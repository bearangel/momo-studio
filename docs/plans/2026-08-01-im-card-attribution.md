# IM 卡片归属与对话化视觉 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 IM 会话里的 dispatch/task_reply 卡片拥有 agent 归属（头像 + 名字 + 左右对齐），不再是"无主系统通知"。

**Architecture:** 抽取 `MessageFrame` 共享消息外壳（头像 + 名字 + isSelf 对齐气泡），三类消息（普通文本 / dispatch / task_reply）复用。TaskReplyCard 经 prop 获得 senderName 补齐归属；DispatchCard 去掉冗余 from、紧凑显示 target。纯前端，不动 Matrix 协议。

**Tech Stack:** React + TypeScript(strict) + Tailwind + vitest + @testing-library/react

## Global Constraints

- **Node 20 LTS**：先 `nvm use 20`（容器默认 Node 26 会破坏 better-sqlite3）
- **TypeScript strict**：禁止 `any` / `@ts-ignore` / `as any`；ESLint `no-explicit-any: error`
- **中文注释**：所有代码注释、文档用中文；标识符（变量/函数/类型名）英文
- **测试约定**：vitest `globals: false`（须显式 `import { describe, it, expect, vi } from 'vitest'`）；jsdom 环境；store 用 `vi.mock` 组件级隔离；不 `vi.mock('../../ipc/client')`
- **包管理**：`npx pnpm@9.0.0`（容器内 pnpm 未全局安装）
- **Conventional Commits**：`feat:` / `refactor:` / `test:`
- **matrix-js-sdk 锁定 ^31.0.0**（本计划不涉及，但勿升级）

## 关联文档

- 设计文档：`docs/specs/2026-08-01-im-card-attribution-design.md`
- 现有组件：`renderer/src/components/im/MessageBubble.tsx`、`DispatchCard.tsx`、`TaskReplyCard.tsx`、`MessageList.tsx`、`avatars.ts`
- bot 名映射：`renderer/src/lib/useBotNames.ts`（`useBotNameMap` 读 `agent.store` 的 assignments + definitions）

---

## 文件结构

```
新增:
  renderer/src/components/im/MessageFrame.tsx          共享消息外壳（头像+名字+对齐气泡）
  renderer/src/components/im/MessageFrame.test.tsx
  renderer/src/components/im/DispatchCard.test.tsx
  renderer/src/components/im/TaskReplyCard.test.tsx
  renderer/src/components/im/MessageBubble.test.tsx
修改:
  renderer/src/components/im/MessageBubble.tsx         普通气泡走 frame；路由透传 isSelf/senderName 给卡片
  renderer/src/components/im/DispatchCard.tsx          走 frame；删冗余 from；保留 useBotNameMap 解析 target
  renderer/src/components/im/TaskReplyCard.tsx         走 frame；props 加 isSelf + senderName（不调 useBotNameMap）
```

---

## Task 1: MessageFrame 共享消息外壳

**Files:**
- Create: `renderer/src/components/im/MessageFrame.tsx`
- Test: `renderer/src/components/im/MessageFrame.test.tsx`

**Interfaces:**
- Produces: `MessageFrame` 组件，签名 `{ message: ImMessage; isSelf: boolean; senderName?: string; bubbleClassName?: string; children: ReactNode }`

- [ ] **Step 1: 写失败测试**

创建 `renderer/src/components/im/MessageFrame.test.tsx`：

```tsx
// renderer/src/components/im/MessageFrame.test.tsx
// MessageFrame 共享消息外壳的渲染行为测试。
// 纯组件，不依赖 store / IPC，无需 vi.mock。
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MessageFrame } from './MessageFrame';
import type { ImMessage } from '../../ipc/types';

const msg: ImMessage = {
  eventId: '$evt:local',
  roomId: '!room:local',
  sender: '@coder:local',
  body: '',
  eventType: 'm.room.message',
  content: {},
  timestamp: 0,
};

describe('MessageFrame', () => {
  it('非自己消息时显示 senderName', () => {
    render(
      <MessageFrame message={msg} isSelf={false} senderName="coder-bot">
        <span>正文</span>
      </MessageFrame>,
    );
    expect(screen.getByText('coder-bot')).toBeInTheDocument();
    expect(screen.getByText('正文')).toBeInTheDocument();
  });

  it('senderName 缺失时回退到 shortName（@coder:local → coder）', () => {
    render(
      <MessageFrame message={msg} isSelf={false}>
        <span>正文</span>
      </MessageFrame>,
    );
    expect(screen.getByText('coder')).toBeInTheDocument();
  });

  it('自己消息（isSelf）时不显示名字', () => {
    render(
      <MessageFrame message={msg} isSelf={true} senderName="coder-bot">
        <span>正文</span>
      </MessageFrame>,
    );
    expect(screen.queryByText('coder-bot')).not.toBeInTheDocument();
  });

  it('bubbleClassName 应用到内层气泡 div', () => {
    render(
      <MessageFrame message={msg} isSelf={false} bubbleClassName="border-accent-purple/40 bg-accent-purple/10">
        <span data-testid="child">x</span>
      </MessageFrame>,
    );
    const bubble = screen.getByTestId('child').parentElement;
    expect(bubble?.className).toContain('border-accent-purple/40');
    expect(bubble?.className).toContain('rounded-lg');
  });

  it('渲染 children', () => {
    render(
      <MessageFrame message={msg} isSelf={false}>
        <span data-testid="child">子内容</span>
      </MessageFrame>,
    );
    expect(screen.getByTestId('child')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd /workspace && source ~/.nvm/nvm.sh && nvm use 20 >/dev/null && npx pnpm@9.0.0 --filter momo-studio-renderer exec vitest run src/components/im/MessageFrame.test.tsx`
