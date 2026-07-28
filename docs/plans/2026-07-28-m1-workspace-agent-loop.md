# AgentPlatform M1 — Workspace + 单 Agent 闭环 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**目标：** 用户能创建 workspace、分配 agent、通过 IM 与 agent 聊天、看到 agent 读写 workspace 文件。

**架构：** 在 M0 基础上（Electron + Conduwuit + Matrix auth + IPC + 主界面壳）增加：Workspace 管理（SQLite + 目录映射 + git init）、文件浏览器 + Monaco 编辑器、Agent 定义（YAML manifest）+ declarative runtime（子进程 + LLM + 内置工具）、基础 IM（团队群 + 消息收发 + @mention）。

**技术栈新增：** `@monaco-editor/react`（编辑器）、`js-yaml`（YAML 解析）、`simple-git`（Git 操作）。LLM 调用直接 `fetch()` 到 OpenAI/Anthropic REST API，不用 SDK。

## 全局约束

继承 M0 全部约束，新增：

- **所有代码注释用中文**（AGENTS.md 语言要求）。代码标识符保持英文。
- **Agent runtime 仅 declarative**（M1 不做 programmatic/external）。
- **沙箱仅应用层**（WorkspaceFS path 检查）。OS 级沙箱（namespace/sandbox-exec）推迟到 M3。
- **LLM 仅支持 OpenAI + Anthropic**（M1 不做 Ollama/Google）。
- **IM 仅团队群 + 基础消息**（M1 不做 dispatch/tool_result 自定义消息类型，那是 M2）。
- **matrix-js-sdk 保持 ^31**（不升级到 v34 ESM）。
- **工作目录** `/workspace`，分支 `main`（M1 直接在 main 上做，或切 `feat/m1` 分支）。

## Spike 决策

- **Monaco 编辑器**：用 `@monaco-editor/react`（官方 React 包装，通过 CDN 加载 Monaco 核心，不需本地打包）。
- **YAML 解析**：用 `js-yaml` + `@types/js-yaml`。
- **Git 操作**：用 `simple-git`（纯 JS，无 native binding）。
- **LLM API**：直接 `fetch()` 调 OpenAI `/v1/chat/completions` 和 Anthropic `/v1/messages`。不引入 openai/anthropic SDK。
- **文件树虚拟化**：M1 不做 virtualized（workspace 文件量 <1000 时性能可接受）。用递归组件渲染。

## 文件结构（新增文件）

```
electron/src/main/
├── workspace/
│   ├── types.ts                 # Workspace 接口定义
│   ├── crud.ts                  # create/list/get/delete workspace
│   ├── git.ts                   # git init + 工具函数
│   └── ipc.handlers.ts          # workspace:* IPC handlers
├── files/
│   ├── workspace-fs.ts          # WorkspaceFS（path 沙箱检查）
│   └── ipc.handlers.ts          # file:read / file:write / file:list
├── agent/
│   ├── types.ts                 # AgentDefinition, AgentAssignment
│   ├── manifest-parser.ts       # YAML 解析 + schema 校验
│   ├── crud.ts                  # agent definition CRUD
│   ├── builtin-tools.ts         # workspace.read_file / write_file / list_files
│   ├── runtime.ts               # AgentRuntime（子进程内运行）
│   ├── runtime-manager.ts       # 主进程管理子进程生命周期
│   ├── llm-provider.ts          # LLMProvider 接口 + OpenAI/Anthropic 实现
│   └── ipc.handlers.ts          # agent:* IPC handlers
├── matrix/
│   └── rooms.ts                 # Space + team room 创建
├── storage/migrations/
│   └── index.ts                 # 更新：加 002 + 003 迁移
└── ipc/
    └── index.ts                 # 更新：注册新 handlers

electron/tests/
├── workspace/
│   ├── crud.test.ts
│   └── git.test.ts
├── files/
│   └── workspace-fs.test.ts
├── agent/
│   ├── manifest-parser.test.ts
│   ├── builtin-tools.test.ts
│   └── llm-provider.test.ts
└── matrix/
    └── rooms.test.ts

renderer/src/
├── components/
│   ├── workspace/
│   │   ├── WorkspaceSwitcher.tsx    # 左栏顶部 workspace 切换器
│   │   └── CreateWorkspaceDialog.tsx
│   ├── files/
│   │   ├── FileTree.tsx             # 递归文件树
│   │   └── FileTreeView.tsx         # 单个树节点
│   ├── editor/
│   │   └── CodeEditor.tsx           # Monaco 包装
│   ├── im/
│   │   ├── RoomList.tsx             # 房间列表
│   │   ├── MessageList.tsx          # 消息流
│   │   ├── MessageBubble.tsx        # 单条消息
│   │   └── MessageInput.tsx         # 输入框
│   └── agent/
│       ├── AgentList.tsx            # workspace 内 agent 列表
│       └── AddAgentDialog.tsx       # 添加 agent 到 workspace
├── stores/
│   ├── workspace.store.ts
│   ├── file.store.ts
│   ├── im.store.ts
│   └── agent.store.ts
├── ipc/
│   └── types.ts                     # 更新：扩展 ApiSurface
└── routes/
    └── MainShell.tsx                # 更新：接入实际视图
```

## 任务依赖图

```
T1 (workspace 迁移) ──► T2 (workspace CRUD) ──► T3 (workspace IPC) ──► T4 (workspace UI)
                                                                                    │
T5 (WorkspaceFS) ──► T6 (file IPC) ─────────────────────────────────────────► T7 (file tree UI)
                                                                                    │
                                                                              T8 (Monaco 编辑器)
                                                                                    │
T9 (agent types + parser) ──► T10 (agent 存储) ──► T11 (LLM provider)              │
                                                        │                          │
T12 (matrix rooms) ──► T13 (agent bot 注册 IPC)          │                        │
                            │                           │                        │
                            └──► T14 (agent runtime) ◄──┘                        │
                                      │                                            │
                                T15 (agent chat loop)                              │
                                      │                                            │
T16 (IM store + sync) ──► T17 (IM 渲染) ──► T18 (IM 输入)                         │
                                      │                                            │
                                T19 (demo agents)                                  │
                                      │                                            │
                                T20 (agent UI + 集成) ◄────────────────────────────┘
```

---

## Task 1: Workspace 数据模型 + SQLite 迁移

**文件：**
- 修改: `electron/src/main/storage/migrations/index.ts`（添加 002 迁移）
- 创建: `electron/src/main/workspace/types.ts`
- 测试: `electron/tests/workspace/types.test.ts`

**接口：**
- 产出: `Workspace` 接口、`workspace_members` 和 `workspaces` 表

- [ ] **Step 1: 创建 `workspace/types.ts`**

```typescript
// electron/src/main/workspace/types.ts

/** Workspace 实体 — 对应一个工作空间 + Matrix Space + Git 仓库 */
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

/** 创建 workspace 时的输入 */
export interface CreateWorkspaceInput {
  name: string;
  description?: string;
  directoryPath: string;
  iconEmoji?: string;
}
```

- [ ] **Step 2: 添加 002 迁移到 `migrations/index.ts`**

在 `MIGRATIONS` 数组末尾添加：

```typescript
  {
    version: 2,
    sql: `
CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  directory_path TEXT NOT NULL,
  matrix_space_id TEXT NOT NULL,
  git_initialized INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  owner_id TEXT NOT NULL,
  icon_emoji TEXT NOT NULL DEFAULT '📁'
);

CREATE TABLE IF NOT EXISTS workspace_members (
  workspace_id TEXT NOT NULL,
  matrix_user_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'owner',
  added_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (workspace_id, matrix_user_id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);
`.trim(),
  },
```

- [ ] **Step 3: 写测试**

```typescript
// electron/tests/workspace/types.test.ts
import { describe, it, expect } from 'vitest';
import type { Workspace, CreateWorkspaceInput } from '../../src/main/workspace/types';

describe('workspace/types', () => {
  it('Workspace 接口包含所有必需字段', () => {
    const ws: Workspace = {
      id: 'test-id',
      name: '测试工作空间',
      description: '',
      directoryPath: '/tmp/test',
      matrixSpaceId: '!space:localhost',
      gitInitialized: false,
      createdAt: '2026-01-01T00:00:00Z',
      ownerId: '@alice:localhost',
      iconEmoji: '📁',
    };
    expect(ws.id).toBe('test-id');
    expect(ws.name).toBe('测试工作空间');
  });

  it('CreateWorkspaceInput 只需 name + directoryPath', () => {
    const input: CreateWorkspaceInput = {
      name: '新项目',
      directoryPath: '/tmp/new-project',
    };
    expect(input.name).toBe('新项目');
    expect(input.description).toBeUndefined();
  });
});
```

- [ ] **Step 4: 运行测试 + 提交**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/workspace/types.test.ts
# 期望: 2 passed
npx pnpm@9.0.0 test  # 全套
git add electron/src/main/workspace/types.ts electron/src/main/storage/migrations/index.ts electron/tests/workspace/types.test.ts
git commit -m "feat(workspace): 添加 workspace 数据模型 + 002 迁移"
```

---

## Task 2: Workspace CRUD + git init

**文件：**
- 创建: `electron/src/main/workspace/crud.ts`
- 创建: `electron/src/main/workspace/git.ts`
- 测试: `electron/tests/workspace/crud.test.ts`

**接口：**
- 消费: `Workspace`, `CreateWorkspaceInput` (T1)、`getDb()` (M0)、`resolveUserDataDir()` (M0)
- 产出:
  - `createWorkspace(input, ownerUserId): Promise<Workspace>`
  - `listWorkspaces(): Workspace[]`
  - `getWorkspace(id): Workspace | null`
  - `deleteWorkspace(id): void`
  - `initGitRepo(dir): Promise<void>`

- [ ] **Step 1: 安装 simple-git**

```bash
cd electron && npx pnpm@9.0.0 add simple-git && npx pnpm@9.0.0 add -D @types/simple-git
```

- [ ] **Step 2: 实现 `workspace/git.ts`**

```typescript
// electron/src/main/workspace/git.ts
import simpleGit from 'simple-git';
import { logger } from '../logger';

/** 在指定目录初始化 git 仓库 */
export async function initGitRepo(directoryPath: string): Promise<void> {
  const git = simpleGit(directoryPath);
  await git.init();
  await git.addConfig('user.name', 'AgentPlatform');
  await git.addConfig('user.email', 'agentplatform@localhost');
  // 创建初始 commit 以确保 main 分支存在
  await git.commit('init: workspace 初始化', [], { '--allow-empty': null });
  logger.info('Git 仓库已初始化', { directoryPath });
}
```

- [ ] **Step 3: 实现 `workspace/crud.ts`**

```typescript
// electron/src/main/workspace/crud.ts
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getDb } from '../storage/db';
import { logger } from '../logger';
import type { Workspace, CreateWorkspaceInput } from './types';
import { initGitRepo } from './git';

