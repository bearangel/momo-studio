# Agent 定义/分配解耦 + Workspace 隔离 设计

**日期**：2026-08-03
**状态**：草案
**作者**：Sisyphus（基于用户深度讨论）

## 1. 问题陈述

当前 `agent_definitions` 表把「agent 是什么」（身份/能力/模型）和「agent 在某 workspace 怎么用」（角色/父子关系）混在一起，且定义全局共享无 workspace 边界。具体痛点：

1. **自定义 agent 全局可见**：workspace A 创建的自定义 agent，在 workspace B 的「添加 agent」下拉里仍然出现。
2. **编辑入口缺失**：编辑按钮只在「当前 workspace 已分配的 agent」列表项里，导致自定义 agent 没分配到当前 workspace 时找不到编辑入口。
3. **main↔sub 关系全局化**：在 workspace A 配的 PM↔Coder 父子关系全局生效，workspace B 里无法重新组合。
4. **角色与定义耦合**：同一个 agent definition 在不同 workspace 想当不同角色（A 里是 main，B 里是 standalone）不可能。

四个痛点都是同一架构问题的症状：definition 重载了过多语义。

## 2. 核心原则

**Definition = "agent 是什么"**
- 身份、能力（tools/mcps/skills）、systemPrompt、模型配置（provider + model name）
- 可全局共享（`workspace_id IS NULL`）或 workspace 私有（`workspace_id = X`）
- builtin 永远 global；custom 创建时由用户选 scope

**Assignment = "agent 在某 workspace 怎么用"**
- 角色（main / sub / standalone）、父子关系（parent_instance_id）、运行实例
- 永远 workspace-scoped
- 可选 API key override（默认用 def 的 provider key）

## 3. Schema 改动 + 迁移

### 3.1 新增迁移文件 `007_agent_role_separation.sql`

#### 阶段 1：加列

```sql
-- agent_definitions 新增列（model_name 已存在，无需重复加）
ALTER TABLE agent_definitions ADD COLUMN workspace_id TEXT;
ALTER TABLE agent_definitions ADD COLUMN model_provider_id TEXT;

-- agent_assignments 新增列
ALTER TABLE agent_assignments ADD COLUMN role TEXT NOT NULL DEFAULT 'standalone';
ALTER TABLE agent_assignments ADD COLUMN parent_instance_id TEXT;
ALTER TABLE agent_assignments ADD COLUMN has_api_key_override INTEGER NOT NULL DEFAULT 0;

CREATE INDEX idx_agent_definitions_workspace ON agent_definitions(workspace_id);
CREATE INDEX idx_agent_assignments_parent ON agent_assignments(workspace_id, parent_instance_id);
```

> `has_api_key_override` 是 DB 中的标志位（实际 key 在 keychain `agent.<id>.api_key_override`）。设/清 override 时同步更新此列。运行时按此列决定查哪把 key。

#### 阶段 2：数据回填

```sql
-- 2a. assignment.role 从老 def.type 推导
UPDATE agent_assignments
SET role = (
  SELECT CASE d.type
    WHEN 'main' THEN 'main'
    WHEN 'sub' THEN 'sub'
    ELSE 'standalone'
  END
  FROM agent_definitions d
  WHERE d.id = agent_assignments.agent_definition_id
);

-- 2b. assignment.parent_instance_id 从老 def.parentAgentId + 同 ws 父 assignment 推导
UPDATE agent_assignments a
SET parent_instance_id = (
  SELECT pa.instance_id
  FROM agent_definitions d
  JOIN agent_assignments pa
    ON pa.agent_definition_id = d.parent_agent_id
    AND pa.workspace_id = a.workspace_id
  WHERE d.id = a.agent_definition_id
    AND d.parent_agent_id IS NOT NULL
)
WHERE EXISTS (
  SELECT 1 FROM agent_definitions d
  WHERE d.id = a.agent_definition_id AND d.parent_agent_id IS NOT NULL
);

-- 2c. 老的 model_name 字段值保留（列已存在，无需 UPDATE）；新的 model_provider_id 留 NULL（强制重配）
-- 老的 keychain 'agent.<id>.llm_api_key' 不迁移；has_api_key_override 默认 0
```

> 实际迁移用 JS（项目 migrations 是 TS 内联字符串常量，AGENTS.md 说明），而不是 `.sql` 文件。SQL 表达式仅供参考。如某 sub 的父 def 未在同 ws 分配，`parent_instance_id` 留 NULL → UI 显示「孤儿 sub」徽标，用户可手动补 parent 或改 role。

#### 阶段 3：删旧列

```sql
ALTER TABLE agent_definitions DROP COLUMN type;
ALTER TABLE agent_definitions DROP COLUMN parent_agent_id;
ALTER TABLE agent_definitions DROP COLUMN model_provider;
ALTER TABLE agent_definitions DROP COLUMN model_base_url;
```

