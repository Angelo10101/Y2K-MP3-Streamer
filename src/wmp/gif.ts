// Minimal GIF decoder (frames + delays + loop count). WebKit's canvas drawImage only ever gives
// the first frame of an animated GIF, and skins use animated GIFs for intros, so we decode them.

export interface GifFrame { delayMs: number; rgba: Uint8ClampedArray }
export interface Gif { width: number; height: number; frames: GifFrame[]; /** 0 = loop forever */ loops: number }

function lzw(minCode: number, data: Uint8Array, count: number): Uint8Array {
  const clear = 1 << minCode, eoi = clear + 1;
  const prefix = new Uint16Array(4096), suffix = new Uint8Array(4096);
  const out = new Uint8Array(count);
  let codeSize = minCode + 1, next = eoi + 1, prev = -1, op = 0, bits = 0, acc = 0, ip = 0;
  const expand = (c: number) => {
    const s: number[] = [];
    while (c >= clear) { s.push(suffix[c]); c = prefix[c]; }
    s.push(c);
    return s.reverse();
  };
  while (op < count) {
    while (bits < codeSize && ip < data.length) { acc |= data[ip++] << bits; bits += 8; }
    if (bits < codeSize) break;
    const code = acc & ((1 << codeSize) - 1);
    acc >>= codeSize; bits -= codeSize;
    if (code === clear) { codeSize = minCode + 1; next = eoi + 1; prev = -1; continue; }
    if (code === eoi) break;
    if (prev === -1) { out[op++] = code; prev = code; continue; }
    let str: number[];
    if (code < next) str = expand(code);
    else { const p = expand(prev); str = p.concat(p[0]); }
    for (const b of str) { if (op < count) out[op++] = b; }
    if (next < 4096) {
      prefix[next] = prev; suffix[next] = str[0]; next++;
      if (next === 1 << codeSize && codeSize < 12) codeSize++;
    }
    prev = code;
  }
  return out;
}

export function decodeGif(buf: Uint8Array, maxPixels = 40_000_000): Gif | null {
  const sig = String.fromCharCode(...buf.subarray(0, 6));
  if (sig !== "GIF87a" && sig !== "GIF89a") return null;
  const u16 = (i: number) => buf[i] | (buf[i + 1] << 8);
  const W = u16(6), H = u16(8);
  let p = 13;
  let gct: Uint8Array | null = null;
  if (buf[10] & 0x80) { const n = 3 * (1 << ((buf[10] & 7) + 1)); gct = buf.subarray(p, p + n); p += n; }
  const frames: GifFrame[] = [];
  const canvas = new Uint8ClampedArray(W * H * 4);
  let delay = 100, transparent = -1, disposal = 0, loops = 1;
  let prevDisposal = 0, prevRect = [0, 0, 0, 0], saved: Uint8ClampedArray | null = null;
  const skipBlocks = () => { while (buf[p] !== 0 && p < buf.length) p += buf[p] + 1; p++; };
  while (p < buf.length) {
    const b = buf[p++];
    if (b === 0x3b) break;
    if (b === 0x21) {
      const label = buf[p++];
      if (label === 0xf9) {
        const pk = buf[p + 1];
        disposal = (pk >> 2) & 7;
        transparent = pk & 1 ? buf[p + 4] : -1;
        delay = Math.max(2, u16(p + 2)) * 10;
        p += 6;
      } else if (label === 0xff && String.fromCharCode(...buf.subarray(p + 1, p + 12)) === "NETSCAPE2.0") {
        loops = u16(p + 14);
        skipBlocks();
      } else skipBlocks();
    } else if (b === 0x2c) {
      const l = u16(p), t = u16(p + 2), w = u16(p + 4), h = u16(p + 6), pk = buf[p + 8];
      p += 9;
      let pal = gct;
      if (pk & 0x80) { const n = 3 * (1 << ((pk & 7) + 1)); pal = buf.subarray(p, p + n); p += n; }
      const minCode = buf[p++];
      const chunks: number[] = [];
      while (buf[p] !== 0 && p < buf.length) { for (let i = 1; i <= buf[p]; i++) chunks.push(buf[p + i]); p += buf[p] + 1; }
      p++;
      if (!pal || (frames.length + 1) * W * H > maxPixels) { if (!pal) continue; break; }
      let idx = lzw(minCode, Uint8Array.from(chunks), w * h);
      if (pk & 0x40) { // interlaced
        const un = new Uint8Array(w * h);
        let row = 0;
        for (const [start, step] of [[0, 8], [4, 8], [2, 4], [1, 2]]) {
          for (let y = start; y < h; y += step) un.set(idx.subarray(row * w, (row + 1) * w), y * w), row++;
        }
        idx = un;
      }
      // dispose of the previous frame before drawing this one
      if (prevDisposal === 2) {
        const [pl, pt, pw, ph] = prevRect;
        for (let y = pt; y < pt + ph && y < H; y++) canvas.fill(0, (y * W + pl) * 4, (y * W + Math.min(pl + pw, W)) * 4);
      } else if (prevDisposal === 3 && saved) canvas.set(saved);
      if (disposal === 3) saved = canvas.slice();
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const c = idx[y * w + x];
          if (c === transparent) continue;
          const o = ((t + y) * W + l + x) * 4;
          if (l + x >= W || t + y >= H) continue;
          canvas[o] = pal[c * 3]; canvas[o + 1] = pal[c * 3 + 1]; canvas[o + 2] = pal[c * 3 + 2]; canvas[o + 3] = 255;
        }
      }
      frames.push({ delayMs: delay, rgba: canvas.slice() });
      prevDisposal = disposal; prevRect = [l, t, w, h];
      disposal = 0; transparent = -1; delay = 100;
    } else break;
  }
  return frames.length ? { width: W, height: H, frames, loops } : null;
}
