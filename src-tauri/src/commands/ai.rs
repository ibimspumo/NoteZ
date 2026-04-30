// OpenRouter integration: title generation, cost ledger, model catalog.
//
// Pipeline:
//   1. Frontend writes a note with a fallback title (deriveTitle).
//   2. Frontend calls generate_note_title(note_id, text) without awaiting.
//   3. We POST to OpenRouter, parse the strict-JSON title response, and
//      atomically: (a) UPDATE notes.title, (b) INSERT into ai_calls,
//      (c) emit notez://notes/changed so the sidebar refreshes.
//   4. Failures (no key, network, 4xx/5xx, malformed JSON) still log a
//      row to ai_calls with status='error' so the user can see what
//      went wrong in the activity dialog.

use crate::constants::{
    AI_CALLS_RETENTION, AI_HTTP_TIMEOUT_SECS, AI_MODELS_CACHE_TTL_SECS,
    AI_TITLE_MAX_CHARS, AI_TITLE_MAX_INPUT_CHARS, AI_TITLE_MAX_TOKENS, MAX_AI_PAGE,
    SETTING_AI_ENABLED, SETTING_AI_MODEL, SETTING_OPENROUTER_KEY_PRESENT,
};
use crate::db::{now_iso, Db};
use crate::error::{NoteZError, Result};
use crate::keychain;
use crate::pagination::{collect_page, next_cursor};
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, State};
use uuid::Uuid;

pub const DEFAULT_AI_MODEL: &str = "google/gemini-3-flash-preview";

const OPENROUTER_BASE: &str = "https://openrouter.ai/api/v1";
const HTTP_TIMEOUT: Duration = Duration::from_secs(AI_HTTP_TIMEOUT_SECS);
const MODELS_CACHE_TTL: Duration = Duration::from_secs(AI_MODELS_CACHE_TTL_SECS);

const TITLE_SYSTEM_PROMPT: &str = "You generate short, descriptive titles for personal notes.\n\nRules:\n- Output ONLY the title.\n- Maximum 8 words / about 60 characters.\n- Match the language of the note exactly.\n- Capture the gist, be concrete.\n- No emojis, no quotes, no trailing punctuation.";

// ─── HTTP client + models cache ─────────────────────────────────────────────

static HTTP: Lazy<reqwest::Client> = Lazy::new(|| {
    reqwest::Client::builder()
        .timeout(HTTP_TIMEOUT)
        .user_agent(concat!("NoteZ/", env!("CARGO_PKG_VERSION")))
        .build()
        .expect("reqwest client")
});

type ModelsCacheEntry = (Vec<AiModel>, Instant);
static MODELS_CACHE: Lazy<Mutex<Option<ModelsCacheEntry>>> = Lazy::new(|| Mutex::new(None));

// ─── Public API types (serialized to frontend) ──────────────────────────────

#[derive(Serialize)]
pub struct AiConfig {
    pub enabled: bool,
    pub has_key: bool,
    pub model: String,
}

#[derive(Serialize, Clone)]
pub struct AiModel {
    pub id: String,
    pub name: String,
    pub context_length: u64,
    /// USD per 1M prompt tokens.
    pub prompt_per_m: f64,
    /// USD per 1M completion tokens.
    pub completion_per_m: f64,
}

#[derive(Serialize)]
pub struct AiCall {
    pub id: String,
    pub created_at: String,
    pub model: String,
    pub purpose: String,
    pub note_id: Option<String>,
    pub note_title: Option<String>,
    pub prompt_tokens: i64,
    pub completion_tokens: i64,
    pub cost_usd: f64,
    pub duration_ms: i64,
    pub status: String,
    pub error: Option<String>,
}

#[derive(Serialize, Deserialize)]
pub struct AiCallsCursor {
    pub created_at: String,
    pub id: String,
}

#[derive(Serialize)]
pub struct AiCallsPage {
    pub items: Vec<AiCall>,
    pub next_cursor: Option<AiCallsCursor>,
}

#[derive(Serialize)]
pub struct AiStats {
    pub total_calls: i64,
    pub total_cost_usd: f64,
    pub error_calls: i64,
}

// ─── Settings commands ─────────────────────────────────────────────────────

