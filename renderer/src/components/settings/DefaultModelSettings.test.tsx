// renderer/src/components/settings/DefaultModelSettings.test.tsx
//
// 默认模型面板行为测试（P2 Task 7，照 settings.html「默认模型」原型）：
// - 四张卡（💬 会话模型 / 👁 多模态模型 / 🧬 向量模型 / 🔀 重排模型）
// - 每卡：provider 下拉（来自 provider.store）+ model 下拉（该 provider 的 enabled 模型列表）
// - 级联：选 provider → 拉 listModels → 填充 model 下拉
// - 保存：updateGlobal({ defaultXxxModel: { providerId, modelId } })
// - 清除按钮：updateGlobal({ defaultXxxModel: undefined })（语义：kv_store 移除该键）
// - 向量/重排卡：「2.1 知识库启用」badge 存在
// - 空态：无 provider 时整面板提示「先在模型服务添加供应商」；
//   有 provider 但无 enabled 模型时 model 下拉禁用 + 提示「先在模型服务添加模型」
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { DefaultModelSettings } from './DefaultModelSettings';
import { useProviderStore } from '../../stores/provider.store';
import type { GlobalSettings, ModelProvider, ProviderModel } from '../../ipc/types';

const P1: ModelProvider = {
  id: 'p1', name: '智谱 AI', baseUrl: 'https://a.example.com/v1',
  defaultModel: null, isDefault: true, createdAt: '', platform: 'openai',
};
const P2: ModelProvider = {
  id: 'p2', name: 'DeepSeek', baseUrl: 'https://b.example.com',
  defaultModel: null, isDefault: false, createdAt: '', platform: 'openai',
};
const P1_MODELS: ProviderModel[] = [
  { providerId: 'p1', modelId: 'glm-4.7', enabled: true, addedAt: 1 },
  { providerId: 'p1', modelId: 'glm-4.7-flash', enabled: true, addedAt: 2 },
  { providerId: 'p1', modelId: 'glm-4.7-disabled', enabled: false, addedAt: 3 },
];
const P2_MODELS: ProviderModel[] = [
  { providerId: 'p2', modelId: 'deepseek-chat', enabled: true, addedAt: 1 },
];

const listMock = vi.fn();
const listModelsMock = vi.fn();
const getGlobalMock = vi.fn();
const updateGlobalMock = vi.fn();

const baseGlobal: GlobalSettings = {
  maxToolCalls: 10,
  auditQuotaMb: 100,
};

