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
  // 重置 store 状态：空缓存 + 仅根展开
  useFileStore.setState({
    tree: new Map(),
    expandedDirs: new Set(['.']),
    selectedFile: null,
  });
  mockApi.file.create.mockClear();
  mockApi.file.delete.mockClear();
  mockApi.file.rename.mockClear();
  mockApi.file.list.mockClear();
  mockApi.file.list.mockResolvedValue(ROOT_ENTRIES);
});

describe('file.store CRUD', () => {
  it('createPath 调用 IPC 并刷新父目录缓存', async () => {
    const { createPath } = useFileStore.getState();
    await createPath('ws-1', 'src/foo.ts', 'file');
    expect(mockApi.file.create).toHaveBeenCalledWith('ws-1', 'src/foo.ts', 'file');
    // 父目录为 src，refreshDir 会调用 list（删除缓存后再加载）
    expect(mockApi.file.list).toHaveBeenCalledWith('ws-1', 'src');
    // 缓存已写入新条目
    expect(useFileStore.getState().tree.get('src')).toBe(ROOT_ENTRIES);
  });

  it('createPath 根目录文件父目录为 "."', async () => {
    const { createPath } = useFileStore.getState();
    await createPath('ws-1', 'root.txt', 'file');
    expect(mockApi.file.list).toHaveBeenCalledWith('ws-1', '.');
  });

  it('deletePath 调用 IPC 并刷新父目录缓存', async () => {
    const { deletePath } = useFileStore.getState();
    await deletePath('ws-1', 'src/foo.ts');
    expect(mockApi.file.delete).toHaveBeenCalledWith('ws-1', 'src/foo.ts');
    expect(mockApi.file.list).toHaveBeenCalledWith('ws-1', 'src');
  });

  it('renamePath 同目录改名只刷新一次父目录', async () => {
    const { renamePath } = useFileStore.getState();
    await renamePath('ws-1', 'src/a.ts', 'src/b.ts');
    expect(mockApi.file.rename).toHaveBeenCalledWith('ws-1', 'src/a.ts', 'src/b.ts');
    // 源与目标父目录相同（均为 src），只刷新一次
    expect(mockApi.file.list).toHaveBeenCalledTimes(1);
    expect(mockApi.file.list).toHaveBeenCalledWith('ws-1', 'src');
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
});
