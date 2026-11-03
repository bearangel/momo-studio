// office 产物结构校验（spec 2026-11-03 §5.2）：zip 完整性 + 关键部件存在性 +
// XML 良构粗检。定位是「agent 收工自查」而非 schema 级校验（Anthropic validate.py
// 的 JS 轻量版）——捕获损坏文件/缺部件，不保证 PowerPoint 语义合法。
'use strict';
const AdmZip = require('adm-zip');

/** 字符间距异常阈值（OOXML spc 单位 1/100 pt）：>12pt 视为疑似误用
 *  charSpacing（验收实锤：charSpacing: 150/180 → spc=15000/18000，PowerPoint
 *  渲染成逐字竖排并压住其他元素；结构完全合法，只有数值红线能拦） */
const SPC_LIMIT = 1200;

/** 各格式的必需部件（zip entry 名） */
const REQUIRED_PARTS = {
  pptx: ['[Content_Types].xml', 'ppt/presentation.xml', '_rels/.rels'],
  xlsx: ['[Content_Types].xml', 'xl/workbook.xml', '_rels/.rels'],
  docx: ['[Content_Types].xml', 'word/document.xml', '_rels/.rels'],
};

/** XML 良构粗检：去声明/注释/CDATA 后做根级闭合配对（不引入完整 parser） */
function xmlRoughCheck(xml, part) {
  const errors = [];
  const body = xml.replace(/^\uFEFF/, '').trim();
  if (!body.startsWith('<')) return [`部件 ${part} 不以 < 开头（疑似二进制损坏）`];
  // trim 必需：真实产物（pptxgenjs/exceljs）声明与根标签之间有 \r\n，剥声明后
  // 前导空白会让下方 ^ 锚定的 open/自闭合分支失配（Task 4 接真实 pptxgenjs 产物时实证）
  const stripped = body
    .replace(/<\?[\s\S]*?\?>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '')
    .trim();
  if (/^<([A-Za-z_][\w.:-]*)[\s\S]*?\/>/.test(stripped)) return errors; // 自闭合根：合法
  const open = /^<([A-Za-z_][\w.:-]*)/.exec(stripped);
  const close = /<\/([A-Za-z_][\w.:-]*)\s*>$/.exec(stripped);
  if (!open || !close || open[1] !== close[1]) {
    errors.push(`部件 ${part} 根标签未闭合（${open ? open[1] : '?'} vs ${close ? close[1] : '?'}）`);
  }
  return errors;
}

/**
 * 校验 office 产物。
 * @param {string} abs 产物绝对路径（支持 pptx / xlsx / docx）
 * @returns {{ ok: boolean, errors: string[] }}
 */
function validateOfficeFile(abs) {
  const ext = abs.slice(abs.lastIndexOf('.') + 1).toLowerCase();
  const required = REQUIRED_PARTS[ext];
  if (!required) return { ok: false, errors: [`不支持的扩展名: .${ext}（支持 pptx/xlsx/docx）`] };
  let zip;
  try {
    zip = new AdmZip(abs);
  } catch (err) {
    return { ok: false, errors: [`zip 无法打开（文件损坏）: ${err.message}`] };
  }
  const names = new Set(zip.getEntries().map((e) => e.entryName));
  const errors = [];
  for (const part of required) {
    if (!names.has(part)) errors.push(`缺少必需部件: ${part}`);
  }
  for (const entry of zip.getEntries()) {
    if (!/\.(xml|rels)$/.test(entry.entryName)) continue;
    const text = entry.getData().toString('utf-8');
    if (text.includes('\u0000')) errors.push(`部件 ${entry.entryName} 含 NUL 字节（疑似损坏）`);
    for (const m of text.matchAll(/spc="(-?\d+)"/g)) {
      const v = Number(m[1]);
      if (Math.abs(v) > SPC_LIMIT) {
        errors.push(
          `部件 ${entry.entryName} 字符间距异常（spc=${v}，约 ${(Math.abs(v) / 100).toFixed(1)}pt）：` +
            '检查 charSpacing 是否为 point 值（正常 0–2）',
        );
      }
    }
    errors.push(...xmlRoughCheck(text, entry.entryName));
  }
  return { ok: errors.length === 0, errors };
}

module.exports = { validateOfficeFile };
