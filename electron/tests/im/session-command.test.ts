// electron/tests/im/session-command.test.ts
//
// /compact 主进程链路单测（spec §4.5，压缩改造迁移后）：
//   - happy path：最近一轮排除在序列化外 → generateCompaction 收到头部序列化文本
//     → upsertSessionCompaction 写 session_compactions（covered_until=最后被覆盖消息
//     createdAt）+ 确认消息落库不路由
//   - 运行中回查拒绝 / 未知命令拒绝
//   - 错误路径专项（momo-test-rules 铁律 3）：会话不存在 / 空历史 / 仅有最近一轮
//     （头部为空）/ 服务失败透传（未配置模型服务、空摘要——CompactionService 抛出，
//     命令路径显式反馈）
//
// mock 对齐说明：
//   - compaction/service 模块 mock（generateCompaction / upsertSessionCompaction）——
//     LLM 与 DB 落库边界；serializeMessages 与 messageToContext 用真实实现（纯函数，
//     T2/P3-M7 各有独立单测）——序列化产物形状在本测试内被真实消费与断言
//   - broadcastLocalMessage 来自 '../p2p'（index 本体导出）
//   - sessions/repo mock 须含 touchSessionLastMessage；getSession 对 'busy' 也返回会话行
//   - 冲突检测 / #T 激活 / 命名 / tasks repo / logger 按模块路径 mock 为 no-op
import { describe, it, expect, beforeEach, vi } from 'vitest';

// vi.hoisted：vi.mock 工厂先于 import 执行，夹具须经 hoisted 提升后才对工厂可见。
const { historyFixture } = vi.hoisted((): { historyFixture: import('../../src/main/storage/messages/repo').MessageRow[] } => ({
  // 默认 3 条历史：[agent, owner, agent]——最后一条 user 在 index 1，
  // 头部 = [m0]（agent），覆盖游标 = m0.createdAt = 1000
  historyFixture: Array.from({ length: 3 }, (_, i) => ({
    id: `m${i}`,
    sessionId: 's1',
    sender: i % 2 ? 'owner' : 'agent-x',
    body: `消息${i}`,
    eventType: 'm.room.message' as const,
    streamSessionId: null,
    parentStreamSessionId: null,
    segmentOf: null,
    segmentIndex: null,
    status: 'done' as const,
    source: 'local' as const,
    workspaceId: 'w1',
    taskId: null,
    createdAt: 1000 + i,
    updatedAt: 1000 + i,
  })),
}));

vi.mock('../../src/main/storage/sessions/repo', () => ({
  // 'missing' → null（会话不存在用例）；其余 id 一律返回会话行（含 'busy'——
  // 运行中拒绝用例须先通过存在性检查才能命中 isSessionRunning 分支）
  getSession: vi.fn((id: string) => (id === 'missing' ? null : { id, workspaceId: 'w1' })),
  touchSessionLastMessage: vi.fn(),
}));
vi.mock('../../src/main/storage/messages/repo', () => ({
  // 窗口方向回归锁（审查 Important）：/compact 必须走 listRecentMessagesBySession
  // （DESC 取最近 N 条后反转）——listMessagesBySession 是 ASC+LIMIT=最早 1000 条，
  // >1000 消息会话 slice(-200) 会取到第 801-1000 条（repo.ts 文档明示的同型陷阱）
  listRecentMessagesBySession: vi.fn(() => historyFixture),
  insertMessage: vi.fn((m: { body: string }) => ({ ...m, id: 'm-new' })),
}));
vi.mock('../../src/main/im/session-ops', () => ({ getSessionMembersInfo: () => [] }));
vi.mock('../../src/main/agent/runtime-registry', () => ({
  isSessionRunning: vi.fn((id: string) => id === 'busy'),
}));
vi.mock('../../src/main/compaction/service', () => ({
  generateCompaction: vi.fn(async () => ({ summary: '测试摘要' })),
  upsertSessionCompaction: vi.fn(),
  getSessionCompaction: vi.fn(() => null),
}));
vi.mock('../../src/main/p2p', () => ({ broadcastLocalMessage: vi.fn() }));
// 其余 session-service 依赖（冲突检测 / #T 激活 / 命名 / tasks repo / logger）按模块路径 mock 为 no-op
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

