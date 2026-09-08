# Chat 回合意图对象（Turn Mandate）与产品文案中性化设计

- **日期**：2026-09-08
- **状态**：待评审
- **范围**：chat 会话回合边界 / compact 语义 / todo 生命周期 / 副作用软门禁 / 产品文案中性化
- **上游输入**：2026-09-08 晚任务系统测试会话（房间 `b4ae75f3`）失控复盘 + agent 运行时过度执行架构审计

---

## 0. 背景与问题定性

### 0.1 起因事件

2026-09-08 晚，用户在 chat 会话中发出唯一指令「压缩上下文」后，agent 自驱执行了约 50 次工具调用：创建 4 个真实任务（T-045~T-048）、写入 2 条跨会话长期记忆（其中 1 条含错误结论，id=4b6c58b9）、3 次自我压缩，历时约 14 分钟。全程不重复、不越工具权限、预算内——**现有机械护栏（重复检测 / 工具预算 / 分段上限 / abort）对「方向正确的过度执行」完全失明**。

### 0.2 架构审计结论（本设计的依据）

| # | 结构性发现 | 证据 |
|---|---|---|
| S1 | chat 回合没有意图对象；任务执行域有（task + `complete_task` 终态）且从不失控 | 同一会话内 8 次任务执行零失控 vs chat 一次失控 |
| S2 | 产品侧行为指令 8 处全部是前进祈使句，0 处停止/确认 | 见 §5.6 清单 |
| S3 | 三层自我授权待办链：todowrite（回合内）→ compact 总结「未完成步骤」（跨压缩）→ memory_save（跨会话） | 失控链走完全程 |
| S4 | 权限模型只有能力维度（能不能用工具），无范围维度（该不该现在做） | 4 个未授权任务仅占预算 8/50 |
| S5 | 预算只约束数量不约束适当性 | 失控段全程「合法」 |

**直接因果链**：compact 总结模板强制覆盖「未完成步骤」→ agent 把自己此前的待命提议（「如需继续测试…随时告诉我」）写成「可选后续方向」→ 压缩后三连「继续工作」指令（`runtime-entry.ts:660/676/688`）将其激活为待办 → 消息数 >30 触发系统提示「压缩…然后继续工作」（`:461`）→ 循环 ×3 → 上下文连环退化 → 工具调用丢参数 → 捏造产品 bug → 错误结论写入长期记忆。

### 0.3 设计取向（用户已拍板的三个决策）

1. **斜杠命令层**：`/compact` 由系统确定性执行，全程不经 LLM。
2. **按 mandate 判定**：agent 自压缩后，有「用户请求的未完成项」则续跑，无则确定性收口。
3. **软门禁**：持久副作用工具无法挂靠本轮用户请求时警告 + 通知，不阻断。

---

## 1. 目标与非目标

### 目标

1. 用户发起的压缩 = **100% 确定性回合终点**。
2. agent 自我管理压缩按 mandate **双态**：有用户未完成项 → 续跑（长任务不中断）；无 → 下一轮无工具，机械收口。
3. 持久副作用工具（`create_task` / `memory_save`）软门禁。
4. 8 处前进祈使句中性化 + 压缩总结模板拆分「用户指令」/「agent 备忘」。
5. todo 生命周期显式契约化：**todo = 回合内计划，生命周期严格等于回合**。

### 非目标

- 硬门禁/确认流（审计方向 C，仅留挂钩点 §9）
- 预算升维 / 副作用预算 / wall-clock 护栏（方向 D，仅留挂钩点）
- 记忆信任分级（方向 E，仅留挂钩点）
- 历史窗口收缩（`session_summaries` 截断 `getConversationContext` 的 20 条窗口——属 extraction 管线增强）
- 任务执行域（`runTaskChatLoop`）与 dispatch 子路径的 compact 行为变更（那边 mandate=task，`complete_task` 是天然终态）

---

## 2. 核心概念：Turn Mandate（本轮授权）

每条用户消息触发新回合时，由 runtime 组装的结构化上下文块：

