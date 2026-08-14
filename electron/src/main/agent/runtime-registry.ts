// electron/src/main/agent/runtime-registry.ts
//
// task-driven runtime 全局注册中心——持有 agentRunners / agentWarmPools / providerBuckets
// 三个全局 Map，供 main/index.ts、IPC handlers、RouterService 共享访问。
//
// 从 main/index.ts 提取到独立模块的原因：
//   - IPC handler（agent:addToWorkspace / agent:start 等）需要读写 agentRunners/agentWarmPools
//   - RouterService 需要只读访问 runners Map（构造时传入引用，后续动态添加可见）
//   - 避免循环依赖（main/index.ts ↔ ipc.handlers.ts）
//
// 关键函数：
//   - startAgentRuntime(opts, taskDriven)：IPC handler 调用入口——taskDriven=true 走 WarmPool
//     预热（含按需创建），taskDriven=false 走 v1 spawnAgent fallback
//   - createTaskDrivenRuntime(opts)：为单个 assignment 创建 WarmPool + AgentRunner + 注册 + 预热
//   - findAssignmentByBotUserId(botUserId)：按 bot_matrix_user_id 反查 instance_id（dispatch 路由用）
//   - destroyAllTaskDrivenRuntimes()：进程退出时清理（before-quit 调用）

import { logger } from '../logger';
import { getDb } from '../storage/db';
import { spawnAgent, handleStreamChunk, type AgentRuntimeOpts } from './runtime-manager';
import { WarmPool } from './warm-pool';
import { AgentRunner } from './agent-runner';
import { spawnForAgent } from './runtime-spawner';
import { ProviderTokenBucket } from './llm/token-bucket';

// ─── 全局注册表 ───────────────────────────────────────────────────────────

/** assignmentId（instance_id）→ AgentRunner */
export const agentRunners = new Map<string, AgentRunner>();

/** assignmentId → WarmPool */
export const agentWarmPools = new Map<string, WarmPool>();

/** modelProviderId → ProviderTokenBucket（LLM 限流共享桶） */
export const providerBuckets = new Map<string, ProviderTokenBucket>();

// ─── 核心函数 ─────────────────────────────────────────────────────────────

/**
 * IPC handler 调用入口——根据 taskDriven 标志分流：
 *   - taskDriven=true：确保 WarmPool + AgentRunner 存在（不存在则创建），然后预热
 *   - taskDriven=false：走 v1 spawnAgent（长期运行子进程模式）
 *
 * 替代 IPC handler 中的直接 spawnAgent(opts) 调用。
 * opts 已由调用方通过 buildSpawnOpts 构造完毕。
 *
 * @param opts 已构建的 AgentRuntimeOpts（含 instanceId / botUserId / workspaceId 等）
 * @param taskDriven agent 定义是否 task_driven=1
 */
export async function startAgentRuntime(
  opts: AgentRuntimeOpts,
  taskDriven: boolean,
): Promise<void> {
  if (taskDriven) {
    await ensureTaskDrivenRuntime(opts);
  } else {
    // v1 fallback：直接 spawn 长期运行子进程
    spawnAgent(opts);
  }
}

/**
 * 确保指定 assignment 的 task-driven runtime 已就绪：
 *   1. WarmPool 不存在 → 创建（spawn 回调闭包捕获 opts）+ 注册
 *   2. AgentRunner 不存在 → 创建 + 注册
 *   3. 预热池（补到 poolSize）
 *
 * 幂等：已存在的 pool/runner 不会重建，仅触发 warm 补充。
 */
