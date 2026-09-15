# 浏览器 tab 归属制与隐藏/销毁分离设计（browser tab ownership & hide-vs-destroy）

- 日期：2026-09-15
- 状态：已获用户认可（brainstorm 对话定稿）
- 上游：`2026-09-11` 浏览器域设计（单页共享仲裁模型）在此之上演进；`ebc0179`（折叠期间 agent 导航自动展开）语义被本文 §7.3 收窄替代

## 1. 背景与问题

同工作区多会话场景下两个用户实测痛点：

**P1 · tab 抢占**：A 会话 agent 打开百度，B 会话 agent 打开 bing——两者加载进同一个 tab（`ws.tabs[ws.current]`），互相覆盖。根因：浏览器域零会话概念，12 个工具全部只传 `workspaceId`，「当前 tab」是工作区全局单点。

**P2 · 折叠即销毁 + 被劫持**：折叠按钮语义是 `destroyTabs`（销毁全部视图），agent 在途操作直接 `BrowserNoViewError`；agent 后续 navigate 又强制自动展开（ebc0179 机制）——用户「收不起也关不掉」，新会话不需要浏览器却被共享侧栏绑架。

## 2. 目标 / 非目标

**目标**

1. 每个 agent 在共享侧栏内拥有专属 tab 集合（独立光标），多 agent 并存互不踩踏
2. 收起 = 纯视觉隐藏（视图后台存活，agent 操作零影响）；销毁成为显式独立动作
3. 侧栏可见性按会话独立记忆；新会话默认收起
4. agent 导航只在「其所属会话 == 活跃会话」时自动展开并切到它的 tab

**非目标（本期不做）**

- 跨工作区并发视图（workspace 切换仍销毁旧 ws 视图——单活跃 ws 约束不动）
- per-tab 接管仲裁（takeover 维持工作区级，见 §8）
- tab 跨重启持久化（现状本就不持久，可见性内存态与之一致）
- 视觉规格升级（徽标用现有 token / lucide 体系，无新设计语言）

## 3. 核心模型（三转变）

| 维度 | 现状 | 目标 |
|---|---|---|
| tab 归属 | 无主，工作区全局单 current | `owner = agent实例ID \| 'user'`，每归属方独立光标 |
| 收起 | 销毁视图 + collapseStash 重建 | bounds 置零隐藏，视图存活 |
| 可见性 | per-workspace 落库（collapsed 列） | per-session 内存态，新会话默认收起 |

## 4. 数据模型

### 4.1 主进程（manager.ts）

```ts
interface TabRecord {
  view: ManagedView;
  serial: number;
  owner: string;            // 新增：agent 实例 ID 或 'user'
}

interface ActiveWorkspace {
  // ... 现有字段
  current: number;                    // 语义收窄：可见 tab（用户视角），不再被 agent 工具消费
  ownerCurrent: Map<string, number>;  // 新增：归属方 → 该方 current tab 的全局下标
  viewsHidden: boolean;               // 新增：侧栏隐藏期视图 bounds 全零标志
  // 退役：collapsed、collapseStash（§7.4）
}
```

### 4.2 共享类型（browser/types.ts）

```ts
export interface TabInfo {
  index: number;      // 调用方作用域下标（见 §6.2：agent=自己集合内 0..n-1，user=全局）
  url: string;
  title: string;
  owner: string;      // 新增：agent 实例 ID 或 'user'——renderer 据此渲染徽标
}

export interface BrowserState {
  // ... 现有字段
  // 退役：collapsed
  expandHint: boolean;         // 新增：本帧推送由「活跃会话的 agent 导航」触发——renderer 见 true 且本会话隐藏则展开
}
```

owner → 名称/颜色的映射由 renderer agentStore 解析（主进程不持 agent 名，保持 identity-dumb）。

## 5. 身份透传（momo-boundary：契约两端同 commit）

### 5.1 ToolContext（agent/tools/types.ts）

