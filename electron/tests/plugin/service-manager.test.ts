// electron/tests/plugin/service-manager.test.ts
//
// service 管理器锁（spec §5.3）：start/stop/handle / 崩溃隔离（handle 抛错
// 不拖垮管理器，Review Focus #3）/ cache 失效（重 start 走新代码，Review
// Focus #4）/ 未运行中文错误 / pluginCtx 注入（getConfig/getDataDir/logger）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { startPluginService, stopPluginService, callPluginService } from '../../src/main/plugin/service-manager';
import { upsertPlugin } from '../../src/main/plugin/registry';
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
  it('stop 后 call 抛未运行；重 start 恢复', async () => {
    const rec = mkPlugin('cg', ECHO_SVC);
    await startPluginService(rec);
    await stopPluginService('cg');
    await expect(callPluginService('cg', 'x', {})).rejects.toThrow(/service 未运行/);
    await expect(startPluginService(rec)).resolves.toBe(true);
    await expect(callPluginService('cg', 'ping', {})).resolves.toBe('echo:ping:{}');
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
