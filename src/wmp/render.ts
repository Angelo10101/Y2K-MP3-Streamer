// Renders a parsed WMS <view> into the DOM and wires it to the player shim.
// Supported subset: view/subview, buttonelement/button/buttongroup (mappingImage hit-testing),
// slider/customslider, text, effects (cava bars), playlist. Everything else is created as
// an inert placeholder so scripts that reference it by id keep working.
import { ImageStore, parseColor, type RGB } from "./images";
import type { PlayerShim } from "./player";
import { fmtTime } from "./player";
import { Scope } from "./scope";
import type { Skin } from "./skin";
import type { WmsNode } from "./xml";

export interface WindowHooks {
  resize(w: number, h: number): void;
  setAlwaysOnTop(on: boolean): void;
  minimize(): void;
  close(): void;
  startDrag(): void;
  setShape(rects: number[][]): void;
}

const num = (v: unknown, d = 0) => { const n = parseFloat(String(v)); return Number.isFinite(n) ? n : d; };
const truthy = (v: unknown, d = true) => (v === undefined || v === "" ? d : !/^(false|0|no)$/i.test(String(v)));
const BINDING = /^\s*(wmpprop|wmpenabled|wmpdisabled)\s*:(.*)$/i;
const BOOL_KEYS = new Set(["visible", "enabled", "tiled", "scrolling", "wordwrap", "allowall", "toggle"]);
const NUM_KEYS = new Set(["left", "top", "width", "height", "zindex", "alphablend", "min", "max", "value", "bordersize", "fontsize"]);

class El {
  attrs: Record<string, string>;
  dom = document.createElement("div");
  canvas?: HTMLCanvasElement;
  kids: El[] = [];
  hover = false;
  down = false;
  dragging = false;
  lastSig = "";
  api!: Record<string, unknown>;
  /** per-type hooks */
  paint: () => void = () => {};
  constructor(public node: WmsNode, public parent: El | null) {
    this.attrs = { ...node.attrs };
    this.dom.className = "skin-el";
  }
  get tag() { return this.node.tag; }
  get id() { return this.attrs.id ?? ""; }
}

export class SkinWindow {
  readonly scope = new Scope();
  private images: ImageStore;
  private root!: HTMLDivElement;
  private all: El[] = [];
  private viewEl!: El;
  private timers: number[] = [];
  private shapeTimer = 0;
  private raf = 0;
  private unsupported = new Set<string>();
  private disposed = false;
  private viewTimer = 0;

  constructor(private skin: Skin, private view: WmsNode, private player: PlayerShim, private host: HTMLElement, private hooks: WindowHooks) {
    this.images = new ImageStore(skin);
  }

  // ---------- lifecycle ----------
  async mount() {
    const v = this.view.attrs;
    const w = num(v.width, 400), h = num(v.height, 300);
    this.root = document.createElement("div");
    this.root.id = "skin-root";
    Object.assign(this.root.style, { position: "relative", width: `${w}px`, height: `${h}px`, overflow: "hidden" });
    this.host.replaceChildren(this.root);
    this.hooks.resize(w, h);

    this.viewEl = new El(this.view, null);
    this.viewEl.dom = this.root as HTMLDivElement;
    this.installGlobals(w, h);
    await this.paintView(this.viewEl);
    for (const c of this.view.children) await this.build(c, this.viewEl);
    this.installPlayerEvents();

    // theme/view script file, then onload handlers
    const sf = v.scriptfile ?? this.skin.theme.attrs.scriptfile;
    const src = sf ? this.skin.text(sf) : undefined;
    if (sf && src === undefined) console.warn(`[skin] script ${sf} not found`);
    if (src) this.scope.run(src, sf);
    for (const key of ["onload"]) {
      if (v[key]) this.scope.run(v[key], "view.onload");
    }
    this.scope.call("view_onload");
    this.sync(true);

    this.root.addEventListener("pointerdown", (e) => { if (e.button === 0) this.hooks.startDrag(); });
    this.timers.push(window.setInterval(() => this.sync(false), 100));
    const loop = () => { this.drawEffects(); this.raf = requestAnimationFrame(loop); };
    loop();
    this.scheduleShape(50);
  }

