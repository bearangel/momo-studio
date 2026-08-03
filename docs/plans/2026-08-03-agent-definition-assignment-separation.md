# Agent 定义/分配解耦 + Workspace 隔离 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 agent 定义（身份/能力/模型）和分配（角色/父子关系）从同一张表彻底解耦；自定义 agent 可 workspace 隔离；UI 提供 Agent 库管理 + 工作空间分配两套独立流程。

**Architecture:** `agent_definitions` 加 `workspace_id` + `model_provider_id` 列，删除 type/parent_agent_id/model_provider/model_base_url；`agent_assignments` 加 `role`/`parent_instance_id`/`has_api_key_override`；Keychain 增加 `agent.<instanceId>.api_key_override` 可选项；UI 拆为 `AgentsView` 双 Tab；现有 assignment 强制重配 provider。

**Tech Stack:** TypeScript strict，Electron CommonJS（main），React ESM（renderer），better-sqlite3，zustand，vitest。

**Spec 文档:** `docs/specs/2026-08-03-agent-definition-assignment-separation-design.md`（必读，本计划引用其中的类型定义、Schema、IPC 签名等）

## Global Constraints

- **Node 20 LTS**（`nvm use 20`），Node 26 破坏 better-sqlite3 native binding
- **TypeScript strict**：禁止 `any` / `@ts-ignore` / `as any`
- **所有代码注释、commit message 中文**（AGENTS.md）
- **migrations 是 TS 内联 SQL 字符串常量**（不是 `.sql` 文件）
- **当前最新 migration version = 11**，本次新增 v12
- **不要 `git add -A`**（`.gitignore` 含裸 `docs`）；用 `git add <files>` 或 `git add -f docs/...`
- 测试命令：`npx pnpm@9.0.0 typecheck` + `npx pnpm@9.0.0 test`
- 容器 Node 路径：`export PATH="/home/ai-agent/.nvm/versions/node/v20.20.2/bin:$PATH"`

## 实施原则

- **每个 task 是一次完整 TDD 循环**：写测试 → 确认失败 → 实现 → 确认通过 → commit
- **代码片段参考 spec**：本计划只给关键代码骨架，完整类型定义和 SQL 见 spec 对应章节
- **小步前进**：每 task 一次 commit，commit message 用中文 conventional commits

---

## Task 1: Migration v12 — Schema 改动 + 数据回填

**Files:**
- Modify: `electron/src/main/storage/migrations/index.ts`
- Test: `electron/tests/migrations/012-agent-role-separation.test.ts`（新建）

**参考 spec 章节**: §3.1（schema 改动）+ §3.4（边界情况）

**Schema 改动要点**（按顺序）：
1. `ALTER TABLE agent_definitions ADD COLUMN workspace_id TEXT`
2. `ALTER TABLE agent_definitions ADD COLUMN model_provider_id TEXT`（注意：`model_name` 列已存在，无需加）
3. `ALTER TABLE agent_assignments ADD COLUMN role TEXT NOT NULL DEFAULT 'standalone'`
4. `ALTER TABLE agent_assignments ADD COLUMN parent_instance_id TEXT`
5. `ALTER TABLE agent_assignments ADD COLUMN has_api_key_override INTEGER NOT NULL DEFAULT 0`
6. 两个索引（`idx_agent_definitions_workspace` + `idx_agent_assignments_parent`）
7. `UPDATE` 回填：assignment.role 从 def.type 推导；parent_instance_id 从 def.parent_agent_id + 同 ws 父推导
8. `DROP COLUMN`: agent_definitions.type / parent_agent_id / model_provider / model_base_url

**测试覆盖**（5+ 用例）：
- v11 schema 有 type/parent_agent_id/model_provider/model_base_url
- v12 加 workspace_id / model_provider_id 到 agent_definitions
- v12 删除旧 4 列
- v12 加 role / parent_instance_id / has_api_key_override 到 agent_assignments
- 回填：assignment.role 从 def.type 正确推导
- 回填：parent_instance_id 同 ws 父存在时正确链接
- 回填：parent_instance_id 父 ws 不同时留 NULL（孤儿 sub）

