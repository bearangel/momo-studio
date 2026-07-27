# AgentPlatform 详细设计文档

| 字段 | 值 |
|---|---|
| 文档版本 | v1.0 |
| 创建日期 | 2026-07-28 |
| 状态 | Draft (待用户审核) |
| 作者 | Sisyphus (基于用户需求细化) |
| 关联需求 | 用户提供的"分布式 agent 平台"原始描述 |

---

## 0. 摘要

AgentPlatform 是一个**个人桌面端的多 agent 协作平台**。用户在本地创建 workspace，配置多个 agent（含主子关系），通过类 IM 界面与 agent 对话、调度 agent 完成任务。Agent 通过子进程方式运行，受 OS 级沙箱隔离，限定在 workspace 目录内工作。多用户可通过 P2P 协作（共享 homeserver + Git 同步文件）共同参与 workspace。平台内置 MCP / Skill / Agent 三类 marketplace 生态。

**核心定位**：本地优先的 agent 编排平台。不是云 SaaS，不是企业级，是开发者桌面工具。

**核心架构选择**：

| 维度 | 决策 |
|---|---|
| 产品形态 | 个人桌面应用 |
| 技术栈 | Electron + React + Node.js |
| 协作模式 | P2P 协作，IM 通讯，Git 同步文件 |
| Agent 运行时 | 子进程 + OS 级隔离（namespace/sandbox-exec） |
| Agent 定义模型 | **三种 runtime**：declarative（YAML）/ programmatic（代码 + SDK）/ external（桥接 OpenCode/Codex 等） |
| IM 范围 | 全 IM（人↔人 / 人↔agent / agent↔agent）— 兼任编排总线 |
| 网络拓扑 | 中心发现服务（Matrix homeserver）+ 可选中继 |
| 主子 Agent | 所有权关系，调度走 IM @ 消息 |
| IM 协议 | Matrix（用 Conduit 作 homeserver） |

> **v1 范围**：仅 declarative runtime。programmatic + external 放 v2（详见第 13 节）。

---

## 1. 系统总览

### 1.1 高层架构图

```
┌─────────────────────────────────────────────────────────────────┐
│                     协调服务器（可选, 可云可本地）                │
│  ┌──────────────────┐  ┌─────────────────┐  ┌────────────────┐  │
│  │ Matrix Homeserver│  │ Git Bare Repo   │  │ Marketplace    │  │
│  │ (Conduit, Rust)  │  │ Service         │  │ REST API       │  │
│  │ - 用户/agent 账号│  │ (HTTPS+token)   │  │ (MCP/Skills/   │  │
│  │ - 消息存储/中继  │  │                 │  │  Agent 上传)   │  │
│  │ - 鉴权/presence  │  │                 │  │                │  │
│  └──────────────────┘  └─────────────────┘  └────────────────┘  │
└────────────────┬───────────────────┬─────────────────┬──────────┘
                 │ Matrix /sync      │ git push/pull   │ REST
                 │ (WebSocket/HTTPS) │                 │
        ┌────────┴────────┐  ┌───────┴───────┐  ┌─────┴──────┐
        │                 │  │               │  │            │
┌───────▼─────────┐ ┌─────▼──────┐ ┌─────────▼──┐ ┌────────▼──┐
│  Peer A 桌面端  │ │ Peer B     │ │ Peer C     │ │ 浏览器(商城)│
│  Electron       │ │ 桌面端     │ │ 桌面端     │ │ (可选)     │
│  ┌───────────┐  │ │            │ │            │ └────────────┘
│  │ React UI  │  │ │            │ │            │
│  │ - IM 视图 │  │ │            │ │            │
│  │ - 文件树  │  │ │            │ │            │
│  │ - 编辑器  │  │ │            │ │            │
│  │ - 配置面板│  │ │            │ │            │
│  └───────────┘  │ │            │ │            │
│  ┌───────────┐  │ │            │ │            │
│  │ Node 主进程│  │ │            │ │            │
│  │ - Matrix  │  │ │            │ │            │
│  │   client  │  │ │            │ │            │
│  │ - Agent   │  │ │            │ │            │
│  │   runtime │  │ │            │ │            │
│  │ - Git     │  │ │            │ │            │
│  │   ops     │  │ │            │ │            │
│  └───────────┘  │ │            │ │            │
│  ┌───────────┐  │ │            │ │            │
│  │ 子进程群  │  │ │            │ │            │
│  │ - Agent A │  │ │            │ │            │
│  │ - Agent B │  │ │            │ │            │
│  │ - MCP x N │  │ │            │ │            │
│  │ - Skill   │  │ │            │ │            │
│  │   runner  │  │ │            │ │            │
│  └───────────┘  │ │            │ │            │
└─────────────────┘ └────────────┘ └────────────┘
   本地文件系统：   本地文件系统     本地文件系统
   ~/AgentPlat/    ~/AgentPlat/    ~/AgentPlat/
     workspaces/     workspaces/     workspaces/
     agents/         agents/         agents/
     cache/          cache/          cache/
```

### 1.2 模块边界（13 个核心模块）

| 模块 | 职责 | 跨界接口 |
|---|---|---|
| **Desktop Shell** | Electron 主进程、窗口管理、生命周期 | IPC to renderer |
| **UI Layer** | React 视图（IM / 文件 / 编辑器 / 配置 / 商城） | IPC + State store |
| **Matrix Client** | 与 homeserver 通讯（matrix-js-sdk） | Event bus |
| **Agent Runtime** | Agent 子进程生命周期、消息路由 | IPC + Matrix |
| **MCP Host** | MCP server 进程池、工具调用 | stdio JSON-RPC (MCP) / HTTP / SSE |
| **Skill Registry** | Skill 包加载、按需注入 LLM context | FS + LLM context |
| **Workspace Mgr** | Workspace 创建、目录映射、Git 操作 | FS + Git |
| **Git Service** | clone/pull/push/commit/conflict 处理 | libgit2 (nodegit) |
| **Plugin Manager** | Marketplace 下载、本地安装、版本管理 | HTTP + FS |
| **Identity/Key Store** | 用户密钥、agent bot 凭证 | OS keychain |
| **State Persistence** | 本地配置、运行时状态 | SQLite (better-sqlite3) |
| **Sync Engine** | 离线队列、冲突处理、推送通知 | Queue + Matrix |
| **Coordination Server** | Conduit + Git server + Marketplace API | 独立部署 |

### 1.3 部署形态

**独立模式（默认）**：
- 用户安装桌面端
- 内置一个 Conduit 实例（随 Electron 启动）— 仅本机访问
- 所有 agent bot 账号注册在本地 Conduit
- 文件 Git 仓库存在本地
- 没有外网依赖，开箱即用

**协作模式**：
- 一台机器跑独立 Conduit + Git server + Marketplace（"主机"）
- 其他人安装桌面端，配置指向"主机"地址
- 主机可以是云服务器、家中 NAS、或某一台桌面机

**云模式（未来）**：
- 官方提供云协调服务器
- 用户登录后即可与其他用户协作

---

## 2. 进程与运行时模型

### 2.1 进程拓扑

```
Electron Main Process (Node.js)
├── 主应用逻辑
│   ├── Matrix Client (matrix-js-sdk, 长连接到 homeserver)
│   ├── Workspace Manager (FS 操作)
│   ├── Git Service (nodegit / 调用 git CLI)
│   ├── Plugin Manager (marketplace 交互)
│   ├── Identity Store (调 OS keychain)
│   ├── State DB (better-sqlite3, 同进程内嵌)
│   └── IPC Router (与 renderer 通讯)
│
├── Agent Runtime Pool (每个 agent 一个子进程)
│   ├── Agent 子进程 #1 (Node.js worker)
│   │   ├── system prompt + 配置
│   │   ├── LLM client (调用 OpenAI/Ollama/etc.)
│   │   └── Matrix client (用 agent bot 账号登录)
│   ├── Agent 子进程 #2
│   └── ...
│
├── MCP Host Pool (每个 stdio MCP 一个子进程)
│   ├── MCP server #1 (例如 filesystem MCP)
│   ├── MCP server #2 (例如 git MCP)
│   └── ...
│
├── Skill Script Runner (按需 spawn)
│   └── 仅当 LLM 决定执行 skill 包内的脚本时 spawn; 执行完即退出
│       (注意: Skill 本身不是可执行单元, 是 SKILL.md 知识包;
│        但 skill 包可包含 parse_pdf.py 等脚本资源,
│        LLM 通过 builtin:skill.execute_script 虚拟工具调用)
│
└── (可选) 内置 Conduit
    └── 独立子进程, Rust 二进制, 监听 127.0.0.1:port

Renderer Process (React)
├── UI 视图
└── 通过 IPC 调主进程
```

### 2.2 进程职责矩阵

| 进程 | 数量 | 生命周期 | 隔离方式 | 文件访问范围 |
|---|---|---|---|---|
| Electron Main | 1 | 应用启动→退出 | - | 全用户目录 |
| Renderer | 1 (可多窗口) | 窗口开关 | Electron sandbox | 仅通过 IPC |
| Agent 子进程 | N (每 agent 1) | workspace 打开→关闭 | OS user + bind-mount | **仅当前 workspace 目录** |
| MCP server (stdio) | N | agent 启动→关闭 | OS user + bind-mount | 配置指定路径（默认 workspace） |
| Skill Script Runner | 短任务（按需） | LLM 调 builtin:skill.execute_script 时 spawn；执行完即退 | OS user + bind-mount | **仅当前 workspace 目录** |
| Conduit (内置) | 0 或 1 | 应用启动→退出 | 独立二进制 | 仅自己数据目录 |

> **说明**：Skill 包本身（SKILL.md）不是可执行单元，是注入 LLM context 的知识。但 skill 包**可包含**脚本资源（如 `parse_pdf.py`），LLM 在需要时通过 `builtin:skill.execute_script` 工具触发其执行（受沙箱限制）。详见第 7 节。

### 2.3 关键设计决策

**1. 为什么 Agent 是独立子进程（而不是 worker thread）？**
- **崩溃隔离**：agent 无限循环 / OOM / 死锁不影响主应用
- **OS 级权限隔离**：可通过 `chroot`/`bind-mount`/`prctl` 限制只能访问 workspace 目录，即便 agent 被 prompt injection 也不能逃逸
- **可独立重启**：某 agent 卡死可单独 kill + 重启
- **资源限制**：可对单 agent 设 CPU/内存上限（cgroups on Linux，job objects on Windows）

**2. 为什么每个 Agent 自己有一个 Matrix client？**
- Agent bot 账号独立鉴权（自己的 access_token）
- 简化消息路由：消息直接发给目标 agent bot，主进程不解析
- 缺点：N 个 agent = N 个 Matrix 长连接；优化：共享 homeserver 连接池，仅 /sync 分流

**3. 主进程 ↔ Agent 子进程 通讯**
- **Matrix 是首选通讯通道**（人/agent 都互通的设计目标）
- **辅助 IPC**：仅用于生命周期管理（启动/停止/健康检查/配置更新），用 JSON over Unix domain socket 或 Node.js `child_process.fork` 内置 IPC
- LLM 调用、tool 调用、agent↔agent 协调**全走 Matrix**，便于审计、回放、跨 peer 协作

**4. 沙箱实现（按 OS）**

| OS | 文件隔离 | 进程隔离 | 资源限制 |
|---|---|---|---|
| **Linux** | `bind-mount` + `mount namespace` + `chroot` | PID namespace | cgroups v2 |
| **macOS** | `sandbox-exec` (Seatbelt profile) | sandbox-exec | `taskpolicy` / `nice` |
| **Windows** | `Job Object` + 受限 token + `AppContainer` | Job Object | Job Object limits |

抽象出 `SandboxProvider` 接口，按平台分发实现。v1 可先做 Linux/macOS，Windows 后续。

### 2.4 Agent 子进程内部结构

```typescript
// Agent 子进程入口 (伪代码)
class AgentProcess {
  // 启动时载入
  manifest: AgentManifest;        // 来自 YAML 配置
  matrixClient: MatrixClient;     // 用 bot 账号登录
  llmProvider: LLMProvider;       // OpenAI / Anthropic / Ollama / ...
  mcpClients: MCPClient[];        // stdio / HTTP / SSE
  skillRegistry: SkillRegistry;   // 已安装 skills
  
  // 主循环
  async onMatrixMessage(msg: MatrixEvent) {
    if (isMentionOfMe(msg) || isDirectMessage(msg)) {
      const ctx = buildContext(msg);            // 历史 + workspace 文件
      const systemPrompt = await buildSystemPrompt({
        base: this.manifest.systemPrompt,
        skillIndex: this.skillRegistry.getIndex(),   // 第 1 层渐进式披露 (skill 元数据)
      });
      const response = await this.llm.chat({
        system: systemPrompt,
        messages: ctx,
        tools: gatherTools(),                    // builtin + MCP tools
                                                     // + 虚拟工具 loadSkill / readResource
                                                     // (skills 通过这些虚拟工具按需注入 context,
                                                     //  不是被调用为常规 tool. 详见第 7 节)
      });
      await this.matrixClient.reply(msg, response);
    }
  }
}
```

