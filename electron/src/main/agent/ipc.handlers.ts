// electron/src/main/agent/ipc.handlers.ts
//
// Agent 相关的 IPC handler 注册入口。
//
// 暴露给渲染进程的能力：
//   - agent:addToWorkspace —— 成员加入 + 启动（v25：无 role/parent）
//   - agent:createFromYaml / list / listAssignments —— 低层
//   - agent:createCustom / updateDefinition / deleteDefinition —— def 管理
//   - agent:updateAssignmentApiKey —— 成员编辑
//   - agent:start / stop / removeAssignment / isRunning / getBuiltinSuggestions
//
// v25 过渡态（spec 2026-08-31）：去编排——agent:assignMain（main+sub 自动跟注）与
// agent:updateAssignmentRole（改角色）随 role/parent 概念退役删除，preload/renderer
// 侧绑定与 UI 由后续 task 一并清理；团队能力（teams）由 Task 4 增补。
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
  assignAgentToWorkspace,
  generateAgentUserId,
  listAssignments,
  updateAssignmentApiKey as crudUpdateAssignmentApiKey,
  deleteDefinition as crudDeleteDefinition,
  updateAgentDefinition,
  createCustomDef,
  stopRunningInstancesByDefinition,
} from './crud';
import { getWorkspace, setWorkspaceDefaultAgent } from '../workspace/crud';
import { deleteSecret } from '../storage/keychain';
import { getDb } from '../storage/db';
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

/** agent:addToWorkspace 入参（v25：无 role/parent；同 ws 同 def 重复加入由 UNIQUE 约束报错） */
export interface AddToWorkspaceInput {
  workspaceId: string;
  agentDefinitionId: string;
  /** 可选；非空 = 写 keychain override；空 = 用供应商 key */
  apiKeyOverride?: string;
}

/**
 * 移除 agent 成员：停止运行 → 清理 keychain override →
 * 清空悬空 default agent 引用 → 删成员行（session_members/team_members 由 FK CASCADE 清理）。
 * v25：无 role/parent 概念，main/sub 级联与父重启逻辑随去编排退役。
 */
export async function removeAgentAssignment(instanceId: string): Promise<void> {
  await stopAgentRuntime(instanceId);
  const row = getDb()
    .prepare('SELECT agent_user_id, workspace_id FROM workspace_agent_members WHERE instance_id = ?')
    .get(instanceId) as
      | { agent_user_id?: string; workspace_id?: string }
      | undefined;
  if (!row) return;
  const workspaceId = row.workspace_id;

  // 清除 API key override（如有）
  await deleteSecret(`agent.${instanceId}.api_key_override`).catch(() => {});

  // 被删实例若是默认会话 agent，清空引用
  if (workspaceId) {
    const ws = getWorkspace(workspaceId);
    if (ws?.defaultAgentInstanceId === instanceId) {
      setWorkspaceDefaultAgent(workspaceId, null);
    }
  }

  getDb().prepare('DELETE FROM workspace_agent_members WHERE instance_id = ?').run(instanceId);
  logger.info('Agent 成员已移除', { instanceId, workspaceId });
}

