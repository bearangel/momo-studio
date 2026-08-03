# IM 工具条 + 成员浮层 + Agent 上下线标签 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 IM 输入框上方加工具条（成员切换按钮），成员面板改为按需浮层，移除 agent 上线消息，成员面板显示在线/离线标签。

**Architecture:** InputToolbar 新组件放 MessageList 和 MessageInput 之间；MembersPanel 从布局常驻改为 absolute 浮层（chat 列 relative 容器内），backdrop 点击关闭；MembersPanel 读 agent.store 的 running 状态显示 bot 成员在线/离线 badge；runtime-entry.ts 删 6 行上线消息。

**Tech Stack:** React + TypeScript(strict) + Tailwind + vitest + @testing-library/react

## Global Constraints

- **Node 20 LTS**：先 `nvm use 20`（容器默认 Node 26 破坏 better-sqlite3）
- **TypeScript strict**：禁止 `any` / `@ts-ignore` / `as any`；ESLint `no-explicit-any: error`
- **中文注释**：所有代码注释用中文；标识符英文
- **测试约定**：vitest `globals: false`（须显式 `import { describe, it, expect, vi } from 'vitest'`）；jsdom；store 用 `vi.mock` 组件级隔离
- **包管理**：`npx pnpm@9.0.0`（容器内 pnpm 未全局安装）
- **⚠️ Tailwind 任意值 class 陷阱**：本项目 Tailwind 的 `max-w-[70%]` 等任意值 class **不生成 CSS**（已验证的 bug）。宽度约束必须用 **inline style**（`style={{ maxWidth: '70%' }}`），不能用 Tailwind class。其他标准 Tailwind class（`bg-*`、`border-*`、`absolute`、`z-30` 等）正常。
- **Conventional Commits**：`feat:` / `fix:` / `refactor:` / `chore:`

## 关联文档

- 设计文档：`docs/specs/2026-08-03-im-toolbar-members-overlay-design.md`

---

## 文件结构

```
新增:
  renderer/src/components/im/InputToolbar.tsx           工具条组件（成员切换按钮 + 预留扩展位）
  renderer/src/components/im/InputToolbar.test.tsx
  renderer/src/components/im/MembersPanel.test.tsx
修改:
  renderer/src/components/layout/MiddlePanel.tsx        IM 视图：chat 列加 relative + InputToolbar + showMembers 状态 + backdrop + MembersPanel 浮层
  renderer/src/components/im/MembersPanel.tsx           改 absolute 浮层定位 + 在线/离线 badge + 读 agent.store running
  electron/src/main/agent/runtime-entry.ts              删 317-322 上线消息
```

---

## Task 1: 移除 Agent 上线消息

**Files:**
- Modify: `electron/src/main/agent/runtime-entry.ts:313-322`

**Interfaces:**
- Produces: agent 启动后不再发 `✅ 已上线，等待任务` 到团队群

- [ ] **Step 1: 删除上线消息 + 更新注释**

修改 `electron/src/main/agent/runtime-entry.ts`。

旧代码（约 313-322 行）：
```ts
  // 构建运行时上下文：初始化 SkillRegistry、发现 MCP 工具、合并工具列表、注入 skill 索引。
  // 在发"已上线"前完成，确保首条消息到达时工具已就绪。
  const ctx = await buildRuntimeContext(config);

  await client.sendEvent(
    config.teamRoomId,
    'm.room.message',
    { msgtype: 'm.text', body: '✅ 已上线，等待任务' },
    '',
  );

  client.on(ClientEvent.Event, (event: MatrixEvent) => {
```

新代码：
```ts
  // 构建运行时上下文：初始化 SkillRegistry、发现 MCP 工具、合并工具列表、注入 skill 索引。
  // 在注册事件监听前完成，确保首条消息到达时工具已就绪。
  const ctx = await buildRuntimeContext(config);

  client.on(ClientEvent.Event, (event: MatrixEvent) => {
```

- [ ] **Step 2: 验证 typecheck + agent 测试**

