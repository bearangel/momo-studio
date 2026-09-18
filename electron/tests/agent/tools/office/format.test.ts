// 办公工具组共享原语单测：格式嗅探 / A1 range 解析 / 参数窄化。
// 这些函数是后续 parseXlsx / parseDocx / parsePptx / parsePdf 的依赖项。

import { describe, it, expect } from 'vitest';
import {
  detectOfficeFormat, assertOfficeFormat, parseRange, colToIndex, asString, asStringArray,
} from '../../../../src/main/agent/tools/office/format';

describe('detectOfficeFormat', () => {
  it('四格式大小写不敏感识别', () => {
    expect(detectOfficeFormat('a.XLSX')).toBe('xlsx');
    expect(detectOfficeFormat('b.Docx')).toBe('docx');
    expect(detectOfficeFormat('c.pptx')).toBe('pptx');
    expect(detectOfficeFormat('d.pdf')).toBe('pdf');
  });
  it('旧格式与其他扩展名返回 null', () => {
    expect(detectOfficeFormat('old.xls')).toBeNull();
    expect(detectOfficeFormat('old.doc')).toBeNull();
    expect(detectOfficeFormat('old.ppt')).toBeNull();
    expect(detectOfficeFormat('a.txt')).toBeNull();
  });
});

describe('assertOfficeFormat', () => {
  it('旧格式报错并提示另存新格式', () => {
    expect(() => assertOfficeFormat('x.xls')).toThrow(/另存/);
  });
  it('支持格式原样通过', () => {
    expect(assertOfficeFormat('x.xlsx')).toBe('xlsx');
  });
  it('非 Office 扩展名报「不支持的文档格式」', () => {
    expect(() => assertOfficeFormat('a.txt')).toThrow(/不支持的文档格式/);
  });
});

describe('parseRange', () => {
  it('单格：ends 为 null（按 values 形状展开）', () => {
    expect(parseRange('A1')).toEqual({ startRow: 1, startCol: 1, endRow: null, endCol: null });
    expect(parseRange('b3')).toEqual({ startRow: 3, startCol: 2, endRow: null, endCol: null });
  });
  it('完整区域', () => {
    expect(parseRange('A1:F50')).toEqual({ startRow: 1, startCol: 1, endRow: 50, endCol: 6 });
    expect(parseRange('aa10:AB12')).toEqual({ startRow: 10, startCol: 27, endRow: 12, endCol: 28 });
  });
  it('非法输入全部拒绝', () => {
    for (const bad of ['1A', 'A0', 'C2:A1', '5', 'A1:B0', 'A:', '', 'A1:B2C']) {
      expect(() => parseRange(bad), `range=${bad}`).toThrow();
    }
  });
});

describe('colToIndex', () => {
  it('字母转列号', () => {
    expect(colToIndex('A')).toBe(1);
    expect(colToIndex('Z')).toBe(26);
    expect(colToIndex('AA')).toBe(27);
  });
  it('非法字母拒绝', () => {
    expect(() => colToIndex('A1')).toThrow(/非法列字母/);
  });
  it('colToIndex 空串拒绝', () => {
    expect(() => colToIndex('')).toThrow(/非法列字母/);
  });
});

describe('参数窄化原语', () => {
  it('asString 拒绝非字符串与空串', () => {
    expect(asString('ok', 'path')).toBe('ok');
    expect(() => asString(1, 'path')).toThrow(/path/);
    expect(() => asString('', 'path')).toThrow(/path/);
  });
  it('asStringArray 逐元素校验', () => {
    expect(asStringArray(['a', 'b'], 'items')).toEqual(['a', 'b']);
    expect(() => asStringArray(['a', 1], 'items')).toThrow(/items\[1\]/);
  });
});