> SQLite 3.35+ 支持 DROP COLUMN。better-sqlite3 v11+ 自带 SQLite 3.42+，无兼容问题。

### 3.2 最终 Schema

#### `agent_definitions`

```
id, slug, name, version, runtime, system_prompt,
default_tools (JSON), default_mcps (JSON), default_skills (JSON),
source, description, icon_emoji, created_at,
workspace_id,           -- 新增；NULL=global，非 NULL=该 ws 私有
model_provider_id,      -- 新增；NULL=builtin 未配置；custom 必填
model_name              -- 复用旧列；builtin/custom 必填
```

#### `agent_assignments`

```
instance_id, workspace_id, agent_definition_id, bot_matrix_user_id,
enabled, created_at,
role,                       -- 新增；'standalone' | 'main' | 'sub'
parent_instance_id,         -- 新增；NULL=无父（role!='sub' 或孤儿 sub）
has_api_key_override        -- 新增；0/1，DB 标志（实际 key 在 keychain）
```

### 3.3 Keychain 三个 key

```
provider.<providerId>.api_key         -- 供应商注册时存（不变）
agent.<instanceId>.api_key_override   -- 新增；存在 = override
agent.<instanceId>.llm_api_key        -- 老格式；迁移后丢弃，不再读
```

Runtime 解析顺序：
```typescript
const apiKey = (await getSecret(`agent.${instanceId}.api_key_override`))
            ?? (await getSecret(`provider.${def.modelProviderId}.api_key`));
if (!apiKey) throw new Error('未配置 API key');
```

### 3.4 边界情况

| 场景 | 迁移后行为 |
|---|---|
| 现有 def 在 `agent_assignments` 中被引用 | assignment 保留，但 def 的 `model_provider_id=NULL` → assignment 启动会失败 → UI 提示「请先配置 def 的 provider」 |
| 现有 sub def 的父 def 未分配到同 ws | `parent_instance_id=NULL` + `role='sub'` → UI 显示「孤儿 sub」徽标 |
| Builtin def 的 YAML 含 `type`/`parentAgentId` | 不写入 DB；存内存 `builtinSuggestions` Map（仅 UI 默认值） |
| Keychain 老的 `agent.<id>.llm_api_key` | 不删不读；用户主动操作可清 |

## 4. IPC API 改动

### 4.1 类型定义

```typescript
// renderer/src/ipc/types.d.ts

export type AgentRole = 'standalone' | 'main' | 'sub';

export interface AgentDefinition {
  id: string;
  name: string;
  slug: string;
  version: string;
  runtime: string;
  systemPrompt: string;
  defaultTools: Array<{ kind: string; ref: string }>;
  defaultMcps?: Array<{ kind: 'mcp'; ref: string; versionRange?: string }>;
  defaultSkills?: Array<{ kind: 'skill'; ref: string; versionRange?: string }>;
  source: string;
  description: string;
  iconEmoji: string;
  /** NULL=全局共享；非 NULL=该 workspace 私有 */
  workspaceId: string | null;
  /** NULL=builtin 未配置；custom 必填 */
  modelProviderId: string | null;
  /** 模型名（如 gpt-4o） */
  modelName: string;
}

export interface AgentAssignment {
  instanceId: string;
  workspaceId: string;
  agentDefinitionId: string;
  botMatrixUserId: string;
  enabled: boolean;
  createdAt: string;
  role: AgentRole;
  /** 父 assignment instanceId（仅 role='sub' 时有值；同 workspace 内） */
  parentInstanceId: string | null;
  /** 有无 API key override（实际 key 在 keychain） */
  hasApiKeyOverride: boolean;
}

export interface BuiltinSuggestion {
  role: AgentRole;
  suggestedParentDefId?: string;
  /** builtin YAML 的 platform 信息；UI 据此在 provider 下拉预选匹配项 */
  suggestedPlatform?: 'openai' | 'anthropic';
}
export type BuiltinSuggestionMap = Record<string, BuiltinSuggestion>;
```

### 4.2 IPC 方法签名

