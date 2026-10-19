// Renders a Winamp classic skin (the main window only) and drives the player from it. The layout
// is Winamp 2's fixed 275x116 main window; everything is drawn on one canvas from the skin's sprite
// sheets and scaled up with nearest-neighbour filtering.
import { sourceName } from "../backend";
import type { PlayerShim } from "../wmp/player";
import type { WindowHooks } from "../wmp/render";
import { glyph, parseRegion, parseViscolor, timeDigits, volumeFrame, type RGB, type WinampSkin } from "./skin";

const W = 275;
const H = 116;
const SCALE = 2;
const FONT_W = 5;
const FONT_H = 6;
const TITLE_X = 111, TITLE_Y = 27, TITLE_W = 153;
const VOL = { x: 107, y: 57, w: 68, h: 13 };
const SEEK = { x: 16, y: 72, w: 248, h: 10 };
const VIS = { x: 24, y: 43, w: 76, h: 16 };
const THUMB = 14;
const SEEK_THUMB = 29;
const DIGIT_X = [48, 60, 78, 90];
/** Winamp's built-in analyzer colours, used when a skin has no viscolor.txt: line 2 is the top row. */
const DEFAULT_VIS: RGB[] = [
  [0, 0, 0], [24, 33, 41], [239, 49, 16], [206, 41, 16], [214, 90, 0], [214, 102, 0], [214, 115, 0], [198, 123, 8],
  [222, 165, 24], [214, 181, 33], [189, 222, 41], [148, 222, 33], [41, 206, 16], [50, 190, 16], [57, 181, 16], [49, 156, 8],
  [41, 148, 0], [24, 132, 8],
];

interface Button {
  id: string;
  x: number; y: number; w: number; h: number;
  sheet: string;
  /** sprite position when idle, and where the pressed sprite is relative to it */
  sx: number; sy: number; down: [number, number];
  /** an optional lit sprite offset (toggles) */
  on?: () => [number, number];
  run: () => void;
}

const inside = (r: { x: number; y: number; w: number; h: number }, x: number, y: number) => x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h;

export class WinampWindow {
  private root = document.createElement("div");
  private canvas = document.createElement("canvas");
  private g = this.canvas.getContext("2d")!;
  private sheets = new Map<string, HTMLImageElement>();
  private vis: RGB[] = DEFAULT_VIS;
  private levels: number[] = new Array(19).fill(0);
  private buttons: Button[] = [];
  private raf = 0;
  private disposed = false;
  private shapeTimer = 0;
  private rects: number[][] = [[0, 0, W * SCALE, H * SCALE]];
  // interaction state
  private pressed: string | null = null;
  private drag: "vol" | "seek" | null = null;
  private seekFrac = 0;
  private press: { x: number; y: number } | null = null;

  constructor(private skin: WinampSkin, private player: PlayerShim, private host: HTMLElement, private hooks: WindowHooks) {}

