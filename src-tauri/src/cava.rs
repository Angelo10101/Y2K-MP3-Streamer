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

fn config(source: &str) -> String {
    format!(
        "[general]\nbars = {BARS}\nframerate = 60\n\
         [input]\nmethod = pipewire\nsource = {source}\n\
         [output]\nmethod = raw\nraw_target = /dev/stdout\ndata_format = ascii\n\
         ascii_max_range = 100\nbar_delimiter = 59\nframe_delimiter = 10\nchannels = mono\n\
         [smoothing]\nnoise_reduction = 70\n"
    )
}

/// Name of the sink that is currently playing audio. cava's `source = auto` only follows the
/// default sink, which is silent when audio is routed elsewhere (e.g. Bluetooth).
async fn running_sink() -> Option<String> {
    let out = Command::new("pactl")
        .args(["list", "short", "sinks"])
        .output()
        .await
        .ok()?;
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|l| {
            let f: Vec<&str> = l.split('\t').collect();
            (f.last() == Some(&"RUNNING")).then(|| f.get(1).map(|n| n.to_string()))?
        })
        .next()
}

/// Runs cava until it exits; emits `viz-status` and `viz-bars` events. Restarts cava on the
/// newly active sink whenever playback moves to a different output.
pub async fn run(app: AppHandle) {
    let status = |available: bool, reason: Option<String>| {
        let _ = app.emit("viz-status", VizStatus { available, reason });
    };
    let path = std::env::temp_dir().join("y2k-mp3-streamer-cava.conf");
    let mut sink = running_sink().await;
    loop {
        // A bare sink name makes PipeWire link cava to the default *mic*; the `.monitor` source is
        // what captures what the sink is playing.
        let source = sink.as_ref().map_or("auto".into(), |n| format!("{n}.monitor"));
        if let Err(e) = std::fs::write(&path, config(&source)) {
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
        let mut tick = tokio::time::interval(std::time::Duration::from_secs(2));
        let switched = loop {
            tokio::select! {
                line = lines.next_line() => match line {
                    Ok(Some(line)) => {
                        let bars: Vec<u8> = line
                            .split(';')
                            .filter_map(|n| n.trim().parse::<u8>().ok())
                            .collect();
                        if !bars.is_empty() {
                            let _ = app.emit("viz-bars", bars);
                        }
                    }
                    _ => break false,
                },
                _ = tick.tick() => {
                    if let Some(now) = running_sink().await {
                        if sink.as_deref() != Some(now.as_str()) {
                            sink = Some(now);
                            break true;
                        }
                    }
                }
            }
        };
        if !switched {
            return status(false, Some("cava exited".into()));
        }
    }
}
