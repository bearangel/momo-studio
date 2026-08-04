// electron/src/main/agent/tools/index.ts
// 工具注册中心。Phase 1 仅占位；Phase 2 起逐步填充。

import type { LLMToolDef } from '../llm-provider';
import type { ToolContext, ToolModule } from './types';
import { UnknownToolError } from './types';

export function buildToolRegistry(_ctx: ToolContext): ToolModule[] {
  return [];
}

export function getAllToolDefs(modules: ToolModule[]): LLMToolDef[] {
  return modules.flatMap((m) => m.getDefs());
}

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
  modules: ToolModule[],
): Promise<string> {
  for (const m of modules) {
    if (m.handles(name)) return m.execute(name, args, ctx);
  }
  throw new UnknownToolError(name);
}