```typescript
agent: {
  /** 列出 agent 定义。workspaceId 提供时只返回 global + 该 ws scoped + 全部 builtin */
  list(workspaceId?: string): Promise<AgentDefinition[]>;

  /** 一键编排：注册 bot + 分配（带 role）+ 邀请 + 启动 */
  addToWorkspace(input: {
    workspaceId: string;
    agentDefinitionId: string;
    role: AgentRole;
    parentInstanceId?: string;       // role='sub' 时必填
    apiKeyOverride?: string;         // 可选；空 = 用供应商 key
  }): Promise<AgentAssignment>;

  /**
   * 安装 main agent 并自动跟随注册其选中的 sub agent。
   * 内部行为：写 assignment.role='main'（首条）+ role='sub'（其余）+ parent_instance_id 链。
   * 校验：main def 和全部 selectedSubDefIds 都必须有 modelProviderId（未配置 → throw）。
   *       任一 sub def 未配置 provider 时拒绝整个安装（避免半残状态）。
   */
  assignMain(input: {
    workspaceId: string;
    mainDefId: string;
    apiKeyOverride?: string;          // 可选；空 = 用 main def 的 provider key
    selectedSubDefIds?: string[];
  }): Promise<AgentAssignment[]>;

  /** 创建自定义 agent 定义 */
  createCustom(input: {
    name: string;
    slug: string;
    description: string;
    systemPrompt: string;
    iconEmoji?: string;
    scope: 'global' | 'workspace';
    modelProviderId: string;        // 必填
    modelName: string;              // 必填
  }): Promise<AgentDefinition>;

  /** 更新 agent 定义字段（含 model 切换）。停止全部运行中实例（应用新配置需重启） */
  updateDefinition(input: {
    id: string;
    name?: string;
    description?: string;
    systemPrompt?: string;
    iconEmoji?: string;
    scope?: 'global' | 'workspace';
    modelProviderId?: string;
    modelName?: string;
  }): Promise<{ definition: AgentDefinition; stoppedInstanceIds: string[] }>;

  /** 列出某 workspace 全部 assignment，含 role + parent_instance_id + hasApiKeyOverride */
  listAssignments(workspaceId: string): Promise<AgentAssignment[]>;

  /** 修改现有 assignment 的角色/父。先停止该实例 runtime。
   *  role='sub' 时 parentInstanceId 必填且同 ws。
   *  校验：避免循环引用（parent 不能是自己或自己的子树）。
   *  从 main 改为非 main 时，全部 role='sub' parent=我的 subs 也一并停止。
   */
  updateAssignmentRole(
    instanceId: string,
    role: AgentRole,
    parentInstanceId?: string,
  ): Promise<{ stoppedInstanceIds: string[] }>;

  /** 设置/清除 assignment 的 API key override。
   *  apiKey=null 清除 override，回退到供应商 key。
   *  不停止 runtime（下次启动生效；用户可在 UI 主动重启）。
   */
  updateAssignmentApiKey(
    instanceId: string,
    apiKey: string | null,
  ): Promise<void>;

  /** 删除自定义 agent 定义。builtin 不可删。
   *  级联：找到全部引用此 def 的 assignment → 停止 runtime → bot 离开房间 → 删 assignment → 删 def。
   *  workspace-scoped 的 def 删除只影响该 ws。
   */
  deleteDefinition(defId: string): Promise<{ stoppedInstanceIds: string[] }>;

  /** 返回 builtin YAML 的角色/platform 建议（UI 添加 builtin 时预填） */
  getBuiltinSuggestions(): Promise<BuiltinSuggestionMap>;

  // 不变：createFromYaml, assign, listAssignments, start, stop, removeAssignment,
  //       isRunning, onRuntimeChanged
  // ❌ 删除：updateApiKey（被 updateAssignmentApiKey 替代）
};
```

## 5. UI 改动

### 5.1 AgentsView 整体结构

现有 AgentList 拆为 Tab 容器 + 两个面板：

```
┌──────────────────────────────────────────────────────────┐
│ AgentsView                                                │
│ ┌─────────────────────┬────────────────────────────────┐ │
│ │ [本工作空间] [Agent 库] │ 顶部工具栏（按 Tab 切换）        │ │
│ │                     │                                │ │
│ │ Tab 内容             │ Tab 内容                       │ │
│ │                     │                                │ │
│ └─────────────────────┴────────────────────────────────┘ │
└──────────────────────────────────────────────────────────┘
```

Tab 切换不持久化（默认「本工作空间」）。Switch workspace 时如当前在「Agent 库」则留在此 Tab。

### 5.2 Tab 1：本工作空间（`WorkspaceAgentsPanel`）

列表按 main→sub 树形分组：

```
── Standalone ──
  🤖 Helper · 独立                          [▶ 运行中]
    操作：编辑角色 / 停止 / 更新密钥 / 移除

── Main ──
  📋 PM · 主 agent                          [▶ 运行中]
    [⭐ 协调] [编辑角色] [停止] [更新密钥] [移除]

  ── Sub of PM ──
    🔗 Coder · 子 agent (parent: PM)        [▶ 运行中]
      [编辑角色] [停止] [更新密钥] [移除]

  ── Orphan ──
    ⚠️ Old · 子 agent (无父) [建议: 选 PM 或改独立]
```

**关键变化 vs 现状**：
- 树形分组（按 role + parent）
- 「编辑 def」按钮**移除**——def 编辑只在 Agent 库 Tab
- 新增「孤儿 sub」警告徽标
- 「移除 main」级联检查：若有 subs，弹窗确认「同时移除全部 N 个子 agent」

### 5.3 AddToWorkspaceDialog（新组件）

