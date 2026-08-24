// electron/src/main/agent/ipc.handlers.ts
//
// Agent 相关的 IPC handler 注册入口（v1.3 schema）。
//
// 暴露给渲染进程的能力：
//   - agent:addToWorkspace —— 一键编排（带 role + parentInstanceId + apiKeyOverride）
//   - agent:assignMain —— 安装 main + 自动跟随 sub
//   - agent:createFromYaml / list / listAssignments —— 低层
//   - agent:createCustom / updateDefinition / deleteDefinition —— def 管理
//   - agent:updateAssignmentRole / updateAssignmentApiKey —— assignment 编辑
//   - agent:start / stop / removeAssignment / isRunning / getBuiltinSuggestions
//
// v2（Task 10）：分配流程去 Matrix——本地身份生成（generateAgentUserId）+
//   session_members 团队会话成员写入，取代 bot 注册 + 房间邀请；agent:start 无 token。
//
// v1.3 改造要点：
//   - addToWorkspace/assignMain 写 role + parent_instance_id（不再写 def.type/parentAgentId）
//   - apiKey 解析走 resolveApiKey（override ?? provider key），不再用单独 llmApiKey 入参
//   - createCustom/updateDefinition 不含 type/parent/model 字段；含 scope/modelProviderId/modelName
//   - 删除 updateApiKey；新增 updateAssignmentApiKey / deleteDefinition /
//     updateAssignmentRole / getBuiltinSuggestions
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
  updateAssignmentRole as crudUpdateAssignmentRole,
  updateAssignmentApiKey as crudUpdateAssignmentApiKey,
  listSubAssignments,
  deleteDefinition as crudDeleteDefinition,
  updateAgentDefinition,
  createCustomDef,
  stopRunningInstancesByDefinition,
} from './crud';
import { getWorkspace, setWorkspaceCoordinator } from '../workspace/crud';
import { deleteSecret } from '../storage/keychain';
import { getDb } from '../storage/db';
import { addSessionMember } from '../storage/sessions/repo';
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
import type { AgentAssignment, AgentDefinition, AgentRole } from './types';

/** agent:addToWorkspace 入参（v1.3） */
export interface AddToWorkspaceInput {
  workspaceId: string;
  agentDefinitionId: string;
  role: AgentRole;
  /** role='sub' 时必填：同 ws 内 main assignment 的 instanceId */
  parentInstanceId?: string;
  /** 可选；非空 = 写 keychain override；空 = 用供应商 key */
  apiKeyOverride?: string;
}

/** agent:assignMain 入参（v1.3） */
export interface AssignMainInput {
  workspaceId: string;
  mainDefId: string;
  /** 可选；非空 = 写 keychain override；空 = 用供应商 key */
  apiKeyOverride?: string;
  /** 要安装的子 agent 定义 ID 列表；undefined = 不安装任何 sub（仅 main） */
  selectedSubDefIds?: string[];
}

/**
 * 安装一个 main agent，并自动跟随注册选中的 sub agent。
 * v1.3：role/parent_instance_id 写在 assignment 上（不写 def）。
 * 任一步骤失败即抛错，不做回滚（与原 addToWorkspace 失败语义一致）。
 *
 * 校验：main def 和全部 selectedSubDefIds 都必须有 modelProviderId（未配置 → throw）。
 */
