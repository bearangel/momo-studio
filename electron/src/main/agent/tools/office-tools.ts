// electron/src/main/agent/tools/office-tools.ts
// 办公文档工具组（spec 2026-11-03 §6）：只读三件——四格式读取 + 表格精读 + 复制。
// 生成类（create_ppt/create_excel/write_excel/create_doc/create_pdf/fill_ppt_template）
// 已下线，能力由 office-pro 插件（run_js 代码工坊）承接；写路径统一模式与记账
// 随之下迁插件侧（声明式 outputs 记账）。
// 读路径：沙箱断言 → 读取（预算截断）→ 标记已读。

import fs from 'node:fs';
import type { LLMToolDef } from '../llm-provider';
import type { ToolContext, ToolModule } from './types';
import { buildCatalog, type ToolCatalogEntry, type ToolMeta } from './catalog-entry';
import { parseStringArg } from './shared/arg-parse';
import { OUTPUT_LIMITS, truncateString } from './shared/output-truncate';
import { buildRecordCtx, recordChangeSafe, toJournalRelPath } from './shared/change-journal';
import { assertNotCipher, readJournalSnapshot } from './shared/cipher-gate';
import { assertOfficeFormat, type OfficeFormat } from './office/format';
import { readXlsxCells, readXlsxPreview } from './office/excel';
import { readDocx } from './office/docx';
import { readPptx } from './office/pptx';
import { readPdf } from './office/pdf';

/** 各格式读取器注册表：入参为**通道读到的字节**（B 方案收口：office-tools
 *  统一经 wsFs 读取 + 密文安全闸后传入，reader 不再裸触 fs）；signal 沿
 *  ctx.abortSignal 透传，helper 循环点自决 throw '已中断'（spec §7） */
const READERS: Partial<Record<OfficeFormat, (data: Buffer, signal?: AbortSignal) => Promise<string>>> = {
  xlsx: readXlsxPreview,
  docx: readDocx,
  pptx: readPptx,
  pdf: readPdf,
};

/** Read-before-Edit 包装：office 场景补充 office_read 指纹。
 *  current（B 方案收口）：调用方已持有的通道读字节——与 ReadTracker.add
 *  的 content 参数同源口径；省略时 tracker 自行磁盘回读。 */
function assertReadForOffice(ctx: ToolContext, abs: string, current?: Buffer): void {
  try {
    ctx.readTracker?.assertRead(ctx.roomId, ctx.parentStreamSessionId, abs, current);
  } catch (err) {
    throw new Error(`${(err as Error).message}（office 文档可用 office_read 读取）`);
  }
}

// ── 工具 defs ──

const READ_DEF: LLMToolDef = {
  name: 'office_read',
  description:
    '读取办公文档并输出结构化文本（按扩展名自动识别 xlsx/docx/pptx/pdf）。' +
    'xlsx：逐 sheet 预览（前 20 行 × 12 列，超限提示精读）；docx：标题/段落/列表/表格（markdown）；' +
    'pptx：逐 slide 文本与备注；pdf：逐页文本。读取后该文件即视为「已读」，可被 office 写工具覆盖/修改。',
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string', description: '相对 workspace 的文档路径' } },
    required: ['path'],
  },
};

const READ_CELLS_DEF: LLMToolDef = {
  name: 'office_read_cells',
  description:
    'Excel 精读：指定 sheet（名字或 1-based 序号）与 A1 range（省略=已用区域）取精确单元格值，' +
    '返回 markdown 表格（首行为表头）。上限 500 行 × 64 列。formulas=true 显示公式原文（默认显示计算值缓存）。',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '相对 workspace 的 .xlsx 路径' },
      sheet: { description: 'sheet 名或 1-based 序号', oneOf: [{ type: 'string' }, { type: 'number' }] },
      range: { type: 'string', description: 'A1 记法，如 A1:F50；省略=已用区域' },
      formulas: { type: 'boolean', description: 'true 时公式单元格显示 =原文' },
    },
    required: ['path', 'sheet'],
  },
};



const COPY_DEF: LLMToolDef = {
  name: 'office_copy',
  description:
    '复制办公文档（xlsx/docx/pptx/pdf）。典型流：复制模板/报表副本后，用 run_js（office-pro 插件）向副本写汇总页签。',
  inputSchema: {
    type: 'object',
    properties: {
      from: { type: 'string', description: '相对 workspace 的源路径' },
      to: { type: 'string', description: '相对 workspace 的目标路径（已存在须先读）' },
    },
    required: ['from', 'to'],
  },
};





// ── ToolModule 实现 ──

// 类外常量（Tier 划分见 spec §3）：
const OFFICE_CATALOG_META: Record<string, ToolMeta> = {
  office_read: { displayName: '读取文档', category: '办公', categoryEmoji: '💼', defaultOn: false },
  office_read_cells: { displayName: '读取表格数据', category: '办公', categoryEmoji: '💼', defaultOn: false },
  office_copy: { displayName: '复制文档', category: '办公', categoryEmoji: '💼', defaultOn: false, riskNote: '文件覆盖' },
};

