# 新装引导系统（Onboarding Wizard）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新装用户首启经向导（AI / 手动两路线）从零到达「供应商 + 工作空间 + 已配置 agent + 默认会话 agent」的可用状态。

**Architecture:** 主进程 OnboardingService（状态 kv + 方案生成直调 LLM + 幂等应用）+ renderer 步骤向导；4 个新 IPC 通道（`onboarding:*`），其余全部复用既有通道与启用链。

**Tech Stack:** Electron 主进程（CommonJS / better-sqlite3 kv_store）+ React/zustand-free 本地状态向导 + vitest（electron 集中 tests/、renderer 贴源）+ Playwright e2e。

**Spec:** `docs/specs/2026-10-10-onboarding-wizard-design.md`（本计划的所有需求论证以 spec 为准，执行者须同时读 spec）

## Global Constraints

- Node 20 LTS：所有命令前 `nvm use 20`；pnpm 用 `npx pnpm@9.0.0`
- TypeScript strict：**禁止** `any` / `as any` / `@ts-ignore`（ESLint `no-explicit-any: error`）
- 所有代码注释、文档中文；标识符英文
- renderer UI 只用语义 token（`bg-surface-*` / `text-secondary`…），禁标准 Tailwind 色阶、禁 inline 硬编码颜色、禁 emoji 图标（lucide-react 16px / stroke 1.75）；原子组件优先（`components/ui/`）
- 测试位置：electron 主进程集中 `electron/tests/`（镜像 src）；renderer 贴源 colocated；根 `tests/` 仅 e2e
- Conventional Commits：`feat:` / `test:` / `refactor:`
- IPC 契约双端镜像：renderer `types.d.ts` 与 electron 侧类型结构对齐（跨进程不共享类型文件）；改后两个 workspace 都要 typecheck
- 每任务完成跑 `npx pnpm@9.0.0 typecheck`（根目录）
- LLM mock 保真：mock `createLLMProvider` 的调用边界（入参形状、返回 `LLMResponse` 形状）与真实一致，不得为测试 convenience 简化（momo-test-rules）

## Review Focus

以下输入类/故障模式 spec 有要求但没有单任务显式覆盖，各自测试已归入所属任务：

1. **LLM 返回带 markdown 围栏或前后杂文的 JSON** → `stripJsonFence` + shape guard 解析成功（Task 3 测试）
2. **applyPlan 整包重试（部分失败后）** → 无重复 def / 无重复成员：preset 启用链幂等 + custom 按 name 查重复用（Task 4 测试）
3. **provider 已删除 / API key 为空时生成** → 中文错误抛出，不产生半配置（Task 3 测试）
4. **plan.agents 空数组 / defaultAgentIndex 越界 / 未注册引用** → sanitize 拒绝或钳制 + warning（Task 2 测试）
5. **App boot 时 `onboarding:getStatus` IPC 失败** → 视为 pending 不阻塞启动，走向导（Task 6 测试）
6. **需求文本超 4000 字符** → 截断后进 prompt，不静默截断 UI（Task 3 截断 + Task 8 输入提示）

---

### Task 1: 契约类型 + 状态服务 + status 通道 + 全链接线

**Files:**
- Create: `electron/src/main/onboarding/status.ts`
- Create: `electron/src/main/onboarding/ipc.handlers.ts`
- Create: `electron/tests/onboarding/status.test.ts`
- Modify: `renderer/src/ipc/types.d.ts`（文件末尾加类型 + `ApiSurface` 加 `onboarding` 命名空间）
- Modify: `electron/src/preload/index.ts`（`api` 对象加 `onboarding` 段）
- Modify: `electron/src/main/ipc/index.ts`（import + 调用 `registerOnboardingHandlers()`）

**Interfaces:**
- Consumes: `kv_store` 表（既有）；`getDb`（`electron/src/main/storage/db`）
- Produces: `readOnboardingStatus(): 'pending'|'completed'|'skipped'`、`markOnboardingDone(skipped: boolean): void`；renderer 全部 onboarding 类型（后续任务的类型基础）+ `ipc.onboarding.getStatus / markDone`（generatePlan / applyPlan 在 Task 3/4 才注册 main handler，preload 先行暴露安全——未注册通道仅在实际调用时 reject）

- [ ] **Step 1: 在 `renderer/src/ipc/types.d.ts` 文件末尾追加 onboarding 类型段**

```ts
// ─── Onboarding（新装引导，spec 2026-10-10 §5）────────────────────────────

/** 引导一次性状态（kv_store: onboarding.status） */
export type OnboardingStatus = 'pending' | 'completed' | 'skipped';

/** onboarding:generatePlan 入参 */
export interface GenerateOnboardingPlanInput {
  /** 用户需求描述；主进程截断至 4000 字符 */
  requirement: string;
  /** 第②步配好的供应商 + 模型（生成调用与 custom agent 落库共用） */
  providerId: string;
  modelId: string;
}

/** 方案 agent 项：预制启用（优先路线） */
export interface OnboardingPlanPresetAgent {
  kind: 'preset';
  slug: string;
  /** 给用户看的选择理由（中文一句话） */
  reason: string;
  /** LLM 追加挂载的 MCP 名（应用前过滤到已注册集） */
  mcps: string[];
  skills: string[];
}

/** 方案 agent 项：自定义生成（预制不满足时的降级路线） */
export interface OnboardingPlanCustomAgent {
  kind: 'custom';
  name: string;
  iconEmoji: string;
  systemPrompt: string;
  /** standard=安全最小集 / all=全部内置工具（引导期不暴露 custom 勾选档） */
  toolPreset: 'standard' | 'all';
  reason: string;
  mcps: string[];
  skills: string[];
}

export type OnboardingPlanAgent = OnboardingPlanPresetAgent | OnboardingPlanCustomAgent;

/** LLM 生成 / 用户勾改后的配置方案 */
export interface OnboardingPlan {
  agents: OnboardingPlanAgent[];
  /** 默认会话 agent 指向 agents[i]；应用时越界钳制到 0 */
  defaultAgentIndex: number;
}

/** onboarding:applyPlan 入参 */
export interface ApplyOnboardingPlanInput {
  plan: OnboardingPlan;
  workspaceId: string;
  providerId: string;
  modelId: string;
}

/** onboarding:applyPlan 返回 */
export interface OnboardingApplyResult {
  applied: Array<{ name: string; kind: 'preset' | 'custom'; instanceId: string }>;
  /** 非致命警告（剔除的未注册引用等），预览页与结果页展示 */
  warnings: string[];
  defaultAgentName: string;
}

/** onboarding:markDone 入参 */
export interface MarkOnboardingDoneInput {
  skipped: boolean;
}

/** generatePlan 的返回（方案 + 生成侧过滤警告） */
export interface GenerateOnboardingPlanResult {
  plan: OnboardingPlan;
  warnings: string[];
}
```

并在 `ApiSurface` 接口中（与既有命名空间并列）追加：

```ts
  /** 新装引导（spec 2026-10-10）——main 侧 onboarding/ipc.handlers.ts */
  onboarding: {
    getStatus: () => Promise<{ status: OnboardingStatus }>;
    generatePlan: (input: GenerateOnboardingPlanInput) => Promise<GenerateOnboardingPlanResult>;
    applyPlan: (input: ApplyOnboardingPlanInput) => Promise<OnboardingApplyResult>;
    markDone: (input: MarkOnboardingDoneInput) => Promise<void>;
  };
```

（import 类型列表同步补齐；`ApiSurface` 若是从各 interface 聚合的大接口，按文件内既有风格插入。）

- [ ] **Step 2: 写 status 服务失败测试**

`electron/tests/onboarding/status.test.ts`：

```ts
// onboarding 状态 kv 服务测试：缺省 pending / completed / skipped 持久 / 畸形值容错。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import {
  ONBOARDING_STATUS_KEY,
  readOnboardingStatus,
  markOnboardingDone,
} from '../../src/main/onboarding/status';

const tmpRoot = path.join(os.tmpdir(), `onboarding-status-${Date.now()}`);

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

describe('onboarding status kv', () => {
  it('无标记时缺省 pending', () => {
    expect(readOnboardingStatus()).toBe('pending');
  });

  it('markOnboardingDone(false) 写 completed 并持久', () => {
    markOnboardingDone(false);
    expect(getDb().prepare('SELECT value FROM kv_store WHERE key = ?').get(ONBOARDING_STATUS_KEY))
      .toEqual({ value: '"completed"' });
    expect(readOnboardingStatus()).toBe('completed');
  });

  it('markOnboardingDone(true) 写 skipped', () => {
    markOnboardingDone(true);
    expect(readOnboardingStatus()).toBe('skipped');
  });

  it('markOnboardingDone 幂等（重复写不报错）', () => {
    markOnboardingDone(false);
    markOnboardingDone(false);
    expect(readOnboardingStatus()).toBe('completed');
  });

  it('畸形值容错回 pending（不抛错）', () => {
    getDb()
      .prepare(
        `INSERT INTO kv_store (key, value, updated_at) VALUES (?, ?, datetime('now'))`,
      )
      .run(ONBOARDING_STATUS_KEY, 'not-json{');
    expect(readOnboardingStatus()).toBe('pending');
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/onboarding/status.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 4: 实现 `electron/src/main/onboarding/status.ts`**

```ts
// electron/src/main/onboarding/status.ts
//
// 引导一次性状态（kv_store，spec 2026-10-10 §4）。
// 读写先例：upgrade/legacy-upgrade.ts 的 LEGACY_UPGRADE_NOTICE_KEY——
// 容错读（畸形值按缺省处理，绝不阻塞启动）+ 幂等写（upsert）。
import { getDb } from '../storage/db';

export const ONBOARDING_STATUS_KEY = 'onboarding.status';

export type OnboardingStatus = 'pending' | 'completed' | 'skipped';

const VALID: readonly OnboardingStatus[] = ['pending', 'completed', 'skipped'];

/** 读引导状态；无标记 / 畸形值一律回 pending（新装语义，UI 不因坏值崩溃） */
export function readOnboardingStatus(): OnboardingStatus {
  const row = getDb()
    .prepare('SELECT value FROM kv_store WHERE key = ?')
    .get(ONBOARDING_STATUS_KEY) as { value: string } | undefined;
  if (!row) return 'pending';
  try {
    const parsed = JSON.parse(row.value) as unknown;
    if (typeof parsed === 'string' && (VALID as readonly string[]).includes(parsed)) {
      return parsed as OnboardingStatus;
    }
    return 'pending';
  } catch {
    return 'pending';
  }
}

