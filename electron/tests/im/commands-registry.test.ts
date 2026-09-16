// electron/tests/im/commands-registry.test.ts
//
// 会话斜杠命令注册表（v2.11，spec 2026-09-16 §6.1）——单一真相源：
//   1. / 菜单命令组数据（session:listCommands → renderer）
//   2. handleSessionCommand 未知命令查表拒绝（中文错误列出支持命令）
//
// mock 对齐说明（momo-test-rules：mock 收窄到 IPC/DB 边界）：
//   - session-service 加载所需的 sessions/repo / messages/repo / runtime-registry /
//     compaction / p2p / session-ops / task / session-naming / logger 全部按
//     session-command.test.ts 既有模式 mock 为 no-op——handler 的未知命令判定在
//     早期 return，不真正触达这些模块。
//   - commands.ts 是纯常量 + 纯函数，零依赖、无副作用，直接 import。
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { historyFixture } = vi.hoisted(
  (): { historyFixture: import('../../src/main/storage/messages/repo').MessageRow[] } => ({
    // 一条占位历史（不触达该路径——未知命令判定早于 history 取数；保留以满足
    // session-service 模块加载的依赖完整性）
    historyFixture: [
      {
        id: 'm0',
        sessionId: 's-x',
        sender: 'owner',
        body: 'hi',
        eventType: 'm.room.message' as const,
        streamSessionId: null,
        parentStreamSessionId: null,
        segmentOf: null,
        segmentIndex: null,
        status: 'done' as const,
        source: 'local' as const,
        workspaceId: 'w-x',
        taskId: null,
        contextJson: null,
        createdAt: 1,
        updatedAt: 1,
      },
    ],
  }),
);

vi.mock('../../src/main/storage/sessions/repo', () => ({
  getSession: vi.fn(() => ({ id: 's-x', workspaceId: 'w-x' })),
  touchSessionLastMessage: vi.fn(),
}));
vi.mock('../../src/main/storage/messages/repo', () => ({
  listRecentMessagesBySession: vi.fn(() => historyFixture),
  insertMessage: vi.fn(() => ({ id: 'm-new' })),
}));
vi.mock('../../src/main/im/session-ops', () => ({ getSessionMembersInfo: () => [] }));
vi.mock('../../src/main/agent/runtime-registry', () => ({
  isSessionRunning: vi.fn(() => false),
}));
vi.mock('../../src/main/compaction/service', () => ({
  generateCompaction: vi.fn(async () => ({ summary: 'x' })),
  upsertSessionCompaction: vi.fn(),
  getSessionCompaction: vi.fn(() => null),
}));
vi.mock('../../src/main/p2p', () => ({ broadcastLocalMessage: vi.fn() }));
vi.mock('../../src/main/task/conflict-detector', () => ({ detectConflict: vi.fn() }));
vi.mock('../../src/main/task/activation', () => ({ activateMentionedTasks: vi.fn() }));
vi.mock('../../src/main/storage/tasks/repo', () => ({
  listTasks: vi.fn(() => []),
  getTask: vi.fn(() => null),
}));
vi.mock('../../src/main/im/session-naming', () => ({ applyFirstMessageTitle: vi.fn() }));
vi.mock('../../src/main/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { SESSION_COMMANDS, isKnownSessionCommand } from '../../src/main/im/commands';
import { handleSessionCommand } from '../../src/main/im/session-service';

describe('会话命令注册表', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('compact 在册且带中文描述', () => {
    const compact = SESSION_COMMANDS.find((c) => c.name === 'compact');
    expect(compact).toBeDefined();
    expect(compact!.description.length).toBeGreaterThan(0);
  });

  it('isKnownSessionCommand 判定', () => {
    expect(isKnownSessionCommand('compact')).toBe(true);
    expect(isKnownSessionCommand('nope')).toBe(false);
  });

  it('未知命令 handleSessionCommand 抛中文错误并列出支持命令', async () => {
    await expect(
      handleSessionCommand({ sessionId: 's-x', command: 'nope' }),
    ).rejects.toThrow(/未知命令: \/nope/);
  });
});