Expected: FAIL（`Cannot find module './MessageFrame'` 或导入错误）

- [ ] **Step 3: 实现 MessageFrame**

创建 `renderer/src/components/im/MessageFrame.tsx`：

```tsx
// renderer/src/components/im/MessageFrame.tsx
//
// 消息通用外壳：头像 + 名字 + 左右对齐气泡列。
// 三类消息（普通文本 / dispatch / task_reply）复用，保证视觉一致、归属统一。
// isSelf 决定左右对齐与自己消息隐藏名字（与原 MessageBubble 普通气泡行为一致）。
import type { ReactNode } from 'react';
import type { ImMessage } from '../../ipc/types';
import { cn } from '../../lib/cn';
import { avatarEmoji, shortName } from './avatars';

interface Props {
  message: ImMessage;
  isSelf: boolean;
  /** bot 配置名（优先于 shortName）；自己消息不显示名字 */
  senderName?: string;
  /** 内层气泡 className（边框/背景/文字色由调用方按消息类型决定） */
  bubbleClassName?: string;
  children: ReactNode;
}

export function MessageFrame({ message, isSelf, senderName, bubbleClassName, children }: Props) {
  return (
    <div className={cn('flex gap-2 px-4 py-1', isSelf ? 'flex-row-reverse' : 'flex-row')}>
      <div className="w-8 h-8 shrink-0 rounded-full bg-bg-tertiary flex items-center justify-center text-base select-none">
        {avatarEmoji(message.sender)}
      </div>
      <div className={cn('max-w-[70%] flex flex-col gap-0.5', isSelf ? 'items-end' : 'items-start')}>
        {!isSelf && (
          <span className="text-xs text-neutral-400 px-1">{senderName ?? shortName(message.sender)}</span>
        )}
        <div className={cn('rounded-lg px-3 py-2 text-sm break-words', bubbleClassName)}>
          {children}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd /workspace && source ~/.nvm/nvm.sh && nvm use 20 >/dev/null && npx pnpm@9.0.0 --filter momo-studio-renderer exec vitest run src/components/im/MessageFrame.test.tsx`
Expected: PASS（5 个测试全过）

- [ ] **Step 5: 提交**

```bash
cd /workspace
git add renderer/src/components/im/MessageFrame.tsx renderer/src/components/im/MessageFrame.test.tsx
git commit -m "feat(im): 抽取 MessageFrame 共享消息外壳组件

头像+名字+isSelf 左右对齐气泡列，三类消息复用。
为后续 dispatch/task_reply 卡片对话化重构打基础。"
```

---

## Task 2: DispatchCard 对话化（MessageFrame + 紧凑 target）

**Files:**
- Modify: `renderer/src/components/im/DispatchCard.tsx`（整体重写卡片体）
- Modify: `renderer/src/components/im/MessageBubble.tsx:24-25`（dispatch 路由透传 isSelf/senderName）
- Test: `renderer/src/components/im/DispatchCard.test.tsx`

**Interfaces:**
- Consumes: `MessageFrame`（Task 1）
- Produces: `DispatchCard` props 改为 `{ message: ImMessage; isSelf: boolean; senderName?: string }`

- [ ] **Step 1: 写失败测试**

创建 `renderer/src/components/im/DispatchCard.test.tsx`：

