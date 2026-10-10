// renderer/src/routes/OnboardingWizard.latch.test.tsx
//
// C1 回归锁（终审 Critical）：向导进行中创建 workspace（store.workspaces 变非空）
// 不得卸载向导——App 侧 wizardOpen 闩锁置于 workspaces 判空之前。
// 真 store + 真 App 链路（不单独渲染 WorkspaceStep——那是保真度缺口本尊）。
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { useWorkspaceStore } from '../stores/workspace.store';
import type { Workspace } from '../ipc/types';

vi.mock('./MainShell', () => ({
  MainShell: () => <div data-testid="main-shell" />,
}));

import { App } from '../App';
import { ipc } from '../ipc/client';

function mkWs(id: string): Workspace {
  return {
    id,
    name: `ws-${id}`,
    description: '',
    directoryPath: '/tmp/ws',
    gitInitialized: true,
    createdAt: '2026-01-01',
    ownerId: 'owner',
    iconEmoji: '📁',
    defaultAgentInstanceId: null,
  };
}

const mockApi = {
  workspace: {
    list: vi.fn(),
    create: vi.fn(),
    // 真 store.create 的 notifySwitch 会调 workspace.switch（缺 mock 即抛错）
    switch: vi.fn().mockResolvedValue(undefined),
  },
  dialog: { pickDirectory: vi.fn().mockResolvedValue(null) },
  session: {
    onMessage: vi.fn().mockReturnValue(() => {}),
    onMessageEventBatch: vi.fn().mockReturnValue(() => {}),
    onListChanged: vi.fn().mockReturnValue(() => {}),
  },
  system: {
    getPlatform: vi.fn().mockReturnValue('linux'),
    getUpgradeNotice: vi.fn().mockResolvedValue(null),
    dismissUpgradeNotice: vi.fn().mockResolvedValue(undefined),
  },
  window: {
    minimize: vi.fn(),
    toggleMaximize: vi.fn(),
    close: vi.fn(),
    isMaximized: vi.fn().mockResolvedValue(false),
    onMaximizedChanged: vi.fn().mockReturnValue(() => {}),
  },
  sandbox: {
    getState: vi.fn(),
    reprobe: vi.fn(),
    installBwrap: vi.fn(),
    dismissPrompt: vi.fn(),
    onWriteBlocked: vi.fn(() => () => {}),
  },
  task: { listInterrupted: vi.fn().mockResolvedValue([]) },
  browser: {
    getState: vi.fn(),
    setActiveSession: vi.fn().mockResolvedValue(undefined),
    onBrowserState: vi.fn().mockReturnValue(() => {}),
    onBrowserNotice: vi.fn().mockReturnValue(() => {}),
  },
  provider: {
    list: vi.fn().mockResolvedValue([]),
    listPresets: vi.fn().mockResolvedValue([]),
    listModels: vi.fn().mockResolvedValue([]),
    create: vi.fn(),
    testConnection: vi.fn(),
  },
  onboarding: {
    getStatus: vi.fn(),
    markDone: vi.fn().mockResolvedValue(undefined),
    generatePlan: vi.fn(),
    applyPlan: vi.fn(),
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  (globalThis as unknown as { window: { api: typeof mockApi } }).window.api = mockApi;
  mockApi.workspace.list.mockResolvedValue([]);
  mockApi.workspace.create.mockResolvedValue(mkWs('ws-new'));
  mockApi.onboarding.getStatus.mockResolvedValue({ status: 'pending' });
  mockApi.system.getUpgradeNotice.mockResolvedValue(null);
  mockApi.task.listInterrupted.mockResolvedValue([]);
  useWorkspaceStore.setState({ workspaces: [], activeWorkspaceId: null });
});

describe('C1 回归：向导闩锁（spec 2026-10-10 §3——向导进行期不被 ws 创建卸载）', () => {
  it('向导挂载后 store.create 写入 workspace → 向导仍在（不进 MainShell）', async () => {
    render(<App />);
    // 向导挂载（pending + 空 ws）
    expect(await screen.findByRole('button', { name: /AI 引导/ })).toBeInTheDocument();

    // 模拟第③步创建成功：真 store.create（走 mockApi.workspace.create）
    await useWorkspaceStore.getState().create({ name: '闩锁测试', directoryPath: '/tmp/ws' });

    // C1 断言：workspaces 已非空但向导不卸载（闩锁生效），MainShell 不出现
    await waitFor(() => {
      expect(useWorkspaceStore.getState().workspaces.length).toBe(1);
    });
    expect(screen.getByRole('button', { name: /AI 引导/ })).toBeInTheDocument();
    expect(screen.queryByTestId('main-shell')).not.toBeInTheDocument();
  });

  it('跳过收尾：markDone(skipped) 后闩锁释放 → 落回原空态（不回向导）', async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '跳过引导' }));
    // 完成回调触发 obCheck 重拉：getStatus 此时回 skipped（第二次调用起）
    mockApi.onboarding.getStatus.mockResolvedValue({ status: 'skipped' });
    mockApi.workspace.list.mockResolvedValue([]);
    await waitFor(
      () => {
        expect(screen.getByRole('heading', { name: '新建工作空间' })).toBeInTheDocument();
      },
      { timeout: 3000 },
    );
    expect(screen.queryByRole('button', { name: /AI 引导/ })).not.toBeInTheDocument();
  });
});
