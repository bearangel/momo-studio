// renderer/src/components/task-board/AssignTargetDialog.tsx
//
// 指派并放入队列（泳道语义重构 spec 2026-09-30 §4.4，预览已确认：
// .omo/previews/assign-target-dialog.html）：无目标 draft 拖入「排队中」列时
// 由 useBoardDrop 拦截弹本框——补齐委派目标（+可选计划时间）后入队。
//   - 确定：update 互斥目标三列（+scheduledAt 若填写）→ move(排队中, 落点组)；
//     失败 toast 后关闭（目标已写入可重试，卡片留待办）
//   - 取消：零副作用（调用方 cancelAssign 清拦截态，不发任何 IPC）
//   - 计划时间语义：不填=并发有空位立即执行；填未来时间=入队后由 executor
//     闸门到点放行（min=当前时间防填过去）
import { useEffect, useState, type FormEvent } from 'react';
import { ipc } from '../../ipc/client';
import type { TaskRow } from '../../ipc/types';
import { Dialog } from '../ui/Dialog';
import { Input } from '../ui/Input';
import { Select } from '../ui/Select';
import { Button } from '../ui/Button';
import { showToast } from '../ui/Toast';

type TargetKind = 'agent' | 'team' | 'session';

interface AssignTargetDialogProps {
  open: boolean;
  taskId: string;
  /** 拖拽落点组（resolution.groupId 透传；null=未分组道/保原组语义） */
  groupId: string | null;
  workspaceId: string;
  /** 确定（含失败路径）与取消统一走 onCancel——调用方据此清拦截态 */
  onCancel: () => void;
}

/** 当前时间 → datetime-local 串（YYYY-MM-DDTHH:mm，本地时区） */
function nowLocalInput(): string {
  return toLocalInput(Date.now());
}

function toLocalInput(ms: number): string {
  const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60_000);
  return d.toISOString().slice(0, 16);
}

export function AssignTargetDialog({ open, taskId, groupId, workspaceId, onCancel }: AssignTargetDialogProps) {
  const [task, setTask] = useState<TaskRow | null>(null);
  const [targetKind, setTargetKind] = useState<TargetKind>('agent');
  const [assigneeAgentId, setAssigneeAgentId] = useState('');
  const [targetTeamId, setTargetTeamId] = useState('');
  const [targetSessionId, setTargetSessionId] = useState('');
  const [scheduledAt, setScheduledAt] = useState('');
  const [assignments, setAssignments] = useState<Array<{ instanceId: string; agentName: string }>>([]);
  const [teams, setTeams] = useState<Array<{ id: string; name: string }>>([]);
  const [sessions, setSessions] = useState<Array<{ id: string; title: string }>>([]);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setTargetKind('agent');
    setAssigneeAgentId('');
    setTargetTeamId('');
    setTargetSessionId('');
    setSubmitting(false);
    // 任务行：标题副文案 + 计划时间预填（get 失败保持空壳，不阻塞指派）
    ipc.task
      .get(taskId)
      .then((t) => {
        if (t) {
          setTask(t);
          setScheduledAt(t.scheduledAt != null ? toLocalInput(t.scheduledAt) : '');
        }
      })
      .catch(() => {});
    // 三类目标选项与 CreateTaskDialog 同源
    ipc.agent
      .listMembers(workspaceId)
      .then((list) => setAssignments(list.map((a) => ({ instanceId: a.instanceId, agentName: a.agentName }))))
      .catch(() => {});
    ipc.team.list(workspaceId).then((list) => setTeams(list.map((t) => ({ id: t.id, name: t.name })))).catch(() => {});
    ipc.session
      .list(workspaceId)
      .then((list) => setSessions(list.map((s) => ({ id: s.id, title: s.title }))))
      .catch(() => {});
  }, [open, taskId, workspaceId]);

  if (!open) return null;

  const targetMissing =
    (targetKind === 'agent' && !assigneeAgentId) ||
    (targetKind === 'team' && !targetTeamId) ||
    (targetKind === 'session' && !targetSessionId);

  const handleSubmit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (targetMissing || submitting) return;
    setSubmitting(true);
    try {
      // 第一步：写互斥目标三列（+计划时间；未填=null 清残留）
      await ipc.task.update(taskId, {
        assigneeAgentId: targetKind === 'agent' ? assigneeAgentId : null,
        targetTeamId: targetKind === 'team' ? targetTeamId : null,
        targetSessionId: targetKind === 'session' ? targetSessionId : null,
        scheduledAt: scheduledAt ? new Date(scheduledAt).getTime() : null,
      });
      // 第二步：move 入队（executeMove 单点：目标校验/转 assigned/notify）
      await ipc.task.move(taskId, { column: 'assigned', groupId });
    } catch (err) {
      // 目标已写入可重试——toast 原因后照常关闭（卡片留待办，重拖即重新指派）
      showToast(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
      onCancel();
    }
  };

  return (
    <Dialog open onClose={onCancel} title="指派并放入队列" width={480}>
      <form onSubmit={handleSubmit} className="flex flex-col gap-3">
        <div className="text-xs text-secondary">
          任务{' '}
          <span className="font-medium text-accent-600 dark:text-accent-300">
            #{taskId} · {task?.title ?? '…'}
          </span>{' '}
          将进入「排队中」，由调度器按并发与计划时间放行
        </div>
        <Select label="委派类型" value={targetKind} onChange={(e) => setTargetKind(e.target.value as TargetKind)}>
          <option value="agent">agent</option>
          <option value="team">团队</option>
          <option value="session">会话</option>
        </Select>
        {targetKind === 'agent' && (
          <Select label="委派目标" value={assigneeAgentId} onChange={(e) => setAssigneeAgentId(e.target.value)}>
            <option value="">请选择 agent</option>
            {assignments.map((a) => (
              <option key={a.instanceId} value={a.instanceId}>
                {a.agentName}
              </option>
            ))}
          </Select>
        )}
        {targetKind === 'team' && (
          <Select label="委派目标" value={targetTeamId} onChange={(e) => setTargetTeamId(e.target.value)}>
            <option value="">请选择团队</option>
            {teams.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </Select>
        )}
        {targetKind === 'session' && (
          <Select label="委派目标" value={targetSessionId} onChange={(e) => setTargetSessionId(e.target.value)}>
            <option value="">请选择会话</option>
            {sessions.map((s) => (
              <option key={s.id} value={s.id}>
                {s.title}
              </option>
            ))}
          </Select>
        )}
        <div>
          <Input
            label="计划时间（可选）"
            type="datetime-local"
            min={nowLocalInput()}
            value={scheduledAt}
            onChange={(e) => setScheduledAt(e.target.value)}
          />
          <div className="mt-1 text-[11px] text-tertiary">
            不填 = 并发有空位立即执行；填未来时间 = 到点自动执行
          </div>
        </div>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onCancel} disabled={submitting}>
            取消
          </Button>
          <Button type="submit" disabled={targetMissing || submitting}>
            {submitting ? '入队中...' : '放入队列'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