describe('DefaultModelSettings', () => {
  beforeEach(() => {
    // 每次测试前重置 mockApi——避免同 context 下其他测试文件（如 ProviderSettings.test.tsx
    // 模块加载时设置的不含 settings 命名空间的 mockApi）覆盖本测试的 settings IPC 桩。
    (globalThis as unknown as { window: { api: unknown } }).window.api = {
      provider: { list: listMock, listModels: listModelsMock },
      settings: { getGlobal: getGlobalMock, updateGlobal: updateGlobalMock },
    };
    listMock.mockReset().mockResolvedValue([P1, P2]);
    listModelsMock.mockReset().mockImplementation(async (id: string) =>
      id === 'p1' ? P1_MODELS : id === 'p2' ? P2_MODELS : [],
    );
    getGlobalMock.mockReset().mockResolvedValue({ ...baseGlobal });
    updateGlobalMock.mockReset().mockImplementation(async (patch: Partial<GlobalSettings>) => ({
      ...baseGlobal,
      ...patch,
    }));
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

  it('渲染四张卡：会话模型 / 多模态模型 / 向量模型 / 重排模型', async () => {
    render(<DefaultModelSettings />);
    await waitFor(() => expect(screen.getByText('会话模型')).toBeInTheDocument());
    expect(screen.getByText('多模态模型')).toBeInTheDocument();
    expect(screen.getByText('向量模型')).toBeInTheDocument();
    expect(screen.getByText('重排模型')).toBeInTheDocument();
  });

  it('向量/重排卡显示「2.1 知识库启用」badge', async () => {
    render(<DefaultModelSettings />);
    await waitFor(() => expect(screen.getAllByText('2.1 知识库启用').length).toBe(2));
  });

  it('无 provider 时整面板提示「先在模型服务添加供应商」', async () => {
    listMock.mockResolvedValue([]);
    render(<DefaultModelSettings />);
    expect(await screen.findByText(/先在模型服务添加供应商/)).toBeInTheDocument();
  });

  it('有 provider 但该 provider 无 enabled 模型 → model 下拉禁用 + 提示「先在模型服务添加模型」', async () => {
    listMock.mockResolvedValue([P1]);
    listModelsMock.mockReset().mockResolvedValue([
      { providerId: 'p1', modelId: 'm1-disabled', enabled: false, addedAt: 1 },
    ]);
    render(<DefaultModelSettings />);
    // 等到 init 派生 picks（首供应商已填入）、model 下拉被禁用（enabled=[]）
    await waitFor(() => {
      const selects = screen.getAllByLabelText('模型');
      expect(selects.length).toBe(4);
      expect((selects[0] as HTMLSelectElement).disabled).toBe(true);
      // 同步断言 model 下拉的 placeholder option 文本已从「先选择供应商」变为「先在模型服务添加模型」
      const optionTexts = Array.from((selects[0] as HTMLSelectElement).options).map((o) => o.textContent);
      expect(optionTexts).toContain('先在模型服务添加模型');
    });
    expect(
      screen.getAllByText((_content, el) => {
        if (!el) return false;
        return /先在模型服务添加模型/.test(el.textContent ?? '');
      }).length,
    ).toBeGreaterThanOrEqual(1);
  });

  it('切换 provider → model 下拉更新为该 provider 的 enabled 模型列表', async () => {
    render(<DefaultModelSettings />);
    await waitFor(() =>
      expect((screen.getAllByLabelText('模型')[0] as HTMLSelectElement).value).toBe('glm-4.7'),
    );
    const providerSelects = screen.getAllByLabelText('供应商');
    const chatProvider = providerSelects[0] as HTMLSelectElement;
    // 初始：第一个 provider 是 P1（默认）
    expect(chatProvider.value).toBe('p1');
    const chatModel = screen.getAllByLabelText('模型')[0] as HTMLSelectElement;
    expect(chatModel.value).toBe('glm-4.7');
    // 切到 P2
    fireEvent.change(chatProvider, { target: { value: 'p2' } });
    await waitFor(() => expect(listModelsMock).toHaveBeenCalledWith('p2'));
    expect((screen.getAllByLabelText('模型')[0] as HTMLSelectElement).value).toBe('deepseek-chat');
  });

  it('model 下拉只列 enabled 模型，disabled 模型不出现在选项', async () => {
    render(<DefaultModelSettings />);
    await waitFor(() =>
      expect((screen.getAllByLabelText('模型')[0] as HTMLSelectElement).value).toBe('glm-4.7'),
    );
    const chatModel = screen.getAllByLabelText('模型')[0] as HTMLSelectElement;
    const options = Array.from(chatModel.options).map((o) => o.value);
    expect(options).toContain('glm-4.7');
    expect(options).toContain('glm-4.7-flash');
    expect(options).not.toContain('glm-4.7-disabled');
  });

  it('加载完成后回显已保存的 defaultChatModel / defaultMultimodalModel', async () => {
    getGlobalMock.mockResolvedValue({
      ...baseGlobal,
      defaultChatModel: { providerId: 'p2', modelId: 'deepseek-chat' },
      defaultMultimodalModel: { providerId: 'p1', modelId: 'glm-4.7-flash' },
    });
    render(<DefaultModelSettings />);
    // 等到回显完成（chat provider=p2, model=deepseek-chat）
    await waitFor(() =>
      expect((screen.getAllByLabelText('供应商')[0] as HTMLSelectElement).value).toBe('p2'),
    );
    const providerSelects = screen.getAllByLabelText('供应商') as HTMLSelectElement[];
    const modelSelects = screen.getAllByLabelText('模型') as HTMLSelectElement[];
    expect(providerSelects[0]?.value).toBe('p2');
    expect(modelSelects[0]?.value).toBe('deepseek-chat');
    expect(providerSelects[1]?.value).toBe('p1');
    expect(modelSelects[1]?.value).toBe('glm-4.7-flash');
  });

  it('点击「保存」调用 updateGlobal 携带所选 { providerId, modelId }', async () => {
    render(<DefaultModelSettings />);
    await waitFor(() => expect(screen.getByText('会话模型')).toBeInTheDocument());
    const chatProvider = screen.getAllByLabelText('供应商')[0] as HTMLSelectElement;
    fireEvent.change(chatProvider, { target: { value: 'p2' } });
    await waitFor(() =>
      expect((screen.getAllByLabelText('模型')[0] as HTMLSelectElement).value).toBe('deepseek-chat'),
    );
    fireEvent.click(screen.getAllByRole('button', { name: '保存' })[0] as HTMLElement);
    await waitFor(() => expect(updateGlobalMock).toHaveBeenCalled());
    expect(updateGlobalMock).toHaveBeenCalledWith(
      expect.objectContaining({
        defaultChatModel: { providerId: 'p2', modelId: 'deepseek-chat' },
      }),
    );
  });

  it('点击「清除」调用 updateGlobal 把对应字段设为 undefined', async () => {
    getGlobalMock.mockResolvedValue({
      ...baseGlobal,
      defaultChatModel: { providerId: 'p1', modelId: 'glm-4.7' },
    });
    render(<DefaultModelSettings />);
    await waitFor(() => expect(screen.getByText('会话模型')).toBeInTheDocument());
    fireEvent.click(screen.getAllByRole('button', { name: '清除' })[0] as HTMLElement);
    await waitFor(() => expect(updateGlobalMock).toHaveBeenCalled());
    // 锁「键存在且值为 undefined」——区分「真实清除」（键存在 + undefined → JSON 序列化丢弃该键）
    // 与「键缺失 no-op」（`objectContaining` 也会匹配键缺失场景）。
    const arg = updateGlobalMock.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    expect(arg).toBeDefined();
    expect('defaultChatModel' in (arg as Record<string, unknown>)).toBe(true);
    expect((arg as Record<string, unknown>).defaultChatModel).toBeUndefined();
  });
});