interface WorkspaceRow {
  id: string;
  name: string;
  description: string;
  directory_path: string;
  matrix_space_id: string;
  git_initialized: number;
  created_at: string;
  owner_id: string;
  icon_emoji: string;
}

function rowToWorkspace(row: WorkspaceRow): Workspace {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    directoryPath: row.directory_path,
    matrixSpaceId: row.matrix_space_id,
    gitInitialized: row.git_initialized === 1,
    createdAt: row.created_at,
    ownerId: row.owner_id,
    iconEmoji: row.icon_emoji,
  };
}

export async function createWorkspace(
  input: CreateWorkspaceInput,
  ownerUserId: string,
  matrixSpaceId: string,
): Promise<Workspace> {
  const id = randomUUID();
  const dir = path.resolve(input.directoryPath);

  // 创建目录（如果不存在）
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // git init
  let gitInitialized = false;
  try {
    await initGitRepo(dir);
    gitInitialized = true;
  } catch (err) {
    logger.warn('Git 初始化失败，继续创建 workspace', { error: (err as Error).message });
  }

  const db = getDb();
  db.prepare(
    `INSERT INTO workspaces (id, name, description, directory_path, matrix_space_id, git_initialized, owner_id, icon_emoji)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.name,
    input.description ?? '',
    dir,
    matrixSpaceId,
    gitInitialized ? 1 : 0,
    ownerUserId,
    input.iconEmoji ?? '📁',
  );

  // 添加 owner 为成员
  db.prepare(
    `INSERT INTO workspace_members (workspace_id, matrix_user_id, role) VALUES (?, ?, 'owner')`,
  ).run(id, ownerUserId);

  const row = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id) as WorkspaceRow;
  logger.info('Workspace 已创建', { id, name: input.name, dir });
  return rowToWorkspace(row);
}

export function listWorkspaces(): Workspace[] {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM workspaces ORDER BY created_at DESC').all() as WorkspaceRow[];
  return rows.map(rowToWorkspace);
}

export function getWorkspace(id: string): Workspace | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id) as WorkspaceRow | undefined;
  return row ? rowToWorkspace(row) : null;
}

export function deleteWorkspace(id: string): void {
  const db = getDb();
  db.prepare('DELETE FROM workspaces WHERE id = ?').run(id);
  logger.info('Workspace 已删除', { id });
}
```

- [ ] **Step 4: 写测试**

```typescript
// electron/tests/workspace/crud.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createWorkspace, listWorkspaces, getWorkspace, deleteWorkspace } from '../../src/main/workspace/crud';
import { runMigrations, closeDb } from '../../src/main/storage/db';

const tmpRoot = path.join(os.tmpdir(), `ap-ws-test-${Date.now()}`);

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

describe('workspace/crud', () => {
  it('createWorkspace 创建目录 + git + SQLite 记录', async () => {
    const wsDir = path.join(tmpRoot, 'my-project');
    const ws = await createWorkspace(
      { name: '测试项目', directoryPath: wsDir },
      '@alice:localhost',
      '!space:localhost',
    );
    expect(ws.name).toBe('测试项目');
    expect(ws.directoryPath).toBe(wsDir);
    expect(fs.existsSync(wsDir)).toBe(true);
    expect(fs.existsSync(path.join(wsDir, '.git'))).toBe(true);
    expect(ws.gitInitialized).toBe(true);
  });

  it('listWorkspaces 返回所有 workspace', async () => {
    await createWorkspace({ name: 'A', directoryPath: path.join(tmpRoot, 'a') }, '@alice:localhost', '!s1:localhost');
    await createWorkspace({ name: 'B', directoryPath: path.join(tmpRoot, 'b') }, '@alice:localhost', '!s2:localhost');
    const list = listWorkspaces();
    expect(list).toHaveLength(2);
    expect(list.map((w) => w.name)).toContain('A');
    expect(list.map((w) => w.name)).toContain('B');
  });

  it('getWorkspace 按 id 查询', async () => {
    const ws = await createWorkspace({ name: 'X', directoryPath: path.join(tmpRoot, 'x') }, '@alice:localhost', '!s:localhost');
    const found = getWorkspace(ws.id);
    expect(found?.name).toBe('X');
    expect(getWorkspace('nonexistent')).toBeNull();
  });

  it('deleteWorkspace 删除记录', async () => {
    const ws = await createWorkspace({ name: 'Y', directoryPath: path.join(tmpRoot, 'y') }, '@alice:localhost', '!s:localhost');
    deleteWorkspace(ws.id);
    expect(getWorkspace(ws.id)).toBeNull();
  });
});
```

- [ ] **Step 5: 运行测试 + 提交**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/workspace/crud.test.ts
# 期望: 4 passed
npx pnpm@9.0.0 test
npx pnpm@9.0.0 typecheck
git add electron/src/main/workspace/ electron/tests/workspace/
git commit -m "feat(workspace): workspace CRUD + git init"
```

---

## Task 3: Workspace IPC handlers

**文件：**
- 创建: `electron/src/main/workspace/ipc.handlers.ts`
- 创建: `electron/src/main/matrix/rooms.ts`
- 修改: `electron/src/main/ipc/index.ts`
- 修改: `renderer/src/ipc/types.ts`（扩展 ApiSurface）

**接口：**
- 消费: T2 的 CRUD 函数
- 产出: IPC handlers `workspace:create`, `workspace:list`, `workspace:get`, `workspace:delete`；`createMatrixSpace()` 工具函数

- [ ] **Step 1: 实现 `matrix/rooms.ts`**

```typescript
// electron/src/main/matrix/rooms.ts
import type { MatrixClient } from 'matrix-js-sdk';
import { logger } from '../logger';

/** 创建 Matrix Space（一种特殊的 room，type = m.space） */
export async function createMatrixSpace(
  client: MatrixClient,
  name: string,
): Promise<string> {
  const response: unknown = await client.createRoom({
    name,
    preset: 'private_chat',
    visibility: 'private',
    creation_content: { type: 'm.space' },
    invite: [],
  });
  const roomId = (response as { room_id: string }).room_id;
  logger.info('Matrix Space 已创建', { name, roomId });
  return roomId;
}

/** 创建普通 room 并加入指定 Space */
export async function createRoomInSpace(
  client: MatrixClient,
  spaceId: string,
  name: string,
): Promise<string> {
  const response: unknown = await client.createRoom({
    name,
    preset: 'private_chat',
    visibility: 'private',
    invite: [],
  });
  const roomId = (response as { room_id: string }).room_id;

  // 把 room 加入 Space（发 m.space.child event）
  await client.sendStateEvent(spaceId, 'm.space.child', roomId, {
    via: [client.getDomain() ?? 'localhost'],
  });
  logger.info('Room 已创建并加入 Space', { name, roomId, spaceId });
  return roomId;
}
```

- [ ] **Step 2: 实现 `workspace/ipc.handlers.ts`**

```typescript
// electron/src/main/workspace/ipc.handlers.ts
import { ipcMain } from 'electron';
import { logger } from '../logger';
import { createWorkspace, listWorkspaces, getWorkspace, deleteWorkspace } from './crud';
import { createMatrixSpace } from '../matrix/rooms';
import { getDb } from '../storage/db';
import type { CreateWorkspaceInput } from './types';

function getCurrentUserId(): string | null {
  const db = getDb();
  const row = db.prepare('SELECT value FROM kv_store WHERE key = ?').get('current_user_session') as
    | { value: string }
    | undefined;
  if (!row) return null;
  const parsed = JSON.parse(row.value) as { userId: string };
  return parsed.userId;
}

/** 获取已登录用户的 Matrix client（从 keychain 恢复 token） */
async function getMatrixClient(): Promise<import('matrix-js-sdk').MatrixClient> {
  const { createMatrixClient } = await import('../matrix/client');
  const { getCurrentUserFlow, type AuthDeps } = await import('../ipc/authFlows');

  const deps: AuthDeps = {
    startConduit: async () => ({ port: 8008, baseUrl: 'http://127.0.0.1:8008' }),
    createMatrixClient,
    setSecret: async (k, v) => (await import('../storage/keychain')).setSecret(k, v),
    getSecret: async (k) => (await import('../storage/keychain')).getSecret(k),
    deleteSecret: async (k) => (await import('../storage/keychain')).deleteSecret(k),
    dbRun: (sql, ...params) => getDb().prepare(sql).run(...params),
    dbGet: <T>(sql: string, ...params: unknown[]): T | undefined =>
      getDb().prepare(sql).get(...params) as T | undefined,
  };

  const session = await getCurrentUserFlow(deps);
  if (!session) throw new Error('未登录');

  const token = await deps.getSecret(`user.${session.userId}.matrix_token`);
  if (!token) throw new Error('Matrix token 丢失');

  return createMatrixClient({
    baseUrl: 'http://127.0.0.1:8008',
    userId: session.userId,
    accessToken: token,
  });
}

export function registerWorkspaceHandlers(): void {
  ipcMain.handle('workspace:create', async (_evt, input: CreateWorkspaceInput) => {
    const userId = getCurrentUserId();
    if (!userId) throw new Error('未登录，无法创建 workspace');

    const client = await getMatrixClient();
    const spaceId = await createMatrixSpace(client, input.name);

    return createWorkspace(input, userId, spaceId);
  });

  ipcMain.handle('workspace:list', async () => {
    return listWorkspaces();
  });

  ipcMain.handle('workspace:get', async (_evt, id: string) => {
    return getWorkspace(id);
  });

  ipcMain.handle('workspace:delete', async (_evt, id: string) => {
    deleteWorkspace(id);
    return;
  });

  logger.info('Workspace IPC handlers 已注册');
}
```

- [ ] **Step 3: 更新 `ipc/index.ts` 注册新 handlers**

在 `registerIpcHandlers()` 中添加：

```typescript
import { registerWorkspaceHandlers } from '../workspace/ipc.handlers';

export function registerIpcHandlers(): void {
  // ... 已有 handlers ...
  registerWorkspaceHandlers();
}
```

- [ ] **Step 4: 更新 renderer `ipc/types.ts`**

在 `ApiSurface` 接口中添加 `workspace` 命名空间：

```typescript
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
  auth: { /* ... 已有 ... */ };
  system: { /* ... 已有 ... */ };
  workspace: {
    create(input: CreateWorkspaceInput): Promise<Workspace>;
    list(): Promise<Workspace[]>;
    get(id: string): Promise<Workspace | null>;
    delete(id: string): Promise<void>;
  };
}
```

- [ ] **Step 5: 更新 preload `index.ts`**

在 `api` 对象中添加：

```typescript
workspace: {
  create: (input) => invoke('workspace:create', input),
  list: () => invoke('workspace:list'),
  get: (id) => invoke('workspace:get', id),
  delete: (id) => invoke('workspace:delete', id),
},
```

- [ ] **Step 6: 提交**

```bash
npx pnpm@9.0.0 typecheck
git add electron/src/main/workspace/ipc.handlers.ts electron/src/main/matrix/rooms.ts \
        electron/src/main/ipc/index.ts electron/src/preload/index.ts \
        renderer/src/ipc/types.ts
git commit -m "feat(workspace): IPC handlers + Matrix Space 创建"
```

---

## Task 4: Workspace UI（store + 创建对话框 + 列表 + 切换器）

**文件：**
- 创建: `renderer/src/stores/workspace.store.ts`
- 创建: `renderer/src/components/workspace/WorkspaceSwitcher.tsx`
- 创建: `renderer/src/components/workspace/CreateWorkspaceDialog.tsx`
- 修改: `renderer/src/components/layout/LeftRail.tsx`（顶部加 workspace 切换器）

**接口：**
- 消费: T3 的 IPC API
- 产出: 用户能在 UI 中创建 + 切换 workspace

- [ ] **Step 1: 实现 `workspace.store.ts`**

```typescript
// renderer/src/stores/workspace.store.ts
import { create } from 'zustand';
import { ipc } from '../ipc/client';
import type { Workspace, CreateWorkspaceInput } from '../ipc/types';

interface WorkspaceState {
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
  loading: boolean;
  error: string | null;

  load: () => Promise<void>;
  create: (input: CreateWorkspaceInput) => Promise<void>;
  select: (id: string) => void;
  getActive: () => Workspace | null;
}

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  workspaces: [],
  activeWorkspaceId: null,
  loading: false,
  error: null,

  load: async () => {
    set({ loading: true, error: null });
    try {
      const list = await ipc.workspace.list();
      const activeId = list.length > 0 ? list[0]!.id : null;
      set({ workspaces: list, activeWorkspaceId: activeId, loading: false });
    } catch (err) {
      set({ loading: false, error: (err as Error).message });
    }
  },

  create: async (input) => {
    const ws = await ipc.workspace.create(input);
    set((state) => ({
      workspaces: [ws, ...state.workspaces],
      activeWorkspaceId: ws.id,
    }));
  },

  select: (id) => set({ activeWorkspaceId: id }),

  getActive: () => {
    const { workspaces, activeWorkspaceId } = get();
    return workspaces.find((w) => w.id === activeWorkspaceId) ?? null;
  },
}));
```

- [ ] **Step 2: 实现 `WorkspaceSwitcher.tsx`**

```tsx
// renderer/src/components/workspace/WorkspaceSwitcher.tsx
import { useEffect, useState } from 'react';
import { useWorkspaceStore } from '../../stores/workspace.store';
import { CreateWorkspaceDialog } from './CreateWorkspaceDialog';
import { cn } from '../../lib/cn';

