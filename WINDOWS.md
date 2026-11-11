# Windows handoff

Written on Linux, where nothing Windows-only can be compiled or run. Everything below is untested on
Windows. The README's Windows section says the same. Work through this list top to bottom.

## 1. Build and test first
- `npm ci && npm test && npm run build && cd src-tauri && cargo test`, then `npm run tauri dev`.
- The last Linux-side edits touched `src-tauri/src/win.rs` and `pear.rs` blind. If they don't compile,
  fix them. They add: process-based Pear window matching (`GetWindowThreadProcessId`,
  `OpenProcess`, `QueryFullProcessImageNameW`, new `Win32_System_Threading` feature in `Cargo.toml`),
  `is_pear_exe` (portable and unit-tested), `EXES` (YouTube Music.exe and Pear Desktop.exe), and a config path that
  tries both `%APPDATA%\YouTube Music` and `%APPDATA%\Pear Desktop`.
- Check the GitHub Actions `windows` job on the latest push.

## 2. Verify, in this order
1. Launch with Pear closed: does the app start Pear (`pear::start`), patch its config
   (`%APPDATA%\<folder>\config.json`) and reach the API at 127.0.0.1:26538? Which folder and exe
   name does the installed Pear use? Fix `pear.rs` candidates if it isn't one of the guesses.
2. Transparent window: does the 900x600 home window render (WebView2, `transparent: true`)? Is a click on a
   transparent part of a skin passed through (`win::set_window_region`, `SetWindowRgn`)? Check at
   100% and 150% display scaling (`scale_factor` is applied to the rects) and on a second monitor.
3. Hide/show: *Open player* hides Pear's window; *Home* shows it again (`close_pear_windows`,
   `show_pear_windows`). **Open a YouTube Music tab in Chrome/Edge first** and make sure hiding does
   NOT close the browser window (this was a bug: title matching alone matched browser tabs).
4. Controls: play/pause, next/previous, seek, volume, shuffle, repeat through the API
   (`api_player.rs`); the playlist drawer shows Pear's queue and double-click plays a row.
5. Stop button: pauses, quits Pear if this app started it, quits the app. It must not close a Pear you started.
6. Visualizer: WASAPI loopback (`viz_win.rs`). Bars move with sound, go flat on silence, and survive
   switching the default output device (headphones <-> speakers; probably needs a stream restart),
   including Bluetooth devices.
7. Skins load from `skins\` or `%APPDATA%\y2k-mp3-streamer\skins`: a `.wmz` (Headspace), a `.wsz` (TRON),
   and the WMP legacy visualizers (`vendor/wmp-legacy-visualizers`) in WebView2.
8. `RETRO_SOURCE=spotify`: SMTC backend (`smtc.rs`) against a real Spotify client.
9. Do the Linux-only workarounds hurt on Windows? `src/repaint.ts` is Linux-only by user agent; confirm
   that WebView2 has no repaint problem and the window does not keep consuming CPU.

## 3. Known gap: no browser tab following on Windows
On Linux the app follows whichever MPRIS player is really playing (`mpris.rs`, `find_player`), so music
started in a browser tab drives the UI. On Windows the Pear API backend only talks to Pear, so music
playing in a browser tab is ignored, and an idle Pear (default song, position 0, reported as
"Playing") is shown. Suggested fix: reuse `smtc.rs` to read the SMTC session that is really playing (the one
with `Playing` and an advancing position) and prefer it over an idle Pear. Linux's rule is in
`mpris.rs::idle_playing`. The queue drawer already falls back to the current track when there is no queue
(`queue_get` returns an error while following an external player).

## 4. Other things to look at
- Pear reports position in whole seconds, so the UI smooths it.
- After fixes, update the README's "not run on Windows" status text and the Windows section.
- Don't add Claude attribution to commit messages (the user's rule for this repo).
