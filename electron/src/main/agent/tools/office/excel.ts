// Excel 读写封装（exceljs）。读取两档：sheet 预览（office_read）与区域精读
// （office_read_cells）；写路径 createXlsx / writeXlsxOps 返回 Buffer，落盘与
// 记账由 office-tools 统一处理（write-ahead：先记账后写盘）。
// 公式注意：exceljs 不计算公式——读取公式的 result 仅取文件内缓存值；写入侧
// 新写的公式无缓存（显示空）。图表缓存语义（spec §14.6 P1b）：add_chart 引用
// 区域容忍公式格——有缓存 result 用之，无缓存该点 omit（c:pt 省略、ptCount 全长），
// Excel 打开后自动计算回填；写路径每次写盘对全部既有图表按 c:f 重算缓存（P1a）。
// 读图表隔离：sanitizeXlsxForRead 读前净化内存副本（剥离 drawings/charts/media
// 部件 + sheet rels 过滤 drawing 条目 + sheet XML 剥 <drawing/> 标签），
// 解决 exceljs 解析 real-Excel 形态 xdr:graphicFrame / unsupported anchor
// 类型崩溃的问题（P0 read-fix）。
// 写图表编排（add_chart）：exceljs 只懂单元格——writeXlsxOps 走「快照 → 净化 →
// exceljs 重写 → 回注快照 → 缓存重算 → 注入新图表」管线，chart/drawing XML 由
// chart-xml 纯函数生成、zip 层操作由 xlsx-zip 承担，本文件只做编排与区域读值。

import ExcelJS from 'exceljs';
import AdmZip from 'adm-zip';
import fs from 'node:fs';
import { parseRange, asString, asStringArray } from './format';
import { buildChartXml, buildAnchorXml, sheetAbsRef } from './chart-xml';
import type { ChartData, ChartSeriesData, ChartType } from './chart-xml';
import { resolveSheetFile, snapshotChartParts, restoreChartParts, injectCharts, refreshChartCaches } from './xlsx-zip';

export const PREVIEW_ROWS = 20;
export const PREVIEW_COLS = 12;
export const MAX_READ_ROWS = 500;
export const MAX_READ_COLS = 64;

/** 读前净化（内存副本，不动原件）：剥离 exceljs 无法解析的 drawing/chart/media 部件。
 *  sheet rels 仅过滤 Type 以 '/drawing' 或 '/chart' 结尾的条目（hyperlink 等保留；
 *  过滤后为空则删该 rels 文件）；sheet XML 剥 <drawing .../> 标签。
 *  chartCount = 原始缓冲中 xl/charts/ 下的部件数（仅用于提示，不代表 sanitize 后数量）。 */
