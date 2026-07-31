// renderer/src/stores/editor.store.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { useEditorStore } from './editor.store';

beforeEach(() => {
  // 重置 store 状态，保证测试间隔离
  useEditorStore.setState({ tabs: [], activeTab: null });
});

describe('editor.store', () => {
  describe('closeTabIfPath', () => {
    it('删除激活 tab 时回退到最后一个 tab', () => {
      const { openFile, closeTabIfPath } = useEditorStore.getState();
      openFile('a.ts', '');
      openFile('b.ts', '');
      openFile('c.ts', '');
      // active 现为 c.ts，关闭它后应回退到 b.ts
      closeTabIfPath('c.ts');
      const state = useEditorStore.getState();
      expect(state.tabs.map((t) => t.filePath)).toEqual(['a.ts', 'b.ts']);
      expect(state.activeTab).toBe('b.ts');
    });

    it('删除非激活 tab 时保持 active 不变', () => {
      const { openFile, setActive, closeTabIfPath } = useEditorStore.getState();
      openFile('a.ts', '');
      openFile('b.ts', '');
      setActive('a.ts');
      closeTabIfPath('b.ts');
      const state = useEditorStore.getState();
      expect(state.tabs.map((t) => t.filePath)).toEqual(['a.ts']);
      expect(state.activeTab).toBe('a.ts');
    });

    it('路径不匹配任何 tab 时无副作用', () => {
      const { openFile, closeTabIfPath } = useEditorStore.getState();
      openFile('a.ts', '');
      const before = useEditorStore.getState();
      closeTabIfPath('不存在.ts');
      const after = useEditorStore.getState();
      expect(after.tabs).toBe(before.tabs);
      expect(after.activeTab).toBe(before.activeTab);
    });

    it('删除最后一个 tab 时 active 置 null', () => {
      const { openFile, closeTabIfPath } = useEditorStore.getState();
      openFile('only.ts', '');
      closeTabIfPath('only.ts');
      const state = useEditorStore.getState();
      expect(state.tabs).toEqual([]);
      expect(state.activeTab).toBeNull();
    });
  });

  describe('renameTab', () => {
    it('更新匹配 tab 的 filePath 并保持 content/dirty', () => {
      const { openFile, updateContent, renameTab } = useEditorStore.getState();
      openFile('old.ts', '内容');
      updateContent('old.ts', '改动后');
      renameTab('old.ts', 'new.ts');
      const tab = useEditorStore.getState().tabs[0]!;
      expect(tab.filePath).toBe('new.ts');
      expect(tab.content).toBe('改动后');
      expect(tab.dirty).toBe(true);
    });

    it('重命名的是激活 tab 时 active 同步更新', () => {
      const { openFile, renameTab } = useEditorStore.getState();
      openFile('old.ts', '');
      renameTab('old.ts', 'new.ts');
      expect(useEditorStore.getState().activeTab).toBe('new.ts');
    });

    it('重命名非激活 tab 时 active 不变', () => {
      const { openFile, setActive, renameTab } = useEditorStore.getState();
      openFile('a.ts', '');
      openFile('b.ts', '');
      setActive('a.ts');
      renameTab('b.ts', 'b2.ts');
      expect(useEditorStore.getState().activeTab).toBe('a.ts');
    });
  });
});
