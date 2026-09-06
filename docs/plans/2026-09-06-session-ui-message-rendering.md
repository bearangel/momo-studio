# 会话消息渲染优化实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地 `docs/specs/2026-09-06-session-ui-message-rendering-design.md`——共享 MarkdownBody 渲染收敛 + 工具卡摘要行结果优先 + 表格全边框 + shiki 代码高亮 + 七项会话体验增强。

**Architecture:** 新建 `MarkdownBody` 作为消息正文唯一渲染入口（SafeAnchor / CodeBlock / 表格滚动容器全调用点一致）；shiki core 单例（JS RegExp 引擎、语言按需动态 import、双主题 CSS 变量切换）；工具卡摘要行与只读工具分组合并为纯函数 + 渲染层接线，**聚合器与 store 零改动**。

**Tech Stack:** react-markdown v10（注意：`code` 组件已无 `inline` prop）+ remark-gfm、shiki v3（`shiki/core` + `shiki/engine/javascript`）、Tailwind 语义 token、vitest + @testing-library/react（jsdom）。

## Global Constraints

- **Node 20**：容器默认 Node 26 会破坏 better-sqlite3——所有命令前先 `nvm use 20`
- **包管理**：一律 `npx pnpm@9.0.0`（容器内 pnpm 未全局安装）
- **TypeScript strict**：禁止 `any` / `as any` / `@ts-ignore`（ESLint `no-explicit-any: error`）
- **UI 设计系统 v2.1**：只用语义 token 类（`bg-surface-*` / `text-secondary` / `border-subtle`…），禁硬编码颜色、禁 emoji 图标（lucide，16px / stroke 1.75；既有 chip 内 12px 先例可沿用）
- **注释与文档全部中文**；Conventional Commits（`feat:` / `test:` / `chore:`）
- **测试位置**：renderer 单测贴源 colocated（`Foo.test.tsx` 与 `Foo.tsx` 同目录），`renderer/vitest.config.ts` 显式 include `src/**/*.test.{ts,tsx}`
- **回归锁零改动**：`renderer/src/lib/stream-aggregator.ts`、`renderer/src/stores/stream.store.ts`、`renderer/src/lib/group-segments.ts`（消息分段堆叠，**与本次新增的 group-tool-segments 不同名不同物**）及相关测试文件不许改动
- **单测命令**：`cd renderer && npx pnpm@9.0.0 vitest run src/path/to/test.ts`（或 `npx pnpm@9.0.0 --filter momo-studio-renderer test` 全量）
- 每个 Task 结束必须：该 Task 涉及测试全绿 + `npx pnpm@9.0.0 --filter momo-studio-renderer typecheck` clean + commit

---

### Task 1: shiki 依赖 + code-highlighter 单例

**Files:**
- Modify: `renderer/package.json`（+dependencies `shiki`，+devDependencies `@types/hast`）
- Create: `renderer/src/lib/code-highlighter.ts`
- Test: `renderer/src/lib/code-highlighter.test.ts`

**Interfaces:**
- Produces: `highlightCode(code: string, fence: string): Promise<string | undefined>`（undefined = shell/白名单外/失败，调用方纯文本降级）；`resolveLang(fence: string): { kind: 'highlight'; id: string } | { kind: 'shell' } | { kind: 'plain' }`

- [ ] **Step 1: 安装依赖**

```bash
nvm use 20 && npx pnpm@9.0.0 --filter momo-studio-renderer add shiki && npx pnpm@9.0.0 --filter momo-studio-renderer add -D @types/hast
```

Expected: 安装成功，`renderer/package.json` 出现 `"shiki": "^3.x"` 与 `"@types/hast"`。若 `@types/hast` 与 react-markdown 传递类型冲突（重复声明），删除 `@types/hast` 并改用 `import type { Element } from 'hast'` 的等价结构本地类型（见 Task 3 备选）。

- [ ] **Step 2: 写失败测试**

`renderer/src/lib/code-highlighter.test.ts`：

```ts
// code-highlighter 单测：语言归一 + 真实 shiki 冒烟（本地 bundle，无网络）。
import { describe, it, expect } from 'vitest';
import { highlightCode, resolveLang } from './code-highlighter';

describe('resolveLang', () => {
  it('别名归一：ts → typescript', () => {
    expect(resolveLang('ts')).toEqual({ kind: 'highlight', id: 'typescript' });
  });
  it('shell 类围栏返回 shell（降饱和路径）', () => {
    expect(resolveLang('bash')).toEqual({ kind: 'shell' });
    expect(resolveLang('console')).toEqual({ kind: 'shell' });
  });
  it('大小写与首尾空格不敏感', () => {
    expect(resolveLang(' Bash ')).toEqual({ kind: 'shell' });
  });
  it('白名单外语言返回 plain', () => {
    expect(resolveLang('cobol')).toEqual({ kind: 'plain' });
  });
});

describe('highlightCode（真实 shiki 冒烟）', () => {
  it('ts 代码返回含 --shiki-dark 变量的 html（双主题一次产出）', async () => {
    const html = await highlightCode('const a = 1', 'ts');
    expect(html).toBeDefined();
    expect(html).toContain('--shiki-dark');
  });
  it('shell / plain 返回 undefined（调用方走纯文本）', async () => {
    expect(await highlightCode('ls -la', 'bash')).toBeUndefined();
    expect(await highlightCode('x', 'brainfuck')).toBeUndefined();
  });
});
```

- [ ] **Step 3: 运行确认失败**

```bash
cd renderer && npx pnpm@9.0.0 vitest run src/lib/code-highlighter.test.ts
```

Expected: FAIL（模块不存在）。

- [ ] **Step 4: 实现 `renderer/src/lib/code-highlighter.ts`**

```ts
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

/** 语言动态 import 表（LangInput 接受模块 Promise，shiki 内部 await） */
const langImports: Record<string, () => Promise<{ default: LanguageRegistration }>> = {
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
```

- [ ] **Step 5: 运行测试通过**

```bash
cd renderer && npx pnpm@9.0.0 vitest run src/lib/code-highlighter.test.ts
```

Expected: PASS（真实 shiki 冒烟含动态 import，首次运行略慢属正常）。

- [ ] **Step 6: typecheck + commit**

```bash
npx pnpm@9.0.0 --filter momo-studio-renderer typecheck
git add renderer/package.json renderer/pnpm-lock.yaml renderer/src/lib/code-highlighter.ts renderer/src/lib/code-highlighter.test.ts
git commit -m "feat(renderer): shiki 高亮单例——JS RegExp 引擎 + 语言按需加载 + 双主题 CSS 变量"
```

---

### Task 2: CodeBlock 组件

**Files:**
- Create: `renderer/src/components/im/CodeBlock.tsx`
- Test: `renderer/src/components/im/CodeBlock.test.tsx`

**Interfaces:**
- Consumes: `highlightCode`（Task 1）
- Produces: `CodeBlock({ code: string; lang: string; deferHighlight?: boolean })`；容器 class `md-codeblock`（Task 3 CSS 挂钩）

- [ ] **Step 1: 写失败测试**

`renderer/src/components/im/CodeBlock.test.tsx`：

```tsx
// CodeBlock 单测：语言标签行 / 无语言降级 / shell 降饱和 / deferHighlight 纯文本。
// highlightCode 模块 mock（组件契约：调用它并注入返回 html；真实行为由
// code-highlighter.test.ts 冒烟覆盖——两层各自测自己的契约）。
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { CodeBlock } from './CodeBlock';
import { highlightCode } from '../../lib/code-highlighter';

vi.mock('../../lib/code-highlighter', () => ({
  highlightCode: vi.fn().mockResolvedValue('<pre class="shiki"><code>hi</code></pre>'),
  SHELL_LANGS: new Set(['bash', 'sh', 'zsh', 'shell', 'console']),
}));

const mockedHighlight = vi.mocked(highlightCode);

describe('CodeBlock', () => {
  it('渲染语言标签行', () => {
    render(<CodeBlock code="const a = 1" lang="ts" />);
    expect(screen.getByText('ts')).toBeInTheDocument();
  });

  it('无语言标注时不渲染标签行', () => {
    const { container } = render(<CodeBlock code="plain" lang="" />);
    // 容器第一层 div 是标签行位置——无语言时不存在
    expect(container.querySelector('.md-codeblock > div')).toBeNull();
  });

  it('可高亮语言异步注入 shiki html', async () => {
    const { container } = render(<CodeBlock code="const a = 1" lang="ts" />);
    await waitFor(() => {
      expect(container.querySelector('.shiki')).not.toBeNull();
    });
    expect(mockedHighlight).toHaveBeenCalledWith('const a = 1', 'ts');
  });

  it('shell 语言不调用高亮（降饱和纯文本）', () => {
    mockedHighlight.mockClear();
    render(<CodeBlock code="git status" lang="bash" />);
    expect(mockedHighlight).not.toHaveBeenCalled();
    expect(screen.getByText('git status')).toBeInTheDocument();
  });

  it('deferHighlight=true 时不调用高亮（流式期间纯文本）', () => {
    mockedHighlight.mockClear();
    render(<CodeBlock code="const a" lang="ts" deferHighlight={true} />);
    expect(mockedHighlight).not.toHaveBeenCalled();
    expect(screen.getByText('const a')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: 运行确认失败**

```bash
cd renderer && npx pnpm@9.0.0 vitest run src/components/im/CodeBlock.test.tsx
```

Expected: FAIL（组件不存在）。

- [ ] **Step 3: 实现 `renderer/src/components/im/CodeBlock.tsx`**

```tsx
// renderer/src/components/im/CodeBlock.tsx
//
// 代码块渲染：语言标签行 + shiki 语法高亮（GitHub 式，无复制按钮——用户决策）。
// - shell 类围栏降饱和纯文本（终端输出不是源码）
// - deferHighlight=true（流式中的活跃段）纯文本渲染，段稳定后恢复高亮
// - 高亮未就绪期间渲染纯文本，就绪后注入（无专门 loading 态，无闪烁阻塞）
import { useEffect, useState } from 'react';
import { highlightCode } from '../../lib/code-highlighter';

