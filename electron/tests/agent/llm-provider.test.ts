// electron/tests/agent/llm-provider.test.ts
//
// llm-provider 单元测试：mock 全局 fetch，覆盖
//   1. OpenAI provider 请求格式（URL / Authorization / body.model）
//   2. Anthropic provider 请求格式（URL / x-api-key / system 顶层字段）
//   3. API 错误时抛出含状态码的异常

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createLLMProvider } from '../../src/main/agent/llm-provider';
import { resolveMaxTokensParam } from '../../src/main/llm/model-catalog';

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

  it('chatStream 网络层失败时错误消息包含 URL 与 cause（2.0.0 主机验收：裸 "fetch failed" 不可诊断）', async () => {
    // 仿真 undici 网络层 TypeError：消息只有 "fetch failed"，真实原因在 cause。
    // 2026-09-08 重试语义适配：网络异常进入指数退避——持续失败 + fake timers
    // 推进全部退避（1+2+4+8+16=31s）后耗尽，最终错误仍须带 URL 与 cause。
    vi.useFakeTimers();
    try {
      const netErr = new TypeError('fetch failed');
      netErr.cause = new Error('connect ECONNREFUSED 127.0.0.1:9');
      mockFetch.mockRejectedValue(netErr);

      const provider = createLLMProvider(
        { provider: 'openai', model: 'gpt-4o', baseUrl: 'http://127.0.0.1:9/v1' },
        'test-key',
      );
      const stream = provider.chatStream(
        [{ role: 'user', content: 'hi' }],
        undefined,
        new AbortController().signal,
      );

      let caught: Error | null = null;
      const p = (async () => {
        try {
          for await (const _delta of stream) { void _delta; }
        } catch (err) {
          caught = err as Error;
        }
      })();
      await vi.advanceTimersByTimeAsync(35_000);
      await p;

      expect(caught).not.toBeNull();
      expect(caught!.message).toContain('http://127.0.0.1:9/v1/chat/completions');
      expect(caught!.message).toContain('ECONNREFUSED 127.0.0.1:9');
      expect(mockFetch).toHaveBeenCalledTimes(6);
    } finally {
      vi.useRealTimers();
    }
  });

  it('chatStream abort 时 AbortError 原样上抛（不被连接错误包装吞掉中断语义）', async () => {
    const abortErr = new DOMException('This operation was aborted', 'AbortError');
    mockFetch.mockRejectedValueOnce(abortErr);

    const provider = createLLMProvider({ provider: 'openai', model: 'gpt-4o' }, 'test-key');
    const stream = provider.chatStream(
      [{ role: 'user', content: 'hi' }],
      undefined,
      new AbortController().signal,
    );

    let caught: Error | null = null;
    try {
      for await (const _delta of stream) { void _delta; }
    } catch (err) {
      caught = err as Error;
    }

    expect(caught).toBe(abortErr);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// P0-3（结果完整性，spec 2026-09-24 §6）：maxTokens 透传为请求体 max_tokens
// 来源 = model-catalog outputTokens（0=未知不透传）。
// ══════════════════════════════════════════════════════════════════════════

describe('llm-provider maxTokens 透传（P0-3）', () => {
  /** OpenAI 非流式应答夹具 */
  const openAiOk = {
    ok: true,
    json: async () => ({
      choices: [{ message: { content: 'ok', tool_calls: undefined }, finish_reason: 'stop' }],
    }),
  };
  /** Anthropic 非流式应答夹具 */
  const anthropicOk = {
    ok: true,
    json: async () => ({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' }),
  };

  function sentBody(): Record<string, unknown> {
    const call = mockFetch.mock.calls[0]!;
    return JSON.parse((call[1] as { body: string }).body) as Record<string, unknown>;
  }

  it('OpenAI：配置 maxTokens → 非流式请求体携带 max_tokens', async () => {
    mockFetch.mockResolvedValueOnce(openAiOk);
    const provider = createLLMProvider({ provider: 'openai', model: 'gpt-4o' }, 'k', { maxTokens: 8192 });
    await provider.chat([{ role: 'user', content: 'hi' }]);
    expect(sentBody().max_tokens).toBe(8192);
  });

  it('OpenAI：未配置 → 请求体不携带 max_tokens（沿用模型默认）', async () => {
    mockFetch.mockResolvedValueOnce(openAiOk);
    const provider = createLLMProvider({ provider: 'openai', model: 'gpt-4o' }, 'k');
    await provider.chat([{ role: 'user', content: 'hi' }]);
    expect('max_tokens' in sentBody()).toBe(false);
  });

  it('OpenAI：配置 maxTokens → 流式请求体同样携带（非 SSE 降级路径即可断言）', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: { get: (): string => 'application/json' },
      json: async () => ({ choices: [{ message: { content: 'ok' } }] }),
    });
    const provider = createLLMProvider({ provider: 'openai', model: 'gpt-4o' }, 'k', { maxTokens: 4096 });
    const stream = provider.chatStream([{ role: 'user', content: 'hi' }], undefined, new AbortController().signal);
    for await (const _d of stream) { void _d; }
    expect(sentBody().max_tokens).toBe(4096);
  });

  it('Anthropic：配置 maxTokens → 非流式请求体 max_tokens = 配置值（替换硬编码 4096）', async () => {
    mockFetch.mockResolvedValueOnce(anthropicOk);
    const provider = createLLMProvider({ provider: 'anthropic', model: 'claude-3-5-sonnet' }, 'k', { maxTokens: 12000 });
    await provider.chat([{ role: 'user', content: 'hi' }]);
    expect(sentBody().max_tokens).toBe(12000);
  });

  it('Anthropic：未配置 → 回退内置缺省 4096（必填参数语义不变）', async () => {
    mockFetch.mockResolvedValueOnce(anthropicOk);
    const provider = createLLMProvider({ provider: 'anthropic', model: 'claude-3-5-sonnet' }, 'k');
    await provider.chat([{ role: 'user', content: 'hi' }]);
    expect(sentBody().max_tokens).toBe(4096);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// B1（安全 review 2026-09-24）：OpenAI 官方 reasoning 模型（gpt-5/o 系）
// 硬拒 max_tokens（400）——maxTokensParam 分流 max_completion_tokens。
// 判别函数 resolveMaxTokensParam 的目录单测同置于此（纯函数，无 DB）。
// ══════════════════════════════════════════════════════════════════════════

describe('llm-provider maxTokensParam 分流（B1）', () => {
  const openAiOk = {
    ok: true,
    json: async () => ({
      choices: [{ message: { content: 'ok', tool_calls: undefined }, finish_reason: 'stop' }],
    }),
  };

  function sentBody(): Record<string, unknown> {
    const call = mockFetch.mock.calls[0]!;
    return JSON.parse((call[1] as { body: string }).body) as Record<string, unknown>;
  }

  it('OpenAI：maxTokensParam=max_completion_tokens → 非流式请求体用该键且无 max_tokens', async () => {
    mockFetch.mockResolvedValueOnce(openAiOk);
    const provider = createLLMProvider(
      { provider: 'openai', model: 'gpt-5' },
      'k',
      { maxTokens: 128000, maxTokensParam: 'max_completion_tokens' },
    );
    await provider.chat([{ role: 'user', content: 'hi' }]);
    const body = sentBody();
    expect(body.max_completion_tokens).toBe(128000);
    expect('max_tokens' in body).toBe(false);
  });

  it('OpenAI：maxTokensParam=max_completion_tokens → 流式请求体同样分流', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: { get: (): string => 'application/json' },
      json: async () => ({ choices: [{ message: { content: 'ok' } }] }),
    });
    const provider = createLLMProvider(
      { provider: 'openai', model: 'o3' },
      'k',
      { maxTokens: 100000, maxTokensParam: 'max_completion_tokens' },
    );
    const stream = provider.chatStream([{ role: 'user', content: 'hi' }], undefined, new AbortController().signal);
    for await (const _d of stream) { void _d; }
    const body = sentBody();
    expect(body.max_completion_tokens).toBe(100000);
    expect('max_tokens' in body).toBe(false);
  });

  it('Anthropic：maxTokensParam 被忽略（该方言恒 max_tokens）', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' }),
    });
    const provider = createLLMProvider(
      { provider: 'anthropic', model: 'claude-sonnet-4' },
      'k',
      { maxTokens: 8192, maxTokensParam: 'max_completion_tokens' },
    );
    await provider.chat([{ role: 'user', content: 'hi' }]);
    expect(sentBody().max_tokens).toBe(8192);
  });
});

