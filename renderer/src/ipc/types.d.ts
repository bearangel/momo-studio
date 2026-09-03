// renderer/src/ipc/types.d.ts
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
  /** 有无 API key override（实际 key 在 keychain） */
  hasApiKeyOverride: boolean;
  /** 用户最近运行意图（true=在线/false=离线）——「agent 在线」的唯一权威源 */
  lastRunning: boolean;
  createdAt: string;
  /**
   * UI 展示用的 agent 名称（可选，由 renderer 按 definitions join 注入；
   * 缺失时回退到 agentUserId。Mention 菜单 / 指派下拉优先用此字段）。
   */
  agentName?: string;
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
  | 'in_progress'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled';

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
 * 远端节点任务镜像（P4 Task 3）——p2p:getRemoteTasks 返回结构。
 * 只读：远端任务仅作看板展示，不进本地 tasks 表。
 */
export interface RemoteNodeTasks {
  nodeId: string;
  nodeName: string;
  tasks: TaskSnapshotItem[];
  /** 快照拍摄时间（毫秒） */
  takenAt: number;
  /** 超 3 分钟未更新——对端可能离线（仍展示，带「已离线?」标记） */
  stale: boolean;
}

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

export interface TaskApiSurface {
  create(input: {
    workspaceId: string;
    title: string;
    description?: string;
    priority?: number;
    sourceSessionId?: string | null;
    sourceMessageId?: string | null;
    assigneeAgentId?: string | null;
    scheduledAt?: number | null;
    deadlineAt?: number | null;
  }): Promise<TaskRow>;
  list(opts: {
    workspaceId?: string;
    status?: TaskStatus | TaskStatus[];
    assigneeAgentId?: string;
    executionSessionId?: string;
    sourceSessionId?: string;
    orderBy?: 'priority' | 'scheduled_at' | 'created_at';
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
  taskId: string | null;
  createdAt: number;
  updatedAt: number;
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

/** 供应商的模型列表条目（与 electron 端 ProviderModel 对齐，v24 起） */
export interface ProviderModel {
  providerId: string;
  modelId: string;
  enabled: boolean;
  addedAt: number;
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
}

/**
 * v1.7 资源类型：agent（子 agent 定义）/ mcp（MCP server 包）/ skill（技能包）。
 * 与 electron 端 resource/types.ts 的 ResourceType 对齐。
 */
export type ResourceType = 'agent' | 'mcp' | 'skill';

/**
 * v1.7 资源来源：
 *   - builtin      系统预置（随应用分发，不可删除）
 *   - marketplace  网络资源（远程 catalog 下载安装）
 *   - custom       我的上传（用户本地注册 / 上传）
 *   - p2p          P2P 共享（v2 引入）
 * 与 electron 端 resource/types.ts 的 ResourceSource 对齐。
 */
export type ResourceSource = 'builtin' | 'marketplace' | 'custom' | 'p2p';

/**
 * v1.7 资源列表过滤条件，所有字段可选，undefined 表示不过滤该维度。
 * 与 electron 端 resource/types.ts 的 ResourceFilter 对齐。
 */
export interface ResourceFilter {
  type?: ResourceType;
  source?: ResourceSource;
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
  iconEmoji?: string;
  /** 是否已安装到本地（builtin 永远 true） */
  installed: boolean;
  /** 是否可安装（builtin = false；p2p 未确认时 = false） */
  installable: boolean;
  /** 是否可删除（仅 builtin = false） */
  removable: boolean;
  /** builtin 项的扩展元数据 */
  builtin?: { category?: string; tags?: string[] };
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
  /** custom 项的扩展元数据 */
  custom?: {
    installedAt: string;
    mcpConfig?: { command: string; args: string[]; env?: Record<string, string> };
    skillFrontmatter?: { name?: string; version?: string };
    agentSystemPromptHash?: string;
  };
  /** p2p 项的扩展元数据 */
  p2p?: { peerId: string; peerName: string };
}

/**
 * v1.5 TodoTools 任务项。与 electron 端 tools/todo-types.ts 的 TodoItem 对齐。
 * 因 renderer 无法直接 import electron 源码，这里维持一份等价的本地定义。
 */
export interface TodoItem {
  id: string;
  subject: string;
  status: 'pending' | 'in_progress' | 'completed';
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
    | 'final';
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
  members: SessionMemberInfo[];
}

/**
 * v25 spec §4.4：协作会话目标——单个 agent 或团队（快照展开）。
 */
export type CollabTarget = { type: 'agent'; instanceId: string } | { type: 'team'; teamId: string };

/**
 * v2.0 P1 Task 8：session: 命名空间 IPC 契约（会话内核，纯 SQLite 无 Matrix）。
 *
 * v25 Task 6（spec §5）：泛化 create 退役 → createQuick / createCollab。
 * invoke 通道 10 个（session.ipc.handlers.ts）：
 *   list / get / createQuick / createCollab / rename / delete / send /
 *   getMessages / loadOlder / exportMessages
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
   */
  send(
    sessionId: string,
    body: string,
    mentionedInstanceIds?: string[],
  ): Promise<{ readOnly: boolean }>;
  /**
   * 历史读取：messages + 每条 message 的 events，
   * renderer 用 stream-aggregator 重建 StreamState。
   */
  getMessages(
    sessionId: string,
  ): Promise<{ messages: ImMessage[]; eventsByMessage: Record<string, MessageEventRow[]> }>;
  /**
   * 向前翻页：返回 created_at < beforeTs 的消息。
   * beforeTs 由调用方从当前可见消息的最小 createdAt 推导；count 默认 30。
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
  /** 订阅消息行实时推送（session:message） */
  onMessage(callback: (msg: ImMessage) => void): () => void;
  /** 订阅流式 events 批量推送（session:message_event_batch，MessageEventBuffer flush 时触发） */
  onMessageEventBatch(callback: (batch: MessageEventBatch) => void): () => void;
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
    /** P2 Task 2：重命名 workspace（UPDATE name 列） */
    rename(id: string, name: string): Promise<{ ok: boolean }>;
    /** P2 Task 2：在系统文件管理器中打开 workspace 目录 */
    openDirectory(id: string): Promise<{ ok: boolean }>;
  };
  file: {
    read(workspaceId: string, filePath: string): Promise<string>;
    write(workspaceId: string, filePath: string, content: string): Promise<void>;
    list(workspaceId: string, dirPath: string): Promise<DirEntry[]>;
    create(workspaceId: string, filePath: string, type: 'file' | 'dir'): Promise<void>;
    delete(workspaceId: string, filePath: string): Promise<void>;
    rename(workspaceId: string, srcPath: string, dstPath: string): Promise<void>;
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
    }): Promise<{ definition: AgentDefinition; stoppedInstanceIds: string[] }>;
    /** v25：原 updateAssignmentApiKey 平移更名（apiKey=null 清除 override） */
    setMemberApiKeyOverride(instanceId: string, apiKey: string | null): Promise<{ ok: boolean }>;
    /** v1.3 新增：删除自定义 def（builtin 不可删；级联清理成员） */
    deleteDefinition(defId: string): Promise<{ stoppedInstanceIds: string[] }>;
    /** v1.3 新增：返回 builtin 建议 Map（UI 添加 builtin 时预填 platform） */
    getBuiltinSuggestions(): Promise<BuiltinSuggestionMap>;
    /** v25：原 getAssignmentDeltas 平移更名（全空对象 = 无 delta） */
    getMemberDeltas(instanceId: string): Promise<AssignmentDeltas>;
    /** v25：原 setAssignmentDeltas 平移更名（幂等全量替换） */
    setMemberDeltas(instanceId: string, deltas: AssignmentDeltas): Promise<void>;
    onRuntimeChanged(callback: () => void): () => void;
    /** Task 6：中断指定 streamSessionId 的活跃流式会话（原按 roomId 中断，修同房覆盖问题） */
    abortStream(streamSessionId: string): Promise<void>;
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
  provider: {
    list(): Promise<ModelProvider[]>;
    get(id: string): Promise<ModelProvider | null>;
    create(input: {
      name: string; baseUrl: string; apiKey: string;
      defaultModel?: string; isDefault?: boolean; platform?: ProviderPlatform;
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
    /** Task 6：删除模型条目 */
    removeModel(id: string, modelId: string): Promise<void>;
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
  resource: {
    /** v1.7：统一资源列表（builtin + marketplace + custom 三源合并），filter 可选 */
    list(filter?: ResourceFilter): Promise<ResourceItem[]>;
    /** v1.7：按 id 查单个资源详情（找不到返回 null） */
    getDetail(id: string): Promise<ResourceItem | null>;
    /** v1.7：安装 marketplace 资源（builtin/custom 不可安装，抛错） */
    install(id: string): Promise<void>;
    /** v1.7：删除/卸载资源（builtin 抛错；marketplace→uninstall；custom 按 type 三分支） */
    delete(id: string): Promise<void>;
    /** P3 Task 7：注册自定义 MCP（source 固定 'custom'），返回新条目的 ResourceItem */
    registerMcp(config: RegisterMcpInput): Promise<ResourceItem>;
    /** P3 Task 7：上传自定义 skill zip，返回 UploadedSkill[]（v1.6.2 起支持批量） */
    uploadSkill(buffer: ArrayBuffer, filename: string): Promise<UploadedSkill[]>;
  };
  task: TaskApiSurface;
  /**
   * P2P 子系统 IPC（C 子系统 C8）——节点发现 + 信任管理。
   *
   *   - getIdentity：当前节点身份（未 initP2p 时返回 null）。fingerprint = 签名公钥
   *     指纹（sha512 前 16 字节 hex，32 字符）——本机指纹，信任前供对端带外核对
   *   - getDiscoveredNodes：mDNS 发现的节点列表（trusted 字段标当前是否已信任；
   *     fingerprint = 该节点签名公钥指纹，与本机指纹比对防局域网冒充）
   *   - addTrustedNode / removeTrustedNode：信任管理（信任后才能 E2E 通信）
   *   - listTrustedNodes：信任节点完整列表（settings 详情用）
   */
  p2p: {
    getIdentity(): Promise<
      { nodeId: string; displayName: string; fingerprint: string } | null
    >;
    getDiscoveredNodes(): Promise<
      Array<{
        nodeId: string;
        displayName: string;
        transport: 'lan' | 'hub';
        trusted: boolean;
        lastSeen: number;
        /** 节点签名公钥指纹——添加信任前与对端 UI 展示的本机指纹核对（防冒充） */
        fingerprint: string;
      }>
    >;
    addTrustedNode(nodeId: string): Promise<void>;
    removeTrustedNode(nodeId: string): Promise<void>;
    listTrustedNodes(): Promise<
      Array<{ nodeId: string; displayName: string; trustedAt: number }>
    >;
    /** P4 Task 3：远端节点任务只读镜像（内存缓存；轮询点顺带清理超时条目） */
    getRemoteTasks(): Promise<RemoteNodeTasks[]>;
  };
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
}

export interface DirEntry {
  name: string;
  isDirectory: boolean;
  size: number;
}
