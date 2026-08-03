// electron/src/main/agent/llm-provider.ts
//
// 统一的 LLM provider 抽象层。对外暴露 createLLMProvider 工厂 + LLMProvider 接口，
// 内部按 platform（显式传入或 baseUrl 自动检测）分派到 OpenAI / Anthropic 两个实现。
// 两家实现都直接走 fetch + 各自的 REST API（不引入官方 SDK），便于裁剪依赖、统一错误处理。
// Anthropic 的两点特殊语义已在此封装：
//   1. system 是请求体顶层字段，不在 messages 数组里
//   2. tool_use 返回在 content 数组中（type: 'tool_use'），需扁平化为 LLMToolCall

/** 对话消息（system / user / assistant / tool_result 四种角色的统一表示） */
export interface LLMMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** role='tool' 时关联的 tool call id（OpenAI 必填，Anthropic 映射为 tool_use_id） */
  toolCallId?: string;
  /** role='assistant' 时附带的工具调用列表 */
  toolCalls?: LLMToolCall[];
}

/** 一次工具调用（id + name + 已解析的参数对象） */
export interface LLMToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/** 工具定义（JSON Schema 风格的输入参数） */
export interface LLMToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** provider.chat 的返回值（已归一化，屏蔽 OpenAI / Anthropic 的差异） */
export interface LLMResponse {
  content: string;
  toolCalls: LLMToolCall[];
  finishReason: 'stop' | 'tool_use';
}

/** 流式 delta（从 SSE stream 归一化） */
export type StreamDelta =
  | { type: 'thinking'; content: string }
  | { type: 'text'; content: string }
  | { type: 'tool_use'; toolCall: LLMToolCall }
  | { type: 'done'; finishReason: 'stop' | 'tool_use' };

/** 统一 provider 接口 */
export interface LLMProvider {
  chat(messages: LLMMessage[], tools?: LLMToolDef[]): Promise<LLMResponse>;
  /** 流式接口；signal 用于中断 */
  chatStream(
    messages: LLMMessage[],
    tools: LLMToolDef[] | undefined,
    signal: AbortSignal,
  ): AsyncIterable<StreamDelta>;
}

/** 对 LLM API 的单次请求超时（毫秒）—— 复杂生成任务可能需要数分钟 */
const LLM_REQUEST_TIMEOUT_MS = 300_000;

/** 最大重试次数（初次请求 + 重试 = maxRetries+1 次总尝试） */
const MAX_LLM_RETRIES = 3;
/** 指数退避延迟：第 1 次重试等 1s，第 2 次等 2s，第 3 次等 4s */
const RETRY_DELAYS_MS = [1000, 2000, 4000];
/** 可重试的 HTTP 状态码（服务端错误 + 限流） */
const RETRYABLE_STATUS = new Set([429, 500, 502, 503]);

/**
 * 带指数退避重试的 fetch 包装。对可重试错误（429/500/502/503 + 网络异常）
 * 按 RETRY_DELAYS_MS 退避后重试；对客户端错误（400/401/403 等）直接返回
 * 响应（由调用方判断 !response.ok 后抛出业务异常，不浪费重试配额）。
 */
async function fetchWithRetry(
  url: string,
  options: RequestInit,
  maxRetries: number = MAX_LLM_RETRIES,
  timeoutMs: number = LLM_REQUEST_TIMEOUT_MS,
): Promise<Response> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      // 每次重试创建新的超时 signal（避免复用已 aborted 的 signal 导致重试瞬间失败）
      const response = await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
      if (response.ok || !RETRYABLE_STATUS.has(response.status)) {
        return response;
      }
      lastError = new Error(`HTTP ${response.status}`);
    } catch (err) {
      lastError = err as Error;
    }
    if (attempt < maxRetries) {
      const delay = RETRY_DELAYS_MS[attempt] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1]!;
      const statusCode = lastError.message.match(/HTTP (\d+)/)?.[1] ?? 'timeout';
      process.stdout.write(`→ LLM 重试 #${attempt + 1} (status=${statusCode}, 退避=${delay}ms)\n`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastError ?? new Error('LLM 请求失败（重试耗尽）');
}

/** 按 baseUrl 启发式检测 platform：anthropic.com 域名 → anthropic，其余 → openai（OpenAI 兼容） */
function detectPlatform(baseUrl?: string): 'openai' | 'anthropic' {
  if (baseUrl && baseUrl.includes('anthropic.com')) return 'anthropic';
  return 'openai';
}

