# Task 14 报告：P1 验收（残留扫描 + 全量验证 + 冒烟 + README 更新）

日期：2026-08-23 · 分支：`feat/v2.0.0-p1-session-core` · 执行环境：OrbStack DevContainer（Linux arm64, Node 20.20.2）

> 注：本文件原为 v1.6 时代同编号任务的报告（UploadSkillDialog，commit b76b7b4），本轮 SDD 任务编号复用，覆盖为 P1 验收报告。

## Step 1: 残留扫描

### 扫描 1（主扫描，排除 `.test.`）

```bash
grep -rn "matrix-js-sdk\|startConduit\|bot-registrar\|botMatrixUserId\|matrix_space_id\|matrixSpaceId\|matrixEventId\|team_room_id\|room_settings\|execution_room_id" electron/src renderer/src --include="*.ts" --include="*.tsx" | grep -v "\.test\."
```

**初跑结果**：25 命中，分布两类：

1. `electron/src/main/storage/migrations/index.ts`（14 处）——**合法历史，保留**。
2. 活跃源码注释（11 处，8 个文件）——其中 5 处把**当前**读取路径错写为旧表名（`room_settings.conflict_strategy` / `room_settings.max_tool_calls`，实际已存 `sessions.settings_json`），其余 6 处为迁移历史说明但含扫描 token。

**处置**：修正/改写 8 个文件的过时注释（仅注释，零逻辑改动）：
`task/conflict-resolver.ts`、`settings/crud.ts`、`settings/ipc.handlers.ts`、`workspace/crud.ts`、`workspace/types.ts`、`storage/sessions/repo.ts`、`renderer .../ConflictDialog.tsx`、`renderer .../RoomToolBudgetBadge.tsx`。当前读取路径统一表述为 `sessions.settings_json` 的 `conflictStrategy` / `maxToolCalls`（经 `getSessionSettings` 实现核实为真）。

**终跑结果**（verbatim）：

```
electron/src/main/storage/migrations/index.ts:74:  matrix_space_id TEXT NOT NULL,
electron/src/main/storage/migrations/index.ts:126:-- team_room_id：workspace 内的"团队群" room ID。workspace 创建时同时创建一个
electron/src/main/storage/migrations/index.ts:130:ALTER TABLE workspaces ADD COLUMN team_room_id TEXT NOT NULL DEFAULT '';
electron/src/main/storage/migrations/index.ts:137:-- default_skills（运行时能力引用）。原 v4 已被 team_room_id 占用，故本迁移用
electron/src/main/storage/migrations/index.ts:327:CREATE TABLE IF NOT EXISTS room_settings (
electron/src/main/storage/migrations/index.ts:473:  execution_room_id     TEXT,
electron/src/main/storage/migrations/index.ts:503:CREATE INDEX IF NOT EXISTS idx_tasks_exec_room ON tasks(execution_room_id);
electron/src/main/storage/migrations/index.ts:517:-- room_settings.conflict_strategy：当 agent 在已运行任务的房间里被 @ 时如何处理。
electron/src/main/storage/migrations/index.ts:522:ALTER TABLE room_settings ADD COLUMN conflict_strategy TEXT NOT NULL DEFAULT 'ask';
electron/src/main/storage/migrations/index.ts:529:-- agent_definitions.default_conflict_strategy：与 room_settings.conflict_strategy 同语义，
electron/src/main/storage/migrations/index.ts:606:ALTER TABLE tasks RENAME COLUMN execution_room_id TO execution_session_id;
electron/src/main/storage/migrations/index.ts:611:ALTER TABLE workspaces RENAME COLUMN team_room_id TO team_session_id;
electron/src/main/storage/migrations/index.ts:612:ALTER TABLE workspaces DROP COLUMN matrix_space_id;
electron/src/main/storage/migrations/index.ts:614:DROP TABLE IF EXISTS room_settings;
```

### 残留分类（全部命中 = migrations/index.ts 独占）

| 类别 | 行 | 判定 |
|---|---|---|
| v1 时代历史迁移 SQL（建列/建表） | 74, 126-137, 327, 473-529 | **合法**——迁移链 append-only，改动会破坏旧库升级路径 |
| v23 迁移自身（改名/删列/删表） | 606, 611, 612, 614 | **合法**——正是执行删除的迁移本体 |

**测试文件命中**：`grep "\.test\."` 过滤后复查 = **CLEAN**（0 个测试文件含任何扫描 token，无需历史豁免）。

### 扫描 2 / 扫描 3

```bash
grep -rn "momo-studio\/matrix\|from '\.\./matrix" electron/src --include="*.ts"   → CLEAN
grep -c "matrix-js-sdk" electron/package.json                                      → 0（CLEAN）
```

## Step 2: 全量验证

