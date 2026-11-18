# 跟踪会话面板直连远端内容（D1 修订）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 侧栏点跟踪会话即直接看到远端执行内容（零额外点击）——远端帧流 + 本地里程碑穿插渲染进标准会话面板，退役独立视图态与全部跳板入口。

**Architecture:** 纯 renderer 改动。新组件 `RemoteSessionPanel`（面板体：状态条 + 穿插时间线 + steer composer）替换跟踪会话的 MessageList/InputToolbar；生命周期挂会话选中（mount→open、unmount→close）；看板/详情入口统一改为「选中跟踪会话」。协议/主进程/hub 零改动。

**Tech Stack:** React 18 + zustand + vitest/@testing-library（renderer workspace）

**Spec:** `docs/specs/2026-11-17-remote-session-view-redesign-design.md` **§12（D1 修订）**——本计划只实施 §12；§4-§11 已交付面不变。

## Global Constraints

- TypeScript strict：禁 `any` / `@ts-ignore` / `as any`（ESLint no-explicit-any: error）
- 中文注释；Conventional Commits（`feat:`/`fix:`/`test:`/`refactor:`）
- renderer 测试贴源 colocated（`Foo.test.tsx` 同目录）
- UI 只用语义 token + lucide-react 16px/stroke 1.75；状态色沿 `lib/task-status`
- 每任务收尾 `cd renderer && npx pnpm@9.0.0 vitest run <本任务文件>` 绿 + `npx pnpm@9.0.0 typecheck` 0 error
- 既有资产不得回退：RemoteSteerComposer 门控/乐观/消解、wire2 协商、legacy 降级渲染、四态降级矩阵（§12.3）

## Review Focus

1. **StrictMode 双挂载**：面板 unmount 清理（store.close）不得让二次挂载拿不到任务——remount effect 必须能从 activeSession 重新 resolve 任务并 open（Task 2 测试锁：render→unmount→render 同会话仍开）。
2. **穿插排序 tie-break**：帧 `at` 与镜像行 `createdAt` 同毫秒时的稳定序（镜像先落、帧后到——按 (timestamp, 先镜像后帧) 排序锁死，防抖动）。
3. **降级矩阵四态**各有渲染路径（未开始占位 / 旧 worker 简版 / 断开徽标保留已到帧 / miss 重试）——不得因拆壳丢失。
4. **入口目标缺失**：executionSessionId 为 null（未派发）或会话已被清理 → 人话 toast，不崩不静默。
5. **composer 终态实时性**：onTaskRunChanged 刷新 task（既有修复）在拆壳后仍生效——任务完成后 composer 禁用不回退。

---

### Task 1: RemoteSessionPanel 面板体 + 时间线穿插 + store 镜像行

**Files:**
- Create: `renderer/src/components/hub/RemoteSessionPanel.tsx`
- Create: `renderer/src/components/hub/RemoteSessionPanel.test.tsx`
- Modify: `renderer/src/stores/remote-session.view.ts`（+mirrorRows 拉取/刷新）
- Test: `renderer/src/stores/remote-session.view.test.ts`（追加）

**Interfaces:**
- Consumes: `useRemoteSessionStore`（全部既有面）、`RemoteSteerComposer`、`ipc.im.getMessages(sessionId): Promise<{ messages: ImMessage[] }>`
- Produces:
```ts
// RemoteSessionPanel.tsx
export function RemoteSessionPanel({ sessionId, workspaceId }: { sessionId: string; workspaceId: string }): React.JSX.Element;
// remote-session.view.ts 新增：
mirrorRows: ImMessage[];   // 本地跟踪会话镜像里程碑行（open 拉取 + onTaskRunChanged 刷新）
```

