// electron/src/main/agent/tools/file-tools.ts
// 文件操作工具模块：read_file / write_file / list_files（v1.4 搬迁）。
// Task 6 会在此模块加 edit_file / mkdir / rm / mv / exists。
//
// 设计要点：
//   - 工具的路径参数都是相对 workspace 根目录；实际沙箱校验由 WorkspaceFS
//     .assertInWorkspace() 完成（含路径穿越 / 符号链接逃逸 / .git 保护）。
//   - 执行失败时抛错，由调用方（tool registry 的 execute 路由）捕获并转成
//     tool result 文本回传给 LLM，使 LLM 能看到错误并自我纠正，而不是中断
//     整轮对话。
//   - 本模块实现 ToolModule 接口（getDefs/handles/execute），是 v1.5 工具库
//     注册中心的首批 module；Task 5 把它接入 registry 后会替换 runtime-entry
//     对此模块的直接调用。

import type { WorkspaceFS } from '../../files/workspace-fs';
import type { LLMToolDef } from '../llm-provider';
import type { ToolContext, ToolModule } from './types';

/** 返回所有文件工具的声明（read_file / write_file / list_files） */
export function getFileToolDefs(): LLMToolDef[] {
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
 * 从 args 中取出一个 string 字段，缺失或类型不符时抛错（给 LLM 明确反馈）。
 * 模块内私有辅助函数——execute 路由需要更精确的报错而不只是「未知工具」。
 */
function parseStringArg(value: unknown, name: string): string {
  if (typeof value !== 'string') {
    throw new Error(`参数 "${name}" 缺失或不是字符串`);
  }
  return value;
}

/**
 * 执行一个文件工具调用。
 *
 * @param toolName 工具名（read_file / write_file / list_files）
 * @param args LLM 返回的已解析参数对象
 * @param wsFs workspace 文件系统实例（提供路径沙箱）
 * @returns 工具执行结果，序列化为字符串（回传给 LLM 作为 tool result）
 * @throws 路径越界 / IO 失败 / 未知工具时抛错，由调用方转成 tool result 文本
 */
export async function executeFileTool(
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

/**
 * 文件工具模块——v1.5 ToolModule 接口实现。
 * Task 5 会通过 tools/index.ts 的 buildToolRegistry() 注册到注册中心；
 * 注册中心路由 execute 时把 ToolContext 注入，此处只需取 wsFs。
 */
export class FileTools implements ToolModule {
  getDefs(): LLMToolDef[] {
    return getFileToolDefs();
  }

  handles(name: string): boolean {
    return name === 'read_file' || name === 'write_file' || name === 'list_files';
  }

  async execute(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    return executeFileTool(name, args, ctx.wsFs);
  }
}
