// electron/src/main/agent/tools/office-tools.ts
// 办公文档工具组（spec 2026-09-18 §5）：四格式读取 + 生成 + Excel 增量写 + 复制。
// 写路径统一模式（对齐 file-tools v2.5）：沙箱断言 → 已存在则 Read-before-Edit
// → 读旧字节 → write-ahead 记账（before/after 为 Buffer，走账本二进制扩展）→
// 落盘 → 标记已读。读路径：沙箱断言 → 读取（预算截断）→ 标记已读。

import fs from 'node:fs';
import type { LLMToolDef } from '../llm-provider';
import type { ToolContext, ToolModule } from './types';
import { parseStringArg } from './shared/arg-parse';
import { OUTPUT_LIMITS, truncateString } from './shared/output-truncate';
import { buildRecordCtx, recordChangeSafe, toJournalRelPath } from './shared/change-journal';
import { assertOfficeFormat, type OfficeFormat } from './office/format';
import {
  createXlsx, parseExcelWriteOps, parseSheetInits, readXlsxCells, readXlsxPreview, writeXlsxOps,
} from './office/excel';
import { createDocx, parseDocSections, readDocx } from './office/docx';
import { createPptx, parsePptxSlides, readPptx } from './office/pptx';
import { createPdf, parsePdfBlocks, readPdf } from './office/pdf';

/** 各格式读取器注册表 */
const READERS: Partial<Record<OfficeFormat, (abs: string) => Promise<string>>> = {
  xlsx: readXlsxPreview,
  docx: readDocx,
  pptx: readPptx,
  pdf: readPdf,
};

/** Read-before-Edit 包装：office 场景补充 office_read 指引 */
function assertReadForOffice(ctx: ToolContext, abs: string): void {
  try {
    ctx.readTracker?.assertRead(ctx.streamSessionId, ctx.parentStreamSessionId, abs);
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

const CREATE_EXCEL_DEF: LLMToolDef = {
  name: 'office_create_excel',
  description:
    '创建新 xlsx（可选初始 sheet 名与列头）。只建骨架——数据一律用 office_write_excel 写入。' +
    '目标已存在时须先 office_read 读取后覆盖。「在原表加汇总页签」场景：office_copy 复制 + office_write_excel。',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '相对 workspace 的输出路径（.xlsx）' },
      sheets: {
        type: 'array',
        description: '初始 sheet 列表；省略建单个 Sheet1',
        items: {
          type: 'object',
          properties: { name: { type: 'string' }, headers: { type: 'array', items: { type: 'string' } } },
          required: ['name'],
        },
      },
    },
    required: ['path'],
  },
};

const WRITE_EXCEL_DEF: LLMToolDef = {
  name: 'office_write_excel',
  description:
    '增量写已有 xlsx：ops 数组依次执行。add_sheet 建新页签；set_cells 写二维区域（值或 {formula}）。' +
    'range 省略=从 A1 按 values 形状展开；给左上角单格同省略语义；给完整区域（A1:F50）则形状必须一致。' +
    'sheet 不存在时须先 add_sheet。写前该文件必须已被 office_read 读取。',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '相对 workspace 的 .xlsx 路径（须已存在）' },
      ops: {
        type: 'array',
        description: '操作序列',
        items: {
          type: 'object',
          properties: {
            op: { type: 'string', enum: ['add_sheet', 'set_cells'] },
            name: { type: 'string', description: 'add_sheet：新页签名' },
            sheet: { type: 'string', description: 'set_cells：目标页签名' },
            range: { type: 'string' },
            values: { type: 'array', items: { type: 'array' }, description: 'set_cells：二维数组' },
          },
          required: ['op'],
        },
      },
    },
    required: ['path', 'ops'],
  },
};

const COPY_DEF: LLMToolDef = {
  name: 'office_copy',
  description:
    '复制办公文档（xlsx/docx/pptx/pdf）。典型流：复制报表副本 → office_write_excel 向副本写汇总页签。',
  inputSchema: {
    type: 'object',
    properties: {
      from: { type: 'string', description: '相对 workspace 的源路径' },
      to: { type: 'string', description: '相对 workspace 的目标路径（已存在须先读）' },
    },
    required: ['from', 'to'],
  },
};

const OFFICE_CREATE_DOC_DEF: LLMToolDef = {
  name: 'office_create_doc',
  description:
    '生成 Word 文档（.docx）：按 sections 顺序输出标题（1-4 级）/段落/列表（有序或无序）/表格。' +
    '目标已存在时须先 office_read 读取后覆盖。参考模板重写 = office_read 读模板 → 按其结构给 sections 重新生成。',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '相对 workspace 的输出路径（.docx）' },
      sections: {
        type: 'array',
        description: '内容序列',
        items: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['heading', 'para', 'list', 'table'] },
            level: { type: 'number', description: 'heading 1-4，默认 1' },
            text: { type: 'string', description: 'heading/para 正文' },
            items: { type: 'array', items: { type: 'string' }, description: 'list 条目' },
            ordered: { type: 'boolean', description: 'list 是否有序' },
            header: { type: 'array', items: { type: 'string' }, description: 'table 表头' },
            rows: { type: 'array', items: { type: 'array' }, description: 'table 数据行' },
          },
          required: ['type'],
        },
      },
    },
    required: ['path', 'sections'],
  },
};

