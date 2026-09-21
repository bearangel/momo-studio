// excel.ts add_chart 编排单测（Task 3）：parseExcelWriteOps 第三型分支 + writeXlsxOps
// 快照-净化-重写-回注-注入全链路。全程真实操作（不 mock 库）：createXlsx 造底 →
// writeXlsxOps → adm-zip 解包断言 chart/drawing/rels 部件内容。
// 覆盖 brief 5 用例：bar round-trip（c:f 引用 + numCache + 注入 sheet 映射）/
// 四型节点 / 保真红线（P0 fixture 原部件字节不变）/ 错误路径（pie 多序列 / series 空 /
// values 含文本含地址 / anchor 区域 / sheet 不存在）/ 顺序语义（同批 set_cells 先写后图）。

import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import AdmZip from 'adm-zip';
import {
  createXlsx,
  writeXlsxOps,
  parseSheetInits,
  parseExcelWriteOps,
} from '../../../../src/main/agent/tools/office/excel';
import { makeBaseXlsxBuffer, injectP0ChartDrawing } from './xlsx-chart-fixture';

/** 读取 zip 内某部件全文；缺失即抛（fixture/实现坏了要让测试大声失败） */
function readText(buf: Buffer, name: string): string {
  const zip = new AdmZip(buf);
  const entry = zip.getEntry(name);
  if (!entry) throw new Error(`zip 缺少部件: ${name}`);
  return zip.readAsText(entry.entryName);
}

/** xl/charts/ 下全部 chart 部件名（排序后断言数量与编号） */
function chartPartNames(buf: Buffer): string[] {
  return new AdmZip(buf)
    .getEntries()
    .map((e) => e.entryName)
    .filter((n) => /^xl\/charts\/chart\d+\.xml$/.test(n))
    .sort();
}

/** exceljs 真实加载（产物结构合法性 + 数据完好断言用） */
async function loadXlsx(buf: Buffer): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  return wb;
}

/** 造「销售明细」底稿：表头 + 9 行月度数据（A2:A10 分类 / B2:B10 数值） */
async function makeMonthlyBase(): Promise<Buffer> {
  return createXlsx(parseSheetInits([{ name: '销售明细' }]));
}

type CellRow = Array<string | number>;

const MONTH_ROWS: CellRow[] = [
  ['月份', '金额'],
  ['1月', 120],
  ['2月', 135],
  ['3月', 148],
  ['4月', 152],
  ['5月', 160],
  ['6月', 171],
  ['7月', 168],
  ['8月', 180],
  ['9月', 195],
];

describe('add_chart：bar round-trip', () => {
  it('c:f 绝对引用 + numCache/catCache/nameCache 与写入一致 + 注入到第二页签 sheet2', async () => {
    const out = await writeXlsxOps(
      await makeMonthlyBase(),
      parseExcelWriteOps([
        { op: 'set_cells', sheet: '销售明细', range: 'A1', values: MONTH_ROWS },
        { op: 'add_sheet', name: '汇总图表' },
        {
          op: 'add_chart',
          sheet: '汇总图表',
          type: 'bar',
          anchor: 'B2',
          size: { cols: 6, rows: 10 },
          title: '月度销售',
          categories: { sheet: '销售明细', range: 'A2:A10' },
          series: [
            {
              name: { sheet: '销售明细', range: 'B1' },
              values: { sheet: '销售明细', range: 'B2:B10' },
            },
          ],
        },
      ]),
    );

    // chart1 部件存在，c:f 三处绝对引用正确（sheetAbsRef：表名加引号 + 全绝对）
    const chart1 = readText(out, 'xl/charts/chart1.xml');
    expect(chart1).toContain(`<c:f>'销售明细'!$A$2:$A$10</c:f>`);
    expect(chart1).toContain(`<c:f>'销售明细'!$B$2:$B$10</c:f>`);
    expect(chart1).toContain(`<c:f>'销售明细'!$B$1</c:f>`);
    // catCache / numCache / nameCache 与 set_cells 写入数据一致
    expect(chart1).toContain('<c:ptCount val="9"/>');
    expect(chart1).toContain('<c:v>1月</c:v>');
    expect(chart1).toContain('<c:v>9月</c:v>');
    expect(chart1).toContain('<c:v>120</c:v>');
    expect(chart1).toContain('<c:v>195</c:v>');
    expect(chart1).toContain('<c:v>金额</c:v>');
    // 标题透传
    expect(chart1).toContain('<a:t>月度销售</a:t>');
    expect(chart1).toContain('<c:barDir val="col"/>');

    // 注入目标：resolveSheetFile 把「汇总图表」（第 2 个 sheet）映射到 sheet2.xml
    expect(readText(out, 'xl/worksheets/sheet2.xml')).toContain('<drawing r:id=');
    const sheet2Rels = readText(out, 'xl/worksheets/_rels/sheet2.xml.rels');
    expect(sheet2Rels).toContain('/drawing');
    expect(sheet2Rels).toContain('Target="../drawings/drawing1.xml"');
    // 数据页 sheet1 无 drawing（图表不在数据页）
    expect(readText(out, 'xl/worksheets/sheet1.xml')).not.toContain('<drawing ');
    // 锚点换算：B2（1-based 2,2）→ 0-based from(1,1)；size 6×10 → to(6,10)
    const drawing1 = readText(out, 'xl/drawings/drawing1.xml');
    expect(drawing1).toContain('<xdr:col>1</xdr:col>');
    expect(drawing1).toContain('<xdr:row>1</xdr:row>');
    expect(drawing1).toContain('<xdr:col>6</xdr:col>');
    expect(drawing1).toContain('<xdr:row>10</xdr:row>');
    // drawing rels 指向 chart1（占位 rid 已被注入层重指派）
    expect(readText(out, 'xl/drawings/_rels/drawing1.xml.rels')).toContain(
      'Target="../charts/chart1.xml"',
    );
    expect(drawing1).not.toContain('rIdPLACE');
    // 产物 exceljs 仍可读 + 数据完好
    const wb = await loadXlsx(out);
    expect(wb.getWorksheet('销售明细')?.getCell('B10').value).toBe(195);
  });
});

