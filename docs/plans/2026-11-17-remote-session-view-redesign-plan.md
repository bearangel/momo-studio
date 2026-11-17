# 远端会话查看重构（全宽一等会话）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 远端委派执行会话从「只读抽屉 + 逐事件碎片投影」重构为「im 视图全宽一等会话 + worker 端聚合帧」，composer 直接下发 steer 指令。

**Architecture:** worker 的 view-server 按 `wire:2` 逐订阅协商切换帧投影（纯聚合模块 `view-frames.ts`）；leader 以订阅响应回显为判据选渲染路径，新 store `remote-session.view` 承载帧流/订阅/steer 生命周期；hub 对载荷透传零改动，仅协议仓 bump 1.13.0。

**Tech Stack:** Electron 主进程（CommonJS）+ React/zustand renderer + momo-hub 协议仓（TypeScript，git tag pin 消费）

**Spec:** `docs/specs/2026-11-17-remote-session-view-redesign-design.md`（本计划从 spec 出发，执行者须同时读 spec）

## Global Constraints

- TypeScript strict：禁 `any` / `@ts-ignore` / `as any`（ESLint no-explicit-any: error）
- 所有代码注释、文档使用中文；标识符英文
- Conventional Commits：`feat:` / `fix:` / `test:` / `docs:` / `chore:`
- 测试位置：electron 集中 `electron/tests/`（镜像 src 结构）；renderer 贴源 colocated（`Foo.test.tsx` 同目录）；根 `tests/` 仅 e2e
- UI 只用语义 token（`bg-surface-*` / `text-secondary`…），图标 lucide-react 16px/stroke 1.75，禁 emoji 图标（规范 `docs/dev/design-system.md`）
- 版本号纪律：特性 commit 不动版本号
- 每任务收尾：`npx pnpm@9.0.0 typecheck` 双 workspace 0 error + 该任务测试绿；Task 8 做全量回归
- 协议镜像三处同步改（momo-hub `src/` 权威源 → studio `electron/src/main/hub/protocol.ts` 镜像 → `renderer/src/ipc/types.d.ts` 镜像）——沿用 M2f T17 裁定的镜像维护模式

## Review Focus

spec 未逐条点名、但最可能咬人的五类输入（每条已锚定到所属任务的测试步骤）：

1. **旧订阅回归**：不带 `wire` 字段的订阅，投影输出必须与现状逐字节一致（Task 3 Step 2 回归锁——否则旧 leader 一起升级就坏）。
2. **流式重发不重不漏**：同 frameId 未终态帧每拍重发、leader 端 upsert 替换；终态后游标才推进——漏推进会永久重发，早推进会丢尾（Task 3 Step 1 聚合单测 + Task 5 Step 1 upsert 单测）。
3. **steer 去重竞态**：worker 回流 steer 帧与 leader 乐观气泡双显；同文两条 steer 按队列顺序消解（Task 5 Step 1 去重单测）。
4. **畸形帧与空联表**：payload_json 损坏单帧丢弃不断流；非委派会话 `delegationId` 联表为 NULL 不带键（Task 3 Step 1/3）。
5. **降级路径**：旧 worker 订阅响应无 `wire:2` 回显 → leader 渲染退旧文本样式不断流（Task 5 Step 1 + Task 6 Step 1 降级渲染测试）。

---

### Task 1: momo-hub 协议 1.13.0——ViewFrame 类型族 + delegationId + VIEW_FRAME_REQUIRED_MINOR

**Files:**
- Modify: `/Users/stbearangel/dev/AiProject/momo-hub/src/version.ts`（PROTOCOL_VERSION 与常量区）
- Modify: `/Users/stbearangel/dev/AiProject/momo-hub/src/remote-view.ts`（ViewSessionSummary :48 附近、ViewMessage :55 附近）
- Test: `/Users/stbearangel/dev/AiProject/momo-hub/packages/hub/tests/protocol-m2.test.ts`

**Interfaces:**
- Produces（后续任务的类型权威源）:

