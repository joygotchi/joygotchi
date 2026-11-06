mod hooks;
mod pets;
mod session;

use tauri::{AppHandle, Manager};

pub use hooks::{AgentEvent, HOOK_PORT};
pub use pets::{installed_pets, pets_root, InstalledPet};
pub use session::Session;

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
/// Off by default, and that is the fix for a bug worth remembering: the app
/// used to turn this *on* at startup and rely on the webview's `mouseenter` to
/// turn it back off. A window that ignores cursor events never receives
/// `mouseenter`, so the pet could not be hovered, clicked or dragged — it was
/// a decoration. The flag can only be driven from outside the window it
/// silences, which here means a switch in Settings.
#[tauri::command]
fn set_click_through(window: tauri::Window, ignore: bool) -> Result<(), String> {
    window.set_ignore_cursor_events(ignore).map_err(|e| e.to_string())
}

#[tauri::command]
fn hook_port() -> u16 {
    HOOK_PORT
}

/// Grow the window while a panel is open, and shrink it back after.
///
/// The pet needs a small window; Settings and the pet panel do not fit in one.
/// Overlaying them on 260x300 produced exactly what it sounds like — the pet
/// list behind the wallet section, text wrapping four words at a time. The
/// window stays anchored to its bottom-right corner so it grows upward and
/// leftward rather than walking off the screen.
#[tauri::command]
fn set_panel_open(window: tauri::Window, open: bool) -> Result<(), String> {
    const PET: (u32, u32) = (260, 300);
    const PANEL: (u32, u32) = (340, 460);

    let (width, height) = if open { PANEL } else { PET };

    let anchor = window.outer_position().map_err(|e| e.to_string())?;
    let before = window.outer_size().map_err(|e| e.to_string())?;

    window
        .set_size(tauri::LogicalSize::new(width, height))
        .map_err(|e| e.to_string())?;

    let after = window.outer_size().map_err(|e| e.to_string())?;
    let x = anchor.x + before.width as i32 - after.width as i32;
    let y = anchor.y + before.height as i32 - after.height as i32;
    window
        .set_position(tauri::PhysicalPosition::new(x, y))
        .map_err(|e| e.to_string())
}

/// Open a URL in the player's own browser.
///
/// Their browser, not a window of ours: the wallet sign-in should happen
/// wherever they are already signed in, and a webview we control is the last
/// place anyone should be asked to type a seed phrase.
#[tauri::command]
fn open_url(app: AppHandle, url: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    // Only ever a wallet sign-in, and only ever https.
    if !url.starts_with("https://") {
        return Err("refusing to open a non-https URL".into());
    }
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|error| error.to_string())
}

/// Where the wallet should send the browser back to.
///
/// Built here rather than in the webview so the port can only ever be the one
/// the server is actually listening on.
#[tauri::command]
fn wallet_callback_url() -> String {
    format!("http://127.0.0.1:{HOOK_PORT}/wallet-callback")
}

/// Record a session the wallet just granted.
///
/// The secret key goes to the operating system's keychain; the rest goes to a
/// plain file, because the account id and the public key are not secrets and
/// keeping them readable makes the app's state inspectable.
#[tauri::command]
fn save_session(app: AppHandle, session: Session, secret_key: String) -> Result<(), String> {
    session::save_secret_key(&secret_key)?;
    session::save_session(&app_dir(&app)?, &session)
}

#[tauri::command]
fn get_session(app: AppHandle) -> Result<Option<Session>, String> {
    Ok(session::load_session(&app_dir(&app)?))
}

/// Hand the secret key to the webview for one signing.
///
/// It crosses the boundary on purpose: NEAR transaction signing is borsh plus
/// ed25519, and the well-tested implementation of both is the JavaScript one.
/// Reimplementing it in Rust to avoid this would trade a real risk for a
/// larger one.
#[tauri::command]
fn session_secret_key() -> Option<String> {
    session::load_secret_key()
}

#[tauri::command]
fn clear_session(app: AppHandle) -> Result<(), String> {
    session::clear_session(&app_dir(&app)?)
}

fn app_dir(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|error| format!("no app data directory: {error}"))
}

/// Quit.
///
/// The window has no decorations and stays out of the taskbar, which is what
/// makes it sit over an editor without looking like an app — and it also means
/// there is no close button and no Dock icon to right-click. Without this, the
/// only way out is killing the process.
#[tauri::command]
fn quit(app: AppHandle) {
    app.exit(0);
}

/// Put the pet in the bottom-right corner of the screen it is on.
///
/// Not a fixed x/y in the config: that lands in a different place on every
/// monitor and off-screen entirely on a smaller one. The margin keeps it clear
/// of a macOS Dock or a Windows taskbar without needing to know which is
/// there, and the whole thing is a best effort — a window in the wrong corner
/// is better than a window that failed to open.
fn place_bottom_right(window: &tauri::WebviewWindow) {
    const MARGIN_RIGHT: i32 = 24;
    // Taller than it looks it needs: the pet sits at the bottom of its own
    // window, and a macOS Dock or a Windows taskbar eats the last ~80px of the
    // screen. Clearing both is what keeps the pet from being half-hidden on a
    // machine nobody tested on.
    const MARGIN_BOTTOM: i32 = 110;

    let Ok(Some(monitor)) = window.current_monitor() else {
        return;
    };
    let Ok(size) = window.outer_size() else {
        return;
    };

    let screen = monitor.size();
    let origin = monitor.position();

    let x = origin.x + screen.width as i32 - size.width as i32 - MARGIN_RIGHT;
    let y = origin.y + screen.height as i32 - size.height as i32 - MARGIN_BOTTOM;

    let _ = window.set_position(tauri::PhysicalPosition::new(x.max(origin.x), y.max(origin.y)));
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            list_pets,
            pets_directory,
            set_click_through,
            hook_port,
            quit,
            open_url,
            set_panel_open,
            wallet_callback_url,
            save_session,
            get_session,
            session_secret_key,
            clear_session
        ])
        .setup(|app| {
            let handle = app.handle().clone();

            // The hook server outlives any window: an agent posting an event
            // while the window is hidden should not get a connection refused.
            tauri::async_runtime::spawn(hooks::serve(handle));

            if let Some(window) = app.get_webview_window("pet") {
                place_bottom_right(&window);
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("joygotchi: failed to start");
}
