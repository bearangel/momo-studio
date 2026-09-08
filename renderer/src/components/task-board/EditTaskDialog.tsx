// renderer/src/components/task-board/EditTaskDialog.tsx
//
// 任务编辑对话框（K5：此前任务创建后无任何编辑入口——标题/描述/优先级/
// 委派目标/计划时间全部不可改）。字段布局与 CreateTaskDialog 同构；
// 打开时按现有 TaskRow 预填（循环规则经 parseRecurrence 反解析到控件），
// 提交走 task.store.update（后端 task:update 剥离 status，状态仍由
// transition 通道独占——编辑不会误触状态机）。
// 仅非终态任务渲染入口（终态任务的执行事实已定，编辑元数据无意义）。
import { useEffect, useState, type FormEvent } from 'react';
import { useTaskStore } from '../../stores/task.store';
import { ipc } from '../../ipc/client';
import type { TaskRow, WorkspaceAgentMember } from '../../ipc/types';
import { parseRecurrence, serializeRecurrence, type RecurrencePreset } from '../../lib/recurrence';
import { Dialog } from '../ui/Dialog';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { Select } from '../ui/Select';

interface EditTaskDialogProps {
  open: boolean;
  onClose: () => void;
  /** 编辑成功后回调（详情面板据此刷新单条） */
  onSaved: () => void;
  task: TaskRow;
  workspaceId: string;
}

type Priority = 'low' | 'medium' | 'high';
type TargetKind = 'none' | 'agent' | 'team' | 'session';
type RecurrenceKind = 'once' | 'every' | 'daily' | 'weekly';

