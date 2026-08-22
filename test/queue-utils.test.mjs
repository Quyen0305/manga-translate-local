import assert from "node:assert/strict";
import test from "node:test";

await import("../extension/queue-utils.js");

const {
  isKnownReaderImage,
  queueOwnsTarget,
  queueSummary,
  readerAdapter,
  readerSessionKey,
  sortQueueItems,
  stageLabel,
} = globalThis.MangaQueueUtils;

test("hàng đợi ưu tiên ảnh đang nhìn thấy rồi tới ảnh gần viewport", () => {
  const items = [
    { id: "far", rect: { top: 2400, bottom: 3000, documentTop: 2400 } },
    { id: "visible-low", rect: { top: 500, bottom: 900, documentTop: 500 } },
    { id: "near", rect: { top: 900, bottom: 1500, documentTop: 900 } },
    { id: "visible-center", rect: { top: 200, bottom: 700, documentTop: 200 } },
  ];
  assert.deepEqual(
    sortQueueItems(items, 800).map((item) => item.id),
    ["visible-center", "visible-low", "near", "far"],
  );
});

test("nhãn tiến độ phản ánh stage và trạng thái tải model", () => {
  assert.equal(stageLabel("detection", "running"), "Nhận diện");
  assert.equal(stageLabel("ocr", "loading"), "Nạp ocr");
  assert.equal(stageLabel("visual-context", "running"), "Ngữ cảnh ảnh");
  assert.equal(stageLabel("rendering", "finished"), "Dựng ảnh xong");
});

test("tổng kết hàng đợi tính cả lỗi và tác vụ hủy", () => {
  assert.deepEqual(
    queueSummary({ completed: 3, failed: 1, cancelledCount: 2, total: 8 }),
    { processed: 6, completed: 3, failed: 1, cancelled: 2, total: 8 },
  );
});

test("tổng kết hàng đợi chấp nhận trạng thái rỗng", () => {
  assert.deepEqual(globalThis.MangaQueueUtils.queueSummary(null), {
    processed: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
    total: 0,
  });
});

test("adapter MangaDex nhận diện ảnh reader theo URL và kích thước", () => {
  const pageUrl = "https://mangadex.org/chapter/example/2";
  assert.equal(readerAdapter(pageUrl), "mangadex");
  assert.equal(isKnownReaderImage({
    pageUrl,
    sourceUrl: "https://uploads.mangadex.org/data/hash/page-1.jpg",
    tagName: "img",
    width: 720,
    height: 1080,
  }), true);
  assert.equal(isKnownReaderImage({
    pageUrl: "https://example.org/chapter/1",
    sourceUrl: "https://example.org/page.jpg",
    tagName: "img",
    width: 720,
    height: 1080,
  }), false);
});

test("khóa phiên MangaDex không đổi khi cuộn sang số trang khác", () => {
  const chapter = "30e8a046-ed96-4629-bfed-f4525b602700";
  assert.equal(
    readerSessionKey(`https://mangadex.org/chapter/${chapter}/1`),
    readerSessionKey(`https://mangadex.org/chapter/${chapter}/14`),
  );
  assert.notEqual(
    readerSessionKey(`https://mangadex.org/chapter/${chapter}/2`),
    readerSessionKey("https://mangadex.org/chapter/another-chapter/2"),
  );
  assert.notEqual(
    readerSessionKey("https://example.org/reader/1"),
    readerSessionKey("https://example.org/reader/2"),
  );
});

test("ảnh thuộc queue vẫn được giữ khi reader tạm tháo khỏi DOM", () => {
  const run = { itemIds: ["page-1", "page-2"] };
  assert.equal(queueOwnsTarget(run, "page-2"), true);
  assert.equal(queueOwnsTarget(run, "page-3"), false);
  assert.equal(queueOwnsTarget(null, "page-1"), false);
});
