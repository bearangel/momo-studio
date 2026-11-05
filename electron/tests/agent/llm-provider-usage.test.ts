// electron/tests/agent/llm-provider-usage.test.ts
//
// R3 真实 token 遥测——provider 层 usage 解析契约锁（2026-11-05）：
//   1. OpenAI 兼容 chat（非流式）：响应体 usage.prompt_tokens / completion_tokens
//      → LLMResponse.usage（归一化为 promptTokens/completionTokens）
//   2. OpenAI 兼容 stream：末包（choices 空数组）携带 usage → done delta 携带
//      （机会式解析——请求未加 stream_options，网关主动携带才可见，见 llm-provider 注释）
//   3. 非 SSE 降级路径（两方言）：整包 JSON 的 usage → done delta 携带
//   4. Anthropic chat（非流式）：usage.input_tokens / output_tokens → 归一化
//   5. Anthropic stream：message_start.input_tokens + message_delta.output_tokens
//      （累计值）→ done delta 携带
//   6. 铁律：usage 缺席 → undefined（不伪造 0）；malformed（字符串 / 负数 / NaN /
//      小数）→ undefined，绝不抛错——单轮坏报文不得炸回合
import { describe, it, expect, vi } from 'vitest';
import { createLLMProvider, type StreamDelta } from '../../src/main/agent/llm-provider';

/** 构造 OpenAI SSE mock 响应 */
function mockOpenAISSE(chunks: object[]): Response {
  const body = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body));
      controller.close();
    },
  });
  return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
}

/** 构造 Anthropic SSE mock 响应 */
function mockAnthropicSSE(events: object[]): Response {
  const body = events.map((e) => `event: message\ndata: ${JSON.stringify(e)}\n\n`).join('');
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body));
      controller.close();
    },
  });
  return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
}

/** mock 非流式 JSON 响应 */
function mockJSON(body: object): Response {
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
}

async function collectStream(provider: ReturnType<typeof createLLMProvider>): Promise<StreamDelta[]> {
  const deltas: StreamDelta[] = [];
  for await (const d of provider.chatStream!(
    [{ role: 'user', content: 'hi' }],
    undefined,
    new AbortController().signal,
  )) {
    deltas.push(d);
  }
  return deltas;
}

function doneOf(deltas: StreamDelta[]): Extract<StreamDelta, { type: 'done' }> {
  const done = deltas.find((d) => d.type === 'done');
  expect(done).toBeDefined();
  return done as Extract<StreamDelta, { type: 'done' }>;
}

describe('usage 解析 — OpenAI 兼容 chat（非流式）', () => {
  it('响应体携带 usage → LLMResponse.usage 归一化', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      mockJSON({
        choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 12, completion_tokens: 34 },
      }),
    );
    const provider = createLLMProvider({ model: 'gpt-4', baseUrl: 'https://api.openai.com/v1' }, 'sk-test');
    const res = await provider.chat([{ role: 'user', content: 'hi' }]);
    expect(res.usage).toEqual({ promptTokens: 12, completionTokens: 34 });
  });

  it('响应体无 usage → res.usage undefined（不伪造 0）', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      mockJSON({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }),
    );
    const provider = createLLMProvider({ model: 'gpt-4', baseUrl: 'https://api.openai.com/v1' }, 'sk-test');
    const res = await provider.chat([{ role: 'user', content: 'hi' }]);
    expect(res.usage).toBeUndefined();
  });

  it.each([
    ['字符串字段', { prompt_tokens: '12', completion_tokens: 34 }],
    ['负数', { prompt_tokens: -1, completion_tokens: 34 }],
    ['NaN', { prompt_tokens: NaN, completion_tokens: 34 }],
    ['小数', { prompt_tokens: 1.5, completion_tokens: 34 }],
    ['缺 completion', { prompt_tokens: 12 }],
    ['usage 非对象', 'oops'],
  ])('malformed usage（%s）→ undefined 且不抛错', async (_label, usage) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      mockJSON({
        choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
        usage,
      }),
    );
    const provider = createLLMProvider({ model: 'gpt-4', baseUrl: 'https://api.openai.com/v1' }, 'sk-test');
    const res = await provider.chat([{ role: 'user', content: 'hi' }]);
    expect(res.usage).toBeUndefined();
  });
});

