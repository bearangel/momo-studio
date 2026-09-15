// electron/tests/browser/op-ctx-threading.test.ts
//
// 归属制身份透传契约锁（spec §5.1/§5.2）：agentInstanceId → BrowserOpCtx →
// 桥 args 尾参 → 主路由提取 → 真实 manager 收到。三段各自独立断言。
import { describe, it, expect, vi } from 'vitest';
import { createBrowserToolsIpcBridge } from '../../src/main/agent/tools/browser-ipc-bridge';
import { routeBrowserOp, initBrowserOpRouter, __resetBrowserOpRouterForTest } from '../../src/main/browser/op-router';
import type { BrowserManagerPort, BrowserPolicyPort } from '../../src/main/agent/tools/browser-tools';
import type { BrowserOpOutcome } from '../../src/main/browser/op-protocol';

describe('BrowserOpCtx 身份透传', () => {
  it('桥端：manager.navigate 携带 ctx 时 args 尾部是 { ownerId, sessionId } 对象', async () => {
    const sent: unknown[] = [];
    const origSend = process.send;
    (process as { send?: unknown }).send = ((msg: unknown) => { sent.push(msg); }) as never;
    try {
      const bridge = createBrowserToolsIpcBridge(1_000);
      const p = bridge.manager.navigate('w1', 'https://a.com', { ownerId: 'inst-1', sessionId: 'sess-1' });
      // 模拟主进程立即回绝（不等超时——只验发送形状）
      const req = sent[0] as { type: string; op: string; args: unknown[] };
      expect(req.type).toBe('browser-op');
      expect(req.op).toBe('navigate');
      expect(req.args[req.args.length - 1]).toEqual({ ownerId: 'inst-1', sessionId: 'sess-1' });
      void p.catch(() => {});
    } finally {
      (process as { send?: unknown }).send = origSend;
    }
  });

  it('主路由端：args 尾参 ctx 被提取并以第三参传给 manager.navigate', async () => {
    const navigate = vi.fn(async () => ({ url: 'https://a.com', title: 'A' }));
    const manager = { navigate } as unknown as BrowserManagerPort;
    const policy = {} as unknown as BrowserPolicyPort;
    initBrowserOpRouter(policy, manager);
    try {
      const outcome: BrowserOpOutcome = await routeBrowserOp({
        type: 'browser-op', requestId: 'r1', op: 'navigate',
        args: ['w1', 'https://a.com', { ownerId: 'inst-1', sessionId: 'sess-1' }],
      });
      expect(outcome.ok).toBe(true);
      expect(navigate).toHaveBeenCalledWith('w1', 'https://a.com', { ownerId: 'inst-1', sessionId: 'sess-1' });
    } finally {
      __resetBrowserOpRouterForTest();
    }
  });

  it('主路由端：ctx 缺失/形状非法 → ok:false（不静默吞）', async () => {
    const manager = {} as unknown as BrowserManagerPort;
    initBrowserOpRouter({} as unknown as BrowserPolicyPort, manager);
    try {
      const bad = await routeBrowserOp({ type: 'browser-op', requestId: 'r2', op: 'navigate', args: ['w1', 'u'] });
      expect(bad.ok).toBe(false);
    } finally {
      __resetBrowserOpRouterForTest();
    }
  });
});
