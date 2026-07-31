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
}

export const useFileStore = create<FileState>((set) => ({
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
}));
