# IM 工具条 + 成员浮层 + Agent 上下线标签 — 设计文档

- **日期**: 2026-08-03
- **里程碑**: v1.2 后续优化
- **状态**: 已确认，待编写实施计划

## 背景与需求

当前 IM 会话界面存在三个待优化点：

1. **输入区缺少扩展位**：MessageInput 只有 textarea + @mention，没有工具条容纳未来的输入扩展（附件、表情等）。
2. **成员面板常驻占空间**：MembersPanel 在选房间后始终占据右侧 ~192px，挤压聊天区，尤其在窄窗口下。
3. **Agent 上线消息噪音 + 缺状态可见性**：每次 agent 启动都往团队群发一条 `✅ 已上线，等待任务`，造成消息噪音；但用户又无法直观看到哪些 agent 当前在线/离线。

## 设计目标

1. 在输入框上方加一个工具条（InputToolbar），本次放成员切换按钮，预留扩展位
2. 成员面板改为**按需浮层**（点击工具条按钮打开，浮层覆盖聊天区右侧，backdrop 或按钮关闭）
3. 移除 agent 启动时的上线消息，改为在成员面板用在线/离线 badge 显示运行状态
4. 纯前端改动为主（MembersPanel/InputToolbar/MiddlePanel），主进程仅删 6 行上线消息

## 方案

### 组件 1：InputToolbar（新增）

独立组件，渲染在 chat 列（MessageList 和 MessageInput 之间）：

```
┌─ chat 列 (flex-col) ────────────────┐
│ MessageList (flex-1 overflow-y-auto) │
├──────────────────────────────────────┤
│ InputToolbar                         │
│  [👥 成员]                    [预留]  │
├──────────────────────────────────────┤
│ MessageInput (textarea + @mention)   │
└──────────────────────────────────────┘
```

- 外层 `<div className="flex items-center gap-2 px-3 py-1 border-t border-border-subtle bg-bg-secondary">`
- 成员按钮：`<button>` 切换 `showMembers`，激活时高亮（`bg-accent-blue/20 text-accent-blue`）
- Props：`{ showMembers: boolean; onToggleMembers: () => void; disabled: boolean }`
- `showMembers` 状态提升到 MiddlePanel（MembersPanel 浮层也在该层）

### 组件 2：MembersPanel 改浮层 + 上下线标签

从布局常驻改为 **absolute 定位浮层**：

```tsx
// MiddlePanel IM 视图
<div className="flex-1 flex min-w-0">
  <RoomList />
  <div className="flex-1 flex flex-col min-w-0 relative">   ← chat 列加 relative
    <MessageList />
    <InputToolbar showMembers={showMembers} onToggleMembers={toggle} disabled={!activeRoomId} />
    <MessageInput />
    {showMembers && activeRoomId && (
      <>
        <div className="absolute inset-0 z-20" onClick={close} />  {/* backdrop，仅覆盖 chat 列 */}
        <MembersPanel />                                           {/* 浮层，在 chat 列右侧 */}
      </>
    )}
  </div>
</div>
```

- backdrop + 浮层都在 chat 列的 `relative` 容器内，**不影响 RoomList**（点 RoomList 切房间正常工作）
- MembersPanel `absolute right-0` 相对于 chat 列，浮在聊天区右侧

MembersPanel 自身样式改为：
```tsx
<aside className="absolute right-0 top-0 bottom-0 w-56 bg-bg-secondary border-l border-border-subtle shadow-xl overflow-auto z-30">
```
- `absolute right-0 top-0 bottom-0`：贴右侧，覆盖在 chat 上
- `shadow-xl z-30`：浮层视觉层次，在 backdrop 之上
- 宽度从 `w-48` 改为 `w-56`（224px），浮层模式稍宽更舒适

**在线/离线标签**：MembersPanel 对 `isBot` 成员查 running 状态：

```
🤖 协调员                    [在线]  ← 绿色 badge (bg-status-success/20 text-status-success)
🤖 ui设计师                  [离线]  ← 灰色 badge (bg-bg-tertiary text-neutral-500)
⭐ 你（本地用户）                      ← 无标签
```

