// electron/tests/plugin/hook-sync.test.ts
//
// hooks.json 主进程加载锁（spec §5.2）：注册进 HookBus / 坏条目逐条降级 /
// require cache 失效（同路径改写后二次 sync 走新代码——Review Focus #4）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { syncPluginHooks, removePluginHooks } from '../../src/main/plugin/hook-sync';
import { HookBus } from '../../src/main/plugin/hook-bus';
import { upsertPlugin } from '../../src/main/plugin/registry';
import { closeDb, runMigrations } from '../../src/main/storage/db';
import type { PluginRecord } from '../../src/main/plugin/types';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-phook-'));

function mkPlugin(id: string, files: Record<string, string>): { bus: HookBus; rec: PluginRecord } {
  const root = path.join(tmpRoot, 'plugins', 'installed', id, '0.1.0');
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  const bus = new HookBus();
  const rec: PluginRecord = {
    id,
    version: '0.1.0',
    manifestJson: JSON.stringify({
      id,
      name: id,
      version: '0.1.0',
      description: '',
      components: { hooks: './hooks/hooks.json' },
    }),
    state: 'active',
    source: 'zip',
    sourcePath: null,
    installedAt: 'x',
  };
  upsertPlugin(rec);
  return { bus, rec };
}

const HOOKS_JSON = JSON.stringify({
  hooks: {
    workspaceOpened: [{ module: './watch.js' }],
    preToolUse: [{ module: './guard.js', matcher: 'bash' }],
  },
});


const WATCH_V1 = `module.exports.handle = async function (event) {
  globalThis.__hookMark = (globalThis.__hookMark || []).concat(['watch:' + event]);
  return null;
};`;

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
});
afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

describe('syncPluginHooks', () => {
  it('合法 hooks.json → 注册两条订阅（含 matcher）', () => {
    const { bus, rec } = mkPlugin('cg', {
      'hooks/hooks.json': HOOKS_JSON,
      'hooks/watch.js': WATCH_V1,
      'hooks/guard.js': 'module.exports.handle = async () => null;',
    });
    const r = syncPluginHooks(rec, bus);
    expect(r.registered).toBe(2);
    const subs = bus.listSubscriptions('cg');
    expect(subs.map((s) => `${s.event}@${s.matcher ?? ''}`).sort()).toEqual([
      'preToolUse@bash',
      'workspaceOpened@',
    ]);
  });

  it('坏 JSON / module 缺失 / 模块无 handle 导出 / require 抛错 → 各自降级跳过', () => {
    const { bus, rec } = mkPlugin('bad', {
      'hooks/hooks.json': JSON.stringify({
        hooks: {
          appReady: [{ module: './a.js' }, { module: './missing.js' }, { module: './nohandle.js' }, { module: './boom.js' }],
        },
      }),
      'hooks/a.js': 'module.exports.handle = async () => null;',
      'hooks/nohandle.js': 'module.exports = {};',
      'hooks/boom.js': 'throw new Error("load boom");',
    });
    const r = syncPluginHooks(rec, bus);
    expect(r.registered).toBe(1); // 仅 a.js 成功
    expect(bus.listSubscriptions('bad')).toHaveLength(1);
  });

  it('manifest 无 hooks 组件 → 0 且不抛', () => {
    const root = path.join(tmpRoot, 'plain');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(
      path.join(root, 'momo-plugin.json'),
      JSON.stringify({ id: 'plain', name: 'p', version: '0.1.0', description: '', components: {} }),
    );
    const rec: PluginRecord = {
      id: 'plain',
      version: '0.1.0',
      manifestJson: fs.readFileSync(path.join(root, 'momo-plugin.json'), 'utf-8'),
      state: 'active',
      source: 'zip',
      sourcePath: null,
      installedAt: 'x',
    };
    upsertPlugin(rec);
    const bus = new HookBus();
    expect(syncPluginHooks(rec, bus).registered).toBe(0);
  });

  it('require cache 失效：改写 watch.js 后二次 sync → dispatch 走新代码（Review Focus #4）', async () => {
    const mark = globalThis as { __hookMark?: string[] };
    delete mark.__hookMark;
    const watchSrc = (tag: string): string => `module.exports.handle = async function (event) {
  globalThis.__hookMark = (globalThis.__hookMark || []).concat(['${tag}:' + event]);
  return null;
};`;
    const { bus, rec } = mkPlugin('reload', {
      'hooks/hooks.json': JSON.stringify({ hooks: { appReady: [{ module: './watch.js' }] } }),
      'hooks/watch.js': watchSrc('v1'),
    });
    syncPluginHooks(rec, bus);
    bus.dispatch('appReady', {});
    await new Promise((r) => setTimeout(r, 30));
    expect(mark.__hookMark).toContain('v1:appReady');

    // dev 改码：同路径写 v2 → 二次 sync（应失效缓存）→ dispatch 走 v2
    fs.writeFileSync(
      path.join(tmpRoot, 'plugins', 'installed', 'reload', '0.1.0', 'hooks', 'watch.js'),
      watchSrc('v2'),
    );
    syncPluginHooks(rec, bus);
    bus.dispatch('appReady', {});
    await new Promise((r) => setTimeout(r, 30));
    expect(mark.__hookMark).toContain('v2:appReady');
  });
});

describe('removePluginHooks', () => {
  it('注销该插件全部订阅', () => {
    const { bus, rec } = mkPlugin('cg', {
      'hooks/hooks.json': HOOKS_JSON,
      'hooks/watch.js': WATCH_V1,
      'hooks/guard.js': 'module.exports.handle = async () => null;',
    });
    syncPluginHooks(rec, bus);
    removePluginHooks('cg', bus);
    expect(bus.listSubscriptions('cg')).toHaveLength(0);
  });
});
