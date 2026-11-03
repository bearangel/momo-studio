// momo-libs 移植行为锁（spec 2026-11-03 §5.2/§6.1）：chart XML 构建与 xlsx 注入、
// pptx 模板填充。测试环境用 electron 侧依赖（exceljs/pptxgenjs/adm-zip——M4 前仍在）。
// 形状与 electron 源码一致：ChartData ← chart-xml.ts、fills ← pptx-zip.ts
// PptTemplateSlideFill；pptx 模板用 defineSlideMaster + placeholder 构造（fillPptTemplate
// 只认 <p:ph> 占位符，裸 addText 文本框无 title ph 会走错误分支——对齐既有
// office-tools.test.ts 的 fill_ppt_template 蓝本）。
import AdmZip from 'adm-zip';
import ExcelJS from 'exceljs';
import PptxGenJS from 'pptxgenjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PLUGIN_ROOT } from './fixtures';

/** 与源 chart-xml.ts ChartSeriesData 同形（JSDoc 全量标注见 momo-chart/index.js） */
interface ChartSeriesData {
  nameRef?: string;
  nameLiteral?: string;
  nameCache?: string;
  catRef: string;
  catCache: Array<string | null>;
  valRef: string;
  valCache: Array<number | null>;
  color?: string;
}

interface ChartData {
  type: 'bar' | 'bar_h' | 'line' | 'pie';
  title?: string;
  series: ChartSeriesData[];
}

/** injectXlsxChart 入参 spec（anchor 0-based 列行） */
interface XlsxChartSpec {
  sheetName: string;
  anchor: { from: { col: number; row: number }; to: { col: number; row: number } };
  chart: ChartData;
}

/** 与源 pptx-zip.ts PptTemplateSlideFill 同形 */
interface PptSlideFill {
  title: string;
  bullets?: string[];
  replaces?: Array<{ from: string; to: string }>;
}