/** ms 时间戳 → datetime-local 输入值（秒级 ISO）；null → 空串 */
function toDatetimeLocal(ms: number | null): string {
  if (ms == null) return '';
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function priorityToLabel(p: number): Priority {
  if (p >= 10) return 'high';
  if (p >= 5) return 'medium';
  return 'low';
}

export function EditTaskDialog({ open, onClose, onSaved, task, workspaceId }: EditTaskDialogProps) {
  const update = useTaskStore((s) => s.update);
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description);
  const [priority, setPriority] = useState<Priority>(priorityToLabel(task.priority));
  const [targetKind, setTargetKind] = useState<TargetKind>(
    task.assigneeAgentId ? 'agent' : task.targetTeamId ? 'team' : task.targetSessionId ? 'session' : 'none',
  );
  const [assigneeAgentId, setAssigneeAgentId] = useState<string>(
    task.assigneeAgentId ?? '',
  );
  const [targetTeamId, setTargetTeamId] = useState(task.targetTeamId ?? '');
  const [targetSessionId, setTargetSessionId] = useState(task.targetSessionId ?? '');
  const [scheduledAt, setScheduledAt] = useState(toDatetimeLocal(task.scheduledAt));
  const [deadlineAt, setDeadlineAt] = useState(toDatetimeLocal(task.deadlineAt));
  const preset = parseRecurrence(task.recurrenceRule);
  const [recurrenceKind, setRecurrenceKind] = useState<RecurrenceKind>(preset.kind);
  const [everyN, setEveryN] = useState(String(preset.everyN ?? 30));
  const [everyUnit, setEveryUnit] = useState<'m' | 'h' | 'd'>(preset.everyUnit ?? 'm');
  const [recTime, setRecTime] = useState(preset.time ?? '09:00');
  const [weekday, setWeekday] = useState(String(preset.weekday ?? 1));
  const [assignments, setAssignments] = useState<Array<{ instanceId: string; agentName: string }>>([]);
  const [teams, setTeams] = useState<Array<{ id: string; name: string }>>([]);
  const [sessions, setSessions] = useState<Array<{ id: string; title: string }>>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 预填是「打开瞬间的快照」——依赖收窄到 open：父组件（TaskDetailPanel）
  // 5s 轮询会用新对象引用刷新 task prop，若 task 留在依赖里，用户填写中的
  // 表单会被外部快照静默重置（K8：委派目标选型被打回「不指派」）。
  // task/workspaceId 读闭包捕获的打开瞬间值；重新打开（open false→true）自然重取最新
  useEffect(() => {
    if (!open) return;
    setTitle(task.title);
    setDescription(task.description);
    setPriority(priorityToLabel(task.priority));
    setTargetKind(
      task.assigneeAgentId ? 'agent' : task.targetTeamId ? 'team' : task.targetSessionId ? 'session' : 'none',
    );
    setAssigneeAgentId(task.assigneeAgentId ?? '');
    setTargetTeamId(task.targetTeamId ?? '');
    setTargetSessionId(task.targetSessionId ?? '');
    setScheduledAt(toDatetimeLocal(task.scheduledAt));
    setDeadlineAt(toDatetimeLocal(task.deadlineAt));
    const p = parseRecurrence(task.recurrenceRule);
    setRecurrenceKind(p.kind);
    setEveryN(String(p.everyN ?? 30));
    setEveryUnit(p.everyUnit ?? 'm');
    setRecTime(p.time ?? '09:00');
    setWeekday(String(p.weekday ?? 1));
    setError(null);
    ipc.agent.listMembers(workspaceId).then((list: WorkspaceAgentMember[]) => {
      setAssignments(list.map((a) => ({ instanceId: a.instanceId, agentName: a.agentName })));
    });
    ipc.team.list(workspaceId).then((list) => setTeams(list.map((t) => ({ id: t.id, name: t.name }))));
    ipc.session.list(workspaceId).then((list) => setSessions(list.map((s) => ({ id: s.id, title: s.title }))));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;

  const targetMissing =
    (targetKind === 'agent' && !assigneeAgentId) ||
    (targetKind === 'team' && !targetTeamId) ||
    (targetKind === 'session' && !targetSessionId);

  const handleSubmit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (!title.trim() || submitting || targetMissing) return;
    setSubmitting(true);
    setError(null);
    try {
      const priorityNum = priority === 'high' ? 10 : priority === 'medium' ? 5 : 1;
      const rulePreset: RecurrencePreset =
        recurrenceKind === 'every'
          ? { kind: 'every', everyN: Math.max(1, Number(everyN) || 1), everyUnit }
          : recurrenceKind === 'daily'
            ? { kind: 'daily', time: recTime }
            : recurrenceKind === 'weekly'
              ? { kind: 'weekly', weekday: Number(weekday), time: recTime }
              : { kind: 'once' };
      await update(task.id, {
        title: title.trim(),
        description,
        priority: priorityNum,
        assigneeAgentId: targetKind === 'agent' ? assigneeAgentId : null,
        targetTeamId: targetKind === 'team' ? targetTeamId : null,
        targetSessionId: targetKind === 'session' ? targetSessionId : null,
        recurrenceRule: serializeRecurrence(rulePreset),
        scheduledAt: scheduledAt ? new Date(scheduledAt).getTime() : null,
        deadlineAt: deadlineAt ? new Date(deadlineAt).getTime() : null,
      });
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open onClose={onClose} title={`编辑任务 #${task.id}`} width={480}>
      <form onSubmit={handleSubmit} className="flex flex-col gap-3">
        <Input label="标题*" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
        <div className="flex flex-col gap-1">
          <label htmlFor="edit-task-desc" className="text-sm text-secondary">
            描述
          </label>
          <textarea
            id="edit-task-desc"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className="mt-1 min-h-[80px] w-full rounded border border-subtle bg-surface-2 px-3 py-2 text-[13px] text-primary focus:border-focus focus:outline-none"
          />
        </div>
        <Select
          label="委派目标类型"
          value={targetKind}
          onChange={(e) => setTargetKind(e.target.value as TargetKind)}
        >
          <option value="none">不指派</option>
          <option value="agent">agent</option>
          <option value="team">团队</option>
          <option value="session">会话</option>
        </Select>
        {targetKind === 'agent' && (
          <Select
            label="委派目标"
            value={assigneeAgentId}
            onChange={(e) => setAssigneeAgentId(e.target.value)}
          >
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
          <Select
            label="委派目标"
            value={targetSessionId}
            onChange={(e) => setTargetSessionId(e.target.value)}
          >
            <option value="">请选择会话</option>
            {sessions.map((s) => (
              <option key={s.id} value={s.id}>
                {s.title}
              </option>
            ))}
          </Select>
        )}
        <Select label="优先级" value={priority} onChange={(e) => setPriority(e.target.value as Priority)}>
          <option value="low">低</option>
          <option value="medium">中</option>
          <option value="high">高</option>
        </Select>
        <Select
          label="循环规则"
          value={recurrenceKind}
          onChange={(e) => setRecurrenceKind(e.target.value as RecurrenceKind)}
        >
          <option value="once">单次</option>
          <option value="every">固定间隔</option>
          <option value="daily">每天</option>
          <option value="weekly">每周</option>
        </Select>
        {recurrenceKind === 'every' && (
          <div className="flex gap-2">
            <Input
              label="间隔数值"
              type="number"
              min={1}
              value={everyN}
              onChange={(e) => setEveryN(e.target.value)}
            />
            <Select
              label="单位"
              value={everyUnit}
              onChange={(e) => setEveryUnit(e.target.value as 'm' | 'h' | 'd')}
            >
              <option value="m">分钟</option>
              <option value="h">小时</option>
              <option value="d">天</option>
            </Select>
          </div>
        )}
        {(recurrenceKind === 'daily' || recurrenceKind === 'weekly') && (
          <Input label="运行时间" type="time" value={recTime} onChange={(e) => setRecTime(e.target.value)} />
        )}
        {recurrenceKind === 'weekly' && (
          <Select label="星期" value={weekday} onChange={(e) => setWeekday(e.target.value)}>
            {['一', '二', '三', '四', '五', '六', '日'].map((d, i) => (
              // 编码契约：1=周一 … 6=周六 0=周日（与 recurrence.ts WEEKDAY_LABEL 对齐）
              <option key={d} value={String((i + 1) % 7)}>{`周${d}`}</option>
            ))}
          </Select>
        )}
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
        {error && <div className="text-xs text-status-error">{error}</div>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose} disabled={submitting}>
            取消
          </Button>
          <Button type="submit" disabled={!title.trim() || submitting || targetMissing}>
            {submitting ? '保存中...' : '保存'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