- [ ] **Step 1: store RED**——remote-session.view.test.ts 追加 describe「镜像行」：
```ts
it('open() 拉取跟踪会话本地镜像行；onTaskRunChanged 推送刷新', async () => {
  api.im = { getMessages: vi.fn().mockResolvedValue({ messages: [{ id: 'm1', sessionId: 'sx', sender: 'system', body: '已提交待验收', eventType: 'delegation_milestone', streamSessionId: null, parentStreamSessionId: null, segmentOf: null, segmentIndex: null, status: 'done', source: 'hub', workspaceId: 'ws', taskId: 'T-9', createdAt: 1700000000000, updatedAt: 0 }] }) };
  task.executionSessionId = 'sx';
  await useRemoteSessionStore.getState().open(task);
  expect(useRemoteSessionStore.getState().mirrorRows.map((m) => m.body)).toEqual(['已提交待验收']);
  api.im.getMessages.mockClear();
  api.task.get.mockResolvedValue({ ...task, status: 'completed' });
  for (const cb of [...runChangedCallbacks]) cb({ taskId: task.id, runId: 'r1', status: 'completed' });
  await vi.waitFor(() => expect(api.im.getMessages).toHaveBeenCalled());
});
```
（mock 面板 api 需补 `im: { getMessages: vi.fn().mockResolvedValue({ messages: [] }) }` 缺省。）
- [ ] **Step 2: 跑 RED**——`cd renderer && npx pnpm@9.0.0 vitest run src/stores/remote-session.view.test.ts`，期望新用例 FAIL（mirrorRows 不存在）。
- [ ] **Step 3: store GREEN**——remote-session.view.ts：state 加 `mirrorRows: ImMessage[]`；open() 成功定位后 `void this.refetchMirror()`（内部 ipc.im.getMessages(task.executionSessionId ?? '').catch(空)）；onTaskRunChanged 处理器在刷新 task 后同样触发 refetchMirror；close() 重置 `mirrorRows: []`。import type ImMessage。
- [ ] **Step 4: 跑 GREEN**——同 Step 2 命令全绿。
- [ ] **Step 5: 面板 RED**——RemoteSessionPanel.test.tsx 写全套（store 直植 + ipc mock）：
  - 穿插时间线：frames=[{seq:1,at:T+2000,kind:'text',content:'远端正文'}] + mirrorRows=[{createdAt:T+1000,body:'已提交待验收'}] → DOM 序：先「已提交待验收」细行后「远端正文」气泡；里程碑细行含 lucide 图标 + HHmm。
  - tie-break：同毫秒 → 镜像行在前。
  - 降级矩阵四态：phase='ready' 但 frames 空 + target null→不适用（miss 态已有）；未开始（phase='miss'）→「未找到执行会话（任务可能尚未开始）」+重试钮；wire2=false→LegacyRow 样式 + 「简版回放」徽标 + 镜像穿插；live=false→「已断开 · 重连后恢复」徽标 + 已到帧保留。
  - composer 在场（RemoteSteerComposer 渲染）+ 加载更早按钮触发 loadEarlier。
- [ ] **Step 6: 跑 RED**——`npx pnpm@9.0.0 vitest run src/components/hub/RemoteSessionPanel.test.tsx`，FAIL（组件不存在）。
- [ ] **Step 7: 面板 GREEN**——RemoteSessionPanel.tsx：
  - 合并算法：`const merged = [...frames.map(f => ({ t: f.at, kind: 'frame' as const, f })), ...mirrorRows.map(m => ({ t: m.createdAt, kind: 'mirror' as const, m }))].sort((a, b) => a.t - b.t || (a.kind === 'mirror' ? -1 : 1))`。
  - 镜像细行：`<div className="mx-auto flex items-center gap-1.5 text-[10.5px] text-tertiary"><Milestone size={11} strokeWidth={1.75}/>{formatHHmm(m.createdAt)}<span className="truncate max-w-[60%]">{m.body}</span></div>`（Milestone 从 lucide-react import；body 截 60 字）。
  - 状态条/帧气泡/工具 chip/LegacyRow/占位/composer：**从 RemoteSessionView.tsx 平移**（FrameBubble/RemoteToolChip/parseToolRow/formatHHmm/isStreamingTail 一并迁入，保持原实现）。
  - 顶部状态条：实时/已断开/简版徽标 + run 号 + 节点名（原头部字段平移为一条横条，不再渲染标题行——标题由会话面板壳负责）。
