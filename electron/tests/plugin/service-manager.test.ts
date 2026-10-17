// electron/tests/plugin/service-manager.test.ts
//
// service 管理器锁（spec §5.3）：start/stop/handle / 崩溃隔离（handle 抛错
// 不拖垮管理器，Review Focus #3）/ cache 失效（重 start 走新代码，Review
// Focus #4）/ 未运行中文错误 / pluginCtx 注入（getConfig/getDataDir/logger）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, beforeEach, afterEach, afterAll, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import {
  startPluginService,
  stopPluginService,
  callPluginService,
  stopAllPluginServices,
} from '../../src/main/plugin/service-manager';
import { upsertPlugin, setPluginEnabled } from '../../src/main/plugin/registry';
import { closeDb, runMigrations } from '../../src/main/storage/db';
import type { PluginRecord } from '../../src/main/plugin/types';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-psvc-'));

function mkPlugin(id: string, serviceSrc: string, withService = true): PluginRecord {
  const root = path.join(tmpRoot, 'plugins', 'installed', id, '0.1.0');
  fs.mkdirSync(path.join(root, 'service'), { recursive: true });
  if (serviceSrc) fs.writeFileSync(path.join(root, 'service', 'index.js'), serviceSrc);
  const rec: PluginRecord = {
    id,
    version: '0.1.0',
    manifestJson: JSON.stringify({
      id,
      name: id,
      version: '0.1.0',
      description: '',
      components: withService ? { service: './service' } : {},
    }),
    state: 'active',
    source: 'zip',
    sourcePath: null,
    installedAt: 'x',
  };
  upsertPlugin(rec);
  return rec;
}

const ECHO_SVC = `module.exports.createService = function (pluginCtx) {
  return {
    async start() { globalThis.__svcMark = (globalThis.__svcMark || []).concat(['start']); },
    async stop() { globalThis.__svcMark = (globalThis.__svcMark || []).concat(['stop']); },
    async handle(method, params) {
      if (method === 'boom') throw new Error('svc boom');
      if (method === 'ctx') return { dir: pluginCtx.getDataDir(), cfg: pluginCtx.getConfig() };
      return 'echo:' + method + ':' + JSON.stringify(params);
    },
  };
};`;

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  delete (globalThis as { __svcMark?: string[] }).__svcMark;
});
afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

afterAll(async () => {
  // teardown 段 SIGSEGV 帝国防线：停全部实例 + 清原生 require 缓存中本测试树的
  // 模块（worker 退出期对已 rmSync 目录内原生模块做 GC 会崩——实证）
  await stopAllPluginServices();
  const r = createRequire(path.join(tmpRoot, 'noop.js'));
  for (const k of Object.keys(r.cache)) {
    if (k.startsWith(tmpRoot)) delete r.cache[k];
  }
});

describe('startPluginService', () => {
  it('合法 service：启动成功 + start 生命周期钩执行', async () => {
    const rec = mkPlugin('cg', ECHO_SVC);
    await expect(startPluginService(rec)).resolves.toBe(true);
    expect((globalThis as { __svcMark?: string[] }).__svcMark).toContain('start');
  });

  it('manifest 无 service 组件 → false；start 抛错 → false 不外抛', async () => {
    await expect(startPluginService(mkPlugin('plain', ECHO_SVC, false))).resolves.toBe(false);
    await expect(
      startPluginService(
        mkPlugin('badstart', `module.exports.createService = function () {
          return { async start() { throw new Error('start fail'); }, async stop() {}, async handle() {} };
        };`),
      ),
    ).resolves.toBe(false);
  });

  it('createService 缺失 / require 抛错 → false', async () => {
    await expect(startPluginService(mkPlugin('noexp', 'module.exports = {};'))).resolves.toBe(false);
    await expect(startPluginService(mkPlugin('boom', 'throw new Error("load boom");'))).resolves.toBe(false);
  });
});

