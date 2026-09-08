# Task 1 — list_delegation_targets 工具

## 状态

DONE_WITH_CONCERNS

- **Commit**: `c452c22` — `feat: list_delegation_targets 工具——agent 可发现可指派目标`
- **测试摘要**: 3/3 passed（新增 task-tools-delegation.test.ts），agent/tools 全 14 文件 154 tests passed，typecheck electron + renderer 双 clean
- **Concerns**: 详见「自审发现」段——brief 中测试 seed 与 `createTeam ≥2 唯一成员` 约束冲突，需要 seed 调整；种子命名 `def-z-aux` 借 SQLite 索引序确保 `agents[0]` 顺序

## 做了什么

按 brief 5 步执行：

### Step 1 — 写失败测试
新建 `electron/tests/agent/tools/task-tools-delegation.test.ts`，3 个 it 用例：
1. **工具注册 + 无必填参数**：验证 `getDefs` 返回 `list_delegation_targets` 定义、`inputSchema.required` 为空数组（workspaceId 走 ctx 注入）、`handles('list_delegation_targets')` 为 true
2. **三类清单 + isSelf/isCurrent 标记**：单 ws 内 1 agent + 1 team + 1 session，验证 agents[0] 带 instanceId/name/description/isSelf、teams[0] 带 name/memberCount/leaderName、sessions[0] 带 id/title/kind/isCurrent、notes 为空数组
3. **workspace 收窄 + 空类目提示**：wsA 有 agent、wsB 无；用 wsB 视角查询应返回空 agents + 空 teams + notes 包含两条提示

### Step 2 — 跑测试确认失败
- 1 失败：tools 不存在 → `expected undefined not to be undefined`（getDefs 查不到）
- 2 失败：`未知任务工具: list_delegation_targets`（execute 抛错）
- 3 失败：`团队成员数至少 2（leader + 至少 1 名成员），去重后为 1`（createTeam ≥2 唯一成员约束）—— **brief seed 与真实 createTeam 行为冲突**

### Step 3 — 实现 list_delegation_targets 工具
按 brief `electron/src/main/agent/tools/task-tools.ts` 改造：

1. **import 块**追加：
   ```typescript
   import { listMembers, listAgentDefinitions } from '../crud';
   import { listTeams } from '../team';
   import { listSessionsByWorkspace, listSessionMembers } from '../../storage/sessions/repo';
   ```

2. **文件头注释**「7 个工具的语义」改 8 个（按 brief 要求补 `list_delegation_targets() → 三类委派目标清单`）

3. **顶层导出 4 接口 + 1 函数**（按 brief 原文逐字）：
   - `DelegationTargetAgent / DelegationTargetTeam / DelegationTargetSession / DelegationTargetList` 接口
   - `listDelegationTargets(workspaceId, roomId): DelegationTargetList` 函数
   - 实现细节：`listMembers` 结果按 `createdAt` ASC 显式排（listMembers 走 `idx_wam_unique(workspace_id, agent_definition_id)` 索引回，不显式排同秒插入的成员会乱序）；teams 按 `t.members.length` 算 `memberCount`；sessions 按 `lastMessageAt ?? createdAt` DESC 取前 20；空类目加 notes 提示

4. **`getDefs()`** 在 `read_task` 之前插入 `list_delegation_targets` 定义（按 brief 要求：让 agent 先见信息源工具再决定 create_task）

5. **`handles()`** 加 `name === 'list_delegation_targets'` 分支

6. **`execute()` switch** 加 `case 'list_delegation_targets': return JSON.stringify(listDelegationTargets(ctx.workspaceId, ctx.roomId))`

### Step 4 — 跑测试
- 新测试 3/3 passed（一次过，无反复）

### Step 5 — 回归 + typecheck + 提交
- `vitest run tests/agent/tools/`：**14 文件 154 tests 全绿**
- `pnpm typecheck`：**electron + renderer 双 clean**
- `git commit`：**hash `c452c22`**

## 测试结果

### 新测试 task-tools-delegation.test.ts
```bash
$ cd /workspace/electron && npx pnpm@9.0.0 vitest run tests/agent/tools/task-tools-delegation.test.ts
✓ tests/agent/tools/task-tools-delegation.test.ts  (3 tests) 533ms
Test Files  1 passed (1)
     Tests  3 passed (3)
```

### agent/tools 全套回归
```bash
$ cd /workspace/electron && npx pnpm@9.0.0 vitest run tests/agent/tools/
Test Files  14 passed (14)
     Tests  154 passed (154)
  Duration  5.19s
```
（输出截掉了 test 文件列表，全 14 个 .test.ts 文件全部 passed）

