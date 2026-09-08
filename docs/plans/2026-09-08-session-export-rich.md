# 会话导出富信息实施计划（rich export）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 会话导出从「纯 body」升级为「除思考外全信息」——工具调用+结果、子 agent 委派嵌套回复、todo 快照、失败/中断状态，时间线交错呈现。

**Architecture:** 主进程新增导出专用聚合器（镜像 renderer stream-aggregator 配对规则，跳过 thinking）；markdown-exporter 增加段序列渲染；handler 接线 + dispatch 段按 subStreamSessionId 递归嵌套（深度上限 3）。IPC 契约不变，renderer 零改动。

**Tech Stack:** Electron 主进程（CommonJS + TS strict）、better-sqlite3、vitest。

**Spec:** `docs/specs/2026-09-08-session-export-rich-design.md`。计划相对 spec §4 类型草图的精化：`resultTruncated` 字段不上聚合段（截断是渲染职责，落 markdown-exporter 的 `TOOL_RESULT_MAX_CHARS`）；dispatch 段增补 `subOmitted?` 标记（深度上限时渲染「（深层委派已省略）」，与「查不到子行」区分）。

## Global Constraints

- Node 20：`source ~/.nvm/nvm.sh && nvm use 20`（默认 Node 26 破坏 better-sqlite3）
- pnpm 一律 `npx pnpm@9.0.0`
- TypeScript strict：禁 `any` / `@ts-ignore` / `as any`
- 注释、commit message 以外的文档全中文；标识符英文；Conventional Commits
- electron 单测集中 `electron/tests/`（vitest include 限定）；测试 import 走 `../../src/...`
- 全量门禁 SIGSEGV 为环境 flake：重跑或 `--pool=threads --poolOptions.threads.singleThread` 串行

---

### Task 1: export-aggregator 纯函数（TDD）

**Files:**
- Create: `electron/src/main/im/export-aggregator.ts`
- Test: `electron/tests/im/export-aggregator.test.ts`

**Interfaces:**
- Consumes: `MessageEventRow`（`../storage/messages/events-repo`）、`TodoItem`（`../agent/tools/todo-types`）
- Produces（Task 2/3 依赖）:
  - `export type ExportDispatchStatus = 'queued' | 'executing' | 'completed' | 'failed' | 'timeout' | 'aborted'`
  - `export type ExportSegment = { kind:'text'; text:string } | { kind:'tool'; callId; toolName; args: Record<string,unknown>; result: string|null; success: boolean|null } | { kind:'dispatch'; callId; subStreamSessionId; subAgentName; task; status: ExportDispatchStatus; subMarkdown?: string; subOmitted?: boolean } | { kind:'todo'; items: TodoItem[] }`
  - `export interface ExportAggregateResult { segments: ExportSegment[]; status: 'streaming'|'done'|'failed'|'aborted'; error?: string }`
  - `export function exportAggregateEvents(events: MessageEventRow[]): ExportAggregateResult`

- [ ] **Step 1: 写失败测试**

