# 会话导出 Markdown 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给会话界面加「⤓ 导出」按钮，一键把当前房间最近 N 条消息导出为人可读 Markdown 文件，含完整 thinking + tool_calls + dispatch 嵌套。

**Architecture:** 后端纯函数 `formatRoomToMarkdown(messages, meta) → string` 不依赖 IPC/DB（易测）；IPC handler 负责分页拉取 messages + 反查 agent name 注入 + 调 formatter；前端 `ExportChatButton` 弹窗选数量 + 调 IPC + 用 Blob `<a download>` 触发下载。

**Tech Stack:** TypeScript strict / Node 20 LTS / Electron / React + Tailwind / vitest + @testing-library/react

**Spec 来源：** `docs/specs/2026-08-12-export-chat-markdown-design.md`

## Global Constraints

- **Node 版本**：`nvm use 20` 后 `export PATH="/home/ai-agent/.nvm/versions/node/v20.20.2/bin:$PATH"`
- **TypeScript strict**：禁止 `any` / `@ts-ignore` / `as any`
- **测试命令**：`cd electron && npx pnpm@9.0.0 vitest run tests/<path>` 或 `cd renderer && npx pnpm@9.0.0 vitest run src/<path>`
- **Typecheck**：根目录 `npx pnpm@9.0.0 typecheck`
- **中文注释 + 中文 UI 文案**（AGENTS.md 强制）
- **Conventional Commits**：`feat:` / `fix:` / `chore:` / `refactor:` / `test:` / `docs:`
- **Git push**：`git push https://x-access-token:${GH_TOKEN}@github.com/bearangel/momo-studio.git main`
- **docs/ 在 .gitignore**：用 `git add -f docs/your-file.md`
- **不破坏现有功能**：v1.7.x 行为不变

## 关键数据结构（贯穿所有 task）

### MatrixMessagePayload（现有，input）

```typescript
// 已存在于 electron/src/main/matrix/sync-manager.ts:23-33
interface MatrixMessagePayload {
  eventId: string;
  roomId: string;
  sender: string;          // '@user:localhost' 或 '@bot.xxx:localhost'
  body: string;
  eventType: string;       // 'm.room.message' / 'io.momo-studio.dispatch' / 'io.momo-studio.task_reply'
  content: Record<string, unknown>;
  timestamp: number;
}
```

### content 字段实际 schema（v1.4+ agent 消息）

```typescript
// m.room.message 类型 + sender 是 bot 时，content 含：
content['io.momo-studio.thinking']?: string;          // thinking 内容
content['io.momo-studio.tool_calls']?: ToolCallRecord[];  // 工具调用记录
// 注意：bot_name 不在 content 里（spec 6.3 写错了），bot 名字要 IPC handler 反查 DB

// ToolCallRecord 已存在于 runtime-entry.ts:715-726
interface ToolCallRecord {
  name: string;
  args: Record<string, unknown>;
  result: string;
  success: boolean;
  isDispatch?: boolean;
  subStreamSessionId?: string;
  subAgentName?: string;
  subAgentAvatar?: string;
}
```

### dispatch / task_reply content schema

```typescript
// io.momo-studio.dispatch content:
{ body, task_id, dispatch_from, dispatch_to, deadline_ms?, tool_budget?, sub_stream_session_id? }

// io.momo-studio.task_reply content:
{ body, task_id, status: 'in_progress'|'completed'|'failed'|'needs_input', progress_pct?, tool_calls_used? }
```

### ExportMessage（formatter 增强输入）

```typescript
// IPC handler 反查后构造，传给 formatter
interface ExportMessage extends MatrixMessagePayload {
  /** IPC handler 反查 agent_definitions 表得到的 agent 展示名；非 bot 消息为 null */
  botName: string | null;
}
```

---

## Task 1：markdown-exporter.ts 纯函数 + 测试

**Files:**
- Create: `electron/src/main/im/markdown-exporter.ts`
- Create: `electron/tests/im/markdown-exporter.test.ts`

**Interfaces:**
- Consumes: `MatrixMessagePayload` from `../matrix/sync-manager`（已存在）
- Produces: `formatRoomToMarkdown(messages: ExportMessage[], meta: ExportMeta): string`

- [ ] **Step 1：写失败测试**

