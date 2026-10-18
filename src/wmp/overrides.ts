// Small per-skin adjustments, keyed by the skin's file name (lower case, without `.wmz`).
// They change how a skin *behaves* here without touching the skin files themselves.

export interface SkinOverride {
  /** exact text replacements applied to the skin's script before it runs */
  scriptPatches?: [from: string, to: string][];
  /** view timers run this many times faster (animations driven by `view.timerInterval`) */
  timerSpeed?: number;
  /** double-clicking the skin runs `run` when the `when` expression is true (e.g. to skip an intro) */
  doubleClick?: { when: string; run: string };
}

export const OVERRIDES: Record<string, SkinOverride> = {
  // Its 568-frame shutter intro is skipped when media is playing; always play it, at double speed,
  // and let a double-click jump to the last frame (the next timer tick then shows the player).
  alienware_invader_by_the_skins_factory: {
    scriptPatches: [["frameCount==568||player.playState==3||player.openState==12", "frameCount==568"]],
    timerSpeed: 2,
    doubleClick: { when: "!introStatus", run: "frameCount = 567;" },
  },
};

export const overrideFor = (skinName: string): SkinOverride =>
  OVERRIDES[skinName.toLowerCase().replace(/\.wmz$/, "")] ?? {};
