import fs from "node:fs";
import { ValidationError } from "./shared/errors.mjs";

function integer(name, fallback, minimum = 1) {
  const raw = process.env[name];
  const value = raw === undefined ? fallback : Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < minimum) {
    throw new ValidationError(`${name} phải là số nguyên >= ${minimum}`);
  }
  return value;
}

function boolean(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  if (["1", "true", "yes"].includes(raw.toLowerCase())) return true;
  if (["0", "false", "no"].includes(raw.toLowerCase())) return false;
  throw new ValidationError(`${name} phải là true hoặc false`);
}

export function loadConfig() {
  const mode = process.env.KOHARU_MODE ?? "real";
  if (!["real", "passthrough"].includes(mode)) {
    throw new ValidationError("KOHARU_MODE phải là real hoặc passthrough");
  }

  const config = {
    service: {
      host: process.env.SERVICE_HOST ?? "127.0.0.1",
      port: integer("SERVICE_PORT", 40721),
      maxImageBytes: integer("MAX_IMAGE_BYTES", 40 * 1024 * 1024),
    },
    koharu: {
      mode,
      executable: process.env.KOHARU_EXE ?? "D:\\koharu\\koharu.exe",
      host: process.env.KOHARU_HOST ?? "127.0.0.1",
      port: integer("KOHARU_PORT", 40722),
      cpu: boolean("KOHARU_CPU", false),
      startTimeoutMs: integer("KOHARU_START_TIMEOUT_MS", 120_000),
      jobTimeoutMs: integer("KOHARU_JOB_TIMEOUT_MS", 900_000),
    },
  };

  if (mode === "real" && !fs.existsSync(config.koharu.executable)) {
    throw new ValidationError(`Không tìm thấy Koharu tại ${config.koharu.executable}`);
  }
  return config;
}
