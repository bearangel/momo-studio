// excel 写链路单测：createXlsx / writeXlsxOps / parseSheetInits / parseExcelWriteOps。
// 真实 exceljs 造文件 → 真实写入 → 真实读取断言（不 mock 库）：
// 「方便测试」的 mock 简化 = 漏掉库类型/行为契约——本套件要求库行为真实。
// 覆盖：骨架创建 + 列头 / 缺省 Sheet1 / sheet 名查重 / add_sheet + set_cells 值与公式
// round-trip / 左上角单格按 values 形状展开 / 完整区域形状不一致报错 / 不存在的 sheet
// 报错 / 非法 op 拒绝。

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import ExcelJS from 'exceljs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createXlsx, writeXlsxOps, parseSheetInits, parseExcelWriteOps,
} from '../../../../src/main/agent/tools/office/excel';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-xlsx-write-'));
});
afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

async function readBack(abs: string): Promise<ExcelJS.Worksheet> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(abs);
  return wb.worksheets[0]!;
}

describe('createXlsx', () => {
  it('建骨架 + 列头，落盘可被 exceljs 重读', async () => {
    const buf = await createXlsx(parseSheetInits([{ name: '汇总', headers: ['月份', '金额'] }]));
    expect(buf.subarray(0, 2)).toEqual(Buffer.from([0x50, 0x4b])); // zip 魔数
    const abs = path.join(tmpDir, 'a.xlsx');
    fs.writeFileSync(abs, buf);
    const ws = await readBack(abs);
    expect(ws.name).toBe('汇总');
    expect(ws.getCell('A1').value).toBe('月份');
  });
  it('缺省建 Sheet1', async () => {
    const buf = await createXlsx(parseSheetInits(undefined));
    const abs = path.join(tmpDir, 'b.xlsx');
    fs.writeFileSync(abs, buf);
    expect((await readBack(abs)).name).toBe('Sheet1');
  });
  it('sheet 名查重', () => {
    expect(() => parseSheetInits([{ name: 'x' }, { name: 'x' }])).toThrow(/重名/);
  });
});

describe('writeXlsxOps', () => {
  it('add_sheet + set_cells 值与公式 round-trip', async () => {
    const abs = path.join(tmpDir, 'c.xlsx');
    fs.writeFileSync(abs, await createXlsx(parseSheetInits([{ name: '原始' }])));
    const ops = parseExcelWriteOps([
      { op: 'add_sheet', name: '汇总' },
      { op: 'set_cells', sheet: '汇总', range: 'A1', values: [['月', '额'], ['1月', { formula: 'SUM(原始!A:A)' }]] },
    ]);
    const out = await writeXlsxOps(fs.readFileSync(abs), ops);
    fs.writeFileSync(abs, out);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(abs);
    const ws = wb.getWorksheet('汇总')!;
    expect(ws.getCell('A1').value).toBe('月');
    expect(ws.getCell('B2').value).toMatchObject({ formula: 'SUM(原始!A:A)' });
  });
  it('左上角单格按 values 形状展开', async () => {
    const abs = path.join(tmpDir, 'd.xlsx');
    fs.writeFileSync(abs, await createXlsx(parseSheetInits(undefined)));
    const out = await writeXlsxOps(
      fs.readFileSync(abs),
      parseExcelWriteOps([{ op: 'set_cells', sheet: 'Sheet1', range: 'B2', values: [[1, 2], [3, 4]] }]),
    );
    fs.writeFileSync(abs, out);
    const ws = await readBack(abs);
    expect(ws.getCell('B2').value).toBe(1);
    expect(ws.getCell('C3').value).toBe(4);
  });
  it('完整区域形状不匹配报错', async () => {
    const abs = path.join(tmpDir, 'e.xlsx');
    fs.writeFileSync(abs, await createXlsx(parseSheetInits(undefined)));
    await expect(
      writeXlsxOps(
        fs.readFileSync(abs),
        parseExcelWriteOps([{ op: 'set_cells', sheet: 'Sheet1', range: 'A1:B3', values: [[1]] }]),
      ),
    ).rejects.toThrow(/形状不一致/);
  });
  it('set_cells 到不存在的 sheet 报错（须显式 add_sheet）', async () => {
    const abs = path.join(tmpDir, 'f.xlsx');
    fs.writeFileSync(abs, await createXlsx(parseSheetInits(undefined)));
    await expect(
      writeXlsxOps(
        fs.readFileSync(abs),
        parseExcelWriteOps([{ op: 'set_cells', sheet: '没有', values: [[1]] }]),
      ),
    ).rejects.toThrow(/add_sheet/);
  });
  it('非法 op 结构拒绝', () => {
    expect(() => parseExcelWriteOps([{ op: 'del_sheet', name: 'x' }])).toThrow(/op/);
    expect(() => parseExcelWriteOps('不是数组')).toThrow();
  });
});
