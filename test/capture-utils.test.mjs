import assert from "node:assert/strict";
import test from "node:test";
import { calculateCaptureCrop } from "../extension/capture-utils.js";

test("crop quy đổi CSS pixel sang screenshot pixel", () => {
  assert.deepEqual(
    calculateCaptureCrop(
      { left: 100, top: 50, right: 500, bottom: 650, viewportWidth: 1000, viewportHeight: 800 },
      2000,
      1600,
    ),
    { sx: 200, sy: 100, sw: 800, sh: 1200 },
  );
});

test("crop cắt phần nằm ngoài viewport", () => {
  assert.deepEqual(
    calculateCaptureCrop(
      { left: -20, top: 100, right: 700, bottom: 900, viewportWidth: 600, viewportHeight: 800 },
      1200,
      1600,
    ),
    { sx: 0, sy: 200, sw: 1200, sh: 1400 },
  );
});

test("crop từ chối vùng không nhìn thấy", () => {
  assert.throws(
    () => calculateCaptureCrop(
      { left: 0, top: 900, right: 100, bottom: 1000, viewportWidth: 600, viewportHeight: 800 },
      1200,
      1600,
    ),
    /viewport/,
  );
});
