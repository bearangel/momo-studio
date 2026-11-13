// electron/tests/im/pending-dispatch.test.ts
//
// 启动期消息排队补偿回归锁（spec 2026-11-13；实机 P0：安装包启动后 50s 窗口内
// 发消息只落库不派发 → 用户体感「agent 不回复」且 UI 无任何反馈）。
//
// 锁什么：
//   1. router 缺席（RouterService 未 lazy 启动）→ 消息入队 + 推 session:pendingDispatch
//      占位态（count / agentName / iconEmoji 快照），不再静默丢弃
//   2. flushPendingDispatches：注入 router 后按入队顺序补派发，payload 与入队快照
//      逐字段对齐（boundary 规则：跨模块字段不得中途重造）
//   3. 补派发完成推 count=0 清空态（renderer 据此移除占位气泡）
//   4. 无 router 时 flush 为 no-op（幂等；队列保留等下次）
//   5. router 在位时 sendUserMessage 直接派发，不入队（无重复派发风险）
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

vi.mock('../../src/main/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { insertSession, addSessionMember } from '../../src/main/storage/sessions/repo';
import { __setElectronApisForTest } from '../../src/main/electron-access';
import {
  __pendingDispatchesForTest,
  __resetPendingDispatchesForTest,
  flushPendingDispatches,
  sendUserMessage,
  setSessionRouter,
} from '../../src/main/im/session-service';

const tmpRoot = path.join(os.tmpdir(), `ap-pending-dispatch-${Date.now()}`);

interface PushedEvent {
  channel: string;
  payload: unknown;
}

function installFakeWindow(): { sent: PushedEvent[] } {
  const sent: PushedEvent[] = [];
  __setElectronApisForTest({
    BrowserWindow: {
      getAllWindows: () => [
        {
          isDestroyed: () => false,
          webContents: {
            send: (channel: string, payload: unknown): void => {
              sent.push({ channel, payload });
            },
          },
        },
      ],
    },
  });
  return { sent };
}

function makeSpyRouter() {
  const routeUserChat = vi.fn().mockResolvedValue(undefined);
  return {
    router: { routeUserChat } as unknown as Parameters<typeof setSessionRouter>[0],
    routeUserChat,
  };
}

/** 单 agent 会话夹具（leader=inst-a，def 带名字与 emoji 供占位态快照断言） */
function seedSingleAgentSession(): string {
  const db = getDb();
  db.prepare(
    `INSERT INTO workspaces
       (id, name, description, directory_path, git_initialized, owner_id, icon_emoji,
        default_agent_instance_id)
     VALUES ('ws1', 'WS', '', '/tmp', 0, '@owner:s', '📁', null)`,
  ).run();
  db.prepare(
    `INSERT INTO agent_definitions (id, name, slug, version, system_prompt, model_name, icon_emoji)
     VALUES ('def-a', '代码专家', 'coder', '1', 'p', 'm', '🧑‍💻')`,
  ).run();
  db.prepare(
    `INSERT INTO workspace_agent_members
       (instance_id, workspace_id, agent_definition_id, agent_user_id, last_running)
     VALUES ('inst-a', 'ws1', 'def-a', '@inst-a:s', 1)`,
  ).run();
  const s = insertSession({ workspaceId: 'ws1', title: '快速会话' });
  addSessionMember(s.id, 'inst-a', true);
  return s.id;
}

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  __resetPendingDispatchesForTest();
});

afterEach(() => {
  setSessionRouter(null);
  __resetPendingDispatchesForTest();
  __setElectronApisForTest(null);
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

describe('启动期消息入队（router 缺席）', () => {
  it('消息落库 + 入队 + 推 session:pendingDispatch 占位态（含 agent 身份快照）', async () => {
    const sessionId = seedSingleAgentSession();
    const { sent } = installFakeWindow();

    await expect(sendUserMessage({ sessionId, body: '你好' })).resolves.toEqual({ readOnly: false });

    const queued = __pendingDispatchesForTest();
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      sessionId,
      assignmentId: 'inst-a',
      body: '你好',
      agentName: '代码专家',
      iconEmoji: '🧑‍💻',
    });

    const placeholder = sent.filter((e) => e.channel === 'session:pendingDispatch');
    expect(placeholder).toHaveLength(1);
    expect(placeholder[0]!.payload).toMatchObject({
      sessionId,
      count: 1,
      timedOut: false,
      agentName: '代码专家',
      iconEmoji: '🧑‍💻',
    });
  });

  it('多条消息按入队顺序累积，count 递增', async () => {
    const sessionId = seedSingleAgentSession();
    const { sent } = installFakeWindow();

    await sendUserMessage({ sessionId, body: '第一条' });
    await sendUserMessage({ sessionId, body: '第二条' });

    expect(__pendingDispatchesForTest().map((p) => p.body)).toEqual(['第一条', '第二条']);
    const counts = sent
      .filter((e) => e.channel === 'session:pendingDispatch')
      .map((e) => (e.payload as { count: number }).count);
    expect(counts).toEqual([1, 2]);
  });

  it('router 在位时直接派发，不入队', async () => {
    const sessionId = seedSingleAgentSession();
    installFakeWindow();
    const { router, routeUserChat } = makeSpyRouter();
    setSessionRouter(router);

    await sendUserMessage({ sessionId, body: '直发' });

    expect(routeUserChat).toHaveBeenCalledTimes(1);
    expect(routeUserChat.mock.calls[0]![0]).toMatchObject({
      sessionId,
      assignmentId: 'inst-a',
      body: '直发',
    });
    expect(__pendingDispatchesForTest()).toHaveLength(0);
  });
});

