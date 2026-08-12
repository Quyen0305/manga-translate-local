import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ValidationError } from "./shared/errors.mjs";

const projectRoot = fileURLToPath(new URL("../..", import.meta.url));
const installedKoharuData = process.env.LOCALAPPDATA
  ? path.join(process.env.LOCALAPPDATA, "Koharu")
  : "";
const defaultEngineData = installedKoharuData
  && fs.existsSync(path.join(installedKoharuData, "runtime"))
  ? installedKoharuData
  : path.join(projectRoot, ".manga-translate", "engine-data");

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
  const mode = process.env.ENGINE_MODE ?? "real";
  if (!["real", "passthrough"].includes(mode)) {
    throw new ValidationError("ENGINE_MODE phải là real hoặc passthrough");
  }

  const config = {
    service: {
      host: process.env.SERVICE_HOST ?? "127.0.0.1",
      port: integer("SERVICE_PORT", 40721),
      maxImageBytes: integer("MAX_IMAGE_BYTES", 40 * 1024 * 1024),
    },
    engine: {
      mode,
      executable: process.env.ENGINE_EXE
        ?? path.join(projectRoot, "engine", "target", "release", "manga-engine.exe"),
      dataDir: process.env.ENGINE_DATA_DIR ?? defaultEngineData,
      workDir: process.env.ENGINE_WORK_DIR ?? path.join(projectRoot, ".manga-translate", "jobs"),
      cpu: boolean("ENGINE_CPU", false),
      startTimeoutMs: integer("ENGINE_START_TIMEOUT_MS", 900_000),
      jobTimeoutMs: integer("ENGINE_JOB_TIMEOUT_MS", 900_000),
      arguments: [],
    },
  };

  if (mode === "real" && !fs.existsSync(config.engine.executable)) {
    throw new ValidationError(
      `Không tìm thấy manga-engine tại ${config.engine.executable}. Hãy chạy npm run build:engine trước.`,
    );
  }
  return config;
}
