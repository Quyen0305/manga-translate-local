import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { EngineWorkerManager } from "../src/engine/worker-manager.mjs";

const projectRoot = fileURLToPath(new URL("../..", import.meta.url));
const fixture = path.join(projectRoot, "test", "fixtures", "fake-engine-worker.mjs");
const silentLogger = { info() {}, warn() {}, error() {} };

async function withManager(run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "manga-engine-test-"));
  const manager = new EngineWorkerManager({
    mode: "real",
    executable: process.execPath,
    arguments: [fixture],
    dataDir: path.join(root, "data"),
    workDir: path.join(root, "jobs"),
    cpu: true,
    startTimeoutMs: 5000,
    jobTimeoutMs: 5000,
  }, silentLogger);
  try {
    await run(manager, root);
  } finally {
    manager.stop();
    await fs.rm(root, { recursive: true, force: true });
  }
}

test("worker source-backed khởi động và trả ảnh kết quả", async () => {
  await withManager(async (manager, root) => {
    const source = Buffer.from([137, 80, 78, 71]);
    const result = await manager.translate({
      image: source,
      filename: "page.png",
      settings: {
        provider: "deepl",
        model: "mt",
        apiKey: "secret:fx",
        baseUrl: "",
        targetLanguage: "vi",
        systemPrompt: "",
      },
    });
    assert.deepEqual(result.bytes, source);
    assert.equal(result.contentType, "image/webp");
    assert.equal(await manager.isReady(), true);
    assert.deepEqual(await fs.readdir(path.join(root, "jobs")), []);
  });
});

test("worker chuyển lỗi pipeline thành ENGINE_ERROR", async () => {
  await withManager(async (manager) => {
    await assert.rejects(
      manager.translate({ image: Buffer.from("x"), filename: "fail.png", settings: {} }),
      (error) => error.code === "ENGINE_ERROR" && /fake pipeline failure/.test(error.message),
    );
  });
});

test("worker dừng tiến trình khi khởi động quá timeout", async () => {
  const child = {
    exitCode: null,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdin: new PassThrough(),
    once() {},
    killCalled: false,
    kill() { this.killCalled = true; },
  };
  const manager = new EngineWorkerManager({
    mode: "real",
    executable: "fake-engine",
    arguments: [],
    dataDir: await fs.mkdtemp(path.join(os.tmpdir(), "manga-engine-timeout-")),
    workDir: os.tmpdir(),
    cpu: false,
    startTimeoutMs: 20,
    jobTimeoutMs: 20,
  }, silentLogger, () => child);

  await assert.rejects(manager.ensureRunning(), (error) => error.code === "TIMEOUT");
  assert.equal(child.killCalled, true);
  await fs.rm(manager.config.dataDir, { recursive: true, force: true });
});
