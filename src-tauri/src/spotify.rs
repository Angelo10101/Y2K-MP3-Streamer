//! Spotify as the playback source (`RETRO_SOURCE=spotify`). On Linux, Spotify's desktop client
//! (and spotifyd, ncspot, ...) speak MPRIS and are driven by `mpris.rs`; on Windows they are
//! driven through the system media session (`smtc.rs`). This module launches the client and
//! tells the rest of the app which source is active.

use std::process::{Command, Stdio};

use crate::pear::PearStatus;

/// `RETRO_SOURCE=spotify` selects Spotify; anything else (or unset) is Pear / YouTube Music.
pub fn active() -> bool {
    cfg!(any(target_os = "linux", windows)) && std::env::var("RETRO_SOURCE").is_ok_and(|s| s.eq_ignore_ascii_case("spotify"))
}

/// Name shown in the UI for the active source.
pub fn source_name() -> &'static str {
    if active() { "Spotify" } else { "YouTube Music" }
}

/// Program and arguments that start Spotify. `RETRO_SPOTIFY_CMD` may hold arguments on Linux,
/// e.g. `flatpak run com.spotify.Client`, or the full path of `Spotify.exe` on Windows.
#[cfg(not(windows))]
fn command() -> Vec<String> {
    let c = std::env::var("RETRO_SPOTIFY_CMD").unwrap_or_else(|_| "spotify".into());
    c.split_whitespace().map(String::from).collect()
}

/// The desktop installer puts Spotify in `%APPDATA%\Spotify`; the Microsoft Store version has no
/// fixed path, but the `spotify:` protocol launches either.
#[cfg(windows)]
fn command() -> Vec<String> {
    if let Ok(c) = std::env::var("RETRO_SPOTIFY_CMD") {
        return if std::path::Path::new(&c).is_file() { vec![c] } else { c.split_whitespace().map(String::from).collect() };
    }
    let exe = std::path::PathBuf::from(std::env::var_os("APPDATA").unwrap_or_default()).join("Spotify").join("Spotify.exe");
    if exe.is_file() {
        return vec![exe.to_string_lossy().into_owned()];
    }
    ["cmd", "/C", "start", "", "spotify:"].map(String::from).to_vec()
}

/// True if a Spotify process exists (the native package and the Flatpak both run `spotify`).
#[cfg(target_os = "linux")]
pub fn is_running() -> bool {
    std::fs::read_dir("/proc")
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().bytes().all(|b| b.is_ascii_digit()))
        .any(|e| std::fs::read_to_string(e.path().join("comm")).map(|c| c.trim() == "spotify").unwrap_or(false))
}

#[cfg(windows)]
pub fn is_running() -> bool {
    use std::os::windows::process::CommandExt;
    Command::new("tasklist")
        .args(["/FI", "IMAGENAME eq Spotify.exe", "/NH", "/FO", "CSV"])
        .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).contains("Spotify.exe"))
        .unwrap_or(false)
}

#[cfg(not(any(target_os = "linux", windows)))]
pub fn is_running() -> bool {
    false
}

/// Launches the client, detached so it survives us quitting. Launching it again while it is
/// running just focuses its window, which is how Windows "raises" it.
pub fn raise() -> Result<(), String> {
    let parts = command();
    let (prog, args) = parts.split_first().ok_or_else(|| "RETRO_SPOTIFY_CMD is empty".to_string())?;
    let mut cmd = Command::new(prog);
    cmd.args(args).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    #[cfg(unix)]
    std::os::unix::process::CommandExt::process_group(&mut cmd, 0);
    #[cfg(windows)]
    std::os::windows::process::CommandExt::creation_flags(&mut cmd, 0x0000_0008 | 0x0000_0200); // DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("cannot start `{}`: {e} (is Spotify installed? see the README)", parts.join(" ")))?;
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

/// Starts Spotify if it isn't running. Returns as soon as the process is spawned.
pub fn start() -> PearStatus {
    if !is_running() {
        if let Err(e) = raise() {
            return PearStatus { running: false, message: Some(e) };
        }
    }
    PearStatus { running: true, message: None }
}
