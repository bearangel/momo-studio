// electron/src/main/agent/tools/task-tools.ts
//
// 任务工具（v2 B10）——暴露给 agent 用，让 agent 能读任务上下文、创建 / 完成任务。
//
// 7 个工具的语义：
//   - read_task(taskId)             → TaskContext 摘要（go through MemoryProvider）
//   - read_task_history(taskId)     → execution_room 内的 messages
//   - read_task_progress(taskId)    → task 关联的所有 message_events
//   - create_task(input)            → 新建任务（draft 状态）
//   - complete_task(taskId)         → 标记 completed
//   - fail_task(taskId, reason)     → 标记 failed + errorMessage
//   - list_tasks(filter?)           → 多维过滤列表
//
// 全部是 SQLite 薄包装，所有数据库读写都走已有的 tasks repo / messages repo /
//   events repo / SQLiteMemoryProvider；本文件不含 SQL。
//
// 设计要点：
//   - read 路径走 MemoryProvider.getTaskContext（统一 agent 上下文入口，未来切到
//     FullMemoryProvider 时本模块无感升级）。
//   - write 路径走 tasks repo（insertTask / transitionTaskStatus），状态机校验由
//     repo 内部保证——非法转换（如 draft → completed 跳过 in_progress）抛错。
//   - read_task_progress 不走 MemoryProvider 因为它要求全部事件（含 thinking_delta /
//     text_delta 流式增量），而 getTaskContext 过滤掉了 noise 事件。
//   - 顶层导出 7 个独立函数（便于测试 / 复用），同时导出 TaskTools 类
//     实现 ToolModule 接口（注册到 tools/index.ts）。
import { getMemoryProvider } from '../../memory';
import {
  insertTask,
  transitionTaskStatus,
  getTask,
  listTasks as listTasksRepo,
  type TaskRow,
} from '../../storage/tasks/repo';
import { listMessagesBySession, type MessageRow } from '../../storage/messages/repo';
import {
  listEventsByMessage,
  type MessageEventRow,
} from '../../storage/messages/events-repo';
import { getDb } from '../../storage/db';
import type { LLMToolDef } from '../llm-provider';
import type { ToolContext, ToolModule } from './types';

/**
 * read_task 的返回结构（task 上下文摘要）。
 *
 * 字段顺序严格匹配 brief；是 MemoryProvider.TaskContext 的扁平化版本——
 * 把 `task: TaskRow` 展开到顶层，便于 LLM 直接解析。
 */
export interface ReadTaskResult {
  id: string;
  title: string;
  description: string;
  status: string;
  assigneeAgentId: string | null;
  priority: number;
  deadlineAt: number | null;
  errorMessage: string | null;
  completedAt: number | null;
  events: Array<{ seq: number; eventType: string; summary: string }>;
  artifacts: Array<{ toolName: string; path: string; action: 'read' | 'write' | 'edit' }>;
}

/**
 * read_task：取 task 上下文摘要。
 *
 * 任务不存在返回 null。存在的 task 走 SQLiteMemoryProvider.getTaskContext 拿
 * 关键事件 + 文件改动；如果 task 还没有任何 events（新建的 draft 任务），
 * events/artifacts 是空数组。
 */
export async function readTask(taskId: string): Promise<ReadTaskResult | null> {
  const memory = getMemoryProvider();
  const ctx = await memory.getTaskContext(taskId);
  if (!ctx) return null;
  return {
    id: ctx.task.id,
    title: ctx.task.title,
    description: ctx.task.description,
    status: ctx.task.status,
    assigneeAgentId: ctx.task.assigneeAgentId,
    priority: ctx.task.priority,
    deadlineAt: ctx.task.deadlineAt,
    errorMessage: ctx.task.errorMessage,
    completedAt: ctx.task.completedAt,
    events: ctx.events,
    artifacts: ctx.artifacts,
  };
}

/**
 * read_task_history：取 task 执行房间内的 messages。
 *
 * task 还没进入 in_progress 状态（没有 execution_session_id）时返回空数组。
 * 这里不过滤 task_id——execution_room 是任务专属房间，room_id 唯一对应
 *   task，但保险起见调用方应在 messages 表查 task_id 也带上（本工具按
 *     brief 语义只按 room 拉）。
 */
export async function readTaskHistory(taskId: string): Promise<MessageRow[]> {
  const task = getTask(taskId);
  if (!task?.executionSessionId) return [];
  return listMessagesBySession(task.executionSessionId);
}

/**
 * read_task_progress：取 task 关联的所有 message_events。
 *
 * 与 getTaskContext 不同：本工具返回全量事件（含 thinking_delta / text_delta），
 * 因为 progress 流需要重建给用户看，noise 事件不能丢。
 *
 * 排序：按 createdAt 升序；同一 message 内 events 自身已按 seq 升序，
 *   跨 message 时按 createdAt 拼接即可。
 */
