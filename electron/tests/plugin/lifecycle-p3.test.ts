// electron/tests/plugin/lifecycle-p3.test.ts
//
// P3 生命周期接线锁：install→hooks+service 激活 / uninstall→全清 /
// reload→重激活新代码 / app 停机钩 / callService 子进程桥形状。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { installPluginDevDir, uninstallPlugin } from '../../src/main/plugin/installer';
import { reloadPlugin } from '../../src/main/plugin/reload';
import { getPluginBus, resetPluginBusForTest } from '../../src/main/plugin/bus-instance';
import { isServiceRunning, stopAllPluginServices } from '../../src/main/plugin/service-manager';
import { closeDb, runMigrations , getDb } from '../../src/main/storage/db';
import { requestPluginCallService } from '../../src/main/agent/plugin-hook-bridge';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-plife-'));

function mkPlugin(id: string): string {
  const dir = path.join(tmpRoot, `${id}-plugin`);
  fs.mkdirSync(path.join(dir, 'tools'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'hooks'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'service'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'tools', 'echo.js'), 'module.exports.createTools = () => ({});');
  fs.writeFileSync(
    path.join(dir, 'hooks', 'hooks.json'),
    JSON.stringify({ hooks: { appReady: [{ module: './log.js' }] } }),
  );
  fs.writeFileSync(path.join(dir, 'hooks', 'log.js'), 'module.exports.handle = async () => null;');
  fs.writeFileSync(
    path.join(dir, 'service', 'index.js'),
    `module.exports.createService = function () {
      return {
        async start() {},
        async stop() {},
        async handle(method, params) { return 'svc:' + method; },
      };
    };`,
  );
  fs.writeFileSync(
    path.join(dir, 'momo-plugin.json'),
    JSON.stringify({
      id,
      name: id,
      version: '0.1.0',
      description: '',
      components: { tools: './tools', hooks: './hooks/hooks.json', service: './service' },
    }),
  );
  return dir;
}

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  getDb()
    .prepare(`INSERT OR IGNORE INTO workspaces (id, name, directory_path, owner_id) VALUES ('ws-t', 'T', '/tmp/x', '@o')`)
    .run();
  resetPluginBusForTest();
});
afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

describe('install → 激活 hooks + service', () => {
  it('dev 注册后：HookBus 有订阅 + service 运行', async () => {
    installPluginDevDir(mkPlugin('cg'), '2.1.0', 'ws-t');
    await new Promise((r) => setTimeout(r, 30)); // service start 异步（void 发射）
    expect(getPluginBus().listSubscriptions('cg')).toHaveLength(1);
    expect(isServiceRunning('cg')).toBe(true);
    await expect(
      (await import('../../src/main/plugin/service-manager')).callPluginService('cg', 'ping', {}),
    ).resolves.toBe('svc:ping');
  });
});

describe('uninstall → 全清', () => {
  it('hooks 注销 + service 停止', async () => {
    installPluginDevDir(mkPlugin('cg'), '2.1.0', 'ws-t');
    await new Promise((r) => setTimeout(r, 30));
    uninstallPlugin('cg', true);
    await new Promise((r) => setTimeout(r, 30));
    expect(getPluginBus().listSubscriptions('cg')).toHaveLength(0);
    expect(isServiceRunning('cg')).toBe(false);
  });
});

describe('reload → 重激活（新代码）', () => {
  it('service 换实现后 reload → callService 走新代码', async () => {
    const dir = mkPlugin('cg');
    installPluginDevDir(dir, '2.1.0', 'ws-t');
    const { callPluginService } = await import('../../src/main/plugin/service-manager');
    await expect(callPluginService('cg', 'ping', {})).resolves.toBe('svc:ping');
    fs.writeFileSync(
      path.join(dir, 'service', 'index.js'),
      `module.exports.createService = function () {
        return {
          async start() {},
          async stop() {},
          async handle(method) { return 'v2:' + method; },
        };
      };`,
    );
    await reloadPlugin('cg');
    await new Promise((r) => setTimeout(r, 50)); // service stop→start 链
    expect(isServiceRunning('cg')).toBe(true);
    await expect(callPluginService('cg', 'ping', {})).resolves.toBe('v2:ping');
  });
});

describe('stopAllPluginServices', () => {
  it('停全部（app 退出钩语义）', async () => {
    installPluginDevDir(mkPlugin('a'), '2.1.0', 'ws-t');
    installPluginDevDir(mkPlugin('b'), '2.1.0', 'ws-t');
    await new Promise((r) => setTimeout(r, 30));
    await stopAllPluginServices();
    expect(isServiceRunning('a')).toBe(false);
    expect(isServiceRunning('b')).toBe(false);
  });
});

describe('requestPluginCallService（子进程桥）', () => {
  it('无 process.send → reject 中文超时语义外的明确错误（fail-open 上一层 catch）', async () => {
    const proc = process as { send?: unknown };
    const orig = proc.send;
    proc.send = undefined;
    try {
      await expect(requestPluginCallService('cg', 'x', {})).rejects.toThrow(/桥不可用/);
    } finally {
      proc.send = orig;
    }
  });

  it('id 配对回包 result', async () => {
    let captured: ((m: unknown) => void) | null = null;
    const proc = process as unknown as {
      send?: (m: unknown) => void;
      on: (ev: string, fn: (m: unknown) => void) => void;
      off: (ev: string, fn: (m: unknown) => void) => void;
    };
    const orig = { send: proc.send, on: proc.on, off: proc.off };
    proc.send = (m) => {
      setTimeout(() => captured?.({ id: (m as { id: string }).id, result: 'pong' }), 5);
    };
    proc.on = (_e, fn) => { captured = fn; };
    proc.off = vi.fn();
    try {
      await expect(requestPluginCallService('cg', 'ping', {})).resolves.toBe('pong');
    } finally {
      Object.assign(proc, orig);
    }
  });
});

describe('安装/卸载事件（P3 补线）', () => {
  it('install → resourceInstalled；uninstall → resourceRemoved（经 wire 注入可观测）', async () => {
    const events: string[] = [];
    const { wirePluginEventSources } = await import('../../src/main/plugin/event-sources');
    wirePluginEventSources(getPluginBus(), (e) => events.push(e));
    installPluginDevDir(mkPlugin('cg'), '2.1.0', 'ws-t');
    uninstallPlugin('cg', true);
    expect(events).toContain('resourceInstalled');
    expect(events).toContain('resourceRemoved');
  });
});
