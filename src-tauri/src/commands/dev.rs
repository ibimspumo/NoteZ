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
// Some indices aren't currently mentioned by any other note - kept for
// symmetry so future edits to the demo set can cross-link them without
// hunting for the right number.
#[allow(dead_code)]
const N_APEX: usize = 0;
#[allow(dead_code)]
const N_STANDUP: usize = 1;
#[allow(dead_code)]
const N_ONBOARD: usize = 2;
#[allow(dead_code)]
const N_VOICE: usize = 3;
#[allow(dead_code)]
const N_SOCIAL: usize = 4;
#[allow(dead_code)]
const N_MIRA: usize = 5;
#[allow(dead_code)]
const N_PERF: usize = 6;
#[allow(dead_code)]
const N_LUMEN: usize = 7;
#[allow(dead_code)]
const N_SEO: usize = 8;
#[allow(dead_code)]
const N_EMAIL: usize = 9;
#[allow(dead_code)]
const N_SHOOT: usize = 10;
#[allow(dead_code)]
const N_BUDGET: usize = 11;
#[allow(dead_code)]
const N_OKR: usize = 12;
#[allow(dead_code)]
const N_CRISIS: usize = 13;
#[allow(dead_code)]
const N_NEWS: usize = 14;
#[allow(dead_code)]
const N_NORTH: usize = 15;
#[allow(dead_code)]
const N_WEBINAR: usize = 16;
#[allow(dead_code)]
const N_YEAR: usize = 17;
#[allow(dead_code)]
const N_PILLARS: usize = 18;
#[allow(dead_code)]
const N_RETRO: usize = 19;

