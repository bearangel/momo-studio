// renderer/src/monaco-tokenization.test.ts
//
// Monaco 文法注册链回归锁（2026-10-23 高亮缺失事故）：
// monaco 0.5x 把入口（exports '.'）指向 esm/vs/index.js，基础文法改为按语言
// 懒加载（registerLanguage loader → 动态 import → tokens factory）。本测试以与
// monaco-setup.ts 相同的入口 import 真实包，锁定两件事：
//   1. 入口仍聚合全部文法注册（若上游再改入口结构，懒加载链断裂 → 此处红）
//   2. 懒加载链最终产出多 token（plaintext 对照组恒单 token）
// 注：首开无色窗口（懒加载延迟）属运行时表现，由 App 级验收（CDP 开文件查
// token 色）覆盖；本锁保证链路存在且通。
// jsdom polyfill：monaco 0.56 clipboard contrib 顶层调 document.
// queryCommandSupported；StandaloneThemeService 构造调 matchMedia（Electron
// 均存在，jsdom 缺失）。
import { describe, it, expect, beforeAll } from 'vitest';
import type * as MonacoNs from 'monaco-editor';

let monaco: typeof MonacoNs;

/** Worker 边界 stub：jsdom 无 Worker；着色（Monarch 主线程）不依赖 worker，
 *  仅 ts/json 诊断适配器会尝试建 worker（不 mock 会产生 unhandled rejection） */
class StubWorker {
  onmessage: unknown = null;
  postMessage(): void {}
  terminate(): void {}
  addEventListener(): void {}
  removeEventListener(): void {}
}

beforeAll(async () => {
  const doc = document as Document & { queryCommandSupported?: (cmd: string) => boolean };
  if (typeof doc.queryCommandSupported !== 'function') {
    doc.queryCommandSupported = () => false;
  }
  if (typeof window.matchMedia !== 'function') {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    })) as typeof window.matchMedia;
  }
  // 镜像 monaco-setup.ts 的 MonacoEnvironment 结构（仅替换 Worker 边界为 stub）
  self.MonacoEnvironment = {
    getWorker: () => new StubWorker() as unknown as Worker,
  };
  monaco = (await import('monaco-editor')) as typeof MonacoNs;
  // P3-3 噪声治源（2026-10-28）：ts 模型创建触发 DiagnosticsAdapter._doValidate——jsdom
  // 里 StubWorker 握手失败后 monaco 回退主线程本地 EditorWorker，其无 foreign module →
  // $fmr('getSyntacticDiagnostics' 等) 异步 reject 且适配器不接 catch，落在用例结束后
  // → vitest 判 suite FAIL（4/4 用例过的假红）。本锁只测文法 tokenization，诊断属 worker
  // 边界（App 内有真实 worker），这里按 monaco 公开配置三路全关：_doValidate 的 promises
  // 为空即不再触达 worker 协议。注意 0.56 API 位点在包顶层导出 monaco.typescript（主入口
  // eager 求值 features/typescript/register.js，import 完成即存在），非旧版 languages.typescript
  monaco.typescript.typescriptDefaults.setDiagnosticsOptions({
    noSyntaxValidation: true,
    noSemanticValidation: true,
    noSuggestionDiagnostics: true,
  });
});

/** 轮询等待懒加载的 tokens factory 生效（tokenize 多 token）或超时 */
async function waitTokenizes(text: string, langId: string, ms = 4000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    try {
      if (monaco.editor.tokenize(text, langId)[0]!.length > 1) return true;
    } catch {
      // tokenize 对未加载语言抛错的防御（不影响轮询）
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

describe('monaco 文法注册链', () => {
  it('typescript 懒加载后产生多 token', async () => {
    monaco.editor.createModel('const x: number = 1;', 'typescript');
    expect(await waitTokenizes('const x: number = 1;', 'typescript')).toBe(true);
  });

  it('json 懒加载后产生多 token', async () => {
    monaco.editor.createModel('{"a": 1}', 'json');
    expect(await waitTokenizes('{"a": 1}', 'json')).toBe(true);
  });

  it('对照组：plaintext 恒单 token', () => {
    expect(monaco.editor.tokenize('const x = 1', 'plaintext')[0]!.length).toBe(1);
  });

  it('预载语言集（monaco-setup PRELOAD_LANG_IDS）全部可注册加载', async () => {
    const preloadIds = [
      'typescript', 'javascript', 'json', 'css', 'scss', 'less', 'html', 'xml',
      'markdown', 'yaml', 'python', 'go', 'rust', 'shell', 'c', 'cpp', 'java',
      'ini', 'ruby', 'php', 'swift', 'kotlin', 'sql',
    ];
    const registered = new Set(monaco.languages.getLanguages().map((l) => l.id));
    const missing = preloadIds.filter((id) => !registered.has(id));
    expect(missing).toEqual([]);
  });
});
