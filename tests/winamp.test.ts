import { describe, expect, it } from "vitest";
import { zipSync } from "fflate";
import { glyph, loadWinampSkin, parseRegion, parseViscolor, timeDigits, volumeFrame } from "../src/winamp/skin";

const bytes = (s: string) => new TextEncoder().encode(s);

describe("winamp skin archive", () => {
  it("finds main.bmp at the top level, case-insensitively", () => {
    const skin = loadWinampSkin("a.wsz", zipSync({ "Main.BMP": bytes("x"), "cButtons.bmp": bytes("y") }));
    expect([...skin.files.keys()].sort()).toEqual(["cbuttons.bmp", "main.bmp"]);
  });

  it("looks inside a wrapping folder", () => {
    const skin = loadWinampSkin("b.wsz", zipSync({ "Pip Boy/main.bmp": bytes("x"), "Pip Boy/text.bmp": bytes("t"), "readme.txt": bytes("r") }));
    expect([...skin.files.keys()].sort()).toEqual(["main.bmp", "text.bmp"]);
  });

  it("rejects an archive without main.bmp", () => {
    expect(() => loadWinampSkin("c.wsz", zipSync({ "skin.wms": bytes("<theme/>") }))).toThrow(/not a Winamp skin/);
  });
});

describe("winamp text files", () => {
  it("parses viscolor.txt and ignores comments", () => {
    const c = parseViscolor("0,0,0 // background\r\n24, 33, 41\r\nnot a colour\r\n300,0,1");
    expect(c).toEqual([[0, 0, 0], [24, 33, 41], [255, 0, 1]]);
  });

  it("parses region.txt polygons", () => {
    const polys = parseRegion("// made by a tool\n[Normal]\nNumPoints=4,3\nPointList=0,0, 275,0, 275,116, 0,116, 1,1, 5,1, 3,9\n[WindowShade]\nNumPoints=3\nPointList=9,9,9,9,9,9");
    expect(polys).toHaveLength(2);
    expect(polys[0]).toEqual([[0, 0], [275, 0], [275, 116], [0, 116]]);
    expect(polys[1]).toEqual([[1, 1], [5, 1], [3, 9]]);
  });

  it("treats a comment-only region.txt as a plain rectangle", () => {
    expect(parseRegion("// This file was created by a tool\n// http://example.com")).toEqual([]);
  });
});

describe("winamp display helpers", () => {
  it("splits elapsed time into display digits", () => {
    expect(timeDigits(0)).toEqual([0, 0, 0, 0]);
    expect(timeDigits(75.9)).toEqual([0, 1, 1, 5]);
    expect(timeDigits(3599)).toEqual([5, 9, 5, 9]);
    expect(timeDigits(99999)).toEqual([9, 9, 3, 9]); // minutes cap at 99
  });

  it("maps a volume to one of the 28 slider frames", () => {
    expect([volumeFrame(0), volumeFrame(0.5), volumeFrame(1), volumeFrame(2)]).toEqual([0, 14, 27, 27]);
  });

  it("locates glyphs in text.bmp's 5x6 font", () => {
    expect(glyph("A")).toEqual([0, 0]);
    expect(glyph("a")).toEqual([0, 0]);
    expect(glyph("Z")).toEqual([125, 0]);
    expect(glyph("0")).toEqual([0, 6]);
    expect(glyph(":")).toEqual([60, 6]);
    expect(glyph("-")).toEqual([75, 6]);
    expect(glyph("#")).toEqual([150, 6]);
    expect(glyph(" ")).toEqual([145, 0]);
    expect(glyph("€")).toBeNull();
  });
});
