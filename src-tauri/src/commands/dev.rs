//! Dev-only stress-test helpers. The whole module is gated on
//! `debug_assertions`; release builds strip every command here and the
//! `invoke_handler` registration in `lib.rs` mirrors that gate so the IPC
//! surface in production is unchanged.
//!
//! Tracks generated note IDs in a side table (`dev_generated_notes`) created
//! lazily on first use. Skipping a migration keeps the production schema
//! identical between dev and release builds.

use crate::db::{now_iso, Db};
use crate::error::Result;
use rand::seq::SliceRandom;
use rand::Rng;
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;

/// Per-call upper bound. 100k notes is already several minutes of FTS work
/// even with batched commits.
const MAX_PER_CALL: u32 = 100_000;

/// Notes per transaction. Each batch commits before the next starts so other
/// readers (e.g. a sidebar refresh) can interleave between batches and the
/// frontend can render a progress event.
const BATCH_SIZE: u32 = 250;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DevGenerateOptions {
    pub count: u32,
    /// "plain" | "mixed" | "long"
    pub style: String,
    /// 0..=100. Probability that any given generated note ends up pinned.
    pub pin_percent: u8,
}

#[tauri::command]
pub fn dev_generate_notes(
    app: AppHandle,
    db: State<Db>,
    options: DevGenerateOptions,
) -> Result<u32> {
    let total = options.count.min(MAX_PER_CALL);
    if total == 0 {
        return Ok(0);
    }
    let style = options.style.as_str();
    let pin_percent = options.pin_percent.min(100);

    let mut conn = db.conn()?;
    ensure_tracking_table(&conn)?;
    let mut rng = rand::thread_rng();

    let _ = app.emit(
        "notez://dev/generate-progress",
        json!({ "phase": "start", "done": 0u32, "total": total }),
    );

    let mut produced = 0u32;
    while produced < total {
        let batch = (total - produced).min(BATCH_SIZE);
        let now = now_iso();

        let tx = conn.transaction()?;
        {
            let mut insert_note = tx.prepare(
                "INSERT INTO notes (id, title, content_json, content_text, is_pinned, pinned_at, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
            )?;
            let mut insert_track = tx.prepare(
                "INSERT OR IGNORE INTO dev_generated_notes (note_id) VALUES (?1)",
            )?;

            for _ in 0..batch {
                let id = Uuid::new_v4().to_string();
                let (title, content_json, content_text) = generate_note(&mut rng, style);
                let pinned: bool = rng.gen_range(0..100) < pin_percent;
                let pinned_at: Option<&str> = if pinned { Some(now.as_str()) } else { None };
                let is_pinned: i64 = if pinned { 1 } else { 0 };

                insert_note.execute(rusqlite::params![
                    id,
                    title,
                    content_json,
                    content_text,
                    is_pinned,
                    pinned_at,
                    now,
                ])?;
                insert_track.execute(rusqlite::params![id])?;
            }
        }
        tx.commit()?;

        produced += batch;
        let _ = app.emit(
            "notez://dev/generate-progress",
            json!({ "phase": "progress", "done": produced, "total": total }),
        );
    }

    let _ = app.emit(
        "notez://dev/generate-progress",
        json!({ "phase": "done", "done": produced, "total": total }),
    );
    tracing::info!("dev: generated {produced} notes (style={style}, pinned={pin_percent}%)");
    Ok(produced)
}

#[tauri::command]
pub fn dev_count_generated_notes(db: State<Db>) -> Result<u32> {
    let conn = db.conn()?;
    ensure_tracking_table(&conn)?;
    let n: i64 = conn.query_row(
        "SELECT COUNT(*) FROM dev_generated_notes
         WHERE EXISTS (SELECT 1 FROM notes WHERE notes.id = dev_generated_notes.note_id)",
        [],
        |r| r.get(0),
    )?;
    Ok(n as u32)
}

