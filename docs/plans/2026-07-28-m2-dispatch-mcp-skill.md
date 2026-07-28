# AgentPlatform M2 — 主子调度 + MCP + Skill 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**目标：** 主 agent 能调度子 agent（通过 IM dispatch 消息）；agent 能调用 MCP 工具（stdio transport）；agent 能用 Skill（渐进式披露知识包）。

**架构：** 在 M1 的 agent runtime + chat loop 基础上，增加三条能力线：(1) 主子关系 + IM dispatch 协议（自定义 Matrix event type）；(2) MCP Host 进程池（workspace 级共享，JSON-RPC over stdio）；(3) SkillRegistry（SKILL.md frontmatter 扫描 + loadSkill/readResource 虚拟工具）。

**技术栈新增：** 无新 npm 依赖。MCP stdio 用 Node.js child_process + 手写 JSON-RPC 2.0。Skill 解析复用 M1 的 js-yaml。

## 全局约束

继承 M0+M1 全部约束。新增：

- **MCP 仅 stdio transport**（M2 不做 HTTP/SSE — v2 范围）。
- **Skill 是知识包不是可执行**（Anthropic SKILL.md 规范）。通过 loadSkill/readResource 虚拟工具按需注入 LLM context。
- **主子调度走 IM**（自定义 Matrix event type `io.agentplatform.dispatch` / `io.agentplatform.task_reply`），不走 RPC。
- **MCP 进程池 workspace 级共享**（同 workspace 的多个 agent 共用同一 MCP server 进程）。
- **三层能力叠加**：AgentDefinition.default + WorkspaceAllocation + AgentAssignment.extra（M2 实现 WorkspaceAllocation 层）。
- 代码注释用中文。工作目录 `/workspace`。

## Spike 决策

- **MCP client**：手写 JSON-RPC 2.0 over stdio（不引 `@modelcontextprotocol/sdk`，避免 ESM/CJS 冲突）。协议简单：initialize → tools/list → tools/call。
- **Skill frontmatter**：复用 `js-yaml`（M1 已装）。SKILL.md = YAML frontmatter + Markdown body。
- **自定义 Matrix event**：直接用 matrix-js-sdk 的 `client.sendEvent(roomId, eventType, content, txId)`。

## 文件结构（新增）

```
electron/src/main/
├── agent/
│   ├── types.ts                    # 修改：扩展 parentAgentId, McpRef, SkillRef
│   ├── dispatch.ts                 # 新：dispatch/task_reply 消息构建 + 解析
│   ├── builtin-tools.ts            # 修改：添加 loadSkill/readResource 虚拟工具
│   ├── chat-loop.ts                # 修改：集成 MCP 工具 + dispatch + skill
│   ├── runtime-entry.ts            # 修改：dispatch handler + skill 索引注入
│   └── ipc.handlers.ts             # 修改：workspace allocation handlers
├── mcp/
│   ├── types.ts                    # MCP 相关类型
│   ├── client.ts                   # JSON-RPC 2.0 over stdio 客户端
│   ├── host-manager.ts             # workspace 级 MCP 进程池
│   └── ipc.handlers.ts             # mcp:* IPC handlers
├── skill/
│   ├── types.ts                    # SkillDefinition, SkillFrontmatter
│   ├── registry.ts                 # SkillRegistry（扫描 + 加载 + 索引）
│   ├── loader.ts                   # SKILL.md 解析（frontmatter + body）
│   └── ipc.handlers.ts             # skill:* IPC handlers
├── storage/migrations/
│   └── index.ts                    # 修改：004 迁移（agent parent + mcp + skill 表）
└── workspace/
    └── allocation.ts               # 新：workspace 级能力分配 CRUD

renderer/src/
├── components/
│   ├── im/
│   │   ├── DispatchCard.tsx        # dispatch 消息卡片
│   │   └── TaskReplyCard.tsx       # task_reply 消息卡片
│   └── agent/
│       └── CapabilityConfig.tsx     # 三层能力配置面板
├── stores/
│   └── capability.store.ts          # 能力配置 store
└── ipc/
    └── types.ts                     # 修改：扩展 mcp/skill/allocation API
```

## 任务依赖图

```
T1 (类型扩展 + 迁移) ──► T2 (主子安装) ──► T3 (dispatch 消息类型)
                                              │
T6 (MCP client) ──► T7 (MCP host pool)        │
                       │                      │
T11 (Skill parser) ──► T12 (SkillRegistry)    │
                              │               │
                              └──► T4 (runtime 集成: dispatch + mcp + skill)
                                       │
T5 (dispatch UI) ──► T13 (tool_result UI)     │
                       │                      │
                  T14 (三层能力叠加) ◄────────┘
                       │
                  T15 (端到端 demo)
```

---

## Task 1: 类型扩展 + 004 迁移

**文件：**
- 修改: `electron/src/main/agent/types.ts`
- 修改: `electron/src/main/storage/migrations/index.ts`
- 测试: `electron/tests/agent/types-extended.test.ts`

**接口：**
- 产出: `AgentDefinition` 新增 `parentAgentId?`, `defaultMcps`, `defaultSkills`; 新增 `McpRef`, `SkillRef` 类型; `workspace_allocations` 表

- [ ] **Step 1: 扩展 `agent/types.ts`**

在现有 `ToolRef` 后添加：

