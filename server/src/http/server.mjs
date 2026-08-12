import crypto from "node:crypto";
import http from "node:http";
import { AppError, ValidationError } from "../shared/errors.mjs";

function setCors(req, res) {
  const origin = req.headers.origin;
  if (origin && (origin.startsWith("chrome-extension://") || /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin))) {
    res.setHeader("access-control-allow-origin", origin);
    res.setHeader("vary", "origin");
  }
  res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
  res.setHeader(
    "access-control-allow-headers",
    "content-type,x-mt-provider,x-mt-model,x-mt-api-key,x-mt-base-url,x-mt-target-language,x-mt-system-prompt,x-mt-filename",
  );
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("cache-control", "no-store");
}

async function readBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new AppError("Ảnh vượt quá giới hạn dung lượng", "PAYLOAD_TOO_LARGE", 413);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function header(req, name, fallback = "") {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] ?? fallback : value ?? fallback;
}

function json(res, status, body) {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": data.length });
  res.end(data);
}

export function createHttpServer({ config, translationService, modelDiscoveryService, processManager, logger }) {
  return http.createServer(async (req, res) => {
    const requestId = header(req, "x-request-id", crypto.randomUUID());
    const startedAt = Date.now();
    res.setHeader("x-request-id", requestId);
    setCors(req, res);

    try {
      if (req.method === "OPTIONS") {
        res.writeHead(204);
        return res.end();
      }
      if (req.method === "GET" && req.url === "/health") {
        const koharuReady = config.koharu.mode === "passthrough" || await processManager.isReady();
        return json(res, 200, {
          status: "ok",
          mode: config.koharu.mode,
          koharu: koharuReady ? "ready" : "stopped",
          version: "0.6.0",
        });
      }
      if (req.method === "GET" && req.url === "/ready") {
        const ready = config.koharu.mode === "passthrough" || await processManager.isReady();
        return json(res, ready ? 200 : 503, { status: ready ? "ready" : "not_ready" });
      }
      if (req.method === "POST" && req.url === "/api/v1/models") {
        const models = await modelDiscoveryService.list({
          provider: header(req, "x-mt-provider"),
          apiKey: header(req, "x-mt-api-key"),
          baseUrl: header(req, "x-mt-base-url"),
        });
        return json(res, 200, { models });
      }
      if (req.method === "POST" && req.url === "/api/v1/translate-image") {
        const contentType = header(req, "content-type", "image/png").split(";")[0];
        if (!contentType.startsWith("image/")) throw new ValidationError("Nội dung gửi lên không phải ảnh");
        const image = await readBody(req, config.service.maxImageBytes);
        if (!image.length) throw new ValidationError("Ảnh rỗng");

        const result = await translationService.translate({
          requestId,
          image,
          contentType,
          filename: header(req, "x-mt-filename", `page-${Date.now()}.png`),
          settings: {
            provider: header(req, "x-mt-provider"),
            model: header(req, "x-mt-model"),
            apiKey: header(req, "x-mt-api-key"),
            baseUrl: header(req, "x-mt-base-url"),
            targetLanguage: header(req, "x-mt-target-language"),
            systemPrompt: decodeURIComponent(header(req, "x-mt-system-prompt")),
          },
        });
        res.writeHead(200, {
          "content-type": result.contentType,
          "content-length": result.bytes.length,
          "x-mt-cache": "miss",
        });
        return res.end(result.bytes);
      }
      throw new AppError("Không tìm thấy endpoint", "NOT_FOUND", 404);
    } catch (error) {
      const known = error instanceof AppError;
      const status = known ? error.status : 500;
      logger.error("Request thất bại", {
        requestId,
        method: req.method,
        path: req.url,
        status,
        code: known ? error.code : "INTERNAL_ERROR",
        error: error.message,
        durationMs: Date.now() - startedAt,
      });
      if (!res.headersSent) {
        json(res, status, {
          error: {
            code: known ? error.code : "INTERNAL_ERROR",
            message: known ? error.message : "Lỗi nội bộ local service",
            requestId,
          },
        });
      } else res.destroy();
    }
  });
}