```typescript
// electron/tests/im/export-aggregator.test.ts
//
// 导出富信息聚合器单测（v2.3.2 spec §4）：时间线交错、跳过 thinking、
// callId 配对、isDispatch 分流、终态收敛、todo 位置快照、畸形事件防御。
import { describe, it, expect } from 'vitest';
import { exportAggregateEvents } from '../../src/main/im/export-aggregator';
import type { MessageEventRow } from '../../src/main/storage/messages/events-repo';

let seq = 0;
function ev(eventType: MessageEventRow['eventType'], payload: Record<string, unknown>): MessageEventRow {
  seq += 1;
  return { id: `e-${seq}`, messageId: 'm-1', seq, eventType, payload, createdAt: seq };
}

describe('exportAggregateEvents', () => {
  it('text 聚合为相邻段、thinking 完全排除', () => {
    const r = exportAggregateEvents([
      ev('thinking_delta', { delta: '内心独白' }),
      ev('text_delta', { delta: '先看' }),
      ev('text_delta', { delta: '目录' }),
      ev('final', { status: 'done' }),
    ]);
    expect(r.segments).toEqual([{ kind: 'text', text: '先看目录' }]);
    expect(r.status).toBe('done');
    expect(JSON.stringify(r.segments)).not.toContain('内心独白');
  });

  it('tool start/result 按 callId 配对（含 args/result/success）', () => {
    const r = exportAggregateEvents([
      ev('text_delta', { delta: '查一下' }),
      ev('tool_call_start', { callId: 'c1', toolName: 'list_files', args: { path: '/src' } }),
      ev('tool_call_result', { callId: 'c1', result: 'a.ts', success: true }),
      ev('final', { status: 'done' }),
    ]);
    expect(r.segments).toEqual([
      { kind: 'text', text: '查一下' },
      { kind: 'tool', callId: 'c1', toolName: 'list_files', args: { path: '/src' }, result: 'a.ts', success: true },
    ]);
  });

  it('终态后未配对 tool：done → (未返回结果)；aborted → (已中断)', () => {
    const r1 = exportAggregateEvents([
      ev('tool_call_start', { callId: 'c1', toolName: 'grep', args: {} }),
      ev('final', { status: 'done' }),
    ]);
    expect(r1.segments[0]).toMatchObject({ kind: 'tool', result: '(未返回结果)', success: false });
    const r2 = exportAggregateEvents([
      ev('tool_call_start', { callId: 'c1', toolName: 'grep', args: {} }),
      ev('final', { status: 'aborted' }),
    ]);
    expect(r2.segments[0]).toMatchObject({ result: '(已中断)' });
  });

  it('isDispatch 分流为 dispatch 段，subStatus 回执更新终态', () => {
    const r = exportAggregateEvents([
      ev('tool_call_start', { callId: 'd1', toolName: 'dispatch', isDispatch: true, subStreamSessionId: 'ss-sub', subAgentName: 'tester', args: { task: '验证' } }),
      ev('tool_call_result', { callId: 'd1', subStatus: 'completed' }),
      ev('final', { status: 'done' }),
    ]);
    expect(r.segments).toEqual([
      { kind: 'dispatch', callId: 'd1', subStreamSessionId: 'ss-sub', subAgentName: 'tester', task: '验证', status: 'completed' },
    ]);
  });

  it('dispatch 终态后无回执收敛为 aborted（镜像 UI 防永久执行中）', () => {
    const r = exportAggregateEvents([
      ev('tool_call_start', { callId: 'd1', toolName: 'dispatch', isDispatch: true, subStreamSessionId: 'ss-sub', subAgentName: 't', args: {} }),
      ev('final', { status: 'aborted' }),
    ]);
    expect(r.segments[0]).toMatchObject({ kind: 'dispatch', status: 'aborted' });
  });

  it('todo_update 每次一个位置快照段（非末值胜出）', () => {
    const r = exportAggregateEvents([
      ev('todo_update', { todos: [{ id: '1', subject: 'A', status: 'pending' }] }),
      ev('text_delta', { delta: '做 A' }),
      ev('todo_update', { todos: [{ id: '1', subject: 'A', status: 'completed' }] }),
      ev('final', { status: 'done' }),
    ]);
    expect(r.segments[0]).toMatchObject({ kind: 'todo', items: [{ status: 'pending' }] });
    expect(r.segments[2]).toMatchObject({ kind: 'todo', items: [{ status: 'completed' }] });
  });

  it('final 携带 error 时捕获（status=failed）', () => {
    const r = exportAggregateEvents([
      ev('text_delta', { delta: 'x' }),
      ev('final', { status: 'failed', error: 'provider 429' }),
    ]);
    expect(r.status).toBe('failed');
    expect(r.error).toBe('provider 429');
  });

  it('畸形事件跳过不炸（缺 callId / delta 非字符串）', () => {
    const r = exportAggregateEvents([
      ev('text_delta', { delta: 123 }),
      ev('tool_call_start', { toolName: 'x' }),
      ev('tool_call_result', { result: 'y' }),
      ev('final', { status: 'done' }),
    ]);
    expect(r.segments).toEqual([]);
    expect(r.status).toBe('done');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/im/export-aggregator.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 写实现**

```typescript
// electron/src/main/im/export-aggregator.ts
//
// 会话导出富信息聚合器（rich export，v2.3.2，spec §3/§4）。
// 把单条消息的 message_events 事件流聚合为导出段序列——时间线交错呈现，
// 跳过 thinking_delta（用户裁定：思考不进导出）。
//
// 镜像关系：配对规则镜像 renderer stream-aggregator.ts（callId 配对 /
// isDispatch 分流 / 终态收敛），差异仅三点（见各 case 注释）。主进程无法
// import renderer 源码（electron tsconfig rootDir: src 封死），故镜像实现
// + 本单测锁语义。改 stream-aggregator 配对规则时此处必须同步。
import type { MessageEventRow } from '../storage/messages/events-repo';
import type { TodoItem } from '../agent/tools/todo-types';

export type ExportDispatchStatus = 'queued' | 'executing' | 'completed' | 'failed' | 'timeout' | 'aborted';

export type ExportSegment =
  | { kind: 'text'; text: string }
  | {
      kind: 'tool';
      callId: string;
      toolName: string;
      args: Record<string, unknown>;
      result: string | null; // null = 执行中（终态收敛后不会残留）
      success: boolean | null;
    }
  | {
      kind: 'dispatch';
      callId: string;
      subStreamSessionId: string;
      subAgentName: string;
      task: string;
      status: ExportDispatchStatus;
      /** handler 递归填充：子 agent 回复的已渲染 markdown（引块内嵌） */
      subMarkdown?: string;
      /** 深度上限触发时置 true（与「查不到子行」区分，渲染省略标记） */
      subOmitted?: boolean;
    }
  | { kind: 'todo'; items: TodoItem[] };

export interface ExportAggregateResult {
  segments: ExportSegment[];
  status: 'streaming' | 'done' | 'failed' | 'aborted';
  error?: string;
}