const OFFICE_CREATE_PPT_DEF: LLMToolDef = {
  name: 'office_create_ppt',
  description:
    '生成 PPT（.pptx）：逐 slide 标题 + 要点列表或表格 + 备注。简单版式（标题+内容），' +
    '复杂排版不支持（spec 边界）。目标已存在时须先 office_read 读取后覆盖。' +
    '参考模板重写 = office_read 读模板文本结构 → 按其分页与要点重新生成。',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '相对 workspace 的输出路径（.pptx）' },
      slides: {
        type: 'array',
        description: '幻灯片序列',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            bullets: { type: 'array', items: { type: 'string' } },
            table: {
              type: 'object',
              properties: {
                header: { type: 'array', items: { type: 'string' } },
                rows: { type: 'array', items: { type: 'array' } },
              },
              required: ['header'],
            },
            notes: { type: 'string' },
          },
          required: ['title'],
        },
      },
    },
    required: ['path', 'slides'],
  },
};

const OFFICE_CREATE_PDF_DEF: LLMToolDef = {
  name: 'office_create_pdf',
  description:
    '生成 PDF：blocks 顺序输出标题/段落/列表/表格/分页符，内嵌中文字体。' +
    '目标已存在时须先 office_read 读取后覆盖。表格为均分列宽简单网格线（v1 边界）。',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '相对 workspace 的输出路径（.pdf）' },
      blocks: {
        type: 'array',
        description: '内容序列',
        items: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['heading', 'para', 'list', 'table', 'pagebreak'] },
            level: { type: 'number' },
            text: { type: 'string' },
            items: { type: 'array', items: { type: 'string' } },
            ordered: { type: 'boolean' },
            header: { type: 'array', items: { type: 'string' } },
            rows: { type: 'array', items: { type: 'array' } },
          },
          required: ['type'],
        },
      },
    },
    required: ['path', 'blocks'],
  },
};

// ── ToolModule 实现 ──