**关键约束**：Agent 子进程的**所有文件操作**都经过一个 `WorkspaceFS` 抽象，该抽象在内部强制 path 都在 `workspace_dir` 之内。这是一个 belt-and-suspenders（除了 OS 沙箱外的应用层防线）。

---

## 3. 数据模型

### 3.1 实体关系图（概念层）

```
┌────────────┐         ┌──────────────┐         ┌────────────┐
│   User     │◄─M:N───►│  Workspace   │◄─M:N───►│   Agent    │
│ (Matrix    │ members │ (Space)      │ assign  │ Definition │
│  user)     │         │  - dir map   │         │ (template) │
└────────────┘         │  - git remote│         └─────┬──────┘
       │               └──────┬───────┘               │
       │                      │                       │ owner_of
       │               ┌──────┴───────┐               ▼
       │               │AgentAssignment│◀──────┌──────────────┐
       │               │ (per-workspace│       │   Sub Agent  │
       │               │  per-agent    │       │   Definition │
       │               │  instance)    │       └──────────────┘
       │               └──────┬───────┘
       │                      │
       │               ┌──────┴───────┐
       │               │ Workspace    │
       │               │ Allocations  │  (workspace-level
       │               │ - tools      │   tools/mcps/skills,
       │               │ - mcps       │   inheritable by agents)
       │               │ - skills     │
       │               └──────────────┘
       ▼
┌────────────┐
│Conversation│  (Matrix rooms / threads)
│  Message   │
└────────────┘
       ▲
       │ produced by
┌──────┴───────┐
│  Marketplace │  (coordination server)
│   Items     │   - agents, mcps, skills
└──────┬───────┘   - versions, authors
       │ install
       ▼
┌────────────┐
│ Local Cache│  (FS: ~/.agent-platform/cache/)
│  - Agent   │
│    pkg     │
│  - MCP pkg │
│  - Skill   │
│    pkg     │
└────────────┘
```

### 3.2 核心实体定义（TypeScript 风格）

```typescript
// ============ 用户与身份 ============
interface User {
  matrixUserId: string;        // @alice:home.server
  displayName: string;
  avatarMxc?: string;          // Matrix mxc:// URL
  publicKey: string;           // Ed25519, 用于消息签名验证
}

// ============ 工作空间 ============
interface Workspace {
  id: string;                  // UUID, 本地生成
  name: string;
  description?: string;
  matrixSpaceId: string;       // Matrix Space room ID (!xxx:home.server)
  directoryPath: string;       // 本地绝对路径
  gitRemoteUrl: string;
  createdAt: string;
  ownerUserId: string;
  iconEmoji?: string;
}

interface WorkspaceMember {
  workspaceId: string;
  matrixUserId: string;
  role: 'owner' | 'collaborator' | 'viewer';
  addedAt: string;
}

// ============ Agent 定义（template）============
interface AgentDefinition {
  id: string;
  name: string;
  slug: string;
  version: string;
  
  type: 'main' | 'sub' | 'standalone';
  parentAgentId?: string;
  
  // === 关键扩展: 三种 runtime 类型 ===
  runtime: 'declarative' | 'programmatic' | 'external';
  
  // Case 1: declarative (YAML 配置式, 原始模型, 适合简单 agent)
  declarative?: {
    systemPrompt: string;
    model: ModelRef;
    temperature?: number;
    maxTokens?: number;
  };
  
  // Case 2: programmatic (代码式, 实现 Agent SDK 接口)
  programmatic?: {
    language: 'typescript' | 'python';
    entry: string;              // 主入口文件 (相对 manifest)
    sdkVersion: string;         // 兼容的 Agent SDK 版本
    env?: Record<string, string>;
  };
  
  // Case 3: external (桥接外部 agent 运行时, 如 OpenCode/Codex)
  external?: {
    platform: 'opencode' | 'codex' | 'claude-code' | 'custom';
    bridge: {
      type: 'subprocess' | 'http' | 'websocket' | 'stdio_json';
      // subprocess: 启动外部进程, 通过 stdin/stdout JSON 通信
      command?: string[];
      cwd?: string;
      // http/websocket: 远端服务, 通过网络通信
      url?: string;
      authType?: 'none' | 'bearer' | 'apikey';
      authTokenRef?: string;
    };
    // 桥接模式: 我们只做 Matrix <-> External 协议转换
    capabilities: {
      supportsThreads: boolean;
      supportsToolCallEvents: boolean;
      supportsStreaming: boolean;
    };
  };
  
  // === 共享配置 (所有 runtime 类型) ===
  defaultTools: ToolRef[];
  defaultMcps: McpRef[];
  defaultSkills: SkillRef[];
  
  source: 'builtin' | 'marketplace' | 'custom';
  marketplaceItemId?: string;
  
  author?: { matrixUserId: string; displayName: string };
  description?: string;
  iconEmoji?: string;
  tags?: string[];
}

// ============ Agent 在 workspace 中的实例化 ============
interface AgentAssignment {
  workspaceId: string;
  agentDefinitionId: string;
  instanceId: string;
  
  botMatrixUserId: string;
  
  extraTools: ToolRef[];
  extraMcps: McpRef[];
  extraSkills: SkillRef[];
  
  overrideSystemPrompt?: string;
  overrideModel?: ModelRef;
  
  enabled: boolean;
  createdAt: string;
}

// ============ 工作空间级能力分配 ============
interface WorkspaceAllocation {
  workspaceId: string;
  tools: ToolRef[];
  mcps: McpRef[];
  skills: SkillRef[];
}

// ============ 工具与模型引用 ============
interface ToolRef {
  kind: 'builtin' | 'mcp' | 'skill';
  ref: string;
}

interface ModelRef {
  provider: 'openai' | 'anthropic' | 'google' | 'ollama' | 'lmstudio' | 'custom';
  model: string;
  apiKeyRef?: string;
  baseUrl?: string;
}

// ============ MCP（多 transport）============
interface McpDefinition {
  id: string;
  name: string;
  version: string;
  
  transport: 'stdio' | 'http' | 'sse';
  
  stdio?: {
    command: string;
    args: string[];
    env?: Record<string, string>;
    packageSpec: string;
  };
  
  remote?: {
    url: string;
    authType: 'none' | 'bearer' | 'apikey' | 'oauth';
    authTokenRef?: string;
    headers?: Record<string, string>;
  };
  
  capabilities: string[];
  marketplaceItemId?: string;
}

// ============ Skill（知识包，非可执行）============
interface SkillDefinition {
  id: string;
  name: string;
  version: string;
  
  // Skill 是 SKILL.md + 可选资源文件
  // 通过渐进式披露注入 LLM context（不是被调用为 tool）
  
  // 元数据来自 SKILL.md 的 frontmatter
  description: string;
  allowedTools?: string[];      // 此 skill 引用的工具白名单（软约束）
  tags?: string[];
  
  // 本地路径
  cachePath: string;            // 解压后的目录
  marketplaceItemId?: string;
}

// ============ 对话消息（基于 Matrix event）============
interface ConversationMessage {
  matrixEventId: string;
  matrixRoomId: string;
  senderMatrixUserId: string;
  senderType: 'human' | 'agent';
  
  body: string;
  messageType: 'chat' | 'system' | 'dispatch' | 'tool_result' | 'file_event';
  
  threadId?: string;
  replyTo?: string;
  mentions?: string[];
  
  attachments?: Attachment[];
  metadata?: object;
  
  timestamp: string;
}

interface Attachment {
  type: 'file' | 'image' | 'agent_artifact' | 'diff';
  mxcUrl: string;
  fileName: string;
  mimeType: string;
  size: number;
}

// ============ 插件安装记录 ============
interface PluginInstallation {
  id: string;
  workspaceId?: string;
  type: 'agent' | 'mcp' | 'skill';
  definitionId: string;
  
  installedFrom: 'marketplace' | 'local_file' | 'git_url';
  marketplaceItemId?: string;
  installedAt: string;
}

// ============ Marketplace 条目 ============
interface MarketplaceItem {
  id: string;
  type: 'agent' | 'mcp' | 'skill';
  slug: string;
  name: string;
  version: string;
  author: { matrixUserId: string; displayName: string };
  
  description: string;
  readme: string;
  iconUrl?: string;
  tags: string[];
  
  distribution: 
    | { kind: 'package'; downloadUrl: string; checksum: string; sizeBytes: number; runtime?: 'node' | 'python' | 'binary' }
    | { kind: 'remote_service'; serviceUrl: string; transport: 'http' | 'sse'; authGuide: string };
  
  installCount: number;
  ratingSum: number;
  ratingCount: number;
  
  verificationStatus: 'unverified' | 'community' | 'verified' | 'official';
  reviewStatus: 'pending' | 'approved' | 'rejected' | 'hidden';
  
  publishedAt: string;
  updatedAt: string;
}
```

### 3.3 能力叠加规则（关键）

Agent 实际可用能力 = **三层叠加**：

```
EffectiveTools(agent_assignment) 
  = AgentDefinition.defaultTools       // 第 1 层: agent 模板预设
  ∪ WorkspaceAllocation.tools          // 第 2 层: workspace 公共池
  ∪ AgentAssignment.extraTools         // 第 3 层: 该实例额外配置

（MCP / Skills 同理）
```

**冲突解决**：
- 同名 MCP 在多层出现 → 取最具体层（assignment > workspace > definition）
- 工具名冲突（如两个 MCP 都有 `read_file`）→ 自动加 namespace 前缀 `mcpname.read_file`

### 3.4 存储分布

| 数据 | 存储位置 | 技术 |
|---|---|---|
| Workspace / AgentAssignment / WorkspaceAllocation 配置 | 本地 | SQLite (`state.db`) |
| AgentDefinition / McpDefinition / SkillDefinition | 本地 FS | YAML 文件（`~/.agent-platform/definitions/`） |
| 安装的 MCP/Skill 包 | 本地 FS | `~/.agent-platform/cache/{mcp,skill}/<name>/<version>/` |
| 用户密钥 / API key / Matrix token | OS Keychain | macOS Keychain / Windows Credential Manager / Linux libsecret |
| 对话消息（所有 H↔H, H↔A, A↔A） | Matrix Homeserver | Conduit 内部存储 |
| Workspace 文件 | 本地 FS + Git | workspace 目录 + bare repo on 协调服务器 |
| Marketplace 元数据 | 协调服务器 | REST API + 后端 DB |

### 3.5 关键设计决策

**1. AgentDefinition 与 AgentAssignment 分离**
- "Agent 定义" 是模板（可被复用、可上架 marketplace）
- "Agent Assignment" 是模板在具体 workspace 的实例化
- 这样：同一个 agent 定义可以装到多个 workspace，每个 workspace 配不同的 extra tools / 覆盖 system prompt

**2. 主子关系是 AgentDefinition 层的属性，不是实例层**
- 一个 sub agent 定义"归属于"一个 main agent 定义
- 装到 workspace 时，main 自带的 sub 自动跟随安装（也可手动选子集）
- 用户在 workspace 中可以**只装 main agent**，子 agent 自动激活；或**显式禁用**某些子

**3. 消息存储完全在 Matrix**
- 本地不持久化对话历史（避免双写一致性问题）
- 消息检索/搜索 = 调用 Matrix 的 search API
- 性能优化：matrix-js-sdk 自带 IndexedDB 缓存

**4. 配置存储用 SQLite + YAML 混合**
- 关系型数据（assignment、installation、allocation）→ SQLite（事务、JOIN）
- 定义类数据（agent/mcp/skill 模板）→ YAML 文件（人类可读、版本控制、便于 marketplace 打包）

---

## 4. 身份与权限模型

### 4.1 身份体系（三层）

```
┌──────────────────────────────────────────────────┐
│ Layer 1: Matrix 用户身份 (人)                     │
│  - @alice:home.server                            │
│  - 由 homeserver 颁发 access_token               │
│  - 密码 / OAuth 登录                              │
└──────────────────┬───────────────────────────────┘
                   │ 拥有
                   ▼
┌──────────────────────────────────────────────────┐
│ Layer 2: Agent Bot 身份 (非人)                    │
│  - @req-agent.proj-x.alice:home.server           │
│  - 命名规则: @<agent-slug>.<ws-slug>.<owner>:home │
│  - 标记: Matrix account_data 中存 'agent_of' 字段│
└──────────────────┬───────────────────────────────┘
                   │ 信任
                   ▼
┌──────────────────────────────────────────────────┐
│ Layer 3: Device / Peer 身份 (可选)                │
│  - 每台桌面端生成 Ed25519 keypair                  │
│  - 公钥发布到 Matrix user profile                  │
│  - 用于消息签名验证、P2P 直连鉴权                  │
└──────────────────────────────────────────────────┘
```

### 4.2 鉴权流程

