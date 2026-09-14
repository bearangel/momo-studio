# 浏览器接管优雅等待设计（驻留等待 + 空闲自愈 + 释放提示卡）

- 日期：2026-09-14
- 状态：待评审
- 范围：electron 主进程 `browser/`（manager/policy/settings 接线）+ renderer 新增一张提示卡；不动 IPC 既有通道签名、不动 runtime 子进程
- 上游讨论：2026-09-14 会话（用户案例：投资分析任务中被误触接管，agent 两次重试失败后放弃任务）

## 1. 背景与问题

### 1.1 案例

agent 执行「黄金价格分析」任务，调用 `browser_navigate`；用户误触点击内嵌浏览器页面 → 单页仲裁切到 user 态 → 工具立即失败（`浏览器被用户接管，等待释放后重试`）。模型按文案指引「稍等后重试」——但运行时不存在等待原语，立即重试再次失败，模型理性放弃任务。

### 1.2 根因链（代码坐标）

| 环节 | 现状 | 坐标 |
|---|---|---|
| 接管触发 | 页内点击/输入即接管，修饰键是唯一防线，无防抖 | `manager.ts:756-765`（before-input-event）、`view-factory.ts`（overlay mousedown） |
| 工具门控 | takeover='user' 态下 `browser_*` 全部**立即抛** `BrowserTakenOverError` | `manager.ts:581-583`（assertAgentSide） |
| 释放 | 仅显式（侧栏按钮），**v1 无自动回切**；释放事件对 agent 不可见 | `manager.ts:473-479` |
| 错误文案 | 「等待释放后重试」承诺了不存在的能力 | `errors.ts:62-65` |
| 模型侧 | 无 sleep/wait 原语；错误以 `工具执行失败: <文案>` 回给 LLM | `runtime-entry.ts:1274-1275` |

**核心矛盾**：设计意图（`manager.ts:473`「agent 收到 TakenOver 错误自决等待/改道」）假设 agent 能等待——运行时没有给过这个能力。

### 1.3 可复用的成熟模式

- **信任等待先例**（`policy.ts:110-149`）：单飞阻塞等待 + notice 前置 + 超时兜底 + 迟到应答 no-op + IPC 故障清理——本设计的 `waitForAgentSide` 与其同构；
- **子进程桥透明性**：browser 工具经 IPC 桥调用主进程 manager（`browser-tools.ts:36-46` 端口注释），park 发生在主进程内对子进程只是「invoke 挂久一点」，child 侧零改动；用户中断走既有 v1.5.2 干净退出（`runtime-entry.ts:1261-1272`），主进程等待有超时兜底不悬挂；
- **notice 通道与卡片**：`browser:notice`（kind+text+workspaceId）+ `BrowserTrustNotice.tsx`（agent 工具挂起等用户应答的卡片先例）；
- **既有释放按钮**：`TakeoverIndicator.tsx` / `BrowserSidebar.tsx:245`（`browser:releaseTakeover`）。

## 2. 目标 / 非目标

**目标**

1. 误触接管后：agent 挂起等待而非放弃；用户点击释放（或提示卡一键释放）→ 工具自动继续，任务无感恢复。
2. 误触且用户离开：空闲超时自动回切，任务自愈。
3. 用户真在用浏览器：不被打扰、不被抢——agent 有界等待超时后拿到**诚实且可行动**的错误（指引改道 webfetch 等），任务不闷死。
4. 全程双向可见：用户知道 agent 在等（卡片），agent 知道为什么被挡（错误语义）。

**非目标**

- 不改接管的三个入口与判定灵敏度（误触防抖/单击阈值——仲裁安全优先，自愈已覆盖误触后果）；
- 不做 OS 级系统通知（窗口失焦 escalate，记路线图，默认不做）；
- 不改工具描述（驻留后「立即重试」问题不复存在，超时错误文案自带指引）；
- 不动子进程 runtime / IPC 桥 / 工具层端口签名。

## 3. 设计总览

三件套，全部落在主进程 `BrowserManager` + 一张 renderer 卡片：

```
工具调用(navigate…) ──► gateAgentSide(ws)
                          │ takeover='agent' → 直接过（零开销快路径）
                          │ takeover='user'  → 驻留等待（单飞）：
                          │    ├─ 推 notice 'agent-waiting-release'（一次）→ renderer 弹提示卡
                          │    ├─ 等三件事之一：releaseTakeover / 空闲自愈 / 超时
                          │    │    release ──► 全体 waiter 放行 → 原操作继续
                          │    │    空闲自愈 ─► lastUserInputAt 距今 ≥ idleMs 且 agent 在等
                          │    │                 → 自动 releaseTakeover（同上放行）
                           │    │    超时(默认120s) ─► 抛 BrowserTakenOverError（诚实文案）
                          │    └─ ws 切走/浏览器关闭 → 清 waiter（防悬挂）
```

