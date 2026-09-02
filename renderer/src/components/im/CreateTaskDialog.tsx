// renderer/src/components/im/CreateTaskDialog.tsx
//
// 任务创建弹窗（B 子系统 B7）。
//   - 表单字段：标题（必填）/ 描述 / 指派 agent / 优先级 / 计划开始 / 截止时间
//   - preset 预填：从 agent inline 建议或会话内按钮触发时传入已知的 title/desc/source/assignee
//   - 提交走 ipc.task.create，成功后回调 onCreated(taskId) + onClose
//   - open=false 时 return null（hooks 仍在调用顺序中，符合 React 规则）
// v2.1：外壳收敛 Dialog 原子件；表单控件换 Input/Select；textarea 无原子件走 token 类。
import { useEffect, useState, type FormEvent } from 'react';
import { ipc } from '../../ipc/client';
import type { WorkspaceAgentMember } from '../../ipc/types';
import { Dialog } from '../ui/Dialog';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { Select } from '../ui/Select';

interface CreateTaskDialogProps {
  open: boolean;
  onClose: () => void;
  onCreated: (taskId: string) => void;
  workspaceId: string;
  /** 预填字段（从 agent inline 建议或会话内按钮触发时） */
  preset?: {
    title?: string;
    description?: string;
    sourceSessionId?: string;
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
    ipc.agent.listMembers(workspaceId).then((list: WorkspaceAgentMember[]) => {
      setAssignments(
        list.map((a) => ({ instanceId: a.instanceId, agentName: a.agentName ?? a.agentUserId })),
      );
    });
  }, [open, preset, workspaceId]);

  if (!open) return null;

  const handleSubmit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (!title.trim() || submitting) return;
    setSubmitting(true);
    try {
      const priorityNum = priority === 'high' ? 10 : priority === 'medium' ? 5 : 1;
      const created = await ipc.task.create({
        workspaceId,
        title: title.trim(),
        description,
        priority: priorityNum,
        sourceSessionId: preset?.sourceSessionId ?? null,
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
    <Dialog open onClose={onClose} title="创建任务" width={480}>
      <form onSubmit={handleSubmit} className="flex flex-col gap-3">
        <Input
          label="标题*"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          autoFocus
        />
        <div className="flex flex-col gap-1">
          <label htmlFor="create-task-desc" className="text-sm text-secondary">
            描述
          </label>
          <textarea
            id="create-task-desc"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className="mt-1 min-h-[80px] w-full rounded border border-subtle bg-surface-2 px-3 py-2 text-[13px] text-primary focus:border-focus focus:outline-none"
          />
        </div>
        <Select
          label="指派 agent"
          value={assigneeAgentId ?? ''}
          onChange={(e) => setAssigneeAgentId(e.target.value || null)}
        >
          <option value="">未指派</option>
          {assignments.map((a) => (
            <option key={a.instanceId} value={a.instanceId}>
              {a.agentName}
            </option>
          ))}
        </Select>
        <Select
          label="优先级"
          value={priority}
          onChange={(e) => setPriority(e.target.value as Priority)}
        >
          <option value="low">低</option>
          <option value="medium">中</option>
          <option value="high">高</option>
        </Select>
        <Input
          label="计划开始"
          type="datetime-local"
          value={scheduledAt}
          onChange={(e) => setScheduledAt(e.target.value)}
        />
        <Input
          label="截止时间"
          type="datetime-local"
          value={deadlineAt}
          onChange={(e) => setDeadlineAt(e.target.value)}
        />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose} disabled={submitting}>
            取消
          </Button>
          <Button type="submit" disabled={!title.trim() || submitting}>
            {submitting ? '创建中...' : '创建'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
