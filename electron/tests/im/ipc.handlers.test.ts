// electron/tests/im/ipc.handlers.test.ts
//
// 验证 im: 命名空间 IPC handler 的注册与委托。重点覆盖 M1 新增的 4 个通道：
// im:createRoom / im:renameRoom / im:dissolveRoom / im:getMembers —— 它们通过
// 动态 import('./room-ops') 委托，vitest 的 vi.mock 会拦截该动态 import。
import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.mock 提升到 import 之前；工厂引用的可变桩需用 vi.hoisted 提前声明
const { ipcHandlers, roomOpsMocks } = vi.hoisted(() => {
  const ipcHandlers = new Map<string, (...args: unknown[]) => unknown>();
  return {
    ipcHandlers,
    roomOpsMocks: {
      createRoom: vi.fn(async () => ({ roomId: '!new:localhost' })),
      renameRoom: vi.fn(async () => undefined),
      dissolveRoom: vi.fn(async () => ({ dissolved: true })),
      getRoomMembers: vi.fn(async () => []),
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

vi.mock('../../src/main/conduit/manager', () => ({
  startConduit: vi.fn(async () => ({ port: 8008, baseUrl: 'http://127.0.0.1:8008' })),
}));

vi.mock('../../src/main/matrix/sync-manager', () => ({
  startSyncFromSession: vi.fn(async () => undefined),
  sendMessage: vi.fn(async () => undefined),
  sendMessageWithMentions: vi.fn(async () => undefined),
  getJoinedRooms: vi.fn(() => []),
  getRoomMessages: vi.fn(() => []),
}));

// 关键：拦截 ipc.handlers 内的动态 import('./room-ops')
vi.mock('../../src/main/im/room-ops', () => roomOpsMocks);

import { registerImHandlers } from '../../src/main/im/ipc.handlers';

beforeEach(() => {
  ipcHandlers.clear();
  Object.values(roomOpsMocks).forEach((m) => m.mockClear());
  registerImHandlers();
});

describe('im/ipc.handlers 注册', () => {
  it('注册全部 im: 通道（含 M1 新增 4 个）', () => {
    expect(ipcHandlers.has('im:startSync')).toBe(true);
    expect(ipcHandlers.has('im:send')).toBe(true);
    expect(ipcHandlers.has('im:sendWithMentions')).toBe(true);
    expect(ipcHandlers.has('im:getRooms')).toBe(true);
    expect(ipcHandlers.has('im:getMessages')).toBe(true);
    // M1 新增
    expect(ipcHandlers.has('im:createRoom')).toBe(true);
    expect(ipcHandlers.has('im:renameRoom')).toBe(true);
    expect(ipcHandlers.has('im:dissolveRoom')).toBe(true);
    expect(ipcHandlers.has('im:getMembers')).toBe(true);
  });
});

describe('im:createRoom handler', () => {
  it('委托 room-ops.createRoom 并原样回传 { roomId }', async () => {
    const input = { name: '讨论组', isDirect: false, inviteUserIds: ['@b:localhost'] };
    const res = await ipcHandlers.get('im:createRoom')!({} as never, input);
    expect(roomOpsMocks.createRoom).toHaveBeenCalledWith(input);
    expect(res).toEqual({ roomId: '!new:localhost' });
  });
});

describe('im:renameRoom handler', () => {
  it('委托 room-ops.renameRoom(roomId, name) 并回传 { ok:true }', async () => {
    const res = await ipcHandlers.get('im:renameRoom')!({} as never, '!r:localhost', '新名字');
    expect(roomOpsMocks.renameRoom).toHaveBeenCalledWith('!r:localhost', '新名字');
    expect(res).toEqual({ ok: true });
  });
});

describe('im:dissolveRoom handler', () => {
  it('委托 room-ops.dissolveRoom(roomId) 并原样回传 { dissolved }', async () => {
    const res = await ipcHandlers.get('im:dissolveRoom')!({} as never, '!r:localhost');
    expect(roomOpsMocks.dissolveRoom).toHaveBeenCalledWith('!r:localhost');
    expect(res).toEqual({ dissolved: true });
  });
});

describe('im:getMembers handler', () => {
  it('委托 room-ops.getRoomMembers(roomId) 并原样回传成员数组', async () => {
    roomOpsMocks.getRoomMembers.mockResolvedValueOnce([{ userId: '@o:localhost' }]);
    const res = await ipcHandlers.get('im:getMembers')!({} as never, '!r:localhost');
    expect(roomOpsMocks.getRoomMembers).toHaveBeenCalledWith('!r:localhost');
    expect(res).toEqual([{ userId: '@o:localhost' }]);
  });
});
