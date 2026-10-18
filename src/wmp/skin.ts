// .wmz = ZIP archive containing a .wms (XML layout), bitmaps and optional JScript.
import { unzipSync } from "fflate";
import { parseXml, findAll, type WmsNode } from "./xml";

export interface Skin {
  name: string;
  /** the <theme> element */
  theme: WmsNode;
  views: WmsNode[];
  files: Map<string, Uint8Array>;
  /** Case- and slash-insensitive lookup. */
  file(path: string): Uint8Array | undefined;
  text(path: string): string | undefined;
}

const norm = (p: string) => p.replace(/\\/g, "/").replace(/^\.?\//, "").toLowerCase();

/**
 * The view to show. WMP 11 skins start with a `previewView` (the thumbnail in the skin chooser)
 * and a `controlView` before the real `mainView`; older skins just have one view.
 */
export function pickMainView(views: WmsNode[]): WmsNode {
  const id = (v: WmsNode) => (v.attrs.id ?? "").toLowerCase();
  return (
    views.find((v) => id(v) === "mainview") ??
    views.find((v) => !/preview|control/.test(id(v)) && v.attrs.width) ??
    views[0]
  );
}

export function loadSkin(name: string, zip: Uint8Array): Skin {
  const raw = unzipSync(zip);
  const files = new Map<string, Uint8Array>();
  for (const [k, v] of Object.entries(raw)) if (!k.endsWith("/")) files.set(norm(k), v);

  const wmsPath = [...files.keys()].filter((k) => k.endsWith(".wms")).sort((a, b) => a.split("/").length - b.split("/").length)[0];
  if (!wmsPath) throw new Error(`${name}: no .wms layout file found in archive`);
  const root = parseXml(decodeText(files.get(wmsPath)!));
  const theme = findAll(root, "theme")[0] ?? root;
  const views = findAll(theme, "view");
  if (!views.length) throw new Error(`${name}: .wms contains no <view>`);

  return {
    name, theme, views, files,
    file: (p) => files.get(norm(p)),
    text: (p) => { const f = files.get(norm(p)); return f && decodeText(f); },
  };
}

/** WMS/JS files are UTF-16 or ANSI depending on the author's editor. */
export function decodeText(b: Uint8Array): string {
  if (b[0] === 0xff && b[1] === 0xfe) return new TextDecoder("utf-16le").decode(b);
  if (b[0] === 0xfe && b[1] === 0xff) return new TextDecoder("utf-16be").decode(b);
  try { return new TextDecoder("utf-8", { fatal: true }).decode(b); }
  catch { return new TextDecoder("windows-1252").decode(b); }
}
