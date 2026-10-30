// electron/src/main/hub/dispatch-submit.ts
//
// M2.1 Task 8：路由提交链——新建弹窗「执行位置」三选的统一落点。
//   - local → 委托既有本地创建管道（task/ipc.handlers.ts createTaskFromForm，draft 语义单源）
//   - group → 组装 DispatchInput（T7 契约）→ pickWorker → 有候选走既有委派管道
//     （TASK_RPC.delegate，permissionTier 随载荷——协议 1.2.0 多字段向后兼容）→ 回写 delegation_id
//   - node  → 校验成员身份后直发指定节点（用户显式锁定，不 least-busy）
//
// 落库时序（外派路径）：行先落 pending（routing 保留、delegationId 空）→ 再派发 →
// 成功回写 delegation_id；派发瞬断（node_offline 等）不抛——行保留待处理，由看板
// 待派发卡手动「重试派发」驱动（RM-M21-5：无候选/失败不轮询）。
//
// 纯注入：本模块只做编排与校验，hub RPC / 本地 DB 全部经 DispatchSubmitPorts 注入
// （ipc.handlers.ts 接线，tests/hub/dispatch-submit.test.ts 注入 fake——mock 收窄铁律）。
// runningCount 口径 = 该节点活跃委派数（pending|running|interrupted；终态与 cancelled 不计）；
// mirroredBy 口径 = 登记表按工作空间名过滤（镜像真相在节点级，跨组——RM-M21-7）。
import { pickWorker } from './dispatch-scheduler';
import { isTaskRouting, type TaskRouting } from './task-routing';
import type { PermissionTier } from './run-policy';
import { blockedDispatchError } from '../task/dependency-gate';
import type { TaskRow } from '../storage/tasks/repo';
import { TEAM_DELEGATION_REQUIRED_MINOR } from './protocol';

/**
 * HITL 权限档位（T10 起单源迁移至 run-policy.ts——三档运行时语义在该模块；
 * 此处 re-export 维持 dispatch-submit / delegation-sync 既有导入路径）
 */
export type { PermissionTier } from './run-policy';

/** hub:submitRoutedTask 入参（group/node 路径的外派任务书 + 本地落库字段） */
export interface SubmitRoutedTaskInput {
  workspaceId: string;
  /** 工作空间名（镜像按名对账 + 委派载荷 workspaceName） */
  workspaceName: string;
  title: string;
  /** 任务书（委派载荷 prompt；空时以标题兜底） */
  description?: string;
  /** 看板分组（落库前三重校验，与 task.create 同源） */
  groupId?: string;
  routing: TaskRouting;
  /** 缺省 'confirm'（执行端确认）；T10 档位选择器接入后显式透传 */
  permissionTier?: PermissionTier;
  /**
   * M4.3 外派行 `::` 依赖语法：解析出的直接依赖 id 列表（CreateTaskDialog
   * 外派路径带出）。落库走 insertTaskWithRelations（存在 + 环检测单源）；
   * 建链后行 blocked 派生 → 派发闸管制（blocked 不 delegate）
   */
  dependsOn?: string[];
  /**
   * M5.3 团队派发：本地团队 id（renderer X3 团队下拉带出）。提交时主进程展开为
   * 成员名单快照（name=agentName，与镜像快照名对齐口径）随载荷 team 段（不带
   * agentSlug——协议互斥）；单 agent 路径缺省不带键（零变化）。批量链路不提供。
   */
  teamId?: string;
}

export interface SubmitRoutedTaskResult {
  /** 本地落库行（dispatched=true 时已带 delegationId） */
  task: TaskRow;
  /** group/node 是否已发出委派（false=留待处理：无候选或发送瞬断） */
  dispatched: boolean;
  /** 委派目标节点（dispatched=true 时在场） */
  nodeId: string | null;
}

/** 既有委派管道载荷（TASK_RPC.delegate 请求体；permissionTier / dependsOn 为向后兼容扩展字段） */
export interface DelegationTaskBrief {
  groupId: string;
  targetNodeId: string;
  workspaceName: string;
  task: {
    title: string;
    prompt: string;
    permissionTier: PermissionTier;
    /**
     * M4.3 协议 1.7.0：leader 本地依赖 id 清单——纯透传（展示/审计），hub 不
     * 校验存在性、worker 零消费（语义裁定 spec §2.1）；缺省不带键（1.6 兼容）
     */
    dependsOn?: string[];
    /**
     * M5.3 协议 1.9.0：外派团队段——成员名单快照（name=agent 定义名，恰一名
     * isLeader）；与 agentSlug 互斥（同场 hub 整包拒）；缺省不带键（1.8 兼容）
     */
    team?: { members: Array<{ name: string; isLeader: boolean }> };
  };
}

