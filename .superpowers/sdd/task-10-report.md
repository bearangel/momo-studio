# Task 10 报告：CreateTaskDialog 目标三选 + 循环预设

## 状态

**完成**。TDD 全流程（RED → GREEN → 回归锁），renderer 全套 954 测试绿，typecheck 双 workspace clean，两个 commit 已落 `feat/task-execution-runtime`。

## 交付内容

### 1. 组件扩展 `renderer/src/components/im/CreateTaskDialog.tsx`

- **委派目标四选**：`TargetKind = 'none' | 'agent' | 'team' | 'session'` Select；按类型条件渲染联动「委派目标」Select（agent → 成员列表 / team → 团队列表 / session → 会话列表），三列互斥（未选类型的目标列提交 null）
- **循环规则四选**：`RecurrenceKind = 'once' | 'every' | 'daily' | 'weekly'` Select；every → 间隔数值 + 单位（m/h/d）；daily/weekly → 运行时间（time input）；weekly → 星期 Select（编码契约 `1=周一 … 6=周六 0=周日`，与 `recurrence.ts` WEEKDAY_LABEL 对齐）
- **提交**：`serializeRecurrence`（真实实现，非 mock）序列化后随 `ipc.task.create` 传 `recurrenceRule` + `targetTeamId`/`targetSessionId`；`assigneeAgentId` 仅在 targetKind==='agent' 时透传
- **校验**：`targetMissing`（team/session 已选类型但未选具体对象）→ 创建按钮禁用 + `handleSubmit` 双保险拦截（防 Enter 隐式提交/未来重构绕过）
- **preset 语义**：`preset.assigneeAgentId` 预填时 `targetKind` 初值置 `'agent'`（open 时 effect 内判定），保持旧预填直达体验；无 preset 默认 `'none'`（未指定·手动启动）
- **数据加载**：open 时与既有 `agent.listMembers` 并列加载 `ipc.team.list(workspaceId)` / `ipc.session.list(workspaceId)`，map 收窄为 `{id,name}` / `{id,title}` 子集
- **状态复位**：每次 open 重置全部新 state（targetKind/targetTeamId/targetSessionId/recurrenceKind/everyN/everyUnit/recTime/weekday），杜绝重开对话框脏状态

### 2. 测试 `renderer/src/components/im/CreateTaskDialog.test.tsx`

按 brief 要求扩展（既有 B7 文件保留，非空目录新建）：

- **mock 扩展**：`vi.hoisted` 结构增加 `team.list` / `session.list`；返回形状与 `Team` / `SessionSummary` 契约字段对齐（消费子集 id/name/title）
- **保留既有 5 个回归用例**（open=false 不渲染 / 核心字段渲染 / preset 预填 / 空标题禁用 / 提交回调链）——即 none 默认路径回归锁
- **brief 两个新用例**：
  1. 选团队目标 → create 携带 `targetTeamId: 'team1'` 且 `targetSessionId: null`（互斥断言，超出 brief 的 onCreated 断言——momo-test-rules「断言生产消费的字段」）
  2. 选循环每天 09:00 → create 携带 `recurrenceRule: 'daily@09:00'`
- **追加校验用例**（任务上下文建议）：团队目标未选时创建按钮禁用 → 选中后恢复（错误路径专项用例）
- **追加回归锁**（自查产出）：`preset.assigneeAgentId` 预填 → 目标类型初值 `'agent'` + 委派目标预选 + 提交透传 `assigneeAgentId`（team/session 保持 null）。**变异验证通过**：临时把 preset 判定改为 `setTargetKind('none')` → 恰好该用例红；还原后绿——证明回归锁真实咬合

### 3. 伴随修复 `renderer/src/components/task-board/TaskSidebarPanel.test.tsx`

看板侧边栏挂载真实 CreateTaskDialog，其 `window.api` mock 缺新 `team`/`session` 命名空间 → 对话框 effect 内 `Cannot read properties of undefined`。补两通道 mock（空数组，该测试不涉目标选择）+ 两个 beforeEach 补 reset。**这是 IPC 契约扩展后消费方 mock 的标准同步，非测试简化**。

## 验证证据

| 步骤 | 命令 | 结果 |
|---|---|---|
| RED | `vitest run src/components/im/CreateTaskDialog.test.tsx` | 3 failed（无「委派目标类型」/「循环规则」控件）/ 5 passed |
| GREEN（实现后） | 同上 | 8 passed |
| 变异验证 | 破坏 preset→agent 接线后跑 | 恰好新回归用例 1 failed；还原后 9 passed |
| renderer 全套 | `vitest run` | **106 files / 954 tests 全绿** |
| typecheck | 根 `pnpm typecheck` | electron + renderer 双 Done |
| ESLint | 三个改动文件 | 零输出（clean） |

## Commits

- `d4fe403` feat: 创建对话框——委派目标三选一 + 循环规则预设（组件 + 测试 + TaskSidebarPanel mock 同步）
- `a81ee2f` test: preset.assigneeAgentId 预填回归锁——目标类型初值 agent + 提交透传（变异验证过的追加用例）

## 自查结论

1. **preset 预填路径不回归** ✅ — 变异验证过的专项回归锁（初值 'agent' / 预选 / 透传三断言）
2. **none 默认路径与旧行为一致** ✅ — 既有 5 用例原样保留并通过；差异仅为预期内 UX 语义：旧行为「指派 agent Select 常驻」→ 新行为「默认未指定，需先选类型 agent」——这是 brief 明确的三选一设计（「未指定（手动启动）」），非回归
3. **UI 红线** ✅ — 全语义 token（`text-secondary`/`border-subtle`/`bg-surface-2` 等，均来自既有 Input/Select 原子件）；无 emoji 图标；无动态拼接 class；`flex gap-2` 等静态类
4. **测试保真度** ✅ — mock 只落 IPC 边界（client 模块级），`serializeRecurrence` 走真实实现；断言 create 实际载荷字段（targetTeamId/recurrenceRule/互斥列）；错误路径（未选目标禁用）有专项用例

## 备注 / 边界

- brief 测试代码按既有文件的 `vi.hoisted` mock 结构适配（brief 用工厂内 `vi.fn()` + `clearAllMocks`，语义等价）；brief 用例 1 的 `onCreated('T-001')` 断言值经 `mockResolvedValueOnce` 保留原值，不动既有用例的 `'T-100'`
- 星期编码 `(i+1) % 7` 是跨模块契约（双端 nextRun/展示对齐），已加注释防「顺手改」
- 未跑 `pnpm install`（任务约束）；未跑 electron workspace 测试（改动仅 renderer，主进程零变更）
- 本文件原为 v2.1 设计系统计划的 Task 10（Badge）报告，该计划已完结（commit f2b7c40）；按本任务指定路径覆盖
