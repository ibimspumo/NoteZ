# Sharing - Plan (later)

How users will share a single note with another person, without breaking
NoteZ' "local-only, no telemetry, fully offline" promise.

Two phases. Phase 1 needs no server at all. Phase 2 is optional and only
gets built if Phase 1 isn't enough in practice.

## Phase 1: Deep-Link Sharing (no server)

The whole note (title + Lexical state) is compressed and stuffed into a
custom-scheme link. Recipient clicks, NoteZ opens, preview dialog, import.
Both parties need NoteZ installed.

**Pipeline:**
1. Serialize note (Lexical JSON or Markdown render)
2. Compress with `zstd` level 22 (using `zstd` crate in Rust)
3. Wire-format prefix: `[version: 1B][dict_id: 1B][payload]`
   - `dict_id = 0` means dictionary-less zstd (ship this first)
   - Future `dict_id >= 1` reserved for custom-trained dictionaries if URL
     length becomes a real complaint
4. URL-safe base64 encode
5. Wrap in `notez://import/v1?d=<encoded>`

**Receiver side:**
- Tauri 2 `tauri-plugin-deep-link` registers `notez://` scheme on macOS
- Parse version + dict_id, decompress, deserialize
- Show preview modal with title and first lines, user confirms before insert
- Imported note gets a fresh UUID (never overwrite existing IDs)

**Bench numbers (already measured in `tools/share-bench/`):**
- 22-word note: 375 char URL (no dict) / 174 with dict
- 430-word note: 1506 chars / 1232 with dict
- 770-word note: 1678 chars / 1362 with dict

**Open questions for Phase 1:**
- Round-trip strategy: ship Lexical JSON directly (simplest, future-proof)
  or pre-render to Markdown (smaller but lossy for custom nodes like
  mentions). Recommendation: Lexical JSON, dict_id=0 to start.
- Mentions across users: a `@mention` in the shared note references a
  note ID that the recipient doesn't have. On import, render the mention
  as plain text or as a "broken link" pill, never silently drop.
- Image embedding: images are local file paths. Phase 1 either skips
  images or inlines them as base64 (blows up URL fast). Recommendation:
  strip images with a notice in the import dialog, defer image-sharing
  to Phase 2.

## Phase 2: Optional Cloud Shortlinks (later, only if needed)

For when users want to share with people who don't have NoteZ, or want a
short clean URL instead of a 1.5kb wall of base64. Strictly optional in
the app: a toggle in Share dialog ("Create short link"), default off.

**Hard constraints:**
- End-to-end encryption mandatory. Server never sees plaintext.
- No account, no signup, no email.
- Self-expiring (max 30 days TTL, user picks).
- Has to be ripoutable: if the service goes down, the rest of the app
  keeps working.

**Architecture:**

```
[NoteZ App]                     [API on Vercel/Sevalla]    [DB on Convex/Sevalla]
     |                                    |                          |
     | encrypt locally (AES-GCM, 256-bit) |                          |
     | key never leaves device            |                          |
     |--- POST /api/share (ciphertext) -->|                          |
     |                                    |--- write {id, ct, ttl}-->|
     |<-- {id: "8saj-18sj"} --------------|                          |
     |                                                               |
     | Build link: take-notez.com/s/8saj-18sj#<base64-key>           |
     | (the #fragment is browser-only, never sent to server)         |
```

Recipient opens link in browser → small landing page that either
deep-links into NoteZ (`notez://import/v2?id=8saj-18sj#<key>`) or
offers a read-only web preview if they don't have the app installed.

**Routes (small, stateless):**
- `POST /api/register` - returns per-install token on first use
- `POST /api/share` - body: `{ ciphertext, ttl_hours }`, returns `{ id }`
- `GET /s/:id` - returns ciphertext + a tiny landing page
- `DELETE /api/share/:id` - revoke own share (token must match)

