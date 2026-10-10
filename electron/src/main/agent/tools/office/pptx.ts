// PPT 读写。读取零新依赖：pptx 是 zip 容器，slide XML 的 <a:t> 文本用既有
// adm-zip + cheerio 提取（css-select 命名空间选择器 a\:t，行为由 round-trip
// 测试锁死）。生成走 pptxgenjs 简单版式（spec §12：无母版继承，重样式走人工）。
// v2.1 视觉三件套（spec §14.9-1/2/4）：页背景色 / 插图（base64 data 注入，
// 不传 path 规避打包相对路径问题）/ 原生图表（addChart 活图表非截图）。

import fs from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
import * as cheerio from 'cheerio';
import PptxGenJS from 'pptxgenjs';
import { asString, asStringArray } from './format';

const SLIDE_RE = /^ppt\/slides\/slide(\d+)\.xml$/;
const NOTES_RE = /^ppt\/notesSlides\/notesSlide(\d+)\.xml$/;

function slideTexts(xml: string): string[] {
  const $ = cheerio.load(xml, { xmlMode: true });
  return $('a\\:t')
    .map((_, el) => $(el).text())
    .get()
    .filter((t) => t.trim().length > 0);
}

export async function readPptx(abs: string, signal?: AbortSignal): Promise<string> {
  const zip = new AdmZip(abs);
  const slides = zip
    .getEntries()
    .filter((e) => SLIDE_RE.test(e.entryName))
    .sort((a, b) => {
      const na = Number(SLIDE_RE.exec(a.entryName)![1]);
      const nb = Number(SLIDE_RE.exec(b.entryName)![1]);
      return na - nb; // 数值序（slide10 不能排在 slide2 前）
    });
  const notes = new Map<number, string>();
  for (const e of zip.getEntries()) {
    const m = NOTES_RE.exec(e.entryName);
    if (m) notes.set(Number(m[1]), slideTexts(e.getData().toString('utf-8')).join(' '));
  }
  if (slides.length === 0) return '(未发现幻灯片)';
  const parts: string[] = [];
  for (const [i, entry] of slides.entries()) {
    // 循环点抛已中断（spec §7）：对齐 bash/webfetch 的 resolve 先例，让 office_read catch 透传
    if (signal?.aborted) throw new Error('已中断');
    const texts = slideTexts(entry.getData().toString('utf-8'));
    parts.push(`## Slide ${i + 1}\n${texts.length > 0 ? texts.join('\n') : '(无文本)'}`);
    const note = notes.get(i + 1);
    if (note && note.length > 0) parts.push(`备注: ${note}`);
  }
  return parts.join('\n\n');
}

/** workspace 相对路径 → 绝对路径解析器（越界路径抛错）。
 * office-tools.ts 以箭头函数注入 ctx.wsFs.assertInWorkspace（方法读 this，禁止裸传引用）；
 * pptx.ts 本体不感知 WorkspaceFS 类型，保持与 workspace 模块解耦。 */
export type WorkspacePathResolver = (rel: string) => string;

/** 插图（parse 后形态）：path 保留入参相对路径供回显，abs 为已通过
 * assertInWorkspace + 存在性 + 扩展白名单校验的绝对路径（createPptx 读字节用） */
export interface PptxImageSpec {
  path: string;
  abs: string;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
}

export type PptxChartType = 'bar' | 'bar_h' | 'line' | 'pie';

/** 图表（spec §14.9-4）：categories 与各 series.values 等长（parse 保证）；
 * pie 仅 1 个系列（对齐 excel add_chart 语义）；color 为 6 位 hex 系列色 */
export interface PptxChartSpec {
  type: PptxChartType;
  categories: string[];
  series: Array<{ name: string; values: number[]; color?: string }>;
  title?: string;
}

/** 页型（2026-10-10 PPT 质量专项）：cover 封面 / section 章节隔页 / content 常规内容 /
 * chart 图表主体页 / closing 结尾页。缺省按内容自动推断（首页 cover、末页空内容
 * closing、含图表 chart、纯标题 section、其余 content）——默认即有版式感，
 * 不依赖 LLM 显式选型 */
export type PptxSlideLayout = 'cover' | 'section' | 'content' | 'chart' | 'closing';