/** 外派行落库入参（wiring 侧做分组三重校验后 insertTaskWithRelations） */
export interface RemoteCreateInput {
  workspaceId: string;
  title: string;
  description: string;
  groupId?: string;
  status: 'pending';
  routing: TaskRouting;
  /** M4.3：外派行 `::` 建链（同事务插边——存在 + 环检测在 relations 单源） */
  dependsOn?: string[];
}

/**
 * 进程/网络边界端口（唯一 mock 面）。生产接线见 hub/ipc.handlers.ts：
 *   - listGroups / listDelegations / delegate → hubRequest（hub RPC）
 *   - listMirrorRegistry → hubListMirrorRegistry（本地登记表，RM-M21-7）
 *   - createLocalTask → task/ipc.handlers.ts createTaskFromForm（draft 语义单源）
 *   - createRemoteTask / updateDelegationLink → storage/tasks/repo
 */
export interface DispatchSubmitPorts {
  /** 本节点所在组清单（presence 融合后的成员在线态；protoVer 为 1.9.0 起在线
   *  成员携带的协议版本——M5.3 派发闸 / nodeCaps 数据源，离线成员缺省不带） */
  listGroups(): Promise<
    Array<{
      groupId: string;
      groupName: string;
      members: Array<{ nodeId: string; name: string; online: boolean; protoVer?: string }>;
    }>
  >;
  /**
   * M5.3 团队快照展开：本地团队当前成员 + leader 标记（name=agentName——外派
   * team 段名单与镜像按名对齐同口径）。团队不存在/已解散 → null（提交时人话拒）。
   */
  getTeamSnapshot(
    workspaceId: string,
    teamId: string,
  ): { name: string; members: Array<{ agentName: string; isLeader: boolean }> } | null;
  /** 组内委派账本（runningCount 数据源） */
  listDelegations(groupId: string): Promise<Array<{ taskId: string; targetNodeId: string; status: string }>>;
  /** 镜像登记表（按工作空间名过滤） */
  listMirrorRegistry(
    workspaceName: string,
  ): Array<{ groupId: string; targetNodeId: string; workspaceName: string }>;
  /** 既有委派管道（leader-only；目标离线即拒 node_offline） */
  delegate(brief: DelegationTaskBrief): Promise<{ taskId: string }>;
  /** local 模式：既有本地创建（draft 落库 + notifyExecutor） */
  createLocalTask(input: SubmitRoutedTaskInput): TaskRow;
  /** group/node 模式：外派行落库（pending + routing 保留 + dependsOn 建链） */
  createRemoteTask(input: RemoteCreateInput): TaskRow;
  /**
   * M4.3 派发闸数据源：M3.3 blocked 派生单源（deriveBlockedBy——仅 completed
   * 解锁）；返回未完成直接依赖 id 列表，空 = 不阻塞
   */
  deriveBlockedBy(taskId: string): string[];
  /** 委派成功后回写 tasks 行 delegation_id + 已解析目标 routing（D5：group
   *  变体带上调度解析的 targetNodeId——外派卡节点徽标持久源） */
  updateDelegationLink(taskId: string, delegationId: string, routing: TaskRouting): void;
}

/** 活跃委派口径：pending|running|interrupted（未终态且未取消——interrupted 会重连续跑，占负载） */
const ACTIVE_DELEGATION = new Set(['pending', 'running', 'interrupted']);

/**
 * protoVer minor 解析（'1.9.0' → 9；缺省/异形 → null）。M5.3 派发闸按
 * minor 与 TEAM_DELEGATION_REQUIRED_MINOR（协议包单源）比对；缺省视为旧——
 * 在线但不带 protoVer 的成员即旧版 studio（1.9.0 起在线成员恒带）。
 */
function protoVerMinor(v: string | undefined): number | null {
  if (v === undefined) return null;
  const m = /^(\d+)\.(\d+)(?:\.\d+)?$/.exec(v.trim());
  if (!m) return null;
  return Number(m[2]);
}

