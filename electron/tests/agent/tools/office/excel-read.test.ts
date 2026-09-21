// excel 读取链路单测：readXlsxPreview / readXlsxCells / cellText / sanitizeXlsxForRead。
// 真实 exceljs 造文件 → 真实读取断言（不 mock 库）：
// 「方便测试」的 mock 简化 = 漏掉库类型/行为契约——本套件要求库行为真实。
// 覆盖：维度预览 + 空表标注 / 默认已用区域 + 表头 / A1 精读 / 公式默认空 +
// formulas=true 显示原文 / sheet 不存在报错 / 超 500 行上限报错。
// 附加：带图表/图片的 xlsx（P0 回归）—— exceljs 解析 drawing 会因 unsupported 锚点
// 类型（xdr:graphicFrame 等真实 Excel/wps/openpyxl 写法）崩溃，故读前需 sanitize
// 剥离 xl/drawings/ + xl/charts/ + xl/media/ 部件、sheet rels 过滤 drawing 条目（保留
// hyperlink 等）、sheet XML 剥 <drawing/> 标签。preview 头部追加图表存在提示。

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import ExcelJS from 'exceljs';
import AdmZip from 'adm-zip';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  readXlsxPreview,
  readXlsxCells,
  sanitizeXlsxForRead,
} from '../../../../src/main/agent/tools/office/excel';
// P0 形态 drawing/chart 注入 fixture 已抽公共 helper（xlsx-zip.test.ts 共用，防两份副本漂移）
import { makeBaseXlsxBuffer, injectP0ChartDrawing, withChartXml, richChartXml } from './xlsx-chart-fixture';

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
  wb.addWorksheet('空表');
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

// ────────────────────────────────────────────────────────────────────────────
// P0 回归：带图表/图片的 xlsx（P0 read-fix）
// 真实 Excel / WPS / openpyxl 输出的 xlsx 含 xl/drawings/ + xl/charts/ 部件，
// drawing.xml 用 xdr:graphicFrame 锚点（图表）、xdr:pic（图片）。exceljs 只识别
// xdr:twoCellAnchor / xdr:oneCellAnchor + xdr:pic，无法解析 graphicFrame 形态，
// 真实报错：「Cannot read properties of undefined (reading 'anchors')」或
// 「unexpected close tag」。同事流转的报表几乎必带图表，故读前需 sanitize。
// ────────────────────────────────────────────────────────────────────────────

/** 写一份含图表/链接的 xlsx fixture 到 tmpDir，返回绝对路径 */
async function makeChartFixture(dir: string, name = 'chart.xlsx'): Promise<string> {
  const withCharts = path.join(dir, name);
  fs.writeFileSync(withCharts, injectP0ChartDrawing(await makeBaseXlsxBuffer()));
  return withCharts;
}

describe('P0 read-fix：带图表/图片的 xlsx', () => {
  it('readXlsxPreview 成功读取含图表 xlsx，并提示文件含 2 个图表', async () => {
    const abs = await makeChartFixture(tmpDir);
    const out = await readXlsxPreview(abs);
    // 数据仍读出
    expect(out).toContain('## Sheet: 销售 (3×3)');
    expect(out).toContain('2026-01-02');
    // 头部追加图表存在提示（位于首个 sheet 节之前）
    const chartHintIdx = out.indexOf('文件含 2 个图表');
    const sheetIdx = out.indexOf('## Sheet:');
    expect(chartHintIdx).toBeGreaterThanOrEqual(0);
    expect(chartHintIdx).toBeLessThan(sheetIdx);
  });

  it('readXlsxCells 成功取数（不阻塞业务）', async () => {
    const abs = await makeChartFixture(tmpDir);
    const out = await readXlsxCells(abs, '销售');
    expect(out).toContain('| 日期 | 地区 | 金额 |');
    expect(out).toContain('| 2026-01-01 | 华东 | 100 |');
  });
});

