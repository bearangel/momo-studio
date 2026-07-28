// electron/tests/files/ipc.handlers.test.ts
//
// 验证 file:read / file:write / file:list 三个 IPC handler 的委托与错误传播。
// 通过 vi.mock 解耦 ipcMain / logger / WorkspaceFS / getWorkspace。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// vi.mock 会被提升到所有 import 之前；所有被工厂引用的 mock helper 必须用
// vi.hoisted 提前声明，否则会触发 TDZ 错误。
const { ipcHandlers, mockReadFile, mockWriteFile, mockListDir, getWorkspaceMock } = vi.hoisted(
  () => {
    const ipcHandlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
    return {
      ipcHandlers,
      mockReadFile: vi.fn(),
      mockWriteFile: vi.fn(),
      mockListDir: vi.fn(),
      getWorkspaceMock: vi.fn(),
    };
  },
);

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => Promise<unknown>) => {
      ipcHandlers.set(channel, fn);
    },
  },
}));

vi.mock('../../src/main/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../src/main/files/workspace-fs', () => ({
  WorkspaceFS: vi.fn().mockImplementation(() => ({
    readFile: mockReadFile,
    writeFile: mockWriteFile,
    listDir: mockListDir,
  })),
}));

vi.mock('../../src/main/workspace/crud', () => ({
  getWorkspace: getWorkspaceMock,
}));

import { registerFileHandlers, __resetFsCacheForTest } from '../../src/main/files/ipc.handlers';

const tmpRoot = path.join(os.tmpdir(), `ap-file-ipc-test-${Date.now()}`);

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  ipcHandlers.clear();
  mockReadFile.mockReset();
  mockWriteFile.mockReset();
  mockListDir.mockReset();
  getWorkspaceMock.mockReset();
  __resetFsCacheForTest();
  registerFileHandlers();
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function fakeWorkspace(id: string, directoryPath: string) {
  return { id, directoryPath };
}

describe('files/ipc.handlers', () => {
  it('注册 file:read / file:write / file:list 三个通道', () => {
    expect(ipcHandlers.has('file:read')).toBe(true);
    expect(ipcHandlers.has('file:write')).toBe(true);
    expect(ipcHandlers.has('file:list')).toBe(true);
  });

  it('file:read 返回 utf-8 字符串', async () => {
    const ws = fakeWorkspace('ws-1', path.join(tmpRoot, 'ws-1'));
    getWorkspaceMock.mockReturnValue(ws);
    mockReadFile.mockResolvedValue(Buffer.from('hello 你好', 'utf-8'));

    const handler = ipcHandlers.get('file:read');
    if (!handler) throw new Error('file:read 未注册');
    const result = await handler({}, 'ws-1', 'note.md');

    expect(result).toBe('hello 你好');
    expect(mockReadFile).toHaveBeenCalledWith('note.md');
  });

  it('file:write 把内容写入对应 workspace 的文件', async () => {
    const ws = fakeWorkspace('ws-1', path.join(tmpRoot, 'ws-1'));
    getWorkspaceMock.mockReturnValue(ws);
    mockWriteFile.mockResolvedValue(undefined);

    const handler = ipcHandlers.get('file:write');
    if (!handler) throw new Error('file:write 未注册');
    await handler({}, 'ws-1', 'note.md', '你好');

    expect(mockWriteFile).toHaveBeenCalledWith('note.md', '你好');
  });

  it('file:list 返回目录条目数组', async () => {
    const ws = fakeWorkspace('ws-1', path.join(tmpRoot, 'ws-1'));
    getWorkspaceMock.mockReturnValue(ws);
    const entries = [{ name: 'a.md', isDirectory: false, size: 5 }];
    mockListDir.mockResolvedValue(entries);

    const handler = ipcHandlers.get('file:list');
    if (!handler) throw new Error('file:list 未注册');
    const result = await handler({}, 'ws-1', '.');

    expect(result).toBe(entries);
    expect(mockListDir).toHaveBeenCalledWith('.');
  });

  it('workspace 不存在时 file:read 抛出明确错误', async () => {
    getWorkspaceMock.mockReturnValue(null);

    const handler = ipcHandlers.get('file:read');
    if (!handler) throw new Error('file:read 未注册');
    await expect(handler({}, 'missing', 'note.md')).rejects.toThrow(/Workspace 不存在/);
    expect(mockReadFile).not.toHaveBeenCalled();
  });

  it('file:write 复用缓存的 WorkspaceFS 实例（同一 workspace 多次写入只构造一次）', async () => {
    const ws = fakeWorkspace('ws-1', path.join(tmpRoot, 'ws-1'));
    getWorkspaceMock.mockReturnValue(ws);
    mockWriteFile.mockResolvedValue(undefined);

    const handler = ipcHandlers.get('file:write');
    if (!handler) throw new Error('file:write 未注册');
    await handler({}, 'ws-1', 'a.md', 'A');
    await handler({}, 'ws-1', 'b.md', 'B');

    expect(getWorkspaceMock).toHaveBeenCalledTimes(1);
  });
});
