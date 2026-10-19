// App flow: "home" = Pear's own YouTube Music window plus a small companion panel (skin
// chooser, mini controls); "player" = the skinned player with Pear's window hidden.
// Only one of the two is ever visible.
import { emptyState, inTauri, listSkins, onPlayerState, onViz, pearHide, pearShow, pearStart, readSkin, setInputShape, sourceName, startupOptions, type PlayerState } from "./backend";
import { Panel } from "./panel";
import { PlayerShim } from "./wmp/player";
import { SkinWindow, type WindowHooks } from "./wmp/render";
import { loadSkin, pickMainView } from "./wmp/skin";

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

/** Forces the webview to repaint (after resizes / content swaps it can keep showing a stale frame). */
function nudgeRepaint() {
  for (const delay of [0, 120, 400]) {
    setTimeout(() => {
      app.style.transform = "translateZ(0)";
      requestAnimationFrame(() => { app.style.transform = ""; });
    }, delay);
  }
}

const win = async () => (await import("@tauri-apps/api/window")).getCurrentWindow();

/**
 * The window is created large (see tauri.conf.json) and only ever grows. Compositors such as
 * picom animate every geometry change, and overlapping animations can leave the window showing
 * stale content until the next focus change. The unused area is transparent and click-through
 * (input shape), so a big window costs nothing.
 */
let winW = 900;
let winH = 600;
const hooks: WindowHooks = {
  resize: async (w, h) => {
    if (!inTauri || (w <= winW && h <= winH)) return;
    winW = Math.max(winW, w);
    winH = Math.max(winH, h);
    const { LogicalSize } = await import("@tauri-apps/api/window");
    await (await win()).setSize(new LogicalSize(winW, winH));
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
    const w = await win();
    void setInputShape([[0, 0, 420, 430]]); // only the panel takes clicks, the rest of the window is click-through
    await w.show();
  }
  nudgeRepaint();
}

/** Returns false if the skin failed to load (the home screen is shown instead). */
async function openSkin(name: string): Promise<boolean> {
  try {
    const skin = loadSkin(name, await readSkin(name));
    closeMenu();
    current?.dispose();
    panel = undefined;
    current = new SkinWindow(skin, pickMainView(skin.views), player, app, hooks);
    await current.mount();
    localStorage.setItem("skin", name);
    (window as unknown as { __skins: unknown }).__skins = { skin, current };
    nudgeRepaint();
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
  item(`   Home (${sourceName})`, () => void enterHome());
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
// Escape always goes Home from the player, for skins without a "return to full mode" button
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && mode === "player") void enterHome(); });
document.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  if (mode === "player") void openMenu(e.clientX, e.clientY);
});

// ---------- startup ----------
(async () => {
  onState(emptyState);
  const opts = inTauri ? await startupOptions() : undefined; // also sets the source name used in UI text
  if (inTauri) {
    const status = await pearStart().catch((e) => ({ running: false, message: String(e) }));
    pearMessage = status.message ?? undefined;
  }
  await showHome();
  // development aid: RETRO_SKIN=<name> opens that skin's player immediately
  if (inTauri && opts) {
    if (opts.debug) {
      document.addEventListener("pointerdown", (e) => {
        const stack = document.elementsFromPoint(e.clientX, e.clientY).slice(0, 8).map((n) => {
          const el = n as HTMLElement;
          return `${el.tagName.toLowerCase()}${el.id ? "#" + el.id : ""}.${[...el.classList].join(".")}${el.title ? `[${el.title}]` : ""}`;
        });
        const covering = [...document.querySelectorAll<HTMLElement>(".skin-el, .skin-el canvas")]
          .filter((n) => { const r = n.getBoundingClientRect(); return n.offsetParent && e.clientX >= r.left && e.clientX < r.right && e.clientY >= r.top && e.clientY < r.bottom; })
          .map((n) => { const r = n.getBoundingClientRect(); return `${n.tagName.toLowerCase()}${n.id ? "#" + n.id : ""}:${getComputedStyle(n).pointerEvents}${n.classList.contains("pass") ? ":pass" : ""}[${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)} ov=${getComputedStyle(n).overflow}]`; });
        console.warn(`[click] (${Math.round(e.clientX)},${Math.round(e.clientY)}) top: ${stack.join(" > ")} | covering: ${covering.join(" ")}`);
        // is an auto element really unreachable? probe its own centre
        for (const n of document.querySelectorAll<HTMLElement>(".skin-el canvas")) {
          const r = n.getBoundingClientRect();
          if (r.width && r.width < 120 && getComputedStyle(n).pointerEvents === "auto" && e.clientX >= r.left && e.clientX < r.right && e.clientY >= r.top && e.clientY < r.bottom) {
            const top = document.elementsFromPoint(r.left + r.width / 2, r.top + r.height / 2).slice(0, 4).map((x) => (x as HTMLElement).tagName.toLowerCase() + ((x as HTMLElement).id ? "#" + (x as HTMLElement).id : ""));
            let chain = ""; for (let a: HTMLElement | null = n; a && a.id !== "skin-root"; a = a.parentElement) chain += `${a.tagName.toLowerCase()}(${getComputedStyle(a).pointerEvents},${getComputedStyle(a).display},${getComputedStyle(a).visibility}) < `;
            console.warn(`[probe] canvas ${Math.round(r.width)}x${Math.round(r.height)} at centre: ${top.join(">")} chain ${chain}`);
          }
        }
      }, true);
    }
    const want = opts.skin?.toLowerCase().replace(/\.wmz$/, "");
    const found = want && (await listSkins()).skins.find((n) => n.toLowerCase().replace(/\.wmz$/, "") === want);
    if (found) { localStorage.setItem("skin", found); await enterPlayer(); return; }
  }
  // Pear may have been left hidden by a previous run (player mode); bring it back. Right
  // after a fresh launch it isn't on D-Bus yet, so retry for a while.
  if (inTauri) {
    for (let i = 0; i < 15 && mode === "home"; i++) {
      if (await pearShow().then(() => true, () => false)) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
})();
