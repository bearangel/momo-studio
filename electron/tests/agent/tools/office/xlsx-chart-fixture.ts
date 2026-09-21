// 公共 xlsx fixture：exceljs 造底 + adm-zip 注入 P0 形态 drawing/chart 部件。
// 供 excel-read.test.ts（P0 sanitize 回归）与 xlsx-zip.test.ts（注入 / 快照回注）共用，
// 避免两份 fixture 副本漂移。注入物模拟真实 Excel / WPS / openpyxl 产物：
//   xl/drawings/drawing1.xml（xdr:graphicFrame 锚点——exceljs 读时会崩的形态）
//   xl/drawings/_rels/drawing1.xml.rels（chart 引用）
//   xl/charts/chartN.xml
//   xl/worksheets/_rels/sheet1.xml.rels（drawing 条目 + 可选 hyperlink 条目）
//   sheet1.xml 尾部 <drawing/> 标签
//   [Content_Types].xml 补 drawing/chart Override 行
// 全程真实操作（不 mock 库），与生产读写链路同一套 exceljs / adm-zip。

import ExcelJS from 'exceljs';
import AdmZip from 'adm-zip';

const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const XDR_NS = 'http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing';
const A_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const C_NS = 'http://schemas.openxmlformats.org/drawingml/2006/chart';
const PKG_REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const CT_DRAWING = 'application/vnd.openxmlformats-officedocument.drawing+xml';
const CT_CHART = 'application/vnd.openxmlformats-officedocument.drawingml.chart+xml';

/** exceljs 造底：单 sheet「销售」3 行数据；withHyperlinkCell 时 D1 加外链单元格
 *  （exceljs 原生产物根节点恒声明 xmlns:r，sheet 无 rels 需求时不写 rels 文件）。 */
