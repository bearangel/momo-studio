// PPT 读取（spec 2026-11-03 §6 下线生成后仅保留读路径）。pptx 是 zip 容器，
// slide XML 的 <a:t> 文本用 adm-zip + cheerio 提取（css-select 命名空间选择器
// a\:t，行为由 round-trip 测试锁死）。生成能力由 office-pro 插件承接。
// B 方案收口：入参从磁盘路径改为字节缓冲（office-tools 经内容通道读取 +
// 密文安全闸后传入——本模块不再裸触 fs）。

import AdmZip from 'adm-zip';
import * as cheerio from 'cheerio';

const SLIDE_RE = /^ppt\/slides\/slide(\d+)\.xml$/;
const NOTES_RE = /^ppt\/notesSlides\/notesSlide(\d+)\.xml$/;

function slideTexts(xml: string): string[] {
  const $ = cheerio.load(xml, { xmlMode: true });
  return $('a\\:t')
    .map((_, el) => $(el).text())
    .get()
    .filter((t) => t.trim().length > 0);
}

export async function readPptx(data: Buffer, signal?: AbortSignal): Promise<string> {
  const zip = new AdmZip(data);
  const slides = zip
    .getEntries()
    .filter((e) => SLIDE_RE.test(e.entryName))
    .sort((a, b) => {
      const na = Number(SLIDE_RE.exec(a.entryName)![1]);
      const nb = Number(SLIDE_RE.exec(b.entryName)![1]);
      return na - nb; // 数值序（slide10 不能排在 slide2 前）
    });
  const notes = new Map<number, string>();
  for (const e of zip.getEntries()) {
    const m = NOTES_RE.exec(e.entryName);
    if (m) notes.set(Number(m[1]), slideTexts(e.getData().toString('utf-8')).join(' '));
  }
  if (slides.length === 0) return '(未发现幻灯片)';
  const parts: string[] = [];
  for (const [i, entry] of slides.entries()) {
    // 循环点抛已中断（spec §7）：对齐 bash/webfetch 的 resolve 先例，让 office_read catch 透传
    if (signal?.aborted) throw new Error('已中断');
    const texts = slideTexts(entry.getData().toString('utf-8'));
    parts.push(`## Slide ${i + 1}\n${texts.length > 0 ? texts.join('\n') : '(无文本)'}`);
    const note = notes.get(i + 1);
    if (note && note.length > 0) parts.push(`备注: ${note}`);
  }
  return parts.join('\n\n');
}
