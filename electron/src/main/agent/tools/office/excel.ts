// Excel 读写封装（exceljs）。读取两档：sheet 预览（office_read）与区域精读
// （office_read_cells）；写路径 createXlsx / writeXlsxOps 返回 Buffer，落盘与
// 记账由 office-tools 统一处理（write-ahead：先记账后写盘）。
// 公式注意：exceljs 不计算公式——读取公式的 result 仅取文件内缓存值（写入侧
// 新写的公式无缓存，显示空），需要精确计算时由 agent 在上下文中完成运算。

import ExcelJS from 'exceljs';
import { parseRange } from './format';

export const PREVIEW_ROWS = 20;
export const PREVIEW_COLS = 12;
export const MAX_READ_ROWS = 500;
export const MAX_READ_COLS = 64;

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
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(abs);
  const parts: string[] = [];
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
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(abs);
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
