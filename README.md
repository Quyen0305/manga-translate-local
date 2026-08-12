# Manga Translate Local - Phase 2 Web Robustness

Chrome extension nhận diện ảnh manga trên trang web, gửi ảnh vào Koharu chạy local và dùng API do người dùng tự cấu hình để dịch phần văn bản OCR. Ảnh gốc không được gửi tới nhà cung cấp dịch.

Mã MVP này không thu phí thuê bao. Nhà cung cấp API cloud vẫn có thể tính phí theo tài khoản của bạn; dùng Ollama/LM Studio qua `OpenAI-compatible` thì không có phí API. Dự án không sao chép backend độc quyền hoặc mã nguồn của Torii, mà tự triển khai lại lớp nhận diện ảnh và trải nghiệm trên trang.

## Kiến trúc

```text
Trang manga
  -> Content script: phát hiện img/canvas, nút dịch, khôi phục
  -> Service worker: tải ảnh, SHA-256 cache, giữ API key
  -> Local service :40721: queue và adapter
  -> Koharu headless :40722: detect -> OCR -> API dịch text -> inpaint -> render
  -> Ảnh PNG đã dịch quay lại đúng phần tử trên trang
```

Local service tự chạy `D:\koharu\koharu.exe --headless`; không cần mở giao diện Koharu. Vì API của Koharu dùng một `current project`, Phase 1 xử lý từng ảnh tuần tự để không làm lẫn dữ liệu.

## Chạy local service

Yêu cầu: Node.js 20 trở lên và Koharu tại `D:\koharu\koharu.exe`.

```powershell
cd D:\translate_manga
npm test
powershell -ExecutionPolicy Bypass -File .\scripts\start-service.ps1
```

Kiểm tra tại `http://127.0.0.1:40721/health`. Log nằm trong `.manga-translate`. Để service tự chạy khi đăng nhập Windows:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-startup.ps1
```

## Cài extension

1. Mở `chrome://extensions`.
2. Bật **Developer mode**.
3. Chọn **Load unpacked** và trỏ tới `D:\translate_manga\extension`.
4. Mở popup, bật **Bật extension**, nhập API key, bấm `↻`, chọn model API đang cấp rồi bấm **Lưu cấu hình**.
5. Bật **Dịch tự động** để dịch ảnh ngay khi trang/lazy-load phát hiện ảnh mới, hoặc dùng nút `文` và **Dịch trang** để chạy thủ công.

Gemini mặc định dùng `gemini-3.5-flash-lite`. Với Ollama, LM Studio hoặc API tương thích OpenAI, chọn `OpenAI-compatible`, điền Base URL dạng `http://127.0.0.1:11434/v1` và tên model.

Sau khi nhập API key, bấm nút `↻` bên cạnh Model. Extension gọi API `/models` của chính nhà cung cấp và chỉ đưa các model dịch văn bản tương thích vào danh sách. Model vẫn là ô nhập tự do để hỗ trợ server local không có endpoint liệt kê.

Với DeepL, chọn `DeepL` và nhập API key. Koharu dùng engine dịch máy `mt`; key Free có hậu tố `:fx` tự dùng `https://api-free.deepl.com`, key Pro tự dùng `https://api.deepl.com`. Base URL chỉ cần nhập khi dùng endpoint khu vực hoặc proxy riêng. Nút `↻` kiểm tra key qua `/v2/usage` trước khi lưu.

Nếu endpoint dự đoán trả `401/403` và Base URL đang để trống, service tự thử endpoint Free/Pro còn lại trước khi báo lỗi. DeepL yêu cầu **Authentication Key** trong mục API Keys của tài khoản có gói DeepL API; mật khẩu đăng nhập hoặc token của ứng dụng DeepL không dùng được.

Mỗi cặp `provider + model` có hồ sơ API key/Base URL riêng. Khi đổi model, popup tự nạp đúng hồ sơ đã lưu; model mới chưa cấu hình sẽ để trống key. Bấm **Kiểm tra API và model** để xác nhận key hợp lệ và model nằm trong danh sách được API cấp quyền trước khi lưu.

## Pipeline Koharu của MVP

1. `comic-text-bubble-detector`
2. `comic-text-detector-seg`
3. `speech-bubble-segmentation`
4. `paddle-ocr-vl-1.6`
5. `yuzumarker-font-detection`
6. `llm`
7. `lama-manga`
8. `koharu-renderer`

Lần đầu chạy một model Koharu có thể mất thời gian vì engine cần tải model. Timeout mặc định là 15 phút và có thể đổi bằng biến môi trường trong `.env.example`.

## Nền tảng Phase 1

- Có: nhận diện `img` và `canvas`, trang tải động/lazy-load, dịch từng ảnh/toàn trang, restore, cache IndexedDB, shortcut `Alt+Shift+T` và `Alt+Shift+R`.
- Ảnh dịch được đặt thành lớp phủ, không thay đổi `src`/`srcset` của trang; **Khôi phục** gỡ lớp phủ để trả lại ảnh gốc ngay lập tức.
- Khi chuyển chương hoặc dùng Back/Forward, extension tự tra cache và hiển thị lại bản dịch đã có mà không gọi API dịch lần nữa.
- Có: OpenAI, Gemini, DeepSeek, Claude, DeepL và OpenAI-compatible thông qua provider của Koharu.
- Chưa có: editor bong bóng thủ công, tiến độ chi tiết từng stage, dịch song song và đóng gói installer/native host.

## Phase 2: Web robustness

- Capture ưu tiên byte gốc; tự fallback sang screenshot + crop khi gặp `blob:`, canvas tainted, CORS hoặc hotlink protection.
- Nhận diện `img`, `picture`, `canvas`, CSS background và nội dung SPA/lazy-load.
- Detector chấm điểm kích thước, tỉ lệ, ngữ cảnh reader/chapter và loại logo/avatar/banner khỏi danh sách.
- Chỉ đọc cache khi ảnh tiến gần viewport, tránh tải cả chương dài cùng lúc.
- Hàng đợi toàn trang hiển thị tiến độ và có thể dừng sau ảnh đang xử lý.
- Công tắc tổng tắt toàn bộ detector/UI/overlay; chế độ tự dịch tự xử lý ảnh mới khi trang tải động hoặc chuyển chương.
- Popup lưu tối đa 20 lỗi gần nhất với mã lỗi, bước xử lý, provider, HTTP status, request ID và gợi ý khắc phục; URL được loại query/hash và API key không được ghi vào lịch sử.
- Screenshot fallback hiện crop vùng đang nhìn thấy; với ảnh được bảo vệ và lớn hơn viewport, hãy thu nhỏ trang để toàn bộ ảnh vừa màn hình rồi thử lại.
- Fixture kiểm thử nằm tại `test/fixtures/web-robustness.html`.

Thông tin thành phần bên thứ ba nằm trong `THIRD_PARTY_NOTICES.md`.

Chế độ kiểm thử không chạy model:

```powershell
$env:KOHARU_MODE="passthrough"
npm start
```
