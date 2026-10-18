//! Visualizer source on Windows: captures what the default output device is playing (WASAPI
//! loopback through cpal) and turns it into bars with `dsp`. Emits the same `viz-bars` /
//! `viz-status` events as the cava source on Linux.

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{SampleFormat, StreamConfig};
use serde_json::json;
use tauri::{AppHandle, Emitter};

use crate::dsp::{Analyzer, FFT_SIZE};

pub const BARS: usize = 32;

fn status(app: &AppHandle, available: bool, reason: Option<String>) {
    let _ = app.emit("viz-status", json!({ "available": available, "reason": reason }));
}

/// Averages interleaved frames to mono.
fn downmix<T: Copy>(data: &[T], channels: usize, conv: impl Fn(T) -> f32) -> Vec<f32> {
    data.chunks(channels.max(1)).map(|f| f.iter().map(|&s| conv(s)).sum::<f32>() / f.len() as f32).collect()
}

struct Ring {
    samples: Vec<f32>,
    last_data: Instant,
}

pub async fn run(app: AppHandle) {
    let _ = std::thread::Builder::new().name("loopback-viz".into()).spawn(move || capture(app));
}

fn capture(app: AppHandle) {
    let host = cpal::default_host();
    let Some(device) = host.default_output_device() else {
        return status(&app, false, Some("no audio output device".into()));
    };
    let supported = match device.default_output_config() {
        Ok(c) => c,
        Err(e) => return status(&app, false, Some(format!("cannot read audio format: {e}"))),
    };
    let (rate, channels, format) = (supported.sample_rate().0, supported.channels() as usize, supported.sample_format());
    let config: StreamConfig = supported.into();

    let ring = Arc::new(Mutex::new(Ring { samples: Vec::with_capacity(FFT_SIZE * 2), last_data: Instant::now() }));
    let push = {
        let ring = ring.clone();
        move |mono: Vec<f32>| {
            let mut r = ring.lock().unwrap();
            r.samples.extend(mono);
            let excess = r.samples.len().saturating_sub(FFT_SIZE * 2);
            r.samples.drain(..excess);
            r.last_data = Instant::now();
        }
    };
    let err_app = app.clone();
    let err_fn = move |e: cpal::StreamError| status(&err_app, false, Some(format!("audio capture error: {e}")));

    // Building an *input* stream on an *output* device is WASAPI loopback in cpal.
    let stream = match format {
        SampleFormat::F32 => device.build_input_stream(&config, move |d: &[f32], _| push(downmix(d, channels, |s| s)), err_fn, None),
        SampleFormat::I16 => device.build_input_stream(&config, move |d: &[i16], _| push(downmix(d, channels, |s| s as f32 / 32768.0)), err_fn, None),
        SampleFormat::U16 => device.build_input_stream(&config, move |d: &[u16], _| push(downmix(d, channels, |s| (s as f32 - 32768.0) / 32768.0)), err_fn, None),
        other => return status(&app, false, Some(format!("unsupported audio sample format {other:?}"))),
    };
    let stream = match stream {
        Ok(s) => s,
        Err(e) => return status(&app, false, Some(format!("cannot capture system audio: {e}"))),
    };
    if let Err(e) = stream.play() {
        return status(&app, false, Some(format!("cannot start audio capture: {e}")));
    }
    status(&app, true, None);

    let mut analyzer = Analyzer::new(rate, BARS);
    loop {
        std::thread::sleep(Duration::from_millis(16));
        let samples = {
            let mut r = ring.lock().unwrap();
            // WASAPI loopback delivers nothing while silent: treat that as silence
            if r.last_data.elapsed() > Duration::from_millis(120) {
                r.samples.clear();
            }
            r.samples.clone()
        };
        let _ = app.emit("viz-bars", analyzer.process(&samples));
    }
}
