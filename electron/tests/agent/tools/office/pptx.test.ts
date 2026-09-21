// pptx round-trip 测试。pptxgenjs 真生成 → 自解析真提取（双向都不 mock——
// css-select 命名空间选择器 a\:t 的真实行为由本 round-trip 锁死）。
// v2.1 视觉三件套（spec §14.9-1/2/4）：生成物 unzip 断言真实 OOXML 部件
// （<p:bg> / ppt/media / graphicFrame + ppt/charts），不信任库的中间形态。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { createPptx, parsePptxSlides, readPptx, type WorkspacePathResolver } from '../../../../src/main/agent/tools/office/pptx';

// 1x1 透明 PNG（合法最小 PNG；pptxgenjs 仅原样嵌入不解析像素）
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

let wsDir: string;

beforeEach(() => {
  wsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-pptx-ws-'));
});

afterEach(() => {
  fs.rmSync(wsDir, { recursive: true, force: true });
});

/** 模拟 office-tools.ts 的注入形态：箭头包装 + 越界防御（真实越界防御由
 * office-tools.test.ts 用真 WorkspaceFS 端到端锁定） */
const resolver: WorkspacePathResolver = (rel) => {
  if (rel.includes('..')) throw new Error('路径越界');
  return path.join(wsDir, rel);
};

/** 生成 → 落盘 → 打开 zip（slide XML / rels / media / chart 部件断言入口） */
async function generate(slidesRaw: unknown[]): Promise<AdmZip> {
  const buf = await createPptx(parsePptxSlides(slidesRaw, resolver));
  expect(buf.subarray(0, 2)).toEqual(Buffer.from([0x50, 0x4b]));
  const abs = path.join(wsDir, 'out.pptx');
  fs.writeFileSync(abs, buf);
  return new AdmZip(abs);
}

function entryText(zip: AdmZip, name: string): string {
  const e = zip.getEntry(name);
  if (!e) throw new Error(`zip 缺少部件 ${name}；实际有: ${zip.getEntries().map((x) => x.entryName).join(', ')}`);
  return e.getData().toString('utf-8');
}

/** pptxgenjs 的 chart 部件编号是模块级全局计数器（跨生成实例累加），
 * 断言一律按 chart\d+.xml 正则查找，不依赖具体编号 */
function chartEntry(zip: AdmZip): { name: string; xml: string } {
  const e = zip.getEntries().find((x) => /^ppt\/charts\/chart\d+\.xml$/.test(x.entryName));
  if (!e) throw new Error('zip 缺少 ppt/charts/chartN.xml 部件');
  return { name: e.entryName, xml: e.getData().toString('utf-8') };
}

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

describe('pptx 背景色（spec §14.9-1）', () => {
  it('slide XML 含 <p:bg> 与 hex 色值', async () => {
    const zip = await generate([{ title: '封面', background: '1F3864' }]);
    const xml = entryText(zip, 'ppt/slides/slide1.xml');
    expect(xml).toContain('<p:bg>');
    expect(xml).toContain('1F3864');
  });
  it('hex 校验拒绝', () => {
    expect(() => parsePptxSlides([{ title: 'x', background: '12345' }], resolver)).toThrow(/hex/);
    expect(() => parsePptxSlides([{ title: 'x', background: 'GGGGGG' }], resolver)).toThrow(/hex/);
    expect(() => parsePptxSlides([{ title: 'x', background: '#1F3864' }], resolver)).toThrow(/hex/);
  });
});

describe('pptx 插图（spec §14.9-2）', () => {
  it('media 部件字节一致 + slide rels 引用 image', async () => {
    fs.mkdirSync(path.join(wsDir, 'img'), { recursive: true });
    fs.writeFileSync(path.join(wsDir, 'img/logo.png'), PNG_1PX);
    const zip = await generate([{ title: '带图页', images: [{ path: 'img/logo.png', x: 1, y: 2, w: 4, h: 2 }] }]);
    const media = zip.getEntries().find((e) => /^ppt\/media\/.+\.(png|jpe?g|gif|webp|bmp)$/.test(e.entryName));
    expect(media).toBeDefined();
    expect(media!.getData().equals(PNG_1PX)).toBe(true);
    const rels = entryText(zip, 'ppt/slides/_rels/slide1.xml.rels');
    expect(rels).toContain('../media/');
    expect(rels).toContain('/image');
  });
  it('缺省几何：不给 x/y/w/h 也正常生成（h 按 w×0.6 兜底）', async () => {
    fs.writeFileSync(path.join(wsDir, 'pic.png'), PNG_1PX);
    const zip = await generate([{ title: '默认尺寸', images: [{ path: 'pic.png' }] }]);
    expect(zip.getEntries().some((e) => /^ppt\/media\/.+\.png$/.test(e.entryName))).toBe(true);
  });
  it('校验拒绝：不存在 / 坏扩展 / 越界 / 非数字坐标 / w≤0 / 未注入解析器', () => {
    expect(() => parsePptxSlides([{ title: 'x', images: [{ path: 'nope.png' }] }], resolver)).toThrow(/图片不存在/);
    fs.writeFileSync(path.join(wsDir, 'a.txt'), 'x');
    fs.writeFileSync(path.join(wsDir, 'pic.png'), PNG_1PX);
    expect(() => parsePptxSlides([{ title: 'x', images: [{ path: 'a.txt' }] }], resolver)).toThrow(/扩展名/);
    expect(() => parsePptxSlides([{ title: 'x', images: [{ path: '../escape.png' }] }], resolver)).toThrow(/越界/);
    expect(() => parsePptxSlides([{ title: 'x', images: [{ path: 'pic.png', x: 'left' }] }], resolver)).toThrow(/有限数字/);
    expect(() => parsePptxSlides([{ title: 'x', images: [{ path: 'pic.png', w: -1 }] }], resolver)).toThrow(/正数/);
    expect(() => parsePptxSlides([{ title: 'x', images: [{ path: 'pic.png', h: 0 }] }], resolver)).toThrow(/正数/);
    expect(() => parsePptxSlides([{ title: 'x', images: [{ path: 'pic.png' }] }])).toThrow(/解析器/);
    expect(() => parsePptxSlides([{ title: 'x', images: [] }], resolver)).toThrow(/非空数组/);
  });
});

