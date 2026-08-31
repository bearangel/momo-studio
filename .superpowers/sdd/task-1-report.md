# Task 1 Report: migration v25 —— schema 变形

## Status: DONE_WITH_CONCERNS（245 个预存 schema 依赖测试失败，已判定为预期破坏）

## What Was Implemented

按 brief（/workspace/.superpowers/sdd/task-1-brief.md）完成 migration v25（spec `docs/specs/2026-08-31-agent-team-session-redesign.md` §3）：

- **`electron/src/main/storage/migrations/index.ts`**：MIGRATIONS 数组 v24 后追加 v25
  - 去编排：`agent_assignments` → `workspace_agent_members`（无 role/parent/enabled；同 ws 同 def 去重保留最早一条，被删行经 FK 级联清理 session_members / agent_assignment_capabilities）
  - 团队：`teams`（leader FK 指 member）/ `team_members`（双主键 team_id+instance_id）
  - 双会话类型：`sessions.title_auto`；`session_members` 重建表（assignment_id → instance_id、新增 is_leader 默认 0、FK 改指 members）
  - 默认会话 agent：`workspaces.coordinator_instance_id` → `default_agent_instance_id`；`team_session_id` 退役
  - 定义全局化：`agent_definitions.workspace_id` 退役
- **SQL 与 brief 的两处偏差（均为必要修正，已在迁移注释中说明）**：
  1. `UPDATE workspaces SET default_agent_instance_id = coordinator_instance_id;`（同表列直拷）——brief 自带的修正注释所指
  2. 新增 `DROP INDEX IF EXISTS idx_agent_definitions_workspace;`（在 `ALTER TABLE agent_definitions DROP COLUMN workspace_id` 之前）——SQLite DROP COLUMN 拒绝删除带索引的列，v12 建的该索引不删则迁移报 `error in index ... no such column`（实验验证）
- **`electron/tests/storage/migration-v25.test.ts`**（新建，路径按 brief）：5 用例
- **两处机械性测试修复（v25 的直接后果，意图不变）**：
  - `tests/migrations/023-sessions.test.ts`：harness 由「无上界应用全部迁移」改为上界 23（024 起的 applyUpTo 模式）——其断言的 schema（team_session_id / agent_assignments 列）自 v25 起被合法退役，无上界则随最新版本漂移误报
  - `tests/upgrade/legacy-upgrade.test.ts:214`：`expect(maxV).toBe(24)` 硬编码改为动态取 `loadMigrations()` 最大版本——该断言意图本是「新库迁到最新」，硬编码每加迁移必碎

## TDD Evidence

**RED**（实现前）：
- 命令：`cd electron && npx vitest run tests/storage/migration-v25.test.ts`
- 结果：`Tests 5 failed (5)`，失败原因全部为 v25 缺失导致的 schema 缺席：
  - `SqliteError: no such table: workspace_agent_members`
  - `SqliteError: no such column: default_agent_instance_id`
  - 及 teams/is_leader 等断言失败——符合预期（迁移不存在，不是笔误）

**GREEN**（实现后）：
- `npx vitest run tests/storage/migration-v25.test.ts tests/migrations/023-sessions.test.ts tests/migrations/024-settings.test.ts` → `Test Files 3 passed (3) / Tests 18 passed (18)`

**实现前 dry-run 去险**：在 /tmp 脚本中以真实 v1..v24 迁移链 + fixture 数据预演 brief SQL，发现并验证 DROP COLUMN 带索引列问题（见上）。

## Test Results

| 项 | 命令 | 结果 |
|---|---|---|
| 本任务测试 | `npx vitest run tests/storage/migration-v25.test.ts` | 5/5 通过 |
| 邻近迁移测试 | 023 + 024 | 13/13 通过 |
| typecheck | `npx pnpm@9.0.0 typecheck`（根） | electron + renderer 双 clean |
| lsp_diagnostics | 3 个改动文件 | 零错误 |
| electron 全量 | `npx vitest run`（electron workspace） | 958 通过 / 245 失败（41 文件）——见下判定 |
| renderer 全量 | 未跑（零 renderer 文件改动；typecheck 已覆盖编译层） | — |

