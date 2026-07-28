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
}