use std::io::{Read, Write};
use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

#[cfg(not(windows))]
use std::process::{Command, Stdio};

use anyhow::{Context, Result, anyhow, bail};
use serde::{Deserialize, Serialize};

pub const HOST_NAME: &str = "com.manga_translate.local";
pub const START_EVENT_NAME: &str = "Local\\MangaTranslateStartService";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeRequest {
    #[serde(default)]
    action: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeResponse {
    ok: bool,
    service_ready: bool,
    version: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

pub fn invoked_by_chrome() -> bool {
    std::env::args().skip(1).any(|argument| {
        argument.starts_with("chrome-extension://") || argument.starts_with("--parent-window=")
    })
}

pub fn run_host() -> Result<()> {
    let request = read_native_message().unwrap_or(NativeRequest {
        action: "ensureRunning".into(),
    });
    let response = if request.action.is_empty() || request.action == "ensureRunning" {
        match ensure_service_running() {
            Ok(()) => NativeResponse {
                ok: true,
                service_ready: true,
                version: env!("CARGO_PKG_VERSION"),
                error: None,
            },
            Err(error) => NativeResponse {
                ok: false,
                service_ready: false,
                version: env!("CARGO_PKG_VERSION"),
                error: Some(format!("{error:#}")),
            },
        }
    } else {
        NativeResponse {
            ok: false,
            service_ready: service_is_ready(),
            version: env!("CARGO_PKG_VERSION"),
            error: Some(format!("Unsupported action: {}", request.action)),
        }
    };
    write_native_message(&response)
}

pub fn install() -> Result<()> {
    #[cfg(not(windows))]
    bail!("Installation is supported on Windows only");

    #[cfg(windows)]
    {
        use winreg::RegKey;
        use winreg::enums::HKEY_CURRENT_USER;

        let app_dir = installed_app_dir()?;
        std::fs::create_dir_all(&app_dir)?;
        let installed_exe = app_dir.join("MangaTranslate.exe");
        let current_exe = std::env::current_exe()?;
        if !same_path(&current_exe, &installed_exe) {
            std::fs::copy(&current_exe, &installed_exe).with_context(|| {
                format!(
                    "copy {} to {}",
                    current_exe.display(),
                    installed_exe.display()
                )
            })?;
        }

        let manifest_path = app_dir.join("native-host.json");
        let allowed_origins = discover_extension_origins(&manifest_path)?;
        if allowed_origins.is_empty() {
            bail!(
                "No loaded Manga Translate extension was found. Load the extension in Chrome, then run --install again."
            );
        }
        let manifest = serde_json::json!({
            "name": HOST_NAME,
            "description": "Manga Translate native launcher",
            "path": installed_exe,
            "type": "stdio",
            "allowed_origins": allowed_origins,
        });
        std::fs::write(&manifest_path, serde_json::to_vec_pretty(&manifest)?)?;

        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let (host_key, _) = hkcu.create_subkey(format!(
            "Software\\Google\\Chrome\\NativeMessagingHosts\\{HOST_NAME}"
        ))?;
        host_key.set_value("", &manifest_path.to_string_lossy().as_ref())?;
        set_startup(true)?;
        spawn_tray(&installed_exe)?;
        Ok(())
    }
}

#[cfg(windows)]
fn discover_extension_origins(existing_manifest: &Path) -> Result<Vec<String>> {
    use std::collections::BTreeSet;

    let mut origins = BTreeSet::new();
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        let user_data = PathBuf::from(local).join("Google\\Chrome\\User Data");
        if let Ok(profiles) = std::fs::read_dir(user_data) {
            for profile in profiles.flatten() {
                let preferences = profile.path().join("Secure Preferences");
                let Ok(bytes) = std::fs::read(preferences) else {
                    continue;
                };
                let Ok(value) = serde_json::from_slice::<serde_json::Value>(&bytes) else {
                    continue;
                };
                let Some(settings) = value["extensions"]["settings"].as_object() else {
                    continue;
                };
                for (id, entry) in settings {
                    if !is_extension_id(id) {
                        continue;
                    }
                    let Some(path) = entry["path"].as_str().map(PathBuf::from) else {
                        continue;
                    };
                    let Ok(manifest_bytes) = std::fs::read(path.join("manifest.json")) else {
                        continue;
                    };
                    let Ok(manifest) = serde_json::from_slice::<serde_json::Value>(&manifest_bytes)
                    else {
                        continue;
                    };
                    if manifest["name"] == "Manga Translate Local" {
                        origins.insert(format!("chrome-extension://{id}/"));
                    }
                }
            }
        }
    }

    if origins.is_empty()
        && let Ok(bytes) = std::fs::read(existing_manifest)
        && let Ok(value) = serde_json::from_slice::<serde_json::Value>(&bytes)
        && let Some(existing) = value["allowed_origins"].as_array()
    {
        for origin in existing.iter().filter_map(|origin| origin.as_str()) {
            origins.insert(origin.to_string());
        }
    }
    Ok(origins.into_iter().collect())
}

#[cfg(windows)]
fn is_extension_id(value: &str) -> bool {
    value.len() == 32 && value.bytes().all(|byte| (b'a'..=b'p').contains(&byte))
}

pub fn uninstall() -> Result<()> {
    #[cfg(not(windows))]
    bail!("Uninstallation is supported on Windows only");

    #[cfg(windows)]
    {
        use winreg::RegKey;
        use winreg::enums::HKEY_CURRENT_USER;

        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let _ = hkcu.delete_subkey_all(format!(
            "Software\\Google\\Chrome\\NativeMessagingHosts\\{HOST_NAME}"
        ));
        set_startup(false)?;
        let manifest = installed_app_dir()?.join("native-host.json");
        let _ = std::fs::remove_file(manifest);
        Ok(())
    }
}

#[cfg(windows)]
pub fn set_startup(enabled: bool) -> Result<()> {
    use winreg::RegKey;
    use winreg::enums::HKEY_CURRENT_USER;

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let (run, _) = hkcu.create_subkey("Software\\Microsoft\\Windows\\CurrentVersion\\Run")?;
    if enabled {
        let executable = installed_executable()?;
        run.set_value(
            "MangaTranslate",
            &format!("\"{}\" --tray", executable.display()),
        )?;
    } else {
        let _ = run.delete_value("MangaTranslate");
    }
    Ok(())
}

#[cfg(windows)]
pub fn startup_enabled() -> bool {
    use winreg::RegKey;
    use winreg::enums::HKEY_CURRENT_USER;

    RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey("Software\\Microsoft\\Windows\\CurrentVersion\\Run")
        .and_then(|key| key.get_value::<String, _>("MangaTranslate"))
        .is_ok()
}

fn ensure_service_running() -> Result<()> {
    if service_is_ready() {
        return Ok(());
    }
    #[cfg(windows)]
    signal_start_event();
    if !wait_for_service(Duration::from_millis(800)) {
        let executable = installed_executable().or_else(|_| std::env::current_exe())?;
        spawn_tray(&executable)?;
    }
    if wait_for_service(Duration::from_secs(20)) {
        Ok(())
    } else {
        bail!("Manga Translate did not become ready within 20 seconds")
    }
}

fn service_is_ready() -> bool {
    let Ok(mut stream) = TcpStream::connect_timeout(
        &SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 40721),
        Duration::from_millis(300),
    ) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(500)));
    if stream
        .write_all(b"GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
        .is_err()
    {
        return false;
    }
    let mut response = Vec::with_capacity(1024);
    if stream.take(4096).read_to_end(&mut response).is_err() {
        return false;
    }
    let response = String::from_utf8_lossy(&response);
    response.starts_with("HTTP/1.1 200")
        && response.contains("\"status\":\"ok\"")
        && response.contains("\"mode\":\"unified\"")
}