Run:
```bash
cd /workspace && source ~/.nvm/nvm.sh && nvm use 20 >/dev/null
npx pnpm@9.0.0 typecheck 2>&1 | tail -2
npx pnpm@9.0.0 --filter momo-studio-electron exec vitest run tests/agent/ 2>&1 | grep -E "Tests +[0-9]|FAIL" | tail -1
```
Expected: typecheck 双 Done；agent 测试全部通过（上线消息无专门测试断言，不影响）

- [ ] **Step 3: 提交**

```bash
cd /workspace
git add electron/src/main/agent/runtime-entry.ts
git commit -m "feat(agent): 移除 agent 启动上线消息

agent 启动不再往团队群发 '✅ 已上线，等待任务'。
上线状态改为在成员面板用在线/离线 badge 展示（后续 task 实现）。"
```

---

## Task 2: InputToolbar 组件

**Files:**
- Create: `renderer/src/components/im/InputToolbar.tsx`
- Test: `renderer/src/components/im/InputToolbar.test.tsx`

**Interfaces:**
- Produces: `InputToolbar({ showMembers: boolean; onToggleMembers: () => void; disabled: boolean })`

- [ ] **Step 1: 写失败测试**

创建 `renderer/src/components/im/InputToolbar.test.tsx`：

```tsx
// renderer/src/components/im/InputToolbar.test.tsx
// InputToolbar 工具条：成员切换按钮渲染 + 交互。
// 纯展示组件，不依赖 store / IPC，无需 vi.mock。
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { InputToolbar } from './InputToolbar';

describe('InputToolbar', () => {
  it('渲染成员切换按钮', () => {
    render(<InputToolbar showMembers={false} onToggleMembers={() => {}} disabled={false} />);
    expect(screen.getByRole('button', { name: /成员/ })).toBeInTheDocument();
  });

  it('点击成员按钮触发 onToggleMembers', () => {
    const onToggle = vi.fn();
    render(<InputToolbar showMembers={false} onToggleMembers={onToggle} disabled={false} />);
    fireEvent.click(screen.getByRole('button', { name: /成员/ }));
    expect(onToggle).CalledOnce;
  });

  it('showMembers=true 时按钮高亮', () => {
    render(<InputToolbar showMembers={true} onToggleMembers={() => {}} disabled={false} />);
    const btn = screen.getByRole('button', { name: /成员/ });
    expect(btn.className).toContain('accent-blue');
  });

  it('showMembers=false 时按钮不高亮', () => {
    render(<InputToolbar showMembers={false} onToggleMembers={() => {}} disabled={false} />);
    const btn = screen.getByRole('button', { name: /成员/ });
    expect(btn.className).not.toContain('accent-blue');
  });

  it('disabled=true 时按钮禁用', () => {
    render(<InputToolbar showMembers={false} onToggleMembers={() => {}} disabled={true} />);
    expect(screen.getByRole('button', { name: /成员/ })).toBeDisabled();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd /workspace && source ~/.nvm/nvm.sh && nvm use 20 >/dev/null && npx pnpm@9.0.0 --filter momo-studio-renderer exec vitest run src/components/im/InputToolbar.test.tsx`
Expected: FAIL（`Cannot find module './InputToolbar'`）

- [ ] **Step 3: 实现 InputToolbar**

创建 `renderer/src/components/im/InputToolbar.tsx`：

