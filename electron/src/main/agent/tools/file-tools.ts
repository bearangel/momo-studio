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
import type { LLMToolDef } from '../llm-provider';
import type { ToolContext, ToolModule } from './types';
import { parseStringArg } from './shared/arg-parse';
import { formatEditError } from './shared/edit-recovery';
import {
  buildRecordCtx,
  toJournalRelPath,
  recordChangeSafe,
  recordDeleteTreeSafe,
  recordRenameTreeSafe,
} from './shared/change-journal';

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
 * 执行一个文件工具调用。
 *
 * @param toolName 工具名（read_file / write_file / list_files / edit_file / mkdir / rm / mv / exists）
 * @param args LLM 返回的已解析参数对象
 * @param ctx 工具执行上下文（v2.3 起接 ctx 而非 wsFs：Read-before-Edit 守门需要
 *   ctx.readTracker 与 ctx.streamSessionId / ctx.parentStreamSessionId）
 * @returns 工具执行结果，序列化为字符串（回传给 LLM 作为 tool result）
 * @throws 路径越界 / IO 失败 / 未知工具 / Read-before-Edit 守门未读时抛错，由调用方转成 tool result 文本
 */
export async function executeFileTool(
  toolName: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<string> {
  const wsFs = ctx.wsFs;
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
      // v2.3 Read-before-Edit：read 成功即标记已读（后续 edit_file / write_file 守门依据）。
      // 键用 assertInWorkspace 归一化的绝对路径——'./a.ts' 与 'a.ts' 等价（review M4）
      ctx.readTracker?.add(ctx.streamSessionId, wsFs.assertInWorkspace(filePath));
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
      const abs = wsFs.assertInWorkspace(filePath);
      const existed = fs.existsSync(abs);
      // v2.3 Read-before-Edit：仅对已存在文件（覆盖场景）生效；新文件豁免。
      // 键用 abs（归一化绝对路径，review M4）——与 read_file 的标记键一致
      if (existed) {
        ctx.readTracker?.assertRead(ctx.streamSessionId, ctx.parentStreamSessionId, abs);
      }
      // v2.5 变更账本：写前记账（write-ahead）——覆盖场景取旧内容为 before；
      // 记账失败不阻塞工具执行（Safe 包装内部降级）
      const before = existed ? await fs.promises.readFile(abs, 'utf-8') : null;
      recordChangeSafe(
        buildRecordCtx('write_file', ctx),
        toJournalRelPath(ctx, filePath),
        existed ? 'modify' : 'create',
        before,
        content,
      );
      await wsFs.writeFile(filePath, content);
      // 写入成功后标记已读（让后续 edit_file 通过守门）
      ctx.readTracker?.add(ctx.streamSessionId, abs);
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

      // v2.3 Read-before-Edit：强阻塞守门。键用 abs（归一化绝对路径，review M4）
      ctx.readTracker?.assertRead(ctx.streamSessionId, ctx.parentStreamSessionId, abs);

      const original = await fs.promises.readFile(abs, 'utf-8');
      const firstIdx = original.indexOf(oldStr);
      if (firstIdx === -1) {
        // v2.3 失败信息增强：formatEditError 含原文 5KB 快照 + 首次不一致行号 + read_file 建议
        throw formatEditError('not_found', filePath, oldStr, original);
      }
      const lastIdx = original.lastIndexOf(oldStr);
      if (firstIdx !== lastIdx) {
        const count = original.split(oldStr).length - 1;
        throw formatEditError('not_unique', filePath, oldStr, original, count);
      }

      const updated = original.slice(0, firstIdx) + newStr + original.slice(lastIdx + oldStr.length);
      // v2.5 变更账本：全部校验通过后、写盘前记账（校验失败不产生孤儿条目；
      // 写盘失败的孤儿由 revert 的 no-op 守卫兜底）
      recordChangeSafe(
        buildRecordCtx('edit_file', ctx),
        toJournalRelPath(ctx, filePath),
        'modify',
        original,
        updated,
      );
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
      // v2.5 变更账本：删除前记账（删后内容不可再读，写前记账是唯一时机）。
      // recordDeleteTree 自辨单文件/目录（单文件 1 条、目录逐文件 delete）；
      // 目标不存在时 walker 短路返回空——实际删除仍由 deletePath 原样抛错
      recordDeleteTreeSafe(
        buildRecordCtx('rm', ctx),
        ctx.workspaceDir,
        toJournalRelPath(ctx, targetPath),
      );
      await wsFs.deletePath(targetPath);
      return `已删除: ${targetPath}`;
    }
    case 'mv': {
      const src = parseStringArg(args.src, 'src');
      const dst = parseStringArg(args.dst, 'dst');
      // v2.5 变更账本：移动前记账。rename(2) 语义：目标文件已存在时被静默覆盖
      // ——先为被覆盖目标叠一条 modify（before=目标旧内容, after=源内容）再记
      // rename 本体；撤销逆序（created_at DESC）先逆 rename（目标移回源）再逆
      // modify（重建目标旧内容），端态双文件均正确。目录移动逐文件记 rename
      const rc = buildRecordCtx('mv', ctx);
      const srcAbs = wsFs.assertInWorkspace(src);
      const dstAbs = wsFs.assertInWorkspace(dst);
      const srcRel = toJournalRelPath(ctx, src);
      const dstRel = toJournalRelPath(ctx, dst);
      if (!fs.existsSync(srcAbs)) {
        // 源不存在：不记账，由 wsFs.rename 原样抛 ENOENT（既有行为不变）
      } else if (fs.statSync(srcAbs).isDirectory()) {
        recordRenameTreeSafe(rc, ctx.workspaceDir, srcRel, dstRel);
      } else {
        const srcContent = await fs.promises.readFile(srcAbs, 'utf-8');
        if (fs.existsSync(dstAbs) && !fs.statSync(dstAbs).isDirectory()) {
          const dstOld = await fs.promises.readFile(dstAbs, 'utf-8');
          recordChangeSafe(rc, dstRel, 'modify', dstOld, srcContent);
        }
        recordChangeSafe(rc, dstRel, 'rename', srcContent, null, srcRel);
      }
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
 * v2.3 起直接透传 ctx（Read-before-Edit 守门依赖 ctx.readTracker）。
 */
export class FileTools implements ToolModule {
  getDefs(): LLMToolDef[] {
    return getFileToolDefs();
  }

  handles(name: string): boolean {
    return ['read_file', 'write_file', 'list_files', 'edit_file', 'mkdir', 'rm', 'mv', 'exists'].includes(name);
  }

  async execute(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    return executeFileTool(name, args, ctx);
  }
}