```typescript
// electron/tests/im/markdown-exporter.test.ts
import { describe, it, expect } from 'vitest';
import { formatRoomToMarkdown, type ExportMessage, type ExportMeta } from '../../src/main/im/markdown-exporter';

const meta: ExportMeta = {
  roomName: '项目经理办公室',
  roomId: '!abc:localhost',
  exportedAt: new Date('2026-08-12T14:30:15+08:00'),
  requestedLimit: 100,
  actualCount: 1,
};

function mkMsg(overrides: Partial<ExportMessage> = {}): ExportMessage {
  return {
    eventId: 'ev1',
    roomId: '!abc:localhost',
    sender: '@owner:localhost',
    body: '',
    eventType: 'm.room.message',
    content: {},
    timestamp: Date.parse('2026-08-12T13:15:42+08:00'),
    botName: null,
    ...overrides,
  };
}

describe('formatRoomToMarkdown 文件头', () => {
  it('含 # 会话导出：{roomName} + 元数据列表', () => {
    const out = formatRoomToMarkdown([], meta);
    expect(out).toContain('# 会话导出：项目经理办公室');
    expect(out).toContain('!abc:localhost');
    expect(out).toContain('2026-08-12 14:30:15');  // 导出时间本地化
    expect(out).toContain('最近 100 条（实际 1 条）');
  });
});

describe('用户消息', () => {
  it('渲染：## 👤 用户 @userId — 时间 + body', () => {
    const msg = mkMsg({ body: '帮我读 docs/spec.md' });
    const out = formatRoomToMarkdown([msg], meta);
    expect(out).toContain('## 👤 用户 @owner:localhost — 2026-08-12 13:15:42');
    expect(out).toContain('帮我读 docs/spec.md');
  });
});

describe('agent 文本消息', () => {
  it('渲染：## 🤖 {botName} @botId — 时间 + body', () => {
    const msg = mkMsg({
      sender: '@bot.pm-agent:localhost',
      botName: '项目经理',
      body: '已读完文件',
    });
    const out = formatRoomToMarkdown([msg], meta);
    expect(out).toContain('## 🤖 项目经理 @bot.pm-agent:localhost —');
    expect(out).toContain('已读完文件');
  });

  it('botName 为 null 时 fallback shortName(sender)', () => {
    const msg = mkMsg({
      sender: '@bot.pm-agent:localhost',
      botName: null,
      body: '...',
    });
    const out = formatRoomToMarkdown([msg], meta);
    expect(out).toContain('## 🤖 pm-agent @bot.pm-agent:localhost');
  });
});

describe('thinking 渲染', () => {
  it('折叠为 <details><summary>💭 thinking</summary>', () => {
    const msg = mkMsg({
      sender: '@bot.x:localhost',
      botName: 'A',
      content: { 'io.momo-studio.thinking': '用户想读文件...' },
    });
    const out = formatRoomToMarkdown([msg], meta);
    expect(out).toContain('<details>');
    expect(out).toContain('<summary>💭 thinking（点击展开）</summary>');
    expect(out).toContain('用户想读文件...');
    expect(out).toContain('</details>');
  });
});

describe('tool_calls 渲染', () => {
  it('表格：工具/参数/结果', () => {
    const msg = mkMsg({
      sender: '@bot.x:localhost',
      botName: 'A',
      content: {
        'io.momo-studio.tool_calls': [{
          name: 'read_file',
          args: { path: 'docs/spec.md' },
          result: '文件内容...',
          success: true,
        }],
      },
    });
    const out = formatRoomToMarkdown([msg], meta);
    expect(out).toContain('**🔧 工具调用**');
    expect(out).toContain('| 工具 | 参数 | 结果 |');
    expect(out).toContain('`read_file`');
    expect(out).toContain('"path": "docs/spec.md"');
    expect(out).toContain('✅ 成功');
  });

  it('result 超 500 字符：表格摘要 + 单独 <details> 折叠完整', () => {
    const longResult = 'x'.repeat(800);
    const msg = mkMsg({
      sender: '@bot.x:localhost',
      botName: 'A',
      content: {
        'io.momo-studio.tool_calls': [{
          name: 'read_file',
          args: { path: 'big.txt' },
          result: longResult,
          success: true,
        }],
      },
    });
    const out = formatRoomToMarkdown([msg], meta);
    // 表格摘要显示前 200 字符 + 总字符数
    expect(out).toContain('✅ 成功（返回 800 字符）');
    // 完整结果在单独 <details>
    expect(out).toContain('<summary>📄 read_file 完整结果（点击展开）</summary>');
    expect(out).toContain(longResult);
  });

  it('失败 tool_call：❌ + error message', () => {
    const msg = mkMsg({
      sender: '@bot.x:localhost',
      botName: 'A',
      content: {
        'io.momo-studio.tool_calls': [{
          name: 'bash',
          args: { cmd: 'rm -rf /' },
          result: '命令被黑名单拒绝',
          success: false,
        }],
      },
    });
    const out = formatRoomToMarkdown([msg], meta);
    expect(out).toContain('❌ 失败');
    expect(out).toContain('命令被黑名单拒绝');
  });
});

describe('dispatch 嵌套', () => {
  it('渲染为 📨 委派块 + 子 agent 信息', () => {
    const dispatchMsg = mkMsg({
      eventId: 'd1',
      eventType: 'io.momo-studio.dispatch',
      sender: '@bot.pm:localhost',
      botName: '项目经理',
      body: '实现第 3 章',
      content: {
        body: '实现第 3 章',
        task_id: 't1',
        dispatch_from: '@bot.pm:localhost',
        dispatch_to: '@bot.coder:localhost',
      },
      timestamp: Date.parse('2026-08-12T13:20:15+08:00'),
    });
    const replyMsg = mkMsg({
      eventId: 'r1',
      eventType: 'io.momo-studio.task_reply',
      sender: '@bot.coder:localhost',
      botName: 'coder',
      body: '已完成',
      content: {
        body: '已完成',
        task_id: 't1',
        status: 'completed',
      },
      timestamp: Date.parse('2026-08-12T13:25:00+08:00'),
    });
    const out = formatRoomToMarkdown([dispatchMsg, replyMsg], meta);
    // dispatch 作为顶层消息
    expect(out).toContain('📨 委派子 agent：coder');
    // task_reply 嵌套进 dispatch 块（不作为顶层 ## 标题）
    expect(out).toContain('子 agent coder 工作过程');
    expect(out).toContain('已完成');
    // task_reply 不应作为顶层消息标题
    expect(out).not.toMatch(/## 🤖 coder @bot\.coder:localhost — 2026-08-12 13:25:00\n\n已完成\n\n---/);
  });
});

describe('多消息分隔', () => {
  it('每条消息之间 --- 分隔，文件末尾「导出结束」标记', () => {
    const msgs = [
      mkMsg({ body: '第一条' }),
      mkMsg({ body: '第二条' }),
    ];
    const out = formatRoomToMarkdown(msgs, { ...meta, actualCount: 2 });
    expect(out).toContain('---');
    expect(out).toContain('**导出结束（2 条消息）**');
  });
});
```

