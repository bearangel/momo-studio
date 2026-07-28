// electron/tests/agent/llm-provider.test.ts
//
// llm-provider 单元测试：mock 全局 fetch，覆盖
//   1. OpenAI provider 请求格式（URL / Authorization / body.model）
//   2. Anthropic provider 请求格式（URL / x-api-key / system 顶层字段）
//   3. API 错误时抛出含状态码的异常

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createLLMProvider } from '../../src/main/agent/llm-provider';

// Mock 全局 fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

beforeEach(() => {
  mockFetch.mockReset();
});

describe('llm-provider', () => {
  it('OpenAI provider 发送正确请求', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        choices: [{
          message: { content: '你好', tool_calls: undefined },
          finish_reason: 'stop',
        }],
      }),
    });

    const provider = createLLMProvider({ provider: 'openai', model: 'gpt-4o' }, 'test-key');
    const result = await provider.chat([
      { role: 'system', content: '你是助手' },
      { role: 'user', content: '你好' },
    ]);

    expect(result.content).toBe('你好');
    expect(result.toolCalls).toEqual([]);
    expect(result.finishReason).toBe('stop');

    // 验证 fetch 被正确调用
    const call = mockFetch.mock.calls[0]!;
    expect(call[0]).toBe('https://api.openai.com/v1/chat/completions');
    const opts = call[1] as { headers: Record<string, string>; body: string };
    expect(opts.headers.Authorization).toBe('Bearer test-key');
    const body = JSON.parse(opts.body);
    expect(body.model).toBe('gpt-4o');
  });

  it('Anthropic provider 发送正确请求', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        content: [{ type: 'text', text: 'Hello!' }],
        stop_reason: 'end_turn',
      }),
    });

    const provider = createLLMProvider({ provider: 'anthropic', model: 'claude-3-5-sonnet' }, 'ant-key');
    const result = await provider.chat([
      { role: 'system', content: 'Be helpful' },
      { role: 'user', content: 'Hi' },
    ]);

    expect(result.content).toBe('Hello!');
    const call = mockFetch.mock.calls[0]!;
    expect(call[0]).toBe('https://api.anthropic.com/v1/messages');
    const opts = call[1] as { headers: Record<string, string>; body: string };
    expect(opts.headers['x-api-key']).toBe('ant-key');
    const body = JSON.parse(opts.body);
    expect(body.system).toBe('Be helpful');
  });

  it('API 错误时抛出异常', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 401, text: async () => 'Unauthorized' });
    const provider = createLLMProvider({ provider: 'openai', model: 'gpt-4o' }, 'bad-key');
    await expect(provider.chat([{ role: 'user', content: 'hi' }])).rejects.toThrow('401');
  });
});
