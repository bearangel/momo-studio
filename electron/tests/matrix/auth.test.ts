// electron/tests/matrix/auth.test.ts
import { describe, it, expect, vi } from 'vitest';
import type { MatrixClient } from 'matrix-js-sdk';
import { registerAdmin, login, logout } from '../../src/main/matrix/auth';

interface StubResponses {
  registerResponse: unknown;
  loginResponse: unknown;
}

function makeStubClient(responses: StubResponses): MatrixClient {
  return {
    register: vi.fn().mockResolvedValue(responses.registerResponse),
    login: vi.fn().mockResolvedValue(responses.loginResponse),
    logout: vi.fn().mockResolvedValue(undefined),
    stopClient: vi.fn(),
  } as unknown as MatrixClient;
}

describe('matrix/auth', () => {
  it('registerAdmin returns userId + accessToken + deviceId', async () => {
    const client = makeStubClient({
      registerResponse: { user_id: '@alice:localhost', access_token: 'tok-1', device_id: 'DEV-1' },
      loginResponse: {},
    });
    const result = await registerAdmin(client, 'alice', 'pass');
    expect(result).toEqual({ userId: '@alice:localhost', accessToken: 'tok-1', deviceId: 'DEV-1' });
    expect(client.register).toHaveBeenCalledWith('alice', 'pass', null, expect.any(Object));
  });

  it('login returns userId + accessToken + deviceId', async () => {
    const client = makeStubClient({
      registerResponse: {},
      loginResponse: { user_id: '@alice:localhost', access_token: 'tok-2', device_id: 'DEV-2' },
    });
    const result = await login(client, 'alice', 'pass');
    expect(result).toEqual({ userId: '@alice:localhost', accessToken: 'tok-2', deviceId: 'DEV-2' });
  });

  it('logout calls client.logout', async () => {
    const client = makeStubClient({ registerResponse: {}, loginResponse: {} });
    await logout(client);
    expect(client.logout).toHaveBeenCalled();
  });
});
