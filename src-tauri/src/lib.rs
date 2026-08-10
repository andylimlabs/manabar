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
/// Active provider: the HUD shows ONE game at a time ("claude" | "codex").
static PROVIDER: Mutex<String> = Mutex::new(String::new());

fn active_provider() -> String {
    let p = PROVIDER.lock().unwrap().clone();
    if p.is_empty() {
        "claude".into()
    } else {
        p
    }
}

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
    let status = status.trim();
    if status == "404" || status == "410" {
        // endpoint moved or retired: manabar itself needs updating
        return Err(format!("gone: http {status}"));
    }
    if status != "200" {
        let head: String = body.chars().take(120).collect();
        return Err(format!("http {status}: {head}"));
    }
    if body.trim_start().starts_with('{') {
        Ok(body.to_string())
    } else {
        let head: String = body.chars().take(120).collect();
        Err(format!("unexpected response: {head}"))
    }
}

const NO_CREDS: &str = "no-creds";

fn read_codex_auth() -> Result<(String, String), String> {
    let home = std::env::var("HOME").map_err(|_| format!("{NO_CREDS}: no HOME"))?;
    let path = std::path::Path::new(&home).join(".codex/auth.json");
    let bytes = std::fs::read(path).map_err(|_| format!("{NO_CREDS}: no codex auth"))?;
    let v: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|e| format!("codex auth parse: {e}"))?;
    let token = v["tokens"]["access_token"]
        .as_str()
        .ok_or(format!("{NO_CREDS}: no codex access_token"))?;
    let acct = v["tokens"]["account_id"].as_str().unwrap_or_default();
    Ok((token.to_string(), acct.to_string()))
}

fn query_codex(token: &str, account_id: &str) -> Result<String, String> {
    // Both headers over stdin (-H @- reads one header per line): the token
    // never appears in argv.
    let mut child = Command::new("curl")
        .args([
            "-s",
            "-m",
            "10",
            "-w",
            "\n%{http_code}",
            "https://chatgpt.com/backend-api/wham/usage",
            "-H",
            "@-",
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
        .write_all(
            format!("Authorization: Bearer {token}\nchatgpt-account-id: {account_id}").as_bytes(),
        )
        .map_err(|e| format!("curl stdin write: {e}"))?;
    let out = child
        .wait_with_output()
        .map_err(|e| format!("curl wait: {e}"))?;
    let raw = String::from_utf8_lossy(&out.stdout).to_string();
    let (body, status) = raw.rsplit_once('\n').unwrap_or((raw.as_str(), ""));
    let status = status.trim();
    if status == "404" || status == "410" {
        return Err(format!("gone: http {status}"));
    }
    if status != "200" {
        let head: String = body.chars().take(120).collect();
        return Err(format!("http {status}: {head}"));
    }
    serde_json::from_str::<serde_json::Value>(body)
        .map(|_| body.to_string())
        .map_err(|e| format!("codex parse: {e}"))
}

fn cache_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|d| d.join("last_usage.json"))
}

fn unix_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// Preload the disk cache at startup so a restart paints real (slightly
/// stale) numbers instantly instead of "syncing" until the first fetch.
/// Skip stale caches: applying hours-old data would spawn bogus ghost
/// animations when the fresh fetch lands.
const CACHE_FRESH_MS: u128 = 30 * 60 * 1000;

fn load_cache(app: &AppHandle) {
    let Some(path) = cache_path(app) else { return };
    let Ok(bytes) = std::fs::read(path) else { return };
    let Ok(v) = serde_json::from_slice::<serde_json::Value>(&bytes) else { return };
    let fresh = v["at"]
        .as_u64()
        .is_some_and(|at| unix_ms().saturating_sub(at as u128) < CACHE_FRESH_MS);
    if fresh {
        if let Some(body) = v["body"].as_str() {
            *LAST_USAGE.lock().unwrap() = Some(body.to_string());
        }
    }
}

fn save_cache(app: &AppHandle, body: &str) {
    if let Some(path) = cache_path(app) {
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let v = serde_json::json!({ "at": unix_ms() as u64, "body": body });
        let _ = std::fs::write(path, v.to_string());
    }
}

/// Fetch every provider; succeed if ANY does. The envelope keys a provider
/// to its parsed payload, or null when that provider is unavailable.
#[tauri::command]
async fn fetch_usage(app: AppHandle) -> Result<String, String> {
    let result = tauri::async_runtime::spawn_blocking(|| {
        let claude = keychain_token().and_then(|t| query_usage(&t));
        let codex = read_codex_auth().and_then(|(t, a)| query_codex(&t, &a));
        match (&claude, &codex) {
            (Err(ce), Err(xe)) => {
                if ce.starts_with(NO_CREDS) && xe.starts_with(NO_CREDS) {
                    Err("no-providers".to_string())
                } else if ce.starts_with("gone") || xe.starts_with("gone") {
                    Err(format!("gone: claude[{ce}] codex[{xe}]"))
                } else {
                    Err(format!("claude[{ce}] codex[{xe}]"))
                }
            }
            _ => {
                let parse = |r: &Result<String, String>| {
                    r.as_ref()
                        .ok()
                        .and_then(|b| serde_json::from_str::<serde_json::Value>(b).ok())
                        .unwrap_or(serde_json::Value::Null)
                };
                let err_of =
                    |r: &Result<String, String>| r.as_ref().err().cloned().unwrap_or_default();
                // Per-provider merge: one provider failing must not evict the
                // other's (or its own) last good data from the cache.
                let prev: serde_json::Value = LAST_USAGE
                    .lock()
                    .unwrap()
                    .as_deref()
                    .and_then(|b| serde_json::from_str(b).ok())
                    .unwrap_or(serde_json::Value::Null);
                let keep = |cur: serde_json::Value, key: &str| {
                    if cur.is_null() {
                        prev[key].clone()
                    } else {
                        cur
                    }
                };
                Ok(serde_json::json!({
                    "claude": keep(parse(&claude), "claude"),
                    "codex": keep(parse(&codex), "codex"),
                    "claude_error": err_of(&claude),
                    "codex_error": err_of(&codex),
                })
                .to_string())
            }
        }
    })
    .await
    .map_err(|e| e.to_string())?;
    if let Ok(body) = &result {
        *LAST_USAGE.lock().unwrap() = Some(body.clone());
        save_cache(&app, body);
    }
    update_status(&app, &result);
    result
}

