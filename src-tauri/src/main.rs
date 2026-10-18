mod cava;
mod mpris;
mod pear;
mod skins;

use mpris::Mpris;
use tauri::{Emitter, Manager, State};


#[tauri::command]
async fn player_state(m: State<'_, Mpris>) -> Result<mpris::PlayerState, ()> {
    Ok(m.snapshot().await)
}

#[tauri::command]
async fn player_cmd(
    m: State<'_, Mpris>,
    cmd: String,
    num: Option<f64>,
    text: Option<String>,
) -> Result<(), String> {
    m.command(&cmd, num, text).await
}

#[tauri::command]
async fn pear_start() -> Result<pear::PearStatus, String> {
    tauri::async_runtime::spawn_blocking(pear::start).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn pear_hide() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(pear::hide_window).await.map_err(|e| e.to_string())?
}

/// Brings Pear's window back (starting Pear first if it isn't running).
#[tauri::command]
async fn pear_show(m: State<'_, Mpris>) -> Result<(), String> {
    if !pear::is_running() {
        tauri::async_runtime::spawn_blocking(pear::start).await.map_err(|e| e.to_string())?;
        return Ok(());
    }
    m.command("raise", None, None).await
}

#[tauri::command]
async fn queue_get() -> Result<Vec<pear::QueueItem>, String> {
    tauri::async_runtime::spawn_blocking(pear::queue).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn queue_select(index: usize) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || pear::select(index)).await.map_err(|e| e.to_string())?
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
    #[cfg(not(target_os = "linux"))]
    let _ = (window, rects);
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            player_state,
            player_cmd,
            set_input_shape,
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
            let m = tauri::async_runtime::block_on(Mpris::connect())?;
            app.manage(m.clone());
            tauri::async_runtime::spawn({
                let handle = handle.clone();
                async move {
                    loop {
                        let _ = handle.emit("player-state", m.snapshot().await);
                        tokio::time::sleep(mpris::POLL).await;
                    }
                }
            });
            tauri::async_runtime::spawn(cava::run(handle));
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