## 全量失败清单与预存判定

**基线证明**：`git stash` 我的改动后全量跑 → **154 文件 / 1198 测试全绿**。故全部 245 个失败均由 v25 引起。

**错误形态分布**（全部为 schema 依赖，无逻辑错误类）：
- 96 × `table workspaces has no column named team_session_id`（测试 fixture 插入 v25 退役列）
- 37 × `table agent_definitions has no column named workspace_id`
- 10 × `no such table: agent_assignments`
- 其余为连带断言失败（beforeEach hook 失败连锁、断言退役列存在等，如 db.test.ts:87 断言 coordinator_instance_id 存在）

**判定**：41 个失败文件全部属于任务说明预告的「现有测试直接建/依赖 v24 前 schema」类别——它们通过真实 `runMigrations()` 建库或 fixture 插入旧 schema 列/表，v25 合法退役这些结构后必然失败，属 15-task 计划后续任务（服务与测试重写）的预期工作面，本任务不越界修业务代码。

失败文件清单（41）：
```
tests/agent/agent-runner.test.ts                tests/agent/agent-start-subagents.test.ts
tests/agent/assign-local-identity.test.ts       tests/agent/assignment-capabilities-crud.test.ts
tests/agent/builtin.test.ts                     tests/agent/capability-merger-read.test.ts
tests/agent/crud-assignment.test.ts             tests/agent/crud-custom-def.test.ts
tests/agent/crud-list-definitions.test.ts       tests/agent/crud-update.test.ts
tests/agent/definition-default-model.test.ts    tests/agent/ipc-stop-start.test.ts
tests/agent/remove-cascade.test.ts              tests/agent/runtime-registry.test.ts
tests/agent/spawn-helpers-platform.test.ts      tests/agent/spawn-helpers-sub-filter.test.ts
tests/agent/spawn-helpers-tools.test.ts         tests/agent/tools/task-tools.test.ts
tests/audit/quota.test.ts                       tests/im/session-ops.test.ts
tests/im/session-service.test.ts                tests/integration/agent-online-bootstrap.test.ts
tests/integration/agent-start-stop.test.ts      tests/integration/router-lazy-init.test.ts
tests/integration/task-driven-e2e.test.ts       tests/marketplace/installer.test.ts
tests/memory/sqlite-provider.test.ts            tests/storage/db.test.ts
tests/storage/sessions-repo.test.ts             tests/storage/tasks-repo.test.ts
tests/task/conflict-executor.test.ts            tests/task/dispatcher.test.ts
tests/task/ipc-handlers.test.ts                 tests/task/scheduler.test.ts
tests/task/starter.test.ts                      tests/workspace/allocation.test.ts
tests/workspace/coordinator.test.ts             tests/workspace/crud.test.ts
tests/workspace/git-policy.test.ts              tests/workspace/rename.test.ts
tests/workspace/set-coordinator-restart.test.ts
```

## Files Changed（commit 3e46360）

- `electron/src/main/storage/migrations/index.ts`（+v25 迁移，89 行）
- `electron/tests/storage/migration-v25.test.ts`（新建，5 用例）
- `electron/tests/migrations/023-sessions.test.ts`（harness 上界 23）
- `electron/tests/upgrade/legacy-upgrade.test.ts`（版本断言动态化）

## Self-Review Findings

- **测试保真度（momo-test-rules 对照）**：零 mock——真实 better-sqlite3 内存库 + 真实迁移 SQL 全链路；断言生产消费字段（instance_id/agent_user_id/api_key_override/created_at/is_leader/added_at）的真实值；空库路径有专项用例（迁移不炸 + COUNT=0）；fixture 经 FK ON 校验。
- **YAGNI**：未动任何业务代码；仅迁移 + 测试 + 两处机械性测试修复。
- **测试文件位置**：brief 指定 `tests/storage/migration-v25.test.ts`，与既有迁移测试目录 `tests/migrations/` 不同——按 brief 执行（vitest include 两者都覆盖）。后续 task 若归档迁移测试可移入 `tests/migrations/025-*`。

## Concerns

