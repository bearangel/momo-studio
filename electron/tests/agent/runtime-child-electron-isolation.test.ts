// electron/tests/agent/runtime-child-electron-isolation.test.ts
//
// 回归锁（v2.1.0-alpha.9 mac 打包验收实测 P0）：
// runtime 子进程以 ELECTRON_RUN_AS_NODE 运行——该模式下 'electron' 不是内建模块，
// 打包产物 asar 内也没有 electron npm 包。凡 runtime-entry 静态依赖图可达的共享模块
// （tools/* / stream-relay / git-policy 等），顶层 import 'electron' 都会让子进程
// boot 即 MODULE_NOT_FOUND 崩溃 → WarmPool 预热全灭 → agent 恒不可用。
//
// 本文件模拟「electron 不可解析」的打包子进程环境（mock 工厂直接抛错 = require 失败），
// 断言涉事模块仍可正常加载。新增共享模块若需 electron API，一律走
// src/main/electron-access.ts 的 loadElectronApis() 惰性取用并做不可用降级。

import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// 模拟打包子进程：require('electron') 抛 MODULE_NOT_FOUND（工厂抛错会在被测模块
// 顶层 require 'electron' 时向上传播——正是打包产物的真实失败形态）
vi.mock('electron', () => {
  throw new Error("Cannot find module 'electron'");
});

// ─── 真实依赖图遍历（2026-11-13 实机 P0 教训）──────────────────────────────
// 旧版本本文件是**手工清单**（apply-patch-tools / stream-relay / git-policy），
// 新增边（runtime-entry → … → resource/hub/momo-hub → hub/index 的顶层
// `import { BrowserWindow } from 'electron'`）无人登记，手工清单查不出，
// 导致打包后 runtime 子进程 boot 即 exit 1 → WarmPool 全灭 → agent 恒不回复。
// 现改为从真实入口静态遍历相对 import，机械断言「子进程图内零 electron 值依赖」，
// 新增模块无需登记。

const SRC_MAIN = path.resolve(__dirname, '../../src/main');
const ENTRY = path.join(SRC_MAIN, 'agent/runtime-entry.ts');

/** 解析相对 specifier 到真实源文件（.ts / .tsx / 目录 index.ts） */
function resolveRelative(fromFile: string, spec: string): string | null {
  const base = path.resolve(path.dirname(fromFile), spec);
  const candidates = [base + '.ts', base + '.tsx', path.join(base, 'index.ts')];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return null;
}

/** 从入口 BFS 收集静态依赖图内的全部源文件 */
function collectReachable(entry: string): string[] {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const src = fs.readFileSync(file, 'utf8');
    const specRe = /(?:from\s+|require\(\s*)['"](\.[^'"]+)['"]/g;
    let m: RegExpExecArray | null;
    while ((m = specRe.exec(src)) !== null) {
      const spec: string | undefined = m[1];
      if (spec === undefined) continue;
      const next = resolveRelative(file, spec);
      if (next !== null && !seen.has(next)) queue.push(next);
    }
  }
  return [...seen];
}

