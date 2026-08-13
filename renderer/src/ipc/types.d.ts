// renderer/src/ipc/types.d.ts
export interface SystemInfo {
  platform: string;
  arch: string;
  nodeVersion: string;
  appVersion: string;
  userDataDir: string;
}

export interface ConduitStatus {
  running: boolean;
  baseUrl: string | null;
  port: number | null;
}

export interface AuthResult {
  userId: string;
  deviceId: string;
}

export interface Workspace {
  id: string;
  name: string;
  description: string;
  directoryPath: string;
  matrixSpaceId: string;
  /** workspace 内"团队群" room ID（用户 + agent bot 交流房间），004 迁移引入 */
  teamRoomId: string;
  gitInitialized: boolean;
  createdAt: string;
  ownerId: string;
  iconEmoji: string;
  /** 该 workspace 的"协调 agent"实例 ID；null=未指定 */
  coordinatorInstanceId: string | null;
}

export interface CreateWorkspaceInput {
  name: string;
  description?: string;
  directoryPath: string;
  iconEmoji?: string;
}

export type AgentRole = 'standalone' | 'main' | 'sub';

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
  /** NULL=全局共享；非 NULL=该 workspace 私有 */
  workspaceId: string | null;
  /** NULL=builtin 未配置；custom 必填 */
  modelProviderId: string | null;
  /** 模型名 */
  modelName: string;
}

export interface AgentAssignment {
  instanceId: string;
  workspaceId: string;
  agentDefinitionId: string;
  botMatrixUserId: string;
  enabled: boolean;
  createdAt: string;
  /** 角色（在 assignment 级而非 definition 级） */
  role: AgentRole;
  /** 父 assignment 的 instanceId（仅 role='sub' 时有值） */
  parentInstanceId: string | null;
  /** 有无 API key override（实际 key 在 keychain） */
  hasApiKeyOverride: boolean;
  /**
   * UI 展示用的 agent 名称（可选，由 main process 在 listAssignments 时 join 注入）。
   * 缺失时回退到 botMatrixUserId。Mention 菜单 / TaskChip 优先用此字段。
   */
  agentName?: string;
}

