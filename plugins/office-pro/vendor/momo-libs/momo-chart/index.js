// momo-chart：Excel 图表 XML 构建 + xlsx zip 注入库（office-pro 插件自有，纯 CJS）。
// 移植来源（office-pro-plugin 分支 commit 2a795cfb，逐函数剥 TS 类型转 JSDoc，逻辑/常量/错误文案原样）：
//   - electron/src/main/agent/tools/office/chart-xml.ts（全部构建函数）
//   - electron/src/main/agent/tools/office/xlsx-zip.ts（add_chart 注入路径：部件挂载 /
//     [Content_Types] 与 rels 更新 / 快照回注；缓存重算与图表摘要属内核编排管线，未随迁）
//   - electron/src/main/agent/tools/office/format.ts（parseRange / colToIndex 内联，保持自包含）
// 新增组合层：injectXlsxChart(xlsxBuffer, spec)——插件侧 agent 直接以 JS 对象传 spec，
// 内核 excel.ts 的 add_chart op 解析层不迁。
'use strict';
const AdmZip = require('adm-zip');

// ────────────────────────────────────────────────────────────────────────────
// JSDoc 类型（与源 TS interface 同形）
// ────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {'bar'|'bar_h'|'line'|'pie'} ChartType
 */

/**
 * 单序列数据：nameRef / nameLiteral 二选一；catCache / valCache 是写入时缓存，
 * 避免 Excel 重新读源数据时被空值遮蔽（与 openpyxl 写法对齐）。
 * nameCache：nameRef 模式下序列名缓存值（编排层从内存 workbook 读 B1 等单元格填充），
 * 提供时 strRef 内 c:f 之后发 c:strCache（契约：c:tx = strRef+strCache | c:v）。
 * 缓存 null 点语义：公式格无缓存 result 时该点 omit——生成侧省略 c:pt、ptCount
 * 保持区域全长（Excel 打开后自动计算回填，诚实优于错值）。
 * color：系列实心填充色（6 位 hex）——缺省走类型默认（bar/line 黑描边无填充、pie 无 spPr）。
 * @typedef {Object} ChartSeriesData
 * @property {string} [nameRef]
 * @property {string} [nameLiteral]
 * @property {string} [nameCache]
 * @property {string} catRef
 * @property {Array.<string|null>} catCache
 * @property {string} valRef
 * @property {Array.<number|null>} valCache
 * @property {string} [color]
 */

/**
 * 逐数据点着色项：index 非负；不与系列点数校验上限——超出点数的项 Excel 渲染时忽略。
 * @typedef {Object} DataPointColor
 * @property {number} index
 * @property {string} color
 */

/**
 * 图表数据：type 决定布局（pie 无轴、bar_h 横纵翻转）；title 缺省时 c:title 节点不输出；
 * dataPointColors 对图表内每个 ser 生成 c:dPt（典型场景单序列柱/饼条件预警色）。
 * @typedef {Object} ChartData
 * @property {ChartType} type
 * @property {string} [title]
 * @property {ChartSeriesData[]} series
 * @property {DataPointColor[]} [dataPointColors]
 */

/**
 * drawing twoCellAnchor 锚点：0-based 列/行下标（Excel 模型）。
 * @typedef {Object} AnchorSpec
 * @property {number} fromCol
 * @property {number} fromRow
 * @property {number} toCol
 * @property {number} toRow
 */

/**
 * injectXlsxChart 入参 spec：anchor 0-based 列行。
 * @typedef {Object} XlsxChartSpec
 * @property {string} sheetName
 * @property {{from: {col: number, row: number}, to: {col: number, row: number}}} anchor
 * @property {ChartData} chart
 */

// ────────────────────────────────────────────────────────────────────────────
// 自 format.ts 内联：A1 range 解析（保持库自包含）
// ────────────────────────────────────────────────────────────────────────────

/** 列字母 → 1-based 列号（A=1, Z=26, AA=27） */
function colToIndex(letters) {
  if (letters.length === 0) throw new Error('非法列字母: (空串)');
  let n = 0;
  for (const ch of letters.toUpperCase()) {
    const code = ch.charCodeAt(0);
    if (code < 65 || code > 90) throw new Error(`非法列字母: ${letters}`);
    n = n * 26 + (code - 64);
  }
  return n;
}

