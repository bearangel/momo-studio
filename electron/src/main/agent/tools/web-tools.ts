// electron/src/main/agent/tools/web-tools.ts
// webfetch 工具：抓取 HTTP/HTTPS URL 并转换为 Markdown / text / html。
//
// 核心设计：
//   - HTTP 自动升级 HTTPS（拒绝 file:// / data: / ftp:// 等非 HTTP 协议）
//   - HTML → Markdown（turndown）/ 纯文本（正则去标签）/ 原样 HTML
//   - CSS 选择器提取（cheerio），命中 0 个元素抛错
//   - 非 HTML（JSON / text / 二进制元数据）原样返回
//   - 双阶段截断：原始响应 100KB + 转换后 50KB
//   - 4xx / 5xx 不抛错，返回 status 元信息
//   - 默认 20s 超时（最大 60s），通过 AbortController 中断
//   - User-Agent: 'MomoStudio-Agent/1.5 (Electron)'

import { Buffer } from 'node:buffer';
import TurndownService from 'turndown';
import * as cheerio from 'cheerio';
import type { LLMToolDef } from '../llm-provider';
import type { ToolContext, ToolModule } from './types';
import { OUTPUT_LIMITS, truncateString } from './shared/output-truncate';

/** turndown 实例配置：ATX 风格标题（#）/ 围栏代码块 / '-' 无序列表 / '_' 强调。
 *  remove 移除噪声元素，避免污染 Markdown 输出。模块级单例，避免重复构造。 */
const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
  emDelimiter: '_',
});
turndown.remove(['script', 'style', 'nav', 'footer', 'header', 'aside', 'noscript']);

/** HTML → Markdown：调用 turndown 并 trim 首尾空白。 */
function htmlToMarkdown(html: string): string {
  return turndown.turndown(html).trim();
}

/** HTML → 纯文本：正则移除 script/style/标签，解码常见实体，压缩多余空行。
 *  轻量场景使用（format=text），不引入完整 HTML parser。 */
function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** CSS 选择器提取：cheerio 加载 HTML，取首个匹配元素的 innerHTML。
 *  无匹配抛错（让 LLM 知道选择器写错了，可重试）。 */
function extractBySelector(html: string, selector: string): string {
  const $ = cheerio.load(html);
  const $el = $(selector).first();
  if ($el.length === 0) throw new Error(`CSS 选择器 "${selector}" 未匹配到元素`);
  return $el.html() ?? '';
}

/** URL 归一化：解析失败抛错；http: 自动升级 https:；非 http/https 协议拒绝。 */
function normalizeUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`非法 URL: ${raw}`);
  }
  if (parsed.protocol === 'http:') parsed.protocol = 'https:';
  if (parsed.protocol !== 'https:') {
    throw new Error(`不允许的协议: ${parsed.protocol}（仅 http/https）`);
  }
  return parsed.toString();
}

/** content-type 是否为 HTML（含 xhtml）。 */
function isHtml(contentType: string): boolean {
  return contentType.includes('text/html') || contentType.includes('application/xhtml');
}

/** 从 content-type 抽取 charset，仅返回 Node Buffer 支持的常见编码；未识别返回 null。 */
function detectCharset(contentType: string): BufferEncoding | null {
  const match = /charset=([\w-]+)/i.exec(contentType);
  if (!match) return null;
  // noUncheckedIndexedAccess: 捕获组为 string | undefined，显式判空。
  const enc = match[1];
  if (enc === undefined) return null;
  const lower = enc.toLowerCase();
  if (lower === 'utf-8' || lower === 'utf8') return 'utf-8';
  if (lower === 'ascii') return 'ascii';
  if (lower === 'latin1' || lower === 'iso-8859-1') return 'latin1';
  return null;
}

/** 读取 ReadableStream 到 Buffer，达到 maxBytes 立即停止（避免下载超大响应爆内存）。
 *  Node 20 的 Web ReadableStream 支持 async iteration，但 TS 类型库版本差异较大，
 *  这里通过 AsyncIterable<Buffer> 桥接以保证类型安全。 */
async function readBodyWithCap(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<Buffer> {
  if (!body) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of body as unknown as AsyncIterable<Buffer>) {
    total += chunk.length;
    chunks.push(Buffer.from(chunk));
    if (total >= maxBytes) break;
  }
  return Buffer.concat(chunks).subarray(0, maxBytes);
}

/** 数值钳制到 [min, max]。 */
function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

