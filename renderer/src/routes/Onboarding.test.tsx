// renderer/src/routes/Onboarding.test.tsx
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
  },
  system: { getInfo: vi.fn().mockResolvedValue({}), getConduitStatus: vi.fn().mockResolvedValue({}) },
};

beforeEach(() => {
  // Assigning `api` to globalThis.window replaces the jsdom window object,
  // which breaks React DOM's internal instanceof checks. Mutate it instead.
  (globalThis as unknown as { window: { api: typeof mockApi } }).window.api = mockApi;
  useAuthStore.getState().reset();
  mockApi.auth.register.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Onboarding', () => {
  it('renders welcome step first', () => {
    render(<Onboarding onComplete={() => {}} />);
    expect(screen.getByText(/welcome/i)).toBeInTheDocument();
  });

  it('advances through steps to account setup', async () => {
    const onComplete = vi.fn();
    render(<Onboarding onComplete={onComplete} />);

    // Welcome → Mode
    fireEvent.click(screen.getByRole('button', { name: /get started/i }));
    expect(await screen.findByText(/choose mode/i)).toBeInTheDocument();

    // Mode → Account (select standalone)
    fireEvent.click(screen.getByRole('button', { name: /standalone/i }));
    fireEvent.click(screen.getByRole('button', { name: /next|continue/i }));
    expect(await screen.findByLabelText(/username/i)).toBeInTheDocument();

    // Account → Complete. Use anchored regex so /password/i doesn't match "Confirm password".
    fireEvent.change(screen.getByLabelText(/username/i), { target: { value: 'alice' } });
    fireEvent.change(screen.getByLabelText(/^password$/i), { target: { value: 'pass123' } });
    fireEvent.change(screen.getByLabelText(/confirm/i), { target: { value: 'pass123' } });
    fireEvent.click(screen.getByRole('button', { name: /create|register|sign up/i }));

    // CompleteStep auto-redirects after 1500ms; allow generous timeout.
    await waitFor(() => {
      expect(onComplete).toHaveBeenCalled();
    }, { timeout: 3000 });
    expect(mockApi.auth.register).toHaveBeenCalledWith({
      username: 'alice',
      password: 'pass123',
    });
  });
});