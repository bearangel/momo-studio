// electron/src/main/agent/auto-start.ts
//
// 应用启动时自动恢复已分配的 agent（v1 fallback 路径）。
//
// task-driven 架构（T7 改造）：
//   - task_driven=1 的 agent 由 main/index.ts 的 initTaskDrivenRuntime 接管
//     （创建 WarmPool + AgentRunner + 预热 + 启动 RouterService）。
//   - task_driven=0 的 agent 仍走本函数的 v1 spawn 路径（长期运行子进程）。
//   - auth 登录流程也调 autoStartAgents——在 task-driven 模式下，
//     initTaskDrivenRuntime 已在 autoRestoreSession 中先于 autoStartAgents 调用，
//     task_driven=1 的 agent 已在 agentRunners/agentWarmPools 中，本函数的
//     isV1SubprocessAlive 仅查 v1 runtimes Map（与 task-driven 路径解耦）；
//     task-driven agent 由下方的 def.taskDriven !== false 守卫跳过。
//
// v1.3 改造：
//   - role 来自 assignment（不再从 def.type 推断）
//   - subAgents 由 buildSpawnOpts 按 assignment.parent_instance_id 重建
//   - apiKey 解析走 resolveApiKey（override ?? provider key）；def.modelProviderId=NULL 时跳过
//   - 老的 llmApiKeyRef keychain key 仅作 fallback（向后兼容）

import { getDb } from '../storage/db';
import { spawnAgent, isV1SubprocessAlive } from './runtime-manager';
import { getAgentDefinition, listSubAssignments } from './crud';
import { getWorkspace } from '../workspace/crud';
import { buildSpawnOpts, resolveApiKey, HOMESERVER_URL } from './spawn-helpers';
import { createMatrixClient } from '../matrix/client';
import { logger } from '../logger';
import type { AgentRole } from './types';

interface AssignmentRow {
  instance_id: string;
  workspace_id: string;
  agent_definition_id: string;
  bot_matrix_user_id: string;
  enabled: number;
  /** v1.5.8：用户最近运行意图（1=运行 / 0=主动下线） */
  last_running: number;
  role: string;
}

/**
 * v1 自动启动入口。
 *
 * task-driven 模式下（T7 改造）：
 *   - task_driven=1 的 agent 由 initTaskDrivenRuntime 接管，本函数不再处理它们。
 *   - task_driven=0 的 agent 继续走 v1 spawn 路径（保留向后兼容）。
 *
 * 幂等：v1 子进程已在 runtimes Map 中的 agent 会被 isV1SubprocessAlive 跳过，避免重复 spawn。
 * 注意：isV1SubprocessAlive 只看 v1 runtimes Map——不查 DB last_running（用户启动意图）。
 *       task-driven agent（task_driven=1）不在本路径检查范围内，由 def.taskDriven !== false 跳过。
 *
 * Task 2 review C1 修复：原 isAgentRunning 已改查 DB（语义=用户启动意图），
 *   而本函数 SELECT 已过滤 last_running=1，导致 isAgentRunning 守卫永远为真，
 *   spawnAgent 永不调用 → 自启动成 no-op。改用 isV1SubprocessAlive 恢复 v1 重复 spawn 防护。
 */
