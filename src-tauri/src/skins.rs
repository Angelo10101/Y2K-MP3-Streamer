//! Locating and reading `.wmz` and `.wsz` skin archives.

use std::path::PathBuf;

use serde::Serialize;

/// Skin search order: `$RETRO_SKINS_DIR`, `./skins`, `../skins` (cargo-run from
/// `src-tauri`), next to the executable, then `~/.local/share/y2k-mp3-streamer/skins` (Linux) or
/// `%APPDATA%\y2k-mp3-streamer\skins` (Windows). The `retro-mp3-yt-music` folders the app used
/// before it was renamed are still searched, after the new ones.
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
    for app in ["y2k-mp3-streamer", "retro-mp3-yt-music"] {
        if let Some(home) = std::env::var_os("HOME") {
            candidates.push(PathBuf::from(home).join(".local/share").join(app).join("skins"));
        }
        if let Some(appdata) = std::env::var_os("APPDATA") {
            candidates.push(PathBuf::from(appdata).join(app).join("skins"));
        }
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
        .filter(|n| is_skin(n))
        .collect();
    skins.sort_by_key(|s| s.to_lowercase());
    let dir = std::fs::canonicalize(&dir).unwrap_or(dir);
    SkinList { dir: dir.display().to_string(), skins }
}

/// Windows Media Player (`.wmz`) and Winamp (`.wsz`) skins.
fn is_skin(name: &str) -> bool {
    let n = name.to_lowercase();
    n.ends_with(".wmz") || n.ends_with(".wsz")
}

/// Raw bytes of a skin archive. Only plain `*.wmz` / `*.wsz` file names are accepted.
#[tauri::command]
pub fn read_skin(name: String) -> Result<tauri::ipc::Response, String> {
    if name.contains(['/', '\\']) || name.starts_with('.') || !is_skin(&name) {
        return Err("invalid skin name".into());
    }
    std::fs::read(skins_dir().join(&name))
        .map(tauri::ipc::Response::new)
        .map_err(|e| format!("cannot read {name}: {e}"))
}
