// renderer/src/components/task-board/TaskChangesPanel.tsx
//
// 任务卡「变更审查」面板（v2.5 Task 9）：任务级变更审查入口——
//   - 挂载时并行懒查 journal.list({workspaceId, taskId}) + journal.scan(workspaceId,
//     taskId)（Promise.all；scan 懒执行语义 = 用户展开分区才跑，本组件仅在
//     TaskDetailPanel 展开时挂载）
//   - 按消息（streamSessionId）分组渲染聚合 diff：组内每文件净 diff = 首条
//     before → 末条 after（与消息流 chip 同语义，两级视图一致；同 path 跨组
//     不合并，各消息组独立呈现该消息的净效果）
//   - 未入账区：scan 差集路径 + 「经 shell 命令或用户手动修改」诚实归因；
//     degraded 文案兼顾两成因（本机无 git 或仓库异常——探测器两类降级路径）
//   - [撤回全部入账变更] → revert(workspaceId, 全部 id)（force 不默认）；
//     黄标（skipped-diverged）行提供 [回滚到此文件此条之前] → rollbackFileBefore
//     组合逆序回滚，逐文件结果呈现不静默
//   - 空态「无变更记录」（账面与扫描双空）；list/scan 失败降级 warn 留痕不弹错
import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Undo2 } from 'lucide-react';
import { ipc } from '../../ipc/client';
import type {
  JournalEntryView,
  JournalScanResult,
  RevertOutcome,
} from '../../ipc/types';
import { Button } from '../ui/Button';
import {
  DiffBlock,
  JournalOutcomeList,
  groupByPath,
  type FileChangeGroup,
} from '../common/JournalChangeViews';

export interface TaskChangesPanelProps {
  workspaceId: string;
  taskId: string;
}

/** 消息分组：一条消息（streamSessionId）一组，组内按 path 归文件组 */
interface SessionGroup {
  streamSessionId: string;
  entries: JournalEntryView[];
  files: FileChangeGroup[];
  /** 组间排序键 = 组内最早条目 createdAt（仅排序用） */
  sortKey: number;
}

/** 按 streamSessionId 归组；组间按各自最早条目 createdAt 升序（消息时间线序） */
function groupBySession(entries: JournalEntryView[]): SessionGroup[] {
  const map = new Map<string, JournalEntryView[]>();
  for (const e of entries) {
    const arr = map.get(e.streamSessionId);
    if (arr !== undefined) arr.push(e);
    else map.set(e.streamSessionId, [e]);
  }
  const groups: SessionGroup[] = [];
  for (const [streamSessionId, list] of map) {
    let firstCreatedAt = Number.POSITIVE_INFINITY;
    for (const e of list) {
      if (e.createdAt < firstCreatedAt) firstCreatedAt = e.createdAt;
    }
    // 组内至少一条（构造即 push），firstCreatedAt 必为有限值；防御兜底排最后
    groups.push({
      streamSessionId,
      entries: list,
      files: groupByPath(list),
      sortKey: Number.isFinite(firstCreatedAt) ? firstCreatedAt : Number.POSITIVE_INFINITY,
    });
  }
  groups.sort((a, b) => a.sortKey - b.sortKey);
  return groups;
}

