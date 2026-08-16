# Manga Translate Local

Chrome extension dịch manga trực tiếp trên trang web bằng một ứng dụng Windows hợp nhất được xây dựng từ mã nguồn Koharu `0.61.2`.

Từ phiên bản `0.8.0`, toàn bộ local HTTP API, model discovery, kiểm tra provider, hàng đợi dịch, pipeline Koharu, Native Messaging và biểu tượng khay hệ thống nằm trong một file:

```text
MangaTranslate.exe
```

Ứng dụng không cần Node.js, PowerShell tray, `koharu.exe` hoặc `manga-engine.exe` riêng khi sử dụng hằng ngày.

## Tính năng hiện tại

- Nhận diện ảnh manga từ `img`, `picture`, canvas, CSS background, lazy-load và trang SPA.
- Lọc logo, avatar và banner theo kích thước/ngữ cảnh reader.
- Capture byte ảnh gốc; fallback sang screenshot và crop khi gặp `blob:`, canvas tainted, CORS hoặc hotlink protection.
- Hiển thị ảnh dịch bằng overlay, không thay đổi `src`/`srcset` và có thể khôi phục ảnh gốc tức thì.
- Cache bản dịch bằng IndexedDB và tự phục hồi khi reload, chuyển chương hoặc dùng Back/Forward.
- Dịch từng ảnh, dịch toàn trang, dừng hàng đợi, bật/tắt extension và dịch tự động.
- Mỗi cặp provider/model có API key và Base URL riêng, kèm kiểm tra API và tải danh sách model.
- Lưu tối đa 20 lỗi gần nhất với bước lỗi, provider, HTTP status, request ID và gợi ý xử lý.
- Tự đánh thức ứng dụng Windows qua Chrome Native Messaging; không cần mở Koharu thủ công.

## Kiến trúc

```text
Trang manga
  -> Chrome content script: nhận diện ảnh, overlay, khôi phục
  -> Chrome service worker: capture, cache, API profile
  -> Native Messaging: đánh thức MangaTranslate.exe
  -> HTTP 127.0.0.1:40721: truyền ảnh dung lượng lớn
  -> Koharu crates: detect -> OCR -> API dịch text -> inpaint -> render
```

Native Messaging chỉ truyền lệnh điều khiển nhỏ. Ảnh manga đi qua HTTP localhost để không vướng giới hạn 1 MiB của native host. Ảnh được xử lý trên máy; provider dịch chỉ nhận văn bản OCR và thông tin dịch cần thiết.

## Yêu cầu

### Sử dụng

- Windows 10/11 x64.
- Google Chrome.
- API key của provider đã chọn, trừ provider local/OpenAI-compatible không yêu cầu xác thực.
- GPU NVIDIA là tùy chọn; có thể chạy CPU nhưng chậm hơn đáng kể.

### Build

- Rust `1.95` trở lên.
- Visual Studio 2022 C++ Build Tools.
- LLVM có `libclang.dll`.
- CUDA Toolkit nếu build bản GPU.
- Node.js `20` trở lên chỉ để chạy test JavaScript.

Source Koharu được ghim tại phiên bản `0.61.2` trong `vendor/koharu`.

## Cài đặt

Thứ tự cài đặt rất quan trọng: extension phải được load vào Chrome trước khi đăng ký Native Messaging.

### 1. Build ứng dụng

```powershell
cd D:\translate_manga
git submodule update --init --recursive
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\build-engine.ps1 -Cuda
```

Binary được tạo tại:

```text
D:\translate_manga\engine\target\release\MangaTranslate.exe
```

Bỏ `-Cuda` để build bản CPU.

### 2. Load extension

1. Mở `chrome://extensions`.
2. Bật **Developer mode**.
3. Chọn **Load unpacked**.
4. Chọn thư mục `D:\translate_manga\extension`.
5. Giữ Chrome mở để installer có thể tìm thấy extension ID.

### 3. Cài ứng dụng và Chrome Integration

```powershell
& "D:\translate_manga\engine\target\release\MangaTranslate.exe" --install
```

Installer sẽ:

1. Sao chép binary vào `%LOCALAPPDATA%\MangaTranslate\MangaTranslate.exe`.
2. Tìm extension ID trong các Chrome profile đã load extension.
3. Tạo manifest `com.manga_translate.local` với đúng allowlist extension.
4. Đăng ký Native Messaging trong `HKCU`.
5. Đăng ký chạy cùng Windows.
6. Khởi động tray và local service.

Không cần quyền Administrator. Khi extension ID hoặc thư mục extension thay đổi, bấm **Install Chrome Integration** trong menu tray hoặc chạy lại `--install`.

## Sử dụng hằng ngày

Sau khi cài một lần, không cần mở terminal hoặc Koharu:

1. Mở trang đọc manga.
2. Mở popup extension và bật **Bật extension**.
3. Chọn provider/model, nhập API key và bấm **Kiểm tra API và model**.
4. Chọn ngôn ngữ đích rồi lưu cấu hình.
5. Bấm **Dịch trang**, nút trên từng ảnh hoặc bật **Dịch tự động**.

Phím tắt mặc định:

- `Alt+Shift+T`: dịch trang.
- `Alt+Shift+R`: khôi phục ảnh gốc.

Menu chuột phải của biểu tượng tray gồm:

- Trạng thái service và engine.
- Bật/tắt local service.
- Khởi tạo lại engine để giải phóng model khỏi RAM/VRAM.
- Mở thư mục log.
- Bật/tắt chạy cùng Windows.
- Cài lại Chrome Integration.
- Thoát Manga Translate.

## API và model

Pipeline hỗ trợ OpenAI, Gemini, Claude, DeepSeek, DeepL, Google Translate, Caiyun và OpenAI-compatible.