/** 把统一 LLMMessage 映射为 OpenAI 的 messages 元素格式 */
function toOpenAIMessage(m: LLMMessage): Record<string, unknown> {
  if (m.role === 'tool' && m.toolCallId) {
    return { role: 'tool', content: m.content, tool_call_id: m.toolCallId };
  }
  if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
    return {
      role: 'assistant',
      content: m.content || null,
      tool_calls: m.toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function',
        function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
      })),
    };
  }
  return { role: m.role, content: m.content };
}

/** 统一的 LLM provider 工厂。
 *  platform 显式传入时优先用；缺省时按 baseUrl 自动检测（OpenAI 兼容为默认）。 */
export function createLLMProvider(
  model: { provider?: 'openai' | 'anthropic'; model: string; baseUrl?: string },
  apiKey: string,
): LLMProvider {
  const provider = model.provider ?? detectPlatform(model.baseUrl);
  if (provider === 'openai') {
    return new OpenAIProvider(model.model, apiKey, model.baseUrl);
  }
  if (provider === 'anthropic') {
    return new AnthropicProvider(model.model, apiKey, model.baseUrl);
  }
  throw new Error(`不支持的 LLM provider: ${provider}`);
}

// --- OpenAI 实现 ---

class OpenAIProvider implements LLMProvider {
  constructor(private model: string, private apiKey: string, private baseUrl?: string) {}

  async chat(messages: LLMMessage[], tools?: LLMToolDef[]): Promise<LLMResponse> {
    const apiUrl = this.baseUrl
      ? `${this.baseUrl}/chat/completions`
      : 'https://api.openai.com/v1/chat/completions';
    const body: Record<string, unknown> = {
      model: this.model,
      messages: messages.map((m) => toOpenAIMessage(m)),
    };
    if (tools && tools.length > 0) {
      body.tools = tools.map((t) => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.inputSchema,
        },
      }));
    }

    const response = await fetchWithRetry(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`OpenAI API 错误 ${response.status}: ${errText}`);
    }

    const data = (await response.json()) as {
      choices: Array<{
        message: {
          content: string | null;
          tool_calls?: Array<{
            id: string;
            function: { name: string; arguments: string };
          }>;
        };
        finish_reason: string;
      }>;
    };

    const choice = data.choices[0]!;
    const toolCalls: LLMToolCall[] = (choice.message.tool_calls ?? []).map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      arguments: JSON.parse(tc.function.arguments) as Record<string, unknown>,
    }));

    return {
      content: choice.message.content ?? '',
      toolCalls,
      finishReason: choice.finish_reason === 'tool_calls' ? 'tool_use' : 'stop',
    };
  }

  async *chatStream(
    messages: LLMMessage[],
    tools: LLMToolDef[] | undefined,
    signal: AbortSignal,
  ): AsyncIterable<StreamDelta> {
    yield* chatStreamOpenAI(this.model, this.baseUrl, this.apiKey, messages, tools, signal);
  }
}

// --- Anthropic 实现 ---

class AnthropicProvider implements LLMProvider {
  constructor(private model: string, private apiKey: string, private baseUrl?: string) {}

