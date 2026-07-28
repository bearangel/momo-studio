// electron/src/main/agent/builtin-tools.ts
//
// 把 WorkspaceFS 包装成 LLM 可调用的工具定义 + 执行器。供 runtime-entry 的
// chat loop 使用：getBuiltinToolDefs() 返回 JSON Schema 风格的工具声明（喂给
// LLM），executeBuiltinTool() 执行单个工具调用并把结果序列化为字符串（作为
// tool result 回传给 LLM）。
//
// 设计要点：
//   - 工具的路径参数都是相对 workspace 根目录；实际沙箱校验由 WorkspaceFS
//     .assertInWorkspace() 完成（含路径穿越 / 符号链接逃逸 / .git 保护）。
//   - 执行失败时抛错，由调用方（chat loop）捕获并转成 tool result 文本回传
//     给 LLM，使 LLM 能看到错误并自我纠正，而不是中断整轮对话。

import type { WorkspaceFS } from '../files/workspace-fs';
import type { LLMToolDef } from './llm-provider';
import { SkillRegistry } from '../skill/registry';

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

/** 返回所有内置工具的声明（read_file / write_file / list_files） */
export function getBuiltinToolDefs(): LLMToolDef[] {
  return [
    {
      name: 'read_file',
      description: '读取 workspace 内的文件内容（UTF-8 文本）',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '相对 workspace 根目录的文件路径' },
        },
        required: ['path'],
      },
    },
    {
      name: 'write_file',
      description: '写入文件到 workspace（覆盖已有内容，父目录自动创建）',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '相对 workspace 根目录的文件路径' },
          content: { type: 'string', description: '要写入的文件内容' },
        },
        required: ['path', 'content'],
      },
    },
    {
      name: 'list_files',
      description: '列出指定目录下的文件和子目录（默认列 workspace 根目录）',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '相对 workspace 根目录的目录路径（默认 "."）' },
        },
      },
    },
  ];
}

/**
 * 执行一个内置工具调用。
 *
 * @param toolName 工具名（read_file / write_file / list_files）
 * @param args LLM 返回的已解析参数对象
 * @param wsFs workspace 文件系统实例（提供路径沙箱）
 * @returns 工具执行结果，序列化为字符串（回传给 LLM 作为 tool result）
 * @throws 路径越界 / IO 失败 / 未知工具时抛错，由调用方转成 tool result 文本
 */
export async function executeBuiltinTool(
  toolName: string,
  args: Record<string, unknown>,
  wsFs: WorkspaceFS,
): Promise<string> {
  switch (toolName) {
    case 'read_file': {
      const filePath = parseStringArg(args.path, 'path');
      const content = await wsFs.readFile(filePath);
      return content.toString('utf-8');
    }
    case 'write_file': {
      const filePath = parseStringArg(args.path, 'path');
      const content = parseStringArg(args.content, 'content');
      await wsFs.writeFile(filePath, content);
      return `文件已写入: ${filePath}`;
    }
    case 'list_files': {
      const dirPath = typeof args.path === 'string' ? args.path : '.';
      const entries = await wsFs.listDir(dirPath);
      if (entries.length === 0) return '(空目录)';
      return entries
        .map((e) => `${e.isDirectory ? '📁' : '📄'} ${e.name}${e.isDirectory ? '/' : ''}`)
        .join('\n');
    }
    default:
      throw new Error(`未知工具: ${toolName}`);
  }
}

/** 从 args 中取出一个 string 字段，缺失或类型不符时抛错（给 LLM 明确反馈） */
function parseStringArg(value: unknown, name: string): string {
  if (typeof value !== 'string') {
    throw new Error(`参数 "${name}" 缺失或不是字符串`);
  }
  return value;
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