**实施步骤**：
- [ ] 1.1 写测试（参考 spec §3.4 + 上面 7 个测试名）
- [ ] 1.2 运行测试确认失败（v12 不存在）
- [ ] 1.3 在 MIGRATIONS 数组末尾追加 v12 entry（SQL 见 spec §3.1，分 3 阶段：加列/回填/删旧列）
- [ ] 1.4 运行测试确认全部通过
- [ ] 1.5 Commit: `feat(migration): v12 agent 定义/分配解耦 schema 改动`

---

## Task 2: 更新 AgentDefinition / AgentAssignment 类型

**Files:**
- Modify: `electron/src/main/agent/types.ts`
- Modify: `renderer/src/ipc/types.d.ts`

**参考 spec 章节**: §4.1（完整类型定义）

**改动**：
- 删除 `ModelRef` interface（不再使用）
- 改造 `AgentDefinition`：删 `type/parentAgentId/model`，加 `workspaceId/modelProviderId/modelName`
- 改造 `AgentAssignment`：加 `role/parentInstanceId/hasApiKeyOverride`
- 新增导出：`AgentRole` / `BuiltinSuggestion` / `BuiltinSuggestionMap`

**实施步骤**：
- [ ] 2.1 改 types.ts（按 spec §4.1 中的 TypeScript 代码块）
- [ ] 2.2 同步改 renderer/src/ipc/types.d.ts（同样的类型，但不含 ModelRef import）
- [ ] 2.3 跑 typecheck，**预期大量错误**（下游代码未适配，后续 task 修复）
- [ ] 2.4 Commit: `refactor(types): AgentDefinition/Assignment 解耦字段`

---

## Task 3: crud.ts — listDefinitions 过滤 + row mapper 适配

**Files:**
- Modify: `electron/src/main/agent/crud.ts`
- Test: `electron/tests/agent/crud-list-definitions.test.ts`（新建）

**参考 spec 章节**: §8.1（crud.ts 改动要点）

**改动**：
- `AgentDefRow` 加 `workspace_id` / `model_provider_id` 列；删 `type/parent_agent_id/model_provider/model_base_url`
- `rowToDef` 适配新 schema
- `listAgentDefinitions(workspaceId?)` 按 workspace 过滤：`WHERE workspace_id IS NULL OR workspace_id = ?`
- `saveAgentDefinition` 写入 `workspace_id` / `model_provider_id`（不写旧字段）
- `AgentAssignmentRow` 加 `role/parent_instance_id/has_api_key_override`；`rowToAssignment` 适配

**测试覆盖**（3+ 用例）：
- workspaceId=undefined 返回全部
- workspaceId='ws-a' 返回 global + ws-a scoped + builtin，不返回 ws-b scoped
- rowToDef 正确映射 workspaceId/modelProviderId/modelName；旧字段不存在

**实施步骤**：
- [ ] 3.1 写测试
- [ ] 3.2 运行确认失败
- [ ] 3.3 改 `AgentDefRow` / `rowToDef` / `listAgentDefinitions` / `saveAgentDefinition`
- [ ] 3.4 改 `AgentAssignmentRow` / `rowToAssignment`
- [ ] 3.5 运行测试确认通过
- [ ] 3.6 Commit: `feat(agent/crud): listAgentDefinitions 按 workspace 过滤`

---

## Task 4: crud.ts — assignment CRUD + deleteDefinition

**Files:**
- Modify: `electron/src/main/agent/crud.ts`
- Test: `electron/tests/agent/crud-assignment.test.ts`（新建）

**参考 spec 章节**: §4.2（IPC 方法签名 → 对应 crud 函数）