export interface PptxSlideSpec {
  title: string;
  bullets?: string[];
  table?: { header: string[]; rows: string[][] };
  notes?: string;
  background?: string;
  images?: PptxImageSpec[];
  chart?: PptxChartSpec;
  layout?: PptxSlideLayout;
  /** 主题强调色（6 位 hex；作用于 title bar / 色块 / 章节底色），缺省商务深蓝 */
  accentColor?: string;
}

/** 图片扩展白名单（spec §14.9-2）：ext（小写）→ base64 data URL 的 mime 前缀 */
const IMAGE_MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
};

/** 插图缺省几何（英寸，pptxgenjs 单位）：h 不引图片测量依赖，按 w×0.6 兜底
 * （16:9 版心常见横图近似；需精确宽高比时显式给 h） */
const IMAGE_DEFAULT_X = 0.5;
const IMAGE_DEFAULT_Y = 1.8;
const IMAGE_DEFAULT_W = 9;
const IMAGE_DEFAULT_H_RATIO = 0.6;

/** 系列缺省色：series[].color 部分缺失时按 Office accent 序列轮转补位，
 * 与显式给色的系列区分（全缺失时不启用 chartColors，走 PowerPoint 主题默认色） */
const SERIES_FALLBACK_COLORS = ['4472C4', 'ED7D31', 'A5A5A5', 'FFC000', '5B9BD5', '70AD47'];

/** 6 位 hex 颜色校验（规则复用 excel.ts §14.8-5） */
const HEX_COLOR_RE = /^[0-9A-Fa-f]{6}$/;

const CHART_TYPES: readonly PptxChartType[] = ['bar', 'bar_h', 'line', 'pie'];

const SLIDE_LAYOUTS: readonly PptxSlideLayout[] = ['cover', 'section', 'content', 'chart', 'closing'];

function asFiniteNumber(v: unknown, what: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`参数 ${what} 不是有限数字`);
  return v;
}

function parseHexColor(v: unknown, what: string): string {
  if (typeof v !== 'string' || !HEX_COLOR_RE.test(v)) {
    throw new Error(`参数 ${what} 必须是 6 位 hex 颜色（如 4472C4）`);
  }
  return v;
}

function parseSlideImages(
  raw: unknown,
  what: string,
  resolveInWorkspace: WorkspacePathResolver | undefined,
): PptxImageSpec[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new Error(`参数 ${what} 缺失或不是非空数组`);
  if (!resolveInWorkspace) {
    throw new Error(`参数 ${what} 需要 workspace 路径解析器（调用方未注入）`);
  }
  return raw.map((im, i) => {
    if (typeof im !== 'object' || im === null) throw new Error(`${what}[${i}] 不是对象`);
    const rec = im as Record<string, unknown>;
    const rel = asString(rec.path, `${what}[${i}].path`);
    const ext = path.extname(rel).toLowerCase().replace('.', '');
    if (!(ext in IMAGE_MIME_BY_EXT)) {
      throw new Error(
        `${what}[${i}].path 不支持的图片扩展名 .${ext || '(无)'}（支持 png/jpg/jpeg/gif/webp/bmp）`,
      );
    }
    // 越界防御（.. / 符号链接逃逸 / 绝对路径）由解析器内部的 WorkspaceFS 保证
    const abs = resolveInWorkspace(rel);
    if (!fs.existsSync(abs)) throw new Error(`图片不存在: ${rel}`);
    const spec: PptxImageSpec = { path: rel, abs };
    if (rec.x !== undefined && rec.x !== null) spec.x = asFiniteNumber(rec.x, `${what}[${i}].x`);
    if (rec.y !== undefined && rec.y !== null) spec.y = asFiniteNumber(rec.y, `${what}[${i}].y`);
    if (rec.w !== undefined && rec.w !== null) {
      const w = asFiniteNumber(rec.w, `${what}[${i}].w`);
      if (w <= 0) throw new Error(`参数 ${what}[${i}].w 必须为正数`);
      spec.w = w;
    }
    if (rec.h !== undefined && rec.h !== null) {
      const h = asFiniteNumber(rec.h, `${what}[${i}].h`);
      if (h <= 0) throw new Error(`参数 ${what}[${i}].h 必须为正数`);
      spec.h = h;
    }
    return spec;
  });
}

