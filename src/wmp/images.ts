// Decoding skin bitmaps (BMP/GIF/JPG/PNG) into canvases, with colour-key transparency.
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

export class ImageStore {
  private cache = new Map<string, Promise<HTMLCanvasElement | null>>();
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
    }
    return p;
  }

  private async decode(path: string, keys: RGB[]): Promise<HTMLCanvasElement | null> {
    const bytes = this.skin.file(path);
    if (!bytes) { console.warn(`[skin] missing image ${path}`); return null; }
    const ext = path.split(".").pop()!.toLowerCase();
    const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: MIME[ext] ?? "application/octet-stream" }));
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      const c = document.createElement("canvas");
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const ctx = c.getContext("2d", { willReadFrequently: true })!;
      ctx.drawImage(img, 0, 0);
      if (keys.length) {
        const d = ctx.getImageData(0, 0, c.width, c.height);
        for (let i = 0; i < d.data.length; i += 4) {
          for (const key of keys) {
            if (d.data[i] === key[0] && d.data[i + 1] === key[1] && d.data[i + 2] === key[2]) { d.data[i + 3] = 0; break; }
          }
        }
        ctx.putImageData(d, 0, 0);
      }
      return c;
    } catch (e) {
      console.warn(`[skin] cannot decode ${path}`, e);
      return null;
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}
