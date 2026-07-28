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
  timestamp: number;
}

export interface ImRoomInfo {
  roomId: string;
  name: string;
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
}

export interface DirEntry {
  name: string;
  isDirectory: boolean;
  size: number;
}
