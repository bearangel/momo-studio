# 会话输入框上下文系统实施计划（技能 / 指令 / 文件引用）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 输入框支持 `/` 菜单（命令 + 技能）、`@` 菜单文件组（`@/路径` 引用）、消息气泡 context chip 化渲染，预置 3 个 builtin skill。

**Architecture:** 方案 B（spec `docs/specs/2026-09-16-composer-context-system-design.md`）——renderer→main 传 metadata 级 `MessageContext`（slug/路径，落库 `messages.context_json`），主进程 `context-expander` 展开为 `ExpandedContext`（skill 正文 + 文件内容），经 `task-config`/`steer` 子进程协议下发，子进程把 `<user-context>` 块包装进本轮用户正文。两层契约分离：正文不落库、不回 renderer。

**Tech Stack:** Electron 主进程（CommonJS）+ React renderer（ESM/Vite）+ better-sqlite3 + zustand + Tailwind 语义 token + vitest（两 workspace）+ Playwright e2e。

## Global Constraints

- **Node 20**：容器默认 Node 26 会破坏 better-sqlite3。所有命令前 `nvm use 20`；pnpm 用 `npx pnpm@9.0.0`
- **TypeScript strict**：禁止 `any` / `@ts-ignore` / `as any`（ESLint no-explicit-any: error）
- **注释与文档全部中文**；标识符英文
- **Conventional Commits**：`feat:` / `test:` / `chore:` / `docs:`
- **版本号纪律**：本计划所有 commit 一律不动版本号
- **UI 设计系统**：renderer 只用语义 token（`bg-surface-*` / `text-secondary`…），图标 lucide-react 16px / stroke 1.75，禁 emoji 图标、禁 inline 颜色
- **测试位置**：electron 单测在 `electron/tests/`（镜像 src 结构）；renderer 单测贴源 colocated（`Foo.test.tsx` 与 `Foo.tsx` 同目录）
- **IPC 契约（momo-boundary-rules）**：协议字段两端同 commit 修改 + 契约测试锁形状；改 IPC 接口后两个 workspace 都跑 typecheck
- **测试保真（momo-test-rules）**：mock 只收窄到 IPC/DB 边界；错误路径与空输入必须有专项用例；断言被消费字段的真实性质

---

### Task 1: 共享类型 + messages.context_json migration

**Files:**
- Modify: `renderer/src/ipc/types.d.ts`（ImMessage 后追加类型 + ImMessage 加字段）
- Create: `electron/src/main/storage/migrations/036_v2_11_message_context.ts`
- Modify: `electron/src/main/storage/migrations/index.ts`（追加 import + MIGRATIONS 条目）
- Modify: `electron/src/main/storage/messages/repo.ts`（MessageRow / SqlRow / rowToCamel / insertMessage）
- Test: `electron/tests/migrations/036-message-context.test.ts`

**Interfaces:**
- Produces: `MessageContext` / `SkillContextItem` / `FileContextItem`（types.d.ts，两 workspace 共享）；`MessageRow.contextJson: string | null`；`insertMessage` 接受 `contextJson`

- [ ] **Step 1: 写失败测试**

```typescript
// electron/tests/migrations/036-message-context.test.ts
// migration 036：messages 加 context_json 列。旧行 NULL 兼容 + insertMessage 往返。
import { describe, it, expect } from 'vitest';
import { getDb } from '../../src/main/storage/db';
import { runMigrations } from '../../src/main/storage/migrations';
import { insertMessage } from '../../src/main/storage/messages/repo';

describe('migration 036 messages.context_json', () => {
  it('新列存在且旧行为 NULL', () => {
    runMigrations();
    const cols = getDb().prepare("PRAGMA table_info('messages')").all() as Array<{ name: string }>;
    expect(cols.some((c) => c.name === 'context_json')).toBe(true);
  });

  it('insertMessage 携带 contextJson 落库往返', () => {
    const ctx = JSON.stringify({ skills: [{ slug: 'code-review', name: '代码审查' }], files: [{ path: 'src/a.ts' }] });
    const row = insertMessage({
      sessionId: 's-mig036', sender: 'owner', eventType: 'm.room.message',
      body: '检查一下', contextJson: ctx,
    });
    expect(row.contextJson).toBe(ctx);
  });

  it('contextJson 缺省为 null（旧行为兼容）', () => {
    const row = insertMessage({
      sessionId: 's-mig036', sender: 'owner', eventType: 'm.room.message', body: '普通消息',
    });
    expect(row.contextJson).toBeNull();
  });
});

- [ ] **Step 2: 跑测试确认红**

```bash
nvm use 20 && cd electron && npx pnpm@9.0.0 vitest run tests/migrations/036-message-context.test.ts
```
预期：FAIL（新列不存在 / contextJson 类型缺失）

- [ ] **Step 3: 实现**

`electron/src/main/storage/migrations/036_v2_11_message_context.ts`（照抄 035 的导出形状——先 `read electron/src/main/storage/migrations/035_v2_7_browser_takeover_wait.ts` 对齐结构）：

```typescript
// electron/src/main/storage/migrations/036_v2_11_message_context.ts
// v2.11 输入框上下文系统：messages 表新增 context_json 列（nullable）。
// 存放 MessageContext 序列化（metadata 级：skill slug / 文件路径），skill 正文与
// 文件内容绝不落库（主进程派发时渐进展开，spec 2026-09-16 §5.3）。
import type { Migration } from '.';

export const migration036: Migration = {
  version: 36,
  sql: `ALTER TABLE messages ADD COLUMN context_json TEXT NULL;`,
};
```

`migrations/index.ts`：在 035 import 后追加 `import { migration036 } from './036_v2_11_message_context';`，MIGRATIONS 数组末尾追加 `migration036,`。

`renderer/src/ipc/types.d.ts`（ImMessage 定义 L312 前后）：

```typescript
/** 输入框上下文项——技能（metadata 级；正文仅派发时在主进程展开） */
export interface SkillContextItem {
  slug: string;
  /** 展示名（选择时从资源索引快照，渲染 chip 不反查） */
  name: string;
}

/** 输入框上下文项——workspace 文件路径引用（相对路径，'/' 分隔） */
export interface FileContextItem {
  path: string;
}

/** 一条消息携带的输入框上下文（renderer ↔ main 契约 + messages.context_json 载荷） */
export interface MessageContext {
  skills: SkillContextItem[];
  files: FileContextItem[];
}
```

`ImMessage` 内（`taskId: string | null;` 之后）追加——**wire 契约说明**：`session:message` 推送与 `getMessages` 返回的都是原始 `MessageRow`（camelCase 直通），主进程不做 context 解析变换（避免每个推送点遗漏）；renderer 消费时用 `parseMessageContext` 解析：

```typescript
  /** 输入框上下文序列化（v2.11）：messages.context_json 直通；null=无上下文（旧消息） */
  contextJson: string | null;
```

`renderer/src/lib/message-context.ts`（新建，renderer 侧消费helper）：

```typescript
// renderer/src/lib/message-context.ts
// context_json → MessageContext 防御性解析：null / 损坏 / 非法形状 → null。
// 消费点：MessageBubble chip 渲染。wire 是 MessageRow 直通（contextJson），
// 解析收口在本模块单点，杜绝各组件手写 try/JSON.parse 漂移。
import type { MessageContext } from '../ipc/types';

export function parseMessageContext(raw: string | null): MessageContext | null {
  if (raw === null) return null;
  try {
    const v = JSON.parse(raw) as { skills?: unknown; files?: unknown };
    if (!Array.isArray(v.skills) || !Array.isArray(v.files)) return null;
    return { skills: v.skills, files: v.files };
  } catch {
    return null;
  }
}
```

`renderer/src/lib/message-context.test.ts`（贴源测试）：

```typescript
import { describe, it, expect } from 'vitest';
import { parseMessageContext } from './message-context';

describe('parseMessageContext', () => {
  it('合法 JSON 解析', () => {
    expect(parseMessageContext(JSON.stringify({ skills: [], files: [{ path: 'a' }] }))).toEqual({
      skills: [], files: [{ path: 'a' }],
    });
  });
  it('null 与损坏 JSON 返回 null', () => {
    expect(parseMessageContext(null)).toBeNull();
    expect(parseMessageContext('{oops')).toBeNull();
  });
  it('形状非法（skills/files 非数组）返回 null', () => {
    expect(parseMessageContext('{"skills":1}')).toBeNull();
  });
});
```

注意：repo.ts **不**新增 parseContextJson（解析收口 renderer 侧单点）；`rowToCamel` 映射 `contextJson: r.context_json`；INSERT 列清单与参数各加一项。

- [ ] **Step 4: 跑测试确认绿**

同 Step 2 命令。预期：3 用例全 PASS。

- [ ] **Step 5: 跑既有消息域回归 + 双 typecheck**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/storage tests/im/session-service.test.ts
cd ../renderer && npx pnpm@9.0.0 vitest run src/lib/message-context.test.ts
cd ../ && npx pnpm@9.0.0 typecheck
```
预期：全绿（ImMessage 加必填字段 `contextJson` 若造成 renderer 类型错，在所有构造 ImMessage 的测试 fixture 补 `contextJson: null`——grep `makeMsg` / `makeReply` / `seedSession` 等逐个补）。

- [ ] **Step 6: Commit**

```bash
git add electron/src/main/storage/migrations electron/src/main/storage/messages/repo.ts electron/tests/migrations/036-message-context.test.ts renderer/src/ipc/types.d.ts renderer/src/lib/message-context.ts renderer/src/lib/message-context.test.ts
git commit -m "feat: messages.context_json 列与 MessageContext 共享类型（输入框上下文系统 Task 1）"
```

---

### Task 2: 命令注册表 + session:listCommands

