# 远端会话查看重构设计（全宽一等会话）

- 日期：2026-11-17
- 状态：已实现（分支 feat/remote-session-view，8 任务 TDD 交付；单测/集成全绿——E2E 验收见 .omo/qa-reports/2026-11-17-remote-session-view-e2e/）
- 范围：studio 双 workspace + momo-hub 协议仓（minor bump）
- 上游依据：`docs/specs/2026-11-13-task-human-loop-lifecycle-design.md`（steer §8.2 / view 只读红线 §8.4）、`docs/specs/2026-08-23-v2.0.0-platform-refactor-design.md`

## 1. 背景与问题

主节点（发起方）经任务看板查看外派委派的执行过程，现有「只读抽屉」链路存在三痛点：

### 1.1 会话定位失败

`RemoteSessionDrawer.resolveTarget` 三跳定位全部依赖脆弱匹配：

1. `taskList` 反查账本行（delegationId → targetNodeId / workspaceName）；
2. `viewSessions(targetNodeId, workspaceName)` 后**按标题全等** `s.title === task.title` 找执行方会话；
3. `viewMessages` 拉尾窗。

任务未建会话（真 miss）、标题被编辑、workspaceName 漂移，任一环断即落「未找到执行会话（任务可能尚未开始）」占位。协议没有 delegationId → sessionId 的直达通道，全靠猜。

### 1.2 「（事件 thinking_delta）」噪音与 token 跳行

worker 侧 `view-server.ts` 的投影是**逐事件**的（`message_events` 每行 → 一条 ViewMessage）：

- `projectEventContent` 只认 `eventType === 'thinking'`，而事件库类型是 `thinking_delta`——该分支为死代码，thinking 全部落兜底 `（事件 ${eventType} ）`（**投影 bug**，用户看到的「（事件thinking_delta）」即此）；
- `text_delta` 每 token 投影一条 → 一个字一行（「跳行」）；
- 本地会话正常是因为渲染端走 `stream-aggregator` 聚合（delta 拼全文、thinking 折叠、工具 chip 化）；view-server 在投影端就把结构信息丢了，leader 侧拿到纯文本碎片，事后无法重聚合。

### 1.3 回复要走独立按钮

抽屉底部「无 composer——只读回放·不落本地消息」（CONTRACT #9），回复只能去会话头点「补充指令」（SteerEntry 独立按钮），交互面割裂。

## 2. 目标与非目标

**目标**：远端执行会话的查看与交互体验对齐本地会话——

- 定位链根治（delegationId 精确直达，标题匹配退役为存量兜底）；
- 帧化聚合显示（正文完整气泡 / 工具调用 chip 同构 / thinking 投影端全裁）；
- 全宽一等会话形态，composer 直接输入 = 下发 steer 指令；只读抽屉与 SteerEntry 退役。

**非目标**：

- 不改本地会话渲染链路（stream-aggregator / MessageList 原样）；
- 不做远端会话落库（leader 本地零持久化，纯视图态——沿只读红线）；
- 不做远端人工请求代答面板迁移（HumanRequestPanel 既有路径不动）；
- 不改 hub 的中继语义（载荷透传，见 §7 前提核实项）。

## 3. 已拍板决策（2026-11-17 brainstorming）

| # | 决策点 | 结论 |
|---|---|---|
| D1 | 复用形态 | **全宽一等会话**（im 视图全宽打开，非抽屉） |
| D2 | thinking | **投影端完全裁掉**（worker 不发；想看思考去执行节点本地） |
| D3 | 工具调用 | **本地同构 chip**（协议透传结构化工具帧） |
| D4 | 入口与生命周期 | **任务驱动临时进入**（不落会话列表；看板/详情点「进入会话」打开） |
| D5 | wire 形态 | **A1：worker 端聚合帧**（非 A2 事件透传） |
| D6 | 定位修复 | **B1：会话与委派 id 显式关联**（标题匹配降级兜底） |

## 4. 帧模型（ViewFrame，wire v2）

worker 投影从「逐事件」升级为「按消息聚合帧」。一帧：