```typescript
/** MCP server 引用 */
export interface McpRef {
  kind: 'mcp';
  /** MCP server 名（对应 McpDefinition.name） */
  ref: string;
  /** 版本范围（semver），如 "^1.0.0"，默认 "latest" */
  versionRange?: string;
}

/** Skill 引用 */
export interface SkillRef {
  kind: 'skill';
  /** skill slug */
  ref: string;
  versionRange?: string;
}
```

修改 `AgentDefinition` 接口，添加字段：

```typescript
export interface AgentDefinition {
  // ... 已有字段不变 ...
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

  // === M2 新增 ===
  /** 父 agent ID（仅 type='sub' 时有值） */
  parentAgentId?: string;
  /** MCP server 引用列表 */
  defaultMcps: McpRef[];
  /** Skill 引用列表 */
  defaultSkills: SkillRef[];
}
```

- [ ] **Step 2: 添加 004 迁移**

在 `MIGRATIONS` 数组末尾添加：

```typescript
  {
    version: 4,
    sql: `
-- agent_definitions 新增列（SQLite ALTER TABLE 仅加列）
ALTER TABLE agent_definitions ADD COLUMN parent_agent_id TEXT;
ALTER TABLE agent_definitions ADD COLUMN default_mcps TEXT NOT NULL DEFAULT '[]';
ALTER TABLE agent_definitions ADD COLUMN default_skills TEXT NOT NULL DEFAULT '[]';

