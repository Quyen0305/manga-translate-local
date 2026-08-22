import { diagnosticHint, ERROR_LOG_KEY } from "../error-utils.js";
import {
  computeModeLabel,
  cudaStatusLabel,
  engineStateLabel,
  formatBytes,
  formatDuration,
  recoveryIssueLabel,
  recoveryStatusLabel,
  runtimeIssueLabel,
  runtimeStatusLabel,
} from "../diagnostics-utils.js";
import { migrateLegacyProfile, profileFor, profileKey, saveProfile } from "../profile-utils.js";

const DEFAULTS = {
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

const MODELS = {
  gemini: "gemini-3.5-flash-lite",
  openai: "gpt-4.1-mini",
  deepseek: "deepseek-v4-flash",
  claude: "claude-sonnet-4-20250514",
  deepl: "mt",
  "openai-compatible": "",
};

const fields = {
  extensionEnabled: document.querySelector("#extension-enabled"),
  provider: document.querySelector("#provider"),
  model: document.querySelector("#model"),
  apiKey: document.querySelector("#api-key"),
  baseUrl: document.querySelector("#base-url"),
  targetLanguage: document.querySelector("#target-language"),
  systemPrompt: document.querySelector("#system-prompt"),
  minWidth: document.querySelector("#min-width"),
  minHeight: document.querySelector("#min-height"),
  autoTranslate: document.querySelector("#auto-translate"),
  visualContextMode: document.querySelector("#visual-context-mode"),
};

let apiProfiles = {};
let providerModels = {};
let activeProfile = { provider: DEFAULTS.provider, model: DEFAULTS.model };
let modelChangeTimer;
let cleanupCandidates = [];
let queueState = { state: "idle" };

document.addEventListener("DOMContentLoaded", initialize);
document.querySelector("#save").addEventListener("click", save);
document.querySelector("#clear-page-cache").addEventListener("click", () => clearCache("page"));
document.querySelector("#clear-site-cache").addEventListener("click", () => clearCache("site"));
document.querySelector("#clear-cache").addEventListener("click", () => clearCache("all"));
document.querySelector("#prune-cache").addEventListener("click", pruneCache);
document.querySelector("#refresh-models").addEventListener("click", () => refreshModels());
document.querySelector("#check-api").addEventListener("click", checkApiConfiguration);
document.querySelector("#clear-errors").addEventListener("click", clearErrors);
document.querySelector("#refresh-diagnostics").addEventListener("click", updateDiagnostics);
document.querySelector("#cleanup-list").addEventListener("click", handleCleanupClick);
document.querySelector("#load-engine").addEventListener("click", () => runEngineAction("preload"));
document.querySelector("#unload-engine").addEventListener("click", () => runEngineAction("unload"));
document.querySelector("#restart-engine").addEventListener("click", () => runEngineAction("restart"));
document.querySelector("#retry-gpu").addEventListener("click", () => runEngineAction("retry-gpu"));
document.querySelector("#idle-timeout").addEventListener("change", saveEnginePolicy);
document.querySelector("#preload-engine").addEventListener("change", saveEnginePolicy);
fields.provider.addEventListener("change", () => {
  const provider = fields.provider.value;
  fields.model.value = providerModels[provider] || MODELS[provider];
  activeProfile = { provider, model: fields.model.value.trim() };
  loadActiveProfile();
  clearModelOptions();
  updateProviderUi();
  resetApiCheck();
});
fields.model.addEventListener("change", handleModelChange);
fields.model.addEventListener("input", () => {
  clearTimeout(modelChangeTimer);
  modelChangeTimer = setTimeout(handleModelChange, 180);
});
fields.apiKey.addEventListener("input", handleCredentialInput);
fields.baseUrl.addEventListener("input", handleCredentialInput);
fields.extensionEnabled.addEventListener("change", persistModeSwitches);
fields.autoTranslate.addEventListener("change", persistModeSwitches);
document.querySelector("#queue-popup-pause").addEventListener("click", () => {
  sendQueueCommand(queueState.state === "paused" ? "resume" : "pause");
});
document.querySelector("#queue-popup-start").addEventListener("click", () => sendQueueCommand("start"));
document.querySelector("#queue-popup-retry").addEventListener("click", () => sendQueueCommand("retry-failed"));
document.querySelector("#queue-popup-cancel").addEventListener("click", () => sendQueueCommand("cancel"));

async function initialize() {
  const settings = { ...DEFAULTS, ...(await chrome.storage.local.get(DEFAULTS)) };
  if (settings.provider === "gemini" && settings.model === "gemini-2.5-flash-lite") {
    settings.model = "gemini-3.5-flash-lite";
    await chrome.storage.local.set({ model: settings.model });
  }
  apiProfiles = migrateLegacyProfile(settings);
  providerModels = { ...(settings.providerModels || {}), [settings.provider]: settings.model };
  activeProfile = { provider: settings.provider, model: settings.model };
  for (const [key, field] of Object.entries(fields)) {
    if (field.type === "checkbox") field.checked = Boolean(settings[key]);
    else field.value = settings[key];
  }
  loadActiveProfile();
  updateProviderUi();
  await Promise.all([checkEngine(), updateDiagnostics(), updateCacheStats(), updateErrorLog(), updateQueueStatus()]);
  setInterval(updateEngineStatus, 2000);
  setInterval(updateQueueStatus, 800);
  if (settings.apiKey || (settings.provider === "openai-compatible" && settings.baseUrl)) {
    await refreshModels(true);
  }
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id ? tab : null;
}

async function updateQueueStatus() {
  try {
    const tab = await activeTab();
    if (!tab) throw new Error("Không có tab đang hoạt động");
    const next = await queueMessage(tab.id, { type: "GET_QUEUE_STATE" });
    queueState = next || { state: "idle" };
  } catch {
    queueState = { state: "unavailable", canPause: false, canCancel: false, canRetry: false };
  }
  renderQueueStatus(queueState);
}

async function sendQueueCommand(command) {
  try {
    const tab = await activeTab();
    if (!tab) return;
    const next = await queueMessage(tab.id, { type: "QUEUE_COMMAND", command });
    if (next) queueState = next;
    renderQueueStatus(queueState);
    setTimeout(updateQueueStatus, 120);
  } catch {
    await updateQueueStatus();
  }
}

async function queueMessage(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch {
    const injected = await chrome.runtime.sendMessage({ type: "ENSURE_CONTENT_SCRIPT", payload: { tabId } });
    if (!injected?.ok) throw new Error(injected?.error || "Không thể kích hoạt extension trên tab");
    return chrome.tabs.sendMessage(tabId, message);
  }
}

function renderQueueStatus(state) {
  const status = document.querySelector("#queue-popup-status");
  const start = document.querySelector("#queue-popup-start");
  const pause = document.querySelector("#queue-popup-pause");
  const retry = document.querySelector("#queue-popup-retry");
  const cancel = document.querySelector("#queue-popup-cancel");
  const processed = Number(state.processed || 0);
  const total = Number(state.total || 0);
  const stage = queueStageLabel(state.activeStage, state.activeStageState);
  const labels = {
    idle: state.detected ? `Đã nhận diện ${state.detected} ảnh` : "Chưa nhận diện ảnh manga",
    running: `${processed}/${total}${stage ? ` · ${stage}` : ""}`,
    paused: `${processed}/${total} · Đã tạm dừng`,
    cancelling: `${processed}/${total} · Đang dừng`,
    cancelled: `${processed}/${total} · Đã hủy`,
    completed: `${processed}/${total} · Hoàn tất${state.failed ? `, lỗi ${state.failed}` : ""}`,
    unavailable: "Tab này không hỗ trợ dịch",
  };
  status.textContent = labels[state.state] || "Chưa có tác vụ";
  status.title = status.textContent;
  start.disabled = !state.canStart;
  pause.disabled = !state.canPause;
  pause.textContent = state.state === "paused" ? "▶" : "Ⅱ";
  pause.title = state.state === "paused" ? "Tiếp tục hàng đợi" : "Tạm dừng hàng đợi";
  pause.setAttribute("aria-label", pause.title);
  retry.disabled = !state.canRetry;
  cancel.disabled = !state.canCancel;
}

function queueStageLabel(stage, stageState = "") {
  const stages = {
    preparing: "Chuẩn bị",
    "visual-context": "Ngữ cảnh ảnh",
    detection: "Nhận diện",
    ocr: "OCR",
    translation: "Dịch",
    inpainting: "Xóa chữ",
    rendering: "Dựng ảnh",
  };
  const label = stages[stage] || "";
  if (!label) return "";
  if (stageState === "loading") return `Nạp ${label.toLowerCase()}`;
  return label;
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[ERROR_LOG_KEY]) updateErrorLog();
});

