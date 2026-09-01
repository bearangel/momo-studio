// renderer/src/components/settings/AppearanceSettings.test.tsx
import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AppearanceSettings } from './AppearanceSettings';
import { useThemeStore } from '../../stores/theme.store';

describe('AppearanceSettings', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.classList.remove('dark');
    useThemeStore.setState({ mode: 'system', resolved: 'light' });
  });

  it('渲染主题模式分段控件（浅色/深色/跟随系统）', () => {
    render(<AppearanceSettings />);
    expect(screen.getByRole('radiogroup', { name: '主题模式' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: '跟随系统' })).toBeInTheDocument();
  });

  it('切换到深色：html 加 .dark 且持久化', () => {
    render(<AppearanceSettings />);
    fireEvent.click(screen.getByRole('radio', { name: '深色' }));
    expect(useThemeStore.getState().mode).toBe('dark');
    expect(localStorage.getItem('momo.theme')).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('切回浅色：html 移除 .dark', () => {
    render(<AppearanceSettings />);
    fireEvent.click(screen.getByRole('radio', { name: '深色' }));
    fireEvent.click(screen.getByRole('radio', { name: '浅色' }));
    expect(document.documentElement.classList.contains('dark')).toBe(false);
    expect(localStorage.getItem('momo.theme')).toBe('light');
  });
});
