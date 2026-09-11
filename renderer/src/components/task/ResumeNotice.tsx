// renderer/src/components/task/ResumeNotice.tsx
//
// v2.6.0 启动恢复卡（spec §6）：重启后检测到 in_progress / assigned / session_queued
// 任务时右下角非模态呈现（SandboxNotice 同款基建），boot 现查现示——瞬态卡，无 kv
// 持久化；全部任务决策完（恢复 / 放弃）即消散。D6：卡片是唯一闸门，检测与决策都
// 不改任务状态，直到用户点按钮。
//
// 逐任务行：标题 + agent 名 + 「半程变更 M 处」（journalCount=0 → 「无文件变更」）。
//   - [恢复] → task.resume(taskId)（in_progress 走断点续跑；assigned/session_queued
//     走 executor 全新执行——多路分发在主进程）→ 成功后该行消散
//   - [放弃] 展开内联二选一：
//       [直接放弃] → task.transition(id, 'cancelled')
//       [撤回变更后放弃] → task.get 取 workspaceId → journal.list({workspaceId,
//       taskId}) 取全部条目 ids → journal.revert(workspaceId, ids, {})（force 不
//       默认，漂移条目由 v2.5 既有黄标组合回滚兜底）→ 行内呈现撤回结果摘要
//       （撤回 x 处 · 跳过 y 处）→ transition('cancelled')
// 撤回链错误（get/list/revert/transition 任一失败）→ 行保留 + 错误行呈现，不静默吞。
import { useEffect, useState } from 'react';
import { Ban, History, RotateCcw, Undo2 } from 'lucide-react';
import { ipc } from '../../ipc/client';
import type { InterruptedTaskInfo, RevertOutcome } from '../../ipc/types';
import { Button } from '../ui/Button';

/** 行内 UI 状态（决策展开 / 撤回摘要 / 错误行），按 taskId 键控 */
interface RowUi {
  abandonExpanded: boolean;
  summary: { reverted: number; skipped: number } | null;
  error: string | null;
}

const ROW_UI_INIT: RowUi = { abandonExpanded: false, summary: null, error: null };

/** 撤回结果计数：成功还原（reverted / restored-missing）计撤回，其余（漂移跳过 /
 * no-op / failed）计跳过——与账本面板 OUTCOME_META 的绿/非绿二分口径一致 */
function countOutcomes(outcomes: RevertOutcome[]): { reverted: number; skipped: number } {
  let reverted = 0;
  for (const o of outcomes) {
    if (o.result === 'reverted' || o.result === 'restored-missing') reverted += 1;
  }
  return { reverted, skipped: outcomes.length - reverted };
}

