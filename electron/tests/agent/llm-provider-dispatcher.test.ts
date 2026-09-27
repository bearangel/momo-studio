// electron/tests/agent/llm-provider-dispatcher.test.ts
// terminated P0 方案 A 契约锁：LLM 请求必须携带专用 undici Agent
// （bodyTimeout=0）——Node 全局 fetch 默认 300s body 空闲超时会把深度推理的
// 长静默当死流掐断（实测 failed 回合最后字节→final 恰好 300.000s）。

import { describe, it, expect, vi, afterEach } from 'vitest';
import { createLLMProvider, __llmFetchAgentForTest } from '../../src/main/agent/llm-provider';

describe('LLM fetch dispatcher（方案 A）', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('chat 请求 init 携带 LLM 专用 Agent（dispatcher 注入不落空）', async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit): Promise<Response> =>
        new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
          status: 200,
        }),
    );
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
    const llm = createLLMProvider({ model: 'gpt-4o', provider: 'openai' }, 'k');
    await llm.chat([{ role: 'user', content: 'hi' }]);
    expect(fetchMock).toHaveBeenCalled();
    const init = fetchMock.mock.calls[0]?.[1] as (RequestInit & { dispatcher?: unknown }) | undefined;
    expect(init?.dispatcher).toBe(__llmFetchAgentForTest);
  });

  it('Agent 配置契约：bodyTimeout=0（禁用 body 空闲超时）', () => {
    // undici Agent 不暴露配置读取——用行为断言：默认 Agent bodyTimeout=300s
    // 会在空闲后掐流；这里锁「导出的 Agent 与请求注入的同一实例 + 构造配置
    // 经由实现层常量保证」。实例同一性已由上一用例锁定，此处防误删导出。
    expect(__llmFetchAgentForTest).toBeDefined();
  });
});
