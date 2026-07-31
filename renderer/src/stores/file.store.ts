// renderer/src/stores/file.store.ts
// 文件树状态管理：按目录路径缓存 DirEntry 列表、记录展开/折叠的目录、当前选中文件
import { create } from 'zustand';
import { ipc } from '../ipc/client';
import type { DirEntry } from '../ipc/types';

interface FileState {
  // 按目录路径缓存其直接子条目，避免重复 IPC 调用
  tree: Map<string, DirEntry[]>;
  // 已展开的目录路径集合（根目录默认展开）
  expandedDirs: Set<string>;
  // 当前选中的文件全路径（相对 workspace 根）
  selectedFile: string | null;

  // 拉取指定目录的条目并写入缓存
  loadDir: (workspaceId: string, dirPath: string) => Promise<void>;
  // 切换目录展开/折叠状态
  toggleDir: (dirPath: string) => void;
  // 记录选中的文件
  selectFile: (filePath: string) => void;
  // 折叠全部目录，回到仅根目录展开的初始状态
  collapseAll: () => void;
  // 失效指定目录缓存并重新拉取（刷新）
  refreshDir: (workspaceId: string, dirPath: string) => Promise<void>;
  // 新建文件或目录，完成后刷新其父目录缓存
  createPath: (workspaceId: string, filePath: string, type: 'file' | 'dir') => Promise<void>;
  // 删除文件或目录，完成后刷新其父目录缓存
  deletePath: (workspaceId: string, filePath: string) => Promise<void>;
  // 重命名/移动，完成后刷新源与目标父目录缓存
  renamePath: (workspaceId: string, srcPath: string, dstPath: string) => Promise<void>;
}

export const useFileStore = create<FileState>((set, get) => ({
  tree: new Map(),
  expandedDirs: new Set(['.']),
  selectedFile: null,

  loadDir: async (workspaceId, dirPath) => {
    const entries = await ipc.file.list(workspaceId, dirPath);
    set((state) => {
      // 复制原 Map 以触发 React 重渲染（Map 引用变更）
      const tree = new Map(state.tree);
      tree.set(dirPath, entries);
      return { tree };
    });
  },

  toggleDir: (dirPath) => {
    set((state) => {
      const expanded = new Set(state.expandedDirs);
      if (expanded.has(dirPath)) {
        expanded.delete(dirPath);
      } else {
        expanded.add(dirPath);
      }
      return { expandedDirs: expanded };
    });
  },

  selectFile: (filePath) => set({ selectedFile: filePath }),

  collapseAll: () => set({ expandedDirs: new Set(['.']) }),

  refreshDir: async (workspaceId, dirPath) => {
    // 先失效缓存再重新加载，确保触发 UI 重渲染
    set((state) => {
      const tree = new Map(state.tree);
      tree.delete(dirPath);
      return { tree };
    });
    const entries = await ipc.file.list(workspaceId, dirPath);
    set((state) => {
      const tree = new Map(state.tree);
      tree.set(dirPath, entries);
      return { tree };
    });
  },

  createPath: async (workspaceId, filePath, type) => {
    await ipc.file.create(workspaceId, filePath, type);
    // 取父目录路径：根目录下文件父目录为 '.'；否则截到最后一个 '/'
    const parent = filePath.includes('/') ? filePath.slice(0, filePath.lastIndexOf('/')) : '.';
    await get().refreshDir(workspaceId, parent);
  },

  deletePath: async (workspaceId, filePath) => {
    await ipc.file.delete(workspaceId, filePath);
    const parent = filePath.includes('/') ? filePath.slice(0, filePath.lastIndexOf('/')) : '.';
    await get().refreshDir(workspaceId, parent);
  },

  renamePath: async (workspaceId, srcPath, dstPath) => {
    await ipc.file.rename(workspaceId, srcPath, dstPath);
    const srcParent = srcPath.includes('/') ? srcPath.slice(0, srcPath.lastIndexOf('/')) : '.';
    const dstParent = dstPath.includes('/') ? dstPath.slice(0, dstPath.lastIndexOf('/')) : '.';
    await get().refreshDir(workspaceId, srcParent);
    if (srcParent !== dstParent) await get().refreshDir(workspaceId, dstParent);
  },
}));
