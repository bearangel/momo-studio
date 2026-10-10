// renderer/src/components/onboarding/DoneStep.test.tsx
//
// 完成页测试（spec 2026-10-10 §8）：摘要渲染（applyResult 缺省兜底）+
// 开始使用 → markDone({skipped:false}) + finish。
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { WizardCtx } from '../../routes/OnboardingWizard';

const mockMarkDone = vi.fn();

vi.mock('../../ipc/client', () => ({
  ipc: {
    onboarding: {
      markDone: (...a: unknown[]) => mockMarkDone(...a),
    },
  },
}));

import { DoneStep } from './DoneStep';

function mkCtx(applyResult: WizardCtx['applyResult']): WizardCtx {
  return {
    route: 'manual',
    providerId: 'p1',
    modelId: 'glm-5.3',
    workspaceId: 'ws-1',
    plan: null,
    planWarnings: [],
    applyResult,
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
  mockMarkDone.mockResolvedValue(undefined);
});

describe('DoneStep', () => {
  it('渲染摘要：启用的 agent 列表 + 默认 agent 名', async () => {
    render(<DoneStep ctx={mkCtx(APPLY_RESULT)} />);
    expect(await screen.findByText('一切就绪')).toBeInTheDocument();
    expect(screen.getByText(/需求分析师 · 周报整理员/)).toBeInTheDocument();
    expect(screen.getByText('需求分析师')).toBeInTheDocument();
  });

  it('applyResult 缺省兜底（不崩溃，仅提示已配置）', async () => {
    render(<DoneStep ctx={mkCtx(null)} />);
    expect(await screen.findByText('一切就绪')).toBeInTheDocument();
  });

  it('开始使用 → markDone({skipped:false}) + finish', async () => {
    const ctx = mkCtx(APPLY_RESULT);
    render(<DoneStep ctx={ctx} />);
    fireEvent.click(await screen.findByRole('button', { name: /开始使用/ }));
    await waitFor(() => expect(mockMarkDone).toHaveBeenCalledWith({ skipped: false }));
    expect(ctx.finish).toHaveBeenCalled();
  });

  it('I2 回归：markDone 失败 → 行内中文错误呈现，向导不关（finish 不调）', async () => {
    const ctx = mkCtx(APPLY_RESULT);
    mockMarkDone.mockRejectedValueOnce(new Error('kv write failed'));
    render(<DoneStep ctx={ctx} />);
    fireEvent.click(await screen.findByRole('button', { name: /开始使用/ }));
    expect(await screen.findByText(/保存引导状态失败/)).toBeInTheDocument();
    expect(ctx.finish).not.toHaveBeenCalled();
  });
});
