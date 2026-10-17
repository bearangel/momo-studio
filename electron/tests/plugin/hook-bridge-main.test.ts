// electron/tests/plugin/hook-bridge-main.test.ts
//
// 主进程插件桥三分支契约锁（spec §5.2-5.3，范式 C respond 注入——不经真实
// fork）：preToolUse waterfall 回包 / callService RPC / postToolUse fire-and-
// forget 落审计 / 非本族消息不消费 / 形状漂移收敛。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { handlePluginBridgeMsg, wireHookBridgeAudit } from '../../src/main/plugin/hook-bridge-main';
import { HookBus } from '../../src/main/plugin/hook-bus';
import { closeDb, getDb, runMigrations } from '../../src/main/storage/db';
import { callPluginService } from '../../src/main/plugin/service-manager';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-pbmain-'));
let bus: HookBus;

const svc = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('../../src/main/plugin/service-manager', () => ({
  callPluginService: svc.call,
  startPluginService: vi.fn(),
  stopPluginService: vi.fn(),
  stopAllPluginServices: vi.fn(),
}));

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  svc.call.mockReset();
  bus = new HookBus();
  wireHookBridgeAudit(bus);
});

afterEach(() => {
  bus.setDispatchObserver(null);
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

describe('handlePluginBridgeMsg 三分支', () => {
  it('preToolUse：waterfall 决策回包（id 配对）+ hook_calls 落库', async () => {
    bus.register({
      pluginId: 'cg',
      event: 'preToolUse',
      modulePath: 'x',
      handler: async () => ({ action: 'deny', reason: '危险' }),
    });
    const respond = vi.fn();
    const consumed = await handlePluginBridgeMsg(
      { type: 'plugin:preToolUse', id: 'r1', workspaceId: 'ws1', toolName: 'bash', args: { cmd: 'ls' } },
      respond,
      bus,
    );
    expect(consumed).toBe(true);
    expect(respond).toHaveBeenCalledWith({ id: 'r1', decision: { action: 'deny', reason: '危险' } });
    const rows = getDb()
      .prepare(`SELECT plugin_id, event, decision FROM hook_calls WHERE event = 'preToolUse'`)
      .all() as Array<{ plugin_id: string; event: string; decision: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.plugin_id).toBe('cg');
    expect(rows[0]!.decision).toContain('deny');
  });

  it('preToolUse：无订阅者 → decision null 回包（子进程直通语义）', async () => {
    const respond = vi.fn();
    await handlePluginBridgeMsg(
      { type: 'plugin:preToolUse', id: 'r2', workspaceId: 'ws1', toolName: 'bash', args: {} },
      respond,
      bus,
    );
    expect(respond).toHaveBeenCalledWith({ id: 'r2', decision: null });
  });

  it('callService：成功回包 result；失败回包 error', async () => {
    svc.call.mockResolvedValueOnce('pong');
    const ok = vi.fn();
    await handlePluginBridgeMsg(
      { type: 'plugin:callService', id: 'r3', pluginId: 'cg', method: 'ping', params: {} },
      ok,
      bus,
    );
    expect(svc.call).toHaveBeenCalledWith('cg', 'ping', {}, undefined);
    expect(ok).toHaveBeenCalledWith({ id: 'r3', result: 'pong' });

    svc.call.mockRejectedValueOnce(new Error('svc down'));
    const bad = vi.fn();
    await handlePluginBridgeMsg(
      { type: 'plugin:callService', id: 'r4', pluginId: 'cg', method: 'boom', params: {} },
      bad,
      bus,
    );
    expect(bad).toHaveBeenCalledWith({ id: 'r4', error: 'svc down' });
  });

  it('postToolUse：fire-and-forget 分发 + hook_calls 落库（不回包）', async () => {
    const seen: string[] = [];
    bus.register({
      pluginId: 'cg',
      event: 'postToolUse',
      modulePath: 'x',
      handler: async (_e, _c, p) => {
        seen.push((p as { toolName: string }).toolName);
        return null;
      },
    });
    const respond = vi.fn();
    const consumed = await handlePluginBridgeMsg(
      { type: 'plugin:postToolUse', workspaceId: 'ws1', toolName: 'read_file', args: {}, success: true, durationMs: 3 },
      respond,
      bus,
    );
    expect(consumed).toBe(true);
    expect(respond).not.toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, 20));
    expect(seen).toContain('read_file');
    const rows = getDb()
      .prepare(`SELECT event FROM hook_calls WHERE event = 'postToolUse'`)
      .all();
    expect(rows).toHaveLength(1);
  });

  it('非本族消息 / id 缺失 → 不消费', async () => {
    const respond = vi.fn();
    expect(
      await handlePluginBridgeMsg({ type: 'stream:chunk', chunk: {} } as unknown as Record<string, unknown>, respond, bus),
    ).toBe(false);
    expect(
      await handlePluginBridgeMsg({ type: 'plugin:preToolUse', workspaceId: 'ws1', toolName: 'x', args: {} }, respond, bus),
    ).toBe(false);
    expect(respond).not.toHaveBeenCalled();
  });

  it('形状漂移收敛：字段缺失不炸、String 化', async () => {
    const respond = vi.fn();
    expect(
      await handlePluginBridgeMsg({ type: 'plugin:postToolUse' }, respond, bus),
    ).toBe(true);
    await new Promise((r) => setTimeout(r, 10));
  });
});
