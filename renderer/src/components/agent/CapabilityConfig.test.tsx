// renderer/src/components/agent/CapabilityConfig.test.tsx
//
// v1.6 Task 16：CapabilityConfig 顶部增强按钮测试。
// 新增两个可选 callback props，分别跳到 def 默认能力编辑（Layer 1）
// 和 per-assignment 能力覆盖（Layer 3）：
//   - onEditDefinition?: (defId: string) => void
//     仅当 agentDef 非空 + source !== 'builtin' + callback 提供 → 显示「编辑 def 默认能力」
//   - onAdjustAssignment?: (assignment: AgentAssignment) => void
//     仅当 activeAssignment 提供 + callback 提供 → 显示「调整本实例能力」
//
// 不破坏现有调用站点：未提供 callback 时两个按钮均不渲染。
//
// Mock 策略：window.api 注入 allocation 桩（load 调用）+ useCapabilityStore.setState 注入空 allocation。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CapabilityConfig } from './CapabilityConfig';
import { useCapabilityStore } from '../../stores/capability.store';
import type { AgentAssignment, AgentDefinition, WorkspaceAllocation } from '../../ipc/types';

// allocation.get/add/remove 在 CapabilityConfig 挂载与 L2 增删时被触发
const allocationGet = vi.fn();
const allocationAdd = vi.fn();
const allocationRemove = vi.fn();
const mockApi = {
  allocation: { get: allocationGet, add: allocationAdd, remove: allocationRemove },
};

beforeEach(() => {
  allocationGet.mockReset();
  allocationAdd.mockReset();
  allocationRemove.mockReset();
  allocationGet.mockResolvedValue({
    workspaceId: 'ws-1',
    tools: [],
    mcps: [],
    skills: [],
  } satisfies WorkspaceAllocation);
  allocationAdd.mockResolvedValue(undefined);
  allocationRemove.mockResolvedValue(undefined);
  (globalThis as unknown as { window: { api: typeof mockApi } }).window.api = mockApi;

  // 重置 store 状态，避免上一个 case 的 allocation 残留
  useCapabilityStore.setState({
    allocation: null,
    loading: false,
    error: null,
  });
});

function buildDef(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    id: 'def-1',
    name: '测试 agent',
    slug: 'test',
    version: '1.0.0',
    runtime: 'declarative',
    systemPrompt: '',
    defaultTools: [{ kind: 'builtin', ref: 'read_file' }],
    source: 'custom',
    description: '',
    iconEmoji: '🤖',
    defaultMcps: [],
    defaultSkills: [],
    workspaceId: null,
    modelProviderId: 'p1',
    modelName: 'm',
    ...overrides,
  };
}

function buildAssignment(overrides: Partial<AgentAssignment> = {}): AgentAssignment {
  return {
    instanceId: 'inst-1',
    workspaceId: 'ws-1',
    agentDefinitionId: 'def-1',
    agentUserId: '@bot:server',
    enabled: true,
    createdAt: '',
    role: 'standalone',
    parentInstanceId: null,
    hasApiKeyOverride: false,
    lastRunning: true,
    ...overrides,
  };
}

describe('CapabilityConfig — 「编辑 def 默认能力」按钮', () => {
  it('custom agent + callback 提供 → 显示「编辑 def 默认能力」按钮', async () => {
    const onEditDefinition = vi.fn();
    render(
      <CapabilityConfig
        workspaceId="ws-1"
        agentDef={buildDef()}
        onEditDefinition={onEditDefinition}
      />,
    );
    await waitFor(() => {
      expect(allocationGet).toHaveBeenCalledWith('ws-1');
    });
    expect(screen.getByRole('button', { name: '编辑 def 默认能力' })).toBeInTheDocument();
  });

  it('builtin agent 即使 callback 提供也不显示「编辑 def 默认能力」按钮', async () => {
    const onEditDefinition = vi.fn();
    render(
      <CapabilityConfig
        workspaceId="ws-1"
        agentDef={buildDef({ source: 'builtin' })}
        onEditDefinition={onEditDefinition}
      />,
    );
    await waitFor(() => {
      expect(allocationGet).toHaveBeenCalledWith('ws-1');
    });
    expect(screen.queryByRole('button', { name: '编辑 def 默认能力' })).not.toBeInTheDocument();
  });

  it('点击「编辑 def 默认能力」→ onEditDefinition 收到 def.id', async () => {
    const onEditDefinition = vi.fn();
    render(
      <CapabilityConfig
        workspaceId="ws-1"
        agentDef={buildDef({ id: 'def-xyz' })}
        onEditDefinition={onEditDefinition}
      />,
    );
    await waitFor(() => {
      expect(allocationGet).toHaveBeenCalledWith('ws-1');
    });
    fireEvent.click(screen.getByRole('button', { name: '编辑 def 默认能力' }));
    expect(onEditDefinition).toHaveBeenCalledTimes(1);
    expect(onEditDefinition).toHaveBeenCalledWith('def-xyz');
  });

  it('未提供 onEditDefinition → 不显示编辑按钮（向后兼容现有调用站点）', async () => {
    render(<CapabilityConfig workspaceId="ws-1" agentDef={buildDef()} />);
    await waitFor(() => {
      expect(allocationGet).toHaveBeenCalledWith('ws-1');
    });
    expect(screen.queryByRole('button', { name: '编辑 def 默认能力' })).not.toBeInTheDocument();
  });
});

