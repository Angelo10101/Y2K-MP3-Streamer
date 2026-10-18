//! Managing the Pear Desktop (th-ch YouTube Music) app that does the actual playback:
//! one-time config, launching it, hiding/showing its window, and reading its queue.

use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};

const WINDOW_CLASS: &str = "com.github.th-ch.youtube-music";

fn command() -> String {
    std::env::var("RETRO_PEAR_CMD").unwrap_or_else(|_| "youtube-music".into())
}

fn api() -> String {
    std::env::var("RETRO_PEAR_API").unwrap_or_else(|_| "http://127.0.0.1:26538".into())
}

fn config_path() -> PathBuf {
    let base = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")))
        .unwrap_or_default();
    base.join("YouTube Music").join("config.json")
}

/// True if a Pear/YouTube Music process exists.
pub fn is_running() -> bool {
    std::fs::read_dir("/proc")
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().bytes().all(|b| b.is_ascii_digit()))
        .any(|e| {
            std::fs::read_to_string(e.path().join("comm"))
                .map(|c| c.trim() == "youtube-music")
                .unwrap_or(false)
        })
}

/// Settings this app needs: MPRIS (shortcuts plugin), the local API server, hide-to-tray on
/// close (how we hide the window without quitting playback), and no auto-resume on start
/// (which would otherwise yank us into player mode at launch).
fn needs_patch(c: &Value) -> bool {
    let p = &c["plugins"];
    !(p["shortcuts"]["enabled"] == true
        && p["api-server"]["enabled"] == true
        && p["api-server"]["hostname"] == "127.0.0.1"
        && p["api-server"]["authStrategy"] == "NONE"
        && c["options"]["tray"] == true
        && c["options"]["resumeOnStart"] == false)
}

fn patch(c: &mut Value) {
    c["plugins"]["shortcuts"] = json!({
        "enabled": true, "overrideMediaKeys": false,
        "global": {"previous": "", "playPause": "", "next": ""},
        "local": {"previous": "", "playPause": "", "next": ""}
    });
    c["plugins"]["api-server"] = json!({
        "enabled": true, "hostname": "127.0.0.1", "port": 26538, "authStrategy": "NONE",
        "secret": "retro-mp3", "authorizedClients": [], "useHttps": false, "certPath": "", "keyPath": ""
    });
    c["options"]["tray"] = json!(true);
    c["options"]["resumeOnStart"] = json!(false);
}

#[derive(Serialize)]
pub struct PearStatus {
    pub running: bool,
    /// Human-readable note for the home screen (None = all good).
    pub message: Option<String>,
}