> **勘误（2026-09-15 主机验收后）**：§4/§5 原定 `ownerId = agent 实例 ID`。实测「快速会话共用 workspace 默认 agent 实例」场景下两会话同实例 → 同 ownerId → 抢占复发。修正为 **会话作用域复合键 `ownerId = ${roomId}:${agentInstanceId}`**（装配点 browser-tools.ts；roomId 空=后台任务退化为纯实例键；无 agent 身份归 'user'）。manager 对 ownerId 不透明零改动；renderer 徽标按首个 ':' 后段解析 instanceId（`parseOwnerAgentId`）。回归锁：`browser-owner-session-scope.test.ts`（四用例）+ BrowserSidebar 复合解析用例。

```ts
export interface ToolContext {
  // ... 现有字段
  agentInstanceId?: string;  // 新增：AgentRunner 现有实例标识（agentAssignmentId 字段）沿线注入；
                             // 缺省（无 runner 的测试路径）归一为 'user'
}
```

sessionId 复用现有 `ctx.roomId`（v2 语义即 session id，stream-chunk.ts 注释已锚定）。

### 5.2 op-protocol（browser/op-protocol.ts）

`BrowserOpArgs` 全部 12 个 manager 类 op 追加尾参 `BrowserOpCtx`：

```ts
export interface BrowserOpCtx {
  ownerId: string;    // ctx.agentInstanceId ?? 'user'
  sessionId: string;  // ctx.roomId
}
```

桥（browser-ipc-bridge.ts）与主路由（op-router.ts）两端同步；`assertAllowed` / `assertEvaluate` 策略门不带 ctx（信任与 evaluate 均为 ws 级，不受归属影响）。

### 5.3 用户路径（ipc.handlers.ts）

用户 IPC 入口（userNavigate / openTab / switchTab / closeTab 等）固定 `ownerId='user'`、无 sessionId。与 agent 路径在 manager 方法签名上合流：

```ts
async navigate(wsId: string, rawUrl: string, ctx: BrowserOpCtx = { ownerId: 'user', sessionId: '' }): Promise<{ url: string; title: string }>;
```

### 5.4 活跃会话上报（新增 IPC）

`browser:setActiveSession(sessionId: string | null)`——renderer 在 activeSessionId 变化时上报（含启动后首次，模式同 `setSidebarBounds` 的 renderer→main 主动上报）。主进程缓存为自动展开判定输入（§7.3）。空（files/agents 等非会话视图）传 null。

## 6. 主进程行为规格

### 6.1 工具解析规则（12 工具统一）

- **navigate(wsId, url, ctx)**：gate → 策略 → 解析 `ownerCurrent[ctx.ownerId]`；无则建专属 tab 并设为该方 current → 加载。**不再触碰 `ws.current`**（可见 tab 仅由 §7.3 自动切换与用户显式切换改变）
- **视图类（snapshot / click / type / pressKey / hover / scroll / evaluate / consoleMessages / screenshot）**：`requireCurrentTab` 改为按 ctx.ownerId 解析该方 current tab
- **tabsAction（agent 源）**：
  - `list`：仅返回该 owner 的 tab，`index` 为其集合内 0..n-1
  - `open`：建 tab 归该 owner，其光标移过去
  - `close`：集合内下标关自己 tab；**关光自己最后一个 tab = 该方集合清空**（不再触发关浏览器）；随后该方 navigate 自动重建首 tab（ensureLive 语义保留于此）
  - `switch`：集合内下标，仅移动该方光标（不改可见 tab）
- **tabsAction（user 源）**：`index` 为全局下标，switch 改 `ws.current` + applyLastRect（现状）；close 关最后一个 tab 仍 = 关闭浏览器（§6.4）
- **LLM 语义**：`browser_tabs` 工具描述同步修订——「返回并操作你自己打开的标签页」

### 6.2 可见 tab（ws.current）

- bounds 仅施加于 `ws.current` 指向的视图（现状不变）
- 非可见的存活视图 bounds 全零（现状不变），快照/操作照常（webContents 不依赖 view bounds）

### 6.3 隐藏 / 显示

- **新 IPC `browser:setSidebarVisible(wsId, visible)`**：
  - `visible=false`：`viewsHidden=true`，全部视图 `setBounds(0,0,0,0)`，**不销毁**
  - `visible=true`：`viewsHidden=false`，`applyLastRect(ws)` 恢复可见 tab bounds；renderer 侧占位区 effect 重挂后自然重报真实 rect
