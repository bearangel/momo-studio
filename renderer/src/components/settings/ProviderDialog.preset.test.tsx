// renderer/src/components/settings/ProviderDialog.preset.test.tsx
//
// 预设两段式：选卡 → 预填 → 提交带 presetKey；自定义路径回归（spec §7.1）。
// window.api mock 与 ipc client Proxy 约定一致（Object.assign 全局）。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ProviderDialog } from './ProviderDialog';
import type { ModelProvider, ProviderPreset } from '../../ipc/types';

const presets: ProviderPreset[] = [
  {
    key: 'zhipu', name: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    platform: 'openai', thinkingWire: 'toggle-effort',
    models: [
      { id: 'glm-5.3', contextWindow: 1000000, outputTokens: 128000, reasoning: { kind: 'effort', values: ['low', 'high', 'max'], default: 'max' } },
    ],
  },
  {
    key: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1',
    platform: 'openai', thinkingWire: 'effort', fetchListHint: true, models: [],
  },
];

const created: ModelProvider = {
  id: 'p1', name: '智谱 GLM', baseUrl: '', defaultModel: null,
  isDefault: false, createdAt: '', platform: 'openai', presetKey: 'zhipu',
};
const create = vi.fn(async (_input: { presetKey?: string; platform?: string }) => created);

function mockApi(overrides?: Record<string, unknown>): void {
  // 与 ipc client Proxy 约定一致：替换 window.api 属性（保留 jsdom window 本体，
  // 整体替换 globalThis.window 会删掉 document/HTMLElement 使 react-dom 崩溃）
  (globalThis as unknown as { window: { api: unknown } }).window.api = {
    provider: {
      listPresets: async () => presets,
      create,
      listModels: async () => [],
      list: async () => [],
      testConnection: async () => ({ ok: true }),
      ...overrides,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockApi();
});

describe('ProviderDialog 预设两段式', () => {
  it('打开即显示预设卡片（品牌名 + 拉取提示）', async () => {
    render(<ProviderDialog open onClose={() => {}} onSaved={() => {}} />);
    expect(await screen.findByText('智谱 GLM')).toBeTruthy();
    expect(screen.getByText(/创建后可拉取模型列表/)).toBeTruthy();
  });

  it('点选预设 → 表单预填（名称/BaseURL/平台）→ 提交带 presetKey', async () => {
    render(<ProviderDialog open onClose={() => {}} onSaved={() => {}} />);
    fireEvent.click(await screen.findByText('智谱 GLM'));
    expect(await screen.findByDisplayValue('https://open.bigmodel.cn/api/paas/v4')).toBeTruthy();
    expect(screen.getByDisplayValue('智谱 GLM')).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/API Key/), { target: { value: 'sk-x' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(create.mock.calls[0]![0]).toMatchObject({ presetKey: 'zhipu', platform: 'openai' });
  });

  it('自定义入口保留手填路径（无 presetKey）', async () => {
    render(<ProviderDialog open onClose={() => {}} onSaved={() => {}} />);
    fireEvent.click(await screen.findByText('自定义供应商'));
    fireEvent.change(screen.getByLabelText(/^名称$/), { target: { value: 'My' } });
    fireEvent.change(screen.getByLabelText(/Base URL/), { target: { value: 'https://x.test/v1' } });
    fireEvent.change(screen.getByLabelText(/API Key/), { target: { value: 'k' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(create.mock.calls[0]![0].presetKey).toBeUndefined();
  });

  it('已添加的预设显示徽标（按 presetKey 判重）', async () => {
    mockApi({
      list: async () => [created],
    });
    const { useProviderStore } = await import('../../stores/provider.store');
    useProviderStore.setState({ providers: [], loading: false });
    render(<ProviderDialog open onClose={() => {}} onSaved={() => {}} />);
    expect(await screen.findByText('已添加')).toBeTruthy();
  });
});
