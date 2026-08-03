// electron/tests/agent/llm-provider-stream.test.ts
//
// chatStream 流式接口测试：mock 全局 fetch 返回 SSE 流，
// 覆盖 OpenAI 格式的 text / reasoning_content(thinking) / tool_calls 累积、
// 非 SSE 降级、以及 abort 中断。

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

/** 构造 Anthropic SSE mock 响应（每个元素已包含 event: 行 + data: 行） */
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

describe('chatStream — OpenAI SSE', () => {
  it('解析 text delta', async () => {
    const chunks = [
      { choices: [{ delta: { content: 'Hello' }, index: 0 }] },
      { choices: [{ delta: { content: ' world' }, index: 0 }] },
      { choices: [{ finish_reason: 'stop', delta: {}, index: 0 }] },
    ];
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(mockOpenAISSE(chunks));

    const provider = createLLMProvider({ model: 'gpt-4', baseUrl: 'https://api.openai.com/v1' }, 'sk-test');
    const deltas: StreamDelta[] = [];
    for await (const d of provider.chatStream!(
      [{ role: 'user', content: 'hi' }],
      undefined,
      new AbortController().signal,
    )) {
      deltas.push(d);
    }
    const textDeltas = deltas.filter((d) => d.type === 'text');
    expect(textDeltas).toHaveLength(2);
    expect((textDeltas[0] as { content: string }).content).toBe('Hello');
    expect((textDeltas[1] as { content: string }).content).toBe(' world');
    const done = deltas.find((d) => d.type === 'done');
    expect(done).toBeDefined();
    expect((done as { finishReason: string }).finishReason).toBe('stop');
  });

  it('解析 reasoning_content delta 为 thinking', async () => {
    const chunks = [
      { choices: [{ delta: { reasoning_content: '思考中' }, index: 0 }] },
      { choices: [{ delta: { content: '回答' }, index: 0 }] },
      { choices: [{ finish_reason: 'stop', delta: {}, index: 0 }] },
    ];
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(mockOpenAISSE(chunks));

    const provider = createLLMProvider({ model: 'o1', baseUrl: 'https://api.openai.com/v1' }, 'sk-test');
    const deltas: StreamDelta[] = [];
    for await (const d of provider.chatStream!(
      [{ role: 'user', content: 'hi' }],
      undefined,
      new AbortController().signal,
    )) {
      deltas.push(d);
    }
    const thinking = deltas.filter((d) => d.type === 'thinking');
    expect(thinking).toHaveLength(1);
    expect((thinking[0] as { content: string }).content).toBe('思考中');
  });

  it('解析 tool_calls delta 并累积为完整 tool_use', async () => {
    const chunks = [
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read_file', arguments: '' } }] }, index: 0 }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":"a.ts"}' } }] }, index: 0 }] },
      { choices: [{ finish_reason: 'tool_calls', delta: {}, index: 0 }] },
    ];
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(mockOpenAISSE(chunks));

    const provider = createLLMProvider({ model: 'gpt-4', baseUrl: 'https://api.openai.com/v1' }, 'sk-test');
    const deltas: StreamDelta[] = [];
    for await (const d of provider.chatStream!(
      [{ role: 'user', content: 'hi' }],
      [{ name: 'read_file', description: '', inputSchema: { type: 'object', properties: {} } }],
      new AbortController().signal,
    )) {
      deltas.push(d);
    }
    const toolUse = deltas.find((d) => d.type === 'tool_use');
    expect(toolUse).toBeDefined();
    const tc = (toolUse as { toolCall: { id: string; name: string; arguments: Record<string, unknown> } }).toolCall;
    expect(tc.id).toBe('call_1');
    expect(tc.name).toBe('read_file');
    expect(tc.arguments).toEqual({ path: 'a.ts' });
  });

  it('非 SSE 响应自动降级到 chat()', async () => {
    // 返回普通 JSON（非 event-stream）
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({
        choices: [{ message: { content: '完整回复' }, finish_reason: 'stop' }],
      }), { headers: { 'content-type': 'application/json' } }),
    );

    const provider = createLLMProvider({ model: 'gpt-4', baseUrl: 'https://api.openai.com/v1' }, 'sk-test');
    const deltas: StreamDelta[] = [];
    for await (const d of provider.chatStream!(
      [{ role: 'user', content: 'hi' }],
      undefined,
      new AbortController().signal,
    )) {
      deltas.push(d);
    }
    const text = deltas.filter((d) => d.type === 'text');
    expect(text).toHaveLength(1);
    expect((text[0] as { content: string }).content).toBe('完整回复');
  });

  it('abort 信号中断迭代', async () => {
    const ac = new AbortController();
    const body = `data: ${JSON.stringify({ choices: [{ delta: { content: 'H' }, index: 0 }] })}\n\n`;
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(body));
        // 不 close，模拟持续流
      },
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(stream, { headers: { 'content-type': 'text/event-stream' } }),
    );

    const provider = createLLMProvider({ model: 'gpt-4', baseUrl: 'https://api.openai.com/v1' }, 'sk-test');
    const iter = provider.chatStream!(
      [{ role: 'user', content: 'hi' }],
      undefined,
      ac.signal,
    );
    // 读第一个 delta
    const first = await iter.next();
    expect(first.value.type).toBe('text');
    // abort
    ac.abort();
    // 下一次 next 应该抛 AbortError
    await expect(iter.next()).rejects.toThrow();
  });
});

