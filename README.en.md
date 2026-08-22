# Manga Translate Local

[README tieng Viet](README.md)

A Chrome extension that translates manga directly in a reader page through one unified Windows application built from the Koharu `0.70.2` source code.

Since `0.8.0`, the local HTTP API, model discovery, provider checks, translation queue, Koharu pipeline, Native Messaging host, and system-tray application are packaged in one executable:

```text
MangaTranslate.exe
```

You do not need Node.js, a PowerShell tray script, `koharu.exe`, or a separate `manga-engine.exe` during normal use. `0.10.0` moved to Koharu's scene-native pipeline, `0.14.0` added Queue Manager, `0.15.x` added page/site cache and local MiniCPM-V Visual Context, and `0.16.0` added a scene-native editor for individual speech bubbles.

## Features

- Detects manga images in `img`, `picture`, canvas, CSS backgrounds, lazy-loaded readers, and SPA pages.
- Filters avatars, banners, and logos using image size and reader context.
- Captures original image bytes, with screenshot/crop fallbacks for `blob:`, tainted canvas, CORS, and hotlink-protected images.
- Shows translated images as overlays without changing `src` or `srcset`; original images can be restored instantly.
- Uses IndexedDB translation cache with pipeline version, site/chapter/provider/model metadata and restores translations after reload or browser Back/Forward.
- Provides per-page/chapter, per-site, and global cache cleanup, plus 90-day/1 GiB/1,000-item LRU maintenance.
- Supports image, page, and automatic translation; extension enable/disable; retries and detailed diagnostics.
- Queues images serially to protect VRAM, prioritizes the viewport, and can pause, resume, or cancel work safely.
- Optionally runs MiniCPM-V 4.6 locally to infer speaker, emotion, tone, and page context without sending source image bytes to a translation provider.
- Lets you edit a translated bubble: text, font, size, bold/italic, alignment, and line spacing. Edits render from the existing OCR/inpaint scene instead of running those expensive stages again.
- Uses separate API key and Base URL profiles for every provider/model pair, with API validation and model discovery.
- Starts and controls the Windows application through Chrome Native Messaging. Koharu never needs to be opened manually.
- Monitors GPU/driver/CUDA compatibility, engine memory state, runtime health, CPU fallback, and safe cleanup of legacy Koharu data.

## Architecture

```text
Manga page
  -> Chrome content script: image detection, viewport queue, overlays, restore
  -> Chrome service worker: capture, cache, API profiles
  -> Native Messaging: wakes MangaTranslate.exe
  -> HTTP 127.0.0.1:40721: transfers large images
  -> Koharu crates: detect -> OCR -> scene with panels/bubbles/segments
  -> Optional MiniCPM-V: source image + scene/OCR -> local context JSON
  -> Koharu crates: translate with API + context -> inpaint -> render
```

Native Messaging only sends small control commands. Manga images use localhost HTTP so they do not hit the 1 MiB Native Messaging limit. Images are processed locally. With Visual Context enabled, the translation provider receives OCR text and the locally generated context summary, never the original source-image bytes.

## Requirements

### End users

- Windows 10/11 x64.
- Google Chrome.
- An API key for the selected provider, except local/OpenAI-compatible providers that do not need authentication.
- NVIDIA GPU is optional. CPU mode works, but is considerably slower.

### Building from source

- Rust `1.95` or newer.
- Visual Studio 2022 C++ Build Tools.
- LLVM with `libclang.dll`.
- Ninja and LLVM/clang-cl to build the Windows Torch shim.
- Node.js `20` or newer for JavaScript tests only.

The active Koharu source is pinned in `vendor/koharu-0.70.2`. The older `0.61.2` source remains in `vendor/koharu` only as a migration rollback option.

## Installation

Load the extension into Chrome before registering Native Messaging, so the installer can discover the extension ID.

### 1. Build the Windows application

```powershell
cd D:\translate_manga
git submodule update --init --recursive
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\build-engine.ps1 -Cuda
```

The binary is created at:

```text
D:\translate_manga\engine\target\release\MangaTranslate.exe
```

Omit `-Cuda` for a CPU build.

### 2. Load the Chrome extension

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Select **Load unpacked**.
4. Choose `D:\translate_manga\extension`.
5. Keep Chrome open while installing the Windows application.

### 3. Install the app and Chrome integration

```powershell
& "D:\translate_manga\engine\target\release\MangaTranslate.exe" --install
```

The installer copies the executable and `koharu-torch.dll` into `%LOCALAPPDATA%\MangaTranslate`, finds loaded Chrome extension IDs, creates the allowlisted `com.manga_translate.local` manifest, registers it in `HKCU`, enables startup with Windows, and starts the tray/service. Administrator permissions are not required.

Run `--install` again, or choose **Install Chrome Integration** from the tray menu, after changing the extension ID or extension folder.

## Everyday use

