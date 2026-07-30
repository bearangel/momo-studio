// electron/src/main/agent/ipc.handlers.ts
//
// Agent 相关的 IPC handler 注册入口。
// 暴露给渲染进程的能力：
//   - agent:addToWorkspace —— 一键编排：注册 bot 账号 + 分配到 workspace +
//     邀请 bot 进团队群 + 存 LLM API key + 启动 runtime（UI 主要入口）
//   - agent:createFromYaml / list / assign / listAssignments —— 低层能力
//   - agent:start / stop —— 单独控制已分配 agent 的启停
import { ipcMain } from 'electron';
import path from 'node:path';
import { logger } from '../logger';
import { parseAgentManifest } from './manifest-parser';
import {
  saveAgentDefinition,
  listAgentDefinitions,
  getAgentDefinition,
  assignAgentToWorkspace,
  listAssignments,
} from './crud';
import { getWorkspace } from '../workspace/crud';
import { getAllocation } from '../workspace/allocation';
import { mergeCapabilities } from './capability-merger';
import { getSecret, setSecret, deleteSecret } from '../storage/keychain';
import { getDb } from '../storage/db';
import { spawnAgent, stopAgent, isAgentRunning } from './runtime-manager';
import { registerAgentBot, type RegisteredBot } from './bot-registrar';
import { inviteBotToRoom } from '../matrix/rooms';
import { getOwnerMatrixClient } from '../matrix/session';
import { resolveSkillsDir } from '../paths';
import type { AgentAssignment } from './types';
import type { RuntimeSkillRef, SubAgentRef } from './builtin-tools';

// Conduwuit 固定监听 8008（与 conduit/manager.ts 的 CONDUIT_PORT 一致）。
const HOMESERVER_URL = 'http://127.0.0.1:8008';

/** LLM API key 在 keychain 中的存储 key 前缀 */
const llmApiKeyStorageKey = (instanceId: string): string => `agent.${instanceId}.llm_api_key`;

/**
 * 把 skill slug 列表解析成子进程可用的 RuntimeSkillRef。
 * cachePath 按 <userData>/skills/<slug> 约定解析；skill 包尚未安装时该路径可能不存在，
 * 子进程 SkillRegistry.register 会抛错并被 try/catch 跳过（不阻塞 agent 上线）。
 *
 * 接收 string[] 而非 SkillRef[]：T13 接线后入参来自 mergeCapabilities 的输出
 * （def.defaultSkills ∪ workspace allocation，已去重为 ref 字符串列表）。
 */
function resolveSkillSlugs(slugs: string[]): RuntimeSkillRef[] {
  const skillsDir = resolveSkillsDir();
  return slugs.map((slug) => ({ slug, cachePath: path.join(skillsDir, slug) }));
}

/** agent:addToWorkspace 入参 */
export interface AddToWorkspaceInput {
  workspaceId: string;
  agentDefinitionId: string;
  llmApiKey: string;
}

/**
 * agent:assignMain 入参 —— 安装一个 main agent 时自动跟随注册其全部 sub agent。
 * 与 addToWorkspace 的区别：assignMain 接收的是 main 定义 ID，会一次性把该 main
 * 名下所有 parentAgentId 指向它的 sub 定义也安装到位。
 */
export interface AssignMainInput {
  workspaceId: string;
  /** main agent 定义 ID（type='main'） */
  mainDefId: string;
  /** LLM API key，存入 keychain 供 main 及其全部 sub 实例的 runtime 共用 */
  llmApiKey: string;
}

/**
 * 安装一个 main agent，并自动跟随注册其全部 sub agent（listAgentDefinitions 中
 * parentAgentId 指向该 main 的定义）。对每个 agent（main + subs）执行与
 * agent:addToWorkspace 等价的全套编排：
 *   注册 bot 账号 → 分配到 workspace → 邀请进团队群 → 存 LLM API key → 启动 runtime。
 *
 * 设计取舍：
 *   - teamRoomId 从 workspace 取（单一数据源），与 addToWorkspace 一致，不信任 renderer 传入；
 *   - owner 用 workspace.ownerId（而非 getCurrentUserId），与 addToWorkspace 一致；
 *   - 所有实例共用同一把 llmApiKey（用户级 API key），逐个存入各自 instance 的 keychain key；
 *   - 任一步骤失败即抛错，不做回滚（与 addToWorkspace 的失败语义一致）。
 *
 * 导出该函数以便单测直接调用（绕过 ipcMain），handler 层只做薄封装。
 *
 * @returns 全部新建的 assignment 列表（首条为 main，其后按 sub 定义顺序排列）
 */