## 4. 详细设计

### 4.1 驻留等待（BrowserManager）

- `assertAgentSide` 保留为纯判定；新增 **`gateAgentSide(ws): Promise<void>`**，原 assertAgentSide 的全部 agent 调用点（navigate / tabsAction / evaluate / requireCurrentTab 动作原语族）改为 `await this.gateAgentSide(ws)`：
  - agent 态 → 立即返回（快路径零开销，高频路径不降级）；
  - user 态 → 进入单飞等待（同 ws 并发工具 join 同一等待，只推一次 notice——对齐 trust 等待并发语义）；
  - 等待循环以 1s tick 驱动（`setInterval` + `unref`），每 tick 检查：已释放 → resolve；`Date.now() - lastUserInputAt ≥ idleAutoReleaseMs` → 调 `releaseTakeover`（自愈放行）；`Date.now() - parkStartedAt ≥ agentWaitMs` → reject `BrowserTakenOverError`（超时文案见 §4.5）；
  - 循环内每次释放后复查 `takeover`（防「释放瞬间又被接管」竞态：复查仍 user 则继续等，直至超时——deadline 语义）；
  - 清理路径：`closeBrowser` / `onWorkspaceDeactivated` / `disposeAll` 中清空该 ws 的 waiter（resolve——让挂着的调用按空视图/新仲裁态自然走后续门控，不悬挂 Promise）。
- **waiter 状态**：`Map<wsId, { promise, startedAt, timer }>`（模块内私有；与 policy.trustWaiters 同款生命周期纪律：notice 前置发出、推送抛错同步清理 entry）。
- 常量默认值：`AGENT_WAIT_MS = 120_000`、`IDLE_AUTO_RELEASE_MS = 90_000`（均可经 settings 覆盖，见 §4.4；`0` = 关闭该能力——等待关闭即回到今天的 fail-fast，向后兼容开关）。wait 缺省取 120s 而非 60s：保证大于 idle 缺省 90s（自愈可达性不变式，见 §4.2；终审 I1 裁定，v35 未发布零成本改缺省）。

### 4.2 空闲自愈口径

- `ActiveWorkspace` 新增 `lastUserInputAt: number`（初始 = 激活时刻）。
- 刷新点（全覆盖用户真实输入，排除 agent 自身）：`before-input-event` 非自锁命中（含 user 态持续输入——现监听器对所有态触发，user 态下刷新时刻即可）、overlay mousedown（view-factory → manager.userTakeover 路径顺带刷新）、`userNavigate`（地址栏回车）、显式按钮 `userTakeover`。
- **只在「agent 正在等待」时判定自愈**：无 waiter 挂起时绝不自动回切（用户长时间阅读不被打扰）；有 waiter 时以 lastUserInputAt 判定，正在操作的用户持续刷新计时，不会被抢。
- 自愈动作复用 `releaseTakeover`（单一出口：状态翻转 + emitState + waiter 放行 + 卡片自动卸载）。
- **可达性不变式**：自愈先于超时可达要求 `idleAutoReleaseMs < agentWaitMs`（缺省 90s < 120s 满足）。若配置使 idle ≥ wait：旗舰场景（误触时刻 T0、park 起点 T0+δ、δ<wait-idle）下 timeout 先触发、waiter 消散，「无 waiter 绝不回切」使控制权停在 user 态——自愈事实不可达（终审 I1 的缺省依据）。

### 4.3 释放提示卡（renderer）

- 主进程 park 进入时推 `pushNotice('agent-waiting-release', 'agent 正在等待浏览器控制权——点击「释放并继续」恢复任务，或稍候自动恢复', wsId)`（单飞：仅 waiter 创建时一次）。**载荷携带可选字段 `durationMs`（= 本轮 agentWaitMs 实际生效值）**——超时出口下 takeover 仍为 user 态、state 不会翻转，卡片本地计时必须由主进程下发时长，避免 renderer 侧硬编码默认值与 settings 覆盖值漂移。
- renderer 新增 `BrowserWaitReleaseNotice.tsx`（克隆 `BrowserTrustNotice.tsx` 交互形态）：
  - 挂载：收到 `kind='agent-waiting-release'` notice（按 workspaceId 路由，同 trust 卡 M7 语义）；
  - 卸载（三出口全覆盖）：订阅 `browser:state`，`takeover === 'agent'` 即卸载（手动释放与空闲自愈）；本地 `durationMs` 定时器兜底卸载（超时出口，防孤儿卡）；ws 切换即卸载；
  - 动作：单一按钮「释放并继续」→ `ipc.browser.releaseTakeover(workspaceId)`（既有通道，零新 IPC）。
- 卡片遵循 v2.1 设计系统（语义 token / lucide 图标 / 原子组件），与信任卡同栈展示。

### 4.4 设置项

