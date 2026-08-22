(() => {
  const STAGE_LABELS = Object.freeze({
    preparing: "Chuẩn bị",
    "visual-context": "Ngữ cảnh ảnh",
    detection: "Nhận diện",
    ocr: "OCR",
    translation: "Dịch",
    inpainting: "Xóa chữ",
    rendering: "Dựng ảnh",
    cache: "Cache",
  });

  function queuePriority(rect, viewportHeight) {
    const height = Math.max(1, Number(viewportHeight) || 1);
    const visible = rect.bottom > 0 && rect.top < height;
    const distance = visible
      ? Math.abs((rect.top + rect.bottom) / 2 - height / 2)
      : rect.top >= height ? rect.top - height : Math.abs(rect.bottom);
    const band = visible ? 0 : distance <= height * 1.5 ? 1 : 2;
    return [band, distance, Math.max(0, Number(rect.documentTop ?? rect.top) || 0)];
  }

  function compareQueueItems(left, right, viewportHeight) {
    const a = queuePriority(left.rect, viewportHeight);
    const b = queuePriority(right.rect, viewportHeight);
    for (let index = 0; index < a.length; index += 1) {
      if (a[index] !== b[index]) return a[index] - b[index];
    }
    return String(left.id).localeCompare(String(right.id));
  }

  function sortQueueItems(items, viewportHeight) {
    return [...items].sort((left, right) => compareQueueItems(left, right, viewportHeight));
  }

  function stageLabel(stage, stageState = "") {
    const label = STAGE_LABELS[stage] || (stage ? String(stage) : "Đang chờ");
    if (stageState === "loading") return `Nạp ${label.toLowerCase()}`;
    if (stageState === "finished") return `${label} xong`;
    if (stageState === "cancelling") return "Đang dừng";
    return label;
  }

  function queueSummary(run = {}) {
    run = run || {};
    const completed = Number(run.completed || 0);
    const failed = Number(run.failed || 0);
    const cancelled = Number(run.cancelledCount || 0);
    const total = Number(run.total || 0);
    return {
      processed: completed + failed + cancelled,
      completed,
      failed,
      cancelled,
      total,
    };
  }

  function queueOwnsTarget(run, targetId) {
    return Boolean(run && Array.isArray(run.itemIds) && run.itemIds.includes(targetId));
  }

  function readerAdapter(pageUrl) {
    try {
      const url = new URL(pageUrl);
      if (url.hostname === "mangadex.org" && /^\/chapter\//i.test(url.pathname)) return "mangadex";
    } catch {
      // Invalid URLs do not receive a site-specific adapter.
    }
    return "generic";
  }

  function readerSessionKey(pageUrl) {
    try {
      const url = new URL(pageUrl);
      if (readerAdapter(pageUrl) === "mangadex") {
        const chapter = url.pathname.match(/^\/chapter\/([^/]+)(?:\/\d+)?\/?$/i);
        if (chapter) return `${url.origin}/chapter/${chapter[1]}`;
      }
      return url.href;
    } catch {
      return String(pageUrl || "");
    }
  }

  function isKnownReaderImage({ pageUrl, sourceUrl = "", tagName = "", width = 0, height = 0 }) {
    if (readerAdapter(pageUrl) !== "mangadex" || String(tagName).toUpperCase() !== "IMG") return false;
    try {
      const source = new URL(sourceUrl, pageUrl);
      if (/\/data(?:-saver)?\//i.test(source.pathname)) return true;
    } catch {
      // Blob/data images are recognized by their displayed dimensions below.
    }
    return Number(width) >= 320 && Number(height) >= 400;
  }

  globalThis.MangaQueueUtils = Object.freeze({
    compareQueueItems,
    isKnownReaderImage,
    queuePriority,
    queueOwnsTarget,
    queueSummary,
    readerAdapter,
    readerSessionKey,
    sortQueueItems,
    stageLabel,
  });
})();
