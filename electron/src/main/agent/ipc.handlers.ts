// electron/src/main/agent/ipc.handlers.ts
//
// Agent / 团队相关的 IPC handler 注册入口（v25 Task 6 通道面，spec §5）。
//
// 暴露给渲染进程的能力：
//   - agent:addMember —— 成员加入 + 启动（v25：无 role/parent）
//   - agent:createFromYaml / list / assign —— 低层
//   - agent:createCustom / updateDefinition / deleteDefinition —— def 管理
//   - agent:listMembers / removeMember / setMemberApiKeyOverride —— 成员制（原 assignment 系列平移）
//   - agent:getMemberDeltas / setMemberDeltas —— Layer 3 能力 delta
//   - agent:start / stop / isRunning / getBuiltinSuggestions
//   - team:list/create/rename/delete/setLeader/addMember/removeMember —— 团队（spec §4.2）
//
// v25（spec 2026-08-31）：去编排——agent:assignMain / agent:updateAssignmentRole
// 随 role/parent 概念退役删除；assignment 字样通道统一更名 member。
//
// v2（Task 10）：分配流程去 Matrix——本地身份生成（generateAgentUserId），
// agent:start 无 token。
import { ipcMain } from 'electron';
import { logger } from '../logger';
import { parseAgentManifest } from './manifest-parser';
import {
  saveAgentDefinition,
  listAgentDefinitions,
  getAgentDefinition,
  addMember,
  generateAgentUserId,
  listMembers,
  removeMember,
  type RemoveMemberResult,
  updateAssignmentApiKey as crudUpdateAssignmentApiKey,
  deleteDefinition as crudDeleteDefinition,
  updateAgentDefinition,
  createCustomDef,
  stopRunningInstancesByDefinition,
} from './crud';
import {
  createTeam,
  renameTeam,
  setLeader,
  addTeamMember,
  removeTeamMember,
  deleteTeam,
  listTeams,
} from './team';
import { getWorkspace } from '../workspace/crud';
import { deleteSecret } from '../storage/keychain';
import { isAgentRunning } from './runtime-status';
import { startAgentRuntime, stopAgentRuntime } from './runtime-registry';
import { buildSpawnOpts, resolveApiKey } from './spawn-helpers';
import { getBuiltinSuggestionsMap } from './builtin';
import { broadcastLocalResourceCatalog } from '../p2p/resource-share';
import {
  getAssignmentDeltas,
  setAssignmentDeltas,
  type AssignmentDeltas,
} from './assignment-capabilities';
import type { AgentAssignment, AgentDefinition } from './types';

/** agent:addMember 入参（v25 spec §5：AddMemberInput；无 role/parent；同 ws 同 def 重复加入由 UNIQUE 约束报错） */
export interface AddMemberInput {
  workspaceId: string;
  agentDefinitionId: string;
  /** 可选；非空 = 写 keychain override；空 = 用供应商 key */
  apiKeyOverride?: string;
}

/**
 * 移除 agent 成员（v25 spec §4.1）：
 *  1. removeMember 内 leader 守卫 + 事务删除——blocked 时直接返回，零副作用
 *  2. 已删行后收尾：销毁 runtime（内存态；DB last_running 写已无行，天然 no-op）+
 *     清 keychain override（session_members/team_members 由 FK CASCADE 清理）
 * 返回结构化结果供 renderer 提示 blocked 原因。
 */
export async function removeAgentAssignment(instanceId: string): Promise<RemoveMemberResult> {
  const result = removeMember(instanceId);
  if (!result.ok) {
    return result;
  }
  await stopAgentRuntime(instanceId);
  await deleteSecret(`agent.${instanceId}.api_key_override`).catch(() => {});
  logger.info('Agent 成员已移除', { instanceId });
  return result;
}

