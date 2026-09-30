// renderer/src/components/task-board/TaskChangesPanel.tsx
//
// 任务卡「变更与回滚」面板（v2.5 Task 9 首建；2026-09-28 回滚重构 spec
// 2026-09-28-journal-rollback-redesign.md §5.5；2026-09-29 会话任务联动 G1
// 摘要常显重构）：
//   - 分区头（自 TaskDetailPanel 移入）：FileDiff 图标 + 「变更与回滚」标题 +
//     「N 处变更 · M 个文件」计数（ChangesChip 同款语义）+ 展开箭头
//   - 折叠态即常显：文件路径清单（JournalFileChangesList 共享件，可就地
//     展开 diff；D6——同 path 跨消息合并，净 diff = 首条 before → 末条 after）
//   - journal.list 挂载即查（摘要常显的数据面）；journal.scan 仅展开后执行
//     （懒执行语义保持，spec §5.5）
//   - 展开态：空态指引 / JournalRollbackSection 共享回滚流（汇总 + danger
//     主按钮 + 预检确认 + 执行结果）/ 未入账区（scan 差集路径 + 「经 shell
//     命令或用户手动修改」诚实归因；degraded 文案兼顾两成因）
//   - list/scan 失败降级 warn 留痕不弹错；空态「无变更记录」（账面与扫描双空）
//   - 2026-09-28 逐层撤回重构：逐文件「回滚到此文件此条之前」兜底移除——
//     撤回收敛为整组事务（会话侧走气泡右下角 TurnUndoButton），任务面板保留
//     任务范围整体回滚
import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, FileDiff } from 'lucide-react';
import { ipc } from '../../ipc/client';
import type { JournalEntryView, JournalScanResult } from '../../ipc/types';
import { JournalRollbackSection } from '../common/JournalRollback';
import { JournalFileChangesList } from '../common/JournalFileChangesList';

export interface TaskChangesPanelProps {
  workspaceId: string;
  taskId: string;
}

export function TaskChangesPanel({ workspaceId, taskId }: TaskChangesPanelProps) {
  const [entries, setEntries] = useState<JournalEntryView[] | null>(null);
  const [scan, setScan] = useState<JournalScanResult | null>(null);
  // 展开态：挂载回滚区 + 未入账区（scan 懒执行的触发位）
  const [open, setOpen] = useState(false);

  // journal.list 挂载即查（摘要常显）；失败降级空账面 + warn 留痕
  useEffect(() => {
    let cancelled = false;
    void ipc.journal
      .list({ workspaceId, taskId })
      .then((rows) => {
        if (!cancelled) setEntries(rows);
      })
      .catch((err: unknown) => {
        console.warn('[TaskChangesPanel] journal.list 查询失败', err);
        if (!cancelled) setEntries([]);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, taskId]);

  // scan 仅展开后执行（2026-09-28 spec §5.5 懒执行语义保持）；失败降级 null
  // （未入账区不渲染）
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void ipc.journal
      .scan(workspaceId, taskId)
      .then((r) => {
        if (!cancelled) setScan(r);
      })
      .catch((err: unknown) => {
        console.warn('[TaskChangesPanel] journal.scan 查询失败', err);
        if (!cancelled) setScan(null);
      });
    return () => {
      cancelled = true;
    };
  }, [open, workspaceId, taskId]);

  // 回滚后的幂等二次查询（撤回条目仍留账——对称记账）；scan 仅展开态刷新
  const refresh = async (): Promise<void> => {
    const rows = await ipc.journal.list({ workspaceId, taskId }).catch((err: unknown) => {
      console.warn('[TaskChangesPanel] journal.list 二次查询失败', err);
      return [] as JournalEntryView[];
    });
    setEntries(rows);
    if (open) {
      const scanResult = await ipc.journal.scan(workspaceId, taskId).catch((err: unknown) => {
        console.warn('[TaskChangesPanel] journal.scan 二次查询失败', err);
        return null;
      });
      setScan(scanResult);
    }
  };

  if (entries === null) {
    return <div className="text-xs text-tertiary">变更与回滚加载中...</div>;
  }

  const unjournaled = scan?.unjournaled ?? [];
  const degraded = scan?.degraded ?? false;
  const fileCount = new Set(entries.map((e) => e.path)).size;
  const empty = entries.length === 0 && unjournaled.length === 0;

  return (
    <div className="mt-1" data-testid="task-changes-panel">
      {/* 分区头：标题 + 计数 + 展开箭头（自 TaskDetailPanel 移入） */}
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        data-testid="task-changes-toggle"
        className="flex w-full cursor-pointer items-center gap-1.5 rounded border border-strong bg-surface-3 px-2 py-1 text-left text-xs transition-colors"
      >
        <FileDiff size={16} strokeWidth={1.75} aria-hidden className="shrink-0 text-accent-500" />
        <span className="text-primary">变更与回滚</span>
        <span className="ml-auto shrink-0 text-tertiary" data-testid="task-changes-summary">
          {empty ? '无变更记录' : `${entries.length} 处变更 · ${fileCount} 个文件`}
        </span>
        <span className="shrink-0 text-tertiary" aria-hidden>
          {open ? <ChevronDown size={16} strokeWidth={1.75} /> : <ChevronRight size={16} strokeWidth={1.75} />}
        </span>
      </button>
      {/* 折叠态即常显：文件路径清单（可就地展开 diff） */}
      {entries.length > 0 && (
        <div className="mt-1 max-h-40 overflow-y-auto px-2 py-1">
          <JournalFileChangesList entries={entries} />
        </div>
      )}
      {/* 展开态：指引 / 回滚区 / 未入账区 */}
      {open && (
        <div className="mt-2 space-y-2 text-xs">
          {empty && (
            <div className="text-tertiary">
              会话内直接对话产生的变更不计入任务——请到对应会话头部的「回滚」入口操作
            </div>
          )}
          {entries.length > 0 && (
            <JournalRollbackSection
              workspaceId={workspaceId}
              entries={entries}
              onAfterRevert={refresh}
              testId="task-changes"
              unjournaledPaths={unjournaled}
            />
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
      )}
    </div>
  );
}