```
## 本轮用户授权（mandate）
- 用户消息：「<本轮用户消息原文>」
- 中途补充：<本回合内 drain 的 steers 原文列表；无则省略本节>
- 用户请求的未完成项：<todoStore 现查的 pending source=user 项；无则「无」>

约束：以上是你本轮被授权完成的工作范围。「agent 备忘」类信息（你自己想到的
可选方向）不属于授权——除非用户在本轮明确要求，否则不要据此发起新工作；
需要时先向用户提出。中途补充与原始消息同等授权效力，可扩大、修改、撤销
原授权；收到改变方向或要求停止的补充时，必须先用 todowrite 同步更新
user-source 待办项（删除/改写），使待办表始终反映用户当前意图，然后再继续。
```

**关键机制**：

- **注入点**：`finalSystemContent`（`runtime-entry.ts:295` 拼接链：systemPrompt + budgetHint + dispatchHint + taskHint + pinnedMem.hint）之后追加 mandate 尾段。
- **每轮重写**：`finalSystemContent` 拆为 static 段 + mandate 段；每轮构建 LLM 请求前重写 `messages[0].content = staticSystem + buildMandateHint(current)`——保证「中途补充」与「未完成项」实时。
- **跨压缩存活**：compact 只替换历史、保留 `messages[0]`（`:655-657`）→ mandate 天然不丢。这是修复「压缩丢边界」的机制本质。
- **每条用户消息都是全新回合**：`runChatLoop` 每次从 DB 拉最近 20 条历史（`:281-306`），mandate 每回合从当轮用户消息重新派生，与历史无关。

---

## 3. 架构总览与组件改动面

| 组件 | 改动 |
|---|---|
| renderer 输入链（MentionInput 提交路径 / session.store） | `/` 前缀命令拦截；v1 白名单 `['compact']`；未知 `/xxx` 本地提示不发送；`//xxx` 转义为原样发送（防误伤斜杠开头文本） |
| `preload` + 新 IPC `session:command` | 命令通道（不走 `session:send`）；types.d.ts 双端同步 |
| 主进程命令处理（session-service 新增分支） | `/compact` 执行链，见 §5.4 |
| `runtime-entry.ts` runChatLoop | ① mandate 尾段组装与每轮重写；② compact 分支双态改造（§5.1）；③ `:461` 提示文案中性化 |
| `prompt-hints.ts` | 新增 `buildMandateHint()`；dispatchHint 限定「当前任务」语境 |
| `builtin-tools.ts` | compact / task_complete 描述重写（总结模板拆分 + 去继续类指令） |
| `todo-tools.ts` | `TodoItem.source: 'user' \| 'agent'`（缺省 `'agent'`）+ 校验 + 回显 `[u]/[a]` 标记 + 导出 `hasPendingUserTodos()` |
| `task-tools.ts` / `memory-tools.ts` | 软门禁 warning（§5.3） |
| 测试 | `electron/tests/agent/` 新增 + 既有套件回归（§7） |

---

## 4. todo 生命周期 × 用户介入（三场景裁定）

### 场景 1：同会话、回合进行中，用户插入新消息（steer）

保留 v2.3 消息滚动语义（回合不中断，`[用户中途补充]` 注入，`runtime-entry.ts:445-455`；2026-09-08 会话 19:11:24 实测工作良好）。补充规则：

1. steer 原文追加进 mandate「中途补充」节（每轮重写保证实时）。
2. **todos 是用户意图的唯一运行时镜像，agent 有同步维护义务**（mandate 约束段明示）：改变方向/要求停止的补充到达时，必须先 todowrite 更新 user-source 项再继续。

**已知软边界（明示记录）**：用户 steer「停下」但 agent 未清 todo 即压缩 → 收尾判定读到旧 user-source 项 → 误放行续跑。确定性保底 = 停止按钮（abort 链路，已存在且可靠）。机械硬边界管「授权状态」，语义撤销走提示层 + abort 兜底。

### 场景 2：用户在另一会话发消息

旧会话回合与 todo 继续运行是**正确语义**（用户未发停止指令）。隔离由现有机制保证：todo 按 streamSessionId 键控 + 不同会话回合跑在 WarmPool 分配的不同子进程（各自模块级 store），无串扰。用户想停 → 切回该会话 abort 或 steer 明示。

### 场景 3：上一回合已结束，用户发新消息（新回合）