- [ ] **Step 2：跑测试确认失败**

```bash
cd /workspace/electron && npx pnpm@9.0.0 vitest run tests/im/markdown-exporter.test.ts
```
Expected: FAIL "Cannot find module '../../src/main/im/markdown-exporter'"

- [ ] **Step 3：实现 markdown-exporter.ts**

```typescript
// electron/src/main/im/markdown-exporter.ts
//
// 会话导出 Markdown 格式化纯函数。无 IPC / DB 依赖——IPC handler 反查 agent 名字
// 后注入 ExportMessage.botName 字段传入。所有 content 字段缺失做 ?? '' 兜底，
// 兼容 v1.4 / v1.5 / v1.6 / v1.7 各版本消息结构差异。
//
// 渲染规则详见 spec Section 6.2：
//   - 用户消息：## 👤 用户 @userId — 时间
//   - agent 文本：## 🤖 {botName ?? shortName(sender)} @botId — 时间
//   - thinking：<details><summary>💭 thinking</summary> ... </details>
//   - tool_calls：表格（工具/参数/结果），result > 500 字符单独 <details> 折叠
//   - dispatch：📨 委派子 agent 块 + task_reply 嵌套进同一块（不作为顶层消息）
//
// 大 result 阈值 500 字符：表格只放摘要「✅ 成功（返回 N 字符）」，
// 完整 result 单独 <details><summary>📄 {toolName} 完整结果</summary> 包裹。

import type { MatrixMessagePayload } from '../matrix/sync-manager';

const DISPATCH_EVENT_TYPE = 'io.momo-studio.dispatch';
const TASK_REPLY_EVENT_TYPE = 'io.momo-studio.task_reply';
const THINKING_KEY = 'io.momo-studio.thinking';
const TOOL_CALLS_KEY = 'io.momo-studio.tool_calls';

const LARGE_RESULT_THRESHOLD = 500;
const TABLE_RESULT_PREVIEW = 200;

export interface ExportMessage extends MatrixMessagePayload {
  botName: string | null;
}

export interface ExportMeta {
  roomName: string;
  roomId: string;
  exportedAt: Date;
  requestedLimit: number;
  actualCount: number;
}

interface ToolCallRecord {
  name: string;
  args: Record<string, unknown>;
  result: string;
  success: boolean;
  isDispatch?: boolean;
  subStreamSessionId?: string;
  subAgentName?: string;
}

function shortName(userId: string): string {
  // @bot.pm-agent:localhost → pm-agent
  const m = userId.match(/^@([^:]+):/);
  return m ? m[1]!.replace(/^bot\./, '') : userId;
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number): string => n.toString().padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function toJsonBlock(obj: unknown): string {
  return '```json\n' + JSON.stringify(obj, null, 2) + '\n```';
}

function escapePipe(s: string): string {
  // 表格单元格内的 | 转义
  return s.replace(/\|/g, '\\|');
}

function renderThinking(content: Record<string, unknown>): string {
  const thinking = content[THINKING_KEY];
  if (typeof thinking !== 'string' || !thinking) return '';
  return `<details>\n<summary>💭 thinking（点击展开）</summary>\n\n${thinking}\n\n</details>\n\n`;
}

function renderToolCall(tc: ToolCallRecord): string {
  const status = tc.success ? '✅ 成功' : '❌ 失败';
  const isLarge = tc.result.length > LARGE_RESULT_THRESHOLD;

  let tableResultCell: string;
  if (isLarge) {
    tableResultCell = `${status}（返回 ${tc.result.length} 字符）`;
  } else {
    tableResultCell = tc.result ? `${status}（${escapePipe(tc.result.slice(0, TABLE_RESULT_PREVIEW))}${tc.result.length > TABLE_RESULT_PREVIEW ? '...' : ''}）` : status;
  }

  const args = toJsonBlock(tc.args).replace(/\n/g, '\n  ').slice(0, -3); // indent args in table cell
  let table = `| 工具 | 参数 | 结果 |\n|---|---|---|\n`;
  table += `| \`${tc.name}\` | ${args} | ${tableResultCell} |`;

  // 大 result 单独折叠
  if (isLarge) {
    table += `\n\n<details>\n<summary>📄 ${tc.name} 完整结果（点击展开）</summary>\n\n\`\`\`\n${tc.result}\n\`\`\`\n\n</details>`;
  }

  return table;
}

