// electron/tests/task/human-ipc.test.ts
//
// 任务生命周期 v2 Task 16 IPC 契约锁（human 命名空间 + task 两段式通道 + 推送 +
// 装配幂等）。mock 边界（momo-test-rules）：只 mock electron 边界——
//   - ipcMain.handle 注册经 hoisted Map 捕获（journal/ipc.handlers.test.ts 先例）
//   - webContents 推送经 __setElectronApisForTest 注入假窗口（tool-gate-persistence
//     先例——vi.mock 拦不到 loadElectronApis 的 raw require）
// 数据面全真实（AP_USER_DATA_DIR 临时库 + runMigrations + 真实 repo / 服务函数）。
//
// 覆盖（brief Step 1 五用例）：
//   1) human:list 按 sessionId / taskId / status 过滤
//   2) human:answer question → answered + human:changed 推送（sessionId/requestId）+
//      message 附言并入 answer.text；重答 stale
//   3) human:attention 聚合：waiting（pending 非验收计数）/ submitted（本机验收方）/
//      executorSubmitted（delegation_role='in'）/ failed（失败任务）；零信号会话不占位
//   4) task:reject 空白理由人话拒 + 有理由打回回 assigned；task:listRuns run_no ASC；
//      task:submit / task:accept 全链
//   5) registerHumanIpc 幂等（模块级 flag——重复注册零新增通道）
import { describe, it, expect, beforeEach, afterEach, vi, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

interface IpcHandler {
  (event: unknown, ...args: unknown[]): Promise<unknown> | unknown;
}

const { handlers, handleSpy, mockSend } = vi.hoisted(() => {
  const handlers = new Map<string, IpcHandler>();
  const handleSpy = vi.fn((channel: string, fn: IpcHandler): void => {
    handlers.set(channel, fn);
  });
  const mockSend = vi.fn();
  return { handlers, handleSpy, mockSend };
});

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: IpcHandler): void => handleSpy(channel, fn),
  },
}));

import { __setElectronApisForTest } from '../../src/main/electron-access';
import { registerTaskHandlers } from '../../src/main/task/ipc.handlers';
import {
  registerHumanIpc,
  __teardownHumanIpcForTest,
} from '../../src/main/task/human.ipc.handlers';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { insertTask, updateTask, getTask } from '../../src/main/storage/tasks/repo';
import { insertSession } from '../../src/main/storage/sessions/repo';
import {
  insertHumanRequest,
  getHumanRequest,
  tryAnswer,
} from '../../src/main/storage/tasks/human-requests-repo';
import { startRun, submitRun } from '../../src/main/task/lifecycle-runs';
import { insertRun } from '../../src/main/storage/tasks/runs-repo';

beforeAll(() => {
  // webContents 推送边界：假主窗口 + send spy（sink → pushToMainWindow 可观测）
  __setElectronApisForTest({
    BrowserWindow: {
      getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: mockSend } }],
    },
  });
});
afterAll(() => {
  __setElectronApisForTest(null);
});