describe('chatStream — Anthropic SSE', () => {
  it('解析 text_delta 为 text 流', async () => {
    const events = [
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' world' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_stop' },
    ];
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(mockAnthropicSSE(events));

    const provider = createLLMProvider(
      { model: 'claude-sonnet-4-20250514', baseUrl: 'https://api.anthropic.com' },
      'sk-ant-test',
    );
    const deltas: StreamDelta[] = [];
    for await (const d of provider.chatStream!(
      [{ role: 'user', content: 'hi' }],
      undefined,
      new AbortController().signal,
    )) {
      deltas.push(d);
    }
    const textDeltas = deltas.filter((dd) => dd.type === 'text');
    expect(textDeltas).toHaveLength(2);
    expect((textDeltas[0] as { content: string }).content).toBe('Hello');
    expect((textDeltas[1] as { content: string }).content).toBe(' world');
    const done = deltas.find((dd) => dd.type === 'done');
    expect(done).toBeDefined();
    expect((done as { finishReason: string }).finishReason).toBe('stop');
  });

  it('解析 thinking_delta 为 thinking 流', async () => {
    const events = [
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '先分析' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '一下问题' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '回答' } },
      { type: 'content_block_stop', index: 1 },
      { type: 'message_stop' },
    ];
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(mockAnthropicSSE(events));

    const provider = createLLMProvider(
      { model: 'claude-sonnet-4-20250514', baseUrl: 'https://api.anthropic.com' },
      'sk-ant-test',
    );
    const deltas: StreamDelta[] = [];
    for await (const d of provider.chatStream!(
      [{ role: 'user', content: 'hi' }],
      undefined,
      new AbortController().signal,
    )) {
      deltas.push(d);
    }
    const thinking = deltas.filter((dd) => dd.type === 'thinking');
    expect(thinking).toHaveLength(2);
    expect((thinking[0] as { content: string }).content).toBe('先分析');
    expect((thinking[1] as { content: string }).content).toBe('一下问题');
  });

  it('累积 tool_use 的 input_json_delta 为完整 toolCall', async () => {
    const events = [
      // text 块（可省略，但 Anthropic 通常 text + tool_use 并存）
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '我来读文件' } },
      { type: 'content_block_stop', index: 0 },
      // tool_use 块：start 记录 id/name；后续 input_json_delta 累积 arguments
      {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: {} },
      },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"a.ts"}' } },
      { type: 'content_block_stop', index: 1 },
      { type: 'message_stop' },
    ];
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(mockAnthropicSSE(events));

    const provider = createLLMProvider(
      { model: 'claude-sonnet-4-20250514', baseUrl: 'https://api.anthropic.com' },
      'sk-ant-test',
    );
    const deltas: StreamDelta[] = [];
    for await (const d of provider.chatStream!(
      [{ role: 'user', content: 'hi' }],
      [{ name: 'read_file', description: '', inputSchema: { type: 'object', properties: {} } }],
      new AbortController().signal,
    )) {
      deltas.push(d);
    }
    const toolUse = deltas.find((dd) => dd.type === 'tool_use');
    expect(toolUse).toBeDefined();
    const tc = (toolUse as { toolCall: { id: string; name: string; arguments: Record<string, unknown> } }).toolCall;
    expect(tc.id).toBe('toolu_1');
    expect(tc.name).toBe('read_file');
    expect(tc.arguments).toEqual({ path: 'a.ts' });
    const done = deltas.find((dd) => dd.type === 'done');
    expect(done).toBeDefined();
    expect((done as { finishReason: string }).finishReason).toBe('tool_use');
  });
});
