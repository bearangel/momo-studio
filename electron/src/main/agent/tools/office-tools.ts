// electron/src/main/agent/tools/office-tools.ts
// 办公文档工具组（spec 2026-09-18 §5）：四格式读取 + 生成 + Excel 增量写 + 复制
// + PPT 模板填充（spec §14.9-3）。
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
  NUM_FORMAT_WHITELIST,
} from './office/excel';
import { createDocx, parseDocSections, readDocx } from './office/docx';
import { createPptx, parsePptxSlides, readPptx } from './office/pptx';
import { fillPptTemplate, parsePptTemplateFills } from './office/pptx-zip';
import { createPdf, parsePdfBlocks, readPdf } from './office/pdf';

/** 各格式读取器注册表：signal 沿 ctx.abortSignal 透传，helper 循环点自决 throw '已中断'（spec §7） */
const READERS: Partial<Record<OfficeFormat, (abs: string, signal?: AbortSignal) => Promise<string>>> = {
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
    '增量写已有 xlsx：ops 数组依次执行。**ops 批次原子性：任一 op 校验或执行失败，整批不落盘**。' +
    'add_sheet 建新页签；set_cells 写二维区域（值或 {formula}；以 = 开头的字符串自动按公式处理，前导 = 自动剥离）。' +
    'range 省略=从 A1 按 values 形状展开；给左上角单格同省略语义；给完整区域（A1:F50）则形状必须一致。' +
    '**省略 range = 从 A1 开始写（会覆盖表头！追加数据务必给 range 如 A100）**。' +
    `set_format 设区域数字格式（白名单：${NUM_FORMAT_WHITELIST.join(' / ')}；先写值再设格式，百分比/日期列必用）。` +
    'add_chart 建原生图表（柱 bar / 横条 bar_h / 折线 line / 饼 pie）：先 set_cells 写数据，再 add_chart 引用区域' +
    '（引用即活链接，改单元格图表跟随刷新）；**数据必须先于图表写入**。' +
    'add_chart 着色：series[].color 设系列色（6 位 hex 如 4472C4）；dataPointColors=[{index,color}] 逐数据点着色' +
    '（条件预警色，如超阈值红柱；index 超出点数 Excel 忽略）。' +
    'sheet 不存在时须先 add_sheet。写前该文件必须已被 office_read 读取。' +
    '汇总统计建议用 SUMIF/COUNTIF 公式引用明细区域（Excel 计算、避免手算误差；公式格作图表数据缓存留空打开后自算）。' +
    'fill 七型列规格——sequence_date{start,end,distribute:even|random}；sequence_number{start,step}；' +
    'random_int{min,max}；random_float{min,max,decimals}；pick{items,weights?}；literal{values}；' +
    'formula{template，{row} 占位实际行号}；sequence_date/sequence_number 另可选 repeat（正整数，默认 1）' +
    '——值每 repeat 行推进一次（块重复，如「每 5 行同一天」）；' +
    '锚点 anchor+行数 rows+可选 seed（省略 42，同参数同 seed 逐格复现）' +
    '——**禁止手写超过 20 行的大数组**（易形状错乱）；' +
    '派生列（如类别=产品映射）从第一列起就用公式 =VLOOKUP(C{row},目录区,2,0)（不要先随机再修）；' +
    '验证数据一致性优先用 office_read_cells 抽样比对。',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '相对 workspace 的 .xlsx 路径（须已存在）' },
      ops: {
        type: 'array',
        description: '操作序列（任一 op 失败整批不落盘）',
        items: {
          type: 'object',
          properties: {
            op: {
              type: 'string',
              enum: ['add_sheet', 'set_cells', 'set_format', 'fill', 'add_chart'],
              description:
                'add_chart：建原生图表（柱/横条/折线/饼）；fill：声明式批量数据生成（替代手写大数组）；' +
                'set_format：设区域数字格式（白名单校验）',
            },
            name: { type: 'string', description: 'add_sheet：新页签名' },
            sheet: {
              type: 'string',
              description: 'set_cells/set_format/fill/add_chart：目标页签名（add_chart：图表所在 sheet）',
            },
            range: {
              type: 'string',
              description: 'set_cells：A1 range；省略=从 A1 按 values 形状展开；set_format：目标区域（单格或 A1:F50）',
            },
            format: {
              type: 'string',
              description: `set_format：数字格式（白名单：${NUM_FORMAT_WHITELIST.join(' / ')}）`,
            },
            values: {
              type: 'array',
              items: { type: 'array' },
              description:
                'set_cells：二维数组（元素 string/number/boolean/null/{formula}）；' +
                '以 = 开头的字符串自动按公式处理（{formula} 形态亦会自动剥前导 =）',
            },
            anchor: {
              type: 'string',
              description:
                'fill：单格左上角锚点（如 A2），生成区域按 rows × columns.length 向右下展开；' +
                'add_chart：图表左上角单格锚点（如 B2）；省略默认尺寸 8 列 × 15 行',
            },
            rows: {
              type: 'number',
              description: 'fill：生成行数（1..50000 整数）',
            },
            seed: {
              type: 'number',
              description: 'fill：确定性 PRNG 种子（省略 = 42；同 seed 同参数逐字节可复现）',
            },
            columns: {
              type: 'array',
              description:
                'fill 七型列规格——sequence_date{start,end,distribute:even|random}；' +
                'sequence_number{start,step}；random_int{min,max}；random_float{min,max,decimals}；' +
                'pick{items,weights?}；literal{values}；formula{template，{row} 占位实际行号}；' +
                'sequence_date/sequence_number 可选 repeat（正整数，默认 1）——值每 repeat 行推进一次',
              items: { type: 'object' },
            },
            type: {
              type: 'string',
              enum: ['bar', 'bar_h', 'line', 'pie'],
              description: 'add_chart：图表类型（柱/横条/折线/饼）',
            },
            size: {
              type: 'object',
              description: 'add_chart：图表尺寸 {cols, rows}（列/行数，正整数）',
              properties: {
                cols: { type: 'number', description: '宽度（列数）' },
                rows: { type: 'number', description: '高度（行数）' },
              },
            },
            title: { type: 'string', description: 'add_chart：图表标题（可选）' },
            dataPointColors: {
              type: 'array',
              description:
                'add_chart：逐数据点着色 [{index, color}]（条件预警色，如超阈值红柱；' +
                'index 非负整数，超出系列点数的项 Excel 忽略；6 位 hex）',
              items: {
                type: 'object',
                properties: {
                  index: { type: 'number', description: '数据点下标（0-based 非负整数）' },
                  color: { type: 'string', description: '6 位 hex（如 FF0000）' },
                },
                required: ['index', 'color'],
              },
            },
            categories: {
              type: 'object',
              description: 'add_chart：类别轴引用 {sheet, range}（单行或单列）',
              properties: {
                sheet: { type: 'string', description: '源数据 sheet 名' },
                range: { type: 'string', description: 'A1 range（如 A2:A10）' },
              },
              required: ['sheet', 'range'],
            },
            series: {
              type: 'array',
              description: 'add_chart：数据序列；pie 仅 1 个',
              items: {
                type: 'object',
                properties: {
                  name: {
                    description: '序列名：字符串字面量 或 {sheet, range} 单格引用',
                  },
                  color: {
                    type: 'string',
                    description: '序列实心填充色（6 位 hex，如 4472C4）',
                  },
                  values: {
                    type: 'object',
                    description: '数值引用 {sheet, range}（单行或单列）',
                    properties: {
                      sheet: { type: 'string' },
                      range: { type: 'string', description: 'A1 range（如 B2:B10）' },
                    },
                    required: ['sheet', 'range'],
                  },
                },
                required: ['values'],
              },
            },
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
    '生成 PPT（.pptx）：逐 slide 标题 + 要点列表或表格 + 备注；' +
    '支持页级背景色（background，6 位 hex 如 1F3864）/插图（images，图先入 workspace、' +
    '本工具只引用，扩展白名单 png/jpg/jpeg/gif/webp/bmp）/原生图表（chart，活图表非截图，' +
    '数据由 agent 经 office_read_cells 取数提供）。' +
    '简单版式（标题+内容），复杂排版不支持（spec 边界）。目标已存在时须先 office_read 读取后覆盖。' +
    '用户提供 .pptx 模板要保留版式/主题/品牌时，改用 office_fill_ppt_template 按页填充；' +
    '本页工具是基于 pptxgenjs 的全新生成，不继承模板样式。',
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
            background: {
              type: 'string',
              description: '页背景色（6 位 hex，如 1F3864；深色底建议配浅色正文——v1 正文色固定黑，深底场景慎用）',
            },
            images: {
              type: 'array',
              description:
                '插图列表：path 为 workspace 相对路径（png/jpg/jpeg/gif/webp/bmp，须已存在——' +
                '图片进 workspace 是用户/文件工具的职责，本工具只引用）；x/y/w/h 英寸可选，' +
                '缺省 x=0.5/y=1.8/w=9、h 按 w×0.6 兜底（需精确宽高比时显式给 h）',
              items: {
                type: 'object',
                properties: {
                  path: { type: 'string', description: '相对 workspace 的图片路径' },
                  x: { type: 'number', description: '左上角 x（英寸）' },
                  y: { type: 'number', description: '左上角 y（英寸）' },
                  w: { type: 'number', description: '宽（英寸，正数）' },
                  h: { type: 'number', description: '高（英寸，正数；缺省按 w×0.6）' },
                },
                required: ['path'],
              },
            },
            chart: {
              type: 'object',
              description:
                '原生图表（活图表非截图；数据由 agent 经 office_read_cells 取数提供）',
              properties: {
                type: { type: 'string', enum: ['bar', 'bar_h', 'line', 'pie'], description: '柱/横条/折线/饼' },
                categories: { type: 'array', items: { type: 'string' }, description: '类别轴标签' },
                series: {
                  type: 'array',
                  description: '数据序列（pie 仅 1 个）；color 为 6 位 hex 系列色（可选）',
                  items: {
                    type: 'object',
                    properties: {
                      name: { type: 'string', description: '序列名' },
                      values: { type: 'array', items: { type: 'number' }, description: '数值（与 categories 等长）' },
                      color: { type: 'string', description: '系列色（6 位 hex，如 4472C4）' },
                    },
                    required: ['name', 'values'],
                  },
                },
                title: { type: 'string', description: '图表标题（可选）' },
              },
              required: ['type', 'categories', 'series'],
            },
          },
          required: ['title'],
        },
      },
    },
    required: ['path', 'slides'],
  },
};

