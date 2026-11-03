// PPT 读取（spec 2026-11-03 §6 下线生成后仅保留读路径）。pptx 是 zip 容器，
// slide XML 的 <a:t> 文本用 adm-zip + cheerio 提取（css-select 命名空间选择器
// a\:t，行为由 round-trip 测试锁死）。生成能力由 office-pro 插件承接。

import AdmZip from 'adm-zip';
import * as cheerio from 'cheerio';

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