```
┌──────────────────────────────────────────┐
│ 添加 agent 到本工作空间                    │
│                                          │
│ 选择 agent: [📋 PM ▼]                     │
│   ↑ list(currentWorkspaceId)，含 builtin +  │
│     global custom + 当前 ws scoped custom │
│   ↑ 如选中 def 的 modelProviderId=NULL，   │
│     禁用提交并提示「请先到 Agent 库配置」    │
│                                          │
│ 角色:                                     │
│   ( ) 独立                                │
│   (•) 主 agent                            │
│   ( ) 子 agent                            │
│   ↑ builtin 默认选中建议角色（来自          │
│     getBuiltinSuggestions）               │
│                                          │
│ 父主 agent: [📋 PM ▼]   ← 仅 role='sub' 显示 │
│   ↑ 列表：当前 ws 已分配的 role='main'      │
│                                          │
│ API Key (可选): [_______________]          │
│   placeholder: "留空使用供应商默认 key"     │
│                                          │
│              [取消] [添加并启动]           │
└──────────────────────────────────────────┘
```

入口两个：
- Tab 1 顶部「+ 添加 agent」按钮
- Tab 2 每个 def 后的「+ 加入到当前工作空间」按钮（预填 def）

### 5.4 AssignmentRoleEditor（新组件）

```
┌──────────────────────────────────────────┐
│ 编辑角色：🔗 Coder                         │
│                                          │
│ 当前角色: 子 agent (parent: PM)            │
│                                          │
│ 新角色:                                   │
│   ( ) 独立                                │
│   ( ) 主 agent                            │
│   (•) 子 agent                            │
│                                          │
│ 父主 agent: [📋 PM ▼]                     │
│                                          │
│ ⚠️ 应用新角色需停止并重启该 agent 实例      │
│                                          │
│              [取消] [应用并重启]           │
└──────────────────────────────────────────┘
```

提交调用 `agent.updateAssignmentRole`。主进程停止该实例（+ 其全部 subs，如果从 main 改为非 main）→ 更新 DB → 返回 stoppedInstanceIds → UI 提示用户重启。

### 5.5 AssignmentApiKeyEditor（新组件，替代「更新密钥」）

始终显示 API key 输入框：

```
┌──────────────────────────────────────────┐
│ 更新 API Key：🔗 Coder                     │
│                                          │
│ API Key: [_______________]                │
│   placeholder: "留空使用供应商默认 key"     │
│   ↑ 当前值：如果有 override 显示占位（密码），否则空 │
│                                          │
│ ℹ️ 留空清除 override，回退到供应商 key。    │
│ ℹ️ 运行中实例需手动重启生效。              │
│                                          │
│              [取消] [保存]                │
└──────────────────────────────────────────┘
```

提交调用 `agent.updateAssignmentApiKey`。

### 5.6 Tab 2：Agent 库（`AgentLibrary`）

```
┌────────────────────────────────────────────────────────┐
│ Agent 库 · global + 本工作空间 + builtin                 │
│ [+ 新建 agent 定义] [🔍 搜索...]                        │
├────────────────────────────────────────────────────────┤
│ ── 内置 agent ──────────────────────────────────────── │
│   📋 PM            slug: pm          [内置]            │
│     模型: 未配置 / OpenAI gpt-4o                        │
│     [配置] [+ 加入到当前工作空间]                       │
│   ↑ builtin 不可删；可「配置」（设 provider+model）；    │
│     「加入到当前工作空间」跳到 Tab 1 并预填             │
│                                                        │
│ ── 全局自定义 ──────────────────────────────────────── │
│   🤖 My Helper     slug: my-helper    [全局]            │
│     模型: OpenAI gpt-4o                                 │
│     [编辑] [删除] [+ 加入到当前工作空间]                │
│                                                        │
│ ── 本工作空间私有 ──────────────────────────────────── │
│   🎯 Proj Auditor  slug: proj-aud     [工作空间]        │
│     模型: Anthropic claude-3-opus                       │
│     [编辑] [删除] [+ 加入到当前工作空间]                │
│                                                        │
└────────────────────────────────────────────────────────┘
```

**搜索行为**：搜索框实时过滤，匹配字段 `name + slug + description`，大小写不敏感。空字符串显示全部。

**关键交互**：
- 「+ 新建 agent 定义」→ 打开 `DefinitionEditor`（mode='create'）
- 「编辑」→ 打开 `DefinitionEditor`（mode='edit'，custom）
- 「配置」→ 打开 `DefinitionEditor`（mode='configure'，builtin，仅 provider+model 可改）
- 「删除」→ confirm 弹窗显示影响范围（「workspace A 的 1 个实例将停止」）→ 确认后 IPC deleteDefinition
- 「加入到当前工作空间」→ 切到 Tab 1 + 自动打开 AddToWorkspaceDialog 预填该 def

### 5.7 DefinitionEditor（替代现有 AddAgentDialog）

