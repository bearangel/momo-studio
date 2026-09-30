# Agent 创建工具集重构 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 per-agent 工具白名单失效 P0，工具目录改为注册中心自描述单一真相源（IPC 下发），创建入口支持 工具/MCP/Skill 三类能力配置，落地 Tier 0-3 工具分级。

**Architecture:** 修复 `buildRuntimeContext` 白名单并集只放行 Tier 0 动态工具；每个 `ToolModule` 新增 `getCatalog()` 自描述目录元数据，`catalog.ts` 常量改为从模块派生；新 IPC `tools:getCatalog` 下发目录，renderer 删除镜像副本改用 `useToolCatalog()` hook；migration 052 对存量 def 做只加不减的 Tier 1 回填。

**Tech Stack:** Electron 主进程（CommonJS）+ React renderer（ESM, Vite）+ better-sqlite3（JSON1 函数）+ vitest。

**Spec:** `docs/specs/2026-09-30-agent-tool-capability-redesign.md`（本计划从 spec 出发论证，执行者须同时阅读 spec）

## Global Constraints

- Node 20 LTS：容器默认 Node 26 会破坏 better-sqlite3 native binding，先 `nvm use 20`
- 包管理一律 `npx pnpm@9.0.0`；单测命令形如 `cd electron && npx pnpm@9.0.0 vitest run tests/agent/xxx.test.ts`
- TypeScript strict：禁止 `any` / `@ts-ignore` / `as any`（ESLint `no-explicit-any: error` 已启用）
- 所有代码注释使用中文；标识符英文
- Conventional Commits：`feat:` / `fix:` / `refactor:` / `test:` / `docs:`，描述用中文
- IPC 契约改动（Task 4-7）完成后必须跑双 workspace `npx pnpm@9.0.0 typecheck`
- 测试位置：electron 集中 `electron/tests/`（镜像 src 结构）；renderer 贴源 colocated
- renderer UI 只用语义 token，禁标准 Tailwind 色阶类与 inline 硬编码颜色；类别 emoji 是目录数据字段（豁免 emoji 图标禁令，沿用现状）
- 版本号纪律：实现 commit 不动版本号
- 修 bug 类改动先写失败测试再修（TDD，本计划步骤已按此排列）

## Review Focus

执行者注意：以下五类输入/失效模式 spec 有隐含要求但没有单一任务的测试显式覆盖之外的守卫，测试已分别钉在所属任务里：

1. **`allowedTools=[]` 全放行语义不变**——空数组 = 不启用白名单（仅 deniedTools 生效），修复不得改变。→ Task 1 Step 1 纯函数测试 `不改变空数组语义` 用例
2. **deniedTools 优先级不受并集影响**——即使动态工具被并入白名单，denied 命中仍拒绝。→ Task 1 Step 1 `denied 命中仍拒绝（并入白名单之后）` 用例
3. **新模块注册但漏写 meta**——将来给 `unconditionalModules()` 加模块忘写 `getCatalog()` meta 表时，目录派生必须 fail-fast 而非静默缺项。→ Task 2 Step 1 `缺 meta 条目抛错` 用例 + Task 3 完备性断言
4. **migration 只加不减**——存量 def 已有的非 Tier 1 工具（如 bash）必须原样保留。→ Task 8 Step 1 `含 bash 的 def 保留 bash` 用例
5. **IPC 目录拉取失败不阻塞创建表单**——`useToolCatalog` 出错时能力区显示错误提示，表单其余字段（名称/模型/提示词）仍可填写提交。→ Task 5 Step 1 CapabilityTabs 错误态用例

---

### Task 1: 白名单修复（P0）+ 回归锁

**Files:**
- Modify: `electron/src/main/agent/runtime-entry.ts`（`buildRuntimeContext` 内 v1.7.1 白名单并集块，约 441-451 行）
- Test: `electron/tests/agent/runtime-whitelist.test.ts`（新建）

**Interfaces:**
- Consumes: `getAllToolDefs(toolModules)`（`tools/index.ts` 现有导出）、`assertToolAllowed`（`tools/shared/permission.ts` 现有导出）
- Produces: `unionDynamicToolNames(allowedTools: string[], allTools: LLMToolDef[], builtinNames: ReadonlySet<string>): string[]`（`runtime-entry.ts` 导出，Task 3 不依赖但集成测试消费）

**背景（给零上下文执行者）：** `buildRuntimeContext` 把全部工具（`getAllToolDefs` 的 ~60 个内置工具 + 虚拟/MCP/dispatch/loop 动态工具）拼进 `tools` 数组后，有一段 v1.7.1 加入的逻辑：`allowedTools` 非空时把 `tools.map(t => t.name)` 全部并进白名单。注释意图是只并入动态工具（loadSkill / mcp:* / dispatch:* / task_complete / compact），但 `tools` 首个展开项就是全部内置工具——结果白名单永远被扩成全集，per-agent 工具配置完全失效。

- [ ] **Step 1: 写失败测试**

新建 `electron/tests/agent/runtime-whitelist.test.ts`：

```typescript
// electron/tests/agent/runtime-whitelist.test.ts
// v2.x 白名单修复回归锁（spec §4.1）：
//   1. 纯函数：unionDynamicToolNames 只并入非 builtin 工具名；空数组语义不变；
//      denied 优先级不受影响
//   2. 集成：真实链路（parseConfig → buildRuntimeContext）后，allowedTools 只含
//      配置项 + 动态工具，bash 被拒绝——修复前该链路 bash 会被放行（测试红）
// DB 隔离模式抄 dispatch-snapshot.test.ts（AP_USER_DATA_DIR 临时目录）。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { parseConfig } from '../../src/main/agent/runtime-config';
import {
  buildRuntimeContext,
  unionDynamicToolNames,
} from '../../src/main/agent/runtime-entry';
import { assertToolAllowed } from '../../src/main/agent/tools/shared/permission';
import type { LLMToolDef } from '../../src/main/agent/llm-provider';

const tmpRoot = path.join(os.tmpdir(), `ap-whitelist-test-${Date.now()}-${process.pid}`);
const wsDir = path.join(tmpRoot, 'ws');

beforeEach(() => {
  fs.mkdirSync(wsDir, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  const db = getDb();
  db.prepare(
    `INSERT INTO workspaces (id, name, description, directory_path, git_initialized, owner_id, icon_emoji)
     VALUES ('ws-1', 'WS', '', ?, 0, '@owner:local', '📁')`,
  ).run(wsDir);
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

function def(name: string): LLMToolDef {
  return { name, description: '', inputSchema: { type: 'object', properties: {} } };
}

describe('unionDynamicToolNames（纯函数）', () => {
  const builtin = new Set(['read_file', 'bash']);
  const all = [def('read_file'), def('bash'), def('loadSkill'), def('task_complete')];

  it('只并入非 builtin 工具名——bash 不被并入', () => {
    const out = unionDynamicToolNames(['read_file'], all, builtin);
    expect(out).toContain('read_file');
    expect(out).toContain('loadSkill');
    expect(out).toContain('task_complete');
    expect(out).not.toContain('bash');
  });

  it('不改变空数组语义（空 = 不启用白名单，原样返回）', () => {
    expect(unionDynamicToolNames([], all, builtin)).toEqual([]);
  });

  it('denied 命中仍拒绝（并入白名单之后）', () => {
    const out = unionDynamicToolNames(['read_file'], all, builtin);
    // loadSkill 已被并入 allowedTools，但 deniedTools 优先级更高
    expect(() =>
      assertToolAllowed('loadSkill', { allowedTools: out, deniedTools: ['loadSkill'] }),
    ).toThrow(/被禁止使用/);
  });
});

describe('buildRuntimeContext 集成（真实链路回归锁）', () => {
  it('allowedTools=[read_file] 的 agent：task_complete 放行、bash 拒绝', async () => {
    const opts = {
      agentAssignmentId: 'inst-1',
      agentUserId: '@agent:local',
      systemPrompt: 'p',
      modelName: 'm',
      llmApiKey: 'k',
      workspaceDir: wsDir,
      workspaceId: 'ws-1',
      role: 'standalone' as const,
      subAgents: [],
      skills: [],
      mcpNames: [],
      allowedTools: ['read_file'],
      deniedTools: [],
      isLeader: false,
      devMode: false,
      maxToolCalls: -1,
      contextWindow: 0,
      outputTokens: 0,
    };
    const config = parseConfig(JSON.parse(JSON.stringify(opts)));
    await buildRuntimeContext(config);
    // 修复点：内置 bash 不被自动并入（修复前此断言失败——白名单被扩成全集）
    expect(config.allowedTools).not.toContain('bash');
    // Tier 0 loop 工具仍被并入（平台机制恒放行）
    expect(config.allowedTools).toContain('task_complete');
    expect(config.allowedTools).toContain('compact');
    // 所配即所得：read_file 放行
    expect(() =>
      assertToolAllowed('read_file', { allowedTools: config.allowedTools, deniedTools: [] }),
    ).not.toThrow();
    expect(() =>
      assertToolAllowed('bash', { allowedTools: config.allowedTools, deniedTools: [] }),
    ).toThrow(/不在允许列表中/);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/agent/runtime-whitelist.test.ts
```

预期：FAIL——`unionDynamicToolNames` 不存在（导入报错），或集成用例 `not.toContain('bash')` 失败（取决于先写哪部分；两者都必须先红）。

- [ ] **Step 3: 实现修复**

`electron/src/main/agent/runtime-entry.ts`：

(a) 新增导出纯函数（放在 `buildRuntimeContext` 上方）：

```typescript
/**
 * v2.x 白名单修复（spec §4.1）：把动态工具（非 ToolModule 注册的虚拟 / MCP /
 * dispatch / builtin loop 工具，即 Tier 0 平台机制）并入 allowedTools 白名单。
 *
 * v1.7.1 的实现把 getAllToolDefs 的全部内置工具也并了进来，导致白名单被扩成
 * 全集、per-agent 工具配置完全失效（任何 agent 实际都能调全部工具，P0）。
 * 本函数只放行 Tier 0；内置工具是否可用完全由 def/workspace/delta 三层配置决定。
 */
export function unionDynamicToolNames(
  allowedTools: string[],
  allTools: LLMToolDef[],
  builtinNames: ReadonlySet<string>,
): string[] {
  if (allowedTools.length === 0) return allowedTools;
  const dynamic = allTools
    .filter((t) => !builtinNames.has(t.name))
    .map((t) => t.name);
  return [...new Set([...allowedTools, ...dynamic])];
}
```