  dispose() {
    this.disposed = true;
    this.timers.forEach(clearInterval);
    clearInterval(this.viewTimer);
    cancelAnimationFrame(this.raf);
    clearTimeout(this.shapeTimer);
    this.scope.dispose();
    this.root?.remove();
  }

  private installGlobals(w: number, h: number) {
    const s = this.scope.store;
    const self = this;
    s.player = this.player.api;
    s.view = {
      get width() { return w; }, get height() { return h; },
      set width(v: number) { w = num(v); self.resizeView(w, h); },
      set height(v: number) { h = num(v); self.resizeView(w, h); },
      get alwaysOnTop() { return self.alwaysOnTop; },
      set alwaysOnTop(v: boolean) { self.alwaysOnTop = !!v; self.hooks.setAlwaysOnTop(!!v); },
      close: () => this.hooks.close(),
      minimize: () => this.hooks.minimize(),
      maximize: () => {}, restore: () => {},
      get timerInterval() { return self.viewTimerMs; },
      set timerInterval(ms: number) { self.setViewTimer(num(ms)); },
      currentViewMode: 0, title: this.skin.theme.attrs.title ?? this.skin.name,
      setTimer: (_id: unknown, ms: number) => self.setViewTimer(ms),
      resizeTo: (nw: number, nh: number) => self.resizeView(nw, nh),
      returnToMediaCenter: () => {}, dispatch: () => {},
    };
    s.theme = {
      get currentViewID() { return self.view.attrs.id ?? ""; },
      openView: () => {}, loadPreset: () => {}, savePreset: () => {}, close: () => this.hooks.close(),
    };
    s.alert = (m: unknown) => console.info("[skin alert]", m);
  }
  private alwaysOnTop = false;
  private viewTimerMs = 0;
  private setViewTimer(ms: number) {
    this.viewTimerMs = ms;
    clearInterval(this.viewTimer);
    if (ms > 0) {
      this.viewTimer = window.setInterval(() => {
        if (this.view.attrs.ontimer) this.scope.run(this.view.attrs.ontimer, "ontimer");
        this.scope.call("view_onTimer");
        this.scope.call("onTimer");
      }, ms);
    }
  }
  private resizeView(w: number, h: number) {
    Object.assign(this.root.style, { width: `${w}px`, height: `${h}px` });
    this.hooks.resize(w, h);
    this.scheduleShape();
  }

  private installPlayerEvents() {
    this.player.onEvent((ev, arg) => {
      const attr = `on${ev}`;
      for (const el of [this.viewEl, ...this.all]) if (el.attrs[attr]) this.scope.run(el.attrs[attr], attr);
      this.scope.call(attr, arg);
      this.scope.call(`player_${attr}`, arg);
      this.sync(true);
    });
  }

  // ---------- building ----------
  private async paintView(el: El) {
    const v = this.view.attrs;
    const w = num(v.width, 400), h = num(v.height, 300);
    const clip = parseColor(v.clippingcolor);
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const ctx = c.getContext("2d")!;
    if (v.backgroundcolor && !clip) { ctx.fillStyle = v.backgroundcolor; ctx.fillRect(0, 0, w, h); }
    const bg = await this.images.load(v.backgroundimage, clip);
    if (bg) ctx.drawImage(bg, 0, 0);
    if (v.clippingimage) {
      // clippingImage: pixels of the clipping colour mark transparent regions of the window
      const mask = await this.images.load(v.clippingimage, clip);
      if (mask) {
        const m = document.createElement("canvas");
        m.width = w; m.height = h;
        m.getContext("2d")!.drawImage(mask, 0, 0);
        ctx.globalCompositeOperation = "destination-in";
        ctx.drawImage(m, 0, 0);
        ctx.globalCompositeOperation = "source-over";
      }
    }
    c.style.cssText = "position:absolute;left:0;top:0";
    el.canvas = c;
    this.root.prepend(c);
  }

  private read(el: El, name: string): string | undefined {
    const raw = el.attrs[name];
    if (raw === undefined) return undefined;
    const m = BINDING.exec(raw);
    if (!m) return raw;
    const expr = m[2].trim();
    switch (m[1].toLowerCase()) {
      case "wmpprop": { const r = this.scope.eval(expr); return r === undefined || r === null ? "" : String(r); }
      case "wmpenabled": return String(this.feature(expr));
      default: return String(!this.feature(expr));
    }
  }
  private feature(expr: string): boolean {
    const last = expr.split(".").pop()!.toLowerCase();
    return !!this.scope.eval(`player.controls.isAvailable("${last}")`);
  }
  private n(el: El, name: string, d = 0) { return num(this.read(el, name), d); }