export async function readTaskProgress(taskId: string): Promise<MessageEventRow[]> {
  const task = getTask(taskId);
  if (!task) return [];
  const db = getDb();
  const msgIds = db
    .prepare('SELECT id FROM messages WHERE task_id = ? ORDER BY created_at ASC')
    .all(taskId) as Array<{ id: string }>;
  const allEvents: MessageEventRow[] = [];
  for (const m of msgIds) {
    allEvents.push(...listEventsByMessage(m.id));
  }
  return allEvents.sort((a, b) => a.createdAt - b.createdAt);
}

/** create_task：列出仓库的入参（明示 description / priority / assignee 默认值）。 */
export interface CreateTaskInput {
  workspaceId: string;
  title: string;
  creatorUserId: string;
  description?: string;
  priority?: number;
  assigneeAgentId?: string;
}

/**
 * create_task：新建任务。
 *
 * 走 insertTask（status 默认 draft / description 默认 '' / priority 默认 0）。
 * 返回插入后的 TaskRow（含自动生成的 id）。
 */
export async function createTask(input: CreateTaskInput): Promise<TaskRow> {
  return insertTask({
    workspaceId: input.workspaceId,
    title: input.title,
    description: input.description ?? '',
    creatorUserId: input.creatorUserId,
    priority: input.priority ?? 0,
    assigneeAgentId: input.assigneeAgentId,
  });
}

/**
 * complete_task：标记任务完成。
 *
 * 走 transitionTaskStatus('completed')——状态机校验要求当前状态在
 * { in_progress, paused, pending_review } 之一。非法转换抛错。
 * 自动设 completedAt = now()。
 */
export async function completeTask(taskId: string): Promise<void> {
  transitionTaskStatus(taskId, 'completed', { completedAt: Date.now() });
}

/**
 * fail_task：标记任务失败 + 写入错误原因。
 *
 * 转 failed + 写 errorMessage + 设 completedAt（业务上"完成"了不管是正常完成还是失败）。
 * 状态机校验：仅 in_progress / paused 可转 failed。
 */
export async function failTask(taskId: string, reason: string): Promise<void> {
  transitionTaskStatus(taskId, 'failed', {
    errorMessage: reason,
    completedAt: Date.now(),
  });
}

/** list_tasks：透传 tasks repo.listTasks 参数（多维过滤 + 排序 + limit）。 */
export type ListTasksOptions = Parameters<typeof listTasksRepo>[0];

/**
 * list_tasks：按过滤条件列出任务。
 *
 * 纯透传 listTasksRepo——workspaceId / status / assigneeAgentId / executionSessionId /
 *   sourceSessionId / orderBy / limit。返回 TaskRow 数组。
 */
export async function listTasks(opts: ListTasksOptions): Promise<TaskRow[]> {
  return listTasksRepo(opts);
}

/**
 * 把 unknown 归一化为 string，缺失或非 string 时抛错。
 * 工具 execute 路由共用：给 LLM 明确的错误反馈而不是默默 undefined。
 */
function parseStringArg(value: unknown, name: string): string {
  if (typeof value !== 'string') {
    throw new Error(`参数 "${name}" 缺失或不是字符串`);
  }
  return value;
}

function parseStringArgOptional(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new Error(`参数 "${name}" 不是字符串`);
  }
  return value;
}

/**
 * 任务工具模块（v2 B10）：注册 7 个工具 read_task / read_task_history /
 *   read_task_progress / create_task / complete_task / fail_task / list_tasks。
 *
 * 结果通过 JSON.stringify 回给 LLM（message 数据天然是结构化的，JSON 表达最清晰）。
 */