export async function assignMainAgent(opts: AssignMainInput): Promise<AgentAssignment[]> {
  const { workspaceId, mainDefId, llmApiKey } = opts;

  const mainDef = getAgentDefinition(mainDefId);
  if (!mainDef) throw new Error(`未找到 agent 定义: ${mainDefId}`);

  const workspace = getWorkspace(workspaceId);
  if (!workspace) throw new Error(`未找到 workspace: ${workspaceId}`);
  if (!workspace.teamRoomId) {
    throw new Error('workspace 尚未创建团队群（teamRoomId 为空）');
  }

  // owner 的 Matrix client（用于把各 bot 邀请进团队群）；从 keychain 恢复 token 构造，不启动 sync
  const ownerClient = await getOwnerMatrixClient();

  // 查找全部归属该 main 的 sub agent 定义（parentAgentId 指向 main.id）
  const subDefs = listAgentDefinitions().filter((d) => d.parentAgentId === mainDef.id);

  // Phase 1：注册 bot + 分配 + 邀请 + 存 key（先完成全部账号编排，收集每个 agent 的信息）。
  // 拆成两阶段是为了让 main 在 Phase 2 启动时已知道其全部 sub 的 botUserId——
  // dispatch:<slug> 工具的执行依赖它。
  const installed: Array<{ def: typeof mainDef; assignment: AgentAssignment; bot: RegisteredBot }> = [];
  for (const def of [mainDef, ...subDefs]) {
    const bot = await registerAgentBot({
      slug: def.slug,
      workspaceName: workspace.name,
      ownerUserId: workspace.ownerId,
      homeserverUrl: HOMESERVER_URL,
    });
    const assignment = assignAgentToWorkspace(workspaceId, def.id, bot.botUserId);
    await inviteBotToRoom(ownerClient, workspace.teamRoomId, bot.botUserId);
    await setSecret(llmApiKeyStorageKey(assignment.instanceId), llmApiKey);
    installed.push({ def, assignment, bot });
  }

  // 主 agent 名下的 sub 列表（构建 dispatch:<slug> 工具用）
  const subAgents: SubAgentRef[] = installed
    .filter((it) => it.def.type === 'sub')
    .map((it) => ({ slug: it.def.slug, botUserId: it.bot.botUserId, description: it.def.description }));

  // T13：合并三层能力（def 默认 ∪ workspace allocation），workspace 内所有 agent 共享。
  // allocation 按 workspace 取一次（同一 workspace 内不变），在循环内按各 def 合并。
  const allocation = getAllocation(workspaceId);

  // Phase 2：启动 runtime。main 携带 subAgents；其余 agent 的 subAgents 为空。
  const results: AgentAssignment[] = [];
  for (const { def, assignment, bot } of installed) {
    const merged = mergeCapabilities(def, allocation);
    spawnAgent({
      instanceId: assignment.instanceId,
      workspaceId,
      workspaceDir: workspace.directoryPath,
      botUserId: bot.botUserId,
      botAccessToken: bot.botAccessToken,
      homeserverUrl: HOMESERVER_URL,
      systemPrompt: def.systemPrompt,
      modelProvider: def.model.provider,
      modelName: def.model.model,
      llmApiKey,
      teamRoomId: workspace.teamRoomId,
      ownerUserId: workspace.ownerId,
      agentType: def.type,
      subAgents: def.type === 'main' ? subAgents : [],
      skills: resolveSkillSlugs(merged.skills),
      mcpNames: merged.mcps,
    });
    results.push(assignment);
  }

  logger.info('Main agent 及其 sub agents 已安装并启动', {
    workspaceId,
    mainDefId,
    mainSlug: mainDef.slug,
    subCount: subDefs.length,
  });
  return results;
}