export class OfficeTools implements ToolModule {
  getDefs(): LLMToolDef[] {
    return [READ_DEF, READ_CELLS_DEF, COPY_DEF];
  }

  getCatalog(): ToolCatalogEntry[] {
    return buildCatalog(this.getDefs(), OFFICE_CATALOG_META);
  }

  handles(name: string): boolean {
    return this.getDefs().some((d) => d.name === name);
  }

  async execute(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    switch (name) {
      case 'office_read': {
        if (ctx.abortSignal?.aborted) return '已中断';
        const rel = parseStringArg(args.path, 'path');
        const abs = ctx.wsFs.assertInWorkspace(rel);
        if (!fs.existsSync(abs)) throw new Error(`文件不存在: ${rel}`);
        const fmt = assertOfficeFormat(rel);
        const reader = READERS[fmt];
        if (!reader) throw new Error(`该格式读取器尚未接线: ${fmt}`);
        // B 方案收口：字节经通道读取 + 密文安全闸（明确报错，不做垃圾解析）
        const data = await ctx.wsFs.readFile(rel);
        assertNotCipher(data, rel);
        let out: string;
        try {
          out = await reader(data, ctx.abortSignal);
        } catch (err) {
          const msg = (err as Error).message;
          // 中断透传：与 bash/webfetch 的 resolve '已中断' 对齐（spec §7）
          if (msg === '已中断') return '已中断';
          // 规范文案透传：spec §10「无文本层」明确为扫描版语义，不被「文件损坏」前缀稀释
          if (msg.includes('无文本层')) throw err;
          throw new Error(`读取失败（文件损坏或非预期格式）: ${msg}`);
        }
        ctx.readTracker?.add(ctx.roomId, abs, ctx.parentStreamSessionId, data);
        return truncateString(out, OUTPUT_LIMITS.office_read);
      }
      case 'office_read_cells': {
        if (ctx.abortSignal?.aborted) return '已中断';
        const rel = parseStringArg(args.path, 'path');
        const abs = ctx.wsFs.assertInWorkspace(rel);
        if (!fs.existsSync(abs)) throw new Error(`文件不存在: ${rel}`);
        assertOfficeFormat(rel);
        const sheet = typeof args.sheet === 'number' ? args.sheet : parseStringArg(args.sheet, 'sheet');
        const range = typeof args.range === 'string' ? args.range : undefined;
        const formulas = args.formulas === true;
        // B 方案收口：字节经通道读取 + 密文安全闸
        const data = await ctx.wsFs.readFile(rel);
        assertNotCipher(data, rel);
        let out: string;
        try {
          out = await readXlsxCells(data, sheet, range, formulas);
        } catch (err) {
          const msg = (err as Error).message;
          if (msg === '已中断') return '已中断';
          if (msg.includes('sheet 不存在') || msg.includes('读取区域过大') || msg.includes('range')) throw err;
          throw new Error(`读取失败（文件损坏或非预期格式）: ${msg}`);
        }
        ctx.readTracker?.add(ctx.roomId, abs, ctx.parentStreamSessionId, data);
        const label = `Sheet: ${typeof sheet === 'number' ? `#${sheet}` : sheet}\n\n`;
        return label + truncateString(out, OUTPUT_LIMITS.office_read_cells);
      }
      case 'office_copy': {
        const fromRel = parseStringArg(args.from, 'from');
        const toRel = parseStringArg(args.to, 'to');
        const fromAbs = ctx.wsFs.assertInWorkspace(fromRel);
        const toAbs = ctx.wsFs.assertInWorkspace(toRel);
        if (!fs.existsSync(fromAbs)) throw new Error(`源文件不存在: ${fromRel}`);
        assertOfficeFormat(fromRel);
        // B 方案收口：源字节经通道读取 + 密文安全闸——密文源拒绝复制
        //（复制密文容器只会得到密文副本 + 下游工具垃圾解析）
        const bytes = await ctx.wsFs.readFile(fromRel);
        assertNotCipher(bytes, fromRel);
        const existed = fs.existsSync(toAbs);
        // 目标旧内容快照经通道读取（journal before；密文 → null 优雅降级），
        // 守门指纹复用同一份字节
        const before = existed ? await readJournalSnapshot(ctx.wsFs, toRel) : null;
        if (existed) assertReadForOffice(ctx, toAbs, before ?? undefined);
        recordChangeSafe(
          buildRecordCtx('office_copy', ctx),
          toJournalRelPath(ctx, toRel),
          existed ? 'modify' : 'create',
          before,
          bytes,
        );
        // B 方案收口：写入经通道（proxy 模式下裸写 = 明文落盘）
        await ctx.wsFs.writeFile(toRel, bytes);
        ctx.readTracker?.add(ctx.roomId, toAbs, ctx.parentStreamSessionId, bytes);
        return `已复制: ${fromRel} → ${toRel}`;
      }
      default:
        throw new Error(`未知 office 工具: ${name}`);
    }
  }
}
