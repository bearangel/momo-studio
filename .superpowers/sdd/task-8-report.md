# Task 8 Report — renderer P0 数据修复（store 全生命周期 + 筛选语义 + # 菜单过滤）

## What I Implemented

修复「启动即消失」bug 家族的 renderer 数据层根因：`task.store.load` 此前只拉 draft/pending/assigned，in_progress/paused 任务进不了看板、并发徽标 active 恒为 0。语义分三层重构：

- **数据层 `task.store.ts`**：删除 `PENDING_STATUSES` 常量与 `status` 过滤，`load` 改为 `{ workspaceId, orderBy: 'created_at', limit: 500 }` 全生命周期拉取（简报 verbatim）；头注释同步改写（全生命周期语义 + `#` 菜单过滤职责移交 MentionInput）
- **看板筛选 `TaskSidebarPanel.tsx`**：模块级 `ACTIVE_STATUSES`（draft/pending/assigned/in_progress/paused，`TaskStatus` 从 `../../ipc/types` import）；`filteredTasks` 的 'all' 分支 = 活跃态集合过滤，终态（completed/failed/cancelled）仅经筛选条显式选择可见——防全量拉取后终态历史淹没列表
- **# 菜单 `MentionInput.tsx`**：`PENDING_TASK_STATUSES` 改名 `MENU_STATUSES` 并升级为**唯一过滤点**（store 不再过滤后此处从「保留作防御」反转为承载逻辑）；头注释与挂载接线注释同步语义反转
- **下游注释 `TaskBoardView.tsx`**（brief 清单外、必要传染修正）：头注释「仅 draft/pending/assigned」描述已失真，同步改为全生命周期——该文件并发徽标 `active=in_progress` 计数正是本次修复的受益方

## TDD Evidence

**RED**：先更新三个测试文件，跑简报 Step 2 命令，恰好两个预期失败：
1. `task.store.test.ts` — `load 拉全生命周期任务（不按状态过滤，limit 500）`：断言收到 `{workspaceId, status: [draft,pending,assigned]}`（旧实现仍传 status）
2. `TaskSidebarPanel.test.tsx` — `'all' 只显示活跃任务`：任务D（completed）出现在默认列表（旧 'all' 无过滤）
3. `MentionInput.test.tsx` 通过——旧代码的防御性过滤恰与新语义一致，该组测试是行为不变式的回归锁（符合简报 Step 2 只列前两文件 Expected FAIL 的预期）

**GREEN**：实现后目标测试 6 文件 / 53 用例全绿。

## 测试更新明细（零删除，只增/强化）

- `task.store.test.ts`（3 → 6 用例）：新增 `load` 语义 describe——简报 verbatim 入参断言 + 成功写入 store（含 in_progress/paused/completed 全谱 fixture）+ 失败路径（error 记录、loading 复位，momo-test-rules #3 错误路径专项）；补全字段 `mkTask` 工厂
- `TaskSidebarPanel.test.tsx`（10 → 11 用例）：新增「'all' 只显示活跃态；终态需显式选择（选 completed 显示已完成）」——seed 一条 in_progress + 一条 completed，断言默认视图只见活跃行、切 completed 后只见终态行
- `MentionInput.test.tsx`（22 用例数不变，1 例原地强化）：#T 菜单用例 fixture 从 2 条扩到 5 条（补 in_progress/paused/draft），断言菜单只放行 draft/pending/assigned——锁死 MENU_STATUSES 与 ACTIVE_STATUSES 的边界差（活跃但已启动/暂停的任务不进菜单）

## 验证

- LSP 诊断：7 个改动文件零 error
- 目标测试：`task.store + task-board/* + MentionInput` → **6 files / 53 passed**
- renderer 全量：**104 files / 946 passed**（零 flake）
- 根 typecheck：electron + renderer 双 clean
- TaskBoardView.test.tsx 未改动即全绿（预判核实：其并发断言 mock `task.list` 的**返回值**而非入参，in_progress seeds 已在 fixture 内非零）

## Commit

`5d9178b` — `fix: 看板数据层 P0——store 拉全生命周期任务，筛选/菜单语义分层`

7 files（brief 列出的 5 + 2 个必要传染：`MentionInput.test.tsx` 断言强化、`TaskBoardView.tsx` 失真注释修正），+136/−18。

## Self-Review Findings

- ✅ 无测试删除（MentionInput 用例为原地强化，断言只增不减）
- ✅ 'all' 语义变更未破坏既有筛选测试（seed 的三任务 in_progress/assigned/in_progress 均属活跃态，默认视图断言无需改动即绿）
- ✅ MentionInput 菜单仍只显示 draft/pending/assigned（5 态 fixture 边界锁）
- ✅ `TaskStatus` import 保留于 task.store.ts（`transition` 签名仍消费）
- ✅ 简报 Step 3 代码块逐字采纳（load body / ACTIVE_STATUSES / MENU_STATUSES 及注释）
- ✅ 全部注释中文、TypeScript strict（无 any / as any）

## Concerns

- `limit: 500` 截断意味着第 501 条以后的历史任务在 renderer 不可见——简报已明示此取舍（单用户桌面端量级足够），后续如需终态归档浏览再议分页。
- 'all' 默认视图不含终态是行为变更：依赖看板直查历史的用户需显式切筛选。这是 spec §8.1 的既定语义，非缺陷。