**Files:**
- Create: `electron/src/main/im/commands.ts`
- Modify: `electron/src/main/im/session-service.ts`（handleSessionCommand 查表）
- Modify: `electron/src/main/im/session.ipc.handlers.ts`（新增 listCommands handler）
- Modify: `renderer/src/ipc/types.d.ts`（SessionApiSurface.listCommands）
- Modify: `electron/src/preload/index.ts`（session:listCommands 暴露）
- Modify: `renderer/src/stores/session.store.ts`（删本地白名单，未知命令转发）
- Test: `electron/tests/im/commands-registry.test.ts`

**Interfaces:**
- Produces: `SESSION_COMMANDS: readonly SessionCommandDef[]`；`isKnownSessionCommand(name): boolean`；renderer `ipc.session.listCommands(): Promise<Array<{name, description}>>`

- [ ] **Step 1: 写失败测试**

```typescript
// electron/tests/im/commands-registry.test.ts
// 命令注册表：单一真相源 + handleSessionCommand 查表分发（未知命令中文错误）。
import { describe, it, expect } from 'vitest';
import { SESSION_COMMANDS, isKnownSessionCommand } from '../../src/main/im/commands';
import { handleSessionCommand } from '../../src/main/im/session-service';

describe('会话命令注册表', () => {
  it('compact 在册且带中文描述', () => {
    const compact = SESSION_COMMANDS.find((c) => c.name === 'compact');
    expect(compact).toBeDefined();
    expect(compact!.description.length).toBeGreaterThan(0);
  });

  it('isKnownSessionCommand 判定', () => {
    expect(isKnownSessionCommand('compact')).toBe(true);
    expect(isKnownSessionCommand('nope')).toBe(false);
  });

  it('未知命令 handleSessionCommand 抛中文错误并列出支持命令', async () => {
    await expect(handleSessionCommand({ sessionId: 's-x', command: 'nope' })).rejects.toThrow(
      /未知命令: \/nope/,
    );
  });
});
```

- [ ] **Step 2: 跑测试确认红**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/im/commands-registry.test.ts
```
预期：FAIL（commands.ts 不存在）

- [ ] **Step 3: 实现**

```typescript
// electron/src/main/im/commands.ts
// 会话斜杠命令注册表（v2.11，spec 2026-09-16 §6.1）——单一真相源：
//   - / 菜单命令组数据（session:listCommands → renderer）
//   - handleSessionCommand 查表分发
// 新增命令 = 在此追加一条 + handler 挂到 session-service 的分发映射。
export interface SessionCommandDef {
  name: string;
  description: string;
}

export const SESSION_COMMANDS: readonly SessionCommandDef[] = [
  { name: 'compact', description: '压缩会话历史，释放上下文窗口' },
];

export function isKnownSessionCommand(name: string): boolean {
  return SESSION_COMMANDS.some((c) => c.name === name);
}
```

`session-service.ts` `handleSessionCommand` 头部改为：

```typescript
  const supported = SESSION_COMMANDS.map((c) => `/${c.name}`).join('、');
  if (!isKnownSessionCommand(input.command)) {
    throw new Error(`未知命令: /${input.command}（当前支持 ${supported}）`);
  }
```

（import 加 `SESSION_COMMANDS, isKnownSessionCommand`；原 `if (input.command !== 'compact')` 分支删除。）

`session.ipc.handlers.ts`（session:command handler 旁）新增：

```typescript
  ipcMain.handle('session:listCommands', () => SESSION_COMMANDS);
```

`types.d.ts` `SessionApiSurface`：

```typescript
  /** 会话命令注册表（v2.11）——/ 菜单命令组数据源 */
  listCommands(): Promise<Array<{ name: string; description: string }>>;
```

`preload/index.ts`：照抄 session 命名空间既有 `command` 包装形态加：

```typescript
    listCommands: () => ipcRenderer.invoke('session:listCommands'),
```

`session.store.ts` `sendMessage` 的 `/` 拦截段改为（删除 compact 硬编码白名单）：

```typescript
    } else if (body.startsWith('/')) {
      const command = body.slice(1).trim();
      try {
        const r = await ipc.session.command(activeSessionId, command);
        set({ commandHint: r.message });
      } catch (err) {
        set({ commandHint: err instanceof Error ? err.message : String(err) });
      }
      return undefined;
    }
```

- [ ] **Step 4: 跑测试 + 既有命令回归**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/im/commands-registry.test.ts tests/im/session.ipc.handlers.test.ts
cd ../renderer && npx pnpm@9.0.0 vitest run src/stores/session.store.test.ts
```
预期：全绿。session.store.test.ts 若有「未知命令本地拦截」用例，改为断言转发 IPC（更新断言而非删用例）。

- [ ] **Step 5: Commit**

```bash
git add electron/src/main/im/commands.ts electron/src/main/im/session-service.ts electron/src/main/im/session.ipc.handlers.ts electron/src/preload/index.ts electron/tests/im/commands-registry.test.ts renderer/src/ipc/types.d.ts renderer/src/stores/session.store.ts
git commit -m "feat: 会话命令注册表单一真相源 + session:listCommands（Task 2）"
```

---

### Task 3: ExpandedContext 协议类型 + turn-context 渲染模块

**Files:**
- Modify: `electron/src/main/agent/runtime-config.ts`（TaskConfig 加 context + ExpandedContext 定义）
- Create: `electron/src/main/agent/turn-context.ts`
- Test: `electron/tests/agent/turn-context.test.ts`

**Interfaces:**
- Produces: `ExpandedContext { skills: ExpandedSkillItem[]; files: ExpandedFileItem[] }`（`ExpandedSkillItem { slug, name, body }`；`ExpandedFileItem { path, content: string | null }`）定义于 runtime-config.ts（task-config 线协议类型单点）；`renderTurnBody(body: string, context?: ExpandedContext): string`

- [ ] **Step 1: 写失败测试**

```typescript
// electron/tests/agent/turn-context.test.ts
// turn-context：ExpandedContext → 本轮用户正文包装（<user-context> 块）。
// 错误路径铁律：content=null 的文件渲染为「按需读取」提示行，不是吞掉。
import { describe, it, expect } from 'vitest';
import { renderTurnBody, renderUserContext } from '../../src/main/agent/turn-context';
import type { ExpandedContext } from '../../src/main/agent/runtime-config';

const ctx: ExpandedContext = {
  skills: [{ slug: 'code-review', name: '代码审查', body: '逐条审查变更' }],
  files: [
    { path: 'src/a.ts', content: 'const a = 1;' },
    { path: 'big.bin', content: null },
  ],
};

describe('renderUserContext', () => {
  it('渲染 skill 正文与文件内容块', () => {
    const s = renderUserContext(ctx);
    expect(s).toContain('<user-context>');
    expect(s).toContain('<skill name="code-review">');
    expect(s).toContain('逐条审查变更');
    expect(s).toContain('<file path="src/a.ts">');
    expect(s).toContain('const a = 1;');
  });

  it('content=null 的文件渲染为按需读取提示', () => {
    const s = renderUserContext(ctx);
    expect(s).toContain('<file path="big.bin">');
    expect(s).toContain('文件过大，请用文件工具按需读取');
  });

  it('空上下文返回空串', () => {
    expect(renderUserContext({ skills: [], files: [] })).toBe('');
  });
});

describe('renderTurnBody', () => {
  it('无 context 原样返回', () => {
    expect(renderTurnBody('你好', undefined)).toBe('你好');
  });

  it('有 context 时块在前正文在后，空正文也成立', () => {
    expect(renderTurnBody('你好', ctx)).toContain('你好');
    expect(renderTurnBody('', ctx)).toContain('<user-context>');
    expect(renderTurnBody('', ctx).endsWith('\n\n')).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认红**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/agent/turn-context.test.ts
```
预期：FAIL（模块不存在）

- [ ] **Step 3: 实现**

`runtime-config.ts` TaskConfig 之前追加类型 + TaskConfig 内 `mentions` 字段后追加 `context`：

```typescript
/** 主进程展开后下发给子进程的上下文项——skill（loadFull 正文） */
export interface ExpandedSkillItem {
  slug: string;
  name: string;
  /** SKILL.md 正文 */
  body: string;
}

/** 主进程展开后下发给子进程的上下文项——文件（content=null = 超 64KB/读取失败/总量超限降级） */
export interface ExpandedFileItem {
  path: string;
  content: string | null;
}

/** task-config / steer 线协议的上下文载荷（不落库、不回 renderer） */
export interface ExpandedContext {
  skills: ExpandedSkillItem[];
  files: ExpandedFileItem[];
}
```

TaskConfig 追加（`mentions` 后）：

```typescript
  /**
   * v2.11 输入框上下文（spec 2026-09-16 §5.4）：主进程展开后的用户指定
   * skill 正文与文件内容。设置时 runTaskChatLoop 把 <user-context> 块包装进
   * 本轮用户正文（一次性注入，不落库）。
   */
  context?: ExpandedContext;
```

`electron/src/main/agent/turn-context.ts`：

```typescript
// electron/src/main/agent/turn-context.ts
// ExpandedContext → <user-context> XML 块渲染（v2.11，spec 2026-09-16 §5.5）。
// 纯函数：只做字符串组装，IO（skill 加载 / 文件读取）全部在主进程 context-expander。
import type { ExpandedContext } from './runtime-config';

/** 单文件超大 / 读取失败的降级提示行（LLM 可据此转用文件工具自读） */
const FILE_FALLBACK_HINT = '文件过大，请用文件工具按需读取';

export function renderUserContext(context: ExpandedContext): string {
  const parts: string[] = [];
  for (const s of context.skills) {
    parts.push(`<skill name="${escapeAttr(s.name)}">\n${s.body}\n</skill>`);
  }
  for (const f of context.files) {
    parts.push(
      `<file path="${escapeAttr(f.path)}">\n${f.content ?? FILE_FALLBACK_HINT}\n</file>`,
    );
  }
  if (parts.length === 0) return '';
  return `<user-context>\n${parts.join('\n')}\n</user-context>`;
}

/** 把渲染块包装进本轮用户正文：块在前、正文在后；两者皆空返回空串 */
export function renderTurnBody(body: string, context?: ExpandedContext): string {
  if (!context) return body;
  const block = renderUserContext(context);
  if (block === '') return body;
  return body === '' ? block : `${block}\n\n${body}`;
}

/** XML 属性值转义（name/path 是受控输入，仍防御引号破坏标签结构） */
function escapeAttr(v: string): string {
  return v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
```

