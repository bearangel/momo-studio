// provider-ipc handler 委托 + testConnection 成功/URL 构造测试。
// 与 provider-ipc.test.ts（仅测 testConnection 失败路径）互补。
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { ipcHandlers, crudMocks, fetchMock } = vi.hoisted(() => {
  const ipcHandlers = new Map<string, (...args: unknown[]) => unknown>();
  return {
    ipcHandlers,
    crudMocks: {
      listProviders: vi.fn(() => []),
      getProvider: vi.fn(() => null),
      createProvider: vi.fn(async () => ({ id: 'p1' })),
      updateProvider: vi.fn(async () => ({ id: 'p1' })),
      deleteProvider: vi.fn(async () => undefined),
      setDefaultProvider: vi.fn(() => undefined),
      getProviderApiKey: vi.fn(async () => 'sk-secret'),
    },
    fetchMock: vi.fn(),
  };
});

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      ipcHandlers.set(channel, fn);
    },
  },
}));

vi.mock('../../src/main/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../src/main/agent/provider-crud', () => crudMocks);

import { registerProviderHandlers, testProviderConnection } from '../../src/main/agent/provider-ipc';

beforeEach(() => {
  ipcHandlers.clear();
  Object.values(crudMocks).forEach((m) => m.mockClear());
  fetchMock.mockReset();
  global.fetch = fetchMock as never;
  registerProviderHandlers();
});

describe('provider-ipc handler 注册', () => {
  it('注册全部 8 个 provider: 通道', () => {
    for (const ch of [
      'provider:list', 'provider:get', 'provider:create', 'provider:update',
      'provider:delete', 'provider:setDefault', 'provider:testConnection',
      'provider:getApiKey',
    ]) {
      expect(ipcHandlers.has(ch)).toBe(true);
    }
  });
});

describe('provider-ipc CRUD 委托', () => {
  it('provider:list → listProviders()', () => {
    crudMocks.listProviders.mockReturnValueOnce([{ id: 'p1' }]);
    const res = ipcHandlers.get('provider:list')!();
    expect(crudMocks.listProviders).toHaveBeenCalled();
    expect(res).toEqual([{ id: 'p1' }]);
  });

  it('provider:get → getProvider(id)', () => {
    ipcHandlers.get('provider:get')!({} as never, 'p1');
    expect(crudMocks.getProvider).toHaveBeenCalledWith('p1');
  });

  it('provider:create → createProvider(input)', async () => {
    const input = { name: 'X', baseUrl: 'u', apiKey: 'k' };
    const res = await ipcHandlers.get('provider:create')!({} as never, input);
    expect(crudMocks.createProvider).toHaveBeenCalledWith(input);
    expect(res).toEqual({ id: 'p1' });
  });

  it('provider:update → updateProvider(input)', async () => {
    const input = { id: 'p1', name: 'Y' };
    await ipcHandlers.get('provider:update')!({} as never, input);
    expect(crudMocks.updateProvider).toHaveBeenCalledWith(input);
  });

  it('provider:setDefault → setDefaultProvider(id)', () => {
    ipcHandlers.get('provider:setDefault')!({} as never, 'p1');
    expect(crudMocks.setDefaultProvider).toHaveBeenCalledWith('p1');
  });

  it('provider:getApiKey → getProviderApiKey(id)', async () => {
    const res = await ipcHandlers.get('provider:getApiKey')!({} as never, 'p1');
    expect(crudMocks.getProviderApiKey).toHaveBeenCalledWith('p1');
    expect(res).toBe('sk-secret');
  });

  it('provider:delete 触发 deleteProvider(id)（删 DB + keychain 的入口）', async () => {
    const res = await ipcHandlers.get('provider:delete')!({} as never, 'p1');
    // handler 即刻返回 { ok:true }（fire-and-forget）
    expect(res).toEqual({ ok: true });
    // 刷新挂起的 floating promise 后断言 deleteProvider 被调用
    await new Promise((r) => setTimeout(r, 0));
    expect(crudMocks.deleteProvider).toHaveBeenCalledWith('p1');
  });
});

describe('provider-ipc testConnection 成功与 URL 构造', () => {
  it('HTTP 200 → ok:true', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200 });
    const r = await testProviderConnection({ baseUrl: 'https://x/v1', apiKey: 'k', model: 'm' });
    expect(r.ok).toBe(true);
  });

  it('baseUrl 以 /v1 结尾 → 直接拼 /chat/completions', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200 });
    await testProviderConnection({ baseUrl: 'https://x/v1', apiKey: 'k', model: 'm' });
    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toBe('https://x/v1/chat/completions');
  });

  it('baseUrl 不以 /v1 结尾且带尾斜杠 → 裁掉尾斜杠后拼 /chat/completions（不自动补 /v1）', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200 });
    await testProviderConnection({ baseUrl: 'https://x/custom/', apiKey: 'k', model: 'm' });
    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toBe('https://x/custom/chat/completions');
  });

  it('请求携带 Authorization: Bearer <apiKey>', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200 });
    await testProviderConnection({ baseUrl: 'https://x/v1', apiKey: 'sk-token', model: 'm' });
    const opts = fetchMock.mock.calls[0][1] as { headers: Record<string, string> };
    expect(opts.headers.Authorization).toBe('Bearer sk-token');
  });
});