describe('pptx 图表（spec §14.9-4）', () => {
  const barSlides = [{
    title: '营收',
    chart: {
      type: 'bar' as const,
      categories: ['Q1', 'Q2', 'Q3'],
      series: [
        { name: '营收', values: [100, 150, 180], color: '4472C4' },
        { name: '成本', values: [60, 70, 65] },
      ],
      title: '季度营收对比',
    },
  }];

  it('slide XML 含 graphicFrame；chart 部件含类型/系列/系列色/标题；embeddings 有数据工作簿', async () => {
    const zip = await generate(barSlides);
    expect(entryText(zip, 'ppt/slides/slide1.xml')).toContain('<p:graphicFrame>');
    const { name, xml: chartXml } = chartEntry(zip);
    expect(chartXml).toContain('<c:barChart>');
    expect(chartXml).toContain('<c:barDir val="col"/>');
    expect(chartXml).toContain('季度营收对比');
    expect(chartXml).toContain('营收');
    expect(chartXml).toContain('4472C4');
    expect(zip.getEntries().some((e) => /^ppt\/embeddings\/.+\.xlsx$/.test(e.entryName))).toBe(true);
    const rels = entryText(zip, 'ppt/slides/_rels/slide1.xml.rels');
    expect(rels).toContain(`/ppt/charts/${name.split('/').pop()}`);
  });
  it('bar_h：barDir=bar；line/pie：对应图类型', async () => {
    const hZip = await generate([{ title: '横条', chart: { type: 'bar_h', categories: ['甲', '乙'], series: [{ name: '量', values: [3, 5] }] } }]);
    expect(chartEntry(hZip).xml).toContain('<c:barDir val="bar"/>');
    const lineZip = await generate([{ title: '折线', chart: { type: 'line', categories: ['1月', '2月'], series: [{ name: '温度', values: [10, 12] }] } }]);
    expect(chartEntry(lineZip).xml).toContain('<c:lineChart>');
    const pieZip = await generate([{ title: '饼图', chart: { type: 'pie', categories: ['A', 'B'], series: [{ name: '占比', values: [30, 70] }] } }]);
    expect(chartEntry(pieZip).xml).toContain('<c:pieChart>');
  });
  it('校验拒绝：非法 type / pie 多系列 / 长度不一致 / 坏色 / 空类别 / 非数字值', () => {
    const bad = (chart: Record<string, unknown>) => parsePptxSlides([{ title: 'x', chart }], resolver);
    expect(() => bad({ type: 'scatter', categories: ['a'], series: [{ name: 's', values: [1] }] })).toThrow(/type/);
    expect(() => bad({
      type: 'pie', categories: ['a', 'b'],
      series: [{ name: 's1', values: [1, 2] }, { name: 's2', values: [3, 4] }],
    })).toThrow(/pie/);
    expect(() => bad({ type: 'bar', categories: ['a', 'b'], series: [{ name: 's', values: [1] }] })).toThrow(/不一致/);
    expect(() => bad({ type: 'bar', categories: ['a'], series: [{ name: 's', values: [1], color: 'XYZ' }] })).toThrow(/hex/);
    expect(() => bad({ type: 'bar', categories: [], series: [{ name: 's', values: [] }] })).toThrow(/categories/);
    expect(() => bad({ type: 'bar', categories: ['a'], series: [{ name: 's', values: ['x'] }] })).toThrow(/有限数字/);
    expect(() => bad({ type: 'bar', categories: ['a'] })).toThrow(/series/);
  });
});
