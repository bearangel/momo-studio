// renderer/src/components/oauth/AuthorizeDialog.test.tsx
//
// 授权等待对话框行为测试（预览 v2 区块 C 契约）：挂载即开系统浏览器（幂等）、
// 回调地址展示 + 复制（失败兜底文案）、手动粘贴提交（成功 / 失败不关窗）、
// authorizationChanged 推送（connected → onSuccess；failed → 错误文案）、
// 取消 = cancelAuthorization + onClose。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AuthorizeDialog } from './AuthorizeDialog';
import type { AuthorizationChangedPayload } from '../../ipc/types';

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
});
