// electron/tests/compaction/ipc-bridge.test.ts
//
// compaction IPC 线协议两端契约锁（spec §4.4，momo-boundary-rules 铁律 4：
// 生产者/消费者成对修改 + 契约测试锁形状）：
//   - 子进程发送方（runtime-entry.requestCompaction）→ process.send 载荷形状：
//     { type:'compaction:request', streamSessionId, sessionId, conversation, coveredUntil }
//   - 主进程分支（runtime-spawner.handleCompactionRequestMsg）→ generateCompaction
//     + upsertSessionCompaction 参数 + 回写 { type:'compaction:result', streamSessionId,
//     ok, summary|error }
//   - 子进程接收（runtime-entry.handleCompactionResultIpc）→ 按 streamSessionId 配对
//     resolve/reject；10s 超时；未知 id 迟到结果不崩
//
// 配对保真：请求侧捕获真实生成的 streamSessionId（randomUUID，非手写占位）直接
// 回喂结果侧——生产者真实产出 → 消费者直接消费，不经手写中间数据。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ─── spawner 依赖边界 mock（进程/DB 边界；compaction/service 为被测接线的对端） ──

const { generateCompactionMock, upsertMock } = vi.hoisted(() => ({
  generateCompactionMock: vi.fn(),
  upsertMock: vi.fn(),
}));