- 新增全局 settings key：`browserAgentWaitMs`（默认 120000，`0`=不等待）、`browserIdleAutoReleaseMs`（默认 90000，`0`=关闭自愈）。
- manager 构造注入读取器（`readAgentWaitMs?: () => number`，boot 接线读 settings-store——与 `readSidebarCollapsed` 同款注入模式），每 tick 重读（设置即时生效，无需重启）。
- 设置页 UI 控件**本期不做**（key 已生效，可用 dev 手段调；UI 暴露记 follow-up，避免扩大 renderer 范围）。

### 4.5 超时错误文案（诚实化）

`BrowserTakenOverError` 超时出口使用新文案（错误 kind 不变，消息替换）：

```
浏览器被用户接管，已等待 {N} 秒未释放。用户可点击浏览器侧栏/提示卡上的「释放」按钮；
你也可以改用 webfetch 等非浏览器方式继续当前任务，稍后再回到浏览器操作。
```

立即失败仅在 `browserAgentWaitMs=0` 时出现，沿用此文案（把「已等待 N 秒」段替换为「等待已关闭」）。

## 5. 契约影响评估（boundary-rules 自查）

- `browser:notice` 新增 kind `'agent-waiting-release'` + 载荷可选字段 `durationMs`：**均为加法**（可选字段旧消费者无感）；生产者 manager / 消费者新卡片组件**同 PR 成对交付** + 契约测试锁 kind 字符串与载荷形状（既有 `BrowserNotice` 类型追加可选字段，不改已有字段语义）。
- `BrowserState` 不改（卡片复用 takeover 字段驱动卸载）。
- 工具层端口（BrowserManagerPort）/ IPC 桥 / 子进程 runtime：**零改动**（park 对桥透明）。
- settings 新 key：生产者 settings-store 默认值，消费者 manager 注入读取——两端同 PR。
- 一义一名：`gateAgentSide`（带等待的门）vs `assertAgentSide`（纯判定）显式分名；waiter/notice 命名对齐 trust 先例（`agent-waiting-release` vs `trust-request`）。

## 6. 测试矩阵

1. **manager 驻留**：user 态 navigate → 不立即抛、park；`releaseTakeover` → 放行且导航成功返回。
2. **超时**：park 超过 agentWaitMs（测试注入小值）→ `BrowserTakenOverError`，文案含「已等待」与 webfetch 指引。
3. **并发 join 单飞**：两个工具并发被挡 → 只推一次 notice，release 后两个都放行。
4. **释放-再接管竞态**：release 后立即再 takeover → 等待继续直至超时（deadline 语义）。
5. **空闲自愈**：park 中把 lastUserInputAt 拨到过期（测试注入/等待小值）→ 自动 release + 放行；park 中持续模拟用户输入刷新计时 → 不自愈，走向超时。
6. **不打扰原则**：无 waiter 挂起时 lastUserInputAt 过期 → 状态保持 user（绝不自动回切）。
7. **清理**：park 中 closeBrowser / 切走 ws → waiter 清空不悬挂（Promise settle，后续门控自然接管）。
8. **快路径零回归**：agent 态工具调用行为与今天逐字节一致（既有 browser manager 测试全绿即锁）。
9. **renderer 卡片**：notice 挂载 / `takeover='agent'` 卸载 / 本地超时卸载 / 按钮 → `releaseTakeover(wsId)`（对齐 BrowserSidebar.test 模式）。
10. **桥形态冒烟**：runtime-browser-bridge-wiring 形态下 navigate 在 user 态挂起（不立即回错误）——park 跨 IPC 透明性锁。

## 7. 风险与取舍

- **等待占用调用位**：park 期间工具调用挂起（最多 120s）。与 bash/dispatch 长调用同类，无 per-tool 超时约束；lane/预算/steer 均不受影响（同进程事件循环不阻塞）。
- **自愈误判**：用户正在**阅读**（无输入）+ agent 恰好被挡 → 90s 后控制权被回切。阅读者不产生输入与离开者不可区分；取保守值 90s 且仅在有 waiter（agent 明确需要）时触发。真在细读的用户可用显式按钮重新接管（一次点击，成本对称）。
- **v1 仲裁哲学变更**：spec「无自动回切」是有意取舍；本设计把回切条件收紧到「agent 被阻塞 + 用户无输入 N 秒」，默认开启但可 `browserIdleAutoReleaseMs=0` 关闭回到 v1 行为。
- **多 ws**：waiter 按 wsId 键控，park 期间切走 ws → 清理放行（不跨 ws 等待）。

## 8. 里程碑

- **M1（主进程）**：gateAgentSide + 空闲自愈 + 设置注入 + 超时文案 + manager 测试 1-8。
- **M2（renderer）**：提示卡 + notice kind 接线 + 契约测试 + 卡片测试 9。
- **M3（收尾）**：桥冒烟 10 + 双 typecheck + 全量测试 + CHANGELOG 账本（不动版本号）。
