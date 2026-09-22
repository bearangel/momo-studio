# 资源库预设 agent 启用与 LLM 配置设计

- 日期：2026-09-22
- 状态：已审定（用户逐节确认）
- 范围：资源库「系统预置」agent 的启用链路 + 预设 / marketplace agent 的 LLM 配置能力 + 会话加载闭环
- 关联：`docs/specs/2026-08-31-agent-team-session-redesign.md`（agent 域现行设计）、`docs/specs/2026-08-23-v2.0.0-platform-refactor-design.md`（v2 架构）

## 1. 背景与根因

用户报告两个缺陷：资源库预设 agent ①无法设置 LLM；②无法在 Agent 会话中加载。

代码层根因链（均有源码依据）：

1. **预设 agent 的定义从未进入 `agent_definitions` 表**：
   - `electron/src/main/agent/builtin.ts` 的 `registerBuiltinAgents()` 自 v1.1 起启动流程不再调用（注释明示「内置 agent 改为通过 marketplace 按需安装」），但该替代路径对 builtin 项未打通——`resource/catalog-adapter.ts` 的 `fromCatalogItem` 中 `installable: source === 'marketplace' && !installed`，builtin 恒 false；
   - `ResourceDetail.tsx` 对 builtin 项只渲染「已安装」静态标记（误导：实际 def 不在库），无任何安装 / 配置入口；
   - 会话成员 ← `workspace_agent_members` ← `agent_definitions`，def 缺失 → `AddAgentDialog` 列不出 → 无法加入工作空间 → 快速 / 协作会话均不可选。
2. **LLM 配置被锁死**：
   - `DefinitionEditor.tsx` 中 `mode === 'configure'` 时 `readOnly = true`，`ProviderModelPicker` 被 disabled，且该 configure 模式当前无 UI 入口；
   - 即便 def 存在（如经 marketplace 安装），`modelProviderId = NULL` 时 spawn 直接拒绝（`spawn-helpers.ts`：`agent 定义「xxx」未配置 modelProviderId`）；`agent:addMember` IPC 同样有该守卫；
   - 现成可用能力：`MemberEditDialog` 的模型区可写、`updateAgentDefinition` 后端不限制 source——缺的只是前置链路。

## 2. 目标 / 非目标

**目标**：
1. 资源库预设 agent 可「按需启用」：一键完成 def 入库 + LLM 配置 +（可选）加入当前工作空间；
2. 启用后即可在快速 / 协作会话中选用该 agent（会话加载闭环）；
3. marketplace（网络资源）安装的 agent 同批获得 LLM 配置引导与常驻配置入口。

**非目标**：
- 不改预设 agent 的名称 / 系统提示词 / 默认能力的可编辑性（保持只读，成员级 override 走既有 Layer 3）；
- 不改 `resource:install` 的返回契约；
- 不恢复启动时全量 `registerBuiltinAgents()` 落库（保持按需语义）；
- 不动 P2P 资源导入链路。

## 3. 已裁定决策

| # | 决策点 | 裁定 |
|---|---|---|
| D1 | 预设 agent 入库方式 | **按需启用**：资源库详情加「启用」按钮，按需写入定义表；不用的预设不进列表 |
| D2 | LLM 配置交互 | **启用即配**：点「启用」弹轻量表单，保存 = def 入库 + 模型写入一步完成；全局默认模型预填 |
| D3 | 会话闭环 | **顺带加入 ws**：启用表单带「加入当前工作空间」checkbox（默认勾）+ 可选「设为默认会话 agent」 |
| D4 | 修复范围 | **builtin + marketplace 同修**（两者同病：def 落库后 `modelProviderId=NULL` 且无配置入口） |
| D5 | 实现架构 | **方案 B：单一后端编排 IPC `agent:enablePreset`**（否决前端多步编排——有半启用态风险；否决折中拆分——交互多一步） |

## 4. 交互流设计

资源库 → 「系统预置」tab → agent 详情面板按钮三态：

| 状态 | 显示 | 动作 |
|---|---|---|
| 未启用（`agentEnabled=false`） | 「启用」按钮 | 弹「启用预设 Agent」表单 |
| 已启用（`agentEnabled=true`） | 「配置」按钮 + 「已启用」标记 | 弹同一表单（编辑模式） |

**启用表单**（新组件 `renderer/src/components/agent/EnablePresetDialog.tsx`，复用 `ProviderModelPicker` + `ThinkingOverrideControl`）：