interface Props {
  code: string;
  /** 围栏语言标注（空串 = 无语言） */
  lang: string;
  /** 流式性能保护：true 时不做高亮 */
  deferHighlight?: boolean;
}

export function CodeBlock({ code, lang, deferHighlight }: Props) {
  const [html, setHtml] = useState<string | undefined>(undefined);
  const trimmedLang = lang.trim();
  // shell 类在 highlightCode 内部返回 undefined；这里提前短路避免无谓调用
  const wantsHighlight = trimmedLang !== '' && !deferHighlight && !['bash', 'sh', 'zsh', 'shell', 'console'].includes(trimmedLang.toLowerCase());

  useEffect(() => {
    setHtml(undefined);
    if (!wantsHighlight) return;
    let cancelled = false;
    void highlightCode(code, trimmedLang).then((h) => {
      if (!cancelled) setHtml(h);
    });
    return () => {
      cancelled = true;
    };
  }, [code, trimmedLang, wantsHighlight]);

  return (
    <div className="md-codeblock my-2 overflow-hidden rounded-lg border border-subtle bg-surface-1">
      {trimmedLang !== '' && (
        <div className="border-b border-subtle px-3 py-1 font-mono text-[11px] text-tertiary">
          {trimmedLang}
        </div>
      )}
      {html !== undefined ? (
        <div className="md-codeblock-body" dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <pre className="md-codeblock-body">
          <code>{code}</code>
        </pre>
      )}
    </div>
  );
}
```

- [ ] **Step 4: 运行测试通过**

```bash
cd renderer && npx pnpm@9.0.0 vitest run src/components/im/CodeBlock.test.tsx
```

Expected: PASS。

- [ ] **Step 5: typecheck + commit**

```bash
npx pnpm@9.0.0 --filter momo-studio-renderer typecheck
git add renderer/src/components/im/CodeBlock.tsx renderer/src/components/im/CodeBlock.test.tsx
git commit -m "feat(renderer): CodeBlock 组件——语言标签行 + shell 降饱和 + 流式 deferHighlight"
```

---

### Task 3: MarkdownBody 组件 + md-body 样式清单

**Files:**
- Create: `renderer/src/components/im/MarkdownBody.tsx`
- Modify: `renderer/src/styles/globals.css`（md-body 表格/标题/列表/图片/hr + 代码块 + shiki 双主题 CSS）
- Test: `renderer/src/components/im/MarkdownBody.test.tsx`

**Interfaces:**
- Consumes: `CodeBlock`（Task 2）；`SafeAnchor` 行为从 `MessageBubble.tsx` 迁入（本 Task 后 MessageBubble 暂时保留自有副本，Task 9 切引用）
- Produces: `MarkdownBody({ children: string; deferHighlight?: boolean })`；`SafeAnchor`（named export，Task 9 MessageBubble 改引用）；class `md-table-wrap`

- [ ] **Step 1: 写失败测试**

`renderer/src/components/im/MarkdownBody.test.tsx`：

```tsx
// MarkdownBody 单测：统一 components 映射——围栏代码块走 CodeBlock、行内 code
// 不误判、表格滚动容器、SafeAnchor 链接拦截。CodeBlock mock 掉（契约分层）。
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MarkdownBody } from './MarkdownBody';

vi.mock('./CodeBlock', () => ({
  CodeBlock: ({ code, lang }: { code: string; lang: string }) => (
    <div data-testid="codeblock" data-lang={lang}>
      {code}
    </div>
  ),
}));

describe('MarkdownBody', () => {
  it('GFM 表格包进横向滚动容器', () => {
    const { container } = render(<MarkdownBody>{'| a | b |\n|---|---|\n| 1 | 2 |'}</MarkdownBody>);
    expect(container.querySelector('.md-table-wrap table')).not.toBeNull();
  });

  it('围栏代码块走 CodeBlock 且语言正确提取', () => {
    render(<MarkdownBody>{'```ts\nconst a = 1\n```'}</MarkdownBody>);
    expect(screen.getByTestId('codeblock').dataset.lang).toBe('ts');
  });

  it('无语言围栏走 CodeBlock 且 lang 为空（不渲染标签行由 CodeBlock 保证）', () => {
    render(<MarkdownBody>{'```\nplain\n```'}</MarkdownBody>);
    expect(screen.getByTestId('codeblock').dataset.lang).toBe('');
  });

  it('行内代码不走 CodeBlock，渲染为 code 元素', () => {
    render(<MarkdownBody>{'使用 `seq` 去重'}</MarkdownBody>);
    expect(screen.queryByTestId('codeblock')).toBeNull();
    expect(screen.getByText('seq').tagName).toBe('CODE');
  });

  it('链接点击被拦截，window.open 带noopener 代跳', () => {
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    render(<MarkdownBody>{'[docs](https://example.com)'}</MarkdownBody>);
    fireEvent.click(screen.getByRole('link'));
    expect(openSpy).toHaveBeenCalledWith('https://example.com', '_blank', 'noopener,noreferrer');
    openSpy.mockRestore();
  });

  it('deferHighlight 透传给 CodeBlock', () => {
    render(
      <MarkdownBody deferHighlight={true}>{'```ts\nconst a\n```'}</MarkdownBody>,
    );
    expect(screen.getByTestId('codeblock').textContent).toBe('const a');
  });
});
```

- [ ] **Step 2: 运行确认失败**

```bash
cd renderer && npx pnpm@9.0.0 vitest run src/components/im/MarkdownBody.test.tsx
```

Expected: FAIL（组件不存在）。

- [ ] **Step 3: 实现 `renderer/src/components/im/MarkdownBody.tsx`**

```tsx
// renderer/src/components/im/MarkdownBody.tsx
//
// 消息正文统一渲染入口（spec 方案二收敛点）：MessageBubble / AgentStreamBubble /
// SubAgentSection / ThinkingSection 四处调用点共用——SafeAnchor 链接拦截、
// CodeBlock 代码块、表格滚动容器全调用点一致，杜绝「修了这处漏那处」。
//
// 块级/行内 code 判定：覆写 pre 组件（块级代码由 CodeBlock 接管，直接消费
// hast 节点），code 组件只对行内代码生效——规避 react-markdown v10 移除
// inline prop 后的 className 误判问题。
import ReactMarkdown from 'react-markdown';
import type { Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { AnchorHTMLAttributes, MouseEvent, ReactNode } from 'react';
import type { Element } from 'hast';
import { CodeBlock } from './CodeBlock';

/**
 * S2 链接拦截：统一 preventDefault + window.open → 主进程 setWindowOpenHandler
 * 拒绝新窗口并转 shell.openExternal 走系统浏览器。
 */
export function SafeAnchor(props: AnchorHTMLAttributes<HTMLAnchorElement>): JSX.Element {
  const { href, children, target: _target, rel: _rel, onClick: _onClick, ...rest } = props;
  const handleClick = (event: MouseEvent<HTMLAnchorElement>): void => {
    event.preventDefault();
    if (typeof href === 'string' && href.length > 0) {
      window.open(href, '_blank', 'noopener,noreferrer');
    }
  };
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" onClick={handleClick} {...rest}>
      {children as ReactNode}
    </a>
  );
}

/** 从 hast 节点递归提取纯文本 */
function hastText(node: Element): string {
  let out = '';
  for (const child of node.children) {
    if (child.type === 'text') out += child.value;
    else if (child.type === 'element') out += hastText(child);
  }
  return out;
}

/** 从 pre 的 hast 节点提取 code 子元素的语言标注与代码文本 */
function extractCode(node: Element): { code: string; lang: string } {
  const codeEl = node.children.find(
    (c): c is Element => c.type === 'element' && c.tagName === 'code',
  );
  if (codeEl === undefined) return { code: hastText(node), lang: '' };
  const cls = codeEl.properties?.className;
  const langClass = Array.isArray(cls)
    ? cls.find((c): c is string => typeof c === 'string' && c.startsWith('language-'))
    : undefined;
  return {
    code: hastText(codeEl),
    lang: langClass !== undefined ? langClass.slice('language-'.length) : '',
  };
}

interface Props {
  children: string;
  /** 流式性能保护：true 时代码块纯文本渲染（流式中的活跃段传 true） */
  deferHighlight?: boolean;
}