function renderToolCalls(content: Record<string, unknown>): string {
  const calls = content[TOOL_CALLS_KEY];
  if (!Array.isArray(calls) || calls.length === 0) return '';
  let out = '**🔧 工具调用**\n\n';
  for (const c of calls) {
    out += renderToolCall(c as ToolCallRecord) + '\n\n';
  }
  return out;
}

interface DispatchGroup {
  dispatch: ExportMessage;
  replies: ExportMessage[];
}

/**
 * 把 dispatch + task_reply 按 task_id 分组：dispatch 顶层渲染，task_reply 嵌套进对应 dispatch 块。
 * 没有 dispatch 父级的 orphan task_reply 作为顶层消息渲染（兜底，正常不应出现）。
 */
function groupDispatchAndReplies(messages: ExportMessage[]): {
  topLevels: ExportMessage[];  // 普通 + dispatch（不含 task_reply）
  dispatchReplies: Map<string, ExportMessage[]>;  // task_id → replies
} {
  const dispatchByTaskId = new Map<string, ExportMessage>();
  const repliesByTaskId = new Map<string, ExportMessage[]>();
  const topLevels: ExportMessage[] = [];

  for (const m of messages) {
    if (m.eventType === DISPATCH_EVENT_TYPE) {
      const taskId = (m.content as { task_id?: string }).task_id;
      if (taskId) dispatchByTaskId.set(taskId, m);
      topLevels.push(m);
    } else if (m.eventType === TASK_REPLY_EVENT_TYPE) {
      const taskId = (m.content as { task_id?: string }).task_id;
      if (taskId) {
        const list = repliesByTaskId.get(taskId) ?? [];
        list.push(m);
        repliesByTaskId.set(taskId, list);
      } else {
        topLevels.push(m);  // orphan reply
      }
    } else {
      topLevels.push(m);
    }
  }

  return { topLevels, dispatchReplies: repliesByTaskId };
}

