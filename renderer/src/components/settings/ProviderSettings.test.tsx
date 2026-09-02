// renderer/src/components/settings/ProviderSettings.test.tsx
//
// ProviderSettings 两列重构行为测试（P2 Task 6，照 settings.html「模型服务」原型）：
// - 左列 218px 供应商列表：名称 + 模型数徽标 + 默认 Star 标记 + Plus 入口
// - 挂载自动选中默认供应商 → 右列配置卡（名称/平台下拉/BaseURL/APIKey 留空不改）
// - 保存 → update 携带 platform；APIKey 留空时不传
// - 删除供应商（confirm 确认）
// v2.1 P1：默认标记 emoji ⭐ → lucide Star；断言改语义查询（getByTitle('默认供应商')）
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { ProviderSettings } from './ProviderSettings';
import { useProviderStore } from '../../stores/provider.store';
import type { ModelProvider } from '../../ipc/types';

const PROVIDERS: ModelProvider[] = [
  { id: 'p1', name: 'P1', baseUrl: 'https://a.example.com/v1', defaultModel: null, isDefault: true, createdAt: '', platform: 'openai' },
  { id: 'p2', name: 'P2', baseUrl: 'https://b.example.com', defaultModel: null, isDefault: false, createdAt: '', platform: 'anthropic' },
];
const P1_MODELS = [
  { providerId: 'p1', modelId: 'glm-5.3', enabled: true, addedAt: 1 },
  { providerId: 'p1', modelId: 'glm-5.2', enabled: true, addedAt: 2 },
];

const list = vi.fn();
const update = vi.fn();
const del = vi.fn();
const setDefault = vi.fn();
const listModels = vi.fn();

const mockApi = {
  provider: { list, update, delete: del, setDefault, listModels },
};
(globalThis as unknown as { window: { api: typeof mockApi } }).window.api = mockApi;

describe('ProviderSettings 两列布局', () => {
  beforeEach(() => {
    list.mockReset().mockResolvedValue(PROVIDERS);
    update.mockReset().mockResolvedValue(PROVIDERS[0]);
    del.mockReset().mockResolvedValue({ ok: true });
    setDefault.mockReset().mockResolvedValue({ ok: true });
    listModels.mockReset().mockImplementation(async (id: string) => (id === 'p1' ? P1_MODELS : []));
    useProviderStore.setState({
      providers: [], loading: false,
      loadProviders: useProviderStore.getState().loadProviders,
      createProvider: useProviderStore.getState().createProvider,
      updateProvider: useProviderStore.getState().updateProvider,
      deleteProvider: useProviderStore.getState().deleteProvider,
      setDefault: useProviderStore.getState().setDefault,
      clear: useProviderStore.getState().clear,
    });
  });

  it('左列为 218px 宽的 aside 供应商列表', async () => {
    const { container } = render(<ProviderSettings />);
    await screen.findByRole('button', { name: /P1/ });
    const aside = container.querySelector('aside');
    expect(aside).not.toBeNull();
    expect(aside?.style.width).toBe('218px');
  });

  it('供应商行显示名称 + 模型数徽标 + 默认 Star 标记', async () => {
    render(<ProviderSettings />);
    const row1 = await screen.findByRole('button', { name: /P1/ });
    // 模型数徽标在 refreshCounts 完成后才出现，需等待
    await waitFor(() => expect(row1.textContent).toContain('2'));
    // 默认标记 emoji → lucide Star，外层 span title='默认供应商' 保留以语义查询
    expect(within(row1).getByTitle('默认供应商')).toBeInTheDocument();
    const row2 = screen.getByRole('button', { name: /P2/ });
    expect(within(row2).queryByTitle('默认供应商')).not.toBeInTheDocument();
    expect(row2.textContent).toContain('0');
  });

  it('挂载自动选中默认供应商 → 右列配置卡回显（名称/平台/BaseURL）+ 模型列表', async () => {
    render(<ProviderSettings />);
    await waitFor(() => expect((screen.getByLabelText('名称') as HTMLInputElement).value).toBe('P1'));
    expect((screen.getByLabelText('平台') as HTMLSelectElement).value).toBe('openai');
    expect((screen.getByLabelText('Base URL') as HTMLInputElement).value).toBe('https://a.example.com/v1');
    // 内嵌 ProviderModelList 渲染选中供应商的模型
    expect(await screen.findByText('glm-5.3')).toBeInTheDocument();
  });

  it('切换左列选择 → 右列配置卡切换为对应供应商', async () => {
    render(<ProviderSettings />);
    await screen.findByRole('button', { name: /P2/ });
    fireEvent.click(screen.getByRole('button', { name: /P2/ }));
    await waitFor(() => expect((screen.getByLabelText('名称') as HTMLInputElement).value).toBe('P2'));
    expect((screen.getByLabelText('平台') as HTMLSelectElement).value).toBe('anthropic');
  });

  it('修改平台并保存 → update 携带 platform，APIKey 留空不传', async () => {
    render(<ProviderSettings />);
    await waitFor(() => expect((screen.getByLabelText('名称') as HTMLInputElement).value).toBe('P1'));
    fireEvent.change(screen.getByLabelText('平台'), { target: { value: 'anthropic' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => expect(update).toHaveBeenCalled());
    expect(update).toHaveBeenCalledWith(expect.objectContaining({
      id: 'p1', name: 'P1', baseUrl: 'https://a.example.com/v1', platform: 'anthropic',
    }));
    expect(update.mock.calls[0][0]).not.toHaveProperty('apiKey');
  });

  it('填写 APIKey 后保存 → update 携带 apiKey', async () => {
    render(<ProviderSettings />);
    await waitFor(() => expect((screen.getByLabelText('名称') as HTMLInputElement).value).toBe('P1'));
    fireEvent.change(screen.getByLabelText(/API Key/), { target: { value: 'sk-new' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => expect(update).toHaveBeenCalled());
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'sk-new' }));
  });

  it('点击「＋」打开添加供应商对话框（含平台选择，无默认模型字段）', async () => {
    render(<ProviderSettings />);
    await screen.findByRole('button', { name: /P1/ });
    fireEvent.click(screen.getByRole('button', { name: '添加供应商' }));
    const dialog = await screen.findByRole('dialog', { name: '添加供应商' });
    expect(within(dialog).getByLabelText('平台')).toBeInTheDocument();
    expect(screen.queryByText(/默认模型/)).not.toBeInTheDocument();
  });

  it('删除供应商（confirm 确认后调用 delete）', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<ProviderSettings />);
    await screen.findByRole('button', { name: /P1/ });
    // 自动选中是行渲染后的下一个 effect tick，先等配置卡挂载再点删除
    await waitFor(() => expect(screen.getByLabelText('名称')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: '删除' }));
    await waitFor(() => expect(del).toHaveBeenCalledWith('p1'));
  });

  it('无供应商时右列显示引导文案', async () => {
    list.mockResolvedValue([]);
    render(<ProviderSettings />);
    await waitFor(() => expect(screen.getByText(/暂无供应商/)).toBeInTheDocument());
  });
});