export function exportAggregateEvents(events: MessageEventRow[]): ExportAggregateResult {
  const segments: ExportSegment[] = [];
  let status: ExportAggregateResult['status'] = 'streaming';
  let error: string | undefined;

  const appendText = (delta: string): void => {
    const last = segments[segments.length - 1];
    if (last !== undefined && last.kind === 'text') last.text += delta;
    else segments.push({ kind: 'text', text: delta });
  };
  const patchDispatch = (callId: string, next: ExportDispatchStatus): void => {
    for (let i = segments.length - 1; i >= 0; i--) {
      const seg = segments[i]!;
      if (seg.kind === 'dispatch' && seg.callId === callId) {
        seg.status = next;
        break;
      }
    }
  };

  for (const e of events) {
    const p = e.payload;
    switch (e.eventType) {
      case 'thinking_delta':
        break; // 导出排除思考（spec §1 用户裁定）
      case 'text_delta':
        if (typeof p.delta === 'string') appendText(p.delta);
        break;
      case 'tool_call_start': {
        if (typeof p.callId !== 'string' || typeof p.toolName !== 'string') break;
        if (p.isDispatch === true && typeof p.subStreamSessionId === 'string') {
          // P0-6：v2 生产链路 dispatch 以 tool_call_start(isDispatch) 落库
          const args = (p.args as Record<string, unknown>) ?? {};
          segments.push({
            kind: 'dispatch',
            callId: p.callId,
            subStreamSessionId: p.subStreamSessionId,
            subAgentName: typeof p.subAgentName === 'string' ? p.subAgentName : '',
            task: typeof args.task === 'string' ? args.task : '',
            status: 'executing',
          });
          break;
        }
        segments.push({
          kind: 'tool',
          callId: p.callId,
          toolName: p.toolName,
          args: (p.args as Record<string, unknown>) ?? {},
          result: null,
          success: null,
        });
        break;
      }
      case 'tool_call_result': {
        if (typeof p.callId !== 'string') break;
        if (p.subStatus === 'completed' || p.subStatus === 'failed' || p.subStatus === 'timeout') {
          patchDispatch(p.callId, p.subStatus);
          break;
        }
        for (let i = segments.length - 1; i >= 0; i--) {
          const seg = segments[i]!;
          if (seg.kind === 'tool' && seg.callId === p.callId && seg.result === null) {
            seg.result = typeof p.result === 'string' ? p.result : '';
            seg.success = p.success === true;
            break;
          }
        }
        break;
      }
      case 'todo_update':
        // 位置快照语义：每次更新一个段（与 UI 时间线一致），非末值胜出
        if (Array.isArray(p.todos)) segments.push({ kind: 'todo', items: p.todos as TodoItem[] });
        break;
      case 'dispatch_start':
        // 旧形状（v2 生产链路不产生，防御保留——镜像 stream-aggregator）
        if (typeof p.callId === 'string' && typeof p.subStreamSessionId === 'string') {
          segments.push({
            kind: 'dispatch',
            callId: p.callId,
            subStreamSessionId: p.subStreamSessionId,
            subAgentName: typeof p.subAgentName === 'string' ? p.subAgentName : '',
            task: typeof p.task === 'string' ? p.task : '',
            status: 'executing',
          });
        }
        break;
      case 'dispatch_result':
        if (
          typeof p.callId === 'string' &&
          (p.status === 'completed' || p.status === 'failed' || p.status === 'timeout')
        ) {
          patchDispatch(p.callId, p.status);
        }
        break;
      case 'segment_boundary':
        break; // 不参与导出聚合（分段行由 handler 层对齐处理）
      case 'status_change':
      case 'final': {
        if (p.status === 'streaming' || p.status === 'done' || p.status === 'failed' || p.status === 'aborted') {
          status = p.status;
        } else if (e.eventType === 'final' && p.status === undefined) {
          status = 'done'; // 旧形状 final 兜底（镜像 stream-aggregator）
        }
        if (typeof p.error === 'string') error = p.error;
        break;
      }
    }
  }

  // 终态收敛（镜像 stream-aggregator:268-288）：流结束后未回填的 tool/dispatch
  // 收敛为终态展示，防导出里出现永久「执行中」
  if (status !== 'streaming') {
    const pending = status === 'aborted' ? '(已中断)' : '(未返回结果)';
    for (const seg of segments) {
      if (seg.kind === 'tool' && seg.result === null) {
        seg.result = pending;
        seg.success = false;
      } else if (seg.kind === 'dispatch' && (seg.status === 'executing' || seg.status === 'queued')) {
        seg.status = 'aborted';
      }
    }
  }

  return { segments, status, ...(error !== undefined ? { error } : {}) };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/im/export-aggregator.test.ts`
Expected: 8 passed

- [ ] **Step 5: Commit**

```bash
git add electron/src/main/im/export-aggregator.ts electron/tests/im/export-aggregator.test.ts
git commit -m "feat: 导出富信息聚合器 exportAggregateEvents（跳过 thinking，配对/收敛镜像 stream-aggregator）"
```

---

### Task 2: markdown-exporter 富渲染（TDD）

**Files:**
- Modify: `electron/src/main/im/markdown-exporter.ts`
- Test: `electron/tests/im/markdown-exporter.test.ts`（既有文件，追加 describe）

**Interfaces:**
- Consumes: `ExportSegment` / `ExportDispatchStatus`（Task 1）
- Produces（Task 3 依赖）:
  - `ExportMessage` 增可选字段 `rich?: { segments: ExportSegment[]; status: 'streaming'|'done'|'failed'|'aborted'; error?: string }`（legacy-export 传 rich 缺省 → 行为不变）
  - `export const TOOL_RESULT_MAX_CHARS = 2000`
  - `export function renderSubMessage(msg: ExportMessage): string`（子 agent 嵌套渲染，无 `##` 头）

- [ ] **Step 1: 写失败测试**（追加到既有 `electron/tests/im/markdown-exporter.test.ts`，顶部补 import：`import { formatRoomToMarkdown, renderSubMessage, TOOL_RESULT_MAX_CHARS, type ExportMessage } from '../../src/main/im/markdown-exporter';`——若与既有 import 合并则去重）

```typescript
describe('富信息渲染（v2.3.2）', () => {
  const base: ExportMessage = {
    eventId: 'e1', roomId: 'r1', sender: '@a:home', body: '',
    eventType: 'm.room.message', content: {}, timestamp: 1700000000000, botName: 'coder',
  };

  it('段序列交错渲染：text → 工具块 → dispatch → todo', () => {
    const md = formatRoomToMarkdown(
      [{ ...base, rich: { segments: [
        { kind: 'text', text: '先看目录' },
        { kind: 'tool', callId: 'c1', toolName: 'list_files', args: { path: '/src' }, result: 'a.ts', success: true },
        { kind: 'dispatch', callId: 'd1', subStreamSessionId: 'ss-sub', subAgentName: 'tester', task: '验证', status: 'completed', subMarkdown: '**tester** — 2026\n\n验证通过' },
        { kind: 'todo', items: [{ id: '1', subject: 'A', status: 'completed' }, { id: '2', subject: 'B', status: 'in_progress' }, { id: '3', subject: 'C', status: 'pending' }] },
      ], status: 'done' } }],
      { roomName: '测试', roomId: 'r1', exportedAt: new Date(), requestedLimit: 10, actualCount: 1 },
    );
    const iText = md.indexOf('先看目录');
    const iTool = md.indexOf('🔧 **工具** `list_files` → `{"path":"/src"}`');
    const iDisp = md.indexOf('📤 **委派** tester：验证 —— ✅ completed');
    const iTodo = md.indexOf('- ✓ A');
    expect(iText).toBeGreaterThanOrEqual(0);
    expect(iTool).toBeGreaterThan(iText);
    expect(iDisp).toBeGreaterThan(iTool);
    expect(iTodo).toBeGreaterThan(iDisp);
    expect(md).toContain('> a.ts');                       // 结果进引块
    expect(md).toContain('> **tester** — 2026');          // 子回复引块嵌套
    expect(md).toContain('> 验证通过');
    expect(md).toContain('- ◐ B');
    expect(md).toContain('- ○ C');
  });

  it('工具结果截断 2000 字符并标注原长', () => {
    const long = 'x'.repeat(2500);
    const md = formatRoomToMarkdown(
      [{ ...base, rich: { segments: [
        { kind: 'tool', callId: 'c1', toolName: 'grep', args: {}, result: long, success: true },
      ], status: 'done' } }],
      { roomName: 't', roomId: 'r1', exportedAt: new Date(), requestedLimit: 1, actualCount: 1 },
    );
    expect(TOOL_RESULT_MAX_CHARS).toBe(2000);
    expect(md).toContain('（已截断，原文 2500 字符）');
    expect(md).not.toContain('x'.repeat(2001));
  });

  it('无 rich 字段回退纯 body（legacy 兼容路径不变）', () => {
    const md = formatRoomToMarkdown(
      [{ ...base, body: '纯正文' }],
      { roomName: 't', roomId: 'r1', exportedAt: new Date(), requestedLimit: 1, actualCount: 1 },
    );
    expect(md).toContain('纯正文');
    expect(md).not.toContain('🔧');
  });

  it('failed/aborted 消息头带状态标注与错误文本', () => {
    const md = formatRoomToMarkdown(
      [{ ...base, rich: { segments: [{ kind: 'text', text: '部分输出' }], status: 'failed', error: '429' } }],
      { roomName: 't', roomId: 'r1', exportedAt: new Date(), requestedLimit: 1, actualCount: 1 },
    );
    expect(md).toMatch(/## 🤖 coder .*（失败：429）/);
  });

  it('renderSubMessage：无 ## 头、含角色行与段内容', () => {
    const out = renderSubMessage({ ...base, rich: { segments: [{ kind: 'text', text: '子回复' }], status: 'done' } });
    expect(out).not.toContain('## ');
    expect(out).toContain('**coder** — ');
    expect(out).toContain('子回复');
  });

  it('dispatch subOmitted 渲染省略标记；无子内容仅显示状态', () => {
    const mk = (seg: Parameters<typeof renderSubMessage>[0]['rich']): string =>
      formatRoomToMarkdown(
        [{ ...base, rich: seg }],
        { roomName: 't', roomId: 'r1', exportedAt: new Date(), requestedLimit: 1, actualCount: 1 },
      );
    expect(mk({ segments: [{ kind: 'dispatch', callId: 'd1', subStreamSessionId: 's', subAgentName: 't', task: 'x', status: 'completed', subOmitted: true }], status: 'done' })).toContain('（深层委派已省略）');
    expect(mk({ segments: [{ kind: 'dispatch', callId: 'd1', subStreamSessionId: 's', subAgentName: 't', task: 'x', status: 'completed' }], status: 'done' })).toContain('✅ completed');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/im/markdown-exporter.test.ts`
Expected: FAIL（`rich` 字段/`renderSubMessage`/`TOOL_RESULT_MAX_CHARS` 不存在，类型编译错或断言失败）

- [ ] **Step 3: 写实现**（markdown-exporter.ts 改动）

3a. 文件头补 import 与常量：

```typescript
import type { ExportDispatchStatus, ExportSegment } from './export-aggregator';

/** 工具结果导出截断上限（spec §1 用户裁定：固定 2000 字符） */
export const TOOL_RESULT_MAX_CHARS = 2000;
```

3b. `ExportMessage` 接口追加字段（`botName: string | null;` 之后）：

```typescript
  /** 富信息（v2.3.2）：事件聚合段序列；缺省（legacy / 无事件消息）走纯 body 渲染 */
  rich?: {
    segments: ExportSegment[];
    status: 'streaming' | 'done' | 'failed' | 'aborted';
    error?: string;
  };
```

3c. `shortName`/`formatTime` 之后新增渲染辅助 + 状态行辅助：

```typescript
/** 工具结果截断：超限截到 2000 字符并标注原文长度 */
function truncateResult(result: string): string {
  if (result.length <= TOOL_RESULT_MAX_CHARS) return result;
  return `${result.slice(0, TOOL_RESULT_MAX_CHARS)}…（已截断，原文 ${result.length} 字符）`;
}

const DISPATCH_STATUS_ICON: Record<ExportDispatchStatus, string> = {
  queued: '🕒 排队',
  executing: '⏳ 执行中',
  completed: '✅ completed',
  failed: '❌ failed',
  timeout: '⏱ timeout',
  aborted: '🛑 aborted',
};

/** 逐行加 `> ` 前缀（工具结果 / 子 agent 嵌套内容用引块呈现） */
function quoteBlock(markdown: string): string {
  return markdown
    .split('\n')
    .map((line) => `> ${line}`.trimEnd())
    .join('\n');
}

function renderSegments(segments: ExportSegment[]): string {
  let out = '';
  for (const seg of segments) {
    switch (seg.kind) {
      case 'text':
        if (seg.text) out += `${seg.text}\n\n`;
        break;
      case 'tool': {
        out += `🔧 **工具** \`${seg.toolName}\` → \`${JSON.stringify(seg.args)}\`\n\n`;
        const result = seg.result === null ? '（执行中）' : truncateResult(seg.result);
        out += `${quoteBlock(result)}\n\n`;
        break;
      }
      case 'dispatch': {
        out += `📤 **委派** ${seg.subAgentName || '子 agent'}：${seg.task || '（无任务描述）'} —— ${DISPATCH_STATUS_ICON[seg.status]}\n\n`;
        if (seg.subMarkdown !== undefined && seg.subMarkdown.length > 0) {
          out += `${quoteBlock(seg.subMarkdown)}\n\n`;
        } else if (seg.subOmitted === true) {
          out += '> （深层委派已省略）\n\n';
        }
        break;
      }
      case 'todo': {
        for (const item of seg.items) {
          const mark = item.status === 'completed' ? '✓' : item.status === 'in_progress' ? '◐' : '○';
          out += `- ${mark} ${item.subject}\n`;
        }
        out += '\n';
        break;
      }
    }
  }
  return out;
}