```ts
// src/remote-view.ts 新增/扩展
export interface ViewSessionSummary { sessionId: string; title: string; lastSeq: number; updatedAt: number; delegationId?: string }
export interface ViewToolFrame { name: string; argsExcerpt?: string; result?: string; success?: boolean; truncated?: boolean }
export interface ViewFrame {
  frameId: string;          // text=消息 messageId；tool=callId；user=消息 messageId；steer=事件 id
  seq: number;              // 帧末事件 rowid（全序单调，游标/去重键）
  at: number;
  role: 'user' | 'assistant';
  kind: 'text' | 'tool' | 'user' | 'steer';
  content?: string;         // kind=text/user/steer
  streaming?: boolean;      // kind=text 未终态（leader 按 frameId 整帧替换）
  tool?: ViewToolFrame;     // kind=tool
}
export interface ViewFramePage { frames: ViewFrame[]; hasMore: boolean }
// view.subscribe 请求载荷加可选 wire；响应载荷加可选 wire 回显
// （请求类型名以 remote-view.ts 订阅段现状为准，字段如下）
wire?: 2                    // 请求声明 + 响应回显，逐订阅协商
// view.tail 载荷可选第二形态（与 events 并存，hub 透传）
export interface ViewTailFramesPayload { sessionId: string; frames: ViewFrame[] }
// src/version.ts
export const PROTOCOL_VERSION = '1.13.0';
export const VIEW_FRAME_REQUIRED_MINOR = 13;
```

- [ ] **Step 1: 写失败测试**——protocol-m2.test.ts 追加 describe：①版本线 `PROTOCOL_VERSION === '1.13.0'` 且 `protocolSupports('1.12.0', 12)` 仍 true（兼容线含 1.12.0）；②`VIEW_FRAME_REQUIRED_MINOR === 13`；③ViewFrame 键集锁（frameId/seq/at/role/kind 五必键 + content/streaming/tool 可选；tool 子键 name 必选四可选）；④ViewSessionSummary 序列化 delegationId 缺省不带键（沿既有「缺省不带键」锁测试形态）。

- [ ] **Step 2: 跑测试确认失败**——`cd /Users/stbearangel/dev/AiProject/momo-hub && npx pnpm@9.0.0 vitest run packages/hub/tests/protocol-m2.test.ts`，期望 FAIL（常量/类型不存在）。

- [ ] **Step 3: 实现**——按上方 Interfaces 修改 version.ts（bump 1.13.0 + 头注释追加一条 1.13.0 变更说明 + `VIEW_FRAME_REQUIRED_MINOR`，不入 `METHOD_REQUIRED_MINOR`——载荷能力门，沿 TASK_STEER 先例）与 remote-view.ts（可选字段全加，旧形状零变化）。hub 中继零改动（remote-view.ts relay 对载荷透传——实现时读 hub 侧 `packages/hub/src/remote-view.ts` 确认无 shape 校验；若有校验则同步放行 frames 字段并在 commit message 注明）。

- [ ] **Step 4: 跑测试确认通过**——同 Step 2 命令，期望全绿；再跑 `npx pnpm@9.0.0 --filter momo-hub test`（或仓内既定全量命令）确认 444 基线不破。

- [ ] **Step 5: Commit + tag**——`git add src/version.ts src/remote-view.ts packages/hub/tests/protocol-m2.test.ts && git commit -m "feat: 协议 1.13.0——ViewFrame 帧类型族 + view.sessions 回带 delegationId + wire 逐订阅协商字段"`；`git tag v0.7.5`（**不推送**，Task 8 统一推）。

### Task 2: studio 协议镜像同步

**Files:**
- Modify: `electron/src/main/hub/protocol.ts`（studio 侧协议镜像——ViewMessage/ViewSessionSummary 镜像处）
- Modify: `electron/src/main/hub/view-wire.ts`（ViewTailPayload 镜像处，:35 附近）
- Modify: `renderer/src/ipc/types.d.ts`（HubViewMessage/HubViewSessionSummary 镜像，:3765 附近）

