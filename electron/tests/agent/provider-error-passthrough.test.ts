// provider 错误原文透传（M2.4 T2）回归锁：
//   ① 生产链——`watchTurnProduct` 从 message_events 最后一条 final 事件回填
//      `TurnTerminal.error`（provider 401 原文不得死于主进程映射层）；
//   ② 脱敏——sk- / Bearer / token= 三形态；query token 仅在显式开关下脱敏
//      （快照侧默认关闭 = 行为零变更）；
//   ③ 截断——超 300 code point 用 Array.from 切、禁 slice 劈代理对，尾部 `…`；
//   ④ snapshot 侧回归由既有 `electron/tests/hub/snapshot-builder.test.ts` 承担
//      （本文件不改其断言）。
// 夹具纪律（momo-test-rules #5）：进程/会话执行边界收窄 mock，DB 查询走真实
// migrations 表（与 delegation-ports.test 同款）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] },
}));
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
import { watchTurnProduct } from '../../src/main/hub/delegation-ports';
import {
  createDelegationRunner,
  type AssignedTaskEvent,
  type DelegationRunPorts,
  type TurnTerminal,
} from '../../src/main/hub/delegation-runner';
import { createHubDelegationSettingsStore } from '../../src/main/hub/delegation-settings';
import { createHubDelegationStore } from '../../src/main/hub/delegation-store';
import type { TaskReportPayload } from '../../src/main/hub/delegation-wire';
import { redactSecrets, truncateCodePoints } from '../../src/main/util/redact';

/** provider 401 原文（与 llm-provider.buildStreamErrorMessage 同形：主文案 + ||details|| + HTTP 状态/响应体） */
const PROVIDER_401 =
  '模型服务连接失败：API Key 无效或无权限，请到设置中检查供应商密钥。本轮未完成，发送「继续」可从断点恢复' +
  '\n||details||\nHTTP 401 Unauthorized: {"error":{"message":"invalid api key"}}';

// ── 环境脚手架（delegation-ports.test 同款） ────────────────────────────────

let tmpRoot = '';
const memStore = new Map<string, string>();
const memKeychain: KeychainImpl = {
  async setSecret(k, v) { memStore.set(k, v); },
  async getSecret(k) { return memStore.get(k) ?? null; },
  async deleteSecret(k) { memStore.delete(k); },
};

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-provider-error-'));
  process.env.AP_USER_DATA_DIR = tmpRoot;
  setKeychainImpl(memKeychain);
  runMigrations();
});
afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  memStore.clear();
});

/** 直插消息行（watchTurn 观测表） */
function insertMessage(input: {
  sessionId: string;
  sender: string;
  status: string;
  streamSessionId: string;
  createdAt: number;
}): string {
  const id = `msg-${randomUUID().slice(0, 8)}`;
  getDb()
    .prepare(
      `INSERT INTO messages (id, session_id, sender, event_type, body, stream_session_id,
         parent_stream_session_id, segment_of, status, created_at, updated_at)
       VALUES (?, ?, ?, 'text', '', ?, NULL, NULL, ?, ?, ?)`,
    )
    .run(id, input.sessionId, input.sender, input.streamSessionId, input.status, input.createdAt, input.createdAt);
  return id;
}

/** 直插流事件（message_events） */
function insertEvent(messageId: string, eventType: string, payloadJson: string): void {
  getDb()
    .prepare(
      'INSERT INTO message_events (id, message_id, seq, event_type, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(`evt-${randomUUID().slice(0, 8)}`, messageId, Math.floor(Math.random() * 1e6), eventType, payloadJson, Date.now());
}

// ── ① 生产链：401 原文从 final 事件回填 TurnTerminal.error ─────────────────

describe('① provider 错误原文透传（有救：读侧映射补 error）', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('watchTurnProduct 从最后一条 final 事件回填 error（含 401 原文，非 undefined）', async () => {
    const sessionId = 'sess-401';
    // 先 attach（基线之后落库的行才属本回合观测面）
    const terminals: TurnTerminal[] = [];
    const dispose = watchTurnProduct(sessionId, (t) => { terminals.push(t); });
    const messageId = insertMessage({
      sessionId,
      sender: 'agent-coder',
      status: 'failed',
      streamSessionId: 'st-401',
      createdAt: 1000,
    });
    // 与 stream-relay 'end' 分支同形状：final payload 携带 error 原文
    insertEvent(messageId, 'final', JSON.stringify({ status: 'failed', error: PROVIDER_401 }));

    await vi.advanceTimersByTimeAsync(1500);
    dispose();

    expect(terminals).toHaveLength(1);
    expect(terminals[0]!.status).toBe('failed');
    expect(terminals[0]!.error).toContain('401');
    expect(terminals[0]!.error).toContain('invalid api key');
  });

  it('无 final 事件（陈旧/兜底终态行）→ error 缺席，交回真兜底', async () => {
    const sessionId = 'sess-no-final';
    const terminals: TurnTerminal[] = [];
    const dispose = watchTurnProduct(sessionId, (t) => { terminals.push(t); });
    insertMessage({ sessionId, sender: 'agent-coder', status: 'failed', streamSessionId: 'st-x', createdAt: 1000 });

    await vi.advanceTimersByTimeAsync(1500);
    dispose();

    expect(terminals).toHaveLength(1);
    expect(terminals[0]!.error).toBeUndefined();
  });

  it('委派 reason 携带 401 原文（非「未知错误」），本机账本与 hub 上报同源', async () => {
    const h = makeRunnerHarness();
    await h.admit('t-401');
    h.fireTerminal('sess-1', { status: 'failed', error: PROVIDER_401 });

    const failed = h.reports.find((r) => r.taskId === 't-401' && r.payload.status === 'failed');
    expect(failed).toBeDefined();
    expect(failed!.payload.reason).toContain('401');
    expect(failed!.payload.reason).not.toContain('未知错误');
    expect(h.store.get('t-401')?.reason).toBe(failed!.payload.reason);
  });

  it('委派 reason 超长：红act 后 ≤301 code point（含 …），不劈代理对', async () => {
    const h = makeRunnerHarness();
    await h.admit('t-long');
    h.fireTerminal('sess-1', { status: 'failed', error: `HTTP 500 ${'😀'.repeat(400)}` });

    const failed = h.reports.find((r) => r.taskId === 't-long' && r.payload.status === 'failed');
    const reason = failed!.payload.reason!;
    expect(Array.from(reason).length).toBeLessThanOrEqual(301);
    expect(reason.endsWith('…')).toBe(true);
    // 孤立代理对检测（截断点必须落在 code point 边界）
    expect(reason).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(reason).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    expect(h.store.get('t-long')?.reason).toBe(reason);
  });
});

