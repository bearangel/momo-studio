// electron/tests/sandbox/write-blocked-emit.test.ts
// 主进程事件检测（spec 2026-10-03 §5.1/§5.3）：批次 tool_call_result 命中 →
// 组装 writeBlocked 信号（command 跨批环形缓存关联；session/ws 经 messages 解析）。
import { describe, it, expect, beforeEach, afterEach, vi, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// electron API 假件（照 stream-relay.test 形态——进程边界 DI）
const mockSend = vi.fn();
import { __setElectronApisForTest } from '../../src/main/electron-access';

beforeAll(() => {
  __setElectronApisForTest({
    BrowserWindow: {
      getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: mockSend } }],
    },
    ipcMain: { handle: vi.fn() },
  });
});
afterAll(() => {
  __setElectronApisForTest(null);
});
import {
  inspectEventBatch,
  writeBlockedFromChildMsg,
  listPendingWriteBlocked,
  clearPendingOnGrant,
  clearPendingOnDeny,
  __resetInspectStateForTest,
} from '../../src/main/sandbox/write-blocked-emit';
import type { MessageEventRow } from '../../src/main/storage/messages/events-repo';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';

const tmpRoot = path.join(os.tmpdir(), `write-blocked-emit-test-${Date.now()}`);

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  __resetInspectStateForTest();
});
afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

let seq = 0;
function mkStart(callId: string, command: string): MessageEventRow {
  seq += 1;
  return {
    id: `e-${callId}-s-${seq}`, messageId: 'm-1', seq, eventType: 'tool_call_start',
    payload: { callId, toolName: 'bash', args: { command } }, createdAt: Date.now(),
  };
}
function mkResult(callId: string, result: string): MessageEventRow {
  seq += 1;
  return {
    id: `e-${callId}-r-${seq}`, messageId: 'm-1', seq, eventType: 'tool_call_result',
    payload: { callId, toolName: 'bash', result, success: false }, createdAt: Date.now(),
  };
}

// 语料用真实 home（emit 内部取 os.homedir()——HOME 一级归并分支）。
// result 为子进程拼好的完整形态：exit_code + sandbox tag 行（终审 I2 检测依据）+ stdout 错误段
const HOME = os.homedir();
const CARGO_FAIL = `exit_code: 1

sandbox: seatbelt/net-on

error: failed to open ${HOME}/.cargo/registry/cache/a.crate

Caused by:
  Operation not permitted (os error 1)`;