**用户首次启动桌面端**：
1. 检查本地是否有 homeserver 配置
   - 无 → 启动内置 Conduit → 注册首个 admin 账号 → 进入
   - 有 → 询问"连接现有 homeserver" 还是"启动内置"
2. 用户登录后，客户端持有 access_token，存 OS keychain
3. （可选）生成 device keypair，公钥发布到 profile

**创建 agent 时**：
1. 用户在 UI 中创建 agent（选 definition + 配置 extra tools）
2. 客户端调 homeserver 注册 bot 账号
3. 用 bot 账号登录获取 access_token
4. 拉进 workspace Space（invite + accept）
5. 启动 agent 子进程，注入 bot token
6. （若 main agent）自动批量注册其下属 sub agent bots

### 4.3 权限模型

#### 4.3.1 用户在 workspace 中的角色

| 角色 | 能力 |
|---|---|
| **owner** | 删除 workspace、管理成员、管理所有 agent 配置、改 git remote |
| **collaborator** | 创建/修改自己的 agent 配置、读写文件、群聊 |
| **viewer** | 只读：浏览文件、查看聊天、不能配置 agent |

实现：Matrix 的 power levels（0-100）映射。

#### 4.3.2 Agent 的权限维度

```typescript
interface AgentPermissions {
  fs: {
    workspaceDir: 'read' | 'readwrite' | 'none';
    pathsOutsideWorkspace: string[];
  };
  
  network: {
    llmApi: boolean;
    mcpRemote: boolean;
    arbitraryDomains: string[];
  };
  
  dispatch: {
    canCallSubAgents: boolean;
    callableAgentIds: string[];
  };
  
  tools: {
    allowed: string[];
    denied: string[];
  };
  
  resources: {
    cpuPercent: number;
    memoryMB: number;
    monthlyTokenBudget?: number;
  };
}
```

#### 4.3.3 权限决策点

| 操作 | 决策点 | 检查内容 |
|---|---|---|
| Agent 读写 workspace 文件 | SandboxProvider + WorkspaceFS | 路径在 workspace_dir 内？ |
| Agent 调用 MCP tool | ToolRegistry | tool 在 permissions.tools.allowed 内？ |
| Agent 调度 sub agent | Agent 子进程 + IM 路由 | dispatch.canCallSubAgents && 目标 ID 在 callableAgentIds |
| Agent 调 LLM API | LLM Provider wrapper | network.llmApi && token 配额未超 |
| 用户读 workspace 文件 | Electron 主进程 IPC | Matrix power level ≥ 0 |
| 用户配置 agent | Electron 主进程 IPC | Matrix power level ≥ 50 |

### 4.4 密钥与凭证管理

**OS Keychain 统一接口**（`keytar` 库）：

```
Service: "AgentPlatform"
Account: <key-name>
Password: <secret>
```

| key-name | 内容 |
|---|---|
| `user.<matrix_user_id>.matrix_token` | 用户 Matrix access_token |
| `agent.<bot_matrix_user_id>.matrix_token` | Agent bot access_token |
| `mcp.<mcp_id>.auth_token` | 远端 MCP 鉴权 token |
| `llm.<provider>.api_key` | OpenAI/Anthropic 等 API key |
| `device.private_key` | 本机 device Ed25519 私钥 |

**永远不**：写入 SQLite、写入文件、打印到日志、通过 IPC 传给 renderer。

### 4.5 跨 peer 信任建立

```
1. Alice 邀请 Bob: 客户端调 Matrix API invite Bob 进 Space
2. Bob 接受: 客户端收到 invite, UI 显示, Bob 同意 → join Space + clone git
3. (可选) 验证 device 公钥: 双方 UI 看到对方公钥指纹, 线下核对 (类似 Signal)
```

### 4.6 关键设计决策

**1. Bot 账号是用户的"代理资产"**
- 用户创建的 agent bot 账号**归属**于该用户
- 通过 Matrix 的 `account_data` 字段标记
- 用户卸载客户端时，可选择保留 / 删除 bot 账号

**2. 权限三层检查（defense in depth）**
- **OS 沙箱**（最强）：bind-mount / sandbox-exec 限制路径
- **应用层 WorkspaceFS**（次强）：所有 FS API 强制 path 验证
- **ToolRegistry**（运行时）：tool 调用前查白/黑名单

**3. Token 配额可选**
- `monthlyTokenBudget` 让用户控制 LLM 开销
- 超额后 agent 自动暂停 + 在 IM 群里通知

**4. Matrix power level 复用**
- 不重新发明角色权限，直接用 Matrix 现有机制
- 好处：未来 federation 时跨 homeserver 权限天然一致

---

## 5. IM 系统（基于 Matrix）

### 5.1 房间结构（一个 workspace 内）

```
Matrix Space: Workspace "proj-x"
├── !team-room          (团队群, 所有人 + 所有 agent)
│   ├── 默认聊天频道     ← 主要会话场所
│   └── thread per task  ← 每个任务/讨论拉一个子线程
│
├── !dm-alice-ui-bot    (Alice ↔ UI-design Agent, 1:1 DM)
├── !dm-alice-req-bot   (Alice ↔ Requirements Agent, 1:1 DM)
├── !dm-bob-ui-bot      (Bob ↔ UI-design Agent, 1:1 DM)
│
├── !adhoc-group-1      (临时群: Alice + Bob + UI Agent + Req Agent)
│
└── !file-events        (系统消息流: git push/pull/merge 通知)
```

### 5.2 Matrix 概念 → 产品概念映射

| Matrix 概念 | 产品概念 |
|---|---|
| Space | Workspace |
| Room (team) | 团队群 |
| Room (DM) | 1:1 私聊 |
| Room (adhoc) | 临时群 |
| User | 人或 Agent bot |
| Power level | 用户角色（0/50/100） |
| Mention (@) | @ 提及 |
| Thread | 任务/讨论子线程 |
| Reply / Edit / Reaction / Read receipt / Typing / Presence | 同名功能 |
| File attachment | 文件/图片 |
| Custom event type | 结构化消息（dispatch/tool_result/file_event） |

### 5.3 消息类型

普通聊天用 Matrix 标准 `m.room.message`；编排消息用**自定义 event type**：

```typescript
// 1. 普通聊天
type ChatMessage = {
  type: 'm.room.message';
  content: {
    msgtype: 'm.text' | 'm.emote' | 'm.notice';
    body: string;
    formatted_body?: string;
    format?: 'org.matrix.custom.html';
    'm.mentions'?: { user: string; room?: boolean }[];
  };
};

// 2. Agent 任务调度 (主 → 子)
type DispatchMessage = {
  type: 'io.agentplatform.dispatch';
  content: {
    body: string;
    task_id: string;
    dispatch_from: string;
    dispatch_to: string;
    input_artifacts?: string[];
    deadline_ms?: number;
    priority?: 'low' | 'normal' | 'high';
    commitConvention?: {               // 提交规范提示
      type: string;
      taskId: string;
      summary: string;
    };
  };
};

// 3. Agent 任务回复
type TaskReplyMessage = {
  type: 'io.agentplatform.task_reply';
  content: {
    body: string;
    task_id: string;
    status: 'in_progress' | 'completed' | 'failed' | 'needs_input';
    output_artifacts?: string[];
    progress_pct?: number;
    reply_to_event?: string;
  };
};

// 4. 工具调用结果
type ToolResultMessage = {
  type: 'io.agentplatform.tool_result';
  content: {
    body: string;
    tool_ref: string;
    input_summary: object;
    output_summary: string;
    output_artifact_mxc?: string;
    success: boolean;
    duration_ms: number;
  };
};

// 5. 文件事件通知
type FileEventMessage = {
  type: 'io.agentplatform.file_event';
  content: {
    body: string;
    event: 'push' | 'pull' | 'merge' | 'conflict' | 'branch_created';
    actor: string;
    commit_range?: { from: string; to: string };
    files_changed?: string[];
    branch?: string;
  };
};
```

**UI 渲染规则**：
- `m.room.message` → 普通气泡
- `dispatch` → 紫色高亮卡片 "🤖 → 🤖 任务: ..."
- `task_reply` → 绿色/红色卡片（按 status）
- `tool_result` → 折叠卡片（默认收起）
- `file_event` → 系统消息样式

### 5.4 @ 提及机制

**用户 @ agent**：Matrix mention event 指定 user_id；agent 子进程判断 mention 命中自己后触发响应。

**Agent @ agent（主调子）**：底层是 dispatch message，UI 上同时渲染为 "@提及" 样式 + 紫色任务卡片。

**避免循环**：每个 dispatch message 带原 `task_id`，子 agent 回复必须引用该 id；agent 收到 dispatch 时检查 `dispatch_to == self`。

### 5.5 实时性与同步

- Matrix `/sync` 长连接，新 event 推送
- 离线 → 重连时从 `since_token` 续拉
- 每个客户端（人 + agent bot）维护独立 `since_token`

**性能优化**：N 个 agent = N 个 /sync 长连接 → homeserver 压力。
- v1：直接 N 连接（家户数 < 20，可接受）
- v2：用 Matrix **Appservice** 模式，单一连接代理所有 bot

### 5.6 离线与消息可靠性

| 场景 | 处理 |
|---|---|
| 用户离线，agent 完成任务 | 消息存 homeserver，用户上线后 /sync 拉到 |
| Agent 子进程崩溃中途回复 | 子进程重启后从 `since_token` 续传；进行中任务标记为 stale |
| 网络断开 | Matrix 客户端自动重连（exponential backoff） |
| 跨 homeserver federation（v2+） | Matrix 标准 federation 自动处理 |

### 5.7 关键设计决策

**1. 自定义 event type 而不是塞进 m.room.message.metadata**
- Matrix 自定义 event type 一等公民，UI 可精确按 type 渲染
- Schema 可独立演进

**2. dispatch 走 IM 而不是 RPC**
- 整个调度过程**人可见、可干预、可审计**
- 延迟比 RPC 高（~200ms），可接受（agent 任务通常 10s+ 级别）

**3. 默认一个大群（不是开多个 room）**
- 用户原需求："组建一个群，通过@方式和不同的agent协同工作"
- 默认就一个大群降低使用门槛；临时专题群是 ad-hoc

---

## 6. Agent 生命周期与调度

### 6.1 Agent 生命周期阶段

```
   ┌──────────┐    ┌──────────────┐    ┌──────────┐    ┌─────────┐
   │ Defined  │───►│ Assigned     │───►│ Running  │───►│ Paused  │
   │ (模板)   │    │ (装到 ws)    │    │ (子进程  │    │ (挂起)  │
   └────┬─────┘    └──────┬───────┘    └────┬─────┘    └────┬────┘
        │                 │                 │                │
        │                 │ unassign        │ stop           │ resume
        │          ┌──────────────┐  ┌──────────┐            │
        │          │ Unassigned   │  │ Stopped  │◄───────────┘
        │          │ (定义在但   │  │ (子进程  │
        │          │  未装到 ws) │  │  退出)   │
        │          └──────────────┘  └────┬─────┘
        │                            │ delete
        ▼                            ▼
   ┌──────────┐                ┌──────────┐
   │Archived  │                │ Deleted  │
   │(下架)    │                │(bot 注销)│
   └──────────┘                └──────────┘
```

### 6.2 Agent 定义格式（YAML Manifest）

支持 **3 种 runtime 类型**：declarative（配置式）、programmatic（代码式）、external（桥接外部运行时）。

#### 6.2.1 declarative（最常见，配置式）

```yaml
apiVersion: v1
kind: AgentDefinition
metadata:
  id: a1b2c3d4-...
  name: 需求讨论师
  slug: requirement-analyst
  version: 1.0.0
  author:
    matrixUserId: "@alice:home.server"
    displayName: Alice
  description: 帮用户梳理需求、产出需求文档
  iconEmoji: "📝"
  tags: [requirement, document]

spec:
  type: sub                    # main | sub | standalone
  parentAgentId: optional
  runtime: declarative         # ★ 标识 runtime 类型
  
  declarative:
    systemPrompt: |
      你是一名资深需求分析师。你的职责是...
    
    model:
      provider: anthropic
      model: claude-3-5-sonnet
      temperature: 0.7
      maxTokens: 8192
  
  # 共享配置
  defaultTools:
    - kind: builtin
      ref: workspace.read_file
    - kind: builtin
      ref: workspace.write_file
  defaultMcps:
    - kind: mcp
      ref: mcp:filesystem:latest
  defaultSkills:
    - kind: skill
      ref: skill:write-markdown-doc:1.0.0
  
  resources:
    cpuPercent: 50
    memoryMB: 512
    monthlyTokenBudget: 1000000
  
  permissions:
    fs:
      workspaceDir: readwrite
    network:
      llmApi: true
      mcpRemote: true
    dispatch:
      canCallSubAgents: false
```

#### 6.2.2 programmatic（代码式，进阶）

