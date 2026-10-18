# retro-mp3-yt-music
Y2K themed front-end for YouTube music on Linux

Has swappable retro skins and real audio visualizer.
Controls playback over MPRIS and renders in custom retro skins with
cava-powered visualisers.

Inspired by a reel: https://www.instagram.com/p/Delqq-ngEdE/

Pulling skins from old Windows Media Player skins: https://archive.org/details/windowsmediaplayerskinscollection

## How it works

```
YouTube Music desktop app  --MPRIS/D-Bus-->  Tauri backend (Rust)  --events-->  skin renderer (TS)
  (login, streaming, ads)                       zbus + cava                      .wmz/.wms + JScript shim
```

- **Playback engine:** [th-ch's YouTube Music desktop app (now called [Pear Desktop](https://github.com/pear-devs/pear-desktop)) runs in the background. This app never talks to YouTube.
- **Control:** play/pause/stop/next/previous, seek, volume, shuffle/repeat and track metadata over MPRIS.
- **Skins:** real Windows Media Player `.wmz` skins are unzipped, their `.wms` layout is parsed and rendered, and the skin's own JScript runs against a `player.*` shim that maps onto MPRIS.
- **Visualizer:** [cava](https://github.com/karlstav/cava) reads PipeWire and streams bar data to the skin's effects area.

## Install (Arch / EndeavourOS)

1. System packages:
   ```sh
   sudo pacman -S --needed base-devel webkit2gtk-4.1 gtk3 librsvg rust nodejs npm cava
   yay -S pear-desktop-bin         # the playback engine, formerly youtube-music-bin (AUR)
   ```
   `cava` is optional (no visualizer without it). Other distros: see the [Tauri 2 prerequisites](https://tauri.app/start/prerequisites/#linux).
2. Clone and install JS dependencies:
   ```sh
   git clone <this repo> && cd retro-mp3-yt-music
   npm install
   ```
3. **Add a skin.** Skins are copyrighted and are *not* in this repo (`skins/` is gitignored). Put `.wmz` files in `skins/`, e.g. `skins/Headspace.wmz`. Old WMP skins are collected at the [Internet Archive](https://archive.org/details/windowsmediaplayerskinscollection).
   - Skins are searched for in `$RETRO_SKINS_DIR`, `./skins`, next to the executable, then `~/.local/share/retro-mp3-yt-music/skins`.
   - To try the app without a real skin: `python3 scripts/make_test_skin.py` generates a small original `skins/TestSkin.wmz`.
4. Nothing else to do for the player: on first launch this app starts Pear itself and, if needed, edits Pear's config (`~/.config/YouTube Music/config.json`, a backup is saved as `config.json.bak-retro-mp3`) to enable the MPRIS and API-server plugins, hide-to-tray on close, and no auto-resume. Log in to your Google account once in Pear's window.
5. Run this app:
   ```sh
   npm run tauri dev        # development
   npm run tauri build      # release binary in src-tauri/target/release
   ```
   If YouTube Music isn't running the app tells you so and keeps retrying.

### How it works day to day
- **Home:** Pear's own YouTube Music window (everything: home, library, playlists, search) plus a small companion panel with the skin chooser, mini controls and an *Open YouTube Music* button.
- **Start any song in Pear:** the home screen is hidden and the skinned player opens. Resuming the same song or a song auto-advancing doesn't switch.
- **In the player:** the *playlist* drawer shows Pear's real queue (double-click to play a row). The *return to full mode* button (or right-click > Home) hides the player and brings the home screen back. Only one of the two is ever visible.
- Hiding Pear's window works on **X11** (we close it politely and Pear hides to its tray). On Wayland the window can't be hidden, so both stay visible.
- Under i3 add `for_window [class="com.github.th-ch.youtube-music"] floating enable` if you'd rather not have Pear tile.
- Quitting this app leaves Pear (and your music) running.

### Using it
- Drag the skin body to move the window. Buttons, sliders and the visualizer behave as the skin defines.
- **Right-click** the skin for the menu: choose a skin, toggle always-on-top, open the plain control panel, or quit.
- The home panel has the skin chooser (the last choice is remembered). With no skins, it explains where to put them.
- Check that the player is visible to MPRIS: bus names containing `youtube` or `pear` are used. Set `RETRO_MPRIS_ANY=1` to fall back to any other MPRIS player (e.g. YouTube Music in a browser) instead. Set `RETRO_MPRIS_PLAYER=<substring>` if yours is named differently.

### Tiling window managers (i3, sway)
The window sets a utility type hint so i3 floats it automatically. If yours still tiles it, add `for_window [class="Retro-mp3-yt-music"] floating enable` to your i3 config. The window has no titlebar; drag the skin body to move it.

### Rendering stalls (window only updates when hovered)
On hybrid AMD/NVIDIA laptops WebKitGTK's GPU buffer path can stop presenting frames until an input event arrives. The app therefore starts WebKit in software-compositing mode (`WEBKIT_DISABLE_DMABUF_RENDERER=1`, `WEBKIT_DISABLE_COMPOSITING_MODE=1`), which is plenty for a 2D skin. Set `RETRO_WEBKIT_GPU=1` to keep WebKit's defaults.

### Window transparency
The window is frameless and transparent. You need a compositing manager for the transparent parts to look right: KDE Plasma has one built in; on i3 run e.g. `picom -b`. Without a compositor the transparent areas render black.

Clicks on transparent parts of the skin fall through to the window below (GTK input shape region). Verified on X11 (i3 + picom); on Wayland GTK3 maps it to the surface input region, which should also work but is less tested. If it misbehaves on Wayland, run through XWayland: `GDK_BACKEND=x11 npm run tauri dev`.

## Skin support

Implemented subset of the WMP skin object model:

| Feature | Status |
| --- | --- |
| `view` (size, `backgroundImage`, `clippingColor`/`clippingImage` window shape) | yes |
| `subview` (nesting, visibility, `transparencyColor`, move/alpha animation via `moveTo`/`alphaBlendTo`) | yes |
| `buttonelement` / `button` with hover/down/disabled images | yes |
| WMP's special buttons (`prevelement`, `playelement`, `stopelement`, `nextelement`, `pausebutton`, mute/shuffle/repeat/ff/rw) with built-in actions and automatic enabled state | yes |
| `buttongroup` with `mappingImage` hit-testing | yes |
| `slider` / `customslider` (thumb, foreground/position image, vertical, `borderSize`) | yes |
| `text` (`wmpprop:` bindings, scrolling, fonts, justification) | yes |
| `effects` (bars / scope driven by cava) | yes |
| `playlist` | current track only (see limitations) |
| `wmpprop:` / `wmpenabled:` / `wmpdisabled:` bindings | yes |
| Theme JScript (`scriptFile`, inline `jscript:` handlers) | yes, best effort |
| attribute expressions (`left="jscript:a.left+10;"`), `scriptFile` lists (`res://` DLL entries are replaced by built-in constants), case-insensitive `player.*` names | yes |
| `video`, `vbscript:` | no (placeholders / ignored) |

`player.*` shim: `controls.*`, `currentMedia.*` (`name`, `duration`, `getItemInfo`), `settings.volume/mute/getMode/setMode`, `playState`, `status`, `currentPlaylist` (one item). Player events `onplaystatechange` / `onmediachange` / `onopenstatechange` are dispatched to elements that declare them and to same-named global script functions.

## Tested skins
- **Headspace** (WMP 7-10): head shape, transport controls with enabled/disabled states, pause/play swap, seek and volume sliders, visualizer in the head's screen with a preset chooser, sliding EQ and playlist drawers, minimize/close. The EQ and balance sliders move but do nothing.
- A generated `TestSkin.wmz` (`scripts/make_test_skin.py`).

## Known limitations
- **Visualizer presets** are our own (bars, mirror, scope, dots), not WMP's effect plugins; **video** isn't supported (YouTube Music plays audio).
- **"Return to full mode"** (WMP's skin-to-full-player button) raises the YouTube Music app's own window via MPRIS `Raise`; it does nothing if the player doesn't support that.
- **EQ, balance, playback rate:** rendered and animated but they do nothing, since MPRIS has no equivalent.
- **Playlist:** the queue comes from Pear's local API server (`127.0.0.1:26538`, no auth, localhost only). If it is unreachable the drawer falls back to the current track.
- **Skin scripts are untrusted code.** They run in a restricted scope (only a small allow-list of JS globals plus `player`, `view`, `theme` and the skin's elements), but this is best effort, not a security boundary. Only install skins you trust.
- Skin-script compatibility is validated against a synthetic skin and the WMP documentation; real skins may use attributes or script features not yet implemented. Unsupported elements are logged to the dev console (`[skin] <tag> not supported`).
- Seeking uses MPRIS `SetPosition`, falling back to relative `Seek`.

## Development
No YouTube Music app handy? `python3 scripts/fake_mpris.py` registers a fake player on D-Bus (needs `python-dbus` and `python-gobject`).

```sh
npm test                    # unit tests (WMS parser)
node_modules/.bin/tsc --noEmit
cd src-tauri && cargo check
```