-- workspace 级能力分配
CREATE TABLE IF NOT EXISTS workspace_allocations (
  workspace_id TEXT NOT NULL,
  capability_type TEXT NOT NULL,
  capability_ref TEXT NOT NULL,
  added_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (workspace_id, capability_type, capability_ref),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

-- MCP server 定义
CREATE TABLE IF NOT EXISTS mcp_definitions (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL UNIQUE,
  version TEXT NOT NULL,
  transport TEXT NOT NULL DEFAULT 'stdio',
  command TEXT NOT NULL,
  args TEXT NOT NULL DEFAULT '[]',
  env TEXT NOT NULL DEFAULT '{}',
  capabilities TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Skill 定义
CREATE TABLE IF NOT EXISTS skill_definitions (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  version TEXT NOT NULL,
  description TEXT NOT NULL,
  allowed_tools TEXT NOT NULL DEFAULT '[]',
  cache_path TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`.trim(),
  },
```

- [ ] **Step 3: 写测试 + 提交**

```typescript
// electron/tests/agent/types-extended.test.ts
import { describe, it, expect } from 'vitest';
import type { AgentDefinition, McpRef, SkillRef } from '../../src/main/agent/types';

describe('agent/types M2 扩展', () => {
  it('McpRef 包含 kind + ref', () => {
    const mcp: McpRef = { kind: 'mcp', ref: 'filesystem', versionRange: '^1.0.0' };
    expect(mcp.kind).toBe('mcp');
    expect(mcp.ref).toBe('filesystem');
  });

  it('SkillRef 包含 kind + ref', () => {
    const skill: SkillRef = { kind: 'skill', ref: 'code-review-workflow' };
    expect(skill.kind).toBe('skill');
  });

  it('AgentDefinition 包含 M2 新字段', () => {
    const def: AgentDefinition = {
      id: 'test', name: '测试', slug: 'test', version: '1.0.0',
      type: 'main', runtime: 'declarative', systemPrompt: 'test',
      model: { provider: 'openai', model: 'gpt-4o' },
      defaultTools: [], source: 'builtin', description: '', iconEmoji: '🤖',
      parentAgentId: undefined,
      defaultMcps: [{ kind: 'mcp', ref: 'github' }],
      defaultSkills: [{ kind: 'skill', ref: 'code-review' }],
    };
    expect(def.defaultMcps).toHaveLength(1);
    expect(def.defaultSkills).toHaveLength(1);
    expect(def.parentAgentId).toBeUndefined();
  });
});
```

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/agent/types-extended.test.ts
npx pnpm@9.0.0 typecheck
git add electron/src/main/agent/types.ts electron/src/main/storage/migrations/index.ts \
        electron/tests/agent/types-extended.test.ts
git commit -m "feat(agent): M2 类型扩展（parentAgentId + McpRef + SkillRef + 004 迁移）"
```

---

## Task 2: 主子 Agent 安装跟随

**文件：**
- 修改: `electron/src/main/agent/bot-registrar.ts`
- 修改: `electron/src/main/agent/ipc.handlers.ts`
- 测试: `electron/tests/agent/sub-agent-install.test.ts`

**接口：**
- 消费: T1 的 `parentAgentId` 字段
- 产出: `agent:assignMain` IPC handler — 安装 main agent 时自动注册所有 sub agents

- [ ] **Step 1: 修改 `agent/ipc.handlers.ts` 添加 assignMain handler**

```typescript
// 在 registerAgentHandlers() 中添加:

ipcMain.handle(
  'agent:assignMain',
  async (_evt, opts: { workspaceId: string; mainDefId: string; llmApiKey: string; teamRoomId: string }) => {
    const mainDef = getAgentDefinition(opts.mainDefId);
    if (!mainDef) throw new Error('Agent 定义不存在');

    // 查找所有 parentAgentId == mainDef.id 的 sub agents
    const allDefs = listAgentDefinitions();
    const subDefs = allDefs.filter((d) => d.parentAgentId === mainDef.id);

    const results: AgentAssignment[] = [];

    // 注册 main bot
    const mainBot = await registerAgentBot({
      slug: mainDef.slug,
      workspaceName: getWorkspace(opts.workspaceId)?.name ?? 'ws',
      ownerUserId: getCurrentUserId() ?? '@unknown:localhost',
      homeserverUrl: 'http://127.0.0.1:8008',
    });
    await inviteBotToRoom(ownerClient, opts.teamRoomId, mainBot.botUserId);
    const mainAssignment = assignAgentToWorkspace(opts.workspaceId, mainDef.id, mainBot.botUserId);
    results.push(mainAssignment);

    // 注册所有 sub bots
    for (const subDef of subDefs) {
      const subBot = await registerAgentBot({
        slug: subDef.slug,
        workspaceName: getWorkspace(opts.workspaceId)?.name ?? 'ws',
        ownerUserId: getCurrentUserId() ?? '@unknown:localhost',
        homeserverUrl: 'http://127.0.0.1:8008',
      });
      await inviteBotToRoom(ownerClient, opts.teamRoomId, subBot.botUserId);
      const subAssignment = assignAgentToWorkspace(opts.workspaceId, subDef.id, subBot.botUserId);
      results.push(subAssignment);
    }

    return results;
  },
);
```

- [ ] **Step 2: 写测试 + 提交**

测试验证：给定一个 main agent + 2 个 sub agents，assignMain 返回 3 个 assignment。

```bash
git add electron/src/main/agent/ipc.handlers.ts electron/tests/agent/sub-agent-install.test.ts
git commit -m "feat(agent): 主 agent 安装时自动跟随注册所有 sub agents"
```

---

## Task 3: Dispatch 消息类型

**文件：**
- 创建: `electron/src/main/agent/dispatch.ts`
- 测试: `electron/tests/agent/dispatch.test.ts`

**接口：**
- 产出:
  - `buildDispatchMessage(opts): DispatchContent` — 构造 dispatch event content
  - `parseDispatchEvent(content): ParsedDispatch` — 解析收到的 dispatch
  - `buildTaskReply(opts): TaskReplyContent` — 构造 task_reply event content
  - `parseTaskReply(content): ParsedTaskReply` — 解析收到的 task_reply
  - `io.agentplatform.dispatch` / `io.agentplatform.task_reply` Matrix event types

- [ ] **Step 1: 实现 `dispatch.ts`**

```typescript
// electron/src/main/agent/dispatch.ts

/** dispatch 消息内容（Matrix event type: io.agentplatform.dispatch） */
export interface DispatchContent {
  body: string;
  task_id: string;
  dispatch_from: string;
  dispatch_to: string;
  deadline_ms?: number;
}

/** task_reply 消息内容（Matrix event type: io.agentplatform.task_reply） */
export interface TaskReplyContent {
  body: string;
  task_id: string;
  status: 'in_progress' | 'completed' | 'failed' | 'needs_input';
  progress_pct?: number;
}

export const DISPATCH_EVENT_TYPE = 'io.agentplatform.dispatch';
export const TASK_REPLY_EVENT_TYPE = 'io.agentplatform.task_reply';

import { randomUUID } from 'node:crypto';

export function buildDispatchMessage(opts: {
  body: string;
  fromBotUserId: string;
  toBotUserId: string;
  deadlineMs?: number;
}): { eventType: typeof DISPATCH_EVENT_TYPE; content: DispatchContent } {
  return {
    eventType: DISPATCH_EVENT_TYPE,
    content: {
      body: opts.body,
      task_id: randomUUID(),
      dispatch_from: opts.fromBotUserId,
      dispatch_to: opts.toBotUserId,
      deadline_ms: opts.deadlineMs,
    },
  };
}

export function buildTaskReply(opts: {
  body: string;
  taskId: string;
  status: TaskReplyContent['status'];
  progressPct?: number;
}): { eventType: typeof TASK_REPLY_EVENT_TYPE; content: TaskReplyContent } {
  return {
    eventType: TASK_REPLY_EVENT_TYPE,
    content: {
      body: opts.body,
      task_id: opts.taskId,
      status: opts.status,
      progress_pct: opts.progressPct,
    },
  };
}

/** 从 Matrix event content 解析 dispatch */
export function parseDispatchEvent(content: Record<string, unknown>): DispatchContent | null {
  if (typeof content.task_id !== 'string') return null;
  if (typeof content.body !== 'string') return null;
  return {
    body: content.body,
    task_id: content.task_id,
    dispatch_from: content.dispatch_from as string,
    dispatch_to: content.dispatch_to as string,
    deadline_ms: content.deadline_ms as number | undefined,
  };
}

/** 从 Matrix event content 解析 task_reply */
export function parseTaskReply(content: Record<string, unknown>): TaskReplyContent | null {
  if (typeof content.task_id !== 'string') return null;
  if (typeof content.body !== 'string') return null;
  return {
    body: content.body,
    task_id: content.task_id,
    status: content.status as TaskReplyContent['status'],
    progress_pct: content.progress_pct as number | undefined,
  };
}
```

- [ ] **Step 2: 写测试**

```typescript
// electron/tests/agent/dispatch.test.ts
import { describe, it, expect } from 'vitest';
import {
  buildDispatchMessage,
  buildTaskReply,
  parseDispatchEvent,
  parseTaskReply,
  DISPATCH_EVENT_TYPE,
  TASK_REPLY_EVENT_TYPE,
} from '../../src/main/agent/dispatch';

describe('agent/dispatch', () => {
  it('buildDispatchMessage 生成正确的 event type + content', () => {
    const msg = buildDispatchMessage({
      body: '帮我写需求文档',
      fromBotUserId: '@pm-agent:localhost',
      toBotUserId: '@req-agent:localhost',
    });
    expect(msg.eventType).toBe(DISPATCH_EVENT_TYPE);
    expect(msg.content.body).toBe('帮我写需求文档');
    expect(msg.content.dispatch_from).toBe('@pm-agent:localhost');
    expect(msg.content.dispatch_to).toBe('@req-agent:localhost');
    expect(msg.content.task_id).toHaveLength(36); // UUID
  });

  it('parseDispatchEvent 正确解析', () => {
    const parsed = parseDispatchEvent({
      body: 'test',
      task_id: 'abc-123',
      dispatch_from: '@a:localhost',
      dispatch_to: '@b:localhost',
    });
    expect(parsed?.task_id).toBe('abc-123');
    expect(parsed?.dispatch_to).toBe('@b:localhost');
  });

  it('parseDispatchEvent 缺字段返回 null', () => {
    expect(parseDispatchEvent({ body: 'test' })).toBeNull();
  });

  it('buildTaskReply + parseTaskReply 往返', () => {
    const reply = buildTaskReply({
      body: '完成了',
      taskId: 'task-xyz',
      status: 'completed',
    });
    expect(reply.eventType).toBe(TASK_REPLY_EVENT_TYPE);
    const parsed = parseTaskReply(reply.content);
    expect(parsed?.status).toBe('completed');
    expect(parsed?.task_id).toBe('task-xyz');
  });
});
```

- [ ] **Step 3: 运行 + 提交**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/agent/dispatch.test.ts
git add electron/src/main/agent/dispatch.ts electron/tests/agent/dispatch.test.ts
git commit -m "feat(agent): dispatch/task_reply 消息类型构建与解析"
```

---

## Task 4: MCP Client（JSON-RPC over stdio）

**文件：**
- 创建: `electron/src/main/mcp/types.ts`
- 创建: `electron/src/main/mcp/client.ts`
- 测试: `electron/tests/mcp/client.test.ts`

**接口：**
- 产出:
  - `McpClient` 类：`connect()`, `listTools()`, `callTool(name, args)`, `disconnect()`
  - JSON-RPC 2.0 over child process stdin/stdout
  - `McpToolInfo` 类型（name, description, inputSchema）

- [ ] **Step 1: 创建 `mcp/types.ts`**

```typescript
// electron/src/main/mcp/types.ts

/** MCP server 配置 */
export interface McpServerConfig {
  id: string;
  name: string;
  version: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/** MCP 工具信息（从 tools/list 响应解析） */
export interface McpToolInfo {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** MCP 工具调用结果 */
export interface McpToolResult {
  content: Array<{
    type: 'text' | 'image' | 'resource';
    text?: string;
  }>;
  isError: boolean;
}
```

- [ ] **Step 2: 实现 `mcp/client.ts`**

```typescript
// electron/src/main/mcp/client.ts
// JSON-RPC 2.0 over stdio — MCP 协议的客户端实现。
// 不依赖 @modelcontextprotocol/sdk（避免 ESM/CJS 冲突）。

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { logger } from '../logger';
import type { McpServerConfig, McpToolInfo, McpToolResult } from './types';

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export class McpClient {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (err: Error) => void;
  }>();
  private buffer = '';
  private initialized = false;

  constructor(private config: McpServerConfig) {}

  async connect(): Promise<void> {
    this.proc = spawn(this.config.command, this.config.args, {
      env: { ...process.env, ...this.config.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.proc.stdout.on('data', (chunk: Buffer) => this.handleData(chunk));
    this.proc.stderr.on('data', (chunk: Buffer) => {
      logger.debug(`[mcp:${this.config.name}] stderr: ${chunk.toString().trim()}`);
    });
    this.proc.on('exit', (code) => {
      logger.warn(`MCP server ${this.config.name} 退出`, { code });
      this.proc = null;
      // reject 所有 pending 请求
      for (const [, p] of this.pending) {
        p.reject(new Error(`MCP server 退出 (code=${code})`));
      }
      this.pending.clear();
    });

    // MCP initialize 握手
    const result = await this.sendRequest('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'AgentPlatform', version: '0.1.0' },
    });
    logger.info(`MCP ${this.config.name} 握手成功`, {
      protocolVersion: (result as { protocolVersion?: string }).protocolVersion,
    });

    // 发 initialized 通知（无 id = notification）
    this.sendNotification('notifications/initialized', {});
    this.initialized = true;
  }

  async listTools(): Promise<McpToolInfo[]> {
    const result = await this.sendRequest('tools/list', {});
    const tools = (result as { tools?: McpToolInfo[] }).tools ?? [];
    return tools;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    const result = await this.sendRequest('tools/call', { name, arguments: args });
    return result as McpToolResult;
  }

  async disconnect(): Promise<void> {
    if (this.proc) {
      this.proc.kill('SIGTERM');
      this.proc = null;
    }
    this.initialized = false;
  }

  get isConnected(): boolean {
    return this.initialized && this.proc !== null;
  }

  private async sendRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (!this.proc) throw new Error(`MCP ${this.config.name} 未连接`);
    const id = this.nextId++;
    const request: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };
    const promise = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      // 超时 30s
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`MCP 请求超时: ${method} (30s)`));
        }
      }, 30000);
    });
    this.proc.stdin.write(JSON.stringify(request) + '\n');
    return promise;
  }

  private sendNotification(method: string, params: Record<string, unknown>): void {
    if (!this.proc) return;
    const notification = { jsonrpc: '2.0', method, params };
    this.proc.stdin.write(JSON.stringify(notification) + '\n');
  }

  private handleData(chunk: Buffer): void {
    this.buffer += chunk.toString();
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line) as JsonRpcResponse;
        const pending = this.pending.get(msg.id);
        if (pending) {
          this.pending.delete(msg.id);
          if (msg.error) {
            pending.reject(new Error(msg.error.message));
          } else {
            pending.resolve(msg.result);
          }
        }
      } catch (err) {
        logger.warn(`MCP ${this.config.name} JSON 解析失败`, { line: line.slice(0, 100) });
      }
    }
  }
}
```

- [ ] **Step 3: 写测试（用 fake MCP server 进程）**

```typescript
// electron/tests/mcp/client.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { McpClient } from '../../src/main/mcp/client';
import type { McpServerConfig } from '../../src/main/mcp/types';

// 创建一个 fake MCP server 脚本（响应 JSON-RPC）
const fakeServerScript = `
const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0', id: msg.id,
      result: { protocolVersion: '2024-11-05', capabilities: { tools: {} } }
    }) + '\\n');
  } else if (msg.method === 'notifications/initialized') {
    // no response (notification)
  } else if (msg.method === 'tools/list') {
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0', id: msg.id,
      result: { tools: [
        { name: 'read_file', description: '读文件', inputSchema: { type: 'object' } }
      ]}
    }) + '\\n');
  } else if (msg.method === 'tools/call') {
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0', id: msg.id,
      result: { content: [{ type: 'text', text: 'result: ' + JSON.stringify(msg.params.arguments) }], isError: false }
    }) + '\\n');
  }
});
`;

const tmpDir = path.join(os.tmpdir(), `ap-mcp-test-${Date.now()}`);
let fakeScriptPath: string;

beforeEach(() => {
  fs.mkdirSync(tmpDir, { recursive: true });
  fakeScriptPath = path.join(tmpDir, 'fake-mcp-server.js');
  fs.writeFileSync(fakeScriptPath, fakeServerScript);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('mcp/client', () => {
  it('connect + listTools + callTool + disconnect', async () => {
    const config: McpServerConfig = {
      id: 'test', name: 'test-mcp', version: '1.0.0',
      command: 'node', args: [fakeScriptPath],
    };
    const client = new McpClient(config);
    await client.connect();
    expect(client.isConnected).toBe(true);

    const tools = await client.listTools();
    expect(tools).toHaveLength(1);
    expect(tools[0]!.name).toBe('read_file');

    const result = await client.callTool('read_file', { path: 'test.txt' });
    expect(result.isError).toBe(false);
    expect(result.content[0]!.text).toContain('test.txt');

    await client.disconnect();
    expect(client.isConnected).toBe(false);
  }, 10000);
});
```

