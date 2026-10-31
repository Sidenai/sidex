//! What an xterm-compatible terminal sends to the shell for a key, a mouse
//! event or a paste. Pure functions over the terminal mode, so they're tested
//! without a window.
//!
//! Printable text is deliberately not handled here: it reaches the terminal
//! through the platform input handler, so dead keys, ⌥-composed characters
//! and IME composition work the way they do in VSCode.

use alacritty_terminal::term::TermMode;
use gpui_kit::{Keystroke, Modifiers};

/// Bytes for a keystroke, or `None` when the key isn't the terminal's:
/// printable text (left to the input handler) and workbench shortcuts.
pub fn key_to_bytes(ks: &Keystroke, mode: TermMode) -> Option<Vec<u8>> {
    let m = ks.modifiers;
    let key = ks.key.as_str();

    // ⌘ belongs to the workbench, except the readline motions VSCode binds
    // on macOS (`workbench.action.terminal.sendSequence`).
    if m.platform {
        if m.control || m.alt {
            return None;
        }
        return match key {
            "left" => Some(vec![0x01]),
            "right" => Some(vec![0x05]),
            "backspace" => Some(vec![0x15]),
            _ => None,
        };
    }

    // xterm modifier parameter: 1 + shift + 2·alt + 4·ctrl.
    let param = 1 + u8::from(m.shift) + 2 * u8::from(m.alt) + 4 * u8::from(m.control);
    let tilde = |code: u8| -> Vec<u8> {
        if param > 1 {
            format!("\x1b[{code};{param}~").into_bytes()
        } else {
            format!("\x1b[{code}~").into_bytes()
        }
    };

    let bytes = match key {
        "up" | "down" | "right" | "left" | "home" | "end" => {
            let f = match key {
                "up" => 'A',
                "down" => 'B',
                "right" => 'C',
                "left" => 'D',
                "home" => 'H',
                _ => 'F',
            };
            // ⌥←/⌥→ move by word, as xterm.js does when ⌥ isn't Meta.
            if m.alt && !m.shift && !m.control && matches!(key, "left" | "right") {
                return Some(if key == "left" { b"\x1bb" } else { b"\x1bf" }.to_vec());
            }
            if param > 1 {
                format!("\x1b[1;{param}{f}").into_bytes()
            } else if mode.contains(TermMode::APP_CURSOR) {
                format!("\x1bO{f}").into_bytes()
            } else {
                format!("\x1b[{f}").into_bytes()
            }
        }
        "insert" => tilde(2),
        "delete" => tilde(3),
        "pageup" => tilde(5),
        "pagedown" => tilde(6),
        "f1" | "f2" | "f3" | "f4" => {
            let f = match key {
                "f1" => 'P',
                "f2" => 'Q',
                "f3" => 'R',
                _ => 'S',
            };
            if param > 1 {
                format!("\x1b[1;{param}{f}").into_bytes()
            } else {
                format!("\x1bO{f}").into_bytes()
            }
        }
        "f5" => tilde(15),
        "f6" => tilde(17),
        "f7" => tilde(18),
        "f8" => tilde(19),
        "f9" => tilde(20),
        "f10" => tilde(21),
        "f11" => tilde(23),
        "f12" => tilde(24),
        "enter" if m.alt => b"\x1b\r".to_vec(),
        "enter" => b"\r".to_vec(),
        // ⌥⌫ deletes a word, as VSCode binds it on macOS.
        "backspace" if m.alt => vec![0x17],
        "backspace" if m.control => vec![0x08],
        "backspace" => vec![0x7f],
        // Ctrl-Tab is the workbench's tab switcher.
        "tab" if m.control => return None,
        "tab" if m.shift => b"\x1b[Z".to_vec(),
        "tab" => b"\t".to_vec(),
        "escape" => vec![0x1b],
        "space" if m.control => vec![0x00],
        _ if m.control => {
            let mut ch = key.chars();
            let (Some(c), None) = (ch.next(), ch.next()) else {
                return None;
            };
            let byte = control_byte(c)?;
            if m.alt {
                vec![0x1b, byte]
            } else {
                vec![byte]
            }
        }
        _ => return None,
    };
    Some(bytes)
}

/// The C0 control byte Ctrl+`c` produces.
fn control_byte(c: char) -> Option<u8> {
    Some(match c.to_ascii_lowercase() {
        c @ 'a'..='z' => c as u8 - b'a' + 1,
        '@' | '2' | ' ' => 0x00,
        '[' | '3' => 0x1b,
        '\\' | '4' => 0x1c,
        ']' | '5' => 0x1d,
        '^' | '6' => 0x1e,
        '_' | '-' | '7' | '/' => 0x1f,
        '8' | '?' => 0x7f,
        _ => return None,
    })
}

/// Mouse buttons as the xterm protocol numbers them.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReportButton {
    Left = 0,
    Middle = 1,
    Right = 2,
    WheelUp = 64,
    WheelDown = 65,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReportKind {
    Press,
    Release,
    /// Motion with the button held (or with no button, for `MOUSE_MOTION`).
    Motion,
}