/** 消息头状态标注（failed / aborted 时追加） */
function statusSuffix(rich: ExportMessage['rich']): string {
  if (!rich || (rich.status !== 'failed' && rich.status !== 'aborted')) return '';
  const label = rich.status === 'failed' ? '失败' : '已中断';
  return rich.error ? `（${label}：${rich.error}）` : `（${label}）`;
}
```

3d. `renderMessage` 改造（替换现有函数体）：

```typescript
function renderMessage(msg: ExportMessage): string {
  const isBot = msg.botName !== null || msg.sender.startsWith('@bot.');
  const icon = isBot ? '🤖' : '👤';
  const role = isBot ? (msg.botName ?? shortName(msg.sender)) : '用户';
  let out = `## ${icon} ${role} ${msg.sender} — ${formatTime(msg.timestamp)}${statusSuffix(msg.rich)}\n\n`;

  if (msg.rich && msg.rich.segments.length > 0) {
    out += renderSegments(msg.rich.segments);
  } else if (msg.body) {
    out += msg.body + '\n\n';
  }
  return out;
}
```

3e. 文件末尾新增导出（子 agent 嵌套渲染，供 handler 递归填充 `subMarkdown`）：

```typescript
/**
 * 子 agent 消息嵌套渲染（v2.3.2 spec §5）：无 `##` 头（避免污染文档大纲），
 * 角色行 + 段内容，产出被 dispatch 段以引块包裹。
 */
