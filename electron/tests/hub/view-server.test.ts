// 远程查看服务端真 DB 回归锁（M2e T14，spec §3.1 view.* / §5.4 / §8.4 只读红线）。
//
// 锁什么：
//   四组装器     workspace 七字段 / sessions lastSeq 降序分页 / messages seq 升序页
//                + hasMore / tasks 最新在前——全部真实域查询入口（mock 收窄：仅
//                进程边界 electron/logger 与 client 上行面）
//   错误路径     工作空间/会话不存在 not_found、sessionId 缺失 bad_request、
//                跨空间会话 id（workspaceName 附加键）not_found 防探测
//   事件投影     text_delta/final/tool_call_start/thinking/脏载荷——ViewMessage
//                {seq,at,role,content} 与「调用工具 X」前缀约定
//   尾部订阅     订阅锚定当前 max rowid（历史事件不上行）、500ms 批上行、
//                上行成功才推进游标（失败/离线不丢）、consent 关闭停发且游标
//                不推进（重开补投关窗期事件——T13 交接）、unsubscribe 幂等停发
//   只读红线     源码静态断言：view-server.ts 无 INSERT/UPDATE/DELETE/CREATE
//                SQL（六方法零写路径——§8.4）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] },
}));
vi.mock('../../src/main/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { closeDb, getDb, runMigrations } from '../../src/main/storage/db';
import { setKeychainImpl, type KeychainImpl } from '../../src/main/storage/keychain';
import { createWorkspace } from '../../src/main/workspace/crud';
import { insertSession } from '../../src/main/storage/sessions/repo';
import { insertTask } from '../../src/main/storage/tasks/repo';
import type { HubClient } from '../../src/main/hub/client';
import { ViewServer } from '../../src/main/hub/view-server';
import type { HubViewSettings } from '../../src/main/hub/view-settings';
import { VIEW_RPC } from '../../src/main/hub/protocol';

// ── 环境脚手架（delegation-ports.test 同款） ─────────────────────────────────

let tmpRoot = '';
const memStore = new Map<string, string>();
const memKeychain: KeychainImpl = {
  async setSecret(k, v) { memStore.set(k, v); },
  async getSecret(k) { return memStore.get(k) ?? null; },
  async deleteSecret(k) { memStore.delete(k); },
};
// 每用例的 ViewServer 登记——afterEach 统一 destroy（断言失败的早退不泄漏 interval）
const liveServers: ViewServer[] = [];

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-view-server-'));
  process.env.AP_USER_DATA_DIR = tmpRoot;
  setKeychainImpl(memKeychain);
  runMigrations();
});
afterEach(() => {
  for (const s of liveServers.splice(0)) s.destroy();
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  memStore.clear();
});

// ── 种子与桩 ────────────────────────────────────────────────────────────────

async function seedWorkspace(name: string): Promise<string> {
  const ws = await createWorkspace(
    { name, directoryPath: path.join(tmpRoot, `wsdir-${randomUUID().slice(0, 8)}`) },
    'owner',
  );
  return ws.id;
}

function insertMessage(sessionId: string, sender: string): string {
  const id = `msg-${randomUUID().slice(0, 8)}`;
  getDb()
    .prepare(
      `INSERT INTO messages (id, session_id, sender, event_type, body, status, created_at, updated_at)
       VALUES (?, ?, ?, 'text', '', 'done', ?, ?)`,
    )
    .run(id, sessionId, sender, Date.now(), Date.now());
  return id;
}