  async chat(messages: LLMMessage[], tools?: LLMToolDef[]): Promise<LLMResponse> {
    // Anthropic 把 system 单独传，messages 只含 user/assistant
    const systemMsg = messages.find((m) => m.role === 'system');
    const conversationMessages = messages.filter((m) => m.role !== 'system');

    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: 4096,
      messages: conversationMessages.map((m) => this.toAnthropicMessage(m)),
    };
    if (systemMsg) {
      body.system = systemMsg.content;
    }
    if (tools && tools.length > 0) {
      body.tools = tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema,
      }));
    }

    const apiUrl = `${this.baseUrl ?? 'https://api.anthropic.com'}/v1/messages`;
    const response = await fetchWithRetry(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Anthropic API 错误 ${response.status}: ${errText}`);
    }

    const data = (await response.json()) as {
      content: Array<
        | { type: 'text'; text: string }
        | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
      >;
      stop_reason: string;
    };

    const textParts = data.content.filter((c) => c.type === 'text').map((c) => (c as { text: string }).text);
    const toolUses = data.content.filter((c) => c.type === 'tool_use');

    return {
      content: textParts.join('\n'),
      toolCalls: toolUses.map((tu) => {
        const t = tu as { id: string; name: string; input: Record<string, unknown> };
        return { id: t.id, name: t.name, arguments: t.input };
      }),
      finishReason: data.stop_reason === 'tool_use' ? 'tool_use' : 'stop',
    };
  }

  /** 把统一 LLMMessage 映射为 Anthropic 的 messages 元素格式（tool_result 用 user 角色） */
  private toAnthropicMessage(m: LLMMessage): Record<string, unknown> {
    if (m.role === 'tool') {
      return {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: m.toolCallId,
            content: m.content,
          },
        ],
      };
    }
    if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
      return {
        role: 'assistant',
        content: [
          ...(m.content ? [{ type: 'text', text: m.content }] : []),
          ...m.toolCalls.map((tc) => ({
            type: 'tool_use',
            id: tc.id,
            name: tc.name,
            input: tc.arguments,
          })),
        ],
      };
    }
    return { role: m.role, content: m.content };
  }

  async *chatStream(
    messages: LLMMessage[],
    tools: LLMToolDef[] | undefined,
    signal: AbortSignal,
  ): AsyncIterable<StreamDelta> {
    yield* chatStreamAnthropic(this.model, this.baseUrl, this.apiKey, messages, tools, signal);
  }
}

// --- 流式实现（chatStream） ---

/**
 * OpenAI 兼容 SSE 流式解析。
 *
 * 直接使用 fetch（不经过 fetchWithRetry），原因：
 *  1. fetchWithRetry 会用 AbortSignal.timeout 覆盖调用方 signal，使 abort 无法传播到 response.body
 *  2. 流式响应已部分消费后重试会产生重复 delta，语义上无意义
 *
 * abort 支持通过 Promise.race 实现：将 reader.read() 与一个在 signal abort 时 reject 的 promise 竞速。
 * （fetch 被 mock 时不连接 signal 到 response.body，必须显式竞速才能中断读取。）
 */
async function* chatStreamOpenAI(
  model: string,
  baseUrl: string | undefined,
  apiKey: string,
  messages: LLMMessage[],
  tools: LLMToolDef[] | undefined,
  signal: AbortSignal,
): AsyncIterable<StreamDelta> {
  const url = `${baseUrl ?? 'https://api.openai.com/v1'}/chat/completions`;
  const body: Record<string, unknown> = {
    model,
    messages: messages.map(toOpenAIMessage),
    stream: true,
  };
  if (tools && tools.length > 0) {
    body.tools = tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.inputSchema },
    }));
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`LLM 流式请求失败: HTTP ${response.status} ${errText}`);
  }

  // 非 SSE → 降级到非流式解析（整条 JSON 一次性返回）
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('text/event-stream')) {
    const json = (await response.json()) as {
      choices?: { message?: { content?: string }; finish_reason?: string }[];
    };
    const content = json.choices?.[0]?.message?.content ?? '';
    if (content) yield { type: 'text', content };
    yield { type: 'done', finishReason: 'stop' };
    return;
  }

  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  // tool_calls 累积器：按 index 合并 arguments fragment（OpenAI 把参数拆成多个 delta 发送）
  const toolCallMap = new Map<number, { id: string; name: string; argsBuffer: string }>();
  let finishReason: 'stop' | 'tool_use' = 'stop';

  const abortPromise = buildAbortPromise(signal);

  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), abortPromise]);
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? ''; // 最后一条可能不完整，留到下次拼接

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') continue;
        let parsed: { choices?: { delta?: Record<string, unknown>; finish_reason?: string }[] };
        try {
          parsed = JSON.parse(data);
        } catch {
          continue;
        }
        const choice = parsed.choices?.[0];
        if (!choice) continue;

        // thinking（reasoning_content — DeepSeek / OpenAI o1 系列的思维链）
        const reasoning = (choice.delta as { reasoning_content?: string })?.reasoning_content;
        if (typeof reasoning === 'string' && reasoning.length > 0) {
          yield { type: 'thinking', content: reasoning };
        }

        // 正文文本
        const text = (choice.delta as { content?: string })?.content;
        if (typeof text === 'string' && text.length > 0) {
          yield { type: 'text', content: text };
        }

        // tool_calls 累积（按 index 合并 id / name / arguments fragments）
        const toolCallsRaw = (
          choice.delta as {
            tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[];
          }
        )?.tool_calls;
        if (Array.isArray(toolCallsRaw)) {
          for (const tc of toolCallsRaw) {
            const existing = toolCallMap.get(tc.index);
            if (existing) {
              existing.argsBuffer += tc.function?.arguments ?? '';
            } else {
              toolCallMap.set(tc.index, {
                id: tc.id ?? '',
                name: tc.function?.name ?? '',
                argsBuffer: tc.function?.arguments ?? '',
              });
            }
          }
        }

        if (choice.finish_reason === 'tool_calls') finishReason = 'tool_use';
        if (choice.finish_reason === 'stop') finishReason = 'stop';
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }

  // 流结束后发出累积完整的 tool_use delta
  for (const [, tc] of toolCallMap) {
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(tc.argsBuffer || '{}');
    } catch {
      args = { _raw: tc.argsBuffer };
    }
    yield { type: 'tool_use', toolCall: { id: tc.id, name: tc.name, arguments: args } };
  }

  yield { type: 'done', finishReason };
}

/**
 * Anthropic SSE 流式解析（含 thinking 支持）。
 * Anthropic 的 SSE 事件类型：
 *  - content_block_start: 标记 text / thinking / tool_use 块开始
 *  - content_block_delta: 增量内容（thinking_delta / text_delta / input_json_delta）
 *  - message_stop: 消息结束
 */
async function* chatStreamAnthropic(
  model: string,
  baseUrl: string | undefined,
  apiKey: string,
  messages: LLMMessage[],
  tools: LLMToolDef[] | undefined,
  signal: AbortSignal,
): AsyncIterable<StreamDelta> {
  const url = `${baseUrl ?? 'https://api.anthropic.com'}/v1/messages`;
  const body: Record<string, unknown> = {
    model,
    // max_tokens 必须大于 thinking.budget_tokens（10000），否则 Anthropic 报 400
    max_tokens: 16384,
    stream: true,
    messages: messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: m.content,
      })),
  };
  const systemMsg = messages.find((m) => m.role === 'system');
  if (systemMsg) body.system = systemMsg.content;

  // 开启 thinking（Claude extended thinking）
  body.thinking = { type: 'enabled', budget_tokens: 10000 };

  if (tools && tools.length > 0) {
    body.tools = tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema,
    }));
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`Anthropic 流式请求失败: HTTP ${response.status} ${errText}`);
  }

  // 非 SSE → 降级
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('text/event-stream')) {
    const json = (await response.json()) as { content?: { type: string; text?: string }[] };
    const text = json.content?.find((b) => b.type === 'text')?.text ?? '';
    if (text) yield { type: 'text', content: text };
    yield { type: 'done', finishReason: 'stop' };
    return;
  }

  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  // tool_use 累积：content_block index → { id, name, argsBuffer }
  const toolUseMap = new Map<number, { id: string; name: string; argsBuffer: string }>();
  let finishReason: 'stop' | 'tool_use' = 'stop';

  const abortPromise = buildAbortPromise(signal);

  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), abortPromise]);
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (!data) continue;
        let event: {
          type: string;
          delta?: Record<string, unknown>;
          content_block?: Record<string, unknown>;
          index?: number;
        };
        try {
          event = JSON.parse(data);
        } catch {
          continue;
        }

        if (event.type === 'content_block_delta') {
          const deltaType = (event.delta as { type?: string })?.type;
          if (deltaType === 'thinking_delta') {
            const thinking = (event.delta as { thinking?: string })?.thinking;
            if (thinking) yield { type: 'thinking', content: thinking };
          }
          if (deltaType === 'text_delta') {
            const text = (event.delta as { text?: string })?.text;
            if (text) yield { type: 'text', content: text };
          }
          if (deltaType === 'input_json_delta') {
            const partial = (event.delta as { partial_json?: string })?.partial_json;
            if (partial && event.index !== undefined) {
              const existing = toolUseMap.get(event.index);
              if (existing) existing.argsBuffer += partial;
            }
          }
        }

        // tool_use 块开始——记录 id / name，后续 input_json_delta 填充 arguments
        if (event.type === 'content_block_start' && event.content_block) {
          const cb = event.content_block as { type?: string; id?: string; name?: string };
          if (cb.type === 'tool_use' && event.index !== undefined) {
            toolUseMap.set(event.index, {
              id: cb.id ?? '',
              name: cb.name ?? '',
              argsBuffer: '',
            });
            finishReason = 'tool_use';
          }
        }
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }

  for (const [, tc] of toolUseMap) {
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(tc.argsBuffer || '{}');
    } catch {
      args = { _raw: tc.argsBuffer };
    }
    yield { type: 'tool_use', toolCall: { id: tc.id, name: tc.name, arguments: args } };
  }

  yield { type: 'done', finishReason };
}

/**
 * 构造一个在 signal abort 时 reject 的 promise，用于与 reader.read() 竞速实现中断。
 * 如果 signal 已 abort，promise 立即 reject。
 */
function buildAbortPromise(signal: AbortSignal): Promise<never> {
  return new Promise<never>((_, reject) => {
    if (signal.aborted) {
      const e = new Error('流式请求被中断');
      e.name = 'AbortError';
      reject(e);
      return;
    }
    signal.addEventListener(
      'abort',
      () => {
        const e = new Error('流式请求被中断');
        e.name = 'AbortError';
        reject(e);
      },
      { once: true },
    );
  });
}
