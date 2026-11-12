# 会话内 agent 能力管理工具设计（update 工具族 + 用户确认通道）

- 日期：2026-11-12
- 状态：待用户审阅
- 上游：`docs/specs/2026-11-09-resource-creation-skills-design.md`（资源创建六工具；其 §12 预告「update/delete 工具视用户反馈二期评估」——本设计即该二期，用户反馈已出现）
- 用户裁定链（设计期逐条确认，实现不得偏离）：
  1. 确认纪律 = **B 分级**：扩权类写操作必须用户显式确认；减权/纯元数据复述即可
  2. 能力工具**必带 `scope` 参数**，语义缺省 L3（member），仅用户明确要求改定义才传 `definition`
  3. **本版不提供任何删除操作**（agent 定义 / skill / MCP / 移除成员全部 UI-only，agent 拒答引导）
  4. 写面 = **C 全量**：L3 加+减、L1 改定义、`update_skill`、`update_mcp`
  5. 默认授予 = **Momo（general-assistant）迁移回填**；`defaultOn` 保持 false
  6. 结构 = **方案一**：细粒度 5 工具 + 确认门在主进程桥内
  7. 重启 = **restart 参数**（缺省 auto），目标≠自身立即 stop+拉起（= UI 立即重启），自身走 respawn-on-idle；**不做真热更**

## 1. 背景与目标

现状：会话内资源工具只有创建语义（`resource_list / create_agent / add_agent_member / create_skill / create_mcp / create_team / list_models` 七 op 白名单，`resource-ops.ts:24`）。已装 skill / 已注册 MCP 是「未绑定归属的半成品」——agent 装得上、挂不上；对已加入工作空间的成员，agent 无任何修改通道（`agent:updateDefinition` / `agent:setMemberDeltas` / `allocation:*` 全部 renderer-only）；读面也缺——`resource_list` agents 段看不到任何能力面。

目标：把「只能创建」补成「能管理既有」：

1. **成员级（L3）**：给某成员加/减 skill、MCP、builtin 工具、插件工具
2. **定义级（L1）**：改 agent 定义的 `default*` / model / prompt / `deniedTools`（全局影响）
3. **资源级**：覆盖更新已装 skill、更新已注册 MCP 配置
4. **读面**：查单个 agent 的定义 + 生效能力 + 三层归因 + 跨工作空间提示
5. **生效闭环**：改完自动重启（同 UI 立即重启语义），下一轮/下一个会话生效

## 2. 非目标

- **不做任何 delete op**：删除 skill / MCP / agent 定义、停用预设、移除工作空间成员——全部 UI-only。agent 收到删除类请求必须友好拒答引导（§10），桥面白名单架构性不存在 delete 入口
- **不做真热更**：工具注册中心在 child 启动时构建一次、每轮复用（`runtime-entry.ts:131/:523/:543`），热更需三处动态化 + 处理在飞调用与 WarmPool 失效，投入产出比低。演进位：若二期需要，形态 = child `capabilities-changed` 消息 → 下轮重建工具目录
- **不动既有 6 个 create op 行为**：确认门只覆盖本设计新增写 op；create 侧维持「复述 + 直接落库」
- **不做**「本次会话不再询问」记忆授权、拒绝时自由文本带话、多阶段草稿确认
- **不做通用确认框架**：本通道仅服务 resource-ops 写 op，不向插件/其他工具面开放

## 3. 方案比选结论（过程记录）

| 维度 | 选定：细粒度 5 工具 + 桥内确认 | 单入口 `manage_resource(action)` | 子进程侧确认（write-grant 复刻） |
|---|---|---|---|
| LLM 填参准确率 | 高（schema 各自收敛） | 低（大一统互斥分支） | 高 |
| 权限分级 | 按工具/op 分档 | 不可 | 按工具分档 |
| 绕过风险 | 低（主进程单点，子进程无法绕） | 低 | 中（每个工具都要接等待逻辑） |
| 仓库范式一致性 | 高（`git_*` / `browser_*` 一动作一工具） | 低 | 中 |