describe('add_chart：四型', () => {
  it('bar / bar_h / line / pie 各一 → 四个 chart 部件型别节点正确', async () => {
    const base = await makeMonthlyBase();
    const chartOp = (type: 'bar' | 'bar_h' | 'line' | 'pie', anchor: string) => ({
      op: 'add_chart' as const,
      sheet: '图表集',
      type,
      anchor,
      categories: { sheet: '销售明细', range: 'A2:A10' },
      series: [{ values: { sheet: '销售明细', range: 'B2:B10' } }],
    });
    const out = await writeXlsxOps(
      base,
      parseExcelWriteOps([
        { op: 'set_cells', sheet: '销售明细', range: 'A1', values: MONTH_ROWS },
        { op: 'add_sheet', name: '图表集' },
        chartOp('bar', 'A1'),
        chartOp('bar_h', 'J1'),
        chartOp('line', 'A20'),
        chartOp('pie', 'J20'),
      ]),
    );

    const names = chartPartNames(out);
    expect(names).toEqual([
      'xl/charts/chart1.xml',
      'xl/charts/chart2.xml',
      'xl/charts/chart3.xml',
      'xl/charts/chart4.xml',
    ]);
    // 注入顺序 = op 顺序：chart1 bar(col) / chart2 bar_h(bar) / chart3 line / chart4 pie
    expect(readText(out, 'xl/charts/chart1.xml')).toContain('<c:barChart>');
    expect(readText(out, 'xl/charts/chart1.xml')).toContain('<c:barDir val="col"/>');
    expect(readText(out, 'xl/charts/chart2.xml')).toContain('<c:barChart>');
    expect(readText(out, 'xl/charts/chart2.xml')).toContain('<c:barDir val="bar"/>');
    expect(readText(out, 'xl/charts/chart3.xml')).toContain('<c:lineChart>');
    expect(readText(out, 'xl/charts/chart4.xml')).toContain('<c:pieChart>');
    // 同 sheet 四图合一 drawing：4 个锚点 + 4 条 chart 关系
    const drawing1 = readText(out, 'xl/drawings/drawing1.xml');
    expect((drawing1.match(/<xdr:twoCellAnchor\b/g) ?? []).length).toBe(4);
    const drels = readText(out, 'xl/drawings/_rels/drawing1.xml.rels');
    expect((drels.match(/<Relationship\b/g) ?? []).length).toBe(4);
  });
});

