// renderer/src/lib/recurrence.ts
//
// 循环规则 renderer 侧（创建对话框序列化 + 展示人性化）。
// 规则编码契约与 electron/src/main/task/recurrence.ts 的 nextRun 对齐
// （双端独立声明，同 TaskStatus 镜像先例）；改格式两边同步。
export interface RecurrencePreset {
  kind: 'once' | 'every' | 'daily' | 'weekly';
  everyN?: number;
  everyUnit?: 'm' | 'h' | 'd';
  time?: string;
  weekday?: number;
}

const WEEKDAY_LABEL = ['日', '一', '二', '三', '四', '五', '六'];
const UNIT_LABEL: Record<string, string> = { m: '分钟', h: '小时', d: '天' };

export function serializeRecurrence(p: RecurrencePreset): string | null {
  if (p.kind === 'once') return null;
  if (p.kind === 'every' && p.everyN && p.everyUnit) return `every:${p.everyN}${p.everyUnit}`;
  if (p.kind === 'daily' && p.time) return `daily@${p.time}`;
  if (p.kind === 'weekly' && p.weekday !== undefined && p.time) return `weekly@${p.weekday},${p.time}`;
  return null;
}

export function humanizeRecurrence(rule: string): string {
  // 捕获组索引访问（noUncheckedIndexedAccess 下为 string | undefined）；
  // 正则匹配后必存在，?? '' 仅作 TS 兜底，运行时不触发（regex 命中）——同 electron 侧先例。
  const ev = /^every:(\d+)([mhd])$/.exec(rule);
  if (ev && UNIT_LABEL[ev[2] ?? '']) return `每 ${ev[1]} ${UNIT_LABEL[ev[2] ?? '']}`;
  const dv = /^daily@(\d{1,2}:\d{2})$/.exec(rule);
  if (dv) return `每天 ${dv[1]}`;
  const wv = /^weekly@(\d),(\d{1,2}:\d{2})$/.exec(rule);
  if (wv && WEEKDAY_LABEL[Number(wv[1])]) return `每周${WEEKDAY_LABEL[Number(wv[1])]} ${wv[2]}`;
  return rule;
}