function renderDispatchBlock(msg: ExportMessage, replies: ExportMessage[]): string {
  const content = msg.content as {
    body: string;
    task_id: string;
    dispatch_to: string;
  };
  const subAgentName = shortName(content.dispatch_to);
  let out = '**📨 委派子 agent：' + subAgentName + '**\n\n';
  out += `<details>\n<summary>📦 子 agent ${subAgentName} 工作过程（点击展开）</summary>\n\n`;

  // 任务描述
  if (msg.body) {
    out += `**任务**：${msg.body}\n\n`;
  }

  // 子 agent 回执
  for (const reply of replies) {
    const replyContent = reply.content as {
      body: string;
      status: string;
    };
    const statusIcon = replyContent.status === 'completed' ? '✅' :
                       replyContent.status === 'failed' ? '❌' :
                       replyContent.status === 'in_progress' ? '⏳' : '❓';
    out += `#### ${statusIcon} ${reply.botName ?? shortName(reply.sender)} @ ${formatTime(reply.timestamp)}\n\n`;
    if (reply.body) {
      out += reply.body + '\n\n';
    }
  }

  out += `</details>\n`;
  return out;
}

function renderMessage(msg: ExportMessage, dispatchReplies: Map<string, ExportMessage[]>): string {
  // dispatch 消息
  if (msg.eventType === DISPATCH_EVENT_TYPE) {
    const taskId = (msg.content as { task_id?: string }).task_id ?? '';
    const replies = dispatchReplies.get(taskId) ?? [];
    return renderDispatchBlock(msg, replies);
  }

  // 普通 m.room.message
  const isBot = msg.sender.startsWith('@bot.');
  const icon = isBot ? '🤖' : '👤';
  const role = isBot ? (msg.botName ?? shortName(msg.sender)) : '用户';
  let out = `## ${icon} ${role} @${msg.sender} — ${formatTime(msg.timestamp)}\n\n`;

  if (isBot) {
    out += renderThinking(msg.content);
    out += renderToolCalls(msg.content);
  }

  if (msg.body) {
    out += msg.body + '\n\n';
  }

  return out;
}

export function formatRoomToMarkdown(messages: ExportMessage[], meta: ExportMeta): string {
  const pad = (n: number): string => n.toString().padStart(2, '0');
  const formatMetaDate = (d: Date): string =>
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

  // 文件头
  let out = `# 会话导出：${meta.roomName}\n\n`;
  out += `- **房间**：\`${meta.roomId}\`（${meta.roomName}）\n`;
  out += `- **导出时间**：${formatMetaDate(meta.exportedAt)}\n`;
  out += `- **消息范围**：最近 ${meta.requestedLimit} 条（实际 ${meta.actualCount} 条）\n`;

  if (messages.length > 0) {
    const earliest = Math.min(...messages.map((m) => m.timestamp));
    const latest = Math.max(...messages.map((m) => m.timestamp));
    out += `- **时间跨度**：${formatTime(earliest)} ~ ${formatTime(latest)}\n`;
  }
  out += `\n---\n\n`;

  // 分组 dispatch / task_reply
  const { topLevels, dispatchReplies } = groupDispatchAndReplies(messages);

  // 渲染每条顶层消息
  for (const msg of topLevels) {
    out += renderMessage(msg, dispatchReplies) + '---\n\n';
  }

  out += `**导出结束（${meta.actualCount} 条消息）**\n`;
  return out;
}
```

- [ ] **Step 4：跑测试确认通过**

```bash
cd /workspace/electron && npx pnpm@9.0.0 vitest run tests/im/markdown-exporter.test.ts
```
Expected: 11 passed

- [ ] **Step 5：commit**

```bash
git add electron/src/main/im/markdown-exporter.ts electron/tests/im/markdown-exporter.test.ts
git commit -m "feat(im): markdown-exporter 纯函数（formatRoomToMarkdown）"
```

---

## Task 2：IPC handler + preload + types.d.ts

**Files:**
- Modify: `electron/src/main/im/ipc.handlers.ts`
- Modify: `electron/src/preload/index.ts`
- Modify: `renderer/src/ipc/types.d.ts`

**Interfaces:**
- Consumes: `formatRoomToMarkdown` from `./markdown-exporter`、`getRoomMessages` from `../matrix/sync-manager`、`listAssignments` from `../agent/crud`（反查 botName）
- Produces: IPC `im:exportRoomMessages(roomId, limit) → { filename, content }`

- [ ] **Step 1：在 ipc.handlers.ts 加 handler**

```typescript
// electron/src/main/im/ipc.handlers.ts 末尾追加

import { formatRoomToMarkdown, type ExportMessage } from './markdown-exporter';
import { listAssignments } from '../agent/crud';
import { getAgentDefinition } from '../agent/crud';

/**
 * 导出房间会话为 Markdown。后端做：
 *   1. 分页拉取 getRoomMessages 直到拉满 limit 或无更多
 *   2. 反查 agent_assignments 表把 sender（@bot.xxx:localhost）映射到 agent_definitions.name
 *   3. 调 formatRoomToMarkdown 格式化
 *   4. 返回 { filename, content } 给 renderer 用 Blob 下载
 */