```yaml
apiVersion: v1
kind: AgentDefinition
metadata:
  name: 智能代码审查员
  slug: smart-code-reviewer
  version: 1.0.0
  description: 复杂多步代码审查 + 自定义规则引擎 + 学习型 agent

spec:
  type: main
  runtime: programmatic        # ★ 代码式
  
  programmatic:
    language: typescript
    entry: ./agent.ts          # 实现 Agent 接口的模块
    sdkVersion: "^1.0.0"       # 兼容的 @agentplatform/sdk 版本
    env:
      CUSTOM_RULES_PATH: ./rules.json
  
  # 共享配置 (代码内通过 ctx.* 访问)
  defaultMcps:
    - kind: mcp
      ref: mcp:github:latest
  defaultSkills:
    - kind: skill
      ref: skill:code-review-workflow:1.0.0
  
  resources: { cpuPercent: 80, memoryMB: 1024 }
  permissions: { ... }
```

**Agent 代码示例** (`agent.ts`):

```typescript
import { Agent, MessageContext, ToolResult, AgentContext } from '@agentplatform/sdk';

interface MyState {
  pendingReviews: Map<string, ReviewTask>;
  learnedPatterns: Pattern[];
}

export default class SmartCodeReviewer extends Agent<MyState> {
  async onStart(ctx: AgentContext): Promise<void> {
    this.state = { pendingReviews: new Map(), learnedPatterns: [] };
    await ctx.sendToTeamRoom('🤖 Smart Code Reviewer 已就绪');
  }
  
  async onMessage(msg: MessageContext): Promise<void> {
    // 完全自定义逻辑: 可以调 LLM, 也可以走规则引擎, 也可以混合
    if (msg.mentionsMe && msg.containsKeyword('review')) {
      const task = this.parseReviewTask(msg);
      this.state.pendingReviews.set(task.id, task);
      
      // 调度子 agent
      await msg.dispatch('static-analyzer', { files: task.files });
      
      // 自己也用 LLM 分析
      const analysis = await msg.llm.chat({
        system: '你是代码审查专家...',
        messages: [{ role: 'user', content: msg.body }],
      });
      
      // 调 MCP
      const pr = await msg.mcp.call('github', 'get_pull_request', { id: task.prId });
      
      // 写文件
      await msg.fs.writeFile(`reviews/${task.id}.md`, analysis);
      
      // 回复
      await msg.reply(`✅ 审查完成, 报告见 reviews/${task.id}.md`);
    }
  }
  
  async onToolResult(result: ToolResult): Promise<void> {
    // 处理异步工具结果
  }
  
  async onError(err: Error): Promise<void> {
    // 自定义错误处理
  }
}
```

#### 6.2.3 external（桥接外部 agent 运行时）

桥接 OpenCode / Codex / Claude Code / 任意外部 agent 平台。我们的 runtime 仅作 Matrix ↔ 外部协议的桥梁。

```yaml
apiVersion: v1
kind: AgentDefinition
metadata:
  name: OpenCode Coder
  slug: opencode-coder
  version: 1.0.0
  description: 通过 OpenCode 提供强大的代码生成能力

spec:
  type: sub
  runtime: external            # ★ 桥接外部
  
  external:
    platform: opencode         # opencode | codex | claude-code | custom
    bridge:
      type: subprocess         # subprocess | http | websocket | stdio_json
      command: ['opencode', 'agent', '--mode', 'stdio-bridge']
      cwd: ${WORKSPACE_DIR}    # 占位符, 运行时替换
      # 或 HTTP:
      # type: http
      # url: http://localhost:3000/opencode/message
      # authType: bearer
      # authTokenRef: mcp.opencode.auth_token
    
    capabilities:
      supportsThreads: true
      supportsToolCallEvents: true
      supportsStreaming: false
  
  # 共享配置: MCP/Skill 仍可挂载, 桥接层会传给外部 runtime (如果它支持)
  defaultMcps: [...]
  
  resources: { cpuPercent: 80, memoryMB: 2048 }
  permissions: { ... }
```

**桥接协议**（subprocess stdio JSON）：

```
我们 → 外部 (stdin):
  { "type": "message", "from": "@alice:home", "body": "...", "mentions": [...], "task_id": "...", "attachments": [...] }

外部 → 我们 (stdout):
  { "type": "reply", "body": "...", "tool_calls": [...], "artifacts": [...] }
  { "type": "tool_call", "tool": "fs.read_file", "input": {...} }   # 外部请求我们执行 (走我们的权限/沙箱)
  { "type": "error", "message": "..." }
```

外部 runtime 想用 MCP / workspace 文件时，通过 tool_call 反向请求我们执行（受我们的权限/沙箱限制）。这样即便外部 runtime 自身无沙箱，也仍受我们控制。

#### 6.2.4 三种 runtime 对比

| 维度 | declarative | programmatic | external |
|---|---|---|---|
| 开发难度 | 低（YAML） | 中-高（写代码） | 低-中（配 bridge） |
| 灵活度 | 低（固定 LLM loop） | 高（任意逻辑） | 取决于外部平台 |
| 适合场景 | 简单 prompt + tools | 复杂工作流、自定义状态机 | 复用 OpenCode/Codex 等已有能力 |
| 沙箱 | 子进程（我们的 runtime） | 子进程（用户代码 + 我们的 SDK） | 外部进程（仍受我们子进程沙箱） |
| 能力调用 | 直接 | 通过 ctx.* SDK | 通过 tool_call 反向请求 |
| Marketplace 分发 | YAML + 资源 | YAML + 代码 + package.json | YAML + bridge 配置 |

**捆绑资产**（marketplace 分发时）：
```
requirement-analyst-1.0.0.tar.gz
├── manifest.yaml
├── prompts/
├── templates/
├── README.md
└── icon.png (可选)
```

### 6.3 Agent SDK

为 programmatic agent 提供标准化开发套件。

#### 6.3.1 SDK 包

- **TypeScript**: `@agentplatform/sdk` (npm)
- **Python**: `agentplatform-sdk` (pip)

SDK 提供：
- `Agent` 基类（含生命周期 hook）
- `AgentContext` / `MessageContext` / `ToolResult` 等类型
- 内置能力客户端（LLM、MCP、Skill、FS、IM、Dispatch）
- 类型定义（TypeScript 原生；Python 用 pydantic + type stubs）

#### 6.3.2 Agent 接口（TypeScript 版）

```typescript
import { Agent, AgentContext, MessageContext, ToolResult, ToolCall } from '@agentplatform/sdk';

export interface Agent<State = unknown> {
  // === 生命周期 ===
  onStart(ctx: AgentContext): Promise<void>;
  onStop(): Promise<void>;
  
  // === 消息处理 (替代 declarative 的 LLM loop) ===
  onMessage(msg: MessageContext): Promise<void>;
  
  // === 工具调用结果 (异步场景) ===
  onToolResult?(result: ToolResult): Promise<void>;
  
  // === 调度事件 (主 agent 收到子 agent 的 task_reply) ===
  onTaskReply?(reply: TaskReply): Promise<void>;
  
  // === 错误 ===
  onError?(err: Error): Promise<void>;
  
  // === 状态 (agent 自定义) ===
  state?: State;
}

// SDK 提供的上下文对象 (ctx / msg 内自动注入)
interface AgentContext {
  botUserId: string;
  workspaceId: string;
  workspaceDir: string;
  
  // 能力客户端
  llm: LLMClient;              // chat / stream / embed
  mcp: McpClient;              // call(mcpName, toolName, input)
  fs: WorkspaceFS;             // readFile / writeFile / listFiles (沙箱强制)
  skill: SkillClient;          // loadSkill / readResource / executeScript
  im: IMClient;                // send / reply / mention / createRoom
  
  // 主 agent 专属
  dispatch?: DispatchClient;    // dispatchSubAgent / waitForReply
  
  // 元信息
  permissions: AgentPermissions;
  config: Record<string, any>; // manifest 中 programmatic.env 合并运行时注入
}

// MessageContext 是 AgentContext 的扩展, 含本次消息上下文
interface MessageContext extends AgentContext {
  eventId: string;
  roomId: string;
  sender: string;
  body: string;
  mentionsMe: boolean;
  attachments: Attachment[];
  reply(): Promise<void>;
  replyInThread(body: string): Promise<void>;
}
```

#### 6.3.3 declarative runtime 也基于同一 SDK

declarative agent 本质上是 SDK 内置的一个 `DeclarativeAgent` 类：

```typescript
// @agentplatform/sdk 内部实现 (用户不需要看)
class DeclarativeAgent extends Agent {
  constructor(private spec: DeclarativeSpec) { super(); }
  
  async onMessage(msg: MessageContext) {
    const history = await msg.im.loadHistory(msg.roomId, 20);
    const systemPrompt = await buildSystemPrompt(this.spec.systemPrompt, msg);
    
    let response = await msg.llm.chat({
      system: systemPrompt,
      messages: [...history, { role: 'user', content: msg.body }],
      tools: await gatherTools(msg),
    });
    
    while (response.hasToolCalls) {
      for (const call of response.toolCalls) {
        const result = await executeTool(call, msg);
        await msg.im.sendToolResult(msg.roomId, call, result);
      }
      response = await msg.llm.chat({ /* continue */ });
    }
    
    await msg.reply(response.content);
  }
}
```

这样 declarative 和 programmatic 共享同一套基础设施（ctx / 能力客户端 / 沙箱），仅"业务逻辑"不同。

#### 6.3.4 external bridge runtime

external runtime **不**走 Agent SDK。它运行外部进程（如 `opencode` CLI），通过桥接协议（subprocess stdio JSON / HTTP / WebSocket）与我们的 AgentRuntime 通信。

我们的 AgentRuntime 内部仍是一个 programmatic agent（继承 SDK 的 `Agent` 基类），但 `onMessage` 的实现是"转发给外部进程"：

```typescript
// 内置 ExternalBridgeAgent (用户不需要写)
class ExternalBridgeAgent extends Agent {
  constructor(private spec: ExternalSpec) { super(); }
  
  async onStart(ctx: AgentContext) {
    this.bridge = await BridgeProtocol.connect(this.spec.bridge, ctx);
  }
  
  async onMessage(msg: MessageContext) {
    // 1. 把 Matrix 消息转成 bridge 协议格式, 发给外部进程
    await this.bridge.send({
      type: 'message',
      from: msg.sender,
      body: msg.body,
      task_id: msg.taskId,
      attachments: msg.attachments,
    });
    
    // 2. 异步等外部进程响应 (可能多条)
    for await (const event of this.bridge.events()) {
      switch (event.type) {
        case 'reply':
          await msg.reply(event.body);
          break;
        case 'tool_call':
          // 外部 runtime 请求我们执行工具 (走我们的沙箱)
          const result = await this.executeBridgedTool(event, msg);
          await this.bridge.send({ type: 'tool_result', id: event.id, ...result });
          break;
        case 'error':
          await msg.reply(`❌ 外部 agent 报错: ${event.message}`);
          break;
      }
    }
  }
}
```

#### 6.3.5 SDK 设计原则

1. **declarative 是 programmatic 的子集**：所有 declarative 行为都能用 SDK 重写，反之不行
2. **能力客户端统一**：所有 runtime（含 external）调 MCP/Skill/FS 都经过相同接口，确保权限/审计一致
3. **沙箱不可绕过**：SDK 的 fs / mcp / skill 客户端在内部强制路径检查和权限验证；用户代码不能直接 `require('fs')`（沙箱层阻止）
4. **状态隔离**：每个 agent 实例的 `state` 在内存中独立，进程崩溃即丢失（v2 提供持久化 hook）
5. **可观测**：SDK 自动记录所有 ctx.* 调用到审计日志

### 6.4 创建 Agent 实例（assign 到 workspace）

```
1. 用户在 workspace 配置面板点 "+ 添加 Agent"
2. 选择来源: 已装定义 / marketplace / 自定义创建
3. (若选 main agent) 显示其下属 sub 列表, 默认全选, 可勾选
4. 配置 extra tools/mcps/skills (workspace 级 + instance 级)
5. 可选: 覆盖 system prompt / model
6. 点 "启用"

后台执行 (每个 selected agent):
  1. 注册 bot 账号
  2. 存 access_token 到 keychain
  3. invite bot 进 Space + team room
  4. 启动子进程 (含 OS 沙箱)
  5. bot 在 team room 发 "✅ 已上线"
```

### 6.5 主子 Agent 调度机制

**主 agent 调度子 agent**（通过 IM）：

```typescript
// 在主 agent 的 LLM tool 列表里, 注册"调度子 agent"为虚拟工具:
{
  name: `dispatch:${subAgentSlug}`,
  description: subAgentManifest.description,
  parameters: {
    task: { type: 'string' },
    input_files: { type: 'array', items: { type: 'string' } },
    deadline: { type: 'number', optional: true },
  },
}

// LLM 调用此工具时:
async function dispatchSubAgent(subAgentBotId, params) {
  const task_id = uuid();
  
  await matrix.send(teamRoomId, {
    type: 'io.agentplatform.dispatch',
    content: { ... },
  });
  
  return await waitForTaskReply(task_id, params.deadline ?? 60000);
}
```

