// renderer/src/components/resource-library/DanglingRefsCard.test.tsx
//
// P2.2 Task 7：MCP 悬空引用提示卡测试（spec §6.3）。
// mount 拉一次 resource.danglingMcpRefs：
//   - 空数组 / 加载失败 / 加载中 → 不渲染（静默，spec §5.4 同语义）
//   - 非空 → 每条 ref 渲染：agent 名单（、连接）+ refName + 指引文案
//
// Mock 方式遵循 ResourceDetail.test.tsx 既有形态：真实 jsdom window 上装
// window.api 属性（momo-test-rules：mock 收窄到 IPC 边界）。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { DanglingRefsCard } from './DanglingRefsCard';

const danglingMcpRefsMock = vi.fn();

const mockApi = {
  resource: {
    danglingMcpRefs: danglingMcpRefsMock,
  },
};

beforeEach(() => {
  danglingMcpRefsMock.mockReset();
  danglingMcpRefsMock.mockResolvedValue([]);
  (globalThis as unknown as { window: { api: typeof mockApi } }).window.api = mockApi;
});

describe('DanglingRefsCard — 条件渲染', () => {
  it('空数组 → 不渲染', async () => {
    const { container } = render(<DanglingRefsCard />);
    await waitFor(() => expect(danglingMcpRefsMock).toHaveBeenCalled());
    expect(container.querySelector('[data-testid="dangling-refs-card"]')).toBeNull();
  });

  it('加载失败 → 不渲染（静默降级）', async () => {
    danglingMcpRefsMock.mockRejectedValueOnce(new Error('boom'));
    const { container } = render(<DanglingRefsCard />);
    await waitFor(() => expect(danglingMcpRefsMock).toHaveBeenCalled());
    expect(container.querySelector('[data-testid="dangling-refs-card"]')).toBeNull();
  });

  it('window.api 缺面（调用同步抛错）→ 不渲染（防御：既有测试桩未挂该命名空间）', () => {
    (globalThis as unknown as { window: { api: unknown } }).window.api = {};
    const { container } = render(<DanglingRefsCard />);
    expect(container.querySelector('[data-testid="dangling-refs-card"]')).toBeNull();
  });

  it('mount 拉一次（不重复请求）', async () => {
    render(<DanglingRefsCard />);
    await waitFor(() => expect(danglingMcpRefsMock).toHaveBeenCalledTimes(1));
  });
});

describe('DanglingRefsCard — 非空渲染', () => {
  it('渲染 refName + agent 名单（、连接）+ 指引文案', async () => {
    danglingMcpRefsMock.mockResolvedValueOnce([
      {
        refName: 'filesystem',
        agents: [
          { definitionId: 'def-1', name: '程序员' },
          { definitionId: 'def-2', name: '研究员' },
        ],
      },
    ]);
    render(<DanglingRefsCard />);
    expect(await screen.findByText('程序员、研究员 引用了未安装的 MCP：filesystem')).toBeInTheDocument();
    expect(
      screen.getByText('去 Smithery 搜索安装（注册名需与引用名一致），或编辑 agent 引用'),
    ).toBeInTheDocument();
  });

  it('多条悬空引用 → 各自渲染', async () => {
    danglingMcpRefsMock.mockResolvedValueOnce([
      { refName: 'filesystem', agents: [{ definitionId: 'def-1', name: '程序员' }] },
      { refName: 'github', agents: [{ definitionId: 'def-2', name: '研究员' }] },
    ]);
    render(<DanglingRefsCard />);
    expect(await screen.findByText('程序员 引用了未安装的 MCP：filesystem')).toBeInTheDocument();
    expect(screen.getByText('研究员 引用了未安装的 MCP：github')).toBeInTheDocument();
  });
});