export async function assignMainAgent(opts: AssignMainInput): Promise<AgentAssignment[]> {
  const { workspaceId, mainDefId, apiKeyOverride, selectedSubDefIds } = opts;

  const mainDef = getAgentDefinition(mainDefId);
  if (!mainDef) throw new Error(`未找到 agent 定义: ${mainDefId}`);
  if (!mainDef.modelProviderId) {
    throw new Error(`main agent「${mainDef.name}」未配置 modelProviderId，请先到 Agent 库配置`);
  }

  // 守卫：检查 mainDef 是否已安装到该 workspace
  const existingAssignments = listAssignments(workspaceId);
  const alreadyInstalled = existingAssignments.some((a) => a.agentDefinitionId === mainDefId);
  if (alreadyInstalled) {
    throw new Error('该 main agent 已安装到此 workspace，请先移除后再重新安装');
  }

  const workspace = getWorkspace(workspaceId);
  if (!workspace) throw new Error(`未找到 workspace: ${workspaceId}`);
  if (!workspace.teamSessionId) {
    throw new Error('workspace 尚未创建团队群（teamSessionId 为空）');
  }

  // 查找选中的 sub 定义；校验全部已配置 provider
  const subDefs: AgentDefinition[] = [];
  if (selectedSubDefIds && selectedSubDefIds.length > 0) {
    for (const subDefId of selectedSubDefIds) {
      const subDef = getAgentDefinition(subDefId);
      if (!subDef) throw new Error(`未找到子 agent 定义: ${subDefId}`);
      if (!subDef.modelProviderId) {
        throw new Error(`子 agent「${subDef.name}」未配置 modelProviderId，请先到 Agent 库配置`);
      }
      subDefs.push(subDef);
    }
  }

  // I2：跳过已安装的 sub（避免重复分配同一 def 到 workspace）
  const installedDefIds = new Set(existingAssignments.map((a) => a.agentDefinitionId));
  const newSubDefs = subDefs.filter((d) => !installedDefIds.has(d.id));

  // Phase 1：生成本地身份 + 分配 + 入团队会话 + 存 apiKeyOverride（如有）
  // v2（Task 10）：不再注册 Matrix bot / 邀请进团队群——本地身份即时生成，
  // 团队会话成员关系写 session_members 表
  const installed: Array<{ def: AgentDefinition; assignment: AgentAssignment }> = [];

  // 1a. 安装 main（role='main'）
  const mainAssignment = assignAgentToWorkspace(
    workspaceId, mainDef.id, generateAgentUserId(mainDef.slug), 'main',
  );
  addSessionMember(workspace.teamSessionId, mainAssignment.instanceId);
  if (apiKeyOverride) {
    await crudUpdateAssignmentApiKey(mainAssignment.instanceId, apiKeyOverride);
  }
  installed.push({ def: mainDef, assignment: mainAssignment });

  // 1b. 安装 subs（role='sub', parentInstanceId=mainAssignment.instanceId）
  for (const subDef of newSubDefs) {
    const subAssignment = assignAgentToWorkspace(
      workspaceId, subDef.id, generateAgentUserId(subDef.slug), 'sub', mainAssignment.instanceId,
    );
    addSessionMember(workspace.teamSessionId, subAssignment.instanceId);
    if (apiKeyOverride) {
      await crudUpdateAssignmentApiKey(subAssignment.instanceId, apiKeyOverride);
    }
    installed.push({ def: subDef, assignment: subAssignment });
  }

  // Phase 2：启动 runtime（subAgents 由 buildSpawnOpts 内部按 parent_instance_id 重建）
  const results: AgentAssignment[] = [];
  for (const { def, assignment } of installed) {
    const apiKey = await resolveApiKey(assignment.instanceId, def.modelProviderId!);
    await startAgentRuntime(
      buildSpawnOpts({
        instanceId: assignment.instanceId,
        agentUserId: assignment.agentUserId,
        workspaceId,
        workspaceDir: workspace.directoryPath,
        teamSessionId: workspace.teamSessionId,
        def,
        role: assignment.role,
        llmApiKey: apiKey,
        isCoordinator: (workspace.coordinatorInstanceId ?? null) === assignment.instanceId,
      }),
    );
    results.push(assignment);
  }

  logger.info('Main agent 及其 sub agents 已安装并启动', {
    workspaceId, mainDefId, mainSlug: mainDef.slug, subCount: newSubDefs.length,
  });
  return results;
}

/**
 * 删除 agent 分配：停止运行 → 清理 keychain override →
 * 清空悬空 coordinator 引用 → 删 assignment 行（session_members 由 FK CASCADE 清理）。
 * v1.3：若删除的是 role='main'，则级联删除同 ws 内 parent_instance_id 指向它的全部 subs。
 * v2（Task 10）：agent 无 Matrix 身份，不再做离房 / bot token 清理。
 */
