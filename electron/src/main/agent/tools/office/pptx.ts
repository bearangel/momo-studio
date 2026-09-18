// PPT 读写。读取零新依赖：pptx 是 zip 容器，slide XML 的 <a:t> 文本用既有
// adm-zip + cheerio 提取（css-select 命名空间选择器 a\:t，行为由 round-trip
// 测试锁死）。生成走 pptxgenjs 简单版式（spec §12：无母版继承，重样式走人工）。

import AdmZip from 'adm-zip';
import * as cheerio from 'cheerio';
import PptxGenJS from 'pptxgenjs';
import { asString, asStringArray } from './format';

const SLIDE_RE = /^ppt\/slides\/slide(\d+)\.xml$/;
const NOTES_RE = /^ppt\/notesSlides\/notesSlide(\d+)\.xml$/;

function slideTexts(xml: string): string[] {
  const $ = cheerio.load(xml, { xmlMode: true });
  return $('a\\:t')
    .map((_, el) => $(el).text())
    .get()
    .filter((t) => t.trim().length > 0);
}

export async function readPptx(abs: string, signal?: AbortSignal): Promise<string> {
  const zip = new AdmZip(abs);
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

export interface PptxSlideSpec {
  title: string;
  bullets?: string[];
  table?: { header: string[]; rows: string[][] };
  notes?: string;
}

export function parsePptxSlides(raw: unknown): PptxSlideSpec[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new Error('参数 slides 缺失或不是非空数组');
  return raw.map((s, i) => {
    if (typeof s !== 'object' || s === null) throw new Error(`slides[${i}] 不是对象`);
    const rec = s as Record<string, unknown>;
    const spec: PptxSlideSpec = { title: asString(rec.title, `slides[${i}].title`) };
    if (rec.bullets !== undefined) spec.bullets = asStringArray(rec.bullets, `slides[${i}].bullets`);
    if (rec.notes !== undefined && rec.notes !== null) spec.notes = asString(rec.notes, `slides[${i}].notes`);
    if (rec.table !== undefined && rec.table !== null) {
      if (typeof rec.table !== 'object') throw new Error(`slides[${i}].table 不是对象`);
      const t = rec.table as Record<string, unknown>;
      spec.table = {
        header: asStringArray(t.header, `slides[${i}].table.header`),
        rows: (Array.isArray(t.rows) ? t.rows : []).map((r, ri) =>
          asStringArray(r, `slides[${i}].table.rows[${ri}]`)),
      };
    }
    return spec;
  });
}

export async function createPptx(slides: PptxSlideSpec[]): Promise<Buffer> {
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_16x9';
  for (const s of slides) {
    const slide = pptx.addSlide();
    slide.addText(s.title, { x: 0.5, y: 0.4, w: 9, h: 0.9, fontSize: 28, bold: true });
    if (s.bullets && s.bullets.length > 0) {
      slide.addText(
        s.bullets.map((b) => ({ text: b, options: { bullet: true } })),
        { x: 0.8, y: 1.6, w: 8.4, h: 3.6, fontSize: 16 },
      );
    }
    if (s.table) {
      const header = s.table.header.map((h) => ({ text: h, options: { bold: true } }));
      const rows = [header, ...s.table.rows.map((r) => r.map((c) => ({ text: c })))];
      slide.addTable(rows, { x: 0.6, y: 1.6, w: 8.8, fontSize: 12 });
    }
    if (s.notes) slide.addNotes(s.notes);
  }
  const out = await pptx.write({ outputType: 'nodebuffer' });
  return Buffer.from(out as Uint8Array); // 类型层为联合类型，nodebuffer 运行时是 Buffer
}
