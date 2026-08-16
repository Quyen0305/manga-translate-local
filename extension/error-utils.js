export const ERROR_LOG_KEY = "errorLog";
export const MAX_ERROR_LOG_ENTRIES = 20;

export function createErrorRecord(input, now = Date.now()) {
  const message = cleanText(input.message, "Lỗi không xác định", 600);
  return {
    id: `${now}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: new Date(now).toISOString(),
    source: cleanText(input.source, "extension", 40),
    operation: cleanText(input.operation, "unknown", 80),
    code: cleanText(input.code, "UNKNOWN", 80),
    message,
    pageUrl: sanitizeUrl(input.pageUrl),
    image: cleanText(input.image, "", 160),
    provider: cleanText(input.provider, "", 50),
    httpStatus: Number.isInteger(input.httpStatus) ? input.httpStatus : null,
    requestId: cleanText(input.requestId, "", 100),
  };
}

export function mergeErrorLog(current, record, limit = MAX_ERROR_LOG_ENTRIES) {
  const entries = Array.isArray(current) ? current : [];
  const duplicate = entries[0]
    && entries[0].code === record.code
    && entries[0].message === record.message
    && entries[0].pageUrl === record.pageUrl
    && Date.parse(record.timestamp) - Date.parse(entries[0].timestamp) < 1500;
  return [record, ...(duplicate ? entries.slice(1) : entries)].slice(0, limit);
}

export function diagnosticHint(code) {
  const hints = {
    CAPTURE_REQUIRED: "Đưa toàn bộ ảnh vào vùng nhìn thấy hoặc thu nhỏ trang rồi thử lại.",
    EXTENSION_DISABLED: "Bật extension trong popup trước khi dịch.",
    ENGINE_ERROR: "Kiểm tra model OCR và log của MangaTranslate.exe trong thư mục LocalAppData.",
    KOHARU_ERROR: "Kiểm tra model OCR và log của MangaTranslate.exe trong thư mục LocalAppData.",
    PROVIDER_API_ERROR: "Kiểm tra API Authentication Key, quota và Base URL. Với DeepL, không dùng mật khẩu hoặc token ứng dụng.",
    TIMEOUT: "Tác vụ quá lâu; thử lại với một ảnh và kiểm tra trạng thái engine ở biểu tượng tray.",
    VALIDATION_ERROR: "Kiểm tra nhà cung cấp, model, ngôn ngữ và định dạng ảnh.",
    SERVICE_UNAVAILABLE: "Chạy MangaTranslate.exe --install, sau đó reload extension và thử lại.",
  };
  return hints[code] || "Thử lại; nếu lỗi lặp lại, dùng mã lỗi và request ID để kiểm tra log service.";
}

function cleanText(value, fallback, maxLength) {
  const text = String(value ?? "").trim();
  return (text || fallback).slice(0, maxLength);
}

function sanitizeUrl(value) {
  if (!value) return "";
  try {
    const url = new URL(String(value));
    if (!["http:", "https:"].includes(url.protocol)) return url.protocol;
    return `${url.origin}${url.pathname}`.slice(0, 500);
  } catch {
    return "";
  }
}
