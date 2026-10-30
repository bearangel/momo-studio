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
//     ipc.hub.submitRoutedTask（hub 无批量通道，逐行循环保持——每次提交重跑调度）。
//     M4.3 起外派路径同样解析 `::` 后缀（M3.3 裁定翻转——建链后任务 blocked，
//     派发受主进程闸管制：blocked 拒绝人话回显，依赖完成后待派发卡重试放行）
//   - `::` 依赖行语法（M3.3 spec §2.2 最小面）：`标题 :: T-1,T-2` 双冒号+逗号分隔，
//     可省略——无后缀行解析零变化（测试锁）；单任务模式用同输入框后缀语法，
//     无新控件（P2 口径：纯输入语法扩展，无布局语言变化——spec 定稿授权）
//   - preset 预填：从 agent inline 建议或会话内按钮触发时传入已知字段
//   - open=false 时 return null（hooks 仍在调用顺序中，符合 React 规则）
//   - M5.3 X3 外派「执行方式」（spec §5.2/§5.4/§5.5，预览定值清单为合同）：
//     单 agent（默认，仅一行 hint）/ 团队协作（本 ws 团队下拉 + leader chip）。
//     指定节点 → 成员覆盖预检（本地同名镜像成员名近似，绿/黄字）；组内调度 →
//     协议落后节点黄字（routingPrecheck nodeCaps 数据源）。黄字一律不拦提交，
//     协议门红字仅出现在主进程派发闸失败 toast；团队提交随载荷 teamId（主进程
//     展开成员快照 + 版本闸）。批量模式不提供执行方式区（spec §5.2 票桶）
// v2.1：外壳收敛 Dialog 原子件；表单控件换 Input/Select；textarea 无原子件走 token 类。
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { TriangleAlert, Users, X } from 'lucide-react';
import { ipc } from '../../ipc/client';
import type { PermissionTier, RoutingPrecheckResult, TaskCreateBatchResult, TaskRouting, WorkspaceAgentMember } from '../../ipc/types';
import { serializeRecurrence, type RecurrencePreset } from '../../lib/recurrence';
import { rpcErrorMessage } from '../../lib/rpc-error';
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
/** M5.3 外派执行方式：单 agent（默认）/ 团队协作 */
type ExecMode = 'agent' | 'team';

/** 团队执行下拉消费的团队子集（Team 契约字段：leader chip + 成员覆盖预检） */
interface DelegationTeam {
  id: string;
  name: string;
  leaderInstanceId: string;
  members: Array<{ instanceId: string; agentName: string }>;
}

/**
 * 指定节点成员覆盖预检数据（spec §5.4 本地零 hub RPC）：
 *   - idle：未就绪（非团队态 / 查询中），不出预检注
 *   - none：本地库无同名镜像（或查询失败）→ 覆盖未知态黄字
 *   - ok：镜像成员名集合，团队名单 ⊆ 该集合 → 绿字，缺谁列谁 → 黄字
 */
type MirrorCoverage = { status: 'idle' } | { status: 'none' } | { status: 'ok'; names: string[] };

/**
 * 团队派发协议门槛 minor（与 electron 侧 momo-hub-protocol
 * TEAM_DELEGATION_REQUIRED_MINOR=9 单源对齐；hub 协议 1.9.0 起认 team 段。
 * renderer 不依赖该包，此处双写并锚定单源——升级协议时两处同步；
 * export 供 CreateTaskDialog.test 机械锁（===9 对齐 electron pin test 防漂移）。
 */
export const TEAM_DELEGATION_REQUIRED_MINOR = 9;

/** 节点是否支持团队派发（minor ≥ 门槛；缺省/空/异形视为旧——与主进程
 *  dispatch-submit.ts supportsTeamDelegation 同口径，黄字预检与提交闸不漂移） */