async function refreshModels(silent = false) {
  const button = document.querySelector("#refresh-models");
  const status = document.querySelector("#model-status");
  const payload = {
    provider: fields.provider.value,
    apiKey: fields.apiKey.value.trim(),
    baseUrl: fields.baseUrl.value.trim().replace(/\/$/, ""),
  };
  if (payload.provider !== "openai-compatible" && !payload.apiKey) {
    if (!silent) showMessage("Hãy nhập API key trước khi tải model.", true);
    return;
  }
  if (payload.provider === "openai-compatible" && !payload.baseUrl) {
    if (!silent) showMessage("Hãy nhập Base URL trước khi tải model.", true);
    return;
  }

  button.disabled = true;
  button.textContent = "…";
  status.textContent = "Đang tải từ API…";
  try {
    const result = await chrome.runtime.sendMessage({ type: "LIST_MODELS", payload });
    if (!result?.ok) throw new Error(result?.error || "Không tải được danh sách model");
    setModelOptions(result.models);
    const ids = new Set(result.models.map((model) => model.id));
    if (!ids.has(fields.model.value)) {
      fields.model.value = recommendedModel(payload.provider, result.models);
      activeProfile = { provider: payload.provider, model: fields.model.value.trim() };
      stashActiveProfile();
      providerModels[payload.provider] = activeProfile.model;
    }
    status.textContent = payload.provider === "deepl" ? "DeepL API hợp lệ" : `${result.models.length} model từ API`;
    if (!silent) showMessage(payload.provider === "deepl" ? "DeepL API hợp lệ." : "Đã cập nhật danh sách model.");
  } catch (error) {
    status.textContent = "Không tải được danh sách";
    if (!silent) showMessage(error.message || "Không tải được danh sách model.", true);
  } finally {
    button.disabled = false;
    button.textContent = "↻";
  }
}

