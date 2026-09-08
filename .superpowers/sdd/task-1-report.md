# Task 1 Report — Migration v29 + tasks repo 三新字段

## Status: DONE

对应 plan：`docs/plans/2026-09-07-task-execution-runtime.md` Task 1（11 任务 TDD 分解中的第一项）
对应 spec：`docs/specs/2026-09-07-task-execution-runtime-design.md` §4.1

## What I Implemented

按 brief Step 1-5 严格落地（**全 verbatim 转写**，无自由发挥）：

1. **Step 1**：写 `electron/tests/task/target-columns.test.ts`（3 用例：insertTask 往返 / updateTask 往返 / 双委派目标 trigger 拒绝）
2. **Step 2**：跑测试确认 RED（3/3 fail，原因：缺 `targetTeamId` 字段 / 缺 trigger）
3. **Step 3**：v29 迁移追加到 `electron/src/main/storage/migrations/index.ts`（v28 之后）；`electron/src/main/storage/tasks/repo.ts` 五处扩展
4. **Step 4**：跑测试确认 GREEN（3/3 PASS）
5. **Step 5**：跑回归（tests/storage + tests/task = 175/175 PASS）+ commit

## TDD Evidence

### RED

```
> vitest run tests/task/target-columns.test.ts

  ❯ tests/task/target-columns.test.ts  (3 tests | 3 failed) 145ms
    ❯ insertTask 带 targetTeamId → getTask 往返保真
      → expected undefined to be 'team-1'
    ❯ updateTask 改 targetSessionId / recurrenceParentId → 往返保真
      → expected undefined to be 'sess-1'
    ❯ 两个委派目标同设 → trigger 拒绝
      → expected [Function] to throw an error
```

> 注：首次运行有 `NODE_MODULE_VERSION 115 vs 147` 原生绑定不匹配（容器默认 Node 26，better-sqlite3 编译自 Node 20）。按 AGENTS.md 指引在 `node_modules/.pnpm/better-sqlite3@11.10.0/node_modules/better-sqlite3` 下用 `npx node-gyp rebuild --release` 重建（source ~/.nvm/nvm.sh && nvm use 20）后通过。这只是环境适配，不是产品代码变更。

### GREEN

```
> vitest run tests/task/target-columns.test.ts

12:51:11.843 (main) › Applying migration { version: 29 }

 ✓ tests/task/target-columns.test.ts  (3 tests) 120ms
 Test Files  1 passed (1)
      Tests  3 passed (3)
```

### Regression

```
> vitest run tests/storage tests/task

 Test Files  23 passed (23)
      Tests  175 passed (175)
   Duration  2.65s
```

23 个测试文件 175 用例全绿，包括：v22-v28 迁移链既有测试、tasks-repo 既有 11 用例、scheduler.test.ts、conflict-detector 等 task 子系统既有测试。

## Files Changed

| 文件 | 类型 | 改动摘要 |
|---|---|---|
| `electron/src/main/storage/migrations/index.ts` | M | 追加 v29 条目：3 个 `ALTER TABLE tasks ADD COLUMN` + `idx_tasks_admission` 索引 + 2 个 trigger（insert / update 互斥） |
| `electron/src/main/storage/tasks/repo.ts` | M | `TaskRow` 加 3 字段（line 36-40）；`SqlRow` 加 3 snake_case 字段（line 71-73）；`rowToCamel` 加 3 映射（line 97-99）；`insertTask` INSERT 列清单 25→28、VALUES 占位符 25→28、`.run()` 参数同步扩展（line 174-194）；`updateTask` UPDATE SET 列 22→25、`.run()` 参数同步扩展（line 230-256） |
| `electron/tests/task/target-columns.test.ts` | A | 新建 3 用例：insertTask 往返 / updateTask 往返 / 双委派目标 trigger 拒绝（insert + update 双路径） |

## Commit

```
e15032e feat: tasks 表 v29 迁移——委派目标三互斥列 + 循环实例链
 3 files changed, 112 insertions(+), 1 deletion(-)
```

## Self-Review

### 完整性