```tsx
// renderer/src/components/im/DispatchCard.test.tsx
// DispatchCard 对话化后的渲染行为：归属（frame 头）+ 紧凑 target + 解析失败回退。
// useBotNameMap 读 agent.store，用 vi.mock 隔离成受控映射。
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ImMessage } from '../../ipc/types';

// 受控 botNameMap：主 agent + 子 agent 各一条
vi.mock('../../lib/useBotNames', () => ({
  useBotNameMap: () => new Map([['@coordinator:local', '协调员'], ['@coder:local', '码农']]),
  resolveBotName: (userId: string, m: Map<string, string>) => m.get(userId) ?? userId,
}));

import { DispatchCard } from './DispatchCard';

function makeDispatch(overrides: Partial<ImMessage> = {}): ImMessage {
  return {
    eventId: '$d1:local',
    roomId: '!team:local',
    sender: '@coordinator:local',
    body: '',
    eventType: 'io.momo-studio.dispatch',
    content: {
      body: '请实现登录页',
      task_id: 'task-abc1234567',
      dispatch_from: '@coordinator:local',
      dispatch_to: '@coder:local',
    },
    timestamp: 0,
    ...overrides,
  };
}

describe('DispatchCard', () => {
  it('frame 头显示主 agent 配置名（协调员）', () => {
    render(<DispatchCard message={makeDispatch()} isSelf={false} senderName="协调员" />);
    // 名字由 MessageFrame 渲染（senderName prop）
    expect(screen.getByText('协调员')).toBeInTheDocument();
  });

  it('卡片内紧凑显示目标 agent（→ 码农）', () => {
    render(<DispatchCard message={makeDispatch()} isSelf={false} senderName="协调员" />);
    expect(screen.getByText('码农')).toBeInTheDocument();
    expect(screen.getByText('→')).toBeInTheDocument();
  });

  it('显示 task_id 前 8 位', () => {
    render(<DispatchCard message={makeDispatch()} isSelf={false} senderName="协调员" />);
    expect(screen.getByText('#task-abc')).toBeInTheDocument();
  });

  it('渲染 body markdown', () => {
    render(<DispatchCard message={makeDispatch()} isSelf={false} senderName="协调员" />);
    expect(screen.getByText('请实现登录页')).toBeInTheDocument();
  });

  it('有 deadline_ms 时显示截止时间', () => {
    const msg = makeDispatch({
      content: {
        body: '任务',
        task_id: 'task-abc1234567',
        dispatch_from: '@coordinator:local',
        dispatch_to: '@coder:local',
        deadline_ms: 1800000000000,
      },
    });
    render(<DispatchCard message={msg} isSelf={false} senderName="协调员" />);
    expect(screen.getByText(/截止/)).toBeInTheDocument();
  });

  it('无 deadline_ms 时不显示截止', () => {
    render(<DispatchCard message={makeDispatch()} isSelf={false} senderName="协调员" />);
    expect(screen.queryByText(/截止/)).not.toBeInTheDocument();
  });

  it('content 缺 task_id 时回退为普通气泡（仍走 frame 保留归属）', () => {
    const msg = makeDispatch({ content: { body: '畸形', dispatch_from: '@c:local', dispatch_to: '@d:local' } });
    render(<DispatchCard message={msg} isSelf={false} senderName="协调员" />);
    expect(screen.getByText('畸形')).toBeInTheDocument();
    expect(screen.getByText('协调员')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd /workspace && source ~/.nvm/nvm.sh && nvm use 20 >/dev/null && npx pnpm@9.0.0 --filter momo-studio-renderer exec vitest run src/components/im/DispatchCard.test.tsx`
Expected: FAIL（DispatchCard 不接 isSelf/senderName props；或"码农"找不到因仍渲染 from→to 双行）

- [ ] **Step 3: 重写 DispatchCard**

整体替换 `renderer/src/components/im/DispatchCard.tsx`：

```tsx
// renderer/src/components/im/DispatchCard.tsx
//
// dispatch 消息卡片：主 agent 向子 agent 调度任务。
// 字段取自 io.momo-studio.dispatch event content：
//   dispatch_from → dispatch_to, body, task_id, deadline_ms?
// 对话化重构：走 MessageFrame（frame 头 = 主 agent 头像+名 = dispatch_from），
// 卡片内只紧凑显示 target（dispatch_to），去除冗余 from。
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ImMessage } from '../../ipc/types';
import { cn } from '../../lib/cn';
import { avatarEmoji } from './avatars';
import { useBotNameMap, resolveBotName } from '../../lib/useBotNames';
import { MessageFrame } from './MessageFrame';

interface Props {
  message: ImMessage;
  isSelf: boolean;
  senderName?: string;
}

interface DispatchFields {
  body: string;
  taskId: string;
  from: string;
  to: string;
  deadlineMs?: number;
}

/** 从 message.content 安全解析 dispatch 字段；缺关键字段时返回 null（调用方回退普通渲染） */
function readDispatch(content: Record<string, unknown> | undefined): DispatchFields | null {
  if (!content) return null;
  const taskId = content.task_id;
  const from = content.dispatch_from;
  const to = content.dispatch_to;
  if (typeof taskId !== 'string') return null;
  if (typeof from !== 'string' || typeof to !== 'string') return null;
  const deadline = content.deadline_ms;
  return {
    body: typeof content.body === 'string' ? content.body : '',
    taskId,
    from,
    to,
    deadlineMs: typeof deadline === 'number' ? deadline : undefined,
  };
}

export function DispatchCard({ message, isSelf, senderName }: Props) {
  const botNameMap = useBotNameMap();
  const fields = readDispatch(message.content);
  // 解析失败时回退为普通气泡渲染（走 frame 保留归属），保证不丢消息
  if (!fields) {
    return (
      <MessageFrame
        message={message}
        isSelf={isSelf}
        senderName={senderName}
        bubbleClassName="bg-bg-tertiary text-neutral-300"
      >
        {message.body}
      </MessageFrame>
    );
  }

  return (
    <MessageFrame
      message={message}
      isSelf={isSelf}
      senderName={senderName}
      bubbleClassName="border border-accent-purple/40 bg-accent-purple/10"
    >
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="inline-flex items-center rounded bg-accent-purple/20 px-1.5 py-0.5 font-medium text-accent-purple">
          调度
        </span>
        <span className="text-neutral-500">#{fields.taskId.slice(0, 8)}</span>
        <span className="text-neutral-500">→</span>
        <span className="inline-flex items-center gap-1">
          <span aria-hidden>{avatarEmoji(fields.to)}</span>
          <span className="text-neutral-200">{resolveBotName(fields.to, botNameMap)}</span>
        </span>
      </div>

      <div className="mt-1.5 text-sm text-neutral-100 [&_p]:my-0 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0 [&_pre]:overflow-x-auto [&_code]:rounded [&_code]:px-1 [&_code]:py-0.5 [&_code]:bg-black/30">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{fields.body}</ReactMarkdown>
      </div>

      {fields.deadlineMs !== undefined && (
        <div className="mt-1.5 text-xs text-neutral-500">
          截止：{new Date(fields.deadlineMs).toLocaleString()}
        </div>
      )}
    </MessageFrame>
  );
}
```

