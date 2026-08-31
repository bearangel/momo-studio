// electron/tests/im/session.ipc.handlers.test.ts
//
// 验证 session: 命名空间 IPC handler 的注册与委托（2.0.0 P1 Task 8；
// v25 Task 6 通道面更换：泛化 session:create 退役 → createQuick / createCollab）。
// 模式：vi.mock('electron') 捕获 ipcMain.handle 注册表，断言通道注册 +
// 转调 session-ops / session-service / team 服务，参数透传正确。
import { describe, it, expect, vi, beforeEach } from 'vitest';

// 可变桩需 vi.hoisted 提前声明（vi.mock 工厂提升到 import 之前）
const {
  ipcHandlers,
  sessionOpsMocks,
  sessionServiceMocks,
  sessionsRepoMocks,
  messagesRepoMocks,
  eventsRepoMocks,
  exporterMocks,
  agentCrudMocks,
  workspaceCrudMocks,
  teamMocks,
} = vi.hoisted(() => {
  const ipcHandlers = new Map<string, (...args: unknown[]) => unknown>();
  return {
    ipcHandlers,
    sessionOpsMocks: {
      getSessionsForWorkspace: vi.fn(() => []),
      createSession: vi.fn(() => ({
        id: 'sess-new',
        workspaceId: 'ws-1',
        title: '新会话',
        titleAuto: true,
        kind: 'chat',
        settingsJson: null,
        createdAt: 1,
        updatedAt: 1,
        lastMessageAt: null,
      })),
      renameSession: vi.fn(() => undefined),
      deleteSessionOp: vi.fn(() => undefined),
      getSessionMembersInfo: vi.fn(() => []),
    },
    sessionServiceMocks: {
      sendUserMessage: vi.fn(async () => undefined),
    },
    sessionsRepoMocks: {
      getSession: vi.fn(() => null),
    },
    messagesRepoMocks: {
      listMessagesBySession: vi.fn(() => []),
      listOlderMessages: vi.fn(() => []),
    },
    eventsRepoMocks: {
      listEventsByMessage: vi.fn(() => []),
    },
    exporterMocks: {
      formatRoomToMarkdown: vi.fn(() => '# 导出内容'),
    },
    agentCrudMocks: {
      listMembers: vi.fn(() => []),
      getAgentDefinition: vi.fn(() => null),
    },
    workspaceCrudMocks: {
      listWorkspaces: vi.fn(() => []),
      getWorkspace: vi.fn((): null => null),
    },
    teamMocks: {
      listTeams: vi.fn(() => []),
    },
  };
});

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      ipcHandlers.set(channel, fn);
    },
  },
}));

vi.mock('../../src/main/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../src/main/im/session-ops', () => sessionOpsMocks);
vi.mock('../../src/main/im/session-service', () => sessionServiceMocks);
vi.mock('../../src/main/storage/sessions/repo', () => sessionsRepoMocks);
vi.mock('../../src/main/storage/messages/repo', () => messagesRepoMocks);
vi.mock('../../src/main/storage/messages/events-repo', () => eventsRepoMocks);
vi.mock('../../src/main/im/markdown-exporter', () => exporterMocks);
vi.mock('../../src/main/agent/crud', () => agentCrudMocks);
vi.mock('../../src/main/workspace/crud', () => workspaceCrudMocks);
vi.mock('../../src/main/agent/team', () => teamMocks);

import { registerSessionIpcHandlers } from '../../src/main/im/session.ipc.handlers';

/** 复用的 SessionRow fixture */
const sessionRow = {
  id: 'sess-1',
  workspaceId: 'ws-1',
  title: '调试会话',
  titleAuto: false,
  kind: 'chat',
  settingsJson: null,
  createdAt: 1,
  updatedAt: 1,
  lastMessageAt: 123,
} as const;

