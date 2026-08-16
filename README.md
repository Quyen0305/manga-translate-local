# Manga Translate Local

Chrome extension dịch manga trực tiếp trên trang web bằng một ứng dụng Windows hợp nhất được build từ mã nguồn Koharu `0.61.2`.

Từ phiên bản `0.8.0`, runtime không còn cần Node.js, PowerShell tray, `koharu.exe` hoặc `manga-engine.exe` riêng. Toàn bộ HTTP API, model discovery, DeepL validation, hàng đợi dịch, pipeline Koharu, Native Messaging và biểu tượng khay hệ thống nằm trong một file:

```text
MangaTranslate.exe
```

## Kiến trúc

```text
Trang manga
  -> Chrome content script: nhận diện ảnh, overlay, restore
  -> Chrome service worker: capture, cache, API profiles
  -> Native Messaging: đánh thức MangaTranslate.exe khi cần
  -> HTTP 127.0.0.1:40721: truyền ảnh dung lượng lớn
  -> Koharu crates: detect -> OCR -> API dịch text -> inpaint -> render
```

Native Messaging chỉ truyền lệnh điều khiển nhỏ. Ảnh manga đi qua HTTP localhost để không vướng giới hạn message 1 MiB từ native host về Chrome.

## Sử dụng hằng ngày

Sau khi cài đặt một lần, không cần mở terminal:

1. Chrome tự gọi native host khi extension cần dịch.
2. `MangaTranslate.exe` xuất hiện trong khay hệ thống cạnh đồng hồ.
3. Local service mở tại `http://127.0.0.1:40721`.
4. Engine Koharu/CUDA chỉ được nạp khi dịch trang đầu tiên.

Menu chuột phải của biểu tượng tray gồm:

- Trạng thái service và engine.
- Bật/tắt local service.
- Giải phóng và khởi tạo lại engine.
- Mở thư mục log.
- Bật/tắt chạy cùng Windows.
- Cài lại Chrome Native Messaging.
- Dừng toàn bộ ứng dụng.

## Build

Yêu cầu build trên Windows 10/11 x64:

- Rust 1.95 trở lên.
- Visual Studio 2022 C++ Build Tools.
- LLVM có `libclang.dll`.
- CUDA Toolkit nếu build bản GPU.

```powershell
cd D:\translate_manga
git submodule update --init --recursive
powershell -ExecutionPolicy Bypass -File .\scripts\build-engine.ps1 -Cuda
```

Binary được tạo tại:

```text
D:\translate_manga\engine\target\release\MangaTranslate.exe
```

## Cài ứng dụng

Chạy một lần sau khi build:

```powershell
D:\translate_manga\engine\target\release\MangaTranslate.exe --install
```

Lệnh này tự động:

1. Sao chép binary vào `%LOCALAPPDATA%\MangaTranslate\MangaTranslate.exe`.
2. Tạo native-host manifest.
3. Đăng ký `com.manga_translate.local` trong Registry của người dùng hiện tại.
4. Đăng ký chạy cùng Windows.
5. Mở tray và local service.

Không cần quyền Administrator. Gỡ đăng ký bằng:

```powershell
%LOCALAPPDATA%\MangaTranslate\MangaTranslate.exe --uninstall
```

## Cài extension

1. Mở `chrome://extensions`.
2. Bật **Developer mode**.
3. Chọn **Load unpacked** và trỏ tới `D:\translate_manga\extension`.
4. Bấm **Reload** nếu đã từng tải phiên bản cũ.
5. Chọn provider/model, nhập API key và bấm kiểm tra API.

Installer tự đọc các Chrome profile và đưa đúng ID của bản extension unpacked hiện tại vào allowlist Native Messaging. Vì vậy việc nâng cấp không đổi extension ID và không làm mất Chrome storage/API profiles. Sau khi load extension lần đầu, hãy chạy lại `MangaTranslate.exe --install` nếu Chrome báo chưa tìm thấy native host.

## API và model

Các provider được pipeline hỗ trợ gồm OpenAI, Gemini, Claude, DeepSeek, DeepL, Google Translate, Caiyun và OpenAI-compatible. Mỗi cặp `provider + model` giữ API key và Base URL riêng trong Chrome storage.

DeepL tự kiểm tra endpoint Free/Pro. OpenAI-compatible có thể dùng Ollama hoặc LM Studio với Base URL như `http://127.0.0.1:11434/v1`.

API key chỉ đi trong request và bộ nhớ tiến trình; không được ghi vào log hoặc project tạm.

## Pipeline Koharu

1. `comic-text-bubble-detector`
2. `comic-text-detector-seg`
3. `speech-bubble-segmentation`
4. `paddle-ocr-vl-1.6`
5. `yuzumarker-font-detection`
6. `llm`
7. `lama-manga`
8. `koharu-renderer`

Nếu `%LOCALAPPDATA%\Koharu\runtime` tồn tại, ứng dụng chỉ tái sử dụng cache model/runtime ở đó. Nếu không, dữ liệu được lưu tại `%LOCALAPPDATA%\MangaTranslate\data`. Koharu GUI và Koharu HTTP service không được chạy.

## Trạng thái và log

Kiểm tra service:

```powershell
Invoke-RestMethod http://127.0.0.1:40721/health
```

`engine: "sleeping"` nghĩa là service đã sẵn sàng nhưng model chưa được nạp. Log nằm tại `%LOCALAPPDATA%\MangaTranslate\logs\manga-translate.log`.

## Kiểm thử

```powershell
npm test
npm run check
powershell -ExecutionPolicy Bypass -File .\scripts\build-engine.ps1 -Check
cargo test --manifest-path .\engine\Cargo.toml
```

Node.js chỉ dùng để chạy unit test JavaScript của extension, không phải dependency runtime của ứng dụng.

## Giấy phép

Ứng dụng liên kết trực tiếp mã nguồn Koharu GPL-3.0-only nên dự án được phân phối theo GPL-3.0-only. Torii chỉ được dùng để nghiên cứu hành vi nhận diện/trải nghiệm; dự án không sao chép backend, credit system hoặc mã độc quyền của Torii.
