# 内联 Pill 富输入块（RichComposer）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地 `docs/specs/2026-09-17-rich-composer-inline-pills-design.md`——contentEditable 富输入块替换 textarea，五类引用（agent/文件/任务/技能/命令）成为文字流内联原子 pill。

**Architecture:** 三层：`composer-segments.ts`（纯函数：segments 类型/序列化/草稿）→ `RichComposer.tsx`（非受控 contentEditable 编辑面：pill 插删/光标/IME 保护，暴露 handle）→ `MentionInput.tsx` 集成（菜单/搜索/📎/发送链路复用，退役三数组和 chip 行）。IPC 契约与主进程零改动。

**Tech Stack:** React 18 非受控 contentEditable + Selection/Range DOM API + Tailwind 语义 token（含 `status-violet` / `status-warning-tint` / `accent-600/10`）+ Vitest/jsdom + Playwright。

## Global Constraints

- **TypeScript strict**：禁 `any` / `@ts-ignore` / `as any`；ESLint `no-explicit-any: error`
- **UI 设计系统**：只用语义 token，禁标准 Tailwind 色阶、禁 inline 硬编码色、禁 emoji 图标（pill 用文字 sigil `@`/`#`/`/` + 语义底色区分类型——设计已裁定不加图标）
- **注释全部中文**；Conventional Commits
- **测试位置**：renderer 贴源 colocated；根 `tests/e2e/` 仅 Playwright
- **Node 20**（`source ~/.nvm/nvm.sh && nvm use 20`）；`npx pnpm@9.0.0`
- **IPC 契约零改动**：`sendMessage(body, mentionedInstanceIds, context)` 三参形状与语义不变；不碰 `electron/src/**`（Task 4 ABI 重建除外）
- 运行测试：`cd renderer && npx pnpm@9.0.0 vitest run src/components/im/<文件>`

---

### Task 1: composer-segments 纯函数层

**Files:**
- Create: `renderer/src/components/im/composer-segments.ts`
- Test: `renderer/src/components/im/composer-segments.test.ts`

**Interfaces:**
- Produces（Task 2/3 依赖，签名逐字）:
  - `type PillKind = 'agent' | 'file' | 'task' | 'skill' | 'command'`
  - `interface TextSeg { type: 'text'; text: string }`
  - `interface PillSeg { type: 'pill'; kind: PillKind; id: string; label: string }`
  - `type ComposerSegment = TextSeg | PillSeg`
  - `interface ComposerPayload { body: string; mentions?: string[]; context?: MessageContext }`
  - `serializeSegments(segs: ComposerSegment[]): ComposerPayload`
  - `segmentsToDraft(segs: ComposerSegment[]): string`
  - `draftToSegments(raw: string | null | undefined): ComposerSegment[]`

- [ ] **Step 1: 写失败测试**（`composer-segments.test.ts` 全文）