function insertEvent(messageId: string, eventType: string, payload: Record<string, unknown>): number {
  const info = getDb()
    .prepare(
      'INSERT INTO message_events (id, message_id, seq, event_type, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(`evt-${randomUUID().slice(0, 8)}`, messageId, Math.floor(Math.random() * 1e6), eventType, JSON.stringify(payload), Date.now());
  return Number(info.lastInsertRowid);
}

interface TailCall { method: string; payload: { sessionId: string; events: Array<{ seq: number; content: string }> } }

/** client 桩：记录 request 调用；failNext 让下一次 tail 上行 reject（游标不推进路径）。 */
function fakeClient(opts: { online?: boolean; failNext?: boolean } = {}): { client: HubClient; calls: TailCall[] } {
  const calls: TailCall[] = [];
  const state = { online: opts.online ?? true, failNext: opts.failNext ?? false };
  const client = {
    state: () => (state.online ? 'online' : 'disconnected'),
    request: vi.fn(async (method: string, payload: unknown) => {
      if (state.failNext) {
        state.failNext = false;
        throw new Error('上行失败（桩）');
      }
      calls.push({ method, payload: payload as TailCall['payload'] });
      return { ok: true };
    }),
  } as unknown as HubClient;
  return { client, calls };
}

function viewServerOf(client: HubClient | null, settings: HubViewSettings = { allowGroupView: true }): ViewServer {
  const s = new ViewServer({
    clientGetter: () => client,
    settings: () => settings,
    tailTickMs: 20,
  });
  liveServers.push(s);
  return s;
}

const req = (method: string, payload: Record<string, unknown>) => ({
  v: 1 as const,
  kind: 'req' as const,
  id: `req-${randomUUID().slice(0, 8)}`,
  method,
  payload,
});

// ────────────────────────────────────────────────────────────────────────────
// 四组装器
// ────────────────────────────────────────────────────────────────────────────

describe('四组装器', () => {
  it('view.workspace：七字段组装（概览/成员/团队/MCP/skill/插件/资源统计）', async () => {
    const wsId = await seedWorkspace('prod-dev');
    const s1 = insertSession({ workspaceId: wsId, title: 's1' });
    const s2 = insertSession({ workspaceId: wsId, title: 's2' });
    insertEvent(insertMessage(s1.id, 'owner'), 'text_delta', { delta: 'hi' });
    void s2;

    const server = viewServerOf(null);
    const r = await server.handleViewRequest(req(VIEW_RPC.workspace, { workspaceName: 'prod-dev' }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const p = r.payload as {
      overview: { name: string; sessionCount: number };
      agentMembers: unknown[];
      teams: unknown[];
      mcpEnabled: string[];
      skills: string[];
      pluginsEnabled: string[];
      resourcesSummary: { agent: number; mcp: number; skill: number; plugin: number };
    };
    expect(p.overview).toMatchObject({ name: 'prod-dev', sessionCount: 2 });
    expect(Array.isArray(p.agentMembers)).toBe(true);
    expect(Array.isArray(p.teams)).toBe(true);
    expect(Array.isArray(p.mcpEnabled)).toBe(true);
    expect(Array.isArray(p.skills)).toBe(true);
    expect(Array.isArray(p.pluginsEnabled)).toBe(true);
    // 资源统计四键恒数字（builtin skill 等基础库随应用分发——只断形状不断绝对值）
    for (const v of Object.values(p.resourcesSummary)) expect(typeof v).toBe('number');
    server.destroy();
  });

  it('view.sessions：lastSeq=会话事件最大 rowid；lastSeq 降序 + beforeSeq 过滤 + limit 截断', async () => {
    const wsId = await seedWorkspace('prod-dev');
    const sA = insertSession({ workspaceId: wsId, title: 'A' });
    const sB = insertSession({ workspaceId: wsId, title: 'B' });
    const sC = insertSession({ workspaceId: wsId, title: 'C-空会话' });
    insertEvent(insertMessage(sA.id, 'owner'), 'text_delta', { delta: 'a1' });
    insertEvent(insertMessage(sA.id, 'owner'), 'text_delta', { delta: 'a2' });
    insertEvent(insertMessage(sB.id, 'agent-x'), 'final', { body: 'b1' });
    void sC;

    const server = viewServerOf(null);
    const r = await server.handleViewRequest(req(VIEW_RPC.sessions, { workspaceName: 'prod-dev', limit: 10 }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const sessions = (r.payload as { sessions: Array<{ sessionId: string; lastSeq: number }> }).sessions;
    // lastSeq 降序：B 的事件 rowid 最新（>A 两事件），C 空会话=0 殿后
    expect(sessions.map((s) => s.sessionId)).toEqual([sB.id, sA.id, sC.id]);
    expect(sessions[0]!.lastSeq).toBeGreaterThan(sessions[1]!.lastSeq);
    expect(sessions[2]!.lastSeq).toBe(0);

    // beforeSeq 过滤（分页游标=上页末条 lastSeq，严格小于界值才入页）：以 B.lastSeq
    // 为界 → B 滤除，A/C 保留
    const bSeq = sessions[0]!.lastSeq;
    const r2 = await server.handleViewRequest(req(VIEW_RPC.sessions, { workspaceName: 'prod-dev', beforeSeq: bSeq, limit: 10 }));
    const page2 = (r2.ok ? (r2.payload as { sessions: Array<{ sessionId: string }> }).sessions : []).map((s) => s.sessionId);
    expect(page2).toEqual([sA.id, sC.id]);

    // limit 截断
    const r3 = await server.handleViewRequest(req(VIEW_RPC.sessions, { workspaceName: 'prod-dev', limit: 1 }));
    expect((r3.payload as { sessions: unknown[] }).sessions).toHaveLength(1);
    server.destroy();
  });

  it('view.messages：seq 升序一页 + 角色推导 + 事件投影；hasMore 指示更早事件在望', async () => {
    const wsId = await seedWorkspace('prod-dev');
    const s = insertSession({ workspaceId: wsId, title: 'S' });
    const userMsg = insertMessage(s.id, 'owner');
    const agentMsg = insertMessage(s.id, 'agent-coder');
    const seqs: number[] = [];
    seqs.push(insertEvent(userMsg, 'text_delta', { delta: '你好' }));
    seqs.push(insertEvent(agentMsg, 'tool_call_start', { toolName: 'bash' }));
    seqs.push(insertEvent(agentMsg, 'thinking', { delta: '想一想' }));
    seqs.push(insertEvent(agentMsg, 'final', { body: '完成' }));
    seqs.push(insertEvent(agentMsg, 'final', { body: '' })); // 空 body → 事件名占位
    getDb().prepare('UPDATE message_events SET payload_json = ? WHERE rowid = ?').run('{bad json', seqs[4]!); // 脏载荷占位

    const server = viewServerOf(null);
    const r = await server.handleViewRequest(req(VIEW_RPC.messages, {
      workspaceName: 'prod-dev', sessionId: s.id, fromSeq: seqs[0]!, limit: 10,
    }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const page = r.payload as { messages: Array<{ seq: number; role: string; content: string }>; hasMore: boolean };
    expect(page.messages.map((m) => m.seq)).toEqual(seqs);
    expect(page.messages[0]).toMatchObject({ role: 'user', content: '你好' });
    expect(page.messages[1]).toMatchObject({ role: 'assistant', content: '调用工具 bash' });
    expect(page.messages[2]!.content).toContain('想一想');
    expect(page.messages[3]!.content).toBe('完成');
    expect(page.messages[4]!.content).toContain('事件 final');
    expect(page.hasMore).toBe(false);

    // fromSeq=0 → 全量；hasMore=false（无更早）
    const r0 = await server.handleViewRequest(req(VIEW_RPC.messages, { workspaceName: 'prod-dev', sessionId: s.id, fromSeq: 0, limit: 100 }));
    expect((r0.payload as { hasMore: boolean }).hasMore).toBe(false);

    // 从中段起 → hasMore=true；limit 截断
    const rMid = await server.handleViewRequest(req(VIEW_RPC.messages, { workspaceName: 'prod-dev', sessionId: s.id, fromSeq: seqs[1]!, limit: 2 }));
    const mid = rMid.payload as { messages: Array<{ seq: number }>; hasMore: boolean };
    expect(mid.messages).toHaveLength(2);
    expect(mid.hasMore).toBe(true);
    server.destroy();
  });

  it('view.tasks：目标本地任务最新在前（taskId/title/status/updatedAt）', async () => {
    const wsId = await seedWorkspace('prod-dev');
    // 同毫秒创建时 created_at_desc 排序不稳定——错开时间戳
    insertTask({ workspaceId: wsId, title: '旧任务', creatorUserId: 'owner', status: 'completed' });
    await new Promise((r) => setTimeout(r, 5));
    insertTask({ workspaceId: wsId, title: '新任务', creatorUserId: 'owner', status: 'pending' });
    const server = viewServerOf(null);
    const r = await server.handleViewRequest(req(VIEW_RPC.tasks, { workspaceName: 'prod-dev' }));
    const tasks = (r.payload as { tasks: Array<{ taskId: string; title: string; status: string; updatedAt: number }> }).tasks;
    expect(tasks.map((t) => t.title)).toEqual(['新任务', '旧任务']);
    expect(tasks[0]).toMatchObject({ status: 'pending' });
    expect(typeof tasks[0]!.updatedAt).toBe('number');
    server.destroy();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 错误路径与守卫
// ────────────────────────────────────────────────────────────────────────────

describe('错误路径与守卫', () => {
  it('工作空间不存在 → not_found；sessionId 缺失 → bad_request；未知方法 → unknown_method', async () => {
    const server = viewServerOf(null);
    const miss = await server.handleViewRequest(req(VIEW_RPC.workspace, { workspaceName: 'ghost-ws' }));
    expect(miss).toEqual({ ok: false, payload: { code: 'not_found', message: '工作空间不存在: ghost-ws' } });

    const noSession = await server.handleViewRequest(req(VIEW_RPC.messages, { workspaceName: 'ghost-ws', fromSeq: 0, limit: 10 }));
    expect((noSession as { payload: { code: string } }).payload.code).toBe('bad_request');

    const unknown = await server.handleViewRequest(req('view.nope', {}));
    expect((unknown as { payload: { code: string } }).payload.code).toBe('unknown_method');
    server.destroy();
  });

  it('会话不存在 / 跨空间会话 id（workspaceName 附加键）→ not_found（防探测不细分）', async () => {
    const wsA = await seedWorkspace('ws-a');
    await seedWorkspace('ws-b');
    const sA = insertSession({ workspaceId: wsA, title: 'A' });
    const server = viewServerOf(null);

    const ghost = await server.handleViewRequest(req(VIEW_RPC.messages, { workspaceName: 'ws-a', sessionId: 'sess-ghost', fromSeq: 0, limit: 10 }));
    expect((ghost as { payload: { code: string } }).payload.code).toBe('not_found');

    const cross = await server.handleViewRequest(req(VIEW_RPC.messages, { workspaceName: 'ws-b', sessionId: sA.id, fromSeq: 0, limit: 10 }));
    expect((cross as { payload: { code: string } }).payload.code).toBe('not_found');

    // 同空间正常
    const ok = await server.handleViewRequest(req(VIEW_RPC.messages, { workspaceName: 'ws-a', sessionId: sA.id, fromSeq: 0, limit: 10 }));
    expect(ok.ok).toBe(true);

    const ghostSub = await server.handleViewRequest(req(VIEW_RPC.subscribe, { sessionId: 'sess-ghost' }));
    expect((ghostSub as { payload: { code: string } }).payload.code).toBe('not_found');
    server.destroy();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 尾部订阅（MC3：拉取+订阅，无轮询 view.*）
// ────────────────────────────────────────────────────────────────────────────

describe('尾部订阅与 view.tail 上行', () => {
  it('订阅锚定当前 max rowid：历史事件不上行；新事件 500ms 批上行且游标推进；unsubscribe 停发', async () => {
    const wsId = await seedWorkspace('prod-dev');
    const s = insertSession({ workspaceId: wsId, title: 'S' });
    insertEvent(insertMessage(s.id, 'owner'), 'text_delta', { delta: '历史事件' });

    const { client, calls } = fakeClient();
    const server = viewServerOf(client);
    const sub = await server.handleViewRequest(req(VIEW_RPC.subscribe, { sessionId: s.id }));
    expect(sub.ok).toBe(true);

    await new Promise((r) => setTimeout(r, 60));
    expect(calls).toHaveLength(0); // 历史事件不上行（订阅锚定）

    const msg2 = insertMessage(s.id, 'agent-coder');
    insertEvent(msg2, 'text_delta', { delta: '新增量' });
    insertEvent(msg2, 'final', { body: '终稿' });
    await new Promise((r) => setTimeout(r, 80));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('view.tail');
    expect(calls[0]!.payload.sessionId).toBe(s.id);
    expect(calls[0]!.payload.events.map((e) => e.content)).toEqual(['新增量', '终稿']);

    // 游标已推进：无新事件不再上行
    await new Promise((r) => setTimeout(r, 60));
    expect(calls).toHaveLength(1);

    // unsubscribe 后停发（幂等）
    await server.handleViewRequest(req(VIEW_RPC.unsubscribe, { sessionId: s.id }));
    await server.handleViewRequest(req(VIEW_RPC.unsubscribe, { sessionId: s.id }));
    const msg3 = insertMessage(s.id, 'agent-coder');
    insertEvent(msg3, 'text_delta', { delta: '退订后' });
    await new Promise((r) => setTimeout(r, 80));
    expect(calls).toHaveLength(1);
    server.destroy();
  });

  it('上行失败 → 游标不推进（下轮重试补投，不丢增量）', async () => {
    const wsId = await seedWorkspace('prod-dev');
    const s = insertSession({ workspaceId: wsId, title: 'S' });
    const { client, calls } = fakeClient({ failNext: true });
    const server = viewServerOf(client);
    await server.handleViewRequest(req(VIEW_RPC.subscribe, { sessionId: s.id }));

    const m = insertMessage(s.id, 'owner');
    const evSeq = insertEvent(m, 'text_delta', { delta: '第一拍' });
    await new Promise((r) => setTimeout(r, 40)); // 首上行失败
    expect(calls).toHaveLength(0);
    await new Promise((r) => setTimeout(r, 60)); // 下轮重试
    expect(calls).toHaveLength(1);
    expect(calls[0]!.payload.events[0]).toMatchObject({ seq: evSeq, content: '第一拍' });
    server.destroy();
  });

  it('consent 关闭 → 停发且游标不推进；重开 → 关窗期事件首批补投（T13 交接）', async () => {
    const wsId = await seedWorkspace('prod-dev');
    const s = insertSession({ workspaceId: wsId, title: 'S' });
    let settings: HubViewSettings = { allowGroupView: false };
    const { client, calls } = fakeClient();
    const server = new ViewServer({ clientGetter: () => client, settings: () => settings, tailTickMs: 20 });
    await server.handleViewRequest(req(VIEW_RPC.subscribe, { sessionId: s.id }));

    const m = insertMessage(s.id, 'owner');
    const evSeq = insertEvent(m, 'text_delta', { delta: '关窗期事件' });
    await new Promise((r) => setTimeout(r, 80));
    expect(calls).toHaveLength(0); // 停发

    settings = { allowGroupView: true };
    await new Promise((r) => setTimeout(r, 80));
    expect(calls).toHaveLength(1); // 重开补投（游标未推进）
    expect(calls[0]!.payload.events[0]).toMatchObject({ seq: evSeq, content: '关窗期事件' });
    server.destroy();
  });

  it('离线（client null / 非 online）→ 不上行不推进；重连后续传', async () => {
    const wsId = await seedWorkspace('prod-dev');
    const s = insertSession({ workspaceId: wsId, title: 'S' });
    const holder: { client: HubClient | null } = { client: null };
    const { client, calls } = fakeClient();
    const server = new ViewServer({ clientGetter: () => holder.client, settings: () => ({ allowGroupView: true }), tailTickMs: 20 });
    await server.handleViewRequest(req(VIEW_RPC.subscribe, { sessionId: s.id }));

    const m = insertMessage(s.id, 'owner');
    const evSeq = insertEvent(m, 'text_delta', { delta: '离线期事件' });
    await new Promise((r) => setTimeout(r, 80));
    expect(calls).toHaveLength(0);

    holder.client = client; // 重连
    await new Promise((r) => setTimeout(r, 80));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.payload.events[0]!.seq).toBe(evSeq);
    server.destroy();
  });

  it('批上限 200：单轮超量分批上行（首批恰 200 条，余量下轮补投）', async () => {
    const wsId = await seedWorkspace('prod-dev');
    const s = insertSession({ workspaceId: wsId, title: 'S' });
    const { client, calls } = fakeClient();
    const server = viewServerOf(client);
    await server.handleViewRequest(req(VIEW_RPC.subscribe, { sessionId: s.id }));
    const m = insertMessage(s.id, 'owner');
    for (let i = 0; i < 205; i++) insertEvent(m, 'text_delta', { delta: `e${i}` });
    await new Promise((r) => setTimeout(r, 120));
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls[0]!.payload.events).toHaveLength(200); // TAIL_BATCH_MAX
    expect(calls[calls.length - 1]!.payload.events).toHaveLength(5); // 余量
    const total = calls.reduce((n, c) => n + c.payload.events.length, 0);
    expect(total).toBe(205); // 不丢不重
    server.destroy();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 只读红线（§8.4：服务端六方法零写路径）
// ────────────────────────────────────────────────────────────────────────────

describe('只读红线（静态源码断言）', () => {
  it('view-server.ts 源码不含写路径 SQL（组装器全部只读——§8.4）', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../src/main/hub/view-server.ts'),
      'utf-8',
    );
    // 写关键词只在与 DB 语句执行同现时判红（注释/字符串中的协议词不误伤）
    const writeSql = /\b(INSERT|UPDATE\s+\w+|DELETE\s+FROM|REPLACE\s+INTO|CREATE\s|DROP\s|ALTER\s)/i;
    const offending = src.split('\n').filter((line) =>
      writeSql.test(line) && (/\.prepare\(/.test(line) || /\.run\(/.test(line) || /\.exec\(/.test(line)),
    );
    expect(offending, `写路径 SQL 泄漏:\n${offending.join('\n')}`).toEqual([]);
  });
});
