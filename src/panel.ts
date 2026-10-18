// Plain, unskinned control panel: the test UI for MPRIS, and the fallback shown when no
// skin is loaded (with a message telling the user where to put one).
import { playerCmd, type PlayerState } from "./backend";
import { fmtTime } from "./wmp/player";

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
  private last?: PlayerState;
  private $: Record<string, HTMLElement> = {};

  constructor(private info: PanelInfo) {
    this.el.className = "panel";
    const skins = info.skins.length
      ? `<div class="row">Skin: <select id="skin">${info.skins.map((s) => `<option${s === info.selected ? " selected" : ""}>${s.replace(/\.wmz$/i, "")}</option>`).join("")}</select><button id="player">Open player</button></div>`
      : `<div class="msg">No skins found. Put a <code>.wmz</code> file (e.g. <code>Headspace.wmz</code>) in <code>${info.skinsDir}</code>.</div>`;
    this.el.innerHTML = `
      <h1 data-tauri-drag-region>retro-mp3-yt-music: home</h1>
      <div class="row"><button id="yt">Open YouTube Music</button></div>
      ${info.message ? `<div class="msg">${info.message}</div>` : ""}
      <div id="offline" class="msg"></div>
      <div class="row"><img class="art" id="art" alt=""><div><b id="title">-</b><br><span id="artist"></span> <span id="album"></span></div></div>
      <div class="row"><button id="prev">⏮</button><button id="pp">⏯</button><button id="stop">⏹</button><button id="next">⏭</button>
        <button id="shuf">shuffle</button><button id="rep">repeat</button></div>
      <div class="row"><span id="pos">0:00</span><input type="range" id="seek" min="0" max="1" step="0.1" value="0"><span id="len">0:00</span></div>
      <div class="row">vol <input type="range" id="vol" min="0" max="100" value="100"></div>
      <div class="bars" id="bars"></div>
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
    this.$.skin?.addEventListener("change", () => info.onPick((this.$.skin as HTMLSelectElement).value + ".wmz"));
    const seek = this.$.seek as HTMLInputElement;
    seek.addEventListener("pointerdown", () => (this.seeking = true));
    seek.addEventListener("change", () => { this.seeking = false; void playerCmd("seek_to", Number(seek.value)); });
    this.$.vol.addEventListener("input", () => playerCmd("volume", Number((this.$.vol as HTMLInputElement).value) / 100));
  }

  update(s: PlayerState) {
    this.last = s;
    this.$.offline.textContent = s.running
      ? (s.error ?? "")
      : "YouTube Music isn't running; starting it...";
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
    (this.$.vol as HTMLInputElement).value = String(Math.round(s.volume * 100));
  }

  bars(b: number[]) {
    const el = this.$.bars;
    if (el.children.length !== b.length) el.innerHTML = b.map(() => "<i></i>").join("");
    b.forEach((v, i) => ((el.children[i] as HTMLElement).style.height = `${v}%`));
  }
}
