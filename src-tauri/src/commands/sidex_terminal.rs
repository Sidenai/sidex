use serde::Serialize;

// ── Response structs ────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct TerminalProfileInfo {
    pub name: String,
    pub shell_path: String,
    pub args: Vec<String>,
    pub icon: String,
    pub color: Option<String>,
}

impl From<sidex_terminal::TerminalProfile> for TerminalProfileInfo {
    fn from(p: sidex_terminal::TerminalProfile) -> Self {
        Self {
            name: p.name,
            shell_path: p.shell_path,
            args: p.args,
            icon: p.icon,
            color: p.color,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct TerminalMatchInfo {
    pub start_row: i32,
    pub start_col: u16,
    pub end_row: i32,
    pub end_col: u16,
}

impl From<sidex_terminal::TerminalMatch> for TerminalMatchInfo {
    fn from(m: sidex_terminal::TerminalMatch) -> Self {
        Self {
            start_row: m.start_row,
            start_col: m.start_col,
            end_row: m.end_row,
            end_col: m.end_col,
        }
    }
}

// ── Commands ────────────────────────────────────────────────────────────

/// Detect the user's default shell via `sidex-terminal`.
#[tauri::command]
#[allow(clippy::unnecessary_wraps)]
pub fn terminal_detect_shell() -> Result<String, String> {
    Ok(sidex_terminal::detect_default_shell())
}

/// List available terminal profiles (shell + icon + args).
#[tauri::command]
#[allow(clippy::unnecessary_wraps)]
pub fn terminal_get_profiles() -> Result<Vec<TerminalProfileInfo>, String> {
    Ok(sidex_terminal::detect_profiles()
        .into_iter()
        .map(TerminalProfileInfo::from)
        .collect())
}

/// Search the ring-buffer output of a managed terminal.
///
/// Drains pending output, builds a temporary `TerminalGrid` from the
/// buffered text, then delegates to `sidex_terminal::find_in_terminal`.
#[tauri::command]
#[allow(clippy::needless_pass_by_value)]
pub fn terminal_find_in_buffer(
    state: tauri::State<'_, std::sync::Arc<super::process::ProcessStore>>,
    terminal_id: u32,
    query: String,
    case_sensitive: Option<bool>,
    regex: Option<bool>,
    whole_word: Option<bool>,
) -> Result<Vec<TerminalMatchInfo>, String> {
    let handle = super::process::TermHandle(terminal_id);
    let text = state.buffer_text(handle)?;

    let opts = sidex_terminal::FindOptions {
        case_sensitive: case_sensitive.unwrap_or(false),
        regex: regex.unwrap_or(false),
        whole_word: whole_word.unwrap_or(false),
    };

    let lines: Vec<&str> = text.lines().collect();
    #[allow(clippy::cast_possible_truncation)]
    let cols = lines.iter().map(|l| l.len()).max().unwrap_or(80).max(80) as u16;
    #[allow(clippy::cast_possible_truncation)]
    let rows = (lines.len().max(4)) as u16;
    let mut grid = sidex_terminal::TerminalGrid::new(rows, cols);
    let template = sidex_terminal::Cell::default();

    for (i, line) in lines.iter().enumerate() {
        #[allow(clippy::cast_possible_truncation)]
        grid.set_cursor(i as u16, 0);
        for ch in line.chars() {
            grid.write_char(ch, &template);
        }
    }

    let matches = sidex_terminal::find_in_terminal(&grid, &query, &opts);
    Ok(matches.into_iter().map(TerminalMatchInfo::from).collect())
}

#[derive(Debug, Clone, Serialize)]
pub struct TerminalLinkInfo {
    pub start_row: u16,
    pub start_col: u16,
    pub end_row: u16,
    pub end_col: u16,
    pub url: String,
    pub kind: String,
}

impl From<sidex_terminal::TerminalLink> for TerminalLinkInfo {
    fn from(l: sidex_terminal::TerminalLink) -> Self {
        let kind = match l.kind {
            sidex_terminal::LinkKind::Url => "Url".to_string(),
            sidex_terminal::LinkKind::FilePath => "FilePath".to_string(),
            sidex_terminal::LinkKind::OscHyperlink => "OscHyperlink".to_string(),
            sidex_terminal::LinkKind::Command => "Command".to_string(),
        };
        Self {
            start_row: l.start.0,
            start_col: l.start.1,
            end_row: l.end.0,
            end_col: l.end.1,
            url: l.url,
            kind,
        }
    }
}

#[tauri::command]
pub fn terminal_detect_links(line_text: String) -> Result<Vec<TerminalLinkInfo>, String> {
    let cells: Vec<sidex_terminal::Cell> = line_text
        .chars()
        .map(|c| {
            let mut cell = sidex_terminal::Cell::default();
            cell.c = c;
            cell
        })
        .collect();

    let links = sidex_terminal::detect_links(&cells);
    Ok(links.into_iter().map(TerminalLinkInfo::from).collect())
}
