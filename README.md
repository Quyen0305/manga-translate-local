# Manga Translate Local

Chrome extension dịch manga ngay trên trang web. Extension nhận diện ảnh manga, gửi ảnh vào backend cục bộ và hiển thị ảnh đã dịch dưới dạng lớp phủ nên có thể khôi phục ảnh gốc tức thì.

Từ phiên bản `0.7.0`, dự án không còn gọi `D:\koharu\koharu.exe` hoặc HTTP service Koharu ở cổng `40722`. Repo build một native worker riêng từ source Koharu `0.61.2`; backend Node giao tiếp với worker qua stdin/stdout.

## Kiến trúc

```text
Trang manga
  -> Chrome content script: nhận diện img/canvas/background, overlay, restore
  -> Chrome service worker: capture, SHA-256 cache, API profiles
  -> Manga Translate service :40721
  -> manga-engine.exe (stdin/stdout, không mở GUI và không có cổng riêng)
  -> Koharu crates: detect -> OCR -> API dịch text -> inpaint -> render
```

Ảnh manga chỉ được xử lý trên máy. Nhà cung cấp OpenAI, Gemini, Claude, DeepSeek hoặc DeepL chỉ nhận phần văn bản OCR cần dịch. OpenAI-compatible có thể dùng Ollama/LM Studio để không phát sinh phí API.

## Yêu cầu build

- Windows 10/11 x64.
- Node.js 20 trở lên.
- Rust 1.95 trở lên, cài bằng `rustup`.
- Visual Studio 2022 C++ Build Tools.
- LLVM có `libclang.dll` để build bindings của `koharu-llm`.
- CUDA Toolkit chỉ cần khi chủ động build feature CUDA; bản mặc định dùng backend tương thích rộng.

Source Koharu được ghim bằng Git submodule tại commit `35f3e6d` (tag `0.61.2`).

## Cài và chạy

```powershell
cd D:\translate_manga
git submodule update --init --recursive
npm test
npm run build:engine
powershell -ExecutionPolicy Bypass -File .\scripts\start-service.ps1
```

`start-service.ps1` sẽ tự build engine nếu binary chưa tồn tại. Build đầu tiên lâu hơn do Cargo tải và biên dịch các thư viện ML. Binary nằm tại `engine\target\release\manga-engine.exe`.

Kiểm tra service:

```powershell
Invoke-RestMethod http://127.0.0.1:40721/health
```

Engine chưa chạy ngay khi service mới bật. Nó tự khởi động ở tác vụ dịch đầu tiên, giữ model trong bộ nhớ cho các ảnh tiếp theo và tự dừng cùng service. Không cần mở hoặc cài ứng dụng Koharu.

Để service tự chạy khi đăng nhập Windows:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-startup.ps1
```

## Cài extension

1. Mở `chrome://extensions`.
2. Bật **Developer mode**.
3. Chọn **Load unpacked** và trỏ tới `D:\translate_manga\extension`.
4. Mở popup, chọn provider/model, nhập API key của đúng model và bấm **Kiểm tra API và model**.
5. Bật **Dịch tự động** hoặc dùng nút dịch từng ảnh/toàn trang.

Mỗi cặp `provider + model` có API key và Base URL riêng. DeepL tự chọn endpoint Free/Pro theo API key; OpenAI-compatible cần Base URL như `http://127.0.0.1:11434/v1`.

## Web robustness

- Nhận diện `img`, `picture`, `canvas`, CSS background và nội dung SPA/lazy-load; lọc logo, avatar và banner theo kích thước/ngữ cảnh reader.
- Capture ưu tiên byte ảnh gốc, sau đó fallback sang screenshot + crop khi gặp `blob:`, canvas tainted, CORS hoặc hotlink protection.
- Ảnh dịch là lớp phủ, không thay đổi `src`/`srcset`; **Khôi phục** gỡ lớp phủ và trả lại ảnh gốc ngay.
- Cache IndexedDB tự khôi phục bản dịch khi chuyển chương, Back/Forward hoặc ảnh lazy-load xuất hiện lại.
- Hỗ trợ dịch từng ảnh/toàn trang, dừng hàng đợi, bật/tắt extension và dịch tự động.
- Popup lưu tối đa 20 lỗi gần nhất với stage, provider, HTTP status, request ID và gợi ý xử lý; API key không được ghi vào lịch sử lỗi.

## Pipeline engine

1. `comic-text-bubble-detector`
2. `comic-text-detector-seg`
3. `speech-bubble-segmentation`
4. `paddle-ocr-vl-1.6`
5. `yuzumarker-font-detection`
6. `llm`
7. `lama-manga`
8. `koharu-renderer`

Nếu máy đã có cache `C:\Users\PC\AppData\Local\Koharu` tương thích, engine tái sử dụng runtime/model ở đó nhưng không chạy ứng dụng hay service Koharu. Trên máy sạch, model OCR/inpainting được tải vào `.manga-translate\engine-data` trong lần dùng đầu. Tác vụ được xử lý tuần tự để tránh tranh chấp GPU và giữ ổn định bộ nhớ.

## Cấu hình

Sao chép các giá trị cần thiết từ `.env.example` vào môi trường chạy. Các biến chính:

- `ENGINE_EXE`: đường dẫn binary worker.
- `ENGINE_DATA_DIR`: runtime và model cache.
- `ENGINE_CPU=true`: ép pipeline dùng CPU.
- `ENGINE_START_TIMEOUT_MS`: thời gian chờ engine khởi tạo.
- `ENGINE_JOB_TIMEOUT_MS`: timeout một trang manga.
- `ENGINE_MODE=passthrough`: chế độ test không chạy model.

## Kiểm thử

```powershell
npm test
npm run check
npm run check:engine
```

GitHub Actions cũng build `manga-engine.exe` trên Windows và lưu nó dưới dạng workflow artifact.

## Giấy phép

Worker liên kết trực tiếp mã Koharu GPL-3.0-only, vì vậy dự án được phân phối theo GPL-3.0-only. Xem `LICENSE` và `THIRD_PARTY_NOTICES.md`. Torii chỉ được dùng để nghiên cứu hành vi nhận diện/trải nghiệm; dự án không sao chép backend, credit system hoặc mã độc quyền của Torii.
