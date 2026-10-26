// renderer/src/components/layout/MiddlePanel.test.tsx
//
// M2.1 D1 回归锁：
//   1. 0-ws 主区引导——!workspace 分支渲染 EmptyState 引导 + 内嵌创建表单
//      （自 App.tsx 首启空态迁入；创建流程 store 断言 = 原 App 级回归锁平移）
//   2. workgroups 视图不依赖工作空间——workspace 守卫之前分发（UC8 新设备
//      0 空间可达工作组，D1 主壳化的前置契约）
// 重型视图组件打桩（本文件聚焦分支分发，子组件行为由各自测试覆盖）。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { useWorkspaceStore } from '../../stores/workspace.store';
import { useUiStore } from '../../stores/ui.store';
import type { Workspace } from '../../ipc/types';

vi.mock('../editor/CodeEditor', () => ({ CodeEditor: () => <div data-testid="code-editor-stub" /> }));
vi.mock('../im/MessageList', () => ({ MessageList: () => <div /> }));
vi.mock('../im/MentionInput', () => ({ MentionInput: () => <div /> }));
vi.mock('../im/MembersPanel', () => ({ MembersPanel: () => <div /> }));
vi.mock('../im/InputToolbar', () => ({ InputToolbar: () => <div /> }));
vi.mock('../im/RoomToolBudgetBadge', () => ({ RoomToolBudgetBadge: () => <div /> }));
vi.mock('../im/ExportChatButton', () => ({ ExportChatButton: () => <div /> }));
vi.mock('../im/TaskProgressButton', () => ({ TaskProgressButton: () => <div /> }));
vi.mock('../im/InFlightPanel', () => ({ InFlightPanel: () => <div /> }));
vi.mock('../agent/AgentsView', () => ({ AgentsView: () => <div data-testid="agents-stub" /> }));
vi.mock('../settings/SettingsView', () => ({ SettingsView: () => <div /> }));
vi.mock('../resource-library/ResourceLibraryView', () => ({
  ResourceLibraryView: () => <div />,
}));
vi.mock('../task-board/TaskBoardView', () => ({ TaskBoardView: () => <div /> }));
vi.mock('../workgroup/WorkgroupView', () => ({
  WorkgroupView: () => <div data-testid="workgroup-view-stub" />,
}));
vi.mock('../workspace/BrowserSidebar', () => ({ BrowserSidebar: () => <div /> }));
vi.mock('../plugins/PanelPageView', () => ({ PanelPageView: () => <div /> }));

import { MiddlePanel } from './MiddlePanel';

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
    list: vi.fn().mockResolvedValue([]),
    create: vi.fn(),
  },
  dialog: {
    pickDirectory: vi.fn().mockResolvedValue('/tmp/picked'),
  },
};

beforeEach(() => {
  (globalThis as unknown as { window: { api: typeof mockApi } }).window.api = mockApi;
  mockApi.workspace.list.mockReset().mockResolvedValue([]);
  mockApi.workspace.create.mockReset();
  useWorkspaceStore.setState({ workspaces: [], activeWorkspaceId: null, closedIds: [] });
  useUiStore.setState({ activeView: 'im' });
});

function ui(): ReactElement {
  return <MiddlePanel />;
}

describe('MiddlePanel 0-ws 主区引导（D1：首启创建表单随主壳迁入）', () => {
  it('无 workspace → 引导文案 + 内嵌「新建工作空间」表单在场', () => {
    render(ui());
    expect(screen.getByText('创建或选择一个工作空间开始')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '新建工作空间' })).toBeInTheDocument();
  });

  it('创建成功 → store.workspaces 更新（主壳分支翻转到工作空间态的数据前提）', async () => {
    mockApi.workspace.create.mockResolvedValue(mkWs('w-new'));
    render(ui());

    const inputs = document.querySelectorAll('input');
    fireEvent.change(inputs[0]!, { target: { value: '我的项目' } });
    fireEvent.change(inputs[1]!, { target: { value: '/tmp/project' } });
    fireEvent.click(screen.getByRole('button', { name: '创建' }));

    await waitFor(() => {
      expect(mockApi.workspace.create).toHaveBeenCalledWith({
        name: '我的项目',
        directoryPath: '/tmp/project',
      });
    });
    await waitFor(() => {
      expect(useWorkspaceStore.getState().workspaces).toHaveLength(1);
      expect(useWorkspaceStore.getState().activeWorkspaceId).toBe('w-new');
    });
  });

  it('表单提交缺项 → 创建按钮禁用不触发 create（空输入守卫）', () => {
    render(ui());
    const submit = screen.getByRole('button', { name: '创建' });
    expect(submit).toBeDisabled();
    fireEvent.click(submit);
    expect(mockApi.workspace.create).not.toHaveBeenCalled();
  });
});

describe('MiddlePanel workgroups 视图独立于工作空间（D1 前置契约，UC8）', () => {
  it('无 workspace + workgroups 视图 → WorkgroupView 渲染（不被创建引导拦截）', () => {
    useUiStore.setState({ activeView: 'workgroups' });
    render(ui());
    expect(screen.getByTestId('workgroup-view-stub')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: '新建工作空间' })).not.toBeInTheDocument();
  });
});
