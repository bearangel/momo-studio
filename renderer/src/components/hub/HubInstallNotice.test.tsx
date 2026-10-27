// renderer/src/components/hub/HubInstallNotice.test.tsx
//
// P2-7 补装进度通知面契约：MainShell 挂载一次，订阅 store 渲染右下角补装条——
// downloading（spinner + 字节进度，无总量时只显已收）/ extracting（解压中）/
// done（完成）/ failed（失败 + 人话 message，title 全文）。空态零渲染。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { HubInstallNotice } from './HubInstallNotice';
import { __resetHubInstallProgressForTest, useHubInstallProgressStore } from '../../stores/hub-install-progress.store';
import type { HubInstallProgressEvent } from '../../ipc/types';

const onInstallProgress = vi.fn<(cb: (e: HubInstallProgressEvent) => void) => () => void>();
const disposer = vi.fn();

const api = {
  hub: {
    onInstallProgress: onInstallProgress.mockImplementation(() => disposer),
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  // 组件测试保留 jsdom window（整窗替换会毁掉 document/Element——client.ts 只读 window.api）
  (globalThis as unknown as { window: { api: typeof api } }).window.api = api;
  __resetHubInstallProgressForTest();
});

afterEach(cleanup);

function setEntry(e: HubInstallProgressEvent): void {
  useHubInstallProgressStore.setState({ entries: { [`${e.type}:${e.slug}`]: e } });
}

describe('HubInstallNotice 订阅生命周期', () => {
  it('挂载即订阅 onInstallProgress，卸载即退订', () => {
    const { unmount } = render(<HubInstallNotice />);
    expect(onInstallProgress).toHaveBeenCalledTimes(1);
    unmount();
    expect(disposer).toHaveBeenCalledTimes(1);
  });

  it('空态零渲染（无补装不打扰）', () => {
    const { container } = render(<HubInstallNotice />);
    expect(container.querySelector('[data-testid="hub-install-notice"]')).toBeNull();
  });
});

describe('HubInstallNotice 四态渲染', () => {
  it('downloading：spinner + 字节进度（已收 / 总量，MB 一位小数）', () => {
    setEntry({
      stage: 'downloading',
      type: 'plugin',
      slug: 'codegraph',
      receivedBytes: 5_242_880,
      totalBytes: 58_720_256,
    });
    render(<HubInstallNotice />);
    expect(screen.getByText('补装 codegraph')).toBeInTheDocument();
    expect(screen.getByText(/下载中 5.0 MB \/ 56.0 MB/)).toBeInTheDocument();
  });

  it('downloading 无总量（Content-Length 缺失）：只显已收字节', () => {
    setEntry({ stage: 'downloading', type: 'skill', slug: 'big-skill', receivedBytes: 2048, totalBytes: null });
    render(<HubInstallNotice />);
    expect(screen.getByText(/下载中 2.0 KB/)).toBeInTheDocument();
  });

  it('extracting：解压中', () => {
    setEntry({ stage: 'extracting', type: 'plugin', slug: 'codegraph' });
    render(<HubInstallNotice />);
    expect(screen.getByText(/解压中/)).toBeInTheDocument();
  });

  it('done：完成态', () => {
    setEntry({ stage: 'done', type: 'agent', slug: 'reviewer' });
    render(<HubInstallNotice />);
    expect(screen.getByText('补装 reviewer')).toBeInTheDocument();
    expect(screen.getByText(/：完成/)).toBeInTheDocument();
  });

  it('failed：失败 + 人话 message（title 悬浮全文）', () => {
    setEntry({ stage: 'failed', type: 'mcp', slug: 'weather', message: '下载失败: HTTP 401（鉴权失败：hub 凭证缺失或已失效，请检查 hub 接入配置）' });
    render(<HubInstallNotice />);
    expect(screen.getByText(/：失败/)).toBeInTheDocument();
    const line = screen.getByText(/下载失败: HTTP 401/);
    expect(line).toBeInTheDocument();
    expect(line.closest('p')?.getAttribute('title')).toContain('请检查 hub 接入配置');
  });

  it('多条并行补装同时在场（镜像多资源形态）', () => {
    useHubInstallProgressStore.setState({
      entries: {
        'skill:a': { stage: 'downloading', type: 'skill', slug: 'a', receivedBytes: 10, totalBytes: null },
        'plugin:b': { stage: 'extracting', type: 'plugin', slug: 'b' },
      },
    });
    render(<HubInstallNotice />);
    expect(screen.getByText('补装 a')).toBeInTheDocument();
    expect(screen.getByText('补装 b')).toBeInTheDocument();
  });
});
