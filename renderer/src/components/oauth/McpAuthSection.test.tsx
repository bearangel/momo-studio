// renderer/src/components/oauth/McpAuthSection.test.tsx
//
// MCP 认证区块测试（预览 v2 区块 D 契约）：未绑定态（stdio 缺环境变量名禁授权）、
// 授权发起（beginAuthorizationForMcp + AuthorizeDialog 挂载开浏览器）+ 同 tick
// 双击防抖、已绑定态（连接信息 + 共享提示 + 解除绑定）、撤销授权两步确认
// （确认前只读影响面不吊销；确认后 disconnect + unbind；取消两者皆不触发）、
// authorizationChanged connected 推送自愈绑定态。
// Mock 方式遵循 McpConfigDialog.test 既有形态：真实 ipc/client Proxy 上装 window.api 桩。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { McpAuthSection } from './McpAuthSection';
import type { AuthorizationChangedPayload } from '../../ipc/types';

const listConnections = vi.fn();
const listBoundMcps = vi.fn();
const beginAuthorizationForMcp = vi.fn();
const unbindMcp = vi.fn();
const disconnect = vi.fn();
const onAuthorizationChanged = vi.fn(() => () => undefined);
const mockApi = {
  oauth: { listConnections, listBoundMcps, beginAuthorizationForMcp, unbindMcp, disconnect, onAuthorizationChanged },
};

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
    const onAuthorizationChangedLocal = vi.fn(() => () => undefined);
    (globalThis as unknown as { window: { api: unknown } }).window.api = {
      ...mockApi, misc: { openExternal }, oauth: { ...mockApi.oauth, onAuthorizationChanged: onAuthorizationChangedLocal },
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

  it('授权按钮同 tick 双击只发一次 beginAuthorizationForMcp（防抖回归锁）', async () => {
    let resolveBegin: (v: unknown) => void = () => undefined;
    beginAuthorizationForMcp.mockImplementationOnce(
      () => new Promise((resolve) => { resolveBegin = resolve; }),
    );
    render(<McpAuthSection mcpName="gh" transport="streamable_http" connectionId={undefined} envVar={undefined} onChange={vi.fn()} />);
    const btn = screen.getByRole('button', { name: '授权' });
    fireEvent.click(btn);
    fireEvent.click(btn);
    expect(beginAuthorizationForMcp).toHaveBeenCalledTimes(1);
    resolveBegin({ pendingId: null, authorizationUrl: null, redirectUri: null, existingConnectionId: null });
    await waitFor(() => expect(screen.getByRole('button', { name: '授权' })).toBeEnabled());
  });

  it('已绑定时显示连接信息 + 共享提示 + 解除绑定/撤销授权', async () => {
    unbindMcp.mockResolvedValue(undefined);
    render(<McpAuthSection mcpName="gh" transport="streamable_http" connectionId="c1" envVar={undefined} onChange={vi.fn()} />);
    expect(await screen.findByText(/GitHub/)).toBeTruthy();
    expect(screen.getByText(/此授权也被 1 个其他服务器使用/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '解除绑定' }));
    await waitFor(() => expect(unbindMcp).toHaveBeenCalledWith('gh'));
  });

  it('撤销授权两步确认：确认前只读影响面不吊销，确认后 disconnect + unbind 各一次', async () => {
    disconnect.mockResolvedValue({ affectedMcpNames: ['gh', 'gh-mirror'] });
    unbindMcp.mockResolvedValue(undefined);
    const onAuthorized = vi.fn();
    render(<McpAuthSection mcpName="gh" transport="streamable_http" connectionId="c1" envVar={undefined} onChange={vi.fn()} onAuthorized={onAuthorized} />);
    fireEvent.click(await screen.findByText('撤销授权…'));
    expect(await screen.findByText(/gh、gh-mirror/)).toBeTruthy();
    // 影响面来自只读 listBoundMcps——确认前不得吊销令牌（disconnect 零调用）
    expect(listBoundMcps).toHaveBeenCalledWith('c1');
    expect(disconnect).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '确认撤销' }));
    await waitFor(() => expect(disconnect).toHaveBeenCalledWith('c1'));
    await waitFor(() => expect(unbindMcp).toHaveBeenCalledWith('gh'));
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(unbindMcp).toHaveBeenCalledTimes(1);
  });

  it('撤销授权点「取消」：不吊销、不解绑，回到已绑定视图（错误路径回归锁）', async () => {
    render(<McpAuthSection mcpName="gh" transport="streamable_http" connectionId="c1" envVar={undefined} onChange={vi.fn()} />);
    fireEvent.click(await screen.findByText('撤销授权…'));
    expect(await screen.findByText(/撤销将断开使用此授权的服务器/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(await screen.findByText(/GitHub/)).toBeTruthy();
    expect(disconnect).not.toHaveBeenCalled();
    expect(unbindMcp).not.toHaveBeenCalled();
  });

  it('authorizationChanged connected 推送自愈绑定态（无需父层改 prop）', async () => {
    let pushHandler: ((payload: AuthorizationChangedPayload) => void) | null = null;
    const onAuthorizationChangedCapture = vi.fn((cb: (payload: AuthorizationChangedPayload) => void) => {
      pushHandler = cb;
      return () => { pushHandler = null; };
    });
    (globalThis as unknown as { window: { api: unknown } }).window.api = {
      ...mockApi, oauth: { ...mockApi.oauth, onAuthorizationChanged: onAuthorizationChangedCapture },
    };
    render(<McpAuthSection mcpName="gh" transport="streamable_http" connectionId={undefined} envVar={undefined} onChange={vi.fn()} />);
    expect(await screen.findByText('未绑定 OAuth 连接')).toBeTruthy();
    expect(pushHandler).not.toBeNull();
    await act(async () => {
      pushHandler!({ pendingId: 'x', status: 'connected', connectionId: 'c1' });
    });
    expect(await screen.findByText(/GitHub/)).toBeTruthy();
    expect(screen.getByText('已连接')).toBeTruthy();
    expect(listConnections).toHaveBeenCalledTimes(2); // mount 一次 + 推送自愈重拉
  });
});