- [ ] **Step 4: 更新 MessageBubble 的 dispatch 路由透传 props**

修改 `renderer/src/components/im/MessageBubble.tsx` 第 24-26 行，把 dispatch 路由改为透传 isSelf/senderName：

旧代码（第 24-26 行）：
```tsx
  if (message.eventType === 'io.momo-studio.dispatch') {
    return <DispatchCard message={message} />;
  }
```

新代码：
```tsx
  if (message.eventType === 'io.momo-studio.dispatch') {
    return <DispatchCard message={message} isSelf={isSelf} senderName={senderName} />;
  }
```

- [ ] **Step 5: 运行测试确认通过**

Run: `cd /workspace && source ~/.nvm/nvm.sh && nvm use 20 >/dev/null && npx pnpm@9.0.0 --filter momo-studio-renderer exec vitest run src/components/im/DispatchCard.test.tsx`
Expected: PASS（7 个测试全过）

同时跑 typecheck 确认无类型错误：
Run: `cd /workspace && source ~/.nvm/nvm.sh && nvm use 20 >/dev/null && npx pnpm@9.0.0 typecheck 2>&1 | tail -3`
Expected: electron/renderer 双 Done（注：task_reply 路由此时仍传旧 props，下一步修）

- [ ] **Step 6: 提交**

```bash
cd /workspace
git add renderer/src/components/im/DispatchCard.tsx renderer/src/components/im/DispatchCard.test.tsx renderer/src/components/im/MessageBubble.tsx
git commit -m "refactor(im): DispatchCard 对话化（MessageFrame + 紧凑 target）

- 走 MessageFrame：frame 头 = 主 agent 头像+名（= dispatch_from）
- 卡片内去除冗余 from，只紧凑显示 target（→ 🐱 coder）
- 解析失败回退也走 frame，保留归属
- MessageBubble dispatch 路由透传 isSelf/senderName"
```

---

## Task 3: TaskReplyCard 补齐 agent 归属

**Files:**
- Modify: `renderer/src/components/im/TaskReplyCard.tsx`（整体重写卡片体）
- Modify: `renderer/src/components/im/MessageBubble.tsx:27-29`（task_reply 路由透传 isSelf/senderName）
- Test: `renderer/src/components/im/TaskReplyCard.test.tsx`

**Interfaces:**
- Consumes: `MessageFrame`（Task 1）
- Produces: `TaskReplyCard` props 改为 `{ message: ImMessage; isSelf: boolean; senderName?: string }`

- [ ] **Step 1: 写失败测试**

创建 `renderer/src/components/im/TaskReplyCard.test.tsx`：

