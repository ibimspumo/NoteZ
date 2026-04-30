//! Dev-only stress-test helpers. The whole module is gated on
//! `debug_assertions`; release builds strip every command here and the
//! `invoke_handler` registration in `lib.rs` mirrors that gate so the IPC
//! surface in production is unchanged.
//!
//! Tracks generated note IDs in a side table (`dev_generated_notes`) created
//! lazily on first use. Skipping a migration keeps the production schema
//! identical between dev and release builds.

use crate::db::{now_iso, wal_checkpoint, Db};
use crate::error::Result;
use chrono::{Duration, Utc};
use rand::seq::SliceRandom;
use rand::Rng;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashSet;
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
    // Same reasoning as the delete path: massive FTS-trigger churn produces
    // a long WAL, so we reclaim it post-bulk-write.
    let _ = wal_checkpoint(&db);
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
    // Bulk delete with FTS triggers per row produces a huge WAL - reclaim it
    // so the DB doesn't sit on tens of MB of journal between runs.
    let _ = wal_checkpoint(&db);
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

// ---- Demo content (marketing-agency screenshots) -----------------------
//
// Hand-authored set of 20 notes used by the dev panel's "Seed demo notes"
// button. These exist so we can produce reproducible marketing screenshots
// without relying on the random stress-test generator (whose lorem ipsum
// looks fake on a product page). Tracked in `dev_generated_notes` so the
// existing "Delete all generated" path cleans them up.
//
// IDs are generated up-front so notes can `@mention` each other; the
// `mentions` table is populated directly because dev seed bypasses
// `update_note` (which is what normally maintains it).

const DEMO_NOTE_COUNT: usize = 20;

#[tauri::command]
pub fn dev_seed_demo_notes(app: AppHandle, db: State<Db>) -> Result<u32> {
    let mut conn = db.conn()?;
    ensure_tracking_table(&conn)?;

    let total = DEMO_NOTE_COUNT as u32;
    let ids: Vec<String> = (0..DEMO_NOTE_COUNT)
        .map(|_| Uuid::new_v4().to_string())
        .collect();
    let notes = build_demo_notes(&ids);
    debug_assert_eq!(notes.len(), DEMO_NOTE_COUNT);

    let _ = app.emit(
        "notez://dev/generate-progress",
        json!({ "phase": "start", "done": 0u32, "total": total }),
    );

    let now_chrono = Utc::now();

    let tx = conn.transaction()?;
    {
        let mut insert_note = tx.prepare(
            "INSERT INTO notes (id, title, content_json, content_text, is_pinned, pinned_at, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
        )?;
        let mut insert_track = tx.prepare(
            "INSERT OR IGNORE INTO dev_generated_notes (note_id) VALUES (?1)",
        )?;

        // First pass: insert every note so the mentions FK targets exist.
        // Notes can reference each other across the set (e.g. note 0 mentions
        // note 3); doing both inserts in one pass would violate the FK on
        // any forward reference.
        let mut timestamps: Vec<String> = Vec::with_capacity(notes.len());
        for (i, demo) in notes.iter().enumerate() {
            // Stagger timestamps so the first-defined note ends up at the top
            // of the sidebar (ORDER BY updated_at DESC) and pinned ordering
            // matches definition order (ORDER BY pinned_at DESC).
            let ts = (now_chrono - Duration::seconds(i as i64)).to_rfc3339();
            let pinned_at: Option<&str> = if demo.pinned { Some(ts.as_str()) } else { None };
            let is_pinned: i64 = if demo.pinned { 1 } else { 0 };

            insert_note.execute(rusqlite::params![
                ids[i],
                demo.title,
                demo.content_json,
                demo.content_text,
                is_pinned,
                pinned_at,
                ts,
            ])?;
            insert_track.execute(rusqlite::params![ids[i]])?;
            timestamps.push(ts);
        }

        // Second pass: every target now exists, so backlinks resolve.
        let mut insert_mention = tx.prepare(
            "INSERT OR IGNORE INTO mentions (source_note_id, target_note_id, created_at) VALUES (?1, ?2, ?3)",
        )?;
        for (i, demo) in notes.iter().enumerate() {
            for target in &demo.mention_targets {
                if target == &ids[i] {
                    continue;
                }
                insert_mention.execute(rusqlite::params![ids[i], target, timestamps[i]])?;
            }
        }
    }
    tx.commit()?;

    let _ = app.emit(
        "notez://dev/generate-progress",
        json!({ "phase": "done", "done": total, "total": total }),
    );
    let _ = wal_checkpoint(&db);
    tracing::info!("dev: seeded {total} demo notes");
    Ok(total)
}

struct DemoNote {
    title: String,
    pinned: bool,
    content_json: String,
    content_text: String,
    mention_targets: Vec<String>,
}

#[derive(Clone)]
enum Span {
    T(String),
    B(String),
    I(String),
    C(String),
    M(String, String), // (note_id, title)
}

// Some block + helper variants aren't used by the current demo set but stay
// in the DSL so editing the content doesn't require re-introducing them.
#[allow(dead_code)]
enum DemoBlock {
    H2(String),
    H3(String),
    P(Vec<Span>),
    Q(String),
    Bul(Vec<Vec<Span>>),
    Num(Vec<Vec<Span>>),
    Chk(Vec<(bool, Vec<Span>)>),
}

