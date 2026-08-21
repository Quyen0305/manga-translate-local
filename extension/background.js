import { cacheClear, cacheCount, cacheGet, cachePut } from "./cache.js";
import { calculateCaptureCrop } from "./capture-utils.js";
import { createErrorRecord, ERROR_LOG_KEY, mergeErrorLog } from "./error-utils.js";
import { migrateLegacyProfile } from "./profile-utils.js";

const SERVICE_URL = "http://127.0.0.1:40721";
const NATIVE_HOST = "com.manga_translate.local";
let nativeWakePromise = null;
const DEFAULT_SETTINGS = {
  extensionEnabled: true,
  provider: "gemini",
  model: "gemini-3.5-flash-lite",
  apiKey: "",
  baseUrl: "",
  targetLanguage: "vi",
  systemPrompt: "Dịch tự nhiên, giữ đúng sắc thái nhân vật và không thêm lời giải thích.",
  minWidth: 280,
  minHeight: 280,
  minArea: 120000,
  autoTranslate: false,
  restoreCacheOnLoad: true,
  apiProfiles: {},
  providerModels: {},
};

chrome.runtime.onInstalled.addListener(async () => {
  const current = await chrome.storage.local.get(Object.keys(DEFAULT_SETTINGS));
  const next = { ...DEFAULT_SETTINGS, ...current };
  if (next.provider === "gemini" && next.model === "gemini-2.5-flash-lite") {
    next.model = "gemini-3.5-flash-lite";
  }
  next.apiProfiles = migrateLegacyProfile(next);
  next.providerModels = { ...(next.providerModels || {}), [next.provider]: next.model };
  await chrome.storage.local.set(next);
  await updateActionState(next.extensionEnabled);
});

chrome.runtime.onStartup.addListener(refreshActionState);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.extensionEnabled) {
    updateActionState(changes.extensionEnabled.newValue);
  }
});
refreshActionState();
wakeServiceForEnabledExtension();

chrome.commands.onCommand.addListener(async (command) => {
  const { extensionEnabled } = await chrome.storage.local.get({ extensionEnabled: true });
  if (!extensionEnabled) return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  if (command === "translate-page") chrome.tabs.sendMessage(tab.id, { type: "TRANSLATE_PAGE" });
  if (command === "restore-page") chrome.tabs.sendMessage(tab.id, { type: "RESTORE_PAGE" });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender).then(sendResponse).catch(async (error) => {
    const diagnostic = await recordError({
      error,
      operation: message?.type,
      pageUrl: sender?.url || message?.payload?.pageUrl,
      image: message?.payload?.filename,
      source: "background",
    });
    sendResponse({
      ok: false,
      error: diagnostic.message,
      code: diagnostic.code,
      httpStatus: diagnostic.httpStatus,
      requestId: diagnostic.requestId,
      reported: true,
    });
  });
  return true;
});

async function handleMessage(message, sender) {
  switch (message.type) {
    case "TRANSLATE_IMAGE":
      return translateImage(message.payload, sender);
    case "LOOKUP_CACHED_IMAGE":
      return lookupCachedImage(message.payload, sender);
    case "CHECK_ENGINE":
      return checkEngine();
    case "GET_DIAGNOSTICS":
      return getDiagnostics();
    case "GET_ENGINE_STATUS":
      return getEngineStatus();
    case "ENGINE_ACTION":
      return engineAction(message.payload?.action);
    case "SET_ENGINE_POLICY":
      return setEnginePolicy(message.payload);
    case "CLEAN_STORAGE":
      return cleanStorage(message.payload);
    case "LIST_MODELS":
      return listModels(message.payload);
    case "CLEAR_CACHE":
      await cacheClear();
      return { ok: true, count: 0 };
    case "CACHE_COUNT":
      return { ok: true, count: await cacheCount() };
    case "GET_ERROR_LOG": {
      const stored = await chrome.storage.local.get({ [ERROR_LOG_KEY]: [] });
      return { ok: true, errors: stored[ERROR_LOG_KEY] };
    }
    case "CLEAR_ERROR_LOG":
      await chrome.storage.local.set({ [ERROR_LOG_KEY]: [] });
      return { ok: true };
    case "REPORT_ERROR":
      return { ok: true, error: await recordError({ ...message.payload, source: "content" }) };
    default:
      return { ok: false, error: "Lệnh không được hỗ trợ" };
  }
}