确认门放主进程桥（`handleResourceOpMessage` 内、`executeResourceOp` 前）是关键裁定：确认与审计单点收敛，子进程只发意图。

## 4. 现状复用点（探索钉死的事实锚，行号为 2026-11-12 当前）

| 事实 | 锚点 | 消费 |
|---|---|---|
| op 白名单 + 桥（id 配对 / 30s 超时 / 回写通道关闭防御） | `resource-ops.ts:24`、`resource-ops-bridge.ts:11` | 扩面 7→12 op；确认类 op 单独放宽等待预算 |
| 成员级能力 delta 持久化（add/remove 双向、全量替换、事务） | `assignment-capabilities.ts:75` `setAssignmentDeltas` | `updateCapabilities` member 分支直接复用 |
| 定义级更新（undefined=不改/传值=覆盖） | `crud.ts:498` `updateAgentDefinition` | `updateCapabilities` definition 分支 + `updateProfile` |
| 定义更新停机链 | `agent/ipc.handlers.ts:241` `stopRunningInstancesByDefinition` | definition 分支复用（与 UI 同款） |
| 能力快照在 spawn 定型（三层合并 → allowedTools） | `spawn-helpers.ts:413` | 重启语义的根因（§8） |
| WarmPool spawn 闭包捕获注册时 opts → 池内新 child 全用旧快照 | `runtime-registry.ts:136` | 改能力必须 stop（销毁池）+ 拉起（重建池） |
| 重启原语：`stopAgentRuntime` + `ensureMemberRuntime`（幂等，内部现算 buildSpawnOpts） | `start-chain.ts:33` | restart=auto 的执行体（= UI 立即重启） |
| 回合归零边沿回调 | `agent-runner.ts:255` `onIdle` | respawn-on-idle 的触发点 |
| 调用者身份（agentInstanceId）可从 spawn 上下文注入 | `agent/types.ts:49`（ToolContext.agentInstanceId） | 自改检测（target == self） |
| 后台链信号 | `runtime-config.ts:191` `parentStreamSessionId` | 确认 fail-closed 判定 |
| skill 表单创建 = 全量替换（清目录重写 + `.sha256` 重算） | `skill/form-create.ts:27` | `updateSkill` 同语义 |
| MCP 全字段编辑（保 id/source/installed_at，内部池驱逐） | `resource/mcp-config.ts` `updateMcpEntry` | `updateMcp` 复用 |
| MCP 先测后落库 + OAuth 401/403 例外 | `resource-ops.ts` `opCreateMcp`（R14） | `updateMcp` 沿用 |
| 已知工具名判定域 | `known-tool-names.ts` `collectKnownToolNames` | ref 校验 |
| renderer delta 计算 | `renderer/src/lib/capability-helpers.ts` `computeDeltas` | 同源铁律契约锁（§6.4） |
| Momo 工具集迁移先例（整列替换 + 冻结名单测试） | `migrations/077/078` | migration 079 同式 |
| **无通用「运行时→用户确认」通道**（仅 write-grant 专用轮询） | 全局探明 | 本设计新增 §7 |

## 5. 工具面设计（5 工具，全部落 `tools/resource-tools.ts`）

命名域沿 `resource_` / `create_` 既有风格；目录分类「资源管理」、`defaultOn: false`（不进 Tier 1 公共默认集，不污染新建 agent 默认勾选）。

### 5.1 `describe_agent`（只读，免确认，op: `describeAgent`）

```
入参: { agent: string }               // instanceId 或 slug（同 ws 内 slug 唯一，v25 约束）
出参: {
  definition: { id, slug, name, source, modelProviderId, modelName,
                defaultTools, defaultMcps, defaultSkills, deniedTools },
  member:    { instanceId, running },
  effective: { tools, mcps, skills },          // 三层合并生效集（getEffectiveCapabilities 同源）
  attribution: { fromDefinition, fromWorkspace, memberAdded, memberRemoved },
  otherWorkspaceMembers: number                // 跨 ws 提示数据源
}
```