```ts
// segments 纯函数层：五类 pill 序列化规则 + 草稿往返。规则表 = spec §3。
import { describe, it, expect } from 'vitest';
import {
  serializeSegments,
  segmentsToDraft,
  draftToSegments,
  type PillSeg,
} from './composer-segments';

const agent = (id: string, label: string): PillSeg => ({ type: 'pill', kind: 'agent', id, label });
const file = (path: string): PillSeg => ({ type: 'pill', kind: 'file', id: path, label: path });
const task = (id: string, title: string): PillSeg => ({ type: 'pill', kind: 'task', id, label: title });
const skill = (slug: string, name: string): PillSeg => ({ type: 'pill', kind: 'skill', id: slug, label: name });
const command = (name: string): PillSeg => ({ type: 'pill', kind: 'command', id: name, label: name });

describe('serializeSegments（spec §3 序列化规则表）', () => {
  it('五类混排：body 标记形态 + mentions/context 归位', () => {
    const r = serializeSegments([
      agent('inst-1', 'coder'),
      { type: 'text', text: ' 审查 ' },
      file('src/a.ts'),
      task('T-3', '修复登录'),
      skill('code-review', '代码审查'),
      command('compact'),
    ]);
    expect(r.body).toBe('@coder 审查 @src/a.ts#T-3/compact');
    expect(r.mentions).toEqual(['inst-1']);
    expect(r.context).toEqual({
      skills: [{ slug: 'code-review', name: '代码审查' }],
      files: [{ path: 'src/a.ts' }],
    });
  });

  it('技能不进正文（v2.11 语义：展开块由主进程注入，防双重曝光）', () => {
    const r = serializeSegments([skill('s1', '技能一')]);
    expect(r.body).toBe('');
    expect(r.context?.skills).toEqual([{ slug: 's1', name: '技能一' }]);
  });

  it('空 body + 仅技能 pill：context 有值（合法发送判定依据）', () => {
    const r = serializeSegments([skill('s1', 'x')]);
    expect(r.body).toBe('');
    expect(r.context).toBeDefined();
    expect(r.mentions).toBeUndefined();
  });

  it('命令 pill → body 恰为 /name（整串拦截语义由序列化形态自然保持）', () => {
    expect(serializeSegments([command('compact')]).body).toBe('/compact');
    // 混排时不是纯命令串
    expect(serializeSegments([{ type: 'text', text: 'hi ' }, command('compact')]).body).toBe('hi /compact');
  });

  it('重复 pill：body 保留全部出现，结构化数组按 id/slug/path 去重（保序）', () => {
    const r = serializeSegments([
      agent('i1', 'a'), agent('i1', 'a'),
      file('f.ts'), file('f.ts'),
      skill('s1', 'x'), skill('s1', 'x'),
    ]);
    expect(r.body).toBe('@a@af.tsf.ts');
    expect(r.mentions).toEqual(['i1']);
    expect(r.context?.files).toEqual([{ path: 'f.ts' }]);
    expect(r.context?.skills).toEqual([{ slug: 's1', name: 'x' }]);
  });

  it('纯文本与空数组', () => {
    expect(serializeSegments([])).toEqual({ body: '' });
    expect(serializeSegments([{ type: 'text', text: '你好' }])).toEqual({ body: '你好' });
  });
});

describe('草稿往返（segmentsToDraft / draftToSegments）', () => {
  it('round-trip：pill 与文本不丢', () => {
    const segs: Parameters<typeof segmentsToDraft>[0] = [
      { type: 'text', text: '帮 ' },
      agent('i1', 'coder'),
      { type: 'text', text: ' 看 ' },
      file('a.ts'),
    ];
    expect(draftToSegments(segmentsToDraft(segs))).toEqual(segs);
  });

  it('旧纯文本草稿 / null / 非法 JSON / 形状非法 → 降级单文本 segment', () => {
    expect(draftToSegments('普通旧草稿')).toEqual([{ type: 'text', text: '普通旧草稿' }]);
    expect(draftToSegments(null)).toEqual([]);
    expect(draftToSegments(undefined)).toEqual([]);
    expect(draftToSegments('{{{')).toEqual([{ type: 'text', text: '{{{' }]);
    expect(draftToSegments(JSON.stringify([{ type: 'pill', kind: 'hack', id: 'x', label: 'x' }])))
      .toEqual([{ type: 'text', text: JSON.stringify([{ type: 'pill', kind: 'hack', id: 'x', label: 'x' }]) }]);
  });
});
```

- [ ] **Step 2: 跑红**

Run: `cd renderer && npx pnpm@9.0.0 vitest run src/components/im/composer-segments.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**（`composer-segments.ts` 全文）

```ts
// renderer/src/components/im/composer-segments.ts
//
// 内联 pill 富输入块的纯函数层（spec 2026-09-17 §3/§4.4）：
//   segments 类型 → 发送序列化（body/mentions/context）+ 会话草稿往返。
//   不含任何 DOM 依赖——RichComposer 负责 DOM↔segments，本层可独立单测。
import type { MessageContext } from '../../ipc/types';

