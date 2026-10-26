// 子节点委派执行器生产端口真 DB 回归锁（M2e T12 前置 F1/F2——T10/T11 评审 Important）。
// 三端口直测（SQL 形状漂移的网兜）：
//   watchTurnProduct      回合终态轮询 + F1 attach 基线界定（idle 续传「旧终态行 +
//                         新回合无流行」不得误判假 failed）
//   sessionTailProduct    事件挑选（text_delta / final.body / tool_call_start）与
//                         rowid 单调游标（含不可读条目推进游标、跨会话隔离）
//   resolveAgentInstanceProduct  slug 匹配与默认 agent 回退（跨空间脏默认值拒绝）
// 夹具纪律（mirror-applier.test 同款）：真 migrations DB（AP_USER_DATA_DIR 指向 tmp
// 目录），只 mock 进程边界（electron / 会话执行入口 / logger）——agent/workspace/
// messages 全部走真实表与真实查询代码（momo-test-rules #5 mock 收窄）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] },
}));
// 会话执行边界替身（端口装配 imports 链上的进程边界；DB 查询保持真实）
vi.mock('../../src/main/im/session-ops', () => ({
  createCollabSession: vi.fn(() => ({ id: 'sess-x' })),
}));
vi.mock('../../src/main/im/session-service', () => ({
  sendUserMessage: vi.fn(async () => undefined),
}));
vi.mock('../../src/main/agent/router-bootstrap', () => ({
  getRouterService: vi.fn(() => null),
}));
vi.mock('../../src/main/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { closeDb, getDb, runMigrations } from '../../src/main/storage/db';
import { setKeychainImpl, type KeychainImpl } from '../../src/main/storage/keychain';
import { createWorkspace } from '../../src/main/workspace/crud';
import { addMember, saveAgentDefinition } from '../../src/main/agent/crud';
import type { AgentDefinition } from '../../src/main/agent/types';
import { insertSession } from '../../src/main/storage/sessions/repo';
import { getGrantedDirs, grantWriteDirs } from '../../src/main/sandbox/write-grant';
import {
  applyRunPolicyProduct,
  resolveAgentInstanceProduct,
  sessionTailProduct,
  sessionWaitingProduct,
  watchTurnProduct,
} from '../../src/main/hub/delegation-ports';
import {
  clearPendingOnDeny,
  listPendingWriteBlocked,
  writeBlockedFromChildMsg,
} from '../../src/main/sandbox/write-blocked-emit';

// ── 环境脚手架（mirror-applier.test 同款） ──────────────────────────────────

let tmpRoot = '';
const memStore = new Map<string, string>();
const memKeychain: KeychainImpl = {
  async setSecret(k, v) { memStore.set(k, v); },
  async getSecret(k) { return memStore.get(k) ?? null; },
  async deleteSecret(k) { memStore.delete(k); },
};

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-delegation-ports-'));
  process.env.AP_USER_DATA_DIR = tmpRoot;
  setKeychainImpl(memKeychain);
  runMigrations();
});
afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  memStore.clear();
});

// ── 种子工具 ────────────────────────────────────────────────────────────────

function makeDef(slug: string): AgentDefinition {
  return {
    id: `def-${slug}`,
    name: slug,
    slug,
    version: '1.0.0',
    runtime: 'declarative',
    systemPrompt: `你是 ${slug}`,
    defaultTools: [],
    source: 'custom',
    description: '',
    iconEmoji: '🤖',
    defaultMcps: [],
    defaultSkills: [],
    workspaceId: null,
    modelProviderId: null,
    modelName: 'glm-5.3',
  };
}

async function seedWorkspaceWithMember(wsName: string, slug: string): Promise<{ wsId: string; instanceId: string }> {
  const ws = await createWorkspace(
    { name: wsName, directoryPath: path.join(tmpRoot, `wsdir-${randomUUID().slice(0, 8)}`) },
    'owner',
  );
  saveAgentDefinition(makeDef(slug));
  const member = await addMember(ws.id, `def-${slug}`, `@${slug}:localhost`);
  return { wsId: ws.id, instanceId: member.instanceId };
}

