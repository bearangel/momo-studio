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
  // 重置 store 状态：空缓存 + 仅根展开 + 未激活 workspace + 根目录为选中目录
  useFileStore.setState({
    tree: new Map(),
    expandedDirs: new Set(['.']),
    selectedFile: null,
    selectedDir: '.',
    error: null,
    workspaceId: null,
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

  it('createPath 刷新失败时抛错并写入 error', async () => {
    const error = new Error('刷新失败');
    mockApi.file.list.mockRejectedValue(error);

    await expect(useFileStore.getState().createPath('ws-1', 'src/foo.ts', 'file')).rejects.toBe(
      error,
    );

    expect(useFileStore.getState().error).toBe('刷新失败');
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

  it('deletePath 刷新失败时抛错并写入 error', async () => {
    const error = new Error('刷新失败');
    mockApi.file.list.mockRejectedValue(error);

    await expect(useFileStore.getState().deletePath('ws-1', 'src/foo.ts')).rejects.toBe(error);

    expect(useFileStore.getState().error).toBe('刷新失败');
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

  it('renamePath 刷新失败时抛错并写入 error', async () => {
    const error = new Error('刷新失败');
    mockApi.file.list.mockRejectedValue(error);

    await expect(
      useFileStore.getState().renamePath('ws-1', 'src/a.ts', 'src/b.ts'),
    ).rejects.toBe(error);

    expect(useFileStore.getState().error).toBe('刷新失败');
  });
});

describe('file.store expandedDirs 按 workspace 隔离持久化', () => {
  it('initWorkspace 从该 workspace 专属 key 恢复展开目录', () => {
    localStorage.setItem('fileTree.expanded.ws-1', '[".","src"]');

    useFileStore.getState().initWorkspace('ws-1');

    expect(useFileStore.getState().workspaceId).toBe('ws-1');
    expect([...useFileStore.getState().expandedDirs]).toEqual(['.', 'src']);
  });

  it('initWorkspace 无持久化数据时默认仅展开根目录', () => {
    useFileStore.getState().initWorkspace('ws-2');

    expect([...useFileStore.getState().expandedDirs]).toEqual(['.']);
  });

  it('initWorkspace 同一 workspace 重复调用不重新加载（保留内存态）', () => {
    localStorage.setItem('fileTree.expanded.ws-1', '[".","src"]');
    useFileStore.getState().initWorkspace('ws-1');
    // 手动改写内存态，使其与持久化数据不一致（绕过持久化）
    useFileStore.setState({ expandedDirs: new Set(['.']) });

    useFileStore.getState().initWorkspace('ws-1');

    // guard 生效：未重新从 localStorage 读取 src
    expect([...useFileStore.getState().expandedDirs]).toEqual(['.']);
  });

  it('切换 workspace 加载各自独立的展开态', () => {
    localStorage.setItem('fileTree.expanded.ws-1', '[".","src"]');
    localStorage.setItem('fileTree.expanded.ws-2', '[".","docs"]');

    useFileStore.getState().initWorkspace('ws-1');
    expect([...useFileStore.getState().expandedDirs]).toEqual(['.', 'src']);

    useFileStore.getState().initWorkspace('ws-2');
    expect([...useFileStore.getState().expandedDirs]).toEqual(['.', 'docs']);
  });

  it('toggleDir 持久化到当前 workspace 的专属 key', () => {
    useFileStore.getState().initWorkspace('ws-1');

    useFileStore.getState().toggleDir('src');

    expect([...useFileStore.getState().expandedDirs]).toEqual(['.', 'src']);
    expect(localStorage.getItem('fileTree.expanded.ws-1')).toBe('[".","src"]');
    // 不污染其他 workspace
    expect(localStorage.getItem('fileTree.expanded.ws-2')).toBeNull();
  });

  it('toggleDir 在 localStorage 写入失败时仍更新内存状态', () => {
    useFileStore.getState().initWorkspace('ws-1');
    const setItemSpy = vi
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementation(() => {
        throw new Error('QuotaExceededError');
      });

    useFileStore.getState().toggleDir('src');

    expect([...useFileStore.getState().expandedDirs]).toEqual(['.', 'src']);
    setItemSpy.mockRestore();
  });

  it('collapseAll 持久化仅展开根目录到当前 workspace', () => {
    useFileStore.getState().initWorkspace('ws-1');
    useFileStore.setState({ expandedDirs: new Set(['.', 'src']) });

    useFileStore.getState().collapseAll();

    expect([...useFileStore.getState().expandedDirs]).toEqual(['.']);
    expect(localStorage.getItem('fileTree.expanded.ws-1')).toBe('["."]');
  });

  it('未初始化 workspace 时 toggleDir 仅更新内存（不写持久化）', () => {
    // workspaceId 为 null（未调用 initWorkspace）
    useFileStore.getState().toggleDir('src');

    expect([...useFileStore.getState().expandedDirs]).toEqual(['.', 'src']);
    expect(localStorage.length).toBe(0);
  });
});

describe('file.store selectedDir', () => {
  it('selectDir 设置当前选中目录', () => {
    useFileStore.getState().selectDir('src');
    expect(useFileStore.getState().selectedDir).toBe('src');
  });

  it('selectDir 根目录', () => {
    useFileStore.getState().selectDir('.');
    expect(useFileStore.getState().selectedDir).toBe('.');
  });

  it('selectedDir 不持久化（initWorkspace 不读取它）', () => {
    localStorage.setItem('fileTree.expanded.ws-1', '["." ,"src"]');
    useFileStore.setState({ selectedDir: 'src' });
    useFileStore.getState().initWorkspace('ws-1');
    // initWorkspace 重置 selectedDir 为 '.'
    expect(useFileStore.getState().selectedDir).toBe('.');
  });

  it('deletePath 删除选中目录本身时重置 selectedDir 为 "."', async () => {
    useFileStore.setState({ selectedDir: 'src' });
    await useFileStore.getState().deletePath('ws-1', 'src');
    expect(useFileStore.getState().selectedDir).toBe('.');
  });

  it('deletePath 删除选中目录的子目录时不重置 selectedDir', async () => {
    useFileStore.setState({ selectedDir: 'src' });
    await useFileStore.getState().deletePath('ws-1', 'src/nested');
    expect(useFileStore.getState().selectedDir).toBe('src');
  });

  it('deletePath 删除选中目录的祖先时重置 selectedDir 为 "."', async () => {
    // selectedDir 是 src/utils，删除 src（祖先）应重置
    useFileStore.setState({ selectedDir: 'src/utils' });
    await useFileStore.getState().deletePath('ws-1', 'src');
    expect(useFileStore.getState().selectedDir).toBe('.');
  });

  it('deletePath 删除无关目录时不影响 selectedDir', async () => {
    useFileStore.setState({ selectedDir: 'src' });
    await useFileStore.getState().deletePath('ws-1', 'docs');
    expect(useFileStore.getState().selectedDir).toBe('src');
  });

  it('renamePath 重命名选中目录本身时更新 selectedDir', async () => {
    useFileStore.setState({ selectedDir: 'src' });
    await useFileStore.getState().renamePath('ws-1', 'src', 'lib');
    expect(useFileStore.getState().selectedDir).toBe('lib');
  });

  it('renamePath 重命名选中目录的祖先时更新 selectedDir 前缀', async () => {
    // selectedDir 是 src/utils，src 改名为 lib，selectedDir 应变为 lib/utils
    useFileStore.setState({ selectedDir: 'src/utils' });
    await useFileStore.getState().renamePath('ws-1', 'src', 'lib');
    expect(useFileStore.getState().selectedDir).toBe('lib/utils');
  });

  it('renamePath 重命名无关目录时不影响 selectedDir', async () => {
    useFileStore.setState({ selectedDir: 'src' });
    await useFileStore.getState().renamePath('ws-1', 'docs', 'documentation');
    expect(useFileStore.getState().selectedDir).toBe('src');
  });
});

describe('file.store refreshAllCached', () => {
  it('并行刷新所有已缓存目录', async () => {
    // 预置三个已缓存目录
    useFileStore.setState({
      tree: new Map([
        ['.', ROOT_ENTRIES],
        ['src', SUB_ENTRIES],
        ['docs', ROOT_ENTRIES],
      ]),
    });

    await useFileStore.getState().refreshAllCached('ws-1');

    // 每个缓存 key 都被 list 重新拉取
    expect(mockApi.file.list).toHaveBeenCalledTimes(3);
    expect(mockApi.file.list).toHaveBeenCalledWith('ws-1', '.');
    expect(mockApi.file.list).toHaveBeenCalledWith('ws-1', 'src');
    expect(mockApi.file.list).toHaveBeenCalledWith('ws-1', 'docs');
  });

  it('空缓存时不调任何 list', async () => {
    useFileStore.setState({ tree: new Map() });
    await useFileStore.getState().refreshAllCached('ws-1');
    expect(mockApi.file.list).not.toHaveBeenCalled();
  });
});
