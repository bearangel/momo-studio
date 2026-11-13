// electron/tests/agent/tools/task-tools-v2.test.ts
//
// 任务工具 v2（任务生命周期 v2 Task 14）——agent 工具面契约锁：
//   1) request_human(question+options)：返回 {requestId,status:'waiting'} + DB 请求行
//      （taskId/runId 绑会话活动任务与活动 run）+ 任务 waiting_human
//   2) request_human 无任务会话：task_id NULL 也能建（仅会话徽标），steps 序列化
//      payloadJson={manualAction:{steps}}
//   3) submit_task：任务 submitted + run submitted + 返回 {status:'submitted',runNo}
//   4) complete_task 别名：行为与 submit_task 一致（summary 缺省 ''，同返回）
//   5) 有未决 tool_gate 时 submit_task 人话拒绝（Review Focus #2 提交闸工具面）
//   6) fail_task：任务 failed + run failed（既有语义保持，走 failRun）
//   7) 描述断言：四工具 description 关键句锁文案防回退
//   8) runId 绑定策略：活动 run 不属于本会话 → taskId 照绑、runId null（不绑 run，
//      T11 review carry——run 收尾不顶替该请求）
//
// 隔离：每 case 独立 tmp 目录 + closeDb（task-tools.test.ts 同形态）；真实 DB，
// 只经 TaskTools.execute 工具面驱动（不 mock lifecycle 服务——工具面就是薄封装）。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb, getDb } from '../../../src/main/storage/db';
import {
  insertTask,
  getTask,
  transitionTaskStatus,
  type TaskRow,
} from '../../../src/main/storage/tasks/repo';
import { insertSession } from '../../../src/main/storage/sessions/repo';
import {
  getActiveRun,
  listRuns,
  type TaskRunRow,
} from '../../../src/main/storage/tasks/runs-repo';
import {
  getHumanRequest,
  insertHumanRequest,
  listByTask,
} from '../../../src/main/storage/tasks/human-requests-repo';
import { startRun } from '../../../src/main/task/lifecycle-runs';
import { TaskTools } from '../../../src/main/agent/tools/task-tools';
import type { ToolContext } from '../../../src/main/agent/tools/types';

const tmpRoot = path.join(
  os.tmpdir(),
  `ap-task-tools-v2-${Date.now()}-${Math.random().toString(36).slice(2)}`,
);

function seedCtx(sessionId: string): ToolContext {
  return {
    wsFs: {} as ToolContext['wsFs'],
    workspaceId: 'ws1',
    workspaceDir: '/tmp/ws1',
    skillRegistry: {} as ToolContext['skillRegistry'],
    streamSessionId: 'ss-1',
    roomId: sessionId,
    sendStreamChunk: () => undefined,
    permissionConfig: { allowedTools: [], deniedTools: [] },
    creatorUserId: '@owner:home',
  };
}

/** 种一颗跑起来的任务（生产同构落态：assigned → in_progress + startRun 记账） */
function seedRunningTask(sessionId: string, bindRunToSession = true): { task: TaskRow; run: TaskRunRow } {
  const task = insertTask({
    workspaceId: 'ws1',
    title: '落地功能',
    creatorUserId: '@owner:home',
  });
  transitionTaskStatus(task.id, 'assigned');
  transitionTaskStatus(task.id, 'in_progress', { executionSessionId: sessionId });
  const run = startRun(task.id, {
    trigger: 'initial',
    executionSessionId: bindRunToSession ? sessionId : null,
  });
  return { task, run };
}

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  getDb()
    .prepare(`INSERT INTO workspaces (id, name, directory_path, owner_id) VALUES (?, ?, ?, ?)`)
    .run('ws1', 'Test', '/tmp/ws1', '@owner:home');
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