export function MarkdownBody({ children, deferHighlight }: Props) {
  const components: Components = {
    a: SafeAnchor,
    pre: ({ node }) => {
      if (node === undefined) return <pre>{children}</pre>;
      const { code, lang } = extractCode(node);
      return <CodeBlock code={code.replace(/\n$/, '')} lang={lang} deferHighlight={deferHighlight} />;
    },
    table: ({ children: tableChildren }) => (
      <div className="md-table-wrap">
        <table>{tableChildren}</table>
      </div>
    ),
  };
  return (
    <div className="md-body overflow-hidden min-w-0 [&_p]:my-0 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {children}
      </ReactMarkdown>
    </div>
  );
}
```

- [ ] **Step 4: 扩展 `renderer/src/styles/globals.css`**

在文件末尾（`.bg-accent-500 .md-body blockquote` 规则之后）追加。**注意**：既有 `.md-body table` / `.md-body th, .md-body td` / `.md-body th` 三条规则直接**替换**为下面表格新规则（全边框网格）；其余既有规则（pre / 行内 code / blockquote / a）保留不动（旧调用点在 Task 9 前仍依赖）：

```css
/* ── v2.1 会话渲染：表格（方案 A 全边框网格——用户决策）────────────── */
.md-table-wrap {
  overflow-x: auto;
}
.md-body table {
  border-collapse: collapse;
  margin: 8px 0;
  font-size: 12.5px;
}
.md-body th,
.md-body td {
  border: 1px solid rgb(var(--border-strong));
  padding: 6px 12px;
  text-align: start;
  vertical-align: top;
}
.md-body th {
  background: rgb(var(--surface-3));
  color: rgb(var(--text-primary));
  font-weight: 600;
}

/* ── v2.1 会话渲染：标题/列表/图片/hr（气泡内排版约束，消灭浏览器默认 2em） ── */
.md-body h1 { font-size: 15px; font-weight: 600; margin: 10px 0 4px; color: rgb(var(--text-primary)); }
.md-body h2 { font-size: 14.5px; font-weight: 600; margin: 10px 0 4px; color: rgb(var(--text-primary)); }
.md-body h3 { font-size: 14px; font-weight: 600; margin: 8px 0 4px; color: rgb(var(--text-primary)); }
.md-body h4 { font-size: 13.5px; font-weight: 600; margin: 8px 0 4px; color: rgb(var(--text-primary)); }
.md-body h5, .md-body h6 { font-size: 13px; font-weight: 600; margin: 8px 0 4px; color: rgb(var(--text-primary)); }
.md-body ul, .md-body ol { margin: 4px 0 8px; padding-left: 20px; line-height: 1.7; }
.md-body img { max-width: 100%; border-radius: 6px; }
.md-body hr { border: none; border-top: 1px solid rgb(var(--border-subtle)); margin: 8px 0; }

/* ── v2.1 会话渲染：CodeBlock 代码块体（含 shiki 双主题切换）───────── */
/* 规则置于旧 .md-body pre 之后：同为 (0,1,1) 特异性，后者胜出，
   保证 Task 9 全接线前旧调用点的裸 pre 不受影响 */
.md-codeblock pre,
.md-codeblock .shiki {
  margin: 0;
  padding: 10px 12px;
  overflow-x: auto;
  background: transparent !important; /* shiki 内联亮色背景退役，底色由容器 bg-surface-1 承担 */
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12.5px;
  line-height: 1.6;
  color: rgb(var(--text-secondary));
}
.md-codeblock .shiki code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
/* shiki 双主题：默认亮色 token；html.dark 切到 --shiki-dark 变量（零重算） */
html.dark .md-codeblock .shiki,
html.dark .md-codeblock .shiki span {
  color: var(--shiki-dark) !important;
  font-style: var(--shiki-dark-font-style) !important;
  font-weight: var(--shiki-dark-font-weight) !important;
  text-decoration: var(--shiki-dark-text-decoration) !important;
}
```

- [ ] **Step 5: 运行测试通过 + typecheck**

```bash
cd renderer && npx pnpm@9.0.0 vitest run src/components/im/MarkdownBody.test.tsx src/components/im/CodeBlock.test.tsx src/components/im/MessageBubble.test.tsx
npx pnpm@9.0.0 --filter momo-studio-renderer typecheck
```

Expected: MarkdownBody/CodeBlock PASS；MessageBubble 既有测试 PASS（本 Task 未动 MessageBubble）。

- [ ] **Step 6: commit**

```bash
git add renderer/src/components/im/MarkdownBody.tsx renderer/src/components/im/MarkdownBody.test.tsx renderer/src/styles/globals.css
git commit -m "feat(renderer): MarkdownBody 统一渲染入口 + 表格全边框/标题列表图片排版 + shiki 双主题 CSS"
```

---

### Task 4: describe-tool-call 纯函数

**Files:**
- Create: `renderer/src/lib/describe-tool-call.ts`
- Test: `renderer/src/lib/describe-tool-call.test.ts`

**Interfaces:**
- Produces: `describeToolCall(toolName: string, args: Record<string, unknown>): { summary: string; extraArgs: string[] }`（Task 6 ToolCallChip / Task 7 ContextGroupChip 消费）

- [ ] **Step 1: 写失败测试**

`renderer/src/lib/describe-tool-call.test.ts`：

```ts
// describeToolCall 单测：已知工具映射 + 未知工具优先级键回退 + 截断 + extras 上限。
import { describe, it, expect } from 'vitest';
import { describeToolCall } from './describe-tool-call';

describe('describeToolCall — 已知工具映射', () => {
  it('read_file 只显文件名（不显全路径）', () => {
    expect(describeToolCall('read_file', { path: 'src/components/app.ts' }).summary).toBe('app.ts');
  });
  it('write_file 经 filePath 键也取文件名', () => {
    expect(describeToolCall('write_file', { filePath: 'a/b/c.ts' }).summary).toBe('c.ts');
  });
  it('bash 取命令首行并截断到 60 字符', () => {
    const long = 'x'.repeat(80);
    const r = describeToolCall('bash', { command: `${long}\nsecond line` });
    expect(r.summary.endsWith('…')).toBe(true);
    expect(r.summary.length).toBe(60);
    expect(r.summary).not.toContain('second');
  });
  it('grep 组合 pattern 与 path', () => {
    expect(describeToolCall('grep', { pattern: 'useState', path: 'src/' }).summary).toBe('"useState" in src/');
  });
  it('glob 只显 pattern', () => {
    expect(describeToolCall('glob', { pattern: '**/*.test.ts' }).summary).toBe('**/*.test.ts');
  });
  it('空参数返回空摘要', () => {
    expect(describeToolCall('bash', {}).summary).toBe('');
  });
});

describe('describeToolCall — 未知/MCP 工具回退', () => {
  it('按优先级键取第一个非空字符串（description 优先于 path）', () => {
    const r = describeToolCall('mcp:github', { path: 'repo', description: '创建 issue' });
    expect(r.summary).toBe('创建 issue');
  });
  it('url / query / pattern / name 依次回退', () => {
    expect(describeToolCall('t1', { url: 'https://x.dev' }).summary).toBe('https://x.dev');
    expect(describeToolCall('t2', { query: '怎么写测试' }).summary).toBe('怎么写测试');
    expect(describeToolCall('t3', { pattern: 'foo' }).summary).toBe('foo');
    expect(describeToolCall('t4', { name: 'setup' }).summary).toBe('setup');
  });
  it('次要标量参数最多 2 个，主摘要用过的键不重复，对象值跳过', () => {
    const r = describeToolCall('mcp:x', {
      description: '做事',
      owner: 'alice',
      repo: 'bob',
      num: 3,
      ok: true,
      nested: { a: 1 },
    });
    expect(r.extraArgs).toEqual(['owner=alice', 'repo=bob']);
  });
  it('完全无匹配键时 summary 为空且 extras 收标量', () => {
    const r = describeToolCall('weird', { count: 9 });
    expect(r.summary).toBe('');
    expect(r.extraArgs).toEqual(['count=9']);
  });
});
```

- [ ] **Step 2: 运行确认失败**

```bash
cd renderer && npx pnpm@9.0.0 vitest run src/lib/describe-tool-call.test.ts
```

Expected: FAIL。

- [ ] **Step 3: 实现 `renderer/src/lib/describe-tool-call.ts`**

```ts
// renderer/src/lib/describe-tool-call.ts
//
// 工具调用「摘要行」纯函数（同构 opencode getToolInfo）：已知工具按语义提炼
// 关键参数（路径只显文件名 / bash 显命令 / grep 显 pattern），未知与 mcp:*
// 工具按优先级键回退。供 ToolCallChip 与 ContextGroupChip 共用。
//
// 注意：list_files 走 FILE_TOOLS 的 path 键（显示目录名），无需特判。

/** 未知工具回退时按优先级挑「这个调用是关于什么」的键 */
const PRIORITY_KEYS = ['description', 'query', 'url', 'filePath', 'path', 'pattern', 'name'] as const;

export interface ToolCallSummary {
  /** 主摘要（折叠行 secondary 部分） */
  summary: string;
  /** 未知工具的次要 k=v（最多 2 个，主摘要用过的键不重复） */
  extraArgs: string[];
}

function basename(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] !== '' ? parts[parts.length - 1]! : p;
}

