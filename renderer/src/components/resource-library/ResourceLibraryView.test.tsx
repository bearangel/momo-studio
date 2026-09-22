// renderer/src/components/resource-library/ResourceLibraryView.test.tsx
//
// 资源库壳重写测试（spec §2.1 三页结构）：TypeSidebar 二级菜单 + TypePageShell 组合。
//   - 默认渲染 Agent 页（导航 landmark + 页标题「智能体」）
//   - 切 MCP 页：标题与「＋」按钮文案随类型切换
//   - MCP 页「＋」下拉三条路径（手动配置 / 粘贴 JSON / 网络获取）
//   - localStorage 持久化恢复上次激活页
//
// Mock 方式遵循 TypePageShell.test.tsx 既有形态：不 vi.mock ipc/client 模块，而是在
// 真实 jsdom window 上装 window.api 属性——ipc.client 是真实 Proxy，store 的 load 经
// 真通道走桩（momo-test-rules：mock 收窄到 IPC 边界）。vitest globals:false，显式导入。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ResourceLibraryView } from './ResourceLibraryView';
import { useResourceStore } from '../../stores/resource.store';
import type { AgentDefinition, ResourceItem } from '../../ipc/types';

// ---- mock IPC 桩（本壳测试只触达 resource / agent 两个命名空间）----
const resourceList = vi.fn();
const resourceInstall = vi.fn();
const resourceDelete = vi.fn();
const agentList = vi.fn();

const mockApi = {
  resource: { list: resourceList, install: resourceInstall, delete: resourceDelete },
  agent: { list: agentList },
};

beforeEach(() => {
  resourceList.mockReset().mockResolvedValue([] as ResourceItem[]);
  resourceInstall.mockReset().mockResolvedValue(undefined);
  resourceDelete.mockReset().mockResolvedValue(undefined);
  agentList.mockReset().mockResolvedValue([] as AgentDefinition[]);
  (globalThis as unknown as { window: { api: typeof mockApi } }).window.api = mockApi;

  localStorage.clear();
  useResourceStore.setState({
    items: [], loading: false, error: null, installNotice: null,
    typeFilter: 'agent', sourceFilter: 'all', query: '',
    activeType: 'agent', mode: 'installed',
  });
});

describe('ResourceLibraryView（三页壳）', () => {
  it('渲染二级侧边菜单与默认 Agent 页', () => {
    render(<ResourceLibraryView />);
    expect(screen.getByRole('navigation', { name: '资源类型' })).toBeTruthy();
    expect(screen.getByText('智能体')).toBeTruthy();
  });

  it('切到 MCP 页标题与添加按钮文案切换', () => {
    render(<ResourceLibraryView />);
    fireEvent.click(screen.getByRole('button', { name: /MCP/ }));
    expect(screen.getByText('MCP 服务器')).toBeTruthy();
    expect(screen.getByRole('button', { name: '＋ 添加服务器' })).toBeTruthy();
  });

  it('MCP 页下拉含三条路径（手动配置/粘贴 JSON/网络获取）', () => {
    render(<ResourceLibraryView />);
    fireEvent.click(screen.getByRole('button', { name: /MCP/ }));
    fireEvent.click(screen.getByRole('button', { name: '＋ 添加服务器' }));
    expect(screen.getByText('手动配置…')).toBeTruthy();
    expect(screen.getByText('粘贴 JSON…')).toBeTruthy();
    expect(screen.getByText('从网络获取…')).toBeTruthy();
  });

  it('持久化恢复上次激活页', () => {
    localStorage.setItem('momo.resourceLibrary.activeType', 'skill');
    useResourceStore.setState({ activeType: 'skill', typeFilter: 'skill' });
    render(<ResourceLibraryView />);
    expect(screen.getByText('技能')).toBeTruthy();
  });
});
