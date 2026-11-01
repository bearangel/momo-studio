// electron/tests/task/dispatch-task-ledger.test.ts
//
// D4（验收报告 2026-10-31 T22）：dispatch 子任务入 tasks 账本——registry 的单向
// 持久化投影。spec docs/specs/2026-10-31-ledger-storage-package-design.md §3。
// 覆盖：行形状 / followup 权威复位 / settle 三态映射（needs_input→paused）/ cancel /
// sweepDead fail / 启动对账 / 写失败韧性（投影失败不断运行链）。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { getTask, listTasks } from '../../src/main/storage/tasks/repo';
import {
  ledgerInsertDispatch,
  ledgerSettleDispatch,
  ledgerCancelDispatch,
  ledgerFailDispatch,
  reconcileDispatchTasksAtBoot,
} from '../../src/main/agent/dispatch-task-ledger';

const tmpRoot = path.join(
  os.tmpdir(),
  `ap-d4-ledger-${Date.now()}-${Math.random().toString(36).slice(2)}`,
);

function seedMembers(): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO workspaces (id, name, directory_path, owner_id) VALUES ('ws', 'T', '/tmp', '@o')`,
  ).run();
  for (const inst of ['inst-pm', 'inst-smith']) {
    db.prepare(
      `INSERT INTO agent_definitions
         (id, name, slug, version, runtime, system_prompt, default_tools, default_mcps,
          default_skills, source, description, icon_emoji, model_provider_id, model_name, task_driven)
       VALUES (?, ?, ?, '1.0.0', 'declarative', 'p', '[]', '[]', '[]', 'custom', '', '🤖', 'prov-1', 'm', 1)`,
    ).run(inst, inst, inst);
    db.prepare(
      `INSERT INTO workspace_agent_members (instance_id, workspace_id, agent_definition_id, agent_user_id)
       VALUES (?, 'ws', ?, ?)`,
    ).run(inst, inst, `agent-${inst}`);
  }
}

const CHAIN = {
  taskId: 'd4-chain-001',
  body: '写 index.html 游戏主页面',
  pmAssignmentId: 'inst-pm',
  subAssignmentId: 'inst-smith',
  sessionId: 'sess-d4',
  subStreamSessionId: 'ss-d4-sub',
};

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  seedMembers();
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

describe('D4 dispatch-task-ledger（registry → tasks 单向投影）', () => {
  it('register 投影：origin=dispatch 直插 in_progress（id=链 taskId 原样沿用），title=body', () => {
    ledgerInsertDispatch(CHAIN);
    const row = getTask(CHAIN.taskId);
    expect(row, '行应落 tasks 表').toBeDefined();
    expect(row!.origin).toBe('dispatch');
    expect(row!.status).toBe('in_progress');
    expect(row!.title).toBe(CHAIN.body);
    expect(row!.assigneeAgentId).toBe('inst-smith');
    expect(row!.executionSessionId).toBe('sess-d4');
    expect(row!.workspaceId).toBe('ws');
  });

  it('title 截断 80 字符（簿记行防超长）', () => {
    ledgerInsertDispatch({ ...CHAIN, body: '长'.repeat(120) });
    const row = getTask(CHAIN.taskId)!;
    expect(row.title).toHaveLength(80);
  });

  it('followup 链复用：终态行 updateTask 权威复位回 in_progress（禁 DELETE——迁移 555 触发器会把挂链消息 task_id 置 NULL 断链）', () => {
    ledgerInsertDispatch(CHAIN);
    ledgerSettleDispatch(CHAIN.taskId, 'completed');
    expect(getTask(CHAIN.taskId)!.status).toBe('completed');
    // 下一轮派发（同链 id）——行 id 稳定不动（触发器零触发）
    ledgerInsertDispatch({ ...CHAIN, body: '第二轮任务' });
    const row = getTask(CHAIN.taskId)!;
    expect(row.status).toBe('in_progress');
    expect(row.title).toBe('第二轮任务');
  });

  it('settle 三态映射：completed→completed / failed→failed+errorMessage / needs_input→paused', () => {
    ledgerInsertDispatch(CHAIN);
    ledgerSettleDispatch(CHAIN.taskId, 'failed', '连接中断：terminated');
    let row = getTask(CHAIN.taskId)!;
    expect(row.status).toBe('failed');
    expect(row.errorMessage).toBeTruthy();

    ledgerInsertDispatch(CHAIN); // 复位
    ledgerSettleDispatch(CHAIN.taskId, 'needs_input');
    row = getTask(CHAIN.taskId)!;
    expect(row.status, 'needs_input=HITL 等待人工——paused 语义准确（spec 自审修正）').toBe('paused');

    ledgerInsertDispatch(CHAIN);
    ledgerSettleDispatch(CHAIN.taskId, 'completed');
    row = getTask(CHAIN.taskId)!;
    expect(row.status).toBe('completed');
  });

  it('cancel 投影 → cancelled', () => {
    ledgerInsertDispatch(CHAIN);
    ledgerCancelDispatch(CHAIN.taskId);
    expect(getTask(CHAIN.taskId)!.status).toBe('cancelled');
  });

  it('sweepDead 判死投影 → failed + 判死原因', () => {
    ledgerInsertDispatch(CHAIN);
    ledgerFailDispatch(CHAIN.taskId, '心跳超时判死');
    const row = getTask(CHAIN.taskId)!;
    expect(row.status).toBe('failed');
    expect(row.errorMessage).toContain('心跳超时判死');
  });

  it('启动对账：origin=dispatch 的 in_progress/paused 全转 failed（应用重启，编排链丢失），用户任务不动', () => {
    const db = getDb();
    ledgerInsertDispatch(CHAIN); // in_progress
    ledgerInsertDispatch({ ...CHAIN, taskId: 'd4-chain-002' });
    ledgerSettleDispatch('d4-chain-002', 'needs_input'); // paused
    // 用户任务对照
    db.prepare(
      `INSERT INTO tasks (id, workspace_id, title, creator_user_id, status, created_at, updated_at)
       VALUES ('T-9001', 'ws', '用户任务', '@o', 'in_progress', ?, ?)`,
    ).run(Date.now(), Date.now());

    reconcileDispatchTasksAtBoot();

    expect(getTask(CHAIN.taskId)!.status).toBe('failed');
    expect(getTask(CHAIN.taskId)!.errorMessage).toContain('应用重启');
    expect(getTask('d4-chain-002')!.status).toBe('failed');
    expect(getTask('T-9001')!.status, '用户任务不被对账波及').toBe('in_progress');
  });

  it('写失败韧性：成员行缺失（workspace 无法解析）→ 不抛错不落行（投影失败不断运行链）', () => {
    expect(() =>
      ledgerInsertDispatch({ ...CHAIN, subAssignmentId: 'inst-ghost' }),
    ).not.toThrow();
    expect(getTask(CHAIN.taskId)).toBeNull();
  });

  it('对不存在行的 settle/cancel/fail 幂等不抛错（迟到钩子防崩）', () => {
    expect(() => ledgerSettleDispatch('ghost', 'completed')).not.toThrow();
    expect(() => ledgerCancelDispatch('ghost')).not.toThrow();
    expect(() => ledgerFailDispatch('ghost', 'x')).not.toThrow();
  });
});

describe('D4 excludeOrigin 过滤（Oracle MUST FIX 1 的 repo 面）', () => {
  it('listTasks({executionSessionId, status:in_progress, excludeOrigin:dispatch}) 不回 dispatch 行——跑链会话冲突检测的消费形态', () => {
    ledgerInsertDispatch(CHAIN); // executionSessionId=sess-d4, in_progress
    getDb()
      .prepare(
        `INSERT INTO tasks (id, workspace_id, title, creator_user_id, status, execution_session_id, created_at, updated_at)
         VALUES ('T-9100', 'ws', '用户执行室任务', '@o', 'in_progress', 'sess-d4', ?, ?)`,
      )
      .run(Date.now(), Date.now());
    const rows = listTasks({
      executionSessionId: 'sess-d4',
      status: 'in_progress',
      excludeOrigin: 'dispatch',
    });
    expect(rows.map((r) => r.id)).toEqual(['T-9100']);
    // 不过滤则两行都在（对照组——排除确因 origin 生效）
    const all = listTasks({ executionSessionId: 'sess-d4', status: 'in_progress' });
    expect(all).toHaveLength(2);
  });
});