export async function autoStartAgents(): Promise<void> {
  const db = getDb();
  // v1.5.8：只启动 enabled=1（assignment 存在）AND last_running=1（用户未主动下线）的 agent
  const rows = db
    .prepare('SELECT * FROM agent_assignments WHERE enabled = 1 AND last_running = 1')
    .all() as AssignmentRow[];
  if (rows.length === 0) {
    logger.info('没有需要自启动的 agent');
    return;
  }

  let started = 0;
  let failed = 0;
  let skipped = 0;

  for (const row of rows) {
    if (isV1SubprocessAlive(row.instance_id)) continue;

    try {
      const def = getAgentDefinition(row.agent_definition_id);
      if (!def) {
        logger.warn('Agent 定义不存在，跳过', { defId: row.agent_definition_id });
        failed++;
        continue;
      }

      // T7：task_driven=1 的 agent 由 initTaskDrivenRuntime 接管，跳过 v1 spawn
      if (def.taskDriven !== false) {
        skipped++;
        continue;
      }

      // v1.3：def 未配置 provider 时跳过（强制用户重配）
      if (!def.modelProviderId) {
        logger.warn('Agent 定义未配置 modelProviderId，跳过自启动', {
          slug: def.slug, instanceId: row.instance_id,
        });
        skipped++;
        continue;
      }

      const ws = getWorkspace(row.workspace_id);
      if (!ws) {
        logger.warn('Workspace 不存在，跳过', { wsId: row.workspace_id });
        failed++;
        continue;
      }

      const apiKey = await resolveApiKey(row.instance_id, def.modelProviderId);

      const rawToken = await getBotToken(row.bot_matrix_user_id);
      if (!rawToken) {
        logger.warn('Bot Matrix token 丢失，跳过', { botUserId: row.bot_matrix_user_id });
        failed++;
        continue;
      }

      // v1.5.8：spawn 前主动验证 token——避免失效 token 触发子进程崩溃重启循环（matrix-js-sdk 收到 M_UNKNOWN_TOKEN 会 fatal exit）
      let token = rawToken;
      const tokenCheck = await verifyBotToken(row.bot_matrix_user_id, token);
      if (!tokenCheck.ok) {
        // token 失效——尝试用 keychain 里的 password 重新 login（应对 Conduwuit 重启 token 丢失）
        const relogin = await tryReloginBot(row.bot_matrix_user_id);
        if (relogin.ok) {
          token = relogin.token;
          logger.info('Bot token 失效，已用 password 重新登录获得新 token', {
            instanceId: row.instance_id,
            botUserId: row.bot_matrix_user_id,
            slug: def.slug,
          });
        } else {
          logger.warn('Bot Matrix token 在服务端失效且无 password 可恢复，跳过自启动', {
            instanceId: row.instance_id,
            botUserId: row.bot_matrix_user_id,
            slug: def.slug,
            reason: tokenCheck.reason,
            tokenPrefix: `${token.slice(0, 8)}…`,
            hint: '老 bot（v1.5.8 前注册）未存 password，请在 UI 删除该 agent 后重新安装',
          });
          failed++;
          continue;
        }
      }

      spawnAgent(
        buildSpawnOpts({
          instanceId: row.instance_id,
          botUserId: row.bot_matrix_user_id,
          workspaceId: row.workspace_id,
          workspaceDir: ws.directoryPath,
          teamRoomId: ws.teamRoomId ?? ws.matrixSpaceId,
          ownerUserId: ws.ownerId,
          def,
          role: row.role as AgentRole,
          botAccessToken: token,
          llmApiKey: apiKey,
          isCoordinator: (ws.coordinatorInstanceId ?? null) === row.instance_id,
        }),
      );
      const subCount = row.role === 'main'
        ? listSubAssignments(row.workspace_id, row.instance_id).length
        : 0;

      started++;
      logger.info('Agent 已自启动（v1 路径）', {
        slug: def.slug,
        instanceId: row.instance_id,
        role: row.role,
        subAgentCount: subCount,
      });
    } catch (err) {
      failed++;
      logger.error('Agent 自启动失败', {
        instanceId: row.instance_id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  logger.info('Agent 自启动完成（v1 fallback）', { started, failed, skipped, total: rows.length });
}

/** 从 keychain 取 bot Matrix token（封装 helper，便于日志统一） */
async function getBotToken(botUserId: string): Promise<string | null> {
  const { getSecret } = await import('../storage/keychain');
  return getSecret(`bot.${botUserId}.matrix_token`);
}

/**
 * v1.5.8：用 bot token 调 Conduwuit 的 /account/whoami 验证 token 是否仍被服务端认可。
 * 失败常见原因：Conduwuit 数据被清/重启换 DB、token 被 Matrix 服务器主动撤销、keychain 残留旧环境 token。
 * 用GET /whoami 而非 startClient：避免触发 pushrules 等重流程，单次往返即得答案。
 */
async function verifyBotToken(
  botUserId: string,
  token: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    const client = createMatrixClient({
      baseUrl: HOMESERVER_URL,
      userId: botUserId,
      accessToken: token,
    });
    // whoami 是 matrix-js-sdk 的轻量认证探测端点；401 → 抛 MatrixError
    await client.whoami();
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: msg };
  }
}

/**
 * 完整的 bot token 解析流程：keychain 取 token → whoami 验证 → 失效则 password re-login。
 * task-driven runtime（initTaskDrivenRuntime）和 v1 autoStartAgents 共用此逻辑。
 *
 * @returns 有效 token；keychain 无 token 或 re-login 也失败时返回 null
 */
export async function resolveBotToken(botUserId: string): Promise<string | null> {
  const rawToken = await getBotToken(botUserId);
  if (!rawToken) return null;

  const tokenCheck = await verifyBotToken(botUserId, rawToken);
  if (tokenCheck.ok) return rawToken;

  const relogin = await tryReloginBot(botUserId);
  return relogin.ok ? relogin.token : null;
}

/**
 * v1.5.8：token 失效时用 keychain 里的 password 重新登录拿新 token。
 * 应对 Conduwuit 重启导致 token 全部丢失的场景（user 用 password 重新 login，
 * bot 同理——前提是注册时已把 password 存入 keychain）。
 *
 * 成功则把新 token 写回 keychain（更新 token 缓存）。
 *
 * @returns ok=true + 新 token；ok=false + reason（无 password / login 失败）
 */
async function tryReloginBot(
  botUserId: string,
): Promise<{ ok: true; token: string } | { ok: false; reason: string }> {
  const { getSecret, setSecret } = await import('../storage/keychain');
  const password = await getSecret(`bot.${botUserId}.matrix_password`);
  if (!password) {
    return { ok: false, reason: 'keychain 无 bot password（v1.5.8 前注册的 bot 不存 password）' };
  }

  // bot userId 的 localpart——matrix m.login.password 接受 localpart 作为 user
  const localpart = botUserId.replace(/^@|:.*$/g, '');
  try {
    const client = createMatrixClient({ baseUrl: HOMESERVER_URL });
    const raw = await client.login('m.login.password', {
      user: localpart,
      password,
      initial_device_display_name: 'Momo Studio Agent Bot',
    });
    const response = raw as { access_token?: string };
    if (typeof response.access_token !== 'string') {
      return { ok: false, reason: 'login 返回缺 access_token' };
    }
    await setSecret(`bot.${botUserId}.matrix_token`, response.access_token);
    return { ok: true, token: response.access_token };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `login 失败: ${msg}` };
  }
}