function parseSlideChart(raw: unknown, what: string): PptxChartSpec {
  if (typeof raw !== 'object' || raw === null) throw new Error(`参数 ${what} 缺失或不是对象`);
  const rec = raw as Record<string, unknown>;
  if (typeof rec.type !== 'string' || !CHART_TYPES.includes(rec.type as PptxChartType)) {
    throw new Error(`参数 ${what}.type 必须是 bar / bar_h / line / pie`);
  }
  const type = rec.type as PptxChartType;
  const categories = asStringArray(rec.categories, `${what}.categories`);
  if (categories.length === 0) throw new Error(`参数 ${what}.categories 不能为空`);
  if (!Array.isArray(rec.series) || rec.series.length === 0) {
    throw new Error(`参数 ${what}.series 缺失或不是非空数组`);
  }
  if (type === 'pie' && rec.series.length > 1) {
    throw new Error(`参数 ${what}.series：pie 图仅支持 1 个系列`);
  }
  const series = rec.series.map((sv, si) => {
    if (typeof sv !== 'object' || sv === null) throw new Error(`${what}.series[${si}] 不是对象`);
    const s = sv as Record<string, unknown>;
    const name = asString(s.name, `${what}.series[${si}].name`);
    if (!Array.isArray(s.values) || s.values.length === 0) {
      throw new Error(`参数 ${what}.series[${si}].values 缺失或不是非空数组`);
    }
    const values = s.values.map((v, vi) => asFiniteNumber(v, `${what}.series[${si}].values[${vi}]`));
    if (values.length !== categories.length) {
      throw new Error(
        `${what}.series[${si}].values 长度 ${values.length} 与 categories 长度 ${categories.length} 不一致`,
      );
    }
    const spec: { name: string; values: number[]; color?: string } = { name, values };
    if (s.color !== undefined && s.color !== null) {
      spec.color = parseHexColor(s.color, `${what}.series[${si}].color`);
    }
    return spec;
  });
  const chart: PptxChartSpec = { type, categories, series };
  if (rec.title !== undefined && rec.title !== null) chart.title = asString(rec.title, `${what}.title`);
  return chart;
}

export function parsePptxSlides(
  raw: unknown,
  resolveInWorkspace?: WorkspacePathResolver,
): PptxSlideSpec[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new Error('参数 slides 缺失或不是非空数组');
  return raw.map((s, i) => {
    if (typeof s !== 'object' || s === null) throw new Error(`slides[${i}] 不是对象`);
    const rec = s as Record<string, unknown>;
    const spec: PptxSlideSpec = { title: asString(rec.title, `slides[${i}].title`) };
    if (rec.bullets !== undefined) spec.bullets = asStringArray(rec.bullets, `slides[${i}].bullets`);
    if (rec.notes !== undefined && rec.notes !== null) spec.notes = asString(rec.notes, `slides[${i}].notes`);
    if (rec.table !== undefined && rec.table !== null) {
      if (typeof rec.table !== 'object') throw new Error(`slides[${i}].table 不是对象`);
      const t = rec.table as Record<string, unknown>;
      spec.table = {
        header: asStringArray(t.header, `slides[${i}].table.header`),
        rows: (Array.isArray(t.rows) ? t.rows : []).map((r, ri) =>
          asStringArray(r, `slides[${i}].table.rows[${ri}]`)),
      };
    }
    if (rec.background !== undefined && rec.background !== null) {
      spec.background = parseHexColor(rec.background, `slides[${i}].background`);
    }
    if (rec.images !== undefined && rec.images !== null) {
      spec.images = parseSlideImages(rec.images, `slides[${i}].images`, resolveInWorkspace);
    }
    if (rec.chart !== undefined && rec.chart !== null) {
      spec.chart = parseSlideChart(rec.chart, `slides[${i}].chart`);
    }
    if (rec.layout !== undefined && rec.layout !== null) {
      if (typeof rec.layout !== 'string' || !SLIDE_LAYOUTS.includes(rec.layout as PptxSlideLayout)) {
        throw new Error(`slides[${i}].layout 必须是 ${SLIDE_LAYOUTS.join(' / ')}`);
      }
      spec.layout = rec.layout as PptxSlideLayout;
    }
    if (rec.accentColor !== undefined && rec.accentColor !== null) {
      spec.accentColor = parseHexColor(rec.accentColor, `slides[${i}].accentColor`);
    }
    return spec;
  });
}

