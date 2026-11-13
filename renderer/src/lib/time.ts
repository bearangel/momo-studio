// renderer/src/lib/time.ts
//
// 时间格式化单源（2026-11-13 自 MessageFrame 下沉）：消息气泡与进度折叠卡共用，
// 消除 lib→components 反向依赖（progress-segment 此前 import components/im/MessageFrame）。

/** epoch ms → HH:mm（本地时区）。2026-11-11 起导出共享：lib/progress-segment 进度折叠卡单源复用 */
export function formatHHmm(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