function setModelOptions(models) {
  const list = document.querySelector("#model-options");
  list.replaceChildren(...models.map((model) => {
    const option = document.createElement("option");
    option.value = model.id;
    option.label = model.name || model.id;
    return option;
  }));
}

function clearModelOptions() {
  document.querySelector("#model-options").replaceChildren();
  document.querySelector("#model-status").textContent = "";
}

function recommendedModel(provider, models) {
  const preferences = {
    gemini: [/gemini-3\.5-flash-lite$/i, /flash-lite/i, /flash/i],
    openai: [/gpt-5-mini$/i, /gpt-4\.1-mini$/i, /mini/i],
    deepseek: [/deepseek-v4-flash$/i, /flash/i],
    claude: [/sonnet/i, /haiku/i],
    deepl: [/^mt$/i],
    "openai-compatible": [],
  };
  for (const pattern of preferences[provider] ?? []) {
    const match = models.find((model) => pattern.test(model.id));
    if (match) return match.id;
  }
  return models[0]?.id || fields.model.value;
}

function updateProviderUi() {
  const provider = fields.provider.value;
  const isDeepL = provider === "deepl";
  const baseUrlRow = document.querySelector("#base-url-row");
  baseUrlRow.hidden = !isDeepL && provider !== "openai-compatible";
  document.querySelector("#base-url-label").textContent = isDeepL ? "Base URL (tùy chọn)" : "Base URL";
  document.querySelector("#base-url-status").textContent = isDeepL ? "Tự nhận Free/Pro theo API key" : "";
  fields.baseUrl.placeholder = isDeepL ? "https://api-free.deepl.com" : "http://127.0.0.1:11434/v1";
  fields.model.readOnly = isDeepL;
  document.querySelector("#system-prompt-row").hidden = isDeepL;
  document.querySelector("#refresh-models").title = isDeepL ? "Kiểm tra DeepL API" : "Tải danh sách model từ API";
  document.querySelector("#refresh-models").setAttribute("aria-label", isDeepL ? "Kiểm tra DeepL API" : "Tải danh sách model");
  if (isDeepL) {
    fields.model.value = "mt";
    document.querySelector("#model-status").textContent = "Machine Translation";
  }
}