**子 agent 收到 dispatch**：
1. 确认是给自己的（`dispatch_to == self`）
2. 发 `task_reply` status=in_progress
3. 执行任务
4. 发 `task_reply` status=completed/failed

### 6.6 上下文管理

**LLM 上下文 = 多源拼接**：

```
[System Prompt]
  ├── Agent manifest 中的 spec.systemPrompt
  ├── 引用的 templates
  ├── Workspace 元信息
  └── 可用工具描述 + Skill 索引

[Messages]
  ├── 最近 N 条 IM 历史
  ├── 当前 thread 上下文
  └── 引用的文件内容
```

**Token 预算控制**：优先保留 system prompt + 当前任务 + 最近 5 条消息；滑动窗口丢弃旧消息；大文件仅注入元信息。

### 6.7 错误处理与恢复

| 场景 | 处理 |
|---|---|
| LLM API 调用失败 | 重试（指数 backoff），3 次失败后报错；token 配额耗尽则停止 |
| 子进程崩溃 | 主进程监听 `child.exit`，自动重启；3 次失败后暂停 |
| MCP server 无响应 | 5s 超时，标记该 tool 不可用 |
| Skill 包内脚本执行超时（`builtin:skill.execute_script`） | 强制 kill 子进程，返回 timeout 错误给 LLM |
| WorkspaceFS 路径违规 | 直接拒绝，返回 PermissionDenied |
| Bot Matrix token 失效 | 主进程检测 401，重新登录 |

### 6.8 热重载

- 改 extra tools / system prompt → IPC 推送，子进程热重载
- 改 model / 资源限制 → 重启子进程

### 6.9 关键设计决策

**1. Agent 通过 IM 调度（不是 RPC）**
- 人可见、可干预、跨 peer 天然兼容
- 代价：延迟（~200ms），可接受

**2. 子 agent 调用注册为 LLM tool**
- LLM 不需要"知道"自己有子 agent，只需看到 dispatch 工具
- 自然语言描述引导 LLM 何时调用

**3. 任务用 task_id 关联**
- Matrix message ID 不可控
- 自定义 task_id 让 dispatch/reply 1:N 关系稳定

**4. 子 agent 可被多人共享**
- 一个 sub agent bot 可被多人 @
- 同一时刻只能处理一个任务（v2 支持并发）

---

## 7. 工具 / MCP / Skills 集成

### 7.1 三层能力模型

```
┌─────────────────────────────────────────────────────┐
│ Layer 3: Skills（知识层）                            │
│   "如何做" — 工作流、最佳实践、领域知识              │
│   格式: SKILL.md + 可选资源文件                     │
│   加载方式: 渐进式披露进 LLM context                │
└────────────────────┬────────────────────────────────┘
                     │ references (allowed_tools)
                     ▼
┌─────────────────────────────────────────────────────┐
│ Layer 2: MCP（连接层）                              │
│   "够得着" — 标准化外部资源访问                     │
│   Transports: stdio / Streamable HTTP / HTTP+SSE   │
└────────────────────┬────────────────────────────────┘
                     │ invokes
                     ▼
┌─────────────────────────────────────────────────────┐
│ Layer 1: Builtin Tools（基础工具层）                │
│   "必备" — 平台内置的核心工具                       │
└─────────────────────────────────────────────────────┘
```

**关键**：Skill **不调用**工具，而是**告诉** LLM 该调用哪些工具。Skill 与 MCP 是**互补**，不是替代。

### 7.2 Skill 文件格式（遵循 Anthropic 规范）

#### 7.2.1 目录结构

```
~/.agent-platform/cache/skills/
├── code-review-workflow/
│   ├── SKILL.md              # 主文件（必需）
│   ├── checklist.md          # 附加资源（按需加载）
│   └── templates/
│       └── comment-template.md
├── mysql-employees-analysis/
│   ├── SKILL.md
│   └── db_schema.sql
└── pdf-form-filling/
    ├── SKILL.md
    ├── parse_pdf.py
    └── forms.md
```

#### 7.2.2 SKILL.md 规范

```markdown
---
name: code-review-workflow
description: >
  执行标准的代码审查流程。审查代码风格、安全问题、测试覆盖率。
  适用于 PR review、merge 前检查、代码质量审计场景。
  当用户提到"审查代码"、"review PR"、"check 代码质量"时使用此技能。
version: 1.0.0
allowed_tools:
  - builtin:workspace.read_file
  - mcp:github:latest
  - mcp:filesystem:latest
required_context: [git_repo]
license: MIT
author:
  matrixUserId: "@alice:home.server"
  displayName: Alice
tags: [code-review, security, quality]
iconEmoji: "🔍"
---

# 代码审查工作流

## 概述
（详细介绍技能用途、使用场景、技术背景）

## 工作流程
1. **获取 PR 信息**：调用 `mcp:github:get_pull_request_details`
2. **分析变更文件**：调用 `mcp:github:list_pr_files`
3. ...

## 详细检查清单
（参见 `checklist.md`）
```

### 7.3 渐进式披露机制（核心）

```
启动时 (所有已装 skills):
    扫描每个 SKILL.md 的 YAML frontmatter
    仅元数据 (~100 tokens/skill)
    ↓
    注入 system prompt 的"已安装技能索引"
    总开销: 50 个 skill ≈ 5,000 tokens

对话中 (按需加载):
    用户问任务
    ↓
    LLM 自主判断: 匹配某 skill
    ↓
    调虚拟工具 loadSkill(name)
    ↓
    加载该 skill 完整正文 (~2-3k tokens)

更深入 (按需加载附加资源):
    LLM 调虚拟工具 readResource(skill, path)
    ↓
    加载 checklist.md / templates 等
```

**实现**：在 agent 子进程的 LLM provider 旁加一个 **SkillRegistry**，负责：
- 启动时扫描所有已装 skill 的 frontmatter
- 提供 `getIndex()` 注入 system prompt
- 提供 `loadFull(skillId)` 按需读取正文
- 提供 `loadResource(skillId, filePath)` 读取附加资源

### 7.4 MCP Host（三种 transport）

```typescript
interface McpTransport {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  call(toolName: string, input: unknown): Promise<McpResponse>;
  listTools(): Promise<McpToolInfo[]>;
}

// StdioMcpTransport: 本地子进程 (JSON-RPC over stdio)
// StreamableHttpMcpTransport: 单 HTTP 端点 + 可选 SSE 流 (MCP 2025 规范)
// HttpSseMcpTransport: GET /sse 长连接 + POST /messages (旧规范)
```

**MCP 进程池共享**：一个 workspace 内有 5 个 agent 都用 filesystem MCP → 只起 1 个 MCP server 进程。5 个 agent 的 IPC 调用都路由到同一个 MCP 进程。

### 7.5 Builtin Tools

| 工具 | 用途 |
|---|---|
| `builtin:workspace.read_file` | 读 workspace 内文件 |
| `builtin:workspace.write_file` | 写 workspace 内文件 |
| `builtin:workspace.list_files` | 列目录 |
| `builtin:workspace.search` | 全文/grep 搜索 |
| `builtin:workspace.git_status` | 查 git 状态 |
| `builtin:workspace.git_commit` | 提交（带 policy 校验） |
| `builtin:im.send` | 发 IM 消息 |
| `builtin:im.mention` | @ 提及 |
| `builtin:dispatch.sub_agent` | 主 agent 调度子 agent |
| `builtin:workspace.meta` | 查 workspace 元信息 |
| `builtin:loadSkill` | 虚拟工具：加载 skill 正文到 LLM context |
| `builtin:readResource` | 虚拟工具：读取 skill 引用的资源 |
| `builtin:skill.execute_script` | 虚拟工具：执行 skill 包内的脚本（如 `parse_pdf.py`），受沙箱限制 |

### 7.6 修正后的 Agent 子进程结构

```typescript
class AgentRuntime {
  constructor(manifest, ctx) {
    // Matrix / LLM / 沙箱 / 资源监控
    
    this.tools = new ToolRegistry();
    
    // 1. Builtin tools (受 permissions 限制)
    for (const t of BUILTIN_TOOLS) {
      if (this.isAllowed(t.name)) this.tools.register(t);
    }
    
    // 2. MCP tools (从 MCP server listTools 拉取)
    for (const mcpRef of agent.capabilities.mcps) {
      const mcp = ctx.mcpHost.get(mcpRef.id);
      const mcpTools = await mcp.listTools();
      for (const t of mcpTools) {
        const fullName = `mcp:${mcpRef.name}:${t.name}`;
        if (this.isAllowed(fullName)) {
          this.tools.register(new McpToolAdapter(mcp, t));
        }
      }
    }
    
    // 3. SkillRegistry (不再是 tool, 而是上下文注入)
    this.skillRegistry = new SkillRegistry(
      agent.capabilities.skills,
      ctx.skillCachePath,
    );
  }
  
  async buildSystemPrompt(task): Promise<string> {
    const base = this.manifest.spec.systemPrompt;
    const skillIndex = this.skillRegistry.getIndex();
    
    return `${base}
    
## 已安装技能索引
${skillIndex}

调用 loadSkill(name) 后, 该技能的完整指令会注入到你的上下文。
技能指令中可能引用附加资源文件, 你可用 readResource(name, path) 按需读取。
`;
  }
  
  async executeTool(call) {
    // 虚拟工具: loadSkill
    if (call.name === 'loadSkill') {
      const skillBody = await this.skillRegistry.loadFull(call.input.name);
      return { success: true, output: { instructions: skillBody }, summary: `已加载技能 ${call.input.name}` };
    }
    if (call.name === 'readResource') {
      const content = await this.skillRegistry.loadResource(call.input.skill, call.input.path);
      return { success: true, output: { content }, summary: `已读取资源` };
    }
    if (call.name === 'skill.execute_script') {
      // 执行 skill 包内的脚本 (如 parse_pdf.py)
      // spawn Skill Script Runner 子进程, 受沙箱限制
      return await this.ctx.skillScriptRunner.execute({
        skill: call.input.skill,
        script: call.input.script,
        args: call.input.args,
        stdin: call.input.stdin,
        timeoutMs: 30000,         // 默认 30s, manifest 可覆盖
      });
    }
    return this.tools.invoke(call.name, call.input, this.ctx);
  }
}
```

### 7.7 工具调用流程

```
[Agent] LLM 决定调 mcp:filesystem:read_file
   ↓ 通过 IPC 发到主进程
[Electron Main]
   - McpHostManager.lookup('filesystem')
   - 权限检查
   - 调用 transport.call('read_file', input)
[MCP Transport (stdio)]
   ↓ JSON-RPC over stdio
[MCP server 子进程]
   ↓ 执行读取
   ↑ 返回结果
[主进程] 包装 ToolResult
[Agent 子进程] 拿到结果, 传给 LLM
```

### 7.8 工具调用审计

每次 tool 调用记录到 SQLite：

```sql
CREATE TABLE tool_calls (
  id TEXT PRIMARY KEY,
  workspace_id TEXT,
  agent_bot_user_id TEXT,
  task_id TEXT,
  tool_name TEXT,
  input_summary TEXT,
  output_summary TEXT,
  success INTEGER,
  duration_ms INTEGER,
  timestamp TEXT
);
```

### 7.9 关键设计决策

**1. MCP 共享进程池**
- 资源节省；状态一致；通过重启可恢复故障

**2. Skill 是上下文，不是工具**
- 通过 `loadSkill` 虚拟工具按需注入到 LLM context
- LLM 看到 skill 索引后**自主决定**何时加载

**3. 渐进式披露由 LLM 主导**
- 第 1 层（元数据）启动时自动注入
- 第 2 层（正文）LLM 决定何时 loadSkill
- 第 3 层（附加资源）LLM 决定何时 readResource

**4. Skill 中的 `allowed_tools` 是软约束**
- 仅作为 LLM 提示
- 真正硬约束在 `AgentPermissions`

---

## 8. P2P 协作与文件同步

### 8.1 协作场景概览

```
                ┌──────────────────────────┐
                │  Conduit Homeserver      │
                │  + Git bare repo service │
                │  + Marketplace API       │
                └─────┬──────┬──────┬──────┘
                      │      │      │
                      ▼      ▼      ▼
            ┌──────┐    ┌──────┐    ┌──────┐
            │Peer A│    │Peer B│    │Peer C│
            │本地  │    │本地  │    │本地  │
            │check │    │check │    │check │
            │out   │    │out   │    │out   │
            └──┬───┘    └──┬───┘    └──┬───┘
               └──── git push/pull ────┘
                       (经协调服务器)
```

**重要边界**：peers 之间**不直接**通讯。所有协作流量都经过协调服务器。这是简化但实用的"P2P"（事实上是"星型 hub-spoke"）。真正端到端直连作为 v2 优化点。

### 8.2 Workspace 创建与协作流程