// ── ② 脱敏三形态 ───────────────────────────────────────────────────────────

describe('② redactSecrets 脱敏', () => {
  it('sk- / Bearer / ghp_ / xox / 64 位十六进制均替换为 ***', () => {
    expect(redactSecrets('key=sk-abcdefghijklmnop1234')).toBe('key=***');
    expect(redactSecrets('Authorization: Bearer abcdefghijklmnop')).toBe('Authorization: ***');
    expect(redactSecrets('t ghp_abcdefghijklmnopqrst')).toBe('t ***');
    expect(redactSecrets('slack xoxb-1234567890-abcdef')).toBe('slack ***');
    expect(redactSecrets(`sha ${'a'.repeat(64)}`)).toBe('sha ***');
  });

  it('token= 形态：includeQueryToken=true 才脱敏；默认关闭（快照侧行为零变更）', () => {
    const url = 'https://hub.example/api?token=abcdef0123456789&x=1';
    expect(redactSecrets(url)).toBe(url); // 默认不碰 query token
    expect(redactSecrets(url, { includeQueryToken: true })).toBe('https://hub.example/api?***&x=1');
    expect(redactSecrets('access_token=secret-value-123', { includeQueryToken: true })).toBe('***');
  });

  it('空串/无敏感形态原样返回（不误伤普通文本）', () => {
    expect(redactSecrets('')).toBe('');
    expect(redactSecrets('模型服务连接失败：HTTP 401')).toBe('模型服务连接失败：HTTP 401');
  });
});

// ── ③ code point 截断 ─────────────────────────────────────────────────────

describe('③ truncateCodePoints', () => {
  it('301+ code point → 300 + …（共 301），代理对完整', () => {
    const out = truncateCodePoints('😀'.repeat(400));
    expect(Array.from(out).length).toBe(301);
    expect(out.endsWith('…')).toBe(true);
    expect(out).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(out).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  });

  it('CJK 混排同样按 code point 计（300 边界不提前/不滞后）', () => {
    const src = `前缀${'修'.repeat(299)}`;
    const out = truncateCodePoints(src);
    expect(Array.from(out).length).toBe(301);
    expect(out).toBe(`${Array.from(src).slice(0, 300).join('')}…`);
  });

  it('≤300 原样返回（不补省略号）', () => {
    const src = '执'.repeat(300);
    expect(truncateCodePoints(src)).toBe(src);
    expect(truncateCodePoints('短文本')).toBe('短文本');
  });
});

// ── 委派执行器最小测试台（真实 store/设置 + 端口桩） ────────────────────────

function makeRunnerHarness(): {
  admit: (taskId: string) => Promise<void>;
  fireTerminal: (sessionId: string, t: TurnTerminal) => void;
  reports: Array<{ taskId: string; payload: TaskReportPayload }>;
  store: ReturnType<typeof createHubDelegationStore>;
} {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE IF NOT EXISTS kv_store (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT)');
  const settings = createHubDelegationSettingsStore(db);
  const store = createHubDelegationStore(db);
  const watchers = new Map<string, (t: TurnTerminal) => void>();
  const reports: Array<{ taskId: string; payload: TaskReportPayload }> = [];

  const ports: DelegationRunPorts = {
    settings: () => settings.read(),
    findWorkspaceByName: (name) => (name === 'ws-a' ? { id: 'ws-1', name } : null),
    resolveAgentInstance: () => 'inst-default',
    createDelegatedSession: () => 'sess-1',
    applyRunPolicy: () => undefined,
    sessionWaiting: () => null,
    injectSteer: () => undefined,
    startTurn: async () => undefined,
    stopSession: () => undefined,
    watchTurn: (sessionId, onTerminal) => {
      watchers.set(sessionId, onTerminal);
      return () => { watchers.delete(sessionId); };
    },
    sessionTail: () => null,
    report: async (taskId, payload) => {
      reports.push({ taskId, payload });
      return true;
    },
    listInterruptedDelegations: async () => [],
  };

  const runner = createDelegationRunner({ ports, store, tickMs: 500 });
  const evt = (taskId: string): AssignedTaskEvent => ({
    taskId,
    workspaceName: 'ws-a',
    task: { title: '修复登录超时', prompt: '请排查并修复登录超时问题。' },
    byNode: 'node-leader',
  });

  return {
    admit: async (taskId) => { await runner.handleAssigned(evt(taskId)); },
    fireTerminal: (sessionId, t) => { watchers.get(sessionId)?.(t); },
    reports,
    store,
  };
}
