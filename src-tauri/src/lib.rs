use std::io::Write;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Monitor, WebviewUrl, WebviewWindowBuilder};

const RECONCILE_SECS: u64 = 15;

/// Show a bar on every display (tray-toggleable, persisted).
static ALL_DISPLAYS: AtomicBool = AtomicBool::new(true);
/// HUD mode: "full" (bars + readout), "minimal" (readout only, hugging the
/// screen edge), "hidden" (nothing). One radio state, game-style.
static HUD_MODE: Mutex<String> = Mutex::new(String::new());

fn hud_mode() -> String {
    let m = HUD_MODE.lock().unwrap().clone();
    if m.is_empty() {
        "full".into()
    } else {
        m
    }
}

/// HUD size preset: "compact" | "standard" | "large" (empty = standard).
static HUD_SIZE: Mutex<String> = Mutex::new(String::new());

fn hud_size() -> String {
    let s = HUD_SIZE.lock().unwrap().clone();
    if s.is_empty() {
        "standard".into()
    } else {
        s
    }
}

/// Window height in logical points: weekly strip + session bar heights per
/// size preset, plus headroom for the floating readout pill. Must track the
/// CSS size presets in styles.css.
fn bar_height() -> f64 {
    match hud_size().as_str() {
        "compact" => 38.0,
        "large" => 46.0,
        _ => 40.0,
    }
}
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
fn get_hud_mode() -> String {
    hud_mode()
}

#[tauri::command]
fn get_hud_size() -> String {
    hud_size()
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
                if let Some(m) = v["hud_mode"].as_str() {
                    if ["full", "minimal", "hidden"].contains(&m) {
                        *HUD_MODE.lock().unwrap() = m.to_string();
                    }
                } else if v["labels_only"].as_bool() == Some(true) {
                    // migrate the pre-HUD-mode setting
                    *HUD_MODE.lock().unwrap() = "minimal".to_string();
                }
                if let Some(s) = v["hud_size"].as_str() {
                    if ["compact", "standard", "large"].contains(&s) {
                        *HUD_SIZE.lock().unwrap() = s.to_string();
                    }
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
            "hud_mode": hud_mode(),
            "hud_size": hud_size(),
        });
        let _ = std::fs::write(path, v.to_string());
    }
}

fn pin_to_monitor(win: &tauri::WebviewWindow, mon: &Monitor) {
    let scale = mon.scale_factor();
    let size = mon.size().to_logical::<f64>(scale);
    let pos = mon.position().to_logical::<f64>(scale);
    let h = bar_height();
    let _ = win.set_size(LogicalSize::new(size.width, h));
    let _ = win.set_position(LogicalPosition::new(pos.x, pos.y + size.height - h));
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
        if hud_mode() == "hidden" {
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

fn apply_hud_mode(app: &AppHandle) {
    let mode = hud_mode();
    let hidden = mode == "hidden";
    for (label, win) in app.webview_windows() {
        if label == "main" || label.starts_with("bar") {
            if hidden {
                let _ = win.hide();
            } else {
                let _ = win.show();
            }
        }
    }
    // Hidden windows keep their webviews alive, so they hear this too and
    // come back in the right mode.
    let _ = app.emit("hud-mode", mode);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            fetch_usage,
            cached_usage,
            get_label_position,
            get_hud_mode,
            get_hud_size
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

            let mode = hud_mode();
            let hud_full = CheckMenuItem::with_id(
                app,
                "hud-full",
                "Full HUD",
                true,
                mode == "full",
                None::<&str>,
            )?;
            let hud_minimal = CheckMenuItem::with_id(
                app,
                "hud-minimal",
                "Minimal HUD",
                true,
                mode == "minimal",
                None::<&str>,
            )?;
            let hud_hidden = CheckMenuItem::with_id(
                app,
                "hud-hidden",
                "Hide HUD",
                true,
                mode == "hidden",
                None::<&str>,
            )?;
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
            let labels = Submenu::with_items(
                app,
                "Readout position",
                true,
                &[&lab_left, &lab_center, &lab_right],
            )?;
            let size = hud_size();
            let size_compact = CheckMenuItem::with_id(
                app,
                "size-compact",
                "Compact",
                true,
                size == "compact",
                None::<&str>,
            )?;
            let size_standard = CheckMenuItem::with_id(
                app,
                "size-standard",
                "Standard",
                true,
                size == "standard",
                None::<&str>,
            )?;
            let size_large = CheckMenuItem::with_id(
                app,
                "size-large",
                "Large",
                true,
                size == "large",
                None::<&str>,
            )?;
            let sizes = Submenu::with_items(
                app,
                "HUD size",
                true,
                &[&size_compact, &size_standard, &size_large],
            )?;
            let quit = MenuItem::with_id(app, "quit", "Quit manabar", true, None::<&str>)?;
            let sep1 = PredefinedMenuItem::separator(app)?;
            let sep2 = PredefinedMenuItem::separator(app)?;
            let menu = Menu::with_items(
                app,
                &[
                    &hud_full,
                    &hud_minimal,
                    &hud_hidden,
                    &sep1,
                    &sizes,
                    &labels,
                    &all_displays,
                    &sep2,
                    &quit,
                ],
            )?;
            let all_item = all_displays.clone();
            let lab_items = [lab_left.clone(), lab_center.clone(), lab_right.clone()];
            let hud_items = [hud_full.clone(), hud_minimal.clone(), hud_hidden.clone()];
            let size_items = [
                size_compact.clone(),
                size_standard.clone(),
                size_large.clone(),
            ];
            TrayIconBuilder::new()
                .icon(app.default_window_icon().expect("app icon").clone())
                .menu(&menu)
                .show_menu_on_left_click(true)
                .on_menu_event(move |app, event| match event.id.as_ref() {
                    "quit" => app.exit(0),
                    id if id.starts_with("hud-") => {
                        let mode = id.trim_start_matches("hud-").to_string();
                        *HUD_MODE.lock().unwrap() = mode;
                        for item in &hud_items {
                            let _ = item.set_checked(item.id().as_ref() == id);
                        }
                        save_settings(app);
                        apply_hud_mode(app);
                    }
                    "alldisplays" => {
                        let on = !ALL_DISPLAYS.load(Ordering::Relaxed);
                        ALL_DISPLAYS.store(on, Ordering::Relaxed);
                        let _ = all_item.set_checked(on);
                        save_settings(app);
                        reconcile(app);
                    }
                    id if id.starts_with("size-") => {
                        let size = id.trim_start_matches("size-").to_string();
                        *HUD_SIZE.lock().unwrap() = size.clone();
                        for item in &size_items {
                            let _ = item.set_checked(item.id().as_ref() == id);
                        }
                        save_settings(app);
                        reconcile(app);
                        let _ = app.emit("hud-size", size);
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
