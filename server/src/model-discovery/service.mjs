import crypto from "node:crypto";
import { resolveDeepLEndpoint } from "../deepl/service.mjs";
import { ProviderApiError, ValidationError } from "../shared/errors.mjs";

const SUPPORTED_PROVIDERS = new Set([
  "gemini",
  "openai",
  "deepseek",
  "claude",
  "deepl",
  "openai-compatible",
]);
const CACHE_TTL_MS = 5 * 60 * 1000;

export class ModelDiscoveryService {
  constructor(fetchImpl = fetch) {
    this.fetch = fetchImpl;
    this.cache = new Map();
  }

  async list(input) {
    const settings = validate(input);
    const cacheKey = fingerprint(settings);
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.models;

    const models = await this.fetchModels(settings);
    const normalized = uniqueModels(models).sort(compareModels);
    if (!normalized.length) {
      throw new ProviderApiError("API không trả về model dịch văn bản tương thích");
    }
    this.cache.set(cacheKey, { models: normalized, expiresAt: Date.now() + CACHE_TTL_MS });
    return normalized;
  }

  async fetchModels(settings) {
    switch (settings.provider) {
      case "gemini":
        return this.listGemini(settings.apiKey);
      case "openai":
        return this.listOpenAi("https://api.openai.com/v1", settings.apiKey, "openai");
      case "deepseek":
        return this.listOpenAi("https://api.deepseek.com", settings.apiKey, "deepseek");
      case "openai-compatible":
        return this.listOpenAi(settings.baseUrl, settings.apiKey, "openai-compatible");
      case "claude":
        return this.listClaude(settings.apiKey);
      case "deepl":
        return this.listDeepL(settings.apiKey, settings.baseUrl);
      default:
        throw new ValidationError("Nhà cung cấp chưa hỗ trợ tải danh sách model");
    }
  }

  async listGemini(apiKey) {
    const response = await this.fetchJson(
      `https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000&key=${encodeURIComponent(apiKey)}`,
      {},
      "gemini",
    );
    return (response.models ?? [])
      .filter((model) => model.supportedGenerationMethods?.includes("generateContent"))
      .map((model) => ({
        id: String(model.name ?? "").replace(/^models\//, ""),
        name: model.displayName || String(model.name ?? "").replace(/^models\//, ""),
      }))
      .filter((model) => /^gemini-/i.test(model.id) && isTextModel(model.id));
  }

  async listOpenAi(baseUrl, apiKey, provider) {
    const headers = apiKey ? { authorization: `Bearer ${apiKey}` } : {};
    const response = await this.fetchJson(`${baseUrl.replace(/\/$/, "")}/models`, headers, provider);
    return (response.data ?? [])
      .map((model) => ({ id: String(model.id ?? ""), name: String(model.id ?? "") }))
      .filter((model) => model.id && (provider !== "openai" || isOpenAiTextModel(model.id)));
  }

  async listClaude(apiKey) {
    const response = await this.fetchJson(
      "https://api.anthropic.com/v1/models?limit=1000",
      { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      "claude",
    );
    return (response.data ?? []).map((model) => ({
      id: String(model.id ?? ""),
      name: model.display_name || String(model.id ?? ""),
    }));
  }

  async listDeepL(apiKey, baseUrl) {
    await resolveDeepLEndpoint({ apiKey, baseUrl, fetchImpl: this.fetch });
    return [{ id: "mt", name: "DeepL Machine Translation" }];
  }

  async fetchJson(url, headers, provider) {
    let response;
    try {
      response = await this.fetch(url, {
        headers,
        signal: AbortSignal.timeout(20_000),
      });
    } catch (error) {
      throw new ProviderApiError(`Không kết nối được API ${provider}: ${error.message}`);
    }
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      const message = [401, 403].includes(response.status)
        ? `API key ${provider} không hợp lệ hoặc không có quyền truy cập`
        : `API ${provider} trả về HTTP ${response.status}`;
      throw new ProviderApiError(message, {
        provider,
        upstreamStatus: response.status,
        upstreamMessage: body.slice(0, 500),
      });
    }
    return response.json();
  }
}

function validate(input) {
  const settings = {
    provider: String(input.provider || "").trim(),
    apiKey: String(input.apiKey || "").trim(),
    baseUrl: String(input.baseUrl || "").trim().replace(/\/$/, ""),
  };
  if (!SUPPORTED_PROVIDERS.has(settings.provider)) {
    throw new ValidationError("Nhà cung cấp chưa hỗ trợ tải danh sách model");
  }
  if (settings.provider !== "openai-compatible" && !settings.apiKey) {
    throw new ValidationError("Hãy nhập API key trước khi tải model");
  }
  if (settings.provider === "openai-compatible" && !settings.baseUrl) {
    throw new ValidationError("OpenAI-compatible cần Base URL");
  }
  return settings;
}

function fingerprint(settings) {
  const secretHash = crypto.createHash("sha256").update(settings.apiKey).digest("hex");
  return `${settings.provider}:${settings.baseUrl}:${secretHash}`;
}

function uniqueModels(models) {
  const seen = new Set();
  return models.filter((model) => {
    if (!model.id || seen.has(model.id)) return false;
    seen.add(model.id);
    return true;
  });
}

function compareModels(a, b) {
  const rank = (id) => {
    if (/flash-lite|mini|nano|haiku/i.test(id)) return 0;
    if (/flash|sonnet|chat/i.test(id)) return 1;
    return 2;
  };
  return rank(a.id) - rank(b.id) || b.id.localeCompare(a.id, "en", { numeric: true });
}

function isTextModel(id) {
  return !/(embedding|image|imagen|tts|audio|live|robotics|aqa)/i.test(id);
}

function isOpenAiTextModel(id) {
  return /^(gpt-|chatgpt-|o[1-9](?:-|$))/i.test(id)
    && !/(audio|realtime|transcri|tts|image|search|computer)/i.test(id);
}