/** 完成或跳过时写终态；upsert 幂等 */
export function markOnboardingDone(skipped: boolean): void {
  const value: OnboardingStatus = skipped ? 'skipped' : 'completed';
  getDb()
    .prepare(
      `INSERT INTO kv_store (key, value, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(ONBOARDING_STATUS_KEY, JSON.stringify(value));
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/onboarding/status.test.ts`
Expected: PASS（5 用例）

- [ ] **Step 6: IPC handler + preload + 注册接线**

`electron/src/main/onboarding/ipc.handlers.ts`（本任务先注册 2 通道，Task 3/4 补 2 个）：

```ts
// electron/src/main/onboarding/ipc.handlers.ts
//
// onboarding:* IPC handlers（spec 2026-10-10 §5）。generatePlan / applyPlan
// 分别在 plan-generator / plan-applier 就绪后注册（分任务接线）。
import { ipcMain } from 'electron';
import { logger } from '../logger';
import { readOnboardingStatus, markOnboardingDone } from './status';

export function registerOnboardingHandlers(): void {
  ipcMain.handle('onboarding:getStatus', () => ({ status: readOnboardingStatus() }));

  ipcMain.handle('onboarding:markDone', (_e, input: { skipped: boolean }) => {
    markOnboardingDone(input.skipped);
    return { ok: true } as const;
  });

  logger.info('Onboarding IPC handlers 已注册');
}
```

`electron/src/main/ipc/index.ts`：import 区加 `import { registerOnboardingHandlers } from '../onboarding/ipc.handlers';`，`registerIpcHandlers` 函数体内（`registerP2pHandlers();` 之后）加一行 `registerOnboardingHandlers();`。

`electron/src/preload/index.ts`：import 类型列表补 `GenerateOnboardingPlanInput, ApplyOnboardingPlanInput, GenerateOnboardingPlanResult, OnboardingApplyResult, OnboardingStatus, MarkOnboardingDoneInput`，`api` 对象中加：

```ts
  // 新装引导（spec 2026-10-10）：status 通道 Task 1 接线；
  // generatePlan / applyPlan 的 main handler 在 Task 3/4 注册
  onboarding: {
    getStatus: () => invoke<{ status: OnboardingStatus }>('onboarding:getStatus'),
    generatePlan: (input: GenerateOnboardingPlanInput) =>
      invoke<GenerateOnboardingPlanResult>('onboarding:generatePlan', input),
    applyPlan: (input: ApplyOnboardingPlanInput) =>
      invoke<OnboardingApplyResult>('onboarding:applyPlan', input),
    markDone: (input: MarkOnboardingDoneInput) => invoke<void>('onboarding:markDone', input),
  },
```

- [ ] **Step 7: 双端 typecheck**

Run: `npx pnpm@9.0.0 typecheck`
Expected: 两 workspace 0 error

- [ ] **Step 8: Commit**

```bash
git add electron/src/main/onboarding/ electron/tests/onboarding/ electron/src/main/ipc/index.ts electron/src/preload/index.ts renderer/src/ipc/types.d.ts
git commit -m "feat(onboarding): 引导状态 kv 服务 + getStatus/markDone 通道 + 全契约类型接线"
```

---

### Task 2: Plan 类型守卫 + sanitize（plan-types）

**Files:**
- Create: `electron/src/main/onboarding/plan-types.ts`
- Create: `electron/tests/onboarding/plan-types.test.ts`

**Interfaces:**
- Consumes: Task 1 的类型形状（electron 侧在本文件**独立定义同形类型**——repo 惯例：跨进程仅结构对齐不共享文件）
- Produces: `isOnboardingPlan(v): v is OnboardingPlan`、`sanitizePlan(raw, ctx): { plan: OnboardingPlan | null; warnings: string[] }`、`PlanSanitizeContext`——Task 3 / Task 4 共用（双保险过滤）

- [ ] **Step 1: 写失败测试**

`electron/tests/onboarding/plan-types.test.ts`：

```ts
// OnboardingPlan shape guard + sanitize 过滤测试（spec §6.1 / §6.2 / §7）。
import { describe, it, expect } from 'vitest';
import { isOnboardingPlan, sanitizePlan } from '../../src/main/onboarding/plan-types';

const CTX = { presetSlugs: ['coder', 'pm-agent'], mcpNames: ['filesystem', 'web-search'], skillSlugs: ['doc-writer'] };

const VALID_PLAN = {
  agents: [
    { kind: 'preset', slug: 'coder', reason: '写代码', mcps: ['filesystem'], skills: [] },
    { kind: 'custom', name: '测试员', iconEmoji: '🧪', systemPrompt: '你是测试员', toolPreset: 'standard', reason: '补位', mcps: ['web-search'], skills: ['doc-writer'] },
  ],
  defaultAgentIndex: 0,
};

describe('isOnboardingPlan', () => {
  it('合法方案通过', () => expect(isOnboardingPlan(VALID_PLAN)).toBe(true));
  it('agents 空数组拒绝', () => expect(isOnboardingPlan({ agents: [], defaultAgentIndex: 0 })).toBe(false));
  it('defaultAgentIndex 非数字拒绝', () =>
    expect(isOnboardingPlan({ ...VALID_PLAN, defaultAgentIndex: 'x' })).toBe(false));
  it('preset 项缺 slug 拒绝', () =>
    expect(isOnboardingPlan({ agents: [{ kind: 'preset', reason: 'r', mcps: [], skills: [] }], defaultAgentIndex: 0 })).toBe(false));
  it('custom 项 toolPreset 非法值拒绝', () =>
    expect(isOnboardingPlan({ agents: [{ ...VALID_PLAN.agents[1], toolPreset: 'custom' }], defaultAgentIndex: 0 })).toBe(false));
  it('非对象拒绝', () => expect(isOnboardingPlan('{"agents":[]}')).toBe(false));
});

describe('sanitizePlan', () => {
  it('白名单内的引用保留，白名单外剔除并出 warning', () => {
    const raw = {
      agents: [
        { kind: 'preset', slug: 'coder', reason: 'r', mcps: ['filesystem', 'not-registered'], skills: ['doc-writer', 'ghost-skill'] },
      ],
      defaultAgentIndex: 0,
    };
    const { plan, warnings } = sanitizePlan(raw, CTX);
    expect(plan?.agents[0]).toMatchObject({ mcps: ['filesystem'], skills: ['doc-writer'] });
    expect(warnings.some((w) => w.includes('not-registered'))).toBe(true);
    expect(warnings.some((w) => w.includes('ghost-skill'))).toBe(true);
  });

  it('slug 不在预制清单的项剔除；剔除后空 → plan=null', () => {
    const { plan, warnings } = sanitizePlan(
      { agents: [{ kind: 'preset', slug: 'ghost', reason: 'r', mcps: [], skills: [] }], defaultAgentIndex: 0 },
      CTX,
    );
    expect(plan).toBeNull();
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('defaultAgentIndex 越界钳制到 0 并出 warning', () => {
    const { plan, warnings } = sanitizePlan({ ...VALID_PLAN, defaultAgentIndex: 9 }, CTX);
    expect(plan?.defaultAgentIndex).toBe(0);
    expect(warnings.some((w) => w.includes('defaultAgentIndex'))).toBe(true);
  });

  it('agents 超过 5 截断到前 5 并出 warning', () => {
    const agents = Array.from({ length: 7 }, (_, i) => ({
      kind: 'preset', slug: 'coder', reason: `r${i}`, mcps: [], skills: [],
    }));
    const { plan, warnings } = sanitizePlan({ agents, defaultAgentIndex: 0 }, CTX);
    expect(plan?.agents.length).toBe(5);
    expect(warnings.some((w) => w.includes('5'))).toBe(true);
  });

  it('custom 项 name/systemPrompt 空白剔除并出 warning', () => {
    const { plan } = sanitizePlan(
      { agents: [{ ...VALID_PLAN.agents[1], name: '  ' }], defaultAgentIndex: 0 },
      CTX,
    );
    expect(plan).toBeNull();
  });

  it('整包非法（guard 不过）→ plan=null + warning', () => {
    const { plan, warnings } = sanitizePlan({ foo: 1 }, CTX);
    expect(plan).toBeNull();
    expect(warnings.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/onboarding/plan-types.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `electron/src/main/onboarding/plan-types.ts`**

```ts
// electron/src/main/onboarding/plan-types.ts
//
// OnboardingPlan 的 electron 侧类型 + shape guard + sanitize（spec §6）。
// 类型与 renderer/src/ipc/types.d.ts 同形独立定义（repo 跨进程惯例：仅结构对齐）。
// sanitize 是生成侧与应用侧共用的双保险过滤（spec §7）：引用只认白名单，
// 剔除一律出 warning 不静默。

export interface PlanPresetAgent {
  kind: 'preset';
  slug: string;
  reason: string;
  mcps: string[];
  skills: string[];
}

export interface PlanCustomAgent {
  kind: 'custom';
  name: string;
  iconEmoji: string;
  systemPrompt: string;
  toolPreset: 'standard' | 'all';
  reason: string;
  mcps: string[];
  skills: string[];
}

export type PlanAgent = PlanPresetAgent | PlanCustomAgent;

export interface OnboardingPlan {
  agents: PlanAgent[];
  defaultAgentIndex: number;
}

/** 方案 agent 数上限（spec §6.1 硬性规则） */
export const MAX_PLAN_AGENTS = 5;

/** sanitize 白名单上下文：预制 slug / 已注册 MCP 名 / 已安装 skill slug */
export interface PlanSanitizeContext {
  presetSlugs: string[];
  mcpNames: string[];
  skillSlugs: string[];
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((e) => typeof e === 'string');
}

function isPresetAgent(v: Record<string, unknown>): boolean {
  return (
    typeof v.slug === 'string' &&
    typeof v.reason === 'string' &&
    isStringArray(v.mcps) &&
    isStringArray(v.skills)
  );
}

function isCustomAgent(v: Record<string, unknown>): boolean {
  return (
    typeof v.name === 'string' &&
    typeof v.iconEmoji === 'string' &&
    typeof v.systemPrompt === 'string' &&
    (v.toolPreset === 'standard' || v.toolPreset === 'all') &&
    typeof v.reason === 'string' &&
    isStringArray(v.mcps) &&
    isStringArray(v.skills)
  );
}

/** OnboardingPlan shape guard（LLM 输出 / renderer 勾改回传共用） */
export function isOnboardingPlan(v: unknown): v is OnboardingPlan {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  if (!Array.isArray(o.agents) || o.agents.length === 0) return false;
  if (typeof o.defaultAgentIndex !== 'number') return false;
  return o.agents.every((a) => {
    if (typeof a !== 'object' || a === null) return false;
    const agent = a as Record<string, unknown>;
    if (agent.kind === 'preset') return isPresetAgent(agent);
    if (agent.kind === 'custom') return isCustomAgent(agent);
    return false;
  });
}

/**
 * 白名单过滤 + 上限截断 + 越界钳制（spec §6.1 生成侧 / §6.2 应用前共用）。
 * 返回 plan=null 表示无可应用项（调用方据此报错）。
 */
export function sanitizePlan(
  raw: unknown,
  ctx: PlanSanitizeContext,
): { plan: OnboardingPlan | null; warnings: string[] } {
  const warnings: string[] = [];
  if (!isOnboardingPlan(raw)) {
    return { plan: null, warnings: ['配置方案格式无效'] };
  }
  const mcpSet = new Set(ctx.mcpNames);
  const skillSet = new Set(ctx.skillSlugs);
  const slugSet = new Set(ctx.presetSlugs);

  const agents: PlanAgent[] = [];
  for (const a of raw.agents) {
    if (a.kind === 'preset' && !slugSet.has(a.slug)) {
      warnings.push(`预制 agent「${a.slug}」不在预置清单，已剔除`);
      continue;
    }
    if (a.kind === 'custom' && (a.name.trim() === '' || a.systemPrompt.trim() === '')) {
      warnings.push(`自定义 agent「${a.name || '(未命名)'}」名称或提示词为空，已剔除`);
      continue;
    }
    const mcps = a.mcps.filter((m) => {
      if (mcpSet.has(m)) return true;
      warnings.push(`MCP「${m}」未注册，已从「${a.name ?? a.slug}」剔除`);
      return false;
    });
    const skills = a.skills.filter((s) => {
      if (skillSet.has(s)) return true;
      warnings.push(`Skill「${s}」未安装，已从「${a.name ?? a.slug}」剔除`);
      return false;
    });
    agents.push({ ...a, mcps, skills });
    if (agents.length >= MAX_PLAN_AGENTS) break;
  }
  if (raw.agents.length > MAX_PLAN_AGENTS) {
    warnings.push(`方案 agent 数超过 ${MAX_PLAN_AGENTS}，已截断到前 ${MAX_PLAN_AGENTS} 个`);
  }
  if (agents.length === 0) {
    return { plan: null, warnings: [...warnings, '过滤后无可应用的 agent'] };
  }
  let defaultAgentIndex = raw.defaultAgentIndex;
  if (defaultAgentIndex < 0 || defaultAgentIndex >= agents.length) {
    warnings.push(`defaultAgentIndex=${defaultAgentIndex} 越界，已钳制到 0`);
    defaultAgentIndex = 0;
  }
  return { plan: { agents, defaultAgentIndex }, warnings };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/onboarding/plan-types.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add electron/src/main/onboarding/plan-types.ts electron/tests/onboarding/plan-types.test.ts
git commit -m "feat(onboarding): OnboardingPlan 守卫与白名单 sanitize 过滤"
```

---

### Task 3: plan-generator + generatePlan 通道

**Files:**
- Create: `electron/src/main/onboarding/plan-generator.ts`
- Create: `electron/tests/onboarding/plan-generator.test.ts`
- Modify: `electron/src/main/onboarding/ipc.handlers.ts`（补 generatePlan handler）

**Interfaces:**
- Consumes: `createLLMProvider(model, apiKey): LLMProvider`（`../agent/llm-provider`）；`getProvider(id)` / `getProviderApiKey(id)`（`../agent/provider-crud`）；`previewBuiltinPresetAgent(slug)` / `listBuiltinPresetAgents()`（`../agent/builtin`）；`listRegistered()`（`../mcp/host-manager`）；`listInstalled()`（`../skill/zip-uploader`——返回 `InstalledSkill[]`，含 slug/name 字段，打开该文件核对字段名后使用）；Task 2 的 `sanitizePlan`
- Produces: `generateOnboardingPlan(input): Promise<GenerateOnboardingPlanResult>`（IPC handler 直调）；`buildPlanPrompt` / `stripJsonFence` 导出供测试

- [ ] **Step 1: 写失败测试**

`electron/tests/onboarding/plan-generator.test.ts`（DB setup 照 `electron/tests/agent/preset.test.ts` 模板；LLM 经 deps 注入 mock，不用模块 mock——保真边界在 `LLMResponse` 形状）：

```ts
// plan-generator 测试：prompt 组装 / 围栏剥离 / 截断 / 静默修复一轮 / 失败上抛。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { setBuiltinAgentsDir } from '../../src/main/agent/builtin';
import {
  generateOnboardingPlan,
  buildPlanPrompt,
  stripJsonFence,
  type PlanDeps,
} from '../../src/main/onboarding/plan-generator';

const tmpRoot = path.join(os.tmpdir(), `onboarding-gen-${Date.now()}`);

/** LLMResponse 形状保真（momo-test-rules：mock 边界与真实一致） */
function llmReply(content: string): { content: string; toolCalls: unknown[]; finishReason: 'stop' | 'tool_use' } {
  return { content, toolCalls: [], finishReason: 'stop' };
}

const VALID_PLAN_JSON = JSON.stringify({
  agents: [
    { kind: 'preset', slug: 'requirement-analyst', reason: '梳理需求', mcps: [], skills: [] },
  ],
  defaultAgentIndex: 0,
});

function seedProvider(): void {
  getDb().prepare(
    `INSERT INTO model_providers (id, name, base_url, api_key_ref, default_model, is_default, created_at, platform, preset_key)
     VALUES ('prov-1', '测试供应商', 'https://api.test/v1', 'provider.prov-1.api_key', NULL, 1, datetime('now'), 'openai', NULL)`,
  ).run();
}

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  const agentDir = path.join(tmpRoot, 'agents');
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, 'requirement-analyst.yaml'), VALID_YAML, 'utf-8');
  setBuiltinAgentsDir(agentDir);
  seedProvider();
});