  async mount() {
    await Promise.all(
      ["main", "cbuttons", "titlebar", "numbers", "nums_ex", "playpaus", "monoster", "text", "volume", "balance", "posbar", "shufrep"].map(async (n) => {
        const img = await this.loadImage(`${n}.bmp`);
        if (img) this.sheets.set(n, img);
      }),
    );
    if (!this.sheets.has("main")) throw new Error(`${this.skin.name}: main.bmp could not be decoded`);
    const vc = this.text("viscolor.txt");
    if (vc) {
      const colors = parseViscolor(vc);
      if (colors.length >= 18) this.vis = colors;
    }
    this.buildButtons();

    const c = this.canvas;
    c.width = W;
    c.height = H;
    Object.assign(c.style, { width: `${W * SCALE}px`, height: `${H * SCALE}px`, imageRendering: "pixelated", display: "block", position: "absolute", left: "0", top: "0" });
    Object.assign(this.root.style, { position: "relative", width: `${W * SCALE}px`, height: `${H * SCALE}px` });
    this.root.id = "skin-root";
    this.root.append(c);
    this.host.replaceChildren(this.root);
    this.applyRegion();
    this.hooks.resize(W * SCALE, H * SCALE);
    this.wirePointer();
    this.scheduleShape(50);
    const loop = () => {
      if (this.disposed) return;
      this.draw();
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    clearTimeout(this.shapeTimer);
  }

  /** Re-applies the click-through shape (after the right-click menu widened it). */
  scheduleShape(ms = 150) {
    clearTimeout(this.shapeTimer);
    this.shapeTimer = window.setTimeout(() => this.hooks.setShape(this.rects), ms);
  }

  // ---------- loading ----------
  private text(name: string): string | undefined {
    const b = this.skin.files.get(name);
    return b && new TextDecoder("windows-1252").decode(b);
  }

  private async loadImage(name: string): Promise<HTMLImageElement | null> {
    const bytes = this.skin.files.get(name);
    if (!bytes) return null;
    const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "image/bmp" }));
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return img;
    } catch (e) {
      console.warn(`[winamp] cannot decode ${name}`, e);
      return null;
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  /** A non-rectangular skin (region.txt) clips what is drawn, and shapes what clicks can reach. */
  private applyRegion() {
    const polys = parseRegion(this.text("region.txt") ?? "");
    if (!polys.length) return;
    const path = polys.map((p) => "M" + p.map(([x, y]) => `${x * SCALE} ${y * SCALE}`).join(" L") + " Z").join(" ");
    this.canvas.style.clipPath = `path("${path}")`;
    this.rects = polys.map((p) => {
      const xs = p.map((q) => q[0] * SCALE), ys = p.map((q) => q[1] * SCALE);
      const x = Math.min(...xs), y = Math.min(...ys);
      return [x, y, Math.max(...xs) - x, Math.max(...ys) - y];
    });
  }

  // ---------- controls ----------
  private buildButtons() {
    const api = this.player.api;
    const st = () => this.player.state;
    const b = (id: string, x: number, y: number, w: number, h: number, sheet: string, sx: number, sy: number, down: [number, number], run: () => void, on?: () => [number, number]): Button => ({ id, x, y, w, h, sheet, sx, sy, down, run, on });
    this.buttons = [
      // transport buttons (cbuttons.bmp: idle row on top, pressed row below)
      b("prev", 16, 88, 23, 18, "cbuttons", 0, 0, [0, 18], () => api.controls.previous()),
      b("play", 39, 88, 23, 18, "cbuttons", 23, 0, [0, 18], () => api.controls.play()),
      b("pause", 62, 88, 23, 18, "cbuttons", 46, 0, [0, 18], () => api.controls.pause()),
      b("stop", 85, 88, 23, 18, "cbuttons", 69, 0, [0, 18], () => api.controls.stop()),
      b("next", 108, 88, 22, 18, "cbuttons", 92, 0, [0, 18], () => api.controls.next()),
      // Winamp's eject opens a file dialog; here it is the way back to the home screen
      b("eject", 136, 89, 22, 16, "cbuttons", 114, 0, [0, 16], () => this.hooks.returnHome()),
      b("shuffle", 164, 89, 47, 15, "shufrep", 28, 0, [0, 15], () => api.settings.setMode("shuffle", !st().shuffle), () => [0, st().shuffle ? 30 : 0]),
      b("repeat", 211, 89, 28, 15, "shufrep", 0, 0, [0, 15], () => api.settings.setMode("loop", st().loop_status === "None"), () => [0, st().loop_status !== "None" ? 30 : 0]),
      // title bar buttons (titlebar.bmp)
      b("menu", 6, 3, 9, 9, "titlebar", 0, 0, [0, 9], () => {}),
      b("minimize", 244, 3, 9, 9, "titlebar", 9, 0, [0, 9], () => this.hooks.minimize()),
      b("shade", 254, 3, 9, 9, "titlebar", 0, 18, [9, 0], () => {}),
      b("close", 264, 3, 9, 9, "titlebar", 18, 0, [0, 9], () => this.hooks.close()),
    ];
  }

  private pos(e: PointerEvent): [number, number] {
    const r = this.canvas.getBoundingClientRect();
    return [((e.clientX - r.left) * W) / r.width, ((e.clientY - r.top) * H) / r.height];
  }

  private setVolumeAt(x: number) {
    const v = Math.max(0, Math.min(1, (x - VOL.x - THUMB / 2) / (VOL.w - THUMB)));
    this.player.api.settings.volume = Math.round(v * 100);
  }

  private seekAt(x: number) {
    this.seekFrac = Math.max(0, Math.min(1, (x - SEEK.x - SEEK_THUMB / 2) / (SEEK.w - SEEK_THUMB)));
  }

  private wirePointer() {
    const c = this.canvas;
    const capture = (e: PointerEvent) => { try { c.setPointerCapture(e.pointerId); } catch { /* drags just aren't captured */ } };
    c.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      const [x, y] = this.pos(e);
      const s = this.player.state;
      const btn = [...this.buttons].reverse().find((q) => inside(q, x, y));
      if (btn) { this.pressed = btn.id; capture(e); return; }
      if (inside(VOL, x, y)) { this.drag = "vol"; this.setVolumeAt(x); capture(e); return; }
      if (inside(SEEK, x, y) && s.length_s > 0) { this.drag = "seek"; this.seekAt(x); capture(e); return; }
      // anywhere else the skin body drags the window, once the pointer really moves
      this.press = { x: e.screenX, y: e.screenY };
    });
    c.addEventListener("pointermove", (e) => {
      const [x] = this.pos(e);
      if (this.drag === "vol") this.setVolumeAt(x);
      else if (this.drag === "seek") this.seekAt(x);
      else if (this.press && (e.buttons & 1) && Math.hypot(e.screenX - this.press.x, e.screenY - this.press.y) > 4) {
        this.press = null;
        this.hooks.startDrag();
      }
    });
    c.addEventListener("pointerup", (e) => {
      const [x, y] = this.pos(e);
      this.press = null;
      if (this.pressed) {
        const btn = this.buttons.find((q) => q.id === this.pressed);
        this.pressed = null;
        if (btn && inside(btn, x, y)) btn.run();
      }
      if (this.drag === "seek") this.player.api.controls.currentPosition = this.seekFrac * this.player.state.length_s;
      this.drag = null;
    });
    c.addEventListener("pointercancel", () => { this.pressed = null; this.drag = null; this.press = null; });
  }

  // ---------- drawing ----------
  private blit(sheet: string, sx: number, sy: number, w: number, h: number, dx: number, dy: number) {
    const img = this.sheets.get(sheet);
    if (img) this.g.drawImage(img, sx, sy, w, h, dx, dy, w, h);
  }

  private drawText(str: string, x: number, y: number) {
    for (const ch of str) {
      const p = glyph(ch) ?? glyph(" ");
      if (p) this.blit("text", p[0], p[1], FONT_W, FONT_H, x, y);
      x += FONT_W;
    }
  }

  private title(): string {
    const s = this.player.state;
    if (!s.running) return `${sourceName} is not running`;
    if (!s.title) return "Y2K-MP3-Streamer";
    return `${s.artist ? s.artist + " - " : ""}${s.title}`;
  }

  private draw() {
    const g = this.g;
    g.imageSmoothingEnabled = false;
    const s = this.player.state;
    const active = s.running && s.status !== "Stopped";
    const playing = s.running && s.status === "Playing";

    this.blit("main", 0, 0, W, H, 0, 0);
    this.blit("titlebar", 27, 0, W, 14, 0, 0);

    // elapsed time
    if (active) {
      const digits = this.sheets.has("numbers") ? "numbers" : "nums_ex";
      timeDigits(this.player.position).forEach((d, i) => this.blit(digits, d * 9, 0, 9, 13, DIGIT_X[i], 26));
    }
    // play / pause / stop indicator, and the stereo lamp
    this.blit("playpaus", playing ? 0 : s.status === "Paused" && s.running ? 9 : 18, 0, 9, 9, 26, 28);
    this.blit("monoster", 0, active ? 0 : 12, 29, 12, 239, 41);
    this.blit("monoster", 29, 12, 29, 12, 212, 41);

    this.drawTitle();
    this.drawAnalyzer(playing);

    // volume: the slider's background frame, then the thumb
    const vol = Math.max(0, Math.min(1, s.volume));
    this.blit("volume", 0, volumeFrame(vol) * 15, VOL.w, VOL.h, VOL.x, VOL.y);
    this.blit("volume", this.drag === "vol" ? 0 : 15, 422, THUMB, 11, VOL.x + Math.round(vol * (VOL.w - THUMB)), VOL.y + 1);
    // balance is not supported by the players: always centred
    this.blit("balance", 0, 0, 38, 13, 177, 57);
    this.blit("balance", 15, 422, THUMB, 11, 177 + (38 - THUMB) / 2, 58);
    // EQ / playlist toggles are not supported: drawn idle
    this.blit("shufrep", 0, 61, 23, 12, 219, 58);
    this.blit("shufrep", 23, 61, 23, 12, 242, 58);

    // seek bar
    this.blit("posbar", 0, 0, SEEK.w, SEEK.h, SEEK.x, SEEK.y);
    if (active && s.length_s > 0) {
      const frac = this.drag === "seek" ? this.seekFrac : Math.min(1, this.player.position / s.length_s);
      this.blit("posbar", this.drag === "seek" ? 278 : 248, 0, SEEK_THUMB, SEEK.h, SEEK.x + Math.round(frac * (SEEK.w - SEEK_THUMB)), SEEK.y);
    }

    for (const b of this.buttons) {
      const down = this.pressed === b.id;
      const [ox, oy] = b.on?.() ?? [0, 0];
      this.blit(b.sheet, b.sx + ox + (down ? b.down[0] : 0), b.sy + oy + (down ? b.down[1] : 0), b.w, b.h, b.x, b.y);
    }
  }

  /** The song title, scrolling when it doesn't fit. */
  private drawTitle() {
    const text = this.title();
    const g = this.g;
    g.save();
    g.beginPath();
    g.rect(TITLE_X, TITLE_Y, TITLE_W, FONT_H);
    g.clip();
    // repaint the whole ticker strip with the font's own background, as Winamp does
    this.drawText(" ".repeat(Math.ceil(TITLE_W / FONT_W)), TITLE_X, TITLE_Y);
    if (text.length * FONT_W <= TITLE_W) this.drawText(text, TITLE_X, TITLE_Y);
    else {
      const loop = `${text}  ***  `;
      const offset = Math.floor(performance.now() / 60) % (loop.length * FONT_W);
      this.drawText(loop + loop, TITLE_X - offset, TITLE_Y);
    }
    g.restore();
  }

  /** The spectrum analyzer: 19 bars, 3 px wide with a 1 px gap, coloured by row from viscolor.txt. */
  private drawAnalyzer(playing: boolean) {
    const bars = this.player.vizAvailable ? this.player.bars : [];
    for (let i = 0; i < this.levels.length; i++) {
      const target = playing && bars.length ? Math.min(1, (bars[Math.floor((i * bars.length) / this.levels.length)] ?? 0) / 100) : 0;
      this.levels[i] = Math.max(target, this.levels[i] - 0.05);
      const h = Math.round(this.levels[i] * VIS.h);
      for (let r = VIS.h - h; r < VIS.h; r++) {
        const [cr, cg, cb] = this.vis[2 + Math.min(15, r)] ?? DEFAULT_VIS[2 + Math.min(15, r)];
        this.g.fillStyle = `rgb(${cr},${cg},${cb})`;
        this.g.fillRect(VIS.x + i * 4, VIS.y + r, 3, 1);
      }
    }
  }
}
