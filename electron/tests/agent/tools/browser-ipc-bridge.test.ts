// electron/tests/agent/tools/browser-ipc-bridge.test.ts
//
// browser IPC 桥（子进程侧）契约锁 + 错误/超时路径（主机验收 P0 修复）。
//
// 根因：initBrowserTools 只在主进程 boot 调用，agent 工具在 runtime 子进程执行
//   ——模块级注入按进程隔离，子进程恒未初始化 → 12 个浏览器工具全部报
//   「BrowserTools 未初始化」。本桥把两端口（policy/manager）代理为
//   process.send IPC 往返。
//
// 契约锁（momo-boundary-rules：一义一名，两端同 commit）：
//   子→主 { type:'browser-op', requestId(真实 UUID), op, args }
//   主→子 { type:'browser-op:result', requestId, ok:true,payload | ok:false,error{name,message} }
//
// mock 纪律（momo-test-rules）：
//   - process.send 是进程边界——mock 仿真真实语义：this 绑定校验（真实 Node
//     内部读 this.connected，解构裸调用必崩，P0-1 教训）
//   - requestId 断言真实唯一（randomUUID 形状 + 两次调用互异——占位 id 会让
//     pending 派发误杀）
//   - 错误路径专项：ok:false 保真 / 超时清 pending / process.send 缺失立即拒绝 /
//     未知 requestId 迟到结果不崩

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createBrowserToolsIpcBridge, handleBrowserOpResult } from '../../../src/main/agent/tools/browser-ipc-bridge';

