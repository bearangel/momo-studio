// electron/tests/agent/llm-provider-thinking.test.ts
//
// wire 方言 × mode 请求体快照测试（spec §5.2 映射表唯一真相源）。
// mock 全局 fetch 捕获请求体（momo-test-rules：断言真实序列化产物）。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createLLMProvider, applyOpenAIThinking, applyAnthropicThinking } from '../../src/main/agent/llm-provider';
import type { ThinkingRequest } from '../../src/main/llm/provider-presets';

const bodies: Array<Record<string, unknown>> = [];

beforeEach(() => {
  bodies.length = 0;
  vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    // 响应体同时含 OpenAI（choices）与 Anthropic（content/stop_reason）形状——
    // 两个 provider 各取所需，断言焦点在请求体（bodies[0]）而非响应解析
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'stop',
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }));
});

function tr(partial: Partial<ThinkingRequest> & { wire: ThinkingRequest['wire'] }): ThinkingRequest {
  return { kind: 'effort', mode: 'on', effort: 'high', ...partial };
}

describe('applyOpenAIThinking：方言 × mode 映射表', () => {
  const cases: Array<[string, ThinkingRequest | undefined, Record<string, unknown>]> = [
    ['toggle off', tr({ wire: 'toggle', kind: 'toggle', mode: 'off', effort: null }), { thinking: { type: 'disabled' } }],
    ['toggle on', tr({ wire: 'toggle', kind: 'toggle', mode: 'on', effort: null }), { thinking: { type: 'enabled' } }],
    ['toggle-effort on+effort', tr({ wire: 'toggle-effort' }), { thinking: { type: 'enabled' }, reasoning_effort: 'high' }],
    ['toggle-effort off', tr({ wire: 'toggle-effort', mode: 'off', effort: null }), { thinking: { type: 'disabled' } }],
    ['effort on', tr({ wire: 'effort' }), { reasoning_effort: 'high' }],
    ['effort off（不发参数）', tr({ wire: 'effort', mode: 'off', effort: null }), {}],
    ['auto（不发参数）', tr({ wire: 'toggle-effort', mode: 'auto', effort: null }), {}],
    ['kind none（不发参数）', { wire: 'effort', kind: 'none', mode: 'on', effort: null }, {}],
    ['undefined（不发参数）', undefined, {}],
  ];
  for (const [name, t, expected] of cases) {
    it(name, () => {
      const body: Record<string, unknown> = { model: 'm', messages: [] };
      applyOpenAIThinking(body, t);
      expect(body).toEqual({ model: 'm', messages: [], ...expected });
    });
  }
});

describe('applyAnthropicThinking：budget 阶梯 + max_tokens 抬升', () => {
  it('on + low/medium/high → budget 4096/10000/32768；max_tokens > budget', () => {
    for (const [effort, budget] of [['low', 4096], ['medium', 10000], ['high', 32768]] as const) {
      const body: Record<string, unknown> = { model: 'm', max_tokens: 4096, messages: [] };
      applyAnthropicThinking(body, tr({ wire: 'anthropic-budget', effort }));
      expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: budget });
      expect(body.max_tokens as number).toBeGreaterThan(budget);
    }
  });
  it('auto / off / kind none / undefined → 不发 thinking 且 max_tokens 不动', () => {
    const cases: Array<ThinkingRequest | undefined> = [
      undefined,
      tr({ wire: 'anthropic-budget', mode: 'auto', effort: null }),
      tr({ wire: 'anthropic-budget', mode: 'off', effort: null }),
      { wire: 'anthropic-budget', kind: 'none', mode: 'on', effort: null },
    ];
    for (const t of cases) {
      const body: Record<string, unknown> = { model: 'm', max_tokens: 4096, messages: [] };
      applyAnthropicThinking(body, t);
      expect(body.thinking).toBeUndefined();
      expect(body.max_tokens).toBe(4096);
    }
  });
});

describe('createLLMProvider 端到端注入（chat 非流式）', () => {
  it('openai 方言 toggle-effort：请求体含 thinking + reasoning_effort', async () => {
    const llm = createLLMProvider(
      { model: 'glm-5.3', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', provider: 'openai' },
      'k',
      { thinking: tr({ wire: 'toggle-effort' }) },
    );
    await llm.chat([{ role: 'user', content: 'hi' }]);
    expect(bodies[0]).toMatchObject({ thinking: { type: 'enabled' }, reasoning_effort: 'high' });
  });

  it('anthropic 方言：thinking + max_tokens 抬升', async () => {
    const llm = createLLMProvider(
      { model: 'claude-sonnet-4-5', provider: 'anthropic' },
      'k',
      { thinking: tr({ wire: 'anthropic-budget', effort: 'low' }) },
    );
    await llm.chat([{ role: 'user', content: 'hi' }]);
    expect(bodies[0]).toMatchObject({ thinking: { type: 'enabled', budget_tokens: 4096 } });
    expect(bodies[0]!.max_tokens as number).toBeGreaterThan(4096);
  });

  it('无 thinking（既有调用点兼容）：请求体无 thinking 字段', async () => {
    const llm = createLLMProvider({ model: 'gpt-4o', provider: 'openai' }, 'k');
    await llm.chat([{ role: 'user', content: 'hi' }]);
    expect(bodies[0]!.thinking).toBeUndefined();
    expect(bodies[0]!.reasoning_effort).toBeUndefined();
  });
});

describe('chatStream 流式注入（SSE mock）', () => {
  it('openai 流式请求体同样注入 thinking', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response('data: [DONE]\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    }));
    const llm = createLLMProvider(
      { model: 'glm-5.3', provider: 'openai' },
      'k',
      { thinking: tr({ wire: 'toggle-effort' }) },
    );
    for await (const d of llm.chatStream(
      [{ role: 'user', content: 'hi' }],
      undefined,
      new AbortController().signal,
    )) {
      void d;
    }
    expect(bodies[0]).toMatchObject({ thinking: { type: 'enabled' }, reasoning_effort: 'high' });
  });
});

describe('chatStream anthropic 注入（行为变更锁：旧 always-on thinking:10000 硬编码退役）', () => {
  it('anthropic 流式 + thinking on+low：请求体含 budget_tokens=4096 且 max_tokens 抬升', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response('data: [DONE]\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    }));
    const llm = createLLMProvider(
      { model: 'claude-sonnet-4-5', provider: 'anthropic' },
      'k',
      { thinking: tr({ wire: 'anthropic-budget', effort: 'low' }) },
    );
    for await (const d of llm.chatStream(
      [{ role: 'user', content: 'hi' }],
      undefined,
      new AbortController().signal,
    )) {
      void d;
    }
    expect(bodies[0]).toMatchObject({ thinking: { type: 'enabled', budget_tokens: 4096 } });
    expect(bodies[0]!.max_tokens as number).toBeGreaterThan(4096);
  });

  it('anthropic 流式 + 未配置 thinking：请求体无 thinking 字段（Anthropic 用户默认不再发 thinking）', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response('data: [DONE]\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    }));
    const llm = createLLMProvider({ model: 'claude-sonnet-4-5', provider: 'anthropic' }, 'k');
    for await (const d of llm.chatStream(
      [{ role: 'user', content: 'hi' }],
      undefined,
      new AbortController().signal,
    )) {
      void d;
    }
    expect(bodies[0]!.thinking).toBeUndefined();
    // 不注入时 max_tokens 保持 chatStreamAnthropic 基础档 16384（未被 budget 逻辑抬升）
    expect(bodies[0]!.max_tokens).toBe(16384);
  });
});
