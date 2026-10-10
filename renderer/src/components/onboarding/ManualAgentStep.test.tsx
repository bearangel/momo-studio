// renderer/src/components/onboarding/ManualAgentStep.test.tsx
//
// 手动路线配置步测试（spec 2026-10-10 §8）：预制清单渲染与勾选 / 展开预览 /
// 至少一项才能完成 / 自定义表单产出 custom 项 / 默认单选 / 组装 plan 调 applyPlan。
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { WizardCtx } from '../../routes/OnboardingWizard';

const mockListPresets = vi.fn();
const mockPreview = vi.fn();
const mockApply = vi.fn();

vi.mock('../../ipc/client', () => ({
  ipc: {
    resource: {
      listBuiltinPresets: (...a: unknown[]) => mockListPresets(...a),
      previewBuiltinPreset: (...a: unknown[]) => mockPreview(...a),
    },
    onboarding: {
      applyPlan: (...a: unknown[]) => mockApply(...a),
      markDone: vi.fn(),
      generatePlan: vi.fn(),
      getStatus: vi.fn(),
    },
  },
}));

import { ManualAgentStep } from './ManualAgentStep';

const PRESETS = [
  { slug: 'requirement-analyst', name: '需求分析师', description: '帮用户梳理需求', iconEmoji: '📋' },
  { slug: 'coder', name: '程序员', description: '通用编码 agent', iconEmoji: '💻' },
];

const PREVIEW = {
  slug: 'requirement-analyst',
  name: '需求分析师',
  iconEmoji: '📋',
  description: '帮用户梳理需求',
  systemPrompt: '你是需求分析师，负责……（长提示词截断展示）',
  tools: ['read_file', 'write_file'],
  mcps: [],
  skills: [],
};

function mkCtx(): WizardCtx {
  return {
    route: 'manual',
    providerId: 'p1',
    modelId: 'glm-5.3',
    workspaceId: 'ws-1',
    plan: null,
    planWarnings: [],
    applyResult: null,
    setProvider: vi.fn(),
    setWorkspace: vi.fn(),
    setPlan: vi.fn(),
    setPlanWarnings: vi.fn(),
    setApplyResult: vi.fn(),
    go: vi.fn(),
    toManual: vi.fn(),
    finish: vi.fn(),
  };
}

const APPLY_RESULT = {
  applied: [
    { name: '需求分析师', kind: 'preset' as const, instanceId: 'i1' },
    { name: '周报整理员', kind: 'custom' as const, instanceId: 'i2' },
  ],
  warnings: [],
  defaultAgentName: '需求分析师',
};

beforeEach(() => {
  vi.clearAllMocks();
  mockListPresets.mockResolvedValue(PRESETS);
  mockPreview.mockResolvedValue(PREVIEW);
  mockApply.mockResolvedValue(APPLY_RESULT);
});

describe('ManualAgentStep', () => {
  it('预制清单渲染（名称 + 描述）', async () => {
    render(<ManualAgentStep ctx={mkCtx()} />);
    expect(await screen.findByText('需求分析师')).toBeInTheDocument();
    expect(screen.getByText('程序员')).toBeInTheDocument();
  });

  it('展开预览：拉 previewBuiltinPreset 并截断展示提示词', async () => {
    render(<ManualAgentStep ctx={mkCtx()} />);
    fireEvent.click((await screen.findAllByRole('button', { name: /详情/ }))[0]!);
    await waitFor(() => expect(mockPreview).toHaveBeenCalledWith('requirement-analyst'));
    expect(await screen.findByText(/你是需求分析师/)).toBeInTheDocument();
  });

  it('未勾选任何项 → 完成配置禁用', async () => {
    render(<ManualAgentStep ctx={mkCtx()} />);
    const btn = (await screen.findByRole('button', { name: /完成配置/ })) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it('创建自定义表单产出 custom 项（name/prompt/工具档）', async () => {
    render(<ManualAgentStep ctx={mkCtx()} />);
    fireEvent.click(await screen.findByText(/\+ 创建自定义 agent/));
    fireEvent.change(await screen.findByLabelText(/名称/), { target: { value: '周报整理员' } });
    fireEvent.change(screen.getByLabelText(/系统提示词/), {
      target: { value: '你是周报整理员' },
    });
    fireEvent.click(screen.getByRole('button', { name: /完成配置/ }));
    await waitFor(() =>
      expect(mockApply).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceId: 'ws-1',
          plan: expect.objectContaining({
            agents: [
              expect.objectContaining({ kind: 'custom', name: '周报整理员', toolPreset: 'standard' }),
            ],
          }),
        }),
      ),
    );
  });

  it('勾选预制 + 默认单选 → 组装 preset 项调 applyPlan → setApplyResult + go(done)', async () => {
    const ctx = mkCtx();
    render(<ManualAgentStep ctx={ctx} />);
    fireEvent.click(await screen.findByLabelText(/启用 需求分析师/));
    fireEvent.click(screen.getByRole('button', { name: /完成配置/ }));
    await waitFor(() =>
      expect(mockApply).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceId: 'ws-1',
          providerId: 'p1',
          modelId: 'glm-5.3',
          plan: {
            agents: [
              { kind: 'preset', slug: 'requirement-analyst', reason: '', mcps: [], skills: [] },
            ],
            defaultAgentIndex: 0,
          },
        }),
      ),
    );
    await waitFor(() => expect(ctx.setApplyResult).toHaveBeenCalledWith(APPLY_RESULT));
    expect(ctx.go).toHaveBeenCalledWith('done');
  });

  it('applyPlan 失败 → 错误卡 + 重试可用', async () => {
    const ctx = mkCtx();
    mockApply.mockRejectedValueOnce(new Error('启用失败'));
    render(<ManualAgentStep ctx={ctx} />);
    fireEvent.click(await screen.findByLabelText(/启用 需求分析师/));
    fireEvent.click(screen.getByRole('button', { name: /完成配置/ }));
    expect(await screen.findByText(/启用失败/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /重试/ })).toBeInTheDocument();
    expect(ctx.go).not.toHaveBeenCalled();
  });
});