- 模型区：预填全局默认模型（settings 的 `defaultChatModel`）；无则空；必填校验在前端源头拦截；
- 平台预选：`builtinSuggestions[defId].suggestedPlatform` 用于 provider 下拉预选匹配项（providers 按 `presetKey → platform` 匹配；无匹配不预选）；
- checkbox「加入当前工作空间」：默认勾选；无激活 workspace 时禁用并提示；
- checkbox「设为默认会话 agent」：默认不勾；仅上一项勾选时渲染；
- 两个 checkbox 仅在**启用模式**（`agentEnabled=false` 首次启用）渲染；**编辑模式**（「配置」按钮）仅模型 / 思维区。启用时未勾选加入的，后续经 Agent 管理 → 添加 Agent（`AddAgentDialog` 既有能力）加入——配置弹窗不重复承担加入职责；
- 保存（启用模式）→ `agent:enablePreset` → 刷新资源库（`resource.store.load`）+ agent store（`loadDefinitions` / `loadMembers`）→ 关闭表单。

**配置（编辑模式）**：仅模型 / 思维可改，保存走现有 `agent:updateDefinition`（只传 `id/modelProviderId/modelName/thinkingJson`，与 `MemberEditDialog` 模型区同模式）。运行中的成员模型变更提示重启——沿用 `MemberEditDialog` 的 `pendingRestart` 模式（启用表单编辑模式下同样处理）。

## 5. `agent:enablePreset` IPC 契约

```ts
interface EnablePresetInput {
  /** 预设 agent slug（须过 marketplace/types 的 isValidSlug 白名单，防路径穿越） */
  slug: string;
  modelProviderId: string;   // 必填
  modelName: string;         // 必填
  thinkingJson?: ThinkingConfig | null;
  /** 传入则加入该 workspace 并启动 runtime */
  joinWorkspaceId?: string;
  /** 仅 joinWorkspaceId 存在时有效 */
  setAsDefault?: boolean;
}

// 返回
interface EnablePresetResult {
  def: AgentDefinition;
  member: WorkspaceAgentMember | null;  // 未加入时 null
}
```

实现要点（新模块 `electron/src/main/agent/preset.ts`）：

1. **解析**：`resolveBuiltinAgentsDir()` 读 `<slug>.yaml`；slug 先过 `isValidSlug`（拒绝 `..` / 分隔符等）；文件缺失抛明确错误。
2. **落库**：`parseAgentManifestWithSuggestion` 解析 → def 定型：`id = 'builtin-<slug>'`（确定性 id，幂等重启用不换 id）、`source='builtin'`、`modelProviderId/modelName/thinkingJson` 以入参覆盖 → `saveAgentDefinition`（INSERT OR REPLACE）。
3. **suggestions**：填充该条 `builtinSuggestions`；另在启动流程加轻量函数 `loadBuiltinSuggestionsOnly()`——只解析 YAML 填内存 Map、**不落库**，保证 `agent:getBuiltinSuggestions` IPC 开箱有数据（平台预选可用）。
4. **供应商校验**：`getProvider(modelProviderId)` 不存在 → 抛错（ghost provider 源头拒绝）。
5. **形状校验**：`thinkingJson != null` 时走 `assertThinkingConfigShape`（现有函数）。
6. **加入工作空间**：`joinWorkspaceId` 存在时复用 `agent:addMember` 的内部链路（`generateAgentUserId(def.slug)` + `addMember` + `resolveApiKey` + `buildSpawnOpts` + `startAgentRuntime`）——**启用即上线**，与既有成员加入语义一致；模型已在步骤 2 写入，`modelProviderId` 守卫天然通过。
7. **幂等加入**：`addMember` 命中 UNIQUE（同 ws 同 def 已存在）→ 查询现有 member 返回，不视为错误。
8. **设默认**：`setAsDefault` → 复用 workspace 域 setDefaultAgent 内部函数；失败不回滚启用（def 已落库），错误上抛。

IPC 注册位置：`electron/src/main/agent/ipc.handlers.ts`（与既有 `agent:` 通道同处）；preload 暴露 + `renderer/src/ipc/types.d.ts` 类型同步（两端 typecheck）。

## 6. 数据契约：启用状态标志

`ResourceItem.builtin` namespace 新增：

```ts
builtin?: {
  category?: string;
  tags?: string[];
  /** 仅 type='agent'：该预设已启用（agent_definitions 存在同 slug def）。v2.1 启用链路 */
  agentEnabled?: boolean;
};
```