- renderer rail 模式（隐藏态）过渡帧上报零 rect 一次（对齐既有卸载零报语义），此后不再上报
- 隐藏期 agent 导航/操作零影响（§6.1 规则与 viewsHidden 正交；`applyLastRect` 在 viewsHidden 时 no-op）

### 6.4 关闭浏览器（销毁语义）

- **agent `browser_close`**：仅销毁自己 owner 的 tab（集合清空 + 清自己 `ownerCurrent` 条目）；其他归属 tab 不受影响
- **用户关闭**（chrome 区「关闭浏览器」入口）：
  - 无 agent 拥有 tab → 直接销毁全部（现状语义）
  - 有 agent 拥有 tab → renderer 先弹居中确认卡（CenterPromptLayer，§8 设计系统两级提示），确认后带 `force` 销毁全部
- **全局销毁时**（用户直接/force 关、ws 切换）：`ownerCurrent` 全清、takeover 复位 agent、`stashedTabs` 清、`settleAgentWait(wsId, true)`（现状 §7 语义，仅归全局销毁所有——agent 集合清空不重置 ws 级仲裁、不 settle）
- **唯一 tab 关闭 = 关闭浏览器**的旧规则随归属制退役：agent 关自己最后一个 tab 只是集合清空；user 关全局最后一个 tab 触发关闭浏览器

### 6.5 workspace 生命周期（不动）

- `onWorkspaceDeactivated`：销毁视图 + 活清单存 `stashedTabs`（跨 ws 恢复，现状保留）
- `onWorkspaceActivated`：按 `stashedTabs` 重建；**不再读落库 collapsed**（§7.4 退役）

## 7. 与 ebc0179 / 折叠链路的关系

### 7.1 折叠销毁链路退役清单

| 退役项 | 原因 |
|---|---|
| `setSidebarCollapsed` IPC + manager 方法 | 收起改走 `setSidebarVisible` |
| `ActiveWorkspace.collapsed` / `collapseStash` | 隐藏不销毁，无 stash 需求 |
| `readSidebarCollapsed` 注入 + 激活投影 | 落库折叠真相源随可见性会话化失去意义 |
| `ensureLive` 的折叠复活分支 | 隐藏期视图本就存活；仅保留「owner 无 tab → navigate 建首 tab」的懒建语义 |

`ensureLive` 收敛为单一职责：保证调用方 owner 的 current tab 存在（无则建），不再承担折叠恢复。

### 7.2 2026-09-15 回归锁处置

`manager-collapsed-navigate.test.ts`（ensureLive 清 collapsed 修复）随 `collapsed` 字段退役而**改写**为等价行为锁：隐藏态（viewsHidden=true）+ owner 无 tab → navigate 建专属 tab + 推送 `expandHint`（活跃会话时）——回归意图（agent 活动不被 UI 态阻断且正确通告 renderer）不变。

### 7.3 自动展开规则（替代 ebc0179 无条件展开）

`navigate`（agent 源）成功后：

```
if (ctx.sessionId === 缓存的 activeSessionId && activeSessionId !== null) {
  ws.current = 该 owner 的 current tab;   // 切可见；viewsHidden=false 时 applyLastRect 立即施加，
                                          // viewsHidden=true 时 bounds 维持全零、仅记录 ws.current（显示时 §6.3 恢复）
  emitState({ expandHint: true });
} else {
  emitState({ expandHint: false });        // 不动 ws.current，不打扰
}
```

renderer 收到 `expandHint=true` 且本会话可见性为隐藏 → 展开侧栏（占位区重挂 → rect 重报 → bounds 恢复）。非活跃会话的 agent 导航对 renderer 零打扰（P2 根治）。

### 7.4 持久化清理

`workspace_settings` 的 `browser_sidebar_collapsed` 列停读停写（列保留不删，避免无谓 migration；下次触碰该表的功能再清理）。

## 8. Takeover 粒度（本期裁定）

维持**工作区级**：用户接管任一 tab → 全部 agent 工具 park（`gateAgentSide` 现状）。已知边缘：用户操作 A 的 tab 时 B 的 agent 短暂等待——可接受。理由：park / 单飞 notice / 空闲自愈三套机制均按 ws 键控，per-tab 化牵动面大而本期收益边际。后续迭代再评估。

