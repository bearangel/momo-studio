// electron/tests/task/steer-ipc.test.ts
//
// 任务生命周期 v2 P3 S3 回归锁（spec 2026-11-13 §8.2 steer 槽位 / 发起方侧）：
// task:steer IPC 契约 + steerTaskRouted 路由单点：
//   1) 载荷契约：channel task:steer 收 { taskId, message } 单对象
//   2) out 校验：任务不存在 / delegation_role≠'out' / delegation_id 空 /
//      message 空或超 4000 码点 → 人话拒且 forwarder 不被调
//   3) 转发载荷：{ delegationId, message(trim 后) } → hub task.steer（注入面锁定）
//   4) 错误透传：node_offline → CONTRACT #18「执行节点离线，稍后再试」；其余
//      hub 原文 / 本地错误原样抛；失败不落里程碑
//   5) 成功里程碑：跟踪会话（外派行 execution_session_id）落 delegation_milestone
//      行 kind='steered'（body 已下发指令全文 + meta.message ≤80 字摘要）+
//      pushSessionMessage 实时推；同文 10s 窗口防重（转发照发——指令非状态）
//   6) 无跟踪会话（execution_session_id 空）→ 里程碑跳过（warn 兜底）仍成功返回
//
// mock 边界（momo-test-rules #5，worker-steer-consume.test.ts 同款）：electron
// ipcMain 注册面 + stream-relay push；DB 真实（AP_USER_DATA_DIR 临时库）。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

interface IpcHandler {
  (event: unknown, ...args: unknown[]): Promise<unknown> | unknown;
}

const handlers = vi.hoisted(() => new Map<string, IpcHandler>());
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: IpcHandler): void => {
      handlers.set(channel, fn);
    },
  },
}));

const { pushSessionMessageMock } = vi.hoisted(() => ({
  pushSessionMessageMock: vi.fn<(msg: unknown) => void>(),
}));
vi.mock('../../src/main/agent/stream-relay', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/agent/stream-relay')>()),
  pushSessionMessage: (msg: unknown) => pushSessionMessageMock(msg),
}));

import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { insertTask } from '../../src/main/storage/tasks/repo';
import { insertSession } from '../../src/main/storage/sessions/repo';
import { RpcRemoteError } from '../../src/main/hub/client';
import {
  registerTaskHandlers,
  setSteerForwarder,
  steerTaskRouted,
  type RemoteSteerForwardInput,
} from '../../src/main/task/ipc.handlers';
import { __resetOriginSteerDedupeForTest } from '../../src/main/hub/remote-intervene-bridge';

const DELEGATION_ID = 'dl-steer-origin-1';
const tmpRoot = path.join(
  os.tmpdir(),
  `ap-steer-ipc-${Date.now()}-${Math.random().toString(36).slice(2)}`,
);

const forwarderMock = vi.fn<(input: RemoteSteerForwardInput) => Promise<void>>();

let trackingSessionId = '';

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  getDb()
    .prepare(`INSERT INTO workspaces (id, name, directory_path, owner_id) VALUES (?, ?, ?, ?)`)
    .run('ws1', 'Test', '/tmp', '@owner:home');
  trackingSessionId = insertSession({ workspaceId: 'ws1', title: '跟踪', kind: 'chat' }).id;
  __resetOriginSteerDedupeForTest();
  forwarderMock.mockReset().mockResolvedValue(undefined);
  setSteerForwarder(forwarderMock);
  pushSessionMessageMock.mockClear();
  handlers.clear();
  registerTaskHandlers();
});