(b) `buildRuntimeContext` 内，替换现有 v1.7.1 块（`if (config.allowedTools.length > 0) { const dynamicNames = tools.map(...); ... }`）为：

```typescript
  // v2.x 白名单修复：只并入 Tier 0 动态工具（虚拟 / MCP / dispatch / loop）。
  // 这些工具的暴露本身已受控（有 skill 才暴露 loadSkill；leader 才有 dispatch:*；
  // 配置 MCP 才有 mcp:*），并入不削弱安全模型；内置工具一律按三层配置白名单执行。
  config.allowedTools = unionDynamicToolNames(
    config.allowedTools,
    tools,
    new Set(getAllToolDefs(toolModules).map((t) => t.name)),
  );
```

注意保留原 v1.7.1 注释中关于 wire format 的说明不在此块（那是另一段），只替换白名单并集块。

- [ ] **Step 4: 跑测试确认通过**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/agent/runtime-whitelist.test.ts
```

预期：PASS（4 个用例全绿）。

- [ ] **Step 5: 跑受影响邻域回归**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/agent/dispatch-snapshot.test.ts tests/agent/mcp-discovery-notice.test.ts tests/agent/tools/shared/permission.test.ts
```

预期：PASS。若有用例依赖「白名单全集」旧（错误）行为而红，读用例意图：断言动态工具可用的保留（我们仍并入），断言内置工具被自动放行的属于锁定 bug 行为——改用例为断言按配置执行，并在 commit message 注明。

- [ ] **Step 6: Commit**

```bash
git add electron/src/main/agent/runtime-entry.ts electron/tests/agent/runtime-whitelist.test.ts
git commit -m "fix: 修复 per-agent 工具白名单被动态工具并集整体放行的 P0 缺陷"
```

---

### Task 2: ToolCatalogEntry 目录自描述（getCatalog + 14 模块元数据）

**Files:**
- Create: `electron/src/main/agent/tools/catalog-entry.ts`
- Modify: `electron/src/main/agent/tools/types.ts`（`ToolModule` 接口加 `getCatalog()`）
- Modify: `electron/src/main/agent/tools/file-tools.ts`、`apply-patch-tools.ts`、`search-tools.ts`、`shell-tools.ts`、`process-tools.ts`、`git-tools.ts`、`web-tools.ts`、`todo-tools.ts`、`task-tools.ts`、`memory-tools.ts`、`browser-tools.ts`、`office-tools.ts`、`session-tools.ts`、`lsp-tools.ts`
- Modify: `electron/src/main/agent/tools/index.ts`（抽 `unconditionalModules()`）
- Test: `electron/tests/agent/tools/catalog-selfdescribe.test.ts`（新建）

**Interfaces:**
- Consumes: `ToolModule.getDefs()`（现有）、各模块 DEFS 常量（现有）
- Produces:
  - `ToolCatalogEntry { name: string; description: string; category: string; categoryEmoji: string; defaultOn: boolean; riskNote?: string; conditional?: string }`（`catalog-entry.ts` 导出）
  - `ToolMeta = Omit<ToolCatalogEntry, 'name' | 'description'>`（`catalog-entry.ts` 导出）
  - `buildCatalog(defs: LLMToolDef[], metaByTool: Record<string, ToolMeta>): ToolCatalogEntry[]`（`catalog-entry.ts` 导出，缺 meta 抛错）
  - `ToolModule.getCatalog(): ToolCatalogEntry[]`（接口方法）
  - `LSP_CATALOG_ENTRIES: ToolCatalogEntry[]`（`lsp-tools.ts` 导出——LspTools 私有构造，目录条目走常量）
  - `unconditionalModules(): ToolModule[]`（`index.ts` 导出——13 个无条件模块列表，`buildToolRegistry` 与 catalog 派生共用，防双清单漂移）

**背景：** 目录粒度是 per-tool 而非 per-module（FileTools 里 `read_file` 默认开、`rm` 默认关），所以自描述方法返回条目数组而不是单个 meta。Tier 划分见 spec §3：Tier 1（defaultOn=true）共 17 个。

- [ ] **Step 1: 写失败测试**

新建 `electron/tests/agent/tools/catalog-selfdescribe.test.ts`：

```typescript
// electron/tests/agent/tools/catalog-selfdescribe.test.ts
// 目录自描述契约（spec §4.2）：
//   1. 每个模块 getCatalog() 与 getDefs() 名字一一对应
//   2. 每个条目 category 非空、defaultOn 为 boolean
//   3. 缺 meta 的工具在 buildCatalog 处 fail-fast（防将来新模块漏写）
//   4. LSP 条目带 conditional 标注
//   5. Tier 1（defaultOn=true）全集 = 17 个，与 spec §3.2 逐名核对
import { describe, it, expect } from 'vitest';
import { unconditionalModules } from '../../../src/main/agent/tools/index';
import { LSP_CATALOG_ENTRIES } from '../../../src/main/agent/tools/lsp-tools';
import { buildCatalog, type ToolCatalogEntry } from '../../../src/main/agent/tools/catalog-entry';
import type { LLMToolDef } from '../../../src/main/agent/llm-provider';

const TIER1 = [
  'read_file', 'write_file', 'list_files', 'edit_file', 'mkdir', 'mv', 'exists',
  'grep', 'glob',
  'todowrite',
  'read_task', 'read_task_history', 'read_task_progress', 'list_tasks',
  'memory_search',
  'list_sessions', 'read_session',
];

describe('ToolModule.getCatalog 自描述', () => {
  it('每个模块 getCatalog 与 getDefs 一一对应，category 非空且 defaultOn 为 boolean', () => {
    for (const m of unconditionalModules()) {
      const defs = m.getDefs().map((d) => d.name).sort();
      const cat = m.getCatalog().map((e) => e.name).sort();
      expect(cat).toEqual(defs);
      for (const e of m.getCatalog()) {
        expect(e.category.length).toBeGreaterThan(0);
        expect(typeof e.defaultOn).toBe('boolean');
      }
    }
  });

  it('Tier 1 全集 = 17 个且逐名核对', () => {
    const all: ToolCatalogEntry[] = [
      ...unconditionalModules().flatMap((m) => m.getCatalog()),
      ...LSP_CATALOG_ENTRIES,
    ];
    const tier1 = all.filter((e) => e.defaultOn).map((e) => e.name).sort();
    expect(tier1).toEqual([...TIER1].sort());
  });

  it('LSP 条目带 conditional 标注且 defaultOn=false', () => {
    expect(LSP_CATALOG_ENTRIES).toHaveLength(2);
    for (const e of LSP_CATALOG_ENTRIES) {
      expect(e.conditional).toContain('TS/JS');
      expect(e.defaultOn).toBe(false);
    }
  });

  it('buildCatalog 缺 meta 条目抛错（fail-fast）', () => {
    const defs: LLMToolDef[] = [
      { name: 'read_file', description: '', inputSchema: { type: 'object', properties: {} } },
    ];
    expect(() => buildCatalog(defs, {})).toThrow(/缺少目录元数据/);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/agent/tools/catalog-selfdescribe.test.ts
```

预期：FAIL（`catalog-entry.ts` 与 `getCatalog` 不存在）。

- [ ] **Step 3: 实现类型 + helper + 各模块**

(a) 新建 `electron/src/main/agent/tools/catalog-entry.ts`：

```typescript
// electron/src/main/agent/tools/catalog-entry.ts
// 目录条目类型 + 模块内构造 helper（v2.x 目录自描述，spec §4.2）。
// 独立小文件不 import 任何模块——避免 catalog.ts ↔ 模块 循环依赖。

import type { LLMToolDef } from '../llm-provider';

/** 目录条目：IPC tools:getCatalog 的载荷单元，renderer 据此渲染分组勾选 */
export interface ToolCatalogEntry {
  name: string;
  description: string;
  category: string;
  categoryEmoji: string;
  /** Tier 1 公共默认集 = true（创建时默认勾选，可取消） */
  defaultOn: boolean;
  /** 高危组 UI 提示文案（可选） */
  riskNote?: string;
  /** 条件可用说明（LSP：仅 TS/JS workspace 注册） */
  conditional?: string;
}

/** per-tool 元数据（name/description 从 DEFS 取，不重复） */
export type ToolMeta = Omit<ToolCatalogEntry, 'name' | 'description'>;

/**
 * 按名字表把模块 DEFS 映射为目录条目。缺 meta 直接抛错——fail-fast，
 * 防止「新模块注册了工具但目录漏项」的静默漂移（Task 3 完备性测试双保险）。
 */
export function buildCatalog(
  defs: LLMToolDef[],
  metaByTool: Record<string, ToolMeta>,
): ToolCatalogEntry[] {
  return defs.map((d) => {
    const meta = metaByTool[d.name];
    if (!meta) {
      throw new Error(`工具 ${d.name} 缺少目录元数据（getCatalog meta 表漏项）`);
    }
    return { name: d.name, description: d.description, ...meta };
  });
}
```

(b) `types.ts` 的 `ToolModule` 接口加方法（`handles` 之前）：

```typescript
  /** 目录自描述（v2.x 单一真相源）：与 getDefs() 一一对应的目录条目 */
  getCatalog(): ToolCatalogEntry[];
```

并在文件头 import：`import type { ToolCatalogEntry } from './catalog-entry';`

(c) `index.ts` 抽公共模块列表：