export async function removeAgentAssignment(instanceId: string): Promise<void> {
  await stopAgentRuntime(instanceId);
  const row = getDb()
    .prepare('SELECT agent_user_id, workspace_id, role, parent_instance_id FROM agent_assignments WHERE instance_id = ?')
    .get(instanceId) as
    | { agent_user_id?: string; workspace_id?: string; role?: string; parent_instance_id?: string }
    | undefined;
  if (!row) return;
  const workspaceId = row.workspace_id;
  // v1.5.8：删除前记下 parent_main_id（删完之后行就没了，无法再查）
  const parentMainId = row.parent_instance_id;

  // v1.3 级联：main 被删时连带删除同 ws 内 parent_instance_id 指向它的 subs
  if (row.role === 'main' && workspaceId) {
    const subs = listSubAssignments(workspaceId, instanceId);
    for (const sub of subs) {
      await removeAgentAssignment(sub.instanceId);
    }
  }

  // 清除 API key override（如有）
  await deleteSecret(`agent.${instanceId}.api_key_override`).catch(() => {});

  // 被删实例若是协调 agent，清空引用
  if (workspaceId) {
    const ws = getWorkspace(workspaceId);
    if (ws?.coordinatorInstanceId === instanceId) {
      setWorkspaceCoordinator(workspaceId, null);
    }
  }

  getDb().prepare('DELETE FROM agent_assignments WHERE instance_id = ?').run(instanceId);
  logger.info('Agent 分配已删除', { instanceId, workspaceId });

  // v1.5.8：若删的是 sub，重启父 main agent 让其 subAgents 重建
  // （否则 PM 内存里的 subAgents 残留已删 sub 的 botUserId，dispatch_to 永远不匹配）
  // 级联删除场景：父 main 已 stop（isAgentRunning=false），重启会被静默跳过
  if (row.role === 'sub' && workspaceId && parentMainId) {
    await restartMainForSubChange(workspaceId, parentMainId);
  }
}

/**
 * v1.5.8：sub agent 变更（add/remove）后重启父 main agent，让它的 subAgents 配置
 * 重建自当前 DB——否则 PM 内存里的 subAgents 会残留旧/缺新 sub 的 botUserId，
 * dispatch event 的 dispatch_to 与新 sub 不匹配 → 子 agent 静默丢弃 → PM 等到超时。
 *
 * 静默跳过条件：
 *   - main 当前未运行（DB 已更新，下次启动自然带上新 subAgents）
 *   - main assignment 不存在（已被删）
 *   - keychain 缺 apiKey
 */
async function restartMainForSubChange(
  workspaceId: string,
  mainInstanceId: string,
): Promise<void> {
  if (!isAgentRunning(mainInstanceId)) return;

  const ws = getWorkspace(workspaceId);
  if (!ws) return;

  const assignment = listAssignments(workspaceId).find(
    (a) => a.instanceId === mainInstanceId,
  );
  if (!assignment) return;

  const def = getAgentDefinition(assignment.agentDefinitionId);
  if (!def || !def.modelProviderId) return;

  const apiKey = await resolveApiKey(assignment.instanceId, def.modelProviderId);

  await stopAgentRuntime(mainInstanceId);
  await startAgentRuntime(
    buildSpawnOpts({
      instanceId: assignment.instanceId,
      agentUserId: assignment.agentUserId,
      workspaceId,
      workspaceDir: ws.directoryPath,
      teamSessionId: ws.teamSessionId,
      def,
      role: assignment.role,
      llmApiKey: apiKey,
      isCoordinator: (ws.coordinatorInstanceId ?? null) === assignment.instanceId,
    }),
  );
  logger.info('Main agent 因 sub 变更已重启（重建 subAgents）', {
    mainInstanceId,
    workspaceId,
  });
}

/**
 * v2 修复：若 instanceId 是 sub，重启其 parent main。
 * 用于 agent:start / agent:stop 末尾——sub 状态变化时让 main 的 dispatch 工具列表刷新。
 *
 * 内部委托 restartMainForSubChange（已存在），仅在 instanceId 是 sub 时执行。
 * standalone / main / parent 不存在时 no-op。
 */
async function maybeRestartMainForSubChange(instanceId: string): Promise<void> {
  const row = getDb()
    .prepare('SELECT workspace_id, role, parent_instance_id FROM agent_assignments WHERE instance_id = ?')
    .get(instanceId) as
      | { workspace_id: string; role: string; parent_instance_id: string | null }
      | undefined;
  if (row?.role === 'sub' && row.parent_instance_id) {
    await restartMainForSubChange(row.workspace_id, row.parent_instance_id);
  }
}