export function WorkspaceSwitcher() {
  const { workspaces, activeWorkspaceId, load, select } = useWorkspaceStore();
  const [showCreate, setShowCreate] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    void load();
  }, [load]);

  const active = workspaces.find((w) => w.id === activeWorkspaceId);

  return (
    <>
      <button
        onClick={() => setOpen(!open)}
        className="w-10 h-10 flex items-center justify-center rounded-md text-lg hover:bg-bg-tertiary"
        title={active?.name ?? '选择 workspace'}
      >
        {active?.iconEmoji ?? '📁'}
      </button>

      {open && (
        <div className="absolute left-14 top-2 bg-bg-secondary border border-border-subtle rounded-lg shadow-xl py-1 min-w-[200px] z-50">
          {workspaces.map((ws) => (
            <button
              key={ws.id}
              onClick={() => {
                select(ws.id);
                setOpen(false);
              }}
              className={cn(
                'w-full text-left px-3 py-2 text-sm hover:bg-bg-tertiary flex items-center gap-2',
                ws.id === activeWorkspaceId && 'bg-accent-blue/20',
              )}
            >
              <span>{ws.iconEmoji}</span>
              <span className="truncate">{ws.name}</span>
            </button>
          ))}
          <div className="border-t border-border-subtle mt-1 pt-1">
            <button
              onClick={() => {
                setShowCreate(true);
                setOpen(false);
              }}
              className="w-full text-left px-3 py-2 text-sm text-accent-blue hover:bg-bg-tertiary"
            >
              + 新建 workspace
            </button>
          </div>
        </div>
      )}

      {showCreate && <CreateWorkspaceDialog onClose={() => setShowCreate(false)} />}
    </>
  );
}
```

- [ ] **Step 3: 实现 `CreateWorkspaceDialog.tsx`**

```tsx
// renderer/src/components/workspace/CreateWorkspaceDialog.tsx
import { useState } from 'react';
import { useWorkspaceStore } from '../../stores/workspace.store';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';

interface Props {
  onClose: () => void;
}

export function CreateWorkspaceDialog({ onClose }: Props) {
  const { create } = useWorkspaceStore();
  const [name, setName] = useState('');
  const [dir, setDir] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !dir.trim()) {
      setError('名称和目录不能为空');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      await create({ name: name.trim(), directoryPath: dir.trim() });
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <form
        onClick={(e) => e.stopPropagation()}
        onSubmit={handleSubmit}
        className="bg-bg-secondary rounded-xl border border-border-subtle p-6 w-full max-w-md"
      >
        <h2 className="text-xl font-bold mb-4">新建 workspace</h2>
        <div className="flex flex-col gap-3">
          <Input label="名称" value={name} onChange={(e) => setName(e.target.value)} placeholder="我的项目" />
          <Input label="目录路径" value={dir} onChange={(e) => setDir(e.target.value)} placeholder="~/projects/my-app" />
          {error && <div className="text-red-400 text-sm">{error}</div>}
          <div className="flex gap-2 justify-end mt-2">
            <Button variant="ghost" type="button" onClick={onClose}>取消</Button>
            <Button type="submit" disabled={loading || !name || !dir}>
              {loading ? '创建中…' : '创建'}
            </Button>
          </div>
        </div>
      </form>
    </div>
  );
}
```

- [ ] **Step 4: 更新 `LeftRail.tsx`（加 WorkspaceSwitcher）**

在 LeftRail 组件顶部添加 `<WorkspaceSwitcher />`：

```tsx
// 在 LeftRail.tsx 的 return 的最外层 div 内，NAV_ITEMS 之前添加：
<div className="relative">
  <WorkspaceSwitcher />
</div>
<div className="w-8 h-px bg-border-subtle my-1" />
```

并在文件顶部添加 import：
```typescript
import { WorkspaceSwitcher } from '../workspace/WorkspaceSwitcher';
```

- [ ] **Step 5: 提交**

```bash
cd renderer && npx pnpm@9.0.0 typecheck
git add renderer/src/stores/workspace.store.ts renderer/src/components/workspace/ \
        renderer/src/components/layout/LeftRail.tsx
git commit -m "feat(workspace): workspace UI（store + 创建对话框 + 切换器）"
```

---

## Task 5: WorkspaceFS（应用层 path 沙箱）

**文件：**
- 创建: `electron/src/main/files/workspace-fs.ts`
- 测试: `electron/tests/files/workspace-fs.test.ts`

**接口：**
- 产出:
  - `WorkspaceFS` 类：`assertInWorkspace(path)`, `readFile(p)`, `writeFile(p, content)`, `listDir(p)`, `exists(p)`

- [ ] **Step 1: 写测试**

```typescript
// electron/tests/files/workspace-fs.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { WorkspaceFS } from '../../src/main/files/workspace-fs';

const tmpRoot = path.join(os.tmpdir(), `ap-fs-test-${Date.now()}`);
let wsFs: WorkspaceFS;

