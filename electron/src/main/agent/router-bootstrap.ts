// electron/src/main/agent/router-bootstrap.ts
//
// RouterService lazy 启动器——v2 修复：从启动时单例改为 lazy 单例。
//
// 问题背景：原 initTaskDrivenRuntime 是唯一创建 RouterService 的位置，
// app 启动时若无 runner（用户主动 stop 过所有 agent / 新用户首次启动），
// RouterService 永远 null，sync-manager.ts 的 if(routerService) 整段
// 跳过 → 所有 m.room.message 静默丢弃 → agent 不回复任何消息。
//
// 解决：抽取 ensureRouterService() 幂等 lazy init。第一次 runner 注册时
// （由 ensureTaskDrivenRuntime 末尾调用）启动 RouterService；后续调用 no-op。
//
// 与 runtime-registry / init-runtime 的依赖：
//   - 不直接 import runtime-registry（避免循环）
//   - agentRunners + providerBuckets 通过参数传入
//   - 由调用方（ensureTaskDrivenRuntime / initTaskDrivenRuntime）动态 import 本模块

import { RouterService } from './router-service';
import { TaskDispatcher, type AgentAssignmentInfo } from '../task/dispatcher';
import { setRouterService } from '../matrix/sync-manager';
import { getDb } from '../storage/db';
import { logger } from '../logger';
import type { AgentRunner } from './agent-runner';
import type { ProviderTokenBucket } from './llm/token-bucket';

/** 模块级单例（lazy 启动后非空） */
let currentRouterService: RouterService | null = null;

/**
 * 幂等 lazy 启动 RouterService。
 *
 * - 已启动（currentRouterService 非 null）→ no-op
 * - runners.size === 0 → no-op（防御性，正常路径不触发）
 * - 首次调用 → 创建 TaskDispatcher + 创建 RouterService + setRouterService
 *
 * @param runners agentRunners Map 引用（后续新增 runner 自动可见，因 RouterService 持有 Map 引用）
 * @param buckets providerBuckets Map 引用（dispatcher 用于 LLM 限流）
 */
export async function ensureRouterService(
  runners: Map<string, AgentRunner>,
  buckets: Map<string, ProviderTokenBucket>,
): Promise<void> {
  if (currentRouterService) return;  // 已启动
  if (runners.size === 0) return;    // 无 runner，不需要

  const dispatcher = new TaskDispatcher({
    runners,
    buckets,
    getAgentAssignment: (instanceId) => getAssignmentInfo(instanceId),
    getGlobalMax: () => getGlobalMax(),
  });

  currentRouterService = new RouterService({ runners, dispatcher });
  currentRouterService.start();
  setRouterService(currentRouterService);
  logger.info('RouterService lazy 启动', { runnerCount: runners.size });
}

/**
 * 销毁 RouterService（before-quit 时调用）。
 * 反向清理：setRouterService(null) + 释放模块引用。
 * 已 null 时 no-op。
 */
export function destroyRouterService(): void {
  if (!currentRouterService) return;
  setRouterService(null);
  currentRouterService = null;
  logger.info('RouterService 已销毁');
}

/** 测试用：重置模块状态（清 currentRouterService，不调 sync-manager） */
export function __resetRouterServiceForTest(): void {
  currentRouterService = null;
}

// ─── helpers（从 init-runtime.ts 迁移，供 dispatcher 使用） ────────────────

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