describe('flushPendingDispatches（RouterService 就绪后补派发）', () => {
  it('按入队顺序补派发，载荷逐字段对齐，完成后推 count=0', async () => {
    const sessionId = seedSingleAgentSession();
    const { sent } = installFakeWindow();
    await sendUserMessage({ sessionId, body: '第一条' });
    await sendUserMessage({ sessionId, body: '第二条' });

    const { router, routeUserChat } = makeSpyRouter();
    setSessionRouter(router);
    sent.length = 0;

    await flushPendingDispatches();

    expect(routeUserChat.mock.calls.map((c) => (c[0] as { body: string }).body)).toEqual([
      '第一条',
      '第二条',
    ]);
    expect(routeUserChat.mock.calls[0]![0]).toMatchObject({
      sessionId,
      assignmentId: 'inst-a',
      systemKickoff: false,
      sourceTaskId: null,
    });
    expect(__pendingDispatchesForTest()).toHaveLength(0);

    const cleared = sent.filter((e) => e.channel === 'session:pendingDispatch');
    expect(cleared).toHaveLength(1);
    expect(cleared[0]!.payload).toMatchObject({ sessionId, count: 0, timedOut: false });
  });

  it('无 router 时 no-op：队列保留、不抛错', async () => {
    const sessionId = seedSingleAgentSession();
    installFakeWindow();
    await sendUserMessage({ sessionId, body: '等就绪' });

    await expect(flushPendingDispatches()).resolves.toBeUndefined();
    expect(__pendingDispatchesForTest()).toHaveLength(1);
  });

  it('单条派发失败不阻断后续（逐条 try/catch）', async () => {
    const sessionId = seedSingleAgentSession();
    installFakeWindow();
    await sendUserMessage({ sessionId, body: '会失败' });
    await sendUserMessage({ sessionId, body: '应成功' });

    const routeUserChat = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(undefined);
    setSessionRouter({ routeUserChat } as unknown as Parameters<typeof setSessionRouter>[0]);

    await flushPendingDispatches();

    expect(routeUserChat).toHaveBeenCalledTimes(2);
    expect(__pendingDispatchesForTest()).toHaveLength(0);
  });

  // drain 串行化回归锁（2026-11-13 审查跟进）：flush 逐条 await 期间新消息
  // 不得经直路由超越队内更早消息——必须入队并由 drain 循环按序消化
  it('drain 进行中新消息入队按序消化，不走直路由（防顺序倒挂）', async () => {
    const sessionId = seedSingleAgentSession();
    installFakeWindow();
    await sendUserMessage({ sessionId, body: '队首' });

    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const routeUserChat = vi
      .fn()
      .mockImplementationOnce(async () => {
        await firstGate;
      })
      .mockResolvedValue(undefined);
    setSessionRouter({ routeUserChat } as unknown as Parameters<typeof setSessionRouter>[0]);

    const flushPromise = flushPendingDispatches();
    // flush 同步段已发起队首派发并挂起；此刻 router 在位但 drain 在途
    expect(routeUserChat).toHaveBeenCalledTimes(1);
    await sendUserMessage({ sessionId, body: 'drain 中新消息' });
    expect(routeUserChat).toHaveBeenCalledTimes(1);
    expect(__pendingDispatchesForTest()).toHaveLength(1);

    releaseFirst();
    await flushPromise;
    expect(routeUserChat.mock.calls.map((c) => (c[0] as { body: string }).body)).toEqual([
      '队首',
      'drain 中新消息',
    ]);
    expect(__pendingDispatchesForTest()).toHaveLength(0);
  });
});
