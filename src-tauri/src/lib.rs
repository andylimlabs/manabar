use std::io::Write;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use tauri::menu::{CheckMenuItem, Menu, MenuItem, Submenu};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Monitor, WebviewUrl, WebviewWindowBuilder};

/// Window height in logical points: 8px weekly strip + 4px session bar,
/// plus headroom for the floating readout pill.
const BAR_HEIGHT: f64 = 38.0;
const RECONCILE_SECS: u64 = 15;

/// Show a bar on every display (tray-toggleable, persisted).
static ALL_DISPLAYS: AtomicBool = AtomicBool::new(true);
static BARS_HIDDEN: AtomicBool = AtomicBool::new(false);
/// Labels-only mode: hide the meter strips, keep the readout pill.
static LABELS_ONLY: AtomicBool = AtomicBool::new(false);
/// Last successful usage payload; lets a late-joining bar catch up instantly
/// instead of waiting for the primary window's next poll.
static LAST_USAGE: Mutex<Option<String>> = Mutex::new(None);
/// Readout pill placement: "left" | "center" | "right" (empty = right).
static LABEL_POS: Mutex<String> = Mutex::new(String::new());

fn label_pos() -> String {
    let p = LABEL_POS.lock().unwrap().clone();
    if p.is_empty() {
        "right".into()
    } else {
        p
    }
}

fn keychain_token() -> Result<String, String> {
    let out = Command::new("security")
        .args(["find-generic-password", "-s", "Claude Code-credentials", "-w"])
        .output()
        .map_err(|e| format!("security spawn: {e}"))?;
    if !out.status.success() {
        return Err("keychain read denied or entry missing".into());
    }
    let creds: serde_json::Value =
        serde_json::from_slice(&out.stdout).map_err(|e| format!("credentials parse: {e}"))?;
    creds["claudeAiOauth"]["accessToken"]
        .as_str()
        .map(|s| s.to_string())
        .ok_or_else(|| "no accessToken in credentials".into())
}

fn query_usage(token: &str) -> Result<String, String> {
    // Token goes to curl over stdin (-H @-) so it never appears in argv.
    let mut child = Command::new("curl")
        .args([
            "-s",
            "-m",
            "10",
            "-w",
            "\n%{http_code}",
            "https://api.anthropic.com/api/oauth/usage",
            "-H",
            "@-",
            "-H",
            "anthropic-beta: oauth-2025-04-20",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("curl spawn: {e}"))?;
    child
        .stdin
        .take()
        .ok_or("no curl stdin")?
        .write_all(format!("Authorization: Bearer {token}").as_bytes())
        .map_err(|e| format!("curl stdin write: {e}"))?;
    let out = child
        .wait_with_output()
        .map_err(|e| format!("curl wait: {e}"))?;
    let raw = String::from_utf8_lossy(&out.stdout).to_string();
    let (body, status) = raw.rsplit_once('\n').unwrap_or((raw.as_str(), ""));
    if status.trim() != "200" {
        let head: String = body.chars().take(120).collect();
        return Err(format!("http {}: {head}", status.trim()));
    }
    if body.trim_start().starts_with('{') {
        Ok(body.to_string())
    } else {
        let head: String = body.chars().take(120).collect();
        Err(format!("unexpected response: {head}"))
    }
}

#[tauri::command]
async fn fetch_usage() -> Result<String, String> {
    let result = tauri::async_runtime::spawn_blocking(|| {
        let token = keychain_token()?;
        query_usage(&token)
    })
    .await
    .map_err(|e| e.to_string())?;
    if let Ok(body) = &result {
        *LAST_USAGE.lock().unwrap() = Some(body.clone());
    }
    result
}

#[tauri::command]
fn cached_usage() -> Option<String> {
    LAST_USAGE.lock().unwrap().clone()
}

#[tauri::command]
fn get_label_position() -> String {
    label_pos()
}

#[tauri::command]
fn get_labels_only() -> bool {
    LABELS_ONLY.load(Ordering::Relaxed)
}

fn settings_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("settings.json"))
}

