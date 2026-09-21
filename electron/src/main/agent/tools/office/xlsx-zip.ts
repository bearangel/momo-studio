// xlsx zip 层图表部件操作（office_write_excel add_chart 的注入与保真底座）。
// 设计取舍：与 P0 sanitizeXlsxForRead 同款字符串级 rels 操作（<Relationship .../> 数组化
// 增删再重组），不引 DOM 解析——xlsx 部件 XML 结构稳定，字符串手法可控且零依赖。
// 入口：
//   resolveSheetFile     sheet 显示名 → sheetN.xml 路径（workbook.xml + workbook rels）
//   snapshotChartParts   exceljs 重写前快照 drawing/chart/media 侧（镜像 sanitize 的收集版）
//   restoreChartParts    exceljs 重写后回注快照（rels 合并 + Id 冲突重命名 + ContentTypes 补缺）
//   injectCharts         向目标 sheet 注入新图表（无 drawing 新建 / 已有 drawing 合并锚点）
//   parseChartRef        c:f 引用解析（'表'!$A$1:$A$5 → { sheet, range }）
//   refreshChartCaches   全部 chart 部件缓存重算（spec §14.6 P1a，字符串分段替换）
// 实证依据（PoC 复核）：exceljs 可 load 含 graphicFrame 锚点的注入产物；
// adm-zip updateFile 对不存在条目是静默 no-op——所有写入必须走 upsertFile。
// refreshChartCaches 不用 cheerio round-trip 而用字符串分段替换：DOM 序列化会重排
// 属性/空白/自闭合形态，破坏「其余节点字节不变」的保真红线；缓存子树重建复用
// chart-xml 的 buildNumCacheXml/buildStrCacheXml，保证值未变时字节同构（幂等）。

import AdmZip from 'adm-zip';
import { parseRange } from './format';
import { buildNumCacheXml, buildStrCacheXml } from './chart-xml';

const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const REL_DRAWING = `${REL_NS}/drawing`;
const REL_CHART = `${REL_NS}/chart`;
const PKG_REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const CT_DRAWING = 'application/vnd.openxmlformats-officedocument.drawing+xml';
const CT_CHART = 'application/vnd.openxmlformats-officedocument.drawingml.chart+xml';
const XDR_NS = 'http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing';
const A_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main';

// ────────────────────────────────────────────────────────────────────────────
// 内部工具：XML / 路径 / rels 字符串级操作
// ────────────────────────────────────────────────────────────────────────────

/** 取 XML 标签内某属性值（限定名属性如 r:id 用 \b 前界匹配）；无则 null */
function attrValue(tag: string, attrName: string): string | null {
  const m = tag.match(new RegExp(`\\b${attrName}="([^"]*)"`));
  return m === null || m[1] === undefined ? null : m[1];
}