describe('inspectEventBatch（spec §5.3）', () => {
  it('start+result 同批：命中 → dirs 归一 + command 关联', () => {
    const sig = inspectEventBatch([mkStart('c1', 'cargo build'), mkResult('c1', CARGO_FAIL)]);
    expect(sig).not.toBeNull();
    expect(sig!.command).toBe('cargo build');
    expect(sig!.dirs).toEqual([path.join(HOME, '.cargo')]); // HOME 一级归一
  });

  it('start 先批、result 后批：环形缓存跨批关联 command', () => {
    expect(inspectEventBatch([mkStart('c2', 'cargo run')])).toBeNull();
    const sig = inspectEventBatch([mkResult('c2', CARGO_FAIL)]);
    expect(sig?.command).toBe('cargo run');
  });

  it('非 bash / 未命中签名批次 → null', () => {
    const nonBash: MessageEventRow = { ...mkResult('c3', CARGO_FAIL), payload: { callId: 'c3', toolName: 'write_file', result: CARGO_FAIL } };
    expect(inspectEventBatch([nonBash])).toBeNull();
    expect(inspectEventBatch([mkResult('c4', 'ok output')])).toBeNull();
  });

  it('消息行在库：sessionId/workspaceId 经 messages 解析', () => {
    getDb()
      .prepare(
        'INSERT INTO messages (id, session_id, sender, event_type, body, stream_session_id, workspace_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run('m-1', 's-resolve', 'agent-x', 'message', '', 'ss-resolve', 'w-resolve', Date.now(), Date.now());
    const sig = inspectEventBatch([mkStart('c5', 'x'), mkResult('c5', CARGO_FAIL)]);
    expect(sig?.sessionId).toBe('s-resolve');
    expect(sig?.workspaceId).toBe('w-resolve');
  });


  it('result 文本无沙箱 tag 行（permissive/unsandboxed）→ 不触发（终审 I2）', () => {
    // 同样的 EPERM 文本但没有 sandbox: seatbelt|bwrap 行——真实系统权限错误不弹卡
    const plainFail = 'error: cannot write /etc/hosts\nOperation not permitted';
    expect(inspectEventBatch([mkStart('c-nb', 'touch /etc/hosts'), mkResult('c-nb', plainFail)])).toBeNull();
    const unsandboxedFail = 'exit_code: 1\n\nsandbox: unsandboxed:测试降级\n\nerror: Operation not permitted';
    expect(inspectEventBatch([mkStart('c-ns', 'x'), mkResult('c-ns', unsandboxedFail)])).toBeNull();
  });

  it('消息行缺失（无映射）→ sessionId/workspaceId null（卡按钮降级依据）', () => {
    const sig = inspectEventBatch([mkStart('c6', 'x'), mkResult('c6', CARGO_FAIL)]);
    expect(sig?.sessionId).toBeNull();
    expect(sig?.workspaceId).toBeNull();
  });

  it('command 截断 200（超长命令预览上限）', () => {
    const longCmd = 'x'.repeat(500);
    const sig = inspectEventBatch([mkStart('c7', longCmd), mkResult('c7', CARGO_FAIL)]);
    expect(sig?.command).toHaveLength(200);
  });
});


// ═══ 子进程上报消费（spec §12——等待开始即弹卡的主信号）═══
describe('writeBlockedFromChildMsg（spec §12）', () => {
  it('合法载荷 → 解析 sessionId（roll 语义）并推 sandbox:writeBlocked', () => {
    getDb()
      .prepare(
        'INSERT INTO messages (id, session_id, sender, event_type, body, stream_session_id, workspace_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run('m-rep', 's-rep', 'agent-x', 'message', '', 'ss-rep#roll1', 'w-rep', Date.now(), Date.now());
    mockSend.mockClear();
    const consumed = writeBlockedFromChildMsg({
      type: 'write-blocked-report',
      streamSessionId: 'ss-rep',
      workspaceId: 'w-rep',
      dirs: [path.join(os.homedir(), '.cargo')],
      command: 'cargo build',
    });
    expect(consumed).toBe(true);
    expect(mockSend).toHaveBeenCalledWith('sandbox:writeBlocked', {
      sessionId: 's-rep',
      workspaceId: 'w-rep',
      dirs: [path.join(os.homedir(), '.cargo')],
      command: 'cargo build',
      // F4 来源标注三件套（sender `agent-x` 无 -XXXXXX 后缀 → slug 'x'；会话行缺失 → title null）
      streamSessionId: 'ss-rep',
      sourceAgentName: 'x',
      sessionTitle: null,
    });
  });

  it('形状不符 → 返回 false（消息落回其他分支）；无窗口静默不抛', () => {
    expect(writeBlockedFromChildMsg({ type: 'other' })).toBe(false);
    expect(writeBlockedFromChildMsg('not-an-object')).toBe(false);
    expect(writeBlockedFromChildMsg({ type: 'write-blocked-report', dirs: 42 })).toBe(false);
  });
});

// === F4（2026-10-14 后台链授权卡死配套）：载荷来源标注三件套 ===
// streamSessionId / sourceAgentName / sessionTitle——两条上报链同源解析，
// 卡片与在途面板据此指明「谁在哪条流等授权」。
describe('writeBlockedFromChildMsg 载荷来源标注（F4）', () => {
  it('推送载荷带 streamSessionId + sender 提取的 agent 名 + 会话标题', () => {
    // seed：会话 + 子 agent 消息行（sender agent-<slug>-<rand> 形态）
    const db = getDb();
    db.prepare(
      `INSERT INTO workspaces (id, name, directory_path, owner_id)
       VALUES ('ws-1', 'dape', '/ws/dape', 'u-test')`,
    ).run();
    db.prepare(
      `INSERT INTO sessions (id, workspace_id, title, title_auto, kind, created_at, updated_at)
       VALUES ('s-f4', 'ws-1', '团队功能与分工介绍', 0, 'chat', 1, 1)`,
    ).run();
    db.prepare(
      `INSERT INTO messages (id, session_id, sender, event_type, body, stream_session_id, status, source, created_at, updated_at)
       VALUES ('m-f4-sub', 's-f4', 'agent-coder-66XMEw', 'm.room.message', '', 'ss-f4-sub', 'streaming', 'local', 1, 1)`,
    ).run();

    mockSend.mockClear();
    const handled = writeBlockedFromChildMsg({
      type: 'write-blocked-report',
      streamSessionId: 'ss-f4-sub',
      workspaceId: 'ws-1',
      dirs: ['/ws/out'],
      command: 'mkdir -p out',
    });
    expect(handled).toBe(true);
    expect(mockSend).toHaveBeenCalledTimes(1);
    const payload = mockSend.mock.calls[0]![1] as Record<string, unknown>;
    expect(payload.streamSessionId).toBe('ss-f4-sub');
    expect(payload.sourceAgentName).toBe('coder');
    expect(payload.sessionTitle).toBe('团队功能与分工介绍');
  });

  it('流查无消息行 → 三件套降级 null（不抛错不阻断推送）', () => {
    mockSend.mockClear();
    writeBlockedFromChildMsg({
      type: 'write-blocked-report',
      streamSessionId: 'ss-ghost',
      workspaceId: 'ws-1',
      dirs: ['/x'],
      command: 'true',
    });
    const payload = mockSend.mock.calls[0]![1] as Record<string, unknown>;
    expect(payload.streamSessionId).toBe('ss-ghost');
    expect(payload.sourceAgentName).toBeNull();
    expect(payload.sessionTitle).toBeNull();
  });
});

// === 2026-10-15 会话验收 P1-1 回归锁：子链行（parent_stream_session_id 非 NULL）
// 的归属解析——旧 getLatestMessageByStreamSessionId 的 parent IS NULL 过滤对子链流
// 恒 null（会话允许禁用 + 来源标注丢失），resolveStreamContext 换 resolveStreamOwner
// 后四件套全解出。
describe('writeBlockedFromChildMsg 子链行归属解析（P1-1）', () => {
  function seedSubChainRow(): void {
    const db = getDb();
    db.prepare(
      `INSERT INTO workspaces (id, name, directory_path, owner_id)
       VALUES ('ws-p11', 'ws-p11', '/ws/p11', 'u-test')`,
    ).run();
    db.prepare(
      `INSERT INTO sessions (id, workspace_id, title, title_auto, kind, created_at, updated_at)
       VALUES ('s-p11', 'ws-p11', '团队协作创建问候文件', 0, 'chat', 1, 1)`,
    ).run();
    // 子链行形态（DB 实测）：parent_stream_session_id = PM 流 id（非 NULL）——
    // 旧解析的排除条件正中此行
    db.prepare(
      `INSERT INTO messages (id, session_id, sender, event_type, body, stream_session_id, parent_stream_session_id, workspace_id, status, source, created_at, updated_at)
       VALUES ('m-p11-sub', 's-p11', 'agent-general-assistant-Bu1uQw', 'm.room.message', '', 'ss-p11-sub', 'ss-p11-pm', 'ws-p11', 'streaming', 'local', 1, 1)`,
    ).run();
  }

  it('子链上报 → sessionId 非 null（会话允许可用）+ workspace 兜底解出 + 来源标注', () => {
    seedSubChainRow();
    mockSend.mockClear();
    const handled = writeBlockedFromChildMsg({
      type: 'write-blocked-report',
      streamSessionId: 'ss-p11-sub',
      // 子进程载荷缺 workspaceId（历史形态）→ 解析链兜底 ws-p11
      dirs: ['/private/tmp/momo-out'],
      command: 'write_file /tmp/momo-out/x.txt',
    });
    expect(handled).toBe(true);
    const payload = mockSend.mock.calls[0]![1] as Record<string, unknown>;
    expect(payload.sessionId).toBe('s-p11');
    expect(payload.workspaceId).toBe('ws-p11');
    expect(payload.sourceAgentName).toBe('general-assistant');
    expect(payload.sessionTitle).toBe('团队协作创建问候文件');
  });

  it('inspectEventBatch 迟到兜底链：子链 tool_call_result → sessionId 同样解出', () => {
    seedSubChainRow();
    // 事件行挂子链消息 id（真实时序：tool_call_result 落子链流的 messageId）
    const mkSubStart = mkStart('c-p11', 'write_file /tmp/momo-out/x.txt');
    const mkSubResult = mkResult('c-p11', CARGO_FAIL);
    const sig = inspectEventBatch([mkSubStart, mkSubResult].map((e) => ({
      ...e,
      messageId: 'm-p11-sub',
    })));
    expect(sig?.sessionId).toBe('s-p11');
    expect(sig?.sourceAgentName).toBe('general-assistant');
  });
});

// === M2.1 T11 L1b：未决写授权登记（主进程真源——委派执行器 sessionWaiting 消费）。
// 两条上报链（childMsg 等待即报 / inspectEventBatch 迟到兜底）都登记；
// grantWrite / denyWrite 处置清除（dirs 相交匹配）；15min TTL 惰性过期
// （renderer write-grant.store F3 同款语义——covered 轮询路径主进程不可观测，TTL 兜底）。
describe('未决写授权登记（T11 sessionWaiting 真源）', () => {
  function seedWaitingSession(sessionId: string, streamId: string, messageId = 'm-t11'): void {
    const db = getDb();
    db.prepare(
      `INSERT INTO workspaces (id, name, directory_path, owner_id)
       VALUES ('ws-t11', 't11', '/ws/t11', 'u-test')`,
    ).run();
    db.prepare(
      `INSERT INTO sessions (id, workspace_id, title, title_auto, kind, created_at, updated_at)
       VALUES (?, 'ws-t11', '委派任务会话', 0, 'chat', 1, 1)`,
    ).run(sessionId);
    db.prepare(
      `INSERT INTO messages (id, session_id, sender, event_type, body, stream_session_id, status, source, created_at, updated_at)
       VALUES (?, ?, 'agent-coder-66XMEw', 'm.room.message', '', ?, 'streaming', 'local', 1, 1)`,
    ).run(messageId, sessionId, streamId);
  }

  it('childMsg 上报即登记：listPendingWriteBlocked(sessionId) 命中（command/dirs/来源完整）', () => {
    seedWaitingSession('s-w1', 'ss-w1');
    writeBlockedFromChildMsg({
      type: 'write-blocked-report',
      streamSessionId: 'ss-w1',
      workspaceId: 'ws-t11',
      dirs: ['/ws/t11/out'],
      command: 'mkdir -p out',
    });
    const pending = listPendingWriteBlocked('s-w1');
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ command: 'mkdir -p out', dirs: ['/ws/t11/out'], sourceAgentName: 'coder' });
    // 归属不到会话的查询不命中（跨会话隔离）
    expect(listPendingWriteBlocked('s-other')).toHaveLength(0);
  });

  it('inspectEventBatch 迟到兜底链同样登记', () => {
    seedWaitingSession('s-w2', 'ss-w2', 'm-t11-w2');
    const start = mkStart('c-w2', 'cargo build');
    const result = mkResult('c-w2', CARGO_FAIL);
    inspectEventBatch([start, result].map((e) => ({ ...e, messageId: 'm-t11-w2' })));
    const pending = listPendingWriteBlocked('s-w2');
    expect(pending).toHaveLength(1);
    expect(pending[0]!.command).toBe('cargo build');
  });

  it('grantWrite 处置清除：session scope + dirs 相交命中；scope/键不符或目录不相交不清', () => {
    seedWaitingSession('s-w3', 'ss-w3');
    writeBlockedFromChildMsg({
      type: 'write-blocked-report', streamSessionId: 'ss-w3', workspaceId: 'ws-t11',
      dirs: ['/ws/t11/a', '/ws/t11/b'], command: 'x',
    });
    // scope 键不符（别的会话）→ 不清
    clearPendingOnGrant('session', 's-other', ['/ws/t11/a']);
    expect(listPendingWriteBlocked('s-w3')).toHaveLength(1);
    // 目录不相交 → 不清（同会话另一张卡的场景）
    clearPendingOnGrant('session', 's-w3', ['/ws/t11/c']);
    expect(listPendingWriteBlocked('s-w3')).toHaveLength(1);
    // workspace scope 命中 + 目录相交 → 清
    clearPendingOnGrant('workspace', 'ws-t11', ['/ws/t11/b']);
    expect(listPendingWriteBlocked('s-w3')).toHaveLength(0);
  });

  it('denyWrite 处置清除：sessionId 匹配 + dirs 相交；sessionId null 时按目录全局匹配', () => {
    seedWaitingSession('s-w4', 'ss-w4');
    writeBlockedFromChildMsg({
      type: 'write-blocked-report', streamSessionId: 'ss-w4', workspaceId: 'ws-t11',
      dirs: ['/ws/t11/d'], command: 'y',
    });
    clearPendingOnDeny('s-w4', ['/unrelated']);
    expect(listPendingWriteBlocked('s-w4')).toHaveLength(1);
    clearPendingOnDeny('s-w4', ['/ws/t11/d']);
    expect(listPendingWriteBlocked('s-w4')).toHaveLength(0);

    // sessionId null（未归属卡拒绝）→ 目录相交即清
    writeBlockedFromChildMsg({
      type: 'write-blocked-report', streamSessionId: 'ss-w5', workspaceId: 'ws-t11',
      dirs: ['/ws/t11/e'], command: 'z',
    });
    clearPendingOnDeny(null, ['/ws/t11/e']);
    expect(listPendingWriteBlocked('s-w4')).toHaveLength(0);
  });

  it('15min TTL 惰性过期（查询时清扫超期条目）', () => {
    vi.useFakeTimers();
    try {
      seedWaitingSession('s-w6', 'ss-w6');
      writeBlockedFromChildMsg({
        type: 'write-blocked-report', streamSessionId: 'ss-w6', workspaceId: 'ws-t11',
        dirs: ['/ws/t11/f'], command: 'w',
      });
      expect(listPendingWriteBlocked('s-w6')).toHaveLength(1);
      vi.advanceTimersByTime(15 * 60 * 1000 + 1);
      expect(listPendingWriteBlocked('s-w6')).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
