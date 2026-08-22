# Manga Translate Local

[English README](README.en.md)

Chrome extension dịch manga trực tiếp trên trang web bằng một ứng dụng Windows hợp nhất được xây dựng từ mã nguồn Koharu `0.70.2`.

Từ phiên bản `0.8.0`, toàn bộ local HTTP API, model discovery, kiểm tra provider, hàng đợi dịch, pipeline Koharu, Native Messaging và biểu tượng khay hệ thống nằm trong một file. Phiên bản `0.10.0` chuyển engine sang pipeline scene-native của Koharu `0.70.2`; phiên bản `0.11.0` bổ sung quản lý vòng đời engine; phiên bản `0.12.0` bổ sung kiểm tra runtime và quản lý dữ liệu Koharu cũ; phiên bản `0.13.0` bổ sung Recovery cho GPU, DLL và local service; phiên bản `0.14.0` bổ sung Queue Manager; phiên bản `0.15.0` bổ sung cache nâng cao theo trang và website; phiên bản `0.15.1` bổ sung Visual Context local bằng MiniCPM-V 4.6; phiên bản `0.15.2` tăng trần sinh Visual Context lên 8192 token với cửa sổ 32768 token; phiên bản `0.15.3` liên kết Visual Context với panel, bóng thoại và segment OCR thật của Koharu; phiên bản `0.15.4` ổn định polling/context; phiên bản `0.16.0` bổ sung editor scene-native cho từng bong bóng:

```text
MangaTranslate.exe
```

Ứng dụng không cần Node.js, PowerShell tray, `koharu.exe` hoặc `manga-engine.exe` riêng khi sử dụng hằng ngày.

## Tính năng hiện tại

- Nhận diện ảnh manga từ `img`, `picture`, canvas, CSS background, lazy-load và trang SPA.
- Lọc logo, avatar và banner theo kích thước/ngữ cảnh reader.
- Capture byte ảnh gốc; fallback sang screenshot và crop khi gặp `blob:`, canvas tainted, CORS hoặc hotlink protection.
- Hiển thị ảnh dịch bằng overlay, không thay đổi `src`/`srcset` và có thể khôi phục ảnh gốc tức thì.
- Cache bản dịch bằng IndexedDB, có phiên bản pipeline, metadata website/chapter/provider/model và tự phục hồi khi reload hoặc dùng Back/Forward.
- Hiển thị dung lượng cache thật; có thể xóa theo trang/chapter, website hoặc toàn bộ và tự dọn bằng LRU sau 90 ngày hoặc khi vượt 1 GiB/1.000 bản.
- Dịch từng ảnh, dịch toàn trang, bật/tắt extension và dịch tự động.
- Queue Manager ưu tiên ảnh trong viewport, xử lý tuần tự để ổn định VRAM, cho phép tạm dừng, tiếp tục và hủy.
- Hiển thị bước nhận diện, OCR, dịch, xóa chữ và dựng ảnh; có thể thử lại từng ảnh hoặc toàn bộ ảnh lỗi.
- Tùy chọn MiniCPM-V 4.6 local để hiểu toàn trang, suy luận nhân vật/người nói/cảm xúc và bổ sung ngữ cảnh cho API dịch mà không gửi ảnh ra Internet.
- Popup có thể bắt đầu **Dịch trang**, hiển thị số ảnh đã nhận diện và tự kích hoạt content script trên tab MangaDex đã mở trước khi extension được reload.
- Khi cuộn reader, queue sắp xếp lại các ảnh chưa xử lý theo viewport mới, giữ snapshot nguồn của ảnh bị MangaDex tạm tháo khỏi DOM và không bị hủy khi MangaDex cập nhật số trang trong URL.
- Nhấp nút xanh trên ảnh đã dịch để chọn từng vùng chữ, sửa câu, font, cỡ chữ, đậm/nghiêng, căn lề và khoảng cách dòng.
- Dịch lại hoặc đặt lại riêng một segment; render từ scene đã OCR/inpaint mà không chạy lại hai bước nặng này.
- Mỗi cặp provider/model có API key và Base URL riêng, kèm kiểm tra API và tải danh sách model.
- Lưu tối đa 20 lỗi gần nhất với bước lỗi, provider, HTTP status, request ID và gợi ý xử lý.
- Tự đánh thức ứng dụng Windows qua Chrome Native Messaging; không cần mở Koharu thủ công.
- Kiểm tra GPU/driver/CUDA, hiển thị dung lượng engine và tự fallback CPU cho lỗi tương thích CUDA.
- Theo dõi trạng thái `sleeping/loading/ready/busy`, RAM/VRAM và tự giải phóng model sau thời gian không hoạt động.
- Kiểm tra từng thành phần runtime `0.70.2`, phát hiện gói cài dở và tách riêng dung lượng active/legacy.
- Dọn cache, runtime hoặc model Koharu cũ theo whitelist; không xóa project hay runtime active.
- Tự fallback CPU khi CUDA lỗi, cho phép thử lại GPU và phân loại DLL thiếu/không tương thích.
- Watchdog tự khởi động lại local service sau lỗi ngoài ý muốn nhưng tôn trọng lệnh dừng thủ công.