/** 主题缺省强调色：商务深蓝（PowerPoint Office 主题「深蓝，着色 1，深 50%」） */
const DEFAULT_ACCENT = '1F4E79';
/** 内容正文字色（近黑深灰，比纯黑柔和） */
const BODY_TEXT_COLOR = '333333';
const MUTED_TEXT_COLOR = '767171';

/** 16:9 版面常量（英寸；pptxgenjs LAYOUT_16x9 = 10 × 5.625） */
const PAGE_W = 10;
const PAGE_H = 5.625;
const TITLE_BAR_H = 0.85;
const CONTENT_TOP = 1.15;
/** 内容区下界（页脚带上方留 0.15 呼吸） */
const CONTENT_BOTTOM = 5.25;
const FOOTER_LINE_Y = 5.4;
/** 编排器元素间纵向间隙 */
const CONTENT_GAP = 0.18;

function inferLayout(s: PptxSlideSpec, index: number, total: number): PptxSlideLayout {
  if (s.layout) return s.layout;
  // 实质内容元素优先于封面判定：单页图表/插图/表格的需求真实存在（快出一张图），
  // 真封面页通常只有标题与少量 bullets
  if (s.chart) return 'chart';
  const hasHeavyContent = s.table !== undefined || (s.images?.length ?? 0) > 0;
  if (index === 0 && !hasHeavyContent) return 'cover';
  if (index === total - 1 && !s.bullets?.length && !s.table && !s.chart && !s.images?.length) {
    return 'closing';
  }
  if (!s.bullets?.length && !s.table && !s.images?.length) return 'section';
  return 'content';
}

/** bullets 分栏阈值：超过则双栏（content 版式内自动） */
const TWO_COL_THRESHOLD = 6;

