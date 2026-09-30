// electron/tests/agent/tools/session-tools.test.ts
//
// SessionTools.list_sessions / read_session 回归锁（spec 2026-09-30 §4.1/§4.2）：
//   list_sessions —— workspace 范围 / 排除当前会话 / 关键词过滤 / 消歧元信息。
//   read_session —— 范围门三连 / 最近 N 条 + 工具摘要（B 颗粒度）/ beforeTs 翻页 /
//     输出总量截断。
// 核心读路径真 SQLite；listMembers（显示名富化）mock 收窄到边界。
//
// seeding 偏离 brief：sessions.workspace_id 外键真实存在（REFERENCES workspaces
// + foreign_keys=ON），按 messages-repo.test.ts Task-1 套件先例补 seed workspaces 行。
// workspace id 用 randomUUID：每个 beforeEach 重建 DB 安全，但跨 it 用 fixed id 仍
// 脆；本次复现 brief 三例，每个 it 内分别 seed 独立 workspace id。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { runMigrations, closeDb, getDb } from '../../../src/main/storage/db';
import { insertSession, addSessionMember } from '../../../src/main/storage/sessions/repo';
import { insertMessage } from '../../../src/main/storage/messages/repo';
import { insertEventBatch } from '../../../src/main/storage/messages/events-repo';
import { OUTPUT_LIMITS } from '../../../src/main/agent/tools/shared/output-truncate';
import { SessionTools } from '../../../src/main/agent/tools/session-tools';
import type { ToolContext } from '../../../src/main/agent/tools/types';

vi.mock('../../../src/main/agent/crud', () => ({
  listMembers: () => [
    { instanceId: 'inst-coder', agentUserId: 'coder-1', agentName: 'Coder', iconEmoji: null },
    { instanceId: 'inst-writer', agentUserId: 'writer-1', agentName: 'Writer', iconEmoji: null },
  ],
}));

/** 建 workspace 行（sessions FK 兜底；NOT NULL 列全补），返回 id */
function seedWorkspace(): string {
  const id = `ws-${randomUUID()}`;
  getDb()
    .prepare(
      `INSERT INTO workspaces
         (id, name, description, directory_path, git_initialized, owner_id, icon_emoji,
          default_agent_instance_id)
       VALUES (?, 'WS', '', '/tmp', 0, '@owner:s', '📁', null)`,
    )
    .run(id);
  return id;
}

/** 建 agent_definition + workspace_agent_member 行（addSessionMember FK 兜底：
 *  session_members.instance_id → workspace_agent_members.instance_id →
 *  workspaces(id) / agent_definitions(id)）。仅 inst-coder 是被测断言消费的实例
 *  （addSessionMember(ref.id, 'inst-coder', true)）；其它实例（inst-writer）mock
 *  listMembers 返回，不入 DB。 */
function seedMemberInstance(workspaceId: string, instanceId: string, defId: string, agentUserId: string): void {
  getDb()
    .prepare(
      `INSERT INTO agent_definitions
         (id, name, slug, version, system_prompt, model_name, model_provider_id)
       VALUES (?, 'def', 'def', '1', '', 'm', NULL)`,
    )
    .run(defId);
  getDb()
    .prepare(
      `INSERT INTO workspace_agent_members
         (instance_id, workspace_id, agent_definition_id, agent_user_id, last_running)
       VALUES (?, ?, ?, ?, 1)`,
    )
    .run(instanceId, workspaceId, defId, agentUserId);
}

const tmpRoot = path.join(os.tmpdir(), `momo-sess-tools-${Date.now()}`);

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

const mkCtx = (workspaceId: string, roomId: string): ToolContext => ({
  wsFs: {} as never,
  workspaceId,
  workspaceDir: '/tmp/ws',
  skillRegistry: {} as never,
  streamSessionId: 'ss-1',
  roomId,
  sendStreamChunk: () => {},
  permissionConfig: { allowedTools: [], deniedTools: [] },
  creatorUserId: 'owner',
});