/** pill 五类：agent / 文件 / 任务 / 技能 / 命令（spec §3 表） */
export type PillKind = 'agent' | 'file' | 'task' | 'skill' | 'command';

/** 文本段（连续文字，含用户手敲的一切） */
export interface TextSeg {
  type: 'text';
  text: string;
}

/** pill 段：id = instanceId / 文件路径 / 任务 id / slug / 命令名；label = 显示名 */
export interface PillSeg {
  type: 'pill';
  kind: PillKind;
  id: string;
  label: string;
}

export type ComposerSegment = TextSeg | PillSeg;

/** 序列化产物：三参直接对应 sendMessage 契约（IPC 形状不变） */
export interface ComposerPayload {
  body: string;
  mentions?: string[];
  context?: MessageContext;
}

/**
 * 发送序列化（spec §3 规则表）：
 *   agent → body `@label` + mentions（按 instanceId 去重保序）
 *   file  → body `@path`   + context.files（按 path 去重）
 *   task  → body `#id`（conflict-detector 照旧解析正文）
 *   skill → 不进正文（展开块由主进程注入 <user-context>，防双重曝光）+ context.skills（按 slug 去重）
 *   command → body `/name`（纯命令 pill 时序列化恰为 `/name`——整串拦截语义由形态保持）
 *   重复 pill：body 保留全部出现（等价手敲两遍），结构化数组去重
 */
export function serializeSegments(segs: ComposerSegment[]): ComposerPayload {
  let body = '';
  const mentions: string[] = [];
  const skills: Array<{ slug: string; name: string }> = [];
  const files: Array<{ path: string }> = [];
  for (const seg of segs) {
    if (seg.type === 'text') {
      body += seg.text;
      continue;
    }
    switch (seg.kind) {
      case 'agent':
        body += `@${seg.label}`;
        if (!mentions.includes(seg.id)) mentions.push(seg.id);
        break;
      case 'file':
        body += `@${seg.id}`;
        if (!files.some((f) => f.path === seg.id)) files.push({ path: seg.id });
        break;
      case 'task':
        body += `#${seg.id}`;
        break;
      case 'skill':
        if (!skills.some((s) => s.slug === seg.id)) skills.push({ slug: seg.id, name: seg.label });
        break;
      case 'command':
        body += `/${seg.id}`;
        break;
    }
  }
  return {
    body,
    mentions: mentions.length > 0 ? mentions : undefined,
    context: skills.length > 0 || files.length > 0 ? { skills, files } : undefined,
  };
}

/** 草稿序列化：segments JSON（切会话 pill 不丢） */
export function segmentsToDraft(segs: ComposerSegment[]): string {
  return JSON.stringify(segs);
}

const PILL_KINDS: ReadonlyArray<PillKind> = ['agent', 'file', 'task', 'skill', 'command'];

/**
 * 草稿反序列化：null/undefined → 空；JSON 解析失败 / 非数组 / 元素形状非法 /
 * 旧版纯文本草稿 → 整体降级为单文本 segment（宽容恢复，绝不抛错）。
 */
