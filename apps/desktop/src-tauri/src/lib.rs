mod hooks;
mod pets;

use tauri::Manager;

pub use hooks::{AgentEvent, HOOK_PORT};
pub use pets::{installed_pets, pets_root, InstalledPet};

/// Pets on this machine, for the Settings list.
#[tauri::command]
fn list_pets() -> Vec<InstalledPet> {
    installed_pets()
}

/// Where the CLI puts them, so Settings can say so when the list is empty.
#[tauri::command]
fn pets_directory() -> String {
    pets_root().to_string_lossy().into_owned()
}

/// Let clicks through to whatever is behind the pet.
///
/// The window covers a rectangle but the pet is a small sprite in the middle of
/// it; without this, a transparent corner of the window eats clicks meant for
/// the editor underneath. The frontend turns it off while the cursor is over
/// the pet itself so the pet stays clickable.
#[tauri::command]
fn set_click_through(window: tauri::Window, ignore: bool) -> Result<(), String> {
    window.set_ignore_cursor_events(ignore).map_err(|e| e.to_string())
}

#[tauri::command]
fn hook_port() -> u16 {
    HOOK_PORT
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            list_pets,
            pets_directory,
            set_click_through,
            hook_port
        ])
        .setup(|app| {
            let handle = app.handle().clone();

            // The hook server outlives any window: an agent posting an event
            // while the window is hidden should not get a connection refused.
            tauri::async_runtime::spawn(hooks::serve(handle));

            if let Some(window) = app.get_webview_window("pet") {
                let _ = window.set_ignore_cursor_events(true);
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("joygotchi: failed to start");
}
