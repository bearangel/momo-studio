// electron/tests/ipc/authFlows.test.ts
import { describe, it, expect, vi } from 'vitest';
import type { MatrixClient } from 'matrix-js-sdk';
import {
  registerFlow,
  loginFlow,
  getCurrentUserFlow,
  type AuthDeps,
} from '../../src/main/ipc/authFlows';

const SESSION = { userId: '@alice:localhost', deviceId: 'DEV' };

function makeStubMatrixClient(): MatrixClient {
  return {
    register: vi.fn().mockResolvedValue({
      user_id: '@alice:localhost',
      access_token: 'tok',
      device_id: 'DEV',
    }),
    login: vi.fn().mockResolvedValue({
      user_id: '@alice:localhost',
      access_token: 'tok',
      device_id: 'DEV',
    }),
    stopClient: vi.fn(),
  } as unknown as MatrixClient;
}

function makeDeps(overrides: Partial<AuthDeps> = {}): AuthDeps {
  return {
    startConduit: vi.fn().mockResolvedValue({ port: 8008, baseUrl: 'http://127.0.0.1:8008' }),
    createMatrixClient: vi.fn().mockReturnValue(makeStubMatrixClient()),
    setSecret: vi.fn().mockResolvedValue(undefined),
    getSecret: vi.fn().mockResolvedValue(null),
    deleteSecret: vi.fn().mockResolvedValue(undefined),
    dbRun: vi.fn(),
    dbGet: vi.fn().mockReturnValue(undefined),
    ...overrides,
  };
}

describe('auth flows', () => {
  it('registerFlow starts Conduit, registers user, persists token', async () => {
    const deps = makeDeps();
    const result = await registerFlow({ username: 'alice', password: 'pass' }, deps);
    expect(result).toEqual(SESSION);
    expect(deps.startConduit).toHaveBeenCalled();
    expect(deps.setSecret).toHaveBeenCalledWith('user.@alice:localhost.matrix_token', 'tok');
    expect(deps.dbRun).toHaveBeenCalledWith(
      'INSERT OR REPLACE INTO kv_store (key, value) VALUES (?, ?)',
      'current_user_session',
      JSON.stringify(SESSION),
    );
  });

  it('loginFlow logs in and persists token', async () => {
    const deps = makeDeps();
    const result = await loginFlow({ username: 'alice', password: 'pass' }, deps);
    expect(result).toEqual(SESSION);
    expect(deps.setSecret).toHaveBeenCalled();
    expect(deps.dbRun).toHaveBeenCalled();
  });

  it('getCurrentUserFlow returns null when no stored user in DB', async () => {
    const deps = makeDeps({ dbGet: vi.fn().mockReturnValue(undefined) });
    const result = await getCurrentUserFlow(deps);
    expect(result).toBeNull();
    expect(deps.getSecret).not.toHaveBeenCalled();
  });

  it('getCurrentUserFlow returns null when DB has user but token missing', async () => {
    const deps = makeDeps({
      dbGet: vi.fn().mockReturnValue({ value: JSON.stringify(SESSION) }),
      getSecret: vi.fn().mockResolvedValue(null),
    });
    const result = await getCurrentUserFlow(deps);
    expect(result).toBeNull();
  });

  it('getCurrentUserFlow returns user when DB has user and token present', async () => {
    const deps = makeDeps({
      dbGet: vi.fn().mockReturnValue({ value: JSON.stringify(SESSION) }),
      getSecret: vi.fn().mockResolvedValue('tok'),
    });
    const result = await getCurrentUserFlow(deps);
    expect(result).toEqual(SESSION);
  });
});