### 5.2 `update_agent_capabilities`（op: `updateCapabilities`）

```
入参: {
  agent: string,                             // instanceId 或 slug
  scope?: 'member' | 'definition',           // 缺省 member；仅用户明确要求改定义本身/全局生效时传 definition
  add?:    { skills?: string[], mcps?: string[], tools?: string[], pluginTools?: string[] },
  remove?: { skills?: string[], mcps?: string[], tools?: string[], pluginTools?: string[] },
  restart?: 'auto' | 'deferred',             // 缺省 auto（§8）
}
出参: { appliedTo, changed: {adds, removes}, effective, restarted?, needsRestart?,
        effectiveFrom?: 'next-turn', otherWorkspaceMembers, stoppedInstances? }
```

- **增量语义（两个 scope 一致）**：终态 = (现状 ∪ add) − remove；同 ref 同现 add+remove → remove 胜（与 `mergeCapabilities` 保守语义对齐）
- member 分支：读旧 deltas → 计算新 deltas（§6.4 纯函数）→ `setAssignmentDeltas` 全量替换；不改定义
- definition 分支：`def.default*` 增量后经 `updateAgentDefinition` 落库 → `stopRunningInstancesByDefinition`；返回 `stoppedInstances`；**builtin 定义拒绝**（见 §11）
- **ref 校验 fail-fast**：tool ∈ `collectKnownToolNames(workspaceId)`、skill ∈ `listInstalled`、mcp ∈ `listRegistered`、pluginTool ∈ 插件装配面；非法 ref **逐条全量报出**（不是只报第一个），零落库
- `add` 与 `remove` 至少其一；空请求报错
- **`restart` 参数仅 member 分支生效**：definition 分支恒 stop-only（§8），传了也忽略并在返回中说明

### 5.3 `update_agent_profile`（恒确认，op: `updateProfile`）

```
入参: { agent: string,                       // instanceId / slug / definitionId（解析到定义）
        name?, description?, systemPrompt?, iconEmoji?,
        model?: { providerId: string, modelName: string },   // = list_models 的 providerId/modelId
        deniedTools?: string[] }              // 整列覆盖（工具禁用模式串）
出参: { definition: {...}, stoppedInstances: number }
```

- 走 `updateAgentDefinition` + `stopRunningInstancesByDefinition`（与 UI MemberEditDialog 保存链一致）；model 入参校验 provider 存在（沿 `opCreateAgent` 校验）
- builtin 定义拒绝（§11）
- 为什么恒确认：model / systemPrompt / deniedTools 都会改变 agent 行为面，统一一档避免「轻字段绕档」的规则漏洞

### 5.4 `update_skill`（恒确认，op: `updateSkill`）

```
入参: { slug: string, skillMd: string, references?: Array<{path, content}> }
出参: { slug, name, refCount, agentsUsingIt: number, needsRestart: boolean }
```

- **全量替换**（`form-create.ts:27` 同款）：清目录重写 `SKILL.md` + references + `.sha256` 重算；不做差量 patch
- 仅 **custom 源**可改（`.sha256` 标记判定）；builtin / marketplace 拒绝引导 UI；slug 不存在 → 报错指路 `create_skill`
- `references` 路径越界防御沿 `opCreateSkill.safeJoin` 同款
- 返回 `agentsUsingIt`（挂着此技能的成员数）+ `needsRestart`（skill 是 spawn 时注入，已挂成员不重载）

### 5.5 `update_mcp`（恒确认，op: `updateMcp`）

```
入参: { name: string, transport: {…与 create_mcp 同形} }
出参: { name, toolCount, toolNames: string[]（截 20）, needsAuthorization?, notice? }
```

- name 必须已注册；不存在 → 指路 `create_mcp`
- **先测后落库**（沿 `opCreateMcp` 纪律）：瞬态客户端连通测试（initialize + tools/list，30s 超时）通过 → `updateMcpEntry`（保 id/source/installed_at，内部池驱逐 → 运行中 agent 下次调用重新握手，基本即时生效）；失败零落库报错可修重试
- OAuth 401/403 → R14 例外语义：落库未绑定，返回 `needsAuthorization` + 授权路径引导
- 凭证（headers/env）不回显

