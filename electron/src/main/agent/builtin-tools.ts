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
