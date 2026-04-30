//! Backend constants. Single source of truth - the frontend's
//! `src/lib/constants.ts` mirrors the values that need to match (kept in sync
//! manually; tested by `cross_check_constants` if/when we add an integration
//! test).

// ─── Pagination ───────────────────────────────────────────────────────────

/// Hard cap to keep IPC frames small even if a buggy caller asks for the moon.
/// 500 rows ≈ 80 KB of NoteSummary JSON - that's our budget per RTT.
pub const MAX_PAGE_SIZE: u32 = 500;

/// Default page size when caller omits the limit.
pub const DEFAULT_PAGE_SIZE: u32 = 100;

/// Hard ceiling on pinned items. Pinned counts are bounded by user behaviour
/// in practice - this guards against a misuse / future-sync-bug dumping 100k
/// rows into the IPC.
pub const MAX_PINNED: i64 = 200;

/// Snapshot list page cap.
pub const MAX_SNAPSHOTS_PAGE: u32 = 200;

/// AI-calls list page cap.
pub const MAX_AI_PAGE: u32 = 200;

// ─── Search ───────────────────────────────────────────────────────────────

/// Stage-1 FTS5 candidate pool size. Stage-2 re-ranks these in memory.
pub const FTS_CANDIDATE_POOL: i64 = 500;

/// Default search limit.
pub const DEFAULT_SEARCH_LIMIT: usize = 50;

/// Hard cap on search results.
pub const MAX_SEARCH_LIMIT: u32 = 200;

/// Default quick-lookup limit.
pub const DEFAULT_QUICK_LOOKUP_LIMIT: u32 = 8;

/// Hard cap on quick-lookup.
pub const MAX_QUICK_LOOKUP_LIMIT: u32 = 20;

// ─── Snapshots ────────────────────────────────────────────────────────────

/// Maximum auto-snapshots retained per note. Older auto-snapshots get pruned
/// at insert time. Manual snapshots are subject to a separate (much higher) cap.
pub const MAX_AUTO_SNAPSHOTS_PER_NOTE: i64 = 50;

/// Maximum manual snapshots per note. Defense against a runaway-script.
pub const MAX_MANUAL_SNAPSHOTS_PER_NOTE: i64 = 500;

// ─── Previews ─────────────────────────────────────────────────────────────

/// Sidebar / command-bar preview length cap (in chars).
pub const PREVIEW_MAX_CHARS: usize = 140;

// ─── AI ledger ────────────────────────────────────────────────────────────

/// Auto-trim threshold for the `ai_calls` table. Older calls beyond this count
/// are deleted opportunistically (after every successful insert).
pub const AI_CALLS_RETENTION: i64 = 10_000;

/// AI title generation: max input chars sent to the LLM.
pub const AI_TITLE_MAX_INPUT_CHARS: usize = 8_000;

/// AI HTTP timeout.
pub const AI_HTTP_TIMEOUT_SECS: u64 = 30;

/// OpenRouter models cache TTL.
pub const AI_MODELS_CACHE_TTL_SECS: u64 = 3_600;

/// Maximum tokens for the title-generation completion.
pub const AI_TITLE_MAX_TOKENS: u32 = 80;

/// Maximum length of the sanitized title we'll keep.
pub const AI_TITLE_MAX_CHARS: usize = 120;

// ─── Asset / image embeds ─────────────────────────────────────────────────

/// Maximum bytes we accept for an image asset (16 MB). Above this we reject -
/// the editor flow can't stream a 100 MB blob over the IPC anyway.
pub const MAX_ASSET_BYTES: u64 = 16 * 1024 * 1024;

/// Blurhash thumbnail decode size.
pub const BLURHASH_DECODE_SIZE: u32 = 256;

// ─── Per-note content caps ────────────────────────────────────────────────

/// Hard cap on a single note's `content_text`. 16 MB of plain text is enough
/// for several novels worth of content while preventing a buggy paste from
/// inflating the DB or stalling FTS5 indexing.
pub const MAX_NOTE_TEXT_BYTES: usize = 16 * 1024 * 1024;

/// Hard cap on a single note's `content_json`. Lexical state is structurally
/// 3-5x bigger than its plain-text content, so allow proportionally more.
pub const MAX_NOTE_JSON_BYTES: usize = 64 * 1024 * 1024;

/// Maximum number of mention targets a single note can declare. Prevents a
/// pathological note (or a buggy save) from hammering the mentions table.
pub const MAX_MENTION_TARGETS_PER_NOTE: usize = 5_000;

/// Maximum number of asset references a single note can declare.
pub const MAX_ASSET_REFS_PER_NOTE: usize = 5_000;

// ─── Settings caps ────────────────────────────────────────────────────────

/// Max settings-value length. The Lexical-pane-layout blob is the heaviest
/// known consumer (~10 KB at MAX_PANES + tabs); 1 MB leaves comfortable
/// headroom while preventing a runaway `cursor:<uuid>` write from filling
/// the table.
pub const MAX_SETTING_VALUE_BYTES: usize = 1024 * 1024;

