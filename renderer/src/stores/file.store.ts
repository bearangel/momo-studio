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
  /** 当前选中目录（新建文件的落点）。'.' 表示根目录。不持久化 */
  selectedDir: string;
  error: string | null;
  // 当前激活的 workspace ID，用于按 workspace 隔离展开态持久化（null=未初始化）
  workspaceId: string | null;

  // 拉取指定目录的条目并写入缓存
  loadDir: (workspaceId: string, dirPath: string) => Promise<void>;
  // 切换激活 workspace：从专属 key 加载展开态；同一 workspace 重复调用不重载
  initWorkspace: (workspaceId: string) => void;
  // 切换目录展开/折叠状态
  toggleDir: (dirPath: string) => void;
  // 记录选中的文件
  selectFile: (filePath: string) => void;
  /** 设为当前选中目录（单击文件夹时调用） */
  selectDir: (dirPath: string) => void;
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
  /** 刷新所有已缓存目录（视图切换时同步外部变更） */
  refreshAllCached: (workspaceId: string) => Promise<void>;
}

// 按 workspace 隔离的展开态持久化 key
const expandedKey = (workspaceId: string): string => `fileTree.expanded.${workspaceId}`;

// 将展开态写入当前 workspace 的专属 key；无 workspace 或写入失败时静默
const persistExpanded = (workspaceId: string | null, expanded: Set<string>): void => {
  if (!workspaceId) return;
  try {
    localStorage.setItem(expandedKey(workspaceId), JSON.stringify([...expanded]));
  } catch {
    // localStorage 写入失败不影响内存中的展开状态
  }
};

export const useFileStore = create<FileState>((set, get) => ({
  tree: new Map(),
  expandedDirs: new Set<string>(['.']),
  selectedFile: null,
  selectedDir: '.',
  error: null,
  workspaceId: null,

  loadDir: async (workspaceId, dirPath) => {
    const entries = await ipc.file.list(workspaceId, dirPath);
    set((state) => {
      // 复制原 Map 以触发 React 重渲染（Map 引用变更）
      const tree = new Map(state.tree);
      tree.set(dirPath, entries);
      return { tree };
    });
  },

  initWorkspace: (workspaceId) => {
    // 同一 workspace 重复初始化直接跳过，避免覆盖内存中的展开态
    if (get().workspaceId === workspaceId) return;
    let expanded: Set<string>;
    try {
      const stored = localStorage.getItem(expandedKey(workspaceId));
      expanded = new Set(stored ? (JSON.parse(stored) as string[]) : ['.']);
    } catch {
      expanded = new Set(['.']);
    }
    // 切换 workspace 时重置选中目录为根（selectedDir 不跨 workspace 持久化）
    set({ workspaceId, expandedDirs: expanded, selectedDir: '.' });
  },

  toggleDir: (dirPath) => {
    set((state) => {
      const expanded = new Set(state.expandedDirs);
      if (expanded.has(dirPath)) {
        expanded.delete(dirPath);
      } else {
        expanded.add(dirPath);
      }
      persistExpanded(state.workspaceId, expanded);
      return { expandedDirs: expanded };
    });
  },

  selectFile: (filePath) => set({ selectedFile: filePath }),

  selectDir: (dirPath) => set({ selectedDir: dirPath }),

  collapseAll: () => {
    const expanded = new Set(['.']);
    persistExpanded(get().workspaceId, expanded);
    set({ expandedDirs: expanded });
  },

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
    set({ error: null });
    try {
      await ipc.file.create(workspaceId, filePath, type);
      // 取父目录路径：根目录下文件父目录为 '.'；否则截到最后一个 '/'
      const parent = filePath.includes('/') ? filePath.slice(0, filePath.lastIndexOf('/')) : '.';
      await get().refreshDir(workspaceId, parent);
    } catch (err) {
      set({ error: (err as Error).message });
      throw err;
    }
  },

  deletePath: async (workspaceId, filePath) => {
    set({ error: null });
    try {
      await ipc.file.delete(workspaceId, filePath);
      const parent = filePath.includes('/') ? filePath.slice(0, filePath.lastIndexOf('/')) : '.';
      await get().refreshDir(workspaceId, parent);
      // 维护 selectedDir 一致性：删除的路径是 selectedDir 本身或其祖先时重置为根
      const sel = get().selectedDir;
      if (sel === filePath || sel.startsWith(filePath + '/')) {
        set({ selectedDir: '.' });
      }
    } catch (err) {
      set({ error: (err as Error).message });
      throw err;
    }
  },

  renamePath: async (workspaceId, srcPath, dstPath) => {
    set({ error: null });
    try {
      await ipc.file.rename(workspaceId, srcPath, dstPath);
      const srcParent = srcPath.includes('/') ? srcPath.slice(0, srcPath.lastIndexOf('/')) : '.';
      const dstParent = dstPath.includes('/') ? dstPath.slice(0, dstPath.lastIndexOf('/')) : '.';
      await get().refreshDir(workspaceId, srcParent);
      if (srcParent !== dstParent) await get().refreshDir(workspaceId, dstParent);
      // 维护 selectedDir 一致性：重命名的是 selectedDir 本身或其祖先时同步更新
      const sel = get().selectedDir;
      if (sel === srcPath) {
        set({ selectedDir: dstPath });
      } else if (sel.startsWith(srcPath + '/')) {
        set({ selectedDir: dstPath + sel.slice(srcPath.length) });
      }
    } catch (err) {
      set({ error: (err as Error).message });
      throw err;
    }
  },

  /** 刷新所有已缓存目录（视图切换时同步外部变更） */
  refreshAllCached: async (workspaceId) => {
    const cachedDirs = [...get().tree.keys()];
    await Promise.all(cachedDirs.map((dir) => get().refreshDir(workspaceId, dir)));
  },
}));
