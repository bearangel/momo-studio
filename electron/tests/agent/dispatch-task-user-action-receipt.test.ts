// electron/tests/agent/dispatch-task-user-action-receipt.test.ts
//
// 任务级取消/暂停回执真相化（2026-11-04 事故同构收尾，W4 残留缺口）：
// 用户从任务 UI 单独取消/暂停任务（不停止 agent runtime）时，任务流被
// abortTaskExecution 中断，但 dispatch 链曾保持 in_flight——233 秒后被
// sweepDead 误判成「子 agent 心跳超时」。与 W4（stopAgentRuntime 误判）同构。
// 本文件锁定新语义：
//   1. cancelTask / 任务级暂停（task:transition paused 分支同构驱动）→ 该任务
//      在途链立即以「任务已被用户取消/暂停」落终态 + 投递真实产出回执
//   2. 回执不出现「心跳超时」；标题行为「已被用户取消/已被用户暂停」
//   3. 无链普通任务取消 → no-op（无回执、无崩溃）
//   4. 幂等：任务级取消后 sweepDead 不翻案；agent 停止先落终态后取消迟到
//      → 均不产生第二份回执
//   5. 零活动任务 → 诚实零计数（「文件变更 0 处」「工具调用 0 次」）
//   6. 任务行投影权威（cancelled/paused 由 lifecycle transition 落定），
//      不被链 settle 覆盖成 failed
//
// 驱动链路保真（momo-test-rules）：真实 cancelTask / transitionTaskStatus +
// abortTaskExecution（= task:cancel / task:transition IPC handler 主体，IPC
// wrapper 与 assertNotDispatchRow 只读守卫不在语义面内）；真实 SQLite +
// RouterService / dispatchRegistry / dispatch-task-ledger；mock 仅 runner。
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// mock electron：stream-relay 的 BrowserWindow 推送在测试环境静默降级（同款模式）。
const { mockSend } = vi.hoisted(() => ({
  mockSend: vi.fn<(channel: string, payload?: unknown) => void>(),
}));

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: mockSend } }],
  },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
}));

import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { insertSession } from '../../src/main/storage/sessions/repo';
import { listMessagesBySession } from '../../src/main/storage/messages/repo';
import { getTask, transitionTaskStatus, insertTask } from '../../src/main/storage/tasks/repo';
import { insertToolCall } from '../../src/main/audit/insert';
import { __setElectronApisForTest } from '../../src/main/electron-access';
import {
  RouterService,
  setAgentStopHandler,
  setTaskUserActionHandler,
} from '../../src/main/agent/router-service';
import {
  dispatchRegistry,
  __resetDispatchRegistryForTest,
} from '../../src/main/agent/dispatch-registry';
import { ledgerInsertDispatch } from '../../src/main/agent/dispatch-task-ledger';
import { stopAgentRuntime } from '../../src/main/agent/runtime-registry';
import { cancelTask, abortTaskExecution } from '../../src/main/task/lifecycle';
import type { AgentRunner } from '../../src/main/agent/agent-runner';

const tmpRoot = path.join(
  os.tmpdir(),
  `ap-dispatch-task-action-${Date.now()}-${Math.random().toString(36).slice(2)}`,
);

let sessChatId = '';

/** PM runner mock（dispatch-user-stop-receipt 同款） */
function mkRunner(): { runner: AgentRunner; spies: { executeTask: Mock; notifyTaskReply: Mock } } {
  const executeTask = vi.fn(async (t: { streamSessionId: string }) => ({
    streamSessionId: t.streamSessionId,
  }));
  const notifyTaskReply = vi.fn(async (): Promise<void> => undefined);
  const runner = {
    executeTask,
    steer: vi.fn((): boolean => true),
    notifyTaskReply,
    get busy(): boolean {
      return false;
    },
  } as unknown as AgentRunner;
  return { runner, spies: { executeTask, notifyTaskReply } };
}

/** 种子：该 task_id 的审计 tool_calls 行（生产写入链） */
function seedAuditRows(taskId: string, n: number): void {
  for (let i = 0; i < n; i++) {
    insertToolCall({
      workspaceId: 'ws',
      agentBotUserId: 'agent-inst-sub',
      toolName: 'write_file',
      inputSummary: '',
      outputSummary: '',
      success: true,
      durationMs: 1,
      taskId,
    });
  }
}

/** 种子：该 task_id 的账本 journal_entries 行（生产写入链列形状） */
function seedJournalRows(taskId: string, n: number): void {
  const db = getDb();
  const stmt = db.prepare(
    `INSERT INTO journal_entries (id, workspace_id, task_id, stream_session_id, tool_name, path, op, created_at)
     VALUES (?, 'ws', ?, 'ss-jx', 'write_file', ?, 'create', ?)`,
  );
  for (let i = 0; i < n; i++) {
    stmt.run(`je-${taskId}-${i}`, taskId, `src/f${i}.ts`, Date.now());
  }
}