1. **245 个预存 schema 依赖失败**（41 文件，清单与判定见上）——后续 task 重写服务时一并处理；提交本 commit 后分支全量非绿是**预期状态**。
2. **数据边界：coordinator 指向被去重掉的重复 assignment** → `UPDATE workspaces SET default_agent_instance_id = ...` 会触发 FK 约束使迁移中止（实验确认 FK 行为）。brief SQL 未处理此边界（去重只保最早 rowid）；真实数据中「同 ws 同 def 重复 assignment + coordinator 恰指向后者」概率低，但发布前建议任务 owner 决定是否加防护（如先把失配 coordinator 置 NULL）。
3. **`agent_assignment_capabilities` 表仍在**（brief 未提）：v25 去重/删表的 FK 级联会清空其行，但空表 + 悬空 FK 定义残留，后续清理 task 需处理。
4. **brief SQL 的两处偏差**（UPDATE 同表直拷系 brief 自注修正；DROP INDEX 为实验验证的必要修正）——已写入迁移注释与 commit message。

---

# Appendix: 评审修复（Important #1 / #2）——commit 5f35c2d

## 修复经过

评审 Approved 附两条 Important，均按 TDD 顺序完成：

### Fix 1：migration 防护性 UPDATE（Important #1）

`electron/src/main/storage/migrations/index.ts` v25 SQL 中，去重 DELETE 之后、`INSERT INTO workspace_agent_members` 之前插入防护语句（评审给定 SQL 原文）：

```sql
-- 防护：coordinator 指向被去重掉的行时先置 NULL（否则下方直拷 UPDATE 触发 FK 中止，
-- 且迁移 runner 逐句自动提交会让库停在半迁移态无法自愈重试）
UPDATE workspaces SET coordinator_instance_id = NULL
WHERE coordinator_instance_id IS NOT NULL
  AND coordinator_instance_id NOT IN (SELECT instance_id FROM agent_assignments);
```

同时消解了原 Concerns #2（数据边界：coordinator 指向被去重行 → 迁移中止）。

### Fix 2：边界回归锁「去重×级联×重建三联动」（Important #2）

`migration-v25.test.ts` 新增第 6 用例。夹具：1 ws + 1 def + 两条重复 assignment（inst-1 早 / inst-2 晚）+ session 同时挂两成员 + `agent_assignment_capabilities` 一行挂 inst-2 + coordinator 指向 inst-2。断言四点：session_members 只剩 (sess-1, inst-1) / capabilities 级联清空 / default_agent_instance_id 为 NULL / members 仅剩 inst-1。

## TDD Evidence（修复轮）

**RED**（防护语句加入前）：
- 命令：`cd electron && npx vitest run tests/storage/migration-v25.test.ts`
- 输出：`6 tests | 1 failed` → `SqliteError: FOREIGN KEY constraint failed`，栈顶即 `applyRemaining` 中 `db.exec(m.sql)`——迁移本身在直拷 UPDATE 处中止，与评审诊断的 abort 路径一致（取证于防护加入前的原始 SQL，未走「临时注释」捷径）
- 其余 5 用例保持通过

**GREEN**（防护加入后）：
- `npx vitest run tests/storage/migration-v25.test.ts tests/storage/db.test.ts tests/migrations/023-sessions.test.ts tests/migrations/024-settings.test.ts`
- 结果：`Test Files 1 failed | 3 passed (4) / Tests 1 failed | 25 passed (26)`
- 判定：migration-v25 **6/6 全绿**；023/024 全绿；db.test.ts 的 1 失败为原报告已记录的预存 schema 依赖（db.test.ts:87 断言退役列 coordinator_instance_id 存在于最新 schema），与本次修复无关，留后续 task
- 额外保险：`tests/upgrade/legacy-upgrade.test.ts` 15/15（真实 runMigrations 全链含防护语句可完整走通）
- `npx pnpm@9.0.0 typecheck`：electron + renderer 双 clean；lsp_diagnostics 两改动文件零错误

## Files Changed（commit 5f35c2d）

- `electron/src/main/storage/migrations/index.ts`（+5 行：防护 UPDATE 及注释）
- `electron/tests/storage/migration-v25.test.ts`（+49 行：三联动用例）
