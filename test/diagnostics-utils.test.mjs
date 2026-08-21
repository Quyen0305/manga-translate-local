import assert from "node:assert/strict";
import test from "node:test";
import {
  computeModeLabel,
  cudaStatusLabel,
  engineStateLabel,
  formatBytes,
  formatDuration,
  recoveryIssueLabel,
  recoveryStatusLabel,
  runtimeIssueLabel,
  runtimeStatusLabel,
} from "../extension/diagnostics-utils.js";

test("dung lượng được định dạng ổn định", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(1536), "2 KB");
  assert.equal(formatBytes(5 * 1024 ** 3), "5.00 GB");
});

test("diagnostics phân biệt GPU và CPU fallback", () => {
  assert.equal(computeModeLabel({ activeMode: "gpu" }), "GPU");
  assert.equal(computeModeLabel({ activeMode: "cpu-fallback" }), "CPU fallback");
  assert.equal(cudaStatusLabel({ status: "ready", driverCudaVersion: "13.2" }), "Sẵn sàng 13.2");
  assert.equal(cudaStatusLabel({ status: "incompatible" }), "Không tương thích");
});

test("lifecycle hiển thị trạng thái và thời gian ngủ", () => {
  assert.equal(engineStateLabel({ state: "sleeping" }), "Đang ngủ");
  assert.equal(engineStateLabel({ state: "loading" }), "Đang nạp");
  assert.equal(engineStateLabel({ state: "busy" }), "Đang xử lý");
  assert.equal(formatDuration(59), "59 giây");
  assert.equal(formatDuration(61), "2 phút");
  assert.equal(formatDuration(3600), "1 giờ");
});

test("runtime health phân biệt kho đầy đủ và gói cài dở", () => {
  assert.equal(runtimeStatusLabel({ status: "ready" }), "Đầy đủ");
  assert.equal(runtimeStatusLabel({ status: "attention" }), "Cần dọn gói dở");
  assert.equal(runtimeStatusLabel({ status: "incomplete" }), "Chưa đầy đủ");
  assert.equal(runtimeStatusLabel({ status: "missing" }), "Chưa cài");
  assert.equal(
    runtimeIssueLabel({
      status: "incomplete",
      components: [{ label: "Torch", status: "missing", optional: false }],
    }),
    "Runtime cần xử lý: Torch.",
  );
});

test("recovery hiển thị CPU fallback và watchdog service", () => {
  assert.equal(
    recoveryStatusLabel({ recovery: { retryGpuAvailable: true } }, { status: "running" }),
    "CPU fallback",
  );
  assert.equal(
    recoveryStatusLabel({}, { status: "running", restartCount: 2 }),
    "Đã phục hồi 2 lần",
  );
  assert.match(
    recoveryIssueLabel(
      { fallbackReason: "CUDA PTX không tương thích", recovery: { retryGpuAvailable: true } },
      {},
    ),
    /CUDA PTX/,
  );
});