function handleModelChange() {
  clearTimeout(modelChangeTimer);
  activeProfile = { provider: fields.provider.value, model: fields.model.value.trim() };
  providerModels[activeProfile.provider] = activeProfile.model;
  loadActiveProfile();
  updateProviderUi();
  resetApiCheck();
}

function handleCredentialInput() {
  stashActiveProfile();
  document.querySelector("#profile-status").textContent = "Bản nháp key của model này";
  resetApiCheck();
}

function stashActiveProfile() {
  if (!activeProfile.provider || !activeProfile.model) return;
  apiProfiles = saveProfile(apiProfiles, activeProfile.provider, activeProfile.model, {
    apiKey: fields.apiKey.value,
    baseUrl: fields.baseUrl.value,
  });
}

function loadActiveProfile() {
  const profile = profileFor(apiProfiles, activeProfile.provider, activeProfile.model);
  fields.apiKey.value = profile.apiKey;
  fields.baseUrl.value = profile.baseUrl;
  const exists = Boolean(apiProfiles[profileKey(activeProfile.provider, activeProfile.model)]);
  document.querySelector("#profile-status").textContent = exists
    ? "Đã nạp key riêng của model này"
    : "Chưa có key cho model này";
}

function resetApiCheck() {
  const button = document.querySelector("#check-api");
  button.dataset.state = "idle";
  button.textContent = "Kiểm tra API và model";
}

async function checkApiConfiguration() {
  const button = document.querySelector("#check-api");
  button.disabled = true;
  button.dataset.state = "idle";
  button.textContent = "Đang kiểm tra…";
  try {
    const models = await requestModels();
    const selectedModel = fields.provider.value === "deepl" ? "mt" : fields.model.value.trim();
    if (!models.some((model) => model.id === selectedModel)) {
      throw new Error(`API key hợp lệ nhưng không truy cập được model ${selectedModel}`);
    }
    button.dataset.state = "ok";
    button.textContent = "API và model hợp lệ";
    showMessage(`Đã kiểm tra ${fields.provider.value} / ${selectedModel}.`);
  } catch (error) {
    button.dataset.state = "error";
    button.textContent = "Kiểm tra thất bại";
    showMessage(error.message || "Không kiểm tra được API.", true);
  } finally {
    button.disabled = false;
  }
}

async function requestModels() {
  const payload = {
    provider: fields.provider.value,
    apiKey: fields.apiKey.value.trim(),
    baseUrl: fields.baseUrl.value.trim().replace(/\/$/, ""),
  };
  if (payload.provider !== "openai-compatible" && !payload.apiKey) throw new Error("Hãy nhập API key.");
  if (payload.provider === "openai-compatible" && !payload.baseUrl) throw new Error("Hãy nhập Base URL.");
  const result = await chrome.runtime.sendMessage({ type: "LIST_MODELS", payload });
  if (!result?.ok) throw new Error(result?.error || "Không tải được danh sách model");
  return result.models || [];
}

