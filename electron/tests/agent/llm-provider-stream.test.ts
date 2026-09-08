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

// ────────────────────────────────────────────────────────────────────────────
// 2026-09-08 主机 bug 回归锁：chatStream 建立阶段 429 直停（无指数退避重试）
//
// 根因：流式路径刻意绕过 fetchWithRetry（其 AbortSignal.timeout 会覆盖调用方
// signal），429 在「响应头阶段」失败——零 delta 已发出，重试完全安全——却直接
// 抛错终止 agent。新契约：重试只覆盖「建连 + 响应头」（fetchWithRetry 内部
// 超时在响应头到达即清除，流式 body 读取只受调用方 signal 控制）；进入流
// 消费阶段后不再重试（重复 delta 语义无意义）。
describe('chatStream — 建立阶段指数退避重试', () => {
  it('首个 429 → 第二次 SSE 200：重试后正常收到 delta（主机场景：模型访问量过大）', async () => {
    vi.useFakeTimers();
    try {
      const chunks = [
        { choices: [{ delta: { content: '恢复' }, index: 0 }] },
        { choices: [{ finish_reason: 'stop', delta: {}, index: 0 }] },
      ];
      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce({ ok: false, status: 429, text: async () => '{"error":{"code":"1305","message":"该模型当前访问量过大"}}' } as unknown as Response)
        .mockResolvedValueOnce(mockOpenAISSE(chunks));

      const provider = createLLMProvider({ model: 'glm-4', baseUrl: 'https://open.bigmodel.cn/v1' }, 'key');
      const deltas: StreamDelta[] = [];
      const iter = provider.chatStream!([{ role: 'user', content: 'hi' }], undefined, new AbortController().signal);
      const p = (async () => { for await (const d of iter) deltas.push(d); })();
      await vi.advanceTimersByTimeAsync(1100);
      await p;

      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(deltas.filter((d) => d.type === 'text')).toHaveLength(1);
      expect(deltas.find((d) => d.type === 'done')).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('429 带 Retry-After: 3 → 退避尊重服务端指示（3s 后才发起第二次请求）', async () => {
    vi.useFakeTimers();
    try {
      const chunks = [{ choices: [{ finish_reason: 'stop', delta: {}, index: 0 }] }];
      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce({ ok: false, status: 429, headers: { get: () => '3' }, text: async () => '' } as unknown as Response)
        .mockResolvedValueOnce(mockOpenAISSE(chunks));

      const provider = createLLMProvider({ model: 'glm-4' }, 'key');
      const iter = provider.chatStream!([{ role: 'user', content: 'hi' }], undefined, new AbortController().signal);
      const p = (async () => { for await (const _ of iter) void _; })();

      await vi.advanceTimersByTimeAsync(1000); // 指数退避第 1 档只到 1s——Retry-After=3 未到
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(2100);
      await p;
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('重试退避期间调用方 abort → AbortError 立即上抛，不再发起第二次请求', async () => {
    vi.useFakeTimers();
    try {
      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce({ ok: false, status: 429, text: async () => '' } as unknown as Response);

      const provider = createLLMProvider({ model: 'glm-4' }, 'key');
      const ctrl = new AbortController();
      const iter = provider.chatStream!([{ role: 'user', content: 'hi' }], undefined, ctrl.signal);
      const p = (async () => { for await (const _ of iter) void _; })();
      p.catch(() => {});
      // 显式 flush 微任务链：确保已走到退避睡眠挂起点（advanceTimersByTimeAsync
      // 在无 timer 到期时不 flush 微任务，链条可能仍停在 fetch resolve 后）
      await vi.advanceTimersByTimeAsync(0);
      await Promise.resolve();
      await Promise.resolve();
      ctrl.abort(); // 仍在第 1 次退避等待中
      await vi.advanceTimersByTimeAsync(5000);
      await expect(p).rejects.toThrow();
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('建立阶段网络异常 → 重试恢复（cause 语义保留在最终错误里）', async () => {
    vi.useFakeTimers();
    try {
      const chunks = [{ choices: [{ finish_reason: 'stop', delta: {}, index: 0 }] }];
      const fetchSpy = vi.spyOn(globalThis, 'fetch')
        .mockRejectedValueOnce(new Error('fetch failed'))
        .mockResolvedValueOnce(mockOpenAISSE(chunks));

      const provider = createLLMProvider({ model: 'glm-4', baseUrl: 'https://x.example/v1' }, 'key');
      const iter = provider.chatStream!([{ role: 'user', content: 'hi' }], undefined, new AbortController().signal);
      const p = (async () => { for await (const _ of iter) void _; })();
      await vi.advanceTimersByTimeAsync(1100);
      await p;
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