  private async build(node: WmsNode, parent: El) {
    const el = new El(node, parent);
    parent.kids.push(el);
    this.all.push(el);
    parent.dom.appendChild(el.dom);
    this.makeApi(el);
    if (el.id) this.scope.store[el.id] = el.api;

    switch (node.tag) {
      case "subview": await this.buildSubview(el); break;
      case "buttongroup": await this.buildButtonGroup(el); break;
      case "buttonelement": case "button": await this.buildButton(el); break;
      case "slider": case "customslider": await this.buildSlider(el); break;
      case "text": this.buildText(el); break;
      case "effects": this.buildEffects(el); break;
      case "playlist": this.buildPlaylist(el); break;
      default:
        if (!this.unsupported.has(node.tag)) { this.unsupported.add(node.tag); console.info(`[skin] <${node.tag}> not supported; created as placeholder`); }
        this.layout(el);
        el.dom.style.display = "none";
    }
    if (node.tag !== "buttongroup" && node.tag !== "subview") for (const c of node.children) await this.build(c, el);
  }

  private layout(el: El) {
    const d = el.dom.style;
    const vis = truthy(this.read(el, "visible"), true);
    d.left = `${this.n(el, "left")}px`;
    d.top = `${this.n(el, "top")}px`;
    const w = this.n(el, "width", NaN), h = this.n(el, "height", NaN);
    if (!isNaN(w)) d.width = `${w}px`;
    if (!isNaN(h)) d.height = `${h}px`;
    d.display = vis ? "" : "none";
    const z = el.attrs.zindex; if (z !== undefined) d.zIndex = String(num(z));
    const a = el.attrs.alphablend; if (a !== undefined) d.opacity = String(Math.max(0, Math.min(1, num(a, 255) / 255)));
  }

  private async buildSubview(el: El) {
    this.layout(el);
    const a = el.attrs;
    if (a.backgroundcolor) el.dom.style.background = a.backgroundcolor;
    const bg = await this.images.load(a.backgroundimage, parseColor(a.transparencycolor));
    if (bg) {
      el.canvas = this.cloneCanvas(bg);
      el.canvas.style.cssText = "position:absolute;left:0;top:0";
      el.dom.prepend(el.canvas);
      if (!a.width) el.dom.style.width = `${bg.width}px`;
      if (!a.height) el.dom.style.height = `${bg.height}px`;
    }
    this.wireMouse(el, el.dom);
    for (const c of el.node.children) await this.build(c, el);
  }

  private cloneCanvas(src: HTMLCanvasElement) {
    const c = document.createElement("canvas");
    c.width = src.width; c.height = src.height;
    c.getContext("2d")!.drawImage(src, 0, 0);
    return c;
  }

  private stateImages(el: El, over: Record<string, string> = el.attrs) {
    const key = parseColor(el.attrs.transparencycolor);
    return Promise.all(["image", "hoverimage", "downimage", "disabledimage"].map((k) => this.images.load(over[k], key)));
  }

  private alphaAt(c: HTMLCanvasElement, x: number, y: number) {
    if (x < 0 || y < 0 || x >= c.width || y >= c.height) return 0;
    return c.getContext("2d", { willReadFrequently: true })!.getImageData(x, y, 1, 1).data[3];
  }