export class TaskTools implements ToolModule {
  getDefs(): LLMToolDef[] {
    return [
      {
        name: 'read_task',
        description:
          '读取任务详情 + 执行历史摘要（关键事件 + 文件改动）。任务执行前调一次了解上下文。taskId 不存在返回 null。',
        inputSchema: {
          type: 'object',
          properties: {
            taskId: {
              type: 'string',
              description: '任务 ID（如 T-001）',
            },
          },
          required: ['taskId'],
        },
      },
      {
        name: 'read_task_history',
        description:
          '读取任务的 execution_room 内的 IM 消息历史（按 createdAt 升序）。任务未进入 in_progress 状态时返回空数组。',
        inputSchema: {
          type: 'object',
          properties: {
            taskId: { type: 'string', description: '任务 ID' },
          },
          required: ['taskId'],
        },
      },
      {
        name: 'read_task_progress',
        description:
          '读取任务的执行进度流（全量 message_events，含 thinking_delta / text_delta / tool_call_*）。用于重建执行过程。',
        inputSchema: {
          type: 'object',
          properties: {
            taskId: { type: 'string', description: '任务 ID' },
          },
          required: ['taskId'],
        },
      },
      {
        name: 'create_task',
        description:
          '创建新任务。返回刚创建的 TaskRow（含 id / status=draft）。workspaceId/title/creatorUserId 必填。',
        inputSchema: {
          type: 'object',
          properties: {
            workspaceId: { type: 'string', description: '所属 workspace ID' },
            title: { type: 'string', description: '任务标题' },
            creatorUserId: { type: 'string', description: '创建者 user ID' },
            description: { type: 'string', description: '任务描述（可选）' },
            priority: {
              type: 'number',
              description: '优先级 0-9（越大越优先，默认 0）',
            },
            assigneeAgentId: {
              type: 'string',
              description: '指派 agent ID（可选；不指定则由调度器决定）',
            },
          },
          required: ['workspaceId', 'title', 'creatorUserId'],
        },
      },
      {
        name: 'complete_task',
        description:
          '把任务标记为 completed。状态机校验：当前状态须为 in_progress / paused / pending_review。',
        inputSchema: {
          type: 'object',
          properties: {
            taskId: { type: 'string', description: '任务 ID' },
          },
          required: ['taskId'],
        },
      },
      {
        name: 'fail_task',
        description:
          '把任务标记为 failed 并写入错误原因。状态机校验：当前状态须为 in_progress / paused。',
        inputSchema: {
          type: 'object',
          properties: {
            taskId: { type: 'string', description: '任务 ID' },
            reason: { type: 'string', description: '失败原因（中英文皆可）' },
          },
          required: ['taskId', 'reason'],
        },
      },
      {
        name: 'list_tasks',
        description:
          '按过滤条件列任务。常用过滤：workspaceId / status / assigneeAgentId。可选 orderBy ("priority" / "scheduled_at" / "created_at") + limit。',
        inputSchema: {
          type: 'object',
          properties: {
            workspaceId: { type: 'string', description: 'workspace ID' },
            status: {
              type: 'string',
              enum: [
                'draft',
                'pending',
                'assigned',
                'in_progress',
                'paused',
                'pending_review',
                'completed',
                'failed',
              ],
              description: '按状态过滤（单值；多值请用 list_tasks 多次调用）',
            },
            assigneeAgentId: { type: 'string', description: '指派 agent ID' },
            orderBy: {
              type: 'string',
              enum: ['priority', 'scheduled_at', 'created_at'],
              description: '排序方式（默认 created_at）',
            },
            limit: { type: 'number', description: '最多返回条数' },
          },
        },
      },
    ];
  }

  handles(name: string): boolean {
    return (
      name === 'read_task' ||
      name === 'read_task_history' ||
      name === 'read_task_progress' ||
      name === 'create_task' ||
      name === 'complete_task' ||
      name === 'fail_task' ||
      name === 'list_tasks'
    );
  }

  async execute(
    name: string,
    args: Record<string, unknown>,
    // ctx 当前未使用——任务工具不走 workspace FS / skill registry；
  // 保留参数是为了符合 ToolModule 接口统一签名。
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _ctx: ToolContext,
  ): Promise<string> {
    switch (name) {
      case 'read_task': {
        const taskId = parseStringArg(args.taskId, 'taskId');
        const result = await readTask(taskId);
        return JSON.stringify(result);
      }
      case 'read_task_history': {
        const taskId = parseStringArg(args.taskId, 'taskId');
        const result = await readTaskHistory(taskId);
        return JSON.stringify(result);
      }
      case 'read_task_progress': {
        const taskId = parseStringArg(args.taskId, 'taskId');
        const result = await readTaskProgress(taskId);
        return JSON.stringify(result);
      }
      case 'create_task': {
        const input: CreateTaskInput = {
          workspaceId: parseStringArg(args.workspaceId, 'workspaceId'),
          title: parseStringArg(args.title, 'title'),
          creatorUserId: parseStringArg(args.creatorUserId, 'creatorUserId'),
          description: parseStringArgOptional(args.description, 'description'),
          priority:
            typeof args.priority === 'number' ? args.priority : undefined,
          assigneeAgentId: parseStringArgOptional(
            args.assigneeAgentId,
            'assigneeAgentId',
          ),
        };
        const result = await createTask(input);
        return JSON.stringify(result);
      }
      case 'complete_task': {
        const taskId = parseStringArg(args.taskId, 'taskId');
        await completeTask(taskId);
        return JSON.stringify({ ok: true, taskId, status: 'completed' });
      }
      case 'fail_task': {
        const taskId = parseStringArg(args.taskId, 'taskId');
        const reason = parseStringArg(args.reason, 'reason');
        await failTask(taskId, reason);
        return JSON.stringify({
          ok: true,
          taskId,
          status: 'failed',
          errorMessage: reason,
        });
      }
      case 'list_tasks': {
        const opts: ListTasksOptions = {};
        if (typeof args.workspaceId === 'string') {
          opts.workspaceId = args.workspaceId;
        }
        if (typeof args.status === 'string') {
          opts.status = args.status as TaskRow['status'];
        }
        if (typeof args.assigneeAgentId === 'string') {
          opts.assigneeAgentId = args.assigneeAgentId;
        }
        if (
          args.orderBy === 'priority' ||
          args.orderBy === 'scheduled_at' ||
          args.orderBy === 'created_at'
        ) {
          opts.orderBy = args.orderBy;
        }
        if (typeof args.limit === 'number') {
          opts.limit = args.limit;
        }
        const result = await listTasks(opts);
        return JSON.stringify(result);
      }
      default:
        throw new Error(`未知任务工具: ${name}`);
    }
  }
}
