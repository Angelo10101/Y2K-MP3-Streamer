import { emptyState, inTauri, listSkins, onPlayerState, onViz, readSkin, setInputShape, type PlayerState } from "./backend";
import { Panel } from "./panel";
import { PlayerShim } from "./wmp/player";
import { SkinWindow, type WindowHooks } from "./wmp/render";
import { loadSkin } from "./wmp/skin";

const app = document.getElementById("app")!;
const player = new PlayerShim();
let panel: Panel | undefined;
let current: SkinWindow | undefined;

const hooks: WindowHooks = {
  resize: async (w, h) => {
    if (!inTauri) return;
    const { getCurrentWindow, LogicalSize } = await import("@tauri-apps/api/window");
    await getCurrentWindow().setSize(new LogicalSize(w, h));
  },
  setAlwaysOnTop: async (on) => inTauri && (await import("@tauri-apps/api/window")).getCurrentWindow().setAlwaysOnTop(on),
  minimize: async () => inTauri && (await import("@tauri-apps/api/window")).getCurrentWindow().minimize(),
  close: async () => inTauri && (await import("@tauri-apps/api/window")).getCurrentWindow().close(),
  startDrag: async () => inTauri && (await import("@tauri-apps/api/window")).getCurrentWindow().startDragging(),
  setShape: (rects) => void setInputShape(rects),
};

function applyState(s: PlayerState) {
  player.update(s);
  panel?.update(s);
}
onPlayerState(applyState);
onViz(
  (b) => { player.bars = b; panel?.bars(b); },
  (ok, reason) => { player.vizAvailable = ok; player.vizReason = reason; if (!ok) console.info("[viz]", reason); },
);

async function showPanel(message?: string) {
  current?.dispose();
  current = undefined;
  const list = inTauri ? await listSkins() : { dir: "skins/", skins: [] };
  panel = new Panel({ skinsDir: list.dir, skins: list.skins, message, onPick: (n) => void openSkin(n) });
  app.replaceChildren(panel.el);
  panel.update(player.state);
  if (inTauri) {
    const { getCurrentWindow, LogicalSize } = await import("@tauri-apps/api/window");
    await getCurrentWindow().setSize(new LogicalSize(420, 400));
    void setInputShape([[0, 0, 420, 400]]);
  }
}

export async function openSkin(name: string) {
  try {
    const skin = loadSkin(name, await readSkin(name));
    current?.dispose();
    panel = undefined;
    current = new SkinWindow(skin, skin.views[0], player, app, hooks);
    await current.mount();
    localStorage.setItem("skin", name);
    (window as unknown as { __skins: unknown }).__skins = { skin, current };
  } catch (e) {
    console.error(e);
    await showPanel(`Could not load ${name}: ${(e as Error).message ?? e}`);
  }
}

(async () => {
  applyState(emptyState);
  const list = inTauri ? await listSkins() : { dir: "", skins: [] as string[] };
  const want = localStorage.getItem("skin");
  const pick = list.skins.find((s) => s === want) ?? list.skins.find((s) => /headspace/i.test(s)) ?? list.skins[0];
  if (pick) await openSkin(pick);
  else await showPanel();
})();