beforeEach(() => {
  fs.mkdirSync(path.join(tmpRoot, 'workspace'), { recursive: true });
  wsFs = new WorkspaceFS(path.join(tmpRoot, 'workspace'));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('files/workspace-fs', () => {
  it('assertInWorkspace 允许 workspace 内路径', () => {
    expect(() => wsFs.assertInWorkspace('src/main.ts')).not.toThrow();
    expect(() => wsFs.assertInWorkspace(path.join(wsFs['rootDir'], 'src/app.ts'))).not.toThrow();
  });

  it('assertInWorkspace 拒绝路径穿越', () => {
    expect(() => wsFs.assertInWorkspace('../../../etc/passwd')).toThrow();
    expect(() => wsFs.assertInWorkspace('../../secret')).toThrow();
  });

  it('assertInWorkspace 拒绝绝对路径在 workspace 外', () => {
    expect(() => wsFs.assertInWorkspace('/etc/passwd')).toThrow();
    expect(() => wsFs.assertInWorkspace(path.join(tmpRoot, 'outside'))).toThrow();
  });

  it('writeFile + readFile 往返', async () => {
    await wsFs.writeFile('test.txt', 'hello world');
    const content = await wsFs.readFile('test.txt');
    expect(content.toString()).toBe('hello world');
  });

  it('writeFile 拒绝写到 .git/', async () => {
    await expect(wsFs.writeFile('.git/config', 'evil')).rejects.toThrow();
  });

  it('listDir 返回文件和子目录', async () => {
    await wsFs.writeFile('a.txt', 'a');
    await wsFs.writeFile('b.txt', 'b');
    fs.mkdirSync(path.join(wsFs['rootDir'], 'subdir'), { recursive: true });
    const entries = await wsFs.listDir('.');
    expect(entries.map((e) => e.name).sort()).toEqual(['a.txt', 'b.txt', 'subdir']);
  });

  it('exists 检查文件存在', async () => {
    await wsFs.writeFile('exists.txt', 'yes');
    expect(await wsFs.exists('exists.txt')).toBe(true);
    expect(await wsFs.exists('no.txt')).toBe(false);
  });
});
```

- [ ] **Step 2: 实现 `workspace-fs.ts`**

```typescript
// electron/src/main/files/workspace-fs.ts
import fs from 'node:fs';
import path from 'node:path';

export interface DirEntry {
  name: string;
  isDirectory: boolean;
  size: number;
}

/**
 * 应用层文件系统沙箱。强制所有路径在 workspace 目录内。
 * 这是 OS 级沙箱（namespace / sandbox-exec）之外的应用层防线（M3 会加 OS 级）。
 */
export class WorkspaceFS {
  constructor(private rootDir: string) {
    this.rootDir = path.resolve(rootDir);
  }

  /** 验证路径在 workspace 内，返回绝对路径 */
  assertInWorkspace(relativeOrAbsolutePath: string): string {
    const abs = path.isAbsolute(relativeOrAbsolutePath)
      ? relativeOrAbsolutePath
      : path.join(this.rootDir, relativeOrAbsolutePath);

    const normalized = path.normalize(abs);
    const realRoot = fs.realpathSync(this.rootDir);

    // 解析符号链接
    let realPath: string;
    try {
      realPath = fs.realpathSync(normalized);
    } catch {
      // 文件不存在时，检查 normalized 路径
      realPath = path.realpathSync(path.dirname(normalized)) !== realRoot &&
        !path.dirname(normalized).startsWith(realRoot)
        ? normalized
        : normalized;
    }

    if (
      realPath !== realRoot &&
      !realPath.startsWith(realRoot + path.sep) &&
      !normalized.startsWith(realRoot + path.sep) &&
      normalized !== realRoot
    ) {
      throw new Error(`路径越界: ${relativeOrAbsolutePath} 不在 workspace 内`);
    }

    // 额外检查：不允许写 .git/
    const rel = path.relative(this.rootDir, normalized);
    if (rel.startsWith('.git') && rel !== '.gitignore') {
      throw new Error(`禁止操作 .git 目录: ${relativeOrAbsolutePath}`);
    }

    return normalized;
  }

  async readFile(relativePath: string): Promise<Buffer> {
    const abs = this.assertInWorkspace(relativePath);
    return fs.promises.readFile(abs);
  }

  async writeFile(relativePath: string, content: string | Buffer): Promise<void> {
    const abs = this.assertInWorkspace(relativePath);
    // 确保父目录存在
    const dir = path.dirname(abs);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    await fs.promises.writeFile(abs, content);
  }

  async listDir(relativePath: string): Promise<DirEntry[]> {
    const abs = this.assertInWorkspace(relativePath);
    const entries = await fs.promises.readdir(abs, { withFileTypes: true });
    return entries
      .filter((e) => !e.name.startsWith('.git'))
      .map((e) => {
        const fullPath = path.join(abs, e.name);
        const stat = fs.statSync(fullPath);
        return {
          name: e.name,
          isDirectory: e.isDirectory(),
          size: stat.size,
        };
      });
  }

  async exists(relativePath: string): Promise<boolean> {
    try {
      const abs = this.assertInWorkspace(relativePath);
      return fs.existsSync(abs);
    } catch {
      return false;
    }
  }
}
```

- [ ] **Step 3: 运行测试 + 提交**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/files/workspace-fs.test.ts
# 期望: 7 passed
git add electron/src/main/files/workspace-fs.ts electron/tests/files/workspace-fs.test.ts
git commit -m "feat(files): WorkspaceFS 应用层 path 沙箱"
```

---

## Task 6: 文件 IPC handlers

**文件：**
- 创建: `electron/src/main/files/ipc.handlers.ts`
- 修改: `electron/src/main/ipc/index.ts`
- 修改: `renderer/src/ipc/types.ts`

**接口：**
- 消费: `WorkspaceFS` (T5)、`getWorkspace()` (T2)
- 产出: IPC `file:read`, `file:write`, `file:list`

- [ ] **Step 1: 实现 `files/ipc.handlers.ts`**

```typescript
// electron/src/main/files/ipc.handlers.ts
import { ipcMain } from 'electron';
import { logger } from '../logger';
import { WorkspaceFS } from './workspace-fs';
import { getWorkspace } from '../workspace/crud';

// 缓存每个 workspace 的 WorkspaceFS 实例
const fsCache = new Map<string, WorkspaceFS>();

function getWorkspaceFs(workspaceId: string): WorkspaceFS {
  let wsFs = fsCache.get(workspaceId);
  if (!wsFs) {
    const ws = getWorkspace(workspaceId);
    if (!ws) throw new Error(`Workspace 不存在: ${workspaceId}`);
    wsFs = new WorkspaceFS(ws.directoryPath);
    fsCache.set(workspaceId, wsFs);
  }
  return wsFs;
}

export function registerFileHandlers(): void {
  ipcMain.handle('file:read', async (_evt, workspaceId: string, filePath: string) => {
    const wsFs = getWorkspaceFs(workspaceId);
    const buf = await wsFs.readFile(filePath);
    return buf.toString('utf-8');
  });

  ipcMain.handle(
    'file:write',
    async (_evt, workspaceId: string, filePath: string, content: string) => {
      const wsFs = getWorkspaceFs(workspaceId);
      await wsFs.writeFile(filePath, content);
      logger.info('文件已写入', { workspaceId, filePath });
    },
  );

  ipcMain.handle('file:list', async (_evt, workspaceId: string, dirPath: string) => {
    const wsFs = getWorkspaceFs(workspaceId);
    return wsFs.listDir(dirPath);
  });

  logger.info('File IPC handlers 已注册');
}
```

- [ ] **Step 2: 更新 `ipc/index.ts`、`preload/index.ts`、`renderer/ipc/types.ts`**

`ipc/index.ts`:
```typescript
import { registerFileHandlers } from '../files/ipc.handlers';
// 在 registerIpcHandlers() 中:
registerFileHandlers();
```

`renderer/ipc/types.ts` 添加到 `ApiSurface`:
```typescript
export interface DirEntry {
  name: string;
  isDirectory: boolean;
  size: number;
}

// 在 ApiSurface 接口中:
file: {
  read(workspaceId: string, filePath: string): Promise<string>;
  write(workspaceId: string, filePath: string, content: string): Promise<void>;
  list(workspaceId: string, dirPath: string): Promise<DirEntry[]>;
};
```

`preload/index.ts` 添加:
```typescript
file: {
  read: (wsId, path) => invoke('file:read', wsId, path),
  write: (wsId, path, content) => invoke('file:write', wsId, path, content),
  list: (wsId, dir) => invoke('file:list', wsId, dir),
},
```

- [ ] **Step 3: 提交**

```bash
npx pnpm@9.0.0 typecheck
git add electron/src/main/files/ipc.handlers.ts electron/src/main/ipc/index.ts \
        electron/src/preload/index.ts renderer/src/ipc/types.ts
git commit -m "feat(files): 文件读写 IPC handlers"
```

---

## Task 7: 文件树 UI 组件

**文件：**
- 创建: `renderer/src/stores/file.store.ts`
- 创建: `renderer/src/components/files/FileTreeView.tsx`
- 创建: `renderer/src/components/files/FileTree.tsx`
- 修改: `renderer/src/components/layout/MiddlePanel.tsx`（files 视图）

**接口：**
- 消费: T6 的 `file:list` IPC
- 产出: 文件浏览器中间面板，展开/折叠目录，点击文件发出 `onSelectFile` 回调

- [ ] **Step 1: 实现 `file.store.ts`**

```typescript
// renderer/src/stores/file.store.ts
import { create } from 'zustand';
import { ipc } from '../ipc/client';
import type { DirEntry } from '../ipc/types';

interface FileState {
  tree: Map<string, DirEntry[]>;
  expandedDirs: Set<string>;
  selectedFile: string | null;
  loadDir: (workspaceId: string, dirPath: string) => Promise<void>;
  toggleDir: (dirPath: string) => void;
  selectFile: (filePath: string) => void;
}

export const useFileStore = create<FileState>((set, get) => ({
  tree: new Map(),
  expandedDirs: new Set(['.']),
  selectedFile: null,

  loadDir: async (workspaceId, dirPath) => {
    const entries = await ipc.file.list(workspaceId, dirPath);
    set((state) => {
      const tree = new Map(state.tree);
      tree.set(dirPath, entries);
      return { tree };
    });
  },

  toggleDir: (dirPath) => {
    set((state) => {
      const expanded = new Set(state.expandedDirs);
      if (expanded.has(dirPath)) {
        expanded.delete(dirPath);
      } else {
        expanded.add(dirPath);
      }
      return { expandedDirs: expanded };
    });
  },

  selectFile: (filePath) => set({ selectedFile: filePath }),
}));
```

- [ ] **Step 2: 实现 `FileTreeView.tsx`**

```tsx
// renderer/src/components/files/FileTreeView.tsx
import { useEffect } from 'react';
import type { DirEntry } from '../../ipc/types';
import { useFileStore } from '../../stores/file.store';
import { useWorkspaceStore } from '../../stores/workspace.store';
import { cn } from '../../lib/cn';

interface Props {
  dirPath: string;
  depth: number;
  onSelectFile: (filePath: string) => void;
}

export function FileTreeView({ dirPath, depth, onSelectFile }: Props) {
  const { tree, expandedDirs, selectedFile, loadDir, toggleDir, selectFile } = useFileStore();
  const workspace = useWorkspaceStore((s) => s.getActive());

  const entries = tree.get(dirPath);
  const expanded = expandedDirs.has(dirPath);

  useEffect(() => {
    if (workspace && !entries) {
      void loadDir(workspace.id, dirPath);
    }
  }, [workspace, dirPath, entries, loadDir]);

  if (!entries) {
    return <div style={{ paddingLeft: depth * 16 }} className="text-neutral-500 text-sm">加载中…</div>;
  }

  return (
    <div>
      {entries.map((entry) => {
        const fullPath = dirPath === '.' ? entry.name : `${dirPath}/${entry.name}`;
        const isSelected = selectedFile === fullPath;

        if (entry.isDirectory) {
          return (
            <div key={fullPath}>
              <button
                onClick={() => toggleDir(fullPath)}
                className={cn(
                  'w-full text-left py-1 text-sm hover:bg-bg-tertiary flex items-center gap-1 rounded',
                )}
                style={{ paddingLeft: depth * 16 }}
              >
                <span className="text-xs">{expanded ? '▼' : '▶'}</span>
                <span>{expanded ? '📂' : '📁'}</span>
                <span className="truncate">{entry.name}</span>
              </button>
              {expanded && (
                <FileTreeView
                  dirPath={fullPath}
                  depth={depth + 1}
                  onSelectFile={onSelectFile}
                />
              )}
            </div>
          );
        }

        return (
          <button
            key={fullPath}
            onClick={() => {
              selectFile(fullPath);
              onSelectFile(fullPath);
            }}
            className={cn(
              'w-full text-left py-1 text-sm hover:bg-bg-tertiary flex items-center gap-1 rounded',
              isSelected && 'bg-accent-blue/20',
            )}
            style={{ paddingLeft: depth * 16 + 20 }}
          >
            <span>📄</span>
            <span className="truncate">{entry.name}</span>
          </button>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 3: 实现 `FileTree.tsx`（包装组件）**

```tsx
// renderer/src/components/files/FileTree.tsx
import { FileTreeView } from './FileTreeView';

interface Props {
  onSelectFile: (filePath: string) => void;
}

export function FileTree({ onSelectFile }: Props) {
  return (
    <div className="flex flex-col h-full overflow-auto">
      <FileTreeView dirPath="." depth={0} onSelectFile={onSelectFile} />
    </div>
  );
}
```

- [ ] **Step 4: 更新 `MiddlePanel.tsx` 渲染 files 视图**

在 MiddlePanel 的 `activeView === 'files'` 分支中渲染 FileTree + 传入文件选择回调。这部分在 Task 8（Monaco 编辑器）中完成，因为需要 editor 配合。

- [ ] **Step 5: 提交**

```bash
cd renderer && npx pnpm@9.0.0 typecheck
git add renderer/src/stores/file.store.ts renderer/src/components/files/
git commit -m "feat(files): 文件树 UI 组件（递归渲染 + 展开/折叠）"
```

---

## Task 8: Monaco 编辑器集成

**文件：**
- 安装: `@monaco-editor/react`
- 创建: `renderer/src/components/editor/CodeEditor.tsx`
- 创建: `renderer/src/stores/editor.store.ts`
- 修改: `renderer/src/components/layout/MiddlePanel.tsx`（files 视图完整实现）
- 修改: `renderer/src/components/layout/MainLayout.tsx`（右栏显示编辑器）

**接口：**
- 消费: T7 的 file store + onSelectFile
- 产出: 双击文件 → 编辑器打开；支持多 tab；保存（Ctrl+S → IPC file:write）

- [ ] **Step 1: 安装依赖**

```bash
cd renderer && npx pnpm@9.0.0 add @monaco-editor/react
```

- [ ] **Step 2: 实现 `editor.store.ts`**

```typescript
// renderer/src/stores/editor.store.ts
import { create } from 'zustand';

interface EditorTab {
  filePath: string;
  content: string;
  dirty: boolean;
}

interface EditorState {
  tabs: EditorTab[];
  activeTab: string | null;

  openFile: (filePath: string, content: string) => void;
  closeTab: (filePath: string) => void;
  updateContent: (filePath: string, content: string) => void;
  markSaved: (filePath: string) => void;
  setActive: (filePath: string) => void;
}

export const useEditorStore = create<EditorState>((set, get) => ({
  tabs: [],
  activeTab: null,

  openFile: (filePath, content) => {
    const existing = get().tabs.find((t) => t.filePath === filePath);
    if (existing) {
      set({ activeTab: filePath });
      return;
    }
    set((state) => ({
      tabs: [...state.tabs, { filePath, content, dirty: false }],
      activeTab: filePath,
    }));
  },

  closeTab: (filePath) => {
    set((state) => {
      const tabs = state.tabs.filter((t) => t.filePath !== filePath);
      const activeTab =
        state.activeTab === filePath ? (tabs.length > 0 ? tabs[tabs.length - 1]!.filePath : null) : state.activeTab;
      return { tabs, activeTab };
    });
  },

  updateContent: (filePath, content) => {
    set((state) => ({
      tabs: state.tabs.map((t) =>
        t.filePath === filePath ? { ...t, content, dirty: true } : t,
      ),
    }));
  },

  markSaved: (filePath) => {
    set((state) => ({
      tabs: state.tabs.map((t) => (t.filePath === filePath ? { ...t, dirty: false } : t)),
    }));
  },

  setActive: (filePath) => set({ activeTab: filePath }),
}));
```

- [ ] **Step 3: 实现 `CodeEditor.tsx`**

```tsx
// renderer/src/components/editor/CodeEditor.tsx
import { useCallback } from 'react';
import Editor from '@monaco-editor/react';
import { useEditorStore } from '../../stores/editor.store';
import { useWorkspaceStore } from '../../stores/workspace.store';
import { ipc } from '../../ipc/client';
import { cn } from '../../lib/cn';

export function CodeEditor() {
  const { tabs, activeTab, updateContent, markSaved, setActive, closeTab } = useEditorStore();
  const workspace = useWorkspaceStore((s) => s.getActive());
  const activeTabData = tabs.find((t) => t.filePath === activeTab);

  const handleSave = useCallback(
    async (filePath: string) => {
      if (!workspace) return;
      const tab = tabs.find((t) => t.filePath === filePath);
      if (!tab) return;
      await ipc.file.write(workspace.id, filePath, tab.content);
      markSaved(filePath);
    },
    [workspace, tabs, markSaved],
  );

  // Ctrl+S 保存
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        if (activeTab) void handleSave(activeTab);
      }
    },
    [activeTab, handleSave],
  );

  if (tabs.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-neutral-500">
        <div className="text-center">
          <div className="text-4xl mb-2">📄</div>
          <p className="text-sm">双击文件打开编辑器</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col" onKeyDown={handleKeyDown}>
      {/* Tab 栏 */}
      <div className="flex bg-bg-secondary border-b border-border-subtle overflow-x-auto">
        {tabs.map((tab) => (
          <button
            key={tab.filePath}
            onClick={() => setActive(tab.filePath)}
            className={cn(
              'px-3 py-1.5 text-sm border-r border-border-subtle flex items-center gap-2 whitespace-nowrap',
              tab.filePath === activeTab ? 'bg-bg-primary' : 'hover:bg-bg-tertiary',
            )}
          >
            <span>{tab.dirty ? '●' : ''}</span>
            <span className="truncate max-w-[150px]">{tab.filePath.split('/').pop()}</span>
            <span
              onClick={(e) => {
                e.stopPropagation();
                closeTab(tab.filePath);
              }}
              className="text-neutral-500 hover:text-white ml-1"
            >
              ×
            </span>
          </button>
        ))}
      </div>

      {/* Monaco 编辑器 */}
      {activeTabData && (
        <Editor
          height="100%"
          theme="vs-dark"
          language={detectLanguage(activeTabData.filePath)}
          value={activeTabData.content}
          onChange={(value) => {
            if (value !== undefined && activeTab) {
              updateContent(activeTab, value);
            }
          }}
          options={{
            fontSize: 14,
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            automaticLayout: true,
          }}
        />
      )}
    </div>
  );
}

