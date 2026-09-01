// electron/src/main/agent/start-chain.ts
//
// agent start 链共享入口（v25 Task 9，spec §4.6「目标成员离线时自动拉起」）。
// 把 ipc.handlers 的 agent:start 内联链（成员行 → def 校验 → apiKey 解析 →
// buildSpawnOpts → startAgentRuntime）抽为按 instanceId 可调用的函数，
// 供接待路由在 runner 缺失时自动拉起后派发（RouterServiceOpts.ensureRunner）。
//
// 与 agent:start handler 的差异：入参只有 instanceId（成员行自查 DB）；
// 校验失败（成员/def/provider/workspace 缺失）照常 throw，由调用方
// （RouterService.routeUserChat）catch 后 warn 放弃派发——消息发送链不中断。

import { getDb } from '../storage/db';
import { getWorkspace } from '../workspace/crud';
import { getAgentDefinition } from './crud';
import { resolveApiKey, buildSpawnOpts } from './spawn-helpers';
import { startAgentRuntime, agentRunners } from './runtime-registry';
import { logger } from '../logger';

interface MemberRow {
  workspace_id: string;
  agent_definition_id: string;
  agent_user_id: string;
}

/**
 * 确保指定成员的 runtime 就绪（幂等：runner 已在 Map 时 no-op）。
 * 校验链与 agent:start handler 一致：成员行 → def → modelProviderId →
 * workspace → resolveApiKey → buildSpawnOpts → startAgentRuntime。
 * startAgentRuntime 内部会写 last_running=1（registerTaskDrivenRuntime），
 * 与用户手动 start 的运行态语义完全一致。
 */
export async function ensureMemberRuntime(instanceId: string): Promise<void> {
  if (agentRunners.has(instanceId)) return;

  const row = getDb()
    .prepare(
      'SELECT workspace_id, agent_definition_id, agent_user_id FROM workspace_agent_members WHERE instance_id = ?',
    )
    .get(instanceId) as MemberRow | undefined;
  if (!row) throw new Error(`未找到 agent 成员: ${instanceId}`);

  const def = getAgentDefinition(row.agent_definition_id);
  if (!def) throw new Error(`未找到 agent 定义: ${row.agent_definition_id}`);
  if (!def.modelProviderId) {
    throw new Error(`agent 定义「${def.name}」未配置 modelProviderId，请到 Agent 库配置`);
  }

  const workspace = getWorkspace(row.workspace_id);
  if (!workspace) throw new Error(`未找到 workspace: ${row.workspace_id}`);

  const llmApiKey = await resolveApiKey(instanceId, def.modelProviderId);
  await startAgentRuntime(
    buildSpawnOpts({
      instanceId,
      agentUserId: row.agent_user_id,
      workspaceId: row.workspace_id,
      workspaceDir: workspace.directoryPath,
      def,
      llmApiKey,
    }),
  );
  logger.info('接待路由自动拉起 agent runtime 完成', { instanceId });
}