fn load_settings(app: &AppHandle) {
    if let Some(path) = settings_path(app) {
        if let Ok(bytes) = std::fs::read(path) {
            if let Ok(v) = serde_json::from_slice::<serde_json::Value>(&bytes) {
                if let Some(b) = v["all_displays"].as_bool() {
                    ALL_DISPLAYS.store(b, Ordering::Relaxed);
                }
                if let Some(p) = v["label_position"].as_str() {
                    if ["left", "center", "right"].contains(&p) {
                        *LABEL_POS.lock().unwrap() = p.to_string();
                    }
                }
                if let Some(b) = v["labels_only"].as_bool() {
                    LABELS_ONLY.store(b, Ordering::Relaxed);
                }
            }
        }
    }
}

fn save_settings(app: &AppHandle) {
    if let Some(path) = settings_path(app) {
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let v = serde_json::json!({
            "all_displays": ALL_DISPLAYS.load(Ordering::Relaxed),
            "label_position": label_pos(),
            "labels_only": LABELS_ONLY.load(Ordering::Relaxed),
        });
        let _ = std::fs::write(path, v.to_string());
    }
}

fn pin_to_monitor(win: &tauri::WebviewWindow, mon: &Monitor) {
    let scale = mon.scale_factor();
    let size = mon.size().to_logical::<f64>(scale);
    let pos = mon.position().to_logical::<f64>(scale);
    let _ = win.set_size(LogicalSize::new(size.width, BAR_HEIGHT));
    let _ = win.set_position(LogicalPosition::new(
        pos.x,
        pos.y + size.height - BAR_HEIGHT,
    ));
}

fn ensure_bar(app: &AppHandle, label: &str, mon: &Monitor) {
    if let Some(win) = app.get_webview_window(label) {
        pin_to_monitor(&win, mon);
        return;
    }
    let built = WebviewWindowBuilder::new(app, label, WebviewUrl::App("index.html".into()))
        .title("manabar")
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(false)
        .accept_first_mouse(false)
        .closable(false)
        .resizable(false)
        .visible_on_all_workspaces(true)
        .build();
    if let Ok(win) = built {
        let _ = win.set_ignore_cursor_events(true);
        pin_to_monitor(&win, mon);
        if BARS_HIDDEN.load(Ordering::Relaxed) {
            let _ = win.hide();
        }
    }
}

/// Keep one bar per display: re-pin existing bars (display geometry can change),
/// create missing secondaries, close bars whose display vanished. Runs on the
/// main thread (macOS requires it for window creation).
fn reconcile(app: &AppHandle) {
    let primary = app.primary_monitor().ok().flatten();
    if let (Some(win), Some(mon)) = (app.get_webview_window("main"), primary.as_ref()) {
        pin_to_monitor(&win, mon);
    }
    let mut wanted: Vec<String> = Vec::new();
    if ALL_DISPLAYS.load(Ordering::Relaxed) {
        let mut monitors = app.available_monitors().unwrap_or_default();
        monitors.sort_by_key(|m| (m.position().x, m.position().y));
        let primary_pos = primary.as_ref().map(|m| *m.position());
        for (i, mon) in monitors
            .iter()
            .filter(|m| Some(*m.position()) != primary_pos)
            .enumerate()
        {
            let label = format!("bar{}", i + 1);
            ensure_bar(app, &label, mon);
            wanted.push(label);
        }
    }
    for (label, win) in app.webview_windows() {
        if label.starts_with("bar") && !wanted.contains(&label) {
            let _ = win.close();
        }
    }
}