```tsx
// renderer/src/components/im/InputToolbar.tsx
//
// 输入框上方工具条：本次放成员切换按钮，预留扩展位（附件/表情等未来功能）。
// 纯展示组件，状态由 MiddlePanel 管理（showMembers + onToggleMembers）。
import { cn } from '../../lib/cn';

interface Props {
  /** 成员浮层是否打开（按钮高亮） */
  showMembers: boolean;
  /** 切换成员浮层 */
  onToggleMembers: () => void;
  /** 无选中房间时禁用 */
  disabled: boolean;
}

export function InputToolbar({ showMembers, onToggleMembers, disabled }: Props) {
  return (
    <div className="flex items-center gap-2 px-3 py-1 border-t border-border-subtle bg-bg-secondary">
      <button
        type="button"
        onClick={onToggleMembers}
        disabled={disabled}
        aria-label="成员"
        title="查看成员"
        aria-pressed={showMembers}
        className={cn(
          'inline-flex items-center gap-1 rounded px-2 py-1 text-xs transition-colors',
          'disabled:opacity-40 disabled:cursor-not-allowed',
          showMembers
            ? 'bg-accent-blue/20 text-accent-blue'
            : 'text-neutral-400 hover:bg-bg-tertiary hover:text-neutral-200',
        )}
      >
        <span>👥</span>
        <span>成员</span>
      </button>
      {/* 预留扩展位：附件、表情等未来功能 */}
    </div>
  );
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd /workspace && source ~/.nvm/nvm.sh && nvm use 20 >/dev/null && npx pnpm@9.0.0 --filter momo-studio-renderer exec vitest run src/components/im/InputToolbar.test.tsx`
Expected: PASS（5 个测试全过）

- [ ] **Step 5: 提交**

```bash
cd /workspace
git add renderer/src/components/im/InputToolbar.tsx renderer/src/components/im/InputToolbar.test.tsx
git commit -m "feat(im): InputToolbar 工具条组件（成员切换按钮 + 预留扩展位）"
```

---

## Task 3: MembersPanel 在线/离线标签

**Files:**
- Modify: `renderer/src/components/im/MembersPanel.tsx`
- Test: `renderer/src/components/im/MembersPanel.test.tsx`

**Interfaces:**
- Consumes: `useAgentStore()` 的 `{ assignments, running }`
- Produces: MembersPanel bot 成员显示在线/离线 badge（本 task 不改定位，定位在 Task 4 改）

- [ ] **Step 1: 写失败测试**

创建 `renderer/src/components/im/MembersPanel.test.tsx`：

```tsx
// renderer/src/components/im/MembersPanel.test.tsx
// MembersPanel 成员列表：在线/离线 badge 渲染。
// mock im.store（selector 模式）+ agent.store（返回受控 assignments/running）+ useBotNames。
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { AgentAssignment, RoomMember } from '../../ipc/types';

// 受控 agent store 数据
const mockAssignments: AgentAssignment[] = [
  { instanceId: 'inst-online', workspaceId: 'w1', agentDefinitionId: 'd1',
    botMatrixUserId: '@online-bot:local', enabled: true, createdAt: '' },
  { instanceId: 'inst-offline', workspaceId: 'w1', agentDefinitionId: 'd2',
    botMatrixUserId: '@offline-bot:local', enabled: true, createdAt: '' },
];
const mockRunning: Record<string, boolean> = {
  'inst-online': true,
  'inst-offline': false,
};

vi.mock('../../stores/agent.store', () => ({
  useAgentStore: vi.fn(() => ({
    assignments: mockAssignments,
    running: mockRunning,
  })),
}));
vi.mock('../../lib/useBotNames', () => ({
  useBotNameMap: () => new Map([['@online-bot:local', '在线Agent'], ['@offline-bot:local', '离线Agent']]),
  resolveBotName: (userId: string, m: Map<string, string>) => m.get(userId) ?? userId,
}));

import { MembersPanel } from './MembersPanel';

// 模拟 im.store 的 selector 调用
const mockMembers: RoomMember[] = [
  { userId: '@online-bot:local', displayName: '在线Agent', avatarUrl: null, powerLevel: 0, isBot: true, isLocalUser: false },
  { userId: '@offline-bot:local', displayName: '离线Agent', avatarUrl: null, powerLevel: 0, isBot: true, isLocalUser: false },
  { userId: '@no-assign-bot:local', displayName: '无Assignment的Bot', avatarUrl: null, powerLevel: 0, isBot: true, isLocalUser: false },
  { userId: '@local:local', displayName: '我', avatarUrl: null, powerLevel: 100, isBot: false, isLocalUser: true },
];

vi.mock('../../stores/im.store', () => ({
  useImStore: vi.fn((selector?: (s: { members: RoomMember[] }) => unknown) => {
    const state = { members: mockMembers };
    return selector ? selector(state) : state;
  }),
}));

describe('MembersPanel 在线/离线标签', () => {
  it('运行中的 bot 显示"在线"标签', () => {
    render(<MembersPanel />);
    expect(screen.getByText('在线Agent')).toBeInTheDocument();
    expect(screen.getByText('在线')).toBeInTheDocument();
  });

  it('已停止的 bot 显示"离线"标签', () => {
    render(<MembersPanel />);
    expect(screen.getByText('离线Agent')).toBeInTheDocument();
    expect(screen.getByText('离线')).toBeInTheDocument();
  });

  it('无 assignment 的 bot 不显示在线/离线标签', () => {
    render(<MembersPanel />);
    expect(screen.getByText('无Assignment的Bot')).toBeInTheDocument();
    // 在线/离线 badge 各只有一个（在线Agent 和 离线Agent），无Assignment的Bot 没有
    const badges = screen.getAllByText(/在线|离线/);
    expect(badges).toHaveLength(2);
  });

  it('非 bot 成员（本地用户）不显示在线/离线标签', () => {
    render(<MembersPanel />);
    expect(screen.getByText('我')).toBeInTheDocument();
    // 总共只有 2 个 badge（在线Agent + 离线Agent）
    const badges = screen.getAllByText(/^(在线|离线)$/);
    expect(badges).toHaveLength(2);
  });

  it('显示成员数量标题', () => {
    render(<MembersPanel />);
    expect(screen.getByText(/成员（4）/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd /workspace && source ~/.nvm/nvm.sh && nvm use 20 >/dev/null && npx pnpm@9.0.0 --filter momo-studio-renderer exec vitest run src/components/im/MembersPanel.test.tsx`
