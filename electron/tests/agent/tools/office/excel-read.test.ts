// excel 读取链路单测：readXlsxPreview / readXlsxCells / cellText。
// 真实 exceljs 造文件 → 真实读取断言（不 mock 库）：
// 「方便测试」的 mock 简化 = 漏掉库类型/行为契约——本套件要求库行为真实。
// 覆盖：维度预览 + 空表标注 / 默认已用区域 + 表头 / A1 精读 / 公式默认空 +
// formulas=true 显示原文 / sheet 不存在报错 / 超 500 行上限报错。

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import ExcelJS from 'exceljs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readXlsxPreview, readXlsxCells } from '../../../../src/main/agent/tools/office/excel';

let tmpDir: string;
let abs: string;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-xlsx-read-'));
  abs = path.join(tmpDir, 'data.xlsx');
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('销售');
  ws.addRow(['日期', '地区', '金额']);
  ws.addRow(['2026-01-01', '华东', 100]);
  ws.addRow(['2026-01-02', '华北', 200]);
  const ws2 = wb.addWorksheet('空表');
  const fws = wb.addWorksheet('公式');
  fws.getCell('A1').value = 1;
  fws.getCell('A2').value = 2;
  fws.getCell('A3').value = { formula: 'SUM(A1:A2)' }; // 无缓存 result
  await wb.xlsx.writeFile(abs);
});

afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

describe('readXlsxPreview', () => {
  it('逐 sheet 输出维度与预览，空 sheet 标注', async () => {
    const out = await readXlsxPreview(abs);
    expect(out).toContain('## Sheet: 销售 (3×3)');
    expect(out).toContain('2026-01-01');
    expect(out).toContain('## Sheet: 空表');
    expect(out).toContain('(空 sheet)');
  });
});

describe('readXlsxCells', () => {
  it('默认已用区域，首行为表头（markdown 表格）', async () => {
    const out = await readXlsxCells(abs, '销售');
    expect(out).toContain('| 日期 | 地区 | 金额 |');
    expect(out).toContain('| 2026-01-02 | 华北 | 200 |');
  });
  it('range 精读 + sheet 序号定位', async () => {
    const out = await readXlsxCells(abs, 1, 'A1:B2');
    expect(out).toContain('| 日期 | 地区 |');
    expect(out).not.toContain('华北');
  });
  it('公式默认显示缓存值（无缓存为空），formulas=true 显示原文', async () => {
    expect(await readXlsxCells(abs, '公式')).toContain('|  |'); // A3 无缓存 result
    expect(await readXlsxCells(abs, '公式', undefined, true)).toContain('=SUM(A1:A2)');
  });
  it('sheet 不存在报错', async () => {
    await expect(readXlsxCells(abs, '不存在')).rejects.toThrow(/sheet 不存在/);
  });
  it('超过 500 行上限报错并说明上限', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('大表');
    for (let i = 0; i < 501; i++) ws.addRow([i]);
    const bigAbs = path.join(tmpDir, 'big.xlsx');
    await wb.xlsx.writeFile(bigAbs);
    await expect(readXlsxCells(bigAbs, '大表')).rejects.toThrow(/500/);
  });
});

describe('cellText 分支契约（Date/richText/hyperlink）', () => {
  it('Date 单元格显示 ISO 日期', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('日期');
    ws.getCell('A1').value = new Date(Date.UTC(2026, 0, 15));
    const abs2 = path.join(tmpDir, 'date.xlsx');
    await wb.xlsx.writeFile(abs2);
    const out = await readXlsxCells(abs2, '日期');
    expect(out).toContain('2026-01-15');
  });
  it('richText 拼接显示', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('富文本');
    ws.getCell('A1').value = { richText: [{ text: '加粗' }, { text: '普通' }] } as ExcelJS.CellValue;
    const abs2 = path.join(tmpDir, 'rich.xlsx');
    await wb.xlsx.writeFile(abs2);
    const out = await readXlsxCells(abs2, '富文本');
    expect(out).toContain('加粗普通');
  });
});
