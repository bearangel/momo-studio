# 任务回合对账门禁设计(turn reconciliation)

日期:2026-09-28 · 状态:已批准(用户 2026-09-28 口头批准)
上游:Oracle 架构咨询裁决(A′+C′ 组合,拒绝硬续跑)

## 1. 背景与根因

T-060 故障裁决(2026-09-28):任务委派到会话后,agent 在 todo②in_progress、todo③pending、
`complete_task` 0 次调用的状态下正常结束回合。三方数据各自正确,但割裂:

- 会话徽标「已完成」= 流正常结束(`AgentStreamBubble.STATUS_TEXT.done`),措辞越权暗示工作完成;
- 任务 `in_progress` = 数据真相(无人调 `complete_task`);
- todo 未清 = 真相(pending 不被现有钩子覆盖)。

现有钩子覆盖面不足:

1. `completeInProgressTodos`:只机械清 user-source in_progress;pending 不碰;
2. `buildTodoReconcileNotice`(F1):终文前只对 user-source **in_progress** 注入一次性合成条;
   pending 与「任务未关闭」都在覆盖面外。

仓库 P0 红线:自动续跑曾致「同一指令完整执行两遍」(F1 诞生背景)。

## 2. 裁决

**拒绝硬续跑(B 案)**:终止判据「todo 清零」= 优化自我报告指标,激励模型刷状态换停机
(`todowrite(completed)`+`complete_task()` 不管干没干活);cap 命中后结局与软提醒相同但
更贵且带重复执行风险。

**采用 A′+C′**:

- A′ = F1 扩展 + 入场闭合契约 + sweep 门禁;
- C′ = 纯派生徽标(不动任务状态机)+ 一键催。

## 3. 设计细则

### 3.1 F1 触发扩展(electron/runtime-entry.ts 终文前钩子)

触发条件:任务宿主回合 && task 仍 `in_progress` &&(存在 user-source in_progress **或**
pending todo,或本回合 complete_task/fail_task 未调用)→ 注入一次合成条。仍一次性防循环。

### 3.2 措辞模板(双逃生门,共享常量单点)

```
[系统] 回合收尾核对(非新任务请求):任务 {id} 仍处于 in_progress,待办存在未清项:
{未清项列表(仅未清项+当前状态)}
请二选一:
(a) 完成剩余项,调用 todowrite 如实更新,并调用 complete_task 关闭任务;
(b) 确认剩余项不应/不能现在完成:调用 todowrite 如实更新状态,在终文中说明原因,
    任务保持 in_progress 留待用户处理。
严禁重复执行已完成的事项。本提醒一次性,不会再触发。
```

模板文本在 electron(runtime-entry)与 renderer(一键催)双侧镜像 + 同步测试锁
(先例:board-columns 双镜像 TS6059 裁决)。

### 3.3 入场闭合契约(委派简报注入模板)

任务简报注入会话时追加:「本回合由任务简报触发;结束时必须调用 complete_task 或
fail_task 关闭任务,或在终文中说明原因。」——预防优于出口补救(T-060 的 0 次调用
说明模型不知道闭合是义务)。

### 3.4 sweep 门控

任务宿主回合 && 任务未关闭时,跳过 `completeInProgressTodos` 机械清 in_progress——
「终文即交付」前提在任务未关闭时不成立,此时机械清会制造「todo 说完成/任务说没完成」
的四态割裂。

### 3.5 派生徽标「待收尾」(renderer,纯状态推导)

任务 `in_progress` && 宿主会话无运行回合(重启后仅凭 in_progress)→ 琥珀色
「待收尾」徽标。**不依赖 hook 事件**——覆盖强停路径(F1/sweep 均不跑的盲区)。
色值唯一来源 `lib/task-status.ts`(新增 tone 映射)。

### 3.6 一键催(renderer)

任务详情动作区「催收尾」按钮 = 向宿主会话注入 3.2 同一模板文本(走既有消息通道)。

### 3.7 会话徽标措辞

`STATUS_TEXT.done: '已完成' → '已回复'`。词汇专用原则:「完成」全系统保留给任务
状态机;流式传输词汇不得渲染完成语义。

## 4. 状态机权威裁定

- task 是 UI/面板唯一权威;todo 是 agent 工作区簿记(advisory);
- 钩子只「敦促对齐 + 呈现分歧」,永不机械互写(既有 sweep 是唯一例外,现加门控);
- `complete_task`/`fail_task` 是唯一指定的闭合言语行为(agent 写),用户手动关闭是终局权威。

## 5. 回归锁清单

1. F1 扩展触发(pending + 任务未关闭);
2. 一次性防循环;
3. sweep 门控(任务 open → 不清 in_progress);
4. 强停路径徽标仍派生(纯状态推导);
5. 催按钮与 F1 模板文本同步(镜像测试);
6. 入场契约出现在委派注入的简报中。

## 6. 前置确认

任务宿主回合的 turn context 是否已带 taskId(P3 #T 端到端;缺则为本设计前置小改)。
