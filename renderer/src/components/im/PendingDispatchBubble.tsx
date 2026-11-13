// renderer/src/components/im/PendingDispatchBubble.tsx
//
// 启动期消息排队占位气泡（spec 2026-11-13；预览 .omo/previews/2026-11-13-startup-queue-feedback.html 方案 A）。
//
// 背景：RouterService 要等各 agent 预热池 boot 完才就绪（真机实测 ~50s）。此前该窗口内
// 用户消息只落库不派发、UI 无反馈 → 体感「agent 不回复」。现在主进程入队并推
// session:pendingDispatch，此组件在消息列表底部渲染 agent 侧占位：让用户立刻看到
// 「智能体正在启动」，就绪后占位消失、真实流式回复接管。
//
// 视觉定值（对齐已批准预览，勿随意改）：
//   - 外壳复用 MessageFrame 同款：头像 32px 圆形 bg-surface-2、gap-2、px-4 py-1
//   - 气泡：rounded-lg px-3 py-2 text-sm、bg-surface-2 + border-subtle、max-width 90%
//   - 主行：12px（text-xs）text-secondary + 12px 转圈图标（accent-500，stroke 1.75）
//   - 副行：11px text-tertiary「消息已排队（N 条），就绪后自动发送」
//   - 超时态：主行改 text-status-error「智能体启动超时，请稍后重发」
import { Bot, Loader2 } from 'lucide-react';
import type { PendingDispatchState } from '../../ipc/types';

interface Props {
  state: PendingDispatchState;
}

export function PendingDispatchBubble({ state }: Props): React.JSX.Element {
  const { count, timedOut, agentName, iconEmoji } = state;
  return (
    <div
      className="flex gap-2 px-4 py-1"
      style={{ minWidth: 0, overflow: 'hidden' }}
      data-testid="pending-dispatch-bubble"
    >
      <div
        className="w-8 h-8 shrink-0 rounded-full bg-surface-2 flex items-center justify-center text-base select-none"
        aria-hidden="true"
      >
        {iconEmoji !== '' ? iconEmoji : <Bot size={16} strokeWidth={1.75} className="text-secondary" />}
      </div>
      <div
        className="flex flex-col gap-0.5 items-start"
        style={{ minWidth: 0, maxWidth: '90%', overflow: 'hidden' }}
      >
        {agentName !== '' && <span className="px-1 text-xs text-secondary">{agentName}</span>}
        <div className="rounded-lg px-3 py-2 text-sm break-words bg-surface-2 text-primary border border-subtle">
          {timedOut ? (
            <span className="text-xs text-status-error">智能体启动超时，请稍后重发</span>
          ) : (
            <>
              <span className="flex items-center gap-1.5 text-xs text-secondary">
                <Loader2 size={12} strokeWidth={1.75} className="animate-spin text-accent-500" />
                正在启动智能体
              </span>
              <span className="mt-0.5 block text-[11px] text-tertiary">
                消息已排队{count > 1 ? `（${count} 条）` : ''}，就绪后自动发送
              </span>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