```
┌──────────────────────────────────────────┐
│ 新建 agent 定义 / 编辑 / 配置 builtin       │
│                                          │
│ 名称: [_______________]                   │
│   ↑ builtin configure 时只读              │
│ 标识符 (slug): [_________] (编辑时只读)    │
│   ↑ builtin configure 时不显示             │
│ 系统提示词: [_________________]            │
│   ↑ builtin configure 时只读              │
│ 图标 emoji: [🤖]                          │
│                                          │
│ 模型供应商: [🔍 | OpenAI 官方 ▼]  ← 必填   │
│   ↑ 全部 provider 列表，下拉内文本搜索     │
│   ↑ builtin configure 时按 suggestedPlatform │
│     预选匹配 provider                     │
│ 模型名: [gpt-4o___________]      ← 必填   │
│   ↑ 选 provider 时可预填 defaultModel     │
│                                          │
│ 范围:                                     │
│   (•) 仅本工作空间                         │
│   ( ) 全局共享                             │
│   ↑ 仅 create 模式显示；edit 时只读；       │
│     builtin configure 不显示               │
│                                          │
│              [取消] [创建/保存]            │
└──────────────────────────────────────────┘
```

### 5.8 删除影响范围显示

```
┌──────────────────────────────────────────┐
│ 确认删除 agent 定义                        │
│                                          │
│ 「My Helper」将被删除。影响范围：          │
│   • workspace A: 1 个运行中实例将停止      │
│   • workspace B: 无实例                    │
│                                          │
│ 此操作不可撤销。                           │
│                                          │
│              [取消] [确认删除]             │
└──────────────────────────────────────────┘
```

主进程 deleteDefinition 返回 stoppedInstanceIds，UI 提示哪些被停止需重启（如果用户后悔可重新添加）。

### 5.9 未配置 provider 的 def 显示

Agent 库 Tab 列出 def 时：
- `modelProviderId !== NULL`：正常显示模型信息（如「OpenAI gpt-4o」）
- `modelProviderId === NULL`：显示「⚠️ 未配置」徽标 + 优先显示「配置」按钮（替代「编辑」）

Tab 1 选中此 def 的 assignment（迁移后的老 assignment）：
- 显示「⚠️ def 未配置 provider，无法启动」警告
- 提供「去 Agent 库 配置」按钮跳到 Tab 2

## 6. Runtime 改动

### 6.1 AGENT_CONFIG JSON 字段

```typescript
{
  // 不变
  botUserId, botAccessToken, homeserverUrl, teamRoomId, ownerUserId,
  workspaceDir, workspaceId, subAgents, skills, mcpNames,
  allowedTools, deniedTools, isCoordinator, devMode, llmApiKey,

  // 重命名（来自 assignment.role）
  role: 'main' | 'sub' | 'standalone',    // 替代旧 agentType

  // 新增
  modelProviderId: string,                 // 来自 def
  modelName: string,                       // 来自 def

  // ❌ 删除：agentType（重命名为 role）
  // ❌ 删除：modelProvider, modelBaseUrl（合并到 modelProviderId + 主进程解析）
}
```

### 6.2 spawn-helpers.ts

`buildSpawnOpts` 改为：

```typescript
async function buildSpawnOpts(opts: {
  instanceId, botUserId, workspaceId, workspaceDir, teamRoomId, ownerUserId,
  def, botAccessToken, role, parentInstanceId?, isCoordinator,
}): Promise<RuntimeSpawnOpts> {
  // 1. 校验 def 已配置 provider
  if (!opts.def.modelProviderId) {
    throw new Error(`agent 定义「${opts.def.name}」未配置 modelProviderId，请到 Agent 库配置`);
  }
  if (!opts.def.modelName) {
    throw new Error(`agent 定义「${opts.def.name}」未配置 modelName`);
  }

  // 2. 解析 API key：override ?? provider key
  const apiKey = await resolveApiKey(opts.instanceId, opts.def.modelProviderId);

  // 3. 取 provider baseUrl（runtime 需要）
  const provider = getProvider(opts.def.modelProviderId);
  if (!provider) throw new Error(`供应商不存在: ${opts.def.modelProviderId}`);

  // 4. sub agents：仅 role='main' 时查询
  const subAgents = opts.role === 'main'
    ? await listSubAgentRefs(opts.workspaceId, opts.instanceId)
    : [];

  return {
    ...,
    role: opts.role,
    modelProviderId: opts.def.modelProviderId,
    modelName: opts.def.modelName,
    llmApiKey: apiKey,
    subAgents,
    // 注：runtime-entry 接收 modelProviderId/modelName/llmApiKey，
    // 不再接收 def.model.provider/model/baseUrl
  };
}

async function resolveApiKey(instanceId: string, providerId: string): Promise<string> {
  const override = await getSecret(`agent.${instanceId}.api_key_override`);
  if (override) return override;
  const providerKey = await getSecret(`provider.${providerId}.api_key`);
  if (!providerKey) throw new Error(`供应商 API key 丢失，请检查设置`);
  return providerKey;
}
```

