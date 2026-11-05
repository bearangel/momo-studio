// electron/tests/agent/dispatch-user-stop-receipt.test.ts
//
// 用户停止回执真相化（2026-11-04 生产事故 A 面）：
// 用户手动停止 agent runtime 后，dispatch 链曾保持 in_flight，233 秒后被
// sweepDead 误判成「子 agent 心跳超时……判定无响应」——PM leader 据假回执
// 得出「基础设施问题，一行代码都没写」的错误结论（子 agent 实际已产出
// 30+ 文件）。本文件锁定新语义：
//   1. stopAgentRuntime（真实入口）→ 该子 agent 名下在途链立即以
//      「用户已主动停止」落终态 + 投递真实产出回执（审计/账本实数）
//   2. 回执不出现「心跳超时」；标题行为「被用户停止」（非「失败」）
//   3. 用户停止后 sweepDead 不再翻案（事故回归锁）
//   4. 真超时判死语义保持（既有心跳超时文案不被本次改动吃掉）
//   5. 任务行维持 paused（K7-1 既有投影），不被停止回执覆盖成 failed
//
// fixture 保真度（momo-test-rules）：真实 SQLite + 真实 RouterService /
// dispatchRegistry / dispatch-task-ledger / 真实 stopAgentRuntime（含 DB 投影）；
// mock 仅 runner（进程边界）。
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
import { getTask } from '../../src/main/storage/tasks/repo';
import { insertToolCall } from '../../src/main/audit/insert';
import { __setElectronApisForTest } from '../../src/main/electron-access';
import {
  RouterService,
  setAgentStopHandler,
} from '../../src/main/agent/router-service';
import {
  dispatchRegistry,
  __resetDispatchRegistryForTest,
} from '../../src/main/agent/dispatch-registry';
import { ledgerInsertDispatch } from '../../src/main/agent/dispatch-task-ledger';
import { stopAgentRuntime } from '../../src/main/agent/runtime-registry';
import type { AgentRunner } from '../../src/main/agent/agent-runner';

const tmpRoot = path.join(
  os.tmpdir(),
  `ap-dispatch-user-stop-${Date.now()}-${Math.random().toString(36).slice(2)}`,
);

let sessChatId = '';

/** PM runner mock（dispatch-auto-delivery 同款） */
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
  const sess = insertSession({ workspaceId: 'ws', title: 'user-stop' });
  sessChatId = sess.id;
  __resetDispatchRegistryForTest();
});