  private async buildButton(el: El) {
    const [img, hov, down, dis] = await this.stateImages(el);
    const w = img?.width ?? this.n(el, "width"), h = img?.height ?? this.n(el, "height");
    el.dom.style.width = `${w}px`; el.dom.style.height = `${h}px`;
    this.layout(el);
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    el.canvas = c;
    el.dom.appendChild(c);
    el.paint = () => {
      const enabled = truthy(this.read(el, "enabled"), true);
      const pick = !enabled ? dis ?? img : el.down ? down ?? hov ?? img : el.hover ? hov ?? img : img;
      const ctx = c.getContext("2d")!;
      ctx.clearRect(0, 0, w, h);
      if (pick) ctx.drawImage(pick, 0, 0);
    };
    el.paint();
    el.dom.style.cursor = el.attrs.cursor === "hand" || el.attrs.onclick ? "pointer" : "";
    if (el.attrs.uptooltip) c.title = el.attrs.uptooltip;
    const hit = (e: PointerEvent) => { const r = c.getBoundingClientRect(); return this.alphaAt(c, Math.floor(e.clientX - r.left), Math.floor(e.clientY - r.top)) > 0; };
    c.addEventListener("pointermove", (e) => { const h2 = hit(e); if (h2 !== el.hover) { el.hover = h2; el.paint(); this.fire(el, h2 ? "onmouseover" : "onmouseout"); } });
    c.addEventListener("pointerleave", () => { if (el.hover) { el.hover = false; el.paint(); this.fire(el, "onmouseout"); } });
    c.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || !hit(e) || !truthy(this.read(el, "enabled"), true)) return;
      e.stopPropagation(); c.setPointerCapture(e.pointerId);
      el.down = true; el.paint(); this.fire(el, "onmousedown");
    });
    c.addEventListener("pointerup", (e) => {
      if (!el.down) return;
      el.down = false; el.paint(); this.fire(el, "onmouseup");
      if (hit(e)) { this.fire(el, "onclick"); this.sync(true); }
    });
  }

  private async buildButtonGroup(el: El) {
    this.layout(el);
    const [img, hov, down, dis] = await this.stateImages(el);
    const mapImg = await this.images.load(el.attrs.mappingimage, null);
    const w = img?.width ?? mapImg?.width ?? this.n(el, "width"), h = img?.height ?? mapImg?.height ?? this.n(el, "height");
    el.dom.style.width = `${w}px`; el.dom.style.height = `${h}px`;
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    el.canvas = c; el.dom.appendChild(c);

    const kids: { el: El; rgb: RGB; mask: HTMLCanvasElement | null }[] = [];
    const mapData = mapImg?.getContext("2d", { willReadFrequently: true })!.getImageData(0, 0, mapImg.width, mapImg.height);
    for (const n of el.node.children) {
      if (n.tag !== "buttonelement") continue;
      const k = new El(n, el);
      this.all.push(k); el.kids.push(k);
      this.makeApi(k);
      if (k.id) this.scope.store[k.id] = k.api;
      const rgb = parseColor(n.attrs.mappingcolor);
      kids.push({ el: k, rgb: rgb ?? [-1, -1, -1], mask: null });
    }
    const maskFor = (k: (typeof kids)[number]) => {
      if (k.mask || !mapData || !mapImg) return k.mask;
      const m = document.createElement("canvas"); m.width = mapImg.width; m.height = mapImg.height;
      const mc = m.getContext("2d")!; const o = mc.createImageData(m.width, m.height);
      for (let i = 0; i < mapData.data.length; i += 4)
        if (mapData.data[i] === k.rgb[0] && mapData.data[i + 1] === k.rgb[1] && mapData.data[i + 2] === k.rgb[2]) o.data.set([255, 255, 255, 255], i);
      mc.putImageData(o, 0, 0);
      return (k.mask = m);
    };
    const at = (x: number, y: number) => {
      if (!mapData || x < 0 || y < 0 || x >= mapData.width || y >= mapData.height) return undefined;
      const i = (y * mapData.width + x) * 4;
      return kids.find((k) => k.rgb[0] === mapData.data[i] && k.rgb[1] === mapData.data[i + 1] && k.rgb[2] === mapData.data[i + 2]);
    };
    const tmp = document.createElement("canvas"); tmp.width = w; tmp.height = h;
    el.paint = () => {
      const ctx = c.getContext("2d")!;
      ctx.clearRect(0, 0, w, h);
      if (img) ctx.drawImage(img, 0, 0);
      for (const k of kids) {
        const enabled = truthy(this.read(k.el, "enabled"), true);
        const state = !enabled ? dis : k.el.down ? down ?? hov : k.el.hover ? hov : null;
        const mask = state && maskFor(k);
        if (!state || !mask) continue;
        const t = tmp.getContext("2d")!;
        t.clearRect(0, 0, w, h); t.globalCompositeOperation = "source-over"; t.drawImage(state, 0, 0);
        t.globalCompositeOperation = "destination-in"; t.drawImage(mask, 0, 0);
        ctx.drawImage(tmp, 0, 0);
      }
    };
    el.paint();

    let cur: (typeof kids)[number] | undefined;
    const pos = (e: PointerEvent) => { const r = c.getBoundingClientRect(); return [Math.floor(e.clientX - r.left), Math.floor(e.clientY - r.top)] as const; };
    const setHover = (k: typeof cur) => {
      if (k === cur) return;
      if (cur) { cur.el.hover = false; this.fire(cur.el, "onmouseout"); }
      cur = k;
      if (cur) { cur.el.hover = true; this.fire(cur.el, "onmouseover"); }
      c.style.cursor = cur ? "pointer" : "";
      c.title = cur?.el.attrs.uptooltip ?? "";
      el.paint();
    };
    c.addEventListener("pointermove", (e) => setHover(at(...pos(e))));
    c.addEventListener("pointerleave", () => { if (!cur?.el.down) setHover(undefined); });
    c.addEventListener("pointerdown", (e) => {
      const k = at(...pos(e));
      if (e.button !== 0 || !k || !truthy(this.read(k.el, "enabled"), true)) return;
      e.stopPropagation(); c.setPointerCapture(e.pointerId);
      cur = k; k.el.down = true; k.el.hover = true; el.paint(); this.fire(k.el, "onmousedown");
    });
    c.addEventListener("pointerup", (e) => {
      const k = cur;
      if (!k?.el.down) return;
      k.el.down = false; this.fire(k.el, "onmouseup");
      const over = at(...pos(e));
      if (over === k) { this.fire(k.el, "onclick"); this.sync(true); }
      else setHover(over);
      el.paint();
    });
  }

  private async buildSlider(el: El) {
    const a = el.attrs;
    const key = parseColor(a.transparencycolor);
    const [track, fore, pos, thumb, thumbHover, thumbDown] = await Promise.all(
      ["image", "foregroundimage", "positionimage", "thumbimage", "thumbhoverimage", "thumbdownimage"].map((k) => this.images.load(a[k], key)),
    );
    const w = this.n(el, "width", track?.width ?? 100), h = this.n(el, "height", track?.height ?? 20);
    el.attrs.width = String(w); el.attrs.height = String(h);
    this.layout(el);
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    el.canvas = c; el.dom.appendChild(c);
    const vertical = /vertical/i.test(a.direction ?? "");
    const border = num(a.bordersize, 0);
    const frac = () => {
      const min = this.n(el, "min", 0), max = this.n(el, "max", 100), v = this.n(el, "value", min);
      return max > min ? Math.max(0, Math.min(1, (v - min) / (max - min))) : 0;
    };
    el.paint = () => {
      const ctx = c.getContext("2d")!;
      ctx.clearRect(0, 0, w, h);
      if (track) ctx.drawImage(track, 0, 0, w, h);
      const f = frac();
      for (const strip of [fore, pos]) {
        if (!strip) continue;
        ctx.save(); ctx.beginPath();
        if (vertical) ctx.rect(0, h * (1 - f), w, h * f); else ctx.rect(0, 0, w * f, h);
        ctx.clip(); ctx.drawImage(strip, 0, 0, w, h); ctx.restore();
      }
      const t = el.dragging ? thumbDown ?? thumb : el.hover ? thumbHover ?? thumb : thumb;
      if (t) {
        const tl = vertical ? t.height : t.width;
        const travel = (vertical ? h : w) - tl - 2 * border;
        const p = border + (vertical ? (1 - f) : f) * Math.max(0, travel);
        if (vertical) ctx.drawImage(t, Math.round((w - t.width) / 2), Math.round(p));
        else ctx.drawImage(t, Math.round(p), Math.round((h - t.height) / 2));
      }
    };
    el.paint();
    const valueAt = (e: PointerEvent) => {
      const r = c.getBoundingClientRect();
      const tl = thumb ? (vertical ? thumb.height : thumb.width) : 0;
      const len = vertical ? h : w;
      const travel = Math.max(1, len - tl - 2 * border);
      const p = (vertical ? e.clientY - r.top : e.clientX - r.left) - border - tl / 2;
      let t = Math.max(0, Math.min(1, p / travel));
      if (vertical) t = 1 - t;
      const min = this.n(el, "min", 0), max = this.n(el, "max", 100);
      return min + t * (max - min);
    };
    const bound = BINDING.exec(a.value ?? "");
    const seekLike = !!bound && /currentposition/i.test(bound[2]);
    const commit = (v: number) => { if (bound?.[1].toLowerCase() === "wmpprop") this.scope.assign(bound[2].trim(), v); };
    c.style.cursor = "pointer";
    c.addEventListener("pointerenter", () => { el.hover = true; el.paint(); });
    c.addEventListener("pointerleave", () => { el.hover = false; el.paint(); });
    c.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || !truthy(this.read(el, "enabled"), true)) return;
      e.stopPropagation(); c.setPointerCapture(e.pointerId);
      el.dragging = true;
      this.fire(el, "onmousedown");
      move(e);
    });
    const move = (e: PointerEvent) => {
      if (!el.dragging) return;
      const v = valueAt(e);
      el.attrs.value = String(v);
      el.paint();
      if (!seekLike) commit(v);
      this.fire(el, "onchange");
    };
    c.addEventListener("pointermove", move);
    c.addEventListener("pointerup", (e) => {
      if (!el.dragging) return;
      move(e);
      el.dragging = false;
      if (seekLike) commit(num(el.attrs.value));
      // restore the live binding so the slider follows playback again
      if (bound) el.attrs.value = a.value;
      el.paint();
      this.fire(el, "onmouseup"); this.fire(el, "onendchange");
    });
    // when bound, `a.value` is the binding string: remember it
    if (bound) el.attrs.value = a.value;
  }

  private buildText(el: El) {
    this.layout(el);
    const span = document.createElement("span");
    el.dom.appendChild(span);
    el.dom.classList.add("skin-text");
    const a = el.attrs, d = el.dom.style;
    d.fontFamily = a.fontface ? `"${a.fontface}", sans-serif` : "sans-serif";
    d.fontSize = `${num(a.fontsize, 10)}pt`;
    d.color = a.foregroundcolor ?? "#fff";
    if (a.backgroundcolor) d.background = a.backgroundcolor;
    d.textAlign = (a.justification ?? "left").toLowerCase();
    const st = (a.fontstyle ?? "").toLowerCase();
    if (st.includes("bold")) d.fontWeight = "bold";
    if (st.includes("italic")) d.fontStyle = "italic";
    if (st.includes("underline")) d.textDecoration = "underline";
    if (!truthy(a.wordwrap, false)) d.whiteSpace = "nowrap";
    el.dom.style.cursor = a.onclick ? "pointer" : "default";
    let last = "\u0000";
    el.paint = () => {
      const v = this.read(el, "value") ?? "";
      if (v === last) return;
      last = v; span.textContent = v;
      // marquee when the text does not fit
      span.style.animation = "";
      if (truthy(a.scrolling, false) && span.scrollWidth > el.dom.clientWidth) {
        const dist = span.scrollWidth - el.dom.clientWidth;
        span.style.position = "relative";
        span.animate([{ left: "0px" }, { left: "0px", offset: 0.15 }, { left: `-${dist}px`, offset: 0.85 }, { left: `-${dist}px` }],
          { duration: Math.max(4000, dist * 40), iterations: Infinity, direction: "alternate" });
      }
    };
    el.paint();
    this.wireMouse(el, el.dom);
  }

  private buildEffects(el: El) {
    this.layout(el);
    const w = this.n(el, "width", 100), h = this.n(el, "height", 50);
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    el.canvas = c; el.dom.appendChild(c);
    el.paint = () => {
      const ctx = c.getContext("2d")!;
      ctx.clearRect(0, 0, w, h);
      if (el.attrs.backgroundcolor) { ctx.fillStyle = el.attrs.backgroundcolor; ctx.fillRect(0, 0, w, h); }
      const bars = this.player.bars.length ? this.player.bars : new Array(32).fill(0);
      ctx.fillStyle = el.attrs.foregroundcolor ?? "#4dff7a";
      if (/scope/i.test(el.attrs.type ?? "")) {
        ctx.strokeStyle = ctx.fillStyle; ctx.beginPath();
        bars.forEach((b, i) => { const x = (i / (bars.length - 1)) * w, y = h - (b / 100) * h; i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
        ctx.stroke();
      } else {
        const bw = w / bars.length;
        bars.forEach((b, i) => { const bh = Math.max(1, (b / 100) * h); ctx.fillRect(i * bw + 1, h - bh, Math.max(1, bw - 2), bh); });
      }
    };
    this.wireMouse(el, el.dom);
  }
  private drawEffects() {
    for (const el of this.all) if (el.tag === "effects" && el.dom.style.display !== "none") el.paint();
  }

  private buildPlaylist(el: El) {
    this.layout(el);
    const a = el.attrs, d = el.dom.style;
    d.overflow = "hidden";
    d.fontFamily = a.fontface ? `"${a.fontface}", sans-serif` : "sans-serif";
    d.fontSize = `${num(a.fontsize, 9)}pt`;
    d.color = a.foregroundcolor ?? "#fff";
    if (a.backgroundcolor) d.background = a.backgroundcolor;
    let last = "";
    el.paint = () => {
      const s = this.player.state;
      const sig = `${s.title}|${s.artist}|${s.length_s}|${s.running}`;
      if (sig === last) return;
      last = sig;
      el.dom.replaceChildren();
      const row = document.createElement("div");
      row.style.cssText = `display:flex;gap:6px;padding:1px 3px;background:${a.selectedcolor ?? a.selectedbackgroundcolor ?? "#ffffff22"}`;
      row.innerHTML = s.title
        ? `<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"></span><span></span>`
        : `<span style="opacity:.6">${s.running ? "Nothing playing" : "YouTube Music is not running"}</span>`;
      if (s.title) {
        (row.children[0] as HTMLElement).textContent = `1. ${s.title}${s.artist ? " - " + s.artist : ""}`;
        (row.children[1] as HTMLElement).textContent = fmtTime(s.length_s);
      }
      el.dom.appendChild(row);
    };
    el.paint();
  }

  // ---------- events / script access ----------
  private fire(el: El, ev: string) {
    const code = el.attrs[ev];
    if (code) this.scope.run(code, `${el.id || el.tag}.${ev}`);
    this.scope.call(`${el.id}_${ev}`);
  }

  private wireMouse(el: El, target: HTMLElement) {
    if (!(el.attrs.onclick || el.attrs.onmouseover || el.attrs.onmousedown)) return;
    target.addEventListener("pointerdown", (e) => { if (e.button === 0 && (el.attrs.onclick || el.attrs.onmousedown)) { e.stopPropagation(); this.fire(el, "onmousedown"); } });
    target.addEventListener("click", () => { this.fire(el, "onclick"); this.sync(true); });
    target.addEventListener("pointerenter", () => this.fire(el, "onmouseover"));
    target.addEventListener("pointerleave", () => this.fire(el, "onmouseout"));
  }

  /** The object skin scripts see for an element id. */
  private makeApi(el: El) {
    const self = this;
    const relayout = () => { self.layout(el); el.paint(); self.scheduleShape(); };
    const tween = (props: Record<string, string>, sec: number) => {
      const d = el.dom.style;
      d.transition = Object.keys(props).map((p) => `${p} ${Math.max(0, sec)}s linear`).join(",");
      requestAnimationFrame(() => Object.assign(d, props));
      self.scheduleShape(Math.max(0, sec) * 1000 + 120);
      self.scheduleShape(60);
    };
    el.api = new Proxy({} as Record<string, unknown>, {
      get(_t, k) {
        if (typeof k !== "string") return undefined;
        const key = k.toLowerCase();
        switch (key) {
          case "moveto": return (x: number, y: number, sec = 0) => {
            el.attrs.left = String(x); el.attrs.top = String(y);
            tween({ left: `${x}px`, top: `${y}px` }, num(sec));
          };
          case "alphablendto": return (a: number, sec = 0) => {
            el.attrs.alphablend = String(a);
            tween({ opacity: String(Math.max(0, Math.min(1, num(a) / 255))) }, num(sec));
          };
          case "jscript": case "onclick": return () => self.fire(el, "onclick");
          case "parent": return el.parent?.api;
          case "tagname": return el.tag;
          case "hovered": return el.hover;
        }
        const v = self.read(el, key);
        if (v === undefined) return key === "visible" || key === "enabled" ? true : undefined;
        if (BOOL_KEYS.has(key)) return truthy(v);
        if (NUM_KEYS.has(key) || /^-?\d+(\.\d+)?$/.test(v)) return num(v);
        return v;
      },
      set(_t, k, v) {
        if (typeof k !== "string") return true;
        const key = k.toLowerCase();
        el.attrs[key] = typeof v === "boolean" ? String(v) : String(v);
        if (["left", "top", "width", "height", "visible", "zindex", "alphablend"].includes(key)) {
          el.dom.style.transition = "";
          relayout();
        } else if (el.tag === "buttongroup" || key === "enabled") el.paint();
        else el.paint();
        return true;
      },
    });
  }

  // ---------- periodic refresh of bound attributes ----------
  private sync(force: boolean) {
    if (this.disposed) return;
    for (const el of this.all) {
      if (el.dragging) continue;
      let sig = "";
      for (const k of ["value", "min", "max", "enabled", "visible", "left", "top"]) {
        if (el.attrs[k] !== undefined && BINDING.test(el.attrs[k])) sig += `${k}=${this.read(el, k)};`;
      }
      if (el.tag === "playlist" || el.tag === "text") sig += "-";
      if (!sig && !(force && el.attrs.enabled !== undefined)) continue;
      if (el.tag === "text" || el.tag === "playlist") { el.paint(); continue; }
      if (sig === el.lastSig && !force) continue;
      el.lastSig = sig;
      this.layout(el);
      el.paint();
    }
  }

  // ---------- window shape ----------
  scheduleShape(ms = 150) {
    clearTimeout(this.shapeTimer);
    this.shapeTimer = window.setTimeout(() => !this.disposed && this.hooks.setShape(this.computeShape()), ms);
  }

  /** Union of everything painted, as `[x, y, w, h]` rectangles (input region). */
  private computeShape(): number[][] {
    const W = Math.round(this.n(this.viewEl, "width", 400)), H = Math.round(this.n(this.viewEl, "height", 300));
    const off = document.createElement("canvas");
    off.width = W; off.height = H;
    const ctx = off.getContext("2d", { willReadFrequently: true })!;
    const origin = this.root.getBoundingClientRect();
    const visit = (e: El) => {
      if (e.dom.style.display === "none") return;
      const r = (e.dom === this.root ? this.root : e.dom).getBoundingClientRect();
      const op = parseFloat(e.dom.style.opacity || "1");
      if (op <= 0.01) return;
      if (e.canvas) ctx.drawImage(e.canvas, e.canvas.getBoundingClientRect().left - origin.left, e.canvas.getBoundingClientRect().top - origin.top);
      else if (e !== this.viewEl && (e.tag === "text" || e.tag === "playlist" || e.tag === "effects")) ctx.fillRect(r.left - origin.left, r.top - origin.top, r.width, r.height);
      else if (e.tag === "subview" && e.attrs.backgroundcolor) ctx.fillRect(r.left - origin.left, r.top - origin.top, r.width, r.height);
      e.kids.forEach(visit);
    };
    visit(this.viewEl);
    const data = ctx.getImageData(0, 0, W, H).data;
    const out: number[][] = [];
    let prevKey = "";
    // row run-length encode, merge identical consecutive rows
    const rows: { key: string; runs: [number, number][]; y: number; h: number }[] = [];
    for (let y = 0; y < H; y++) {
      const runs: [number, number][] = [];
      let x0 = -1;
      for (let x = 0; x <= W; x++) {
        const on = x < W && data[(y * W + x) * 4 + 3] > 0;
        if (on && x0 < 0) x0 = x;
        else if (!on && x0 >= 0) { runs.push([x0, x - x0]); x0 = -1; }
      }
      const key = runs.map((r) => r.join(":")).join(",");
      const last = rows[rows.length - 1];
      if (last && last.key === key && key === prevKey) last.h++;
      else rows.push({ key, runs, y, h: 1 });
      prevKey = key;
    }
    for (const r of rows) for (const [x, w] of r.runs) out.push([x, r.y, w, r.h]);
    return out;
  }
}