| 门禁 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npx pnpm@9.0.0 typecheck` | ✅ 双 clean（`electron typecheck: Done` / `renderer typecheck: Done`） |
| Electron 测试 | `npx pnpm@9.0.0 test` | ✅ **Test Files 128 passed (128)，Tests 858 passed (858)**，25.98s |
| Renderer 测试 | `--filter momo-studio-renderer test` | ✅ **Test Files 49 passed (49)，Tests 409 passed (409)**，19.58s |
| 构建 | `npx pnpm@9.0.0 build` | ✅ EXIT=0（renderer `✓ built in 2m 40s`；仅 >500kB chunk 警告，非错误） |

注释清理后复验：typecheck 双 clean + 相关测试复跑（conflict-resolver 5/5、RoomToolBudgetBadge 8/8）通过。

## Step 3: xvfb 冒烟（容器安全子集）

**边界声明（诚实）**：本冒烟只覆盖"启动链无 Matrix 残留、无崩溃"。brief 中的完整交互验收（建 workspace → 建会话拉 agent → 真实 LLM 流式回复 → 杀进程重启会话一致）**需要真实 LLM API key 与 GUI 交互，留待 macOS 主机执行**，本容器未验证。

过程中处置的两个环境问题（均为 AGENTS.md 已知坑，非代码问题）：
1. `better-sqlite3` NODE_MODULE_VERSION 115 vs 123（electron ABI）→ `npx electron-rebuild -f -w better-sqlite3` 修复。
2. `electron/dist/main/conduit/` 为 7 月旧构建的孤儿产物（tsc 不清理已删源码的输出，且会被 electron-builder 打包捡走）→ 已手动删除。**建议 P3 收敛时在 build 脚本加 dist 清理步骤**。

**冒烟命令与输出（verbatim，60s timeout，入口为 `dist/main/index.js`——task 指令中的 `dist/main.js` 是笔误）**：

```bash
timeout 60 xvfb-run -a --server-args="-screen 0 1280x800x24" ./node_modules/.bin/electron dist/main/index.js --no-sandbox
```

```
18:32:11.717 (main) › App starting { version: '30.5.1' }
18:32:11.738 (main) › SQLite opened { path: '/home/ai-agent/.momo-studio/state.db' }
18:32:11.739 (main) › Applying migration { version: 17 }
...（17/18/19/21/22/23 依次应用）
18:32:11.765 (main) › Migrations complete
18:32:11.766 (main) › TaskScheduler 已启动（调度层；task-driven 执行链路为 v2 增量）
18:32:11.766 (main) › Registering IPC handlers
...（System/Workspace/File/Agent/Session/MCP/Allocation/Git Policy/Audit/Provider/Skill/Resource/Task/Dialog 全部注册——无任何 conduit/matrix handler）
18:32:11.971 (main) › 无 task-driven agent，跳过 RouterService 初始化
18:32:11.972 (main) › Task-driven runtime initialized
18:32:12.752 (main) › Window ready
/workspace/.../electron exited with signal SIGTERM    ← timeout 正常终止，60s 内无崩溃
```

（GPU/viz_main_impl 报错为 xvfb 无显卡环境的正常现象，不影响验收。）

**加分证据**：容器里的 `state.db` 是带 v1 旧数据的真实旧库，本次启动把 17→23 迁移链**在真实数据上增量跑通**，顺带验证了 v23 对旧 schema 的变形能力（注：2.0.0 D5 决策为完全重新开始，正式升级路径仍以新库为准）。

**进程检查**：`ps aux | grep -i "tuwunel\|conduit"` → `无 Tuwunel/Conduit 进程`。

### 验收点对照

| brief 验收点 | 容器内 | 结论 |
|---|---|---|
| 首启建 workspace | 未交互验证（无 GUI 操作） | 留待主机 |
| 建会话拉 agent + 流式回复 | 未验证（需真实 LLM key） | 留待主机 |
| 杀进程重启会话一致 | 未验证 | 留待主机 |
| 无 Tuwunel 进程 | ✅ ps 为空 + 日志零引用 | 通过 |
| 启动链健康（DB/迁移/runtime/窗口/无崩溃） | ✅ 见上 verbatim | 通过 |

## Step 4: README 更新

- 状态段新增 **v2.0.0-p1 条目**（BREAKING 移除 Matrix/Tuwunel、sessions 模型、传输层内迁、task_reply 链线、P2-P5 待办）。
- 修剪陈述"当前事实"的过时段落：前置依赖 Tuwunel 行、安装段 postinstall/Tuwunel 下载说明、matrix-js-sdk 锁版本 blockquote、开发段"首次注册向导（本地 Matrix 账号）"、项目结构 resources/ 描述（实测仅剩 marketplace catalog）。
- 特性段"即时通讯（IM）"→"会话"；工具上限"房间级覆盖"→"会话级覆盖"。
- 技术债表删 3 行已解决项（matrix-js-sdk 锁定 / conduit 测试 flaky——测试已删 / 同房中断——`activeStreams` 已随双轨删除，grep 核实）。
- 已知限制删 4 项失效项（Tuwunel 二进制、matrix-js-sdk 锁定、同房中断、Matrix event 不可变旧消息），新增"2.0.0 完全重新开始"条目。
- **历史 roadmap（v1.0-v1.7 已发布记录及 v2.0+ 远景条目）原样保留**——其中 Matrix 相关表述属历史记录，不改。

## Commits

1. `chore: 清理 v23 迁移后残留的旧 schema 注释引用`（8 文件，仅注释）
2. `docs: P1 会话内核完成——README 2.0 重构状态更新`（README.md）
3. `docs(sdd): task-14-report P1 验收报告`（本文件）

## 结论

P1 残留扫描、类型检查、测试（858+409 全绿）、构建、容器级冒烟**全部通过**；唯一未闭环项为需真实 LLM key 的交互式验收，按边界声明留待 macOS 主机执行。
