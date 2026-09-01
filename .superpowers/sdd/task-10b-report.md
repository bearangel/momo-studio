# Task 10B 报告：v25 遗留债务清理（capabilities FK 重建 + definitions 死列修复）

## Status: ✅ COMPLETE

## 交付内容

### 债务①：migration v26——重建 agent_assignment_capabilities FK

**根因**：v25 `DROP TABLE agent_assignments` 时未重建本表外键，`assignment_id` 悬挂引用已删表——`foreign_keys=ON` 下任何 INSERT 即报 `no such table: main.agent_assignments`，生产写路径 `agent:setMemberDeltas` 必炸（T10 审查移交）。

**修法**（`electron/src/main/storage/migrations/index.ts` 追加 v26，与 v25 session_members 同款「新建表+搬运+换名」）：

- FK 改指 `workspace_agent_members(instance_id) ON DELETE CASCADE`；列清单/复合 PK 与 v16 完全一致——**生产读写代码零改动**
- `JOIN workspace_agent_members` 搬运 = 失效 instance_id 引用按级联语义清理（不搬运）；正常路径 v25 的 DROP 级联已清空表，空表安全通过

### 债务②：crud.ts workspace_id 死列清理（4 处）

v25:712 已 `DROP COLUMN workspace_id`，crud 仍在读写——definition 保存链路全炸（174 红主要根因之一）：

| 位置 | 修复 |
|---|---|
| `saveAgentDefinition` INSERT | 列清单 + `@workspace_id` 移除 |
| `listAgentDefinitions` WHERE | `workspace_id IS NULL OR = ?` 过滤退役（v25 定义全局化；参数保留签名兼容，`resource/custom` `marketplace/installer` `p2p/resource-transfer` 三个消费方均无参调用，零影响） |
| `rowToDef` / `AgentDefRow` | 死列映射移除，`workspaceId: null`（字段保留为 renderer 契约，T12 起 UI 清理） |
| `updateAgentDefinition` SET | 死列 + `input.workspaceId` 入参移除；`ipc.handlers.ts` 调用方同步（handler 入参类型保留接收、文档标注语义退役） |

### TDD 回归锁（先红后绿，红态=生产断裂复现）

- `electron/tests/storage/migration-v26.test.ts`（6 用例）：空库 FK 指向/四列 PK 保留、FK=ON 写路径恢复、FK 真实生效（ghost 拒绝）、数据搬运无损+失效清理、级联贯通、v25 空表安全升级
- `electron/tests/agent/capabilities-rebuild.test.ts`（7 用例）：**setMemberDeltas 全链路**（ipcMain 捕获真实 handler → 真实落表 → capability-merger 读回 → `mergeCapabilities` 三层合并，与 `spawn-helpers.ts:217-219` 生产消费序列逐字对齐）+ getMemberDeltas 空 delta 契约 + FK 错误路径 + 级联清理 + 全量替换幂等 + definitions round-trip。Mock 收窄：仅 electron/keychain/spawn 链/p2p 广播边界，DB 与业务全真实；instanceId 用真实 `addMember` randomUUID
- 红态证据：13/13 失败于 `no such table: main.agent_assignments` / `table agent_definitions has no column named workspace_id`——两条生产断裂精确复现

### capabilities 域 fixture 迁移（v25 schema）

- `assignment-capabilities-crud.test.ts` / `capability-merger-read.test.ts`：fixture 从 `team_session_id`/`agent_assignments`(enabled/role) 迁到 v25 `workspace_agent_members`，语义意图不变
- `spawn-helpers-tools.test.ts`：v25 时代「临时关 FK 绕悬挂外键」的 seed 绕行删除（v26 后直写，注释记录债务已清偿）

## 全量前后对比（electron workspace）

| 指标 | 前 | 后 | Δ |
|---|---|---|---|
| 总数 | 1314 | 1327 | +13（新增测试） |
| 通过 | 1140 | 1179 | +39（26 转绿 + 13 新增） |
| 失败 | **174** | **148** | **−26** |
| 新增红 | — | **0** | 逐测试 fullName 比对确认 |

**转绿 26 = definitions 域 19**（builtin ×4 / deleteDefinition / createCustomDef ×6 / updateAgentDefinition ×6 / listAgentDefinitions / marketplace-installer）**+ capabilities 域 7**（assignment-capabilities-crud ×5 / capability-merger-read ×2）。

**剩余 148 红不在本任务域**：tasks-repo(13)/audit-quota(12)/agent-runner(11)/task-tools(11)/sqlite-provider(10)/dispatcher(9)/crud-assignment(17)/crud-update、crud-list 部分断言 v25 前 workspace 过滤语义（断言已退役行为，属各域语义清理任务）等——均为 v25 中间态已知基线的其他域部分。

## 验证

- 新增测试 13/13 绿；capabilities+v25+v26 域批 29/29 绿（v25 迁移回归无破坏）
- `pnpm typecheck` 双 clean（electron Done / renderer Done）
- `lsp_diagnostics` 三个改动文件零错误
- ESLint `no-explicit-any` 无违反（无 any 引入）

## Commits

- `fix(storage): v26 重建 capabilities FK + definitions 死列清理——v25 遗留生产断裂（T10 审查移交）`

## Concerns / 边界说明

1. `listAgentDefinitions(workspaceId?)` 参数保留但语义退役（`void workspaceId`）——T12 renderer 清理后可移除；`ipc.handlers.ts` 的 `agent:updateDefinition` 入参仍接收 `scope`/`workspaceId`（renderer 兼容），已文档标注不消费
2. `AgentDefinition.workspaceId` 类型字段保留（electron + renderer 两端），恒映射 `null`——契约漂移防线：字段未删是因为 renderer types.d.ts 仍声明，T12 统一清理
3. v26 数据搬运用 JOIN 防御式清理：正常升级路径下表已被 v25 级联清空，搬运实际为 no-op；针对的是 FK 关闭期间残留行的理论态
