// electron/tests/agent/llm-provider.test.ts
//
// llm-provider 单元测试：mock 全局 fetch，覆盖
//   1. OpenAI provider 请求格式（URL / Authorization / body.model）
//   2. Anthropic provider 请求格式（URL / x-api-key / system 顶层字段）
//   3. API 错误时抛出含状态码的异常

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createLLMProvider } from '../../src/main/agent/llm-provider';
import { resolveMaxTokensParam } from '../../src/main/llm/model-catalog';

// Mock 全局 fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

beforeEach(() => {
  mockFetch.mockReset();
});

describe('llm-provider 工具名 wire 编解码（冒号工具名 400 修复）', () => {
  // 用户实测：团队会话 leader 的 dispatch:<slug> 工具名含冒号，OpenAI 兼容网关
  // （智谱）按 ^[a-zA-Z0-9_-]+$ 校验 tools[].function.name → 整请求 400。
  // 契约：内部名保持 dispatch:<slug>（runtime/UI/存储零改动），provider 层
  // 出站消毒（非法字符→下划线）、入站回映（wire 名→内部名）。

  const COLON_TOOLS = [
    { name: 'dispatch:coder', description: '调度子 agent', inputSchema: { type: 'object' } },
    { name: 'dispatch_bg:writer', description: '后台派发', inputSchema: { type: 'object' } },
    { name: 'read_file', description: '读文件', inputSchema: { type: 'object' } },
  ];

  it('OpenAI chat：请求 tools 名消毒（dispatch:coder → dispatch_coder）；响应 tool_call 名回映', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        choices: [{
          message: {
            content: '',
            tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'dispatch_coder', arguments: '{"task":"干活"}' } }],
          },
          finish_reason: 'tool_calls',
        }],
      }),
    });
    const provider = createLLMProvider({ provider: 'openai', model: 'glm-5.3' }, 'k');
    const result = await provider.chat([{ role: 'user', content: '派活' }], COLON_TOOLS);

    const body = JSON.parse((mockFetch.mock.calls[0]![1] as { body: string }).body);
    const names = (body.tools as Array<{ function: { name: string } }>).map((t) => t.function.name);
    expect(names).toEqual(['dispatch_coder', 'dispatch_bg_writer', 'read_file']);
    expect(result.toolCalls[0]!.name).toBe('dispatch:coder');
  });

  it('OpenAI chat：assistant 历史 toolCalls 回放同样消毒（对话续轮请求体合法）', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }),
    });
    const provider = createLLMProvider({ provider: 'openai', model: 'glm-5.3' }, 'k');
    await provider.chat(
      [
        { role: 'user', content: '派活' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'tc1', name: 'dispatch:coder', arguments: { task: 'x' } }] },
        { role: 'tool', content: '结果', toolCallId: 'tc1' },
        { role: 'user', content: '继续' },
      ],
      COLON_TOOLS,
    );
    const body = JSON.parse((mockFetch.mock.calls[0]![1] as { body: string }).body);
    const echo = body.messages[1].tool_calls[0].function.name;
    expect(echo).toBe('dispatch_coder');
  });

  it('Anthropic chat：tools 名消毒 + tool_use 名回映', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        content: [{ type: 'tool_use', id: 'tu1', name: 'dispatch_bg_writer', input: { task: '写' } }],
        stop_reason: 'tool_use',
      }),
    });
    const provider = createLLMProvider({ provider: 'anthropic', model: 'claude-x' }, 'k');
    const result = await provider.chat([{ role: 'user', content: '后台派' }], COLON_TOOLS);

    const body = JSON.parse((mockFetch.mock.calls[0]![1] as { body: string }).body);
    const names = (body.tools as Array<{ name: string }>).map((t) => t.name);
    expect(names).toEqual(['dispatch_coder', 'dispatch_bg_writer', 'read_file']);
    expect(result.toolCalls[0]!.name).toBe('dispatch_bg:writer');
  });

  it('OpenAI 流式：请求消毒 + 累积 tool_use 回映', async () => {
    const sse = [
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"tc1","function":{"name":"dispatch_coder","arguments":""}}]}}]}',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"task\":\"y\"}"}}]}}]}',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
      'data: [DONE]',
    ].join('\n\n');
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: { get: () => 'text/event-stream' },
      body: { getReader: () => new StringReader(sse) },
    });
    const provider = createLLMProvider({ provider: 'openai', model: 'glm-5.3' }, 'k');
    const deltas: Array<{ type: string; toolCall?: { name: string } }> = [];
    for await (const d of provider.chatStream([{ role: 'user', content: '派' }], COLON_TOOLS, new AbortController().signal)) {
      deltas.push(d as { type: string; toolCall?: { name: string } });
    }
    const body = JSON.parse((mockFetch.mock.calls[0]![1] as { body: string }).body);
    const names = (body.tools as Array<{ function: { name: string } }>).map((t) => t.function.name);
    expect(names).toEqual(['dispatch_coder', 'dispatch_bg_writer', 'read_file']);
    const tu = deltas.find((d) => d.type === 'tool_use');
    expect(tu?.toolCall?.name).toBe('dispatch:coder');
  });

  it('回归锁：wire 合法名（read_file 等）出站字节不变', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }),
    });
    const provider = createLLMProvider({ provider: 'openai', model: 'gpt-4o' }, 'k');
    await provider.chat([{ role: 'user', content: 'hi' }], [
      { name: 'read_file', description: 'd', inputSchema: { type: 'object' } },
      { name: 'bash_exec-1', description: 'd', inputSchema: { type: 'object' } },
    ]);
    const body = JSON.parse((mockFetch.mock.calls[0]![1] as { body: string }).body);
    expect(body.tools.map((t: { function: { name: string } }) => t.function.name)).toEqual(['read_file', 'bash_exec-1']);
  });
});

