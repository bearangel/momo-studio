// renderer/src/stores/file.store.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useFileStore } from './file.store';
import type { DirEntry } from '../ipc/types';

const ROOT_ENTRIES: DirEntry[] = [
  { name: 'a.ts', isDirectory: false, size: 0 },
];
const SUB_ENTRIES: DirEntry[] = [
  { name: 'nested', isDirectory: true, size: 0 },
];

const mockApi = {
  file: {
    create: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    rename: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue(ROOT_ENTRIES),
  },
};

beforeEach(() => {
  Object.assign(globalThis, { window: { api: mockApi } });
  localStorage.clear();
  // 重置 store 状态：空缓存 + 仅根展开
  useFileStore.setState({
    tree: new Map(),
    expandedDirs: new Set(['.']),
    selectedFile: null,
    error: null,
  });
  mockApi.file.create.mockResolvedValue(undefined);
  mockApi.file.delete.mockResolvedValue(undefined);
  mockApi.file.rename.mockResolvedValue(undefined);
  mockApi.file.create.mockClear();
  mockApi.file.delete.mockClear();
  mockApi.file.rename.mockClear();
  mockApi.file.list.mockClear();
  mockApi.file.list.mockResolvedValue(ROOT_ENTRIES);
});

describe('file.store CRUD', () => {
  it('createPath 调用 IPC、清除旧 error 并刷新父目录缓存', async () => {
    useFileStore.setState({ error: '旧错误' });
    const { createPath } = useFileStore.getState();

    await createPath('ws-1', 'src/foo.ts', 'file');

    expect(mockApi.file.create).toHaveBeenCalledWith('ws-1', 'src/foo.ts', 'file');
    // 父目录为 src，refreshDir 会调用 list（删除缓存后再加载）
    expect(mockApi.file.list).toHaveBeenCalledWith('ws-1', 'src');
    // 缓存已写入新条目
    expect(useFileStore.getState().tree.get('src')).toBe(ROOT_ENTRIES);
    expect(useFileStore.getState().error).toBeNull();
  });

  it('createPath 根目录文件父目录为 "."', async () => {
    const { createPath } = useFileStore.getState();
    await createPath('ws-1', 'root.txt', 'file');
    expect(mockApi.file.list).toHaveBeenCalledWith('ws-1', '.');
  });

  it('createPath 失败时抛错并写入 error', async () => {
    const error = new Error('新建失败');
    mockApi.file.create.mockRejectedValue(error);

    await expect(useFileStore.getState().createPath('ws-1', 'src/foo.ts', 'file')).rejects.toBe(
      error,
    );

    expect(useFileStore.getState().error).toBe('新建失败');
    expect(mockApi.file.list).not.toHaveBeenCalled();
  });

  it('deletePath 调用 IPC、清除旧 error 并刷新父目录缓存', async () => {
    useFileStore.setState({ error: '旧错误' });
    const { deletePath } = useFileStore.getState();

    await deletePath('ws-1', 'src/foo.ts');

    expect(mockApi.file.delete).toHaveBeenCalledWith('ws-1', 'src/foo.ts');
    expect(mockApi.file.list).toHaveBeenCalledWith('ws-1', 'src');
    expect(useFileStore.getState().error).toBeNull();
  });

  it('deletePath 失败时抛错并写入 error', async () => {
    const error = new Error('删除失败');
    mockApi.file.delete.mockRejectedValue(error);

    await expect(useFileStore.getState().deletePath('ws-1', 'src/foo.ts')).rejects.toBe(error);

    expect(useFileStore.getState().error).toBe('删除失败');
    expect(mockApi.file.list).not.toHaveBeenCalled();
  });

  it('renamePath 同目录改名只刷新一次父目录并清除旧 error', async () => {
    useFileStore.setState({ error: '旧错误' });
    const { renamePath } = useFileStore.getState();

    await renamePath('ws-1', 'src/a.ts', 'src/b.ts');

    expect(mockApi.file.rename).toHaveBeenCalledWith('ws-1', 'src/a.ts', 'src/b.ts');
    // 源与目标父目录相同（均为 src），只刷新一次
    expect(mockApi.file.list).toHaveBeenCalledTimes(1);
    expect(mockApi.file.list).toHaveBeenCalledWith('ws-1', 'src');
    expect(useFileStore.getState().error).toBeNull();
  });

  it('renamePath 跨目录移动刷新源与目标两个父目录', async () => {
    mockApi.file.list
      .mockResolvedValueOnce(SUB_ENTRIES)
      .mockResolvedValueOnce(ROOT_ENTRIES);
    const { renamePath } = useFileStore.getState();
    await renamePath('ws-1', 'src/a.ts', 'dst/a.ts');
    expect(mockApi.file.rename).toHaveBeenCalledWith('ws-1', 'src/a.ts', 'dst/a.ts');
    // 源 src 与目标 dst 不同，各刷新一次
    expect(mockApi.file.list).toHaveBeenCalledTimes(2);
    expect(mockApi.file.list).toHaveBeenNthCalledWith(1, 'ws-1', 'src');
    expect(mockApi.file.list).toHaveBeenNthCalledWith(2, 'ws-1', 'dst');
  });

  it('renamePath 失败时抛错并写入 error', async () => {
    const error = new Error('重命名失败');
    mockApi.file.rename.mockRejectedValue(error);

    await expect(
      useFileStore.getState().renamePath('ws-1', 'src/a.ts', 'dst/a.ts'),
    ).rejects.toBe(error);

    expect(useFileStore.getState().error).toBe('重命名失败');
    expect(mockApi.file.list).not.toHaveBeenCalled();
  });
});

describe('file.store expandedDirs 持久化', () => {
  it('toggleDir 持久化展开目录', () => {
    useFileStore.getState().toggleDir('src');

    expect([...useFileStore.getState().expandedDirs]).toEqual(['.', 'src']);
    expect(localStorage.getItem('fileTree.expandedDirs')).toBe('[".","src"]');
  });

  it('collapseAll 持久化仅展开根目录', () => {
    useFileStore.setState({ expandedDirs: new Set(['.', 'src']) });

    useFileStore.getState().collapseAll();

    expect([...useFileStore.getState().expandedDirs]).toEqual(['.']);
    expect(localStorage.getItem('fileTree.expandedDirs')).toBe('["."]');
  });

  it('初始化时从 localStorage 恢复展开目录', async () => {
    localStorage.setItem('fileTree.expandedDirs', '[".","src"]');
    vi.resetModules();

    const { useFileStore: restoredFileStore } = await import('./file.store');

    expect([...restoredFileStore.getState().expandedDirs]).toEqual(['.', 'src']);
  });
});
