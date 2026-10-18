//! MPRIS (D-Bus) client for the YouTube Music desktop app.

use std::collections::HashMap;
use std::time::Duration;

use serde::Serialize;
use zbus::zvariant::{ObjectPath, OwnedValue, Value};
use zbus::{fdo::DBusProxy, Connection, Proxy};

const PREFIX: &str = "org.mpris.MediaPlayer2.";
const PATH: &str = "/org/mpris/MediaPlayer2";
const PLAYER_IFACE: &str = "org.mpris.MediaPlayer2.Player";

#[derive(Serialize, Clone, Default, PartialEq)]
pub struct PlayerState {
    pub running: bool,
    pub bus_name: Option<String>,
    /// "Playing" | "Paused" | "Stopped"
    pub status: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub art_url: Option<String>,
    pub track_id: String,
    pub length_s: f64,
    pub position_s: f64,
    /// 0.0 ..= 1.0
    pub volume: f64,
    pub shuffle: bool,
    /// "None" | "Track" | "Playlist"
    pub loop_status: String,
    pub error: Option<String>,
}

#[derive(Clone)]
pub struct Mpris {
    conn: Connection,
}

impl Mpris {
    pub async fn connect() -> zbus::Result<Self> {
        Ok(Self { conn: Connection::session().await? })
    }

    /// Finds the YouTube Music player on the bus. `RETRO_MPRIS_PLAYER` overrides the
    /// substring that is matched (case-insensitive) against the bus name.
    async fn find_player(&self) -> zbus::Result<Option<String>> {
        // The app was renamed from "YouTube Music" to "Pear Desktop"; accept either.
        let wanted: Vec<String> = match std::env::var("RETRO_MPRIS_PLAYER") {
            Ok(w) => vec![w.to_lowercase()],
            Err(_) => vec!["youtube".into(), "pear".into()],
        };
        let names: Vec<String> = DBusProxy::new(&self.conn)
            .await?
            .list_names()
            .await?
            .into_iter()
            .map(|n| n.to_string())
            .filter(|n| n.starts_with(PREFIX))
            .collect();
        let preferred = names.iter().find(|n| wanted.iter().any(|w| n.to_lowercase().contains(w.as_str())));
        // Playing other players (e.g. a browser tab) is opt-in: RETRO_MPRIS_ANY=1
        if preferred.is_some() || std::env::var("RETRO_MPRIS_PLAYER").is_ok() || std::env::var("RETRO_MPRIS_ANY").is_err() {
            return Ok(preferred.cloned());
        }
        // Fallback: any other player (e.g. YouTube Music open in a browser), preferring one
        // that is currently playing. playerctld is only a proxy and is skipped.
        let mut fallback = None;
        for n in names.iter().filter(|n| !n.contains("playerctld")) {
            let status: String = match self.player_proxy(n).await {
                Ok(p) => p.get_property("PlaybackStatus").await.unwrap_or_default(),
                Err(_) => continue,
            };
            if status == "Playing" {
                return Ok(Some(n.clone()));
            }
            fallback.get_or_insert_with(|| n.clone());
        }
        Ok(fallback)
    }

