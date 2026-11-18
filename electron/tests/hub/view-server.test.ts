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
import { createWorkspace, getWorkspace } from '../../src/main/workspace/crud';
import { insertSession } from '../../src/main/storage/sessions/repo';
import { insertTask } from '../../src/main/storage/tasks/repo';
import type { HubClient } from '../../src/main/hub/client';
import { ViewServer } from '../../src/main/hub/view-server';
import type { HubViewSettings } from '../../src/main/hub/view-settings';
import { VIEW_RPC, VIEW_FILES_ENTRIES_MAX, VIEW_FILES_READ_MAX } from '../../src/main/hub/protocol';

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
function fakeClient(opts: { online?: boolean; failNext?: boolean; protoVer?: string } = {}): { client: HubClient; calls: TailCall[] } {
  const calls: TailCall[] = [];
  const state = { online: opts.online ?? true, failNext: opts.failNext ?? false, protoVer: opts.protoVer ?? '1.13.0' };
  const client = {
    state: () => (state.online ? 'online' : 'disconnected'),
    hubProtoVer: () => state.protoVer,
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

  it('view.messages 稠密 rowid 契约（fix round 1）：单会话连续 51 条——含头窗口尾条在页、hasMore 正确；旧开窗丢尾（故障模式锁定）', async () => {
    const wsId = await seedWorkspace('prod-dev');
    const s = insertSession({ workspaceId: wsId, title: 'dense' });
    const m = insertMessage(s.id, 'owner');
    const seqs: number[] = [];
    for (let i = 0; i < 51; i++) seqs.push(insertEvent(m, 'text_delta', { delta: `e${i}` }));
    // 稠密前提自证（单会话独占连续插入——M2 委派拓扑常态；前提破则本锁失效）
    expect(seqs[50]! - seqs[0]!).toBe(50);
    const lastSeq = seqs[50]!;

    const server = viewServerOf(null);
    // 含头窗口（修复后客户端公式 fromSeq = lastSeq - 50 + 1）：恰 50 条含头含尾
    const rFix = await server.handleViewRequest(req(VIEW_RPC.messages, {
      workspaceName: 'prod-dev', sessionId: s.id, fromSeq: lastSeq - 50 + 1, limit: 50,
    }));
    const fixPage = rFix.payload as { messages: Array<{ seq: number }>; hasMore: boolean };
    expect(fixPage.messages).toHaveLength(50);
    expect(fixPage.messages[0]!.seq).toBe(seqs[1]!);
    expect(fixPage.messages[49]!.seq).toBe(lastSeq); // 尾事件 seq=lastSeq 不丢
    expect(fixPage.hasMore).toBe(true); // seqs[0] 更早事件在望

    // 旧开窗（修复前客户端公式 fromSeq = lastSeq - 50）：窗口含 51 值，ASC LIMIT 50
    // 保留最低 50 条 → seq=lastSeq 被截——off-by-one 丢尾故障模式（服务端语义不变，
    // 客户端必须含头开窗，见 hub-view.store.test 回归锁 a）
    const rOld = await server.handleViewRequest(req(VIEW_RPC.messages, {
      workspaceName: 'prod-dev', sessionId: s.id, fromSeq: lastSeq - 50, limit: 50,
    }));
    const oldPage = rOld.payload as { messages: Array<{ seq: number }> };
    expect(oldPage.messages).toHaveLength(50);
    expect(oldPage.messages[49]!.seq).toBe(seqs[49]!);
    expect(oldPage.messages.some((e) => e.seq === lastSeq)).toBe(false);
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
// M3.2 远端可见性：view.workspaces / view.files
// ────────────────────────────────────────────────────────────────────────────

describe('M3.2 view.workspaces 远端空间清单', () => {
  it('投影白名单 {id,name,description}——键集恰三字段，不含 directoryPath/ownerId（本机路径泄漏面）', async () => {
    const wsA = await seedWorkspace('prod-dev');
    await seedWorkspace('lab');
    const server = viewServerOf(null);
    const r = await server.handleViewRequest(req(VIEW_RPC.workspaces, {}));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const workspaces = (r.payload as { workspaces: Array<Record<string, unknown>> }).workspaces;
    expect(workspaces).toHaveLength(2);
    for (const w of workspaces) {
      expect(Object.keys(w).sort()).toEqual(['description', 'id', 'name']);
    }
    const names = workspaces.map((w) => w.name);
    expect(names).toContain('prod-dev');
    expect(names).toContain('lab');
    // id 与 DB 行同源（picker pickWorkspace 直接消费）
    expect(workspaces.find((w) => w.name === 'prod-dev')!.id).toBe(wsA);
    server.destroy();
  });

  it('空库 → 空清单（非错误）', async () => {
    const server = viewServerOf(null);
    const r = await server.handleViewRequest(req(VIEW_RPC.workspaces, {}));
    expect(r).toEqual({ ok: true, payload: { workspaces: [] } });
    server.destroy();
  });
});

describe('M3.2 view.files 只读文件树', () => {
  let wsId = '';
  let root = '';

  beforeEach(async () => {
    wsId = await seedWorkspace('prod-dev');
    root = getWorkspace(wsId)!.directoryPath;
    fs.mkdirSync(path.join(root, 'docs'));
    fs.mkdirSync(path.join(root, 'docs', 'deep'));
    fs.writeFileSync(path.join(root, 'README.md'), '# 项目\n你好世界');
    fs.writeFileSync(path.join(root, 'docs', 'notes.txt'), '笔记内容 abc');
    fs.writeFileSync(path.join(root, 'docs', 'deep', 'x.log'), 'x');
  });

  it('op=list：根目录（path 缺省 = 根）条目含目录/文件 + .git* 不可见；子目录按 path 列举', async () => {
    const server = viewServerOf(null);
    const r = await server.handleViewRequest(req(VIEW_RPC.files, { workspaceName: 'prod-dev', op: 'list' }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const p = r.payload as { entries: Array<{ name: string; isDirectory: boolean; size: number }>; truncated: boolean };
    const names = p.entries.map((e) => e.name);
    expect(names).toContain('README.md');
    expect(names).toContain('docs');
    // .git 目录与 .git* 前缀条目一律不可见（WorkspaceFS listDir 既有过滤）
    for (const n of names) expect(n.toLowerCase().startsWith('.git')).toBe(false);
    const docs = p.entries.find((e) => e.name === 'docs')!;
    expect(docs.isDirectory).toBe(true);
    expect(p.truncated).toBe(false);

    const sub = await server.handleViewRequest(req(VIEW_RPC.files, { workspaceName: 'prod-dev', op: 'list', path: 'docs' }));
    expect(sub.ok).toBe(true);
    const subEntries = (sub.ok ? (sub.payload as { entries: Array<{ name: string }> }).entries : []).map((e) => e.name);
    expect(subEntries).toEqual(['deep', 'notes.txt']);
    server.destroy();
  });

  it(`op=list 超 ${VIEW_FILES_ENTRIES_MAX} 条 → 截断至 ${VIEW_FILES_ENTRIES_MAX} + truncated=true；恰 ${VIEW_FILES_ENTRIES_MAX} → false`, async () => {
    const big = path.join(root, 'big');
    fs.mkdirSync(big);
    for (let i = 0; i <= VIEW_FILES_ENTRIES_MAX; i++) fs.writeFileSync(path.join(big, `f${i}.txt`), 'x');
    const server = viewServerOf(null);
    const over = await server.handleViewRequest(req(VIEW_RPC.files, { workspaceName: 'prod-dev', op: 'list', path: 'big' }));
    const overP = over.ok ? (over.payload as { entries: unknown[]; truncated: boolean }) : null;
    expect(overP?.entries).toHaveLength(VIEW_FILES_ENTRIES_MAX);
    expect(overP?.truncated).toBe(true);

    fs.unlinkSync(path.join(big, `f${VIEW_FILES_ENTRIES_MAX}.txt`));
    const exact = await server.handleViewRequest(req(VIEW_RPC.files, { workspaceName: 'prod-dev', op: 'list', path: 'big' }));
    const exactP = exact.ok ? (exact.payload as { entries: unknown[]; truncated: boolean }) : null;
    expect(exactP?.entries).toHaveLength(VIEW_FILES_ENTRIES_MAX);
    expect(exactP?.truncated).toBe(false);
    server.destroy();
  });

  it('op=read：文本文件 base64 往返 + size = 原始字节数 + truncated=false', async () => {
    const server = viewServerOf(null);
    const r = await server.handleViewRequest(req(VIEW_RPC.files, { workspaceName: 'prod-dev', op: 'read', path: 'docs/notes.txt' }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const p = r.payload as { content: string; size: number; truncated: boolean };
    const text = fs.readFileSync(path.join(root, 'docs', 'notes.txt'));
    expect(Buffer.from(p.content, 'base64').equals(text)).toBe(true);
    expect(p.size).toBe(text.length);
    expect(p.truncated).toBe(false);
    server.destroy();
  });

  it('op=read：二进制文件 base64 字节级往返（utf-8 roundtrip 必不一致的字节序列）', async () => {
    const bin = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe, 0x00, 0x81]);
    fs.writeFileSync(path.join(root, 'logo.png'), bin);
    const server = viewServerOf(null);
    const r = await server.handleViewRequest(req(VIEW_RPC.files, { workspaceName: 'prod-dev', op: 'read', path: 'logo.png' }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const p = r.payload as { content: string; size: number };
    expect(Buffer.from(p.content, 'base64').equals(bin)).toBe(true);
    expect(p.size).toBe(bin.length);
    server.destroy();
  });

  it(`op=read 超 ${VIEW_FILES_READ_MAX} 字节 → content 截断至 ${VIEW_FILES_READ_MAX} + size=原始大小 + truncated=true`, async () => {
    const big = Buffer.alloc(VIEW_FILES_READ_MAX + 1, 0x61);
    fs.writeFileSync(path.join(root, 'huge.txt'), big);
    const server = viewServerOf(null);
    const r = await server.handleViewRequest(req(VIEW_RPC.files, { workspaceName: 'prod-dev', op: 'read', path: 'huge.txt' }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const p = r.payload as { content: string; size: number; truncated: boolean };
    expect(Buffer.from(p.content, 'base64').length).toBe(VIEW_FILES_READ_MAX);
    expect(p.size).toBe(VIEW_FILES_READ_MAX + 1);
    expect(p.truncated).toBe(true);
    server.destroy();
  });

  it('越界（..）/ 绝对路径 / 符号链接逃逸 / 不存在 → not_found（anti-probe 不细分）', async () => {
    const outside = path.join(tmpRoot, 'outside-secret.txt');
    fs.writeFileSync(outside, 'secret');
    fs.symlinkSync(outside, path.join(root, 'escape-link.txt'));
    fs.symlinkSync(tmpRoot, path.join(root, 'escape-dir'));
    const server = viewServerOf(null);

    const cases: Array<Record<string, unknown>> = [
      { workspaceName: 'prod-dev', op: 'read', path: '../outside-secret.txt' },
      { workspaceName: 'prod-dev', op: 'read', path: outside },
      { workspaceName: 'prod-dev', op: 'list', path: '..' },
      { workspaceName: 'prod-dev', op: 'read', path: 'escape-link.txt' },
      { workspaceName: 'prod-dev', op: 'list', path: 'escape-dir' },
      { workspaceName: 'prod-dev', op: 'read', path: 'ghost.txt' },
      { workspaceName: 'prod-dev', op: 'list', path: 'ghost-dir' },
      { workspaceName: 'ghost-ws', op: 'list' },
    ];
    for (const payload of cases) {
      const r = await server.handleViewRequest(req(VIEW_RPC.files, payload));
      expect(r.ok, JSON.stringify(payload)).toBe(false);
      expect((r as { payload: { code: string } }).payload.code).toBe('not_found');
    }
    server.destroy();
  });

  it('op 非法/缺失 → bad_request；path 超 512 字符 → bad_request', async () => {
    const server = viewServerOf(null);
    const badOp = await server.handleViewRequest(req(VIEW_RPC.files, { workspaceName: 'prod-dev', op: 'write', path: 'x' }));
    expect((badOp as { payload: { code: string } }).payload.code).toBe('bad_request');
    const noOp = await server.handleViewRequest(req(VIEW_RPC.files, { workspaceName: 'prod-dev' }));
    expect((noOp as { payload: { code: string } }).payload.code).toBe('bad_request');
    const longPath = await server.handleViewRequest(req(VIEW_RPC.files, { workspaceName: 'prod-dev', op: 'list', path: 'a'.repeat(513) }));
    expect((longPath as { payload: { code: string } }).payload.code).toBe('bad_request');
    server.destroy();
  });

  it('read 目录路径 → not_found（EISDIR 归入不可访问）；list 文件路径 → not_found（ENOTDIR）', async () => {
    const server = viewServerOf(null);
    const readDir = await server.handleViewRequest(req(VIEW_RPC.files, { workspaceName: 'prod-dev', op: 'read', path: 'docs' }));
    expect((readDir as { payload: { code: string } }).payload.code).toBe('not_found');
    const listFile = await server.handleViewRequest(req(VIEW_RPC.files, { workspaceName: 'prod-dev', op: 'list', path: 'README.md' }));
    expect((listFile as { payload: { code: string } }).payload.code).toBe('not_found');
    server.destroy();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 只读红线（§8.4：服务端八方法零写路径）
// ────────────────────────────────────────────────────────────────────────────

describe('只读红线（静态源码断言）', () => {
  it('view-server.ts 源码不含写路径 SQL（组装器全部只读——§8.4；M3.2 workspaces/files 分支自动同覆盖）', () => {
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

// ────────────────────────────────────────────────────────────────────────────
// wire v2 协商与帧投影（1.13.0，spec 2026-11-17 §4/§6）
// ────────────────────────────────────────────────────────────────────────────

describe('wire v2 协商与帧投影', () => {
  async function seedSessionWithFrames(): Promise<{ wsName: string; sessionId: string; msgId: string }> {
    const wsId = await seedWorkspace('frame-ws');
    const session = insertSession({ workspaceId: wsId, title: '帧会话' });
    const msgId = insertMessage(session.id, 'agent');
    return { wsName: 'frame-ws', sessionId: session.id, msgId };
  }

  it('subscribe wire:2 + hub 1.13 → res 回显 wire:2；tail 上行帧形态；未终态帧跨拍重发、终态后不再出现', async () => {
    const { sessionId, msgId } = await seedSessionWithFrames();
    const { client, calls } = fakeClient();
    const server = viewServerOf(client);

    const r = await server.handleViewRequest(req(VIEW_RPC.subscribe, { sessionId, wire: 2 }));
    expect(r.ok).toBe(true);
    expect(r.ok && r.payload).toEqual({ ok: true, wire: 2 });

    // 第一拍：一个未终态 text 帧
    insertEvent(msgId, 'text_delta', { delta: '生成' });
    await new Promise((res) => setTimeout(res, 45));
    const first = calls.find((c) => 'frames' in c.payload) as unknown as { payload: { frames: Array<{ frameId: string; content: string; streaming?: boolean }> } };
    expect(first).toBeDefined();
    expect(first.payload.frames).toEqual([
      { frameId: msgId, seq: expect.any(Number), at: expect.any(Number), role: 'assistant', kind: 'text', content: '生成', streaming: true },
    ]);

    // 第二拍：帧内容增长（重发同 frameId 整帧替换）
    insertEvent(msgId, 'text_delta', { delta: '中…' });
    await new Promise((res) => setTimeout(res, 45));
    const frameCalls = calls.filter((c) => 'frames' in c.payload) as unknown as Array<{ payload: { frames: Array<{ frameId: string; content: string; streaming?: boolean }> } }>;
    const second = frameCalls[frameCalls.length - 1]!;
    expect(second.payload.frames[0]).toMatchObject({ frameId: msgId, content: '生成中…', streaming: true });

    // 终态拍：final 定稿 + streaming 收敛；此后无新事件 → 无更多上行
    insertEvent(msgId, 'final', { body: '生成中…（完）', status: 'done' });
    await new Promise((res) => setTimeout(res, 45));
    const last = calls.filter((c) => 'frames' in c.payload).pop() as unknown as { payload: { frames: Array<{ frameId: string; content: string; streaming?: boolean }> } };
    expect(last.payload.frames[0]).toMatchObject({ frameId: msgId, content: '生成中…（完）' });
    expect(last.payload.frames[0]!.streaming).toBeUndefined();
    const callsBefore = calls.length;
    await new Promise((res) => setTimeout(res, 45));
    expect(calls.length).toBe(callsBefore); // 游标已推进，静止期零上行
  });

  it('hub <1.13 时 wire:2 订阅不回显、tail 恒旧 events 形态（旧 hub 不认帧——防 tail 被整包拒）', async () => {
    const { sessionId, msgId } = await seedSessionWithFrames();
    const { client, calls } = fakeClient({ protoVer: '1.12.0' });
    const server = viewServerOf(client);

    const r = await server.handleViewRequest(req(VIEW_RPC.subscribe, { sessionId, wire: 2 }));
    expect(r.ok).toBe(true);
    expect(r.ok && r.payload).toEqual({ ok: true }); // 无 wire 键

    insertEvent(msgId, 'text_delta', { delta: 'x' });
    insertEvent(msgId, 'final', { body: 'x', status: 'done' });
    await new Promise((res) => setTimeout(res, 45));
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      expect('frames' in c.payload).toBe(false);
      expect('events' in c.payload).toBe(true);
    }
  });

  it('无 wire 字段订阅 → 行为与现状逐字节一致（回归锁：res 无 wire 键 + events 形态）', async () => {
    const { sessionId, msgId } = await seedSessionWithFrames();
    const { client, calls } = fakeClient();
    const server = viewServerOf(client);

    const r = await server.handleViewRequest(req(VIEW_RPC.subscribe, { sessionId }));
    expect(r.ok && r.payload).toEqual({ ok: true });
    insertEvent(msgId, 'text_delta', { delta: 'hi' });
    await new Promise((res) => setTimeout(res, 45));
    const tail = calls[0]!;
    expect('frames' in tail.payload).toBe(false);
    expect(tail.payload.events[0]).toMatchObject({ role: 'assistant', content: 'hi' });
  });

  it('viewMessages wire:2 → 帧页（fromSeq=0 取尾窗帧 + hasMore）', async () => {
    const { sessionId } = await seedSessionWithFrames();
    // 三条消息：两条终态 + 一条未终态
    for (let i = 0; i < 2; i++) {
      const m = insertMessage(sessionId, 'agent');
      insertEvent(m, 'text_delta', { delta: `文${i}` });
      insertEvent(m, 'final', { body: `文${i}定稿`, status: 'done' });
    }
    const m3 = insertMessage(sessionId, 'agent');
    insertEvent(m3, 'text_delta', { delta: '流' });

    const server = viewServerOf(null);
    const page = await server.handleViewRequest(req(VIEW_RPC.messages, { sessionId, fromSeq: 0, limit: 2, wire: 2 }));
    expect(page.ok).toBe(true);
    if (!page.ok) return;
    const p = page.payload as { frames: Array<{ frameId: string; kind: string; streaming?: boolean }>; hasMore: boolean };
    expect(p.frames).toHaveLength(2);
    expect(p.hasMore).toBe(true);
    expect(p.frames[1]!.frameId).toBe(m3);
    expect(p.frames[1]!.streaming).toBe(true);
    expect(p.frames[0]!.kind).toBe('text');
  });

  it('viewMessages wire:2 loadEarlier（fromSeq=首帧 seq）→ 更早帧页', async () => {
    const { sessionId } = await seedSessionWithFrames();
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const m = insertMessage(sessionId, 'agent');
      insertEvent(m, 'text_delta', { delta: `m${i}` });
      insertEvent(m, 'final', { body: `m${i}`, status: 'done' });
      ids.push(m);
    }
    const server = viewServerOf(null);
    const r1 = await server.handleViewRequest(req(VIEW_RPC.messages, { sessionId, fromSeq: 0, limit: 2, wire: 2 }));
    const p1 = (r1.ok ? r1.payload : { frames: [] }) as { frames: Array<{ frameId: string; seq: number }> };
    const firstSeq = p1.frames[0]!.seq;
    const r2 = await server.handleViewRequest(req(VIEW_RPC.messages, { sessionId, fromSeq: firstSeq, limit: 2, wire: 2 }));
    const p2 = (r2.ok ? r2.payload : { frames: [] }) as { frames: Array<{ frameId: string }>; hasMore: boolean };
    expect(p2.frames.map((f) => f.frameId)).toEqual(ids.slice(0, 1));
    expect(p2.hasMore).toBe(false);
  });

  it('wire2 订阅即种子 openStarts：订阅前已开始的流式帧首拍即全文快照（终审 C3c）', async () => {
    const { sessionId, msgId } = await seedSessionWithFrames();
    // 订阅前消息已流式输出两段
    insertEvent(msgId, 'text_delta', { delta: '前半' });
    insertEvent(msgId, 'text_delta', { delta: '段' });
    const { client, calls } = fakeClient();
    const server = viewServerOf(client);
    const r = await server.handleViewRequest(req(VIEW_RPC.subscribe, { sessionId, wire: 2 }));
    expect(r.ok && r.payload).toEqual({ ok: true, wire: 2 });
    // 订阅后新增量到达——首拍快照必须含订阅锚之前的全文（非仅新 delta）
    insertEvent(msgId, 'text_delta', { delta: '+新' });
    await new Promise((res) => setTimeout(res, 45));
    const first = calls.find((c) => 'frames' in c.payload) as unknown as { payload: { frames: Array<{ content?: string; streaming?: boolean }> } };
    expect(first).toBeDefined();
    expect(first.payload.frames[0]).toMatchObject({ content: '前半段+新', streaming: true });
  });

  it('viewMessages wire:2 afterSeq → seq 升序帧页（断线补拉方向，终审 C3b）', async () => {
    const { sessionId } = await seedSessionWithFrames();
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const m = insertMessage(sessionId, 'agent');
      insertEvent(m, 'text_delta', { delta: `m${i}` });
      insertEvent(m, 'final', { body: `m${i}`, status: 'done' });
      ids.push(m);
    }
    const server = viewServerOf(null);
    const page = await server.handleViewRequest(req(VIEW_RPC.messages, { sessionId, fromSeq: 0, limit: 50, afterSeq: 2, wire: 2 }));
    expect(page.ok).toBe(true);
    if (!page.ok) return;
    // afterSeq=2：仅返回 seq>2 的帧（升序），第一条是第二条消息（其首事件 rowid=3）
    const p = page.payload as { frames: Array<{ frameId: string; seq: number }>; hasMore: boolean };
    expect(p.frames.map((f) => f.frameId)).toEqual(ids.slice(1));
    expect(p.frames.every((f) => f.seq > 2)).toBe(true);
    expect(p.hasMore).toBe(false);
  });

  it('hub <1.13 时 viewMessages wire:2 不回帧页——按 legacy 投影降级（终审 Important#4）', async () => {
    const { sessionId, msgId } = await seedSessionWithFrames();
    insertEvent(msgId, 'text_delta', { delta: 'x' });
    insertEvent(msgId, 'final', { body: 'x', status: 'done' });
    const server = viewServerOf(fakeClient({ protoVer: '1.12.0' }).client);
    const r = await server.handleViewRequest(req(VIEW_RPC.messages, { sessionId, fromSeq: 0, limit: 50, wire: 2 }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect('frames' in (r.payload as Record<string, unknown>)).toBe(false);
    expect('messages' in (r.payload as Record<string, unknown>)).toBe(true);
  });

  it('viewSessions 回带 delegationId（tasks.execution_session_id 联表）；非委派会话不带键', async () => {
    const wsId = await seedWorkspace('del-ws');
    const s1 = insertSession({ workspaceId: wsId, title: '委派会话' });
    const s2 = insertSession({ workspaceId: wsId, title: '普通会话' });
    insertEvent(insertMessage(s1.id, 'agent'), 'text_delta', { delta: 'x' });
    const task = insertTask({ workspaceId: wsId, title: '外派任务', creatorUserId: 'owner', status: 'in_progress' });
    getDb().prepare('UPDATE tasks SET delegation_id = ?, delegation_role = ?, execution_session_id = ? WHERE id = ?')
      .run('del-123', 'in', s1.id, task.id);

    const server = viewServerOf(null);
    const r = await server.handleViewRequest(req(VIEW_RPC.sessions, { workspaceName: 'del-ws', limit: 10 }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const sessions = (r.payload as { sessions: Array<{ sessionId: string; delegationId?: string }> }).sessions;
    const linked = sessions.find((x) => x.sessionId === s1.id);
    const plain = sessions.find((x) => x.sessionId === s2.id);
    expect(linked?.delegationId).toBe('del-123');
    expect('delegationId' in (plain ?? {})).toBe(false);
  });
});