describe('request_human', () => {
  const tools = new TaskTools();

  it('1) question+options：请求行落库（绑任务+run）+ 任务/run waiting_human', async () => {
    const sess = insertSession({ workspaceId: 'ws1', title: '执行间', kind: 'task_execution' }).id;
    const { task, run } = seedRunningTask(sess);

    const out = JSON.parse(
      await tools.execute(
        'request_human',
        {
          kind: 'question',
          title: '确认方案',
          prompt: 'A 还是 B？',
          options: [
            { id: 'a', label: '方案A', description: '更快' },
            { id: 'b', label: '方案B' },
          ],
          deadlineMinutes: 30,
        },
        seedCtx(sess),
      ),
    );

    expect(out).toEqual({ requestId: expect.any(String), status: 'waiting' });
    const row = getHumanRequest(out.requestId)!;
    expect(row).not.toBeNull();
    expect(row.kind).toBe('question');
    expect(row.sessionId).toBe(sess);
    expect(row.taskId).toBe(task.id);
    expect(row.runId).toBe(run.id);
    expect(JSON.parse(row.optionsJson!)).toEqual([
      { id: 'a', label: '方案A', description: '更快' },
      { id: 'b', label: '方案B' },
    ]);
    expect(row.deadlineAt).not.toBeNull();
    expect(getTask(task.id)!.status).toBe('waiting_human');
    expect(getActiveRun(task.id)!.status).toBe('waiting_human');
  });

  it('2) 无任务会话：task_id NULL 也能建（仅会话徽标）；steps 序列化 payloadJson', async () => {
    const sess = insertSession({ workspaceId: 'ws1', title: '快速会话', kind: 'chat' }).id;
    const steps = [
      { id: 's1', label: '重启依赖服务' },
      { id: 's2', label: '确认恢复' },
    ];

    const out = JSON.parse(
      await tools.execute(
        'request_human',
        {
          kind: 'manual_action',
          title: '请重启服务',
          prompt: '依赖的本地服务挂了，请手动重启后告诉我',
          steps,
        },
        seedCtx(sess),
      ),
    );

    expect(out).toEqual({ requestId: expect.any(String), status: 'waiting' });
    const row = getHumanRequest(out.requestId)!;
    expect(row.taskId).toBeNull();
    expect(row.runId).toBeNull();
    expect(JSON.parse(row.payloadJson!)).toEqual({ manualAction: { steps } });
    expect(row.timeoutPolicy).toBe('escalate');
  });

  it('8) runId 绑定策略：活动 run 不属于本会话 → taskId 照绑、runId null', async () => {
    const sess = insertSession({ workspaceId: 'ws1', title: '执行间2', kind: 'task_execution' }).id;
    // run 未携带 execution_session_id（旧链路 / 回填形态）→ 不视为本会话 run
    const { task } = seedRunningTask(sess, false);

    const out = JSON.parse(
      await tools.execute(
        'request_human',
        { kind: 'question', title: '问一句', prompt: '参数用哪个？' },
        seedCtx(sess),
      ),
    );

    const row = getHumanRequest(out.requestId)!;
    expect(row.taskId).toBe(task.id);
    expect(row.runId).toBeNull();
  });
});