全新 streamSessionId → 全新 todo store → 全新 mandate。**上回合 pending todos 不进入新回合的收尾判定**，仅作对话历史上下文可见。

**显式架构契约**：todo = 回合内计划，生命周期严格等于回合；跨回合持续工作的正确载体是任务域（`create_task` → scheduler → 执行会话 + `complete_task` 终态约束）。todo 永远不该成为「跨回合还在跑的东西」——现有实现按回合键控本就如此，本设计将其升格为契约。

---

## 5. 关键行为规格

### 5.1 compact 双态 + wrapUpMode（`runtime-entry.ts:634-690`）

**作用域判定**：`parentStreamSessionId == null && config.currentTaskId == null`（三态覆盖：顶层 chat 改 / 任务执行不改 / dispatch 子 agent parent 非空不改）。

```
compact(summary) 被调用（summary 校验不变：≥50 字符，过短拒绝并要求重写）
  ├─ hasPendingUserTodos(streamSessionId) = true → 续跑模式
  │    历史照旧替换为 [system, user(两节模板总结)]；
  │    压缩消息尾部指令 =「[历史已压缩。本轮仍有用户请求的未完成工作，请继续完成]」
  └─ false → 收尾模式
       a. 压缩消息尾部指令 =「[本轮用户请求已无未完成项，请输出简短总结后
          结束本轮，不要开始新工作]」
       b. 置 wrapUpMode = true → 下一轮 LLM 请求 tools = undefined
          （模型无工具可调 → 只能输出终文 → finishReason=stop → loop 机械退出；
           先例：budget ≤ 0 时同样传 undefined，`:472`）
```

**wrapUpMode 与 steer 交互**：wrapUpMode 下 drain 出新 steer → 清除 wrapUpMode、恢复工具（新指令优先于收尾）；若 steer 只是确认语（「好的」），mandate 约束段（无未完成项不发起续工作）使模型输出终文自然停——软边界，可接受。wrapUpMode 是回合级内存状态，随回合结束消亡。

### 5.2 判定函数（`todo-tools.ts` 导出）

```typescript
hasPendingUserTodos(streamSessionId): boolean
  = todoStore.get(streamSessionId)?.some(t => t.status !== 'completed' && t.source === 'user') ?? false
```

### 5.3 软门禁（`create_task` / `memory_save`）

执行成功后追加判定，沿 `NO_ASSIGNMENT_WARNING` 顶层附加模式（`{...result, warning}`，向后兼容，不阻断）：

```
if (!hasPendingUserTodos(ctx.streamSessionId)) → 附 warning：
「⚠ 本操作未挂靠到本轮用户请求（当前无 source=user 待办项）。若确属用户
  本轮请求范围，请先用 todowrite 建立对应 user 待办；若属你自行发起的工作，
  请先向用户说明并获同意。本警告不阻断操作。」
```

**dispatch 不门禁**：dispatch 是回合内同步等待操作（结果回传前 PM 不脱离本回合），越界面远小于持久化副作用。

**source 缺省 `'agent'`（保守取向）**：未标注不算 user 挂靠。权衡明示：忘标注的大任务会被 compact 提前收口（代价 = 用户多说一句「继续」），换来越界链不复活（缺省 `'user'` 等于回到现状）。todowrite 回显加 `[u]/[a]` 标记供 agent 自检自纠。

### 5.4 `/compact` 命令链

```
输入 "/compact"
→ renderer 拦截（整条消息以 '/' 开头且命中白名单；未知 /xxx 本地提示；
  //xxx 转义为 /xxx 原样发送）
→ ipc session:command { sessionId, command: 'compact' }
→ 主进程 handleSessionCommand：
   0. 查询该会话是否有运行中回合（AgentRunner 活跃表 / 车道）→ 有则拒绝：
      「会话正在执行中，请先停止或等待完成」
   1. 拉会话消息（上限 200 条）；空会话 → 拒绝：「无内容可压缩」
   2. resolveSessionLlm(sessionId)（复用 extraction 管线 LLM 解析链）
   3. LLM 生成两节模板总结（同 §5.6 #5 模板）
   4. upsert session_summaries（复用 extraction 的 SQL 语义，extraction.ts:196-205）
   5. 落确认消息（sender='owner' + body 前缀「[系统] 会话已压缩：N 条消息
      → 摘要（下轮生效）」，走既有落库/推送/P2P 广播路径，**不路由 agent**；
      沿 kickoff 先例不引入新 sender 值，零 renderer 渲染改动）
→ 下一回合经 pinned 记忆「本会话背景摘要」段注入新摘要
```