describe('list_sessions', () => {
  it('列出本 workspace 会话，排除当前会话，带成员名/消息数/预览', async () => {
    const wsA = seedWorkspace();
    const wsB = seedWorkspace();
    const cur = insertSession({ workspaceId: wsA, title: '当前会话' });
    const ref = insertSession({ workspaceId: wsA, title: '设计讨论' });
    insertSession({ workspaceId: wsB, title: '别家的会话' });
    seedMemberInstance(wsA, 'inst-coder', 'def-coder', 'coder-1');
    addSessionMember(ref.id, 'inst-coder', true);
    insertMessage({ sessionId: ref.id, sender: 'owner', eventType: 'm.room.message', body: '我们讨论一下重构方案' });

    const out = await new SessionTools().execute('list_sessions', {}, mkCtx(wsA, cur.id));

    expect(out).toContain('设计讨论');
    expect(out).toContain('Coder');
    expect(out).toContain('消息数=1');
    expect(out).toContain('我们讨论一下重构方案');
    expect(out).not.toContain('当前会话'); // 排除自身
    expect(out).not.toContain('别家的会话'); // workspace 范围门
    expect(out).toContain(ref.id); // id 必须出现（read_session 直达键）
  });

  it('keyword 标题子串过滤（大小写不敏感）', async () => {
    const wsA = seedWorkspace();
    insertSession({ workspaceId: wsA, title: 'Refactor Plan' });
    insertSession({ workspaceId: wsA, title: '闲聊' });
    const out = await new SessionTools().execute(
      'list_sessions',
      { keyword: 'refactor' },
      mkCtx(wsA, 'room-x'),
    );
    expect(out).toContain('Refactor Plan');
    expect(out).not.toContain('闲聊');
  });

  it('空会话与零命中', async () => {
    const wsA = seedWorkspace();
    const s = insertSession({ workspaceId: wsA, title: '空会话' });
    const out = await new SessionTools().execute('list_sessions', {}, mkCtx(wsA, 'room-x'));
    expect(out).toContain('空会话');
    expect(out).toContain('消息数=0');
    expect(out).toContain(s.id);
    const miss = await new SessionTools().execute(
      'list_sessions',
      { keyword: '不存在的关键词' },
      mkCtx(wsA, 'room-x'),
    );
    expect(miss).toContain('没有匹配的会话');
  });
});

