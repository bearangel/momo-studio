// Momo Studio 原生 Excel 图表 XML 纯函数生成器。无 IO / 无 side effect。
// 输出符合 openpyxl 严格 schema（PoC 排雷铁律已锁：drawing 根节点 xmlns:r 声明、
// graphicFrame 显式闭合、chartSpace 元素次序严格）。后续 Task 2 会把它喂给 exceljs
// 写 xl/charts/chart*.xml 与 xl/drawings/drawing*.xml。

import { parseRange } from './format';

export type ChartType = 'bar' | 'bar_h' | 'line' | 'pie';

/** 单序列数据：nameRef / nameLiteral 二选一；catCache / valCache 是写入时缓存，
 *  避免 Excel 重新读源数据时被空值遮蔽（与 openpyxl 写法对齐）。
 *  nameCache：nameRef 模式下序列名缓存值（编排层从内存 workbook 读 B1 等单元格填充），
 *  提供时 strRef 内 c:f 之后发 c:strCache（brief 契约：c:tx = strRef+strCache | c:v）。
 *  缓存 null 点语义（spec §14.6 P1b）：公式格无缓存 result 时该点 omit——生成侧
 *  省略 c:pt、ptCount 保持区域全长（Excel 打开后自动计算回填，诚实优于错值）。 */
export interface ChartSeriesData {
  nameRef?: string;
  nameLiteral?: string;
  nameCache?: string;
  catRef: string;
  catCache: Array<string | null>;
  valRef: string;
  valCache: Array<number | null>;
}

/** 图表数据：type 决定布局（pie 无轴、bar_h 横纵翻转）；title 缺省时 c:title 节点不输出。 */
export interface ChartData {
  type: ChartType;
  title?: string;
  series: ChartSeriesData[];
}

/** drawing twoCellAnchor 锚点：0-based 列/行下标（Excel 模型）。 */
export interface AnchorSpec {
  fromCol: number;
  fromRow: number;
  toCol: number;
  toRow: number;
}

/** XML 元素转义：& 必须先替换，避免双重转义。 */
export function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// 列号(1-based) → 列字母（A=1, Z=26, AA=27）。parseRange 的反向。
function indexToCol(idx: number): string {
  let s = '';
  while (idx > 0) {
    idx--;
    s = String.fromCharCode(65 + (idx % 26)) + s;
    idx = Math.floor(idx / 26);
  }
  return s;
}

/** sheet 名 + A1 range → 'sheet'!$A$1:$B$5 形态（表名一律加单引号，内部 ' 双写）。
 * 解析与大小写归一委托给既有 parseRange。 */
export function sheetAbsRef(sheet: string, range: string): string {
  const r = parseRange(range);
  const startCol = indexToCol(r.startCol);
  const quoted = `'${sheet.replace(/'/g, "''")}'`;
  if (r.endCol !== null && r.endRow !== null) {
    return `${quoted}!$${startCol}$${r.startRow}:$${indexToCol(r.endCol)}$${r.endRow}`;
  }
  return `${quoted}!$${startCol}$${r.startRow}`;
}

// 两个固定轴 ID：openpyxl / Excel 实际渲染只看 axId 对应关系，固定值简化生成逻辑。
const CAT_AX_ID = '111111111';
const VAL_AX_ID = '222222222';

function buildTxXml(s: ChartSeriesData): string {
  if (s.nameRef !== undefined) {
    const cacheXml = s.nameCache !== undefined
      ? `<c:strCache><c:ptCount val="1"/><c:pt idx="0"><c:v>${xmlEscape(s.nameCache)}</c:v></c:pt></c:strCache>`
      : '';
    return `<c:tx><c:strRef><c:f>${xmlEscape(s.nameRef)}</c:f>${cacheXml}</c:strRef></c:tx>`;
  }
  if (s.nameLiteral !== undefined) {
    return `<c:tx><c:v>${xmlEscape(s.nameLiteral)}</c:v></c:tx>`;
  }
  return '';
}

// bar / line 默认黑色细线（9525 EMU = 0.75pt，与 openpyxl 默认一致）；pie 无 spPr。
function buildSpPrXml(type: ChartType): string {
  if (type === 'pie') return '';
  return `<c:spPr>
    <a:ln w="9525">
      <a:solidFill><a:srgbClr val="000000"/></a:solidFill>
    </a:ln>
  </c:spPr>`;
}

function buildMarkerXml(): string {
  return `<c:marker>
    <c:symbol val="circle"/>
    <c:size val="5"/>
  </c:marker>`;
}