**Interfaces:**
- Consumes: Task 1 的类型族（上节全文，逐字镜像）
- Produces（renderer 侧名称前缀 Hub）:

```ts
// renderer/src/ipc/types.d.ts
export interface HubViewFrame { frameId: string; seq: number; at: number; role: string; kind: 'text'|'tool'|'user'|'steer'; content?: string; streaming?: boolean; tool?: HubViewToolFrame }
export interface HubViewToolFrame { name: string; argsExcerpt?: string; result?: string; success?: boolean; truncated?: boolean }
export interface HubViewFramePage { frames: HubViewFrame[]; hasMore: boolean }
// HubViewSessionSummary 加 delegationId?: string
// view.appended 事件载荷（ipc.hub.onViewAppended 的 evt）加可选 frames?: HubViewFrame[]
```

- [ ] **Step 1: 镜像同步**——三文件按 Task 1 类型逐字镜像（electron 侧无 Hub 前缀沿用协议名 ViewFrame 等；注释标注「协议 1.13.0 镜像，单源 momo-hub src/remote-view.ts」）。
- [ ] **Step 2: 类型检查**——`npx pnpm@9.0.0 typecheck`，期望 0 error（纯类型追加，无运行时改动，无新测试——键集锁已在 Task 1 协议侧覆盖）。
- [ ] **Step 3: Commit**——`git add -A electron/src/main/hub/protocol.ts electron/src/main/hub/view-wire.ts renderer/src/ipc/types.d.ts && git commit -m "feat: 协议 1.13.0 镜像同步——ViewFrame/delegationId/wire 协商字段三处镜像"`

### Task 3: worker 帧聚合投影 + 订阅协商 + sessions 回带 delegationId

**Files:**
- Create: `electron/src/main/hub/view-frames.ts`（纯聚合模块）
- Modify: `electron/src/main/hub/view-server.ts`（projectEventContent :95 / handleViewRequest :158 / assembleSessions :307 / assembleMessages :334 / subscribe :358 / tick :386）
- Test: `electron/tests/hub/view-frames.test.ts`（新建）
- Test: `electron/tests/hub/view-server.test.ts`（既有，追加）

**Interfaces:**
- Consumes: Task 2 镜像类型 `ViewFrame`
- Produces:

```ts
// electron/src/main/hub/view-frames.ts
/** 聚合输入行（sessionEvents 查询行的解包形态） */
export interface FrameEventRow {
  seq: number; at: number; messageId: string;
  sender: string;                        // 'owner' | 其他
  eventType: string;                     // message_events.event_type 真实值
  payload: Record<string, unknown>;      // JSON 已解包（损坏行由调用方跳过或本函数防御）
}
/**
 * 事件行 → 帧序列（纯函数，wire v2 投影单点）：
 * - text_delta 游程 → kind='text'（streaming=无终态事件；final.payload.body 到达以其定稿）
 * - thinking_delta / thinking 整族丢弃
 * - tool_call_start(+callId) 开 tool 帧；tool_call_result 按 callId 回填（无 callId 时按栈序配对）
 * - owner 消息行 → kind='user'
 * - steer 事件（payload.body）→ kind='steer'（role='user'）
 * - 其余事件类型丢弃（todo_update/dispatch/segment_boundary/status_change——终态事件仅驱动 streaming 收敛）
 */
export function aggregateFrames(rows: FrameEventRow[]): ViewFrame[];
```

