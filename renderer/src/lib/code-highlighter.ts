// renderer/src/lib/code-highlighter.ts
//
// shiki 高亮单例：细粒度按需加载（语言/主题动态 import → Vite 自动分包），
// JS RegExp 引擎（免 Oniguruma WASM），双主题一次渲染——亮色为默认色、
// 暗色走 --shiki-dark CSS 变量，html.dark 作用域切换，主题切换零重算。
import { createHighlighterCore, type HighlighterCore, type LanguageRegistration } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';

/** shell 类围栏：降饱和纯文本（终端输出不是源码，不与正文代码争视觉权重） */
export const SHELL_LANGS = new Set(['bash', 'sh', 'zsh', 'shell', 'console']);

/** 围栏语言别名 → shiki 语言 id；不在表内 = 纯文本 */
const LANG_ALIAS: Record<string, string> = {
  ts: 'typescript', typescript: 'typescript',
  tsx: 'tsx',
  js: 'javascript', javascript: 'javascript',
  jsx: 'jsx',
  json: 'json',
  css: 'css',
  html: 'html',
  py: 'python', python: 'python',
  go: 'go',
  rs: 'rust', rust: 'rust',
  sql: 'sql',
  yml: 'yaml', yaml: 'yaml',
  md: 'markdown', markdown: 'markdown',
};

export type ResolvedLang =
  | { kind: 'highlight'; id: string }
  | { kind: 'shell' }
  | { kind: 'plain' };

export function resolveLang(fence: string): ResolvedLang {
  const key = fence.trim().toLowerCase();
  if (SHELL_LANGS.has(key)) return { kind: 'shell' };
  const id = LANG_ALIAS[key];
  return id !== undefined ? { kind: 'highlight', id } : { kind: 'plain' };
}

// 语言动态 import 表（LangInput 接受模块 Promise，shiki 内部 await）
// shiki 4.x 的语言模块 default 为 LanguageRegistration[]；loadLanguage 接受
// MaybeArray<LanguageRegistration>，数组形态直接传入。
const langImports: Record<string, () => Promise<{ default: LanguageRegistration[] }>> = {
  typescript: () => import('shiki/langs/typescript.mjs'),
  tsx: () => import('shiki/langs/tsx.mjs'),
  javascript: () => import('shiki/langs/javascript.mjs'),
  jsx: () => import('shiki/langs/jsx.mjs'),
  json: () => import('shiki/langs/json.mjs'),
  css: () => import('shiki/langs/css.mjs'),
  html: () => import('shiki/langs/html.mjs'),
  python: () => import('shiki/langs/python.mjs'),
  go: () => import('shiki/langs/go.mjs'),
  rust: () => import('shiki/langs/rust.mjs'),
  sql: () => import('shiki/langs/sql.mjs'),
  yaml: () => import('shiki/langs/yaml.mjs'),
  markdown: () => import('shiki/langs/markdown.mjs'),
};

let highlighterPromise: Promise<HighlighterCore> | undefined;

function getHighlighter(): Promise<HighlighterCore> {
  highlighterPromise ??= createHighlighterCore({
    engine: createJavaScriptRegexEngine(),
    themes: [import('shiki/themes/github-light.mjs'), import('shiki/themes/github-dark.mjs')],
  });
  return highlighterPromise;
}

/**
 * 高亮代码块；返回 undefined = shell / 白名单外 / 加载失败（调用方渲染纯文本，
 * 高亮失败永不阻塞消息渲染）。
 */
export async function highlightCode(code: string, fence: string): Promise<string | undefined> {
  const resolved = resolveLang(fence);
  if (resolved.kind !== 'highlight') return undefined;
  try {
    const hi = await getHighlighter();
    if (!hi.getLoadedLanguages().includes(resolved.id)) {
      const loader = langImports[resolved.id];
      if (loader === undefined) return undefined;
      await hi.loadLanguage(await loader());
    }
    return hi.codeToHtml(code, {
      lang: resolved.id,
      themes: { light: 'github-light', dark: 'github-dark' },
      defaultColor: 'light',
    });
  } catch {
    return undefined;
  }
}
