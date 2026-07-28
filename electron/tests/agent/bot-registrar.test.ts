// electron/tests/agent/bot-registrar.test.ts
//
// bot-registrar 单元测试：mock matrix/client 的 createMatrixClient（让其返回的
// client.register 是受控桩）与 keychain 的 setSecret，验证
//   1. bot 用户名按 <slug>.<workspaceSlug>.<ownerLocalpart> 规则生成
//   2. 随机密码长度为 32
//   3. access token 以 bot.<userId>.matrix_token 存入 keychain
//   4. 注册返回缺字段时抛错

import { describe, it, expect, beforeEach, vi } from 'vitest';

// vi.hoisted 保证 mock 桩函数在 vi.mock 工厂（会被提升到文件顶部）执行时就已就绪。
const { mockRegister, mockSetSecret } = vi.hoisted(() => ({
  mockRegister: vi.fn(),
  mockSetSecret: vi.fn(),
}));

vi.mock('../../src/main/matrix/client', () => ({
  createMatrixClient: vi.fn(() => ({ register: mockRegister })),
}));

vi.mock('../../src/main/storage/keychain', () => ({
  setSecret: mockSetSecret,
}));

import { registerAgentBot } from '../../src/main/agent/bot-registrar';

describe('agent/bot-registrar', () => {
  beforeEach(() => {
    mockRegister.mockReset();
    mockSetSecret.mockReset();
    mockSetSecret.mockResolvedValue(undefined);
  });

  it('按规则生成 bot 用户名并注册', async () => {
    mockRegister.mockResolvedValue({
      user_id: '@requirement-analyst.proj-x.alice:localhost',
      access_token: 'tok-123',
      device_id: 'DEVAAA',
    });

    const result = await registerAgentBot({
      slug: 'requirement-analyst',
      workspaceName: 'proj-x',
      ownerUserId: '@alice:localhost',
      homeserverUrl: 'http://127.0.0.1:8008',
    });

    expect(mockRegister).toHaveBeenCalledWith(
      'requirement-analyst.proj-x.alice',
      expect.any(String),
      null,
      { type: 'm.login.dummy' },
    );

    const password = mockRegister.mock.calls[0]![1];
    expect(password).toHaveLength(32);

    expect(result).toEqual({
      botUserId: '@requirement-analyst.proj-x.alice:localhost',
      botAccessToken: 'tok-123',
      botDeviceId: 'DEVAAA',
    });
  });

  it('access token 以 bot.<userId>.matrix_token 存入 keychain', async () => {
    mockRegister.mockResolvedValue({
      user_id: '@bot.user.alice:localhost',
      access_token: 'tok-xyz',
      device_id: 'DEVBBB',
    });

    await registerAgentBot({
      slug: 'bot',
      workspaceName: 'user',
      ownerUserId: '@alice:localhost',
      homeserverUrl: 'http://127.0.0.1:8008',
    });

    expect(mockSetSecret).toHaveBeenCalledWith(
      'bot.@bot.user.alice:localhost.matrix_token',
      'tok-xyz',
    );
  });

  it('大小写/空格被规范化为小写短横线段', async () => {
    mockRegister.mockResolvedValue({
      user_id: '@req-analyst.my-project-x.alice:localhost',
      access_token: 't',
      device_id: 'd',
    });

    await registerAgentBot({
      slug: 'Req Analyst',
      workspaceName: 'My Project X',
      ownerUserId: '@Alice:localhost',
      homeserverUrl: 'http://127.0.0.1:8008',
    });

    const username = mockRegister.mock.calls[0]![0];
    expect(username).toBe('req-analyst.my-project-x.alice');
  });

  it('注册返回缺少字段时抛错', async () => {
    mockRegister.mockResolvedValue({ user_id: '@x.y.z:localhost' });

    await expect(
      registerAgentBot({
        slug: 'x',
        workspaceName: 'y',
        ownerUserId: '@z:localhost',
        homeserverUrl: 'http://127.0.0.1:8008',
      }),
    ).rejects.toThrow('device_id');
  });
});