function supportsTeamDelegation(protoVer: string | undefined): boolean {
  if (protoVer === undefined || protoVer === '') return false;
  const m = /^(\d+)\.(\d+)(?:\.\d+)?$/.exec(protoVer.trim());
  if (!m) return false;
  return Number(m[2]) >= TEAM_DELEGATION_REQUIRED_MINOR;
}

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
  const [teams, setTeams] = useState<DelegationTeam[]>([]);
  // M5.3 X3：外派执行方式（单 agent 默认）+ 团队下拉选中值 + 成员覆盖预检数据
  const [execMode, setExecMode] = useState<ExecMode>('agent');
  const [delegationTeamId, setDelegationTeamId] = useState('');
  const [mirrorCoverage, setMirrorCoverage] = useState<MirrorCoverage>({ status: 'idle' });
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
    setExecMode('agent');
    setDelegationTeamId('');
    setMirrorCoverage({ status: 'idle' });
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
    // M5.3：teams 保留 leader/成员面（执行方式团队下拉的 chip 与覆盖预检消费）
    ipc.team.list(workspaceId).then((list) =>
      setTeams(
        list.map((t) => ({
          id: t.id,
          name: t.name,
          leaderInstanceId: t.leaderInstanceId,
          members: t.members.map((m) => ({ instanceId: m.instanceId, agentName: m.agentName })),
        })),
      ),
    );
    ipc.session.list(workspaceId).then((list) => setSessions(list.map((s) => ({ id: s.id, title: s.title }))));
  }, [open, preset, workspaceId, workspaceName, loadGroups, defaultGroupId, routingAvailable]);

  // M5.3 成员覆盖预检数据面（spec §5.4 本地零 hub RPC）：外派单任务 × 团队协作 ×
  // 指定节点时，本地库按名找镜像 workspace（镜像与源同名）→ 其成员名集合作为
  // 目标节点镜像覆盖面的本地近似（目标可能本地自建同名成员，故黄字不拦提交）。
  // 路由或执行方式切换即重查（cancelled 旗防过期回写）。
  useEffect(() => {
    if (!open || !workspaceName || !remoteRouting || execMode !== 'team' || routing.mode !== 'node') {
      return;
    }
    let cancelled = false;
    setMirrorCoverage({ status: 'idle' });
    ipc.workspace
      .list()
      .then((list) => {
        if (cancelled) return;
        const mirror = list.find((w) => w.name === workspaceName);
        if (!mirror) {
          setMirrorCoverage({ status: 'none' });
          return;
        }
        return ipc.agent.listMembers(mirror.id).then((members) => {
          if (!cancelled) setMirrorCoverage({ status: 'ok', names: members.map((m) => m.agentName) });
        });
      })
      .catch(() => {
        // 查询失败与无镜像同口径（覆盖未知态黄字，不拦提交）
        if (!cancelled) setMirrorCoverage({ status: 'none' });
      });
    return () => {
      cancelled = true;
    };
  }, [open, workspaceName, remoteRouting, execMode, routing.mode]);

  if (!open) return null;

  // team/session 已选类型但未选具体对象时不可提交（按钮禁用 + submit 双保险）；
  // M5.3：外派团队执行未选团队并入同口径
  const targetMissing =
    (targetKind === 'team' && !targetTeamId) ||
    (targetKind === 'session' && !targetSessionId) ||
    (remoteRouting && execMode === 'team' && delegationTeamId === '');

  const submitSingleRemote = async (): Promise<void> => {
    if (!workspaceName) return;
    // M4.3：外派单任务同款 `::` 后缀解析（与本地单任务/批量同源 parseTaskLine）
    const parsed = parseTaskLine(title.trim());
    try {
      const result = await ipc.hub.submitRoutedTask({
        workspaceId,
        workspaceName,
        title: parsed.title,
        ...(description.trim() !== '' ? { description: description.trim() } : {}),
        ...(parsed.dependsOn.length > 0 ? { dependsOn: parsed.dependsOn } : {}),
        // M5.3：团队执行随载荷 teamId（主进程展开成员快照 + 版本闸）；单 agent
        // 缺省不带键（payload 零变化回归）
        ...(execMode === 'team' && delegationTeamId !== '' ? { teamId: delegationTeamId } : {}),
        routing,
        permissionTier,
      });
      onCreated(result.task.id);
      onClose();
    } catch (err) {
      // M4.3 派发闸拒绝（blocked 人话）/ 路由校验拒绝在此回显——此前该路径
      // rejection 无兜底（unhandled，弹窗悬挂）；行已建链时任务保留待处理卡
      showToast(`创建外派任务失败: ${(err as Error).message}`);
    }
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
    // M4.3：逐行 `::` 后缀解析（与本地批量同源 parseTaskLine）；blocked 行建链
    // 后被主进程派发闸拒 → per-line 失败展示（行保留待处理，依赖完成后重试派发）
    let lastId = '';
    let successCount = 0;
    const failures: Array<{ line: string; message: string }> = [];
    for (const line of batchLines) {
      const parsed = parseTaskLine(line);
      try {
        const result = await ipc.hub.submitRoutedTask({
          workspaceId,
          workspaceName,
          title: parsed.title,
          ...(parsed.dependsOn.length > 0 ? { dependsOn: parsed.dependsOn } : {}),
          routing,
          permissionTier,
        });
        lastId = result.task.id;
        successCount += 1;
      } catch (err) {
        // hub 通道（M4.1 coded）：剥 `[code]` 传输前缀后入失败清单
        failures.push({ line, message: rpcErrorMessage(err) });
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

  // ── M5.3 团队执行预检（spec §5.4：黄字一律不拦提交；协议门红字拒提交仅出现在
  // 主进程派发闸失败 toast，不在表单内）——预览定值清单条款 4/5/6 ──
  const selectedTeam = execMode === 'team' ? teams.find((t) => t.id === delegationTeamId) : undefined;

  const warnBar = (text: string): ReactNode => (
    <div className="flex items-start gap-1.5 rounded-md bg-status-warning-tint px-2.5 py-2 text-xs leading-relaxed text-status-warning">
      <TriangleAlert size={14} strokeWidth={1.75} aria-hidden className="mt-0.5 shrink-0" />
      <span className="break-words">{text}</span>
    </div>
  );

  const teamPrecheckNote: ReactNode = (() => {
    if (mode !== 'single' || !remoteRouting || !selectedTeam) return null;
    if (routing.mode === 'node') {
      if (mirrorCoverage.status === 'idle') return null;
      if (mirrorCoverage.status === 'none') {
        return warnBar(
          `本地无 ${workspaceName} 镜像，无法预检成员覆盖——目标节点若未镜像将被拒收`,
        );
      }
      const memberNames = selectedTeam.members.map((m) => m.agentName);
      const mirrorSet = new Set(mirrorCoverage.names);
      const missing = memberNames.filter((n) => !mirrorSet.has(n));
      if (missing.length === 0) {
        return (
          <p className="text-xs leading-relaxed text-status-success">
            {`✓ ${memberNames.length} 名成员在目标节点镜像中全部可解析`}
          </p>
        );
      }
      return warnBar(
        `目标节点镜像缺 ${missing.length} 名成员：${missing.join('、')}——若对方本地也无这些 agent，任务将被拒收（保留待处理可重试）`,
      );
    }
    if (routing.mode === 'group' && precheck !== null) {
      if (precheck.nodeCaps === undefined) {
        // 旧 hub / 数据源缺席：无法判定，兜底黄字
        return warnBar('无法获取组内节点版本，若含旧节点任务将被拒');
      }
      const caps = precheck.nodeCaps;
      const online =
        precheck.groups.find((g) => g.groupId === routing.groupId)?.members.filter((m) => m.online) ??
        [];
      const laggards = online
        .map((m) => ({ name: m.name, ver: caps.find((c) => c.nodeId === m.nodeId)?.protoVer }))
        .filter((x) => !supportsTeamDelegation(x.ver));
      if (laggards.length === 0) return null;
      return warnBar(
        `组内 ${laggards.length} 个节点版本过旧（${laggards
          .map((x) => `${x.name}·协议 ${x.ver ?? '未知'}`)
          .join('、')}），团队任务不会派给它；全员落后时提交将被拒`,
      );
    }
    return null;
  })();

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
            {/* M5.3 X3：外派「执行方式」——权限档位之下、表单尾部（预览定值条款 7）；
                批量分支不渲染本区（条款 8） */}
            {routingAvailable && remoteRouting && (
              <div className="flex flex-col gap-2.5">
                <div className="flex items-center gap-2.5">
                  <span className="text-sm text-secondary">执行方式</span>
                  <Segmented
                    options={[
                      { value: 'agent', label: '单 agent' },
                      { value: 'team', label: '团队协作' },
                    ]}
                    value={execMode}
                    onChange={(v) => setExecMode(v)}
                    aria-label="执行方式"
                  />
                </div>
                {execMode === 'agent' ? (
                  <p className="text-xs leading-relaxed text-tertiary">
                    任务落到目标节点后由单个 agent 处理（默认 agent，或按 agent 指定）
                  </p>
                ) : (
                  <>
                    <Select
                      label="团队"
                      value={delegationTeamId}
                      onChange={(e) => setDelegationTeamId(e.target.value)}
                    >
                      {teams.length === 0 ? (
                        <option value="">暂无团队（≥2 成员的团队才可协作）</option>
                      ) : (
                        <>
                          <option value="">请选择团队</option>
                          {teams.map((t) => (
                            <option key={t.id} value={t.id}>
                              {t.name}
                            </option>
                          ))}
                        </>
                      )}
                    </Select>
                    {selectedTeam && (
                      <span className="inline-flex w-fit items-center gap-1.5 rounded-full bg-status-violet-tint px-2.5 py-0.5 text-xs text-status-violet">
                        <Users size={14} strokeWidth={1.75} aria-hidden />
                        {`leader：${
                          selectedTeam.members.find(
                            (m) => m.instanceId === selectedTeam.leaderInstanceId,
                          )?.agentName ?? '未知'
                        } · 提交时展开为成员名单快照`}
                      </span>
                    )}
                    {teamPrecheckNote}
                  </>
                )}
              </div>
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
