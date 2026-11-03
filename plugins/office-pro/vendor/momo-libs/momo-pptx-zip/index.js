// momo-pptx-zip：pptx 模板填充 zip 手术库（office-pro 插件自有，纯 CJS）。
// 移植来源（office-pro-plugin 分支 commit 2a795cfb，逐函数剥 TS 类型转 JSDoc，逻辑/常量/错误文案原样）：
//   - electron/src/main/agent/tools/office/pptx-zip.ts（fillPptTemplate 及内部辅助；
//     parsePptTemplateFills 属 op 入参窄化层，未随迁——插件侧 agent 直接传 JS 对象）
//   - electron/src/main/agent/tools/office/xlsx-zip.ts 的 attrValue / parseRels /
//     normalizeOfficePath（自包含复制）
// 保真铁律（随源迁）：只 updateFile 被填充页的 slide XML；母版/版式/主题/媒体/rels/
// presentation.xml 与未填充页一律字节不动（另存语义——模板文件本身不改）。
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
'use strict';
const AdmZip = require('adm-zip');

/**
 * 填充指令：title 必填；bullets 非空数组才触发 body 填充（省略 = 正文保持原样）；
 * replaces 逐对全文文本替换（企业模板正文常为普通文本框而非占位符——示例文本
 * 只有 replaces 够得着；from/to 均经 xmlEscape）。
 * @typedef {Object} PptTemplateSlideFill
 * @property {string} title
 * @property {string[]} [bullets]
 * @property {Array.<{from: string, to: string}>} [replaces]
 */

// ────────────────────────────────────────────────────────────────────────────
// 自 xlsx-zip.ts 复制的通用工具（保持库自包含）
// ────────────────────────────────────────────────────────────────────────────

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