#[tauri::command]
pub fn dev_delete_generated_notes(app: AppHandle, db: State<Db>) -> Result<u32> {
    let mut conn = db.conn()?;
    ensure_tracking_table(&conn)?;

    // Total upfront so the progress event has a denominator.
    let total: i64 = conn.query_row(
        "SELECT COUNT(*) FROM dev_generated_notes",
        [],
        |r| r.get(0),
    )?;
    let total = total as u32;

    let _ = app.emit(
        "notez://dev/delete-progress",
        json!({ "phase": "start", "done": 0u32, "total": total }),
    );

    let mut deleted = 0u32;
    loop {
        let tx = conn.transaction()?;
        // Pull a batch of IDs; FTS triggers fire per-row, so committing in
        // chunks keeps the lock window small and lets readers interleave.
        let ids: Vec<String> = {
            let mut stmt = tx.prepare(
                "SELECT note_id FROM dev_generated_notes LIMIT ?1",
            )?;
            let mapped = stmt.query_map(rusqlite::params![BATCH_SIZE as i64], |r| r.get::<_, String>(0))?;
            mapped.collect::<rusqlite::Result<Vec<_>>>()?
        };
        if ids.is_empty() {
            tx.commit()?;
            break;
        }
        for id in &ids {
            tx.execute("DELETE FROM notes WHERE id = ?1", rusqlite::params![id])?;
            tx.execute(
                "DELETE FROM dev_generated_notes WHERE note_id = ?1",
                rusqlite::params![id],
            )?;
        }
        tx.commit()?;

        deleted += ids.len() as u32;
        let _ = app.emit(
            "notez://dev/delete-progress",
            json!({ "phase": "progress", "done": deleted, "total": total }),
        );
    }

    let _ = app.emit(
        "notez://dev/delete-progress",
        json!({ "phase": "done", "done": deleted, "total": total }),
    );
    tracing::info!("dev: deleted {deleted} generated notes");
    Ok(deleted)
}

fn ensure_tracking_table(conn: &rusqlite::Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS dev_generated_notes (
            note_id TEXT PRIMARY KEY REFERENCES notes(id) ON DELETE CASCADE
         );",
    )?;
    Ok(())
}

// ---- Note content generation -------------------------------------------

fn generate_note(rng: &mut rand::rngs::ThreadRng, style: &str) -> (String, String, String) {
    let title_words = rng.gen_range(2..=6);
    let title = title_case(&random_words(rng, title_words));

    // Builders return (plain_text, body_children) - the body only. The title
    // is prepended below as an H1 so it's the first visual element in the
    // editor and the first line of content_text (which `deriveTitle()` keys
    // off of for the sidebar label).
    let (text, mut children) = match style {
        "plain" => build_plain(rng),
        "long" => build_long(rng),
        _ => build_mixed(rng),
    };

    children.insert(0, heading("h1", vec![text_node(&title, 0)]));

    let content_text = if text.is_empty() {
        title.clone()
    } else {
        format!("{title}\n{text}")
    };
    let content_json = root_json(children);

    (title, content_json, content_text)
}

// ---- Lexical JSON builders ----------------------------------------------
//
// Builders return (plain_text, body_node_list). `generate_note` prepends the
// title H1 and serialises to JSON once.

fn build_plain(rng: &mut rand::rngs::ThreadRng) -> (String, Vec<Value>) {
    let para_count = rng.gen_range(1..=3);
    let mut children: Vec<Value> = Vec::with_capacity(para_count);
    let mut text_lines: Vec<String> = Vec::new();
    for _ in 0..para_count {
        let n = rng.gen_range(20..=60);
        let body = random_paragraph(rng, n);
        text_lines.push(body.clone());
        children.push(paragraph(vec![text_node(&body, 0)]));
    }
    (text_lines.join("\n"), children)
}

fn build_mixed(rng: &mut rand::rngs::ThreadRng) -> (String, Vec<Value>) {
    let mut children: Vec<Value> = Vec::new();
    let mut text_lines: Vec<String> = Vec::new();

    if rng.gen_bool(0.7) {
        let head_words = rng.gen_range(3..=7);
        let head = title_case(&random_words(rng, head_words));
        text_lines.push(head.clone());
        // Body section headings stay h2/h3 - the note's title H1 is prepended
        // separately by `generate_note`, so we don't want a competing H1 here.
        let tag = ["h2", "h3"].choose(rng).copied().unwrap_or("h2");
        children.push(heading(tag, vec![text_node(&head, 0)]));
    }

    let block_count = rng.gen_range(2..=6);
    for _ in 0..block_count {
        let pick = rng.gen_range(0..10);
        match pick {
            0..=4 => {
                let n = rng.gen_range(15..=45);
                let nodes = formatted_text_run(rng, n);
                let plain = nodes_to_text(&nodes);
                text_lines.push(plain);
                children.push(paragraph(nodes));
            }
            5..=6 => {
                let items = rng.gen_range(2..=5);
                let mut li: Vec<Value> = Vec::with_capacity(items);
                for i in 0..items {
                    let n = rng.gen_range(3..=10);
                    let body = random_words(rng, n);
                    text_lines.push(body.clone());
                    li.push(list_item(i + 1, vec![text_node(&body, 0)]));
                }
                let bullet = pick % 2 == 0;
                children.push(list_node(bullet, li));
            }
            7 => {
                let n = rng.gen_range(15..=35);
                let body = random_paragraph(rng, n);
                text_lines.push(body.clone());
                children.push(quote(vec![text_node(&body, 0)]));
            }
            _ => {
                let n = rng.gen_range(2..=5);
                let head = title_case(&random_words(rng, n));
                text_lines.push(head.clone());
                let tag = ["h2", "h3"].choose(rng).copied().unwrap_or("h3");
                children.push(heading(tag, vec![text_node(&head, 0)]));
            }
        }
    }

    (text_lines.join("\n"), children)
}

