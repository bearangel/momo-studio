// renderer/src/routes/OnboardingWizard.test.tsx
//
// 向导骨架测试（spec 2026-10-10 §3/§8）：欢迎页路线选择 / 跳过写 kv /
// 路线分叉进入供应商步 / getStatus 失败容错不阻塞（Review Focus 5）。
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { OnboardingWizard } from './OnboardingWizard';
import { ipc } from '../ipc/client';

vi.mock('../ipc/client', () => ({
  ipc: {
    // TitleBar 渲染依赖：platform 同步判定 + 窗口态订阅
    system: {
      getPlatform: vi.fn(() => 'darwin'),
    },
    window: {
      isMaximized: vi.fn().mockResolvedValue(false),
      onMaximizedChanged: vi.fn(() => () => undefined),
    },
    // ProviderStep 挂载即拉供应商与预设（失败静默空列表）
    provider: {
      list: vi.fn().mockResolvedValue([]),
      listPresets: vi.fn().mockResolvedValue([]),
    },
    onboarding: {
      getStatus: vi.fn(),
      markDone: vi.fn().mockResolvedValue(undefined),
      generatePlan: vi.fn(),
      applyPlan: vi.fn(),
    },
  },
}));

const mocked = vi.mocked(ipc.onboarding);

beforeEach(() => {
  vi.clearAllMocks();
  mocked.getStatus.mockResolvedValue({ status: 'pending' });
});

describe('OnboardingWizard', () => {
  it('欢迎页呈现两条路线与跳过按钮', async () => {
    render(<OnboardingWizard onFinished={() => undefined} />);
    expect(await screen.findByRole('button', { name: /AI 引导/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /手动引导/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /跳过引导/ })).toBeInTheDocument();
  });

  it('点「跳过引导」→ markDone({skipped:true}) + onFinished', async () => {
    const onFinished = vi.fn();
    render(<OnboardingWizard onFinished={onFinished} />);
    fireEvent.click(await screen.findByRole('button', { name: /跳过引导/ }));
    await waitFor(() => expect(mocked.markDone).toHaveBeenCalledWith({ skipped: true }));
    expect(onFinished).toHaveBeenCalled();
  });

  it('I2 回归：跳过时 markDone 失败 → 行内中文错误，向导不关（onFinished 不调）', async () => {
    const onFinished = vi.fn();
    mocked.markDone.mockRejectedValueOnce(new Error('kv write failed'));
    render(<OnboardingWizard onFinished={onFinished} />);
    fireEvent.click(await screen.findByRole('button', { name: /跳过引导/ }));
    expect(await screen.findByText(/保存引导状态失败/)).toBeInTheDocument();
    expect(onFinished).not.toHaveBeenCalled();
    // 向导仍在（欢迎页按钮可见）
    expect(screen.getByRole('button', { name: /AI 引导/ })).toBeInTheDocument();
  });

  it('选择 AI 路线进入供应商步骤（第②步标题可见）', async () => {
    render(<OnboardingWizard onFinished={() => undefined} />);
    fireEvent.click(await screen.findByRole('button', { name: /AI 引导/ }));
    expect(await screen.findByText('配置模型服务')).toBeInTheDocument();
  });

  it('getStatus 失败 → 视为 pending 照常走向导，不崩溃（Review Focus 5）', async () => {
    mocked.getStatus.mockRejectedValue(new Error('ipc down'));
    render(<OnboardingWizard onFinished={() => undefined} />);
    expect(await screen.findByRole('button', { name: /AI 引导/ })).toBeInTheDocument();
  });
});
