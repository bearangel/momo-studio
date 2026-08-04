// electron/src/main/agent/tools/types.ts
// 工具模块统一接口 + 共享上下文。每个工具模块实现 ToolModule，
// 由 tools/index.ts 聚合并路由。

import type { WorkspaceFS } from '../../files/workspace-fs';
import type { SkillRegistry } from '../../skill/registry';
import type { LLMToolDef } from '../llm-provider';
import type { StreamChunk } from '../stream-chunk';
import type { ToolPermissionConfig } from './shared/permission';

/** 工具执行时的共享上下文。runtime-entry 在每次工具调用前组装并传入。 */
export interface ToolContext {
  wsFs: WorkspaceFS;
  workspaceId: string;
  workspaceDir: string;
  skillRegistry: SkillRegistry;
  streamSessionId: string;
  parentStreamSessionId?: string;
  roomId: string;
  sendStreamChunk: (chunk: StreamChunk) => void;
  permissionConfig: ToolPermissionConfig;
  /**
   * v1.5.1：当前 chat loop 的 abortSignal。
   * 长任务工具（bash/webfetch）应监听此 signal，被中断时立即清理（SIGKILL 子进程 / abort fetch）
   * 并 resolve "已中断"，否则会等到自身 timeout 才返回，期间用户停止按钮无效。
   */
  abortSignal?: AbortSignal;
}

/** 工具模块统一接口。每个类别一个实现。 */
export interface ToolModule {
  getDefs(): LLMToolDef[];
  handles(name: string): boolean;
  execute(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<string>;
}

export class UnknownToolError extends Error {
  constructor(name: string) {
    super(`未知工具: ${name}`);
    this.name = 'UnknownToolError';
  }
}