### 6.3 runtime-entry.ts

`parseConfig` 改：
- 接受 `role`（替代 `agentType`）
- 接受 `modelProviderId` + `modelName`（替代 `modelProvider` + `modelBaseUrl`）
- `llmApiKey` 字段不变（spawn 前主进程已解析）

`buildRuntimeContext` 不变（subAgents 来源不变）。

`createLLMProvider` 调用变为：

```typescript
const llm = createLLMProvider(
  { model: config.modelName },  // model 字段够了；provider/baseUrl 由内部按 modelProviderId 决定
  config.llmApiKey,
);
```

> 注：llm-provider.ts 内部仍需知道 baseUrl（OpenAI / Anthropic 不同）。可以读 provider.baseUrl（通过 AGENT_CONFIG 传入）或根据 modelProviderId 硬编码。建议传入 baseUrl 简化。

最终 AGENT_CONFIG 还需含 `modelBaseUrl: string`（来自 provider.baseUrl）。`spawn-helpers.ts` 在第 3 步补充：

```typescript
return {
  ...,
  modelBaseUrl: provider.baseUrl,
};
```

## 7. Builtin 加载策略

### 7.1 builtin.ts 改动

YAML 加载逻辑：

```typescript
// 内存建议表（仅主进程，IPC getBuiltinSuggestions 返回）
const builtinSuggestions = new Map<string, BuiltinSuggestion>();

export function loadBuiltinAgents(): void {
  for (const yamlPath of discoverBuiltinYamls()) {
    const parsed = parseYaml(yamlPath);
    const def: AgentDefinition = {
      ...,
      workspaceId: null,        // builtin 永远 global
      modelProviderId: null,    // builtin 启动时无 provider，需用户配置
      modelName: parsed.model.model,
      // ❌ 不再写 type/parentAgentId 到 DB
    };
    saveAgentDefinition(def);

    // 把 YAML 的 type/parent/platform 存内存建议
    if (parsed.type || parsed.parentAgentId || parsed.model?.provider) {
      builtinSuggestions.set(def.id, {
        role: parsed.type ?? 'standalone',
        suggestedParentDefId: parsed.parentAgentId,
        suggestedPlatform: parsed.model?.provider,
      });
    }
  }
}

export function getBuiltinSuggestionsMap(): BuiltinSuggestionMap {
  return Object.fromEntries(builtinSuggestions);
}
```

### 7.2 manifest-parser.ts 改动

YAML 解析仍接受 `type` / `parentAgentId` / `model.provider` 字段（不破坏现有 YAML 格式）。返回结构：

```typescript
interface ParsedManifest {
  // definition 字段（无 type/parent/model.provider）
  name, slug, version, runtime, systemPrompt, defaultTools, source, ..., modelName,
  // 建议字段（不进 DB）
  suggestedType?: AgentRole,
  suggestedParentAgentId?: string,
  suggestedPlatform?: 'openai' | 'anthropic',
}
```

`builtin.ts` 和 marketplace install 都通过此解析器；建议字段路由到 `builtinSuggestions` 或类似机制。

## 8. 文件改动清单

### 8.1 主进程

| 文件 | 改动 |
|---|---|
| `electron/src/main/storage/migrations/007_agent_role_separation.sql` | 新增（实际是 TS 内联字符串） |
| `electron/src/main/storage/migrations/index.ts` | 注册新迁移 |
| `electron/src/main/agent/types.ts` | AgentDefinition 删 type/parent/model；AgentAssignment 加 role/parent/hasApiKeyOverride；新增 BuiltinSuggestion 类型 |
| `electron/src/main/agent/crud.ts` | listDefinitions(workspaceId?) 过滤；assignAgentToWorkspace 写 role/parent；deleteDefinition 级联；updateAssignmentRole 校验循环引用；updateAssignmentApiKey keychain 操作；listAssignments 返回 hasApiKeyOverride |
| `electron/src/main/agent/builtin.ts` | YAML 加载不写 type/parent/platform 到 DB；改写内存 builtinSuggestions Map |
| `electron/src/main/agent/manifest-parser.ts` | YAML 解析仍接受 type/parent/platform，路由到 suggestions 字段 |
| `electron/src/main/agent/ipc.handlers.ts` | 更新全部 IPC handler 签名；新增 deleteDefinition / updateAssignmentRole / updateAssignmentApiKey / getBuiltinSuggestions |
| `electron/src/main/agent/spawn-helpers.ts` | buildSpawnOpts 改读 def.modelProviderId/modelName + 解析 apiKey override + 查询 subAgents by assignment.parent_instance_id |
| `electron/src/main/agent/runtime-entry.ts` | parseConfig 改读 role/modelProviderId/modelName/modelBaseUrl（不再读 agentType/modelProvider） |
| `electron/src/main/agent/llm-provider.ts` | 适配新的 model config 结构（如有必要） |
| `electron/src/main/agent/agent-start-subagents.ts` 或对应文件 | sub-agents 来源改为按 assignment 查询，而非 def.parentAgentId |

