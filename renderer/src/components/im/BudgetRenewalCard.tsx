// renderer/src/components/im/BudgetRenewalCard.tsx
//
// 工具预算软续期卡（2026-10-10，预览稿 .omo/previews/budget-renewal.html）。
// 呈现条件：顶层流 final reason='budget_exhausted'（aggregator 聚合为
// awaiting_renewal）。子 agent 流不渲染（PM tool_budget 硬预算，失败回执原语义）。
// 三动作：继续任务（发续作消息，新回合满额预算）/ 本会话无限制（写 session
// maxToolCalls=-1 后续作）/ 就此停止（卡片定格为终态文案）。
import { useState } from 'react';
import { TriangleAlert, Play, Infinity as InfinityIcon } from 'lucide-react';
import { useSessionStore } from '../../stores/session.store';
import { ipc } from '../../ipc/client';

/** 续作指令正文——LLM 与用户均可见（上下文透明），明确「不重做已完成部分」 */
export const BUDGET_RENEWAL_MESSAGE =
  '[预算续期] 工具预算已续期（本回合满额）。请从中断处继续完成之前的任务，不要重做已完成的部分。';

type Handled = 'renewed' | 'unlimited' | 'stopped' | null;

interface Props {
  sessionId: string;
  /** 本回合已消耗的工具调用次数（卡片标题展示） */
  toolCallsUsed: number;
}

export function BudgetRenewalCard({ sessionId, toolCallsUsed }: Props) {
  const [handled, setHandled] = useState<Handled>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sendRenewal = async (): Promise<void> => {
    // 复用现有发消息链路——新回合预算天然满额，无需预算 IPC
    await useSessionStore.getState().sendMessage(BUDGET_RENEWAL_MESSAGE);
  };

  const onRenew = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await sendRenewal();
      setHandled('renewed');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const onUnlimited = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      // 先写会话级无限制（同徽标操作通道），再续作——顺序保证续作回合即无限制
      await ipc.settings.updateSession(sessionId, { maxToolCalls: -1 });
      await sendRenewal();
      setHandled('unlimited');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (handled !== null) {
    const text =
      handled === 'renewed'
        ? '已发送续作指令，任务将在新气泡中继续'
        : handled === 'unlimited'
          ? '本会话已切换为无限制，续作指令已发送'
          : '已停止——本回合到此为止';
    return (
      <div className="mt-2 rounded border border-subtle bg-surface-2 px-2.5 py-1.5">
        <p className="text-[11px] text-tertiary">{text}</p>
      </div>
    );
  }

  return (
    <div className="mt-2 rounded border border-status-warning/40 bg-status-warning-tint px-2.5 py-2">
      <div className="flex items-center gap-1.5 text-xs font-medium text-status-warning">
        <TriangleAlert size={14} strokeWidth={1.75} aria-hidden />
        工具预算已用完（本回合 {toolCallsUsed} 次调用），任务尚未完成
      </div>
      <p className="mt-1 mb-2.5 text-[11px] leading-relaxed text-tertiary">
        本回合工具调用达到上限。续期将以新一轮满额预算继续当前任务；任务体量大时可切换本会话为无限制。
      </p>
      {error !== null && <p className="mb-2 text-[11px] text-status-error">{error}</p>}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => void onRenew()}
          disabled={busy}
          className="inline-flex items-center gap-1.5 rounded bg-accent-600 px-3 py-1 text-xs text-white hover:bg-accent-500 disabled:opacity-40"
        >
          <Play size={13} strokeWidth={2} aria-hidden />
          {busy ? '发送中…' : '继续任务'}
        </button>
        <button
          type="button"
          onClick={() => void onUnlimited()}
          disabled={busy}
          className="inline-flex items-center gap-1.5 rounded border border-subtle bg-transparent px-3 py-1 text-xs text-secondary hover:bg-surface-3 disabled:opacity-40"
        >
          <InfinityIcon size={13} strokeWidth={1.75} aria-hidden />
          本会话无限制
        </button>
        <button
          type="button"
          onClick={() => setHandled('stopped')}
          disabled={busy}
          className="rounded px-1.5 py-1 text-xs text-tertiary hover:text-secondary disabled:opacity-40"
        >
          就此停止
        </button>
      </div>
    </div>
  );
}