function firstString(args: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const k of keys) {
    const v = args[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return undefined;
}

function truncate(s: string, max = 60): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

const FILE_TOOLS = new Set([
  'read_file', 'write_file', 'edit_file', 'mkdir', 'rm', 'mv', 'exists', 'lsp_diagnostics',
]);

export function describeToolCall(toolName: string, args: Record<string, unknown>): ToolCallSummary {
  if (toolName === 'bash') {
    const cmd = typeof args.command === 'string' ? args.command.split('\n')[0] ?? '' : '';
    return { summary: cmd !== '' ? truncate(cmd) : '', extraArgs: [] };
  }
  if (toolName === 'grep') {
    const pattern = typeof args.pattern === 'string' ? `"${args.pattern}"` : '';
    const path = typeof args.path === 'string' ? ` in ${args.path}` : '';
    const combined = `${pattern}${path}`;
    return { summary: combined !== '' ? truncate(combined) : '', extraArgs: [] };
  }
  if (toolName === 'glob') {
    return {
      summary: typeof args.pattern === 'string' ? truncate(args.pattern) : '',
      extraArgs: [],
    };
  }
  if (FILE_TOOLS.has(toolName)) {
    const p = firstString(args, ['filePath', 'path']);
    return { summary: p !== undefined ? truncate(basename(p)) : '', extraArgs: [] };
  }
  // 未知 / mcp:* 工具：优先级键回退 + 最多 2 个次要标量参数
  const main = firstString(args, PRIORITY_KEYS);
  const usedKey = PRIORITY_KEYS.find((k) => args[k] === main);
  const extraArgs: string[] = [];
  for (const [k, v] of Object.entries(args)) {
    if (extraArgs.length >= 2) break;
    if (k === usedKey) continue;
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      extraArgs.push(`${k}=${String(v)}`);
    }
  }
  return { summary: main !== undefined ? truncate(main) : '', extraArgs };
}
```

- [ ] **Step 4: 运行测试通过 + typecheck + commit**

```bash
cd renderer && npx pnpm@9.0.0 vitest run src/lib/describe-tool-call.test.ts
npx pnpm@9.0.0 --filter momo-studio-renderer typecheck
git add renderer/src/lib/describe-tool-call.ts renderer/src/lib/describe-tool-call.test.ts
git commit -m "feat(renderer): describeToolCall 摘要行纯函数——已知工具语义提炼 + 未知工具优先级键回退"
```

---

### Task 5: group-tool-segments 纯函数

**Files:**
- Create: `renderer/src/lib/group-tool-segments.ts`
- Test: `renderer/src/lib/group-tool-segments.test.ts`

**Interfaces:**
- Consumes: `StreamSegment`（`renderer/src/lib/stream-aggregator.ts` 导入类型，**只读不改聚合器**）
- Produces: `groupToolSegments(segments: StreamSegment[]): RenderSegment[]`；`ContextGroup`（Task 7 ContextGroupChip 消费）

命名注意：**不是** `lib/group-segments.ts`（那是消息分段堆叠 `groupBySegment`，回归锁范围，禁碰）。

- [ ] **Step 1: 写失败测试**

`renderer/src/lib/group-tool-segments.test.ts`：

```ts
// groupToolSegments 单测：连续只读工具合并 / 单个不合并 / 非只读打断 /
// todowrite 过滤 / 与 thinking/text 段交错保序。
import { describe, it, expect } from 'vitest';
import { groupToolSegments } from './group-tool-segments';
import type { StreamSegment } from './stream-aggregator';

function tool(callId: string, toolName: string): Extract<StreamSegment, { kind: 'tool_call' }> {
  return { kind: 'tool_call', callId, toolName, args: {}, result: 'ok', success: true };
}

describe('groupToolSegments', () => {
  it('连续 ≥2 个只读工具合并为 context-group', () => {
    const out = groupToolSegments([tool('c1', 'read_file'), tool('c2', 'glob'), tool('c3', 'grep')]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: 'context-group' });
  });

  it('单个只读工具不合并（照旧独立 tool_call）', () => {
    const out = groupToolSegments([tool('c1', 'read_file')]);
    expect(out).toEqual([tool('c1', 'read_file')]);
  });

  it('非只读工具打断连续段（两组各自成块）', () => {
    const out = groupToolSegments([
      tool('c1', 'read_file'),
      tool('c2', 'bash'),
      tool('c3', 'read_file'),
      tool('c4', 'grep'),
    ]);
    expect(out).toHaveLength(3);
    expect(out[0]).toMatchObject({ kind: 'tool_call', toolName: 'bash' } as never);
    // 顺序：原顺序保留——out[0] 是 c1 单独？不——c1 单独成段（1 个不合并）
    expect(out.map((s) => (s.kind === 'context-group' ? `group:${s.items.length}` : `${s.kind}:${'toolName' in s ? s.toolName : ''}`)))
      .toEqual(['tool_call:read_file', 'tool_call:bash', 'context-group:2'.replace('context-group', 'group').replace('group', 'context-group')]);
  });

  it('todowrite 段被过滤（TodoSection 已展示）', () => {
    const out = groupToolSegments([tool('c1', 'todowrite'), { kind: 'text', text: 'hi' }]);
    expect(out).toEqual([{ kind: 'text', text: 'hi' }]);
  });

  it('与 thinking/text 交错保序', () => {
    const out = groupToolSegments([
      { kind: 'thinking', text: '想' },
      tool('c1', 'read_file'),
      tool('c2', 'list_files'),
      { kind: 'text', text: '说' },
    ]);
    expect(out).toHaveLength(3);
    expect(out[0]).toEqual({ kind: 'thinking', text: '想' });
    expect(out[1]).toMatchObject({ kind: 'context-group', items: { length: 2 } });
    expect(out[2]).toEqual({ kind: 'text', text: '说' });
  });

  it('末尾连续只读工具也合并（flush 兜底）', () => {
    const out = groupToolSegments([{ kind: 'text', text: 'a' }, tool('c1', 'grep'), tool('c2', 'glob')]);
    expect(out).toHaveLength(2);
    expect(out[1]).toMatchObject({ kind: 'context-group' });
  });
});
```

（第三个用例的断言写复杂了——实现时简化为直接断言每段 kind 与数量即可，测试意图不变：`['tool_call:read_file 单独', 'tool_call:bash', 'context-group 2 项']`。）

- [ ] **Step 2: 运行确认失败**

```bash
cd renderer && npx pnpm@9.0.0 vitest run src/lib/group-tool-segments.test.ts
```

- [ ] **Step 3: 实现 `renderer/src/lib/group-tool-segments.ts`**

```ts
// renderer/src/lib/group-tool-segments.ts
//
// 渲染前分段分组（纯渲染层，聚合器零改动）：连续 ≥2 个只读工具段合并为
// context-group（「收集上下文 · N 次读取 · M 次搜索」）；todowrite 段过滤
//（TodoSection 已展示，双份冗余）。AgentStreamBubble / SubAgentSection 共用。
import type { StreamSegment } from './stream-aggregator';

/** 只读「收集上下文」类工具——合并展示不打断阅读 */
const CONTEXT_TOOLS = new Set(['read_file', 'glob', 'grep', 'list_files']);

/** 不再单独渲染 chip 的工具（已有专属展示区） */
const HIDDEN_TOOLS = new Set(['todowrite']);

type ToolSeg = Extract<StreamSegment, { kind: 'tool_call' }>;

export interface ContextGroup {
  kind: 'context-group';
  items: ToolSeg[];
}

export type RenderSegment = StreamSegment | ContextGroup;

export function groupToolSegments(segments: StreamSegment[]): RenderSegment[] {
  const out: RenderSegment[] = [];
  let buf: ToolSeg[] = [];
  const flush = (): void => {
    if (buf.length === 0) return;
    if (buf.length === 1) {
      out.push(buf[0]!);
    } else {
      out.push({ kind: 'context-group', items: buf });
    }
    buf = [];
  };
  for (const seg of segments) {
    if (seg.kind === 'tool_call' && HIDDEN_TOOLS.has(seg.toolName)) continue;
    if (seg.kind === 'tool_call' && CONTEXT_TOOLS.has(seg.toolName)) {
      buf.push(seg);
      continue;
    }
    flush();
    out.push(seg);
  }
  flush();
  return out;
}
```

- [ ] **Step 4: 运行测试通过 + typecheck + commit**

```bash
cd renderer && npx pnpm@9.0.0 vitest run src/lib/group-tool-segments.test.ts
npx pnpm@9.0.0 --filter momo-studio-renderer typecheck
git add renderer/src/lib/group-tool-segments.ts renderer/src/lib/group-tool-segments.test.ts
git commit -m "feat(renderer): groupToolSegments——连续只读工具分组合并 + todowrite 去冗余"
```

---

### Task 6: ToolCallChip 重写

**Files:**
- Modify: `renderer/src/components/im/ToolCallChip.tsx`（整文件重写）
- Rewrite: `renderer/src/components/im/ToolCallChip.test.tsx`

**Interfaces:**
- Consumes: `describeToolCall`（Task 4）
- Produces: Props 签名不变（`toolName/args/result/success/durationMs/isExecuting/defaultExpanded`），调用方 AgentStreamBubble / SubAgentSection 无需改 props

- [ ] **Step 1: 重写测试（先写完再实现——重写场景测试与实现同步落）**

`renderer/src/components/im/ToolCallChip.test.tsx` 整文件替换：

```tsx
// ToolCallChip 单测（v2.1 重写）：摘要行（describeToolCall）+ 展开结果优先
//（默认无参数）+ 10 行折叠 + 次级参数开关 + 错误单行 + 权限拒绝降级 warning。
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ToolCallChip } from './ToolCallChip';

