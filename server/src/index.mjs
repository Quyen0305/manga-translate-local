import { loadConfig } from "./config.mjs";
import { EngineWorkerManager } from "./engine/worker-manager.mjs";
import { createHttpServer } from "./http/server.mjs";
import { ModelDiscoveryService } from "./model-discovery/service.mjs";
import { logger } from "./shared/logger.mjs";
import { TranslationService } from "./translation/service.mjs";

const config = loadConfig();
const engineManager = new EngineWorkerManager(config.engine, logger);
const modelDiscoveryService = new ModelDiscoveryService();
const translationService = new TranslationService({
  mode: config.engine.mode,
  engineManager,
  logger,
});
const server = createHttpServer({
  config,
  translationService,
  modelDiscoveryService,
  engineManager,
  logger,
});

server.listen(config.service.port, config.service.host, () => {
  logger.info("Manga Translate local service đã chạy", {
    url: `http://${config.service.host}:${config.service.port}`,
    mode: config.engine.mode,
  });
});

function shutdown(signal) {
  logger.info("Đang dừng local service", { signal });
  server.close(() => {
    engineManager.stop();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