**Stack candidates (in preference order):**
1. **Vercel + Convex** - known stack, Convex handles TTL natively, edge
   functions for the routes, free tier covers a lot. Convex' subscription
   model on the client side is overkill here, but for Phase 2's tiny
   surface that's fine.
2. **Sevalla** - all-in-one, simpler ops if you don't already have
   anything on Vercel. Slightly less ecosystem but one bill, one dashboard.
3. **Cloudflare Workers + KV** - cheapest at scale, but requires picking
   up CF's tooling. Skip unless cost becomes an issue.

**Security model (the actually-important part):**

The misconception to avoid: a bundled API key in a desktop binary is
**not** secret. Anyone can extract it with `strings`. So:

- **Per-install token, not a global key.** App calls `/api/register` on
  first launch, stores token in macOS Keychain. Server has the list,
  can revoke individual abusive tokens without nuking everyone.
- **Rate limit on the server** is the real defense, not key secrecy.
  Suggested baseline: 50 shares/day per token, 100/day per IP, 100KB
  max ciphertext per share.
- **E2E crypto in the URL fragment** means the server hosts opaque
  bytes and never has the decryption key. This both protects user
  privacy and makes abuse cheaper to handle (you delete an unreadable
  blob; you don't have to look at it).
- **Optional Cloudflare Turnstile or HashCash-style PoW** if spam ever
  becomes a problem. Don't bother on day one.
- **Logging discipline:** never log ciphertext, tokens, or anything
  derivable. Counters and error codes only.
- **CORS lockdown:** API only accepts requests from the desktop app
  (custom user-agent header check) and from `take-notez.com` itself.

**TODO checklist when this gets built:**

- [ ] Pick stack (Vercel+Convex vs Sevalla) and stand up empty project
- [ ] Implement client-side AES-GCM encrypt/decrypt in the Tauri app
  (Rust `aes-gcm` crate, generate key with `OsRng`)
- [ ] Wire `notez://import/v2?id=...` deep-link variant for Phase 2 links
- [ ] Build `/api/register` and per-install token storage (Keychain)
- [ ] Build `/api/share` and `/s/:id` with rate limits + size cap + TTL
- [ ] Landing page at `/s/:id` with download-NoteZ fallback for users
  without the app
- [ ] Settings toggle: enable cloud sharing (default off)
- [ ] User-facing share dialog: deep-link copy vs. short-link create
- [ ] Privacy page on take-notez.com explaining what the server sees
  and doesn't see
- [ ] Monitoring: counter dashboard for share creates, retrieves, and
  rate-limit-rejects. No content, no tokens.

**Effort estimate (rough):**
- Phase 1 (deep-link sharing): 2-3 days
- Phase 2 MVP (server + E2E + UI): 3-4 days on top
- Phase 2 hardening (rate limits, abuse mitigation, monitoring): 2-3 days

## Security model (applies to both phases)

A shared note is untrusted input from a stranger. The receiver's NoteZ
must treat it that way, both for deep links and for cloud shortlinks.
The threat that matters most: a Tauri webview XSS gives the attacker
access to `window.__TAURI__.invoke(...)`, which means arbitrary Rust
command execution on the recipient's machine (delete notes, read files,
anything in the allowlist). XSS in a Tauri app is not "just an alert".

**Mandatory mitigations on the import path:**

- **Decompression cap.** Refuse any payload whose decompressed size
  exceeds a hard limit (e.g. 5 MB). Use streaming zstd decode with a
  byte counter that aborts early. This blocks decompression bombs.
- **Schema validation before Lexical sees it.** Don't pipe raw JSON
  into `parseEditorState`. First validate against a known Lexical
  schema: whitelist of allowed node types (root, paragraph, text,
  heading, list, listitem, link, mention, image), reject anything
  unknown. Reject unexpected fields rather than ignoring them.
- **URL scheme allowlist for link nodes.** Strip or refuse any link
  whose `url` is not `http(s)://`, `mailto:`, or `notez://`.
  Explicitly block `javascript:`, `data:`, `vbscript:`, `file:`,
  and friends. This is the single most important XSS prevention.