export function draftToSegments(raw: string | null | undefined): ComposerSegment[] {
  if (raw === null || raw === undefined) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    if (!Array.isArray(v)) return [{ type: 'text', text: raw }];
    const segs: ComposerSegment[] = [];
    for (const item of v) {
      if (typeof item !== 'object' || item === null) return [{ type: 'text', text: raw }];
      const o = item as Record<string, unknown>;
      if (o.type === 'text' && typeof o.text === 'string') {
        segs.push({ type: 'text', text: o.text });
        continue;
      }
      if (
        o.type === 'pill' &&
        typeof o.kind === 'string' &&
        PILL_KINDS.includes(o.kind as PillKind) &&
        typeof o.id === 'string' &&
        typeof o.label === 'string'
      ) {
        segs.push({ type: 'pill', kind: o.kind as PillKind, id: o.id, label: o.label });
        continue;
      }
      return [{ type: 'text', text: raw }];
    }
    return segs;
  } catch {
    return [{ type: 'text', text: raw }];
  }
}
```

- [ ] **Step 4: 跑绿**

Run: `cd renderer && npx pnpm@9.0.0 vitest run src/components/im/composer-segments.test.ts`
Expected: 全部 PASS

- [ ] **Step 5: Commit**

```bash
git add renderer/src/components/im/composer-segments.ts renderer/src/components/im/composer-segments.test.ts
git commit -m "feat: composer segments 纯函数层——五类 pill 序列化规则与草稿往返"
```

---

### Task 2: RichComposer 编辑面组件

**Files:**
- Create: `renderer/src/components/im/RichComposer.tsx`
- Test: `renderer/src/components/im/RichComposer.test.tsx`

**Interfaces:**
- Consumes: Task 1 的 `ComposerSegment` / `PillSeg` / `PillKind`
- Produces（Task 3 依赖，签名逐字）:
  - `interface RichComposerHandle { focus(): void; moveCaretToEnd(): void; insertPill(pill: PillSeg, replaceLen: number): void; insertTextAtEnd(text: string): void; getSegments(): ComposerSegment[]; setSegments(segs: ComposerSegment[]): void; clear(): void }`
  - `interface RichComposerProps { disabled: boolean; placeholder: string; ariaLabel: string; onInputText(beforeCaret: string, allText: string): void; onEnter(): void; onEscape(): void }`

实现要点（写成代码时逐条落实）：
- 非受控 contentEditable div（React 不传 children）；`role="textbox"` + `aria-multiline` + `aria-label={ariaLabel}` + `data-placeholder`；placeholder 用 `empty:before:content-[attr(data-placeholder)] empty:before:text-disabled`
- pill DOM：`<span contenteditable="false" data-kind data-id data-label>` + 类名按 kind（见 PILL_CLASS）+ 后随 `\u200b` 文本节点作光标落点；显示文本：agent `@label` / file `label`(=path) / task `#id label` / skill `label` / command `/id`（命令无图标，D-3）
- `PILL_CLASS`（全语义 token）：agent `bg-accent-600/10 text-accent-600 dark:text-accent-300`；file `bg-surface-active text-secondary`；skill `bg-status-violet-tint text-status-violet`；command `bg-status-warning-tint text-status-warning`；task `bg-status-success-tint text-status-success`；公共 `rounded px-1.5 text-xs leading-5 inline-flex items-center align-baseline select-none`；选中态追加 `data-selected="1"` + `ring-1 ring-accent-500`
- 光标前文本：遍历 root——文本节点累加文字、pill 节点折叠为单个空格（防 pill 文字与 @ 局部粘连误触发）、剥离 `\u200b`
- `insertPill`：Selection/Range 在光标处删除最近 `replaceLen` 个触发字符（文本节点 splitText + deleteData，offset < replaceLen 时防御性钳 0）→ 插 pill + ZWSP → 光标落 ZWSP 后；无有效选区时追加末尾
- Backspace 两段式：keydown 拦截——光标紧邻 pill（文本节点 offset 0 且 previousSibling 为 pill，或所在文本节点为 ZWSP）时：第一次 `preventDefault` 置 `data-selected="1"`，第二次删除 pill（连带其后 ZWSP）；Delete 删除已选中 pill
- 点击 pill（mousedown）→ 选中态；再次点击文字区清除选中态
- IME：compositionstart/end 之间不触发 `onInputText`、Enter/Backspace 拦截逻辑跳过；Enter（非 Shift）→ `onEnter()`（`isComposing`/`keyCode 229` 守卫）；Escape → `onEscape()`
- `setSegments` 重建 DOM（innerHTML 清空后逐段建节点）；`getSegments` 反向遍历（连续文本节点合并、剥 ZWSP、pill 取 dataset）；`clear` = 清空；`insertTextAtEnd`：末尾追加文字（末字符非空白且非开头时补一个空格防粘连）+ 光标到末尾 + 触发 onInputText
- 挂载后（focus 且空）placeholder 由 CSS 呈现

