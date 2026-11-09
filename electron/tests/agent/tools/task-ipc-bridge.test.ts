// electron/tests/agent/tools/task-ipc-bridge.test.ts
//
// task-op 子进程桥单元（2026-11-09 agent 工作组路由面）：请求/应答往返 /
// 失败透传 / 超时清理 / 非 fork 环境 / 未知 requestId 容忍。process.send 按
// 真实语义 stub（方法调用形式、捕获载荷回放应答）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  handleTaskOpResult,
  requestCreateRouted,
  requestListWorkgroups,
  TASK_OP_BRIDGE_TIMEOUT_MS,
  type TaskWorkgroupsPayload,
} from '../../../src/main/agent/tools/task-ipc-bridge';

interface SendCapture {
  calls: Array<Record<string, unknown>>;
  reply(msg: unknown): void;
}

function stubProcessSend(): SendCapture {
  const calls: Array<Record<string, unknown>> = [];
  const proc = process as unknown as { send?: unknown };
  const original = proc.send;
  proc.send = (msg: Record<string, unknown>) => {
    calls.push(msg);
    return true;
  };
  return {
    calls,
    reply: (m) => handleTaskOpResult(m),
  };
}

function restoreProcessSend(original: unknown): void {
  const proc = process as unknown as { send?: unknown };
  if (original === undefined) delete proc.send;
  else proc.send = original;
}

let originalSend: unknown;

beforeEach(() => {
  originalSend = (process as unknown as { send?: unknown }).send;
});
afterEach(() => {
  restoreProcessSend(originalSend);
  vi.useRealTimers();
});

describe('task-ipc-bridge', () => {
  it('list_workgroups 往返：请求带 op/requestId → 应答 payload 原样 resolve', async () => {
    const cap = stubProcessSend();
    const payload: TaskWorkgroupsPayload = [
      { groupId: 'g-1', groupName: '研发组', mode: 'leader-follower', modeLabel: '主从模式', isLeader: true, members: [] },
    ];
    const p = requestListWorkgroups();
    await vi.waitFor(() => expect(cap.calls.length).toBe(1));
    const sent = cap.calls[0]!;
    expect(sent['type']).toBe('task-op');
    expect(sent['op']).toBe('list_workgroups');
    expect(typeof sent['requestId']).toBe('string');
    cap.reply({ type: 'task-op:result', requestId: sent['requestId'], ok: true, payload });
    await expect(p).resolves.toEqual(payload);
  });

  it('create_routed 失败透传：ok:false error 文本成 Error（LLM 可见人话）', async () => {
    const cap = stubProcessSend();
    const p = requestCreateRouted({
      workspaceId: 'ws1', title: 't', creatorUserId: 'u',
      routing: { mode: 'group', groupId: 'g-none' },
    });
    await vi.waitFor(() => expect(cap.calls.length).toBe(1));
    cap.reply({ type: 'task-op:result', requestId: cap.calls[0]!['requestId'], ok: false, error: '工作组 g-none 不存在——先调用 list_workgroups 获取真实组 ID' });
    await expect(p).rejects.toThrow('list_workgroups');
  });

  it('超时：到点清 pending 并 reject 中文文案（防泄漏——迟到结果安全 no-op）', async () => {
    vi.useFakeTimers();
    const cap = stubProcessSend();
    const p = requestListWorkgroups();
    const expectation = expect(p).rejects.toThrow('任务 IPC 无响应');
    await vi.advanceTimersByTimeAsync(TASK_OP_BRIDGE_TIMEOUT_MS + 10);
    await expectation;
    // 迟到应答：requestId 已清——静默忽略不崩
    expect(() => cap.reply({ type: 'task-op:result', requestId: cap.calls[0]!['requestId'], ok: true, payload: [] })).not.toThrow();
  });

  it('非 fork 环境（process.send 缺失）立即 reject，不挂等超时', async () => {
    const proc = process as unknown as { send?: unknown };
    delete proc.send;
    await expect(requestListWorkgroups()).rejects.toThrow('非 fork 子进程环境');
  });

  it('未知 requestId / 异形消息：静默忽略（不崩不误伤在途）', () => {
    expect(() => {
      handleTaskOpResult(null);
      handleTaskOpResult({ type: 'other' });
      handleTaskOpResult({ type: 'task-op:result', requestId: 'ghost', ok: true, payload: {} });
    }).not.toThrow();
  });
});
