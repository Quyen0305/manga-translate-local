import assert from "node:assert/strict";
import test from "node:test";
import { createHttpServer } from "../src/http/server.mjs";

const silentLogger = { info() {}, warn() {}, error() {} };

async function withServer(run) {
  const translationService = {
    async translate(job) {
      return { bytes: job.image, contentType: job.contentType };
    },
  };
  const engineManager = { async isReady() { return true; } };
  const modelDiscoveryService = {
    async list() {
      return [{ id: "model-from-api", name: "Model from API" }];
    },
  };
  const config = {
    service: { maxImageBytes: 1024 * 1024 },
    engine: { mode: "passthrough" },
  };
  const server = createHttpServer({
    config,
    translationService,
    modelDiscoveryService,
    engineManager,
    logger: silentLogger,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("health trả trạng thái service", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      status: "ok",
      mode: "passthrough",
      engine: "ready",
      engineSource: "koharu-0.61.2",
      version: "0.7.0",
    });
  });
});

test("models trả danh sách đã chuẩn hóa", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/v1/models`, {
      method: "POST",
      headers: { "x-mt-provider": "gemini", "x-mt-api-key": "test-key" },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      models: [{ id: "model-from-api", name: "Model from API" }],
    });
  });
});

test("translate-image giữ nguyên bytes trong adapter giả lập", async () => {
  await withServer(async (baseUrl) => {
    const image = Buffer.from([137, 80, 78, 71]);
    const response = await fetch(`${baseUrl}/api/v1/translate-image`, {
      method: "POST",
      headers: { "content-type": "image/png" },
      body: image,
    });
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), image);
  });
});

test("translate-image từ chối payload không phải ảnh", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/v1/translate-image`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "hello",
    });
    assert.equal(response.status, 422);
    const body = await response.json();
    assert.equal(body.error.code, "VALIDATION_ERROR");
  });
});
