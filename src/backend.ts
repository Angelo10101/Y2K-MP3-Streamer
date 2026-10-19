// Thin typed wrapper around the Tauri backend.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export interface PlayerState {
  running: boolean;
  bus_name: string | null;
  status: "Playing" | "Paused" | "Stopped" | string;
  title: string;
  artist: string;
  album: string;
  art_url: string | null;
  track_id: string;
  length_s: number;
  position_s: number;
  volume: number; // 0..1
  shuffle: boolean;
  loop_status: "None" | "Track" | "Playlist" | string;
  error: string | null;
}

export const emptyState: PlayerState = {
  running: false, bus_name: null, status: "Stopped", title: "", artist: "", album: "",
  art_url: null, track_id: "", length_s: 0, position_s: 0, volume: 1, shuffle: false,
  loop_status: "None", error: null,
};

export const inTauri = "__TAURI_INTERNALS__" in window;

export function playerCmd(cmd: string, num?: number, text?: string): Promise<void> {
  if (!inTauri) return Promise.resolve();
  return invoke<void>("player_cmd", { cmd, num, text }).catch((e) => console.warn("player_cmd", cmd, e));
}

export function onPlayerState(cb: (s: PlayerState) => void): void {
  if (!inTauri) return;
  void listen<PlayerState>("player-state", (e) => cb(e.payload));
}

export function onViz(cb: (bars: number[]) => void, status: (ok: boolean, reason: string | null) => void): void {
  if (!inTauri) return;
  void listen<number[]>("viz-bars", (e) => cb(e.payload));
  void listen<{ available: boolean; reason: string | null }>("viz-status", (e) => status(e.payload.available, e.payload.reason));
}

export interface SkinList { dir: string; skins: string[] }
export const listSkins = () => invoke<SkinList>("list_skins");
export async function readSkin(name: string): Promise<Uint8Array> {
  return new Uint8Array(await invoke<ArrayBuffer>("read_skin", { name }));
}
export const setInputShape = (rects: number[][]) => invoke("set_input_shape", { rects }).catch(() => {});

export interface QueueItem { index: number; video_id: string; title: string; artist: string; duration: string; selected: boolean; thumb: string | null }
export const queueGet = () => invoke<QueueItem[]>("queue_get");
export const queueSelect = (index: number) => invoke<void>("queue_select", { index });

export interface PearStatus { running: boolean; message: string | null }
export const pearStart = () => invoke<PearStatus>("pear_start");
export const pearHide = () => invoke<void>("pear_hide");
export const pearShow = () => invoke<void>("pear_show");

/** Name of the playback source in UI text; set from the backend once at startup. */
export let sourceName = "YouTube Music";

export async function startupOptions() {
  const o = await invoke<{ skin: string | null; debug: boolean; source: string }>("startup_options");
  sourceName = o.source;
  return o;
}
