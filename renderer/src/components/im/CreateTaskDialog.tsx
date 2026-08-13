// renderer/src/components/im/CreateTaskDialog.tsx
//
// 任务创建弹窗（B 子系统 B7）。
//   - 表单字段：标题（必填）/ 描述 / 指派 agent / 优先级 / 计划开始 / 截止时间
//   - preset 预填：从 agent inline 建议或会话内按钮触发时传入已知的 title/desc/source/assignee
//   - 提交走 ipc.task.create，成功后回调 onCreated(taskId) + onClose
//   - open=false 时 return null（hooks 仍在调用顺序中，符合 React 规则）
import { useEffect, useState } from 'react';
import { ipc } from '../../ipc/client';
import type { AgentAssignment } from '../../ipc/types';

interface CreateTaskDialogProps {
  open: boolean;
  onClose: () => void;
  onCreated: (taskId: string) => void;
  workspaceId: string;
  /** 预填字段（从 agent inline 建议或会话内按钮触发时） */
  preset?: {
    title?: string;
    description?: string;
    sourceRoomId?: string;
    sourceMessageId?: string;
    assigneeAgentId?: string;
  };
}

type Priority = 'low' | 'medium' | 'high';

export function CreateTaskDialog({ open, onClose, onCreated, workspaceId, preset }: CreateTaskDialogProps) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<Priority>('medium');
  const [assigneeAgentId, setAssigneeAgentId] = useState<string | null>(null);
  const [scheduledAt, setScheduledAt] = useState<string>('');
  const [deadlineAt, setDeadlineAt] = useState<string>('');
  const [assignments, setAssignments] = useState<Array<{ instanceId: string; agentName: string }>>([]);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setTitle(preset?.title ?? '');
    setDescription(preset?.description ?? '');
    setAssigneeAgentId(preset?.assigneeAgentId ?? null);
    setPriority('medium');
    setScheduledAt('');
    setDeadlineAt('');
    ipc.agent.listAssignments(workspaceId).then((list: AgentAssignment[]) => {
      setAssignments(
        list.map((a) => ({ instanceId: a.instanceId, agentName: a.agentName ?? a.botMatrixUserId })),
      );
    });
  }, [open, preset, workspaceId]);

  if (!open) return null;

  const handleSubmit = async (): Promise<void> => {
    if (!title.trim() || submitting) return;
    setSubmitting(true);
    try {
      const priorityNum = priority === 'high' ? 10 : priority === 'medium' ? 5 : 1;
      const created = await ipc.task.create({
        workspaceId,
        title: title.trim(),
        description,
        priority: priorityNum,
        sourceRoomId: preset?.sourceRoomId ?? null,
        sourceMessageId: preset?.sourceMessageId ?? null,
        assigneeAgentId,
        scheduledAt: scheduledAt ? new Date(scheduledAt).getTime() : null,
        deadlineAt: deadlineAt ? new Date(deadlineAt).getTime() : null,
      });
      onCreated(created.id);
      onClose();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div style={overlayStyle} onClick={onClose}>
      <div style={dialogStyle} onClick={(e) => e.stopPropagation()}>
        <h3 style={{ marginTop: 0 }}>创建任务</h3>
        <label style={labelStyle}>
          标题*
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            style={inputStyle}
            autoFocus
          />
        </label>
        <label style={labelStyle}>
          描述
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            style={{ ...inputStyle, minHeight: 80 }}
          />
        </label>
        <label style={labelStyle}>
          指派 agent
          <select
            value={assigneeAgentId ?? ''}
            onChange={(e) => setAssigneeAgentId(e.target.value || null)}
            style={inputStyle}
          >
            <option value="">未指派</option>
            {assignments.map((a) => (
              <option key={a.instanceId} value={a.instanceId}>
                {a.agentName}
              </option>
            ))}
          </select>
        </label>
        <label style={labelStyle}>
          优先级
          <select
            value={priority}
            onChange={(e) => setPriority(e.target.value as Priority)}
            style={inputStyle}
          >
            <option value="low">低</option>
            <option value="medium">中</option>
            <option value="high">高</option>
          </select>
        </label>
        <label style={labelStyle}>
          计划开始
          <input
            type="datetime-local"
            value={scheduledAt}
            onChange={(e) => setScheduledAt(e.target.value)}
            style={inputStyle}
          />
        </label>
        <label style={labelStyle}>
          截止时间
          <input
            type="datetime-local"
            value={deadlineAt}
            onChange={(e) => setDeadlineAt(e.target.value)}
            style={inputStyle}
          />
        </label>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12 }}>
          <button type="button" onClick={onClose} disabled={submitting}>
            取消
          </button>
          <button
            type="button"
            onClick={() => void handleSubmit()}
            disabled={!title.trim() || submitting}
            style={primaryButtonStyle}
          >
            {submitting ? '创建中...' : '创建'}
          </button>
        </div>
      </div>
    </div>
  );
}

const overlayStyle: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  backgroundColor: 'rgba(0,0,0,0.5)',
  zIndex: 100,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
};
const dialogStyle: React.CSSProperties = {
  backgroundColor: '#1f2937',
  border: '1px solid #374151',
  borderRadius: 8,
  padding: 20,
  minWidth: 480,
  maxWidth: '90vw',
  maxHeight: '90vh',
  overflowY: 'auto',
};
const labelStyle: React.CSSProperties = {
  display: 'block',
  marginBottom: 12,
  fontSize: 13,
  color: '#9ca3af',
};
const inputStyle: React.CSSProperties = {
  display: 'block',
  width: '100%',
  marginTop: 4,
  padding: '6px 8px',
  backgroundColor: '#111827',
  color: '#e5e7eb',
  border: '1px solid #374151',
  borderRadius: 4,
};
const primaryButtonStyle: React.CSSProperties = {
  padding: '6px 16px',
  backgroundColor: '#3b82f6',
  color: '#fff',
  border: 'none',
  borderRadius: 4,
  cursor: 'pointer',
};