- **No HTML pass-through, ever.** Text nodes carry plain strings only.
  No `innerHTML` / `dangerouslySetInnerHTML` / template injection on
  any field that came from the share payload.
- **Strict CSP in `tauri.conf.json`.** Block inline scripts, `eval`,
  remote script loading. This is the last-line defense if validation
  has a hole.
- **Tauri capability scoping.** Audit which commands the webview can
  invoke. Don't grant the import flow more access than it needs. The
  share-import command runs with the smallest scope possible.
- **Mention IDs are remapped, not trusted.** A `@mention` referencing
  a UUID is rendered as a broken-link pill on import unless the
  recipient explicitly chooses to relink it to a local note. Never
  silently dereference a foreign note ID against the local DB.
- **Imported note gets a fresh UUID.** Never overwrite or merge into an
  existing note. The recipient's note IDs are off-limits to the sender.
- **Confirmation dialog before insert.** User sees title + first lines,
  has to click "Import". No auto-import on click. Prevents
  drive-by-imports from a malicious link in chat.
- **Image handling.** Phase 1: strip embedded images with a notice.
  Phase 2: re-fetch images server-side or render them inert
  (`sandbox` attribute, no JS, no event handlers).

**Server side (Phase 2 specifics):**

- E2E encryption means the server hosts opaque ciphertext - it cannot
  inspect, scan, or modify the content, which is both a privacy
  feature and an abuse-liability shield.
- Size cap on ciphertext (100 KB) to bound the bomb potential.
- `:id` parameter must match a fixed regex (e.g. `[a-z0-9]{4}-[a-z0-9]{4}`).
  No path traversal, no SQL injection (Convex queries are typed anyway,
  but defense in depth).
- Browser landing page at `/s/:id`: render preview only inside a
  sandboxed iframe (`sandbox="allow-same-origin"` only, no scripts),
  or skip preview entirely and just offer "open in NoteZ" / "install".
- Rate limits on `/api/share` per token and per IP (already noted above).

**What we're explicitly not promising:**

- We do not protect against the recipient *manually* copy-pasting a
  malicious-looking link into their address bar after being told to.
  Phishing via social engineering is out of scope.
- We do not protect against a compromised sender (their machine is
  malware-controlled). They can sign whatever they want, the
  encryption only protects content in transit.
- A determined attacker with a zero-day in Lexical's parser or in
  zstd's decoder could bypass our schema validation. We mitigate via
  CSP + capability scoping + confirmation dialog so even a successful
  exploit has a small blast radius, but no app is unhackable.

**Pre-launch security checklist (must all be green before shipping):**

- [ ] Fuzz test the deep-link import path with malformed base64,
  malformed zstd, malformed JSON, oversized payloads
- [ ] Unit test that every banned URL scheme is rejected by link-node
  validation
- [ ] Manual XSS attempt: craft a payload with `javascript:` in a
  link-node, confirm import either rejects or renders inert
- [ ] Confirm CSP is set in `tauri.conf.json` and inline scripts fail
- [ ] Audit Tauri allowlist: import flow runs with minimum scope
- [ ] Confirm decompression cap fires on a known-bad zstd bomb sample
- [ ] (Phase 2) Penetration test of API: rate-limit bypass, oversized
  payloads, malformed IDs, replay attacks on `/api/share`

## Why this order

Phase 1 ships the 80% case for free. The "share with non-NoteZ users"
gap is real but small: most NoteZ-to-NoteZ sharing among existing users
will work fine with deep links, and we get to validate that anyone
actually wants the feature before standing up infrastructure.

Phase 2 is the "Bitwarden Send" pattern, well-trodden territory, low
ongoing cost, and stays optional. If we never build it, NoteZ' offline
promise is fully intact. If we do build it, the E2E design keeps that
promise even when users opt in.
