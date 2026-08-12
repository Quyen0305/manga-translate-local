import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { KoharuError, TimeoutError } from "../shared/errors.mjs";

export class KoharuProcessManager {
  constructor(config, logger, fetchImpl = fetch) {
    this.config = config;
    this.logger = logger;
    this.fetch = fetchImpl;
    this.child = null;
    this.startPromise = null;
  }

  get baseUrl() {
    return `http://${this.config.host}:${this.config.port}/api/v1`;
  }

  async isReady() {
    try {
      const response = await this.fetch(`${this.baseUrl}/meta`, {
        signal: AbortSignal.timeout(1500),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async ensureRunning() {
    if (this.config.mode === "passthrough") return;
    if (await this.isReady()) return;
    if (!this.startPromise) {
      this.startPromise = this.start().finally(() => {
        this.startPromise = null;
      });
    }
    return this.startPromise;
  }

  async start() {
    const args = ["--headless", "--host", this.config.host, "--port", String(this.config.port)];
    if (this.config.cpu) args.push("--cpu");

    this.logger.info("Đang khởi động Koharu headless", {
      executable: this.config.executable,
      port: this.config.port,
      cpu: this.config.cpu,
    });
    this.child = spawn(this.config.executable, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.child.stdout.on("data", (chunk) => {
      const message = chunk.toString().trim();
      if (message) this.logger.info("koharu", { output: message.slice(0, 1000) });
    });
    this.child.stderr.on("data", (chunk) => {
      const message = chunk.toString().trim();
      if (message) this.logger.warn("koharu", { output: message.slice(0, 1000) });
    });
    this.child.once("exit", (code) => {
      this.logger.warn("Koharu đã dừng", { code });
      this.child = null;
    });

    const startedAt = Date.now();
    while (Date.now() - startedAt < this.config.startTimeoutMs) {
      if (await this.isReady()) {
        this.logger.info("Koharu đã sẵn sàng", { baseUrl: this.baseUrl });
        return;
      }
      if (this.child?.exitCode !== null && this.child?.exitCode !== undefined) {
        throw new KoharuError(`Koharu dừng với mã ${this.child.exitCode}`);
      }
      await delay(500);
    }
    throw new TimeoutError("Koharu khởi động quá thời gian cho phép");
  }

  stop() {
    if (this.child && this.child.exitCode === null) this.child.kill();
  }
}