#[tauri::command]
pub fn get_ai_config(db: State<Db>) -> Result<AiConfig> {
    let conn = db.conn()?;
    let enabled = read_setting(&conn, SETTING_AI_ENABLED)
        .map(|v| v == "1")
        .unwrap_or(false);
    let model = read_setting(&conn, SETTING_AI_MODEL).unwrap_or_else(|| DEFAULT_AI_MODEL.to_string());
    // Read the SQLite presence marker, NOT the keychain. Touching the keychain
    // here would force a macOS password prompt every time settings load -
    // and `loadSettings` fires on app start AND on every cross-window
    // settings-changed event AND from the capture window's own bootstrap,
    // which adds up to ~8 prompts per launch on unsigned dev builds.
    // The marker is written by `set_openrouter_key` in lockstep with the
    // keychain, so it accurately reflects "is there a key?" without the
    // privileged read.
    let has_key = read_setting(&conn, SETTING_OPENROUTER_KEY_PRESENT)
        .map(|v| v == "1")
        .unwrap_or(false);
    Ok(AiConfig { enabled, has_key, model })
}

#[tauri::command]
pub fn set_ai_enabled(app: AppHandle, db: State<Db>, enabled: bool) -> Result<()> {
    write_setting(&db, SETTING_AI_ENABLED, if enabled { "1" } else { "0" })?;
    crate::events::emit_settings_changed(&app, SETTING_AI_ENABLED);
    Ok(())
}

#[tauri::command]
pub fn set_ai_model(app: AppHandle, db: State<Db>, model: String) -> Result<()> {
    if model.trim().is_empty() {
        return Err(NoteZError::InvalidInput("model cannot be empty".into()));
    }
    write_setting(&db, SETTING_AI_MODEL, model.trim())?;
    crate::events::emit_settings_changed(&app, SETTING_AI_MODEL);
    Ok(())
}

/// Store the OpenRouter API key in the OS keychain. An empty `key` clears it.
///
/// Why the keychain: a plain SQLite column would let any process with read
/// access to `~/Library/Application Support/de.agent-z.notez/notez.db`
/// (Time Machine backups, malware running as the user, other users sharing
/// the Mac) read the credential. The keychain is encrypted-at-rest and
/// scoped to the bundle id, so even another tool running as the same user
/// has to prompt for permission on first read.
#[tauri::command]
pub fn set_openrouter_key(app: AppHandle, db: State<Db>, key: String) -> Result<()> {
    let trimmed = key.trim();
    if trimmed.is_empty() {
        keychain::delete_openrouter_key()?;
        write_setting(&db, SETTING_OPENROUTER_KEY_PRESENT, "0")?;
    } else {
        keychain::set_openrouter_key(trimmed)?;
        write_setting(&db, SETTING_OPENROUTER_KEY_PRESENT, "1")?;
    }
    crate::events::emit_settings_changed(&app, SETTING_OPENROUTER_KEY_PRESENT);
    Ok(())
}

// ─── Models catalog ────────────────────────────────────────────────────────

#[tauri::command]
pub async fn list_ai_models(force_refresh: Option<bool>) -> Result<Vec<AiModel>> {
    let force = force_refresh.unwrap_or(false);
    if !force {
        if let Some(cached) = read_models_cache() {
            return Ok(cached);
        }
    }
    let models = fetch_openrouter_models().await?;
    if let Ok(mut guard) = MODELS_CACHE.lock() {
        *guard = Some((models.clone(), Instant::now()));
    }
    Ok(models)
}

fn read_models_cache() -> Option<Vec<AiModel>> {
    let guard = MODELS_CACHE.lock().ok()?;
    let (cached, at) = guard.as_ref()?;
    if at.elapsed() < MODELS_CACHE_TTL {
        Some(cached.clone())
    } else {
        None
    }
}

#[derive(Deserialize)]
struct OrModelList {
    data: Vec<OrModel>,
}

#[derive(Deserialize)]
struct OrModel {
    id: String,
    name: String,
    context_length: Option<u64>,
    architecture: Option<OrArchitecture>,
    pricing: Option<OrPricing>,
    supported_parameters: Option<Vec<String>>,
}

#[derive(Deserialize)]
struct OrArchitecture {
    output_modalities: Option<Vec<String>>,
}

#[derive(Deserialize)]
struct OrPricing {
    prompt: Option<String>,
    completion: Option<String>,
}

