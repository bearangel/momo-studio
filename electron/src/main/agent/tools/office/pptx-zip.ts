// pptx 模板填充 zip 手术（spec §14.9-3，office_fill_ppt_template 底座）。
// 设计取舍：对齐 xlsx-zip 的字符串级手术风格——不引 DOM 解析（DOM round-trip
// 会重排属性/空白/自闭合形态，破坏「其余部件字节不变」保真红线），只对明确
// 匹配的片段做原位替换。
// 保真铁律：只 updateFile 被填充页的 slide XML；母版/版式/主题/媒体/rels/
// presentation.xml 与未填充页一律字节不动（另存语义——模板文件本身不改）。
//
// 手术协议（实证依据 2026-09-21：pptxgenjs 4.0.1 defineSlideMaster + 页级
// addText({placeholder}) 产物）：
//   页序   presentation.xml 的 <p:sldIdLst> 元素顺序 → r:id 经
//         ppt/_rels/presentation.xml.rels 解析到 ppt/slides/slideN.xml
//         （文件名号序 ≠ 展示序：PowerPoint 拖动换序不改 slideN 文件名）
//   title  首个 <p:ph type="title"/>（或 ctrTitle）的 sp：txBody 内首个 <a:r>
//         的 <a:t> 写全量新文本、保留该 run 的 rPr、其余 <a:r> 删除（a:p 段落
//         结构保留——title 单段）
//   body   首个 type="body" 的 sp：以首个 a:p 为模板克隆，每个 bullet 一段
//         （pPr/rPr 逐段保留）。设计原案限定「无 idx 或 idx=1」，但 pptxgenjs
//         产物 body 占位符实为 idx="101"（100+ 编号），故收敛为「首个
//         type="body"」——真实 PowerPoint 与 pptxgenjs 均命中
//   防御   文本经 xmlEscape；slides 超模板页数 / 占位符缺失给明确中文错误

import AdmZip from 'adm-zip';
import { asString, asStringArray } from './format';
import { attrValue, normalizeOfficePath, parseRels } from './xlsx-zip';

/** 填充指令（parse 后形态）：title 必填；bullets 非空数组才触发 body 填充（省略 = 正文保持原样） */
export interface PptTemplateSlideFill {
  title: string;
  bullets?: string[];
}

/** XML 文本转义（& 必须最先，防 &amp;lt; 二次转义）——title/bullets 写入 <a:t> 前统一过此关 */
function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

interface XmlMatch {
  start: number;
  end: number;
  xml: string;
}

// 标签字面量与后续字母直接跟 '>'，天然排除 <a:pPr> / </a:pPr> / <a:rPr> 等近邻名。
// 走 scanAll 的三个模式必须带 g 标志（否则 exec 恒返首个 match → 死循环）
const SP_RE = /<p:sp>[\s\S]*?<\/p:sp>/g;
const TXBODY_RE = /<p:txBody>[\s\S]*?<\/p:txBody>/;
const PARAGRAPH_RE = /<a:p>[\s\S]*?<\/a:p>/g;
const RUN_RE = /<a:r>[\s\S]*?<\/a:r>/g;

/** 全量扫描（局部 RegExp 实例防 lastIndex 跨调用泄漏；缺 g 标志防御性补上——
 *  无 g 的 exec 恒返首个 match 会让循环不终止） */
function scanAll(pattern: RegExp, s: string): XmlMatch[] {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  const re = new RegExp(pattern.source, flags);
  const out: XmlMatch[] = [];
  let m = re.exec(s);
  while (m !== null) {
    out.push({ start: m.index, end: m.index + m[0].length, xml: m[0] });
    m = re.exec(s);
  }
  return out;
}

/** sp 块的占位符信息（无 p:ph 返回 null）。ph 标签可为多行缩进形态（pptxgenjs 实证） */
function phInfoOf(spXml: string): { type: string | null; idx: string | null } | null {
  const m = spXml.match(/<p:ph\b[^>]*>/);
  if (m === null) return null;
  const tag = m[0] ?? '';
  return { type: attrValue(tag, 'type'), idx: attrValue(tag, 'idx') };
}