export function renderSubMessage(msg: ExportMessage): string {
  const isBot = msg.botName !== null || msg.sender.startsWith('@bot.');
  const role = isBot ? (msg.botName ?? shortName(msg.sender)) : '用户';
  let out = `**${role}** — ${formatTime(msg.timestamp)}${statusSuffix(msg.rich)}\n\n`;
  if (msg.rich && msg.rich.segments.length > 0) {
    out += renderSegments(msg.rich.segments);
  } else if (msg.body) {
    out += `${msg.body}\n\n`;
  }
  return out;
}
```

同步更新文件头注释「导出器简化为仅输出 body」段落，标注 v2.3.2 富信息渲染已接入（rich 缺省仍走 body）。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/im/markdown-exporter.test.ts`
Expected: 全部通过（含既有用例零回归）

- [ ] **Step 5: Commit**

```bash
git add electron/src/main/im/markdown-exporter.ts electron/tests/im/markdown-exporter.test.ts
git commit -m "feat: markdown-exporter 富信息段渲染（工具/委派/todo/状态标注 + 结果截断 2000）"
```

---

### Task 3: repo 函数 + handler 接线 + 集成测试（TDD）

**Files:**
- Modify: `electron/src/main/storage/messages/repo.ts`（新增 `listMessagesByStreamSessionId`）
- Modify: `electron/src/main/im/session.ipc.handlers.ts`（对齐逻辑提取 + rich 接线 + 递归嵌套）
- Modify: `electron/tests/storage/messages-repo.test.ts`（追加用例）
- Modify: `electron/tests/im/session.ipc.handlers.test.ts`（mock 骨架补新导出）
- Create: `electron/tests/im/export-rich.integration.test.ts`

