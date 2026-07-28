// electron/tests/agent/llm-provider-retry.test.ts
//
// fetchWithRetry 指数退避重试逻辑测试。通过 mock 全局 fetch 模拟各种
// HTTP 状态码和网络异常，配合 vi.useFakeTimers 跳过真实退避延迟。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createLLMProvider } from '../../src/main/agent/llm-provider';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function okResponse(data: unknown): Response {
  return { ok: true, status: 200, json: async () => data } as unknown as Response;
}

function errorResponse(status: number): Response {
  return { ok: false, status, text: async () => `HTTP ${status}` } as unknown as Response;
}

beforeEach(() => {
  mockFetch.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('llm-provider 重试逻辑', () => {
  it('第一次 429 → 第二次 200：重试一次后成功', async () => {
    vi.useFakeTimers();
    mockFetch
      .mockResolvedValueOnce(errorResponse(429))
      .mockResolvedValueOnce(
        okResponse({
          choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
        }),
      );

    const provider = createLLMProvider({ provider: 'openai', model: 'gpt-4o' }, 'key');
    const p = provider.chat([{ role: 'user', content: 'hi' }]);
    await vi.advanceTimersByTimeAsync(1000);
    const result = await p;

    expect(result.content).toBe('ok');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('全部 500：重试 3 次后抛错（共 4 次请求）', async () => {
    vi.useFakeTimers();
    mockFetch.mockResolvedValue(errorResponse(500));

    const provider = createLLMProvider({ provider: 'openai', model: 'gpt-4o' }, 'key');
    const p = provider.chat([{ role: 'user', content: 'hi' }]);
    p.catch(() => {});
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(p).rejects.toThrow('HTTP 500');
    expect(mockFetch).toHaveBeenCalledTimes(4);
  });

  it('400 客户端错误：不重试，直接返回（provider 抛业务异常）', async () => {
    mockFetch.mockResolvedValueOnce(errorResponse(400));

    const provider = createLLMProvider({ provider: 'openai', model: 'gpt-4o' }, 'key');
    await expect(provider.chat([{ role: 'user', content: 'hi' }])).rejects.toThrow('400');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('401 不重试（认证错误无意义重试）', async () => {
    mockFetch.mockResolvedValueOnce(errorResponse(401));

    const provider = createLLMProvider({ provider: 'openai', model: 'gpt-4o' }, 'bad-key');
    await expect(provider.chat([{ role: 'user', content: 'hi' }])).rejects.toThrow('401');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('fetch 抛网络异常 → 重试', async () => {
    vi.useFakeTimers();
    mockFetch
      .mockRejectedValueOnce(new Error('network error'))
      .mockResolvedValueOnce(
        okResponse({
          choices: [{ message: { content: 'recovered' }, finish_reason: 'stop' }],
        }),
      );

    const provider = createLLMProvider({ provider: 'openai', model: 'gpt-4o' }, 'key');
    const p = provider.chat([{ role: 'user', content: 'hi' }]);
    await vi.advanceTimersByTimeAsync(1000);
    const result = await p;

    expect(result.content).toBe('recovered');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('502 和 503 同样触发重试', async () => {
    vi.useFakeTimers();
    mockFetch
      .mockResolvedValueOnce(errorResponse(502))
      .mockResolvedValueOnce(errorResponse(503))
      .mockResolvedValueOnce(
        okResponse({
          choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
        }),
      );

    const provider = createLLMProvider({ provider: 'openai', model: 'gpt-4o' }, 'key');
    const p = provider.chat([{ role: 'user', content: 'hi' }]);
    await vi.advanceTimersByTimeAsync(3000);
    const result = await p;

    expect(result.content).toBe('ok');
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('网络异常持续 → 重试 3 次后抛错', async () => {
    vi.useFakeTimers();
    mockFetch.mockRejectedValue(new Error('connection refused'));

    const provider = createLLMProvider({ provider: 'openai', model: 'gpt-4o' }, 'key');
    const p = provider.chat([{ role: 'user', content: 'hi' }]);
    p.catch(() => {});
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(p).rejects.toThrow('connection refused');
    expect(mockFetch).toHaveBeenCalledTimes(4);
  });
});
