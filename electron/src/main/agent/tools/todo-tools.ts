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
import { parseStringArg } from './shared/arg-parse';

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

/** 测试用：直接播种指定流式会话的 todo 表（绕过 execute 全量替换协议） */
export function __setTodosForTest(streamSessionId: string, items: TodoItem[]): void {
  todoStore.set(streamSessionId, items);
}

/** mandate 判定（spec §5.2）：是否存在未完成的 user 挂靠项 */
export function hasPendingUserTodos(streamSessionId: string): boolean {
  return (todoStore.get(streamSessionId) ?? []).some(
    (t) => t.status !== 'completed' && t.source === 'user',
  );
}

/**
 * 挂靠判定（F7，spec §5.3 memory_save 软门禁用）：本流是否存在 user 来源待办
 * （任意状态）。收尾沉淀（保存测试结论 / 经验记忆）天然发生在全部待办完成之后
 * ——原谓词 hasPendingUserTodos 在该时刻恒 false，会把最正常的任务收尾动作
 * 误报为「未挂靠」（2026-09-18 实测）。create_task 门禁维持 hasPendingUserTodos
 * （新建任务理应挂在未完成授权下）。
 */
export function hasUserTodos(streamSessionId: string): boolean {
  return (todoStore.get(streamSessionId) ?? []).some((t) => t.source === 'user');
}

/**
 * 回合正常终止时的 todo 收敛：把该流仍在 in_progress 的项机械标记 completed。
 *
 * 根因背景（P0「最后一项永不完成」）：todowrite 是全量替换协议，LLM 的实际
 * 书写习惯是转移驱动——开始下一项时才补上一项的 completed；最后一项的完成
 * 动作与终文重合，没有「下一项」触发簿记，模型产出终文即停。终文即交付，
 * 此处由 harness 收尾兜底。
 *
 * 语义边界：只动 in_progress（交付中）；pending 不动（未启动 ≠ 完成，不伪造
 * 数据真相）。强停路径（interrupted / error / budget_exhausted）不应调用——
 * in_progress 保持原状以支撑断点续跑。无变更时返回原数组引用（幂等门：
 * 调用方据此跳过 todo_update 推送，不产生多余事件）。
 */
export function completeInProgressTodos(streamSessionId: string): {
  changed: boolean;
  todos: TodoItem[];
} {
  const todos = todoStore.get(streamSessionId);
  if (!todos || !todos.some((t) => t.status === 'in_progress')) {
    return { changed: false, todos: todos ?? [] };
  }
  const next = todos.map((t) =>
    t.status === 'in_progress' ? { ...t, status: 'completed' as const } : t,
  );
  todoStore.set(streamSessionId, next);
  return { changed: true, todos: next };
}

/**
 * todowrite 工具模块（v1.5）。仅 1 个工具：`todowrite`。
 *
 * 返回给 LLM 的结构化摘要格式（便于 LLM 自我感知进度）：
 *   ```
 *   当前任务列表（N/M 完成）:
 *   1. [x] [u] 已完成项
 *   2. [>] [a] 进行中项
 *   3. [ ] 待办项
 *   ```
 * 其中 status 图标：completed='x' / in_progress='>' / pending=' '；source 标注（spec §5.3）：'user'=[u] / 'agent'=[a]，未标注按 'agent' 解析。
 */
export class TodoTools implements ToolModule {
  getDefs(): LLMToolDef[] {
    return [
      {
        name: 'todowrite',
        description:
          '管理任务列表（全量替换）。为「本轮用户请求直接要求」的步骤标 source=user——这是' +
          '系统判定你本轮授权范围的依据；你自己扩展的可选工作标 source=agent。收到改变方向或' +
          '要求停止的用户补充时，必须先更新本表使其反映用户当前意图。复杂任务（≥3 步骤）建议先建表。',
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
                  source: {
                    type: 'string',
                    enum: ['user', 'agent'],
                    description: '挂靠来源（缺省 agent）',
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

    // F9a 稳定 ID：全量替换协议不变，但按归一 subject（trim）匹配既有条目延续 id——
    // 同 subject 跨重写保持逐项身份（消费方可按 id 追踪历史）；subject 改写 = 新条目
    // （无重命名语义）；同批重复 subject 仅首个延续，其余新 id（防同表 id 重复）。
    const existing = todoStore.get(ctx.streamSessionId) ?? [];
    const idBySubject = new Map<string, string>();
    for (const t of existing) {
      const key = t.subject.trim();
      if (!idBySubject.has(key)) idBySubject.set(key, t.id);
    }
    const claimedIds = new Set<string>();

    // 先逐项校验并生成 id（任一失败立即抛错，store 不变）
    const newTodos: TodoItem[] = args.todos.map((t, i) => {
      const item = t as { subject?: unknown; status?: unknown; source?: unknown };
      // 写入即 trim：subject 是匹配键（稳定 ID 归一），两侧空白属手误噪声
      const subject = parseStringArg(item?.subject, `todos[${i}].subject`).trim();
      if (subject === '') {
        throw new Error(`todos[${i}].subject 不能为空`);
      }
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
      const rawSource = item?.source;
      let source: TodoItem['source'];
      if (rawSource === undefined) {
        source = 'agent'; // 缺省保守取向（spec §5.3）
      } else if (rawSource === 'user' || rawSource === 'agent') {
        source = rawSource;
      } else {
        throw new Error(
          `todos[${i}].source 必须是 user/agent，实际: ${String(rawSource)}`,
        );
      }
      if (subject.length > MAX_SUBJECT_LEN) {
        throw new Error(
          `todos[${i}].subject 过长（${subject.length} > ${MAX_SUBJECT_LEN}），请拆分`,
        );
      }
      const keptId = idBySubject.get(subject.trim());
      const id = keptId !== undefined && !claimedIds.has(keptId) ? keptId : randomUUID();
      claimedIds.add(id);
      return { id, subject, status, source };
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
      // Task 6 字段迁移：roomId→sessionId（值语义不变，仍是会话/房间 ID）
      sessionId: ctx.roomId,
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
        const src = t.source === 'user' ? 'u' : 'a';
        return `${i + 1}. [${mark}] [${src}] ${t.subject}`;
      })
      .join('\n');
    return `当前任务列表（${doneCount}/${todos.length} 完成）:\n${body}`;
  }
}