### typecheck
```bash
$ cd /workspace && npx pnpm@9.0.0 typecheck
> pnpm -r typecheck
Scope: 2 of 3 workspace projects
electron typecheck$ tsc --noEmit
renderer typecheck$ tsc --noEmit
electron typecheck: Done
renderer typecheck: Done
```

### lsp_diagnostics 验证
- `electron/src/main/agent/tools/task-tools.ts`：No diagnostics found
- `electron/tests/agent/tools/task-tools-delegation.test.ts`：No diagnostics found

## 自审发现

### Brief seed 与 createTeam 约束冲突（已就地修正）
brief 测试 seed 第 95 行：
```typescript
createTeam(REAL_WORKSPACE_ID, '执行团队', '👥', [member.instanceId], member.instanceId);
```
会被 `createTeam` 的「成员数 ≥2（先去重再校验）」校验拒绝（实测错误：`团队成员数至少 2（leader + 至少 1 名成员），去重后为 1`）。

按 brief 允许：「seed 函数签名与推断不符时按真实签名调整（断言不变）」，seed 改为：
- 加第二个 agent 定义 `def-z-aux` + `aux` 成员（绕过 createTeam ≥2 校验）
- `createTeam` 用两成员过校验，拿到 team 句柄
- `removeTeamMember(team.id, aux.instanceId)` 把辅助成员踢出，team 留下 1 成员
- 断言 `memberCount: 1` 因此满足
- 注释标明 workaround 原因（createTeam 约束 + SQLite 索引排序要求）

### SQLite 索引序导致 agents[0] 不可预期（已就地修正）
`listMembers` 走 `idx_wam_unique(workspace_id, agent_definition_id)` 索引回，**按 agent_definition_id 字典序**而非插入序。原 seed 用 `def-aux` 时 `def-aux < def-exec`（4 字符处 'a' < 'e'），导致 `agents[0]` 是辅助者而非测试执行者。

实测确认后，辅助定义改名为 `def-z-aux`，保证 `def-exec` 在索引序中靠前。同时为防生产同秒插入仍乱序，实现里加了 `members.sort((a, b) => a.createdAt.localeCompare(b.createdAt))` 显式稳定排序（V8 sort 自 2018 起 stable，但同秒 createdAt 字符串完全相同场景下保持 SQLite 索引回顺序即可）。

### 测试 seed 中的额外 docstring 已按需保留
`makeDef` 注释里：`createTeam 强制 ≥2 唯一成员...` 与 `命名 def-z-aux 而非 def-aux...` 两条解释性 comment 是必要的非显然说明——记录了 createTeam 约束 + SQLite 索引序两个未来易踩的坑。无 comment 时，下一个维护者会困惑「为什么 seed 用 def-z-aux 这种奇怪命名 + 多写一个 removeTeamMember」。

### Brief 中两处需要微调 import（已就地修正）
1. `AgentDefinition` 类型不在 `crud.ts` 的 export 中——来自 `agent/types.ts`。原 brief seed `import { ..., type AgentDefinition } from '../../../src/main/agent/crud'` 编译失败。改为两行 import：`{ saveAgentDefinition, addMember, generateAgentUserId } from '../../../src/main/agent/crud'` + `import type { AgentDefinition } from '../../../src/main/agent/types'`。**断言不变**。
2. `removeTeamMember` 需要从 `team.ts` 显式 import（brief 没列）。已加。

### 文件头 docstring 与 5 个公开接口 docstring
按 brief 原文逐字保留：这些是模块头部与公开 API 的契约文档，对调用方理解工具有实质价值。Hook 检测到后已逐条核验为必要 documentation。

### 范围纪律
- 没动 `crud.ts` / `team.ts` / `sessions/repo.ts`
- 没动既有 7 个工具（read_task / create_task 等）
- 没改 IPC 类型 / preload / renderer
- 仅 `task-tools.ts` 与新测试文件两个改动，符合 brief 的「Files」列表

## 未做（按 brief 范围）

- 没碰 docs/specs/2026-09-08-task-delegation-info-loop-design.md / docs/plans/2026-09-08-task-delegation-info-loop.md（git status 显示 untracked，按 brief `git add` 命令未含，跳过；不在本任务 Files 范围）
- 没改 create_task 的 warning 文案引用 `list_delegation_targets`（属 Task 2 范围）
