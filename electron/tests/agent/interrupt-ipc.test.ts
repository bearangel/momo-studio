// electron/tests/agent/interrupt-ipc.test.ts
//
// 三级中断四通道 IPC 契约测试（P0-B Task B2，spec 2026-10-13 §7.2）：
//   agent:abortTurn / session:stopAll / dispatch:cancelChain / dispatch:listInFlight
//
// mock 收窄纪律（momo-test-rules 规则 5）：只 mock 进程边界——ipcMain.handle
// Map 捕获（照抄 tests/journal/ipc.handlers.test.ts 形态）+ logger 打桩；
// 被测模块 interrupt-ipc.ts 本体真实执行。deps 全为 vi.fn 桩——RouterService
// 级联本体由 tests/agent/interrupt-cascade-e2e.test.ts 锁定，此处只锁 IPC 边界：
//   1. 四通道注册名精确（不多不少）
//   2. 载荷校验抛错路径：缺 sessionId / 空串 / 非法类型 / cancelChain 双键全缺
//      ——且非法载荷不触达 deps（错误不外溢成级联动作）
//   3. 合法载荷 deps 透传（参数形状 + 返回值回传）

import { describe, it, expect, beforeEach, vi } from 'vitest';

// vi.mock 会被提升到所有 import 之前；被工厂引用的 mock 必须用 vi.hoisted 提前声明。
const { ipcHandlers } = vi.hoisted(() => ({
  ipcHandlers: new Map<string, (...args: unknown[]) => unknown>(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      ipcHandlers.set(channel, fn);
    },
  },
}));

