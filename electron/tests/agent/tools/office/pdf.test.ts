// pdf 读侧测试（spec 2026-11-03 §6 下线生成后）：逐页文本提取 + 扫描版明确报错。
// 夹具由插件 vendor 的 pdfkit 真生成（内嵌字体），pdfjs 真解析。
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readPdf } from '../../../../src/main/agent/tools/office/pdf';
import { loadVendorLib } from './vendor-fixtures';

interface PdfDoc {
  on(ev: string, cb: () => void): void;
  text(t: string): void;
  addPage(): void;
  end(): void;
  pipe(stream: fs.WriteStream): void;
}
type PdfKit = new (o?: Record<string, unknown>) => PdfDoc;

describe('readPdf（读侧）', () => {
  it('逐页文本提取（真实 pdfkit 产物）', async () => {
    const PDFDocument = loadVendorLib<PdfKit>('pdfkit');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-pdf-'));
    const file = path.join(tmp, 'a.pdf');
    await new Promise<void>((resolve, reject) => {
      const doc = new PDFDocument({ autoFirstPage: true });
      const stream = fs.createWriteStream(file);
      stream.on('finish', () => resolve());
      stream.on('error', reject);
      doc.pipe(stream);
      doc.text('PageOneContent');
      doc.addPage();
      doc.text('PageTwoContent');
      doc.end();
    });
    const out = await readPdf(file);
    expect(out).toContain('PageOneContent');
    expect(out).toContain('PageTwoContent');
    expect(out).toContain('第 1 页');
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('非法 PDF → 抛错可自诊', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-pdf-'));
    const file = path.join(tmp, 'bad.pdf');
    fs.writeFileSync(file, 'not a pdf');
    await expect(readPdf(file)).rejects.toThrow();
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