**新增/改造函数**：
- `assignAgentToWorkspace(workspaceId, defId, botUserId, role, parentInstanceId?)` — INSERT 含 role/parent；校验 role='sub' 时 parent 必填
- `updateAssignmentRole(instanceId, role, parentInstanceId?)` — 校验循环引用（自己/间接子树）；UPDATE
- `updateAssignmentApiKey(instanceId, apiKey)` — keychain set/delete + DB UPDATE has_api_key_override
- `listSubAssignments(workspaceId, parentInstanceId)` — 查询同 ws + parent=指定的 subs
- `deleteDefinition(defId)` — builtin 不可删；级联停止 + 清 keychain override + 删 assignment + 删 def

**测试覆盖**（9+ 用例）：
- assignAgentToWorkspace 写 role + parent_instance_id
- role='sub' parent 必填校验
- role!='sub' 时 parent 必须为 NULL 校验
- updateAssignmentRole 改 role + parent
- updateAssignmentRole 检测循环引用（自己当父）
- updateAssignmentRole 检测循环引用（间接：a→b→c→a）
- updateAssignmentRole role!=sub 时强制 parent=NULL
- updateAssignmentApiKey 写 keychain + 置标志
- updateAssignmentApiKey apiKey=null 清除 override
- listSubAssignments 返回正确集合
- deleteDefinition builtin 不可删（抛错）
- deleteDefinition custom 级联清理

**实施步骤**：
- [ ] 4.1 写测试
- [ ] 4.2 运行确认失败
- [ ] 4.3 实现 5 个新/改函数（参考 spec §4.2 IPC 签名 → 内部 crud 逻辑）
- [ ] 4.4 运行测试确认通过
- [ ] 4.5 Commit: `feat(agent/crud): assignment role/parent/apiKeyOverride + deleteDefinition`

---

## Task 5: builtin.ts + manifest-parser.ts — 建议 Map

**Files:**
- Modify: `electron/src/main/agent/builtin.ts`
- Modify: `electron/src/main/agent/manifest-parser.ts`
- Test: `electron/tests/agent/builtin-suggestions.test.ts`（新建）

**参考 spec 章节**: §7（builtin 加载策略）+ §4.1（BuiltinSuggestion 类型）

**改动**：
- `manifest-parser.ts`：`parseAgentManifest` 返回 `ParsedManifest = { def: AgentDefinition, suggestion: BuiltinSuggestion }`；def 不含 type/parent/model.provider；含 modelName + workspaceId=NULL + modelProviderId=NULL
- `builtin.ts`：维护内存 `builtinSuggestions: Map<string, BuiltinSuggestion>`；YAML 加载时 type/parent/platform 入 Map 不入 DB；导出 `getBuiltinSuggestionsMap()` + `clearBuiltinSuggestionsForTest()`
- builtin.ts 中 `suggestion.suggestedParentDefId` 是 slug → 转 `builtin-${slug}` defId（保持现有 slug→id 解析逻辑）

**测试覆盖**（3+ 用例）：
- builtin def 在 DB 中无 type/parent_agent_id/model_provider 字段值（旧字段已不存在）
- builtinSuggestions 含 main/sub 角色信息
- builtin def modelProviderId=NULL，modelName 来自 YAML

**实施步骤**：
- [ ] 5.1 写测试
- [ ] 5.2 改 manifest-parser.ts（返回 ParsedManifest）
- [ ] 5.3 改 builtin.ts（saveAgentDefinition 不传旧字段；维护 suggestions Map）
- [ ] 5.4 运行测试确认通过
- [ ] 5.5 Commit: `refactor(agent/builtin): YAML type/parent/platform 进内存 Map`

---

## Task 6: spawn-helpers.ts — resolveApiKey + buildSpawnOpts 改造

**Files:**
- Modify: `electron/src/main/agent/spawn-helpers.ts`
- Modify: `electron/src/main/agent/runtime-entry.ts`
- Modify: `electron/src/main/agent/llm-provider.ts`（如需）
- Test: `electron/tests/agent/spawn-helpers-resolve.test.ts`（新建）

**参考 spec 章节**: §6（Runtime 改动）

