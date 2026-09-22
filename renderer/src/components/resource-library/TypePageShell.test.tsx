// renderer/src/components/resource-library/TypePageShell.test.tsx
//
// TypePageShell 行为（spec §2.1 页面骨架）：
//   - 工具栏：模式 Segmented（已安装|网络获取）+ 来源 chips（已安装模式专属）+ AddMenu
//   - 已安装空列表 → EmptyState 文案（按类型命名）
//   - 行点击选中 → 右侧详情面板挂载（「关闭详情」按钮出现）
//   - mode=registry → 渲染 RegistryBrowse（来源标注出现）
//
// Mock 方式遵循 ResourceLibraryView.test.tsx 既有形态（组件渲染测试变体）：不 vi.mock
// ipc/client 模块，而是在真实 jsdom window 上装 window.api 属性——ipc.client 是真实
// Proxy，registry 模式下 RegistryBrowse 经 Provider 走真通道；整窗替换（store 测试的
// window = {...} 写法）会抹掉 DOM 构造器导致 react-dom 崩溃（momo-test-rules：
// mock 收窄到 IPC 边界）。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TypePageShell } from './TypePageShell';
import { useResourceStore } from '../../stores/resource.store';
import type { ResourceItem } from '../../ipc/types';

const listMock = vi.fn();

const mockApi = {
  resource: {
    list: listMock,
  },
};

beforeEach(() => {
  listMock.mockReset();
  listMock.mockResolvedValue([] as ResourceItem[]);
  (globalThis as unknown as { window: { api: typeof mockApi } }).window.api = mockApi;

  useResourceStore.setState({
    items: [], loading: false, error: null, installNotice: null,
    typeFilter: 'mcp', sourceFilter: 'all', query: '',
    activeType: 'mcp', mode: 'installed',
  });
});

describe('TypePageShell', () => {
  it('工具栏含模式 Segmented（已安装|网络获取）、来源 chips、AddMenu', () => {
    render(
      <TypePageShell type="mcp" addItems={[]} onInstall={vi.fn()} onEditAgent={vi.fn()} onOpenPreset={vi.fn()} />,
    );
    expect(screen.getByRole('radio', { name: '已安装' })).toBeTruthy();
    expect(screen.getByRole('radio', { name: '网络获取' })).toBeTruthy();
    expect(screen.getByText('预置')).toBeTruthy();
    expect(screen.getByRole('button', { name: '＋ 添加服务器' })).toBeTruthy();
  });

  it('已安装空列表渲染 EmptyState 文案', () => {
    render(
      <TypePageShell type="mcp" addItems={[]} onInstall={vi.fn()} onEditAgent={vi.fn()} onOpenPreset={vi.fn()} />,
    );
    expect(screen.getByText('还没有 MCP 服务器')).toBeTruthy();
  });

  it('行点击选中后挂载详情面板', () => {
    useResourceStore.setState({
      items: [{
        id: 'custom-mcp-a', type: 'mcp', source: 'custom', slug: 'a', name: '甲',
        description: '', installed: true, installable: false, removable: true,
      }],
    });
    render(
      <TypePageShell type="mcp" addItems={[]} onInstall={vi.fn()} onEditAgent={vi.fn()} onOpenPreset={vi.fn()} />,
    );
    fireEvent.click(screen.getByText('甲'));
    expect(screen.getByLabelText('关闭详情')).toBeTruthy();
  });

  it('mode=registry 时渲染 RegistryBrowse（来源标注出现）', () => {
    useResourceStore.setState({ mode: 'registry' });
    render(
      <TypePageShell type="mcp" addItems={[]} onInstall={vi.fn()} onEditAgent={vi.fn()} onOpenPreset={vi.fn()} />,
    );
    expect(screen.getByText('来源：内置市场')).toBeTruthy();
  });

  // ── 终审 Important-1 回归锁：registry 模式安装反馈 ─────────────────────
  it('registry 模式下安装成功横幅可见（不再被 mode 门控）', () => {
    useResourceStore.setState({ mode: 'registry', installNotice: '已导入至「我的上传」' });
    render(
      <TypePageShell type="mcp" addItems={[]} onInstall={vi.fn()} onEditAgent={vi.fn()} onOpenPreset={vi.fn()} />,
    );
    expect(screen.getByTestId('install-notice')).toBeTruthy();
    expect(screen.getByText('已导入至「我的上传」')).toBeTruthy();
  });

  it('registry 模式下 store 错误行可见（安装失败反馈）', () => {
    useResourceStore.setState({ mode: 'registry', error: '导入失败：boom' });
    render(
      <TypePageShell type="mcp" addItems={[]} onInstall={vi.fn()} onEditAgent={vi.fn()} onOpenPreset={vi.fn()} />,
    );
    expect(screen.getByText('加载失败：导入失败：boom')).toBeTruthy();
  });
});
