// renderer/src/components/settings/About.test.tsx
//
// 关于面板行为测试（P2 Task 7）：
// - 挂载 → ipc.system.getInfo() 拉版本信息卡
// - 渲染应用版本/平台/架构/Node 版本四字段
// - 加载阶段显示「加载中...」
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { About } from './About';
import type { SystemInfo } from '../../ipc/types';

const getInfoMock = vi.fn();
const mockApi = { system: { getInfo: getInfoMock, getPlatform: () => 'darwin' } };
(globalThis as unknown as { window: { api: typeof mockApi } }).window.api = mockApi;

const STUB_INFO: SystemInfo = {
  platform: 'darwin',
  arch: 'arm64',
  nodeVersion: 'v20.20.2',
  appVersion: '2.0.0-p2',
  userDataDir: '/Users/test/.momo-studio',
};

describe('About', () => {
  beforeEach(() => {
    getInfoMock.mockReset();
  });

  it('挂载时显示「加载中...」', () => {
    getInfoMock.mockReturnValue(new Promise(() => {}));
    render(<About />);
    expect(screen.getByText('加载中...')).toBeInTheDocument();
  });

  it('加载完成后渲染应用版本/平台/架构/Node 版本四字段', async () => {
    getInfoMock.mockResolvedValue(STUB_INFO);
    render(<About />);
    await waitFor(() => expect(screen.getByText('2.0.0-p2')).toBeInTheDocument());
    expect(screen.getByText('darwin')).toBeInTheDocument();
    expect(screen.getByText('arm64')).toBeInTheDocument();
    expect(screen.getByText('v20.20.2')).toBeInTheDocument();
  });

  it('调用 ipc.system.getInfo 拉版本信息', async () => {
    getInfoMock.mockResolvedValue(STUB_INFO);
    render(<About />);
    await waitFor(() => expect(getInfoMock).toHaveBeenCalled());
  });
});