/** 直插一条消息行（messages 是 watchTurn/sessionTail 的唯一观测表；返回 rowid） */
function insertMessage(input: {
  sessionId: string;
  sender: string;
  status: string;
  streamSessionId?: string | null;
  parentStreamSessionId?: string | null;
  segmentOf?: string | null;
  createdAt: number;
}): { id: string; rowid: number } {
  const id = `msg-${randomUUID().slice(0, 8)}`;
  const info = getDb()
    .prepare(
      `INSERT INTO messages (id, session_id, sender, event_type, body, stream_session_id,
         parent_stream_session_id, segment_of, status, created_at, updated_at)
       VALUES (?, ?, ?, 'text', '', ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.sessionId,
      input.sender,
      input.streamSessionId ?? null,
      input.parentStreamSessionId ?? null,
      input.segmentOf ?? null,
      input.status,
      input.createdAt,
      input.createdAt,
    );
  return { id, rowid: Number(info.lastInsertRowid) };
}

function setMessageStatus(messageId: string, status: string): void {
  getDb().prepare('UPDATE messages SET status = ? WHERE id = ?').run(status, messageId);
}

/** 直插一条流事件（message_events；返回 rowid） */
function insertEvent(messageId: string, eventType: string, payloadJson: string): number {
  const info = getDb()
    .prepare(
      'INSERT INTO message_events (id, message_id, seq, event_type, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(`evt-${randomUUID().slice(0, 8)}`, messageId, Math.floor(Math.random() * 1e6), eventType, payloadJson, Date.now());
  return Number(info.lastInsertRowid);
}

// ── watchTurnProduct：回合终态观测 + F1 attach 基线界定 ─────────────────────

describe('watchTurnProduct 回合终态观测', () => {
  // 假时钟只限本 describe：轮询周期推进断言需要；种子阶段（createWorkspace 的
  // git 子进程）在真时钟下执行
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('F1 回归锁：旧终态行 + 新回合无流行 → 不误判（陈旧 failed 不胜出）', async () => {
    // 场景（idle 续传路径）：上一回合在会话里留下 failed 终态行；重连后 runner
    // 复用同一会话注入续跑回合——attach 时刻新回合尚无任何流行。无基线下界时
    // ORDER BY created_at DESC 让陈旧行立即胜出 → 假 failed 回调。
    const sessionId = 'sess-resume';
    insertMessage({ sessionId, sender: 'agent-coder', status: 'failed', streamSessionId: 'st-old', createdAt: 1000 });

    const terminals: string[] = [];
    const dispose = watchTurnProduct(sessionId, (t) => { terminals.push(t.status); });
    await vi.advanceTimersByTimeAsync(2500); // 两个以上轮询周期
    expect(terminals).toEqual([]); // 陈旧终态行被 attach 基线排除——不误判

    // 新回合开始：agent 流行落库（streaming）→ 仍在跑，不回调
    insertMessage({ sessionId, sender: 'agent-coder', status: 'streaming', streamSessionId: 'st-new', createdAt: 2000 });
    await vi.advanceTimersByTimeAsync(2500);
    expect(terminals).toEqual([]);

    // 新回合终态落库 → 回调真实终态
    const doneRow = getDb()
      .prepare("SELECT id FROM messages WHERE session_id = ? AND stream_session_id = 'st-new'")
      .get(sessionId) as { id: string };
    setMessageStatus(doneRow.id, 'done');
    await vi.advanceTimersByTimeAsync(2500);
    expect(terminals).toEqual(['done']);
    dispose();
  });

  it('首回合（空会话基线 0）：streaming 等待、failed 终态回调、aborted 映射中止', async () => {
    const sessionId = 'sess-fresh';
    const terminals: string[] = [];
    const dispose = watchTurnProduct(sessionId, (t) => { terminals.push(t.status); });

    await vi.advanceTimersByTimeAsync(2500);
    expect(terminals).toEqual([]); // 无流行（用户消息已落、agent 未开始）继续等

    const row = insertMessage({ sessionId, sender: 'agent-coder', status: 'streaming', streamSessionId: 'st-1', createdAt: 2000 });
    await vi.advanceTimersByTimeAsync(2500);
    expect(terminals).toEqual([]); // streaming=在跑

    setMessageStatus(row.id, 'aborted');
    await vi.advanceTimersByTimeAsync(2500);
    expect(terminals).toEqual(['aborted']);
    dispose();
  });

  it('观测面收窄：owner 行 / 子段（segment_of）/ 嵌套流（parent_stream_session_id）不算回合终态', async () => {
    const sessionId = 'sess-scope';
    insertMessage({ sessionId, sender: 'owner', status: 'failed', streamSessionId: 'st-owner', createdAt: 1000 });
    insertMessage({ sessionId, sender: 'agent-coder', status: 'done', streamSessionId: 'st-nested', parentStreamSessionId: 'st-1', createdAt: 1100 });
    insertMessage({ sessionId, sender: 'agent-coder', status: 'done', streamSessionId: 'st-seg', segmentOf: 'msg-parent', createdAt: 1200 });

    const terminals: string[] = [];
    const dispose = watchTurnProduct(sessionId, (t) => { terminals.push(t.status); });
    await vi.advanceTimersByTimeAsync(2500);
    expect(terminals).toEqual([]); // 三行均不在顶层 agent 流行观测面
    dispose();
  });

  it('解订阅后不再回调（取消路径清算 watcher）', async () => {
    const sessionId = 'sess-cancel';
    const terminals: string[] = [];
    const dispose = watchTurnProduct(sessionId, (t) => { terminals.push(t.status); });
    dispose();
    insertMessage({ sessionId, sender: 'agent-coder', status: 'failed', streamSessionId: 'st-1', createdAt: 1000 });
    await vi.advanceTimersByTimeAsync(2500);
    expect(terminals).toEqual([]);
  });
});

// ── sessionTailProduct：事件挑选与 rowid 单调游标 ───────────────────────────

describe('sessionTailProduct 尾部增量', () => {
  it('批内末条可读文本胜出：text_delta → tool_call_start → final.body（末条 final 赢）；lastSeq=批尾 rowid', () => {
    const sessionId = 'sess-tail-1';
    const m = insertMessage({ sessionId, sender: 'agent-coder', status: 'streaming', streamSessionId: 'st-1', createdAt: 1000 });
    insertEvent(m.id, 'text_delta', JSON.stringify({ delta: '分析中' }));
    insertEvent(m.id, 'tool_call_start', JSON.stringify({ toolName: 'read_file' }));
    const lastRid = insertEvent(m.id, 'final', JSON.stringify({ body: '已完成修复并跑绿测试' }));

    const tail = sessionTailProduct(sessionId, 0);
    expect(tail).not.toBeNull();
    expect(tail!.lastSeq).toBe(lastRid);
    expect(tail!.excerpt).toBe('已完成修复并跑绿测试');
  });

  it('游标推进后无增量返回 null；增量续至后按新批尾返回（rowid 单调不丢）', () => {
    const sessionId = 'sess-tail-2';
    const m = insertMessage({ sessionId, sender: 'agent-coder', status: 'streaming', streamSessionId: 'st-1', createdAt: 1000 });
    const rid1 = insertEvent(m.id, 'text_delta', JSON.stringify({ delta: '第一段' }));
    const first = sessionTailProduct(sessionId, 0);
    expect(first!.lastSeq).toBe(rid1);

    expect(sessionTailProduct(sessionId, rid1)).toBeNull(); // 无增量不打空拍

    const rid2 = insertEvent(m.id, 'text_delta', JSON.stringify({ delta: '第二段' }));
    const second = sessionTailProduct(sessionId, rid1);
    expect(second!.lastSeq).toBe(rid2);
    expect(second!.excerpt).toBe('第二段');
  });

  it('末条不可读（thinking 等）不覆盖前序可读摘要，但 lastSeq 仍推进到批尾', () => {
    const sessionId = 'sess-tail-3';
    const m = insertMessage({ sessionId, sender: 'agent-coder', status: 'streaming', streamSessionId: 'st-1', createdAt: 1000 });
    insertEvent(m.id, 'text_delta', JSON.stringify({ delta: '可读摘要' }));
    const lastRid = insertEvent(m.id, 'thinking_delta', JSON.stringify({ delta: '推理中' }));

    const tail = sessionTailProduct(sessionId, 0);
    expect(tail!.lastSeq).toBe(lastRid);
    expect(tail!.excerpt).toBe('可读摘要');
  });

  it('仅工具事件批：excerpt=「调用工具 X」；全不可读批：恒非空占位（wire 契约 excerpt 恒非空）', () => {
    const sessionId = 'sess-tail-4';
    const m1 = insertMessage({ sessionId, sender: 'agent-coder', status: 'streaming', streamSessionId: 'st-1', createdAt: 1000 });
    insertEvent(m1.id, 'tool_call_start', JSON.stringify({ toolName: 'bash' }));
    const t1 = sessionTailProduct(sessionId, 0);
    expect(t1!.excerpt).toBe('调用工具 bash');

    const m2 = insertMessage({ sessionId, sender: 'agent-coder', status: 'streaming', streamSessionId: 'st-2', createdAt: 2000 });
    const rid2 = insertEvent(m2.id, 'usage', JSON.stringify({ tokens: 42 }));
    const t2 = sessionTailProduct(sessionId, t1!.lastSeq);
    expect(t2!.lastSeq).toBe(rid2);
    expect(t2!.excerpt).toBe('（无文本增量）');
  });

  it('异形载荷（缺字段/空串/坏 JSON 之外的可解析形态）不炸：空 delta 被跳过', () => {
    const sessionId = 'sess-tail-5';
    const m = insertMessage({ sessionId, sender: 'agent-coder', status: 'streaming', streamSessionId: 'st-1', createdAt: 1000 });
    insertEvent(m.id, 'text_delta', JSON.stringify({ delta: '   ' })); // 空白不可读
    insertEvent(m.id, 'final', JSON.stringify({ body: '有效正文' }));
    const tail = sessionTailProduct(sessionId, 0);
    expect(tail!.excerpt).toBe('有效正文');
  });

  it('跨会话隔离：他会话事件不进本会话尾部', () => {
    const mine = 'sess-tail-mine';
    const other = 'sess-tail-other';
    const mOther = insertMessage({ sessionId: other, sender: 'agent-coder', status: 'streaming', streamSessionId: 'st-o', createdAt: 1000 });
    insertEvent(mOther.id, 'text_delta', JSON.stringify({ delta: '他会话增量' }));

    expect(sessionTailProduct(mine, 0)).toBeNull();
  });
});

// ── resolveAgentInstanceProduct：slug 匹配与默认回退 ────────────────────────

describe('resolveAgentInstanceProduct agent 解析', () => {
  it('指定 slug 命中成员 → 该成员 instanceId；slug 无匹配 → null', async () => {
    const { wsId } = await seedWorkspaceWithMember('ws-a', 'coder');
    const hit = resolveAgentInstanceProduct(wsId, 'coder');
    expect(hit).toEqual(expect.any(String));

    expect(resolveAgentInstanceProduct(wsId, 'ghost')).toBeNull();
  });

  it('缺省 slug → 工作空间默认 agent；未配置默认 → null', async () => {
    const { wsId, instanceId } = await seedWorkspaceWithMember('ws-b', 'pm-agent');
    // 未配置默认
    expect(resolveAgentInstanceProduct(wsId, undefined)).toBeNull();

    getDb().prepare('UPDATE workspaces SET default_agent_instance_id = ? WHERE id = ?').run(instanceId, wsId);
    expect(resolveAgentInstanceProduct(wsId, undefined)).toBe(instanceId);
  });

  it('默认值指向非在册成员（跨空间脏默认值）→ null（不盲信 workspaces 行）', async () => {
    const a = await seedWorkspaceWithMember('ws-c', 'coder');
    const b = await seedWorkspaceWithMember('ws-d', 'pm-agent');
    // ws-c 的默认 agent 指向 ws-d 的成员——回退必须拒绝
    getDb().prepare('UPDATE workspaces SET default_agent_instance_id = ? WHERE id = ?').run(b.instanceId, a.wsId);
    expect(resolveAgentInstanceProduct(a.wsId, undefined)).toBeNull();
  });

  it('指定 slug 但成员定义已被删（悬挂引用）→ null', async () => {
    const { wsId } = await seedWorkspaceWithMember('ws-e', 'temp-agent');
    getDb().prepare('DELETE FROM agent_definitions WHERE slug = ?').run('temp-agent');
    expect(resolveAgentInstanceProduct(wsId, undefined)).toBeNull();
  });
});

// ── applyRunPolicyProduct：L0 权限档位生产接线（M2.1 T10） ───────────────────
// 接既有写授权管理器（sandbox/write-grant.ts，授权卡 sandbox:grantWrite 同一 API）：
//   readonly = clearSessionGrants（零会话级写授权——降级面，行为约束在 prompt 前缀）
//   sandbox  = grantWriteDirs('session', sid, [镜像工作空间目录])（会话级预授予，
//              随 deleteSession 清理；经 handleNetTrustOp 两层合成流进 extraDirs）
//   confirm  = 不动授权面（不自动拒，现状默认）

describe('applyRunPolicyProduct 权限档位接线', () => {
  async function seedSession(tierSeed?: { dirs: string[] }): Promise<{
    sessionId: string;
    wsDir: string;
  }> {
    const ws = await createWorkspace(
      { name: 'ws-tier', directoryPath: path.join(tmpRoot, `wsdir-${randomUUID().slice(0, 8)}`) },
      'owner',
    );
    const sessionId = insertSession({ workspaceId: ws.id, title: '委派会话' }).id;
    if (tierSeed) grantWriteDirs('session', sessionId, tierSeed.dirs);
    return { sessionId, wsDir: ws.directoryPath };
  }

  it('readonly：清空会话级写授权（零授权面显式化）——预存授权被清', async () => {
    const seedDir = path.join(tmpRoot, 'outside-seed');
    fs.mkdirSync(seedDir, { recursive: true });
    const { sessionId } = await seedSession({ dirs: [seedDir] });
    expect(getGrantedDirs(sessionId, null)).toHaveLength(1); // 前置自证：授权确已落 kv

    applyRunPolicyProduct(sessionId, 'readonly');

    expect(getGrantedDirs(sessionId, null)).toEqual([]);
  });

  it('sandbox：预授予镜像工作空间目录写授权（realpath 归一形态，会话级键）', async () => {
    const { sessionId, wsDir } = await seedSession();

    applyRunPolicyProduct(sessionId, 'sandbox');

    // grantWriteDirs 经 expandToolchainDirs realpath 归一（macOS /var → /private/var）
    expect(getGrantedDirs(sessionId, null)).toEqual([fs.realpathSync(wsDir)]);
  });

  it('confirm：授权面不动——预存授权保留、无新增', async () => {
    const seedDir = path.join(tmpRoot, 'confirm-keep');
    fs.mkdirSync(seedDir, { recursive: true });
    const { sessionId, wsDir } = await seedSession({ dirs: [seedDir] });

    applyRunPolicyProduct(sessionId, 'confirm');

    expect(getGrantedDirs(sessionId, null)).toEqual([fs.realpathSync(seedDir)]);
    expect(getGrantedDirs(sessionId, null)).not.toContain(wsDir);
  });

  it('防御：会话不存在（悬挂 sessionId）→ 三档均不炸（sandbox 静默跳过授予）', () => {
    expect(() => applyRunPolicyProduct('sess-ghost', 'sandbox')).not.toThrow();
    expect(() => applyRunPolicyProduct('sess-ghost', 'readonly')).not.toThrow();
    expect(() => applyRunPolicyProduct('sess-ghost', 'confirm')).not.toThrow();
  });
});

// ── sessionWaitingProduct：L1b 等待信号生产接线（M2.1 T11） ──────────────────
// 真源=write-blocked-emit 未决写授权登记（主进程镜像）；门控=回合在跑
// （latestAgentStreamRow status='streaming'——回合已终态的陈旧登记不误报）。

describe('sessionWaitingProduct 等待信号接线', () => {
  interface WaitingSeed {
    sessionId: string;
    streamId: string;
    messageId: string;
    agentStatus: string;
  }

  function seedWaiting(seed: WaitingSeed): void {
    const db = getDb();
    db.prepare(
      `INSERT INTO workspaces (id, name, directory_path, owner_id)
       VALUES ('ws-wait', 'wait', '/ws/wait', 'u-test')`,
    ).run();
    db.prepare(
      `INSERT INTO sessions (id, workspace_id, title, title_auto, kind, created_at, updated_at)
       VALUES (?, 'ws-wait', '委派会话', 0, 'chat', 1, 1)`,
    ).run(seed.sessionId);
    db.prepare(
      `INSERT INTO messages (id, session_id, sender, event_type, body, stream_session_id, status, source, created_at, updated_at)
       VALUES (?, ?, 'agent-coder-66XMEw', 'm.room.message', '', ?, ?, 'local', 1, 1)`,
    ).run(seed.messageId, seed.sessionId, seed.streamId, seed.agentStatus);
  }

  function reportWaiting(streamId: string, command: string): void {
    // writeBlockedFromChildMsg 在 electron mock 下无窗口静默跳过推送，登记面照常落
    writeBlockedFromChildMsg({
      type: 'write-blocked-report',
      streamSessionId: streamId,
      workspaceId: 'ws-wait',
      dirs: ['/ws/wait/out'],
      command,
    });
  }

  it('未决授权卡 + 回合 streaming → waiting=true，summary 含来源 agent 与命令', () => {
    seedWaiting({ sessionId: 's-h1', streamId: 'ss-h1', messageId: 'm-h1', agentStatus: 'streaming' });
    reportWaiting('ss-h1', 'mkdir -p out');
    const w = sessionWaitingProduct('s-h1');
    expect(w).not.toBeNull();
    expect(w!.waiting).toBe(true);
    expect(w!.summary).toContain('mkdir -p out');
    expect(w!.summary).toContain('coder');
  });

  it('无未决登记 → waiting=false（summary 空串）', () => {
    seedWaiting({ sessionId: 's-h2', streamId: 'ss-h2', messageId: 'm-h2', agentStatus: 'streaming' });
    const w = sessionWaitingProduct('s-h2');
    expect(w).toEqual({ waiting: false, summary: '' });
  });

  it('回合已终态（done）+ 残留登记 → waiting=false（陈旧登记不误报）', () => {
    seedWaiting({ sessionId: 's-h3', streamId: 'ss-h3', messageId: 'm-h3', agentStatus: 'streaming' });
    reportWaiting('ss-h3', 'cargo build');
    getDb().prepare('UPDATE messages SET status = ? WHERE id = ?').run('done', 'm-h3');
    expect(listPendingWriteBlocked('s-h3')).toHaveLength(1); // 前置自证：登记仍在
    const w = sessionWaitingProduct('s-h3');
    expect(w!.waiting).toBe(false);
  });

  it('denyWrite 处置后 → waiting 恢复 false（重连/处置链路联动）', () => {
    seedWaiting({ sessionId: 's-h4', streamId: 'ss-h4', messageId: 'm-h4', agentStatus: 'streaming' });
    reportWaiting('ss-h4', 'rm -rf build');
    expect(sessionWaitingProduct('s-h4')!.waiting).toBe(true);
    clearPendingOnDeny('s-h4', ['/ws/wait/out']);
    expect(sessionWaitingProduct('s-h4')!.waiting).toBe(false);
  });

  it('防御：会话不存在 → 不炸，waiting=false', () => {
    expect(() => sessionWaitingProduct('sess-ghost')).not.toThrow();
    expect(sessionWaitingProduct('sess-ghost')!.waiting).toBe(false);
  });
});