### 5.6 确认档位矩阵（B 方案落点，桥面 `CONFIRM_REQUIRED` 判定的单一真相源）

| 工具 | 档位 |
|---|---|
| `describe_agent` | 免确认（只读） |
| `update_agent_capabilities` | 含任一 `add`（含加 skill）或 `scope='definition'` → **确认**；纯 member 纯 `remove` → 复述即可 |
| `update_agent_profile` | **恒确认** |
| `update_skill` | **恒确认**（内容注入即行为注入） |
| `update_mcp` | **恒确认**（连接/凭证变化） |

### 5.7 目录元数据

`CATALOG_META` 新五项：displayName（查看智能体 / 调整智能体能力 / 编辑智能体档案 / 更新技能 / 更新 MCP）、category「资源管理」、`defaultOn: false`；`update_agent_capabilities` 与 `update_mcp` 带 `riskNote`（「能力面变更，需用户确认」「连接与凭证变更，需用户确认」）。

## 6. resource-ops 扩面（7 → 12 op）

### 6.1 白名单与分发

`RESOURCE_OP_NAMES` 增加：`describeAgent` / `updateCapabilities` / `updateProfile` / `updateSkill` / `updateMcp`。`executeResourceOp` 分发沿用「args 一律不可信输入，形状先验，非法即抛中文错误」纪律。

### 6.2 广播矩阵（`notifyResourceOpSucceeded`）

| op | resource:changed | agent:runtimeChanged |
|---|---|---|
| describeAgent | ✗ | ✗ |
| updateCapabilities（member） | ✓ | ✓（进 MEMBER_AFFECTING_OPS） |
| updateCapabilities（definition）/ updateProfile | ✓ | ✓ |
| updateSkill / updateMcp | ✓ | ✗ |

### 6.3 入参解析与校验（fail-fast）

- `agent` 解析顺序：instanceId 精确匹配 → 当前 ws 成员表按 definitionId 匹配 → slug 反查定义再匹配成员；查无报错「先用 resource_list 查真实 id」
- ref 校验见 §5.2；错误信息聚合全部非法项后一次抛出
- `updateProfile` / `updateSkill` / `updateMcp` 的形状校验沿 `str / strArray / optStrMap` 既有小工具

### 6.4 delta 计算同源（契约点）

member 分支的「旧 deltas ∪ add − remove → 新 deltas」必须与 renderer `capability-helpers.computeDeltas` 同语义。**同源铁律**（`effective-capabilities.ts` 头注：展示侧禁止重实现合并规则——反向同理）落法：

- 主进程 `resource-ops.ts` 内实现纯函数 `applyCapabilityDelta(current: MergedCapabilities, deltas: AssignmentDeltas, add, remove): AssignmentDeltas`
- 新契约测试 `resource-ops-delta-parity.test.ts`：同一组输入（现状集 / 旧 deltas / add / remove）分别喂主进程纯函数与 renderer `computeDeltas`，断言输出全等；用例覆盖「add 已在 L1 的 ref」「remove 后再 add」「plugin_tool 双向」等边角

### 6.5 跨工作空间提示

`workspace_agent_members` 按 `agent_definition_id` 聚合（排除当前 ws）得 `otherWorkspaceMembers`；`scope='member'` 的成功返回里附带，供 agent 主动问「另有 N 个工作空间也有这个 agent，需要一并加吗？」

## 7. 用户确认通道（新模块 `agent-op-confirm.ts`）

### 7.1 数据结构与消息流

```
主进程 pendingConfirms: Map<requestId, { payload, resolve, childKey, timer, requestedAt }>

请求（桥内，executeResourceOp 前）:
  requestAgentOpConfirm(payload): Promise<{ allowed: boolean; reason: string }>
  → webContents.send('agent-op-confirm:request', payload)   // 广播所有窗口

回执（renderer）:
  ipc.invoke('agent-op-confirm:reply', { requestId, allowed })
  → 先到先得：requestId 不在表中 no-op（防多窗口重复处置）
```

