mod api_player;
#[cfg(target_os = "linux")]
mod cava;
mod dsp;
#[cfg(target_os = "linux")]
mod mpris;
mod pear;
mod player;
mod skins;
mod spotify;
#[cfg(windows)]
mod smtc;
#[cfg(target_os = "linux")]
mod x11tweaks;
#[cfg(windows)]
mod viz_win;
#[cfg(windows)]
mod win;

use player::Player;
use tauri::{Emitter, Manager, State};

#[tauri::command]
async fn player_state(m: State<'_, Player>) -> Result<player::PlayerState, ()> {
    Ok(m.snapshot().await)
}

#[tauri::command]
async fn player_cmd(
    m: State<'_, Player>,
    cmd: String,
    num: Option<f64>,
    text: Option<String>,
) -> Result<(), String> {
    m.command(&cmd, num, text).await
}

#[tauri::command]
async fn pear_start() -> Result<pear::PearStatus, String> {
    if spotify::active() {
        return tauri::async_runtime::spawn_blocking(spotify::start).await.map_err(|e| e.to_string());
    }
    tauri::async_runtime::spawn_blocking(pear::start).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn pear_hide() -> Result<(), String> {
    // Closing Spotify's window may quit it, so with Spotify both windows just stay visible.
    if spotify::active() {
        return Ok(());
    }
    tauri::async_runtime::spawn_blocking(pear::hide_window).await.map_err(|e| e.to_string())?
}

/// Brings Pear's window back (starting Pear first if it isn't running).
#[tauri::command]
async fn pear_show(m: State<'_, Player>) -> Result<(), String> {
    if spotify::active() {
        if !spotify::is_running() {
            tauri::async_runtime::spawn_blocking(spotify::start).await.map_err(|e| e.to_string())?;
            return Ok(());
        }
        return m.command("raise", None, None).await;
    }
    if !pear::is_running() {
        tauri::async_runtime::spawn_blocking(pear::start).await.map_err(|e| e.to_string())?;
        return Ok(());
    }
    #[cfg(windows)]
    {
        let _ = &m;
        return tauri::async_runtime::spawn_blocking(pear::show_window).await.map_err(|e| e.to_string())?;
    }
    #[cfg(not(windows))]
    m.command("raise", None, None).await
}

#[tauri::command]
async fn queue_get() -> Result<Vec<pear::QueueItem>, String> {
    if spotify::active() {
        return Err("Spotify has no queue API".into()); // the playlist drawer falls back to the current track
    }
    tauri::async_runtime::spawn_blocking(pear::queue).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn queue_select(index: usize) -> Result<(), String> {
    if spotify::active() {
        return Err("Spotify has no queue API".into());
    }
    tauri::async_runtime::spawn_blocking(move || pear::select(index)).await.map_err(|e| e.to_string())?
}

#[derive(serde::Serialize)]
struct StartupOptions {
    /// `RETRO_SKIN=Goo` (or `Goo.wmz`): open this skin's player straight away (development aid)
    skin: Option<String>,
    /// `RETRO_DEBUG=1`: log which skin elements are under every click
    debug: bool,
    /// Name of the playback source for UI text: "YouTube Music" or "Spotify"
    source: &'static str,
}

fn source_name() -> &'static str {
    spotify::source_name()
}

#[tauri::command]
fn startup_options() -> StartupOptions {
    StartupOptions { skin: std::env::var("RETRO_SKIN").ok().filter(|s| !s.is_empty()), debug: std::env::var_os("RETRO_DEBUG").is_some(), source: source_name() }
}

/// Restricts mouse input to the given `[x, y, w, h]` rectangles (the opaque part
/// of the skin) so clicks on transparent regions fall through to windows below.
#[tauri::command]
fn set_input_shape(window: tauri::WebviewWindow, rects: Vec<[i32; 4]>) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        use gtk::cairo::{RectangleInt, Region};
        use gtk::prelude::*;
        let w = window.clone();
        window
            .run_on_main_thread(move || {
                let Ok(gtk_window) = w.gtk_window() else { return };
                let Some(gdk) = gtk_window.window() else { return };
                let region = Region::create();
                for [x, y, w, h] in rects {
                    let _ = region.union_rectangle(&RectangleInt::new(x, y, w, h));
                }
                gdk.input_shape_combine_region(&region, 0, 0);
            })
            .map_err(|e| e.to_string())?;
    }
    #[cfg(windows)]
    {
        if rects.is_empty() {
            return Ok(());
        }
        let hwnd = window.hwnd().map_err(|e| e.to_string())?.0 as isize;
        let scale = window.scale_factor().unwrap_or(1.0);
        window.run_on_main_thread(move || win::set_window_region(hwnd, &rects, scale)).map_err(|e| e.to_string())?;
    }
    #[cfg(not(any(target_os = "linux", windows)))]
    let _ = (window, rects);
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            player_state,
            player_cmd,
            set_input_shape,
            startup_options,
            pear_start,
            pear_hide,
            pear_show,
            queue_get,
            queue_select,
            skins::list_skins,
            skins::read_skin
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            let m = tauri::async_runtime::block_on(Player::connect());
            app.manage(m.clone());
            tauri::async_runtime::spawn({
                let handle = handle.clone();
                async move {
                    loop {
                        let _ = handle.emit("player-state", m.snapshot().await);
                        tokio::time::sleep(player::POLL).await;
                    }
                }
            });
            #[cfg(target_os = "linux")]
            tauri::async_runtime::spawn(cava::run(handle));
            #[cfg(windows)]
            tauri::async_runtime::spawn(viz_win::run(handle));
            #[cfg(not(any(target_os = "linux", windows)))]
            let _ = handle.emit("viz-status", serde_json::json!({ "available": false, "reason": "no audio capture on this platform" }));
            #[cfg(target_os = "linux")]
            std::thread::spawn(x11tweaks::mark_no_shadow);
            // A utility-type window floats under tiling WMs (i3, sway) instead of being tiled.
            #[cfg(target_os = "linux")]
            if let Some(w) = app.get_webview_window("main") {
                use gtk::prelude::GtkWindowExt;
                if let Ok(g) = w.gtk_window() {
                    g.set_type_hint(gtk::gdk::WindowTypeHint::Utility);
                }
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running app");
}
