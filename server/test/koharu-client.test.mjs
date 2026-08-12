import assert from "node:assert/strict";
import test from "node:test";
import { KoharuClient } from "../src/koharu/client.mjs";

function jsonResponse(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

test("Koharu nhận cấu hình DeepL, secret và model mt", async () => {
  const requests = [];
  const client = new KoharuClient("http://koharu.test/api/v1", 1000, async (url, options = {}) => {
    requests.push({ url, options });
    if (url.endsWith("/config") && !options.method) {
      return jsonResponse({ providers: [{ id: "gemini", apiKey: "[REDACTED]" }] });
    }
    if (url.endsWith("/llm/current") && !options.method) {
      return jsonResponse({
        status: "ready",
        target: { kind: "provider", providerId: "deepl", modelId: "mt" },
      });
    }
    return new Response(null, { status: 204 });
  });

  await client.configureProvider({
    provider: "deepl",
    model: "mt",
    apiKey: "secret:fx",
    baseUrl: "https://api-free.deepl.com",
  });

  const configPatch = requests.find((request) => request.url.endsWith("/config") && request.options.method === "PATCH");
  const secretPut = requests.find((request) => request.url.endsWith("/config/providers/deepl/secret"));
  const llmPut = requests.find((request) => request.url.endsWith("/llm/current") && request.options.method === "PUT");
  assert.deepEqual(JSON.parse(configPatch.options.body).providers.at(-1), {
    id: "deepl",
    baseUrl: "https://api-free.deepl.com",
    apiKey: "[REDACTED]",
  });
  assert.deepEqual(JSON.parse(secretPut.options.body), { secret: "secret:fx" });
  assert.deepEqual(JSON.parse(llmPut.options.body).target, {
    kind: "provider",
    modelId: "mt",
    providerId: "deepl",
  });
});