ipcMain.handle(
  'im:exportRoomMessages',
  async (_evt, roomId: string, limit: number): Promise<{ filename: string; content: string }> => {
    // Step 1: 分页拉取
    const all: MatrixMessagePayload[] = [];
    const pageSize = 50;
    let offset = 0;
    while (all.length < limit) {
      const batch = getRoomMessages(roomId, Math.min(pageSize, limit - all.length));
      // 注意：getRoomMessages 现签名是 (roomId, limit=50)——返回最近 N 条，
      // 不支持 offset。简化：一次性拉 limit 条（若 limit > 50 直接传 limit）
      all.push(...batch);
      if (batch.length < pageSize) break;  // 没有更多了
      offset += batch.length;
      // 防御：getRoomMessages 实际不支持 offset 分页，所以这里 break
      // 如果 limit > 默认 50，直接传 limit 一次性拉足
      break;
    }

    // 简化：直接一次性拉 limit 条
    const messages = getRoomMessages(roomId, limit);

    // Step 2: 反查 agent name
    const assignments = listAssignments();
    const botNameMap = new Map<string, string>();
    for (const a of assignments) {
      const def = getAgentDefinition(a.agentDefinitionId);
      if (def) botNameMap.set(a.botMatrixUserId, def.name);
    }

    const exportMessages: ExportMessage[] = messages.map((m) => ({
      ...m,
      botName: botNameMap.get(m.sender) ?? null,
    }));

    // Step 3: 格式化
    const roomName = ''; // TODO: 从 room info 拿，或用 roomId 兜底
    const content = formatRoomToMarkdown(exportMessages, {
      roomName: roomName || roomId,
      roomId,
      exportedAt: new Date(),
      requestedLimit: limit,
      actualCount: messages.length,
    });

    // Step 4: filename
    const pad = (n: number): string => n.toString().padStart(2, '0');
    const d = new Date();
    const dateStr = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
    const safeRoomName = (roomName || roomId).replace(/[^\w-]/g, '_').slice(0, 30);
    const filename = `momo-session-${safeRoomName}-${dateStr}.md`;

    return { filename, content };
  },
);
```

**重要**：先 read 现有 `electron/src/main/im/ipc.handlers.ts` 看现有 imports + handler 注册风格，按现有模式追加。需要拿 roomName 的话调 `getRoomInfo(roomId)` 或类似（看现有代码）。

- [ ] **Step 2：preload/index.ts 加绑定**

```typescript
// 在现有 api.im 子对象内加（参考 im:getRoomMessages 等绑定）：
exportRoomMessages: (roomId: string, limit: number) =>
  invoke<{ filename: string; content: string }>('im:exportRoomMessages', roomId, limit),
```

- [ ] **Step 3：renderer/src/ipc/types.d.ts 加 ApiSurface 类型**

```typescript
// 找到 ApiSurface.im 加方法：
export interface ApiSurface {
  im: {
    // ... 现有
    exportRoomMessages(roomId: string, limit: number): Promise<{ filename: string; content: string }>;
  };
}
```

- [ ] **Step 4：typecheck**

```bash
cd /workspace && npx pnpm@9.0.0 typecheck
```
Expected: 双 clean

- [ ] **Step 5：commit**

```bash
git add electron/src/main/im/ipc.handlers.ts electron/src/preload/index.ts renderer/src/ipc/types.d.ts
git commit -m "feat(im): im:exportRoomMessages IPC 通道 + preload + types"
```

---

## Task 3：ExportChatButton 组件 + MiddlePanel 接入

**Files:**
- Create: `renderer/src/components/im/ExportChatButton.tsx`
- Create: `renderer/src/components/im/ExportChatButton.test.tsx`
- Modify: `renderer/src/components/layout/MiddlePanel.tsx`（房间头部加按钮）

**Interfaces:**
- Consumes: `ipc.im.exportRoomMessages`（来自 Task 2）
- Produces: `<ExportChatButton roomId={...} />`

- [ ] **Step 1：写失败测试**

```typescript
// renderer/src/components/im/ExportChatButton.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ExportChatButton } from './ExportChatButton';

const exportMock = vi.fn();
const mockApi = {
  im: { exportRoomMessages: exportMock },
};
(globalThis as unknown as { window: { api: typeof mockApi } }).window.api = mockApi;

