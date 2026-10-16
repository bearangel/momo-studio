// electron/tests/plugin/codegraph-tools.test.ts
//
// P5 T3：codegraph 工具（explore/status）——返回形状 / 错误路径 / config 融合。
// 真实 tmpdir + 真实插件模块（child 语义同构：按需增量扫描）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

type Tools = {
  getDefs(): { name: string; description: string; inputSchema: unknown }[];
  getCatalog(): { name: string }[];
  handles(name: string): boolean;
  execute(name: string, args: unknown): Promise<unknown>;
};
let createExplore: typeof import('../../../plugins/codegraph/tools/explore.js').createTools;
let createStatus: typeof import('../../../plugins/codegraph/tools/status.js').createTools;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-cgtool-'));
const root = path.join(tmp, 'ws');

function mkCtx(config: Record<string, unknown> = {}): unknown {
  return { getConfig: () => config, getDataDir: () => path.join(tmp, 'data') };
}

beforeEach(async () => {
  fs.mkdirSync(root, { recursive: true });
  ({ createTools: createExplore } = await import('../../../plugins/codegraph/tools/explore.js'));
  ({ createTools: createStatus } = await import('../../../plugins/codegraph/tools/status.js'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('codegraph 工具面', () => {
  it('explore.js / status.js 各出一工具（文件名=短名，交叉引用约定）+ handles', () => {
    const te = createExplore(mkCtx({ workspaceRoot: root }));
    expect(te.getDefs().map((d) => d.name)).toEqual(['explore']);
    expect(te.handles('explore')).toBe(true);
    expect(te.handles('bash')).toBe(false);
    const ts = createStatus(mkCtx({ workspaceRoot: root }));
    expect(ts.getDefs().map((d) => d.name)).toEqual(['status']);
    expect(ts.handles('status')).toBe(true);
  });

  it('explore：返回定义+调用方+blast（markdown 人类可读，含近似标注）', async () => {
    fs.writeFileSync(
      path.join(root, 'a.ts'),
      'export function alpha() { return 1; }',
    );
    fs.writeFileSync(
      path.join(root, 'b.ts'),
      'import { alpha } from "./a";\nexport function beta() { return alpha(); }',
    );
    const t = createExplore(mkCtx({ workspaceRoot: root }));
    const out = (await t.execute('explore', { symbol: 'alpha' })) as string;
    expect(out).toContain('alpha');
    expect(out).toContain('b.ts');
    expect(out).toContain('近似'); // regex 近似语义明示（计划 §6 风险裁定）
  });

  it('explore：未知符号 → 友好错误', async () => {
    fs.writeFileSync(path.join(root, 'a.ts'), 'export function alpha() {}');
    const t = createExplore(mkCtx({ workspaceRoot: root }));
    await expect(t.execute('explore', { symbol: 'ghost' })).rejects.toThrow(/未收录/);
  });

  it('explore：嵌套目录文件的路径含目录前缀（真实 LLM 轮缺陷——basename 抹掉 src/ 前缀致 agent 读文件失败）', async () => {
    fs.writeFileSync(path.join(root, 'a.ts'), 'export function alpha() {}');
    fs.mkdirSync(path.join(root, 'src', 'deep'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'deep', 'leaf.ts'), 'import { alpha } from "../a.ts";\nexport function leafTwice() { return alpha(); }\n');
    const t = createExplore(mkCtx({ workspaceRoot: root, indexCommand: '' }));
    const out = (await t.execute('explore', { symbol: 'alpha' })) as string;
    expect(out).toContain(path.join('src', 'deep', 'leaf.ts'));
  });

  it('status：摘要含 root 与非零统计（C1 回归锁——零值输出=诊断面说谎）', async () => {
    fs.writeFileSync(path.join(root, 'a.ts'), 'export function alpha() {}');
    const t = createStatus(mkCtx({ workspaceRoot: root, indexCommand: '' }));
    const out = (await t.execute('status', {})) as string;
    expect(out).toContain(root);
    expect(out).toMatch(/files: [1-9]/);
    expect(out).toMatch(/symbols: [1-9]/);
    expect(out).not.toMatch(/1970-01-01/);
  });

  it('workspaceRoot 未配置 → 明确错误（config required 语义兜底）', async () => {
    const t = createExplore(mkCtx({}));
    await expect(t.execute('explore', { symbol: 'x' })).rejects.toThrow(/workspaceRoot/);
  });
});
