import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { Onboarding } from './Onboarding';
import { useAuthStore } from '../stores/auth.store';

const mockApi = {
  auth: {
    register: vi.fn().mockResolvedValue({ userId: '@alice:localhost', deviceId: 'DEV' }),
    login: vi.fn(),
    getCurrentUser: vi.fn().mockResolvedValue(null),
    logout: vi.fn(),
    onSessionExpired: vi.fn().mockReturnValue(() => {}),
  },
  system: { getInfo: vi.fn().mockResolvedValue({}), getConduitStatus: vi.fn().mockResolvedValue({}) },
};

beforeEach(() => {
  (globalThis as unknown as { window: { api: typeof mockApi } }).window.api = mockApi;
  useAuthStore.setState({ status: 'unknown', user: null, error: null, loading: false, wasAuthenticated: false });
  mockApi.auth.register.mockClear();
});

afterEach(() => { vi.useRealTimers(); });

describe('Onboarding', () => {
  it('首次使用显示欢迎页', () => {
    render(<Onboarding onComplete={() => {}} />);
    expect(screen.getByRole('heading', { name: /欢迎使用/ })).toBeInTheDocument();
  });

  it('从欢迎页推进到账号创建', () => {
    render(<Onboarding onComplete={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /开始使用/ }));
    expect(screen.getByRole('heading', { name: /选择模式/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /继续/ }));
    expect(screen.getByRole('heading', { name: /创建账号/ })).toBeInTheDocument();
  });

  it('填写表单提交注册', async () => {
    render(<Onboarding onComplete={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /开始使用/ }));
    fireEvent.click(screen.getByRole('button', { name: /继续/ }));

    const inputs = document.querySelectorAll('input');
    fireEvent.change(inputs[0]!, { target: { value: 'alice' } });
    fireEvent.change(inputs[1]!, { target: { value: 'password123' } });
    fireEvent.change(inputs[2]!, { target: { value: 'password123' } });
    fireEvent.click(screen.getByRole('button', { name: /创建账号/ }));

    await waitFor(() => {
      expect(mockApi.auth.register).toHaveBeenCalledWith({ username: 'alice', password: 'password123' });
    });
  });
});

describe('Onboarding 重新登录', () => {
  it('退出后直接显示登录页', () => {
    useAuthStore.setState({ wasAuthenticated: true });
    render(<Onboarding onComplete={() => {}} />);
    expect(screen.getByRole('heading', { name: '登录' })).toBeInTheDocument();
    expect(screen.queryByText(/欢迎使用/)).not.toBeInTheDocument();
  });
});
