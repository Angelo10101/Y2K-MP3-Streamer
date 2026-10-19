// Renders a Winamp classic skin and drives the player from it: the 275x116 main window, plus the
// equalizer and playlist windows stacked below it (toggled by the EQ and PL buttons, as in
// Winamp). Everything is drawn on one canvas from the skin's sprite sheets and scaled up with
// nearest-neighbour filtering.
import { queueGet, queueSelect, sourceName, type QueueItem } from "../backend";
import type { WindowHooks } from "../wmp/render";
import { fmtTime, type PlayerShim } from "../wmp/player";
import { glyph, parsePledit, parseRegion, parseViscolor, timeDigits, volumeFrame, type PlaylistStyle, type RGB, type WinampSkin } from "./skin";

const W = 275;
const MAIN_H = 116;
const EQ_H = 116;
const PL_H = 174;
const FONT_W = 5;
const FONT_H = 6;
const TITLE_X = 111, TITLE_Y = 27, TITLE_W = 153;
const VOL = { x: 107, y: 57, w: 68, h: 13 };
const BAL = { x: 177, y: 57, w: 38, h: 13 };
const SEEK = { x: 16, y: 72, w: 248, h: 10 };
const VIS = { x: 24, y: 43, w: 76, h: 16 };
const THUMB = 14;
const SEEK_THUMB = 29;
const DIGIT_X = [48, 60, 78, 90];
// equalizer window: the preamp slider, then ten band sliders (14x63 each)
const EQ_SLIDER_Y = 38;
const EQ_SLIDER_W = 14;
const EQ_SLIDER_H = 63;
const EQ_X = [21, ...Array.from({ length: 10 }, (_, i) => 78 + i * 18)];
// playlist window: the list sits between the frame's tiles
const PL_LIST = { x: 12, y: 20, w: W - 12 - 20, h: PL_H - 20 - 38 };
const ROW_H = 13;
/** Winamp's built-in analyzer colours, used when a skin has no viscolor.txt: line 2 is the top row. */
const DEFAULT_VIS: RGB[] = [
  [0, 0, 0], [24, 33, 41], [239, 49, 16], [206, 41, 16], [214, 90, 0], [214, 102, 0], [214, 115, 0], [198, 123, 8],
  [222, 165, 24], [214, 181, 33], [189, 222, 41], [148, 222, 33], [41, 206, 16], [50, 190, 16], [57, 181, 16], [49, 156, 8],
  [41, 148, 0], [24, 132, 8],
];

type Win = "main" | "eq" | "pl";

interface Button {
  win: Win;
  id: string;
  /** position inside its window */
  x: number; y: number; w: number; h: number;
  sheet: string;
  /** sprite position when idle, and where the pressed sprite is relative to it */
  sx: number; sy: number; down: [number, number];
  /** an offset to a lit sprite (toggles) */
  on?: () => [number, number];
  /** false for click areas that are already part of the window's frame bitmap */
  visible: boolean;
  run: () => void;
}

type Drag =
  | { kind: "vol" }
  | { kind: "seek" }
  | { kind: "eq"; index: number }
  | { kind: "scroll" };

const inside = (r: { x: number; y: number; w: number; h: number }, x: number, y: number) => x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h;
const flag = (key: string, def: boolean) => { try { const v = localStorage.getItem(key); return v === null ? def : v === "1"; } catch { return def; } };
const setFlag = (key: string, on: boolean) => { try { localStorage.setItem(key, on ? "1" : "0"); } catch { /* ignore */ } };

export class WinampWindow {
  private root = document.createElement("div");
  private canvas = document.createElement("canvas");
  private g = this.canvas.getContext("2d")!;
  private sheets = new Map<string, HTMLImageElement>();
  private vis: RGB[] = DEFAULT_VIS;
  private plStyle: PlaylistStyle = parsePledit("");
  private levels: number[] = new Array(19).fill(0);
  private buttons: Button[] = [];
  private raf = 0;
  private disposed = false;
  private shapeTimer = 0;
  private queueTimer = 0;
  private mainRegion: [number, number][][] = [];
  private scale = 2;
  // which extra windows are open
  private eqOpen = flag("winamp-eq", false);
  private plOpen = flag("winamp-pl", false);
  // equalizer: preamp then ten bands, 0..100 with 50 in the middle. The players have no equalizer,
  // so these only move on screen.
  private eqValues: number[] = new Array(11).fill(50);
  private eqOn = true;
  private eqAuto = false;
  // playlist
  private queue: QueueItem[] | null = null;
  private plScroll = 0;
  private plSelected = -1;
  // interaction state
  private pressed: string | null = null;
  private drag: Drag | null = null;
  private seekFrac = 0;
  private press: { x: number; y: number } | null = null;