struct StatusItem(tauri::menu::MenuItem<tauri::Wry>);
struct ProvMenuItems {
    claude: tauri::menu::CheckMenuItem<tauri::Wry>,
    codex: tauri::menu::CheckMenuItem<tauri::Wry>,
}

/// Tray diagnostics: facts and hedged hints live here, never in the pill.
fn update_status(app: &AppHandle, result: &Result<String, String>) {
    fn prov(err: &str) -> &'static str {
        if err.is_empty() {
            "OK"
        } else if err.starts_with("gone") {
            "API changed?"
        } else if err.starts_with(NO_CREDS) {
            "not signed in"
        } else {
            "error"
        }
    }
    let text = match result {
        Ok(body) => {
            let v: serde_json::Value = serde_json::from_str(body).unwrap_or_default();
            format!(
                "Status: Claude {} · Codex {}",
                prov(v["claude_error"].as_str().unwrap_or("")),
                prov(v["codex_error"].as_str().unwrap_or("")),
            )
        }
        Err(e) if e == "no-providers" => "Status: no CLI sign-ins found".to_string(),
        Err(e) if e.starts_with("gone") => "Status: API changed? app may need an update".to_string(),
        Err(_) => "Status: fetch failing, will retry".to_string(),
    };
    if let Some(s) = app.try_state::<StatusItem>() {
        let _ = s.0.set_text(text);
    }
    // annotate the Provider entries so a signed-out choice is informed,
    // not disabled
    if let (Ok(body), Some(items)) = (result, app.try_state::<ProvMenuItems>()) {
        let v: serde_json::Value = serde_json::from_str(body).unwrap_or_default();
        let name = |base: &str, err: &str| {
            if err.starts_with(NO_CREDS) {
                format!("{base} (not signed in)")
            } else {
                base.to_string()
            }
        };
        let _ = items
            .claude
            .set_text(name("Claude", v["claude_error"].as_str().unwrap_or("")));
        let _ = items
            .codex
            .set_text(name("Codex", v["codex_error"].as_str().unwrap_or("")));
    }
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

#[tauri::command]
fn get_provider() -> String {
    active_provider()
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
                if let Some(p) = v["provider"].as_str() {
                    if ["claude", "codex"].contains(&p) {
                        *PROVIDER.lock().unwrap() = p.to_string();
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
            "provider": active_provider(),
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
            get_hud_size,
            get_provider
        ])
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            let handle = app.handle().clone();
            load_settings(&handle);
            load_cache(&handle);

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
            let prov = active_provider();
            let prov_claude = CheckMenuItem::with_id(
                app,
                "prov-claude",
                "Claude",
                true,
                prov == "claude",
                None::<&str>,
            )?;
            let prov_codex = CheckMenuItem::with_id(
                app,
                "prov-codex",
                "Codex",
                true,
                prov == "codex",
                None::<&str>,
            )?;
            let providers =
                Submenu::with_items(app, "Provider", true, &[&prov_claude, &prov_codex])?;
            app.manage(ProvMenuItems {
                claude: prov_claude.clone(),
                codex: prov_codex.clone(),
            });
            let demo =
                MenuItem::with_id(app, "demo", "Preview animations", true, None::<&str>)?;
            let status = MenuItem::with_id(app, "status", "Status: starting…", false, None::<&str>)?;
            app.manage(StatusItem(status.clone()));
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
                    &providers,
                    &sizes,
                    &labels,
                    &all_displays,
                    &demo,
                    &sep2,
                    &status,
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
            let prov_items = [prov_claude.clone(), prov_codex.clone()];
            TrayIconBuilder::new()
                .icon(app.default_window_icon().expect("app icon").clone())
                .menu(&menu)
                .show_menu_on_left_click(true)
                .on_menu_event(move |app, event| match event.id.as_ref() {
                    "quit" => app.exit(0),
                    "demo" => {
                        let _ = app.emit("demo", ());
                    }
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
                    id if id.starts_with("prov-") => {
                        let p = id.trim_start_matches("prov-").to_string();
                        *PROVIDER.lock().unwrap() = p.clone();
                        for item in &prov_items {
                            let _ = item.set_checked(item.id().as_ref() == id);
                        }
                        save_settings(app);
                        let _ = app.emit("provider", p);
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
