// renderer/src/components/im/ChangesChip.tsx
//
// 消息流「变更」chip（v2.5 Task 8）：终态消息旁展示本次流会话写入的文件变更，
// 点开逐文件行级 diff，支持逐文件/全部撤回与漂移强制撤回。
//
// 数据源：ipc.journal.list({ workspaceId, streamSessionId })（Task 7 四通道）。
// 行为契约：
//   - 挂载懒查一次（useEffect + 局部 state；身份字段缺一不查，勿每渲染轮询）
//   - 空数组/查询失败 → 不渲染（被动 affordance，失败仅 warn 留痕不弹错）
//   - 撤回经 ipc.journal.revert(workspaceId, ids, opts)——执行序由主进程按全局
//     created_at 逆序保证；撤回后幂等二次查询刷新（撤回条目仍留账：对称记账）
//   - 五态结果逐条呈现不静默；skipped-diverged 黄标 + detail + [强制撤回]
//     （force=true 覆盖漂移内容，UI 如实转述主进程 detail 警示）
//   - 同 path 链式条目归单文件组，净 diff = 首条 beforeText → 末条 afterText
import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, FileDiff, Undo2 } from 'lucide-react';
import { cn } from '../../lib/cn';
import { diffLines, type DiffLine } from '../../lib/line-diff';
import type { ImMessage, JournalEntryView, RevertOutcome } from '../../ipc/types';
import { ipc } from '../../ipc/client';
import { Button } from '../ui/Button';

export interface ChangesChipProps {
  /** 宿主消息：自取 workspaceId / streamSessionId（挂载点 AgentStreamBubble） */
  message: ImMessage;
}

/** 撤回五态的呈现文案 + 语义 tone（黄=漂移跳过，红=失败，绿=成功还原） */
const OUTCOME_META: Record<RevertOutcome['result'], { label: string; className: string }> = {
  reverted: { label: '已撤回', className: 'text-status-success' },
  'skipped-diverged': { label: '已跳过：文件已漂移', className: 'text-status-warning' },
  'restored-missing': { label: '文件缺失已还原', className: 'text-status-success' },
  'no-op': { label: '无需撤回', className: 'text-tertiary' },
  failed: { label: '撤回失败', className: 'text-status-error' },
};

/** 同 path 条目归组：净 diff 取首条 before → 末条 after（组内 createdAt 升序） */
interface FileChangeGroup {
  path: string;
  entries: JournalEntryView[];
  first: JournalEntryView;
  last: JournalEntryView;
}

