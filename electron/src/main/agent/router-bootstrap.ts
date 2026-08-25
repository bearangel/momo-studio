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
//   - agentRunners 通过参数传入
//   - 由调用方（ensureTaskDrivenRuntime / initTaskDrivenRuntime）动态 import 本模块
//
// v2.0.1（spec §9 范围裁定）：TaskDispatcher 的 pickup 链路已砍除（留 2.1）。
// RouterService 的三条现役路由（routeUserChat / routeDispatch / routeTaskReply）
// 均直接派发 runner，不经过 dispatcher——本模块不再构造 TaskDispatcher，
// 也不再把 providerBuckets 传入（buckets 只为 dispatcher 的限流检查存在）。

import { RouterService } from './router-service';
import { setBridgeRouter } from './internal-event-bridge';
import { setSessionRouter } from '../im/session-service';
import { logger } from '../logger';
import type { AgentRunner } from './agent-runner';

/** 模块级单例（lazy 启动后非空） */
let currentRouterService: RouterService | null = null;

/**
 * 幂等 lazy 启动 RouterService。
 *
 * - 已启动（currentRouterService 非 null）→ no-op
 * - runners.size === 0 → no-op（防御性，正常路径不触发）
 * - 首次调用 → 创建 RouterService + setBridgeRouter
 *
 * v2（P1 Task 5）：RouterService 注入方式改为内部事件桥（setBridgeRouter）——
 * runtime 子进程的 dispatch/task_reply 经 child IPC 直达 routeEvent，
 * 不再绕道 Matrix /sync。sync-manager 的 setRouterService 导出保留
 * （阶段三 Task 12 删除），router-bootstrap 不再调用它。
 *
 * @param runners agentRunners Map 引用（后续新增 runner 自动可见，因 RouterService 持有 Map 引用）
 */
export async function ensureRouterService(
  runners: Map<string, AgentRunner>,
): Promise<void> {
  if (currentRouterService) return;  // 已启动
  if (runners.size === 0) return;    // 无 runner，不需要

  currentRouterService = new RouterService({ runners });
  currentRouterService.start();
  setBridgeRouter(currentRouterService);
  setSessionRouter(currentRouterService);
  logger.info('RouterService lazy 启动', { runnerCount: runners.size });
}

/**
 * 销毁 RouterService（before-quit 时调用）。
 * 反向清理：setBridgeRouter(null) + 释放模块引用。
 * 已 null 时 no-op。
 */
export function destroyRouterService(): void {
  if (!currentRouterService) return;
  setBridgeRouter(null);
  setSessionRouter(null);
  currentRouterService = null;
  logger.info('RouterService 已销毁');
}

/** 测试用：重置模块状态（清 currentRouterService，不调 bridge） */
export function __resetRouterServiceForTest(): void {
  currentRouterService = null;
}