/** 复用的 MessageRow fixture（agent 消息，sender 为 bot userId） */
const msgRow = {
  id: 'msg-1',
  sessionId: 'sess-1',
  sender: '@bot.helper:home',
  eventType: 'm.room.message',
  body: '你好',
  streamSessionId: null,
  parentStreamSessionId: null,
  segmentOf: null,
  segmentIndex: null,
  status: 'done',
  source: 'local',
  workspaceId: 'ws-1',
  taskId: null,
  createdAt: 100,
  updatedAt: 100,
} as const;

beforeEach(() => {
  ipcHandlers.clear();
  Object.values(sessionOpsMocks).forEach((m) => m.mockClear());
  Object.values(sessionServiceMocks).forEach((m) => m.mockClear());
  Object.values(sessionsRepoMocks).forEach((m) => m.mockClear());
  Object.values(messagesRepoMocks).forEach((m) => m.mockClear());
  Object.values(eventsRepoMocks).forEach((m) => m.mockClear());
  Object.values(exporterMocks).forEach((m) => m.mockClear());
  Object.values(agentCrudMocks).forEach((m) => m.mockClear());
  Object.values(workspaceCrudMocks).forEach((m) => m.mockClear());
  Object.values(teamMocks).forEach((m) => m.mockClear());
  registerSessionIpcHandlers();
});

describe('session/ipc.handlers 注册', () => {
  it('注册全部 session: 通道（含 createQuick/createCollab，泛化 create 退役）', () => {
    const expected = [
      'session:list',
      'session:get',
      'session:createQuick',
      'session:createCollab',
      'session:rename',
      'session:delete',
      'session:send',
      'session:getMessages',
      'session:loadOlder',
      'session:exportMessages',
    ];
    for (const ch of expected) expect(ipcHandlers.has(ch), ch).toBe(true);
    // 泛化 session:create 退役零残留锁（spec §5）
    expect(ipcHandlers.has('session:create')).toBe(false);
  });
});

describe('session:list handler', () => {
  it('委托 session-ops.getSessionsForWorkspace(workspaceId) 并原样回传', async () => {
    sessionOpsMocks.getSessionsForWorkspace.mockReturnValueOnce([{ id: 'sess-1' }]);
    const res = await ipcHandlers.get('session:list')!({} as never, 'ws-1');
    expect(sessionOpsMocks.getSessionsForWorkspace).toHaveBeenCalledWith('ws-1');
    expect(res).toEqual([{ id: 'sess-1' }]);
  });

  it('workspaceId 缺省时透传 undefined（全量会话）', async () => {
    await ipcHandlers.get('session:list')!({} as never, undefined);
    expect(sessionOpsMocks.getSessionsForWorkspace).toHaveBeenCalledWith(undefined);
  });
});

describe('session:get handler', () => {
  it('返回 { session, members }（getSession + getSessionMembersInfo）', async () => {
    sessionsRepoMocks.getSession.mockReturnValueOnce(sessionRow);
    sessionOpsMocks.getSessionMembersInfo.mockReturnValueOnce([
      { instanceId: 'inst-1', agentName: '小助手', isLeader: true },
    ]);
    const res = await ipcHandlers.get('session:get')!({} as never, 'sess-1');
    expect(sessionsRepoMocks.getSession).toHaveBeenCalledWith('sess-1');
    expect(sessionOpsMocks.getSessionMembersInfo).toHaveBeenCalledWith('sess-1');
    expect(res).toEqual({
      session: sessionRow,
      members: [{ instanceId: 'inst-1', agentName: '小助手', isLeader: true }],
    });
  });

  it('会话不存在时抛错（renderer 收到明确错误）', async () => {
    sessionsRepoMocks.getSession.mockReturnValueOnce(null);
    await expect(
      ipcHandlers.get('session:get')!({} as never, 'sess-404'),
    ).rejects.toThrow('会话不存在');
  });
});