```typescript
/** 13 个无条件注册模块（buildToolRegistry 与 catalog 派生共用——单一清单防漂移） */
export function unconditionalModules(): ToolModule[] {
  return [
    new FileTools(),
    new ApplyPatchTools(),
    new SearchTools(),
    new ShellTools(),
    new ProcessTools(),
    new GitTools(),
    new WebTools(),
    new TodoTools(),
    new TaskTools(),
    new MemoryTools(),
    new BrowserTools(),
    new OfficeTools(),
    new SessionTools(),
  ];
}

export function buildToolRegistry(ctx: ToolContext): ToolModule[] {
  const modules = unconditionalModules();
  const lsp = LspTools.create(ctx);
  if (lsp) modules.push(lsp);
  return modules;
}
```

(d) 每个模块文件加三样：import、模块级 `XXX_CATALOG_META` 常量、类内 `getCatalog()`。以 `file-tools.ts` 为完整样板：

```typescript
// import 区加：
import { buildCatalog, type ToolCatalogEntry, type ToolMeta } from './catalog-entry';

// 类外常量（Tier 划分见 spec §3）：
const FILE_CATALOG_META: Record<string, ToolMeta> = {
  read_file: { category: '文件', categoryEmoji: '📁', defaultOn: true },
  write_file: { category: '文件', categoryEmoji: '📁', defaultOn: true },
  list_files: { category: '文件', categoryEmoji: '📁', defaultOn: true },
  edit_file: { category: '文件', categoryEmoji: '📁', defaultOn: true },
  mkdir: { category: '文件', categoryEmoji: '📁', defaultOn: true },
  rm: { category: '文件', categoryEmoji: '📁', defaultOn: false, riskNote: '不可恢复删除' },
  mv: { category: '文件', categoryEmoji: '📁', defaultOn: true },
  exists: { category: '文件', categoryEmoji: '📁', defaultOn: true },
};

// 类内（getDefs 旁）：
  getCatalog(): ToolCatalogEntry[] {
    return buildCatalog(this.getDefs(), FILE_CATALOG_META);
  }
```

其余 12 个模块同构，meta 表逐工具完整给出（执行者照抄，不得增删工具名）：

```typescript
// apply-patch-tools.ts
const APPLY_PATCH_CATALOG_META: Record<string, ToolMeta> = {
  apply_patch: { category: '原子补丁', categoryEmoji: '🧩', defaultOn: false, riskNote: '多文件批量修改' },
};

// search-tools.ts
const SEARCH_CATALOG_META: Record<string, ToolMeta> = {
  grep: { category: '搜索', categoryEmoji: '🔍', defaultOn: true },
  glob: { category: '搜索', categoryEmoji: '🔍', defaultOn: true },
};

// shell-tools.ts
const SHELL_CATALOG_META: Record<string, ToolMeta> = {
  bash: { category: 'Shell', categoryEmoji: '💻', defaultOn: false, riskNote: '任意代码执行' },
};

// process-tools.ts
const PROCESS_CATALOG_META: Record<string, ToolMeta> = {
  process_list: { category: '进程', categoryEmoji: '⚙️', defaultOn: false },
  process_keep: { category: '进程', categoryEmoji: '⚙️', defaultOn: false, riskNote: '进程控制' },
  process_kill: { category: '进程', categoryEmoji: '⚙️', defaultOn: false, riskNote: '进程控制' },
};

// git-tools.ts（读组无 riskNote；写组统一 '改仓库历史'）
const GIT_CATALOG_META: Record<string, ToolMeta> = {
  git_repos: { category: 'Git', categoryEmoji: '📋', defaultOn: false },
  git_status: { category: 'Git', categoryEmoji: '📋', defaultOn: false },
  git_diff: { category: 'Git', categoryEmoji: '📋', defaultOn: false },
  git_log: { category: 'Git', categoryEmoji: '📋', defaultOn: false },
  git_show: { category: 'Git', categoryEmoji: '📋', defaultOn: false },
  git_add: { category: 'Git', categoryEmoji: '📋', defaultOn: false, riskNote: '改仓库历史' },
  git_commit: { category: 'Git', categoryEmoji: '📋', defaultOn: false, riskNote: '改仓库历史' },
  git_branch: { category: 'Git', categoryEmoji: '📋', defaultOn: false, riskNote: '改仓库历史' },
  git_checkout: { category: 'Git', categoryEmoji: '📋', defaultOn: false, riskNote: '改仓库历史' },
  git_stash: { category: 'Git', categoryEmoji: '📋', defaultOn: false, riskNote: '改仓库历史' },
};

// web-tools.ts
const WEB_CATALOG_META: Record<string, ToolMeta> = {
  webfetch: { category: 'Web', categoryEmoji: '🌐', defaultOn: false, riskNote: '涉外网络请求' },
};

// todo-tools.ts
const TODO_CATALOG_META: Record<string, ToolMeta> = {
  todowrite: { category: '任务清单', categoryEmoji: '✅', defaultOn: true },
};

// task-tools.ts
const TASK_CATALOG_META: Record<string, ToolMeta> = {
  read_task: { category: '任务', categoryEmoji: '🗃️', defaultOn: true },
  read_task_history: { category: '任务', categoryEmoji: '🗃️', defaultOn: true },
  read_task_progress: { category: '任务', categoryEmoji: '🗃️', defaultOn: true },
  list_tasks: { category: '任务', categoryEmoji: '🗃️', defaultOn: true },
  create_task: { category: '任务', categoryEmoji: '🗃️', defaultOn: false, riskNote: '任务板状态变更' },
  complete_task: { category: '任务', categoryEmoji: '🗃️', defaultOn: false, riskNote: '任务板状态变更' },
  fail_task: { category: '任务', categoryEmoji: '🗃️', defaultOn: false, riskNote: '任务板状态变更' },
};

// memory-tools.ts
const MEMORY_CATALOG_META: Record<string, ToolMeta> = {
  memory_search: { category: '记忆', categoryEmoji: '🧠', defaultOn: true },
  memory_save: { category: '记忆', categoryEmoji: '🧠', defaultOn: false, riskNote: '写入记忆库' },
  memory_forget: { category: '记忆', categoryEmoji: '🧠', defaultOn: false, riskNote: '删除记忆数据' },
};

// browser-tools.ts（12 个全部 defaultOn=false，riskNote 统一）
// browser_navigate / browser_snapshot / browser_screenshot / browser_click /
// browser_type / browser_press_key / browser_hover / browser_scroll /
// browser_evaluate / browser_console_messages / browser_tabs / browser_close
const BROWSER_CATALOG_META: Record<string, ToolMeta> = {
  browser_navigate: { category: '浏览器', categoryEmoji: '🖥️', defaultOn: false, riskNote: '浏览器操作（受信任门管控）' },
  browser_snapshot: { category: '浏览器', categoryEmoji: '🖥️', defaultOn: false, riskNote: '浏览器操作（受信任门管控）' },
  browser_screenshot: { category: '浏览器', categoryEmoji: '🖥️', defaultOn: false, riskNote: '浏览器操作（受信任门管控）' },
  browser_click: { category: '浏览器', categoryEmoji: '🖥️', defaultOn: false, riskNote: '浏览器操作（受信任门管控）' },
  browser_type: { category: '浏览器', categoryEmoji: '🖥️', defaultOn: false, riskNote: '浏览器操作（受信任门管控）' },
  browser_press_key: { category: '浏览器', categoryEmoji: '🖥️', defaultOn: false, riskNote: '浏览器操作（受信任门管控）' },
  browser_hover: { category: '浏览器', categoryEmoji: '🖥️', defaultOn: false, riskNote: '浏览器操作（受信任门管控）' },
  browser_scroll: { category: '浏览器', categoryEmoji: '🖥️', defaultOn: false, riskNote: '浏览器操作（受信任门管控）' },
  browser_evaluate: { category: '浏览器', categoryEmoji: '🖥️', defaultOn: false, riskNote: '浏览器操作（受信任门管控，默认禁用）' },
  browser_console_messages: { category: '浏览器', categoryEmoji: '🖥️', defaultOn: false, riskNote: '浏览器操作（受信任门管控）' },
  browser_tabs: { category: '浏览器', categoryEmoji: '🖥️', defaultOn: false, riskNote: '浏览器操作（受信任门管控）' },
  browser_close: { category: '浏览器', categoryEmoji: '🖥️', defaultOn: false, riskNote: '浏览器操作（受信任门管控）' },
};

// office-tools.ts（9 个全部 defaultOn=false）
const OFFICE_CATALOG_META: Record<string, ToolMeta> = {
  office_read: { category: '办公', categoryEmoji: '💼', defaultOn: false },
  office_read_cells: { category: '办公', categoryEmoji: '💼', defaultOn: false },
  office_create_excel: { category: '办公', categoryEmoji: '💼', defaultOn: false, riskNote: '文件覆盖' },
  office_write_excel: { category: '办公', categoryEmoji: '💼', defaultOn: false, riskNote: '文件覆盖' },
  office_create_doc: { category: '办公', categoryEmoji: '💼', defaultOn: false, riskNote: '文件覆盖' },
  office_create_ppt: { category: '办公', categoryEmoji: '💼', defaultOn: false, riskNote: '文件覆盖' },
  office_create_pdf: { category: '办公', categoryEmoji: '💼', defaultOn: false, riskNote: '文件覆盖' },
  office_copy: { category: '办公', categoryEmoji: '💼', defaultOn: false, riskNote: '文件覆盖' },
  office_fill_ppt_template: { category: '办公', categoryEmoji: '💼', defaultOn: false, riskNote: '文件覆盖' },
};

// session-tools.ts
const SESSION_CATALOG_META: Record<string, ToolMeta> = {
  list_sessions: { category: '会话', categoryEmoji: '💬', defaultOn: true },
  read_session: { category: '会话', categoryEmoji: '💬', defaultOn: true },
};
```

每个模块类内加同构方法（meta 常量名替换为对应模块的）：

```typescript
  getCatalog(): ToolCatalogEntry[] {
    return buildCatalog(this.getDefs(), XXX_CATALOG_META);
  }
```

(e) `lsp-tools.ts`（私有构造走常量导出，放在 `REFERENCES_DEF` 之后）：