function detectLanguage(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase();
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
    json: 'json', md: 'markdown', py: 'python', go: 'go', rs: 'rust',
    css: 'css', html: 'html', yaml: 'yaml', yml: 'yaml', sh: 'shell',
  };
  return map[ext ?? ''] ?? 'plaintext';
}
```

- [ ] **Step 4: 更新 `MiddlePanel.tsx` 渲染 files 视图 + 加载文件内容**

```tsx
// renderer/src/components/layout/MiddlePanel.tsx（替换 M0 的占位实现）
import { useCallback, useEffect } from 'react';
import { useUiStore } from '../../stores/ui.store';
import { useWorkspaceStore } from '../../stores/workspace.store';
import { useEditorStore } from '../../stores/editor.store';
import { ipc } from '../../ipc/client';
import { FileTree } from '../files/FileTree';
import { CodeEditor } from '../editor/CodeEditor';

export function MiddlePanel() {
  const { activeView } = useUiStore();
  const workspace = useWorkspaceStore((s) => s.getActive());
  const { openFile } = useEditorStore();

  const handleSelectFile = useCallback(
    async (filePath: string) => {
      if (!workspace) return;
      const content = await ipc.file.read(workspace.id, filePath);
      openFile(filePath, content);
    },
    [workspace, openFile],
  );

  if (!workspace) {
    return (
      <div className="flex-1 flex items-center justify-center text-neutral-500">
        <div className="text-center">
          <div className="text-4xl mb-2">📁</div>
          <p className="text-sm">创建或选择一个 workspace 开始</p>
        </div>
      </div>
    );
  }

  if (activeView === 'files') {
    return (
      <div className="flex-1 flex">
        <div className="w-64 border-r border-border-subtle bg-bg-secondary overflow-auto">
          <FileTree onSelectFile={handleSelectFile} />
        </div>
        <CodeEditor />
      </div>
    );
  }

  // 其他视图暂保留占位
  return (
    <div className="flex-1 flex items-center justify-center text-neutral-500">
      <div className="text-center">
        <div className="text-4xl mb-2">
          {activeView === 'im' && '💬'}
          {activeView === 'agents' && '🤖'}
          {activeView === 'marketplace' && '🛒'}
          {activeView === 'settings' && '⚙'}
        </div>
        <p className="text-sm">Coming in M1+</p>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: 更新 `MainLayout.tsx`**

MiddlePanel 已经包含编辑器，不需要单独的 RightPanel。更新 MainLayout 移除 M0 的 RightPanel（在 files 视图时 MiddlePanel 已自包含）：

```tsx
// renderer/src/components/layout/MainLayout.tsx
import { LeftRail } from './LeftRail';
import { MiddlePanel } from './MiddlePanel';

export function MainLayout() {
  return (
    <div className="flex h-screen w-screen overflow-hidden bg-bg-primary">
      <LeftRail />
      <MiddlePanel />
    </div>
  );
}
```

- [ ] **Step 6: 提交**

```bash
cd renderer && npx pnpm@9.0.0 typecheck
git add renderer/src/stores/editor.store.ts renderer/src/components/editor/ \
        renderer/src/components/layout/MiddlePanel.tsx renderer/src/components/layout/MainLayout.tsx \
        renderer/package.json
git commit -m "feat(editor): Monaco 编辑器 + 多 tab + Ctrl+S 保存"
```

---

## Task 9: Agent 定义类型 + YAML 解析器

**文件：**
- 安装: `js-yaml`, `@types/js-yaml`
- 创建: `electron/src/main/agent/types.ts`
- 创建: `electron/src/main/agent/manifest-parser.ts`
- 测试: `electron/tests/agent/manifest-parser.test.ts`

**接口：**
- 产出:
  - `AgentDefinition` 接口（declarative runtime 子集）
  - `parseAgentManifest(yaml: string): AgentDefinition`
  - `validateAgentDefinition(def: AgentDefinition): string[]`（返回错误列表）

- [ ] **Step 1: 安装 js-yaml**

```bash
cd electron && npx pnpm@9.0.0 add js-yaml && npx pnpm@9.0.0 add -D @types/js-yaml
```

- [ ] **Step 2: 创建 `agent/types.ts`**

```typescript
// electron/src/main/agent/types.ts

/** Agent 模型引用 */
export interface ModelRef {
  provider: 'openai' | 'anthropic';
  model: string;
  apiKeyRef?: string;
}

/** Agent 工具引用 */
export interface ToolRef {
  kind: 'builtin';
  ref: string;
}

/** Declarative agent 定义（M1 仅支持此类型） */
export interface AgentDefinition {
  id: string;
  name: string;
  slug: string;
  version: string;
  type: 'standalone' | 'main' | 'sub';
  runtime: 'declarative';
  systemPrompt: string;
  model: ModelRef;
  defaultTools: ToolRef[];
  source: 'builtin' | 'custom';
  description: string;
  iconEmoji: string;
}

/** Agent 在 workspace 中的实例化 */
export interface AgentAssignment {
  instanceId: string;
  workspaceId: string;
  agentDefinitionId: string;
  botMatrixUserId: string;
  enabled: boolean;
  createdAt: string;
}
```

- [ ] **Step 3: 实现 `manifest-parser.ts`**

```typescript
// electron/src/main/agent/manifest-parser.ts
import yaml from 'js-yaml';
import { randomUUID } from 'node:crypto';
import type { AgentDefinition, ModelRef, ToolRef } from './types';

interface RawManifest {
  apiVersion?: string;
  kind?: string;
  metadata?: {
    name?: string;
    slug?: string;
    version?: string;
    description?: string;
    iconEmoji?: string;
  };
  spec?: {
    type?: string;
    runtime?: string;
    declarative?: {
      systemPrompt?: string;
      model?: {
        provider?: string;
        model?: string;
      };
    };
    defaultTools?: Array<{ kind?: string; ref?: string }>;
  };
}

/** 解析 YAML manifest 为 AgentDefinition。失败时抛出 Error。 */
export function parseAgentManifest(yamlContent: string): AgentDefinition {
  const raw = yaml.load(yamlContent) as RawManifest;
  const errors = validateRawManifest(raw);
  if (errors.length > 0) {
    throw new Error(`Agent manifest 校验失败:\n${errors.map((e) => '  - ' + e).join('\n')}`);
  }

  const spec = raw.spec!;
  const decl = spec.declarative!;
  const model = decl.model!;

  return {
    id: randomUUID(),
    name: raw.metadata!.name!,
    slug: raw.metadata!.slug!,
    version: raw.metadata!.version!,
    type: (spec.type as AgentDefinition['type']) ?? 'standalone',
    runtime: 'declarative',
    systemPrompt: decl.systemPrompt!,
    model: {
      provider: model.provider as ModelRef['provider'],
      model: model.model!,
    },
    defaultTools: (spec.defaultTools ?? []).map((t) => ({
      kind: 'builtin' as const,
      ref: t.ref!,
    })),
    source: 'custom',
    description: raw.metadata!.description ?? '',
    iconEmoji: raw.metadata!.iconEmoji ?? '🤖',
  };
}

function validateRawManifest(raw: RawManifest): string[] {
  const errors: string[] = [];
  if (raw.apiVersion !== 'v1') errors.push('apiVersion 必须为 "v1"');
  if (raw.kind !== 'AgentDefinition') errors.push('kind 必须为 "AgentDefinition"');
  if (!raw.metadata?.name) errors.push('metadata.name 不能为空');
  if (!raw.metadata?.slug) errors.push('metadata.slug 不能为空');
  if (!raw.spec?.declarative?.systemPrompt) errors.push('spec.declarative.systemPrompt 不能为空');
  if (!raw.spec?.declarative?.model?.provider) errors.push('spec.declarative.model.provider 不能为空');
  if (!raw.spec?.declarative?.model?.model) errors.push('spec.declarative.model.model 不能为空');

  const provider = raw.spec?.declarative?.model?.provider;
  if (provider && provider !== 'openai' && provider !== 'anthropic') {
    errors.push(`model.provider 仅支持 "openai" 或 "anthropic"，收到 "${provider}"`);
  }
  return errors;
}
```

- [ ] **Step 4: 写测试**

```typescript
// electron/tests/agent/manifest-parser.test.ts
import { describe, it, expect } from 'vitest';
import { parseAgentManifest } from '../../src/main/agent/manifest-parser';

const VALID_YAML = `
apiVersion: v1
kind: AgentDefinition
metadata:
  name: 需求讨论师
  slug: requirement-analyst
  version: 1.0.0
  description: 帮用户梳理需求
  iconEmoji: "📝"
spec:
  type: standalone
  runtime: declarative
  declarative:
    systemPrompt: "你是一名需求分析师"
    model:
      provider: anthropic
      model: claude-3-5-sonnet
  defaultTools:
    - kind: builtin
      ref: workspace.read_file
    - kind: builtin
      ref: workspace.write_file
`;

describe('agent/manifest-parser', () => {
  it('解析合法 YAML 返回 AgentDefinition', () => {
    const def = parseAgentManifest(VALID_YAML);
    expect(def.name).toBe('需求讨论师');
    expect(def.slug).toBe('requirement-analyst');
    expect(def.runtime).toBe('declarative');
    expect(def.model.provider).toBe('anthropic');
    expect(def.model.model).toBe('claude-3-5-sonnet');
    expect(def.defaultTools).toHaveLength(2);
    expect(def.defaultTools[0]!.ref).toBe('workspace.read_file');
  });

  it('缺少 apiVersion 时抛错', () => {
    expect(() => parseAgentManifest('kind: AgentDefinition\nmetadata:\n  name: test\n  slug: test\nspec:\n  declarative:\n    systemPrompt: "test"\n    model:\n      provider: openai\n      model: gpt-4')).toThrow('apiVersion');
  });

  it('不支持的 provider 抛错', () => {
    const yaml = VALID_YAML.replace('anthropic', 'gemini');
    expect(() => parseAgentManifest(yaml)).toThrow('gemini');
  });

  it('缺少 systemPrompt 抛错', () => {
    const yaml = VALID_YAML.replace('systemPrompt: "你是一名需求分析师"', '');
    expect(() => parseAgentManifest(yaml)).toThrow('systemPrompt');
  });
});
```

- [ ] **Step 5: 运行测试 + 提交**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/agent/manifest-parser.test.ts
git add electron/src/main/agent/types.ts electron/src/main/agent/manifest-parser.ts \
        electron/tests/agent/manifest-parser.test.ts electron/package.json
git commit -m "feat(agent): YAML manifest 解析器 + 类型定义"
```

---

## Task 10: Agent 存储 + bot 账号注册

**文件：**
- 修改: `electron/src/main/storage/migrations/index.ts`（添加 003 迁移）
- 创建: `electron/src/main/agent/crud.ts`
- 创建: `electron/src/main/agent/ipc.handlers.ts`
- 修改: `electron/src/main/ipc/index.ts`

**接口：**
- 消费: T9 的 types + parser
- 产出:
  - `agent_definitions` 和 `agent_assignments` 表
  - `saveAgentDefinition(def)`, `listAgentDefinitions()`, `getAgentDefinition(id)`
  - `assignAgentToWorkspace(workspaceId, defId, botUserId)` + IPC handlers

- [ ] **Step 1: 添加 003 迁移**

在 `MIGRATIONS` 数组末尾添加：

```typescript
  {
    version: 3,
    sql: `
CREATE TABLE IF NOT EXISTS agent_definitions (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  version TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'standalone',
  runtime TEXT NOT NULL DEFAULT 'declarative',
  system_prompt TEXT NOT NULL,
  model_provider TEXT NOT NULL,
  model_name TEXT NOT NULL,
  default_tools TEXT NOT NULL DEFAULT '[]',
  source TEXT NOT NULL DEFAULT 'custom',
  description TEXT NOT NULL DEFAULT '',
  icon_emoji TEXT NOT NULL DEFAULT '🤖',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS agent_assignments (
  instance_id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  agent_definition_id TEXT NOT NULL,
  bot_matrix_user_id TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (agent_definition_id) REFERENCES agent_definitions(id) ON DELETE CASCADE
);
`.trim(),
  },
```

- [ ] **Step 2: 实现 `agent/crud.ts`**

```typescript
// electron/src/main/agent/crud.ts
import { getDb } from '../storage/db';
import { logger } from '../logger';
import type { AgentDefinition, AgentAssignment, ToolRef } from './types';

interface AgentDefRow {
  id: string;
  name: string;
  slug: string;
  version: string;
  type: string;
  runtime: string;
  system_prompt: string;
  model_provider: string;
  model_name: string;
  default_tools: string;
  source: string;
  description: string;
  icon_emoji: string;
}

function rowToDef(row: AgentDefRow): AgentDefinition {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    version: row.version,
    type: row.type as AgentDefinition['type'],
    runtime: row.runtime as AgentDefinition['runtime'],
    systemPrompt: row.system_prompt,
    model: { provider: row.model_provider as 'openai' | 'anthropic', model: row.model_name },
    defaultTools: JSON.parse(row.default_tools) as ToolRef[],
    source: row.source as 'builtin' | 'custom',
    description: row.description,
    iconEmoji: row.icon_emoji,
  };
}

export function saveAgentDefinition(def: AgentDefinition): void {
  const db = getDb();
  db.prepare(
    `INSERT OR REPLACE INTO agent_definitions
     (id, name, slug, version, type, runtime, system_prompt, model_provider, model_name, default_tools, source, description, icon_emoji)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    def.id, def.name, def.slug, def.version, def.type, def.runtime,
    def.systemPrompt, def.model.provider, def.model.model,
    JSON.stringify(def.defaultTools), def.source, def.description, def.iconEmoji,
  );
}

export function listAgentDefinitions(): AgentDefinition[] {
  const db = getDb();
  return (db.prepare('SELECT * FROM agent_definitions ORDER BY created_at DESC').all() as AgentDefRow[]).map(rowToDef);
}

export function getAgentDefinition(id: string): AgentDefinition | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM agent_definitions WHERE id = ?').get(id) as AgentDefRow | undefined;
  return row ? rowToDef(row) : null;
}

export function assignAgentToWorkspace(
  workspaceId: string,
  agentDefinitionId: string,
  botMatrixUserId: string,
): AgentAssignment {
  const { randomUUID } = require('node:crypto') as { randomUUID: () => string };
  const instanceId = randomUUID();
  const db = getDb();
  db.prepare(
    `INSERT INTO agent_assignments (instance_id, workspace_id, agent_definition_id, bot_matrix_user_id)
     VALUES (?, ?, ?, ?)`,
  ).run(instanceId, workspaceId, agentDefinitionId, botMatrixUserId);

  const row = db.prepare('SELECT * FROM agent_assignments WHERE instance_id = ?').get(instanceId) as {
    instance_id: string;
    workspace_id: string;
    agent_definition_id: string;
    bot_matrix_user_id: string;
    enabled: number;
    created_at: string;
  };
  logger.info('Agent 已分配到 workspace', { workspaceId, agentDefinitionId, botMatrixUserId });
  return {
    instanceId: row.instance_id,
    workspaceId: row.workspace_id,
    agentDefinitionId: row.agent_definition_id,
    botMatrixUserId: row.bot_matrix_user_id,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
  };
}

export function listAssignments(workspaceId: string): AgentAssignment[] {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM agent_assignments WHERE workspace_id = ?').all(workspaceId) as Array<{
    instance_id: string;
    workspace_id: string;
    agent_definition_id: string;
    bot_matrix_user_id: string;
    enabled: number;
    created_at: string;
  }>;
  return rows.map((r) => ({
    instanceId: r.instance_id,
    workspaceId: r.workspace_id,
    agentDefinitionId: r.agent_definition_id,
    botMatrixUserId: r.bot_matrix_user_id,
    enabled: r.enabled === 1,
    createdAt: r.created_at,
  }));
}
```

- [ ] **Step 3: 实现 `agent/ipc.handlers.ts`**

```typescript
// electron/src/main/agent/ipc.handlers.ts
import { ipcMain } from 'electron';
import { logger } from '../logger';
import { parseAgentManifest } from './manifest-parser';
import { saveAgentDefinition, listAgentDefinitions, assignAgentToWorkspace, listAssignments } from './crud';

export function registerAgentHandlers(): void {
  ipcMain.handle('agent:createFromYaml', async (_evt, yamlContent: string) => {
    const def = parseAgentManifest(yamlContent);
    saveAgentDefinition(def);
    logger.info('Agent 定义已创建', { slug: def.slug });
    return def;
  });

  ipcMain.handle('agent:list', async () => {
    return listAgentDefinitions();
  });

  ipcMain.handle(
 'agent:assign',
    async (_evt, workspaceId: string, agentDefinitionId: string, botMatrixUserId: string) => {
      return assignAgentToWorkspace(workspaceId, agentDefinitionId, botMatrixUserId);
    },
  );

  ipcMain.handle('agent:listAssignments', async (_evt, workspaceId: string) => {
    return listAssignments(workspaceId);
  });

  logger.info('Agent IPC handlers 已注册');
}
```

- [ ] **Step 4: 更新 `ipc/index.ts`、`preload`、`types.ts`**

`ipc/index.ts`: 添加 `registerAgentHandlers()` 调用。

`renderer/src/ipc/types.ts`:
```typescript
export interface AgentDefinition {
  id: string; name: string; slug: string; version: string;
  type: string; runtime: string; systemPrompt: string;
  model: { provider: string; model: string };
  defaultTools: Array<{ kind: string; ref: string }>;
  source: string; description: string; iconEmoji: string;
}

export interface AgentAssignment {
  instanceId: string; workspaceId: string;
  agentDefinitionId: string; botMatrixUserId: string;
  enabled: boolean; createdAt: string;
}

// 在 ApiSurface 接口中添加:
agent: {
  createFromYaml(yaml: string): Promise<AgentDefinition>;
  list(): Promise<AgentDefinition[]>;
  assign(workspaceId: string, defId: string, botUserId: string): Promise<AgentAssignment>;
  listAssignments(workspaceId: string): Promise<AgentAssignment[]>;
};
```

`preload/index.ts` 添加对应的 `agent:` 命名空间。

- [ ] **Step 5: 提交**

```bash
npx pnpm@9.0.0 typecheck
git add electron/src/main/agent/crud.ts electron/src/main/agent/ipc.handlers.ts \
        electron/src/main/storage/migrations/index.ts \
        electron/src/main/ipc/index.ts electron/src/preload/index.ts \
        renderer/src/ipc/types.ts
git commit -m "feat(agent): agent 存储 + bot 账号注册 IPC"
```

---

## Task 11: LLM Provider 抽象

**文件：**
- 创建: `electron/src/main/agent/llm-provider.ts`
- 测试: `electron/tests/agent/llm-provider.test.ts`

**接口：**
- 产出:
  - `LLMMessage` 类型（system / user / assistant / tool_result）
  - `LLMToolCall` 类型
  - `LLMResponse` 类型
  - `createLLMProvider(model: ModelRef, apiKey: string): LLMProvider`
  - `LLMProvider.chat(messages, tools?): Promise<LLMResponse>`

- [ ] **Step 1: 实现 `llm-provider.ts`**

```typescript
// electron/src/main/agent/llm-provider.ts
import { logger } from '../logger';
import type { ModelRef } from './types';

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCallId?: string;
  toolCalls?: LLMToolCall[];
}

export interface LLMToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface LLMToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface LLMResponse {
  content: string;
  toolCalls: LLMToolCall[];
  finishReason: 'stop' | 'tool_use';
}

export interface LLMProvider {
  chat(messages: LLMMessage[], tools?: LLMToolDef[]): Promise<LLMResponse>;
}

/** 统一的 LLM provider 工厂 */
export function createLLMProvider(model: ModelRef, apiKey: string): LLMProvider {
  if (model.provider === 'openai') {
    return new OpenAIProvider(model.model, apiKey);
  }
  if (model.provider === 'anthropic') {
    return new AnthropicProvider(model.model, apiKey);
  }
  throw new Error(`不支持的 LLM provider: ${model.provider}`);
}

// --- OpenAI 实现 ---

class OpenAIProvider implements LLMProvider {
  constructor(private model: string, private apiKey: string) {}

  async chat(messages: LLMMessage[], tools?: LLMToolDef[]): Promise<LLMResponse> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: messages.map((m) => this.toOpenAIMessage(m)),
    };
    if (tools && tools.length > 0) {
      body.tools = tools.map((t) => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.inputSchema,
        },
      }));
    }

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`OpenAI API 错误 ${response.status}: ${errText}`);
    }

    const data = (await response.json()) as {
      choices: Array<{
        message: {
          content: string | null;
          tool_calls?: Array<{
            id: string;
            function: { name: string; arguments: string };
          }>;
        };
        finish_reason: string;
      }>;
    };

    const choice = data.choices[0]!;
    const toolCalls: LLMToolCall[] = (choice.message.tool_calls ?? []).map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      arguments: JSON.parse(tc.function.arguments) as Record<string, unknown>,
    }));

    return {
      content: choice.message.content ?? '',
      toolCalls,
      finishReason: choice.finish_reason === 'tool_calls' ? 'tool_use' : 'stop',
    };
  }

  private toOpenAIMessage(m: LLMMessage): Record<string, unknown> {
    if (m.role === 'tool' && m.toolCallId) {
      return { role: 'tool', content: m.content, tool_call_id: m.toolCallId };
    }
    if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
      return {
        role: 'assistant',
        content: m.content || null,
        tool_calls: m.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
        })),
      };
    }
    return { role: m.role, content: m.content };
  }
}

// --- Anthropic 实现 ---

class AnthropicProvider implements LLMProvider {
  constructor(private model: string, private apiKey: string) {}

  async chat(messages: LLMMessage[], tools?: LLMToolDef[]): Promise<LLMResponse> {
    // Anthropic 把 system 单独传，messages 只含 user/assistant
    const systemMsg = messages.find((m) => m.role === 'system');
    const conversationMessages = messages.filter((m) => m.role !== 'system');

    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: 4096,
      messages: conversationMessages.map((m) => this.toAnthropicMessage(m)),
    };
    if (systemMsg) {
      body.system = systemMsg.content;
    }
    if (tools && tools.length > 0) {
      body.tools = tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema,
      }));
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Anthropic API 错误 ${response.status}: ${errText}`);
    }

    const data = (await response.json()) as {
      content: Array<
        | { type: 'text'; text: string }
        | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
      >;
      stop_reason: string;
    };

    const textParts = data.content.filter((c) => c.type === 'text').map((c) => (c as { text: string }).text);
    const toolUses = data.content.filter((c) => c.type === 'tool_use');

    return {
      content: textParts.join('\n'),
      toolCalls: toolUses.map((tu) => {
        const t = tu as { id: string; name: string; input: Record<string, unknown> };
        return { id: t.id, name: t.name, arguments: t.input };
      }),
      finishReason: data.stop_reason === 'tool_use' ? 'tool_use' : 'stop',
    };
  }

  private toAnthropicMessage(m: LLMMessage): Record<string, unknown> {
    if (m.role === 'tool') {
      return {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: m.toolCallId,
            content: m.content,
          },
        ],
      };
    }
    if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
      return {
        role: 'assistant',
        content: [
          ...(m.content ? [{ type: 'text', text: m.content }] : []),
          ...m.toolCalls.map((tc) => ({
            type: 'tool_use',
            id: tc.id,
            name: tc.name,
            input: tc.arguments,
          })),
        ]),
      };
    }
    return { role: m.role, content: m.content };
  }
}
```

- [ ] **Step 2: 写测试（mock fetch）**

```typescript
// electron/tests/agent/llm-provider.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createLLMProvider, type LLMMessage } from '../../src/main/agent/llm-provider';

