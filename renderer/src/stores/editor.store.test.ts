// renderer/src/stores/editor.store.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { useEditorStore } from './editor.store';

beforeEach(() => {
  // 重置 store 状态，保证测试间隔离（分片化后须清 byWorkspace + 绑定，
  // 仿真 App 顶层 effect 在任何 openFile 前完成 setWorkspace 的真实时序）
  useEditorStore.setState({
    tabs: [],
    activeTab: null,
    pendingBinary: null,
    byWorkspace: {},
    currentWorkspaceId: 'ws-test',
  });
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

  describe('workspace 隔离（分片契约）', () => {
    it('切换工作空间后旧空间 tab 不可见，新空间独立', () => {
      const { openFile, setWorkspace } = useEditorStore.getState();
      setWorkspace('ws-a');
      openFile('a1.ts', '内容1');
      openFile('a2.ts', '内容2');
      setWorkspace('ws-b');
      expect(useEditorStore.getState().tabs).toEqual([]);
      expect(useEditorStore.getState().activeTab).toBeNull();
      openFile('b1.ts', 'b内容');
      expect(useEditorStore.getState().tabs.map((t) => t.filePath)).toEqual(['b1.ts']);
    });

    it('切回原工作空间恢复 tabs 与 activeTab，dirty 状态保留', () => {
      const { openFile, updateContent, setWorkspace } = useEditorStore.getState();
      setWorkspace('ws-a');
      openFile('a1.ts', '原内容');
      updateContent('a1.ts', '未保存的改动');
      setWorkspace('ws-b');
      openFile('b1.ts', 'b');
      setWorkspace('ws-a');
      const state = useEditorStore.getState();
      expect(state.tabs).toEqual([{ filePath: 'a1.ts', content: '未保存的改动', dirty: true }]);
      expect(state.activeTab).toBe('a1.ts');
    });

    it('两个工作空间同相对路径互不干扰', () => {
      const { openFile, updateContent, setWorkspace } = useEditorStore.getState();
      setWorkspace('ws-a');
      openFile('src/a.ts', 'A 空间内容');
      setWorkspace('ws-b');
      openFile('src/a.ts', 'B 空间内容');
      updateContent('src/a.ts', 'B 空间改动');
      setWorkspace('ws-a');
      expect(useEditorStore.getState().tabs[0]!.content).toBe('A 空间内容');
      expect(useEditorStore.getState().tabs[0]!.dirty).toBe(false);
    });

    it('closeTabIfPath 与 renameTab 只作用于当前分片', () => {
      const { openFile, closeTabIfPath, renameTab, setWorkspace } = useEditorStore.getState();
      setWorkspace('ws-a');
      openFile('shared.ts', 'a');
      setWorkspace('ws-b');
      openFile('shared.ts', 'b');
      closeTabIfPath('shared.ts');
      renameTab('shared.ts', 'renamed.ts');
      setWorkspace('ws-a');
      const state = useEditorStore.getState();
      expect(state.tabs.map((t) => t.filePath)).toEqual(['shared.ts']);
      expect(state.tabs[0]!.content).toBe('a');
    });

    it('setWorkspace(null) 清空镜像，切回原空间恢复', () => {
      const { openFile, setWorkspace } = useEditorStore.getState();
      setWorkspace('ws-a');
      openFile('a1.ts', 'x');
      setWorkspace(null);
      expect(useEditorStore.getState().tabs).toEqual([]);
      expect(useEditorStore.getState().activeTab).toBeNull();
      setWorkspace('ws-a');
      expect(useEditorStore.getState().tabs.map((t) => t.filePath)).toEqual(['a1.ts']);
    });

    it('openFile 指定 workspaceId 时落入该空间分片（消息 chip 跨空间场景）', () => {
      const { openFile, setWorkspace } = useEditorStore.getState();
      setWorkspace('ws-a');
      // 消息属于 ws-b：tab 应落 ws-b 分片，不污染当前 ws-a 镜像
      openFile('report.md', '内容', 'ws-b');
      expect(useEditorStore.getState().tabs).toEqual([]);
      setWorkspace('ws-b');
      expect(useEditorStore.getState().tabs.map((t) => t.filePath)).toEqual(['report.md']);
      expect(useEditorStore.getState().activeTab).toBe('report.md');
    });

    it('未绑定工作空间时 openFile 无副作用（防御锁）', () => {
      useEditorStore.setState({ currentWorkspaceId: null, tabs: [], activeTab: null });
      useEditorStore.getState().openFile('a.ts', '');
      expect(useEditorStore.getState().tabs).toEqual([]);
    });
  });

  describe('pendingBinary 二进制占位（④ VS Code 式）', () => {
    it('showBinaryNotice 写入镜像，不建 tab', () => {
      const { showBinaryNotice } = useEditorStore.getState();
      showBinaryNotice('assets/hero.png');
      const state = useEditorStore.getState();
      expect(state.pendingBinary).toBe('assets/hero.png');
      expect(state.tabs).toEqual([]);
    });

    it('打开任一文本文件即清占位', () => {
      const { showBinaryNotice, openFile } = useEditorStore.getState();
      showBinaryNotice('assets/hero.png');
      openFile('a.ts', '');
      expect(useEditorStore.getState().pendingBinary).toBeNull();
    });

    it('激活任一 tab 即清占位（点 tab 返回编辑器）', () => {
      const { openFile, setActive, showBinaryNotice } = useEditorStore.getState();
      openFile('a.ts', '');
      showBinaryNotice('assets/hero.png');
      setActive('a.ts');
      expect(useEditorStore.getState().pendingBinary).toBeNull();
    });

    it('占位按工作空间隔离：切走不泄漏，切回恢复', () => {
      const { showBinaryNotice, openFile, setWorkspace } = useEditorStore.getState();
      setWorkspace('ws-a');
      showBinaryNotice('a.png');
      setWorkspace('ws-b');
      expect(useEditorStore.getState().pendingBinary).toBeNull();
      openFile('b.ts', '');
      setWorkspace('ws-a');
      expect(useEditorStore.getState().pendingBinary).toBe('a.png');
    });

    it('未绑定工作空间时 showBinaryNotice 无副作用（防御锁）', () => {
      useEditorStore.setState({ currentWorkspaceId: null, pendingBinary: null });
      useEditorStore.getState().showBinaryNotice('a.png');
      expect(useEditorStore.getState().pendingBinary).toBeNull();
    });
  });
});
