// electron/tests/agent/agent-runner-browser-op.test.ts
//
// 主机验收 P0 回归锁：AgentRunner messageHandler 的 browser-op 分支。
//
// 子进程 browser 工具经 IPC 桥发来 { type:'browser-op', requestId, op, args }——
// 该消息【不带 streamSessionId】，必须在「只处理本 task 的 chunk」过滤之前分发，
// 否则被流过滤拦截丢弃 → 子进程 60s 挂等超时。分支链路：
//   routeBrowserOp(msg) → child.send({type:'browser-op:result', requestId, ok, ...})。
//
// 形态：与 agent-runner.test.ts 同款 mock child（记录 message handler）；
// op-router 是跨进程边界依赖——mock routeBrowserOp 为 spy（路由分发逻辑自身
// 在 tests/browser/op-router.test.ts 锁定，此处只锁 agent-runner 接线）。

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentRunner } from '../../src/main/agent/agent-runner';
import { WarmPool } from '../../src/main/agent/warm-pool';
import { routeBrowserOp } from '../../src/main/browser/op-router';
import type { ChildProcess } from 'node:child_process';

vi.mock('../../src/main/browser/op-router', () => ({
  routeBrowserOp: vi.fn(),
}));

/**
 * 构造 mock 子进程——记录 message handler 以便测试模拟子进程发消息
 * （与 agent-runner.test.ts 同模式，避免真实 fork）。
 */
function mkMockChild(): ChildProcess & {
  kill: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  off: ReturnType<typeof vi.fn>;
} {
  const handlers: Record<string, (...args: unknown[]) => void> = {};
  return {
    pid: 12345,
    on: vi.fn((event: string, h: (...args: unknown[]) => void) => {
      handlers[event] = h;
    }),
    off: vi.fn(),
    send: vi.fn(() => true),
    kill: vi.fn(),
    connected: true,
    exitCode: null,
  } as unknown as ChildProcess & {
    kill: ReturnType<typeof vi.fn>;
    send: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
    off: ReturnType<typeof vi.fn>;
  };
}

/** 从 mock child 的 on() 调用记录里取回注册的 message handler */
function getMessageHandler(child: ChildProcess): (msg: unknown) => void {
  const onCalls = (child.on as unknown as ReturnType<typeof vi.fn>).mock.calls;
  const handler = onCalls.find((c) => c[0] === 'message')?.[1] as
    | ((msg: unknown) => void)
    | undefined;
  if (!handler) throw new Error('message handler 未注册');
  return handler;
}

describe('AgentRunner browser-op 分支（browser 工具 IPC 桥接线）', () => {
  beforeEach(() => {
    vi.mocked(routeBrowserOp).mockReset();
  });

  it('browser-op 消息 → routeBrowserOp 被调 + child.send 收到成功 result（载荷原样回传）', async () => {
    const child = mkMockChild();
    const warmPool = new WarmPool({ spawn: vi.fn().mockResolvedValue(child) });
    await warmPool.warm('inst1');
    const runner = new AgentRunner({
      agentAssignmentId: 'inst1',
      agentUserId: 'agent-bot-x1',
      workspaceId: 'ws1',
      config: {} as never,
      warmPool: warmPool,
    });
    await runner.executeTask({
      taskId: null,
      executionSessionId: '!r:home',
      body: 'x',
      streamSessionId: 'ss-1',
    });

    const payload = { url: 'https://example.com/final', title: 'Example' };
    vi.mocked(routeBrowserOp).mockResolvedValue({ ok: true, payload });

    const opMsg = { type: 'browser-op', requestId: 'req-1', op: 'navigate', args: ['ws1', 'https://example.com'] };
    getMessageHandler(child)(opMsg);

    await vi.waitFor(() => {
      expect(routeBrowserOp).toHaveBeenCalledWith(opMsg);
    });
    await vi.waitFor(() => {
      expect(child.send).toHaveBeenCalledWith({
        type: 'browser-op:result',
        requestId: 'req-1',
        ok: true,
        payload,
      });
    });

    // browser-op 不携带 streamSessionId——不得影响活跃 task（不被流过滤误伤、不触发收尾）
    expect(runner.activeTaskCount()).toBe(1);

    // 后续 end 正常收尾（分支 return 不污染既有消息语义）
    getMessageHandler(child)({ type: 'end', streamSessionId: 'ss-1', finishReason: 'stop' });
    expect(runner.activeTaskCount()).toBe(0);
    await runner.destroy();
  });

  it('路由失败 → child.send 收到 {ok:false, error:{name,message}}（error 保真回传）', async () => {
    const child = mkMockChild();
    const warmPool = new WarmPool({ spawn: vi.fn().mockResolvedValue(child) });
    await warmPool.warm('inst1');
    const runner = new AgentRunner({
      agentAssignmentId: 'inst1',
      agentUserId: 'agent-bot-x1',
      workspaceId: 'ws1',
      config: {} as never,
      warmPool: warmPool,
    });
    await runner.executeTask({
      taskId: null,
      executionSessionId: '!r:home',
      body: 'x',
      streamSessionId: 'ss-1',
    });

    vi.mocked(routeBrowserOp).mockResolvedValue({
      ok: false,
      error: { name: 'BrowserNotTrustedError', message: '已请求浏览器权限，请在右下角卡片授权后重试' },
    });

    getMessageHandler(child)({ type: 'browser-op', requestId: 'req-2', op: 'click', args: ['ws1', '#btn'] });

    await vi.waitFor(() => {
      expect(child.send).toHaveBeenCalledWith({
        type: 'browser-op:result',
        requestId: 'req-2',
        ok: false,
        error: { name: 'BrowserNotTrustedError', message: '已请求浏览器权限，请在右下角卡片授权后重试' },
      });
    });
    expect(runner.activeTaskCount()).toBe(1);
    await runner.destroy();
  });
});
