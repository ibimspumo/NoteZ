// Configurable global shortcut machinery.
//
// Shortcuts are stored as strings in the `settings` table (e.g. "super+alt+KeyN")
// and live-mutable: changing one in the UI re-registers it without a restart.

use std::sync::Mutex;
use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ShortcutSpec {
    pub mods: Modifiers,
    pub key: Code,
}

impl ShortcutSpec {
    pub fn to_shortcut(self) -> Shortcut {
        Shortcut::new(Some(self.mods), self.key)
    }

    /// Strict match: exactly the configured mods (in our known set) and the same key.
    pub fn matches(self, mods: Modifiers, key: Code) -> bool {
        let known =
            Modifiers::SUPER | Modifiers::ALT | Modifiers::SHIFT | Modifiers::CONTROL;
        (mods & known) == self.mods && key == self.key
    }

    pub fn to_canonical(self) -> String {
        let mut parts: Vec<&'static str> = Vec::new();
        if self.mods.contains(Modifiers::SUPER) { parts.push("super"); }
        if self.mods.contains(Modifiers::ALT) { parts.push("alt"); }
        if self.mods.contains(Modifiers::SHIFT) { parts.push("shift"); }
        if self.mods.contains(Modifiers::CONTROL) { parts.push("ctrl"); }
        let key = code_to_str(self.key);
        if parts.is_empty() {
            key.to_string()
        } else {
            format!("{}+{}", parts.join("+"), key)
        }
    }
}

pub fn default_quick_capture() -> ShortcutSpec {
    ShortcutSpec { mods: Modifiers::SUPER | Modifiers::ALT, key: Code::KeyN }
}

pub fn default_command_bar() -> ShortcutSpec {
    ShortcutSpec { mods: Modifiers::SUPER, key: Code::KeyK }
}

pub fn parse(s: &str) -> Option<ShortcutSpec> {
    let parts: Vec<&str> = s
        .split('+')
        .map(|p| p.trim())
        .filter(|p| !p.is_empty())
        .collect();
    if parts.is_empty() {
        return None;
    }
    let mut mods = Modifiers::empty();
    let mut key: Option<Code> = None;
    for p in parts {
        match p.to_lowercase().as_str() {
            "super" | "cmd" | "command" | "meta" => mods |= Modifiers::SUPER,
            "alt" | "option" | "opt" => mods |= Modifiers::ALT,
            "shift" => mods |= Modifiers::SHIFT,
            "ctrl" | "control" => mods |= Modifiers::CONTROL,
            other => {
                if key.is_some() {
                    return None;
                }
                key = Some(parse_code(other)?);
            }
        }
    }
    let key = key?;
    if mods.is_empty() {
        // Reject bare-key shortcuts - they would steal regular typing.
        return None;
    }
    Some(ShortcutSpec { mods, key })
}

fn parse_code(s: &str) -> Option<Code> {
    use Code::*;
    let s = s.to_lowercase();
    Some(match s.as_str() {
        "a" | "keya" => KeyA, "b" | "keyb" => KeyB, "c" | "keyc" => KeyC,
        "d" | "keyd" => KeyD, "e" | "keye" => KeyE, "f" | "keyf" => KeyF,
        "g" | "keyg" => KeyG, "h" | "keyh" => KeyH, "i" | "keyi" => KeyI,
        "j" | "keyj" => KeyJ, "k" | "keyk" => KeyK, "l" | "keyl" => KeyL,
        "m" | "keym" => KeyM, "n" | "keyn" => KeyN, "o" | "keyo" => KeyO,
        "p" | "keyp" => KeyP, "q" | "keyq" => KeyQ, "r" | "keyr" => KeyR,
        "s" | "keys" => KeyS, "t" | "keyt" => KeyT, "u" | "keyu" => KeyU,
        "v" | "keyv" => KeyV, "w" | "keyw" => KeyW, "x" | "keyx" => KeyX,
        "y" | "keyy" => KeyY, "z" | "keyz" => KeyZ,
        "0" | "digit0" => Digit0, "1" | "digit1" => Digit1, "2" | "digit2" => Digit2,
        "3" | "digit3" => Digit3, "4" | "digit4" => Digit4, "5" | "digit5" => Digit5,
        "6" | "digit6" => Digit6, "7" | "digit7" => Digit7, "8" | "digit8" => Digit8,
        "9" | "digit9" => Digit9,
        "space" => Space,
        "enter" | "return" => Enter,
        "tab" => Tab,
        "backspace" => Backspace,
        "delete" | "del" => Delete,
        "escape" | "esc" => Escape,
        "minus" => Minus,
        "equal" => Equal,
        "comma" => Comma,
        "period" | "dot" => Period,
        "slash" => Slash,
        "backslash" => Backslash,
        "semicolon" => Semicolon,
        "quote" => Quote,
        "backquote" | "grave" => Backquote,
        "bracketleft" => BracketLeft,
        "bracketright" => BracketRight,
        "f1" => F1, "f2" => F2, "f3" => F3, "f4" => F4, "f5" => F5, "f6" => F6,
        "f7" => F7, "f8" => F8, "f9" => F9, "f10" => F10, "f11" => F11, "f12" => F12,
        _ => return None,
    })
}

fn code_to_str(c: Code) -> &'static str {
    use Code::*;
    match c {
        KeyA => "KeyA", KeyB => "KeyB", KeyC => "KeyC", KeyD => "KeyD",
        KeyE => "KeyE", KeyF => "KeyF", KeyG => "KeyG", KeyH => "KeyH",
        KeyI => "KeyI", KeyJ => "KeyJ", KeyK => "KeyK", KeyL => "KeyL",
        KeyM => "KeyM", KeyN => "KeyN", KeyO => "KeyO", KeyP => "KeyP",
        KeyQ => "KeyQ", KeyR => "KeyR", KeyS => "KeyS", KeyT => "KeyT",
        KeyU => "KeyU", KeyV => "KeyV", KeyW => "KeyW", KeyX => "KeyX",
        KeyY => "KeyY", KeyZ => "KeyZ",
        Digit0 => "Digit0", Digit1 => "Digit1", Digit2 => "Digit2",
        Digit3 => "Digit3", Digit4 => "Digit4", Digit5 => "Digit5",
        Digit6 => "Digit6", Digit7 => "Digit7", Digit8 => "Digit8",
        Digit9 => "Digit9",
        Space => "Space",
        Enter => "Enter",
        Tab => "Tab",
        Backspace => "Backspace",
        Delete => "Delete",
        Escape => "Escape",
        Minus => "Minus",
        Equal => "Equal",
        Comma => "Comma",
        Period => "Period",
        Slash => "Slash",
        Backslash => "Backslash",
        Semicolon => "Semicolon",
        Quote => "Quote",
        Backquote => "Backquote",
        BracketLeft => "BracketLeft",
        BracketRight => "BracketRight",
        F1 => "F1", F2 => "F2", F3 => "F3", F4 => "F4",
        F5 => "F5", F6 => "F6", F7 => "F7", F8 => "F8",
        F9 => "F9", F10 => "F10", F11 => "F11", F12 => "F12",
        _ => "Unknown",
    }
}

pub struct ShortcutsState {
    pub quick_capture: Mutex<ShortcutSpec>,
    pub command_bar: Mutex<ShortcutSpec>,
}

impl ShortcutsState {
    pub fn new(quick_capture: ShortcutSpec, command_bar: ShortcutSpec) -> Self {
        Self {
            quick_capture: Mutex::new(quick_capture),
            command_bar: Mutex::new(command_bar),
        }
    }
}
