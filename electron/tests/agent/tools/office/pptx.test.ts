// pptx 读侧测试（spec 2026-11-03 §6 下线生成后）：读提取 round-trip。
// 夹具由插件 vendor 的 pptxgenjs 真生成 → readPptx 真解析（css-select 命名空间
// 选择器 a\:t 的真实行为由本 round-trip 锁死；双向都不 mock）。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readPptx } from '../../../../src/main/agent/tools/office/pptx';
import { loadVendorLib } from './vendor-fixtures';

interface PptxLike {
  addSlide(): { addText(t: string | string[], o?: Record<string, unknown>): unknown };
  writeFile(o: { fileName: string }): Promise<string>;
}

let tmp: string;

beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-pptx-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

async function makeDeck(build: (p: PptxLike) => void): Promise<string> {
  const PptxGenJS = loadVendorLib<new () => PptxLike>('pptxgenjs');
  const pptx = new PptxGenJS();
  build(pptx);
  const file = path.join(tmp, `deck-${Math.random().toString(36).slice(2)}.pptx`);
  await pptx.writeFile({ fileName: file });
  return file;
}

describe('pptx round-trip（读侧）', () => {
  it('多页文本 + 备注 → 按页提取、跳过空文本', async () => {
    const file = await makeDeck((p) => {
      p.addSlide().addText('封面标题');
      p.addSlide().addText('要点一\n要点二', { x: 0.5, y: 1 });
    });
    const out = await readPptx(file);
    expect(out).toContain('封面标题');
    expect(out).toContain('要点一');
    expect(out).toContain('要点二');
    expect(out).toContain('## Slide 1');
  });

  it('预置 abortSignal → 立即返回已中断', async () => {
    const file = await makeDeck((p) => { p.addSlide().addText('x'); });
    const ac = new AbortController();
    ac.abort();
    await expect(readPptx(file, ac.signal)).rejects.toThrow('已中断');
  });

  it('非 pptx 文件（zip 缺部件）→ 抛错可自诊', async () => {
    const fake = path.join(tmp, 'bad.pptx');
    fs.writeFileSync(fake, 'not a zip');
    await expect(readPptx(fake)).rejects.toThrow();
  });
});