1. Open a manga reader page.
2. Open the extension popup and enable the extension.
3. Select a provider/model, enter its API key, then select **Check API and model**.
4. Select target language and optional **Visual Context**, then save.
5. Select **Translate page**, use an image button, or enable **Automatic translation**.

The in-page queue and popup show detected images, completed images, and the current pipeline step. Pause stops before the next image; resume continues; cancel uses Koharu's `StopToken` at a safe pipeline boundary rather than killing the process.

Select the green button on a translated image to open **Edit bubbles**. Select a highlighted region and edit its text or typography. The editor synchronizes after a short debounce; **Sync now** forces an immediate render. Edited text always uses horizontal writing, including source scenes whose OCR was vertical. The font menu groups manga/handwriting, readable, display, classic, and monospace fonts; **Other font** accepts the name of any Windows-installed font. Renders are serialized and only the newest change is retained, so stale responses cannot overwrite text currently being typed.

The editor pauses remaining queue work, survives MangaDex virtualized image DOM nodes, and rebuilds a missing in-memory scene from the original source image once when necessary. That recovery bypasses the translated PNG cache and may run the pipeline/API again. **Retranslate** sends only the selected segment to the provider while retaining the page Visual Context. **API version** restores its original translation/style; **Original image** removes the overlay. The engine retains up to 12 recent edit sessions in memory; edited PNGs remain in Chrome cache.

Default shortcuts:

- `Alt+Shift+T`: translate page.
- `Alt+Shift+R`: restore original images.

The tray menu shows service/engine status and RAM/VRAM, starts or stops the service, loads/unloads/restarts the engine, retries GPU after CPU fallback, configures engine preload, opens model/runtime and log folders, controls Windows startup, reinstalls Chrome integration, and exits the app.

## Providers, API keys, and models

The pipeline supports OpenAI, Gemini, Claude, DeepSeek, DeepL, Google Translate, Caiyun, and OpenAI-compatible endpoints.

- Every `provider + model` combination owns a separate API key and Base URL.
- DeepL detects its Free/Pro endpoint.
- OpenAI-compatible endpoints include Ollama and LM Studio, for example `http://127.0.0.1:11434/v1`.
- Provider, model, Base URL, target language, system prompt, and pipeline version are part of the cache key.
- Visual Context is also part of the cache key, so contextual and non-contextual translations never collide.

API keys are stored in the extension's `chrome.storage.local`. They are not inserted into page DOM, engine logs, diagnostics, cache metadata, or temporary project files. The service worker only sends a key to the local service while issuing a translation request.

## Translation cache

The IndexedDB cache uses schema v2. A cache key is SHA-256 of original image bytes plus provider, model, Base URL, target language, system prompt, and `koharu-0.70.2-scene-v1`. API keys are never stored in the cache.

Each record stores byte size, creation/last-access time, and site/chapter scope. MangaDex URLs such as `/chapter/<id>/1`, `/2`, and `/14` are treated as one chapter, allowing reliable scrolling and Back/Forward restoration. The **Translation cache** popup exposes global/site/current chapter statistics and cleanup. Legacy v1 records migrate in place when reused.

## Koharu pipeline and Visual Context

Each image uses this scene-native workflow:

1. `koharu-layout-rfdetr-seg-2xl` detects layout, text regions, and speech bubbles.
2. `paddleocr-vl-1.6` runs OCR.
3. If enabled, **MiniCPM-V 4.6 - economical** receives the source image, panel/bubble/segment coordinates, and OCR text, then produces a local scene-context JSON document.
4. The context is validated against segment and bubble IDs, visual evidence, non-duplicated character IDs, and confidence thresholds.
5. The selected provider translates keyed segments with trusted speaker, listener, emotion, and tone context.
6. `lama` removes source text.
7. `koharu-renderer` and `koharu-rasterizer` lay out text and output PNG.

Visual Context uses `openbmb/MiniCPM-V-4.6-gguf`, `MiniCPM-V-4_6-Q4_K_M.gguf`, and `mmproj-model-f16.gguf`. Koharu downloads the model to its runtime store on first use and runs it through embedded `llama.cpp` after OCR. Context cache files are JSON only; source images are not retained. A failed download, inference, or validation produces `VISUAL_CONTEXT_FALLBACK` in diagnostics and continues with ordinary translation.

## Data, storage, and engine lifecycle

The installed app and logs are in:

```text
%LOCALAPPDATA%\MangaTranslate
```

The model/runtime directory is selected in this order:

1. `--data-dir DIR`.
2. `ENGINE_DATA_DIR` environment variable.
3. `%LOCALAPPDATA%\Koharu` when `runtime-v0.70.2` or legacy `runtime` exists.
4. `%LOCALAPPDATA%\MangaTranslate\data` on a clean system.

You can relocate models to another drive with `ENGINE_DATA_DIR` or an NTFS junction. Koharu `0.70.2` uses `runtime-v0.70.2`, separated from the old `runtime`. Its CUDA/Torch/native-runtime download archives use staging inside this data store rather than `%TEMP%` on drive C.