Expected: FAIL（MembersPanel 当前不显示"在线"/"离线"文字）

- [ ] **Step 3: 重写 MembersPanel（加 badge，保持当前定位）**

整体替换 `renderer/src/components/im/MembersPanel.tsx`：

```tsx
// 群成员侧栏：显示当前选中房间的成员，含身份标识 + agent 在线/离线状态。
// bot 成员通过 agent.store 的 running 状态判断在线/离线，显示对应 badge。
import { useImStore } from '../../stores/im.store';
import { useAgentStore } from '../../stores/agent.store';
import { useBotNameMap } from '../../lib/useBotNames';
import { cn } from '../../lib/cn';

export function MembersPanel() {
  const members = useImStore((s) => s.members);
  const botNameMap = useBotNameMap();
  const { assignments, running } = useAgentStore();

  /** 查 member userId 对应的 agent 是否在运行。无 assignment 返回 null（不显示标签） */
  const isAgentOnline = (userId: string): boolean | null => {
    const a = assignments.find((item) => item.botMatrixUserId === userId);
    if (!a) return null;
    return running[a.instanceId] === true;
  };

  return (
    <aside className="w-48 min-w-[9rem] border-l border-border-subtle bg-bg-secondary overflow-auto">
      <div className="px-3 py-2 text-xs text-neutral-500 border-b border-border-subtle">
        成员（{members.length}）
      </div>
      {members.map((m) => {
        const online = m.isBot ? isAgentOnline(m.userId) : null;
        return (
          <div key={m.userId} className="px-3 py-2 flex items-center gap-2 text-sm text-neutral-300">
            <span>{m.isLocalUser ? '⭐' : m.isBot ? '🤖' : '👤'}</span>
            <span className="truncate flex-1">{botNameMap.get(m.userId) ?? m.displayName}</span>
            {m.powerLevel >= 50 && <span className="text-[10px] text-accent-blue">管理</span>}
            {online !== null && (
              <span
                className={cn(
                  'text-[10px] px-1.5 py-0.5 rounded shrink-0',
                  online
                    ? 'bg-status-success/20 text-status-success'
                    : 'bg-bg-tertiary text-neutral-500',
                )}
              >
                {online ? '在线' : '离线'}
              </span>
            )}
          </div>
        );
      })}
    </aside>
  );
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd /workspace && source ~/.nvm/nvm.sh && nvm use 20 >/dev/null && npx pnpm@9.0.0 --filter momo-studio-renderer exec vitest run src/components/im/MembersPanel.test.tsx`
Expected: PASS（5 个测试全过）