async function lookupCachedImage(payload, sender) {
  const settings = { ...DEFAULT_SETTINGS, ...(await chrome.storage.local.get(DEFAULT_SETTINGS)) };
  if (!settings.extensionEnabled) throw extensionDisabled();
  const source = await loadImage(payload, sender);
  if (source.contentType.includes("svg")) return { ok: true, hit: false };
  const cacheKey = await createCacheKey(source.bytes, settings);
  const cached = await cacheGet(cacheKey);
  if (!cached) return { ok: true, hit: false };
  return {
    ok: true,
    hit: true,
    dataUrl: bytesToDataUrl(cached.bytes, cached.contentType),
  };
}

async function listModels(payload) {
  const response = await serviceFetch("/api/v1/models", {
    method: "POST",
    headers: {
      "x-mt-provider": payload.provider || "",
      "x-mt-api-key": payload.apiKey || "",
      "x-mt-base-url": payload.baseUrl || "",
    },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw responseError(body, response.status, `Không tải được model (HTTP ${response.status})`);
  }
  const body = await response.json();
  return { ok: true, models: body.models ?? [] };
}

async function checkEngine() {
  try {
    const response = await serviceFetch("/health");
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return { ok: true, data: await response.json() };
  } catch (error) {
    return { ok: false, error: error.message || "MangaTranslate.exe chưa chạy" };
  }
}

async function getDiagnostics() {
  const response = await serviceFetch("/api/v1/diagnostics");
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw responseError(body, response.status, `Không đọc được diagnostics (HTTP ${response.status})`);
  }
  return { ok: true, data: await response.json() };
}

async function getEngineStatus() {
  const response = await serviceFetch("/api/v1/engine/status");
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw responseError(body, response.status, `Không đọc được trạng thái engine (HTTP ${response.status})`);
  }
  return { ok: true, data: await response.json() };
}

async function engineAction(action) {
  if (!["unload", "preload", "restart", "retry-gpu"].includes(action)) {
    throw new Error("Thao tác engine không hợp lệ");
  }
  const response = await serviceFetch(`/api/v1/engine/${action}`, { method: "POST" });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw responseError(body, response.status, `Không điều khiển được engine (HTTP ${response.status})`);
  }
  return { ok: true, data: await response.json() };
}

async function setEnginePolicy(payload) {
  const response = await serviceFetch("/api/v1/engine/policy", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      idleTimeoutSeconds: Number(payload?.idleTimeoutSeconds || 0),
      preloadOnStart: Boolean(payload?.preloadOnStart),
    }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw responseError(body, response.status, `Không lưu được lifecycle policy (HTTP ${response.status})`);
  }
  return { ok: true, data: await response.json() };
}

async function cleanStorage(payload) {
  const response = await serviceFetch("/api/v1/storage/cleanup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ target: payload?.target || "" }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw responseError(body, response.status, `Không dọn được dữ liệu (HTTP ${response.status})`);
  }
  return { ok: true, data: await response.json() };
}