- [ ] **Step 1: 写失败测试**（`RichComposer.test.tsx` 全文；selection 辅助函数先行）

```tsx
// RichComposer 编辑面：pill 插入/原子删除/IME 保护/segments 往返。
// jsdom 的 Selection/Range 支持基础操作（createRange + addRange），测试内主动设光标。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { useRef } from 'react';
import { RichComposer, type RichComposerHandle } from './RichComposer';
import type { ComposerSegment, PillSeg } from './composer-segments';

/** 测试壳：拿 handle + 观察 onInputText */
function Harness(props: Partial<Parameters<typeof RichComposer>[0]> = {}) {
  const ref = useRef<RichComposerHandle>(null);
  return {
    ref,
    ui: (
      <RichComposer
        ref={ref}
        disabled={false}
        placeholder="输入消息"
        ariaLabel="消息输入框"
        onInputText={props.onInputText ?? vi.fn()}
        onEnter={props.onEnter ?? vi.fn()}
        onEscape={props.onEscape ?? vi.fn()}
      />
    ),
  };
}

/** 设光标到指定文本节点的 offset（jsdom 下手动建 Range） */
function setCaret(node: Node, offset: number): void {
  const sel = window.getSelection();
  const range = document.createRange();
  range.setStart(node, offset);
  range.collapse(true);
  sel?.removeAllRanges();
  sel?.addRange(range);
}

const agentPill: PillSeg = { type: 'pill', kind: 'agent', id: 'i1', label: 'coder' };
const filePill: PillSeg = { type: 'pill', kind: 'file', id: 'src/a.ts', label: 'src/a.ts' };

function editor(): HTMLElement {
  return screen.getByRole('textbox', { name: '消息输入框' }) as HTMLElement;
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('RichComposer segments 往返', () => {
  it('setSegments → DOM pill（data-*）→ getSegments 还原', () => {
    const segs: ComposerSegment[] = [
      { type: 'text', text: '帮 ' },
      agentPill,
      { type: 'text', text: ' 看 ' },
      filePill,
    ];
    const h = render(<Harness ui-only-placeholder /> as never); // 见下方说明——实际用 h.ui
    // 实际测试代码：render(h.ui); h.ref.current!.setSegments(segs);
    expect(true).toBe(true);
  });
});
```

⚠️ 上段为骨架示意——**实现者以行为为准写全**，必须覆盖以下 10 个用例（全部真实断言，禁 placeholder 断言）：

1. `setSegments 混排 → getSegments 深等于输入`（连续文本节点合并 / ZWSP 剥离 / pill dataset 还原 kind/id/label）
2. `setSegments → DOM：pill span contenteditable=false + data-kind/id/label + 语义类名`（断言 `bg-accent-600/10` 在 agent pill class 中、`bg-status-violet-tint` 在 skill pill class 中）
3. `空编辑器 placeholder 呈现`（`data-placeholder` 属性 + `empty:before:content-` 类存在；jsdom 不渲染伪元素——断言类名与属性即可）
4. `insertPill 替换触发局部`：先 `setSegments([{type:'text',text:'帮 @co'}])` + 光标置文本节点末尾 offset，`insertPill(agentPill, 3)` → getSegments = `[text '帮 ', agentPill]`，且编辑器 DOM 中 agent pill 存在
5. `insertPill 空选区防御`：无光标（不设 selection）调 insertPill → pill 追加末尾不抛错
6. `Backspace 两段式`：setSegments([agentPill]) 后光标置 pill 后 ZWSP（offset 0）→ keyDown Backspace 第一次：pill `data-selected="1"` 且未删除；第二次：pill 连 ZWSP 删除、getSegments 为空
7. `Delete 删选中 pill`：点击 pill（mousedown）→ data-selected → keyDown Delete → 删除
8. `IME 组字保护`：compositionstart → fireEvent.input → `onInputText` 未被调；compositionend 后 input → 被调
9. `Enter/Escape 回调 + Shift+Enter 不触发 onEnter`；`isComposing 的 Enter 不触发`
10. `insertTextAtEnd 防粘连`：已有文字 `帮` 末尾插入 `@` → allText 含 `帮 @`；空编辑器插入 `@` → 恰 `@`；onInputText 被调（beforeCaret 含 `@`）