```tsx
// renderer/src/components/im/TaskReplyCard.test.tsx
// TaskReplyCard 归属修复后的渲染行为。
// 卡片不调 useBotNameMap（senderName 经 prop 传入），无需 mock store。
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ImMessage } from '../../ipc/types';
import { TaskReplyCard } from './TaskReplyCard';

function makeReply(status: string, overrides: Partial<ImMessage> = {}): ImMessage {
  return {
    eventId: '$r1:local',
    roomId: '!team:local',
    sender: '@coder:local',
    body: '',
    eventType: 'io.momo-studio.task_reply',
    content: { body: '任务完成结果', task_id: 'task-abc1234567', status },
    timestamp: 0,
    ...overrides,
  };
}

describe('TaskReplyCard', () => {
  it('frame 头显示子 agent 配置名（码农）', () => {
    render(<TaskReplyCard message={makeReply('completed')} isSelf={false} senderName="码农" />);
    expect(screen.getByText('码农')).toBeInTheDocument();
  });

  it('senderName 缺失时 frame 回退 shortName（@coder:local → coder）', () => {
    render(<TaskReplyCard message={makeReply('completed')} isSelf={false} />);
    expect(screen.getByText('coder')).toBeInTheDocument();
  });

  it.each([
    ['completed', '已完成'],
    ['in_progress', '进行中'],
    ['failed', '失败'],
    ['needs_input', '需补充输入'],
  ])('status=%s 显示对应 label %s', (status, label) => {
    render(<TaskReplyCard message={makeReply(status)} isSelf={false} senderName="码农" />);
    expect(screen.getByText(label)).toBeInTheDocument();
  });

  it('显示 task_id 前 8 位', () => {
    render(<TaskReplyCard message={makeReply('completed')} isSelf={false} senderName="码农" />);
    expect(screen.getByText('#task-abc')).toBeInTheDocument();
  });

  it('渲染 body markdown', () => {
    render(<TaskReplyCard message={makeReply('completed')} isSelf={false} senderName="码农" />);
    expect(screen.getByText('任务完成结果')).toBeInTheDocument();
  });

  it('有 progress_pct 时显示进度条', () => {
    const msg = makeReply('in_progress', {
      content: { body: '处理中', task_id: 'task-abc1234567', status: 'in_progress', progress_pct: 60 },
    });
    const { container } = render(<TaskReplyCard message={msg} isSelf={false} senderName="码农" />);
    const bar = container.querySelector('[style*="width: 60%"]');
    expect(bar).not.toBeNull();
  });

  it('无 progress_pct 时不显示进度条', () => {
    const { container } = render(<TaskReplyCard message={makeReply('completed')} isSelf={false} senderName="码农" />);
    const bar = container.querySelector('[style*="width:');
    expect(bar).toBeNull();
  });

  it('progress_pct 钳到 0-100（150 → 100）', () => {
    const msg = makeReply('in_progress', {
      content: { body: 'x', task_id: 'task-abc1234567', status: 'in_progress', progress_pct: 150 },
    });
    const { container } = render(<TaskReplyCard message={msg} isSelf={false} senderName="码农" />);
    const bar = container.querySelector('[style*="width: 100%"]');
    expect(bar).not.toBeNull();
  });

  it('content 缺 task_id 时回退普通气泡（仍走 frame 保留归属）', () => {
    const msg = makeReply('completed', { content: { body: '畸形', status: 'completed' } });
    render(<TaskReplyCard message={msg} isSelf={false} senderName="码农" />);
    expect(screen.getByText('畸形')).toBeInTheDocument();
    expect(screen.getByText('码农')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd /workspace && source ~/.nvm/nvm.sh && nvm use 20 >/dev/null && npx pnpm@9.0.0 --filter momo-studio-renderer exec vitest run src/components/im/TaskReplyCard.test.tsx`
Expected: FAIL（TaskReplyCard 不接 isSelf/senderName props）

- [ ] **Step 3: 重写 TaskReplyCard**

整体替换 `renderer/src/components/im/TaskReplyCard.tsx`：

