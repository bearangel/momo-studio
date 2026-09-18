// docx round-trip：生成 → 磁盘 → 读取，验证结构保真（标题/段落/列表/表格）；
// 入参窄化拒绝非法 sections。真实 mammoth + 真实 docx 库，不 mock 库行为。
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readDocx, createDocx, parseDocSections } from '../../../../src/main/agent/tools/office/docx';

describe('docx round-trip', () => {
  it('生成 → 读取：标题/段落/列表/表格结构保真', async () => {
    const buf = await createDocx(parseDocSections([
      { type: 'heading', level: 1, text: '项目周报' },
      { type: 'para', text: '本周完成三项工作。' },
      { type: 'list', items: ['需求梳理', '接口联调'] },
      { type: 'table', header: ['事项', '状态'], rows: [['发版', 'done']] },
    ]));
    expect(buf.subarray(0, 2)).toEqual(Buffer.from([0x50, 0x4b])); // zip 魔数
    const abs = path.join(os.tmpdir(), `momo-docx-${Date.now()}.docx`);
    fs.writeFileSync(abs, buf);
    try {
      const md = await readDocx(abs);
      expect(md).toContain('项目周报');
      expect(md).toContain('本周完成三项工作');
      expect(md).toContain('需求梳理');
      expect(md).toContain('发版');
      expect(md).toContain('done');
    } finally {
      fs.rmSync(abs, { force: true });
    }
  });
  it('非法 section 拒绝', () => {
    expect(() => parseDocSections([{ type: 'poem', text: 'x' }])).toThrow(/type/);
    expect(() => parseDocSections('x')).toThrow();
  });
});
