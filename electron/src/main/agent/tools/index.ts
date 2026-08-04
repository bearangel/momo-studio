// electron/src/main/agent/tools/index.ts
// 工具注册中心。已接入 FileTools（8 个文件工具）+ SearchTools（grep / glob）+
//   ShellTools（bash，workspace 内自由 shell）+ GitTools（git 只读 4 工具）；
//   后续 phase 追加 WebTools / TodoTools / LspTools。
// 通用前置处理（权限 / 审计）仍在 runtime-entry 入口处，不在本注册中心做。

import type { LLMToolDef } from '../llm-provider';
import type { ToolContext, ToolModule } from './types';
import { UnknownToolError } from './types';
import { FileTools } from './file-tools';
import { SearchTools } from './search-tools';
import { ShellTools } from './shell-tools';
import { GitTools } from './git-tools';

export function buildToolRegistry(_ctx: ToolContext): ToolModule[] {
  return [new FileTools(), new SearchTools(), new ShellTools(), new GitTools()];
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