/** 该文件是否存在对 electron 的运行期依赖（type-only import 与 typeof import() 会被擦除，放行） */
function electronRuntimeDeps(src: string): string[] {
  // 先剥注释：源码里的「原实现 require('electron')…」这类说明文字不应被误判
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  const hits: string[] = [];
  const importRe = /^[ \t]*import\s+(type\s+)?([^;]*?)\s+from\s+['"]electron['"]/gm;
  let m: RegExpExecArray | null;
  while ((m = importRe.exec(code)) !== null) {
    // `import { type A } from` 这种内联 type 修饰仍需逐项判断——出现非 type 项即违规
    const clause = m[2] ?? '';
    const inlineOnlyType =
      /^\{\s*(type\s+\w+(?:\s*,\s*type\s+\w+)*\s*,?\s*)\}$/.test(clause.trim());
    if (m[1] === 'type' || inlineOnlyType) continue;
    hits.push(`import ... from 'electron' → ${clause.trim().slice(0, 60)}`);
  }
  if (/^[ \t]*import\s+['"]electron['"]/m.test(code)) hits.push("side-effect import 'electron'");
  if (/require\(\s*['"]electron['"]\s*\)/.test(code)) hits.push("require('electron')");
  if (/import\(\s*['"]electron['"]\s*\)/.test(code)) hits.push("dynamic import('electron')");
  return hits;
}

/**
 * 唯一豁免：electron-access.ts 本身就是「惰性取 electron API」的封装层
 * ——它内部必须 require('electron')（并 try/catch 降级），type import 也只是类型。
 */
const SANCTIONED = new Set(['electron-access.ts']);

/**
 * 禁入节点断言（T13 评审必办 2）：图内不得出现指定模块。
 * 违规时输出含命中节点的报错（比零 electron 断言更指名道姓——新增禁入边
 * 一眼定位），供两类断言复用：
 *   - runtime-entry 全图：sandbox/ipc.handlers（顶层 import electron 的主进程
 *     装配模块——它进子图等价于零 electron 断言爆，显式命名更可诊断）
 *   - write-blocked-emit 子图：task/lifecycle-runs + sandbox/ipc.handlers
 *     （T13 帷幕约束「本模块为子进程可达：不得顶层 import lifecycle-runs /
 *     ipc.handlers」的机械化——静态 BFS 把传递依赖一并锁住）
 */
function expectForbiddenAbsent(graph: string[], forbidden: string[], scope: string): void {
  const hits = forbidden.filter((needle) =>
    graph.some((f) => f === path.join(SRC_MAIN, ...needle.split('/'))),
  );
  expect(hits, `${scope} 静态依赖图混入禁入模块：${hits.join('、')}`).toEqual([]);
}

describe('runtime 子进程 electron 隔离（打包回归锁）', () => {
  it('runtime-entry 静态依赖图内零 electron 运行期依赖（真实图遍历，非手列清单）', () => {
    const files = collectReachable(ENTRY);
    // 图规模下限自检：防止解析逻辑失效导致「空图永远绿」
    expect(files.length).toBeGreaterThan(200);
    // 图内必须真的覆盖到曾翻车的 hub/index（否则遍历等于没查到关键路径）
    expect(files.some((f) => f.endsWith(path.join('hub', 'index.ts')))).toBe(true);

    const offenders = files
      .map((file) => ({
        file: path.relative(SRC_MAIN, file).replace(/\\/g, '/'),
        deps: SANCTIONED.has(path.basename(file)) ? [] : electronRuntimeDeps(fs.readFileSync(file, 'utf8')),
      }))
      .filter((x) => x.deps.length > 0)
      .map((x) => `${x.file}: ${x.deps.join(' | ')}`);

    expect(offenders).toEqual([]);

    // T13 必办 2a：主进程装配模块显式禁入（ipc.handlers 顶层 import electron，
    // 进子图即子进程 boot 崩——上面零 electron 断言已兜底，此处指名锁）
    expectForbiddenAbsent(
      files,
      ['sandbox/ipc.handlers.ts', 'task/human.ipc.handlers.ts'],
      'runtime-entry',
    );
  });

  it('write-blocked-emit 子图禁入 lifecycle-runs / ipc.handlers（T13 答复接线约束）', () => {
    const files = collectReachable(path.join(SRC_MAIN, 'sandbox/write-blocked-emit.ts'));
    // 子图非空自检（防解析失效空图恒绿）
    expect(files.length).toBeGreaterThan(10);
    expectForbiddenAbsent(
      files,
      ['task/lifecycle-runs.ts', 'sandbox/ipc.handlers.ts', 'task/human.ipc.handlers.ts'],
      'write-blocked-emit',
    );
  });

  it('apply-patch-tools 在 electron 不可解析时仍可加载', async () => {
    const mod = await import('../../src/main/agent/tools/apply-patch-tools');
    expect(mod.ApplyPatchTools).toBeDefined();
  });

  it('stream-relay 在 electron 不可解析时仍可加载', async () => {
    const mod = await import('../../src/main/agent/stream-relay');
    expect(mod.handleStreamChunk).toBeDefined();
  });

  it('git-policy 在 electron 不可解析时仍可加载', async () => {
    const mod = await import('../../src/main/workspace/git-policy');
    expect(mod.getGitPolicy).toBeDefined();
  });

  it('loadElectronApis 降级为空 Partial（不抛、无 API）', async () => {
    const { loadElectronApis } = await import('../../src/main/electron-access');
    const apis = loadElectronApis();
    expect(apis.BrowserWindow).toBeUndefined();
    expect(apis.ipcMain).toBeUndefined();
    expect(apis.app).toBeUndefined();
  });

  it('loadElectronApis 重复调用返回稳定缓存（require 不重试）', async () => {
    const { loadElectronApis } = await import('../../src/main/electron-access');
    expect(loadElectronApis()).toBe(loadElectronApis());
  });
});
