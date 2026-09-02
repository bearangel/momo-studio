// renderer/src/components/im/ConflictDialog.tsx
//
// 任务冲突处理弹窗（B 子系统 B9）。
//
// 当用户在 execution_room 内 @agent 启动新任务、但当前会话已有 in_progress 任务时，
// runtime-entry 检测到冲突 → 通过 IPC 推 conflict 事件到 renderer → 本弹窗弹出。
//
// 用户从 4 个选项中选一个（与 conflict-resolver.ts 的 5 策略对应，去掉 'ask'——
// 'ask' 就是触发本弹窗本身）。选完后调 ipc.task.resolveConflict 让主进程执行副作用。
// 可选勾选"本会话记住"——勾选后调 ipc.settings.updateSession 把 strategy 写入
// sessions.settings_json 的 conflictStrategy，以后本会话再冲突时自动按此策略处理（不再弹窗）。
// v2.1：⚠️ → CircleAlert 图标；外壳收敛 Dialog 原子件；checkbox 走 Checkbox；样式全 token 类。

import { useState } from 'react';
import { CircleAlert } from 'lucide-react';
import { ipc } from '../../ipc/client';
import { Dialog } from '../ui/Dialog';
import { Button } from '../ui/Button';
import { Checkbox } from '../ui/Checkbox';

type ResolvableStrategy = 'queue' | 'preempt' | 'fork' | 'reject';

interface ConflictDialogProps {
  open: boolean;
  newTaskId: string;
  currentTaskId: string;
  currentRoomId: string;
  onClose: () => void;
  onResolved: (strategy: ResolvableStrategy) => void;
  /** 是否展示"本会话记住"复选框；默认 true。某些调用场景（如一次性冲突）可关闭 */
  rememberChoice?: boolean;
}

export function ConflictDialog({
  open,
  newTaskId,
  currentTaskId,
  currentRoomId,
  onClose,
  onResolved,
  rememberChoice = true,
}: ConflictDialogProps) {
  const [remember, setRemember] = useState(false);

  if (!open) return null;

  const handleChoose = async (strategy: ResolvableStrategy): Promise<void> => {
    if (remember) {
      await ipc.settings.updateSession(currentRoomId, { conflictStrategy: strategy });
    }
    await ipc.task.resolveConflict({ newTaskId, currentTaskId, currentRoomId, strategy });
    onResolved(strategy);
    onClose();
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title="任务冲突"
      width={480}
      footer={
        <Button type="button" variant="ghost" onClick={onClose}>
          关闭
        </Button>
      }
    >
      <div className="flex items-center gap-2 text-status-warning">
        <CircleAlert size={16} strokeWidth={1.75} aria-hidden />
        <p className="text-sm text-secondary">
          当前会话正在执行任务 <strong>#{currentTaskId}</strong>，
          你想启动任务 <strong>#{newTaskId}</strong>。怎么处理？
        </p>
      </div>
      <div className="mt-4 flex flex-col gap-2">
        <button
          type="button"
          onClick={() => void handleChoose('queue')}
          className="w-full rounded border border-subtle bg-surface-2 px-3 py-2 text-left text-[13px] text-primary hover:bg-surface-3"
        >
          ① 排队——等 #{currentTaskId} 完成后自动开始 #{newTaskId}
        </button>
        <button
          type="button"
          onClick={() => void handleChoose('preempt')}
          className="w-full rounded border border-subtle bg-surface-2 px-3 py-2 text-left text-[13px] text-primary hover:bg-surface-3"
        >
          ② 抢占——暂停 #{currentTaskId}，立即开始 #{newTaskId}
        </button>
        <button
          type="button"
          onClick={() => void handleChoose('fork')}
          className="w-full rounded border border-subtle bg-surface-2 px-3 py-2 text-left text-[13px] text-primary hover:bg-surface-3"
        >
          ③ 分流——#{newTaskId} 在新会话执行，#{currentTaskId} 继续在这里
        </button>
        <button
          type="button"
          onClick={() => void handleChoose('reject')}
          className="w-full rounded border border-subtle bg-surface-2 px-3 py-2 text-left text-[13px] text-primary hover:bg-surface-3"
        >
          ④ 取消——不开 #{newTaskId}
        </button>
      </div>
      {rememberChoice && (
        <div className="mt-4">
          <Checkbox
            label="本会话记住选择（以后本会话自动按所选策略处理，不再弹窗）"
            checked={remember}
            onChange={(e) => setRemember(e.target.checked)}
          />
        </div>
      )}
    </Dialog>
  );
}