// Mock 全局 fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

beforeEach(() => {
  mockFetch.mockReset();
});

describe('llm-provider', () => {
  it('OpenAI provider 发送正确请求', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        choices: [{
          message: { content: '你好', tool_calls: undefined },
          finish_reason: 'stop',
        }],
      }),
    });

    const provider = createLLMProvider({ provider: 'openai', model: 'gpt-4o' }, 'test-key');
    const result = await provider.chat([
      { role: 'system', content: '你是助手' },
      { role: 'user', content: '你好' },
    ]);

    expect(result.content).toBe('你好');
    expect(result.toolCalls).toEqual([]);
    expect(result.finishReason).toBe('stop');

    // 验证 fetch 被正确调用
    const call = mockFetch.mock.calls[0]!;
    expect(call[0]).toBe('https://api.openai.com/v1/chat/completions');
    const opts = call[1] as { headers: Record<string, string>; body: string };
    expect(opts.headers.Authorization).toBe('Bearer test-key');
    const body = JSON.parse(opts.body);
    expect(body.model).toBe('gpt-4o');
  });

  it('Anthropic provider 发送正确请求', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        content: [{ type: 'text', text: 'Hello!' }],
        stop_reason: 'end_turn',
      }),
    });

    const provider = createLLMProvider({ provider: 'anthropic', model: 'claude-3-5-sonnet' }, 'ant-key');
    const result = await provider.chat([
      { role: 'system', content: 'Be helpful' },
      { role: 'user', content: 'Hi' },
    ]);

    expect(result.content).toBe('Hello!');
    const call = mockFetch.mock.calls[0]!;
    expect(call[0]).toBe('https://api.anthropic.com/v1/messages');
    const opts = call[1] as { headers: Record<string, string>; body: string };
    expect(opts.headers['x-api-key']).toBe('ant-key');
    const body = JSON.parse(opts.body);
    expect(body.system).toBe('Be helpful');
  });

  it('API 错误时抛出异常', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 401, text: async () => 'Unauthorized' });
    const provider = createLLMProvider({ provider: 'openai', model: 'gpt-4o' }, 'bad-key');
    await expect(provider.chat([{ role: 'user', content: 'hi' }])).rejects.toThrow('401');
  });
});
```

- [ ] **Step 3: 运行测试 + 提交**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/agent/llm-provider.test.ts
git add electron/src/main/agent/llm-provider.ts electron/tests/agent/llm-provider.test.ts
git commit -m "feat(agent): LLM provider 抽象（OpenAI + Anthropic）"
```

