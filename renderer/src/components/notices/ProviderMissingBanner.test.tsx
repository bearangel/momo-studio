// renderer/src/components/notices/ProviderMissingBanner.test.tsx
//
// D1b 条件渲染与交互锁：无供应商显示 / 有供应商不显示 / 关闭后会话内不再
// 显示 / 去配置直达 设置→模型服务 / 首拉未完成不闪现。
// Mock 策略（momo-test-rules）：mock 收窄到 IPC 边界（window.api.provider.list），
// provider store 走真实 loadProviders 链——组件读到的 providers 即 IPC 返回值。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ProviderMissingBanner } from './ProviderMissingBanner';
import { useProviderStore } from '../../stores/provider.store';
import { useSettingsStore } from '../../stores/settings.store';
import { useUiStore } from '../../stores/ui.store';
import type { ModelProvider } from '../../ipc/types';

const providerList = vi.fn();

const PROVIDER: ModelProvider = {
  id: 'p1', name: '智谱 GLM', baseUrl: 'https://a', defaultModel: null,
  isDefault: false, createdAt: '', platform: 'openai', presetKey: 'zhipu',
};

beforeEach(() => {
  providerList.mockReset().mockResolvedValue([]);
  (globalThis as unknown as { window: { api: unknown } }).window.api = {
    provider: { list: providerList },
  };
  useProviderStore.setState({ providers: [], loading: false });
  useUiStore.setState({ activeView: 'im' });
  useSettingsStore.setState({ activeCategory: 'memory' });
});

describe('ProviderMissingBanner（D1b）', () => {
  it('无供应商（首拉完成）→ 显示横幅与双按钮', async () => {
    render(<ProviderMissingBanner />);
    expect(await screen.findByTestId('provider-missing-banner')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '去配置' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '关闭' })).toBeInTheDocument();
  });

  it('有供应商 → 不显示', async () => {
    providerList.mockResolvedValue([PROVIDER]);
    render(<ProviderMissingBanner />);
    await waitFor(() => expect(useProviderStore.getState().providers).toHaveLength(1));
    expect(screen.queryByTestId('provider-missing-banner')).not.toBeInTheDocument();
  });

  it('首拉未完成 → 不显示（防加载间隙闪现）', () => {
    providerList.mockReturnValue(new Promise(() => {}));
    render(<ProviderMissingBanner />);
    expect(screen.queryByTestId('provider-missing-banner')).not.toBeInTheDocument();
  });

  it('拉取失败 → 保守降级仍显示（providers 空 + 设置入口可用）', async () => {
    providerList.mockRejectedValue(new Error('ipc down'));
    render(<ProviderMissingBanner />);
    expect(await screen.findByTestId('provider-missing-banner')).toBeInTheDocument();
  });

  it('点「关闭」→ 会话内不再显示', async () => {
    render(<ProviderMissingBanner />);
    fireEvent.click(await screen.findByRole('button', { name: '关闭' }));
    expect(screen.queryByTestId('provider-missing-banner')).not.toBeInTheDocument();
  });

  it('点「去配置」→ 设置视图 + 定位「模型服务」分类', async () => {
    render(<ProviderMissingBanner />);
    fireEvent.click(await screen.findByRole('button', { name: '去配置' }));
    expect(useUiStore.getState().activeView).toBe('settings');
    expect(useSettingsStore.getState().activeCategory).toBe('model_provider');
  });
});
