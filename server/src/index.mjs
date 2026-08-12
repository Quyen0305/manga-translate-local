import { loadConfig } from "./config.mjs";
import { createHttpServer } from "./http/server.mjs";
import { KoharuClient } from "./koharu/client.mjs";
import { KoharuProcessManager } from "./koharu/process-manager.mjs";
import { ModelDiscoveryService } from "./model-discovery/service.mjs";
import { logger } from "./shared/logger.mjs";
import { TranslationService } from "./translation/service.mjs";

const config = loadConfig();
const processManager = new KoharuProcessManager(config.koharu, logger);
const koharuClient = new KoharuClient(processManager.baseUrl, config.koharu.jobTimeoutMs);
const modelDiscoveryService = new ModelDiscoveryService();
const translationService = new TranslationService({
  mode: config.koharu.mode,
  processManager,
  koharuClient,
  logger,
});
const server = createHttpServer({
  config,
  translationService,
  modelDiscoveryService,
  processManager,
  logger,
});

server.listen(config.service.port, config.service.host, () => {
  logger.info("Manga Translate local service đã chạy", {
    url: `http://${config.service.host}:${config.service.port}`,
    mode: config.koharu.mode,
  });
});

function shutdown(signal) {
  logger.info("Đang dừng local service", { signal });
  server.close(() => {
    processManager.stop();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
