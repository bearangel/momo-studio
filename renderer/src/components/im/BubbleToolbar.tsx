// renderer/src/components/im/BubbleToolbar.tsx
//
// 气泡工具条（2026-09-28 回滚 UI 演进约定）：agent 气泡底部状态行右侧的
// 动作簇——气泡级动作的统一扩展点，后续新动作一律加在这里。
// 现有动作：
//   - 停止（流式中，替代动作簇位置）
//   - 撤回（仅会话最新一组对话的气泡且终态非 aborted——整组事务入口）
//   - 复制（与撤回同排常显；hover 提亮为中性 primary——与撤回的
//     destructive 红色 hover 构成语义区分）
import { Square } from 'lucide-react';
import { ipc } from '../../ipc/client';
import type { ImMessage } from '../../ipc/types';
import { Button } from '../ui/Button';
import { CopyButton } from '../ui/CopyButton';
import { TurnUndoButton } from './TurnUndoButton';

interface Props {
  message: ImMessage;
  isStreaming: boolean;
  /** 终态且非 aborted（撤回入口的挂载条件） */
  canUndo: boolean;
}

export function BubbleToolbar({ message, isStreaming, canUndo }: Props) {
  if (isStreaming) {
    return (
      <Button
        variant="secondary"
        size="sm"
        className="ml-auto"
        onClick={() => {
          if (message.streamSessionId) {
            void ipc.agent.abortStream(message.streamSessionId);
          }
        }}
      >
        <Square size={11} strokeWidth={1.75} aria-hidden /> 停止
      </Button>
    );
  }
  return (
    <div className="ml-auto flex items-center gap-1.5" data-testid="bubble-toolbar">
      {canUndo && <TurnUndoButton message={message} />}
      <CopyButton text={message.body} className="hover:border-strong hover:text-primary" />
    </div>
  );
}
