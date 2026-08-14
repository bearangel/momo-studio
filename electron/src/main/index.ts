// electron/src/main/index.ts
import { app, BrowserWindow } from 'electron';
import { createMainWindow } from './window';
import { registerIpcHandlers } from './ipc';
import { runMigrations, getDb } from './storage/db';
import { startConduit, stopConduit } from './conduit/manager';
import { setMainWindow, stopSync, startSyncFromSession, broadcastRuntimeChanged, setRouterService } from './matrix/sync-manager';
import { setMainWindow as setRuntimeMainWindow, handleStreamChunk } from './agent/runtime-manager';
import { resolveBotToken } from './agent/auto-start';
import { initP2p } from './p2p';
import { initTaskRuntime, stopTaskRuntime } from './task/runtime-init';
import { logger } from './logger';
import { WarmPool } from './agent/warm-pool';
import { AgentRunner } from './agent/agent-runner';
import { RouterService } from './agent/router-service';
import { TaskDispatcher, type AgentAssignmentInfo } from './task/dispatcher';
import type { ProviderTokenBucket } from './agent/llm/token-bucket';
import { spawnForAgent } from './agent/runtime-spawner';
import { listAssignments, getAgentDefinition } from './agent/crud';
import { listWorkspaces } from './workspace/crud';
import { buildSpawnOpts, resolveApiKey } from './agent/spawn-helpers';
import type { AgentRole } from './agent/types';

let routerService: RouterService | null = null;
const agentRunners = new Map<string, AgentRunner>();
const agentWarmPools = new Map<string, WarmPool>();
const providerBuckets = new Map<string, ProviderTokenBucket>();

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