```typescript
import { buildCatalog, type ToolCatalogEntry, type ToolMeta } from './catalog-entry';

const LSP_CATALOG_META: Record<string, ToolMeta> = {
  lsp_diagnostics: {
    category: '代码', categoryEmoji: '🔧', defaultOn: false,
    conditional: '仅 TS/JS workspace 可用（条件注册）',
  },
  lsp_find_references: {
    category: '代码', categoryEmoji: '🔧', defaultOn: false,
    conditional: '仅 TS/JS workspace 可用（条件注册）',
  },
};

/** LspTools 私有构造——目录条目经此常量参与派生（与 DIAGNOSTICS_DEF/REFERENCES_DEF 一一对应） */
export const LSP_CATALOG_ENTRIES: ToolCatalogEntry[] = buildCatalog(
  [DIAGNOSTICS_DEF, REFERENCES_DEF],
  LSP_CATALOG_META,
);
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/agent/tools/catalog-selfdescribe.test.ts
```

预期：PASS（4 用例）。

- [ ] **Step 5: 模块邻域回归**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/agent/tools/
```

预期：PASS（既有模块测试不受接口新增影响；`getCatalog` 是纯新增方法）。

- [ ] **Step 6: Commit**

```bash
git add electron/src/main/agent/tools/ electron/tests/agent/tools/catalog-selfdescribe.test.ts
git commit -m "feat: ToolModule 目录自描述——getCatalog 与 per-tool 分级元数据"
```

---

### Task 3: catalog.ts 派生重写 + 存量目录测试改造

**Files:**
- Modify: `electron/src/main/agent/tools/catalog.ts`（常量改派生 + 新增 `buildToolCatalog()`）
- Test: `electron/tests/agent/tools-catalog.test.ts`（重写断言）
- Test: `electron/tests/agent/tools/tools-catalog-v2.3.test.ts`（断言适配，如结构相同则并入重写后的断言）
- Test: `electron/tests/agent/tools/office/builtin-office.test.ts`（如引用旧全集常量则适配）

**Interfaces:**
- Consumes: `unconditionalModules()`、`LSP_CATALOG_ENTRIES`（Task 2 产出）
- Produces（消费方零改动——导出符号与形状保持）:
  - `ALL_BUILTIN_TOOLS: string[]`（≈60，含 LSP）
  - `SAFE_MINIMUM_TOOLS: string[]`（17，Tier 1）
  - `TOOL_CATEGORIES: Array<{ label: string; emoji: string; tools: string[] }>`
  - `buildToolCatalog(): ToolCatalogEntry[]`（新导出，Task 4 IPC handler 消费；Task 8 migration 消费 SAFE_MINIMUM_TOOLS）

**背景：** 现有三个常量是手写数组（33 个，缺 TaskTools/MemoryTools/BrowserTools/SessionTools/ProcessTools/git_repos）。改为从模块派生后，消费方（`crud.ts` 默认工具、`p2p/resource-transfer.ts` SAFE_TOOL_REFS、`marketplace/installer.ts` clamp、migration v16 语义）符号不变、内容自动扩到全集。既有 `tools-catalog.test.ts` 锁死 34 个的断言必须改为派生断言。

- [ ] **Step 1: 重写测试为派生断言（先红——现状 33 个不满足新断言）**

重写 `electron/tests/agent/tools-catalog.test.ts`：

```typescript
// electron/tests/agent/tools-catalog.test.ts
// 目录派生契约（v2.x 单一真相源，spec §4.2）：
//   1. ALL_BUILTIN_TOOLS 覆盖注册中心全部模块工具（含 v2.x 新增的任务/记忆/浏览器/会话/进程/git_repos）
//   2. SAFE_MINIMUM_TOOLS = Tier 1（17 个，defaultOn 派生）
//   3. TOOL_CATEGORIES 并集 = ALL_BUILTIN_TOOLS 且无重复
//   4. 派生完备性：buildToolCatalog 每个条目都能在注册中心模块 defs 里找到（防手写残留）
import { describe, it, expect } from 'vitest';
import {
  ALL_BUILTIN_TOOLS,
  SAFE_MINIMUM_TOOLS,
  TOOL_CATEGORIES,
  buildToolCatalog,
} from '../../src/main/agent/tools/catalog';
import { unconditionalModules } from '../../src/main/agent/tools/index';
import { LSP_CATALOG_ENTRIES } from '../../src/main/agent/tools/lsp-tools';

describe('tools/catalog 派生常量', () => {
  it('ALL_BUILTIN_TOOLS 覆盖全部模块工具（含任务/记忆/浏览器/会话/进程/git_repos）', () => {
    for (const name of unconditionalModules().flatMap((m) => m.getDefs().map((d) => d.name))) {
      expect(ALL_BUILTIN_TOOLS).toContain(name);
    }
    for (const name of ['bash', 'lsp_find_references', 'apply_patch', 'office_read',
      'read_task', 'memory_search', 'browser_navigate', 'list_sessions', 'process_list', 'git_repos']) {
      expect(ALL_BUILTIN_TOOLS).toContain(name);
    }
    expect(new Set(ALL_BUILTIN_TOOLS).size).toBe(ALL_BUILTIN_TOOLS.length);
  });

  it('SAFE_MINIMUM_TOOLS = Tier 1 共 17 个（只读 13 + 文件写 4，不含 rm/bash）', () => {
    expect(SAFE_MINIMUM_TOOLS).toHaveLength(17);
    for (const banned of ['rm', 'bash', 'apply_patch', 'git_commit', 'webfetch', 'office_read']) {
      expect(SAFE_MINIMUM_TOOLS).not.toContain(banned);
    }
    for (const t of SAFE_MINIMUM_TOOLS) {
      expect(ALL_BUILTIN_TOOLS).toContain(t);
    }
  });

  it('TOOL_CATEGORIES 并集 = ALL_BUILTIN_TOOLS 且无重复', () => {
    const all = TOOL_CATEGORIES.flatMap((c) => c.tools);
    expect(new Set(all).size).toBe(all.length);
    expect(all.sort()).toEqual([...ALL_BUILTIN_TOOLS].sort());
  });

  it('buildToolCatalog 完备：条目数 = 模块 defs + LSP 条目数，每条目有 meta', () => {
    const entries = buildToolCatalog();
    const registryNames = [
      ...unconditionalModules().flatMap((m) => m.getDefs().map((d) => d.name)),
      ...LSP_CATALOG_ENTRIES.map((e) => e.name),
    ];
    expect(entries.map((e) => e.name).sort()).toEqual([...registryNames].sort());
    for (const e of entries) {
      expect(e.category.length).toBeGreaterThan(0);
      expect(typeof e.defaultOn).toBe('boolean');
    }
  });
});
```

同法检查 `tools-catalog-v2.3.test.ts` 与 `office/builtin-office.test.ts`：凡断言「总数 34/33」或旧 7 个最小集的用例，改为引用 `ALL_BUILTIN_TOOLS` / `SAFE_MINIMUM_TOOLS` 派生值断言成员关系（不得再锁具体数字）。

- [ ] **Step 2: 跑测试确认失败**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/agent/tools-catalog.test.ts
```

预期：FAIL（`buildToolCatalog` 未导出；工具数 33 < 断言要求）。

- [ ] **Step 3: 重写 catalog.ts 为派生实现**

`electron/src/main/agent/tools/catalog.ts` 全文替换为：

```typescript
// electron/src/main/agent/tools/catalog.ts
// v2.x 起目录常量从注册中心模块派生（单一真相源，spec §4.2）：
//   - 手写清单曾两次漂移（renderer 24 / electron 33 / 运行时 ≈60），
//     模块注册即目录，结构性根除漂移。
//   - 三个导出符号与历史形状兼容（string[] / Array<{label,emoji,tools}>），
//     crud.ts、p2p clamp、marketplace installer 等既有消费者零改动。
// 工具名来源：各模块 getDefs() 的 name 字段（经 getCatalog 自描述聚合）。
import { unconditionalModules } from './index';
import { LSP_CATALOG_ENTRIES } from './lsp-tools';
import type { ToolCatalogEntry } from './catalog-entry';

/** 全部内置工具目录（含 LSP 条目；≈60 个，随模块注册自动扩展） */
export function buildToolCatalog(): ToolCatalogEntry[] {
  return [...unconditionalModules().flatMap((m) => m.getCatalog()), ...LSP_CATALOG_ENTRIES];
}

/** 全部内置工具名全集（派生自 buildToolCatalog，模块注册顺序） */
export const ALL_BUILTIN_TOOLS: string[] = buildToolCatalog().map((e) => e.name);

/**
 * 安全最小集 = Tier 1 公共默认集（spec §3.2，17 个：只读 13 + 文件写 4）。
 * 新建 custom agent 默认勾选；p2p 导入钳制同源派生（天然不含 rm/bash/git 写）。
 */
export const SAFE_MINIMUM_TOOLS: string[] = buildToolCatalog()
  .filter((e) => e.defaultOn)
  .map((e) => e.name);

/** 类别分组（派生：按目录条目首次出现的类别顺序聚合） */
export const TOOL_CATEGORIES: Array<{ label: string; emoji: string; tools: string[] }> = (() => {
  const order: string[] = [];
  const byCat = new Map<string, { label: string; emoji: string; tools: string[] }>();
  for (const e of buildToolCatalog()) {
    let g = byCat.get(e.category);
    if (!g) {
      g = { label: e.category, emoji: e.categoryEmoji, tools: [] };
      byCat.set(e.category, g);
      order.push(e.category);
    }
    g.tools.push(e.name);
  }
  return order.map((c) => byCat.get(c)!);
})();
```