```tsx
// renderer/src/components/im/TaskReplyCard.tsx
//
// task_reply 消息卡片：子 agent 向主 agent 回报任务状态。
// 字段取自 io.momo-studio.task_reply event content：
//   status (in_progress|completed|failed|needs_input), body, task_id, progress_pct?
// 对话化重构：走 MessageFrame（frame 头 = 子 agent 头像+名），补齐此前完全缺失的归属。
// 名字由 senderName prop 传入（MessageFrame 渲染），卡片本身不调 useBotNameMap。
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ImMessage } from '../../ipc/types';
import { cn } from '../../lib/cn';
import { MessageFrame } from './MessageFrame';

interface Props {
  message: ImMessage;
  isSelf: boolean;
  senderName?: string;
}

type ReplyStatus = 'in_progress' | 'completed' | 'failed' | 'needs_input';

interface TaskReplyFields {
  body: string;
  taskId: string;
  status: ReplyStatus;
  progressPct?: number;
}

const VALID_STATUSES: ReadonlySet<ReplyStatus> = new Set([
  'in_progress',
  'completed',
  'failed',
  'needs_input',
]);

const STATUS_STYLE: Record<
  ReplyStatus,
  { label: string; border: string; bg: string; text: string; bar: string }
> = {
  completed: {
    label: '已完成',
    border: 'border-status-success/40',
    bg: 'bg-status-success/10',
    text: 'text-status-success',
    bar: 'bg-status-success',
  },
  in_progress: {
    label: '进行中',
    border: 'border-status-info/40',
    bg: 'bg-status-info/10',
    text: 'text-status-info',
    bar: 'bg-status-info',
  },
  failed: {
    label: '失败',
    border: 'border-status-error/40',
    bg: 'bg-status-error/10',
    text: 'text-status-error',
    bar: 'bg-status-error',
  },
  needs_input: {
    label: '需补充输入',
    border: 'border-status-warning/40',
    bg: 'bg-status-warning/10',
    text: 'text-status-warning',
    bar: 'bg-status-warning',
  },
};

/** 从 message.content 安全解析 task_reply 字段；status 非法或缺字段时返回 null */
function readReply(content: Record<string, unknown> | undefined): TaskReplyFields | null {
  if (!content) return null;
  const taskId = content.task_id;
  const status = content.status;
  if (typeof taskId !== 'string') return null;
  if (typeof status !== 'string' || !VALID_STATUSES.has(status as ReplyStatus)) return null;
  const pct = content.progress_pct;
  return {
    body: typeof content.body === 'string' ? content.body : '',
    taskId,
    status: status as ReplyStatus,
    progressPct: typeof pct === 'number' ? pct : undefined,
  };
}

export function TaskReplyCard({ message, isSelf, senderName }: Props) {
  const fields = readReply(message.content);
  // 解析失败时回退为普通气泡渲染（走 frame 保留归属），保证不丢消息
  if (!fields) {
    return (
      <MessageFrame
        message={message}
        isSelf={isSelf}
        senderName={senderName}
        bubbleClassName="bg-bg-tertiary text-neutral-300"
      >
        {message.body}
      </MessageFrame>
    );
  }

  const style = STATUS_STYLE[fields.status];
  const pct =
    fields.progressPct !== undefined ? Math.max(0, Math.min(100, fields.progressPct)) : null;

  return (
    <MessageFrame
      message={message}
      isSelf={isSelf}
      senderName={senderName}
      bubbleClassName={cn('border', style.border, style.bg)}
    >
      <div className="flex items-center gap-2 text-xs">
        <span className={cn('inline-flex items-center rounded px-1.5 py-0.5 font-medium', style.text)}>
          {style.label}
        </span>
        <span className="text-neutral-500">#{fields.taskId.slice(0, 8)}</span>
      </div>

      <div className="mt-1.5 text-sm text-neutral-100 [&_p]:my-0 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0 [&_pre]:overflow-x-auto [&_code]:rounded [&_code]:px-1 [&_code]:py-0.5 [&_code]:bg-black/30">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{fields.body}</ReactMarkdown>
      </div>

      {pct !== null && (
        <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-black/30">
          <div className={cn('h-full rounded-full', style.bar)} style={{ width: `${pct}%` }} />
        </div>
      )}
    </MessageFrame>
  );
}
```

- [ ] **Step 4: 更新 MessageBubble 的 task_reply 路由透传 props**

修改 `renderer/src/components/im/MessageBubble.tsx`，把 task_reply 路由也透传（此时与 Task 2 改过的 dispatch 路由并列）：

旧代码（第 27-29 行）：
```tsx
  if (message.eventType === 'io.momo-studio.task_reply') {
    return <TaskReplyCard message={message} />;
  }
```

新代码：
```tsx
  if (message.eventType === 'io.momo-studio.task_reply') {
    return <TaskReplyCard message={message} isSelf={isSelf} senderName={senderName} />;
  }
```

- [ ] **Step 5: 运行测试确认通过**

Run: `cd /workspace && source ~/.nvm/nvm.sh && nvm use 20 >/dev/null && npx pnpm@9.0.0 --filter momo-studio-renderer exec vitest run src/components/im/TaskReplyCard.test.tsx`
Expected: PASS（12 个测试全过：2 个归属 + it.each 展开 4 个 status + 6 个其他）

- [ ] **Step 6: 提交**

```bash
cd /workspace
git add renderer/src/components/im/TaskReplyCard.tsx renderer/src/components/im/TaskReplyCard.test.tsx renderer/src/components/im/MessageBubble.tsx
git commit -m "feat(im): TaskReplyCard 补齐 agent 归属（此前完全缺失）

- 走 MessageFrame：frame 头 = 子 agent 头像+名（核心收益）
- 多子 agent 并行回报时现在可视觉区分是谁
- 状态 label 降为紧凑徽章 pill
- 解析失败回退也走 frame，保留归属
- MessageBubble task_reply 路由透传 isSelf/senderName"
```

---

## Task 4: MessageBubble 普通气泡走 MessageFrame + 路由测试

**Files:**
- Modify: `renderer/src/components/im/MessageBubble.tsx`（普通气泡分支改用 MessageFrame）
- Test: `renderer/src/components/im/MessageBubble.test.tsx`

**Interfaces:**
- Consumes: `MessageFrame`（Task 1）、`DispatchCard`（Task 2）、`TaskReplyCard`（Task 3）
- Produces: `MessageBubble` 三类消息统一走 MessageFrame 外壳

