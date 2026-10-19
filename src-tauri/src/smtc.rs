//! Windows media-session (SMTC) client, used for Spotify (`RETRO_SOURCE=spotify`). Spotify
//! publishes its track and accepts transport commands through the same system media controls
//! that drive the volume flyout and the lock screen. SMTC has no volume, so that is a no-op.

use std::time::{SystemTime, UNIX_EPOCH};

use windows::Foundation::TimeSpan;
use windows::Media::Control::{
    GlobalSystemMediaTransportControlsSession as Session, GlobalSystemMediaTransportControlsSessionManager as Manager,
    GlobalSystemMediaTransportControlsSessionPlaybackStatus as Status,
};
use windows::Media::MediaPlaybackAutoRepeatMode as Repeat;
use windows::core::Interface;
use windows::Storage::Streams::{DataReader, IContentTypeProvider, IRandomAccessStream};

use crate::player::PlayerState;

/// 100 ns ticks per second (SMTC's `TimeSpan` unit)
const TICKS: f64 = 1e7;
/// Seconds between 1601-01-01 (SMTC's `DateTime` epoch) and 1970-01-01
const EPOCH_GAP_S: f64 = 11_644_473_600.0;

#[derive(Clone, Default)]
pub struct Smtc {
    /// Last album art, keyed by the track it belongs to, so we don't re-read it on every poll.
    art: std::sync::Arc<std::sync::Mutex<(String, Option<String>)>>,
}

impl Smtc {
    pub fn new() -> Self {
        Self::default()
    }

    /// Runs the blocking WinRT calls off the async workers.
    pub async fn snapshot(&self) -> PlayerState {
        let this = self.clone();
        tauri::async_runtime::spawn_blocking(move || this.read())
            .await
            .unwrap_or_else(|e| PlayerState { status: "Stopped".into(), error: Some(e.to_string()), ..Default::default() })
    }

    pub async fn command(&self, cmd: &str, num: Option<f64>, text: Option<String>) -> Result<(), String> {
        if cmd == "raise" {
            // a second launch of Spotify focuses the running instance
            return crate::spotify::raise();
        }
        let (this, cmd) = (self.clone(), cmd.to_owned());
        tauri::async_runtime::spawn_blocking(move || this.run(&cmd, num, text))
            .await
            .map_err(|e| e.to_string())?
    }

    fn session() -> windows::core::Result<Option<Session>> {
        let sessions = Manager::RequestAsync()?.get()?.GetSessions()?;
        for s in sessions {
            if s.SourceAppUserModelId()?.to_string().to_lowercase().contains("spotify") {
                return Ok(Some(s));
            }
        }
        Ok(None)
    }

    fn read(&self) -> PlayerState {
        let stopped = PlayerState { status: "Stopped".into(), volume: 1.0, ..Default::default() };
        match Self::session() {
            Ok(Some(s)) => self.read_state(&s).unwrap_or_else(|e| PlayerState {
                running: true,
                error: Some(e.to_string()),
                ..stopped
            }),
            Ok(None) => stopped,
            Err(e) => PlayerState { error: Some(format!("media session error: {e}")), ..stopped },
        }
    }

    fn read_state(&self, s: &Session) -> windows::core::Result<PlayerState> {
        let props = s.TryGetMediaPropertiesAsync()?.get()?;
        let info = s.GetPlaybackInfo()?;
        let status = match info.PlaybackStatus()? {
            Status::Playing => "Playing",
            Status::Paused => "Paused",
            _ => "Stopped",
        };
        let mut st = PlayerState {
            running: true,
            bus_name: Some("spotify".into()),
            status: status.into(),
            title: props.Title()?.to_string(),
            artist: props.Artist()?.to_string(),
            album: props.AlbumTitle()?.to_string(),
            volume: 1.0,
            shuffle: info.IsShuffleActive().ok().and_then(|r| r.Value().ok()).unwrap_or(false),
            loop_status: match info.AutoRepeatMode().ok().and_then(|r| r.Value().ok()) {
                Some(Repeat::Track) => "Track",
                Some(Repeat::List) => "Playlist",
                _ => "None",
            }
            .into(),
            ..Default::default()
        };
        // SMTC has no track id; the frontend only needs it to notice track changes
        st.track_id = format!("{}|{}|{}", st.title, st.artist, st.album);

        if let Ok(t) = s.GetTimelineProperties() {
            let secs = |d: TimeSpan| d.Duration as f64 / TICKS;
            st.length_s = (secs(t.EndTime()?) - secs(t.StartTime()?)).max(0.0);
            st.position_s = secs(t.Position()?) - secs(t.StartTime()?);
            // the position is a snapshot taken at LastUpdatedTime; advance it while playing
            if status == "Playing" {
                let updated = t.LastUpdatedTime()?.UniversalTime as f64 / TICKS - EPOCH_GAP_S;
                let now = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs_f64()).unwrap_or(updated);
                st.position_s += (now - updated).max(0.0);
            }
            if st.length_s > 0.0 {
                st.position_s = st.position_s.clamp(0.0, st.length_s);
            }
        }

