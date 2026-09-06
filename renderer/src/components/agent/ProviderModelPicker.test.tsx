// renderer/src/components/agent/ProviderModelPicker.test.tsx
//
// ProviderModelPicker 行为测试：受控组件 + 数据自理。
//   - 供应商列表来自 useProviderStore（setState 注入，loadProviders 桩）
//   - 模型列表 ipc.provider.listModels（window.api 桩），仅 enabled 可选
//   - 联动重置：换供应商补发 onModelChange('')
//   - 空态：内嵌「拉取模型列表」（fetchModels → addModel 逐个 → listModels 刷新）
//   - 错误路径：listModels / fetchModels 失败行内展示
//
// Mock 策略（momo-test-rules）：mock 收窄到 IPC 边界（window.api）；
// store setState 注入状态 + loadProviders 桩；ProviderModel 字段全量对齐真实契约。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { ProviderModelPicker } from './ProviderModelPicker';
import { useProviderStore } from '../../stores/provider.store';
import type { ProviderModel } from '../../ipc/types';

const listModels = vi.fn();
const fetchModels = vi.fn();
const addModel = vi.fn();

/** 构造全量字段 ProviderModel（契约对齐，不写占位符） */
function pm(providerId: string, modelId: string, enabled: boolean): ProviderModel {
  return { providerId, modelId, enabled, addedAt: 0 };
}

beforeEach(() => {
  listModels.mockReset();
  fetchModels.mockReset();
  addModel.mockReset();

  (globalThis as unknown as { window: { api: unknown } }).window.api = {
    provider: { listModels, fetchModels, addModel },
  };

  useProviderStore.setState({
    providers: [
      { id: 'p1', name: '供应商A', baseUrl: 'https://a', defaultModel: null, isDefault: true, createdAt: '', platform: 'openai' as const },
      { id: 'p2', name: '供应商B', baseUrl: 'https://b', defaultModel: null, isDefault: false, createdAt: '', platform: 'anthropic' as const },
    ],
    loading: false,
    loadProviders: vi.fn().mockResolvedValue(undefined),
    createProvider: vi.fn(),
    updateProvider: vi.fn(),
    deleteProvider: vi.fn(),
    setDefault: vi.fn(),
    clear: vi.fn(),
  });
});

/** 受控桩：回调直接透传 spies（无本地 state，方便断言联动补发） */
function renderPicker(props: Partial<Parameters<typeof ProviderModelPicker>[0]> = {}) {
  const onProviderChange = vi.fn();
  const onModelChange = vi.fn();
  render(
    <ProviderModelPicker
      providerId=""
      modelId=""
      onProviderChange={onProviderChange}
      onModelChange={onModelChange}
      {...props}
    />,
  );
  return { onProviderChange, onModelChange };
}

describe('ProviderModelPicker — 供应商下拉', () => {
  it('渲染供应商列表，默认供应商带「（默认）」标记', () => {
    renderPicker();
    const select = screen.getByLabelText('模型供应商*') as HTMLSelectElement;
    expect(select.options).toHaveLength(3); // 请选择... + p1 + p2
    expect(select.options[1]!.textContent).toBe('供应商A（默认）');
    expect(select.options[2]!.textContent).toBe('供应商B');
  });

  it('未选供应商时模型下拉禁用', () => {
    renderPicker();
    expect(screen.getByLabelText('模型名')).toBeDisabled();
  });
});

describe('ProviderModelPicker — 模型联动', () => {
  it('providerId 给定 → listModels 拉取 → 仅 enabled 模型出现在下拉', async () => {
    listModels.mockResolvedValue([pm('p1', 'm-on', true), pm('p1', 'm-off', false)]);
    renderPicker({ providerId: 'p1' });
    const select = (await screen.findByLabelText('模型名')) as HTMLSelectElement;
    await waitFor(() => {
      expect(Array.from(select.options).map((o) => o.value)).toEqual(['', 'm-on']);
    });
    expect(listModels).toHaveBeenCalledWith('p1');
  });

  it('换供应商 → onProviderChange(id) + 补发 onModelChange(\'\')（联动重置）', () => {
    const { onProviderChange, onModelChange } = renderPicker();
    fireEvent.change(screen.getByLabelText('模型供应商*'), { target: { value: 'p2' } });
    expect(onProviderChange).toHaveBeenCalledWith('p2');
    expect(onModelChange).toHaveBeenCalledWith('');
  });

  it('listModels 失败 → 行内 error 展示', async () => {
    listModels.mockRejectedValue(new Error('网络不可达'));
    renderPicker({ providerId: 'p1' });
    expect(await screen.findByText('网络不可达')).toBeInTheDocument();
  });

  it('切换到已缓存的供应商时清除上一个供应商的残留 error', async () => {
    // p1 先加载成功（进缓存），p2 加载失败 → 切回 p1 → p2 的 error 必须被清掉
    listModels.mockImplementation(async (id: string) =>
      id === 'p1' ? [pm('p1', 'm-on', true)] : Promise.reject(new Error('HTTP 401')),
    );
    const { rerender } = render(
      <ProviderModelPicker
        providerId="p1"
        modelId=""
        onProviderChange={() => {}}
        onModelChange={() => {}}
      />,
    );
    await screen.findByRole('option', { name: 'm-on' });
    rerender(
      <ProviderModelPicker
        providerId="p2"
        modelId=""
        onProviderChange={() => {}}
        onModelChange={() => {}}
      />,
    );
    expect(await screen.findByText('HTTP 401')).toBeInTheDocument();
    rerender(
      <ProviderModelPicker
        providerId="p1"
        modelId=""
        onProviderChange={() => {}}
        onModelChange={() => {}}
      />,
    );
    await waitFor(() => {
      expect(screen.queryByText('HTTP 401')).not.toBeInTheDocument();
    });
    expect(screen.getByRole('option', { name: 'm-on' })).toBeInTheDocument();
  });
});

