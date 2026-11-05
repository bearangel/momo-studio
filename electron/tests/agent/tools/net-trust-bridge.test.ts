// electron/tests/agent/tools/net-trust-bridge.test.ts
//
// net-trust 桥（子进程侧）契约锁 + writePolicy 规范化（2026-11-05 全盘可写
// spec §5.5）。结构孪生 browser-ipc-bridge.test.ts——mock 纪律同源：
//   - process.send mock 仿真 this 绑定语义（真实 Node 读 this.connected，
//     解构裸调用必崩——P0-1 教训）
//   - requestId 断言真实唯一（randomUUID 形状）
//   - 新旧混跑安全（Review Focus #1）：旧主进程应答缺 writePolicy / 脏值
//     一律兜底 'confined'——绝不因缺字段把子进程 spawn 推向全盘写
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  requestEffectiveNetwork,
  handleNetTrustOpResult,
} from '../../../src/main/agent/tools/net-trust-bridge';

/** UUID v4 形状（randomUUID 产物） */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('net-trust 桥（子进程侧）', () => {
  const originalSend = process.send;
  let sent: unknown[];

  beforeEach(() => {
    sent = [];
  });

  afterEach(() => {
    process.send = originalSend;
  });

  /** 安装 this 绑定语义仿真的 process.send mock（记录投递） */
  function installSendMock(): void {
    process.send = function (this: unknown, msg: unknown): boolean {
      if (this === undefined || this === null) {
        throw new TypeError("Cannot read properties of undefined (reading 'connected')");
      }
      sent.push(msg);
      return true;
    } as NonNullable<typeof process.send>;
  }

  /** 取第 index 条已发送消息的 requestId */
  function sentRequestId(index = 0): string {
    const msg = sent[index] as { requestId?: string };
    if (typeof msg.requestId !== 'string') throw new Error('requestId 缺失');
    return msg.requestId;
  }

  /** 投递一次主进程应答并取 promise */
  function replyWith(payload: unknown): Promise<unknown> {
    const p = requestEffectiveNetwork('ssn-bridge-1', 'ws-1');
    handleNetTrustOpResult({
      type: 'net-trust-op:result',
      requestId: sentRequestId(),
      ok: true,
      payload,
    });
    return p;
  }

  it('契约锁：effective 载荷精确 {type, requestId, op, streamSessionId, workspaceId}', async () => {
    installSendMock();
    const p = requestEffectiveNetwork('ssn-bridge-1', 'ws-1');
    await Promise.resolve();
    expect(sent).toHaveLength(1);
    const msg = sent[0] as Record<string, unknown>;
    expect(msg['type']).toBe('net-trust-op');
    expect(msg['op']).toBe('effective');
    expect(msg['streamSessionId']).toBe('ssn-bridge-1');
    expect(msg['workspaceId']).toBe('ws-1');
    expect(UUID_RE.test(String(msg['requestId']))).toBe(true);
    handleNetTrustOpResult({
      type: 'net-trust-op:result', requestId: sentRequestId(), ok: true,
      payload: { netOn: true, extraDirs: [], writePolicy: 'confined' },
    });
    await expect(p).resolves.toEqual({ netOn: true, extraDirs: [], writePolicy: 'confined' });
  });

  it('规范化：旧主进程应答缺 writePolicy → 兜底 confined（混跑安全，绝不放大写域）', async () => {
    installSendMock();
    await expect(replyWith({ netOn: true, extraDirs: [] })).resolves.toEqual({
      netOn: true, extraDirs: [], writePolicy: 'confined',
    });
  });

  it('规范化：脏值 writePolicy → 兜底 confined', async () => {
    installSendMock();
    await expect(replyWith({ netOn: false, extraDirs: [], writePolicy: 'yolo' })).resolves.toEqual({
      netOn: false, extraDirs: [], writePolicy: 'confined',
    });
  });

  it('规范化：合法 full-disk 透传（设置翻转后下一条 bash 即全盘写）', async () => {
    installSendMock();
    await expect(replyWith({ netOn: true, extraDirs: [], writePolicy: 'full-disk' })).resolves.toEqual({
      netOn: true, extraDirs: [], writePolicy: 'full-disk',
    });
  });

  it('规范化：extraDirs 非数组兜底 []（既有回归）', async () => {
    installSendMock();
    await expect(replyWith({ netOn: true, writePolicy: 'confined' })).resolves.toEqual({
      netOn: true, extraDirs: [], writePolicy: 'confined',
    });
  });

  it('process.send 缺失（非 fork 环境）→ 立即 reject 不挂等超时', async () => {
    delete (process as { send?: unknown }).send;
    await expect(requestEffectiveNetwork('ssn-x', 'ws-x')).rejects.toThrow('process.send 缺失');
  });

  it('未知 requestId 迟到结果静默忽略（不崩不误伤）', () => {
    expect(() =>
      handleNetTrustOpResult({ type: 'net-trust-op:result', requestId: 'ghost-id', ok: true, payload: {} }),
    ).not.toThrow();
  });
});