async function save() {
  stashActiveProfile();
  const settings = {
    extensionEnabled: fields.extensionEnabled.checked,
    provider: fields.provider.value,
    model: fields.provider.value === "deepl" ? "mt" : fields.model.value.trim(),
    apiKey: fields.apiKey.value.trim(),
    baseUrl: fields.baseUrl.value.trim().replace(/\/$/, ""),
    targetLanguage: fields.targetLanguage.value,
    systemPrompt: fields.systemPrompt.value.trim(),
    minWidth: Math.max(80, Number(fields.minWidth.value) || DEFAULTS.minWidth),
    minHeight: Math.max(80, Number(fields.minHeight.value) || DEFAULTS.minHeight),
    minArea: DEFAULTS.minArea,
    autoTranslate: fields.autoTranslate.checked,
    visualContextMode: fields.visualContextMode.value,
    apiProfiles,
    providerModels: { ...providerModels, [fields.provider.value]: fields.model.value.trim() },
  };
  if (!settings.model) return showMessage("Hãy nhập model.", true);
  if (settings.provider !== "openai-compatible" && !settings.apiKey) return showMessage("Hãy nhập API key.", true);
  if (settings.provider === "openai-compatible" && !settings.baseUrl) return showMessage("Hãy nhập Base URL.", true);
  await chrome.storage.local.set(settings);
  showMessage("Đã lưu cấu hình.");
}

async function persistModeSwitches() {
  await chrome.storage.local.set({
    extensionEnabled: fields.extensionEnabled.checked,
    autoTranslate: fields.autoTranslate.checked,
  });
  showMessage(fields.extensionEnabled.checked ? "Extension đang bật." : "Extension đã tắt.");
}

async function checkEngine() {
  const status = document.querySelector("#engine-status");
  const result = await chrome.runtime.sendMessage({ type: "CHECK_ENGINE" });
  status.dataset.state = result.ok ? "ready" : "offline";
  status.textContent = result.ok
    ? engineStateLabel({ state: result.data.engine })
    : "Chưa chạy";
  if (!result.ok) {
    await chrome.runtime.sendMessage({
      type: "REPORT_ERROR",
      payload: {
        operation: "CHECK_ENGINE",
        code: "SERVICE_UNAVAILABLE",
        message: result.error || "Local service chưa chạy",
      },
    });
  }
}

async function updateEngineStatus() {
  try {
    const result = await chrome.runtime.sendMessage({ type: "GET_ENGINE_STATUS" });
    if (!result?.ok) return;
    renderEngineLifecycle(result.data.engine || {});
    renderCleanupCandidates(cleanupCandidates, result.data.engine || {});
    const status = document.querySelector("#engine-status");
    status.dataset.state = "ready";
    status.textContent = engineStateLabel(result.data.engine || {});
  } catch {
    // The full diagnostics refresh reports actionable connection errors.
  }
}

async function updateDiagnostics() {
  const refresh = document.querySelector("#refresh-diagnostics");
  const summary = document.querySelector("#system-summary");
  refresh.disabled = true;
  refresh.textContent = "…";
  summary.textContent = "Đang kiểm tra";
  try {
    const result = await chrome.runtime.sendMessage({ type: "GET_DIAGNOSTICS" });
    if (!result?.ok) throw new Error(result?.error || "Không đọc được diagnostics");
    renderDiagnostics(result.data);
  } catch (error) {
    summary.textContent = "Không đọc được";
    document.querySelector("#cuda-message").textContent = error.message || "Không đọc được diagnostics.";
    document.querySelector("#runtime-message").textContent = "";
    document.querySelector("#recovery-message").textContent = "";
    cleanupCandidates = [];
    document.querySelector("#cleanup-list").replaceChildren();
    document.querySelector("#cleanup-empty").hidden = false;
  } finally {
    refresh.disabled = false;
    refresh.textContent = "↻";
  }
}

