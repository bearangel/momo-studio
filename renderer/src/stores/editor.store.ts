// renderer/src/stores/editor.store.ts
// 编辑器多 tab 状态管理：打开/关闭 tab、内容更新、保存标记、激活切换
import { create } from 'zustand';

export interface EditorTab {
  filePath: string;
  content: string;
  dirty: boolean;
}

interface EditorState {
  tabs: EditorTab[];
  activeTab: string | null;

  // 打开文件（已存在则仅激活，否则新建 tab 并激活）
  openFile: (filePath: string, content: string) => void;
  // 关闭 tab，关闭的是激活 tab 时回退到最后一个
  closeTab: (filePath: string) => void;
  // 更新某 tab 内容并标记为 dirty
  updateContent: (filePath: string, content: string) => void;
  // 标记某 tab 已保存（dirty 置 false）
  markSaved: (filePath: string) => void;
  // 切换激活 tab
  setActive: (filePath: string) => void;
}

export const useEditorStore = create<EditorState>((set, get) => ({
  tabs: [],
  activeTab: null,

  openFile: (filePath, content) => {
    const existing = get().tabs.find((t) => t.filePath === filePath);
    if (existing) {
      set({ activeTab: filePath });
      return;
    }
    set((state) => ({
      tabs: [...state.tabs, { filePath, content, dirty: false }],
      activeTab: filePath,
    }));
  },

  closeTab: (filePath) => {
    set((state) => {
      const tabs = state.tabs.filter((t) => t.filePath !== filePath);
      // 关闭的是激活 tab 时回退到最后一个，否则保持不变
      const activeTab =
        state.activeTab === filePath
          ? tabs.length > 0
            ? tabs[tabs.length - 1]!.filePath
            : null
          : state.activeTab;
      return { tabs, activeTab };
    });
  },

  updateContent: (filePath, content) => {
    set((state) => ({
      tabs: state.tabs.map((t) =>
        t.filePath === filePath ? { ...t, content, dirty: true } : t,
      ),
    }));
  },

  markSaved: (filePath) => {
    set((state) => ({
      tabs: state.tabs.map((t) =>
        t.filePath === filePath ? { ...t, dirty: false } : t,
      ),
    }));
  },

  setActive: (filePath) => set({ activeTab: filePath }),
}));
