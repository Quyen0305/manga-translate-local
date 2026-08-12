import { ValidationError } from "../shared/errors.mjs";
import { resolveDeepLEndpoint } from "../deepl/service.mjs";

const PROVIDERS = new Set([
  "openai",
  "gemini",
  "claude",
  "deepseek",
  "deepl",
  "google-translate",
  "caiyun",
  "openai-compatible",
]);

export function validateTranslationSettings(input) {
  const provider = String(input.provider || "gemini").trim();
  const settings = {
    provider,
    model: provider === "deepl" ? "mt" : String(input.model || "gemini-3.5-flash-lite").trim(),
    apiKey: String(input.apiKey || "").trim(),
    baseUrl: String(input.baseUrl || "").trim().replace(/\/$/, ""),
    targetLanguage: String(input.targetLanguage || "vi").trim(),
    systemPrompt: String(input.systemPrompt || "").trim(),
  };
  if (!PROVIDERS.has(settings.provider)) throw new ValidationError("Nhà cung cấp API không hợp lệ");
  if (!settings.model) throw new ValidationError("Thiếu model dịch");
  if (!settings.targetLanguage) throw new ValidationError("Thiếu ngôn ngữ đích");
  if (settings.provider !== "openai-compatible" && !settings.apiKey) {
    throw new ValidationError("Thiếu API key");
  }
  if (settings.provider === "openai-compatible" && !settings.baseUrl) {
    throw new ValidationError("OpenAI-compatible cần Base URL");
  }
  return settings;
}

export class TranslationService {
  constructor({ mode, engineManager, logger }) {
    this.mode = mode;
    this.engine = engineManager;
    this.logger = logger;
    this.queue = Promise.resolve();
  }

  translate(job) {
    const run = () => this.translateNow(job);
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => {});
    return result;
  }

  async translateNow(job) {
    if (this.mode === "passthrough") {
      return { bytes: job.image, contentType: job.contentType };
    }
    let settings = validateTranslationSettings(job.settings);
    if (settings.provider === "deepl") {
      const resolved = await resolveDeepLEndpoint({
        apiKey: settings.apiKey,
        baseUrl: settings.baseUrl,
      });
      settings = { ...settings, baseUrl: resolved.baseUrl };
    }
    const startedAt = Date.now();
    const result = await this.engine.translate({ ...job, settings });
    this.logger.info("Đã dịch ảnh bằng manga-engine", {
      requestId: job.requestId,
      durationMs: Date.now() - startedAt,
      provider: settings.provider,
      model: settings.model,
    });
    return result;
  }
}
