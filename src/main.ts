// App flow: "home" = Pear's own YouTube Music window plus a small companion panel (skin
// chooser, mini controls); "player" = the skinned player with Pear's window hidden.
// Only one of the two is ever visible.
import { emptyState, inTauri, listSkins, onPlayerState, onViz, pearHide, pearShow, pearStart, readSkin, setInputShape, type PlayerState } from "./backend";
import { Panel } from "./panel";
import { PlayerShim } from "./wmp/player";
import { SkinWindow, type WindowHooks } from "./wmp/render";
import { loadSkin } from "./wmp/skin";

type Mode = "home" | "player";
const app = document.getElementById("app")!;
const player = new PlayerShim();
const startedAt = Date.now();
let mode: Mode = "home";
let panel: Panel | undefined;
let current: SkinWindow | undefined;
let prev: PlayerState = emptyState;
let pearMessage: string | undefined;
let onTop = false;

const win = async () => (await import("@tauri-apps/api/window")).getCurrentWindow();

const hooks: WindowHooks = {
  resize: async (w, h) => {
    if (!inTauri) return;
    const { LogicalSize } = await import("@tauri-apps/api/window");
    await (await win()).setSize(new LogicalSize(w, h));
  },
  setAlwaysOnTop: async (on) => inTauri && (await win()).setAlwaysOnTop(on),
  minimize: async () => inTauri && (await win()).minimize(),
  close: async () => inTauri && (await win()).close(),
  startDrag: async () => inTauri && (await win()).startDragging(),
  setShape: (rects) => void setInputShape(rects),
  returnHome: () => void enterHome(),
};

// ---------- player events ----------
function onState(s: PlayerState) {
  player.update(s);
  panel?.update(s);
  if (mode === "home") maybeEnterPlayer(prev, s);
  prev = s;
}
onPlayerState(onState);
onViz(
  (b) => { player.bars = b; panel?.bars(b); },
  (ok, reason) => { player.vizAvailable = ok; player.vizReason = reason; if (!ok) console.info("[viz]", reason); },
);

/** A new track started playing while on the home screen: go to the player. */
function maybeEnterPlayer(before: PlayerState, s: PlayerState) {
  if (!s.running || s.status !== "Playing" || !s.track_id) return;
  if (Date.now() - startedAt < 5000) return; // ignore whatever was already playing at launch
  if (s.track_id === before.track_id) return; // resume / same track
  const autoAdvanced = before.status === "Playing" && before.length_s > 0 && before.position_s >= before.length_s - 3;
  if (autoAdvanced) return; // the previous song just ended; don't yank the user off the home screen
  void enterPlayer();
}

// ---------- modes ----------
const savedSkin = () => localStorage.getItem("skin");
async function pickSkin(): Promise<string | undefined> {
  const list = await listSkins();
  const want = savedSkin();
  return list.skins.find((s) => s === want) ?? list.skins.find((s) => /headspace/i.test(s)) ?? list.skins[0];
}

async function enterPlayer() {
  if (mode === "player" || !inTauri) return;
  const skin = await pickSkin();
  if (!skin) { await showHome("No skins found, so the player can't open."); return; }
  mode = "player";
  if (!(await openSkin(skin))) return;
  await (await win()).show();
  // hide Pear last so the screen is never empty; X11 only, otherwise both stay visible
  await pearHide().catch((e) => console.warn("[pear] cannot hide window:", e));
}

async function enterHome() {
  mode = "home";
  await showHome();
  await pearShow().catch((e) => console.warn("[pear] cannot show window:", e));
}

/** The companion panel shown next to Pear's window. */
async function showHome(message?: string) {
  closeMenu();
  current?.dispose();
  current = undefined;
  const list = inTauri ? await listSkins() : { dir: "skins/", skins: [] as string[] };
  panel = new Panel({
    skinsDir: list.dir,
    skins: list.skins,
    selected: (await pickSkin()) ?? undefined,
    message: message ?? pearMessage,
    onPick: (n) => localStorage.setItem("skin", n),
    onOpenPlayer: () => void enterPlayer(),
    onOpenYouTube: () => void pearShow().catch(console.warn),
  });
  app.replaceChildren(panel.el);
  panel.update(player.state);
  if (inTauri) {
    const { LogicalSize } = await import("@tauri-apps/api/window");
    const w = await win();
    await w.setSize(new LogicalSize(420, 430));
    void setInputShape([[0, 0, 420, 430]]);
    await w.show();
  }
}

/** Returns false if the skin failed to load (the home screen is shown instead). */
async function openSkin(name: string): Promise<boolean> {
  try {
    const skin = loadSkin(name, await readSkin(name));
    closeMenu();
    current?.dispose();
    panel = undefined;
    current = new SkinWindow(skin, skin.views[0], player, app, hooks);
    await current.mount();
    localStorage.setItem("skin", name);
    (window as unknown as { __skins: unknown }).__skins = { skin, current };
    return true;
  } catch (e) {
    console.error(e);
    mode = "home";
    await showHome(`Could not load ${name}: ${(e as Error).message ?? e}`);
    return false;
  }
}

// ---------- right-click menu (player mode) ----------
function closeMenu() { document.getElementById("ctx")?.remove(); }

async function openMenu(x: number, y: number) {
  closeMenu();
  const list = await listSkins();
  const cur = savedSkin();
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
  item(`${onTop ? "✓ " : "   "}Always on top`, () => { onTop = !onTop; void hooks.setAlwaysOnTop(onTop); }, true);
  item("   Home (YouTube Music)", () => void enterHome());
  item("   Quit", () => void hooks.close());
  document.body.appendChild(m);
  const r = m.getBoundingClientRect();
  m.style.left = `${Math.max(0, Math.min(x, innerWidth - r.width))}px`;
  m.style.top = `${Math.max(0, Math.min(y, innerHeight - r.height))}px`;
  // the menu must be clickable even where the skin is transparent
  void setInputShape([[0, 0, innerWidth, innerHeight]]);
  const off = (e: Event) => {
    if ((e.target as HTMLElement).closest?.("#ctx")) return;
    closeMenu(); document.removeEventListener("pointerdown", off, true);
    current?.scheduleShape(0);
  };
  document.addEventListener("pointerdown", off, true);
}
document.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  if (mode === "player") void openMenu(e.clientX, e.clientY);
});

// ---------- startup ----------
(async () => {
  onState(emptyState);
  if (inTauri) {
    const status = await pearStart().catch((e) => ({ running: false, message: String(e) }));
    pearMessage = status.message ?? undefined;
  }
  await showHome();
})();