describe('read_session', () => {
  it('范围门：不存在 / 跨 workspace / 读自己 → 明确文案，不做任何读取', async () => {
    const wsA = seedWorkspace();
    const wsB = seedWorkspace();
    const tools = new SessionTools();
    const out1 = await tools.execute('read_session', { sessionId: 'no-such' }, mkCtx(wsA, 'room-x'));
    expect(out1).toContain('会话不存在');
    const other = insertSession({ workspaceId: wsB, title: '别家' });
    const out2 = await tools.execute('read_session', { sessionId: other.id }, mkCtx(wsA, 'room-x'));
    expect(out2).toContain('不在当前 workspace');
    const cur = insertSession({ workspaceId: wsA, title: '自己' });
    const out3 = await tools.execute('read_session', { sessionId: cur.id }, mkCtx(wsA, cur.id));
    expect(out3).toContain('已在你的上下文中');
  });

  it('默认最近 N 条 + 工具调用摘要（正文行 + 🔧 缩进行）+ 翻页提示', async () => {
    const wsA = seedWorkspace();
    const s = insertSession({ workspaceId: wsA, title: '参考会话' });
    const userMsg = insertMessage({ sessionId: s.id, sender: 'owner', eventType: 'm.room.message', body: '帮我重构 X' });
    const agentMsg = insertMessage({ sessionId: s.id, sender: 'coder-1', eventType: 'm.room.message', body: '好的，完成重构' });
    insertEventBatch([
      { messageId: agentMsg.id, seq: 0, eventType: 'text_delta', payload: { delta: '好的' } },
      { messageId: agentMsg.id, seq: 1, eventType: 'tool_call_start', payload: { callId: 'c1', toolName: 'read_file', args: { path: 'src/x.ts' } } },
      { messageId: agentMsg.id, seq: 2, eventType: 'tool_call_result', payload: { callId: 'c1', toolName: 'read_file', result: 'export const a = 1;', success: true } },
    ]);
    void userMsg;

    const out = await new SessionTools().execute('read_session', { sessionId: s.id }, mkCtx(wsA, 'room-x'));

    expect(out).toContain('参考会话');
    expect(out).toContain('用户: 帮我重构 X');       // sender='owner' → 「用户」
    expect(out).toContain('Coder: 好的，完成重构');   // agentUserId → 显示名（mock listMembers）
    expect(out).toContain('🔧 read_file');
    expect(out).toContain('src/x.ts');
    expect(out).toContain('beforeTs=');              // 翻页提示带本页最早时间戳
    expect(out).not.toContain('截断');               // Ruling 1：未超限输出不得出现截断文案
  });

  it('beforeTs 向前翻页 + dispatch 段渲染', async () => {
    const wsA = seedWorkspace();
    const s = insertSession({ workspaceId: wsA, title: '分页会话' });
    const m1 = insertMessage({ sessionId: s.id, sender: 'owner', eventType: 'm.room.message', body: '第一条' });
    await new Promise((r) => setTimeout(r, 5)); // 保证 created_at 严格递增
    insertMessage({ sessionId: s.id, sender: 'owner', eventType: 'm.room.message', body: '第二条' });
    await new Promise((r) => setTimeout(r, 5));
    insertMessage({ sessionId: s.id, sender: 'owner', eventType: 'm.room.message', body: '第三条' });
    const boundary = m1.createdAt + 2; // 严格小于第二条、大于第一条的切点

    const out = await new SessionTools().execute(
      'read_session',
      { sessionId: s.id, beforeTs: boundary },
      mkCtx(wsA, 'room-x'),
    );
    expect(out).toContain('第一条');
    expect(out).not.toContain('第二条');
    expect(out).not.toContain('第三条');

    const d = insertSession({ workspaceId: wsA, title: 'dispatch 会话' });
    const lead = insertMessage({ sessionId: d.id, sender: 'pm-1', eventType: 'm.room.message', body: '派发' });
    insertEventBatch([
      { messageId: lead.id, seq: 0, eventType: 'tool_call_start', payload: { callId: 'c9', toolName: 'dispatch', args: { task: '写文档' }, isDispatch: true, subStreamSessionId: 'ss-sub', subAgentName: 'Writer' } },
      { messageId: lead.id, seq: 1, eventType: 'tool_call_result', payload: { callId: 'c9', toolName: 'dispatch', result: '', success: true, subStatus: 'completed' } },
    ]);
    const out2 = await new SessionTools().execute('read_session', { sessionId: d.id }, mkCtx(wsA, 'room-x'));
    expect(out2).toContain('📤 dispatch→Writer');
    expect(out2).toContain('写文档');
    expect(out2).toContain('completed');
  });

  it('空会话 → 元信息头 + 「会话无消息」', async () => {
    const wsA = seedWorkspace();
    const s = insertSession({ workspaceId: wsA, title: '空的' });
    const out = await new SessionTools().execute('read_session', { sessionId: s.id }, mkCtx(wsA, 'room-x'));
    expect(out).toContain('会话无消息');
  });

  it('输出总量截断（OUTPUT_LIMITS.read_session）', async () => {
    const wsA = seedWorkspace();
    const s = insertSession({ workspaceId: wsA, title: '长会话' });
    // Ruling 1 要求截断真实发生：brief 的 .repeat(50) 在默认 limit=50 下总量
    // ~28.8KB 够不到 30KB 上限（恒不截断）；放大到 repeat(100)（~56KB）保证超限。
    for (let i = 0; i < 200; i++) {
      insertMessage({ sessionId: s.id, sender: 'owner', eventType: 'm.room.message', body: `消息 ${i} `.repeat(100) });
    }
    const out = await new SessionTools().execute('read_session', { sessionId: s.id }, mkCtx(wsA, 'room-x'));
    // FIX-1：footer 改为截断后追加——总长 = 截断正文（上限 + ~30B 标记行）+ ~110B 双游标
    // footer，容差由 +100 放宽到 +300（字节上限对 .length 同样成立：CJK 1 unit ≤ 3 bytes）
    expect(out.length).toBeLessThanOrEqual(OUTPUT_LIMITS.read_session + 300);
    expect(out).toContain('截断');
    // FIX-1 核心回归锁：截断发生时翻页游标仍必须完整存活（footer 挤不丢）
    expect(out).toMatch(/beforeTs=\d+/);
    expect(out).toMatch(/afterTs=\d+/);
  });
});

