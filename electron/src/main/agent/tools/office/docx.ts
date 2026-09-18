// Word 读写：mammoth 提取（结构保真、样式丢弃——spec §12 边界）+ docx 库生成。
// 读取图片占位 [图片]（mammoth 默认 inline base64 data URI 会撑爆上下文）。

import mammoth from 'mammoth';
import {
  Document, HeadingLevel, Packer, Paragraph, Table, TableCell, TableRow, TextRun, WidthType,
} from 'docx';
import { asString, asStringArray } from './format';

export async function readDocx(abs: string): Promise<string> {
  const { value } = await mammoth.convertToMarkdown({ path: abs });
  return value.replace(/!\[[^\]]*\]\([^)]*\)/g, '[图片]');
}

export type DocSection =
  | { type: 'heading'; level?: number; text: string }
  | { type: 'para'; text: string }
  | { type: 'list'; items: string[]; ordered?: boolean }
  | { type: 'table'; header: string[]; rows: string[][] };

export function parseDocSections(raw: unknown): DocSection[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new Error('参数 sections 缺失或不是非空数组');
  return raw.map((s, i) => {
    if (typeof s !== 'object' || s === null) throw new Error(`sections[${i}] 不是对象`);
    const rec = s as Record<string, unknown>;
    switch (rec.type) {
      case 'heading': {
        const level = typeof rec.level === 'number' ? rec.level : 1;
        return { type: 'heading' as const, level, text: asString(rec.text, `sections[${i}].text`) };
      }
      case 'para':
        return { type: 'para' as const, text: asString(rec.text, `sections[${i}].text`) };
      case 'list':
        return {
          type: 'list' as const,
          items: asStringArray(rec.items, `sections[${i}].items`),
          ordered: rec.ordered === true,
        };
      case 'table':
        return {
          type: 'table' as const,
          header: asStringArray(rec.header, `sections[${i}].header`),
          rows: (Array.isArray(rec.rows) ? rec.rows : []).map((r, ri) =>
            asStringArray(r, `sections[${i}].rows[${ri}]`)),
        };
      default:
        throw new Error(`sections[${i}].type 非法（支持 heading/para/list/table）`);
    }
  });
}

function headingOf(level: number): (typeof HeadingLevel)[keyof typeof HeadingLevel] {
  const l = Math.min(4, Math.max(1, Math.floor(level)));
  const map = [
    HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4,
  ] as const;
  return map[l - 1] ?? HeadingLevel.HEADING_1;
}

export async function createDocx(sections: DocSection[]): Promise<Buffer> {
  const children: Array<Paragraph | Table> = [];
  for (const s of sections) {
    if (s.type === 'heading') {
      children.push(new Paragraph({ heading: headingOf(s.level ?? 1), children: [new TextRun(s.text)] }));
    } else if (s.type === 'para') {
      children.push(new Paragraph({ children: [new TextRun(s.text)] }));
    } else if (s.type === 'list') {
      for (const [i, item] of s.items.entries()) {
        if (s.ordered) {
          children.push(new Paragraph({ children: [new TextRun(`${i + 1}. ${item}`)] }));
        } else {
          children.push(new Paragraph({ children: [new TextRun(item)], bullet: { level: 0 } }));
        }
      }
    } else {
      const rows = [s.header, ...s.rows].map(
        (cells) =>
          new TableRow({
            children: cells.map((c) => new TableCell({ children: [new Paragraph(c)] })),
          }),
      );
      children.push(new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE } }));
    }
  }
  const doc = new Document({ sections: [{ children }] });
  return Packer.toBuffer(doc);
}