fn build_demo_notes(ids: &[String]) -> Vec<DemoNote> {
    vec![
        // 0 - pinned
        make_demo(
            "Q3 Brand Refresh - Apex Athletics",
            true,
            vec![
                h2("Goals"),
                bul(vec![
                    vec![t("Reposition Apex as the premium runner's brand.")],
                    vec![t("Cut creative production costs "), bs("18%"), t(" with a unified asset system.")],
                    vec![t("Launch hero campaign by "), bs("September 12"), t(".")],
                ]),
                h2("Workstreams"),
                num_(vec![
                    vec![bs("Visual identity"), t(" - new wordmark, palette, motion language.")],
                    vec![bs("Photography"), t(" - athlete-led, on-location, no studio fallbacks.")],
                    vec![bs("Site rebuild"), t(" - migrate the storefront to a headless CMS.")],
                ]),
                h2("Cross-references"),
                p(vec![
                    t("Tone direction lives in "),
                    mr(ids, N_VOICE, "Brand Voice & Tone Guide"),
                    t(". Budget is tracked in "),
                    mr(ids, N_BUDGET, "Q2 Budget Reconciliation"),
                    t(". Shoot day plan: "),
                    mr(ids, N_SHOOT, "Photoshoot Shotlist - Summer"),
                    t("."),
                ]),
                qb("Premium isn't a price point. It's a feeling of inevitability."),
            ],
        ),
        // 1 - pinned
        make_demo(
            "Weekly Standup - Monday",
            true,
            vec![
                h2("Last week"),
                chk(vec![
                    (true, vec![t("Shipped Apex moodboard v3")]),
                    (true, vec![t("Recorded Lumen pitch dry-run")]),
                    (false, vec![t("Approve June social calendar")]),
                    (false, vec![t("Send invoice batch to finance")]),
                ]),
                h2("This week"),
                chk(vec![
                    (false, vec![t("Lock photoshoot crew for July 8")]),
                    (false, vec![t("Brief "), mr(ids, N_MIRA, "Influencer Brief - Mira Tanaka"), t(" on TikTok cutdowns")]),
                    (false, vec![t("Walk through "), mr(ids, N_SEO, "SEO Audit - Riverstone Co."), t(" with Riverstone")]),
                    (false, vec![t("Finalize "), mr(ids, N_LUMEN, "Pitch Notes - Lumen Labs")]),
                ]),
                h2("Blockers"),
                p(vec![
                    t("Northwind teardown is blocked on legal review - notes in "),
                    mr(ids, N_NORTH, "Competitor Teardown - Northwind"),
                    t("."),
                ]),
            ],
        ),
        // 2
        make_demo(
            "Client Onboarding Checklist",
            false,
            vec![
                pi("Run through every step before kickoff. Skipping any of these is how scope creep starts."),
                h2("Pre-kickoff"),
                chk(vec![
                    (true, vec![t("Signed SOW received and filed")]),
                    (true, vec![t("Slack channel created and pinned")]),
                    (true, vec![t("Shared drive provisioned with the standard folder set")]),
                    (false, vec![t("Stakeholder map confirmed with client")]),
                    (false, vec![t("Decision-maker identified for sign-offs")]),
                ]),
                h2("Kickoff"),
                chk(vec![
                    (false, vec![t("Schedule 90-minute kickoff (creative + strategy + account)")]),
                    (false, vec![t("Send pre-read 48 hours in advance")]),
                    (false, vec![t("Capture success criteria in writing, in the room")]),
                ]),
                h2("First two weeks"),
                num_(vec![
                    vec![t("Brand audit deck due day 10.")],
                    vec![t("Tone-of-voice workshop day 12 - reference "), mr(ids, N_VOICE, "Brand Voice & Tone Guide"), t(".")],
                    vec![t("First creative review day 14.")],
                ]),
                qb("If it isn't on the checklist, it isn't onboarding. Add it or skip it."),
            ],
        ),
        // 3
        make_demo(
            "Brand Voice & Tone Guide",
            false,
            vec![
                h2("How we sound"),
                pt("Confident, never boastful. We earn the room before we own it."),
                bul(vec![
                    vec![bs("Direct"), t(" - short sentences, active voice, real verbs.")],
                    vec![bs("Warm"), t(" - use second person. Talk to one human, not an audience.")],
                    vec![bs("Specific"), t(" - numbers beat adjectives. \"Cut launch time 40%\" beats \"much faster.\"")],
                ]),
                h3("Words we reach for"),
                p(vec![
                    t("Prefer "),
                    cs("launch"),
                    t(", "),
                    cs("ship"),
                    t(", "),
                    cs("reach"),
                    t(", "),
                    cs("sharpen"),
                    t("."),
                ]),
                h3("Words we avoid"),
                p(vec![
                    t("Hard pass on "),
                    cs("leverage"),
                    t(", "),
                    cs("synergy"),
                    t(", "),
                    cs("ecosystem"),
                    t(", "),
                    cs("circle back"),
                    t("."),
                ]),
                qb("If you wouldn't say it out loud to a friend, don't write it for the brand."),
            ],
        ),
        // 4
        make_demo(
            "Social Calendar - June",
            false,
            vec![
                h2("Anchor posts"),
                num_(vec![
                    vec![bs("Mon 6/2"), t(" - Carousel: \"How Apex chose its new wordmark\"")],
                    vec![bs("Wed 6/4"), t(" - Reel: behind-the-scenes from Tuesday's shoot")],
                    vec![bs("Fri 6/6"), t(" - Static: founder quote + portrait")],
                    vec![bs("Mon 6/9"), t(" - Long-form: case study teaser for "), mr(ids, N_LUMEN, "Pitch Notes - Lumen Labs")],
                ]),
                h2("Influencer drops"),
                p(vec![
                    t("Mira's three-part series goes live the week of 6/16. Brief in "),
                    mr(ids, N_MIRA, "Influencer Brief - Mira Tanaka"),
                    t("."),
                ]),
                h2("Reactive slots"),
                bul(vec![
                    vec![t("Hold Tuesday and Thursday afternoons for trend hijacks.")],
                    vec![t("Comms team approval window: 2pm - 5pm same-day.")],
                ]),
                h3("Risk flags"),
                pt("Avoid Friday sends in June - Q2 data shows ~30% lower engagement vs Tuesday."),
            ],
        ),
        // 5
        make_demo(
            "Influencer Brief - Mira Tanaka",
            false,
            vec![
                pt("Three-part TikTok series, posted week of June 16. Focus on the shift from her old running shoes to the new Apex Glide."),
                h2("Deliverables"),
                num_(vec![
                    vec![t("Unboxing (45 - 60s)")],
                    vec![t("First 5km review (60 - 90s)")],
                    vec![t("Style + training day vlog (~90s)")],
                ]),
                h2("Must include"),
                chk(vec![
                    (true, vec![t("Brand handle in caption and on-screen")]),
                    (true, vec![t("Disclosure tag in first 3 seconds")]),
                    (false, vec![t("Hashtag set: "), cs("#ApexGlide"), t(" "), cs("#BuiltToRun")]),
                    (false, vec![t("CTA: \"link in bio for early access\"")]),
                ]),
                h2("Tone"),
                p(vec![
                    t("Read like Mira talking to a friend, not Mira reading our deck. Reference "),
                    mr(ids, N_VOICE, "Brand Voice & Tone Guide"),
                    t(" if a phrase feels off."),
                ]),
                qb("If the first three seconds aren't honest, the rest doesn't matter."),
            ],
        ),
        // 6
        make_demo(
            "Performance Report - April",
            false,
            vec![
                h2("Headline"),
                p(vec![
                    bs("CPA down 22% MoM. Reach up 14% on a flat budget."),
                    t(" Best month of the quarter."),
                ]),
                h2("By channel"),
                bul(vec![
                    vec![bs("Paid social"), t(" - CPM down 11%, ROAS 4.1x")],
                    vec![bs("Search"), t(" - branded queries up 38% (likely halo from "), mr(ids, N_MIRA, "Influencer Brief - Mira Tanaka"), t(")")],
                    vec![bs("Email"), t(" - open rate 41.6%, click 6.2%. Sequence in "), mr(ids, N_EMAIL, "Welcome Email Sequence"), t(".")],
                ]),
                h2("What worked"),
                num_(vec![
                    vec![t("Hooks under 2 seconds outperformed every long-form variant.")],
                    vec![t("Static + UGC hybrid beat polished video on cost.")],
                    vec![t("Subject lines in the 35 - 45 character range had the best open rate.")],
                ]),
                h2("What didn't"),
                num_(vec![
                    vec![t("Carousel ads underperformed - pausing for May.")],
                    vec![t("Friday sends underperformed by ~30% vs Tuesday.")],
                ]),
                pt("Full deck filed in shared drive."),
            ],
        ),
        // 7
        make_demo(
            "Pitch Notes - Lumen Labs",
            false,
            vec![
                pi("First call: Thursday 2pm. They've already talked to two other agencies."),
                h2("What they want"),
                bul(vec![
                    vec![t("Repositioning around \"science-backed sleep\".")],
                    vec![t("New PDP system that converts on mobile.")],
                    vec![t("Six-month content engine they can run in-house after.")],
                ]),
                h2("What they really want"),
                qb("We need to stop sounding like a mattress company."),
                h2("Our angle"),
                num_(vec![
                    vec![t("Lead with category insight, not capabilities.")],
                    vec![t("Bring a 30-second cut of the Apex hero - proves we ship: "), mr(ids, N_APEX, "Q3 Brand Refresh - Apex Athletics"), t(".")],
                    vec![t("End with a 90-day plan, priced.")],
                ]),
                h2("Risks"),
                chk(vec![
                    (false, vec![t("Their CMO leaves in Q4 - decision could stall")]),
                    (false, vec![t("Procurement requires two more agencies on the shortlist")]),
                    (false, vec![t("Crisis comms on day one if their recall expands - see "), mr(ids, N_CRISIS, "Crisis Comms Playbook")]),
                ]),
            ],
        ),
        // 8
        make_demo(
            "SEO Audit - Riverstone Co.",
            false,
            vec![
                h2("Top issues"),
                num_(vec![
                    vec![t("Title tags missing on "), bs("41%"), t(" of product pages.")],
                    vec![bs("Crawl budget wasted on faceted URLs"), t(" - 12k near-duplicate URLs in index.")],
                    vec![t("No internal linking from blog posts to PDPs.")],
                    vec![t("Core Web Vitals fail on mobile (LCP 4.2s).")],
                ]),
                h2("Quick wins this sprint"),
                chk(vec![
                    (false, vec![t("Add canonical tags to faceted URLs")]),
                    (false, vec![t("Compress hero images (avg 1.4MB - target <250kB)")]),
                    (false, vec![t("Rewrite the 18 highest-traffic title tags")]),
                ]),
                h2("Q3 roadmap"),
                bul(vec![
                    vec![t("Topical authority hub for \"natural stone care\".")],
                    vec![t("Programmatic location pages (38 metros).")],
                    vec![t("Internal link graph rebuild.")],
                ]),
                p(vec![
                    t("Findings deck in shared drive. Action plan synced with content team in "),
                    mr(ids, N_NEWS, "Newsletter Backlog"),
                    t("."),
                ]),
            ],
        ),
        // 9
        make_demo(
            "Welcome Email Sequence",
            false,
            vec![
                pt("Five emails over ten days. Goal: first purchase by day 14."),
                h2("Sequence"),
                num_(vec![
                    vec![bs("Email 1 (Day 0)"), t(" - Welcome and brand story. Single CTA.")],
                    vec![bs("Email 2 (Day 2)"), t(" - Best-sellers. Social proof above the fold.")],
                    vec![bs("Email 3 (Day 5)"), t(" - Founder note. No product.")],
                    vec![bs("Email 4 (Day 7)"), t(" - Free shipping nudge with a 72h timer.")],
                    vec![bs("Email 5 (Day 10)"), t(" - \"Still here?\" - light, low-pressure.")],
                ]),
                h2("Tone"),
                p(vec![
                    t("Read like "),
                    mr(ids, N_VOICE, "Brand Voice & Tone Guide"),
                    t(". Short paragraphs. One thought per line."),
                ]),
                h2("Subject lines (drafted)"),
                bul(vec![
                    vec![cs("Welcome to Apex - one thing first")],
                    vec![cs("The shoes everyone keeps reordering")],
                    vec![cs("Why we started")],
                    vec![cs("Free shipping ends Friday")],
                    vec![cs("Still thinking it over?")],
                ]),
            ],
        ),
        // 10
        make_demo(
            "Photoshoot Shotlist - Summer",
            false,
            vec![
                pi("July 8 - 10. Joshua Tree. Crew of 11. Sunrise calls every day."),
                h2("Day 1 - Athletes"),
                chk(vec![
                    (false, vec![t("Sprint sequence (front, back, three-quarter)")]),
                    (false, vec![t("Lace-up close-up - hands only")]),
                    (false, vec![t("Mid-stride - low angle, motion blur")]),
                    (false, vec![t("Hero portrait - golden hour")]),
                ]),
                h2("Day 2 - Lifestyle"),
                chk(vec![
                    (false, vec![t("Truck-bed flat-lay (shoes, water, map)")]),
                    (false, vec![t("Walking-away wide shot, dust kicked up")]),
                    (false, vec![t("Group laugh, not posed")]),
                ]),
                h2("Day 3 - Product"),
                chk(vec![
                    (false, vec![t("All 6 colorways, white sweep")]),
                    (false, vec![t("Detail macros: stitching, sole, logo")]),
                    (false, vec![t("Buffer shots for ecom")]),
                ]),
                p(vec![
                    t("Final selects feed "),
                    mr(ids, N_SOCIAL, "Social Calendar - June"),
                    t(" and the website rebuild in "),
                    mr(ids, N_APEX, "Q3 Brand Refresh - Apex Athletics"),
                    t("."),
                ]),
            ],
        ),
        // 11
        make_demo(
            "Q2 Budget Reconciliation",
            false,
            vec![
                h2("Summary"),
                p(vec![
                    bs("$312k of $340k spent. Under budget by 8.2%."),
                ]),
                h2("By account"),
                bul(vec![
                    vec![mr(ids, N_APEX, "Q3 Brand Refresh - Apex Athletics"), t(" - $148k (target $150k)")],
                    vec![mr(ids, N_SEO, "SEO Audit - Riverstone Co."), t(" - $86k (target $90k)")],
                    vec![mr(ids, N_NORTH, "Competitor Teardown - Northwind"), t(" - $52k (target $55k)")],
                    vec![mr(ids, N_LUMEN, "Pitch Notes - Lumen Labs"), t(" - $0 (pitching)")],
                ]),
                h2("Variance flags"),
                num_(vec![
                    vec![t("Photography "), bs("+$8k"), t(" over - Joshua Tree day-rate increase.")],
                    vec![t("Paid media "), bs("-$22k"), t(" under - June flight pushed to July.")],
                    vec![t("Software flat - no surprises.")],
                ]),
                pt("Detailed CSV in finance shared drive."),
            ],
        ),
        // 12
        make_demo(
            "H1 OKRs - 2026",
            false,
            vec![
                h2("Objective 1: Become the agency clients reference unprompted"),
                bul(vec![
                    vec![bs("KR1"), t(" - 4 inbound leads per month from referrals.")],
                    vec![bs("KR2"), t(" - NPS at or above 60 across active accounts.")],
                    vec![bs("KR3"), t(" - 2 case studies published per quarter.")],
                ]),
                h2("Objective 2: Make great work without burning the team"),
                bul(vec![
                    vec![bs("KR1"), t(" - Average billable hours at or under 36 per week per IC.")],
                    vec![bs("KR2"), t(" - 100% of projects use the shared production system.")],
                    vec![bs("KR3"), t(" - Zero weekend deploys.")],
                ]),
                h2("Objective 3: Lock in revenue we can plan around"),
                bul(vec![
                    vec![bs("KR1"), t(" - 70% of Q3 revenue from retainers.")],
                    vec![bs("KR2"), t(" - 3 new retainers signed by end of June.")],
                    vec![bs("KR3"), t(" - Average contract length up from 4 to 7 months.")],
                ]),
                qb("OKRs aren't a wishlist. If we miss two of three, we picked wrong."),
            ],
        ),
        // 13
        make_demo(
            "Crisis Comms Playbook",
            false,
            vec![
                pt("Use this when something goes sideways - product recall, exec issue, viral negative post."),
                h2("First hour"),
                num_(vec![
                    vec![t("Acknowledge internally in the client Slack within 15 minutes.")],
                    vec![t("Pull facts before forming a position - never the other way around.")],
                    vec![t("Identify the single spokesperson.")],
                ]),
                h2("First day"),
                chk(vec![
                    (false, vec![t("Issue holding statement (3 - 4 sentences, no speculation)")]),
                    (false, vec![t("Pause all scheduled paid and organic posts")]),
                    (false, vec![t("Brief account team and legal on a single thread")]),
                ]),
                h2("Don'ts"),
                bul(vec![
                    vec![bs("Don't"), t(" apologize for things you don't yet understand.")],
                    vec![bs("Don't"), t(" ghost the press - \"we're investigating\" is a real answer.")],
                    vec![bs("Don't"), t(" let the founder tweet.")],
                ]),
                qb("The story you tell in the first 24 hours is the story you live with for six months."),
            ],
        ),
        // 14
        make_demo(
            "Newsletter Backlog",
            false,
            vec![
                pt("Running list of issue ideas. Prune monthly. Anything older than 90 days gets killed or rewritten."),
                h2("Ready to draft"),
                chk(vec![
                    (false, vec![t("How Apex chose its wordmark - long-form, ~1500 words. Source: "), mr(ids, N_APEX, "Q3 Brand Refresh - Apex Athletics")]),
                    (false, vec![t("What we learned ripping Riverstone's site apart - source: "), mr(ids, N_SEO, "SEO Audit - Riverstone Co.")]),
                    (false, vec![t("Three subject-line patterns we'll use forever - source: "), mr(ids, N_EMAIL, "Welcome Email Sequence")]),
                ]),
                h2("Needs an angle"),
                bul(vec![
                    vec![t("Why we stopped pitching with case studies.")],
                    vec![t("The deck slide we always cut at the last minute.")],
                    vec![t("On hiring our first producer.")],
                ]),
                h2("Killed"),
                bul(vec![
                    vec![is_("AI in advertising (too crowded)")],
                    vec![is_("Year-in-review (saving for December)")],
                ]),
            ],
        ),
        // 15
        make_demo(
            "Competitor Teardown - Northwind",
            false,
            vec![
                pi("Honest read on what they do better than us, what they don't, and what to steal."),
                h2("What they do well"),
                num_(vec![
                    vec![t("Site speed - PDP loads in 1.1s on mobile.")],
                    vec![t("Email - their welcome series is the cleanest in the category.")],
                    vec![t("Hiring - they publish process docs publicly. Magnetic for senior talent.")],
                ]),
                h2("What they don't"),
                num_(vec![
                    vec![t("Strategy work feels generic - same deck for every client.")],
                    vec![t("Photography is stock-y, even on hero pages.")],
                    vec![t("No point of view in their thought leadership.")],
                ]),
                h2("Steal-with-pride list"),
                chk(vec![
                    (true, vec![t("Their PDP load-speed budget")]),
                    (true, vec![t("Public hiring docs (adapt for our team)")]),
                    (false, vec![t("Their Slack-first project status format")]),
                ]),
                p(vec![
                    t("Cross-reference benchmark numbers in "),
                    mr(ids, N_PERF, "Performance Report - April"),
                    t("."),
                ]),
            ],
        ),
        // 16
        make_demo(
            "Webinar Production Plan",
            false,
            vec![
                pt("60-minute webinar, late June. Topic: \"Building a brand engine without 40 freelancers.\""),
                h2("Roles"),
                bul(vec![
                    vec![bs("Host"), t(" - creative director")],
                    vec![bs("Co-host"), t(" - strategy lead")],
                    vec![bs("Producer"), t(" - runs chat, switches scenes, kills silence")],
                ]),
                h2("Run of show"),
                num_(vec![
                    vec![t("0:00 - Welcome + housekeeping (2 min)")],
                    vec![t("0:02 - Why this topic, why now (5 min)")],
                    vec![t("0:07 - Three case stories (25 min) - Apex, Riverstone, Lumen")],
                    vec![t("0:32 - Live audit of an attendee's brand (15 min)")],
                    vec![t("0:47 - Q&A (10 min)")],
                    vec![t("0:57 - CTA + close (3 min)")],
                ]),
                h2("Pre-flight"),
                chk(vec![
                    (false, vec![t("Test audio on the actual hardware 24h before")]),
                    (false, vec![t("Two backup slides per section")]),
                    (false, vec![t("Pre-seed three Q&A questions in chat")]),
                ]),
                p(vec![
                    t("Promo plan inside "),
                    mr(ids, N_SOCIAL, "Social Calendar - June"),
                    t(" and "),
                    mr(ids, N_EMAIL, "Welcome Email Sequence"),
                    t("."),
                ]),
            ],
        ),
        // 17
        make_demo(
            "Year-End Wrap-Up Ideas",
            false,
            vec![
                pt("Holding pen for the December creative push. Pick 2 - 3 by October."),
                h2("Format options"),
                num_(vec![
                    vec![t("Long-form essay - \"The work we're proudest of, and why\".")],
                    vec![t("Photo book - print run for the top 50 clients.")],
                    vec![t("Short film - 90 seconds, behind-the-scenes from the year.")],
                    vec![t("Annual report parody - real numbers, dry humor.")],
                ]),
                h2("Constraints"),
                bul(vec![
                    vec![t("No new client work in the December push.")],
                    vec![t("Budget cap: "), bs("$25k all-in"), t(".")],
                    vec![t("Must ship by Dec 12 - team is off after the 19th.")],
                ]),
                p(vec![
                    t("Cross-post into "),
                    mr(ids, N_PILLARS, "Content Pillars 2026"),
                    t(" so we don't double-up on January content."),
                ]),
                qb("End-of-year work is the agency's resume. Treat it like one."),
            ],
        ),
        // 18
        make_demo(
            "Content Pillars 2026",
            false,
            vec![
                h2("Pillar 1 - Craft"),
                pt("How we make the work. Process posts, before/after, redlines."),
                bul(vec![
                    vec![t("Tear-downs of our own past projects.")],
                    vec![t("Workshops on-camera - no scripts, real edits.")],
                ]),
                h2("Pillar 2 - Point of view"),
                pt("What we believe about the industry. Counter-narrative is the goal."),
                bul(vec![
                    vec![t("Essays from the leadership team.")],
                    vec![t("Reactions to industry news, within 48 hours.")],
                ]),
                h2("Pillar 3 - People"),
                pt("The team, the clients, the rooms we work in."),
                bul(vec![
                    vec![t("New-hire intros.")],
                    vec![t("Client features - in-depth, not testimonials.")],
                ]),
                p(vec![
                    t("All publishing flows through "),
                    mr(ids, N_NEWS, "Newsletter Backlog"),
                    t(" before scheduling."),
                ]),
            ],
        ),
        // 19
        make_demo(
            "Team Retro - March",
            false,
            vec![
                h2("What went well"),
                bul(vec![
                    vec![t("Apex pitch landed on the first round - "), mr(ids, N_APEX, "Q3 Brand Refresh - Apex Athletics"), t(".")],
                    vec![t("Two new retainers signed - both inbound.")],
                    vec![t("Production system handled three concurrent shoots without churn.")],
                ]),
                h2("What didn't"),
                bul(vec![
                    vec![t("Riverstone scope creep - "), bs("28% over original SOW"), t(". Notes in "), mr(ids, N_SEO, "SEO Audit - Riverstone Co."), t(".")],
                    vec![t("Two missed Friday deadlines on social - process gap, not capacity.")],
                    vec![t("Onboarding for the new producer was rushed.")],
                ]),
                h2("Actions for April"),
                chk(vec![
                    (false, vec![t("Add scope-change template to "), mr(ids, N_ONBOARD, "Client Onboarding Checklist")]),
                    (false, vec![t("Lock social ship-day to Thursday")]),
                    (false, vec![t("Run new-hire ramp at 2 weeks minimum")]),
                ]),
                qb("Retros without owners are just a feelings circle. Every action gets a name."),
            ],
        ),
    ]
}