function renderDiagnostics(data) {
  const { engine = {}, service = {}, cuda = {}, storage = {} } = data || {};
  const mode = computeModeLabel(engine);
  document.querySelector("#system-summary").textContent = `${engineStateLabel(engine)} · ${formatBytes(storage.totalBytes)}`;
  document.querySelector("#compute-mode").textContent = engine.busy ? `${mode} · đang xử lý` : mode;
  renderEngineLifecycle(engine);
  document.querySelector("#service-recovery").textContent = service.status === "running"
    ? "Đang chạy"
    : service.status === "recovering" ? "Đang tự khởi động lại" : "Đã dừng";
  document.querySelector("#recovery-state").textContent = recoveryStatusLabel(engine, service);
  document.querySelector("#recovery-message").textContent = recoveryIssueLabel(engine, service);
  const cudaStatus = document.querySelector("#cuda-status");
  cudaStatus.dataset.state = cuda.status || "unavailable";
  cudaStatus.textContent = cudaStatusLabel(cuda);
  const runtime = storage.activeRuntime || {};
  const runtimeHealth = document.querySelector("#runtime-health");
  runtimeHealth.dataset.state = runtime.status || "missing";
  runtimeHealth.textContent = runtimeStatusLabel(runtime);
  document.querySelector("#runtime-message").textContent = runtimeIssueLabel(runtime);
  document.querySelector("#active-runtime-size").textContent = formatBytes(runtime.bytes);
  document.querySelector("#legacy-size").textContent = formatBytes(storage.legacyBytes);
  document.querySelector("#visual-context-cache-size").textContent = formatBytes(storage.visualContextCacheBytes);
  document.querySelector("#reclaimable-size").textContent = formatBytes(storage.reclaimableBytes);
  const other = Number(storage.projectsBytes || 0) + Number(storage.webviewBytes || 0) + Number(storage.otherBytes || 0);
  document.querySelector("#other-size").textContent = formatBytes(other);
  document.querySelector("#cuda-message").textContent = engine.fallbackReason || cuda.message || "";
  const dataDirectory = document.querySelector("#data-directory");
  dataDirectory.textContent = storage.dataDir || "";
  dataDirectory.title = storage.dataDir || "";
  renderCleanupCandidates(storage.cleanupCandidates || [], engine);
}

function renderCleanupCandidates(candidates, engine) {
  cleanupCandidates = candidates;
  const busy = engine.state === "busy" || engine.state === "loading";
  const list = document.querySelector("#cleanup-list");
  const rows = candidates.map((candidate) => {
    const row = document.createElement("div");
    row.className = "cleanup-row";
    const button = document.createElement("button");
    button.className = "secondary";
    button.type = "button";
    button.textContent = "Dọn";
    button.disabled = busy;
    button.dataset.target = candidate.target;
    button.dataset.label = candidate.label;
    button.dataset.confirm = String(Boolean(candidate.requiresConfirmation));
    row.append(
      textElement("span", "cleanup-label", candidate.label),
      textElement("span", "cleanup-size", formatBytes(candidate.bytes)),
      button,
    );
    return row;
  });
  list.replaceChildren(...rows);
  document.querySelector("#cleanup-empty").hidden = rows.length > 0;
}

function renderEngineLifecycle(engine) {
  const resources = engine.resources || {};
  document.querySelector("#lifecycle-state").textContent = engineStateLabel(engine);
  document.querySelector("#process-memory").textContent = formatBytes(resources.processMemoryBytes);
  const gpuMemory = resources.gpuMemoryUsedBytes == null
    ? "-"
    : resources.gpuMemoryBudgetBytes
      ? `${formatBytes(resources.gpuMemoryUsedBytes)} / ${formatBytes(resources.gpuMemoryBudgetBytes)}`
      : formatBytes(resources.gpuMemoryUsedBytes);
  document.querySelector("#gpu-memory").textContent = gpuMemory;
  document.querySelector("#idle-remaining").textContent = engine.state === "sleeping"
    ? "Đã giải phóng"
    : Number(engine.idleTimeoutSeconds) === 0
      ? "Đã tắt"
      : formatDuration(engine.idleSecondsRemaining);
  document.querySelector("#idle-timeout").value = String(engine.idleTimeoutSeconds ?? 900);
  document.querySelector("#preload-engine").checked = Boolean(engine.preloadOnStart);
  const busy = engine.state === "busy" || engine.state === "loading";
  document.querySelector("#load-engine").disabled = busy || Boolean(engine.loaded);
  document.querySelector("#unload-engine").disabled = busy || !engine.loaded;
  document.querySelector("#restart-engine").disabled = busy;
  document.querySelector("#retry-gpu").disabled = busy || !engine.recovery?.retryGpuAvailable;
}