/** numCache 子树：null 点省略 c:pt、ptCount 保持全长、formatCode 缺省 General。
 *  xlsx-zip.refreshChartCaches 复用同款生成——引用值未变时重算结果与原生成器
 *  字节同构（保真分支「未被修改则字节不变」依赖此约定）。 */
export function buildNumCacheXml(values: Array<number | null>, formatCode = 'General'): string {
  const pts = values
    .map((v, i) => (v === null ? '' : `<c:pt idx="${i}"><c:v>${v}</c:v></c:pt>`))
    .join('');
  return `<c:numCache><c:formatCode>${xmlEscape(formatCode)}</c:formatCode><c:ptCount val="${values.length}"/>${pts}</c:numCache>`;
}

/** strCache 子树：语义同 buildNumCacheXml（文本侧，无 formatCode）。 */
export function buildStrCacheXml(values: Array<string | null>): string {
  const pts = values
    .map((v, i) => (v === null ? '' : `<c:pt idx="${i}"><c:v>${xmlEscape(v)}</c:v></c:pt>`))
    .join('');
  return `<c:strCache><c:ptCount val="${values.length}"/>${pts}</c:strCache>`;
}

function buildCatXml(s: ChartSeriesData): string {
  return `<c:cat>
    <c:strRef>
      <c:f>${xmlEscape(s.catRef)}</c:f>
      ${buildStrCacheXml(s.catCache)}
    </c:strRef>
  </c:cat>`;
}

function buildValXml(s: ChartSeriesData): string {
  return `<c:val>
    <c:numRef>
      <c:f>${xmlEscape(s.valRef)}</c:f>
      ${buildNumCacheXml(s.valCache)}
    </c:numRef>
  </c:val>`;
}

function buildSeriesXml(s: ChartSeriesData, idx: number, type: ChartType): string {
  const txXml = buildTxXml(s);
  const spPrXml = buildSpPrXml(type);
  const markerXml = type === 'line' ? buildMarkerXml() : '';
  const catXml = buildCatXml(s);
  const valXml = buildValXml(s);
  return `<c:ser>
    <c:idx val="${idx}"/>
    <c:order val="${idx}"/>
    ${txXml}
    ${spPrXml}
    ${markerXml}
    ${catXml}
    ${valXml}
  </c:ser>`;
}

function buildBarChartBody(data: ChartData): string {
  const barDir = data.type === 'bar_h' ? 'bar' : 'col';
  const sers = data.series.map((s, i) => buildSeriesXml(s, i, data.type)).join('');
  return `<c:barChart>
    <c:barDir val="${barDir}"/>
    <c:grouping val="clustered"/>
    <c:varyColors val="0"/>
    ${sers}
    <c:gapWidth val="150"/>
    <c:axId val="${CAT_AX_ID}"/>
    <c:axId val="${VAL_AX_ID}"/>
  </c:barChart>`;
}

function buildLineChartBody(data: ChartData): string {
  const sers = data.series.map((s, i) => buildSeriesXml(s, i, data.type)).join('');
  return `<c:lineChart>
    <c:grouping val="standard"/>
    <c:varyColors val="0"/>
    ${sers}
    <c:marker val="1"/>
    <c:axId val="${CAT_AX_ID}"/>
    <c:axId val="${VAL_AX_ID}"/>
  </c:lineChart>`;
}

function buildPieChartBody(data: ChartData): string {
  const sers = data.series.map((s, i) => buildSeriesXml(s, i, data.type)).join('');
  return `<c:pieChart>
    <c:varyColors val="1"/>
    ${sers}
    <c:dLbls>
      <c:txPr>
        <a:bodyPr/>
        <a:lstStyle/>
        <a:p>
          <a:pPr><a:defRPr sz="1000"/></a:pPr>
          <a:endParaRPr lang="zh-CN"/>
        </a:p>
      </c:txPr>
      <c:dLblPos val="ctr"/>
      <c:showLegendKey val="0"/>
      <c:showVal val="0"/>
      <c:showCatName val="0"/>
      <c:showSerName val="0"/>
      <c:showPercent val="1"/>
      <c:showBubbleSize val="0"/>
      <c:showLeaderLines val="1"/>
    </c:dLbls>
    <c:firstSliceAng val="0"/>
  </c:pieChart>`;
}