app.whenReady().then(async () => {
  try {
    logger.info('App starting', { version: app.getVersion() });

    runMigrations();
    logger.info('Migrations complete');

    // D 子系统：启动 TaskScheduler（调度层）——提升 pending→assigned，执行层走 v1 runtime。
    initTaskRuntime();

    void startConduit().catch((err) => {
      logger.error('Conduit pre-start failed (will retry on auth)', {
        error: err instanceof Error ? err.message : String(err),
      });
    });

    registerIpcHandlers();

    const win = createMainWindow();
    setMainWindow(win);
    setRuntimeMainWindow(win);

    // 5. 如果已有登录会话，等待 Conduit 就绪后自动恢复 sync + agent
    void (async () => {
      try {
        await startConduit();
        await autoRestoreSession();
      } catch (err) {
        logger.info('Session restore deferred', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })();
  } catch (err) {
    logger.error('Fatal startup error', {
      error: err instanceof Error ? err.message : String(err),
    });
    app.quit();
  }
});

async function autoRestoreSession(): Promise<void> {
  try {
    await startSyncFromSession();
    logger.info('Session restored: Matrix sync started');
    await initTaskDrivenRuntime();
    logger.info('Task-driven runtime initialized');
    broadcastRuntimeChanged();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.info('No active session or restore failed', { error: msg });
    // 延迟 1s 发送，确保 renderer 已 mount 并注册了监听
    setTimeout(() => {
      const win = BrowserWindow.getAllWindows()[0];
      if (win && !win.isDestroyed()) {
        win.webContents.send('auth:sessionExpired', { reason: msg });
        logger.info('Notified renderer: session expired');
      }
    }, 1000);
  }

  // 无登录会话时 P2P 仍可启动（节点发现/信任管理不依赖 Matrix）
  void initP2p().catch((err) => {
    logger.warn('P2P 子系统初始化失败（不影响主流程）', {
      error: err instanceof Error ? err.message : String(err),
    });
  });
}

/**
 * task-driven runtime 初始化：遍历所有 workspace 的 assignment，
 * 为每个 task_driven=1 的 agent 创建 WarmPool + AgentRunner → 预热 → 启动 RouterService。
 * task_driven=0 的 agent 走 v1 autoStartAgents（由 auth handler 登录流程触发）。
 */
async function initTaskDrivenRuntime(): Promise<void> {
  for (const ws of listWorkspaces()) {
    for (const assignment of listAssignments(ws.id)) {
      if (agentRunners.has(assignment.instanceId)) continue;
      if (!assignment.enabled) continue;

      const def = getAgentDefinition(assignment.agentDefinitionId);
      if (!def) continue;
      if (def.taskDriven === false) continue;
      if (!def.modelProviderId) {
        logger.warn('Agent 未配置 modelProviderId，跳过 task-driven 初始化', {
          instanceId: assignment.instanceId, slug: def.slug,
        });
        continue;
      }

      try {
        const botAccessToken = await resolveBotToken(assignment.botMatrixUserId);
        if (!botAccessToken) {
          logger.warn('Bot token 丢失，跳过', { instanceId: assignment.instanceId });
          continue;
        }
        const llmApiKey = await resolveApiKey(assignment.instanceId, def.modelProviderId);

        const runtimeConfig = buildSpawnOpts({
          instanceId: assignment.instanceId,
          botUserId: assignment.botMatrixUserId,
          workspaceId: ws.id,
          workspaceDir: ws.directoryPath,
          teamRoomId: ws.teamRoomId ?? ws.matrixSpaceId,
          ownerUserId: ws.ownerId,
          def,
          botAccessToken,
          llmApiKey,
          role: assignment.role as AgentRole,
          isCoordinator: (ws.coordinatorInstanceId ?? null) === assignment.instanceId,
        });

        const pool = new WarmPool({
          poolSize: 2,
          spawn: async (agentId) => {
            const runtime = await spawnForAgent({
              assignmentId: agentId,
              runtimeConfig,
              onChunk: (chunk) => handleStreamChunk(chunk),
              onExit: (code) => {
                logger.info('task-driven runtime 退出', { agentId, code });
              },
            });
            return runtime.child;
          },
        });
        agentWarmPools.set(assignment.instanceId, pool);

        const runner = new AgentRunner({
          agentAssignmentId: assignment.instanceId,
          agentBotUserId: assignment.botMatrixUserId,
          workspaceId: ws.id,
          warmPool: pool,
        });
        agentRunners.set(assignment.instanceId, runner);

        await pool.warm(assignment.instanceId).catch((err) => {
          logger.warn('WarmPool 预热失败', {
            instanceId: assignment.instanceId, error: String(err),
          });
        });

        logger.info('task-driven agent 已初始化', {
          slug: def.slug, instanceId: assignment.instanceId, role: assignment.role,
        });
      } catch (err) {
        logger.warn('task-driven agent 初始化失败', {
          instanceId: assignment.instanceId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  if (agentRunners.size === 0) {
    logger.info('无 task-driven agent，跳过 RouterService 初始化');
    return;
  }

  const dispatcher = new TaskDispatcher({
    runners: agentRunners,
    buckets: providerBuckets,
    getAgentAssignment: (instanceId) => getAssignmentInfo(instanceId),
    getGlobalMax: () => getGlobalMax(),
  });

  routerService = new RouterService({ runners: agentRunners, dispatcher });
  routerService.start();
  setRouterService(routerService);
  logger.info('RouterService 已启动', { runnerCount: agentRunners.size });
}

function getAssignmentInfo(instanceId: string): AgentAssignmentInfo | null {
  const row = getDb().prepare(
    `SELECT a.agent_definition_id, d.model_provider_id, d.max_concurrent_tasks
     FROM agent_assignments a
     JOIN agent_definitions d ON a.agent_definition_id = d.id
     WHERE a.instance_id = ?`,
  ).get(instanceId) as
    | { agent_definition_id: string; model_provider_id: string | null; max_concurrent_tasks: number }
    | undefined;
  if (!row?.model_provider_id) return null;
  return {
    agentDefinitionId: row.agent_definition_id,
    modelProviderId: row.model_provider_id,
    maxConcurrentTasks: row.max_concurrent_tasks,
  };
}

function getGlobalMax(): number {
  const row = getDb().prepare(
    'SELECT max_concurrent_tasks FROM global_settings WHERE id = 1',
  ).get() as { max_concurrent_tasks: number } | undefined;
  return row?.max_concurrent_tasks ?? 3;
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
});

app.on('before-quit', () => {
  for (const runner of agentRunners.values()) runner.destroy();
  for (const pool of agentWarmPools.values()) pool.destroyAll();
  agentRunners.clear();
  agentWarmPools.clear();
  setRouterService(null);
  routerService = null;

  stopTaskRuntime();
  void stopConduit();
  void stopSync();
});