- [ ] **Step 5: 提交**

```bash
cd /workspace
git add renderer/src/components/im/MembersPanel.tsx renderer/src/components/im/MembersPanel.test.tsx
git commit -m "feat(im): MembersPanel bot 成员在线/离线标签

通过 agent.store 的 running 状态判断 bot 成员是否在运行。
运行中显示绿色'在线' badge，已停止显示灰色'离线' badge。
非 bot 成员和无 assignment 的 bot 不显示标签。"
```

---

## Task 4: MiddlePanel 浮层集成

**Files:**
- Modify: `renderer/src/components/layout/MiddlePanel.tsx:67-79`（IM 视图）
- Modify: `renderer/src/components/im/MembersPanel.tsx:13`（aside className 改浮层定位）
- Modify: `renderer/src/components/im/MembersPanel.test.tsx`（更新定位断言）

**Interfaces:**
- Consumes: `InputToolbar`（Task 2）、MembersPanel badge 逻辑（Task 3）
- Produces: 完整的 IM 浮层成员体验（工具条按钮 → 浮层 → backdrop 关闭）

- [ ] **Step 1: 更新 MembersPanel 浮层定位 + 补测试**

修改 `renderer/src/components/im/MembersPanel.tsx`，把 aside 的 className 从布局常驻改为浮层定位。

旧（Task 3 产出）：
```tsx
    <aside className="w-48 min-w-[9rem] border-l border-border-subtle bg-bg-secondary overflow-auto">
```

新：
```tsx
    <aside className="absolute right-0 top-0 bottom-0 w-56 border-l border-border-subtle bg-bg-secondary shadow-xl overflow-auto z-30">
```

在 `renderer/src/components/im/MembersPanel.test.tsx` 末尾的 `describe` 块内追加一个定位测试：

```tsx
  it('浮层定位为 absolute right-0（覆盖模式）', () => {
    const { container } = render(<MembersPanel />);
    const aside = container.querySelector('aside');
    expect(aside?.className).toContain('absolute');
    expect(aside?.className).toContain('right-0');
    expect(aside?.className).toContain('z-30');
  });
```

Run: `cd /workspace && source ~/.nvm/nvm.sh && nvm use 20 >/dev/null && npx pnpm@9.0.0 --filter momo-studio-renderer exec vitest run src/components/im/MembersPanel.test.tsx`
Expected: PASS（6 个测试，含新定位测试）

- [ ] **Step 2: 改写 MiddlePanel IM 视图**

修改 `renderer/src/components/layout/MiddlePanel.tsx`。

1. 在文件顶部 import 区追加（约第 14 行 `import { MembersPanel }` 之后）：

```ts
import { InputToolbar } from '../im/InputToolbar';
```

2. 在 `MiddlePanel` 函数体内，`activeRoomId` 声明之后追加 showMembers 状态。找到现有的 `const activeRoomId = useImStore((s) => s.activeRoomId);` 行，在其下方追加：

```ts
  const [showMembers, setShowMembers] = useState(false);
```

（`useState` 已在文件顶部 import，无需额外引入。）

3. 替换整个 IM 视图分支（旧代码约第 67-79 行）。

旧代码：
```tsx
  // im 视图：左侧房间列表 + 中间消息流和输入框 + 右侧成员面板
  if (activeView === 'im') {
    return (
      <div className="flex-1 flex min-w-0">
        <RoomList />
        <div className="flex-1 flex flex-col min-w-0">
          <MessageList />
          <MessageInput />
        </div>
        {activeRoomId && <MembersPanel />}
      </div>
    );
  }
```