/** 节点是否支持团队派发（minor ≥ 协议包门槛；缺省/异形视为旧） */
export function supportsTeamDelegation(protoVer: string | undefined): boolean {
  const minor = protoVerMinor(protoVer);
  return minor !== null && minor >= TEAM_DELEGATION_REQUIRED_MINOR;
}

/** 版本门人话（文案口径对齐 hub node_unsupported：含节点名与对方版本） */
function nodeTooOldMessage(nodeName: string, protoVer: string | undefined): string {
  return `目标节点 ${nodeName} 版本过旧（协议 ${protoVer ?? '未知'}），不支持团队派发——需对方升级到 v0.5.0+`;
}

/**
 * M5.3 团队快照展开：teamId → 成员名单 payload（name=agentName + leader 标记）。
 * 提交时早失败（零落库零派发）：团队不存在/形态不满足 hub 校验锚点（2..8 名、
 * 恰一名 leader）→ 人话 throw。
 */
function expandTeamPayload(
  input: SubmitRoutedTaskInput,
  ports: Pick<DispatchSubmitPorts, 'getTeamSnapshot'>,
): { members: Array<{ name: string; isLeader: boolean }> } {
  const snap = ports.getTeamSnapshot(input.workspaceId, input.teamId!);
  if (!snap) {
    throw new Error(`团队不存在或已解散: ${input.teamId}（工作空间 ${input.workspaceName}）`);
  }
  const leaderCount = snap.members.filter((m) => m.isLeader).length;
  if (snap.members.length < 2 || snap.members.length > 8 || leaderCount !== 1) {
    throw new Error(
      `团队 ${snap.name} 形态不满足团队派发（当前 ${snap.members.length} 名成员、${leaderCount} 名 leader——须 2..8 名且恰一名 leader）`,
    );
  }
  return { members: snap.members.map((m) => ({ name: m.agentName, isLeader: m.isLeader })) };
}

/**
 * 路由提交主链。routing 异形人话拒绝（与 task.create IPC 同哲学：想外派被静默
 * 降级本机，错误更晚更贵）；组不存在 / 非成员目标同样响亮拒绝（零落库零派发）。
 */
export async function submitRoutedTask(
  input: SubmitRoutedTaskInput,
  ports: DispatchSubmitPorts,
): Promise<SubmitRoutedTaskResult> {
  if (!isTaskRouting(input.routing)) {
    throw new Error(
      'routing 形状非法：须为 {mode:"local"} | {mode:"group",groupId} | {mode:"node",groupId,targetNodeId} 之一',
    );
  }
  if (input.routing.mode === 'local') {
    const task = ports.createLocalTask(input);
    return { task, dispatched: false, nodeId: null };
  }

  // M5.3 团队展开（提交时早失败——团队不存在/形态非法零落库零派发）
  const teamPayload = input.teamId !== undefined ? expandTeamPayload(input, ports) : undefined;
  const targetNodeId = await resolveRemoteTarget(input.routing, input.workspaceName, ports, {
    team: teamPayload !== undefined,
  });
  // 行先落库再派发：外派前先有账，发送失败不丢单（RM-M21-5 手动重试面）；
  // M4.3：dependsOn 随行建链（存在 + 环检测在 relations 单源）
  const task = ports.createRemoteTask({
    workspaceId: input.workspaceId,
    title: input.title,
    description: input.description ?? '',
    ...(input.groupId !== undefined ? { groupId: input.groupId } : {}),
    status: 'pending',
    routing: input.routing,
    ...(input.dependsOn !== undefined && input.dependsOn.length > 0
      ? { dependsOn: input.dependsOn }
      : {}),
  });
  // M4.3 派发闸（spec §2.3.1 核心）：建链后 blocked 派生 → 拒绝委派。行保留
  // pending 待处理（建链账不回滚——重试入口在待派发卡，依赖完成后放行）；
  // 文案单源 task/dependency-gate.ts（与 retryDispatch 闸逐字同源）
  const unmetDeps = ports.deriveBlockedBy(task.id);
  if (unmetDeps.length > 0) throw blockedDispatchError(unmetDeps);
  // 无候选：行照落待处理（routing 保留、delegationId 空），不轮询（RM-M21-5）
  if (targetNodeId === null) {
    return { task, dispatched: false, nodeId: null };
  }
  try {
    const { taskId: delegationId } = await ports.delegate({
      groupId: input.routing.groupId,
      targetNodeId,
      workspaceName: input.workspaceName,
      task: {
        title: input.title,
        prompt: input.description?.trim() || input.title,
        permissionTier: input.permissionTier ?? 'confirm',
        // M4.3 协议 1.7.0：依赖元数据随任务书透传（hub 不校验存在性——展示/审计）
        ...(input.dependsOn !== undefined && input.dependsOn.length > 0
          ? { dependsOn: input.dependsOn }
          : {}),
        // M5.3 协议 1.9.0：团队段随任务书透传（不带 agentSlug——协议互斥；
        // 单 agent 路径缺省不带键，1.8 载荷零变化）
        ...(teamPayload !== undefined ? { team: teamPayload } : {}),
      },
    });
    // D5：已解析目标随 delegation_id 一并回写行（group 变体补 targetNodeId；
    // node 变体本就携带——幂等同值）
    const resolvedRouting: TaskRouting =
      input.routing.mode === 'group' ? { ...input.routing, targetNodeId } : input.routing;
    ports.updateDelegationLink(task.id, delegationId, resolvedRouting);
    return { task: { ...task, delegationId }, dispatched: true, nodeId: targetNodeId };
  } catch {
    // 瞬断（node_offline / 网络抖动）：行保留待处理，不向上抛——弹窗提交不该
    // 因单节点瞬断整体失败；重试入口在待派发卡（T9）
    return { task, dispatched: false, nodeId: null };
  }
}