**诚实范围声明**：v2.2 现状下 `session_summaries` 是背景注入，不截断历史窗口（`getConversationContext` 仍拉最近 20 条）。v1 的 `/compact` 语义 = 「生成并常驻高质量会话摘要」。

### 5.5 mandate 组装与每轮重写

- 回合开始：mandate = `{ userBody: currentBody, steers: [] }`；steer drain 时追加。
- 每轮构建 LLM 请求前：`messages[0].content = staticSystem + buildMandateHint(mandate, todoStore 现查)`。
- compact 保留 `messages[0]` → mandate 跨压缩存活；下一轮重写自然恢复实时性。

### 5.6 方向 B：8 处文案中性化清单

| # | 位置 | 现文案问题 | 新文案要点 |
|---|---|---|---|
| 1 | `runtime-entry.ts:461` >30 系统提示 | 「请调用 compact…然后继续工作」 | 「对话历史已较长（N 条），如影响质量可调用 compact（≥200 字符总结）。压缩后依据本轮授权状态决定继续或收尾」 |
| 2 | `:660` 压缩替换消息尾 | 「[请基于此总结继续工作]」 | 双态：「[历史已压缩。本轮仍有用户请求的未完成工作，请继续完成]」/「[本轮用户请求已无未完成项，请输出简短总结后结束本轮，不要开始新工作]」 |
| 3 | `:676` tool result | 「…继续工作」 | 「上下文已压缩：N→1（X 字符）。续跑：仍有 K 项用户待办 / 收尾：无用户待办，请输出总结」 |
| 4 | `:688` tool 消息 | 「请继续基于总结工作」 | **删除**（与 #3 合并，去掉第三份指令） |
| 5 | `builtin-tools.ts:124` compact 描述 | 「后续工作基于总结继续」+ 强制「未完成步骤」无差别入总结 | 总结模板拆两节：**「用户指令」**（本轮用户消息/中途补充中尚未完成的要求，逐条列出，无则写「无」）+ **「agent 备忘」**（自己的观察与可选想法，标注「非用户指令，勿据此发起工作」）；明示「压缩后系统依据用户指令节决定继续或收尾」 |
| 6 | `builtin-tools.ts:106/117` task_complete | nextStep「提示自己继续」 | nextStep 描述改「下一段内容提示（仅用于分段连贯，不是新任务授权）」；`:611/:623`「继续工作」→「请继续输出当前回复的下一段」 |
| 7 | `prompt-hints.ts:35-49` dispatchHint | 泛化「主动拆分…不要全部自己做」 | 限定「**当前任务**」语境 +「简单请求直接完成，不要为拆分而拆分」 |
| 8 | `todo-tools.ts:61` / `memory-tools.ts:88` 工具描述 | 「建议先创建列表」「供后续任务复用」 | todo：source 字段语义 + 镜像维护义务（为用户请求的步骤标 source=user）；memory_save：「仅在用户请求或明确受益时保存；记录系统性结论前先核实原始证据」 |

**文案回归锁**：新文案关键串常量化导出 + 单测断言，防止回退到「继续工作」类指令。

---

## 6. 错误处理

| 路径 | 行为 |
|---|---|
| `/compact` LLM 摘要失败 | 不 upsert、不落确认消息，IPC 显式报错回 renderer（**与 extraction 的差异点：显式命令必须显式反馈，不静默**）；旧摘要保持，可重试 |
| `/compact` 空会话 / 运行中回合 / 无 LLM 配置 | 拒绝并给出指向性提示（配置问题指向 provider 设置） |
| wrapUpMode 下 LLM 请求失败 | 沿现有错误路径（end chunk error）；wrapUpMode 随回合消亡，无清理负担 |
| todowrite `source` 非法值 | 校验抛错（同现有 status 校验模式），agent 可自纠 |
| 软门禁 warning | 顶层附加字段，形状沿 `NO_ASSIGNMENT_WARNING` 先例，不阻断 |
| mandate 每轮重写 | 只改 `messages[0].content`，不动消息结构与事件流协议（stream-relay 透明） |