- [ ] **Step 4: 运行 + 提交**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/mcp/client.test.ts
git add electron/src/main/mcp/types.ts electron/src/main/mcp/client.ts electron/tests/mcp/client.test.ts
git commit -m "feat(mcp): JSON-RPC 2.0 over stdio 客户端实现"
```

---

## Task 5: MCP Host 进程池

**文件：**
- 创建: `electron/src/main/mcp/host-manager.ts`
- 创建: `electron/src/main/mcp/ipc.handlers.ts`
- 修改: `electron/src/main/ipc/index.ts`

**接口：**
- 消费: T4 的 `McpClient`
- 产出:
  - `McpHostManager` — workspace 级 MCP 进程池（同 workspace 的 agent 共享）
  - `getOrStartMcp(workspaceId, config): Promise<McpClient>`
  - `stopAllMcpForWorkspace(workspaceId): Promise<void>`
  - IPC: `mcp:list`, `mcp:start`, `mcp:callTool`, `mcp:stop`

- [ ] **Step 1: 实现 `host-manager.ts`**

```typescript
// electron/src/main/mcp/host-manager.ts
import { McpClient } from './client';
import { getDb } from '../storage/db';
import { logger } from '../logger';
import type { McpServerConfig, McpToolInfo } from './types';

// 按 workspace 分组的 MCP 客户端池
// key = `${workspaceId}:${mcpName}`
const pool = new Map<string, McpClient>();