---

## Task 12-20: 后续任务大纲

由于篇幅限制，以下任务给出**精确的文件列表、接口定义、和关键实现要点**，但代码量小于前 11 个 task。执行时按相同 TDD 模式展开。

### Task 12: Matrix room 管理

**文件：** `electron/src/main/matrix/rooms.ts`（已在 T3 创建）、测试 `electron/tests/matrix/rooms.test.ts`

**要点：**
- `createTeamRoomInSpace(client, spaceId, name)` — 创建团队群并加入 Space
- `inviteBotToRoom(client, roomId, botUserId)` — 邀请 bot 进群
- 测试用 stub MatrixClient

### Task 13: Agent bot 账号注册

**文件：** `electron/src/main/agent/bot-registrar.ts`

**要点：**
- `registerAgentBot(slug, workspaceSlug, ownerUserId, password)` — 在 Conduwuit 注册 bot 账号
- bot 命名规则：`@<slug>.<ws-slug>.<owner>:localhost`
- 密码随机生成，token 存 keychain
- 复用 M0 的 registerAdmin 逻辑

### Task 14: Agent runtime（子进程）

**文件：** `electron/src/main/agent/runtime.ts`（子进程内代码）、`electron/src/main/agent/runtime-manager.ts`（主进程管理）

**要点：**
- `runtime.ts` 是子进程入口（`child_process.fork`）
- 接收配置：manifest + workspace_dir + bot credentials + LLM API key
- 初始化 Matrix client（bot 登录）
- 监听 /sync 收到 @mention 消息 → 转入 chat loop
- `runtime-manager.ts`：`spawnAgent(assignment)`, `stopAgent(instanceId)`, `listRunningAgents()`
- 子进程崩溃自动重启（3 次重试后暂停）

