// renderer/src/components/common/JournalChangeViews.tsx
//
// 变更账本共享呈现件（v2.5 Task 8 首建于 ChangesChip，Task 9 提取共享）：
// 消息流 chip（im/ChangesChip）与任务卡「变更审查」面板（task-board/TaskChangesPanel）
// 两个入口共用同一套行级 diff 渲染与撤回五态结果列表，避免平行实现漂移。
//
//   - groupByPath：同 path 链式条目归组，净 diff 语义 = 组内首条 before → 末条 after
//     （组内 createdAt 升序；T8/T9 两级视图保持一致语义）
//   - DiffBlock：行级 diff（del 红 / add 绿 / ctx 中性，语义 token）
//   - JournalOutcomeList：五态结果逐条呈现（不静默）；宿主经 renderAction
//     注入特定结果行的追加操作（chip 的「强制撤回」/ 任务面板的「回滚到此文件此条之前」）
import { useMemo, type ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { diffLines, type DiffLine } from '../../lib/line-diff';
import type { JournalEntryView, RevertOutcome } from '../../ipc/types';

/** 撤回五态的呈现文案 + 语义 tone（黄=漂移跳过，红=失败，绿=成功还原） */
export const OUTCOME_META: Record<RevertOutcome['result'], { label: string; className: string }> = {
  reverted: { label: '已撤回', className: 'text-status-success' },
  'skipped-diverged': { label: '已跳过：文件已漂移', className: 'text-status-warning' },
  'restored-missing': { label: '文件缺失已还原', className: 'text-status-success' },
  'no-op': { label: '无需撤回', className: 'text-tertiary' },
  failed: { label: '撤回失败', className: 'text-status-error' },
};

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

/**
 * 撤回五态结果列表（逐条呈现不静默）。
 * renderAction：宿主注入的行级追加操作（返回 null 则该行无按钮）——
 * chip 传「强制撤回」（force 重试），任务面板传「回滚到此文件此条之前」（组合回滚）。
 */
export function JournalOutcomeList({
  outcomes,
  testId,
  renderAction,
}: {
  outcomes: RevertOutcome[];
  /** 宿主专属 testid（chip=changes-outcomes；任务面板另有回滚结果列表，须区分） */
  testId: string;
  renderAction?: (outcome: RevertOutcome) => ReactNode;
}) {
  return (
    <div className="mt-1.5 border-t border-subtle pt-1.5" data-testid={testId}>
      {outcomes.map((o, idx) => {
        const meta = OUTCOME_META[o.result];
        return (
          <div
            key={`${o.id}-${idx}`}
            className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5 py-0.5"
          >
            <span className={cn('shrink-0 font-medium', meta.className)}>{meta.label}</span>
            <span className="min-w-0 truncate font-mono text-[11px] text-secondary">
              {o.path !== '' ? o.path : o.id}
            </span>
            {o.detail !== undefined && <span className="text-tertiary">{o.detail}</span>}
            {renderAction !== undefined && renderAction(o)}
          </div>
        );
      })}
    </div>
  );
}
