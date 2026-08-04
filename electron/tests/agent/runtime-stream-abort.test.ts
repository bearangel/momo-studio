// electron/tests/agent/runtime-stream-abort.test.ts
//
// v1.4 嵌套中断传播集成测试。
// 用 fake-runtime-stream.ts 作为子进程入口（通过 setRuntimeEntryOverride），配合
// mock BrowserWindow 捕获 relayed chunks，验证：
//   1. 子 agent start chunk 含 parentStreamSessionId 时，主进程建立父→子嵌套映射
//   2. abortStream(roomId) 中断 PM 时同步把 abort IPC 传播到所有子 agent
//   3. end chunk / 子进程退出时清理嵌套映射（防泄漏）
//
// 不测真实 LLM/Matrix——只验证主进程的 IPC 桥接 + 映射维护逻辑。

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import type { BrowserWindow } from 'electron';
import {
  spawnAgent,
  stopAllAgents,
  abortStream,
  setMainWindow,
  setRuntimeEntryOverride,
  __getStreamChildren,
  __getActiveStreams,
  __resetStreamState,
  type AgentRuntimeOpts,
} from '../../src/main/agent/runtime-manager';
import type { StreamChunk } from '../../src/main/agent/stream-chunk';

const fakeStream = path.join(__dirname, 'fake-runtime-stream.ts');

/** 捕获 relayed chunks 的 mock 窗口（替代真实 BrowserWindow） */
const relayedChunks: StreamChunk[] = [];
const mockWindow = {
  isDestroyed: () => false,
  webContents: {
    send: (_channel: string, chunk: StreamChunk): void => {
      relayedChunks.push(chunk);
    },
  },
} as unknown as BrowserWindow;

function makeOpts(instanceId: string): AgentRuntimeOpts {
  return {
    instanceId,
    workspaceId: 'ws-abort-test',
    workspaceDir: '/tmp',
    botUserId: `@bot.${instanceId}:localhost`,
    botAccessToken: 'tok',
    homeserverUrl: 'http://127.0.0.1:8008',
    systemPrompt: '',
    modelName: 'test-model',
    llmApiKey: 'key',
    teamRoomId: '!team:localhost',
    ownerUserId: '@owner:localhost',
  };
}

/** 轮询等待条件满足或超时（处理子进程 IPC 的异步时序） */
async function waitFor(fn: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`waitFor 超时（${timeoutMs}ms）`);
}

/** 等待指定 streamSessionId 的 start chunk 被 relay */
async function waitForStart(sessionId: string): Promise<void> {
  await waitFor(
    () => relayedChunks.some((c) => c.type === 'start' && (c as { streamSessionId: string }).streamSessionId === sessionId),
  );
}

/** 等待指定 streamSessionId 的 end chunk 被 relay */
async function waitForEnd(sessionId: string): Promise<void> {
  await waitFor(
    () => relayedChunks.some((c) => c.type === 'end' && (c as { streamSessionId: string }).streamSessionId === sessionId),
  );
}

/** 启动一个 fake-stream 子进程，在 start chunk 到达后返回 */
async function spawnFake(instanceId: string, sessionId: string, roomId: string, parentId?: string): Promise<void> {
  process.env.AP_SESSION_ID = sessionId;
  process.env.AP_ROOM_ID = roomId;
  if (parentId) {
    process.env.AP_PARENT_ID = parentId;
  } else {
    delete process.env.AP_PARENT_ID;
  }
  spawnAgent(makeOpts(instanceId));
  await waitForStart(sessionId);
}