#### Alice 创建 workspace 并邀请 Bob

```
[Alice]
1. UI: "新建 workspace"
2. 客户端执行:
   a. 本地 mkdir + git init
   b. Conduit: createRoom type=m.space
   c. Conduit: createRoom (team room) + invite self
   d. 协调服务器: POST /api/git/repos → git remote URL + token
   e. git remote add origin + git push -u origin main
   f. SQLite 记录 workspace
3. UI: "邀请 Bob"
4. Conduit invite + 协调服务器 grant git token
```

#### Bob 接受邀请

```
[Bob]
1. 收到 Matrix invite
2. 接受 → join Space + git clone
3. SQLite 记录 workspace
4. 在 team room 发系统消息
```

### 8.3 Git 同步策略

#### 触发时机

| 事件 | 触发动作 |
|---|---|
| 用户手动按 "同步" | git pull → 解决冲突 → git push |
| Agent 修改文件后 | 自动 commit (署名 bot) → push |
| 收到 file_event 消息 | 提示用户 pull |
| Agent 调度跨 peer | 发起方 push 任务输入；接收方 pull |
| 定时（每 5 分钟） | 后台 pull 检查 |

#### Agent 提交策略

```
commit message format:
  [agent:<bot_user_id>] <action summary>
  
  task_id: <task_id>
  triggered_by: <matrix_user_id_or_bot>
```

### 8.4 提交策略与规则

```yaml
gitPolicy:
  allowAgentCommits: true              # 是否允许 agent 提交
  defaultBranch: main
  fallbackBranchPattern: "agent/{agent_slug}/{task_id}"
  
  commitMessage:
    template: "{type}{taskId} {summary}"
    patterns:
      - code: S                        # story
        name: "故事任务"
        regex: '^S\d{8}\s+.+'
        example: "S12345678 用户管理模型"
      - code: B                        # bugfix
        name: "Bug 修复"
        regex: '^B\d{8}\s+.+'
        example: "B87654321 修复登录页崩溃"
    
    validation: strict                 # strict | warning | none
    trailers:                          # 强制附加 commit trailers
      - key: "Agent-Bot"
        value: "{bot_user_id}"
      - key: "Task-ID"
        value: "{task_id}"
```

**Agent 如何获得 commit convention**：通过 dispatch message 携带：

```typescript
type DispatchMessage = {
  type: 'io.agentplatform.dispatch';
  content: {
    ...
    commitConvention?: {
      type: 'S' | 'B' | string;
      taskId: string;
      summary: string;
    };
  };
};
```

**校验失败处理**（strict 模式）：
1. git_commit tool 拒绝提交
2. 返回错误给 agent，要求重新生成合规 message
3. 3 次失败 → 提交到 fallback branch + 通知用户审核

### 8.5 冲突处理

```
git pull → 冲突
   ↓
本地 UI 提示: "Alice 和你的 agent 同时改了 README.md"
   ↓
打开冲突解决界面 (3-way merge UI)
   ↓
用户/agent 解决 → git commit + push
```

v1 默认不自动合并，所有冲突人工干预。v2 优化：用 agent 辅助合并。

### 8.6 协调服务器 Git 服务

提供 git smart HTTP protocol：

```
GET  /git/<repo>.git/info/refs?service=git-upload-pack
POST /git/<repo>.git/git-upload-pack
GET  /git/<repo>.git/info/refs?service=git-receive-pack
POST /git/<repo>.git/git-receive-pack
```

**鉴权**：Bearer token（每个用户对每个 repo 独立 token），token 在 Matrix `account_data` 中分发。

**实现选择**：v1 用 Gitea（成熟稳定），后续可换自建。

### 8.7 跨 Peer Agent 调用

**机制**：完全走 Matrix。

```
[Alice] @bob-pdf-agent 帮我处理这份 PDF
   ↓ Matrix 路由
[Bob 的客户端] mention 命中 PDF agent
   ↓
[PDF agent] 下载附件 → 处理 → 上传结果 → task_reply
   ↓
[Alice] 收到 reply
```

**约束**：
- 跨 peer agent 调用 = 该 agent 实际跑在**对方机器上**
- 文件输入/输出通过 Matrix attachment 传递，不直接读对方文件系统

### 8.8 离线行为

| 场景 | 处理 |
|---|---|
| Peer 离线时其他人 push | Conduit 存消息；git server 存 commits；上线后 pull |
| Peer 离线时被 @ agent | 消息存 Conduit，上线后路由到本地 agent |
| 离线期间 agent bot "在线"？ | 客户端跑 → bot 在线；客户端关 → bot 离线 |
| 离线时其他 peer 调用该 peer 的 agent | 失败：bot 不在线，task_reply 超时 |

v2 优化：headless agent runner（独立守护进程，7×24 在线）。

### 8.9 关键设计决策

**1. 星型 hub-spoke（而非纯 P2P）**
- v1 用协调服务器中转，简化实现
- 用户体验等同 P2P
- v2 加 NAT 打洞支持直连

**2. 文件同步走 Git**
- 成熟、用户熟悉、强大工具链
- 自动版本历史，便于审计
- 缺点：实时性差（不是秒级），但对 agent 协作足够

**3. 跨 peer agent 调用通过 Matrix**
- 保持架构一致性
- 天然支持异步、离线、跨 homeserver federation
- 文件经 mxc URL 传递，维持安全边界

**4. 单 main 分支（v1）**
- 简化使用门槛
- 冲突靠人工解决

---

## 9. Marketplace（MCP + Skills + Agent 商城）

### 9.1 商城定位

| 类型 | 子类型 | 内容性质 | 分发方式 |
|---|---|---|---|
| **Agent** | declarative | YAML manifest + prompt + 模板/资产包 | 打包下载 (tar.gz) |
| **Agent** | programmatic | YAML manifest + 代码（TS/Py）+ package.json + 资产 | 打包下载 (tar.gz)，安装时 `npm install` |
| **Agent** | external | YAML manifest + bridge 配置 + 可选引导脚本 | 打包下载 (tar.gz) 或仅元数据（远端服务型） |
| **MCP (stdio)** | - | 可执行代码包 | 打包下载或包管理器安装 |
| **MCP (http/sse)** | - | 元数据 + 接入配置 | 仅元数据登记 |
| **Skill** | - | Markdown 包（SKILL.md + 可选脚本资源） | 打包下载 (tar.gz) |

> **Agent runtime 三类型详见第 6.2 节**。Marketplace 对用户透明：用户安装 agent 时不需要关心是 declarative 还是 programmatic，安装流程一致；只是 programmatic 包会多一步依赖安装。

### 9.2 上架流程

#### 用户发布包（Agent / Skill / stdio MCP）

```
[桌面端]
1. 用户选 "发布到商城"
2. 客户端打包 tar.gz
3. POST /api/marketplace/items (含作者 Matrix 签名)

[Marketplace 服务]
4. 校验包结构 + 病毒扫描 + 生成 checksum
5. 存对象存储
6. reviewStatus = 'pending'
7. (可选) 审核 → approved
```

#### 发布 MCP（HTTP/SSE 远端服务）

```
1. 填表: 元数据 + 服务 URL + 鉴权方式
2. POST /api/marketplace/items (无文件上传)
3. 服务端 health check (调 tools/list)
4. reviewStatus = 'approved'
```

### 9.3 安装流程

#### 安装 Skill

```
1. 下载 tar.gz → 校验 checksum
2. 解压到 cache/skills/<name>/<version>/
3. 验证 SKILL.md frontmatter
4. 本地 PluginInstallation 记录
5. UI 提示: 需在 workspace 配置中分配给 agent
```

#### 安装 MCP（stdio 包）

```
1. 下载 → 校验 checksum → 解压
2. 根据 runtime 安装依赖 (npm install / pip install)
3. 启动测试 (调 tools/list)
4. 失败 → 回滚
5. PluginInstallation 记录
```

#### 接入 MCP（HTTP/SSE）

```
1. UI 引导填入鉴权凭证
2. 凭证存 keychain
3. 测试连接
4. PluginInstallation 记录 (无文件下载)
```

#### 安装 Agent

```
1. 下载 → 校验 checksum → 解压到 cache/agents/<name>/<version>/
2. 解析 manifest.yaml, 校验 schema
3. 按 runtime 类型分别处理:
   - declarative: 无额外步骤
   - programmatic:
     a. cd 到解压目录
     b. npm install --production  (TypeScript)
        或 pip install -r requirements.txt  (Python)
     c. 编译 TypeScript (若 manifest 要求): tsc
     d. 启动测试: spawn 子进程, 调 onStart hook, 应在 5s 内返回
   - external:
     a. 验证 bridge.command 路径或 bridge.url 可达
     b. 若是 subprocess: 测试启动 + 立即关闭
     c. 若是 http: 测试 ping endpoint
4. 检查依赖 (MCP / Skill) → 缺失则提示一并安装
5. 注册 AgentDefinition 到本地
```

**失败回滚**：任何步骤失败 → 删除解压目录 → 不注册 → UI 报错。

### 9.4 版本与更新

- 每次发布新版本 → marketplace 创建新 entry，旧版本仍可访问
- 桌面端启动时检查更新
- 用户主动升级（不自动）

### 9.5 依赖管理

```yaml
spec:
  dependencies:
    - type: mcp
      ref: mcp:github
      versionRange: ">=1.0.0 <2.0.0"
      required: true
    - type: skill
      ref: skill:code-review-workflow
      versionRange: "^1.0.0"
      required: false
```

### 9.6 信任与安全

#### verificationStatus 含义

| 状态 | 含义 |
|---|---|
| `unverified` | 任何人上传，未审 |
| `community` | 已通过自动审核 |
| `verified` | 人工审核通过 |
| `official` | 平台官方维护 |

#### 安装时警告

```
⚠️ 此包未经验证, 可能包含恶意代码。
请确认你信任作者 @someone:home.server。
建议在虚拟机或受限沙箱中测试后再用。
[取消] [我了解风险, 继续]
```

#### 沙箱作为最后防线

即便包含恶意代码，运行时仍受：
- OS 级进程隔离
- 应用层 WorkspaceFS 路径限制
- AgentPermissions 工具白名单
- 网络限制（默认 deny）

### 9.7 私有 marketplace

```yaml
marketplaces:
  - name: "Public"
    url: https://marketplace.agentplatform.io
    default: true
  - name: "Company Internal"
    url: https://marketplace.company.internal
    auth: bearer
    token_keychain_ref: "marketplace.company.internal"
```

### 9.8 关键设计决策

**1. 一个商城，三个分类**
- 不拆三个独立商城
- 共享审核、版本、统计基础设施

**2. stdio MCP 走下载，HTTP/SSE MCP 走登记**
- 清晰区分两类

**3. 不做自动更新**
- 用户主动升级

**4. 不做付费/计费（v1）**

**5. 信任分四级 + 沙箱兜底**

---

## 10. UI 与交互

### 10.1 应用主框架

**类 VS Code 布局 + 类 Slack IM 集成**的混合方案：

```
┌──────────────────────────────────────────────────────────────────────────┐
│ AgentPlatform                                          [- ☐ ×]            │
├──────────────────────────────────────────────────────────────────────────┤
│ File  Edit  Selection  View  Workspace  Help                             │
├────┬─────────────────────────────────────────────────────────────────────┤
│WS  │  Team Chat (proj-x)        │ Code Editor - src/App.tsx               │
│切换│  ┌────────────────────────┐│ ┌────────────────────────────────────┐ │
│    │  │ Alice: @ui-design ...  ││ 1  import React from 'react'         │ │
│ 📁 │  │ ...                    ││ ...                                  │ │
│proj│  └────────────────────────┘│                                        │ │
│-x  │  ┌────────────────────────┐│                                        │ │
│ 📁 │  │ Type a message... @    ││                                        │ │
│api │  └────────────────────────┘│                                        │ │
│-s  │                            │                                        │ │
├────┤                            │                                        │ │
│导  │  ┌─Rooms─────────────────┐│                                        │ │
│航  │  │ # team (proj-x)       ││                                        │ │
│ 💬 │  │ ▸ req-agent DM        ││                                        │ │
│ 🤖 │  │ ▸ ui-design DM        ││                                        │ │
│ 🛒 │  └────────────────────────┘│                                        │ │
│ ⚙  │                            │                                        │ │
└────┴────────────────────────────┴───────────────────────────────────────┘
   左栏(56px)  IM区(可调,默认 35%)   编辑器区(剩余空间)
```

### 10.2 功能视图切换

| 图标 | 视图 | 内容 |
|---|---|---|
| 💬 | IM | 房间列表 + 选中的会话 |
| 📁 | 文件浏览器 | 文件树 + 编辑器 |
| 🤖 | Agent 管理 | agent 列表 + 配置面板 |
| 🛒 | Marketplace | 商城浏览 + 搜索 |
| ⚙ | 设置 | workspace / 用户设置 |

### 10.3 关键交互细节

