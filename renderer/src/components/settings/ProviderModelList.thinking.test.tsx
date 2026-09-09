// renderer/src/components/settings/ProviderModelList.thinking.test.tsx
//
// 模型行思维控件（spec §7.2）：三态 + 档位下拉；kind=none 隐藏；窗口 placeholder 有效值。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ProviderModelList } from './ProviderModelList';
import type { ProviderModel } from '../../ipc/types';

const setModelThinking = vi.fn(async () => undefined);
const models: ProviderModel[] = [
  {
    providerId: 'p1', modelId: 'glm-5.3', enabled: true, addedAt: 1,
    contextWindow: null, thinkingJson: null,
    reasoning: { kind: 'effort', values: ['low', 'high', 'max'], default: 'max' },
    effectiveWindow: 1000000,
  },
  {
    providerId: 'p1', modelId: 'glm-4.6', enabled: true, addedAt: 2,
    contextWindow: null, thinkingJson: null,
    reasoning: { kind: 'toggle' },
    effectiveWindow: 200000,
  },
  {
    providerId: 'p1', modelId: 'glm-4.5-air', enabled: true, addedAt: 3,
    contextWindow: null, thinkingJson: null,
    reasoning: { kind: 'none' },
    effectiveWindow: null,
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  // 与 ipc client Proxy 约定一致：替换 window.api 属性（保留 jsdom window 本体，
  // 整体替换 globalThis.window 会删掉 document/HTMLElement 使 react-dom 崩溃）
  (globalThis as unknown as { window: { api: unknown } }).window.api = {
    provider: {
      listModels: async () => models,
      setModelEnabled: async () => undefined,
      removeModel: async () => undefined,
      addModel: async () => undefined,
      fetchModels: async () => [],
      setModelWindow: async () => undefined,
      setModelThinking,
    },
  };
});

describe('模型行思维控件', () => {
  it('effort 模型渲染三态；开启后档位下拉选项=模型 values', async () => {
    render(<ProviderModelList providerId="p1" />);
    const modeSel = await screen.findByLabelText('思维模式 glm-5.3');
    expect(modeSel).toBeTruthy();
    fireEvent.change(modeSel, { target: { value: 'on' } });
    const effortSel = await screen.findByLabelText('思维档位 glm-5.3');
    for (const v of ['low', 'high', 'max']) {
      expect((effortSel as HTMLSelectElement).textContent).toContain(v);
    }
  });

  it('开+选档提交 ThinkingConfig；「默认」提交 null', async () => {
    render(<ProviderModelList providerId="p1" />);
    fireEvent.change(await screen.findByLabelText('思维模式 glm-5.3'), { target: { value: 'on' } });
    fireEvent.change(await screen.findByLabelText('思维档位 glm-5.3'), { target: { value: 'low' } });
    await waitFor(() =>
      expect(setModelThinking).toHaveBeenCalledWith('p1', 'glm-5.3', { mode: 'on', effort: 'low' }),
    );
    fireEvent.change(screen.getByLabelText('思维模式 glm-5.3'), { target: { value: 'auto' } });
    await waitFor(() =>
      expect(setModelThinking).toHaveBeenCalledWith('p1', 'glm-5.3', null),
    );
  });

  it('toggle 模型只有三态无档位；none 模型无控件', async () => {
    render(<ProviderModelList providerId="p1" />);
    await screen.findByText('glm-4.6');
    expect(screen.queryByLabelText('思维档位 glm-4.6')).toBeNull();
    expect(screen.queryByLabelText('思维模式 glm-4.5-air')).toBeNull();
  });

  it('窗口 placeholder 显示 resolve 有效值（1M / 200K / 自动）', async () => {
    render(<ProviderModelList providerId="p1" />);
    expect((await screen.findByLabelText('上下文窗口 glm-5.3') as HTMLInputElement).placeholder).toBe('1M');
    expect((screen.getByLabelText('上下文窗口 glm-4.6') as HTMLInputElement).placeholder).toBe('200K');
    expect((screen.getByLabelText('上下文窗口 glm-4.5-air') as HTMLInputElement).placeholder).toBe('自动');
  });
});
