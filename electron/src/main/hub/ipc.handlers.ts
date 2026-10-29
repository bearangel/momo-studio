// hub 命名空间 IPC——通道名与 types.d.ts / preload 逐一对齐（momo-boundary-rules）。
import { ipcMain } from 'electron';
import {
  hubConfigure, hubDelegationBoard, hubEnroll, hubForget, hubGetDelegationSettings, hubGetPresenceNodes,
  hubGetStatus,
  hubGetViewSettings, hubGetWorkspaceDirSettings, hubListMirrorRegistry, hubLocalWaiting,
  hubMarkDelegationCancelled, hubRequest,
  hubSetDelegationSettings, hubSetViewSettings, hubSetWorkspaceDirSettings, replayPresenceSeed,
} from './index';
import { createGroupClient } from './groups';
import { publishToHub, type PublishInput } from './publish';
import { unpublishHubResource } from '../resource/hub/momo-hub';
import { buildAndUploadWorkspaceSnapshot } from './snapshot-upload';
import { RPC, TASK_RPC, VIEW_RPC } from './protocol';
import { RpcRemoteError } from './client';
import {
  resolveRemoteTarget,
  routingPrecheck,
  submitRoutedTask,
  type DispatchSubmitPorts,
  type SubmitRoutedTaskInput,
} from './dispatch-submit';
import { retryDispatch, type RedispatchPorts } from './delegation-sync';
import { assertBoardGroupValid, createTaskFromForm } from '../task/ipc.handlers';
import { insertTask, updateTask, getTask } from '../storage/tasks/repo';
import { listWorkspaces } from '../workspace/crud';
import { recordPublishAccountingSafe } from '../resource/hub-install';

// 组管理客户端单点：绑定 hubRequest（IPC 面复用同一实例；纯函数集，无状态）
const groups = createGroupClient((method, payload, timeoutMs) => hubRequest(method, payload, timeoutMs));

/**
 * M4.1 错误契约统一包裹：RpcRemoteError 的协议错误码编入 rejection message
 * 前缀 `[code] 原文` 再抛（与 M3.1 taskAnswer 现格式逐字一致）——Electron IPC
 * rejection 只保 message（自定义属性不跨进程，Electron #24427），renderer 侧
 * lib/rpc-error.ts parseRpcErrorCode 单源解析。非 RpcRemoteError 原样透传
 * （不动 user-facing-error/redact 链与本地人话错误）。
 * spec：momo-hub docs/specs/2026-10-29-momo-hub-m4.1-error-contract.md §2.1。
 */
function coded<T>(fn: () => Promise<T>): Promise<T> {
  return fn().catch((err: unknown) => {
    if (err instanceof RpcRemoteError) throw new Error(`[${err.code}] ${err.message}`);
    throw err;
  });
}

