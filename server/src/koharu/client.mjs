import { setTimeout as delay } from "node:timers/promises";
import { resolveDeepLEndpoint } from "../deepl/service.mjs";
import { KoharuError, TimeoutError } from "../shared/errors.mjs";

const PIPELINE_STEPS = [
  "comic-text-bubble-detector",
  "comic-text-detector-seg",
  "speech-bubble-segmentation",
  "paddle-ocr-vl-1.6",
  "yuzumarker-font-detection",
  "llm",
  "lama-manga",
  "koharu-renderer",
];

export class KoharuClient {
  constructor(baseUrl, jobTimeoutMs, fetchImpl = fetch) {
    this.baseUrl = baseUrl;
    this.jobTimeoutMs = jobTimeoutMs;
    this.fetch = fetchImpl;
    this.providerSignature = null;
  }

  async request(path, options = {}) {
    const response = await this.fetch(`${this.baseUrl}${path}`, {
      ...options,
      headers: {
        ...(options.body instanceof FormData ? {} : { "content-type": "application/json" }),
        ...options.headers,
      },
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new KoharuError(`Koharu ${response.status}: ${text || response.statusText}`, 502, {
        path,
        upstreamStatus: response.status,
      });
    }
    return response;
  }

  async json(path, options = {}) {
    const response = await this.request(path, options);
    return response.json();
  }

  async configureProvider(settings) {
    if (settings.provider === "deepl") {
      const resolved = await resolveDeepLEndpoint({
        apiKey: settings.apiKey,
        baseUrl: settings.baseUrl,
        fetchImpl: this.fetch,
      });
      settings = { ...settings, baseUrl: resolved.baseUrl };
    }
    const signature = JSON.stringify({
      provider: settings.provider,
      model: settings.model,
      baseUrl: settings.baseUrl,
      apiKey: settings.apiKey,
    });
    if (signature === this.providerSignature) return;

    if (["openai-compatible", "deepl"].includes(settings.provider)) {
      const current = await this.json("/config");
      const providers = (current.providers ?? []).filter((item) => item.id !== settings.provider);
      providers.push({
        id: settings.provider,
        baseUrl: settings.baseUrl || null,
        apiKey: settings.apiKey ? "[REDACTED]" : undefined,
      });
      await this.request("/config", {
        method: "PATCH",
        body: JSON.stringify({ providers }),
      });
    }

    if (settings.apiKey) {
      await this.request(`/config/providers/${encodeURIComponent(settings.provider)}/secret`, {
        method: "PUT",
        body: JSON.stringify({ secret: settings.apiKey }),
      });
    }

    await this.request("/llm/current", {
      method: "PUT",
      body: JSON.stringify({
        target: {
          kind: "provider",
          modelId: settings.model,
          providerId: settings.provider,
        },
        options: { temperature: 0.2, maxTokens: 4096 },
      }),
    });
    await this.waitForLlm(settings);
    this.providerSignature = signature;
  }

  async waitForLlm(settings) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < 60_000) {
      const state = await this.json("/llm/current");
      if (state.status === "ready" && state.target?.modelId === settings.model) return;
      if (state.status === "failed") {
        throw new KoharuError(`Không tải được API dịch: ${state.error ?? "lỗi không xác định"}`);
      }
      await delay(300);
    }
    throw new TimeoutError("API dịch không sẵn sàng sau 60 giây");
  }

  async createProject() {
    return this.json("/projects", {
      method: "POST",
      body: JSON.stringify({ name: `browser-${Date.now()}` }),
    });
  }

  async uploadPage(image, contentType, filename) {
    const form = new FormData();
    form.append("files", new Blob([image], { type: contentType }), filename);
    const result = await this.json("/pages", { method: "POST", body: form });
    if (!result.pages?.[0]) throw new KoharuError("Koharu không tạo được trang từ ảnh");
    return result.pages[0];
  }

  async runPipeline(pageId, settings) {
    const result = await this.json("/pipelines", {
      method: "POST",
      body: JSON.stringify({
        steps: PIPELINE_STEPS,
        pages: [pageId],
        targetLanguage: settings.targetLanguage,
        systemPrompt: settings.systemPrompt || undefined,
        readingOrder: "rtl",
      }),
    });
    await this.waitForOperation(result.operationId);
  }

  async waitForOperation(operationId) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < this.jobTimeoutMs) {
      const result = await this.json("/operations");
      const operation = result.operations?.find((item) => item.id === operationId);
      if (!operation || operation.status === "running") {
        await delay(750);
        continue;
      }
      if (operation.status === "completed") return;
      throw new KoharuError(
        operation.error || `Pipeline kết thúc với trạng thái ${operation.status}`,
      );
    }
    throw new TimeoutError("Pipeline Koharu chạy quá thời gian cho phép");
  }

  async exportRendered(pageId) {
    const response = await this.request("/projects/current/export", {
      method: "POST",
      body: JSON.stringify({ format: "rendered", pages: [pageId] }),
    });
    return {
      bytes: Buffer.from(await response.arrayBuffer()),
      contentType: response.headers.get("content-type") || "image/png",
    };
  }

  async cleanupProject(projectId) {
    await this.request("/projects/current", { method: "DELETE", body: undefined }).catch(() => {});
    if (projectId) {
      await this.request(`/projects/${encodeURIComponent(projectId)}`, {
        method: "DELETE",
        body: undefined,
      }).catch(() => {});
    }
  }
}