// spec §8 明列的三个测试锁（终审 FIX-2）：limit 边界 / 未配对 tool_call_start / afterTs-only 翻页
describe('spec §8 锁：limit 边界 / 未配对 tool_call / afterTs 翻页', () => {
  it('list_sessions limit：数值 clamp 与非法值回落，均不抛错且行为确定', async () => {
    const wsA = seedWorkspace();
    const cur = insertSession({ workspaceId: wsA, title: '当前' });
    insertSession({ workspaceId: wsA, title: '会话甲' });
    await new Promise((r) => setTimeout(r, 5)); // created_at 严格递增保排序确定（ORDER BY ... DESC）
    insertSession({ workspaceId: wsA, title: '会话乙' });
    await new Promise((r) => setTimeout(r, 5));
    insertSession({ workspaceId: wsA, title: '会话丙' });
    const tools = new SessionTools();

    // limit=2 → 只列最近 2 个（丙乙）；甲（最旧）被截
    const out2 = await tools.execute('list_sessions', { limit: 2 }, mkCtx(wsA, cur.id));
    expect(out2).toContain('共 2 个会话');
    expect(out2).toContain('会话丙');
    expect(out2).not.toContain('会话甲');

    // limit=0 / 负数 → clamp 到 1（确定性回落，不抛错）
    const out0 = await tools.execute('list_sessions', { limit: 0 }, mkCtx(wsA, cur.id));
    expect(out0).toContain('共 1 个会话');
    const outNeg = await tools.execute('list_sessions', { limit: -3 }, mkCtx(wsA, cur.id));
    expect(outNeg).toContain('共 1 个会话');

    // 非数字（string / NaN）→ 回落默认 20 → 全列
    const outStr = await tools.execute('list_sessions', { limit: 'abc' }, mkCtx(wsA, cur.id));
    expect(outStr).toContain('共 3 个会话');
    const outNan = await tools.execute('list_sessions', { limit: Number.NaN }, mkCtx(wsA, cur.id));
    expect(outNan).toContain('共 3 个会话');
  });

  it('read_session limit：999 clamp 到上限 200 不抛错 / 0 → 1 条 / 非数字 → 默认 50', async () => {
    const wsA = seedWorkspace();
    const s = insertSession({ workspaceId: wsA, title: '限值会话' });
    for (const body of ['第一条', '第二条', '第三条']) {
      insertMessage({ sessionId: s.id, sender: 'owner', eventType: 'm.room.message', body });
      await new Promise((r) => setTimeout(r, 5));
    }
    const tools = new SessionTools();

    // limit=999 → clamp 上限 200；库存 3 → 返回条数 = min(请求 999, 上限 200, 库存 3)
    const outMax = await tools.execute('read_session', { sessionId: s.id, limit: 999 }, mkCtx(wsA, 'room-x'));
    expect(outMax).toContain('本页 3 条');
    expect(outMax).toContain('第三条');

    // limit=0 → clamp 到 1：只返回最新一条
    const outZero = await tools.execute('read_session', { sessionId: s.id, limit: 0 }, mkCtx(wsA, 'room-x'));
    expect(outZero).toContain('本页 1 条');
    expect(outZero).toContain('第三条');
    expect(outZero).not.toContain('第一条');

    // limit 非数字 → 默认 50 路径不抛错（库存 3 < 50 → 全返回）
    const outStr = await tools.execute('read_session', { sessionId: s.id, limit: 'abc' }, mkCtx(wsA, 'room-x'));
    expect(outStr).toContain('本页 3 条');
  });

  it('未配对 tool_call_start（无 result）→ 🔧 行 + 参数摘要 + … + (结果未回传)', async () => {
    const wsA = seedWorkspace();
    const s = insertSession({ workspaceId: wsA, title: '未回传会话' });
    const agentMsg = insertMessage({ sessionId: s.id, sender: 'coder-1', eventType: 'm.room.message', body: '调用中' });
    // 只挂 start、不挂 result 也不挂 final 事件——终态收敛仅在流终态后把 null 改写为
    // (未返回结果)/✗，此处锁「流进行中 / 事件缺失」时 result 与 success 双 null 的诚实渲染
    insertEventBatch([
      { messageId: agentMsg.id, seq: 0, eventType: 'tool_call_start', payload: { callId: 'c-unpaired', toolName: 'read_file', args: { path: 'src/y.ts' } } },
    ]);

    const out = await new SessionTools().execute('read_session', { sessionId: s.id }, mkCtx(wsA, 'room-x'));
    expect(out).toContain('🔧 read_file(');
    expect(out).toContain('src/y.ts');
    expect(out).toContain('…'); // FIX-3：success===null 用 …，不得伪装成功 ✓
    expect(out).toContain('(结果未回传)');
    expect(out).not.toContain('✓');
  });

  it('afterTs-only 向更新翻页：只含更新消息，footer 带 afterTs=<latest> 游标', async () => {
    const wsA = seedWorkspace();
    const s = insertSession({ workspaceId: wsA, title: '向后翻页会话' });
    const m1 = insertMessage({ sessionId: s.id, sender: 'owner', eventType: 'm.room.message', body: '第一条' });
    await new Promise((r) => setTimeout(r, 5));
    insertMessage({ sessionId: s.id, sender: 'owner', eventType: 'm.room.message', body: '第二条' });
    await new Promise((r) => setTimeout(r, 5));
    const m3 = insertMessage({ sessionId: s.id, sender: 'owner', eventType: 'm.room.message', body: '第三条' });

    const out = await new SessionTools().execute(
      'read_session',
      { sessionId: s.id, afterTs: m1.createdAt },
      mkCtx(wsA, 'room-x'),
    );
    expect(out).not.toContain('第一条');
    expect(out).toContain('第二条');
    expect(out).toContain('第三条');
    expect(out).toContain('本页 2 条');
    // FIX-1：footer 截断后追加——afterTs 游标必须指向本页最新一条
    expect(out).toContain(`afterTs=${m3.createdAt}`);
  });
});
