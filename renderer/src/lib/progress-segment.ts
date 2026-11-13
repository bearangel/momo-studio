// renderer/src/lib/progress-segment.ts
//
// 【进度分段】行识别 / 解析 / 分组（2026-11-11 展示优化）。
// 主进程 router-service.maybeEmitProgressSegment 每条 dispatch 链 ~2 分钟落一条
// sender='system' 的顶层进度行，长任务 30+ 条刷屏。本层在 MessageList 渲染前
// 把连续进度行折叠为一组（ProgressTimelineCard 单卡承载）。纯函数，无副作用。
import type { ImMessage } from '../ipc/types';
// 单源复用 lib/time 的 HH:mm 格式化（2026-11-13 下沉），消除 lib→components 反向依赖
import { formatHHmm } from './time';

/** 进度行 body 固定前缀（对齐主进程模板常量；renderer 侧只识别不生成） */
export const PROGRESS_SEGMENT_PREFIX = '【进度分段】';

/** 是否进度分段行：sender='system' 且 body 以前缀开头 */
export function isProgressSegmentMessage(msg: ImMessage): boolean {
  return msg.sender === 'system' && msg.body.startsWith(PROGRESS_SEGMENT_PREFIX);
}

/** 进度行结构化数据（解析自 body 模板） */
export interface ProgressSegmentData {
  label: string;
  toolCalls: number;
  changes: number;
}

// 对齐主进程模板：`【进度分段】子任务 ${label} 进行中 · 工具调用累计 ${n} 次 · 文件变更累计 ${m} 处`
// label 非贪婪匹配：任务标题本身含「 进行中 · 工具调用累计 」等锚点子串时会提前截断——
// 病态标题下仅展示文本偏短，属可接受退化（数字段与整体格式不受影响）。
const PROGRESS_BODY_RE =
  /^【进度分段】子任务 (.+?) 进行中 · 工具调用累计 (\d+) 次 · 文件变更累计 (\d+) 处$/;

/** 解析进度行 body；格式漂移返回 null（调用方降级展示原始 body 切片，不抛错） */
export function parseProgressSegmentBody(body: string): ProgressSegmentData | null {
  const m = PROGRESS_BODY_RE.exec(body);
  // noUncheckedIndexedAccess：捕获组下标访问需显式判 undefined（正则命中时组必在）
  if (m === null || m[1] === undefined || m[2] === undefined || m[3] === undefined) return null;
  return { label: m[1], toolCalls: Number(m[2]), changes: Number(m[3]) };
}

/** 渲染项：普通消息单条透传 / 连续进度行折叠组 */
export type ProgressRenderItem =
  | { kind: 'single'; message: ImMessage }
  | { kind: 'progress'; messages: ImMessage[] };

/**
 * 连续进度行折叠分组：顺序遍历，进度行的连续段（≥1，保持原数组时间序）收敛为
 * 一个 progress 组；其余消息原样 single 透传。分段仅被非进度消息打断。
 */
export function groupProgressSegments(visible: ImMessage[]): ProgressRenderItem[] {
  const items: ProgressRenderItem[] = [];
  let run: ImMessage[] = [];
  const flushRun = (): void => {
    if (run.length > 0) {
      items.push({ kind: 'progress', messages: run });
      run = [];
    }
  };
  for (const msg of visible) {
    if (isProgressSegmentMessage(msg)) {
      run.push(msg);
    } else {
      flushRun();
      items.push({ kind: 'single', message: msg });
    }
  }
  flushRun();
  return items;
}

/** epoch ms → 本地 HH:mm（零填充）；单源委托 lib/time.formatHHmm */
export function formatProgressTime(ts: number): string {
  return formatHHmm(ts);
}
