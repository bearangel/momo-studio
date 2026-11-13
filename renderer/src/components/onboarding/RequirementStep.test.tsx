// renderer/src/components/onboarding/RequirementStep.test.tsx
//
// AI 路线需求描述步测试（spec 2026-10-10 §8）：字数呈现 / 生成成功推进 /
// 失败错误卡（重试 + 转手动保成果）。
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { WizardCtx } from '../../routes/OnboardingWizard';

const mockGenerate = vi.fn();

vi.mock('../../ipc/client', () => ({
  ipc: {
    onboarding: {
      generatePlan: (...a: unknown[]) => mockGenerate(...a),
      applyPlan: vi.fn(),
      markDone: vi.fn(),
      getStatus: vi.fn(),
    },
  },
}));

import { RequirementStep } from './RequirementStep';

const PLAN = {
  agents: [
    { kind: 'preset' as const, slug: 'requirement-analyst', reason: 'r', mcps: [], skills: [] },
  ],
  defaultAgentIndex: 0,
};

function mkCtx(): WizardCtx {
  return {
    route: 'ai',
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

beforeEach(() => {
  vi.clearAllMocks();
});

describe('RequirementStep', () => {
  it('需求为空时生成按钮禁用；输入后启用并显示字数', async () => {
    render(<RequirementStep ctx={mkCtx()} />);
    const btn = (await screen.findByRole('button', { name: /生成配置方案/ })) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/工作需求/), { target: { value: '写周报' } });
    expect(screen.getByText(/3 \/ 4000/)).toBeInTheDocument();
    expect((screen.getByRole('button', { name: /生成配置方案/ }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('生成成功 → setPlan + setPlanWarnings + go(preview)', async () => {
    const ctx = mkCtx();
    mockGenerate.mockResolvedValue({ plan: PLAN, warnings: ['w1'] });
    render(<RequirementStep ctx={ctx} />);
    fireEvent.change(await screen.findByLabelText(/工作需求/), { target: { value: '需求分析' } });
    fireEvent.click(screen.getByRole('button', { name: /生成配置方案/ }));
    await waitFor(() =>
      expect(mockGenerate).toHaveBeenCalledWith({
        requirement: '需求分析',
        providerId: 'p1',
        modelId: 'glm-5.3',
      }),
    );
    await waitFor(() => expect(ctx.setPlan).toHaveBeenCalledWith(PLAN));
    expect(ctx.setPlanWarnings).toHaveBeenCalledWith(['w1']);
    expect(ctx.go).toHaveBeenCalledWith('preview');
  });

  it('生成失败 → 错误卡（原因 + 重试 + 转手动，转手动保成果直达 manualAgents）', async () => {
    const ctx = mkCtx();
    mockGenerate.mockRejectedValue(new Error('AI 生成超时（60s）'));
    render(<RequirementStep ctx={ctx} />);
    fireEvent.change(await screen.findByLabelText(/工作需求/), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: /生成配置方案/ }));
    expect(await screen.findByText(/AI 生成超时/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /转手动配置/ }));
    expect(ctx.toManual).toHaveBeenCalled();
    expect(ctx.go).not.toHaveBeenCalledWith('preview');
  });
});

describe('上一步目标（T4，spec 2026-11-13 §6——绕开 workspace 直通弹回）', () => {
  it('点「上一步」→ ctx.go("provider")（不回 workspace）', () => {
    const ctx = mkCtx();
    render(<RequirementStep ctx={ctx} />);
    fireEvent.click(screen.getByRole('button', { name: '上一步' }));
    expect(ctx.go).toHaveBeenCalledWith('provider');
  });
});

describe('等待体验（T5，spec 2026-11-13 §7）', () => {
  it('busy 期文案 8s 阶段轮换：分析需求 → 挑选 agent', async () => {
    vi.useFakeTimers();
    mockGenerate.mockReturnValue(new Promise(() => undefined)); // 永不 resolve
    try {
      render(<RequirementStep ctx={mkCtx()} />);
      fireEvent.change(screen.getByLabelText('工作需求'), {
        target: { value: '整理周报' },
      });
      fireEvent.click(screen.getByRole('button', { name: /生成配置方案/ }));
      // busy 即刻进入（React act 内同步刷新由 RTL 处理——用同步断言轮询）
      await vi.waitFor(() => {
        expect(screen.getByText(/正在分析你的需求/)).toBeInTheDocument();
      });
      await vi.advanceTimersByTimeAsync(8_000);
      expect(screen.getByText(/正在挑选合适的 agent/)).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('busy 期「转手动配置」可点，点击后立即 toManual；迟到成功结果被丢弃（不回 preview）', async () => {
    let resolvePlan!: (v: { plan: typeof PLAN; warnings: string[] }) => void;
    mockGenerate.mockReturnValue(
      new Promise((res) => {
        resolvePlan = res;
      }),
    );
    const ctx = mkCtx();
    render(<RequirementStep ctx={ctx} />);
    fireEvent.change(screen.getByLabelText('工作需求'), {
      target: { value: '整理周报' },
    });
    fireEvent.click(screen.getByRole('button', { name: /生成配置方案/ }));
    // 等待期出口在场且可点（不再等失败才给）
    const toManualBtn = await screen.findByRole('button', { name: '转手动配置' });
    expect(toManualBtn).toBeEnabled();
    fireEvent.click(toManualBtn);
    expect(ctx.toManual).toHaveBeenCalled();
    expect(ctx.go).not.toHaveBeenCalledWith('preview');
    // 迟到成功：静默丢弃——不得推进 preview / 写 plan
    resolvePlan({ plan: PLAN, warnings: [] });
    await waitFor(() => {
      expect(ctx.setPlan).not.toHaveBeenCalled();
      expect(ctx.go).not.toHaveBeenCalledWith('preview');
    });
  });
});
