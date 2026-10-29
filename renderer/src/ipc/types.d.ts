// renderer/src/ipc/types.d.ts
//
// BoardColumnKey 联合类型内联于此、不再 import board-columns.ts：electron 构建
// （tsc -p tsconfig.json）会沿本文件的 type import 把 board-columns.ts 拖进
// 编译图，在 renderer 源码树旁路产出 board-columns.js——vite 解析 .js 优先于
// .ts，污染存在时 renderer build 必失败（Task 14 收尾发现）。列常量与该联合
// 的双向等值由 board-columns.ts 编译期断言锁死。

/** 看板五列 key（值域与 board-columns.ts 的 BOARD_COLUMN_KEYS 常量双向锁） */
export type BoardColumnKey = 'backlog' | 'assigned' | 'active' | 'done' | 'closed';

export interface SystemInfo {
  platform: string;
  arch: string;
  nodeVersion: string;
  electronVersion: string;
  appVersion: string;
  userDataDir: string;
}

/** P5 Task 2：v1.x → 2.0 旧库升级首启提示载荷——导出目录 */
export interface UpgradeNotice {
  exportDir: string;
}

export interface Workspace {
  id: string;
  name: string;
  description: string;
  directoryPath: string;
  gitInitialized: boolean;
  createdAt: string;
  ownerId: string;
  iconEmoji: string;
  /** 该 workspace 的「默认会话 agent」实例 ID（v25：原协调 agent）；null=未指定 */
  defaultAgentInstanceId: string | null;
}

export interface CreateWorkspaceInput {
  name: string;
  description?: string;
  directoryPath: string;
  iconEmoji?: string;
}

export interface AgentDefinition {
  id: string;
  name: string;
  slug: string;
  version: string;
  runtime: string;
  systemPrompt: string;
  defaultTools: Array<{ kind: string; ref: string }>;
  source: string;
  description: string;
  iconEmoji: string;
  /** 默认 MCP server 引用（Layer 1 能力），与 electron 端 McpRef 对齐 */
  defaultMcps?: Array<{ kind: 'mcp'; ref: string; versionRange?: string }>;
  /** 默认 Skill 引用（Layer 1 能力），与 electron 端 SkillRef 对齐 */
  defaultSkills?: Array<{ kind: 'skill'; ref: string; versionRange?: string }>;
  /**
   * v25 恒 null——定义全局化（migration v25 已 DROP workspace_id 列，
   * electron rowToDef 恒映射 null）。字段保留与 electron 端结构对齐；
   * 显示逻辑不得依赖它做分组/徽标（Task 11 清理）。
   */
  workspaceId: string | null;
  /** NULL=builtin 未配置；custom 必填 */
  modelProviderId: string | null;
  /** 模型名 */
  modelName: string;
  /** agent 级思维模式覆盖；NULL=继承模型级（v31 起） */
  thinkingJson?: ThinkingConfig | null;
  /** 工作空间维度 v1.1：工具禁用模式串（plugin:<id>/* 前缀 + 精确名）；缺省 [] */
  deniedTools?: string[];
}

/**
 * Agent 在 workspace 中的成员关系（v25：取代 v1.3 的 AgentAssignment——
 * 去编排，无 role/parentInstanceId/enabled；同 ws 同 def 唯一）。
 * 与 electron 端 agent/types.ts 的 WorkspaceAgentMember 对齐。
 */
export interface WorkspaceAgentMember {
  instanceId: string;
  workspaceId: string;
  agentDefinitionId: string;
  agentUserId: string;
  /**
   * 展示名（electron 端 JOIN agent_definitions.name 产出，缺失兜底 agentUserId）。
   * v2.2 bug 修复：后端数据面产出——此前「renderer 按 definitions 注入」的设计
   * 从未接线，协作会话/团队/Picker/任务指派等列表在 definitions 未加载时显示 ID。
   */
  agentName: string;
  /** 展示 emoji（JOIN agent_definitions.icon_emoji；无 emoji 时空串） */
  iconEmoji: string;
  /** 有无 API key override（实际 key 在 keychain） */
  hasApiKeyOverride: boolean;
  /** 用户最近运行意图（true=在线/false=离线）——「agent 在线」的唯一权威源 */
  lastRunning: boolean;
  createdAt: string;
}

/**
 * 团队（ws 级，spec §3.2；leader 必须同时在 members 内）。
 * 与 electron 端 agent/types.ts 的 Team 对齐。
 */
export interface Team {
  id: string;
  workspaceId: string;
  name: string;
  iconEmoji: string;
  leaderInstanceId: string;
  members: WorkspaceAgentMember[];
  createdAt: string;
}

/** Builtin YAML 的 platform 建议（不进 DB，仅 UI 默认值；v25 起无角色建议） */
export interface BuiltinSuggestion {
  suggestedParentDefId?: string;
  suggestedPlatform?: 'openai' | 'anthropic';
}
export type BuiltinSuggestionMap = Record<string, BuiltinSuggestion>;

/**
 * 任务状态（与 electron/src/main/storage/tasks/state-machine.ts 的 TaskStatus 同步）。
 * 这里只声明当前 UI 需要的最小子集；后续 B 子系统任务可扩展字段。
 */
export type TaskStatus =
  | 'draft'
  | 'pending'
  | 'assigned'
  | 'session_queued'
  | 'in_progress'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled';

/**
 * 任务执行路由三选（M2.1 契约区——与 electron/src/main/hub/task-routing.ts 逐字对齐）。
 * 落本地 tasks 表 routing_json 列（RM-M21-2，非 hub 协议）；NULL/异形读侧兜底 local。
 * group 变体 targetNodeId 为可选「已解析目标」（D5：派发回执回写，外派卡节点徽标源）。
 */
export type TaskRouting =
  | { mode: 'local' }
  | { mode: 'group'; groupId: string; targetNodeId?: string }
  | { mode: 'node'; groupId: string; targetNodeId: string };

/**
 * HITL 权限档位（M2.1 契约区——与 electron/src/main/hub/dispatch-submit.ts 逐字对齐；
 * T10 run-policy 消费，随委派载荷向后兼容透传，缺省 'confirm'）。
 */
export type PermissionTier = 'readonly' | 'sandbox' | 'confirm';

/** hub:submitRoutedTask 入参（三模式统一落点；与 dispatch-submit.ts SubmitRoutedTaskInput 对齐） */
export interface SubmitRoutedTaskInput {
  workspaceId: string;
  workspaceName: string;
  title: string;
  description?: string;
  groupId?: string;
  routing: TaskRouting;
  permissionTier?: PermissionTier;
}

/** hub:submitRoutedTask 返回（dispatched=false = 留待处理：无候选或发送瞬断） */
export interface SubmitRoutedTaskResult {
  task: TaskRow;
  dispatched: boolean;
  nodeId: string | null;
}

/** 路由预检成员概要（hub:routingPrecheck；mirrored=登记表本空间口径） */
export interface RoutingMemberSummary {
  nodeId: string;
  name: string;
  online: boolean;
  mirrored: boolean;
}

/** 路由预检组概要（预检行「N 节点在线 · M 已镜像」数据源） */
export interface RoutingGroupSummary {
  groupId: string;
  groupName: string;
  onlineCount: number;
  mirroredCount: number;
  members: RoutingMemberSummary[];
}

/** 路由预检结果（mirrored=false → 弹窗执行位置仅「本机」——Review Focus #1 守门） */
export interface RoutingPrecheckResult {
  mirrored: boolean;
  groups: RoutingGroupSummary[];
}

/**
 * 任务行（renderer 视图，与 electron 端 storage/tasks/repo.ts 的 TaskRow 完整对齐）。
 *
 * B7 之前是 { id, title, status } 三字段子集；B7 task.store 需要 update/transition
 * 全字段 patch + 存储完整行，故扩展为全字段镜像。MentionInput 等只读 id/title/status
 * 的消费者不受影响（多余字段直接忽略）。
 */
export interface TaskRow {
  id: string;
  workspaceId: string;
  title: string;
  description: string;
  status: TaskStatus;
  sourceSessionId: string | null;
  sourceMessageId: string | null;
  creatorUserId: string;
  executionSessionId: string | null;
  assigneeAgentId: string | null;
  /** v29：委派目标三列（互斥）+ 循环实例链 */
  targetTeamId: string | null;
  targetSessionId: string | null;
  recurrenceParentId: string | null;
  priority: number;
  scheduledAt: number | null;
  recurrenceRule: string | null;
  deadlineAt: number | null;
  /** D 阶段占位字段（D 子系统填值） */
  queuePosition: number | null;
  runtimeInstanceId: string | null;
  estimatedTokens: number | null;
  actualTokens: number | null;
  toolCallsUsed: number;
  errorMessage: string | null;
  sourceNodeId: string | null;
  createdAt: number;
  updatedAt: number;
  startedAt: number | null;
  completedAt: number | null;
  /** 看板分组（task_groups.id，G-<seq>），NULL=未分组（看板重构 spec §2） */
  groupId: string | null;
  /** 顶置时间戳（ms），NULL=未顶置；看板列内排序键（迁移 050，boardPosition 退役） */
  pinnedAt: number | null;
  /** 归档时间戳（ms），NULL=活跃；task.list 默认排除归档行 */
  archivedAt: number | null;
  /** M2.1：执行路由三选（routing_json 解析形态；旧行 NULL 兜底 {mode:'local'}） */
  routing: TaskRouting;
  /** M2.1：hub 委派 id 关联（delegation-sync 回写；缺省 null） */
  delegationId: string | null;
  /**
   * M3.3：父任务 id（层级链，区别于循环实例链 recurrenceParentId）；写路径走
   * task:setRelations（存在 + 链无环校验），task:update 剥离
   */
  parentTaskId: string | null;
  /**
   * M3.3 blocked 派生态（非状态，不落列）：存在未完成直接依赖时 true。
   * 读路径派生填充（task:get / task:list 聚合）；未填充时 undefined，
   * 消费方按 falsy 处理等同未阻塞
   */
  blocked?: boolean;
  /** M3.3：未完成直接依赖的 id 列表（blocked=true 时非空）；只读派生态 */
  blockedBy?: string[];
}

/**
 * 远端任务快照行（P4 Task 3）——TaskRow 的 7 字段子集，
 * 与 electron/src/main/p2p/protocols.ts 的 TaskSnapshot.tasks 对齐（传输瘦身）。
 */
export type TaskSnapshotItem = Pick<
  TaskRow,
  'id' | 'title' | 'status' | 'assigneeAgentId' | 'priority' | 'createdAt' | 'updatedAt'
>;

/**
 * 任务相关 IPC 接口（B 子系统）。
 *
 *   - create：新建任务（status 默认 'draft'）。creatorUserId 由 main process 从当前
 *     登录会话注入，renderer 不传。
 *   - list / get：查询。
 *   - update：部分字段更新（绕过状态机；正常路径请用 transition）。
 *   - transition：状态机驱动的状态转换，可带 extraPatch 副作用字段。
 *   - start：B8 实现（execution_room 决策树）；B7 只声明类型 + preload 桥接，handler 留空。
 *   - cancel：等价 transition(id, 'cancelled') 的快捷通道。
 *   - resolveConflict：B9 实现——任务冲突处理（5 策略），ConflictDialog 选完策略后调此通道。
 */
export type ConflictStrategy = 'ask' | 'queue' | 'preempt' | 'fork' | 'reject';

/**
 * v2.6.0 启动恢复卡条目（spec §5.6 IPC 面；2026-09-30 语义修正后仅 in_progress
 * ——assigned/session_queued 由 executor boot 自愈，不再进卡，主进程 detectInterrupted 同步收窄）：
 *   - taskId / title / status：透传任务行
 *   - agentName：JOIN agent_definitions.name；取不到时降级空串
 *   - journalCount：v2.5 变更账本条目数（store 未注入时 0）
 *   - streamSessionId：断点流 base id（剥 #roll 后缀）；无断点流时空串
 */
export interface InterruptedTaskInfo {
  taskId: string;
  title: string;
  status: 'in_progress';
  agentName: string;
  journalCount: number;
  streamSessionId: string;
}

/**
 * task:create / task:createBatch 单项入参（不含 creatorUserId，由 main 注入）。
 * M3.3 抽出命名类型：批量通道复用同一形状，杜绝两处内联漂移。
 */
export interface TaskCreateInput {
  workspaceId: string;
  title: string;
  description?: string;
  priority?: number;
  sourceSessionId?: string | null;
  sourceMessageId?: string | null;
  assigneeAgentId?: string | null;
  /** v29：委派目标三列（互斥） */
  targetTeamId?: string | null;
  /** v29：委派目标三列（互斥） */
  targetSessionId?: string | null;
  /** v29：循环规则 */
  recurrenceRule?: string | null;
  scheduledAt?: number | null;
  deadlineAt?: number | null;
  /** 看板分组（UX 修复）：落组 id，缺省不分组；主进程三重校验（存在/同 ws/未归档） */
  groupId?: string;
  /** M2.1：执行路由三选；缺省不传 = 本机（落列 NULL）；异形主进程人话拒绝 */
  routing?: TaskRouting;
  /** M3.3：父任务 id；主进程校验存在 + 链无环 */
  parentTaskId?: string | null;
  /** M3.3：直接依赖任务 id 列表；主进程逐个校验存在 + 环检测（同事务插边） */
  dependsOn?: string[];
}

/**
 * M3.3 task:createBatch 返回：per-item union（部分成功允许，与逐行循环 catch
 * 语义等价）；失败项带原始 index 供 per-line 错误展示。
 */
export interface TaskCreateBatchResult {
  results: Array<{ ok: true; task: TaskRow } | { ok: false; index: number; error: string }>;
}

export interface TaskApiSurface {
  create(input: TaskCreateInput): Promise<TaskRow>;
  /**
   * M3.3 批量创建：上限 50（超限整体 bad_request）；逐项走 create 同源校验
   * （分组/routing/依赖），失败只败该项不拖垮整批
   */
  createBatch(input: { items: TaskCreateInput[] }): Promise<TaskCreateBatchResult>;
  /**
   * M3.3 关系写通道：parentTaskId / dependsOn 各自可选更新（未携带的保持不变）；
   * dependsOn 为全量替换语义（数组即最终态）；parentTaskId 传 null 清除父任务。
   * 成环/引用不存在任务时人话拒绝（含环路径）
   */
  setRelations(input: {
    taskId: string;
    parentTaskId?: string | null;
    dependsOn?: string[];
  }): Promise<TaskRow>;
  list(opts: {
    workspaceId?: string;
    status?: TaskStatus | TaskStatus[];
    assigneeAgentId?: string;
    executionSessionId?: string;
    sourceSessionId?: string;
    /** 按 source_message_id 集合过滤（会话任务联动 G3：撤回时命中受影响任务）；空数组跳过条件 */
    sourceMessageIds?: string[];
    /** 归档三态透传（看板重构 Task 6/7）：'exclude' 默认 / 'only' 只回归档 / 'all' 全回 */
    archived?: 'exclude' | 'only' | 'all';
    orderBy?: 'priority' | 'scheduled_at' | 'created_at' | 'created_at_desc';
    limit?: number;
  }): Promise<TaskRow[]>;
  get(id: string): Promise<TaskRow | null>;
  update(id: string, patch: Partial<Omit<TaskRow, 'id' | 'createdAt'>>): Promise<void>;
  transition(
    id: string,
    to: TaskStatus,
    extraPatch?: Partial<Omit<TaskRow, 'id' | 'createdAt'>>,
  ): Promise<TaskRow>;
  /** B8 实现：拉起 execution session + transition 到 in_progress */
  start(id: string, opts: { executionSessionId?: string; createNewRoom?: boolean }): Promise<{
    executionSessionId: string;
    createdNewRoom: boolean;
  }>;
  cancel(id: string): Promise<void>;
  /**
   * 看板重构 Task 6 → 2026-09-30 排序退役：拖拽换列/换组单一通道——renderer
   * 只发目标（column/groupId），动作裁决（start/complete/cancel/换组/no-op）
   * 全部在主进程 executeMove 单点；列内顺序由 pinned/创建时间决定（无落点锚）
   */
  move(
    id: string,
    target: {
      column: BoardColumnKey;
      groupId: string | null;
    },
  ): Promise<TaskRow>;
  /**
   * 顶置开关（迁移 050）：全状态可用；pin 写当前时间（排序键，重复 pin 刷新
   * = 重新压顶），unpin 置空。语义单点在主进程 repo.setTaskPinned
   */
  setPinned(id: string, pinned: boolean): Promise<TaskRow>;
  /** 看板重构 Task 6：归档（仅终态任务可归档，非终态 reject） */
  archive(id: string): Promise<TaskRow>;
  /** 看板重构 Task 6：取消归档 */
  unarchive(id: string): Promise<TaskRow>;
  /**
   * K7-5 + v2.6.0 多路恢复（spec §5.6 IPC 面）：
   *   - paused → 既有 K7-5：transition + kickoff 重注入（返回 TaskRow）
   *   - in_progress → v2.6.0 断点续跑：返回 TaskRow & { streamSessionId }（renderer 据此关联 SSE 流）
   *   - assigned / session_queued → v2.6.0 全新执行：notifyExecutor 触发既有 executor 放行
   * 不在以上三态的任务抛错。
   */
  resume(id: string): Promise<TaskRow & { streamSessionId?: string }>;
  /**
   * v2.6.0 启动恢复卡数据源（spec §5.2；2026-09-30 语义修正后仅列 in_progress
   * ——排队任务由 executor boot 自愈，不进卡）供 renderer 渲染 ResumeNotice。
   * D6 检测时不改任务状态。
   */
  listInterrupted(): Promise<InterruptedTaskInfo[]>;
  /** B9：任务冲突处理——ConflictDialog 选完策略后调此通道，main process 执行副作用 */
  resolveConflict(input: {
    newTaskId: string;
    currentTaskId: string;
    currentRoomId: string;
    strategy: ConflictStrategy;
  }): Promise<
    | { action: 'queue'; newTaskId: string }
    | { action: 'preempt'; newTaskId: string; pausedTaskId: string }
    | { action: 'fork'; newTaskId: string; newExecutionSessionId: string }
    | { action: 'reject'; reason: string }
    | { action: 'ask' }
  >;
}

/**
 * 任务组行（renderer 镜像，看板重构 Task 7）。
 * 与 electron 端 storage/task-groups/repo.ts 的 GroupRow 对齐（跨进程独立定义，仅结构对齐）。
 */
