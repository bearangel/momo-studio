// renderer/src/components/im/ConflictDialog.tsx
//
// 任务冲突处理弹窗（B 子系统 B9）。
//
// 当用户在 execution_room 内 @agent 启动新任务、但当前会话已有 in_progress 任务时，
// runtime-entry 检测到冲突 → 通过 IPC 推 conflict 事件到 renderer → 本弹窗弹出。
//
// 用户从 4 个选项中选一个（与 conflict-resolver.ts 的 5 策略对应，去掉 'ask'——
// 'ask' 就是触发本弹窗本身）。选完后调 ipc.task.resolveConflict 让主进程执行副作用。
// 可选勾选"本会话记住"——勾选后调 ipc.settings.updateRoom 把 strategy 写入
// room_settings.conflict_strategy，以后本会话再冲突时自动按此策略处理（不再弹窗）。

import { useState } from 'react';
import type { CSSProperties } from 'react';
import { ipc } from '../../ipc/client';

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
    <div
      style={overlayStyle}
      data-testid="conflict-overlay"
      onClick={onClose}
    >
      <div style={dialogStyle} onClick={(e) => e.stopPropagation()}>
        <h3 style={{ marginTop: 0 }}>⚠️ 任务冲突</h3>
        <p style={{ fontSize: 14, color: '#9ca3af', margin: '8px 0 0' }}>
          当前会话正在执行任务 <strong>#{currentTaskId}</strong>，
          你想启动任务 <strong>#{newTaskId}</strong>。怎么处理？
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 16 }}>
          <button type="button" onClick={() => void handleChoose('queue')} style={optionButtonStyle}>
            ① 排队——等 #{currentTaskId} 完成后自动开始 #{newTaskId}
          </button>
          <button type="button" onClick={() => void handleChoose('preempt')} style={optionButtonStyle}>
            ② 抢占——暂停 #{currentTaskId}，立即开始 #{newTaskId}
          </button>
          <button type="button" onClick={() => void handleChoose('fork')} style={optionButtonStyle}>
            ③ 分流——#{newTaskId} 在新会话执行，#{currentTaskId} 继续在这里
          </button>
          <button type="button" onClick={() => void handleChoose('reject')} style={optionButtonStyle}>
            ④ 取消——不开 #{newTaskId}
          </button>
        </div>
        {rememberChoice && (
          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              marginTop: 16,
              fontSize: 12,
              color: '#9ca3af',
            }}
          >
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
            />
            本会话记住选择（以后本会话自动按所选策略处理，不再弹窗）
          </label>
        )}
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 12 }}>
          <button type="button" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}

const overlayStyle: CSSProperties = {
  position: 'fixed',
  inset: 0,
  backgroundColor: 'rgba(0,0,0,0.5)',
  zIndex: 100,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
};
const dialogStyle: CSSProperties = {
  backgroundColor: '#1f2937',
  border: '1px solid #374151',
  borderRadius: 8,
  padding: 20,
  minWidth: 480,
  maxWidth: '90vw',
  color: '#e5e7eb',
};
const optionButtonStyle: CSSProperties = {
  padding: '8px 12px',
  textAlign: 'left',
  cursor: 'pointer',
  backgroundColor: '#111827',
  color: '#e5e7eb',
  border: '1px solid #374151',
  borderRadius: 4,
};
