// renderer/src/components/oauth/AuthorizeDialog.test.tsx
//
// 授权等待对话框行为测试（预览 v2 区块 C 契约）：挂载即开系统浏览器（幂等，
// 含 StrictMode 双挂载回归）、回调地址展示 + 复制（失败兜底文案）、手动粘贴
// 提交（成功 / 失败不关窗 / 取消后迟到结果不触发 onSuccess）、
// authorizationChanged 推送（connected → onSuccess；failed → 错误文案；
// 取消后推送不触发 onSuccess）、打开浏览器失败中文兜底、
// 取消 = cancelAuthorization + onClose。
import { StrictMode } from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { AuthorizeDialog } from './AuthorizeDialog';
import type { AuthorizationChangedPayload, OAuthConnectionView } from '../../ipc/types';

const openExternal = vi.fn().mockResolvedValue(undefined);
const completeWithManualCallback = vi.fn();
const cancelAuthorization = vi.fn().mockResolvedValue(undefined);
type ChangedHandler = (payload: AuthorizationChangedPayload) => void;
let changedHandler: ChangedHandler | null = null;
const onAuthorizationChanged = vi.fn((cb: ChangedHandler) => {
  changedHandler = cb;
  return () => {
    changedHandler = null;
  };
});

const mockApi = {
  misc: { openExternal },
  oauth: { completeWithManualCallback, cancelAuthorization, onAuthorizationChanged },
};

beforeEach(() => {
  vi.clearAllMocks();
  openExternal.mockResolvedValue(undefined);
  cancelAuthorization.mockResolvedValue(undefined);
  changedHandler = null;
  (globalThis as unknown as { window: { api: typeof mockApi } }).window.api = mockApi;
});

const PROPS = {
  pendingId: 'p-1',
  authorizationUrl: 'https://auth.example.com/authorize?x=1',
  redirectUri: 'http://127.0.0.1:51789/callback',
  onSuccess: vi.fn(),
  onClose: vi.fn(),
};