- [ ] **Step 1: 写失败测试**

创建 `renderer/src/components/im/MessageBubble.test.tsx`：

```tsx
// renderer/src/components/im/MessageBubble.test.tsx
// MessageBubble 路由行为：按 eventType 分发到 DispatchCard/TaskReplyCard/普通气泡，
// 并正确透传 isSelf + senderName。用 vi.mock 把卡片替换为可控桩，隔离 store 依赖。
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ImMessage } from '../../ipc/types';

// 把两个卡片 mock 成带 testid 的桩，便于断言"哪个被渲染"+ 捕获 props
vi.mock('./DispatchCard', () => ({
  DispatchCard: (props: { senderName?: string; isSelf: boolean }) => (
    <div data-testid="dispatch" data-self={String(props.isSelf)} data-name={props.senderName ?? ''} />
  ),
}));
vi.mock('./TaskReplyCard', () => ({
  TaskReplyCard: (props: { senderName?: string; isSelf: boolean }) => (
    <div data-testid="task-reply" data-self={String(props.isSelf)} data-name={props.senderName ?? ''} />
  ),
}));

import { MessageBubble } from './MessageBubble';

describe('MessageBubble 路由', () => {
  it('io.momo-studio.dispatch → DispatchCard', () => {
    const msg: ImMessage = {
      eventId: '$1', roomId: '!r', sender: '@bot:local', body: '',
      eventType: 'io.momo-studio.dispatch', content: {}, timestamp: 0,
    };
    render(<MessageBubble message={msg} isSelf={false} senderName="协调员" />);
    expect(screen.getByTestId('dispatch')).toBeInTheDocument();
    expect(screen.queryByTestId('task-reply')).not.toBeInTheDocument();
  });

  it('dispatch 透传 isSelf + senderName', () => {
    const msg: ImMessage = {
      eventId: '$1', roomId: '!r', sender: '@bot:local', body: '',
      eventType: 'io.momo-studio.dispatch', content: {}, timestamp: 0,
    };
    render(<MessageBubble message={msg} isSelf={true} senderName="协调员" />);
    const card = screen.getByTestId('dispatch');
    expect(card).toHaveAttribute('data-self', 'true');
    expect(card).toHaveAttribute('data-name', '协调员');
  });

  it('io.momo-studio.task_reply → TaskReplyCard', () => {
    const msg: ImMessage = {
      eventId: '$1', roomId: '!r', sender: '@bot:local', body: '',
      eventType: 'io.momo-studio.task_reply', content: {}, timestamp: 0,
    };
    render(<MessageBubble message={msg} isSelf={false} senderName="码农" />);
    expect(screen.getByTestId('task-reply')).toBeInTheDocument();
    expect(screen.queryByTestId('dispatch')).not.toBeInTheDocument();
  });

  it('task_reply 透传 isSelf + senderName', () => {
    const msg: ImMessage = {
      eventId: '$1', roomId: '!r', sender: '@bot:local', body: '',
      eventType: 'io.momo-studio.task_reply', content: {}, timestamp: 0,
    };
    render(<MessageBubble message={msg} isSelf={false} senderName="码农" />);
    const card = screen.getByTestId('task-reply');
    expect(card).toHaveAttribute('data-self', 'false');
    expect(card).toHaveAttribute('data-name', '码农');
  });

  it('m.room.message → 普通气泡（走 MessageFrame，显示 body）', () => {
    const msg: ImMessage = {
      eventId: '$1', roomId: '!r', sender: '@bot:local', body: '你好',
      eventType: 'm.room.message', content: {}, timestamp: 0,
    };
    render(<MessageBubble message={msg} isSelf={false} senderName="码农" />);
    expect(screen.getByText('你好')).toBeInTheDocument();
    expect(screen.getByText('码农')).toBeInTheDocument();
    expect(screen.queryByTestId('dispatch')).not.toBeInTheDocument();
    expect(screen.queryByTestId('task-reply')).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd /workspace && source ~/.nvm/nvm.sh && nvm use 20 >/dev/null && npx pnpm@9.0.0 --filter momo-studio-renderer exec vitest run src/components/im/MessageBubble.test.tsx`
Expected: FAIL（"你好"断言可能通过，但路由透传断言会因桩未生效或 import 顺序失败——确认失败后继续）

- [ ] **Step 3: 重写 MessageBubble 普通气泡分支走 MessageFrame**

整体替换 `renderer/src/components/im/MessageBubble.tsx`：