/** 注册全部 agent: 命名空间的 IPC handler。在 app ready 后由 registerIpcHandlers 统一调用。 */
export function registerAgentHandlers(): void {
  // 一键编排：注册 bot + 分配（带 role/parent）+ 邀请 + 启动 runtime
  ipcMain.handle(
    'agent:addToWorkspace',
    async (_evt, input: AddToWorkspaceInput) => {
      const { workspaceId, agentDefinitionId, role, parentInstanceId, apiKeyOverride } = input;

      const def = getAgentDefinition(agentDefinitionId);
      if (!def) throw new Error(`未找到 agent 定义: ${agentDefinitionId}`);
      if (!def.modelProviderId) {
        throw new Error(`agent 定义「${def.name}」未配置 modelProviderId，请先到 Agent 库配置`);
      }

      const workspace = getWorkspace(workspaceId);
      if (!workspace) throw new Error(`未找到 workspace: ${workspaceId}`);
      if (!workspace.teamSessionId) {
        throw new Error('workspace 尚未创建团队群（teamSessionId 为空）');
      }

      // v2（Task 10）：本地身份生成 + 团队会话成员写入，取代 bot 注册 + 房间邀请
      const assignment = assignAgentToWorkspace(
        workspaceId, agentDefinitionId, generateAgentUserId(def.slug), role, parentInstanceId ?? null,
      );
      addSessionMember(workspace.teamSessionId, assignment.instanceId);

      if (apiKeyOverride) {
        await crudUpdateAssignmentApiKey(assignment.instanceId, apiKeyOverride);
      }

      const apiKey = await resolveApiKey(assignment.instanceId, def.modelProviderId);
      await startAgentRuntime(
        buildSpawnOpts({
          instanceId: assignment.instanceId,
          agentUserId: assignment.agentUserId,
          workspaceId,
          workspaceDir: workspace.directoryPath,
          teamSessionId: workspace.teamSessionId,
          def,
          role: assignment.role,
          llmApiKey: apiKey,
          isCoordinator: (workspace.coordinatorInstanceId ?? null) === assignment.instanceId,
        }),
      );

      logger.info('Agent 已添加到 workspace 并启动', {
        slug: def.slug, workspaceId, instanceId: assignment.instanceId, role,
      });

      // v1.5.8：若新增的是 sub，重启父 main 让 subAgents 重建（含新 sub 的 botUserId）
      if (role === 'sub' && parentInstanceId) {
        await restartMainForSubChange(workspaceId, parentInstanceId);
      }

      return assignment;
    },
  );

  ipcMain.handle(
    'agent:assignMain',
    async (_evt, opts: AssignMainInput) => assignMainAgent(opts),
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
      // 低层 API：保留向后兼容，默认 role='standalone'
      return assignAgentToWorkspace(workspaceId, agentDefinitionId, agentUserId, 'standalone');
    },
  );

  ipcMain.handle('agent:listAssignments', async (_evt, workspaceId: string) => {
    return listAssignments(workspaceId);
  });

  ipcMain.handle('agent:stop', async (_evt, instanceId: string) => {
    await stopAgentRuntime(instanceId);
    await maybeRestartMainForSubChange(instanceId);
    return { ok: true };
  });

  ipcMain.handle('agent:removeAssignment', async (_evt, instanceId: string) => {
    await removeAgentAssignment(instanceId);
    return { ok: true };
  });

  ipcMain.handle('agent:isRunning', async (_evt, instanceId: string) => {
    return isAgentRunning(instanceId);
  });

  // 修改 assignment 的 role + parent（含循环引用校验）
  // 主进程只更新 DB；调用方需自行停止 + 重启 runtime 才能应用新角色
  ipcMain.handle(
    'agent:updateAssignmentRole',
    async (
      _evt,
      instanceId: string,
      role: AgentRole,
      parentInstanceId?: string,
    ) => {
      crudUpdateAssignmentRole(instanceId, role, parentInstanceId ?? null);

      // 如从 main 改为非 main，停止其全部 subs（它们失去父）
      const wsRow = instanceId
        ? (getDb()
            .prepare('SELECT workspace_id FROM agent_assignments WHERE instance_id = ?')
            .get(instanceId) as { workspace_id: string } | undefined)
        : undefined;
      const wsId = wsRow?.workspace_id ?? '';
      const allAssignments = wsId ? listAssignments(wsId) : [];
      const stopped: string[] = [];
      const current = allAssignments.find((a) => a.instanceId === instanceId);
      // 仅当从 main 改为非 main 时级联停止 subs
      if (current && current.role === 'main' && role !== 'main') {
        const oldSubs = listSubAssignments(current.workspaceId, instanceId);
        for (const sub of oldSubs) {
          if (isAgentRunning(sub.instanceId)) {
            await stopAgentRuntime(sub.instanceId);
            stopped.push(sub.instanceId);
          }
        }
      }
      return { stoppedInstanceIds: stopped };
    },
  );

  // 设置/清除 assignment 的 API key override
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
          teamSessionId: workspace.teamSessionId,
          def,
          role: assignment.role,
          llmApiKey,
          isCoordinator: (workspace.coordinatorInstanceId ?? null) === assignment.instanceId,
        }),
      );

      await maybeRestartMainForSubChange(assignment.instanceId);

      return { instanceId: assignment.instanceId };
    },
  );

  logger.info('Agent IPC handlers 已注册');
}
