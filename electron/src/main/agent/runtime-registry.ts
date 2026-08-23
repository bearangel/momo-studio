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
//   - startAgentRuntime(opts)：IPC handler 调用入口——确保 WarmPool + AgentRunner 存在并预热
//     （Task 13 起 v1 spawnAgent 双轨分支已删除，全部 agent 走 task-driven）
//   - createTaskDrivenRuntime(opts)：为单个 assignment 创建 WarmPool + AgentRunner + 注册
//   - stopAgentRuntime(instanceId)：统一停止入口（销毁 runner/pool + DB last_running=0）
//   - destroyAllTaskDrivenRuntimes()：进程退出时清理（before-quit 调用）
//
// v2（Task 10）：dispatch_to/reply_to 值已是 assignmentId，RouterService 直接以 runners
// key 定位——findAssignmentByAgentUserId 反查已删除。

import { logger } from '../logger';
import { getDb } from '../storage/db';
import type { AgentRuntimeOpts } from './runtime-config';
// Task 6：chunk 中继（handleStreamChunk）由 stream-relay 承载
import { handleStreamChunk, setAbortResolver } from './stream-relay';
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

// Task 6：注册按 streamSessionId 中断的解析器（注册反转，避免 stream-relay ↔ 本模块循环依赖）。
// 广播语义：遍历全部 runner 逐个调 abortStream，各 runner 内部按自身活跃表自然过滤——
// 只有持有该 streamSessionId 的 runner 会真正下发 abort IPC。
setAbortResolver((streamSessionId) => {
  for (const runner of agentRunners.values()) {
    runner.abortStream(streamSessionId);
  }
  return agentRunners.size > 0;
});

// ─── 核心函数 ─────────────────────────────────────────────────────────────

/**
 * IPC handler 调用入口——确保指定 assignment 的 task-driven runtime 就绪
 * （WarmPool + AgentRunner 不存在则创建），然后预热。
 *
 * 替代 IPC handler 中的直接 spawn 调用。
 * opts 已由调用方通过 buildSpawnOpts 构造完毕。
 *
 * @param opts 已构建的 AgentRuntimeOpts（含 instanceId / agentUserId / workspaceId 等）
 */
export async function startAgentRuntime(opts: AgentRuntimeOpts): Promise<void> {
  await ensureTaskDrivenRuntime(opts);
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
  const { instanceId, agentUserId, workspaceId } = opts;

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
      agentUserId,
      workspaceId,
      warmPool: pool,
    });
    agentRunners.set(instanceId, runner);

    // 与 stopAgentRuntime 对称——写 last_running=1。否则 stop（写 0）→ start
    // 循环后 DB 仍为 0，renderer reload 看到 lastRunning=false，UI 显示离线
    // 而 runner 实际在运行。
    getDb()
      .prepare('UPDATE agent_assignments SET last_running = 1 WHERE instance_id = ?')
      .run(instanceId);

    logger.info('task-driven runtime 已创建', { instanceId, agentUserId });

    // v2 修复（final review M1）：补齐 init/lazy 路径不对称——lazy 路径也要
    // populate buckets，否则 dispatcher 对缺失 bucket 不限流放行（潜伏点）。
    // 幂等：重复调用安全（Map 覆盖写）。
    populateProviderBuckets();

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
  const { instanceId, agentUserId, workspaceId } = opts;

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
    agentUserId,
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
 * 不存在 instanceId 时 no-op。
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
 * 统一的 agent 停止入口。
 * 销毁 task-driven runtime（runner + WarmPool）+ 写 DB last_running=0。
 *
 * @param instanceId agent_assignment 主键
 */
export async function stopAgentRuntime(instanceId: string): Promise<void> {
  destroyTaskDrivenRuntime(instanceId);
  getDb()
    .prepare('UPDATE agent_assignments SET last_running = 0 WHERE instance_id = ?')
    .run(instanceId);
  logger.info('stopAgentRuntime 完成（销毁 runtime + DB 同步）', { instanceId });
}

// ─── 测试辅助 ─────────────────────────────────────────────────────────────

/** 测试用：清空全部全局 Map（避免跨用例污染） */
export function __clearRuntimeRegistryForTest(): void {
  agentRunners.clear();
  agentWarmPools.clear();
  providerBuckets.clear();
}