fn spawn() -> Result<(), String> {
    use std::os::unix::process::CommandExt;
    let mut child = Command::new(command())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .process_group(0) // survives us quitting
        .spawn()
        .map_err(|e| format!("cannot start `{}`: {e} (is pear-desktop-bin installed?)", command()))?;
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

fn stop_pear() {
    let _ = Command::new("pkill").args(["-x", "youtube-music"]).status();
    for _ in 0..50 {
        if !is_running() {
            return;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

/// Makes sure Pear is configured for us and running. Blocking.
pub fn start() -> PearStatus {
    let cfg = config_path();
    let running = is_running();
    let read = || std::fs::read_to_string(&cfg).ok().and_then(|s| serde_json::from_str::<Value>(&s).ok());

    let mut conf = read();
    if conf.is_none() && !running {
        // First run: let Pear create its default config, then stop it so we can edit it.
        if let Err(e) = spawn() {
            return PearStatus { running: false, message: Some(e) };
        }
        for _ in 0..100 {
            std::thread::sleep(Duration::from_millis(200));
            conf = read();
            if conf.is_some() {
                break;
            }
        }
        std::thread::sleep(Duration::from_secs(2));
        stop_pear();
    }
    if let Some(mut c) = conf {
        if needs_patch(&c) {
            if is_running() {
                return PearStatus {
                    running: true,
                    message: Some("YouTube Music needs a one-time restart so it can be configured for this app. Close it fully (tray icon > Quit) and restart this app.".into()),
                };
            }
            let _ = std::fs::copy(&cfg, cfg.with_file_name("config.json.bak-retro-mp3"));
            patch(&mut c);
            if let Err(e) = std::fs::write(&cfg, serde_json::to_string_pretty(&c).unwrap_or_default()) {
                return PearStatus { running: false, message: Some(format!("cannot update YouTube Music config: {e}")) };
            }
        }
    }
    if !is_running() {
        if let Err(e) = spawn() {
            return PearStatus { running: false, message: Some(e) };
        }
    }
    PearStatus { running: true, message: None }
}

/// Hides Pear's window by asking the window manager to close it; with the tray option on,
/// Pear hides instead of quitting, so playback continues. X11 only.
pub fn hide_window() -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        use x11rb::connection::Connection;
        use x11rb::protocol::xproto::*;
        use x11rb::rust_connection::RustConnection;
        let e = |e: &dyn std::fmt::Display| e.to_string();
        let (conn, screen) = RustConnection::connect(None).map_err(|x| format!("no X11 display: {x}"))?;
        let root = conn.setup().roots[screen].root;
        let atom = |n: &str| -> Result<u32, String> {
            Ok(conn.intern_atom(false, n.as_bytes()).map_err(|x| e(&x))?.reply().map_err(|x| e(&x))?.atom)
        };
        let (list, close) = (atom("_NET_CLIENT_LIST")?, atom("_NET_CLOSE_WINDOW")?);
        let reply = conn
            .get_property(false, root, list, AtomEnum::WINDOW, 0, 4096)
            .map_err(|x| e(&x))?
            .reply()
            .map_err(|x| e(&x))?;
        let wins: Vec<u32> = reply.value32().map(|i| i.collect()).unwrap_or_default();
        for w in wins {
            let cls = conn
                .get_property(false, w, AtomEnum::WM_CLASS, AtomEnum::STRING, 0, 256)
                .map_err(|x| e(&x))?
                .reply()
                .map_err(|x| e(&x))?;
            if String::from_utf8_lossy(&cls.value).contains(WINDOW_CLASS) {
                let ev = ClientMessageEvent::new(32, w, close, [0u32, 1, 0, 0, 0]);
                conn.send_event(false, root, EventMask::SUBSTRUCTURE_REDIRECT | EventMask::SUBSTRUCTURE_NOTIFY, ev)
                    .map_err(|x| e(&x))?;
            }
        }
        conn.flush().map_err(|x| e(&x))?;
        return Ok(());
    }
    #[allow(unreachable_code)]
    Err("hiding the YouTube Music window is only supported on X11".into())
}

#[derive(Serialize)]
pub struct QueueItem {
    pub index: usize,
    pub video_id: String,
    pub title: String,
    pub artist: String,
    pub duration: String,
    pub selected: bool,
    pub thumb: Option<String>,
}

fn text(v: &Value) -> String {
    v["runs"].as_array().map(|r| r.iter().filter_map(|x| x["text"].as_str()).collect()).unwrap_or_default()
}

fn read_body(r: Result<ureq::http::Response<ureq::Body>, ureq::Error>) -> Result<String, String> {
    let mut r = r.map_err(|e| e.to_string())?;
    r.body_mut().read_to_string().map_err(|e| e.to_string())
}

pub fn queue() -> Result<Vec<QueueItem>, String> {
    let body = read_body(ureq::get(&format!("{}/api/v1/queue", api())).call())?;
    if body.trim().is_empty() {
        return Ok(vec![]);
    }
    let v: Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    let mut out = vec![];
    for it in v["items"].as_array().into_iter().flatten() {
        // some entries wrap a primary renderer (song + music-video alternatives)
        let r = if it["playlistPanelVideoRenderer"].is_object() {
            &it["playlistPanelVideoRenderer"]
        } else {
            &it["playlistPanelVideoWrapperRenderer"]["primaryRenderer"]["playlistPanelVideoRenderer"]
        };
        if !r.is_object() {
            continue;
        }
        let artist = r["longBylineText"]["runs"][0]["text"].as_str().map(String::from).unwrap_or_else(|| text(&r["shortBylineText"]));
        out.push(QueueItem {
            index: out.len(),
            video_id: r["videoId"].as_str().unwrap_or_default().into(),
            title: text(&r["title"]),
            artist,
            duration: text(&r["lengthText"]),
            selected: r["selected"].as_bool().unwrap_or(false),
            thumb: r["thumbnail"]["thumbnails"].as_array().and_then(|t| t.first()).and_then(|t| t["url"].as_str()).map(String::from),
        });
    }
    Ok(out)
}

pub fn select(index: usize) -> Result<(), String> {
    read_body(ureq::patch(&format!("{}/api/v1/queue", api())).send_json(json!({ "index": index }))).map(drop)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn patch_satisfies_needs_patch_and_keeps_other_settings() {
        let mut c = json!({"options": {"tray": false, "resumeOnStart": true, "keep": 1}, "plugins": {"discord": {"listenAlong": true}}});
        assert!(needs_patch(&c));
        patch(&mut c);
        assert!(!needs_patch(&c));
        assert_eq!(c["options"]["keep"], 1);
        assert_eq!(c["plugins"]["discord"]["listenAlong"], true);
    }
}
