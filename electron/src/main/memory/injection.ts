// electron/src/main/memory/injection.ts
// 常驻注入视图组装（spec §6.3）：预算合计 7500 字符（≈3000 token，分段 2000/3000/1000/500/1000；
// 中英混合近似——业界生产共识 2000-3000 token 常驻）。超预算按 updated_at 新者保留。
import type { MemoryEntry } from '../storage/memories/repo';

export interface SessionSummaryRow {
  summary: string;
  coveredUntil: number;
  updatedAt: number;
}

export interface PinnedParts {
  globalPinned: MemoryEntry[];
  workspacePinned: MemoryEntry[];
  sessionPinned: MemoryEntry[];  // 会话层常驻条目（子 agent sessionId=null 时为空数组）
  sessionSummary: SessionSummaryRow | null;
  catalog: MemoryEntry[];       // 非 pinned 检索型目录行（各路已 SQL 限量；合并后超 CATALOG_MAX_ROWS 计入截断）
}

export interface PinnedMemoryView {
  hint: string;
  truncatedCount: number;
  pinnedIds: string[];          // 实际注入的常驻条目 id（测试与统计用）
}

const BUDGET_GLOBAL = 2000;
const BUDGET_WORKSPACE = 3000;
const BUDGET_SESSION = 1000;
const BUDGET_SESSION_PINNED = 500;
const BUDGET_CATALOG = 1000;
/** 目录行单条预览长度 */
const CATALOG_PREVIEW = 30;
/** 目录行数上限（合并三路后限量；超出部分计入 truncatedCount，不静默丢弃） */
export const CATALOG_MAX_ROWS = 30;

function takeWithinBudget(entries: MemoryEntry[], budget: number): { kept: MemoryEntry[]; truncated: number } {
  let used = 0;
  const kept: MemoryEntry[] = [];
  for (const e of entries) {  // 调用方已按 updated_at DESC 排序
    if (used + e.content.length > budget) { continue; }
    kept.push(e);
    used += e.content.length;
  }
  return { kept, truncated: entries.length - kept.length };
}

function section(title: string, lines: string[]): string | null {
  if (lines.length === 0) return null;
  return `### ${title}\n${lines.join('\n')}`;
}

export function buildPinnedView(parts: PinnedParts): PinnedMemoryView {
  const g = takeWithinBudget(parts.globalPinned, BUDGET_GLOBAL);
  const w = takeWithinBudget(parts.workspacePinned, BUDGET_WORKSPACE);
  const sp = takeWithinBudget(parts.sessionPinned, BUDGET_SESSION_PINNED);
  const sections: string[] = [];

  const gSec = section('全局（用户偏好与通用规范）', g.kept.map((e) => `- ${e.content}`));
  if (gSec) sections.push(gSec);
  const wSec = section('项目记忆（workspace 规范）', w.kept.map((e) => `- ${e.content}`));
  if (wSec) sections.push(wSec);

  if (parts.sessionSummary) {
    const s = parts.sessionSummary.summary.slice(0, BUDGET_SESSION);
    sections.push(`### 本会话背景摘要\n${s}`);
  }

  // 会话层常驻条目：置于摘要段之后（spec §6.3 分段顺序）
  const spSec = section('会话记忆', sp.kept.map((e) => `- ${e.content}`));
  if (spSec) sections.push(spSec);

  // 目录先按行数限量（溢出计入截断），再按字符预算截断
  let truncated = g.truncated + w.truncated + sp.truncated;
  const catRows = parts.catalog.slice(0, CATALOG_MAX_ROWS);
  truncated += parts.catalog.length - catRows.length;
  const catLines: string[] = [];
  let catUsed = 0;
  for (const e of catRows) {
    const line = `- (${e.kind}) ${e.content.slice(0, CATALOG_PREVIEW)}`;
    if (catUsed + line.length > BUDGET_CATALOG) { truncated += catRows.length - catLines.length; break; }
    catLines.push(line);
    catUsed += line.length;
  }
  if (catLines.length > 0) sections.push(`### 可检索记忆目录\n${catLines.join('\n')}`);

  if (sections.length === 0) {
    return { hint: '', truncatedCount: 0, pinnedIds: [] };
  }
  const tail = truncated > 0 ? `\n\n（另有 ${truncated} 条记忆未注入，完整内容见 设置 → 记忆）` : '';
  return {
    hint: `\n\n## 记忆\n${sections.join('\n\n')}${tail}`,
    truncatedCount: truncated,
    pinnedIds: [...g.kept, ...w.kept, ...sp.kept].map((e) => e.id),
  };
}