interface ContentRegion {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * 内容区几何编排器（PPT 质量专项 A）：同页 table/bullets/images/chart 顺序纵向
 * 分配，互不叠放。此前 bullets/table/chart 全部硬编码 y=1.6 同起点——图表页
 * 文本与图表必然压盖（CFO 走查实测）。chart 在场时前置元素限高（图表是页面
 * 主体）；bullets 超阈值自动双栏。
 */
function planContentRegions(s: PptxSlideSpec): {
  table?: ContentRegion;
  bullets?: ContentRegion;
  bulletsTwoCol: boolean;
  chart?: ContentRegion;
  defaultImages: Array<{ img: PptxImageSpec; region: ContentRegion }>;
} {
  const plan = {
    table: undefined as ContentRegion | undefined,
    bullets: undefined as ContentRegion | undefined,
    bulletsTwoCol: false,
    chart: undefined as ContentRegion | undefined,
    defaultImages: [] as Array<{ img: PptxImageSpec; region: ContentRegion }>,
  };
  const fullW = PAGE_W - 1.2;
  const chartPresent = s.chart !== undefined;
  let y = CONTENT_TOP;

  const remaining = () => Math.max(CONTENT_BOTTOM - y, 0.6);

  if (s.table) {
    const rows = s.table.rows.length + 1;
    const h = Math.min(rows * 0.32 + 0.4, chartPresent ? 1.8 : remaining());
    plan.table = { x: 0.6, y, w: fullW, h };
    y += h + CONTENT_GAP;
  }

  if (s.bullets && s.bullets.length > 0) {
    const twoCol = !chartPresent && !s.table && s.bullets.length > TWO_COL_THRESHOLD;
    const h = twoCol
      ? Math.min(Math.ceil(s.bullets.length / 2) * 0.36 + 0.15, remaining())
      : Math.min(s.bullets.length * 0.34 + 0.2, chartPresent ? 1.6 : remaining());
    plan.bullets = { x: 0.8, y, w: fullW - 0.4, h };
    plan.bulletsTwoCol = twoCol;
    y += h + CONTENT_GAP;
  }

  for (const img of s.images ?? []) {
    // 显式坐标的插图不参与编排（保留 LLM 精确定位能力）；仅缺省几何入队
    if (img.x !== undefined || img.y !== undefined) continue;
    const w = img.w ?? IMAGE_DEFAULT_W;
    const h = Math.min(img.h ?? Number((w * IMAGE_DEFAULT_H_RATIO).toFixed(2)), remaining());
    plan.defaultImages.push({ img, region: { x: 0.6, y, w: Math.min(w, fullW), h } });
    y += h + CONTENT_GAP;
  }

  if (s.chart) {
    const h = Math.max(remaining(), 1.2);
    plan.chart = { x: 0.6, y, w: fullW, h: Math.min(h, CONTENT_BOTTOM - y) };
  }
  return plan;
}

function addTitleBar(slide: PptxGenJS.Slide, title: string, accent: string): void {
  slide.addShape('rect', { x: 0, y: 0, w: PAGE_W, h: TITLE_BAR_H, fill: { color: accent } });
  slide.addText(title, {
    x: 0.5, y: 0.12, w: PAGE_W - 1, h: 0.62,
    fontSize: 22, bold: true, color: 'FFFFFF',
  });
}

function addFooter(slide: PptxGenJS.Slide, pageNo: number, accent: string): void {
  slide.addShape('rect', { x: 0.5, y: FOOTER_LINE_Y, w: PAGE_W - 1, h: 0.012, fill: { color: accent } });
  slide.addText(String(pageNo), {
    x: PAGE_W - 0.9, y: FOOTER_LINE_Y + 0.03, w: 0.4, h: 0.18,
    fontSize: 10, color: MUTED_TEXT_COLOR, align: 'right',
  });
}

/** chart 中文/小字号适配：类目轴与数据标签字号固定档，避免默认 12-14pt 在
 * 长中文类目（如「市场推广费执行率」）下溢出重叠 */
function chartFontOpts(): Partial<PptxGenJS.IChartOpts> {
  return {
    catAxisLabelFontSize: 11,
    valAxisLabelFontSize: 10,
    legendFontSize: 11,
    dataLabelFontSize: 10,
    titleFontSize: 14,
  };
}

export async function createPptx(slides: PptxSlideSpec[]): Promise<Buffer> {
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_16x9';
  const total = slides.length;
  for (const [index, s] of slides.entries()) {
    const slide = pptx.addSlide();
    const layout = inferLayout(s, index, total);
    const accent = s.accentColor ?? DEFAULT_ACCENT;
    if (s.background) slide.background = { color: s.background };

    if (layout === 'cover' || layout === 'closing') {
      const isCover = layout === 'cover';
      slide.addShape('rect', { x: 0, y: 0, w: 0.22, h: PAGE_H, fill: { color: accent } });
      slide.addText(s.title, {
        x: 0.85, y: isCover ? 1.7 : 2.1, w: 8.3, h: 1.1,
        fontSize: isCover ? 34 : 30, bold: true, color: isCover ? accent : BODY_TEXT_COLOR,
      });
      if (s.bullets?.length) {
        slide.addText(s.bullets.map((b) => ({ text: b, options: { breakLine: true } })), {
          x: 0.9, y: isCover ? 2.95 : 3.2, w: 8, h: 1.4, fontSize: 15, color: MUTED_TEXT_COLOR,
        });
      }
      slide.addShape('rect', { x: 0.85, y: isCover ? 1.5 : 1.95, w: 1.6, h: 0.045, fill: { color: accent } });
    } else if (layout === 'section') {
      slide.background = { color: accent };
      slide.addText(s.title, {
        x: 0.6, y: 2.05, w: 8.8, h: 0.9, fontSize: 30, bold: true, color: 'FFFFFF', align: 'center',
      });
      if (s.bullets?.length) {
        slide.addText(s.bullets.join('　·　'), {
          x: 0.6, y: 3.1, w: 8.8, h: 0.5, fontSize: 14, color: 'E8EDF4', align: 'center',
        });
      }
    } else {
      // content / chart：title bar + 内容区编排 + 页脚
      addTitleBar(slide, s.title, accent);
      addFooter(slide, index + 1, accent);
      const plan = planContentRegions(s);

      if (s.table && plan.table) {
        const header = s.table.header.map((h) => ({ text: h, options: { bold: true, color: 'FFFFFF', fill: { color: accent } } }));
        const rows = [header, ...s.table.rows.map((r) => r.map((c) => ({ text: c })))];
        slide.addTable(rows, { x: plan.table.x, y: plan.table.y, w: plan.table.w, fontSize: 12, color: BODY_TEXT_COLOR });
      }

      if (s.bullets?.length && plan.bullets) {
        const region = plan.bullets;
        if (plan.bulletsTwoCol) {
          const half = Math.ceil(s.bullets.length / 2);
          const colW = region.w / 2 - 0.15;
          const toOpts = (b: string) => ({ text: b, options: { bullet: true } });
          slide.addText(s.bullets.slice(0, half).map(toOpts), {
            x: region.x, y: region.y, w: colW, h: region.h, fontSize: 15, color: BODY_TEXT_COLOR,
          });
          slide.addText(s.bullets.slice(half).map(toOpts), {
            x: region.x + colW + 0.3, y: region.y, w: colW, h: region.h, fontSize: 15, color: BODY_TEXT_COLOR,
          });
        } else {
          slide.addText(
            s.bullets.map((b) => ({ text: b, options: { bullet: true } })),
            { x: region.x, y: region.y, w: region.w, h: region.h, fontSize: 15, color: BODY_TEXT_COLOR },
          );
        }
      }

      for (const { img, region } of plan.defaultImages) {
        slide.addImage({
          // 扩展白名单已在 parse 校验，mime 必中
          data: `${IMAGE_MIME_BY_EXT[path.extname(img.path).toLowerCase().replace('.', '')]!};base64,${fs.readFileSync(img.abs).toString('base64')}`,
          x: region.x, y: region.y, w: region.w, h: region.h,
        });
      }
      // 显式坐标插图（不参与编排）
      for (const img of (s.images ?? [])) {
        if (img.x === undefined && img.y === undefined) continue;
        const w = img.w ?? IMAGE_DEFAULT_W;
        slide.addImage({
          data: `${IMAGE_MIME_BY_EXT[path.extname(img.path).toLowerCase().replace('.', '')]!};base64,${fs.readFileSync(img.abs).toString('base64')}`,
          x: img.x ?? IMAGE_DEFAULT_X,
          y: img.y ?? IMAGE_DEFAULT_Y,
          w,
          h: img.h ?? Number((w * IMAGE_DEFAULT_H_RATIO).toFixed(2)),
        });
      }

      if (s.chart && plan.chart) {
        const c = s.chart;
        const data = c.series.map((ser) => ({ name: ser.name, labels: c.categories, values: ser.values }));
        const opts: PptxGenJS.IChartOpts = {
          x: plan.chart.x, y: plan.chart.y, w: plan.chart.w, h: plan.chart.h,
          showLegend: c.series.length > 1,
          ...chartFontOpts(),
        };
        // chartColors 按系列序取色（pptxgenjs bar/line 逐系列、pie 单系列同色）；
        // 任一系列显式给色才启用，未给色的系列按 accent 序列补位对齐次序
        if (c.series.some((ser) => ser.color)) {
          opts.chartColors = c.series.map(
            (ser, si) => ser.color ?? SERIES_FALLBACK_COLORS[si % SERIES_FALLBACK_COLORS.length]!,
          );
        }
        if (c.type === 'bar_h') opts.barDir = 'bar';
        if (c.title) {
          opts.showTitle = true;
          opts.title = c.title;
        }
        // pptxgenjs 的 ChartType 枚举仅存在于类型层（CJS 运行时不导出），
        // CHART_NAME 本就是字符串联合，直接传字面量
        const kind: 'bar' | 'line' | 'pie' = c.type === 'pie' ? 'pie' : c.type === 'line' ? 'line' : 'bar';
        slide.addChart(kind, data, opts);
      }
    }
    if (s.notes) slide.addNotes(s.notes);
  }
  const out = await pptx.write({ outputType: 'nodebuffer' });
  return Buffer.from(out as Uint8Array); // 类型层为联合类型，nodebuffer 运行时是 Buffer
}