/** 把 unknown 归一化为 string，非 string 则抛错。 */
function parseStringArg(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new Error(`参数 "${name}" 缺失或不是字符串`);
  return value;
}

export class WebTools implements ToolModule {
  getDefs(): LLMToolDef[] {
    return [
      {
        name: 'webfetch',
        description:
          '抓取 HTTP/HTTPS URL 并转换为 Markdown。HTTP 自动升级 HTTPS。HTML → Markdown，非 HTML 原样返回（截断到 50KB）。',
        inputSchema: {
          type: 'object',
          properties: {
            url: { type: 'string', description: '完整 HTTP/HTTPS URL' },
            format: {
              type: 'string',
              enum: ['markdown', 'text', 'html'],
              description: '输出格式：markdown（默认）/ text / html',
            },
            selector: { type: 'string', description: 'CSS 选择器，提取页面局部' },
            timeoutMs: {
              type: 'number',
              description: '超时毫秒，默认 20000，最大 60000',
            },
          },
          required: ['url'],
        },
      },
    ];
  }

  handles(name: string): boolean {
    return name === 'webfetch';
  }

  async execute(
    name: string,
    args: Record<string, unknown>,
    _ctx: ToolContext,
  ): Promise<string> {
    if (name !== 'webfetch') throw new Error(`未知 web 工具: ${name}`);

    const rawUrl = parseStringArg(args.url, 'url');
    const format =
      args.format === 'text' || args.format === 'html' ? args.format : 'markdown';
    const selector = typeof args.selector === 'string' ? args.selector : undefined;
    const timeoutMs = clamp(
      typeof args.timeoutMs === 'number' ? args.timeoutMs : 20000,
      1000,
      60000,
    );

    // URL 归一化：协议升级与拒绝在此完成。
    const url = normalizeUrl(rawUrl);

    // 超时控制：AbortController + setTimeout。fetch reject 后判 signal.aborted 区分
    // 是超时还是网络错误。
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetch(url, {
        signal: controller.signal,
        redirect: 'follow',
        headers: {
          'User-Agent': 'MomoStudio-Agent/1.5 (Electron)',
          Accept: 'text/html,application/json,text/plain,*/*;q=0.8',
        },
      });
    } catch (err) {
      clearTimeout(timer);
      if (controller.signal.aborted) {
        throw new Error(`webfetch 超时（${timeoutMs}ms）`);
      }
      throw new Error(`webfetch 失败: ${err instanceof Error ? err.message : String(err)}`);
    }
    clearTimeout(timer);

    // 元信息头部：URL / status / content-type。
    const parts: string[] = [
      `url: ${url}`,
      `status: ${response.status}`,
      `content_type: ${response.headers.get('content-type') ?? 'unknown'}`,
    ];

    // 4xx / 5xx：不抛错，让 LLM 看到 status 后自行决策（如换 URL / 放弃）。
    if (response.status >= 400) {
      return `${parts.join('\n')}\n\n(HTTP ${response.status}，未抓取正文)`;
    }

    // 第一阶段截断：原始响应字节流上限 100KB，避免下载超大页面爆内存。
    const MAX_BYTES = OUTPUT_LIMITS.webfetch_raw;
    const buffer = await readBodyWithCap(response.body, MAX_BYTES);
    if (buffer.length === MAX_BYTES) {
      parts.push(`(原始响应已截断到 ${MAX_BYTES} 字节)`);
    }

    const contentType = response.headers.get('content-type') ?? '';
    const charset = detectCharset(contentType) ?? 'utf-8';
    const rawText = buffer.toString(charset);

    // 格式分支：
    //   - format=html → 直接返回原始文本（截断后）
    //   - 非 HTML（JSON / 纯文本） → 原样返回（截断后）
    //   - format ∈ {markdown, text} + HTML → 经 selector 提取后转 markdown / text
    if (format === 'html' || !isHtml(contentType)) {
      parts.push('', truncateString(rawText, OUTPUT_LIMITS.webfetch_converted));
    } else {
      const processed = selector ? extractBySelector(rawText, selector) : rawText;
      const converted =
        format === 'text' ? htmlToText(processed) : htmlToMarkdown(processed);
      // 第二阶段截断：转换后输出上限 50KB，控制 LLM 上下文预算。
      parts.push('', truncateString(converted, OUTPUT_LIMITS.webfetch_converted));
    }

    return parts.join('\n');
  }
}