function poolKey(workspaceId: string, mcpName: string): string {
  return `${workspaceId}:${mcpName}`;
}

export async function getOrStartMcp(workspaceId: string, config: McpServerConfig): Promise<McpClient> {
  const key = poolKey(workspaceId, config.name);
  const existing = pool.get(key);
  if (existing && existing.isConnected) return existing;

  const client = new McpClient(config);
  await client.connect();
  pool.set(key, client);
  logger.info('MCP server 已启动', { workspaceId, name: config.name });
  return client;
}

export async function listMcpTools(workspaceId: string, mcpName: string): Promise<McpToolInfo[]> {
  const key = poolKey(workspaceId, mcpName);
  const client = pool.get(key);
  if (!client || !client.isConnected) {
    throw new Error(`MCP ${mcpName} 未启动`);
  }
  return client.listTools();
}

export async function callMcpTool(
  workspaceId: string,
  mcpName: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<string> {
  const key = poolKey(workspaceId, mcpName);
  const client = pool.get(key);
  if (!client || !client.isConnected) {
    throw new Error(`MCP ${mcpName} 未启动`);
  }
  const result = await client.callTool(toolName, args);
  // 提取文本内容
  return result.content
    .filter((c) => c.type === 'text')
    .map((c) => c.text ?? '')
    .join('\n');
}

export async function stopMcp(workspaceId: string, mcpName: string): Promise<void> {
  const key = poolKey(workspaceId, mcpName);
  const client = pool.get(key);
  if (client) {
    await client.disconnect();
    pool.delete(key);
  }
}

export async function stopAllMcpForWorkspace(workspaceId: string): Promise<void> {
  const toStop: string[] = [];
  for (const [key] of pool) {
    if (key.startsWith(`${workspaceId}:`)) {
      toStop.push(key);
    }
  }
  for (const key of toStop) {
    const client = pool.get(key);
    if (client) await client.disconnect();
    pool.delete(key);
  }
}

/** 从 SQLite 获取已注册的 MCP 配置 */
export function getMcpConfig(mcpName: string): McpServerConfig | null {
  const db = getDb();
  const row = db.prepare('SELECT * FROM mcp_definitions WHERE name = ?').get(mcpName) as {
    id: string; name: string; version: string; transport: string;
    command: string; args: string; env: string;
  } | undefined;
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    version: row.version,
    command: row.command,
    args: JSON.parse(row.args),
    env: JSON.parse(row.env),
  };
}