afterEach(() => {
  closeDb();
  setBuiltinAgentsDir(null);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

// VALID_YAML 与 electron/tests/agent/preset.test.ts 的 VALID_YAML 相同——
// 直接复制该常量到本文件（引导执行者可能乱序读任务，故不 import 跨测试文件）
const VALID_YAML = `
apiVersion: v1
kind: AgentDefinition
metadata:
  name: 需求讨论师
  slug: requirement-analyst
  version: 1.0.0
  description: 帮用户梳理需求
spec:
  type: standalone
  runtime: declarative
  declarative:
    systemPrompt: "你是需求分析师"
    model:
      provider: anthropic
      model: claude-3-5-sonnet
  defaultTools:
    - kind: builtin
      ref: read_file
`;

describe('stripJsonFence', () => {
  it('剥离 ```json 围栏', () => {
    expect(stripJsonFence('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });
  it('无围栏原样返回', () => {
    expect(stripJsonFence('{"a":1}')).toBe('{"a":1}');
  });
  it('前后杂文取首个 { 到末个 } 的片段', () => {
    expect(stripJsonFence('好的，这是方案：{"a":1} 以上')).toBe('{"a":1}');
  });
});

describe('buildPlanPrompt', () => {
  it('系统指令含 schema 描述与硬性规则，上下文含预制/MCP/skill 白名单，用户消息含需求', () => {
    const { system, user } = buildPlanPrompt({
      requirement: '我要写周报',
      presets: [
        { slug: 'requirement-analyst', name: '需求讨论师', description: '梳理需求', systemPrompt: '', tools: [], mcps: [], skills: [], iconEmoji: '📋' },
      ],
      mcpNames: ['filesystem'],
      skills: [{ slug: 'doc-writer', name: '文档写手', description: '写文档' }],
    });
    expect(system).toContain('JSON');
    expect(system).toContain('preset');
    expect(system).toContain('filesystem');
    expect(user).toContain('我要写周报');
  });
});

describe('generateOnboardingPlan', () => {
  const baseInput = { requirement: '帮我做需求分析', providerId: 'prov-1', modelId: 'glm-test' };

  it('合法 JSON 直接产出方案', async () => {
    const deps: PlanDeps = { callLlm: async () => llmReply(VALID_PLAN_JSON) };
    const { plan } = await generateOnboardingPlan(baseInput, deps);
    expect(plan.agents[0]).toMatchObject({ kind: 'preset', slug: 'requirement-analyst' });
  });

  it('围栏包裹的 JSON 可解析（Review Focus 1）', async () => {
    const deps: PlanDeps = { callLlm: async () => llmReply('```json\n' + VALID_PLAN_JSON + '\n```') };
    const { plan } = await generateOnboardingPlan(baseInput, deps);
    expect(plan.agents.length).toBe(1);
  });

  it('第一轮解析失败 → 静默修复一轮成功', async () => {
    let calls = 0;
    const deps: PlanDeps = {
      callLlm: async () => {
        calls += 1;
        return calls === 1 ? llmReply('我觉得你应该自己配') : llmReply(VALID_PLAN_JSON);
      },
    };
    const { plan } = await generateOnboardingPlan(baseInput, deps);
    expect(calls).toBe(2);
    expect(plan.agents.length).toBe(1);
  });

  it('两轮失败 → 中文错误上抛', async () => {
    const deps: PlanDeps = { callLlm: async () => llmReply('仍然不是 JSON') };
    await expect(generateOnboardingPlan(baseInput, deps)).rejects.toThrow('格式无效');
  });

  it('供应商不存在 → 中文错误（Review Focus 3）', async () => {
    const deps: PlanDeps = { callLlm: async () => llmReply(VALID_PLAN_JSON) };
    await expect(
      generateOnboardingPlan({ ...baseInput, providerId: 'ghost' }, deps),
    ).rejects.toThrow('供应商不存在');
  });

  it('需求超 4000 字符截断（Review Focus 6）', async () => {
    let seen = '';
    const deps: PlanDeps = {
      callLlm: async (messages) => {
        seen = messages.map((m) => m.content).join('\n');
        return llmReply(VALID_PLAN_JSON);
      },
    };
    await generateOnboardingPlan({ ...baseInput, requirement: '长'.repeat(5000) }, deps);
    expect(seen.includes('长'.repeat(4000))).toBe(true);
    expect(seen.includes('长'.repeat(4001))).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/onboarding/plan-generator.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 `electron/src/main/onboarding/plan-generator.ts`**

```ts
// electron/src/main/onboarding/plan-generator.ts
//
// AI 路线方案生成（spec §6.1）：单次非流式 chat 直调 LLM（session-naming 同款
// createLLMProvider 先例），60s 独立超时（不复用 300s 全局值），解析失败静默
// 修复一轮。LLM 依赖经 PlanDeps 注入（测试保真边界在 LLMResponse 形状）。
import type { LLMMessage, LLMResponse } from '../agent/llm-provider';
import { createLLMProvider } from '../agent/llm-provider';
import { getProvider, getProviderApiKey } from '../agent/provider-crud';
import { listBuiltinPresetAgents, previewBuiltinPresetAgent } from '../agent/builtin';
import { listRegistered } from '../mcp/host-manager';
import { listInstalled } from '../skill/zip-uploader';
import { sanitizePlan, type OnboardingPlan } from './plan-types';

/** 引导 LLM 调用独立超时（spec §6.1：引导场景等不了 300s 全局值） */
export const ONBOARDING_LLM_TIMEOUT_MS = 60_000;

/** 需求文本上限（spec §5 GenerateOnboardingPlanInput 注释） */
export const MAX_REQUIREMENT_CHARS = 4000;

/** LLM 调用注入点：生产 = createLLMProvider 包装；测试 = 直接给实现 */
export interface PlanDeps {
  callLlm: (messages: LLMMessage[]) => Promise<LLMResponse>;
}

/** prompt 上下文：预制 agent 预览 + MCP/skill 白名单 */
export interface PlanPromptContext {
  requirement: string;
  presets: Array<{
    slug: string;
    name: string;
    description: string;
    systemPrompt: string;
    tools: string[];
    mcps: string[];
    skills: string[];
    iconEmoji: string;
  }>;
  mcpNames: string[];
  skills: Array<{ slug: string; name: string; description: string }>;
}

/** 剥离 markdown 代码围栏与前后杂文（LLM 常见输出形态容错） */
export function stripJsonFence(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1]! : text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return body.trim();
  return body.slice(start, end + 1);
}

/** 组装 prompt（纯函数，供测试直接断言） */
export function buildPlanPrompt(ctx: PlanPromptContext): { system: string; user: string } {
  const system = [
    '你是 Momo Studio（桌面端多 agent 协作平台）的新装配置助手。',
    '根据用户的工作需求，从「预置 agent 清单」中选择启用的 agent；仅当预置无法满足时才设计自定义 agent。',
    'MCP 与 skill 只能从「可挂载资源白名单」中选择，禁止编造名单外的名字。',
    '输出严格为一个 JSON 对象，不要输出任何其他文字。schema：',
    '{',
    '  "agents": [ 1~5 个元素，二选一：',
    '    {"kind":"preset","slug":"<预置清单中的 slug>","reason":"中文一句话理由","mcps":["<白名单 MCP 名>"],"skills":["<白名单 skill slug>"]}',
    '    {"kind":"custom","name":"<名称>","iconEmoji":"<一个 emoji>","systemPrompt":"<完整中文系统提示词>","toolPreset":"standard"|"all","reason":"中文一句话理由","mcps":[],"skills":[]}',
    '  ],',
    '  "defaultAgentIndex": <默认会话 agent 在 agents 数组的下标>',
    '}',
    '',
    '预置 agent 清单：',
    ...ctx.presets.map(
      (p) =>
        `- slug=${p.slug} 名称=${p.name} 描述=${p.description} 已有工具=${p.tools.join(',')} 已有MCP=${p.mcps.join(',')} 已有skill=${p.skills.join(',')}`,
    ),
    '',
    '可挂载 MCP 白名单：' + (ctx.mcpNames.join(', ') || '（空，mcps 一律给 []）'),
    '可挂载 skill 白名单：' +
      (ctx.skills.map((s) => `${s.slug}(${s.name}:${s.description})`).join(', ') || '（空，skills 一律给 []）'),
  ].join('\n');
  const user = `我的工作需求：${ctx.requirement}`;
  return { system, user };
}

/** 从代码库现取 sanitize 白名单上下文（spec §7：白名单来自注册表/安装表） */
function buildSanitizeContext() {
  return {
    presetSlugs: listBuiltinPresetAgents().map((p) => p.slug),
    mcpNames: listRegistered().map((m) => m.name),
    skillSlugs: listInstalled().map((s) => s.slug),
  };
}

function parsePlanResponse(content: string): OnboardingPlan {
  const plan: unknown = JSON.parse(stripJsonFence(content));
  if (typeof plan !== 'object' || plan === null) {
    throw new Error('方案不是 JSON 对象');
  }
  return plan as OnboardingPlan; // isOnboardingPlan 在 sanitizePlan 内复验
}

/**
 * 生成配置方案（onboarding:generatePlan 数据面）。
 * 流程：需求截断 → provider/key 校验 → 单次 chat（60s race 超时）
 * → 解析失败静默修复一轮 → sanitize 白名单过滤。
 */
export async function generateOnboardingPlan(
  input: { requirement: string; providerId: string; modelId: string },
  deps?: PlanDeps,
): Promise<{ plan: OnboardingPlan; warnings: string[] }> {
  const requirement = input.requirement.trim().slice(0, MAX_REQUIREMENT_CHARS);
  if (!requirement) throw new Error('需求描述不能为空');

  const provider = getProvider(input.providerId);
  if (!provider) throw new Error(`供应商不存在: ${input.providerId}`);
  const apiKey = await getProviderApiKey(input.providerId);
  if (!apiKey) throw new Error('供应商 API key 未配置，请回到上一步检查');

  const callLlm =
    deps?.callLlm ??
    (async (messages: LLMMessage[]): Promise<LLMResponse> => {
      const llm = createLLMProvider(
        { provider: provider.platform, model: input.modelId, baseUrl: provider.baseUrl },
        apiKey,
      );
      // 60s 外层 race：底层请求由模块级 300s 兜底终止，结果被丢弃即可
      return Promise.race([
        llm.chat(messages),
        new Promise<LLMResponse>((_, reject) =>
          setTimeout(
            () => reject(new Error('AI 生成超时（60s），建议换更快的模型（如 flash 档）后重试')),
            ONBOARDING_LLM_TIMEOUT_MS,
          ),
        ),
      ]);
    });

  const ctx: PlanPromptContext = {
    requirement,
    presets: listBuiltinPresetAgents().map((p) => {
      const pv = previewBuiltinPresetAgent(p.slug);
      return {
        slug: pv.slug, name: pv.name, description: p.description, systemPrompt: pv.systemPrompt,
        tools: pv.tools, mcps: pv.mcps, skills: pv.skills, iconEmoji: pv.iconEmoji,
      };
    }),
    mcpNames: listRegistered().map((m) => m.name),
    skills: listInstalled().map((s) => ({ slug: s.slug, name: s.name, description: s.description })),
  };
  const { system, user } = buildPlanPrompt(ctx);

  // 第一轮
  let response = await callLlm([
    { role: 'system', content: system },
    { role: 'user', content: user },
  ]);
  let parsed: OnboardingPlan;
  try {
    parsed = parsePlanResponse(response.content);
  } catch {
    // 静默修复一轮：原响应 + 纠错指令重发
    response = await callLlm([
      { role: 'system', content: system },
      { role: 'user', content: user },
      { role: 'assistant', content: response.content },
      { role: 'user', content: '你上一条回复不是合法 JSON。请只输出符合 schema 的 JSON 对象，不要有任何其他文字。' },
    ]);
    try {
      parsed = parsePlanResponse(response.content);
    } catch {
      throw new Error('AI 生成的方案格式无效，请重试或转手动配置');
    }
  }

  const { plan, warnings } = sanitizePlan(parsed, buildSanitizeContext());
  if (!plan) throw new Error(`方案过滤后无可应用项：${warnings.join('；')}`);
  return { plan, warnings };
}
```

**实现前核对**（实现时打开文件确认，若签名有出入以真实签名为准并保持调用语义）：
- `listRegistered()` 在 `electron/src/main/mcp/host-manager.ts` 导出（`resource/mcp-config.ts` 在消费）
- `listInstalled()` 在 `electron/src/main/skill/zip-uploader.ts` 导出，返回条目含 `slug` / `name` / `description` 字段
- `previewBuiltinPresetAgent` 返回 `BuiltinPresetPreview`（slug/name/iconEmoji/description/systemPrompt/tools/mcps/skills）

- [ ] **Step 4: 跑测试确认通过**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/onboarding/plan-generator.test.ts`
Expected: PASS

- [ ] **Step 5: 注册 generatePlan IPC handler**

`electron/src/main/onboarding/ipc.handlers.ts` 补：

```ts
  ipcMain.handle(
    'onboarding:generatePlan',
    (_e, input: { requirement: string; providerId: string; modelId: string }) =>
      generateOnboardingPlan(input),
  );
```

（import 补 `generateOnboardingPlan`。）

- [ ] **Step 6: typecheck + Commit**

Run: `npx pnpm@9.0.0 typecheck`（两 workspace 0 error）

```bash
git add electron/src/main/onboarding/ electron/tests/onboarding/
git commit -m "feat(onboarding): LLM 方案生成器（60s 超时 + 静默修复 + 白名单过滤）与 generatePlan 通道"
```

---

### Task 4: plan-applier + applyPlan 通道

**Files:**
- Create: `electron/src/main/onboarding/plan-applier.ts`
- Create: `electron/tests/onboarding/plan-applier.test.ts`
- Modify: `electron/src/main/onboarding/ipc.handlers.ts`（补 applyPlan handler）

**Interfaces:**
- Consumes: `enablePresetDef`（`../agent/preset`——幂等启用：存在走 UPDATE 不触发 CASCADE）；`getAgentDefinition` / `updateAgentDefinition` / `addMember` / `generateAgentUserId` / `listMembers`（`../agent/crud`，签名以文件为准——`updateAgentDefinition` 入参形状见 `preset.ts:94-106` 调用范例）；`createCustomDef`（`../agent/crud`，入参形状 = `ipc.agent.createCustom` 的 input，见 `renderer/src/components/agent/CreateAgentDialog.tsx:121-138` 范例）；`SAFE_MINIMUM_TOOLS` / `ALL_BUILTIN_TOOLS`（`../agent/tools/catalog`）；`getWorkspace` / `setDefaultAgent`（`../workspace/crud`）；`getProvider`（`../agent/provider-crud`）；`listRegistered()` / `listInstalled()`；Task 2 `sanitizePlan`
- Produces: `applyOnboardingPlan(input: ApplyOnboardingPlanInput): Promise<OnboardingApplyResult>`（返回形状与 renderer `OnboardingApplyResult` 同形）

- [ ] **Step 1: 写失败测试**

`electron/tests/onboarding/plan-applier.test.ts`（setup 照 Task 3 模板：tmpdir + runMigrations + setBuiltinAgentsDir(VALID_YAML) + seedProvider + `createWorkspace`（`../../src/main/workspace/crud`）。VALID_YAML、seedProvider 复制自 Task 3 测试文件，不跨测试文件 import）：

```ts
// plan-applier 测试：preset 启用+能力同步 / custom 创建 / 幂等重试 / 越界钳制 / 中断语义。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
// … beforeEach/afterEach 与 seedProvider/VALID_YAML 同 Task 3 模板（含 createWorkspace）…
import { applyOnboardingPlan } from '../../src/main/onboarding/plan-applier';
import { getAgentDefinition, listMembers } from '../../src/main/agent/crud';
import { getWorkspace } from '../../src/main/workspace/crud';

// beforeEach 内补：const ws = createWorkspace({ name: '引导测试', directoryPath: path.join(tmpRoot, 'ws') });
// 记为 wsId（用例通过 getWorkspace 查询或保存 beforeEach 返回值，按 createWorkspace 实际签名调用）

const PRESET_AGENT = { kind: 'preset' as const, slug: 'requirement-analyst', reason: 'r', mcps: [], skills: [] };
const CUSTOM_AGENT = {
  kind: 'custom' as const, name: '测试工程师', iconEmoji: '🧪',
  systemPrompt: '你是测试工程师', toolPreset: 'standard' as const, reason: 'r', mcps: [], skills: [],
};

describe('applyOnboardingPlan', () => {
  it('preset 项：启用 def + 加入成员 + 设默认', async () => {
    const result = await applyOnboardingPlan({
      plan: { agents: [PRESET_AGENT], defaultAgentIndex: 0 },
      workspaceId: wsId, providerId: 'prov-1', modelId: 'glm-test',
    });
    expect(result.applied.length).toBe(1);
    expect(result.defaultAgentName).toBe('需求讨论师');
    expect(getAgentDefinition('builtin-requirement-analyst')).toBeTruthy();
    expect(listMembers(wsId).length).toBe(1);
    expect(getWorkspace(wsId)?.defaultAgentInstanceId).toBeTruthy();
  });

  it('custom 项：createCustomDef + 工具档映射 standard → SAFE_MINIMUM_TOOLS', async () => {
    const result = await applyOnboardingPlan({
      plan: { agents: [CUSTOM_AGENT], defaultAgentIndex: 0 },
      workspaceId: wsId, providerId: 'prov-1', modelId: 'glm-test',
    });
    expect(result.applied[0]!.kind).toBe('custom');
    const def = getAgentDefinition(result.applied[0]!.instanceId.replace(/^inst-/, '')) ?? null;
    // 断言以成员行反查 def 的 defaultTools 等于 SAFE_MINIMUM_TOOLS（实现内 def.id 断言见下）
  });

  it('幂等：整包重复应用无重复 def / 成员（Review Focus 2）', async () => {
    const input = {
      plan: { agents: [PRESET_AGENT, CUSTOM_AGENT], defaultAgentIndex: 1 },
      workspaceId: wsId, providerId: 'prov-1', modelId: 'glm-test',
    };
    await applyOnboardingPlan(input);
    await applyOnboardingPlan(input); // 整包重试
    expect(listMembers(wsId).length).toBe(2);
    // custom 按 name 查重复用：agent_definitions 中同名 custom def 仅 1 行
  });

  it('未注册引用在应用侧再过滤（双保险）+ warning', async () => {
    const result = await applyOnboardingPlan({
      plan: { agents: [{ ...PRESET_AGENT, mcps: ['ghost-mcp'] }], defaultAgentIndex: 0 },
      workspaceId: wsId, providerId: 'prov-1', modelId: 'glm-test',
    });
    expect(result.warnings.some((w) => w.includes('ghost-mcp'))).toBe(true);
    expect(getAgentDefinition('builtin-requirement-analyst')!.defaultMcps).toEqual([]);
  });

  it('defaultAgentIndex 越界钳制到 0', async () => {
    const result = await applyOnboardingPlan({
      plan: { agents: [PRESET_AGENT], defaultAgentIndex: 5 },
      workspaceId: wsId, providerId: 'prov-1', modelId: 'glm-test',
    });
    expect(result.defaultAgentName).toBe('需求讨论师');
    expect(result.warnings.some((w) => w.includes('defaultAgentIndex'))).toBe(true);
  });

  it('workspace 不存在 → 中文错误，零副作用', async () => {
    await expect(
      applyOnboardingPlan({
        plan: { agents: [PRESET_AGENT], defaultAgentIndex: 0 },
        workspaceId: 'ghost-ws', providerId: 'prov-1', modelId: 'glm-test',
      }),
    ).rejects.toThrow('未找到 workspace');
  });

  it('agents 过滤后为空 → 拒绝应用', async () => {
    await expect(
      applyOnboardingPlan({
        plan: { agents: [{ kind: 'preset', slug: 'ghost-slug', reason: 'r', mcps: [], skills: [] }], defaultAgentIndex: 0 },
        workspaceId: wsId, providerId: 'prov-1', modelId: 'glm-test',
      }),
    ).rejects.toThrow('无可应用');
  });
});
```

（用例 2 的实现内断言按 `applied[0].instanceId` → `listMembers` 反查 `agentDefinitionId` → `getAgentDefinition` 的链路取 def，断言 `defaultTools.map(t => t.ref)` 等于 `SAFE_MINIMUM_TOOLS`；测试 import `SAFE_MINIMUM_TOOLS` from `../../src/main/agent/tools/catalog`。）

- [ ] **Step 2: 跑测试确认失败**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/onboarding/plan-applier.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 `electron/src/main/onboarding/plan-applier.ts`**

```ts
// electron/src/main/onboarding/plan-applier.ts
//
// 方案应用（spec §6.3）：重校验（renderer 勾改过的 plan 不可盲信）→ 顺序应用 →
// 幂等（preset 启用链幂等 + custom 按 name 查重复用 + 成员先查后加）。
// 任一步失败中断上抛，已应用项保留（真实可用配置非垃圾），整包重试安全。
import { randomUUID } from 'node:crypto';
import { getWorkspace, setDefaultAgent } from '../workspace/crud';
import { getProvider } from './provider-crud';
import {
  getAgentDefinition,
  updateAgentDefinition,
  addMember,
  generateAgentUserId,
  listMembers,
  listAgentDefinitions,
} from './crud';
// 注意：applier 位于 onboarding/ 目录，import 路径为 '../agent/crud' 等——按实际相对路径书写
import { enablePresetDef } from '../agent/preset';
import { listBuiltinPresetAgents } from '../agent/builtin';
import { listRegistered } from '../mcp/host-manager';
import { listInstalled } from '../skill/zip-uploader';
import { SAFE_MINIMUM_TOOLS, ALL_BUILTIN_TOOLS } from '../agent/tools/catalog';
import { sanitizePlan, type OnboardingPlan } from './plan-types';
import type { ToolRef, McpRef, SkillRef, AgentDefinition } from '../agent/types';

/** 应用结果（与 renderer OnboardingApplyResult 同形） */
export interface OnboardingApplyResult {
  applied: Array<{ name: string; kind: 'preset' | 'custom'; instanceId: string }>;
  warnings: string[];
  defaultAgentName: string;
}

function toMcpRefs(names: string[]): McpRef[] {
  return names.map((ref) => ({ kind: 'mcp' as const, ref }));
}
function toSkillRefs(slugs: string[]): SkillRef[] {
  return slugs.map((ref) => ({ kind: 'skill' as const, ref }));
}

/** 幂等加入成员：已有同 def 成员则复用（spec §6.3 步骤 1 的幂等关键点） */
async function joinWorkspace(
  workspaceId: string,
  def: AgentDefinition,
): Promise<{ instanceId: string; name: string }> {
  const existing = listMembers(workspaceId).find((m) => m.agentDefinitionId === def.id);
  if (existing) return { instanceId: existing.instanceId, name: existing.agentName };
  const member = await addMember(workspaceId, def.id, generateAgentUserId(def.slug));
  return { instanceId: member.instanceId, name: def.name };
}

/**
 * 应用配置方案（onboarding:applyPlan 数据面）。
 * custom agent 模型统一用入参 provider/model（spec §6.1：不暴露模型选择面）。
 */
export async function applyOnboardingPlan(input: {
  plan: OnboardingPlan;
  workspaceId: string;
  providerId: string;
  modelId: string;
}): Promise<OnboardingApplyResult> {
  const workspace = getWorkspace(input.workspaceId);
  if (!workspace) throw new Error(`未找到 workspace: ${input.workspaceId}`);
  if (!getProvider(input.providerId)) throw new Error(`供应商不存在: ${input.providerId}`);

  // 应用侧重校验 + 双保险过滤（spec §6.2 / §7）
  const { plan, warnings } = sanitizePlan(input.plan, {
    presetSlugs: listBuiltinPresetAgents().map((p) => p.slug),
    mcpNames: listRegistered().map((m) => m.name),
    skillSlugs: listInstalled().map((s) => s.slug),
  });
  if (!plan) throw new Error(`方案无可应用的 agent：${warnings.join('；')}`);

  const applied: OnboardingApplyResult['applied'] = [];
  const members: Array<{ instanceId: string; name: string }> = [];

  for (const agent of plan.agents) {
    if (agent.kind === 'preset') {
      // 启用（幂等：已存在走 UPDATE，不触发成员 CASCADE）
      let def = enablePresetDef({
        slug: agent.slug,
        modelProviderId: input.providerId,
        modelName: input.modelId,
      });
      // MCP/skill 同步：YAML 声明 ∪ 方案追加（sanitize 已过滤到注册集）
      const yamlMcps = new Set(def.defaultMcps.map((m) => m.ref));
      const yamlSkills = new Set(def.defaultSkills.map((s) => s.ref));
      const finalMcps = [...def.defaultMcps, ...toMcpRefs(agent.mcps.filter((m) => !yamlMcps.has(m)))];
      const finalSkills = [...def.defaultSkills, ...toSkillRefs(agent.skills.filter((s) => !yamlSkills.has(s)))];
      if (finalMcps.length !== def.defaultMcps.length || finalSkills.length !== def.defaultSkills.length) {
        def = updateAgentDefinition({
          id: def.id,
          name: def.name,
          description: def.description,
          systemPrompt: def.systemPrompt,
          iconEmoji: def.iconEmoji,
          modelProviderId: def.modelProviderId,
          modelName: def.modelName,
          defaultTools: def.defaultTools,
          defaultMcps: finalMcps,
          defaultSkills: finalSkills,
          thinkingJson: def.thinkingJson ?? null,
        });
      }
      const member = await joinWorkspace(input.workspaceId, def);
      members.push(member);
      applied.push({ name: member.name, kind: 'preset', instanceId: member.instanceId });
    } else {
      // custom：按 name 查重复用（整包重试幂等，spec Review Focus 2）
      const slug = `onboarding-${randomUUID().slice(0, 8)}`;
      const existing = listAgentDefinitions().find(
        (d) => d.source === 'custom' && d.name === agent.name,
      );
      let defId: string;
      let name: string;
      if (existing) {
        defId = existing.id;
        name = existing.name;
      } else {
        // createCustomDef 签名以 crud.ts 实际导出为准（对照 CreateAgentDialog
        // ipc.agent.createCustom 入参形状）；工具档映射 spec §6.3 步骤 2
        const tools: ToolRef[] = (agent.toolPreset === 'all' ? ALL_BUILTIN_TOOLS : SAFE_MINIMUM_TOOLS)
          .map((ref) => ({ kind: 'builtin' as const, ref }));
        const created = createCustomDefSafe({
          name: agent.name.trim(),
          slug,
          description: `引导创建: ${agent.name.trim()}`,
          systemPrompt: agent.systemPrompt.trim(),
          iconEmoji: agent.iconEmoji || '🤖',
          scope: 'global',
          modelProviderId: input.providerId,
          modelName: input.modelId,
          thinkingJson: null,
          defaultTools: tools,
          defaultMcps: toMcpRefs(agent.mcps),
          defaultSkills: toSkillRefs(agent.skills),
        });
        defId = created.id;
        name = created.name;
      }
      const def = getAgentDefinition(defId)!;
      const member = await joinWorkspace(input.workspaceId, def);
      members.push(member);
      applied.push({ name, kind: 'custom', instanceId: member.instanceId });
    }
  }

  const defaultIdx = Math.min(Math.max(plan.defaultAgentIndex, 0), members.length - 1);
  setDefaultAgent(input.workspaceId, members[defaultIdx]!.instanceId);

  return { applied, warnings, defaultAgentName: members[defaultIdx]!.name };
}
```

**实现时落点**：
- `createCustomDefSafe` 不是现成函数——直接 import crud.ts 的 `createCustomDef`（打开文件核对参数名；若参数是位置参数则按位置传，若是对象则按上形状传）。测试与实现中的调用保持一致，删掉本注释中 `-Safe` 命名。
- `updateAgentDefinition` 若有 `thinkingJson` 可选性差异，以 preset.ts:94-106 调用为准。
- `addMember(workspaceId, defId, agentUserId)` 的第三参语义见 preset.ts:135（`generateAgentUserId(def.slug)`）。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/onboarding/plan-applier.test.ts`
Expected: PASS（7 用例）

- [ ] **Step 5: 注册 applyPlan IPC handler + 全量主进程回归**

`ipc.handlers.ts` 补：

```ts
  ipcMain.handle('onboarding:applyPlan', (_e, input: Parameters<typeof applyOnboardingPlan>[0]) =>
    applyOnboardingPlan(input),
  );
```

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/onboarding/ && npx pnpm@9.0.0 vitest run tests/agent/preset.test.ts`
Expected: 全 PASS（preset 启用链既有回归不破）

- [ ] **Step 6: typecheck + Commit**

Run: `npx pnpm@9.0.0 typecheck`

```bash
git add electron/src/main/onboarding/ electron/tests/onboarding/
git commit -m "feat(onboarding): 方案应用器（幂等启用/查重复用/成员先查后加）与 applyPlan 通道"
```

---

### Task 5: UI 静态预览门禁（P1，人工确认点）

**Files:**
- Create: `.omo/preview/onboarding-wizard-preview.html`（临时预览产物，不入产品代码）

**Interfaces:**
- Consumes: spec §8 组件结构 + `docs/dev/design-system.md` token 规范
- Produces: 需求方确认的向导视觉基线（后续 UI 任务据此实现；确认记录在 commit message / 会话）

- [ ] **Step 1: 制作静态预览页**

单 HTML 文件内联 Tailwind CDN 或手写 CSS 变量（对齐 `docs/dev/design-system.md` 的语义 token 值），静态呈现向导关键帧：① 欢迎页（路线二选一大卡）② 供应商表单步 ③ 工作空间步 ④ AI 需求描述步 ⑤ 方案预览卡（agent 卡片 + 默认单选 + 警告区）⑥ 手动 agent 配置步 ⑦ 完成页。lucide 图标用同形 SVG 占位。

- [ ] **Step 2: 交给需求方确认**

打开预览（macOS 主机 `open .omo/preview/onboarding-wizard-preview.html`），需求方确认视觉与布局基线。**未确认不开始 Task 6+ 的 renderer 实现**（momo-ui-preview-rules P1 门禁）。确认后的修改意见回写到预览文件再确认一轮。

- [ ] **Step 3: Commit 预览产物**

```bash
git add .omo/preview/onboarding-wizard-preview.html
git commit -m "docs(onboarding): 向导 UI 静态预览基线（P1 门禁确认稿）"
```

---

### Task 6: 向导骨架 + WelcomeStep + App.tsx 接线

**Files:**
- Create: `renderer/src/routes/OnboardingWizard.tsx`
- Create: `renderer/src/components/onboarding/WelcomeStep.tsx`
- Create: `renderer/src/routes/OnboardingWizard.test.tsx`
- Modify: `renderer/src/App.tsx`（空态分支改造，:88-102 一带）

**Interfaces:**
- Consumes: `ipc.onboarding.getStatus / markDone`（Task 1）；`useWorkspaceStore`
- Produces: `<OnboardingWizard onFinished: () => void>`——步骤机 `step` 状态与 `route: 'ai' | 'manual' | null`；后续任务在占位分支填入各 Step 组件。`OnboardingStepProps` 形状：`{ route, setRoute, go(next), skip() }` 由骨架定义并导出

- [ ] **Step 1: 写失败测试**

`renderer/src/routes/OnboardingWizard.test.tsx`：

```tsx
// 向导骨架测试：boot 拉状态 / 欢迎页路线选择 / 跳过写 kv / getStatus 失败容错（Review Focus 5）。
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { OnboardingWizard } from './OnboardingWizard';
import { ipc } from '../ipc/client';

vi.mock('../ipc/client', () => ({
  ipc: {
    onboarding: {
      getStatus: vi.fn(),
      markDone: vi.fn().mockResolvedValue(undefined),
      generatePlan: vi.fn(),
      applyPlan: vi.fn(),
    },
  },
}));

const mocked = vi.mocked(ipc.onboarding);

beforeEach(() => {
  vi.clearAllMocks();
  mocked.getStatus.mockResolvedValue({ status: 'pending' });
});

describe('OnboardingWizard', () => {
  it('欢迎页呈现两条路线与跳过按钮', async () => {
    render(<OnboardingWizard onFinished={() => {}} />);
    expect(await screen.findByRole('button', { name: /AI 引导/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /手动引导/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /跳过引导/ })).toBeInTheDocument();
  });

  it('点「跳过引导」→ markDone({skipped:true}) + onFinished', async () => {
    const onFinished = vi.fn();
    render(<OnboardingWizard onFinished={onFinished} />);
    fireEvent.click(await screen.findByRole('button', { name: /跳过引导/ }));
    await waitFor(() => expect(mocked.markDone).toHaveBeenCalledWith({ skipped: true }));
    expect(onFinished).toHaveBeenCalled();
  });

  it('选择 AI 路线进入供应商步骤（第②步标题可见）', async () => {
    render(<OnboardingWizard onFinished={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: /AI 引导/ }));
    expect(await screen.findByText(/配置模型服务/)).toBeInTheDocument();
  });

  it('getStatus 失败 → 视为 pending 照常走向导，不崩溃（Review Focus 5）', async () => {
    mocked.getStatus.mockRejectedValue(new Error('ipc down'));
    render(<OnboardingWizard onFinished={() => {}} />);
    expect(await screen.findByRole('button', { name: /AI 引导/ })).toBeInTheDocument();
  });
});
```

（App.tsx 的分支接线由 e2e 与手动验收覆盖；单测聚焦向导组件本身。）

- [ ] **Step 2: 跑测试确认失败**

Run: `cd renderer && npx pnpm@9.0.0 vitest run src/routes/OnboardingWizard.test.tsx`
Expected: FAIL

- [ ] **Step 3: 实现 `OnboardingWizard.tsx` + `WelcomeStep.tsx`**

`renderer/src/routes/OnboardingWizard.tsx`：

```tsx
// renderer/src/routes/OnboardingWizard.tsx
//
// 新装引导向导（spec §3 / §8）：取代 App.tsx 首启空态分支。
// 步骤状态本地持有（真实配置是唯一状态源——spec §3.2 幂等预填原则）；
// 各步骤组件分任务接线：本文件先立骨架与欢迎页。
import { useEffect, useState } from 'react';
import { TitleBar } from '../components/layout/TitleBar';
import { WelcomeStep } from '../components/onboarding/WelcomeStep';
import { ProviderStep } from '../components/onboarding/ProviderStep';
import { WorkspaceStep } from '../components/onboarding/WorkspaceStep';
import { RequirementStep } from '../components/onboarding/RequirementStep';
import { PlanPreviewStep } from '../components/onboarding/PlanPreviewStep';
import { ManualAgentStep } from '../components/onboarding/ManualAgentStep';
import { DoneStep } from '../components/onboarding/DoneStep';
import { ipc } from '../ipc/client';

export type WizardRoute = 'ai' | 'manual';
export type WizardStep =
  | 'welcome'
  | 'provider'
  | 'workspace'
  | 'requirement'   // AI 路线
  | 'preview'       // AI 路线
  | 'manualAgents'  // 手动路线
  | 'done';

/** 步骤组件共享上下文（骨架定义，各 Step 消费） */
export interface WizardCtx {
  route: WizardRoute;
  providerId: string;
  modelId: string;
  workspaceId: string;
  setProvider: (providerId: string, modelId: string) => void;
  setWorkspace: (workspaceId: string) => void;
  go: (next: WizardStep) => void;
  /** 转手动：保留 provider/workspace 成果直达手动配置步（spec §8） */
  toManual: () => void;
  finish: () => void;
}

export function OnboardingWizard({ onFinished }: { onFinished: () => void }) {
  const [step, setStep] = useState<WizardStep>('welcome');
  const [route, setRoute] = useState<WizardRoute | null>(null);
  const [providerId, setProviderId] = useState('');
  const [modelId, setModelId] = useState('');
  const [workspaceId, setWorkspaceId] = useState('');

  useEffect(() => {
    // 触发条件已在 App.tsx 判定（workspaces 空 + status pending）；
    // 此处容错拉一次状态仅作防御日志，失败按 pending 处理不阻塞（Review Focus 5）
    void ipc.onboarding.getStatus().catch(() => undefined);
  }, []);

  const ctx: WizardCtx = {
    route: route ?? 'manual',
    providerId,
    modelId,
    workspaceId,
    setProvider: (p, m) => {
      setProviderId(p);
      setModelId(m);
    },
    setWorkspace: setWorkspaceId,
    go: setStep,
    toManual: () => {
      setRoute('manual');
      setStep('manualAgents');
    },
    finish: onFinished,
  };

  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden bg-canvas">
      <TitleBar />
      <div className="flex-1 min-h-0 flex items-center justify-center p-6">
        {step === 'welcome' && (
          <WelcomeStep
            onSelect={(r) => {
              setRoute(r);
              setStep('provider');
            }}
            onSkip={async () => {
              await ipc.onboarding.markDone({ skipped: true });
              onFinished();
            }}
          />
        )}
        {step === 'provider' && <ProviderStep ctx={ctx} />}
        {step === 'workspace' && <WorkspaceStep ctx={ctx} />}
        {step === 'requirement' && <RequirementStep ctx={ctx} />}
        {step === 'preview' && <PlanPreviewStep ctx={ctx} />}
        {step === 'manualAgents' && <ManualAgentStep ctx={ctx} />}
        {step === 'done' && <DoneStep ctx={ctx} />}
      </div>
    </div>
  );
}
```

`WelcomeStep.tsx`（视觉基线按 Task 5 确认稿）：两张大卡（AI 引导 / 手动引导，lucide `Sparkles` / `Settings2` 图标 + 一句说明）+ 底部「跳过引导」ghost 按钮；`onSelect(route)` / `onSkip()` props。

**本任务先建 5 个步骤占位文件**（`ProviderStep` 等，各导出最小组件 `<XxxStep ctx>` 显示步骤标题 + 「下一步」临时按钮推进 `go(...)`），Task 7-9 逐个替换为真实现——占位保证骨架测试可跑、typecheck 可过。占位中 ProviderStep 显示标题「配置模型服务」（测试断言锚点）。

- [ ] **Step 4: App.tsx 空态分支改造**

`renderer/src/App.tsx`：新增 `const [obStatus, setObStatus] = useState<'pending'|'completed'|'skipped'>('pending');`，bootstrapped 后拉取（失败静默保持 pending）；空态分支改为：

```tsx
  if (workspaces.length === 0) {
    // 首启空态：引导 pending → 向导；completed/skipped/失败 → 原空态表单（spec §3.1）
    if (obStatus === 'pending') {
      return <OnboardingWizard onFinished={() => void load()} />;
    }
    return (
      <div className="flex flex-col h-screen w-screen overflow-hidden bg-canvas">
        <TitleBar />
        <div className="flex-1 min-h-0 flex items-center justify-center p-6">
          <CreateWorkspaceDialog onClose={() => void load()} embedded />
        </div>
      </div>
    );
  }
```

（`load()` 在向导 markDone 完成后重拉——workspaces 已非空 → MainShell。）

- [ ] **Step 5: 跑测试 + typecheck**

Run: `cd renderer && npx pnpm@9.0.0 vitest run src/routes/OnboardingWizard.test.tsx && cd .. && npx pnpm@9.0.0 typecheck`
Expected: PASS + 0 error

- [ ] **Step 6: Commit**

```bash
git add renderer/src/routes/ renderer/src/components/onboarding/ renderer/src/App.tsx
git commit -m "feat(onboarding): 向导骨架与欢迎页，接管首启空态分支"
```

---

### Task 7: ProviderStep + WorkspaceStep 真实现

**Files:**
- Modify: `renderer/src/components/onboarding/ProviderStep.tsx`（替换占位）
- Modify: `renderer/src/components/onboarding/WorkspaceStep.tsx`（替换占位）
- Create: `renderer/src/components/onboarding/ProviderStep.test.tsx`
- Create: `renderer/src/components/onboarding/WorkspaceStep.test.tsx`

**Interfaces:**
- Consumes: `ipc.provider.listPresets / list / create / testConnection`（通道名与入参以 `electron/src/main/agent/provider-ipc.ts` 为准；renderer 调用范例见 `renderer/src/components/settings/ProviderSettings.tsx`）；`CreateWorkspaceDialog`（`embedded` 模式，props 见 App.tsx 现用法 `{ onClose, embedded }`）
- Produces: `ctx.setProvider(providerId, modelId)`（成功后 `ctx.go('workspace')`）；`ctx.setWorkspace(wsId)` + `ctx.go(route === 'ai' ? 'requirement' : 'manualAgents')`

- [ ] **Step 1: 写 ProviderStep 失败测试**

`ProviderStep.test.tsx` 覆盖：① 已有供应商时呈现「使用已有」快捷路径（mock `provider.list` 返回非空，选中后直接 `setProvider` 可下一步）② 新建路径：选预设 → 填 key/模型 → `provider.create` 被调 → `provider.testConnection` 失败时行内错误停留本步 ③ 成功路径 `ctx.go('workspace')` 被调。mock `../ipc/client` 的 `provider` 命名空间 + `onboarding`（ctx 用 vi.fn() 手造）。

```tsx
// 关键断言示例（完整用例按上述三点展开，ctx 手造：{ go: vi.fn(), setProvider: vi.fn(), ... }）
it('testConnection 失败 → 行内错误 + 停留本步', async () => {
  mocked.provider.list.mockResolvedValue([]);
  mocked.provider.listPresets.mockResolvedValue([{ key: 'zhipu', name: '智谱 GLM', baseUrl: 'https://x', platform: 'openai', thinkingWire: 'effort', models: [{ id: 'glm-5.3', contextWindow: 1, outputTokens: 1, reasoning: { kind: 'none' } }] }]);
  mocked.provider.create.mockResolvedValue({ id: 'p1', name: '智谱 GLM', baseUrl: 'https://x', defaultModel: null, isDefault: false, createdAt: '', platform: 'openai', presetKey: 'zhipu' });
  mocked.provider.testConnection.mockResolvedValue({ ok: false, error: 'HTTP 401' });
  render(<ProviderStep ctx={fakeCtx} />);
  fireEvent.click(await screen.findByRole('option', { name: /智谱/ })); // 或按实现的预设选择交互
  fireEvent.change(screen.getByLabelText(/API Key/), { target: { value: 'sk-bad' } });
  fireEvent.click(screen.getByRole('button', { name: /验证并继续/ }));
  expect(await screen.findByText(/HTTP 401/)).toBeInTheDocument();
  expect(fakeCtx.go).not.toHaveBeenCalled();
});
```

（选择器按实现微调；三条用例的 mock 边界保持 IPC 返回形状保真——对照 provider-crud 的 `ModelProvider` 形状。）

- [ ] **Step 2: 实现 ProviderStep**

紧凑表单：预设下拉（`provider.listPresets` → 选中预填 baseUrl/platform + 默认模型取预设第一个模型）/ API Key 输入 / 模型输入（预填可改）/「验证并继续」→ `provider.create`（key 由 create 入参携带——对照 ProviderSettings 的 create 调用形状；若 create 不收 key 则再查 `provider.getApiKey` 链路并补 key 写入调用，以 ProviderSettings.tsx 实际做法为准）→ `provider.testConnection({ baseUrl, apiKey, model })` → 失败行内红字停留；成功 `ctx.setProvider(id, model)` + `ctx.go('workspace')`。已有供应商（`provider.list` 非空）：顶部「使用已有供应商」单选列表（选中即 `setProvider` + 下一步）。视觉按 Task 5 基线，语义 token + lucide。

- [ ] **Step 3: WorkspaceStep 实现 + 测试**

直接复用：`<CreateWorkspaceDialog embedded onClose={...} />`——创建成功如何拿 wsId？`CreateWorkspaceDialog` 内部走 workspace.store 的 `create`（新建即激活）。WorkspaceStep 挂载后订阅 `useWorkspaceStore((s) => s.activeWorkspaceId)`，从 `undefined → 有值` 的变化捕获 wsId → `ctx.setWorkspace(id)` + `ctx.go(...)`。`onClose` 兜底重查。测试：mock workspace.store（或 mock `CreateWorkspaceDialog` 子组件触发 store create），断言 `ctx.setWorkspace` 与 `go` 按路线分叉（`route='ai'` → `requirement`；`manual` → `manualAgents`）。

- [ ] **Step 4: 跑测试 + typecheck + Commit**

Run: `cd renderer && npx pnpm@9.0.0 vitest run src/components/onboarding/ && cd .. && npx pnpm@9.0.0 typecheck`

```bash
git add renderer/src/components/onboarding/
git commit -m "feat(onboarding): 供应商配置步（预设+验证）与工作空间步（复用创建对话框）"
```

---

### Task 8: RequirementStep + PlanPreviewStep（AI 路线）

**Files:**
- Modify: `renderer/src/components/onboarding/RequirementStep.tsx`
- Modify: `renderer/src/components/onboarding/PlanPreviewStep.tsx`
- Create: `renderer/src/components/onboarding/PlanPreviewStep.test.tsx`
- Create: `renderer/src/components/onboarding/RequirementStep.test.tsx`

**Interfaces:**
- Consumes: `ipc.onboarding.generatePlan / applyPlan`；Task 6 `WizardCtx`
- Produces: RequirementStep：`generatePlan({ requirement, providerId, modelId })` 成功把 `{ plan, warnings }` 经组件内 state 传给 PlanPreviewStep（提升到 OnboardingWizard：骨架加 `plan` / `setPlan` 到 ctx——实现时同步扩展 `WizardCtx` 并更新骨架）；PlanPreviewStep：`applyPlan({ plan: 勾改后, workspaceId, providerId, modelId })`

- [ ] **Step 1: 写 PlanPreviewStep 失败测试**

```tsx
// 覆盖：① 渲染方案卡（agent 名 + reason + 来源徽标）② 取消全部勾选 → 应用按钮禁用
// ③ 默认 agent 单选随勾选收缩，被取消回退第一勾选项 ④ warning 区渲染
// ⑤ applyPlan reject → 错误卡 + [重试] [转手动]（转手动调 ctx.toManual）
// ⑥ applyPlan 成功 → ctx.go('done')
```

（mock `ipc.onboarding.applyPlan`；`plan` prop 用 Task 2 VALID_PLAN 同形手造。六条用例逐条断言，mock 边界保真 `OnboardingApplyResult` 形状。）

- [ ] **Step 2: 实现 RequirementStep**

textarea（placeholder 示例：「例如：我每周要整理客户访谈记录，生成需求文档和周报……」）+ 4000 字符计数（超限截断 + 提示文案「已超出上限，将截断前 4000 字」——Review Focus 6 的 UI 面）+「生成配置方案」→ loading 态（禁用按钮 + Spinner）→ 成功存 plan 进 ctx → `go('preview')`；失败 → 错误卡（中文原因 + [重试] [转手动]）。

- [ ] **Step 3: 实现 PlanPreviewStep**

方案卡列表：每卡 `Checkbox`（含复选）+ 名称 + 来源徽标（预制 `Shape=Badge` / 自定义）+ reason + 挂载 MCP/skill 标签行；默认 agent `radio`（限勾选项，全收缩回退第一项）；warnings 黄色提示区；[应用配置] → `applyPlan`（勾改后的 plan：被取消项剔除、defaultAgentIndex 重算）→ 成功 `go('done')`；失败错误卡 + [重试]（幂等，spec §6.3）+ [转手动]。

- [ ] **Step 4: 跑测试 + typecheck + Commit**

Run: `cd renderer && npx pnpm@9.0.0 vitest run src/components/onboarding/ && cd .. && npx pnpm@9.0.0 typecheck`

```bash
git add renderer/src/components/onboarding/ renderer/src/routes/OnboardingWizard.tsx
git commit -m "feat(onboarding): AI 路线需求描述与方案预览（勾改/默认单选/失败转手动）"
```

---

### Task 9: ManualAgentStep + DoneStep

**Files:**
- Modify: `renderer/src/components/onboarding/ManualAgentStep.tsx`
- Modify: `renderer/src/components/onboarding/DoneStep.tsx`
- Create: `renderer/src/components/onboarding/ManualAgentStep.test.tsx`
- Create: `renderer/src/components/onboarding/DoneStep.test.tsx`

**Interfaces:**
- Consumes: `ipc.resource.listBuiltinPresets('agent')` / `ipc.resource.previewBuiltinPreset(slug)`（通道签名见 `electron/src/main/resource/ipc.handlers.ts:537-547`）；`ipc.onboarding.applyPlan`（手动路线复用同一应用器：把用户勾选组装成 plan——preset 项 + custom 项（精简表单产出），`mcps/skills` 恒 `[]`：手动路线不暴露 MCP/skill 勾选（spec §8），预制 def 的 YAML 声明能力在启用链保留）；`ipc.onboarding.markDone`
- Produces: 完成时 `markDone({ skipped: false })` + `ctx.finish()`

- [ ] **Step 1: 写 ManualAgentStep 测试**

覆盖：① 预制清单渲染（mock listBuiltinPresets 返回 3 项）② 展开预览（previewBuiltinPreset 的 systemPrompt 截断展示）③ 至少勾选 1 个才能继续 ④「创建自定义」内联表单（name/prompt/工具两档）产出 custom plan 项 ⑤ 默认 agent 单选 ⑥ 组装 plan 调 `applyPlan`（preset + custom 混合）→ 成功 `go('done')`。

- [ ] **Step 2: 实现 ManualAgentStep + DoneStep**

ManualAgentStep：预制卡列表（勾选 + 展开详情）+「创建自定义 agent」折叠表单（名称 / 图标 / 系统提示词 / 工具档 `Segmented`：标准 / 全部）+ 默认 agent 单选 + [完成配置] → 组装 `OnboardingPlan`（preset 项 mcps/skills 空数组；custom 项 toolPreset 映射）→ `applyPlan` → 成功 `go('done')`，失败错误卡 + [重试]。

DoneStep：结果摘要（`applied` 清单 + 默认 agent 名 + warnings 若有）+ [开始使用] → `markDone({ skipped: false })` → `ctx.finish()`。

- [ ] **Step 3: 跑测试 + typecheck + Commit**

Run: `cd renderer && npx pnpm@9.0.0 vitest run src/components/onboarding/ && cd .. && npx pnpm@9.0.0 typecheck`

```bash
git add renderer/src/components/onboarding/
git commit -m "feat(onboarding): 手动路线 agent 配置与完成页"
```

---

### Task 10: e2e 适配 + 主链路 e2e + 全量回归

**Files:**
- Modify: `tests/e2e/*.spec.ts`（既有空态相关用例适配）
- Create: `tests/e2e/onboarding.spec.ts`

**Interfaces:**
- Consumes: Playwright 既有 fixtures（`tests/e2e/` 现行模式——先读该目录任一 spec 对齐启动/隔离方式）；kv seed：e2e 环境的 userData 目录下预写 `state.db` 不现实——改为在受影响的旧空态用例开头走「跳过引导」路径（点跳过按钮 → 旧空态断言照旧）
- Produces: 验收证据（spec §11 验收标准 1/3/8 的 e2e 覆盖）

- [ ] **Step 1: 适配既有空态用例**

Grep `tests/e2e/` 中依赖首启空态（CreateWorkspaceDialog 直接可见）的用例；在断言前置步骤加「点击『跳过引导』」。逐个跑通。

- [ ] **Step 2: 新增 `tests/e2e/onboarding.spec.ts`**

主链路（AI 路线，真实 LLM 不可用——mock 到主进程不现实；e2e 只走**手动路线**主链路 + AI 路线的失败降级）：

```ts
// 用例 1（手动路线主链路）：首启 → 向导可见 → 手动引导 → 使用已有供应商路径或
//   新建（e2e 环境真实 create + testConnection 会失败——e2e 的 provider 步允许
//   「跳过验证继续」？→ 不引入新交互：e2e 走 testConnection 必然失败的网络环境
//   断言错误卡出现即停止。完整成功链路留给验收手动走查（momo-acceptance），
//   e2e 断言到「供应商步错误卡 + 转手动可达」）。
// 用例 2（跳过）：跳过引导 → 旧空态表单可见；重启（reload）→ 不再出现向导。
// 用例 3（欢迎页）：两条路线按钮可见，点 AI 引导进入供应商步。
```

（e2e 断言边界明确：完整 AI 成功链路含真实 LLM 调用，属验收走查域不在 CI e2e 域——spec §10 e2e 节「新增主链路」按此裁定落地为手动路线 + 失败降级，理由回写 spec §10 不需要——计划即此裁定的载体。）

- [ ] **Step 3: 全量回归**

```bash
npx pnpm@9.0.0 typecheck
npx pnpm@9.0.0 test          # 两 workspace 全部单测
npx pnpm@9.0.0 e2e           # 需先 build（NODE_OPTIONS=4096）
```

Expected: 全绿（既有失败如与本特性无关，列明不扩大范围）。

- [ ] **Step 4: alpha 版本号 +1（版本纪律：三处 package.json alpha 号，不动 CHANGELOG 产品版本）**

```bash
# 根 / electron / renderer 三处 package.json 的 2.1.0-alpha.N → N+1（以当前实际 alpha 号为准）
git add package.json electron/package.json renderer/package.json
git commit -m "chore: bump 2.1.0-alpha 版本号（onboarding 引导系统）"
```

- [ ] **Step 5: 验收走查（momo-acceptance 技能，App 级）**

真实 App 启动（隔离 profile），按 spec §11 验收标准 1-7 逐条走查，产出 `.omo/qa-reports/` 报告。AI 路线走真实 LLM（需求方提供 key 的测试供应商）。

---

## Self-Review 记录

- **Spec 覆盖**：§3 流程/触发（Task 6）、§4 kv（Task 1）、§5 契约（Task 1/3/4）、§6.1 生成（Task 3）、§6.2 重校验（Task 2/4）、§6.3 应用（Task 4）、§7 同步规则（Task 2/4）、§8 组件（Task 5-9）、§9 错误表（Task 3/7/8/9 各自错误路径测试）、§10 测试（各任务 + Task 10）、§11 验收（Task 10 e2e + 走查）、§12 风险（启用链幂等已有 preset.test.ts 回归 + Task 4 幂等测试）、§13 注意事项（UI 门禁 Task 5 / 版本纪律 Task 10）——无缺口
- **占位符扫描**：Task 4 的 `createCustomDef` / `updateAgentDefinition` 以「打开文件核对签名」+ 既有调用范例（preset.ts:94-106、CreateAgentDialog.tsx:121-138）锚定，非 TBD；无其他占位
- **类型一致性**：`OnboardingPlan` 形状在 Task 1（renderer）/ Task 2（electron 镜像）一致；`WizardCtx` 在 Task 6 定义、Task 8 扩展 `plan/setPlan` 已注明同步更新骨架；`GenerateOnboardingPlanResult` Task 1 定义 / Task 3 使用一致
- **Review Focus**：6 条全部有归属任务与测试步骤
