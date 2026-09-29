// renderer/src/components/im/TurnUndoDialog.tsx
//
// 逐层撤回确认弹窗（rollback UI 重设计 2026-09-28）：
//   - 打开即界定「一组对话」（latestTurn：owner 锚点 + 其后 agent 行）并
//     匹配该组账本条目（base ssi 集合过滤 session scope 条目）
//   - 组内有变更 → 警告弹窗 A：整体还原声明 + 预检分组清单（将还原/删除、
//     漂移黄标、no-op 计数）+ 全局强制勾选；确认 = revert（组内全部 id，
//     整体原子）→ 零 failed 才删气泡（deleteMessages）→ reloadMessages
//   - 组内无变更 → 弹窗 B：仅删除确认
//   - 失败路径：revert 出现 failed 或任一 IPC 抛错 → 停在弹窗内呈现错误，
//     气泡保留（错误不静默；重试走再次点击撤回）
import { useEffect, useMemo, useState } from 'react';
import { Trash2, TriangleAlert } from 'lucide-react';
import { ipc } from '../../ipc/client';
import type { ImMessage, JournalEntryView, RevertOutcome } from '../../ipc/types';
import { latestTurn, type TurnSegment } from '../../lib/turn-segment';
import { useSessionStore } from '../../stores/session.store';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';

interface Props {
  workspaceId: string;
  sessionId: string;
  onClose: () => void;
}

type Phase = 'loading' | 'confirm' | 'busy' | 'error';

