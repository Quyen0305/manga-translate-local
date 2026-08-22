export const CACHE_KEY_VERSION = 2;
export const CACHE_PIPELINE_VERSION = "koharu-0.70.2-scene-v1";
export const CACHE_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
export const CACHE_MAX_BYTES = 1024 * 1024 * 1024;
export const CACHE_MAX_ENTRIES = 1000;
export const VISUAL_CONTEXT_VERSION = "minicpm-v4.6-context-v2.5-grounded";

export function cacheLocation(pageUrl) {
  try {
    const url = new URL(pageUrl);
    const siteKey = url.origin;
    const mangaDexChapter = url.hostname === "mangadex.org"
      ? url.pathname.match(/^\/chapter\/([^/]+)(?:\/\d+)?\/?$/i)
      : null;
    const pagePath = mangaDexChapter ? `/chapter/${mangaDexChapter[1]}` : normalizePath(url.pathname);
    const pageKey = `${siteKey}${pagePath}`;
    return {
      siteKey,
      siteLabel: url.hostname,
      pageKey,
      pageUrl: pageKey,
      chapterKey: mangaDexChapter ? pageKey : "",
    };
  } catch {
    return { siteKey: "", siteLabel: "", pageKey: "", pageUrl: "", chapterKey: "" };
  }
}

export function cacheFingerprint(settings, { legacy = false } = {}) {
  const fingerprint = {
    provider: settings.provider || "",
    model: settings.model || "",
    baseUrl: legacy ? settings.baseUrl || "" : String(settings.baseUrl || "").replace(/\/+$/, ""),
    targetLanguage: settings.targetLanguage || "",
    systemPrompt: settings.systemPrompt || "",
  };
  if (!legacy) {
    fingerprint.cacheKeyVersion = CACHE_KEY_VERSION;
    fingerprint.pipelineVersion = CACHE_PIPELINE_VERSION;
    fingerprint.visualContextMode = settings.visualContextMode || "off";
    if (fingerprint.visualContextMode !== "off") {
      fingerprint.visualContextVersion = VISUAL_CONTEXT_VERSION;
    }
  }
  return fingerprint;
}

export function cacheEntryMetadata(pageUrl, settings) {
  const location = cacheLocation(pageUrl);
  return {
    ...location,
    siteKeys: location.siteKey ? [location.siteKey] : [],
    pageKeys: location.pageKey ? [location.pageKey] : [],
    provider: settings.provider || "",
    model: settings.model || "",
    providerModel: `${settings.provider || ""}:${settings.model || ""}`,
    visualContextMode: settings.visualContextMode || "off",
    targetLanguage: settings.targetLanguage || "",
    pipelineVersion: CACHE_PIPELINE_VERSION,
    cacheKeyVersion: CACHE_KEY_VERSION,
  };
}

export function cacheScopeForPage(pageUrl) {
  const location = cacheLocation(pageUrl);
  return {
    siteKey: location.siteKey,
    siteLabel: location.siteLabel,
    pageKey: location.pageKey,
  };
}

function normalizePath(pathname) {
  const path = pathname.replace(/\/{2,}/g, "/").replace(/\/$/, "");
  return path || "/";
}
