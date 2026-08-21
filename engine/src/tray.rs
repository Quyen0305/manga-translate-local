use std::ptr::{null, null_mut};
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail};
use tray_icon::menu::{CheckMenuItem, Menu, MenuEvent, MenuItem, PredefinedMenuItem};
use tray_icon::{Icon, TrayIconBuilder};
use windows_sys::Win32::Foundation::{
    CloseHandle, ERROR_ALREADY_EXISTS, GetLastError, WAIT_OBJECT_0,
};
use windows_sys::Win32::System::Threading::{
    CreateEventW, CreateMutexW, ResetEvent, WaitForSingleObject,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    DispatchMessageW, MSG, PM_REMOVE, PeekMessageW, TranslateMessage, WM_QUIT,
};

use crate::config::AppConfig;
use crate::diagnostics::resolve_path;
use crate::native;
use crate::service::ServiceController;

pub fn run(controller: Arc<ServiceController>, config: AppConfig) -> Result<()> {
    let mutex_name = native::wide("Local\\MangaTranslateTray");
    let start_event_name = native::wide(native::START_EVENT_NAME);
    unsafe {
        let mutex = CreateMutexW(null(), 0, mutex_name.as_ptr());
        if mutex.is_null() {
            bail!("Could not create the tray instance lock");
        }
        if GetLastError() == ERROR_ALREADY_EXISTS {
            CloseHandle(mutex);
            return Ok(());
        }
        let start_event = CreateEventW(null(), 1, 0, start_event_name.as_ptr());
        if start_event.is_null() {
            CloseHandle(mutex);
            bail!("Could not create the service start event");
        }
        let result = run_loop(controller, config, start_event);
        CloseHandle(start_event);
        CloseHandle(mutex);
        result
    }
}