- 计算位置：`catalog-adapter.fromCatalogItem`——`listAgentDefinitions()` 按 slug 匹配即 `true`（与 marketplace install 的 slug 复用逻辑同口径，不分 source：marketplace 装过同名项同样视为已启用）。该字段仅对 builtin 项有意义（marketplace 项不挂 `builtin` namespace）；
- marketplace 项不新增字段：详情面板对 `installed && type === 'agent' && source === 'marketplace'` 直接显示「配置」按钮（安装成功即 def 已落库，无需启用态判定）；
- 两端类型同步：`electron/src/main/resource/types.ts` + `renderer/src/ipc/types.d.ts`；
- `installed / installable / removable` 三态语义不变。

## 7. marketplace 同修

`resource:install`（网络资源 agent）成功后，renderer 编排：

1. `loadDefinitions()` → 按 slug 找到落库 def；
2. 弹 `EnablePresetDialog`（编辑模式，标题「配置 Agent」）；
3. 保存 → `updateDefinition` 写模型；
4. 用户直接关闭表单 → def 保持 `modelProviderId=NULL`（半配置态）：详情面板「配置」按钮常驻可再配；若已加入 ws，`MemberEditDialog` 亦可配。

不改 `resource:install` 返回契约（避免 p2p / marketplace 两分支的返回形状分歧）。

## 8. 错误处理与边界

| 场景 | 行为 |
|---|---|
| YAML 缺失 / 解析失败 | `enablePreset` 抛明确错误；表单 error 区展示，不落库 |
| slug 路径穿越（`isValidSlug` 不过） | 源头拒绝 |
| 供应商行已被删（ghost provider） | `getProvider` 校验，源头拒绝 |
| `thinkingJson` 坏形状 | `assertThinkingConfigShape` 拒绝 |
| 模型未选 / 未填 | 前端表单源头拦截，不发 IPC |
| 重复启用（幂等） | 确定性 id，INSERT OR REPLACE 覆盖；modelProviderId 以最新入参为准 |
| 重复加入 ws（UNIQUE 竞态） | 幂等：返回已有 member |
| `setAsDefault` 失败 | 启用不回滚，错误上抛表单提示重试 |
| 无激活 workspace | 「加入」checkbox 禁用，仅落库全局定义 |
| 用户取消 marketplace 配置引导 | 半配置态可见可修（「配置」按钮），不阻塞 |
| runtime 启动失败（key 缺失等） | def 与 member 已落库，错误上抛；agent 离线态可从 Agent 管理再启动（既有能力） |

## 9. 测试策略

按 momo-test-rules 保真度要求（真实 SQLite、mock 仅隔离外部边界）：

- **electron 单测**（`electron/tests/agent/preset.test.ts`）：
  - 幂等：重复启用 id 不变、字段覆盖正确；
  - 确定性 id / `source='builtin'` / 模型字段写入；
  - join + setAsDefault 链路（runtime 启动 mock 隔离，DB 断言 `workspace_agent_members` / `workspaces.default_agent_instance_id`）；
  - slug 路径穿越拒绝、YAML 缺失报错、坏 thinkingJson 拒绝、ghost provider 拒绝；
  - 重复加入幂等（返回既有 member）。
- **catalog-adapter 单测**：`agentEnabled` 计算（def 存在 / 不存在 / 同 slug 异 source）。
- **renderer 单测**：
  - `ResourceDetail` 按钮态（builtin 未启用 / 已启用 / marketplace installed）；
  - `EnablePresetDialog` 必填校验、默认模型预填、checkbox 联动、保存调用正确 IPC；
  - marketplace install 后配置引导触发（store 测试）。
- **回归**：`ResourceLibraryView.test.tsx` / `ResourceDetail.test.tsx` 适配「已安装」静态标记 → 状态驱动按钮。

## 10. 验收标准

1. 资源库「系统预置」任一 agent：点「启用」→ 选模型 → 勾选加入 → 立即可新建协作会话选中它 / 设为默认后快速会话直达；
2. 启用后 spawn 不再报「未配置 modelProviderId」；
3. 已启用预设的「配置」按钮可改模型 / 思维，运行中成员提示重启；
4. 「网络资源」安装 agent 后自动弹配置引导，关闭后可从详情面板「配置」再配；
5. 重启应用后启用状态与配置持久（DB 为准）；
6. `pnpm typecheck` + 两 workspace 全量单测通过。