describe('session:createQuick handler', () => {
  it('有默认 agent：单成员建会（占位标题）并返回 SessionSummary', async () => {
    workspaceCrudMocks.getWorkspace.mockReturnValueOnce({
      id: 'ws-1',
      defaultAgentInstanceId: 'inst-default',
    });
    sessionOpsMocks.createSession.mockReturnValueOnce({
      ...sessionRow, id: 'sess-quick', title: '新会话', titleAuto: true, lastMessageAt: null,
    });
    sessionOpsMocks.getSessionMembersInfo.mockReturnValueOnce([
      { instanceId: 'inst-default', agentName: '默认Agent', iconEmoji: '🤖', isLeader: false, lastRunning: true },
    ]);

    const res = await ipcHandlers.get('session:createQuick')!({} as never, 'ws-1');

    // 委托 createSession：占位标题 + 单成员（默认 agent）+ kind=chat
    expect(workspaceCrudMocks.getWorkspace).toHaveBeenCalledWith('ws-1');
    expect(sessionOpsMocks.createSession).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      title: '新会话',
      memberInstanceIds: ['inst-default'],
      kind: 'chat',
    });
    // 返回 SessionSummary（id/titleAuto/members 齐全——renderer 直接消费）
    expect(res).toEqual({
      id: 'sess-quick',
      workspaceId: 'ws-1',
      title: '新会话',
      titleAuto: true,
      kind: 'chat',
      lastMessageAt: null,
      members: [
        { instanceId: 'inst-default', agentName: '默认Agent', iconEmoji: '🤖', isLeader: false, lastRunning: true },
      ],
    });
  });

  it('无默认 agent：reject NO_DEFAULT_AGENT 且零建会副作用', async () => {
    workspaceCrudMocks.getWorkspace.mockReturnValueOnce({
      id: 'ws-1',
      defaultAgentInstanceId: null,
    });
    await expect(
      ipcHandlers.get('session:createQuick')!({} as never, 'ws-1'),
    ).rejects.toThrow('NO_DEFAULT_AGENT');
    expect(sessionOpsMocks.createSession).not.toHaveBeenCalled();
  });

  it('workspace 不存在：抛明确错误', async () => {
    workspaceCrudMocks.getWorkspace.mockReturnValueOnce(null);
    await expect(
      ipcHandlers.get('session:createQuick')!({} as never, 'ws-404'),
    ).rejects.toThrow('workspace');
  });
});

describe('session:createCollab handler', () => {
  it('单 agent 目标：指定标题 + 单成员建会', async () => {
    workspaceCrudMocks.getWorkspace.mockReturnValueOnce({
      id: 'ws-1',
      defaultAgentInstanceId: null,
    });
    sessionOpsMocks.createSession.mockReturnValueOnce({
      ...sessionRow, id: 'sess-collab', title: '规划评审', titleAuto: false, lastMessageAt: null,
    });

    const res = await ipcHandlers.get('session:createCollab')!({} as never, 'ws-1', '规划评审', {
      type: 'agent',
      instanceId: 'inst-7',
    });

    expect(sessionOpsMocks.createSession).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      title: '规划评审',
      memberInstanceIds: ['inst-7'],
      kind: 'chat',
    });
    expect(res).toMatchObject({ id: 'sess-collab', title: '规划评审' });
  });

  it('标题留空：动态命名占位（新会话）', async () => {
    workspaceCrudMocks.getWorkspace.mockReturnValueOnce({ id: 'ws-1' });
    await ipcHandlers.get('session:createCollab')!({} as never, 'ws-1', undefined, {
      type: 'agent',
      instanceId: 'inst-7',
    });
    expect(sessionOpsMocks.createSession).toHaveBeenCalledWith(
      expect.objectContaining({ title: '新会话' }),
    );
  });

  it('团队目标：展开团队当前成员快照写入', async () => {
    workspaceCrudMocks.getWorkspace.mockReturnValueOnce({ id: 'ws-1' });
    teamMocks.listTeams.mockReturnValueOnce([
      {
        id: 'team-1',
        workspaceId: 'ws-1',
        name: '攻坚组',
        iconEmoji: '👥',
        leaderInstanceId: 'inst-leader',
        members: [
          { instanceId: 'inst-leader' },
          { instanceId: 'inst-a' },
        ],
        createdAt: '2026-09-01T00:00:00Z',
      },
    ]);

    await ipcHandlers.get('session:createCollab')!({} as never, 'ws-1', '协作', {
      type: 'team',
      teamId: 'team-1',
    });

    expect(teamMocks.listTeams).toHaveBeenCalledWith('ws-1');
    expect(sessionOpsMocks.createSession).toHaveBeenCalledWith({
      workspaceId: 'ws-1',
      title: '协作',
      memberInstanceIds: ['inst-leader', 'inst-a'],
      kind: 'chat',
    });
  });

  it('团队不存在：抛明确错误，零建会副作用', async () => {
    workspaceCrudMocks.getWorkspace.mockReturnValueOnce({ id: 'ws-1' });
    teamMocks.listTeams.mockReturnValueOnce([]);
    await expect(
      ipcHandlers.get('session:createCollab')!({} as never, 'ws-1', '协作', {
        type: 'team',
        teamId: 'team-404',
      }),
    ).rejects.toThrow('团队不存在');
    expect(sessionOpsMocks.createSession).not.toHaveBeenCalled();
  });
});

