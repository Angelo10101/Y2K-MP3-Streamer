import { describe, expect, it } from "vitest";
import { decodeGif } from "../src/wmp/gif";

// 3 frames, 6x4, delay 100 ms, loops forever: solid red, solid blue, a green->yellow gradient
const GIF = Uint8Array.from(atob("R0lGODlhBgAEAPAAAP8AAAAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQACgAAACwAAAAABgAEAAACBISPqVcAIfkEAAoAAAAsAAAAAAYABACAAAD/AAAAAgSEj6lXACH5BAAKAAAALAAAAAAGAAQAgQD/AFX/AKr/AP//AAIHhB+pwj0PCwA7"), (c) => c.charCodeAt(0));

describe("gif decoder", () => {
  it("decodes frames, delays and loop count", () => {
    const g = decodeGif(GIF)!;
    expect([g.width, g.height, g.frames.length, g.loops]).toEqual([6, 4, 3, 0]);
    expect(g.frames.map((f) => f.delayMs)).toEqual([100, 100, 100]);
  });

  it("decodes pixel colours", () => {
    const g = decodeGif(GIF)!;
    const px = (f: number, x: number, y: number) => [...g.frames[f].rgba.slice((y * 6 + x) * 4, (y * 6 + x) * 4 + 4)];
    expect(px(0, 0, 0)).toEqual([255, 0, 0, 255]);
    expect(px(1, 5, 3)).toEqual([0, 0, 255, 255]);
    // gradient frame: top row greener than bottom row's yellow (red channel grows downwards)
    expect(px(2, 2, 0)[0]).toBeLessThan(px(2, 2, 3)[0]);
  });

  it("rejects non-gif data", () => {
    expect(decodeGif(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]))).toBeNull();
  });
});
