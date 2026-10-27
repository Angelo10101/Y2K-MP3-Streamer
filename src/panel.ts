// Plain, unskinned control panel: the test UI for MPRIS, and the fallback shown when no
// skin is loaded (with a message telling the user where to put one).
import { playerCmd, sourceName, type PlayerState } from "./backend";
import { fmtTime } from "./wmp/player";
import { getViz, loadViz, setViz, vizMenu } from "./wmp/viz";

export interface PanelInfo {
  skinsDir: string;
  skins: string[];
  selected?: string;
  message?: string;
  onPick: (name: string) => void;
  onOpenPlayer: () => void;
  onOpenYouTube: () => void;
}

export class Panel {
  el = document.createElement("div");
  private seeking = false;
  private volDragging = false;
  private volHoldUntil = 0;
  private last?: PlayerState;
  private $: Record<string, HTMLElement> = {};

  constructor(private info: PanelInfo) {
    this.el.className = "panel";
    const skins = info.skins.length
      ? `<div class="row">Skin: <select id="skin">${info.skins.map((s) => `<option value="${s}"${s === info.selected ? " selected" : ""}>${s.replace(/\.w[ms]z$/i, "")}</option>`).join("")}</select><button id="player">Open player</button></div>`
      : `<div class="msg">No skins found. Put a <code>.wmz</code> (Windows Media Player) or <code>.wsz</code> (Winamp) file, e.g. <code>Headspace.wmz</code>, in <code>${info.skinsDir}</code>.</div>`;
    this.el.innerHTML = `
      <h1 data-tauri-drag-region>Y2K-MP3-Streamer: home</h1>
      <div class="row"><button id="yt">Open ${sourceName}</button></div>
      ${info.message ? `<div class="msg">${info.message}</div>` : ""}
      <div id="offline" class="msg"></div>
      <div class="row"><img class="art" id="art" alt=""><div><b id="title">-</b><br><span id="artist"></span> <span id="album"></span></div></div>
      <div class="row"><button id="prev">⏮</button><button id="pp">⏯</button><button id="stop">⏹</button><button id="next">⏭</button>
        <button id="shuf">shuffle</button><button id="rep">repeat</button></div>
      <div class="row"><span id="pos">0:00</span><input type="range" id="seek" min="0" max="1" step="0.1" value="0"><span id="len">0:00</span></div>
      <div class="row">vol <input type="range" id="vol" min="0" max="100" value="100"></div>
      <div class="bars" id="bars"></div>
      <div class="row">Visualization: <select id="viz"></select></div>
      ${skins}`;
    this.el.querySelectorAll<HTMLElement>("[id]").forEach((e) => (this.$[e.id] = e));
    const on = (id: string, f: () => void) => this.$[id]?.addEventListener("click", f);
    on("prev", () => playerCmd("previous"));
    on("next", () => playerCmd("next"));
    on("pp", () => playerCmd("play_pause"));
    on("stop", () => playerCmd("stop"));
    on("shuf", () => playerCmd("shuffle", this.last?.shuffle ? 0 : 1));
    on("rep", () => playerCmd("loop", undefined, this.last?.loop_status === "None" ? "Playlist" : "None"));
    on("yt", () => info.onOpenYouTube());
    on("player", () => info.onOpenPlayer());
    const viz = this.$.viz as HTMLSelectElement;
    const fillViz = () => {
      viz.replaceChildren(...vizMenu().map((g) => {
        const og = document.createElement("optgroup");
        og.label = g.group;
        og.append(...g.items.map((i) => new Option(i.text, i.value)));
        return og;
      }));
      viz.value = getViz();
    };
    fillViz();
    loadViz(fillViz); // WMP's own visualizations join the menu once the engine has loaded
    viz.addEventListener("change", () => setViz(viz.value));
    this.$.skin?.addEventListener("change", () => info.onPick((this.$.skin as HTMLSelectElement).value));
    const seek = this.$.seek as HTMLInputElement;
    seek.addEventListener("pointerdown", () => (this.seeking = true));
    seek.addEventListener("change", () => { this.seeking = false; void playerCmd("seek_to", Number(seek.value)); });
    // while the user is dragging (and briefly after), polled values must not move the slider back
    this.$.vol.addEventListener("pointerdown", () => {
      this.volDragging = true;
      window.addEventListener("pointerup", () => { this.volDragging = false; this.volHoldUntil = performance.now() + 1500; }, { once: true });
    });
    this.$.vol.addEventListener("input", () => {
      this.volHoldUntil = performance.now() + 1500;
      void playerCmd("volume", Number((this.$.vol as HTMLInputElement).value) / 100);
    });
  }

  update(s: PlayerState) {
    this.last = s;
    this.$.offline.textContent = s.running
      ? (s.error ?? "")
      : `${sourceName} isn't running; starting it...`;
    this.$.title.textContent = s.title || "-";
    this.$.artist.textContent = s.artist;
    this.$.album.textContent = s.album ? `· ${s.album}` : "";
    const art = this.$.art as HTMLImageElement;
    if (s.art_url && art.src !== s.art_url) art.src = s.art_url;
    art.style.display = s.art_url ? "" : "none";
    this.$.shuf.style.fontWeight = s.shuffle ? "bold" : "";
    this.$.rep.style.fontWeight = s.loop_status !== "None" ? "bold" : "";
    const seek = this.$.seek as HTMLInputElement;
    seek.max = String(s.length_s || 1);
    if (!this.seeking) seek.value = String(s.position_s);
    this.$.pos.textContent = fmtTime(s.position_s);
    this.$.len.textContent = fmtTime(s.length_s);
    if (!this.volDragging && performance.now() > this.volHoldUntil) (this.$.vol as HTMLInputElement).value = String(Math.round(s.volume * 100));
  }

  bars(b: number[]) {
    const el = this.$.bars;
    if (el.children.length !== b.length) el.innerHTML = b.map(() => "<i></i>").join("");
    b.forEach((v, i) => ((el.children[i] as HTMLElement).style.height = `${v}%`));
  }
}