`payload`（renderer 卡数据源，**diff 由主进程生成结构化数据，renderer 只渲染**——真相源单点）：

```
{ requestId, workspaceId,
  requester: { agentName, op, toolName },
  diff: {
    target: { kind: 'member'|'definition'|'skill'|'mcp', name, workspaceName },
    scope?: 'member' | 'definition',
    adds:    Array<{ field: 'skills'|'mcps'|'tools'|'pluginTools', ref }>,
    removes: Array<同上>,
    fieldChanges?: Array<{ field, before?, after? }>,      // profile / mcp 用
  },
  riskNote?: string,
  expiresAt: number }
```

### 7.2 四个收敛出口（缺一不可）

| 出口 | 触发 | 收敛 |
|---|---|---|
| allow | 用户点允许 | 执行 op |
| deny | 用户点拒绝 | 回子进程错误「用户拒绝了本次变更」 |
| timeout | `CONFIRM_WAIT_MS = 10min`（对齐 write-grant F5） | 按拒绝收敛，文案含「确认超时」 |
| child 退出 / 窗口全关 | spawner exit 钩子按 childKey 清表；`BrowserWindow` 计数为 0 | 立即拒绝 + 清 timer |

- 拒绝/超时文案面向 agent 可理解可改道，不是裸 exception；agent 收到后不得重试轰炸（技能册硬规则）
- 子进程侧等待预算：`requestResourceOp` 对确认类 op 用 **10min30s**，普通 op 维持 30s——per-op timeout 参数化（改 `resource-ops-bridge.ts:11` 单一常量结构）
- 回写复用 `sendMcpResponse` 通道关闭防御（`runtime-spawner.ts:499` 既有），死 child 不抛 unhandledRejection

### 7.3 后台链 fail-closed（write-grant F5 教训先验防御）

`runtimeConfig.parentStreamSessionId` 非空（dispatch 子链）→ **不发确认卡，直接拒绝**，文案：「后台任务链中没有确认人在场。能力变更请在工作空间会话中直接提出，由你本人确认。」

桥签名扩为 `handleResourceOpMessage(msg, workspaceId, childSend, executor, ctx?: { background: boolean, callerInstanceId?: string })`，spawner 闭包注入（`callerInstanceId` 供 §8 自改检测）。

### 7.4 审计

每次裁决 `logger.info({ requestId, op, allowed, reason, waitMs })`；既有工具调用审计面（doExecuteTool / preToolUse decision）不动。拒绝原因不进 agent 可见返回以外的任何持久面。

### 7.5 renderer 确认卡（P1 级 UI，走 momo-ui-preview-rules 预览门禁）

- `stores/agent-op-confirm.store.ts` + `components/AgentOpConfirmCard.tsx`，全局 Dialog（App 级挂载）
- 形态对齐 write-grant 授权卡：标题「{agentName} 请求变更」+ diff 列表（+/− 行、profile 字段 before→after）+ riskNote 高亮 + [允许] [拒绝]
- 设计系统硬约束：语义 token、lucide 图标 16px/1.75、禁 emoji 图标禁硬编码色（`docs/dev/design-system.md`）
- 卡过期（`expiresAt`）自动消失并按拒绝收敛

## 8. 重启语义（`restart` 参数，缺省 auto）

| 场景 | auto（缺省） | deferred |
|---|---|---|
| 目标在跑且 ≠ 调用者自身 | 立即 `stopAgentRuntime` + `ensureMemberRuntime`，返回 `restarted: true`（= UI 立即重启） | 只落库，`needsRestart: true` |
| 目标 == 调用者自身 | 挂 respawn-on-idle，本回合正常回包结束，返回 `effectiveFrom: 'next-turn'` | 同左 |
| 目标未在跑 | 无需重启，`needsRestart: false`（下次派发 `ensureMemberRuntime` 现算快照） | 同左 |