function buildChartTypeBody(data: ChartData): string {
  switch (data.type) {
    case 'bar':
    case 'bar_h':
      return buildBarChartBody(data);
    case 'line':
      return buildLineChartBody(data);
    case 'pie':
      return buildPieChartBody(data);
  }
}

function buildCatAx(type: ChartType): string {
  // bar_h 类别轴翻转到左侧；bar / line 类别轴在底。
  const axPos = type === 'bar_h' ? 'l' : 'b';
  return `<c:catAx>
    <c:axId val="${CAT_AX_ID}"/>
    <c:scaling><c:orientation val="minMax"/></c:scaling>
    <c:delete val="0"/>
    <c:axPos val="${axPos}"/>
    <c:crossAx val="${VAL_AX_ID}"/>
  </c:catAx>`;
}

function buildValAx(type: ChartType): string {
  const axPos = type === 'bar_h' ? 'b' : 'l';
  return `<c:valAx>
    <c:axId val="${VAL_AX_ID}"/>
    <c:scaling><c:orientation val="minMax"/></c:scaling>
    <c:delete val="0"/>
    <c:axPos val="${axPos}"/>
    <c:numFmt formatCode="General" sourceLinked="1"/>
    <c:crossAx val="${CAT_AX_ID}"/>
  </c:valAx>`;
}

function buildTitleXml(title: string): string {
  return `<c:title>
    <c:tx>
      <c:rich>
        <a:bodyPr/>
        <a:lstStyle/>
        <a:p>
          <a:pPr>
            <a:defRPr sz="1200"/>
          </a:pPr>
          <a:r>
            <a:rPr lang="zh-CN" sz="1200"/>
            <a:t>${xmlEscape(title)}</a:t>
          </a:r>
        </a:p>
      </c:rich>
    </c:tx>
    <c:overlay val="0"/>
  </c:title>`;
}

/** 组装完整 chartSpace XML（c:chartSpace > c:chart > [...title, autoTitleDeleted, plotArea, plotVisOnly, dispBlanksAs]）。
 * 元素次序严格按 openpyxl schema。 */
export function buildChartXml(data: ChartData): string {
  const titlePart = data.title !== undefined
    ? `${buildTitleXml(data.title)}
    <c:autoTitleDeleted val="0"/>`
    : '<c:autoTitleDeleted val="1"/>';

  const axesPart = data.type === 'pie'
    ? ''
    : `${buildCatAx(data.type)}
    ${buildValAx(data.type)}`;

  return `<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <c:chart>
    ${titlePart}
    <c:plotArea>
      <c:layout/>
      ${buildChartTypeBody(data)}
      ${axesPart}
    </c:plotArea>
    <c:plotVisOnly val="1"/>
    <c:dispBlanksAs val="gap"/>
  </c:chart>
</c:chartSpace>`;
}

/** 组装 drawing twoCellAnchor 片段（不含根 xmlns：调用方需在根节点声明 xmlns:xdr/a/r/c）。
 * graphicFrame 显式闭合后才接 xdr:clientData；c:chart 用 r:id 指向 chart 关系。
 * 排雷铁律 #1：根节点必须声明 xmlns:r（openpyxl 校验 unbound prefix）。 */
export function buildAnchorXml(anchor: AnchorSpec, chartRid: string, frameId: number): string {
  return `<xdr:twoCellAnchor editAs="oneCell">
    <xdr:from>
      <xdr:col>${anchor.fromCol}</xdr:col>
      <xdr:colOff>0</xdr:colOff>
      <xdr:row>${anchor.fromRow}</xdr:row>
      <xdr:rowOff>0</xdr:rowOff>
    </xdr:from>
    <xdr:to>
      <xdr:col>${anchor.toCol}</xdr:col>
      <xdr:colOff>0</xdr:colOff>
      <xdr:row>${anchor.toRow}</xdr:row>
      <xdr:rowOff>0</xdr:rowOff>
    </xdr:to>
    <xdr:graphicFrame macro="">
      <xdr:nvGraphicFramePr>
        <xdr:cNvPr id="${frameId}" name="Chart ${frameId}"/>
        <xdr:cNvGraphicFramePr/>
      </xdr:nvGraphicFramePr>
      <xdr:xfrm>
        <a:off x="0" y="0"/>
        <a:ext cx="0" cy="0"/>
      </xdr:xfrm>
      <a:graphic>
        <a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart">
          <c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" r:id="${chartRid}"/>
        </a:graphicData>
      </a:graphic>
    </xdr:graphicFrame>
    <xdr:clientData/>
  </xdr:twoCellAnchor>`;
}