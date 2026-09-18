// 办公工具组共享：扩展名嗅探、A1 range 解析、参数窄化原语。

import path from 'node:path';

export type OfficeFormat = 'xlsx' | 'docx' | 'pptx' | 'pdf';

/** 按文件名扩展名嗅探格式；不支持（含旧二进制 .xls/.doc/.ppt）返回 null */
export function detectOfficeFormat(fileName: string): OfficeFormat | null {
  const ext = path.extname(fileName).toLowerCase().replace('.', '');
  if (ext === 'xlsx') return 'xlsx';
  if (ext === 'docx') return 'docx';
  if (ext === 'pptx') return 'pptx';
  if (ext === 'pdf') return 'pdf';
  return null;
}

/** 断言支持格式；旧格式给出「另存为新格式」指引 */
export function assertOfficeFormat(fileName: string): OfficeFormat {
  const fmt = detectOfficeFormat(fileName);
  if (fmt !== null) return fmt;
  const ext = path.extname(fileName).toLowerCase().replace('.', '');
  if (ext === 'xls' || ext === 'doc' || ext === 'ppt') {
    throw new Error(`不支持旧格式 .${ext}——请先在 Office/WPS 中另存为 .${ext}x 新格式`);
  }
  throw new Error(`不支持的文档格式: ${fileName}（支持 xlsx / docx / pptx / pdf）`);
}

/** 列字母 → 1-based 列号（A=1, Z=26, AA=27） */
export function colToIndex(letters: string): number {
  if (letters.length === 0) throw new Error('非法列字母: (空串)');
  let n = 0;
  for (const ch of letters.toUpperCase()) {
    const code = ch.charCodeAt(0);
    if (code < 65 || code > 90) throw new Error(`非法列字母: ${letters}`);
    n = n * 26 + (code - 64);
  }
  return n;
}

export interface CellRange {
  startRow: number;
  startCol: number;
  /** null = 未给定终点（调用方按数据形状展开） */
  endRow: number | null;
  endCol: number | null;
}

const RANGE_RE = /^\$?([A-Za-z]{1,3})\$?([1-9][0-9]{0,6})(?::\$?([A-Za-z]{1,3})\$?([1-9][0-9]{0,6}))?$/;

/** A1 记法解析：'A1'（ends null）或 'A1:F50'（ends 有值，保证 start<=end） */
export function parseRange(range: string): CellRange {
  const m = RANGE_RE.exec(range.trim());
  if (!m) throw new Error(`非法 range: "${range}"（示例：A1 或 A1:F50）`);
  const startCol = colToIndex(m[1]!);
  const startRow = Number(m[2]!);
  const endCol = m[3] !== undefined ? colToIndex(m[3]) : null;
  const endRow = m[4] !== undefined ? Number(m[4]) : null;
  if (endCol !== null && endRow !== null && (endRow < startRow || endCol < startCol)) {
    throw new Error(`非法 range: "${range}"（终点必须不小于起点）`);
  }
  return { startRow, startCol, endRow, endCol };
}

/** 窄化原语：非空字符串或抛错（中文错误含字段名） */
export function asString(v: unknown, what: string): string {
  if (typeof v !== 'string' || v.length === 0) {
    throw new Error(`参数 ${what} 缺失或不是非空字符串`);
  }
  return v;
}

/** 窄化原语：字符串数组或抛错（逐元素报字段下标） */
export function asStringArray(v: unknown, what: string): string[] {
  if (!Array.isArray(v)) throw new Error(`参数 ${what} 缺失或不是数组`);
  return v.map((x, i) => asString(x, `${what}[${i}]`));
}
