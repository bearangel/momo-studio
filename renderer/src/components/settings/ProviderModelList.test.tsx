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
const setModelWindow = vi.fn();

const mockApi = {
  provider: { listModels, fetchModels, addModel, setModelEnabled, removeModel, setModelWindow },
};
(globalThis as unknown as { window: { api: typeof mockApi } }).window.api = mockApi;

const MODELS = [
  // thinking 三字段为 v31 数据形状升级（Task 9）；断言语义不变
  {
    providerId: 'p1', modelId: 'glm-5.3', enabled: true, addedAt: 1, contextWindow: 131072,
    reasoning: { kind: 'none' }, thinkingJson: null, effectiveWindow: null,
  },
  {
    providerId: 'p1', modelId: 'glm-5.2', enabled: false, addedAt: 2, contextWindow: null,
    reasoning: { kind: 'none' }, thinkingJson: null, effectiveWindow: null,
  },
];

describe('ProviderModelList', () => {
  beforeEach(() => {
    listModels.mockReset().mockResolvedValue(MODELS);
    fetchModels.mockReset();
    addModel.mockReset().mockResolvedValue(undefined);
    setModelEnabled.mockReset().mockResolvedValue(undefined);
    removeModel.mockReset().mockResolvedValue(undefined);
    setModelWindow.mockReset().mockResolvedValue(undefined);
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

  it('行内窗口编辑：输入正整数并失焦 → setModelWindow(providerId, modelId, 数值)', async () => {
    render(<ProviderModelList providerId="p1" />);
    const input = await screen.findByLabelText('上下文窗口 glm-5.3');
    expect(input).toHaveValue('131072');

    fireEvent.change(input, { target: { value: '200000' } });
    fireEvent.blur(input);

    await waitFor(() => expect(setModelWindow).toHaveBeenCalledWith('p1', 'glm-5.3', 200000));
  });

  it('清空窗口输入并失焦 → setModelWindow(providerId, modelId, null)（回退目录）', async () => {
    render(<ProviderModelList providerId="p1" />);
    const input = await screen.findByLabelText('上下文窗口 glm-5.3');

    fireEvent.change(input, { target: { value: '' } });
    fireEvent.blur(input);

    await waitFor(() => expect(setModelWindow).toHaveBeenCalledWith('p1', 'glm-5.3', null));
  });

  it('非法输入（非正整数）失焦不调 IPC，回退显示原值', async () => {
    render(<ProviderModelList providerId="p1" />);
    const input = await screen.findByLabelText('上下文窗口 glm-5.3');

    fireEvent.change(input, { target: { value: '-5' } });
    fireEvent.blur(input);
    expect(setModelWindow).not.toHaveBeenCalled();
    expect(input).toHaveValue('131072');

    fireEvent.change(input, { target: { value: 'abc' } });
    fireEvent.blur(input);
    expect(setModelWindow).not.toHaveBeenCalled();
  });

  it('窗口写入失败 → 内联错误展示', async () => {
    setModelWindow.mockRejectedValueOnce(new Error('DB locked'));
    render(<ProviderModelList providerId="p1" />);
    const input = await screen.findByLabelText('上下文窗口 glm-5.3');

    fireEvent.change(input, { target: { value: '999999' } });
    fireEvent.blur(input);

    expect(await screen.findByText(/DB locked/)).toBeInTheDocument();
  });
});
