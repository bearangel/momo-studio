// pptx round-trip 测试。pptxgenjs 真生成 → 自解析真提取（双向都不 mock——
// css-select 命名空间选择器 a\:t 的真实行为由本 round-trip 锁死）。
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPptx, parsePptxSlides, readPptx } from '../../../../src/main/agent/tools/office/pptx';

describe('pptx round-trip', () => {
  it('生成 → 提取：标题/要点/表格/备注逐 slide 保真', async () => {
    const buf = await createPptx(parsePptxSlides([
      { title: '季度汇报', bullets: ['收入增长 20%', '成本下降 5%'], notes: '强调同比' },
      { title: '数据表', table: { header: ['季度', '营收'], rows: [['Q1', '100 万']] } },
    ]));
    expect(buf.subarray(0, 2)).toEqual(Buffer.from([0x50, 0x4b]));
    const abs = path.join(os.tmpdir(), `momo-pptx-${Date.now()}.pptx`);
    fs.writeFileSync(abs, buf);
    try {
      const out = await readPptx(abs);
      expect(out).toContain('## Slide 1');
      expect(out).toContain('季度汇报');
      expect(out).toContain('收入增长 20%');
      expect(out).toContain('备注: 强调同比');
      expect(out).toContain('## Slide 2');
      expect(out).toContain('100 万');
    } finally {
      fs.rmSync(abs, { force: true });
    }
  });
  it('非法 slide 拒绝', () => {
    expect(() => parsePptxSlides([{ bullets: ['x'] }])).toThrow(/title/);
    expect(() => parsePptxSlides([])).toThrow();
  });
});