- **respawn-on-idle**：runtime-registry 维护 `pendingRespawn: Set<instanceId>`；AgentRunner `onIdle` 回合归零边沿（`agent-runner.ts:255`）触发检查 → `stopAgentRuntime` + `ensureMemberRuntime`；`stopAgentRuntime` 内清除标记（防重复）；不设超时上限（长任务期间等闲下来是正确行为），标记幂等
- **自改检测**：桥 ctx 的 `callerInstanceId`（ToolContext.agentInstanceId 同源）== 目标 instanceId → 恒走 respawn-on-idle，**绝不 mid-call 杀自己**（当前工具调用永远回不了包 = 会话戛然而止）
- **definition scope 维持 stop-only**（`stoppedInstances: N`，与 UI 同款不自动拉回）：可能波及多工作空间多成员，批量自动拉回影响面大
- `update_skill` / `update_mcp` / `update_profile` 不带 restart 参数：skill 靠 `needsRestart` 提示；mcp 池驱逐即基本即时；profile 走 definition 停机链

## 9. Momo 升级与存量回填

- `electron/resources/agents/general-assistant.yaml` 升版 v2.2.0：`defaultTools` 64 → **69**（+5 新工具）；`defaultSkills` 4 → **5** 册（+ `manage-agent`）
- **migration 079**（077 同式整列替换，只命中 `source='builtin' AND slug='general-assistant'`）：`default_tools` 全量替换为 69 项冻结名单；新装库 no-op
- 冻结名单导出 `MOMO_V22_ALL_BUILTIN_TOOL_REFS`（079 文件内自包含纯字符串 SQL，不 import catalog）
- 测试联动：077/078 测试的冻结名单指向按其文件头注释的既定流程更新指向 079；catalog 计数 fixture 同步 69
- builtin 再同步钩子（spec 2026-11-09 §8）自然覆盖：YAML 升版后存量库重启即再同步（与 079 双保险）

## 10. 技能设计（新册 `electron/resources/skills/manage-agent/`）

- frontmatter：name「管理智能体」；description 覆盖触发短语——给某个 agent/成员/智能体加技能、加工具、接 MCP、去掉某能力、改 prompt、换模型、更新技能内容、更新 MCP 配置、删除类请求的引导
- 工作流：**盘点**（`resource_list` 拿成员清单）→ **看清现状**（`describe_agent`）→ **复述变更**（加什么/去什么/作用域 member 还是 definition/影响几个工作空间）→ 调 update 工具 → 确认卡被拒/超时则改道不复读 → 成功后**如实转告生效时机**（已重启 / 下一轮生效 / 需手动重启）
- 硬规则（NEVER/ALWAYS 节）：
  - **删除拒答清单**（收到即一句话引导 + 指到具体页签）：删除 skill / 删除 MCP / 删除 agent 定义 / 停用预设 / 从工作空间移除成员。话术模板：「这个操作需要你亲自完成——我没有删除权限。请在 **资源库 → {页签} → {名称}** 操作。」
  - NEVER：用 `bash` / `sqlite3` / 文件系统直写绕过任何资源限制；把删除请求改写成「删了重建同名」（slug 冲突也是死路）；确认被拒后未经用户改变主意就重试同一变更；`scope=definition` 不经用户明确要求擅自使用
  - ALWAYS：改前 `describe_agent` 盘点；改前向用户复述变更清单与作用域；builtin 定义改定义级请求 → 引导 UI（成员级照常）
- catalog 双轨：`resources/marketplace/catalog.json` +1 条

## 11. 安全与权限