/**
 * 测试用 SSE reader：把整段字符串一次性交出（覆盖流式解析的最小 Reader 形状）。
 * 放在文件尾（仅本 describe 消费，避免与既有 fetch mock 文件头 helper 命名冲突）。
 */
class StringReader {
  private done = false;
  constructor(private readonly s: string) {}
  read(): Promise<{ done: boolean; value?: Uint8Array }> {
    if (this.done) return Promise.resolve({ done: true });
    this.done = true;
    return Promise.resolve({ done: false, value: new TextEncoder().encode(this.s) });
  }
  cancel(): Promise<void> {
    return Promise.resolve();
  }
}

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

// ══════════════════════════════════════════════════════════════════════════
// T3（spec §7）：LLMMessage.images 双平台 parts 映射——provider 层只负责
// 映射，无 vision 能力判定（能力 gating 是 Task 8 runtime 责任）。
// 无 images 时 content 保持 string（字节不变回归锁）。
// ══════════════════════════════════════════════════════════════════════════

describe('llm-provider LLMMessage.images 双平台映射（T3 / spec §7）', () => {
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

  /** 提取本次 fetch 调用发送的 JSON 请求体 */
  function sentBody(): Record<string, unknown> {
    const call = mockFetch.mock.calls[0]!;
    return JSON.parse((call[1] as { body: string }).body) as Record<string, unknown>;
  }

  it('OpenAI：消息含 2 张图 → content 数组 [text, image_url, image_url]，data URL 良构', async () => {
    mockFetch.mockResolvedValueOnce(openAiOk);
    const provider = createLLMProvider({ provider: 'openai', model: 'gpt-4o' }, 'k');
    await provider.chat([
      {
        role: 'user',
        content: '描述这两张图',
        images: [
          { mime: 'image/png', base64: 'AAA', w: 1024, h: 768 },
          { mime: 'image/jpeg', base64: 'BBB', w: 800, h: 600 },
        ],
      },
    ]);
    const body = sentBody();
    const messages = body.messages as Array<{ role: string; content: unknown }>;
    const content = messages[0]!.content;
    expect(Array.isArray(content)).toBe(true);
    expect(content).toEqual([
      { type: 'text', text: '描述这两张图' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
      { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,BBB' } },
    ]);
  });

  it('OpenAI：无 images → content 是字符串，深度等于原文（字节不变回归锁）', async () => {
    mockFetch.mockResolvedValueOnce(openAiOk);
    const provider = createLLMProvider({ provider: 'openai', model: 'gpt-4o' }, 'k');
    await provider.chat([{ role: 'user', content: '你好' }]);
    const messages = (sentBody().messages as Array<{ role: string; content: unknown }>);
    const content = messages[0]!.content;
    expect(typeof content).toBe('string');
    expect(content).toBe('你好');
  });

  it('Anthropic：消息含 2 张图 → content 数组 [image, image, text]，base64 + media_type + data', async () => {
    mockFetch.mockResolvedValueOnce(anthropicOk);
    const provider = createLLMProvider({ provider: 'anthropic', model: 'claude-3-5-sonnet' }, 'k');
    await provider.chat([
      {
        role: 'user',
        content: '看图说话',
        images: [
          { mime: 'image/png', base64: 'AAA', w: 1024, h: 768 },
          { mime: 'image/jpeg', base64: 'BBB', w: 800, h: 600 },
        ],
      },
    ]);
    const body = sentBody();
    const messages = body.messages as Array<{ role: string; content: unknown }>;
    const content = messages[0]!.content;
    expect(Array.isArray(content)).toBe(true);
    expect(content).toEqual([
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: 'AAA' },
      },
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/jpeg', data: 'BBB' },
      },
      { type: 'text', text: '看图说话' },
    ]);
  });

  it('Anthropic：无 images → content 是字符串（字节不变）', async () => {
    mockFetch.mockResolvedValueOnce(anthropicOk);
    const provider = createLLMProvider({ provider: 'anthropic', model: 'claude-3-5-sonnet' }, 'k');
    await provider.chat([{ role: 'user', content: 'Hi' }]);
    const messages = (sentBody().messages as Array<{ role: string; content: unknown }>);
    const content = messages[0]!.content;
    expect(typeof content).toBe('string');
    expect(content).toBe('Hi');
  });

  it('OpenAI 流式：含 images → chatStream 请求体 content 数组同样带 image_url parts', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: { get: (): string => 'application/json' },
      json: async () => ({ choices: [{ message: { content: 'ok' } }] }),
    });
    const provider = createLLMProvider({ provider: 'openai', model: 'gpt-4o' }, 'k');
    const stream = provider.chatStream(
      [
        {
          role: 'user',
          content: '看图',
          images: [{ mime: 'image/png', base64: 'AAA', w: 1024, h: 768 }],
        },
      ],
      undefined,
      new AbortController().signal,
    );
    for await (const _d of stream) { void _d; }
    const messages = (sentBody().messages as Array<{ role: string; content: unknown }>);
    const content = messages[0]!.content;
    expect(content).toEqual([
      { type: 'text', text: '看图' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
    ]);
  });

  it('OpenAI：images 空数组 → content 保持字符串（length===0 不切 parts 边界锁）', async () => {
    mockFetch.mockResolvedValueOnce(openAiOk);
    const provider = createLLMProvider({ provider: 'openai', model: 'gpt-4o' }, 'k');
    await provider.chat([{ role: 'user', content: '普通文本', images: [] }]);
    const messages = (sentBody().messages as Array<{ role: string; content: unknown }>);
    const content = messages[0]!.content;
    expect(typeof content).toBe('string');
    expect(content).toBe('普通文本');
  });

  it('Anthropic 流式：含 images → chatStream 请求体 content 数组同样带 image + text blocks', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: { get: (): string => 'application/json' },
      json: async () => ({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' }),
    });
    const provider = createLLMProvider({ provider: 'anthropic', model: 'claude-3-5-sonnet' }, 'k');
    const stream = provider.chatStream(
      [
        {
          role: 'user',
          content: '看图',
          images: [{ mime: 'image/png', base64: 'AAA', w: 1024, h: 768 }],
        },
      ],
      undefined,
      new AbortController().signal,
    );
    for await (const _d of stream) { void _d; }
    const messages = (sentBody().messages as Array<{ role: string; content: unknown }>);
    const content = messages[0]!.content;
    expect(content).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } },
      { type: 'text', text: '看图' },
    ]);
  });
});

