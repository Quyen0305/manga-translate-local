import assert from "node:assert/strict";
import test from "node:test";

import {
  CACHE_KEY_VERSION,
  CACHE_PIPELINE_VERSION,
  VISUAL_CONTEXT_VERSION,
  cacheEntryMetadata,
  cacheFingerprint,
  cacheLocation,
  cacheScopeForPage,
} from "../extension/cache-metadata.js";

const settings = {
  provider: "gemini",
  model: "gemini-3.5-flash-lite",
  apiKey: "must-not-be-cached",
  baseUrl: "https://generativelanguage.googleapis.com/",
  targetLanguage: "vi",
  systemPrompt: "Dịch tự nhiên",
  visualContextMode: "off",
};

test("MangaDex dùng cùng phạm vi chapter khi URL đổi số trang", () => {
  const chapter = "30e8a046-ed96-4629-bfed-f4525b602700";
  const first = cacheLocation(`https://mangadex.org/chapter/${chapter}/1`);
  const later = cacheLocation(`https://mangadex.org/chapter/${chapter}/14?foo=bar#reader`);
  assert.equal(first.pageKey, later.pageKey);
  assert.equal(first.chapterKey, `https://mangadex.org/chapter/${chapter}`);
  assert.equal(first.siteKey, "https://mangadex.org");
});

test("phạm vi website và trang generic loại query cùng hash", () => {
  const scope = cacheScopeForPage("https://reader.example/chapter/12/?page=3#image");
  assert.deepEqual(scope, {
    siteKey: "https://reader.example",
    siteLabel: "reader.example",
    pageKey: "https://reader.example/chapter/12",
  });
});

test("fingerprint mới chứa phiên bản pipeline còn fingerprint legacy giữ định dạng cũ", () => {
  const current = cacheFingerprint(settings);
  const legacy = cacheFingerprint(settings, { legacy: true });
  assert.equal(current.cacheKeyVersion, CACHE_KEY_VERSION);
  assert.equal(current.pipelineVersion, CACHE_PIPELINE_VERSION);
  assert.equal(current.visualContextMode, "off");
  assert.equal("visualContextVersion" in current, false);
  assert.equal("cacheKeyVersion" in legacy, false);
  assert.equal("pipelineVersion" in legacy, false);
  assert.equal(JSON.stringify(legacy), JSON.stringify({
    provider: settings.provider,
    model: settings.model,
    baseUrl: settings.baseUrl,
    targetLanguage: settings.targetLanguage,
    systemPrompt: settings.systemPrompt,
  }));
});

test("MiniCPM visual context có fingerprint riêng nhưng không làm thay đổi cache chế độ tắt", () => {
  const disabled = cacheFingerprint(settings);
  const enabled = cacheFingerprint({ ...settings, visualContextMode: "minicpm-v4.6" });
  assert.equal(enabled.visualContextMode, "minicpm-v4.6");
  assert.equal(enabled.visualContextVersion, VISUAL_CONTEXT_VERSION);
  assert.notEqual(JSON.stringify(enabled), JSON.stringify(disabled));
});

test("metadata cache có provider/model và không lưu API key", () => {
  const metadata = cacheEntryMetadata("https://mangadex.org/chapter/example/2", settings);
  assert.equal(metadata.provider, settings.provider);
  assert.equal(metadata.model, settings.model);
  assert.equal(metadata.providerModel, `${settings.provider}:${settings.model}`);
  assert.equal(metadata.visualContextMode, "off");
  assert.equal(metadata.pipelineVersion, CACHE_PIPELINE_VERSION);
  assert.equal("apiKey" in metadata, false);
  assert.equal(JSON.stringify(metadata).includes(settings.apiKey), false);
});

test("URL không hợp lệ không tạo phạm vi xóa cache", () => {
  assert.deepEqual(cacheScopeForPage("not a url"), {
    siteKey: "",
    siteLabel: "",
    pageKey: "",
  });
});
