import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = Number.parseInt(process.env.FIXTURE_PORT || "4173", 10);
const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".css": "text/css; charset=utf-8",
};

http.createServer(async (req, res) => {
  try {
    const requestPath = req.url === "/" ? "/test/fixtures/web-robustness.html" : req.url.split("?")[0];
    const absolutePath = path.resolve(projectRoot, `.${requestPath}`);
    if (!absolutePath.startsWith(projectRoot + path.sep)) throw new Error("invalid path");
    const body = await fs.readFile(absolutePath);
    res.writeHead(200, {
      "content-type": contentTypes[path.extname(absolutePath)] || "application/octet-stream",
      "cache-control": "no-store",
    });
    res.end(body);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
}).listen(port, "127.0.0.1", () => {
  process.stdout.write(`Fixture server: http://127.0.0.1:${port}\n`);
});