    async fn player_proxy(&self, name: &str) -> zbus::Result<Proxy<'static>> {
        Proxy::new(&self.conn, name.to_owned(), PATH, PLAYER_IFACE).await
    }

    pub async fn snapshot(&self) -> PlayerState {
        let name = match self.find_player().await {
            Ok(Some(n)) => n,
            Ok(None) => return PlayerState { status: "Stopped".into(), volume: 1.0, ..Default::default() },
            Err(e) => {
                return PlayerState {
                    status: "Stopped".into(),
                    error: Some(format!("D-Bus error: {e}")),
                    ..Default::default()
                }
            }
        };
        match self.read_state(&name).await {
            Ok(s) => s,
            Err(e) => PlayerState {
                running: true,
                bus_name: Some(name),
                status: "Stopped".into(),
                error: Some(e.to_string()),
                ..Default::default()
            },
        }
    }

    async fn read_state(&self, name: &str) -> zbus::Result<PlayerState> {
        let p = self.player_proxy(name).await?;
        let mut s = PlayerState {
            running: true,
            bus_name: Some(name.to_owned()),
            status: p.get_property("PlaybackStatus").await.unwrap_or_else(|_| "Stopped".into()),
            volume: p.get_property("Volume").await.unwrap_or(1.0),
            shuffle: p.get_property("Shuffle").await.unwrap_or(false),
            loop_status: p.get_property("LoopStatus").await.unwrap_or_else(|_| "None".into()),
            ..Default::default()
        };
        if let Ok(us) = p.get_property::<i64>("Position").await {
            s.position_s = us as f64 / 1e6;
        }
        if let Ok(md) = p.get_property::<HashMap<String, OwnedValue>>("Metadata").await {
            s.title = md.get("xesam:title").and_then(as_string).unwrap_or_default();
            s.album = md.get("xesam:album").and_then(as_string).unwrap_or_default();
            s.artist = md.get("xesam:artist").map(as_joined).unwrap_or_default();
            s.art_url = md.get("mpris:artUrl").and_then(as_string);
            s.track_id = md.get("mpris:trackid").and_then(as_string).unwrap_or_default();
            s.length_s = md.get("mpris:length").and_then(as_i64).unwrap_or(0) as f64 / 1e6;
        }
        Ok(s)
    }

    /// Executes a command coming from the frontend.
    pub async fn command(&self, cmd: &str, num: Option<f64>, text: Option<String>) -> Result<(), String> {
        let name = self
            .find_player()
            .await
            .map_err(|e| e.to_string())?
            .ok_or("YouTube Music is not running")?;
        let e = |e: zbus::Error| e.to_string();
        if cmd == "raise" {
            // org.mpris.MediaPlayer2.Raise brings the player's own window to the front
            let root = Proxy::new(&self.conn, name.clone(), PATH, "org.mpris.MediaPlayer2").await.map_err(e)?;
            return root.call_method("Raise", &()).await.map(drop).map_err(e);
        }
        let p = self.player_proxy(&name).await.map_err(|e| e.to_string())?;
        match cmd {
            "play" => p.call_method("Play", &()).await.map(drop).map_err(e),
            "pause" => p.call_method("Pause", &()).await.map(drop).map_err(e),
            "play_pause" => p.call_method("PlayPause", &()).await.map(drop).map_err(e),
            "stop" => p.call_method("Stop", &()).await.map(drop).map_err(e),
            "next" => p.call_method("Next", &()).await.map(drop).map_err(e),
            "previous" => p.call_method("Previous", &()).await.map(drop).map_err(e),
            "seek_by" => {
                let us = (num.unwrap_or(0.0) * 1e6) as i64;
                p.call_method("Seek", &(us,)).await.map(drop).map_err(e)
            }
            "seek_to" => {
                let st = self.read_state(&name).await.map_err(|e| e.to_string())?;
                let id = ObjectPath::try_from(st.track_id.as_str()).map_err(|e| e.to_string())?;
                let us = (num.unwrap_or(0.0) * 1e6) as i64;
                match p.call_method("SetPosition", &(id, us)).await {
                    Ok(_) => Ok(()),
                    // Some players reject SetPosition; fall back to a relative Seek.
                    Err(_) => {
                        let delta = us - (st.position_s * 1e6) as i64;
                        p.call_method("Seek", &(delta,)).await.map(drop).map_err(e)
                    }
                }
            }
            "volume" => p.set_property("Volume", num.unwrap_or(1.0).clamp(0.0, 1.0)).await.map_err(|e| e.to_string()),
            "shuffle" => p.set_property("Shuffle", num.unwrap_or(0.0) != 0.0).await.map_err(|e| e.to_string()),
            "loop" => p
                .set_property("LoopStatus", text.unwrap_or_else(|| "None".into()))
                .await
                .map_err(|e| e.to_string()),
            other => Err(format!("unknown command: {other}")),
        }
    }
}

fn as_string(v: &OwnedValue) -> Option<String> {
    match &**v {
        Value::Str(s) => Some(s.to_string()),
        Value::ObjectPath(p) => Some(p.to_string()),
        _ => None,
    }
}

fn as_joined(v: &OwnedValue) -> String {
    match &**v {
        Value::Array(a) => a
            .iter()
            .filter_map(|i| if let Value::Str(s) = i { Some(s.to_string()) } else { None })
            .collect::<Vec<_>>()
            .join(", "),
        Value::Str(s) => s.to_string(),
        _ => String::new(),
    }
}

fn as_i64(v: &OwnedValue) -> Option<i64> {
    match &**v {
        Value::I64(n) => Some(*n),
        Value::U64(n) => Some(*n as i64),
        Value::I32(n) => Some(*n as i64),
        Value::U32(n) => Some(*n as i64),
        Value::F64(n) => Some(*n as i64),
        _ => None,
    }
}

pub const POLL: Duration = Duration::from_millis(250);