describe('CapabilityConfig — 「调整本实例能力」按钮', () => {
  it('activeAssignment + callback 提供 → 显示「调整本实例能力」按钮', async () => {
    const onAdjustAssignment = vi.fn();
    render(
      <CapabilityConfig
        workspaceId="ws-1"
        agentDef={buildDef()}
        activeAssignment={buildAssignment()}
        onAdjustAssignment={onAdjustAssignment}
      />,
    );
    await waitFor(() => {
      expect(allocationGet).toHaveBeenCalledWith('ws-1');
    });
    expect(screen.getByRole('button', { name: '调整本实例能力' })).toBeInTheDocument();
  });

  it('builtin agent + activeAssignment + callback → 也显示「调整本实例能力」按钮', async () => {
    const onAdjustAssignment = vi.fn();
    render(
      <CapabilityConfig
        workspaceId="ws-1"
        agentDef={buildDef({ source: 'builtin' })}
        activeAssignment={buildAssignment()}
        onAdjustAssignment={onAdjustAssignment}
      />,
    );
    await waitFor(() => {
      expect(allocationGet).toHaveBeenCalledWith('ws-1');
    });
    expect(screen.getByRole('button', { name: '调整本实例能力' })).toBeInTheDocument();
  });

  it('点击「调整本实例能力」→ onAdjustAssignment 收到 assignment 对象', async () => {
    const onAdjustAssignment = vi.fn();
    const assignment = buildAssignment({ instanceId: 'inst-xyz' });
    render(
      <CapabilityConfig
        workspaceId="ws-1"
        agentDef={buildDef()}
        activeAssignment={assignment}
        onAdjustAssignment={onAdjustAssignment}
      />,
    );
    await waitFor(() => {
      expect(allocationGet).toHaveBeenCalledWith('ws-1');
    });
    fireEvent.click(screen.getByRole('button', { name: '调整本实例能力' }));
    expect(onAdjustAssignment).toHaveBeenCalledTimes(1);
    expect(onAdjustAssignment).toHaveBeenCalledWith(assignment);
  });

  it('未提供 activeAssignment → 不显示调整按钮', async () => {
    const onAdjustAssignment = vi.fn();
    render(
      <CapabilityConfig
        workspaceId="ws-1"
        agentDef={buildDef()}
        onAdjustAssignment={onAdjustAssignment}
      />,
    );
    await waitFor(() => {
      expect(allocationGet).toHaveBeenCalledWith('ws-1');
    });
    expect(screen.queryByRole('button', { name: '调整本实例能力' })).not.toBeInTheDocument();
  });

  it('未提供 onAdjustAssignment → 不显示调整按钮（即使 activeAssignment 提供）', async () => {
    render(
      <CapabilityConfig
        workspaceId="ws-1"
        agentDef={buildDef()}
        activeAssignment={buildAssignment()}
      />,
    );
    await waitFor(() => {
      expect(allocationGet).toHaveBeenCalledWith('ws-1');
    });
    expect(screen.queryByRole('button', { name: '调整本实例能力' })).not.toBeInTheDocument();
  });
});

describe('CapabilityConfig — Layer 2 工作空间共享能力增删', () => {
  it('无选中 agent 时仍渲染 Layer 2 增删输入框（保证 AgentsView 挂载场景可独立工作）', async () => {
    render(<CapabilityConfig workspaceId="ws-1" />);
    await waitFor(() => {
      expect(allocationGet).toHaveBeenCalledWith('ws-1');
    });
    // 三个类型分组各一个 input
    const inputs = screen.getAllByPlaceholderText(/添加 workspace 级/);
    expect(inputs).toHaveLength(3);
  });

  it('输入 ref 并提交 → 调用 allocation.add(workspaceId, type, ref)', async () => {
    render(<CapabilityConfig workspaceId="ws-1" />);
    await waitFor(() => {
      expect(allocationGet).toHaveBeenCalledWith('ws-1');
    });

    const toolInput = screen.getAllByPlaceholderText(/添加 workspace 级/)[0]!;
    fireEvent.change(toolInput, { target: { value: 'shell' } });
    fireEvent.submit(toolInput.closest('form')!);

    await waitFor(() => {
      expect(allocationAdd).toHaveBeenCalledWith('ws-1', 'tool', 'shell');
    });
  });

  it('点击 Layer 2 chip ✕ → 调用 allocation.remove(workspaceId, type, ref)', async () => {
    allocationGet.mockResolvedValue({
      workspaceId: 'ws-1',
      tools: ['shell'],
      mcps: [],
      skills: [],
    } satisfies WorkspaceAllocation);

    render(<CapabilityConfig workspaceId="ws-1" />);
    await waitFor(() => {
      expect(allocationGet).toHaveBeenCalledWith('ws-1');
    });

    fireEvent.click(screen.getByRole('button', { name: 'shell ✕' }));

    await waitFor(() => {
      expect(allocationRemove).toHaveBeenCalledWith('ws-1', 'tool', 'shell');
    });
  });
});
