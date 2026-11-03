// Excel 读取封装（exceljs，spec 2026-11-03 §6 下线生成后仅保留读路径）：
// sheet 预览（office_read）与区域精读（office_read_cells）两档。
// 公式注意：exceljs 不计算公式——读取公式的 result 仅取文件内缓存值。
// 读图表隔离：sanitizeXlsxForRead 读前净化内存副本（剥离 drawings/charts/media
// 部件 + sheet rels 过滤 drawing 条目 + sheet XML 剥 <drawing/> 标签），
// 解决 exceljs 解析 real-Excel 形态 xdr:graphicFrame / unsupported anchor
// 类型崩溃的问题（P0 read-fix）。生成与图表注入能力由 office-pro 插件承接。

import ExcelJS from 'exceljs';
import AdmZip from 'adm-zip';
import fs from 'node:fs';
import { parseRange, asString, asStringArray } from './format';
import { extractChartSummaries } from './xlsx-zip';
import type { ChartSummary } from './xlsx-zip';

export const PREVIEW_ROWS = 20;
export const PREVIEW_COLS = 12;
export const MAX_READ_ROWS = 500;
export const MAX_READ_COLS = 64;

/** 读前净化（内存副本，不动原件）：剥离 exceljs 无法解析的 drawing/chart/media 部件。
 *  sheet rels 仅过滤 Type 以 '/drawing' 或 '/chart' 结尾的条目（hyperlink 等保留；
 *  过滤后为空则删该 rels 文件）；sheet XML 剥 <drawing .../> 标签。
 *  chartCount = 原始缓冲中 xl/charts/ 下的部件数；chartSummaries 从原始缓冲提取
 *  （先于删除——净化件已无 chart 部件），供预览头部图表提示（spec §14.8-4）。 */
export function sanitizeXlsxForRead(buf: Buffer): {
  data: Buffer;
  chartCount: number;
  chartSummaries: ChartSummary[];
} {
  const zip = new AdmZip(buf);
  const entries = zip.getEntries();
  // 摘要从原始 buffer 提取（对原件而非净化件）；统计原始 chart 部件数（提示用）
  const chartSummaries = extractChartSummaries(buf);
  const chartCount = entries.filter((e) => e.entryName.startsWith('xl/charts/') && !e.isDirectory).length;
  // 第一遍：删 drawings / charts / media（media 仅被 drawing 引用）
  for (const e of entries) {
    if (
      e.entryName.startsWith('xl/drawings/') ||
      e.entryName.startsWith('xl/charts/') ||
      e.entryName.startsWith('xl/media/')
    ) {
      zip.deleteFile(e.entryName);
    }
  }
  // 第二遍：sheet rels 过滤 drawing/chart 条目；过滤后为空则删除该 rels 文件
  for (const e of entries) {
    if (/^xl\/worksheets\/_rels\/sheet\d+\.xml\.rels$/.test(e.entryName)) {
      const xml = zip.readAsText(e.entryName);
      const relationships = xml.match(/<Relationship\b[^>]*\/>/g) ?? [];
      const kept = relationships.filter((r) => !/\/drawing["']/.test(r) && !/\/chart["']/.test(r));
      if (kept.length === 0) {
        zip.deleteFile(e.entryName);
      } else if (kept.length !== relationships.length) {
        zip.updateFile(
          e.entryName,
          Buffer.from(
            `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
              `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
              `${kept.join('')}` +
              `</Relationships>`,
          ),
        );
      }
    }
  }
  // 第三遍：sheet XML 剥 <drawing .../> 标签（自身闭合形态，real-Excel 写法）
  for (const e of entries) {
    if (/^xl\/worksheets\/sheet\d+\.xml$/.test(e.entryName)) {
      const xml = zip.readAsText(e.entryName);
      if (xml.includes('<drawing ')) {
        zip.updateFile(e.entryName, Buffer.from(xml.replace(/<drawing\b[^>]*\/>/g, '')));
      }
    }
  }
  return { data: zip.toBuffer(), chartCount, chartSummaries };
}

/** 单元格值 → 展示文本。formulas=true 时公式显示 =原文，否则显示缓存 result */
export function cellText(v: ExcelJS.CellValue, formulas = false): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    if ('formula' in v && typeof v.formula === 'string') {
      return formulas ? `=${v.formula}` : cellText(v.result ?? null, false);
    }
    if ('sharedFormula' in v && typeof v.sharedFormula === 'string') {
      return formulas ? `=${v.sharedFormula}` : cellText(v.result ?? null, false);
    }
    if ('richText' in v) return v.richText.map((t) => t.text).join('');
    if ('error' in v) return String(v.error);
    if ('hyperlink' in v) return typeof v.text === 'string' ? v.text : String(v.hyperlink);
    return JSON.stringify(v);
  }
  return String(v);
}

/** 图表摘要引用段渲染（spec §14.8-4）：cat/val/name 桶覆盖全部引用且 ≤4 个时
 *  标注 序列名/类别/数值；否则按出现序列出，超过 4 个截断提示。 */
function chartRefSeg(s: ChartSummary): string {
  const refs = s.refs;
  if (refs.length === 0) return '';
  const name = s.nameRefs ?? [];
  const cat = s.catRefs ?? [];
  const val = s.valRefs ?? [];
  const classified = new Set([...name, ...cat, ...val]);
  if (refs.every((r) => classified.has(r)) && refs.length <= 4) {
    const segs: string[] = [];
    if (name.length > 0) segs.push(`序列名 ${name.join('、')}`);
    if (cat.length > 0) segs.push(`类别 ${cat.join('、')}`);
    if (val.length > 0) segs.push(`数值 ${val.join('、')}`);
    return segs.join(' / ');
  }
  const shown = refs.slice(0, 4).join('、');
  return refs.length > 4 ? `${shown} 等 ${refs.length} 个引用` : shown;
}

