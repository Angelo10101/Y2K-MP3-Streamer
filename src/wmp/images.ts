// Decoding skin bitmaps (BMP/GIF/JPG/PNG) into canvases, with colour-key transparency.
import { decodeGif, type Gif } from "./gif";
import type { Skin } from "./skin";

export type RGB = [number, number, number];

export function parseColor(s: string | undefined): RGB | null {
  if (!s) return null;
  const m = /^\s*#?([0-9a-f]{6})\s*$/i.exec(s) ?? /^\s*#([0-9a-f]{3})\s*$/i.exec(s);
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = [...h].map((c) => c + c).join("");
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const MIME: Record<string, string> = { bmp: "image/bmp", png: "image/png", gif: "image/gif", jpg: "image/jpeg", jpeg: "image/jpeg" };

/** Decoded images kept around, in pixels (about 120 MB of RGBA). */
const CACHE_PIXELS = 30_000_000;

/** A GIF being played: frames are drawn onto `canvas` on a timer (see `ImageStore.tick`). */
interface Animated { gif: Gif; canvas: HTMLCanvasElement; keys: RGB[]; index: number; nextAt: number; loopsLeft: number; done: boolean }

export class ImageStore {
  private cache = new Map<string, Promise<HTMLCanvasElement | null>>();
  private animated: Animated[] = [];
  private sizes = new Map<string, number>();
  private pixels = 0;
  private lastTick = 0;
  /** Canvases that are redrawn by `tick()` and so must not be copied. */
  isAnimated(c: HTMLCanvasElement) { return this.animated.some((a) => a.canvas === c); }

  dispose() { this.animated = []; }

  /** Advances animated GIFs (call from a rAF loop). Non-looping GIFs stop on their last frame. */
  tick(now: number) {
    for (const a of this.animated) {
      if (a.done) continue;
      if (a.nextAt === 0) a.nextAt = now + a.gif.frames[0].delayMs;
      let advanced = false;
      while (!a.done && now >= a.nextAt) {
        if (a.index + 1 >= a.gif.frames.length) {
          if (a.gif.loops === 0 || a.loopsLeft > 1) { a.index = 0; if (a.gif.loops !== 0) a.loopsLeft--; }
          else { a.done = true; break; }
        } else a.index++;
        a.nextAt += a.gif.frames[a.index].delayMs;
        advanced = true;
      }
      if (advanced) drawGifFrame(a);
    }
  }

  constructor(private skin: Skin) {}

  /** Loads `path` from the archive; pixels equal to `key` become transparent. */
  load(path: string | undefined, keys?: RGB | (RGB | null)[] | null): Promise<HTMLCanvasElement | null> {
    if (!path) return Promise.resolve(null);
    const key: RGB[] = !keys ? [] : typeof keys[0] === "number" ? [keys as RGB] : (keys as (RGB | null)[]).filter((k): k is RGB => !!k);
    const id = `${path.toLowerCase()}|${key.map((k) => k.join(",")).join(";")}`;
    let p = this.cache.get(id);
    if (!p) {
      p = this.decode(path, key);
      this.cache.set(id, p);
      // frame-by-frame animations load hundreds of images: keep the cache bounded (oldest first)
      void p.then((c) => {
        if (!c || !this.cache.has(id)) return;
        this.sizes.set(id, c.width * c.height);
        this.pixels += c.width * c.height;
        for (const k of this.cache.keys()) {
          if (this.pixels <= CACHE_PIXELS) break;
          if (k === id || !this.sizes.has(k)) continue;
          this.pixels -= this.sizes.get(k)!; this.sizes.delete(k); this.cache.delete(k);
        }
      });
    }
    return p;
  }

  private async decode(path: string, keys: RGB[]): Promise<HTMLCanvasElement | null> {
    const bytes = this.skin.file(path);
    if (!bytes) { console.warn(`[skin] missing image ${path}`); return null; }
    const ext = path.split(".").pop()!.toLowerCase();
    if (ext === "gif") {
      const gif = decodeGif(bytes);
      if (gif && gif.frames.length > 1) {
        const canvas = document.createElement("canvas");
        canvas.width = gif.width; canvas.height = gif.height;
        const a: Animated = { gif, canvas, keys, index: 0, nextAt: 0, loopsLeft: gif.loops || 1, done: false };
        drawGifFrame(a);
        this.animated.push(a);
        return canvas;
      }
    }
    const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: MIME[ext] ?? "application/octet-stream" }));
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      const c = document.createElement("canvas");
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      paintImage(c, img, keys);
      return c;
    } catch (e) {
      console.warn(`[skin] cannot decode ${path}`, e);
      return null;
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}

/** Draws `img` onto `c`, making every pixel equal to one of `keys` transparent. */
function paintImage(c: HTMLCanvasElement, img: HTMLImageElement, keys: RGB[]) {
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  ctx.clearRect(0, 0, c.width, c.height);
  ctx.drawImage(img, 0, 0);
  if (!keys.length) return;
  const d = ctx.getImageData(0, 0, c.width, c.height);
  for (let i = 0; i < d.data.length; i += 4) {
    for (const key of keys) {
      if (d.data[i] === key[0] && d.data[i + 1] === key[1] && d.data[i + 2] === key[2]) { d.data[i + 3] = 0; break; }
    }
  }
  ctx.putImageData(d, 0, 0);
}

function drawGifFrame(a: Animated) {
  const f = a.gif.frames[a.index];
  const data = new Uint8ClampedArray(f.rgba);
  for (let i = 0; i < data.length; i += 4) {
    for (const k of a.keys) {
      if (data[i] === k[0] && data[i + 1] === k[1] && data[i + 2] === k[2]) { data[i + 3] = 0; break; }
    }
  }
  a.canvas.getContext("2d")!.putImageData(new ImageData(data, a.gif.width, a.gif.height), 0, 0);
}
