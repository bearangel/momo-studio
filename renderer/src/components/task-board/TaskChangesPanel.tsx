// renderer/src/components/task-board/TaskChangesPanel.tsx
//
// 任务卡「变更与回滚」面板（v2.5 Task 9 首建；2026-09-28 回滚重构 spec
// 2026-09-28-journal-rollback-redesign.md §5.5 信息架构倒转）：
//   - 顶部：JournalRollbackSection 共享回滚流（汇总 + danger 主按钮 + 预检
//     确认 + 执行结果）——「回滚此任务全部变更」是本分区主角
//   - 变更明细（默认折叠，次要）：按文件分组（D6——同 path 跨消息合并，净 diff
//     = 首条 before → 末条 after；消息级上下文由会话内 chip 提供，本面板不重复）
//   - 未入账区：scan 差集路径 + 「经 shell 命令或用户手动修改」诚实归因；
//     degraded 文案兼顾两成因（本机无 git 或仓库异常）
//   - 空态「无变更记录」（账面与扫描双空）；list/scan 失败降级 warn 留痕不弹错
//   - 2026-09-28 逐层撤回重构：逐文件「回滚到此文件此条之前」兜底移除——
//     撤回收敛为整组事务（会话侧走气泡右下角 TurnUndoButton），任务面板保留
//     任务范围整体回滚
import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { ipc } from '../../ipc/client';
import type { JournalEntryView, JournalScanResult } from '../../ipc/types';
import { JournalRollbackSection } from '../common/JournalRollback';
import {
  DiffBlock,
  groupByPath,
} from '../common/JournalChangeViews';

export interface TaskChangesPanelProps {
  workspaceId: string;
  taskId: string;
}

export function TaskChangesPanel({ workspaceId, taskId }: TaskChangesPanelProps) {
  const [entries, setEntries] = useState<JournalEntryView[] | null>(null);
  const [scan, setScan] = useState<JournalScanResult | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [openPaths, setOpenPaths] = useState<ReadonlySet<string>>(() => new Set());

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

  const fileGroups = useMemo(() => groupByPath(entries ?? []), [entries]);

  // 回滚后的幂等二次查询：撤回条目仍留账（对称记账），刷新反映
  // 配额清理/并发写入后的最新账面与扫描
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

  if (entries === null) {
    return <div className="text-xs text-tertiary">变更与回滚加载中...</div>;
  }

  const unjournaled = scan?.unjournaled ?? [];
  const degraded = scan?.degraded ?? false;

  if (entries.length === 0 && unjournaled.length === 0) {
    return (
      <div className="space-y-1 text-xs">
        <div className="text-tertiary">无变更记录</div>
        <div className="text-tertiary">
          会话内直接对话产生的变更不计入任务——请到对应会话头部的「回滚」入口操作
        </div>
        {degraded && (
          <div className="text-status-warning">无法交叉核对（本机无 git 或仓库异常）</div>
        )}
      </div>
    );
  }

  const togglePath = (path: string) => {
    setOpenPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  return (
    <div className="mt-1 space-y-2 text-xs" data-testid="task-changes-panel">
      <JournalRollbackSection
        workspaceId={workspaceId}
        entries={entries}
        onAfterRevert={refresh}
        testId="task-changes"
        unjournaledPaths={unjournaled}
      />

      {fileGroups.length > 0 && (
        <div>
          <button
            type="button"
            aria-expanded={detailOpen}
            onClick={() => setDetailOpen((v) => !v)}
            className="flex w-full cursor-pointer items-center gap-1 py-0.5 text-left"
            data-testid="task-changes-detail-toggle"
          >
            <span className="shrink-0 text-tertiary" aria-hidden>
              {detailOpen ? (
                <ChevronDown size={16} strokeWidth={1.75} />
              ) : (
                <ChevronRight size={16} strokeWidth={1.75} />
              )}
            </span>
            <span className="text-secondary">变更明细（{fileGroups.length} 个文件）</span>
          </button>
          {detailOpen && (
            <div className="mt-1">
              {fileGroups.map((g) => {
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
                    </div>
                    {open && (
                      <DiffBlock beforeText={g.first.beforeText} afterText={g.last.afterText} />
                    )}
                  </div>
                );
              })}
            </div>
          )}
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
          {/* 基线缺失提示（未入账误归因根治）：无任务起点基线（旧任务或捕获失败）
              时，unjournaled 是自上次 commit 的累计账外状态而非本任务专属——
              头部先行声明，避免误读为「本任务产生的变更」 */}
          {scan?.baselineAvailable === false && unjournaled.length > 0 && (
            <div className="text-xs text-tertiary">
              无任务起点基线（旧任务或捕获失败），以上为工作区累计账外状态，非本任务专属
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
    </div>
  );
}
