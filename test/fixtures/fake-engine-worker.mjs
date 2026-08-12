import fs from "node:fs/promises";
import readline from "node:readline";

process.stdout.write(`${JSON.stringify({
  type: "ready",
  ok: true,
  version: "test",
  koharuVersion: "0.61.2",
})}\n`);

const lines = readline.createInterface({ input: process.stdin });
for await (const line of lines) {
  const request = JSON.parse(line);
  if (request.filename.includes("fail")) {
    process.stdout.write(`${JSON.stringify({
      id: request.id,
      type: "result",
      ok: false,
      error: { code: "PIPELINE_FAILED", message: "fake pipeline failure" },
    })}\n`);
    continue;
  }
  await fs.copyFile(request.inputPath, request.outputPath);
  process.stdout.write(`${JSON.stringify({
    id: request.id,
    type: "result",
    ok: true,
    contentType: "image/webp",
  })}\n`);
}
