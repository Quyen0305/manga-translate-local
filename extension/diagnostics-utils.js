export function formatBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const amount = bytes / (1024 ** index);
  const precision = index >= 3 ? 2 : index >= 2 ? 1 : 0;
  return `${amount.toFixed(precision)} ${units[index]}`;
}

export function computeModeLabel(engine = {}) {
  if (engine.activeMode === "cpu-fallback") return "CPU fallback";
  if (engine.activeMode === "cpu") return "CPU";
  if (engine.activeMode === "gpu") return "GPU";
  return "Chưa xác định";
}

export function cudaStatusLabel(cuda = {}) {
  if (cuda.status === "ready") return cuda.driverCudaVersion ? `Sẵn sàng ${cuda.driverCudaVersion}` : "Sẵn sàng";
  if (cuda.status === "incompatible") return "Không tương thích";
  if (cuda.status === "cpu") return "Không sử dụng";
  return "Không phát hiện";
}

export function engineStateLabel(engine = {}) {
  if (engine.state === "busy") return "Đang xử lý";
  if (engine.state === "loading") return "Đang nạp";
  if (engine.state === "ready") return "Sẵn sàng";
  return "Đang ngủ";
}

export function formatDuration(seconds) {
  const value = Math.max(0, Math.floor(Number(seconds) || 0));
  if (value < 60) return `${value} giây`;
  const minutes = Math.ceil(value / 60);
  if (minutes < 60) return `${minutes} phút`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder ? `${hours} giờ ${remainder} phút` : `${hours} giờ`;
}

export function runtimeStatusLabel(runtime = {}) {
  if (runtime.status === "ready") return "Đầy đủ";
  if (runtime.status === "attention") return "Cần dọn gói dở";
  if (runtime.status === "incomplete") return "Chưa đầy đủ";
  return "Chưa cài";
}

export function runtimeIssueLabel(runtime = {}) {
  if (runtime.status === "attention") return "Phát hiện gói cài đặt chưa hoàn tất.";
  const invalid = (runtime.components || [])
    .filter((component) => !component.optional && component.status !== "ready")
    .map((component) => component.message ? `${component.label}: ${component.message}` : component.label);
  if (invalid.length) return `Runtime cần xử lý: ${invalid.join("; ")}.`;
  if (runtime.status === "ready") return "Các thành phần bắt buộc đã sẵn sàng.";
  return "Runtime sẽ được tải khi nạp engine lần đầu.";
}

export function recoveryStatusLabel(engine = {}, service = {}) {
  if (engine.recovery?.retryGpuAvailable) return "CPU fallback";
  if (service.status === "recovering") return "Đang phục hồi service";
  if (Number(service.restartCount || 0) > 0) return `Đã phục hồi ${service.restartCount} lần`;
  if (engine.recovery?.lastAction === "gpu-restored") return "GPU đã phục hồi";
  return "Sẵn sàng";
}

export function recoveryIssueLabel(engine = {}, service = {}) {
  if (engine.recovery?.retryGpuAvailable) {
    return engine.fallbackReason || "Engine đang dùng CPU fallback; có thể thử lại GPU sau khi sửa driver/runtime.";
  }
  if (service.lastFailure) return `Service gần nhất: ${service.lastFailure}`;
  const recovery = engine.recovery || {};
  if (recovery.lastErrorCode) return `Lỗi gần nhất: ${recovery.lastErrorCode}.`;
  return "Watchdog service và cơ chế fallback đang hoạt động.";
}
