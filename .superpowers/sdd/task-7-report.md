# Task 7 Report — IPC create 入参扩展（双端）

## What I Implemented

扩展 task 创建入参 3 字段（targetTeamId / targetSessionId / recurrenceRule），三层透传：

- **Layer 1 — IPC handler（electron 主进程）**：`task:create` 的 `CreateInput` 加三字段 + `insertTask({...})` 调用同步透传
- **Layer 2 — Agent 工具（LLM 透出）**：`CreateTaskInput` / `createTask` / `create_task` 工具 JSON schema defs / `execute()` args parsing 四处同步加三字段（agent 调 `create_task` 时可直接指定委派目标）
- **Layer 3 — Renderer 类型契约**：`TaskRow` 加 3 字段（targetTeamId / targetSessionId / recurrenceParentId，`recurrenceRule` 既有）；`TaskApiSurface.create` 加 3 字段（targetTeamId / targetSessionId / recurrenceRule）

`preload/index.ts:216` 透传桥，**未改动**（按 brief 已核实）。

## TDD Evidence

**RED**：先在测试文件加两个用例（`task:create 支持 targetTeamId + 循环规则透传` / `task:create 支持 targetSessionId 委派`），第一次跑测试即失败——`CreateInput` 无三字段，断言 `created.targetTeamId === 'team1'` 收到 null。

**GREEN**：实现三处扩展后所有用例通过（6 tests passed）。
```
✓ tests/task/ipc-handlers.test.ts  (6 tests) 248ms
Test Files  1 passed (1)
Tests  6 passed (6)
```

三个用例覆盖：
1. `targetTeamId` + `recurrenceRule` 透传；DB trigger 强制三列互斥，未传列保持 null
2. `targetSessionId` 委派（独立用例，确保两个目标列都被接线）
3. 不传三列/规则时基线行为保持（向后兼容）

## Typecheck

```
> momo-studio@2.0.0 typecheck /workspace
> pnpm -r typecheck

electron typecheck: Done
renderer typecheck: Done
```

双 clean。

注：`TaskRow` 新字段（`targetTeamId` / `targetSessionId` / `recurrenceParentId`）按 brief 标记为**必填**（非 optional），与 electron `repo.ts` 对齐。3 个 renderer 测试 fixture（`MentionInput.test.tsx` / `TaskBoardView.test.tsx` / `TaskSidebarPanel.test.tsx`）的 `makeTask`/`mkTask` 工厂同步加三字段——否则 typecheck 红。该改动超出 brief 列出 4 文件，是必要的传染修正，已纳入同一 commit。

## 全量测试

- electron: 179 files / **1494 passed**
- renderer: 104 files / **942 passed**
- 零 flake，零 warning

## Self-Review Findings

- ✅ 三层扩展完整：CreateInput + insertTask 调用 + CreateTaskInput + createTask + JSON schema defs + execute() args 解析 + TaskRow + TaskApiSurface.create 全部到位
- ✅ `recurrenceParentId` 仅出现在 renderer TaskRow（输出镜像），不在 IPC 入参——与 brief 字面一致（输入用规则字符串，输出镜像续期写入的 parent id）
- ✅ 三列互斥语义保留：DB trigger `SQLITE_CONSTRAINT_TRIGGER` 拦截同时传 targetTeamId + targetSessionId；测试用例单独验证每个列，互不干扰
- ✅ JSON schema property 风格与同文件其他 property 一致（`type: 'string'` + `description`）
- ✅ IPC handler 透传沿用现有结构（`sourceSessionId` / `assigneeAgentId` 同一插入位置）
- ✅ 中文注释：版本标记 `v29` + 互斥语义（非类型可推）+ 循环规则，简短不冗余
- ✅ 无 lint 违规（无 any / as any / @ts-ignore）
- ✅ 提交 message 字面一致 brief：`feat: 任务创建入参扩展——委派目标三列 + 循环规则（IPC 与 agent 工具同步）`

## Concerns

无。

## Commit

`1f6d93f` — feat: 任务创建入参扩展——委派目标三列 + 循环规则（IPC 与 agent 工具同步）

7 files changed, 109 insertions(+)：
- `electron/src/main/task/ipc.handlers.ts` (+9)
- `electron/src/main/agent/tools/task-tools.ts` (+30)
- `renderer/src/ipc/types.d.ts` (+10)
- `electron/tests/task/ipc-handlers.test.ts` (+51)
- 3 个 renderer 测试 fixture（TaskRow 新字段传播修正，+3 each）