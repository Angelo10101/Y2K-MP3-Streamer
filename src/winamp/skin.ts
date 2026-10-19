// Winamp classic skins (.wsz): a ZIP of bitmaps (main.bmp, cbuttons.bmp, ...) and a few text files.
import { unzipSync } from "fflate";

export type RGB = [number, number, number];

export interface WinampSkin {
  name: string;
  /** lower-case file name -> bytes, relative to the folder that holds main.bmp */
  files: Map<string, Uint8Array>;
}

export function loadWinampSkin(name: string, zip: Uint8Array): WinampSkin {
  const all = new Map<string, Uint8Array>();
  for (const [k, v] of Object.entries(unzipSync(zip))) if (!k.endsWith("/")) all.set(k.replace(/\\/g, "/").toLowerCase(), v);
  // some archives wrap everything in a folder
  const main = [...all.keys()]
    .filter((k) => k === "main.bmp" || k.endsWith("/main.bmp"))
    .sort((a, b) => a.split("/").length - b.split("/").length)[0];
  if (!main) throw new Error(`${name}: no main.bmp in the archive, so this is not a Winamp skin`);
  const base = main.slice(0, main.length - "main.bmp".length);
  const files = new Map<string, Uint8Array>();
  for (const [k, v] of all) if (k.startsWith(base)) files.set(k.slice(base.length), v);
  return { name, files };
}

/** viscolor.txt: one `R,G,B` per line (anything after the third number is a comment). */
export function parseViscolor(text: string): RGB[] {
  const out: RGB[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(line);
    if (m) out.push([Number(m[1]), Number(m[2]), Number(m[3])].map((n) => Math.min(255, n)) as RGB);
  }
  return out;
}

/** region.txt: the `[Normal]` window outline as polygons (empty when the skin is a plain rectangle). */
export function parseRegion(text: string): [number, number][][] {
  let inNormal = false;
  let counts: number[] = [];
  let pts: number[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\/\/.*$/, "").trim();
    const section = /^\[(.+)\]$/.exec(line);
    if (section) { inNormal = section[1].toLowerCase() === "normal"; continue; }
    const kv = inNormal ? /^(\w+)\s*=\s*(.*)$/.exec(line) : null;
    if (!kv) continue;
    const nums = kv[2].split(/[\s,]+/).filter(Boolean).map(Number).filter(Number.isFinite);
    if (kv[1].toLowerCase() === "numpoints") counts = nums;
    else if (kv[1].toLowerCase() === "pointlist") pts = nums;
  }
  const polys: [number, number][][] = [];
  let at = 0;
  for (const n of counts) {
    const poly: [number, number][] = [];
    for (let i = 0; i < n && at + 1 < pts.length; i++, at += 2) poly.push([pts[at], pts[at + 1]]);
    if (poly.length >= 3) polys.push(poly);
  }
  return polys;
}

/** The four digits of the time display: minutes (capped at 99) and seconds. */
export function timeDigits(sec: number): [number, number, number, number] {
  const s = Math.max(0, Math.floor(sec || 0));
  const m = Math.min(99, Math.floor(s / 60));
  return [Math.floor(m / 10), m % 10, Math.floor((s % 60) / 10), (s % 60) % 10];
}

/** Which of volume.bmp's 28 background frames shows a volume of 0..1. */
export const volumeFrame = (v: number) => Math.max(0, Math.min(27, Math.round(v * 27)));

// text.bmp is a 5x6 pixel font, 31 glyphs wide
// (cell 28 of the first row holds an unused glyph fragment; the blank space cell is 29)
const ROWS = ['ABCDEFGHIJKLMNOPQRSTUVWXYZ"@\u0001 ', "0123456789….:()-'!_+\\/[]^&%,=$#", "ÅÖÄ?*"];
const GLYPHS = new Map<string, [number, number]>();
ROWS.forEach((row, y) => [...row].forEach((ch, x) => GLYPHS.set(ch, [x * 5, y * 6])));

/** Source position of a character in text.bmp (null if the font has none; a space is a real glyph). */
export function glyph(ch: string): [number, number] | null {
  return GLYPHS.get(ch.toUpperCase()) ?? null;
}