### 8.2 Preload + Renderer

| 文件 | 改动 |
|---|---|
| `renderer/src/ipc/types.d.ts` | 类型同步 |
| `electron/src/preload/index.ts` | 桥接新 IPC 方法 |
| `renderer/src/stores/agent.store.ts` | loadDefinitions(workspaceId?)；addAgent 新签名（带 role + parentInstanceId + apiKeyOverride）；loadBuiltinSuggestions / deleteDefinition / updateAssignmentRole / updateAssignmentApiKey 新 actions |
| `renderer/src/components/agent/AgentsView.tsx` | 新组件：Tab 容器 |
| `renderer/src/components/agent/WorkspaceAgentsPanel.tsx` | 新组件：Tab 1 内容（从 AgentList 重构） |
| `renderer/src/components/agent/AgentLibrary.tsx` | 新组件：Tab 2 内容 |
| `renderer/src/components/agent/DefinitionEditor.tsx` | 新组件：def 创建/编辑/配置 builtin |
| `renderer/src/components/agent/AddToWorkspaceDialog.tsx` | 新组件：选 def + 配 role + 可选 API key override |
| `renderer/src/components/agent/AssignmentRoleEditor.tsx` | 新组件：编辑现有 assignment 的 role/parent |
| `renderer/src/components/agent/AssignmentApiKeyEditor.tsx` | 新组件：编辑现有 assignment 的 API key override |
| `renderer/src/components/agent/AgentOrchestrator.tsx` | 数据源更新（读 assignment.role/parent） |
| `renderer/src/components/agent/CapabilityConfig.tsx` | 不变 |
| `renderer/src/components/agent/AgentList.tsx` | 删除（拆分到上述新组件） |
| `renderer/src/components/agent/AddAgentDialog.tsx` | 删除（拆分到 DefinitionEditor + AddToWorkspaceDialog） |

### 8.3 测试

| 文件 | 改动 |
|---|---|
| `electron/tests/agent/crud-update.test.ts` | 适配新 API |
| `electron/tests/agent/sub-agent-install.test.ts` | 改读 assignment.parent_instance_id |
| `electron/tests/migrations/007-agent-role-separation.test.ts` | 新增迁移测试 |
| `renderer/src/stores/agent.store.test.ts` | 适配新 store actions |
| `renderer/src/components/agent/AgentsView.test.tsx` | 新增 Tab 切换 |
| `renderer/src/components/agent/WorkspaceAgentsPanel.test.tsx` | 新增分组/孤儿/级联检查 |
| `renderer/src/components/agent/AgentLibrary.test.tsx` | 新增分组显示/操作 |
| `renderer/src/components/agent/DefinitionEditor.test.tsx` | 新增 create/edit/configure 三模式 |
| `renderer/src/components/agent/AddToWorkspaceDialog.test.tsx` | 新增 role/parent/apiKeyOverride |
| `renderer/src/components/agent/AssignmentRoleEditor.test.tsx` | 新增循环引用阻断 |
| `renderer/src/components/agent/AssignmentApiKeyEditor.test.tsx` | 新增 override 设置/清除 |

## 9. 测试策略

### 9.1 主进程单元测试

- **migrations/007**：现有 def.type → assignment.role；现有 def.parentAgentId + 同 ws 父 assignment → parent_instance_id；边界（父 ws 不同→NULL）；迁移后 def 表无 type/parent_agent_id/model_provider/model_base_url 列
- **crud.listDefinitions**：global + 当前 ws scoped + builtin 都返回；其他 ws scoped 不返回
- **crud.assignAgentToWorkspace**：写 role + parent_instance_id；role='sub' 时 parent 必填校验
- **crud.deleteDefinition**：builtin 不可删；custom 级联停止 + 删 assignment + 删 def
- **crud.updateAssignmentRole**：循环引用检测；从 main 改非 main 时同步停止 subs
- **crud.updateAssignmentApiKey**：apiKey=null 清除 override；非 null 写 keychain
- **spawn-helpers.resolveApiKey**：override 优先；fallback provider key；都无时报错
- **builtin.loadBuiltinAgents**：type/parent/platform 不进 DB；suggestions 正确填充

### 9.2 IPC 集成测试

- `agent:list(workspaceId?)` 透传
- `agent:addToWorkspace` 5 个参数完整透传
- `agent:deleteDefinition` 返回 stoppedInstanceIds
- `agent:updateAssignmentRole` 校验失败时 throw
- `agent:getBuiltinSuggestions` 返回内存 Map

### 9.3 Renderer 单元测试