## Kiến trúc

```text
Trang manga
  -> Chrome content script: nhận diện ảnh, queue ưu tiên viewport, overlay, khôi phục
  -> Chrome service worker: capture, cache, API profile
  -> Native Messaging: đánh thức MangaTranslate.exe
  -> HTTP 127.0.0.1:40721: truyền ảnh dung lượng lớn
  -> Koharu crates: detect -> OCR -> scene có panel/bóng thoại/segment
  -> MiniCPM-V tùy chọn: ảnh gốc + tọa độ scene/OCR -> ngữ cảnh JSON cục bộ
  -> Koharu crates: API dịch text + context -> inpaint -> render
```

Native Messaging chỉ truyền lệnh điều khiển nhỏ. Ảnh manga đi qua HTTP localhost để không vướng giới hạn 1 MiB của native host. Ảnh được xử lý trên máy; khi bật Visual Context, provider dịch chỉ nhận văn bản OCR cùng bản tóm tắt ngữ cảnh do MiniCPM-V tạo, không nhận byte ảnh nguồn.

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
- Ninja và LLVM/clang-cl để build shim Torch trên Windows.
- Node.js `20` trở lên chỉ để chạy test JavaScript.

Source Koharu mới được ghim trong `vendor/koharu-0.70.2`. Bản `0.61.2` cũ vẫn nằm trong `vendor/koharu` để rollback trong giai đoạn migration.

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

1. Sao chép `MangaTranslate.exe` và `koharu-torch.dll` vào `%LOCALAPPDATA%\MangaTranslate`.
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
4. Chọn ngôn ngữ đích và tùy chọn **Ngữ cảnh hình ảnh** rồi lưu cấu hình.
5. Bấm **Dịch trang**, nút trên từng ảnh hoặc bật **Dịch tự động**.

Thanh hàng đợi trên trang và popup cùng hiển thị số ảnh đã nhận diện, số ảnh đã xử lý và bước pipeline hiện tại. Nút **Dịch trang** bắt đầu hàng đợi, `Ⅱ` tạm dừng trước ảnh kế tiếp, `▶` tiếp tục, `■` hủy job đang chạy và `↻` thử lại ảnh lỗi. Hủy job dùng `StopToken` của Koharu nên engine dừng ở ranh giới pipeline an toàn thay vì kết thúc tiến trình đột ngột.

Sau khi dịch xong, nhấp nút xanh trên ảnh để mở **Chỉnh bong bóng**. Chọn vùng viền xanh rồi sửa văn bản hoặc typography; editor tự đồng bộ sau một khoảng debounce ngắn, còn **Đồng bộ ngay** dùng để ép render tức thì. Văn bản đã chỉnh luôn được render theo chiều ngang, kể cả khi OCR nguồn nhận diện chữ dọc. Menu **Kiểu chữ** nhóm các font manga/viết tay, dễ đọc, tiêu đề, cổ điển và đơn cách; **Font khác** nhận tên một font đã cài trong Windows. Các lượt render luôn chạy tuần tự và chỉ giữ thay đổi mới nhất để phản hồi cũ không ghi đè nội dung đang gõ. Editor tạm dừng phần hàng đợi còn lại, giữ form khi MangaDex virtualize ảnh và tự tái tạo scene từ ảnh nguồn nếu session trong RAM đã hết hạn; thao tác phục hồi này bỏ qua PNG cache và có thể chạy lại pipeline/API một lần. **Dịch lại** chỉ gọi provider cho segment đang chọn và giữ Visual Context của trang; **Về bản API** phục hồi câu cùng kiểu chữ ban đầu; **Ảnh gốc** bỏ overlay. Engine giữ tối đa 12 edit session gần nhất trong RAM và xóa chúng khi engine unload. PNG đã chỉnh vẫn nằm trong cache Chrome; khi session mất, ảnh nguồn phải còn truy cập được để editor tự phục hồi.

