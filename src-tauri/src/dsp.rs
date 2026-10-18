#![cfg_attr(not(windows), allow(dead_code))]
//! Turns raw audio samples into visualizer bars (0..=100). Used where cava isn't available.

use std::sync::Arc;

use rustfft::{num_complex::Complex, Fft, FftPlanner};

pub const FFT_SIZE: usize = 2048;

pub struct Analyzer {
    fft: Arc<dyn Fft<f32>>,
    window: Vec<f32>,
    bands: Vec<(usize, usize)>,
    prev: Vec<f32>,
}

impl Analyzer {
    pub fn new(sample_rate: u32, bars: usize) -> Self {
        let fft = FftPlanner::new().plan_fft_forward(FFT_SIZE);
        let window = (0..FFT_SIZE)
            .map(|i| 0.5 - 0.5 * (2.0 * std::f32::consts::PI * i as f32 / (FFT_SIZE as f32 - 1.0)).cos())
            .collect();
        // log-spaced bands from ~60 Hz to 16 kHz (or Nyquist)
        let (lo, hi) = (60.0f32, (sample_rate as f32 / 2.0).min(16_000.0));
        let bin = |f: f32| ((f * FFT_SIZE as f32 / sample_rate as f32) as usize).clamp(1, FFT_SIZE / 2 - 1);
        let bands = (0..bars)
            .map(|i| {
                let f0 = lo * (hi / lo).powf(i as f32 / bars as f32);
                let f1 = lo * (hi / lo).powf((i + 1) as f32 / bars as f32);
                let (a, b) = (bin(f0), bin(f1));
                (a, b.max(a + 1))
            })
            .collect();
        Self { fft, window, bands, prev: vec![0.0; bars] }
    }

    /// `samples` is mono, newest last; shorter input is zero-padded at the front.
    pub fn process(&mut self, samples: &[f32]) -> Vec<u8> {
        let mut buf = vec![Complex { re: 0.0f32, im: 0.0 }; FFT_SIZE];
        let take = samples.len().min(FFT_SIZE);
        for (i, s) in samples[samples.len() - take..].iter().enumerate() {
            let j = FFT_SIZE - take + i;
            buf[j].re = s * self.window[j];
        }
        self.fft.process(&mut buf);
        let norm = FFT_SIZE as f32 / 4.0; // Hann window halves the amplitude
        self.bands
            .iter()
            .zip(self.prev.iter_mut())
            .map(|(&(a, b), prev)| {
                let mag = buf[a..b].iter().map(|c| c.norm() / norm).fold(0.0f32, f32::max);
                let db = 20.0 * mag.max(1e-6).log10();
                let level = ((db + 65.0) / 60.0 * 100.0).clamp(0.0, 100.0); // -65 dB .. -5 dB
                *prev = level.max(*prev * 0.82); // quick rise, gentle fall
                prev.round() as u8
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sine(freq: f32, rate: u32, n: usize) -> Vec<f32> {
        (0..n).map(|i| 0.5 * (2.0 * std::f32::consts::PI * freq * i as f32 / rate as f32).sin()).collect()
    }

    #[test]
    fn silence_gives_zero_bars() {
        let mut a = Analyzer::new(48_000, 32);
        assert!(a.process(&vec![0.0; FFT_SIZE]).iter().all(|&b| b == 0));
    }

    #[test]
    fn a_tone_lights_up_the_matching_band_most() {
        let mut a = Analyzer::new(48_000, 32);
        let bars = a.process(&sine(1_000.0, 48_000, FFT_SIZE));
        let peak = bars.iter().enumerate().max_by_key(|(_, &v)| v).unwrap().0;
        // 1 kHz is ~50% of the way through 60 Hz..16 kHz on a log scale
        assert!((15..=17).contains(&peak), "peak band {peak}: {bars:?}");
        assert!(bars[peak] > 60);
        assert!(bars[0] < bars[peak] && bars[31] < bars[peak]);
    }
}
