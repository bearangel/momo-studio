// provider-ipc 的 testConnection：仅验证它存在且对错误凭证返回失败
// （真实网络调用在集成测试/手测，单测 mock fetch）
import { describe, it, expect, vi } from 'vitest';
import { testProviderConnection } from '../../src/main/agent/provider-ipc';

describe('provider-ipc testConnection', () => {
  it('凭证错误时返回 ok:false + error', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 401, text: () => Promise.resolve('unauthorized') });
    const r = await testProviderConnection({ baseUrl: 'https://x/v1', apiKey: 'bad', model: 'm' });
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
  });

  it('网络异常时返回 ok:false + error', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('ETIMEDOUT'));
    const r = await testProviderConnection({ baseUrl: 'https://x/v1', apiKey: 'k', model: 'm' });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('ETIMEDOUT');
  });
});
