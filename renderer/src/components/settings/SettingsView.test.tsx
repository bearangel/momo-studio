// renderer/src/components/settings/SettingsView.test.tsx
//
// SettingsView 行为测试（P2 Task 4）：
// - 渲染 7 个分类菜单项（顺序：模型服务/默认模型/会话设置/Git 策略/审计日志/节点互联/关于）
// - 已删除 account 分类
// - 顶部「← 返回」按钮点击后 setActiveView('im')
// - 全局 Esc 键返回 im 视图（仅 settings 视图挂载时生效）
// - 切换菜单项渲染对应面板
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SettingsView } from './SettingsView';
import { useSettingsStore } from '../../stores/settings.store';
import { useUiStore } from '../../stores/ui.store';
import { useWorkspaceStore } from '../../stores/workspace.store';
import type { Workspace } from '../../ipc/types';

const STUB_WORKSPACE: Workspace = {
  id: 'ws-test',
  name: 'Test',
  description: '',
  directoryPath: '/tmp/test',
  teamSessionId: 'sess-team',
  gitInitialized: false,
  createdAt: '2026-01-01T00:00:00Z',
  ownerId: 'owner',
  iconEmoji: '📁',
  coordinatorInstanceId: null,
};

// 桩 ipc：渲染分支时各组件会触发挂载副作用；本测试不验证副作用内容
const mockApi = {
  provider: {
    list: vi.fn().mockResolvedValue([]),
  },
  settings: {
    getGlobal: vi.fn().mockResolvedValue({ maxToolCalls: 10 }),
  },
  audit: {
    list: vi.fn().mockResolvedValue([]),
  },
  gitPolicy: {
    get: vi.fn().mockResolvedValue({}),
  },
  p2p: {
    getDiscoveredNodes: vi.fn().mockResolvedValue([]),
    addTrustedNode: vi.fn().mockResolvedValue(undefined),
    removeTrustedNode: vi.fn().mockResolvedValue(undefined),
  },
  agent: {
    listAssignments: vi.fn().mockResolvedValue([]),
  },
};

describe('SettingsView', () => {
  beforeEach(() => {
    (globalThis as unknown as { window: { api: typeof mockApi } }).window.api = mockApi;
    useUiStore.setState({ activeView: 'settings' });
    useSettingsStore.setState({ activeCategory: 'model_provider' });
    useWorkspaceStore.setState({
      workspaces: [STUB_WORKSPACE],
      activeWorkspaceId: STUB_WORKSPACE.id,
      loading: false,
      error: null,
    });
    vi.clearAllMocks();
  });

  it('渲染 7 个分类菜单项且顺序符合原型', () => {
    render(<SettingsView />);
    // 限定在 <nav aria-label="设置分类"> 内查找分类按钮，避免右侧内容区按钮干扰
    const nav = screen.getByRole('navigation', { name: '设置分类' });
    const navButtons = Array.from(nav.querySelectorAll('button'));
    expect(navButtons.length).toBe(7);
    const labels = navButtons.map((b) => b.textContent ?? '');
    expect(labels).toEqual([
      '🏢模型服务',
      '🎯默认模型',
      '💬会话设置',
      '🌿Git 策略',
      '📜审计日志',
      '🌐节点互联',
      'ℹ️关于',
    ]);
  });

  it('account 分类不存在', () => {
    render(<SettingsView />);
    expect(screen.queryByText('账户')).not.toBeInTheDocument();
  });

  it('点击「← 返回」按钮切换到 im 视图', () => {
    render(<SettingsView />);
    fireEvent.click(screen.getByRole('button', { name: /返回/ }));
    expect(useUiStore.getState().activeView).toBe('im');
  });

  it('按 Esc 键返回 im 视图', () => {
    render(<SettingsView />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(useUiStore.getState().activeView).toBe('im');
  });

  it('非 Esc 键不触发返回', () => {
    render(<SettingsView />);
    fireEvent.keyDown(window, { key: 'Enter' });
    fireEvent.keyDown(window, { key: 'a' });
    expect(useUiStore.getState().activeView).toBe('settings');
  });

  it('点击「默认模型」分类切换 activeCategory 并渲染占位', () => {
    render(<SettingsView />);
    fireEvent.click(screen.getByRole('button', { name: /默认模型/ }));
    expect(useSettingsStore.getState().activeCategory).toBe('default_model');
    expect(screen.getByText('默认模型设置——T7 实现')).toBeInTheDocument();
  });

  it('点击「关于」分类切换 activeCategory 并渲染占位', () => {
    render(<SettingsView />);
    fireEvent.click(screen.getByRole('button', { name: /关于/ }));
    expect(useSettingsStore.getState().activeCategory).toBe('about');
    // 「关于」同时出现在菜单按钮与面板标题，用占位文案断言面板已挂载
    expect(screen.getByText('关于——T7 实现')).toBeInTheDocument();
  });

  it('SettingsNav 宽度 190px', () => {
    render(<SettingsView />);
    const nav = screen.getByRole('navigation');
    expect(nav.style.width).toBe('190px');
  });

  it('顶部标题显示「设置」', () => {
    render(<SettingsView />);
    expect(screen.getByRole('heading', { name: '设置' })).toBeInTheDocument();
  });
});