**Interfaces:**
- Consumes: `exportAggregateEvents`/`ExportSegment`（Task 1）、`renderSubMessage`/`ExportMessage.rich`（Task 2）、`listEventsByMessage`（events-repo 既有）、`listRecentMessagesBySession`（repo 既有）
- Produces: `listMessagesByStreamSessionId(streamSessionId: string): MessageRow[]`（含 `#seg`/`#roll` 后缀子行，created_at 升序）

- [ ] **Step 1: repo 失败测试**（追加到 `electron/tests/storage/messages-repo.test.ts` 的 describe 内）

```typescript
  it('listMessagesByStreamSessionId 命中本体与 #roll/#seg 后缀行，不含他流', () => {
    insertMessage({ id: 'm-base', sessionId: 'r1', sender: '@a:home', eventType: 'm.room.message', body: 'b', streamSessionId: 'ss-1' });
    insertMessage({ id: 'm-roll', sessionId: 'r1', sender: '@a:home', eventType: 'm.room.message', body: 'r', streamSessionId: 'ss-1#roll1' });
    insertMessage({ id: 'm-other', sessionId: 'r1', sender: '@a:home', eventType: 'm.room.message', body: 'o', streamSessionId: 'ss-2' });
    const rows = listMessagesByStreamSessionId('ss-1');
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.id).sort()).toEqual(['m-base', 'm-roll']);
  });
```

import 行补 `listMessagesByStreamSessionId`。（同毫秒双插入的顺序确定性由实现里的 `ORDER BY created_at ASC, rowid ASC` 保证。）

- [ ] **Step 2: repo 实现**（messages/repo.ts，`getMessageByStreamSessionId` 之后）

```typescript
/**
 * 取指定流会话的全部消息行（含 `#seg`/`#roll` 后缀子行），按时间升序。
 * 用途：导出富信息 dispatch 段嵌套展开子 agent 回复（v2.3.2 spec §5）。
 * ssi 由系统内部生成（s- 前缀 + UUID/后缀），无 LIKE 元字符，前缀匹配安全。
 */
