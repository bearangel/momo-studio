// 依赖仓库内字体资产（Step 1 提交进 git）；字体是测试前置而非 mock 对象。
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPdf, parsePdfBlocks, readPdf, resolveFontPath } from '../../../../src/main/agent/tools/office/pdf';

describe('createPdf', () => {
  it('中文字块渲染：产出 PDF 魔数且非平凡体积', async () => {
    expect(fs.existsSync(resolveFontPath())).toBe(true);
    const buf = await createPdf(parsePdfBlocks([
      { type: 'heading', level: 1, text: '季度报告' },
      { type: 'para', text: '收入与成本概况如下。' },
      { type: 'list', items: ['华东区', '华北区'], ordered: true },
      { type: 'table', header: ['区域', '营收'], rows: [['华东', '100 万']] },
      { type: 'pagebreak' },
      { type: 'para', text: '第二页。' },
    ]));
    expect(buf.subarray(0, 4).toString('ascii')).toBe('%PDF');
    // 内嵌 CJK 子集的体积下界：实测 35 唯一字符子集 7.6KB（pdfkit 压缩）；
    // 无字体嵌入的纯文本 PDF <2KB，5KB 阈值区分度充分
    expect(buf.length).toBeGreaterThan(5 * 1024);
  });
});

describe('readPdf', () => {
  it('逐页提取自产 PDF 的中文文本', async () => {
    const buf = await createPdf(parsePdfBlocks([
      { type: 'heading', text: '标题甲' },
      { type: 'para', text: '正文乙' },
    ]));
    const abs = path.join(os.tmpdir(), `momo-pdf-${Date.now()}.pdf`);
    fs.writeFileSync(abs, buf);
    try {
      const out = await readPdf(abs);
      expect(out).toContain('第 1 页');
      expect(out).toContain('标题甲');
    } finally {
      fs.rmSync(abs, { force: true });
    }
  });

  it('无文本层（空渲染页）报扫描版错误', async () => {
    // pdfkit 直接 addPage 不写文本 → 空文本层
    const PDFDocument = (await import('pdfkit')).default;
    const doc = new PDFDocument();
    const chunks: Buffer[] = [];
    const done = new Promise<void>((r) => doc.on('end', () => r()));
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.addPage();
    doc.end();
    await done;
    const abs = path.join(os.tmpdir(), `momo-pdf-empty-${Date.now()}.pdf`);
    fs.writeFileSync(abs, Buffer.concat(chunks));
    try {
      await expect(readPdf(abs)).rejects.toThrow(/无文本层/);
    } finally {
      fs.rmSync(abs, { force: true });
    }
  });
});

describe('parsePdfBlocks', () => {
  it('非法 block 拒绝', () => {
    expect(() => parsePdfBlocks([{ type: 'chart' }])).toThrow(/type/);
  });
});