```ts
interface ViewFrame {
  /** 帧稳定身份：text=消息 messageId；tool=工具 callId；user=消息 messageId；steer=事件 id */
  frameId: string;
  /** 帧末事件 rowid（游标 / 排序 / 去重键，单调全序不变） */
  seq: number;
  at: number;
  role: 'user' | 'assistant';
  kind: 'text' | 'tool' | 'user' | 'steer';
  /** kind='text'：正文全文；streaming=true 表示未终态（见 §4.1） */
  content?: string;
  streaming?: boolean;
  /** kind='tool'：结构化工具载荷（chip 渲染输入） */
  tool?: { name: string; argsExcerpt?: string; result?: string; success?: boolean; truncated?: boolean };
  /** kind='steer'：origin=发起方节点标记（leader 去重依据，§8.4） */
  origin?: string;
}
```

### 4.1 流式与游标语义

- 未终态的 text 帧：每拍 tail 重发**最新快照**（同 frameId = 整帧替换，content 随流增长）；leader 端按 frameId upsert。
- 游标（订阅 cursor）只推进到**已终态帧**的末 seq；未终态帧不推进游标、每拍重发，终态（`final` / `status_change` 终态）后最后一拍定稿、游标越过。
- tail 推送频率从「每 token 一条」降为「每拍至多一帧」（500ms 轮询节拍不变）。

### 4.2 聚合规则（worker 投影端单点）

| 事件 | 投影 |
|---|---|
| `text_delta` 游程 | 拼接为一条 text 帧正文（`final.payload.body` 到达时以其为准定稿） |
| `thinking_delta` / `thinking` | **整族丢弃**（D2） |
| `tool_call_start` | 开工具帧（name + argsExcerpt） |
| `tool_call_result` | 回填同 callId 工具帧（result / success / truncated——结果超长截断，沿 TOOL_RESULT_WIRE_BUDGET 量级） |
| owner 消息（messages 行） | user 帧（任务书首消息等） |
| `steer` 事件（payload.body） | **steer 帧**（role=user，origin=标记；leader 据此去重，§8.4） |
| 其余（todo_update / dispatch / segment_boundary / status_change…） | 丢弃（notice 类暂不设——最小面起步，需要再议） |

### 4.3 查询与分页

`sessionEvents` JOIN messages 的既有查询不变；帧化在投影层完成（按 message_id 分组 + 组内事件归并）。`view.messages` 分页语义从「事件页」变为「帧页」（fromSeq 对帧末 seq，hasMore 判定同款）。

## 5. 定位链修复（D6 / B1）

- `view.sessions` 会话摘要**新增可选 `delegationId`**：worker 由 `sessions.task_id → tasks.delegation_id` 联表回带（列已存在，零迁移；executor 闸门同源）。
- leader 定位：`resolveTarget` 改为按 `delegationId === task.delegationId` 精确匹配，多命中（rework 多 run）取 `lastSeq` 最大者（最新 run，语义同现标题匹配的降序取首）。
- **标题全等匹配退役为兜底**：仅当回带字段缺失（存量旧 worker / 旧会话）时走旧链；兜底路径行为不变、有既有测试锁。

## 6. 协议与协商

- `view.subscribe` 载荷新增可选 `wire: 2`：**逐订阅协商**（hub 对 view 载荷透传，不感知）。
  - 新 leader 订阅带 `wire:2` → worker 认得 → 帧流应答，且订阅响应**回显 `wire:2`**；
  - 旧 worker 未知字段剥除 → 回旧文本投影，响应无回显 → leader 自动降级旧渲染；
  - 旧 leader 不带字段 → worker 旧投影，行为逐字节不变。
- leader 以**订阅响应回显**为渲染路径的唯一判据（不依赖全局版本门）。
- `PROTOCOL_VERSION` bump **1.13.0**（momo-hub 仓 `src/version.ts`），登记 `VIEW_FRAME_REQUIRED_MINOR = 13` 常量：仅供 UI 预判提示（「对方节点版本较旧，回放为简版」）与 protocol-m2 版本线锁，不参与硬拒。
- **前提核实项（实施首步）**：hub `remote-view.ts` 对 view 载荷确为透传、无 shape 校验；若存在校验则 hub 侧同步放行新形态（hub 仓最小改）。

## 7. leader 侧 UI（D1 / D4）

### 7.1 入口与生命周期

- 任务看板外派卡 / 任务详情 →「进入会话」→ 切 im 视图全宽打开远端会话。
- 不落会话列表（RoomList 不出现）；ui store 新增 `remoteSessionView: { task, target } | null` 视图态；切换本地会话 / 视图即关闭。
- 任务终态后入口仍在（看板历史卡），可回看；实时徽标变为「已结束」。

### 7.2 渲染