/// Max settings-key length. Real keys are ≤ 80 chars; this just blocks
/// pathological writes.
pub const MAX_SETTING_KEY_BYTES: usize = 256;

// ─── Database / SQLite ────────────────────────────────────────────────────

/// `r2d2` pool max size.
pub const DB_POOL_SIZE: u32 = 8;

/// SQLite busy timeout.
pub const DB_BUSY_TIMEOUT_SECS: u64 = 5;

// ─── Setting keys (persisted in the `settings` table) ─────────────────────
//
// Listed here so the allowlist in `commands::settings` can validate them.
// Anything not on this list (and not a recognized prefix like `cursor:`) is
// rejected at the IPC boundary as defense-in-depth.

pub const SETTING_TRASH_RETENTION: &str = "trash_retention_days";
/// Active theme id. Built-in: "default", "light", "mono". Custom themes
/// (Phase 2) will use UUIDs that resolve against on-disk `.nzt` files.
pub const SETTING_THEME_ID: &str = "theme_id";
/// Legacy: pre-theme-system "color_mode" with values "default" | "mono".
/// Read at startup as a migration fallback when `theme_id` is absent.
pub const SETTING_COLOR_MODE_LEGACY: &str = "color_mode";
pub const SETTING_SIDEBAR_PREVIEW_LINES: &str = "sidebar_preview_lines";
pub const SETTING_QUICK_CAPTURE: &str = "shortcut_quick_capture";
pub const SETTING_COMMAND_BAR: &str = "shortcut_command_bar";
pub const SETTING_AI_ENABLED: &str = "ai_title_enabled";
pub const SETTING_AI_MODEL: &str = "ai_model";
/// Legacy: the OpenRouter API key used to live here. Keep the key constant
/// for migration logic; new writes go to the OS keychain.
pub const SETTING_OPENROUTER_KEY_LEGACY: &str = "openrouter_api_key";
/// Marker setting: "1" if a key is stored in the keychain, "0" or missing
/// otherwise. Lets the UI render the "Stored / Clear" state without an
/// IPC roundtrip per render.
pub const SETTING_OPENROUTER_KEY_PRESENT: &str = "openrouter_api_key_present";
/// Serialized pane-tree layout + active-pane id, so the app reopens with the
/// same split topology and last-focused note.
pub const SETTING_PANES_LAYOUT: &str = "panes:layout";
/// JSON-encoded `FolderFilter` so the sidebar reopens scoped to the same
/// folder the user last had selected.
pub const SETTING_ACTIVE_FOLDER_FILTER: &str = "folders:active_filter";
/// JSON-encoded array of folder ids that were expanded in the sidebar tree.
pub const SETTING_EXPANDED_FOLDERS: &str = "folders:expanded";
/// "1" if the folders section in the sidebar was open at last save, else absent.
pub const SETTING_FOLDERS_SECTION_OPEN: &str = "folders:section_open";

/// All known top-level setting keys. The allowlist in `set_setting` accepts
/// either an exact match here or a recognized dynamic prefix (`cursor:`).
pub const KNOWN_SETTING_KEYS: &[&str] = &[
    SETTING_TRASH_RETENTION,
    SETTING_THEME_ID,
    SETTING_COLOR_MODE_LEGACY,
    SETTING_SIDEBAR_PREVIEW_LINES,
    SETTING_QUICK_CAPTURE,
    SETTING_COMMAND_BAR,
    SETTING_AI_ENABLED,
    SETTING_AI_MODEL,
    SETTING_OPENROUTER_KEY_LEGACY,
    SETTING_OPENROUTER_KEY_PRESENT,
    SETTING_PANES_LAYOUT,
    SETTING_ACTIVE_FOLDER_FILTER,
    SETTING_EXPANDED_FOLDERS,
    SETTING_FOLDERS_SECTION_OPEN,
];

/// Dynamic keys that match a prefix. None left as of v7 - cursor data
/// moved to the dedicated `cursors` table. Kept as an empty array for
/// future expansion (e.g. per-pane scratch state) without re-introducing
/// the `cursor:` allowlist hole.
pub const KNOWN_SETTING_PREFIXES: &[&str] = &[];

// ─── Keychain ─────────────────────────────────────────────────────────────

/// Keychain service name. Chosen to match the bundle identifier so the entry
/// shows up cleanly in Keychain Access.
pub const KEYCHAIN_SERVICE: &str = "de.agent-z.notez";
/// Per-key entry name within the service.
pub const KEYCHAIN_ACCOUNT_OPENROUTER: &str = "openrouter_api_key";

// ─── Cross-window events ──────────────────────────────────────────────────

/// Fired by the backend when settings change so peer windows can refresh.
pub const EVENT_SETTINGS_CHANGED: &str = "notez://settings/changed";