export function listMessagesByStreamSessionId(streamSessionId: string): MessageRow[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT * FROM messages
       WHERE stream_session_id = ?1 OR stream_session_id LIKE ?1 || '#%'
       ORDER BY created_at ASC, rowid ASC`,
    )
    .all(streamSessionId) as SqlRow[];
  return rows.map(rowToCamel);
}
```

- [ ] **Step 3: 跑 repo 测试确认通过**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/storage/messages-repo.test.ts`
Expected: 全部通过

- [ ] **Step 4: 既有 handler 测试骨架修补**（`electron/tests/im/session.ipc.handlers.test.ts`——防新导入名缺失炸 mock）

- `messagesRepoMocks` 补：`listMessagesByStreamSessionId: vi.fn(() => []),`
- 该文件对 `../../src/main/im/markdown-exporter` 的 vi.mock 工厂若为具名导出工厂，补 `renderSubMessage: vi.fn(() => '**子消息**'),`；同时确认未 mock `export-aggregator`（纯函数无需 mock，直接用真实现）
- 跑：`cd electron && npx pnpm@9.0.0 vitest run tests/im/session.ipc.handlers.test.ts` → 全部通过（handler 尚未接线，行为不变）

- [ ] **Step 5: handler 接线**（session.ipc.handlers.ts）

5a. import 区补：

```typescript
import { listMessagesByStreamSessionId } from '../storage/messages/repo'; // 并入既有 repo import
import { exportAggregateEvents, type ExportSegment } from './export-aggregator';
import { renderSubMessage } from './markdown-exporter'; // 并入既有 exporter import
import type { MessageRow } from '../storage/messages/repo';
```

（以文件既有 import 实际路径为准合并，勿重复模块行。）

5b. 模块级新增对齐辅助（把 `session:exportMessages` 内现有「过滤 + segmentsByParent + 父替换 + 孤儿兜底」代码原样搬入，`topLevel` 分流过滤规则）：

```typescript
/**
 * 显示对齐（MessageList.tsx / group-segments.ts 语义）。
 * topLevel=true（主循环）：剔除 dispatch/task_reply 回执与子流顶层条目（子内容由 dispatch 段嵌套承载）。
 * topLevel=false（子展开）：保留 parentStreamSessionId 行（它们就是子内容），仅剔回执。
 */
function alignVisibleEntries(rows: MessageRow[], topLevel: boolean): MessageRow[] {
  const visible = rows.filter((m) => {
    if (m.eventType === 'io.momo.studio.dispatch') return false;
    if (m.eventType === 'io.momo.studio.task_reply') return false;
    if (topLevel && m.parentStreamSessionId) return false;
    return true;
  });
  const segmentsByParent = new Map<string, MessageRow[]>();
  for (const m of rows) {
    if (m.segmentOf === null) continue;
    const list = segmentsByParent.get(m.segmentOf);
    if (list) list.push(m);
    else segmentsByParent.set(m.segmentOf, [m]);
  }
  for (const list of segmentsByParent.values()) {
    list.sort((a, b) => (a.segmentIndex ?? 0) - (b.segmentIndex ?? 0));
  }
  const replacedParents = new Set<string>();
  const entries: MessageRow[] = [];
  for (const m of visible) {
    if (m.segmentOf !== null) continue;
    const segments = m.streamSessionId ? segmentsByParent.get(m.streamSessionId) : undefined;
    if (segments && segments.length > 0 && m.streamSessionId) {
      replacedParents.add(m.streamSessionId);
      entries.push(...segments);
    } else {
      entries.push(m);
    }
  }
  for (const [parentStreamId, segments] of segmentsByParent) {
    if (replacedParents.has(parentStreamId)) continue;
    entries.push(...segments); // 孤儿分段兜底
  }
  entries.sort((a, b) => a.createdAt - b.createdAt);
  return entries;
}
```

5c. `session:exportMessages` handler 体内改造（替换第 2/4 步之间）：

```typescript
      // 2. 显示对齐（提取为 alignVisibleEntries，语义与原内联代码一致）
      const entries = alignVisibleEntries(rows, true);

      // 3. 反查 agent 名字（既有代码不动）
      const botNameMap = new Map<string, string>();
      // ...（原样）

      // 3.5 富信息（v2.3.2）：events → 段序列；dispatch 段递归嵌套子回复（深度上限 3）
      const MAX_DISPATCH_DEPTH = 3;
      // botNameOverride：dispatch 段展开子回复时传 seg.subAgentName——子 agent 的
      // userId 不在 botNameMap 反查索引里也能正确落名（子 agent 名在 start payload 已知）
      const toExport = (m: MessageRow, depth: number, botNameOverride?: string): ExportMessage => ({
        eventId: m.id,
        roomId: m.sessionId,
        sender: m.sender,
        body: m.body,
        eventType: m.eventType,
        content: {},
        timestamp: m.createdAt,
        botName: botNameOverride ?? botNameMap.get(m.sender) ?? null,
        rich: buildRich(m, depth),
      });
      const buildRich = (m: MessageRow, depth: number): ExportMessage['rich'] => {
        const events = listEventsByMessage(m.id);
        if (events.length === 0) return undefined; // 无事件（user/legacy）→ 纯 body 路径
        const agg = exportAggregateEvents(events);
        if (agg.segments.length === 0) return undefined;
        for (const seg of agg.segments) {
          if (seg.kind !== 'dispatch') continue;
          if (depth >= MAX_DISPATCH_DEPTH) {
            seg.subOmitted = true;
            continue;
          }
          const subRows = alignVisibleEntries(listMessagesByStreamSessionId(seg.subStreamSessionId), false);
          const subRendered = subRows.map((s) => renderSubMessage(toExport(s, depth + 1, seg.subAgentName || undefined)));
          if (subRendered.length > 0) seg.subMarkdown = subRendered.join('\n');
        }
        return { segments: agg.segments, status: agg.status, ...(agg.error !== undefined ? { error: agg.error } : {}) };
      };
      const exportMessages = entries.map((m) => toExport(m, 0));
```

（`toExport` 在前、`buildRich` 在后：箭头函数体内对后声明 const 的引用在运行期解析——`toExport` 首次被调用发生在两者都初始化之后，合法无 TDZ 问题。）

后续第 4-6 步（roomName / formatRoomToMarkdown / filename）原样保留，`entries`/`exportMessages` 变量名对接。

- [ ] **Step 6: 集成测试**（Create `electron/tests/im/export-rich.integration.test.ts`）

```typescript
// electron/tests/im/export-rich.integration.test.ts
//
// 导出富信息端到端集成（v2.3.2 spec §7）：真 DB + 真 handler 链——
// listRecentMessagesBySession → alignVisibleEntries → exportAggregateEvents
// → renderSubMessage 嵌套 → formatRoomToMarkdown。锁：时间线交错顺序、
// thinking 排除、截断标注、子 agent 嵌套、无事件消息回退。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const { ipcHandlers } = vi.hoisted(() => ({ ipcHandlers: new Map<string, (...a: unknown[]) => unknown>() }));
vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: (...a: unknown[]) => unknown) => { ipcHandlers.set(ch, fn); } },
}));
vi.mock('../../src/main/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../src/main/memory/extraction', () => ({
  scheduleExtraction: vi.fn(),
  TRIGGER_TURN_INTERVAL: 20,
}));

import { runMigrations, closeDb } from '../../src/main/storage/db';
import { insertMessage } from '../../src/main/storage/messages/repo';
import { insertEvent, nextSeqForMessage } from '../../src/main/storage/messages/events-repo';
import { registerSessionIpcHandlers } from '../../src/main/im/session.ipc.handlers';

const tmpRoot = path.join(os.tmpdir(), `ap-export-rich-${Date.now()}`);
const SESSION = 'sess-rich';

function pushEvent(messageId: string, eventType: Parameters<typeof insertEvent>[0]['eventType'], payload: Record<string, unknown>): void {
  insertEvent({ messageId, seq: nextSeqForMessage(messageId), eventType, payload });
}

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  registerSessionIpcHandlers();
});
afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

