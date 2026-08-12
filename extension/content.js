(() => {
  if (window.__mangaTranslateLocalLoaded) return;
  window.__mangaTranslateLocalLoaded = true;

  const targets = new Map();
  const elementIds = new WeakMap();
  const restoreSuppressions = new Set();
  const CACHE_SETTING_KEYS = new Set(["provider", "model", "baseUrl", "targetLanguage", "systemPrompt"]);
  let nextId = 1;
  let currentPageUrl = location.href;
  let layoutQueued = false;
  let scanTimer;
  let autoTranslateTimer;
  let queueRun = null;
  let settings = {
    extensionEnabled: true,
    minWidth: 280,
    minHeight: 280,
    minArea: 120000,
    autoTranslate: false,
    restoreCacheOnLoad: true,
  };

  const host = document.createElement("div");
  host.id = "manga-translate-local-root";
  host.hidden = true;
  document.documentElement.appendChild(host);
  const root = host.attachShadow({ mode: window.__MANGA_TRANSLATE_TEST__ ? "open" : "closed" });
  root.innerHTML = `
    <style>
      :host { all: initial; }
      :host([hidden]) { display: none !important; }
      #layer { position: fixed; inset: 0; z-index: 2147483646; pointer-events: none; font-family: Arial, sans-serif; }
      .translation { position: fixed; display: block; margin: 0; padding: 0; border: 0; pointer-events: none; object-fit: fill; }
      .target { position: fixed; width: 34px; height: 34px; border: 1px solid rgba(255,255,255,.65); border-radius: 6px; background: #17191d; color: #fff; box-shadow: 0 2px 10px rgba(0,0,0,.3); cursor: pointer; pointer-events: auto; font-size: 16px; font-weight: 700; }
      .target:hover { background: #262a31; }
      .target[data-state="loading"] { color: transparent; cursor: wait; }
      .target[data-state="loading"]::after { content: ""; position: absolute; width: 13px; height: 13px; inset: 0; margin: auto; border: 2px solid #8b919d; border-top-color: #fff; border-radius: 50%; animation: spin .7s linear infinite; }
      .target[data-state="done"] { background: #147d64; }
      .target[data-state="error"] { background: #b53a42; }
      #toolbar { position: fixed; right: 18px; bottom: 18px; display: flex; align-items: center; gap: 6px; min-height: 46px; padding: 6px; border: 1px solid #42464f; border-radius: 8px; background: #17191d; box-shadow: 0 4px 18px rgba(0,0,0,.32); pointer-events: auto; }
      #toolbar button { height: 34px; border: 0; border-radius: 5px; background: transparent; color: #f5f6f7; padding: 0 10px; cursor: pointer; font-size: 13px; font-weight: 600; white-space: nowrap; }
      #toolbar button:hover { background: #2b2e35; }
      #toolbar button:disabled { color: #7f858f; cursor: default; }
      #cancel { color: #ffb4b8; }
      #status { min-width: 28px; max-width: 90px; color: #aeb4bf; font-size: 12px; text-align: center; white-space: nowrap; }
      #toast { position: fixed; left: 50%; bottom: 72px; transform: translateX(-50%); max-width: min(560px, calc(100vw - 32px)); padding: 9px 12px; border-radius: 6px; background: #17191d; color: #fff; box-shadow: 0 4px 16px rgba(0,0,0,.35); font-size: 13px; opacity: 0; transition: opacity .18s; text-align: center; }
      #toast.show { opacity: 1; }
      [hidden] { display: none !important; }
      @keyframes spin { to { transform: rotate(360deg); } }
    </style>
    <div id="layer">
      <div id="translations"></div>
      <div id="buttons"></div>
      <div id="toolbar">
        <button id="translate-all" title="Dịch mọi trang manga được nhận diện">Dịch trang</button>
        <button id="restore-all" title="Khôi phục mọi ảnh gốc">Khôi phục</button>
        <button id="cancel" title="Dừng hàng đợi sau ảnh hiện tại" hidden>Hủy</button>
        <span id="status">0</span>
      </div>
      <div id="toast"></div>
    </div>`;

  const translations = root.querySelector("#translations");
  const buttons = root.querySelector("#buttons");
  const translateAllButton = root.querySelector("#translate-all");
  const cancelButton = root.querySelector("#cancel");
  const status = root.querySelector("#status");
  const toast = root.querySelector("#toast");

  translateAllButton.addEventListener("click", () => translatePage());
  root.querySelector("#restore-all").addEventListener("click", restorePage);
  cancelButton.addEventListener("click", cancelQueue);

  const resizeObserver = new ResizeObserver(queueLayout);
  const proximityObserver = new IntersectionObserver(handleProximity, { rootMargin: "1200px 300px" });
  const mutationObserver = new MutationObserver(() => {
    handleNavigation();
    scheduleScan();
  });
  mutationObserver.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["src", "srcset", "style", "class"],
  });

  window.addEventListener("scroll", queueLayout, { passive: true });
  window.addEventListener("resize", queueLayout, { passive: true });
  window.addEventListener("popstate", handleNavigation);
  window.addEventListener("hashchange", handleNavigation);
  document.addEventListener("load", scheduleScan, true);
  document.addEventListener("error", scheduleScan, true);

  chrome.runtime.onMessage.addListener((message) => {
    if (!settings.extensionEnabled) return;
    if (message.type === "TRANSLATE_PAGE") translatePage();
    if (message.type === "RESTORE_PAGE") restorePage();
  });

  chrome.storage.local.get(settings).then((stored) => {
    settings = { ...settings, ...stored };
    applyEnabledState();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    const wasEnabled = settings.extensionEnabled;
    let cacheSettingsChanged = false;
    for (const key of Object.keys(settings)) {
      if (changes[key]) settings[key] = changes[key].newValue;
    }
    for (const key of Object.keys(changes)) {
      if (CACHE_SETTING_KEYS.has(key)) cacheSettingsChanged = true;
    }
    if (settings.extensionEnabled !== wasEnabled) {
      applyEnabledState();
      return;
    }
    if (!settings.extensionEnabled) return;
    if (changes.autoTranslate && !settings.autoTranslate) cancelQueue();
    if (cacheSettingsChanged) resetTranslationsForSettings();
    scheduleScan();
  });

  function scheduleScan() {
    if (!settings.extensionEnabled) return;
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scan, 220);
  }

  function scan() {
    if (!settings.extensionEnabled) return;
    const seen = new Set();
    for (const element of candidateElements()) {
      if (!isCandidate(element)) continue;
      const id = targetId(element);
      seen.add(id);
      if (!targets.has(id)) addTarget(id, element);
      else refreshTargetSource(targets.get(id));
    }
    for (const [id, target] of targets) {
      if (!seen.has(id) || !target.element.isConnected) removeTarget(id);
    }
    updateIdleStatus();
    queueLayout();
    scheduleAutoTranslate();
  }

  function candidateElements() {
    return document.querySelectorAll("img, canvas, [role='img'], [style*='background-image']");
  }

  function isCandidate(element) {
    if (!(element instanceof Element) || host.contains(element)) return false;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
    if (rect.width < 80 || rect.height < 80) return false;

    const dimensions = intrinsicDimensions(element, rect);
    if (dimensions.width < settings.minWidth || dimensions.height < settings.minHeight) return false;
    if (dimensions.width * dimensions.height < settings.minArea) return false;
    if (element instanceof HTMLImageElement && /\.svg(?:$|[?#])/i.test(element.currentSrc || element.src)) return false;

    const semantic = semanticContext(element);
    let score = 1;
    if (dimensions.height >= 500) score += 1;
    if (dimensions.width * dimensions.height >= 350000) score += 1;
    if (Math.max(dimensions.width, dimensions.height) >= 900) score += 1;
    if (dimensions.height / Math.max(1, dimensions.width) >= 1.15) score += 1;
    if (/(manga|comic|chapter|reader|page|scan|webtoon)/i.test(semantic)) score += 3;
    if (/(avatar|logo|icon|emoji|sticker|advert|banner|thumbnail|profile|reaction|mascot)/i.test(semantic)) score -= 4;
    if (["fixed", "sticky"].includes(style.position)) score -= 2;
    return score >= 4;
  }

  function intrinsicDimensions(element, rect) {
    if (element instanceof HTMLImageElement) {
      return { width: Math.max(element.naturalWidth, rect.width), height: Math.max(element.naturalHeight, rect.height) };
    }
    if (element instanceof HTMLCanvasElement) {
      return { width: Math.max(element.width, rect.width), height: Math.max(element.height, rect.height) };
    }
    return { width: rect.width, height: rect.height };
  }

  function semanticContext(element) {
    let current = element;
    const values = [];
    for (let depth = 0; current && depth < 4; depth += 1, current = current.parentElement) {
      values.push(current.id, current.className, current.getAttribute("role"), current.getAttribute("aria-label"));
      if (current instanceof HTMLImageElement) values.push(current.alt);
    }
    return values.filter((value) => typeof value === "string").join(" ");
  }

  function targetId(element) {
    if (!elementIds.has(element)) elementIds.set(element, `mt-${nextId++}`);
    return elementIds.get(element);
  }

  function addTarget(id, element) {
    const button = document.createElement("button");
    button.className = "target";
    button.textContent = "文";
    button.title = "Dịch ảnh này";
    button.dataset.state = "idle";
    button.addEventListener("click", () => translateTarget(id));
    buttons.appendChild(button);

    const target = {
      id,
      element,
      button,
      state: "idle",
      overlay: null,
      cacheChecked: false,
      cachePending: false,
      nearViewport: false,
      sourceKey: "",
    };
    targets.set(id, target);
    target.sourceKey = sourceIdentity(target);
    resizeObserver.observe(element);
    proximityObserver.observe(element);
  }

  function removeTarget(id) {
    const target = targets.get(id);
    if (!target) return;
    resizeObserver.unobserve(target.element);
    proximityObserver.unobserve(target.element);
    target.overlay?.remove();
    target.button.remove();
    targets.delete(id);
  }

  function refreshTargetSource(target) {
    const nextSourceKey = sourceIdentity(target);
    if (nextSourceKey === target.sourceKey) return;
    restoreTarget(target, false);
    target.sourceKey = nextSourceKey;
    target.cacheChecked = false;
    target.cachePending = false;
    if (target.nearViewport) restoreCachedTarget(target.id);
  }

  function handleProximity(entries) {
    for (const entry of entries) {
      const id = elementIds.get(entry.target);
      const target = id ? targets.get(id) : null;
      if (!target) continue;
      target.nearViewport = entry.isIntersecting;
      if (entry.isIntersecting) restoreCachedTarget(id);
    }
  }

  function queueLayout() {
    if (layoutQueued) return;
    layoutQueued = true;
    requestAnimationFrame(() => {
      layoutQueued = false;
      for (const target of targets.values()) positionTarget(target);
    });
  }

  function positionTarget(target) {
    const rect = target.element.getBoundingClientRect();
    const visible = intersectsViewport(rect);
    target.button.hidden = !visible;
    positionOverlay(target, rect, visible);
    if (!visible) return;
    target.button.style.left = `${Math.max(4, Math.min(innerWidth - 38, rect.right - 38))}px`;
    target.button.style.top = `${Math.max(4, rect.top + 4)}px`;
    if (!target.cacheChecked && !target.cachePending) restoreCachedTarget(target.id);
  }

  function positionOverlay(target, rect, visible) {
    if (!target.overlay) return;
    target.overlay.hidden = !visible;
    if (!visible) return;
    target.overlay.style.left = `${rect.left}px`;
    target.overlay.style.top = `${rect.top}px`;
    target.overlay.style.width = `${rect.width}px`;
    target.overlay.style.height = `${rect.height}px`;
    target.overlay.style.borderRadius = getComputedStyle(target.element).borderRadius;
  }

  async function translateTarget(id) {
    const target = targets.get(id);
    if (!settings.extensionEnabled || !target || target.state === "loading") return false;
    const requestedSourceKey = sourceIdentity(target);
    setState(target, "loading");
    try {
      let payload = createPayload(target);
      let result = await chrome.runtime.sendMessage({ type: "TRANSLATE_IMAGE", payload });
      if (!result?.ok && result?.code === "CAPTURE_REQUIRED") {
        payload = await prepareScreenshotPayload(target);
        result = await chrome.runtime.sendMessage({ type: "TRANSLATE_IMAGE", payload });
      }
      if (!result?.ok) throw errorFromResult(result, "Không dịch được ảnh");
      if (!settings.extensionEnabled || targets.get(id) !== target || !target.element.isConnected) return false;
      if (requestedSourceKey !== sourceIdentity(target)) {
        setState(target, "idle");
        return false;
      }
      await applyTranslation(target, result.dataUrl);
      setState(target, "done");
      if (!queueRun) showToast(result.cached ? "Đã dùng bản dịch trong cache" : "Đã dịch xong ảnh");
      return true;
    } catch (error) {
      if (!settings.extensionEnabled || targets.get(id) !== target) return false;
      target.lastError = error.message || "Không dịch được ảnh";
      setState(target, "error");
      if (!error.reported) reportContentError(error, target);
      if (!queueRun) showToast(`${target.lastError} · Xem Chi tiết lỗi trong popup`);
      return false;
    }
  }

  async function restoreCachedTarget(id) {
    const target = targets.get(id);
    if (!settings.extensionEnabled || !target || target.cacheChecked || target.cachePending || !settings.restoreCacheOnLoad) return;
    if (restoreSuppressions.has(sourceIdentity(target))) {
      target.cacheChecked = true;
      return;
    }
    target.cachePending = true;
    const requestedSourceKey = target.sourceKey;
    try {
      const payload = createPayload(target);
      const result = await chrome.runtime.sendMessage({ type: "LOOKUP_CACHED_IMAGE", payload });
      if (!result?.ok && result?.code === "CAPTURE_REQUIRED") {
        target.cacheChecked = false;
        return;
      }
      target.cacheChecked = true;
      if (!result?.ok || !result.hit || target.state !== "idle" || !target.element.isConnected) return;
      if (target.sourceKey !== requestedSourceKey) return;
      await applyTranslation(target, result.dataUrl);
      setState(target, "done");
    } catch {
      target.cacheChecked = false;
    } finally {
      target.cachePending = false;
    }
  }

  function createPayload(target, forceScreenshot = false) {
    const element = target.element;
    let source = null;
    let filename = `${target.id}.png`;
    if (element instanceof HTMLCanvasElement) {
      if (!forceScreenshot) {
        try {
          source = element.toDataURL("image/png");
        } catch {
          source = null;
        }
      }
    } else if (element instanceof HTMLImageElement) {
      source = forceScreenshot ? null : element.currentSrc || element.src;
      if (source && !/^(data|blob):/i.test(source)) {
        filename = new URL(source, location.href).pathname.split("/").pop() || filename;
      }
    } else {
      source = forceScreenshot ? null : backgroundImageUrl(element);
      if (source && !/^(data|blob):/i.test(source)) {
        filename = new URL(source, location.href).pathname.split("/").pop() || filename;
      }
    }
    return {
      source,
      filename,
      pageUrl: location.href,
      forceScreenshot,
      capture: captureInfo(element),
    };
  }

  async function prepareScreenshotPayload(target) {
    let rect = target.element.getBoundingClientRect();
    if (!fullyVisible(rect)) {
      target.element.scrollIntoView({ behavior: "instant", block: "center", inline: "center" });
      await waitForStableLayout();
      rect = target.element.getBoundingClientRect();
    }
    if (!fullyVisible(rect)) {
      throw new Error("Ảnh bị chặn tải và lớn hơn viewport; hãy thu nhỏ trang rồi thử lại");
    }
    return createPayload(target, true);
  }

  function captureInfo(element) {
    const rect = element.getBoundingClientRect();
    return {
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      viewportWidth: innerWidth,
      viewportHeight: innerHeight,
      fullyVisible: fullyVisible(rect),
    };
  }

  function fullyVisible(rect) {
    return rect.width > 1 && rect.height > 1
      && rect.left >= 0 && rect.top >= 0
      && rect.right <= innerWidth && rect.bottom <= innerHeight;
  }

  function intersectsViewport(rect) {
    return rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth;
  }

  function waitForStableLayout() {
    return new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 180)));
  }

  async function applyTranslation(target, dataUrl) {
    if (!target.overlay) {
      target.overlay = document.createElement("img");
      target.overlay.className = "translation";
      target.overlay.alt = "";
      translations.appendChild(target.overlay);
    }
    target.overlay.src = dataUrl;
    await target.overlay.decode().catch(() => {});
    positionTarget(target);
  }

  function restoreTarget(target, suppress = true) {
    if (!target.overlay) return false;
    if (suppress) restoreSuppressions.add(sourceIdentity(target));
    target.overlay.remove();
    target.overlay = null;
    setState(target, "idle");
    return true;
  }

  function sourceIdentity(target) {
    const element = target.element;
    if (element instanceof HTMLImageElement) return element.currentSrc || element.src || target.id;
    if (element instanceof HTMLCanvasElement) return `canvas:${target.id}:${element.width}x${element.height}`;
    return backgroundImageUrl(element) || `background:${target.id}`;
  }

  function backgroundImageUrl(element) {
    const value = getComputedStyle(element).backgroundImage;
    const match = /^url\((['"]?)(.*?)\1\)$/.exec(value);
    return match?.[2] || null;
  }

  async function translatePage({ automatic = false } = {}) {
    if (!settings.extensionEnabled) return;
    if (queueRun) {
      if (!automatic) showToast("Hàng đợi đang chạy");
      return;
    }
    const pending = [...targets.values()]
      .filter((target) => automatic ? target.state === "idle" : !["done", "loading"].includes(target.state))
      .sort((a, b) => documentTop(a.element) - documentTop(b.element));
    if (!pending.length) {
      if (!automatic) showToast("Không có ảnh mới để dịch");
      return;
    }

    const run = { cancelled: false, completed: 0, failed: 0, total: pending.length };
    queueRun = run;
    setQueueUi(run);
    for (const target of pending) {
      if (run.cancelled) break;
      const ok = await translateTarget(target.id);
      if (ok) run.completed += 1;
      else run.failed += 1;
      setQueueUi(run);
    }
    const wasCancelled = run.cancelled;
    const message = wasCancelled
      ? `Đã dừng: ${run.completed}/${run.total} ảnh hoàn tất`
      : `Hoàn tất ${run.completed}/${run.total} ảnh${run.failed ? `, lỗi ${run.failed} · Xem Chi tiết lỗi trong popup` : ""}`;
    queueRun = null;
    setQueueUi(null);
    if (settings.extensionEnabled) showToast(message);
    scheduleAutoTranslate();
  }

  function cancelQueue() {
    if (!queueRun) return;
    queueRun.cancelled = true;
    cancelButton.disabled = true;
    status.textContent = "Đang dừng";
  }

  function setQueueUi(run) {
    translateAllButton.disabled = Boolean(run);
    cancelButton.hidden = !run;
    cancelButton.disabled = Boolean(run?.cancelled);
    if (run) status.textContent = `${run.completed + run.failed}/${run.total}`;
    else updateIdleStatus();
  }

  function updateIdleStatus() {
    if (!queueRun) status.textContent = String(targets.size);
  }

  function documentTop(element) {
    return element.getBoundingClientRect().top + scrollY;
  }

  function restorePage() {
    cancelQueue();
    let restored = 0;
    for (const target of targets.values()) restored += restoreTarget(target, true) ? 1 : 0;
    showToast(restored ? `Đã khôi phục ${restored} ảnh gốc` : "Không có ảnh đã dịch để khôi phục");
  }

  function handleNavigation() {
    if (location.href === currentPageUrl) return;
    currentPageUrl = location.href;
    restoreSuppressions.clear();
    cancelQueue();
    for (const target of targets.values()) {
      restoreTarget(target, false);
      target.cacheChecked = false;
      target.cachePending = false;
    }
    if (settings.extensionEnabled) scheduleScan();
  }

  function resetTranslationsForSettings() {
    restoreSuppressions.clear();
    for (const target of targets.values()) {
      restoreTarget(target, false);
      target.cacheChecked = false;
      target.cachePending = false;
      if (target.nearViewport) restoreCachedTarget(target.id);
    }
  }

  function scheduleAutoTranslate() {
    clearTimeout(autoTranslateTimer);
    if (!settings.extensionEnabled || !settings.autoTranslate || queueRun) return;
    if (![...targets.values()].some((target) => target.state === "idle")) return;
    autoTranslateTimer = setTimeout(() => {
      if (!queueRun && settings.extensionEnabled && settings.autoTranslate) {
        translatePage({ automatic: true });
      }
    }, 700);
  }

  function applyEnabledState() {
    clearTimeout(scanTimer);
    clearTimeout(autoTranslateTimer);
    host.hidden = !settings.extensionEnabled;
    if (!settings.extensionEnabled) {
      cancelQueue();
      restoreSuppressions.clear();
      for (const id of [...targets.keys()]) removeTarget(id);
      return;
    }
    scan();
  }

  function setState(target, state) {
    target.state = state;
    target.button.dataset.state = state;
    target.button.title = state === "done"
      ? "Ảnh đã dịch"
      : state === "error" ? `Dịch lại ảnh · ${target.lastError || "Xem Chi tiết lỗi trong popup"}` : "Dịch ảnh này";
  }

  function errorFromResult(result, fallback) {
    const error = new Error(result?.error || fallback);
    error.code = result?.code || "UNKNOWN";
    error.httpStatus = result?.httpStatus ?? null;
    error.requestId = result?.requestId || "";
    error.reported = Boolean(result?.reported);
    return error;
  }

  function reportContentError(error, target) {
    const payload = createPayload(target);
    chrome.runtime.sendMessage({
      type: "REPORT_ERROR",
      payload: {
        operation: "TRANSLATE_IMAGE",
        code: error.code || "CONTENT_ERROR",
        message: error.message,
        httpStatus: error.httpStatus,
        requestId: error.requestId,
        pageUrl: location.href,
        image: payload.filename,
      },
    }).catch(() => {});
  }

  let toastTimer;
  function showToast(message) {
    toast.textContent = message;
    toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("show"), 3200);
  }
})();