- [ ] **Step 4: 跑测试确认绿** → 同 Step 2。预期 PASS。

- [ ] **Step 5: Commit**

```bash
git add electron/src/main/agent/runtime-config.ts electron/src/main/agent/turn-context.ts electron/tests/agent/turn-context.test.ts
git commit -m "feat: ExpandedContext 线协议类型 + turn-context 渲染模块（Task 3）"
```

---

### Task 4: 主进程 context-expander

**Files:**
- Create: `electron/src/main/im/context-expander.ts`
- Test: `electron/tests/im/context-expander.test.ts`

**Interfaces:**
- Consumes: `MessageContext`（types.d.ts，Task 1）；skill 目录约定（`<userData>/skills/<slug>/SKILL.md` custom/marketplace、`<resources>/skills/<slug>/SKILL.md` builtin——先 grep `electron/src/main/skill/loader.ts` 与 `resource/` 确认实际根路径解析函数；若存在现成 `listResources`/skill store 枚举则优先复用，本 task 的 `resolveSkillMarkdown` 内部改为调它，测试不变）
- Produces: `expandMessageContext(workspaceId: string | null, context: MessageContext): Promise<ExpandedContext>`；常量 `MAX_INLINE_FILE_BYTES = 64 * 1024`、`MAX_TOTAL_INLINE_BYTES = 256 * 1024`

- [ ] **Step 1: 写失败测试**

```typescript
// electron/tests/im/context-expander.test.ts
// context-expander：skill 展开（成功/不可用占位）+ 文件读取（内联/超大/总量/逃逸/不存在）。
// momo-test-rules：文件系统用真实临时目录（不 mock fs）；skill 用真实 SKILL.md 文件。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expandMessageContext, MAX_INLINE_FILE_BYTES } from '../../src/main/im/context-expander';

let tmpRoot: string;
let wsId: string | null;

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-ctx-'));
  // 伪 workspace 目录结构：expander 经测试注入的根解析函数取 workspace 目录
  fs.mkdirSync(path.join(tmpRoot, 'ws1'), { recursive: true });
  fs.writeFileSync(path.join(tmpRoot, 'ws1', 'a.ts'), 'export const a = 1;');
  // 超大文件（> 64KB）
  fs.writeFileSync(path.join(tmpRoot, 'ws1', 'big.txt'), 'x'.repeat(MAX_INLINE_FILE_BYTES + 1));
  // skill 目录（custom 形态）
  fs.mkdirSync(path.join(tmpRoot, 'skills', 'demo'), { recursive: true });
  fs.writeFileSync(
    path.join(tmpRoot, 'skills', 'demo', 'SKILL.md'),
    '---\nname: 演示技能\ndescription: 测试用\nversion: 1.0.0\n---\n\n技能正文。',
  );
  wsId = 'ws1';
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('expandMessageContext', () => {
  it('skill 展开正文与名称', async () => {
    const r = await expandMessageContext(wsId, { skills: [{ slug: 'demo', name: '演示技能' }], files: [] });
    expect(r.skills).toHaveLength(1);
    expect(r.skills[0]!.body).toContain('技能正文。');
    expect(r.skills[0]!.name).toBe('演示技能');
  });

  it('skill 不可用降级为占位（不抛错）', async () => {
    const r = await expandMessageContext(wsId, { skills: [{ slug: 'gone', name: '已删除' }], files: [] });
    expect(r.skills[0]!.body).toBe('[skill 已不可用]');
  });

  it('文件内联读取（≤64KB）', async () => {
    const r = await expandMessageContext(wsId, { skills: [], files: [{ path: 'a.ts' }] });
    expect(r.files[0]!.content).toBe('export const a = 1;');
  });

  it('超大文件 content=null 降级', async () => {
    const r = await expandMessageContext(wsId, { skills: [], files: [{ path: 'big.txt' }] });
    expect(r.files[0]!.content).toBeNull();
  });

  it('路径逃逸（.. 与绝对路径）按读取失败降级，不越 workspace', async () => {
    const r = await expandMessageContext(wsId, {
      skills: [],
      files: [{ path: '../outside.txt' }, { path: '/etc/passwd' }],
    });
    expect(r.files[0]!.content).toBeNull();
    expect(r.files[1]!.content).toBeNull();
  });

  it('不存在文件 content=null 降级', async () => {
    const r = await expandMessageContext(wsId, { skills: [], files: [{ path: 'nope.ts' }] });
    expect(r.files[0]!.content).toBeNull();
  });

  it('空 context 返回空结构', async () => {
    const r = await expandMessageContext(wsId, { skills: [], files: [] });
    expect(r).toEqual({ skills: [], files: [] });
  });
});
```

- [ ] **Step 2: 跑测试确认红**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/im/context-expander.test.ts
```
预期：FAIL（模块不存在）

- [ ] **Step 3: 实现**

```typescript
// electron/src/main/im/context-expander.ts
// 输入框上下文展开器（v2.11，spec 2026-09-16 §6.2）。
// renderer 传来的 MessageContext（slug/路径）→ 子进程消费的 ExpandedContext
// （skill 正文 + 文件内容）。所有失败路径一律降级（占位 / content=null），
// 绝不阻塞消息派发——上下文是增强不是前提。
import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { logger } from '../logger';
import type { ExpandedContext, ExpandedFileItem, ExpandedSkillItem } from '../agent/runtime-config';
import type { MessageContext } from '../../../renderer/src/ipc/types';

/** 单文件内联上限；超出降级为路径引用（LLM 转用文件工具自读） */
export const MAX_INLINE_FILE_BYTES = 64 * 1024;
/** 单条消息文件内容累计内联上限；超出后其余文件全部降级 */
export const MAX_TOTAL_INLINE_BYTES = 256 * 1024;

/** skill 不可用占位（renderTurnBody 原样注入，用户意图在流内可见） */
const SKILL_UNAVAILABLE = '[skill 已不可用]';

/** 测试注入点：skill 根目录解析（生产 = userData/skills + resources/skills） */
export interface ExpanderDeps {
  skillRoots?: string[];
  workspaceDir?: (workspaceId: string) => string | null;
}
let deps: ExpanderDeps = {};
export function setExpanderDeps(d: ExpanderDeps): void {
  deps = d;
}

function skillRoots(): string[] {
  if (deps.skillRoots) return deps.skillRoots;
  return [
    path.join(app.getPath('userData'), 'skills'),
    path.join(process.resourcesPath ?? '', 'skills'),
  ];
}

function workspaceDirOf(workspaceId: string | null): string | null {
  if (!workspaceId) return null;
  if (deps.workspaceDir) return deps.workspaceDir(workspaceId);
  // 生产路径：复用 workspace 表 directory_path（grep getWorkspace 的既有导入形态后对齐）
  const { getWorkspace } = require('../storage/workspaces/repo') as
    typeof import('../storage/workspaces/repo');
  const ws = getWorkspace(workspaceId);
  return ws?.directoryPath ?? null;
}

/** SKILL.md 定位 + frontmatter 剥离（name 从 frontmatter 提取，body 为其后的正文） */
function resolveSkillMarkdown(slug: string): { name: string; body: string } | null {
  for (const root of skillRoots()) {
    const file = path.join(root, slug, 'SKILL.md');
    if (!fs.existsSync(file)) continue;
    const raw = fs.readFileSync(file, 'utf-8');
    const fm = raw.match(/^---\n([\s\S]*?)\n---\n?/);
    const nameMatch = fm?.[1].match(/^name:\s*(.+)$/m);
    return {
      name: nameMatch?.[1]?.trim() || slug,
      body: fm ? raw.slice(fm[0].length) : raw,
    };
  }
  return null;
}

/** 路径安全：仅允许 workspace 相对路径（禁 `..` 逃逸与绝对路径——输入面在 renderer，此处是信任边界） */
function isSafeRelativePath(p: string): boolean {
  if (p === '' || path.isAbsolute(p)) return false;
  const norm = path.normalize(p);
  return norm !== '..' && !norm.startsWith(`..${path.sep}`) && !norm.startsWith('.');
}

