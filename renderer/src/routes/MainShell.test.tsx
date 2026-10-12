// renderer/src/routes/MainShell.test.tsx
//
// D1b 挂载点锁：ProviderMissingBanner 挂在 TitleBar 与 MainLayout 之间；
// 显隐跟随供应商状态。TitleBar / MainLayout / ConflictDialogMount 用轻量桩——
// 本文件聚焦挂载位置，子组件行为由各自测试覆盖（ViewSidebar.test 同模式）。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MainShell } from './MainShell';
import { useProviderStore } from '../stores/provider.store';
import type { ModelProvider } from '../ipc/types';

vi.mock('../components/layout/TitleBar', () => ({
  TitleBar: () => <div data-testid="titlebar-stub" />,
}));
vi.mock('../components/layout/MainLayout', () => ({
  MainLayout: () => <div data-testid="mainlayout-stub" />,
}));
vi.mock('../components/im/ConflictDialogMount', () => ({
  ConflictDialogMount: () => <div data-testid="conflict-stub" />,
}));

const providerList = vi.fn();

const PROVIDER: ModelProvider = {
  id: 'p1', name: '智谱 GLM', baseUrl: 'https://a', defaultModel: null,
  isDefault: false, createdAt: '', platform: 'openai', presetKey: null,
};

beforeEach(() => {
  providerList.mockReset().mockResolvedValue([]);
  (globalThis as unknown as { window: { api: unknown } }).window.api = {
    provider: { list: providerList },
  };
  useProviderStore.setState({ providers: [], loading: false });
});

describe('MainShell — ProviderMissingBanner 挂载（D1b）', () => {
  it('无供应商 → 横幅位于 TitleBar 与 MainLayout 之间', async () => {
    render(<MainShell />);
    const banner = await screen.findByTestId('provider-missing-banner');
    expect(banner.previousElementSibling).toBe(screen.getByTestId('titlebar-stub'));
    expect(banner.nextElementSibling).toBe(screen.getByTestId('mainlayout-stub'));
  });

  it('有供应商 → 横幅不渲染，其余结构完整', async () => {
    providerList.mockResolvedValue([PROVIDER]);
    render(<MainShell />);
    await waitFor(() => expect(useProviderStore.getState().providers).toHaveLength(1));
    expect(screen.queryByTestId('provider-missing-banner')).not.toBeInTheDocument();
    expect(screen.getByTestId('titlebar-stub')).toBeInTheDocument();
    expect(screen.getByTestId('mainlayout-stub')).toBeInTheDocument();
    expect(screen.getByTestId('conflict-stub')).toBeInTheDocument();
  });
});
