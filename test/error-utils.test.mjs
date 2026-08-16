import assert from "node:assert/strict";
import test from "node:test";
import { createErrorRecord, diagnosticHint, mergeErrorLog } from "../extension/error-utils.js";

test("bản ghi lỗi loại query và không giữ trường nhạy cảm ngoài schema", () => {
  const record = createErrorRecord({
    code: "ENGINE_ERROR",
    message: "Pipeline failed",
    pageUrl: "https://reader.test/chapter/1?token=secret#page-2",
    operation: "TRANSLATE_IMAGE",
    provider: "deepl",
    apiKey: "must-not-be-stored",
  }, Date.parse("2026-08-12T12:00:00Z"));
  assert.equal(record.pageUrl, "https://reader.test/chapter/1");
  assert.equal(record.provider, "deepl");
  assert.equal("apiKey" in record, false);
});

test("lịch sử lỗi giới hạn 20 mục và gộp lỗi liên tiếp", () => {
  const first = createErrorRecord({ code: "TIMEOUT", message: "too slow" }, 1000);
  const duplicate = createErrorRecord({ code: "TIMEOUT", message: "too slow" }, 2000);
  const deduplicated = mergeErrorLog([first], duplicate);
  assert.equal(deduplicated.length, 1);
  assert.equal(deduplicated[0].timestamp, duplicate.timestamp);

  let log = [];
  for (let index = 0; index < 25; index += 1) {
    log = mergeErrorLog(log, createErrorRecord({ code: `E_${index}`, message: `error ${index}` }, 5000 + index * 2000));
  }
  assert.equal(log.length, 20);
  assert.equal(log[0].code, "E_24");
});

test("gợi ý lỗi provider hướng người dùng kiểm tra API", () => {
  assert.match(diagnosticHint("PROVIDER_API_ERROR"), /Authentication Key/);
});
