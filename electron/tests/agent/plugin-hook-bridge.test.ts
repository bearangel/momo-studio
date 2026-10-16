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