- [ ] **Step 1: 写失败测试（view-frames.test.ts）**——describe「帧聚合」用例：①text_delta×N + final → 单条 text 帧正文拼接、无 streaming；②text_delta×N 无 final → streaming=true；③thinking_delta 夹在 text 游程间 → 全部丢弃、正文不受污染；④tool_call_start{callId:'c1',toolName:'bash',args:'…'} + tool_call_result{callId:'c1',result,success:true} → 单 tool 帧四字段（argsExcerpt= args 截 200 字符；result 超 TOOL_RESULT_WIRE_BUDGET(800) 截断 + truncated:true）；⑤tool_call_result 无对应 start → 按栈序补配；⑥owner 消息行 → user 帧；⑦steer 事件{body:'改一下'} → kind='steer'/role='user'/content='改一下'；⑧status_change(done) 后 text 帧 streaming 消失；⑨payload 损坏行（JSON.parse 由调用方解包——本函数收到 payload 非对象时该行跳过）不断流；⑩未知事件类型丢弃。每用例构造 rows 数组直断言输出帧（含 frameId/seq=组内末行 rowid）。

- [ ] **Step 2: 跑测试确认失败**——`cd electron && npx pnpm@9.0.0 vitest run tests/hub/view-frames.test.ts`，期望 FAIL（模块不存在）。

- [ ] **Step 3: 实现 view-frames.ts**——纯函数按 Interfaces 注释实现；分组键=（messageId × 事件族）；工具配对 Map<callId, 帧>，无 callId 用栈；帧 seq=组内最大 rowid；正文/结果 clamp 沿用 CONTENT_MAX 语义（content 超 256KB 截断）。

- [ ] **Step 4: 跑测试确认通过**——同 Step 2，期望全绿。

- [ ] **Step 5: 写失败测试（view-server.test.ts 追加）**——describe「wire v2 协商与帧投影」：①subscribe 载荷 `{sessionId, wire:2}` → res 载荷含 `{ok:true, wire:2}` 回显，tail 上行（VIEW_WIRE.tail mock 捕获）载荷为 `{sessionId, frames}` 且未终态 text 帧跨两拍重发同 frameId、终态拍后游标推进（下拍不再重发）；②subscribe 无 wire 字段 → res 无 wire 键、tail 载荷 `{sessionId, events}` **与现状逐字节一致**（回归锁——用既有测试的事件夹具对比）；③viewMessages 载荷 `{sessionId, wire:2, fromSeq:0, limit:50}` → res `{frames, hasMore}`，帧由 aggregateFrames 产出、hasMore=帧末 seq 之前仍有行；④assembleSessions 返回 delegationId（夹具：会话 task_id → task 行 delegation_id='d1'）且非委派会话不带键。测试沿用 view-server.test.ts 既有 harness（真 socket / mock clientGetter 形态照抄现文件）。

- [ ] **Step 6: 跑测试确认失败**——`cd electron && npx pnpm@9.0.0 vitest run tests/hub/view-server.test.ts`，期望新 describe FAIL。

- [ ] **Step 7: 实现 view-server.ts 改造**——①`TailWatch` 加 `wire: 1|2`（subscribe 解析 `p.wire === 2` 时置 2 并在 res 回显，幂等重订沿用）；②`assembleMessages` 加 wire 参数：wire2 时 rows 解包为 FrameEventRow（含 messageId——`sessionEvents` SELECT 需补 `e.message_id`）→ `aggregateFrames` → `{frames, hasMore}`；③`tick` wire2 分支：增量行 + **上一拍未终态帧的锚点重读**（实现取「游标内聚合含未终态帧全组」——watcher 记 `pendingFrameIds: Set<string>`，上行帧 = aggregateFrames(自帧组首行起重读)；上行成功且帧全终态才推游标过帧末 seq，未终态帧不推进——spec §4.1）；④`assembleSessions` 联表：`SELECT s.id, s.title, …, t.delegation_id FROM sessions s LEFT JOIN tasks t ON t.id = s.task_id WHERE s.workspace_id = ?`（沿 listSessionsByWorkspace 查询域改造；delegation_id 非空才带键）；⑤旧路径（无 wire）全走原代码，零改动。`handleViewRequest` messages/subscribe case 透传 wire 参数。

- [ ] **Step 8: 跑测试确认通过 + typecheck**——`cd electron && npx pnpm@9.0.0 vitest run tests/hub/view-server.test.ts tests/hub/view-frames.test.ts`；`npx pnpm@9.0.0 typecheck`。

