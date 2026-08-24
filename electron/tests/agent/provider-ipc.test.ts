// provider-ipc 的 testConnection：仅验证它存在且对错误凭证返回失败
// （真实网络调用在集成测试/手测，单测 mock fetch）
//
// P3 Task 2：model 为空/纯空白时不应发裸请求——返回结构化错误提示用户先去拉取模型列表。
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

  it('model 为空串 → 立即返回 ok:false + 提示文案（不发请求）', async () => {
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy;
    const r = await testProviderConnection({
      baseUrl: 'https://x/v1', apiKey: 'k', model: '',
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/模型名|拉取模型列表/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('model 为纯空白 → 同样立即返回结构化错误', async () => {
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy;
    const r = await testProviderConnection({
      baseUrl: 'https://x/v1', apiKey: 'k', model: '   ',
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/模型名|拉取模型列表/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