fn wait_for_service(timeout: Duration) -> bool {
    let started = Instant::now();
    while started.elapsed() < timeout {
        if service_is_ready() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    false
}

fn spawn_tray(executable: &Path) -> Result<()> {
    #[cfg(windows)]
    {
        use windows_sys::Win32::UI::Shell::ShellExecuteW;
        use windows_sys::Win32::UI::WindowsAndMessaging::SW_HIDE;

        let operation = wide("open");
        let path = wide(&executable.to_string_lossy());
        let arguments = wide("--tray");
        let result = unsafe {
            ShellExecuteW(
                std::ptr::null_mut(),
                operation.as_ptr(),
                path.as_ptr(),
                arguments.as_ptr(),
                std::ptr::null(),
                SW_HIDE,
            )
        };
        if result as isize <= 32 {
            bail!(
                "ShellExecuteW could not start Manga Translate (code {})",
                result as isize
            );
        }
        return Ok(());
    }

    #[cfg(not(windows))]
    {
        Command::new(executable)
            .arg("--tray")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .context("start Manga Translate tray")?;
        Ok(())
    }
}

#[cfg(windows)]
fn signal_start_event() {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{EVENT_MODIFY_STATE, OpenEventW, SetEvent};

    let name = wide(START_EVENT_NAME);
    unsafe {
        let event = OpenEventW(EVENT_MODIFY_STATE, 0, name.as_ptr());
        if !event.is_null() {
            SetEvent(event);
            CloseHandle(event);
        }
    }
}

fn read_native_message() -> Result<NativeRequest> {
    let mut length = [0u8; 4];
    std::io::stdin().read_exact(&mut length)?;
    let length = u32::from_le_bytes(length) as usize;
    if length > 1024 * 1024 {
        bail!("Native message exceeds 1 MiB")
    }
    let mut bytes = vec![0; length];
    std::io::stdin().read_exact(&mut bytes)?;
    Ok(serde_json::from_slice(&bytes)?)
}

fn write_native_message<T: Serialize>(message: &T) -> Result<()> {
    let bytes = serde_json::to_vec(message)?;
    let length = u32::try_from(bytes.len()).map_err(|_| anyhow!("native response is too large"))?;
    let mut stdout = std::io::stdout().lock();
    stdout.write_all(&length.to_le_bytes())?;
    stdout.write_all(&bytes)?;
    stdout.flush()?;
    Ok(())
}

fn installed_app_dir() -> Result<PathBuf> {
    let local =
        std::env::var_os("LOCALAPPDATA").ok_or_else(|| anyhow!("LOCALAPPDATA is missing"))?;
    Ok(PathBuf::from(local).join("MangaTranslate"))
}

fn installed_executable() -> Result<PathBuf> {
    let installed = installed_app_dir()?.join("MangaTranslate.exe");
    if installed.is_file() {
        Ok(installed)
    } else {
        std::env::current_exe().context("locate MangaTranslate.exe")
    }
}

fn same_path(left: &Path, right: &Path) -> bool {
    left.to_string_lossy()
        .eq_ignore_ascii_case(&right.to_string_lossy())
}

#[cfg(windows)]
pub fn wide(value: &str) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    std::ffi::OsStr::new(value)
        .encode_wide()
        .chain(Some(0))
        .collect()
}
