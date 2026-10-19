//! The playback backend the frontend talks to. Linux uses MPRIS (D-Bus); every platform can use
//! Pear's local API server instead (the only option on Windows). `RETRO_PLAYER_BACKEND=api`
//! forces the API backend, `=mpris` forces MPRIS.

use std::time::Duration;

use serde::Serialize;

use crate::api_player::PearApi;

pub const POLL: Duration = Duration::from_millis(250);

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
pub enum Player {
    #[cfg(target_os = "linux")]
    Mpris(crate::mpris::Mpris),
    #[cfg(windows)]
    Smtc(crate::smtc::Smtc),
    Api(PearApi),
}

impl Player {
    pub async fn connect() -> Self {
        #[cfg(windows)]
        if crate::spotify::active() {
            return Player::Smtc(crate::smtc::Smtc::new());
        }
        let want = std::env::var("RETRO_PLAYER_BACKEND").unwrap_or_default();
        #[cfg(target_os = "linux")]
        if want != "api" {
            match crate::mpris::Mpris::connect().await {
                Ok(m) => return Player::Mpris(m),
                Err(e) => eprintln!("cannot connect to D-Bus ({e}); using Pear's API instead"),
            }
        }
        let _ = want;
        Player::Api(PearApi::new())
    }

    pub async fn snapshot(&self) -> PlayerState {
        match self {
            #[cfg(target_os = "linux")]
            Player::Mpris(m) => m.snapshot().await,
            #[cfg(windows)]
            Player::Smtc(m) => m.snapshot().await,
            Player::Api(a) => a.snapshot().await,
        }
    }

    pub async fn command(&self, cmd: &str, num: Option<f64>, text: Option<String>) -> Result<(), String> {
        match self {
            #[cfg(target_os = "linux")]
            Player::Mpris(m) => m.command(cmd, num, text).await,
            #[cfg(windows)]
            Player::Smtc(m) => m.command(cmd, num, text).await,
            Player::Api(a) => a.command(cmd, num, text).await,
        }
    }
}
