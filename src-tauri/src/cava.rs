//! Streams visualizer bar data from `cava` (PipeWire) to the frontend.

use std::process::Stdio;

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

pub const BARS: usize = 32;

#[derive(Serialize, Clone)]
struct VizStatus {
    available: bool,
    reason: Option<String>,
}

fn config() -> String {
    format!(
        "[general]\nbars = {BARS}\nframerate = 60\n\
         [input]\nmethod = pipewire\nsource = auto\n\
         [output]\nmethod = raw\nraw_target = /dev/stdout\ndata_format = ascii\n\
         ascii_max_range = 100\nbar_delimiter = 59\nframe_delimiter = 10\nchannels = mono\n\
         [smoothing]\nnoise_reduction = 70\n"
    )
}

/// Runs cava until it exits; emits `viz-status` and `viz-bars` events.
pub async fn run(app: AppHandle) {
    let status = |available: bool, reason: Option<String>| {
        let _ = app.emit("viz-status", VizStatus { available, reason });
    };
    let path = std::env::temp_dir().join("retro-mp3-yt-music-cava.conf");
    if let Err(e) = std::fs::write(&path, config()) {
        return status(false, Some(format!("cannot write cava config: {e}")));
    }
    let mut child = match Command::new("cava")
        .arg("-p")
        .arg(&path)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
    {
        Ok(c) => c,
        Err(e) => {
            return status(
                false,
                Some(if e.kind() == std::io::ErrorKind::NotFound {
                    "cava is not installed".into()
                } else {
                    e.to_string()
                }),
            )
        }
    };
    status(true, None);
    let mut lines = BufReader::new(child.stdout.take().expect("piped")).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let bars: Vec<u8> = line
            .split(';')
            .filter_map(|n| n.trim().parse::<u8>().ok())
            .collect();
        if !bars.is_empty() {
            let _ = app.emit("viz-bars", bars);
        }
    }
    status(false, Some("cava exited".into()));
}