export function ResumeNotice() {
  // null = boot 拉取未返回（不渲染）；空数组 = 无中断任务（不渲染）
  const [items, setItems] = useState<InterruptedTaskInfo[] | null>(null);
  const [rowUi, setRowUi] = useState<Record<string, RowUi>>({});
  // 行级互斥：任一行动作 in-flight 时该行按钮禁用（防双击双发 resume/transition）
  const [busyId, setBusyId] = useState<string | null>(null);

  // boot 现查现示（瞬态，无 kv）；拉取失败视为无中断任务——恢复卡是体验性增强，
  // 不阻塞启动（与升级首启提示同语义），下次启动自然再现
  useEffect(() => {
    void ipc.task
      .listInterrupted()
      .then((list) => setItems(list))
      .catch(() => setItems([]));
  }, []);

  if (items === null || items.length === 0) return null;

  const patchUi = (taskId: string, patch: Partial<RowUi>): void => {
    setRowUi((prev) => ({ ...prev, [taskId]: { ...(prev[taskId] ?? ROW_UI_INIT), ...patch } }));
  };

  // 决策完成 → 该行消散；全部决策完 items 为空 → 卡片消散（return null）
  const removeRow = (taskId: string): void => {
    setItems((prev) => (prev ?? []).filter((i) => i.taskId !== taskId));
  };

  const wrapAction = async (taskId: string, label: string, action: () => Promise<void>): Promise<void> => {
    if (busyId !== null) return;
    setBusyId(taskId);
    patchUi(taskId, { error: null });
    try {
      await action();
    } catch (err) {
      // 错误路径：行保留 + 错误行呈现（决策未完成，卡片不消散）；
      // 前缀标注动作语境，多行场景用户可定位失败的是哪个决策
      const reason = err instanceof Error ? err.message : String(err);
      patchUi(taskId, { error: `${label}失败：${reason}` });
    } finally {
      setBusyId(null);
    }
  };

  const handleResume = (taskId: string): void => {
    void wrapAction(taskId, '恢复', async () => {
      await ipc.task.resume(taskId);
      removeRow(taskId);
    });
  };

  const handleDirectAbandon = (taskId: string): void => {
    void wrapAction(taskId, '放弃', async () => {
      await ipc.task.transition(taskId, 'cancelled');
      removeRow(taskId);
    });
  };

  const handleRevertThenAbandon = (taskId: string): void => {
    void wrapAction(taskId, '撤回变更后放弃', async () => {
      // workspaceId 不在 InterruptedTaskInfo 里（T5 契约无此字段）——从任务行现取，
      // 保证跨 workspace 的中断任务撤回各自账本
      const task = await ipc.task.get(taskId);
      if (!task) throw new Error('任务不存在');
      const entries = await ipc.journal.list({ workspaceId: task.workspaceId, taskId });
      if (entries.length > 0) {
        const outcomes = await ipc.journal.revert(
          task.workspaceId,
          entries.map((e) => e.id),
          {},
        );
        // 摘要先于 transition 呈现（transition resolve 后行即消散）
        patchUi(taskId, { summary: countOutcomes(outcomes) });
      }
      await ipc.task.transition(taskId, 'cancelled');
      removeRow(taskId);
    });
  };

  return (
    <div
      data-testid="resume-notice"
      className="fixed right-4 bottom-4 z-40 w-[380px] max-w-[calc(100vw-2rem)] rounded-lg border border-subtle bg-surface-1 shadow-xl p-4 text-sm text-secondary"
    >
      <div className="flex items-start gap-2 mb-2">
        <History size={16} strokeWidth={1.75} className="text-tertiary shrink-0 mt-0.5" aria-hidden />
        <div>
          <h2 className="text-base font-semibold text-primary">有任务在重启时被中断</h2>
          <p className="text-xs text-tertiary mt-0.5">
            恢复将从断点继续执行；放弃可选择撤回该任务已做的文件变更
          </p>
        </div>
      </div>
      <div className="space-y-2">
        {items.map((item) => {
          const ui = rowUi[item.taskId] ?? ROW_UI_INIT;
          const busy = busyId === item.taskId;
          return (
            <div
              key={item.taskId}
              data-testid={`resume-row-${item.taskId}`}
              className="rounded border border-subtle bg-surface-2 p-2.5"
            >
              <div className="flex items-baseline justify-between gap-2">
                <span className="truncate font-medium text-primary">{item.title}</span>
                <span className="shrink-0 text-xs text-tertiary">{item.agentName}</span>
              </div>
              <div className="mt-0.5 text-xs text-tertiary">
                {item.journalCount > 0 ? `半程变更 ${item.journalCount} 处` : '无文件变更'}
              </div>
              {ui.error !== null && (
                <div className="mt-1.5 rounded border border-status-error/40 bg-status-error-tint px-2 py-1 text-xs text-status-error">
                  {ui.error}
                </div>
              )}
              {ui.summary !== null && (
                <div className="mt-1.5 text-xs text-secondary" data-testid={`resume-summary-${item.taskId}`}>
                  撤回 {ui.summary.reverted} 处 · 跳过 {ui.summary.skipped} 处
                </div>
              )}
              <div className="mt-2 flex flex-wrap items-center justify-end gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={busy}
                  onClick={() => handleResume(item.taskId)}
                >
                  <RotateCcw size={16} strokeWidth={1.75} aria-hidden /> 恢复
                </Button>
                {!ui.abandonExpanded && (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => patchUi(item.taskId, { abandonExpanded: true })}
                  >
                    <Ban size={16} strokeWidth={1.75} aria-hidden /> 放弃
                  </Button>
                )}
                {ui.abandonExpanded && (
                  <>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() => handleDirectAbandon(item.taskId)}
                    >
                      <Ban size={16} strokeWidth={1.75} aria-hidden /> 直接放弃
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() => handleRevertThenAbandon(item.taskId)}
                    >
                      <Undo2 size={16} strokeWidth={1.75} aria-hidden /> 撤回变更后放弃
                    </Button>
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