/**
 * 外派目标解析：node 模式锁定直发（成员身份校验）；group 模式组装 T7 DispatchInput
 * 走 pickWorker（无候选返回 null → 调用方落待处理）。
 * 导出供 delegation-sync.retryDispatch 复用（T9 重派单点——调度逻辑单源）。
 *
 * M5.3 派发闸（opts.team=true 时生效，早失败零落库）：
 *   - 指定节点：在线成员 protoVer（缺省视为旧）minor < 门槛 → 人话拒（含节点名
 *     与对方版本）；离线成员无 protoVer 可查——不在此闸拦（hub 兜底 node_offline/
 *     node_unsupported）
 *   - 组内调度：least-busy 候选池额外排除协议过旧节点；本可有候选（在线∧已镜像）
 *     但全被版本排除 → 人话拒并列全部落后节点名；无候选（本就无在线/镜像）→
 *     维持 null 留待处理（既有语义零变化）
 */
export async function resolveRemoteTarget(
  routing: Exclude<TaskRouting, { mode: 'local' }>,
  workspaceName: string,
  ports: DispatchSubmitPorts,
  opts?: { team?: boolean },
): Promise<string | null> {
  const groups = await ports.listGroups();
  const group = groups.find((g) => g.groupId === routing.groupId);
  if (!group) {
    throw new Error(`工作组 ${routing.groupId} 不存在或已退出，无法外派任务`);
  }
  if (routing.mode === 'node') {
    const member = group.members.find((m) => m.nodeId === routing.targetNodeId);
    if (!member) {
      throw new Error(
        `指定节点 ${routing.targetNodeId} 不是工作组 ${group.groupName}（${group.groupId}）的成员`,
      );
    }
    if (opts?.team === true && member.online && !supportsTeamDelegation(member.protoVer)) {
      throw new Error(nodeTooOldMessage(member.name, member.protoVer));
    }
    return routing.targetNodeId;
  }
  const delegations = await ports.listDelegations(routing.groupId);
  const runningCount = new Map<string, number>();
  for (const d of delegations) {
    if (!ACTIVE_DELEGATION.has(d.status)) continue;
    runningCount.set(d.targetNodeId, (runningCount.get(d.targetNodeId) ?? 0) + 1);
  }
  const mirroredBy = new Set(
    ports.listMirrorRegistry(workspaceName).map((r) => r.targetNodeId),
  );
  const onlineMembers = group.members.filter((m) => m.online);
  if (opts?.team === true) {
    // 版本排除前的真实候选池（在线 ∧ 已镜像——pickWorker 语义同款）
    const baseCandidates = onlineMembers.filter((m) => mirroredBy.has(m.nodeId));
    const eligible = baseCandidates.filter((m) => supportsTeamDelegation(m.protoVer));
    if (eligible.length === 0 && baseCandidates.length > 0) {
      const laggards = baseCandidates
        .filter((m) => !supportsTeamDelegation(m.protoVer))
        .map((m) => m.name);
      throw new Error(
        `组内候选节点协议均过旧（${laggards.join('、')}），不支持团队派发——需对方升级到 v0.5.0+`,
      );
    }
    return pickWorker({
      groupId: routing.groupId,
      workspaceName,
      members: eligible.map((m) => ({
        nodeId: m.nodeId,
        name: m.name,
        online: m.online,
        runningCount: runningCount.get(m.nodeId) ?? 0,
      })),
      mirroredBy,
    });
  }
  return pickWorker({
    groupId: routing.groupId,
    workspaceName,
    // DispatchInput 契约：members 为 presence 过滤后的在线成员（pickWorker 自带
    // online 复核，此处过滤是契约遵守而非冗余）
    members: onlineMembers.map((m) => ({
      nodeId: m.nodeId,
      name: m.name,
      online: m.online,
      runningCount: runningCount.get(m.nodeId) ?? 0,
    })),
    mirroredBy,
  });
}