**1. 文件双击编辑**
- 双击 → 编辑器 tab 打开（固定）
- 单击 = 预览（轻量 tab）

**2. 跨视图拖拽**
- IM 附件 → 编辑器（自动下载到 workspace）
- 文件树 → IM 输入框（作为附件）

**3. 全局搜索**
- Cmd+P: 快速打开文件
- Cmd+Shift+P: 命令面板

**4. Agent 主动通知**
- IM 消息 → 红点
- 任务完成 → 桌面系统通知
- 报错 → 顶部 banner

**5. 协作感知**
- 在线状态绿点
- Git push/pull 实时提示

### 10.4 技术选型

| UI 部分 | 技术 |
|---|---|
| 整体框架 | Electron + React 18 |
| 状态管理 | Zustand + React Query |
| 样式 | Tailwind CSS + CSS Modules |
| 组件库 | Radix UI + Shadcn/ui |
| 编辑器 | Monaco Editor |
| 文件树 | 自实现（virtualized, `react-window`） |
| Markdown 渲染 | `react-markdown` + `remark-gfm` |
| Matrix SDK | `matrix-js-sdk` |
| Git 操作 | `isomorphic-git` 或 `nodegit` |
| 图标 | Lucide React |

### 10.5 关键设计决策

**1. 混合 VS Code + Slack 布局**
- 不是纯 IDE（缺 IM 体验）
- 不是纯聊天（缺编辑能力）

**2. Monaco 编辑器**
- VS Code 同款，功能强大

**3. Zustand 状态管理**
- 简洁且性能好

**4. 文件树 virtualized**
- 大 workspace 也流畅

---

## 11. 安全与沙箱

### 11.1 威胁模型

| 威胁 | 来源 | 风险 | 缓解 |
|---|---|---|---|
| 恶意 MCP/Skill/Agent 包 | marketplace | 高 | 沙箱 + verification + 扫描 |
| Prompt injection | 用户输入/外部数据 | 高 | WorkspaceFS + 工具白名单 |
| Agent bot 凭证泄露 | 本地存储 | 中 | OS keychain |
| 跨 workspace 数据泄露 | 配置错误 | 中 | OS 沙箱按 ws 隔离 |
| 跨 peer 消息伪造 | 恶意 peer | 中 | Matrix 鉴权 + 签名验证 |
| Git push 恶意代码 | agent 被劫持 | 中 | commit policy + 用户审查 |
| LLM API key 滥用 | 超额/攻击 | 低 | Token 配额 |
| 协调服务器入侵 | 服务器被攻破 | 高 | 不存明文（v2 E2E）+ 备份 |

### 11.2 沙箱实现

#### Linux

```bash
unshare --mount --pid --net --uts --ipc --user --map-root-user -- \
  chroot /run/agent-sandbox/<workspace_id> /usr/bin/node /path/to/agent-entry.js

mount --bind ~/AgentPlat/workspaces/proj-x /run/agent-sandbox/<workspace_id>/workspace

# cgroups v2 资源限制
echo "+memory +cpu +pids" > /sys/fs/cgroup/slice-agent-<id>/cgroup.subtree_control
echo "512M" > memory.max
echo "50 100 100000" > cpu.max
echo "100" > pids.max
```

#### macOS (sandbox-exec / Seatbelt)

```
(allow file-read* file-write* (subpath "${workspace_dir}"))
(allow file-read* (subpath "/usr/lib") (subpath "/usr/share"))
(deny file-*)
(allow network* (remote tcp "*:443"))
(allow network* (remote tcp "127.0.0.1"))
(deny network*)
```

#### Windows (Job Object + AppContainer, v2)

略，v1 仅应用层防御。

### 11.3 SandboxProvider 抽象

```typescript
interface SandboxProvider {
  spawn(opts: {
    runtime: 'node' | 'python' | 'binary';
    entry: string;
    args?: string[];
    env?: Record<string, string>;
    workspaceDir: string;
    extraReadablePaths?: string[];
    extraWritablePaths?: string[];
    network: { allowDomains: string[]; denyOthers: boolean };
    resources: { memoryMB: number; cpuPercent: number; maxProcesses: number; timeoutMs: number };
  }): SandboxProcess;
}

// LinuxSandboxProvider (unshare + chroot + cgroups)
// MacSandboxProvider (sandbox-exec)
// WindowsSandboxProvider (Job Object + AppContainer) — v2
// FallbackSandboxProvider (仅 path 检查, 开发用)
```

### 11.4 应用层防御（WorkspaceFS）

```typescript
class WorkspaceFS {
  constructor(private rootDir: string) {}
  
  private assertInWorkspace(path: string): string {
    const abs = path.isAbsolute(path) ? path : path.join(this.rootDir, path);
    const normalized = path.normalize(abs);
    const realPath = fs.realpathSync(normalized);
    const realRoot = fs.realpathSync(this.rootDir);
    
    if (!realPath.startsWith(realRoot + path.sep) && realPath !== realRoot) {
      throw new PermissionError(`Path ${path} escapes workspace`);
    }
    
    return realPath;
  }
  
  async writeFile(p: string, content: Buffer): Promise<void> {
    const realPath = this.assertInWorkspace(p);
    if (realPath.includes('/.git/')) {
      throw new PermissionError('Cannot write to .git directory');
    }
    return fs.writeFile(realPath, content);
  }
}
```

### 11.5 网络安全

| 出站类别 | 策略 |
|---|---|
| LLM API | 允许（域名白名单） |
| MCP remote server | 允许（按 mcp config） |
| Marketplace REST | 允许 |
| Conduit Homeserver | 允许 |
| 其他 | **默认拒绝**（沙箱层 enforce） |

### 11.6 审计日志

```sql
CREATE TABLE audit_logs (
  id TEXT PRIMARY KEY,
  timestamp TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  actor_type TEXT NOT NULL,           -- 'user' | 'agent' | 'system'
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT,
  success INTEGER NOT NULL,
  detail TEXT,
  task_id TEXT
);
```

记录的操作：文件读写、工具调用、agent 启停、权限拒绝、git 操作、marketplace 安装、IM 消息发送（仅 metadata，不记 body）。

### 11.7 关键设计决策

**1. 三层防御**
- OS 沙箱 / WorkspaceFS / 工具白名单
- 不依赖单一防御

**2. Linux/macOS 优先**
- Windows 完整沙箱放 v2

**3. WorkspaceFS 阻止写 `.git/`**

**4. 网络默认拒绝**

**5. 审计但不存 IM body**

**6. 凭证不持久化到子进程**

---

## 12. 关键数据流（端到端场景走查）

### 12.1 场景一：从零到第一次和 agent 对话

1. Onboarding：内置 Conduit + 注册账号 + 生成 keypair
2. 创建 workspace：mkdir + git init + createRoom Space + 配 git remote + push
3. 添加 agent：marketplace 安装 → 注册 bot 账号 → invite → spawn 子进程
4. 对话：用户 @agent → Matrix 路由 → agent /sync 收到 → LLM 推理 → write_file + reply

### 12.2 场景二：主 agent 调度多个子 agent 完成复杂任务

1. pm-agent (main) 收到任务
2. LLM 决定并行 dispatch:requirement-analyst + dispatch:ui-design
3. 两个子 agent 同时处理，task_reply completed
4. pm-agent 收到回复，dispatch:coder 实现
5. coder 写代码 + git_commit + push
6. pm-agent 汇总

### 12.3 场景三：跨 peer 协作（Alice 邀请 Bob）

1. Alice invite Bob 进 Space + grant git token
2. Bob 接受 → join Space + git clone
3. Bob 看到完整文件 + IM 历史
4. Bob @ Alice 的 agent → 消息路由到 Alice 端 → agent 在 Alice 机器执行
5. 同时编辑时 → git 冲突 → UI 解决

### 12.4 场景四：用户从 marketplace 安装 HTTP MCP

1. 浏览 → 选 github-mcp (HTTP)
2. 接入 → 输入 token → 测试连接
3. 分配给 coder-agent
4. 使用：coder 调 mcp:github:list_pull_requests → 主进程路由到 HTTP MCP → 返回结果

### 12.5 场景五：Skill 渐进式披露效果

```
启动 (Layer 1): skill 索引 ~150 tokens
任务匹配 (Layer 2): loadSkill 加载正文 ~3000 tokens
深入资源 (Layer 3): readResource 加载 checklist ~1000 tokens
总消耗 ≈ 4K tokens (vs 无 skill 方式 16K)
节省: 75%
```

### 12.6 场景六：Agent 提交代码 + 触发 git policy

1. Alice 调度携带 commitConvention
2. Agent 实现代码
3. 调 git_commit → 校验 S/B 规则 → commit + trailers → push
4. file_event 通知 room

### 12.7 场景七：Agent 崩溃恢复

1. 子进程 OOM 退出
2. 主进程检测 → UI banner → room 系统消息
3. 自动重启（3 次内）
4. 子进程重新 /sync（从 since_token 续传）
5. 进行中任务标记 stale
6. 3 次失败 → 标记 error → 等待用户手动重启

---

## 13. v1 MVP 范围与里程碑

### 13.1 范围划定原则

v1 聚焦"**单机自洽 + 单 agent 闭环可用**"。P2P 协作、marketplace 上架、复杂沙箱等作为 v2+ 推进。

判据：用户能独立用 v1 完成一个真实工作流（创建 workspace → 装 agent → 聊天 → agent 调工具/写文件）。

### 13.2 v1 / v2 / v3 功能矩阵

| 功能类别 | v1 | v2 | v3+ |
|---|---|---|---|
| **核心运行时** | | | |
| Electron + React + Node.js 框架 | ✅ | | |
| 内置 Conduit（独立模式） | ✅ | | |
| 连接外部 homeserver（协作模式） | | ✅ | |
| Agent 子进程（Node.js runtime） | ✅ | | |
| OS 沙箱（Linux: namespace/cgroups） | ✅ | | |
| OS 沙箱（macOS: sandbox-exec） | ✅ | | |
| OS 沙箱（Windows: AppContainer） | | ✅ | |
| **Workspace** | | | |
| Workspace CRUD | ✅ | | |
| Workspace → 目录映射 | ✅ | | |
| 单 main 分支 Git 同步（本地） | ✅ | | |
| Git push/pull 到协调服务器 | | ✅ | |
| 分支工作流 | | | ✅ |
| Commit message 规则校验 | ✅ | | |
| **Agent** | | | |
| Agent 定义 — declarative runtime | ✅ | | |
| Agent 定义 — programmatic runtime + Agent SDK | | ✅ | |
| Agent 定义 — external runtime (桥接 OpenCode/Codex 等) | | ✅ | |
| Agent 实例化 | ✅ | | |
| 主子 agent 关系 + 调度 | ✅ | | |
| Agent 并发处理多任务 | | ✅ | |
| **IM** | | | |
| 1:1 / 群聊 / @ 提及 | ✅ | | |
| 自定义消息类型 | ✅ | | |
| 跨 homeserver federation | | | ✅ |
| E2E 加密 | | ✅ | |
| 消息搜索 | | ✅ | |
| **MCP** | | | |
| MCP stdio transport | ✅ | | |
| MCP Streamable HTTP | | ✅ | |
| MCP HTTP+SSE 兼容 | | ✅ | |
| MCP 共享进程池 | ✅ | | |
| **Skill** | | | |
| SKILL.md 加载（渐进式披露） | ✅ | | |
| Skill 附加资源按需读取 | ✅ | | |
| Skill 动态发现 | | ✅ | |
| **Marketplace** | | | |
| 浏览/搜索 | ✅ | | |
| 安装 stdio MCP / Skill / Agent 包 | ✅ | | |
| 接入 HTTP/SSE MCP | | ✅ | |
| 用户上架 | | ✅ | |
| 评价/评论 | | ✅ | |
| 私有 marketplace | | | ✅ |
| 付费/计费 | | | ✅ |
| **UI** | | | |
| 主框架 | ✅ | | |
| IM 视图 | ✅ | | |
| 文件浏览器 + Monaco 编辑器 | ✅ | | |
| Agent 管理视图 | ✅ | | |
| Marketplace 视图 | ✅ | | |
| Onboarding 流程 | ✅ | | |
| 协作感知 | | ✅ | |
| LSP 集成 | | ✅ | |
| **安全** | | | |
| WorkspaceFS 应用层防御 | ✅ | | |
| 工具权限白名单 | ✅ | | |
| OS keychain 凭证管理 | ✅ | | |
| 审计日志 | ✅ | | |
| Token 配额 | | ✅ | |
| **P2P 协作** | | | |
| 多 peer workspace | | ✅ | |
| 跨 peer agent 调用 | | ✅ | |
| NAT 打洞 | | | ✅ |
| Headless agent runner | | | ✅ |

### 13.3 v1 里程碑