- Mỗi cặp `provider + model` giữ API key và Base URL riêng.
- DeepL tự kiểm tra endpoint Free/Pro.
- OpenAI-compatible hỗ trợ dịch vụ như Ollama hoặc LM Studio, ví dụ `http://127.0.0.1:11434/v1`.
- Đổi provider, model, Base URL, ngôn ngữ hoặc system prompt sẽ tạo khóa cache khác.

API key được lưu trong `chrome.storage.local` của extension. Key không được đưa vào DOM trang web, lịch sử lỗi, log engine hoặc project tạm; service worker chỉ gửi key tới local service khi thực hiện yêu cầu dịch.

## Pipeline Koharu

Mỗi ảnh được xử lý tuần tự qua:

1. `comic-text-bubble-detector`
2. `comic-text-detector-seg`
3. `speech-bubble-segmentation`
4. `paddle-ocr-vl-1.6`
5. `yuzumarker-font-detection`
6. `llm`
7. `lama-manga`
8. `koharu-renderer`

Engine chỉ khởi tạo ở yêu cầu dịch đầu tiên. `engine: "sleeping"` nghĩa là service đã sẵn sàng nhưng model chưa chiếm RAM/VRAM.

## Dữ liệu và dung lượng

Ứng dụng cài và ghi log tại:

```text
%LOCALAPPDATA%\MangaTranslate
```

Thứ tự chọn thư mục model/runtime:

1. Tham số `--data-dir DIR`.
2. Biến môi trường `ENGINE_DATA_DIR`.
3. `%LOCALAPPDATA%\Koharu` nếu thư mục `runtime` tồn tại.
4. `%LOCALAPPDATA%\MangaTranslate\data` trên máy sạch.

Có thể chuyển model sang ổ khác bằng `ENGINE_DATA_DIR` hoặc NTFS junction. Không xóa `runtime\cuda`, `runtime\llama.cpp` hoặc model đang dùng trong pipeline. Thư mục `runtime\.downloads` chỉ chứa gói cài đã tải và có thể xóa sau khi runtime hoạt động ổn định.

## Cấu hình nâng cao

Các biến môi trường được hỗ trợ:

| Biến | Mặc định | Tác dụng |
| --- | --- | --- |
| `SERVICE_PORT` | `40721` | Cổng HTTP localhost |
| `MAX_IMAGE_BYTES` | `41943040` | Dung lượng ảnh tối đa, tính theo byte |
| `ENGINE_DATA_DIR` | tự phát hiện | Thư mục model/runtime |
| `ENGINE_CPU` | `false` | Ép engine chạy CPU |
| `RUST_LOG` | `info` | Mức log của ứng dụng |

CLI hỗ trợ các chế độ `--tray`, `--service`, `--native-messaging`, `--install`, `--uninstall`, `--cpu` và `--data-dir DIR`.

## Trạng thái và log

Kiểm tra service:

```powershell
Invoke-RestMethod http://127.0.0.1:40721/health
```

Kết quả bình thường:

```json
{
  "status": "ok",
  "mode": "unified",
  "engine": "sleeping",
  "engineSource": "koharu-0.61.2",
  "version": "0.8.0"
}
```

Log nằm tại `%LOCALAPPDATA%\MangaTranslate\logs\manga-translate.log`.

## Xử lý sự cố

### Chrome báo chưa cài native host

1. Xác nhận extension đang được load tại `chrome://extensions`.
2. Chạy lại `MangaTranslate.exe --install` hoặc bấm **Install Chrome Integration** trong tray.
3. Reload extension và mở lại trang manga.

### `CUDA_ERROR_UNSUPPORTED_PTX_VERSION`

CUDA Toolkit dùng để build/runtime đang mới hơn khả năng của driver NVIDIA. Cập nhật driver để hỗ trợ toolkit hiện tại hoặc build lại với CUDA Toolkit tương thích. Kiểm tra mức CUDA driver hỗ trợ bằng:

```powershell
nvidia-smi
```

Có thể dùng `--cpu` hoặc `ENGINE_CPU=true` để chạy tạm bằng CPU.

### Service chạy nhưng engine là `sleeping`

Đây không phải lỗi. Engine chỉ tải model khi bắt đầu dịch ảnh đầu tiên.

### Đổi model nhưng vẫn thấy bản dịch cũ

Extension đã đưa provider, model, Base URL, ngôn ngữ đích và system prompt vào khóa cache. Nếu cấu hình không đổi nhưng muốn dịch lại, dùng **Xóa cache** trong popup.

## Kiểm thử

```powershell
npm test
npm run check
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\build-engine.ps1 -Check -Cuda
```

Để chạy Rust unit test trực tiếp, đặt `LIBCLANG_PATH` tới thư mục chứa `libclang.dll`:

```powershell
$env:LIBCLANG_PATH = "$env:LOCALAPPDATA\LLVM\bin"
cargo test --manifest-path .\engine\Cargo.toml
cargo fmt --manifest-path .\engine\Cargo.toml -- --check
```

## Gỡ cài đặt

```powershell
& "$env:LOCALAPPDATA\MangaTranslate\MangaTranslate.exe" --uninstall
```

Lệnh này gỡ Native Messaging manifest và mục chạy cùng Windows. Dữ liệu model/cache không tự bị xóa để tránh phải tải lại khi cài lại.

## Giấy phép

Ứng dụng liên kết trực tiếp mã nguồn Koharu GPL-3.0-only nên dự án được phân phối theo GPL-3.0-only. Xem `LICENSE` và `THIRD_PARTY_NOTICES.md`.

Torii chỉ được dùng để nghiên cứu hành vi nhận diện và trải nghiệm người dùng; dự án không sao chép backend, credit system hoặc mã độc quyền của Torii.