```tsx
// renderer/src/components/im/MessageBubble.tsx
//
// 单条消息渲染入口。根据 eventType 分发：
//   - io.momo-studio.dispatch   → DispatchCard（紫色，走 MessageFrame）
//   - io.momo-studio.task_reply → TaskReplyCard（状态色，走 MessageFrame）
//   - 其余（m.room.message 等）   → 普通气泡（走 MessageFrame，自己蓝/他人灰）
// 三类消息统一走 MessageFrame 外壳，视觉一致、归属统一。
// 消息体统一用 react-markdown 渲染（支持 GFM 表格、删除线等）。
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ImMessage } from '../../ipc/types';
import { cn } from '../../lib/cn';
import { DispatchCard } from './DispatchCard';
import { TaskReplyCard } from './TaskReplyCard';
import { MessageFrame } from './MessageFrame';

interface Props {
  message: ImMessage;
  isSelf: boolean;
  /** bot 的配置名称（如有），优先于 shortName 展示 */
  senderName?: string;
}

export function MessageBubble({ message, isSelf, senderName }: Props) {
  if (message.eventType === 'io.momo-studio.dispatch') {
    return <DispatchCard message={message} isSelf={isSelf} senderName={senderName} />;
  }
  if (message.eventType === 'io.momo-studio.task_reply') {
    return <TaskReplyCard message={message} isSelf={isSelf} senderName={senderName} />;
  }

  return (
    <MessageFrame
      message={message}
      isSelf={isSelf}
      senderName={senderName}
      bubbleClassName={cn(isSelf ? 'bg-accent-blue text-white' : 'bg-bg-tertiary text-neutral-100')}
    >
      {/* react-markdown 渲染消息体；p 元素默认有 margin，用样式覆盖 */}
      <div className="[&_p]:my-0 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0 [&_pre]:overflow-x-auto [&_code]:rounded [&_code]:px-1 [&_code]:py-0.5 [&_code]:bg-black/30">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.body}</ReactMarkdown>
      </div>
    </MessageFrame>
  );
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd /workspace && source ~/.nvm/nvm.sh && nvm use 20 >/dev/null && npx pnpm@9.0.0 --filter momo-studio-renderer exec vitest run src/components/im/MessageBubble.test.tsx`
Expected: PASS（5 个测试全过）

- [ ] **Step 5: 全量验证 — typecheck + 全部 renderer 测试**

Run typecheck：
```bash
cd /workspace && source ~/.nvm/nvm.sh && nvm use 20 >/dev/null && npx pnpm@9.0.0 typecheck 2>&1 | tail -3
```
Expected: `electron typecheck: Done` + `renderer typecheck: Done`

Run 全部 renderer 测试：
```bash
npx pnpm@9.0.0 --filter momo-studio-renderer exec vitest run 2>&1 | tail -5
```
Expected: 全部 PASS（含新增 4 个 IM 测试文件 + 既有 65 个）

Run 全部 IM 组件测试（确认四文件齐过）：
```bash
npx pnpm@9.0.0 --filter momo-studio-renderer exec vitest run src/components/im/ 2>&1 | tail -5
```
Expected: MessageFrame(5) + DispatchCard(7) + TaskReplyCard(12) + MessageBubble(5) = 29 个 IM 测试全过

- [ ] **Step 6: 提交**

```bash
cd /workspace
git add renderer/src/components/im/MessageBubble.tsx renderer/src/components/im/MessageBubble.test.tsx
git commit -m "refactor(im): MessageBubble 普通气泡走 MessageFrame + 路由测试

- 普通文本气泡分支改用 MessageFrame（与卡片视觉外壳统一）
- 三类消息现在全部走 MessageFrame：头像+名字+isSelf 对齐
- 补 MessageBubble 路由测试（dispatch/task_reply/普通三分支 + 透传断言）"
```

---

## 验收清单（全部 Task 完成后）

对照 `docs/specs/2026-08-01-im-card-attribution-design.md` 的验收标准：

- [ ] 团队群中 task_reply 卡片显示子 agent 头像 + 配置名（Task 3）
- [ ] dispatch 卡片显示主 agent 头像 + 名（frame 头）+ 紧凑 target（Task 2）
- [ ] 三类消息视觉外壳一致（Task 4，全部走 MessageFrame）
- [ ] 解析失败时仍保留归属（Task 2/3 的回退分支走 MessageFrame）
- [ ] `npx pnpm@9.0.0 typecheck` 双 workspace 通过（Task 4 Step 5）
- [ ] `npx pnpm@9.0.0 --filter momo-studio-renderer test` 全部通过（Task 4 Step 5）

## 人工视觉验证（macOS）

提交并 push 后，用户在 macOS 拉取最新代码启动 dev 模式人工核对：

```bash
cd /Users/stbearangel/dev/AiProject/moo-studio  # 或 momo-test
git pull origin main
nvm use 20 && pnpm dev
```

在团队群里 @ 主 agent 派发任务，观察：
1. 调度卡（紫色）左侧出现主 agent 头像 + 名，卡片内 `→ 🐱 子agent名`
2. 进行中卡（蓝色）左侧出现子 agent 头像 + 名
3. 已完成卡（绿色）左侧出现子 agent 头像 + 名
4. 多个子 agent 并行回报时，每条 task_reply 头像/名不同，可视觉区分
5. 卡片宽度收窄到 70%，与普通气泡一致