function groupByPath(entries: JournalEntryView[]): FileChangeGroup[] {
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

/** 行级 diff 渲染：del 行 text-status-error / add 行 text-status-success / ctx 中性 */
function DiffBlock({
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
      {rows.map((row, i) => (
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
    </div>
  );
}

export function ChangesChip({ message }: ChangesChipProps) {
  const { workspaceId, streamSessionId } = message;

  const [entries, setEntries] = useState<JournalEntryView[] | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [openPaths, setOpenPaths] = useState<ReadonlySet<string>>(() => new Set());
  const [outcomes, setOutcomes] = useState<RevertOutcome[] | null>(null);
  const [revertError, setRevertError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // 挂载懒查一次：空数组 → 不渲染；失败降级为空（warn 留痕）
  useEffect(() => {
    if (workspaceId === null || streamSessionId === null) return;
    let cancelled = false;
    ipc.journal
      .list({ workspaceId, streamSessionId })
      .then((rows) => {
        if (!cancelled) setEntries(rows);
      })
      .catch((err: unknown) => {
        console.warn('[ChangesChip] journal.list 查询失败', err);
        if (!cancelled) setEntries([]);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, streamSessionId]);

  const groups = useMemo(() => groupByPath(entries ?? []), [entries]);

  const handleRevert = async (ids: string[], force: boolean) => {
    if (workspaceId === null || streamSessionId === null || busy) return;
    setBusy(true);
    setRevertError(null);
    try {
      const result = await ipc.journal.revert(
        workspaceId,
        ids,
        force ? { force: true } : undefined,
      );
      setOutcomes(result);
      // 幂等二次查询：撤回条目仍留账（对称记账落 journal-revert-ui），刷新反映
      // 配额清理/并发写入后的最新账面
      const rows = await ipc.journal.list({ workspaceId, streamSessionId });
      setEntries(rows);
    } catch (err: unknown) {
      // 整批抛错（如 store 未注入）→ 错误行呈现，不静默吞掉
      setRevertError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  // 查询中 / 无变更 → 不渲染
  if (entries === null || entries.length === 0) return null;

  const togglePath = (path: string) => {
    setOpenPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  return (
    <div className="mt-1" data-testid="changes-chip">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full cursor-pointer items-center gap-1.5 rounded border border-strong bg-surface-3 px-2 py-1 text-left text-xs transition-colors"
      >
        <FileDiff size={16} strokeWidth={1.75} aria-hidden className="shrink-0 text-accent-500" />
        <span className="text-primary">{entries.length} 处变更</span>
        <span className="ml-auto shrink-0 text-tertiary" aria-hidden>
          {expanded ? (
            <ChevronDown size={16} strokeWidth={1.75} />
          ) : (
            <ChevronRight size={16} strokeWidth={1.75} />
          )}
        </span>
      </button>

      {expanded && (
        <div className="mt-1 rounded border border-subtle bg-surface-1 p-2 text-xs">
          <div className="mb-1.5 flex items-center justify-between gap-2">
            <span className="text-secondary">{groups.length} 个文件</span>
            <Button
              variant="secondary"
              size="sm"
              disabled={busy}
              onClick={() => void handleRevert(entries.map((e) => e.id), false)}
            >
              <Undo2 size={16} strokeWidth={1.75} aria-hidden /> 全部撤回
            </Button>
          </div>

          {groups.map((g) => {
            const open = openPaths.has(g.path);
            const renameFrom = g.first.oldPath;
            return (
              <div key={g.path} className="mb-1 rounded border border-subtle bg-surface-2">
                <div className="flex items-center gap-1.5 px-1.5 py-1">
                  <button
                    type="button"
                    aria-expanded={open}
                    onClick={() => togglePath(g.path)}
                    className="flex min-w-0 flex-1 cursor-pointer items-center gap-1 text-left"
                  >
                    <span className="shrink-0 text-tertiary" aria-hidden>
                      {open ? (
                        <ChevronDown size={16} strokeWidth={1.75} />
                      ) : (
                        <ChevronRight size={16} strokeWidth={1.75} />
                      )}
                    </span>
                    <span className="truncate font-mono text-[11px] text-primary">
                      {renameFrom !== null ? `${renameFrom} → ${g.path}` : g.path}
                    </span>
                    <span className="shrink-0 text-tertiary">{g.entries.length} 条</span>
                  </button>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={busy}
                    onClick={() => void handleRevert(g.entries.map((e) => e.id), false)}
                  >
                    撤回
                  </Button>
                </div>
                {open && <DiffBlock beforeText={g.first.beforeText} afterText={g.last.afterText} />}
              </div>
            );
          })}

          {revertError !== null && (
            <div className="mt-1 rounded border border-status-error/40 bg-status-error-tint px-2 py-1 text-status-error">
              撤回失败：{revertError}
            </div>
          )}

          {outcomes !== null && outcomes.length > 0 && (
            <div className="mt-1.5 border-t border-subtle pt-1.5" data-testid="changes-outcomes">
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
                    {o.result === 'skipped-diverged' && (
                      <Button
                        variant="danger"
                        size="sm"
                        disabled={busy}
                        onClick={() => void handleRevert([o.id], true)}
                      >
                        强制撤回
                      </Button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