/** 注册 MCP server 定义到 SQLite */
export function registerMcpDefinition(config: McpServerConfig): void {
  const db = getDb();
  db.prepare(
    `INSERT OR REPLACE INTO mcp_definitions (id, name, version, transport, command, args, env)
     VALUES (?, ?, ?, 'stdio', ?, ?, ?)`,
  ).run(
    config.id, config.name, config.version,
    config.command, JSON.stringify(config.args), JSON.stringify(config.env ?? {}),
  );
  logger.info('MCP 定义已注册', { name: config.name });
}
```

- [ ] **Step 2: 实现 IPC handlers + 注册**

```typescript
// electron/src/main/mcp/ipc.handlers.ts
import { ipcMain } from 'electron';
import { logger } from '../logger';
import { getOrStartMcp, listMcpTools, callMcpTool, stopMcp, registerMcpDefinition, getMcpConfig } from './host-manager';

export function registerMcpHandlers(): void {
  ipcMain.handle('mcp:register', async (_evt, config) => {
    registerMcpDefinition(config);
    return;
  });

  ipcMain.handle('mcp:start', async (_evt, workspaceId: string, mcpName: string) => {
    const config = getMcpConfig(mcpName);
    if (!config) throw new Error(`MCP ${mcpName} 未注册`);
    await getOrStartMcp(workspaceId, config);
    return;
  });

  ipcMain.handle('mcp:listTools', async (_evt, workspaceId: string, mcpName: string) => {
    return listMcpTools(workspaceId, mcpName);
  });

  ipcMain.handle('mcp:callTool', async (_evt, workspaceId: string, mcpName: string, toolName: string, args) => {
    return callMcpTool(workspaceId, mcpName, toolName, args);
  });

  ipcMain.handle('mcp:stop', async (_evt, workspaceId: string, mcpName: string) => {
    await stopMcp(workspaceId, mcpName);
    return;
  });

  logger.info('MCP IPC handlers 已注册');
}
```

在 `ipc/index.ts` 中添加 `registerMcpHandlers()`。

- [ ] **Step 3: 提交**

```bash
npx pnpm@9.0.0 typecheck
git add electron/src/main/mcp/ electron/src/main/ipc/index.ts
git commit -m "feat(mcp): workspace 级 MCP 进程池 + IPC handlers"
```

---

## Task 6: Skill 解析器 + Registry

**文件：**
- 创建: `electron/src/main/skill/types.ts`
- 创建: `electron/src/main/skill/loader.ts`
- 创建: `electron/src/main/skill/registry.ts`
- 测试: `electron/tests/skill/loader.test.ts`, `electron/tests/skill/registry.test.ts`

**接口：**
- 产出:
  - `SkillFrontmatter` — SKILL.md YAML frontmatter 类型
  - `SkillDefinition` — 完整 skill 定义
  - `parseSkillMd(content): SkillDefinition` — 解析 SKILL.md
  - `SkillRegistry` 类 — `register(cachePath)`, `getIndex(): string`（system prompt 注入用）, `loadFull(slug): string`（正文）, `loadResource(slug, path): string`

- [ ] **Step 1: 创建 `skill/types.ts`**

```typescript
// electron/src/main/skill/types.ts

/** SKILL.md 的 YAML frontmatter */
export interface SkillFrontmatter {
  name: string;
  description: string;
  version: string;
  allowedTools?: string[];
  tags?: string[];
}

/** 完整 skill 定义 */
export interface SkillDefinition extends SkillFrontmatter {
  id: string;
  slug: string;
  cachePath: string;
  body: string; // Markdown 正文（不含 frontmatter）
}
```

- [ ] **Step 2: 实现 `skill/loader.ts`**

```typescript
// electron/src/main/skill/loader.ts
import { load as yamlLoad } from 'js-yaml';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { SkillDefinition, SkillFrontmatter } from './types';

/** 解析 SKILL.md 内容为 SkillDefinition */
export function parseSkillMd(content: string, cachePath: string): SkillDefinition {
  // 分离 YAML frontmatter 和 Markdown body
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) {
    throw new Error('SKILL.md 格式错误：缺少 YAML frontmatter（--- 包围）');
  }

  const [, yamlText, body] = match;
  const fm = yamlLoad(yamlText) as SkillFrontmatter;

  // 校验必填字段
  if (!fm.name) throw new Error('SKILL.md frontmatter 缺少 name');
  if (!fm.description) throw new Error('SKILL.md frontmatter 缺少 description');

  return {
    id: randomUUID(),
    slug: fm.name,
    name: fm.name,
    description: fm.description,
    version: fm.version ?? '1.0.0',
    allowedTools: fm.allowedTools ?? [],
    tags: fm.tags ?? [],
    cachePath,
    body: body.trim(),
  };
}