export async function expandMessageContext(
  workspaceId: string | null,
  context: MessageContext,
): Promise<ExpandedContext> {
  // 1. skills：逐 slug 展开；失败降级占位（不阻塞）
  const skills: ExpandedSkillItem[] = [];
  for (const s of context.skills) {
    const found = resolveSkillMarkdown(s.slug);
    if (found) {
      skills.push({ slug: s.slug, name: found.name, body: found.body });
    } else {
      logger.warn('context-expander：skill 不可用，降级占位', { slug: s.slug });
      skills.push({ slug: s.slug, name: s.name, body: SKILL_UNAVAILABLE });
    }
  }

  // 2. files：内联读取（单文件 + 总量双上限，超限/失败/逃逸降级 content=null）
  const root = workspaceDirOf(workspaceId);
  const files: ExpandedFileItem[] = [];
  let total = 0;
  for (const f of context.files) {
    if (!root || !isSafeRelativePath(f.path)) {
      files.push({ path: f.path, content: null });
      continue;
    }
    try {
      const abs = path.resolve(root, f.path);
      if (!abs.startsWith(path.resolve(root) + path.sep)) {
        files.push({ path: f.path, content: null });
        continue;
      }
      const stat = await fs.promises.stat(abs);
      if (stat.size > MAX_INLINE_FILE_BYTES || total + stat.size > MAX_TOTAL_INLINE_BYTES) {
        files.push({ path: f.path, content: null });
        continue;
      }
      const content = await fs.promises.readFile(abs, 'utf-8');
      total += stat.size;
      files.push({ path: f.path, content });
    } catch (err) {
      logger.warn('context-expander：文件读取失败，降级引用', {
        path: f.path,
        error: err instanceof Error ? err.message : String(err),
      });
      files.push({ path: f.path, content: null });
    }
  }

  return { skills, files };
}
```

**实现前核对三点**（以真值为准同步调整，勿盲写）：
1. `grep -rn "directoryPath\|directory_path" electron/src/main/storage/workspaces/` 确认 workspace 目录字段名
2. `grep -rn "resourcesPath\|resources" electron/src/main/skill/ electron/src/main/resource/` 确认 builtin skill 根的既有解析方式（zip-uploader 写 userData 侧的路径拼接也要看）
3. `require(...)` 动态导入若 ESLint 报错，改为顶部静态 import（注意循环依赖：context-expander ↔ workspaces repo 应无环）

测试注入：测试文件 `beforeAll` 里 `setExpanderDeps({ skillRoots: [path.join(tmpRoot, 'skills')], workspaceDir: () => path.join(tmpRoot, 'ws1') })`（在 Step 1 的测试代码 beforeAll 中补这一行），`afterAll` 里 `setExpanderDeps({})`。

- [ ] **Step 4: 跑测试确认绿** → 同 Step 2。预期 7 用例 PASS。

- [ ] **Step 5: Commit**

```bash
git add electron/src/main/im/context-expander.ts electron/tests/im/context-expander.test.ts
git commit -m "feat: 主进程上下文展开器 context-expander（skill 正文 + 文件内联 + 降级矩阵）（Task 4）"
```

---

### Task 5: 派发链接线（session-service → router → agent-runner → 子进程协议）

**Files:**
- Modify: `electron/src/main/im/session-service.ts`（sendUserMessage：落库 + 命名回退 + P2P + 路由）
- Modify: `electron/src/main/im/session.ipc.handlers.ts`（session:send 第 4 参）
- Modify: `electron/src/main/p2p/sync.ts`（SyncMessage + 形状 guard）
- Modify: `electron/src/main/p2p/index.ts`（handleRemoteMessage 落库 context）
- Modify: `electron/src/main/agent/router-service.ts`（RouteUserChatInput.context + expand + TaskConfig + steer）
- Modify: `electron/src/main/agent/agent-runner.ts`（task-config / steer 条件展开）
- Test: `electron/tests/agent/router-context.test.ts`

**Interfaces:**
- Consumes: `expandMessageContext`（Task 4）、`ExpandedContext`（Task 3）、`MessageRow.contextJson`（Task 1）
- Produces: `RouteUserChatInput.context?: MessageContext`；`router.steer(streamSessionId, body, context?: ExpandedContext)`；`task-config.context` / `steer.context` 线协议字段

- [ ] **Step 1: 写失败测试**

```typescript
// electron/tests/agent/router-context.test.ts
// 接线锁（momo-boundary-rules 第 4 条）：context 从 routeUserChat 注入 TaskConfig 与
// steer 分支——摘掉任何一跳的透传该锁必红。
import { describe, it, expect, vi } from 'vitest';
import { RouterService } from '../../src/main/agent/router-service';

function mkRunner() {
  return {
    executeTask: vi.fn().mockResolvedValue(undefined),
    steer: vi.fn().mockReturnValue(true),
    abortStream: vi.fn(),
    notifyTaskReply: vi.fn(),
  };
}

describe('routeUserChat context 接线', () => {
  it('executeTask 路径：TaskConfig 携带展开后的 ExpandedContext', async () => {
    const runner = mkRunner();
    const svc = new RouterService({
      runners: new Map([['a1', runner as never]]),
    } as never);
    const ctx = { skills: [{ slug: 's', name: 'n' }], files: [] };
    await svc.routeUserChat({ sessionId: 's1', assignmentId: 'a1', body: 'hi', context: ctx });
    const task = runner.executeTask.mock.calls[0]![0];
    expect(task.context).toBeDefined();
    expect(task.context.skills[0]!.slug).toBe('s');
    expect(task.context.skills[0]!.body).toBe('[skill 已不可用]'); // 测试环境无 skill 根 → 降级占位
  });

  it('steer 路径：展开后 context 作为第 3 参下发', async () => {
    const runner = mkRunner();
    // 占道：先走一次 executeTask 注册车道，再 steer
    const registerLane = (await import('../../src/main/agent/lane')).registerLane;
    const svc = new RouterService({
      runners: new Map([['a1', runner as never]]),
    } as never);
    const ctx = { skills: [], files: [{ path: 'a.ts' }] };
    registerLane('s2', { taskId: null, streamSessionId: 'str-1', assignmentId: 'a1' }, { kickoff: false });
    await svc.routeUserChat({ sessionId: 's2', assignmentId: 'a1', body: '补充', context: ctx });
    expect(runner.steer).toHaveBeenCalledWith(
      'str-1',
      '补充',
      expect.objectContaining({ files: expect.any(Array) }),
    );
  });

  it('无 context 时 TaskConfig.context 为 undefined（向后兼容）', async () => {
    const runner = mkRunner();
    const svc = new RouterService({
      runners: new Map([['a1', runner as never]]),
    } as never);
    await svc.routeUserChat({ sessionId: 's3', assignmentId: 'a1', body: 'hi' });
    const task = runner.executeTask.mock.calls[0]![0];
    expect(task.context).toBeUndefined();
  });
});
```

注意：`lane` 模块路径与 `registerLane` 签名以 `grep -n "registerLane\|getLane" electron/src/main/agent/*.ts` 实际结果为准（router-service.ts 顶部 import 可见真实来源）；测试环境 workspaceDir 解析为 null → 文件 content=null，属预期降级。

- [ ] **Step 2: 跑测试确认红**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/agent/router-context.test.ts
```
预期：FAIL（RouteUserChatInput 无 context 字段 / TaskConfig 无 context）

- [ ] **Step 3: 实现**

**router-service.ts**：
1. `RouteUserChatInput` 加字段：

```typescript
  /** v2.11：输入框上下文（metadata 级；展开为 ExpandedContext 后随 task-config / steer 下发） */
  context?: MessageContext;
```

（import type `MessageContext`——路径照抄本文件既有 renderer 类型引用惯例；若本文件无先例则从 `../../renderer/src/ipc/types` 相对引入并对齐 preload 三层惯例。）

2. `routeUserChat` 在 steer 分支之前展开（两分支共用一次展开）：

```typescript
    // v2.11：上下文在 steer 分支前展开一次，executeTask 与 steer 两分支共用
    //（失败降级已在 expander 内部处理，此处不 try/catch——expander 永不抛错）
    const expandedContext = input.context
      ? await expandMessageContext(input.sessionId 对应 workspaceId, input.context)
      : undefined;
```

workspaceId 解析：`getSession(input.sessionId)?.workspaceId ?? null`（import getSession——确认 router-service 现有依赖里是否已有；没有则从 `../storage/sessions/repo` 引入）。

3. steer 调用改：`runner.steer(laneEntry.streamSessionId, input.body, expandedContext)`
4. TaskConfig 构造加：`...(expandedContext ? { context: expandedContext } : {})`

**agent-runner.ts**：
1. `steer` 方法签名改：

```typescript
  steer(streamSessionId: string, body: string, context?: ExpandedContext): boolean {
    const active = this.activeTasks.get(streamSessionId);
    if (!active) return false;
    try {
      active.runtime.child.send({ type: 'steer', streamSessionId, body, ...(context ? { context } : {}) });
      return true;
    } catch {
      return false;
    }
  }
```

2. `executeTask` 的 `child.send` task-config 块追加（`historyPrefix` 行后）：

```typescript
      ...(task.context ? { context: task.context } : {}),
```

**TaskConfig（agent-runner.ts 侧的本地类型）**：grep `interface TaskConfig` 确认 agent-runner.ts 有独立 TaskConfig 还是复用 runtime-config 的——复用则零改动；独立则同型加 `context?: ExpandedContext`。

**session-service.ts** `sendUserMessage`：
1. 入参加 `context?: MessageContext`
2. `insertMessage({ ..., ...(input.context ? { contextJson: JSON.stringify(input.context) } : {}) })`
3. 命名回退（替换原 `applyFirstMessageTitle(input.sessionId, input.body);`）：

```typescript
  // v2.11：空正文 + context 非空时，首条消息命名回退到 skill 名 / 文件 basename
  const titleSource =
    input.body !== '' || !input.context
      ? input.body
      : input.context.skills[0]?.name ??
        (input.context.files[0] ? input.context.files[0].path.split('/').pop()! : '');
  applyFirstMessageTitle(input.sessionId, titleSource);
```

4. P2P 广播载荷加 context（`broadcastLocalMessage` 调用处与 `p2p/sync.ts` `SyncMessage` 接口加 `contextJson?: string | null`；`handleIncoming` 的形状 guard 放行该可选字段——非字符串直接丢弃为 undefined；`p2p/index.ts` `handleRemoteMessage` 的 `insertMessage` 透传 `contextJson: (msg as { contextJson?: string | null }).contextJson ?? null`）
5. `router.routeUserChat({ ..., ...(input.context ? { context: input.context } : {}) })`

**session.ipc.handlers.ts** `session:send` handler：第 4 参 `context` 透传 `sendUserMessage`（形状 guard：仅当 `skills`/`files` 均为数组时透传，否则 undefined——防御畸形 IPC 载荷）。

- [ ] **Step 4: 跑测试 + 既有路由回归**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/agent/router-context.test.ts tests/agent/router-leader.test.ts tests/im/session-service.test.ts tests/p2p
```
预期：全绿（P2P SyncMessage 加可选字段向后兼容，旧测试不受影响）。

