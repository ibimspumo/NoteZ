use serde::{Serialize, Serializer};

#[derive(Debug, thiserror::Error)]
pub enum NoteZError {
    #[error("database: {0}")]
    Database(#[from] rusqlite::Error),

    #[error("pool: {0}")]
    Pool(#[from] r2d2::Error),

    #[error("io: {0}")]
    Io(#[from] std::io::Error),

    #[error("serde: {0}")]
    Serde(#[from] serde_json::Error),

    #[error("not found: {0}")]
    NotFound(String),

    #[error("invalid input: {0}")]
    InvalidInput(String),

    #[error("tauri: {0}")]
    Tauri(#[from] tauri::Error),
}

impl Serialize for NoteZError {
    fn serialize<S: Serializer>(&self, ser: S) -> std::result::Result<S::Ok, S::Error> {
        ser.serialize_str(self.to_string().as_ref())
    }
}

pub type Result<T> = std::result::Result<T, NoteZError>;
