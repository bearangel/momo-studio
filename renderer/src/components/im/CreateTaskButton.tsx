// renderer/src/components/im/CreateTaskButton.tsx
//
// 输入框旁的"创建任务"按钮（B 子系统 B7）。
// 点击打开 CreateTaskDialog，preset 携带 sourceSessionId（任务来源房间）。
// v2.1：📌 → ListPlus 图标；外壳换 IconButton。
import { useState } from 'react';
import { ListPlus } from 'lucide-react';
import { IconButton } from '../ui/IconButton';
import { CreateTaskDialog } from './CreateTaskDialog';

interface CreateTaskButtonProps {
  workspaceId: string;
  sourceSessionId: string;
}

export function CreateTaskButton({ workspaceId, sourceSessionId }: CreateTaskButtonProps) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <IconButton
        aria-label="创建任务"
        onClick={() => setOpen(true)}
        disabled={!workspaceId || !sourceSessionId}
      >
        <ListPlus size={14} strokeWidth={1.75} />
      </IconButton>
      <CreateTaskDialog
        open={open}
        onClose={() => setOpen(false)}
        onCreated={() => {
          /* 可选：未来在此触发 toast 通知 */
        }}
        workspaceId={workspaceId}
        preset={{ sourceSessionId }}
      />
    </>
  );
}