/** 单图摘要行：图表N[类型] 标题 → 引用段（无标题/无引用时省略对应段） */
function chartSummaryLine(n: number, s: ChartSummary): string {
  const head = `图表${n}[${s.kind}]${s.title === null ? '' : ` ${s.title}`}`;
  const seg = chartRefSeg(s);
  return seg === '' ? head : `${head} → ${seg}`;
}

/** 头部图表提示块（spec §14.8-4）：单图提示与摘要同行；多图提示行 + 逐图行；
 *  部件存在但全部无法解析时退回纯部件计数提示（读取仅覆盖单元格数据）。 */
function chartHintBlock(chartCount: number, summaries: ChartSummary[]): string {
  const first = summaries[0];
  if (summaries.length === 0) {
    return `（注：文件含 ${chartCount} 个图表/图形部件，读取仅覆盖单元格数据）`;
  }
  if (chartCount === 1 && first !== undefined) {
    return `（注：文件含 1 个图表）${chartSummaryLine(1, first)}`;
  }
  const lines = [`（注：文件含 ${chartCount} 个图表）`];
  summaries.forEach((s, i) => lines.push(chartSummaryLine(i + 1, s)));
  return lines.join('\n');
}

/** sheet 预览：每 sheet 一节（维度 + 前 20 行 × 12 列 markdown 表格） */
export async function readXlsxPreview(abs: string, signal?: AbortSignal): Promise<string> {
  const raw = fs.readFileSync(abs);
  const { data, chartCount, chartSummaries } = sanitizeXlsxForRead(raw);
  const wb = new ExcelJS.Workbook();
  // exceljs 类型层 Buffer extends ArrayBuffer，与 Node Buffer<ArrayBufferLike> 结构不兼容——断言为 ArrayBuffer，运行时字节布局一致
  await wb.xlsx.load(data as unknown as ArrayBuffer);
  const parts: string[] = [];
  if (chartCount > 0) {
    parts.push(chartHintBlock(chartCount, chartSummaries));
  }
  for (const ws of wb.worksheets) {
    if (signal?.aborted) throw new Error('已中断');
    const rows = ws.rowCount;
    const cols = ws.columnCount;
    parts.push(`## Sheet: ${ws.name} (${rows}×${cols})`);
    if (rows === 0 || cols === 0) {
      parts.push('(空 sheet)');
      continue;
    }
    const lines: string[] = [];
    const rMax = Math.min(rows, PREVIEW_ROWS);
    const cMax = Math.min(cols, PREVIEW_COLS);
    for (let r = 1; r <= rMax; r++) {
      const cells: string[] = [];
      for (let c = 1; c <= cMax; c++) cells.push(cellText(ws.getCell(r, c).value));
      lines.push(`| ${cells.join(' | ')} |`);
      if (r === 1) lines.push(`|${' --- |'.repeat(cMax)}`);
    }
    parts.push(lines.join('\n'));
    if (cols > PREVIEW_COLS) parts.push(`(共 ${cols} 列，仅预览前 ${PREVIEW_COLS} 列)`);
    if (rows > PREVIEW_ROWS) {
      parts.push(`(共 ${rows} 行，仅预览前 ${PREVIEW_ROWS} 行——用 office_read_cells 精读)`);
    }
  }
  return parts.join('\n\n');
}

/** 区域精读：markdown 表格（首行为表头）；sheet 按名或 1-based 序号 */
export async function readXlsxCells(
  abs: string,
  sheet: string | number,
  range?: string,
  formulas = false,
): Promise<string> {
  const raw = fs.readFileSync(abs);
  const { data } = sanitizeXlsxForRead(raw);
  const wb = new ExcelJS.Workbook();
  // exceljs 类型层 Buffer extends ArrayBuffer，与 Node Buffer<ArrayBufferLike> 结构不兼容——断言为 ArrayBuffer，运行时字节布局一致
  await wb.xlsx.load(data as unknown as ArrayBuffer);
  const ws = typeof sheet === 'number' ? wb.worksheets[sheet - 1] : wb.getWorksheet(sheet);
  if (!ws) {
    throw new Error(`sheet 不存在: ${typeof sheet === 'number' ? `#${sheet}` : sheet}`);
  }
  let startRow = 1;
  let startCol = 1;
  let endRow = ws.rowCount;
  let endCol = ws.columnCount;
  if (range) {
    const r = parseRange(range);
    startRow = r.startRow;
    startCol = r.startCol;
    endRow = r.endRow ?? ws.rowCount;
    endCol = r.endCol ?? ws.columnCount;
  }
  const rows = endRow - startRow + 1;
  const cols = endCol - startCol + 1;
  if (rows > MAX_READ_ROWS || cols > MAX_READ_COLS) {
    throw new Error(
      `读取区域过大（${rows} 行 × ${cols} 列）——上限 ${MAX_READ_ROWS} 行 × ${MAX_READ_COLS} 列，请用 range 缩小`,
    );
  }
  const lines: string[] = [];
  for (let r = startRow; r <= endRow; r++) {
    const cells: string[] = [];
    for (let c = startCol; c <= endCol; c++) cells.push(cellText(ws.getCell(r, c).value, formulas));
    lines.push(`| ${cells.join(' | ')} |`);
    if (r === startRow) lines.push(`|${' --- |'.repeat(cols)}`);
  }
  return lines.join('\n');
}