export function sanitizeXlsxForRead(buf: Buffer): { data: Buffer; chartCount: number } {
  const zip = new AdmZip(buf);
  const entries = zip.getEntries();
  // 统计原始 chart 部件数（在删前快照，提示用）
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
  return { data: zip.toBuffer(), chartCount };
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

/** sheet 预览：每 sheet 一节（维度 + 前 20 行 × 12 列 markdown 表格） */
export async function readXlsxPreview(abs: string, signal?: AbortSignal): Promise<string> {
  const raw = fs.readFileSync(abs);
  const { data, chartCount } = sanitizeXlsxForRead(raw);
  const wb = new ExcelJS.Workbook();
  // exceljs 类型层 Buffer extends ArrayBuffer，与 Node Buffer<ArrayBufferLike> 结构不兼容——断言为 ArrayBuffer，运行时字节布局一致
  await wb.xlsx.load(data as unknown as ArrayBuffer);
  const parts: string[] = [];
  if (chartCount > 0) {
    parts.push(`（注：文件含 ${chartCount} 个图表/图形部件，读取仅覆盖单元格数据）`);
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

// ────────────────────────────────────────────────────────────────────────────
// 写链路：类型 + 窄化 + 序列化。返回 Buffer（调用方记账后落盘）。
// ────────────────────────────────────────────────────────────────────────────

export interface ExcelSheetInit {
  name: string;
  headers?: string[];
}

/** sheets 参数窄化：缺省 [{name:'Sheet1'}]；name 必填且查重 */
export function parseSheetInits(raw: unknown): ExcelSheetInit[] {
  if (raw === undefined || raw === null) return [{ name: 'Sheet1' }];
  if (!Array.isArray(raw) || raw.length === 0) throw new Error('参数 sheets 缺失或不是非空数组');
  const seen = new Set<string>();
  return raw.map((s, i) => {
    if (typeof s !== 'object' || s === null) throw new Error(`sheets[${i}] 不是对象`);
    const rec = s as Record<string, unknown>;
    const name = asString(rec.name, `sheets[${i}].name`);
    if (seen.has(name)) throw new Error(`sheet 重名: ${name}`);
    seen.add(name);
    return {
      name,
      headers: rec.headers === undefined ? undefined : asStringArray(rec.headers, `sheets[${i}].headers`),
    };
  });
}

export type CellInput = string | number | boolean | null | { formula: string };

/** 区域引用：sheet 显示名 + A1 记法（图表 categories / values / name 用） */
export interface SheetRangeRef {
  sheet: string;
  range: string;
}

/** 图表序列入参：name 可选（单格引用或字面量），values 必填（单行/单列区域） */
export interface ChartSeriesSpec {
  name?: SheetRangeRef | string;
  values: SheetRangeRef;
}

export const CHART_DEFAULT_COLS = 8;
export const CHART_DEFAULT_ROWS = 15;

/** add_chart op（parse 后形态）：size 已解析为完整正整数，title/name 可选已归一 */
export interface ChartOpSpec {
  op: 'add_chart';
  sheet: string;
  type: ChartType;
  /** 图表左上角单格锚点（A1 记法，parse 保证单格） */
  anchor: string;
  size: { cols: number; rows: number };
  title?: string;
  categories: SheetRangeRef;
  series: ChartSeriesSpec[];
}

export type ExcelWriteOp =
  | { op: 'add_sheet'; name: string }
  | { op: 'set_cells'; sheet: string; range?: string; values: CellInput[][] }
  | ChartOpSpec;

function parseCellInput(v: unknown, what: string): CellInput {
  if (v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
    return v;
  }
  if (typeof v === 'object' && typeof (v as Record<string, unknown>).formula === 'string') {
    return { formula: (v as Record<string, unknown>).formula as string };
  }
  throw new Error(`参数 ${what} 不是合法单元格值（string/number/boolean/null/{formula}）`);
}

function asPositiveInt(v: unknown, what: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) {
    throw new Error(`参数 ${what} 必须是正整数`);
  }
  return v;
}

function parseSheetRangeRef(v: unknown, what: string): SheetRangeRef {
  if (typeof v !== 'object' || v === null) {
    throw new Error(`参数 ${what} 缺失或不是 {sheet, range} 对象`);
  }
  const rec = v as Record<string, unknown>;
  return { sheet: asString(rec.sheet, `${what}.sheet`), range: asString(rec.range, `${what}.range`) };
}

export function parseExcelWriteOps(raw: unknown): ExcelWriteOp[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new Error('参数 ops 缺失或不是非空数组');
  return raw.map((o, i) => {
    if (typeof o !== 'object' || o === null) throw new Error(`ops[${i}] 不是对象`);
    const rec = o as Record<string, unknown>;
    if (rec.op === 'add_sheet') {
      return { op: 'add_sheet' as const, name: asString(rec.name, `ops[${i}].name`) };
    }
    if (rec.op === 'set_cells') {
      const sheet = asString(rec.sheet, `ops[${i}].sheet`);
      const range = typeof rec.range === 'string' ? rec.range : undefined;
      if (!Array.isArray(rec.values) || rec.values.length === 0) {
        throw new Error(`ops[${i}].values 缺失或不是非空二维数组`);
      }
      const values = rec.values.map((row, ri) => {
        if (!Array.isArray(row)) throw new Error(`ops[${i}].values[${ri}] 不是数组`);
        return row.map((c, ci) => parseCellInput(c, `ops[${i}].values[${ri}][${ci}]`));
      });
      return { op: 'set_cells' as const, sheet, range, values };
    }
    if (rec.op === 'add_chart') {
      const sheet = asString(rec.sheet, `ops[${i}].sheet`);
      const type = asString(rec.type, `ops[${i}].type`);
      if (type !== 'bar' && type !== 'bar_h' && type !== 'line' && type !== 'pie') {
        throw new Error(`ops[${i}].type 非法（支持 bar / bar_h / line / pie）`);
      }
      const anchor = asString(rec.anchor, `ops[${i}].anchor`);
      const anchorRange = parseRange(anchor);
      if (anchorRange.endRow !== null || anchorRange.endCol !== null) {
        throw new Error(`ops[${i}].anchor 必须是单格左上角（如 A16）`);
      }
      let cols = CHART_DEFAULT_COLS;
      let rows = CHART_DEFAULT_ROWS;
      if (rec.size !== undefined) {
        if (typeof rec.size !== 'object' || rec.size === null) {
          throw new Error(`参数 ops[${i}].size 不是对象`);
        }
        const sz = rec.size as Record<string, unknown>;
        if (sz.cols !== undefined) cols = asPositiveInt(sz.cols, `ops[${i}].size.cols`);
        if (sz.rows !== undefined) rows = asPositiveInt(sz.rows, `ops[${i}].size.rows`);
      }
      const title = typeof rec.title === 'string' && rec.title.length > 0 ? rec.title : undefined;
      const categories = parseSheetRangeRef(rec.categories, `ops[${i}].categories`);
      if (!Array.isArray(rec.series) || rec.series.length === 0) {
        throw new Error(`ops[${i}].series 缺失或不是非空数组`);
      }
      if (type === 'pie' && rec.series.length > 1) {
        throw new Error(`pie 图仅支持 1 个序列（收到 ${rec.series.length} 个）`);
      }
      const series: ChartSeriesSpec[] = rec.series.map((s, si) => {
        if (typeof s !== 'object' || s === null) throw new Error(`ops[${i}].series[${si}] 不是对象`);
        const sr = s as Record<string, unknown>;
        let name: SheetRangeRef | string | undefined;
        if (sr.name !== undefined) {
          if (typeof sr.name === 'string') {
            name = asString(sr.name, `ops[${i}].series[${si}].name`);
          } else if (typeof sr.name === 'object' && sr.name !== null) {
            const nameRef = parseSheetRangeRef(sr.name, `ops[${i}].series[${si}].name`);
            const nameRange = parseRange(nameRef.range);
            if (nameRange.endRow !== null || nameRange.endCol !== null) {
              throw new Error(`ops[${i}].series[${si}].name 引用必须是单格（如 B1）`);
            }
            name = nameRef;
          } else {
            throw new Error(`ops[${i}].series[${si}].name 必须是 {sheet, range} 对象或字符串`);
          }
        }
        return { name, values: parseSheetRangeRef(sr.values, `ops[${i}].series[${si}].values`) };
      });
      return {
        op: 'add_chart' as const,
        sheet,
        type,
        anchor,
        size: { cols, rows },
        title,
        categories,
        series,
      };
    }
    throw new Error(`ops[${i}].op 非法（支持 add_sheet / set_cells / add_chart）`);
  });
}

/** 建新 xlsx 骨架（可选列头），返回文件字节 */
export async function createXlsx(sheets: ExcelSheetInit[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  for (const s of sheets) {
    const ws = wb.addWorksheet(s.name);
    if (s.headers) ws.addRow(s.headers);
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** exceljs 公式单元格值判定（formula / sharedFormula 两形态），非公式格返回 null */
function asFormulaCell(
  v: ExcelJS.CellValue,
): { formula?: unknown; sharedFormula?: unknown; result?: unknown } | null {
  if (typeof v !== 'object' || v === null || v instanceof Date) return null;
  const rec = v as { formula?: unknown; sharedFormula?: unknown };
  if (typeof rec.formula === 'string' || typeof rec.sharedFormula === 'string') return rec;
  return null;
}

/** 区域读值：单行或单列区域逐格取值（多行多列报错）。
 *  texts 槽为文本侧（cellText：Date 转 ISO 日期串）——categories 与序列名消费；
 *  公式格（spec §14.6 P1b）取缓存 result：string 用之否则 **null**（chart-xml
 *  buildStrCacheXml 对 null 省略 c:pt——对齐 spec 「该点 omit」文面，不再用空串
 *  占位造成 chart 渲染时把空串当合法分类）。
 *  numbers 槽为数值侧：number 用之；公式格 number result 用之、无缓存 result 该点
 *  null（omit c:pt）；numeric=true（series values 消费）时其余非数字值仍抛错且文案
 *  含 'sheet'!地址；numeric=false（lenient，缓存重算消费）时该点 null 不抛。 */
export function readRangeValues(
  wb: ExcelJS.Workbook,
  ref: SheetRangeRef,
  numeric = false,
): { texts: Array<string | null>; numbers: Array<number | null> } {
  const ws = wb.getWorksheet(ref.sheet);
  if (!ws) throw new Error(`sheet 不存在: ${ref.sheet}（须先 add_sheet）`);
  const r = parseRange(ref.range);
  const endRow = r.endRow ?? r.startRow;
  const endCol = r.endCol ?? r.startCol;
  if (endRow > r.startRow && endCol > r.startCol) {
    throw new Error(`引用区域必须是单行或单列: '${ref.sheet}'!${ref.range}`);
  }
  const horizontal = endCol > r.startCol;
  const count = horizontal ? endCol - r.startCol + 1 : endRow - r.startRow + 1;
  const texts: Array<string | null> = [];
  const numbers: Array<number | null> = [];
  for (let k = 0; k < count; k++) {
    const row = horizontal ? r.startRow : r.startRow + k;
    const col = horizontal ? r.startCol + k : r.startCol;
    const cell = ws.getCell(row, col);
    const v = cell.value;
    const formula = asFormulaCell(v);
    if (formula !== null) {
      texts.push(typeof formula.result === 'string' ? formula.result : null);
      numbers.push(typeof formula.result === 'number' ? formula.result : null);
    } else {
      texts.push(cellText(v));
      if (typeof v === 'number') {
        numbers.push(v);
      } else if (numeric) {
        throw new Error(`'${ref.sheet}'!${cell.address} 不是数字`);
      } else {
        numbers.push(null);
      }
    }
  }
  return { texts, numbers };
}

/** 组装单个 add_chart 的 ChartData（从内存 wb 读区域值——同批更早 set_cells 刚写入
 *  的值天然可见，即 op 顺序语义）。序列名三分支：单格引用 → nameRef+nameCache；
 *  字符串 → nameLiteral；缺省 → Series N 占位。 */
function buildChartData(wb: ExcelJS.Workbook, op: ChartOpSpec): ChartData {
  const cats = readRangeValues(wb, op.categories);
  const series: ChartSeriesData[] = op.series.map((s, si) => {
    const vals = readRangeValues(wb, s.values, true);
    const out: ChartSeriesData = {
      catRef: sheetAbsRef(op.categories.sheet, op.categories.range),
      catCache: cats.texts,
      valRef: sheetAbsRef(s.values.sheet, s.values.range),
      valCache: vals.numbers,
    };
    if (typeof s.name === 'string') {
      out.nameLiteral = s.name;
    } else if (s.name !== undefined) {
      out.nameRef = sheetAbsRef(s.name.sheet, s.name.range);
      // 公式无 result（readRangeValues 文本槽 null）→ undefined：chart-xml buildTxXml
      // 据此不发 strCache，对齐 spec §14.6 「该点 omit」——非公式格文本侧空串（cellText）
      // 仍照常作为合法序列名缓存。
      const firstName = readRangeValues(wb, s.name).texts[0];
      out.nameCache = firstName === null ? undefined : firstName;
    } else {
      out.nameLiteral = `Series ${si + 1}`;
    }
    return out;
  });
  return { type: op.type, title: op.title, series };
}

/** 增量写：原字节 → 内存变更 → 新字节（一次序列化）。
 *  add_chart 编排管线：snapshotChartParts（重写前快照）→ sanitizeXlsxForRead（P0 净化，
 *  否则 exceljs 遇 real-Excel 图表形态直接崩）→ exceljs 重写（图表侧全丢）→
 *  restoreChartParts 回注快照（既有图表保真）→ refreshChartCaches 缓存重算（P1a）→
 *  injectCharts 注入新图表。
 *  ⚠️ restoreChartParts 契约：仅限本函数的重写管线内重写后单次调用（T2 审查 Minor
 *  裁定），外部不得复用。同 sheet 多个 add_chart 合并为一次 injectCharts 调用（注入
 *  层支持数组批量，部件编号续接语义与逐次注入一致——择简实现）。 */
export async function writeXlsxOps(before: Buffer, ops: ExcelWriteOp[]): Promise<Buffer> {
  const snap = snapshotChartParts(before);
  const sanitized = sanitizeXlsxForRead(before).data;
  const wb = new ExcelJS.Workbook();
  // exceljs 类型层 Buffer extends ArrayBuffer，与 Node Buffer<ArrayBufferLike> 结构不兼容——断言为 ArrayBuffer，运行时字节布局一致
  await wb.xlsx.load(sanitized as unknown as ArrayBuffer);
  // 注入依赖 writeBuffer 产出的最终 workbook.xml（resolveSheetFile 按 sheet 名定位），
  // 故图表先按 sheet 收集、序列化后统一注入
  const chartsBySheet = new Map<string, Array<{ chartXml: string; anchorXml: string }>>();
  for (const op of ops) {
    if (op.op === 'add_sheet') {
      if (wb.getWorksheet(op.name)) throw new Error(`sheet 已存在: ${op.name}`);
      wb.addWorksheet(op.name);
      continue;
    }
    if (op.op === 'add_chart') {
      if (!wb.getWorksheet(op.sheet)) throw new Error(`sheet 不存在: ${op.sheet}（须先 add_sheet）`);
      const chartXml = buildChartXml(buildChartData(wb, op));
      // parse 已保证 anchor 单格（ends null）；1-based → 0-based，尺寸按 size 展开
      const a = parseRange(op.anchor);
      const anchorXml = buildAnchorXml(
        {
          fromCol: a.startCol - 1,
          fromRow: a.startRow - 1,
          toCol: a.startCol - 1 + op.size.cols - 1,
          toRow: a.startRow - 1 + op.size.rows - 1,
        },
        'rIdPLACE', // 占位：注入层无条件重指派为实际分配的 drawing-rels Id
        0,
      );
      const list = chartsBySheet.get(op.sheet);
      if (list === undefined) chartsBySheet.set(op.sheet, [{ chartXml, anchorXml }]);
      else list.push({ chartXml, anchorXml });
      continue;
    }
    const ws = wb.getWorksheet(op.sheet);
    if (!ws) throw new Error(`sheet 不存在: ${op.sheet}（须先 add_sheet）`);
    const r =
      op.range === undefined
        ? { startRow: 1, startCol: 1, endRow: null, endCol: null }
        : parseRange(op.range);
    const startRow = r.startRow;
    const startCol = r.startCol;
    const maxLen = op.values.reduce((m, row) => Math.max(m, row.length), 0);
    let endRow = r.endRow;
    let endCol = r.endCol;
    if (endRow === null || endCol === null) {
      endRow = startRow + op.values.length - 1;
      endCol = startCol + maxLen - 1;
    } else if (endRow - startRow + 1 !== op.values.length || endCol - startCol + 1 !== maxLen) {
      throw new Error(
        `range 与 values 形状不一致：range 为 ${endRow - startRow + 1}×${endCol - startCol + 1}，values 为 ${op.values.length}×${maxLen}`,
      );
    }
    for (const [ri, row] of op.values.entries()) {
      for (const [ci, val] of row.entries()) {
        const cell = ws.getCell(startRow + ri, startCol + ci);
        if (val !== null && typeof val === 'object') {
          cell.value = { formula: val.formula };
        } else {
          cell.value = val;
        }
      }
    }
  }
  // 显式宽类型：exceljs Buffer.from 产物是 Buffer<Buffer>，restore/inject 返回
  // Buffer<ArrayBufferLike>——裸 Buffer（= ArrayBufferLike）两者皆可赋值
  let out: Buffer = Buffer.from(await wb.xlsx.writeBuffer());
  out = restoreChartParts(out, snap);
  // P1a（spec §14.6）：全部既有图表缓存重算——按 chart XML 的 c:f 引用从内存 wb
  // （已应用本批 ops）重读区域值重建 numCache/strCache，消灭「改数后缓存陈旧」。
  // 置于 injectCharts 之前：新注入图表缓存在 add_chart 时点已同源正确，无需重算。
  // readRef 失败（sheet 不存在 / 区域非法多行多列）返回 null → 该引用保持原缓存。
  out = refreshChartCaches(out, (ref) => {
    try {
      return readRangeValues(wb, ref);
    } catch {
      return null;
    }
  });
  for (const [sheetName, charts] of chartsBySheet) {
    const sheetFile = resolveSheetFile(new AdmZip(out), sheetName);
    if (sheetFile === null) throw new Error(`sheet 不存在: ${sheetName}`);
    out = injectCharts(out, sheetFile, charts);
  }
  return out;
}
