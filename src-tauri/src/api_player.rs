//! Playback control through Pear Desktop's local API server (`127.0.0.1:26538`). Works on every
//! platform; the only backend on Windows, where there is no MPRIS.

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::player::PlayerState;

fn base() -> String {
    std::env::var("RETRO_PEAR_API").unwrap_or_else(|_| "http://127.0.0.1:26538".into())
}

/// Volume, shuffle and repeat rarely change; fetch them less often than the song.
const SLOW_EVERY: Duration = Duration::from_millis(1500);

struct Inner {
    last: PlayerState,
    slow_at: Option<Instant>,
    volume: f64,
    shuffle: bool,
    loop_status: String,
}

#[derive(Clone)]
pub struct PearApi {
    inner: Arc<Mutex<Inner>>,
}

fn get(path: &str) -> Result<Option<Value>, String> {
    let mut r = ureq::get(&format!("{}{}", base(), path)).call().map_err(|e| e.to_string())?;
    let body = r.body_mut().read_to_string().map_err(|e| e.to_string())?;
    if body.trim().is_empty() {
        return Ok(None);
    }
    serde_json::from_str(&body).map(Some).map_err(|e| e.to_string())
}

fn post(path: &str, body: Option<Value>) -> Result<(), String> {
    let req = ureq::post(&format!("{}{}", base(), path));
    let r = match body {
        Some(b) => req.send_json(b),
        None => req.send_empty(),
    };
    r.map(drop).map_err(|e| e.to_string())
}

/// Maps `GET /api/v1/song` to our state (`None` = nothing loaded).
pub fn song_to_state(v: Option<&Value>) -> PlayerState {
    let mut s = PlayerState { running: true, status: "Stopped".into(), loop_status: "None".into(), volume: 1.0, ..Default::default() };
    if let Some(v) = v {
        let text = |k: &str| v[k].as_str().unwrap_or_default().to_string();
        s.title = text("title");
        s.artist = text("artist");
        s.album = text("album");
        s.art_url = v["imageSrc"].as_str().map(String::from);
        s.track_id = text("videoId");
        s.length_s = v["songDuration"].as_f64().unwrap_or(0.0);
        s.position_s = v["elapsedSeconds"].as_f64().unwrap_or(0.0);
        s.status = if v["isPaused"].as_bool().unwrap_or(false) { "Paused" } else { "Playing" }.into();
    }
    s
}

pub fn repeat_to_loop(mode: &str) -> &'static str {
    match mode {
        "ALL" => "Playlist",
        "ONE" => "Track",
        _ => "None",
    }
}

