// electron/src/main/agent/tools/todo-tools.ts
// v1.5 todowrite 工具：全量替换协议的任务列表管理。
//
// 设计要点：
//   - 全量替换：每次调用传完整 todos 数组，无增量/补丁语义（与 Claude Code todowrite 对齐）。
//     简化 agent 心智模型——LLM 不需要记住"当前列表+差异"，每次重写整张表。
//   - 会话级隔离：todoStore 按 streamSessionId 索引，每个流式会话独立维护一份列表，
//     不同任务/不同子 agent 不串数据。会话结束（renderer 收到 end chunk 后）由
//     renderer 侧清理临时态；服务端 store 保留至进程退出（轻量、可观察）。
//   - 输入校验：subject 非空 + ≤200 字符；status 三态枚举；列表 ≤30 项。
//   - 持久化：通过 sendStreamChunk('todo_update') 实时推送给 renderer；
//     会话结束时 sendFinalMessage 把最终 todos 写入 Matrix 历史的
//     `io.momo-studio.todos` 字段（重启后可还原）。

import { randomUUID } from 'node:crypto';
import type { LLMToolDef } from '../llm-provider';
import type { StreamChunk } from '../stream-chunk';
import type { ToolContext, ToolModule } from './types';
import type { TodoItem } from './todo-types';

/** subject 字段最大字符数——超过即拒绝（防 LLM 把整段需求塞进单条任务） */
const MAX_SUBJECT_LEN = 200;
/** 单个会话的任务列表上限——超过即拒绝（防 LLM 失控膨胀，也保护渲染性能） */
const MAX_TODO_COUNT = 30;

/**
 * 会话级任务存储。Map key 是 streamSessionId（每条用户消息分配新 UUID）。
 *
** 模块级单例**——整个 agent 子进程共享。子进程是 per-instance 的（每个 agent 一个
 * fork），所以不存在跨 agent 串扰；同进程内不同 streamSessionId 天然隔离。
 */
const todoStore = new Map<string, TodoItem[]>();

/**
 * 读取指定流式会话的当前任务列表（只读视图）。runtime-entry.sendFinalMessage 用此函数
 * 把最终 todos 写入 Matrix 持久化字段。
 */
export function getTodosForSession(streamSessionId: string): TodoItem[] {
  return todoStore.get(streamSessionId) ?? [];
}

/** 把 unknown 归一化为非空 string；非 string 或缺失则抛错。各字段校验共用。 */
function parseStringArg(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new Error(`参数 "${name}" 缺失或不是字符串`);
  return value;
}

/**
 * todowrite 工具模块（v1.5）。仅 1 个工具：`todowrite`。
 *
 * 返回给 LLM 的结构化摘要格式（便于 LLM 自我感知进度）：
 *   ```
 *   当前任务列表（N/M 完成）:
 *   1. [x] 已完成项
 *   2. [>] 进行中项
 *   3. [ ] 待办项
 *   ```
 * 其中 status 图标：completed='x' / in_progress='>' / pending=' '。
 */
export class TodoTools implements ToolModule {
  getDefs(): LLMToolDef[] {
    return [
      {
        name: 'todowrite',
        description:
          '管理任务列表。每次调用传完整 todos 数组（全量替换）。复杂任务（≥3 步骤）建议先创建列表跟踪进度。建议同时仅一项 in_progress。',
        inputSchema: {
          type: 'object',
          properties: {
            todos: {
              type: 'array',
              description: '完整任务列表（覆盖现有）。空数组 = 清空',
              items: {
                type: 'object',
                properties: {
                  subject: {
                    type: 'string',
                    description: '任务标题（建议 ≤ 60 字符，硬上限 200）',
                  },
                  status: {
                    type: 'string',
                    enum: ['pending', 'in_progress', 'completed'],
                  },
                },
                required: ['subject', 'status'],
              },
            },
          },
          required: ['todos'],
        },
      },
    ];
  }

  handles(name: string): boolean {
    return name === 'todowrite';
  }

  /** 测试钩子：读取指定会话的当前 todos（断言用）。 */
  getTodos(streamSessionId: string): TodoItem[] {
    return todoStore.get(streamSessionId) ?? [];
  }

  async execute(
    name: string,
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<string> {
    if (name !== 'todowrite') throw new Error(`未知 todo 工具: ${name}`);
    if (!Array.isArray(args.todos)) throw new Error('参数 "todos" 缺失或不是数组');

    // 先逐项校验并生成 id（任一失败立即抛错，store 不变）
    const newTodos: TodoItem[] = args.todos.map((t, i) => {
      const item = t as { subject?: unknown; status?: unknown };
      const subject = parseStringArg(item?.subject, `todos[${i}].subject`);
      const status = item?.status;
      if (
        status !== 'pending' &&
        status !== 'in_progress' &&
        status !== 'completed'
      ) {
        throw new Error(
          `todos[${i}].status 必须是 pending/in_progress/completed，实际: ${String(status)}`,
        );
      }
      if (subject.length > MAX_SUBJECT_LEN) {
        throw new Error(
          `todos[${i}].subject 过长（${subject.length} > ${MAX_SUBJECT_LEN}），请拆分`,
        );
      }
      return { id: randomUUID(), subject, status };
    });

    // 数量上限放在逐项校验之后，避免对已被截断的输入做错位计数。
    if (newTodos.length > MAX_TODO_COUNT) {
      throw new Error(
        `todos 数量 ${newTodos.length} 超过上限 ${MAX_TODO_COUNT}`,
      );
    }

    // 全量替换：直接覆盖该 streamSessionId 的整张列表
    todoStore.set(ctx.streamSessionId, newTodos);

    // 推送 todo_update chunk（携带完整 todos）让 renderer 实时更新 todo 面板。
    // 嵌套场景（子 agent 调 todowrite）携带 parentStreamSessionId，便于 renderer
    // 区分这是子 agent 的私有列表还是 PM 的列表。
    const chunk: StreamChunk = {
      type: 'todo_update',
      streamSessionId: ctx.streamSessionId,
      roomId: ctx.roomId,
      todos: newTodos,
      ...(ctx.parentStreamSessionId
        ? { parentStreamSessionId: ctx.parentStreamSessionId }
        : {}),
    };
    ctx.sendStreamChunk(chunk);

    return this.formatSummary(newTodos);
  }

  /** 生成「当前任务列表（N/M 完成）」摘要文本，回给 LLM 作为 tool_result。 */
  private formatSummary(todos: TodoItem[]): string {
    const doneCount = todos.filter((t) => t.status === 'completed').length;
    const body = todos
      .map((t, i) => {
        const mark = t.status === 'completed' ? 'x' : t.status === 'in_progress' ? '>' : ' ';
        return `${i + 1}. [${mark}] ${t.subject}`;
      })
      .join('\n');
    return `当前任务列表（${doneCount}/${todos.length} 完成）:\n${body}`;
  }
}
