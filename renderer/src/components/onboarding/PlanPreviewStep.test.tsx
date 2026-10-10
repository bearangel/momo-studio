// renderer/src/components/onboarding/PlanPreviewStep.test.tsx
//
// 方案预览步测试（spec 2026-10-10 §8）：卡片渲染 / 勾选联动与全取消禁用 /
// 默认单选收缩回退 / 警告区 / applyPlan 失败转手动 / 成功推进 done。
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { WizardCtx } from '../../routes/OnboardingWizard';
import type { OnboardingPlan } from '../../ipc/types';

const mockApply = vi.fn();

vi.mock('../../ipc/client', () => ({
  ipc: {
    onboarding: {
      generatePlan: vi.fn(),
      applyPlan: (...a: unknown[]) => mockApply(...a),
      markDone: vi.fn(),
      getStatus: vi.fn(),
    },
  },
}));

import { PlanPreviewStep } from './PlanPreviewStep';

const PLAN: OnboardingPlan = {
  agents: [
    { kind: 'preset', slug: 'coder', reason: '写代码', mcps: ['filesystem'], skills: [] },
    {
      kind: 'custom',
      name: '测试工程师',
      iconEmoji: '🧪',
      systemPrompt: '你是测试工程师',
      toolPreset: 'standard',
      reason: '补位',
      mcps: [],
      skills: ['doc-writer'],
    },
  ],
  defaultAgentIndex: 0,
};

function mkCtx(plan: OnboardingPlan, warnings: string[] = []): WizardCtx {
  return {
    route: 'ai',
    providerId: 'p1',
    modelId: 'glm-5.3',
    workspaceId: 'ws-1',
    plan,
    planWarnings: warnings,
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
  applied: [{ name: '程序员', kind: 'preset' as const, instanceId: 'i1' }],
  warnings: [],
  defaultAgentName: '程序员',
};

beforeEach(() => {
  vi.clearAllMocks();
  mockApply.mockResolvedValue(APPLY_RESULT);
});

describe('PlanPreviewStep', () => {
  it('渲染方案卡：agent 名 + 来源徽标 + reason + 挂载标签', async () => {
    render(<PlanPreviewStep ctx={mkCtx(PLAN)} />);
    expect(await screen.findByText('程序员')).toBeInTheDocument();
    expect(screen.getByText('预制')).toBeInTheDocument();
    expect(screen.getByText('测试工程师')).toBeInTheDocument();
    expect(screen.getByText('自定义')).toBeInTheDocument();
    expect(screen.getByText(/写代码/)).toBeInTheDocument();
    expect(screen.getByText(/MCP · filesystem/)).toBeInTheDocument();
    expect(screen.getByText(/Skill · doc-writer/)).toBeInTheDocument();
  });

  it('plan 为空防御：提示并返回需求步', async () => {
    const ctx = mkCtx(PLAN);
    (ctx as unknown as { plan: null }).plan = null;
    render(<PlanPreviewStep ctx={ctx} />);
    expect(await screen.findByText(/暂无方案/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /返回需求描述/ }));
    expect(ctx.go).toHaveBeenCalledWith('requirement');
  });

  it('取消全部勾选 → 应用按钮禁用；默认单选随勾选收缩回退', async () => {
    render(<PlanPreviewStep ctx={mkCtx(PLAN)} />);
    // coder 卡默认勾选且为默认；先取消第二张卡，再取消第一张
    const checks = screen.getAllByRole('checkbox');
    expect(checks.length).toBe(2);
    fireEvent.click(checks[1]!);
    fireEvent.click(checks[0]!);
    const btn = screen.getByRole('button', { name: /应用配置/ }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it('警告区渲染生成侧 warnings', async () => {
    render(<PlanPreviewStep ctx={mkCtx(PLAN, ['MCP「x」未注册，已剔除'])} />);
    expect(await screen.findByText(/MCP「x」未注册/)).toBeInTheDocument();
  });

  it('applyPlan 成功 → setApplyResult + go(done)；plan 剔除未勾选项', async () => {
    const ctx = mkCtx(PLAN);
    render(<PlanPreviewStep ctx={ctx} />);
    const checks = screen.getAllByRole('checkbox');
    fireEvent.click(checks[1]!); // 取消第二张
    fireEvent.click(screen.getByRole('button', { name: /应用配置/ }));
    await waitFor(() =>
      expect(mockApply).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceId: 'ws-1',
          providerId: 'p1',
          modelId: 'glm-5.3',
          plan: expect.objectContaining({
            agents: [PLAN.agents[0]],
            defaultAgentIndex: 0,
          }),
        }),
      ),
    );
    await waitFor(() => expect(ctx.setApplyResult).toHaveBeenCalledWith(APPLY_RESULT));
    expect(ctx.go).toHaveBeenCalledWith('done');
  });

  it('applyPlan 失败（部分失败）→ 错误卡 + 重试 + 转手动', async () => {
    const ctx = mkCtx(PLAN);
    mockApply.mockRejectedValueOnce(new Error('启用失败：供应商不存在'));
    render(<PlanPreviewStep ctx={ctx} />);
    fireEvent.click(screen.getByRole('button', { name: /应用配置/ }));
    expect(await screen.findByText(/启用失败/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /重试/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /转手动配置/ }));
    expect(ctx.toManual).toHaveBeenCalled();
  });
});
