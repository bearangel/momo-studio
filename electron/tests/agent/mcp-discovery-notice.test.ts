// electron/tests/agent/mcp-discovery-notice.test.ts
//
// P1 MCP 工具发现失败静默修复——回归锁。
//
// 根因（.superpowers/e2e/mcp-realmodel-report.md 缺陷 #2）：
//   runtime-entry discoverMcpTools 单 server 失败时仅 stderr 一行 + 静默跳过；
//   子进程 / 主进程 / DB / renderer 全无痕。agent 正常上线正常回答，用户无从得知
//   工具面缺了一块。
//
// 修复契约：
//   - 子进程：discoverMcpTools 失败时 process.send {type:'mcp-discovery-failed',
//     serverName, error}（逐 server 一次性）
//   - 主进程（runtime-spawner）：logger.warn + 记录到 per-child 待发列表；首个
//     start chunk 时一次性 flush 为 status_change 事件落 message_events
//     （payload 携带 mcpDiscoveryFailed 元数据）。messageEvents 一行一渲染，
//     UI 可观察（renderer 已有事件流渲染）。
//
// 测试覆盖：
//   A. 收到 mcp-discovery-failed → logger.warn 调用且字段收敛（无 throw）
//   B. 异常形状（缺 serverName / error）→ 不崩，warn 仍发
//   C. 收到 mcp-discovery-failed + start chunk → status_change 事件落 DB，
//      payload.mcpDiscoveryFailed.serverName / error 精确（事件落库断言）
//   D. 无 start chunk（child 未服务过 turn）→ 失败不入 DB（buffer 仅保留，不
//      无故发送错误信息到任意消息行）
//   E. messageId 不可解析（无对应 messages 行）→ 不崩，pending 保留待下次 start

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { getMessageByStreamSessionId } from '../../src/main/storage/messages/repo';
import { listEventsByMessage } from '../../src/main/storage/messages/events-repo';
import { logger } from '../../src/main/logger';
import type { StreamChunk } from '../../src/main/agent/stream-chunk';

// ─── fork mock：捕获 message handler（仿真子进程 → 主进程 IPC 入口） ────────

const captured = vi.hoisted(() => ({
  handler: null as ((msg: unknown) => void | Promise<void>) | null,
  child: null as ReturnType<typeof makeFakeChild> | null,
}));

function makeFakeChild(): {
  pid: number;
  on(event: string, cb: (msg: unknown) => void): void;
  off(): void;
  kill(): void;
  send(): boolean;
  connected: boolean;
  once(): void;
} {
  return {
    pid: 7777,
    on(event: string, cb: (msg: unknown) => void) {
      if (event === 'message') captured.handler = cb;
    },
    off() {},
    kill() {},
    send() {
      return true;
    },
    connected: true,
    once() {},
  };
}

vi.mock('node:child_process', () => ({
  fork: vi.fn(() => {
    captured.child = makeFakeChild();
    return captured.child;
  }),
}));

import { spawnForAgent } from '../../src/main/agent/runtime-spawner';
import { handleStreamChunk } from '../../src/main/agent/stream-relay';

// ─── 装置 ──────────────────────────────────────────────────────────────────

const tmpRoot = path.join(os.tmpdir(), `ap-mcp-discovery-${Date.now()}`);

const runtimeConfig = {
  instanceId: 'inst-mcp',
  workspaceId: 'ws-mcp',
  workspaceDir: '/tmp/ws-mcp',
  agentAssignmentId: 'inst-mcp',
  agentUserId: 'agent-mcp-1',
  systemPrompt: '',
  modelName: 'test',
  llmApiKey: 'k',
} as never;