const RANGE_RE = /^\$?([A-Za-z]{1,3})\$?([1-9][0-9]{0,6})(?::\$?([A-Za-z]{1,3})\$?([1-9][0-9]{0,6}))?$/;

/**
 * A1 记法解析：'A1'（ends null）或 'A1:F50'（ends 有值，保证 start<=end）。
 * @param {string} range
 * @returns {{startRow: number, startCol: number, endRow: number|null, endCol: number|null}}
 */
function parseRange(range) {
  const m = RANGE_RE.exec(range.trim());
  if (!m) throw new Error(`非法 range: "${range}"（示例：A1 或 A1:F50）`);
  const startCol = colToIndex(m[1] ?? '');
  const startRow = Number(m[2] ?? '0');
  const endCol = m[3] !== undefined ? colToIndex(m[3]) : null;
  const endRow = m[4] !== undefined ? Number(m[4]) : null;
  if (endCol !== null && endRow !== null && (endRow < startRow || endCol < startCol)) {
    throw new Error(`非法 range: "${range}"（终点必须不小于起点）`);
  }
  return { startRow, startCol, endRow, endCol };
}

// ────────────────────────────────────────────────────────────────────────────
// 自 chart-xml.ts 移植：图表 XML 纯函数生成（无 IO / 无 side effect）
// ────────────────────────────────────────────────────────────────────────────

/** XML 元素转义：& 必须先替换，避免双重转义。
 * @param {string} s
 * @returns {string}
 */
