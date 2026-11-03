// docx 读侧测试（spec 2026-11-03 §6 下线生成后）：结构提取（标题/段落/列表/表格）。
// 夹具由插件 vendor 的 docx 库真生成 → mammoth 真提取，不 mock 库行为。
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readDocx } from '../../../../src/main/agent/tools/office/docx';
import { loadVendorLib } from './vendor-fixtures';

interface DocxLib {
  Document: new (o: unknown) => unknown;
  Packer: { toBuffer(doc: unknown): Promise<Buffer> };
  Paragraph: new (o: unknown) => unknown;
  HeadingLevel: { HEADING_1: unknown };
  Table: new (o: unknown) => unknown;
  TableRow: new (o: unknown) => unknown;
  TableCell: new (o: unknown) => unknown;
  TextRun: new (o: unknown) => unknown;
}

describe('docx round-trip（读侧）', () => {
  it('标题/段落/列表/表格结构保真', async () => {
    const docxLib = loadVendorLib<DocxLib>('docx');
    const { Document, Packer, Paragraph, HeadingLevel, Table, TableRow, TableCell, TextRun } = docxLib;
    const doc = new Document({
      sections: [{
        children: [
          new Paragraph({ text: '季度报告', heading: HeadingLevel.HEADING_1 }),
          new Paragraph({ children: [new TextRun('正文段落')] }),
          new Paragraph({ text: '列表项一', bullet: { level: 0 } }),
          new Table({
            rows: [new TableRow({ children: [new TableCell({ children: [new Paragraph('表头A')] })] })],
          }),
        ],
      }],
    });
    const buf = await Packer.toBuffer(doc);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-docx-'));
    const file = path.join(tmp, 'a.docx');
    fs.writeFileSync(file, buf);
    const out = await readDocx(file);
    for (const kw of ['季度报告', '正文段落', '列表项一', '表头A']) expect(out).toContain(kw);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