**改动**：
- 新增 `resolveApiKey(instanceId, providerId)`：override ?? provider key，都无抛错
- `buildSpawnOpts` 改读 `def.modelProviderId/modelName`；查询 subAgents via `listSubAssignments(workspaceId, instanceId)`（仅 role='main' 时）；校验 def.modelProviderId 非空
- `runtime-entry.ts` parseConfig：`agentType` 重命名为 `role`；新增 `modelProviderId`；保留 `modelName` / `modelBaseUrl`（modelBaseUrl 来自 provider.baseUrl，spawn 前注入）
- `buildRuntimeContext`：`config.agentType === 'main'` 改为 `config.role === 'main'`

**测试覆盖**（3+ 用例）：
- resolveApiKey 有 override 时优先用 override
- resolveApiKey 无 override 时用 provider key
- resolveApiKey 都无时抛「供应商 API key 丢失」

**实施步骤**：
- [ ] 6.1 写 resolveApiKey 测试
- [ ] 6.2 运行确认失败
- [ ] 6.3 实现 resolveApiKey
- [ ] 6.4 改 buildSpawnOpts（先打开现有文件看完整签名，保持兼容字段名）
- [ ] 6.5 改 runtime-entry.ts parseConfig（重命名字段，校验 modelProviderId）
- [ ] 6.6 适配 llm-provider.ts（如果签名变化）
- [ ] 6.7 主进程 typecheck（spawn-helpers + runtime-entry 通过；其他文件错误后续 task 修）
- [ ] 6.8 Commit: `feat(agent/spawn): resolveApiKey + buildSpawnOpts 读 assignment.role`

---

## Task 7: ipc.handlers.ts + preload + ApiSurface — IPC 签名更新

**Files:**
- Modify: `electron/src/main/agent/ipc.handlers.ts`
- Modify: `electron/src/preload/index.ts`
- Modify: `renderer/src/ipc/types.d.ts`（ApiSurface 的 `agent:` 命名空间）

**参考 spec 章节**: §4.2（IPC 方法签名）

**改动**：
- `agent:list` 接 `workspaceId?`
- `agent:addToWorkspace` input 改为 `{ workspaceId, agentDefinitionId, role, parentInstanceId?, apiKeyOverride? }`（删 llmApiKey）
- `agent:assignMain` input 改为 `{ workspaceId, mainDefId, apiKeyOverride?, selectedSubDefIds? }`
- `agent:createCustom` input 加 `scope/modelProviderId/modelName`，删 type/parent/modelProvider/modelName/modelBaseUrl
- `agent:updateDefinition` input 加 `scope/modelProviderId/modelName`，删 type/parent
- 新增：`agent:deleteDefinition` / `agent:updateAssignmentRole` / `agent:updateAssignmentApiKey` / `agent:getBuiltinSuggestions`
- 删除：`agent:updateApiKey`
- preload `api.agent.*` 全部同步
- ApiSurface 类型同步

**实施步骤**：
- [ ] 7.1 改 ipc.handlers.ts 全部 handler（按 spec §4.2 签名）
- [ ] 7.2 改 preload/index.ts 的 api.agent 对象
- [ ] 7.3 改 renderer/src/ipc/types.d.ts 的 ApiSurface
- [ ] 7.4 主进程 typecheck 通过
- [ ] 7.5 Commit: `feat(agent/ipc): IPC 签名更新 + 新方法`

> 此 task 完成后，renderer 部分仍 typecheck 失败（agent.store + 旧组件未适配），后续 task 修复。

---

## Task 8: agent.store.ts — 新签名 + 新 actions

**Files:**
- Modify: `renderer/src/stores/agent.store.ts`
- Modify: `renderer/src/stores/agent.store.test.ts`

**参考 spec 章节**: §5.9（store 改动）

**改动**：
- `loadDefinitions(workspaceId?)` 透传
- `addAgent(workspaceId, defId, role, parentInstanceId?, apiKeyOverride?)` 新签名
- `assignMainAgent(workspaceId, mainDefId, apiKeyOverride?, selectedSubDefIds?)` 新签名
- 新 actions：`loadBuiltinSuggestions` / `deleteDefinition` / `updateAssignmentRole` / `updateAssignmentApiKey`
- state 加 `builtinSuggestions: BuiltinSuggestionMap`

