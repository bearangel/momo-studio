// renderer/src/components/onboarding/WorkspaceStep.test.tsx
//
// 工作空间步测试（spec 2026-10-10 §8）：复用 CreateWorkspaceDialog（含目录选择器），
// 创建成功后捕获 activeWorkspaceId → setWorkspace → 按路线分叉推进。
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import type { WizardCtx } from '../../routes/OnboardingWizard';
import { useWorkspaceStore } from '../../stores/workspace.store';

const mockCreate = vi.fn();

vi.mock('../../ipc/client', () => ({
  ipc: {
    workspace: {
      create: (...a: unknown[]) => mockCreate(...a),
    },
    dialog: {
      pickDirectory: vi.fn().mockResolvedValue(null),
    },
  },
}));

import { WorkspaceStep } from './WorkspaceStep';

function mkCtx(route: 'ai' | 'manual'): WizardCtx {
  return {
    route,
    providerId: 'p1',
    modelId: 'glm-5.3',
    workspaceId: '',
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
  mockCreate.mockResolvedValue({
    id: 'ws-1',
    name: '引导测试',
    directoryPath: '/tmp/ws',
    createdAt: '',
    defaultAgentInstanceId: null,
  });
  useWorkspaceStore.setState({ workspaces: [], activeWorkspaceId: null });
});

describe('WorkspaceStep', () => {
  it('渲染内嵌创建表单（含目录选择器按钮）', async () => {
    render(<WorkspaceStep ctx={mkCtx('ai')} />);
    expect(await screen.findByText('新建工作空间')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '选择目录' })).toBeInTheDocument();
  });

  it('I1 回归：已建 workspace 重进本步（上一步回退）→ 直通路线下一步，不卡死', async () => {
    const ctx = mkCtx('ai');
    (ctx as unknown as { workspaceId: string }).workspaceId = 'ws-1';
    render(<WorkspaceStep ctx={ctx} />);
    await waitFor(() => expect(ctx.go).toHaveBeenCalledWith('requirement'));
    // 手动路线分叉同样直通
    const ctx2 = mkCtx('manual');
    (ctx2 as unknown as { workspaceId: string }).workspaceId = 'ws-1';
    render(<WorkspaceStep ctx={ctx2} />);
    await waitFor(() => expect(ctx2.go).toHaveBeenCalledWith('manualAgents'));
  });

  it('AI 路线：创建成功 → setWorkspace(ws-1) + go(requirement)', async () => {
    const ctx = mkCtx('ai');
    render(<WorkspaceStep ctx={ctx} />);
    fireEvent.change(await screen.findByLabelText(/名称/), { target: { value: '我的工作区' } });
    fireEvent.change(screen.getByPlaceholderText('选择或输入目录路径'), {
      target: { value: '/tmp/ws' },
    });
    fireEvent.click(screen.getByRole('button', { name: '创建' }));
    await waitFor(() => expect(ctx.setWorkspace).toHaveBeenCalledWith('ws-1'));
    expect(ctx.go).toHaveBeenCalledWith('requirement');
  });

  it('手动路线：创建成功 → go(manualAgents)', async () => {
    const ctx = mkCtx('manual');
    render(<WorkspaceStep ctx={ctx} />);
    fireEvent.change(await screen.findByLabelText(/名称/), { target: { value: '手动工作区' } });
    fireEvent.change(screen.getByPlaceholderText('选择或输入目录路径'), {
      target: { value: '/tmp/ws2' },
    });
    fireEvent.click(screen.getByRole('button', { name: '创建' }));
    await waitFor(() => expect(ctx.go).toHaveBeenCalledWith('manualAgents'));
  });
});