export function TaskChangesPanel({ workspaceId, taskId }: TaskChangesPanelProps) {
  const [entries, setEntries] = useState<JournalEntryView[] | null>(null);
  const [scan, setScan] = useState<JournalScanResult | null>(null);
  const [outcomes, setOutcomes] = useState<RevertOutcome[] | null>(null);
  const [rollbackOutcomes, setRollbackOutcomes] = useState<RevertOutcome[] | null>(null);
  const [openKeys, setOpenKeys] = useState<ReadonlySet<string>>(() => new Set());
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // 挂载并行懒查：list 失败降级空账面；scan 失败降级 null（未入账区不渲染）
  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      ipc.journal.list({ workspaceId, taskId }).catch((err: unknown) => {
        console.warn('[TaskChangesPanel] journal.list 查询失败', err);
        return [] as JournalEntryView[];
      }),
      ipc.journal.scan(workspaceId, taskId).catch((err: unknown) => {
        console.warn('[TaskChangesPanel] journal.scan 查询失败', err);
        return null;
      }),
    ]).then(([rows, scanResult]) => {
      if (cancelled) return;
      setEntries(rows);
      setScan(scanResult);
    });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, taskId]);

  const sessionGroups = useMemo(() => groupBySession(entries ?? []), [entries]);

  // 撤回/回滚后的幂等二次查询：撤回条目仍留账（对称记账落 journal-revert-ui），
  // 刷新反映配额清理/并发写入后的最新账面与扫描
  const refresh = async (): Promise<void> => {
    const [rows, scanResult] = await Promise.all([
      ipc.journal.list({ workspaceId, taskId }).catch((err: unknown) => {
        console.warn('[TaskChangesPanel] journal.list 二次查询失败', err);
        return [] as JournalEntryView[];
      }),
      ipc.journal.scan(workspaceId, taskId).catch((err: unknown) => {
        console.warn('[TaskChangesPanel] journal.scan 二次查询失败', err);
        return null;
      }),
    ]);
    setEntries(rows);
    setScan(scanResult);
  };

  const handleRevertAll = async (): Promise<void> => {
    if (entries === null || busy) return;
    setBusy(true);
    setActionError(null);
    try {
      // force 不默认：漂移条目由黄标 + [回滚到此文件此条之前] 组合操作兜底
      const result = await ipc.journal.revert(
        workspaceId,
        entries.map((e) => e.id),
        undefined,
      );
      setOutcomes(result);
      setRollbackOutcomes(null);
      await refresh();
    } catch (err: unknown) {
      // 整批抛错（如 store 未注入）→ 错误行呈现，不静默吞掉
      setActionError(`撤回失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const handleRollbackBefore = async (outcome: RevertOutcome): Promise<void> => {
    if (busy || outcome.path === '') return;
    setBusy(true);
    setActionError(null);
    try {
      const result = await ipc.journal.rollbackFileBefore(
        workspaceId,
        outcome.path,
        outcome.id,
      );
      setRollbackOutcomes(result);
      await refresh();
    } catch (err: unknown) {
      setActionError(`回滚失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  if (entries === null) {
    return <div className="text-xs text-tertiary">变更审查加载中...</div>;
  }

  const unjournaled = scan?.unjournaled ?? [];
  const degraded = scan?.degraded ?? false;

  if (entries.length === 0 && unjournaled.length === 0) {
    return (
      <div className="space-y-1 text-xs">
        <div className="text-tertiary">无变更记录</div>
        {degraded && (
          <div className="text-status-warning">无法交叉核对（本机无 git 或仓库异常）</div>
        )}
      </div>
    );
  }

  const toggleFile = (key: string) => {
    setOpenKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <div className="mt-1 space-y-2 text-xs" data-testid="task-changes-panel">
      {entries.length > 0 && (
        <div>
          <div className="mb-1.5 flex items-center justify-between gap-2">
            <span className="text-secondary">
              {entries.length} 处入账变更 · {sessionGroups.length} 条消息
            </span>
            <Button
              variant="secondary"
              size="sm"
              disabled={busy}
              onClick={() => void handleRevertAll()}
            >
              <Undo2 size={16} strokeWidth={1.75} aria-hidden /> 撤回全部入账变更
            </Button>
          </div>

          {sessionGroups.map((g) => (
            <div
              key={g.streamSessionId}
              className="mb-1 rounded border border-subtle bg-surface-2"
              data-testid="changes-group"
            >
              <div className="truncate px-1.5 py-1 font-mono text-[11px] text-tertiary">
                消息 {g.streamSessionId}
              </div>
              {g.files.map((f) => {
                const key = `${g.streamSessionId}::${f.path}`;
                const open = openKeys.has(key);
                const renameFrom = f.first.oldPath;
                return (
                  <div key={key} className="mb-1">
                    <div className="flex items-center gap-1.5 px-1.5 py-1">
                      <button
                        type="button"
                        aria-expanded={open}
                        onClick={() => toggleFile(key)}
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
                          {renameFrom !== null ? `${renameFrom} → ${f.path}` : f.path}
                        </span>
                        <span className="shrink-0 text-tertiary">{f.entries.length} 条</span>
                      </button>
                    </div>
                    {open && (
                      <DiffBlock beforeText={f.first.beforeText} afterText={f.last.afterText} />
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}

      {(unjournaled.length > 0 || degraded) && (
        <div className="rounded border border-status-warning/40 bg-status-warning-tint px-2 py-1.5">
          <div className="mb-1 font-medium text-status-warning">未入账变更</div>
          {degraded && (
            <div className="text-status-warning">
              无法交叉核对（本机无 git 或仓库异常）——以下核对不可用
            </div>
          )}
          {unjournaled.length > 0 && (
            <>
              {unjournaled.map((p) => (
                <div key={p} className="truncate font-mono text-[11px] text-secondary">
                  {p}
                </div>
              ))}
              <div className="mt-1 text-tertiary">
                以上经 shell 命令或用户手动修改——无法区分来源，不在撤回范围内
              </div>
            </>
          )}
        </div>
      )}

      {actionError !== null && (
        <div className="rounded border border-status-error/40 bg-status-error-tint px-2 py-1 text-status-error">
          {actionError}
        </div>
      )}

      {outcomes !== null && outcomes.length > 0 && (
        <JournalOutcomeList
          outcomes={outcomes}
          testId="task-changes-outcomes"
          renderAction={(o) =>
            o.result === 'skipped-diverged' && o.path !== '' ? (
              <Button
                variant="secondary"
                size="sm"
                disabled={busy}
                onClick={() => void handleRollbackBefore(o)}
              >
                回滚到此文件此条之前
              </Button>
            ) : null
          }
        />
      )}

      {rollbackOutcomes !== null && rollbackOutcomes.length > 0 && (
        <div>
          <div className="mb-0.5 text-secondary">组合回滚结果（逆序逐步）：</div>
          <JournalOutcomeList outcomes={rollbackOutcomes} testId="task-rollback-outcomes" />
        </div>
      )}
    </div>
  );
}
