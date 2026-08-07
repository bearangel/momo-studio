// electron/src/main/agent/tools/file-tools.ts
// 文件操作工具模块：read_file / write_file / list_files / edit_file /
//   mkdir / rm / mv / exists（v1.4 搬迁 + v1.5 Task 6 扩展）。
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

import fs from 'node:fs';
import type { WorkspaceFS } from '../../files/workspace-fs';
import type { LLMToolDef } from '../llm-provider';
import type { ToolContext, ToolModule } from './types';

/** 返回所有文件工具的声明（read_file / write_file / list_files / edit_file / mkdir / rm / mv / exists） */
export function getFileToolDefs(): LLMToolDef[] {
  return [
    {
      name: 'read_file',
      description: '读取 workspace 内的文件内容（UTF-8 文本）。大文件用 offset+limit 分页读取，避免一次性塞满 LLM 上下文。',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '相对 workspace 根目录的文件路径' },
          offset: {
            type: 'number',
            description: '起始行号（1-based，默认 1）。配合 limit 分页读大文件',
          },
          limit: {
            type: 'number',
            description: '本次返回最大行数（默认 2000）。文件超过此规模时尾部会提示"用 offset=N 继续读"',
          },
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
    {
      name: 'edit_file',
      description: '通过精确字符串匹配增量编辑文件。oldString 必须在文件中唯一出现，否则报错。',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '相对 workspace 根目录的文件路径' },
          oldString: { type: 'string', description: '要被替换的原文字符串（须精确匹配，含空白/缩进）' },
          newString: { type: 'string', description: '替换后的新字符串' },
        },
        required: ['path', 'oldString', 'newString'],
      },
    },
    {
      name: 'mkdir',
      description: '创建目录（递归创建父目录）',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    },
    {
      name: 'rm',
      description: '删除文件或目录（递归）',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    },
    {
      name: 'mv',
      description: '移动/重命名文件或目录',
      inputSchema: {
        type: 'object',
        properties: {
          src: { type: 'string', description: '源路径' },
          dst: { type: 'string', description: '目标路径' },
        },
        required: ['src', 'dst'],
      },
    },
    {
      name: 'exists',
      description: '检查路径是否存在',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
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
 * @param toolName 工具名（read_file / write_file / list_files / edit_file / mkdir / rm / mv / exists）
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
      // v1.5.6：分页参数（offset 1-based；limit 默认 2000，opencode 标准做法）
      const offset = typeof args.offset === 'number' && args.offset > 0
        ? Math.floor(args.offset)
        : 1;
      const limit = typeof args.limit === 'number' && args.limit > 0
        ? Math.floor(args.limit)
        : 2000;
      // 上限保护：单次最多 5000 行（防 LLM 误传巨大 limit 撑爆 LLM 上下文）
      const effectiveLimit = Math.min(limit, 5000);

      const content = await wsFs.readFile(filePath);
      const text = content.toString('utf-8');
      const allLines = text.split('\n');
      const totalLines = allLines.length;

      // 边界：offset 超出文件总行数
      if (offset > totalLines) {
        return `(空) 文件共 ${totalLines} 行，offset=${offset} 超出范围`;
      }

      const sliceEnd = Math.min(offset - 1 + effectiveLimit, totalLines);
      const pageLines = allLines.slice(offset - 1, sliceEnd);
      const parts: string[] = [pageLines.join('\n')];

      // 尾部提示：还有更多行 → 教 LLM 用 offset=sliceEnd+1 继续
      if (sliceEnd < totalLines) {
        parts.push(
          `\n\n...(共 ${totalLines} 行，已显示第 ${offset}-${sliceEnd} 行；用 offset=${sliceEnd + 1} 继续读取)`,
        );
      } else if (offset > 1) {
        // 已经读到末尾但本次是分页读取 → 提示这是末段
        parts.push(`\n\n（文件末尾，共 ${totalLines} 行）`);
      }
      return parts.join('');
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
    case 'edit_file': {
      const filePath = parseStringArg(args.path, 'path');
      const oldStr = parseStringArg(args.oldString, 'oldString');
      const newStr = parseStringArg(args.newString, 'newString');
      if (oldStr === newStr) throw new Error('oldString 与 newString 相同，无操作');

      const abs = wsFs.assertInWorkspace(filePath);
      if (!fs.existsSync(abs)) throw new Error(`文件不存在: ${filePath}`);

      const original = await fs.promises.readFile(abs, 'utf-8');
      const firstIdx = original.indexOf(oldStr);
      if (firstIdx === -1) {
        const preview = original.slice(0, 500);
        throw new Error(`oldString 未在文件中找到。文件开头 500 字符:\n${preview}`);
      }
      const lastIdx = original.lastIndexOf(oldStr);
      if (firstIdx !== lastIdx) {
        throw new Error(`oldString 在文件中出现多次（${original.split(oldStr).length - 1} 处），请提供更长上下文以唯一定位`);
      }

      const updated = original.slice(0, firstIdx) + newStr + original.slice(firstIdx + oldStr.length);
      await fs.promises.writeFile(abs, updated, 'utf-8');

      const beforeLines = original.slice(0, firstIdx).split('\n');
      const startLine = Math.max(0, beforeLines.length - 2);
      return `已编辑 ${filePath}（第 ${startLine + 1} 行附近）`;
    }
    case 'mkdir': {
      const dirPath = parseStringArg(args.path, 'path');
      await wsFs.createDir(dirPath);
      return `目录已创建: ${dirPath}`;
    }
    case 'rm': {
      const targetPath = parseStringArg(args.path, 'path');
      await wsFs.deletePath(targetPath);
      return `已删除: ${targetPath}`;
    }
    case 'mv': {
      const src = parseStringArg(args.src, 'src');
      const dst = parseStringArg(args.dst, 'dst');
      await wsFs.rename(src, dst);
      return `已移动: ${src} → ${dst}`;
    }
    case 'exists': {
      const checkPath = parseStringArg(args.path, 'path');
      return (await wsFs.exists(checkPath)) ? '存在' : '不存在';
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
    return ['read_file', 'write_file', 'list_files', 'edit_file', 'mkdir', 'rm', 'mv', 'exists'].includes(name);
  }

  async execute(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    return executeFileTool(name, args, ctx.wsFs);
  }
}