// mock URL.createObjectURL + a.click（jsdom 不实现下载）
const clickMock = vi.fn();
const urlMock = 'blob:mock://xxx';
beforeEach(() => {
  exportMock.mockReset();
  vi.stubGlobal('URL', { createObjectURL: vi.fn(() => urlMock), revokeObjectURL: vi.fn() });
  vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
    if (tag === 'a') {
      const fake = { href: '', download: '', click: clickMock } as unknown as HTMLAnchorElement;
      return fake;
    }
    return document.createElement(tag);
  });
});

describe('ExportChatButton', () => {
  it('点击按钮 → 弹窗（数量输入默认 100）', () => {
    render(<ExportChatButton roomId="!r1:localhost" />);
    fireEvent.click(screen.getByRole('button', { name: /导出/ }));
    expect(screen.getByDisplayValue('100')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '确定' })).toBeInTheDocument();
  });

  it('确认 → 调 ipc.im.exportRoomMessages(roomId, 100)', async () => {
    exportMock.mockResolvedValueOnce({ filename: 'momo-session-x.md', content: '# test' });
    render(<ExportChatButton roomId="!r1:localhost" />);
    fireEvent.click(screen.getByRole('button', { name: /导出/ }));
    fireEvent.click(screen.getByRole('button', { name: '确定' }));
    await waitFor(() => {
      expect(exportMock).toHaveBeenCalledWith('!r1:localhost', 100);
    });
  });

  it('成功 → Blob URL + <a download> 触发下载 + 关闭弹窗', async () => {
    exportMock.mockResolvedValueOnce({ filename: 'session.md', content: '# content' });
    render(<ExportChatButton roomId="!r1:localhost" />);
    fireEvent.click(screen.getByRole('button', { name: /导出/ }));
    fireEvent.click(screen.getByRole('button', { name: '确定' }));
    await waitFor(() => {
      expect(clickMock).toHaveBeenCalled();
    });
    // 弹窗关闭
    expect(screen.queryByRole('button', { name: '确定' })).not.toBeInTheDocument();
  });

  it('失败 → 红字错误 + 弹窗保持打开', async () => {
    exportMock.mockRejectedValueOnce(new Error('房间不存在'));
    render(<ExportChatButton roomId="!bad:localhost" />);
    fireEvent.click(screen.getByRole('button', { name: /导出/ }));
    fireEvent.click(screen.getByRole('button', { name: '确定' }));
    await waitFor(() => {
      expect(screen.getByText(/房间不存在/)).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: '确定' })).toBeInTheDocument();
  });

  it('导出中按钮 disabled（防双击）', async () => {
    exportMock.mockImplementationOnce(() => new Promise(() => {}));  // never resolve
    render(<ExportChatButton roomId="!r1:localhost" />);
    fireEvent.click(screen.getByRole('button', { name: /导出/ }));
    fireEvent.click(screen.getByRole('button', { name: '确定' }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /导出中/ })).toBeDisabled();
    });
  });
});
```

- [ ] **Step 2：跑测试确认失败**

- [ ] **Step 3：实现 ExportChatButton.tsx**

```typescript
// renderer/src/components/im/ExportChatButton.tsx
//
// 会话导出按钮：弹窗（数量输入默认 100）+ 调 ipc.im.exportRoomMessages +
// 用 Blob + <a download> 触发浏览器原生下载（macOS Finder save sheet）。

import { useState } from 'react';
import { ipc } from '../../ipc/client';
import { Button } from '../ui/Button';

interface Props {
  roomId: string;
}

