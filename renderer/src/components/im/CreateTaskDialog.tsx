// renderer/src/components/im/CreateTaskDialog.tsx
//
// 任务创建弹窗（B 子系统 B7；v29 扩展目标三选 + 循环预设；M2.1 T8 扩展单/批量与执行位置）。
//   - 模式 seg（头部）：单任务（标题/描述/委派目标/分组/优先级/循环/计划开始）/
//     批量（多行任务书 textarea，每行一任务书，空行跳过；S2 合同字段集=任务书+执行位置）
//   - 执行位置区（传 workspaceName 才渲染）：RunRoutingField 三 radio 卡行（守门降级
//     见该组件）；外派模式（group/node）下本地委派字段退场——S2 单任务合同只留
//     标题/任务书/执行位置
//   - 提交分流：local → 本机批量走单 IPC task:createBatch（M3.3 替换逐行循环，
//     per-item union 错误展示沿用既有 per-line UI）；单任务 local 走既有
//     ipc.task.create（标题支持同款 `::` 依赖后缀）；group/node →
//     ipc.hub.submitRoutedTask（hub 无批量/依赖通道，逐行循环保持——每次提交重跑调度，
//     `::` 后缀在外派路径不解析，整行原样为标题）
//   - `::` 依赖行语法（M3.3 spec §2.2 最小面）：`标题 :: T-1,T-2` 双冒号+逗号分隔，
//     可省略——无后缀行解析零变化（测试锁）；单任务模式用同输入框后缀语法，
//     无新控件（P2 口径：纯输入语法扩展，无布局语言变化——spec 定稿授权）
//   - preset 预填：从 agent inline 建议或会话内按钮触发时传入已知字段
//   - open=false 时 return null（hooks 仍在调用顺序中，符合 React 规则）
// v2.1：外壳收敛 Dialog 原子件；表单控件换 Input/Select；textarea 无原子件走 token 类。
import { useEffect, useState, type FormEvent } from 'react';
import { X } from 'lucide-react';
import { ipc } from '../../ipc/client';
import type { PermissionTier, RoutingPrecheckResult, TaskCreateBatchResult, TaskRouting, WorkspaceAgentMember } from '../../ipc/types';
import { serializeRecurrence, type RecurrencePreset } from '../../lib/recurrence';
import { useGroupStore } from '../../stores/group.store';
import { useTaskStore } from '../../stores/task.store';
import { Dialog } from '../ui/Dialog';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { Select } from '../ui/Select';
import { Segmented } from '../ui/Segmented';
import { RunRoutingField } from '../workgroup/RunRoutingField';
import { showToast } from '../ui/Toast';

interface CreateTaskDialogProps {
  open: boolean;
  onClose: () => void;
  onCreated: (taskId: string) => void;
  workspaceId: string;
  /**
   * 工作空间名（M2.1 T8 执行位置守门 + 外派载荷 workspaceName）。
   * 未传 = 不渲染执行位置区，弹窗行为与 T8 前完全一致（会话内入口等无路由场景）
   */
  workspaceName?: string;
  /** 预填字段（从 agent inline 建议或会话内按钮触发时） */
  preset?: {
    title?: string;
    description?: string;
    sourceSessionId?: string;
    sourceMessageId?: string;
    assigneeAgentId?: string;
  };
  /**
   * 分组默认值（看板选中分组时传入，TaskBoardView 的 activeGroupId 已带
   * 悬空守卫）；'' / null / 未传 = 默认「不分组」。primitive 入 deps——
   * 不放 preset（对象身份每渲染变，会连带重置其余表单字段）
   */
  defaultGroupId?: string | null;
}

type Priority = 'low' | 'medium' | 'high';
type TargetKind = 'none' | 'agent' | 'team' | 'session';
type RecurrenceKind = 'once' | 'every' | 'daily' | 'weekly';
type CreateMode = 'single' | 'batch';

// ── M3.3 `::` 依赖行语法解析（spec §2.2 最小面，批量行与单任务标题共用）────────

/** 任务 id 形状：T-<seq>（本地建行与 worker 镜像行统一落此形状） */
const TASK_ID_RE = /^T-\d+$/;
/** 依赖后缀分隔符（`标题 :: T-1,T-2`）——lastIndexOf 取末次出现，标题内含
 *  C++ 风格 `::`（如 std::vector）不被误切 */
const DEPS_SEP = '::';