describe('callPluginService', () => {
  it('handle 正常往返 + pluginCtx 注入（dataDir/config）', async () => {
    const rec = mkPlugin('cg', ECHO_SVC);
    await startPluginService(rec);
    await expect(callPluginService('cg', 'query', { q: 'x' })).resolves.toBe(
      'echo:query:{"q":"x"}',
    );
    const dataDir = path.join(tmpRoot, 'plugins', 'data', 'cg');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'config.json'), '{"k":1}');
    const ctxInfo = (await callPluginService('cg', 'ctx', {})) as { dir: string; cfg: unknown };
    expect(ctxInfo.dir).toBe(dataDir);
    expect(ctxInfo.cfg).toEqual({ k: 1 });
  });

  it('handle 抛错 → reject 且管理器存活可继续调用（Review Focus #3）', async () => {
    const rec = mkPlugin('cg', ECHO_SVC);
    await startPluginService(rec);
    await expect(callPluginService('cg', 'boom', {})).rejects.toThrow('svc boom');
    await expect(callPluginService('cg', 'ping', {})).resolves.toBe('echo:ping:{}');
  });

  it('未运行 → 中文错误', async () => {
    await expect(callPluginService('nope', 'x', {})).rejects.toThrow(/service 未运行/);
  });
});

describe('stopPluginService + cache 失效', () => {
  it('stop 后 call 对启用插件 lazy 复活；禁用后 call 不复活（§8.6）', async () => {
    getDb().prepare('INSERT INTO workspaces (id, name, directory_path, owner_id) VALUES (?, ?, ?, ?)').run('ws-live', 'l', '/tmp/l', 'u1');
    const rec = mkPlugin('p-revive', ECHO_SVC);
    await startPluginService(rec);
    await stopPluginService('p-revive');
    await expect(callPluginService('p-revive', 'ping', {})).resolves.toBe('echo:ping:{}'); // lazy 复活（新语义）
    setPluginEnabled('p-revive', 'ws-live', false); // 唯一工作区禁用 → 无人启用（与 setEnabled 联动同判定）
    await stopPluginService('p-revive');
    await expect(callPluginService('p-revive', 'ping', {})).rejects.toThrow(/未运行/); // 禁用即熄灭：lazy 不复活
  });

  it('改写 service 源码 → 重 start 走新代码（Review Focus #4）', async () => {
    const rec = mkPlugin('cg', ECHO_SVC);
    await startPluginService(rec);
    await expect(callPluginService('cg', 'ping', {})).resolves.toBe('echo:ping:{}');
    const root = path.join(tmpRoot, 'plugins', 'installed', 'cg', '0.1.0');
    fs.writeFileSync(
      path.join(root, 'service', 'index.js'),
      ECHO_SVC.replace("'echo:' + method", "'v2:' + method"),
    );
    await stopPluginService('cg');
    await expect(startPluginService(rec)).resolves.toBe(true);
    await expect(callPluginService('cg', 'ping', {})).resolves.toBe('v2:ping:{}');
  });
});

// ── 工作空间维度 v1.1（spec 2026-10-17 §5）：service 多实例 ──
import {
  pluginUsesWorkspaceScope,
  onWorkspaceSwitched,
  stopAllWorkspaceInstances,
} from '../../src/main/plugin/service-manager';
import { getDb } from '../../src/main/storage/db';
import { resolvePluginDataDir } from '../../src/main/paths';

function mkWs(id: string, directoryPath: string): void {
  getDb().prepare('INSERT INTO workspaces (id, name, directory_path, owner_id) VALUES (?, ?, ?, ?)').run(id, id, directoryPath, 'u1');
}

/** 多实例型 service：记录 start/stop 的工作区标记，handle 回显 ws 上下文 */
const WS_SVC = `module.exports.createService = function (pluginCtx) {
  const tag = pluginCtx.workspace ? pluginCtx.workspace.id : 'none';
  return {
    async start() { globalThis.__wsm = (globalThis.__wsm || []).concat(['start:' + tag]); },
    async stop() { globalThis.__wsm = (globalThis.__wsm || []).concat(['stop:' + tag]); },
    async handle(method, params) {
      if (method === 'wsinfo') return pluginCtx.workspace ? pluginCtx.workspace.id + '|' + pluginCtx.workspace.directoryPath : 'none';
      if (method === 'cfg') return pluginCtx.getConfig();
      return 'echo:' + method;
    },
  };
};`;

