// electron/src/main/agent/tools/office/pdf.ts
// PDF 读写：pdfjs-dist（v3 UMD CJS，Node fake-worker 路径，verbosity 0 压噪）逐页
// 提取 + pdfkit 生成（内嵌 Noto Sans SC，pdfkit 默认字体无 CJK）。
// 扫描版（无文本层）读取明确报错。仅用 getTextContent，不触渲染，无需 canvas。

import fs from 'node:fs';
import path from 'node:path';
import PDFDocument from 'pdfkit';
import * as pdfjsLib from 'pdfjs-dist';
import { asString, asStringArray } from './format';

const FONT_FILE = 'NotoSansSC-Regular.ttf';

/** 字体定位：生产走 extraResources（process.resourcesPath/fonts）；
 * dev（process.defaultApp）从编译产物 dist/main/agent/tools/office 上溯 5 级
 * 到包根 resources/fonts（与 builtin.ts 的 agents 目录解析同模式）。 */
export function resolveFontPath(): string {
  if (process.resourcesPath && !process.defaultApp) {
    return path.join(process.resourcesPath, 'fonts', FONT_FILE);
  }
  return path.join(__dirname, '..', '..', '..', '..', '..', 'resources', 'fonts', FONT_FILE);
}

export async function readPdf(abs: string, signal?: AbortSignal): Promise<string> {
  const data = new Uint8Array(fs.readFileSync(abs));
  // Node 运行时约定：isEvalSupported/useWorkerFetch/disableFontFace 关掉浏览器侧
  // 能力；verbosity 0 压制 fake-worker 等告警噪声（测试输出必须干净）
  const doc = await pdfjsLib.getDocument({
    data,
    isEvalSupported: false,
    useWorkerFetch: false,
    disableFontFace: true,
    verbosity: 0,
  }).promise;
  try {
    const pageTexts: string[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      // 循环点抛已中断（spec §7）：对齐 bash/webfetch 的 resolve 先例，让 office_read catch 透传
      if (signal?.aborted) throw new Error('已中断');
      const page = await doc.getPage(i);
      const tc = await page.getTextContent();
      // TextItem | TextMarkedContent 联合类型：'str' in 收窄
      pageTexts.push(tc.items.map((it) => ('str' in it ? it.str : '')).join(' ').trim());
    }
    if (pageTexts.every((t) => t.length === 0)) {
      throw new Error('PDF 无文本层（疑似扫描版，无法提取文本）');
    }
    return pageTexts.map((t, i) => `## 第 ${i + 1} 页\n${t}`).join('\n\n');
  } finally {
    await doc.cleanup();
  }
}

export type PdfBlock =
  | { type: 'heading'; level?: number; text: string }
  | { type: 'para'; text: string }
  | { type: 'list'; items: string[]; ordered?: boolean }
  | { type: 'table'; header: string[]; rows: string[][] }
  | { type: 'pagebreak' };

export function parsePdfBlocks(raw: unknown): PdfBlock[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new Error('参数 blocks 缺失或不是非空数组');
  return raw.map((b, i) => {
    if (typeof b !== 'object' || b === null) throw new Error(`blocks[${i}] 不是对象`);
    const rec = b as Record<string, unknown>;
    switch (rec.type) {
      case 'heading': {
        const level = typeof rec.level === 'number' ? rec.level : 1;
        return { type: 'heading' as const, level, text: asString(rec.text, `blocks[${i}].text`) };
      }
      case 'para':
        return { type: 'para' as const, text: asString(rec.text, `blocks[${i}].text`) };
      case 'list':
        return {
          type: 'list' as const,
          items: asStringArray(rec.items, `blocks[${i}].items`),
          ordered: rec.ordered === true,
        };
      case 'table':
        return {
          type: 'table' as const,
          header: asStringArray(rec.header, `blocks[${i}].header`),
          rows: (Array.isArray(rec.rows) ? rec.rows : []).map((r, ri) =>
            asStringArray(r, `blocks[${i}].rows[${ri}]`)),
        };
      case 'pagebreak':
        return { type: 'pagebreak' as const };
      default:
        throw new Error(`blocks[${i}].type 非法（支持 heading/para/list/table/pagebreak）`);
    }
  });
}

/** 表格：均分列宽简单网格线（v1 边界：单元格单行，不换行） */
function drawTable(doc: PDFKit.PDFDocument, header: string[], rows: string[][]): void {
  const colCount = Math.max(1, header.length);
  const margin = doc.page.margins.left;
  const colW = (doc.page.width - margin * 2) / colCount;
  const rowH = 24;
  const allRows = [header, ...rows];
  for (const cells of allRows) {
    const y = doc.y;
    for (let ci = 0; ci < colCount; ci++) {
      const x = margin + ci * colW;
      doc.save();
      doc.rect(x, y, colW, rowH).stroke();
      const text = cells[ci] ?? '';
      doc.fontSize(10).text(text, x + 4, y + 6, { width: colW - 8, height: rowH - 8, lineBreak: false });
      doc.restore();
    }
    doc.y = y + rowH;
  }
  doc.moveDown(0.4);
}

export async function createPdf(blocks: PdfBlock[]): Promise<Buffer> {
  const fontPath = resolveFontPath();
  if (!fs.existsSync(fontPath)) throw new Error(`中文字体缺失（安装损坏）: ${FONT_FILE}`);
  const doc = new PDFDocument({ size: 'A4', margin: 56 });
  const chunks: Buffer[] = [];
  const done = new Promise<void>((resolve) => doc.on('end', () => resolve()));
  doc.on('data', (c: Buffer) => chunks.push(c));
  doc.font(fontPath); // 内嵌 Noto Sans SC（CJK 必需）
  for (const b of blocks) {
    if (b.type === 'pagebreak') {
      doc.addPage();
      continue;
    }
    if (b.type === 'heading') {
      const level = Math.min(4, Math.max(1, Math.floor(b.level ?? 1)));
      doc.fontSize(12 + 4 * (5 - level)).text(b.text);
      doc.moveDown(0.5);
    } else if (b.type === 'para') {
      doc.fontSize(11).text(b.text);
      doc.moveDown(0.5);
    } else if (b.type === 'list') {
      for (const [i, item] of b.items.entries()) {
        const prefix = b.ordered ? `${i + 1}. ` : '• ';
        doc.fontSize(11).text(prefix + item, { indent: 16 });
      }
      doc.moveDown(0.4);
    } else {
      drawTable(doc, b.header, b.rows);
    }
  }
  doc.end();
  await done;
  return Buffer.concat(chunks);
}
