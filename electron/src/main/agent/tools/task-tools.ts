// electron/src/main/agent/tools/task-tools.ts
//
// 任务工具（v2 B10）——暴露给 agent 用，让 agent 能读任务上下文、创建 / 完成任务。
//
// 8 个工具的语义：
//   - read_task(taskId)             → TaskContext 摘要（go through MemoryProvider）
//   - read_task_history(taskId)     → execution_room 内的 messages
//   - read_task_progress(taskId)    → task 关联的所有 message_events
//   - list_delegation_targets()     → 三类委派目标清单（agent 成员 / 团队 / 会话）
//   - create_task(input)            → 新建任务（K1 落态：有目标 assigned / 有计划 pending / 否则 draft）
//   - complete_task(taskId)         → 标记 completed
//   - fail_task(taskId, reason)     → 标记 failed + errorMessage
//   - list_tasks(filter?)           → 多维过滤列表
//
// 全部是 SQLite 薄包装，所有数据库读写都走已有的 tasks repo / messages repo /
//   events repo / agent crud / team / sessions repo / SQLiteMemoryProvider；本文件不含 SQL。
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
import { spawnNextInstanceIfRecurring } from '../../task/recurrence';
import { notifyExecutor } from '../../task/executor';
import { hasDelegationTarget } from '../../task/starter';
import { listMembers, listAgentDefinitions } from '../crud';
import { listTeams } from '../team';
import { listSessionsByWorkspace, listSessionMembers } from '../../storage/sessions/repo';
import type { LLMToolDef } from '../llm-provider';
import type { ToolContext, ToolModule } from './types';
import { parseStringArg } from './shared/arg-parse';

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
  /** v29：委派目标三列（互斥） */
  targetTeamId?: string | null;
  /** v29：委派目标三列（互斥） */
  targetSessionId?: string | null;
  /** v29：循环规则 */
  recurrenceRule?: string | null;
  /** 计划开始时间（ms epoch）；设置时任务落 pending 交 scheduler 接管 */
  scheduledAt?: number | null;
}

/**
 * create_task：新建任务。
 *
 * K1 落态决策（有目标 / 有计划 / 否则 draft，三选一）：
 *   - 有委派目标（assigneeAgentId / targetTeamId / targetSessionId 任一非空）→ assigned
 *     即时评估放行——executor 只消费 assigned，否则带目标草稿死局
 *   - 有计划时间（scheduledAt 非空）→ pending 到点由 scheduler 接管转 assigned
 *     ——C1 定时管线入口，与 task:create IPC 入口同语义
 *   - 两者皆无 → draft（repo 默认值；草稿暂存不会被调度，execute() 返回 warning）
 *
 * description / priority 缺省取 '' / 0；返回插入后的 TaskRow（含自动生成的 id）。
 */