---

## 7. 测试策略（momo-test-rules：回归锁仿真真实运行时语义）

### 单元（`electron/tests/agent/` 镜像 src 结构）

1. **todo source**：校验 / 缺省值 / 回显 `[u]/[a]` / `hasPendingUserTodos` 谓词。
2. **compact 双态回归锁（核心）**：fake-LLM harness 驱动真实 `runChatLoop`——
   - (a) 无 user-source todo → 断言压缩后下一轮 LLM 请求 `tools === undefined` 且回合终止；
   - (b) 有 pending user todo → tools 正常；
   - (c) wrapUpMode 中 steer 到达 → 恢复工具；
   - (d) task 域 / dispatch 子路径 compact 行为不变（作用域判定回归）。
3. **软门禁**：无挂靠 → result 含 warning；有挂靠 → 不含。
4. **文案回归锁**：§5.6 新文案关键串断言。
5. **mandate 重写**：steer 追加后下一轮 `messages[0]` 含新补充；compact 后 mandate 段仍在。

### 既有套件回归

electron + renderer 全绿；重点：restart-consistency、dispatch 嵌套（`messages[0]` 重写不得影响事件流）。

### 真机验收剧本（macOS 主机，复刻起因会话场景）

| # | 场景 | 预期 |
|---|---|---|
| ① | chat 中说「压缩上下文」 | agent 压缩后输出确认即停，不自驱 |
| ② | 大任务中途自压缩（有 user todos） | 续跑至完成 |
| ③ | steer「停下」后压缩 | 收口 |
| ④ | `/compact` 命令 | 确认消息落库 + 下轮摘要生效 + 不触发 agent 回合 |

### renderer 单测

命令拦截：白名单命中 / 未知命令提示 / `//` 转义。

---

## 8. 兼容性

- 新 IPC `session:command`：types.d.ts 双端同步，两 workspace 同 typecheck（boundary-rules）。
- 老 agent YAML 零改动（mandate 是 runtime 注入）。
- **不设 feature flag**：越界是缺陷不是特性；「长任务忘标 source 被早收口」由 todowrite 描述引导 + 缺省保守取向兜住，不加开关减少状态分叉。
- 消息协议零变更（`/compact` 确认消息沿 owner sender + body 前缀先例）。

---

## 9. 方向 C / D / E 挂钩点（留接口不实现）

- **C（范围权限）**：软门禁判定谓词（`hasPendingUserTodos` + 挂靠引用）即未来硬门禁/确认流的插入点。
- **D（预算升维）**：mandate 尾段预留「本轮用量」节拼接位；wrapUpMode 可复用为预算软耗尽收尾模式。
- **E（记忆信任分级）**：memory_save 的 warning 即分级入口——未来 agent 源系统性结论默认低信任、不常驻注入。

---

## 10. 实施切分预览（writing-plans 输入骨架）

| 任务 | 内容 | 依赖 |
|---|---|---|
| T1 | renderer 命令层 + `session:command` IPC | — |
| T2 | 主进程 `/compact` handler | T1（配对） |
| T3 | todo `source` 字段 + `hasPendingUserTodos` | — |
| T4 | mandate 注入 + 每轮重写 | T3 |
| T5 | compact 双态 + wrapUpMode | T3, T4 |
| T6 | 软门禁 | T3 |
| T7 | B 文案 8 处（独立可先行） | — |
| T8 | 测试与回归锁 | 全部 |

---

## 11. 验收标准

1. §7 真机剧本四场景全部通过；
2. compact 双态回归锁单测通过（含 task 域 / dispatch 不变式）；
3. `grep` 全仓「继续工作」在 agent 运行时路径零残留（renderer 展示文案除外）；
4. 既有测试套件全绿 + typecheck 双 clean；
5. 起因会话重放对照：同样输入「压缩上下文」下，agent 行为终止于压缩确认。
