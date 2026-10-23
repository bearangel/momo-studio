// renderer/src/stores/editor.store.ts
// 编辑器多 tab 状态管理：打开/关闭 tab、内容更新、保存标记、激活切换。
// 工作空间分片（2026-10-23 隔离修复）：tabs/activeTab 按 workspaceId 隔离存储，
// 顶层 tabs/activeTab 镜像「当前分片」——既有消费者（CodeEditor/FileTreeView/
// ViewSidebar/MessageBubble）读顶层字段的代码零改动。绑定由 App 顶层 effect
// 调 setWorkspace（任何 openFile 前完成，真实时序见 editor.store.test.ts）。
import { create } from 'zustand';

export interface EditorTab {
  filePath: string;
  content: string;
  dirty: boolean;
}

/** 单个 workspace 的编辑器状态分片 */
interface WorkspaceSlice {
  tabs: EditorTab[];
  activeTab: string | null;
  /** 二进制占位（VS Code 式）：当前被点击的二进制文件相对路径；瞬态——
   *  打开任一文本文件 / 激活任一 tab / 切换工作空间即清空 */
  pendingBinary: string | null;
}

const EMPTY_SLICE: WorkspaceSlice = { tabs: [], activeTab: null, pendingBinary: null };

interface EditorState {
  /** 当前分片镜像（消费者直接读，勿单独写） */
  tabs: EditorTab[];
  activeTab: string | null;
  /** 当前分片镜像：二进制占位路径（null = 无占位） */
  pendingBinary: string | null;
  byWorkspace: Record<string, WorkspaceSlice>;
  currentWorkspaceId: string | null;

  /** 切换当前分片（App 顶层 effect 随 activeWorkspaceId 调用；null = 无工作空间） */
  setWorkspace: (workspaceId: string | null) => void;
  /** 二进制文件被点击：当前分片写入占位路径（编辑区渲染占位卡，不建 tab） */
  showBinaryNotice: (filePath: string) => void;
  // 打开文件（已存在则仅激活，否则新建 tab 并激活）；workspaceId 缺省 = 当前
  // 空间，显式传入用于跨空间打开（消息 chip 的 workspaceId 取自消息本身）
  openFile: (filePath: string, content: string, workspaceId?: string) => void;
  // 关闭 tab，关闭的是激活 tab 时回退到最后一个
  closeTab: (filePath: string) => void;
  // 更新某 tab 内容并标记为 dirty
  updateContent: (filePath: string, content: string) => void;
  // 标记某 tab 已保存（dirty 置 false）
  markSaved: (filePath: string) => void;
  // 切换激活 tab
  setActive: (filePath: string) => void;
  // 文件被删除时关闭对应 tab（active 关了则回退到最后一个）
  closeTabIfPath: (filePath: string) => void;
  // 文件被重命名/移动时更新对应 tab 的 filePath（保持 content/dirty）
  renameTab: (oldPath: string, newPath: string) => void;
}

/** 写入指定分片；该分片为当前分片时同步镜像顶层字段 */
function writeSlice(
  state: EditorState,
  workspaceId: string,
  slice: WorkspaceSlice,
): Partial<EditorState> {
  const mirrorsCurrent = workspaceId === state.currentWorkspaceId;
  return {
    byWorkspace: { ...state.byWorkspace, [workspaceId]: slice },
    ...(mirrorsCurrent
      ? {
          tabs: slice.tabs,
          activeTab: slice.activeTab,
          pendingBinary: slice.pendingBinary,
        }
      : {}),
  };
}