export class OfficeTools implements ToolModule {
  getDefs(): LLMToolDef[] {
    return [READ_DEF, READ_CELLS_DEF, CREATE_EXCEL_DEF, WRITE_EXCEL_DEF, OFFICE_CREATE_DOC_DEF, OFFICE_CREATE_PPT_DEF, OFFICE_CREATE_PDF_DEF, COPY_DEF];
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
        let out: string;
        try {
          out = await reader(abs);
        } catch (err) {
          throw new Error(`读取失败（文件损坏或非预期格式）: ${(err as Error).message}`);
        }
        ctx.readTracker?.add(ctx.streamSessionId, abs);
        return truncateString(out, OUTPUT_LIMITS.office_read);
      }
      case 'office_read_cells': {
        const rel = parseStringArg(args.path, 'path');
        const abs = ctx.wsFs.assertInWorkspace(rel);
        if (!fs.existsSync(abs)) throw new Error(`文件不存在: ${rel}`);
        assertOfficeFormat(rel);
        const sheet = typeof args.sheet === 'number' ? args.sheet : parseStringArg(args.sheet, 'sheet');
        const range = typeof args.range === 'string' ? args.range : undefined;
        const formulas = args.formulas === true;
        let out: string;
        try {
          out = await readXlsxCells(abs, sheet, range, formulas);
        } catch (err) {
          const msg = (err as Error).message;
          if (msg.includes('sheet 不存在') || msg.includes('读取区域过大') || msg.includes('range')) throw err;
          throw new Error(`读取失败（文件损坏或非预期格式）: ${msg}`);
        }
        ctx.readTracker?.add(ctx.streamSessionId, abs);
        const label = `Sheet: ${typeof sheet === 'number' ? `#${sheet}` : sheet}\n\n`;
        return label + truncateString(out, OUTPUT_LIMITS.office_read_cells);
      }
      case 'office_create_excel': {
        const rel = parseStringArg(args.path, 'path');
        const abs = ctx.wsFs.assertInWorkspace(rel);
        assertOfficeFormat(rel);
        const existed = fs.existsSync(abs);
        if (existed) assertReadForOffice(ctx, abs);
        const sheets = parseSheetInits(args.sheets);
        const buf = await createXlsx(sheets);
        recordChangeSafe(
          buildRecordCtx('office_create_excel', ctx),
          toJournalRelPath(ctx, rel),
          existed ? 'modify' : 'create',
          existed ? fs.readFileSync(abs) : null,
          buf,
        );
        fs.writeFileSync(abs, buf);
        ctx.readTracker?.add(ctx.streamSessionId, abs);
        return `Excel 已${existed ? '覆盖' : '创建'}: ${rel}（sheet: ${sheets.map((s) => s.name).join(', ')}）`;
      }
      case 'office_write_excel': {
        const rel = parseStringArg(args.path, 'path');
        const abs = ctx.wsFs.assertInWorkspace(rel);
        if (!fs.existsSync(abs)) throw new Error(`文件不存在: ${rel}（先用 office_create_excel 创建）`);
        assertReadForOffice(ctx, abs);
        const ops = parseExcelWriteOps(args.ops);
        const before = fs.readFileSync(abs);
        const buf = await writeXlsxOps(before, ops);
        recordChangeSafe(buildRecordCtx('office_write_excel', ctx), toJournalRelPath(ctx, rel), 'modify', before, buf);
        fs.writeFileSync(abs, buf);
        ctx.readTracker?.add(ctx.streamSessionId, abs);
        return `已执行 ${ops.length} 个操作并写入: ${rel}`;
      }
      case 'office_create_doc': {
        const rel = parseStringArg(args.path, 'path');
        const abs = ctx.wsFs.assertInWorkspace(rel);
        assertOfficeFormat(rel);
        const existed = fs.existsSync(abs);
        if (existed) assertReadForOffice(ctx, abs);
        const sections = parseDocSections(args.sections);
        const buf = await createDocx(sections);
        recordChangeSafe(
          buildRecordCtx('office_create_doc', ctx),
          toJournalRelPath(ctx, rel),
          existed ? 'modify' : 'create',
          existed ? fs.readFileSync(abs) : null,
          buf,
        );
        fs.writeFileSync(abs, buf);
        ctx.readTracker?.add(ctx.streamSessionId, abs);
        return `Word 已${existed ? '覆盖' : '生成'}: ${rel}（${sections.length} 节）`;
      }
      case 'office_create_ppt': {
        const rel = parseStringArg(args.path, 'path');
        const abs = ctx.wsFs.assertInWorkspace(rel);
        assertOfficeFormat(rel);
        const existed = fs.existsSync(abs);
        if (existed) assertReadForOffice(ctx, abs);
        const slides = parsePptxSlides(args.slides);
        const buf = await createPptx(slides);
        recordChangeSafe(
          buildRecordCtx('office_create_ppt', ctx),
          toJournalRelPath(ctx, rel),
          existed ? 'modify' : 'create',
          existed ? fs.readFileSync(abs) : null,
          buf,
        );
        fs.writeFileSync(abs, buf);
        ctx.readTracker?.add(ctx.streamSessionId, abs);
        return `PPT 已${existed ? '覆盖' : '生成'}: ${rel}（${slides.length} 页）`;
      }
      case 'office_create_pdf': {
        const rel = parseStringArg(args.path, 'path');
        const abs = ctx.wsFs.assertInWorkspace(rel);
        assertOfficeFormat(rel);
        const existed = fs.existsSync(abs);
        if (existed) assertReadForOffice(ctx, abs);
        const blocks = parsePdfBlocks(args.blocks);
        const buf = await createPdf(blocks);
        recordChangeSafe(
          buildRecordCtx('office_create_pdf', ctx),
          toJournalRelPath(ctx, rel),
          existed ? 'modify' : 'create',
          existed ? fs.readFileSync(abs) : null,
          buf,
        );
        fs.writeFileSync(abs, buf);
        ctx.readTracker?.add(ctx.streamSessionId, abs);
        return `PDF 已${existed ? '覆盖' : '生成'}: ${rel}（${blocks.length} 块）`;
      }
      case 'office_copy': {
        const fromRel = parseStringArg(args.from, 'from');
        const toRel = parseStringArg(args.to, 'to');
        const fromAbs = ctx.wsFs.assertInWorkspace(fromRel);
        const toAbs = ctx.wsFs.assertInWorkspace(toRel);
        if (!fs.existsSync(fromAbs)) throw new Error(`源文件不存在: ${fromRel}`);
        assertOfficeFormat(fromRel);
        const existed = fs.existsSync(toAbs);
        if (existed) assertReadForOffice(ctx, toAbs);
        const bytes = fs.readFileSync(fromAbs);
        recordChangeSafe(
          buildRecordCtx('office_copy', ctx),
          toJournalRelPath(ctx, toRel),
          existed ? 'modify' : 'create',
          existed ? fs.readFileSync(toAbs) : null,
          bytes,
        );
        fs.writeFileSync(toAbs, bytes);
        ctx.readTracker?.add(ctx.streamSessionId, toAbs);
        return `已复制: ${fromRel} → ${toRel}（可用 office_write_excel 向副本增量写）`;
      }
      default:
        throw new Error(`未知 office 工具: ${name}`);
    }
  }
}
