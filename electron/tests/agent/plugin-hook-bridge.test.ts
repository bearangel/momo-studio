// electron/tests/agent/plugin-hook-bridge.test.ts
//
// 子进程侧插件钩子桥锁（spec §5.2）：无 process.send 直通（fail-open——Review
// Focus #1，护 runtime-entry-routing 既有测试群）/ id 配对回包 / 5s 超时降级
// null / postToolUse fire-and-forget 不等待。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { requestPreToolUse, notifyPostToolUse, PRE_TOOL_USE_TIMEOUT_MS } from '../../src/main/agent/plugin-hook-bridge';

interface ProcShape {
  send?: (msg: unknown) => void;
  on: (ev: string, fn: (msg: unknown) => void) => void;
  off: (ev: string, fn: (msg: unknown) => void) => void;
}

interface ProcHandle extends ProcShape {
  restore(): void;
}

function withFakeProc(partial: Partial<ProcShape>): ProcHandle {
  const proc = process as unknown as ProcShape;
  const orig = { send: proc.send, on: proc.on, off: proc.off };
  Object.assign(proc, partial);
  const handle: ProcHandle = {
    ...partial,
    on: proc.on,
    off: proc.off,
    restore: () => Object.assign(proc, orig),
  } as ProcHandle;
  return handle;
}

const PAYLOAD = { workspaceId: 'ws1', toolName: 'bash', args: { cmd: 'ls' } };

describe('requestPreToolUse', () => {
  it('无 process.send → 立即 null（fail-open，Review Focus #1）', async () => {
    const restore = withFakeProc({ send: undefined });
    try {
      const t0 = Date.now();
      expect(await requestPreToolUse(PAYLOAD)).toBeNull();
      expect(Date.now() - t0).toBeLessThan(50);
    } finally {
      restore.restore();
    }
  });

  it('主进程回包按 id 配对 → 决策透传', async () => {
    let captured: ((m: unknown) => void) | null = null;
    const sentRef: { v?: { type?: string; id?: string } } = {};
    const restore = withFakeProc({
      send: (m) => {
        sentRef.v = m as { type?: string; id?: string };
        // 模拟主进程立即回包
        setTimeout(() => captured?.({ id: (m as { id: string }).id, decision: { action: 'deny', reason: 'no' } }), 5);
      },
      on: (_ev, fn) => { captured = fn; },
      off: vi.fn(),
    });
    try {
      const d = await requestPreToolUse(PAYLOAD);
      expect(sentRef.v?.type).toBe('plugin:preToolUse');
      expect(d?.action).toBe('deny');
      expect(d?.reason).toBe('no');
    } finally {
      restore.restore();
    }
  });

  it('超时 → warn + null（不阻塞工具）', async () => {
    const restore = withFakeProc({
      send: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
    });
    try {
      const t0 = Date.now();
      expect(await requestPreToolUse(PAYLOAD)).toBeNull();
      expect(Date.now() - t0).toBeGreaterThanOrEqual(PRE_TOOL_USE_TIMEOUT_MS);
    } finally {
      restore.restore();
    }
  }, 15000);
});

describe('notifyPostToolUse', () => {
  it('fire-and-forget：send 后立即返回；无 send 静默', () => {
    const restore = withFakeProc({ send: vi.fn(), on: vi.fn(), off: vi.fn() });
    try {
      expect(() => notifyPostToolUse({ ...PAYLOAD, success: true, durationMs: 5 })).not.toThrow();
    } finally {
      restore.restore();
    }
    const restore2 = withFakeProc({ send: undefined, on: vi.fn(), off: vi.fn() });
    try {
      expect(() => notifyPostToolUse({ ...PAYLOAD, success: true, durationMs: 5 })).not.toThrow();
    } finally {
      restore2.restore();
    }
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── §8.4 真机回归锁（P5）：process.send 解构调用病 ──
// 真实 Node 的 process.send 读 this.connected——解构后调用 this=undefined 即抛
// 「Cannot read properties of undefined (reading 'connected')」。锁 bind(process) 语义。
describe('process.send 绑定语义（§8.4 真机回归）', () => {
  it('send 以 process 为 this 调用（bind 后不丢 this）', async () => {
    const calls: Array<{ thisIsProcess: boolean; msg: unknown }> = [];
    const orig = process.send;
    const sentinel = { tag: 'P5-THIS-CHECK' };
    (process as { send?: unknown }).send = function (this: unknown, msg: unknown) {
      calls.push({ thisIsProcess: this === process, msg });
      return true;
    } as never;
    try {
      const { notifyPostToolUse } = await import('../../src/main/agent/plugin-hook-bridge');
      notifyPostToolUse({ workspaceId: 'ws1', toolName: 't', args: {}, success: true, durationMs: 1 });
      // 直接调用形式（无 bind）在真桩下：this === undefined → 断言能区分
      const direct = (process as unknown as { send: (m: unknown) => void }).send;
      void direct; // 仅取引用不调用——避免真解构调用污染
      expect(calls.length).toBeGreaterThanOrEqual(1);
      expect(calls.at(-1)?.thisIsProcess).toBe(true);
    } finally {
      if (orig === undefined) delete (process as { send?: unknown }).send;
      else (process as { send?: unknown }).send = orig;
      void sentinel;
    }
  });
});