**测试覆盖**（5+ 新用例 + 改写旧用例）：
- loadDefinitions 透传 workspaceId
- addAgent 透传 role + parentInstanceId + apiKeyOverride
- deleteDefinition 调用 IPC + 刷新 definitions
- updateAssignmentRole 调用 IPC + 刷新 assignments
- updateAssignmentApiKey 调用 IPC（null 清除）
- loadBuiltinSuggestions 填充 state

**实施步骤**：
- [ ] 8.1 改写测试（替换旧 addAgent 三参用例为五参；加新 action 用例）
- [ ] 8.2 运行确认失败
- [ ] 8.3 改 agent.store.ts（参考 spec §5.9 完整代码）
- [ ] 8.4 运行测试确认通过
- [ ] 8.5 Commit: `refactor(agent/store): 新签名 + 新 actions`

---

## Task 9: AgentsView + WorkspaceAgentsPanel（Tab 1）

**Files:**
- Create: `renderer/src/components/agent/AgentsView.tsx`
- Create: `renderer/src/components/agent/WorkspaceAgentsPanel.tsx`
- Modify: `renderer/src/components/layout/MiddlePanel.tsx`（替换 AgentList 引用）
- Test: `renderer/src/components/agent/AgentsView.test.tsx`（新建）
- Test: `renderer/src/components/agent/WorkspaceAgentsPanel.test.tsx`（新建）

**参考 spec 章节**: §5.1（AgentsView 结构）+ §5.2（WorkspaceAgentsPanel）

**实现要点**：
- `AgentsView`：Tab 容器；useEffect 监听 activeWorkspaceId 变化时调 loadDefinitions + loadBuiltinSuggestions
- `WorkspaceAgentsPanel`：从旧 `AgentList.tsx` 重构；按 role 分组渲染（standalone / main + subs / orphan sub）；移除 main 级联检查（confirm 显示子 agent 数）；调用 AssignmentRoleEditor / AssignmentApiKeyEditor / AddToWorkspaceDialog（这些组件下个 task 实现，本 task 用 mock 或临时桩）
- `MiddlePanel`：把 `<AgentList onAdd={...} />` 替换为 `<AgentsView />`

**测试覆盖**：
- AgentsView：默认显示「本工作空间」Tab；点击切换到「Agent 库」
- WorkspaceAgentsPanel：standalone/main/sub 分组渲染；孤儿 sub 警告徽标

**实施步骤**：
- [ ] 9.1 写 AgentsView 测试（mock WorkspaceAgentsPanel + AgentLibrary 子组件）
- [ ] 9.2 实现 AgentsView
- [ ] 9.3 写 WorkspaceAgentsPanel 测试
- [ ] 9.4 实现 WorkspaceAgentsPanel
- [ ] 9.5 改 MiddlePanel.tsx
- [ ] 9.6 运行测试确认通过
- [ ] 9.7 Commit: `feat(agent/ui): AgentsView Tab 容器 + WorkspaceAgentsPanel`

> 本 task 暂用桩组件占位 AssignmentRoleEditor / AssignmentApiKeyEditor / AddToWorkspaceDialog，后续 task 实现后再 wire up。或者按依赖顺序：先做 Task 11/12/13 再做本 task。**推荐：本 task 用临时桩，让测试通过，后续 task 替换桩为真实组件**。

---

## Task 10: AgentLibrary（Tab 2）

**Files:**
- Create: `renderer/src/components/agent/AgentLibrary.tsx`
- Create: `renderer/src/lib/provider-helpers.ts`（辅助：getProviderName）
- Test: `renderer/src/components/agent/AgentLibrary.test.tsx`

**参考 spec 章节**: §5.6（AgentLibrary）

