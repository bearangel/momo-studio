// renderer/src/components/common/JournalChangeViews.tsx
//
// 变更账本共享呈现件（v2.5 Task 8 首建于 ChangesChip，Task 9 提取共享）：
// 消息流 chip（im/ChangesChip）与文件清单（common/JournalFileChangesList）
// 两个入口共用同一套行级 diff 渲染，避免平行实现漂移。
//
//   - groupByPath：同 path 链式条目归组，净 diff 语义 = 组内首条 before → 末条 after
//     （组内 createdAt 升序；两级视图保持一致语义）
//   - DiffBlock：行级 diff（del 红 / add 绿 / ctx 中性，语义 token）
import { useMemo } from 'react';
import { cn } from '../../lib/cn';
import { diffLines, type DiffLine } from '../../lib/line-diff';
import type { JournalEntryView } from '../../ipc/types';

/** 同 path 条目归组：净 diff 取首条 before → 末条 after（组内 createdAt 升序） */
export interface FileChangeGroup {
  path: string;
  entries: JournalEntryView[];
  first: JournalEntryView;
  last: JournalEntryView;
}

/** 同 path 归组（保持入参顺序稳定：Map 按首现次序产出） */
export function groupByPath(entries: JournalEntryView[]): FileChangeGroup[] {
  const map = new Map<string, JournalEntryView[]>();
  for (const e of entries) {
    const arr = map.get(e.path);
    if (arr !== undefined) arr.push(e);
    else map.set(e.path, [e]);
  }
  const groups: FileChangeGroup[] = [];
  for (const [path, list] of map) {
    list.sort((a, b) => a.createdAt - b.createdAt);
    const first = list[0];
    const last = list[list.length - 1];
    // 空组不可达（构造即至少一条）；防御性窄化满足 noUncheckedIndexedAccess
    if (first === undefined || last === undefined) continue;
    groups.push({ path, entries: list, first, last });
  }
  return groups;
}

/**
 * 渲染行数上限（审查 C3）：超大 diff（降级视图可达 n+m 行）全量渲染 DOM 行
 * 会卡死消息流——截断展示前 N 行 + 总行数提示；diff 计算本身有
 * line-diff 降级阈值兜底，本截断是渲染层的第二道防线。
 */
const DIFF_RENDER_ROW_CAP = 500;

/** 行级 diff 渲染：del 行 text-status-error / add 行 text-status-success / ctx 中性 */
export function DiffBlock({
  beforeText,
  afterText,
}: {
  beforeText: string | null;
  afterText: string | null;
}) {
  const rows = useMemo<DiffLine[]>(
    () =>
      diffLines(
        beforeText !== null ? beforeText.split('\n') : [],
        afterText !== null ? afterText.split('\n') : [],
      ),
    [beforeText, afterText],
  );
  const truncated = rows.length > DIFF_RENDER_ROW_CAP;
  const shown = truncated ? rows.slice(0, DIFF_RENDER_ROW_CAP) : rows;

  // 双侧文本皆缺（hash 为 null 或 blob 被配额清理）→ 无从 diff，如实提示
  if (beforeText === null && afterText === null) {
    return (
      <div className="border-t border-subtle px-2 py-1 text-[11px] text-tertiary">
        内容快照缺失，无法展示差异
      </div>
    );
  }

  return (
    <div
      className="overflow-x-auto border-t border-subtle px-2 py-1 font-mono text-[11px]"
      data-testid="changes-diff"
    >
      {shown.map((row, i) => (
        <div
          key={`${row.type}-${i}`}
          className={cn(
            'whitespace-pre-wrap break-all',
            row.type === 'del' && 'text-status-error',
            row.type === 'add' && 'text-status-success',
            row.type === 'ctx' && 'text-tertiary',
          )}
        >
          <span aria-hidden className="select-none">
            {row.type === 'del' ? '-' : row.type === 'add' ? '+' : ' '}
          </span>
          {row.text}
        </div>
      ))}
      {truncated && (
        <div className="px-2 py-1 text-tertiary" data-testid="changes-diff-truncated">
          已截断，共 {rows.length} 行
        </div>
      )}
    </div>
  );
}