/** 读取 skill 目录下的附加资源文件 */
export function readSkillResource(cachePath: string, resourcePath: string): string {
  const { readFileSync } = require('node:fs') as { readFileSync: typeof import('node:fs').readFileSync };
  const fullPath = path.join(cachePath, resourcePath);
  return readFileSync(fullPath, 'utf-8');
}
```

- [ ] **Step 3: 实现 `skill/registry.ts`**

```typescript
// electron/src/main/skill/registry.ts
import fs from 'node:fs';
import path from 'node:path';
import { parseSkillMd, readSkillResource } from './loader';
import type { SkillDefinition } from './types';
import { logger } from '../logger';

/**
 * Skill 注册表。管理已安装的 skill 包。
 *
 * 渐进式披露三层模型：
 *   Layer 1: getIndex() — frontmatter 摘要（~100 tokens/skill），注入 system prompt
 *   Layer 2: loadFull(slug) — 完整 SKILL.md 正文（~2-3k tokens），LLM 主动调 loadSkill 加载
 *   Layer 3: loadResource(slug, path) — 附加资源文件，LLM 主动调 readResource 读取
 */
export class SkillRegistry {
  private skills = new Map<string, SkillDefinition>();

  /** 注册一个 skill 目录（包含 SKILL.md） */
  register(cachePath: string): SkillDefinition {
    const skillMdPath = path.join(cachePath, 'SKILL.md');
    if (!fs.existsSync(skillMdPath)) {
      throw new Error(`SKILL.md 不存在: ${skillMdPath}`);
    }
    const content = fs.readFileSync(skillMdPath, 'utf-8');
    const def = parseSkillMd(content, cachePath);
    this.skills.set(def.slug, def);
    logger.info('Skill 已注册', { slug: def.slug, name: def.name });
    return def;
  }

  /** 获取所有已注册 skill 的索引（Layer 1 — 注入 system prompt） */
  getIndex(): string {
    const lines: string[] = [];
    for (const [, def] of this.skills) {
      lines.push(`- ${def.name} v${def.version}: ${def.description}`);
    }
    return lines.join('\n');
  }

  /** 加载完整 SKILL.md 正文（Layer 2 — LLM 通过 loadSkill 虚拟工具触发） */
  loadFull(slug: string): string {
    const def = this.skills.get(slug);
    if (!def) throw new Error(`Skill 不存在: ${slug}`);
    return def.body;
  }

  /** 读取附加资源文件（Layer 3 — LLM 通过 readResource 虚拟工具触发） */
  loadResource(slug: string, resourcePath: string): string {
    const def = this.skills.get(slug);
    if (!def) throw new Error(`Skill 不存在: ${slug}`);
    return readSkillResource(def.cachePath, resourcePath);
  }

  /** 检查 skill 是否已注册 */
  has(slug: string): boolean {
    return this.skills.has(slug);
  }

  /** 列出所有已注册 skill */
  list(): SkillDefinition[] {
    return Array.from(this.skills.values());
  }
}
```

- [ ] **Step 4: 写测试**

```typescript
// electron/tests/skill/loader.test.ts
import { describe, it, expect } from 'vitest';
import { parseSkillMd } from '../../src/main/skill/loader';

const VALID_SKILL_MD = `---
name: code-review-workflow
description: 执行标准的代码审查流程
version: 1.0.0
allowedTools:
  - read_file
  - write_file
tags:
  - code-review
  - security
---

# 代码审查工作流

## 步骤
1. 读取代码文件
2. 检查安全漏洞
3. 输出审查报告
`;

describe('skill/loader', () => {
  it('parseSkillMd 解析 frontmatter + body', () => {
    const def = parseSkillMd(VALID_SKILL_MD, '/cache/code-review');
    expect(def.slug).toBe('code-review-workflow');
    expect(def.description).toBe('执行标准的代码审查流程');
    expect(def.version).toBe('1.0.0');
    expect(def.allowedTools).toEqual(['read_file', 'write_file']);
    expect(def.body).toContain('# 代码审查工作流');
    expect(def.body).toContain('读取代码文件');
  });

  it('缺少 frontmatter 抛错', () => {
    expect(() => parseSkillMd('just markdown', '/cache')).toThrow('frontmatter');
  });

  it('缺少 name 抛错', () => {
    const bad = `---
description: test
---
body`;
    expect(() => parseSkillMd(bad, '/cache')).toThrow('name');
  });
});
```

```typescript
// electron/tests/skill/registry.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SkillRegistry } from '../../src/main/skill/registry';

const tmpDir = path.join(os.tmpdir(), `ap-skill-test-${Date.now()}`);