/** XML 属性值反转义（&amp; 必须最后替换，避免 &amp;lt; 被二次解开） */
function xmlUnescapeAttr(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

interface RelEntry {
  id: string;
  type: string;
  target: string;
  /** Relationship 标签原文（重组时原样保留未知属性） */
  raw: string;
}

/** rels XML → Relationship 条目数组（P0 sanitize 同款手法） */
function parseRels(xml: string): RelEntry[] {
  return (xml.match(/<Relationship\b[^>]*\/>/g) ?? []).map((raw) => ({
    raw,
    id: attrValue(raw, 'Id') ?? '',
    type: attrValue(raw, 'Type') ?? '',
    target: attrValue(raw, 'Target') ?? '',
  }));
}

/** Relationship 条目数组 → rels XML（整文件重组） */
function buildRelsXml(rels: RelEntry[]): string {
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<Relationships xmlns="${PKG_REL_NS}">` +
    rels.map((r) => r.raw).join('') +
    `</Relationships>`
  );
}

/** 在已占用 Id 集合之外取最小 rIdN */
function nextRid(taken: ReadonlySet<string>): string {
  let n = 1;
  while (taken.has(`rId${n}`)) n++;
  return `rId${n}`;
}

/** 部件路径 → 对应 rels 路径（xl/worksheets/sheet1.xml → xl/worksheets/_rels/sheet1.xml.rels） */
function relsPathFor(partPath: string): string {
  const idx = partPath.lastIndexOf('/');
  if (idx < 0) return `_rels/${partPath}.rels`;
  return `${partPath.slice(0, idx)}/_rels/${partPath.slice(idx + 1)}.rels`;
}

/** rels 路径 → 所属部件路径（relsPathFor 的逆） */
function partPathOfRels(relsPath: string): string {
  const m = relsPath.match(/^(.*)\/_rels\/([^/]+)\.rels$/);
  return m === null ? relsPath : `${m[1]}/${m[2]}`;
}

/** 目录路径 */
function dirName(p: string): string {
  const idx = p.lastIndexOf('/');
  return idx < 0 ? '' : p.slice(0, idx);
}

/** rels Target 归一为 zip 内完整路径：相对 baseDir 解析（Target 以 / 开头为包内绝对路径） */
function normalizeOfficePath(baseDir: string, target: string): string {
  const raw = target.startsWith('/') ? target.slice(1) : `${baseDir}/${target}`;
  const out: string[] = [];
  for (const seg of raw.split('/')) {
    if (seg === '..') out.pop();
    else if (seg !== '.' && seg !== '') out.push(seg);
  }
  return out.join('/');
}

/** adm-zip updateFile 对不存在条目静默 no-op（实证）——写入必须先判存在 */
function upsertFile(zip: AdmZip, name: string, data: Buffer): void {
  if (zip.getEntry(name) !== null) zip.updateFile(name, data);
  else zip.addFile(name, data);
}

/** drawing XML 内既有 cNvPr id 最大值（新锚点 frameId 从其后续编） */
function maxCnvPrId(drawingXml: string): number {
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

/** anchorXml 重指派：chart r:id → 注入时实际分配的 drawing-rels Id；
 *  cNvPr id → 续编后的唯一 frameId。调用方（Task 3）按契约传入即可，
 *  带占位值时由本层兜底改写，保证 rels 与锚点永远一致（brief 明示允许）。 */
function rebindAnchorRids(anchorXml: string, chartRid: string, frameId: number): string {
  return anchorXml
    .replace(/(<c:chart\b[^>]*\br:id=")[^"]*(")/, `$1${chartRid}$2`)
    .replace(/(<xdr:cNvPr\b[^>]*\bid=")\d+(")/, `$1${frameId}$2`);
}

/** sheet XML 根标签缺 xmlns:r 声明时补上（<drawing r:id> 前缀依赖；exceljs 产物恒有，防御其他生产者） */
function ensureRelNamespace(sheetXml: string): string {
  const root = sheetXml.match(/<worksheet\b[^>]*>/);
  if (root === null || /xmlns:r=/.test(root[0])) return sheetXml;
  return sheetXml.replace(/<worksheet\b/, `<worksheet xmlns:r="${REL_NS}"`);
}

/** ContentTypes 补缺失 Override（按 PartName 去重；[Content_Types].xml 缺失时跳过） */
function appendContentOverrides(zip: AdmZip, overrides: string[]): void {
  if (overrides.length === 0) return;
  const ctName = '[Content_Types].xml';
  if (zip.getEntry(ctName) === null) return;
  const xml = zip.readAsText(ctName);
  const present = new Set(
    (xml.match(/<Override\b[^>]*\/>/g) ?? [])
      .map((o) => attrValue(o, 'PartName'))
      .filter((v): v is string => v !== null),
  );
  const missing = overrides.filter((o) => {
    const pn = attrValue(o, 'PartName');
    return pn !== null && !present.has(pn);
  });
  if (missing.length === 0) return;
  zip.updateFile(ctName, Buffer.from(xml.replace('</Types>', `${missing.join('')}</Types>`), 'utf8'));
}

function drawingOverrideXml(partPath: string): string {
  return `<Override PartName="/${partPath}" ContentType="${CT_DRAWING}"/>`;
}

function chartOverrideXml(partPath: string): string {
  return `<Override PartName="/${partPath}" ContentType="${CT_CHART}"/>`;
}

// ────────────────────────────────────────────────────────────────────────────
// 公开接口
// ────────────────────────────────────────────────────────────────────────────

/** sheet 显示名 → 'xl/worksheets/sheetN.xml'。
 *  workbook.xml 的 <sheet name r:id>（属性次序不定，逐标签解析）+
 *  xl/_rels/workbook.xml.rels 的 r:id → Target 归一；找不到返回 null。 */
export function resolveSheetFile(zip: AdmZip, sheetName: string): string | null {
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

/** 图表部件快照：sanitizeXlsxForRead 的镜像收集版（收集而非丢弃） */
export interface ChartPartsSnapshot {
  /** drawings/charts/media 部件原字节（entryName → data） */
  parts: Array<{ name: string; data: Buffer }>;
  /** 含 drawing 条目的整个 sheet rels 文件原文（回注时只取 drawing 侧合并） */
  sheetRels: Array<{ name: string; data: Buffer }>;
  /** sheet XML 中被剥的 <drawing r:id="..."/> 标签原文 */
  sheetDrawingTags: Array<{ sheet: string; tag: string }>;
  /** 原 [Content_Types].xml 中与上述部件相关的 Override 行原文 */
  contentOverrides: string[];
}

/** 快照 xlsx 内全部 drawing/chart/media 侧内容（exceljs 重写前调用） */
export function snapshotChartParts(buf: Buffer): ChartPartsSnapshot {
  const zip = new AdmZip(buf);
  const parts: Array<{ name: string; data: Buffer }> = [];
  const sheetRels: Array<{ name: string; data: Buffer }> = [];
  const sheetDrawingTags: Array<{ sheet: string; tag: string }> = [];

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

/** 回注快照（exceljs 重写后调用）：
 *  1. parts 原字节回写；2. 每个 sheet rels 只把快照的 drawing 条目合并进当前文件
 *  （无文件则整写）——Id 与既有条目冲突时重命名为未占用 rIdM，并同步改 sheet XML
 *  里 drawing 标签的 r:id；3. drawing 标签在 </worksheet> 前回插；4. ContentTypes 补缺。 */
export function restoreChartParts(buf: Buffer, snap: ChartPartsSnapshot): Buffer {
  const zip = new AdmZip(buf);

  for (const p of snap.parts) zip.addFile(p.name, p.data);

  // sheet rels 合并 + 冲突重命名（重命名映射按 sheet 隔离，两 sheet 各自 rId1 互不干扰）
  const renamesBySheet = new Map<string, Map<string, string>>();
  for (const sr of snap.sheetRels) {
    const drawingRels = parseRels(sr.data.toString('utf8')).filter((r) => r.type.endsWith('/drawing'));
    if (drawingRels.length === 0) continue;
    const sheetFile = partPathOfRels(sr.name);
    const current = zip.getEntry(sr.name) !== null ? parseRels(zip.readAsText(sr.name)) : [];
    const taken = new Set(current.map((r) => r.id));
    const renameMap = new Map<string, string>();
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

/** 向目标 sheet 注入图表。
 *  charts[i].chartXml = 完整 chartSpace XML；charts[i].anchorXml = twoCellAnchor 片段
 *  （chart r:id 与 cNvPr id 由本层重指派为实际分配值，调用方可传占位值）。
 *  目标 sheet 无 drawing → 新建 drawingN/双 rels/sheet 标签/ContentTypes；
 *  已有 drawing → 锚点并入既有 wsDr 尾部、drawing rels 追加、sheet rels 不动。 */
export function injectCharts(
  buf: Buffer,
  sheetFile: string,
  charts: Array<{ chartXml: string; anchorXml: string }>,
): Buffer {
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

  let drawingFile: string;
  let drawingRelsName: string;
  let drawingRels: RelEntry[];
  let maxFrame: number;
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
  const anchorParts: string[] = [];
  const newOverrides: string[] = [];
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
// 缓存重算（spec §14.6 P1a）：set_cells 修改被引用区域后既有图表缓存跟随刷新
// ────────────────────────────────────────────────────────────────────────────

/** 引用解析：'汇总图表'!$C$10:$C$13 或 汇总!$B$1 → { sheet, range }（range 归一为
 *  无 $ 的 A1 记法）；非法形态（无 sheet 段 / 引号未配对 / 非法区域 / 外部工作簿
 *  引用）返回 null。 */
export function parseChartRef(ref: string): { sheet: string; range: string } | null {
  const s = ref.trim();
  if (s.length === 0) return null;
  let sheet: string;
  let rest: string;
  if (s.startsWith("'")) {
    // 引号形态：内部 '' 是转义的单引号，需配对解析（表名可含 ! 与空格）
    let name = '';
    let i = 1;
    let closed = false;
    while (i < s.length) {
      const ch = s[i] ?? '';
      if (ch === "'") {
        if (s[i + 1] === "'") {
          name += "'";
          i += 2;
          continue;
        }
        closed = true;
        i += 1;
        break;
      }
      name += ch;
      i += 1;
    }
    if (!closed || name.length === 0 || s[i] !== '!') return null;
    sheet = name;
    rest = s.slice(i + 1);
  } else {
    const bang = s.indexOf('!');
    if (bang <= 0) return null;
    sheet = s.slice(0, bang);
    rest = s.slice(bang + 1);
  }
  if (sheet.startsWith('[')) return null;
  const range = rest.replace(/\$/g, '');
  try {
    parseRange(range);
  } catch {
    return null;
  }
  return { sheet, range };
}

/** readRef 回调返回的区域值：texts 喂 strCache 重建、numbers 喂 numCache 重建；
 *  数组内的 null 点 = omit（c:pt 省略、ptCount 全长）。 */
export interface ChartRefValues {
  texts?: Array<string | null>;
  numbers?: Array<number | null>;
}

const F_TAG_RE = /<c:f>([\s\S]*?)<\/c:f>/;
const NUM_CACHE_RE = /<c:numCache>[\s\S]*?<\/c:numCache>/;
const STR_CACHE_RE = /<c:strCache>[\s\S]*?<\/c:strCache>/;
const FORMAT_CODE_RE = /<c:numCache>[\s\S]*?<c:formatCode>([^<]*)<\/c:formatCode>/;

/** 单个 chart XML 的缓存重算：遍历全部 <c:numRef>/<c:strRef>（含 c:tx 序列名
 *  strRef），<c:f> 经 parseChartRef + readRef 取值后只替换 cache 子树（无 cache
 *  则插到 </c:f> 之后），其余节点字节不动。 */
function refreshChartXmlCaches(
  xml: string,
  readRef: (ref: { sheet: string; range: string }) => ChartRefValues | null,
): string {
  const refresh = (block: string, inner: string, isNum: boolean): string => {
    const f = inner.match(F_TAG_RE);
    if (f === null) return block;
    const parsed = parseChartRef(xmlUnescapeAttr(f[1] ?? ''));
    if (parsed === null) return block;
    const values = readRef(parsed);
    if (values === null) return block;
    let cache: string | null = null;
    let cacheRe: RegExp;
    if (isNum) {
      if (values.numbers === undefined) return block;
      // 保留原 numCache 的 formatCode（无则 General）
      const fc = inner.match(FORMAT_CODE_RE);
      cache = buildNumCacheXml(
        values.numbers,
        fc === null ? 'General' : xmlUnescapeAttr(fc[1] ?? 'General'),
      );
      cacheRe = NUM_CACHE_RE;
    } else {
      if (values.texts === undefined) return block;
      cache = buildStrCacheXml(values.texts);
      cacheRe = STR_CACHE_RE;
    }
    const nextInner = cacheRe.test(inner)
      ? inner.replace(cacheRe, cache)
      : inner.replace(/<\/c:f>/, `</c:f>${cache}`);
    return `<c:${isNum ? 'numRef' : 'strRef'}>${nextInner}</c:${isNum ? 'numRef' : 'strRef'}>`;
  };
  return xml
    .replace(/<c:numRef>([\s\S]*?)<\/c:numRef>/g, (block, inner: string) =>
      refresh(block, inner, true),
    )
    .replace(/<c:strRef>([\s\S]*?)<\/c:strRef>/g, (block, inner: string) =>
      refresh(block, inner, false),
    );
}

/** 对 zip 内全部 xl/charts/chartN.xml 重建缓存：每个 <c:numRef>/<c:strRef> 的 <c:f>
 *  经 readRef 回调取值，重建 numCache/strCache（null 点省略 c:pt、ptCount 全长、
 *  formatCode 保留）；readRef 返回 null 或相应值槽缺失时跳过该引用（保持原缓存）。
 *  无 chart 部件 / 全部未变化时原字节返回（幂等）。 */
export function refreshChartCaches(
  buf: Buffer,
  readRef: (ref: { sheet: string; range: string }) => ChartRefValues | null,
): Buffer {
  const zip = new AdmZip(buf);
  const chartEntries = zip
    .getEntries()
    .filter((e) => !e.isDirectory && /^xl\/charts\/chart\d+\.xml$/.test(e.entryName));
  if (chartEntries.length === 0) return buf;
  let changed = false;
  for (const e of chartEntries) {
    const xml = zip.readAsText(e.entryName);
    const next = refreshChartXmlCaches(xml, readRef);
    if (next !== xml) {
      zip.updateFile(e.entryName, Buffer.from(next, 'utf8'));
      changed = true;
    }
  }
  return changed ? zip.toBuffer() : buf;
}