/** Builtin YAML 的角色/platform 建议（不进 DB，仅 UI 默认值） */
export interface BuiltinSuggestion {
  role: AgentRole;
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
  sourceRoomId: string | null;
  sourceMessageId: string | null;
  creatorUserId: string;
  executionRoomId: string | null;
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
    sourceRoomId?: string | null;
    sourceMessageId?: string | null;
    assigneeAgentId?: string | null;
    scheduledAt?: number | null;
    deadlineAt?: number | null;
  }): Promise<TaskRow>;
  list(opts: {
    workspaceId?: string;
    status?: TaskStatus | TaskStatus[];
    assigneeAgentId?: string;
    executionRoomId?: string;
    sourceRoomId?: string;
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
  /** B8 实现：拉起 execution room + transition 到 in_progress */
  start(id: string, opts: { executionRoomId?: string; createNewRoom?: boolean }): Promise<{
    executionRoomId: string;
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
    | { action: 'fork'; newTaskId: string; newExecutionRoomId: string }
    | { action: 'reject'; reason: string }
    | { action: 'ask' }
  >;
}

export interface StartAgentInput {
  assignment: AgentAssignment;
  workspaceId: string;
  teamRoomId: string;
}

/** agent:addToWorkspace 入参 — UI "添加 agent" 一键编排入口 */
export interface AddToWorkspaceInput {
  workspaceId: string;
  agentDefinitionId: string;
  role: AgentRole;
  parentInstanceId?: string;
  apiKeyOverride?: string;
}

/**
 * agent:assignMain 入参 — 安装 main agent 时自动跟随注册其全部 sub agent。
 * 内部行为：写 assignment.role='main'（首条）+ role='sub'（其余）+ parent_instance_id 链。
 */
export interface AssignMainInput {
  workspaceId: string;
  mainDefId: string;
  apiKeyOverride?: string;
  /** 要安装的子 agent 定义 ID 列表；undefined = 全部安装 */
  selectedSubDefIds?: string[];
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
  roomId: string;
  sender: string;
  body: string;
  eventType: string;
  streamSessionId: string | null;
  parentStreamSessionId: string | null;
  segmentOf: string | null;
  segmentIndex: number | null;
  status: 'streaming' | 'done' | 'failed' | 'aborted';
  source: 'local' | 'lan' | 'hub' | 'matrix';
  matrixEventId: string | null;
  workspaceId: string | null;
  taskId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface ImRoomInfo {
  roomId: string;
  name: string;
  isSystem?: boolean;
}

/** 房间成员（含身份标识） */
export interface RoomMember {
  userId: string;
  displayName: string;
  avatarUrl: string | null;
  powerLevel: number;
  isBot: boolean;
  isLocalUser: boolean;
}

/** MCP 工具信息（tools/list 响应的单条工具，与 electron 端 McpToolInfo 对齐） */
export interface McpToolInfo {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** MCP server 定义（mcp:register 入参，与 electron 端 McpServerConfig 对齐） */
export interface McpServerConfig {
  id: string;
  name: string;
  version: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  /** v1.6：来源标识。'marketplace' 不可删（走卸载按钮），'custom' 可删 */
  source?: 'marketplace' | 'custom';
  /** v1.6：注册时间 ISO 字符串（缺省时 DB 列默认值填充） */
  installedAt?: string;
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
 * 由 Task 9 的 DefinitionEditor / Task 11 的 AddToWorkspaceDialog 消费。
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

/** 全局模型供应商（注册表项，不含 apiKey） */
export interface ModelProvider {
  id: string;
  name: string;
  baseUrl: string;
  defaultModel: string | null;
  isDefault: boolean;
  createdAt: string;
}

/** 全局会话配置（v1.4：工具调用上限等），与 electron 端 GlobalSettings 对齐 */
export interface GlobalSettings {
  /** 工具调用上限默认值。-1=无限, 0=禁用, N=上限 */
  maxToolCalls: number;
}

/** 房间级会话配置（v1.4 + B9），与 electron 端 RoomSettings 对齐 */
export interface RoomSettings {
  /** NULL=继承全局 */
  maxToolCalls: number | null;
  /** 任务冲突策略（migration v19 加列，默认 'ask'） */
  conflictStrategy: 'ask' | 'queue' | 'preempt' | 'fork' | 'reject';
}

/**
 * v1.6.2：单次 zip 上传返回结构（skill:uploadZip 返回数组，即使只装一个 skill）。
 * 与 electron 端的 InstalledSkill 区别：不含 source / installedAt（这两个由 listResources 二次解析）。
 */
export interface UploadedSkill {
  slug: string;
  /** 展示名（来自 frontmatter.name，无则用 slug 兜底） */
  name: string;
  description: string;
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
 * 流式 IPC chunk（v1.4），与 electron 端 stream-chunk.ts 的 StreamChunk 对齐。
 * 子进程 process.send → 主进程转发 → renderer 经 api.agent.onStream 接收。
 * renderer 用 streamSessionId 聚合同一次响应的所有 chunk 到一个临时气泡。
 *
 * v1.4 嵌套字段（仅在嵌套场景出现）：
 * - start.parentStreamSessionId: 子 agent 标识其所属 PM 的 stream session，renderer 据此把子流
 *   嵌套渲染到 PM 气泡内的 dispatch chip 下方
 * - start.subAgentName / subAgentAvatar: 子 agent 的展示名与头像（chip 头部用）
 * - tool_call.isDispatch: 标记该 tool_call 是 PM 的 dispatch 委派（与普通工具调用区分）
 * - tool_call.subStreamSessionId: PM 发起的本次子 agent 流 session ID（与子 start 的
 *   streamSessionId 对应，renderer 据此把子 stream 关联到 dispatch chip）
 * - tool_result.subStatus: dispatch 完成状态（completed / failed / timeout），用于更新 chip 状态
 *
 * v1.5 新增：
 * - todo_update: todowrite 工具调用导致的任务列表全量替换，renderer 据此更新 todo 面板
 */
export type StreamChunk =
  | {
      type: 'start';
      streamSessionId: string;
      roomId: string;
      botUserId: string;
      /** v1.4 嵌套：父 agent 的 streamSessionId（子 agent 用，标识所属 PM 会话） */
      parentStreamSessionId?: string;
      /** v1.4 嵌套：子 agent 展示名（dispatch chip 头部显示） */
      subAgentName?: string;
      /** v1.4 嵌套：子 agent emoji 头像（dispatch chip 头部显示） */
      subAgentAvatar?: string;
    }
  | { type: 'thinking'; streamSessionId: string; delta: string }
  | { type: 'text'; streamSessionId: string; delta: string }
  | {
      type: 'tool_call';
      streamSessionId: string;
      /** A7：工具调用唯一 ID（tool_call ↔ tool_result 配对用，MessageEventBuffer 据此落盘） */
      callId: string;
      toolName: string;
      args: Record<string, unknown>;
      /** v1.4 嵌套：标记此 tool_call 为 PM 的 dispatch 委派（区分普通工具调用） */
      isDispatch?: boolean;
      /** v1.4 嵌套：本次委派创建的子 agent 流 session ID（关联子 agent start chunk） */
      subStreamSessionId?: string;
      /** v1.4 嵌套：被委派子 agent 的展示名 */
      subAgentName?: string;
      /** v1.4 嵌套：被委派子 agent 的 emoji 头像 */
      subAgentAvatar?: string;
    }
  | {
      type: 'tool_result';
      streamSessionId: string;
      /** A7：配对的 tool_call callId（与对应 tool_call chunk 的 callId 一致） */
      callId: string;
      toolName: string;
      result: string;
      success: boolean;
      /** v1.4 嵌套：dispatch 完成状态（completed=成功 / failed=子 agent 报错 / timeout=超时） */
      subStatus?: 'completed' | 'failed' | 'timeout';
    }
  | {
      /** v1.5 todowrite 全量替换任务列表。每次调用 todowrite 都发一个 chunk，携带完整 todos。 */
      type: 'todo_update';
      streamSessionId: string;
      roomId: string;
      /** 完整任务列表（覆盖式）；空数组 = 清空 */
      todos: TodoItem[];
      /** v1.5 嵌套：父 agent 的 streamSessionId（子 agent 调 todowrite 时携带） */
      parentStreamSessionId?: string;
    }
  | {
      type: 'end';
      streamSessionId: string;
      finishReason: 'stop' | 'budget_exhausted' | 'interrupted' | 'error';
      error?: string;
    }
  | {
      /** A7 fix：task_complete 主动分段边界，触发主进程 INSERT 独立分段 message row */
      type: 'segment_boundary';
      /** 父 stream session id */
      streamSessionId: string;
      /** 第几段（1-based） */
      segmentIndex: number;
      /** 本段最终 body 快照 */
      segmentBody: string;
      /** 本段独立 stream session id（如 "ss-1#seg1"） */
      segmentStreamSessionId: string;
    };

/**
 * A 子系统：事件溯源——单条 stream chunk 落盘一行。
 *
 * 与 StreamChunk（IPC 实时通道）的区别：
 * - StreamChunk 是 transient 的 IPC 事件，由 renderer stream.store 聚合；
 * - MessageEventRow 是持久化的 DB 行，A 子系统重启后从 message_events 表重建流状态。
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

/** MessageEventRow[] 批量推送（IPC 通道 im:message_event_batch） */
export type MessageEventBatch = MessageEventRow[];

export interface ApiSurface {
  auth: {
    register(opts: { username: string; password: string }): Promise<AuthResult>;
    login(opts: { username: string; password: string }): Promise<AuthResult>;
    getCurrentUser(): Promise<AuthResult | null>;
    logout(): Promise<void>;
    /** v1.5.7: token 失效时主进程通知 renderer 跳转登录页 */
    onSessionExpired(callback: (reason: string) => void): () => void;
  };
  system: {
    getInfo(): Promise<SystemInfo>;
    getConduitStatus(): Promise<ConduitStatus>;
  };
  workspace: {
    create(input: CreateWorkspaceInput): Promise<Workspace>;
    list(): Promise<Workspace[]>;
    get(id: string): Promise<Workspace | null>;
    delete(id: string): Promise<void>;
    setCoordinator(workspaceId: string, instanceId: string | null): Promise<{ ok: boolean }>;
    getCoordinator(workspaceId: string): Promise<{ instanceId: string | null }>;
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
    /** v1.3：一键编排（带 role + parentInstanceId + apiKeyOverride） */
    addToWorkspace(input: AddToWorkspaceInput): Promise<AgentAssignment>;
    /** v1.3：安装 main + 自动跟随 sub */
    assignMain(input: AssignMainInput): Promise<AgentAssignment[]>;
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
    assign(workspaceId: string, defId: string, botUserId: string): Promise<AgentAssignment>;
    listAssignments(workspaceId: string): Promise<AgentAssignment[]>;
    start(opts: StartAgentInput): Promise<{ instanceId: string }>;
    stop(instanceId: string): Promise<{ ok: boolean }>;
    removeAssignment(instanceId: string): Promise<{ ok: boolean }>;
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
    /** v1.3 新增：修改 assignment 的 role + parentInstanceId */
    updateAssignmentRole(
      instanceId: string,
      role: AgentRole,
      parentInstanceId?: string,
    ): Promise<{ stoppedInstanceIds: string[] }>;
    /** v1.3 新增：设置/清除 API key override（apiKey=null 清除） */
    updateAssignmentApiKey(
      instanceId: string,
      apiKey: string | null,
    ): Promise<{ ok: boolean }>;
    /** v1.3 新增：删除自定义 def（builtin 不可删；级联清理 assignment） */
    deleteDefinition(defId: string): Promise<{ stoppedInstanceIds: string[] }>;
    /** v1.3 新增：返回 builtin 建议 Map（UI 添加 builtin 时预填） */
    getBuiltinSuggestions(): Promise<BuiltinSuggestionMap>;
    /** v1.6：读取某 assignment 的能力 delta（Layer 3，全空对象 = 无 delta） */
    getAssignmentDeltas(instanceId: string): Promise<AssignmentDeltas>;
    /** v1.6：全量替换某 assignment 的能力 delta（幂等） */
    setAssignmentDeltas(instanceId: string, deltas: AssignmentDeltas): Promise<void>;
    onRuntimeChanged(callback: () => void): () => void;
    /** v1.4：订阅 agent 流式 chunk（thinking/text/tool_call 等），返回取消订阅函数 */
    onStream(callback: (chunk: StreamChunk) => void): () => void;
    /** v1.4：中断指定房间的活跃流式会话 */
    abortStream(roomId: string): Promise<void>;
  };
  provider: {
    list(): Promise<ModelProvider[]>;
    get(id: string): Promise<ModelProvider | null>;
    create(input: { name: string; baseUrl: string; apiKey: string; defaultModel?: string; isDefault?: boolean }): Promise<ModelProvider>;
    update(input: { id: string; name?: string; baseUrl?: string; apiKey?: string; defaultModel?: string; isDefault?: boolean }): Promise<ModelProvider>;
    delete(id: string): Promise<{ ok: boolean }>;
    setDefault(id: string): Promise<{ ok: boolean }>;
    testConnection(input: { baseUrl: string; apiKey: string; model: string }): Promise<{ ok: boolean; error?: string }>;
    getApiKey(id: string): Promise<string | null>;
  };
  im: {
    startSync(): Promise<void>;
    send(roomId: string, body: string): Promise<void>;
    sendWithMentions(roomId: string, body: string, mentionedUserIds: string[]): Promise<void>;
    /** 房间列表。workspaceId 提供时只返回该 workspace 范围内的房间 */
    getRooms(workspaceId?: string): Promise<ImRoomInfo[]>;
    /**
     * A 子系统：从 SQLite 拉 messages + 每条 message 的 events，
     * renderer 用 stream-aggregator 重建 StreamState。
     */
    getMessages(
      roomId: string,
    ): Promise<{ messages: ImMessage[]; eventsByMessage: Record<string, MessageEventRow[]> }>;
    /**
     * 向前翻页：返回 SQLite 里 created_at < beforeTs 的消息。
     * beforeTs 由调用方从当前可见消息的最小 createdAt 推导。
     */
    loadOlderMessages(
      roomId: string,
      beforeTs: number,
      count?: number,
    ): Promise<{
      messages: ImMessage[];
      eventsByMessage: Record<string, MessageEventRow[]>;
      hasMore: boolean;
    }>;
    /** 拉取单条 message 的全部 events（按 seq 升序） */
    getMessageEvents(messageId: string): Promise<MessageEventRow[]>;
    createRoom(input: {
      name: string;
      isDirect: boolean;
      inviteUserIds: string[];
      /** 把新建房间加入此 workspace 的 Space（让其在此 workspace 内可见） */
      workspaceId?: string;
    }): Promise<{ roomId: string }>;
    renameRoom(roomId: string, name: string): Promise<{ ok: boolean }>;
    dissolveRoom(roomId: string): Promise<{ dissolved: boolean }>;
    getMembers(roomId: string): Promise<RoomMember[]>;
    /** 导出指定房间最近 limit 条会话为 Markdown。返回 { filename, content }，renderer 用 Blob 触发下载。 */
    exportRoomMessages(roomId: string, limit: number): Promise<{ filename: string; content: string }>;
    onMessage(callback: (msg: ImMessage) => void): () => void;
    /** A 子系统：订阅 stream chunk 批量推送（主进程 MessageEventBuffer flush 时触发） */
    onMessageEventBatch(callback: (batch: MessageEventBatch) => void): () => void;
  };
  mcp: {
    /** 注册一条 MCP server 定义到 SQLite（不启动进程） */
    register(config: McpServerConfig): Promise<void>;
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
    /** 读取房间级配置（不存在返回 null 字段） */
    getRoom(roomId: string): Promise<RoomSettings>;
    /** 部分更新房间级配置，返回更新后的完整配置 */
    updateRoom(roomId: string, patch: Partial<RoomSettings>): Promise<RoomSettings>;
  };
  skill: {
    /**
     * v1.6：上传自定义 skill zip（解压到 <userData>/skills/<slug>/）。
     * v1.6.2 起返回 UploadedSkill[]（支持扁平 / 包裹 / 多 skill 批量三种 zip 结构）。
     */
    uploadZip(buffer: ArrayBuffer, filename: string): Promise<UploadedSkill[]>;
  };
  resource: {
    /** v1.7：统一资源列表（builtin + marketplace + custom 三源合并），filter 可选 */
    list(filter?: ResourceFilter): Promise<ResourceItem[]>;
    /** v1.7：按 id 查单个资源详情（找不到返回 null） */
    getDetail(id: string): Promise<ResourceItem | null>;
    /** v1.7：安装 marketplace 资源（builtin/custom 不可安装，抛错） */
    install(id: string): Promise<void>;
    /** v1.7：删除/卸载资源（builtin 抛错；marketplace→uninstall；custom 按 type 三分支） */
    delete(id: string): Promise<void>;
  };
  task: TaskApiSurface;
}

export interface DirEntry {
  name: string;
  isDirectory: boolean;
  size: number;
}