### Task 15: Agent chat loop

**文件：** `electron/src/main/agent/chat-loop.ts`（被 runtime.ts 调用）

**要点：**
- `handleMessage(event, context)`：
  1. 加载最近 N 条 room 历史
  2. 构建 system prompt + 历史 + 用户消息
  3. 调用 LLM provider
  4. 如果 LLM 返回 tool_calls → 执行 builtin tools（read_file/write_file/list_files）→ 把结果加回 messages → 再调 LLM
  5. 最终回复通过 Matrix client 发到 room
- 工具调用循环上限 10 次（防无限循环）
- `builtin-tools.ts`：包装 WorkspaceFS 的 readFile/writeFile/listDir 为 LLM 工具格式

### Task 16: IM store + Matrix sync

**文件：** `renderer/src/stores/im.store.ts`、`electron/src/main/matrix/sync-manager.ts`

**要点：**
- 主进程的 Matrix client 启动 /sync，收到消息后通过 IPC 推送给 renderer
- `im.store.ts`：rooms Map、messages per room、typing 状态
- `/sync` 用 matrix-js-sdk 的 `client.startClient()` + `on('event')` 监听

### Task 17: IM 消息渲染

**文件：** `renderer/src/components/im/RoomList.tsx`、`MessageList.tsx`、`MessageBubble.tsx`

**要点：**
- RoomList：列出用户参与的 room（从 Space 拉取）
- MessageList：按时间渲染消息流，支持 Markdown 渲染（react-markdown）
- MessageBubble：区分人/agent 头像、sender 名、时间戳

### Task 18: IM 消息输入 + 发送

**文件：** `renderer/src/components/im/MessageInput.tsx`

**要点：**
- Markdown 输入 + 发送（Enter 发送，Shift+Enter 换行）
- @mention 弹出选择器（列出 room 内 agent bot）
- 发送通过 IPC → 主进程 Matrix client → `sendMessage`

### Task 19: Demo agents

**文件：** `electron/resources/agents/requirement-analyst.yaml`、`coder.yaml`

**要点：**
- requirement-analyst：anthropic claude-3-5-sonnet，system prompt 梳理需求输出 Markdown
- coder：openai gpt-4o，system prompt 写代码 + 用 workspace.write_file 工具
- 应用启动时自动注册 builtin agents

### Task 20: Agent 管理 UI + 集成

**文件：** `renderer/src/components/agent/AgentList.tsx`、`AddAgentDialog.tsx`、修改 `MiddlePanel.tsx`

**要点：**
- agents 视图：列出 workspace 内已分配 agent + 添加按钮
- AddAgentDialog：从已装定义中选 + 输入 LLM API key
- 添加 agent = 注册 bot + 分配到 workspace + 启动 runtime + 在 team room 发 "已上线"
- IM 视图接入 RoomList + MessageList + MessageInput
- 完整集成验证：创建 ws → 添加 agent → 在 IM 中聊天 → agent 写文件 → 文件树更新

---

## 自审

### Spec 覆盖

| Spec M1 要求 | 对应 Task |
|---|---|
| Workspace CRUD UI + SQLite 持久化 | T1-T4 |
| 本地 git init | T2 |
| 文件浏览器 | T7 |
| Monaco 编辑器集成 | T8 |
| Agent 定义格式 (YAML) + 解析 | T9 |
| Agent 子进程启动 | T14 |
| 内置 demo agent | T19 |
| 基础 IM (DM + 团队群 + @ mention) | T16-T18 |
| 单 agent 与用户聊天 + 读写文件 | T15 + T11 + T5 |

### 验收标准（Spec 13.5）

- ✅ 创建 workspace "demo"，git init 成功 → T2
- ✅ 从内置 agent 安装 requirement-analyst → T19 + T10
- ✅ 在 IM 中 @requirement-analyst → agent 输出文档并写入 workspace → T15 + T17 + T18
- ✅ 文件浏览器双击打开文档 → T7 + T8
- ✅ @coder 写代码 → T15 + T19

### 已知简化（M1 范围内合理）

- 无 OS 级沙箱（仅 WorkspaceFS 应用层检查）→ M3
- 无主子 agent 调度 → M2
- 无 MCP/Skill → M2
- 无 Marketplace → M4
- IM 无自定义消息类型（dispatch/tool_result） → M2
- 文件树无虚拟化 → M2 优化
