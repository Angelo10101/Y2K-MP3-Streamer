//! Windows-only helpers: finding/hiding/showing Pear's window and shaping our own window.

use windows_sys::core::BOOL;
use windows_sys::Win32::Foundation::{HWND, LPARAM};
use windows_sys::Win32::Graphics::Gdi::{CombineRgn, CreateRectRgn, DeleteObject, SetWindowRgn, RGN_OR};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetClassNameW, GetWindowTextW, IsWindowVisible, PostMessageW, SetForegroundWindow, ShowWindow,
    SW_RESTORE, SW_SHOW, WM_CLOSE,
};

/// Chromium/Electron top-level windows whose title contains this belong to Pear.
const TITLE: &str = "YouTube Music";
const CLASS: &str = "Chrome_WidgetWin_1";

unsafe extern "system" fn collect(hwnd: HWND, lparam: LPARAM) -> BOOL {
    let out = &mut *(lparam as *mut Vec<(isize, bool)>);
    let mut cls = [0u16; 64];
    let n = GetClassNameW(hwnd, cls.as_mut_ptr(), cls.len() as i32);
    if n <= 0 || String::from_utf16_lossy(&cls[..n as usize]) != CLASS {
        return 1;
    }
    let mut title = [0u16; 256];
    let t = GetWindowTextW(hwnd, title.as_mut_ptr(), title.len() as i32);
    if t <= 0 || !String::from_utf16_lossy(&title[..t as usize]).contains(TITLE) {
        return 1;
    }
    out.push((hwnd as isize, IsWindowVisible(hwnd) != 0));
    1 // keep enumerating
}

/// `(hwnd, visible)` for every Pear window, including ones hidden to the tray.
fn pear_windows() -> Vec<(isize, bool)> {
    let mut found: Vec<(isize, bool)> = Vec::new();
    unsafe {
        EnumWindows(Some(collect), &mut found as *mut Vec<(isize, bool)> as LPARAM);
    }
    found
}

/// Asks Pear's visible windows to close; with the tray option on, Pear hides instead of quitting.
pub fn close_pear_windows() -> Result<(), String> {
    for (hwnd, visible) in pear_windows() {
        if visible {
            unsafe {
                PostMessageW(hwnd as HWND, WM_CLOSE, 0, 0);
            }
        }
    }
    Ok(())
}

/// Shows and focuses Pear's window. Returns false if no Pear window exists at all.
pub fn show_pear_windows() -> Result<bool, String> {
    let wins = pear_windows();
    for (hwnd, _) in &wins {
        unsafe {
            ShowWindow(*hwnd as HWND, SW_SHOW);
            ShowWindow(*hwnd as HWND, SW_RESTORE);
            SetForegroundWindow(*hwnd as HWND);
        }
    }
    Ok(!wins.is_empty())
}

/// Clips a window (and its input) to the union of `[x, y, w, h]` rectangles given in CSS pixels.
/// Clicks on everything outside fall through to the windows below.
pub fn set_window_region(hwnd: isize, rects: &[[i32; 4]], scale: f64) {
    let px = |v: i32| (v as f64 * scale).round() as i32;
    unsafe {
        let region = CreateRectRgn(0, 0, 0, 0);
        for [x, y, w, h] in rects {
            let r = CreateRectRgn(px(*x), px(*y), px(x + w).max(px(*x) + 1), px(y + h).max(px(*y) + 1));
            CombineRgn(region, region, r, RGN_OR);
            DeleteObject(r);
        }
        // the system owns the region after this call
        SetWindowRgn(hwnd as HWND, region, 1);
    }
}