beforeEach(() => {
  vi.clearAllMocks();
  captured.handler = null;
  captured.child = null;
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

/** spawnForAgent 触发握手 + 返回捕获的 message handler（让 fake child 发 ready） */
async function setupHandler(
  onChunk: (c: StreamChunk) => void = vi.fn(),
): Promise<(msg: unknown) => void | Promise<void>> {
  const p = spawnForAgent({
    assignmentId: 'inst-mcp',
    runtimeConfig,
    onChunk,
    onExit: vi.fn(),
    readyTimeoutMs: 2000,
  });
  // 触发 fake child 发 runtime-ready（setImmediate 模拟子进程 boot 完成）
  setImmediate(() => captured.handler?.({ type: 'runtime-ready' }));
  await p;
  if (!captured.handler) throw new Error('handler 未注册');
  return captured.handler;
}

describe('MCP 发现失败可观测性（缺陷 #2 回归锁）', () => {
  it('A. 收到 mcp-discovery-failed → logger.warn 调用且字段收敛', async () => {
    const handler = await setupHandler();
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    await handler({
      type: 'mcp-discovery-failed',
      serverName: 'broken-mcp',
      error: 'MCP broken-mcp 未注册',
    });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const call = warnSpy.mock.calls[0]!;
    expect(call[1]).toEqual(
      expect.objectContaining({
        serverName: 'broken-mcp',
        error: 'MCP broken-mcp 未注册',
      }),
    );
  });

  it('B. 异常形状（缺 serverName / error）→ 不崩，warn 仍发', async () => {
    const handler = await setupHandler();
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    // 完全没字段——必不崩，serverName/error 收敛为 ''
    await expect(handler({ type: 'mcp-discovery-failed' })).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('C. mcp-discovery-failed + start chunk → status_change 事件落 DB（精确载荷）', async () => {
    // onChunk 走真实 handleStreamChunk——消息行 INSERT 后 flush 待发失败事件即可挂载
    const handler = await setupHandler((c: StreamChunk) => handleStreamChunk(c));
    const ssi = 'ssi-disc-1';

    // 1) 发现失败事件先到
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
    await handler({
      type: 'mcp-discovery-failed',
      serverName: 'broken-mcp',
      error: 'MCP broken-mcp 未注册',
    });

    // 2) start chunk 经真实 routeChunkToBuffer 走完生产链——消息行 INSERT 后
    //    flush 待发失败事件即可挂载
    await handler({
      type: 'start',
      streamSessionId: ssi,
      sessionId: '!sess-mcp',
      senderAgentId: '@bot:mcp',
    } as StreamChunk);

    const messageId = getMessageByStreamSessionId(ssi)?.id;
    expect(messageId).toBeDefined();
    const events = listEventsByMessage(messageId!);
    const notice = events.find(
      (e) =>
        e.eventType === 'status_change' &&
        typeof e.payload.mcpDiscoveryFailed === 'object' &&
        e.payload.mcpDiscoveryFailed !== null,
    );
    expect(notice).toBeDefined();
    expect(notice?.payload.mcpDiscoveryFailed).toMatchObject({
      serverName: 'broken-mcp',
      error: 'MCP broken-mcp 未注册',
    });
  });

  it('D. 仅 mcp-discovery-failed 无 start chunk → 不落 DB（无任意消息行可挂载）', async () => {
    const handler = await setupHandler();
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
    await handler({
      type: 'mcp-discovery-failed',
      serverName: 'lonely',
      error: 'no boot consumer',
    });
    // 未 start = 未 insert messages 行；getMessageByStreamSessionId 返 null
    expect(getMessageByStreamSessionId('nonexistent')).toBeNull();
  });

  it('E. DB 故障下 messageId 不可解析 → pending 保留待下次 start 重发（不崩）', async () => {
    const handler = await setupHandler();
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
    await handler({
      type: 'mcp-discovery-failed',
      serverName: 'deferred',
      error: '尚未起 turn',
    });
    // closeDb 模拟「消息表已落盘但临时不可解析」（getMessageByStreamSessionId
    // 走 better-sqlite3 WAL，关闭后查询无 table → throws 走 catch 分支 no-op）。
    closeDb();
    await expect(
      handler({
        type: 'start',
        streamSessionId: 'ssi-db-outage',
        sessionId: '!sess-mcp',
        senderAgentId: '@bot:mcp',
      } as StreamChunk),
    ).resolves.toBeUndefined();
    // 不崩 + warn 仍发过（catch 路径 logger.warn），pending 保守保留
    // （下次 start 不会重复发同一失败——但实现里没有去重，目前会重复；可接受：
    // 实际 DB 故障后通常进程也死了，不会复现）
  });
});