async function translateImage(payload, sender) {
  const settings = { ...DEFAULT_SETTINGS, ...(await chrome.storage.local.get(DEFAULT_SETTINGS)) };
  if (!settings.extensionEnabled) throw extensionDisabled();
  const source = await loadImage(payload, sender);
  if (source.contentType.includes("svg")) throw new Error("MVP chưa hỗ trợ ảnh SVG");

  const cacheKey = await createCacheKey(source.bytes, settings);
  const cached = await cacheGet(cacheKey);
  if (cached) {
    return {
      ok: true,
      dataUrl: bytesToDataUrl(cached.bytes, cached.contentType),
      cached: true,
    };
  }

  const headers = {
    "content-type": source.contentType,
    "x-mt-provider": settings.provider,
    "x-mt-model": settings.model,
    "x-mt-api-key": settings.apiKey,
    "x-mt-base-url": settings.baseUrl,
    "x-mt-target-language": settings.targetLanguage,
    "x-mt-system-prompt": encodeURIComponent(settings.systemPrompt),
    "x-mt-filename": safeFilename(payload.filename || "manga-page.png"),
  };
  const response = await serviceFetch("/api/v1/translate-image", {
    method: "POST",
    headers,
    body: source.bytes,
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw responseError(body, response.status, `Local service trả về HTTP ${response.status}`);
  }

  const bytes = await response.arrayBuffer();
  const contentType = response.headers.get("content-type") || "image/png";
  await cachePut({ key: cacheKey, bytes, contentType });
  return { ok: true, dataUrl: bytesToDataUrl(bytes, contentType), cached: false };
}

async function serviceFetch(path, options = {}) {
  try {
    return await fetch(`${SERVICE_URL}${path}`, options);
  } catch (firstError) {
    await wakeNativeApplication();
    try {
      return await fetch(`${SERVICE_URL}${path}`, options);
    } catch (secondError) {
      throw secondError || firstError;
    }
  }
}

async function wakeNativeApplication() {
  if (!nativeWakePromise) {
    nativeWakePromise = chrome.runtime.sendNativeMessage(NATIVE_HOST, {
      action: "ensureRunning",
    }).then((response) => {
      if (!response?.ok || !response.serviceReady) {
        throw new Error(response?.error || "MangaTranslate.exe không khởi động được service");
      }
      return response;
    }).catch((error) => {
      throw new Error(`Chưa cài Manga Translate native host: ${error.message}`);
    }).finally(() => {
      nativeWakePromise = null;
    });
  }
  return nativeWakePromise;
}

async function wakeServiceForEnabledExtension() {
  const { extensionEnabled } = await chrome.storage.local.get({ extensionEnabled: true });
  if (extensionEnabled) wakeNativeApplication().catch(() => {});
}

async function loadImage(payload, sender) {
  if (payload.forceScreenshot) return captureVisibleRegion(payload.capture, sender);

  if (payload.source) {
    try {
      const response = await fetch(payload.source, {
        credentials: "include",
        referrer: payload.pageUrl,
        cache: "force-cache",
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const contentType = response.headers.get("content-type")?.split(";")[0]
        || guessContentType(payload.source);
      if (!contentType.startsWith("image/")) throw new Error(`Content-Type ${contentType}`);
      return { bytes: await response.arrayBuffer(), contentType, method: "direct" };
    } catch (error) {
      if (payload.capture?.fullyVisible) return captureVisibleRegion(payload.capture, sender);
      throw captureRequired(`Không tải trực tiếp được ảnh: ${error.message}`);
    }
  }

  if (payload.capture?.fullyVisible) return captureVisibleRegion(payload.capture, sender);
  throw captureRequired("Ảnh cần được đưa vào vùng nhìn thấy để chụp");
}

async function captureVisibleRegion(capture, sender) {
  if (!capture || !sender?.tab?.id || !sender.tab.active) {
    throw captureRequired("Tab phải đang hoạt động để chụp ảnh fallback");
  }
  const screenshot = await chrome.tabs.captureVisibleTab(sender.tab.windowId, { format: "png" });
  const response = await fetch(screenshot);
  const bitmap = await createImageBitmap(await response.blob());
  try {
    const crop = calculateCaptureCrop(capture, bitmap.width, bitmap.height);
    const canvas = new OffscreenCanvas(crop.sw, crop.sh);
    const context = canvas.getContext("2d", { alpha: false });
    context.drawImage(bitmap, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, crop.sw, crop.sh);
    const blob = await canvas.convertToBlob({ type: "image/png" });
    return { bytes: await blob.arrayBuffer(), contentType: "image/png", method: "screenshot" };
  } finally {
    bitmap.close();
  }
}

function captureRequired(message) {
  const error = new Error(message);
  error.code = "CAPTURE_REQUIRED";
  return error;
}

function extensionDisabled() {
  const error = new Error("Extension đang tắt");
  error.code = "EXTENSION_DISABLED";
  return error;
}

async function refreshActionState() {
  const { extensionEnabled } = await chrome.storage.local.get({ extensionEnabled: true });
  await updateActionState(extensionEnabled);
}

async function updateActionState(enabled) {
  await chrome.action.setBadgeBackgroundColor({ color: enabled ? "#147d64" : "#6f747d" });
  await chrome.action.setBadgeText({ text: enabled ? "" : "OFF" });
  await chrome.action.setTitle({
    title: enabled ? "Manga Translate Local" : "Manga Translate Local (đang tắt)",
  });
}

async function createCacheKey(bytes, settings) {
  const encoder = new TextEncoder();
  const fingerprint = JSON.stringify({
    provider: settings.provider,
    model: settings.model,
    baseUrl: settings.baseUrl,
    targetLanguage: settings.targetLanguage,
    systemPrompt: settings.systemPrompt,
  });
  const metadata = encoder.encode(fingerprint);
  const merged = new Uint8Array(bytes.byteLength + metadata.byteLength);
  merged.set(new Uint8Array(bytes), 0);
  merged.set(metadata, bytes.byteLength);
  const hash = await crypto.subtle.digest("SHA-256", merged);
  return [...new Uint8Array(hash)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function bytesToDataUrl(bytes, contentType) {
  const data = new Uint8Array(bytes);
  const chunkSize = 0x8000;
  let binary = "";
  for (let offset = 0; offset < data.length; offset += chunkSize) {
    binary += String.fromCharCode(...data.subarray(offset, offset + chunkSize));
  }
  return `data:${contentType};base64,${btoa(binary)}`;
}

function guessContentType(url) {
  const path = url.split(/[?#]/)[0].toLowerCase();
  if (path.endsWith(".webp")) return "image/webp";
  if (path.endsWith(".jpg") || path.endsWith(".jpeg")) return "image/jpeg";
  if (path.endsWith(".gif")) return "image/gif";
  return "image/png";
}

function safeFilename(value) {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-120) || "manga-page.png";
}

function friendlyError(error) {
  if (error instanceof TypeError && error.message.includes("fetch")) {
    return "Không kết nối được local service hoặc ảnh nguồn";
  }
  return error?.message || "Lỗi không xác định";
}

function responseError(body, status, fallback) {
  const error = new Error(body?.error?.message || fallback);
  error.code = body?.error?.code || `HTTP_${status}`;
  error.httpStatus = status;
  error.requestId = body?.error?.requestId || "";
  return error;
}

async function recordError(input) {
  const settings = await chrome.storage.local.get({ provider: "" });
  const error = input.error;
  const record = createErrorRecord({
    source: input.source,
    operation: input.operation,
    code: input.code || error?.code,
    message: input.message || friendlyError(error),
    pageUrl: input.pageUrl,
    image: input.image,
    provider: input.provider || settings.provider,
    httpStatus: input.httpStatus ?? error?.httpStatus,
    requestId: input.requestId || error?.requestId,
  });
  const stored = await chrome.storage.local.get({ [ERROR_LOG_KEY]: [] });
  await chrome.storage.local.set({
    [ERROR_LOG_KEY]: mergeErrorLog(stored[ERROR_LOG_KEY], record),
  });
  return record;
}