async fn fetch_openrouter_models() -> Result<Vec<AiModel>> {
    let resp = HTTP
        .get(format!("{OPENROUTER_BASE}/models"))
        .send()
        .await
        .map_err(|e| NoteZError::Other(format!("openrouter models: {e}")))?;
    if !resp.status().is_success() {
        return Err(NoteZError::Other(format!(
            "openrouter models: HTTP {}",
            resp.status()
        )));
    }
    let body: OrModelList = resp
        .json()
        .await
        .map_err(|e| NoteZError::Other(format!("openrouter models parse: {e}")))?;

    let mut out = Vec::with_capacity(body.data.len());
    for m in body.data {
        // Only keep text-output models with structured_outputs - everything else
        // would silently break our strict-JSON title pipeline.
        let text_only = m
            .architecture
            .as_ref()
            .and_then(|a| a.output_modalities.as_ref())
            .map(|v| v.len() == 1 && v[0] == "text")
            .unwrap_or(false);
        if !text_only {
            continue;
        }
        let supports_structured = m
            .supported_parameters
            .as_ref()
            .map(|v| v.iter().any(|s| s == "structured_outputs"))
            .unwrap_or(false);
        if !supports_structured {
            continue;
        }
        let prompt_per_m = m
            .pricing
            .as_ref()
            .and_then(|p| p.prompt.as_ref())
            .and_then(|s| s.parse::<f64>().ok())
            .unwrap_or(0.0)
            * 1_000_000.0;
        let completion_per_m = m
            .pricing
            .as_ref()
            .and_then(|p| p.completion.as_ref())
            .and_then(|s| s.parse::<f64>().ok())
            .unwrap_or(0.0)
            * 1_000_000.0;
        out.push(AiModel {
            id: m.id,
            name: m.name,
            context_length: m.context_length.unwrap_or(0),
            prompt_per_m,
            completion_per_m,
        });
    }
    out.sort_by_key(|a| a.name.to_lowercase());
    Ok(out)
}

// ─── Title generation ──────────────────────────────────────────────────────

#[derive(Serialize)]
struct ChatRequest<'a> {
    model: &'a str,
    messages: Vec<ChatMessage<'a>>,
    max_tokens: u32,
    response_format: ResponseFormat<'a>,
}

#[derive(Serialize)]
struct ChatMessage<'a> {
    role: &'a str,
    content: &'a str,
}

#[derive(Serialize)]
struct ResponseFormat<'a> {
    #[serde(rename = "type")]
    kind: &'a str,
    json_schema: JsonSchemaSpec<'a>,
}

#[derive(Serialize)]
struct JsonSchemaSpec<'a> {
    name: &'a str,
    strict: bool,
    schema: serde_json::Value,
}

#[derive(Deserialize)]
struct ChatResponse {
    choices: Vec<ChatChoice>,
    usage: Option<ChatUsage>,
}

#[derive(Deserialize)]
struct ChatChoice {
    message: ChatChoiceMessage,
}

#[derive(Deserialize)]
struct ChatChoiceMessage {
    content: Option<String>,
}

#[derive(Deserialize)]
struct ChatUsage {
    prompt_tokens: Option<i64>,
    completion_tokens: Option<i64>,
    cost: Option<f64>,
}

#[derive(Deserialize)]
struct TitlePayload {
    title: String,
}