数据映射（MembersPanel 新增从 agent.store 取 `assignments` + `running`）：
```ts
const { assignments, running } = useAgentStore();
const isAgentOnline = (userId: string): boolean | null => {
  const a = assignments.find((a) => a.botMatrixUserId === userId);
  if (!a) return null;            // 非 assignment bot，不显示标签
  return running[a.instanceId] === true;
};
// 对 isBot 且 isAgentOnline !== null 的成员显示 在线/离线 badge
```

### 改动 3：移除上线消息

`electron/src/main/agent/runtime-entry.ts` 第 317-322 行，删除：
```ts
await client.sendEvent(
  config.teamRoomId,
  'm.room.message',
  { msgtype: 'm.text', body: '✅ 已上线，等待任务' },
  '',
);
```

同时更新第 314 行注释（原文"在发'已上线'前完成"→ 移除对该消息的引用）。

## 交互细节

### 浮层关闭机制

- **再点按钮**：toggle `showMembers=false`
- **点 backdrop**：透明 backdrop（`absolute inset-0 z-20`）捕获点击 → 关闭
- backdrop 和浮层都在 `relative` 容器内，不影响 RoomList

### 状态联动

- **切换房间**：`selectRoom` 时 reset `showMembers=false`，避免新房间显示旧成员
- **未选房间**：InputToolbar 的成员按钮 `disabled`
- **agent 运行态变化**：`onRuntimeChanged` IPC 已驱动 agent.store 更新 `running`，MembersPanel 自动重渲染标签

## 边界情况

| 情况 | 处理 |
|---|---|
| 切换房间 | 自动关闭浮层（reset showMembers） |
| 未选房间 | 成员按钮 disabled |
| 成员列表为空 | 浮层显示"暂无成员"（map 空数组成员） |
| agent 运行中状态变化 | React 自动重渲染（store 驱动） |
| 非 bot 成员 | 不显示在线/离线标签 |
| bot 成员但无 assignment | 不显示标签（`find()` 返回 null） |

## 改动文件清单

```
新增:
  renderer/src/components/im/InputToolbar.tsx          (~25 行，工具条 + 成员切换按钮)
  renderer/src/components/im/InputToolbar.test.tsx
修改:
  renderer/src/components/layout/MiddlePanel.tsx       (IM 视图：relative + InputToolbar + 浮层 MembersPanel + backdrop + showMembers 状态)
  renderer/src/components/im/MembersPanel.tsx          (absolute 浮层 + 在线/离线 badge + running 状态)
  renderer/src/components/im/MembersPanel.test.tsx     (浮层定位 + badge 渲染)
  electron/src/main/agent/runtime-entry.ts             (删 317-322 上线消息 + 更新注释)
```

## 测试计划

| 测试文件 | 覆盖点 |
|---|---|
| **InputToolbar.test.tsx**（新） | 渲染成员按钮；点击触发 onToggleMembers；showMembers=true 时按钮高亮；disabled 状态 |
| **MembersPanel.test.tsx**（更新） | 浮层定位（absolute right-0）；bot 成员显示在线/离线 badge（mock assignments + running）；非 bot 无 badge；无 assignment 的 bot 无 badge |

## 明确不做（YAGNI）

- ❌ 工具条上的其他按钮（附件、表情等）—— 仅预留位置，本次只放成员切换
- ❌ 成员列表搜索/过滤
- ❌ 在线状态的 Matrix presence 协议 —— 用本地 running 状态
- ❌ 浮层动画/过渡 —— 简单 show/hide
- ❌ MembersPanel 宽度拖拽调整

## 验收标准

1. 输入框上方出现工具条，含一个"成员"按钮
2. 点击"成员"按钮打开浮层成员列表（覆盖聊天区右侧），再点或点外部关闭
3. 切换房间时浮层自动关闭
4. 成员列表中 bot 成员显示"在线"（绿）或"离线"（灰）标签，本地用户和非 bot 无标签
5. agent 启动不再发送"✅ 已上线，等待任务"消息
6. `npx pnpm@9.0.0 typecheck` 双 workspace 通过
7. `npx pnpm@9.0.0 --filter momo-studio-renderer test` 全部通过（含新增/更新测试）