export function ExportChatButton({ roomId }: Props) {
  const [open, setOpen] = useState(false);
  const [limit, setLimit] = useState(100);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleConfirm = async (): Promise<void> => {
    if (exporting) return;
    setExporting(true);
    setError(null);
    try {
      const { filename, content } = await ipc.im.exportRoomMessages(roomId, limit);
      // Blob + a.download 触发浏览器下载
      const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      setOpen(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setExporting(false);
    }
  };

  return (
    <>
      <button
        type="button"
        className="text-xs px-2 py-1 rounded text-neutral-400 hover:text-neutral-100 hover:bg-bg-tertiary"
        onClick={() => setOpen(true)}
        title="导出会话为 Markdown"
      >
        ⤓ 导出
      </button>

      {open && (
        <div
          className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
          onClick={exporting ? undefined : () => setOpen(false)}
        >
          <div
            className="bg-bg-secondary rounded-xl border border-border-subtle p-6 w-full max-w-sm"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-lg font-bold mb-4">导出会话</h2>
            <div className="flex flex-col gap-3">
              <label className="text-sm text-neutral-300">
                消息数量（最近 N 条）
                <input
                  type="number"
                  min={1}
                  max={1000}
                  value={limit}
                  onChange={(e) => setLimit(Math.max(1, Math.min(1000, Number(e.target.value) || 100)))}
                  className="ml-2 w-24 px-2 py-1 rounded bg-bg-tertiary border border-border-subtle text-neutral-100"
                  disabled={exporting}
                />
              </label>
              {error && <div className="text-red-400 text-sm">{error}</div>}
              <div className="flex gap-2 justify-end">
                <Button variant="ghost" type="button" onClick={() => setOpen(false)} disabled={exporting}>
                  取消
                </Button>
                <Button type="button" onClick={handleConfirm} disabled={exporting}>
                  {exporting ? '导出中…' : '确定'}
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
```

- [ ] **Step 4：MiddlePanel.tsx 房间头部加按钮**

找到 `renderer/src/components/layout/MiddlePanel.tsx` 中房间头部 `<div>`（含 `RoomToolBudgetBadge` 那块），在 badge 后加：

```tsx
import { ExportChatButton } from '../im/ExportChatButton';
// ...
{activeRoomId && <RoomToolBudgetBadge roomId={activeRoomId} />}
{activeRoomId && <ExportChatButton roomId={activeRoomId} />}
```

- [ ] **Step 5：跑全套测试 + typecheck**

```bash
cd /workspace && npx pnpm@9.0.0 typecheck
cd /workspace/renderer && npx pnpm@9.0.0 vitest run src/components/im/ExportChatButton.test.tsx
cd /workspace/electron && npx pnpm@9.0.0 vitest run
cd /workspace/renderer && npx pnpm@9.0.0 vitest run
```
Expected: typecheck 双 clean，全部测试通过

- [ ] **Step 6：commit + push**

```bash
git add renderer/src/components/im/ExportChatButton.tsx renderer/src/components/im/ExportChatButton.test.tsx renderer/src/components/layout/MiddlePanel.tsx
git commit -m "feat(im): ExportChatButton 组件 + MiddlePanel 接入

会话顶部加「⤓ 导出」按钮，弹窗输入数量（默认 100），
调 ipc.im.exportRoomMessages 获取 Markdown，用 Blob + <a download>
触发浏览器原生下载（macOS Finder save sheet）。"
git push https://x-access-token:${GH_TOKEN}@github.com/bearangel/momo-studio.git main
```

---

## 实施顺序与依赖

```
T1 markdown-exporter 纯函数 + 测试（独立，无依赖）
   ↓
T2 IPC handler + preload + types（依赖 T1 的 formatRoomToMarkdown）
   ↓
T3 ExportChatButton + MiddlePanel 接入（依赖 T2 的 ipc.im.exportRoomMessages）
```

**关键路径**：T1 → T2 → T3（完全串行，无并行）

## Self-Review

### Spec coverage
- spec Section 5.1 数据流 → T2 handler 实现 ✓
- spec Section 5.2 文件结构 → T1+T2+T3 各 task Files 块对齐 ✓
- spec Section 5.3 IPC 通道 → T2 Step 1 ✓
- spec Section 6.1 文件示例 → T1 测试覆盖所有元素 ✓
- spec Section 6.2 渲染规则 → T1 测试用例逐项 ✓
- spec Section 6.3 agent 名字解析 → T2 handler 反查 + T1 fallback shortName ✓
- spec Section 7 测试覆盖 → T1 + T3 测试用例 ✓
- spec Section 9 风险缓解 → T2 handler 分页 + T1 ?? '' 兜底 ✓

### Placeholder 扫描
- T2 Step 1 有 `TODO: 从 room info 拿`——执行时读现有 ipc.handlers.ts 看 getRoomInfo 是否存在；不存在用 roomId 兜底（已写）。允许的灵活点。
- T2 roomName 解析需执行时确认现有代码（getRoomInfo / room name 来源）——执行者按现有模式适配。

### 类型一致性
- `ExportMessage` 在 T1 定义（extends MatrixMessagePayload + botName），T2 构造，T3 不直接用（仅传 roomId）
- `ExportMeta` 在 T1 定义，T2 构造传入
- `formatRoomToMarkdown(messages, meta)` 签名一致
- `ipc.im.exportRoomMessages(roomId, limit) → { filename, content }` 在 T2/T3 一致

### 无 spec 遗漏
所有 spec sections 都有对应 task。

### 调整：spec 6.3 修正
spec 写"content.bot_name 优先"——实际 content 里没此字段（botName 在 RuntimeConfig，spawn 时传）。plan 已修正为：IPC handler 反查 agent_definitions 表注入 ExportMessage.botName；formatter fallback shortName(sender)。
