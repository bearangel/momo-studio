// electron/src/main/agent/tools/index.ts
// 工具注册中心。Phase 1 接入 FileTools（read_file / write_file / list_files）；
//   Phase 2 起追加 SearchTools / ShellTools / GitTools / WebTools / TodoTools / LspTools。
// 通用前置处理（权限 / 审计）仍在 runtime-entry 入口处，不在本注册中心做。

import type { LLMToolDef } from '../llm-provider';
import type { ToolContext, ToolModule } from './types';
import { UnknownToolError } from './types';
import { FileTools } from './file-tools';

export function buildToolRegistry(_ctx: ToolContext): ToolModule[] {
  return [new FileTools()];
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