新代码：
```tsx
  // im 视图：左侧房间列表 + 中间消息流和工具条和输入框 + 成员浮层（按需）
  if (activeView === 'im') {
    return (
      <div className="flex-1 flex min-w-0">
        <RoomList />
        <div className="flex-1 flex flex-col min-w-0 relative">
          <MessageList />
          <InputToolbar
            showMembers={showMembers}
            onToggleMembers={() => setShowMembers((v) => !v)}
            disabled={!activeRoomId}
          />
          <MessageInput />
          {showMembers && activeRoomId && (
            <>
              {/* 透明 backdrop：点击关闭浮层（仅覆盖 chat 列，不影响 RoomList） */}
              <div
                className="absolute inset-0 z-20"
                onClick={() => setShowMembers(false)}
                data-testid="members-backdrop"
              />
              <MembersPanel />
            </>
          )}
        </div>
      </div>
    );
  }
```

4. 在 `selectRoom` 触发时关闭浮层。找到 MiddlePanel 中没有直接的 selectRoom（它在 RoomList 内），所以用 `activeRoomId` 的变化来 reset。

在 MiddlePanel 函数体内，`showMembers` 状态声明之后追加 useEffect：

```ts
  // 切换房间时关闭成员浮层，避免新房间显示旧成员
  useEffect(() => {
    setShowMembers(false);
  }, [activeRoomId]);
```

在文件顶部 import 区追加（如果 `useEffect` 尚未 import）：

```ts
import { useCallback, useEffect, useState } from 'react';
```

（当前文件第 4 行是 `import { useCallback, useState } from 'react';`，改为加上 `useEffect`。）

- [ ] **Step 3: 全量验证**

Run:
```bash
cd /workspace && source ~/.nvm/nvm.sh && nvm use 20 >/dev/null
npx pnpm@9.0.0 typecheck 2>&1 | tail -2
npx pnpm@9.0.0 --filter momo-studio-renderer exec vitest run src/components/im/ 2>&1 | grep -E "Tests +[0-9]|FAIL" | tail -1
```
Expected: typecheck 双 Done；IM 测试全部通过（InputToolbar 5 + MembersPanel 6 + 既有 MessageFrame 5 + DispatchCard 7 + TaskReplyCard 12 + MessageBubble 5 = 40）

- [ ] **Step 4: 提交**

```bash
cd /workspace
git add renderer/src/components/layout/MiddlePanel.tsx renderer/src/components/im/MembersPanel.tsx renderer/src/components/im/MembersPanel.test.tsx
git commit -m "feat(im): MiddlePanel 浮层集成（工具条 + 成员按需浮层 + backdrop）

- chat 列加 relative + InputToolbar（MessageList 和 MessageInput 之间）
- showMembers 状态 + 切房间自动关闭
- MembersPanel 改 absolute right-0 浮层定位（shadow-xl z-30）
- 透明 backdrop 点击关闭（仅覆盖 chat 列，不影响 RoomList）"
```

---

## 验收清单（全部 Task 完成后）

对照 `docs/specs/2026-08-03-im-toolbar-members-overlay-design.md` 的验收标准：

- [ ] 输入框上方出现工具条，含"成员"按钮（Task 2 + 4）
- [ ] 点"成员"按钮打开浮层，再点或点 backdrop 关闭（Task 4）
- [ ] 切换房间时浮层自动关闭（Task 4 useEffect）
- [ ] bot 成员显示"在线"（绿）/ "离线"（灰）标签（Task 3）
- [ ] agent 启动不再发上线消息（Task 1）
- [ ] `npx pnpm@9.0.0 typecheck` 双 workspace 通过（Task 4 Step 3）
- [ ] `npx pnpm@9.0.0 --filter momo-studio-renderer test` 全部通过（Task 4 Step 3）

## 人工视觉验证（macOS）

```bash
cd /Users/stbearangel/dev/AiProject/momo-studio
git pull origin main
pnpm dev
```

在团队群里验证：
1. 输入框上方有工具条 + 👥成员 按钮
2. 点成员按钮 → 右侧浮层滑出（覆盖聊天右侧），显示成员列表 + bot 在线/离线标签
3. 点浮层外部（backdrop）或再点按钮 → 浮层关闭
4. 切换房间 → 浮层自动关闭
5. 启动/停止 agent → 成员列表的在线/离线标签实时更新
6. agent 启动时团队群不再出现"✅ 已上线"消息
