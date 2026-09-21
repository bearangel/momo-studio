// Excel 读写封装（exceljs）。读取两档：sheet 预览（office_read）与区域精读
// （office_read_cells）；写路径 createXlsx / writeXlsxOps 返回 Buffer，落盘与
// 记账由 office-tools 统一处理（write-ahead：先记账后写盘）。
// 公式注意：exceljs 不计算公式——读取公式的 result 仅取文件内缓存值（写入侧
// 新写的公式无缓存，显示空），需要精确计算时由 agent 在上下文中完成运算。
// 读图表隔离：sanitizeXlsxForRead 读前净化内存副本（剥离 drawings/charts/media
// 部件 + sheet rels 过滤 drawing 条目 + sheet XML 剥 <drawing/> 标签），
// 解决 exceljs 解析 real-Excel 形态 xdr:graphicFrame / unsupported anchor
// 类型崩溃的问题（P0 read-fix）。

import ExcelJS from 'exceljs';
import AdmZip from 'adm-zip';
import fs from 'node:fs';
import { parseRange, asString, asStringArray } from './format';

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

export type ExcelWriteOp =
  | { op: 'add_sheet'; name: string }
  | { op: 'set_cells'; sheet: string; range?: string; values: CellInput[][] };

function parseCellInput(v: unknown, what: string): CellInput {
  if (v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
    return v;
  }
  if (typeof v === 'object' && typeof (v as Record<string, unknown>).formula === 'string') {
    return { formula: (v as Record<string, unknown>).formula as string };
  }
  throw new Error(`参数 ${what} 不是合法单元格值（string/number/boolean/null/{formula}）`);
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
    throw new Error(`ops[${i}].op 非法（支持 add_sheet / set_cells）`);
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

/** 增量写：原字节 → 内存变更 → 新字节（一次序列化） */
export async function writeXlsxOps(before: Buffer, ops: ExcelWriteOp[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  // exceljs 类型层 Buffer extends ArrayBuffer，与 Node Buffer<ArrayBufferLike> 结构不兼容——断言为 ArrayBuffer，运行时字节布局一致
  await wb.xlsx.load(before as unknown as ArrayBuffer);
  for (const op of ops) {
    if (op.op === 'add_sheet') {
      if (wb.getWorksheet(op.name)) throw new Error(`sheet 已存在: ${op.name}`);
      wb.addWorksheet(op.name);
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
  return Buffer.from(await wb.xlsx.writeBuffer());
}