export const useEditorStore = create<EditorState>((set, get) => ({
  tabs: [],
  activeTab: null,
  pendingBinary: null,
  byWorkspace: {},
  currentWorkspaceId: null,

  setWorkspace: (workspaceId) => {
    const state = get();
    if (workspaceId === state.currentWorkspaceId) return;
    const slice =
      workspaceId === null ? EMPTY_SLICE : (state.byWorkspace[workspaceId] ?? EMPTY_SLICE);
    set({
      currentWorkspaceId: workspaceId,
      tabs: slice.tabs,
      activeTab: slice.activeTab,
      pendingBinary: slice.pendingBinary,
    });
  },

  showBinaryNotice: (filePath) => {
    const state = get();
    const wsId = state.currentWorkspaceId;
    if (wsId === null) return;
    const slice = state.byWorkspace[wsId] ?? EMPTY_SLICE;
    if (slice.pendingBinary === filePath) return;
    set(writeSlice(state, wsId, { ...slice, pendingBinary: filePath }));
  },

  openFile: (filePath, content, workspaceId) => {
    const state = get();
    const target = workspaceId ?? state.currentWorkspaceId;
    if (target === null) return;
    const slice = state.byWorkspace[target] ?? EMPTY_SLICE;
    // 打开文本文件即清二进制占位（占位是「未打开任何替代内容」时的编辑区主体）
    const cleared = slice.pendingBinary === null ? slice : { ...slice, pendingBinary: null };
    if (cleared.tabs.some((t) => t.filePath === filePath)) {
      set(writeSlice(state, target, { ...cleared, activeTab: filePath }));
      return;
    }
    set(
      writeSlice(state, target, {
        ...cleared,
        tabs: [...cleared.tabs, { filePath, content, dirty: false }],
        activeTab: filePath,
      }),
    );
  },

  closeTab: (filePath) => {
    const state = get();
    const wsId = state.currentWorkspaceId;
    if (wsId === null) return;
    const slice = state.byWorkspace[wsId] ?? EMPTY_SLICE;
    const tabs = slice.tabs.filter((t) => t.filePath !== filePath);
    if (tabs.length === slice.tabs.length) return;
    // 关闭的是激活 tab 时回退到最后一个，否则保持不变
    const activeTab =
      slice.activeTab === filePath
        ? tabs.length > 0
          ? tabs[tabs.length - 1]!.filePath
          : null
        : slice.activeTab;
    set(writeSlice(state, wsId, { ...slice, tabs, activeTab }));
  },

  updateContent: (filePath, content) => {
    const state = get();
    const wsId = state.currentWorkspaceId;
    if (wsId === null) return;
    const slice = state.byWorkspace[wsId] ?? EMPTY_SLICE;
    const tabs = slice.tabs.map((t) =>
      t.filePath === filePath ? { ...t, content, dirty: true } : t,
    );
    set(writeSlice(state, wsId, { ...slice, tabs }));
  },

  markSaved: (filePath) => {
    const state = get();
    const wsId = state.currentWorkspaceId;
    if (wsId === null) return;
    const slice = state.byWorkspace[wsId] ?? EMPTY_SLICE;
    const tabs = slice.tabs.map((t) => (t.filePath === filePath ? { ...t, dirty: false } : t));
    set(writeSlice(state, wsId, { ...slice, tabs }));
  },

  setActive: (filePath) => {
    const state = get();
    const wsId = state.currentWorkspaceId;
    if (wsId === null) return;
    const slice = state.byWorkspace[wsId] ?? EMPTY_SLICE;
    if (slice.activeTab === filePath && slice.pendingBinary === null) return;
    // 激活任一 tab 即清二进制占位（预览定值：点 tab 返回编辑器）
    set(writeSlice(state, wsId, { ...slice, activeTab: filePath, pendingBinary: null }));
  },

  closeTabIfPath: (filePath) => {
    const state = get();
    const wsId = state.currentWorkspaceId;
    if (wsId === null) return;
    const slice = state.byWorkspace[wsId] ?? EMPTY_SLICE;
    if (!slice.tabs.some((t) => t.filePath === filePath)) return;
    get().closeTab(filePath);
  },

  renameTab: (oldPath, newPath) => {
    const state = get();
    const wsId = state.currentWorkspaceId;
    if (wsId === null) return;
    const slice = state.byWorkspace[wsId] ?? EMPTY_SLICE;
    const tabs = slice.tabs.map((t) => (t.filePath === oldPath ? { ...t, filePath: newPath } : t));
    const activeTab = slice.activeTab === oldPath ? newPath : slice.activeTab;
    set(writeSlice(state, wsId, { ...slice, tabs, activeTab }));
  },
}));
