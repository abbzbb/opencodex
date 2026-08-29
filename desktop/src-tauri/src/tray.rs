use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, Runtime};

pub const TRAY_OPEN: &str = "open";
pub const TRAY_STATUS: &str = "status";
pub const TRAY_QUIT: &str = "quit";

pub fn install_tray<R: Runtime, F>(app: &AppHandle<R>, on_menu: F) -> tauri::Result<()>
where
    F: Fn(&AppHandle<R>, &str) + Send + Sync + 'static,
{
    let open = MenuItem::with_id(app, TRAY_OPEN, "Open", true, None::<&str>)?;
    let status = MenuItem::with_id(app, TRAY_STATUS, "Status", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, TRAY_QUIT, "Quit", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&open, &status, &separator, &quit])?;
    let mut builder = TrayIconBuilder::with_id("opencodex-tray")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .tooltip("OpenCodex")
        .on_menu_event(move |app, event| {
            on_menu(app, event.id.as_ref());
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

pub fn show_main_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tray_ids_are_open_status_quit() {
        assert_eq!(TRAY_OPEN, "open");
        assert_eq!(TRAY_STATUS, "status");
        assert_eq!(TRAY_QUIT, "quit");
    }
}
