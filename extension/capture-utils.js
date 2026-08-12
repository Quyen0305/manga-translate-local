export function calculateCaptureCrop(capture, bitmapWidth, bitmapHeight) {
  const viewportWidth = number(capture.viewportWidth, "viewportWidth");
  const viewportHeight = number(capture.viewportHeight, "viewportHeight");
  const scaleX = bitmapWidth / viewportWidth;
  const scaleY = bitmapHeight / viewportHeight;
  const left = Math.max(0, number(capture.left, "left"));
  const top = Math.max(0, number(capture.top, "top"));
  const right = Math.min(viewportWidth, number(capture.right, "right"));
  const bottom = Math.min(viewportHeight, number(capture.bottom, "bottom"));

  if (right <= left || bottom <= top) throw new Error("Vùng ảnh không nằm trong viewport");

  const sx = Math.max(0, Math.round(left * scaleX));
  const sy = Math.max(0, Math.round(top * scaleY));
  const sw = Math.min(bitmapWidth - sx, Math.max(1, Math.round((right - left) * scaleX)));
  const sh = Math.min(bitmapHeight - sy, Math.max(1, Math.round((bottom - top) * scaleY)));
  return { sx, sy, sw, sh };
}

function number(value, name) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${name} không hợp lệ`);
  return parsed;
}
