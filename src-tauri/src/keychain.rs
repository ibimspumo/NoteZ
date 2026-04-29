//! OS-keychain wrapper. Wraps the `keyring` crate with our error type and
//! a single owner ("notez bundle id, account name = setting key").
//!
//! Why a wrapper:
//!   - We want the bundle identifier in one place (`KEYCHAIN_SERVICE`).
//!   - The keyring crate's errors don't `From<>`-convert into `NoteZError`
//!     cleanly, so a thin shim keeps callers simple (`?`-propagation works).
//!   - On `NoEntry` we return `Ok(None)` instead of an error - that's the
//!     ergonomic choice (the absence of a key is a normal state, not a fault).
//!   - We hold an in-process cache: macOS prompts the user for keychain
//!     access on every read for unsigned binaries (and even on signed ones
//!     for new ACL grants). Caching the key in RAM after the first
//!     successful read means a session of N AI calls fires 1 prompt, not N.
//!     The cache is invalidated on `set` and `delete` so it never goes
//!     stale relative to the keychain.

use crate::constants::{KEYCHAIN_ACCOUNT_OPENROUTER, KEYCHAIN_SERVICE};
use crate::error::{NoteZError, Result};
use std::sync::{OnceLock, RwLock};

fn entry(account: &str) -> Result<keyring::Entry> {
    keyring::Entry::new(KEYCHAIN_SERVICE, account)
        .map_err(|e| NoteZError::Other(format!("keychain entry: {e}")))
}

fn map_keyring_err(e: keyring::Error) -> NoteZError {
    NoteZError::Other(format!("keychain: {e}"))
}

fn get_uncached(account: &str) -> Result<Option<String>> {
    let entry = entry(account)?;
    match entry.get_password() {
        Ok(s) => Ok(Some(s)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(map_keyring_err(e)),
    }
}

pub fn set(account: &str, value: &str) -> Result<()> {
    let entry = entry(account)?;
    entry.set_password(value).map_err(map_keyring_err)
}

fn delete_uncached(account: &str) -> Result<()> {
    let entry = entry(account)?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        // Idempotent delete: missing entry == success.
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(map_keyring_err(e)),
    }
}

// ─── In-process cache ─────────────────────────────────────────────────────
//
// We use `Option<Option<String>>` so we can distinguish three states:
//   - `None`              → never read; next access triggers a keychain hit
//   - `Some(None)`        → keychain confirmed empty (or deleted)
//   - `Some(Some(value))` → cached value
//
// Behind a `RwLock` so multiple AI calls can read concurrently without
// blocking each other.

type Cache = RwLock<Option<Option<String>>>;
static OPENROUTER_CACHE: OnceLock<Cache> = OnceLock::new();

fn openrouter_cache() -> &'static Cache {
    OPENROUTER_CACHE.get_or_init(|| RwLock::new(None))
}

pub fn get_openrouter_key() -> Result<Option<String>> {
    // Fast path: cached.
    if let Ok(c) = openrouter_cache().read() {
        if let Some(cached) = c.as_ref() {
            return Ok(cached.clone());
        }
    }
    // Slow path: hit the keychain (this is what triggers the OS prompt).
    let value = get_uncached(KEYCHAIN_ACCOUNT_OPENROUTER)?;
    if let Ok(mut c) = openrouter_cache().write() {
        *c = Some(value.clone());
    }
    Ok(value)
}

pub fn set_openrouter_key(value: &str) -> Result<()> {
    set(KEYCHAIN_ACCOUNT_OPENROUTER, value)?;
    if let Ok(mut c) = openrouter_cache().write() {
        *c = Some(Some(value.to_string()));
    }
    Ok(())
}

pub fn delete_openrouter_key() -> Result<()> {
    delete_uncached(KEYCHAIN_ACCOUNT_OPENROUTER)?;
    if let Ok(mut c) = openrouter_cache().write() {
        *c = Some(None);
    }
    Ok(())
}
