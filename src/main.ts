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

let onTop = false;
function closeMenu() { document.getElementById("ctx")?.remove(); }

/** Right-click menu: skin chooser, always-on-top, control panel, quit. */
async function openMenu(x: number, y: number) {
  closeMenu();
  const list = await listSkins();
  const cur = localStorage.getItem("skin");
  const m = document.createElement("div");
  m.id = "ctx";
  const item = (label: string, f: () => void, sep = false) => {
    const d = document.createElement("div");
    d.textContent = label;
    d.className = "ctx-item" + (sep ? " sep" : "");
    d.onpointerdown = (e) => e.stopPropagation();
    d.onclick = () => { closeMenu(); f(); };
    m.appendChild(d);
  };
  for (const n of list.skins) item(`${n === cur ? "✓ " : "   "}${n.replace(/\.wmz$/i, "")}`, () => void openSkin(n));
  if (!list.skins.length) item(`no skins in ${list.dir}`, () => {});
  item(`${onTop ? "✓ " : "   "}Always on top`, () => { onTop = !onTop; hooks.setAlwaysOnTop(onTop); }, true);
  item("   Control panel", () => void showPanel());
  item("   Quit", () => hooks.close());
  document.body.appendChild(m);
  const r = m.getBoundingClientRect();
  m.style.left = `${Math.max(0, Math.min(x, innerWidth - r.width))}px`;
  m.style.top = `${Math.max(0, Math.min(y, innerHeight - r.height))}px`;
  // the menu must be clickable even where the skin is transparent
  void setInputShape([[0, 0, innerWidth, innerHeight]]);
  const off = (e: Event) => {
    if ((e.target as HTMLElement).closest?.("#ctx")) return;
    closeMenu(); document.removeEventListener("pointerdown", off, true);
    (window as unknown as { __skins?: { current: SkinWindow } }).__skins?.current.scheduleShape(0);
  };
  document.addEventListener("pointerdown", off, true);
}
document.addEventListener("contextmenu", (e) => { e.preventDefault(); void openMenu(e.clientX, e.clientY); });

export async function openSkin(name: string) {
  try {
    const skin = loadSkin(name, await readSkin(name));
    closeMenu();
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
