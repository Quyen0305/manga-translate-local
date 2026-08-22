import { cacheClear, cacheDelete, cacheGet, cachePrune, cachePut, cacheStats } from "./cache.js";
import {
  CACHE_MAX_AGE_MS,
  CACHE_MAX_BYTES,
  CACHE_MAX_ENTRIES,
  CACHE_PIPELINE_VERSION,
  cacheEntryMetadata,
  cacheFingerprint,
  cacheScopeForPage,
} from "./cache-metadata.js";
import { calculateCaptureCrop } from "./capture-utils.js";
import { createErrorRecord, ERROR_LOG_KEY, mergeErrorLog } from "./error-utils.js";
import { migrateLegacyProfile } from "./profile-utils.js";

const SERVICE_URL = "http://127.0.0.1:40721";
const NATIVE_HOST = "com.manga_translate.local";
const JOB_POLL_INTERVAL_MS = 250;
const CACHE_MAINTENANCE_INTERVAL_MS = 10 * 60 * 1000;
let nativeWakePromise = null;
let cacheMaintenancePromise = null;
let lastCacheMaintenanceAt = 0;
const cancelledJobs = new Set();
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
  visualContextMode: "off",
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
runCacheMaintenance().catch(() => {});

chrome.commands.onCommand.addListener(async (command) => {
  const { extensionEnabled } = await chrome.storage.local.get({ extensionEnabled: true });
  if (!extensionEnabled) return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  if (command === "translate-page") await sendContentMessage(tab.id, { type: "TRANSLATE_PAGE" });
  if (command === "restore-page") await sendContentMessage(tab.id, { type: "RESTORE_PAGE" });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender).then(sendResponse).catch(async (error) => {
    if (error?.code === "JOB_CANCELLED") {
      sendResponse({
        ok: false,
        error: error.message || "Tác vụ đã được hủy",
        code: "JOB_CANCELLED",
        httpStatus: error.httpStatus,
        requestId: error.requestId,
        reported: true,
      });
      return;
    }
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
    case "EDIT_TRANSLATION_SEGMENT":
      return editTranslationSegment(message.payload);
    case "REFRESH_EDITOR_SESSION":
      return refreshEditorSession(message.payload);
    case "CANCEL_TRANSLATION_JOB":
      return cancelTranslationJob(message.payload);
    case "ENSURE_CONTENT_SCRIPT":
      return ensureContentScript(message.payload?.tabId);
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
      return clearTranslationCache(message.payload);
    case "CACHE_STATS":
      return translationCacheStats(message.payload);
    case "CACHE_PRUNE":
      return { ok: true, data: await runCacheMaintenance({ force: true }) };
    case "CACHE_COUNT": {
      const stats = await cacheStats();
      return { ok: true, count: stats.total.count };
    }
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

async function ensureContentScript(tabId) {
  if (!Number.isInteger(tabId)) return { ok: false, error: "Tab không hợp lệ" };
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["queue-utils.js", "editor-utils.js", "content.js"],
    });
    await new Promise((resolve) => setTimeout(resolve, 250));
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message || "Không thể kích hoạt extension trên tab này" };
  }
}

async function sendContentMessage(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch {
    const injected = await ensureContentScript(tabId);
    if (!injected.ok) return injected;
    return chrome.tabs.sendMessage(tabId, message);
  }
}

