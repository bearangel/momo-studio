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
import {
  readXlsxPreview,
  readXlsxCells,
  sanitizeXlsxForRead,
} from '../../../../src/main/agent/tools/office/excel';

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

// ────────────────────────────────────────────────────────────────────────────
// P0 回归：带图表/图片的 xlsx（P0 read-fix）
// 真实 Excel / WPS / openpyxl 输出的 xlsx 含 xl/drawings/ + xl/charts/ 部件，
// drawing.xml 用 xdr:graphicFrame 锚点（图表）、xdr:pic（图片）。exceljs 只识别
// xdr:twoCellAnchor / xdr:oneCellAnchor + xdr:pic，无法解析 graphicFrame 形态，
// 真实报错：「Cannot read properties of undefined (reading 'anchors')」或
// 「unexpected close tag」。同事流转的报表几乎必带图表，故读前需 sanitize。
// ────────────────────────────────────────────────────────────────────────────

/** 给 exceljs 正常生成的 xlsx 注入 drawing/chart 部件 + rels + sheet XML 标签，
 *  模拟真实 Excel/WPS/openpyxl 产物。返回写入后的字节。 */
function injectChartParts(buf: Buffer): Buffer {
  const zip = new AdmZip(buf);

  // 1. drawing.xml 含 xdr:graphicFrame 引 chart（exceljs 无法解析此形态）
  zip.addFile(
    'xl/drawings/drawing1.xml',
    Buffer.from(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing"` +
      ` xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"` +
      ` xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"` +
      ` xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
      `<xdr:twoCellAnchor editAs="oneCell">` +
      `<xdr:from><xdr:col>0</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>0</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>` +
      `<xdr:to><xdr:col>4</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>15</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>` +
      `<xdr:graphicFrame macro="">` +
      `<xdr:nvGraphicFramePr><xdr:cNvPr id="2" name="Chart 1"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr>` +
      `<xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm>` +
      `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart">` +
      `<c:chart r:id="rIdC1"/>` +
      `</a:graphicData></a:graphic>` +
      `</xdr:graphicFrame>` +
      `</xdr:twoCellAnchor>` +
      `</xdr:wsDr>`,
    ),
  );

  // 2. drawing.rels：引 chart1 + chart2
  zip.addFile(
    'xl/drawings/_rels/drawing1.xml.rels',
    Buffer.from(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rIdC1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart1.xml"/>` +
      `<Relationship Id="rIdC2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart2.xml"/>` +
      `</Relationships>`,
    ),
  );

  // 3. 两个 chart.xml
  const chartXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart">` +
    `<c:chart><c:title><c:tx><c:rich>` +
    `<a:bodyPr xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"/>` +
    `</c:rich></c:tx></c:title></c:chart></c:chartSpace>`;
  zip.addFile('xl/charts/chart1.xml', Buffer.from(chartXml));
  zip.addFile('xl/charts/chart2.xml', Buffer.from(chartXml));

  // 4. sheet1 rels：drawing + hyperlink 混合（hyperlink 必须保留）
  zip.addFile(
    'xl/worksheets/_rels/sheet1.xml.rels',
    Buffer.from(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rIdD" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/>` +
      `<Relationship Id="rIdH" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com" TargetMode="External"/>` +
      `</Relationships>`,
    ),
  );

  // 5. sheet1.xml：追加 <drawing/> 标签（自身行尾）
  for (const entry of zip.getEntries()) {
    if (entry.entryName === 'xl/worksheets/sheet1.xml') {
      const xml = zip.readAsText(entry.entryName);
      const updated = xml.replace(
        /<\/worksheet>/,
        `<drawing r:id="rIdD"/></worksheet>`,
      );
      zip.updateFile(entry.entryName, Buffer.from(updated));
      break;
    }
  }

  return zip.toBuffer();
}

/** 写一份含图表/链接的 xlsx fixture 到 tmpDir，返回绝对路径 */
async function makeChartFixture(dir: string, name = 'chart.xlsx'): Promise<string> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('销售');
  ws.addRow(['日期', '地区', '金额']);
  ws.addRow(['2026-01-01', '华东', 100]);
  ws.addRow(['2026-01-02', '华北', 200]);
  const plain = path.join(dir, '_plain.xlsx');
  await wb.xlsx.writeFile(plain);
  const withCharts = path.join(dir, name);
  fs.writeFileSync(withCharts, injectChartParts(fs.readFileSync(plain)));
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
    const originalHash = require('node:crypto').createHash('sha256').update(original).digest('hex');
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
    const afterHash = require('node:crypto').createHash('sha256').update(original).digest('hex');
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