export function TurnUndoDialog({ workspaceId, sessionId, onClose }: Props) {
  const [phase, setPhase] = useState<Phase>('loading');
  const [turn, setTurn] = useState<TurnSegment | null>(null);
  const [entries, setEntries] = useState<JournalEntryView[]>([]);
  const [previewOutcomes, setPreviewOutcomes] = useState<RevertOutcome[] | null>(null);
  const [forceOverride, setForceOverride] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<void> => {
      try {
        const messages =
          useSessionStore.getState().messagesBySession.get(sessionId) ?? ([] as ImMessage[]);
        const seg = latestTurn(messages);
        if (seg === null) {
          if (cancelled) return;
          setTurn(null);
          setPhase('error');
          setErrorText('未找到可撤回的对话组');
          return;
        }
        const all = await ipc.journal.list({ workspaceId, sessionId });
        const groupEntries = all.filter((e) => seg.streamIds.includes(e.streamSessionId));
        if (cancelled) return;
        setTurn(seg);
        setEntries(groupEntries);
        if (groupEntries.length > 0) {
          const preview = await ipc.journal.preview(
            workspaceId,
            groupEntries.map((e) => e.id),
          );
          if (cancelled) return;
          setPreviewOutcomes(preview);
        }
        setPhase('confirm');
      } catch (err: unknown) {
        if (cancelled) return;
        setPhase('error');
        setErrorText(err instanceof Error ? err.message : String(err));
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [workspaceId, sessionId]);

  const willRevert = useMemo(
    () =>
      previewOutcomes?.filter((o) => o.result === 'reverted' || o.result === 'restored-missing') ??
      [],
    [previewOutcomes],
  );
  const blocked = useMemo(
    () => previewOutcomes?.filter((o) => o.result === 'skipped-diverged') ?? [],
    [previewOutcomes],
  );
  const noopCount = previewOutcomes?.filter((o) => o.result === 'no-op').length ?? 0;

  const confirm = async (): Promise<void> => {
    if (phase !== 'confirm' || turn === null) return;
    setPhase('busy');
    setErrorText(null);
    try {
      if (entries.length > 0) {
        const outcomes = await ipc.journal.revert(
          workspaceId,
          entries.map((e) => e.id),
          forceOverride ? { force: true } : undefined,
        );
        const failures = outcomes.filter((o) => o.result === 'failed');
        if (failures.length > 0) {
          // 还原失败 → 气泡保留（记录仍是理解失败原因的上下文），错误如实呈现
          setPhase('error');
          setErrorText(
            `${failures.length} 处还原失败：${failures
              .map((f) => `${f.path !== '' ? f.path : f.id}（${f.detail ?? f.result}）`)
              .join('；')}`,
          );
          return;
        }
      }
      await ipc.session.deleteMessages(sessionId, turn.messageIds);
      await useSessionStore.getState().reloadMessages(sessionId);
      onClose();
    } catch (err: unknown) {
      setPhase('error');
      setErrorText(err instanceof Error ? err.message : String(err));
    }
  };

  const hasChanges = entries.length > 0;
  const busy = phase === 'busy';

  return (
    <Dialog
      open
      onClose={busy ? () => undefined : onClose}
      title={hasChanges ? '撤回这组对话？' : '删除这组对话？'}
      width={440}
    >
      {phase === 'loading' && <div className="py-4 text-xs text-tertiary">正在检查这组对话的变更...</div>}

      {phase === 'confirm' && (
        <div className="space-y-2 text-xs" data-testid="turn-undo-confirm">
          <div className="flex items-start gap-2">
            <span className="mt-0.5 shrink-0" aria-hidden>
              {hasChanges ? (
                <TriangleAlert size={16} strokeWidth={1.75} className="text-status-warning" />
              ) : (
                <Trash2 size={16} strokeWidth={1.75} className="text-tertiary" />
              )}
            </span>
            <p className="text-secondary">
              {hasChanges
                ? `删除这组对话（提问 + 回复），并整体还原它修改的 ${new Set(entries.map((e) => e.path)).size} 个文件——不支持只撤单个文件。`
                : '这组对话没有修改任何文件——仅删除提问与回复气泡。'}
            </p>
          </div>

          {hasChanges && previewOutcomes !== null && (
            <div className="space-y-1.5">
              {willRevert.length > 0 && (
                <div>
                  <div className="font-medium text-status-success">将还原 / 删除（{willRevert.length} 处）：</div>
                  {willRevert.map((o, i) => (
                    <div
                      key={`${o.id}-${i}`}
                      className="truncate font-mono text-[11px] text-secondary"
                    >
                      {o.path !== '' ? o.path : o.id}
                      {o.result === 'restored-missing' && (
                        <span className="text-tertiary">（文件已缺失，将重建后撤销）</span>
                      )}
                    </div>
                  ))}
                </div>
              )}
              {blocked.length > 0 && (
                <div className="rounded border border-status-warning/40 bg-status-warning-tint px-2 py-1">
                  <div className="flex items-center gap-1 font-medium text-status-warning">
                    <TriangleAlert size={16} strokeWidth={1.75} aria-hidden className="shrink-0" />
                    将跳过 {blocked.length} 处（文件在记账后被修改）：
                  </div>
                  {blocked.map((o, i) => (
                    <div
                      key={`${o.id}-${i}`}
                      className="truncate font-mono text-[11px] text-secondary"
                    >
                      {o.path}
                    </div>
                  ))}
                  <label className="mt-1 flex items-start gap-1.5 text-status-warning">
                    <input
                      type="checkbox"
                      checked={forceOverride}
                      onChange={(e) => setForceOverride(e.target.checked)}
                      disabled={busy}
                      className="mt-0.5"
                      data-testid="turn-undo-force-override"
                    />
                    <span>强制覆盖已漂移文件（将丢失其后的全部手动修改）</span>
                  </label>
                </div>
              )}
              {noopCount > 0 && (
                <div className="text-tertiary">另有 {noopCount} 处无需还原（已还原或未生效）</div>
              )}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <Button variant="secondary" size="sm" disabled={busy} onClick={onClose}>
              取消
            </Button>
            <Button
              variant="danger"
              size="sm"
              disabled={busy}
              onClick={() => void confirm()}
              data-testid="turn-undo-confirm-btn"
            >
              {hasChanges ? '确认撤回' : '确认删除'}
            </Button>
          </div>
        </div>
      )}

      {phase === 'error' && (
        <div className="space-y-2 text-xs" data-testid="turn-undo-error">
          <div className="rounded border border-status-error/40 bg-status-error-tint px-2 py-1 text-status-error">
            {errorText}
          </div>
          <div className="flex justify-end">
            <Button variant="secondary" size="sm" onClick={onClose}>
              关闭
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}