- **提权链分析**：给成员加 `bash` / `browser_*` / plugin tool = 纯扩权。缓解四层：确认卡 diff + riskNote（§7）→ 桥面白名单单点（子进程无法绕）→ 审计日志（§7.4）→ 后台链 fail-closed（§7.3）。残余风险与「用户手动在 UI 勾选」等价，且多一道显式确认
- **builtin 只读保护**：`updateCapabilities(scope=definition)` / `updateProfile` 命中 `source='builtin'` 定义 → 拒绝，文案：「builtin 预设定义只读。给成员调整能力用默认 member scope 即可；改定义请在资源库 UI（自定义 agent）。」成员级 deltas 是 builtin 的既有管理通道（momo-feature-scope-rules 原则 4）
- **ref 校验**：拼错当场报，不留悬空引用（§6.3）
- **凭证不回显**：`update_mcp` 的 headers/env 只入配置，返回与日志均不含
- **减权免确认的安全论证**：纯 remove 只收窄能力面，方向安全；误删可由 add 恢复（可逆）

## 12. 消费面矩阵（momo-feature-scope-rules W1–W5）

矩阵落盘 `.omo/feature-matrices/2026-11-12-agent-capability-management.md`，实现前置产物。摘要：

| 展示面 | 裁定 |
|---|---|
| 资源目录页（资源库各页签） | `resource:changed` 广播既有链原生刷新；agent 侧改动 UI 侧可见（验收锚点 1 反向验证 MemberEditDialog 同一条 delta） |
| 选择器候选（成员编辑 CapabilityTabs / 工具页签） | `tools:getCatalog` 数据驱动 +5 项；无计数硬编码（2026-11-09 已验证） |
| 命令引用入口（/ 命令、@ 引用） | 不涉及——工具不经 slash 入口暴露 |
| 各编辑器（定义/成员/工作空间配置） | MemberEditDialog 打开能看到 agent 写入的 delta（同链 `setAssignmentDeltas`，天然一致） |
| builtin 只读对象 | §11 保护 + 验收锚点 5 |

W4 门禁八问逐项作答写入矩阵文件（重点 ⑦：生效层 = spawn 装配 + MCP 池驱逐 + respawn-on-idle；可见层 = 目录/成员编辑/资源库页签，两层分别裁定；⑧ 存量锚点 = 079 迁移场景，builtin 锚点 = 只读拒绝场景）。

## 13. 测试与验收

### 13.1 单测（electron/tests/ 镜像 src/；DB 重度目录显式 `--pool=forks`）

| 文件 | 覆盖 |
|---|---|
| `tests/agent/resource-op-confirm.test.ts` | 四出口（allow/deny/timeout/child 退出）、先到先得（第二窗口 reply no-op）、窗口全关、后台链 fail-closed、payload diff 形状锁、审计日志形状 |
| `tests/agent/resource-ops-update.test.ts` | 5 新 op：增量语义（含「同 ref add+remove → remove 胜」）、ref 校验 fail-fast 全量报错、builtin 写保护、skill 仅 custom + 全量替换、mcp 先测后落库 + OAuth 例外 + 池驱逐调用、definition 停机返回 stoppedInstances、otherWorkspaceMembers 计数 |
| `tests/agent/resource-ops-delta-parity.test.ts` | §6.4 契约锁（主进程纯函数 vs renderer computeDeltas 同输入同输出） |
| `tests/agent/resource-ops-restart.test.ts` | restart 三行场景表：≠自身 stop+ensure 调用序与返回、==自身挂 pendingRespawn 且 onIdle 触发、未在跑 needsRestart=false、deferred 分支 |
| `tests/agent/tools/resource-tools.test.ts`（扩） | 新 5 工具 schema / handles / catalog 元数据完备（buildCatalog fail-fast 兜底） |
| `tests/storage/migrations/079_*.test.ts` | 冻结名单 64→69 计数 + catalog 全集一致 + 只命中 builtin general-assistant |
| `renderer/src/stores/agent-op-confirm.store.test.ts` + `AgentOpConfirmCard.test.tsx` | 卡渲染 diff / 先到先得 / 过期清扫 / riskNote 展示 |

### 13.2 回归锁

- 既有 7 op（含 6 create）零行为变化：不弹卡、超时维持 30s——专项用例断言确认门不触发
- `resource-ops-bridge` / `resource-ops` 既有测试群不回归
- 双 workspace typecheck（preload 三层引用 IPC 面，两边都要过）