Phím tắt mặc định:

- `Alt+Shift+T`: dịch trang.
- `Alt+Shift+R`: khôi phục ảnh gốc.

Menu chuột phải của biểu tượng tray gồm:

- Trạng thái service và engine.
- RAM/VRAM hiện tại của tiến trình.
- Bật/tắt local service.
- Nạp, giải phóng hoặc khởi động lại engine mà không tắt tray.
- Thử lại GPU sau khi engine đã chuyển sang CPU fallback.
- Bật/tắt nạp sẵn lõi engine khi khởi động ứng dụng.
- Mở thư mục model/runtime đang được sử dụng.
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
- Chế độ Visual Context cũng thuộc cache key; bật MiniCPM-V không dùng nhầm bản dịch được tạo khi chế độ này đang tắt.

API key được lưu trong `chrome.storage.local` của extension. Key không được đưa vào DOM trang web, lịch sử lỗi, log engine hoặc project tạm; service worker chỉ gửi key tới local service khi thực hiện yêu cầu dịch.

Mỗi yêu cầu dịch có một UUID trong header `x-mt-job-id`. Extension đọc tiến độ qua `GET /api/v1/jobs/{jobId}` và hủy qua `POST /api/v1/jobs/{jobId}/cancel`. Job registry chỉ giữ metadata trạng thái của tối đa 128 job gần nhất, không giữ byte ảnh hoặc API key.

Ảnh dịch mới trả `x-mt-editor-session`. Extension đọc scene qua `GET /api/v1/editor/{sessionId}`, render chỉnh sửa qua `POST /render` và dịch lại một segment qua `POST /retranslate`. Edit session chỉ giữ scene, ảnh nguồn và lớp cleanup trong RAM engine; API key tiếp tục chỉ tồn tại trong request dịch lại.

## Cache bản dịch

Cache IndexedDB dùng schema v2. Khóa cache được tạo từ SHA-256 của byte ảnh nguồn cùng provider, model, Base URL, ngôn ngữ đích, system prompt và phiên bản pipeline `koharu-0.70.2-scene-v1`. API key không được lưu trong cache hoặc metadata.

Mỗi bản ghi lưu dung lượng byte, thời điểm tạo/truy cập gần nhất và phạm vi website/chapter. Với MangaDex, các URL `/chapter/<id>/1`, `/2` hoặc `/14` được xem là cùng một chapter, nên cuộn reader không chia nhỏ cache và Back/Forward vẫn phục hồi đúng bản dịch.

Popup **Cache bản dịch** hiển thị thống kê toàn bộ, website hiện tại và trang/chapter hiện tại. Có thể xóa riêng từng phạm vi hoặc toàn bộ. Maintenance tự động loại bản ghi có pipeline không tương thích, bản không được dùng trong 90 ngày và các bản ít dùng nhất khi cache vượt 1 GiB hoặc 1.000 bản.

Database v1 được nâng cấp tại chỗ. Bản ghi legacy vẫn được đọc bằng cache key cũ và được chuyển sang schema/key mới khi dùng lại; chúng chỉ bị xóa nếu quá hạn hoặc vượt giới hạn dung lượng.

## Pipeline Koharu

Mỗi ảnh dùng workflow scene-native mới:

1. `koharu-layout-rfdetr-seg-2xl`: nhận diện layout, vùng chữ và bong bóng.
2. `paddleocr-vl-1.6`: OCR.
3. Nếu bật **MiniCPM-V 4.6 · tiết kiệm**, model nhận ảnh gốc cùng tọa độ panel `P`, bóng thoại `B`, segment OCR `S` và văn bản OCR để tạo scene context JSON.
4. Context được kiểm tra: đủ đúng các segment, ID bóng thoại khớp scene, nhân vật không trùng ID, summary không chép OCR và evidence phải nêu dấu hiệu thị giác. Gợi ý chỉ lặp OCR bị hạ confidence xuống dưới ngưỡng sử dụng.
5. Provider API đã chọn dịch các segment bằng keyed output, kèm người nói, người nghe, cảm xúc và giọng điệu theo đúng ID nếu độ tin cậy từ `0.55` trở lên.
6. `lama`: xóa chữ nguồn.
7. `koharu-renderer` và `koharu-rasterizer`: dàn chữ và xuất PNG.