afterEach(() => {
  setSteerForwarder(null);
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

/** 种外派行（delegation_role='out'，S6 跟踪会话 = execution_session_id） */
function seedOutTask(opts: { executionSessionId?: string; delegationId?: string } = {}): string {
  const t = insertTask({
    workspaceId: 'ws1',
    title: '委派任务',
    creatorUserId: '@owner:home',
    status: 'in_progress',
    executionSessionId: opts.executionSessionId ?? trackingSessionId,
    delegationId: opts.delegationId ?? DELEGATION_ID,
  });
  getDb().prepare(`UPDATE tasks SET delegation_role = 'out' WHERE id = ?`).run(t.id);
  return t.id;
}

function milestoneRows(sessionId: string): Array<{
  sender: string;
  body: string;
  task_id: string;
  context_json: string;
}> {
  return getDb()
    .prepare(
      `SELECT sender, body, task_id, context_json FROM messages
       WHERE session_id = ? AND event_type = 'delegation_milestone'`,
    )
    .all(sessionId) as Array<{ sender: string; body: string; task_id: string; context_json: string }>;
}

// ── 1/2. IPC 载荷契约 + out 校验 ────────────────────────────────────────────

describe('task:steer IPC 契约与校验', () => {
  it('channel 收 { taskId, message } 单对象 → 走 steerTaskRouted 单点', async () => {
    const taskId = seedOutTask();
    const handler = handlers.get('task:steer')!;
    await expect(
      handler(undefined, { taskId, message: '  补充：覆盖 seeds 表  ' }),
    ).resolves.toEqual({ ok: true });
    expect(forwarderMock).toHaveBeenCalledWith({
      delegationId: DELEGATION_ID,
      message: '补充：覆盖 seeds 表',
    });
  });

  it('任务不存在 → 人话拒', async () => {
    await expect(steerTaskRouted('T-miss', 'x')).rejects.toThrow('task T-miss 不存在');
    expect(forwarderMock).not.toHaveBeenCalled();
  });

  it("delegation_role='in' → 仅发起方可补充指令（forwarder 不调）", async () => {
    const t = insertTask({
      workspaceId: 'ws1', title: '承接', creatorUserId: '@owner:home', status: 'in_progress',
      delegationId: DELEGATION_ID,
    });
    getDb().prepare(`UPDATE tasks SET delegation_role = 'in' WHERE id = ?`).run(t.id);
    await expect(steerTaskRouted(t.id, 'x')).rejects.toThrow('仅发起方可对委派任务补充指令');
    expect(forwarderMock).not.toHaveBeenCalled();
  });

  it('本地行（无 delegation_role / delegation_id）→ 人话拒', async () => {
    const t = insertTask({ workspaceId: 'ws1', title: '本地', creatorUserId: '@owner:home' });
    await expect(steerTaskRouted(t.id, 'x')).rejects.toThrow('仅发起方可对委派任务补充指令');
    const out = seedOutTask({ delegationId: DELEGATION_ID });
    getDb().prepare(`UPDATE tasks SET delegation_id = NULL WHERE id = ?`).run(out);
    await expect(steerTaskRouted(out, 'x')).rejects.toThrow('任务未委派，无可送达的执行节点');
    expect(forwarderMock).not.toHaveBeenCalled();
  });

  it('任务 submitted（待裁决）→ 人话拒且 forwarder 不被调（DEC-11）', async () => {
    const taskId = seedOutTask();
    getDb().prepare(`UPDATE tasks SET status = 'submitted' WHERE id = ?`).run(taskId);
    await expect(steerTaskRouted(taskId, '先别动')).rejects.toThrow(
      '任务待验收，请先裁决（继续 / 完成 / 驳回）后再补充指令',
    );
    expect(forwarderMock).not.toHaveBeenCalled();
  });

  it('message 空 / 纯空白 / 超 4000 码点 → 人话拒（码点计非 UTF-16 单元）', async () => {
    const taskId = seedOutTask();
    await expect(steerTaskRouted(taskId, '')).rejects.toThrow('补充指令不能为空');
    await expect(steerTaskRouted(taskId, '   \n ')).rejects.toThrow('补充指令不能为空');
    await expect(steerTaskRouted(taskId, 'a'.repeat(4001))).rejects.toThrow('补充指令最多 4000 字');
    // 2001 个 emoji = 2001 码点 / 4002 UTF-16 单元——码点口径应放行
    await expect(steerTaskRouted(taskId, '😀'.repeat(2001))).resolves.toEqual({ ok: true });
    expect(forwarderMock).toHaveBeenCalledTimes(1);
  });

  it('转发器未装配（hub 域未接线）→ 人话拒', async () => {
    setSteerForwarder(null);
    const taskId = seedOutTask();
    await expect(steerTaskRouted(taskId, 'x')).rejects.toThrow('补充指令通道未就绪');
  });
});

// ── 4. 错误透传 ─────────────────────────────────────────────────────────────

describe('错误人话透传', () => {
  it('node_offline → CONTRACT #18 固定文案', async () => {
    const taskId = seedOutTask();
    forwarderMock.mockRejectedValue(new RpcRemoteError('node_offline', '目标节点不在线'));
    await expect(steerTaskRouted(taskId, 'x')).rejects.toThrow('执行节点离线，稍后再试');
  });

  it('其余协议码 / 本地错误 → hub 原文人话透传', async () => {
    const taskId = seedOutTask();
    forwarderMock.mockRejectedValueOnce(new RpcRemoteError('conflict', '任务已终态，不可补充指令'));
    await expect(steerTaskRouted(taskId, 'x')).rejects.toThrow('任务已终态，不可补充指令');
    forwarderMock.mockRejectedValueOnce(new Error('hub 未连接，请稍后重试'));
    await expect(steerTaskRouted(taskId, 'x')).rejects.toThrow('hub 未连接，请稍后重试');
  });

  it('发送失败不落里程碑', async () => {
    const taskId = seedOutTask();
    forwarderMock.mockRejectedValue(new RpcRemoteError('node_offline', '目标节点不在线'));
    await expect(steerTaskRouted(taskId, 'x')).rejects.toThrow();
    expect(milestoneRows(trackingSessionId)).toHaveLength(0);
    expect(pushSessionMessageMock).not.toHaveBeenCalled();
  });
});

// ── 5/6. 成功里程碑（发起方本地写）──────────────────────────────────────────

describe('成功里程碑（跟踪会话本地写）', () => {
  it('kind=steered 行：body 全文 + meta.message ≤80 字摘要 + pushSessionMessage', async () => {
    const taskId = seedOutTask();
    const message = '回滚语句要覆盖 seeds 表；旧 token 保留 30 天过渡期，先别直接删。';
    await expect(steerTaskRouted(taskId, message)).resolves.toEqual({ ok: true });

    const rows = milestoneRows(trackingSessionId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.sender).toBe('system');
    expect(rows[0]!.task_id).toBe(taskId);
    expect(rows[0]!.body).toBe(`已下发指令：${message}`);
    const meta = JSON.parse(rows[0]!.context_json) as { kind: string; message: string };
    expect(meta.kind).toBe('steered');
    expect(meta.message).toBe(message);
    expect(pushSessionMessageMock).toHaveBeenCalledTimes(1);
  });

  it('超长指令 meta.message 截 80 字（含省略号），body 保留全文', async () => {
    const taskId = seedOutTask();
    const long = '甲'.repeat(120);
    await steerTaskRouted(taskId, long);
    const meta = JSON.parse(milestoneRows(trackingSessionId)[0]!.context_json) as {
      message: string;
    };
    expect(Array.from(meta.message)).toHaveLength(80); // 79 字 + '…'
    expect(meta.message.endsWith('…')).toBe(true);
    expect(milestoneRows(trackingSessionId)[0]!.body).toBe(`已下发指令：${long}`);
  });

  it('同文 10s 窗口防重：转发照发（指令非状态）、里程碑只落一行；异文照落', async () => {
    const taskId = seedOutTask();
    await steerTaskRouted(taskId, '同一条指令');
    await steerTaskRouted(taskId, '同一条指令');
    expect(forwarderMock).toHaveBeenCalledTimes(2);
    expect(milestoneRows(trackingSessionId)).toHaveLength(1);

    await steerTaskRouted(taskId, '另一条指令');
    expect(milestoneRows(trackingSessionId)).toHaveLength(2);
  });

  it('无跟踪会话（execution_session_id 空）→ 里程碑跳过，发送仍成功', async () => {
    const taskId = seedOutTask({ executionSessionId: '' });
    await expect(steerTaskRouted(taskId, 'x')).resolves.toEqual({ ok: true });
    expect(pushSessionMessageMock).not.toHaveBeenCalled();
  });
});
