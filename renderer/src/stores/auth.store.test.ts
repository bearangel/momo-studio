// renderer/src/stores/auth.store.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useAuthStore } from './auth.store';

// Mock window.api before importing
const mockApi = {
  auth: {
    register: vi.fn().mockResolvedValue({ userId: '@alice:localhost', deviceId: 'DEV' }),
    login: vi.fn().mockResolvedValue({ userId: '@alice:localhost', deviceId: 'DEV' }),
    getCurrentUser: vi.fn().mockResolvedValue(null),
    logout: vi.fn().mockResolvedValue(undefined),
  },
  system: { getInfo: vi.fn(), getConduitStatus: vi.fn() },
};

beforeEach(() => {
  Object.assign(globalThis, { window: { api: mockApi } });
  mockApi.auth.getCurrentUser.mockResolvedValue(null);
  useAuthStore.getState().reset();
});

describe('auth.store', () => {
  it('starts in unknown status', () => {
    expect(useAuthStore.getState().status).toBe('unknown');
  });

  it('loadCurrent moves to unauthenticated when no current user', async () => {
    await useAuthStore.getState().loadCurrent();
    expect(useAuthStore.getState().status).toBe('unauthenticated');
  });

  it('register sets authenticated', async () => {
    await useAuthStore.getState().register({ username: 'alice', password: 'pass' });
    expect(useAuthStore.getState().status).toBe('authenticated');
    expect(useAuthStore.getState().user?.userId).toBe('@alice:localhost');
  });

  it('logout moves to unauthenticated', async () => {
    await useAuthStore.getState().register({ username: 'alice', password: 'pass' });
    await useAuthStore.getState().logout();
    expect(useAuthStore.getState().status).toBe('unauthenticated');
  });
});