const tmpRoot = path.join(
  os.tmpdir(),
  `ap-human-ipc-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
);

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  getDb()
    .prepare(`INSERT INTO workspaces (id, name, directory_path, owner_id) VALUES (?, ?, ?, ?)`)
    .run('ws1', 'Test', '/tmp', '@owner:home');
  handlers.clear();
  handleSpy.mockClear();
  mockSend.mockClear();
  registerTaskHandlers();
  registerHumanIpc();
});

afterEach(() => {
  // 还原 human.ipc.handlers 模块级装配态（registered flag + 定时器 + sink）
  __teardownHumanIpcForTest();
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

/** 种聊天会话（human_requests.session_id FK 前置） */
function seedSession(id: string): string {
  return insertSession({ workspaceId: 'ws1', title: `会话-${id}`, kind: 'chat' }).id;
}

// ═══ 1) human:list 过滤 ═══
describe('1) human:list 按 sessionId / taskId / status 过滤', () => {
  it('sessionId 过滤只看本会话；status=all 含已答；taskId 过滤命中任务行', async () => {
    const sA = seedSession('list-a');
    const sB = seedSession('list-b');
    const task = insertTask({ workspaceId: 'ws1', title: 'T', creatorUserId: 'u' });
    const p1 = insertHumanRequest({ sessionId: sA, kind: 'question', title: 'q1' });
    insertHumanRequest({ sessionId: sA, kind: 'question', title: 'q2' });
    const answered = insertHumanRequest({ sessionId: sA, kind: 'question', title: 'q3' });
    tryAnswer(answered.id, JSON.stringify({ text: '好' }), 'u');
    insertHumanRequest({ sessionId: sB, kind: 'question', title: 'other' });
    insertHumanRequest({ sessionId: sA, kind: 'question', title: 'by-task', taskId: task.id });

    const list = handlers.get('human:list')!;

    const pendingA = (await list(null, { sessionId: sA })) as Array<{ id: string; status: string }>;
    expect(pendingA).toHaveLength(3); // q1/q2/by-task（q3 已答不出现）
    expect(pendingA.map((r) => r.id)).toContain(p1.id);
    expect(pendingA.every((r) => r.status === 'pending')).toBe(true);

    const allA = (await list(null, { sessionId: sA, status: 'all' })) as unknown[];
    expect(allA).toHaveLength(4); // 含已答 q3

    const byTask = (await list(null, { taskId: task.id })) as Array<{ title: string }>;
    expect(byTask).toHaveLength(1);
    expect(byTask[0]!.title).toBe('by-task');

    // 异形入参：status 越界人话拒（handler 同步抛——不走 rejects 形态）
    expect(() => void list(null, { status: 'bogus' as unknown as 'all' })).toThrow(
      'status 只支持 pending / all',
    );
  });
});

// ═══ 2) human:answer + human:changed 推送 ═══
describe('2) human:answer question → answered + 推送 + 附言并入', () => {
  it('答复落库 + human:changed 推送（sessionId/requestId/kind）+ message 并入 text；重答 stale', async () => {
    const sC = seedSession('answer');
    const req = insertHumanRequest({
      sessionId: sC,
      kind: 'question',
      title: '选哪个方案',
      optionsJson: JSON.stringify(['A', 'B']),
    });
    const answer = handlers.get('human:answer')!;

    const disp = await answer(null, req.id, { text: '选 A', selected: ['A'] }, '补充：尽快');
    expect(disp).toEqual({ disposition: 'answered' });

    const row = getHumanRequest(req.id)!;
    expect(row.status).toBe('answered');
    expect(row.answeredByNodeId).toBe('local'); // 未配置 hub → 'local'
    const answerJson = JSON.parse(row.answerJson!) as { text?: string; selected?: string[] };
    expect(answerJson.text).toBe('选 A\n补充：尽快'); // message 换行拼接
    expect(answerJson.selected).toEqual(['A']);

    // 推送：human:changed { sessionId, requestId, kind:'answered' }
    const pushes = mockSend.mock.calls.filter((c) => c[0] === 'human:changed');
    expect(pushes).toHaveLength(1);
    expect(pushes[0]![1]).toEqual({ sessionId: sC, requestId: req.id, kind: 'answered' });

    // 重答（已非 pending）→ stale，零新推送
    const again = await answer(null, req.id, { text: '再答' });
    expect(again).toEqual({ disposition: 'stale' });
    expect(mockSend.mock.calls.filter((c) => c[0] === 'human:changed')).toHaveLength(1);
  });
});

// ═══ 3) human:attention 聚合 ═══
describe('3) human:attention 聚合（waiting / submitted / executorSubmitted / failed）', () => {
  it('两会话对比 + delegation_role 分流 + acceptance 不计入 waiting + 零信号会话不占位', async () => {
    const sBusy = seedSession('busy');
    const sIdle = seedSession('idle');
    const sExecutor = seedSession('executor');
    const sFailed = seedSession('failed');
    const sRemote = seedSession('remote-out');

    // sBusy：pending question ×2 + 一条 pending acceptance（不计 waiting）
    insertHumanRequest({ sessionId: sBusy, kind: 'question', title: 'q1' });
    insertHumanRequest({ sessionId: sBusy, kind: 'question', title: 'q2' });
    insertHumanRequest({ sessionId: sBusy, kind: 'acceptance', title: '验收单' });
    // sBusy 同时挂一个本机 submitted 任务（delegation_role NULL = 本机验收方）
    insertTask({
      workspaceId: 'ws1',
      title: 'local-submitted',
      creatorUserId: 'u',
      status: 'submitted',
      executionSessionId: sBusy,
    });
    // sExecutor：承接外派（'in'）的 submitted 任务——执行方视角
    const inTask = insertTask({
      workspaceId: 'ws1',
      title: 'in-submitted',
      creatorUserId: 'u',
      status: 'submitted',
      executionSessionId: sExecutor,
    });
    updateTask(inTask.id, { delegationRole: 'in' });
    // sRemote：外派他人（'out'）——本机是验收方
    const outTask = insertTask({
      workspaceId: 'ws1',
      title: 'out-submitted',
      creatorUserId: 'u',
      status: 'submitted',
      executionSessionId: sRemote,
    });
    updateTask(outTask.id, { delegationRole: 'out' });
    // sFailed：失败任务
    insertTask({
      workspaceId: 'ws1',
      title: 'dead',
      creatorUserId: 'u',
      status: 'failed',
      executionSessionId: sFailed,
    });

    const attention = handlers.get('human:attention')!;
    const map = (await attention(null, 'ws1')) as Record<
      string,
      { waiting: number; submitted: boolean; executorSubmitted: boolean; failed: boolean }
    >;

    expect(map[sBusy]).toEqual({ waiting: 2, submitted: true, executorSubmitted: false, failed: false });
    expect(map[sIdle]).toBeUndefined(); // 零信号会话不占位
    expect(map[sExecutor]).toEqual({ waiting: 0, submitted: false, executorSubmitted: true, failed: false });
    expect(map[sRemote]).toEqual({ waiting: 0, submitted: true, executorSubmitted: false, failed: false });
    expect(map[sFailed]).toEqual({ waiting: 0, submitted: false, executorSubmitted: false, failed: true });
    expect(Object.keys(map).sort()).toEqual([sBusy, sExecutor, sFailed, sRemote].sort());
  });
});

// ═══ 4) task:reject / listRuns / submit / accept ═══
describe('4) task 两段式通道：reject 空白拒 + listRuns ASC + submit/accept 全链', () => {
  it('空白理由人话拒；listRuns run_no ASC；打回回 assigned；accept 全链 completed', async () => {
    const sRun = seedSession('run');
    const task = insertTask({
      workspaceId: 'ws1',
      title: '两段式',
      creatorUserId: 'u',
      status: 'assigned',
      executionSessionId: sRun,
    });
    // run #1 终态（历史）+ startRun → run #2 → submitRun → submitted
    insertRun({ taskId: task.id, status: 'failed', trigger: 'initial' });
    startRun(task.id, { trigger: 'rework', executionSessionId: sRun });
    await submitRun(task.id, { summary: '交付说明' });

    const reject = handlers.get('task:reject')!;
    await expect(reject(null, task.id, '   ')).rejects.toThrow('打回必须填写理由');

    const listRunsHandler = handlers.get('task:listRuns')!;
    const runs = (await listRunsHandler(null, task.id)) as Array<{ runNo: number; status: string }>;
    expect(runs.map((r) => r.runNo)).toEqual([1, 2]); // ASC
    expect(runs[1]!.status).toBe('submitted');

    // 有理由打回：run rejected + 任务回 assigned（排队返工）
    const rejected = (await reject(null, task.id, '样式不对')) as { status: string };
    expect(rejected.status).toBe('assigned');
    expect(getTask(task.id)!.status).toBe('assigned');

    // 返工再提交 → 验收通过全链
    startRun(task.id, { trigger: 'rework', executionSessionId: sRun });
    const submit = handlers.get('task:submit')!;
    const submitted = (await submit(null, task.id, { summary: '二版' })) as { status: string };
    expect(submitted.status).toBe('submitted');

    const accept = handlers.get('task:accept')!;
    const completed = (await accept(null, task.id)) as { status: string };
    expect(completed.status).toBe('completed');
    expect(getTask(task.id)!.acceptedAt).not.toBeNull();
  });
});

// ═══ 5) 装配幂等 ═══
describe('5) registerHumanIpc 幂等（模块级 flag）', () => {
  it('重复注册零新增通道（handlers 不翻倍）', () => {
    expect(handlers.has('human:list')).toBe(true);
    expect(handlers.has('human:answer')).toBe(true);
    expect(handlers.has('human:attention')).toBe(true);

    const before = handleSpy.mock.calls.length;
    registerHumanIpc();
    registerHumanIpc();
    expect(handleSpy.mock.calls.length).toBe(before);
  });
});