Visual Context dùng `openbmb/MiniCPM-V-4.6-gguf`, file `MiniCPM-V-4_6-Q4_K_M.gguf` và `mmproj-model-f16.gguf`. Model được tải tự động vào kho runtime ở lần dùng đầu tiên và chạy qua `llama.cpp` đã nhúng trong Koharu sau bước OCR. Kết quả context được cache theo SHA-256 của ảnh, bằng chứng OCR/scene và phiên bản schema trong `visual-context-cache`; cache này chỉ lưu JSON ngữ cảnh, không lưu ảnh nguồn. Khi OCR hoặc phân vùng thay đổi, cache cũ không còn khớp. Nếu tải, inference hoặc kiểm tra tính nhất quán thất bại, pipeline tiếp tục dịch thường và ghi `VISUAL_CONTEXT_FALLBACK` trong **Chi tiết lỗi**.

Engine chỉ khởi tạo ở yêu cầu dịch đầu tiên. `engine: "sleeping"` nghĩa là service đã sẵn sàng nhưng pipeline/model đã được giải phóng. Mặc định watchdog tự đưa engine về trạng thái này sau 15 phút không dịch; timeout và preload có thể đổi trong popup **Engine & dung lượng**.

## Dữ liệu và dung lượng

Ứng dụng cài và ghi log tại:

```text
%LOCALAPPDATA%\MangaTranslate
```

Thứ tự chọn thư mục model/runtime:

1. Tham số `--data-dir DIR`.
2. Biến môi trường `ENGINE_DATA_DIR`.
3. `%LOCALAPPDATA%\Koharu` nếu `runtime-v0.70.2` hoặc `runtime` cũ tồn tại.
4. `%LOCALAPPDATA%\MangaTranslate\data` trên máy sạch.

Có thể chuyển model sang ổ khác bằng `ENGINE_DATA_DIR` hoặc NTFS junction. Koharu `0.70.2` dùng kho riêng `runtime-v0.70.2` trong thư mục dữ liệu; bản cũ tiếp tục dùng `runtime`, nên hai engine không ghi đè lẫn nhau. Các archive tạm của CUDA, Torch và native runtime cũng được tạo trong thư mục staging thuộc kho này, không dùng `%TEMP%` trên ổ C. Không xóa runtime hoặc model đang được pipeline sử dụng. Thư mục `runtime\.downloads` của engine cũ chỉ chứa gói cài đã tải và có thể xóa sau khi runtime hoạt động ổn định.

Cache JSON của Visual Context nằm trong `visual-context-cache` dưới thư mục dữ liệu. Popup hiển thị riêng dung lượng này và cho phép dọn mà không xóa model MiniCPM-V hoặc cache bản dịch của Chrome.

## Cấu hình nâng cao

Các biến môi trường được hỗ trợ:

| Biến | Mặc định | Tác dụng |
| --- | --- | --- |
| `SERVICE_PORT` | `40721` | Cổng HTTP localhost |
| `MAX_IMAGE_BYTES` | `41943040` | Dung lượng ảnh tối đa, tính theo byte |
| `ENGINE_DATA_DIR` | tự phát hiện | Thư mục model/runtime |
| `ENGINE_CPU` | `false` | Ép engine chạy CPU |
| `ENGINE_IDLE_TIMEOUT_SECONDS` | `900` | Số giây nhàn rỗi trước khi tự giải phóng; `0` để tắt |
| `ENGINE_PRELOAD` | `false` | Nạp sẵn lõi engine khi service khởi động |
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
  "engineSource": "koharu-0.70.2",
  "version": "0.16.0"
}
```

Log nằm tại `%LOCALAPPDATA%\MangaTranslate\logs\manga-translate.log`.

Popup **Engine & dung lượng** hiển thị lifecycle, RAM, VRAM, GPU, driver, CUDA runtime, chế độ GPU/CPU fallback, trạng thái Recovery, đường dẫn dữ liệu và sức khỏe runtime active. Policy lifecycle được lưu tại `%LOCALAPPDATA%\MangaTranslate\lifecycle.json`. Trình quản lý kho phân loại `runtime-v0.70.2` đang dùng, gói cài dở, runtime/model cũ và cache ứng dụng cũ. Những nhóm legacy cần xác nhận trước khi xóa; thư mục `projects`, cấu hình và runtime active không thuộc bất kỳ mục cleanup nào. Cleanup legacy cũng bị từ chối nếu Koharu desktop còn chạy. Các thao tác unload/restart, thử lại GPU và dọn dữ liệu bị từ chối khi engine đang xử lý hoặc nạp model.

Recovery ghi lại mã lỗi engine và hành động gần nhất trong diagnostics. Lỗi CUDA/PTX kích hoạt CPU fallback; sau khi cập nhật driver hoặc runtime, nút **Thử lại GPU** sẽ giải phóng engine CPU và khởi tạo lại GPU. Kiểm tra runtime xác nhận các DLL/model bắt buộc thay vì chỉ dựa vào dung lượng thư mục. Nếu HTTP service dừng ngoài ý muốn, tray thử khởi động lại tối đa ba lần cho một chuỗi lỗi; chọn **Stop Service** sẽ tắt watchdog cho đến khi người dùng hoặc Native Messaging bật service lại. Cache bản dịch nằm trong IndexedDB của extension nên không bị xóa khi unload, restart engine hoặc phục hồi service.

## Xử lý sự cố

### Chrome báo chưa cài native host

1. Xác nhận extension đang được load tại `chrome://extensions`.
2. Chạy lại `MangaTranslate.exe --install` hoặc bấm **Install Chrome Integration** trong tray.
3. Reload extension và mở lại trang manga.