- [ ] **Step 9: Commit**——`git add electron/src/main/hub/view-frames.ts electron/src/main/hub/view-server.ts electron/tests/hub/view-frames.test.ts electron/tests/hub/view-server.test.ts && git commit -m "feat: view-server wire v2——帧聚合投影 + 逐订阅协商 + sessions 回带 delegationId"`

### Task 4: leader 主进程 IPC 面——wire 参数透传 + appended 帧载荷

**Files:**
- Modify: hub IPC 注册处（`electron/src/main/hub/` 下 viewMessages/viewSubscribe handler 所在文件——grep `viewSubscribe` 定位，预期 hub/index.ts 或独立 ipc 文件）+ `electron/src/preload/index.ts`
- Test: 对应 handler 既有测试文件追加（grep `viewMessages` electron/tests/hub/ 定位）

**Interfaces:**
- Consumes: Task 3 的 wire2 响应形状 `{frames, hasMore}`
- Produces（renderer 调用面，types.d.ts 同步）:

```ts
ipc.hub.viewMessages(input: { targetNodeId: string; sessionId: string; workspaceName: string; fromSeq: number; limit: number; groupId?: string; wire?: 2 }):
  Promise<HubViewFramePage | HubViewMessagePage>   // wire:2 时返回 frames 页
ipc.hub.viewSubscribe(input: { targetNodeId: string; sessionId: string; groupId?: string; wire?: 2 }):
  Promise<{ ok: boolean; wire?: 2 }>                // 回显判据
// ipc.hub.onViewAppended(evt) 的 evt 加可选 frames?: HubViewFrame[]
```

- [ ] **Step 1: 写失败测试**——handler 测试追加：①viewMessages 带 wire:2 → 载荷含 wire 字段透传（mock 下游断言）；②viewSubscribe 带 wire:2 → res 透传 worker 回显；③onViewAppended 帧 evt 透传 renderer（沿既有事件桥测试形态）。
- [ ] **Step 2: 跑测试确认失败**——`cd electron && npx pnpm@9.0.0 vitest run tests/hub/<定位到的文件>`。
- [ ] **Step 3: 实现**——三处载荷可选字段透传（主进程 handler / preload / types.d.ts 声明）。hub 客户端侧 view.appended 事件解包处把 worker 帧 tail 载荷映射进 evt.frames。
- [ ] **Step 4: 跑测试确认通过 + typecheck**。
- [ ] **Step 5: Commit**——`git commit -m "feat: view IPC 面 wire v2 透传——viewMessages/viewSubscribe/appended 帧载荷"`（含实际改动文件）。

### Task 5: renderer——remote-session.view store（帧流/订阅/steer 生命周期）

**Files:**
- Create: `renderer/src/stores/remote-session.view.ts`
- Modify: `renderer/src/stores/ui.store.ts`（视图态挂载）
- Test: `renderer/src/stores/remote-session.view.test.ts`（colocated）

**Interfaces:**
- Consumes: Task 2/4 的 IPC 面
- Produces:

```ts
export interface RemoteSessionTarget {
  targetNodeId: string; workspaceName: string; groupId: string | null;
  runNo: number; nodeName: string; sessionId: string;
}
export interface PendingSteer { id: string; text: string; state: 'sending' | 'sent' | 'failed'; error?: string }
export function useRemoteSessionStore(): {
  phase: 'resolving' | 'ready' | 'miss' | 'error';
  errorText: string | null;
  target: RemoteSessionTarget | null;
  wire2: boolean;                        // 订阅回显判定
  frames: HubViewFrame[];                // wire2 帧流（frameId upsert 去重）
  legacy: HubViewMessage[];              // 降级旧投影（沿现抽屉渲染语义）
  hasMore: boolean; loadingEarlier: boolean; live: boolean; hubOnline: boolean; liveError: string | null;
  pendingSteers: PendingSteer[];
  open(task: TaskRow): void;             // 定位链：delegationId 精确匹配优先，标题全等兜底（沿 resolveTarget 迁移）
  close(): void;                         // 退订幂等清理
  loadEarlier(): void;
  sendSteer(text: string): Promise<void>;// ipc.hub.steer（签名沿 SteerEntry.tsx:119 现调用）+ 乐观 PendingSteer
  retrySteer(id: string): void; dropSteer(id: string): void;
}
// ui.store 追加：
remoteSessionView: { task: TaskRow } | null;
openRemoteSession(task: TaskRow): void;  // set 态 + setActiveView('im')
closeRemoteSession(): void;              // 触发 store.close()
```