vi.mock('../../src/main/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { registerInterruptIpc } from '../../src/main/agent/interrupt-ipc';

/** 构造四方法 vi.fn 桩（返回值可区分，验证回传链路） */
function mkDeps() {
  return {
    abortTurn: vi.fn(
      (sessionId: string): { stoppedStream: boolean } => ({
        stoppedStream: sessionId === 'sess-1',
      }),
    ),
    stopAll: vi.fn(
      (_sessionId: string): { stoppedStreams: number; cancelledChains: number } => ({
        stoppedStreams: 2,
        cancelledChains: 3,
      }),
    ),
    cancelChain: vi.fn(
      (_arg: { taskId?: string; subStreamSessionId?: string }): { status: string } => ({
        status: 'cancelled',
      }),
    ),
    listInFlight: vi.fn(
      (_sessionId?: string): Array<Record<string, unknown>> => [{ taskId: 't-1', round: 1 }],
    ),
  };
}

/** 注册后取回指定通道的 handler（省略样板） */
function handler(channel: string): (...args: unknown[]) => unknown {
  const h = ipcHandlers.get(channel);
  if (!h) throw new Error(`通道 ${channel} 未注册`);
  return h;
}

describe('registerInterruptIpc 契约（spec §7.2 四通道）', () => {
  beforeEach(() => {
    ipcHandlers.clear();
  });

  it('四通道注册名精确——不多不少', () => {
    registerInterruptIpc(mkDeps());
    expect([...ipcHandlers.keys()].sort()).toEqual(
      ['agent:abortTurn', 'dispatch:cancelChain', 'dispatch:listInFlight', 'session:stopAll'].sort(),
    );
  });

  describe('agent:abortTurn', () => {
    it('合法载荷：sessionId 解包透传 deps，返回值回传', () => {
      const deps = mkDeps();
      registerInterruptIpc(deps);
      expect(handler('agent:abortTurn')(undefined, { sessionId: 'sess-1' })).toEqual({
        stoppedStream: true,
      });
      expect(deps.abortTurn).toHaveBeenCalledTimes(1);
      expect(deps.abortTurn).toHaveBeenCalledWith('sess-1');
    });

    it('缺 sessionId 抛错且不触达 deps', () => {
      const deps = mkDeps();
      registerInterruptIpc(deps);
      expect(() => handler('agent:abortTurn')(undefined, {})).toThrow('sessionId 非法');
      expect(deps.abortTurn).not.toHaveBeenCalled();
    });

    it('空串 / 非字符串 sessionId 抛错', () => {
      const deps = mkDeps();
      registerInterruptIpc(deps);
      expect(() => handler('agent:abortTurn')(undefined, { sessionId: '' })).toThrow(
        'sessionId 非法',
      );
      expect(() => handler('agent:abortTurn')(undefined, { sessionId: 42 })).toThrow(
        'sessionId 非法',
      );
      expect(deps.abortTurn).not.toHaveBeenCalled();
    });
  });

  describe('session:stopAll', () => {
    it('合法载荷：透传 + 返回值回传', () => {
      const deps = mkDeps();
      registerInterruptIpc(deps);
      expect(handler('session:stopAll')(undefined, { sessionId: 'sess-1' })).toEqual({
        stoppedStreams: 2,
        cancelledChains: 3,
      });
      expect(deps.stopAll).toHaveBeenCalledWith('sess-1');
    });

    it('缺 sessionId 抛错且不触达 deps', () => {
      const deps = mkDeps();
      registerInterruptIpc(deps);
      expect(() => handler('session:stopAll')(undefined, {})).toThrow('sessionId 非法');
      expect(deps.stopAll).not.toHaveBeenCalled();
    });
  });

  describe('dispatch:cancelChain', () => {
    it('taskId 单键：deps 收到仅含 taskId 的对象', () => {
      const deps = mkDeps();
      registerInterruptIpc(deps);
      handler('dispatch:cancelChain')(undefined, { taskId: 't-1' });
      expect(deps.cancelChain).toHaveBeenCalledWith({ taskId: 't-1' });
    });

    it('subStreamSessionId 单键：仅含该键（renderer chip 的查找键，spec §7.6）', () => {
      const deps = mkDeps();
      registerInterruptIpc(deps);
      expect(handler('dispatch:cancelChain')(undefined, { subStreamSessionId: 'ssi-1' })).toEqual({
        status: 'cancelled',
      });
      expect(deps.cancelChain).toHaveBeenCalledWith({ subStreamSessionId: 'ssi-1' });
    });

    it('双键齐全：两键均透传', () => {
      const deps = mkDeps();
      registerInterruptIpc(deps);
      handler('dispatch:cancelChain')(undefined, { taskId: 't-1', subStreamSessionId: 'ssi-1' });
      expect(deps.cancelChain).toHaveBeenCalledWith({ taskId: 't-1', subStreamSessionId: 'ssi-1' });
    });

    it('双键全缺抛错且不触达 deps', () => {
      const deps = mkDeps();
      registerInterruptIpc(deps);
      expect(() => handler('dispatch:cancelChain')(undefined, {})).toThrow(
        'taskId 与 subStreamSessionId 至少一项',
      );
      expect(deps.cancelChain).not.toHaveBeenCalled();
    });

    it('非字符串键不混入透传对象', () => {
      const deps = mkDeps();
      registerInterruptIpc(deps);
      handler('dispatch:cancelChain')(undefined, { taskId: 42, subStreamSessionId: 'ssi-1' });
      expect(deps.cancelChain).toHaveBeenCalledWith({ subStreamSessionId: 'ssi-1' });
    });
  });

  describe('dispatch:listInFlight', () => {
    it('无载荷（undefined）：deps 收到 undefined（全量查询）', () => {
      const deps = mkDeps();
      registerInterruptIpc(deps);
      expect(handler('dispatch:listInFlight')(undefined, undefined)).toEqual([
        { taskId: 't-1', round: 1 },
      ]);
      expect(deps.listInFlight).toHaveBeenCalledWith(undefined);
    });

    it('空对象载荷：同样落到全量查询', () => {
      const deps = mkDeps();
      registerInterruptIpc(deps);
      handler('dispatch:listInFlight')(undefined, {});
      expect(deps.listInFlight).toHaveBeenCalledWith(undefined);
    });

    it('合法 sessionId 透传', () => {
      const deps = mkDeps();
      registerInterruptIpc(deps);
      handler('dispatch:listInFlight')(undefined, { sessionId: 'sess-1' });
      expect(deps.listInFlight).toHaveBeenCalledWith('sess-1');
    });

    it('非法 sessionId 类型抛错且不触达 deps', () => {
      const deps = mkDeps();
      registerInterruptIpc(deps);
      expect(() => handler('dispatch:listInFlight')(undefined, { sessionId: 42 })).toThrow(
        'sessionId 非法',
      );
      expect(deps.listInFlight).not.toHaveBeenCalled();
    });
  });
});