export async function createTask(input: CreateTaskInput): Promise<TaskRow> {
  // 委派信息闭环 ④：与 IPC task:create 的 K1 落态决策对齐（决策表注释见
  // task/ipc.handlers.ts）——scheduler 只消费 pending、executor 只消费
  // assigned；agent 建的带目标任务此前落 draft 两个调度器都不认（死局换形态）。
  // 谓词统一走 starter.hasDelegationTarget——四处同义判定收敛单点（终审 N1/M6）
  const hasTarget = hasDelegationTarget(input);
  const row = insertTask({
    workspaceId: input.workspaceId,
    title: input.title,
    status: input.scheduledAt != null ? 'pending' : hasTarget ? 'assigned' : undefined,
    description: input.description ?? '',
    creatorUserId: input.creatorUserId,
    priority: input.priority ?? 0,
    assigneeAgentId: input.assigneeAgentId,
    targetTeamId: input.targetTeamId,
    targetSessionId: input.targetSessionId,
    recurrenceRule: input.recurrenceRule,
    scheduledAt: input.scheduledAt,
  });
  // assigned 落态即时触发放行评估（100ms 去抖合并；丢了有 30s 兜底扫描自愈）
  if (row.status === 'assigned') notifyExecutor();
  return row;
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
  // 终态钩子（Task 5）：循环任务续期（仅 completed；spec §7.2）+ 释放槽位立即评估放行
  spawnNextInstanceIfRecurring(taskId);
  notifyExecutor();
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
  // 终态钩子（Task 5）：失败同样释放槽位——立即触发放行评估
  notifyExecutor();
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

/** list_delegation_targets 的 agents 条目 */
export interface DelegationTargetAgent {
  instanceId: string;
  name: string;
  description: string;
  /** 当前会话（ctx.roomId 的 session_members）内的成员 = agent 视角的「自己」 */
  isSelf: boolean;
}

/** list_delegation_targets 的 teams 条目 */
export interface DelegationTargetTeam {
  id: string;
  name: string;
  memberCount: number;
  leaderName: string;
}

/** list_delegation_targets 的 sessions 条目 */
export interface DelegationTargetSession {
  id: string;
  title: string;
  kind: 'chat' | 'task_execution';
  isCurrent: boolean;
}

/** list_delegation_targets 返回结构（紧凑，直接 JSON.stringify 给 LLM） */
export interface DelegationTargetList {
  agents: DelegationTargetAgent[];
  teams: DelegationTargetTeam[];
  sessions: DelegationTargetSession[];
  /** 空类目提示（agent 区分「没有」与「查询失败」）；全非空为空数组 */
  notes: string[];
}

/**
 * list_delegation_targets：一次返回三类可指派委派目标（agent 成员 / 团队 / 会话）。
 *
 * 委派信息闭环（spec 2026-09-08）：agent 此前无工具发现指派目标 ID，
 * create_task 留空指派 → draft 死局。查询全部走 repo 函数（本文件不含 SQL）。
 * sessions 按 COALESCE(last_message_at, created_at) DESC 取最近 20 条。
 * members 按 createdAt ASC 排（listMembers 走 idx_wam_unique 可能按 agent_definition_id 序回，
 * 显式排序保证 LLM 看到的清单稳定、按加入先后）。
 */
export function listDelegationTargets(workspaceId: string, roomId: string): DelegationTargetList {
  const members = listMembers(workspaceId)
    .slice()
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const descByDefId = new Map(listAgentDefinitions().map((d) => [d.id, d.description]));
  const selfIds = new Set(roomId ? listSessionMembers(roomId).map((m) => m.instanceId) : []);
  const agents: DelegationTargetAgent[] = members.map((m) => ({
    instanceId: m.instanceId,
    name: m.agentName,
    description: descByDefId.get(m.agentDefinitionId) ?? '',
    isSelf: selfIds.has(m.instanceId),
  }));

  const teams: DelegationTargetTeam[] = listTeams(workspaceId).map((t) => ({
    id: t.id,
    name: t.name,
    memberCount: t.members.length,
    leaderName:
      t.members.find((m) => m.instanceId === t.leaderInstanceId)?.agentName ?? '（无 leader）',
  }));

  const sessions: DelegationTargetSession[] = listSessionsByWorkspace(workspaceId)
    .map((s) => ({ row: s, sortKey: s.lastMessageAt ?? s.createdAt }))
    .sort((a, b) => b.sortKey - a.sortKey)
    .slice(0, 20)
    .map(({ row }) => ({ id: row.id, title: row.title, kind: row.kind, isCurrent: row.id === roomId }));

  const notes: string[] = [];
  if (agents.length === 0) notes.push('本工作空间暂无 agent 成员，无法指派 assigneeAgentId');
  if (teams.length === 0) notes.push('本工作空间暂无团队');
  return { agents, teams, sessions, notes };
}

function parseStringArgOptional(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new Error(`参数 "${name}" 不是字符串`);
  }
  return value;
}

