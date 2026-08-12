import assert from "node:assert/strict";
import test from "node:test";
import { validateTranslationSettings } from "../src/translation/service.mjs";

test("chấp nhận cấu hình Gemini hợp lệ", () => {
  const settings = validateTranslationSettings({
    provider: "gemini",
    model: "gemini-3.5-flash-lite",
    apiKey: "test-key",
    targetLanguage: "vi",
  });
  assert.equal(settings.provider, "gemini");
  assert.equal(settings.targetLanguage, "vi");
});

test("OpenAI-compatible bắt buộc có base URL", () => {
  assert.throws(
    () => validateTranslationSettings({ provider: "openai-compatible", model: "local-model" }),
    /Base URL/,
  );
});

test("provider cloud bắt buộc có API key", () => {
  assert.throws(
    () => validateTranslationSettings({ provider: "openai", model: "gpt-4.1-mini" }),
    /API key/,
  );
});

test("DeepL dùng engine dịch máy mt của Koharu", () => {
  const settings = validateTranslationSettings({
    provider: "deepl",
    model: "",
    apiKey: "test-key:fx",
    targetLanguage: "vi",
  });
  assert.equal(settings.provider, "deepl");
  assert.equal(settings.model, "mt");
});
