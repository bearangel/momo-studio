// xlsx-zip 单测：resolveSheetFile / snapshotChartParts / restoreChartParts / injectCharts。
// 全程真实操作（不 mock 库）：exceljs 造底 + adm-zip 注入 P0 形态 drawing（公共 fixture），
// 快照-回注走真实管线（sanitizeXlsxForRead → exceljs load/writeBuffer → restore）。
// 覆盖 brief 6 用例：sheet 名映射与 null / 干净注入结构+exceljs 可读 / 多图表 /
// 既有 drawing 合并 / snapshot-restore 往返字节不变 / rId 冲突重命名。
// 边界用例：空 charts 数组、干净文件空快照、空快照 restore。

import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import AdmZip from 'adm-zip';
import {
  resolveSheetFile,
  snapshotChartParts,
  restoreChartParts,
  injectCharts,
} from '../../../../src/main/agent/tools/office/xlsx-zip';
import { sanitizeXlsxForRead } from '../../../../src/main/agent/tools/office/excel';
import { buildAnchorXml, buildChartXml } from '../../../../src/main/agent/tools/office/chart-xml';
import type { ChartData } from '../../../../src/main/agent/tools/office/chart-xml';
import { makeBaseXlsxBuffer, injectP0ChartDrawing } from './xlsx-chart-fixture';

const chartData: ChartData = {
  type: 'bar',
  title: '销量',
  series: [
    {
      catRef: '销售!$A$2:$A$3',
      catCache: ['2026-01-01', '2026-01-02'],
      valRef: '销售!$C$2:$C$3',
      valCache: [100, 200],
    },
  ],
};

/** 读取 zip 内某部件全文；缺失即抛（fixture/实现坏了要让测试大声失败） */
function readText(buf: Buffer, name: string): string {
  const zip = new AdmZip(buf);
  const entry = zip.getEntry(name);
  if (!entry) throw new Error(`zip 缺少部件: ${name}`);
  return zip.readAsText(entry.entryName);
}

function countMatches(s: string, re: RegExp): number {
  const m = s.match(re);
  return m === null ? 0 : m.length;
}

/** exceljs 真实加载（P0 结论：注入 graphicFrame 形态后 exceljs 仍可 load） */
async function loadXlsx(buf: Buffer): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  return wb;
}

