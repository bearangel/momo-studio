// electron/tests/browser/op-router.test.ts
//
// 主进程 browser op 路由测试——routeBrowserOp 把子进程 browser-op 请求分发到
// 真实 policy/manager 面（initBrowserOpRouter 注册），错误序列化为 {name,message}
// 回传子进程（BrowserError 子类名保留，LLM 可见可行动指引）。
//
// 安全锁（设计铁律）：
//   - 主进程路由禁止经此通道传 source='user'——tabsAction 最多 4 参 / closeBrowser
//     最多 1 参，超量参数一律拒收且真实 manager 不被触碰（元数走私防御）
//   - 未注册路由 / 未知 op / 形状非法 / 参数类型不符 → error 应答（子进程 60s
//     挂等防护——绝不静默丢弃）
//
// fake policy/manager 用 vi.fn 记录调用（本测试被测对象是「分发逻辑」本身，
// 真实 BrowserPolicy/BrowserManager 已各有单测；此处只锁分发命中与参数透传）。

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { initBrowserOpRouter, routeBrowserOp, __resetBrowserOpRouterForTest } from '../../src/main/browser/op-router';
import { BrowserNotTrustedError, BrowserNoViewError } from '../../src/main/browser/errors';
import type { BrowserPolicyPort, BrowserManagerPort } from '../../src/main/agent/tools/browser-tools';

/** fake 端口：全方法 vi.fn 记录调用与返回 */
function mkFakePorts(): { policy: BrowserPolicyPort; manager: BrowserManagerPort } {
  return {
    policy: {
      assertAllowed: vi.fn(),
      assertEvaluate: vi.fn(),
    },
    manager: {
      navigate: vi.fn(async () => ({ url: 'https://example.com/final', title: 'Example' })),
      snapshot: vi.fn(async () => 'a11y 树'),
      screenshot: vi.fn(async () => ({ path: '/tmp/shot.png' })),
      click: vi.fn(async () => undefined),
      type: vi.fn(async () => undefined),
      pressKey: vi.fn(async () => undefined),
      hover: vi.fn(async () => undefined),
      scroll: vi.fn(async () => undefined),
      evaluate: vi.fn(async () => ({ answer: 42 })),
      consoleMessages: vi.fn(async () => ['[log] hi']),
      tabsAction: vi.fn(async () => [{ index: 0, title: 'Example', url: 'https://example.com' }]),
      closeBrowser: vi.fn(async () => undefined),
    },
  };
}