- **agent.store**：loadDefinitions(workspaceId) 透传；addAgent 5 参数；deleteDefinition / updateAssignmentRole / updateAssignmentApiKey / loadBuiltinSuggestions
- **AgentsView**：Tab 切换；switch workspace 时停留在当前 Tab
- **WorkspaceAgentsPanel**：standalone/main/sub 分组渲染；孤儿 sub 警告；移除 main 级联确认；调用 editors 正确
- **AgentLibrary**：三组分类；scope 徽标；操作按钮按 source 显示/隐藏
- **DefinitionEditor**：create vs edit vs configure builtin 三模式字段可见性；builtin configure 时 suggestedPlatform 预选
- **AddToWorkspaceDialog**：role='sub' 时 parent 显示；def.modelProviderId=NULL 时禁用提交；apiKeyOverride 可选
- **AssignmentRoleEditor**：循环引用时禁用提交；从 main 改非 main 时警告 subs 会被停止
- **AssignmentApiKeyEditor**：留空清 override；非空写入

## 10. 范围与非目标

### 10.1 包含

- agent_definitions 表的 workspace 隔离（scope 字段）
- 角色与父子关系从 def 剥离到 assignment
- 模型配置归属 def（provider + model name）
- Agent 库管理 UI（创建/编辑/配置/删除 def）
- Assignment 角色与 API key override 编辑 UI
- Builtin 加载策略改造（type/parent/platform 入内存建议）
- 迁移现有数据（强制重配 provider）

### 10.2 不包含（明确排除）

- **Builtin YAML 格式变更**：YAML 仍可写 type/parent/model.provider（向后兼容），只是不写入 DB
- **Marketplace 安装流程改造**：marketplace install 仍可用，但安装后的 builtin 一样遵循新模型
- **Multi-peer 协作场景**：本设计假定单用户；多用户共享 def 的语义留给 v2.0
- **Agent 定义版本化**：def 仍单版本；多版本支持留给未来
- **历史迁移工具**：用户从老版升级需重新配 provider，不提供自动迁移助手
- **AGENTS 库搜索**：库 Tab 的搜索功能仅基本文本过滤，不做高级索引

### 10.3 已知边界

- **孤儿 sub**：迁移可能产生 role='sub' 但 parent_instance_id=NULL 的 assignment；UI 显示警告，用户可补 parent 或改 role
- **Builtin 全局配置**：builtin 配置 provider 后全局生效（所有 workspace 共享）；如需 per-workspace 不同 provider，需用户复制 builtin 为自定义 def
- **删除 def 级联**：删除 def 时无法保留 assignment；用户必须先迁移到新 def 再删旧

## 11. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 迁移后用户全部 agent 不可用（强制重配 provider） | UI 在 AgentsView 顶部显示一次性提示「N 个 agent 需要配置供应商才能启动」+ 一键跳到 Agent 库；migration 完成后弹通知 |
| 迁移失败导致数据丢失 | 迁移前自动备份 SQLite DB（项目已有 backup 机制？需确认）；迁移用单 transaction，失败全部回滚 |
| 复杂对话框 UX 退化 | DefinitionEditor/AddToWorkspaceDialog/AssignmentRoleEditor 等组件设计已最小化字段；用 placeholder/默认值降低决策负担 |
| 删除 def 级联停止全部 assignment | confirm 弹窗清晰显示影响范围；返回 stoppedInstanceIds 让用户重启决策 |
| Runtime 子进程读不到 keychain | spawn-helpers 在主进程解析 apiKey 后通过 AGENT_CONFIG 注入子进程；子进程无需访问 keychain |
| Builtin 全局配置影响所有 workspace | 设计如此，已知边界；用户如需 per-ws 不同模型可复制 builtin 为 custom |

## 12. 验收标准

- [ ] 切换 workspace 后，Agent 库 Tab 只显示 global + 当前 ws scoped + builtin；其他 ws 的 scoped def 不可见
- [ ] 在 ws A 创建 workspace-scoped 自定义 agent，ws B 的 Tab 1「添加 agent」下拉不显示该 def
- [ ] Agent 库 Tab 可创建/编辑/删除 custom def；builtin 可配置 provider+model
- [ ] 创建 custom def 时必填 provider + modelName；保存后 def 立即可用
- [ ] Tab 1 添加 agent 时显式选 role；role='sub' 时 parent 必填且下拉只列当前 ws 的 main
- [ ] Tab 1 任何 assignment 都可改 role（弹 Editor），保存后该实例停止，提示用户重启
- [ ] Tab 1 任何 assignment 都可设/清 API key override；运行中实例提示需重启生效
- [ ] 删除 ws A 后，A 的 scoped custom def 一起删除；global custom def 不受影响
- [ ] 迁移后老 assignment 显示「def 未配置 provider」警告，配置 def 后自动可用
- [ ] 删除 custom def 时弹窗显示影响范围（哪些 ws 哪些实例会停止）
- [ ] 全套单元测试 + 集成测试 + 迁移测试通过；typecheck 干净