/** 从 run XML 提取 rPr（自闭合 / 带子元素两种形态；无 rPr 返回空串） */
function extractRPr(runXml: string): string {
  const m = runXml.match(/<a:rPr\b[^>]*\/>|<a:rPr\b[^>]*>[\s\S]*?<\/a:rPr>/);
  return m === null ? '' : m[0] ?? '';
}

/** 区块内 run 手术：首个 run 原位替换为新文本 run（保留其 rPr）、其余 run 删除；
 *  run 之外的段落结构（a:p 边界 / pPr / endParaRPr）原样保留。
 *  区块内无 run（空占位符）：向最后一个 a:p 的 endParaRPr 前（无则 </a:p> 前）
 *  插入新 run；连 a:p 都没有返回 null（调用方按结构异常报错）。 */
function replaceFirstRun(blockXml: string, escapedText: string): string | null {
  const runs = scanAll(RUN_RE, blockXml);
  if (runs.length > 0) {
    const first = runs[0]!;
    const newRun = `<a:r>${extractRPr(first.xml)}<a:t>${escapedText}</a:t></a:r>`;
    let out = blockXml.slice(0, first.start) + newRun;
    for (let i = 1; i < runs.length; i++) {
      out += blockXml.slice(runs[i - 1]!.end, runs[i]!.start);
    }
    out += blockXml.slice(runs[runs.length - 1]!.end);
    return out;
  }
  const paras = scanAll(PARAGRAPH_RE, blockXml);
  const last = paras[paras.length - 1];
  if (last === undefined) return null;
  const run = `<a:r><a:t>${escapedText}</a:t></a:r>`;
  const endPrAt = blockXml.indexOf('<a:endParaRPr', last.start);
  const insertAt = endPrAt >= 0 && endPrAt < last.end ? endPrAt : last.end - '</a:p>'.length;
  return blockXml.slice(0, insertAt) + run + blockXml.slice(insertAt);
}

/** body txBody 重写：以首个 a:p 为模板逐 bullet 克隆（run 替换），整体替换原全部
 *  段落；无 a:p 返回 null。bullets 至少 1 条（调用方保证——空数组不触发 body 填充）。 */
function rebuildBodyParagraphs(txBodyXml: string, escapedBullets: string[]): string | null {
  const paras = scanAll(PARAGRAPH_RE, txBodyXml);
  const first = paras[0];
  if (first === undefined) return null;
  const clones: string[] = [];
  for (const b of escapedBullets) {
    const clone = replaceFirstRun(first.xml, b);
    if (clone === null) return null;
    clones.push(clone);
  }
  return txBodyXml.slice(0, first.start) + clones.join('') + txBodyXml.slice(paras[paras.length - 1]!.end);
}

/** 展示序 slide 文件列表：presentation.xml 的 <p:sldIdLst> 顺序，r:id 经
 *  ppt/_rels/presentation.xml.rels 解析（Target 相对 ppt/ 归一）；坏引用跳过不炸整包 */
function slideFilesInOrder(zip: AdmZip): string[] {
  if (zip.getEntry('ppt/presentation.xml') === null) return [];
  if (zip.getEntry('ppt/_rels/presentation.xml.rels') === null) return [];
  const rels = parseRels(zip.readAsText('ppt/_rels/presentation.xml.rels'));
  const byId = new Map(rels.map((r): [string, (typeof rels)[number]] => [r.id, r]));
  const out: string[] = [];
  for (const tag of zip.readAsText('ppt/presentation.xml').match(/<p:sldId\b[^>]*\/>/g) ?? []) {
    const rid = attrValue(tag, 'r:id');
    const rel = rid === null ? undefined : byId.get(rid);
    if (rel === undefined || !rel.type.endsWith('/slide')) continue;
    const file = normalizeOfficePath('ppt', rel.target);
    if (zip.getEntry(file) !== null) out.push(file);
  }
  return out;
}

