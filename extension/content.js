(() => {
  if (window.__mangaTranslateLocalLoaded) return;
  window.__mangaTranslateLocalLoaded = true;

  const targets = new Map();
  const queueUtils = globalThis.MangaQueueUtils;
  const editorUtils = globalThis.MangaEditorUtils;
  const elementIds = new WeakMap();
  const restoreSuppressions = new Set();
  const CACHE_SETTING_KEYS = new Set(["provider", "model", "baseUrl", "targetLanguage", "systemPrompt"]);
  let nextId = 1;
  let currentPageUrl = location.href;
  let currentReaderSession = queueUtils.readerSessionKey(location.href);
  let layoutQueued = false;
  let scanTimer;
  let autoTranslateTimer;
  let queueRun = null;
  let lastQueueRun = null;
  let extensionContextValid = true;
  let editorState = null;
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
      #editor-hotspots { position: fixed; inset: 0; pointer-events: none; }
      .editor-hotspot { position: fixed; min-width: 18px; min-height: 18px; border: 2px solid #36b99a; border-radius: 4px; background: rgba(20,125,100,.10); box-shadow: 0 0 0 1px rgba(255,255,255,.7) inset; cursor: pointer; pointer-events: auto; }
      .editor-hotspot:hover, .editor-hotspot[aria-pressed="true"] { border-color: #fff; background: rgba(20,125,100,.28); }
      .target { position: fixed; width: 34px; height: 34px; border: 1px solid rgba(255,255,255,.65); border-radius: 6px; background: #17191d; color: #fff; box-shadow: 0 2px 10px rgba(0,0,0,.3); cursor: pointer; pointer-events: auto; font-size: 16px; font-weight: 700; }
      .target:hover { background: #262a31; }
      .target[data-state="loading"] { color: transparent; cursor: wait; }
      .target[data-state="loading"]::after { content: ""; position: absolute; width: 13px; height: 13px; inset: 0; margin: auto; border: 2px solid #8b919d; border-top-color: #fff; border-radius: 50%; animation: spin .7s linear infinite; }
      .target[data-state="done"] { background: #147d64; }
      .target[data-state="error"] { background: #b53a42; }
      .target[data-state="cancelled"] { background: #676d77; }
      #queue-dock { position: fixed; right: 18px; bottom: 18px; width: min(320px, calc(100vw - 36px)); pointer-events: auto; }
      #queue-panel { max-height: min(360px, calc(100vh - 96px)); overflow: hidden; border: 1px solid #42464f; border-bottom: 0; border-radius: 7px 7px 0 0; background: #17191d; color: #f5f6f7; box-shadow: 0 4px 18px rgba(0,0,0,.32); }
      #queue-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 38px; padding: 0 10px; border-bottom: 1px solid #343840; font-size: 12px; font-weight: 700; }
      #queue-summary { color: #aeb4bf; font-size: 11px; font-weight: 400; }
      #queue-list { max-height: 264px; overflow-y: auto; }
      .queue-row { display: grid; grid-template-columns: 24px minmax(0, 1fr) 28px; align-items: center; gap: 7px; min-height: 38px; padding: 4px 7px 4px 10px; border-top: 1px solid #2c3036; }
      .queue-row:first-child { border-top: 0; }
      .queue-index { color: #858c96; font-size: 10px; }
      .queue-label { min-width: 0; overflow: hidden; color: #e4e7eb; font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
      .queue-label[data-state="done"] { color: #79d1b7; }
      .queue-label[data-state="error"] { color: #ff9da3; }
      .queue-label[data-state="cancelled"] { color: #aeb4bf; }
      .queue-retry { width: 28px; height: 28px; min-height: 28px !important; padding: 0 !important; font-size: 16px !important; }
      #toolbar { display: flex; align-items: center; justify-content: flex-end; gap: 6px; min-height: 46px; padding: 6px; border: 1px solid #42464f; border-radius: 8px; background: #17191d; box-shadow: 0 4px 18px rgba(0,0,0,.32); pointer-events: auto; }
      #queue-panel:not([hidden]) + #toolbar { border-radius: 0 0 8px 8px; }
      #toolbar button { height: 34px; border: 0; border-radius: 5px; background: transparent; color: #f5f6f7; padding: 0 10px; cursor: pointer; font-size: 13px; font-weight: 600; white-space: nowrap; }
      #toolbar button:hover { background: #2b2e35; }
      #toolbar button:disabled { color: #7f858f; cursor: default; }
      #pause, #cancel, #retry-failed { width: 34px; padding: 0 !important; font-size: 16px !important; }
      #cancel { color: #ffb4b8; }
      #status { min-width: 28px; max-width: 90px; color: #aeb4bf; font-size: 12px; text-align: center; white-space: nowrap; }
      #toast { position: fixed; left: 50%; bottom: 72px; transform: translateX(-50%); max-width: min(560px, calc(100vw - 32px)); padding: 9px 12px; border-radius: 6px; background: #17191d; color: #fff; box-shadow: 0 4px 16px rgba(0,0,0,.35); font-size: 13px; opacity: 0; transition: opacity .18s; text-align: center; }
      #toast.show { opacity: 1; }
      #editor-panel { position: fixed; left: 18px; bottom: 18px; width: min(360px, calc(100vw - 36px)); max-height: calc(100vh - 36px); overflow-y: auto; border: 1px solid #42464f; border-radius: 8px; background: #17191d; color: #f5f6f7; box-shadow: 0 4px 18px rgba(0,0,0,.38); pointer-events: auto; }
      #editor-heading { display: flex; align-items: center; justify-content: space-between; min-height: 42px; padding: 0 10px 0 12px; border-bottom: 1px solid #343840; }
      #editor-heading strong { font-size: 13px; }
      #editor-heading button { width: 32px; height: 32px; border: 0; border-radius: 5px; background: transparent; color: #d9dde3; cursor: pointer; font-size: 20px; }
      #editor-heading button:hover { background: #2b2e35; }
      #editor-form { display: grid; gap: 10px; padding: 12px; }
      #editor-form label { display: grid; gap: 5px; color: #aeb4bf; font-size: 11px; }
      #editor-source { max-height: 52px; margin: 0; overflow-y: auto; color: #d9dde3; font-size: 12px; line-height: 1.4; }
      #editor-form textarea, #editor-form input, #editor-form select { box-sizing: border-box; width: 100%; min-height: 34px; border: 1px solid #4a4f59; border-radius: 5px; background: #22252b; color: #fff; padding: 7px 8px; font: 12px Arial, sans-serif; }
      #editor-form textarea { min-height: 82px; resize: vertical; line-height: 1.35; }
      .editor-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 8px; }
      .editor-checks { display: flex; align-items: center; gap: 14px; min-height: 30px; }
      .editor-checks label { display: flex !important; grid-auto-flow: column; align-items: center; gap: 6px !important; color: #d9dde3 !important; }
      .editor-checks input { width: 16px !important; min-height: 16px !important; margin: 0; }
      #editor-actions { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 7px; }
      #editor-actions button { min-height: 34px; border: 1px solid #4a4f59; border-radius: 5px; background: #292d34; color: #fff; cursor: pointer; font-size: 12px; font-weight: 600; }
      #editor-actions button:hover { background: #343941; }
      #editor-actions button:disabled { color: #777e88; cursor: wait; }
      #editor-save { border-color: #147d64 !important; background: #147d64 !important; }
      #editor-original { color: #ffb4b8 !important; }
      #editor-message { min-height: 16px; margin: 0; color: #9ba2ad; font-size: 11px; }
      [hidden] { display: none !important; }
      @keyframes spin { to { transform: rotate(360deg); } }
    </style>
    <div id="layer">
      <div id="translations"></div>
      <div id="editor-hotspots"></div>
      <div id="buttons"></div>
      <div id="queue-dock">
        <div id="queue-panel" hidden>
          <div id="queue-heading"><span>Hàng đợi</span><span id="queue-summary">0/0</span></div>
          <div id="queue-list"></div>
        </div>
        <div id="toolbar">
          <button id="translate-all" title="Dịch mọi trang manga được nhận diện">Dịch trang</button>
          <button id="restore-all" title="Khôi phục mọi ảnh gốc">Khôi phục</button>
          <button id="pause" title="Tạm dừng hàng đợi" aria-label="Tạm dừng hàng đợi" hidden>Ⅱ</button>
          <button id="retry-failed" title="Thử lại các ảnh lỗi" aria-label="Thử lại các ảnh lỗi" hidden>↻</button>
          <button id="cancel" title="Hủy hàng đợi" aria-label="Hủy hàng đợi" hidden>■</button>
          <span id="status">0</span>
        </div>
      </div>
      <div id="editor-panel" hidden>
        <div id="editor-heading"><strong>Chỉnh bong bóng <span id="editor-segment"></span></strong><button id="editor-close" title="Đóng editor" aria-label="Đóng editor">×</button></div>
        <div id="editor-form">
          <label>Văn bản gốc<p id="editor-source"></p></label>
          <label>Bản dịch<textarea id="editor-text" maxlength="65536"></textarea></label>
          <label>Kiểu chữ<select id="editor-font">
            <option value="">Tự động</option>
            <optgroup label="Manga và viết tay"><option value="Comic Sans MS">Comic Sans MS</option><option value="Segoe Print">Segoe Print</option><option value="MV Boli">MV Boli</option></optgroup>
            <optgroup label="Dễ đọc"><option value="Arial">Arial</option><option value="Arial Narrow">Arial Narrow</option><option value="Segoe UI">Segoe UI</option><option value="Tahoma">Tahoma</option><option value="Verdana">Verdana</option><option value="Trebuchet MS">Trebuchet MS</option><option value="Calibri">Calibri</option></optgroup>
            <optgroup label="Tiêu đề"><option value="Impact">Impact</option><option value="Bahnschrift Condensed">Bahnschrift Condensed</option></optgroup>
            <optgroup label="Cổ điển"><option value="Georgia">Georgia</option><option value="Times New Roman">Times New Roman</option></optgroup>
            <optgroup label="Đơn cách"><option value="Consolas">Consolas</option></optgroup>
            <option value="__custom__">Font khác...</option>
          </select></label>
          <label id="editor-font-custom-label" hidden>Tên font khác<input id="editor-font-custom" maxlength="256" placeholder="Tên font đã cài trong Windows"></label>
          <div class="editor-grid">
            <label>Cỡ chữ<input id="editor-size" type="number" min="6" max="256" step="1"></label>
            <label>Khoảng cách dòng<input id="editor-line-height" type="number" min="0.8" max="3" step="0.05"></label>
          </div>
          <label>Căn lề<select id="editor-alignment"><option value="auto">Tự động</option><option value="start">Trái</option><option value="center">Giữa</option><option value="end">Phải</option><option value="justify">Đều</option></select></label>
          <div class="editor-checks"><label><input id="editor-auto-fit" type="checkbox">Tự co chữ</label><label><input id="editor-bold" type="checkbox">Đậm</label><label><input id="editor-italic" type="checkbox">Nghiêng</label></div>
          <div id="editor-actions"><button id="editor-save">Đồng bộ ngay</button><button id="editor-retranslate">Dịch lại</button><button id="editor-reset">Về bản API</button><button id="editor-original">Ảnh gốc</button></div>
          <p id="editor-message" role="status"></p>
        </div>
      </div>
      <div id="toast"></div>
    </div>`;

  const translations = root.querySelector("#translations");
  const editorHotspots = root.querySelector("#editor-hotspots");
  const buttons = root.querySelector("#buttons");
  const translateAllButton = root.querySelector("#translate-all");
  const pauseButton = root.querySelector("#pause");
  const retryFailedButton = root.querySelector("#retry-failed");
  const cancelButton = root.querySelector("#cancel");
  const status = root.querySelector("#status");
  const toast = root.querySelector("#toast");
  const queuePanel = root.querySelector("#queue-panel");
  const queueList = root.querySelector("#queue-list");
  const queueSummary = root.querySelector("#queue-summary");
  const editorPanel = root.querySelector("#editor-panel");
  const editorText = root.querySelector("#editor-text");
  const editorFont = root.querySelector("#editor-font");
  const editorFontCustom = root.querySelector("#editor-font-custom");
  const editorFontCustomLabel = root.querySelector("#editor-font-custom-label");
  const editorAutoFit = root.querySelector("#editor-auto-fit");
  const editorSize = root.querySelector("#editor-size");
  const editorMessage = root.querySelector("#editor-message");

  translateAllButton.addEventListener("click", () => translatePage());
  root.querySelector("#restore-all").addEventListener("click", restorePage);
  pauseButton.addEventListener("click", toggleQueuePause);
  retryFailedButton.addEventListener("click", retryFailedTargets);
  cancelButton.addEventListener("click", cancelQueue);
  queueList.addEventListener("click", handleQueueListClick);
  root.querySelector("#editor-close").addEventListener("click", closeEditor);
  root.querySelector("#editor-save").addEventListener("click", flushEditorSync);
  root.querySelector("#editor-retranslate").addEventListener("click", () => submitEditor("retranslate"));
  root.querySelector("#editor-reset").addEventListener("click", () => submitEditor("reset"));
  root.querySelector("#editor-original").addEventListener("click", restoreEditorTarget);
  editorText.addEventListener("input", () => scheduleEditorSync(320));
  editorFont.addEventListener("change", () => {
    updateEditorFontState();
    scheduleEditorSync(60);
  });
  editorFontCustom.addEventListener("input", () => scheduleEditorSync(320));
  editorSize.addEventListener("input", () => scheduleEditorSync(220));
  root.querySelector("#editor-line-height").addEventListener("input", () => scheduleEditorSync(220));
  root.querySelector("#editor-alignment").addEventListener("change", () => scheduleEditorSync(60));
  root.querySelector("#editor-bold").addEventListener("change", () => scheduleEditorSync(60));
  root.querySelector("#editor-italic").addEventListener("change", () => scheduleEditorSync(60));
  editorAutoFit.addEventListener("change", () => {
    updateEditorSizeState();
    scheduleEditorSync(60);
  });
  editorHotspots.addEventListener("click", handleEditorHotspotClick);

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

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === "GET_QUEUE_STATE") {
      sendResponse(publicQueueState());
      return;
    }
    if (message.type === "TRANSLATION_PROGRESS") {
      handleTranslationProgress(message);
      return;
    }
    if (!settings.extensionEnabled) return;
    if (message.type === "TRANSLATE_PAGE") {
      scan();
      translatePage();
    }
    if (message.type === "RESTORE_PAGE") restorePage();
    if (message.type === "QUEUE_COMMAND") {
      handleQueueCommand(message.command);
      sendResponse(publicQueueState());
    }
  });

  chrome.storage.local.get(settings).then((stored) => {
    settings = { ...settings, ...stored };
    applyEnabledState();
  }).catch((error) => {
    if (isExtensionContextInvalidated(error)) invalidateExtensionContext();
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
      const rebound = rebindEditorTarget(element);
      const id = rebound?.id || targetId(element);
      seen.add(id);
      if (rebound) {
        restorePendingTranslation(rebound);
      } else if (!targets.has(id)) addTarget(id, element);
      else {
        targets.get(id).detached = false;
        refreshTargetSource(targets.get(id));
        restorePendingTranslation(targets.get(id));
      }
    }
    for (const [id, target] of targets) {
      if (!seen.has(id) || !target.element.isConnected) {
        if (queueUtils.queueOwnsTarget(queueRun, id) || editorState?.targetId === id) {
          target.detached = true;
          target.button.hidden = true;
          if (target.overlay) target.overlay.hidden = true;
          if (editorState?.targetId === id) positionEditorHotspots(target, {}, false);
          continue;
        }
        removeTarget(id);
      }
    }
    renderQueueUi();
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
    if (queueUtils.isKnownReaderImage({
      pageUrl: location.href,
      sourceUrl: element instanceof HTMLImageElement ? element.currentSrc || element.src : "",
      tagName: element.tagName,
      width: dimensions.width,
      height: dimensions.height,
    })) score += 6;
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

  function rebindEditorTarget(element) {
    const target = editorState ? targets.get(editorState.targetId) : null;
    if (!target || target.element === element || target.element.isConnected || elementIds.has(element)) return null;
    if (elementSourceIdentity(element, "") !== target.sourceKey) return null;
    resizeObserver.unobserve(target.element);
    proximityObserver.unobserve(target.element);
    target.element = element;
    target.detached = false;
    elementIds.set(element, target.id);
    resizeObserver.observe(element);
    proximityObserver.observe(element);
    if (target.overlay) target.overlay.hidden = false;
    return target;
  }

  function addTarget(id, element) {
    const button = document.createElement("button");
    button.className = "target";
    button.textContent = "文";
    button.title = "Dịch ảnh này";
    button.dataset.state = "idle";
    button.addEventListener("click", () => {
      const target = targets.get(id);
      if (!target) return;
      if (target.state === "done") openEditor(target);
      else startQueue([target]);
    });
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
      jobId: "",
      stage: "",
      stageState: "",
      queuePosition: 0,
      detached: false,
      queuePayload: null,
      pendingDataUrl: "",
      pendingSourceKey: "",
      editorSessionId: "",
      editorScene: null,
      cacheKey: "",
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
    if (editorState?.targetId === id) closeEditor();
    target.overlay?.remove();
    target.button.remove();
    targets.delete(id);
    renderQueueUi();
  }

  function refreshTargetSource(target) {
    const nextSourceKey = sourceIdentity(target);
    if (nextSourceKey === target.sourceKey) return;
    restoreTarget(target, false);
    target.pendingDataUrl = "";
    target.pendingSourceKey = "";
    clearEditorMetadata(target);
    target.sourceKey = nextSourceKey;
    target.cacheChecked = false;
    target.cachePending = false;
    if (target.nearViewport) restoreCachedTarget(target.id);
  }

  function restorePendingTranslation(target) {
    if (!target.pendingDataUrl || target.overlay || target.state !== "done") return;
    if (target.pendingSourceKey !== sourceIdentity(target)) {
      target.pendingDataUrl = "";
      target.pendingSourceKey = "";
      setState(target, "idle");
      return;
    }
    const dataUrl = target.pendingDataUrl;
    const sourceKey = target.pendingSourceKey;
    target.pendingDataUrl = "";
    target.pendingSourceKey = "";
    applyTranslation(target, dataUrl).catch(() => {
      target.pendingDataUrl = dataUrl;
      target.pendingSourceKey = sourceKey;
    });
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
    if (target.detached || !target.element.isConnected) {
      target.button.hidden = true;
      if (target.overlay) target.overlay.hidden = true;
      if (editorState?.targetId === target.id) positionEditorHotspots(target, {}, false);
      return;
    }
    const rect = target.element.getBoundingClientRect();
    const visible = intersectsViewport(rect);
    target.button.hidden = !visible;
    positionOverlay(target, rect, visible);
    if (editorState?.targetId === target.id) positionEditorHotspots(target, rect, visible);
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
    target.jobId = crypto.randomUUID();
    target.stage = "preparing";
    target.stageState = "queued";
    setState(target, "loading");
    renderQueueUi();
    try {
      let payload = target.queuePayload ? { ...target.queuePayload } : createPayload(target);
      payload.jobId = target.jobId;
      let result = await chrome.runtime.sendMessage({ type: "TRANSLATE_IMAGE", payload });
      if (!result?.ok && result?.code === "CAPTURE_REQUIRED") {
        payload = await prepareScreenshotPayload(target);
        payload.jobId = target.jobId;
        result = await chrome.runtime.sendMessage({ type: "TRANSLATE_IMAGE", payload });
      }
      if (!result?.ok) throw errorFromResult(result, "Không dịch được ảnh");
      if (!settings.extensionEnabled || targets.get(id) !== target) return false;
      if (target.element.isConnected && !target.detached && requestedSourceKey !== sourceIdentity(target)) {
        setState(target, "idle");
        return true;
      }
      if (!target.element.isConnected || target.detached) {
        target.pendingDataUrl = result.dataUrl;
        target.pendingSourceKey = requestedSourceKey;
        applyEditorMetadata(target, result);
        target.stage = result.cached ? "cache" : "rendering";
        target.stageState = "finished";
        setState(target, "done");
        return true;
      }
      await applyTranslation(target, result.dataUrl);
      applyEditorMetadata(target, result);
      target.stage = result.cached ? "cache" : "rendering";
      target.stageState = "finished";
      setState(target, "done");
      if (!queueRun) showToast(result.cached ? "Đã dùng bản dịch trong cache" : "Đã dịch xong ảnh");
      return true;
    } catch (error) {
      if (isExtensionContextInvalidated(error)) {
        invalidateExtensionContext();
        return false;
      }
      if (!settings.extensionEnabled || targets.get(id) !== target) return false;
      if (error.code === "JOB_CANCELLED") {
        target.stageState = "cancelled";
        setState(target, "cancelled");
        return false;
      }
      target.lastError = error.message || "Không dịch được ảnh";
      target.stageState = "failed";
      setState(target, "error");
      if (!error.reported) reportContentError(error, target);
      if (!queueRun) showToast(`${target.lastError} · Xem Chi tiết lỗi trong popup`);
      return false;
    } finally {
      if (targets.get(id) === target) {
        target.jobId = "";
        target.queuePayload = null;
        if (extensionContextValid) renderQueueUi();
      }
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
      applyEditorMetadata(target, result);
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
    if (editorState?.targetId === target.id) closeEditor();
    setState(target, "idle");
    return true;
  }

  function applyEditorMetadata(target, result) {
    target.editorSessionId = String(result?.editorSessionId || "");
    target.editorScene = result?.editorScene && Array.isArray(result.editorScene.segments)
      ? result.editorScene : null;
    target.cacheKey = String(result?.cacheKey || target.cacheKey || "");
  }

  function clearEditorMetadata(target) {
    if (editorState?.targetId === target.id) closeEditor();
    target.editorSessionId = "";
    target.editorScene = null;
    target.cacheKey = "";
  }

  function openEditor(target) {
    if (!target.overlay || !target.editorSessionId || !target.editorScene?.segments?.length) {
      showToast("Bản cache này không còn scene chỉnh sửa; khôi phục ảnh gốc rồi dịch lại");
      return;
    }
    if (editorState) closeEditor();
    const pausedQueue = queueRun && !queueRun.paused ? queueRun : null;
    if (pausedQueue) toggleQueuePause(true);
    const state = {
      targetId: target.id,
      segmentId: target.editorScene.segments[0].id,
      busy: false,
      revision: 0,
      syncing: false,
      recoveryAttempts: 0,
      resumeQueue: pausedQueue,
    };
    state.syncQueue = editorUtils.createLatestTaskQueue(
      (snapshot) => renderEditorSnapshot(state, target, snapshot),
    );
    editorState = state;
    editorPanel.hidden = false;
    renderEditorHotspots(target);
    selectEditorSegment(state.segmentId);
    positionTarget(target);
    refreshOpenEditorSession(state, target);
  }

  function closeEditor() {
    const state = editorState;
    const target = state ? targets.get(state.targetId) : null;
    state?.syncQueue?.cancel();
    editorState = null;
    editorPanel.hidden = true;
    editorHotspots.replaceChildren();
    editorMessage.textContent = "";
    if (state?.resumeQueue === queueRun && queueRun?.paused) toggleQueuePause(false);
    if (target?.detached) scheduleScan();
  }

  async function refreshOpenEditorSession(state, target) {
    const sessionId = target.editorSessionId;
    try {
      const result = await chrome.runtime.sendMessage({
        type: "REFRESH_EDITOR_SESSION",
        payload: { sessionId, pageUrl: location.href },
      });
      if (!result?.ok) throw errorFromResult(result, "Không kiểm tra được phiên chỉnh sửa");
      if (editorState !== state || targets.get(target.id) !== target || target.editorSessionId !== sessionId) return;
      applyEditorMetadata(target, result);
      renderEditorHotspots(target);
      if (state.revision === 0 && state.syncQueue.isIdle()) selectEditorSegment(state.segmentId);
    } catch (error) {
      if (isExtensionContextInvalidated(error)) {
        invalidateExtensionContext();
        return;
      }
      if (editorState !== state || target.editorSessionId !== sessionId) return;
      if (error.code === "EDITOR_SESSION_EXPIRED") {
        editorMessage.textContent = "Phiên cũ đã hết hạn; thay đổi đầu tiên sẽ tự tái tạo scene";
        return;
      }
      editorMessage.textContent = error.message || "Không kiểm tra được phiên chỉnh sửa";
    }
  }

  function renderEditorHotspots(target) {
    if (!editorState || editorState.targetId !== target.id) return;
    const hotspots = target.editorScene.segments.map((segment) => {
      const button = document.createElement("button");
      button.className = "editor-hotspot";
      button.dataset.segmentId = segment.id;
      button.title = `${segment.id}: ${segment.text}`;
      button.setAttribute("aria-label", `Chỉnh ${segment.id}`);
      button.setAttribute("aria-pressed", String(segment.id === editorState.segmentId));
      return button;
    });
    editorHotspots.replaceChildren(...hotspots);
  }

  function positionEditorHotspots(target, imageRect, visible) {
    for (const button of editorHotspots.querySelectorAll(".editor-hotspot")) {
      button.hidden = !visible;
      if (!visible) continue;
      const segment = target.editorScene?.segments?.find((item) => item.id === button.dataset.segmentId);
      if (!segment) continue;
      const rect = editorUtils.segmentRect(
        segment,
        imageRect,
        target.editorScene.width,
        target.editorScene.height,
      );
      button.style.left = `${rect.left}px`;
      button.style.top = `${rect.top}px`;
      button.style.width = `${rect.width}px`;
      button.style.height = `${rect.height}px`;
    }
  }

  async function handleEditorHotspotClick(event) {
    const button = event.target.closest("button[data-segment-id]");
    if (!button || editorState?.busy) return;
    const state = editorState;
    if (!state.syncQueue.isIdle()) {
      editorMessage.textContent = "Đang hoàn tất thay đổi trước khi chuyển bong bóng";
      await state.syncQueue.drain();
      if (editorState !== state) return;
    }
    selectEditorSegment(button.dataset.segmentId);
  }

  function selectEditorSegment(segmentId) {
    const target = editorState ? targets.get(editorState.targetId) : null;
    const segment = target?.editorScene?.segments?.find((item) => item.id === segmentId);
    if (!segment) return;
    editorState.segmentId = segment.id;
    root.querySelector("#editor-segment").textContent = segment.id;
    root.querySelector("#editor-source").textContent = segment.sourceText || "";
    editorText.value = segment.text || "";
    const style = editorUtils.normalizeStyle(segment.style);
    const fontOption = [...editorFont.options].some((option) => option.value === style.fontFamily);
    editorFont.value = fontOption ? style.fontFamily : "__custom__";
    editorFontCustom.value = fontOption ? "" : style.fontFamily;
    updateEditorFontState();
    editorSize.value = String(style.fontSize || 24);
    editorAutoFit.checked = style.autoFit;
    root.querySelector("#editor-line-height").value = String(style.lineHeight);
    root.querySelector("#editor-alignment").value = style.alignment;
    root.querySelector("#editor-bold").checked = style.fontWeight >= 600;
    root.querySelector("#editor-italic").checked = style.italic;
    editorMessage.textContent = "";
    updateEditorSizeState();
    for (const button of editorHotspots.querySelectorAll(".editor-hotspot")) {
      button.setAttribute("aria-pressed", String(button.dataset.segmentId === segment.id));
    }
  }

  function editorStyleFromForm() {
    return editorUtils.normalizeStyle({
      fontFamily: editorFont.value === "__custom__" ? editorFontCustom.value : editorFont.value,
      fontSize: Number(editorSize.value),
      autoFit: editorAutoFit.checked,
      fontWeight: root.querySelector("#editor-bold").checked ? 700 : 400,
      italic: root.querySelector("#editor-italic").checked,
      alignment: root.querySelector("#editor-alignment").value,
      lineHeight: Number(root.querySelector("#editor-line-height").value),
    });
  }

  function updateEditorSizeState() {
    editorSize.disabled = editorAutoFit.checked || Boolean(editorState?.busy);
  }

  function updateEditorFontState() {
    const custom = editorFont.value === "__custom__";
    editorFontCustomLabel.hidden = !custom;
    editorFontCustom.disabled = !custom || Boolean(editorState?.busy);
  }

  function editorSnapshot(state) {
    return {
      revision: ++state.revision,
      segmentId: state.segmentId,
      text: editorText.value,
      style: editorStyleFromForm(),
    };
  }

  function scheduleEditorSync(delay = 280) {
    const state = editorState;
    if (!state || state.busy) return;
    state.syncQueue.schedule(editorSnapshot(state), delay);
    editorMessage.textContent = "Đang chờ đồng bộ";
  }

  async function flushEditorSync() {
    const state = editorState;
    if (!state || state.busy) return;
    state.syncQueue.schedule(editorSnapshot(state), 0);
    await state.syncQueue.drain();
  }

  async function renderEditorSnapshot(state, target, snapshot) {
    if (!editorState || editorState !== state || targets.get(target.id) !== target) return;
    state.syncing = true;
    editorMessage.textContent = "Đang đồng bộ";
    try {
      const result = await chrome.runtime.sendMessage({
        type: "EDIT_TRANSLATION_SEGMENT",
        payload: {
          action: "render",
          sessionId: target.editorSessionId,
          segmentId: snapshot.segmentId,
          text: snapshot.text,
          style: snapshot.style,
          cacheKey: target.cacheKey,
          pageUrl: location.href,
        },
      });
      if (!result?.ok) throw errorFromResult(result, "Không đồng bộ được bong bóng");
      if (!editorState || editorState !== state || targets.get(target.id) !== target) return;
      applyEditorMetadata(target, result);
      if (state.revision !== snapshot.revision || state.segmentId !== snapshot.segmentId) {
        editorMessage.textContent = "Đang chờ đồng bộ thay đổi mới";
        return;
      }
      await applyTranslation(target, result.dataUrl);
      renderEditorHotspots(target);
      setState(target, "done");
      selectEditorSegment(snapshot.segmentId);
      state.recoveryAttempts = 0;
      editorMessage.textContent = "Đã đồng bộ";
    } catch (error) {
      if (isExtensionContextInvalidated(error)) {
        invalidateExtensionContext();
        return;
      }
      if (error.code === "EDITOR_SESSION_EXPIRED") {
        await recoverExpiredEditorSession(state, target, snapshot);
        return;
      }
      if (editorState === state) editorMessage.textContent = error.message || "Không đồng bộ được bong bóng";
      if (!error.reported) reportContentError(error, target, "LIVE_EDIT_TRANSLATION_SEGMENT");
    } finally {
      state.syncing = false;
    }
  }

  async function recoverExpiredEditorSession(state, target, snapshot = null) {
    if (editorState !== state || state.recoveryAttempts >= 1) {
      if (editorState === state) editorMessage.textContent = "Không khôi phục được phiên chỉnh sửa; hãy thử dịch lại ảnh";
      return false;
    }
    state.recoveryAttempts += 1;
    const previousSegment = target.editorScene?.segments?.find((item) => item.id === (snapshot?.segmentId || state.segmentId));
    editorMessage.textContent = "Phiên cũ đã hết hạn; đang tự tái tạo scene";
    try {
      let payload = { ...createPayload(target), bypassCache: true, jobId: crypto.randomUUID() };
      let result = await chrome.runtime.sendMessage({ type: "TRANSLATE_IMAGE", payload });
      if (!result?.ok && result?.code === "CAPTURE_REQUIRED") {
        payload = { ...(await prepareScreenshotPayload(target)), bypassCache: true, jobId: payload.jobId };
        result = await chrome.runtime.sendMessage({ type: "TRANSLATE_IMAGE", payload });
      }
      if (!result?.ok) throw errorFromResult(result, "Không tái tạo được editor scene");
      if (!result.editorSessionId || !result.editorScene?.segments?.length) {
        throw new Error("Bản dịch mới không có scene chỉnh sửa");
      }
      if (editorState !== state || targets.get(target.id) !== target) return false;
      applyEditorMetadata(target, result);
      const replacement = target.editorScene.segments.find((item) => item.id === state.segmentId)
        || target.editorScene.segments.find((item) => item.sourceText === previousSegment?.sourceText)
        || target.editorScene.segments[0];
      state.segmentId = replacement.id;
      renderEditorHotspots(target);
      if (snapshot) {
        state.syncQueue.schedule(editorSnapshot(state), 0);
        editorMessage.textContent = "Đã tái tạo scene; đang gửi lại thay đổi";
      } else {
        await applyTranslation(target, result.dataUrl);
        selectEditorSegment(replacement.id);
        setState(target, "done");
        state.recoveryAttempts = 0;
        editorMessage.textContent = "Đã tái tạo phiên chỉnh sửa";
      }
      return true;
    } catch (recoveryError) {
      if (isExtensionContextInvalidated(recoveryError)) {
        invalidateExtensionContext();
        return false;
      }
      if (editorState === state) {
        editorMessage.textContent = recoveryError.message || "Không tái tạo được editor scene";
      }
      if (!recoveryError.reported) reportContentError(recoveryError, target, "RECOVER_EDITOR_SESSION");
      return false;
    }
  }

  async function submitEditor(action) {
    const state = editorState;
    const target = state ? targets.get(state.targetId) : null;
    if (!state || !target || state.busy) return;
    setEditorBusy(true, action === "retranslate" ? "Đang dịch lại" : "Đang khôi phục bản API");
    try {
      await state.syncQueue.drain();
      if (!editorState || editorState !== state) return;
      const result = await chrome.runtime.sendMessage({
        type: "EDIT_TRANSLATION_SEGMENT",
        payload: {
          action,
          sessionId: target.editorSessionId,
          segmentId: state.segmentId,
          cacheKey: target.cacheKey,
          pageUrl: location.href,
        },
      });
      if (!result?.ok) throw errorFromResult(result, "Không chỉnh sửa được bong bóng");
      if (!editorState || editorState !== state || targets.get(target.id) !== target) return;
      await applyTranslation(target, result.dataUrl);
      applyEditorMetadata(target, result);
      renderEditorHotspots(target);
      selectEditorSegment(state.segmentId);
      setState(target, "done");
      showToast(action === "retranslate" ? "Đã dịch lại bong bóng" : "Đã khôi phục bản API");
    } catch (error) {
      if (isExtensionContextInvalidated(error)) {
        invalidateExtensionContext();
        return;
      }
      if (error.code === "EDITOR_SESSION_EXPIRED") {
        const recovered = await recoverExpiredEditorSession(state, target);
        if (recovered) showToast("Đã tái tạo phiên chỉnh sửa từ ảnh nguồn");
        return;
      }
      editorMessage.textContent = error.message || "Không chỉnh sửa được bong bóng";
      if (!error.reported) reportContentError(error, target, "EDIT_TRANSLATION_SEGMENT");
    } finally {
      if (editorState === state) setEditorBusy(false, editorMessage.textContent);
    }
  }

  function setEditorBusy(busy, message) {
    if (!editorState) return;
    editorState.busy = busy;
    for (const control of editorPanel.querySelectorAll("button, textarea, input, select")) {
      control.disabled = busy;
    }
    editorMessage.textContent = message;
    updateEditorSizeState();
    updateEditorFontState();
  }

  function restoreEditorTarget() {
    const target = editorState ? targets.get(editorState.targetId) : null;
    if (!target) return;
    closeEditor();
    restoreTarget(target, true);
    showToast("Đã khôi phục ảnh gốc");
  }

  function sourceIdentity(target) {
    return elementSourceIdentity(target.element, target.id);
  }

  function elementSourceIdentity(element, fallback) {
    if (element instanceof HTMLImageElement) return element.currentSrc || element.src || fallback;
    if (element instanceof HTMLCanvasElement) return `canvas:${fallback}:${element.width}x${element.height}`;
    return backgroundImageUrl(element) || `background:${fallback}`;
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
      .filter((target) => automatic ? target.state === "idle" : !["done", "loading"].includes(target.state));
    if (!pending.length) {
      if (!automatic) showToast("Không có ảnh mới để dịch");
      return;
    }

    await startQueue(pending, { automatic });
  }

  async function startQueue(pending, { automatic = false } = {}) {
    if (!settings.extensionEnabled || queueRun || !pending.length) return;
    const ordered = sortedQueueTargets(pending);

    const run = {
      automatic,
      cancelled: false,
      paused: false,
      completed: 0,
      failed: 0,
      cancelledCount: 0,
      total: ordered.length,
      itemIds: ordered.map((target) => target.id),
      activeId: "",
      status: "running",
      readerSession: queueUtils.readerSessionKey(location.href),
    };
    ordered.forEach((target, index) => {
      target.queuePosition = index + 1;
      target.stage = "";
      target.stageState = "queued";
      target.queuePayload = createPayload(target);
    });

    queueRun = run;
    lastQueueRun = null;
    renderQueueUi();
    const processedIds = [];
    const remaining = [...ordered];
    while (remaining.length) {
      await waitWhilePaused(run);
      if (run.cancelled) break;
      const nextOrder = sortedQueueTargets(remaining);
      const target = nextOrder[0];
      remaining.splice(remaining.indexOf(target), 1);
      run.itemIds = [...processedIds, ...nextOrder.map((candidate) => candidate.id)];
      run.itemIds.forEach((id, index) => {
        const queuedTarget = targets.get(id);
        if (queuedTarget) queuedTarget.queuePosition = index + 1;
      });
      if (!targets.has(target.id)) {
        run.cancelledCount += 1;
        processedIds.push(target.id);
        continue;
      }
      run.activeId = target.id;
      renderQueueUi();
      const ok = await translateTarget(target.id);
      if (!extensionContextValid) {
        queueRun = null;
        return;
      }
      if (ok) {
        run.completed += 1;
      } else if (target.state === "cancelled" || run.cancelled) {
        run.cancelledCount += 1;
      } else {
        run.failed += 1;
      }
      run.activeId = "";
      processedIds.push(target.id);
      renderQueueUi();
    }
    const wasCancelled = run.cancelled;
    if (wasCancelled) {
      const remaining = run.total - run.completed - run.failed - run.cancelledCount;
      run.cancelledCount += Math.max(0, remaining);
      for (const id of run.itemIds) {
        const target = targets.get(id);
        if (target?.state === "idle" && target.stageState === "queued") {
          target.stageState = "cancelled";
          setState(target, "cancelled");
        }
      }
    }
    run.status = wasCancelled ? "cancelled" : "completed";
    const message = wasCancelled
      ? `Đã dừng: ${run.completed}/${run.total} ảnh hoàn tất`
      : `Hoàn tất ${run.completed}/${run.total} ảnh${run.failed ? `, lỗi ${run.failed} · Xem Chi tiết lỗi trong popup` : ""}`;
    queueRun = null;
    lastQueueRun = settings.extensionEnabled
      && run.readerSession === queueUtils.readerSessionKey(location.href) ? run : null;
    renderQueueUi();
    if (settings.extensionEnabled && extensionContextValid) showToast(message);
    scheduleScan();
    scheduleAutoTranslate();
  }

  function sortedQueueTargets(pending) {
    return queueUtils.sortQueueItems(pending.map((target) => {
      if (target.detached || !target.element.isConnected) {
        return {
          id: target.id,
          target,
          rect: {
            top: Number.MAX_SAFE_INTEGER,
            bottom: Number.MAX_SAFE_INTEGER,
            documentTop: Number.MAX_SAFE_INTEGER,
          },
        };
      }
      const rect = target.element.getBoundingClientRect();
      return {
        id: target.id,
        target,
        rect: { top: rect.top, bottom: rect.bottom, documentTop: documentTop(target.element) },
      };
    }), innerHeight).map((item) => item.target);
  }

  async function waitWhilePaused(run) {
    while (run.paused && !run.cancelled && queueRun === run) {
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
  }

  function toggleQueuePause(forcePaused) {
    if (!queueRun || queueRun.cancelled) return;
    queueRun.paused = typeof forcePaused === "boolean" ? forcePaused : !queueRun.paused;
    queueRun.status = queueRun.paused ? "paused" : "running";
    renderQueueUi();
  }

  async function cancelQueue() {
    if (!queueRun) return;
    queueRun.cancelled = true;
    queueRun.paused = false;
    queueRun.status = "cancelling";
    const activeTarget = targets.get(queueRun.activeId);
    renderQueueUi();
    if (activeTarget?.jobId) {
      try {
        await chrome.runtime.sendMessage({
          type: "CANCEL_TRANSLATION_JOB",
          payload: { jobId: activeTarget.jobId },
        });
      } catch (error) {
        if (isExtensionContextInvalidated(error)) invalidateExtensionContext();
      }
    }
  }

  function retryFailedTargets() {
    const failed = [...targets.values()].filter((target) => ["error", "cancelled"].includes(target.state));
    if (!failed.length) {
      showToast("Không có ảnh lỗi để thử lại");
      return;
    }
    startQueue(failed);
  }

  function handleQueueListClick(event) {
    const button = event.target.closest("button[data-retry-id]");
    if (!button || queueRun) return;
    const target = targets.get(button.dataset.retryId);
    if (target) startQueue([target]);
  }

  function handleQueueCommand(command) {
    if (command === "start") {
      scan();
      translatePage();
    }
    if (command === "pause") toggleQueuePause(true);
    if (command === "resume") toggleQueuePause(false);
    if (command === "cancel") cancelQueue();
    if (command === "retry-failed") retryFailedTargets();
  }

  function handleTranslationProgress(message) {
    const target = [...targets.values()].find((candidate) => candidate.jobId === message.jobId);
    if (!target || !message.progress) return;
    target.stage = message.progress.stage || target.stage;
    target.stageState = message.progress.stageState || target.stageState;
    if (message.progress.state === "cancelling") target.stageState = "cancelling";
    renderQueueUi();
  }

  function publicQueueState() {
    const run = queueRun || lastQueueRun;
    const active = queueRun ? targets.get(queueRun.activeId) : null;
    const summary = queueUtils.queueSummary(run);
    const retryCount = [...targets.values()].filter((target) => ["error", "cancelled"].includes(target.state)).length;
    return {
      state: queueRun ? queueRun.status : run?.status || "idle",
      ...summary,
      activeStage: active?.stage || "",
      activeStageState: active?.stageState || "",
      activePosition: active?.queuePosition || 0,
      detected: targets.size,
      canStart: !queueRun && targets.size > 0,
      canPause: Boolean(queueRun && !queueRun.cancelled),
      canCancel: Boolean(queueRun && !queueRun.cancelled),
      canRetry: !queueRun && retryCount > 0,
      retryCount,
    };
  }

  function renderQueueUi() {
    const run = queueRun || lastQueueRun;
    const summary = queueUtils.queueSummary(run);
    translateAllButton.disabled = Boolean(queueRun);
    pauseButton.hidden = !queueRun;
    pauseButton.disabled = Boolean(queueRun?.cancelled);
    pauseButton.textContent = queueRun?.paused ? "▶" : "Ⅱ";
    pauseButton.title = queueRun?.paused ? "Tiếp tục hàng đợi" : "Tạm dừng hàng đợi";
    pauseButton.setAttribute("aria-label", pauseButton.title);
    cancelButton.hidden = !queueRun;
    cancelButton.disabled = Boolean(queueRun?.cancelled);
    retryFailedButton.hidden = Boolean(queueRun) || ![...targets.values()].some((target) => ["error", "cancelled"].includes(target.state));
    queuePanel.hidden = !run;
    queueSummary.textContent = run ? `${summary.processed}/${summary.total}` : "0/0";
    status.textContent = queueRun?.status === "cancelling" ? "Đang dừng" : run ? `${summary.processed}/${summary.total}` : String(targets.size);

    if (!run) {
      queueList.replaceChildren();
      return;
    }
    const rows = run.itemIds.map((id, index) => {
      const target = targets.get(id);
      if (!target) return null;
      const row = document.createElement("div");
      row.className = "queue-row";
      const position = document.createElement("span");
      position.className = "queue-index";
      position.textContent = String(index + 1);
      const label = document.createElement("span");
      label.className = "queue-label";
      label.dataset.state = target.state;
      label.textContent = queueTargetLabel(target);
      label.title = target.lastError || label.textContent;
      row.append(position, label);
      if (!queueRun && ["error", "cancelled"].includes(target.state)) {
        const retry = document.createElement("button");
        retry.className = "queue-retry";
        retry.dataset.retryId = target.id;
        retry.textContent = "↻";
        retry.title = "Thử lại ảnh này";
        retry.setAttribute("aria-label", "Thử lại ảnh này");
        row.append(retry);
      } else {
        row.append(document.createElement("span"));
      }
      return row;
    }).filter(Boolean);
    queueList.replaceChildren(...rows);
  }

  function queueTargetLabel(target) {
    if (target.state === "done") return "Hoàn tất";
    if (target.state === "error") return `Lỗi: ${target.lastError || "Không dịch được"}`;
    if (target.state === "cancelled") return "Đã hủy";
    if (target.state === "loading") return queueUtils.stageLabel(target.stage, target.stageState);
    return target.stageState === "queued" ? "Đang chờ" : "Chưa chạy";
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
    const nextReaderSession = queueUtils.readerSessionKey(location.href);
    currentPageUrl = location.href;
    if (nextReaderSession === currentReaderSession) {
      queueLayout();
      return;
    }
    currentReaderSession = nextReaderSession;
    restoreSuppressions.clear();
    cancelQueue();
    lastQueueRun = null;
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
    if (!extensionContextValid || !settings.extensionEnabled || !settings.autoTranslate || queueRun) return;
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
      ? "Chỉnh sửa bản dịch"
      : state === "error" ? `Dịch lại ảnh · ${target.lastError || "Xem Chi tiết lỗi trong popup"}`
        : state === "cancelled" ? "Tác vụ đã hủy · Nhấn để thử lại" : "Dịch ảnh này";
    renderQueueUi();
  }

  function errorFromResult(result, fallback) {
    const error = new Error(result?.error || fallback);
    error.code = result?.code || "UNKNOWN";
    error.httpStatus = result?.httpStatus ?? null;
    error.requestId = result?.requestId || "";
    error.reported = Boolean(result?.reported);
    return error;
  }

  function reportContentError(error, target, operation = "TRANSLATE_IMAGE") {
    const payload = createPayload(target);
    try {
      chrome.runtime.sendMessage({
        type: "REPORT_ERROR",
        payload: {
          operation,
          code: error.code || "CONTENT_ERROR",
          message: error.message,
          httpStatus: error.httpStatus,
          requestId: error.requestId,
          pageUrl: location.href,
          image: payload.filename,
        },
      }).catch(() => {});
    } catch (sendError) {
      if (isExtensionContextInvalidated(sendError)) invalidateExtensionContext();
    }
  }

  function isExtensionContextInvalidated(error) {
    return !chrome.runtime?.id || /extension context invalidated/i.test(error?.message || "");
  }

  function invalidateExtensionContext() {
    if (!extensionContextValid) return;
    extensionContextValid = false;
    clearTimeout(scanTimer);
    clearTimeout(autoTranslateTimer);
    if (queueRun) queueRun.cancelled = true;
    host.remove();
  }

  let toastTimer;
  function showToast(message) {
    toast.textContent = message;
    toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("show"), 3200);
  }
})();