fn t(s: &str) -> Span {
    Span::T(s.to_string())
}
fn bs(s: &str) -> Span {
    Span::B(s.to_string())
}
#[allow(dead_code)]
fn is_(s: &str) -> Span {
    Span::I(s.to_string())
}
fn cs(s: &str) -> Span {
    Span::C(s.to_string())
}
fn mr(ids: &[String], idx: usize, title: &str) -> Span {
    Span::M(ids[idx].clone(), title.to_string())
}

fn h2(s: &str) -> DemoBlock {
    DemoBlock::H2(s.to_string())
}
#[allow(dead_code)]
fn h3(s: &str) -> DemoBlock {
    DemoBlock::H3(s.to_string())
}
fn p(spans: Vec<Span>) -> DemoBlock {
    DemoBlock::P(spans)
}
fn pt(s: &str) -> DemoBlock {
    DemoBlock::P(vec![Span::T(s.to_string())])
}
fn pi(s: &str) -> DemoBlock {
    DemoBlock::P(vec![Span::I(s.to_string())])
}
fn qb(s: &str) -> DemoBlock {
    DemoBlock::Q(s.to_string())
}
fn bul(items: Vec<Vec<Span>>) -> DemoBlock {
    DemoBlock::Bul(items)
}
fn num_(items: Vec<Vec<Span>>) -> DemoBlock {
    DemoBlock::Num(items)
}
fn chk(items: Vec<(bool, Vec<Span>)>) -> DemoBlock {
    DemoBlock::Chk(items)
}

fn build_inlines(spans: Vec<Span>) -> (Vec<Value>, String, Vec<String>) {
    let mut nodes: Vec<Value> = Vec::with_capacity(spans.len());
    let mut text = String::new();
    let mut targets: Vec<String> = Vec::new();
    for span in spans {
        match span {
            Span::T(s) => {
                text.push_str(&s);
                nodes.push(text_node(&s, 0));
            }
            Span::B(s) => {
                text.push_str(&s);
                nodes.push(text_node(&s, 1));
            }
            Span::I(s) => {
                text.push_str(&s);
                nodes.push(text_node(&s, 2));
            }
            Span::C(s) => {
                text.push_str(&s);
                nodes.push(text_node(&s, 16));
            }
            Span::M(id, title) => {
                let label = format!("@{}", title);
                text.push_str(&label);
                nodes.push(mention_node(&id, &title));
                targets.push(id);
            }
        }
    }
    (nodes, text, targets)
}

fn make_demo(title: &str, pinned: bool, blocks: Vec<DemoBlock>) -> DemoNote {
    let mut text_lines: Vec<String> = vec![title.to_string()];
    let mut children: Vec<Value> = Vec::new();
    let mut mention_targets: Vec<String> = Vec::new();

    children.push(heading("h1", vec![text_node(title, 0)]));

    for block in blocks {
        match block {
            DemoBlock::H2(s) => {
                text_lines.push(s.clone());
                children.push(heading("h2", vec![text_node(&s, 0)]));
            }
            DemoBlock::H3(s) => {
                text_lines.push(s.clone());
                children.push(heading("h3", vec![text_node(&s, 0)]));
            }
            DemoBlock::P(spans) => {
                let (nodes, line, mt) = build_inlines(spans);
                text_lines.push(line);
                mention_targets.extend(mt);
                children.push(paragraph(nodes));
            }
            DemoBlock::Q(s) => {
                text_lines.push(s.clone());
                children.push(quote(vec![text_node(&s, 0)]));
            }
            DemoBlock::Bul(items) => {
                let mut li: Vec<Value> = Vec::with_capacity(items.len());
                for (i, spans) in items.into_iter().enumerate() {
                    let (nodes, line, mt) = build_inlines(spans);
                    text_lines.push(line);
                    mention_targets.extend(mt);
                    li.push(list_item(i + 1, nodes));
                }
                children.push(list_node(true, li));
            }
            DemoBlock::Num(items) => {
                let mut li: Vec<Value> = Vec::with_capacity(items.len());
                for (i, spans) in items.into_iter().enumerate() {
                    let (nodes, line, mt) = build_inlines(spans);
                    text_lines.push(line);
                    mention_targets.extend(mt);
                    li.push(list_item(i + 1, nodes));
                }
                children.push(list_node(false, li));
            }
            DemoBlock::Chk(items) => {
                let mut li: Vec<Value> = Vec::with_capacity(items.len());
                for (i, (checked, spans)) in items.into_iter().enumerate() {
                    let (nodes, line, mt) = build_inlines(spans);
                    text_lines.push(line);
                    mention_targets.extend(mt);
                    li.push(check_item(i + 1, checked, nodes));
                }
                children.push(check_list(li));
            }
        }
    }

    // Dedup targets while preserving first-seen order. The mentions table
    // uses (source, target) as PK so duplicates are no-ops, but keeping the
    // list short is friendlier to the inserter.
    let mut seen = HashSet::new();
    let mention_targets: Vec<String> = mention_targets
        .into_iter()
        .filter(|x| seen.insert(x.clone()))
        .collect();

    DemoNote {
        title: title.to_string(),
        pinned,
        content_json: root_json(children),
        content_text: text_lines.join("\n"),
        mention_targets,
    }
}

fn mention_node(note_id: &str, title: &str) -> Value {
    json!({
        "children": [{
            "detail": 0,
            "format": 0,
            "mode": "normal",
            "style": "",
            "text": format!("@{}", title),
            "type": "text",
            "version": 1
        }],
        "direction": "ltr",
        "format": "",
        "indent": 0,
        "type": "mention",
        "version": 1,
        "noteId": note_id,
        "title": title
    })
}