/** 单页 slide XML 填充。占位符缺失/结构异常给「第 N 页」明确的中文错误。 */
function fillSlideXml(xml: string, fill: PptTemplateSlideFill, pageNo: number): string {
  const sps = scanAll(SP_RE, xml);
  const titleSp = sps.find((s) => {
    const ph = phInfoOf(s.xml);
    return ph !== null && (ph.type === 'title' || ph.type === 'ctrTitle');
  });
  if (titleSp === undefined) {
    throw new Error(`第 ${pageNo} 页无标题占位符（模板填充要求该页含 title 占位符）`);
  }
  const titleTx = titleSp.xml.match(TXBODY_RE);
  if (titleTx === null) throw new Error(`第 ${pageNo} 页标题占位符无文本体（txBody 缺失）`);
  const newTitleTx = replaceFirstRun(titleTx[0] ?? '', xmlEscape(fill.title));
  if (newTitleTx === null) throw new Error(`第 ${pageNo} 页标题占位符结构异常（无段落无 run）`);

  // 偏移基准统一取原始 xml；按 start 降序套用（后位先改不破坏前位偏移）
  const titleStart = titleSp.start + (titleTx.index ?? 0);
  const edits: Array<{ start: number; end: number; next: string }> = [
    { start: titleStart, end: titleStart + (titleTx[0] ?? '').length, next: newTitleTx },
  ];

  const bullets = fill.bullets ?? [];
  if (bullets.length > 0) {
    const bodySp = sps.find((s) => {
      const ph = phInfoOf(s.xml);
      return ph !== null && ph.type === 'body';
    });
    if (bodySp === undefined) {
      throw new Error(`第 ${pageNo} 页无正文占位符（bullets 需要该页含 body 占位符）`);
    }
    const bodyTx = bodySp.xml.match(TXBODY_RE);
    if (bodyTx === null) throw new Error(`第 ${pageNo} 页正文占位符无文本体（txBody 缺失）`);
    const newBodyTx = rebuildBodyParagraphs(bodyTx[0] ?? '', bullets.map(xmlEscape));
    if (newBodyTx === null) throw new Error(`第 ${pageNo} 页正文占位符结构异常（无段落）`);
    const bodyStart = bodySp.start + (bodyTx.index ?? 0);
    edits.push({ start: bodyStart, end: bodyStart + (bodyTx[0] ?? '').length, next: newBodyTx });
  }

  let out = xml;
  for (const e of edits.sort((a, b) => b.start - a.start)) {
    out = out.slice(0, e.start) + e.next + out.slice(e.end);
  }
  return out;
}

/** 模板填充主入口：AdmZip 解包 → sldIdLst 顺序映射 slide 文件 → 逐页占位符手术 →
 *  单点 updateFile 重组。输入 templateBuf 不被改动（另存语义）；slides 逐页对应
 *  模板页序——少于模板页数时多余页原字节保留，超出报错。 */
export function fillPptTemplate(templateBuf: Buffer, slides: PptTemplateSlideFill[]): Buffer {
  const zip = new AdmZip(templateBuf);
  const ordered = slideFilesInOrder(zip);
  if (slides.length > ordered.length) {
    throw new Error(`模板仅 ${ordered.length} 页，slides 给了 ${slides.length} 页（超出模板页数；请拆分 slides 或换页数足够的模板）`);
  }
  for (let i = 0; i < slides.length; i++) {
    const file = ordered[i]!;
    zip.updateFile(file, Buffer.from(fillSlideXml(zip.readAsText(file), slides[i]!, i + 1), 'utf8'));
  }
  return zip.toBuffer();
}

/** 入参窄化：slides 数组 → PptTemplateSlideFill[]（title 必填非空串；bullets 可选字符串数组） */
export function parsePptTemplateFills(raw: unknown): PptTemplateSlideFill[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new Error('参数 slides 缺失或不是非空数组');
  return raw.map((s, i) => {
    if (typeof s !== 'object' || s === null) throw new Error(`slides[${i}] 不是对象`);
    const rec = s as Record<string, unknown>;
    const fill: PptTemplateSlideFill = { title: asString(rec.title, `slides[${i}].title`) };
    if (rec.bullets !== undefined && rec.bullets !== null) {
      fill.bullets = asStringArray(rec.bullets, `slides[${i}].bullets`);
    }
    return fill;
  });
}