async function runEngineAction(action) {
  const buttons = [...document.querySelectorAll(".engine-actions button")];
  buttons.forEach((button) => { button.disabled = true; });
  const labels = {
    preload: "Đang nạp engine…",
    unload: "Đang giải phóng engine…",
    restart: "Đang khởi động lại engine…",
    "retry-gpu": "Đang thử khôi phục GPU…",
  };
  showMessage(labels[action]);
  try {
    const result = await chrome.runtime.sendMessage({ type: "ENGINE_ACTION", payload: { action } });
    if (!result?.ok) throw new Error(result?.error || "Không điều khiển được engine");
    renderEngineLifecycle(result.data.engine || {});
    showMessage(action === "unload"
      ? "Engine đã được giải phóng."
      : action === "retry-gpu" ? "GPU đã được khôi phục." : "Engine đã sẵn sàng.");
    await checkEngine();
  } catch (error) {
    showMessage(error.message || "Không điều khiển được engine.", true);
  } finally {
    await updateEngineStatus();
  }
}

async function saveEnginePolicy() {
  const payload = {
    idleTimeoutSeconds: Number(document.querySelector("#idle-timeout").value),
    preloadOnStart: document.querySelector("#preload-engine").checked,
  };
  try {
    const result = await chrome.runtime.sendMessage({ type: "SET_ENGINE_POLICY", payload });
    if (!result?.ok) throw new Error(result?.error || "Không lưu được cấu hình engine");
    renderEngineLifecycle(result.data.engine || {});
    showMessage("Đã lưu cấu hình lifecycle engine.");
  } catch (error) {
    showMessage(error.message || "Không lưu được cấu hình engine.", true);
    await updateEngineStatus();
  }
}

function handleCleanupClick(event) {
  const button = event.target.closest("button[data-target]");
  if (!button) return;
  cleanStorage(button);
}

async function cleanStorage(button) {
  const target = button.dataset.target;
  const label = button.dataset.label || "dữ liệu đã chọn";
  if (button.dataset.confirm === "true" && !confirm(`Xóa ${label}? Thao tác này không thể hoàn tác.`)) return;
  button.disabled = true;
  button.textContent = "Đang dọn…";
  try {
    const result = await chrome.runtime.sendMessage({
      type: "CLEAN_STORAGE",
      payload: { target },
    });
    if (!result?.ok) throw new Error(result?.error || "Không dọn được cache tải xuống");
    showMessage(`Đã giải phóng ${formatBytes(result.data.freedBytes)}.`);
    await updateDiagnostics();
  } catch (error) {
    showMessage(error.message || "Không dọn được cache tải xuống.", true);
    await updateDiagnostics();
  }
}

async function clearCache(scope) {
  const labels = {
    page: "cache của trang/chapter hiện tại",
    site: "cache của website hiện tại",
    all: "toàn bộ cache bản dịch",
  };
  if (!confirm(`Xóa ${labels[scope]}? Thao tác này không thể hoàn tác.`)) return;
  try {
    const tab = await activeTab();
    const result = await chrome.runtime.sendMessage({
      type: "CLEAR_CACHE",
      payload: { scope, pageUrl: tab?.url || "" },
    });
    if (!result?.ok) throw new Error(result?.error || "Không xóa được cache");
    await updateCacheStats();
    const removed = result.data || {};
    showMessage(`Đã xóa ${Number(removed.count || 0)} bản dịch, giải phóng ${formatBytes(removed.bytes)}.`);
  } catch (error) {
    showMessage(error.message || "Không xóa được cache.", true);
  }
}

async function pruneCache() {
  const button = document.querySelector("#prune-cache");
  button.disabled = true;
  try {
    const result = await chrome.runtime.sendMessage({ type: "CACHE_PRUNE" });
    if (!result?.ok) throw new Error(result?.error || "Không dọn được cache cũ");
    await updateCacheStats();
    showMessage(`Đã dọn ${Number(result.data?.removedCount || 0)} bản dịch cũ, giải phóng ${formatBytes(result.data?.removedBytes)}.`);
  } catch (error) {
    showMessage(error.message || "Không dọn được cache cũ.", true);
  } finally {
    button.disabled = false;
  }
}

