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
import type { TaskRow } from '../storage/tasks/repo';

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
}

export interface SubmitRoutedTaskResult {
  /** 本地落库行（dispatched=true 时已带 delegationId） */
  task: TaskRow;
  /** group/node 是否已发出委派（false=留待处理：无候选或发送瞬断） */
  dispatched: boolean;
  /** 委派目标节点（dispatched=true 时在场） */
  nodeId: string | null;
}

/** 既有委派管道载荷（TASK_RPC.delegate 请求体；permissionTier 为向后兼容扩展字段） */
export interface DelegationTaskBrief {
  groupId: string;
  targetNodeId: string;
  workspaceName: string;
  task: { title: string; prompt: string; permissionTier: PermissionTier };
}

/** 外派行落库入参（wiring 侧做分组三重校验后 insertTask） */
export interface RemoteCreateInput {
  workspaceId: string;
  title: string;
  description: string;
  groupId?: string;
  status: 'pending';
  routing: TaskRouting;
}

/**
 * 进程/网络边界端口（唯一 mock 面）。生产接线见 hub/ipc.handlers.ts：
 *   - listGroups / listDelegations / delegate → hubRequest（hub RPC）
 *   - listMirrorRegistry → hubListMirrorRegistry（本地登记表，RM-M21-7）
 *   - createLocalTask → task/ipc.handlers.ts createTaskFromForm（draft 语义单源）
 *   - createRemoteTask / updateDelegationLink → storage/tasks/repo
 */
export interface DispatchSubmitPorts {
  /** 本节点所在组清单（presence 融合后的成员在线态） */
  listGroups(): Promise<
    Array<{
      groupId: string;
      groupName: string;
      members: Array<{ nodeId: string; name: string; online: boolean }>;
    }>
  >;
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
  /** group/node 模式：外派行落库（pending + routing 保留） */
  createRemoteTask(input: RemoteCreateInput): TaskRow;
  /** 委派成功后回写 tasks 行 delegation_id */
  updateDelegationLink(taskId: string, delegationId: string): void;
}

/** 活跃委派口径：pending|running|interrupted（未终态且未取消——interrupted 会重连续跑，占负载） */
const ACTIVE_DELEGATION = new Set(['pending', 'running', 'interrupted']);

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

  const targetNodeId = await resolveRemoteTarget(input.routing, input.workspaceName, ports);
  // 行先落库再派发：外派前先有账，发送失败不丢单（RM-M21-5 手动重试面）
  const task = ports.createRemoteTask({
    workspaceId: input.workspaceId,
    title: input.title,
    description: input.description ?? '',
    ...(input.groupId !== undefined ? { groupId: input.groupId } : {}),
    status: 'pending',
    routing: input.routing,
  });
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
      },
    });
    ports.updateDelegationLink(task.id, delegationId);
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
 */
export async function resolveRemoteTarget(
  routing: Exclude<TaskRouting, { mode: 'local' }>,
  workspaceName: string,
  ports: DispatchSubmitPorts,
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
  return pickWorker({
    groupId: routing.groupId,
    workspaceName,
    // DispatchInput 契约：members 为 presence 过滤后的在线成员（pickWorker 自带
    // online 复核，此处过滤是契约遵守而非冗余）
    members: group.members
      .filter((m) => m.online)
      .map((m) => ({
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
  };
}