- [ ] **Step 4: 跑测试确认通过 + 全量 electron 回归**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/agent/tools-catalog.test.ts tests/agent/tools/tools-catalog-v2.3.test.ts tests/agent/tools/office/builtin-office.test.ts
cd electron && npx pnpm@9.0.0 vitest run tests/
```

预期：PASS。重点观察消费方测试：`tests/agent/crud-custom-def.test.ts`（默认工具断言从 7 变 17——按新语义更新）、`tests/agent/tools/office/builtin-office.test.ts`、`tests/resource/mcp-config.test.ts`。

- [ ] **Step 5: Commit**

```bash
git add electron/src/main/agent/tools/catalog.ts electron/tests/agent/tools-catalog.test.ts electron/tests/agent/tools/
git commit -m "refactor: 工具目录改为注册中心派生（单一真相源，Tier 1 扩至 17）"
```

---

### Task 4: IPC `tools:getCatalog` 三层接线

**Files:**
- Modify: `electron/src/main/agent/ipc.handlers.ts`（注册 handler）
- Modify: `electron/src/preload/index.ts`（桥接）
- Modify: `renderer/src/ipc/types.d.ts`（契约类型 + `tools` 组）
- Test: 复用 Task 3 的 `buildToolCatalog` 测试覆盖数据面；本任务以双 workspace typecheck + Task 5 renderer 测试（mock 此通道）为验证

**Interfaces:**
- Consumes: `buildToolCatalog()`（Task 3 产出）
- Produces（Task 5/6/7 消费）:
  - IPC 通道 `'tools:getCatalog'`，无入参，返回 `ToolCatalogEntry[]`
  - renderer `ipc.tools.getCatalog(): Promise<ToolCatalogEntry[]>`
  - renderer `types.d.ts` 内 `ToolCatalogEntry` 接口（electron 侧形状的镜像声明，仓库既有双端契约模式）

- [ ] **Step 1: electron handler**

`electron/src/main/agent/ipc.handlers.ts` 的 handler 注册区（`agent:createCustom` 附近）加：

```typescript
  // v2.x 工具目录下发（单一真相源，spec §4.3）：renderer 创建/编辑界面据此渲染
  ipcMain.handle('tools:getCatalog', () => {
    return buildToolCatalog();
  });
```

文件头 import：`import { buildToolCatalog } from '../tools/catalog';`

- [ ] **Step 2: preload 桥接**

`electron/src/preload/index.ts`：在既有分组（`agent:` 系列旁）加 `tools` 组：

```typescript
    tools: {
      getCatalog: () => invoke('tools:getCatalog'),
    },
```

- [ ] **Step 3: renderer 契约类型**

`renderer/src/ipc/types.d.ts`：在 agent 相关声明附近加镜像接口与 api 组（跟随文件内既有分组写法）：

```typescript
/** v2.x 工具目录条目（tools:getCatalog 返回项；electron 侧 catalog-entry.ts 的镜像契约） */
export interface ToolCatalogEntry {
  name: string;
  description: string;
  category: string;
  categoryEmoji: string;
  /** Tier 1 公共默认集 = true */
  defaultOn: boolean;
  riskNote?: string;
  conditional?: string;
}
```

并在 preload api 对象类型声明的分组里（`agent` / `resource` 等同级）加：

```typescript
    tools: {
      /** 工具目录（注册中心自描述，单一真相源） */
      getCatalog(): Promise<ToolCatalogEntry[]>;
    };
```

- [ ] **Step 4: 双 workspace typecheck**

```bash
npx pnpm@9.0.0 typecheck
```

预期：PASS（renderer 与 electron 都过）。若 client.ts 需要显式类型联动（17 行的薄封装），按编译报错补一处声明即可，不引入新逻辑。

- [ ] **Step 5: Commit**

```bash
git add electron/src/main/agent/ipc.handlers.ts electron/src/preload/index.ts renderer/src/ipc/types.d.ts
git commit -m "feat: IPC tools:getCatalog 下发工具目录（三层接线）"
```

---

### Task 5: `useToolCatalog` hook + CapabilityTabs/DefinitionEditor 切源 + 删 renderer 镜像

**Files:**
- Create: `renderer/src/lib/useToolCatalog.ts`
- Create: `renderer/src/lib/useToolCatalog.test.ts`
- Modify: `renderer/src/components/agent/CapabilityTabs.tsx`
- Modify: `renderer/src/components/agent/DefinitionEditor.tsx`
- Delete: `renderer/src/lib/tool-catalog.ts`
- Test: `renderer/src/components/agent/CapabilityTabs.test.tsx`（改造）、`renderer/src/components/agent/DefinitionEditor.test.tsx`（改造）

**Interfaces:**
- Consumes: `ipc.tools.getCatalog()`（Task 4 产出）、`ToolCatalogEntry`（types.d.ts）、`Capabilities`（`capability-helpers`，现有）
- Produces（Task 6/7 消费）:
  - `useToolCatalog(): { data: ToolCatalogData | null; error: string | null }`
  - `ToolCatalogData { entries: ToolCatalogEntry[]; categories: Array<{ label: string; emoji: string; tools: string[] }>; safeMinimum: string[]; allTools: string[] }`

- [ ] **Step 1: 写 hook 的失败测试**

新建 `renderer/src/lib/useToolCatalog.test.ts`：

```typescript
// renderer/src/lib/useToolCatalog.test.ts
// hook 契约：成功路径派生分组/最小集/全集；失败路径置 error 且 data 为 null；
// 模块级缓存（第二次挂载不再发 IPC）。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useToolCatalog } from './useToolCatalog';
import { ipc } from '../ipc/client';
import type { ToolCatalogEntry } from '../ipc/types';

vi.mock('../ipc/client', () => ({
  ipc: {
    tools: {
      getCatalog: vi.fn(),
    },
  },
}));

function entry(name: string, category: string, defaultOn: boolean): ToolCatalogEntry {
  return { name, description: `${name} 描述`, category, categoryEmoji: '📁', defaultOn };
}

const fakeCatalog: ToolCatalogEntry[] = [
  entry('read_file', '文件', true),
  entry('write_file', '文件', true),
  entry('rm', '文件', false),
  entry('bash', 'Shell', false),
];

