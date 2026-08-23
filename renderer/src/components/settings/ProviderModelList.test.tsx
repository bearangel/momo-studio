// renderer/src/components/settings/ProviderModelList.test.tsx
//
// ProviderModelList 行为测试（P2 Task 6）：
// - 挂载时 ipc.provider.listModels 拉取并渲染模型行（model_id + 启用开关 + 删除）
// - toggle → setModelEnabled；删除行 → removeModel
// - 「↻ 获取模型列表」→ fetchModels → 逐个 addModel → 刷新列表 + onChanged 回调
// - fetchModels 失败 → 内联错误展示，不触发 addModel
// - 「＋ 手动添加」→ 内联输入提交 addModel
// - providerId 切换时重新加载
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ProviderModelList } from './ProviderModelList';

const listModels = vi.fn();
const fetchModels = vi.fn();
const addModel = vi.fn();
const setModelEnabled = vi.fn();
const removeModel = vi.fn();

const mockApi = {
  provider: { listModels, fetchModels, addModel, setModelEnabled, removeModel },
};
(globalThis as unknown as { window: { api: typeof mockApi } }).window.api = mockApi;

const MODELS = [
  { providerId: 'p1', modelId: 'glm-5.3', enabled: true, addedAt: 1 },
  { providerId: 'p1', modelId: 'glm-5.2', enabled: false, addedAt: 2 },
];

describe('ProviderModelList', () => {
  beforeEach(() => {
    listModels.mockReset().mockResolvedValue(MODELS);
    fetchModels.mockReset();
    addModel.mockReset().mockResolvedValue(undefined);
    setModelEnabled.mockReset().mockResolvedValue(undefined);
    removeModel.mockReset().mockResolvedValue(undefined);
  });

  it('挂载时渲染模型行（model_id + 启用状态）', async () => {
    render(<ProviderModelList providerId="p1" />);
    expect(await screen.findByText('glm-5.3')).toBeInTheDocument();
    expect(screen.getByText('glm-5.2')).toBeInTheDocument();
    expect(listModels).toHaveBeenCalledWith('p1');
  });

  it('空列表显示引导文案', async () => {
    listModels.mockResolvedValue([]);
    render(<ProviderModelList providerId="p1" />);
    await waitFor(() => expect(screen.getByText(/暂无模型/)).toBeInTheDocument());
  });

  it('点击启用开关 → setModelEnabled(providerId, modelId, 取反值)', async () => {
    render(<ProviderModelList providerId="p1" />);
    await screen.findByText('glm-5.3');
    fireEvent.click(screen.getByRole('checkbox', { name: '启用 glm-5.3' }));
    await waitFor(() => expect(setModelEnabled).toHaveBeenCalledWith('p1', 'glm-5.3', false));
  });

  it('点击行删除 → removeModel(providerId, modelId) + onChanged', async () => {
    const onChanged = vi.fn();
    render(<ProviderModelList providerId="p1" onChanged={onChanged} />);
    await screen.findByText('glm-5.3');
    fireEvent.click(screen.getByRole('button', { name: '删除 glm-5.3' }));
    await waitFor(() => expect(removeModel).toHaveBeenCalledWith('p1', 'glm-5.3'));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('「↻ 获取模型列表」→ fetchModels 后逐个 addModel 并刷新', async () => {
    const onChanged = vi.fn();
    fetchModels.mockResolvedValue(['new-a', 'new-b']);
    render(<ProviderModelList providerId="p1" onChanged={onChanged} />);
    await screen.findByText('glm-5.3');

    fireEvent.click(screen.getByRole('button', { name: /获取模型列表/ }));
    await waitFor(() => {
      expect(fetchModels).toHaveBeenCalledWith('p1');
      expect(addModel).toHaveBeenCalledWith('p1', 'new-a');
      expect(addModel).toHaveBeenCalledWith('p1', 'new-b');
    });
    // addModel 后重新拉取列表 + 通知父组件刷新计数
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(listModels.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('fetchModels 失败 → 显示错误信息且不触发 addModel', async () => {
    fetchModels.mockRejectedValue(new Error('HTTP 401'));
    render(<ProviderModelList providerId="p1" />);
    await screen.findByText('glm-5.3');

    fireEvent.click(screen.getByRole('button', { name: /获取模型列表/ }));
    expect(await screen.findByText(/HTTP 401/)).toBeInTheDocument();
    expect(addModel).not.toHaveBeenCalled();
  });

  it('「＋ 手动添加」→ 内联输入提交 addModel 并收起输入框', async () => {
    render(<ProviderModelList providerId="p1" />);
    await screen.findByText('glm-5.3');

    fireEvent.click(screen.getByRole('button', { name: /手动添加/ }));
    const input = screen.getByPlaceholderText('模型 ID，如 glm-5.3');
    fireEvent.change(input, { target: { value: 'glm-5.4' } });
    fireEvent.click(screen.getByRole('button', { name: '添加' }));

    await waitFor(() => expect(addModel).toHaveBeenCalledWith('p1', 'glm-5.4'));
    await waitFor(() => expect(screen.queryByPlaceholderText('模型 ID，如 glm-5.3')).not.toBeInTheDocument());
  });

  it('providerId 切换时重新加载', async () => {
    const { rerender } = render(<ProviderModelList providerId="p1" />);
    await screen.findByText('glm-5.3');
    rerender(<ProviderModelList providerId="p2" />);
    await waitFor(() => expect(listModels).toHaveBeenCalledWith('p2'));
  });
});
