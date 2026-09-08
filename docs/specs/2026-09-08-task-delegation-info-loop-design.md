# 任务委派信息闭环设计（agent 无指派任务死锁修复）

- **日期**：2026-09-08
- **状态**：已批准（待实施）
- **上游输入**：主机验收 bug 报告——快速会话内让 agent 委派 5 个任务，全部无指派落 draft，agent 死等「调度器指派」永不发生的事件

## 1. 问题本质

用户在单人/快速会话中要求 agent「委派 5 个任意任务」。agent 调用 `create_task` × 5，均未携带指派目标（assigneeAgentId / targetTeamId / targetSessionId），任务全部停留 draft。agent 随后宣告「等待调度器指派执行」并死等——但系统不存在该机制，任务永不执行，agent 永不苏醒（停止按钮可手动中断，无中断链路 bug）。

三层断裂，每层独立成立、共同造成死锁：

| 层 | 断裂 | 后果 |
|---|---|---|
| 信息 | agent 无工具发现可指派目标（agent 成员 / 团队 / 会话） | 想指派也不知道 ID |
| 认知 | `create_task` 工具描述谎称「不指定则由调度器决定」 | agent 以为留空没问题 |
| 反馈 | 无指派创建静默成功返回 draft | agent 不知道任务已进死局 |

系统侧现状（三重拦截，设计上故意）：scheduler 只扫有目标的 pending；`startTask` 拒绝无目标 draft（错误文案「未指派委派目标，不能启动」）；executor 遇无目标 assigned 转 failed。**拦截机制本身正确，问题是 agent 的世界模型与系统真相不对齐。**

## 2. 方案总览（A + C 组合 + 落态对齐）

四处小修复，把 agent 的世界模型对齐系统真相：

1. **描述纠偏（认知层）**——`create_task` 工具描述删除谎言、写明真相与行动指引
2. **新枚举工具（信息层）**——`list_delegation_targets` 一次返回三类可指派目标
3. **创建反馈（结果层）**——无指派创建时返回显式 `warning` 字段
4. **落态对齐（调度层）**——agent 工具 `createTask` 应用 K1 决策表 + `notifyExecutor()`，带目标任务真正进入调度

**否决的替代方案**：系统兜底自动指派（无目标任务默认派给默认 agent）——「自己委派给自己」语义怪异，且违背用户意图（draft 对人类用户有「待办草稿」的真实语义）。

## 3. 修复细节

### 3.1 修复 ①：create_task 描述纠偏

现描述（错误）：

```
assigneeAgentId: 指派 agent ID（可选；不指定则由调度器决定）
```

改为：

```
assigneeAgentId: 指派目标 agent 的 instance ID（从 list_delegation_targets 查询）。
assigneeAgentId / targetTeamId / targetSessionId 三者必须提供其一——系统没有
自动指派机制，无指派目标任务将永远停留在 draft 不会被调度执行。
```

`targetTeamId` / `targetSessionId` 描述同步补一句指向 `list_delegation_targets`。

### 3.2 修复 ②：新工具 list_delegation_targets

- **归属模块**：`TaskTools`（electron/src/main/agent/tools/task-tools.ts）——任务域工具同类聚合，无新文件
- **输入**：无参数。workspaceId 从 ToolContext 注入（防跨 workspace 泄漏，沿用 list_tasks 的收窄模式）
- **输出**（JSON，紧凑）：
  - `agents`: 当前工作空间全部 agent 成员——`instanceId` / `name` / `description`（一句话）；标记 `isSelf`（ToolContext.roomId 比对 session_members，当前会话内的成员即「自己」）
  - `teams`: 全部团队——`id` / `name` / `memberCount` / `leaderName`
  - `sessions`: 最近 20 条会话（`COALESCE(last_message_at, created_at) DESC`，null 时间戳回退建会时间）——`id` / `title` / `kind`；标记 `isCurrent`（id === roomId）
  - 各类为空时返回空数组并附提示（如「本工作空间暂无团队」）——agent 能区分「没有」与「查询失败」
- **风险面**：只读、零副作用 → 随 TaskTools 模块注册，不进权限收紧范围

### 3.3 修复 ③：create_task 无指派返回 warning

无指派目标创建成功时，返回 JSON 附加 `warning` 字段（有指派时不出现该字段）：

```
任务未指派委派目标（assigneeAgentId / targetTeamId / targetSessionId 均为空）。
系统没有自动指派机制——此任务将停留在 draft，永远不会被调度执行。
draft 任务无法用工具取消（状态机不允许），请：
1) 调用 list_delegation_targets 查看可指派目标，重新创建携带指派的新任务；
2) 告知用户在本条死任务上看板手动处理（取消或编辑指派）。
```

**为什么警告而非报错拒绝**：保留「agent 建草稿、用户稍后手动指派」的合法人类工作流；警告 + 描述修正双管足以纠正 agent 行为，硬拒绝会连带杀掉合法场景。

### 3.4 修复 ④（spec 修订补充）：agent 工具 createTask 对齐 K1 落态决策

**发现于实施计划自审**：K1 的落态决策（有目标 → assigned）只在 IPC `task:create` handler 层，repo 的 `insertTask` 不看 assignee 默认落 draft。agent 工具路径的 `createTask`（task-tools.ts）直调 repo——**即使三处修复后 agent 学会带指派创建，任务仍落 draft 无人调度，死局只是换了个形态**。闭环必须补第四点：

- agent 工具 `createTask` 应用与 IPC 层完全相同的 K1 决策表：
  - 有目标 + 无 scheduledAt → `assigned`（executor 立即评估放行）
  - 有目标 + 有 scheduledAt → `pending`（到点 scheduler 升 assigned）
  - 无目标 + 有 scheduledAt → `pending`
  - 无目标 + 无 scheduledAt → `draft`（repo 默认）
- 落 `assigned` 时调 `notifyExecutor()`（task-tools.ts 已 import，complete/fail 已用同款终态钩子）

## 4. 明确不做（YAGNI）

- ❌ 系统自动指派机制（B 方案已否）
- ❌ `update_task` 补指派工具——警告教 agent「下次创建时带指派」，死任务留给用户看板处理；补指派工具等真实需求出现再做
- ❌ agent 死等超时机制——停止按钮有效；根因（等一个不会发生的事件）被三修复消除后，死等场景本身消失

## 5. 验证

- **单测**（electron/tests/agent/tools/）：
  - `list_delegation_targets`：三类清单返回 / isSelf 与 isCurrent 标记 / workspace 收窄 / 空类目提示
  - `create_task`：无指派返回 warning 且落 draft / 有指派无 warning 字段且落 assigned（K1 决策表对齐）/ 有指派 + scheduledAt 落 pending
- **回归**：现有 task-tools 测试全绿；typecheck 双 clean

## 6. 涉及文件

| 文件 | 变更 |
|---|---|
| `electron/src/main/agent/tools/task-tools.ts` | 三处修复全部落点（描述 + 新工具 + warning） |
| `electron/tests/agent/tools/task-tools-context.test.ts` | 新增回归锁（跟随现有 task 工具上下文测试文件） |