- [ ] **Step 5: Commit**

```bash
git add electron/src/main/agent/router-service.ts electron/src/main/agent/agent-runner.ts electron/src/main/im/session-service.ts electron/src/main/im/session.ipc.handlers.ts electron/src/main/p2p/sync.ts electron/src/main/p2p/index.ts electron/tests/agent/router-context.test.ts
git commit -m "feat: context 派发链接线——落库/P2P/路由/task-config/steer 全线透传 + 契约锁（Task 5）"
```

---

### Task 6: 子进程消费（runTaskChatLoop + steer 监听器）

**Files:**
- Modify: `electron/src/main/agent/runtime-entry.ts`（runTaskChatLoop 解构 + renderTurnBody 包装；steer 监听器包装）
- Test: `electron/tests/agent/runtime-turn-context.test.ts`

**Interfaces:**
- Consumes: `TaskConfig.context`（Task 3/5）、`renderTurnBody`（Task 3）
- Produces: 消费行为——本轮用户正文 = `<user-context>` 块 + 原正文（一次性，不落库）

- [ ] **Step 1: 写失败测试**

```typescript
// electron/tests/agent/runtime-turn-context.test.ts
// 接线锁：task-config.context 经 runTaskChatLoop 包装进 runChatLoop 的 body 参。
// 照抄 tests/agent/runtime-task-driven.test.ts 的 mock 形态（先读该文件对齐 vi.mock 列表）。
import { describe, it, expect, vi } from 'vitest';

vi.mock('./runChatLoop-path', () => ({ runChatLoop: vi.fn().mockResolvedValue('done') }));
// ↑ 实际 mock 路径以 runtime-entry.ts 内 runChatLoop 的真实来源为准（同文件内定义
//   则改为 vi.mock runtime-entry 的依赖集合，照抄 runtime-task-driven.test.ts 现有做法）

describe('runTaskChatLoop context 包装', () => {
  it('context 存在时 body 前置 <user-context> 块', async () => {
    const { runTaskChatLoop } = await import('../../src/main/agent/runtime-entry');
    const { runChatLoop } = await import('./runChatLoop-path');
    await runTaskChatLoop(
      {
        type: 'task-config', taskId: null, executionSessionId: 's1', body: '正文',
        streamSessionId: 'str-1',
        context: { skills: [{ slug: 's', name: 'n', body: '技能指令' }], files: [] },
      } as never,
      {} as never,
      {} as never,
    );
    const body = runChatLoop.mock.calls[0]![1];
    expect(body).toContain('<user-context>');
    expect(body).toContain('技能指令');
    expect(body.endsWith('正文')).toBe(true);
  });

  it('无 context 时 body 原样（回归锁）', async () => {
    const { runTaskChatLoop } = await import('../../src/main/agent/runtime-entry');
    const { runChatLoop } = await import('./runChatLoop-path');
    await runTaskChatLoop(
      { type: 'task-config', taskId: null, executionSessionId: 's1', body: '正文', streamSessionId: 'str-2' } as never,
      {} as never,
      {} as never,
    );
    expect(runChatLoop.mock.calls.at(-1)![1]).toBe('正文');
  });
});
```

（**动手前**：通读 `electron/tests/agent/runtime-task-driven.test.ts`，把它的 vi.mock 块、config/ctx fixture 构造原样搬过来——该文件已解决「如何单测 runTaskChatLoop」的全部 mock 难题，本 task 测试只是在其上叠 body 断言。）

- [ ] **Step 2: 跑测试确认红**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/agent/runtime-turn-context.test.ts
```
预期：FAIL（context 未被消费，body 原样）

- [ ] **Step 3: 实现**

`runtime-entry.ts` `runTaskChatLoop`（L1382 起）：
1. 解构行（L1389）加 `context`：

```typescript
  const { taskId, executionSessionId: roomId, body, streamSessionId, dispatchContext, resume, historyPrefix, context } = cfg;
```

2. `runChatLoop` 调用（L1427-1448）第 2 参 `body` 改为：

```typescript
      renderTurnBody(body, context),
```

（import `{ renderTurnBody }` from `./turn-context`；在调用处上方加注释：

```typescript
  // v2.11 输入框上下文（spec 2026-09-16 §5.5）：context 包装进本轮用户正文
  //（一次性注入——DB body 保持原文，后续轮次会话重建不含 skill/文件展开，token 经济）
```

）

3. steer 监听器：`grep -n "type === 'steer'\|'steer'" electron/src/main/agent/runtime-entry.ts` 定位（`tests/agent/runtime-entry-steer.test.ts` 锁定其行为）。在把 steer body 推进 pendingSteers 的入口处包装：

```typescript
  pendingSteers.push(renderTurnBody(steerBody, steerMsg.context));
```

（变量名以实际代码为准；`steerMsg.context` 形状收窄：`isExpandedContext(v)` 轻量 guard——`skills`/`files` 均为数组，否则按 undefined。guard 函数放 turn-context.ts 导出：）

```typescript
/** steer 载荷 context 字段的形状收窄（unknown → ExpandedContext | undefined） */
export function isExpandedContext(v: unknown): v is ExpandedContext {
  if (typeof v !== 'object' || v === null) return false;
  const c = v as Record<string, unknown>;
  return Array.isArray(c['skills']) && Array.isArray(c['files']);
}
```

- [ ] **Step 4: 跑测试 + steer 回归**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/agent/runtime-turn-context.test.ts tests/agent/runtime-entry-steer.test.ts tests/agent/runtime-task-driven.test.ts
```
预期：全绿。

- [ ] **Step 5: Commit**

```bash
git add electron/src/main/agent/runtime-entry.ts electron/src/main/agent/turn-context.ts electron/tests/agent/runtime-turn-context.test.ts
git commit -m "feat: 子进程消费 context——runTaskChatLoop/steer 包装进本轮正文 + 接线锁（Task 6）"
```

---

### Task 7: renderer IPC 契约（send 第 4 参 + listCommands + store 透传）

**Files:**
- Modify: `renderer/src/ipc/types.d.ts`（SessionApiSurface.send）
- Modify: `electron/src/preload/index.ts`（session:send 第 4 参透传）
- Modify: `renderer/src/stores/session.store.ts`（sendMessage 签名）
- Test: `renderer/src/stores/session.store.test.ts`（扩展）

**Interfaces:**
- Consumes: `MessageContext`（Task 1）
- Produces: `ipc.session.send(sessionId, body, mentionedInstanceIds?, context?)`；`sendMessage(body, mentionedInstanceIds?, context?)`

- [ ] **Step 1: 写失败测试**（在 `renderer/src/stores/session.store.test.ts` 追加——先读既有 mock ipc 形态照抄）

```typescript
  it('sendMessage 透传 context 第 4 参（v2.11）', async () => {
    const ctx = { skills: [{ slug: 'code-review', name: '代码审查' }], files: [{ path: 'a.ts' }] };
    const { ipc } = await import('../ipc/client');
    const sendSpy = vi.spyOn(ipc.session, 'send').mockResolvedValue({ readOnly: false });
    await useSessionStore.getState().sendMessage('正文', undefined, ctx);
    expect(sendSpy).toHaveBeenCalledWith('会话-id', '正文', undefined, ctx);
    sendSpy.mockRestore();
  });

  it('未知 / 命令转发主进程（白名单已删）', async () => {
    const { ipc } = await import('../ipc/client');
    const cmdSpy = vi.spyOn(ipc.session, 'command').mockResolvedValue({ ok: true, message: 'ok' });
    await useSessionStore.getState().sendMessage('/whatever');
    expect(cmdSpy).toHaveBeenCalledWith('会话-id', 'whatever');
    cmdSpy.mockRestore();
  });
```

- [ ] **Step 2: 跑测试确认红**

```bash
cd renderer && npx pnpm@9.0.0 vitest run src/stores/session.store.test.ts
```
预期：FAIL（sendMessage 无第 3 参）

- [ ] **Step 3: 实现**

1. `types.d.ts` `SessionApiSurface.send`：

```typescript
  send(
    sessionId: string,
    body: string,
    mentionedInstanceIds?: string[],
    context?: MessageContext,
  ): Promise<{ readOnly: boolean }>;
```

2. `preload/index.ts` session.send 包装加第 4 参透传（照抄现有参数形态）。
3. `session.store.ts`：

```typescript
  sendMessage: (
    body: string,
    mentionedInstanceIds?: string[],
    context?: MessageContext,
  ) => Promise<{ readOnly: boolean } | undefined>;
```

实现体：`await ipc.session.send(activeSessionId, body, mentionedInstanceIds, context)`；import type 加 `MessageContext`。

- [ ] **Step 4: 双 typecheck + 测试**

```bash
npx pnpm@9.0.0 typecheck && cd renderer && npx pnpm@9.0.0 vitest run src/stores/session.store.test.ts
```
预期：全绿。

- [ ] **Step 5: Commit**

```bash
git add renderer/src/ipc/types.d.ts electron/src/preload/index.ts renderer/src/stores/session.store.ts renderer/src/stores/session.store.test.ts
git commit -m "feat: session.send context 第 4 参贯通 renderer→preload→main（Task 7）"
```

---

### Task 8: MentionInput @ 菜单文件分组

**Files:**
- Modify: `renderer/src/components/im/MentionInput.tsx`
- Test: `renderer/src/components/im/MentionInput.test.tsx`（扩展）