describe('session:rename handler', () => {
  it('委托 session-ops.renameSession(id, title) 并回传 { ok: true }', async () => {
    const res = await ipcHandlers.get('session:rename')!({} as never, 'sess-1', '新名字');
    expect(sessionOpsMocks.renameSession).toHaveBeenCalledWith('sess-1', '新名字');
    expect(res).toEqual({ ok: true });
  });
});

describe('session:delete handler', () => {
  it('委托 session-ops.deleteSessionOp(id) 并回传 { ok: true }', async () => {
    const res = await ipcHandlers.get('session:delete')!({} as never, 'sess-1');
    expect(sessionOpsMocks.deleteSessionOp).toHaveBeenCalledWith('sess-1');
    expect(res).toEqual({ ok: true });
  });

  it('deleteSessionOp 抛错原样传播', async () => {
    sessionOpsMocks.deleteSessionOp.mockImplementationOnce(() => {
      throw new Error('解散失败');
    });
    await expect(
      ipcHandlers.get('session:delete')!({} as never, 'sess-x'),
    ).rejects.toThrow('解散失败');
  });
});

describe('session:send handler', () => {
  it('委托 session-service.sendUserMessage({ sessionId, body, mentionedInstanceIds })', async () => {
    await ipcHandlers.get('session:send')!({} as never, 'sess-1', '你好', ['inst-1']);
    expect(sessionServiceMocks.sendUserMessage).toHaveBeenCalledWith({
      sessionId: 'sess-1',
      body: '你好',
      mentionedInstanceIds: ['inst-1'],
    });
  });

  it('mentionedInstanceIds 缺省时传 undefined', async () => {
    await ipcHandlers.get('session:send')!({} as never, 'sess-1', '你好');
    expect(sessionServiceMocks.sendUserMessage).toHaveBeenCalledWith({
      sessionId: 'sess-1',
      body: '你好',
      mentionedInstanceIds: undefined,
    });
  });
});

describe('session:getMessages handler', () => {
  it('返回 messages + 每条消息的 eventsByMessage', async () => {
    messagesRepoMocks.listMessagesBySession.mockReturnValueOnce([msgRow]);
    eventsRepoMocks.listEventsByMessage.mockReturnValueOnce([
      { id: 'evt-1', messageId: 'msg-1', seq: 1 },
    ]);
    const res = await ipcHandlers.get('session:getMessages')!({} as never, 'sess-1');
    expect(messagesRepoMocks.listMessagesBySession).toHaveBeenCalledWith('sess-1');
    expect(eventsRepoMocks.listEventsByMessage).toHaveBeenCalledWith('msg-1');
    expect(res).toEqual({
      messages: [msgRow],
      eventsByMessage: { 'msg-1': [{ id: 'evt-1', messageId: 'msg-1', seq: 1 }] },
    });
  });
});

