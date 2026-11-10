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

  // 2026-11-10 OAuth Task 1：共享 isLoopbackHost 必须理解 WHATWG URL 的 IPv6 方括号。
  it('http://[::1] 回环 IPv6 → 通过准入并继续发请求', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: false, status: 401, text: () => Promise.resolve('unauthorized'),
    });
    global.fetch = fetchSpy;
    const r = await testProviderConnection({
      baseUrl: 'http://[::1]:11434/v1', apiKey: 'k', model: 'm',
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(r.error).toBe('HTTP 401');
  });

  // 2026-11-10 放宽：内网 oneapi/本地中转常见纯 http——放行探测，安全提醒不阻断（用户自担）
  it('非回环 http → 放行探测并附非加密 warning', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true, status: 200, text: () => Promise.resolve('{}'),
    });
    global.fetch = fetchSpy;
    const r = await testProviderConnection({
      baseUrl: 'http://192.168.1.5:8080/v1', apiKey: 'k', model: 'm',
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(r.ok).toBe(true);
    expect(r.warning).toMatch(/非加密|明文/);
  });

  it('非回环 http 探测失败 → ok:false 且同样带 warning', async () => {
    const fetchSpy = vi.fn().mockRejectedValue(new Error('ETIMEDOUT'));
    global.fetch = fetchSpy;
    const r = await testProviderConnection({
      baseUrl: 'http://10.0.0.8:3000/v1', apiKey: 'k', model: 'm',
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('ETIMEDOUT');
    expect(r.warning).toMatch(/非加密|明文/);
  });

  it('https 地址 → 不附 warning', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true, status: 200, text: () => Promise.resolve('{}'),
    });
    const r = await testProviderConnection({
      baseUrl: 'https://x.example.com/v1', apiKey: 'k', model: 'm',
    });
    expect(r.ok).toBe(true);
    expect(r.warning).toBeUndefined();
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