**Interfaces:**
- Consumes: `ipc.file.searchNames(query)`（先 grep `renderer/src/components/files/FileTree.tsx` 确认调用形态——若经 file.store 则照抄其调用方式）；`FileContextItem`
- Produces: 组件内 `pendingContext.files: FileContextItem[]`；`@/路径` 标记插入；文件 chip 渲染

- [ ] **Step 1: 写失败测试**（追加到 `MentionInput.test.tsx`，mock 形态照抄该文件既有 `useSessionStore` mock，追加 `ipc.file.searchNames` mock 返回 `[{ path: 'src/a.ts', isDirectory: false }, { path: 'src/b.ts', isDirectory: false }]`）

```typescript
  it('输入 @/ 触发文件菜单并展示搜索结果', async () => {
    render(<MentionInput />);
    await userEvent.type(screen.getByRole('textbox'), '@/a');
    expect(await screen.findByText(/选择要引用的文件/)).toBeInTheDocument();
    expect(screen.getByText('src/a.ts')).toBeInTheDocument();
  });

  it('选择文件插入 @/路径 标记并登记 chip', async () => {
    render(<MentionInput />);
    await userEvent.type(screen.getByRole('textbox'), '@/a');
    await userEvent.click(screen.getByText('src/a.ts'));
    expect(screen.getByRole('textbox')).toHaveValue(/@\/src\/a\.ts\s$/);
    expect(screen.getByLabelText('移除文件 src/a.ts')).toBeInTheDocument();
  });

  it('chip 可移除', async () => {
    render(<MentionInput />);
    await userEvent.type(screen.getByRole('textbox'), '@/a');
    await userEvent.click(screen.getByText('src/a.ts'));
    await userEvent.click(screen.getByLabelText('移除文件 src/a.ts'));
    expect(screen.queryByLabelText('移除文件 src/a.ts')).not.toBeInTheDocument();
  });

  it('发送失败恢复文件 chips 与正文', async () => {
    const sendSpy = vi.spyOn(ipc.session, 'send').mockRejectedValue(new Error('boom'));
    render(<MentionInput />);
    await userEvent.type(screen.getByRole('textbox'), '@/a');
    await userEvent.click(screen.getByText('src/a.ts'));
    await userEvent.type(screen.getByRole('textbox'), '看看这个');
    await userEvent.keyboard('{Enter}');
    await waitFor(() => {
      expect(screen.getByRole('textbox')).toHaveValue(/@\/src\/a\.ts/);
      expect(screen.getByLabelText('移除文件 src/a.ts')).toBeInTheDocument();
    });
    sendSpy.mockRestore();
  });

  // 既有 @ 成员菜单用例全部保留（回归锁——文件分组不得破坏成员分支的触发正则与行为）
```

- [ ] **Step 2: 跑测试确认红** → `cd renderer && npx pnpm@9.0.0 vitest run src/components/im/MentionInput.test.tsx`

- [ ] **Step 3: 实现**（MentionInput.tsx）

1. 状态：

```tsx
  const [pendingFiles, setPendingFiles] = useState<FileContextItem[]>([]);
  const [fileHits, setFileHits] = useState<Array<{ path: string; isDirectory: boolean }>>([]);
```

2. `detectTrigger` 追加文件分支（**现有 @ / # 正则不动**）：

```tsx
    const fileMatch = before.match(/(?:^|\s)@\/([^\s]*)$/);
    if (fileMatch) {
      setMenuType('agent'); // 文件并入 @ 菜单分组展示
      setFileQuery(fileMatch[1] ?? '');
      setFileMode(true);
    } else {
      setFileMode(false);
    }
```

（新增 `fileMode` / `fileQuery` state；`fileQuery` 变化时 debounce 200ms 调 `ipc.file.searchNames(query, 8)`——只取文件 `isDirectory === false`，结果写 `fileHits`；空 query 不搜索。）

3. @ 菜单渲染改为两组（成员组现有 + query 为空或 fileMode 时也展示文件组）：

```tsx
      {fileMode && fileHits.length > 0 && (
        <div className="px-3 py-1 text-xs text-tertiary">选择要引用的文件</div>
      )}
      {fileMode && fileHits.map((f) => (
        <button key={f.path} type="button" onClick={() => selectFile(f)} className="...同现有行样式...">
          <FileText size={12} strokeWidth={1.75} aria-hidden className="shrink-0" />
          <span className="truncate">{f.path}</span>
        </button>
      ))}
```

4. 选择与插入（`insertMention` 变体——现有正则字符集不含 `/`）：

```tsx
  const selectFile = (f: { path: string }): void => {
    // 局部替换需覆盖含 '/' 的文件局部输入（与 detectTrigger 文件分支同字符集）
    const ta = textareaRef.current;
    if (!ta) return;
    const pos = ta.selectionStart;
    const before = text.slice(0, pos);
    const after = text.slice(pos);
    const newValue = before.replace(/(?:^|\s)(@\/[^\s]*)$/, `@/${f.path}`) + ' ' + after;
    setText(newValue);
    setMenuType(null); setQuery(''); setFileMode(false);
    setPendingFiles((prev) => prev.some((x) => x.path === f.path) ? prev : [...prev, { path: f.path }]);
    setTimeout(() => { ta.focus(); const np = newValue.length - after.length; ta.setSelectionRange(np, np); }, 0);
  };
```

5. chip 区（pendingMentions chip 行追加）：

```tsx
      {pendingFiles.map((f) => (
        <button key={`file-${f.path}`} type="button" aria-label={`移除文件 ${f.path}`}
          onClick={() => setPendingFiles((prev) => prev.filter((x) => x.path !== f.path))}
          className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded bg-surface-active text-secondary hover:bg-status-error-tint hover:text-status-error">
          <FileText size={11} strokeWidth={1.75} aria-hidden />
          {f.path.split('/').pop()}
          <X size={11} strokeWidth={1.75} aria-hidden />
        </button>
      ))}
```

6. `handleSend`：文件 chips 随发送清空、失败恢复（照抄 pendingMentions 模式）；发送时并入 context（Task 9 统一组装）。
7. 草稿恢复：会话切换 effect 里 `pendingFiles` 清空（正文里的 `@/路径` 文本随 text 草稿自然保留；chips 按 body 里的标记重建可后续增强，MVP 清空——在代码注释标注该取舍）。

- [ ] **Step 4: 跑测试确认绿** → 同 Step 2。

- [ ] **Step 5: Commit**

```bash
git add renderer/src/components/im/MentionInput.tsx renderer/src/components/im/MentionInput.test.tsx
git commit -m "feat: @ 菜单文件分组——@/ 路径触发、searchNames 数据源、chip 与失败恢复（Task 8）"
```

---

### Task 9: MentionInput / 菜单（命令 + 技能）与 context 发送

**Files:**
- Modify: `renderer/src/components/im/MentionInput.tsx`
- Test: `renderer/src/components/im/MentionInput.test.tsx`（扩展）

**Interfaces:**
- Consumes: `ipc.session.listCommands()`（Task 2）、`ipc.resource.list({ type: 'skill' })`（grep `renderer/src/stores/resource.store.ts` 确认调用形态）；`sendMessage(body, mentions, context)`（Task 7）
- Produces: `/` 菜单（命令组 + 技能组）；`pendingSkills`；`handleSend` 组装 `MessageContext`

- [ ] **Step 1: 写失败测试**

```typescript
  it('空 body 输入 / 触发命令+技能两组菜单', async () => {
    render(<MentionInput />);
    await userEvent.type(screen.getByRole('textbox'), '/');
    expect(await screen.findByText('命令')).toBeInTheDocument();
    expect(screen.getByText('技能')).toBeInTheDocument();
    expect(screen.getByText(/压缩会话历史/)).toBeInTheDocument();
  });

  it('选择命令插入 /name 文本', async () => {
    render(<MentionInput />);
    await userEvent.type(screen.getByRole('textbox'), '/');
    await userEvent.click(screen.getByText('compact'));
    expect(screen.getByRole('textbox')).toHaveValue(/^\/compact\s$/);
  });

  it('选择技能登记 chip 且 body 不插文本', async () => {
    render(<MentionInput />);
    await userEvent.type(screen.getByRole('textbox'), '/code');
    await userEvent.click(screen.getByText(/代码审查/));
    expect(screen.getByRole('textbox')).toHaveValue('');
    expect(screen.getByLabelText(/移除技能 代码审查/)).toBeInTheDocument();
  });

  it('菜单激活时 Enter 选中不发送', async () => {
    const sendSpy = vi.spyOn(ipc.session, 'send').mockResolvedValue({ readOnly: false });
    render(<MentionInput />);
    await userEvent.type(screen.getByRole('textbox'), '/');
    await userEvent.keyboard('{Enter}');
    expect(sendSpy).not.toHaveBeenCalled();
    sendSpy.mockRestore();
  });

  it('空 body + 技能 chip 可发送（context 透传）', async () => {
    render(<MentionInput />);
    await userEvent.type(screen.getByRole('textbox'), '/code');
    await userEvent.click(screen.getByText(/代码审查/));
    await userEvent.keyboard('{Enter}');
    expect(sendSpy).toHaveBeenCalledWith('', undefined,
      { skills: [{ slug: 'code-review', name: '代码审查' }], files: [] });
  });

  it('body 非空时不触发 / 菜单（回归锁）', async () => {
    render(<MentionInput />);
    await userEvent.type(screen.getByRole('textbox'), '看下');
    await userEvent.type(screen.getByRole('textbox'), '/');
    expect(screen.queryByText('命令')).not.toBeInTheDocument();
  });
```

- [ ] **Step 2: 跑测试确认红** → 同 Task 8 命令。

- [ ] **Step 3: 实现**

1. 状态 + 数据缓存：

