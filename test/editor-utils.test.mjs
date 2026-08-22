import assert from "node:assert/strict";
import test from "node:test";

await import("../extension/editor-utils.js");

const { createLatestTaskQueue, normalizeStyle, segmentRect } = globalThis.MangaEditorUtils;

test("tọa độ scene được chiếu đúng lên ảnh trong viewport", () => {
  assert.deepEqual(
    segmentRect(
      { bounds: { x: 100, y: 200, width: 300, height: 100 } },
      { left: 20, top: 30, width: 500, height: 1000 },
      1000,
      2000,
    ),
    { left: 70, top: 130, width: 150, height: 50 },
  );
});

test("kiểu chữ editor được giới hạn trước khi gửi engine", () => {
  assert.deepEqual(normalizeStyle({
    fontFamily: "Arial",
    fontSize: 900,
    autoFit: false,
    fontWeight: 735,
    italic: true,
    alignment: "invalid",
    lineHeight: 0.2,
  }), {
    fontFamily: "Arial",
    fontSize: 256,
    autoFit: false,
    fontWeight: 700,
    italic: true,
    alignment: "auto",
    lineHeight: 0.8,
  });
});

test("cỡ chữ tự động không bị biến thành giá trị tối thiểu", () => {
  assert.equal(normalizeStyle({ fontSize: null, autoFit: true }).fontSize, null);
});

test("đồng bộ editor chạy tuần tự và bỏ qua bản nháp trung gian", async () => {
  const calls = [];
  let active = 0;
  let maxActive = 0;
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const queue = createLatestTaskQueue(async (value) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    calls.push(value);
    if (value === "đầu") await firstGate;
    active -= 1;
  });

  queue.schedule("đầu", 1000);
  const first = queue.flush();
  await Promise.resolve();
  queue.schedule("giữa");
  queue.schedule("mới nhất");
  releaseFirst();
  await first;
  await queue.drain();

  assert.deepEqual(calls, ["đầu", "mới nhất"]);
  assert.equal(maxActive, 1);
  assert.equal(queue.isIdle(), true);
});
