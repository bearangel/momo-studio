// electron/tests/memory/conversation-shrink.test.ts
//
// getConversationContext 历史收缩 + 摘要注入 + prune（压缩改造 Task 4，spec §5/§8）。
// 行为契约：
//   ① 收缩：存在 session_compactions 行时，消息查询加 WHERE created_at > covered_until
//      （严格大于——covered_until 对应消息算已覆盖不重拉）；无行 → 现行为完全不变
//   ② 注入：存在 compaction 行时，返回 messages 头部插
//      { role: 'user', content: '[此前对话压缩摘要]\n' + summary }
//      （opencode summary-as-context 形态；不并入 system，不动 pinnedMem 链）
//   ③ prune：除「最后一条 user 消息所在回合」（含其后全部）外，工具结果文本
//      >2000 字符截断为前 2000 + '\n[truncated]'——纯拉取时变换，零持久化
//
// 保真度约定（momo-test-rules）：
//   - DB 全真实（AP_USER_DATA_DIR + runMigrations + closeDb，沿 compaction/service.test.ts 模式）
//   - session_compactions 用真实生产者 upsertSessionCompaction 写入（生产→消费契约，
//     不手造中间数据）
//   - created_at 用 UPDATE 精确控制（insertMessage 固定 Date.now()、外部传入值被忽略——
//     既有 sqlite-provider.test.ts 注释已注明），保证 covered_until 边界判定确定性
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { insertSession } from '../../src/main/storage/sessions/repo';
import {
  insertMessage,
  getMessage,
  type MessageRow,
} from '../../src/main/storage/messages/repo';
import { upsertSessionCompaction } from '../../src/main/compaction/service';
import { SQLiteMemoryProvider } from '../../src/main/memory/sqlite-provider';

const tmpRoot = path.join(os.tmpdir(), `ap-mem-shrink-${Date.now()}-${Math.random().toString(36).slice(2)}`);

const WORKSPACE_ID = 'ws-shrink';
/** beforeEach 内重建（insertSession 生成随机 id，测试统一引用本变量） */
let SESSION_ID = '';

