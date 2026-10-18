//! Locating and reading `.wmz` skin archives.

use std::path::PathBuf;

use serde::Serialize;

/// Skin search order: `$RETRO_SKINS_DIR`, `./skins`, `../skins` (cargo-run from
/// `src-tauri`), next to the executable, then `~/.local/share/retro-mp3-yt-music/skins`.
pub fn skins_dir() -> PathBuf {
    let mut candidates: Vec<PathBuf> = vec![];
    if let Ok(d) = std::env::var("RETRO_SKINS_DIR") {
        candidates.push(d.into());
    }
    candidates.push("skins".into());
    candidates.push("../skins".into());
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("skins"));
        }
    }
    if let Some(home) = std::env::var_os("HOME") {
        candidates.push(PathBuf::from(home).join(".local/share/retro-mp3-yt-music/skins"));
    }
    candidates
        .iter()
        .find(|p| p.is_dir())
        .cloned()
        .unwrap_or_else(|| candidates.into_iter().next().unwrap())
}

#[derive(Serialize)]
pub struct SkinList {
    pub dir: String,
    pub skins: Vec<String>,
}

#[tauri::command]
pub fn list_skins() -> SkinList {
    let dir = skins_dir();
    let mut skins: Vec<String> = std::fs::read_dir(&dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| e.file_name().into_string().ok())
        .filter(|n| n.to_lowercase().ends_with(".wmz"))
        .collect();
    skins.sort_by_key(|s| s.to_lowercase());
    let dir = std::fs::canonicalize(&dir).unwrap_or(dir);
    SkinList { dir: dir.display().to_string(), skins }
}

/// Raw bytes of a skin archive. Only plain `*.wmz` file names are accepted.
#[tauri::command]
pub fn read_skin(name: String) -> Result<tauri::ipc::Response, String> {
    if name.contains(['/', '\\']) || name.starts_with('.') || !name.to_lowercase().ends_with(".wmz") {
        return Err("invalid skin name".into());
    }
    std::fs::read(skins_dir().join(&name))
        .map(tauri::ipc::Response::new)
        .map_err(|e| format!("cannot read {name}: {e}"))
}