- [ ] **Step 2: 跑红**

Run: `cd renderer && npx pnpm@9.0.0 vitest run src/components/im/RichComposer.test.tsx`
Expected: FAIL（组件不存在）

- [ ] **Step 3: 实现 RichComposer.tsx**（按上方「实现要点」逐条；forwardRef + useImperativeHandle 暴露 handle；事件挂 div：onInput/onKeyDown/onMouseDown/onCompositionStart/onCompositionEnd；`contentEditable={!disabled}`；类名 `w-full min-h-[2.6rem] max-h-48 overflow-y-auto bg-transparent px-3 pt-2 text-sm text-primary focus:outline-none empty:before:content-[attr(data-placeholder)] empty:before:text-disabled disabled:opacity-50`——disabled 态用 `contentEditable={false}` + `opacity-50`，不依赖 disabled 属性）

- [ ] **Step 4: 跑绿**

Run: `cd renderer && npx pnpm@9.0.0 vitest run src/components/im/RichComposer.test.tsx`
Expected: 10 用例全 PASS

- [ ] **Step 5: Commit**

```bash
git add renderer/src/components/im/RichComposer.tsx renderer/src/components/im/RichComposer.test.tsx
git commit -m "feat: RichComposer contentEditable 编辑面——内联 pill 原子编辑与 IME 保护"
```

---

### Task 3: MentionInput 集成（退役 chip 行与三数组）

**Files:**
- Modify: `renderer/src/components/im/MentionInput.tsx`（约 605 行现状：state 区 59-80 / 草稿 effect 105-122 / selectX 329-368 / handleSend 370-398 / handleKeyDown 400-414 / JSX 容器 528-605）
- Test: `renderer/src/components/im/MentionInput.test.tsx`（重写受影响 describe）

**Interfaces:**
- Consumes: Task 1 全部 + Task 2 的 `RichComposerHandle`
- Produces: 对外行为——`sendMessage` 三参、菜单/📎/草稿/只读语义不变；pill 内联取代 chip 行

- [ ] **Step 1: 重写受影响测试**（先红）。现状 62 用例中：
  - **保留不动**：@ 菜单双源 / 命令菜单 / #T 菜单 / IME / F1 中文过滤（断言对象是菜单渲染，不走 textarea）——仅将「输入」动作从 `fireEvent.change(textarea)` 改为「设编辑器文本 + 光标 + `fireEvent.input(editor)`」（测试辅助 `typeInEditor(el, text)`：`el.textContent=text; setCaret(最后一个文本节点末尾); fireEvent.input(el)`）
  - **重写为 pill 断言**：发送 5 用例（断言 `sendMessage` 收到 `(body, mentions, context)`——由序列化产生，如选 agent 后发送 `body='@coder '`）、失败恢复（pill 原位恢复）、会话草稿（pill 往返）、F3 容器 3 用例（chips-in-container 断言改为 pills-in-editor：`editor().querySelector('[data-kind="file"]')` 非空；📎 仍在 `.rounded-lg` 容器）、选择类用例（选文件 → `[data-kind="file"][data-id="package.json"]` 存在，不再断言 `ta.value`）
  - **新增**：`仅技能 pill + 空 body 可发送（v2.11 §7.1）`；`命令 pill 单独存在 → sendMessage body='/compact'（拦截语义形态保持）`；`五类混排发送 → payload 三参对齐 spec §3 表`