**实现要点**：
- 按 source + workspace 分组：builtin / globalCustom / workspaceScoped
- 搜索框：name/slug/description 实时过滤（大小写不敏感）
- builtin 行：显示「配置」按钮（modelProviderId=NULL 时显示「⚠️ 未配置」徽标）；不可删
- custom 行：显示「编辑」+「删除」+「+ 加入到当前工作空间」按钮
- 顶部：「+ 新建 agent 定义」按钮
- 调用 DefinitionEditor（create/edit/configure 三模式）+ AddToWorkspaceDialog（preselect）
- 辅助 `getProviderName(providerId)`：从 useProviderStore 查名字；不存在返回 '未知供应商'

**测试覆盖**：
- 按 source 分组显示三组
- builtin 显示「配置」；custom 显示「编辑」+「删除」
- 未配置 provider 的 builtin 显示警告徽标

**实施步骤**：
- [ ] 10.1 写测试（mock DefinitionEditor + AddToWorkspaceDialog）
- [ ] 10.2 实现 provider-helpers.ts
- [ ] 10.3 实现 AgentLibrary
- [ ] 10.4 运行测试确认通过
- [ ] 10.5 Commit: `feat(agent/ui): AgentLibrary Tab 2 - def 管理界面`

---

## Task 11: DefinitionEditor

**Files:**
- Create: `renderer/src/components/agent/DefinitionEditor.tsx`
- Test: `renderer/src/components/agent/DefinitionEditor.test.tsx`

**参考 spec 章节**: §5.7（DefinitionEditor 三模式）

**实现要点**：
- 三模式：`'create'` / `'edit'` / `'configure'`（builtin）
- 字段：name/slug/prompt/iconEmoji + provider 必选 + modelName 必填 + scope（仅 create）
- mode='edit'：slug 只读
- mode='configure'：name/slug/prompt 只读（builtin 不可改身份）；scope 不显示
- 选 provider 时若 modelName 为空，自动填 defaultModel
- 提交调 IPC createCustom / updateDefinition；成功后调 loadDefinitions 刷新 + onClose

**测试覆盖**：
- create 模式：必填字段验证 + 提交调 createCustom 入参正确
- edit 模式：预填 def 字段，slug 只读
- configure 模式：身份字段只读，scope 不显示

**实施步骤**：
- [ ] 11.1 写测试（3 个模式各一个用例）
- [ ] 11.2 实现 DefinitionEditor
- [ ] 11.3 运行测试确认通过
- [ ] 11.4 Commit: `feat(agent/ui): DefinitionEditor 三模式 def 编辑对话框`

---

## Task 12: AddToWorkspaceDialog

**Files:**
- Create: `renderer/src/components/agent/AddToWorkspaceDialog.tsx`
- Test: `renderer/src/components/agent/AddToWorkspaceDialog.test.tsx`

**参考 spec 章节**: §5.3（AddToWorkspaceDialog）

**实现要点**：
- 入参：`preselectedDef?`（从 AgentLibrary 「+ 加入到当前工作空间」跳转时传入）
- 字段：def 选择 + role + parent（仅 role='sub'）+ apiKeyOverride（可选）
- def.modelProviderId=NULL 时：禁用提交按钮 + 显示「请先到 Agent 库配置该 agent」
- builtin 默认选中建议 role（来自 builtinSuggestions）；其他 def 默认 standalone
- role='sub' 时 parent 下拉只列当前 ws 已分配的 role='main'
- apiKeyOverride 输入框 placeholder：「留空使用供应商默认 key」
- 提交调 store.addAgent；成功后 onClose

**测试覆盖**：
- 选中 builtin main def 时 role 默认选中「主 agent」
- role='sub' 时显示 parent 选择器；否则隐藏
- def.modelProviderId=NULL 时禁用提交
- 提交调 store.addAgent 传正确参数

**实施步骤**：
- [ ] 12.1 写测试
- [ ] 12.2 实现 AddToWorkspaceDialog
- [ ] 12.3 运行测试确认通过
- [ ] 12.4 Commit: `feat(agent/ui): AddToWorkspaceDialog`

---