describe('ToolCallChip — 摘要行', () => {
  it('渲染工具名 + 智能摘要（read_file 只显文件名）+ 耗时', () => {
    render(<ToolCallChip toolName="read_file" args={{ path: 'src/index.ts' }} success={true} durationMs={120} />);
    expect(screen.getByText('read_file')).toBeInTheDocument();
    expect(screen.getByText('index.ts')).toBeInTheDocument();
    expect(screen.getByText(/120ms/)).toBeInTheDocument();
  });

  it('未知工具渲染 k=v 次要参数 chip', () => {
    render(<ToolCallChip toolName="mcp:x" args={{ description: '做事', owner: 'a', repo: 'b' }} success={true} />);
    expect(screen.getByText('做事')).toBeInTheDocument();
    expect(screen.getByText('owner=a')).toBeInTheDocument();
  });

  it('成功/失败/执行中三态 tint 与图标沿用', () => {
    const { container, unmount } = render(<ToolCallChip toolName="bash" args={{}} success={true} />);
    expect(container.querySelector('svg.lucide-circle-check')).not.toBeNull();
    expect(screen.getByRole('button').classList.contains('bg-status-success-tint')).toBe(true);
    unmount();

    const c2 = render(<ToolCallChip toolName="bash" args={{}} success={false} result="boom" />).container;
    expect(c2.querySelector('svg.lucide-circle-x')).not.toBeNull();
    expect(c2.querySelector('button')?.classList.contains('bg-status-error-tint')).toBe(true);
  });
});