async function ensureTaskDrivenRuntime(opts: AgentRuntimeOpts): Promise<void> {
  const { instanceId, botUserId, workspaceId } = opts;

  if (!agentWarmPools.has(instanceId)) {
    const pool = new WarmPool({
      poolSize: 2,
      spawn: async (agentId) => {
        const runtime = await spawnForAgent({
          assignmentId: agentId,
          runtimeConfig: opts,
          onChunk: (chunk) => handleStreamChunk(chunk),
          onExit: (code) => {
            logger.info('task-driven runtime 退出', { agentId, code });
          },
        });
        return runtime.child;
      },
    });
    agentWarmPools.set(instanceId, pool);

    const runner = new AgentRunner({
      agentAssignmentId: instanceId,
      agentBotUserId: botUserId,
      workspaceId,
      warmPool: pool,
    });
    agentRunners.set(instanceId, runner);

    // v2 修复（final review C1）：与 stopAgentRuntime 对称——写 last_running=1。
    // 否则 stop（写 0）→ start 循环后 DB 仍为 0，renderer reload 看到 lastRunning=false，
    // UI 显示离线而 runner 实际在运行。v1 spawnAgent 路径内部已写 1，此处补 task-driven 路径。
    getDb()
      .prepare('UPDATE agent_assignments SET last_running = 1 WHERE instance_id = ?')
      .run(instanceId);

    logger.info('task-driven runtime 已创建', { instanceId, botUserId });

    // v2 修复：第一次 runner 注册时 lazy 启动 RouterService
    // （ensureRouterService 内部已 null 检查，幂等安全）。动态 import 避免顶层循环依赖
    // （router-bootstrap → sync-manager → 间接触达 runtime-registry）。
    try {
      const { ensureRouterService } = await import('./router-bootstrap');
      await ensureRouterService(agentRunners, providerBuckets);
    } catch (err) {
      logger.warn('ensureRouterService 失败（runner 已注册但 router 未启动）', {
        instanceId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const pool = agentWarmPools.get(instanceId)!;
  await pool.warm(instanceId).catch((err) => {
    logger.warn('WarmPool 预热失败', { instanceId, error: String(err) });
  });
}

/**
 * 为单个 assignment 创建 task-driven runtime——由 initTaskDrivenRuntime 在启动时遍历调用。
 * 与 ensureTaskDrivenRuntime 的区别：本函数不做幂等检查（调用方保证），
 * 且返回创建的 pool 供调用方记录日志。
 *
 * @returns 创建的 WarmPool；已存在时返回已有的
 */
export function createTaskDrivenRuntime(opts: AgentRuntimeOpts): WarmPool {
  const { instanceId, botUserId, workspaceId } = opts;

  const existing = agentWarmPools.get(instanceId);
  if (existing) return existing;

  const pool = new WarmPool({
    poolSize: 2,
    spawn: async (agentId) => {
      const runtime = await spawnForAgent({
        assignmentId: agentId,
        runtimeConfig: opts,
        onChunk: (chunk) => handleStreamChunk(chunk),
        onExit: (code) => {
          logger.info('task-driven runtime 退出', { agentId, code });
        },
      });
      return runtime.child;
    },
  });
  agentWarmPools.set(instanceId, pool);

  const runner = new AgentRunner({
    agentAssignmentId: instanceId,
    agentBotUserId: botUserId,
    workspaceId,
    warmPool: pool,
  });
  agentRunners.set(instanceId, runner);

  // v2 修复（final review C1）：与 ensureTaskDrivenRuntime 对称——写 last_running=1。
  // init 路径仅对 last_running=1 的 agent 调用，此处写入幂等；防御性保持双轨对称。
  getDb()
    .prepare('UPDATE agent_assignments SET last_running = 1 WHERE instance_id = ?')
    .run(instanceId);

  return pool;
}

/**
 * 按 bot_matrix_user_id 反查 assignment 的 instance_id。
 * 用于 RouterService.routeDispatch：dispatch event 的 dispatch_to 是目标 agent 的 botUserId，
 * 需反查 assignmentId 才能从 runners Map 取到对应 AgentRunner。
 *
 * @returns instance_id；未找到时返回 null
 */
export function findAssignmentByBotUserId(botUserId: string): string | null {
  const row = getDb()
    .prepare('SELECT instance_id FROM agent_assignments WHERE bot_matrix_user_id = ?')
    .get(botUserId) as { instance_id: string } | undefined;
  return row?.instance_id ?? null;
}

/**
 * 从 model_providers 表填充 providerBuckets（I1 修复）。
 * 只有 max_rpm 或 max_tpm 非空的 provider 才创建桶（NULL = 不限流，无需桶）。
 * 已存在的桶不覆盖（支持运行时动态新增 provider 后幂等调用）。
 */
export function populateProviderBuckets(): void {
  const rows = getDb()
    .prepare('SELECT id, max_rpm, max_tpm FROM model_providers')
    .all() as Array<{ id: string; max_rpm: number | null; max_tpm: number | null }>;

  for (const row of rows) {
    if (row.max_rpm === null && row.max_tpm === null) continue;
    if (providerBuckets.has(row.id)) continue;
    providerBuckets.set(
      row.id,
      new ProviderTokenBucket({
        ...(row.max_rpm !== null ? { maxRpm: row.max_rpm } : {}),
        ...(row.max_tpm !== null ? { maxTpm: row.max_tpm } : {}),
      }),
    );
  }
}

/**
 * 销毁所有 task-driven runtime——进程退出（before-quit）时调用。
 * 反注册全部 runner + 销毁全部 pool + 清空 Map。
 */
export function destroyAllTaskDrivenRuntimes(): void {
  for (const runner of agentRunners.values()) runner.destroy();
  for (const pool of agentWarmPools.values()) pool.destroyAll();
  agentRunners.clear();
  agentWarmPools.clear();
}

/**
 * 销毁单个 task-driven runtime（runner + WarmPool），从全局 Map 移除。
 * - runner.destroy() 反注册 handler + release 活跃 runtime
 * - pool.destroyAll() kill 池中所有 warm 子进程
 * - 从 agentRunners + agentWarmPools Map 移除
 *
 * 不存在 instanceId 时 no-op（用于 stopAgentRuntime 兼容 v1-only agent）。
 */
export function destroyTaskDrivenRuntime(instanceId: string): void {
  const runner = agentRunners.get(instanceId);
  if (runner) {
    runner.destroy();
    agentRunners.delete(instanceId);
  }
  const pool = agentWarmPools.get(instanceId);
  if (pool) {
    pool.destroyAll();
    agentWarmPools.delete(instanceId);
  }
}

/**
 * 统一的 agent 停止入口（v2 修复）。
 * 双轨销毁：v1 子进程（如有）+ v2 task-driven runtime（如有）+ DB last_running=0。
 *
 * 设计：v1 路径调用 runtime-manager.stopAgent（已 UPDATE last_running=0）；
 * v2 路径调用 destroyTaskDrivenRuntime。两者幂等，重复 UPDATE 不冲突。
 *
 * @param instanceId agent_assignment 主键
 */
export async function stopAgentRuntime(instanceId: string): Promise<void> {
  // 1. v1 子进程（如有）—— stopAgent 内部已 UPDATE last_running=0
  const { stopAgent } = await import('./runtime-manager');
  stopAgent(instanceId);
  // 2. v2 task-driven runtime（如有）
  destroyTaskDrivenRuntime(instanceId);
  // 3. 幂等再写一次（v1 stopAgent 已做；本行确保 v2-only 路径也覆盖）
  getDb()
    .prepare('UPDATE agent_assignments SET last_running = 0 WHERE instance_id = ?')
    .run(instanceId);
  logger.info('stopAgentRuntime 完成（双轨销毁 + DB 同步）', { instanceId });
}

// ─── 测试辅助 ─────────────────────────────────────────────────────────────

/** 测试用：清空全部全局 Map（避免跨用例污染） */
export function __clearRuntimeRegistryForTest(): void {
  agentRunners.clear();
  agentWarmPools.clear();
  providerBuckets.clear();
}