const momoChart = require(path.join(PLUGIN_ROOT, 'vendor/momo-libs/momo-chart/index.js')) as {
  buildChartXml: (data: ChartData) => string;
  injectXlsxChart: (buf: Buffer, spec: XlsxChartSpec) => Buffer;
};
const momoPptxZip = require(path.join(PLUGIN_ROOT, 'vendor/momo-libs/momo-pptx-zip/index.js')) as {
  fillPptTemplate: (templateBuf: Buffer, slides: PptSlideFill[]) => Buffer;
};
const { validateOfficeFile } = require(path.join(PLUGIN_ROOT, 'vendor/momo-libs/momo-validate/index.js')) as {
  validateOfficeFile: (abs: string) => { ok: boolean; errors: string[] };
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-port-'));

const SERIES_A: ChartSeriesData = {
  nameLiteral: '销量',
  catRef: '数据!$A$2:$A$4', catCache: ['Q1', 'Q2', 'Q3'],
  valRef: '数据!$B$2:$B$4', valCache: [120, 180, 150],
};

/** exceljs 真产物（注入底座与生产同源） */
async function makeXlsxBuffer(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('数据');
  ws.addRow(['季度', '销量']);
  ws.addRow(['Q1', 120]);
  ws.addRow(['Q2', 180]);
  ws.addRow(['Q3', 150]);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** 1 页占位符模板（对齐 office-tools.test.ts 蓝本：母版带 title/body 占位符） */
async function makePlaceholderPptx(): Promise<Buffer> {
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_16x9';
  pptx.defineSlideMaster({
    title: 'M',
    objects: [
      { placeholder: { options: { name: 'title', type: 'title', x: 0.5, y: 0.4, w: 9, h: 1 }, text: 't' } },
      { placeholder: { options: { name: 'body', type: 'body', x: 0.7, y: 1.7, w: 8, h: 3 }, text: 'b' } },
    ],
  });
  const s = pptx.addSlide({ masterName: 'M' });
  s.addText('旧标题', { placeholder: 'title' });
  s.addText([{ text: '旧要点', options: { bullet: true } }], { placeholder: 'body' });
  return Buffer.from(await pptx.write({ outputType: 'nodebuffer' }) as Uint8Array);
}

describe('momo-chart（自 chart-xml.ts 移植）', () => {
  it('buildChartXml：bar 双系列 → chartSpace + 2 ser + 双轴 + 标题', () => {
    const xml = momoChart.buildChartXml({
      type: 'bar', title: '季度销量',
      series: [SERIES_A, { ...SERIES_A, nameLiteral: '目标', valRef: '数据!$C$2:$C$4', valCache: [100, 160, 140] }],
    });
    expect(xml).toContain('<c:chartSpace');
    expect(xml.match(/<c:ser>/g)?.length).toBe(2);
    expect(xml).toContain('<c:catAx');
    expect(xml).toContain('<c:valAx');
    expect(xml).toContain('季度销量');
  });

  it('buildChartXml：pie → 无轴', () => {
    const xml = momoChart.buildChartXml({ type: 'pie', series: [SERIES_A] });
    expect(xml).toContain('<c:chartSpace');
    expect(xml).not.toContain('<c:catAx');
  });

  it('injectXlsxChart：exceljs 产物注入 → zip 含 chart 部件且 exceljs 可重开', async () => {
    const buf = await makeXlsxBuffer();
    const out = momoChart.injectXlsxChart(buf, {
      sheetName: '数据',
      anchor: { from: { col: 3, row: 1 }, to: { col: 9, row: 16 } },
      chart: { type: 'bar', title: '季度销量', series: [SERIES_A] },
    });
    const zip = new AdmZip(out);
    expect(zip.getEntries().some((e) => e.entryName.includes('charts/chart1.xml'))).toBe(true);
    const reopen = new ExcelJS.Workbook();
    // exceljs 类型层 Buffer extends ArrayBuffer，与 Node Buffer<ArrayBufferLike> 结构
    // 不兼容——断言为 ArrayBuffer，运行时字节布局一致（excel.ts 同款处理）
    await reopen.xlsx.load(out as unknown as ArrayBuffer); // 注入后 zip 仍完整（exceljs 可打开）
  });

  it('injectXlsxChart：sheet 不存在 → 明确报错', async () => {
    const buf = await makeXlsxBuffer();
    expect(() => momoChart.injectXlsxChart(buf, {
      sheetName: '不存在',
      anchor: { from: { col: 0, row: 0 }, to: { col: 6, row: 15 } },
      chart: { type: 'bar', series: [SERIES_A] },
    })).toThrow(/sheet 不存在/);
  });
});

describe('momo-pptx-zip（自 pptx-zip.ts 移植）', () => {
  it('fillPptTemplate：替换发生 + 输出过 momo-validate + 模板语义', async () => {
    const tpl = await makePlaceholderPptx();
    const out = momoPptxZip.fillPptTemplate(tpl, [{ title: '新标题', bullets: ['要点一', '要点二'] }]);
    expect(out.equals(tpl)).toBe(false); // 确有替换发生（另存语义，输入不动）
    const slide = new AdmZip(out).readAsText('ppt/slides/slide1.xml');
    expect(slide).toContain('新标题');
    expect(slide).toContain('要点一');
    expect(slide).toContain('要点二');
    expect(slide).not.toContain('旧标题');
    const outPath = path.join(tmp, 'filled.pptx');
    fs.writeFileSync(outPath, out);
    expect(validateOfficeFile(outPath).ok).toBe(true);
  });

  it('fillPptTemplate：slides 超出模板页数 → 明确报错', async () => {
    const tpl = await makePlaceholderPptx();
    expect(() => momoPptxZip.fillPptTemplate(tpl, [
      { title: '一' }, { title: '二' },
    ])).toThrow(/超出模板页数/);
  });
});