/// Generate a title for the given text via the configured OpenRouter model.
///
/// Synchronous from the caller's perspective (await me): we run the HTTP call
/// in-line and return the title string, so the Quick Capture flow can do
/// AI-first then save-with-title. Cost/usage is logged to `ai_calls` regardless
/// of outcome - even errors get a row so the user sees them in the activity
/// dialog.
///
/// `note_id` is optional - when called pre-creation it's `None`, when called
/// to retitle an existing note (future "regenerate title" UI), pass the id.
///
/// Returns the AI-generated title on success. Returns an error if AI is
/// disabled, the key is missing, the network call fails, or the model returns
/// nothing usable - the caller is expected to fall back to a derived title.
#[tauri::command]
pub async fn generate_title(
    db: State<'_, Db>,
    text: String,
    note_id: Option<String>,
) -> Result<String> {
    let db = db.inner().clone();

    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Err(NoteZError::InvalidInput("empty text".into()));
    }

    let (enabled, model) = {
        let conn = db.conn()?;
        let enabled = read_setting(&conn, SETTING_AI_ENABLED).map(|v| v == "1").unwrap_or(false);
        let model = read_setting(&conn, SETTING_AI_MODEL)
            .unwrap_or_else(|| DEFAULT_AI_MODEL.to_string());
        (enabled, model)
    };
    // Pull the key from the OS keychain. A missing keychain entry is treated
    // as "no key configured" - identical to the legacy SQLite-backed empty
    // string so the calling UX is unchanged.
    let key = keychain::get_openrouter_key()?.unwrap_or_default();

    if !enabled {
        return Err(NoteZError::InvalidInput("ai title generation is disabled".into()));
    }
    if key.is_empty() {
        record_call(
            &db,
            CallRecord {
                model: &model,
                note_id: note_id.as_deref(),
                prompt_tokens: 0,
                completion_tokens: 0,
                cost_usd: 0.0,
                duration_ms: 0,
                status: "error",
                error: Some("no api key"),
            },
        );
        return Err(NoteZError::InvalidInput("no openrouter api key configured".into()));
    }

    // Cap input tokens cheaply by character count - longer notes get truncated
    // for the LLM only, the saved note keeps its full content.
    let payload_text = if trimmed.chars().count() > AI_TITLE_MAX_INPUT_CHARS {
        trimmed.chars().take(AI_TITLE_MAX_INPUT_CHARS).collect::<String>()
    } else {
        trimmed.to_string()
    };

    let started = Instant::now();
    let result = call_openrouter(&model, &key, &payload_text).await;
    let elapsed_ms = started.elapsed().as_millis() as i64;

    match result {
        Ok((title, prompt_tokens, completion_tokens, cost)) => {
            let title = sanitize_title(&title);
            if title.is_empty() {
                record_call(
                    &db,
                    CallRecord {
                        model: &model,
                        note_id: note_id.as_deref(),
                        prompt_tokens,
                        completion_tokens,
                        cost_usd: cost,
                        duration_ms: elapsed_ms,
                        status: "error",
                        error: Some("empty title"),
                    },
                );
                return Err(NoteZError::Other("model returned empty title".into()));
            }
            // If a note id was supplied (e.g. user clicked "regenerate title"),
            // update the row in place. Pre-creation calls (Quick Capture) pass
            // None and the caller persists the returned title themselves.
            if let Some(id) = note_id.as_deref() {
                let _ = update_note_title(&db, id, &title)?;
            }
            record_call(
                &db,
                CallRecord {
                    model: &model,
                    note_id: note_id.as_deref(),
                    prompt_tokens,
                    completion_tokens,
                    cost_usd: cost,
                    duration_ms: elapsed_ms,
                    status: "ok",
                    error: None,
                },
            );
            Ok(title)
        }
        Err(e) => {
            tracing::warn!("generate_title failed: {e}");
            record_call(
                &db,
                CallRecord {
                    model: &model,
                    note_id: note_id.as_deref(),
                    prompt_tokens: 0,
                    completion_tokens: 0,
                    cost_usd: 0.0,
                    duration_ms: elapsed_ms,
                    status: "error",
                    error: Some(&e),
                },
            );
            Err(NoteZError::Other(e))
        }
    }
}

async fn call_openrouter(
    model: &str,
    key: &str,
    text: &str,
) -> std::result::Result<(String, i64, i64, f64), String> {
    let req = ChatRequest {
        model,
        messages: vec![
            ChatMessage { role: "system", content: TITLE_SYSTEM_PROMPT },
            ChatMessage { role: "user", content: text },
        ],
        max_tokens: AI_TITLE_MAX_TOKENS,
        response_format: ResponseFormat {
            kind: "json_schema",
            json_schema: JsonSchemaSpec {
                name: "note_title",
                strict: true,
                schema: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "title": { "type": "string" }
                    },
                    "required": ["title"],
                    "additionalProperties": false
                }),
            },
        },
    };

    let resp = HTTP
        .post(format!("{OPENROUTER_BASE}/chat/completions"))
        .bearer_auth(key)
        .header("X-Title", "NoteZ")
        .header("HTTP-Referer", "https://github.com/agent-z/notez")
        .json(&req)
        .send()
        .await
        .map_err(|e| format!("network: {e}"))?;

    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        let truncated: String = body.chars().take(300).collect();
        return Err(format!("HTTP {status}: {}", scrub_secret_like(&truncated)));
    }

    let parsed: ChatResponse = resp.json().await.map_err(|e| format!("parse: {e}"))?;
    let content = parsed
        .choices
        .into_iter()
        .next()
        .and_then(|c| c.message.content)
        .ok_or_else(|| "empty response".to_string())?;

    let payload: TitlePayload =
        serde_json::from_str(&content).map_err(|e| format!("title json: {e} (raw: {content})"))?;

    let usage = parsed.usage.unwrap_or(ChatUsage {
        prompt_tokens: None,
        completion_tokens: None,
        cost: None,
    });

    Ok((
        payload.title,
        usage.prompt_tokens.unwrap_or(0),
        usage.completion_tokens.unwrap_or(0),
        usage.cost.unwrap_or(0.0),
    ))
}