## 9. Renderer 规格

### 9.1 可见性 store（新，内存态）

```ts
// renderer/src/stores/browser-visibility.store.ts
{ visibilityBySession: Record<string, boolean> }   // sessionId → 展开？
```

- 缺省（新会话）：`false`（收起）
- 切会话即切可见性；BrowserSidebar 消费 activeSessionId 查表
- 会话删除时清理条目；不持久化

### 9.2 BrowserSidebar 改造

- 折叠按钮 → `setSidebarVisible(wsId, false)`（原 `setSidebarCollapsed` 调用点替换）；展开逆向
- chrome 区新增「关闭浏览器」按钮（lucide `X` 或 `PanelClose`，16px stroke 1.75）：有 agent 拥有 tab 时经 CenterPromptLayer 确认卡再关（`force`）
- TabStrip：`tab.owner !== 'user'` 显示徽标（色点 + agent 名，agentStore 解析；解析不到显示「agent」兜底）；用户 tab 无徽标
- `onBrowserState` 处理器：`expandHint && 本会话隐藏` → 置展开（替代原 `collapsed` 驱动）；`activeSessionId` 变化时上报 `setActiveSession`
- state 推送订阅的 ws 过滤守卫保留

### 9.3 设计系统遵循

语义 token / lucide 16px stroke 1.75 / 确认卡走 CenterPromptLayer 居中级（`docs/dev/design-system.md` §8 两级提示规则）——不新增裸坐标提示卡。

## 10. 错误处理与边界

| 场景 | 行为 |
|---|---|
| agent 关光自己的 tab 后立即 navigate | ensureLive 懒建首 tab（保留现有语义） |
| 侧栏零 tab（全部关闭） | 空态提示（不自动收起——用户可能正要开页） |
| 隐藏期后台页面加载失败 | 现有 notice 通道照常 |
| `ownerCurrent` 指向的 tab 被用户关闭 | 该 owner 下次操作时检测悬空 → 修正为其集合首个 tab（并回写 `ownerCurrent`）；集合空则懒建 |
| agent 会话结束后其 tab | 保留（用户可看可关）；不自动清理（后续迭代可加「会话结束收敛」策略） |
| `setActiveSession` 未上报（旧 renderer / 竞态） | 缓存为 null → 自动展开永不触发，行为退化为「不打扰」——安全缺省 |

## 11. 测试策略

**manager（electron/tests/browser/）**

- 多 owner 并存：A navigate 百度 + B navigate bing → 两 tab 共存、各自光标独立、互不覆盖（P1 回归锁）
- 视图类工具按 owner 光标解析：B 的 click 不落在 A 的页面
- tabsAction agent 源集合作用域（list 重索引 / close 集合内 / 越界 RangeError）
- 隐藏后 agent 操作照常 + expandHint 行为（活跃会话 true / 非活跃 false / null 安全缺省）
- 用户关全局最后 tab = 关浏览器；agent close 不影响他主
- 隐藏↔显示往返：bounds 全零↔恢复；viewsHidden 期 applyLastRect no-op

**renderer（贴源）**

- 徽标渲染（owner 解析 / 兜底）
- per-session 可见性：切会话各自记忆、新会话默认收起、会话删除清理
- expandHint 驱动展开（本会话隐藏时）；确认卡交互（有/无 agent tab 两态）

**契约（momo-boundary）**

- op-protocol 12 op 尾参加入后两端编译级对齐 + 桥 round-trip 保真
- `browser:state` 新旧字段增删与 preload / types.d.ts 同步

**改写**

- `manager-collapsed-navigate.test.ts` → §7.2 等价行为锁
- ebc0179 既有展开链路测试 → §7.3 新规则锁（活跃会话展开 / 非活跃不打扰）

## 12. 交付边界

单 spec 单计划可承载：主进程（manager/types/protocol/桥/路由/ipc.handlers）+ renderer（sidebar/store/确认卡）+ 测试三层。无 schema migration（列退役不删列）。实施计划另出（docs/plans/）。