- [ ] **Step 8: 跑 GREEN + typecheck**。
- [ ] **Step 9: Commit**——`git add renderer/src/components/hub/RemoteSessionPanel.tsx renderer/src/components/hub/RemoteSessionPanel.test.tsx renderer/src/stores/remote-session.view.ts renderer/src/stores/remote-session.view.test.ts && git commit -m "feat: RemoteSessionPanel 面板体——帧流与镜像里程碑穿插时间线 + store 镜像行拉取刷新（spec §12.2）"`

### Task 2: MiddlePanel 直连路由 + 生命周期挂会话选中 + 退役独立视图态

**Files:**
- Modify: `renderer/src/components/layout/MiddlePanel.tsx`
- Create: `renderer/src/lib/resolve-tracking-task.ts`（共享任务解析）
- Delete: `renderer/src/components/hub/RemoteSessionView.tsx` + `RemoteSessionView.test.tsx`
- Modify: `renderer/src/stores/ui.store.ts`（删 remoteSessionView 三面 + setActiveView 收口补丁）
- Test: `renderer/src/components/layout/MiddlePanel.test.tsx`（追加）

**Interfaces:**
- Consumes: Task 1 的 `RemoteSessionPanel`
- Produces:
```ts
// resolve-tracking-task.ts
export async function resolveTrackingTask(session: { id: string; kind: string; taskId: string | null; workspaceId: string }): Promise<TaskRow | null>;
// taskId 非空 → ipc.task.get；空 → ipc.task.list({workspaceId}) 反查 execution_session_id === session.id；无匹配 → null
```

- [ ] **Step 1: RED**——MiddlePanel.test.tsx 追加 describe「跟踪会话直连」：
  - 选中 kind='task_execution' 会话（session store 预置 activeSessionId + sessions）→ 渲染出 `RemoteSessionPanel`（断言 data-testid="remote-session-panel"，组件根加此 testid）且**不渲染** MessageList 的输入框（无「消息输入框」placeholder）。
  - 普通会话 → 原样渲染（输入框在场，无 remote-session-panel）。
  - StrictMode 双挂载：render→unmount→render 同会话 → panel 仍在且 store.open 被再次调用（close 后可重开）。
  -（mock resolve-tracking-task 经 vi.mock 或注入 ipc.task。）
- [ ] **Step 2: 跑 RED**。
- [ ] **Step 3: GREEN**——
  - resolve-tracking-task.ts 按上方签名实现（逻辑取自 RemoteSessionEntryButton 的 onClick，纯函数化）。
  - RemoteSessionPanel 根元素加 `data-testid="remote-session-panel"`；组件内 mount effect：`resolveTrackingTask({ id: sessionId, kind, taskId, workspaceId }) → task !== null && store.open(task)`；unmount：`store.close()`。
  - MiddlePanel im 分支：`const isTracking = activeSession?.kind === 'task_execution';` 为 true 时以 `<RemoteSessionPanel sessionId={activeSession.id} workspaceId={activeSession.workspaceId} />` 替换 `<MessageList />` + `<InputToolbar …/>`（头部行原样，**删 RemoteSessionEntryButton 挂载与 import**）。
  - ui.store：删 `remoteSessionView/openRemoteSession/closeRemoteSession` 与 setActiveView 的 remoteSessionView 清理分支（还原为 `set({ activeView: view })`）。
  - 删 RemoteSessionView.tsx/.test.tsx（其测试用例已被 Task 1 面板测试承接）。
- [ ] **Step 4: 跑 GREEN**——`npx pnpm@9.0.0 vitest run src/components/layout/` + `src/components/hub/` 全绿；`npx pnpm@9.0.0 typecheck` 0 error（注意：入口仍在引用 openRemoteSession 会红——Task 3 一并修，本步先跑可先注释报错清单确认范围，最终以 Task 3 后的全绿为准；若 typecheck 因 Task 3 未做而红，允许本任务只跑 vitest，typecheck 门在 Task 3 收口）。
- [ ] **Step 5: Commit**——`git add -A renderer/src && git commit -m "feat: MiddlePanel 跟踪会话直连 RemoteSessionPanel——生命周期挂会话选中，退役独立视图态与头部按钮（spec §12.1）"`