async function lookupCachedImage(payload, sender) {
  const settings = { ...DEFAULT_SETTINGS, ...(await chrome.storage.local.get(DEFAULT_SETTINGS)) };
  if (!settings.extensionEnabled) throw extensionDisabled();
  const source = await loadImage(payload, sender);
  if (source.contentType.includes("svg")) return { ok: true, hit: false };
  const { cached } = await findCachedEntry(source.bytes, settings, payload?.pageUrl);
  if (!cached) return { ok: true, hit: false };
  return {
    ok: true,
    hit: true,
    dataUrl: bytesToDataUrl(cached.bytes, cached.contentType),
    cacheKey: cached.key,
    editorSessionId: cached.editorSessionId || "",
    editorScene: cached.editorScene || null,
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
  const jobId = payload.jobId || crypto.randomUUID();
  try {
    return await translateImageJob(payload, sender, jobId);
  } finally {
    cancelledJobs.delete(jobId);
  }
}

async function translateImageJob(payload, sender, jobId) {
  const settings = { ...DEFAULT_SETTINGS, ...(await chrome.storage.local.get(DEFAULT_SETTINGS)) };
  if (!settings.extensionEnabled) throw extensionDisabled();
  const source = await loadImage(payload, sender);
  if (source.contentType.includes("svg")) throw new Error("MVP chưa hỗ trợ ảnh SVG");
  if (cancelledJobs.has(jobId)) throw jobCancelled();

  const cacheLookup = await findCachedEntry(source.bytes, settings, payload?.pageUrl);
  const cached = payload?.bypassCache ? null : cacheLookup.cached;
  if (cancelledJobs.has(jobId)) throw jobCancelled();
  if (cached) {
    return {
      ok: true,
      dataUrl: bytesToDataUrl(cached.bytes, cached.contentType),
      cached: true,
      cacheKey: cached.key,
      editorSessionId: cached.editorSessionId || "",
      editorScene: cached.editorScene || null,
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
    "x-mt-job-id": jobId,
    "x-mt-visual-context-mode": settings.visualContextMode || "off",
  };
  let polling = true;
  const progressTask = relayJobProgress(jobId, sender, () => polling);
  let response;
  try {
    response = await serviceFetch("/api/v1/translate-image", {
      method: "POST",
      headers,
      body: source.bytes,
    });
  } finally {
    polling = false;
    await progressTask;
  }
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw responseError(body, response.status, `Local service trả về HTTP ${response.status}`);
  }
  const visualContextState = response.headers.get("x-mt-visual-context");
  if (visualContextState === "fallback") {
    const encodedMessage = response.headers.get("x-mt-visual-context-message") || "";
    const message = decodeURIComponent(encodedMessage || "MiniCPM-V không khả dụng; đã dịch không có ngữ cảnh ảnh.");
    await recordError({
      source: "engine",
      operation: "VISUAL_CONTEXT",
      code: "VISUAL_CONTEXT_FALLBACK",
      message,
      pageUrl: payload?.pageUrl,
      image: payload?.filename,
      provider: settings.provider,
    });
  }
  if (cancelledJobs.has(jobId)) throw jobCancelled();

  const bytes = await response.arrayBuffer();
  const contentType = response.headers.get("content-type") || "image/png";
  const editorSessionId = response.headers.get("x-mt-editor-session") || "";
  const editorScene = editorSessionId
    ? await fetchEditorScene(editorSessionId).catch(() => null)
    : null;
  await cachePut({
    key: cacheLookup.key,
    bytes,
    contentType,
    editorSessionId,
    editorScene,
    ...cacheLookup.metadata,
  });
  runCacheMaintenance().catch(() => {});
  return {
    ok: true,
    dataUrl: bytesToDataUrl(bytes, contentType),
    cached: false,
    jobId,
    cacheKey: cacheLookup.key,
    editorSessionId,
    editorScene,
  };
}

async function editTranslationSegment(payload) {
  const sessionId = String(payload?.sessionId || "");
  const segmentId = String(payload?.segmentId || "");
  const action = String(payload?.action || "render");
  if (!sessionId || !segmentId) throw new Error("Thiếu phiên hoặc segment cần chỉnh sửa");
  if (!["render", "retranslate", "reset"].includes(action)) throw new Error("Thao tác editor không hợp lệ");

  const settings = { ...DEFAULT_SETTINGS, ...(await chrome.storage.local.get(DEFAULT_SETTINGS)) };
  if (!settings.extensionEnabled) throw extensionDisabled();
  const path = action === "retranslate"
    ? `/api/v1/editor/${encodeURIComponent(sessionId)}/retranslate`
    : `/api/v1/editor/${encodeURIComponent(sessionId)}/render`;
  const headers = {
    "content-type": "application/json",
    ...(action === "retranslate" ? translationHeaders(settings) : {}),
  };
  const response = await serviceFetch(path, {
    method: "POST",
    headers,
    body: JSON.stringify({
      segmentId,
      text: action === "render" ? String(payload?.text ?? "") : undefined,
      style: action === "render" ? payload?.style : undefined,
      resetToApi: action === "reset",
    }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw responseError(body, response.status, `Không render lại được ảnh (HTTP ${response.status})`);
  }
  const bytes = await response.arrayBuffer();
  const contentType = response.headers.get("content-type") || "image/png";
  const editorScene = await fetchEditorScene(sessionId);
  const cacheKey = String(payload?.cacheKey || "");
  if (cacheKey) {
    const cached = await cacheGet(cacheKey);
    if (cached) {
      await cachePut({
        ...cached,
        bytes,
        contentType,
        byteLength: bytes.byteLength,
        editorSessionId: sessionId,
        editorScene,
      });
    }
  }
  return {
    ok: true,
    dataUrl: bytesToDataUrl(bytes, contentType),
    editorSessionId: sessionId,
    editorScene,
    cacheKey,
  };
}

async function refreshEditorSession(payload) {
  const sessionId = String(payload?.sessionId || "");
  if (!sessionId) throw new Error("Thiếu phiên chỉnh sửa");
  return {
    ok: true,
    editorSessionId: sessionId,
    editorScene: await fetchEditorScene(sessionId),
  };
}

async function fetchEditorScene(sessionId) {
  const response = await serviceFetch(`/api/v1/editor/${encodeURIComponent(sessionId)}`);
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw responseError(body, response.status, `Không đọc được editor scene (HTTP ${response.status})`);
  }
  return response.json();
}

function translationHeaders(settings) {
  return {
    "x-mt-provider": settings.provider,
    "x-mt-model": settings.model,
    "x-mt-api-key": settings.apiKey,
    "x-mt-base-url": settings.baseUrl,
    "x-mt-target-language": settings.targetLanguage,
    "x-mt-system-prompt": encodeURIComponent(settings.systemPrompt),
    "x-mt-visual-context-mode": settings.visualContextMode || "off",
  };
}

async function cancelTranslationJob(payload) {
  const jobId = String(payload?.jobId || "");
  if (!jobId) return { ok: false, error: "Không có tác vụ đang chạy" };
  cancelledJobs.add(jobId);
  const response = await serviceFetch(`/api/v1/jobs/${encodeURIComponent(jobId)}/cancel`, {
    method: "POST",
  });
  if (!response.ok) {
    if ([404, 409].includes(response.status)) return { ok: true, pending: true };
    const body = await response.json().catch(() => null);
    throw responseError(body, response.status, `Không hủy được tác vụ (HTTP ${response.status})`);
  }
  return { ok: true, data: await response.json() };
}

function jobCancelled() {
  const error = new Error("Tác vụ dịch đã được hủy");
  error.code = "JOB_CANCELLED";
  return error;
}

async function relayJobProgress(jobId, sender, isActive) {
  let lastSignature = "";
  await new Promise((resolve) => setTimeout(resolve, JOB_POLL_INTERVAL_MS));
  do {
    const progress = await fetchJobProgress(jobId);
    if (progress) {
      const signature = JSON.stringify(progress);
      if (signature !== lastSignature) {
        lastSignature = signature;
        await sendJobProgress(sender, jobId, progress);
      }
      if (["completed", "failed", "cancelled"].includes(progress.state)) return;
    }
    if (!isActive()) break;
    await new Promise((resolve) => setTimeout(resolve, JOB_POLL_INTERVAL_MS));
  } while (isActive());

  const finalProgress = await fetchJobProgress(jobId);
  if (finalProgress && JSON.stringify(finalProgress) !== lastSignature) {
    await sendJobProgress(sender, jobId, finalProgress);
  }
}

async function fetchJobProgress(jobId) {
  try {
    const response = await fetch(`${SERVICE_URL}/api/v1/jobs/${encodeURIComponent(jobId)}`, {
      cache: "no-store",
    });
    if (response.status === 204) return null;
    return response.ok ? response.json() : null;
  } catch {
    return null;
  }
}

async function sendJobProgress(sender, jobId, progress) {
  if (!sender?.tab?.id) return;
  const options = Number.isInteger(sender.frameId) ? { frameId: sender.frameId } : undefined;
  await chrome.tabs.sendMessage(sender.tab.id, {
    type: "TRANSLATION_PROGRESS",
    jobId,
    progress,
  }, options).catch(() => {});
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

async function findCachedEntry(bytes, settings, pageUrl) {
  const metadata = cacheEntryMetadata(pageUrl, settings);
  const key = await createCacheKey(bytes, settings);
  let cached = await cacheGet(key, metadata);
  if (cached) return { key, metadata, cached };

  if ((settings.visualContextMode || "off") !== "off") {
    return { key, metadata, cached: undefined };
  }
  const legacyKey = await createCacheKey(bytes, settings, { legacy: true });
  cached = await cacheGet(legacyKey, metadata);
  if (!cached) return { key, metadata, cached: undefined };

  await cachePut({ ...cached, ...metadata, key });
  await cacheDelete(legacyKey);
  return { key, metadata, cached: { ...cached, ...metadata, key } };
}

async function createCacheKey(bytes, settings, options) {
  const encoder = new TextEncoder();
  const fingerprint = JSON.stringify(cacheFingerprint(settings, options));
  const metadata = encoder.encode(fingerprint);
  const merged = new Uint8Array(bytes.byteLength + metadata.byteLength);
  merged.set(new Uint8Array(bytes), 0);
  merged.set(metadata, bytes.byteLength);
  const hash = await crypto.subtle.digest("SHA-256", merged);
  return [...new Uint8Array(hash)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

async function translationCacheStats(payload) {
  await runCacheMaintenance();
  const scope = cacheScopeForPage(payload?.pageUrl);
  const data = await cacheStats({
    ...scope,
    pipelineVersion: CACHE_PIPELINE_VERSION,
    maxAgeMs: CACHE_MAX_AGE_MS,
  });
  return {
    ok: true,
    data: {
      ...data,
      scope,
      policy: {
        pipelineVersion: CACHE_PIPELINE_VERSION,
        maxAgeMs: CACHE_MAX_AGE_MS,
        maxBytes: CACHE_MAX_BYTES,
        maxEntries: CACHE_MAX_ENTRIES,
      },
    },
  };
}

async function clearTranslationCache(payload) {
  const scope = ["page", "site", "all"].includes(payload?.scope) ? payload.scope : "all";
  const location = cacheScopeForPage(payload?.pageUrl);
  const data = await cacheClear({ scope, ...location });
  return { ok: true, data };
}

async function runCacheMaintenance({ force = false } = {}) {
  if (!force && lastCacheMaintenanceAt
    && Date.now() - lastCacheMaintenanceAt < CACHE_MAINTENANCE_INTERVAL_MS) {
    return { removedCount: 0, removedBytes: 0, skipped: true };
  }
  if (!cacheMaintenancePromise) {
    cacheMaintenancePromise = cachePrune({
      pipelineVersion: CACHE_PIPELINE_VERSION,
      maxAgeMs: CACHE_MAX_AGE_MS,
      maxBytes: CACHE_MAX_BYTES,
      maxEntries: CACHE_MAX_ENTRIES,
    }).then((result) => {
      lastCacheMaintenanceAt = Date.now();
      return result;
    }).finally(() => { cacheMaintenancePromise = null; });
  }
  return cacheMaintenancePromise;
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
