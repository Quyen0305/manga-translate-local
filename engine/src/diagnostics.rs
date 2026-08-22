use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

use anyhow::{Context, Result, bail};
use serde::Serialize;

pub const ACTIVE_RUNTIME_DIRECTORY: &str = "runtime-v0.70.2";

const LEGACY_CACHE_DIRECTORIES: &[&str] = &["EBWebView", "GradleHome", "UserCache", "packages"];

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CudaDiagnostics {
    pub status: &'static str,
    pub gpu_name: Option<String>,
    pub gpu_memory_mib: Option<u64>,
    pub driver_version: Option<String>,
    pub driver_cuda_version: Option<String>,
    pub build_cuda_version: Option<String>,
    pub installed_toolkit_version: Option<String>,
    pub message: String,
}

impl CudaDiagnostics {
    pub fn collect(cpu_requested: bool) -> Self {
        let build = build_cuda_version();
        if cpu_requested || !cfg!(feature = "cuda") {
            return Self {
                status: "cpu",
                gpu_name: None,
                gpu_memory_mib: None,
                driver_version: None,
                driver_cuda_version: None,
                build_cuda_version: build,
                installed_toolkit_version: installed_toolkit_version(),
                message: if cpu_requested {
                    "Engine được cấu hình chạy CPU.".into()
                } else {
                    "Binary hiện tại được build không có CUDA.".into()
                },
            };
        }

        let summary = command_output("nvidia-smi", &[]);
        let query = command_output(
            "nvidia-smi",
            &[
                "--query-gpu=name,driver_version,memory.total",
                "--format=csv,noheader,nounits",
            ],
        );
        let installed = installed_toolkit_version();
        let Some(summary) = summary else {
            return Self {
                status: "unavailable",
                gpu_name: None,
                gpu_memory_mib: None,
                driver_version: None,
                driver_cuda_version: None,
                build_cuda_version: build,
                installed_toolkit_version: installed,
                message:
                    "Không chạy được nvidia-smi; engine sẽ thử GPU và tự fallback nếu CUDA lỗi."
                        .into(),
            };
        };

        let driver_cuda = version_after(&summary, "CUDA UMD Version:")
            .or_else(|| version_after(&summary, "CUDA Version:"));
        let (gpu_name, driver_version, gpu_memory_mib) = query
            .as_deref()
            .and_then(parse_gpu_query)
            .unwrap_or((None, None, None));
        let incompatible = build
            .as_deref()
            .zip(driver_cuda.as_deref())
            .is_some_and(|(build, driver)| version_is_newer(build, driver));
        let (status, message) = if incompatible {
            (
                "incompatible",
                format!(
                    "CUDA runtime {build} mới hơn mức {driver} mà driver hỗ trợ; engine sẽ chuyển sang CPU.",
                    build = build.as_deref().unwrap_or("?"),
                    driver = driver_cuda.as_deref().unwrap_or("?"),
                ),
            )
        } else {
            (
                "ready",
                format!(
                    "CUDA sẵn sàng: runtime {}, driver hỗ trợ {}.",
                    build.as_deref().unwrap_or("không rõ"),
                    driver_cuda.as_deref().unwrap_or("không rõ"),
                ),
            )
        };
        Self {
            status,
            gpu_name,
            gpu_memory_mib,
            driver_version,
            driver_cuda_version: driver_cuda,
            build_cuda_version: build,
            installed_toolkit_version: installed,
            message,
        }
    }

