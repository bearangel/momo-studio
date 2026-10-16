// electron/tests/plugin/codegraph-index.test.ts
//
// P5 T2 RED：codegraph 索引引擎——符号提取 / 调用边 / blast radius /
// mtime 增量 / 上限守卫 / 忽略目录。真实 tmpdir 文件系统（momo-test-rules）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// 插件 CJS 域产物——动态 import（vitest CJS 互操作；tsc CommonJS 下合法）
type Indexer = {
  scanFull(): { files: number; symbols: number; edges: number };
  scanFile(abs: string): void;
  explore(symbol: string): {
    symbol: string;
    definition: { file: string; line: number; kind: string; snippet: string } | null;
    callers: { file: string; lines: number[] }[];
    blastRadius: string[];
    approximate: true;
  } | null;
  graph(symbol?: string, limit?: number): {
    nodes: { id: string; kind: string }[];
    edges: { from: string; to: string }[];
    stats: { files: number; symbols: number; edges: number; lastIndexedAt: number };
  };
};
let createIndexer: typeof import('../../../plugins/codegraph/lib/indexer.js').createIndexer;
beforeEach(async () => {
  ({ createIndexer } = await import('../../../plugins/codegraph/lib/indexer.js'));
});

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-cgidx-'));
const root = path.join(tmp, 'ws');

function write(rel: string, content: string): string {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
}

beforeEach(() => {
  fs.mkdirSync(root, { recursive: true });
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('符号提取', () => {
  it('function / class / 箭头 const / 类方法四类符号', () => {
    write('a.ts', [
      'export function alpha() { return 1; }',
      'class Foo {',
      '  bar() { return 2; }',
      '}',
      'const gamma = (x) => x + 1;',
      'const plain = 5;',
    ].join('\n'));
    const idx = createIndexer({ root });
    const s = idx.scanFull();
    expect(s.symbols).toBe(4); // alpha, Foo, bar, gamma（plain 非函数）
    const e1 = idx.explore('alpha');
    expect(e1?.definition).toMatchObject({ kind: 'function', file: expect.stringContaining('a.ts') });
    expect(e1?.definition?.line).toBe(1);
    const e2 = idx.explore('bar');
    expect(e2?.definition?.kind).toBe('method');
    const e3 = idx.explore('gamma');
    expect(e3?.definition?.kind).toBe('arrow');
  });
});

describe('调用边与 blast radius', () => {
  it('跨文件调用链：c.ts → b.ts → a.ts，blast 含传递上游', () => {
    write('a.ts', 'export function alpha() { return 1; }');
    write('b.ts', 'import { alpha } from "./a";\nexport function beta() { return alpha() + 1; }');
    write('c.ts', 'import { beta } from "./b";\nexport function gammaTop() { return beta() + alpha(); }');
    const idx = createIndexer({ root });
    idx.scanFull();
    const e = idx.explore('alpha');
    // 直接调用方：b.ts 与 c.ts
    const callerFiles = e?.callers.map((c) => path.basename(c.file)).sort();
    expect(callerFiles).toEqual(['b.ts', 'c.ts']);
    // blast radius：alpha 的上游闭包 = { b, c }（b 被调用者也只有 c）
    const blast = e?.blastRadius.map((f) => path.basename(f)).sort();
    expect(blast).toEqual(['b.ts', 'c.ts']);
    // beta 的 blast = { c }（c 调 beta）
    const eb = idx.explore('beta');
    expect(eb?.blastRadius.map((f) => path.basename(f))).toEqual(['c.ts']);
    // 近似语义标注
    expect(e?.approximate).toBe(true);
  });

  it('graph(symbol) 返回目标邻域（节点+边+统计）', () => {
    write('a.ts', 'export function alpha() { return 1; }');
    write('b.ts', 'import { alpha } from "./a";\nexport function beta() { return alpha(); }');
    const idx = createIndexer({ root });
    idx.scanFull();
    const g = idx.graph('alpha');
    expect(g.nodes.some((n) => n.id === 'alpha')).toBe(true);
    expect(g.edges.some((e) => e.to === 'alpha')).toBe(true);
    expect(g.stats.files).toBe(2);
    expect(g.stats.symbols).toBe(2);
  });
});

describe('增量与守卫', () => {
  it('mtime 增量：改单文件只重扫该文件', () => {
    write('a.ts', 'export function alpha() { return 1; }');
    write('b.ts', 'export function beta() { return 2; }');
    const idx = createIndexer({ root });
    idx.scanFull();
    write('a.ts', 'export function alpha() { return 3; }');
    idx.scanFile(path.join(root, 'a.ts'));
    const e = idx.explore('alpha');
    expect(e?.definition?.snippet).toContain('return 3;');
    const eb = idx.explore('beta');
    expect(eb).not.toBeNull(); // 未动文件仍在索引
  });

  it('忽略 node_modules / dist / .git 与二进制', () => {
    write('src/ok.ts', 'export function ok() {}');
    write('node_modules/pkg/x.ts', 'export function hidden1() {}');
    write('dist/x.ts', 'export function hidden2() {}');
    fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(root, 'bin', 'blob.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const idx = createIndexer({ root });
    const s = idx.scanFull();
    expect(s.files).toBe(1);
    expect(idx.explore('hidden1')).toBeNull();
    expect(idx.explore('ok')).not.toBeNull();
  });

  it('maxFiles 上限守卫', () => {
    for (let i = 0; i < 5; i++) write(`f${i}.ts`, `export function f${i}() {}`);
    const idx = createIndexer({ root, maxFiles: 3 });
    const s = idx.scanFull();
    expect(s.files).toBeLessThanOrEqual(3);
  });

  it('未知符号 → null（错误路径）', () => {
    write('a.ts', 'export function alpha() {}');
    const idx = createIndexer({ root });
    idx.scanFull();
    expect(idx.explore('ghost')).toBeNull();
  });
});
