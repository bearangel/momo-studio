// electron/src/main/agent/llm-provider.ts
//
// 统一的 LLM provider 抽象层。对外暴露 createLLMProvider 工厂 + LLMProvider 接口，
// 内部按 model.provider 分派到 OpenAI / Anthropic 两个实现。
// 两家实现都直接走 fetch + 各自的 REST API（不引入官方 SDK），便于裁剪依赖、统一错误处理。
// Anthropic 的两点特殊语义已在此封装：
//   1. system 是请求体顶层字段，不在 messages 数组里
//   2. tool_use 返回在 content 数组中（type: 'tool_use'），需扁平化为 LLMToolCall

import type { ModelRef } from './types';

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

/** 统一 provider 接口 */
export interface LLMProvider {
  chat(messages: LLMMessage[], tools?: LLMToolDef[]): Promise<LLMResponse>;
}

/** 统一的 LLM provider 工厂：按 model.provider 选择实现 */
export function createLLMProvider(model: ModelRef, apiKey: string): LLMProvider {
  if (model.provider === 'openai') {
    return new OpenAIProvider(model.model, apiKey);
  }
  if (model.provider === 'anthropic') {
    return new AnthropicProvider(model.model, apiKey);
  }
  throw new Error(`不支持的 LLM provider: ${model.provider}`);
}

// --- OpenAI 实现 ---

class OpenAIProvider implements LLMProvider {
  constructor(private model: string, private apiKey: string) {}

  async chat(messages: LLMMessage[], tools?: LLMToolDef[]): Promise<LLMResponse> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: messages.map((m) => this.toOpenAIMessage(m)),
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

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
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

  /** 把统一 LLMMessage 映射为 OpenAI 的 messages 元素格式 */
  private toOpenAIMessage(m: LLMMessage): Record<string, unknown> {
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
}

// --- Anthropic 实现 ---

class AnthropicProvider implements LLMProvider {
  constructor(private model: string, private apiKey: string) {}

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

    const response = await fetch('https://api.anthropic.com/v1/messages', {
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
}