/** 注册全部 agent: 命名空间的 IPC handler。在 app ready 后由 registerIpcHandlers 统一调用。 */
export function registerAgentHandlers(): void {
  // 一键编排：注册 bot 账号 → 分配到 workspace → 邀请 bot 进团队群 →
  // 存 LLM API key → 启动 runtime。UI "添加 agent" 按钮的主入口。
  // 任一步骤失败都抛错，由 renderer 转为用户可见的错误提示。
  ipcMain.handle(
    'agent:addToWorkspace',
    async (_evt, input: AddToWorkspaceInput) => {
      const { workspaceId, agentDefinitionId, llmApiKey } = input;

      const def = getAgentDefinition(agentDefinitionId);
      if (!def) throw new Error(`未找到 agent 定义: ${agentDefinitionId}`);

      const workspace = getWorkspace(workspaceId);
      if (!workspace) throw new Error(`未找到 workspace: ${workspaceId}`);
      if (!workspace.teamRoomId) {
        throw new Error('workspace 尚未创建团队群（teamRoomId 为空）');
      }

      // 1. 注册 bot Matrix 账号（token 自动存 keychain）
      const bot = await registerAgentBot({
        slug: def.slug,
        workspaceName: workspace.name,
        ownerUserId: workspace.ownerId,
        homeserverUrl: HOMESERVER_URL,
      });

      // 2. 分配 agent 到 workspace（DB 记录，绑定 botMatrixUserId）
      const assignment = assignAgentToWorkspace(workspaceId, agentDefinitionId, bot.botUserId);

      // 3. 邀请 bot 进团队群（用 owner 的 client 发 invite）
      const ownerClient = await getOwnerMatrixClient();
      await inviteBotToRoom(ownerClient, workspace.teamRoomId, bot.botUserId);

      // 4. LLM API key 存 keychain（runtime 启动时不再需要 renderer 传入）
      await setSecret(llmApiKeyStorageKey(assignment.instanceId), llmApiKey);

      // 5. 合并三层能力（T13）：def 默认 ∪ workspace allocation，去重后传给 runtime
      const allocation = getAllocation(workspaceId);
      const merged = mergeCapabilities(def, allocation);

      // 6. 启动 runtime 子进程
      spawnAgent({
        instanceId: assignment.instanceId,
        workspaceId,
        workspaceDir: workspace.directoryPath,
        botUserId: bot.botUserId,
        botAccessToken: bot.botAccessToken,
        homeserverUrl: HOMESERVER_URL,
        systemPrompt: def.systemPrompt,
        modelProvider: def.model.provider,
        modelName: def.model.model,
        llmApiKey,
        teamRoomId: workspace.teamRoomId,
        ownerUserId: workspace.ownerId,
        agentType: def.type,
        skills: resolveSkillSlugs(merged.skills),
        mcpNames: merged.mcps,
      });

      logger.info('Agent 已添加到 workspace 并启动', {
        slug: def.slug,
        workspaceId,
        instanceId: assignment.instanceId,
      });
      return assignment;
    },
  );

  // 安装 main agent 并自动跟随注册其全部 sub agent（主子安装入口）。
  // 实际逻辑在 assignMainAgent 中，handler 仅做薄封装便于单测。
  ipcMain.handle(
    'agent:assignMain',
    async (_evt, opts: AssignMainInput) => assignMainAgent(opts),
  );

  // 从 YAML manifest 字符串创建 agent 定义并持久化。校验失败会抛错（parseAgentManifest），由 IPC 层转为 rejection。
  ipcMain.handle('agent:createFromYaml', async (_evt, yamlContent: string) => {
    const def = parseAgentManifest(yamlContent);
    saveAgentDefinition(def);
    logger.info('Agent 定义已创建', { slug: def.slug });
    return def;
  });

  ipcMain.handle('agent:createCustom', async (_evt, input: {
    name: string;
    slug: string;
    description: string;
    systemPrompt: string;
    modelProvider: string;
    modelName: string;
    modelBaseUrl?: string;
    iconEmoji?: string;
  }) => {
    const { randomUUID } = await import('node:crypto');
    const def: import('./types').AgentDefinition = {
      id: randomUUID(),
      name: input.name,
      slug: input.slug,
      version: '1.0.0',
      type: 'standalone',
      runtime: 'declarative',
      systemPrompt: input.systemPrompt,
      model: {
        provider: input.modelProvider as 'openai' | 'anthropic',
        model: input.modelName,
        baseUrl: input.modelBaseUrl,
      },
      defaultTools: [
        { kind: 'builtin', ref: 'read_file' },
        { kind: 'builtin', ref: 'write_file' },
        { kind: 'builtin', ref: 'list_files' },
      ],
      defaultMcps: [],
      defaultSkills: [],
      source: 'custom',
      description: input.description,
      iconEmoji: input.iconEmoji ?? '🤖',
    };
    saveAgentDefinition(def);
    logger.info('自定义 Agent 定义已创建', { slug: def.slug });
    return def;
  });

  // 列出全部已持久化的 agent 定义
  ipcMain.handle('agent:list', async () => {
    return listAgentDefinitions();
  });

  // 把 agent 定义分配到 workspace，绑定一个 bot matrix 账号
  ipcMain.handle(
    'agent:assign',
    async (_evt, workspaceId: string, agentDefinitionId: string, botMatrixUserId: string) => {
      return assignAgentToWorkspace(workspaceId, agentDefinitionId, botMatrixUserId);
    },
  );

  // 查询某 workspace 下的全部 agent 分配记录
  ipcMain.handle('agent:listAssignments', async (_evt, workspaceId: string) => {
    return listAssignments(workspaceId);
  });

  // 停止指定 instanceId 的 agent 子进程
  ipcMain.handle('agent:stop', async (_evt, instanceId: string) => {
    stopAgent(instanceId);
    return { ok: true };
  });

  ipcMain.handle('agent:removeAssignment', async (_evt, instanceId: string) => {
    stopAgent(instanceId);
    const row = getDb()
      .prepare('SELECT bot_matrix_user_id FROM agent_assignments WHERE instance_id = ?')
      .get(instanceId) as { bot_matrix_user_id?: string } | undefined;
    if (row?.bot_matrix_user_id) {
      await deleteSecret(`bot.${row.bot_matrix_user_id}.matrix_token`).catch((e) =>
        logger.warn('清理 bot token 失败（非致命）', { error: String(e) }),
      );
    }
    getDb().prepare('DELETE FROM agent_assignments WHERE instance_id = ?').run(instanceId);
    logger.info('Agent 分配已删除', { instanceId, botUserId: row?.bot_matrix_user_id });
    return { ok: true };
  });

  // 查询指定 instanceId 的 agent 是否正在运行（UI 据此显示 running/stopped 状态）
  ipcMain.handle('agent:isRunning', async (_evt, instanceId: string) => {
    return isAgentRunning(instanceId);
  });

  // 重启已分配的 agent：从 keychain 恢复 API key + bot token 后 spawn
  // （应用重启后 agent 不会自动恢复，需用户手动重启或后续实现自动恢复）
  ipcMain.handle(
    'agent:start',
    async (
      _evt,
      opts: {
        assignment: AgentAssignment;
        workspaceId: string;
        teamRoomId: string;
      },
    ) => {
      const { assignment, workspaceId, teamRoomId } = opts;

      const def = getAgentDefinition(assignment.agentDefinitionId);
      if (!def) {
        throw new Error(`未找到 agent 定义: ${assignment.agentDefinitionId}`);
      }

      const workspace = getWorkspace(workspaceId);
      if (!workspace) {
        throw new Error(`未找到 workspace: ${workspaceId}`);
      }

      const botAccessToken = await getSecret(
        `bot.${assignment.botMatrixUserId}.matrix_token`,
      );
      if (!botAccessToken) {
        throw new Error('Bot access token 丢失（请先注册 bot 账号）');
      }

      // LLM API key 从 keychain 恢复（addToWorkspace 时存入）
      const llmApiKey = await getSecret(llmApiKeyStorageKey(assignment.instanceId));
      if (!llmApiKey) {
        throw new Error('LLM API key 丢失，请重新添加 agent');
      }

      // T13：重启时同样合并三层能力（def 默认 ∪ workspace allocation）
      const allocation = getAllocation(workspaceId);
      const merged = mergeCapabilities(def, allocation);

      spawnAgent({
        instanceId: assignment.instanceId,
        workspaceId,
        workspaceDir: workspace.directoryPath,
        botUserId: assignment.botMatrixUserId,
        botAccessToken,
        homeserverUrl: HOMESERVER_URL,
        systemPrompt: def.systemPrompt,
        modelProvider: def.model.provider,
        modelName: def.model.model,
        llmApiKey,
        teamRoomId,
        ownerUserId: workspace.ownerId,
        agentType: def.type,
        skills: resolveSkillSlugs(merged.skills),
        mcpNames: merged.mcps,
      });

      return { instanceId: assignment.instanceId };
    },
  );

  logger.info('Agent IPC handlers 已注册');
}
