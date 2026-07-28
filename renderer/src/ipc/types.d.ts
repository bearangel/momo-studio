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
  model: { provider: string; model: string };
  defaultTools: Array<{ kind: string; ref: string }>;
  source: string;
  description: string;
  iconEmoji: string;
  /** 父 agent ID（仅 type='sub' 时有值），用于 UI 展示主子 agent 分组 */
  parentAgentId?: string;
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
}

export interface ImMessage {
  eventId: string;
  roomId: string;
  sender: string;
  body: string;
  /** Matrix event type，普通消息为 'm.room.message'，自定义消息为 'io.agentplatform.dispatch' / 'io.agentplatform.task_reply' */
  eventType: string;
  /** 原始 event content，自定义消息卡片从中读取结构化字段 */
  content: Record<string, unknown>;
  timestamp: number;
}

export interface ImRoomInfo {
  roomId: string;
  name: string;
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
  };
  file: {
    read(workspaceId: string, filePath: string): Promise<string>;
    write(workspaceId: string, filePath: string, content: string): Promise<void>;
    list(workspaceId: string, dirPath: string): Promise<DirEntry[]>;
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
    list(): Promise<AgentDefinition[]>;
    assign(workspaceId: string, defId: string, botUserId: string): Promise<AgentAssignment>;
    listAssignments(workspaceId: string): Promise<AgentAssignment[]>;
    /** 重启已分配 agent（API key 从 keychain 恢复） */
    start(opts: StartAgentInput): Promise<{ instanceId: string }>;
    stop(instanceId: string): Promise<{ ok: boolean }>;
    isRunning(instanceId: string): Promise<boolean>;
  };
  im: {
    startSync(): Promise<void>;
    send(roomId: string, body: string): Promise<void>;
    getRooms(): Promise<ImRoomInfo[]>;
    getMessages(roomId: string): Promise<ImMessage[]>;
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
}

export interface DirEntry {
  name: string;
  isDirectory: boolean;
  size: number;
}
