// renderer/src/components/layout/ActivityBar.test.tsx
//
// 活动栏测试（P2 Task 3）：
// - 渲染 5 个主项（会话/文件/看板/Agent/资源库）+ 底部设置项
// - 点击切换 activeView；激活项带 aria-current 与左侧 3px 蓝色指示条
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ActivityBar } from './ActivityBar';
import { useUiStore } from '../../stores/ui.store';

describe('ActivityBar', () => {
  beforeEach(() => {
    useUiStore.setState({ activeView: 'im', sidebarCollapsed: false });
  });

  it('渲染 5 个主项 + 底部设置项', () => {
    render(<ActivityBar />);
    expect(screen.getByLabelText('会话')).toBeInTheDocument();
    expect(screen.getByLabelText('文件')).toBeInTheDocument();
    expect(screen.getByLabelText('看板')).toBeInTheDocument();
    expect(screen.getByLabelText('Agent')).toBeInTheDocument();
    expect(screen.getByLabelText('资源库')).toBeInTheDocument();
    expect(screen.getByLabelText('设置')).toBeInTheDocument();
  });

  it('点击活动项切换 activeView', () => {
    render(<ActivityBar />);
    fireEvent.click(screen.getByLabelText('看板'));
    expect(useUiStore.getState().activeView).toBe('tasks');
    fireEvent.click(screen.getByLabelText('设置'));
    expect(useUiStore.getState().activeView).toBe('settings');
  });

  it('激活项带 aria-current 与左侧指示条，未激活项无指示条', () => {
    render(<ActivityBar />);
    const imBtn = screen.getByLabelText('会话');
    expect(imBtn).toHaveAttribute('aria-current', 'page');
    // 激活指示条在按钮内部
    expect(imBtn.querySelector('[data-testid="activity-indicator"]')).not.toBeNull();
    // 指示条宽度 3px（原型：左侧 3px 蓝条）
    const indicator = imBtn.querySelector(
      '[data-testid="activity-indicator"]',
    ) as HTMLElement;
    expect(indicator.style.width).toBe('3px');

    const filesBtn = screen.getByLabelText('文件');
    expect(filesBtn).not.toHaveAttribute('aria-current');
    expect(filesBtn.querySelector('[data-testid="activity-indicator"]')).toBeNull();
  });

  it('切换视图后指示条跟随新激活项', () => {
    render(<ActivityBar />);
    fireEvent.click(screen.getByLabelText('文件'));
    expect(
      screen.getByLabelText('文件').querySelector('[data-testid="activity-indicator"]'),
    ).not.toBeNull();
    expect(
      screen.getByLabelText('会话').querySelector('[data-testid="activity-indicator"]'),
    ).toBeNull();
  });

  it('收起时点击当前侧边栏视图图标 → 恢复侧边栏（视图不变）', () => {
    useUiStore.setState({ activeView: 'im', sidebarCollapsed: true });
    render(<ActivityBar />);
    fireEvent.click(screen.getByLabelText('会话'));
    expect(useUiStore.getState().sidebarCollapsed).toBe(false);
    expect(useUiStore.getState().activeView).toBe('im');
  });

  it('收起时点击其它侧边栏视图 → 正常切换视图，保持收起', () => {
    useUiStore.setState({ activeView: 'im', sidebarCollapsed: true });
    render(<ActivityBar />);
    fireEvent.click(screen.getByLabelText('文件'));
    expect(useUiStore.getState().activeView).toBe('files');
    expect(useUiStore.getState().sidebarCollapsed).toBe(true);
  });

  it('未收起时点击当前视图 → no-op（不切换不恢复）', () => {
    useUiStore.setState({ activeView: 'im', sidebarCollapsed: false });
    render(<ActivityBar />);
    fireEvent.click(screen.getByLabelText('会话'));
    expect(useUiStore.getState().activeView).toBe('im');
    expect(useUiStore.getState().sidebarCollapsed).toBe(false);
  });
});