export interface ParsedTaskLine {
  title: string;
  /** 依赖任务 id 列表；行内无合法 `::` 后缀时空数组 */
  dependsOn: string[];
}

/**
 * 解析一行任务书：`标题 :: T-1,T-2` → { title, dependsOn }。
 * 后缀可省略——不含合法后缀的行（无 `::` / 后缀空 / 依赖项非 T-id 形状 / 标题段空）
 * 一律整行原样为标题、dependsOn 空，**解析结果与扩展前完全一致**（零变化锁）。
 */
export function parseTaskLine(line: string): ParsedTaskLine {
  const trimmed = line.trim();
  const idx = trimmed.lastIndexOf(DEPS_SEP);
  if (idx === -1) return { title: trimmed, dependsOn: [] };
  const title = trimmed.slice(0, idx).trim();
  const depIds = trimmed
    .slice(idx + DEPS_SEP.length)
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  if (title === '' || depIds.length === 0 || !depIds.every((id) => TASK_ID_RE.test(id))) {
    return { title: trimmed, dependsOn: [] };
  }
  return { title, dependsOn: depIds };
}

export function CreateTaskDialog({ open, onClose, onCreated, workspaceId, workspaceName, preset, defaultGroupId }: CreateTaskDialogProps) {
  const [mode, setMode] = useState<CreateMode>('single');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<Priority>('medium');
  const [assigneeAgentId, setAssigneeAgentId] = useState<string | null>(null);
  const [scheduledAt, setScheduledAt] = useState<string>('');
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
  const [groupId, setGroupId] = useState('');
  const [batchText, setBatchText] = useState('');
  const [batchError, setBatchError] = useState<string | null>(null);
  // M2.2 P2-2：目标并发上限预检口径（本机委派设置——各节点自管，leader 只能以
  // 本机设置近似；拉取失败静默降级缺省 2，不阻塞弹窗）
  const [maxConcurrent, setMaxConcurrent] = useState(2);
  const [routing, setRouting] = useState<TaskRouting>({ mode: 'local' });
  const [permissionTier, setPermissionTier] = useState<PermissionTier>('confirm');
  const [precheck, setPrecheck] = useState<RoutingPrecheckResult | null>(null);
  const groups = useGroupStore((s) => s.groups);
  const loadGroups = useGroupStore((s) => s.load);

  const routingAvailable = workspaceName !== undefined && workspaceName !== '';
  const remoteRouting = routing.mode !== 'local';
  const batchLines = batchText.split('\n').map((l) => l.trim()).filter((l) => l !== '');
  const batchCount = batchLines.length;

  useEffect(() => {
    if (!open) return;
    setMode('single');
    setTitle(preset?.title ?? '');
    setDescription(preset?.description ?? '');
    setAssigneeAgentId(preset?.assigneeAgentId ?? null);
    setPriority('medium');
    setScheduledAt('');
    // preset.assigneeAgentId 预填时目标类型直接进 agent 分支，保持旧预填体验
    setTargetKind(preset?.assigneeAgentId ? 'agent' : 'none');
    setTargetTeamId('');
    setTargetSessionId('');
    setRecurrenceKind('once');
    setEveryN('30');
    setEveryUnit('m');
    setRecTime('09:00');
    setWeekday('1');
    setGroupId(defaultGroupId ?? '');
    setBatchText('');
    setBatchError(null);
    setRouting({ mode: 'local' });
    setPermissionTier('confirm');
    setPrecheck(null);
    // 预检失败降级仅本机（守门在 RunRoutingField；提交不受阻）
    if (routingAvailable && workspaceName) {
      void ipc.hub
        .routingPrecheck({ workspaceName })
        .then(setPrecheck)
        .catch(() => setPrecheck({ mirrored: false, groups: [] }));
      void ipc.hub
        .getDelegationSettings()
        .then((s) => setMaxConcurrent(s.maxConcurrent))
        .catch(() => {});
    }
    // 分组选项与 taskGroup.list 'exclude' 口径一致（只列活跃组）；失败静默——
    // 下拉只剩「不分组」，不阻塞建任务
    void loadGroups(workspaceId).catch(() => {});
    ipc.agent.listMembers(workspaceId).then((list: WorkspaceAgentMember[]) => {
      setAssignments(
        list.map((a) => ({ instanceId: a.instanceId, agentName: a.agentName })),
      );
    });
    ipc.team.list(workspaceId).then((list) => setTeams(list.map((t) => ({ id: t.id, name: t.name }))));
    ipc.session.list(workspaceId).then((list) => setSessions(list.map((s) => ({ id: s.id, title: s.title }))));
  }, [open, preset, workspaceId, workspaceName, loadGroups, defaultGroupId, routingAvailable]);

  if (!open) return null;

  // team/session 已选类型但未选具体对象时不可提交（按钮禁用 + submit 双保险）
  const targetMissing =
    (targetKind === 'team' && !targetTeamId) || (targetKind === 'session' && !targetSessionId);

  const submitSingleRemote = async (): Promise<void> => {
    if (!workspaceName) return;
    const result = await ipc.hub.submitRoutedTask({
      workspaceId,
      workspaceName,
      title: title.trim(),
      ...(description.trim() !== '' ? { description: description.trim() } : {}),
      routing,
      permissionTier,
    });
    onCreated(result.task.id);
    onClose();
  };

  const submitSingleLocal = async (): Promise<void> => {
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
    // M3.3：单任务标题支持同款 `::` 依赖后缀（无新控件，P2 口径——spec §2.2
    // 定稿授权）；无后缀标题 payload 零变化（不带 dependsOn 键）
    const parsed = parseTaskLine(title.trim());
    const created = await ipc.task.create({
      workspaceId,
      title: parsed.title,
      ...(parsed.dependsOn.length > 0 ? { dependsOn: parsed.dependsOn } : {}),
      description,
      priority: priorityNum,
      sourceSessionId: preset?.sourceSessionId ?? null,
      sourceMessageId: preset?.sourceMessageId ?? null,
      assigneeAgentId: targetKind === 'agent' ? assigneeAgentId : null,
      targetTeamId: targetKind === 'team' ? targetTeamId || null : null,
      targetSessionId: targetKind === 'session' ? targetSessionId || null : null,
      recurrenceRule,
      scheduledAt: scheduledAt ? new Date(scheduledAt).getTime() : null,
      groupId: groupId === '' ? undefined : groupId,
    });
    onCreated(created.id);
    onClose();
  };

  const submitBatch = async (): Promise<void> => {
    if (routing.mode === 'local' || !workspaceName) {
      // 本机批量：单 IPC task:createBatch（M3.3 替换逐行循环，语义等价——部分成功
      // 允许 + per-line 错误展示沿用现有 UI）。items 保持用户输入顺序原样传递：
      // 主进程逐项顺序落库，批内先行项可被后续行依赖（先行落库后行校验即通过）。
      // 无依赖行 payload 形状与旧逐行 task.create 零变化（不带 dependsOn 键）
      const items = batchLines.map((line) => {
        const parsed = parseTaskLine(line);
        return parsed.dependsOn.length > 0
          ? { workspaceId, title: parsed.title, dependsOn: parsed.dependsOn }
          : { workspaceId, title: parsed.title };
      });
      let result: TaskCreateBatchResult;
      try {
        result = await useTaskStore.getState().createBatch(items);
      } catch (err) {
        // 整批 rejection（超 50 上限等）→ 等价全失败：不关窗，错误在场供修改重试
        setBatchError((err as Error).message);
        return;
      }
      const failures = result.results.flatMap((r) =>
        r.ok ? [] : [{ line: batchLines[r.index] ?? '', message: r.error }],
      );
      const okIds = result.results.flatMap((r) => (r.ok ? [r.task.id] : []));
      if (failures.length > 0) {
        const summary = `${failures.length} 个任务创建失败：${failures
          .map((f) => `「${f.line}」${f.message}`)
          .join('；')}`;
        if (okIds.length === 0) {
          setBatchError(summary);
          return; // 全失败：不关窗不回调，错误行在场供修改后重试
        }
        showToast(summary);
      }
      // 批量只回调一次（末次成功任务），不逐任务开详情抽屉；全失败已在上方 return
      onCreated(okIds[okIds.length - 1] ?? '');
      onClose();
      return;
    }
    // 外派路由批量：hub 无批量通道（spec 裁定协议零改），保持逐行顺序提交——
    // group 路由每次重跑 least-busy（依次派给空闲节点，S2 批量 hint）。
    // per-line catch：单行失败不中断余行；`::` 后缀不解析，整行原样为标题
    let lastId = '';
    let successCount = 0;
    const failures: Array<{ line: string; message: string }> = [];
    for (const line of batchLines) {
      try {
        const result = await ipc.hub.submitRoutedTask({
          workspaceId,
          workspaceName,
          title: line,
          routing,
          permissionTier,
        });
        lastId = result.task.id;
        successCount += 1;
      } catch (err) {
        failures.push({ line, message: (err as Error).message });
      }
    }
    if (failures.length > 0) {
      const summary = `${failures.length} 个任务创建失败：${failures
        .map((f) => `「${f.line}」${f.message}`)
        .join('；')}`;
      if (successCount === 0) {
        setBatchError(summary);
        return; // 全失败：不关窗不回调，错误行在场供修改后重试
      }
      showToast(summary);
    }
    // 批量只回调一次（末次成功任务），不逐任务开详情抽屉；全失败不回调
    onCreated(lastId);
    onClose();
  };

  const handleSubmit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (submitting) return;
    if (mode === 'batch') {
      if (batchCount === 0) return;
      setSubmitting(true);
      try {
        await submitBatch();
      } finally {
        setSubmitting(false);
      }
      return;
    }
    if (!title.trim() || targetMissing) return;
    setSubmitting(true);
    try {
      if (remoteRouting && routingAvailable) {
        await submitSingleRemote();
      } else {
        await submitSingleLocal();
      }
    } finally {
      setSubmitting(false);
    }
  };

  const canSubmit =
    mode === 'batch' ? batchCount > 0 : Boolean(title.trim()) && !targetMissing;
  const submitLabel =
    mode === 'batch' && batchCount > 0 ? `创建 ${batchCount} 个任务` : '创建任务';

  return (
    <Dialog
      open
      onClose={onClose}
      title={mode === 'single' ? '新建任务' : '批量新建'}
      width={520}
      headerExtra={
        <>
          <Segmented
            options={[
              { value: 'single', label: '单任务' },
              { value: 'batch', label: '批量' },
            ]}
            value={mode}
            onChange={(v) => setMode(v)}
            aria-label="创建模式"
          />
          <button
            type="button"
            aria-label="关闭"
            onClick={onClose}
            className="flex h-6 w-6 items-center justify-center rounded text-tertiary transition-colors hover:bg-surface-2 hover:text-primary"
          >
            <X size={16} strokeWidth={1.75} aria-hidden />
          </button>
        </>
      }
    >
      <form onSubmit={handleSubmit} className="flex flex-col gap-3">
        {mode === 'batch' ? (
          <>
            <div className="flex flex-col gap-1">
              <label htmlFor="create-task-batch" className="text-sm text-secondary">
                批量任务书 · 每行一个任务
              </label>
              <textarea
                id="create-task-batch"
                value={batchText}
                onChange={(e) => setBatchText(e.target.value)}
                autoFocus
                className="mt-1 min-h-[104px] w-full rounded border border-subtle bg-surface-2 px-3 py-2 text-[12px] leading-[1.75] text-primary focus:border-focus focus:outline-none"
              />
            </div>
            {batchError !== null && (
              <p role="alert" className="break-words text-xs leading-relaxed text-status-error">
                {batchError}
              </p>
            )}
            {mode === 'batch' && routingAvailable && remoteRouting && batchCount > maxConcurrent && (
              <p
                data-testid="batch-concurrency-hint"
                className="break-words text-xs leading-relaxed text-status-warning"
              >
                批量 {batchCount} 行已超过目标并发上限（{maxConcurrent}）：超出部分可能被目标节点拒派
               （declined，任务保留待处理可重试派发）。提交不会被拦截。
              </p>
            )}
            {routingAvailable && (
              <RunRoutingField
                precheck={precheck}
                value={routing}
                onChange={setRouting}
                taskCount={batchCount > 0 ? batchCount : undefined}
                permissionTier={permissionTier}
                onPermissionTierChange={setPermissionTier}
              />
            )}
          </>
        ) : (
          <>
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
            {routingAvailable && (
              <RunRoutingField
                precheck={precheck}
                value={routing}
                onChange={setRouting}
                permissionTier={permissionTier}
                onPermissionTierChange={setPermissionTier}
              />
            )}
            {!remoteRouting && (
              <>
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
                  label="分组"
                  value={groupId}
                  onChange={(e) => setGroupId(e.target.value)}
                >
                  <option value="">不分组</option>
                  {groups.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.name}
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
              </>
            )}
          </>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose} disabled={submitting}>
            取消
          </Button>
          <Button type="submit" disabled={!canSubmit || submitting}>
            {submitting ? '创建中...' : submitLabel}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