describe('usage 解析 — OpenAI 兼容 stream', () => {
  it('末包（choices 空数组）携带 usage → done delta 携带（机会式）', async () => {
    const chunks = [
      { choices: [{ delta: { content: 'Hi' }, index: 0 }] },
      { choices: [{ finish_reason: 'stop', delta: {}, index: 0 }] },
      { choices: [], usage: { prompt_tokens: 10, completion_tokens: 20 } },
    ];
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(mockOpenAISSE(chunks));
    const provider = createLLMProvider({ model: 'gpt-4', baseUrl: 'https://api.openai.com/v1' }, 'sk-test');
    const done = doneOf(await collectStream(provider));
    expect(done.usage).toEqual({ promptTokens: 10, completionTokens: 20 });
  });

  it('流内无 usage → done delta 无 usage 字段', async () => {
    const chunks = [
      { choices: [{ delta: { content: 'Hi' }, index: 0 }] },
      { choices: [{ finish_reason: 'stop', delta: {}, index: 0 }] },
    ];
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(mockOpenAISSE(chunks));
    const provider = createLLMProvider({ model: 'gpt-4', baseUrl: 'https://api.openai.com/v1' }, 'sk-test');
    const done = doneOf(await collectStream(provider));
    expect(done.usage).toBeUndefined();
  });

  it('末包 malformed usage → undefined 不抛错', async () => {
    const chunks = [
      { choices: [{ finish_reason: 'stop', delta: {}, index: 0 }] },
      { choices: [], usage: { prompt_tokens: 'x', completion_tokens: 3 } },
    ];
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(mockOpenAISSE(chunks));
    const provider = createLLMProvider({ model: 'gpt-4', baseUrl: 'https://api.openai.com/v1' }, 'sk-test');
    const done = doneOf(await collectStream(provider));
    expect(done.usage).toBeUndefined();
  });

  it('非 SSE 降级：整包 JSON 携带 usage → done delta 携带', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      mockJSON({
        choices: [{ message: { content: '完整回复' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 7, completion_tokens: 9 },
      }),
    );
    const provider = createLLMProvider({ model: 'gpt-4', baseUrl: 'https://api.openai.com/v1' }, 'sk-test');
    const done = doneOf(await collectStream(provider));
    expect(done.usage).toEqual({ promptTokens: 7, completionTokens: 9 });
  });
});

describe('usage 解析 — Anthropic', () => {
  it('chat（非流式）：usage.input/output_tokens → 归一化', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      mockJSON({
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 100, output_tokens: 50 },
      }),
    );
    const provider = createLLMProvider(
      { provider: 'anthropic', model: 'claude-sonnet-4', baseUrl: 'https://api.anthropic.com' },
      'sk-test',
    );
    const res = await provider.chat([{ role: 'user', content: 'hi' }]);
    expect(res.usage).toEqual({ promptTokens: 100, completionTokens: 50 });
  });

  it('chat（非流式）无 usage → undefined', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      mockJSON({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' }),
    );
    const provider = createLLMProvider(
      { provider: 'anthropic', model: 'claude-sonnet-4', baseUrl: 'https://api.anthropic.com' },
      'sk-test',
    );
    const res = await provider.chat([{ role: 'user', content: 'hi' }]);
    expect(res.usage).toBeUndefined();
  });

  it('stream：message_start.input + message_delta.output（累计）→ done delta 携带', async () => {
    const events = [
      { type: 'message_start', message: { usage: { input_tokens: 42, output_tokens: 2 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi' } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 17 } },
      { type: 'message_stop' },
    ];
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(mockAnthropicSSE(events));
    const provider = createLLMProvider(
      { provider: 'anthropic', model: 'claude-sonnet-4', baseUrl: 'https://api.anthropic.com' },
      'sk-test',
    );
    const done = doneOf(await collectStream(provider));
    // input 取 message_start；output 取 message_delta 的累计终值（非 message_start 小值 2）
    expect(done.usage).toEqual({ promptTokens: 42, completionTokens: 17 });
  });

  it('stream：无 usage 事件 → done delta 无 usage', async () => {
    const events = [
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi' } },
      { type: 'message_stop' },
    ];
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(mockAnthropicSSE(events));
    const provider = createLLMProvider(
      { provider: 'anthropic', model: 'claude-sonnet-4', baseUrl: 'https://api.anthropic.com' },
      'sk-test',
    );
    const done = doneOf(await collectStream(provider));
    expect(done.usage).toBeUndefined();
  });

  it('stream：malformed input_tokens（负数字符串）→ 该侧按缺席处理不抛错', async () => {
    const events = [
      { type: 'message_start', message: { usage: { input_tokens: '-5', output_tokens: 2 } } },
      { type: 'message_delta', delta: {}, usage: { output_tokens: 9 } },
      { type: 'message_stop' },
    ];
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(mockAnthropicSSE(events));
    const provider = createLLMProvider(
      { provider: 'anthropic', model: 'claude-sonnet-4', baseUrl: 'https://api.anthropic.com' },
      'sk-test',
    );
    const done = doneOf(await collectStream(provider));
    // 合法侧保留真实值，非法侧按 0（缺席语义——不伪造 provider 未报的数据）
    expect(done.usage).toEqual({ promptTokens: 0, completionTokens: 9 });
  });

  it('非 SSE 降级：整包 usage → done delta 携带', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      mockJSON({
        content: [{ type: 'text', text: '完整回复' }],
        usage: { input_tokens: 30, output_tokens: 40 },
      }),
    );
    const provider = createLLMProvider(
      { provider: 'anthropic', model: 'claude-sonnet-4', baseUrl: 'https://api.anthropic.com' },
      'sk-test',
    );
    const done = doneOf(await collectStream(provider));
    expect(done.usage).toEqual({ promptTokens: 30, completionTokens: 40 });
  });
});