const OFFICE_FILL_PPT_DEF: LLMToolDef = {
  name: 'office_fill_ppt_template',
  description:
    '以现有 .pptx 为模板填充标题与要点，产出新文件（另存语义——模板本身不动，字节零修改）。' +
    '公司模板的版式/主题/母版/品牌元素（背景/Logo/配色）全保留，只替换各页占位符文本。' +
    'slides 第 i 项填模板第 i 页：少于模板页数时多余页保持原样；某页不给 bullets 则该页正文不变；' +
    '超出模板页数报错。输出已存在时须先 office_read 读取后覆盖。',
  inputSchema: {
    type: 'object',
    properties: {
      template: { type: 'string', description: '相对 workspace 的模板路径（.pptx，只读不改）' },
      path: { type: 'string', description: '相对 workspace 的输出路径（.pptx）' },
      slides: {
        type: 'array',
        description: '逐页填充内容（第 i 项对应模板第 i 页）',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string', description: '新标题（保留模板标题样式）' },
            bullets: {
              type: 'array',
              items: { type: 'string' },
              description: '要点列表（每条一段，保留模板正文样式；省略 = 正文不变）',
            },
          },
          required: ['title'],
        },
      },
    },
    required: ['template', 'path', 'slides'],
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
    return [READ_DEF, READ_CELLS_DEF, CREATE_EXCEL_DEF, WRITE_EXCEL_DEF, OFFICE_CREATE_DOC_DEF, OFFICE_CREATE_PPT_DEF, OFFICE_FILL_PPT_DEF, OFFICE_CREATE_PDF_DEF, COPY_DEF];
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
          out = await reader(abs, ctx.abortSignal);
        } catch (err) {
          const msg = (err as Error).message;
          // 中断透传：与 bash/webfetch 的 resolve '已中断' 对齐（spec §7）
          if (msg === '已中断') return '已中断';
          // 规范文案透传：spec §10「无文本层」明确为扫描版语义，不被「文件损坏」前缀稀释
          if (msg.includes('无文本层')) throw err;
          throw new Error(`读取失败（文件损坏或非预期格式）: ${msg}`);
        }
        ctx.readTracker?.add(ctx.streamSessionId, abs);
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
        let out: string;
        try {
          out = await readXlsxCells(abs, sheet, range, formulas);
        } catch (err) {
          const msg = (err as Error).message;
          if (msg === '已中断') return '已中断';
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
        // 箭头包装而非裸传方法引用：assertInWorkspace 读 this（P0-1 this 解绑教训）
        const slides = parsePptxSlides(args.slides, (rel) => ctx.wsFs.assertInWorkspace(rel));
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
      case 'office_fill_ppt_template': {
        const templateRel = parseStringArg(args.template, 'template');
        const templateAbs = ctx.wsFs.assertInWorkspace(templateRel);
        if (!fs.existsSync(templateAbs)) throw new Error(`模板不存在: ${templateRel}`);
        if (assertOfficeFormat(templateRel) !== 'pptx') {
          throw new Error(`模板必须是 .pptx: ${templateRel}（模板填充仅支持 pptx）`);
        }
        const rel = parseStringArg(args.path, 'path');
        const abs = ctx.wsFs.assertInWorkspace(rel);
        if (assertOfficeFormat(rel) !== 'pptx') {
          throw new Error(`输出必须是 .pptx 路径: ${rel}`);
        }
        // realpath 归一比较：大小写不敏感 FS（macOS/Windows）与 symlink 别名下
        // 字符串相等会漏判，落盘即毁模板（review Minor-2）
        const sameTarget = (a: string, b: string): boolean => {
          const norm = (p: string): string => {
            try { return fs.realpathSync(p); } catch { return p; }
          };
          return norm(a) === norm(b);
        };
        if (sameTarget(abs, templateAbs)) {
          throw new Error(`输出路径不能与模板相同（另存语义，模板保持不动）: ${rel}`);
        }
        const existed = fs.existsSync(abs);
        if (existed) assertReadForOffice(ctx, abs);
        const slides = parsePptTemplateFills(args.slides);
        // 读写分离：先读模板字节再手术——输出落盘不触碰模板文件
        const buf = fillPptTemplate(fs.readFileSync(templateAbs), slides);
        recordChangeSafe(
          buildRecordCtx('office_fill_ppt_template', ctx),
          toJournalRelPath(ctx, rel),
          existed ? 'modify' : 'create',
          existed ? fs.readFileSync(abs) : null,
          buf,
        );
        fs.writeFileSync(abs, buf);
        ctx.readTracker?.add(ctx.streamSessionId, abs);
        return `PPT 模板填充完成: ${templateRel} → ${rel}（填充 ${slides.length} 页；版式/主题/品牌保留，模板未修改）`;
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