fn build_long(rng: &mut rand::rngs::ThreadRng) -> (String, Vec<Value>) {
    let para_count = rng.gen_range(8..=20);
    let mut children: Vec<Value> = Vec::with_capacity(para_count);
    let mut text_lines: Vec<String> = Vec::new();

    // No leading H1 here either - generate_note adds the title H1.
    for _ in 0..para_count {
        if rng.gen_bool(0.2) {
            let n = rng.gen_range(2..=5);
            let sub = title_case(&random_words(rng, n));
            text_lines.push(sub.clone());
            children.push(heading("h2", vec![text_node(&sub, 0)]));
        }
        let n = rng.gen_range(40..=100);
        let nodes = formatted_text_run(rng, n);
        let plain = nodes_to_text(&nodes);
        text_lines.push(plain);
        children.push(paragraph(nodes));
    }

    (text_lines.join("\n"), children)
}

// Build a paragraph's worth of text nodes with random formatting bursts so
// the editor renders bold/italic/code spans without any markdown shortcuts
// having to re-parse on load.
fn formatted_text_run(rng: &mut rand::rngs::ThreadRng, words: usize) -> Vec<Value> {
    const FORMATS: &[u32] = &[0, 0, 0, 1, 2, 3, 16];

    let mut out: Vec<Value> = Vec::new();
    let mut remaining = words;
    while remaining > 0 {
        let chunk = rng.gen_range(2..=8).min(remaining);
        let format = *FORMATS.choose(rng).unwrap_or(&0);
        let mut text = random_words(rng, chunk);
        if !out.is_empty() {
            text.insert(0, ' ');
        }
        out.push(text_node(&text, format));
        remaining -= chunk;
    }
    out
}

fn nodes_to_text(nodes: &[Value]) -> String {
    nodes
        .iter()
        .filter_map(|n| n.get("text").and_then(|t| t.as_str()))
        .collect::<Vec<_>>()
        .join("")
}

fn root_json(children: Vec<Value>) -> String {
    serde_json::to_string(&json!({
        "root": {
            "children": children,
            "direction": "ltr",
            "format": "",
            "indent": 0,
            "type": "root",
            "version": 1
        }
    }))
    .unwrap_or_else(|_| "{}".to_string())
}

fn paragraph(children: Vec<Value>) -> Value {
    json!({
        "children": children,
        "direction": "ltr",
        "format": "",
        "indent": 0,
        "type": "paragraph",
        "version": 1,
        "textFormat": 0,
        "textStyle": ""
    })
}

fn heading(tag: &str, children: Vec<Value>) -> Value {
    json!({
        "children": children,
        "direction": "ltr",
        "format": "",
        "indent": 0,
        "type": "heading",
        "version": 1,
        "tag": tag
    })
}

fn quote(children: Vec<Value>) -> Value {
    json!({
        "children": children,
        "direction": "ltr",
        "format": "",
        "indent": 0,
        "type": "quote",
        "version": 1
    })
}

fn list_node(bullet: bool, children: Vec<Value>) -> Value {
    json!({
        "children": children,
        "direction": "ltr",
        "format": "",
        "indent": 0,
        "type": "list",
        "version": 1,
        "listType": if bullet { "bullet" } else { "number" },
        "tag": if bullet { "ul" } else { "ol" },
        "start": 1
    })
}

fn list_item(value: usize, children: Vec<Value>) -> Value {
    json!({
        "children": children,
        "direction": "ltr",
        "format": "",
        "indent": 0,
        "type": "listitem",
        "version": 1,
        "value": value
    })
}