// ── 预检概要（新建弹窗「执行位置」区数据源；hub:routingPrecheck） ─────────

export interface RoutingMemberSummary {
  nodeId: string;
  name: string;
  online: boolean;
  /** 该节点是否已镜像本工作空间（登记表按空间名口径，与调度 mirroredBy 同源） */
  mirrored: boolean;
}

export interface RoutingGroupSummary {
  groupId: string;
  groupName: string;
  /** 在线成员数（预检行「N 节点在线」） */
  onlineCount: number;
  /** 已镜像本空间的成员数（预检行「M 已镜像」；与在线口径独立——离线已镜像也计入） */
  mirroredCount: number;
  members: RoutingMemberSummary[];
}

export interface RoutingPrecheckResult {
  /** 本空间是否有任何镜像登记（Review Focus #1 守门信号：false → 弹窗仅「本机」） */
  mirrored: boolean;
  groups: RoutingGroupSummary[];
  /**
   * M5.3 节点能力面：组内在线成员的协议版本（group.list protoVer 派生，跨组按
   * nodeId 去重）——renderer 预检黄字/派发闸 UI（X3）数据源。运行时恒携带；
   * renderer 侧 types.d.ts 对应字段为可选（旧 fixture 兼容，消费面 X3 另行接线）
   */
  nodeCaps: Array<{ nodeId: string; name: string; protoVer: string }>;
}

/**
 * 预检概要：镜像登记表（本地，可信）× 组清单（hub RPC，不可达时降级空数组——
 * 预检炸弹窗不可接受）。守门判定由 renderer RunRoutingField 按 mirrored/groups 消费。
 */
export async function routingPrecheck(
  workspaceName: string,
  ports: Pick<DispatchSubmitPorts, 'listGroups' | 'listMirrorRegistry'>,
): Promise<RoutingPrecheckResult> {
  const mirroredNodes = new Set(
    ports.listMirrorRegistry(workspaceName).map((r) => r.targetNodeId),
  );
  let groups: Awaited<ReturnType<typeof ports.listGroups>> = [];
  try {
    groups = await ports.listGroups();
  } catch {
    // hub 不可达：组信息缺失 → 组内调度/指定节点无数据可显，降级空清单（不抛）
  }
  // nodeCaps：在线成员携带的 protoVer（1.9.0 起在线恒带；离线/旧节点不带），
  // 跨组同 nodeId 去重（首见保留——节点能力与组无关）
  const nodeCaps: Array<{ nodeId: string; name: string; protoVer: string }> = [];
  const seenNodes = new Set<string>();
  for (const g of groups) {
    for (const m of g.members) {
      if (!m.online || typeof m.protoVer !== 'string' || seenNodes.has(m.nodeId)) continue;
      seenNodes.add(m.nodeId);
      nodeCaps.push({ nodeId: m.nodeId, name: m.name, protoVer: m.protoVer });
    }
  }
  return {
    mirrored: mirroredNodes.size > 0,
    groups: groups.map((g) => {
      const members = g.members.map((m) => ({
        nodeId: m.nodeId,
        name: m.name,
        online: m.online,
        mirrored: mirroredNodes.has(m.nodeId),
      }));
      return {
        groupId: g.groupId,
        groupName: g.groupName,
        onlineCount: members.filter((m) => m.online).length,
        mirroredCount: members.filter((m) => m.mirrored).length,
        members,
      };
    }),
    nodeCaps,
  };
}
