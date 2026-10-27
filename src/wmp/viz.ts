// WMP's own visualizations (Alchemy, Bars and Waves, Battery, Spikes, ...) drawn by the
// wmp-legacy-visualizers engine in vendor/, fed from the 32 spectrum bands we already stream.
// The engine is big, so it is loaded the first time an effects element is built.
import type { PresetEntry, TimedLevel, VisEngine } from "../../vendor/wmp-legacy-visualizers/src/index";

type Engine = typeof import("../../vendor/wmp-legacy-visualizers/src/index");

/** Families offered in the cycle; the rest are Direct3D ports or need artwork we don't ship. */
const GROUPS = new Set(["Alchemy", "Bars and Waves", "Battery", "Spikes", "Particle", "Plenoptic", "Ambience"]);

let lib: Engine | null = null;
let loading: Promise<void> | null = null;
const listeners: (() => void)[] = [];

export function loadViz(onReady?: () => void) {
  if (lib) { onReady?.(); return; }
  if (onReady) listeners.push(onReady);
  loading ??= import("../../vendor/wmp-legacy-visualizers/src/index").then((m) => {
    lib = m;
    listeners.splice(0).forEach((f) => f());
  });
}

export function vizPresets(): PresetEntry[] {
  return lib ? lib.PRESETS.filter((p) => GROUPS.has(p.group) && !/\(WMP /.test(p.name)) : [];
}

export const vizLabel = (p: PresetEntry) => (p.group === p.name ? p.name : `${p.group}: ${p.name}`);

// Cava's bands run roughly 50 Hz to 10 kHz on a log scale; WMP's 1024 bins are linear to 22 kHz.
const LO_HZ = 50, HI_HZ = 10000, BIN_HZ = 22050 / 1024, RATE = 44100;
const N = 1024;

/** Turns the band levels into the freq/wave bytes WMP's visualizers expect. */
export class LevelSynth {
  readonly level: TimedLevel;
  private phase = new Float64Array(32);
  private lastBars = "";

  constructor(makeLevel: () => TimedLevel) { this.level = makeLevel(); }

  fill(bars: number[], playing: boolean) {
    const L = this.level;
    const nb = bars.length || 1;
    const band = (i: number) => Math.min(nb - 1, Math.max(0, i));
    const f0 = L.freq[0], w0 = L.wave[0];
    for (let i = 0; i < N; i++) {
      const hz = i * BIN_HZ;
      const pos = hz <= LO_HZ ? 0 : (Math.log(hz / LO_HZ) / Math.log(HI_HZ / LO_HZ)) * (nb - 1);
      const a = Math.floor(pos), t = pos - a;
      let v = (bars[band(a)] ?? 0) * (1 - t) + (bars[band(a + 1)] ?? 0) * t;
      if (hz > HI_HZ) v *= Math.max(0, 1 - (hz - HI_HZ) / 6000);
      f0[i] = Math.min(255, Math.max(0, v * 2.55));
    }
    // No raw samples reach the webview, so make a waveform out of one sine per band.
    w0.fill(128);
    const norm = 1 / Math.max(1, nb) * 3;
    for (let b = 0; b < nb; b++) {
      const amp = (bars[b] ?? 0) / 100;
      const hz = LO_HZ * Math.pow(HI_HZ / LO_HZ, b / Math.max(1, nb - 1));
      const w = (2 * Math.PI * hz) / RATE;
      let ph = this.phase[b] = (this.phase[b] + w * 735) % (2 * Math.PI); // 1/60 s of drift per call
      if (amp < 0.01) continue;
      const k = amp * norm * 127;
      for (let i = 0; i < N; i++) w0[i] += k * Math.sin(ph + w * i);
    }
    L.freq[1].set(f0); L.wave[1].set(w0);
    L.state = playing ? 2 : 1;
    L.timeStamp = Math.floor(performance.now()) || 1;
  }
}

/** One engine bound to one canvas. A canvas can't change context type, so a new family gets a new canvas. */
export class VizView {
  private eng: VisEngine | null = null;
  private kind = "";
  private canvas: HTMLCanvasElement | null = null;
  private synth: LevelSynth | null = null;

  constructor(private host: HTMLElement, private w: number, private h: number) {}

  draw(p: PresetEntry, bars: number[], playing: boolean) {
    if (!lib) return;
    if (!this.synth) this.synth = new LevelSynth(lib.makeLevel);
    if (this.kind !== p.vis) {
      this.canvas?.remove();
      const c = document.createElement("canvas");
      c.width = this.w; c.height = this.h;
      c.style.cssText = "position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none";
      this.host.appendChild(c);
      this.canvas = c;
      this.eng = lib.createEngine(p.vis, c, { preset: p.preset, scale: "auto" });
      this.eng.resize(this.w, this.h);
      this.kind = p.vis;
    } else if (this.eng!.preset !== p.preset) this.eng!.setPreset(p.preset);
    this.synth.fill(bars, playing);
    this.eng!.render(this.synth.level);
    this.eng!.present();
  }

  hide() { this.canvas?.remove(); this.canvas = null; this.eng = null; this.kind = ""; }
}