afterEach(() => {
  setAgentStopHandler(null); // 用例内绑定必须在收尾解绑（模块级单例跨用例共享）
  __setElectronApisForTest(null);
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

describe('用户停止回执（stop-truthful receipts）', () => {
  it('stopAgentRuntime → 链以「用户已主动停止」落终态，回报真实产出，绝口不提心跳超时', async () => {
    seedAuditRows('T-stop-1', 4);
    seedJournalRows('T-stop-1', 3);
    ledgerInsertDispatch({
      taskId: 'T-stop-1',
      body: '重构登录模块',
      pmAssignmentId: 'inst-pm',
      subAssignmentId: 'inst-sub',
      sessionId: sessChatId,
    });
    dispatchRegistry.register({
      taskId: 'T-stop-1',
      pmAssignmentId: 'inst-pm',
      subAssignmentId: 'inst-sub',
      sessionId: sessChatId,
      isFollowupRound: true, // followup 恒投递——PM 显式在等答案（事故形态）
    });
    const { runner, spies } = mkRunner();
    const svc = new RouterService({ runners: new Map([['inst-pm', runner]]) });
    // 生产接线形态：bootstrap 把 RouterService 方法绑到模块级停止处理器
    setAgentStopHandler((instanceId) => svc.settleChainsOnAgentStop(instanceId));

    await stopAgentRuntime('inst-sub');

    // 投递发生：PM 收到自动送达输入
    await vi.waitFor(() => {
      expect(spies.executeTask).toHaveBeenCalledTimes(1);
    });
    const body = (spies.executeTask.mock.calls[0]![0] as { body: string }).body;
    // 契约字面量（momo-boundary-rules：回执文案是协议，字面断言锁死）
    expect(body).toContain('用户已主动停止子 agent 运行');
    expect(body).toContain('文件变更 3 处');
    expect(body).toContain('工具调用 4 次');
    expect(body).toContain('dispatch_followup');
    // 事故反面：绝不出现超时误判文案
    expect(body).not.toContain('心跳超时');
    // 标题行：被用户停止是独立事实（非「已失败」）
    expect(body).toContain('被用户停止');

    // 回执行落库：sender=system + taskId=链 ID（与既有回执同路）
    const rows = listMessagesBySession(sessChatId).filter(
      (r) => r.taskId === 'T-stop-1' && r.body.includes('【dispatch 回执自动送达】'),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.sender).toBe('system');
    expect(rows[0]?.body).toContain('用户已主动停止');

    // 同步等待立即解除：PM runner 收到 failed 回执（真身 body，非超时文案）
    const notified = spies.notifyTaskReply.mock.calls
      .map((c) => c[0] as { taskId: string; status: string; body: string })
      .find((n) => n.taskId === 'T-stop-1');
    expect(notified).toBeDefined();
    expect(notified?.status).toBe('failed');
    expect(notified?.body).toContain('用户已主动停止');

    // 链终态：done + userStopped（deliverChainResult 标题分支的依据）
    expect(dispatchRegistry.get('T-stop-1')?.status).toBe('done');
    expect(dispatchRegistry.get('T-stop-1')?.userStopped).toBe(true);

    // 任务行维持 K7-1 既有投影：paused + 用户停止 error——不被覆盖成 failed
    const task = getTask('T-stop-1');
    expect(task?.status).toBe('paused');
    expect(task?.errorMessage).toBe('agent 运行已被用户停止');
  });

  it('停止后 sweepDead 不再翻案：心跳静默 5 分钟也无超时回执（事故回归锁）', async () => {
    vi.useFakeTimers();
    try {
      seedAuditRows('T-stop-2', 2);
      ledgerInsertDispatch({
        taskId: 'T-stop-2',
        body: '任务二',
        pmAssignmentId: 'inst-pm',
        subAssignmentId: 'inst-sub',
        sessionId: sessChatId,
      });
      dispatchRegistry.register({
        taskId: 'T-stop-2',
        pmAssignmentId: 'inst-pm',
        subAssignmentId: 'inst-sub',
        sessionId: sessChatId,
        isFollowupRound: true,
      });
      const { runner, spies } = mkRunner();
      const svc = new RouterService({ runners: new Map([['inst-pm', runner]]) });
      setAgentStopHandler((instanceId) => svc.settleChainsOnAgentStop(instanceId));
      svc.start(); // 启动心跳死亡清扫计时器（60s 周期）

      // t=0 用户停止；随后心跳静默 5 分钟（远超 233 秒死亡阈值）
      await stopAgentRuntime('inst-sub');
      await vi.advanceTimersByTimeAsync(5 * 60_000);

      // 仍然只有 1 条回执行，且全文无「心跳超时」
      const rows = listMessagesBySession(sessChatId).filter((r) => r.taskId === 'T-stop-2');
      const receipts = rows.filter((r) => r.body.includes('【dispatch 回执自动送达】'));
      expect(receipts).toHaveLength(1);
      expect(receipts[0]?.body).toContain('用户已主动停止');
      expect(receipts[0]?.body).not.toContain('心跳超时');
      // PM 只被唤醒一次（无第二次「翻案」投递）
      expect(spies.executeTask).toHaveBeenCalledTimes(1);
      // 任务行仍是 paused（sweepDead 的 failed 投影没有打上来）
      expect(getTask('T-stop-2')?.status).toBe('paused');

      svc.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('真超时判死语义保持：无人停止 + 心跳静默 → 回执仍是「心跳超时」', async () => {
    vi.useFakeTimers();
    try {
      seedAuditRows('T-timeout-1', 2);
      ledgerInsertDispatch({
        taskId: 'T-timeout-1',
        body: '任务三',
        pmAssignmentId: 'inst-pm',
        subAssignmentId: 'inst-sub',
        sessionId: sessChatId,
      });
      dispatchRegistry.register({
        taskId: 'T-timeout-1',
        pmAssignmentId: 'inst-pm',
        subAssignmentId: 'inst-sub',
        sessionId: sessChatId,
        isFollowupRound: true,
      });
      const { runner, spies } = mkRunner();
      const svc = new RouterService({ runners: new Map([['inst-pm', runner]]) });
      setAgentStopHandler((instanceId) => svc.settleChainsOnAgentStop(instanceId));
      svc.start();

      // 无人停止，心跳静默 4 分钟（> 3×60s 死亡阈值）
      await vi.advanceTimersByTimeAsync(4 * 60_000);

      await vi.waitFor(() => {
        expect(spies.executeTask).toHaveBeenCalledTimes(1);
      });
      const body = (spies.executeTask.mock.calls[0]![0] as { body: string }).body;
      // 既有超时判死文案原样保留（真超时就是超时）
      expect(body).toContain('心跳超时');
      expect(body).toContain('判定无响应');
      expect(body).toContain('已失败');
      expect(body).not.toContain('用户已主动停止');
      // 账本投影：failed + 判死原因（D4 既有语义）
      const task = getTask('T-timeout-1');
      expect(task?.status).toBe('failed');
      expect(task?.errorMessage).toContain('心跳超时');
      // 链不是 userStopped（标题分支依据）
      expect(dispatchRegistry.get('T-timeout-1')?.userStopped).toBeFalsy();

      svc.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('幂等：停止联动重复触发 → 第二次 no-op（不重复投递）', async () => {
    seedAuditRows('T-stop-3', 1);
    dispatchRegistry.register({
      taskId: 'T-stop-3',
      pmAssignmentId: 'inst-pm',
      subAssignmentId: 'inst-sub',
      sessionId: sessChatId,
      isFollowupRound: true,
    });
    const { runner, spies } = mkRunner();
    const svc = new RouterService({ runners: new Map([['inst-pm', runner]]) });

    svc.settleChainsOnAgentStop('inst-sub');
    svc.settleChainsOnAgentStop('inst-sub'); // 重复（链已终态）

    await vi.waitFor(() => {
      expect(spies.executeTask).toHaveBeenCalledTimes(1);
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(spies.executeTask).toHaveBeenCalledTimes(1); // 恰一次
    const receipts = listMessagesBySession(sessChatId).filter(
      (r) => r.taskId === 'T-stop-3' && r.body.includes('【dispatch 回执自动送达】'),
    );
    expect(receipts).toHaveLength(1);
  });
});
