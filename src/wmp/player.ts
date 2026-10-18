// A WMP object-model shim (`player.*`) backed by the MPRIS state from the backend.
// Properties MPRIS cannot support (balance, EQ, rate) are stored locally and do nothing.
import { emptyState, playerCmd, type PlayerState } from "../backend";

const pad = (n: number) => String(Math.floor(n)).padStart(2, "0");
export function fmtTime(sec: number): string {
  sec = Math.max(0, Math.round(sec || 0));
  const h = Math.floor(sec / 3600);
  return (h ? `${h}:${pad((sec % 3600) / 60)}` : `${Math.floor(sec / 60)}`) + `:${pad(sec % 60)}`;
}

export type PlayerEvent = "playstatechange" | "mediachange" | "openstatechange";

// wmppsXxx play states
const PLAY_STATE = { Playing: 3, Paused: 2, Stopped: 1 } as const;

export class PlayerShim {
  state: PlayerState = emptyState;
  private stateAt = performance.now();
  private listeners: ((e: PlayerEvent, arg?: number) => void)[] = [];
  private muted = false;
  private volBeforeMute = 100;
  private local = { balance: 0, rate: 1, eq: 0 };
  bars: number[] = [];
  vizAvailable = false;
  vizReason: string | null = null;

  onEvent(cb: (e: PlayerEvent, arg?: number) => void) { this.listeners.push(cb); }

  update(s: PlayerState) {
    const prev = this.state;
    this.state = s;
    this.stateAt = performance.now();
    if (prev.status !== s.status) this.emit("playstatechange", this.playState);
    if (prev.track_id !== s.track_id || prev.title !== s.title) this.emit("mediachange");
    if (prev.running !== s.running) this.emit("openstatechange", s.running ? 13 : 0);
  }
  private emit(e: PlayerEvent, arg?: number) { for (const l of this.listeners) l(e, arg); }

  /** Position interpolated between 250 ms polls. */
  get position(): number {
    const s = this.state;
    const extra = s.status === "Playing" ? (performance.now() - this.stateAt) / 1000 : 0;
    const p = s.position_s + extra;
    return s.length_s > 0 ? Math.min(p, s.length_s) : p;
  }
  private get playState() { return PLAY_STATE[this.state.status as keyof typeof PLAY_STATE] ?? 0; }

  private seekTo(sec: number) {
    this.state = { ...this.state, position_s: sec };
    this.stateAt = performance.now();
    void playerCmd("seek_to", sec);
  }
  private setVolume(v: number) {
    v = Math.max(0, Math.min(100, v));
    this.state = { ...this.state, volume: v / 100 };
    void playerCmd("volume", v / 100);
  }

  // ---- the public `player` object handed to skin scripts ----
  readonly api = (() => {
    const self = this;
    const item = () => ({
      get name() { return self.state.title; },
      get duration() { return self.state.length_s; },
      get durationString() { return fmtTime(self.state.length_s); },
      get sourceURL() { return self.state.art_url ?? ""; },
      get imageSourceWidth() { return 0; },
      get imageSourceHeight() { return 0; },
      get attributeCount() { return 4; },
      getItemInfo(k: string) {
        switch (String(k).toLowerCase()) {
          case "title": return self.state.title;
          case "author": case "artist": case "wm/albumartist": return self.state.artist;
          case "album": case "wm/albumtitle": return self.state.album;
          case "duration": return String(self.state.length_s);
          default: return "";
        }
      },
      isIdentical(o: unknown) { return o === this; },
    });
    return {
      controls: {
        play: () => void playerCmd("play"),
        pause: () => void playerCmd("pause"),
        stop: () => void playerCmd("stop"),
        next: () => void playerCmd("next"),
        previous: () => void playerCmd("previous"),
        fastForward: () => void playerCmd("seek_by", 10),
        fastReverse: () => void playerCmd("seek_by", -10),
        playItem: () => void playerCmd("play"),
        get currentPosition() { return self.position; },
        set currentPosition(v: number) { self.seekTo(Number(v)); },
        get currentPositionString() { return fmtTime(self.position); },
        get currentItem() { return item(); },
        isAvailable: (what: string) => self.state.running || String(what).toLowerCase() === "play",
      },
      get currentMedia() { return item(); },
      settings: {
        get volume() { return self.muted ? 0 : Math.round(self.state.volume * 100); },
        set volume(v: number) { self.setVolume(Number(v)); },
        get mute() { return self.muted; },
        set mute(m: boolean) {
          if (m === self.muted) return;
          self.muted = !!m;
          if (self.muted) { self.volBeforeMute = Math.round(self.state.volume * 100); self.setVolume(0); }
          else self.setVolume(self.volBeforeMute);
        },
        get balance() { return self.local.balance; },
        set balance(v: number) { self.local.balance = Number(v); }, // no-op: MPRIS has no balance
        get rate() { return self.local.rate; },
        set rate(v: number) { self.local.rate = Number(v); }, // no-op
        autoStart: true,
        playCount: 1,
        enableErrorDialogs: false,
        getMode(m: string) {
          m = String(m).toLowerCase();
          if (m === "shuffle") return self.state.shuffle;
          if (m === "loop") return self.state.loop_status !== "None";
          return false;
        },
        setMode(m: string, on: boolean) {
          m = String(m).toLowerCase();
          if (m === "shuffle") void playerCmd("shuffle", on ? 1 : 0);
          else if (m === "loop") void playerCmd("loop", undefined, on ? "Playlist" : "None");
        },
        isAvailable: () => true,
      },
      get playState() { return self.playState; },
      get openState() { return self.state.running ? 13 : 0; },
      get status() {
        if (!self.state.running) return "YouTube Music is not running";
        return self.state.status === "Playing" ? "Playing" : self.state.status === "Paused" ? "Paused" : "Stopped";
      },
      get URL() { return ""; },
      set URL(_v: string) { /* we never open media ourselves */ },
      currentPlaylist: {
        get count() { return self.state.title ? 1 : 0; },
        get name() { return "Now Playing"; },
        item: () => item(),
      },
      uiMode: "none",
      enableContextMenu: false,
      fullScreen: false,
      versionInfo: "7.0.0.0",
      close: () => void import("@tauri-apps/api/window").then((m) => m.getCurrentWindow().close()),
      launchURL: () => {},
      // visualizer data, exposed for skins that look for it
      get bars() { return self.bars; },
    };
  })();
}
