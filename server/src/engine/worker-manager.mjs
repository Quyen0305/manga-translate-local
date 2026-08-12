import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { EngineError, TimeoutError } from "../shared/errors.mjs";

export class EngineWorkerManager {
  constructor(config, logger, spawnImpl = spawn) {
    this.config = config;
    this.logger = logger;
    this.spawn = spawnImpl;
    this.child = null;
    this.ready = false;
    this.metadata = null;
    this.startPromise = null;
    this.pending = new Map();
  }

  async isReady() {
    return this.config.mode === "passthrough" || Boolean(this.ready && this.child?.exitCode === null);
  }

  async ensureRunning() {
    if (this.config.mode === "passthrough" || await this.isReady()) return;
    if (!this.startPromise) {
      this.startPromise = this.start().finally(() => {
        this.startPromise = null;
      });
    }
    return this.startPromise;
  }

  async start() {
    await fs.mkdir(this.config.dataDir, { recursive: true });
    const args = [
      ...(this.config.arguments ?? []),
      "--data-dir",
      this.config.dataDir,
      ...(this.config.cpu ? ["--cpu"] : []),
    ];
    this.logger.info("Đang khởi động manga-engine từ source Koharu", {
      executable: this.config.executable,
      cpu: this.config.cpu,
    });
    const child = this.spawn(this.config.executable, args, {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    this.ready = false;

    readline.createInterface({ input: child.stdout }).on("line", (line) => this.handleLine(line));
    child.stderr.on("data", (chunk) => {
      const message = chunk.toString().trim();
      if (message) this.logger.info("manga-engine", { output: message.slice(0, 2000) });
    });
    child.once("error", (error) => this.handleExit(new EngineError(
      `Không khởi động được manga-engine: ${error.message}`,
    )));
    child.once("exit", (code) => this.handleExit(new EngineError(`manga-engine đã dừng với mã ${code}`)));

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.readyWaiter = null;
        if (this.child === child && child.exitCode === null) child.kill();
        reject(new TimeoutError("manga-engine khởi động quá thời gian cho phép"));
      }, this.config.startTimeoutMs);
      this.readyWaiter = {
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
    });
  }

  handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.logger.warn("manga-engine trả dữ liệu không hợp lệ", { output: line.slice(0, 500) });
      return;
    }
    if (message.type === "ready") {
      this.ready = true;
      this.metadata = message;
      this.readyWaiter?.resolve();
      this.readyWaiter = null;
      this.logger.info("manga-engine đã sẵn sàng", {
        version: message.version,
        koharuVersion: message.koharuVersion,
      });
      return;
    }
    const pending = message.id && this.pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(message.id);
    if (message.ok) pending.resolve(message);
    else pending.reject(new EngineError(message.error?.message || "Pipeline manga-engine thất bại", 502, {
      engineCode: message.error?.code,
    }));
  }

  handleExit(error) {
    this.ready = false;
    this.child = null;
    this.readyWaiter?.reject(error);
    this.readyWaiter = null;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  async translate(job) {
    await this.ensureRunning();
    await fs.mkdir(this.config.workDir, { recursive: true });
    const jobDir = await fs.mkdtemp(path.join(this.config.workDir, "job-"));
    const inputPath = path.join(jobDir, safeFilename(job.filename));
    const outputPath = path.join(jobDir, "translated.webp");
    try {
      await fs.writeFile(inputPath, job.image);
      const result = await this.send({
        inputPath,
        outputPath,
        filename: job.filename,
        settings: job.settings,
      });
      return {
        bytes: await fs.readFile(outputPath),
        contentType: result.contentType || "image/webp",
      };
    } finally {
      await fs.rm(jobDir, { recursive: true, force: true });
    }
  }

  async send(payload) {
    if (!await this.isReady()) throw new EngineError("manga-engine chưa sẵn sàng");
    const id = crypto.randomUUID();
    const result = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new TimeoutError("Pipeline manga-engine chạy quá thời gian cho phép"));
      }, this.config.jobTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
    this.child.stdin.write(`${JSON.stringify({ id, ...payload })}\n`, (error) => {
      if (!error) return;
      const pending = this.pending.get(id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.reject(new EngineError(`Không gửi được tác vụ tới manga-engine: ${error.message}`));
    });
    return result;
  }

  stop() {
    if (this.child?.exitCode === null) this.child.kill();
  }
}

function safeFilename(value) {
  return String(value || "manga-page.png").replace(/[^a-zA-Z0-9._-]/g, "_").slice(-120)
    || "manga-page.png";
}
