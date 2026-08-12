import assert from "node:assert/strict";
import test from "node:test";
import { ModelDiscoveryService } from "../src/model-discovery/service.mjs";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("Gemini chỉ giữ model hỗ trợ generateContent dạng text", async () => {
  const service = new ModelDiscoveryService(async () => jsonResponse({
    models: [
      {
        name: "models/gemini-3.5-flash-lite",
        displayName: "Gemini 3.5 Flash-Lite",
        supportedGenerationMethods: ["generateContent", "countTokens"],
      },
      {
        name: "models/gemini-embedding-001",
        displayName: "Embedding",
        supportedGenerationMethods: ["embedContent"],
      },
      {
        name: "models/gemini-3-pro-image",
        displayName: "Image",
        supportedGenerationMethods: ["generateContent"],
      },
    ],
  }));

  const models = await service.list({ provider: "gemini", apiKey: "key" });
  assert.deepEqual(models, [{ id: "gemini-3.5-flash-lite", name: "Gemini 3.5 Flash-Lite" }]);
});

test("OpenAI-compatible gọi Base URL /models với bearer key", async () => {
  let request;
  const service = new ModelDiscoveryService(async (url, options) => {
    request = { url, options };
    return jsonResponse({ data: [{ id: "local-qwen", object: "model" }] });
  });

  const models = await service.list({
    provider: "openai-compatible",
    apiKey: "local-key",
    baseUrl: "http://127.0.0.1:11434/v1/",
  });
  assert.equal(request.url, "http://127.0.0.1:11434/v1/models");
  assert.equal(request.options.headers.authorization, "Bearer local-key");
  assert.deepEqual(models, [{ id: "local-qwen", name: "local-qwen" }]);
});

test("DeepL Free kiểm tra key qua endpoint usage và trả engine mt", async () => {
  let request;
  const service = new ModelDiscoveryService(async (url, options) => {
    request = { url, options };
    return jsonResponse({ character_count: 12, character_limit: 500000 });
  });

  const models = await service.list({ provider: "deepl", apiKey: "test-key:fx" });
  assert.equal(request.url, "https://api-free.deepl.com/v2/usage");
  assert.equal(request.options.headers.authorization, "DeepL-Auth-Key test-key:fx");
  assert.deepEqual(models, [{ id: "mt", name: "DeepL Machine Translation" }]);
});

test("lỗi xác thực provider được chuẩn hóa", async () => {
  const service = new ModelDiscoveryService(async () => jsonResponse({ error: "bad key" }, 401));
  await assert.rejects(
    () => service.list({ provider: "deepseek", apiKey: "bad" }),
    /API key deepseek không hợp lệ/,
  );
});