/**
 * rels XML → Relationship 条目数组。
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

// ────────────────────────────────────────────────────────────────────────────
// 自 pptx-zip.ts 移植
// ────────────────────────────────────────────────────────────────────────────

/** XML 文本转义（& 必须最先，防 &amp;lt; 二次转义）——title/bullets 写入 <a:t> 前统一过此关 */
function xmlEscape(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * @typedef {Object} XmlMatch
 * @property {number} start
 * @property {number} end
 * @property {string} xml
 */

// 标签字面量与后续字母直接跟 '>'，天然排除 <a:pPr> / </a:pPr> / <a:rPr> 等近邻名。
// 走 scanAll 的三个模式必须带 g 标志（否则 exec 恒返首个 match → 死循环）
const SP_RE = /<p:sp>[\s\S]*?<\/p:sp>/g;
const TXBODY_RE = /<p:txBody>[\s\S]*?<\/p:txBody>/;
const PARAGRAPH_RE = /<a:p>[\s\S]*?<\/a:p>/g;
const RUN_RE = /<a:r>[\s\S]*?<\/a:r>/g;

/**
 * 全量扫描（局部 RegExp 实例防 lastIndex 跨调用泄漏；缺 g 标志防御性补上——
 * 无 g 的 exec 恒返首个 match 会让循环不终止）。
 * @param {RegExp} pattern
 * @param {string} s
 * @returns {XmlMatch[]}
 */
function scanAll(pattern, s) {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  const re = new RegExp(pattern.source, flags);
  const out = [];
  let m = re.exec(s);
  while (m !== null) {
    out.push({ start: m.index, end: m.index + m[0].length, xml: m[0] });
    m = re.exec(s);
  }
  return out;
}

/**
 * sp 块的占位符信息（无 p:ph 返回 null）。ph 标签可为多行缩进形态（pptxgenjs 实证）。
 * @param {string} spXml
 * @returns {{type: string|null, idx: string|null}|null}
 */
function phInfoOf(spXml) {
  const m = spXml.match(/<p:ph\b[^>]*>/);
  if (m === null) return null;
  const tag = m[0] ?? '';
  return { type: attrValue(tag, 'type'), idx: attrValue(tag, 'idx') };
}

/**
 * 从 run XML 提取 rPr（自闭合 / 带子元素两种形态；无 rPr 返回空串）。
 * @param {string} runXml
 * @returns {string}
 */
function extractRPr(runXml) {
  const m = runXml.match(/<a:rPr\b[^>]*\/>|<a:rPr\b[^>]*>[\s\S]*?<\/a:rPr>/);
  return m === null ? '' : m[0] ?? '';
}

/**
 * 区块内 run 手术：首个 run 原位替换为新文本 run（保留其 rPr）、其余 run 删除；
 * run 之外的段落结构（a:p 边界 / pPr / endParaRPr）原样保留。
 * 区块内无 run（空占位符）：向最后一个 a:p 的 endParaRPr 前（无则 </a:p> 前）
 * 插入新 run；连 a:p 都没有返回 null（调用方按结构异常报错）。
 * @param {string} blockXml
 * @param {string} escapedText
 * @returns {string|null}
 */
function replaceFirstRun(blockXml, escapedText) {
  const runs = scanAll(RUN_RE, blockXml);
  if (runs.length > 0) {
    const first = runs[0];
    const newRun = `<a:r>${extractRPr(first.xml)}<a:t>${escapedText}</a:t></a:r>`;
    let out = blockXml.slice(0, first.start) + newRun;
    for (let i = 1; i < runs.length; i++) {
      out += blockXml.slice(runs[i - 1].end, runs[i].start);
    }
    out += blockXml.slice(runs[runs.length - 1].end);
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

/**
 * body txBody 重写：以首个 a:p 为模板逐 bullet 克隆（run 替换），整体替换原全部
 * 段落；无 a:p 返回 null。bullets 至少 1 条（调用方保证——空数组不触发 body 填充）。
 * @param {string} txBodyXml
 * @param {string[]} escapedBullets
 * @returns {string|null}
 */
function rebuildBodyParagraphs(txBodyXml, escapedBullets) {
  const paras = scanAll(PARAGRAPH_RE, txBodyXml);
  const first = paras[0];
  if (first === undefined) return null;
  const clones = [];
  for (const b of escapedBullets) {
    const clone = replaceFirstRun(first.xml, b);
    if (clone === null) return null;
    clones.push(clone);
  }
  return txBodyXml.slice(0, first.start) + clones.join('') + txBodyXml.slice(paras[paras.length - 1].end);
}

/**
 * 展示序 slide 文件列表：presentation.xml 的 <p:sldIdLst> 顺序，r:id 经
 * ppt/_rels/presentation.xml.rels 解析（Target 相对 ppt/ 归一）；坏引用跳过不炸整包。
 * @param {import('adm-zip')} zip
 * @returns {string[]}
 */
function slideFilesInOrder(zip) {
  if (zip.getEntry('ppt/presentation.xml') === null) return [];
  if (zip.getEntry('ppt/_rels/presentation.xml.rels') === null) return [];
  const rels = parseRels(zip.readAsText('ppt/_rels/presentation.xml.rels'));
  const byId = new Map(rels.map((r) => [r.id, r]));
  const out = [];
  for (const tag of zip.readAsText('ppt/presentation.xml').match(/<p:sldId\b[^>]*\/>/g) ?? []) {
    const rid = attrValue(tag, 'r:id');
    const rel = rid === null ? undefined : byId.get(rid);
    if (rel === undefined || !rel.type.endsWith('/slide')) continue;
    const file = normalizeOfficePath('ppt', rel.target);
    if (zip.getEntry(file) !== null) out.push(file);
  }
  return out;
}

/**
 * 单页 slide XML 填充。占位符缺失/结构异常给「第 N 页」明确的中文错误。
 * 企业模板容忍：目录页等仅含 body 占位符、无 title 占位符的页真实存在——该页
 * fill 带 bullets 时跳过 title 只填 body；页内 title 与 body 占位符全无（垃圾模板）
 * 仍给明确错误。
 * @param {string} xml
 * @param {PptTemplateSlideFill} fill
 * @param {number} pageNo
 * @returns {string}
 */
function fillSlideXml(xml, fill, pageNo) {
  const sps = scanAll(SP_RE, xml);
  const titleSp = sps.find((s) => {
    const ph = phInfoOf(s.xml);
    return ph !== null && (ph.type === 'title' || ph.type === 'ctrTitle');
  });
  const bodySp = sps.find((s) => {
    const ph = phInfoOf(s.xml);
    return ph !== null && ph.type === 'body';
  });
  const hasReplaces = (fill.replaces?.length ?? 0) > 0;
  if (titleSp === undefined && !hasReplaces && (bodySp === undefined || !fill.bullets)) {
    throw new Error(`第 ${pageNo} 页无标题占位符（模板填充要求该页含 title 占位符，或含 body 占位符且 slides 项带 bullets，或该页带 replaces）`);
  }
  // 偏移基准统一取原始 xml；按 start 降序套用（后位先改不破坏前位偏移）
  const edits = [];
  if (titleSp !== undefined) {
    const titleTx = titleSp.xml.match(TXBODY_RE);
    if (titleTx === null) throw new Error(`第 ${pageNo} 页标题占位符无文本体（txBody 缺失）`);
    const newTitleTx = replaceFirstRun(titleTx[0] ?? '', xmlEscape(fill.title));
    if (newTitleTx === null) throw new Error(`第 ${pageNo} 页标题占位符结构异常（无段落无 run）`);
    const titleStart = titleSp.start + (titleTx.index ?? 0);
    edits.push({ start: titleStart, end: titleStart + (titleTx[0] ?? '').length, next: newTitleTx });
  }
  // replaces：全文（含占位符区）逐对替换。PowerPoint 编辑器常态单 run 单 <a:t>，
  // from 命中率高；拆 run 场景（同一句被切成多个 <a:t>）不在此列——调用方给
  // 完整句锚点即可，替换后未命中的 from 由调用方自查（此处不静默吞）。
  for (const rep of fill.replaces ?? []) {
    const from = xmlEscape(rep.from);
    let idx = xml.indexOf(from);
    let hit = false;
    while (idx !== -1) {
      edits.push({ start: idx, end: idx + from.length, next: xmlEscape(rep.to) });
      hit = true;
      idx = xml.indexOf(from, idx + from.length);
    }
    if (!hit) {
      throw new Error(`第 ${pageNo} 页 replaces 未命中：模板页内找不到「${rep.from.slice(0, 30)}」（可能被拆分为多个文本 run）`);
    }
  }

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

/**
 * 模板填充主入口：AdmZip 解包 → sldIdLst 顺序映射 slide 文件 → 逐页占位符手术 →
 * 单点 updateFile 重组。输入 templateBuf 不被改动（另存语义）；slides 逐页对应
 * 模板页序——少于模板页数时多余页原字节保留，超出报错。
 * @param {Buffer} templateBuf
 * @param {PptTemplateSlideFill[]} slides
 * @returns {Buffer}
 */
function fillPptTemplate(templateBuf, slides) {
  const zip = new AdmZip(templateBuf);
  const ordered = slideFilesInOrder(zip);
  if (slides.length > ordered.length) {
    throw new Error(`模板仅 ${ordered.length} 页，slides 给了 ${slides.length} 页（超出模板页数；请拆分 slides 或换页数足够的模板）`);
  }
  for (let i = 0; i < slides.length; i++) {
    const file = ordered[i];
    zip.updateFile(file, Buffer.from(fillSlideXml(zip.readAsText(file), slides[i], i + 1), 'utf8'));
  }
  return zip.toBuffer();
}

module.exports = { fillPptTemplate };
