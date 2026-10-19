//! X11 window hints for compositors (Linux).

use std::time::Duration;

use x11rb::connection::Connection;
use x11rb::protocol::xproto::{AtomEnum, ConnectionExt, PropMode};
use x11rb::rust_connection::RustConnection;
use x11rb::wrapper::ConnectionExt as _;

/// Our window is transparent and larger than most skins, so compositors such as picom draw a
/// big drop shadow (and blur) *through* it. Compositors skip shadows for windows that carry a
/// `_GTK_FRAME_EXTENTS` property (what GTK sets on client-side-decorated windows), so set an empty
/// one on our window.
pub fn mark_no_shadow() {
    for _ in 0..40 {
        if try_mark().unwrap_or(false) {
            return;
        }
        std::thread::sleep(Duration::from_millis(250));
    }
}

fn try_mark() -> Result<bool, Box<dyn std::error::Error>> {
    let (conn, screen) = RustConnection::connect(None)?;
    let root = conn.setup().roots[screen].root;
    let atom = |n: &str| -> Result<u32, Box<dyn std::error::Error>> { Ok(conn.intern_atom(false, n.as_bytes())?.reply()?.atom) };
    let (list, extents) = (atom("_NET_CLIENT_LIST")?, atom("_GTK_FRAME_EXTENTS")?);
    let wins: Vec<u32> = conn
        .get_property(false, root, list, AtomEnum::WINDOW, 0, 4096)?
        .reply()?
        .value32()
        .map(|i| i.collect())
        .unwrap_or_default();
    let mut done = false;
    for w in wins {
        let cls = conn.get_property(false, w, AtomEnum::WM_CLASS, AtomEnum::STRING, 0, 256)?.reply()?;
        if String::from_utf8_lossy(&cls.value).contains("Y2k-mp3-streamer") {
            conn.change_property32(PropMode::REPLACE, w, extents, AtomEnum::CARDINAL, &[0, 0, 0, 0])?;
            done = true;
        }
    }
    conn.flush()?;
    Ok(done)
}
