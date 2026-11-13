// renderer/src/components/onboarding/DoneStep.test.tsx
//
// 完成页测试（spec 2026-10-10 §8）：摘要渲染（applyResult 缺省兜底）+
// 开始使用 → markDone({skipped:false}) + finish。
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { WizardCtx } from '../../routes/OnboardingWizard';

const mockMarkDone = vi.fn();
const mockCreateQuick = vi.fn();
const mockShowToast = vi.fn();

vi.mock('../../ipc/client', () => ({
  ipc: {
    onboarding: {
      markDone: (...a: unknown[]) => mockMarkDone(...a),
    },
  },
}));

// T3（spec 2026-11-13 §5）：mock 打在 store 模块（momo-test-rules——不 mock 两跳外的 ipc）
vi.mock('../../stores/session.store', () => ({
  useSessionStore: {
    getState: () => ({ createQuickSession: mockCreateQuick }),
  },
}));

vi.mock('../ui/Toast', async () => {
  const actual = await vi.importActual<typeof import('../ui/Toast')>('../ui/Toast');
  return { ...actual, showToast: (...a: unknown[]) => mockShowToast(...a) };
});

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

  it('验收补修（2026-11-02）：result 带 team → 渲染「已组建团队」行（名 + 队长）；无 team 不渲染', async () => {
    const withTeam = {
      ...APPLY_RESULT,
      team: { id: 't1', name: '引导测试团队', leaderName: '需求分析师' },
    };
    render(<DoneStep ctx={mkCtx(withTeam)} />);
    expect(await screen.findByText('已组建团队')).toBeInTheDocument();
    expect(screen.getByText(/引导测试团队 · 队长 需求分析师/)).toBeInTheDocument();
    // 无 team（单 agent 方案）→ 行不存在
    render(<DoneStep ctx={mkCtx(APPLY_RESULT)} />);
    expect(screen.getAllByText('已组建团队')).toHaveLength(1);
  });

  it('applyResult 缺省兜底（不崩溃，仅提示已配置）', async () => {
    render(<DoneStep ctx={mkCtx(null)} />);
    expect(await screen.findByText('一切就绪')).toBeInTheDocument();
  });

  it('开始使用 → markDone({skipped:false}) → createQuickSession(ctx.workspaceId) → finish（T3 终点直通）', async () => {
    mockCreateQuick.mockResolvedValue(true);
    const ctx = mkCtx(APPLY_RESULT);
    render(<DoneStep ctx={ctx} />);
    fireEvent.click(await screen.findByRole('button', { name: /开始使用/ }));
    await waitFor(() => expect(mockMarkDone).toHaveBeenCalledWith({ skipped: false }));
    await waitFor(() => expect(mockCreateQuick).toHaveBeenCalledWith('ws-1'));
    // 顺序：markDone → createQuickSession → finish
    expect(ctx.finish).toHaveBeenCalled();
    expect(mockShowToast).not.toHaveBeenCalled();
  });

  it('T3 降级：createQuickSession 失败 → toast 提示 + 不阻断 finish', async () => {
    mockCreateQuick.mockResolvedValue(false);
    const ctx = mkCtx(APPLY_RESULT);
    render(<DoneStep ctx={ctx} />);
    fireEvent.click(await screen.findByRole('button', { name: /开始使用/ }));
    await waitFor(() =>
      expect(mockShowToast).toHaveBeenCalledWith(
        expect.stringContaining('快速会话创建失败'),
      ),
    );
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

describe('T5 团队行说明小字（spec 2026-11-13 §7.2）', () => {
  it('团队行下有 @ 成员协作提示', async () => {
    const withTeam = {
      ...APPLY_RESULT,
      team: { id: 't1', name: 'T', leaderName: '需求分析师' },
    };
    render(<DoneStep ctx={mkCtx(withTeam)} />);
    expect(await screen.findByText(/@ 成员派发任务/)).toBeInTheDocument();
  });
});

describe('T-fix#4 开始使用防抖（Oracle Minor #4）', () => {
  it('点击后异步链进行中按钮禁用——双击不重复建会话', async () => {
    let resolveQuick!: (v: boolean) => void;
    mockCreateQuick.mockReturnValue(new Promise((res) => { resolveQuick = res; }));
    mockMarkDone.mockResolvedValue(undefined);
    const ctx = mkCtx(APPLY_RESULT);
    render(<DoneStep ctx={ctx} />);
    fireEvent.click(await screen.findByRole('button', { name: /开始使用/ }));
    // 异步链进行中：按钮转为禁用态（文案「正在进入…」）
    expect(screen.getByRole('button', { name: /正在进入/ })).toBeDisabled();
    resolveQuick(true);
    await waitFor(() => expect(ctx.finish).toHaveBeenCalled());
  });
});