impl PearApi {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(Inner {
                last: PlayerState::default(),
                slow_at: None,
                volume: 1.0,
                shuffle: false,
                loop_status: "None".into(),
            })),
        }
    }

    fn blocking_snapshot(&self) -> PlayerState {
        let song = match get("/api/v1/song") {
            Ok(v) => v,
            Err(_) => {
                // API unreachable: Pear isn't running (or its API plugin is off)
                let s = PlayerState { status: "Stopped".into(), volume: 1.0, ..Default::default() };
                self.inner.lock().unwrap().last = s.clone();
                return s;
            }
        };
        let mut st = song_to_state(song.as_ref());
        let mut inner = self.inner.lock().unwrap();
        if inner.slow_at.map_or(true, |t| t.elapsed() > SLOW_EVERY) {
            inner.slow_at = Some(Instant::now());
            // drop the lock while doing network calls
            drop(inner);
            let vol = get("/api/v1/volume").ok().flatten().and_then(|v| v["state"].as_f64());
            let shuffle = get("/api/v1/shuffle").ok().flatten().and_then(|v| v["state"].as_bool());
            let repeat = get("/api/v1/repeat-mode").ok().flatten().and_then(|v| v["mode"].as_str().map(String::from));
            inner = self.inner.lock().unwrap();
            if let Some(v) = vol { inner.volume = (v / 100.0).clamp(0.0, 1.0); }
            if let Some(v) = shuffle { inner.shuffle = v; }
            if let Some(m) = repeat { inner.loop_status = repeat_to_loop(&m).into(); }
        }
        st.volume = inner.volume;
        st.shuffle = inner.shuffle;
        st.loop_status = inner.loop_status.clone();
        inner.last = st.clone();
        st
    }

    pub async fn snapshot(&self) -> PlayerState {
        let me = self.clone();
        tauri::async_runtime::spawn_blocking(move || me.blocking_snapshot()).await.unwrap_or_default()
    }

    fn blocking_command(&self, cmd: &str, num: Option<f64>, text: Option<String>) -> Result<(), String> {
        let last = self.inner.lock().unwrap().last.clone();
        match cmd {
            "play" => post("/api/v1/play", None),
            "pause" => post("/api/v1/pause", None),
            "play_pause" => post("/api/v1/toggle-play", None),
            "stop" => {
                post("/api/v1/pause", None)?;
                post("/api/v1/seek-to", Some(json!({ "seconds": 0 })))
            }
            "next" => post("/api/v1/next", None),
            "previous" => post("/api/v1/previous", None),
            "seek_to" => post("/api/v1/seek-to", Some(json!({ "seconds": num.unwrap_or(0.0).max(0.0) }))),
            "seek_by" => {
                let to = (last.position_s + num.unwrap_or(0.0)).clamp(0.0, last.length_s.max(0.0));
                post("/api/v1/seek-to", Some(json!({ "seconds": to })))
            }
            "volume" => {
                self.inner.lock().unwrap().volume = num.unwrap_or(1.0).clamp(0.0, 1.0);
                post("/api/v1/volume", Some(json!({ "volume": (num.unwrap_or(1.0).clamp(0.0, 1.0) * 100.0).round() })))
            }
            "shuffle" => {
                let want = num.unwrap_or(0.0) != 0.0;
                if want != last.shuffle {
                    self.inner.lock().unwrap().shuffle = want;
                    post("/api/v1/shuffle", None)?;
                }
                Ok(())
            }
            "loop" => {
                let want = text.unwrap_or_else(|| "None".into());
                // the API only cycles to the next repeat mode (None -> All -> One -> None)
                let mut cur = last.loop_status.clone();
                for _ in 0..3 {
                    if cur == want { break; }
                    post("/api/v1/switch-repeat", Some(json!({ "iteration": 1 })))?;
                    cur = match cur.as_str() { "None" => "Playlist", "Playlist" => "Track", _ => "None" }.into();
                }
                self.inner.lock().unwrap().loop_status = cur;
                Ok(())
            }
            "raise" => Err("raising Pear's window is handled by the app, not the player backend".into()),
            other => Err(format!("unknown command: {other}")),
        }
    }

    pub async fn command(&self, cmd: &str, num: Option<f64>, text: Option<String>) -> Result<(), String> {
        let me = self.clone();
        let cmd = cmd.to_string();
        tauri::async_runtime::spawn_blocking(move || me.blocking_command(&cmd, num, text)).await.map_err(|e| e.to_string())?
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_song_info() {
        let v = json!({"title":"affection","artist":"Jinsang","album":"life.","imageSrc":"https://x/y.jpg",
                       "isPaused":false,"songDuration":117,"elapsedSeconds":12,"videoId":"NAkZ8gUXcIE"});
        let s = song_to_state(Some(&v));
        assert_eq!((s.title.as_str(), s.artist.as_str(), s.track_id.as_str()), ("affection", "Jinsang", "NAkZ8gUXcIE"));
        assert_eq!((s.length_s, s.position_s, s.status.as_str()), (117.0, 12.0, "Playing"));
        let p = song_to_state(Some(&json!({"isPaused":true})));
        assert_eq!(p.status, "Paused");
        assert_eq!(song_to_state(None).status, "Stopped");
    }

    #[test]
    fn maps_repeat_modes() {
        assert_eq!(repeat_to_loop("ALL"), "Playlist");
        assert_eq!(repeat_to_loop("ONE"), "Track");
        assert_eq!(repeat_to_loop("NONE"), "None");
    }

    /// Run with a Pear that is playing something: `cargo test live -- --ignored --nocapture`
    #[test]
    #[ignore = "needs a running Pear with the API server enabled"]
    fn live_snapshot_and_commands() {
        let api = PearApi::new();
        let s = api.blocking_snapshot();
        println!("state: {} / {} [{}] {:.0}/{:.0}s vol {:.2} shuffle {} loop {}", s.title, s.artist, s.status, s.position_s, s.length_s, s.volume, s.shuffle, s.loop_status);
        assert!(s.running, "API not reachable");
        // set the volume to what it already is, then seek to where we are: harmless round trips
        api.blocking_command("volume", Some(s.volume), None).unwrap();
        api.blocking_command("seek_to", Some(s.position_s), None).unwrap();
        // repeat cycling must end up where requested, then be restored
        let before = s.loop_status.clone();
        api.blocking_command("loop", None, Some("Playlist".into())).unwrap();
        std::thread::sleep(Duration::from_millis(1700));
        assert_eq!(api.blocking_snapshot().loop_status, "Playlist");
        api.blocking_command("loop", None, Some(before.clone())).unwrap();
        std::thread::sleep(Duration::from_millis(1700));
        assert_eq!(api.blocking_snapshot().loop_status, before);
    }
}