export interface GroupRow {
  id: string;
  workspaceId: string;
  name: string;
  /** 语义色名（'accent'/'violet'/'success'/'warning'…），null=默认 */
  color: string | null;
  position: number;
  archivedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

/**
 * 看板重构 Task 7：任务组通道面（IPC 命名空间 taskGroup:*，
 * electron/src/main/task/groups.ipc.handlers.ts）。
 */
export interface TaskGroupApiSurface {
  /** 按 workspace 列组；archived 三态：'exclude'（默认）活跃 / 'only' 只回归档 / 'all' 全回 */
  list(workspaceId: string, opts?: { archived?: 'exclude' | 'only' | 'all' }): Promise<GroupRow[]>;
  /** 新建组（尾插 position） */
  create(input: { workspaceId: string; name: string; color?: string }): Promise<GroupRow>;
  /** 改名/换色；省略字段保留原值 */
  update(id: string, patch: { name?: string; color?: string }): Promise<GroupRow>;
  /** 按入参顺序整段重写 position */
  reorder(orderedIds: string[]): Promise<void>;
  /**
   * 归档组（单事务级联：组内非终态任务 cancel + 全组任务/组本体置 archived_at）。
   * 返回级联取消的任务 id 列表与归档任务数；已归档组幂等返回零值。
   */
  archive(id: string): Promise<{ cancelledIds: string[]; archivedCount: number }>;
  /** 解档组（只复活组本体，任务保持归档） */
  unarchive(id: string): Promise<GroupRow>;
  /**
   * 删除组（删容器不删内容）：单事务内组内全部任务（活跃+已归档，归档态保留）
   * 转移到目标组后删组行。moveToGroupId=null 落未分组；返回转移任务数。
   */
  delete(id: string, moveToGroupId: string | null): Promise<{ movedCount: number }>;
}

export interface StartAgentInput {
  member: WorkspaceAgentMember;
  workspaceId: string;
}

/** agent:addMember 入参（v25 spec §5：无 role/parent；同 ws 同 def 重复加入由 UNIQUE 约束报错） */
export interface AddMemberInput {
  workspaceId: string;
  agentDefinitionId: string;
  /** 可选；非空 = 写 keychain override；空 = 用供应商 key */
  apiKeyOverride?: string;
}

/** agent:enablePreset 入参（spec 2026-09-22 资源库预设 agent 启用与 LLM 配置） */
export interface EnablePresetInput {
  /** 预设 agent slug（resources/agents/<slug>.yaml） */
  slug: string;
  modelProviderId: string;
  modelName: string;
  thinkingJson?: ThinkingConfig | null;
  /** 传入则加入该 workspace 并启动（幂等） */
  joinWorkspaceId?: string;
  /** 仅 joinWorkspaceId 存在时生效 */
  setAsDefault?: boolean;
}

/** agent:definitionImpact 返回——删除/停用确认框的披露数据（2026-10-10 披露式级联） */
export interface DefinitionImpact {
  /** 将被移出的成员总数（跨全部工作空间） */
  memberCount: number;
  /** 涉及的工作空间名（去重） */
  workspaceNames: string[];
  /** 将随 FK 级联解散的团队名（该 agent 成员为 leader） */
  ledTeamNames: string[];
  /** 全部成员失效、将变为只读的会话数（消息历史保留） */
  readOnlySessionCount: number;
  /** 将被清空默认 agent 设置的工作空间名 */
  defaultForWorkspaceNames: string[];
}

/** agent:enablePreset 返回 */
export interface EnablePresetResult {
  def: AgentDefinition;
  member: WorkspaceAgentMember | null;
}

/** v2.x 工具目录条目（tools:getCatalog 返回项；electron 侧 catalog-entry.ts 的镜像契约） */
export interface ToolCatalogEntry {
  name: string;
  /** 中文显示名（UI 主名）；name 保留为提交 ref 与日志对照 */
  displayName: string;
  description: string;
  category: string;
  categoryEmoji: string;
  /** Tier 1 公共默认集 = true */
  defaultOn: boolean;
  riskNote?: string;
  conditional?: string;
}


/**
 * A 子系统：IM 消息（SQLite messages 表 row）。
 *
 * v2.0 重构：从 Matrix event payload 改为 SQLite 唯一真相源。
 * 关键变化：
 *   - id（SQLite UUID）替代 eventId（Matrix event ID）
 *   - createdAt 替代 timestamp
 *   - 删除 content 字段（不再从 Matrix event 富字段读取——
 *     thinking/tool_calls/dispatches 等改由 message_events 表 + aggregateEvents 重建）
 *
 * 与 electron 端 MessageRow 结构对齐（renderer 端独立定义，仅结构对齐）。
 */
export interface ImMessage {
  id: string; // SQLite messages.id（UUID）
  sessionId: string;
  sender: string;
  body: string;
  eventType: string;
  streamSessionId: string | null;
  parentStreamSessionId: string | null;
  segmentOf: string | null;
  segmentIndex: number | null;
  status: 'streaming' | 'done' | 'failed' | 'aborted';
  source: 'local' | 'lan' | 'hub' | 'matrix';
  workspaceId: string | null;
  /**
   * 任务板任务 id（T-xxx）：kickoff 用户消息行携带（executor 放行注入，
   * locateTaskExecution 的定位锚点）；agent 回复行落 dispatch 链 id
   * （chainTaskId，另一 ID 空间）；其余消息 null。
   */
  taskId: string | null;
  /**
   * 输入框上下文序列化（v2.11 spec 2026-09-16 §5.3）：renderer ↔ main 契约 + messages.context_json 落库字段。
   * wire 直通（camelCase 字符串），主进程不做解析；renderer 消费时调 parseMessageContext 解码。
   * null = 旧消息 / 无上下文。
   */
  contextJson: string | null;
  createdAt: number;
  updatedAt: number;
}

/** 输入框上下文项——技能（metadata 级；正文仅派发时在主进程展开） */
export interface SkillContextItem {
  slug: string;
  /** 展示名（选择时从资源索引快照，渲染 chip 不反查） */
  name: string;
}

/** 输入框上下文项——workspace 文件路径引用（相对路径，'/' 分隔） */
export interface FileContextItem {
  path: string;
}

/** 输入框上下文项——图片（多模态 spec 2026-09-26 §6：粘贴/拖入落盘产物或 @ 菜单图片文件） */
export interface ImageContextItem {
  /** workspace 相对路径（asset:saveImage 的 `.momo/assets/<hash>.<ext>` 或 @ 菜单文件） */
  path: string;
  /** 降采样后宽度 px（token 估算免图片解析依赖，spec §9） */
  w: number;
  /** 降采样后高度 px */
  h: number;
}

/** 输入框上下文项——会话引用（指针级；完整内容由 agent 用 read_session 工具按需读取，spec 2026-09-30 §6） */
export interface SessionContextItem {
  sessionId: string;
  /** 展示名（选择时从会话列表快照，chip 渲染不反查） */
  title: string;
}

/**
 * 一条消息携带的输入框上下文（renderer ↔ main 契约 + messages.context_json 载荷）。
 * 解析收口在 renderer 端 src/lib/message-context.ts（防御性：null / 损坏 / 非法形状 → null）。
 */
export interface MessageContext {
  skills: SkillContextItem[];
  files: FileContextItem[];
  /** 图片引用（可选：旧消息 / 无图消息缺省 = 无图，全链路按缺省兼容）；单条消息上限 6 张（renderer 拦截 + sanitize 双层） */
  images?: ImageContextItem[];
  /** 会话引用（可选：旧消息 / 无引用缺省 = 无；指针级，内容由 read_session 按需读） */
  sessions?: SessionContextItem[];
}

/** MCP 工具信息（tools/list 响应的单条工具，与 electron 端 McpToolInfo 对齐） */
export interface McpToolInfo {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** 能力类型：tool（内置工具）/ mcp（MCP server）/ skill（技能），与 electron 端 CapabilityType 对齐 */
export type CapabilityType = 'tool' | 'mcp' | 'skill';

/** 某 workspace 的全部能力分配（按类型分桶），与 electron 端 WorkspaceAllocation 对齐 */
export interface WorkspaceAllocation {
  workspaceId: string;
  tools: string[];
  mcps: string[];
  skills: string[];
}

/**
 * Per-assignment 能力 delta（Layer 3），与 electron 端 assignment-capabilities.ts 的
 * AssignmentDeltas 对齐。renderer 端独立定义（跨 workspace 不共享类型，仅结构对齐）。
 * 由 DefinitionEditor / MemberEditDialog 消费。
 */
export interface AssignmentDeltas {
  addedTools: string[];
  removedTools: string[];
  addedMcps: string[];
  removedMcps: string[];
  addedSkills: string[];
  removedSkills: string[];
  /** 成员级插件工具覆盖：added=覆盖定义级禁用（重新启用）、removed=追加禁用 */
  addedPluginTools: string[];
  removedPluginTools: string[];
}

/**
 * 合并后的成员生效能力（spec 2026-10-22 §6.1），与 electron 端
 * capability-merger.ts 的 MergedCapabilities 结构对齐。
 * deniedTools：def 级基线 ∪ 成员级禁用 − 成员级重新启用（同源合并终态）。
 */
export interface EffectiveCapabilities {
  tools: string[];
  mcps: string[];
  skills: string[];
  deniedTools: string[];
}

/** 一条可识别的 commit message 模式，与 electron 端 CommitPattern 对齐 */
export interface CommitPattern {
  code: string;
  name: string;
  regex: string;
  example: string;
}

/** commit message 校验级别，与 electron 端 CommitValidation 对齐 */
export type CommitValidation = 'strict' | 'warning' | 'none';

/** 一份完整的 Git Policy 配置，与 electron 端 GitPolicy 对齐 */
export interface GitPolicy {
  allowAgentCommits: boolean;
  defaultBranch: string;
  fallbackBranchPattern: string;
  commitMessage: {
    template: string;
    patterns: CommitPattern[];
    validation: CommitValidation;
    trailers: Array<{ key: string; value: string }>;
  };
}

/** 审计日志查询入参（可选筛选 + 分页），与 electron 端 ToolCallQueryOpts 对齐 */
export interface ToolCallQueryOpts {
  limit?: number;
  offset?: number;
  agentBotUserId?: string;
  toolName?: string;
}

/** 单条工具调用审计记录，与 electron 端 ToolCallRecord 对齐 */
export interface ToolCallRecord {
  id: string;
  workspaceId: string;
  agentBotUserId: string;
  taskId: string | null;
  toolName: string;
  inputSummary: string;
  outputSummary: string;
  success: boolean;
  durationMs: number;
  timestamp: string;
}

/** 审计容量配额信息（audit:getQuota 返回），与 electron 端 AuditQuotaInfo 对齐 */
export interface AuditQuotaInfo {
  /** 生效配额（MB）——已按 workspace 覆盖 > 全局 > 默认 100 解析 */
  quotaMb: number;
  /** 估算占用字节数（文本列长度和 + 行数 × 400） */
  usedBytes: number;
  rowCount: number;
}

/**
 * Marketplace 可安装项，与 electron 端 MarketplaceItem 对齐。
 * renderer 端独立定义（跨进程不共享类型，仅结构对齐）。
 */
export interface MarketplaceItem {
  id: string;
  type: 'agent' | 'mcp' | 'skill';
  slug: string;
  name: string;
  version: string;
  author: string;
  description: string;
  readme: string;
  tags: string[];
  category: string;
  iconEmoji: string;
  verificationStatus: 'unverified' | 'community' | 'verified' | 'official';
  /** 下载地址（空串表示 builtin 内联项） */
  downloadUrl: string;
  /** sha256 hex 校验和（空串表示不校验） */
  checksum: string;
  sizeBytes: number;
  installCount: number;
}

/** Marketplace catalog 顶层结构，与 electron 端 Catalog 对齐 */
export interface MarketplaceCatalog {
  version: string;
  updatedAt: string;
  items: MarketplaceItem[];
}

/** 已安装包记录，与 electron 端 InstalledPackage 对齐 */
export interface InstalledPackage {
  id: string;
  itemId: string;
  itemType: string;
  slug: string;
  version: string;
  cachePath: string;
  installedAt: string;
}

/** LLM 协议平台（与 electron 端 provider-crud.ts 的 ProviderPlatform 对齐） */
export type ProviderPlatform = 'openai' | 'anthropic';

/** ─── 供应商预设（与 electron 端 llm/provider-presets 对齐，v31 起） ─── */
export type ThinkingWire = 'toggle' | 'toggle-effort' | 'effort' | 'anthropic-budget';

export type ReasoningCapability =
  | { kind: 'none' }
  | { kind: 'toggle' }
  | { kind: 'effort'; values: readonly string[]; default: string };

export interface ThinkingConfig {
  mode: 'auto' | 'off' | 'on';
  effort: string | null;
}

export interface PresetModel {
  id: string;
  contextWindow: number;
  outputTokens: number;
  reasoning: ReasoningCapability;
  thinkingWire?: ThinkingWire;
}

export interface ProviderPreset {
  key: string;
  name: string;
  baseUrl: string;
  platform: ProviderPlatform;
  thinkingWire: ThinkingWire;
  docsUrl?: string;
  fetchListHint?: boolean;
  models: PresetModel[];
}

/** 供应商的模型列表条目（与 electron 端 ProviderModel 对齐，v24 起） */
export interface ProviderModel {
  providerId: string;
  modelId: string;
  enabled: boolean;
  addedAt: number;
  /** 用户手动覆盖的上下文窗口（token）；null=未知（走内置目录，migration v30 起） */
  contextWindow: number | null;
  /** 模型级思维配置（用户设置）；null=未配置（auto） */
  thinkingJson: ThinkingConfig | null;
  /** 思维模式能力（服务端 resolve：预设表→正则目录；只读） */
  reasoning: ReasoningCapability;
  /** resolve 链生效窗口（用户列→预设→目录）；null=未知 */
  effectiveWindow: number | null;
  /** 视觉输入能力位（用户覆盖列，migration 045 起；与 electron 端 ProviderModel 对齐） */
  vision: boolean;
}

/** 全局模型供应商（注册表项，不含 apiKey） */
export interface ModelProvider {
  id: string;
  name: string;
  baseUrl: string;
  /** @deprecated v2.0 P2 起由 provider_models 模型列表取代，UI 不再展示；DB 列保留（agent 定义快捷填充仍读旧列） */
  defaultModel: string | null;
  isDefault: boolean;
  createdAt: string;
  /** LLM 协议平台（v24 起显式存储，取代 baseUrl 启发式检测） */
  platform: ProviderPlatform;
  /** 来源预设 key；null=自定义供应商（v31 起） */
  presetKey: string | null;
  /** 最近一次「检查连接」成功时间（ISO）；null/缺省 = 未验证（D7 徽标依据，主进程透传） */
  lastVerifiedAt?: string | null;
}

/** 默认模型引用：指向某供应商模型列表中的一个模型（v2.0 P2 起） */
export interface DefaultModelRef {
  providerId: string;
  modelId: string;
}

/** 全局会话配置（v1.4：工具调用上限；v2.0 P2：审计配额 + 四类默认模型），
 * 与 electron 端 GlobalSettings 对齐。renderer 端独立定义，仅结构对齐。 */
export interface GlobalSettings {
  /** 工具调用上限默认值。-1=无限, 0=禁用, N=上限 */
  maxToolCalls: number;
  /** 审计日志全局容量上限（MB）；workspace 级可覆盖。默认 100。 */
  auditQuotaMb: number;
  /** 四类默认模型（P2 只存不消费；向量/重排 2.1 知识库启用，会话 fallback P3 接线） */
  defaultChatModel?: DefaultModelRef;
  defaultMultimodalModel?: DefaultModelRef;
  defaultEmbeddingModel?: DefaultModelRef;
  defaultRerankModel?: DefaultModelRef;
  /** 全局并发任务上限（electron 端读 global_settings 表 v21，默认 3）。 */
  maxConcurrentTasks?: number;
  /** v2.2 P1：记忆系统总开关（默认 true；false = 注入与提取暂停，数据保留） */
  memoryEnabled?: boolean;
  /** v2.2 P2：自动提取子开关（默认 true；与 memoryEnabled 联动——总开关停用时强制不工作） */
  memoryExtractionEnabled?: boolean;
  /** v2.4：OS 沙箱模式（strict=沙箱不可用时 bash 拒绝执行 / permissive=降级运行并审计标记）。默认 strict */
  sandboxMode?: 'strict' | 'permissive';
  /** v2.4：沙箱内 bash 网络出站布尔开关（已废弃——被 sandboxNetworkPolicy 取代；旧键留存供回滚） */
  sandboxNetwork?: boolean;
  /**
   * 沙箱网络出站双态策略（2026-09-13 修订 B）：deny 一律禁网 / allow 全放行
   * （默认——三态时代的 ask 已并入 allow，读时懒迁移收敛）。
   */
  sandboxNetworkPolicy?: 'deny' | 'allow';
  /**
   * v2.5：沙箱工具链目录写入策略。**2026-10-04 随工具链机制整体移除**（硬门控
   * 授权卡取代）：本字段不再被生产消费；存量 JSON 键留存不读不写（回滚安全）。
   */
  sandboxToolchainPolicy?: 'deny' | 'allow';
  /**
   * v2.5：可授权写入的工具链目录清单。**2026-10-04 随工具链机制整体移除**：
   * 本字段不再被生产消费；存量 JSON 键留存不读不写。
   */
  sandboxToolchainDirs?: string[];
  /** v2.5：变更账本 workspace 级 blob 配额（MB，按 1024² 换算；超限滚动清理最旧任务组）。默认 200。 */
  journalQuotaMb?: number;
}

/** 会话级配置（v1.4 + B9；v23 起存 sessions.settings_json），与 electron 端 SessionSettings 对齐 */
export interface SessionSettings {
  /** NULL=继承全局 */
  maxToolCalls: number | null;
  /** 任务冲突策略（migration v19 加列，默认 'ask'） */
  conflictStrategy: 'ask' | 'queue' | 'preempt' | 'fork' | 'reject';
}

/**
 * v1.6.2：单次 zip 上传返回结构（resource:uploadSkill 返回数组，即使只装一个 skill）。
 * 与 electron 端的 InstalledSkill 区别：不含 source / installedAt（这两个由 listResources 二次解析）。
 */
export interface UploadedSkill {
  slug: string;
  /** 展示名（来自 frontmatter.name，无则用 slug 兜底） */
  name: string;
  description: string;
}

/**
 * P2.6：Git 仓库 skill 扫描结果条目（resource:scanGitRepoSkills 返回的 skills 项）。
 * 与 electron 端 skill/git-import.ts 的 ScannedSkill 对齐（renderer 端独立定义，仅结构对齐）。
 */
export interface ScannedSkill {
  /** 安装目录名（SKILL.md 父目录名；根级条目用 frontmatter.name 转 kebab，无则仓库名兜底） */
  slug: string;
  /** 展示名（来自 frontmatter.name，无则用 slug 兜底） */
  name: string;
  description: string;
}

/**
 * P2.6：Git 仓库 skill 导入结果（resource:importGitRepoSkills 返回）。
 * imported 为成功清单（含同 hash 幂等跳过的既有条目）；failures 为逐条失败原因
 * （单条失败不中断其余导入）。与 electron 端 skill/git-import.ts 返回形状对齐。
 */
export interface GitImportResult {
  imported: UploadedSkill[];
  failures: Array<{ slug: string; reason: string }>;
}

/**
 * P3 Task 7：resource:registerMcp 入参——注册自定义 MCP 的最小配置。
 * id / version 由主进程补全（version 缺省存 '1.0.0'），source 固定 'custom'，
 * 注册成功返回新条目的 ResourceItem。
 */
export interface RegisterMcpInput {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /** 可选版本号；缺省由主进程存 '1.0.0' */
  version?: string;
  /** 传输形态；缺省 'stdio'。远程条目传 'streamable_http' + url（P2 Task 7 二态透传） */
  transport?: 'stdio' | 'streamable_http';
  /** 远程端点（transport='streamable_http' 必填，http/https 均可，http 供自建/本地测试；remote 时 command 空串占位） */
  url?: string;
  /** P2.4：远程条目请求头（含鉴权 key，沿用不落日志纪律）；与 electron 端 ipc.handlers.ts 对齐 */
  headers?: Record<string, string>;
  /** P2.4：stdio 条目子进程工作目录；缺省不传（与 bundle 导入 spawn 同语义）；与 electron 端 ipc.handlers.ts 对齐 */
  cwd?: string;
}

/** resource:createSkill 入参——表单创建 skill（spec 2026-09-22 资源库重设计） */
export interface SkillCreateInput {
  name: string;
  description: string;
  body: string;
}

/**
 * v1.7 资源类型：agent（子 agent 定义）/ mcp（MCP server 包）/ skill（技能包）/
 * plugin（插件包——P1 注册与展示，组件激活在 P2+，spec 2026-10-15）。
 * 与 electron 端 resource/types.ts 的 ResourceType 对齐。
 */
export type ResourceType = 'agent' | 'mcp' | 'skill' | 'plugin';

/**
 * v1.7 资源来源：
 *   - builtin      系统预置（随应用分发，不可删除）
 *   - marketplace  网络资源（远程 catalog 下载安装）
 *   - custom       自定义（用户本地注册 / 上传）
 *   - smithery     Smithery registry 安装（P2 双轨·国际，spec 2026-09-22）
 *   - hub          momo-hub 自建节点资源（M1c 第五源，spec 2026-10-24 §6.1）
 * modelscope 已于 P2.1 移除；p2p 共享已于 2026-10-20 随 P2P 子系统移除。
 * 与 electron 端 resource/types.ts 的 ResourceSource 对齐。
 */
export type ResourceSource =
  | 'builtin'
  | 'marketplace'
  | 'custom'
  | 'smithery'
  | 'hub'
  | 'plugin';

/**
 * v1.7 资源列表过滤条件，所有字段可选，undefined 表示不过滤该维度。
 * 与 electron 端 resource/types.ts 的 ResourceFilter 对齐。
 */
export interface ResourceFilter {
  type?: ResourceType;
  source?: ResourceSource;
  /** workspace 级启停解析用（plugin 行 enabled；缺省按启用展示） */
  workspaceId?: string;
}

/**
 * P2.3 预置清单条目（resource:listBuiltinPresets 返回形状的最小只读面，
 * 不含 systemPrompt / 工具引用等重字段）。
 * 与 electron 端 agent/builtin.ts 的 BuiltinPresetItem 对齐（renderer 端独立
 * 定义，仅结构对齐——同 ResourceItem 惯例）。
 */
export interface BuiltinPresetItem {
  /** 预设 slug（启用链路 resource key——EnablePresetDialog / enablePresetWithJoin 消费） */
  slug: string;
  /** 展示名 */
  name: string;
  description: string;
  iconEmoji: string;
}

/**
 * 单个预置 agent 能力预览（resource:previewBuiltinPreset 返回形状，2026-10-08
 * 预设可见化 + 薄 fork）。只读、恒为 YAML 最新版（不受已启用 DB 行版本影响）。
 * 与 electron 端 agent/builtin.ts 的 BuiltinPresetPreview 对齐（renderer 端独立
 * 定义，仅结构对齐——同 BuiltinPresetItem 惯例）。
 */
export interface BuiltinPresetPreview {
  slug: string;
  name: string;
  iconEmoji: string;
  description: string;
  /** 全量系统提示词——展示层自行截断；「复制为自定义」预填需要全量 */
  systemPrompt: string;
  /** 工具 ref 列表（CapabilityTabs Capabilities.tools 同形） */
  tools: string[];
  mcps: string[];
  skills: string[];
}

/**
 * v1.7 统一资源项——前端 UI/IPC 的核心数据结构。
 * 顶层字段对所有 source 通用；source 特有信息放在对应的可选 namespace 字段中。
 * 与 electron 端 resource/types.ts 的 ResourceItem 对齐（renderer 端独立定义，仅结构对齐）。
 */
export interface ResourceItem {
  /** 资源全局唯一 id，格式 `${source}-${type}-${slug}` */
  id: string;
  type: ResourceType;
  source: ResourceSource;
  /** source 内业务标识（agent slug / mcp name / skill slug），不含前缀 */
  slug: string;
  /** 展示名（i18n 后的名字，区别于 slug） */
  name: string;
  description: string;
  version?: string;
  /**
   * 已装版本（D7，M2 Task 1）：installed_packages 记账行版本。
   * hub 已装项「可更新」角标锚定本字段（?? version）——目录先行 + 事件迟到时
   * version（目录 head）与事件版本恒等，锚它会误判「已是最新」。仅 installed 行携带。
   */
  installedVersion?: string;
  iconEmoji?: string;
  /** 是否已安装到本地（builtin 永远 true） */
  installed: boolean;
  /** 是否可安装（builtin = false） */
  installable: boolean;
  /** 是否可删除（仅 builtin = false） */
  removable: boolean;
  /** builtin 项的扩展元数据 */
  builtin?: {
    category?: string;
    tags?: string[];
    /** 仅 type=agent：预设已启用（spec 2026-09-22） */
    agentEnabled?: boolean;
  };
  /** marketplace 项的扩展元数据 */
  marketplace?: {
    author: string;
    readme: string;
    downloadUrl: string;
    checksum: string;
    verificationStatus: 'official' | 'verified' | 'community' | 'unverified';
    sizeBytes?: number;
    installCount?: number;
    tags: string[];
    category: string;
  };
  /** plugin 源行：其插件在目标 workspace 停用（展示层徽标 / 选择器过滤，spec 2026-10-21 矩阵 C1-C3） */
  pluginDisabled?: boolean;