fn check_list(children: Vec<Value>) -> Value {
    json!({
        "children": children,
        "direction": "ltr",
        "format": "",
        "indent": 0,
        "type": "list",
        "version": 1,
        "listType": "check",
        "tag": "ul",
        "start": 1
    })
}

fn check_item(value: usize, checked: bool, children: Vec<Value>) -> Value {
    json!({
        "children": children,
        "direction": "ltr",
        "format": "",
        "indent": 0,
        "type": "listitem",
        "version": 1,
        "value": value,
        "checked": checked
    })
}

// Index map for cross-mentions. Order here = sidebar order.
// Self-referential: every note is *about* NoteZ - the manifesto, the
// roadmap, comparisons with other apps, the bug list, etc. Funnier (and
// more honest) for marketing screenshots than the previous agency theme.
//
// `#[allow(dead_code)]` on every entry because not every index is mentioned
// by another note today, but we keep the full set so editing the demo
// content doesn't require hunting for new constants.
#[allow(dead_code)]
const N_MANIFESTO: usize = 0;
#[allow(dead_code)]
const N_TODAY: usize = 1;
#[allow(dead_code)]
const N_ROADMAP: usize = 2;
#[allow(dead_code)]
const N_LEFT_NOTION: usize = 3;
#[allow(dead_code)]
const N_BENCH: usize = 4;
#[allow(dead_code)]
const N_SIDEBAR: usize = 5;
#[allow(dead_code)]
const N_MILLION: usize = 6;
#[allow(dead_code)]
const N_REQUESTS: usize = 7;
#[allow(dead_code)]
const N_BUGS: usize = 8;
#[allow(dead_code)]
const N_LEXICAL: usize = 9;
#[allow(dead_code)]
const N_MAC: usize = 10;
#[allow(dead_code)]
const N_SHORTCUTS: usize = 11;
#[allow(dead_code)]
const N_SNAPS: usize = 12;
#[allow(dead_code)]
const N_SCREEN: usize = 13;
#[allow(dead_code)]
const N_RELEASE: usize = 14;
#[allow(dead_code)]
const N_AI: usize = 15;
#[allow(dead_code)]
const N_PRICE: usize = 16;
#[allow(dead_code)]
const N_README: usize = 17;
#[allow(dead_code)]
const N_ONBOARD: usize = 18;
#[allow(dead_code)]
const N_CAPTURE: usize = 19;