/// Encode a mouse event at a 0-based viewport cell. SGR (1006) when the
/// application asked for it, the legacy X10 encoding otherwise, which can't
/// address cells past column/line 223.
pub fn mouse_report(
    button: ReportButton,
    kind: ReportKind,
    col: usize,
    line: usize,
    mods: Modifiers,
    mode: TermMode,
) -> Option<Vec<u8>> {
    let mut cb = button as u8;
    if kind == ReportKind::Motion {
        cb += 32;
    }
    cb += 4 * u8::from(mods.shift) + 8 * u8::from(mods.alt) + 16 * u8::from(mods.control);

    if mode.contains(TermMode::SGR_MOUSE) {
        let end = if kind == ReportKind::Release {
            'm'
        } else {
            'M'
        };
        return Some(format!("\x1b[<{cb};{};{}{end}", col + 1, line + 1).into_bytes());
    }

    // X10 can't say which button was released.
    if kind == ReportKind::Release && (button as u8) < 64 {
        cb = (cb & !0b11) | 3;
    }
    let encode = |v: usize| u8::try_from(32 + v + 1).ok().filter(|b| *b < 255);
    Some(vec![0x1b, b'[', b'M', 32 + cb, encode(col)?, encode(line)?])
}

/// Text to send for a paste: newlines become carriage returns, and in
/// bracketed-paste mode the payload is wrapped so the shell doesn't run it
/// line by line. An embedded end marker is removed so a paste can't break
/// out of the brackets.
pub fn paste_bytes(text: &str, mode: TermMode) -> Vec<u8> {
    let body = text.replace("\r\n", "\r").replace('\n', "\r");
    if mode.contains(TermMode::BRACKETED_PASTE) {
        let body = body.replace("\x1b[201~", "");
        format!("\x1b[200~{body}\x1b[201~").into_bytes()
    } else {
        body.into_bytes()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(s: &'static str, mode: TermMode) -> Option<Vec<u8>> {
        key_to_bytes(&Keystroke::parse(s).unwrap(), mode)
    }

    #[::core::prelude::v1::test]
    fn arrows_follow_application_cursor_mode() {
        assert_eq!(key("up", TermMode::NONE).unwrap(), b"\x1b[A");
        assert_eq!(key("up", TermMode::APP_CURSOR).unwrap(), b"\x1bOA");
        assert_eq!(key("shift-up", TermMode::APP_CURSOR).unwrap(), b"\x1b[1;2A");
        assert_eq!(key("ctrl-right", TermMode::NONE).unwrap(), b"\x1b[1;5C");
        assert_eq!(key("alt-left", TermMode::NONE).unwrap(), b"\x1bb");
    }

    #[::core::prelude::v1::test]
    fn control_keys() {
        assert_eq!(key("ctrl-c", TermMode::NONE).unwrap(), [0x03]);
        assert_eq!(key("ctrl-shift-c", TermMode::NONE).unwrap(), [0x03]);
        assert_eq!(key("ctrl-alt-d", TermMode::NONE).unwrap(), [0x1b, 0x04]);
        assert_eq!(key("ctrl-[", TermMode::NONE).unwrap(), [0x1b]);
        assert_eq!(key("ctrl-space", TermMode::NONE).unwrap(), [0x00]);
        assert_eq!(key("ctrl-tab", TermMode::NONE), None);
        assert_eq!(key("ctrl-`", TermMode::NONE), None);
    }

    #[::core::prelude::v1::test]
    fn editing_and_function_keys() {
        assert_eq!(key("enter", TermMode::NONE).unwrap(), b"\r");
        assert_eq!(key("backspace", TermMode::NONE).unwrap(), [0x7f]);
        assert_eq!(key("alt-backspace", TermMode::NONE).unwrap(), [0x17]);
        assert_eq!(key("shift-tab", TermMode::NONE).unwrap(), b"\x1b[Z");
        assert_eq!(key("delete", TermMode::NONE).unwrap(), b"\x1b[3~");
        assert_eq!(key("f1", TermMode::NONE).unwrap(), b"\x1bOP");
        assert_eq!(key("f5", TermMode::NONE).unwrap(), b"\x1b[15~");
        assert_eq!(key("shift-f5", TermMode::NONE).unwrap(), b"\x1b[15;2~");
    }

    #[::core::prelude::v1::test]
    fn printable_and_workbench_keys_are_not_ours() {
        assert_eq!(key("a", TermMode::NONE), None);
        assert_eq!(key("shift-a", TermMode::NONE), None);
        assert_eq!(key("cmd-p", TermMode::NONE), None);
        assert_eq!(key("cmd-left", TermMode::NONE).unwrap(), [0x01]);
    }

    #[::core::prelude::v1::test]
    fn mouse_reports() {
        let none = Modifiers::default();
        let sgr = TermMode::SGR_MOUSE;
        assert_eq!(
            mouse_report(ReportButton::Left, ReportKind::Press, 4, 9, none, sgr).unwrap(),
            b"\x1b[<0;5;10M"
        );
        assert_eq!(
            mouse_report(ReportButton::Left, ReportKind::Release, 4, 9, none, sgr).unwrap(),
            b"\x1b[<0;5;10m"
        );
        assert_eq!(
            mouse_report(ReportButton::WheelUp, ReportKind::Press, 0, 0, none, sgr).unwrap(),
            b"\x1b[<64;1;1M"
        );
        assert_eq!(
            mouse_report(
                ReportButton::Left,
                ReportKind::Release,
                0,
                0,
                none,
                TermMode::NONE
            )
            .unwrap(),
            [0x1b, b'[', b'M', 32 + 3, 33, 33]
        );
        assert_eq!(
            mouse_report(
                ReportButton::Left,
                ReportKind::Press,
                300,
                0,
                none,
                TermMode::NONE
            ),
            None
        );
    }

    #[::core::prelude::v1::test]
    fn paste_is_bracketed_and_sanitised() {
        assert_eq!(paste_bytes("a\nb", TermMode::NONE), b"a\rb");
        assert_eq!(
            paste_bytes("x\x1b[201~y", TermMode::BRACKETED_PASTE),
            b"\x1b[200~xy\x1b[201~"
        );
    }
}