- [ ] **Step 1: 写失败测试（ipc 边界全 mock，沿 RemoteSessionDrawer.test.tsx / SteerEntry.test.tsx 形态）**——用例：①open：viewSessions 返回带 delegationId → 精确匹配（标题不同的会话也命中）；②delegationId 全缺 → 标题全等兜底命中（存量路径）；③双 miss → phase='miss'；④wire2 订阅回显成功 → frames 渲染路径 + appended frames 按 frameId upsert（同 frameId 两拍替换不重复）；⑤回显无 wire 键 → wire2=false + appended events 走 legacy 数组；⑥steer 帧回流（kind='steer'）→ 消解 pendingSteers 首条同文项（队列顺序）；⑦sendSteer：ipc 成功 → 'sent'（气泡显示+送达徽标数据）；失败 → 'failed' + error 人话；⑧断线重连：onStateChanged offline → live=false；online → 重订（先 unsubscribe 幂等）+ viewMessages(fromSeq=已知尾+1, wire) 补拉——沿现抽屉三条 effect 语义迁移。
- [ ] **Step 2: 跑测试确认失败**——`cd renderer && npx pnpm@9.0.0 vitest run src/stores/remote-session.view.test.ts`。
- [ ] **Step 3: 实现 store + ui.store 挂载**——resolveTarget 迁移自 RemoteSessionDrawer.tsx:70-141（delegationId 优先）；订阅/重连/退订三 effect 迁移自抽屉 :214-292；帧 upsert：`Map<frameId, frame>` 值替换后按 seq 排序输出；steer 消解：`kind==='steer' && p.text===frame.content` 消解最旧 pending；HumanRequestPanel 等本地面板不涉及。
- [ ] **Step 4: 跑测试确认通过 + typecheck**。
- [ ] **Step 5: Commit**——`git commit -m "feat: remote-session.view store——帧流 upsert/订阅重连/steer 乐观与消解"`（含两文件 + 测试）。

### Task 6: renderer——RemoteSessionView 全宽组件（帧渲染 + 降级）

**Files:**
- Create: `renderer/src/components/hub/RemoteSessionView.tsx`
- Modify: `renderer/src/components/layout/MiddlePanel.tsx`（im 分支 :109 前插远端分支）
- Test: `renderer/src/components/hub/RemoteSessionView.test.tsx`

**Interfaces:**
- Consumes: Task 5 store + 本地 ToolCallChip（`renderer/src/components/im/` 下 grep `ToolCallChip` 定位；若其为强耦合本地消息形状，则按其 props 适配器映射 HubViewToolFrame）
- Produces: `<RemoteSessionView />`（无 props，读 store；Esc 关闭 = closeRemoteSession）