describe('submit_task / complete_task 别名', () => {
  const tools = new TaskTools();

  it('3) submit_task：任务+run submitted + 返回 {status:"submitted",runNo}', async () => {
    const sess = insertSession({ workspaceId: 'ws1', title: '执行间3', kind: 'task_execution' }).id;
    const { task, run } = seedRunningTask(sess);

    const out = JSON.parse(
      await tools.execute(
        'submit_task',
        {
          taskId: task.id,
          summary: '登录页已实现',
          files: ['src/pages/Login.tsx'],
          artifacts: [{ label: '测试报告', value: '8/8 通过' }],
        },
        seedCtx(sess),
      ),
    );

    expect(out).toEqual({ status: 'submitted', runNo: run.runNo });
    expect(getTask(task.id)!.status).toBe('submitted');
    expect(getTask(task.id)!.submittedAt).not.toBeNull();
    const runs = listRuns(task.id);
    expect(runs[runs.length - 1]!.status).toBe('submitted');
    expect(JSON.parse(runs[runs.length - 1]!.deliverableJson!)).toEqual({
      summary: '登录页已实现',
      files: ['src/pages/Login.tsx'],
      artifacts: [{ label: '测试报告', value: '8/8 通过' }],
    });
    // 验收请求随提交生成（spec §6.5 两段式第一段）
    const acceptance = listByTask(task.id).find((r) => r.kind === 'acceptance');
    expect(acceptance).toBeDefined();
    expect(acceptance!.status).toBe('pending');
  });

  it('4) complete_task 别名：summary 缺省与 submit_task 同返回、同落态', async () => {
    const sess = insertSession({ workspaceId: 'ws1', title: '执行间4', kind: 'task_execution' }).id;
    const { task, run } = seedRunningTask(sess);

    const out = JSON.parse(
      await tools.execute('complete_task', { taskId: task.id }, seedCtx(sess)),
    );

    expect(out).toEqual({ status: 'submitted', runNo: run.runNo });
    expect(getTask(task.id)!.status).toBe('submitted');
  });

  it('5) 有未决 tool_gate 时 submit_task 返回人话错误（不落 submitted）', async () => {
    const sess = insertSession({ workspaceId: 'ws1', title: '执行间5', kind: 'task_execution' }).id;
    const { task, run } = seedRunningTask(sess);
    insertHumanRequest({
      sessionId: sess,
      taskId: task.id,
      runId: run.id,
      kind: 'tool_gate',
      title: '写授权',
      prompt: '请求写入 src/',
    });

    await expect(
      tools.execute('submit_task', { taskId: task.id, summary: '想直接交' }, seedCtx(sess)),
    ).rejects.toThrow(/未决人工请求/);
    expect(getTask(task.id)!.status).toBe('in_progress');
  });
});

describe('fail_task（v2 语义保持）', () => {
  it('6) 任务 failed + run failed + errorMessage 落账', async () => {
    const tools = new TaskTools();
    const sess = insertSession({ workspaceId: 'ws1', title: '执行间6', kind: 'task_execution' }).id;
    const { task } = seedRunningTask(sess);

    const out = JSON.parse(
      await tools.execute(
        'fail_task',
        { taskId: task.id, reason: '依赖服务持续不可用' },
        seedCtx(sess),
      ),
    );

    expect(out).toEqual({
      ok: true,
      taskId: task.id,
      status: 'failed',
      errorMessage: '依赖服务持续不可用',
    });
    expect(getTask(task.id)!.status).toBe('failed');
    expect(getTask(task.id)!.errorMessage).toBe('依赖服务持续不可用');
    expect(getActiveRun(task.id)).toBeNull();
    const runs = listRuns(task.id);
    expect(runs[runs.length - 1]!.status).toBe('failed');
  });
});

describe('7) 描述关键句锁（防文案回退）', () => {
  it('四工具 description 含回合纪律 / 提交语义关键句', () => {
    const defs = new TaskTools().getDefs();
    const desc = (name: string): string => {
      const d = defs.find((x) => x.name === name);
      if (!d) throw new Error(`工具 ${name} 不存在`);
      return d.description;
    };
    // request_human 回合纪律（Brief Step 3 锁句）
    expect(desc('request_human')).toContain('调用后立即结束本回合');
    expect(desc('request_human')).toContain('人答复后你会收到【人工答复】消息并继续');
    // submit_task 提交语义（Brief Step 3 锁句）
    expect(desc('submit_task')).toContain('提交后任务进入待验收状态');
    expect(desc('submit_task')).toContain('你没有完成权限，只有提交权限');
    // complete_task 别名声明
    expect(desc('complete_task')).toContain('已废弃别名——等价 submit_task');
    // fail_task 去向引导
    expect(desc('fail_task')).toContain('需要人帮助改用 request_human');
    // 回合收尾核对三选一已覆盖 request_human（与 turn-reconcile 文案联动）
    expect(desc('request_human')).toContain('kind: question=提问');
  });
});