export async function makeBaseXlsxBuffer(withHyperlinkCell = false): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('销售');
  ws.addRow(['日期', '地区', '金额']);
  ws.addRow(['2026-01-01', '华东', 100]);
  ws.addRow(['2026-01-02', '华北', 200]);
  if (withHyperlinkCell) {
    ws.getCell('D1').value = { text: '链接', hyperlink: 'https://example.com' };
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export interface InjectDrawingOpts {
  /** 注入 chart 部件数（默认 2 = P0 回归形态：chart1 + chart2，drawing rels 两条） */
  charts?: 1 | 2;
  /** sheet rels 中 drawing 条目的 Id（默认 'rIdD'；构造 Id 冲突场景时可传 'rId1'） */
  drawingRid?: string;
  /** 是否在 sheet rels 追加 hyperlink 条目（默认 true = P0 形态；
   *  base 已含 hyperlink 单元格（exceljs 已写过 rels）时应传 false 避免重复条目） */
  addHyperlink?: boolean;
}

/** 给 exceljs 正常生成的 xlsx 注入 P0 形态 drawing/chart 全套部件，返回新 Buffer（不改入参）。 */
export function injectP0ChartDrawing(buf: Buffer, opts: InjectDrawingOpts = {}): Buffer {
  const chartCount = opts.charts ?? 2;
  const drawingRid = opts.drawingRid ?? 'rIdD';
  const addHyperlink = opts.addHyperlink ?? true;
  const zip = new AdmZip(buf);

  // 1. drawing1.xml：xdr:graphicFrame 锚点引 chart1（exceljs 无法解析此形态）
  const drawingXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<xdr:wsDr xmlns:xdr="${XDR_NS}" xmlns:a="${A_NS}" xmlns:c="${C_NS}" xmlns:r="${REL_NS}">` +
    `<xdr:twoCellAnchor editAs="oneCell">` +
    `<xdr:from><xdr:col>0</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>0</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>` +
    `<xdr:to><xdr:col>4</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>15</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>` +
    `<xdr:graphicFrame macro="">` +
    `<xdr:nvGraphicFramePr><xdr:cNvPr id="2" name="Chart 1"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr>` +
    `<xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm>` +
    `<a:graphic><a:graphicData uri="${C_NS}">` +
    `<c:chart r:id="rIdC1"/>` +
    `</a:graphicData></a:graphic>` +
    `</xdr:graphicFrame>` +
    `</xdr:twoCellAnchor>` +
    `</xdr:wsDr>`;
  zip.addFile('xl/drawings/drawing1.xml', Buffer.from(drawingXml, 'utf8'));

  // 2. drawing rels：chart 引用（chartCount=2 时第二条为无锚点引用的 chart2）
  const chartRels =
    `<Relationship Id="rIdC1" Type="${REL_NS}/chart" Target="../charts/chart1.xml"/>` +
    (chartCount === 2 ? `<Relationship Id="rIdC2" Type="${REL_NS}/chart" Target="../charts/chart2.xml"/>` : '');
  zip.addFile(
    'xl/drawings/_rels/drawing1.xml.rels',
    Buffer.from(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="${PKG_REL_NS}">${chartRels}</Relationships>`,
      'utf8',
    ),
  );

  // 3. chart 部件（最小合法 chartSpace）
  const chartXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<c:chartSpace xmlns:c="${C_NS}">` +
    `<c:chart><c:title><c:tx><c:rich>` +
    `<a:bodyPr xmlns:a="${A_NS}"/>` +
    `</c:rich></c:tx></c:title></c:chart></c:chartSpace>`;
  zip.addFile('xl/charts/chart1.xml', Buffer.from(chartXml, 'utf8'));
  if (chartCount === 2) {
    zip.addFile('xl/charts/chart2.xml', Buffer.from(chartXml, 'utf8'));
  }

  // 4. sheet1 rels：既有条目（base 含 hyperlink 单元格时 exceljs 已写过）+ drawing（+ 可选 hyperlink）
  const sheetRelsName = 'xl/worksheets/_rels/sheet1.xml.rels';
  const existingEntry = zip.getEntry(sheetRelsName);
  const existingRels = existingEntry
    ? (zip.readAsText(sheetRelsName).match(/<Relationship\b[^>]*\/>/g) ?? [])
    : [];
  const relParts = [
    ...existingRels,
    `<Relationship Id="${drawingRid}" Type="${REL_NS}/drawing" Target="../drawings/drawing1.xml"/>`,
  ];
  if (addHyperlink) {
    relParts.push(
      `<Relationship Id="rIdH" Type="${REL_NS}/hyperlink" Target="https://example.com" TargetMode="External"/>`,
    );
  }
  zip.addFile(
    sheetRelsName,
    Buffer.from(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="${PKG_REL_NS}">${relParts.join('')}</Relationships>`,
      'utf8',
    ),
  );

  // 5. sheet1.xml 尾部插 <drawing/> 标签（自身闭合形态，real-Excel 写法）
  const sheetXml = zip.readAsText('xl/worksheets/sheet1.xml');
  zip.updateFile(
    'xl/worksheets/sheet1.xml',
    Buffer.from(sheetXml.replace(/<\/worksheet>/, `<drawing r:id="${drawingRid}"/></worksheet>`), 'utf8'),
  );

  // 6. ContentTypes 补 drawing/chart Override 行（真实 Excel 产物含；P0 sanitize 不动它）
  const overrides = [
    `<Override PartName="/xl/drawings/drawing1.xml" ContentType="${CT_DRAWING}"/>`,
    `<Override PartName="/xl/charts/chart1.xml" ContentType="${CT_CHART}"/>`,
  ];
  if (chartCount === 2) {
    overrides.push(`<Override PartName="/xl/charts/chart2.xml" ContentType="${CT_CHART}"/>`);
  }
  const ct = zip.readAsText('[Content_Types].xml');
  zip.updateFile('[Content_Types].xml', Buffer.from(ct.replace('</Types>', `${overrides.join('')}</Types>`), 'utf8'));

  return zip.toBuffer();
}