- [x] v29 迁移 SQL 与 brief 完全一致（含 spec 引用注释、3 列 ADD COLUMN、admission 索引、insert/update 双 trigger、ABORT 消息）
- [x] TaskRow / SqlRow 字段顺序与 brief 指定一致（`assigneeAgentId` 之后、priority 之前）
- [x] rowToCamel 字段顺序与 brief 一致
- [x] insertTask 列清单 25→28、占位符 25→28、参数 25→28 三处数量同步
- [x] updateTask SET 列 22→25、参数 22→25 两处数量同步
- [x] 测试用例与 brief 完全 verbatim

### 质量

- [x] 注释中文（与既有风格一致）
- [x] 没有引入 `any` / `@ts-ignore`
- [x] trigger 错误消息「任务委派目标三列（agent/team/session）最多一个非空」与 brief 一致；测试用 `/最多一个非空/` 正则匹配（错误消息含「最多一个非空」即可，不必强求完整字符串）
- [x] 字段命名 camelCase（与既有 TaskRow 风格一致），SQL 列 snake_case（与既有 SqlRow 风格一致）
- [x] `idx_tasks_admission` 索引遵循 spec §5.1 — status + priority DESC + scheduled_at（executor 放行查询谓词）
- [x] trigger 互斥实现与 v17 messages.task_id trigger 先例同法（RAISE(ABORT, '...')）

### 纪律

- [x] TDD 顺序：先红后绿，过程中没有为通过测试而偷工减料
- [x] 没有修改既有 TaskRow 已有字段（只在 `assigneeAgentId` 后追加新字段）
- [x] 没有为通过 v29 测试而修改既有 tasks-repo.test.ts（既有 11 用例全绿，零回归）
- [x] 严格按 brief 提供的 SQL/TS 代码块 verbatim 落地，没有自由发挥

### 测试保真度

- [x] 测试用真实 better-sqlite3 + tmp 目录 + runMigrations（不是 in-memory mock）
- [x] trigger 用真实 SQL 触发（不是 mock 验证）—— better-sqlite3 RAISE(ABORT, ...) 抛出的 Error 消息真实落入 `expect(...).toThrow(/最多一个非空/)`
- [x] 三列 NULL 默认值通过真实往返验证（`toBeNull()` 不是 `toBeFalsy()`）
- [x] 测试覆盖 3 路径：insert 单目标 / update 双目标 / 双目标互斥拒绝（insert + update 双路径），符合 momo-test-rules 铁律 3「错误路径与空输入必须有专项用例」

## Concerns

1. **环境适配副作用**：better-sqlite3 原生绑定需重建（Node 20 ABI）。这不属于 v29 任务，但如不处理后续 task 2-11 都会遇到同样问题。建议：
   - 后续任务执行前先确认 Node 20 + `npx node-gyp rebuild --release` 已就位
   - 或考虑在根 `package.json` 加 `postinstall` 钩子做 ABI 校验（不在本任务范围）
2. **trigger 互斥的边界**：当前 trigger 用 `(... IS NOT NULL) + (...) > 1` 求和，对 3 列都 NULL 允许（求和 = 0）、单列非空允许（求和 = 1）、任意两列非空拒绝（求和 ≥ 2）。这是设计本意，但 `update` trigger 中 `NEW.*` 是 UPDATE 后的目标值——若某行已 `assigneeAgentId='inst1'`，update 不改 `assignee_agent_id` 也不改 `target_team_id`，但传 `target_session_id='sess-1'` 时，NEW 的三列分别为 inst1 / NULL / sess-1，求和 = 2，触发 trigger 拒绝——与 brief 测试 #3 的 update 路径意图一致（先 insert 一个 assigneeAgentId 已设的任务，再 update 加 targetSessionId，触发拒绝）。OK。
3. **idx_tasks_admission 索引未被本任务测试覆盖**：spec §5.1 executor 放行查询会用到，本任务只负责 schema 落地，executor 行为属后续 task（plan 第 4-5 项）。索引存在性已通过 `CREATE INDEX IF NOT EXISTS` 落地，未来 executor 实现时直接 SELECT 验证即可。

## Report File

`/workspace/.superpowers/sdd/task-1-report.md`（本文件）