/** 注册全部 agent: / team: 命名空间的 IPC handler。在 app ready 后由 registerIpcHandlers 统一调用。 */
export function registerAgentHandlers(): void {
  // 成员加入 workspace：本地身份生成 + 启动 runtime（v25：无 role/parent/自动入团）
  ipcMain.handle(
    'agent:addMember',
    async (_evt, input: AddMemberInput) => {
      const { workspaceId, agentDefinitionId, apiKeyOverride } = input;

      const def = getAgentDefinition(agentDefinitionId);
      if (!def) throw new Error(`未找到 agent 定义: ${agentDefinitionId}`);
      if (!def.modelProviderId) {
        throw new Error(`agent 定义「${def.name}」未配置 modelProviderId，请先到 Agent 库配置`);
      }

      const workspace = getWorkspace(workspaceId);
      if (!workspace) throw new Error(`未找到 workspace: ${workspaceId}`);

      // v2（Task 10）：本地身份生成，取代 bot 注册 + 房间邀请；
      // apiKeyOverride 一并由 addMember 落 keychain + DB 标志
      const member = await addMember(
        workspaceId, agentDefinitionId, generateAgentUserId(def.slug), apiKeyOverride,
      );

      const apiKey = await resolveApiKey(member.instanceId, def.modelProviderId);
      await startAgentRuntime(
        buildSpawnOpts({
          instanceId: member.instanceId,
          agentUserId: member.agentUserId,
          workspaceId,
          workspaceDir: workspace.directoryPath,
          // v25 过渡态：团队会话列已退役，传空串保持线协议形状
          teamSessionId: '',
          def,
          llmApiKey: apiKey,
        }),
      );

      logger.info('Agent 已加入 workspace 并启动', {
        slug: def.slug, workspaceId, instanceId: member.instanceId,
      });

      return member;
    },
  );

  // 从 YAML 创建 agent 定义。v1.3：不再做 parentAgentId slug→UUID 解析
  //（角色/父子关系已移到 assignment 级，def 不再存这些字段）
  ipcMain.handle('agent:createFromYaml', async (_evt, yamlContent: string) => {
    const def = parseAgentManifest(yamlContent);
    saveAgentDefinition(def);
    logger.info('Agent 定义已创建（来自 YAML）', { slug: def.slug });
    return def;
  });

  // 创建自定义 agent 定义（v1.3：scope + modelProviderId + modelName；v1.6：可选 defaultTools/Mcps/Skills）
  ipcMain.handle(
    'agent:createCustom',
    async (_evt, input: {
      name: string;
      slug: string;
      description?: string;
      systemPrompt: string;
      iconEmoji?: string;
      scope: 'global' | 'workspace';
      modelProviderId: string;
      modelName: string;
      /** v1.6：可选 workspaceId（scope='workspace' 时必传，调用方负责）；缺省 = null */
      workspaceId?: string;
      /** v1.6：可选默认工具集，缺省由 createCustomDef 走 SAFE_MINIMUM_TOOLS */
      defaultTools?: Array<{ kind: 'builtin'; ref: string }>;
      defaultMcps?: Array<{ kind: 'mcp'; ref: string; versionRange?: string }>;
      defaultSkills?: Array<{ kind: 'skill'; ref: string; versionRange?: string }>;
    }) => {
      const workspaceId = input.scope === 'workspace'
        ? input.workspaceId ?? null
        : null;
      const def = createCustomDef(workspaceId, input);
      // P4 Task 4：自定义 agent 创建成功 → 广播资源目录（fire-and-forget）
      void broadcastLocalResourceCatalog();
      return def;
    },
  );

  // 编辑 agent 定义（v1.3：scope + modelProviderId + modelName；v1.6：可选 defaultTools/Mcps/Skills）
  ipcMain.handle(
    'agent:updateDefinition',
    async (_evt, input: {
      id: string;
      name?: string;
      description?: string;
      systemPrompt?: string;
      iconEmoji?: string;
      scope?: 'global' | 'workspace';
      modelProviderId?: string;
      modelName?: string;
      /** v1.6：可选 workspaceId（v25 定义全局化后语义退役，仅向后兼容接收） */
      workspaceId?: string;
      /** v1.6：undefined=不改；传值（含 []）= 覆盖 */
      defaultTools?: Array<{ kind: 'builtin'; ref: string }>;
      defaultMcps?: Array<{ kind: 'mcp'; ref: string; versionRange?: string }>;
      defaultSkills?: Array<{ kind: 'skill'; ref: string; versionRange?: string }>;
    }) => {
      // v25 定义全局化：scope/workspaceId 不再持久化（列已 DROP），仅接收不消费
      const updated = updateAgentDefinition({
        id: input.id,
        name: input.name,
        description: input.description,
        systemPrompt: input.systemPrompt,
        iconEmoji: input.iconEmoji,
        modelProviderId: input.modelProviderId,
        modelName: input.modelName,
        defaultTools: input.defaultTools,
        defaultMcps: input.defaultMcps,
        defaultSkills: input.defaultSkills,
      });
      const stopped = await stopRunningInstancesByDefinition(input.id);
      if (stopped.length > 0) {
        logger.info('Agent 定义更新，已停止运行中实例', { id: input.id, stopped: stopped.length });
      }
      // P4 Task 4：定义更新成功 → 广播资源目录（全量重扫；非 custom def 更新无害）
      void broadcastLocalResourceCatalog();
      return { definition: updated, stoppedInstanceIds: stopped };
    },
  );

  // 删除自定义 agent 定义（builtin 不可删；级联清理 assignment）
  ipcMain.handle(
    'agent:deleteDefinition',
    async (_evt, defId: string) => {
      const result = await crudDeleteDefinition(defId);
      // P4 Task 4：自定义 agent 删除成功 → 广播资源目录（fire-and-forget）
      void broadcastLocalResourceCatalog();
      return result;
    },
  );

  // 列出 agent 定义（v1.3：可选 workspaceId 过滤）
  ipcMain.handle('agent:list', async (_evt, workspaceId?: string) => {
    return listAgentDefinitions(workspaceId);
  });

  ipcMain.handle(
    'agent:assign',
    async (_evt, workspaceId: string, agentDefinitionId: string, agentUserId: string) => {
      return addMember(workspaceId, agentDefinitionId, agentUserId);
    },
  );

  ipcMain.handle('agent:listMembers', async (_evt, workspaceId: string) => {
    return listMembers(workspaceId);
  });

  ipcMain.handle('agent:stop', async (_evt, instanceId: string) => {
    await stopAgentRuntime(instanceId);
    return { ok: true };
  });

  ipcMain.handle('agent:removeMember', async (_evt, instanceId: string) => {
    return removeAgentAssignment(instanceId);
  });

  ipcMain.handle('agent:isRunning', async (_evt, instanceId: string) => {
    return isAgentRunning(instanceId);
  });

  // 设置/清除成员的 API key override（原 agent:updateAssignmentApiKey 平移更名）
  ipcMain.handle(
    'agent:setMemberApiKeyOverride',
    async (_evt, instanceId: string, apiKey: string | null) => {
      await crudUpdateAssignmentApiKey(instanceId, apiKey);
      return { ok: true };
    },
  );

  // 返回 builtin 建议 Map（UI 添加 builtin 时预填 platform）
  ipcMain.handle('agent:getBuiltinSuggestions', async () => {
    return getBuiltinSuggestionsMap();
  });

  // 读取某成员的能力 delta（Layer 3）。无 delta 时返回全空对象。
  ipcMain.handle('agent:getMemberDeltas', async (_evt, instanceId: string) => {
    return getAssignmentDeltas(instanceId);
  });

  // 全量替换某成员的能力 delta（幂等；事务内 DELETE + INSERT）。
  ipcMain.handle(
    'agent:setMemberDeltas',
    async (_evt, instanceId: string, deltas: AssignmentDeltas) => {
      setAssignmentDeltas(instanceId, deltas);
    },
  );

  // 重启 agent：解析 apiKey 后 spawn runtime（v2 Task 10：无 Matrix token）
  ipcMain.handle(
    'agent:start',
    async (
      _evt,
      opts: {
        member: AgentAssignment;
        workspaceId: string;
      },
    ) => {
      const { member, workspaceId } = opts;

      const def = getAgentDefinition(member.agentDefinitionId);
      if (!def) {
        throw new Error(`未找到 agent 定义: ${member.agentDefinitionId}`);
      }
      if (!def.modelProviderId) {
        throw new Error(`agent 定义「${def.name}」未配置 modelProviderId，请到 Agent 库配置`);
      }

      const workspace = getWorkspace(workspaceId);
      if (!workspace) {
        throw new Error(`未找到 workspace: ${workspaceId}`);
      }

      const llmApiKey = await resolveApiKey(member.instanceId, def.modelProviderId);

      await startAgentRuntime(
        buildSpawnOpts({
          instanceId: member.instanceId,
          agentUserId: member.agentUserId,
          workspaceId,
          workspaceDir: workspace.directoryPath,
          // v25 过渡态：团队会话列已退役，传空串保持线协议形状
          teamSessionId: '',
          def,
          llmApiKey,
        }),
      );

      return { instanceId: member.instanceId };
    },
  );

  // ─── team: 命名空间（spec §4.2，委托 team.ts 服务层） ──────────────────────

  ipcMain.handle('team:list', async (_evt, workspaceId: string) => {
    return listTeams(workspaceId);
  });

  ipcMain.handle(
    'team:create',
    async (
      _evt,
      workspaceId: string,
      input: {
        name: string;
        iconEmoji?: string;
        memberInstanceIds: string[];
        leaderInstanceId: string;
      },
    ) => {
      // 显式映射，杜绝多余属性混入（契约漂移防线）
      return createTeam(
        workspaceId,
        input.name,
        input.iconEmoji ?? '👥',
        input.memberInstanceIds,
        input.leaderInstanceId,
      );
    },
  );

  ipcMain.handle(
    'team:rename',
    async (_evt, teamId: string, name: string, iconEmoji?: string) => {
      renameTeam(teamId, name, iconEmoji);
      return { ok: true } as const;
    },
  );

  ipcMain.handle('team:delete', async (_evt, teamId: string) => {
    deleteTeam(teamId);
    return { ok: true } as const;
  });

  ipcMain.handle(
    'team:setLeader',
    async (_evt, teamId: string, leaderInstanceId: string) => {
      setLeader(teamId, leaderInstanceId);
      return { ok: true } as const;
    },
  );

  ipcMain.handle('team:addMember', async (_evt, teamId: string, instanceId: string) => {
    addTeamMember(teamId, instanceId);
    return { ok: true } as const;
  });

  ipcMain.handle('team:removeMember', async (_evt, teamId: string, instanceId: string) => {
    removeTeamMember(teamId, instanceId);
    return { ok: true } as const;
  });

  logger.info('Agent/Team IPC handlers 已注册');
}