vi.mock('../../src/main/compaction/service', () => ({
  generateCompaction: generateCompactionMock,
  upsertSessionCompaction: upsertMock,
  getSessionCompaction: vi.fn(() => null),
}));
// spawner 其余依赖按模块路径 mock，避免加载 MCP Host / DB / 内部事件桥真实实现
vi.mock('../../src/main/agent/internal-event-bridge', () => ({ handleChildMessage: vi.fn(() => false) }));
vi.mock('../../src/main/audit/insert', () => ({ insertToolCall: vi.fn() }));
vi.mock('../../src/main/audit/quota', () => ({ enforceAuditQuota: vi.fn() }));
vi.mock('../../src/main/mcp/host-manager', () => ({
  getOrStartMcp: vi.fn(),
  getMcpConfig: vi.fn(() => null),
  listMcpTools: vi.fn(),
  callMcpTool: vi.fn(),
}));
vi.mock('../../src/main/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { handleCompactionRequestMsg } from '../../src/main/agent/runtime-spawner';
import {
  requestCompaction,
  handleCompactionResultIpc,
  COMPACTION_REQUEST_TIMEOUT_MS,
} from '../../src/main/agent/runtime-entry';

// ─── 子进程侧：process.send 捕获（属性替换 + 还原，memory-tools.test.ts 同款；不依赖 this 绑定） ──

/** 捕获的 compaction:request 载荷（按发送顺序） */
const sentRequests: Array<Record<string, unknown>> = [];
const originalSend = process.send;

beforeEach(() => {
  vi.clearAllMocks();
  generateCompactionMock.mockReset();
  upsertMock.mockReset();
  sentRequests.length = 0;
  process.send = ((msg: unknown): boolean => {
    sentRequests.push(msg as Record<string, unknown>);
    return true;
  }) as NonNullable<typeof process.send>;
});

afterEach(() => {
  process.send = originalSend;
  vi.useRealTimers();
});

// ─── 子进程发送方 → 主进程分支（线协议形状锁） ───────────────────────────────

describe('compaction:request 线协议（子→主）', () => {
  it('requestCompaction 发送载荷形状锁（type/streamSessionId/sessionId/conversation/coveredUntil）', async () => {
    const p = requestCompaction('s-ipc-1', '[用户]: 压缩我', 12345);
    expect(sentRequests).toHaveLength(1);
    const sent = sentRequests[0];
    expect(sent).toEqual({
      type: 'compaction:request',
      streamSessionId: expect.any(String) as string,
      sessionId: 's-ipc-1',
      conversation: '[用户]: 压缩我',
      coveredUntil: 12345,
    });
    handleCompactionResultIpc({
      type: 'compaction:result',
      streamSessionId: sent?.streamSessionId as string,
      ok: true,
      summary: '摘要',
    });
    await expect(p).resolves.toBe('摘要');
  });

  it('并发两次请求 → streamSessionId 真实唯一（配对不串扰）', async () => {
    const p1 = requestCompaction('s-ipc-1', '对话一', 1);
    const p2 = requestCompaction('s-ipc-1', '对话二', 2);
    const id1 = sentRequests[0]!.streamSessionId as string;
    const id2 = sentRequests[1]!.streamSessionId as string;
    expect(id1).not.toBe(id2);
    handleCompactionResultIpc({ type: 'compaction:result', streamSessionId: id2, ok: true, summary: '第二个' });
    handleCompactionResultIpc({ type: 'compaction:result', streamSessionId: id1, ok: true, summary: '第一个' });
    await expect(p1).resolves.toBe('第一个');
    await expect(p2).resolves.toBe('第二个');
  });
});

// ─── 主进程分支：compaction:request → 服务调用 + 回写 ────────────────────────

describe('spawner compaction:request 分支（主→子回写）', () => {
  it('成功：generateCompaction({sessionId,conversation}) + upsert(sessionId,summary,coveredUntil) + ok:true 回写', async () => {
    generateCompactionMock.mockResolvedValue({ summary: '结构化摘要' });
    const respond = vi.fn();
    const handled = await handleCompactionRequestMsg(
      { type: 'compaction:request', streamSessionId: 'ss-1', sessionId: 's-ipc-1', conversation: '对话', coveredUntil: 777 },
      respond,
    );
    expect(handled).toBe(true);
    expect(generateCompactionMock).toHaveBeenCalledWith({ sessionId: 's-ipc-1', conversation: '对话' });
    expect(upsertMock).toHaveBeenCalledWith('s-ipc-1', '结构化摘要', 777);
    expect(respond).toHaveBeenCalledWith({
      type: 'compaction:result',
      streamSessionId: 'ss-1',
      ok: true,
      summary: '结构化摘要',
    });
  });

  it('失败：generateCompaction throw → ok:false + error 文本回写（不 upsert）', async () => {
    generateCompactionMock.mockRejectedValue(new Error('未配置可用模型服务（设置 → 模型服务）'));
    const respond = vi.fn();
    const handled = await handleCompactionRequestMsg(
      { type: 'compaction:request', streamSessionId: 'ss-2', sessionId: 's-ipc-1', conversation: '对话', coveredUntil: 1 },
      respond,
    );
    expect(handled).toBe(true);
    expect(upsertMock).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith({
      type: 'compaction:result',
      streamSessionId: 'ss-2',
      ok: false,
      error: '未配置可用模型服务（设置 → 模型服务）',
    });
  });

  it('非 string rejection 的错误也收敛为文本（防 m.error undefined 误判为成功）', async () => {
    generateCompactionMock.mockRejectedValue('裸字符串错误');
    const respond = vi.fn();
    await handleCompactionRequestMsg(
      { type: 'compaction:request', streamSessionId: 'ss-3', sessionId: 's', conversation: 'x', coveredUntil: 1 },
      respond,
    );
    expect(respond).toHaveBeenCalledWith(
      expect.objectContaining({ ok: false, error: '裸字符串错误' }),
    );
  });

  it('coveredUntil IPC 类型漂移（字符串）→ Number 收敛后 upsert', async () => {
    generateCompactionMock.mockResolvedValue({ summary: 's' });
    const respond = vi.fn();
    await handleCompactionRequestMsg(
      { type: 'compaction:request', streamSessionId: 'ss-4', sessionId: 's', conversation: 'x', coveredUntil: '777' },
      respond,
    );
    expect(upsertMock).toHaveBeenCalledWith('s', 's', 777);
  });

  it('coveredUntil 非数值 → 回退 Date.now()（时间游标绝不落 NaN）', async () => {
    generateCompactionMock.mockResolvedValue({ summary: 's' });
    const respond = vi.fn();
    const before = Date.now();
    await handleCompactionRequestMsg(
      { type: 'compaction:request', streamSessionId: 'ss-5', sessionId: 's', conversation: 'x', coveredUntil: 'not-a-number' },
      respond,
    );
    const covered = upsertMock.mock.calls[0][2] as number;
    expect(covered).toBeGreaterThanOrEqual(before);
    expect(Number.isFinite(covered)).toBe(true);
  });

  it('非 compaction 消息 / 缺 streamSessionId → 不处理（返回 false，不触碰服务）', async () => {
    const respond = vi.fn();
    expect(await handleCompactionRequestMsg({ type: 'text', content: 'hi' }, respond)).toBe(false);
    expect(await handleCompactionRequestMsg({ type: 'compaction:request', sessionId: 's', conversation: 'x' }, respond)).toBe(false);
    expect(generateCompactionMock).not.toHaveBeenCalled();
    expect(respond).not.toHaveBeenCalled();
  });
});

// ─── 子进程接收侧：compaction:result 分支 ────────────────────────────────────

describe('handleCompactionResultIpc（子进程结果消费）', () => {
  it('ok:false → reject（error 文本透传）', async () => {
    const p = requestCompaction('s-ipc-1', '对话', 1);
    const id = sentRequests[0]!.streamSessionId as string;
    handleCompactionResultIpc({ type: 'compaction:result', streamSessionId: id, ok: false, error: '压缩摘要生成为空，请重试' });
    await expect(p).rejects.toThrow('压缩摘要生成为空，请重试');
  });

  it('10s 超时 → reject（pending 清理，迟到结果不崩）', async () => {
    vi.useFakeTimers();
    const p = requestCompaction('s-ipc-1', '对话', 1);
    const id = sentRequests[0]!.streamSessionId as string;
    const assertion = expect(p).rejects.toThrow('超时');
    await vi.advanceTimersByTimeAsync(COMPACTION_REQUEST_TIMEOUT_MS);
    await assertion;
    // 超时后迟到的同 id 结果：静默忽略（pending 已删）
    expect(() =>
      handleCompactionResultIpc({ type: 'compaction:result', streamSessionId: id, ok: true, summary: '迟到' }),
    ).not.toThrow();
  });

  it('未知 streamSessionId 的结果 → 忽略不崩', () => {
    expect(() =>
      handleCompactionResultIpc({ type: 'compaction:result', streamSessionId: 'never-issued', ok: true, summary: 'x' }),
    ).not.toThrow();
  });

  it('非 compaction:result 消息 → 忽略', () => {
    expect(() => handleCompactionResultIpc({ type: 'task-reply', reply: {} })).not.toThrow();
    expect(() => handleCompactionResultIpc('not-an-object')).not.toThrow();
  });

  it('子进程无 IPC 通道（process.send 未建立）→ 立即 reject', async () => {
    process.send = undefined as unknown as NonNullable<typeof process.send>;
    await expect(requestCompaction('s', '对话', 1)).rejects.toThrow('IPC 通道');
  });
});