describe('sanitizeXlsxForRead', () => {
  it('剥离 drawings/charts/media 部件；chartCount 准确；sheet rels 仅留 hyperlink；<drawing/> 标签被剥；原入参 buf 字节不变', async () => {
    const abs = await makeChartFixture(tmpDir, 'for-sanitize.xlsx');
    const original = fs.readFileSync(abs);
    const originalHash = createHash('sha256').update(original).digest('hex');
    const originalSnapshot = new AdmZip(original).getEntries().map((e) => e.entryName).sort();

    const { data, chartCount } = sanitizeXlsxForRead(original);

    expect(chartCount).toBe(2);
    const sanitized = new AdmZip(data);
    const sanitizedEntries = sanitized.getEntries().map((e) => e.entryName).sort();

    // 1. drawings/charts/media 部件被剥
    expect(sanitizedEntries).not.toContain('xl/drawings/drawing1.xml');
    expect(sanitizedEntries).not.toContain('xl/drawings/_rels/drawing1.xml.rels');
    expect(sanitizedEntries).not.toContain('xl/charts/chart1.xml');
    expect(sanitizedEntries).not.toContain('xl/charts/chart2.xml');

    // 2. sheet rels 仅留 hyperlink（drawing 条目被过滤）
    const relsXml = sanitized.readAsText('xl/worksheets/_rels/sheet1.xml.rels');
    expect(relsXml).toContain('Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink"');
    expect(relsXml).not.toContain('/drawing');

    // 3. sheet XML 中 <drawing/> 标签被剥
    const sheetXml = sanitized.readAsText('xl/worksheets/sheet1.xml');
    expect(sheetXml).not.toContain('<drawing');

    // 4. 原 buf 字节不变（深拷贝验证：再次 zip 原 buf 部件清单一致）
    const afterHash = createHash('sha256').update(original).digest('hex');
    expect(afterHash).toBe(originalHash);
    const originalSnapshotAfter = new AdmZip(original).getEntries().map((e) => e.entryName).sort();
    expect(originalSnapshotAfter).toEqual(originalSnapshot);
  });

  it('rels 过滤后无 hyperlink 时删除该 rels 文件', () => {
    // 构造一个仅含 drawing 条目的 sheet rels
    const zip = new AdmZip();
    zip.addFile(
      'xl/worksheets/_rels/sheet1.xml.rels',
      Buffer.from(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
          `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
          `<Relationship Id="rIdD" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/>` +
          `</Relationships>`,
      ),
    );
    const { data } = sanitizeXlsxForRead(zip.toBuffer());
    const out = new AdmZip(data).getEntries().map((e) => e.entryName);
    expect(out).not.toContain('xl/worksheets/_rels/sheet1.xml.rels');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// R4（spec §14.8-4）：office_read 图表摘要——预览头部逐图一行（类型/标题/引用）
// ────────────────────────────────────────────────────────────────────────────

/** 2 图 fixture（bar + pie，带标题与 cat/val 引用）；prefixed=false 输出 openpyxl 无前缀形态 */
async function makeRichChartFixture(dir: string, name: string, prefixed: boolean): Promise<string> {
  const target = path.join(dir, name);
  let buf = injectP0ChartDrawing(await makeBaseXlsxBuffer());
  buf = withChartXml(
    buf,
    1,
    richChartXml(
      { kind: 'bar', title: '各门店销售额', catRef: `'门店明细'!$F$2:$F$6`, valRef: `'门店明细'!$G$2:$G$6` },
      prefixed,
    ),
  );
  buf = withChartXml(
    buf,
    2,
    richChartXml(
      { kind: 'pie', title: '各门店占比', catRef: `'门店明细'!$F$2:$F$6`, valRef: `'门店明细'!$H$2:$H$6` },
      prefixed,
    ),
  );
  fs.writeFileSync(target, buf);
  return target;
}

describe('R4：readXlsxPreview 图表摘要', () => {
  it('2 图（c: 前缀形态）→ 部件提示 + 逐图摘要行（类型/标题/类别/数值引用），位于 sheet 节之前', async () => {
    const target = await makeRichChartFixture(tmpDir, 'rich-charts.xlsx', true);
    const out = await readXlsxPreview(target);
    expect(out).toContain('文件含 2 个图表');
    expect(out).toContain(`图表1[bar] 各门店销售额 → 类别 '门店明细'!$F$2:$F$6 / 数值 '门店明细'!$G$2:$G$6`);
    expect(out).toContain(`图表2[pie] 各门店占比 → 类别 '门店明细'!$F$2:$F$6 / 数值 '门店明细'!$H$2:$H$6`);
    expect(out.indexOf('图表1[bar]')).toBeGreaterThanOrEqual(0);
    expect(out.indexOf('图表1[bar]')).toBeLessThan(out.indexOf('## Sheet:'));
  });

  it('openpyxl 无前缀形态 → 同样出摘要', async () => {
    const target = await makeRichChartFixture(tmpDir, 'rich-charts-nopfx.xlsx', false);
    const out = await readXlsxPreview(target);
    expect(out).toContain('文件含 2 个图表');
    expect(out).toContain(`图表1[bar] 各门店销售额 → 类别 '门店明细'!$F$2:$F$6 / 数值 '门店明细'!$G$2:$G$6`);
    expect(out).toContain(`图表2[pie] 各门店占比 → 类别 '门店明细'!$F$2:$F$6 / 数值 '门店明细'!$H$2:$H$6`);
  });

  it('单图 → 提示与摘要同行（文件含 1 个图表）图表N[类型] …', async () => {
    const target = path.join(tmpDir, 'single-chart.xlsx');
    let buf = injectP0ChartDrawing(await makeBaseXlsxBuffer(), { charts: 1 });
    buf = withChartXml(
      buf,
      1,
      richChartXml(
        { kind: 'bar', title: '各门店销售额', catRef: `'门店明细'!$F$2:$F$6`, valRef: `'门店明细'!$G$2:$G$6` },
        true,
      ),
    );
    fs.writeFileSync(target, buf);
    const out = await readXlsxPreview(target);
    expect(out).toContain(
      `（注：文件含 1 个图表）图表1[bar] 各门店销售额 → 类别 '门店明细'!$F$2:$F$6 / 数值 '门店明细'!$G$2:$G$6`,
    );
  });

  it('坏 chart XML 跳过不炸：摘要缺位但部件计数与单元格数据不受影响', async () => {
    const target = path.join(tmpDir, 'broken-chart.xlsx');
    let buf = injectP0ChartDrawing(await makeBaseXlsxBuffer());
    buf = withChartXml(buf, 1, '<?xml version="1.0"?><垃圾内容不是图表');
    buf = withChartXml(
      buf,
      2,
      richChartXml(
        { kind: 'pie', title: '各门店占比', catRef: `'门店明细'!$F$2:$F$6`, valRef: `'门店明细'!$H$2:$H$6` },
        true,
      ),
    );
    fs.writeFileSync(target, buf);
    const out = await readXlsxPreview(target);
    // chart1 损坏被跳过，仅剩 chart2 摘要；部件计数仍按 2 计
    expect(out).toContain('文件含 2 个图表');
    expect(out).toContain('图表1[pie] 各门店占比');
    expect(out).not.toContain('[bar]');
    // 单元格数据照常读出
    expect(out).toContain('## Sheet: 销售 (3×3)');
    expect(out).toContain('2026-01-01');
  });

  it('引用超过 4 个 → 按出现序截断提示（不强行标注类别/数值）', async () => {
    const ref = (col: string): string => `'门店明细'!$${col}$2:$${col}$10`;
    // 5 序列各引不同列（无 cat/name，仅 numRef）→ refs 共 5 个
    const sers = ['B', 'C', 'D', 'E', 'F']
      .map((col) => `<c:ser><c:val><c:numRef><c:f>${ref(col)}</c:f></c:numRef></c:val></c:ser>`)
      .join('');
    const xml =
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">` +
      `<c:chart><c:plotArea><c:layout/><c:barChart>${sers}</c:barChart>` +
      `<c:catAx><c:axId val="111111111"/></c:catAx><c:valAx><c:axId val="222222222"/></c:valAx>` +
      `</c:plotArea></c:chart></c:chartSpace>`;
    const target = path.join(tmpDir, 'many-refs.xlsx');
    let buf = injectP0ChartDrawing(await makeBaseXlsxBuffer(), { charts: 1 });
    buf = withChartXml(buf, 1, xml);
    fs.writeFileSync(target, buf);
    const out = await readXlsxPreview(target);
    expect(out).toContain(
      `图表1[bar] → ${ref('B')}、${ref('C')}、${ref('D')}、${ref('E')} 等 5 个引用`,
    );
  });
});
