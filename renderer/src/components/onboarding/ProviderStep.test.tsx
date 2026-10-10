// renderer/src/components/onboarding/ProviderStep.test.tsx
//
// 供应商配置步测试（spec 2026-10-10 §8 + 预览确认稿）：
// 已有供应商快捷路径 / 预设新建验证失败行内错误 / 预设新建成功推进 / 自定义形态。
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { WizardCtx } from '../../routes/OnboardingWizard';

const mockCreate = vi.fn();
const mockTestConnection = vi.fn();
const mockList = vi.fn();
const mockListPresets = vi.fn();
const mockListModels = vi.fn();

vi.mock('../../ipc/client', () => ({
  ipc: {
    provider: {
      list: (...a: unknown[]) => mockList(...a),
      listPresets: (...a: unknown[]) => mockListPresets(...a),
      listModels: (...a: unknown[]) => mockListModels(...a),
      create: (...a: unknown[]) => mockCreate(...a),
      testConnection: (...a: unknown[]) => mockTestConnection(...a),
    },
  },
}));

import { ProviderStep } from './ProviderStep';

const EXISTING = {
  id: 'p1',
  name: '智谱 GLM',
  baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
  defaultModel: null,
  isDefault: false,
  createdAt: '',
  platform: 'openai' as const,
  presetKey: 'zhipu',
};

const PRESETS = [
  {
    key: 'zhipu',
    name: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    platform: 'openai' as const,
    thinkingWire: 'effort' as const,
    models: [
      { id: 'glm-5.3', contextWindow: 128000, outputTokens: 8192, reasoning: { kind: 'none' as const } },
    ],
  },
];

const MODELS_P1 = [
  {
    providerId: 'p1',
    modelId: 'glm-5.3',
    contextWindow: null,
    thinkingJson: null,
    reasoning: { kind: 'none' as const },
    effectiveWindow: null,
    vision: false,
  },
];

function mkCtx(): WizardCtx {
  return {
    route: 'ai',
    providerId: '',
    modelId: '',
    workspaceId: '',
    plan: null,
    setProvider: vi.fn(),
    setWorkspace: vi.fn(),
    setPlan: vi.fn(),
    go: vi.fn(),
    toManual: vi.fn(),
    finish: vi.fn(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockList.mockResolvedValue([]);
  mockListPresets.mockResolvedValue(PRESETS);
  mockListModels.mockResolvedValue(MODELS_P1);
  mockCreate.mockResolvedValue(EXISTING);
});

describe('ProviderStep', () => {
  it('已有供应商快捷路径：选中 + 模型自动取列表首项 + 继续推进', async () => {
    mockList.mockResolvedValue([EXISTING]);
    const ctx = mkCtx();
    render(<ProviderStep ctx={ctx} />);
    fireEvent.click(await screen.findByText('使用已有供应商'));
    fireEvent.click(await screen.findByText('智谱 GLM'));
    expect(await screen.findByText(/glm-5\.3/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '继续' }));
    await waitFor(() => expect(ctx.setProvider).toHaveBeenCalledWith('p1', 'glm-5.3'));
    expect(ctx.go).toHaveBeenCalledWith('workspace');
  });

  it('预设新建 + 验证失败 → 行内错误，不 create 不推进', async () => {
    const ctx = mkCtx();
    render(<ProviderStep ctx={ctx} />);
    fireEvent.click(await screen.findByText('智谱 GLM'));
    const keyInput = await screen.findByLabelText(/API Key/);
    fireEvent.change(keyInput, { target: { value: 'sk-bad' } });
    mockTestConnection.mockResolvedValue({ ok: false, error: 'HTTP 401' });
    fireEvent.click(screen.getByRole('button', { name: /验证并继续/ }));
    expect(await screen.findByText(/HTTP 401/)).toBeInTheDocument();
    expect(mockCreate).not.toHaveBeenCalled();
    expect(ctx.go).not.toHaveBeenCalled();
  });

  it('预设新建 + 验证成功 → create → setProvider → 推进 workspace', async () => {
    const ctx = mkCtx();
    render(<ProviderStep ctx={ctx} />);
    fireEvent.click(await screen.findByText('智谱 GLM'));
    fireEvent.change(await screen.findByLabelText(/API Key/), { target: { value: 'sk-good' } });
    mockTestConnection.mockResolvedValue({ ok: true });
    fireEvent.click(screen.getByRole('button', { name: /验证并继续/ }));
    await waitFor(() =>
      expect(mockTestConnection).toHaveBeenCalledWith(
        expect.objectContaining({ baseUrl: PRESETS[0]!.baseUrl, apiKey: 'sk-good', model: 'glm-5.3' }),
      ),
    );
    await waitFor(() =>
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({ name: '智谱 GLM', presetKey: 'zhipu', isDefault: true }),
      ),
    );
    expect(ctx.setProvider).toHaveBeenCalledWith('p1', 'glm-5.3');
    expect(ctx.go).toHaveBeenCalledWith('workspace');
  });

  it('自定义供应商形态：名称/平台/Base URL/模型名手填', async () => {
    const ctx = mkCtx();
    render(<ProviderStep ctx={ctx} />);
    fireEvent.click(await screen.findByText('+ 自定义供应商'));
    expect(await screen.findByLabelText(/名称/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Base URL/)).toBeInTheDocument();
    expect(screen.getByLabelText(/模型名/)).toBeInTheDocument();
  });
});