describe('add_chart：保真红线（P0 chart fixture）', () => {
  it('原 chart1/chart2 与 drawing rels 字节不变；新图注入新页签；共 3 个 chart 部件', async () => {
    const orig = injectP0ChartDrawing(await makeBaseXlsxBuffer()); // 2 chart P0 形态（sheet1 销售）
    const out = await writeXlsxOps(
      orig,
      parseExcelWriteOps([
        { op: 'add_sheet', name: '汇总' },
        { op: 'set_cells', sheet: '汇总', range: 'A1', values: [['说明'], ['图表页']] },
        {
          op: 'add_chart',
          sheet: '汇总',
          type: 'line',
          anchor: 'A3',
          categories: { sheet: '销售', range: 'A2:A3' },
          series: [{ values: { sheet: '销售', range: 'C2:C3' } }],
        },
      ]),
    );

    // 部件计数：原 2 + 新 1 = 3
    expect(chartPartNames(out)).toHaveLength(3);

    // 原部件字节不变（快照回注保真）
    const zipOut = new AdmZip(out);
    const zipOrig = new AdmZip(orig);
    for (const part of [
      'xl/charts/chart1.xml',
      'xl/charts/chart2.xml',
      'xl/drawings/drawing1.xml',
      'xl/drawings/_rels/drawing1.xml.rels',
    ]) {
      const after = zipOut.getEntry(part)?.getData();
      const before = zipOrig.getEntry(part)?.getData();
      expect(after && before && after.equals(before)).toBe(true);
    }

    // 新图（chart3）注入「汇总」页签（第 2 sheet → sheet2 + 新 drawing2）
    expect(readText(out, 'xl/worksheets/sheet2.xml')).toContain('<drawing r:id=');
    expect(new AdmZip(out).getEntry('xl/drawings/drawing2.xml')).not.toBeNull();
    const chart3 = readText(out, 'xl/charts/chart3.xml');
    // 无 name 的序列 → Series 1 占位名（nameLiteral 路径）
    expect(chart3).toContain('<c:v>Series 1</c:v>');
    expect(chart3).toContain(`<c:f>'销售'!$A$2:$A$3</c:f>`);
    expect(chart3).toContain('<c:v>100</c:v>');
    expect(chart3).toContain('<c:v>200</c:v>');

    // 产物 exceljs 仍可读 + 原数据完好
    const wb = await loadXlsx(out);
    expect(wb.getWorksheet('销售')?.getCell('C3').value).toBe(200);
    expect(wb.getWorksheet('汇总')?.getCell('A2').value).toBe('图表页');
  });

  it('add_chart 到已有图表的 sheet（原 sheet，非新页签）→ 锚点合并入 drawing1 + 原 chart 字节不变 + sheet rels drawing 引用不变', async () => {
    const orig = injectP0ChartDrawing(await makeBaseXlsxBuffer()); // 2 chart + drawing1 已有 1 个 twoCellAnchor
    const out = await writeXlsxOps(
      orig,
      parseExcelWriteOps([
        {
          op: 'add_chart',
          sheet: '销售', // ← 原 sheet，非新页签
          type: 'pie',
          anchor: 'F10',
          categories: { sheet: '销售', range: 'A2:A3' },
          series: [{ values: { sheet: '销售', range: 'C2:C3' } }],
        },
      ]),
    );

    // 3 个 chart 部件：原 chart1/chart2 + 新 chart3
    expect(chartPartNames(out)).toEqual([
      'xl/charts/chart1.xml',
      'xl/charts/chart2.xml',
      'xl/charts/chart3.xml',
    ]);

    // 原 chart1/chart2.xml 字节不变
    const zipOut = new AdmZip(out);
    const zipOrig = new AdmZip(orig);
    for (const part of ['xl/charts/chart1.xml', 'xl/charts/chart2.xml']) {
      const after = zipOut.getEntry(part)?.getData();
      const before = zipOrig.getEntry(part)?.getData();
      expect(after && before && after.equals(before)).toBe(true);
    }

    // drawing1.xml：原 1 个 twoCellAnchor + 新 1 个 = 2 个（同一 drawing 合并模式）
    const drawing1 = readText(out, 'xl/drawings/drawing1.xml');
    expect((drawing1.match(/<xdr:twoCellAnchor\b/g) ?? []).length).toBe(2);
    // sheet rels 的 drawing 引用未变（仍指向 drawing1.xml）
    const sheetRels = readText(out, 'xl/worksheets/_rels/sheet1.xml.rels');
    expect(sheetRels).toContain('Target="../drawings/drawing1.xml"');
    // drawing rels 新增 chart3 引用（原 2 + 新 1 = 3）
    const drawingRels = readText(out, 'xl/drawings/_rels/drawing1.xml.rels');
    expect((drawingRels.match(/<Relationship\b/g) ?? []).length).toBe(3);
    expect(drawingRels).toContain('Target="../charts/chart3.xml"');

    // 产物 exceljs 仍可读 + 数据完好
    const wb = await loadXlsx(out);
    expect(wb.getWorksheet('销售')?.getCell('C3').value).toBe(200);
  });
});