- [ ] **Step 2: 跑红**（受影响用例批量红；保留组仍绿）

Run: `cd renderer && npx pnpm@9.0.0 vitest run src/components/im/MentionInput.test.tsx`

- [ ] **Step 3: 实现集成**：

1. `textareaRef` → `const composerRef = useRef<RichComposerHandle>(null)`；import RichComposer / composer-segments
2. 删 state：`text` / `pendingMentions` / `pendingFiles` / `pendingSkills`；删 `handleChange` / `insertMention` / `mentionDisplayName` / 底部 chip 行 JSX / `<textarea>`
3. `detectTrigger(before: string)`：接收「光标前文本」（RichComposer 的 beforeCaret——pill 已折叠为空格），正则逻辑不变（cmdMatch 整串锚定在 pill 存在时自然失效——pill 折叠空格使 `^\/` 不匹配，命令整串语义保持）
4. `onInputText={(before) => detectTrigger(before)}`
5. `selectMember/selectTask/selectCommand/selectFile/selectSkill` 统一形：
   ```ts
   const replaceLen = 1 + query.length; // sigil + 查询词（菜单选中时的触发局部）
   composerRef.current?.insertPill(seg, replaceLen);
   setMenuType(null); setQuery('');
   ```
   （`selectFile`：`{kind:'file', id:f.path, label:f.path}`；`selectSkill`：`{kind:'skill', id:s.slug, label:s.name}`；`selectMember`：`{kind:'agent', id:m.instanceId, label:m.agentName}`；`selectTask`：`{kind:'task', id:t.id, label:t.title}`；`selectCommand`：`{kind:'command', id:name, label:name}`）
6. `handleSend`：
   ```ts
   const segs = composerRef.current?.getSegments() ?? [];
   const payload = serializeSegments(segs);
   const trimmed = payload.body.trim();
   const hasContext = !!payload.context;
   if ((!trimmed && !hasContext) || !activeSessionId) return;
   composerRef.current?.clear();
   setMenuType(null); setQuery('');
   try {
     await sendMessage(trimmed, payload.mentions, payload.context);
     await loadSessions();
   } catch {
     composerRef.current?.setSegments(segs); // 失败恢复：pill 原位
   }
   ```
7. 草稿 effect：存 `segmentsToDraft(composerRef.current?.getSegments() ?? [])`；恢复 `composerRef.current?.setSegments(draftToSegments(next))`；`setFileHits([])`（M1）保留
8. 📎 `fileTriggerTick` effect：`composerRef.current?.focus(); composerRef.current?.insertTextAtEnd('@')`（insertTextAtEnd 内部触发 onInputText → detectTrigger 开菜单）；`inputFocusTick` effect 改 `composerRef.current?.focus()`
9. Enter/Escape：`onEnter={() => { if (menuType !== null) return; void handleSend(); }}`；`onEscape={() => { setMenuType(null); }}`（IME 守卫在 RichComposer 内）
10. JSX：容器底行仅剩 📎（chips 条件块整段删除）；编辑面：
    ```tsx
    <RichComposer
      ref={composerRef}
      disabled={!activeSessionId || readOnly}
      placeholder={readOnly ? '会话只读' : activeSessionId ? '输入消息，Enter 发送。@ 引用 agent 或文件，# 引用任务' : '请先选择房间'}
      ariaLabel="消息输入框"
      onInputText={(before) => detectTrigger(before)}
      onEnter={...} onEscape={...}
    />
    ```
11. 头注释更新为内联 pill 模型（v3）

- [ ] **Step 4: 跑绿 + 全文件回归**

Run: `cd renderer && npx pnpm@9.0.0 vitest run src/components/im/MentionInput.test.tsx src/components/im/RichComposer.test.tsx src/components/im/composer-segments.test.ts`
Expected: 全 PASS

- [ ] **Step 5: Commit**