/** UUID v4 形状（randomUUID 产物） */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('browser IPC 桥（子进程侧）', () => {
  const originalSend = process.send;
  let sent: unknown[];

  beforeEach(() => {
    sent = [];
    vi.useRealTimers();
  });

  afterEach(() => {
    process.send = originalSend;
    vi.useRealTimers();
  });

  /** 安装 this 绑定语义仿真的 process.send mock（记录 + 回调） */
  function installSendMock(): void {
    process.send = function (
      this: unknown,
      msg: unknown,
      callback?: (err: Error | null) => void,
    ): boolean {
      // 真实语义：Node 的 process.send 内部读 this.connected——解构后裸调用
      // （this=undefined）在真实环境抛 TypeError；mock 同样拒绝裸调用（P0-1 回归锁）
      if (this === undefined || this === null) {
        throw new TypeError("Cannot read properties of undefined (reading 'connected')");
      }
      sent.push(msg);
      if (callback) callback(null);
      return true;
    } as NonNullable<typeof process.send>;
  }

  /** 从已发送消息里取第 index 条的 requestId */
  function sentRequestId(index = 0): string {
    const msg = sent[index] as { requestId?: string };
    if (typeof msg.requestId !== 'string') throw new Error('requestId 缺失');
    return msg.requestId;
  }

  it('契约锁：manager.navigate → process.send 收到精确 browser-op 载荷；投递 result 后 resolve', async () => {
    installSendMock();
    const { manager } = createBrowserToolsIpcBridge();

    const p = manager.navigate('ws-1', 'https://example.com');
    // 微任务两跳：promise executor 同步 send（无需等宏任务）
    await Promise.resolve();

    expect(sent).toHaveLength(1);
    const msg = sent[0] as Record<string, unknown>;
    expect(msg['type']).toBe('browser-op');
    expect(msg['op']).toBe('navigate');
    expect(msg['args']).toEqual(['ws-1', 'https://example.com']);
    expect(typeof msg['requestId']).toBe('string');
    expect(UUID_RE.test(String(msg['requestId']))).toBe(true);

    const payload = { url: 'https://example.com/final', title: 'Example' };
    handleBrowserOpResult({
      type: 'browser-op:result',
      requestId: sentRequestId(),
      ok: true,
      payload,
    });
    await expect(p).resolves.toEqual(payload);
  });

  it('契约锁：requestId 真实唯一（两次调用互异——pending 派发不误杀）', async () => {
    installSendMock();
    const { manager } = createBrowserToolsIpcBridge();

    const p1 = manager.snapshot('ws-1');
    const p2 = manager.snapshot('ws-1');
    await Promise.resolve();

    expect(sent).toHaveLength(2);
    const id1 = sentRequestId(0);
    const id2 = sentRequestId(1);
    expect(id1).not.toBe(id2);

    handleBrowserOpResult({ type: 'browser-op:result', requestId: id2, ok: true, payload: 'snap-2' });
    handleBrowserOpResult({ type: 'browser-op:result', requestId: id1, ok: true, payload: 'snap-1' });
    await expect(p1).resolves.toBe('snap-1');
    await expect(p2).resolves.toBe('snap-2');
  });

  it('契约锁：policy 端口两 op 代理（assertAllowed / assertEvaluate 参数 [wsId]）', async () => {
    installSendMock();
    const { policy } = createBrowserToolsIpcBridge();

    // 端口面为 void | Promise<void> 联合——Promise.resolve 归一后挂 no-op 兜底
    // （桥实现 resolve 不 reject；此处只锁发送侧契约）
    void Promise.resolve(policy.assertAllowed('ws-9')).then(() => undefined, () => undefined);
    void Promise.resolve(policy.assertEvaluate('ws-9')).then(() => undefined, () => undefined);
    await Promise.resolve();

    expect(sent[0]).toMatchObject({ type: 'browser-op', op: 'assertAllowed', args: ['ws-9'] });
    expect(sent[1]).toMatchObject({ type: 'browser-op', op: 'assertEvaluate', args: ['ws-9'] });

    handleBrowserOpResult({ type: 'browser-op:result', requestId: sentRequestId(0), ok: true, payload: undefined });
    handleBrowserOpResult({ type: 'browser-op:result', requestId: sentRequestId(1), ok: true, payload: undefined });
  });

  it('ok:false → reject 且 error.name / message 保真（BrowserError 子类名保留）', async () => {
    installSendMock();
    const { manager } = createBrowserToolsIpcBridge();

    const p = manager.click('ws-1', '#btn');
    await Promise.resolve();
    const requestId = sentRequestId();

    handleBrowserOpResult({
      type: 'browser-op:result',
      requestId,
      ok: false,
      error: { name: 'BrowserNotTrustedError', message: '已请求浏览器权限，请在右下角卡片授权后重试' },
    });

    const err = await p.then(
      () => { throw new Error('应当 reject'); },
      (e: Error) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('BrowserNotTrustedError');
    expect(err.message).toBe('已请求浏览器权限，请在右下角卡片授权后重试');
  });

  it('60s 超时 → reject 中文文案 + pending 清空（迟到结果安全 no-op）', async () => {
    installSendMock();
    vi.useFakeTimers();
    const { manager } = createBrowserToolsIpcBridge();

    const p = manager.snapshot('ws-1');
    await Promise.resolve();
    const requestId = sentRequestId();
    expect(p).rejects.toThrow('browser IPC 无响应（主进程未接线或超时）');

    await vi.advanceTimersByTimeAsync(60_000);
    await expect(p).rejects.toThrow('browser IPC 无响应（主进程未接线或超时）');

    // 超时后迟到 result：requestId 已清出 pending——静默忽略不崩
    expect(() =>
      handleBrowserOpResult({ type: 'browser-op:result', requestId, ok: true, payload: 'late' }),
    ).not.toThrow();
  });

  it('未知 requestId 的 result → 静默忽略（无 pending 条目不崩、不误伤在途请求）', async () => {
    installSendMock();
    const { manager } = createBrowserToolsIpcBridge();

    const p = manager.consoleMessages('ws-1');
    await Promise.resolve();

    expect(() =>
      handleBrowserOpResult({ type: 'browser-op:result', requestId: 'not-exist', ok: true, payload: [] }),
    ).not.toThrow();

    handleBrowserOpResult({ type: 'browser-op:result', requestId: sentRequestId(), ok: true, payload: ['[log] hi'] });
    await expect(p).resolves.toEqual(['[log] hi']);
  });

  it('process.send 不可用（非 fork）→ 立即 reject，不挂等超时', async () => {
    process.send = undefined;
    const { manager } = createBrowserToolsIpcBridge();

    const p = manager.snapshot('ws-1');
    // 真实计时器下直接 await——若实现误走挂等路径，此 await 将吊死测试（vitest 超时红）
    await expect(p).rejects.toThrow('browser IPC 不可用');
  });
});