/// Strip anything that *looks* like an OpenRouter / OpenAI / generic Bearer
/// token from a free-form error string before we persist it to the
/// `ai_calls.error` column. OpenRouter's responses don't currently echo the
/// caller's auth header, but other providers can; defense-in-depth keeps a
/// future provider swap from leaking secrets into the user's local DB.
fn scrub_secret_like(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for token in s.split_inclusive(|c: char| c.is_whitespace() || c == '"') {
        let trimmed = token.trim_end_matches(|c: char| c.is_whitespace() || c == '"');
        let punct = &token[trimmed.len()..];
        if looks_secret_like(trimmed) {
            out.push_str("[redacted]");
            out.push_str(punct);
        } else {
            out.push_str(token);
        }
    }
    out
}

fn looks_secret_like(s: &str) -> bool {
    // Conservative heuristic: opaque token patterns we know about.
    // - OpenRouter:   sk-or-v1-<hex>
    // - OpenAI/Stripe-style: sk-<long>
    // - Bearer prefix
    // - Hex/Base64 strings ≥ 32 chars (random nonce / API key shape)
    if s.starts_with("sk-") && s.len() >= 20 {
        return true;
    }
    if s.eq_ignore_ascii_case("Bearer") {
        return true;
    }
    if s.len() >= 32
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '+' || c == '/' || c == '=')
    {
        return true;
    }
    false
}

fn sanitize_title(raw: &str) -> String {
    // Strip surrounding quotes / whitespace, collapse newlines, hard-cap length.
    let mut s = raw.trim().trim_matches('"').trim_matches('\'').trim().to_string();
    if let Some(line) = s.lines().next() {
        s = line.to_string();
    }
    s = s.trim().to_string();
    if s.chars().count() > AI_TITLE_MAX_CHARS {
        s = s.chars().take(AI_TITLE_MAX_CHARS).collect();
    }
    s
}

fn update_note_title(db: &Db, note_id: &str, title: &str) -> Result<bool> {
    let conn = db.conn()?;
    // Deliberately do NOT bump updated_at: an automated metadata refinement
    // shouldn't reorder the sidebar. The notes_au trigger still re-indexes
    // FTS because title changed.
    let n = conn.execute(
        "UPDATE notes SET title = ?1 WHERE id = ?2 AND deleted_at IS NULL",
        rusqlite::params![title, note_id],
    )?;
    Ok(n > 0)
}

// ─── Activity ledger ───────────────────────────────────────────────────────

#[tauri::command]
pub fn list_ai_calls(
    db: State<Db>,
    cursor: Option<AiCallsCursor>,
    limit: Option<u32>,
) -> Result<AiCallsPage> {
    let conn = db.conn()?;
    let limit = limit.unwrap_or(50).clamp(1, MAX_AI_PAGE);
    let limit_plus_one = (limit + 1) as i64;

    // LEFT JOIN to notes so deleted-then-purged calls still show with note_title=NULL.
    let (items, has_more) = if let Some(c) = cursor.as_ref() {
        let mut stmt = conn.prepare(
            "SELECT a.id, a.created_at, a.model, a.purpose, a.note_id,
                    n.title AS note_title,
                    a.prompt_tokens, a.completion_tokens, a.cost_usd,
                    a.duration_ms, a.status, a.error
             FROM ai_calls a
             LEFT JOIN notes n ON n.id = a.note_id
             WHERE (a.created_at, a.id) < (?1, ?2)
             ORDER BY a.created_at DESC, a.id DESC
             LIMIT ?3",
        )?;
        collect_page(
            &mut stmt,
            rusqlite::params![c.created_at, c.id, limit_plus_one],
            limit,
            row_to_ai_call,
        )?
    } else {
        let mut stmt = conn.prepare(
            "SELECT a.id, a.created_at, a.model, a.purpose, a.note_id,
                    n.title AS note_title,
                    a.prompt_tokens, a.completion_tokens, a.cost_usd,
                    a.duration_ms, a.status, a.error
             FROM ai_calls a
             LEFT JOIN notes n ON n.id = a.note_id
             ORDER BY a.created_at DESC, a.id DESC
             LIMIT ?1",
        )?;
        collect_page(&mut stmt, rusqlite::params![limit_plus_one], limit, row_to_ai_call)?
    };

    let next = next_cursor(&items, has_more, |c| AiCallsCursor {
        created_at: c.created_at.clone(),
        id: c.id.clone(),
    });
    Ok(AiCallsPage { items, next_cursor: next })
}

