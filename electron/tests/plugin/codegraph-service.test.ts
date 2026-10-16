// electron/tests/plugin/codegraph-service.test.ts
//
// P5 T4：service（start/stop/handle + watcher 清理）与 hooks 队列生产消费链。
// 真实 tmpdir + 真实插件模块；service manager 真跑（P3 已有基础设施）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { installPluginDevDir, uninstallPlugin } from '../../src/main/plugin/installer';
import { listPluginPanels } from '../../src/main/plugin/panel-sync';

// 插件 CJS 域产物——动态 import（vitest CJS 互操作；tsc CommonJS 下合法）
let createService: typeof import('../../../plugins/codegraph/service/index.js').createService;
let handleHook: typeof import('../../../plugins/codegraph/hooks/reindex.js').handle;
beforeEach(async () => {
  ({ createService } = await import('../../../plugins/codegraph/service/index.js'));
  ({ handle: handleHook } = await import('../../../plugins/codegraph/hooks/reindex.js'));
});

interface ServiceCtx {
  getConfig(): Record<string, unknown>;
  getDataDir(): string;
  logger: { info(): void; warn(): void; error(): void };
}
interface Service {
  start(): Promise<void>;
  stop(): Promise<void>;
  handle(method: string, params: unknown): Promise<unknown>;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-cgsvc-'));
const root = path.join(tmp, 'ws');
const dataDir = path.join(tmp, 'data');

function mkCtx(cfg: Record<string, unknown> = { workspaceRoot: root }): ServiceCtx {
  return {
    getConfig: () => cfg,
    getDataDir: () => dataDir,
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
  };
}

async function waitFor(cond: () => boolean | Promise<boolean>, ms = 5000): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    if (await cond()) return;
    if (Date.now() - t0 > ms) throw new Error('waitFor 超时');
    await new Promise((r) => setTimeout(r, 50));
  }
}

beforeEach(() => {
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
});
afterEach(async () => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('service 面', () => {
  it('start → 后台全量；stats/graph/explore RPC 可用', async () => {
    fs.writeFileSync(path.join(root, 'a.ts'), 'export function alpha() { return 1; }');
    const svc = createService(mkCtx());
    await svc.start();
    // 首次全量 setImmediate 后台化——轮询直至可见
    await waitFor(async () => (await (svc.handle('stats', {}) as Promise<{ files: number }>)).files >= 1);
    const stats = (await svc.handle('stats', {})) as { files: number; symbols: number };
    expect(stats.files).toBe(1);
    expect(stats.symbols).toBe(1);
    const e = (await svc.handle('explore', { symbol: 'alpha' })) as { symbol: string; approximate: boolean };
    expect(e.symbol).toBe('alpha');
    expect(e.approximate).toBe(true);
    const g = (await svc.handle('graph', { symbol: 'alpha' })) as { nodes: { id: string }[] };
    expect(g.nodes.some((n) => n.id === 'alpha')).toBe(true);
    await svc.stop();
  });

  it('未知方法 throw；缺 workspaceRoot 的 start 失败可见', async () => {
    const svc = createService(mkCtx({}));
    await expect(svc.start()).rejects.toThrow(/workspaceRoot/);
    const svc2 = createService(mkCtx());
    await svc2.start();
    await expect(svc2.handle('hax', {})).rejects.toThrow(/未知方法/);
    await svc2.stop();
  });

  it('stop 后 watcher 清理（§8.6）——queue 文件再变不再被消费', async () => {
    fs.writeFileSync(path.join(root, 'a.ts'), 'export function alpha() { return 1; }');
    const svc = createService(mkCtx());
    await svc.start();
    await waitFor(async () => (await (svc.handle('stats', {}) as Promise<{ files: number }>)).files >= 1);
    await svc.stop();
    // stop 后写队列——不应被消费（文件残留）
    fs.writeFileSync(path.join(dataDir, 'reindex-queue.json'), JSON.stringify({ paths: [path.join(root, 'b.ts')] }));
    await new Promise((r) => setTimeout(r, 400));
    expect(fs.existsSync(path.join(dataDir, 'reindex-queue.json'))).toBe(true);
  });
});

describe('postToolUse → 队列 → 增量链（§8.5）', () => {
  it('hook 生产队列文件（仅 workspaceRoot 内路径，原子写）', async () => {
    fs.writeFileSync(path.join(root, 'a.ts'), 'x');
    await handleHook(
      { toolName: 'write_file', args: { path: path.join(root, 'a.ts') }, success: true },
      mkCtx(),
    );
    const q = JSON.parse(fs.readFileSync(path.join(dataDir, 'reindex-queue.json'), 'utf-8'));
    expect(q.paths).toEqual([path.join(root, 'a.ts')]);
    // 越界路径不收
    await handleHook(
      { toolName: 'write_file', args: { path: '/etc/hosts' }, success: true },
      mkCtx(),
    );
    const q2 = JSON.parse(fs.readFileSync(path.join(dataDir, 'reindex-queue.json'), 'utf-8'));
    expect(q2.paths).toHaveLength(1);
  });

  it('全链：hook 写队列 → service 消费 → 索引更新 → explore 见新内容', async () => {
    fs.writeFileSync(path.join(root, 'a.ts'), 'export function alpha() { return 1; }');
    const svc = createService(mkCtx());
    await svc.start();
    await waitFor(async () => (await (svc.handle('stats', {}) as Promise<{ files: number }>)).files >= 1);
    // 模拟 agent 改文件 → hook 入队
    fs.writeFileSync(path.join(root, 'a.ts'), 'export function alpha() { return 42; }');
    await handleHook(
      { toolName: 'write_file', args: { path: path.join(root, 'a.ts') }, success: true },
      mkCtx(),
    );
    await waitFor(async () => {
      const e = (await svc.handle('explore', { symbol: 'alpha' })) as { definition: { snippet: string } };
      return e.definition.snippet.includes('42');
    });
    await svc.stop();
  });
});


describe('T1 注册走查：真插件过安装链全校验（manifest/config/panel/agents 交叉引用）', () => {
  it('installPluginDevDir 接受 plugins/codegraph 且五组件激活不炸', async () => {
    process.env.AP_USER_DATA_DIR = tmp; // 复用本文件隔离根
    runMigrations();
    const repoPlugin = path.resolve(__dirname, '../../../plugins/codegraph');
    expect(fs.existsSync(path.join(repoPlugin, 'momo-plugin.json'))).toBe(true);
    const rec = installPluginDevDir(repoPlugin, '2.1.0');
    expect(rec.id).toBe('codegraph');
    expect(rec.version).toBe('0.1.0');
    // 面板可列出（panel.json 校验过）
    getDb()
      .prepare(`INSERT OR IGNORE INTO workspaces (id, name, directory_path, owner_id) VALUES ('ws1', 'T', '/x', '@o')`)
      .run();
    const panels = listPluginPanels('ws1');
    expect(panels.some((x) => x.pluginId === 'codegraph' && x.panelId === 'graph')).toBe(true);
    expect(panels.find((x) => x.panelId === 'graph')?.entryUrl.startsWith('momo-plugin://codegraph/')).toBe(true);
    uninstallPlugin('codegraph', false);
    closeDb();
  });
});
