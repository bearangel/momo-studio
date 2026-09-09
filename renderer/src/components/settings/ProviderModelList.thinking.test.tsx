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

// 回归：fix 哨兵三态化——已配置模型选「默认」必须真正回显为 auto，不能被 config 覆盖回 on
describe('默认清除（fix 哨兵冲突）', () => {
  const configuredModels: ProviderModel[] = [
    {
      providerId: 'p1', modelId: 'glm-5.3', enabled: true, addedAt: 1,
      contextWindow: 1000000, thinkingJson: { mode: 'on', effort: 'low' },
      reasoning: { kind: 'effort', values: ['low', 'high', 'max'], default: 'max' },
      effectiveWindow: 1000000,
    },
  ];
  let setModelThinking: ReturnType<typeof vi.fn<[], Promise<undefined>>>;
  beforeEach(() => {
    setModelThinking = vi.fn(async () => undefined);
    // 与本文件其余测试一致：替换 window.api 属性而非整个 window（保留 jsdom document）
    (globalThis as unknown as { window: { api: unknown } }).window.api = {
      provider: {
        listModels: async () => configuredModels,
        setModelEnabled: async () => undefined,
        removeModel: async () => undefined,
        addModel: async () => undefined,
        fetchModels: async () => [],
        setModelWindow: async () => undefined,
        setModelThinking,
      },
    };
  });
  it('已配置模型选「默认」→ select 回 auto + 档位下拉消失 + IPC 收 null', async () => {
    render(<ProviderModelList providerId="p1" />);
    const modeSel = await screen.findByLabelText('思维模式 glm-5.3');
    // 初始：服务端 config 是 {mode:'on', effort:'low'}，UI 应显示「开」+ 档位下拉
    expect((modeSel as HTMLSelectElement).value).toBe('on');
    expect(screen.queryByLabelText('思维档位 glm-5.3')).not.toBeNull();
    // 用户选「默认」(auto) → 提交 null
    fireEvent.change(modeSel, { target: { value: 'auto' } });
    await waitFor(() =>
      expect(setModelThinking).toHaveBeenCalledWith('p1', 'glm-5.3', null),
    );
    // 关键断言：UI 真正反映清除（不应被 config 覆盖回 'on'，档位下拉须消失）
    expect((screen.getByLabelText('思维模式 glm-5.3') as HTMLSelectElement).value).toBe('auto');
    expect(screen.queryByLabelText('思维档位 glm-5.3')).toBeNull();
  });
});
