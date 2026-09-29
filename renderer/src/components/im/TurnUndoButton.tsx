// renderer/src/components/im/TurnUndoButton.tsx
//
// 逐层撤回入口（rollback UI 重设计 2026-09-28）：挂在 agent 气泡右下角
// （与 ChangesChip 同排），仅当本气泡是当前会话**最后一条消息**时渲染——
// 即「最新一组对话」的操作锚点。撤回后 store 重载，上一组自然成为最新，
// 按钮随之下移，支持连续剥层。
//
// 纯查看契约：本按钮只负责入口；文件还原预检/确认与气泡删除在 TurnUndoDialog。
import { useState } from 'react';
import { Undo2 } from 'lucide-react';
import { useSessionStore } from '../../stores/session.store';
import type { ImMessage } from '../../ipc/types';
import { TurnUndoDialog } from './TurnUndoDialog';

interface Props {
  message: ImMessage;
}

export function TurnUndoButton({ message }: Props) {
  const [open, setOpen] = useState(false);
  const isLastOfSession = useSessionStore((s) => {
    if (s.activeSessionId === null) return false;
    const msgs = s.messagesBySession.get(s.activeSessionId);
    return msgs !== undefined && msgs.length > 0 && msgs[msgs.length - 1]!.id === message.id;
  });

  if (!isLastOfSession || message.workspaceId === null) return null;

  return (
    <>
      <button
        type="button"
        className="inline-flex h-5 shrink-0 cursor-pointer items-center gap-1 rounded border border-subtle px-1.5 font-sans text-[11px] text-tertiary hover:border-status-error/50 hover:text-status-error"
        onClick={() => setOpen(true)}
        title="撤回这组对话（还原其修改并删除气泡）"
        data-testid="turn-undo-button"
      >
        <Undo2 size={11} strokeWidth={1.75} aria-hidden /> 撤回
      </button>
      {open && (
        <TurnUndoDialog
          workspaceId={message.workspaceId}
          sessionId={message.sessionId}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