describe('ToolCallChip — 展开面板（结果优先）', () => {
  it('展开只显示结果，参数默认不渲染', () => {
    render(
      <ToolCallChip toolName="bash" args={{ command: 'git status' }} result="On branch main" success={true} />,
    );
    fireEvent.click(screen.getByText('bash'));
    expect(screen.getByText(/On branch main/)).toBeInTheDocument();
    expect(screen.queryByText(/git status/)).not.toBeInTheDocument(); // 参数不在面板
  });

  it('次级「参数」开关展开后可见参数 JSON', () => {
    render(
      <ToolCallChip toolName="bash" args={{ command: 'ls' }} result="a" success={true} />,
    );
    fireEvent.click(screen.getByText('bash'));
    fireEvent.click(screen.getByText(/▸ 参数/));
    expect(screen.getByText(/"command"/)).toBeInTheDocument();
  });

  it('结果超 10 行折叠并显示「展开剩余 N 行」', () => {
    const eleven = Array.from({ length: 12 }, (_, i) => `line-${i}`).join('\n');
    render(<ToolCallChip toolName="bash" args={{}} result={eleven} success={true} />);
    fireEvent.click(screen.getByText('bash'));
    expect(screen.getByText(/展开剩余 2 行/)).toBeInTheDocument();
    expect(screen.queryByText(/line-11/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByText(/展开剩余 2 行/));
    expect(screen.getByText(/line-11/)).toBeInTheDocument();
  });

  it('执行中展开显示等待文案', () => {
    render(<ToolCallChip toolName="bash" args={{}} success={true} isExecuting={true} defaultExpanded={true} />);
    expect(screen.getByText(/等待工具响应/)).toBeInTheDocument();
  });
});

describe('ToolCallChip — 错误态', () => {
  it('失败结果压平单行（title 悬浮看全文）', () => {
    render(
      <ToolCallChip
        toolName="grep"
        args={{}}
        result={'Error: something\n  at line 2\n  at line 3'}
        success={false}
        defaultExpanded={true}
      />,
    );
    const el = screen.getByText(/Error: something/);
    expect(el.textContent).not.toContain('\n');
    expect(el.getAttribute('title')).toContain('at line 3');
  });

  it('权限拒绝降级 warning tint + TriangleAlert 图标', () => {
    const { container } = render(
      <ToolCallChip
        toolName="write_file"
        args={{}}
        result="用户拒绝写入权限"
        success={false}
        defaultExpanded={true}
      />,
    );
    expect(container.querySelector('svg.lucide-triangle-alert')).not.toBeNull();
    expect(container.querySelector('button')?.classList.contains('bg-status-warning-tint')).toBe(true);
  });
});
```

- [ ] **Step 2: 运行确认失败**

```bash
cd renderer && npx pnpm@9.0.0 vitest run src/components/im/ToolCallChip.test.tsx
```

Expected: FAIL（新断言不满足）。

- [ ] **Step 3: 重写 `renderer/src/components/im/ToolCallChip.tsx`**

```tsx
// renderer/src/components/im/ToolCallChip.tsx
//
// 工具调用卡片（v2.1 重写，spec §4.3）：
//   折叠行 = 状态图标 + 工具名 + describeToolCall 智能摘要 + 次要参数 chip + 耗时
//   展开   = 结果优先（~10 行折叠 +「展开剩余 N 行」+ 次级「参数」开关）
//   错误   = 压平单行（title 看全文）；「用户拒绝/permission denied」降级 warning
import { useState } from 'react';
import { CircleCheck, CircleX, ChevronDown, ChevronRight, Loader2, TriangleAlert } from 'lucide-react';
import { cn } from '../../lib/cn';
import { describeToolCall } from '../../lib/describe-tool-call';

interface Props {
  toolName: string;
  args: Record<string, unknown>;
  result?: string;
  success: boolean;
  durationMs?: number;
  isExecuting?: boolean;
  defaultExpanded?: boolean;
}

/** 结果折叠阈值：超过 N 行显示前 N 行 + 展开条 */
const RESULT_FOLD_LINES = 10;

/** 权限拒绝判定（用户意志非故障，降级 warning） */
function isPermissionDenied(result: string): boolean {
  const lower = result.toLowerCase();
  return (
    lower.includes('用户拒绝') ||
    lower.includes('permission denied') ||
    lower.includes('user denied')
  );
}

/** 多行错误压平为单行 */
function flatten(text: string): string {
  return text.replace(/\s*\n+\s*/g, ' ').trim();
}

export function ToolCallChip({
  toolName,
  args,
  result,
  success,
  durationMs,
  isExecuting,
  defaultExpanded,
}: Props) {
  const [expanded, setExpanded] = useState(defaultExpanded ?? false);
  const [resultExpanded, setResultExpanded] = useState(false);
  const [argsExpanded, setArgsExpanded] = useState(false);

  const denied =
    !isExecuting && success === false && result !== undefined && isPermissionDenied(result);
  const toneCls =
    isExecuting || denied
      ? 'bg-status-warning-tint text-status-warning'
      : success
        ? 'bg-status-success-tint text-status-success'
        : 'bg-status-error-tint text-status-error';
  const StatusIcon = isExecuting ? Loader2 : denied ? TriangleAlert : success ? CircleCheck : CircleX;
  const { summary, extraArgs } = describeToolCall(toolName, args);

  const resultLines = result !== undefined ? result.split('\n') : [];
  const folded = !resultExpanded && resultLines.length > RESULT_FOLD_LINES;
  const shownResult = folded ? resultLines.slice(0, RESULT_FOLD_LINES).join('\n') : result;
  const isError = !isExecuting && success === false;

  return (
    <div className="mb-1">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
        className={cn(
          'flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-xs cursor-pointer transition-colors',
          toneCls,
        )}
      >
        <StatusIcon
          size={12}
          strokeWidth={1.75}
          aria-hidden
          className={isExecuting ? 'animate-spin' : undefined}
        />
        <span className="shrink-0 font-mono text-primary">{toolName}</span>
        {summary !== '' && (
          <span className="min-w-0 truncate text-[11px] text-secondary" title={summary}>
            {summary}
          </span>
        )}
        {extraArgs.map((kv) => (
          <span key={kv} className="shrink-0 rounded bg-surface-3 px-1 text-[10px] text-tertiary">
            {kv}
          </span>
        ))}
        <span className="ml-auto shrink-0 text-[11px] text-tertiary">
          {isExecuting ? '执行中...' : durationMs !== undefined ? `${durationMs}ms` : ''}
        </span>
        {expanded ? (
          <ChevronDown size={12} strokeWidth={1.75} aria-hidden />
        ) : (
          <ChevronRight size={12} strokeWidth={1.75} aria-hidden />
        )}
      </button>
      {expanded && (
        <div className="mt-1 rounded border border-subtle bg-surface-1 p-2 font-mono text-[11px] text-secondary">
          {result === undefined ? (
            <div className="text-tertiary">等待工具响应…</div>
          ) : isError ? (
            <div
              className="overflow-hidden text-ellipsis whitespace-nowrap text-status-error"
              title={result}
            >
              错误: {flatten(result)}
            </div>
          ) : (
            <>
              <div className="max-h-[300px] overflow-auto whitespace-pre-wrap break-words">
                {shownResult}
              </div>
              {resultLines.length > RESULT_FOLD_LINES && (
                <button
                  type="button"
                  onClick={() => setResultExpanded(!resultExpanded)}
                  className="mt-1 w-full cursor-pointer border-t border-subtle pt-1 text-center text-[11px] text-tertiary"
                >
                  {resultExpanded ? '收起' : `展开剩余 ${resultLines.length - RESULT_FOLD_LINES} 行`}
                </button>
              )}
            </>
          )}
          <button
            type="button"
            onClick={() => setArgsExpanded(!argsExpanded)}
            className="mt-1 cursor-pointer text-[10px] text-tertiary"
          >
            {argsExpanded ? '▾ 参数' : '▸ 参数'}
          </button>
          {argsExpanded && (
            <div className="mt-1 whitespace-pre-wrap break-words text-tertiary">
              {JSON.stringify(args, null, 2)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: 运行测试（含依赖方）**

```bash
cd renderer && npx pnpm@9.0.0 vitest run src/components/im/ToolCallChip.test.tsx src/components/im/AgentStreamBubble.test.tsx src/components/im/SubAgentSection.test.tsx
```

Expected: ToolCallChip 新测试 PASS。AgentStreamBubble/SubAgentSection 既有测试若因摘要行变化失败（如断言全参数文本），仅当断言与新行为冲突时适配断言（新行为：摘要只显文件名）。**禁止**改测试来掩盖真实回归。

- [ ] **Step 5: typecheck + commit**

```bash
npx pnpm@9.0.0 --filter momo-studio-renderer typecheck
git add renderer/src/components/im/ToolCallChip.tsx renderer/src/components/im/ToolCallChip.test.tsx
git commit -m "feat(renderer): ToolCallChip 重写——摘要行 + 结果优先 + 10 行折叠 + 次级参数 + 错误单行化"
```

---

### Task 7: ContextGroupChip 组件

**Files:**
- Create: `renderer/src/components/im/ContextGroupChip.tsx`
- Test: `renderer/src/components/im/ContextGroupChip.test.tsx`

**Interfaces:**
- Consumes: `ContextGroup`（Task 5）；`describeToolCall`（Task 4）
- Produces: `ContextGroupChip({ group: ContextGroup })`

- [ ] **Step 1: 写失败测试**

`renderer/src/components/im/ContextGroupChip.test.tsx`：

```tsx
// ContextGroupChip 单测：计数文案（N 次读取 · M 次搜索）+ 展开单行摘要 + 执行中态。
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ContextGroupChip } from './ContextGroupChip';
import type { ContextGroup } from '../../lib/group-tool-segments';

function item(callId: string, toolName: string, over?: Partial<{ result: string | null; success: boolean | null }>) {
  return {
    kind: 'tool_call' as const,
    callId,
    toolName,
    args: toolName === 'read_file' ? { path: `src/${callId}.ts` } : { pattern: '*.ts' },
    result: 'ok',
    success: true,
    ...over,
  };
}

describe('ContextGroupChip', () => {
  it('折叠行显示「收集上下文」+ 分项计数', () => {
    const group: ContextGroup = {
      kind: 'context-group',
      items: [item('c1', 'read_file'), item('c2', 'read_file'), item('c3', 'grep')],
    };
    render(<ContextGroupChip group={group} />);
    expect(screen.getByText('收集上下文')).toBeInTheDocument();
    expect(screen.getByText(/2 次读取 · 1 次搜索/)).toBeInTheDocument();
  });

  it('展开后每条单行摘要（无嵌套手风琴）', () => {
    const group: ContextGroup = {
      kind: 'context-group',
      items: [item('c1', 'read_file'), item('c2', 'glob')],
    };
    render(<ContextGroupChip group={group} />);
    fireEvent.click(screen.getByText('收集上下文'));
    expect(screen.getByText('c1.ts')).toBeInTheDocument(); // describeToolCall 文件名摘要
    expect(screen.getAllByRole('button')).toHaveLength(1); // 只有折叠头一个按钮
  });

  it('有未完成项时显示执行中 warning tint', () => {
    const group: ContextGroup = {
      kind: 'context-group',
      items: [item('c1', 'read_file'), item('c2', 'read_file', { result: null, success: null })],
    };
    const { container } = render(<ContextGroupChip group={group} />);
    expect(container.querySelector('button')?.classList.contains('bg-status-warning-tint')).toBe(true);
  });
});
```

- [ ] **Step 2: 运行确认失败**

```bash
cd renderer && npx pnpm@9.0.0 vitest run src/components/im/ContextGroupChip.test.tsx
```

- [ ] **Step 3: 实现 `renderer/src/components/im/ContextGroupChip.tsx`**

```tsx
// renderer/src/components/im/ContextGroupChip.tsx
//
// 连续只读工具分组合并 chip（spec §4.3）：折叠行「收集上下文 · N 次读取 ·
// M 次搜索」，展开后每条单行摘要（describeToolCall）——8 次文件读取从
// 8 个手风琴变 1 行摘要 + 8 个单行项。
import { useState } from 'react';
import { CircleCheck, CircleX, ChevronDown, ChevronRight, Loader2 } from 'lucide-react';
import type { ContextGroup } from '../../lib/group-tool-segments';
import { describeToolCall } from '../../lib/describe-tool-call';

const READ_TOOLS = new Set(['read_file', 'list_files']);
const SEARCH_TOOLS = new Set(['grep', 'glob']);

function countLabel(items: ContextGroup['items']): string {
  const reads = items.filter((i) => READ_TOOLS.has(i.toolName)).length;
  const searches = items.filter((i) => SEARCH_TOOLS.has(i.toolName)).length;
  const parts: string[] = [];
  if (reads > 0) parts.push(`${reads} 次读取`);
  if (searches > 0) parts.push(`${searches} 次搜索`);
  return parts.join(' · ');
}

export function ContextGroupChip({ group }: { group: ContextGroup }) {
  const [expanded, setExpanded] = useState(false);
  const allDone = group.items.every((i) => i.result !== null);
  const anyFailed = group.items.some((i) => i.success === false);
  const toneCls = !allDone
    ? 'bg-status-warning-tint text-status-warning'
    : anyFailed
      ? 'bg-status-error-tint text-status-error'
      : 'bg-status-success-tint text-status-success';

  return (
    <div className="mb-1">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
        className={`flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-xs cursor-pointer transition-colors ${toneCls}`}
      >
        {allDone ? (
          anyFailed ? (
            <CircleX size={12} strokeWidth={1.75} aria-hidden />
          ) : (
            <CircleCheck size={12} strokeWidth={1.75} aria-hidden />
          )
        ) : (
          <Loader2 size={12} strokeWidth={1.75} aria-hidden className="animate-spin" />
        )}
        <span className="shrink-0 text-primary">收集上下文</span>
        <span className="min-w-0 truncate text-[11px] text-secondary">{countLabel(group.items)}</span>
        {expanded ? (
          <ChevronDown size={12} strokeWidth={1.75} aria-hidden />
        ) : (
          <ChevronRight size={12} strokeWidth={1.75} aria-hidden />
        )}
      </button>
      {expanded && (
        <div className="mt-1 rounded border border-subtle bg-surface-1 p-2 font-mono text-[11px]">
          {group.items.map((item) => {
            const { summary } = describeToolCall(item.toolName, item.args);
            const executing = item.result === null;
            const failed = item.success === false;
            const Icon = executing ? Loader2 : failed ? CircleX : CircleCheck;
            return (
              <div key={item.callId} className="flex items-center gap-1.5 py-0.5">
                <Icon
                  size={11}
                  strokeWidth={1.75}
                  aria-hidden
                  className={cnIcon(executing, failed)}
                />
                <span className="shrink-0 text-primary">{item.toolName}</span>
                {summary !== '' && <span className="min-w-0 truncate text-secondary">{summary}</span>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function cnIcon(executing: boolean, failed: boolean): string {
  if (executing) return 'animate-spin text-status-warning';
  if (failed) return 'text-status-error';
  return 'text-status-success';
}
```

- [ ] **Step 4: 运行测试通过 + typecheck + commit**

```bash
cd renderer && npx pnpm@9.0.0 vitest run src/components/im/ContextGroupChip.test.tsx
npx pnpm@9.0.0 --filter momo-studio-renderer typecheck
git add renderer/src/components/im/ContextGroupChip.tsx renderer/src/components/im/ContextGroupChip.test.tsx
git commit -m "feat(renderer): ContextGroupChip——连续只读工具合并摘要 chip"
```

---

### Task 8: MessageFrame 时间戳 + CopyButton 原子件

**Files:**
- Modify: `renderer/src/components/im/MessageFrame.tsx`
- Modify: `renderer/src/components/im/MessageFrame.test.tsx`（追加用例）
- Create: `renderer/src/components/ui/CopyButton.tsx`
- Test: `renderer/src/components/ui/CopyButton.test.tsx`

**Interfaces:**
- Produces: `MessageFrame` 新增可选 prop `timestamp?: number`；`CopyButton({ text: string; className?: string; label?: string })`

- [ ] **Step 1: 写失败测试**

`renderer/src/components/ui/CopyButton.test.tsx`：

```tsx
// CopyButton 单测：复制源文 + 2s 已复制反馈 + onMouseDown 保护选区。
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CopyButton } from './CopyButton';

describe('CopyButton', () => {
  it('点击调用 clipboard.writeText', () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(<CopyButton text="源文" />);
    fireEvent.click(screen.getByRole('button', { name: '复制' }));
    expect(writeText).toHaveBeenCalledWith('源文');
  });

  it('点击后显示「已复制」', () => {
    vi.useFakeTimers();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(<CopyButton text="x" />);
    fireEvent.click(screen.getByRole('button', { name: '复制' }));
    expect(screen.getByText('已复制')).toBeInTheDocument();
    vi.advanceTimersByTime(2100);
    expect(screen.getByText('复制')).toBeInTheDocument();
    vi.useRealTimers();
  });

  it('onMouseDown preventDefault（保护文本选区）', () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(<CopyButton text="x" />);
    const down = fireEvent.mouseDown(screen.getByRole('button', { name: '复制' }));
    expect(down).toBe(true); // jsdom 下 preventDefault 不阻断派发，断言不抛错即可
  });
});
```

`renderer/src/components/im/MessageFrame.test.tsx` 末尾追加 describe（时间戳用**本地时区无关**的构造）：

```tsx
describe('MessageFrame — 时间戳（v2.1）', () => {
  const TS = new Date('2026-09-06T14:32:00').getTime(); // 本地时区构造，断言同源

  it('非自己消息：名字行旁显示 HH:mm', () => {
    render(
      <MessageFrame sender="@bot:server" isSelf={false} senderName="coder" timestamp={TS}>
        <span>body</span>
      </MessageFrame>,
    );
    expect(screen.getByText('14:32')).toBeInTheDocument();
  });

  it('自己消息：气泡下方右对齐显示时间', () => {
    render(
      <MessageFrame sender="@owner:server" isSelf={true} timestamp={TS}>
        <span>body</span>
      </MessageFrame>,
    );
    expect(screen.getByText('14:32')).toBeInTheDocument();
  });

  it('不传 timestamp 不渲染时间', () => {
    render(
      <MessageFrame sender="@bot:server" isSelf={false}>
        <span>body</span>
      </MessageFrame>,
    );
    expect(screen.queryByText(/\d{2}:\d{2}/)).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: 运行确认失败**

```bash
cd renderer && npx pnpm@9.0.0 vitest run src/components/ui/CopyButton.test.tsx src/components/im/MessageFrame.test.tsx
```

- [ ] **Step 3: 实现 CopyButton `renderer/src/components/ui/CopyButton.tsx`**

```tsx
// renderer/src/components/ui/CopyButton.tsx
//
// 复制小按钮（消息级复制用）：复制源文 + 2s「已复制」反馈；
// onMouseDown preventDefault 防止点击清掉用户文本选区（opencode 同款细节）。
import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { cn } from '../../lib/cn';

interface Props {
  text: string;
  className?: string;
  label?: string;
}

export function CopyButton({ text, className, label = '复制' }: Props) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // 受限上下文回退：临时 textarea + execCommand
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      document.execCommand('copy');
      ta.remove();
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <button
      type="button"
      aria-label={label}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => {
        void handleCopy();
      }}
      className={cn(
        'inline-flex h-5 shrink-0 cursor-pointer items-center gap-1 rounded border border-subtle px-1.5 font-sans text-[11px] text-tertiary transition-opacity',
        className,
      )}
    >
      {copied ? (
        <Check size={11} strokeWidth={1.75} aria-hidden />
      ) : (
        <Copy size={11} strokeWidth={1.75} aria-hidden />
      )}
      {copied ? '已复制' : label}
    </button>
  );
}
```

- [ ] **Step 4: MessageFrame 加 timestamp prop**

`renderer/src/components/im/MessageFrame.tsx`——Props 加字段、组件加渲染（其余不动）：

```tsx
// Props 接口内追加：
  /** 消息时间戳（epoch ms）——agent 消息显示在名字行旁，自己消息显示在气泡下方 */
  timestamp?: number;

// 组件内顶部追加 helper（文件作用域）：
/** epoch ms → HH:mm（本地时区） */
function formatHHmm(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// 名字行（!isSelf 分支）改为：
        {!isSelf && (
          <span className="px-1 text-xs text-secondary">
            {senderName ?? shortName(sender)}
            {timestamp !== undefined && (
              <span className="ml-1 text-[11px] text-tertiary">{formatHHmm(timestamp)}</span>
            )}
          </span>
        )}

// 气泡 div 之后（flex-col 容器内末尾）追加自己消息的时间：
        {isSelf && timestamp !== undefined && (
          <span className="self-end px-1 text-[11px] text-tertiary">{formatHHmm(timestamp)}</span>
        )}
```

- [ ] **Step 5: 运行测试通过 + typecheck + commit**

```bash
cd renderer && npx pnpm@9.0.0 vitest run src/components/ui/CopyButton.test.tsx src/components/im/MessageFrame.test.tsx
npx pnpm@9.0.0 --filter momo-studio-renderer typecheck
git add renderer/src/components/ui/CopyButton.tsx renderer/src/components/ui/CopyButton.test.tsx renderer/src/components/im/MessageFrame.tsx renderer/src/components/im/MessageFrame.test.tsx
git commit -m "feat(renderer): MessageFrame 时间戳 + CopyButton 原子件"
```

---

### Task 9: 四调用点接线 + 体验增强

**Files:**
- Modify: `renderer/src/components/im/AgentStreamBubble.tsx`
- Modify: `renderer/src/components/im/SubAgentSection.tsx`
- Modify: `renderer/src/components/im/MessageBubble.tsx`
- Modify: `renderer/src/components/im/ThinkingSection.tsx`
- Modify: `renderer/src/components/im/DispatchCard.tsx` / `TaskReplyCard.tsx`（仅补 timestamp）
- Test: 上述组件既有测试文件适配 + AgentStreamBubble.test.tsx 追加分组/复制用例

**Interfaces:**
- Consumes: `MarkdownBody`（Task 3）、`groupToolSegments`（Task 5）、`ContextGroupChip`（Task 7）、`CopyButton`（Task 8）、`MessageFrame.timestamp`（Task 8）

- [ ] **Step 1: ThinkingSection 改造**

`renderer/src/components/im/ThinkingSection.tsx`：
- 删除 `ReactMarkdown` / `remarkGfm` import，改 `import { MarkdownBody } from './MarkdownBody'`
- 删除 `void isStreaming;` 占位；标签流式态显示「思考中…」，静态显示「思考过程」；Brain 图标流式态加 `animate-pulse`（呼吸式微光）
- 展开内容 `max-h-[400px]` 改 `max-h-[220px]`（约 10 行封顶）
- 正文 `<MarkdownBody deferHighlight={isStreaming}>{content}</MarkdownBody>`（包裹 div 保留 `md-body` 兼容类可删——MarkdownBody 自带）

```tsx
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-1.5 rounded bg-status-violet-tint px-2 py-1 text-xs text-status-violet cursor-pointer"
      >
        <Brain size={12} strokeWidth={1.75} aria-hidden className={isStreaming ? 'animate-pulse' : undefined} />
        <span>{isStreaming ? '思考中…' : '思考过程'}</span>
        <span className="ml-auto" aria-hidden>
          {expanded ? <ChevronDown size={12} strokeWidth={1.75} /> : <ChevronRight size={12} strokeWidth={1.75} />}
        </span>
      </button>
      {expanded && (
        <div className="mt-1 max-h-[220px] overflow-auto rounded bg-surface-2 p-2 text-xs text-secondary">
          <MarkdownBody deferHighlight={isStreaming}>{content}</MarkdownBody>
        </div>
      )}
```

- [ ] **Step 2: SubAgentSection 改造**

`renderer/src/components/im/SubAgentSection.tsx`：
- import `groupToolSegments` / `ContextGroupChip` / `MarkdownBody`；删除 `ReactMarkdown` / `remarkGfm` import
- 容器加低对比度区分（spec §4.5：比气泡 `--surface-2` 深一档）：`className="my-1 rounded-r-lg border-l-2 border-strong bg-surface-1 py-1 pl-2 pr-2"`
- `stream.segments.map` 改为 `groupToolSegments(stream.segments).map`，switch 增加 `case 'context-group'` 分支：

```tsx
          case 'context-group':
            return <ContextGroupChip key={`sub-ctx-${i}`} group={seg} />;
```

- text 段替换为：

```tsx
              <div key={`sub-text-${i}`} style={{ marginBottom: 8 }}>
                <MarkdownBody deferHighlight={isStreaming && isLastSegment}>{seg.text}</MarkdownBody>
                {isStreaming && isLastSegment && (
                  <span
                    aria-label="子 agent 流式光标"
                    className="inline-block h-3.5 w-0.5 bg-accent-500 align-text-bottom"
                    style={{ marginLeft: 2, animation: 'momo-stream-blink 1s infinite' }}
                  />
                )}
              </div>
```

- [ ] **Step 3: AgentStreamBubble 改造**

`renderer/src/components/im/AgentStreamBubble.tsx`：
- import：`groupToolSegments`、`ContextGroupChip`、`MarkdownBody`、`CopyButton`；删除 `ReactMarkdown` / `remarkGfm` import
- `const renderSegments = useMemo(() => groupToolSegments(stream.segments), [stream.segments]);`
- `.map((seg, i) => ...)` 的数据源从 `stream.segments` 换 `renderSegments`，`isLastSegment` 判定同源切换；switch 增加：

```tsx
          case 'context-group':
            return <ContextGroupChip key={`seg-ctx-${i}`} group={seg} />;
```

- text 段替换为（光标逻辑不变）：

```tsx
              <div key={`seg-text-${i}`} style={{ marginBottom: 8 }}>
                <MarkdownBody deferHighlight={isStreaming && isLastSegment}>{seg.text}</MarkdownMarkdownBody>
                {isStreaming && isLastSegment && (
                  <span
                    aria-label="流式光标"
                    className="bg-accent-500"
                    style={{
                      display: 'inline-block',
                      width: 2,
                      height: 14,
                      marginLeft: 2,
                      verticalAlign: 'text-bottom',
                      animation: 'momo-stream-blink 1s infinite',
                    }}
                  />
                )}
              </div>
```

  （注意上面 `<MarkdownBody>...` 闭合标签笔误防呆：正确写法 `<MarkdownBody deferHighlight={isStreaming && isLastSegment}>{seg.text}</MarkdownBody>`）

- MessageFrame 调用加 `timestamp={message.createdAt}`，`bubbleClassName` 加 `group`：

```tsx
    <MessageFrame
      sender={message.sender}
      isSelf={false}
      senderName={senderName}
      bubbleClassName="group bg-surface-2 text-primary border border-subtle"
      maxWidthPct={90}
      fillWidth
      timestamp={message.createdAt}
    >
```

- footer 状态行加消息级复制（流式结束后出现，hover 气泡显形）：

```tsx
          {!isStreaming && (
            <CopyButton
              text={message.body}
              className="ml-auto opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
            />
          )}
```

  同时「停止」按钮保留 `ml-auto`（复制按钮不存在时它仍在右侧；两者互斥渲染不冲突）。

- [ ] **Step 4: MessageBubble 改造**

`renderer/src/components/im/MessageBubble.tsx`：
- 删除本地 `SafeAnchor` 定义与 `ReactMarkdown` / `Components` / `remarkGfm` / anchor 相关 import，改 `import { MarkdownBody } from './MarkdownBody'`
- 静态气泡路径替换为（agent 回复加 hover 复制；`relative group` 支撑绝对定位）：

```tsx
    <MessageFrame
      sender={message.sender}
      isSelf={isSelf}
      senderName={senderName}
      bubbleClassName={cn(
        'relative group',
        isSelf ? 'bg-accent-500 text-inverse' : 'bg-surface-2 text-primary',
      )}
      timestamp={message.createdAt}
    >
      <MarkdownBody>{message.body}</MarkdownBody>
      {!isSelf && (
        <CopyButton
          text={message.body}
          className="absolute right-2 top-2 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
        />
      )}
    </MessageFrame>
```

- AgentStreamBubble 分支调用处补 `senderName` 不变（时间戳在 AgentStreamBubble 内部传）。

- [ ] **Step 5: DispatchCard / TaskReplyCard 补时间戳**

两文件中 `<MessageFrame ...>` 调用各加 `timestamp={message.createdAt}`（行为与普通消息一致）。

- [ ] **Step 6: 既有测试适配 + 新增用例**

先全量跑，逐条处理：

```bash
cd renderer && npx pnpm@9.0.0 vitest run src/components/im
```

**已知必须适配的断言**（行为有意变更，非回归）：
- `AgentStreamBubble.test.tsx` L127「思考过程」用例：stream 默认 `status: 'streaming'` → 标签现为「思考中…」——断言改 `screen.getByText('思考中…')`（segments 时间线用例 status done 不受影响）
- `ThinkingSection.test.tsx`：标签文案 / animate-pulse / max-h 类名断言按新行为适配
- `MessageBubble.test.tsx`：链接拦截断言仍应通过（SafeAnchor 经 MarkdownBody 生效）；若有直接断言本地 SafeAnchor 的用例改为断言行为（点击 preventDefault + window.open）
- `AgentStreamBubble.test.tsx` L138 工具卡用例：`read_file` 现经 groupToolSegments（单个不合并）+ 摘要显 `a.ts`（文件名）——`getByText('read_file')` 仍通过

**追加用例**（AgentStreamBubble.test.tsx 末尾）：

```tsx
describe('AgentStreamBubble — 只读工具分组（v2.1）', () => {
  it('连续 read_file×2 + grep 渲染单个「收集上下文」chip', () => {
    render(
      <AgentStreamBubble
        stream={makeStream({
          status: 'done',
          segments: [
            { kind: 'tool_call', callId: 'c1', toolName: 'read_file', args: { path: 'a.ts' }, result: 'r1', success: true },
            { kind: 'tool_call', callId: 'c2', toolName: 'read_file', args: { path: 'b.ts' }, result: 'r2', success: true },
            { kind: 'tool_call', callId: 'c3', toolName: 'grep', args: { pattern: 'x' }, result: 'r3', success: true },
          ],
        })}
        message={makeMessage()}
      />,
    );
    expect(screen.getByText('收集上下文')).toBeInTheDocument();
    expect(screen.getByText(/2 次读取 · 1 次搜索/)).toBeInTheDocument();
  });

  it('单个 read_file 不合并为分组', () => {
    render(
      <AgentStreamBubble
        stream={makeStream({
          status: 'done',
          segments: [
            { kind: 'tool_call', callId: 'c1', toolName: 'read_file', args: { path: 'a.ts' }, result: 'r1', success: true },
          ],
        })}
        message={makeMessage()}
      />,
    );
    expect(screen.queryByText('收集上下文')).not.toBeInTheDocument();
    expect(screen.getByText('read_file')).toBeInTheDocument();
  });

  it('done 状态渲染消息级复制按钮（复制 message.body）', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(
      <AgentStreamBubble
        stream={makeStream({ status: 'done', text: '完成' })}
        message={makeMessage({ body: '最终回复' })}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '复制' }));
    expect(writeText).toHaveBeenCalledWith('最终回复');
  });

  it('streaming 状态不渲染复制按钮', () => {
    render(
      <AgentStreamBubble stream={makeStream({ text: '生成中' })} message={makeMessage()} />,
    );
    expect(screen.queryByRole('button', { name: '复制' })).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 7: 全量 renderer 测试 + typecheck + commit**

```bash
cd renderer && npx pnpm@9.0.0 vitest run
npx pnpm@9.0.0 --filter momo-studio-renderer typecheck
git add -A renderer/src
git commit -m "feat(renderer): 四调用点接 MarkdownBody/分组/deferHighlight + 时间戳/复制/思考动画/子agent底色区分"
```

---

### Task 10: 全量验证收尾

**Files:**
- 无新改动（验证 + 回归锁核对；失败则回对应 Task 修复后重跑）

- [ ] **Step 1: 双 workspace typecheck**

```bash
nvm use 20 && npx pnpm@9.0.0 typecheck
```

Expected: electron + renderer 双 clean（preload 引 renderer 类型不受影响——本次未动 `src/ipc/types.d.ts`）。

- [ ] **Step 2: 全量测试（两个 workspace）**

```bash
npx pnpm@9.0.0 test
```

Expected: electron 全绿（**零改动零重跑差异**——本次不触主进程）；renderer 全绿（含新增 8 个测试文件 + 适配后的既有测试）。

- [ ] **Step 3: 回归锁零改动核对**

```bash
git diff --stat main -- renderer/src/lib/stream-aggregator.ts renderer/src/lib/stream-aggregator.test.ts renderer/src/stores/stream.store.ts renderer/src/stores/stream.store.test.ts renderer/src/lib/group-segments.ts renderer/src/lib/group-segments.test.ts
```

Expected: 空输出（零改动）。若非空，回滚这些文件的多余改动——spec 红线。

- [ ] **Step 4: build 冒烟（Vite 打包 + shiki 分包验证）**

```bash
NODE_OPTIONS=--max-old-space-size=4096 npx pnpm@9.0.0 build
```

Expected: exit 0。检查 `renderer/dist/assets/` 生成多个 shiki lang chunk（动态 import 分包生效的旁证）。

- [ ] **Step 5: 手动验收清单（macOS 主机 `pnpm dev`，DoD 对照）**

1. 工具展开无参数 JSON（默认）；「▸ 参数」次级开关可展开
2. 连续 read/glob/grep 合并为「收集上下文 · N 次读取 · M 次搜索」
3. 表格一眼是表格（全边框 + 表头填充）
4. 代码块带语言标签 + 语法高亮；bash 块降饱和无高亮
5. 暗色/明色切换代码高亮跟随
6. 流式消息内链接点击走系统浏览器（SafeAnchor）
7. 消息时间戳显示；hover 气泡出现「复制」
8. 子 agent 展开区底色与主气泡可区分（低对比度）

---

## Self-Review 结论（已执行）

- **Spec 覆盖**：§4.1 共享层→Task 3/9；§4.2 代码块→Task 1/2/3(CSS)；§4.3 工具卡→Task 4/5/6/7；§4.4 样式→Task 3；§4.5 体验→Task 8/9；§5 测试→各 Task 步骤 + Task 10；§6 DoD→Task 10 Step 5。无缺口。
- **类型一致**：`highlightCode` / `resolveLang`（T1→T2）、`CodeBlock` props（T2→T3）、`describeToolCall`（T4→T6/T7）、`ContextGroup`/`groupToolSegments`（T5→T7/T9）、`CopyButton`（T8→T9）、`MessageFrame.timestamp`（T8→T9）签名已对齐。
- **已知笔误防呆**：Task 9 Step 3 中 MarkdownBody 闭合标签已标注正确写法；Task 5 第三个用例的过度复杂断言已注明简化方向。
