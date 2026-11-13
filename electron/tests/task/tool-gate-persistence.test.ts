// electron/tests/task/tool-gate-persistence.test.ts
//
// 写授权卡持久化接线契约锁（任务生命周期 v2 Task 13，spec §6.2/§6.8）。
// 覆盖（brief Step 1 五用例）：
//   1) 双写：WriteBlockedSignal → human_requests 行落库（kind=tool_gate、payload
//      含 command/dirs、deny_and_wrap、deadline≈+15min、title 含命令摘要）
//      + 内存 pending 注册表照旧（readonly 即时拒 / 未归属卡不落库）
//   2) 面板答复 approve → answerHuman → grantWriteDirs('session') 等价调用
//      （dirs 来自 payload）+ 请求 answered + pending 清理
//   3) 答复 deny → deny 广播（broadcastWriteGrantDenied 同源）+ 请求 answered
//      + pending 清理
//   4) 重启恢复：pending tool_gate 且会话无在库等待（无内存登记）→ markExpired；
//      会话仍有活等待的行保留；非 tool_gate 行不动
//   5) sweeper 联动（Task 12）：deny_and_wrap 到期 → system:timeout 答复
//      + deny 广播路径触发
// 隔离：沿 write-blocked-emit.test.ts 形态（electron API 假件 + deny 广播 spy）
// ＋ lifecycle-runs-human.test.ts 形态（router 边界打桩）；DB 真实。
import { describe, it, expect, beforeEach, afterEach, vi, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// electron API 假件（照 write-blocked-emit.test 形态——进程边界 DI）
const mockSend = vi.fn();
import { __setElectronApisForTest } from '../../src/main/electron-access';

// deny 广播链注入（生产接线在 delegation-runner 装载期；测试直注 spy）
const { mockBroadcastDeny } = vi.hoisted(() => ({ mockBroadcastDeny: vi.fn((): boolean => false) }));

// router 边界打桩：tool_gate 答复不走唤醒，但 lifecycle-runs 模块图会装载
// router-bootstrap——打桩保持测试图轻量且不依赖 RouterService 单例态
vi.mock('../../src/main/agent/router-bootstrap', () => ({
  getRouterService: () => null,
}));

import {
  writeBlockedFromChildMsg,
  listPendingWriteBlocked,
  markSessionReadonly,
  setWriteDeniedBroadcaster,
  handleToolGateAnswer,
  recoverOrphanToolGates,
  __resetInspectStateForTest,
} from '../../src/main/sandbox/write-blocked-emit';
import { getGrantedDirs, __clearWriteGrantsForTest } from '../../src/main/sandbox/write-grant';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import {
  insertHumanRequest,
  getHumanRequest,
} from '../../src/main/storage/tasks/human-requests-repo';
import type { HumanRequestRow } from '../../src/main/storage/tasks/human-requests-repo';
import { answerHuman, setToolGateHandler } from '../../src/main/task/lifecycle-runs';
import { sweepHumanTimeouts } from '../../src/main/task/human-timeout-sweeper';

setWriteDeniedBroadcaster(mockBroadcastDeny);

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

const tmpRoot = path.join(os.tmpdir(), `tool-gate-persistence-${Date.now()}-${Math.random().toString(36).slice(2)}`);

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  __resetInspectStateForTest();
  __clearWriteGrantsForTest();
  mockBroadcastDeny.mockClear();
  mockSend.mockClear();
});
afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