  constructor(private skin: WinampSkin, private player: PlayerShim, private host: HTMLElement, private hooks: WindowHooks) {}

  async mount() {
    await Promise.all(
      ["main", "cbuttons", "titlebar", "numbers", "nums_ex", "playpaus", "monoster", "text", "volume", "balance", "posbar", "shufrep", "eqmain", "pledit"].map(async (n) => {
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
    this.plStyle = parsePledit(this.text("pledit.txt") ?? "");
    this.mainRegion = parseRegion(this.text("region.txt") ?? "");
    this.buildButtons();

    this.root.id = "skin-root";
    Object.assign(this.canvas.style, { imageRendering: "pixelated", display: "block", position: "absolute", left: "0", top: "0" });
    this.canvas.width = W;
    this.root.append(this.canvas);
    this.host.replaceChildren(this.root);
    this.layout();
    this.wirePointer();
    this.queueTimer = window.setInterval(() => void this.refreshQueue(), 2000);
    if (this.plOpen) void this.refreshQueue();
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
    clearInterval(this.queueTimer);
  }

  /** Re-applies the click-through shape (after the right-click menu widened it). */
  scheduleShape(ms = 150) {
    clearTimeout(this.shapeTimer);
    this.shapeTimer = window.setTimeout(() => this.hooks.setShape(this.rects()), ms);
  }

  // ---------- layout: the windows stack vertically ----------
  private get totalH() { return MAIN_H + (this.eqOpen ? EQ_H : 0) + (this.plOpen ? PL_H : 0); }
  private offset(win: Win): number { return win === "main" ? 0 : win === "eq" ? MAIN_H : MAIN_H + (this.eqOpen ? EQ_H : 0); }

  /** Where clicks may land: the main window's outline, plus the full rectangle of the windows below. */
  private rects(): number[][] {
    const s = this.scale;
    const out: number[][] = this.mainRegion.length
      ? this.mainRegion.map((p) => {
          const xs = p.map((q) => q[0] * s), ys = p.map((q) => q[1] * s);
          const x = Math.min(...xs), y = Math.min(...ys);
          return [x, y, Math.max(...xs) - x, Math.max(...ys) - y];
        })
      : [[0, 0, W * s, MAIN_H * s]];
    if (this.totalH > MAIN_H) out.push([0, MAIN_H * s, W * s, (this.totalH - MAIN_H) * s]);
    return out;
  }

  /**
   * Sizes the canvas for the open windows. The skin is drawn at 2x, but the stack of windows may
   * only use about 60% of the screen's height (and never more than the app window), so opening
   * the equalizer and playlist shrinks it instead of filling the screen.
   */
  private layout() {
    const total = this.totalH;
    const budget = Math.min(window.innerHeight, (window.screen.availHeight || window.innerHeight) * 0.6);
    this.scale = Math.max(1, Math.floor(Math.min(2, budget / total) * 8) / 8);
    const s = this.scale;
    this.canvas.height = total;
    Object.assign(this.canvas.style, { width: `${W * s}px`, height: `${total * s}px` });
    Object.assign(this.root.style, { position: "relative", width: `${W * s}px`, height: `${total * s}px` });
    if (this.mainRegion.length) {
      const poly = this.mainRegion.map((p) => "M" + p.map(([x, y]) => `${x * s} ${y * s}`).join(" L") + " Z");
      if (total > MAIN_H) poly.push(`M0 ${MAIN_H * s} L${W * s} ${MAIN_H * s} L${W * s} ${total * s} L0 ${total * s} Z`);
      this.canvas.style.clipPath = `path("${poly.join(" ")}")`;
    }
    this.hooks.resize(W * s, total * s);
    this.scheduleShape(50);
  }

  private toggle(win: "eq" | "pl") {
    if (win === "eq") { this.eqOpen = !this.eqOpen; setFlag("winamp-eq", this.eqOpen); }
    else { this.plOpen = !this.plOpen; setFlag("winamp-pl", this.plOpen); if (this.plOpen) void this.refreshQueue(); }
    this.layout();
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

  // ---------- playlist data ----------
  /** The queue comes from Pear; without it (Spotify, no API) the list is just the current track. */
  private async refreshQueue() {
    if (!this.plOpen || this.disposed) return;
    try { this.queue = await queueGet(); } catch { this.queue = null; }
  }

  private rows(): { text: string; time: string; current: boolean; index: number | null }[] {
    const s = this.player.state;
    if (this.queue?.length) return this.queue.map((q, i) => ({ text: `${i + 1}. ${q.artist ? q.artist + " - " : ""}${q.title}`, time: q.duration, current: q.selected, index: q.index }));
    if (s.title) return [{ text: `1. ${s.artist ? s.artist + " - " : ""}${s.title}`, time: fmtTime(s.length_s), current: true, index: null }];
    return [{ text: s.running ? "Nothing playing" : `${sourceName} is not running`, time: "", current: false, index: null }];
  }

  private get visibleRows() { return Math.floor(PL_LIST.h / ROW_H); }
  private maxScroll() { return Math.max(0, this.rows().length - this.visibleRows); }

  // ---------- controls ----------
  private buildButtons() {
    const api = this.player.api;
    const st = () => this.player.state;
    const b = (win: Win, id: string, x: number, y: number, w: number, h: number, sheet: string, sx: number, sy: number, down: [number, number], run: () => void, on?: () => [number, number], visible = true): Button => ({ win, id, x, y, w, h, sheet, sx, sy, down, run, on, visible });
    this.buttons = [
      // transport buttons (cbuttons.bmp: idle row on top, pressed row below)
      b("main", "prev", 16, 88, 23, 18, "cbuttons", 0, 0, [0, 18], () => api.controls.previous()),
      b("main", "play", 39, 88, 23, 18, "cbuttons", 23, 0, [0, 18], () => api.controls.play()),
      b("main", "pause", 62, 88, 23, 18, "cbuttons", 46, 0, [0, 18], () => api.controls.pause()),
      b("main", "stop", 85, 88, 23, 18, "cbuttons", 69, 0, [0, 18], () => api.controls.stop()),
      b("main", "next", 108, 88, 22, 18, "cbuttons", 92, 0, [0, 18], () => api.controls.next()),
      // Winamp's eject opens a file dialog; here it is the way back to the home screen
      b("main", "eject", 136, 89, 22, 16, "cbuttons", 114, 0, [0, 16], () => this.hooks.returnHome()),
      b("main", "shuffle", 164, 89, 47, 15, "shufrep", 28, 0, [0, 15], () => api.settings.setMode("shuffle", !st().shuffle), () => [0, st().shuffle ? 30 : 0]),
      b("main", "repeat", 211, 89, 28, 15, "shufrep", 0, 0, [0, 15], () => api.settings.setMode("loop", st().loop_status === "None"), () => [0, st().loop_status !== "None" ? 30 : 0]),
      // the EQ and PL buttons open and close the two extra windows
      b("main", "eq", 219, 58, 23, 12, "shufrep", 0, 61, [46, 0], () => this.toggle("eq"), () => [0, this.eqOpen ? 12 : 0]),
      b("main", "pl", 242, 58, 23, 12, "shufrep", 23, 61, [46, 0], () => this.toggle("pl"), () => [0, this.plOpen ? 12 : 0]),
      // title bar buttons (titlebar.bmp)
      b("main", "menu", 6, 3, 9, 9, "titlebar", 0, 0, [0, 9], () => {}),
      b("main", "minimize", 244, 3, 9, 9, "titlebar", 9, 0, [0, 9], () => this.hooks.minimize()),
      b("main", "shade", 254, 3, 9, 9, "titlebar", 0, 18, [9, 0], () => {}),
      b("main", "close", 264, 3, 9, 9, "titlebar", 18, 0, [0, 9], () => this.hooks.close()),
      // equalizer window (eqmain.bmp): the ON / AUTO buttons light up by moving 59 px right
      b("eq", "eq-on", 14, 18, 26, 12, "eqmain", 10, 119, [118, 0], () => { this.eqOn = !this.eqOn; }, () => [this.eqOn ? 59 : 0, 0]),
      b("eq", "eq-auto", 39, 18, 32, 12, "eqmain", 36, 119, [118, 0], () => { this.eqAuto = !this.eqAuto; }, () => [this.eqAuto ? 59 : 0, 0]),
      b("eq", "eq-presets", 217, 18, 44, 12, "eqmain", 224, 164, [0, 12], () => {}),
      b("eq", "eq-close", 264, 3, 9, 9, "eqmain", 0, 116, [0, 9], () => this.toggle("eq"), undefined, false),
      // playlist window: the close box is part of the frame bitmap
      b("pl", "pl-close", W - 11, 3, 9, 9, "pledit", 52, 42, [0, 0], () => this.toggle("pl"), undefined, false),
    ];
  }

  /** The window under a canvas y, with the point converted to that window's own coordinates. */
  private locate(x: number, y: number): { win: Win; lx: number; ly: number } | null {
    for (const win of ["pl", "eq", "main"] as Win[]) {
      if ((win === "eq" && !this.eqOpen) || (win === "pl" && !this.plOpen)) continue;
      const top = this.offset(win);
      const h = win === "main" ? MAIN_H : win === "eq" ? EQ_H : PL_H;
      if (y >= top && y < top + h) return { win, lx: x, ly: y - top };
    }
    return null;
  }

  private pos(e: { clientX: number; clientY: number }): [number, number] {
    const r = this.canvas.getBoundingClientRect();
    return [((e.clientX - r.left) * W) / r.width, ((e.clientY - r.top) * this.totalH) / r.height];
  }

  private setVolumeAt(x: number) {
    const v = Math.max(0, Math.min(1, (x - VOL.x - THUMB / 2) / (VOL.w - THUMB)));
    this.player.api.settings.volume = Math.round(v * 100);
  }

  private seekAt(x: number) {
    this.seekFrac = Math.max(0, Math.min(1, (x - SEEK.x - SEEK_THUMB / 2) / (SEEK.w - SEEK_THUMB)));
  }

  private setEqAt(index: number, ly: number) {
    this.eqValues[index] = Math.round(Math.max(0, Math.min(100, 100 - ((ly - EQ_SLIDER_Y - 5.5) / (EQ_SLIDER_H - 11)) * 100)));
  }

  private scrollTo(ly: number) {
    const track = PL_LIST.h - 18;
    this.plScroll = Math.round(Math.max(0, Math.min(1, (ly - PL_LIST.y - 9) / track)) * this.maxScroll());
  }

  private rowAt(ly: number): number | null {
    const i = this.plScroll + Math.floor((ly - PL_LIST.y) / ROW_H);
    return i >= 0 && i < this.rows().length ? i : null;
  }

  private wirePointer() {
    const c = this.canvas;
    const capture = (e: PointerEvent) => { try { c.setPointerCapture(e.pointerId); } catch { /* drags just aren't captured */ } };
    c.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      const [x, y] = this.pos(e);
      const at = this.locate(x, y);
      if (!at) return;
      const { win, lx, ly } = at;
      const btn = [...this.buttons].reverse().find((q) => q.win === win && inside(q, lx, ly));
      if (btn) { this.pressed = btn.id; capture(e); return; }
      if (win === "main") {
        if (inside(VOL, lx, ly)) { this.drag = { kind: "vol" }; this.setVolumeAt(lx); capture(e); return; }
        if (inside(SEEK, lx, ly) && this.player.state.length_s > 0) { this.drag = { kind: "seek" }; this.seekAt(lx); capture(e); return; }
      } else if (win === "eq") {
        const i = EQ_X.findIndex((sx) => lx >= sx && lx < sx + EQ_SLIDER_W);
        if (i >= 0 && ly >= EQ_SLIDER_Y && ly < EQ_SLIDER_Y + EQ_SLIDER_H) { this.drag = { kind: "eq", index: i }; this.setEqAt(i, ly); capture(e); return; }
      } else if (win === "pl") {
        if (lx >= W - 20 && lx < W && ly >= PL_LIST.y && ly < PL_LIST.y + PL_LIST.h) { this.drag = { kind: "scroll" }; this.scrollTo(ly); capture(e); return; }
        if (inside(PL_LIST, lx, ly)) { this.plSelected = this.rowAt(ly) ?? -1; return; }
      }
      // anywhere else the skin body drags the window, once the pointer really moves
      this.press = { x: e.screenX, y: e.screenY };
    });
    c.addEventListener("pointermove", (e) => {
      const [x, y] = this.pos(e);
      const d = this.drag;
      if (d?.kind === "vol") this.setVolumeAt(x);
      else if (d?.kind === "seek") this.seekAt(x);
      else if (d?.kind === "eq") this.setEqAt(d.index, y - this.offset("eq"));
      else if (d?.kind === "scroll") this.scrollTo(y - this.offset("pl"));
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
        const at = this.locate(x, y);
        if (btn && at && at.win === btn.win && inside(btn, at.lx, at.ly)) btn.run();
      }
      if (this.drag?.kind === "seek") this.player.api.controls.currentPosition = this.seekFrac * this.player.state.length_s;
      this.drag = null;
    });
    c.addEventListener("pointercancel", () => { this.pressed = null; this.drag = null; this.press = null; });
    // double-click a playlist row to play it
    c.addEventListener("dblclick", (e) => {
      const [x, y] = this.pos(e);
      const at = this.locate(x, y);
      if (at?.win !== "pl" || !inside(PL_LIST, at.lx, at.ly)) return;
      const row = this.rowAt(at.ly);
      const index = row === null ? null : this.rows()[row].index;
      if (index !== null) void queueSelect(index).then(() => this.refreshQueue()).catch(() => {});
    });
    c.addEventListener("wheel", (e) => {
      const [x, y] = this.pos(e);
      if (this.locate(x, y)?.win !== "pl") return;
      e.preventDefault();
      this.plScroll = Math.max(0, Math.min(this.maxScroll(), this.plScroll + Math.sign(e.deltaY)));
    }, { passive: false });
  }

  // ---------- drawing ----------
  private blit(sheet: string, sx: number, sy: number, w: number, h: number, dx: number, dy: number) {
    const img = this.sheets.get(sheet);
    if (img) this.g.drawImage(img, sx, sy, w, h, dx, dy, w, h);
  }

  /** Paints one window: its drawing code works in the window's own coordinates. */
  private inWindow(win: Win, paint: () => void) {
    this.g.save();
    this.g.translate(0, this.offset(win));
    paint();
    this.g.restore();
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
    this.g.imageSmoothingEnabled = false;
    this.inWindow("main", () => this.drawMain());
    if (this.eqOpen) this.inWindow("eq", () => this.drawEq());
    if (this.plOpen) this.inWindow("pl", () => this.drawPlaylist());
  }

  private drawButtons(win: Win) {
    for (const b of this.buttons) {
      if (b.win !== win || !b.visible) continue;
      const down = this.pressed === b.id;
      const [ox, oy] = b.on?.() ?? [0, 0];
      this.blit(b.sheet, b.sx + ox + (down ? b.down[0] : 0), b.sy + oy + (down ? b.down[1] : 0), b.w, b.h, b.x, b.y);
    }
  }

  private drawMain() {
    const s = this.player.state;
    const active = s.running && s.status !== "Stopped";
    const playing = s.running && s.status === "Playing";

    this.blit("main", 0, 0, W, MAIN_H, 0, 0);
    this.blit("titlebar", 27, 0, W, 14, 0, 0);

    // elapsed time
    if (active) {
      const digits = this.sheets.has("numbers") ? "numbers" : "nums_ex";
      timeDigits(this.player.position).forEach((d, i) => this.blit(digits, d * 9, 0, 9, 13, DIGIT_X[i], 26));
    }
    // play / pause / stop indicator, and the stereo lamp
    this.blit("playpaus", playing ? 0 : s.status === "Paused" && s.running ? 9 : 18, 0, 9, 9, 26, 28);
    this.blit("monoster", 0, active ? 0 : 12, 29, 12, 239, 41);
    this.blit("monoster", 29, 12, 27, 12, 212, 41);

    this.drawTitle();
    this.drawAnalyzer(playing);

    // volume: the slider's background frame, then the thumb
    const vol = Math.max(0, Math.min(1, s.volume));
    this.blit("volume", 0, volumeFrame(vol) * 15, VOL.w, VOL.h, VOL.x, VOL.y);
    this.blit("volume", this.drag?.kind === "vol" ? 0 : 15, 422, THUMB, 11, VOL.x + Math.round(vol * (VOL.w - THUMB)), VOL.y + 1);
    // balance is not supported by the players: always centred (its frames start at x=9 in balance.bmp)
    this.blit("balance", 9, 0, BAL.w, BAL.h, BAL.x, BAL.y);
    this.blit("balance", 15, 422, THUMB, 11, BAL.x + (BAL.w - THUMB) / 2, BAL.y + 1);

    // seek bar
    this.blit("posbar", 0, 0, SEEK.w, SEEK.h, SEEK.x, SEEK.y);
    if (active && s.length_s > 0) {
      const frac = this.drag?.kind === "seek" ? this.seekFrac : Math.min(1, this.player.position / s.length_s);
      this.blit("posbar", this.drag?.kind === "seek" ? 278 : 248, 0, SEEK_THUMB, SEEK.h, SEEK.x + Math.round(frac * (SEEK.w - SEEK_THUMB)), SEEK.y);
    }
    this.drawButtons("main");
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
    const bars = this.player.bars;
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

  /** The equalizer window (eqmain.bmp). Its sliders move, but nothing in the players can use them. */
  private drawEq() {
    if (this.sheets.has("eqmain")) {
      this.blit("eqmain", 0, 0, W, EQ_H, 0, 0);
      this.blit("eqmain", 0, 134, W, 14, 0, 0);
    } else {
      this.g.fillStyle = this.plStyle.normalBg;
      this.g.fillRect(0, 0, W, EQ_H);
    }
    if (!((this.sheets.get("eqmain")?.height ?? 0) >= 315)) return this.drawEqFallback();
    this.drawButtons("eq");
    if (this.pressed === "eq-close") this.blit("eqmain", 0, 125, 9, 9, 264, 3);
    // the response curve through the ten bands, in the skin's own graph colours
    this.blit("eqmain", 0, 294, 113, 19, 86, 17);
    const img = this.sheets.get("eqmain");
    if (img) {
      this.eqValues.slice(1).forEach((v, i) => {
        const row = Math.max(0, Math.min(18, Math.round((1 - v / 100) * 18)));
        this.g.drawImage(img, 115, 294 + row, 1, 1, 86 + 6 + Math.round(i * 11.4), 17 + row, 2, 1);
      });
    }
    EQ_X.forEach((x, i) => {
      const v = this.eqValues[i];
      const frame = Math.round((v / 100) * 27);
      this.blit("eqmain", 13 + (frame % 14) * 15, 164 + Math.floor(frame / 14) * 65, EQ_SLIDER_W, EQ_SLIDER_H, x, EQ_SLIDER_Y);
      const dragging = this.drag?.kind === "eq" && this.drag.index === i;
      this.blit("eqmain", 0, dragging ? 176 : 164, 11, 11, x + 1, EQ_SLIDER_Y + Math.round((1 - v / 100) * (EQ_SLIDER_H - 11)));
    });
  }

  /**
   * Some skins only ship the equalizer's background (their eqmain.bmp is shorter than 315 px); Winamp
   * fills the missing sprites in from its default skin, which isn't available here, so draw plain
   * widgets in the skin's playlist colours instead.
   */
  private drawEqFallback() {
    const g = this.g;
    const st = this.plStyle;
    const label = (text: string, x: number, w: number, on: boolean) => {
      g.strokeStyle = st.normal;
      g.strokeRect(x + 0.5, 18.5, w - 1, 11);
      if (on) { g.fillStyle = st.normal; g.fillRect(x + 1, 19, w - 2, 10); }
      this.drawText(text, x + Math.floor((w - text.length * FONT_W) / 2), 21);
    };
    label("ON", 14, 26, this.eqOn);
    label("AUTO", 39, 32, this.eqAuto);
    EQ_X.forEach((x, i) => {
      g.globalAlpha = 0.4;
      g.fillStyle = st.normal;
      g.fillRect(x + 6, EQ_SLIDER_Y, 2, EQ_SLIDER_H);
      g.globalAlpha = 1;
      g.fillStyle = this.drag?.kind === "eq" && this.drag.index === i ? st.current : st.normal;
      g.fillRect(x + 1, EQ_SLIDER_Y + Math.round((1 - this.eqValues[i] / 100) * (EQ_SLIDER_H - 5)), 12, 5);
    });
  }

  /** The playlist window: the frame from pledit.bmp (or a flat one if the skin lacks it) and the track list. */
  private drawPlaylist() {
    const g = this.g;
    const st = this.plStyle;
    if (this.sheets.has("pledit")) {
      // top: corners, the title, and tiles filling the gaps
      const tile = (x0: number, x1: number) => {
        for (let x = x0; x < x1; x += 25) this.blit("pledit", 127, 0, Math.min(25, x1 - x), 20, x, 0);
      };
      tile(25, 87);
      tile(187, W - 25);
      this.blit("pledit", 0, 0, 25, 20, 0, 0);
      this.blit("pledit", 26, 0, 100, 20, 87, 0);
      this.blit("pledit", 153, 0, 25, 20, W - 25, 0);
      // sides
      for (let y = 20; y < PL_H - 38; y += 29) {
        const h = Math.min(29, PL_H - 38 - y);
        this.blit("pledit", 0, 42, 12, h, 0, y);
        this.blit("pledit", 31, 42, 20, h, W - 20, y);
      }
      // bottom
      for (let x = 125; x < W - 150; x += 25) this.blit("pledit", 179, 0, Math.min(25, W - 150 - x), 38, x, PL_H - 38);
      this.blit("pledit", 0, 72, 125, 38, 0, PL_H - 38);
      this.blit("pledit", 126, 72, 150, 38, W - 150, PL_H - 38);
    } else {
      g.fillStyle = st.normalBg;
      g.fillRect(0, 0, W, PL_H);
      g.strokeStyle = st.normal;
      g.strokeRect(0.5, 0.5, W - 1, PL_H - 1);
      this.drawText("PLAYLIST EDITOR", 87, 7);
    }
    if (this.pressed === "pl-close") this.blit("pledit", 52, 42, 9, 9, W - 11, 3);

    // the list
    g.fillStyle = st.normalBg;
    g.fillRect(PL_LIST.x, PL_LIST.y, PL_LIST.w, PL_LIST.h);
    const rows = this.rows();
    this.plScroll = Math.min(this.plScroll, this.maxScroll());
    g.save();
    g.beginPath();
    g.rect(PL_LIST.x, PL_LIST.y, PL_LIST.w, PL_LIST.h);
    g.clip();
    g.font = `9px "${st.font}", Arial, sans-serif`;
    g.textBaseline = "middle";
    for (let r = 0; r < this.visibleRows; r++) {
      const row = rows[this.plScroll + r];
      if (!row) break;
      const y = PL_LIST.y + r * ROW_H;
      if (this.plScroll + r === this.plSelected) { g.fillStyle = st.selectedBg; g.fillRect(PL_LIST.x, y, PL_LIST.w, ROW_H); }
      g.fillStyle = row.current ? st.current : st.normal;
      const timeW = row.time ? g.measureText(row.time).width + 6 : 0;
      g.save();
      g.beginPath();
      g.rect(PL_LIST.x, y, PL_LIST.w - timeW, ROW_H);
      g.clip();
      g.fillText(row.text, PL_LIST.x + 2, y + ROW_H / 2 + 0.5);
      g.restore();
      if (row.time) { g.textAlign = "right"; g.fillText(row.time, PL_LIST.x + PL_LIST.w - 2, y + ROW_H / 2 + 0.5); g.textAlign = "left"; }
    }
    g.restore();
    // the scroll handle runs along the right edge
    const max = this.maxScroll();
    const handleY = PL_LIST.y + (max ? Math.round((this.plScroll / max) * (PL_LIST.h - 18)) : 0);
    if (this.sheets.has("pledit")) this.blit("pledit", this.drag?.kind === "scroll" ? 61 : 52, 53, 8, 18, W - 15, handleY);
    this.drawButtons("pl");
  }
}