### Task 3: 入口收敛 + 删 RemoteSessionEntryButton

**Files:**
- Modify: `renderer/src/components/workgroup/DelegatedTaskCard.tsx`（菜单项）
- Modify: `renderer/src/components/task-board/TaskDetailPanel.tsx`（路由行按钮）
- Delete: `renderer/src/components/hub/RemoteSessionEntryButton.tsx` + `.test.tsx`
- Test: `renderer/src/components/workgroup/DelegatedTaskCard.test.tsx`、`renderer/src/components/task-board/TaskDetailPanel.test.tsx`（改既有断言）

**Interfaces:**
- Consumes: `useUiStore.setActiveView`、`useSessionStore.setActiveSession`（存在面；若无 setActiveSession 以 session store 实际名 grep 对齐）
- Produces: 无新接口（行为收敛）

- [ ] **Step 1: RED**——两处测试改断言：点击「进入会话」→ `setActiveView('im')` + `setActiveSession(task.executionSessionId)` 被调；`executionSessionId === null` → showToast「任务尚未派发，暂无跟踪会话」且不切换。
- [ ] **Step 2: 跑 RED**。
- [ ] **Step 3: GREEN**——
  - DelegatedTaskCard 菜单项与 TaskDetailPanel 按钮 onClick 统一为：
```ts
if (task.executionSessionId == null) { showToast('任务尚未派发，暂无跟踪会话'); return; }
useUiStore.getState().setActiveView('im');
useSessionStore.getState().setActiveSession(task.executionSessionId);
```
  （session.store 若需先 loadSessions(workspaceId) 保障 sessions 命中，在 setActiveSession 前 `void useSessionStore.getState().loadSessions(task.workspaceId)`。）
  - 删 RemoteSessionEntryButton 两文件；清 MiddlePanel 残留 import。
- [ ] **Step 4: 全量 GREEN + typecheck 0**——`cd renderer && npx pnpm@9.0.0 vitest run` 全绿；`npx pnpm@9.0.0 typecheck` 0 error。
- [ ] **Step 5: Commit**——`git add -A renderer/src && git commit -m "feat: 看板/详情「进入会话」统一收敛为选中跟踪会话；删除 RemoteSessionEntryButton（spec §12.1 单一交互模型）"`

### Task 4: 全量回归 + 真机复验

**Files:** 无新文件（验证任务）。

- [ ] **Step 1**——根 `npx pnpm@9.0.0 typecheck`（0）+ `npx pnpm@9.0.0 test`（electron+renderer 全绿；基线 6419/3655±新增用例）+ 双 ws lint 0 error。
- [ ] **Step 2 真机复验（HMR 即时生效于运行中的 A 实例）**——CDP 驱动：ws2 → 会话 → 点 `#T-011` 跟踪会话 → **无任何额外点击** → 断言：`[data-testid=remote-session-panel]` 在场、流域含湖畔散文正文、镜像里程碑细行穿插、composer 终态「任务已结束」；再建新任务验证流式（「生成中…」）与 steer。
- [ ] **Step 3**——spec §12 尾部追加「已交付（含复验日期）」；commit `docs: spec §12 交付回执`。

---

## Self-Review 记录

- **Spec 覆盖**：§12.1 交互模型→Task 2/3；§12.2 穿插→Task 1；§12.3 降级矩阵→Task 1 Step5；§12.4 composer→Task 1 平移；§12.5 改动面边界（纯 renderer）→全部任务文件清单吻合。无缺口。
- **占位扫描**：无 TBD；「grep 对齐 setActiveSession 实名」是单点查找动作非留白（session.store 既有面）。
- **类型一致性**：resolveTrackingTask 签名 Task 2 定义=组件消费；RemoteSessionPanel props 两任务一致；mirrorRows Task 1 定义=面板消费。
- **Review Focus 五条**均有测试锚点（Task 2 Step1 双挂载 / Task 1 Step5 tie-break 与四态 / Task 3 Step1 目标缺失 / Task 4 Step2 composer 终态真机）。