describe('add_chart：错误路径', () => {
  it('pie 多序列 / series 空 / anchor 区域 / type 非法 / size 非正整数 / name 非法 / categories 缺 sheet —— parse 期拒绝', () => {
    const chart = (over: Record<string, unknown>) => ({
      op: 'add_chart',
      sheet: '汇总图表',
      anchor: 'B2',
      categories: { sheet: '销售明细', range: 'A2:A4' },
      series: [{ values: { sheet: '销售明细', range: 'B2:B4' } }],
      ...over,
    });
    expect(() =>
      parseExcelWriteOps([
        chart({
          type: 'pie',
          series: [
            { values: { sheet: '销售明细', range: 'B2:B4' } },
            { values: { sheet: '销售明细', range: 'C2:C4' } },
          ],
        }),
      ]),
    ).toThrow(/pie 图仅支持 1 个序列/);
    expect(() => parseExcelWriteOps([chart({ type: 'bar', series: [] })])).toThrow(/series/);
    expect(() => parseExcelWriteOps([chart({ type: 'bar', anchor: 'A1:B2' })])).toThrow(
      /单格左上角/,
    );
    expect(() => parseExcelWriteOps([chart({ type: 'scatter' })])).toThrow(/type/);
    expect(() => parseExcelWriteOps([chart({ type: 'bar', size: { cols: 0 } })])).toThrow(
      /正整数/,
    );
    expect(() =>
      parseExcelWriteOps([chart({ type: 'bar', series: [{ name: 42, values: { sheet: '销售明细', range: 'B2:B4' } }] })]),
    ).toThrow(/name/);
    expect(() =>
      parseExcelWriteOps([chart({ type: 'bar', categories: { range: 'A2:A4' } })]),
    ).toThrow(/categories\.sheet/);
    expect(() =>
      parseExcelWriteOps([
        chart({
          type: 'bar',
          series: [{ name: { sheet: '销售明细', range: 'B1:B2' }, values: { sheet: '销售明细', range: 'B2:B4' } }],
        }),
      ]),
    ).toThrow(/name 引用必须是单格/);
  });

  it('values 区域含文本 → 运行期报错文案含单元格地址', async () => {
    const base = await writeXlsxOps(
      await makeMonthlyBase(),
      parseExcelWriteOps([
        {
          op: 'set_cells',
          sheet: '销售明细',
          range: 'A1',
          values: [
            ['月份', '金额'],
            ['1月', 10],
            ['2月', '缺数'],
            ['3月', 30],
          ],
        },
      ]),
    );
    await expect(
      writeXlsxOps(
        base,
        parseExcelWriteOps([
          { op: 'add_sheet', name: '汇总图表' },
          {
            op: 'add_chart',
            sheet: '汇总图表',
            type: 'bar',
            anchor: 'B2',
            categories: { sheet: '销售明细', range: 'A2:A4' },
            series: [{ values: { sheet: '销售明细', range: 'B2:B4' } }],
          },
        ]),
      ),
    ).rejects.toThrow(/'销售明细'!B3 不是数字/);
  });

  it('图表目标 sheet 不存在 → 沿用 add_sheet 指引文案', async () => {
    await expect(
      writeXlsxOps(
        await makeMonthlyBase(),
        parseExcelWriteOps([
          {
            op: 'add_chart',
            sheet: '没有这个页签',
            type: 'bar',
            anchor: 'B2',
            categories: { sheet: '销售明细', range: 'A2:A4' },
            series: [{ values: { sheet: '销售明细', range: 'B2:B4' } }],
          },
        ]),
      ),
    ).rejects.toThrow(/sheet 不存在.*add_sheet/);
  });
});

describe('add_chart：顺序语义', () => {
  it('同批 set_cells 先写数据 + add_chart 引用刚写入区域 → 缓存取到新值；锚点缺省尺寸 8×15', async () => {
    const out = await writeXlsxOps(
      await makeMonthlyBase(),
      parseExcelWriteOps([
        {
          op: 'set_cells',
          sheet: '销售明细',
          range: 'A1',
          values: [
            ['月份', '金额'],
            ['1月', 10],
            ['2月', 20],
            ['3月', 30],
          ],
        },
        {
          op: 'add_chart',
          sheet: '销售明细',
          type: 'bar',
          anchor: 'D2',
          categories: { sheet: '销售明细', range: 'A2:A4' },
          series: [{ values: { sheet: '销售明细', range: 'B2:B4' } }],
        },
      ]),
    );

    const chart1 = readText(out, 'xl/charts/chart1.xml');
    // numCache / catCache 取到同批刚写入的值（不是底稿的空单元格）
    expect(chart1).toContain('<c:v>10</c:v>');
    expect(chart1).toContain('<c:v>20</c:v>');
    expect(chart1).toContain('<c:v>30</c:v>');
    expect(chart1).toContain('<c:v>1月</c:v>');
    expect(chart1).toContain('<c:v>3月</c:v>');
    expect(chart1).toContain('<c:ptCount val="3"/>');
    // 注入到既有 sheet1（无 add_sheet 场景）+ 缺省尺寸：D2 → from(3,1)，8×15 → to(10,15)
    expect(readText(out, 'xl/worksheets/sheet1.xml')).toContain('<drawing r:id=');
    const drawing1 = readText(out, 'xl/drawings/drawing1.xml');
    expect(drawing1).toContain('<xdr:col>3</xdr:col>');
    expect(drawing1).toContain('<xdr:col>10</xdr:col>');
    expect(drawing1).toContain('<xdr:row>15</xdr:row>');
  });
});