### `CUDA_ERROR_UNSUPPORTED_PTX_VERSION`

CUDA runtime mà Koharu tải đang mới hơn khả năng của driver NVIDIA. Cập nhật driver để hỗ trợ runtime hiện tại hoặc dùng CPU fallback. Kiểm tra mức CUDA driver hỗ trợ bằng:

```powershell
nvidia-smi
```

Có thể dùng `--cpu` hoặc `ENGINE_CPU=true` để chạy tạm bằng CPU.

### Service chạy nhưng engine là `sleeping`

Đây không phải lỗi. Engine chỉ tải model khi bắt đầu dịch ảnh đầu tiên.

### Engine đang dùng CPU fallback

Mở **Engine & dung lượng** để xem mã lỗi gần nhất. Sau khi cập nhật driver hoặc sửa runtime, bấm **Thử lại GPU**. Nếu GPU vẫn lỗi, engine giữ CPU fallback và cache bản dịch hiện có không bị thay đổi.

### Đổi model nhưng vẫn thấy bản dịch cũ

Extension đã đưa provider, model, Base URL, ngôn ngữ đích, system prompt và phiên bản pipeline vào khóa cache. Nếu cấu hình không đổi nhưng muốn dịch lại, mở **Cache bản dịch** rồi xóa cache của trang/chapter hiện tại, website hoặc toàn bộ.

### Visual Context báo fallback

Bản dịch vẫn hoàn tất nhưng không có ngữ cảnh hình ảnh. Lần đầu dùng cần Internet để tải MiniCPM-V vào kho engine; kiểm tra dung lượng ổ dữ liệu, log và cho phép kết nối tới Hugging Face. Sau khi model đã tải đủ, những lần sau chạy hoàn toàn local. Context của trang đã phân tích được cache riêng nên đổi provider dịch không khiến model nhìn lại cùng một ảnh.

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

Rust lưu artifact biên dịch trong `engine\target`. Thư mục này không chứa model,
cache bản dịch hoặc dữ liệu người dùng và có thể phình lớn sau nhiều lần đổi
feature/build. Dọn toàn bộ artifact có thể tái tạo bằng:

```powershell
npm run clean:build
```

Lệnh dọn không ảnh hưởng bản đang chạy tại `%LOCALAPPDATA%\MangaTranslate`.

## Gỡ cài đặt

```powershell
& "$env:LOCALAPPDATA\MangaTranslate\MangaTranslate.exe" --uninstall
```

Lệnh này gỡ Native Messaging manifest và mục chạy cùng Windows. Dữ liệu model/cache không tự bị xóa để tránh phải tải lại khi cài lại.

## Giấy phép

Ứng dụng liên kết trực tiếp mã nguồn Koharu GPL-3.0-only nên dự án được phân phối theo GPL-3.0-only. Xem `LICENSE` và `THIRD_PARTY_NOTICES.md`.

Torii chỉ được dùng để nghiên cứu hành vi nhận diện và trải nghiệm người dùng; dự án không sao chép backend, credit system hoặc mã độc quyền của Torii.
