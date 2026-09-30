// renderer/src/components/common/JournalRollback.tsx
//
// 整体回滚核心组件（变更回滚重构，spec 2026-09-28 §5.4）：任务卡「变更与回滚」
// 面板与会话级回滚弹窗共用的回滚流——汇总行 + danger 主按钮 → 干跑预检
// （journal:preview，链式虚拟态预测）→ 确认面板 → 执行（journal:revert）→
// 五态结果逐条呈现。
//
//   - 预检分组呈现：将回滚（reverted/restored-missing，附文件清单）/ 将拦截
//     （skipped-diverged 黄标 + 漂移说明）/ 计数行（no-op）；failed 预测如实呈现
//   - 强制覆盖为全局勾选（D4）：保住批量逆序执行序不拆批；默认不勾，勾选后
//     才以 force=true 执行；逐文件粒度由宿主黄标行「回滚到此文件此条之前」兜底
//   - 预检仅是呈现优化：执行时 hash 守卫仍生效（确认面板如实标注）
//   - 执行后经 onAfterRevert 幂等二次查询（对称记账，撤回条目仍留账）
//   - preview/revert 整批抛错 → 错误行呈现，不静默
import { useMemo, useState, type ReactNode } from 'react';
import { TriangleAlert, Undo2 } from 'lucide-react';
import { ipc } from '../../ipc/client';
import type { JournalEntryView, RevertOutcome } from '../../ipc/types';
import { Button } from '../ui/Button';
import { JournalOutcomeList } from './JournalChangeViews';

export interface JournalRollbackSectionProps {
  workspaceId: string;
  entries: JournalEntryView[];
  /** 执行完成后的幂等二次查询回调（宿主各自按 scope 刷新账面） */
  onAfterRevert?: () => void | Promise<void>;
  /** 宿主专属 testid 前缀（任务面板 / 会话弹窗区分） */
  testId: string;
  /** 未入账文件清单（任务面板传入；确认面板声明「不随回滚」，会话级不传） */
  unjournaledPaths?: string[];
  /** 结果行的追加操作注入（任务面板传「回滚到此文件此条之前」组合操作兜底） */
  renderOutcomeAction?: (outcome: RevertOutcome) => ReactNode;
}

type Phase = 'idle' | 'confirm';