fn text_node(text: &str, format: u32) -> Value {
    json!({
        "detail": 0,
        "format": format,
        "mode": "normal",
        "style": "",
        "text": text,
        "type": "text",
        "version": 1
    })
}

// ---- Word source --------------------------------------------------------

// Hand-rolled word picker. Replaces `lipsum` because its Markov chain has a
// strong bias toward starting outputs with the same prefix ("Ullus
// Investigandi…") for short word counts - all 1k generated titles ended up
// looking identical. Uniform random sampling from a fixed corpus gives the
// variety we actually want for stress-testing rendering and search.
const WORDS: &[&str] = &[
    "ad", "adipiscing", "aliqua", "aliquip", "amet", "anim", "aute", "cillum",
    "commodo", "consectetur", "consequat", "culpa", "cupidatat", "deserunt",
    "do", "dolor", "dolore", "duis", "ea", "eiusmod", "elit", "enim", "esse",
    "est", "et", "eu", "ex", "excepteur", "exercitation", "fugiat", "id", "in",
    "incididunt", "ipsum", "irure", "labore", "laboris", "laborum", "lorem",
    "magna", "minim", "mollit", "nisi", "non", "nostrud", "nulla", "occaecat",
    "officia", "pariatur", "proident", "qui", "quis", "reprehenderit", "sed",
    "sint", "sit", "sunt", "tempor", "ullamco", "ut", "velit", "veniam",
    "voluptate", "accusamus", "accusantium", "alias", "aperiam", "architecto",
    "asperiores", "atque", "beatae", "blanditiis", "consequatur", "corporis",
    "debitis", "delectus", "deleniti", "dicta", "dignissimos", "distinctio",
    "ducimus", "earum", "eius", "eligendi", "error", "eveniet", "expedita",
    "explicabo", "facere", "facilis", "fuga", "fugit", "harum", "hic",
    "iste", "iure", "iusto", "laboriosam", "laudantium", "libero", "magnam",
    "maiores", "maxime", "modi", "molestiae", "natus", "necessitatibus",
    "nemo", "nesciunt", "nihil", "nobis", "obcaecati", "odio", "odit",
    "officiis", "omnis", "optio", "perferendis", "perspiciatis", "placeat",
    "porro", "possimus", "praesentium", "quaerat", "quam", "quasi", "quia",
    "quibusdam", "quidem", "quod", "ratione", "recusandae", "reiciendis",
    "rem", "repellat", "repellendus", "repudiandae", "rerum", "saepe",
    "sapiente", "sequi", "similique", "soluta", "tempora", "tempore",
    "temporibus", "tenetur", "totam", "ullam", "unde", "vel", "veritatis",
    "vero", "vitae", "voluptas", "voluptates", "voluptatibus", "voluptatum",
];

fn random_words(rng: &mut rand::rngs::ThreadRng, n: usize) -> String {
    let n = n.max(1);
    let mut out = String::with_capacity(n * 8);
    for i in 0..n {
        if i > 0 {
            out.push(' ');
        }
        out.push_str(WORDS.choose(rng).copied().unwrap_or("lorem"));
    }
    out
}

fn random_sentence(rng: &mut rand::rngs::ThreadRng, n: usize) -> String {
    let mut s = random_words(rng, n);
    capitalize_first(&mut s);
    s.push('.');
    s
}

fn random_paragraph(rng: &mut rand::rngs::ThreadRng, words: usize) -> String {
    let mut out = String::new();
    let mut remaining = words;
    while remaining > 0 {
        let n = rng.gen_range(6..=14).min(remaining);
        if !out.is_empty() {
            out.push(' ');
        }
        out.push_str(&random_sentence(rng, n));
        remaining -= n;
    }
    out
}

// ---- helpers ------------------------------------------------------------

fn title_case(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut at_word_start = true;
    for ch in s.chars() {
        if ch.is_whitespace() {
            at_word_start = true;
            out.push(ch);
        } else if at_word_start {
            for u in ch.to_uppercase() {
                out.push(u);
            }
            at_word_start = false;
        } else {
            out.push(ch);
        }
    }
    out
}

fn capitalize_first(s: &mut String) {
    let Some(ch) = s.chars().next() else { return };
    let upper: String = ch.to_uppercase().collect();
    s.replace_range(0..ch.len_utf8(), &upper);
}