    pub fn requires_cpu_fallback(&self) -> bool {
        self.status == "incompatible"
    }
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageDiagnostics {
    pub data_dir: String,
    pub total_bytes: u64,
    pub models_bytes: u64,
    pub runtime_bytes: u64,
    pub projects_bytes: u64,
    pub webview_bytes: u64,
    pub downloads_bytes: u64,
    pub visual_context_cache_bytes: u64,
    pub other_bytes: u64,
    pub legacy_bytes: u64,
    pub reclaimable_bytes: u64,
    pub active_runtime: RuntimeHealth,
    pub cleanup_candidates: Vec<CleanupCandidate>,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeHealth {
    pub version: String,
    pub path: String,
    pub status: &'static str,
    pub bytes: u64,
    pub staging_bytes: u64,
    pub components: Vec<RuntimeComponent>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeComponent {
    pub id: &'static str,
    pub label: &'static str,
    pub status: &'static str,
    pub bytes: u64,
    pub optional: bool,
    pub message: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupCandidate {
    pub target: &'static str,
    pub label: &'static str,
    pub bytes: u64,
    pub requires_confirmation: bool,
}

impl StorageDiagnostics {
    pub fn scan(data_dir: &Path) -> Result<Self> {
        let resolved = resolve_path(data_dir);
        if !data_dir.exists() {
            return Ok(Self {
                data_dir: display_path(&resolved),
                active_runtime: RuntimeHealth::scan(data_dir)?,
                ..Self::default()
            });
        }

        let downloads = data_dir.join("runtime").join(".downloads");
        let mut report = Self {
            data_dir: display_path(&resolved),
            ..Self::default()
        };
        let mut seen = HashSet::new();
        let mut stack = vec![data_dir.to_path_buf()];
        while let Some(directory) = stack.pop() {
            let entries = std::fs::read_dir(&directory)
                .with_context(|| format!("read storage directory {}", directory.display()))?;
            for entry in entries {
                let entry = entry?;
                let file_type = entry.file_type()?;
                if file_type.is_symlink() {
                    continue;
                }
                let path = entry.path();
                if file_type.is_dir() {
                    stack.push(path);
                    continue;
                }
                if !file_type.is_file() {
                    continue;
                }
                if let Some(key) = file_key(&path)
                    && !seen.insert(key)
                {
                    continue;
                }
                let bytes = entry.metadata()?.len();
                report.total_bytes = report.total_bytes.saturating_add(bytes);
                if path.starts_with(&downloads) {
                    report.downloads_bytes = report.downloads_bytes.saturating_add(bytes);
                }
                match relative_top_level(data_dir, &path).as_deref() {
                    Some("models") => {
                        report.models_bytes = report.models_bytes.saturating_add(bytes)
                    }
                    Some(top) if top.starts_with("runtime") => {
                        report.runtime_bytes = report.runtime_bytes.saturating_add(bytes)
                    }
                    Some("projects") => {
                        report.projects_bytes = report.projects_bytes.saturating_add(bytes)
                    }
                    Some("ebwebview") => {
                        report.webview_bytes = report.webview_bytes.saturating_add(bytes)
                    }
                    Some("visual-context-cache") => {
                        report.visual_context_cache_bytes =
                            report.visual_context_cache_bytes.saturating_add(bytes)
                    }
                    _ => report.other_bytes = report.other_bytes.saturating_add(bytes),
                }
            }
        }
        let active_runtime = RuntimeHealth::scan(data_dir)?;
        let legacy_runtime_bytes = optional_directory_bytes(&data_dir.join("runtime"))?;
        let legacy_models_bytes = optional_directory_bytes(&data_dir.join("models"))?;
        let legacy_cache_bytes =
            LEGACY_CACHE_DIRECTORIES
                .iter()
                .try_fold(0u64, |total, name| {
                    Ok::<_, anyhow::Error>(
                        total.saturating_add(optional_directory_bytes(&data_dir.join(name))?),
                    )
                })?;
        let legacy_bytes = legacy_runtime_bytes
            .saturating_add(legacy_models_bytes)
            .saturating_add(legacy_cache_bytes);
        let reclaimable_bytes = legacy_bytes
            .saturating_add(active_runtime.staging_bytes)
            .saturating_add(report.visual_context_cache_bytes);
        let mut cleanup_candidates = Vec::new();
        push_cleanup_candidate(
            &mut cleanup_candidates,
            "downloads",
            "Cache tải xuống cũ",
            report.downloads_bytes,
            false,
        );
        push_cleanup_candidate(
            &mut cleanup_candidates,
            "staging",
            "Gói cài đặt dở",
            active_runtime.staging_bytes,
            false,
        );
        push_cleanup_candidate(
            &mut cleanup_candidates,
            "visual-context-cache",
            "Cache ngữ cảnh hình ảnh",
            report.visual_context_cache_bytes,
            false,
        );
        push_cleanup_candidate(
            &mut cleanup_candidates,
            "legacy-runtime",
            "Runtime Koharu cũ",
            legacy_runtime_bytes,
            true,
        );
        push_cleanup_candidate(
            &mut cleanup_candidates,
            "legacy-models",
            "Model Koharu cũ",
            legacy_models_bytes,
            true,
        );
        push_cleanup_candidate(
            &mut cleanup_candidates,
            "legacy-cache",
            "Cache ứng dụng Koharu cũ",
            legacy_cache_bytes,
            true,
        );
        report.legacy_bytes = legacy_bytes;
        report.reclaimable_bytes = reclaimable_bytes;
        report.active_runtime = active_runtime;
        report.cleanup_candidates = cleanup_candidates;
        Ok(report)
    }
}

impl RuntimeHealth {
    fn scan(data_dir: &Path) -> Result<Self> {
        let root = data_dir.join(ACTIVE_RUNTIME_DIRECTORY);
        let components = vec![
            runtime_component(&root, "torch", "Torch", false)?,
            runtime_component(&root, "cuda", "CUDA", true)?,
            runtime_component(&root, "llama", "OCR runtime", false)?,
            runtime_component(&root, "diffusion", "Inpainting runtime", false)?,
            runtime_component(&root, "hugging-face", "Pipeline models", false)?,
        ];
        let bytes = optional_directory_bytes(&root)?;
        let staging_bytes = staging_directories(&root)?
            .iter()
            .try_fold(0u64, |total, path| {
                Ok::<_, anyhow::Error>(total.saturating_add(directory_bytes(path)?))
            })?;
        let required = components.iter().filter(|component| !component.optional);
        let ready = required
            .clone()
            .all(|component| component.status == "ready");
        let has_any = components.iter().any(|component| component.bytes > 0);
        let status = if !root.exists() || !has_any {
            "missing"
        } else if staging_bytes > 0 {
            "attention"
        } else if ready {
            "ready"
        } else {
            "incomplete"
        };
        Ok(Self {
            version: "0.70.2".into(),
            path: display_path(&resolve_path(&root)),
            status,
            bytes,
            staging_bytes,
            components,
        })
    }
}

pub fn cleanup_storage(data_dir: &Path, target: &str) -> Result<u64> {
    match target {
        "downloads" => cleanup_exact_directory(data_dir, &data_dir.join("runtime/.downloads")),
        "staging" => cleanup_staging(data_dir),
        "visual-context-cache" => {
            cleanup_exact_directory(data_dir, &data_dir.join("visual-context-cache"))
        }
        "legacy-runtime" => cleanup_exact_directory(data_dir, &data_dir.join("runtime")),
        "legacy-models" => cleanup_exact_directory(data_dir, &data_dir.join("models")),
        "legacy-cache" => LEGACY_CACHE_DIRECTORIES
            .iter()
            .try_fold(0u64, |total, name| {
                Ok(total.saturating_add(cleanup_exact_directory(data_dir, &data_dir.join(name))?))
            }),
        _ => bail!("unsupported storage cleanup target"),
    }
}

pub fn legacy_koharu_running() -> bool {
    let mut system = sysinfo::System::new();
    system.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
    system.processes().values().any(|process| {
        process
            .name()
            .to_string_lossy()
            .eq_ignore_ascii_case("koharu.exe")
    })
}

fn cleanup_exact_directory(data_dir: &Path, directory: &Path) -> Result<u64> {
    if !directory.exists() {
        return Ok(0);
    }
    let root = std::fs::canonicalize(data_dir)
        .with_context(|| format!("resolve data directory {}", data_dir.display()))?;
    let target = std::fs::canonicalize(directory)
        .with_context(|| format!("resolve cleanup directory {}", directory.display()))?;
    let expected = directory
        .file_name()
        .context("cleanup directory has no file name")?;
    if !target.starts_with(&root) || target == root || target.file_name() != Some(expected) {
        bail!("cleanup target is outside the engine data directory");
    }
    let bytes = directory_bytes(&target)?;
    std::fs::remove_dir_all(&target)
        .with_context(|| format!("remove cleanup directory {}", target.display()))?;
    Ok(bytes)
}

fn cleanup_staging(data_dir: &Path) -> Result<u64> {
    let active = data_dir.join(ACTIVE_RUNTIME_DIRECTORY);
    let mut freed = 0u64;
    for directory in staging_directories(&active)? {
        freed = freed.saturating_add(cleanup_exact_directory(data_dir, &directory)?);
    }
    Ok(freed)
}

fn staging_directories(root: &Path) -> Result<Vec<PathBuf>> {
    if !root.exists() {
        return Ok(Vec::new());
    }
    let mut found = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(directory) = stack.pop() {
        for entry in std::fs::read_dir(&directory)? {
            let entry = entry?;
            if !entry.file_type()?.is_dir() {
                continue;
            }
            let path = entry.path();
            if entry.file_name().to_string_lossy().starts_with(".install-") {
                found.push(path);
            } else {
                stack.push(path);
            }
        }
    }
    Ok(found)
}

fn runtime_component(
    root: &Path,
    id: &'static str,
    label: &'static str,
    optional: bool,
) -> Result<RuntimeComponent> {
    let directory = root.join(id);
    let bytes = optional_directory_bytes(&directory)?;
    let issue = (bytes > 0)
        .then(|| runtime_component_issue(id, &directory))
        .flatten();
    Ok(RuntimeComponent {
        id,
        label,
        status: if bytes == 0 {
            "missing"
        } else if issue.is_some() {
            "invalid"
        } else {
            "ready"
        },
        bytes,
        optional,
        message: issue,
    })
}

fn runtime_component_issue(id: &str, directory: &Path) -> Option<String> {
    let required: &[&[&str]] = match id {
        "torch" => &[&["torch_cpu.dll", "libtorch_cpu.so", "libtorch_cpu.dylib"]],
        "cuda" => &[&["cudart64_13.dll", "libcudart.so"]],
        "llama" => &[
            &["llama.dll", "libllama.so", "libllama.dylib"],
            &["mtmd.dll", "libmtmd.so", "libmtmd.dylib"],
        ],
        "diffusion" => &[&[
            "stable-diffusion.dll",
            "libstable-diffusion.so",
            "libstable-diffusion.dylib",
        ]],
        "hugging-face" => &[
            &["model.safetensors"],
            &["lama-manga.safetensors"],
            &["PaddleOCR-VL-1.6-GGUF.gguf"],
            &["PaddleOCR-VL-1.6-GGUF-mmproj.gguf"],
        ],
        _ => &[],
    };
    let names = directory_file_names(directory).ok()?;
    let missing = required
        .iter()
        .filter(|alternatives| {
            !alternatives
                .iter()
                .any(|name| names.contains(&name.to_ascii_lowercase()))
        })
        .map(|alternatives| alternatives[0])
        .collect::<Vec<_>>();
    (!missing.is_empty()).then(|| format!("Thiếu file bắt buộc: {}", missing.join(", ")))
}

fn directory_file_names(path: &Path) -> Result<HashSet<String>> {
    let mut names = HashSet::new();
    let mut stack = vec![path.to_path_buf()];
    while let Some(directory) = stack.pop() {
        for entry in std::fs::read_dir(directory)? {
            let entry = entry?;
            let file_type = entry.file_type()?;
            if file_type.is_symlink() {
                continue;
            }
            if file_type.is_dir() {
                stack.push(entry.path());
            } else if file_type.is_file() {
                names.insert(entry.file_name().to_string_lossy().to_ascii_lowercase());
            }
        }
    }
    Ok(names)
}

fn optional_directory_bytes(path: &Path) -> Result<u64> {
    if path.is_dir() {
        directory_bytes(path)
    } else {
        Ok(0)
    }
}

fn push_cleanup_candidate(
    candidates: &mut Vec<CleanupCandidate>,
    target: &'static str,
    label: &'static str,
    bytes: u64,
    requires_confirmation: bool,
) {
    if bytes > 0 {
        candidates.push(CleanupCandidate {
            target,
            label,
            bytes,
            requires_confirmation,
        });
    }
}

pub fn resolve_path(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

fn directory_bytes(path: &Path) -> Result<u64> {
    let mut total = 0u64;
    let mut seen = HashSet::new();
    let mut stack = vec![path.to_path_buf()];
    while let Some(directory) = stack.pop() {
        for entry in std::fs::read_dir(&directory)? {
            let entry = entry?;
            let file_type = entry.file_type()?;
            if file_type.is_symlink() {
                continue;
            }
            if file_type.is_dir() {
                stack.push(entry.path());
            } else if file_type.is_file() {
                let path = entry.path();
                if file_key(&path).is_none_or(|key| seen.insert(key)) {
                    total = total.saturating_add(entry.metadata()?.len());
                }
            }
        }
    }
    Ok(total)
}

fn relative_top_level(root: &Path, path: &Path) -> Option<String> {
    path.strip_prefix(root)
        .ok()?
        .components()
        .next()?
        .as_os_str()
        .to_str()
        .map(str::to_ascii_lowercase)
}

fn build_cuda_version() -> Option<String> {
    let version = env!("MANGA_TRANSLATE_CUDA_BUILD_VERSION");
    (version != "cpu" && version != "unknown").then(|| version.to_string())
}

fn installed_toolkit_version() -> Option<String> {
    command_output("nvcc", &["--version"])
        .as_deref()
        .and_then(|output| version_after(output, "release "))
}

fn parse_gpu_query(output: &str) -> Option<(Option<String>, Option<String>, Option<u64>)> {
    let mut values = output.lines().next()?.split(',').map(str::trim);
    let name = values
        .next()
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let driver = values
        .next()
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let memory = values.next().and_then(|value| value.parse().ok());
    Some((name, driver, memory))
}

fn version_after(input: &str, marker: &str) -> Option<String> {
    let start = input.find(marker)? + marker.len();
    let value: String = input[start..]
        .trim_start()
        .chars()
        .take_while(|character| character.is_ascii_digit() || *character == '.')
        .collect();
    (!value.is_empty()).then_some(value)
}

fn version_is_newer(left: &str, right: &str) -> bool {
    version_parts(left) > version_parts(right)
}

fn version_parts(value: &str) -> (u32, u32) {
    let mut parts = value.split('.').filter_map(|part| part.parse().ok());
    (parts.next().unwrap_or(0), parts.next().unwrap_or(0))
}

fn command_output(program: &str, arguments: &[&str]) -> Option<String> {
    let mut command = Command::new(program);
    command.args(arguments);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    successful_output(command.output().ok()?)
}

fn successful_output(output: Output) -> Option<String> {
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).into_owned())
}

fn display_path(path: &Path) -> String {
    path.to_string_lossy()
        .strip_prefix(r"\\?\")
        .unwrap_or(&path.to_string_lossy())
        .to_string()
}

#[cfg(windows)]
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
struct FileKey(u32, u64);

#[cfg(not(windows))]
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
struct FileKey(u64);

#[cfg(windows)]
fn file_key(path: &Path) -> Option<FileKey> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Storage::FileSystem::{
        BY_HANDLE_FILE_INFORMATION, CreateFileW, FILE_ATTRIBUTE_NORMAL, FILE_READ_ATTRIBUTES,
        FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, GetFileInformationByHandle,
        OPEN_EXISTING,
    };

    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let handle = unsafe {
        CreateFileW(
            wide.as_ptr(),
            FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            std::ptr::null(),
            OPEN_EXISTING,
            FILE_ATTRIBUTE_NORMAL,
            std::ptr::null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return None;
    }
    let mut information: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    let success = unsafe { GetFileInformationByHandle(handle, &mut information) } != 0;
    unsafe { CloseHandle(handle) };
    success.then(|| {
        FileKey(
            information.dwVolumeSerialNumber,
            (u64::from(information.nFileIndexHigh) << 32) | u64::from(information.nFileIndexLow),
        )
    })
}

#[cfg(not(windows))]
fn file_key(_path: &Path) -> Option<FileKey> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_cuda_versions() {
        assert_eq!(
            version_after("CUDA Version: 13.2", "CUDA Version:"),
            Some("13.2".into())
        );
        assert_eq!(
            version_after("release 13.2, V13.2.78", "release "),
            Some("13.2".into())
        );
        assert_eq!(
            version_after(
                "KMD Version: 610.88 CUDA UMD Version: 13.3",
                "CUDA UMD Version:"
            ),
            Some("13.3".into())
        );
        assert!(version_is_newer("13.2", "13.1"));
        assert!(!version_is_newer("13.1", "13.2"));
    }

    #[test]
    fn scans_runtime_and_cleans_only_selected_storage() {
        let temp = tempfile::tempdir().expect("temp data directory");
        let models = temp.path().join("models");
        let downloads = temp.path().join("runtime").join(".downloads");
        let active = temp.path().join(ACTIVE_RUNTIME_DIRECTORY);
        let visual_context_cache = temp.path().join("visual-context-cache");
        let project = temp.path().join("projects").join("keep.txt");
        std::fs::create_dir_all(&models).expect("models directory");
        std::fs::create_dir_all(&downloads).expect("downloads directory");
        for (component, filename) in [
            ("torch", "torch_cpu.dll"),
            ("llama", "llama.dll"),
            ("diffusion", "stable-diffusion.dll"),
            ("hugging-face", "model.safetensors"),
        ] {
            let directory = active.join(component);
            std::fs::create_dir_all(&directory).expect("runtime component");
            std::fs::write(directory.join(filename), [1u8]).expect("runtime file");
        }
        std::fs::write(active.join("llama/mtmd.dll"), [1u8]).expect("mtmd runtime");
        for filename in [
            "lama-manga.safetensors",
            "PaddleOCR-VL-1.6-GGUF.gguf",
            "PaddleOCR-VL-1.6-GGUF-mmproj.gguf",
        ] {
            std::fs::write(active.join("hugging-face").join(filename), [1u8])
                .expect("pipeline model");
        }
        std::fs::create_dir_all(project.parent().unwrap()).expect("projects directory");
        std::fs::create_dir_all(&visual_context_cache).expect("visual context cache directory");
        std::fs::write(models.join("model.bin"), vec![1u8; 12]).expect("model");
        std::fs::write(downloads.join("archive.zip"), vec![1u8; 7]).expect("archive");
        std::fs::write(&project, b"keep").expect("project");
        std::fs::write(visual_context_cache.join("context.json"), vec![2u8; 11])
            .expect("visual context cache");

        let report = StorageDiagnostics::scan(temp.path()).expect("storage report");
        assert_eq!(report.models_bytes, 12);
        assert_eq!(report.downloads_bytes, 7);
        assert_eq!(report.visual_context_cache_bytes, 11);
        assert_eq!(report.active_runtime.status, "ready");
        assert_eq!(report.legacy_bytes, 19);
        assert_eq!(
            cleanup_storage(temp.path(), "downloads").expect("cleanup"),
            7
        );
        assert!(!downloads.exists());
        assert_eq!(
            cleanup_storage(temp.path(), "visual-context-cache").expect("context cleanup"),
            11
        );
        assert!(!visual_context_cache.exists());
        assert!(project.exists());
        assert!(active.exists());
    }

    #[test]
    fn cleans_staging_without_touching_active_packages() {
        let temp = tempfile::tempdir().expect("temp data directory");
        let active = temp.path().join(ACTIVE_RUNTIME_DIRECTORY);
        let ready = active.join("torch").join("ready.bin");
        let staging = active.join("torch").join(".install-interrupted");
        std::fs::create_dir_all(&staging).expect("staging directory");
        std::fs::write(&ready, b"ready").expect("active package");
        std::fs::write(staging.join("partial.bin"), vec![0u8; 9]).expect("partial package");

        assert_eq!(cleanup_storage(temp.path(), "staging").expect("cleanup"), 9);
        assert!(ready.exists());
        assert!(!staging.exists());
        assert!(cleanup_storage(temp.path(), "projects").is_err());
    }

    #[test]
    fn runtime_health_detects_a_missing_required_dll() {
        let temp = tempfile::tempdir().expect("temp data directory");
        let active = temp.path().join(ACTIVE_RUNTIME_DIRECTORY);
        for (component, files) in [
            ("torch", vec!["torch_cpu.dll"]),
            ("llama", vec!["llama.dll"]),
            ("diffusion", vec!["stable-diffusion.dll"]),
            (
                "hugging-face",
                vec![
                    "model.safetensors",
                    "lama-manga.safetensors",
                    "PaddleOCR-VL-1.6-GGUF.gguf",
                    "PaddleOCR-VL-1.6-GGUF-mmproj.gguf",
                ],
            ),
        ] {
            let directory = active.join(component);
            std::fs::create_dir_all(&directory).expect("runtime component");
            for file in files {
                std::fs::write(directory.join(file), [1u8]).expect("runtime artifact");
            }
        }

        let runtime = RuntimeHealth::scan(temp.path()).expect("runtime health");
        assert_eq!(runtime.status, "incomplete");
        let llama = runtime
            .components
            .iter()
            .find(|component| component.id == "llama")
            .expect("llama diagnostics");
        assert_eq!(llama.status, "invalid");
        assert!(
            llama
                .message
                .as_deref()
                .is_some_and(|message| message.contains("mtmd.dll"))
        );
    }
}
