(() => {
  function segmentRect(segment, imageRect, sceneWidth, sceneHeight) {
    const bounds = segment?.bounds || {};
    const width = Math.max(1, Number(sceneWidth) || 1);
    const height = Math.max(1, Number(sceneHeight) || 1);
    return {
      left: imageRect.left + (Number(bounds.x) || 0) / width * imageRect.width,
      top: imageRect.top + (Number(bounds.y) || 0) / height * imageRect.height,
      width: Math.max(18, (Number(bounds.width) || 0) / width * imageRect.width),
      height: Math.max(18, (Number(bounds.height) || 0) / height * imageRect.height),
    };
  }

  function normalizeStyle(style = {}) {
    const fontSize = style.fontSize == null || style.fontSize === "" ? Number.NaN : Number(style.fontSize);
    const lineHeight = Number(style.lineHeight);
    const fontWeight = Number(style.fontWeight);
    const alignment = ["auto", "start", "center", "end", "justify"].includes(style.alignment)
      ? style.alignment : "auto";
    return {
      fontFamily: String(style.fontFamily || "").slice(0, 256),
      fontSize: Number.isFinite(fontSize) ? Math.min(256, Math.max(6, fontSize)) : null,
      autoFit: style.autoFit !== false,
      fontWeight: Number.isFinite(fontWeight) ? Math.min(900, Math.max(100, Math.round(fontWeight / 100) * 100)) : 400,
      italic: Boolean(style.italic),
      alignment,
      lineHeight: Number.isFinite(lineHeight) ? Math.min(3, Math.max(0.8, lineHeight)) : 1.2,
    };
  }

  function createLatestTaskQueue(run) {
    let timer = null;
    let pending;
    let hasPending = false;
    let running = null;
    let closed = false;

    function clearTimer() {
      if (timer === null) return;
      clearTimeout(timer);
      timer = null;
    }

    function arm(delay) {
      clearTimer();
      if (closed || running || !hasPending) return;
      timer = setTimeout(() => {
        timer = null;
        void flush().catch(() => {});
      }, Math.max(0, Number(delay) || 0));
    }

    function schedule(value, delay = 0) {
      if (closed) return;
      pending = value;
      hasPending = true;
      arm(delay);
    }

    async function flush() {
      clearTimer();
      if (closed) return;
      if (running) return running;
      if (!hasPending) return;

      const value = pending;
      pending = undefined;
      hasPending = false;
      running = Promise.resolve().then(() => run(value));
      try {
        await running;
      } finally {
        running = null;
        if (hasPending) arm(0);
      }
    }

    async function drain() {
      clearTimer();
      while (!closed && (running || hasPending)) {
        if (running) await running;
        else await flush();
        clearTimer();
      }
    }

    function cancel() {
      closed = true;
      clearTimer();
      pending = undefined;
      hasPending = false;
    }

    return Object.freeze({
      cancel,
      drain,
      flush,
      isIdle: () => !running && !hasPending && timer === null,
      schedule,
    });
  }

  globalThis.MangaEditorUtils = Object.freeze({ createLatestTaskQueue, normalizeStyle, segmentRect });
})();