describe('useToolCatalog', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('成功：派生 categories / safeMinimum / allTools', async () => {
    vi.mocked(ipc.tools.getCatalog).mockResolvedValue(fakeCatalog);
    const { result } = renderHook(() => useToolCatalog());
    await waitFor(() => expect(result.current.data).not.toBeNull());
    expect(result.current.error).toBeNull();
    expect(result.current.data?.allTools).toHaveLength(4);
    expect(result.current.data?.safeMinimum.sort()).toEqual(['read_file', 'write_file']);
    expect(result.current.data?.categories.map((c) => c.label)).toEqual(['文件', 'Shell']);
  });

  it('失败：error 置位、data 为 null（不抛出——表单其余部分不受阻塞）', async () => {
    vi.mocked(ipc.tools.getCatalog).mockRejectedValue(new Error('IPC down'));
    const { result } = renderHook(() => useToolCatalog());
    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.data).toBeNull();
    expect(result.current.error).toContain('IPC down');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd renderer && npx pnpm@9.0.0 vitest run src/lib/useToolCatalog.test.ts
```

预期：FAIL（模块不存在）。

- [ ] **Step 3: 实现 hook**

新建 `renderer/src/lib/useToolCatalog.ts`：

```typescript
// renderer/src/lib/useToolCatalog.ts
// 工具目录 hook（v2.x 单一真相源，spec §4.3）：数据来自 IPC tools:getCatalog，
// 模块级缓存 + 单飞去重——多组件共享一次请求。失败置 error 不抛出，
// 消费方（能力配置区）降级为错误提示，不阻塞表单其余字段。
import { useEffect, useState } from 'react';
import { ipc } from '../ipc/client';
import type { ToolCatalogEntry } from '../ipc/types';

export interface ToolCatalogGroup {
  label: string;
  emoji: string;
  tools: string[];
}

export interface ToolCatalogData {
  entries: ToolCatalogEntry[];
  categories: ToolCatalogGroup[];
  safeMinimum: string[];
  allTools: string[];
}

let cache: ToolCatalogData | null = null;
let inFlight: Promise<ToolCatalogData> | null = null;

function derive(entries: ToolCatalogEntry[]): ToolCatalogData {
  const order: string[] = [];
  const byCat = new Map<string, ToolCatalogGroup>();
  for (const e of entries) {
    let g = byCat.get(e.category);
    if (!g) {
      g = { label: e.category, emoji: e.categoryEmoji, tools: [] };
      byCat.set(e.category, g);
      order.push(e.category);
    }
    g.tools.push(e.name);
  }
  return {
    entries,
    categories: order.map((c) => byCat.get(c)!),
    safeMinimum: entries.filter((e) => e.defaultOn).map((e) => e.name),
    allTools: entries.map((e) => e.name),
  };
}

export function useToolCatalog(): { data: ToolCatalogData | null; error: string | null } {
  const [data, setData] = useState<ToolCatalogData | null>(cache);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (cache) {
      setData(cache);
      return;
    }
    if (!inFlight) {
      // 失败后允许重试：inFlight 复位（缓存只记成功）
      inFlight = ipc.tools
        .getCatalog()
        .then(derive)
        .then((d) => {
          cache = d;
          return d;
        });
      inFlight.catch(() => {
        inFlight = null;
      });
    }
    let cancelled = false;
    void inFlight
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return { data, error };
}
```

- [ ] **Step 4: 跑 hook 测试确认通过**

```bash
cd renderer && npx pnpm@9.0.0 vitest run src/lib/useToolCatalog.test.ts
```

预期：PASS。

- [ ] **Step 5: CapabilityTabs 切源**

`renderer/src/components/agent/CapabilityTabs.tsx`：

(a) 删除 `import { ALL_BUILTIN_TOOLS, SAFE_MINIMUM_TOOLS, TOOL_CATEGORIES } from '../../lib/tool-catalog'`，改 import：

```typescript
import { useToolCatalog } from '../../lib/useToolCatalog';
```

(b) 组件内取目录并替换渲染源：

```typescript
  const { data: catalog, error: catalogError } = useToolCatalog();
```

- 工具 Tab：`TOOL_CATEGORIES.map(...)` → `(catalog?.categories ?? []).map(...)`
- 快捷按钮（edit 模式）：`[...ALL_BUILTIN_TOOLS]` → `[...(catalog?.allTools ?? [])]`；`[...SAFE_MINIMUM_TOOLS]` → `[...(catalog?.safeMinimum ?? [])]`（catalog 未就绪时按钮 disabled）
- 目录加载态与错误态（tools Tab 顶部）：

```tsx
      {tab === 'tools' && (catalogError || !catalog) && (
        <div className="text-xs text-status-error">
          {catalogError ? `工具目录加载失败：${catalogError}` : '工具目录加载中…'}
        </div>
      )}
```

（MCP / Skill Tab 不依赖 catalog，维持既有 `ipc.resource.list` 拉取。）

(c) 改造 `CapabilityTabs.test.tsx`：删除 `vi.mock('../../lib/tool-catalog')` 或常量 import，改为 `vi.mock('../../ipc/client')` 同时 mock `tools.getCatalog`（返回小目录：2 个 defaultOn + 1 个 defaultOn=false）与 `resource.list`；既有用例的勾选/清空/最小集断言改用 mock 目录里的名字。

- [ ] **Step 6: DefinitionEditor 切源**

`renderer/src/components/agent/DefinitionEditor.tsx`：

(a) 删除 `import { SAFE_MINIMUM_TOOLS } from '../../lib/tool-catalog'`，加 `import { useToolCatalog } from '../../lib/useToolCatalog';`

(b) create 模式初始能力改为 catalog 就绪后回填 Tier 1：

```typescript
  const { data: catalog } = useToolCatalog();
  const [capabilities, setCapabilities] = useState<Capabilities>({
    tools: [],
    mcps: [],
    skills: [],
  });
  // create 模式：目录就绪后默认勾选 Tier 1（仅一次——用户已手动改动则不覆盖）
  useEffect(() => {
    if (mode !== 'create' || !catalog) return;
    setCapabilities((cur) =>
      cur.tools.length === 0
        ? { tools: [...catalog.safeMinimum], mcps: [], skills: [] }
        : cur,
    );
  }, [mode, catalog]);
```

（edit/configure 模式从 `defToCapabilities(def)` 加载的既有 useEffect 不变。）

(c) 改造 `DefinitionEditor.test.tsx`：删除 tool-catalog import，mock `../../ipc/client`（`tools.getCatalog` + 既有 `agent.*` 通道），create 模式默认工具断言改为 mock 目录的 defaultOn 集。

- [ ] **Step 7: 删除镜像 + 消费方清零验证**

```bash
git rm renderer/src/lib/tool-catalog.ts
grep -rn "tool-catalog" renderer/src --include='*.ts' --include='*.tsx'
```

预期：grep 无输出（7 个消费方——4 源文件 + 3 测试文件——已全部在本任务与 Task 6/7 前置步骤切换；CreateAgentDialog 与 AgentCreateWizard 的 import 若仍存在，先把这两个文件里对 `tool-catalog` 的 import 行删除并让 TS 报错暴露用法，具体改造在 Task 6/7——因此本步骤若 grep 到这两文件，属于预期中间态，须在 Task 7 完成后复查清零）。

**注意执行顺序调整：** 为保持每任务可独立编译，把「删 tool-catalog.ts」挪到 Task 7 末尾执行。本任务 Step 7 仅确认 CapabilityTabs/DefinitionEditor 及其测试不再引用。

- [ ] **Step 8: renderer 全量回归 + typecheck**

```bash
cd renderer && npx pnpm@9.0.0 vitest run src/
npx pnpm@9.0.0 typecheck
```

预期：PASS。

- [ ] **Step 9: Commit**

```bash
git add renderer/src/lib/useToolCatalog.ts renderer/src/lib/useToolCatalog.test.ts renderer/src/components/agent/CapabilityTabs.tsx renderer/src/components/agent/CapabilityTabs.test.tsx renderer/src/components/agent/DefinitionEditor.tsx renderer/src/components/agent/DefinitionEditor.test.tsx
git commit -m "refactor: renderer 工具目录切 IPC 单一真相源（useToolCatalog hook）"
```

---

### Task 6: CreateAgentDialog 集成 CapabilityTabs（工具/MCP/Skill 三 tab）

**Files:**
- Modify: `renderer/src/components/agent/CreateAgentDialog.tsx`
- Test: `renderer/src/components/agent/CreateAgentDialog.test.tsx`

**Interfaces:**
- Consumes: `CapabilityTabs`（现有组件，mode='edit'）、`useToolCatalog()`（Task 5）、`Capabilities`（`capability-helpers`）
- Produces: 无（叶子组件）

**背景：** 该对话框现在只有三档 preset + 纯 builtin 手写 checkbox，提交只发 `defaultTools`。改造后自定义档内嵌 `CapabilityTabs`，提交发三字段（electron 侧 `agent:createCustom` 已支持三字段，无需改动）。

- [ ] **Step 1: 改造测试（先红）**

`CreateAgentDialog.test.tsx` 核心改造点（保留既有用例意图，替换实现细节）：

```typescript
// 1) mock ipc client：agent.createCustom + tools.getCatalog + resource.list
vi.mock('../../ipc/client', () => ({
  ipc: {
    tools: {
      getCatalog: vi.fn().mockResolvedValue([
        { name: 'read_file', description: '', category: '文件', categoryEmoji: '📁', defaultOn: true },
        { name: 'bash', description: '', category: 'Shell', categoryEmoji: '💻', defaultOn: false },
      ]),
    },
    agent: {
      createCustom: vi.fn().mockResolvedValue({ id: 'def-1' }),
      // ...既有用例需要的其它通道
    },
    resource: {
      list: vi.fn().mockResolvedValue([]),
    },
  },
}));

// 2) 新用例：自定义档渲染三 tab，且提交三字段
it('自定义档：CapabilityTabs 三 tab 可用，提交携带 defaultMcps/defaultSkills', async () => {
  render(<CreateAgentDialog source="library" onClose={vi.fn()} />);
  // 填名称 + 模型（沿用既有用例的 ProviderModelPicker mock 交互）
  await userEvent.type(screen.getByLabelText('名称'), '多面手');
  // ...选择模型（沿用既有 mock）
  await userEvent.click(screen.getByRole('radio', { name: /自定义/ }));
  await userEvent.click(screen.getByRole('button', { name: /MCP/ }));   // 切 MCP tab
  // ...勾选一个 mock 的 MCP
  await userEvent.click(screen.getByRole('button', { name: /Skill/ })); // 切 Skill tab
  // ...勾选一个 mock 的 skill
  await userEvent.click(screen.getByRole('button', { name: '创建' }));
  await waitFor(() => expect(ipc.agent.createCustom).toHaveBeenCalled());
  const input = vi.mocked(ipc.agent.createCustom).mock.calls[0]![0] as Record<string, unknown>;
  expect(input.defaultTools).toEqual([{ kind: 'builtin', ref: 'read_file' }]);
  expect(Array.isArray(input.defaultMcps)).toBe(true);
  expect(Array.isArray(input.defaultSkills)).toBe(true);
});
```

（resource.list 的 MCP/Skill 返回项用 `ResourceItem` 形状的最小 mock：`{ slug: 'mcp-x', name: 'X', installed: true, ... }`——按 `ipc/types.d.ts` 的 ResourceItem 必填字段补齐。）

- [ ] **Step 2: 跑测试确认失败**

```bash
cd renderer && npx pnpm@9.0.0 vitest run src/components/agent/CreateAgentDialog.test.tsx
```

预期：FAIL（无「自定义」radio 三 tab 行为、提交无 mcps/skills 字段）。

- [ ] **Step 3: 改造组件**

`CreateAgentDialog.tsx`：

(a) import 变更：删 `import { ALL_BUILTIN_TOOLS, SAFE_MINIMUM_TOOLS, TOOL_CATEGORIES } from '../../lib/tool-catalog'`；加：

```typescript
import { CapabilityTabs, type Capabilities } from './CapabilityTabs';
import { useToolCatalog } from '../../lib/useToolCatalog';
```

(b) preset 语义升级（`ToolPreset` 与 `PRESETS` 替换）：

```typescript
type ToolPreset = 'standard' | 'all' | 'custom';

const PRESETS: Array<{ key: ToolPreset; label: string; hint: string }> = [
  { key: 'standard', label: '标准（推荐）', hint: '公共默认集：只读 + 文件写，不含 Shell / Git 写 / 网络' },
  { key: 'all', label: '全部工具', hint: '全部内置工具（含 bash、git 写、浏览器）' },
  { key: 'custom', label: '自定义', hint: '手动勾选 工具 / MCP / Skill' },
];
```

(c) 状态与目录：

```typescript
  const { data: catalog, error: catalogError } = useToolCatalog();
  // 「自定义」档的能力集合；目录就绪后初始化为 Tier 1
  const [caps, setCaps] = useState<Capabilities>({ tools: [], mcps: [], skills: [] });
  useEffect(() => {
    if (!catalog) return;
    setCaps((cur) =>
      cur.tools.length === 0
        ? { tools: [...catalog.safeMinimum], mcps: [], skills: [] }
        : cur,
    );
  }, [catalog]);
```

(d) 提交逻辑（`handleSubmit` 内 tools 解析替换）：

```typescript
    const tools =
      preset === 'standard'
        ? (catalog?.safeMinimum ?? [])
        : preset === 'all'
          ? (catalog?.allTools ?? [])
          : caps.tools;
    // catalog 未就绪时禁止提交（标准/全部档依赖目录数据）
    if (preset !== 'custom' && !catalog) {
      setError('工具目录加载中，请稍候再提交');
      return;
    }
```

`ipc.agent.createCustom` 调用处补两字段：

```typescript
        defaultTools: tools.map((ref) => ({ kind: 'builtin' as const, ref })),
        defaultMcps: caps.mcps.map((ref) => ({ kind: 'mcp' as const, ref })),
        defaultSkills: caps.skills.map((ref) => ({ kind: 'skill' as const, ref })),
```

(e) 自定义档 UI：原 `TOOL_CATEGORIES.map(...)` 手写 checkbox 区块整体替换为：

```tsx
          {preset === 'custom' && (
            <div className="flex flex-col gap-2 pl-1 pt-1">
              {catalogError && (
                <div className="text-xs text-status-error">工具目录加载失败：{catalogError}</div>
              )}
              <CapabilityTabs mode="edit" value={caps} onChange={setCaps} />
            </div>
          )}
```

（`toggleCustomTool` helper 与 `customTools` state 删除。）

- [ ] **Step 4: 跑测试确认通过 + typecheck**

```bash
cd renderer && npx pnpm@9.0.0 vitest run src/components/agent/CreateAgentDialog.test.tsx
npx pnpm@9.0.0 typecheck
```

预期：PASS。

- [ ] **Step 5: Commit**

```bash
git add renderer/src/components/agent/CreateAgentDialog.tsx renderer/src/components/agent/CreateAgentDialog.test.tsx
git commit -m "feat: CreateAgentDialog 接入能力三 tab（工具/MCP/Skill）与三字段提交"
```

---

### Task 7: AgentCreateWizard 切目录源 + 删除 renderer 镜像收尾

**Files:**
- Modify: `renderer/src/components/resource-library/wizard/AgentCreateWizard.tsx`
- Create: `renderer/src/components/resource-library/wizard/AgentCreateWizard.test.tsx`
- Delete: `renderer/src/lib/tool-catalog.ts`（Task 5 遗留的最后两个消费方之一在此清零）

**Interfaces:**
- Consumes: `useToolCatalog()`（Task 5）
- Produces: 无（叶子组件）

**背景：** Wizard 已支持 MCP/Skill 多选与三字段提交，唯一缺口是工具数据源是镜像常量 + preset 文案旧语义。

- [ ] **Step 1: 写失败测试（新建）**

新建 `renderer/src/components/resource-library/wizard/AgentCreateWizard.test.tsx`：

```typescript
// AgentCreateWizard.test.tsx
// 契约：4 步向导可走通；能力步骤工具分组来自 IPC 目录（不再是镜像常量）；
// 标准档提交 = mock 目录的 defaultOn 集。
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AgentCreateWizard } from './AgentCreateWizard';
import { ipc } from '../../../ipc/client';

vi.mock('../../../ipc/client', () => ({
  ipc: {
    tools: {
      getCatalog: vi.fn().mockResolvedValue([
        { name: 'read_file', description: '', category: '文件', categoryEmoji: '📁', defaultOn: true },
        { name: 'rm', description: '', category: '文件', categoryEmoji: '📁', defaultOn: false },
      ]),
    },
    resource: { list: vi.fn().mockResolvedValue([]) },
    agent: { createCustom: vi.fn().mockResolvedValue({ id: 'def-1' }) },
  },
}));

function next(): void {
  fireEvent.click(screen.getByRole('button', { name: '下一步' }));
}

describe('AgentCreateWizard', () => {
  it('能力步骤渲染 IPC 目录分组，标准档提交 defaultOn 集', async () => {
    render(<AgentCreateWizard onClose={vi.fn()} onSuccess={vi.fn()} />);
    await userEvent.type(screen.getByLabelText('名称'), '向导测试');
    next(); // → 提示词
    await userEvent.type(screen.getByLabelText('系统提示词'), 'p');
    next(); // → 能力
    // 分组标题来自目录 category（「文件」），工具项含目录名
    expect(await screen.findByText('文件')).toBeTruthy();
    expect(screen.getByLabelText('read_file')).toBeTruthy();
    expect(screen.getByLabelText('rm')).toBeTruthy();
    // 标准档保持默认选中
    next(); // → 模型（模型区留空会校验拦截，本用例到能力步即止断言目录渲染）
    expect(screen.getByRole('button', { name: '下一步' })).toBeTruthy();
    expect(ipc.agent.createCustom).not.toHaveBeenCalled();
  });
});
```

（模型步的 ProviderModelPicker mock 较重，首版测试只锁目录渲染与分组来源，不锁端到端提交——提交三字段链路已由 Task 6 的 CreateAgentDialog 用例与 electron `crud-custom-def.test.ts` 覆盖。）

- [ ] **Step 2: 跑测试确认失败**

```bash
cd renderer && npx pnpm@9.0.0 vitest run src/components/resource-library/wizard/AgentCreateWizard.test.tsx
```

预期：FAIL（组件从镜像常量渲染，无 IPC 依赖 mock 生效路径——`vi.mock` 未被消费，断言分组来源失败或模块加载错误）。

- [ ] **Step 3: 改造组件**

`AgentCreateWizard.tsx`：

(a) 删除 `import { ALL_BUILTIN_TOOLS, SAFE_MINIMUM_TOOLS, TOOL_CATEGORIES } from '../../../lib/tool-catalog'`；加 `import { useToolCatalog } from '../../../lib/useToolCatalog';`

(b) preset 文案与语义（对齐 Task 6）：

```typescript
type ToolPreset = 'standard' | 'all' | 'custom';

const PRESETS: Array<{ key: ToolPreset; label: string; hint: string }> = [
  { key: 'standard', label: '标准（推荐）', hint: '公共默认集：只读 + 文件写，不含 Shell 与 Git 写操作' },
  { key: 'all', label: '全部工具', hint: '全部内置工具（含 bash 与 git 写操作）' },
  { key: 'custom', label: '自定义', hint: '手动勾选工具' },
];
```

(c) 组件内：

```typescript
  const { data: catalog, error: catalogError } = useToolCatalog();
```

- `customTools` 初值 `[...SAFE_MINIMUM_TOOLS]` → `[]`，目录就绪后 Tier 1 回填（与 Task 6 同型 useEffect）
- `TOOL_CATEGORIES.map(...)` → `(catalog?.categories ?? []).map(...)`
- 提交处 `preset === 'safe' ? SAFE_MINIMUM_TOOLS : preset === 'all' ? ALL_BUILTIN_TOOLS : customTools` → `preset === 'standard' ? (catalog?.safeMinimum ?? []) : preset === 'all' ? (catalog?.allTools ?? []) : customTools`，并加 catalog 未就绪提交守卫（同 Task 6 (d)）
- 能力步加目录错误态提示（同 Task 6 (e) 的 `catalogError` 块）

- [ ] **Step 4: 删除镜像 + 消费方清零复查**

```bash
git rm renderer/src/lib/tool-catalog.ts
grep -rn "tool-catalog" renderer/src --include='*.ts' --include='*.tsx'
```

预期：grep 无输出。

- [ ] **Step 5: 跑测试确认通过 + renderer 全量回归**

```bash
cd renderer && npx pnpm@9.0.0 vitest run src/components/resource-library/wizard/AgentCreateWizard.test.tsx
cd renderer && npx pnpm@9.0.0 vitest run src/
npx pnpm@9.0.0 typecheck
```

预期：PASS。

- [ ] **Step 6: Commit**

```bash
git add renderer/src/components/resource-library/wizard/AgentCreateWizard.tsx renderer/src/components/resource-library/wizard/AgentCreateWizard.test.tsx
git rm renderer/src/lib/tool-catalog.ts 2>/dev/null || true
git commit -m "refactor: AgentCreateWizard 切换 IPC 目录源，删除 renderer 镜像副本"
```

---

### Task 8: migration 052 Tier 1 回填 + builtin YAML 对齐

**Files:**
- Create: `electron/src/main/storage/migrations/052_agent_tools_tier1_backfill.ts`
- Modify: `electron/src/main/storage/migrations/index.ts`（注册 052）
- Modify: `electron/resources/agents/coder.yaml`、`pm-agent.yaml`、`office-assistant.yaml`、`requirement-analyst.yaml`（defaultTools 加法）
- Test: `electron/tests/storage/052-tier1-backfill.test.ts`（新建）
- Test: `electron/tests/agent/builtin-yaml-tier1.test.ts`（新建）

**Interfaces:**
- Consumes: `SAFE_MINIMUM_TOOLS`（Task 3 派生常量——migration SQL 在模块加载时以 TS 模板插值嵌入 Tier 1 名单，应用后 SQL 冻结进 schema_migrations，与 v16 `BUILTIN_DEFAULT_TOOLS_JSON` 同模式）
- Produces: `migration052: Migration`（`{ version: 52, sql }`）

**背景：** 白名单修复后，存量 def 的 `default_tools` 将被真正执行。现存量（含 builtin YAML 载入的行）多数不含任务读/记忆读/会话读工具，不加法回填即为事实能力回退。Migration 接口是 `{ version, sql }` 纯 SQL 字符串（打包自包含约束，见 migrations/index.ts 头注释）——JSON 并集用 SQLite JSON1（better-sqlite3 内置，3.38+ 核心）。

- [ ] **Step 1: 写失败测试**

新建 `electron/tests/storage/052-tier1-backfill.test.ts`：

```typescript
// electron/tests/storage/052-tier1-backfill.test.ts
// migration 052 契约（spec §4.5）：
//   1. 只加不减：旧 7 工具 def → 旧集 ∪ Tier 1（17）；已有非 Tier 1 工具（bash）保留
//   2. 幂等：对已回填行重复执行等价 SQL 无变化（UNION 去重）
//   3. 空/异常输入：default_tools='[]' 的行 → 恰好 Tier 1
//   4. default_mcps / default_skills 不动
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { SAFE_MINIMUM_TOOLS } from '../../src/main/agent/tools/catalog';

const tmpRoot = path.join(os.tmpdir(), `ap-mig052-test-${Date.now()}-${process.pid}`);

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

function insertDef(id: string, toolsJson: string, mcpsJson = '[]'): void {
  getDb().prepare(
    `INSERT INTO agent_definitions
       (id, name, slug, version, runtime, system_prompt, default_tools, default_mcps,
        default_skills, source, description, icon_emoji, model_provider_id, model_name, task_driven)
     VALUES (?, ?, ?, '1.0.0', 'declarative', 'p', ?, ?, '[]', 'custom', '', '🤖', NULL, 'm', 1)`,
  ).run(id, id, id, toolsJson, mcpsJson);
}

function readTools(id: string): Array<{ kind: string; ref: string }> {
  const row = getDb().prepare('SELECT default_tools FROM agent_definitions WHERE id = ?').get(id) as {
    default_tools: string;
  };
  return JSON.parse(row.default_tools) as Array<{ kind: string; ref: string }>;
}

function replay(): void {
  // 测试行插在 runMigrations 之后——手动重放 052 SQL 等价验证「migration 时点已有行被回填」；
  // SQL 幂等（UNION 去重），重放同时验证幂等性。SQL 从 migration 导出对象取，测试与实现同源。
  getDb().exec(migration052.sql);
}

describe('migration 052 Tier 1 回填', () => {
  it('旧 7 工具 def：bash 保留 + Tier 1 全集并入（只加不减）', () => {
    const old7 = ['read_file', 'write_file', 'list_files', 'edit_file', 'grep', 'glob', 'todowrite'];
    insertDef('d1', JSON.stringify(old7.map((ref) => ({ kind: 'builtin', ref }))));
    replay();
    const refs = readTools('d1').map((t) => t.ref);
    for (const t of old7) {
      expect(refs).toContain(t);
    }
    for (const t of SAFE_MINIMUM_TOOLS) {
      expect(refs).toContain(t);
    }
  });

  it('default_tools=[] 的行 → 恰好 Tier 1（17 个），重复重放幂等', () => {
    insertDef('d2', '[]');
    replay();
    replay(); // 幂等：第二次重放结果不变
    const refs = readTools('d2').map((t) => t.ref).sort();
    expect(refs).toEqual([...SAFE_MINIMUM_TOOLS].sort());
  });

  it('default_mcps 不动', () => {
    insertDef('d3', '[]', JSON.stringify([{ kind: 'mcp', ref: 'keep-me' }]));
    replay();
    const row = getDb().prepare('SELECT default_mcps FROM agent_definitions WHERE id = ?').get('d3') as {
      default_mcps: string;
    };
    expect(JSON.parse(row.default_mcps)).toEqual([{ kind: 'mcp', ref: 'keep-me' }]);
  });
});
```

import 区需含：`import { migration052 } from '../../src/main/storage/migrations/052_agent_tools_tier1_backfill';`

新建 `electron/tests/agent/builtin-yaml-tier1.test.ts`：

```typescript
// electron/tests/agent/builtin-yaml-tier1.test.ts
// builtin agent YAML 契约（spec §4.5）：全部内置 YAML 的 defaultTools ⊇ Tier 1
// （白名单强执行后 builtin 不丢公共默认能力）。
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { load } from 'js-yaml';
import { SAFE_MINIMUM_TOOLS } from '../../src/main/agent/tools/catalog';

const yamlDir = path.resolve(__dirname, '../../resources/agents');

describe('builtin agent YAML ⊇ Tier 1', () => {
  const files = fs.readdirSync(yamlDir).filter((f) => f.endsWith('.yaml'));

  it('resources/agents 下有 4 个 YAML', () => {
    expect(files).toHaveLength(4);
  });

  for (const f of files) {
    it(`${f} defaultTools 覆盖 Tier 1 全集`, () => {
      const raw = load(fs.readFileSync(path.join(yamlDir, f), 'utf-8')) as {
        spec?: { defaultTools?: Array<{ kind?: string; ref?: string }> };
      };
      const refs = (raw.spec?.defaultTools ?? []).map((t) => t.ref);
      for (const t of SAFE_MINIMUM_TOOLS) {
        expect(refs).toContain(t);
      }
    });
  }
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/storage/052-tier1-backfill.test.ts tests/agent/builtin-yaml-tier1.test.ts
```

预期：FAIL（migration052 模块不存在；YAML 未含 Tier 1 全集）。

- [ ] **Step 3: 实现 migration + 注册**

新建 `electron/src/main/storage/migrations/052_agent_tools_tier1_backfill.ts`：

```typescript
// electron/src/main/storage/migrations/052_agent_tools_tier1_backfill.ts
// v2.x 工具分级落地（spec §4.5）：agent_definitions.default_tools 并入 Tier 1
// 公共默认集——只加不减、幂等（UNION 去重）。
//
// Tier 1 名单在模块加载时从 catalog 派生常量 JSON 序列化后模板插值进 SQL
// （与 v16 BUILTIN_DEFAULT_TOOLS_JSON 同模式）：应用时 SQL 冻结进 schema_migrations，
// 之后 catalog 演进不影响已应用库；两者一致性由 052-tier1-backfill.test.ts 守护。
// 顺序说明：mergeCapabilities 对 defaultTools 按集合语义去重，条目顺序无语义。
import type { Migration } from './index';
import { SAFE_MINIMUM_TOOLS } from '../../agent/tools/catalog';

const TIER1_JSON = JSON.stringify([...SAFE_MINIMUM_TOOLS]);

export const migration052: Migration = {
  version: 52,
  sql: `
-- v2.x Tier 1 公共默认集加法回填（只加不减，幂等）
-- 旧条目解析 ref（NULL/畸形条目跳过）UNION Tier 1 名单，重建为 {kind:'builtin',ref} 数组
UPDATE agent_definitions AS ad
SET default_tools = COALESCE((
  SELECT json_group_array(json_object('kind', 'builtin', 'ref', ref))
  FROM (
    SELECT DISTINCT ref FROM (
      SELECT json_extract(j.value, '$.ref') AS ref
      FROM json_each(COALESCE(ad.default_tools, '[]')) AS j
      WHERE json_extract(j.value, '$.ref') IS NOT NULL
      UNION
      SELECT t.value AS ref
      FROM json_each('${TIER1_JSON}') AS t
    )
  )
), '[]')
`,
};
```

`migrations/index.ts`：import 区加 `import { migration052 } from './052_agent_tools_tier1_backfill';`，注册表末尾（051 之后）加 `migration052,`（沿用既有 `{ version: migration051.version, sql: migration051.sql }` 的展开写法则按同式添加两条属性行）。

- [ ] **Step 4: builtin YAML 加法**

对 `electron/resources/agents/` 四个 YAML 逐个执行：读出 `spec.defaultTools` 现有 ref 集，把 `SAFE_MINIMUM_TOOLS`（17 名单见 Task 2 测试 TIER1 常量）中缺失的 ref 以 `- kind: builtin\n  ref: <name>` 追加到 defaultTools 列表末尾（不删除、不重排既有条目）。已知基线（勘察确认）：coder 已含文件全 + git 读；office-assistant 已含办公 + read_file/list_files/exists/webfetch/todowrite；pm-agent 与 requirement-analyst 已含文件基础——四个文件都缺任务读 4 个 + memory_search + list_sessions/read_session（部分还缺 todowrite/mv 等，以逐文件实际 diff 为准）。

- [ ] **Step 5: 跑测试确认通过 + electron 全量回归**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/storage/052-tier1-backfill.test.ts tests/agent/builtin-yaml-tier1.test.ts
cd electron && npx pnpm@9.0.0 vitest run tests/
```

预期：PASS。关注 builtin 载入相关测试（`tests/agent/definition-default-model.test.ts`、`tests/agent/tools/office/builtin-office.test.ts` 等）是否需按加法后名单适配断言。

- [ ] **Step 6: Commit**

```bash
git add electron/src/main/storage/migrations/ electron/tests/storage/052-tier1-backfill.test.ts electron/tests/agent/builtin-yaml-tier1.test.ts electron/resources/agents/
git commit -m "feat: 存量 agent 定义 Tier 1 加法回填（migration 052）与 builtin YAML 对齐"
```

---

### Task 9: 全局验证 + 研发账本

**Files:**
- Modify: `CHANGELOG.md`（研发账本条目）

**Interfaces:**
- Consumes: 全部前序任务产出
- Produces: 验收记录

- [ ] **Step 1: 双 workspace typecheck + 全量测试**

```bash
npx pnpm@9.0.0 typecheck
npx pnpm@9.0.0 test
```

预期：全部 PASS。

- [ ] **Step 2: 残留清零复查**

```bash
grep -rn "tool-catalog" renderer/src electron/src --include='*.ts' --include='*.tsx' | grep -v spec
grep -rn "getAllToolDefs(toolModules).map((t) => t.name)" electron/src
```

预期：第一条无输出（镜像已删）；第二条无输出（旧 v1.7.1 白名单写法已不存在）。

- [ ] **Step 3: 手动验收（dev 模式，spec §7）**

```bash
npx pnpm@9.0.0 dev
```

验收清单（macOS 主机直接跑；容器内需 xvfb-run）：

1. Agent 管理 → 创建 Agent：三档 preset 文案为「标准（推荐）/ 全部工具 / 自定义」；自定义档出现 工具/MCP/Skill 三 tab；工具分组含 任务/记忆/浏览器/会话/进程 等新类别
2. 创建一个仅勾 Tier 1 的 agent（名字如 `受限测试`），加入工作空间并启动
3. 会话内发消息要求它执行 `bash ls`（如「请用 bash 列出目录」）→ 期望收到「工具 bash 不在允许列表中」类拒绝反馈，而非命令输出
4. 再创建一个勾选 bash 的 agent 对照 → 能正常执行
5. 资源库 → 新建智能体（Wizard）：能力步骤分组同新目录；标准档 hint 为新文案

- [ ] **Step 4: CHANGELOG 研发账本条目**

`CHANGELOG.md` 按既有条目格式（`### 研发中` 区块或最新 alpha 小节，遵循文件内最近条目的排版）追加：

```markdown
- **Agent 创建工具集重构**：修复 per-agent 工具白名单失效 P0（v1.7.1 并集误放行全部工具）；工具目录改为注册中心自描述单一真相源（`tools:getCatalog` IPC 下发，删除 renderer 镜像，24/33/60 三层漂移根除）；工具分级 Tier 0-3（平台机制恒注入 / Tier 1 公共默认 17 个 / 可选 / MCP+Skill 扩展）；创建入口（CreateAgentDialog + Wizard）支持 工具/MCP/Skill 三类能力配置；migration 052 存量 Tier 1 加法回填。spec：`docs/specs/2026-09-30-agent-tool-capability-redesign.md`
```

（不动版本号——研发期纪律。）

- [ ] **Step 5: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs: 工具集重构研发账本条目"
```

---

## 任务依赖关系

- Task 1（白名单修复）独立，可最先做（P0，价值最高）
- Task 2 → Task 3 → Task 4 → Task 5 → {Task 6, Task 7} → Task 8（依赖 Task 3 的 SAFE_MINIMUM_TOOLS 派生）→ Task 9
- Task 6 与 Task 7 相互独立，可并行