fn run_loop(
    controller: Arc<ServiceController>,
    config: AppConfig,
    start_event: windows_sys::Win32::Foundation::HANDLE,
) -> Result<()> {
    let menu = Menu::new();
    let service_status = MenuItem::new("Service: starting", false, None);
    let engine_status = MenuItem::new("Engine: sleeping", false, None);
    let resource_status = MenuItem::new("RAM: checking", false, None);
    let toggle_service = MenuItem::new("Stop Service", true, None);
    let unload_engine = MenuItem::new("Unload Engine", false, None);
    let restart_engine = MenuItem::new("Restart Engine", true, None);
    let preload_engine = CheckMenuItem::new(
        "Preload Engine at Startup",
        true,
        controller.lifecycle_policy().preload_on_start,
        None,
    );
    let open_data = MenuItem::new("Open Data Folder", true, None);
    let open_logs = MenuItem::new("Open Logs", true, None);
    let startup = CheckMenuItem::new("Start with Windows", true, native::startup_enabled(), None);
    let install = MenuItem::new("Install Chrome Integration", true, None);
    let exit = MenuItem::new("Exit Manga Translate", true, None);

    menu.append(&service_status)?;
    menu.append(&engine_status)?;
    menu.append(&resource_status)?;
    menu.append(&PredefinedMenuItem::separator())?;
    menu.append(&toggle_service)?;
    menu.append(&unload_engine)?;
    menu.append(&restart_engine)?;
    menu.append(&preload_engine)?;
    menu.append(&open_data)?;
    menu.append(&open_logs)?;
    menu.append(&startup)?;
    menu.append(&install)?;
    menu.append(&PredefinedMenuItem::separator())?;
    menu.append(&exit)?;

    let tray = TrayIconBuilder::new()
        .with_menu(Box::new(menu))
        .with_tooltip("Manga Translate")
        .with_icon(app_icon()?)
        .build()
        .context("create Windows tray icon")?;

    controller.start();
    let mut should_exit = false;
    let mut last_refresh = Instant::now() - Duration::from_secs(5);

    while !should_exit {
        unsafe {
            let mut message: MSG = std::mem::zeroed();
            while PeekMessageW(&mut message, null_mut(), 0, 0, PM_REMOVE) != 0 {
                if message.message == WM_QUIT {
                    should_exit = true;
                    break;
                }
                TranslateMessage(&message);
                DispatchMessageW(&message);
            }
            if WaitForSingleObject(start_event, 0) == WAIT_OBJECT_0 {
                ResetEvent(start_event);
                controller.start();
            }
        }

        while let Ok(event) = MenuEvent::receiver().try_recv() {
            if event.id == *toggle_service.id() {
                if controller.is_running() {
                    controller.stop();
                } else {
                    controller.start();
                }
            } else if event.id == *restart_engine.id() {
                controller.restart_engine();
            } else if event.id == *unload_engine.id() {
                if let Err(error) = controller.unload_engine() {
                    tracing::error!(%error, "could not unload engine");
                }
            } else if event.id == *preload_engine.id() {
                let mut policy = controller.lifecycle_policy();
                policy.preload_on_start = !policy.preload_on_start;
                if let Err(error) = controller.update_lifecycle_policy(policy) {
                    tracing::error!(%error, "could not update engine preload policy");
                }
            } else if event.id == *open_data.id() {
                let data = resolve_path(&config.data_dir);
                let _ = std::fs::create_dir_all(&data);
                let _ = std::process::Command::new("explorer.exe").arg(data).spawn();
            } else if event.id == *open_logs.id() {
                let logs = config.app_dir.join("logs");
                let _ = std::fs::create_dir_all(&logs);
                let _ = std::process::Command::new("explorer.exe").arg(logs).spawn();
            } else if event.id == *startup.id() {
                let enabled = !native::startup_enabled();
                if let Err(error) = native::set_startup(enabled) {
                    tracing::error!(%error, "could not update Windows startup setting");
                }
            } else if event.id == *install.id() {
                if let Err(error) = native::install() {
                    tracing::error!(%error, "could not install Chrome integration");
                }
            } else if event.id == *exit.id() {
                should_exit = true;
            }
        }

        if last_refresh.elapsed() >= Duration::from_millis(500) {
            let running = controller.is_running();
            let diagnostics = controller.engine_diagnostics();
            let engine_ready = diagnostics.loaded;
            service_status.set_text(if running {
                "Service: running"
            } else {
                "Service: stopped"
            });
            engine_status.set_text(match diagnostics.state {
                "busy" => "Engine: busy",
                "loading" => "Engine: loading",
                "ready" => "Engine: ready",
                _ => "Engine: sleeping",
            });
            let ram = format_bytes(diagnostics.resources.process_memory_bytes);
            let resource_text = diagnostics
                .resources
                .gpu_memory_used_bytes
                .map(|vram| format!("RAM: {ram} | VRAM: {}", format_bytes(vram)))
                .unwrap_or_else(|| format!("RAM: {ram}"));
            resource_status.set_text(&resource_text);
            toggle_service.set_text(if running {
                "Stop Service"
            } else {
                "Start Service"
            });
            unload_engine
                .set_enabled(running && engine_ready && !diagnostics.busy && !diagnostics.loading);
            restart_engine.set_enabled(running && !diagnostics.busy && !diagnostics.loading);
            preload_engine.set_checked(controller.lifecycle_policy().preload_on_start);
            startup.set_checked(native::startup_enabled());
            let _ = tray.set_tooltip(Some(if running {
                if engine_ready {
                    "Manga Translate - engine ready"
                } else {
                    "Manga Translate - service running"
                }
            } else {
                "Manga Translate - service stopped"
            }));
            last_refresh = Instant::now();
        }

        std::thread::sleep(Duration::from_millis(40));
    }

    controller.stop();
    drop(tray);
    Ok(())
}

fn app_icon() -> Result<Icon> {
    const SIZE: u32 = 32;
    let mut rgba = vec![0u8; (SIZE * SIZE * 4) as usize];
    for y in 3..29 {
        for x in 3..29 {
            let border = x < 6 || x > 26 || y < 6 || y > 26;
            let page = (8..15).contains(&x) || (18..25).contains(&x);
            let fold = (x == 15 || x == 17) && (8..25).contains(&y);
            let color = if border {
                [20, 125, 100, 255]
            } else if page || fold {
                [245, 248, 247, 255]
            } else {
                [35, 42, 46, 255]
            };
            let offset = ((y * SIZE + x) * 4) as usize;
            rgba[offset..offset + 4].copy_from_slice(&color);
        }
    }
    Icon::from_rgba(rgba, SIZE, SIZE).context("create tray icon")
}

fn format_bytes(bytes: u64) -> String {
    const MIB: f64 = 1024.0 * 1024.0;
    const GIB: f64 = 1024.0 * MIB;
    if bytes as f64 >= GIB {
        format!("{:.1} GB", bytes as f64 / GIB)
    } else {
        format!("{:.0} MB", bytes as f64 / MIB)
    }
}
