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
const {
  ipcHandlers,
  mockReadFile,
  mockWriteFile,
  mockListDir,
  mockSearchNames,
  mockAssertInWorkspace,
  mockShowItemInFolder,
  mockOpenPath,
  getWorkspaceMock,
} = vi.hoisted(() => {
  const ipcHandlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
  return {
    ipcHandlers,
    mockReadFile: vi.fn(),
    mockWriteFile: vi.fn(),
    mockListDir: vi.fn(),
    mockSearchNames: vi.fn(),
    mockAssertInWorkspace: vi.fn(),
    mockShowItemInFolder: vi.fn(),
    mockOpenPath: vi.fn(),
    getWorkspaceMock: vi.fn(),
  };
});

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => Promise<unknown>) => {
      ipcHandlers.set(channel, fn);
    },
  },
  // shell 边界 mock：只记录调用，不真开 Finder（openPath 失败语义=返回非空串）
  shell: {
    showItemInFolder: mockShowItemInFolder,
    openPath: mockOpenPath,
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
    searchNames: mockSearchNames,
    assertInWorkspace: mockAssertInWorkspace,
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
  mockSearchNames.mockReset();
  mockAssertInWorkspace.mockReset();
  mockShowItemInFolder.mockReset();
  mockOpenPath.mockReset();
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

describe('files/ipc.handlers file:searchNames', () => {
  it('注册 file:searchNames 通道', () => {
    expect(ipcHandlers.has('file:searchNames')).toBe(true);
  });

  it('透传 workspaceId 定位 workspace，query 原样交给 searchNames，结果直返', async () => {
    const ws = fakeWorkspace('ws-1', path.join(tmpRoot, 'ws-1'));
    getWorkspaceMock.mockReturnValue(ws);
    mockSearchNames.mockResolvedValue([{ path: 'src/foo.ts', isDirectory: false }]);
    const handler = ipcHandlers.get('file:searchNames')!;
    const result = (await handler(undefined, 'ws-1', 'foo')) as unknown;
    expect(mockSearchNames).toHaveBeenCalledWith('foo');
    expect(result).toEqual([{ path: 'src/foo.ts', isDirectory: false }]);
  });

  it('searchNames 抛错时错误沿 IPC 传播（reject）', async () => {
    const ws = fakeWorkspace('ws-1', path.join(tmpRoot, 'ws-1'));
    getWorkspaceMock.mockReturnValue(ws);
    mockSearchNames.mockRejectedValue(new Error('boom'));
    const handler = ipcHandlers.get('file:searchNames')!;
    await expect(handler(undefined, 'ws-1', 'x')).rejects.toThrow('boom');
  });
});

describe('files/ipc.handlers 文件区功能优化通道（absolutePath / reveal / 外部打开 / readForEditor）', () => {
  it('注册四个新通道', () => {
    expect(ipcHandlers.has('file:absolutePath')).toBe(true);
    expect(ipcHandlers.has('file:revealInFolder')).toBe(true);
    expect(ipcHandlers.has('file:openWithDefaultApp')).toBe(true);
    expect(ipcHandlers.has('file:readForEditor')).toBe(true);
  });

  it('file:absolutePath 返回 assertInWorkspace 产物', async () => {
    const ws = fakeWorkspace('ws-1', path.join(tmpRoot, 'ws-1'));
    getWorkspaceMock.mockReturnValue(ws);
    mockAssertInWorkspace.mockReturnValue('/abs/ws-1/src/foo.ts');

    const handler = ipcHandlers.get('file:absolutePath')!;
    const result = await handler({}, 'ws-1', 'src/foo.ts');

    expect(mockAssertInWorkspace).toHaveBeenCalledWith('src/foo.ts');
    expect(result).toBe('/abs/ws-1/src/foo.ts');
  });

  it('file:absolutePath 沙箱校验失败（越界）时错误沿 IPC 传播', async () => {
    const ws = fakeWorkspace('ws-1', path.join(tmpRoot, 'ws-1'));
    getWorkspaceMock.mockReturnValue(ws);
    mockAssertInWorkspace.mockImplementation(() => {
      throw new Error('路径越界: ../evil 不在 workspace 内');
    });

    const handler = ipcHandlers.get('file:absolutePath')!;
    await expect(handler({}, 'ws-1', '../evil')).rejects.toThrow(/路径越界/);
  });

  it('file:revealInFolder 沙箱校验后调 shell.showItemInFolder 并返回 {ok:true}', async () => {
    const ws = fakeWorkspace('ws-1', path.join(tmpRoot, 'ws-1'));
    getWorkspaceMock.mockReturnValue(ws);
    mockAssertInWorkspace.mockReturnValue('/abs/ws-1/src/foo.ts');

    const handler = ipcHandlers.get('file:revealInFolder')!;
    const result = await handler({}, 'ws-1', 'src/foo.ts');

    expect(mockShowItemInFolder).toHaveBeenCalledWith('/abs/ws-1/src/foo.ts');
    expect(result).toEqual({ ok: true });
  });

  it('file:revealInFolder 校验失败时不触达 shell', async () => {
    const ws = fakeWorkspace('ws-1', path.join(tmpRoot, 'ws-1'));
    getWorkspaceMock.mockReturnValue(ws);
    mockAssertInWorkspace.mockImplementation(() => {
      throw new Error('符号链接逃逸: x');
    });

    const handler = ipcHandlers.get('file:revealInFolder')!;
    await expect(handler({}, 'ws-1', 'x')).rejects.toThrow(/符号链接逃逸/);
    expect(mockShowItemInFolder).not.toHaveBeenCalled();
  });

  it('file:openWithDefaultApp 成功（openPath 返回空串）→ {ok:true}', async () => {
    const ws = fakeWorkspace('ws-1', path.join(tmpRoot, 'ws-1'));
    getWorkspaceMock.mockReturnValue(ws);
    mockAssertInWorkspace.mockReturnValue('/abs/ws-1/a.png');
    mockOpenPath.mockResolvedValue('');

    const handler = ipcHandlers.get('file:openWithDefaultApp')!;
    const result = await handler({}, 'ws-1', 'a.png');

    expect(mockOpenPath).toHaveBeenCalledWith('/abs/ws-1/a.png');
    expect(result).toEqual({ ok: true });
  });

  it('file:openWithDefaultApp openPath 返回非空错误串 → 抛错（不静默吞失败）', async () => {
    const ws = fakeWorkspace('ws-1', path.join(tmpRoot, 'ws-1'));
    getWorkspaceMock.mockReturnValue(ws);
    mockAssertInWorkspace.mockReturnValue('/abs/ws-1/a.png');
    mockOpenPath.mockResolvedValue('no application knows how to open it');

    const handler = ipcHandlers.get('file:openWithDefaultApp')!;
    await expect(handler({}, 'ws-1', 'a.png')).rejects.toThrow(/外部应用打开失败/);
  });

  it('file:readForEditor 文本文件（含多字节中文）→ {kind:"text", content}', async () => {
    const ws = fakeWorkspace('ws-1', path.join(tmpRoot, 'ws-1'));
    getWorkspaceMock.mockReturnValue(ws);
    mockReadFile.mockResolvedValue(Buffer.from('hello 你好\n', 'utf-8'));

    const handler = ipcHandlers.get('file:readForEditor')!;
    const result = await handler({}, 'ws-1', 'note.md');

    expect(mockReadFile).toHaveBeenCalledWith('note.md');
    expect(result).toEqual({ kind: 'text', content: 'hello 你好\n' });
  });

  it('file:readForEditor 二进制文件（PNG 魔数，utf-8 round-trip 失败）→ {kind:"binary"}', async () => {
    const ws = fakeWorkspace('ws-1', path.join(tmpRoot, 'ws-1'));
    getWorkspaceMock.mockReturnValue(ws);
    mockReadFile.mockResolvedValue(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]),
    );

    const handler = ipcHandlers.get('file:readForEditor')!;
    const result = await handler({}, 'ws-1', 'logo.png');

    expect(result).toEqual({ kind: 'binary' });
  });

  it('file:readForEditor 空文件 → {kind:"text", content:""}（空文件可正常编辑）', async () => {
    const ws = fakeWorkspace('ws-1', path.join(tmpRoot, 'ws-1'));
    getWorkspaceMock.mockReturnValue(ws);
    mockReadFile.mockResolvedValue(Buffer.alloc(0));

    const handler = ipcHandlers.get('file:readForEditor')!;
    const result = await handler({}, 'ws-1', 'empty.txt');

    expect(result).toEqual({ kind: 'text', content: '' });
  });

  it('file:readForEditor 读侧沙箱拒绝（.git 保护）→ 错误沿 IPC 传播', async () => {
    const ws = fakeWorkspace('ws-1', path.join(tmpRoot, 'ws-1'));
    getWorkspaceMock.mockReturnValue(ws);
    // 真实链路中 .git 拒绝发生在 WorkspaceFS.readFile 内部；本层 WorkspaceFS 为
    // mock，用 readFile reject 仿真该错误形状（assertInWorkspace 自身由
    // workspace-fs.test.ts 覆盖）
    mockReadFile.mockRejectedValue(new Error('禁止操作 .git 目录: .git/config'));

    const handler = ipcHandlers.get('file:readForEditor')!;
    await expect(handler({}, 'ws-1', '.git/config')).rejects.toThrow(/禁止操作/);
  });
});