Visual Context JSON cache lives in `visual-context-cache` under the data directory. The popup reports and clears it separately, without deleting MiniCPM-V models or Chrome's translation cache.

The engine loads only for the first translation. `engine: "sleeping"` means the service is ready and models have been released. By default the watchdog returns it to this state after 15 idle minutes; timeout and preload are configurable from **Engine & storage**.

## Advanced configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `SERVICE_PORT` | `40721` | Local HTTP port |
| `MAX_IMAGE_BYTES` | `41943040` | Maximum image size in bytes |
| `ENGINE_DATA_DIR` | auto-detect | Model/runtime directory |
| `ENGINE_CPU` | `false` | Force CPU engine mode |
| `ENGINE_IDLE_TIMEOUT_SECONDS` | `900` | Idle seconds before unload; `0` disables it |
| `ENGINE_PRELOAD` | `false` | Preload engine core when service starts |
| `RUST_LOG` | `info` | Application log level |

The CLI supports `--tray`, `--service`, `--native-messaging`, `--install`, `--uninstall`, `--cpu`, and `--data-dir DIR`.

## Status and diagnostics

Check the service:

```powershell
Invoke-RestMethod http://127.0.0.1:40721/health
```

Expected response:

```json
{
  "status": "ok",
  "mode": "unified",
  "engine": "sleeping",
  "engineSource": "koharu-0.70.2",
  "version": "0.16.0"
}
```

Logs: `%LOCALAPPDATA%\MangaTranslate\logs\manga-translate.log`.

**Engine & storage** reports lifecycle, RAM, VRAM, GPU, driver, CUDA runtime, GPU/CPU fallback mode, recovery status, data path, and active runtime health. Cleanup is whitelist-based and rejects active runtime, project, and configuration directories. It also refuses legacy cleanup while Koharu Desktop is still running. Unload/restart/GPU retry/cleanup are rejected while models are loading or images are being processed.

CUDA/PTX failures trigger CPU fallback. After updating drivers or repairing runtime, use **Retry GPU** to unload the CPU engine and initialize GPU again. The tray watchdog restarts an unexpectedly stopped HTTP service up to three times per failure sequence, while a manual **Stop Service** disables restart until the user or Native Messaging starts it again.

## Troubleshooting

### Chrome says the native host is not installed

1. Confirm that the extension is loaded in `chrome://extensions`.
2. Run `MangaTranslate.exe --install` again or use **Install Chrome Integration** from the tray.
3. Reload the extension and manga page.

### `CUDA_ERROR_UNSUPPORTED_PTX_VERSION`

Koharu downloaded a CUDA runtime newer than the installed NVIDIA driver supports. Update the driver, or use CPU fallback. Check the driver's CUDA support with:

```powershell
nvidia-smi
```

Use `--cpu` or `ENGINE_CPU=true` for temporary CPU mode.

### Service works but engine is `sleeping`

This is normal. The engine loads models only when the first image translation starts.

### Engine is using CPU fallback

Open **Engine & storage** to see the last error. After fixing the driver or runtime, use **Retry GPU**. Existing translation cache is unaffected.

### A changed model still shows an old translation

Provider, model, Base URL, target language, system prompt, and pipeline version are cache-key fields. If the configuration did not change but you need a new translation, clear current chapter/page, site, or all entries from **Translation cache**.

### Visual Context falls back

Translation still completes without visual context. First use needs Internet access to download MiniCPM-V into the engine store. Check free data-drive space, logs, and Hugging Face connectivity. Once downloaded, it runs locally; a cached page context is reused across translation-provider changes.

## Tests

```powershell
npm test
npm run check
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\build-engine.ps1 -Check -Cuda
```

For Rust unit tests, point `LIBCLANG_PATH` at the directory containing `libclang.dll`:

```powershell
$env:LIBCLANG_PATH = "$env:LOCALAPPDATA\LLVM\bin"
cargo test --manifest-path .\engine\Cargo.toml
cargo fmt --manifest-path .\engine\Cargo.toml -- --check
```

Rust build artifacts are stored in `engine\target`; they contain no models, translation cache, or user data, but can grow after feature/build changes. Clean reproducible artifacts with:

```powershell
npm run clean:build
```

This does not affect the installed application in `%LOCALAPPDATA%\MangaTranslate`.

## Uninstall

```powershell
& "$env:LOCALAPPDATA\MangaTranslate\MangaTranslate.exe" --uninstall
```

This removes the Native Messaging manifest and Windows startup entry. Models and cache are intentionally retained to avoid re-downloading on a later reinstall.

## License

This project directly links Koharu source code licensed as GPL-3.0-only and is therefore distributed under GPL-3.0-only. See `LICENSE` and `THIRD_PARTY_NOTICES.md`.

Torii was used only to study image-detection behavior and user experience. This project does not copy Torii's backend, credit system, or proprietary code.