```tsx
  const [menuType, setMenuType] = useState<MenuKind | null>(null); // MenuKind 加 'command'
  const [pendingSkills, setPendingSkills] = useState<SkillContextItem[]>([]);
  const [commands, setCommands] = useState<Array<{ name: string; description: string }>>([]);
  const [skillItems, setSkillItems] = useState<Array<{ slug: string; name: string }>>([]);
```

挂载时并行拉取缓存（失败静默——菜单数据缺失不阻塞输入）：

```tsx
  useEffect(() => {
    void ipc.session.listCommands().then(setCommands).catch(() => {});
    void ipc.resource.list({ type: 'skill' })
      .then((items) => setSkillItems(items.filter((i) => i.installed).map((i) => ({ slug: i.slug, name: i.name }))))
      .catch(() => {});
  }, []);
```

（`ipc.resource.list` 形态以 `renderer/src/stores/resource.store.ts` 既有调用为准。）

2. `detectTrigger` 追加命令分支：

```tsx
    const cmdMatch = newValue.slice(0, cursorPos).match(/^\/([A-Za-z0-9-]*)$/);
    if (cmdMatch) { setMenuType('command'); setQuery(cmdMatch[1] ?? ''); }
```

（注意与现有 @/# 分支的 if-else 顺序：命令分支放最前——`/` 不与 `@`/`#` 冲突。）

3. `/` 菜单渲染：命令组（`commands` 过滤 query）+ 技能组（`skillItems` 过滤 slug/name 含 query）；命令行点击 = `insertMention('/' + name)`（复用现有 insertMention——`/name` 字符集匹配现有正则）；技能行点击 = `setPendingSkills` 登记 + 关菜单。

4. `handleSend` 改造：

```tsx
  const hasContext = pendingSkills.length > 0 || pendingFiles.length > 0;
  const trimmed = text.trim();
  if ((!trimmed && !hasContext) || !activeSessionId) return;
  const context = hasContext
    ? { skills: [...pendingSkills], files: [...pendingFiles] }
    : undefined;
  // …发送成功清空 pendingSkills/pendingFiles；失败一并恢复（照抄 mentions 模式）
  await sendMessage(trimmed, mentions, context);
```

5. chip 区追加技能 chip（`Zap` 图标，样式同文件 chip，aria-label `移除技能 ${name}`）。

- [ ] **Step 4: 跑测试确认绿** → `cd renderer && npx pnpm@9.0.0 vitest run src/components/im/MentionInput.test.tsx`

- [ ] **Step 5: Commit**

```bash
git add renderer/src/components/im/MentionInput.tsx renderer/src/components/im/MentionInput.test.tsx
git commit -m "feat: / 菜单命令+技能两组、技能 chip、context 组装发送（Task 9）"
```

---

### Task 10: InputToolbar 📎 按钮

**Files:**
- Modify: `renderer/src/components/im/InputToolbar.tsx`
- Test: `renderer/src/components/im/InputToolbar.test.tsx`（若无则新建贴源）

**Interfaces:**
- Produces: 📎 按钮 = 聚焦 MentionInput textarea 并插入 `@/` 触发文件菜单。聚焦通道：`useSessionStore` 追加 `fileTriggerTick: number`（MentionInput 订阅，与 `inputFocusTick` 同型——最小新增面，不引 context/refs 跨组件耦合）

- [ ] **Step 1: 写失败测试**

```typescript
  it('点击 📎 递增 fileTriggerTick', async () => {
    render(<InputToolbar />);
    await userEvent.click(screen.getByLabelText('引用文件'));
    expect(useSessionStore.getState().fileTriggerTick).toBe(1);
  });
```

- [ ] **Step 2: 红** → `cd renderer && npx pnpm@9.0.0 vitest run src/components/im/InputToolbar.test.tsx`

- [ ] **Step 3: 实现**

1. `session.store.ts`：`fileTriggerTick: number` 字段 + `bumpFileTrigger()` action（照抄 inputFocusTick 模式）。
2. `InputToolbar.tsx` 预留扩展位渲染按钮：

```tsx
  <button type="button" aria-label="引用文件" title="引用文件"
    disabled={readOnly}
    onClick={() => useSessionStore.getState().bumpFileTrigger()}
    className="p-1.5 rounded text-secondary hover:bg-surface-3 disabled:opacity-50">
    <Paperclip size={16} strokeWidth={1.75} aria-hidden />
  </button>
```

（readOnly 若 InputToolbar 无该状态则从 props/store 传入——对齐该组件现有只读处理。）
3. `MentionInput.tsx` 订阅：

```tsx
  const fileTriggerTick = useSessionStore((s) => s.fileTriggerTick);
  useEffect(() => {
    if (fileTriggerTick === 0) return;
    const ta = textareaRef.current;
    if (!ta) return;
    ta.focus();
    setText((prev) => (prev === '' ? '@/' : /[^\s]$/.test(prev) ? `${prev} @/` : `${prev}@/`));
    // 光标移到末尾触发 detectTrigger 的文件分支
    requestAnimationFrame(() => { ta.setSelectionRange(ta.value.length, ta.value.length); });
  }, [fileTriggerTick]);
```

（注意 setText 后同步触发 handleChange 不经过 onChange——直接在 effect 内调 `detectTrigger(newValue, newValue.length)` 保证菜单弹出。）

- [ ] **Step 4: 绿** → 同 Step 2。

- [ ] **Step 5: Commit**

```bash
git add renderer/src/components/im/InputToolbar.tsx renderer/src/components/im/InputToolbar.test.tsx renderer/src/components/im/MentionInput.tsx renderer/src/stores/session.store.ts
git commit -m "feat: 工具栏 📎 文件引用入口（fileTriggerTick 聚焦通道）（Task 10）"
```

---

### Task 11: MessageBubble context chip 渲染

**Files:**
- Modify: `renderer/src/components/im/MessageBubble.tsx`
- Test: `renderer/src/components/im/MessageBubble.test.tsx`（扩展）

**Interfaces:**
- Consumes: `ImMessage.contextJson`（Task 1 wire 契约）+ `parseMessageContext`（Task 1 renderer lib）；`ipc.file.read`（grep `renderer/src/stores/file.store.ts` 确认读取调用形态）；`useEditorStore.openFile`
- Produces: owner 消息 body 上方 context chip 行；文件 chip 点击打开编辑器

- [ ] **Step 1: 写失败测试**（MessageBubble.test.tsx 既有 fixture `makeMsg` 补 `contextJson` 字段构造）

```typescript
  it('owner 消息渲染技能与文件 chip', () => {
    render(<MessageBubble message={makeMsg({
      sender: 'owner', body: '检查这个',
      contextJson: JSON.stringify({
        skills: [{ slug: 'code-review', name: '代码审查' }],
        files: [{ path: 'src/a.ts' }],
      }),
    })} />);
    expect(screen.getByText('代码审查')).toBeInTheDocument();
    expect(screen.getByText('a.ts')).toBeInTheDocument();
  });

  it('文件 chip 点击 file:read 后打开编辑器 tab', async () => {
    const readSpy = vi.spyOn(ipc.file, 'read').mockResolvedValue('const a = 1;');
    render(<MessageBubble message={makeMsg({
      sender: 'owner', body: 'x',
      contextJson: JSON.stringify({ skills: [], files: [{ path: 'src/a.ts' }] }),
    })} />);
    await userEvent.click(screen.getByRole('button', { name: /src\/a\.ts/ }));
    expect(readSpy).toHaveBeenCalledWith('src/a.ts');
    expect(useEditorStore.getState().activeTab).toBe('src/a.ts');
  });

  it('agent 消息不渲染 context chip（回归锁）', () => {
    render(<MessageBubble message={makeMsg({
      sender: 'agent-x', body: '回复',
      contextJson: JSON.stringify({ skills: [{ slug: 's', name: '技能' }], files: [] }),
    })} />);
    expect(screen.queryByTestId('message-context-chips')).not.toBeInTheDocument();
  });

  it('读取失败 chip 降级不可点（错误路径用例）', async () => {
    const readSpy = vi.spyOn(ipc.file, 'read').mockRejectedValue(new Error('不存在'));
    render(<MessageBubble message={makeMsg({
      sender: 'owner', body: 'x',
      contextJson: JSON.stringify({ skills: [], files: [{ path: 'gone.ts' }] }),
    })} />);
    await userEvent.click(screen.getByRole('button', { name: /gone\.ts/ }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /gone\.ts/ })).toBeDisabled();
    });
    expect(useEditorStore.getState().activeTab).toBeNull();
    readSpy.mockRestore();
  });
```

- [ ] **Step 2: 红** → `cd renderer && npx pnpm@9.0.0 vitest run src/components/im/MessageBubble.test.tsx`

- [ ] **Step 3: 实现**（MessageBubble.tsx——owner 分支、`<MarkdownBody>` 之前插入；context 经 `parseMessageContext(message.contextJson)` 解析，解析失败（损坏 JSON）自然无 chip）

```tsx
  {(() => {
    const ctx = message.sender === 'owner' ? parseMessageContext(message.contextJson) : null;
    if (!ctx || (ctx.skills.length === 0 && ctx.files.length === 0)) return null;
    return (
      <div className="flex flex-wrap gap-1 mb-1.5" data-testid="message-context-chips">
        {ctx.skills.map((s) => (
          <span key={`skill-${s.slug}`} className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded bg-surface-active text-accent-600 dark:text-accent-300">
            <Zap size={11} strokeWidth={1.75} aria-hidden />{s.name}
          </span>
        ))}
        {ctx.files.map((f) => (
          <button key={`file-${f.path}`} type="button" onClick={() => void openInEditor(f.path)}
            className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded bg-surface-active text-secondary hover:bg-surface-3">
            <FileText size={11} strokeWidth={1.75} aria-hidden />{f.path.split('/').pop()}
          </button>
        ))}
      </div>
    );
  })()}
```

