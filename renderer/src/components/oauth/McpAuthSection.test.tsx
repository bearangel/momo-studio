// renderer/src/components/oauth/McpAuthSection.test.tsx
//
// MCP 认证区块测试（预览 v2 区块 D 契约）：未绑定态（stdio 缺环境变量名禁授权）、
// 授权发起（beginAuthorizationForMcp + AuthorizeDialog 挂载开浏览器）、
// 已绑定态（连接信息 + 共享提示 + 解除绑定）、撤销授权两步确认
// （disconnect 取影响面 → 确认后 unbindMcp）。
// Mock 方式遵循 McpConfigDialog.test 既有形态：真实 ipc/client Proxy 上装 window.api 桩。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { McpAuthSection } from './McpAuthSection';

const listConnections = vi.fn();
const listBoundMcps = vi.fn();
const beginAuthorizationForMcp = vi.fn();
const unbindMcp = vi.fn();
const disconnect = vi.fn();
const mockApi = { oauth: { listConnections, listBoundMcps, beginAuthorizationForMcp, unbindMcp, disconnect } };

beforeEach(() => {
  vi.clearAllMocks();
  (globalThis as unknown as { window: { api: typeof mockApi } }).window.api = mockApi;
  listConnections.mockResolvedValue([
    { id: 'c1', displayName: 'GitHub', accountLabel: 'bearangel', status: 'connected', scopes: '', expiresAt: null, source: 'mcp' },
  ]);
  listBoundMcps.mockResolvedValue(['gh', 'gh-mirror']);
});

describe('McpAuthSection（v2：授权管理点）', () => {
  it('未绑定时展示「授权」，stdio 未填环境变量名则禁用并提示', () => {
    render(<McpAuthSection mcpName="local" transport="stdio" connectionId={undefined} envVar={undefined} onChange={vi.fn()} />);
    expect(screen.getByText('未绑定 OAuth 连接')).toBeTruthy();
    expect(screen.getByText('请先填写注入的环境变量名')).toBeTruthy();
    expect(screen.getByRole('button', { name: '授权' })).toBeDisabled();
  });

  it('点击授权发起 beginAuthorizationForMcp 并挂载 AuthorizeDialog（打开浏览器）', async () => {
    const openExternal = vi.fn().mockResolvedValue(undefined);
    const onAuthorizationChanged = vi.fn(() => () => undefined);
    (globalThis as unknown as { window: { api: unknown } }).window.api = {
      ...mockApi, misc: { openExternal }, oauth: { ...mockApi.oauth, onAuthorizationChanged },
    };
    beginAuthorizationForMcp.mockResolvedValue({
      pendingId: 'p1',
      authorizationUrl: 'https://auth.example.com/authorize?x=1',
      redirectUri: 'http://127.0.0.1:51789/callback',
      existingConnectionId: null,
    });
    render(<McpAuthSection mcpName="gh" transport="streamable_http" connectionId={undefined} envVar={undefined} onChange={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '授权' }));
    await waitFor(() => expect(beginAuthorizationForMcp).toHaveBeenCalledWith('gh', null));
    await waitFor(() => expect(openExternal).toHaveBeenCalled());
  });

  it('已绑定时显示连接信息 + 共享提示 + 解除绑定/撤销授权', async () => {
    unbindMcp.mockResolvedValue(undefined);
    render(<McpAuthSection mcpName="gh" transport="streamable_http" connectionId="c1" envVar={undefined} onChange={vi.fn()} />);
    expect(await screen.findByText(/GitHub/)).toBeTruthy();
    expect(screen.getByText(/此授权也被 1 个其他服务器使用/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '解除绑定' }));
    await waitFor(() => expect(unbindMcp).toHaveBeenCalledWith('gh'));
  });

  it('撤销授权先取影响面，确认后 disconnect + unbind', async () => {
    disconnect.mockResolvedValue({ affectedMcpNames: ['gh', 'gh-mirror'] });
    unbindMcp.mockResolvedValue(undefined);
    const onAuthorized = vi.fn();
    render(<McpAuthSection mcpName="gh" transport="streamable_http" connectionId="c1" envVar={undefined} onChange={vi.fn()} onAuthorized={onAuthorized} />);
    fireEvent.click(await screen.findByText('撤销授权…'));
    expect(await screen.findByText(/gh、gh-mirror/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '确认撤销' }));
    await waitFor(() => expect(disconnect).toHaveBeenCalledWith('c1'));
    await waitFor(() => expect(unbindMcp).toHaveBeenCalledWith('gh'));
  });
});