// === D2 流空闲看门狗（验收报告 2026-10-31：死 socket 挂死 17min+ 无数据层看门狗）===

describe('流空闲看门狗（D2）', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** 死 SSE 响应：建连成功（ok + event-stream 头）但 body 永不下发永不关闭——死 socket 语义 */
  function deadSseResponse(): Response {
    const stream = new ReadableStream<Uint8Array>({
      start() {
        /* 永不 enqueue、永不 close */
      },
    });
    return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
  }

  it('OpenAI 流：120s 无任何字节 → StreamIdleTimeout 类型化错误（不再永久挂死）', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(async () => deadSseResponse()));
    try {
      const provider = createLLMProvider({ provider: 'openai', model: 'test-m' }, 'k');
      const iter = provider.chatStream([{ role: 'user', content: '写个长文' }], undefined, new AbortController().signal);
      const p = (async () => {
        for await (const d of iter) {
          void d; // 死流不应产出任何 delta
        }
      })();
      const expectIdle = expect(p).rejects.toMatchObject({
        name: 'StreamIdleTimeout',
        message: expect.stringContaining('流空闲超时'),
      });
      await vi.advanceTimersByTimeAsync(120_000);
      await expectIdle;
    } finally {
      vi.useRealTimers();
    }
  });

  it('Anthropic 流：同款死流 → StreamIdleTimeout（两方言统一执法）', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(async () => deadSseResponse()));
    try {
      const provider = createLLMProvider({ provider: 'anthropic', model: 'claude-test' }, 'k');
      const iter = provider.chatStream([{ role: 'user', content: '写个长文' }], undefined, new AbortController().signal);
      const p = (async () => {
        for await (const d of iter) {
          void d;
        }
      })();
      const expectIdle = expect(p).rejects.toMatchObject({ name: 'StreamIdleTimeout' });
      await vi.advanceTimersByTimeAsync(120_000);
      await expectIdle;
    } finally {
      vi.useRealTimers();
    }
  });

  it('活性重置：字节持续到达不误杀，静默后才计时（keep-alive ping 同样算活性）', async () => {
    vi.useFakeTimers();
    const enc = new TextEncoder();
    // t=0 下发一条 thinking delta，随后静默——重置语义的判定样本
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode('data: {"choices":[{"delta":{"reasoning_content":"先想一下"}}]}\n\n'));
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(stream, { headers: { 'content-type': 'text/event-stream' } })),
    );
    try {
      const provider = createLLMProvider({ provider: 'openai', model: 'test-m' }, 'k');
      const iter = provider.chatStream([{ role: 'user', content: 'hi' }], undefined, new AbortController().signal);
      const seen: string[] = [];
      const p = (async () => {
        for await (const d of iter) {
          if (d.type === 'thinking') seen.push(d.content);
        }
      })();
      await vi.advanceTimersByTimeAsync(0); // 冲微任务：首 delta 已产出且已 reset
      expect(seen).toEqual(['先想一下']);
      // 距最后字节 119s：不误杀
      await vi.advanceTimersByTimeAsync(119_000);
      expect(seen).toEqual(['先想一下']);
      // 距最后字节 120s+：判死
      const expectIdle = expect(p).rejects.toMatchObject({ name: 'StreamIdleTimeout' });
      await vi.advanceTimersByTimeAsync(2_000);
      await expectIdle;
    } finally {
      vi.useRealTimers();
    }
  });

  it('正常收尾：流结束即解除看门狗（收尾后 130s 无迟到火情/无 unhandledRejection）', async () => {
    vi.useFakeTimers();
    const enc = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode('data: [DONE]\n\n'));
        c.close();
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(stream, { headers: { 'content-type': 'text/event-stream' } })),
    );
    try {
      const provider = createLLMProvider({ provider: 'openai', model: 'test-m' }, 'k');
      const iter = provider.chatStream([{ role: 'user', content: 'hi' }], undefined, new AbortController().signal);
      const got: string[] = [];
      for await (const d of iter) {
        got.push(d.type);
      }
      expect(got).toEqual(['done']); // [DONE] 不产内容 delta，仅终结
      await vi.advanceTimersByTimeAsync(130_000); // 迟到火情会以 unhandledRejection 炸测试进程
    } finally {
      vi.useRealTimers();
    }
  });
});
