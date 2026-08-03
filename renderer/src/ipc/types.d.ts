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

export interface AgentDefinition {
  id: string;
  name: string;
  slug: string;
  version: string;
  type: string;
  runtime: string;
  systemPrompt: string;
  model: { provider: string; model: string; baseUrl?: string };
  defaultTools: Array<{ kind: string; ref: string }>;
  source: string;
  description: string;
  iconEmoji: string;
  /** 父 agent ID（仅 type='sub' 时有值），用于 UI 展示主子 agent 分组 */
  parentAgentId?: string;
  /** 默认 MCP server 引用（Layer 1 能力），与 electron 端 McpRef 对齐 */
  defaultMcps?: Array<{ kind: 'mcp'; ref: string; versionRange?: string }>;
  /** 默认 Skill 引用（Layer 1 能力），与 electron 端 SkillRef 对齐 */
  defaultSkills?: Array<{ kind: 'skill'; ref: string; versionRange?: string }>;
}

export interface AgentAssignment {
  instanceId: string;
  workspaceId: string;
  agentDefinitionId: string;
  botMatrixUserId: string;
  enabled: boolean;
  createdAt: string;
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
  llmApiKey: string;
}

/**
 * agent:assignMain 入参 — 安装 main agent 时自动跟随注册其全部 sub agent。
 * mainDefId 指向 type='main' 的定义；该 main 名下所有 parentAgentId 指向它的
 * sub 定义会被一并安装。
 */
export interface AssignMainInput {
  workspaceId: string;
  mainDefId: string;
  llmApiKey: string;
  /** 要安装的子 agent 定义 ID 列表；undefined = 全部安装 */
  selectedSubDefIds?: string[];
}

export interface ImMessage {
  eventId: string;
  roomId: string;
  sender: string;
  body: string;
  /** Matrix event type，普通消息为 'm.room.message'，自定义消息为 'io.momo-studio.dispatch' / 'io.momo-studio.task_reply' */
  eventType: string;
  /** 原始 event content，自定义消息卡片从中读取结构化字段 */
  content: Record<string, unknown>;
  timestamp: number;
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

export interface ApiSurface {
  auth: {
    register(opts: { username: string; password: string }): Promise<AuthResult>;
    login(opts: { username: string; password: string }): Promise<AuthResult>;
    getCurrentUser(): Promise<AuthResult | null>;
    logout(): Promise<void>;
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
    /** 一键编排：注册 bot + 分配 + 邀请进团队群 + 存 API key + 启动 runtime */
    addToWorkspace(input: AddToWorkspaceInput): Promise<AgentAssignment>;
    /**
     * 安装 main agent 并自动跟随注册其全部 sub agent（每个 agent 执行与
     * addToWorkspace 等价的全套编排）。返回全部新建 assignment（首条为 main）。
     */
    assignMain(input: AssignMainInput): Promise<AgentAssignment[]>;
    createFromYaml(yaml: string): Promise<AgentDefinition>;
    createCustom(input: {
      name: string;
      slug: string;
      description: string;
      systemPrompt: string;
      modelProvider: string;
      modelName: string;
      modelBaseUrl?: string;
      iconEmoji?: string;
      type?: 'standalone' | 'main' | 'sub';
      parentAgentId?: string;
    }): Promise<AgentDefinition>;
    list(): Promise<AgentDefinition[]>;
    assign(workspaceId: string, defId: string, botUserId: string): Promise<AgentAssignment>;
    listAssignments(workspaceId: string): Promise<AgentAssignment[]>;
    /** 重启已分配 agent（API key 从 keychain 恢复） */
    start(opts: StartAgentInput): Promise<{ instanceId: string }>;
    stop(instanceId: string): Promise<{ ok: boolean }>;
    removeAssignment(instanceId: string): Promise<{ ok: boolean }>;
    isRunning(instanceId: string): Promise<boolean>;
    updateDefinition(input: {
      id: string;
      name?: string;
      description?: string;
      systemPrompt?: string;
      modelProvider?: string;
      modelName?: string;
      modelBaseUrl?: string;
      iconEmoji?: string;
      type?: 'standalone' | 'main' | 'sub';
      parentAgentId?: string;
    }): Promise<{ definition: AgentDefinition; stoppedInstanceIds: string[] }>;
    updateApiKey(instanceId: string, apiKey: string): Promise<{ ok: boolean }>;
    onRuntimeChanged(callback: () => void): () => void;
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
    getRooms(): Promise<ImRoomInfo[]>;
    getMessages(roomId: string): Promise<ImMessage[]>;
    createRoom(input: { name: string; isDirect: boolean; inviteUserIds: string[] }): Promise<{ roomId: string }>;
    renameRoom(roomId: string, name: string): Promise<{ ok: boolean }>;
    dissolveRoom(roomId: string): Promise<{ dissolved: boolean }>;
    getMembers(roomId: string): Promise<RoomMember[]>;
    onMessage(callback: (msg: ImMessage) => void): () => void;
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
  marketplace: {
    /** 获取 catalog（远程优先，失败回退本地内置） */
    getCatalog(catalogUrl?: string): Promise<MarketplaceCatalog>;
    /** 关键词 + 类型搜索 catalog（关键词命中 name/description/slug/tags） */
    search(query: string, type?: 'agent' | 'mcp' | 'skill'): Promise<MarketplaceItem[]>;
    /** 安装一个 marketplace 包（返回缓存目录路径） */
    install(item: MarketplaceItem): Promise<{ cachePath: string }>;
    /** 列出全部已安装包（最新优先） */
    listInstalled(): Promise<InstalledPackage[]>;
    /** 卸载一个包（按 itemId） */
    uninstall(itemId: string): Promise<void>;
  };
}

export interface DirEntry {
  name: string;
  isDirectory: boolean;
  size: number;
}
