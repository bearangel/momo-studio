// electron/tests/im/session-command.test.ts
//
// /compact 主进程链路单测（spec §5.4）：全 mock 外部依赖，不落真库。
// 覆盖 handleSessionCommand：happy path（摘要 upsert + 确认消息落库不路由）、
// 运行中回查拒绝、未知命令拒绝；另按 momo-test-rules 铁律 3 补错误路径专项用例
// （会话不存在 / 空历史 / LLM 未配置 / 空摘要——实现的全部 throw 分支逐一对齐）。
//
// mock 对齐说明（brief Step 1 清单按 session-service 实际 import 逐一校正）：
//   - broadcastLocalMessage 来自 '../p2p'（index 本体导出）而非 '../p2p/sync'
//   - sessions/repo mock 须含 touchSessionLastMessage（handleSessionCommand 调用）
//   - getSession 对 'busy' 也须返回会话行，否则运行中用例先命中「会话不存在」
//   - 冲突检测 / #T 激活 / 命名 / tasks repo / logger 按模块路径 mock 为 no-op
import { describe, it, expect, beforeEach, vi } from 'vitest';

// vi.hoisted：vi.mock 工厂先于 import 执行，夹具须经 hoisted 提升后才对工厂可见。
const { historyFixture, makeLlm } = vi.hoisted(() => ({
  // 默认 3 条历史（happy path / 未知命令 / 错误路径共用）；owner/agent 交错覆盖 transcript 映射
  historyFixture: Array.from({ length: 3 }, (_, i) => ({
    id: `m${i}`,
    sessionId: 's1',
    sender: i % 2 ? 'owner' : 'agent-x',
    body: `消息${i}`,
    eventType: 'm.room.message',
    createdAt: 1000 + i,
  })),
  // LLMProvider 形状完整的假 provider（chat/chatStream 字段齐全，供 mockResolvedValueOnce 类型对齐）
  makeLlm: (content: string) => ({
    chat: async () => ({ content, toolCalls: [], finishReason: 'stop' as const }),
    chatStream: async function* () {
      yield { type: 'done' as const, finishReason: 'stop' as const };
    },
  }),
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
vi.mock('../../src/main/memory/extraction', () => ({
  resolveSessionLlm: vi.fn(async () =>
    makeLlm('【用户指令】无\n【agent 备忘】测试摘要'),
  ),
  upsertSessionSummary: vi.fn(),
  scheduleExtraction: vi.fn(),
  TRIGGER_TURN_INTERVAL: 20,
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
import { upsertSessionSummary, resolveSessionLlm } from '../../src/main/memory/extraction';
import { insertMessage, listRecentMessagesBySession } from '../../src/main/storage/messages/repo';

describe('handleSessionCommand(compact)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('happy path：摘要 upsert + 确认消息落库（不路由）', async () => {
    const r = await handleSessionCommand({ sessionId: 's1', command: 'compact' });
    expect(r.ok).toBe(true);
    // 取数契约：最近 COMPACT_WINDOW=200 条（DESC 取数语义，非最早 N 条切片）
    expect(listRecentMessagesBySession).toHaveBeenCalledWith('s1', 200);
    expect(upsertSessionSummary).toHaveBeenCalledWith('s1', expect.stringContaining('测试摘要'), expect.any(Number));
    // ack 字段回归锁（审查 Minor）：eventType / workspaceId 是 renderer 渲染与
    // workspace 归属的依赖字段，防漂移
    expect(insertMessage).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 's1',
      body: expect.stringContaining('[系统] 会话已压缩'),
      eventType: 'm.room.message',
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

  it('未配置可用模型 → throw（提示设置入口）', async () => {
    vi.mocked(resolveSessionLlm).mockResolvedValueOnce(null);
    await expect(handleSessionCommand({ sessionId: 's1', command: 'compact' }))
      .rejects.toThrow('未配置可用模型服务');
  });

  it('摘要生成为空 → throw「请重试」', async () => {
    vi.mocked(resolveSessionLlm).mockResolvedValueOnce(makeLlm('   '));
    await expect(handleSessionCommand({ sessionId: 's1', command: 'compact' }))
      .rejects.toThrow('压缩摘要生成为空');
  });
});