describe('ProviderModelPicker — 空态拉取', () => {
  it('模型列表为空 → 显示「拉取模型列表」→ fetchModels + addModel 逐个 + 刷新', async () => {
    // 首次 listModels 空；fetch 返回两个 id；拉取后 listModels 返回入库结果
    let listCallCount = 0;
    listModels.mockImplementation(async () => {
      listCallCount += 1;
      return listCallCount <= 1 ? [] : [pm('p1', 'glm-5.3', true), pm('p1', 'glm-4.7', true)];
    });
    fetchModels.mockResolvedValue(['glm-5.3', 'glm-4.7']);
    addModel.mockResolvedValue(undefined);

    renderPicker({ providerId: 'p1' });
    const btn = await screen.findByRole('button', { name: /拉取模型列表/ });
    fireEvent.click(btn);

    await waitFor(() => {
      expect(fetchModels).toHaveBeenCalledWith('p1');
    });
    expect(addModel).toHaveBeenCalledWith('p1', 'glm-5.3');
    expect(addModel).toHaveBeenCalledWith('p1', 'glm-4.7');
    const select = screen.getByLabelText('模型名') as HTMLSelectElement;
    await waitFor(() => {
      expect(Array.from(select.options).map((o) => o.value)).toEqual(['', 'glm-5.3', 'glm-4.7']);
    });
  });

  it('有已启用模型时不显示拉取按钮', async () => {
    listModels.mockResolvedValue([pm('p1', 'm-on', true)]);
    renderPicker({ providerId: 'p1' });
    await screen.findByRole('option', { name: 'm-on' });
    expect(screen.queryByRole('button', { name: /拉取模型列表/ })).not.toBeInTheDocument();
  });

  it('fetchModels 失败 → 行内 error（不关闭、不清空表单）', async () => {
    listModels.mockResolvedValue([]);
    fetchModels.mockRejectedValue(new Error('HTTP 401'));
    renderPicker({ providerId: 'p1' });
    fireEvent.click(await screen.findByRole('button', { name: /拉取模型列表/ }));
    expect(await screen.findByText('HTTP 401')).toBeInTheDocument();
    expect(addModel).not.toHaveBeenCalled();
  });

  it('拉取进行中切换供应商 → 过期结果不落到新供应商下拉', async () => {
    // p1 首次 listModels 空（出空态拉取按钮），拉取后返回新模型；p2 返回自己的模型
    let p1ListCalls = 0;
    let releaseFetch: () => void = () => {};
    const fetchGate = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    listModels.mockImplementation(async (id: string) => {
      if (id !== 'p1') return [pm('p2', 'p2m', true)];
      p1ListCalls += 1;
      return p1ListCalls === 1 ? [] : [pm('p1', 'p1-new', true)];
    });
    fetchModels.mockImplementation(async () => {
      await fetchGate;
      return ['p1-new'];
    });
    addModel.mockResolvedValue(undefined);

    function Harness() {
      const [providerId, setProviderId] = useState('p1');
      return (
        <ProviderModelPicker
          providerId={providerId}
          modelId=""
          onProviderChange={setProviderId}
          onModelChange={() => {}}
        />
      );
    }
    render(<Harness />);
    // p1 空态 → 点击拉取（fetch 挂起）
    fireEvent.click(await screen.findByRole('button', { name: /拉取模型列表/ }));
    // 切到 p2，其模型列表加载完成
    fireEvent.change(screen.getByLabelText('模型供应商*'), { target: { value: 'p2' } });
    await screen.findByRole('option', { name: 'p2m' });
    // 放行 p1 的 fetch：结果必须被丢弃——p1-new 不得出现在 p2 的下拉
    releaseFetch();
    await waitFor(() => {
      expect(addModel).toHaveBeenCalledWith('p1', 'p1-new');
    });
    expect(screen.queryByRole('option', { name: 'p1-new' })).not.toBeInTheDocument();
  });
});

describe('ProviderModelPicker — 缓存', () => {
  it('同 providerId 二次加载走缓存（listModels 只调一次）', async () => {
    listModels.mockResolvedValue([pm('p1', 'm-on', true)]);
    // 受控有状态 Harness：切换 p1 → p2 → p1
    function Harness() {
      const [providerId, setProviderId] = useState('p1');
      return (
        <ProviderModelPicker
          providerId={providerId}
          modelId=""
          onProviderChange={setProviderId}
          onModelChange={() => {}}
        />
      );
    }
    render(<Harness />);
    await screen.findByRole('option', { name: 'm-on' });
    fireEvent.change(screen.getByLabelText('模型供应商*'), { target: { value: 'p2' } });
    await waitFor(() => {
      expect(listModels).toHaveBeenCalledWith('p2');
    });
    fireEvent.change(screen.getByLabelText('模型供应商*'), { target: { value: 'p1' } });
    await waitFor(() => {
      expect(screen.getByRole('option', { name: 'm-on' })).toBeInTheDocument();
    });
    // p1 只在首次挂载调过一次
    expect(listModels.mock.calls.filter((c) => c[0] === 'p1')).toHaveLength(1);
  });
});
