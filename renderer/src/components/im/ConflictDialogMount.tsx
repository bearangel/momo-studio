// renderer/src/components/im/ConflictDialogMount.tsx
//
// 任务冲突弹窗挂载点（I3 修复）。
// 监听主进程 im:conflict 事件，收到冲突信息时渲染 ConflictDialog。
// 用户选完策略后 ConflictDialog 调 task:resolveConflict，主进程执行副作用。
import { useEffect, useState } from 'react';
import { ipc } from '../../ipc/client';
import { ConflictDialog } from './ConflictDialog';

interface ConflictInfo {
  newTaskId: string;
  currentTaskId: string;
  currentRoomId: string;
}

export function ConflictDialogMount() {
  const [conflict, setConflict] = useState<ConflictInfo | null>(null);

  useEffect(() => {
    return ipc.im.onConflict((c) => setConflict(c));
  }, []);

  if (!conflict) return null;

  return (
    <ConflictDialog
      open={true}
      newTaskId={conflict.newTaskId}
      currentTaskId={conflict.currentTaskId}
      currentRoomId={conflict.currentRoomId}
      onClose={() => setConflict(null)}
      onResolved={() => setConflict(null)}
    />
  );
}