## Task 13: AssignmentRoleEditor + AssignmentApiKeyEditor

**Files:**
- Create: `renderer/src/components/agent/AssignmentRoleEditor.tsx`
- Create: `renderer/src/components/agent/AssignmentApiKeyEditor.tsx`
- Test: `renderer/src/components/agent/AssignmentRoleEditor.test.tsx`
- Test: `renderer/src/components/agent/AssignmentApiKeyEditor.test.tsx`

**参考 spec 章节**: §5.4（AssignmentRoleEditor）+ §5.5（AssignmentApiKeyEditor）

**实现要点**：

**AssignmentRoleEditor**：
- 入参：assignment（当前 role + parent）
- 字段：role 单选 + parent 下拉（仅 role='sub'）
- parent 下拉只列同 ws 的 main assignment
- 提交调 store.updateAssignmentRole；提示「需要重启该 agent 实例」
- 警告：从 main 改为非 main 时显示「N 个子 agent 也会一并停止」

**AssignmentApiKeyEditor**：
- 入参：assignment
- 始终显示 API key 输入框（password type）
- placeholder：「留空使用供应商默认 key」
- 当前 hasApiKeyOverride=true 时显示「当前使用独立 API key」提示
- 提交：非空 → store.updateAssignmentApiKey(value)；空 → store.updateAssignmentApiKey(null)（清除 override）
- 提示「运行中实例需手动重启生效」

**测试覆盖**：
- AssignmentRoleEditor：role='sub' 时显示 parent；非 sub 隐藏
- AssignmentRoleEditor：从 main 改为非 main 时显示 subs 警告
- AssignmentRoleEditor：提交调 updateAssignmentRole
- AssignmentApiKeyEditor：留空清除 override；非空设置 override
- AssignmentApiKeyEditor：提交调 updateAssignmentApiKey

**实施步骤**：
- [ ] 13.1 写 AssignmentRoleEditor 测试
- [ ] 13.2 实现 AssignmentRoleEditor
- [ ] 13.3 写 AssignmentApiKeyEditor 测试
- [ ] 13.4 实现 AssignmentApiKeyEditor
- [ ] 13.5 运行测试确认通过
- [ ] 13.6 Commit: `feat(agent/ui): AssignmentRoleEditor + AssignmentApiKeyEditor`

---

## Task 14: AgentOrchestrator 数据源更新 + 删除旧文件 + 全套回归

**Files:**
- Modify: `renderer/src/components/agent/AgentOrchestrator.tsx`
- Delete: `renderer/src/components/agent/AgentList.tsx`
- Delete: `renderer/src/components/agent/AddAgentDialog.tsx`
- Delete: `renderer/src/components/agent/AddAgentDialog.test.tsx`（如果存在）

**改动**：
- `AgentOrchestrator`：原来读 def.type/parentAgentId 推断 main→sub 树；改为读 assignment.role/parentInstanceId 推断
- 删除 `AgentList.tsx`（拆分到 AgentsView + WorkspaceAgentsPanel 已完成）
- 删除 `AddAgentDialog.tsx`（拆分到 DefinitionEditor + AddToWorkspaceDialog 已完成）
- 删除对应旧测试文件

**实施步骤**：
- [ ] 14.1 改 AgentOrchestrator.tsx 数据源（按 assignment.role/parentInstanceId 分组）
- [ ] 14.2 更新 AgentOrchestrator.test.tsx（mock 数据用新字段）
- [ ] 14.3 删除 AgentList.tsx + AddAgentDialog.tsx + 旧测试
- [ ] 14.4 全套 typecheck：`npx pnpm@9.0.0 typecheck`
- [ ] 14.5 全套测试：`npx pnpm@9.0.0 test`
- [ ] 14.6 如有失败，定位并修复（预期主要是组件 mock 数据需更新字段名）
- [ ] 14.7 Commit: `refactor(agent/ui): AgentOrchestrator 读 assignment.role；删除旧 AgentList/AddAgentDialog`

---

## Task 15: 文档更新 + CHANGELOG