```
M0: 项目骨架 (2 周)
  - Electron + React + TypeScript 项目初始化
  - 主框架布局
  - 内置 Conduit 集成
  - 基础 SQLite + keychain 接入
  - matrix-js-sdk 接入 + 登录流程
  - Onboarding 向导 v0
  
  交付: 用户能启动应用 + 注册账号 + 看到主界面 (空)

M1: Workspace + 单 agent 闭环 (3 周)
  - Workspace CRUD UI + SQLite 持久化
  - 本地 git init
  - 文件浏览器 (virtualized tree)
  - Monaco 编辑器集成
  - Agent 定义格式 (YAML) + 解析
  - Agent 子进程启动 (Linux namespace 沙箱)
  - 内置 demo agent (requirement-analyst, coder)
  - 基础 IM (DM + 团队群 + @ mention)
  - 单 agent 与用户聊天 + 读写文件
  
  交付: 用户能创建 workspace + 启动 agent + 聊天 + 看 agent 改文件

M2: 主子调度 + MCP + Skill (3 周)
  - 主子 agent 关系 + dispatch via IM
  - 自定义消息类型 + UI 渲染
  - MCP stdio transport
  - MCP 工具调用流程
  - tool_result 消息渲染
  - Skill 包格式 + SkillRegistry
  - loadSkill / readResource 虚拟工具
  - 三层能力叠加
  - Agent 配置 UI
  
  交付: 主 agent 调度子 agent; agent 调 MCP 工具; agent 用 skill

M3: 安全加固 + Git Policy + Onboarding 完善 (2 周)
  - WorkspaceFS 完整实现
  - 工具权限白名单 UI + 强制执行
  - macOS sandbox-exec 集成
  - 审计日志 + UI
  - Commit message 规则校验
  - Agent 崩溃自动重启
  - Onboarding 完整流程
  
  交付: 生产可用的安全边界 + 企业 git policy 支持

M4: Marketplace 集成 + 收尾 (2 周)
  - Marketplace REST API
  - 浏览/搜索 UI
  - 安装 stdio MCP / Skill / Agent 包
  - 依赖检查 + 自动安装
  - verification status 显示
  - 内置公开 marketplace
  - 打包发布 (macOS .dmg / Linux .deb / Windows .exe)
  
  交付: v1 GA

[Total: ~12 周开发, 含测试 + 文档]
```

### 13.4 v1 验收标准

用户能完成以下完整流程，且无 crash、无明显性能问题：

1. ✅ 安装应用，3 分钟内完成 Onboarding
2. ✅ 创建 workspace "demo"，git init 成功
3. ✅ 从 marketplace 安装 requirement-analyst + coder 两个 agent
4. ✅ 把两个 agent 分配到 workspace，看到它们在 IM 群里"上线"
5. ✅ 在 IM 中 @requirement-analyst 梳理一个简单需求，agent 输出 Markdown 文档并写入 workspace
6. ✅ 文件浏览器双击打开 agent 写的文档，编辑器正常显示
7. ✅ @coder 实现需求中描述的功能，agent 写代码并 commit（自动 commit message 符合 workspace 规则）
8. ✅ 查看 git 历史，看到 agent 的 commits 含正确 trailers
9. ✅ 主 agent（pm-agent）能调度 requirement + coder 完成全流程
10. ✅ Agent 崩溃后能在 30s 内自动重启

### 13.5 v1 风险

| 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|
| Conduit 集成问题 | 中 | 高 | 提前 spike；备选 Dendrite；最差降级外部 homeserver |
| Linux namespace 沙箱在某些发行版异常 | 中 | 中 | 提供 fallback + 文档 |
| matrix-js-sdk 在 Electron 性能 | 中 | 中 | 早期性能测试；备选 matrix-rust-sdk |
| Monaco 大文件性能 | 低 | 低 | 默认限制 10MB |
| Skill 加载影响 LLM 推理质量 | 中 | 中 | 多模型测试 + skill 编写指南 |

### 13.6 v1 不做的事

| 不做 | 原因 |
|---|---|
| 多 peer 协作 | v1 验证单机体验 |
| 跨 homeserver federation | v1 仅单 homeserver |
| MCP HTTP/SSE | v1 仅 stdio MCP |
| Marketplace 上架 | v1 仅消费 |
| E2E 加密 | v1 走 TLS |
| Windows 完整沙箱 | v1 Windows 仅应用层防御 |
| LSP 集成 | v1 仅语法高亮 |
| 评价系统 | v1 仅展示下载量 |
| Agent 并发多任务 | v1 每 agent 一次一任务 |
| Headless agent | v1 桌面端必须运行 |

---

## 14. 开放问题与后续决策

### 14.1 待研究的技术选型（v1 实施前需 spike）

| 问题 | 选项 | 决策时机 |
|---|---|---|
| Conduit 内嵌 Electron 分发方式 | (a) 随 app 打包预编译 (b) 首次启动下载 (c) Docker sidecar | M0 前 |
| Git 操作库 | (a) isomorphic-git (b) nodegit (c) 系统 git CLI | M1 前 |
| Matrix SDK | (a) matrix-js-sdk (b) matrix-rust-sdk WASM | M0 前 |
| macOS sandbox-exec 签名问题 | 是否需要 Apple Developer 签名 | M3 前 |
| LLM Provider 抽象 | 自实现 vs LangChain.js / Vercel AI SDK | M1 前 |

### 14.2 商业 / 产品层面待决策

| 问题 | 建议 |
|---|---|
| 公开 marketplace 由谁运营 | 项目方提供官方实例 |
| 是否提供官方云协调服务器 | v2 提供（让用户无需自建 homeserver） |
| 开源协议 | 核心 Apache 2.0 / AGPL，marketplace 服务单独 |
| 商业模式 | 暂不锁定；SaaS / 企业版 / marketplace 分成 都是可能路径 |
| 目标用户画像 | v1 面向独立开发者 + 小团队（2-5 人） |

### 14.3 v2 路线

```
v2.0 (v1 GA 后 3-4 个月):
  ★★★ 多 peer 协作 (核心)
  ★★★ Marketplace 上架
  ★★★ Agent SDK + programmatic runtime  ★ 新
       - @agentplatform/sdk (TypeScript / Python)
       - 支持自定义生命周期、状态机、混合 LLM+规则
  ★★☆ MCP HTTP/SSE 支持
  ★★☆ E2E 加密 (人↔人 DM)
  ★★☆ 消息搜索
  ★★☆ External runtime 桥接  ★ 新
       - subprocess / HTTP / WebSocket bridge
       - 官方支持 OpenCode / Codex / Claude Code adapter
  ★☆☆ macOS sandbox 完整化
  ★☆☆ Windows 沙箱

v2.1 (再 2-3 个月):
  ★★★ 分支工作流
  ★★☆ Agent 并发多任务
  ★★☆ Token 配额管理
  ★☆☆ LSP 集成
  ★☆☆ 协作实时编辑

v3.0+ (长期):
  - Federation
  - 私有 marketplace
  - 付费/计费
  - Headless agent runner
  - 移动端
  - NAT 打洞
  - Agent 状态持久化 (跨重启)
  - 自动能力发现
```

### 14.4 SDK 详细设计（v2 实施时补完）

v1 spec 只描述了 SDK 的接口轮廓（第 6.3 节）。v2 实施时需补完：

| 主题 | 现状 | 何时补 |
|---|---|---|
| SDK 完整 API 文档 | 仅核心接口示意 | v2.0 实施时 |
| 各能力客户端详细 API（LLM/MCP/FS/Skill/IM/Dispatch） | 仅类型签名 | v2.0 实施时 |
| Python SDK parity | 仅提及，无细节 | v2.0 实施时 |
| 桥接协议规范（subprocess JSON schema） | 第 6.2.3 有示例 | v2.0 实施时规范化 |
| 官方 external adapter（OpenCode/Codex/Claude Code） | 无 | v2.0/v2.1 各出一个 |
| Agent 状态持久化 | 无 | v3 |
| SDK 版本兼容性策略 | 仅提及 sdkVersion 字段 | v2.0 实施时定义 |

### 14.5 设计中暂未深入的部分

| 主题 | 何时补完 |
|---|---|
| 错误码 / 错误处理规范 | M1 实施时定义 `errors.md` |
| 日志格式 / 日志级别 | M0 实施时定义 |
| 国际化 (i18n) | v2 引入 |
| 主题（dark/light） | M2 UI 实施时定义 design token |
| 键盘快捷键完整表 | M4 实施时整理 |
| 数据迁移（schema 变更） | M0 实施时引入 SQLite migration 框架 |
| 自动更新机制 | M4 实施时引入（electron-updater） |
| 崩溃报告 / 遥测 | v2 引入（隐私优先，opt-in） |

### 14.6 关键风险登记册

| ID | 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|---|
| R-01 | Conduit 内嵌不稳 | 中 | 高 | 早期 spike + 备选 |
| R-02 | Matrix 协议复杂度超预期 | 中 | 中 | v1 用最少 Matrix 特性 |
| R-03 | LLM 调度循环失控 | 高 | 中 | 工具调用次数硬上限 + token 配额 |
| R-04 | Skill 渐进式披露 LLM 不主动 loadSkill | 中 | 中 | system prompt 引导 + 测试 |
| R-05 | 沙箱逃逸漏洞 | 低 | 高 | 三层防御 + 安全审计 |
| R-06 | Git 冲突处理 UX 不佳 | 中 | 低 | v1 默认人工 + v2 agent 辅助 |
| R-07 | 协调服务器单点故障 | 中 | 高 | v1 仅独立模式规避 |
| R-08 | Marketplace 恶意包 | 中 | 高 | verification + 扫描 + 沙箱 |
| R-09 | Agent SDK 设计不当（v2）— 抽象泄露、能力客户端不一致、用户难用 | 中 | 高 | v2 实施前 oracle 评审 + 早期 5+ 试点 agent 验证 API |
| R-10 | External bridge 协议不稳定（OpenCode/Codex 升级破坏兼容） | 高 | 中 | adapter 跟随外部版本；CI 跑兼容性测试；明确 supported versions 矩阵 |
| R-11 | programmatic agent 沙箱逃逸（用户代码绕过 SDK 直调 fs） | 中 | 高 | 沙箱层强制（OS namespace）；SDK fs 客户端只是 wrapper 不是 boundary |

---

## 附录 A：术语表

| 术语 | 定义 |
|---|---|
| Workspace | 工作空间，用户的工作单元，映射到一个目录 + Matrix Space + Git repo |
| Agent | 智能体，LLM 驱动的 worker，注册为 Matrix bot 账号 |
| AgentDefinition | Agent 模板（YAML manifest），可被多个 workspace 复用 |
| AgentAssignment | Agent 在 workspace 中的实例化 |
| Main Agent | 主 agent，可调度归属的子 agent |
| Sub Agent | 子 agent，归属于某个 main agent |
| MCP | Model Context Protocol，标准化外部资源访问协议 |
| Skill | 知识包（SKILL.md + 资源），通过渐进式披露注入 LLM context |
| Marketplace | 商城，发布和安装 Agent / MCP / Skill 的中心 |
| Conduit | Matrix homeserver 的 Rust 实现 |
| Coordination Server | 协调服务器，运行 Conduit + Git server + Marketplace |
| Peer | 协作节点，一个桌面客户端实例 |
| Space | Matrix 的房间分组概念，对应 workspace |
| Power Level | Matrix 的权限等级（0-100） |
| Bot | Matrix 中的非人账号，agent 是 bot |
| SandboxProvider | 沙箱抽象接口，按 OS 平台分发 |
| WorkspaceFS | 应用层文件系统抽象，强制 path 在 workspace 内 |
| Progressive Disclosure | 渐进式披露，Skill 的三层加载机制 |
| Agent Runtime Type | Agent 定义的三种模型之一：declarative / programmatic / external |
| Declarative Agent | 配置式 agent，仅 YAML manifest + system prompt + tools |
| Programmatic Agent | 代码式 agent，实现 Agent SDK 接口，可写任意自定义逻辑 |
| External Agent | 桥接外部 agent 运行时（OpenCode/Codex 等），通过 bridge 协议通信 |
| Agent SDK | `@agentplatform/sdk`（TS）/ `agentplatform-sdk`（Py），programmatic agent 的开发套件 |
| Bridge Protocol | external runtime 与平台通信的协议（subprocess stdio JSON / HTTP / WebSocket） |
| Skill Script Runner | 按需 spawn 的子进程，执行 skill 包内的脚本资源（如 parse_pdf.py） |

## 附录 B：参考文档

- Matrix 协议规范：https://spec.matrix.org/
- Conduit (Rust Matrix homeserver)：https://conduit.rs/
- Model Context Protocol：https://modelcontextprotocol.io/
- Anthropic Agent Skills：https://docs.anthropic.com/en/docs/agent-skills
- Anthropic Skills 仓库：https://github.com/anthropics/skills
- Electron：https://www.electronjs.org/
- Monaco Editor：https://microsoft.github.io/monaco-editor/
- matrix-js-sdk：https://github.com/matrix-org/matrix-js-sdk

---

**文档结束**
