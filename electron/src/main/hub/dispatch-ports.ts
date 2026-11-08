// electron/src/main/hub/dispatch-ports.ts
//
// submitRoutedTask 生产端口装配（原 hub/ipc.handlers.ts 内联——2026-11-08
// 抽出共用：agent 工具面 create_task 路由分支与 IPC 通道 hub:submitRoutedTask /
// hub:routingPrecheck / hub:retryDispatch 复用同一实例，防两处分叉漂移）。
import { createGroupClient } from './groups';
import { TASK_RPC } from './protocol';
import { hubProtoVer, hubListMirrorRegistry, hubRequest } from './index';
import { assertBoardGroupValid, createTaskFromForm } from '../task/ipc.handlers';
import type { DispatchSubmitPorts } from './dispatch-submit';
import { insertTaskWithRelations } from '../task/relations';
import { deriveBlockedBy } from '../storage/tasks/dependencies-repo';
import { updateTask } from '../storage/tasks/repo';
import { listTeams } from '../agent/team';

// 组管理客户端单点：绑定 hubRequest（与 IPC 面同一形态；纯函数集，无状态）
const groups = createGroupClient((method, payload, timeoutMs) => hubRequest(method, payload, timeoutMs));

export function buildDispatchSubmitPorts(): DispatchSubmitPorts {
  return {
    listGroups: async () => (await groups.list()).groups,
    getTeamSnapshot: (workspaceId, teamId) => {
      const team = listTeams(workspaceId).find((t) => t.id === teamId);
      if (!team) return null;
      return {
        name: team.name,
        members: team.members.map((m) => ({
          agentName: m.agentName,
          isLeader: m.instanceId === team.leaderInstanceId,
        })),
      };
    },
    hubProtoVer: () => hubProtoVer(),
    listDelegations: async (groupId) =>
      (await hubRequest<{ tasks: Array<{ taskId: string; targetNodeId: string; status: string }> }>(
        TASK_RPC.list,
        { groupId },
        undefined,
      )).tasks,
    listMirrorRegistry: (workspaceName) => hubListMirrorRegistry(workspaceName),
    // 派发闸（blockedDispatchError——依赖未满足拒委派）在 submitRoutedTask
    // 单源执行，端口层不重复设闸
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
      return insertTaskWithRelations(
        {
          workspaceId: input.workspaceId,
          title: input.title,
          creatorUserId: 'owner',
          status: input.status,
          description: input.description,
          groupId: input.groupId,
          routing: input.routing,
          targetTeamId: input.targetTeamId ?? null,
          ...(input.draft === true ? { origin: 'peer_draft' as const } : {}),
        },
        { dependsOn: input.dependsOn ?? [] },
      );
    },
    deriveBlockedBy: (taskId) => deriveBlockedBy([taskId]).get(taskId) ?? [],
    updateDelegationLink: (taskId, delegationId, routing) => {
      updateTask(taskId, { delegationId, routing });
    },
  };
}