/** 无指派创建的 warning 文案（委派信息闭环 ③：让 agent 立即知道死局与出路） */
const NO_ASSIGNMENT_WARNING =
  '任务未指派委派目标（assigneeAgentId / targetTeamId / targetSessionId 均为空）。' +
  '系统没有自动指派机制——此任务将停留在 draft，永远不会被调度执行。' +
  'draft 任务无法用工具取消（状态机不允许），请：' +
  '1) 调用 list_delegation_targets 查看可指派目标，重新创建携带指派的新任务；' +
  '2) 告知用户在看板手动处理本条死任务（取消或编辑指派）。';

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
        name: 'list_delegation_targets',
        description:
          '列出当前工作空间全部可指派的委派目标（agent 成员 / 团队 / 会话，含各自 ID 与名称）。create_task 前先调用本工具获取真实 ID——系统没有自动指派机制，无指派目标任务不会被调度执行。',
        inputSchema: { type: 'object', properties: {} },
      },
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
          '创建新任务。返回刚创建的 TaskRow（含 id / status=draft；未指派委派目标时返回对象额外含 warning 字段——任务不会被调度执行）。workspaceId 与 creatorUserId 由工具上下文自动注入（LLM 无需填、也不应填——args 中的同名键会被忽略以防 FK 违约与跨用户冒名）。assigneeAgentId / targetTeamId / targetSessionId 三者必须提供其一，创建前先调用 list_delegation_targets 获取真实 ID。',
        inputSchema: {
          type: 'object',
          properties: {
            workspaceId: {
              type: 'string',
              description: '所属 workspace ID（自动从上下文注入；勿手动填）',
            },
            title: { type: 'string', description: '任务标题' },
            creatorUserId: {
              type: 'string',
              description: '创建者 user ID（自动从上下文注入；勿手动填）',
            },
            description: { type: 'string', description: '任务描述（可选）' },
            priority: {
              type: 'number',
              description: '优先级 0-9（越大越优先，默认 0）',
            },
            assigneeAgentId: {
              type: 'string',
              description: '指派目标 agent 的 instance ID（从 list_delegation_targets 查询）。三者必须提供其一——系统没有自动指派机制，无指派任务将永远停留在 draft 不会被调度执行',
            },
            targetTeamId: {
              type: 'string',
              description: '委派目标 team ID（v29：与 assigneeAgentId/targetSessionId 互斥）（从 list_delegation_targets 查询）',
            },
            targetSessionId: {
              type: 'string',
              description: '委派目标 session ID（v29：与 assigneeAgentId/targetTeamId 互斥）（从 list_delegation_targets 查询）',
            },
            recurrenceRule: {
              type: 'string',
              description: '循环规则（如 "daily@09:00"）；设置后由 recurrence 续期生成下一实例',
            },
            scheduledAt: {
              type: 'number',
              description: '计划开始时间（毫秒 epoch；设置后任务直接落 pending 由调度器接管）',
            },
          },
          required: ['title'],
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
          '按过滤条件列任务（默认收窄到当前工作空间——workspaceId 由上下文自动注入；args 中的 workspaceId 会被忽略以防跨 ws 信息泄漏）。可选过滤：status / assigneeAgentId / orderBy / limit。',
        inputSchema: {
          type: 'object',
          properties: {
            workspaceId: {
              type: 'string',
              description: 'workspace ID（自动从上下文注入；勿手动填）',
            },
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
      name === 'list_delegation_targets' ||
      name === 'create_task' ||
      name === 'complete_task' ||
      name === 'fail_task' ||
      name === 'list_tasks'
    );
  }

  async execute(
    name: string,
    args: Record<string, unknown>,
    // 任务工具的 workspaceId / creatorUserId 来自 ToolContext；args 同名键一律忽略
    // ——LLM 不可自由填，否则会 FK 违约或跨用户冒名（Bug 1 修复）。
    ctx: ToolContext,
  ): Promise<string> {
    switch (name) {
      case 'list_delegation_targets': {
        return JSON.stringify(listDelegationTargets(ctx.workspaceId, ctx.roomId));
      }
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
        // 入参边界空串归一：LLM 偶发传 assigneeAgentId=''（应为「无目标」）；
        // 若不归一，hasDelegationTarget 旧实现（!= null）会判有目标 → 落 assigned
        // 即时评估放行 → executor validateTarget 校验空 assignee → 转 failed，
        // 而 execute() 返回体仍带 warning 谎称「停留 draft」——双重新话。
        // '' → undefined 后两侧谓词天然一致。
        const input: CreateTaskInput = {
          // 上下文字段强制走 ctx——忽略 args 同名键，拒 LLM 幻觉填值
          workspaceId: ctx.workspaceId,
          title: parseStringArg(args.title, 'title'),
          creatorUserId: ctx.creatorUserId,
          description: parseStringArgOptional(args.description, 'description'),
          priority:
            typeof args.priority === 'number' ? args.priority : undefined,
          assigneeAgentId:
            parseStringArgOptional(args.assigneeAgentId, 'assigneeAgentId') || undefined,
          targetTeamId:
            parseStringArgOptional(args.targetTeamId, 'targetTeamId') || undefined,
          targetSessionId:
            parseStringArgOptional(args.targetSessionId, 'targetSessionId') || undefined,
          recurrenceRule: parseStringArgOptional(
            args.recurrenceRule,
            'recurrenceRule',
          ),
          scheduledAt: typeof args.scheduledAt === 'number' ? args.scheduledAt : undefined,
        };
        const result = await createTask(input);
        // 委派信息闭环 ③：无指派 → TaskRow 顶层附加 warning（形状向后兼容，
        // 有指派时返回纯 TaskRow——现有消费方直接 parse 顶层字段不破坏）。
        // 谓词统一走 starter.hasDelegationTarget——与 createTask 内部落态决策
        // 同义（终审 N1/M6：谓词分叉导致双重新话回归锁）
        if (!hasDelegationTarget(input)) {
          return JSON.stringify({ ...result, warning: NO_ASSIGNMENT_WARNING });
        }
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
        const opts: ListTasksOptions = {
          // 默认收窄到当前工作空间（防 LLM 漏填/跨 ws 信息泄漏）
          workspaceId: ctx.workspaceId,
        };
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