async function updateCacheStats() {
  try {
    const tab = await activeTab();
    const result = await chrome.runtime.sendMessage({
      type: "CACHE_STATS",
      payload: { pageUrl: tab?.url || "" },
    });
    if (!result?.ok) throw new Error(result?.error || "Không đọc được cache");
    renderCacheStats(result.data);
  } catch {
    document.querySelector("#cache-summary").textContent = "Không đọc được";
  }
}

function renderCacheStats(data) {
  const total = data?.total || {};
  const site = data?.site || {};
  const page = data?.page || {};
  const scope = data?.scope || {};
  const policy = data?.policy || {};
  const summaryLabel = `${Number(total.count || 0)} bản · ${formatBytes(total.bytes)}`;
  document.querySelector("#cache-summary").textContent = summaryLabel;
  document.querySelector("#cache-total").textContent = summaryLabel;
  document.querySelector("#cache-site").textContent = `${Number(site.count || 0)} · ${formatBytes(site.bytes)}`;
  document.querySelector("#cache-page").textContent = `${Number(page.count || 0)} · ${formatBytes(page.bytes)}`;
  document.querySelector("#cache-pipeline").textContent = policy.pipelineVersion || "-";
  const ageDays = Math.round(Number(policy.maxAgeMs || 0) / 86400000);
  document.querySelector("#cache-policy").textContent = `${ageDays} ngày · ${formatBytes(policy.maxBytes)} / ${Number(policy.maxEntries || 0)} bản`;
  const cacheScope = document.querySelector("#cache-scope");
  cacheScope.textContent = scope.pageKey || scope.siteKey || "Tab hiện tại không có phạm vi web";
  cacheScope.title = cacheScope.textContent;
  document.querySelector("#clear-page-cache").disabled = !scope.pageKey || !page.count;
  document.querySelector("#clear-site-cache").disabled = !scope.siteKey || !site.count;
  document.querySelector("#clear-cache").disabled = !total.count;
}

async function updateErrorLog() {
  const result = await chrome.runtime.sendMessage({ type: "GET_ERROR_LOG" });
  const errors = result?.ok && Array.isArray(result.errors) ? result.errors : [];
  document.querySelector("#error-count").textContent = String(errors.length);
  document.querySelector("#error-empty").hidden = errors.length > 0;
  document.querySelector("#clear-errors").disabled = errors.length === 0;
  document.querySelector("#error-list").replaceChildren(...errors.map(renderError));
}

function renderError(error) {
  const entry = document.createElement("article");
  entry.className = "error-entry";

  const header = document.createElement("div");
  header.className = "error-entry-header";
  header.append(
    textElement("span", "error-code", error.code || "UNKNOWN"),
    textElement("time", "error-time", formatTime(error.timestamp)),
  );
  entry.append(header, textElement("p", "error-message", error.message || "Lỗi không xác định"));

  const metadata = [
    error.operation && `Bước: ${error.operation}`,
    error.provider && `API: ${error.provider}`,
    error.httpStatus && `HTTP: ${error.httpStatus}`,
    error.image && `Ảnh: ${error.image}`,
    error.pageUrl && `Trang: ${error.pageUrl}`,
    error.requestId && `Request ID: ${error.requestId}`,
  ].filter(Boolean);
  if (metadata.length) entry.append(textElement("p", "error-meta", metadata.join(" · ")));
  entry.append(textElement("p", "error-hint", diagnosticHint(error.code)));
  return entry;
}

function textElement(tag, className, value) {
  const element = document.createElement(tag);
  element.className = className;
  element.textContent = value;
  return element;
}

function formatTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("vi-VN", {
    hour: "2-digit",
    minute: "2-digit",
    day: "2-digit",
    month: "2-digit",
  }).format(date);
}

async function clearErrors() {
  await chrome.runtime.sendMessage({ type: "CLEAR_ERROR_LOG" });
  await updateErrorLog();
  showMessage("Đã xóa lịch sử lỗi.");
}

function showMessage(text, error = false) {
  const element = document.querySelector("#message");
  element.textContent = text;
  element.style.color = error ? "#a52f38" : "#147d64";
}