/** 种工作空间 + 会话 + 归属消息行（resolveStreamOwner 解析 sessionId 的前提） */
function seedSession(opts: { wsId: string; sessionId: string; streamId: string; messageId?: string }): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO workspaces (id, name, directory_path, owner_id) VALUES (?, ?, ?, ?)`,
  ).run(opts.wsId, opts.wsId, `/ws/${opts.wsId}`, 'u-test');
  db.prepare(
    `INSERT INTO sessions (id, workspace_id, title, title_auto, kind, created_at, updated_at)
     VALUES (?, ?, '写授权测试会话', 0, 'chat', 1, 1)`,
  ).run(opts.sessionId, opts.wsId);
  db.prepare(
    `INSERT INTO messages (id, session_id, sender, event_type, body, stream_session_id, status, source, created_at, updated_at)
     VALUES (?, ?, 'agent-coder-66XMEw', 'm.room.message', '', ?, 'streaming', 'local', 1, 1)`,
  ).run(opts.messageId ?? `m-${opts.sessionId}`, opts.sessionId, opts.streamId);
}

/** 会话内唯一 tool_gate 行（snake_case 原始行 → 断言用字段直取；rowToCamel 为 repo 私有） */
function latestToolGateRow(sessionId: string): HumanRequestRow {
  const rows = getDb()
    .prepare(`SELECT * FROM human_requests WHERE session_id = ? AND kind = 'tool_gate'`)
    .all(sessionId) as Array<Record<string, unknown>>;
  expect(rows).toHaveLength(1);
  const raw = rows[0]!;
  return {
    id: raw.id as string,
    kind: 'tool_gate',
    status: raw.status as HumanRequestRow['status'],
    sessionId: raw.session_id as string,
    taskId: raw.task_id as string | null,
    title: raw.title as string,
    payloadJson: raw.payload_json as string | null,
    deadlineAt: raw.deadline_at as number | null,
    timeoutPolicy: raw.timeout_policy as HumanRequestRow['timeoutPolicy'],
  } as HumanRequestRow;
}

// ═══ 1) 双写：信号产生 → DB 行 + 内存登记 ═══
describe('1) WriteBlockedSignal → human_requests 落库（双写）', () => {
  it('childMsg 上报 → 行落库（kind/payload/policy/deadline/title）+ 内存注册表照旧', () => {
    seedSession({ wsId: 'ws1', sessionId: 's-g1', streamId: 'ss-g1' });
    const before = Date.now();

    writeBlockedFromChildMsg({
      type: 'write-blocked-report',
      streamSessionId: 'ss-g1',
      workspaceId: 'ws1',
      dirs: ['/ws/ws1/out'],
      command: 'mkdir -p out',
    });

    // DB 侧：一行 tool_gate 请求，载荷/策略/期限/标题齐备
    const row = latestToolGateRow('s-g1');
    expect(row.status).toBe('pending');
    expect(row.taskId).toBeNull();
    expect(row.timeoutPolicy).toBe('deny_and_wrap');
    expect(row.deadlineAt).toBeGreaterThan(before + 14 * 60_000);
    expect(row.deadlineAt).toBeLessThan(Date.now() + 16 * 60_000);
    expect(row.title).toContain('mkdir -p out');
    expect(JSON.parse(row.payloadJson!)).toEqual({
      toolGate: { toolName: 'bash', command: 'mkdir -p out', dirs: ['/ws/ws1/out'] },
    });
    // 内存侧：注册表照旧（100% 不变——covered 轮询子进程仍经原 grant 路径解除）
    expect(listPendingWriteBlocked('s-g1')).toHaveLength(1);
  });

  it('超长命令的 title 截断（摘要上限），payload 内 command 保持 200 截断原文', () => {
    seedSession({ wsId: 'ws2', sessionId: 's-g2', streamId: 'ss-g2' });
    const longCmd = 'x'.repeat(200);
    writeBlockedFromChildMsg({
      type: 'write-blocked-report',
      streamSessionId: 'ss-g2',
      workspaceId: 'ws2',
      dirs: ['/ws/ws2/a'],
      command: longCmd,
    });
    const row = latestToolGateRow('s-g2');
    expect(row.title.length).toBeLessThanOrEqual(70); // 「写授权：」+ 命令摘要（截断）
    expect(JSON.parse(row.payloadJson!).toolGate.command).toBe(longCmd);
  });

  it('未归属卡（sessionId null）与 readonly 即时拒：不落库（等待语义与既有链不变）', () => {
    // 流查无消息行 → sessionId null → 不落库（FK NOT NULL；由 renderer 卡自弃承载）
    writeBlockedFromChildMsg({
      type: 'write-blocked-report',
      streamSessionId: 'ss-ghost',
      workspaceId: 'ws-x',
      dirs: ['/x'],
      command: 'true',
    });
    expect(getDb().prepare(`SELECT COUNT(*) AS n FROM human_requests`).get()).toEqual({ n: 0 });

    // readonly 会话：即时拒路径在落库前返回
    seedSession({ wsId: 'ws3', sessionId: 's-ro', streamId: 'ss-ro' });
    markSessionReadonly('s-ro', true);
    writeBlockedFromChildMsg({
      type: 'write-blocked-report',
      streamSessionId: 'ss-ro',
      workspaceId: 'ws3',
      dirs: ['/ws/ws3/b'],
      command: 'git push',
    });
    expect(listPendingWriteBlocked('s-ro')).toHaveLength(0);
    expect(
      getDb().prepare(`SELECT COUNT(*) AS n FROM human_requests WHERE session_id = ?`).get('s-ro'),
    ).toEqual({ n: 0 });
  });
});

// ═══ 2) approve：答复驱动授权 ═══
describe('2) 面板答复 approve → 授权 + 请求 answered + pending 清理', () => {
  it('answerHuman(approve) → grantWriteDirs(session, payload dirs) + 行 answered + 注册表清空', () => {
    seedSession({ wsId: 'ws4', sessionId: 's-ap', streamId: 'ss-ap' });
    writeBlockedFromChildMsg({
      type: 'write-blocked-report',
      streamSessionId: 'ss-ap',
      workspaceId: 'ws4',
      dirs: ['/ws/ws4/out'],
      command: 'cargo build',
    });
    const row = latestToolGateRow('s-ap');
    expect(listPendingWriteBlocked('s-ap')).toHaveLength(1);

    // 模拟生产装配（registerSandboxIpc）：tool_gate 分派 → 本模块 handler
    setToolGateHandler(handleToolGateAnswer);
    try {
      const disp = answerHuman(row.id, { decision: 'approve' }, 'user:panel');
      expect(disp).toEqual({ disposition: 'answered' });

      expect(getHumanRequest(row.id)!.status).toBe('answered');
      // 会话级授权落 KV（grantWriteDirs('session') 等价——covered 轮询子进程解除）
      expect(getGrantedDirs('s-ap', null)).toContain('/ws/ws4/out');
      // 内存注册表同步清理（clearPendingOnGrant 等价）
      expect(listPendingWriteBlocked('s-ap')).toHaveLength(0);
      // approve 不走 deny 广播
      expect(mockBroadcastDeny).not.toHaveBeenCalled();
    } finally {
      setToolGateHandler(null);
    }
  });
});

// ═══ 3) deny：答复驱动拒绝 ═══
describe('3) 面板答复 deny → deny 广播 + 请求 answered + pending 清理', () => {
  it('answerHuman(deny) → deniedBroadcaster(payload dirs) + 行 answered + 注册表清空', () => {
    seedSession({ wsId: 'ws5', sessionId: 's-dn', streamId: 'ss-dn' });
    writeBlockedFromChildMsg({
      type: 'write-blocked-report',
      streamSessionId: 'ss-dn',
      workspaceId: 'ws5',
      dirs: ['/ws/ws5/secret'],
      command: 'rm -rf /ws/ws5/secret',
    });
    const row = latestToolGateRow('s-dn');

    setToolGateHandler(handleToolGateAnswer);
    try {
      const disp = answerHuman(row.id, { decision: 'deny', reason: '不给' }, 'user:panel');
      expect(disp).toEqual({ disposition: 'answered' });

      expect(getHumanRequest(row.id)!.status).toBe('answered');
      // deny 广播（生产 = broadcastWriteGrantDenied——子进程等待按目录相交解除）
      expect(mockBroadcastDeny).toHaveBeenCalledWith(['/ws/ws5/secret']);
      expect(listPendingWriteBlocked('s-dn')).toHaveLength(0);
      // deny 不落授权 KV
      expect(getGrantedDirs('s-dn', null)).toEqual([]);
    } finally {
      setToolGateHandler(null);
    }
  });
});

// ═══ 4) 重启恢复：孤儿 tool_gate 过期 ═══
describe('4) recoverOrphanToolGates：无在库等待的 pending tool_gate → expired', () => {
  it('孤儿行 expired；会话仍有活等待（内存登记）的行保留；非 tool_gate 行不动', () => {
    // 会话 A：直接种 pending tool_gate 行（模拟重启后 DB 残留——本进程无等待）
    seedSession({ wsId: 'ws6', sessionId: 's-orphan', streamId: 'ss-orphan' });
    const orphan = insertHumanRequest({
      sessionId: 's-orphan',
      kind: 'tool_gate',
      title: '写授权：旧命令',
      payloadJson: JSON.stringify({ toolGate: { toolName: 'bash', command: '旧命令', dirs: ['/old'] } }),
      timeoutPolicy: 'deny_and_wrap',
    });
    // 会话 B：本进程有活等待（childMsg 上报 → 双写行 + 内存登记俱在）
    seedSession({ wsId: 'ws7', sessionId: 's-live', streamId: 'ss-live' });
    writeBlockedFromChildMsg({
      type: 'write-blocked-report',
      streamSessionId: 'ss-live',
      workspaceId: 'ws7',
      dirs: ['/ws/ws7/out'],
      command: 'mkdir out',
    });
    const liveRow = latestToolGateRow('s-live');
    // 会话 C：pending question 行（非 tool_gate——不该被孤儿回收触碰）
    const question = insertHumanRequest({
      sessionId: 's-orphan',
      kind: 'question',
      title: '顺便问下',
      timeoutPolicy: 'keep_waiting',
    });

    const res = recoverOrphanToolGates();

    expect(res).toEqual({ expired: 1 });
    expect(getHumanRequest(orphan.id)!.status).toBe('expired');
    expect(getHumanRequest(liveRow.id)!.status).toBe('pending');
    expect(getHumanRequest(question.id)!.status).toBe('pending');
  });
});

// ═══ 5) sweeper 联动（Task 12）：deny_and_wrap 到期自动拒 ═══
describe('5) sweeper 自动拒绝 → deny 广播路径触发（T12 联动）', () => {
  it('到期 tool_gate → system:timeout 答复 + deniedBroadcaster(payload dirs) + pending 清理', () => {
    seedSession({ wsId: 'ws8', sessionId: 's-sw', streamId: 'ss-sw' });
    writeBlockedFromChildMsg({
      type: 'write-blocked-report',
      streamSessionId: 'ss-sw',
      workspaceId: 'ws8',
      dirs: ['/ws/ws8/out'],
      command: 'npm install',
    });
    const row = latestToolGateRow('s-sw');
    // 推 deadline 至过去（生产由 15min 自然到期；测试直接改库控制时刻）
    getDb().prepare(`UPDATE human_requests SET deadline_at = ? WHERE id = ?`).run(Date.now() - 1000, row.id);

    setToolGateHandler(handleToolGateAnswer);
    try {
      const res = sweepHumanTimeouts();
      expect(res.processed).toBe(1);

      const after = getHumanRequest(row.id)!;
      expect(after.status).toBe('answered');
      expect(after.answeredByNodeId).toBe('system:timeout');
      expect(mockBroadcastDeny).toHaveBeenCalledWith(['/ws/ws8/out']);
      expect(listPendingWriteBlocked('s-sw')).toHaveLength(0);
    } finally {
      setToolGateHandler(null);
    }
  });
});