describe('session:loadOlder handler', () => {
  it('委托 listOlderMessages(sessionId, beforeTs, count) 并回传 hasMore', async () => {
    messagesRepoMocks.listOlderMessages.mockReturnValueOnce([msgRow, msgRow, msgRow]);
    const res = await ipcHandlers.get('session:loadOlder')!({} as never, 'sess-1', 500, 3);
    expect(messagesRepoMocks.listOlderMessages).toHaveBeenCalledWith('sess-1', 500, 3);
    expect(res).toEqual({
      messages: [msgRow, msgRow, msgRow],
      eventsByMessage: { 'msg-1': [] },
      hasMore: true, // 满批 → 可能还有更早的
    });
  });

  it('count 缺省时默认 30；未满批 hasMore=false', async () => {
    messagesRepoMocks.listOlderMessages.mockReturnValueOnce([msgRow]);
    const res = await ipcHandlers.get('session:loadOlder')!({} as never, 'sess-1', 500);
    expect(messagesRepoMocks.listOlderMessages).toHaveBeenCalledWith('sess-1', 500, 30);
    expect(res).toEqual({
      messages: [msgRow],
      eventsByMessage: { 'msg-1': [] },
      hasMore: false,
    });
  });
});

describe('session:exportMessages handler', () => {
  it('按 instanceId 反查 botName 后走 markdown-exporter，返回 { filename, content }', async () => {
    sessionsRepoMocks.getSession.mockReturnValueOnce(sessionRow);
    messagesRepoMocks.listMessagesBySession.mockReturnValueOnce([msgRow]);
    workspaceCrudMocks.listWorkspaces.mockReturnValueOnce([{ id: 'ws-1' }]);
    agentCrudMocks.listMembers.mockReturnValueOnce([
      { instanceId: 'inst-1', agentDefinitionId: 'def-1', agentUserId: '@bot.helper:home' },
    ]);
    agentCrudMocks.getAgentDefinition.mockReturnValueOnce({ name: '小助手' });

    const res = await ipcHandlers.get('session:exportMessages')!({} as never, 'sess-1', 50);

    // 1. 拉 limit 条消息
    expect(messagesRepoMocks.listMessagesBySession).toHaveBeenCalledWith('sess-1', { limit: 50 });
    // 2. 导出器收到 botName 已注入的消息 + 会话标题作为 roomName
    expect(exporterMocks.formatRoomToMarkdown).toHaveBeenCalledWith(
      [expect.objectContaining({ botName: '小助手', roomId: 'sess-1' })],
      expect.objectContaining({ roomName: '调试会话', roomId: 'sess-1', requestedLimit: 50, actualCount: 1 }),
    );
    // 3. 返回 filename 前缀 + 导出器产物
    expect(res.filename.startsWith('momo-session-')).toBe(true);
    expect(res.content).toBe('# 导出内容');
  });

  it('会话不存在时用 sessionId 兜底 roomName（filename 仍可生成）', async () => {
    sessionsRepoMocks.getSession.mockReturnValueOnce(null);
    messagesRepoMocks.listMessagesBySession.mockReturnValueOnce([]);

    const res = await ipcHandlers.get('session:exportMessages')!({} as never, 'sess-404', 50);
    expect(exporterMocks.formatRoomToMarkdown).toHaveBeenCalledWith(
      [],
      expect.objectContaining({ roomName: 'sess-404', roomId: 'sess-404' }),
    );
    expect(res.filename.startsWith('momo-session-')).toBe(true);
  });
});