function seedWorkspace(): void {
  getDb().prepare(
    `INSERT INTO workspaces (id, name, description, directory_path, git_initialized, owner_id, icon_emoji, default_agent_instance_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
  ).run(WORKSPACE_ID, 'WS', '', '/tmp', 0, '@owner:s', '📁');
}

/**
 * 播种一组消息并以固定步长（1000ms）重写 created_at，返回重写后的真实行。
 * 时间戳确定性是 covered_until 严格大于边界判定的前提（见文件头保真度说明）。
 */
function seedMessages(
  specs: Array<{ sender: string; body: string; eventType?: string }>,
): MessageRow[] {
  const inserted = specs.map((s) =>
    insertMessage({
      sessionId: SESSION_ID,
      sender: s.sender,
      eventType: s.eventType ?? 'm.room.message',
      body: s.body,
    }),
  );
  const base = Date.now() - inserted.length * 1000;
  const fixTs = getDb().prepare('UPDATE messages SET created_at = ? WHERE id = ?');
  inserted.forEach((m, i) => fixTs.run(base + i * 1000, m.id));
  return inserted.map((m) => getMessage(m.id)!);
}

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  seedWorkspace();
  SESSION_ID = insertSession({ workspaceId: WORKSPACE_ID, title: 'T', titleAuto: true, kind: 'chat' }).id;
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

/** 12 条消息的标准播种：owner/agent 交替，body 可识别序号 */
function seedTwelve(): MessageRow[] {
  return seedMessages(
    Array.from({ length: 12 }, (_, i) => ({
      sender: i % 2 === 0 ? 'owner' : 'agent-coder-a1b2c3',
      body: `m${i + 1}`,
    })),
  );
}

// ─── ① 收缩 + ② 注入（spec §5） ─────────────────────────────────────────────

describe('历史收缩 + 摘要注入（spec §5）', () => {
  const provider = new SQLiteMemoryProvider();

  it('有 compaction 行（covered_until=第 8 条 createdAt）→ 返回 [摘要注入条, 第 9..12 条]；第 8 条算已覆盖不重拉', async () => {
    const rows = seedTwelve();
    upsertSessionCompaction(SESSION_ID, '结构化摘要内容', rows[7]!.createdAt);

    const ctx = await provider.getConversationContext(SESSION_ID);
    // 注入条 + 第 9..12 条 = 5 条
    expect(ctx.messages).toHaveLength(5);
    // 注入条形状锁：role=user，content 前缀精确（'[此前对话压缩摘要]\n' + summary 全文）
    expect(ctx.messages[0]!.role).toBe('user');
    expect(ctx.messages[0]!.content).toBe('[此前对话压缩摘要]\n结构化摘要内容');
    // 严格大于：m9..m12 原序返回，m8（covered_until 对应）不在其中
    expect(ctx.messages.slice(1).map((m) => m.content)).toEqual(['m9', 'm10', 'm11', 'm12']);
  });

  it('无 compaction 行 → 12 条全返回原序，无注入（现行为完全不变）', async () => {
    seedTwelve();

    const ctx = await provider.getConversationContext(SESSION_ID);
    expect(ctx.messages).toHaveLength(12);
    expect(ctx.messages.map((m) => m.content)).toEqual(
      Array.from({ length: 12 }, (_, i) => `m${i + 1}`),
    );
    // 无注入：首条是真实首条消息（sender/role 走既有启发式）
    expect(ctx.messages[0]).toMatchObject({ role: 'user', sender: 'owner', content: 'm1' });
  });

  it('covered_until 晚于全部消息 → 仅返回注入条（全被覆盖）', async () => {
    const rows = seedTwelve();
    upsertSessionCompaction(SESSION_ID, '全覆盖摘要', rows[11]!.createdAt + 10_000);

    const ctx = await provider.getConversationContext(SESSION_ID);
    expect(ctx.messages).toHaveLength(1);
    expect(ctx.messages[0]!.content).toBe('[此前对话压缩摘要]\n全覆盖摘要');
  });

  it('收缩 + limit 组合：limit 作用于过滤后集合（covered 之后的最早 N 条）', async () => {
    const rows = seedTwelve();
    upsertSessionCompaction(SESSION_ID, '摘要', rows[7]!.createdAt);

    const ctx = await provider.getConversationContext(SESSION_ID, { limit: 2 });
    // 注入条不计入 limit（limit 语义沿 listMessagesBySession 原样下推 SQL）
    expect(ctx.messages).toHaveLength(3);
    expect(ctx.messages.map((m) => m.content)).toEqual(['[此前对话压缩摘要]\n摘要', 'm9', 'm10']);
  });

  it('收缩 + beforeTs 组合：afterTs / beforeTs 同时生效', async () => {
    const rows = seedTwelve();
    upsertSessionCompaction(SESSION_ID, '摘要', rows[7]!.createdAt);

    const ctx = await provider.getConversationContext(SESSION_ID, {
      limit: 10,
      beforeTs: rows[10]!.createdAt,
    });
    expect(ctx.messages.map((m) => m.content)).toEqual(['[此前对话压缩摘要]\n摘要', 'm9', 'm10']);
  });

  it('零持久化（收缩侧）：拉取不写回 messages / session_compactions 不被改动', async () => {
    const rows = seedTwelve();
    upsertSessionCompaction(SESSION_ID, '摘要', rows[7]!.createdAt);

    await provider.getConversationContext(SESSION_ID);
    // 消息行原样（m8 仍在 DB，只是不再拉取）
    expect(getMessage(rows[7]!.id)?.body).toBe('m8');
    const row = getDb()
      .prepare('SELECT summary, covered_until FROM session_compactions WHERE session_id = ?')
      .get(SESSION_ID) as { summary: string; covered_until: number };
    expect(row).toEqual({ summary: '摘要', covered_until: rows[7]!.createdAt });
  });
});

// ─── ③ prune 微压缩（spec §8） ───────────────────────────────────────────────

describe('prune 微压缩（spec §8）', () => {
  const provider = new SQLiteMemoryProvider();

  it('旧轮次 3000 字工具结果 → 前 2000 + \\n[truncated]；最后 user 回合的工具结果不截断', async () => {
    const longTool = 'T'.repeat(3000);
    const exactTool = 'E'.repeat(2000);
    seedMessages([
      { sender: 'owner', body: '帮我查一下' }, // m1 user（旧轮次）
      { sender: 'agent-coder-a1b2c3', body: longTool, eventType: 'tool_call_result' }, // m2 旧轮次工具结果 → 截断
      { sender: 'agent-coder-a1b2c3', body: 'X'.repeat(3000) }, // m3 旧轮次非工具长消息 → 不截
      { sender: 'agent-coder-a1b2c3', body: exactTool, eventType: 'tool_call_result' }, // m4 恰好 2000 → 不截（>2000 才截）
      { sender: 'owner', body: '继续' }, // m5 最后一条 user
      { sender: 'agent-coder-a1b2c3', body: longTool, eventType: 'tool_call_result' }, // m6 最后 user 回合 → 不截
    ]);

    const ctx = await provider.getConversationContext(SESSION_ID);
    const [m2, m3, m4, m6] = [ctx.messages[1]!, ctx.messages[2]!, ctx.messages[3]!, ctx.messages[5]!];
    // m2：前 2000 + 标记（总长 2000 + 1 换行 + 11 字符标记）
    expect(m2.content).toBe('T'.repeat(2000) + '\n[truncated]');
    expect(m2.content.length).toBe(2012);
    // m3：非工具结果（eventType=m.room.message）不截断
    expect(m3.content).toBe('X'.repeat(3000));
    // m4：恰好 2000 不截断（严格大于才截）
    expect(m4.content).toBe('E'.repeat(2000));
    // m6：最后 user 回合内的工具结果 verbatim
    expect(m6.content).toBe(longTool);
  });

  it('2001 字工具结果（旧轮次）→ 截断（上边界）', async () => {
    seedMessages([
      { sender: 'owner', body: 'q' },
      { sender: 'agent-coder-a1b2c3', body: 'Y'.repeat(2001), eventType: 'tool_call_result' },
      { sender: 'owner', body: 'next' },
    ]);

    const ctx = await provider.getConversationContext(SESSION_ID);
    expect(ctx.messages[1]!.content).toBe('Y'.repeat(2000) + '\n[truncated]');
  });

  it('无 user 消息：全部视为旧轮次（工具结果照截，与 /compact 头部切分语义一致）', async () => {
    seedMessages([
      { sender: 'agent-coder-a1b2c3', body: 'Z'.repeat(2500), eventType: 'tool_call_result' },
      { sender: 'agent-coder-a1b2c3', body: 'done' },
    ]);

    const ctx = await provider.getConversationContext(SESSION_ID);
    expect(ctx.messages[0]!.content).toBe('Z'.repeat(2000) + '\n[truncated]');
    expect(ctx.messages[1]!.content).toBe('done');
  });

  it('零持久化（prune 侧）：截断只发生在返回值，DB body 原样', async () => {
    const rows = seedMessages([
      { sender: 'owner', body: 'q' },
      { sender: 'agent-coder-a1b2c3', body: 'W'.repeat(3000), eventType: 'tool_call_result' },
      { sender: 'owner', body: 'next' },
    ]);

    await provider.getConversationContext(SESSION_ID);
    expect(getMessage(rows[1]!.id)?.body).toBe('W'.repeat(3000));
  });

  it('与收缩组合：prune 作用于收缩后的拉取集合（注入条不受影响）', async () => {
    const rows = seedMessages([
      { sender: 'owner', body: 'q1' }, // m1 user
      { sender: 'agent-coder-a1b2c3', body: 'A'.repeat(3000), eventType: 'tool_call_result' }, // m2 旧轮次（未被覆盖）→ 截断
      { sender: 'owner', body: 'q2' }, // m3 最后 user
      { sender: 'agent-coder-a1b2c3', body: 'B'.repeat(3000), eventType: 'tool_call_result' }, // m4 最后回合 → 不截
    ]);
    // covered_until = m1：m1 被覆盖；m2..m4 拉取
    upsertSessionCompaction(SESSION_ID, '组合摘要', rows[0]!.createdAt);

    const ctx = await provider.getConversationContext(SESSION_ID);
    expect(ctx.messages).toHaveLength(4);
    // 拉取集合中最后 user 是原 m3 → m2 截断、m4 不截
    expect(ctx.messages[1]!.content).toBe('A'.repeat(2000) + '\n[truncated]');
    expect(ctx.messages[3]!.content).toBe('B'.repeat(3000));
    // 注入条（role=user，位于头部）不参与 prune 也不被打断
    expect(ctx.messages[0]!.content).toBe('[此前对话压缩摘要]\n组合摘要');
  });
});