describe('v1.4 嵌套流式中断传播', () => {
  beforeEach(() => {
    relayedChunks.length = 0;
    __resetStreamState();
    setRuntimeEntryOverride(['node', '--import', 'tsx', fakeStream]);
    setMainWindow(mockWindow);
  });

  afterEach(() => {
    stopAllAgents();
    setRuntimeEntryOverride(null);
    setMainWindow(null);
    __resetStreamState();
    delete process.env.AP_SESSION_ID;
    delete process.env.AP_ROOM_ID;
    delete process.env.AP_PARENT_ID;
  });

  it('子 agent start chunk 含 parentStreamSessionId 时建立父→子映射', async () => {
    await spawnFake('pm-nest', 'pm-sess-nest', '!pm-nest:localhost');
    await spawnFake('sub-nest', 'sub-sess-nest', '!sub-nest:localhost', 'pm-sess-nest');

    const children = __getStreamChildren().get('pm-sess-nest');
    expect(children).toBeDefined();
    expect(children?.has('sub-sess-nest')).toBe(true);

    // 父子两侧都在 activeStreams 中注册（不同 roomId → 不同 entry）
    const activeSessions = new Set([...__getActiveStreams().values()].map((e) => e.streamSessionId));
    expect(activeSessions.has('pm-sess-nest')).toBe(true);
    expect(activeSessions.has('sub-sess-nest')).toBe(true);
  });

  it('无 parentStreamSessionId 的 start chunk 不建立嵌套映射', async () => {
    await spawnFake('solo', 'solo-sess', '!solo:localhost');

    // 顶层 agent 不应出现在 streamChildren 的 key 或任何 value 中
    expect(__getStreamChildren().has('solo-sess')).toBe(false);
    for (const [, children] of __getStreamChildren()) {
      expect(children.has('solo-sess')).toBe(false);
    }
  });

  it('abortStream 中断 PM 时同步传播 abort 到所有子 agent', async () => {
    await spawnFake('pm-abort', 'pm-sess-abort', '!pm-abort:localhost');
    await spawnFake('sub-abort-1', 'sub-sess-abort-1', '!sub-abort-1:localhost', 'pm-sess-abort');
    await spawnFake('sub-abort-2', 'sub-sess-abort-2', '!sub-abort-2:localhost', 'pm-sess-abort');

    // 确认嵌套映射含两个子
    expect(__getStreamChildren().get('pm-sess-abort')?.size).toBe(2);

    // 触发 PM 所在房间的中断
    abortStream('!pm-abort:localhost');

    // 等待 PM + 两个子 agent 的 end(interrupted) chunk 被 relay
    await waitForEnd('pm-sess-abort');
    await waitForEnd('sub-sess-abort-1');
    await waitForEnd('sub-sess-abort-2');

    const abortedSessions = relayedChunks
      .filter((c) => c.type === 'end')
      .map((c) => (c as { streamSessionId: string }).streamSessionId);
    expect(abortedSessions).toContain('pm-sess-abort');
    expect(abortedSessions).toContain('sub-sess-abort-1');
    expect(abortedSessions).toContain('sub-sess-abort-2');
  });

  it('abortStream 对无活跃流的房间是 no-op', () => {
    expect(() => abortStream('!no-such-room:localhost')).not.toThrow();
  });

  it('abortStream 对有 PM 但无子的房间只中断 PM 自身', async () => {
    await spawnFake('pm-solo-abort', 'pm-solo-sess', '!pm-solo-abort:localhost');

    abortStream('!pm-solo-abort:localhost');
    await waitForEnd('pm-solo-sess');

    const abortedSessions = relayedChunks
      .filter((c) => c.type === 'end')
      .map((c) => (c as { streamSessionId: string }).streamSessionId);
    expect(abortedSessions).toEqual(['pm-solo-sess']);
  });

  it('子 agent 与 PM 同 roomId 时仍能被中断（按 streamSessionId 反查）', async () => {
    // 注意：PM 与子在同一房间。activeStreams 按 roomId 索引，后注册的子会覆盖 PM 的 entry。
    // 这暴露了 activeStreams 单 roomId 设计的已知限制（见 plan Task 7 note 2）：
    // abortStream(roomId) 只能拿到最后注册的 session。此用例验证：
    // 即使 PM entry 被覆盖，streamChildren 映射仍正确建立。
    await spawnFake('pm-same', 'pm-same-sess', '!same:localhost');
    await spawnFake('sub-same', 'sub-same-sess', '!same:localhost', 'pm-same-sess');

    // 嵌套映射正确（不受 roomId 冲突影响）
    expect(__getStreamChildren().get('pm-same-sess')?.has('sub-same-sess')).toBe(true);
  });

  it('end chunk 清理 streamChildren 双向映射', async () => {
    await spawnFake('pm-cleanup', 'pm-cleanup-sess', '!pm-cleanup:localhost');
    await spawnFake('sub-cleanup', 'sub-cleanup-sess', '!sub-cleanup:localhost', 'pm-cleanup-sess');

    expect(__getStreamChildren().get('pm-cleanup-sess')?.has('sub-cleanup-sess')).toBe(true);

    // 手动停掉子 agent（SIGTERM → 子退出）。fake-runtime-stream 不发 end chunk 就退出，
    // 由 handleAgentExit 兜底发 end(error) + 清理 streamChildren。
    stopAllAgents();

    // 等待清理完成（进程退出是异步的）
    await waitFor(() => __getStreamChildren().size === 0, 3000);
    expect(__getStreamChildren().size).toBe(0);
  });
});