describe('AuthorizeDialog', () => {
  it('挂载即用系统浏览器打开授权页（幂等，仅一次）', async () => {
    render(<AuthorizeDialog {...PROPS} />);
    await waitFor(() => expect(openExternal).toHaveBeenCalledTimes(1));
    expect(openExternal).toHaveBeenCalledWith(PROPS.authorizationUrl);
  });

  it('展示可复制的回调地址与手动粘贴入口', async () => {
    render(<AuthorizeDialog {...PROPS} />);
    expect(screen.getByText(PROPS.redirectUri)).toBeTruthy();
    expect(screen.getByRole('button', { name: '复制回调地址' })).toBeTruthy();
    fireEvent.click(screen.getByText('无法自动回调？手动粘贴'));
    expect(screen.getByLabelText('粘贴浏览器地址栏的完整回调 URL（或仅 code）')).toBeTruthy();
  });

  it('手动粘贴提交走 completeWithManualCallback，成功回调 onSuccess', async () => {
    completeWithManualCallback.mockResolvedValue({
      id: 'c1',
      displayName: 'X',
      accountLabel: '',
      status: 'connected',
      scopes: '',
      expiresAt: null,
      source: 'manual',
    });
    render(<AuthorizeDialog {...PROPS} />);
    fireEvent.click(screen.getByText('无法自动回调？手动粘贴'));
    fireEvent.change(screen.getByLabelText('粘贴浏览器地址栏的完整回调 URL（或仅 code）'), {
      target: { value: `${PROPS.redirectUri}?code=abc&state=st` },
    });
    fireEvent.click(screen.getByRole('button', { name: '提交' }));
    await waitFor(() =>
      expect(completeWithManualCallback).toHaveBeenCalledWith({
        pendingId: 'p-1',
        input: `${PROPS.redirectUri}?code=abc&state=st`,
      }),
    );
    await waitFor(() => expect(PROPS.onSuccess).toHaveBeenCalled());
  });

  it('粘贴提交失败展示中文错误且弹窗不关', async () => {
    completeWithManualCallback.mockRejectedValue(new Error('state 校验失败，请重新发起授权'));
    render(<AuthorizeDialog {...PROPS} />);
    fireEvent.click(screen.getByText('无法自动回调？手动粘贴'));
    fireEvent.change(screen.getByLabelText('粘贴浏览器地址栏的完整回调 URL（或仅 code）'), {
      target: { value: 'bad-input' },
    });
    fireEvent.click(screen.getByRole('button', { name: '提交' }));
    expect(await screen.findByText('state 校验失败，请重新发起授权')).toBeTruthy();
    expect(PROPS.onSuccess).not.toHaveBeenCalled();
    expect(PROPS.onClose).not.toHaveBeenCalled();
  });

  it('收到本 pendingId 的 connected 推送 → onSuccess；failed → 显示错误', async () => {
    render(<AuthorizeDialog {...PROPS} />);
    changedHandler?.({ pendingId: 'p-1', status: 'connected', connectionId: 'c1' });
    await waitFor(() => expect(PROPS.onSuccess).toHaveBeenCalled());
  });

  it('收到本 pendingId 的 failed 推送 → 展示错误文案，弹窗不关', async () => {
    render(<AuthorizeDialog {...PROPS} />);
    changedHandler?.({
      pendingId: 'p-1',
      status: 'failed',
      error: { code: 'token_exchange_failed', message: '令牌交换失败，请重试' },
    });
    expect(await screen.findByText('令牌交换失败，请重试')).toBeTruthy();
    expect(PROPS.onSuccess).not.toHaveBeenCalled();
    expect(PROPS.onClose).not.toHaveBeenCalled();
  });

  it('非本 pendingId 的推送被忽略', () => {
    render(<AuthorizeDialog {...PROPS} />);
    changedHandler?.({ pendingId: 'p-other', status: 'connected', connectionId: 'c2' });
    expect(PROPS.onSuccess).not.toHaveBeenCalled();
  });

  it('取消 = cancelAuthorization + onClose', async () => {
    render(<AuthorizeDialog {...PROPS} />);
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    await waitFor(() => expect(cancelAuthorization).toHaveBeenCalledWith('p-1'));
    expect(PROPS.onClose).toHaveBeenCalled();
  });

  it('复制失败展示兜底文案「复制失败，请手动选中复制」', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('clipboard denied'));
    Object.assign(navigator, { clipboard: { writeText } });
    try {
      render(<AuthorizeDialog {...PROPS} />);
      fireEvent.click(screen.getByRole('button', { name: '复制回调地址' }));
      expect(await screen.findByText('复制失败，请手动选中复制')).toBeTruthy();
      expect(writeText).toHaveBeenCalledWith(PROPS.redirectUri);
    } finally {
      // jsdom 无原生 clipboard——测试注入的 stub 用完即删，不污染其他用例
      Object.assign(navigator, { clipboard: undefined });
    }
  });

  it('StrictMode 双挂载（setup→cleanup→setup 同闭包）仅打开一次浏览器', async () => {
    render(
      <StrictMode>
        <AuthorizeDialog {...PROPS} />
      </StrictMode>,
    );
    await waitFor(() => expect(openExternal).toHaveBeenCalled());
    // 再冲刷一拍微任务，确认没有迟到的第二次调用
    await act(async () => {});
    expect(openExternal).toHaveBeenCalledTimes(1);
  });

  it('打开浏览器失败展示中文兜底 + 原始错误', async () => {
    openExternal.mockRejectedValue(new Error('cannot open'));
    render(<AuthorizeDialog {...PROPS} />);
    expect(await screen.findByText('无法打开浏览器，请手动访问授权链接（cannot open）')).toBeTruthy();
  });

  it('提交在途时取消 → 迟到的成功结果不触发 onSuccess', async () => {
    let resolveSubmit: (view: OAuthConnectionView) => void = () => {};
    completeWithManualCallback.mockImplementation(
      () =>
        new Promise<OAuthConnectionView>((resolve) => {
          resolveSubmit = resolve;
        }),
    );
    render(<AuthorizeDialog {...PROPS} />);
    fireEvent.click(screen.getByText('无法自动回调？手动粘贴'));
    fireEvent.change(screen.getByLabelText('粘贴浏览器地址栏的完整回调 URL（或仅 code）'), {
      target: { value: `${PROPS.redirectUri}?code=abc&state=st` },
    });
    fireEvent.click(screen.getByRole('button', { name: '提交' }));
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    await waitFor(() => expect(PROPS.onClose).toHaveBeenCalled());
    resolveSubmit({
      id: 'c1',
      displayName: 'X',
      accountLabel: '',
      status: 'connected',
      scopes: '',
      expiresAt: null,
      source: 'manual',
    });
    await act(async () => {});
    expect(PROPS.onSuccess).not.toHaveBeenCalled();
    changedHandler?.({ pendingId: 'p-1', status: 'connected', connectionId: 'c1' });
    await act(async () => {});
    expect(PROPS.onSuccess).not.toHaveBeenCalled();
  });
});