- [ ] **Step 1: 写失败测试**——①ready + wire2：text 帧 → 气泡（streaming 帧带光标类）；tool 帧 → chip（name/摘要/成败图标）；steer 帧 → user 气泡 + 「指令」徽标；user 帧 → 右对齐 user 气泡；②miss → 「未找到执行会话（任务可能尚未开始）」+ 重试按钮（re-open）；③error → 人话错误行；④降级（wire2=false）→ legacy 消息沿现抽屉样式渲染（parseToolRow 文本行形态迁移）；⑤加载更早按钮 → loadEarlier 调用；⑥会话头：节点名 · run 号 · 实时/已断开/已结束徽标（任务终态判定经 task refetch 或 props 透传——沿 store.task）。形态断言沿 design-system token（禁标准色阶类）。
- [ ] **Step 2: 跑测试确认失败**——`cd renderer && npx pnpm@9.0.0 vitest run src/components/hub/RemoteSessionView.test.tsx`。
- [ ] **Step 3: 实现**——布局对齐 im 列（`flex-1 flex flex-col min-w-0`）；头部沿抽屉 CONTRACT #2 徽标形态迁移；帧流域 `gap-2.5 overflow-y-auto px-3.5 py-3` 对齐；ToolCallChip 适配器：`{name, argsExcerpt, result, success, truncated}` → chip props（若 chip 需要事件序列形态则做最小适配组件 `RemoteToolChip` 包一层，不 copy 内部实现）；MiddlePanel im 分支顶部：`const remote = useUiStore(s => s.remoteSessionView); if (activeView === 'im' && remote) return <RemoteSessionView />`。
- [ ] **Step 4: 跑测试确认通过 + typecheck**。
- [ ] **Step 5: Commit**——`git commit -m "feat: RemoteSessionView 全宽组件——帧渲染/工具 chip/降级旧样式/分页"`。

### Task 7: composer=steer + 看板入口 + 旧组件退役

**Files:**
- Create: `renderer/src/components/hub/RemoteSteerComposer.tsx`
- Modify: `renderer/src/components/hub/RemoteSessionView.tsx`（挂 composer）
- Modify: 委派详情/看板卡入口（grep `shortNodeId` 于 `renderer/src/components/task/` 定位 TaskDetailPanel 委派段；DelegatedTaskCard 动作区 `renderer/src/components/workgroup/DelegatedTaskCard.tsx`）
- Delete: `renderer/src/components/hub/RemoteSessionDrawer.tsx` + `.test.tsx`、`renderer/src/components/hub/SteerEntry.tsx` + `.test.tsx`
- Modify: `renderer/src/components/layout/MiddlePanel.tsx`（移除 :22-24 两 import 与 :127/:129 两挂载点）
- Test: `renderer/src/components/hub/RemoteSteerComposer.test.tsx`（新建）

**Interfaces:**
- Consumes: Task 5 store 的 `sendSteer/retrySteer/dropSteer/pendingSteers` + 任务态（TaskRow.status）
- Produces: `<RemoteSteerComposer />`（无 props）

- [ ] **Step 1: 写失败测试**——①任务 running/waiting_human/submitted → 输入可用，发送按钮文案「发送指令」，Enter 提交 → sendSteer(text)；②终态（done/failed/cancelled）→ 禁用 + 占位「任务已结束」；③pending 态任务 → 发送后 ipc 拒绝错误人话 toast；④失败 pendingSteer → 气泡红边 + 重试/丢弃两钮；⑤送达态 → 「送达 {nodeName}」徽标；⑥空文本不发送；超长（STEER_MAX_CODEPOINTS，常量从 SteerEntry.tsx 迁移到 composer 或共享模块）截断提示。
- [ ] **Step 2: 跑测试确认失败**——`cd renderer && npx pnpm@9.0.0 vitest run src/components/hub/RemoteSteerComposer.test.tsx`。
- [ ] **Step 3: 实现 composer + 入口 + 退役**——composer 复用 RichComposer/IconButton 形态（沿 MentionInput 内部组合方式，不耦合 session store）；乐观气泡渲染进 RemoteSessionView 帧流域尾部（pendingSteers → user 气泡 + 状态徽标，回流消解后移除）；入口：TaskDetailPanel 委派段 + DelegatedTaskCard 动作区各加「进入会话」按钮（Eye 图标 → `useUiStore.getState().openRemoteSession(task)`，仅 delegationRole='out' 且 delegationId 非空显示）；删除两旧组件四文件与 MiddlePanel 挂载点（CONTRACT #9/#10/#11 随之退役）。
- [ ] **Step 4: 跑测试确认通过 + 全 renderer 测试**——`cd renderer && npx pnpm@9.0.0 vitest run`（确认删除无残留引用；3642 基线 - 删除用例 + 新增用例全绿）。
- [ ] **Step 5: Commit**——`git commit -m "feat: 远端会话 composer=steer + 看板入口；退役只读抽屉与 SteerEntry"`。