function xmlEscape(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// 列号(1-based) → 列字母（A=1, Z=26, AA=27）。parseRange 的反向。
function indexToCol(idx) {
  let s = '';
  while (idx > 0) {
    idx--;
    s = String.fromCharCode(65 + (idx % 26)) + s;
    idx = Math.floor(idx / 26);
  }
  return s;
}

/**
 * sheet 名 + A1 range → 'sheet'!$A$1:$B$5 形态（表名一律加单引号，内部 ' 双写）。
 * 解析与大小写归一委托给 parseRange。
 * @param {string} sheet
 * @param {string} range
 * @returns {string}
 */
function sheetAbsRef(sheet, range) {
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

/** @param {ChartSeriesData} s @returns {string} */
function buildTxXml(s) {
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

// bar / line 默认黑色细线（9525 EMU = 0.75pt，与 openpyxl 默认一致）；pie 无描边。
// 系列色：solidFill 置于 ln 之前；pie 无色时保持无 spPr。
/** @param {ChartType} type @param {string} [color] @returns {string} */
function buildSpPrXml(type, color) {
  const fill = color !== undefined ? `<a:solidFill><a:srgbClr val="${color}"/></a:solidFill>` : '';
  if (type === 'pie') return fill === '' ? '' : `<c:spPr>${fill}</c:spPr>`;
  return `<c:spPr>
    ${fill}<a:ln w="9525">
      <a:solidFill><a:srgbClr val="000000"/></a:solidFill>
    </a:ln>
  </c:spPr>`;
}

/**
 * 逐数据点着色 c:dPt×N：按 index 升序输出（OOXML 惯例次序），每项 idx + spPr solidFill。
 * OOXML CT_BarSer/CT_LineSer/CT_PieSer 均允许 dPt 位于 spPr（line 为 marker）与 cat
 * 之间——由 buildSeriesXml 的拼接次序保证。
 * @param {DataPointColor[]} items
 * @returns {string}
 */
function buildDPtXml(items) {
  return [...items]
    .sort((a, b) => a.index - b.index)
    .map(
      (d) =>
        `<c:dPt><c:idx val="${d.index}"/><c:spPr><a:solidFill><a:srgbClr val="${d.color}"/></a:solidFill></c:spPr></c:dPt>`,
    )
    .join('');
}

function buildMarkerXml() {
  return `<c:marker>
    <c:symbol val="circle"/>
    <c:size val="5"/>
  </c:marker>`;
}

/**
 * numCache 子树：null 点省略 c:pt、ptCount 保持全长、formatCode 缺省 General。
 * @param {Array.<number|null>} values
 * @param {string} [formatCode]
 * @returns {string}
 */
function buildNumCacheXml(values, formatCode = 'General') {
  const pts = values
    .map((v, i) => (v === null ? '' : `<c:pt idx="${i}"><c:v>${v}</c:v></c:pt>`))
    .join('');
  return `<c:numCache><c:formatCode>${xmlEscape(formatCode)}</c:formatCode><c:ptCount val="${values.length}"/>${pts}</c:numCache>`;
}

/**
 * strCache 子树：语义同 buildNumCacheXml（文本侧，无 formatCode）。
 * @param {Array.<string|null>} values
 * @returns {string}
 */
function buildStrCacheXml(values) {
  const pts = values
    .map((v, i) => (v === null ? '' : `<c:pt idx="${i}"><c:v>${xmlEscape(v)}</c:v></c:pt>`))
    .join('');
  return `<c:strCache><c:ptCount val="${values.length}"/>${pts}</c:strCache>`;
}

/** @param {ChartSeriesData} s @returns {string} */
function buildCatXml(s) {
  return `<c:cat>
    <c:strRef>
      <c:f>${xmlEscape(s.catRef)}</c:f>
      ${buildStrCacheXml(s.catCache)}
    </c:strRef>
  </c:cat>`;
}

/** @param {ChartSeriesData} s @returns {string} */
function buildValXml(s) {
  return `<c:val>
    <c:numRef>
      <c:f>${xmlEscape(s.valRef)}</c:f>
      ${buildNumCacheXml(s.valCache)}
    </c:numRef>
  </c:val>`;
}

/**
 * 单 ser 组装。次序：idx → order → tx → spPr →（line: marker）→ dPt×N → cat → val
 * （OOXML CT_*Ser 元素次序；dPt 由 dataPointColors 生成，逐 ser 应用）
 * @param {ChartSeriesData} s
 * @param {number} idx
 * @param {ChartType} type
 * @param {DataPointColor[]} [pointColors]
 * @returns {string}
 */
function buildSeriesXml(s, idx, type, pointColors) {
  const txXml = buildTxXml(s);
  const spPrXml = buildSpPrXml(type, s.color);
  const markerXml = type === 'line' ? buildMarkerXml() : '';
  const dPtXml = pointColors !== undefined && pointColors.length > 0 ? buildDPtXml(pointColors) : '';
  const catXml = buildCatXml(s);
  const valXml = buildValXml(s);
  return `<c:ser>
    <c:idx val="${idx}"/>
    <c:order val="${idx}"/>
    ${txXml}
    ${spPrXml}
    ${markerXml}
    ${dPtXml}
    ${catXml}
    ${valXml}
  </c:ser>`;
}

/** @param {ChartData} data @returns {string} */
function buildBarChartBody(data) {
  const barDir = data.type === 'bar_h' ? 'bar' : 'col';
  const sers = data.series.map((s, i) => buildSeriesXml(s, i, data.type, data.dataPointColors)).join('');
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

/** @param {ChartData} data @returns {string} */
function buildLineChartBody(data) {
  const sers = data.series.map((s, i) => buildSeriesXml(s, i, data.type, data.dataPointColors)).join('');
  return `<c:lineChart>
    <c:grouping val="standard"/>
    <c:varyColors val="0"/>
    ${sers}
    <c:marker val="1"/>
    <c:axId val="${CAT_AX_ID}"/>
    <c:axId val="${VAL_AX_ID}"/>
  </c:lineChart>`;
}

/** @param {ChartData} data @returns {string} */
function buildPieChartBody(data) {
  const sers = data.series.map((s, i) => buildSeriesXml(s, i, data.type, data.dataPointColors)).join('');
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

/** @param {ChartData} data @returns {string} */
function buildChartTypeBody(data) {
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

/** @param {ChartType} type @returns {string} */
function buildCatAx(type) {
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

/** @param {ChartType} type @returns {string} */
function buildValAx(type) {
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

/** @param {string} title @returns {string} */
function buildTitleXml(title) {
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

/**
 * 组装完整 chartSpace XML（c:chartSpace > c:chart > [...title, autoTitleDeleted, plotArea, plotVisOnly, dispBlanksAs]）。
 * 元素次序严格按 openpyxl schema。
 * @param {ChartData} data
 * @returns {string}
 */
function buildChartXml(data) {
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

/**
 * 组装 drawing twoCellAnchor 片段（不含根 xmlns：调用方需在根节点声明 xmlns:xdr/a/r/c）。
 * graphicFrame 显式闭合后才接 xdr:clientData；c:chart 用 r:id 指向 chart 关系。
 * 排雷铁律 #1：根节点必须声明 xmlns:r（openpyxl 校验 unbound prefix）。
 * @param {AnchorSpec} anchor
 * @param {string} chartRid
 * @param {number} frameId
 * @returns {string}
 */
function buildAnchorXml(anchor, chartRid, frameId) {
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

// ────────────────────────────────────────────────────────────────────────────
// 自 xlsx-zip.ts 移植：xlsx zip 层图表部件操作（注入与保真底座）。
// 与内核同款字符串级 rels 操作（<Relationship .../> 数组化增删再重组），不引 DOM
// 解析——xlsx 部件 XML 结构稳定，字符串手法可控且零依赖。
// 实证依据（内核 PoC 复核）：exceljs 可 load 含 graphicFrame 锚点的注入产物；
// adm-zip updateFile 对不存在条目是静默 no-op——所有写入必须走 upsertFile。
// ────────────────────────────────────────────────────────────────────────────

const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const REL_DRAWING = `${REL_NS}/drawing`;
const REL_CHART = `${REL_NS}/chart`;
const PKG_REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const CT_DRAWING = 'application/vnd.openxmlformats-officedocument.drawing+xml';
const CT_CHART = 'application/vnd.openxmlformats-officedocument.drawingml.chart+xml';
const XDR_NS = 'http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing';
const A_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main';

/**
 * 取 XML 标签内某属性值（限定名属性如 r:id 用 \b 前界匹配）；无则 null。
 * @param {string} tag
 * @param {string} attrName
 * @returns {string|null}
 */
function attrValue(tag, attrName) {
  const m = tag.match(new RegExp(`\\b${attrName}="([^"]*)"`));
  return m === null || m[1] === undefined ? null : m[1];
}

/** XML 属性值反转义（&amp; 必须最后替换，避免 &amp;lt; 被二次解开） */
function xmlUnescapeAttr(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * rels XML → Relationship 条目数组（内核 P0 sanitize 同款手法）。
 * @param {string} xml
 * @returns {Array.<{id: string, type: string, target: string, raw: string}>}
 */
function parseRels(xml) {
  return (xml.match(/<Relationship\b[^>]*\/>/g) ?? []).map((raw) => ({
    raw,
    id: attrValue(raw, 'Id') ?? '',
    type: attrValue(raw, 'Type') ?? '',
    target: attrValue(raw, 'Target') ?? '',
  }));
}

/**
 * Relationship 条目数组 → rels XML（整文件重组）。
 * @param {Array.<{id: string, type: string, target: string, raw: string}>} rels
 * @returns {string}
 */
function buildRelsXml(rels) {
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<Relationships xmlns="${PKG_REL_NS}">` +
    rels.map((r) => r.raw).join('') +
    `</Relationships>`
  );
}

/** 在已占用 Id 集合之外取最小 rIdN */
function nextRid(taken) {
  let n = 1;
  while (taken.has(`rId${n}`)) n++;
  return `rId${n}`;
}

/** 部件路径 → 对应 rels 路径（xl/worksheets/sheet1.xml → xl/worksheets/_rels/sheet1.xml.rels） */
function relsPathFor(partPath) {
  const idx = partPath.lastIndexOf('/');
  if (idx < 0) return `_rels/${partPath}.rels`;
  return `${partPath.slice(0, idx)}/_rels/${partPath.slice(idx + 1)}.rels`;
}

/** rels 路径 → 所属部件路径（relsPathFor 的逆） */
function partPathOfRels(relsPath) {
  const m = relsPath.match(/^(.*)\/_rels\/([^/]+)\.rels$/);
  return m === null ? relsPath : `${m[1]}/${m[2]}`;
}

/** 目录路径 */
function dirName(p) {
  const idx = p.lastIndexOf('/');
  return idx < 0 ? '' : p.slice(0, idx);
}

/**
 * rels Target 归一为 zip 内完整路径：相对 baseDir 解析（Target 以 / 开头为包内绝对路径）。
 * @param {string} baseDir
 * @param {string} target
 * @returns {string}
 */
function normalizeOfficePath(baseDir, target) {
  const raw = target.startsWith('/') ? target.slice(1) : `${baseDir}/${target}`;
  const out = [];
  for (const seg of raw.split('/')) {
    if (seg === '..') out.pop();
    else if (seg !== '.' && seg !== '') out.push(seg);
  }
  return out.join('/');
}

/** adm-zip updateFile 对不存在条目静默 no-op（实证）——写入必须先判存在 */
function upsertFile(zip, name, data) {
  if (zip.getEntry(name) !== null) zip.updateFile(name, data);
  else zip.addFile(name, data);
}

/** drawing XML 内既有 cNvPr id 最大值（新锚点 frameId 从其后续编） */
function maxCnvPrId(drawingXml) {
  let max = 0;
  const re = /<xdr:cNvPr\b[^>]*\bid="(\d+)"/g;
  let m = re.exec(drawingXml);
  while (m !== null) {
    const digits = m[1] ?? '0';
    const n = parseInt(digits, 10);
    if (n > max) max = n;
    m = re.exec(drawingXml);
  }
  return max;
}

/**
 * anchorXml 重指派：chart r:id → 注入时实际分配的 drawing-rels Id；
 * cNvPr id → 续编后的唯一 frameId。调用方按契约传入即可，带占位值时由本层
 * 兜底改写，保证 rels 与锚点永远一致。
 */
function rebindAnchorRids(anchorXml, chartRid, frameId) {
  return anchorXml
    .replace(/(<c:chart\b[^>]*\br:id=")[^"]*(")/, `$1${chartRid}$2`)
    .replace(/(<xdr:cNvPr\b[^>]*\bid=")\d+(")/, `$1${frameId}$2`);
}

/** sheet XML 根标签缺 xmlns:r 声明时补上（<drawing r:id> 前缀依赖；exceljs 产物恒有，防御其他生产者） */
function ensureRelNamespace(sheetXml) {
  const root = sheetXml.match(/<worksheet\b[^>]*>/);
  if (root === null || /xmlns:r=/.test(root[0])) return sheetXml;
  return sheetXml.replace(/<worksheet\b/, `<worksheet xmlns:r="${REL_NS}"`);
}

/** ContentTypes 补缺失 Override（按 PartName 去重；[Content_Types].xml 缺失时跳过） */
function appendContentOverrides(zip, overrides) {
  if (overrides.length === 0) return;
  const ctName = '[Content_Types].xml';
  if (zip.getEntry(ctName) === null) return;
  const xml = zip.readAsText(ctName);
  const present = new Set(
    (xml.match(/<Override\b[^>]*\/>/g) ?? [])
      .map((o) => attrValue(o, 'PartName'))
      .filter((v) => v !== null),
  );
  const missing = overrides.filter((o) => {
    const pn = attrValue(o, 'PartName');
    return pn !== null && !present.has(pn);
  });
  if (missing.length === 0) return;
  zip.updateFile(ctName, Buffer.from(xml.replace('</Types>', `${missing.join('')}</Types>`), 'utf8'));
}

function drawingOverrideXml(partPath) {
  return `<Override PartName="/${partPath}" ContentType="${CT_DRAWING}"/>`;
}

function chartOverrideXml(partPath) {
  return `<Override PartName="/${partPath}" ContentType="${CT_CHART}"/>`;
}

/**
 * sheet 显示名 → 'xl/worksheets/sheetN.xml'。
 * workbook.xml 的 <sheet name r:id>（属性次序不定，逐标签解析）+
 * xl/_rels/workbook.xml.rels 的 r:id → Target 归一；找不到返回 null。
 * @param {import('adm-zip')} zip
 * @param {string} sheetName
 * @returns {string|null}
 */
function resolveSheetFile(zip, sheetName) {
  if (zip.getEntry('xl/workbook.xml') === null) return null;
  const sheetTag = (zip.readAsText('xl/workbook.xml').match(/<sheet\b[^>]*\/>/g) ?? []).find((t) => {
    const name = attrValue(t, 'name');
    return name !== null && xmlUnescapeAttr(name) === sheetName;
  });
  if (sheetTag === undefined) return null;
  const rid = attrValue(sheetTag, 'r:id');
  if (rid === null) return null;
  if (zip.getEntry('xl/_rels/workbook.xml.rels') === null) return null;
  const rel = parseRels(zip.readAsText('xl/_rels/workbook.xml.rels')).find((r) => r.id === rid);
  if (rel === undefined) return null;
  return normalizeOfficePath('xl', rel.target);
}

/**
 * 图表部件快照：内核 sanitizeXlsxForRead 的镜像收集版（收集而非丢弃）。
 * @typedef {Object} ChartPartsSnapshot
 * @property {Array.<{name: string, data: Buffer}>} parts drawings/charts/media 部件原字节
 * @property {Array.<{name: string, data: Buffer}>} sheetRels 含 drawing 条目的整个 sheet rels 文件原文
 * @property {Array.<{sheet: string, tag: string}>} sheetDrawingTags sheet XML 中被剥的 <drawing r:id="..."/> 标签原文
 * @property {string[]} contentOverrides 原 [Content_Types].xml 中与上述部件相关的 Override 行原文
 */

/**
 * 快照 xlsx 内全部 drawing/chart/media 侧内容（exceljs 重写前调用）。
 * @param {Buffer} buf
 * @returns {ChartPartsSnapshot}
 */
function snapshotChartParts(buf) {
  const zip = new AdmZip(buf);
  const parts = [];
  const sheetRels = [];
  const sheetDrawingTags = [];

  for (const e of zip.getEntries()) {
    if (e.isDirectory) continue;
    const name = e.entryName;
    if (
      name.startsWith('xl/drawings/') ||
      name.startsWith('xl/charts/') ||
      name.startsWith('xl/media/')
    ) {
      parts.push({ name, data: e.getData() });
    } else if (/^xl\/worksheets\/_rels\/sheet\d+\.xml\.rels$/.test(name)) {
      // 整文件快照，但仅当确实含 drawing 条目（纯 hyperlink rels 与图表保真无关）
      const xml = zip.readAsText(name);
      if (parseRels(xml).some((r) => r.type.endsWith('/drawing'))) {
        sheetRels.push({ name, data: Buffer.from(xml, 'utf8') });
      }
    } else if (/^xl\/worksheets\/sheet\d+\.xml$/.test(name)) {
      for (const tag of zip.readAsText(name).match(/<drawing\b[^>]*\/>/g) ?? []) {
        sheetDrawingTags.push({ sheet: name, tag });
      }
    }
  }

  const ctEntry = zip.getEntry('[Content_Types].xml');
  const contentOverrides =
    ctEntry === null
      ? []
      : (zip.readAsText('[Content_Types].xml').match(/<Override\b[^>]*\/>/g) ?? []).filter((o) => {
          const pn = attrValue(o, 'PartName') ?? '';
          return (
            pn.startsWith('/xl/drawings/') ||
            pn.startsWith('/xl/charts/') ||
            pn.startsWith('/xl/media/')
          );
        });

  return { parts, sheetRels, sheetDrawingTags, contentOverrides };
}

/**
 * 回注快照（exceljs 重写后调用）：
 * 1. parts 原字节回写；2. 每个 sheet rels 只把快照的 drawing 条目合并进当前文件
 * （无文件则整写）——Id 与既有条目冲突时重命名为未占用 rIdM，并同步改 sheet XML
 * 里 drawing 标签的 r:id；3. drawing 标签在 </worksheet> 前回插；4. ContentTypes 补缺。
 * ⚠️ 内核契约随迁：仅限「快照 → exceljs 重写 → 回注」管线内单次调用，外部不得复用。
 * @param {Buffer} buf
 * @param {ChartPartsSnapshot} snap
 * @returns {Buffer}
 */
function restoreChartParts(buf, snap) {
  const zip = new AdmZip(buf);

  for (const p of snap.parts) zip.addFile(p.name, p.data);

  // sheet rels 合并 + 冲突重命名（重命名映射按 sheet 隔离，两 sheet 各自 rId1 互不干扰）
  const renamesBySheet = new Map();
  for (const sr of snap.sheetRels) {
    const drawingRels = parseRels(sr.data.toString('utf8')).filter((r) => r.type.endsWith('/drawing'));
    if (drawingRels.length === 0) continue;
    const sheetFile = partPathOfRels(sr.name);
    const current = zip.getEntry(sr.name) !== null ? parseRels(zip.readAsText(sr.name)) : [];
    const taken = new Set(current.map((r) => r.id));
    const renameMap = new Map();
    const merged = [...current];
    for (const d of drawingRels) {
      let id = d.id;
      if (taken.has(id)) {
        id = nextRid(taken);
        renameMap.set(d.id, id);
      }
      taken.add(id);
      merged.push(
        id === d.id ? d : { ...d, id, raw: d.raw.replace(/\bId="[^"]*"/, `Id="${id}"`) },
      );
    }
    renamesBySheet.set(sheetFile, renameMap);
    upsertFile(zip, sr.name, Buffer.from(buildRelsXml(merged), 'utf8'));
  }

  // drawing 标签回插（r:id 按重命名映射同步；sheet 本体已不存在则跳过）
  for (const { sheet, tag } of snap.sheetDrawingTags) {
    if (zip.getEntry(sheet) === null) continue;
    const renameMap = renamesBySheet.get(sheet);
    let finalTag = tag;
    if (renameMap !== undefined) {
      const rid = tag.match(/\br:id="([^"]*)"/);
      const oldRid = rid === null ? undefined : rid[1];
      const mapped = oldRid === undefined ? undefined : renameMap.get(oldRid);
      if (oldRid !== undefined && mapped !== undefined) {
        finalTag = tag.replace(`r:id="${oldRid}"`, `r:id="${mapped}"`);
      }
    }
    const xml = ensureRelNamespace(zip.readAsText(sheet));
    zip.updateFile(sheet, Buffer.from(xml.replace(/<\/worksheet>/, `${finalTag}</worksheet>`), 'utf8'));
  }

  appendContentOverrides(zip, snap.contentOverrides);
  return zip.toBuffer();
}

/**
 * 向目标 sheet 注入图表。
 * charts[i].chartXml = 完整 chartSpace XML；charts[i].anchorXml = twoCellAnchor 片段
 * （chart r:id 与 cNvPr id 由本层重指派为实际分配值，调用方可传占位值）。
 * 目标 sheet 无 drawing → 新建 drawingN/双 rels/sheet 标签/ContentTypes；
 * 已有 drawing → 锚点并入既有 wsDr 尾部、drawing rels 追加、sheet rels 不动。
 * @param {Buffer} buf
 * @param {string} sheetFile
 * @param {Array.<{chartXml: string, anchorXml: string}>} charts
 * @returns {Buffer}
 */
function injectCharts(buf, sheetFile, charts) {
  if (charts.length === 0) return buf;
  const zip = new AdmZip(buf);

  // 部件编号：既有 drawing/chart 最大号 + 1 起编
  let maxDrawing = 0;
  let maxChart = 0;
  for (const e of zip.getEntries()) {
    const d = e.entryName.match(/^xl\/drawings\/drawing(\d+)\.xml$/);
    if (d !== null) maxDrawing = Math.max(maxDrawing, parseInt(d[1] ?? '0', 10));
    const c = e.entryName.match(/^xl\/charts\/chart(\d+)\.xml$/);
    if (c !== null) maxChart = Math.max(maxChart, parseInt(c[1] ?? '0', 10));
  }

  // 目标 sheet 现有 drawing 关系（有 → 合并模式）
  const sheetRelsName = relsPathFor(sheetFile);
  const sheetRels = zip.getEntry(sheetRelsName) !== null ? parseRels(zip.readAsText(sheetRelsName)) : [];
  const existingDrawingRel = sheetRels.find((r) => r.type.endsWith('/drawing'));

  let drawingFile;
  let drawingRelsName;
  let drawingRels;
  let maxFrame;
  if (existingDrawingRel !== undefined) {
    drawingFile = normalizeOfficePath(dirName(sheetFile), existingDrawingRel.target);
    drawingRelsName = relsPathFor(drawingFile);
    drawingRels =
      zip.getEntry(drawingRelsName) !== null ? parseRels(zip.readAsText(drawingRelsName)) : [];
    maxFrame = zip.getEntry(drawingFile) !== null ? maxCnvPrId(zip.readAsText(drawingFile)) : 0;
  } else {
    maxDrawing += 1;
    drawingFile = `xl/drawings/drawing${maxDrawing}.xml`;
    drawingRelsName = relsPathFor(drawingFile);
    drawingRels = [];
    maxFrame = 0;
  }

  // 每 chart：新部件 + drawing rels 条目 + 重指派后的锚点
  const anchorParts = [];
  const newOverrides = [];
  for (const chart of charts) {
    maxChart += 1;
    const chartFile = `xl/charts/chart${maxChart}.xml`;
    zip.addFile(chartFile, Buffer.from(chart.chartXml, 'utf8'));
    newOverrides.push(chartOverrideXml(chartFile));
    const rid = nextRid(new Set(drawingRels.map((r) => r.id)));
    drawingRels.push({
      id: rid,
      type: REL_CHART,
      target: `../charts/chart${maxChart}.xml`,
      raw: `<Relationship Id="${rid}" Type="${REL_CHART}" Target="../charts/chart${maxChart}.xml"/>`,
    });
    maxFrame += 1;
    anchorParts.push(rebindAnchorRids(chart.anchorXml, rid, maxFrame));
  }
  upsertFile(zip, drawingRelsName, Buffer.from(buildRelsXml(drawingRels), 'utf8'));

  if (existingDrawingRel === undefined) {
    // 新建 drawing 部件。根节点三命名空间齐全（xdr/a/r）——排雷铁律：
    // openpyxl 对 unbound prefix 校验失败；c 命名空间由 buildAnchorXml 的 c:chart 局部声明。
    const wsDr =
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<xdr:wsDr xmlns:xdr="${XDR_NS}" xmlns:a="${A_NS}" xmlns:r="${REL_NS}">` +
      `${anchorParts.join('')}` +
      `</xdr:wsDr>`;
    zip.addFile(drawingFile, Buffer.from(wsDr, 'utf8'));

    // sheet rels 追加 drawing 引用 + sheet XML 插 <drawing/> 标签
    const sheetRid = nextRid(new Set(sheetRels.map((r) => r.id)));
    sheetRels.push({
      id: sheetRid,
      type: REL_DRAWING,
      target: `../drawings/drawing${maxDrawing}.xml`,
      raw: `<Relationship Id="${sheetRid}" Type="${REL_DRAWING}" Target="../drawings/drawing${maxDrawing}.xml"/>`,
    });
    upsertFile(zip, sheetRelsName, Buffer.from(buildRelsXml(sheetRels), 'utf8'));
    const sheetXml = ensureRelNamespace(zip.readAsText(sheetFile));
    zip.updateFile(
      sheetFile,
      Buffer.from(sheetXml.replace(/<\/worksheet>/, `<drawing r:id="${sheetRid}"/></worksheet>`), 'utf8'),
    );
    newOverrides.push(drawingOverrideXml(drawingFile));
  } else {
    // 合并：锚点片段插到既有 wsDr 尾部（sheet rels 与 drawing Override 已有，不动）
    const drawingXml = zip.readAsText(drawingFile);
    zip.updateFile(
      drawingFile,
      Buffer.from(drawingXml.replace(/<\/xdr:wsDr>/, `${anchorParts.join('')}</xdr:wsDr>`), 'utf8'),
    );
  }

  appendContentOverrides(zip, newOverrides);
  return zip.toBuffer();
}

// ────────────────────────────────────────────────────────────────────────────
// 插件组合层（新增强口）：内核 excel.ts add_chart 编排的库能力等价物——
// op 解析不迁，agent 直接传 spec 对象
// ────────────────────────────────────────────────────────────────────────────

/**
 * 向 xlsx 注入一张图表：sheet 显示名定位 → chartSpace/drawing 锚点构建 → zip 手术。
 * 与内核注入路径同构（resolveSheetFile + buildChartXml + buildAnchorXml + injectCharts）；
 * chart r:id 与 cNvPr id 传占位值，由注入层无条件重指派为实际分配值。
 * @param {Buffer} xlsxBuffer
 * @param {XlsxChartSpec} spec
 * @returns {Buffer}
 */
function injectXlsxChart(xlsxBuffer, spec) {
  const zip = new AdmZip(xlsxBuffer);
  const sheetFile = resolveSheetFile(zip, spec.sheetName);
  if (sheetFile === null) throw new Error(`sheet 不存在: ${spec.sheetName}`);
  const chartXml = buildChartXml(spec.chart);
  const anchorXml = buildAnchorXml(
    {
      fromCol: spec.anchor.from.col,
      fromRow: spec.anchor.from.row,
      toCol: spec.anchor.to.col,
      toRow: spec.anchor.to.row,
    },
    'rIdPLACE', // 占位：注入层无条件重指派为实际分配的 drawing-rels Id
    0,
  );
  return injectCharts(xlsxBuffer, sheetFile, [{ chartXml, anchorXml }]);
}

module.exports = {
  xmlEscape,
  sheetAbsRef,
  buildNumCacheXml,
  buildStrCacheXml,
  buildChartXml,
  buildAnchorXml,
  resolveSheetFile,
  snapshotChartParts,
  restoreChartParts,
  injectCharts,
  injectXlsxChart,
};
