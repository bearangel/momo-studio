// renderer/src/stores/browser-visibility.store.test.ts
//
// 浏览器侧栏 per-session 可见性 store 单测（归属制 spec 2026-09-15 §9.1）：
//   - 缺省不可见（新会话默认收起）
//   - setVisible 按会话独立记忆
//   - purgeStale 清理已删除会话的条目
import { describe, it, expect, beforeEach } from 'vitest';
import { useBrowserVisibilityStore } from './browser-visibility.store';

describe('browser-visibility store（per-session 可见性，spec §9.1）', () => {
  beforeEach(() => {
    useBrowserVisibilityStore.setState({ visibilityBySession: {} });
  });
  it('缺省不可见（新会话默认收起）', () => {
    expect(useBrowserVisibilityStore.getState().isVisible('s1')).toBe(false);
    expect(useBrowserVisibilityStore.getState().isVisible(null)).toBe(false);
  });
  it('setVisible 按会话独立记忆', () => {
    useBrowserVisibilityStore.getState().setVisible('s1', true);
    expect(useBrowserVisibilityStore.getState().isVisible('s1')).toBe(true);
    expect(useBrowserVisibilityStore.getState().isVisible('s2')).toBe(false);
  });
  it('purgeStale 清理已删除会话的条目', () => {
    useBrowserVisibilityStore.getState().setVisible('s1', true);
    useBrowserVisibilityStore.getState().setVisible('s2', true);
    useBrowserVisibilityStore.getState().purgeStale(['s2']);
    expect(useBrowserVisibilityStore.getState().isVisible('s1')).toBe(false);
    expect(useBrowserVisibilityStore.getState().isVisible('s2')).toBe(true);
  });
});
