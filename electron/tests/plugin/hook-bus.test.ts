// electron/tests/plugin/hook-bus.test.ts
//
// HookBus 纯逻辑锁（spec §5.1-5.2）：15 事件目录 / 三分发模式 / fail-open /
// matcher / 注销。纯函数注入 fake handler——无 require 无 DB。
import { describe, expect, it, vi } from 'vitest';
import { HookBus, PLUGIN_HOOK_EVENTS } from '../../src/main/plugin/hook-bus';

const ctx = {
  getConfig: () => ({}),
  getDataDir: () => '/tmp/x',
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
};

describe('事件目录', () => {
  it('15 事件齐备', () => {
    expect(PLUGIN_HOOK_EVENTS).toHaveLength(15);
    for (const e of [
      'appReady', 'workspaceOpened', 'workspaceClosed', 'sessionStarted', 'sessionEnded',
      'preToolUse', 'postToolUse', 'postToolUseFailure', 'taskCreated', 'taskStatusChanged',
      'taskCompleted', 'resourceInstalled', 'resourceRemoved', 'pluginEnabled', 'pluginDisabled',
    ]) {
      expect(PLUGIN_HOOK_EVENTS).toContain(e);
    }
  });
});

describe('emit 模式（fire-and-forget，事务安全）', () => {
  it('dispatch 同步即刻返回；慢 handler 与抛错 handler 互不影响（Review Focus #5）', async () => {
    const bus = new HookBus();
    const slow = vi.fn().mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    const boom = vi.fn().mockRejectedValue(new Error('handler boom'));
    bus.register({ pluginId: 'a', event: 'taskCompleted', modulePath: 'x', handler: slow });
    bus.register({ pluginId: 'b', event: 'taskCompleted', modulePath: 'y', handler: boom });
    const t0 = Date.now();
    bus.dispatch('taskCompleted', { taskId: 't1' }); // 不得 await
    expect(Date.now() - t0).toBeLessThan(20);
    await new Promise((r) => setTimeout(r, 80));
    expect(slow).toHaveBeenCalledTimes(1);
    expect(boom).toHaveBeenCalledTimes(1); // 抛错者也被调（错误吞日志）
    expect(ctx.logger.error).not.toHaveBeenCalled(); // ctx 是独立实例——bus 内部日志另行验证
  });

  it('handler 抛错 → bus 内部 logger.error 吞掉（fail-open 不外泄）', async () => {
    const log = { warn: vi.fn(), info: vi.fn(), error: vi.fn() };
    const bus = new HookBus({ logger: log });
    bus.register({
      pluginId: 'a', event: 'appReady', modulePath: 'x',
      handler: vi.fn().mockRejectedValue(new Error('boom')),
    });
    bus.dispatch('appReady', {});
    await new Promise((r) => setTimeout(r, 10));
    expect(log.error).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ error: expect.stringContaining('boom') }),
    );
  });
});

describe('parallel 模式', () => {
  it('全部并发执行且都被调用（postToolUse 域）', async () => {
    const bus = new HookBus();
    const a = vi.fn().mockResolvedValue(null);
    const b = vi.fn().mockResolvedValue(null);
    bus.register({ pluginId: 'a', event: 'postToolUse', modulePath: 'x', handler: a });
    bus.register({ pluginId: 'b', event: 'postToolUse', modulePath: 'y', handler: b });
    await bus.dispatchAwait('postToolUse', { toolName: 'read_file', success: true });
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });
});

describe('waterfall（仅 preToolUse）', () => {
  const payload = { workspaceId: 'ws1', toolName: 'bash', args: { cmd: 'ls' } };

  it('无订阅者 → null（直通）', async () => {
    const bus = new HookBus();
    expect(await bus.dispatchPreToolUse(payload)).toBeNull();
  });

  it('rewrite 链式透传：A 改 args → B 基于 A 结果再改 → 返回最终', async () => {
    const bus = new HookBus();
    const seen: unknown[] = [];
    bus.register({
      pluginId: 'a', event: 'preToolUse', modulePath: 'x',
      handler: async (_e, _c, p) => {
        seen.push((p as typeof payload).args);
        return { action: 'rewrite', args: { cmd: 'ls -la' } };
      },
    });
    bus.register({
      pluginId: 'b', event: 'preToolUse', modulePath: 'y',
      handler: async (_e, _c, p) => {
        seen.push((p as typeof payload).args);
        return { action: 'rewrite', args: { ...(p as typeof payload).args, cwd: '/tmp' } };
      },
    });
    const d = await bus.dispatchPreToolUse(payload);
    expect(d).toEqual({ action: 'rewrite', args: { cmd: 'ls -la', cwd: '/tmp' } });
    expect(seen[1]).toEqual({ cmd: 'ls -la' }); // B 收到 A 的改写结果
  });

  it('deny 短路：后续订阅者不再执行', async () => {
    const bus = new HookBus();
    const later = vi.fn().mockResolvedValue(null);
    bus.register({
      pluginId: 'a', event: 'preToolUse', modulePath: 'x',
      handler: async () => ({ action: 'deny', reason: '保护分支' }),
    });
    bus.register({ pluginId: 'b', event: 'preToolUse', modulePath: 'y', handler: later });
    const d = await bus.dispatchPreToolUse(payload);
    expect(d?.action).toBe('deny');
    expect(d?.reason).toBe('保护分支');
    expect(later).not.toHaveBeenCalled();
  });

  it('handler 抛错 → fail-open 跳过该层继续洋葱', async () => {
    const log = { warn: vi.fn(), info: vi.fn(), error: vi.fn() };
    const bus = new HookBus({ logger: log });
    bus.register({
      pluginId: 'a', event: 'preToolUse', modulePath: 'x',
      handler: vi.fn().mockRejectedValue(new Error('hook crash')),
    });
    bus.register({
      pluginId: 'b', event: 'preToolUse', modulePath: 'y',
      handler: async () => ({ action: 'deny', reason: 'ok' }),
    });
    const d = await bus.dispatchPreToolUse(payload);
    expect(d?.action).toBe('deny'); // 抛错层被跳过，后续层照常
    expect(log.error).toHaveBeenCalled();
  });

  it('matcher：git_* 不匹配 read_file、匹配 git_status；不匹配者不执行', async () => {
    const bus = new HookBus();
    const guard = vi.fn().mockResolvedValue({ action: 'deny', reason: 'no' });
    bus.register({ pluginId: 'a', event: 'preToolUse', modulePath: 'x', matcher: 'git_*', handler: guard });
    expect(await bus.dispatchPreToolUse({ ...payload, toolName: 'read_file' })).toBeNull();
    expect(guard).not.toHaveBeenCalled();
    const d = await bus.dispatchPreToolUse({ ...payload, toolName: 'git_status' });
    expect(d?.action).toBe('deny');
  });

  it('unregisterPlugin 后不再分发', async () => {
    const bus = new HookBus();
    const h = vi.fn().mockResolvedValue(null);
    bus.register({ pluginId: 'a', event: 'preToolUse', modulePath: 'x', handler: h });
    bus.unregisterPlugin('a');
    expect(await bus.dispatchPreToolUse(payload)).toBeNull();
    expect(h).not.toHaveBeenCalled();
    expect(bus.listSubscriptions('a')).toHaveLength(0);
  });
});