/** 注册全部 agent: 命名空间的 IPC handler。在 app ready 后由 registerIpcHandlers 统一调用。 */
export function registerAgentHandlers(): void {
  // 成员加入 workspace：本地身份生成 + 启动 runtime（v25：无 role/parent/自动入团）
  ipcMain.handle(
    'agent:addToWorkspace',
    async (_evt, input: AddToWorkspaceInput) => {
      const { workspaceId, agentDefinitionId, apiKeyOverride } = input;

      const def = getAgentDefinition(agentDefinitionId);
      if (!def) throw new Error(`未找到 agent 定义: ${agentDefinitionId}`);
      if (!def.modelProviderId) {
        throw new Error(`agent 定义「${def.name}」未配置 modelProviderId，请先到 Agent 库配置`);
      }

      const workspace = getWorkspace(workspaceId);
      if (!workspace) throw new Error(`未找到 workspace: ${workspaceId}`);

      // v2（Task 10）：本地身份生成，取代 bot 注册 + 房间邀请
      const member = assignAgentToWorkspace(
        workspaceId, agentDefinitionId, generateAgentUserId(def.slug),
      );

      if (apiKeyOverride) {
        await crudUpdateAssignmentApiKey(member.instanceId, apiKeyOverride);
      }

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
          isCoordinator: (workspace.defaultAgentInstanceId ?? null) === member.instanceId,
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
      /** v1.6：可选 workspaceId（scope='workspace' 时必传） */
      workspaceId?: string;
      /** v1.6：undefined=不改；传值（含 []）= 覆盖 */
      defaultTools?: Array<{ kind: 'builtin'; ref: string }>;
      defaultMcps?: Array<{ kind: 'mcp'; ref: string; versionRange?: string }>;
      defaultSkills?: Array<{ kind: 'skill'; ref: string; versionRange?: string }>;
    }) => {
      const workspaceId = input.scope === 'global'
        ? null
        : input.scope === 'workspace'
          ? input.workspaceId
          : undefined;

      const updated = updateAgentDefinition({
        id: input.id,
        name: input.name,
        description: input.description,
        systemPrompt: input.systemPrompt,
        iconEmoji: input.iconEmoji,
        modelProviderId: input.modelProviderId,
        modelName: input.modelName,
        workspaceId,
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
      return assignAgentToWorkspace(workspaceId, agentDefinitionId, agentUserId);
    },
  );

  ipcMain.handle('agent:listAssignments', async (_evt, workspaceId: string) => {
    return listAssignments(workspaceId);
  });

  ipcMain.handle('agent:stop', async (_evt, instanceId: string) => {
    await stopAgentRuntime(instanceId);
    return { ok: true };
  });

  ipcMain.handle('agent:removeAssignment', async (_evt, instanceId: string) => {
    await removeAgentAssignment(instanceId);
    return { ok: true };
  });

  ipcMain.handle('agent:isRunning', async (_evt, instanceId: string) => {
    return isAgentRunning(instanceId);
  });

  // 设置/清除成员的 API key override
  ipcMain.handle(
    'agent:updateAssignmentApiKey',
    async (_evt, instanceId: string, apiKey: string | null) => {
      await crudUpdateAssignmentApiKey(instanceId, apiKey);
      return { ok: true };
    },
  );

  // 返回 builtin 建议 Map（UI 添加 builtin 时预填 role/platform）
  ipcMain.handle('agent:getBuiltinSuggestions', async () => {
    return getBuiltinSuggestionsMap();
  });

  // v1.6：读取某 assignment 的能力 delta（Layer 3）。无 delta 时返回全空对象。
  ipcMain.handle('agent:getAssignmentDeltas', async (_evt, instanceId: string) => {
    return getAssignmentDeltas(instanceId);
  });

  // v1.6：全量替换某 assignment 的能力 delta（幂等；事务内 DELETE + INSERT）。
  ipcMain.handle(
    'agent:setAssignmentDeltas',
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
        assignment: AgentAssignment;
        workspaceId: string;
      },
    ) => {
      const { assignment, workspaceId } = opts;

      const def = getAgentDefinition(assignment.agentDefinitionId);
      if (!def) {
        throw new Error(`未找到 agent 定义: ${assignment.agentDefinitionId}`);
      }
      if (!def.modelProviderId) {
        throw new Error(`agent 定义「${def.name}」未配置 modelProviderId，请到 Agent 库配置`);
      }

      const workspace = getWorkspace(workspaceId);
      if (!workspace) {
        throw new Error(`未找到 workspace: ${workspaceId}`);
      }

      const llmApiKey = await resolveApiKey(assignment.instanceId, def.modelProviderId);

      await startAgentRuntime(
        buildSpawnOpts({
          instanceId: assignment.instanceId,
          agentUserId: assignment.agentUserId,
          workspaceId,
          workspaceDir: workspace.directoryPath,
          // v25 过渡态：团队会话列已退役，传空串保持线协议形状
          teamSessionId: '',
          def,
          llmApiKey,
          isCoordinator: (workspace.defaultAgentInstanceId ?? null) === assignment.instanceId,
        }),
      );

      return { instanceId: assignment.instanceId };
    },
  );

  logger.info('Agent IPC handlers 已注册');
}