beforeEach(() => {
  mockSend.mockClear();
  __setElectronApisForTest({
    BrowserWindow: {
      getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: mockSend } }],
    },
  });
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  const db = getDb();
  db.prepare(`INSERT INTO workspaces (id, name, directory_path, owner_id) VALUES ('ws', 'T', '/tmp', '@o')`).run();
  for (const [inst, uid] of [['inst-pm', 'agent-pm-01'], ['inst-sub', 'agent-inst-sub']] as const) {
    db.prepare(
      `INSERT INTO agent_definitions
         (id, name, slug, version, runtime, system_prompt, default_tools, default_mcps,
          default_skills, source, description, icon_emoji, model_provider_id, model_name, task_driven)
       VALUES (?, ?, ?, '1.0.0', 'declarative', 'p', '[]', '[]', '[]', 'custom', '', '🤖', 'prov-1', 'm', 1)`,
    ).run(inst, inst, inst);
    db.prepare(
      `INSERT INTO workspace_agent_members (instance_id, workspace_id, agent_definition_id, agent_user_id)
       VALUES (?, 'ws', ?, ?)`,
    ).run(inst, inst, uid);
  }
  const sess = insertSession({ workspaceId: 'ws', title: 'task-action' });
  sessChatId = sess.id;
  __resetDispatchRegistryForTest();
});