```bash
git add renderer/src/components/im/MentionInput.tsx renderer/src/components/im/MentionInput.test.tsx
git commit -m "feat: MentionInput 接入 RichComposer——内联 pill 取代底部 chip 行与三数组"
```

---

### Task 4: e2e 适配 + CHANGELOG + 全量验证

**Files:**
- Modify: `tests/e2e/composer-context.spec.ts`（编辑器定位与断言）
- Modify: `CHANGELOG.md`（v2.11 账目节追加）

**Interfaces:**
- Consumes: Task 3 完成后的 UI（role=textbox 的 contentEditable 编辑器 + data-kind pill）
- Produces: 无（收尾）

- [ ] **Step 1: e2e 适配**：
  - 编辑器定位：`getByRole('textbox')` 不变（div role=textbox 仍命中）；**Playwright `fill()` 原生支持 contentEditable**——`input.fill('@package')` 保留；如个别步骤 fill 后菜单未触发（input 事件时序），改 `input.click()` + `input.type('@package')`
  - 值断言：`inputValue()` → `innerText`（编辑器无 value 属性）；菜单/气泡断言不变
  - 触发流注释更新为内联 pill 模型
- [ ] **Step 2: CHANGELOG**（v2.11 账目节「交互精简」条目后追加）：

```markdown
- **内联 pill 富输入块（第三轮主机验收）**：textarea 升级为 contentEditable 富输入块——@（agent/文件）/ #（任务）/ /（命令/技能）选中的引用以原子 pill 内联在文字流中（填充底色式：agent 蓝 / 文件中性 / 技能紫 / 命令橙 / 任务绿；命令无前缀图标），光标处插入、退格两段式整删、IME 组字保护；会话草稿存 segments（pill 不丢）。发送序列化保持 IPC 三参契约不变（技能不进正文、命令整串拦截语义由形态保持）
```

- [ ] **Step 3: 全量验证**（同 UX2 Task 4 六步）：

```bash
nvm use 20
npx pnpm@9.0.0 typecheck
cd renderer && npx pnpm@9.0.0 vitest run          # 全绿
cd .. && npx pnpm@9.0.0 build
cd electron && npx electron-rebuild -f -w better-sqlite3
cd .. && xvfb-run -a npx pnpm@9.0.0 e2e tests/e2e/composer-context.spec.ts
cd electron/node_modules/better-sqlite3 && npx prebuild-install
cd ../../.. && cd electron && npx pnpm@9.0.0 vitest run tests/agent/runtime-resume.test.ts
```

Expected: typecheck 零错 / renderer 全绿 / e2e 1 passed / ABI 恢复抽查绿

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/composer-context.spec.ts CHANGELOG.md
git commit -m "test: e2e 适配内联 pill 编辑器 + CHANGELOG 账目"
```

---

## Self-Review 记录

- **Spec 覆盖**：§2 架构→T2/T3；§3 序列化表→T1（用例逐行锁）；§4.1 触发复用→T3.3/4；§4.2 原子编辑→T2 用例 6/7；§4.3 IME→T2 用例 8/9；§4.4 草稿/恢复/只读→T1 草稿往返 + T3.6/7 + placeholder；§5 文件结构→四文件对齐；§7 风险测试→T2 十用例 + T3 重写 + T4 e2e。无缺口。
- **占位符**：T2 Step 1 含骨架示意段并显式标注「实现者以行为为准写全」+10 用例清单（行为规格完备）；其余步骤代码完整。
- **类型一致**：`RichComposerHandle` 七方法在 T2 产出/T3 消费逐字一致；`PillSeg` 五字段构造在 T3.5 与 T1 定义一致；`ComposerPayload` 三字段与 sendMessage 契约对齐。
- **已知风险预案**：jsdom Selection 弱 → 测试统一 `setCaret` 辅助 + handle 直测；Playwright fill 对 contentEditable 支持 → type() 兜底（T4 Step 1）。