describe('session:exportMessages 富信息', () => {
  it('时间线交错 + thinking 排除 + 工具截断 + 子 agent 嵌套 + 无事件回退', async () => {
    // 用户消息（无 events → 纯 body）
    const mu = insertMessage({ sessionId: SESSION, sender: 'owner', eventType: 'm.room.message', body: '帮我检查' });

    // PM agent 消息（含 thinking/工具/委派/todo/final）
    const mp = insertMessage({ sessionId: SESSION, sender: '@coder.x', eventType: 'm.room.message', body: '已检查', streamSessionId: 'ss-pm', status: 'done' });
    pushEvent(mp.id, 'thinking_delta', { delta: '内心策略不外泄' });
    pushEvent(mp.id, 'text_delta', { delta: '先看文件' });
    pushEvent(mp.id, 'tool_call_start', { callId: 'c1', toolName: 'read_file', args: { path: 'a.ts' } });
    pushEvent(mp.id, 'tool_call_result', { callId: 'c1', result: 'y'.repeat(2500), success: true });
    pushEvent(mp.id, 'tool_call_start', { callId: 'd1', toolName: 'dispatch', isDispatch: true, subStreamSessionId: 'ss-sub', subAgentName: 'tester', args: { task: '验证构建' } });
    pushEvent(mp.id, 'todo_update', { todos: [{ id: 't1', subject: '检查', status: 'completed' }] });
    pushEvent(mp.id, 'tool_call_result', { callId: 'd1', subStatus: 'completed' });
    pushEvent(mp.id, 'text_delta', { delta: '完成' });
    pushEvent(mp.id, 'final', { status: 'done' });

    // 子 agent 消息（parentStreamSessionId 指向 PM 流；顶层对齐应剔除、嵌套展开应呈现）
    const ms = insertMessage({ sessionId: SESSION, sender: '@tester.x', eventType: 'm.room.message', body: '子回复', streamSessionId: 'ss-sub', parentStreamSessionId: 'ss-pm', status: 'done' });
    pushEvent(ms.id, 'text_delta', { delta: '构建验证通过' });
    pushEvent(ms.id, 'final', { status: 'done' });

    const handler = ipcHandlers.get('session:exportMessages') as (evt: unknown, sid: string, limit: number) => Promise<{ filename: string; content: string }>;
    const { content } = await handler(null, SESSION, 100);

    // thinking 排除（spec §7-3）
    expect(content).not.toContain('内心策略不外泄');
    // 无事件消息回退（spec §7-5）
    expect(content).toContain('帮我检查');
    // 时间线顺序（spec §7-1）：text → 工具 → 委派 → todo → text
    const order = ['先看文件', '🔧 **工具** `read_file`', '（已截断，原文 2500 字符）', '📤 **委派** tester：验证构建 —— ✅ completed', '- ✓ 检查', '完成']
      .map((s) => content.indexOf(s));
    for (const idx of order) expect(idx).toBeGreaterThanOrEqual(0);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    // 子 agent 嵌套（spec §7-2）：引块内出现子回复，且顶层不重复出现
    expect(content).toContain('> **tester**');
    expect(content).toContain('> 构建验证通过');
    // 子行不作为顶层 ## 条目重复（sender 原文只出现在嵌套引块内）
    const firstTester = content.indexOf('@tester.x');
    expect(content.lastIndexOf('@tester.x')).toBe(firstTester);
  });
});
```

（若 `registerSessionIpcHandlers` 触发的其它模块级副作用在测试环境报错——如 p2p / mcp 桥——按既有 session.ipc.handlers.test.ts 的 mock 清单对相应模块补 vi.mock；原则：仅 mock 进程外副作用，存储与导出链路保持真实现。）

- [ ] **Step 7: 跑集成与既有 handler 测试**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/im/export-rich.integration.test.ts tests/im/session.ipc.handlers.test.ts tests/im/export-aggregator.test.ts tests/im/markdown-exporter.test.ts tests/storage/messages-repo.test.ts`
Expected: 全部通过

- [ ] **Step 8: 门禁**

Run: `npx pnpm@9.0.0 typecheck`（双 workspace clean）→ `npx pnpm@9.0.0 --filter momo-studio-electron test`（全绿；SIGSEGV 重跑或串行）

- [ ] **Step 9: Commit**

```bash
git add electron/src/main/storage/messages/repo.ts electron/src/main/im/session.ipc.handlers.ts electron/tests/storage/messages-repo.test.ts electron/tests/im/session.ipc.handlers.test.ts electron/tests/im/export-rich.integration.test.ts
git commit -m "feat: 会话导出接入富信息——dispatch 嵌套子回复递归展开 + 显示对齐提取"
```

---

## 验收对照（spec §7）

| # | spec 验收 | 锁定测试 |
|---|---|---|
| 1 | 工具块时间线位置 + 截断标注 | T2 截断用例 + T3 集成 order 断言 |
| 2 | dispatch 嵌套子回复（深度 ≤3） | T3 集成嵌套断言 + `MAX_DISPATCH_DEPTH`/`subOmitted`（T2 省略标记用例） |
| 3 | thinking 不出现 | T1 排除用例 + T3 集成 not.toContain |
| 4 | 状态标注 + 收敛终态 | T1 收敛用例 + T2 状态头用例 |
| 5 | legacy/无事件路径不变 | T2 回退用例 + T3 集成「帮我检查」 |
| 6 | 零回归 + typecheck 双 clean | T3 Step 8 门禁 |