```tsx
/** 文件 chip 点击：读 workspace 文件后打开编辑器 tab；失败记入 failedPaths 置 disabled（不崩不弹窗） */
const [failedPaths, setFailedPaths] = useState<string[]>([]);
async function openInEditor(filePath: string): Promise<void> {
  try {
    const content = await ipc.file.read(filePath);
    useEditorStore.getState().openFile(filePath, content);
  } catch {
    setFailedPaths((prev) => (prev.includes(filePath) ? prev : [...prev, filePath]));
  }
}
```

（文件 chip 的 button 上加 `disabled={failedPaths.includes(f.path)}` 与 `disabled:opacity-50` 样式；`ipc.file.read` 返回形态以 file.store 既有用法为准——content 为 string 还是 `{content}` 视实际调整；lucide `Zap` / `FileText` import；`parseMessageContext` from `../lib/message-context`。）

- [ ] **Step 4: 绿** → 同 Step 2。

- [ ] **Step 5: Commit**

```bash
git add renderer/src/components/im/MessageBubble.tsx renderer/src/components/im/MessageBubble.test.tsx
git commit -m "feat: 消息气泡 context chip 化渲染 + 文件 chip 点击打开编辑器（Task 11）"
```

---

### Task 12: 预置技能包（3 个 builtin SKILL.md）

**Files:**
- Create: `electron/resources/skills/code-review/SKILL.md`
- Create: `electron/resources/skills/write-tests/SKILL.md`
- Create: `electron/resources/skills/debug-reproduce/SKILL.md`
- Test: `electron/tests/skill/builtin-presets.test.ts`

**Interfaces:**
- Consumes: builtin 扫描（`grep -rn "resourcesPath\|skills" electron/src/main/skill/registry.ts electron/src/main/resource/` 确认 builtin 根解析——Task 4 已核对过一次，保持同值）
- Produces: 3 个 builtin skill，`resource:list({ type: 'skill' })` 可见（source=builtin）

- [ ] **Step 1: 写失败测试**

```typescript
// electron/tests/skill/builtin-presets.test.ts
// 预置技能包：frontmatter 可解析 + registry 注册成功 + 三包齐备。
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { SkillRegistry } from '../../src/main/skill/registry';

const RESOURCES_SKILLS = path.resolve(__dirname, '../../resources/skills');

describe('builtin 预置技能包', () => {
  const slugs = ['code-review', 'write-tests', 'debug-reproduce'];

  it.each(slugs)('%s 存在且可注册', (slug) => {
    const reg = new SkillRegistry();
    reg.register(path.join(RESOURCES_SKILLS, slug));
    const idx = reg.getIndex();
    expect(idx).toContain(slug);
  });

  it('frontmatter name/description 非空（picker 元数据完整）', () => {
    for (const slug of slugs) {
      const raw = fs.readFileSync(path.join(RESOURCES_SKILLS, slug, 'SKILL.md'), 'utf-8');
      const fm = raw.match(/^---\n([\s\S]*?)\n---/);
      expect(fm, `${slug} 缺 frontmatter`).not.toBeNull();
      expect(fm![1]).toMatch(/^name:\s*\S+/m);
      expect(fm![1]).toMatch(/^description:\s*\S+/m);
      expect(fm![1]).toMatch(/^version:\s*\S+/m);
    }
  });
});
```

（`__dirname` 在 vitest ESM 下不可用——照抄 `electron/tests/skill/registry.test.ts` 的路径解析方式。）

- [ ] **Step 2: 红** → `cd electron && npx pnpm@9.0.0 vitest run tests/skill/builtin-presets.test.ts`

- [ ] **Step 3: 创建三个 SKILL.md**（中文正文，通用工程技能不绑本项目 agent）

`electron/resources/skills/code-review/SKILL.md`：

```markdown
---
name: 代码审查
description: 以缺陷预防为导向审查代码变更——先看控制流与边界，再提改进建议
version: 1.0.0
---

# 代码审查

对指定的变更（文件 / diff / 模块）执行结构化审查：

1. **先读全量上下文**：不要只看 diff——打开相关文件理解调用方与被调用方
2. **审查顺序**：正确性（逻辑 / 边界 / 空值）→ 并发与竞态 → 资源泄漏 → 错误处理是否吞状态 → 类型安全 → 可读性
3. **每个发现必须给出**：严重级别（阻断 / 重要 / 次要）、文件与行号依据、具体修复建议
4. **不要**为风格差异提阻塞意见；不确定的行为问题先写复现条件再定性
5. 输出按严重级别排序的发现清单；无阻断项时明确说「无阻断发现」
```

`electron/resources/skills/write-tests/SKILL.md`：

```markdown
---
name: 编写测试
description: 为指定模块补单元测试——先锁行为再写实现细节，错误路径必须有专项用例
version: 1.0.0
---

# 编写测试

为指定代码补测试时遵守：

1. **先读被测代码的真实依赖**：mock 只收窄到进程 / 网络 / DB 边界，业务逻辑用真实实现
2. **用例覆盖矩阵**：正常值 + 边界空值 + 错误路径（错误处理里吞状态的用例必须存在）
3. **断言被消费的字段**：id 唯一性、状态枚举、时序——不接受「调用方不应该依赖它」的占位断言
4. 测试放行标准：全绿 + 新增用例能在拿掉实现时变红（先写红再写绿）
5. 输出：测试文件路径 + 用例清单 + 运行命令
```

`electron/resources/skills/debug-reproduce/SKILL.md`：

```markdown
---
name: 调试复现
description: 修复 bug 前先建立可靠复现——最小复现、根因假设、逐个排除
version: 1.0.0
---

# 调试复现

接到「修复 X」类请求时，先完成复现再动手改：

1. **最小复现**：构造能稳定触发问题的最小输入 / 步骤；无法复现时明确报告阻塞点，不盲改
2. **根因假设**：列出至少 2-3 个候选根因，按可能性排序
3. **逐个排除**：每个假设给出验证方法（日志 / 断点 / 对照实验）与验证结果
4. **修复后回归锁**：把复现步骤固化为失败测试，修复使其变绿
5. 禁止在未定位根因前连续尝试性修改（shotgun debugging）
```

- [ ] **Step 4: 绿 + resource:list 收录验证**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/skill/builtin-presets.test.ts tests/skill
```
（若 resource 模块有 listResources 单测，追加断言三个 slug 在 builtin 列表中——`grep -rn "listResources\|resource:list" electron/tests/` 找到既有测试文件扩展。）

- [ ] **Step 5: Commit**

```bash
git add electron/resources/skills electron/tests/skill/builtin-presets.test.ts
git commit -m "feat: 预置 builtin 技能包 code-review/write-tests/debug-reproduce（Task 12）"
```

---

### Task 13: e2e + 全量验证

**Files:**
- Create: `tests/e2e/composer-context.spec.ts`

**Interfaces:**
- Consumes: 全链路（Task 1-12）

- [ ] **Step 1: 写 e2e**（照抄 `tests/e2e/` 既有 spec 的启动 / workspace fixture 模式——先 `ls tests/e2e/` 读一个最近 spec 对齐 helper）

```typescript
// tests/e2e/composer-context.spec.ts
// 输入框上下文 e2e：@ 引用文件 + / 选择技能 → 发送 → 气泡 chip 可见。
import { test, expect } from '@playwright/test';

test('输入框支持文件引用与技能 chip', async ({ page }) => {
  // 前置：进入已就绪 workspace 的 IM 会话（复用既有 e2e 的会话建立 helper）
  const input = page.getByRole('textbox');
  // 1. @ 文件引用
  await input.fill('@/package');
  await expect(page.getByText(/选择要引用的文件/)).toBeVisible();
  await page.getByRole('button', { name: /package\.json/ }).first().click();
  await expect(input).toHaveValue(/@\/package\.json/);
  // 2. 清空后 / 技能
  await input.fill('/');
  await expect(page.getByText('技能')).toBeVisible();
  await page.getByRole('button', { name: /代码审查/ }).click();
  await expect(page.getByLabel(/移除技能 代码审查/)).toBeVisible();
  // 3. 输入正文发送
  await input.fill('检查一下');
  await input.press('Enter');
  await expect(page.getByTestId('message-context-chips')).toBeVisible();
});
```

- [ ] **Step 2: 构建 + 跑 e2e**

```bash
nvm use 20 && npx pnpm@9.0.0 build && npx pnpm@9.0.0 e2e
```
（Electron 容器内如需无头：`xvfb-run -a` 包裹；ABI 注意事项见 AGENTS.md「常见陷阱」。）

- [ ] **Step 3: 全量验证**

```bash
nvm use 20 && npx pnpm@9.0.0 typecheck && npx pnpm@9.0.0 test
```
预期：两 workspace 全绿。

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/composer-context.spec.ts
git commit -m "test: 输入框上下文系统 e2e（@ 文件 + / 技能 + chip 渲染）（Task 13）"
```

---

## 验收清单（对照 spec 成功标准）

- [ ] `/` 菜单两组：命令（compact 即执行）+ 技能（chip 随消息一次性注入）
- [ ] `@` 菜单文件组 + 📎 按钮：`@/路径` 引用 workspace 文件
- [ ] 消息气泡 skill / 文件 chip 化渲染，文件 chip 点击打开编辑器
- [ ] 预置 3 个 builtin skill，`/` 菜单技能组开箱非空
- [ ] 空 body + 技能 chip 可发送；skill 正文 / 文件内容不落库不回 renderer
- [ ] steer 中途追加携带 context；P2P 远端消息 chip 只读渲染
- [ ] 双 typecheck + 双测试套件 + e2e 全绿