fn build_demo_notes(ids: &[String]) -> Vec<DemoNote> {
    vec![
        // 0 - pinned
        make_demo(
            "NoteZ - what we're building",
            true,
            vec![
                pi("Pin this. Read it before saying yes to anything new."),
                h2("The promise"),
                bul(vec![
                    vec![bs("Local-first."), t(" Your notes never leave your machine.")],
                    vec![
                        bs("Fast at 1,000,000 notes."),
                        t(" Not just at 100. See "),
                        mr(ids, N_MILLION, "1,000,000 notes - the budget"),
                        t("."),
                    ],
                    vec![bs("Beautiful enough"), t(" to use as your daily driver.")],
                    vec![
                        bs("Mac-first."),
                        t(" Real keyboard shortcuts. Native vibrancy. The reasons in "),
                        mr(ids, N_MAC, "Why Mac-first (for now)"),
                        t("."),
                    ],
                ]),
                h2("What we'll never do"),
                bul(vec![
                    vec![t("No accounts. No login screen. No \"sync your data to the cloud\" nag.")],
                    vec![t("No telemetry. We don't watch how you write.")],
                    vec![
                        t("No AI summaries you didn't ask for - decision logged in "),
                        mr(ids, N_AI, "AI - what we said yes to, what we said no to"),
                        t("."),
                    ],
                    vec![t("No background updates that change the app overnight.")],
                ]),
                h2("What's next"),
                p(vec![
                    t("Roadmap lives in "),
                    mr(ids, N_ROADMAP, "Roadmap - next 3 releases"),
                    t(". Daily focus is "),
                    mr(ids, N_TODAY, "Today"),
                    t("."),
                ]),
                qb("If a feature can't survive the 1M-note test, it's not a feature - it's a demo."),
            ],
        ),
        // 1 - pinned
        make_demo(
            "Today",
            true,
            vec![
                pi("Tuesday. Working on the v0.7 push."),
                h2("Ship today"),
                chk(vec![
                    (true, vec![t("Fix sidebar flicker on first paint")]),
                    (true, vec![t("Bump version to 0.6.4")]),
                    (
                        false,
                        vec![
                            t("Land snapshot diff viewer behind a flag - "),
                            mr(ids, N_SNAPS, "Snapshots - the feature that surprised us"),
                        ],
                    ),
                    (
                        false,
                        vec![
                            t("Rewrite first-launch copy - "),
                            mr(ids, N_ONBOARD, "Onboarding - the first 60 seconds"),
                        ],
                    ),
                ]),
                h2("Inbox"),
                chk(vec![
                    (
                        false,
                        vec![
                            t("Triage three new bug reports - "),
                            mr(ids, N_BUGS, "Bugs - week of April 28"),
                        ],
                    ),
                    (
                        false,
                        vec![
                            t("Draft a reply to the \"why no Windows?\" email - lean on "),
                            mr(ids, N_MAC, "Why Mac-first (for now)"),
                        ],
                    ),
                    (
                        false,
                        vec![
                            t("Approve the new screenshot set - checklist in "),
                            mr(ids, N_SCREEN, "Marketing screenshot checklist"),
                        ],
                    ),
                ]),
                h2("Don't touch today"),
                bul(vec![
                    vec![
                        bs("AI surface area"),
                        t(" - decision is logged in "),
                        mr(ids, N_AI, "AI - what we said yes to, what we said no to"),
                        t("."),
                    ],
                    vec![
                        bs("Pricing page"),
                        t(" - "),
                        mr(ids, N_PRICE, "Pricing - the question we keep dodging"),
                        t(" still open."),
                    ],
                ]),
            ],
        ),
        // 2
        make_demo(
            "Roadmap - next 3 releases",
            false,
            vec![
                pt("Coarse-grained. We don't promise dates - we promise shape."),
                h2("v0.7 - April"),
                chk(vec![
                    (
                        true,
                        vec![
                            t("Sidebar redesign + virtualized list - "),
                            mr(ids, N_SIDEBAR, "Sidebar redesign - what we learned"),
                        ],
                    ),
                    (
                        false,
                        vec![
                            t("Snapshot diff viewer (read-only) - "),
                            mr(ids, N_SNAPS, "Snapshots - the feature that surprised us"),
                        ],
                    ),
                    (false, vec![cs("Cmd+."), t(" - toggle the command bar from anywhere")]),
                    (false, vec![t("Per-note color tags (max 5)")]),
                ]),
                h2("v0.8 - May"),
                chk(vec![
                    (false, vec![t("Backlinks panel (data is already captured, just no UI)")]),
                    (false, vec![t("Folders / nesting - one level deep, no more")]),
                    (false, vec![t("Markdown export per note + bulk")]),
                ]),
                h2("v0.9 - June"),
                chk(vec![
                    (false, vec![t("Web clipper (Mac extension)")]),
                    (false, vec![t("Daily notes (templated)")]),
                    (false, vec![t("First pass at sync - encrypted, opt-in, our infra is the boring part")]),
                ]),
                h2("Definitely not in 2026"),
                bul(vec![
                    vec![
                        t("Mobile apps - reasons in "),
                        mr(ids, N_MAC, "Why Mac-first (for now)"),
                        t("."),
                    ],
                    vec![t("Built-in AI editor.")],
                    vec![t("Real-time collaboration.")],
                ]),
            ],
        ),
        // 3
        make_demo(
            "Why we left Notion",
            false,
            vec![
                pi("We were Notion users for 4 years. We tried hard. Here's the honest list."),
                h2("What broke us"),
                num_(vec![
                    vec![t("Cold start was 3 - 6 seconds. Every single time.")],
                    vec![t("Searching across 8k pages took longer than reading three of them.")],
                    vec![
                        bs("Loading state on every navigation."),
                        t(" You never feel like the app is yours - you feel like a tab."),
                    ],
                    vec![t("Offline mode was a polite lie.")],
                    vec![t("Every page felt like a database row pretending to be a note.")],
                ]),
                h2("What it did well"),
                bul(vec![
                    vec![t("Mention search was excellent.")],
                    vec![t("Templates were actually useful.")],
                    vec![t("Inline databases - genuinely powerful for the right brain.")],
                ]),
                h2("What we kept"),
                bul(vec![
                    vec![
                        t("Slash menus for block insertion - we'll get there ("),
                        mr(ids, N_ROADMAP, "Roadmap - next 3 releases"),
                        t(")."),
                    ],
                    vec![t("@-mentions feel right when they work this fast.")],
                    vec![t("Every block addressable, even if we don't expose it yet.")],
                ]),
                qb("We didn't leave Notion because it was bad. We left because it stopped being for note-takers."),
            ],
        ),
        // 4
        make_demo(
            "Apps we benchmarked against",
            false,
            vec![
                pt("Honest read on every app we open during research. Updated as we test."),
                h2("Bear"),
                bul(vec![
                    vec![bs("Wins:"), t(" typography is unmatched. Tag system is brilliant.")],
                    vec![bs("Loses:"), t(" pricing splits features awkwardly. Search is fine, not great.")],
                    vec![bs("What we steal:"), t(" the typography hierarchy. Shamelessly.")],
                ]),
                h2("Apple Notes"),
                bul(vec![
                    vec![bs("Wins:"), t(" free, fast, ubiquitous. Quick capture is killer.")],
                    vec![bs("Loses:"), t(" structure caps out at folders. Markdown is hostile.")],
                    vec![
                        bs("What we steal:"),
                        t(" the share-sheet flow into "),
                        mr(ids, N_CAPTURE, "Quick capture - the unsung hero"),
                        t("."),
                    ],
                ]),
                h2("Obsidian"),
                bul(vec![
                    vec![bs("Wins:"), t(" graph view. Plugin ecosystem. Local-first we agree with.")],
                    vec![bs("Loses:"), t(" the empty state makes new users bounce.")],
                    vec![bs("What we steal:"), t(" backlinks. Already capturing the data.")],
                ]),
                h2("Reflect"),
                bul(vec![
                    vec![bs("Wins:"), t(" AI integration is the cleanest we've seen.")],
                    vec![bs("Loses:"), t(" subscription is steep. Sync is the whole product.")],
                    vec![
                        bs("What we steal:"),
                        t(" the daily-note metaphor (eventually - "),
                        mr(ids, N_ROADMAP, "Roadmap - next 3 releases"),
                        t(")."),
                    ],
                ]),
                h2("Bike"),
                bul(vec![
                    vec![bs("Wins:"), t(" outliner that respects the keyboard.")],
                    vec![bs("Loses:"), t(" deliberately niche, which is also a strength.")],
                ]),
            ],
        ),
        // 5
        make_demo(
            "Sidebar redesign - what we learned",
            false,
            vec![
                pi("Shipped in v0.6. Took two attempts. Here's what we got wrong the first time."),
                h2("What we got wrong"),
                num_(vec![
                    vec![t("First version re-rendered every row on every keystroke. Fine at 100 notes; somebody opened it with 50k.")],
                    vec![t("Pinned notes were re-fetched as part of pagination. Should have been a separate call.")],
                    vec![t("Time labels updated only on hover. Looked broken.")],
                ]),
                h2("What we got right"),
                num_(vec![
                    vec![
                        t("Virtualization from day one. Without it, none of this was tractable - see "),
                        mr(ids, N_MILLION, "1,000,000 notes - the budget"),
                        t("."),
                    ],
                    vec![t("Row heights measured once and cached in a Fenwick tree. Re-flow is O(log n).")],
                    vec![t("Live time labels - tick at 1Hz, batched, off the main thread (we don't have one - it's Solid).")],
                ]),
                h2("Open follow-ups"),
                chk(vec![
                    (true, vec![t("Drag-to-reorder pinned notes")]),
                    (false, vec![t("Section headers (Today, Yesterday, Earlier)")]),
                    (false, vec![t("Right-click on group header to collapse")]),
                ]),
            ],
        ),
        // 6
        make_demo(
            "1,000,000 notes - the budget",
            false,
            vec![
                pi("Non-negotiable: the app stays snappy with a million notes. If it doesn't, we redesign before we ship."),
                h2("Rules we follow"),
                num_(vec![
                    vec![t("No "), cs("SELECT"), t(" without a "), cs("LIMIT"), t(".")],
                    vec![t("No O(n) work on the render path.")],
                    vec![t("No "), cs("querySelectorAll"), t(" against the sidebar.")],
                    vec![t("Cursor-based pagination, sliding window, capped in-memory prefix.")],
                ]),
                h2("How we test"),
                chk(vec![
                    (true, vec![t("Dev panel can seed 100k notes in <60s")]),
                    (true, vec![t("Sidebar scroll is jank-free at 1M")]),
                    (false, vec![t("Search hits stay under 200ms p95 at 1M")]),
                    (false, vec![t("Cold start under 600ms at 1M")]),
                ]),
                h2("Why we care"),
                p(vec![
                    t("If a feature can't survive this test, it's a demo. The "),
                    mr(ids, N_ROADMAP, "Roadmap - next 3 releases"),
                    t(" gets filtered through this rule first, design second."),
                ]),
                qb("The user with 14 notes is happy either way. The user with 14,000 quietly leaves if you ignore them."),
            ],
        ),
        // 7
        make_demo(
            "Things users keep asking for",
            false,
            vec![
                pi("Living list. Recount monthly. The top of this list shapes the next release."),
                h2("Almost certainly yes"),
                chk(vec![
                    (false, vec![t("Tags (and a tag sidebar)")]),
                    (false, vec![t("Folders - one level, that's it")]),
                    (false, vec![t("Markdown export")]),
                    (false, vec![t("Web clipper")]),
                ]),
                h2("Maybe"),
                chk(vec![
                    (false, vec![t("Daily notes")]),
                    (false, vec![t("Inline images via paste")]),
                    (false, vec![t("Code blocks with syntax highlighting")]),
                    (false, vec![t("iOS / iPad app")]),
                ]),
                h2("Probably not"),
                chk(vec![
                    (false, vec![t("Real-time collaboration")]),
                    (
                        false,
                        vec![
                            t("Inline AI rewrite - see "),
                            mr(ids, N_AI, "AI - what we said yes to, what we said no to"),
                        ],
                    ),
                    (false, vec![t("Wikilinks via "), cs("[[ ]]"), t(" - we have @-mentions")]),
                ]),
                h2("Hard no"),
                bul(vec![
                    vec![t("An account system.")],
                    vec![t("A web version that needs a server we run.")],
                    vec![t("Auto-update without a download button.")],
                ]),
            ],
        ),
        // 8
        make_demo(
            "Bugs - week of April 28",
            false,
            vec![
                pi("Triaged Monday. Anything not fixed by Friday slips to next week's list."),
                h2("Open"),
                chk(vec![
                    (false, vec![bs("P1"), t(" - sidebar flickers on first paint after cold start")]),
                    (false, vec![bs("P2"), t(" - mention popover misses the caret on long lines")]),
                    (false, vec![bs("P2"), t(" - command bar steals focus from the editor on close")]),
                    (false, vec![bs("P3"), t(" - quote block has no top margin after a list")]),
                ]),
                h2("Fixed this week"),
                chk(vec![
                    (true, vec![t("Snapshots panel scrollbar overlapped the close button")]),
                    (true, vec![t("Trash count was stale after Empty Trash")]),
                    (true, vec![t("@-mention insertion left a stray space when the popover closed early")]),
                ]),
                h2("Won't fix"),
                bul(vec![
                    vec![
                        t("macOS 12 and below - we're on the Sonoma+ vibrancy API now (see "),
                        mr(ids, N_MAC, "Why Mac-first (for now)"),
                        t(")."),
                    ],
                ]),
            ],
        ),
        // 9
        make_demo(
            "Lexical - the bet that paid off",
            false,
            vec![
                pt("Written down so we remember why we picked it when the next shiny thing shows up."),
                h2("Why Lexical"),
                num_(vec![
                    vec![t("The state model is JSON we own. No HTML guessing.")],
                    vec![t("Vanilla mode. We don't pay React's tax for using a React-flavored editor.")],
                    vec![
                        t("Custom node types are first-class - "),
                        cs("MentionNode"),
                        t(", "),
                        cs("ImageNode"),
                        t(", future tag nodes."),
                    ],
                    vec![t("Reconciler is fast at thousands of nodes. We've measured.")],
                ]),
                h2("Where it bit us"),
                bul(vec![
                    vec![bs("Markdown shortcuts"), t(" - had to build our own list-aware copy handler.")],
                    vec![bs("Selection paths"), t(" - the API is correct but cryptic. We wrap it.")],
                    vec![
                        bs("Custom nodes need importJSON / exportJSON"),
                        t(" - skip one and saves silently lose data."),
                    ],
                ]),
                h2("What we'd do differently"),
                bul(vec![
                    vec![t("Wrap every Lexical API in our own thin layer earlier.")],
                    vec![t("Write the JSON test suite before the visual one.")],
                ]),
            ],
        ),
        // 10
        make_demo(
            "Why Mac-first (for now)",
            false,
            vec![
                pi("We get this email a lot. Here's the honest answer."),
                h2("What Mac gets us"),
                bul(vec![
                    vec![t("Vibrancy and traffic-light controls that look right by default.")],
                    vec![t("A predictable keyboard - "), cs("Cmd"), t(" is "), cs("Cmd"), t(", everywhere.")],
                    vec![t("Global shortcuts that work without setup theater.")],
                    vec![t("A user base that pays for software.")],
                ]),
                h2("What goes wrong cross-platform"),
                bul(vec![
                    vec![t("Tauri runs on Windows. The app runs. It looks alien.")],
                    vec![t("Vibrancy doesn't translate. We'd need a whole second visual language.")],
                    vec![
                        t("Quick capture ("),
                        mr(ids, N_CAPTURE, "Quick capture - the unsung hero"),
                        t(") expects an OS-level chord that doesn't exist consistently elsewhere."),
                    ],
                ]),
                h2("When that changes"),
                num_(vec![
                    vec![t("After the Mac app feels finished. Not before.")],
                    vec![
                        t("After we have a clear story for sync - see "),
                        mr(ids, N_ROADMAP, "Roadmap - next 3 releases"),
                        t("."),
                    ],
                    vec![t("Probably 2027. Maybe never. We'd rather be loved on one platform than tolerated on three.")],
                ]),
            ],
        ),
        // 11
        make_demo(
            "Keyboard shortcut wish list",
            false,
            vec![
                h2("Have it"),
                bul(vec![
                    vec![cs("Cmd+N"), t(" - new note")],
                    vec![cs("Cmd+K"), t(" - command bar")],
                    vec![cs("Cmd+F"), t(" - search inside the current note")],
                    vec![cs("Cmd+Shift+F"), t(" - search across all notes")],
                    vec![cs("Cmd+B / I / U"), t(" - the obvious")],
                ]),
                h2("Want it"),
                chk(vec![
                    (
                        false,
                        vec![
                            cs("Cmd+."),
                            t(" - toggle command bar from anywhere (queued for v0.7 - "),
                            mr(ids, N_ROADMAP, "Roadmap - next 3 releases"),
                            t(")"),
                        ],
                    ),
                    (false, vec![cs("Cmd+Alt+1..6"), t(" - jump to pinned note by index")]),
                    (false, vec![cs("Cmd+Enter"), t(" - mark a checklist item from anywhere on the line")]),
                    (false, vec![cs("Cmd+P"), t(" - quick switcher (different from the command bar)")]),
                ]),
                h2("Won't do"),
                bul(vec![
                    vec![t("Vim mode.")],
                    vec![t("Customizable everything. Five global, the rest are real keys.")],
                ]),
                p(vec![
                    t("Discussed in last week's "),
                    mr(ids, N_SIDEBAR, "Sidebar redesign - what we learned"),
                    t(" retro."),
                ]),
            ],
        ),
        // 12
        make_demo(
            "Snapshots - the feature that surprised us",
            false,
            vec![
                pi("Built it as a safety net. Users found it and started treating it as version history. We're leaning in."),
                h2("What it does today"),
                bul(vec![
                    vec![t("Auto-snapshot every 5 minutes of editing per note.")],
                    vec![t("Manual snapshot via "), cs("Cmd+S"), t(".")],
                    vec![t("Last 50 auto-snapshots kept per note. Manual snapshots never expire.")],
                ]),
                h2("What's missing"),
                chk(vec![
                    (false, vec![t("Diff view between any two snapshots")]),
                    (false, vec![t("\"Star\" a snapshot to keep it forever")]),
                    (false, vec![t("Snapshot from selection - keep just the section you wrote")]),
                    (false, vec![t("Restore-and-keep (current creates a new snapshot first - confirm UI is unclear)")]),
                ]),
                h2("What people said"),
                qb("I rewrote a 2,000-word note, hated it, and got back to the original in two clicks. This is the only feature I'd pay for."),
                p(vec![
                    t("Filed under "),
                    mr(ids, N_REQUESTS, "Things users keep asking for"),
                    t(" for the next survey."),
                ]),
            ],
        ),
        // 13
        make_demo(
            "Marketing screenshot checklist",
            false,
            vec![
                pi("Set the app up exactly like this before opening QuickTime. Resize the window to 1920x1200."),
                h2("Setup"),
                chk(vec![
                    (true, vec![t("Use the demo content seed ("), cs("Cmd+Shift+D"), t(" - Seed 20 demo notes)")]),
                    (
                        true,
                        vec![
                            t("Pinned: "),
                            mr(ids, N_MANIFESTO, "NoteZ - what we're building"),
                            t(" + "),
                            mr(ids, N_TODAY, "Today"),
                        ],
                    ),
                    (false, vec![t("Sidebar collapsed to ~280px")]),
                    (false, vec![t("Window centered, not maximized - we want the vibrancy")]),
                    (false, vec![t("Hide the dev panel button on the toolbar")]),
                ]),
                h2("Shots to capture"),
                num_(vec![
                    vec![
                        t("Hero - editor view of "),
                        mr(ids, N_MANIFESTO, "NoteZ - what we're building"),
                    ],
                    vec![t("Sidebar focus - the pinned/unpinned split")],
                    vec![
                        t("Command bar open with \"todo\" typed (auto-shows "),
                        mr(ids, N_TODAY, "Today"),
                        t(")"),
                    ],
                    vec![t("@-mention popover open mid-sentence")],
                    vec![
                        t("Snapshot list with 12+ entries (open "),
                        mr(ids, N_SNAPS, "Snapshots - the feature that surprised us"),
                        t(")"),
                    ],
                    vec![t("Quick capture window over a desktop screenshot")],
                ]),
                h2("Don't include"),
                bul(vec![
                    vec![t("The dev tag in the corner.")],
                    vec![t("Any note with placeholder lorem ipsum text.")],
                    vec![t("Traffic lights on hover (red is too loud in marketing shots).")],
                ]),
            ],
        ),
        // 14
        make_demo(
            "Release checklist - v0.7.0",
            false,
            vec![
                pi("Patch bumps don't ship a build. Minor bumps do. Don't tag without going through this list."),
                h2("Pre-tag"),
                chk(vec![
                    (
                        false,
                        vec![
                            t("All bugs in "),
                            mr(ids, N_BUGS, "Bugs - week of April 28"),
                            t(" resolved or moved to the next release"),
                        ],
                    ),
                    (
                        false,
                        vec![
                            t("Roadmap items for v0.7 in "),
                            mr(ids, N_ROADMAP, "Roadmap - next 3 releases"),
                            t(" are checked"),
                        ],
                    ),
                    (false, vec![t("Five version files match (package.json, tauri.conf.json, Cargo.toml, README, badge)")]),
                    (
                        false,
                        vec![
                            t("README still describes the app correctly - re-read it cold ("),
                            mr(ids, N_README, "README - things to fix"),
                            t(")"),
                        ],
                    ),
                    (false, vec![t("CHANGELOG entry written")]),
                ]),
                h2("Tag and ship"),
                num_(vec![
                    vec![cs("git commit -am \"chore: v0.7.0 - <summary>\"")],
                    vec![cs("git tag v0.7.0 && git push origin main --tags")],
                    vec![t("GitHub Action picks up the tag and builds the .dmg.")],
                    vec![t("Verify the release notes include the "), cs("xattr -cr"), t(" line.")],
                    vec![t("Update the website download link.")],
                ]),
                h2("Post-ship"),
                chk(vec![
                    (false, vec![t("Smoke-test the .dmg from a clean download")]),
                    (
                        false,
                        vec![
                            t("Post a release note + 60s screen capture (use "),
                            mr(ids, N_SCREEN, "Marketing screenshot checklist"),
                            t(")"),
                        ],
                    ),
                    (false, vec![t("Email the people who reported the bugs we fixed")]),
                ]),
            ],
        ),
        // 15
        make_demo(
            "AI - what we said yes to, what we said no to",
            false,
            vec![
                pi("Recorded so we don't relitigate this every quarter."),
                h2("Yes"),
                bul(vec![
                    vec![t("Title generation from a note's body - opt-in, single OpenRouter key, your bill.")],
                    vec![t("Find similar notes - local embedding, eventually.")],
                    vec![t("Search-as-question, but only as an upgrade path - keyword search must always work.")],
                ]),
                h2("No"),
                bul(vec![
                    vec![t("Inline \"rewrite this paragraph\" - we're not Grammarly.")],
                    vec![t("Auto-summaries that appear without you asking.")],
                    vec![t("Chat with your notes panel. Other apps do this. They're not us.")],
                    vec![t("Any AI that runs without an explicit user action.")],
                ]),
                h2("Why"),
                qb("If we can't ship the app without an LLM running, we've built a chatbot with a sidebar. We're building notes."),
                p(vec![
                    t("Decision logged. Linked from "),
                    mr(ids, N_MANIFESTO, "NoteZ - what we're building"),
                    t(" under \"What we'll never do\"."),
                ]),
            ],
        ),
        // 16
        make_demo(
            "Pricing - the question we keep dodging",
            false,
            vec![
                pi("Three options on the table. Picking one before v1.0."),
                h2("Option A: Free, MIT, forever"),
                bul(vec![
                    vec![bs("Pro:"), t(" no business-model overhead, no surprise churn.")],
                    vec![bs("Con:"), t(" no funding for a producer, a designer, or a Windows port.")],
                ]),
                h2("Option B: One-time purchase, $39 - $49"),
                bul(vec![
                    vec![bs("Pro:"), t(" Mac-native pricing. Users like owning software.")],
                    vec![bs("Con:"), t(" we have to ship a paid-update story (e.g. major version bumps).")],
                ]),
                h2("Option C: Subscription with a generous free tier"),
                bul(vec![
                    vec![bs("Pro:"), t(" predictable revenue.")],
                    vec![
                        bs("Con:"),
                        t(" Notion-shaped. Most days that feels wrong (see "),
                        mr(ids, N_LEFT_NOTION, "Why we left Notion"),
                        t(")."),
                    ],
                ]),
                h2("Decision criteria"),
                chk(vec![
                    (false, vec![t("Sustains one full-time builder for 24 months")]),
                    (false, vec![t("Doesn't compromise the local-first promise")]),
                    (
                        false,
                        vec![
                            t("Survives the 1M-note user (see "),
                            mr(ids, N_MILLION, "1,000,000 notes - the budget"),
                            t(")"),
                        ],
                    ),
                ]),
            ],
        ),
        // 17
        make_demo(
            "README - things to fix",
            false,
            vec![
                pi("Read the README cold once a month. List what feels stale here."),
                h2("Stale right now"),
                chk(vec![
                    (
                        false,
                        vec![
                            t("Screenshot is from v0.5 - retake using "),
                            mr(ids, N_SCREEN, "Marketing screenshot checklist"),
                        ],
                    ),
                    (false, vec![t("Install section still says \"requires macOS 13\". We support 12.5+.")]),
                    (
                        false,
                        vec![
                            t("Roadmap section is shorter than reality - sync with "),
                            mr(ids, N_ROADMAP, "Roadmap - next 3 releases"),
                        ],
                    ),
                    (false, vec![t("Three em-dashes left in. We don't use those.")]),
                ]),
                h2("Tone problems"),
                bul(vec![
                    vec![t("Opens with features. Should open with one sentence about who it's for.")],
                    vec![t("Says \"the future of note-taking\" once. Cut it.")],
                ]),
                h2("Done this quarter"),
                chk(vec![
                    (true, vec![t("Updated install copy to match release notes")]),
                    (true, vec![t("Added the badge with the current version")]),
                    (true, vec![t("Linked to the GitHub releases page from the install button")]),
                ]),
            ],
        ),
        // 18
        make_demo(
            "Onboarding - the first 60 seconds",
            false,
            vec![
                pt("Our onboarding is invisible. That's a feature - and a problem."),
                h2("What happens now"),
                num_(vec![
                    vec![t("User opens the app. Empty editor. Cursor in place.")],
                    vec![t("No tour. No \"welcome\" note. Nothing.")],
                    vec![t("User figures it out. Or they don't.")],
                ]),
                h2("Why we like that"),
                bul(vec![
                    vec![t("It respects the user's intelligence.")],
                    vec![
                        t("It loads in under 600ms because there's nothing to load (see "),
                        mr(ids, N_MILLION, "1,000,000 notes - the budget"),
                        t(")."),
                    ],
                    vec![t("It's the opposite of Notion's empty-state hellscape.")],
                ]),
                h2("Why it's a problem"),
                bul(vec![
                    vec![
                        t("First-time users don't discover "),
                        mr(ids, N_CAPTURE, "Quick capture - the unsung hero"),
                        t("."),
                    ],
                    vec![t("Mention syntax is invisible. People type @ and nothing happens for 200ms.")],
                    vec![
                        t("Snapshots ("),
                        mr(ids, N_SNAPS, "Snapshots - the feature that surprised us"),
                        t(") are completely hidden. Best feature, zero discovery."),
                    ],
                ]),
                h2("Fix proposal"),
                chk(vec![
                    (false, vec![t("First note auto-created with three lines: a heading, a checklist item, an @-mention example")]),
                    (false, vec![t("If the user deletes it, we don't bring it back. Adults.")]),
                    (false, vec![t("On second launch, surface a \"tips\" command in the command bar - opt-in only")]),
                ]),
            ],
        ),
        // 19
        make_demo(
            "Quick capture - the unsung hero",
            false,
            vec![
                p(vec![
                    cs("Cmd+Shift+Space"),
                    t(" from anywhere. Mini textarea. "),
                    cs("Cmd+Enter"),
                    t(" saves. "),
                    cs("Esc"),
                    t(" dismisses. That's the whole feature."),
                ]),
                h2("Why people love it"),
                bul(vec![
                    vec![t("Opens in under 100ms because the window stays alive in the background.")],
                    vec![t("Doesn't steal focus from your current app for longer than it needs to.")],
                    vec![t("Notes go straight into the inbox - no folder picker, no tag prompt.")],
                ]),
                h2("What's broken"),
                chk(vec![
                    (false, vec![t("Window can land off-screen on multi-monitor setups")]),
                    (false, vec![cs("Cmd+W"), t(" should dismiss; currently does nothing")]),
                    (false, vec![t("Pasted images get dropped (need to wire "), cs("ImageNode"), t(" in here too)")]),
                ]),
                h2("What we won't add"),
                bul(vec![
                    vec![t("A dropdown to pick the destination.")],
                    vec![t("Markdown formatting - it's a textarea on purpose.")],
                    vec![
                        t("AI title generation on save - different argument, see "),
                        mr(ids, N_AI, "AI - what we said yes to, what we said no to"),
                        t("."),
                    ],
                ]),
                pt("If you could only keep one feature in the app, the team would vote for this one."),
            ],
        ),
    ]
}