afterEach(() => {
  setAgentStopHandler(null); // 用例内绑定必须在收尾解绑（模块级单例跨用例共享）
  setTaskUserActionHandler(null);
  __setElectronApisForTest(null);
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

describe('任务级取消/暂停回执（task-level user-action receipts）', () => {
  it('cancelTask → 在途链以「任务已被用户取消」落终态，回报真实产出，绝口不提心跳超时', async () => {
    seedAuditRows('T-tuc-1', 4);
    seedJournalRows('T-tuc-1', 3);
    ledgerInsertDispatch({
      taskId: 'T-tuc-1',
      body: '重构登录模块',
      pmAssignmentId: 'inst-pm',
      subAssignmentId: 'inst-sub',
      sessionId: sessChatId,
    });
    dispatchRegistry.register({
      taskId: 'T-tuc-1',
      pmAssignmentId: 'inst-pm',
      subAssignmentId: 'inst-sub',
      sessionId: sessChatId,
      isFollowupRound: true, // followup 恒投递——PM 显式在等答案（事故形态）
    });
    const { runner, spies } = mkRunner();
    const svc = new RouterService({ runners: new Map([['inst-pm', runner]]) });
    // 生产接线形态：bootstrap 把 RouterService 方法绑到模块级任务级动作处理器
    setTaskUserActionHandler((taskId, action) =>
      svc.settleChainForTaskUserAction(taskId, action),
    );

    // 真实入口（task:cancel handler 主体 = cancelTask）
    await cancelTask('T-tuc-1');

    // 投递发生：PM 收到自动送达输入
    await vi.waitFor(() => {
      expect(spies.executeTask).toHaveBeenCalledTimes(1);
    });
    const body = (spies.executeTask.mock.calls[0]![0] as { body: string }).body;
    // 契约字面量（momo-boundary-rules：回执文案是协议，字面断言锁死）
    expect(body).toContain('任务已被用户取消');
    expect(body).toContain('文件变更 3 处');
    expect(body).toContain('工具调用 4 次');
    expect(body).toContain('dispatch_followup');
    // 事故反面：绝不出现超时误判文案
    expect(body).not.toContain('心跳超时');
    // 标题行：已被用户取消是独立事实（非「已失败」）
    expect(body).toContain('已被用户取消');

    // 回执行落库：sender=system + taskId=链 ID（与既有回执同路）
    const rows = listMessagesBySession(sessChatId).filter(
      (r) => r.taskId === 'T-tuc-1' && r.body.includes('【dispatch 回执自动送达】'),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.sender).toBe('system');
    expect(rows[0]?.body).toContain('任务已被用户取消');

    // 同步等待立即解除：PM runner 收到 failed 回执（真身 body，非超时文案）
    const notified = spies.notifyTaskReply.mock.calls
      .map((c) => c[0] as { taskId: string; status: string; body: string })
      .find((n) => n.taskId === 'T-tuc-1');
    expect(notified).toBeDefined();
    expect(notified?.status).toBe('failed');
    expect(notified?.body).toContain('任务已被用户取消');

    // 链终态：done + userStopped + userStopKind（deliverChainResult 标题分支的依据）
    expect(dispatchRegistry.get('T-tuc-1')?.status).toBe('done');
    expect(dispatchRegistry.get('T-tuc-1')?.userStopped).toBe(true);
    expect(dispatchRegistry.get('T-tuc-1')?.userStopKind).toBe('task-cancelled');

    // 任务行投影权威：cancelled 由 cancelTask 的 transition 落定，不被覆盖成 failed
    const task = getTask('T-tuc-1');
    expect(task?.status).toBe('cancelled');
  });

  it('任务级暂停（task:transition paused 分支同构）→ 「任务已被用户暂停」回执，任务行维持 paused', async () => {
    seedAuditRows('T-tup-1', 1);
    seedJournalRows('T-tup-1', 2);
    ledgerInsertDispatch({
      taskId: 'T-tup-1',
      body: '任务暂停用例',
      pmAssignmentId: 'inst-pm',
      subAssignmentId: 'inst-sub',
      sessionId: sessChatId,
    });
    dispatchRegistry.register({
      taskId: 'T-tup-1',
      pmAssignmentId: 'inst-pm',
      subAssignmentId: 'inst-sub',
      sessionId: sessChatId,
      isFollowupRound: true,
    });
    const { runner, spies } = mkRunner();
    const svc = new RouterService({ runners: new Map([['inst-pm', runner]]) });
    setTaskUserActionHandler((taskId, action) =>
      svc.settleChainForTaskUserAction(taskId, action),
    );

    // 真实入口（task:transition handler paused 分支主体 = transition + abortTaskExecution）
    transitionTaskStatus('T-tup-1', 'paused');
    abortTaskExecution('T-tup-1');

    await vi.waitFor(() => {
      expect(spies.executeTask).toHaveBeenCalledTimes(1);
    });
    const body = (spies.executeTask.mock.calls[0]![0] as { body: string }).body;
    expect(body).toContain('任务已被用户暂停');
    expect(body).toContain('文件变更 2 处');
    expect(body).toContain('工具调用 1 次');
    expect(body).toContain('可在恢复任务后用 dispatch_followup');
    expect(body).not.toContain('心跳超时');
    // 标题行：已被用户暂停（非「已失败」）
    expect(body).toContain('已被用户暂停');

    // 链终态 + 任务行维持 paused（不被链 settle 覆盖）
    expect(dispatchRegistry.get('T-tup-1')?.status).toBe('done');
    expect(dispatchRegistry.get('T-tup-1')?.userStopKind).toBe('task-paused');
    expect(getTask('T-tup-1')?.status).toBe('paused');
  });

  it('无链普通任务取消 → no-op：无回执、无投递、不崩溃', async () => {
    // 普通 in_progress 任务（origin=user），执行会话与会话同址（广播无 runner 也是 no-op）
    const plain = insertTask({
      workspaceId: 'ws',
      title: '普通任务',
      creatorUserId: '@o',
      status: 'in_progress',
      executionSessionId: sessChatId,
    });
    const { runner, spies } = mkRunner();
    const svc = new RouterService({ runners: new Map([['inst-pm', runner]]) });
    setTaskUserActionHandler((taskId, action) =>
      svc.settleChainForTaskUserAction(taskId, action),
    );

    await cancelTask(plain.id);

    // 无链 → 无投递、无回执行；任务行正常 cancelled
    await new Promise((r) => setTimeout(r, 20));
    expect(spies.executeTask).not.toHaveBeenCalled();
    const receipts = listMessagesBySession(sessChatId).filter(
      (r) => r.body.includes('【dispatch 回执自动送达】'),
    );
    expect(receipts).toHaveLength(0);
    expect(getTask(plain.id)?.status).toBe('cancelled');
  });

  it('幂等：任务级取消后 sweepDead 不翻案——心跳静默 5 分钟也无第二份超时回执', async () => {
    vi.useFakeTimers();
    try {
      seedAuditRows('T-tuc-2', 2);
      ledgerInsertDispatch({
        taskId: 'T-tuc-2',
        body: '幂等用例',
        pmAssignmentId: 'inst-pm',
        subAssignmentId: 'inst-sub',
        sessionId: sessChatId,
      });
      dispatchRegistry.register({
        taskId: 'T-tuc-2',
        pmAssignmentId: 'inst-pm',
        subAssignmentId: 'inst-sub',
        sessionId: sessChatId,
        isFollowupRound: true,
      });
      const { runner, spies } = mkRunner();
      const svc = new RouterService({ runners: new Map([['inst-pm', runner]]) });
      setTaskUserActionHandler((taskId, action) =>
        svc.settleChainForTaskUserAction(taskId, action),
      );
      svc.start(); // 启动心跳死亡清扫计时器（60s 周期）

      // t=0 用户取消任务；随后心跳静默 5 分钟（远超 233 秒死亡阈值）
      await cancelTask('T-tuc-2');
      await vi.advanceTimersByTimeAsync(5 * 60_000);

      // 仍然只有 1 条回执行，且全文无「心跳超时」
      const rows = listMessagesBySession(sessChatId).filter((r) => r.taskId === 'T-tuc-2');
      const receipts = rows.filter((r) => r.body.includes('【dispatch 回执自动送达】'));
      expect(receipts).toHaveLength(1);
      expect(receipts[0]?.body).toContain('任务已被用户取消');
      expect(receipts[0]?.body).not.toContain('心跳超时');
      // PM 只被唤醒一次（无第二次「翻案」投递）
      expect(spies.executeTask).toHaveBeenCalledTimes(1);
      // 任务行仍是 cancelled（sweepDead 的 failed 投影没有打上来）
      expect(getTask('T-tuc-2')?.status).toBe('cancelled');

      svc.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('幂等：agent 停止先落终态，任务取消迟到 → 不产生第二份回执', async () => {
    seedAuditRows('T-tuc-3', 2);
    ledgerInsertDispatch({
      taskId: 'T-tuc-3',
      body: '停止在先用例',
      pmAssignmentId: 'inst-pm',
      subAssignmentId: 'inst-sub',
      sessionId: sessChatId,
    });
    dispatchRegistry.register({
      taskId: 'T-tuc-3',
      pmAssignmentId: 'inst-pm',
      subAssignmentId: 'inst-sub',
      sessionId: sessChatId,
      isFollowupRound: true,
    });
    const { runner, spies } = mkRunner();
    const svc = new RouterService({ runners: new Map([['inst-pm', runner]]) });
    // 生产接线形态：两个模块级处理器都绑到同一 RouterService
    setAgentStopHandler((instanceId) => svc.settleChainsOnAgentStop(instanceId));
    setTaskUserActionHandler((taskId, action) =>
      svc.settleChainForTaskUserAction(taskId, action),
    );

    // 先停止 agent（W4 语义：链 done + 「用户已主动停止」回执；任务行转 paused）
    await stopAgentRuntime('inst-sub');
    await vi.waitFor(() => {
      expect(spies.executeTask).toHaveBeenCalledTimes(1);
    });
    // 后取消任务（paused→cancelled 合法转换；链已终态 → settle 幂等 no-op）
    await cancelTask('T-tuc-3');
    await new Promise((r) => setTimeout(r, 20));

    // 只有一份回执行（W4 的用户停止回执），绝无第二份
    const receipts = listMessagesBySession(sessChatId).filter(
      (r) => r.taskId === 'T-tuc-3' && r.body.includes('【dispatch 回执自动送达】'),
    );
    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.body).toContain('用户已主动停止');
    expect(spies.executeTask).toHaveBeenCalledTimes(1);
    // 同步等待通知也只发生一次
    const notifies = spies.notifyTaskReply.mock.calls
      .map((c) => c[0] as { taskId: string })
      .filter((n) => n.taskId === 'T-tuc-3');
    expect(notifies).toHaveLength(1);
    // 链句柄保持 W4 落定态（未被任务级 settle 改写）
    expect(dispatchRegistry.get('T-tuc-3')?.userStopKind).toBe('runtime-stopped');
    // 任务行以迟到的取消动作为准（cancelled 终态）
    expect(getTask('T-tuc-3')?.status).toBe('cancelled');
  });

  it('零活动任务取消 → 诚实零计数（文件变更 0 处 · 工具调用 0 次）', async () => {
    ledgerInsertDispatch({
      taskId: 'T-tuc-0',
      body: '零活动用例',
      pmAssignmentId: 'inst-pm',
      subAssignmentId: 'inst-sub',
      sessionId: sessChatId,
    });
    dispatchRegistry.register({
      taskId: 'T-tuc-0',
      pmAssignmentId: 'inst-pm',
      subAssignmentId: 'inst-sub',
      sessionId: sessChatId,
      isFollowupRound: true,
    });
    const { runner, spies } = mkRunner();
    const svc = new RouterService({ runners: new Map([['inst-pm', runner]]) });
    setTaskUserActionHandler((taskId, action) =>
      svc.settleChainForTaskUserAction(taskId, action),
    );

    await cancelTask('T-tuc-0');

    await vi.waitFor(() => {
      expect(spies.executeTask).toHaveBeenCalledTimes(1);
    });
    const body = (spies.executeTask.mock.calls[0]![0] as { body: string }).body;
    expect(body).toContain('文件变更 0 处');
    expect(body).toContain('工具调用 0 次');
    expect(body).toContain('任务已被用户取消');
  });
});
