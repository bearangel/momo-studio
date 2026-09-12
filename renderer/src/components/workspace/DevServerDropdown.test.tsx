// renderer/src/components/workspace/DevServerDropdown.test.tsx
//
// DevServerDropdown 单元测试（v2.7 Task 8，spec §3.5）：
//   - 关闭时不探活；打开 → listDevServers 渲染存活项
//   - 点击项 → onPick(url) + 关闭
//   - 探活失败（reject）/ 空列表 → 「未发现开发服务器」
// mock 形态照抄 SandboxNotice.test.tsx（globalThis.window.api 桩）。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { DevServerDropdown } from './DevServerDropdown';

const listDevServersMock = vi.fn();

// 桩 window.api（browser 命名空间；组件经 ipc Proxy 透传消费）
const mockApi = {
  browser: {
    listDevServers: listDevServersMock,
  },
};
(globalThis as unknown as { window: { api: typeof mockApi } }).window.api = mockApi;

describe('DevServerDropdown（v2.7 Task 8）', () => {
  beforeEach(() => {
    listDevServersMock.mockReset();
  });

  it('关闭时不调 listDevServers（探活只在打开时发生）', () => {
    render(<DevServerDropdown onPick={vi.fn()} />);
    expect(screen.getByRole('button', { name: '开发服务器' })).toBeInTheDocument();
    expect(listDevServersMock).not.toHaveBeenCalled();
  });

  it('打开 → listDevServers 调用 + 渲染存活项', async () => {
    listDevServersMock.mockResolvedValue([
      { port: 5173, url: 'http://localhost:5173' },
      { port: 3000, url: 'http://localhost:3000' },
    ]);
    render(<DevServerDropdown onPick={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '开发服务器' }));
    await waitFor(() => expect(listDevServersMock).toHaveBeenCalledTimes(1));
    expect(screen.getByText('http://localhost:5173')).toBeInTheDocument();
    expect(screen.getByText('http://localhost:3000')).toBeInTheDocument();
  });

  it('点击存活项 → onPick(url) + 下拉关闭', async () => {
    listDevServersMock.mockResolvedValue([{ port: 5173, url: 'http://localhost:5173' }]);
    const onPick = vi.fn();
    render(<DevServerDropdown onPick={onPick} />);
    fireEvent.click(screen.getByRole('button', { name: '开发服务器' }));
    await waitFor(() => expect(screen.getByText('http://localhost:5173')).toBeInTheDocument());
    fireEvent.click(screen.getByText('http://localhost:5173'));
    expect(onPick).toHaveBeenCalledWith('http://localhost:5173');
    // 下拉关闭：列表项消失
    expect(screen.queryByText('http://localhost:5173')).not.toBeInTheDocument();
  });

  it('探活失败（reject）→ 显示「未发现开发服务器」（错误路径）', async () => {
    listDevServersMock.mockRejectedValue(new Error('probe 失败'));
    render(<DevServerDropdown onPick={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '开发服务器' }));
    await waitFor(() => {
      expect(screen.getByText('未发现开发服务器')).toBeInTheDocument();
    });
  });

  it('探活成功但空列表 → 同样显示「未发现开发服务器」（边界空值）', async () => {
    listDevServersMock.mockResolvedValue([]);
    render(<DevServerDropdown onPick={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '开发服务器' }));
    await waitFor(() => {
      expect(screen.getByText('未发现开发服务器')).toBeInTheDocument();
    });
  });

  it('再次打开重新探活（不缓存上次结果）', async () => {
    listDevServersMock.mockResolvedValue([{ port: 5173, url: 'http://localhost:5173' }]);
    render(<DevServerDropdown onPick={vi.fn()} />);
    const toggle = screen.getByRole('button', { name: '开发服务器' });
    fireEvent.click(toggle);
    await waitFor(() => expect(listDevServersMock).toHaveBeenCalledTimes(1));
    fireEvent.click(toggle); // 关闭
    fireEvent.click(toggle); // 再开
    await waitFor(() => expect(listDevServersMock).toHaveBeenCalledTimes(2));
  });
});
