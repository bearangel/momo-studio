// electron/src/main/agent/builtin-tools.ts
//
// 残余的 LLM 工具声明工具——非真正的「工具调用」，只是给 LLM 看的能力占位。
// 真正的工具实现（read_file / write_file / list_files）已在 v1.5 Task 4 拆分到
// tools/file-tools.ts，本文件只保留与 runtime 元数据强耦合的两类工具声明：
//
//   - getVirtualToolDefs：渐进式披露的 loadSkill / readResource 虚拟工具。
//     执行由 runtime-entry 内联处理（不经过 ToolModule 路由）。
//   - getDispatchToolDefs：主 agent 给每个 sub agent 注册 dispatch:<slug> 工具。
//     执行也由 runtime-entry 内联处理（发 dispatch 消息 → 等 task_reply）。
//
// 兼容说明：v1.4 直接 import getBuiltinToolDefs/executeBuiltinTool 的 runtime-entry
// 暂时通过下面的 re-export shim 继续工作；Task 5 会把它切换到
// tools/index.ts 的注册中心，并移除这些 shim。

import type { LLMToolDef } from './llm-provider';
import { SkillRegistry } from '../skill/registry';
import {
  getFileToolDefs,
  executeFileTool,
} from './tools/file-tools';

// 兼容性 re-export——runtime-entry.ts 还在 import 老名字，Task 5 切换后删除。
export { getFileToolDefs as getBuiltinToolDefs, executeFileTool as executeBuiltinTool };

/**
 * 子 agent 引用（仅主 agent 的 config 携带）。
 * 主 agent 据此为每个归属的 sub agent 构建一个 `dispatch:<slug>` 工具。
 */
export interface SubAgentRef {
  slug: string;
  /** 子 agent bot 的 Matrix user id（dispatch 消息的 dispatch_to 字段） */
  botUserId: string;
  description: string;
}

/**
 * 已安装 skill 引用（runtime config 携带）。
 * 子进程启动时据此把各 skill 注册到 SkillRegistry（渐进式披露的三层都需要）。
 */
export interface RuntimeSkillRef {
  /** skill slug（SkillRegistry 的 key，loadSkill 工具入参） */
  slug: string;
  /** skill 包在磁盘上的绝对路径（须含 SKILL.md） */
  cachePath: string;
}

/**
 * 渐进式披露虚拟工具定义（loadSkill / readResource）。
 * 仅当 registry 已注册至少一个 skill 时返回，避免向 LLM 暴露必然失败的虚拟工具。
 *
 * 这两个工具的「执行」没有真正的副作用——loadSkill 返回 SKILL.md 正文（Layer 2），
 * readResource 返回资源文件文本（Layer 3）——具体执行在 runtime-entry 的 executeTool 路由。
 */
export function getVirtualToolDefs(skillRegistry: SkillRegistry): LLMToolDef[] {
  if (skillRegistry.list().length === 0) return [];
  return [
    {
      name: 'loadSkill',
      description: '加载指定技能的完整指令到上下文。当任务匹配某技能描述时调用。',
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string', description: '技能名（slug）' } },
        required: ['name'],
      },
    },
    {
      name: 'readResource',
      description: '读取技能引用的附加资源文件。',
      inputSchema: {
        type: 'object',
        properties: {
          skill: { type: 'string', description: '技能名（slug）' },
          path: { type: 'string', description: '资源文件相对技能目录的路径' },
        },
        required: ['skill', 'path'],
      },
    },
  ];
}

/**
 * 为主 agent 构建 dispatch:<slug> 工具定义——每个归属的 sub agent 一个。
 * 仅主 agent 调用。执行时构建 dispatch 消息发到 team room 并等待 task_reply。
 */
export function getDispatchToolDefs(subAgents: SubAgentRef[]): LLMToolDef[] {
  return subAgents.map((sub) => ({
    name: `dispatch:${sub.slug}`,
    description: sub.description || `调度子 agent: ${sub.slug}`,
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: '分配给该子 agent 的任务描述' },
      },
      required: ['task'],
    },
  }));
}