function mkMultiPlugin(id: string, serviceSrc: string): PluginRecord {
  const rec = mkPlugin(id, serviceSrc);
  rec.manifestJson = JSON.stringify({
    id, name: id, version: '0.1.0', description: '',
    components: { service: './service' },
    config: {
      type: 'object',
      properties: { workspaceRoot: { type: 'string', scope: 'workspace' }, g: { type: 'string' } },
    },
  });
  upsertPlugin(rec);
  return rec;
}

function writeWsLayerConfig(id: string, workspaceId: string, data: Record<string, unknown>): void {
  fs.mkdirSync(resolvePluginDataDir(id), { recursive: true });
  fs.writeFileSync(path.join(resolvePluginDataDir(id), `config.${workspaceId}.json`), JSON.stringify(data));
}

describe('service 多实例（工作空间维度 v1.1）', () => {
  beforeEach(async () => {
    await stopAllPluginServices(); // 跨测试实例隔离（running Map 是模块级单例）
    delete (globalThis as { __wsm?: string[] }).__wsm;
  });

  it('pluginUsesWorkspaceScope：config 含 workspace-scope 属性判多实例；无 config 判单例', () => {
    const multi = mkMultiPlugin('p-multi', WS_SVC);
    const single = mkPlugin('p-single', ECHO_SVC);
    expect(pluginUsesWorkspaceScope(multi)).toBe(true);
    expect(pluginUsesWorkspaceScope(single)).toBe(false);
  });

  it('同插件两工作区两实例：getConfig 合并 global+ws 层，handle 各自路由', async () => {
    mkWs('ws-a', '/tmp/dir-a');
    mkWs('ws-b', '/tmp/dir-b');
    const rec = mkMultiPlugin('p-inst', WS_SVC);
    fs.mkdirSync(resolvePluginDataDir('p-inst'), { recursive: true });
    fs.writeFileSync(path.join(resolvePluginDataDir('p-inst'), 'config.json'), JSON.stringify({ g: 'G' }));
    writeWsLayerConfig('p-inst', 'ws-a', { workspaceRoot: '/root-a' });
    writeWsLayerConfig('p-inst', 'ws-b', { workspaceRoot: '/root-b' });
    expect(await startPluginService(rec, 'ws-a')).toBe(true);
    expect(await startPluginService(rec, 'ws-b')).toBe(true);
    await expect(callPluginService('p-inst', 'cfg', null, 'ws-a')).resolves.toEqual({ g: 'G', workspaceRoot: '/root-a' });
    await expect(callPluginService('p-inst', 'cfg', null, 'ws-b')).resolves.toEqual({ g: 'G', workspaceRoot: '/root-b' });
    await expect(callPluginService('p-inst', 'wsinfo', null, 'ws-a')).resolves.toBe('ws-a|/tmp/dir-a');
  });

  it('multi 插件无 workspaceId start 返回 false（lazy 兜底语义）；global 单例不受影响', async () => {
    const rec = mkMultiPlugin('p-multi2', WS_SVC);
    expect(await startPluginService(rec)).toBe(false);
    const single = mkPlugin('p-sg2', ECHO_SVC);
    expect(await startPluginService(single, 'ws-a')).toBe(true); // workspaceId 被忽略
    await expect(callPluginService('p-sg2', 'ping', 1)).resolves.toBe('echo:ping:1');
  });

  it('stopPluginService 前缀精确：停 a 不伤 ab@ws（Review Focus #2）', async () => {
    mkWs('ws-a', '/tmp/dir-a');
    const recA = mkMultiPlugin('a', WS_SVC);
    const recAB = mkMultiPlugin('ab', WS_SVC);
    await startPluginService(recA, 'ws-a');
    await startPluginService(recAB, 'ws-a');
    await stopPluginService('a');
    expect((globalThis as { __wsm?: string[] }).__wsm).toContain('stop:ws-a'); // a 的实例停了（一次）
    await expect(callPluginService('ab', 'wsinfo', null, 'ws-a')).resolves.toBe('ws-a|/tmp/dir-a'); // ab 实例还活着
  });

  it('lazy start：未启动的 multi 插件按 wsId 拉起；start 失败不落注册表可重试（Review Focus #4）', async () => {
    mkWs('ws-a', '/tmp/dir-a');
    const rec = mkMultiPlugin('p-lazy', WS_SVC);
    await expect(callPluginService('p-lazy', 'wsinfo', null, 'ws-a')).resolves.toBe('ws-a|/tmp/dir-a');
    // 坏 service（createService 抛错）
    const bad = mkMultiPlugin('p-bad', 'module.exports.createService = function () { throw new Error("bad"); };');
    await expect(callPluginService('p-bad', 'x', null, 'ws-a')).rejects.toThrow(/未运行/);
    await expect(callPluginService('p-bad', 'x', null, 'ws-a')).rejects.toThrow(/未运行/); // 重试语义：再次尝试而非缓存失败
  });

  it('onWorkspaceSwitched 停非当前多实例，当前实例与 global 单例保留', async () => {
    mkWs('ws-a', '/tmp/dir-a');
    mkWs('ws-b', '/tmp/dir-b');
    const rec = mkMultiPlugin('p-sw', WS_SVC);
    const single = mkPlugin('p-sw-sg', ECHO_SVC);
    await startPluginService(rec, 'ws-a');
    await startPluginService(rec, 'ws-b');
    await startPluginService(single);
    await onWorkspaceSwitched('ws-a');
    const marks = (globalThis as { __wsm?: string[] }).__wsm ?? [];
    expect(marks).toContain('stop:ws-b');
    expect(marks).not.toContain('stop:ws-a');
    await expect(callPluginService('p-sw', 'wsinfo', null, 'ws-a')).resolves.toBe('ws-a|/tmp/dir-a');
    await expect(callPluginService('p-sw-sg', 'ping', 1)).resolves.toBe('echo:ping:1');
  });

  it('stopAllWorkspaceInstances：停该工作区全部多实例（工作区删除链路）', async () => {
    mkWs('ws-a', '/tmp/dir-a');
    mkWs('ws-b', '/tmp/dir-b');
    const rec = mkMultiPlugin('p-del', WS_SVC);
    await startPluginService(rec, 'ws-a');
    await startPluginService(rec, 'ws-b');
    await stopAllWorkspaceInstances('ws-a');
    const marks = (globalThis as { __wsm?: string[] }).__wsm ?? [];
    expect(marks.filter((m) => m === 'stop:ws-a').length).toBe(1);
    expect(marks).not.toContain('stop:ws-b');
  });
});

// ── 终审 I1 回归锁：lazy start 单飞（并发首调不产双实例孤儿）──
const SLOW_SVC = `module.exports.createService = function (pluginCtx) {
  const tag = pluginCtx.workspace ? pluginCtx.workspace.id : 'none';
  return {
    async start() {
      globalThis.__wsm = (globalThis.__wsm || []).concat(['start:' + tag]);
      await new Promise((r) => setTimeout(r, 120)); // 拉宽竞态窗口
    },
    async stop() {},
    async handle() { return 'ok'; },
  };
};`;

describe('lazy start 单飞（终审 I1）', () => {
  it('慢 start 期间并发两路 callPluginService → 仅一次 start、单实例', async () => {
    mkWs('ws-r', '/tmp/dir-r');
    const rec = mkMultiPlugin('p-race', SLOW_SVC);
    const [a, b] = await Promise.all([
      callPluginService('p-race', 'ping', null, 'ws-r'),
      callPluginService('p-race', 'ping', null, 'ws-r'),
    ]);
    expect(a).toBe('ok');
    expect(b).toBe('ok');
    const marks = (globalThis as { __wsm?: string[] }).__wsm ?? [];
    expect(marks.filter((m) => m === 'start:ws-r')).toHaveLength(1);
  });
});