### 13.3 真机验收锚点（momo-acceptance，隔离实例 + CDP）

1. **主链**：对 Momo 说「给成员 A 加 weather 技能」→ `resource_list` → `describe_agent` → 确认卡（diff 正确 +skill）→ 允许 → `describe_agent` 复查生效 + **UI MemberEditDialog 打开可见同一条 delta**（agent 写 UI 读同链证明）+ A 已自动重启
2. **拒绝链**：拒绝 → agent 收到改道文案且不复读重试
3. **后台链**：`dispatch_bg` 子链触发扩权 op → 立即拒绝文案，全程无卡
4. **自改链**：对 Momo 说「给你自己加 XX 技能」→ 确认 → 本回合正常回包 → 回合结束后 Momo 自动重启 → 下一轮新技能可用
5. **存量锚点**：带 64 工具旧 Momo 行的库 → 启动后 079 生效 69 工具，会话内新工具可用
6. **builtin 只读锚点**：对 builtin agent 传 `scope=definition` → 拒绝文案；member scope 正常
7. **删除拒答锚点**：「把 xx 技能删了」→ 引导话术 + skill 目录与 DB **零变动**
8. **UI 反向**：工具目录页 69 项分组正确；成员编辑工具页签新工具可勾选

### 13.4 边界纪律

- 版本：合入三处 `package.json` alpha +1，不动终版号（`docs/dev/release.md`）
- 确认卡 P1 级 UI：实现前静态预览过审（momo-ui-preview-rules）
- 双 workspace typecheck 先于测试；提交遵循 Conventional Commits

## 14. 交付物清单与边界

| 交付物 | 位置 |
|---|---|
| 工具面（+5 工具） | `electron/src/main/agent/tools/resource-tools.ts`（含 catalog.ts 聚合计数联动） |
| op 扩面（+5 op + delta 纯函数） | `electron/src/main/agent/resource-ops.ts` |
| 桥改造（确认门 + per-op 超时 + ctx 注入） | `electron/src/main/agent/resource-ops-bridge.ts` + `runtime-spawner.ts` 接线 |
| 确认通道 | `electron/src/main/agent/agent-op-confirm.ts`（新）+ preload 事件/reply 通道 |
| respawn-on-idle | `runtime-registry.ts`（pendingRespawn + onIdle 检查 + stop 清除） |
| renderer 确认卡 | `stores/agent-op-confirm.store.ts` + `components/AgentOpConfirmCard.tsx`（新） |
| Momo 升级 | `general-assistant.yaml` v2.2.0 + `migrations/079_*.ts` + 冻结名单测试联动 |
| 技能册 | `electron/resources/skills/manage-agent/SKILL.md` + catalog.json +1 |
| 消费面矩阵 | `.omo/feature-matrices/2026-11-12-agent-capability-management.md`（gitignored，实现前置） |
| 测试 | §13.1 全列 |

## 15. 风险与备注

- **确认等待期无人响应**：10min 拒绝收敛；agent 收到超时文案改道。不做无限等待（write-grant 前台无限等待是「人在场」前提下的产品裁定，这里确认语义更重，超时收敛更稳）
- **respawn-on-idle 永不触发**（超长后台链占住成员）：标记保留等闲，无数据丢失风险；下一次 stop/start 也会清标记
- **多窗口并发**：先到先得 + requestId 不在表 no-op，双击/双窗无双重执行
- **LLM 滥用 remove 面**：减权免确认的安全论证见 §11；被 remove 后用户可经 UI 或再让 agent add 恢复
- **update_skill 全量替换误删 references**：语义在确认卡 diff 中披露（refCount 前后对比），且 skills 目录内容可由 agent 自身重新 create——自愈闭环成立
- **契约漂移防线**：delta parity 契约测试 + 冻结名单测试 + catalog fail-fast 三层机械锁，防「agent 写 UI 读」两链分叉