fn row_to_ai_call(row: &rusqlite::Row) -> rusqlite::Result<AiCall> {
    Ok(AiCall {
        id: row.get("id")?,
        created_at: row.get("created_at")?,
        model: row.get("model")?,
        purpose: row.get("purpose")?,
        note_id: row.get("note_id")?,
        note_title: row.get("note_title")?,
        prompt_tokens: row.get("prompt_tokens")?,
        completion_tokens: row.get("completion_tokens")?,
        cost_usd: row.get("cost_usd")?,
        duration_ms: row.get("duration_ms")?,
        status: row.get("status")?,
        error: row.get("error")?,
    })
}

#[tauri::command]
pub fn get_ai_stats(db: State<Db>) -> Result<AiStats> {
    let conn = db.conn()?;
    let (total_calls, total_cost_usd, error_calls): (i64, f64, i64) = conn.query_row(
        "SELECT
            COUNT(*) AS total_calls,
            COALESCE(SUM(cost_usd), 0) AS total_cost_usd,
            SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS error_calls
         FROM ai_calls",
        [],
        |r| Ok((r.get(0)?, r.get(1)?, r.get::<_, Option<i64>>(2)?.unwrap_or(0))),
    )?;
    Ok(AiStats { total_calls, total_cost_usd, error_calls })
}

#[tauri::command]
pub fn clear_ai_calls(db: State<Db>) -> Result<u64> {
    let conn = db.conn()?;
    let n = conn.execute("DELETE FROM ai_calls", [])?;
    Ok(n as u64)
}

// ─── Helpers ───────────────────────────────────────────────────────────────

struct CallRecord<'a> {
    model: &'a str,
    note_id: Option<&'a str>,
    prompt_tokens: i64,
    completion_tokens: i64,
    cost_usd: f64,
    duration_ms: i64,
    status: &'a str,
    error: Option<&'a str>,
}

fn record_call(db: &Db, r: CallRecord<'_>) {
    let conn = match db.conn() {
        Ok(c) => c,
        Err(e) => {
            tracing::warn!("ai_calls record_call: db unavailable: {e}");
            return;
        }
    };
    let id = Uuid::new_v4().to_string();
    let now = now_iso();
    if let Err(e) = conn.execute(
        "INSERT INTO ai_calls
         (id, created_at, model, purpose, note_id,
          prompt_tokens, completion_tokens, cost_usd, duration_ms, status, error)
         VALUES (?1, ?2, ?3, 'title_generation', ?4,
                 ?5, ?6, ?7, ?8, ?9, ?10)",
        rusqlite::params![
            id,
            now,
            r.model,
            r.note_id,
            r.prompt_tokens,
            r.completion_tokens,
            r.cost_usd,
            r.duration_ms,
            r.status,
            r.error
        ],
    ) {
        tracing::warn!("ai_calls insert failed: {e}");
        return;
    }

    // Opportunistic retention. Power users can rack up tens of thousands of
    // calls over time - we keep the most recent AI_CALLS_RETENTION rows and
    // discard older ones. Cheap (one DELETE with a bounded subquery) and
    // amortised across writes so we don't need a background sweep.
    if let Err(e) = conn.execute(
        "DELETE FROM ai_calls
         WHERE id IN (
             SELECT id FROM ai_calls
             ORDER BY created_at DESC, id DESC
             LIMIT -1 OFFSET ?1
         )",
        rusqlite::params![AI_CALLS_RETENTION],
    ) {
        tracing::warn!("ai_calls retention trim failed: {e}");
    }
}

fn read_setting(conn: &rusqlite::Connection, key: &str) -> Option<String> {
    conn.query_row(
        "SELECT value FROM settings WHERE key = ?1",
        rusqlite::params![key],
        |r| r.get::<_, String>(0),
    )
    .ok()
}

fn write_setting(db: &Db, key: &str, value: &str) -> Result<()> {
    let conn = db.conn()?;
    let now = now_iso();
    conn.execute(
        "INSERT INTO settings (key, value, updated_at)
         VALUES (?1, ?2, ?3)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        rusqlite::params![key, value, now],
    )?;
    Ok(())
}