export function JournalRollbackSection({
  workspaceId,
  entries,
  onAfterRevert,
  testId,
  unjournaledPaths = [],
  renderOutcomeAction,
}: JournalRollbackSectionProps) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [previewOutcomes, setPreviewOutcomes] = useState<RevertOutcome[] | null>(null);
  const [forceOverride, setForceOverride] = useState(false);
  const [outcomes, setOutcomes] = useState<RevertOutcome[] | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const ids = useMemo(() => entries.map((e) => e.id), [entries]);
  const fileCount = useMemo(
    () => new Set(entries.map((e) => e.path)).size,
    [entries],
  );

  const startPreview = async (): Promise<void> => {
    if (busy || ids.length === 0) return;
    setBusy(true);
    setActionError(null);
    try {
      const result = await ipc.journal.preview(workspaceId, ids);
      setPreviewOutcomes(result);
      setForceOverride(false);
      setOutcomes(null);
      setPhase('confirm');
    } catch (err: unknown) {
      setActionError(`预检失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const executeRevert = async (): Promise<void> => {
    if (busy || phase !== 'confirm') return;
    setBusy(true);
    setActionError(null);
    try {
      const result = await ipc.journal.revert(
        workspaceId,
        ids,
        forceOverride ? { force: true } : undefined,
      );
      setOutcomes(result);
      setPhase('idle');
      setPreviewOutcomes(null);
      await onAfterRevert?.();
    } catch (err: unknown) {
      setActionError(`回滚失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };

  const cancelConfirm = (): void => {
    if (busy) return;
    setPhase('idle');
    setPreviewOutcomes(null);
    setForceOverride(false);
  };

  if (entries.length === 0) return null;

  const willRevert =
    previewOutcomes?.filter((o) => o.result === 'reverted' || o.result === 'restored-missing') ?? [];
  const blocked = previewOutcomes?.filter((o) => o.result === 'skipped-diverged') ?? [];
  const noopCount = previewOutcomes?.filter((o) => o.result === 'no-op').length ?? 0;
  const previewFailed = previewOutcomes?.filter((o) => o.result === 'failed') ?? [];

  return (
    <div data-testid={`${testId}-rollback`} className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-secondary">
          {entries.length} 处入账变更 · {fileCount} 个文件
        </span>
        {phase === 'idle' && (
          <Button
            variant="danger"
            size="sm"
            disabled={busy}
            onClick={() => void startPreview()}
            data-testid={`${testId}-rollback-btn`}
          >
            <Undo2 size={16} strokeWidth={1.75} aria-hidden /> 回滚全部变更
          </Button>
        )}
      </div>

      {phase === 'confirm' && previewOutcomes !== null && (
        <div
          className="rounded border border-subtle bg-surface-2 p-2 space-y-1.5"
          data-testid={`${testId}-rollback-confirm`}
        >
          <div className="font-medium text-primary">确认回滚</div>

          {willRevert.length > 0 && (
            <div>
              <div className="text-status-success">将回滚 {willRevert.length} 处：</div>
              {willRevert.map((o, i) => (
                <div key={`${o.id}-${i}`} className="truncate font-mono text-[11px] text-secondary">
                  {o.path !== '' ? o.path : o.id}
                  {o.result === 'restored-missing' && (
                    <span className="text-tertiary">（文件已缺失，将重建）</span>
                  )}
                </div>
              ))}
            </div>
          )}

          {blocked.length > 0 && (
            <div className="rounded border border-status-warning/40 bg-status-warning-tint px-2 py-1">
              <div className="flex items-center gap-1 text-status-warning">
                <TriangleAlert size={16} strokeWidth={1.75} aria-hidden className="shrink-0" />
                将拦截 {blocked.length} 处（文件在记账后被修改）：
              </div>
              {blocked.map((o, i) => (
                <div key={`${o.id}-${i}`} className="truncate font-mono text-[11px] text-secondary">
                  {o.path}
                </div>
              ))}
            </div>
          )}

          {previewFailed.length > 0 && (
            <div className="rounded border border-status-error/40 bg-status-error-tint px-2 py-1 text-status-error">
              {previewFailed.length} 处无法回滚（数据异常）
            </div>
          )}

          {noopCount > 0 && (
            <div className="text-tertiary">另有 {noopCount} 处无需回滚（已还原或未生效）</div>
          )}

          {unjournaledPaths.length > 0 && (
            <div className="text-tertiary">
              未入账文件（{unjournaledPaths.length} 个，经 shell 或手动修改）不随本次回滚
            </div>
          )}

          {blocked.length > 0 && (
            <label className="flex items-start gap-1.5 text-status-warning">
              <input
                type="checkbox"
                checked={forceOverride}
                onChange={(e) => setForceOverride(e.target.checked)}
                disabled={busy}
                className="mt-0.5"
                data-testid={`${testId}-force-override`}
              />
              <span>强制覆盖已漂移文件（将丢失其后全部变更）</span>
            </label>
          )}

          <div className="text-tertiary">预检为预测结果，以执行时守卫为准</div>

          <div className="flex gap-2 pt-0.5">
            <Button
              variant="danger"
              size="sm"
              disabled={busy}
              onClick={() => void executeRevert()}
              data-testid={`${testId}-rollback-confirm-btn`}
            >
              确认回滚
            </Button>
            <Button variant="secondary" size="sm" disabled={busy} onClick={cancelConfirm}>
              取消
            </Button>
          </div>
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
          testId={`${testId}-rollback-outcomes`}
          renderAction={renderOutcomeAction}
        />
      )}
    </div>
  );
}
