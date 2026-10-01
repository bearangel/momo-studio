// electron/src/main/agent/tools/lsp-tools.ts
// 薄客户端（spec §8，Task 5 重写）：门控 = AGENT_CONFIG.lspLanguages 检测快照非空
// （主进程 spawn 时单点检测注入，子进程只消费——不做任何 fs 探测）；
// execute 经 lsp-ipc-bridge 往返主进程（语言由主进程按扩展名路由，真实
// LspManager 见 main/lsp/manager.ts）。旧内嵌 LspManager 已删除。
import fs from 'node:fs';
import type { LLMToolDef } from '../llm-provider';
import { buildCatalog, type ToolCatalogEntry, type ToolMeta } from './catalog-entry';
import type { ToolContext, ToolModule } from './types';
import { sendLspOp } from './lsp-ipc-bridge';

const DIAGNOSTICS_DEF: LLMToolDef = {
  name: 'lsp_diagnostics',
  description:
    '获取代码文件的诊断信息（编译错误/类型警告）。支持 16 门语言（按 workspace 自动检测激活，部分实验性），server 需已安装。',
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string', description: '相对 workspace 的源码文件路径' } },
    required: ['path'],
  },
};

const REFERENCES_DEF: LLMToolDef = {
  name: 'lsp_find_references',
  description:
    '查找某符号在 workspace 内的所有引用位置（含定义，语义级精度高于 grep）。支持 16 门语言（自动检测激活），server 需已安装。',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '相对 workspace 的源码文件路径' },
      line: { type: 'number', description: '1-based 行号' },
      character: { type: 'number', description: '0-based 列号' },
    },
    required: ['path', 'line', 'character'],
  },
};

const LSP_CATALOG_META: Record<string, ToolMeta> = {
  lsp_diagnostics: {
    category: '代码', categoryEmoji: '🔧', defaultOn: false,
    conditional: '按 workspace toolchain 自动检测激活（16 门语言，4 门实验性）；server 需已安装',
  },
  lsp_find_references: {
    category: '代码', categoryEmoji: '🔧', defaultOn: false,
    conditional: '按 workspace toolchain 自动检测激活（16 门语言，4 门实验性）；server 需已安装',
  },
};

export const LSP_CATALOG_ENTRIES: ToolCatalogEntry[] = buildCatalog(
  [DIAGNOSTICS_DEF, REFERENCES_DEF],
  LSP_CATALOG_META,
);

export class LspTools implements ToolModule {
  private constructor() {}

  /** 门控：检测快照非空（主进程 spawn 时注入；缺省 = 不注册，向后兼容） */
  static create(ctx: ToolContext): LspTools | null {
    if (ctx.lspLanguages === undefined || ctx.lspLanguages.length === 0) return null;
    return new LspTools();
  }

  getDefs(): LLMToolDef[] { return [DIAGNOSTICS_DEF, REFERENCES_DEF]; }
  getCatalog(): ToolCatalogEntry[] { return LSP_CATALOG_ENTRIES; }
  handles(name: string): boolean {
    return name === 'lsp_diagnostics' || name === 'lsp_find_references';
  }

  async execute(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    if (name === 'lsp_diagnostics') {
      const relPath = typeof args.path === 'string' ? args.path : '';
      const absPath = ctx.wsFs.assertInWorkspace(relPath);
      // 内容子进程自读随 op 携带（主进程不做文件 IO——只做路由与语言服务）
      const content = await fs.promises.readFile(absPath, 'utf-8');
      return sendLspOp({ kind: 'diagnostics', workspaceId: ctx.workspaceId, path: relPath, content });
    }
    if (name === 'lsp_find_references') {
      const relPath = typeof args.path === 'string' ? args.path : '';
      ctx.wsFs.assertInWorkspace(relPath);
      const line = typeof args.line === 'number' ? args.line : 1;
      const character = typeof args.character === 'number' ? args.character : 0;
      return sendLspOp({ kind: 'references', workspaceId: ctx.workspaceId, path: relPath, line, character });
    }
    throw new Error(`未知 lsp 工具: ${name}`);
  }
}