describe('主进程 browser op 路由（routeBrowserOp）', () => {
  beforeEach(() => {
    __resetBrowserOpRouterForTest();
  });

  it('未注册路由 → error 应答（中文文案），不抛异常', async () => {
    const r = await routeBrowserOp({ type: 'browser-op', requestId: 'r-0', op: 'snapshot', args: ['ws-1'] });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.message).toBe('主进程 browser op 路由未初始化');
    }
  });

  it('分发命中：navigate → manager.navigate(wsId, url) 精确参数 + payload 透传', async () => {
    const ports = mkFakePorts();
    initBrowserOpRouter(ports.policy, ports.manager);

    const r = await routeBrowserOp({
      type: 'browser-op',
      requestId: 'r-1',
      op: 'navigate',
      args: ['ws-1', 'https://example.com'],
    });

    expect(r.ok).toBe(true);
    if (r.ok) expect(r.payload).toEqual({ url: 'https://example.com/final', title: 'Example' });
    expect(ports.manager.navigate).toHaveBeenCalledWith('ws-1', 'https://example.com');
  });

  it('分发命中：policy 两 op（assertAllowed / assertEvaluate 参数 [wsId]）', async () => {
    const ports = mkFakePorts();
    initBrowserOpRouter(ports.policy, ports.manager);

    const r1 = await routeBrowserOp({ type: 'browser-op', requestId: 'r-1', op: 'assertAllowed', args: ['ws-1'] });
    expect(r1.ok).toBe(true);
    const r2 = await routeBrowserOp({ type: 'browser-op', requestId: 'r-2', op: 'assertEvaluate', args: ['ws-1'] });
    expect(r2.ok).toBe(true);
    expect(ports.policy.assertAllowed).toHaveBeenCalledWith('ws-1');
    expect(ports.policy.assertEvaluate).toHaveBeenCalledWith('ws-1');
  });

  it('分发命中：scroll（direction + amount 透传）与 tabsAction（4 参，不含 source）', async () => {
    const ports = mkFakePorts();
    initBrowserOpRouter(ports.policy, ports.manager);

    await routeBrowserOp({ type: 'browser-op', requestId: 'r-1', op: 'scroll', args: ['ws-1', 'down', 5] });
    expect(ports.manager.scroll).toHaveBeenCalledWith('ws-1', 'down', 5);

    await routeBrowserOp({
      type: 'browser-op',
      requestId: 'r-2',
      op: 'tabsAction',
      args: ['ws-1', 'open', undefined, 'https://example.com'],
    });
    // 精确 4 参——source 恒不被传递（桥路径工具层缺省 'agent'）
    expect(ports.manager.tabsAction).toHaveBeenCalledWith('ws-1', 'open', undefined, 'https://example.com');
    expect(vi.mocked(ports.manager.tabsAction).mock.calls[0]?.length).toBe(4);
  });

  it('安全锁：tabsAction 第 5 参走私 source → 拒收且 manager 不被触碰', async () => {
    const ports = mkFakePorts();
    initBrowserOpRouter(ports.policy, ports.manager);

    const r = await routeBrowserOp({
      type: 'browser-op',
      requestId: 'r-x',
      op: 'tabsAction',
      // 恶意/漂移载荷：故意超量（走私 source='user'——真实端口签名第 5 参恰是 source）
      args: ['ws-1', 'list', undefined, undefined, 'user'],
    });

    expect(r.ok).toBe(false);
    expect(ports.manager.tabsAction).not.toHaveBeenCalled();
    expect(ports.manager.closeBrowser).not.toHaveBeenCalled();
  });

  it('安全锁：closeBrowser 第 2 参走私 source → 拒收', async () => {
    const ports = mkFakePorts();
    initBrowserOpRouter(ports.policy, ports.manager);

    const r = await routeBrowserOp({
      type: 'browser-op',
      requestId: 'r-x',
      op: 'closeBrowser',
      // 恶意/漂移载荷：故意超量（走私 source='user'——真实端口签名第 2 参恰是 source）
      args: ['ws-1', 'user'],
    });

    expect(r.ok).toBe(false);
    expect(ports.manager.closeBrowser).not.toHaveBeenCalled();
  });

  it('policy 抛 BrowserNotTrustedError → {ok:false, name, message} 原样序列化', async () => {
    const ports = mkFakePorts();
    vi.mocked(ports.policy.assertAllowed).mockImplementation(() => {
      throw new BrowserNotTrustedError();
    });
    initBrowserOpRouter(ports.policy, ports.manager);

    const r = await routeBrowserOp({ type: 'browser-op', requestId: 'r-1', op: 'assertAllowed', args: ['ws-1'] });

    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('应当 error');
    expect(r.error.name).toBe('BrowserNotTrustedError');
    expect(r.error.message).toBe('已请求浏览器权限，请在右下角卡片授权后重试');
  });

  it('manager 异步 reject（BrowserNoViewError）→ {ok:false, name, message} 保真', async () => {
    const ports = mkFakePorts();
    vi.mocked(ports.manager.snapshot).mockRejectedValue(new BrowserNoViewError());
    initBrowserOpRouter(ports.policy, ports.manager);

    const r = await routeBrowserOp({ type: 'browser-op', requestId: 'r-1', op: 'snapshot', args: ['ws-1'] });

    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('应当 error');
    expect(r.error.name).toBe('BrowserNoViewError');
    expect(r.error.message).toBe('浏览器未打开（先 browser_navigate）');
  });

  it('未知 op → error 应答（不抛异常、不触达 manager）', async () => {
    const ports = mkFakePorts();
    initBrowserOpRouter(ports.policy, ports.manager);

    const r = await routeBrowserOp({
      type: 'browser-op',
      requestId: 'r-1',
      // 未知操作符（判别联合外的漂移值——信封校验拒收）
      op: 'frobnicate',
      args: [],
    });

    expect(r.ok).toBe(false);
    expect(ports.manager.navigate).not.toHaveBeenCalled();
  });

  it('形状非法（requestId 缺失 / args 非数组 / type 不符）→ error 应答', async () => {
    const ports = mkFakePorts();
    initBrowserOpRouter(ports.policy, ports.manager);

    const bad1 = await routeBrowserOp({ type: 'browser-op', op: 'snapshot', args: ['ws-1'] });
    expect(bad1.ok).toBe(false);
    const bad2 = await routeBrowserOp({ type: 'browser-op', requestId: 'r', op: 'snapshot', args: 'not-array' });
    expect(bad2.ok).toBe(false);
    const bad3 = await routeBrowserOp({ type: 'something-else', requestId: 'r', op: 'snapshot', args: [] });
    expect(bad3.ok).toBe(false);
    expect(ports.manager.snapshot).not.toHaveBeenCalled();
  });

  it('参数类型不符（navigate url 非字符串）→ error 应答且 manager 未被调用', async () => {
    const ports = mkFakePorts();
    initBrowserOpRouter(ports.policy, ports.manager);

    const r = await routeBrowserOp({
      type: 'browser-op',
      requestId: 'r-1',
      op: 'navigate',
      args: ['ws-1', 42],
    });

    expect(r.ok).toBe(false);
    expect(ports.manager.navigate).not.toHaveBeenCalled();
  });
});