fn set_bars_hidden(app: &AppHandle, hidden: bool) {
    BARS_HIDDEN.store(hidden, Ordering::Relaxed);
    for (label, win) in app.webview_windows() {
        if label == "main" || label.starts_with("bar") {
            if hidden {
                let _ = win.hide();
            } else {
                let _ = win.show();
            }
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            fetch_usage,
            cached_usage,
            get_label_position,
            get_labels_only
        ])
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            let handle = app.handle().clone();
            load_settings(&handle);

            let win = app.get_webview_window("main").expect("main window");
            win.set_ignore_cursor_events(true)?;
            win.set_visible_on_all_workspaces(true)?;
            reconcile(&handle);

            // Reconciler: displays get plugged/unplugged/rearranged; keep bars true.
            {
                let handle = handle.clone();
                std::thread::spawn(move || loop {
                    std::thread::sleep(Duration::from_secs(RECONCILE_SECS));
                    let h = handle.clone();
                    let _ = handle.run_on_main_thread(move || reconcile(&h));
                });
            }

            let toggle = MenuItem::with_id(app, "toggle", "Hide bars", true, None::<&str>)?;
            let all_displays = CheckMenuItem::with_id(
                app,
                "alldisplays",
                "All displays",
                true,
                ALL_DISPLAYS.load(Ordering::Relaxed),
                None::<&str>,
            )?;
            let cur = label_pos();
            let lab_left =
                CheckMenuItem::with_id(app, "label-left", "Left", true, cur == "left", None::<&str>)?;
            let lab_center = CheckMenuItem::with_id(
                app,
                "label-center",
                "Center",
                true,
                cur == "center",
                None::<&str>,
            )?;
            let lab_right = CheckMenuItem::with_id(
                app,
                "label-right",
                "Right",
                true,
                cur == "right",
                None::<&str>,
            )?;
            let labels =
                Submenu::with_items(app, "Label position", true, &[&lab_left, &lab_center, &lab_right])?;
            let labels_only = CheckMenuItem::with_id(
                app,
                "labelsonly",
                "Labels only",
                true,
                LABELS_ONLY.load(Ordering::Relaxed),
                None::<&str>,
            )?;
            let quit = MenuItem::with_id(app, "quit", "Quit manabar", true, None::<&str>)?;
            let menu =
                Menu::with_items(app, &[&toggle, &all_displays, &labels, &labels_only, &quit])?;
            let toggle_item = toggle.clone();
            let all_item = all_displays.clone();
            let lab_items = [lab_left.clone(), lab_center.clone(), lab_right.clone()];
            let labels_only_item = labels_only.clone();
            TrayIconBuilder::new()
                .icon(app.default_window_icon().expect("app icon").clone())
                .menu(&menu)
                .show_menu_on_left_click(true)
                .on_menu_event(move |app, event| match event.id.as_ref() {
                    "quit" => app.exit(0),
                    "toggle" => {
                        let hidden = !BARS_HIDDEN.load(Ordering::Relaxed);
                        set_bars_hidden(app, hidden);
                        let _ = toggle_item.set_text(if hidden { "Show bars" } else { "Hide bars" });
                    }
                    "alldisplays" => {
                        let on = !ALL_DISPLAYS.load(Ordering::Relaxed);
                        ALL_DISPLAYS.store(on, Ordering::Relaxed);
                        let _ = all_item.set_checked(on);
                        save_settings(app);
                        reconcile(app);
                    }
                    "labelsonly" => {
                        let on = !LABELS_ONLY.load(Ordering::Relaxed);
                        LABELS_ONLY.store(on, Ordering::Relaxed);
                        let _ = labels_only_item.set_checked(on);
                        save_settings(app);
                        let _ = app.emit("labels-only", on);
                    }
                    id if id.starts_with("label-") => {
                        let pos = id.trim_start_matches("label-").to_string();
                        *LABEL_POS.lock().unwrap() = pos.clone();
                        for item in &lab_items {
                            let _ = item.set_checked(item.id().as_ref() == id);
                        }
                        save_settings(app);
                        let _ = app.emit("label-pos", pos);
                    }
                    _ => {}
                })
                .build(app)?;

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running manabar");
}