  /** custom 项的扩展元数据 */
  custom?: {
    installedAt: string;
    mcpConfig?: { command: string; args: string[]; env?: Record<string, string> };
    skillFrontmatter?: { name?: string; version?: string };
    agentSystemPromptHash?: string;
    /** MCP 条目的传输形态（只读；「配置」按钮显示条件：transport === 'streamable_http'，spec §6.1） */
    transport?: 'stdio' | 'streamable_http';
  };
  /**
   * mcp_definitions DB 行派生项（custom / smithery 源）的启停态（组⑤）。
   * builtin catalog 项无 DB 行不带该段；禁用 = 定义保留、运行时切断。
   */
  mcp?: { enabled: boolean };
  /** plugin 项的扩展元数据（P1：注册与展示；组件运行时激活在 P2+，spec §10） */
  plugin?: {
    /** 插件域 id（config 通道入参用——资源 id 有 custom-plugin- 前缀不可直用） */
    id: string;
    state: 'active' | 'missing';
    devSource: boolean;
    sourcePath: string | null;
    /** manifest.components 声明的组件键列表（UI 详情展示） */
    components: string[];
    /** 当前 workspace 启停态（行缺失 = 停用，spec 2026-10-21 §2） */
    enabled: boolean;
  };
}

/**
 * 插件安装结果摘要（plugin:installZip / installDevDir 返回形状）。
 * 与 electron 端 plugin/ipc.handlers.ts 的 PluginSummary 结构对齐
 * （renderer 独立定义，仅结构对齐——同 ResourceItem 惯例）。
 */
export interface PluginSummary {
  id: string;
  name: string;
  version: string;
  description: string;
  state: 'active' | 'missing';
  source: 'zip' | 'dev';
  components: string[];
}

/** plugin:getDetail 返回形状（spec 2026-10-21 §9② 组件清单，只读七面） */
export interface PluginDetail {
  pluginId: string;
  mcps: Array<{ name: string }>;
  tools: Array<{ fullName: string; description: string; pluginName: string }>;
  skills: Array<{ slug: string }>;
  agents: Array<{ id: string; name: string }>;
  panels: Array<{ panelId: string; title: string }>;
  service: boolean;
  config: boolean;
}

/** 可用面板清单项（plugin:listPanels 返回形状；workspace 启用过滤后） */
export interface PluginPanelInfo {
  pluginId: string;
  pluginName: string;
  panelId: string;
  title: string;
  icon: string;
  entryUrl: string;
  /** 工作空间维度 v1.1：sidebar = 侧栏槽（现状）；page = 主区独立视图 */
  placement: 'sidebar' | 'page';
}

/** config 属性声明（主进程归一化后形状；v1 子集） */
export interface PluginConfigPropertyDecl {
  type: 'string' | 'number' | 'boolean';
  title?: string;
  sensitive?: boolean;
  /** 工作空间维度 v1.1：缺省 global（设置页「按工作空间」徽标依据） */
  scope?: 'workspace' | 'global';
  enum?: (string | number)[];
}

/** plugin:listAssembledTools 返回项（工作空间维度 v1.1 spec §7.3——agent 配置 UI 数据源） */
export interface PluginToolInfo {
  pluginId: string;
  pluginName: string;
  toolName: string;
  /** 全限定名 = plugin:<id>/<短名>（deniedTools 精确名形态） */
  fullName: string;
  description: string;
}

/** plugin:getConfig / setConfig 返回形状（敏感值只出在场布尔，明文永不外泄） */
export interface PluginConfigView {
  schema: { properties: Record<string, PluginConfigPropertyDecl>; required: string[] };
  values: Record<string, unknown>;
  sensitiveConfigured: Record<string, boolean>;
  /** 工作空间维度 v1.1：逐键作用域（workspace 层值已按 wsId 合并进 values） */
  scopes: Record<string, 'workspace' | 'global'>;
}

/** 插件域 IPC 面（P1：安装 / 启停 / 卸载；P2：reload；P4：面板与 config，spec §6） */
export interface PluginApiSurface {
  installZip(data: Uint8Array, filename: string, workspaceId?: string): Promise<PluginSummary>;
  installDevDir(dir: string, workspaceId?: string): Promise<PluginSummary>;
  setEnabled(id: string, workspaceId: string, enabled: boolean): Promise<void>;
  uninstall(id: string, keepData: boolean): Promise<void>;
  reload(id: string): Promise<PluginSummary>;
  getDetail(pluginId: string, workspaceId?: string): Promise<PluginDetail>;
  listPanels(workspaceId: string): Promise<PluginPanelInfo[]>;
  listAssembledTools(workspaceId: string): Promise<PluginToolInfo[]>;
  callService(pluginId: string, method: string, params: unknown, workspaceId?: string): Promise<unknown>;
  getConfig(pluginId: string, workspaceId?: string): Promise<PluginConfigView | null>;
  setConfig(pluginId: string, values: Record<string, string | number | boolean | null>, workspaceId?: string): Promise<PluginConfigView>;
  onPanelsChanged(callback: () => void): () => void;
  onPanelEvent(callback: (payload: { event: string; payload: unknown }) => void): () => void;
}

/**
 * 网络获取 provider 元信息（P2 双轨 hub，spec 2026-09-22 §4.1）。
 * resource:registryProviders 返回——builtin 恒可用（本地 catalog 零网络），
 * hub 项 degraded 取各自退避状态（UI 置灰信号，不隐藏）。
 */
export interface RegistryProviderMeta {
  key: 'builtin' | 'smithery' | 'hub';
  label: string;
  region: 'local' | 'intl' | 'cn';
  types: ResourceType[];
  degraded: boolean;
}

/**
 * Smithery configSchema 的 renderer 镜像（P2.1 Task 3 直连安装契约）。
 * 与 electron 端 resource/hub-install.ts 的 JsonSchemaLike 对齐（跨进程独立定义，
 * 仅结构对齐）；properties 键即配置字段名，x-from 声明注入位置（缺省 header）。
 */
export interface JsonSchemaLike {
  required?: string[];
  properties?: Record<string, {
    title?: string;
    description?: string;
    'x-from'?: 'header' | 'query';
  }>;
}

/**
 * resource:install smithery 条目两态返回（P2.1 Task 3）：
 *   - { needsConfig: true, schema }  详情 configSchema.required 非空——需用户补配置
 *     （Task 6 弹窗渲染表单，提交走 resource.installSmitheryRemote）
 *   - { needsConfig: false }         已直连安装完成
 */
export interface SmitheryInstallResult {
  needsConfig: boolean;
  schema?: JsonSchemaLike;
}

/**
 * resource:install hub 条目返回（M2.3 T2，与 electron 端 resource/hub-install.ts
 * 的 HubInstallOutcome 对齐——跨进程独立定义，仅结构对齐）：
 *   - { cachePath }                          正常安装/更新完成
 *   - { cachePath, alreadyLatest: true, version }  已装版本 ≥ fresh 目录 latest
 *     （semver）——零动作如实回执（回执横幅「已是最新版本」消费）
 */
export interface HubInstallResult {
  cachePath: string;
  alreadyLatest?: boolean;
  version?: string;
}

/**
 * P2.1 Task 5：DXT / MCPB 本地包 user_config 字段描述（resource:parseMcpBundle
 * 返回 userConfigSchema 的元素）。与 electron 端 mcp/bundle-import.ts 的
 * BundleConfigField 对齐（跨进程独立定义，仅结构对齐）。
 *   - type='string' v1 表单渲染；其它类型 required → import 阶段直接拒绝导入
 */
export interface BundleConfigField {
  type: 'string' | 'number' | 'boolean' | 'directory' | 'file';
  title?: string;
  description?: string;
  required?: boolean;
  sensitive?: boolean;
}

/**
 * P2.1 Task 5：DXT / MCPB 本地包两阶段导入第一阶段（resource:parseMcpBundle）
 * 返回的预览——含解包元信息与 user_config schema（Task 6 ImportBundleDialog
 * 渲染表单）。与 electron 端 mcp/bundle-import.ts 的 BundlePreview 对齐。
 *   - tempId 仅为无状态占位（import 阶段重解包方案，renderer 持有原文件 buffer
 *     二次传参，无需回传 tempId；主进程不维护 tempId→目录映射）
 */
export interface BundlePreview {
  name: string;
  displayName: string;
  version: string;
  description: string;
  serverType: 'node' | 'python' | 'binary';
  /** 启动结构预览（command + args 原始拼接，${...} 占位保留——替换发生在 import） */
  commandPreview: string;
  userConfigSchema: Record<string, BundleConfigField>;
  tempId: string;
}

/**
 * resource:registryList 返回条目——与 services/registry 的 RegistryEntry 同构
 * （经 IPC 序列化；跨进程独立定义，仅结构对齐）。
 */
export interface RegistryListEntry {
  id: string;
  type: ResourceType;
  name: string;
  description: string;
  version?: string;
  tags: string[];
  category?: string;
  item: ResourceItem;
}

/**
 * P2.2 Task 6：resource:getMcpConfig 返回的配置视图（McpConfigDialog 数据源）。
 * 与 electron 端 resource/mcp-config.ts 的 McpConfigView 对齐（跨进程独立定义，
 * 仅结构对齐）；schema 镜像用 JsonSchemaLike（electron 端 McpConfigSchema 同源概念）。
 */
export interface McpConfigView {
  name: string;
  transport: 'stdio' | 'streamable_http';
  /** 裸模式标志：无 schema 时 true，编辑弹窗渲染 url 整条 + headers 键值行 */
  bare: boolean;
  /** schema 模式的字段元数据（bare=false 时必有；裸模式缺省） */
  schema?: JsonSchemaLike;
  /** 各字段现值回显（schema 模式按 x-from 反解；裸模式为空对象） */
  values: Record<string, string>;
  /** 远程端点整条（裸模式可编辑回显用；schema 模式表单预填取 url.split('?')[0]，spec §9 D9） */
  url: string;
  /** 裸模式的现有 headers 键值（schema 模式为空对象） */
  headers: Record<string, string>;
}

/**
 * P2.2 Task 6：resource:updateMcpConfig 入参（与 electron 端
 * resource/mcp-config.ts 的 McpConfigUpdateInput 对齐）。
 *   - url 须 https（主进程双防线拒绝）
 *   - config 为 schema 模式字段级值（trim 后空串剔除）
 *   - headers 仅裸模式生效：整包覆盖，schema 模式不传
 */
export interface McpConfigUpdateInput {
  url: string;
  config: Record<string, string>;
  headers?: Record<string, string>;
  /** 编辑期间拉到的新 schema 顺手落库（可选透传） */
  schema?: JsonSchemaLike;
}

/**
 * P2.5 Task 2：resource:getMcpEditView 返回的全字段编辑视图（编辑弹窗预填源）。
 * 与 electron 端 resource/mcp-config.ts 的 McpEditView 对齐（跨进程独立定义，
 * 仅结构对齐）；stdio 与远程形态通吃——另一形态的字段缺省/空对象。
 */
export interface McpEditView {
  name: string;
  transport: 'stdio' | 'streamable_http';
  version: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  /** 仅远程；stdio 为 undefined */
  url?: string;
  /** 仅远程；stdio 为空对象 */
  headers: Record<string, string>;
  /** 仅 stdio */
  cwd?: string;
  /** 组⑤：启停态（编辑保存后据此决定是否跳过 mcp.start 预热） */
  enabled: boolean;
}

/**
 * P2.5 Task 2：resource:updateMcpEntry 入参——RegisterMcpInput 去 name（与
 * electron 端 mcp/types.ts 的 McpEntryUpdateInput 对齐）。name 是 agent 引用键，
 * 编辑不可改，由通道第一参携带；提交走保 id/source/installed_at 的专用 UPDATE。
 */
export interface McpEntryUpdateInput {
  /** 传输形态；缺省 'stdio' */
  transport?: 'stdio' | 'streamable_http';
  /** 可选版本号；缺省存 '1.0.0' */
  version?: string;
  /** stdio 启动命令（远程形态空串占位） */
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /** 远程端点（transport='streamable_http' 必填，强制 https） */
  url?: string;
  /** 远程请求头（含鉴权 key，不落日志） */
  headers?: Record<string, string>;
  /** stdio 子进程工作目录；缺省清空 */
  cwd?: string;
}

/**
 * P2.2 Task 6：resource:danglingMcpRefs 返回的悬空引用条目
 * （DanglingRefsCard 数据源；与 electron 端 resource/mcp-config.ts 的
 * DanglingMcpRef 对齐）。
 */
export interface DanglingMcpRef {
  /** 悬空引用名（如 'filesystem'） */
  refName: string;
  /** 引用了该未注册名字的全部 agent（definitionId + 展示名） */
  agents: Array<{ definitionId: string; name: string }>;
}

/**
 * v1.5 TodoTools 任务项。与 electron 端 tools/todo-types.ts 的 TodoItem 对齐。
 * 因 renderer 无法直接 import electron 源码，这里维持一份等价的本地定义。
 */
export interface TodoItem {
  id: string;
  subject: string;
  status: 'pending' | 'in_progress' | 'completed';
  /**
   * 挂靠来源（turn mandate 契约，spec §5.3）：'user'=本轮用户请求直接要求的步骤；
   * 'agent'=agent 自发扩展。electron 端 todo-tools 解析层缺省 'agent'（保守取向：
   * 未标注不算授权挂靠）。renderer 端为兼容旧 chunk 载荷按可选字段消费。
   */
  source?: 'user' | 'agent';
}

/**
 * A 子系统：事件溯源——单条 stream chunk 落盘一行（MessageEventRow 是持久化的 DB 行，
 * A 子系统重启后从 message_events 表重建流状态）。
 *
 * 两路用同一份 events 数组 + 同一个 aggregateEvents 函数聚合，
 * 保证实时显示和重启显示完全一致（A 子系统核心不变量）。
 */
export interface MessageEventRow {
  id: string;
  messageId: string;
  seq: number;
  eventType:
    | 'thinking_delta'
    | 'text_delta'
    | 'tool_call_start'
    | 'tool_call_result'
    | 'todo_update'
    | 'dispatch_start'
    | 'dispatch_result'
    | 'segment_boundary'
    | 'status_change'
    | 'final'
    // v2.6.0 断点续跑：与 electron 主进程 events-repo.MessageEventRow 联合对齐——
    // steer 事件从主进程 IPC 推送过来时不会被 TS 类型拒绝。
    // renderer 聚合器对 steer 自然跳过（switch 无匹配 case）。
    | 'steer'
    // wire-only 合成 marker（不落库）：thinking wire 截断标志——历史加载时终态
    // 消息 thinking 超预算被截，展开经 session:getMessageThinking 按需取全量
    | 'thinking_truncated';
  payload: Record<string, unknown>;
  createdAt: number;
}

/** MessageEventRow[] 批量推送（IPC 通道 session:message_event_batch） */
export type MessageEventBatch = MessageEventRow[];

/**
 * v2.0 P1 会话内核：会话类型。chat=普通会话；task_execution=任务执行会话。
 * 与 electron 端 storage/sessions/repo.ts 的 SessionRow['kind'] 对齐。
 */
export type SessionKind = 'chat' | 'task_execution';

/**
 * v2.0 P1 会话内核：sessions 表行（renderer 镜像）。
 * 与 electron 端 storage/sessions/repo.ts 的 SessionRow 对齐（跨进程独立定义，仅结构对齐）。
 * v25：加 titleAuto（自动命名标记，spec D4）。
 */
export interface SessionRow {
  id: string;
  workspaceId: string;
  title: string;
  /** 1=自动命名（可被 LLM 替换）；0=用户命名/已手动改名（spec D4） */
  titleAuto: boolean;
  kind: SessionKind;
  /** 会话级设置（maxToolCalls / conflictStrategy）的 JSON 序列化；null=未配置 */
  settingsJson: string | null;
  createdAt: number;
  updatedAt: number;
  /** 最后消息时间戳（会话列表排序键）；null=尚无消息 */
  lastMessageAt: number | null;
  /** 置顶时间戳（spec 2026-10-22 §4.1）；null=未置顶 */
  pinnedAt: number | null;
  /** 所属分组（spec 2026-10-22 §4）；null=未分组 */
  groupId: string | null;
  /** 会话类型（spec 2026-10-22 §3.1）；null=泛化创建路径 */
  sessionType: 'quick' | 'collab' | null;
}

/**
 * v2.0 P1 会话内核：会话成员信息（三表 JOIN 产物）。
 * 与 electron 端 im/session-ops.ts 的 SessionMemberInfo 对齐。
 * v25：role/isCoordinator 退役 → isLeader（建会时快照，接待判定依据，spec §3.3）。
 */
export interface SessionMemberInfo {
  instanceId: string;
  agentName: string;
  iconEmoji: string;
  /** 用户最近运行意图（true=在线） */
  lastRunning: boolean;
  /** 会话创建时的 leader 快照（session_members.is_leader） */
  isLeader: boolean;
  /**
   * 视觉输入能力（2026-09-26 多模态 spec §8）：主进程按成员 def 的
   * (provider, model) 同源 resolve。可选兼容：旧载荷/存量 mock 缺省
   * 按 false 消费（vision ?? false）。运行时以 AGENT_CONFIG 快照为准。
   */
  vision?: boolean;
}

/**
 * v2.0 P1 会话内核：会话列表项（含成员）。
 * 与 electron 端 im/session-ops.ts 的 SessionSummary 对齐。
 */
export interface SessionSummary {
  id: string;
  workspaceId: string;
  title: string;
  titleAuto: boolean;
  kind: SessionKind;
  lastMessageAt: number | null;
  /** 置顶时间戳（spec 2026-10-22 §4.1）；null=未置顶 */
  pinnedAt: number | null;
  /** 所属分组 id（spec 2026-10-22 §4）；null=未分组 */
  groupId: string | null;
  /** 分组名（spec 2026-10-22 §4）；null=未分组 */
  groupName: string | null;
  /** 会话类型（spec 2026-10-22 §3.1）；null=泛化创建路径 */
  sessionType: 'quick' | 'collab' | null;
  members: SessionMemberInfo[];
}

/**
 * 会话分组行（renderer 镜像，spec 2026-10-22 §7）。
 * 与 electron 端 storage/sessions/repo.ts 的 SessionGroupRow 对齐
 * （跨进程独立定义，仅结构对齐）；会话列表按 position ASC, created_at ASC 渲染分组区。
 */
export interface SessionGroupRow {
  id: string;
  workspaceId: string;
  name: string;
  /** 同 workspace 内单调递增（建组 = 当前 max + 1024） */
  position: number;
  /** 组色 #RRGGBB（预览 A rev2）。存量行迁移 068 轮转回填后非空；建组即由 repo 定值 */
  color: string;
  createdAt: number;
}

/**
 * v25 spec §4.4：协作会话目标——单个 agent 或团队（快照展开）。
 * 2026-10-22 spec §5.1：新增第三态 `members`——建会时多选临时组队，
 * leaderInstanceId 必须落在 instanceIds 内（主 agent）。
 * 镜像自 electron/src/main/im/session-ops.ts（两端同步契约）。
 */
export type CollabTarget =
  | { type: 'agent'; instanceId: string }
  | { type: 'team'; teamId: string }
  | { type: 'members'; instanceIds: string[]; leaderInstanceId: string };

/**
 * v2.0 P1 Task 8：session: 命名空间 IPC 契约（会话内核，纯 SQLite 无 Matrix）。
 *
 * v25 Task 6（spec §5）：泛化 create 退役 → createQuick / createCollab。
 * invoke 通道 11 个（session.ipc.handlers.ts）：
 *   list / get / createQuick / createCollab / rename / delete / send /
 *   getMessages / loadOlder / exportMessages / stopAll
 * 推送通道 2 个：
 *   session:message             消息行实时推送（载荷 ImMessage）
 *   session:message_event_batch 流式 events 批量推送（MessageEventBuffer flush）
 */
export interface SessionApiSurface {
  /** 会话列表（含成员）。workspaceId 缺省 = 全部 workspace */
  list(workspaceId?: string): Promise<SessionSummary[]>;
  /** 单会话详情。会话不存在时 invoke 抛错 */
  get(sessionId: string): Promise<{ session: SessionRow; members: SessionMemberInfo[] }>;
  /**
   * 快速会话（spec §4.4）：免弹窗直达 workspace 默认 agent。
   * 未设置默认 agent 时 reject——error message 含 'NO_DEFAULT_AGENT'
   * （Electron IPC 错误只保 message，renderer 以子串识别转引导弹窗）。
   */
  createQuick(workspaceId: string): Promise<SessionSummary>;
  /**
   * 协作会话（spec §4.4）：指定单 agent 或团队（成员快照展开）。
   * title 留空（undefined）→ 动态命名（占位标题起步）。
   */
  createCollab(
    workspaceId: string,
    title: string | undefined,
    target: CollabTarget,
  ): Promise<SessionSummary>;
  /** 重命名会话 */
  rename(sessionId: string, title: string): Promise<{ ok: true }>;
  /** 解散会话 */
  delete(sessionId: string): Promise<{ ok: true }>;
  /**
   * 用户消息写入：落库 + 推送 + P2P 广播 + 冲突检测 + 路由到目标 agent（@ 的 instanceId 列表）。
   * v25 Task 9：返回 readOnly——true 表示会话全部成员已失效（spec §7「会话只读」，UI 据此禁用输入）。
   * v2.11 Task 7：context 第 4 参——输入框上下文 metadata（skill slug / 文件路径），主进程落 messages.context_json。
   */
  send(
    sessionId: string,
    body: string,
    mentionedInstanceIds?: string[],
    context?: MessageContext,
  ): Promise<{ readOnly: boolean }>;
  /**
   * 历史读取：messages + 每条 message 的 events，
   * renderer 用 stream-aggregator 重建 StreamState。
   *
   * 事件裁剪契约（2026-09-25 工作空间切换卡顿修复 + C 方案显示一致性）：
   * - **初始窗口（2026-10-14 P0-1）**：只返回最近 50 条消息（INITIAL_MESSAGES_RECENT）；
   *   更早历史走 loadOlder 翻页
   * - 最近 30 条消息携带全量事件；窗口内单消息事件数 > 2000 或更早消息
   *   走压缩快照（终态写时游程合并：连续 thinking/text delta 合一、结构
   *   事件保留——thinking/正文/工具卡全量保序，交错顺序与流式一致）
   * - **thinking wire 截断（2026-10-14 P0-2）**：终态消息的 thinking 增量在
   *   wire 上截断至预算（THINKING_WIRE_BUDGET 字符），末尾追加合成
   *   thinking_truncated marker——聚合出 thinkingTruncated 标志，展开时经
   *   getMessageThinking 按需取全量
   * - **tool 结果 wire 截断（2026-10-14 第二刀）**：终态消息的
   *   tool_call_result 每条截断至 TOOL_RESULT_WIRE_BUDGET 字符，payload 内嵌
   *   truncated/fullLength 标志（无 marker 事件），展开时经
   *   getMessageToolResults 按需取全量
   * - 快照缺失（历史数据）由主进程就地回填并落库（首访一次付出）
   * - 零事件消息省略 eventsByMessage key（静态气泡渲染 body）
   */
  getMessages(
    sessionId: string,
  ): Promise<{ messages: ImMessage[]; eventsByMessage: Record<string, MessageEventRow[]> }>;
  /**
   * thinking 全量按需拉取（2026-10-14 P0-2，wire 截断配套）：返回该消息全部
   * thinking 游程（seq 升序，与 wire 截断版同 seq 源）。renderer expandThinking
   * 按 seq 归并替换截断版并清除截断标志。
   */
  getMessageThinking(
    messageId: string,
  ): Promise<{ runs: Array<{ seq: number; delta: string }> }>;
  /**
   * 工具结果全量按需拉取（2026-10-14 wire 截断第二刀）：按消息批量返回该消息
   * 全部 tool_call_result 的全量文本（seq 与截断版同源）。renderer
   * expandToolResults 按 seq 替换截断事件（新事件无 truncated 键，success 等
   * 兄弟字段保留），重聚合后截断标志自然消失。
   */
  getMessageToolResults(
    messageId: string,
  ): Promise<{ results: Array<{ seq: number; callId: string; result: string }> }>;
  /**
   * 逐层撤回（turn undo）的消息删除面：按会话归属过滤物理删除消息行
   * （message_events FK 级联 + message_compact_events 清理 + 会话
   * last_message_at 重算均主进程侧完成）。返回实际删除的 id——不属于
   * 该会话的 id 静默跳过。
   */
  deleteMessages(sessionId: string, ids: string[]): Promise<{ deletedIds: string[] }>;
  /** 斜杠命令（spec §5.4）：/compact 等确定性命令。未知命令/运行中/无模型配置时 reject（Error.message 中文提示） */
  command(sessionId: string, command: string): Promise<{ ok: true; message: string }>;
  /** 会话命令注册表（v2.11，spec §6.1）——/ 菜单命令组数据源；主进程 commands.ts 单一真相源 */
  listCommands(): Promise<Array<{ name: string; description: string }>>;
  /**
   * 向前翻页：返回 created_at < beforeTs 的消息。
   * beforeTs 由调用方从当前可见消息的最小 createdAt 推导；count 默认 30。
   * 翻页消息全部走压缩快照（fullRecentCount=0，语义同 getMessages）。
   */
  loadOlder(
    sessionId: string,
    beforeTs: number,
    count?: number,
  ): Promise<{
    messages: ImMessage[];
    eventsByMessage: Record<string, MessageEventRow[]>;
    hasMore: boolean;
  }>;
  /** 导出会话最近 limit 条消息为 Markdown。返回 { filename, content }，renderer 用 Blob 触发下载 */
  exportMessages(sessionId: string, limit: number): Promise<{ filename: string; content: string }>;
  /**
   * 三级中断·会话级急停（spec 2026-10-13 §7.5，通道 session:stopAll）：该会话
   * 全部流 aborted + 全部在途链 cancelled + 待投递回执队列清空。
   */
  stopAll(sessionId: string): Promise<{ stoppedStreams: number; cancelledChains: number }>;
  /**
   * 置顶切换（spec 2026-10-22 §7，通道 session:setPinned）：true=写置顶时间戳
   * （重置顶可上浮置顶区）/ false=取消置顶。与分组互不影响——删组不解除置顶。
   */
  setPinned(sessionId: string, pinned: boolean): Promise<void>;
  /**
   * 归组 / 移出分组（spec 2026-10-22 §7，通道 session:moveToGroup）：
   * groupId=null 为合法的移出路径；非 null 时主进程校验该组属会话所在工作空间，
   * 否则 reject（message 含「分组不存在或不属于当前会话所在工作空间」）。
   */
  moveToGroup(sessionId: string, groupId: string | null): Promise<void>;
  /** 订阅消息行实时推送（session:message） */
  onMessage(callback: (msg: ImMessage) => void): () => void;
  /** 订阅流式 events 批量推送（session:message_event_batch，MessageEventBuffer flush 时触发） */
  onMessageEventBatch(callback: (batch: MessageEventBatch) => void): () => void;
  /** K10：订阅会话列表变化推送（session:listChanged——主进程主动新建执行会话时触发） */
  onListChanged(callback: () => void): () => void;
}

/**
 * 会话分组通道面（spec 2026-10-22 §7；IPC 命名空间 sessionGroup:*，
 * electron/src/main/im/session-group.ipc.handlers.ts）。分组按 workspace 隔离，
 * 置顶/归组两个会话行写面在 api.session（setPinned / moveToGroup）。
 */
export interface SessionGroupApiSurface {
  /** 按 workspace 列组；顺序 position ASC, created_at ASC（分组区渲染序） */
  list(workspaceId: string): Promise<SessionGroupRow[]>;
  /** 建组（尾插 position = max + 1024）；空名/纯空白 reject「分组名不能为空」 */
  create(workspaceId: string, name: string): Promise<SessionGroupRow>;
  /** 改名；空名 reject 同 create（共用名守卫） */
  rename(groupId: string, name: string): Promise<void>;
  /** 删组：组内会话回落未分组（置顶位独立保留），不删会话 */
  delete(groupId: string): Promise<void>;
  /** 组色直写（预览 A rev2）；非 #RRGGBB 格式 reject「颜色值格式不正确」 */
  setColor(groupId: string, color: string): Promise<void>;
}

/**
 * 在途链视图（dispatch:listInFlight 返回项，spec 2026-10-13 §9）。
 * 与主进程 dispatch-registry.ts InFlightChain 逐字段一致（跨进程独立定义，
 * 仅结构对齐）；subAgentName 由主进程解析（D1 inflight-view：listMembers
 * JOIN agentName），成员已删 / 解析失败时为 null，UI 降级短 taskId。
 */
export interface InFlightChainView {
  /** 链 ID（dispatch 事件的 task_id，单点生成沿线透传） */
  taskId: string;
  /** 累计轮次：首派 = 1，followup 复用链 ID 递增 */
  round: number;
  /** 链所在会话 */
  sessionId: string;
  /** PM assignmentId */
  pmAssignmentId: string;
  /** 子 agent assignmentId */
  subAssignmentId: string;
  /** 子 agent 流 id（chip 链级停止的查找键，spec §7.6） */
  subStreamSessionId?: string;
  /** PM 当前流 id */
  pmStreamSessionId?: string;
  /** 链注册时刻（epoch ms） */
  startedAt: number;
  /** 子 agent 展示名（D1 主进程解析 agentName；成员已删 / 解析失败 → null，UI 降级短 taskId） */
  subAgentName: string | null;
}

/**
 * 三级中断·链级 + 在途查询通道面（IPC 命名空间 dispatch:*，主进程
 * agent/interrupt-ipc.ts 注册，spec 2026-10-13 §7.2 / §7.6 / §9）。
 */
export interface DispatchApiSurface {
  /**
   * 链级取消（spec §7.6）：renderer 只持 subStreamSessionId（chip 查找键），
   * taskId 入口留给主进程内部调用。查无 / 已终态 → not_found（幂等取消）。
   */
  cancelChain(arg: {
    taskId?: string;
    subStreamSessionId?: string;
  }): Promise<{ status: 'cancelled' | 'not_found' }>;
  /** 在途链查询（§9）：sessionId 缺省 = 全部会话 */
  listInFlight(sessionId?: string): Promise<InFlightChainView[]>;
}

/**
 * v2.2 记忆条目（renderer 镜像）。
 * 与 electron 端 storage/memories/repo.ts 的 MemoryEntry 对齐（跨进程独立定义，仅结构对齐）。
 * 注意：electron 端另有 rowid（FTS external content 关联键）——主进程内部实现细节，
 * 不属于 renderer 契约，故镜像不含该字段。
 */
export interface MemoryEntry {
  id: string;
  scope: 'global' | 'workspace' | 'session';
  workspaceId: string | null;
  sessionId: string | null;
  kind: 'rule' | 'preference' | 'knowledge' | 'summary';
  pinned: boolean;
  content: string;
  tags: string[];
  source: 'user' | 'agent' | 'auto';
  sourceDetail: string | null;
  confidence: number;
  useCount: number;
  lastUsedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

/** 记忆列表 scope（memory:list 入参）。与 electron 端 storage/memories/repo.ts 的 MemoryListScope 对齐。 */
export type MemoryListScope =
  | { kind: 'global' }
  | { kind: 'workspace'; workspaceId: string }
  | { kind: 'session'; sessionId: string };

/**
 * v2.2 P1 记忆通道（IPC 命名空间 memory:*，memory/ipc.handlers.ts）。
 * 总开关经 settings:updateGlobal 的 memoryEnabled（默认 true）。
 */
export interface MemoryApiSurface {
  /** 按 scope 列记忆（updated_at 倒序）；filter 可选筛选。注：electron 端 filter 另支持 source 筛选（本镜像未暴露） */
  list(scope: MemoryListScope, filter?: { kind?: MemoryEntry['kind']; pinned?: boolean }): Promise<MemoryEntry[]>;
  /** 新建记忆，返回完整条目（pinned 缺省按 kind 推导：rule/preference=常驻） */
  save(input: {
    scope: 'global' | 'workspace' | 'session';
    workspaceId?: string | null;
    sessionId?: string | null;
    kind: MemoryEntry['kind'];
    content: string;
    tags?: string[];
    pinned?: boolean;
    source: MemoryEntry['source'];
  }): Promise<MemoryEntry>;
  /** 部分更新（content/tags/pinned），返回更新后条目；id 不存在时 invoke 抛错 */
  update(id: string, patch: { content?: string; tags?: string[]; pinned?: boolean }): Promise<MemoryEntry>;
  /** 删除记忆；id 不存在时 invoke 抛错 */
  delete(id: string): Promise<{ ok: true }>;
  /**
   * BM25 检索（全局 + 本 workspace + 本会话三层并集）。
   * 管理页固定本机视角：workspaceId 必填（缺失返回空数组），sessionId 可选；limit 默认 20。
   */
  search(q: string, scope: { workspaceId: string; sessionId?: string }, limit?: number): Promise<MemoryEntry[]>;
  /**
   * v2.2 P3：导出一层记忆为 Markdown（人类可读 + 可再导入）。
   * 格式：`# 记忆导出（层名）` + 日期行 + 逐条 `## [kind|source|pinned] content` + `- tag` 行。
   * 与 electron 端 storage/memories/markdown.ts 的 exportMemoriesMarkdown 对齐。
   */
  exportMarkdown(scope: MemoryListScope): Promise<{ filename: string; content: string }>;
  /**
   * v2.2 P3：导入 Markdown 到传入 scope 同层（global→global；workspace→该 workspaceId；
   * session 拒绝——invoke 抛错，UI 仅 global/workspace 层提供入口）。
   * 逐 `## ` 段解析，source 固定 'user'；坏段/去重命中计入 skipped。
   * 与 electron 端 storage/memories/markdown.ts 的 importMemoriesMarkdown 对齐。
   */
  importMarkdown(scope: MemoryListScope, content: string): Promise<{ imported: number; skipped: number }>;
}

/**
 * v2.4 沙箱探测状态（renderer 镜像）。
 * 与 electron 端 sandbox/probe.ts 的 SandboxProbeState 对齐（跨进程独立定义，仅结构对齐；
 * platform 在主进程是 NodeJS.Platform，renderer 镜像放宽为 string）。
 */
export interface SandboxProbeState {
  platform: string;
  sandboxTool: 'seatbelt' | 'bwrap' | null;
  toolVersion: string | null;
  available: boolean;
  unavailableReason: string | null;
  windowsShell: string | null;
  executionPolicy: string | null;
  probedAt: number;
}

/** 沙箱模式，与 electron 端 sandbox/types.ts 的 SandboxMode 对齐 */
export type SandboxMode = 'strict' | 'permissive';

/** 沙箱网络出站双态策略，与 electron 端 sandbox/settings.ts 的 NetworkPolicy 对齐（2026-09-13 修订 B） */
export type NetworkPolicy = 'deny' | 'allow';

/**
 * v2.4 沙箱聚合信息（sandbox:getState / sandbox:reprobe 返回）。
 * 与 electron 端 sandbox/ipc.handlers.ts 的 SandboxInfo 对齐。
 */
export interface SandboxInfo {
  /** boot/上次 reprobe 的探测结果；应用启动早期可能为 null（探测未完成） */
  state: SandboxProbeState | null;
  settings: {
    mode: SandboxMode;
    networkPolicy: NetworkPolicy;
  };
  /** 手动安装指引命令（包管理器探测失败为 null） */
  installCommand: string | null;
  bwrapPromptDismissed: boolean;
  winPolicyPromptDismissed: boolean;
  /** net-off 拦截提示卡是否已关闭（v2.4.x：仅 deny 策略下展示的信息卡） */
  netPromptDismissed: boolean;
}

/**
 * v2.4 沙箱通道（IPC 命名空间 sandbox:*，sandbox/ipc.handlers.ts）。
 * 设置读写走 settings:updateGlobal（不在此命名空间重复）。
 */
export interface SandboxApiSurface {
  /** 聚合信息（探测单例 + settings + 提示卡 flag + 安装指引） */
  getState(): Promise<SandboxInfo>;
  /** 重新探测（bwrap / sandbox-exec / pwsh），探测完成后返回最新聚合信息 */
  reprobe(): Promise<SandboxInfo>;
  /** pkexec 安装 bubblewrap（Linux）；pkexec 缺失/安装失败返回 ok:false + 输出摘要 */
  installBwrap(): Promise<{ ok: boolean; output: string }>;
  /** 关闭提示卡（kv 一次性标记；kind 区分 bwrap 安装引导 / win32 策略提示 / net-off）
   * 2026-10-03：toolchain kind 随事件驱动授权卡退役 */
  dismissPrompt(kind: 'bwrap' | 'winPolicy' | 'netOff'): Promise<void>;
  /**
   * 通用写授权（spec 2026-10-03 §6.3）：授权卡三按钮的两档写入。
   * session=单个聊天会话持久 / workspace=工作空间持久；dirs 为卡上展示的归一目录。
   */
  grantWrite(arg: {
    scope: 'session' | 'workspace';
    key: string;
    dirs: string[];
  }): Promise<void>;
  /** 写授权拒绝（spec 2026-10-03 hard-gate §4.3）：广播解除等待中的工具调用 */
  denyWrite(arg: { sessionId: string | null; dirs: string[] }): Promise<void>;
  /** 撤销单条（设置页「已授权目录」） */
  revokeWrite(arg: { scope: 'session' | 'workspace'; key: string; dir: string }): Promise<void>;
  /** 工作空间持久授权列表（设置页「已授权目录」小节） */
  listWriteGrants(): Promise<Array<{ workspaceId: string; dirs: string[] }>>;
  /** 写拦截信号推送（主进程 stream-relay 检测命中即推；renderer 直弹授权卡） */
  onWriteBlocked(cb: (e: WriteBlockedEvent) => void): () => void;
}

/**
 * sandbox:writeBlocked 事件载荷（spec 2026-10-03 §5.3）——主进程 write-blocked-emit
 * 的 WriteBlockedSignal 镜像（跨进程独立定义，仅结构对齐）。sessionId/workspaceId
 * 为 null = 消息映射失败，卡按钮据此禁用。
 */
export interface WriteBlockedEvent {
  sessionId: string | null;
  workspaceId: string | null;
  dirs: string[];
  command: string;
  /**
   * F4（2026-10-14 后台链授权卡死配套）：等待授权的流 id——在途面板/派单 chip
   * 据此呈现「等待授权」态（write-grant.store.waitingByStream 键）。
   */
  streamSessionId: string | null;
  /** 来源 agent 展示名（sender `agent-<slug>-<rand>` 提取；解析失败 null） */
  sourceAgentName: string | null;
  /** 来源会话标题（解析失败 null——卡上不显示来源行） */
  sessionTitle: string | null;
}

/** v2.5 变更操作四值域。与 electron 端 journal/types.ts 的 JournalOp 对齐（spec §5.2）。 */
export type JournalOp = 'create' | 'modify' | 'delete' | 'rename';

/**
 * v2.5 变更账本条目（renderer 镜像）。与 electron 端 journal/types.ts 的 JournalEntry 对齐。
 * 跨进程独立定义，仅结构对齐；message_id 列已删除（归组键 = streamSessionId，参见 migration v33）。
 */
export interface JournalEntry {
  id: string;
  workspaceId: string;
  taskId: string | null;
  sessionId: string | null;
  streamSessionId: string;
  toolName: string;
  path: string;
  op: JournalOp;
  beforeHash: string | null;
  afterHash: string | null;
  oldPath: string | null;
  createdAt: number;
}

/**
 * list 通道视图：条目 + blob 文本内容（截断 100KB；hash 为 null 或 blob 缺失时
 * 对应文本为 null）。与 electron 端 journal/types.ts 的 JournalEntryView 对齐。
 */
export interface JournalEntryView extends JournalEntry {
  beforeText: string | null;
  afterText: string | null;
}

/** 单条撤销结果。与 electron 端 journal/revert.ts 的 RevertOutcome 对齐。 */
export interface RevertOutcome {
  id: string;
  path: string;
  result: 'reverted' | 'skipped-diverged' | 'restored-missing' | 'no-op' | 'failed';
  detail?: string;
}

/**
 * v2.5 变更账本通道（IPC 命名空间 journal:*，journal/ipc.handlers.ts）。
 * 与 preload 的 invoke 通道名逐一对应；revert / rollbackFileBefore 由
 * 主进程构造合成 recorderCtx（streamSessionId='journal-revert-ui' +
 * toolName='undo'）落账，UI 无须传入 streamSessionId 语义。
 */
export interface JournalApiSurface {
  /**
   * 列条目视图。三 scope（优先级从高到低）：taskId（任务组）/ streamSessionId
   * （消息行流）/ sessionId（会话级聚合——该 session 全部条目，含子 agent
   * dispatch 写入，rollback spec 2026-09-28 §5.2）；三键皆空返回空数组。
   */
  list(scope: {
    workspaceId: string;
    taskId?: string;
    streamSessionId?: string;
    sessionId?: string;
  }): Promise<JournalEntryView[]>;
  /**
   * 撤销指定条目（按 id 批量）；执行序 = 全局 created_at 逆序。
   * force=true 在 hash 漂移时强制写回（会丢失其后变更，UI 需明确警告）。
   */
  revert(workspaceId: string, ids: string[], opts?: { force?: boolean }): Promise<RevertOutcome[]>;
  /**
   * 干跑预检（rollback spec 2026-09-28 §5.1）：与 revert 同序逐条预测，链式
   * 虚拟状态模拟；不写盘不记账，预测恒按 force=false（执行时守卫仍生效，
   * UI 文案需标注「以执行时守卫为准」）。
   */
  preview(workspaceId: string, ids: string[]): Promise<RevertOutcome[]>;
  /**
   * 组合回滚到 beforeEntryId 之前状态：服务端取该 path 上 created_at > 锚点的全部
   * 条目 + 锚点自身，逆序 revert。锚点缺失或 path 不一致 → no-op outcome。
   */
  rollbackFileBefore(workspaceId: string, path: string, beforeEntryId: string): Promise<RevertOutcome[]>;
}

// v2.7 McpBrowser：浏览器通道载荷与 API 面。
// 与 electron/src/main/browser/types.ts、ipc.ts 跨进程结构对齐——刻意独立定义
//（renderer 不 import electron 源码）；契约由 electron/tests/browser/ipc.test.ts
// 的载荷字段锁保护。

/** tab 清单行（browser_tabs 工具返回 / sidebar tabs 栏渲染共用） */
export interface BrowserTabInfo {
  index: number;
  url: string;
  title: string;
  /** 归属方（spec 2026-09-15 §4.1）：agent 实例 ID 或 'user'——user 视角清单透出真实归属 */
  owner: string;
}

/** 统一状态推送（IPC browser:state）载荷——单页共享模型的完整快照 */
export interface BrowserState {
  workspaceId: string;
  tabs: BrowserTabInfo[];
  /** 当前 tab 下标（tabs[current] 即活跃页） */
  current: number;
  url: string;
  title: string;
  /** 单页仲裁态：agent 工具可用 / 用户接管中（工具立即失败） */
  takeover: 'agent' | 'user';
  /** 信任卡视角：浏览器工具当前是否放行（trust=always，或 ask 且本会话已授权；deny / ask 未授权为 false） */
  trusted: boolean;
  /** 本帧推送由「活跃会话的 agent 导航」触发（spec §7.3）——renderer 见 true 且本会话隐藏则展开侧栏 */
  expandHint: boolean;
}

/** sidebar 占位区 rect（browser:setSidebarBounds 载荷，与 Electron setBounds 四字段同构；DPR 换算在 main） */
export interface BrowserSidebarRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 信任卡应答三值（spec §5.2：session 本会话 / always 落库 / deny 无操作） */
export type BrowserTrustAnswer = 'session' | 'always' | 'deny';

/** dev server 探活结果（browser:listDevServers） */
export interface BrowserDevServer {
  port: number;
  url: string;
}

/** workspace 级浏览器设置 patch（browser:updateSettings 载荷；主进程侧净化后落库）。
 *  sidebarCollapsed 已退役（spec 2026-09-15 §7.4 列 inert）——patch 不再接受该键。 */
export interface BrowserSettingsPatch {
  trust?: 'ask' | 'always' | 'deny';
  evaluateEnabled?: boolean;
  blacklist?: string[];
  whitelist?: string[];
  sidebarWidth?: number;
}

/** workspace 级浏览器设置完整形态（browser:getSettings 返回——store.read 六字段） */
export interface BrowserSettings {
  trust: 'ask' | 'always' | 'deny';
  evaluateEnabled: boolean;
  blacklist: string[];
  whitelist: string[];
  sidebarCollapsed: boolean;
  sidebarWidth: number;
}

/** m→r 非模态通知（browser:notice；kind 如 crash-reloaded / popup-blocked / trust-request）。
 * workspaceId 是发送方所在的 workspace（v2.7 review M7）——信任卡按该字段路由应答目标，
 * 不再依赖 renderer 端「单活跃 ws」推导（脆弱：用户切 ws、tool 跨 ws 上下文等）。 */
export interface BrowserNotice {
  kind: string;
  text: string;
  workspaceId: string;
  /** agent-waiting-release 专用：本轮驻留等待实际时长 ms——卡片本地兜底计时用（超时出口 takeover 不翻转，state 不会触发卸载） */
  durationMs?: number;
}

export interface BrowserApiSurface {
  /** sidebar 挂载时拉全量状态 */
  getState(workspaceId: string): Promise<BrowserState>;
  /** 地址栏回车（隐式接管，§3.2） */
  userNavigate(workspaceId: string, url: string): Promise<{ url: string; title: string }>;
  /** 显式接管 / 释放 */
  takeover(workspaceId: string): Promise<void>;
  releaseTakeover(workspaceId: string): Promise<void>;
  /** tabs 管理（open 携带 url；close 当前 tab 且为唯一 tab 时视同 closeBrowser） */
  openTab(workspaceId: string, url?: string): Promise<BrowserTabInfo[]>;
  closeTab(workspaceId: string, index?: number): Promise<BrowserTabInfo[]>;
  switchTab(workspaceId: string, index: number): Promise<BrowserTabInfo[]>;
  /** 占位区 rect 上报（ResizeObserver / window resize 触发） */
  setSidebarBounds(rect: BrowserSidebarRect): Promise<void>;
  /** 归属制（spec 2026-09-15 §6.3）：侧栏收起 = 纯隐藏——bounds 置零不销毁；可见性记忆在 renderer per-session */
  setSidebarVisible(workspaceId: string, visible: boolean): Promise<void>;
  /** 归属制（spec §5.4）：活跃会话上报（自动展开判定输入）；null = 非会话视图（安全缺省） */
  setActiveSession(sessionId: string | null): Promise<void>;
  /** 归属制（spec §6.4）：用户显式关闭浏览器（已过确认卡）——user 源全局销毁（含 agent 的 tab） */
  closeBrowser(workspaceId: string): Promise<void>;
  /** 信任卡应答（session / always / deny） */
  answerTrust(workspaceId: string, answer: BrowserTrustAnswer): Promise<void>;
  /** dev server 探活（5173/3000/8080/4200/8000） */
  listDevServers(): Promise<BrowserDevServer[]>;
  /** 设置写入（主进程净化：跳过 undefined 键 / 非数组名单丢弃；非法 trust 结构化错误返回） */
  updateSettings(
    workspaceId: string,
    patch: BrowserSettingsPatch,
  ): Promise<{ ok: true } | { ok: false; error: string }>;
  /** 设置读取（store.read 全量六字段——设置页表单初始值 / 侧栏宽度初始态消费） */
  getSettings(workspaceId: string): Promise<BrowserSettings>;
  /** 清除 partition 浏览数据（设置页「清除浏览数据」按钮；不经接管门） */
  clearBrowsingData(workspaceId: string): Promise<void>;
  /** 统一状态推送订阅（解订阅函数） */
  onBrowserState(callback: (state: BrowserState) => void): () => void;
  /** 非模态通知订阅（信任卡消费 kind='trust-request'） */
  onBrowserNotice(callback: (notice: BrowserNotice) => void): () => void;
}

/**
 * P2.3 杂项通道（misc:* 命名空间——壳能力级小通道归属地，首个成员为外链
 * 打开；主进程 handler 注册在 electron resource/ipc.handlers.ts）。
 */
export interface MiscApiSurface {
  /** 外链转系统浏览器（主进程强制 https 校验；空串/非 https 中文拒绝） */
  openExternal(url: string): Promise<void>;
}

export interface ApiSurface {
  system: {
    getInfo(): Promise<SystemInfo>;
    /** P2 Task 2：preload 同步注入的 process.platform 常量（titlebar 平台分支用，避免异步首帧闪变） */
    getPlatform(): string;
    /** P5 Task 2：v1.x → 2.0 旧库升级首启标记；null = 无标记 */
    getUpgradeNotice(): Promise<UpgradeNotice | null>;
    /** P5 Task 2：清除升级首启标记（一次性） */
    dismissUpgradeNotice(): Promise<void>;
  };
  workspace: {
    create(input: CreateWorkspaceInput): Promise<Workspace>;
    list(): Promise<Workspace[]>;
    get(id: string): Promise<Workspace | null>;
    delete(id: string): Promise<void>;
    /** v25 Task 6（spec §5）：设置/清空默认会话 agent；instanceId=null 清除（查询随 workspace:get/list 返回） */
    setDefaultAgent(workspaceId: string, instanceId: string | null): Promise<void>;
    /** v2.7 T10：切换激活 workspace 通知（main 收口浏览器子系统切换钩子；fire-and-forget） */
    switch(id: string): Promise<{ ok: boolean }>;
    /** P2 Task 2：重命名 workspace（UPDATE name 列） */
    rename(id: string, name: string): Promise<{ ok: boolean }>;
    /** P2 Task 2：在系统文件管理器中打开 workspace 目录 */
    openDirectory(id: string): Promise<{ ok: boolean }>;
    /**
     * M2.1 D3：主进程侧工作空间列表变更推送（镜像应用等 renderer 无感知的
     * 落库路径）。返回退订函数。
     */
    onListChanged(callback: (e: { reason: string; workspaceName?: string }) => void): () => void;
  };
  file: {
    read(workspaceId: string, filePath: string): Promise<string>;
    write(workspaceId: string, filePath: string, content: string): Promise<void>;
    list(workspaceId: string, dirPath: string): Promise<DirEntry[]>;
    create(workspaceId: string, filePath: string, type: 'file' | 'dir'): Promise<void>;
    delete(workspaceId: string, filePath: string): Promise<void>;
    rename(workspaceId: string, srcPath: string, dstPath: string): Promise<void>;
    /** 文件名搜索（侧边栏搜索，spec §5.1）：主进程递归扫描，返回相对路径命中项 */
    searchNames(workspaceId: string, query: string): Promise<SearchHit[]>;
    /** 文件区功能优化：相对路径 → OS 绝对路径（沙箱校验后返回；「复制路径」用） */
    absolutePath(workspaceId: string, filePath: string): Promise<string>;
    /** 文件区功能优化：在系统文件管理器中显示该文件/目录（所在目录内选中） */
    revealInFolder(workspaceId: string, filePath: string): Promise<{ ok: boolean }>;
    /** 文件区功能优化：用系统默认应用打开（失败抛中文错误，UI alert） */
    openWithDefaultApp(workspaceId: string, filePath: string): Promise<{ ok: boolean }>;
    /** 文件区功能优化：编辑器打开前读取——文本返回内容，二进制返回 kind='binary'（UI 转外部应用打开） */
    readForEditor(workspaceId: string, filePath: string): Promise<EditorFileContent>;
  };
  /**
   * 2026-09-26 多模态（spec §5）：粘贴/拖入图片的资源通道。
   * renderer 降采样后 Uint8Array 经此 IPC 写入 workspace `.momo/assets/`，返回相对路径。
   * 内容寻址去重：同字节 re-paste 直接复用，不重写。
   */
  asset: {
    /**
     * 保存一张已降采样的图片到 workspace 内，返回相对路径（workspace 根下的
     * `.momo/assets/<sha1 前 12 hex>.<ext>`）。
     * 失败语义：未知 workspace / 越界 / 字节超过 8MB / 扩展名非 png|jpg → 抛错
     * （spec §11：renderer 接 reject 后不插 pill + toast 错误，输入不受影响）。
     */
    saveImage(
      workspaceId: string,
      data: Uint8Array,
      ext: 'png' | 'jpg',
    ): Promise<{ path: string }>;
    /**
     * 读 workspace 内 `.momo/assets/<hash>.(png|jpg)` 图片为 data URL（气泡缩略图，
     * spec 2026-09-26 §10）。失败语义：路径不合规 / 越界 / 文件缺失 / 超 8MB /
     * 未知 workspace → 抛中文错误（渲染端降级「图片不可用」占位，spec §11）。
     */
    readDataUrl(workspaceId: string, path: string): Promise<string>;
  };
  agent: {
    /** v25：成员加入（无 role/parent；同 ws 同 def 重复加入报错） */
    addMember(input: AddMemberInput): Promise<WorkspaceAgentMember>;
    createFromYaml(yaml: string): Promise<AgentDefinition>;
    /** v1.3：scope + modelProviderId + modelName；不含 type/parent/modelProvider/modelBaseUrl */
    createCustom(input: {
      name: string;
      slug: string;
      description?: string;
      systemPrompt: string;
      iconEmoji?: string;
      scope: 'global' | 'workspace';
      modelProviderId: string;
      modelName: string;
      /** v1.6：scope='workspace' 时由调用方填入当前 activeWorkspaceId；缺省 = null（global） */
      workspaceId?: string;
      /** v1.6：默认工具；缺省 = SAFE_MINIMUM_TOOLS（在主进程 createCustomDef 内兜底） */
      defaultTools?: Array<{ kind: 'builtin'; ref: string }>;
      /** v1.6：默认 MCP；缺省 = [] */
      defaultMcps?: Array<{ kind: 'mcp'; ref: string; versionRange?: string }>;
      /** v1.6：默认 Skill；缺省 = [] */
      defaultSkills?: Array<{ kind: 'skill'; ref: string; versionRange?: string }>;
      /** v31：agent 级思维模式覆盖；缺省 = null（继承模型级） */
      thinkingJson?: ThinkingConfig | null;
      /** 工作空间维度 v1.1：工具禁用模式串；缺省 = [] */
      deniedTools?: string[];
    }): Promise<AgentDefinition>;
    /** v1.3：可选 workspaceId 过滤 */
    list(workspaceId?: string): Promise<AgentDefinition[]>;
    assign(workspaceId: string, defId: string, botUserId: string): Promise<WorkspaceAgentMember>;
    /** v25：原 listAssignments 平移更名 */
    listMembers(workspaceId: string): Promise<WorkspaceAgentMember[]>;
    start(opts: StartAgentInput): Promise<{ instanceId: string }>;
    stop(instanceId: string): Promise<{ ok: boolean }>;
    /**
     * v25：移除成员。返回结构化结果——leader 守卫命中时 `{ ok: false, blockedTeams }`
     * （该成员担任 leader 的团队名列表，UI 提示先转移/解散）。
     */
    removeMember(instanceId: string): Promise<{ ok: true } | { ok: false; blockedTeams: string[] }>;
    isRunning(instanceId: string): Promise<boolean>;
    /** v1.3：scope + modelProviderId + modelName；不含 type/parent */
    updateDefinition(input: {
      id: string;
      name?: string;
      description?: string;
      systemPrompt?: string;
      iconEmoji?: string;
      scope?: 'global' | 'workspace';
      modelProviderId?: string;
      modelName?: string;
      /** v1.6：scope='workspace' 时由调用方填入当前 activeWorkspaceId */
      workspaceId?: string;
      /** v1.6：undefined=不改；传值（含 []）= 覆盖 */
      defaultTools?: Array<{ kind: 'builtin'; ref: string }>;
      defaultMcps?: Array<{ kind: 'mcp'; ref: string; versionRange?: string }>;
      defaultSkills?: Array<{ kind: 'skill'; ref: string; versionRange?: string }>;
      /** v31：agent 级思维模式覆盖；undefined=不改；null=清除（回退模型级） */
      thinkingJson?: ThinkingConfig | null;
      /** 工作空间维度 v1.1：工具禁用模式串；undefined=不改（含则整体覆盖） */
      deniedTools?: string[];
    }): Promise<{ definition: AgentDefinition; stoppedInstanceIds: string[] }>;
    /** 预设 agent 按需启用（spec 2026-09-22）：def 入库 + 模型 + 可选加入/设默认 */
    enablePreset(input: EnablePresetInput): Promise<EnablePresetResult>;
    /** v25：原 updateAssignmentApiKey 平移更名（apiKey=null 清除 override） */
    setMemberApiKeyOverride(instanceId: string, apiKey: string | null): Promise<{ ok: boolean }>;
    /** v1.3 新增：删除自定义 def（builtin 不可删；级联清理成员） */
    deleteDefinition(defId: string): Promise<{ stoppedInstanceIds: string[] }>;
    /** 2026-10-10 披露式级联：删除/停用前影响面预查（确认框文案数据源，只读） */
    definitionImpact(defId: string): Promise<DefinitionImpact>;
    /** 2026-10-10：停用预设 agent——回到未启用态（级联内核与 deleteDefinition 共用） */
    disablePreset(defId: string): Promise<{ stoppedInstanceIds: string[] }>;
    /** v1.3 新增：返回 builtin 建议 Map（UI 添加 builtin 时预填 platform） */
    getBuiltinSuggestions(): Promise<BuiltinSuggestionMap>;
    /** v25：原 getAssignmentDeltas 平移更名（全空对象 = 无 delta） */
    getMemberDeltas(instanceId: string): Promise<AssignmentDeltas>;
    /** v25：原 setAssignmentDeltas 平移更名（幂等全量替换） */
    setMemberDeltas(instanceId: string, deltas: AssignmentDeltas): Promise<void>;
    /**
     * spec 2026-10-22 §6.1：批量取成员生效能力（与 spawn 同源三层合并）。
     * 未知 / 已移出的 instanceId 在主进程侧省略条目（键不存在）——
     * 消费方须按「缺键 → 降级定义级徽标」处理，不得视作空能力集。
     */
    getEffectiveCapabilities(instanceIds: string[]): Promise<Record<string, EffectiveCapabilities>>;
    onRuntimeChanged(callback: () => void): () => void;
    /** Task 6：中断指定 streamSessionId 的活跃流式会话（原按 roomId 中断，修同房覆盖问题） */
    abortStream(streamSessionId: string): Promise<void>;
    /**
     * 三级中断·回合级（spec 2026-10-13 §7.3）：先断本回合派生链再停 PM 流。
     * 车道空闲（无在途回合）→ { stoppedStream: false } 幂等 no-op。
     */
    abortTurn(sessionId: string): Promise<{ stoppedStream: boolean }>;
  };
  /**
   * v25 Task 6：团队通道面（spec §4.2）。全部委托 team.ts 服务层。
   */
  team: {
    /** 某 workspace 全部团队（含成员展开与 leader 标记） */
    list(workspaceId: string): Promise<Team[]>;
    /** 建团（单事务；成员 ≥2 且 leader 必须在成员集内，违规 reject） */
    create(
      workspaceId: string,
      input: {
        name: string;
        iconEmoji?: string;
        memberInstanceIds: string[];
        leaderInstanceId: string;
      },
    ): Promise<Team>;
    /** 改名/换图标；iconEmoji 省略保留原值 */
    rename(teamId: string, name: string, iconEmoji?: string): Promise<{ ok: true }>;
    /** 解散团队（仅删定义；成员与已建会话快照不受影响） */
    delete(teamId: string): Promise<{ ok: true }>;
    /** 换 leader（新 leader 必须是团队成员，否则 reject） */
    setLeader(teamId: string, leaderInstanceId: string): Promise<{ ok: true }>;
    /** 加成员（须属于团队所在 workspace；重复添加 reject） */
    addMember(teamId: string, instanceId: string): Promise<{ ok: true }>;
    /** 移除成员（leader 走守卫 reject；不存在的成员/团队幂等 no-op） */
    removeMember(teamId: string, instanceId: string): Promise<{ ok: true }>;
  };
  /** v2.x：工具目录（注册中心自描述，单一真相源）——agent 创建/编辑界面据此渲染 */
  tools: {
    /** 工具目录（注册中心自描述，单一真相源） */
    getCatalog(): Promise<ToolCatalogEntry[]>;
  };
  provider: {
    list(): Promise<ModelProvider[]>;
    get(id: string): Promise<ModelProvider | null>;
    create(input: {
      name: string; baseUrl: string; apiKey: string;
      defaultModel?: string; isDefault?: boolean; platform?: ProviderPlatform;
      /** 来源预设 key（v31 起）；传入则后端种子预设模型，未知 key 前置校验拒绝 */
      presetKey?: string;
    }): Promise<ModelProvider>;
    update(input: {
      id: string; name?: string; baseUrl?: string; apiKey?: string;
      defaultModel?: string; isDefault?: boolean; platform?: ProviderPlatform;
    }): Promise<ModelProvider>;
    delete(id: string): Promise<{ ok: boolean }>;
    setDefault(id: string): Promise<{ ok: boolean }>;
    testConnection(input: { baseUrl: string; apiKey: string; model: string }): Promise<{ ok: boolean; error?: string }>;
    getApiKey(id: string): Promise<string | null>;
    /** Task 6：GET {baseUrl}/models 拉取远端模型 id 列表（失败抛 IPC error） */
    fetchModels(id: string): Promise<string[]>;
    /** Task 6：某供应商的模型列表（按加入时间升序） */
    listModels(id: string): Promise<ProviderModel[]>;
    /** Task 6：手动添加模型（幂等，ghost provider 时抛 FOREIGN KEY 错误） */
    addModel(id: string, modelId: string): Promise<void>;
    /** Task 6：切换模型启用状态 */
    setModelEnabled(id: string, modelId: string, enabled: boolean): Promise<void>;
    /** 上下文窗口手动覆盖（token；null=清除回退内置目录；非正整数 reject） */
    setModelWindow(id: string, modelId: string, contextWindow: number | null): Promise<void>;
    /** Task 6：删除模型条目 */
    removeModel(id: string, modelId: string): Promise<void>;
    listPresets: () => Promise<ProviderPreset[]>;
    setModelThinking: (
      providerId: string,
      modelId: string,
      config: ThinkingConfig | null,
    ) => Promise<void>;
    /** 视觉输入能力位（用户覆盖，双向压过预设表；2026-09-26 多模态 spec §3.3） */
    setModelVision: (providerId: string, modelId: string, vision: boolean) => Promise<void>;
  };
  /**
   * v2.0 P1 Task 12：im 命名空间收缩——全部 im:* invoke 通道已随 Matrix 全家删除，
   * 仅保留 im:conflict 推送订阅（发送方主进程 session-service；通道名留待 P2 收敛）。
   */
  im: {
    /** B 子系统：订阅任务冲突检测推送（execution_room 内 mention 另一个任务时触发） */
    onConflict(
      callback: (conflict: {
        newTaskId: string;
        currentTaskId: string;
        currentRoomId: string;
      }) => void,
    ): () => void;
  };
  /**
   * v2.0 P1 Task 8：会话内核命名空间（session.ipc.handlers.ts）。
   */
  session: SessionApiSurface;
  /** 会话分组命名空间（spec 2026-10-22 §7）：分组 CRUD，按 workspace 隔离 */
  sessionGroup: SessionGroupApiSurface;
  /** 三级中断·链级 + 在途查询（dispatch:cancelChain / dispatch:listInFlight） */
  dispatch: DispatchApiSurface;
  mcp: {
    // P3 Task 7：register 收敛到 resource.registerMcp（mcp:register 通道已删除）
    /** 启动某 workspace 内的 MCP 进程（进程池复用） */
    start(workspaceId: string, mcpName: string): Promise<void>;
    /** 列出某 workspace 内已启动 MCP 暴露的工具 */
    listTools(workspaceId: string, mcpName: string): Promise<McpToolInfo[]>;
    /** 调用某 workspace 内已启动 MCP 的指定工具，返回拼接后的文本输出 */
    callTool(
      workspaceId: string,
      mcpName: string,
      toolName: string,
      args: Record<string, unknown>,
    ): Promise<string>;
    /** 停止某 workspace 内的指定 MCP 进程 */
    stop(workspaceId: string, mcpName: string): Promise<void>;
  };
  allocation: {
    /** 读取某 workspace 的全部能力分配（按 tool/mcp/skill 分桶） */
    get(workspaceId: string): Promise<WorkspaceAllocation>;
    /** 增加一条能力分配（重复添加幂等） */
    add(workspaceId: string, type: CapabilityType, ref: string): Promise<void>;
    /** 移除一条能力分配 */
    remove(workspaceId: string, type: CapabilityType, ref: string): Promise<void>;
  };
  gitPolicy: {
    /** 读取某 workspace 的 Git Policy（未配置返回默认） */
    get(workspaceId: string): Promise<GitPolicy>;
    /** 覆盖写入某 workspace 的 Git Policy */
    set(workspaceId: string, policy: GitPolicy): Promise<void>;
  };
  audit: {
    /** 分页查询某 workspace 的工具调用审计记录（最新优先） */
    getToolCalls(workspaceId: string, opts?: ToolCallQueryOpts): Promise<ToolCallRecord[]>;
    /** 读取某 workspace 的配额与占用 */
    getQuota(workspaceId: string): Promise<AuditQuotaInfo>;
    /** 设置 workspace 级配额（MB）；null = 清除覆盖，回退全局 */
    setQuota(workspaceId: string, quotaMb: number | null): Promise<void>;
    /** 立即执行滚动清理，返回本次删除条数 */
    enforceNow(workspaceId: string): Promise<{ deletedCount: number }>;
  };
  dialog: {
    /** 弹出原生目录选择对话框，返回绝对路径；用户取消返回 null */
    pickDirectory(opts?: { title?: string; defaultPath?: string }): Promise<string | null>;
  };
  /** P2.3：杂项通道（misc:* 命名空间——外链打开等壳能力级小通道） */
  misc: MiscApiSurface;
  settings: {
    /** 读取全局会话配置（未配置返回默认值） */
    getGlobal(): Promise<GlobalSettings>;
    /** 部分更新全局配置，返回更新后的完整配置 */
    updateGlobal(patch: Partial<GlobalSettings>): Promise<GlobalSettings>;
    /** 读取会话级配置（不存在返回 null 字段） */
    getSession(sessionId: string): Promise<SessionSettings>;
    /** 部分更新会话级配置，返回更新后的完整配置 */
    updateSession(sessionId: string, patch: Partial<SessionSettings>): Promise<SessionSettings>;
  };
  /** v2.2 P1：记忆管理通道（memory/ipc.handlers.ts；总开关经 settings 的 memoryEnabled） */
  memory: MemoryApiSurface;
  /** v2.4：OS 沙箱通道（sandbox/ipc.handlers.ts） */
  sandbox: SandboxApiSurface;
  /** v2.5：变更账本通道（journal/ipc.handlers.ts） */
  journal: JournalApiSurface;
  /** v2.7：浏览器通道（browser/ipc.ts——16 invoke + state/notice 两推送） */
  browser: BrowserApiSurface;
  resource: {
    /** v1.7：统一资源列表（builtin + marketplace + custom 三源合并），filter 可选 */
    list(filter?: ResourceFilter): Promise<ResourceItem[]>;
    /** v1.7：按 id 查单个资源详情（找不到返回 null） */
    getDetail(id: string): Promise<ResourceItem | null>;
    /**
     * v1.7：安装资源（builtin/custom 不可安装，抛错）。
     * P2.1 Task 3：smithery 条目返回两态 SmitheryInstallResult（needsConfig=true
     * 带 schema 未安装）。
     * M2.3 T2：hub 条目安装/更新返回 HubInstallResult（alreadyLatest=true 为
     * 「已是最新」零动作如实回执）；其余源返回空。
     */
    install(id: string): Promise<SmitheryInstallResult | HubInstallResult | void>;
    /**
     * P2.1 Task 3：smithery needsConfig 二段安装——Task 6 弹窗收集配置后提交。
     * 主进程重拉详情作 schema 真源，按 x-from 分流（query 进 URL / 其余进 headers）。
     */
    installSmitheryRemote(id: string, config: Record<string, string>): Promise<void>;
    /** v1.7：删除/卸载资源（builtin 抛错；marketplace→uninstall；custom 按 type 三分支） */
    delete(id: string): Promise<void>;
    /** P3 Task 7：注册自定义 MCP（source 固定 'custom'），返回新条目的 ResourceItem */
    registerMcp(config: RegisterMcpInput): Promise<ResourceItem>;
    /** P3 Task 7：上传自定义 skill zip，返回 UploadedSkill[]（v1.6.2 起支持批量） */
    uploadSkill(buffer: ArrayBuffer, filename: string): Promise<UploadedSkill[]>;
    /** 表单创建 skill（frontmatter+正文 → custom skill；slug 冲突覆盖，返回同 zip 上传形状） */
    createSkill(input: SkillCreateInput): Promise<UploadedSkill>;
    /**
     * P2.6：扫描 Git 仓库（GitHub/GitLab zip 归档）发现全部 SKILL.md——下载+解析
     * 落 tmp 不进正式目录。返回 importId（导入凭证，一次性消费）+ skills 清单
     * 供 GitImportDialog 预览（同名覆盖警示按 slug 比对）。
     */
    scanGitRepoSkills(url: string): Promise<{ importId: string; skills: ScannedSkill[] }>;
    /**
     * P2.6：确认导入扫描结果（importId 一次性，失效须重扫）。逐 skill 幂等/覆盖
     * （同内容 hash 跳过、不同 hash 全量替换），单条失败不中断——结果分
     * imported / failures 两栏，全成功由弹窗自动关闭+绿横幅。
     */
    importGitRepoSkills(importId: string): Promise<GitImportResult>;
    /**
     * P2.1 Task 5：解析 DXT/MCPB 本地包（两阶段导入第一阶段）。解包校验 + manifest
     * 解析 + user_config 形状判定，不落正式目录。返回 BundlePreview 供 Task 6
     * ImportBundleDialog 渲染表单。
     */
    parseMcpBundle(buffer: ArrayBuffer, filename: string): Promise<BundlePreview>;
    /**
     * P2.1 Task 5：导入 DXT/MCPB 本地包（两阶段导入第二阶段）。变量替换 + S1 校验 +
     * cwd 注册 + 记账，返回 custom ResourceItem。renderer 持有原文件 buffer 二次传参
     * （主进程零中间状态）。
     */
    importMcpBundle(
      buffer: ArrayBuffer,
      filename: string,
      userConfig: Record<string, string>,
    ): Promise<ResourceItem>;
    /** P2 Task 4：网络获取 provider 元信息（builtin 恒可用 + 两 hub 含 degraded 状态） */
    registryProviders(): Promise<RegistryProviderMeta[]>;
    /**
     * P2 Task 4：按 provider 拉取注册表条目（builtin 分支本地过滤排序、hasMore 恒 false；
     * hub 失败 degraded 不抛错）。P2.1 Task 4：query 服务端搜索 + page 分页（1 起始），
     * hasMore 驱动「加载更多」。
     */
    registryList(
      providerKey: RegistryProviderMeta['key'],
      type: ResourceType,
      query?: string,
      page?: number,
    ): Promise<{
      entries: RegistryListEntry[];
      degraded: boolean;
      hasMore: boolean;
      /** M1c：未接入引导态（hub 未配置——空目录 + degraded=false，UI 引导链到设置） */
      notEnrolled?: boolean;
    }>;
    /**
     * P2.2 Task 6：查看已装远程 MCP 配置（McpConfigDialog 打开时拉取）。
     * bare=true 时无 schema（裸表单回显 url/headers）；三级降级在主进程完成。
     */
    getMcpConfig(name: string): Promise<McpConfigView>;
    /**
     * P2.2 Task 6：编辑已装远程 MCP 配置，保存后即时生效（池驱逐 + 下回合重建）。
     * headers 仅裸模式整包覆盖；schema 模式表单预填 url 须去 query（spec §9 D9）。
     */
    updateMcpConfig(name: string, input: McpConfigUpdateInput): Promise<void>;
    /**
     * P2.5 Task 2：读 MCP 全字段编辑视图（stdio + 远程通吃，编辑弹窗 mount 时
     * 拉取预填；name 是 agent 引用键，编辑模式名称只读）。
     */
    getMcpEditView(name: string): Promise<McpEditView>;
    /**
     * P2.5 Task 2：MCP 全字段编辑提交——保 id/source/installed_at 的专用 UPDATE
     * + 池驱逐（旧连接立即失效，下回合 getOrStartMcp 按新定义重建）+ 目录广播。
     */
    updateMcpEntry(name: string, input: McpEntryUpdateInput): Promise<void>;
    /**
     * 组⑤：MCP 启停——写库 + 禁用时驱逐池内运行实例（正在跑的 agent 此后
     * 调用即得「已禁用」错误）；启用不预热，下次使用惰性拉起。未注册 reject。
     */
    setMcpEnabled(name: string, enabled: boolean): Promise<void>;
    /**
     * P2.2 Task 6：悬空 MCP 引用扫描（MCP 标签页顶部提示卡数据源）。
     * 空数组 = 无悬空（含扫描异常降级），卡片不显示。
     */
    danglingMcpRefs(): Promise<DanglingMcpRef[]>;
    /**
     * P2.3：预置清单只读（本地 resources/agents/*.yaml 直读，零网络——
     * 预置库弹窗数据源）。当前预置仅 agent 有「启用」管线，mcp/skill 固定空数组。
     */
    listBuiltinPresets(type: ResourceType): Promise<BuiltinPresetItem[]>;
    /**
     * 2026-10-08：单个预置 agent 能力预览（详情面板能力清单 + 薄 fork 预填）。
     * 坏/空 slug 抛中文错；只读不落库。
     */
    previewBuiltinPreset(slug: string): Promise<BuiltinPresetPreview>;
    /**
     * 2026-10-12 D9：市场目录健康状态（主进程探测 catalog 源可达性；离线/网络
     * 受限时 degraded=true）。资源库 agent 页据此显示「当前显示本地目录」降级提示。
     * M1c：sources 逐源聚合（marketplace 远程目录 + momo-hub 目录各自降级态）。
     * hubNotEnrolled（M2.5 终审 FIX-1）：hub 未接入——与「目录为空」区分，
     * 播种门控据此拒绝建基线。
     */
    getCatalogStatus(): Promise<{
      degraded: boolean;
      hubNotEnrolled: boolean;
      sources?: Array<{ source: 'marketplace' | 'hub'; degraded: boolean }>;
    }>;
  };
  task: TaskApiSurface;
  /** 看板重构 Task 7：任务组通道面（taskGroup:*，groups.ipc.handlers.ts） */
  taskGroup: TaskGroupApiSurface;
  /**
   * 插件系统 P1（spec 2026-10-15）：安装 / 启停 / 卸载四通道。
   * 契约与 electron 端 plugin/ipc.handlers.ts 对齐。
   */
  plugin: PluginApiSurface;
  /**
   * P2 Task 1：窗口控制（自绘 titlebar 控件调用）。
   * minimize/toggleMaximize/close 为单向 send；isMaximized 为 invoke 查询；
   * onMaximizedChanged 订阅主进程 maximize/unmaximize 推送（图标切换用）。
   */
  window: {
    minimize(): void;
    toggleMaximize(): void;
    close(): void;
    isMaximized(): Promise<boolean>;
    onMaximizedChanged(callback: (maximized: boolean) => void): () => void;
  };
  /** 新装引导（spec 2026-10-10）——main 侧 onboarding/ipc.handlers.ts */
  onboarding: OnboardingApiSurface;
  /** M0 节点互联（spec 2026-10-23）——main 侧 hub/ipc.handlers.ts */
  hub: HubApiSurface;
}

export interface DirEntry {
  name: string;
  isDirectory: boolean;
  size: number;
}

/**
 * 文件名搜索命中项（侧边栏搜索）。
 * 与 electron 端 workspace-fs.ts 的 SearchHit 对齐（跨进程独立定义，仅结构对齐）。
 */
export interface SearchHit {
  /** 相对 workspace 根的全路径（含目录前缀，'/' 分隔） */
  path: string;
  isDirectory: boolean;
}

/**
 * file:readForEditor 返回（文件区功能优化）。
 * 与 electron 端 files/ipc.handlers.ts 的 EditorFileContent 对齐（跨进程独立定义，
 * 仅结构对齐）：text=可编辑文本；binary=非 utf-8（图片/PDF 等），UI 转外部应用打开。
 */
export type EditorFileContent = { kind: 'text'; content: string } | { kind: 'binary' };

// ─── Onboarding（新装引导，spec 2026-10-10 §5）────────────────────────────

/** 引导一次性状态（kv_store: onboarding.status） */
export type OnboardingStatus = 'pending' | 'completed' | 'skipped';

/** onboarding:generatePlan 入参 */
export interface GenerateOnboardingPlanInput {
  /** 用户需求描述；主进程截断至 4000 字符 */
  requirement: string;
  /** 第②步配好的供应商 + 模型（生成调用与 custom agent 落库共用） */
  providerId: string;
  modelId: string;
}

/** 方案 agent 项：预制启用（优先路线） */
export interface OnboardingPlanPresetAgent {
  kind: 'preset';
  slug: string;
  /** 给用户看的选择理由（中文一句话） */
  reason: string;
  /** LLM 追加挂载的 MCP 名（应用前过滤到已注册集） */
  mcps: string[];
  skills: string[];
}

/** 方案 agent 项：自定义生成（预制不满足时的降级路线） */
export interface OnboardingPlanCustomAgent {
  kind: 'custom';
  name: string;
  iconEmoji: string;
  systemPrompt: string;
  /** standard=安全最小集 / all=全部内置工具（引导期不暴露 custom 勾选档） */
  toolPreset: 'standard' | 'all';
  reason: string;
  mcps: string[];
  skills: string[];
}

export type OnboardingPlanAgent = OnboardingPlanPresetAgent | OnboardingPlanCustomAgent;

/** LLM 生成 / 用户勾改后的配置方案 */
export interface OnboardingPlan {
  agents: OnboardingPlanAgent[];
  /** 默认会话 agent 指向 agents[i]；应用时越界钳制到 0 */
  defaultAgentIndex: number;
}

/** onboarding:applyPlan 入参 */
export interface ApplyOnboardingPlanInput {
  plan: OnboardingPlan;
  workspaceId: string;
  providerId: string;
  modelId: string;
}

/** onboarding:applyPlan 返回 */
export interface OnboardingApplyResult {
  applied: Array<{ name: string; kind: 'preset' | 'custom'; instanceId: string }>;
  /** 非致命警告（剔除的未注册引用等），预览页与结果页展示 */
  warnings: string[];
  defaultAgentName: string;
}

/** onboarding:markDone 入参 */
export interface MarkOnboardingDoneInput {
  skipped: boolean;
}

/** generatePlan 的返回（方案 + 生成侧过滤警告） */
export interface GenerateOnboardingPlanResult {
  plan: OnboardingPlan;
  warnings: string[];
}

/** 新装引导通道面（spec 2026-10-10 §5：4 通道） */
export interface OnboardingApiSurface {
  getStatus(): Promise<{ status: OnboardingStatus }>;
  generatePlan(input: GenerateOnboardingPlanInput): Promise<GenerateOnboardingPlanResult>;
  applyPlan(input: ApplyOnboardingPlanInput): Promise<OnboardingApplyResult>;
  markDone(input: MarkOnboardingDoneInput): Promise<void>;
}

// ─── Hub（M0 节点互联，spec 2026-10-23）────────────────────────────────────

/**
 * hub 连接状态机（与 electron 端 hub/client.ts 的 HubConnectionState 对齐——
 * 跨进程独立定义，仅结构对齐）。
 */
export type HubConnectionState = 'disconnected' | 'connecting' | 'online';

/**
 * hub 连接状态快照（与 electron/src/main/hub/index.ts 的 HubStatus 对齐）。
 * configured = kv_store 有 hub_config 行；state = 当前连接状态机位置。
 */
export interface HubStatus {
  configured: boolean;
  state: HubConnectionState;
  hubUrl: string | null;
  nodeName: string | null;
  nodeId: string | null;
  lastError: string | null;
  /** 最近一次连接错误的协议错误码（如 proto_version_mismatch）；无错误为 null */
  lastErrorCode: string | null;
  /** 当前连接协商到的 hub 协议版本（hello 应答 protoVer）；未连接为 null */
  hubProtoVer: string | null;
}

/** hub:stateChanged 推送载荷（连接状态变化 / 错误信息 + 协议诊断） */
export interface HubStateChangedEvent {
  state: HubConnectionState;
  lastError: string | null;
  /** 最近一次连接错误的协议错误码；无错误为 null */
  lastErrorCode: string | null;
  /** 当前连接协商到的 hub 协议版本；未连接为 null */
  hubProtoVer: string | null;
}

/** hub:nodePresence 推送载荷（其他节点上下线） */
export interface HubNodePresenceEvent {
  kind: 'online' | 'offline';
  nodeId: string;
  nodeName?: string;
  /** 事件发生时刻（协议 NodeOnlineEvent/NodeOfflineEvent 原字段，随载荷透传） */
  at?: number;
}

/** hub:resourcePublished 推送载荷（协议 ResourcePublishedEvent 镜像——发布成功后 hub 广播全部在线节点） */
export interface HubResourcePublishedEvent {
  slug: string;
  type: 'agent' | 'mcp' | 'skill' | 'plugin';
  name: string;
  version: string;
  /** 发布方节点名（hub 端以鉴权节点名记账，RM1-8） */
  author: string;
  /** 发布时刻（ms） */
  at: number;
}

/**
 * hub:resourceUnpublished 推送载荷（协议 ResourceUnpublishedEvent 镜像——
 * M3.4 §2.4 B12：撤回成功后 hub 广播全部在线节点；目录即刻不可见，已安装
 * 节点不受影响，历史版本下载保留）。by = 执行撤回的节点名。
 */
export interface HubResourceUnpublishedEvent {
  slug: string;
  by: string;
  /** 撤回时刻（ms） */
  at: number;
}

/** hub:publishResource 入参的发布面元数据（全部可选——缺省由主进程从本地定义回填） */
export interface HubPublishMeta {
  name?: string;
  /** 须过 hub version 白名单（数字/字母/点/加号/减号） */
  version?: string;
  description?: string;
  /** README 正文（上限 64KB——超限主进程客户端预校验拒绝） */
  readme?: string;
  tags?: string[];
  category?: string;
  iconEmoji?: string;
}

/** hub:publishResource 入参（与 electron 端 hub/publish.ts PublishInput 对齐） */
export interface HubPublishResourceInput {
  type: 'agent' | 'mcp' | 'skill' | 'plugin';
  /** 定位键：agent=定义 id / skill=slug / mcp=注册名 / plugin=插件 id */
  ref: string;
  meta?: HubPublishMeta;
}

/** hub:publishResource 回执（hub 201 应答——checksum/sizeBytes 为服务端自算权威值） */
export interface HubPublishResult {
  slug: string;
  version: string;
  checksum: string;
  sizeBytes: number;
}

/** hub:configure 入参（hub 地址 + 本节点名） */
export interface HubConfigureInput {
  hubUrl: string;
  nodeName: string;
}

/** hub:enroll 入参（hub 地址 + 加入凭证 + 本节点名） */
export interface HubEnrollInput {
  hubUrl: string;
  enrollmentToken: string;
  nodeName: string;
}

/**
 * hub 委派子节点设置（M2e T10 + M2.1 T11）：接受开关 + 并发上限 + HITL 超时。
 * 主进程 kv 存储；set 返回归一化值（maxConcurrent 夹取 [1,8]；
 * hitlTimeoutMinutes 夹取 [1,120]，RM-M21-4 默认 15 分钟）。
 */
export interface HubDelegationSettings {
  /** 是否接受其他节点派来的委派任务（关闭 = 一律 declined） */
  acceptTasks: boolean;
  /** 同时执行的委派任务上限 */
  maxConcurrent: number;
  /** HITL 无人确认超时（分钟）：委派会话持续等待用户确认超此值 → 自动拒 */
  hitlTimeoutMinutes: number;
}

/**
 * 节点工作目录视图（2026-10-27 节点互联「工作目录」）：新建工作空间预填与
 * 镜像落位共用生效根。主进程 kv 存储；既有工作空间零迁移。
 */
export interface HubWorkspaceDirView {
  /** 用户配置的根（null = 默认） */
  rootDir: string | null;
  /** 默认根（<userData>/workspaces，随环境解析） */
  defaultRootDir: string;
  /** 生效根 = rootDir ?? defaultRootDir（消费方唯一读点） */
  effectiveRootDir: string;
}

/** hub:groupChanged 推送载荷（协议 GroupChangedEvent 镜像——组成员变动/组长转移的组内广播） */
export interface HubGroupChangedEvent {
  groupId: string;
  kind: 'joined' | 'left' | 'leaderChanged';
  nodeId: string;
}

/** 工作组成员行（协议 GroupMember 镜像——online 为 hub 侧 presence 融合结果） */
export interface HubGroupMember {
  nodeId: string;
  name: string;
  online: boolean;
}

/** 工作组信息（协议 GroupInfo 镜像） */
export interface HubGroupInfo {
  groupId: string;
  groupName: string;
  leaderNodeId: string;
  members: HubGroupMember[];
}

export interface HubGroupListResult {
  groups: HubGroupInfo[];
}

export interface HubGroupCreateResult {
  groupId: string;
  /** 创建者自身节点 id（回显） */
  nodeId: string;
}

export interface HubGroupInviteResult {
  inviteCode: string;
}

export interface HubGroupJoinResult {
  groupId: string;
}

export interface HubGroupLeaveResult {
  ok: boolean;
}

export interface HubGroupTransferResult {
  ok: boolean;
}

/** hub:snapshotBuildUpload 回执（向导 S2 完成态消费；manifest 不出主进程——计数摘要形态） */
export interface HubSnapshotBuildUploadResult {
  /** hub 存档 id（workspace.mirror 引用键） */
  snapshotId: string;
  /** 服务端自算权威 checksum（sha256 hex） */
  checksum: string;
  version: string;
  sizeBytes: number;
  /** 无 hub 记账被排除的插件 id（S1 excluded 提示条） */
  excludedPlugins: string[];
  summary: {
    members: number;
    /** 内嵌自定义定义数（members 子集） */
    embeddedMembers: number;
    teams: number;
    mcp: number;
    /** skill 总数（全量清单——含 builtin / marketplace 目录桶，不产生装包；向后兼容保留） */
    skills: number;
    /** hub 记账 skill 数（resources 段 skill 条目——目标节点先装后落） */
    skillResources: number;
    /** 内嵌 custom skill 数（归档 skills/<slug>/ 实体——目标节点落盘即得） */
    skillEmbedded: number;
    plugins: number;
    providers: number;
    /** 默认模型绑定段是否在场（D4——S1 摘要「有/无」行） */
    modelBinding: boolean;
    /** hub 补装位资源总数 */
    resources: number;
  };
}

/** hub:mirrorWorkspace 入参（M2c 镜像发起——strategy 恒 'replace' 由主进程落） */
export interface HubMirrorWorkspaceInput {
  groupId: string;
  targetNodeId: string;
  workspaceName: string;
  snapshotId: string;
  /** 两段式第二击：conflict 确认后带 true 重发 */
  confirm?: boolean;
}

/** workspace.mirror 第一段受理回执（协议 MirrorAcceptRes 镜像） */
export interface HubMirrorAcceptResult {
  accepted: boolean;
  mirrorId: string;
}

/** hub:mirrorResult 推送载荷（两段式第二段——成功/失败/conflict 差异摘要） */
export interface HubMirrorResultEvent {
  mirrorId: string;
  ok: boolean;
  /** ok=true 时在场 */
  appliedResources?: string[];
  /** ok=true 且目标有软失败引用时在场 */
  unresolvedRefs?: string[];
  /** ok=false 时在场（conflict / node_offline / …） */
  code?: string;
  message?: string;
  /** code=conflict 时在场 */
  diffSummary?: { added: number; removed: number; changed: number };
}

/** hub:workspaceMirrored 推送载荷（协议 WorkspaceMirroredEvent 镜像——组内广播） */
export interface HubWorkspaceMirroredEvent {
  groupId: string;
  targetNodeId: string;
  workspaceName: string;
  snapshotId: string;
  appliedResources: string[];
  unresolvedRefs?: string[];
}

/**
 * hub:installProgress 推送载荷（M2.2 P2-7——与 electron 端
 * resource/hub-install.ts HubInstallProgressEvent 对齐）。installHubPackage
 * 补装全程逐拍推送：downloading（可多拍，字节进度）→ extracting → done；
 * 失败终止拍 failed。
 */
export interface HubInstallProgressEvent {
  stage: 'downloading' | 'extracting' | 'done' | 'failed';
  type: 'agent' | 'skill' | 'mcp' | 'plugin';
  slug: string;
  /** stage='downloading' 字节拍在场：累计已收字节（512KB 增量节流） */
  receivedBytes?: number;
  /** stage='downloading' 在场：总量（Content-Length 可得时；缺失/非法为 null） */
  totalBytes?: number | null;
  /** stage='failed' 在场：人话错误 */
  message?: string;
}

/**
 * 镜像登记行（M2.1 T6 / RM-M21-7——workspace_mirror_registry 表 camelCase 镜像）。
 * 数据源 = workspace.mirrored 组内广播累积（同组×同节点×同空间覆盖 snapshot_id）；
 * 失忆限制：M2 协议无重放，晚入组/离线期间的镜像不可恢复（M3 票：hub 查询式清单 RPC）。
 */
export interface HubMirrorRegistryRow {
  id: number;
  groupId: string;
  targetNodeId: string;
  workspaceName: string;
  snapshotId: string;
  mirroredAt: number;
}

// ── 委派 leader 侧（M2e T12，协议 delegation.ts 镜像；M3.1 七态）────────────

/** 委派账本七态（协议 DelegationStatus 镜像——waiting=M3.1 running 中等待用户确认的中间态） */
export type HubDelegationStatus = 'pending' | 'running' | 'waiting' | 'done' | 'failed' | 'interrupted' | 'cancelled';

/** 委派账本条目（协议 TaskRecord 镜像——七字段） */
export interface HubTaskRecord {
  taskId: string;
  workspaceName: string;
  targetNodeId: string;
  status: HubDelegationStatus;
  title: string;
  createdAt: number;
  updatedAt: number;
}

export interface HubTaskListResult {
  tasks: HubTaskRecord[];
}

/** hub:taskDelegate 入参（任务书三字段——agentSlug 空串等价未指定，主进程剥除） */
export interface HubTaskDelegateInput {
  groupId: string;
  targetNodeId: string;
  workspaceName: string;
  title: string;
  prompt: string;
  agentSlug?: string;
}

export interface HubTaskDelegateResult {
  taskId: string;
}

/** hub:taskAnswer 入参（协议 TaskAnswerReq 镜像——M3.1 远程代答，leader-only） */
export interface HubTaskAnswerInput {
  taskId: string;
  decision: 'approve' | 'deny';
  /** 代答备注（≤512）：仅审计与 leader 侧展示，不注入 worker 子进程 */
  message?: string;
}

/** hub:taskAnswer 回执（协议 TaskAnswerRes 镜像——stale=worker 侧已无等待，幂等口径） */
export interface HubTaskAnswerResult {
  disposition: 'granted' | 'denied' | 'stale';
}

/** hub:taskProgress 推送载荷（协议 TaskProgressEvent 镜像——目标 500ms 合并批的直转） */
export interface HubTaskProgressEvent {
  taskId: string;
  sessionId: string;
  lastSeq: number;
  excerpt: string;
  /** 等待确认标注（M2.1 T11b 协议 v0.1.4）：'waiting-input' = worker 等用户确认；
   *  恢复拍无此字段（leader 摘要 kv waiting 标志随其清除，T12 等待卡消费） */
  kind?: 'waiting-input';
}

/** 终态推送载荷（协议 TaskTerminalEvent 镜像——completed/failed{reason}/interrupted 共用） */
export interface HubTaskTerminalEvent {
  taskId: string;
  reason?: string;
}

/** hub:taskAnswered 推送载荷（协议 TaskAnsweredEvent 挑字段镜像——M3.1；by/disposition 属 hub 审计面不桥） */
export interface HubTaskAnsweredEvent {
  taskId: string;
  decision: 'approve' | 'deny';
}

// ── 看板外派投影（M2.1 T9 delegation-sync 消费面）────────────────────────────

/** 进度摘要条目（delegationId 键——主进程 hub 域 kv 'hub_delegation_progress' 镜像） */
export interface HubDelegationProgressEntry {
  excerpt: string;
  lastSeq: number;
  at: number;
  /** 等待确认标志（T12）：等待拍 true；恢复拍清除（字段缺席 = 非等待） */
  waiting?: boolean;
  /** 远程代答留痕（M3.1）：task.answered 事件置；后续进度拍自然清除——
   *  卡片据 answered.at ≥ entry.at 判「较新」才显示 */
  answered?: { decision: 'approve' | 'deny'; at: number };
}

/** 本机等待确认的委派会话（hub:localWaiting 条目——worker 等待卡数据源） */
export interface HubLocalWaitingEntry {
  sessionId: string;
  summary: string;
}

/** worker 侧本地委派记录（delegation-store DelegationRecord 镜像——byNode=派单来源节点） */
export interface HubReceivedDelegation {
  taskId: string;
  sessionId: string;
  workspaceId: string;
  workspaceName: string;
  title: string;
  byNode: string;
  state: 'running' | 'done' | 'failed' | 'cancelled';
  createdAt: number;
  updatedAt: number;
}

/** hub:delegationBoard 结果——外派卡引导读（进度摘要 + worker 收委派记录） */
export interface DelegationBoardResult {
  progress: Record<string, HubDelegationProgressEntry>;
  received: HubReceivedDelegation[];
}

/** hub:retryDispatch 结果——dispatched=false 行留待处理（无候选/瞬断，RM-M21-5） */
export interface RetryDispatchResult {
  dispatched: boolean;
  nodeId: string | null;
  delegationId: string | null;
}

/**
 * hub 查看同意设置（M2e T14/T15）：「允许本组查看」开关。
 * 主进程 kv 存储；默认 true；set 即时上报 hub（离线由重连重报兜底）。
 */
export interface HubViewSettings {
  /** 允许同组组长查看本机工作空间（关闭 = hub 对 view.* 返 forbidden） */
  allowGroupView: boolean;
}

/** 远程查看——目标节点工作空间概览（协议 ViewOverview 镜像，七字段） */
export interface HubViewOverview {
  overview: {
    name: string;
    description: string;
    sessionCount: number;
  };
  agentMembers: Array<{ name: string; agentSlug?: string }>;
  teams: Array<{ name: string; leaderName: string; memberNames: string[] }>;
  mcpEnabled: string[];
  skills: string[];
  pluginsEnabled: string[];
  resourcesSummary: { agent: number; mcp: number; skill: number; plugin: number };
}

/** 远程查看——会话摘要行（协议 ViewSessionSummary 镜像） */
export interface HubViewSessionSummary {
  sessionId: string;
  title: string;
  lastSeq: number;
  updatedAt: number;
}

/** 远程查看——消息条目（协议 ViewMessage 镜像：seq 全序单调，富形态序列化进 content） */
export interface HubViewMessage {
  seq: number;
  at: number;
  role: string;
  content: string;
}

/** 远程查看——消息回放页（协议 ViewMessagePage 镜像） */
export interface HubViewMessagePage {
  messages: HubViewMessage[];
  hasMore: boolean;
}

/** 远程查看——目标节点本地任务行（协议 ViewLocalTask 镜像） */
export interface HubViewLocalTask {
  taskId: string;
  title: string;
  status: string;
  updatedAt: number;
}

/** 远程查看——远端空间摘要行（M3.2 协议 ViewWorkspaceSummary 镜像：白名单三字段，无 directoryPath） */
export interface HubViewWorkspaceSummary {
  id: string;
  name: string;
  description: string;
}

/** 远程查看——文件树目录条目（M3.2 协议 ViewFileEntry 镜像；size 目录恒 0） */
export interface HubViewFileEntry {
  name: string;
  isDirectory: boolean;
  size: number;
}

/**
 * 远程查看——view.files 响应两态（M3.2 协议 ViewFilesRes 镜像）：list → entries +
 * truncated（单目录上限 500 条）；read → content（base64）+ size（原始字节数）+
 * truncated（单文件上限 256KB）。truncated=true 时内容不完整，不得视为全量。
 */
export type HubViewFilesResult =
  | { entries: HubViewFileEntry[]; truncated: boolean }
  | { content: string; size: number; truncated: boolean };

/** hub:viewAppended 推送载荷（协议 ViewAppendedEvent 镜像——订阅会话的尾部增量批） */
export interface HubViewAppendedEvent {
  sessionId: string;
  events: HubViewMessage[];
}

/** hub 命名空间通道面（spec 2026-10-23：4 invoke + 2 推送；M1 T13 增发布 1 invoke + 1 推送；M2b T4 增工作组 6 invoke + 1 推送；M2c T8b 增镜像 2 invoke + 2 推送） */
export interface HubApiSurface {
  getStatus(): Promise<HubStatus>;
  /** 节点清单补拉（M2.5 T3 / A6）：主进程权威在线集合 = 本机行 + 在线对端（at 为事件时刻，种子行缺省） */
  getNodes(): Promise<Array<{ nodeId: string; nodeName: string; at?: number }>>;
  configure(input: HubConfigureInput): Promise<HubStatus>;
  enroll(input: HubEnrollInput): Promise<HubStatus>;
  forget(): Promise<void>;
  /** 发布本地资源到 momo-hub（四类；非 online / C3 越界 / hub 错误码均以人话 rejection 抛出） */
  publishResource(input: HubPublishResourceInput): Promise<HubPublishResult>;
  /**
   * 从 momo-hub 下架资源（M3.4 §2.4 B12）：目录即刻不可见，已安装节点不受影响；
   * 404（资源不存在或已撤回）/ 未接入 / 连接失效均以人话 rejection 抛出（toast 消费）
   */
  unpublishResource(input: { slug: string }): Promise<void>;
  /** resource.unpublished 推送订阅（撤回即时同步：store 清角标键 + 刷新目录） */
  onResourceUnpublished(callback: (e: HubResourceUnpublishedEvent) => void): () => void;
  /** 工作组列表（仅自己所在的组；成员在线态由 hub presence 融合） */
  groupList(): Promise<HubGroupListResult>;
  /** 创建组（创建者即 leader） */
  groupCreate(input: { groupName: string }): Promise<HubGroupCreateResult>;
  /** 生成组邀请码（再生成即撤销旧码——单组单有效码） */
  groupInvite(input: { groupId: string }): Promise<HubGroupInviteResult>;
  /** 凭码入组（无效/已撤销码 → not_found 人话 rejection；幂等） */
  groupJoin(input: { inviteCode: string }): Promise<HubGroupJoinResult>;
  /** 退组（leader 需先转移组长身份） */
  groupLeave(input: { groupId: string }): Promise<HubGroupLeaveResult>;
  /** 转移组长（仅 leader 可调；目标须为组成员） */
  groupTransfer(input: { groupId: string; toNodeId: string }): Promise<HubGroupTransferResult>;
  /** 构建工作空间配置快照并上传 hub 存档（向导 S2；红线 knownSecrets 复检在主进程） */
  snapshotBuildUpload(input: { workspaceId: string }): Promise<HubSnapshotBuildUploadResult>;
  /** 发起镜像（两段式第一段 → 受理回执 mirrorId；终态经 onMirrorResult 推送） */
  mirrorWorkspace(input: HubMirrorWorkspaceInput): Promise<HubMirrorAcceptResult>;
  /** 读取委派子节点设置（接受开关/并发上限；缺省 true/2） */
  getDelegationSettings(): Promise<HubDelegationSettings>;
  /** 写入委派子节点设置（返回归一化值——maxConcurrent 夹取 [1,8]） */
  setDelegationSettings(input: HubDelegationSettings): Promise<HubDelegationSettings>;
  /** 委派账本拉取（缺省 groupId = 本节点所在全部组；组过滤需成员身份） */
  taskList(input?: { groupId?: string }): Promise<HubTaskListResult>;
  /** 新建委派（leader-only；hub 账本先行 pending，目标离线即拒 node_offline） */
  taskDelegate(input: HubTaskDelegateInput): Promise<HubTaskDelegateResult>;
  /** 取消委派（pending/running/waiting/interrupted 可取消；终态 conflict 人话 rejection） */
  taskCancel(input: { taskId: string }): Promise<{ ok: boolean }>;
  /**
   * 远程代答（M3.1 HITL L2，leader-only，协议门槛 minor 3）：approve=worker 侧
   * 会话级授予全部未决写目录、deny=整会话拒绝；stale=worker 已无等待（幂等）。
   * 错误以 rejection 抛出——RpcRemoteError 的 code 经主进程编入 message 前缀
   * `[code] 原文`（Electron IPC 只保 message，自定义属性不跨进程）。
   */
  taskAnswer(input: HubTaskAnswerInput): Promise<HubTaskAnswerResult>;
  /** 读取查看同意设置（允许本组查看开关；缺省 true） */
  getViewSettings(): Promise<HubViewSettings>;
  /** 写入查看同意设置（set 即时上报 hub；离线由重连重报兜底） */
  setViewSettings(input: HubViewSettings): Promise<HubViewSettings>;
  /** 读取节点工作目录视图（新建预填与镜像落位共用 effectiveRootDir） */
  getWorkspaceDirSettings(): Promise<HubWorkspaceDirView>;
  /** 写入节点工作目录（rootDir=null 恢复默认；回执为归一化 view） */
  setWorkspaceDirSettings(input: { rootDir: string | null }): Promise<HubWorkspaceDirView>;
  /** 远程查看：目标工作空间概览+配置七子段（M2e T14 四视图数据源之一） */
  viewWorkspace(input: { targetNodeId: string; workspaceName: string; groupId?: string }): Promise<HubViewOverview>;
  /** 远程查看：目标工作空间会话列表（lastSeq 降序分页） */
  viewSessions(input: {
    targetNodeId: string;
    workspaceName: string;
    beforeSeq?: number;
    limit: number;
    groupId?: string;
  }): Promise<{ sessions: HubViewSessionSummary[] }>;
  /** 远程查看：会话消息回放页（seq 升序；workspaceName 为可选作用域校验附加键） */
  viewMessages(input: {
    targetNodeId: string;
    sessionId: string;
    workspaceName?: string;
    fromSeq: number;
    limit: number;
    groupId?: string;
  }): Promise<HubViewMessagePage>;
  /** 远程查看：目标工作空间本地 #T 任务列表 */
  viewTasks(input: { targetNodeId: string; workspaceName: string; groupId?: string }): Promise<{ tasks: HubViewLocalTask[] }>;
  /** 远程查看：订阅会话尾部增量（进入回放视图自动调；断开/离开自动 unsubscribe） */
  viewSubscribe(input: { targetNodeId: string; sessionId: string; groupId?: string }): Promise<{ ok: boolean }>;
  /** 远程查看：注销尾部订阅（幂等清理——hub 侧 consent 关闭不阻断退订） */
  viewUnsubscribe(input: { targetNodeId: string; sessionId: string; groupId?: string }): Promise<{ ok: boolean }>;
  /** 远程查看（M3.2）：目标节点空间清单（白名单三字段投影；picker 远端数据源） */
  viewWorkspaces(input: { targetNodeId: string; groupId?: string }): Promise<{ workspaces: HubViewWorkspaceSummary[] }>;
  /** 远程查看（M3.2）：目标工作空间只读文件树——op=list 目录列举 / op=read 文件读取（base64） */
  viewFiles(input: {
    targetNodeId: string;
    workspaceName: string;
    op: 'list' | 'read';
    path?: string;
    groupId?: string;
  }): Promise<HubViewFilesResult>;
  /**
   * 镜像登记表查询（M2.1 T6）：workspaceName 可选过滤；行=组内 workspace.mirrored
   * 广播累积登记（T3 徽标/T4 选择器/T7 调度/T8 守门四消费方同源数据）
   */
  mirrorRegistry(input?: { workspaceName?: string }): Promise<{ mirrors: HubMirrorRegistryRow[] }>;
  /**
   * 路由提交链（M2.1 T8）：三模式统一落点——local 委托既有创建；group 走 least-busy
   * 调度+既有委派管道+delegation_id 回写（无候选/瞬断 → 行留待处理 dispatched=false）；
   * node 直发指定成员。permissionTier 缺省 'confirm' 随载荷。
   */
  submitRoutedTask(input: SubmitRoutedTaskInput): Promise<SubmitRoutedTaskResult>;
  /** 路由预检概要（M2.1 T8 弹窗「执行位置」区数据源；hub 不可达降级空组清单不抛） */
  routingPrecheck(input: { workspaceName: string }): Promise<RoutingPrecheckResult>;
  /**
   * 看板外派投影引导读（M2.1 T9）：progress=进度摘要 kv 全量（重启后进度行不丢）；
   * received=worker 侧本地委派记录（byNode=来源，「来自 {node}」徽标数据源）
   */
  delegationBoard(): Promise<DelegationBoardResult>;
  /**
   * 外派行重派单点（M2.1 T9）：待派发重试（RM-M21-5 手动驱动）/ 失败重派（换
   * delegation_id）；无候选/瞬断 → dispatched=false 行留待处理
   */
  retryDispatch(input: { taskId: string }): Promise<RetryDispatchResult>;
  /** 本机等待确认的委派会话清单（M2.1 T12）：worker 等待卡数据源；恢复自动去态 */
  localWaiting(): Promise<HubLocalWaitingEntry[]>;
  /** 连接状态变化推送订阅（解订阅函数） */
  onStateChanged(callback: (payload: HubStateChangedEvent) => void): () => void;
  /** 节点上下线推送订阅（解订阅函数） */
  onNodePresence(callback: (payload: HubNodePresenceEvent) => void): () => void;
  /** 资源发布成功推送订阅（解订阅函数）——含本机与其他节点的发布 */
  onResourcePublished(callback: (payload: HubResourcePublishedEvent) => void): () => void;
  /** 工作组变动推送订阅（解订阅函数）——组成员变动/组长转移（组内广播，含自己触发的） */
  onGroupChanged(callback: (payload: HubGroupChangedEvent) => void): () => void;
  /** 镜像两段式第二段推送订阅（解订阅函数）——成功/失败/conflict 差异摘要（定向→本机 leader） */
  onMirrorResult(callback: (payload: HubMirrorResultEvent) => void): () => void;
  /** hub 资源补装进度推送订阅（解订阅函数）——downloading/extracting/done/failed 逐拍（M2.2 P2-7） */
  onInstallProgress(callback: (payload: HubInstallProgressEvent) => void): () => void;
  /** 镜像完成组内广播订阅（解订阅函数）——组内皆可见谁被镜像到什么版本 */
  onWorkspaceMirrored(callback: (payload: HubWorkspaceMirroredEvent) => void): () => void;
  /** 委派进度拍推送订阅（定向→本机 leader；目标侧 500ms 合并批的直转） */
  onTaskProgress(callback: (payload: HubTaskProgressEvent) => void): () => void;
  /** 委派完成推送订阅（定向→本机 leader） */
  onTaskCompleted(callback: (payload: HubTaskTerminalEvent) => void): () => void;
  /** 委派失败推送订阅（定向→本机 leader；reason 携带 declined/local_session_lost 等约定值） */
  onTaskFailed(callback: (payload: HubTaskTerminalEvent) => void): () => void;
  /** 委派中断推送订阅（定向→本机 leader；目标节点离线，重连自动续跑） */
  onTaskInterrupted(callback: (payload: HubTaskTerminalEvent) => void): () => void;
  /** 委派代答落账推送订阅（M3.1，定向→本机 leader——「已远程批准/拒绝」即时反馈） */
  onTaskAnswered(callback: (payload: HubTaskAnsweredEvent) => void): () => void;
  /** 查看尾部增量推送订阅（定向→本机 leader；订阅会话的 view.appended 批） */
  onViewAppended(callback: (payload: HubViewAppendedEvent) => void): () => void;
}