        let mut cache = self.art.lock().unwrap();
        if cache.0 != st.track_id {
            *cache = (st.track_id.clone(), read_art(&props));
        }
        st.art_url = cache.1.clone();
        Ok(st)
    }

    fn run(&self, cmd: &str, num: Option<f64>, text: Option<String>) -> Result<(), String> {
        let e = |e: windows::core::Error| e.to_string();
        let s = Self::session().map_err(e)?.ok_or("Spotify is not running")?;
        let ok = |accepted: bool| if accepted { Ok(()) } else { Err(format!("Spotify rejected `{cmd}`")) };
        match cmd {
            "play" => ok(s.TryPlayAsync().map_err(e)?.get().map_err(e)?),
            "pause" => ok(s.TryPauseAsync().map_err(e)?.get().map_err(e)?),
            "play_pause" => ok(s.TryTogglePlayPauseAsync().map_err(e)?.get().map_err(e)?),
            "stop" => ok(s.TryStopAsync().map_err(e)?.get().map_err(e)?),
            "next" => ok(s.TrySkipNextAsync().map_err(e)?.get().map_err(e)?),
            "previous" => ok(s.TrySkipPreviousAsync().map_err(e)?.get().map_err(e)?),
            "seek_to" => seek(&s, num.unwrap_or(0.0)),
            "seek_by" => seek(&s, self.read_state(&s).map_err(e)?.position_s + num.unwrap_or(0.0)),
            "shuffle" => ok(s.TryChangeShuffleActiveAsync(num.unwrap_or(0.0) != 0.0).map_err(e)?.get().map_err(e)?),
            "loop" => {
                let mode = match text.as_deref() {
                    Some("Track") => Repeat::Track,
                    Some("Playlist") => Repeat::List,
                    _ => Repeat::None,
                };
                ok(s.TryChangeAutoRepeatModeAsync(mode).map_err(e)?.get().map_err(e)?)
            }
            "volume" => Ok(()), // SMTC has no volume control
            other => Err(format!("unknown command: {other}")),
        }
    }
}

fn seek(s: &Session, secs: f64) -> Result<(), String> {
    let e = |e: windows::core::Error| e.to_string();
    let start = s.GetTimelineProperties().and_then(|t| t.StartTime()).map(|d| d.Duration).unwrap_or(0);
    let ticks = start + (secs.max(0.0) * TICKS) as i64;
    s.TryChangePlaybackPositionAsync(ticks).map_err(e)?.get().map_err(e)?;
    Ok(())
}

/// The track's thumbnail as a `data:` URL (SMTC hands out a stream, not a URL).
fn read_art(props: &windows::Media::Control::GlobalSystemMediaTransportControlsSessionMediaProperties) -> Option<String> {
    let stream = props.Thumbnail().ok()?.OpenReadAsync().ok()?.get().ok()?;
    let random: IRandomAccessStream = stream.cast().ok()?;
    let size = u32::try_from(random.Size().ok()?).ok().filter(|n| *n > 0 && *n < 8_000_000)?;
    let reader = DataReader::CreateDataReader(&random.GetInputStreamAt(0).ok()?).ok()?;
    reader.LoadAsync(size).ok()?.get().ok()?;
    let mut buf = vec![0u8; size as usize];
    reader.ReadBytes(&mut buf).ok()?;
    let mime = stream
        .cast::<IContentTypeProvider>()
        .and_then(|p| p.ContentType())
        .map(|c| c.to_string())
        .ok()
        .filter(|c| !c.is_empty())
        .unwrap_or_else(|| "image/jpeg".into());
    Some(format!("data:{mime};base64,{}", base64(&buf)))
}

fn base64(data: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for c in data.chunks(3) {
        let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
        for i in 0..4 {
            if i <= c.len() {
                out.push(T[(n >> (18 - 6 * i) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::base64;

    #[test]
    fn base64_matches_rfc4648() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
    }
}