/** 真实写管线等价模拟：sanitize（剥 drawing）→ exceljs 重写（drawing 全丢、rels 重编号） */
async function rewriteWithExceljs(buf: Buffer): Promise<Buffer> {
  const { data } = sanitizeXlsxForRead(buf);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(data as unknown as ArrayBuffer);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** 测试专用 rid 手术：sheet rels 条目 Id 与 sheet XML 的 r:id 引用同步改名 */
function renameRid(buf: Buffer, from: string, to: string): Buffer {
  const zip = new AdmZip(buf);
  const relsName = 'xl/worksheets/_rels/sheet1.xml.rels';
  const rels = zip.readAsText(relsName);
  zip.updateFile(relsName, Buffer.from(rels.split(`Id="${from}"`).join(`Id="${to}"`), 'utf8'));
  const sheet = zip.readAsText('xl/worksheets/sheet1.xml');
  zip.updateFile(
    'xl/worksheets/sheet1.xml',
    Buffer.from(sheet.split(`r:id="${from}"`).join(`r:id="${to}"`), 'utf8'),
  );
  return zip.toBuffer();
}

describe('resolveSheetFile', () => {
  it('sheet 显示名 → 文件路径映射（含 XML 转义名 &）；不存在 → null', async () => {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('销售');
    wb.addWorksheet('空表');
    wb.addWorksheet('A&B'); // workbook.xml 中写作 name="A&amp;B"
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const zip = new AdmZip(buf);
    expect(resolveSheetFile(zip, '销售')).toBe('xl/worksheets/sheet1.xml');
    expect(resolveSheetFile(zip, '空表')).toBe('xl/worksheets/sheet2.xml');
    expect(resolveSheetFile(zip, 'A&B')).toBe('xl/worksheets/sheet3.xml');
    expect(resolveSheetFile(zip, '不存在')).toBeNull();
  });
});

describe('injectCharts：干净文件（目标 sheet 无 drawing）', () => {
  it('注入 chart1 + drawing1 + 双 rels + sheet 标签 + ContentTypes；anchor r:id 重指派；exceljs 可读', async () => {
    const base = await makeBaseXlsxBuffer();
    // 占位 rid / 占位 frameId：注入层必须重指派为实际分配值（Task 1 契约的容错侧）
    const anchorXml = buildAnchorXml({ fromCol: 3, fromRow: 0, toCol: 8, toRow: 15 }, 'rIdPLACE', 99);
    const out = injectCharts(base, 'xl/worksheets/sheet1.xml', [
      { chartXml: buildChartXml(chartData), anchorXml },
    ]);
    const z = new AdmZip(out);
    expect(z.getEntry('xl/charts/chart1.xml')).not.toBeNull();
    expect(z.getEntry('xl/drawings/drawing1.xml')).not.toBeNull();
    expect(z.getEntry('xl/drawings/_rels/drawing1.xml.rels')).not.toBeNull();
    expect(z.getEntry('xl/worksheets/_rels/sheet1.xml.rels')).not.toBeNull();

    const drawing = readText(out, 'xl/drawings/drawing1.xml');
    // 根节点三命名空间齐全（排雷铁律：openpyxl 校验 unbound prefix）
    expect(drawing).toContain('xmlns:xdr=');
    expect(drawing).toContain('xmlns:a=');
    expect(drawing).toContain('xmlns:r=');
    // chart r:id 重指派：占位 → 实际分配的 drawing-rels Id；cNvPr id 重编为 1
    expect(drawing).toContain('r:id="rId1"');
    expect(drawing).not.toContain('rIdPLACE');
    expect(drawing).toContain('id="1"');
    expect(drawing).not.toContain('id="99"');
    // drawing rels 指向 chart 部件
    expect(readText(out, 'xl/drawings/_rels/drawing1.xml.rels')).toContain(
      'Target="../charts/chart1.xml"',
    );
    // sheet XML 尾部含 drawing 标签（新建 rels → Id 从 rId1 起）
    expect(readText(out, 'xl/worksheets/sheet1.xml')).toContain('<drawing r:id="rId1"/>');
    // ContentTypes 补 drawing + chart Override
    const ct = readText(out, '[Content_Types].xml');
    expect(ct).toContain('/xl/drawings/drawing1.xml');
    expect(ct).toContain('/xl/charts/chart1.xml');
    // exceljs 仍能 load 注入结果（PoC 已证，此处锁契约）+ 数据完好
    const wb = await loadXlsx(out);
    expect(wb.getWorksheet('销售')?.getCell('C2').value).toBe(100);
  });
});

describe('injectCharts：多图表', () => {
  it('两 chart → chart1/chart2 + drawing1 两个 twoCellAnchor + drawing rels 两条', async () => {
    const base = await makeBaseXlsxBuffer();
    const out = injectCharts(base, 'xl/worksheets/sheet1.xml', [
      { chartXml: buildChartXml(chartData), anchorXml: buildAnchorXml({ fromCol: 0, fromRow: 1, toCol: 5, toRow: 16 }, 'rIdA', 7) },
      { chartXml: buildChartXml(chartData), anchorXml: buildAnchorXml({ fromCol: 6, fromRow: 1, toCol: 11, toRow: 16 }, 'rIdB', 8) },
    ]);
    const z = new AdmZip(out);
    expect(z.getEntry('xl/charts/chart1.xml')).not.toBeNull();
    expect(z.getEntry('xl/charts/chart2.xml')).not.toBeNull();
    const drawing = readText(out, 'xl/drawings/drawing1.xml');
    expect(countMatches(drawing, /<xdr:twoCellAnchor\b/g)).toBe(2);
    // 两个锚点的 chart r:id 分别重指派为 rId1 / rId2（互不相同）
    expect(drawing).toContain('r:id="rId1"');
    expect(drawing).toContain('r:id="rId2"');
    const drels = readText(out, 'xl/drawings/_rels/drawing1.xml.rels');
    expect(countMatches(drels, /<Relationship\b/g)).toBe(2);
    expect(drels).toContain('Target="../charts/chart1.xml"');
    expect(drels).toContain('Target="../charts/chart2.xml"');
    await loadXlsx(out);
  });
});

describe('injectCharts：目标 sheet 已有 drawing（合并）', () => {
  it('锚点并入既有 wsDr、drawing rels 追加、sheet rels 不动、ContentTypes 只补 chart', async () => {
    const withDrawing = injectP0ChartDrawing(await makeBaseXlsxBuffer(), { charts: 1 });
    const sheetRelsBefore = readText(withDrawing, 'xl/worksheets/_rels/sheet1.xml.rels');
    const out = injectCharts(withDrawing, 'xl/worksheets/sheet1.xml', [
      { chartXml: buildChartXml(chartData), anchorXml: buildAnchorXml({ fromCol: 0, fromRow: 1, toCol: 5, toRow: 16 }, 'rIdX', 50) },
      { chartXml: buildChartXml(chartData), anchorXml: buildAnchorXml({ fromCol: 6, fromRow: 1, toCol: 11, toRow: 16 }, 'rIdY', 51) },
    ]);
    const z = new AdmZip(out);
    // chart 部件编号续接既有 max（原 chart1 → 新 chart2/chart3）
    expect(z.getEntry('xl/charts/chart2.xml')).not.toBeNull();
    expect(z.getEntry('xl/charts/chart3.xml')).not.toBeNull();
    const drawing = readText(out, 'xl/drawings/drawing1.xml');
    // 只有一个 wsDr 根；锚点原 1 + 新 2 = 3
    expect(countMatches(drawing, /<xdr:wsDr\b/g)).toBe(1);
    expect(countMatches(drawing, /<xdr:twoCellAnchor\b/g)).toBe(3);
    // drawing rels：原 rIdC1 保住 + 新 2 条（Id 未占用，不与 rIdC1 冲突）
    const drels = readText(out, 'xl/drawings/_rels/drawing1.xml.rels');
    expect(countMatches(drels, /<Relationship\b/g)).toBe(3);
    expect(drels).toContain('Id="rIdC1"');
    // 新锚点 cNvPr id 续接既有最大（原锚点 id=2 → 新 3、4）
    expect(drawing).toContain('id="3"');
    expect(drawing).toContain('id="4"');
    // sheet rels 原样不动；sheet XML 仍只有一个 drawing 标签
    expect(readText(out, 'xl/worksheets/_rels/sheet1.xml.rels')).toBe(sheetRelsBefore);
    expect(countMatches(readText(out, 'xl/worksheets/sheet1.xml'), /<drawing\b/g)).toBe(1);
    // ContentTypes 只补 chart Override；drawing Override 不重复
    const ct = readText(out, '[Content_Types].xml');
    expect(ct).toContain('/xl/charts/chart2.xml');
    expect(ct).toContain('/xl/charts/chart3.xml');
    expect(countMatches(ct, /PartName="\/xl\/drawings\/drawing1\.xml"/g)).toBe(1);
    // exceljs 仍可读
    const wb = await loadXlsx(out);
    expect(wb.getWorksheet('销售')?.getCell('C3').value).toBe(200);
  });
});

describe('snapshotChartParts / restoreChartParts', () => {
  it('往返：真实 exceljs 重写后回注，部件字节不变、rels/ContentTypes 完整、标签回插', async () => {
    const orig = injectP0ChartDrawing(await makeBaseXlsxBuffer()); // 2 chart P0 形态
    const snap = snapshotChartParts(orig);

    // 快照内容：4 部件 + 整文件 sheet rels（含非 drawing 条目）+ drawing 标签原文 + 3 行 Override
    expect(snap.parts.map((p) => p.name)).toContain('xl/drawings/drawing1.xml');
    expect(snap.parts.map((p) => p.name)).toContain('xl/drawings/_rels/drawing1.xml.rels');
    expect(snap.parts.map((p) => p.name)).toContain('xl/charts/chart1.xml');
    expect(snap.parts.map((p) => p.name)).toContain('xl/charts/chart2.xml');
    expect(snap.parts).toHaveLength(4);
    expect(snap.sheetRels).toHaveLength(1);
    const [sheetRelsSnap] = snap.sheetRels;
    if (sheetRelsSnap === undefined) throw new Error('快照应含 1 份 sheet rels');
    expect(sheetRelsSnap.name).toBe('xl/worksheets/_rels/sheet1.xml.rels');
    expect(sheetRelsSnap.data.toString('utf8')).toContain('/drawing');
    expect(sheetRelsSnap.data.toString('utf8')).toContain('/hyperlink'); // 整文件快照
    expect(snap.sheetDrawingTags).toEqual([
      { sheet: 'xl/worksheets/sheet1.xml', tag: '<drawing r:id="rIdD"/>' },
    ]);
    expect(snap.contentOverrides).toHaveLength(3);

    // 真实管线：sanitize → exceljs 重写（drawing 全丢）
    const rewritten = await rewriteWithExceljs(orig);
    expect(new AdmZip(rewritten).getEntry('xl/drawings/drawing1.xml')).toBeNull();

    const restored = restoreChartParts(rewritten, snap);
    const z = new AdmZip(restored);
    expect(z.getEntry('xl/drawings/drawing1.xml')).not.toBeNull();
    expect(z.getEntry('xl/drawings/_rels/drawing1.xml.rels')).not.toBeNull();

    // chart1.xml 字节不变：restore 产物 = 快照原字节 = 原始文件字节
    const chart1Restored = z.getEntry('xl/charts/chart1.xml')?.getData();
    const chart1Snap = snap.parts.find((p) => p.name === 'xl/charts/chart1.xml')?.data;
    const chart1Orig = new AdmZip(orig).getEntry('xl/charts/chart1.xml')?.getData();
    expect(chart1Restored && chart1Snap && chart1Restored.equals(chart1Snap)).toBe(true);
    expect(chart1Restored && chart1Orig && chart1Restored.equals(chart1Orig)).toBe(true);

    // 重写产物无 sheet rels → 回注仅 drawing 侧（快照里 hyperlink 不回注）
    const relsXml = readText(restored, 'xl/worksheets/_rels/sheet1.xml.rels');
    expect(relsXml).toContain('Id="rIdD"');
    expect(relsXml).toContain('/drawing');
    expect(relsXml).not.toContain('/hyperlink');
    // sheet 标签按原文回插
    expect(readText(restored, 'xl/worksheets/sheet1.xml')).toContain('<drawing r:id="rIdD"/>');
    // ContentTypes 补齐 3 行 Override
    const ct = readText(restored, '[Content_Types].xml');
    expect(ct).toContain('/xl/drawings/drawing1.xml');
    expect(ct).toContain('/xl/charts/chart1.xml');
    expect(ct).toContain('/xl/charts/chart2.xml');
    // 回注产物 exceljs 仍可读 + 数据完好
    const wb = await loadXlsx(restored);
    expect(wb.getWorksheet('销售')?.getCell('C3').value).toBe(200);
  });

  it('Id 冲突：新 rels 已有 rId1（hyperlink）+ 快照 drawing 也是 rId1 → 重命名并存，sheet 标签指向新 Id', async () => {
    // base 带 hyperlink 单元格：exceljs 原生 rels = hyperlink rId1 + sheet XML 引用 rId1
    // 先把 hyperlink 挪到 rId2，再让注入的 drawing 占用 rId1（构造冲突前件）
    const swapped = renameRid(await makeBaseXlsxBuffer(true), 'rId1', 'rId2');
    const crafted = injectP0ChartDrawing(swapped, {
      charts: 1,
      drawingRid: 'rId1',
      addHyperlink: false,
    });
    const snap = snapshotChartParts(crafted); // 快照 drawing = rId1
    // 真实重写：exceljs 重新编号，hyperlink 回到 rId1（与快照 drawing 冲突）
    const rewritten = await rewriteWithExceljs(crafted);
    const restored = restoreChartParts(rewritten, snap);

    const relsTags = readText(restored, 'xl/worksheets/_rels/sheet1.xml.rels').match(
      /<Relationship\b[^>]*\/>/g,
    );
    expect(relsTags).not.toBeNull();
    const hyperlinkRels = (relsTags ?? []).filter((t) => t.includes('/hyperlink'));
    const drawingRels = (relsTags ?? []).filter((t) => t.includes('/drawing'));
    // 两条并存，各 1 条
    expect(hyperlinkRels).toHaveLength(1);
    expect(drawingRels).toHaveLength(1);
    // hyperlink 保住 rId1；drawing 被重命名且不等于 rId1
    const [hyperlinkRel] = hyperlinkRels;
    const [drawingRel] = drawingRels;
    if (hyperlinkRel === undefined || drawingRel === undefined) {
      throw new Error('restore 后应各有 1 条 hyperlink / drawing 关系');
    }
    expect(hyperlinkRel).toContain('Id="rId1"');
    expect(drawingRel).not.toContain('Id="rId1"');
    const newRid = drawingRel.match(/Id="([^"]+)"/)?.[1];
    expect(newRid).toBeDefined();
    expect(newRid).not.toBe('rId1');
    // sheet XML：drawing 标签指向重命名后的 Id；hyperlink 引用不被破坏
    const sheetXml = readText(restored, 'xl/worksheets/sheet1.xml');
    expect(sheetXml).toContain(`<drawing r:id="${newRid}"/>`);
    expect(sheetXml).not.toContain('<drawing r:id="rId1"');
    expect(sheetXml).toContain('r:id="rId1"'); // hyperlink 标签仍指 rId1
    // exceljs 可读（hyperlink 未损坏）
    const wb = await loadXlsx(restored);
    expect(wb.getWorksheet('销售')?.getCell('C2').value).toBe(100);
  });
});

describe('边界：空输入', () => {
  it('injectCharts 空 charts 数组：原字节返回', async () => {
    const base = await makeBaseXlsxBuffer();
    const out = injectCharts(base, 'xl/worksheets/sheet1.xml', []);
    expect(out.equals(base)).toBe(true);
  });

  it('干净文件快照全空；空快照 restore 不改部件集、exceljs 仍可读', async () => {
    const base = await makeBaseXlsxBuffer();
    const snap = snapshotChartParts(base);
    expect(snap.parts).toHaveLength(0);
    expect(snap.sheetRels).toHaveLength(0);
    expect(snap.sheetDrawingTags).toHaveLength(0);
    expect(snap.contentOverrides).toHaveLength(0);
    const restored = restoreChartParts(base, snap);
    const namesBefore = new AdmZip(base).getEntries().map((e) => e.entryName).sort();
    const namesAfter = new AdmZip(restored).getEntries().map((e) => e.entryName).sort();
    expect(namesAfter).toEqual(namesBefore);
    await loadXlsx(restored);
  });
});
