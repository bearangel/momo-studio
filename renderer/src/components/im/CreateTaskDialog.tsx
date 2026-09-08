// renderer/src/components/im/CreateTaskDialog.tsx
//
// 任务创建弹窗（B 子系统 B7；v29 扩展目标三选 + 循环预设）。
//   - 表单字段：标题（必填）/ 描述 / 委派目标（none/agent/team/session 四选 + 联动目标）
//     / 优先级 / 循环规则（单次/固定间隔/每天/每周 + 联动控件）/ 计划开始 / 截止时间
//   - preset 预填：从 agent inline 建议或会话内按钮触发时传入已知的 title/desc/source/assignee
//     （assigneeAgentId 预填时 targetKind 初值置 'agent'）
//   - 提交走 ipc.task.create（v29 扩展入参 targetTeamId/targetSessionId/recurrenceRule），
//     循环规则经 serializeRecurrence 序列化；成功后回调 onCreated(taskId) + onClose
//   - 校验：team/session 目标已选类型但未选具体对象时禁用创建按钮
//   - open=false 时 return null（hooks 仍在调用顺序中，符合 React 规则）
// v2.1：外壳收敛 Dialog 原子件；表单控件换 Input/Select；textarea 无原子件走 token 类。
import { useEffect, useState, type FormEvent } from 'react';
import { ipc } from '../../ipc/client';
import type { WorkspaceAgentMember } from '../../ipc/types';
import { serializeRecurrence, type RecurrencePreset } from '../../lib/recurrence';
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
type TargetKind = 'none' | 'agent' | 'team' | 'session';
type RecurrenceKind = 'once' | 'every' | 'daily' | 'weekly';

export function CreateTaskDialog({ open, onClose, onCreated, workspaceId, preset }: CreateTaskDialogProps) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<Priority>('medium');
  const [assigneeAgentId, setAssigneeAgentId] = useState<string | null>(null);
  const [scheduledAt, setScheduledAt] = useState<string>('');
  const [deadlineAt, setDeadlineAt] = useState<string>('');
  const [assignments, setAssignments] = useState<Array<{ instanceId: string; agentName: string }>>([]);
  const [submitting, setSubmitting] = useState(false);
  const [targetKind, setTargetKind] = useState<TargetKind>('none');
  const [targetTeamId, setTargetTeamId] = useState('');
  const [targetSessionId, setTargetSessionId] = useState('');
  const [recurrenceKind, setRecurrenceKind] = useState<RecurrenceKind>('once');
  const [everyN, setEveryN] = useState('30');
  const [everyUnit, setEveryUnit] = useState<'m' | 'h' | 'd'>('m');
  const [recTime, setRecTime] = useState('09:00');
  const [weekday, setWeekday] = useState('1');
  const [teams, setTeams] = useState<Array<{ id: string; name: string }>>([]);
  const [sessions, setSessions] = useState<Array<{ id: string; title: string }>>([]);

  useEffect(() => {
    if (!open) return;
    setTitle(preset?.title ?? '');
    setDescription(preset?.description ?? '');
    setAssigneeAgentId(preset?.assigneeAgentId ?? null);
    setPriority('medium');
    setScheduledAt('');
    setDeadlineAt('');
    // preset.assigneeAgentId 预填时目标类型直接进 agent 分支，保持旧预填体验
    setTargetKind(preset?.assigneeAgentId ? 'agent' : 'none');
    setTargetTeamId('');
    setTargetSessionId('');
    setRecurrenceKind('once');
    setEveryN('30');
    setEveryUnit('m');
    setRecTime('09:00');
    setWeekday('1');
    ipc.agent.listMembers(workspaceId).then((list: WorkspaceAgentMember[]) => {
      setAssignments(
        list.map((a) => ({ instanceId: a.instanceId, agentName: a.agentName })),
      );
    });
    ipc.team.list(workspaceId).then((list) => setTeams(list.map((t) => ({ id: t.id, name: t.name }))));
    ipc.session.list(workspaceId).then((list) => setSessions(list.map((s) => ({ id: s.id, title: s.title }))));
  }, [open, preset, workspaceId]);

  if (!open) return null;

  // team/session 已选类型但未选具体对象时不可提交（按钮禁用 + submit 双保险）
  const targetMissing =
    (targetKind === 'team' && !targetTeamId) || (targetKind === 'session' && !targetSessionId);

  const handleSubmit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (!title.trim() || submitting || targetMissing) return;
    setSubmitting(true);
    try {
      const priorityNum = priority === 'high' ? 10 : priority === 'medium' ? 5 : 1;
      const rulePreset: RecurrencePreset =
        recurrenceKind === 'every'
          ? // 间隔下限 1：负数/零在序列化前钳制（every:-5m 不匹配 electron 侧
            // nextRun 的 \d+ 解析，循环任务会静默失效）
            { kind: 'every', everyN: Math.max(1, Number(everyN) || 1), everyUnit }
          : recurrenceKind === 'daily'
            ? { kind: 'daily', time: recTime }
            : recurrenceKind === 'weekly'
              ? { kind: 'weekly', weekday: Number(weekday), time: recTime }
              : { kind: 'once' };
      const recurrenceRule = serializeRecurrence(rulePreset);
      const created = await ipc.task.create({
        workspaceId,
        title: title.trim(),
        description,
        priority: priorityNum,
        sourceSessionId: preset?.sourceSessionId ?? null,
        sourceMessageId: preset?.sourceMessageId ?? null,
        assigneeAgentId: targetKind === 'agent' ? assigneeAgentId : null,
        targetTeamId: targetKind === 'team' ? targetTeamId || null : null,
        targetSessionId: targetKind === 'session' ? targetSessionId || null : null,
        recurrenceRule,
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
          label="委派目标类型"
          value={targetKind}
          onChange={(e) => setTargetKind(e.target.value as TargetKind)}
        >
          <option value="none">不指派（存为草稿）</option>
          <option value="agent">agent</option>
          <option value="team">团队</option>
          <option value="session">会话</option>
        </Select>
        {targetKind === 'agent' && (
          <Select
            label="委派目标"
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
        <Select
          label="优先级"
          value={priority}
          onChange={(e) => setPriority(e.target.value as Priority)}
        >
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
          <Input
            label="运行时间"
            type="time"
            value={recTime}
            onChange={(e) => setRecTime(e.target.value)}
          />
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
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose} disabled={submitting}>
            取消
          </Button>
          <Button type="submit" disabled={!title.trim() || submitting || targetMissing}>
            {submitting ? '创建中...' : '创建'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