export function registerHubIpc(): void {
  ipcMain.handle('hub:getStatus', () => {
    const status = hubGetStatus();
    // 拉状态 = renderer 面板可能刚挂载（订阅已就位）→ 顺带补发在线节点快照
    replayPresenceSeed();
    return status;
  });
  // 节点清单补拉（M2.5 T3 / A6）：面板挂载与 getStatus 成功后取权威在线集合
  ipcMain.handle('hub:getNodes', () => hubGetPresenceNodes());
  ipcMain.handle('hub:configure', (_evt, input: { hubUrl: string; nodeName: string }) => hubConfigure(input));
  ipcMain.handle('hub:enroll', (_evt, input: { hubUrl: string; enrollmentToken: string; nodeName: string }) => hubEnroll(input));
  ipcMain.handle('hub:forget', () => hubForget());
  ipcMain.handle('hub:publishResource', async (_evt, input: PublishInput) => {
    const result = await publishToHub(input);
    // 发布成功回填记账（M2.2 §2.1 四类统一）：镜像快照 resources 段与目标已装
    // 判定①都以 `hub:{slug}` 记账为源——缺行即分发断链。Safe 壳：记账失败不
    // 翻转发布回执（hub 上传已成功，缺行下次升版发布可自愈）
    recordPublishAccountingSafe(input.type, result.slug, result.version, result.checksum);
    return result;
  });
  // 撤回（M3.4 §2.3.4 / B12）：hub 来源资源卡「下架」入口——HTTP Bearer 直连
  // （与 publish 同信任模型）；404/未接入等以人话 rejection 抛出（renderer toast）
  ipcMain.handle('hub:unpublishResource', (_evt, input: { slug: string }) =>
    unpublishHubResource(input.slug));
  // 工作组六通道（M2b spec §3.1）——payload 直接采用 renderer 契约形状；
  // coded 包裹（M4.1）：hub res.ok=false 的 code 编入前缀给 renderer 判别
  ipcMain.handle('hub:groupList', () => coded(() => groups.list()));
  ipcMain.handle('hub:groupCreate', (_evt, input: { groupName: string }) => coded(() => groups.create(input.groupName)));
  ipcMain.handle('hub:groupInvite', (_evt, input: { groupId: string }) => coded(() => groups.invite(input.groupId)));
  ipcMain.handle('hub:groupJoin', (_evt, input: { inviteCode: string }) => coded(() => groups.join(input.inviteCode)));
  ipcMain.handle('hub:groupLeave', (_evt, input: { groupId: string }) => coded(() => groups.leave(input.groupId)));
  ipcMain.handle('hub:groupTransfer', (_evt, input: { groupId: string; toNodeId: string }) => coded(() => groups.transfer(input.groupId, input.toNodeId)));
  // 镜像发起链（M2c T8b，向导 S2/S4 消费）
  ipcMain.handle('hub:snapshotBuildUpload', (_evt, input: { workspaceId: string }) =>
    buildAndUploadWorkspaceSnapshot(input.workspaceId));
  ipcMain.handle('hub:mirrorWorkspace', (_evt, input: {
    groupId: string; targetNodeId: string; workspaceName: string; snapshotId: string; confirm?: boolean;
  }) => coded(() => hubRequest(RPC.workspace.mirror, {
    groupId: input.groupId,
    targetNodeId: input.targetNodeId,
    workspaceName: input.workspaceName,
    snapshotId: input.snapshotId,
    strategy: 'replace',
    ...(input.confirm !== undefined ? { confirm: input.confirm } : {}),
  })));
  // 委派子节点设置两通道（M2e T10）：接受开关 + 并发上限（set 返回归一化值）
  ipcMain.handle('hub:getDelegationSettings', () => hubGetDelegationSettings());
  ipcMain.handle('hub:setDelegationSettings', (_evt, input: {
    acceptTasks: boolean;
    maxConcurrent: number;
    hitlTimeoutMinutes: number;
  }) => hubSetDelegationSettings(input));
  // 工作目录两通道（2026-10-27）：get/set 均回 view（rootDir/defaultRootDir/effectiveRootDir）
  ipcMain.handle('hub:getWorkspaceDirSettings', () => hubGetWorkspaceDirSettings());
  ipcMain.handle('hub:setWorkspaceDirSettings', (_evt, input: { rootDir: string | null }) =>
    hubSetWorkspaceDirSettings(input));
  // 委派 leader 侧三通道（M2e T12，spec §3.1 task.*）：list（组过滤）/ delegate
  // （账本先行 pending）/ cancel（可取消态单点校验在 hub）；载荷采用 renderer 契约形状
  ipcMain.handle('hub:taskList', (_evt, input?: { groupId?: string }) =>
    coded(() => hubRequest(TASK_RPC.list, { ...(input?.groupId !== undefined ? { groupId: input.groupId } : {}) }, undefined)));
  ipcMain.handle('hub:taskDelegate', (_evt, input: {
    groupId: string; targetNodeId: string; workspaceName: string;
    title: string; prompt: string; agentSlug?: string;
  }) => coded(() => hubRequest(TASK_RPC.delegate, {
    groupId: input.groupId,
    targetNodeId: input.targetNodeId,
    workspaceName: input.workspaceName,
    task: {
      title: input.title,
      prompt: input.prompt,
      ...(input.agentSlug !== undefined && input.agentSlug !== '' ? { agentSlug: input.agentSlug } : {}),
    },
  }, undefined)));
  // 协议无 cancelled leader 推送——取消回执即回写本地行（T9 取消链收口：
  // 外派卡取消 → hub 账本权威 → delegation-sync 行状态同步）
  ipcMain.handle('hub:taskCancel', (_evt, input: { taskId: string }) =>
    coded(() => hubRequest(TASK_RPC.cancel, input, undefined).then((res) => {
      hubMarkDelegationCancelled(input.taskId);
      return res;
    })));
  // 远程代答（M3.1）：task.answer 转发 hub（leader-only + minor 门槛 3 在 hub 侧守卫）。
  // M4.1 起内联 catch 上提为 coded helper（行为零变化——前缀格式逐字一致）：
  // renderer 侧据前缀区分「版本过低」类可读降级（hub-capability / 卡片 toast 消费）。
  ipcMain.handle('hub:taskAnswer', (_evt, input: { taskId: string; decision: 'approve' | 'deny'; message?: string }) =>
    coded(() => hubRequest(TASK_RPC.answer, input, undefined)));
  // 查看同意设置两通道（M2e T14/T15：允许本组查看开关——set 内即时上报 hub）
  ipcMain.handle('hub:getViewSettings', () => hubGetViewSettings());
  ipcMain.handle('hub:setViewSettings', (_evt, input: { allowGroupView: boolean }) => hubSetViewSettings(input));
  // 远程查看 leader 侧六通道（M2e T14，spec §3.1 view.*——hub 定向转发目标节点）；
  // M3.2 起载荷可带可选 groupId（选中组上下文——消 hub commonGroupId 多组歧义）
  ipcMain.handle('hub:viewWorkspace', (_evt, input: { targetNodeId: string; workspaceName: string; groupId?: string }) =>
    coded(() => hubRequest(VIEW_RPC.workspace, input)));
  ipcMain.handle('hub:viewSessions', (_evt, input: {
    targetNodeId: string; workspaceName: string; beforeSeq?: number; limit: number; groupId?: string;
  }) => coded(() => hubRequest(VIEW_RPC.sessions, input)));
  ipcMain.handle('hub:viewMessages', (_evt, input: {
    targetNodeId: string; sessionId: string; workspaceName?: string; fromSeq: number; limit: number; groupId?: string;
  }) => coded(() => hubRequest(VIEW_RPC.messages, input)));
  ipcMain.handle('hub:viewTasks', (_evt, input: { targetNodeId: string; workspaceName: string; groupId?: string }) =>
    coded(() => hubRequest(VIEW_RPC.tasks, input)));
  ipcMain.handle('hub:viewSubscribe', (_evt, input: { targetNodeId: string; sessionId: string; groupId?: string }) =>
    coded(() => hubRequest(VIEW_RPC.subscribe, input)));
  ipcMain.handle('hub:viewUnsubscribe', (_evt, input: { targetNodeId: string; sessionId: string; groupId?: string }) =>
    coded(() => hubRequest(VIEW_RPC.unsubscribe, input)));
  // 远程查看 M3.2 两通道（协议 1.4.0）：远端空间清单 + 只读文件树——载荷原样
  // 透传（groupId 可选段随 renderer 上下文携带，hub 定向转发目标节点）
  ipcMain.handle('hub:viewWorkspaces', (_evt, input: { targetNodeId: string; groupId?: string }) =>
    coded(() => hubRequest(VIEW_RPC.workspaces, input)));
  ipcMain.handle('hub:viewFiles', (_evt, input: {
    targetNodeId: string; workspaceName: string; op: 'list' | 'read'; path?: string; groupId?: string;
  }) => coded(() => hubRequest(VIEW_RPC.files, input)));
  // 镜像登记表查询（M2.1 T6 / RM-M21-7）：workspace.mirrored 广播的累积持久登记，
  // T3 徽标 / T4 选择器 / T7 调度 / T8 守门四消费方同源；workspaceName 可选过滤。
  // 失忆限制与 M3 票见 hub/index.ts hubListMirrorRegistry 注释。
  ipcMain.handle('hub:mirrorRegistry', (_evt, input?: { workspaceName?: string }) =>
    hubListMirrorRegistry(input?.workspaceName));
  // 路由提交链两通道（M2.1 T8）：三模式统一落点 submitRoutedTask（local 委托
  // createTaskFromForm；group 走 pickWorker+既有委派管道+delegation_id 回写；
  // node 直发）+ 预检概要（弹窗「执行位置」区数据源）。编排见 dispatch-submit.ts。
  const dispatchSubmitPorts: DispatchSubmitPorts = {
    listGroups: async () => (await groups.list()).groups,
    listDelegations: async (groupId) =>
      (await hubRequest<{ tasks: Array<{ taskId: string; targetNodeId: string; status: string }> }>(
        TASK_RPC.list,
        { groupId },
        undefined,
      )).tasks,
    listMirrorRegistry: (workspaceName) => hubListMirrorRegistry(workspaceName),
    // M4.1 裁定：delegate 端口不包 coded——两处消费方（submitRoutedTask /
    // retryDispatch）对 delegate rejection 一律吞掉落 dispatched=false（RM-M21-5
    // 瞬断留待处理，错误不达 renderer 直抛面），包了也无人消费前缀；会经
    // resolveRemoteTarget 上抛的 listGroups/listDelegations rejection 由通道级
    // coded 覆盖（hub:submitRoutedTask / hub:retryDispatch 处）。
    delegate: (brief) => hubRequest(TASK_RPC.delegate, brief, undefined),
    createLocalTask: (input) =>
      createTaskFromForm({
        workspaceId: input.workspaceId,
        title: input.title,
        description: input.description,
        groupId: input.groupId,
        routing: input.routing,
      }),
    createRemoteTask: (input) => {
      if (input.groupId !== undefined) assertBoardGroupValid(input.workspaceId, input.groupId);
      return insertTask({
        workspaceId: input.workspaceId,
        title: input.title,
        creatorUserId: 'owner',
        status: input.status,
        description: input.description,
        groupId: input.groupId,
        routing: input.routing,
      });
    },
    updateDelegationLink: (taskId, delegationId, routing) => {
      updateTask(taskId, { delegationId, routing });
    },
  };
  ipcMain.handle('hub:submitRoutedTask', (_evt, input: SubmitRoutedTaskInput) =>
    coded(() => submitRoutedTask(input, dispatchSubmitPorts)));
  ipcMain.handle('hub:routingPrecheck', (_evt, input: { workspaceName: string }) =>
    coded(() => routingPrecheck(input.workspaceName, dispatchSubmitPorts)));
  // 看板外派投影两通道（M2.1 T9）：引导读（进度摘要 kv + worker 收委派记录）+
  // 重派单点（待派发重试 RM-M21-5 / 失败重派换 delegation_id——目标解析复用
  // dispatch-submit 调度单源，委派走既有管道）
  ipcMain.handle('hub:delegationBoard', () => hubDelegationBoard());
  // 本机等待确认会话清单（M2.1 T12 worker 等待卡数据源）
  ipcMain.handle('hub:localWaiting', () => hubLocalWaiting());
  const redispatchPorts: RedispatchPorts = {
    getTask: (taskId) => getTask(taskId),
    workspaceNameOf: (workspaceId) => listWorkspaces().find((w) => w.id === workspaceId)?.name ?? null,
    resolveTarget: (routing, workspaceName) => resolveRemoteTarget(routing, workspaceName, dispatchSubmitPorts),
    // 同上：delegate rejection 被 retryDispatch 吞掉（dispatched=false 留待处理），不包
    delegate: (brief) => hubRequest(TASK_RPC.delegate, brief, undefined),
    updateTask: (taskId, patch) => {
      updateTask(taskId, patch);
    },
    now: () => Date.now(),
  };
  ipcMain.handle('hub:retryDispatch', (_evt, input: { taskId: string }) =>
    coded(() => retryDispatch(input.taskId, redispatchPorts)));
}