### Task 8: 全量回归 + hub tag 推送 + pin 更新 + E2E 验收

**Files:**
- Modify: `electron/package.json`（momo-hub pin `github:bearangel/momo-hub#v0.7.5`）+ lockfile
- Report: `.omo/qa-reports/2026-11-17-remote-session-view-e2e/report.md`

- [ ] **Step 1: 全量回归**——`npx pnpm@9.0.0 typecheck`（双 ws 0 error）→ `npx pnpm@9.0.0 test`（electron + renderer 全绿）→ 双 ws lint 0 error（沿仓内既定 lint 命令）。
- [ ] **Step 2: hub 推送 + pin**——hub 仓 `git push origin main v0.7.5`（Step 前置：远端无新提交，`git pull --ff-only` 核对）；studio `package.json` pin 升 v0.7.5 + `npx pnpm@9.0.0 install` 刷 lockfile。
- [ ] **Step 3: E2E 手动验收（A/B 双实例 CDP 拓扑，沿 2026-11-15 retest 手册）**——vite 5173 + hub 9801 + A(9222/profile-a) B(9223/profile-b)；场景：①B 建 workspace + agent；②A 看板建任务派 B → B 承接跑起来；③A 看板「进入会话」→ 全宽远端会话：正文聚合气泡 / 工具 chip / **无任何 thinking 行 / 无 token 跳行**；④composer 输入「在 README 追加一行」发送 → worker 消费（B 侧日志「远端指令已消费」）→ 回流 steer 帧无双显气泡；⑤打回 → run#2 → 会话帧流切新 run 会话（delegationId 精确定位）；⑥任务 done → composer 禁用「任务已结束」；⑦旧 worker 降级（B 回退旧构建或 mock 回显缺失）→ 简版渲染不断流。逐条截图 + 结论写 report.md。
- [ ] **Step 4: Commit**——`git commit -m "chore: momo-hub pin v0.7.5（协议 1.13.0）"`；E2E 报告 .omo 不入库。
- [ ] **Step 5: spec 状态回填**——`docs/specs/2026-11-17-remote-session-view-redesign-design.md` 头部状态改「已交付（附验收报告路径）」，commit `docs: spec 状态回填——远端会话重构已交付`。

---

## Self-Review 记录

- **Spec 覆盖**：§4 帧模型→Task 1/3；§5 定位链→Task 3(Step5④)/Task 5(Step1①②)；§6 协商→Task 1/3/4；§7.1 入口生命周期→Task 5(ui.store)/6/7；§7.2 渲染与退役→Task 6/7；§7.3 composer→Task 5/7；§8 错误表→Task 5(③⑥⑦)/6(②③④)/7(③④)；§9 测试→各任务 + Task 8；§10 兼容迁移→Task 3 回归锁/Task 8 E2E⑦ + 历史 frames 现算（assembleMessages 实时投影，无迁移）；§11 R1→Task 1 Step 3 核实、R2/R3→Task 5 Step 1⑥。无缺口。
- **占位扫描**：无 TBD/TODO；「grep 定位」仅指向唯一确定文件集的查找动作，非设计留白。
- **类型一致性**：ViewFrame 字段族 Task 1↔2↔3↔5 一致；sendSteer/openRemoteSession 命名 Task 5↔6↔7 一致；STEER_MAX_CODEPOINTS 迁移在 Task 7 Step 1⑥ 注明。
- **Review Focus 五条**均锚定测试步骤（Task 3 Step 1⑨/Step 5②、Task 5 Step 1④⑤⑥、Task 6 Step 1④）。