import { handleSessionCommand } from '../../src/main/im/session-service';
import {
  generateCompaction,
  upsertSessionCompaction,
} from '../../src/main/compaction/service';
import { insertMessage, listRecentMessagesBySession } from '../../src/main/storage/messages/repo';

describe('handleSessionCommand(compact)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('happy path：最近一轮排除 → 头部序列化进 generateCompaction → 写 session_compactions + 确认消息落库（不路由）', async () => {
    const r = await handleSessionCommand({ sessionId: 's1', command: 'compact' });
    expect(r.ok).toBe(true);
    // 取数契约：最近 COMPACT_WINDOW=200 条（DESC 取数语义，非最早 N 条切片）
    expect(listRecentMessagesBySession).toHaveBeenCalledWith('s1', 200);
    // 头部 = m0（agent 消息，经 messageToContext 映射 assistant + serializeMessages 风格拉平）
    expect(generateCompaction).toHaveBeenCalledWith({
      sessionId: 's1',
      conversation: '[助手]: 消息0',
    });
    // covered_until = 最后一条被覆盖消息（头部末条 m0）的 createdAt
    expect(upsertSessionCompaction).toHaveBeenCalledWith('s1', '测试摘要', 1000);
    // ack 字段回归锁（审查 Minor）：eventType / workspaceId 是 renderer 渲染与
    // workspace 归属的依赖字段，防漂移
    expect(insertMessage).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 's1',
      body: expect.stringContaining('[系统] 会话已压缩'),
      eventType: 'm.room.message' as const,
      workspaceId: 'w1',
    }));
  });

  it('运行中回查拒绝', async () => {
    await expect(handleSessionCommand({ sessionId: 'busy', command: 'compact' }))
      .rejects.toThrow('正在执行中');
  });

  it('未知命令拒绝', async () => {
    await expect(handleSessionCommand({ sessionId: 's1', command: 'wat' }))
      .rejects.toThrow('未知命令');
  });
});

// 错误路径专项（momo-test-rules 铁律 3）：显式命令显式反馈——失败必须 throw
// 中文 message（renderer invoke 捕获后直接展示，与 extraction 静默语义刻意相反）。
// 未配置模型 / 空摘要由 CompactionService 抛出，命令路径透传——两个经典失败
// 以 service reject 形态锁定传播链不断。
describe('handleSessionCommand 错误路径', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('会话不存在 → throw（含 sessionId）', async () => {
    await expect(handleSessionCommand({ sessionId: 'missing', command: 'compact' }))
      .rejects.toThrow('会话不存在: missing');
  });

  it('空历史（无消息）→ throw「无内容可压缩」', async () => {
    vi.mocked(listRecentMessagesBySession).mockReturnValueOnce([]);
    await expect(handleSessionCommand({ sessionId: 's1', command: 'compact' }))
      .rejects.toThrow('无内容可压缩');
  });

  it('仅有最近一轮（首条即 user 消息，头部为空）→ throw「无更早历史」', async () => {
    vi.mocked(listRecentMessagesBySession).mockReturnValueOnce([
      { ...historyFixture[1]!, createdAt: 1000 },
      { ...historyFixture[2]!, createdAt: 2000 },
    ]);
    await expect(handleSessionCommand({ sessionId: 's1', command: 'compact' }))
      .rejects.toThrow('无更早历史可压缩');
    expect(generateCompaction).not.toHaveBeenCalled();
    expect(upsertSessionCompaction).not.toHaveBeenCalled();
  });

  it('未配置可用模型 → service throw 透传（提示设置入口）', async () => {
    vi.mocked(generateCompaction).mockRejectedValueOnce(
      new Error('未配置可用模型服务（设置 → 模型服务），无法生成压缩摘要'),
    );
    await expect(handleSessionCommand({ sessionId: 's1', command: 'compact' }))
      .rejects.toThrow('未配置可用模型服务');
    // 失败不落库
    expect(upsertSessionCompaction).not.toHaveBeenCalled();
  });

  it('摘要生成为空 → service throw 透传「请重试」', async () => {
    vi.mocked(generateCompaction).mockRejectedValueOnce(new Error('压缩摘要生成为空，请重试'));
    await expect(handleSessionCommand({ sessionId: 's1', command: 'compact' }))
      .rejects.toThrow('压缩摘要生成为空');
    expect(upsertSessionCompaction).not.toHaveBeenCalled();
  });
});