- 新增轻量 `remote-session.view` store（帧 upsert / 分页 / 订阅生命周期 / 断线重连补拉——迁移现抽屉的三条 effect 语义）。
- 复用本地气泡与 ToolCallChip 组件渲染帧流；会话头：远端徽标（执行节点名 · run 号 · 实时/断开/已结束）。
- 加载更早（触顶翻页）、Esc 退出、断开降级不透明度等交互平移现抽屉契约。
- **退役**：`RemoteSessionDrawer` / `RemoteSessionEntry` / `SteerEntry` 及其测试删除（SteerEntry 能力并入 composer）。

### 7.3 composer = steer

- 复用 `MentionInput` 形态；发送按钮「发送指令」。
- 发送链路 = 既有 `ipc.hub.taskSteer`（协议 1.12 方法，零新增）。
- **态机门控**：任务 `running / waiting_human / submitted` 可发送；终态禁用 + 占位「任务已结束」；`pending`（未开始）发送 → 人话提示；worker 离线 → 人话错误（沿协议既有文案「执行节点离线，稍后再试」）。
- 发送后**乐观渲染** user 气泡 +「送达 {节点名}」徽标（沿 SteerEntry 语义）；worker 消费注入后回流的 steer 帧（§4.2）按 `origin` + 内容匹配消解 pending 乐观气泡，**不双显**；worker 侧 steer 帧内容 = 发送原文（`payload.body` 透传），匹配键 = (origin, content)，pending 队列按序消解。
- 本地零落库（只读红线 §8.4 纪律，纯视图态）。

## 8. 错误处理

| 场景 | 行为 |
|---|---|
| 定位 miss（无关联会话且标题兜底未命中） | 「未找到执行会话（任务可能尚未开始）」占位 + 重试按钮 |
| 订阅失败 / hub 断开 | 降级「已断开 · 重连后恢复」，重连自动重订 + 尾后补拉（平移现抽屉） |
| steer 发送失败 | 乐观气泡转失败态（红边 + 重试/丢弃），不静默吞 |
| 旧 worker 降级 | 帧渲染路径退回旧文本投影渲染（旧样式），头部提示「简版回放」 |
| 帧载荷畸形 | 单帧丢弃 + log warn，不断流 |

## 9. 测试与验收

- **electron 单测**：view-server 帧聚合（delta 游程 / 工具配对 / thinking 丢弃 / steer 帧标记 / 流式重发-终态推游标 / 分页）；viewSessions 回带 delegationId 联表；旧订阅（无 wire 字段）行为逐字节回归锁。
- **renderer 单测**：帧渲染（气泡 / chip / streaming 光标 / upsert 替换）；composer 态机门控全表；steer 乐观渲染 / 帧消解去重 / 失败态；降级渲染路径。
- **protocol（hub 仓）**：wire v2 协商三态（新-新 / 新-旧 / 旧-新）+ 版本线 1.13.0。
- **E2E**（A/B 双实例拓扑）：看板进入 → 帧流显示（正文聚合 / 工具 chip / 无 thinking）→ composer 发 steer → worker 消费 → 回流不双显 → 打回返工 run 切换 → 终态禁用。
- 回归基线：electron / renderer 全量绿，typecheck + lint 0 error。

## 10. 兼容与迁移

- 存量委派任务：worker 升级后新事件自动帧化；**历史事件**在订阅时由 worker 现算帧（`view.messages` 实时投影，无落库迁移）——旧会话也能帧化回看。
- 旧 worker（< 本次版本）回旧投影 + 旧渲染；旧 hub 无影响（透传 + 版本常量随新 tag 发布）。
- momo-hub 仓变更：`src/version.ts` bump 1.13.0 + `VIEW_FRAME_REQUIRED_MINOR` 常量 + 协议类型（ViewFrame / ViewSessionSummary.delegationId）+ tag v0.7.5；studio 更新 git tag pin。

## 11. 风险与开放问题

- **R1** hub view 载荷若非纯透传（§6 前提核实项）→ hub 仓追加最小放行改动，属既定路径非分叉。
- **R2** steer 帧去重键 (origin, content)：同文重复指令按 pending 队列顺序消解；跨 run 同文 steer 极端场景可能误配对——概率与影响（一条乐观气泡提前消解）均可接受，不为此引入序号协议。
- **R3** 帧页 hasMore 语义在超长单帧会话下的翻页粒度变粗（一帧=一消息）——与本地会话体验一致，非回退。
