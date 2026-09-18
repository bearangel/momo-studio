# 会话卫生批次设计（F8 / F9 / F11 / F14）

- 日期：2026-09-18
- 状态：已实施
- 上游：2026-09-18 待办列表测试会话分析（14 项发现中的 4 项产品级遗留）
- 关联：`docs/specs/2026-09-08-turn-mandate-compact-boundary-design.md`（mandate 语义）

## 1. F8 workspace 卫生约定：`.momo-scratch/` 临时区

**问题**：测试/演示产物直接写进真实项目根（`docs/`、`scripts/`、`todos/`）；并行子 agent 共享同一 workspace，仅靠 PM 人工分配文件名避冲突，无系统级约定。

**决策**：约定层（prompt 注入），不做沙箱强制隔离。理由：子 agent 共享 workspace 是协作语义本身（PM 需要核验子 agent 产物），强制隔离会破坏协作；实测根因是「无人告诉 agent 别往项目根写一次性产物」。

- 一次性/测试/演示产物一律写 `.momo-scratch/<任务名>/` 子目录；正式交付物才进项目目录。
- `formatWorkspaceHygieneHint()` 注入全部 agent 的 staticSystem（两行约定，token 成本可忽略）。
- `formatDispatchHint()` 补一行：委派测试类任务时在任务描述中指定 scratch 子目录（并行子 agent 不相互踩踏）。

**不做**：自动清理（删文件风险 > 收益）；目录存在性预建（写时 mkdir 即可）。

## 2. F9 todo 身份与聚合

### 2a. 稳定 ID（subject 归一延续）

**问题**：todowrite 全量替换协议下每次调用重新生成全部 id——逐项身份跨重写不可追踪。

**决策**：协议不变（LLM 面契约零变化），执行层按归一 subject（trim）匹配既有条目延续 id：同 subject 保 id、新 subject 新 id、同批重复 subject 仅首个延续。subject 改写视为新条目（无重命名语义——与 Claude Code todowrite 同款取舍）。

### 2b. 跨轮延续：明确不做自动携带

**决策**：新用户消息（新 streamSessionId）不从上一轮携带未完成待办。理由：mandate 按 轮授权（spec §5.1），自动携带会把上一轮的旧授权注入新轮 mandate——正是 mandate 死锁（F1，同请求双倍执行）的诱因形态。连续性由 2c 的聚合视图承担（用户/agent 可见历史各轮清单）；未来如需「继续上次任务」语义，应走显式指令（如 /continue 命令重播种），不走隐式携带。

### 2c. 会话 todo 聚合视图（renderer）

**问题**：各 agent（PM + 子 agent）的清单分散在各自消息流里，无会话级总览；PM 只能手工汇总回执。

**决策**：纯 renderer 聚合（零新 IPC——事件本就全量到达 renderer）：

- 纯函数 `collectSessionTodos(messages, streams)`：按会话消息序提取每个「有 todo 状态的流」的当前清单（末值胜出），产出 `{messageId, agentName, isSubAgent, todos}[]`。
- `SessionTodosPanel`：会话主区消息列表上方挂载，无清单时整体隐藏；遵守 v2.1 设计系统（语义 token / lucide 16px stroke 1.75 / 原子组件 / 禁 emoji 图标与硬编码色）。

## 3. F11 导出时间跨度

**问题**：agent 消息时间戳 = 回合开始（与用户消息同秒），实际跨度可达数分钟——导出时间轴失真。

**决策**：导出侧呈现起止区间。handler 从消息 events 末条 `createdAt` 计算 `endedAt` 传入 ExportMessage；渲染为 `开始 ~ 结束（跨 N分N秒）`（仅 endedAt 存在且晚于开始时）。用户消息（无 events）不变。实时 UI 不动（气泡相对时间语义自洽）。

## 4. F14 记忆时效

**问题**：记忆声称的事实源不存在（`design/color-tokens.json` 案例）——记忆无校验/过期机制，错误事实被持久化并反复注入。

**决策**：两端轻量标注，不做自动过期删除（记忆主权在用户，工具已有 memory_forget）：

- **注入端**：`buildPinnedView` 对超过 7 天未更新的常驻条目追加 `（保存于 N 天前，使用前请核实）`——agent 每轮看到陈旧度，自然驱动核实。`PinnedParts` 增 `now`（显式传入，保持纯函数可测）。
- **保存端**：`memory_save` 工具描述补教学——事实类记忆（路径/存在性断言）写入前先用工具核实，并在内容中注明核实日期。

## 5. 验收

- 每项均带回归锁（详见各测试文件）；批次收口跑双 workspace typecheck + lint + 全量测试。