describe('resolveMaxTokensParam 目录单测（B1 判别矩阵）', () => {
  it.each([
    ['openai', 'gpt-5', undefined, 'max_completion_tokens'],
    ['openai', 'gpt-5.2-mini', undefined, 'max_completion_tokens'],
    ['openai', 'o1', undefined, 'max_completion_tokens'],
    ['openai', 'o4-mini', undefined, 'max_completion_tokens'],
    ['openai', 'gpt-5', 'https://proxy.example.com/v1', 'max_tokens'],
    ['openai', 'o3', 'https://api.bigmodel.cn/paas/v4', 'max_tokens'],
    // 第三方 OpenAI 兼容模型（kind 同为 effort，但名称不命中官方前缀）
    ['openai', 'glm-5.2', undefined, 'max_tokens'],
    ['openai', 'deepseek-v4', undefined, 'max_tokens'],
    // 官方非 reasoning 模型
    ['openai', 'gpt-4o', undefined, 'max_tokens'],
    ['openai', 'gpt-4.1-mini', undefined, 'max_tokens'],
    // Anthropic 方言不受影响
    ['anthropic', 'claude-sonnet-4', undefined, 'max_tokens'],
  ] as Array<[string, string, string | undefined, string]>)(
    '(%s, %s, baseUrl=%s) → %s',
    (platform, modelId, baseUrl, expected) => {
      expect(resolveMaxTokensParam(platform, modelId, baseUrl)).toBe(expected);
    },
  );
});