beforeEach(() => {
  fs.mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

import { afterEach } from 'vitest';

describe('skill/registry', () => {
  it('register + getIndex + loadFull 三层渐进式披露', () => {
    // 创建测试 skill 目录
    const skillDir = path.join(tmpDir, 'test-skill');
    fs.mkdirSync(skillDir);
    fs.writeFileSync(
      path.join(skillDir, 'SKILL.md'),
      '---\nname: test-skill\ndescription: 测试技能\nversion: 1.0.0\n---\n\n# 正文内容\n步骤1',
    );

    const registry = new SkillRegistry();
    registry.register(skillDir);

    // Layer 1: 索引
    const index = registry.getIndex();
    expect(index).toContain('test-skill');
    expect(index).toContain('测试技能');

    // Layer 2: 正文
    const body = registry.loadFull('test-skill');
    expect(body).toContain('正文内容');

    // 检查
    expect(registry.has('test-skill')).toBe(true);
    expect(registry.has('nonexistent')).toBe(false);
  });

  it('loadFull 不存在的 skill 抛错', () => {
    const registry = new SkillRegistry();
    expect(() => registry.loadFull('nope')).toThrow('不存在');
  });
});
```

- [ ] **Step 5: 运行 + 提交**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/skill/
git add electron/src/main/skill/ electron/tests/skill/
git commit -m "feat(skill): SKILL.md 解析器 + SkillRegistry 渐进式披露"
```

---

## Task 7-15: 后续任务大纲

### Task 7: Agent runtime 集成 dispatch + MCP + skill

**修改：** `runtime-entry.ts` + `builtin-tools.ts` + `chat-loop.ts`

**要点：**
- `builtin-tools.ts` 添加 `loadSkill` 和 `readResource` 虚拟工具
- `builtin-tools.ts` 添加 `dispatch:<sub-slug>` 虚拟工具（主 agent 调度子 agent）
- chat loop 处理 dispatch event（收到 → 执行 → 回复 task_reply）
- chat loop 处理 MCP 工具调用（通过 IPC 路由到主进程 MCP Host）
- system prompt 注入 skill 索引（Layer 1）
- 工具列表合并：builtin + MCP tools（从 listMcpTools 拉）+ loadSkill/readResource 虚拟工具

### Task 8: workspace allocation CRUD + IPC

**创建：** `workspace/allocation.ts` + IPC handlers

**要点：**
- `getAllocation(workspaceId): { tools, mcps, skills }` — 从 workspace_allocations 表读取
- `addAllocation(workspaceId, type, ref)` / `removeAllocation(workspaceId, type, ref)` — 增删
- IPC: `allocation:get`, `allocation:add`, `allocation:remove`

### Task 9: 三层能力叠加合并逻辑

**创建：** `agent/capability-merger.ts`

**要点：**
- `mergeCapabilities(def, allocation, extra): { tools, mcps, skills }`
- 合并规则：defaultTools ∪ allocation.tools ∪ extraTools（同名取最具体层）
- 工具名冲突自动 namespace（mcpname.tool）

### Task 10: dispatch/task_reply UI 卡片

**创建：** `renderer/src/components/im/DispatchCard.tsx`, `TaskReplyCard.tsx`

**要点：**
- MessageList 检测 event type，dispatch 渲染紫色卡片，task_reply 渲染绿色/红色卡片
- 卡片显示：from → to、task_id、body、status

### Task 11: tool_result 消息渲染

**创建：** `renderer/src/components/im/ToolResultCard.tsx`

**要点：**
- 折叠卡片显示工具调用（tool name、duration、success/fail）
- 点击展开看详细 input/output

### Task 12: 能力配置 UI

**创建：** `renderer/src/components/agent/CapabilityConfig.tsx` + `capability.store.ts`

**要点：**
- 显示三层能力（default / workspace / extra）
- 添加/移除 workspace 级 allocation
- 添加/移除 agent extra 能力

### Task 13: 主子 agent demo YAML

**创建：** `electron/resources/agents/pm-agent.yaml` + sub agents

**要点：**
- pm-agent（main）: 系统提示是项目经理，调度 sub agents
- sub agents: requirement-analyst + coder（已有 M1，改为 parentAgentId 指向 pm-agent）

### Task 14: IM 自定义 event type 同步

**修改：** `sync-manager.ts` + `im.store.ts`

**要点：**
- sync-manager 除了 m.room.message 也监听 io.agentplatform.dispatch / task_reply
- 推送到 renderer 时附带 event type
- im.store 按 type 分类存储

### Task 15: 端到端集成

**修改：** 多个文件

**要点：**
- 创建 workspace → 添加 pm-agent（自动跟随 sub agents）
- 在 IM @pm-agent → pm-agent dispatch → sub agent 执行 → task_reply
- agent 用 MCP 工具（如 filesystem MCP）
- agent 用 skill（loadSkill 加载 code-review-workflow）

---

## 自审

### Spec 覆盖

| Spec M2 要求 | 对应 Task |
|---|---|
| 主子 agent 关系 + dispatch via IM | T1-T3, T7 |
| 自定义消息类型 dispatch/task_reply | T3, T10, T14 |
| MCP stdio transport | T4-T5 |
| MCP 工具调用流程 | T5, T7 |
| tool_result 消息渲染 | T11 |
| Skill 包格式 + SkillRegistry | T6 |
| loadSkill / readResource 虚拟工具 | T6, T7 |
| 三层能力叠加 | T8-T9 |
| Agent 配置 UI | T12 |

### 验收标准

- ✅ 主 agent (pm-agent) 能调度子 agent (requirement-analyst, coder)
- ✅ dispatch/task_reply 消息在 IM 中正确渲染
- ✅ agent 能调用 MCP 工具（如 filesystem MCP 的 read_file）
- ✅ agent 能用 skill（loadSkill 加载知识包正文，按指令组织工具调用）
- ✅ workspace 级能力分配可配置