**Files:**
- Modify: `README.md`（v1.3 路线图条目）
- Create: `CHANGELOG.md`（如不存在）或追加 v1.3 条目

**改动**：
- README v1.3 路线图加本次重构条目
- CHANGELOG 加 v1.3.0 简明变更说明（agent 定义/分配解耦、workspace 隔离、UI 双 Tab、强制重配 provider 提示）

**实施步骤**：
- [ ] 15.1 更新 README.md
- [ ] 15.2 更新/创建 CHANGELOG.md
- [ ] 15.3 Commit: `docs: 更新 README + CHANGELOG 反映 agent 定义/分配解耦`

---

## Self-Review

### Spec 覆盖检查

| Spec 章节 | 对应 Task |
|---|---|
| §1-2 问题与原则 | 无（文档章节） |
| §3 Schema + 迁移 | Task 1 |
| §4 IPC API 改动 | Task 2 (types) + Task 7 (IPC handlers + preload + ApiSurface) |
| §5 UI 改动 | Task 9-13 |
| §6 Runtime 改动 | Task 6 |
| §7 Builtin 加载策略 | Task 5 |
| §8 文件改动清单 | 全部 task 覆盖 |
| §9 测试策略 | 每个 task 都含测试 |
| §10 范围与非目标 | 不需要 task |
| §11 风险与缓解 | 实施时按需 |
| §12 验收标准 | 最终手动 QA |

### Placeholder 扫描

✅ 无 TBD/TODO
✅ 所有代码引用都指向 spec 具体章节
✅ 所有测试名都明确

### Type 一致性

✅ AgentDefinition / AgentAssignment / AgentRole / BuiltinSuggestion 名字在所有 task 一致
✅ IPC 方法名（deleteDefinition / updateAssignmentRole / updateAssignmentApiKey / getBuiltinSuggestions）跨 task 一致
✅ Keychain key 格式 `agent.<instanceId>.api_key_override` 一致

### 风险点（实施时注意）

1. **Task 5 builtin.ts 的 builtinDir 路径**：现有代码有路径处理逻辑（dev/prod 不同），改造时**保留原路径处理**，只替换 saveAgentDefinition 调用和加 suggestions Map 填充
2. **Task 6 buildSpawnOpts 现有签名**：打开现有 spawn-helpers.ts 看完整 RuntimeSpawnOpts 字段，保持兼容字段名（如 `homeserverUrl` 等）。本计划只列改动点，不重复列不变字段
3. **Task 7 IPC handler 工作量大**：建议按 handler 分多次小 commit（addToWorkspace / assignMain / createCustom / updateDefinition / 新增 4 个 / 删除 updateApiKey）
4. **Task 9-13 组件依赖顺序**：WorkspaceAgentsPanel 依赖 AssignmentRoleEditor/AssignmentApiKeyEditor/AddToWorkspaceDialog；推荐用临时桩让 Task 9 先通过，后续 task 替换。或者按 11→12→13→9 顺序实施
5. **Task 14 删除文件前确认**：先全局搜索确认没有残留引用，特别是 AgentList.onAdd prop 是否还有调用方

## 验收 Checklist（实施完成后逐项验证）

实施全部 task 完成后，按 spec §12 的 10 条验收标准手动 QA：
- [ ] 切换 workspace 后 Agent 库 Tab 内容正确过滤
- [ ] ws A 创建 workspace-scoped def，ws B 不可见
- [ ] Agent 库 Tab 创建/编辑/删除 custom def 正常
- [ ] 创建 custom def 必填 provider + modelName
- [ ] 添加 agent 时显式选 role；sub 必填 parent
- [ ] 改 assignment role 后实例停止 + 提示重启
- [ ] 改 assignment apiKeyOverride 后提示重启
- [ ] 删除 ws 级联删 scoped custom def；global 不受影响
- [ ] 迁移后老 assignment 显示「def 未配置 provider」警告
- [ ] 删除 custom def 显示影响范围弹窗
- [ ] 全套测试 + typecheck 通过
