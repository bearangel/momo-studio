// renderer/src/components/im/CreateTaskButton.tsx
//
// 输入框旁的"创建任务"按钮（B 子系统 B7）。
// 点击打开 CreateTaskDialog，preset 携带 sourceRoomId（任务来源房间）。
import { useState } from 'react';
import { CreateTaskDialog } from './CreateTaskDialog';

interface CreateTaskButtonProps {
  workspaceId: string;
  sourceRoomId: string;
}

export function CreateTaskButton({ workspaceId, sourceRoomId }: CreateTaskButtonProps) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="创建任务"
        style={buttonStyle}
        disabled={!workspaceId || !sourceRoomId}
      >
        📌
      </button>
      <CreateTaskDialog
        open={open}
        onClose={() => setOpen(false)}
        onCreated={() => {
          /* 可选：未来在此触发 toast 通知 */
        }}
        workspaceId={workspaceId}
        preset={{ sourceRoomId }}
      />
    </>
  );
}

const buttonStyle: React.CSSProperties = {
  padding: '4px 8px',
  background: 'transparent',
  border: '1px solid #374151',
  borderRadius: 4,
  cursor: 'pointer',
  fontSize: 16,
  lineHeight: 1,
};
