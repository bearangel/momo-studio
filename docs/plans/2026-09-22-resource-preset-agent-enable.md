# 资源库预设 agent 启用与 LLM 配置 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 打通资源库「系统预置」agent 的按需启用链路——一键完成 def 入库 + LLM 配置 +（可选）加入工作空间，并让 marketplace 安装的 agent 获得 LLM 配置引导。

**Architecture:** 单一后端编排 IPC `agent:enablePreset`（解析 `resources/agents/<slug>.yaml` → 确定性 id `builtin-<slug>` 幂等落库 → 模型字段覆盖 → 可选 addMember + 设默认）；`ResourceItem.builtin.agentEnabled` 标志驱动资源库详情面板「启用 / 配置」按钮；`EnablePresetDialog` 复用 `ProviderModelPicker` 完成启用即配。

**Tech Stack:** Electron 主进程（CommonJS + better-sqlite3）、React + zustand renderer、vitest 双 workspace。

**Spec:** `docs/specs/2026-09-22-resource-preset-agent-enable-design.md`（本计划的唯一上游依据）

## Global Constraints

- Node 20 LTS（`nvm use 20`）；包管理 `npx pnpm@9.0.0`；容器内测试不加 `--no-sandbox`
- TypeScript strict：禁止 `any` / `@ts-ignore` / `as any`；ESLint `no-explicit-any: error`
- 所有源码注释、文档中文；标识符英文；Conventional Commits（`feat:` / `test:` / `chore:`）
- 测试位置：electron 主进程测试集中 `electron/tests/`（镜像 src 结构）；renderer 测试贴源同目录
- renderer UI：语义 token（`text-status-success` 等）、lucide 图标（本文件小按钮沿用 `size={12} strokeWidth={1.75}` 的既有局部模式）、禁 inline 硬编码色
- 每个任务完成即 commit（实现 + 测试同 commit）；**版本号不动**
- mock 纪律（momo-test-rules）：只 mock IPC / 子进程 / 网络边界，DB 用真实 SQLite（`runMigrations` + `closeDb` + `AP_USER_DATA_DIR` 环境变量，参考 `electron/tests/agent/builtin.test.ts` 夹具）

---

### Task 1: 后端 def 层 — `enablePresetDef` / `enablePresetWithJoin`

**Files:**
- Modify: `electron/src/main/agent/builtin.ts`（导出三个辅助：`setBuiltinSuggestion` / `readBuiltinManifestBySlug` / `loadBuiltinSuggestionsOnly`）
- Modify: `electron/src/main/agent/crud.ts:36`（`assertThinkingConfigShape` 加 `export`）
- Create: `electron/src/main/agent/preset.ts`
- Test: `electron/tests/agent/preset.test.ts`

**Interfaces:**
- Consumes: `parseAgentManifestWithSuggestion(yaml): { def, suggestion }`（manifest-parser）；`saveAgentDefinition` / `addMember` / `generateAgentUserId` / `listMembers`（crud）；`getProvider`（provider-crud）；`isValidSlug`（marketplace/types）；`getWorkspace` / `createWorkspace` / `setDefaultAgent`（workspace/crud）
- Produces（Task 2 依赖）:
  - `enablePresetWithJoin(input: EnablePresetWithJoinInput): Promise<EnablePresetOutcome>`
  - `EnablePresetWithJoinInput = { slug; modelProviderId; modelName; thinkingJson?; joinWorkspaceId?; setAsDefault? }`
  - `EnablePresetOutcome = { def: AgentDefinition; member: WorkspaceAgentMember | null; joinedNow: boolean }`
  - `loadBuiltinSuggestionsOnly(): void`（Task 7 接线）

- [ ] **Step 1: 写失败测试**

创建 `electron/tests/agent/preset.test.ts`：

```ts
// electron/tests/agent/preset.test.ts
//
// 预设 agent 按需启用（spec 2026-09-22）def 层 + 编排层测试：
//   1. enablePresetDef：确定性 id / source=builtin / 模型字段入参覆盖
//   2. 幂等：重复启用 id 不变、字段覆盖
//   3. suggestions Map 填充该条
//   4. 源头拒绝：slug 路径穿越 / 供应商不存在 / YAML 缺失
//   5. enablePresetWithJoin：加入 + 设默认（DB 行断言）
//   6. join 幂等：重复调用返回既有 member、joinedNow=false
//   7. loadBuiltinSuggestionsOnly：只填 Map 不落库
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import {
  listAgentDefinitions,
  getAgentDefinition,
  listMembers,
} from '../../src/main/agent/crud';
import {
  setBuiltinAgentsDir,
  getBuiltinSuggestionsMap,
  clearBuiltinSuggestionsForTest,
} from '../../src/main/agent/builtin';
import {
  enablePresetDef,
  enablePresetWithJoin,
} from '../../src/main/agent/preset';
import { createWorkspace } from '../../src/main/workspace/crud';

const tmpRoot = path.join(os.tmpdir(), `ap-preset-test-${Date.now()}`);

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

/** 插入测试供应商行（model_providers）——getProvider 校验依赖 */
function seedProvider(id: string): void {
  getDb().prepare(
    `INSERT INTO model_providers (id, name, base_url, default_model, is_default, created_at, platform, preset_key)
     VALUES (?, '测试供应商', 'https://api.test/v1', NULL, 0, datetime('now'), 'openai', NULL)`,
  ).run(id);
}

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  clearBuiltinSuggestionsForTest();
  const agentDir = path.join(tmpRoot, 'agents');
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, 'requirement-analyst.yaml'), VALID_YAML, 'utf-8');
  setBuiltinAgentsDir(agentDir);
  seedProvider('prov-1');
});

afterEach(() => {
  closeDb();
  setBuiltinAgentsDir(null);
  clearBuiltinSuggestionsForTest();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

describe('enablePresetDef — def 层', () => {
  it('落库：确定性 id builtin-<slug>、source=builtin、模型字段以入参覆盖', () => {
    const def = enablePresetDef({
      slug: 'requirement-analyst',
      modelProviderId: 'prov-1',
      modelName: 'glm-4.7',
    });
    expect(def.id).toBe('builtin-requirement-analyst');
    expect(def.source).toBe('builtin');
    expect(def.modelProviderId).toBe('prov-1');
    expect(def.modelName).toBe('glm-4.7');
    expect(def.systemPrompt).toBe('你是需求分析师');
    // DB 行为准（不是只看返回值）
    const row = getAgentDefinition('builtin-requirement-analyst');
    expect(row?.modelProviderId).toBe('prov-1');
    expect(listAgentDefinitions().some((d) => d.id === def.id)).toBe(true);
  });

  it('幂等：重复启用 id 不变、模型字段覆盖为新值', () => {
    const first = enablePresetDef({
      slug: 'requirement-analyst', modelProviderId: 'prov-1', modelName: 'glm-4.7',
    });
    const second = enablePresetDef({
      slug: 'requirement-analyst', modelProviderId: 'prov-1', modelName: 'deepseek-chat',
    });
    expect(second.id).toBe(first.id);
    expect(listAgentDefinitions().filter((d) => d.id === first.id)).toHaveLength(1);
    expect(getAgentDefinition(first.id)?.modelName).toBe('deepseek-chat');
  });

  it('suggestions Map 填充该条（key=builtin-<slug>）', () => {
    enablePresetDef({ slug: 'requirement-analyst', modelProviderId: 'prov-1', modelName: 'glm-4.7' });
    expect(getBuiltinSuggestionsMap()['builtin-requirement-analyst']).toBeDefined();
    expect(getBuiltinSuggestionsMap()['builtin-requirement-analyst'].suggestedPlatform).toBe('anthropic');
  });

  it('slug 路径穿越拒绝（../evil 形态）', () => {
    expect(() =>
      enablePresetDef({ slug: '../evil', modelProviderId: 'prov-1', modelName: 'm' }),
    ).toThrow(/slug 非法/);
  });

  it('供应商不存在拒绝（ghost provider）', () => {
    expect(() =>
      enablePresetDef({ slug: 'requirement-analyst', modelProviderId: 'prov-gone', modelName: 'm' }),
    ).toThrow(/供应商不存在/);
  });

  it('YAML 缺失报错（不静默）', () => {
    expect(() =>
      enablePresetDef({ slug: 'no-such-preset', modelProviderId: 'prov-1', modelName: 'm' }),
    ).toThrow(/不存在/);
  });

  it('空 modelProviderId / modelName 拒绝', () => {
    expect(() =>
      enablePresetDef({ slug: 'requirement-analyst', modelProviderId: '  ', modelName: 'm' }),
    ).toThrow(/modelProviderId/);
    expect(() =>
      enablePresetDef({ slug: 'requirement-analyst', modelProviderId: 'prov-1', modelName: '' }),
    ).toThrow(/modelName/);
  });
});

describe('enablePresetWithJoin — 编排层（DB 断言）', () => {
  it('join + setAsDefault：workspace_agent_members 落行 + default_agent_instance_id 写入', async () => {
    const ws = await createWorkspace({ name: '测试 ws', directoryPath: path.join(tmpRoot, 'ws') });
    const outcome = await enablePresetWithJoin({
      slug: 'requirement-analyst',
      modelProviderId: 'prov-1',
      modelName: 'glm-4.7',
      joinWorkspaceId: ws.id,
      setAsDefault: true,
    });
    expect(outcome.joinedNow).toBe(true);
    expect(outcome.member).not.toBeNull();
    expect(outcome.member?.agentDefinitionId).toBe('builtin-requirement-analyst');
    // DB 行断言（生产消费的字段）
    const members = listMembers(ws.id);
    expect(members).toHaveLength(1);
    expect(members[0]!.agentUserId).toMatch(/^agent-requirement-analyst-/);
    const wsRow = getDb()
      .prepare('SELECT default_agent_instance_id FROM workspaces WHERE id = ?')
      .get(ws.id) as { default_agent_instance_id: string | null };
    expect(wsRow.default_agent_instance_id).toBe(outcome.member!.instanceId);
  });

  it('不 join：member=null、joinedNow=false', async () => {
    const outcome = await enablePresetWithJoin({
      slug: 'requirement-analyst', modelProviderId: 'prov-1', modelName: 'glm-4.7',
    });
    expect(outcome.member).toBeNull();
    expect(outcome.joinedNow).toBe(false);
  });

  it('join 幂等：重复调用返回既有 member、joinedNow=false、不重复落行', async () => {
    const ws = await createWorkspace({ name: '测试 ws 2', directoryPath: path.join(tmpRoot, 'ws2') });
    const first = await enablePresetWithJoin({
      slug: 'requirement-analyst', modelProviderId: 'prov-1', modelName: 'glm-4.7',
      joinWorkspaceId: ws.id,
    });
    const second = await enablePresetWithJoin({
      slug: 'requirement-analyst', modelProviderId: 'prov-1', modelName: 'glm-4.7',
      joinWorkspaceId: ws.id,
    });
    expect(second.joinedNow).toBe(false);
    expect(second.member?.instanceId).toBe(first.member?.instanceId);
    expect(listMembers(ws.id)).toHaveLength(1);
  });
});

describe('loadBuiltinSuggestionsOnly — 启动轻量加载', () => {
  it('只填 suggestions Map，不落 agent_definitions', async () => {
    const { loadBuiltinSuggestionsOnly } = await import('../../src/main/agent/builtin');
    const before = listAgentDefinitions().length;
    loadBuiltinSuggestionsOnly();
    expect(getBuiltinSuggestionsMap()['builtin-requirement-analyst']).toBeDefined();
    expect(listAgentDefinitions().length).toBe(before);
  });
});
```

- [ ] **Step 2: 跑测试确认红**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/agent/preset.test.ts
```
预期：FAIL —— `Cannot find module '../../src/main/agent/preset'`。

- [ ] **Step 3: 实现**

3a. `electron/src/main/agent/crud.ts`：第 36 行 `function assertThinkingConfigShape` 改为 `export function assertThinkingConfigShape`（注释不变）。

3b. `electron/src/main/agent/builtin.ts` 文件尾部（`void listAgentDefinitions;` 之前）追加：

```ts
/** 写入单条 suggestion（preset.ts 按需启用时调用；spec 2026-09-22） */
export function setBuiltinSuggestion(defId: string, suggestion: BuiltinSuggestion): void {
  builtinSuggestions.set(defId, suggestion);
}

/**
 * 按 slug 读取单个内置 agent manifest（preset.ts 启用链路）。
 * 文件缺失抛错——按需启用是用户显式动作，缺文件必须可见
 * （区别于 registerBuiltinAgents 整目录扫描的静默跳过）。
 */
export function readBuiltinManifestBySlug(slug: string): {
  def: AgentDefinition;
  suggestion: BuiltinSuggestion;
} {
  const dir = dirOverride ?? resolveBuiltinAgentsDir();
  const file = path.join(dir, `${slug}.yaml`);
  if (!fs.existsSync(file)) {
    throw new Error(`预设 agent 文件不存在: ${file}`);
  }
  return parseAgentManifestWithSuggestion(fs.readFileSync(file, 'utf-8'));
}

/**
 * 启动轻量加载：解析全部内置 YAML 只填 suggestions Map，不落库（spec §5）。
 * 保证 agent:getBuiltinSuggestions 开箱有数据（平台预选可用），
 * DB 维持「按需启用」语义——def 行仅在用户点启用时写入。
 */
export function loadBuiltinSuggestionsOnly(): void {
  builtinSuggestions.clear();
  const dir = dirOverride ?? resolveBuiltinAgentsDir();
  if (!fs.existsSync(dir)) {
    logger.warn('内置 agent 目录不存在，跳过 suggestions 加载', { dir });
    return;
  }
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.yaml'))) {
    try {
      const yamlContent = fs.readFileSync(path.join(dir, file), 'utf-8');
      const { def, suggestion } = parseAgentManifestWithSuggestion(yamlContent);
      builtinSuggestions.set(`builtin-${def.slug}`, suggestion);
    } catch (err) {
      logger.error('解析内置 agent 失败（suggestions only）', {
        file,
        error: (err as Error).message,
      });
    }
  }
}
```

3c. 创建 `electron/src/main/agent/preset.ts`：

```ts
// electron/src/main/agent/preset.ts
//
// 预设 agent 按需启用（spec 2026-09-22 资源库预设 agent 启用与 LLM 配置）。
//
// 背景：registerBuiltinAgents（启动全量落库）自 v1.1 起不再被启动调用，builtin
// 内联 catalog 项 installable=false——预设 agent 的 def 从未进入 agent_definitions，
// 既无法配置 LLM 也无法加入会话。本模块是「按需启用」替代：
//   - enablePresetDef：解析 resources/agents/<slug>.yaml → 确定性 id builtin-<slug>
//     幂等落库（source='builtin'）→ 模型字段以入参覆盖 → 填充该条 builtinSuggestions
//   - enablePresetWithJoin：叠加「加入工作空间（幂等）+ 设默认」编排；
//     runtime 启动留在 IPC handler（与 agent:addMember 同模式——子进程 spawn
//     属外部边界，DB 语义在此层可测）
import {
  readBuiltinManifestBySlug,
  setBuiltinSuggestion,
} from './builtin';
import {
  saveAgentDefinition,
  addMember,
  generateAgentUserId,
  listMembers,
  assertThinkingConfigShape,
} from './crud';
import { getProvider } from './provider-crud';
import { getWorkspace, setDefaultAgent } from '../workspace/crud';
import { isValidSlug } from '../marketplace/types';
import type { AgentDefinition, WorkspaceAgentMember } from './types';
import type { ThinkingConfig } from '../llm/provider-presets';

/** def 层入参（IPC EnablePresetInput 的子集） */
export interface EnablePresetDefInput {
  /** 预设 agent slug（须过 marketplace isValidSlug 白名单，防路径穿越） */
  slug: string;
  modelProviderId: string;
  modelName: string;
  /** agent 级思维覆盖；null=清除（继承模型级） */
  thinkingJson?: ThinkingConfig | null;
}

/** 完整入参（IPC 层直传形状） */
export interface EnablePresetWithJoinInput extends EnablePresetDefInput {
  /** 传入则加入该 workspace（幂等） */
  joinWorkspaceId?: string;
  /** 仅 joinWorkspaceId 存在时生效 */
  setAsDefault?: boolean;
}

export interface EnablePresetOutcome {
  def: AgentDefinition;
  member: WorkspaceAgentMember | null;
  /** 本次是否新加入（true 时 IPC handler 需启动 runtime） */
  joinedNow: boolean;
}

/** 启用预设 agent（def 层）。全部校验先于写库完成（源头拒绝，不留半启用态）。 */
export function enablePresetDef(input: EnablePresetDefInput): AgentDefinition {
  if (!isValidSlug(input.slug)) {
    throw new Error(`预设 slug 非法: ${input.slug}`);
  }
  const providerId = input.modelProviderId.trim();
  const modelName = input.modelName.trim();
  if (!providerId) throw new Error('modelProviderId 不能为空');
  if (!modelName) throw new Error('modelName 不能为空');
  if (!getProvider(providerId)) {
    throw new Error(`供应商不存在: ${providerId}（可能已被删除，请刷新供应商列表）`);
  }
  if (input.thinkingJson != null) assertThinkingConfigShape(input.thinkingJson);

  const { def: parsed, suggestion } = readBuiltinManifestBySlug(input.slug);
  const def: AgentDefinition = {
    ...parsed,
    id: `builtin-${parsed.slug}`,
    source: 'builtin',
    workspaceId: null,
    modelProviderId: providerId,
    modelName,
    thinkingJson: input.thinkingJson ?? null,
  };
  saveAgentDefinition(def);
  setBuiltinSuggestion(def.id, suggestion);
  return def;
}

/**
 * 启用 + 可选加入编排（DB 层；不启动 runtime）。
 * - joinWorkspaceId 缺省：仅落库，member=null
 * - 已加入（同 ws 同 def）：幂等返回既有 member，joinedNow=false
 * - setAsDefault 仅加入场景生效；失败上抛（def/member 已落库不回滚，重试安全）
 */
export async function enablePresetWithJoin(
  input: EnablePresetWithJoinInput,
): Promise<EnablePresetOutcome> {
  const def = enablePresetDef(input);
  if (!input.joinWorkspaceId) return { def, member: null, joinedNow: false };

  const workspace = getWorkspace(input.joinWorkspaceId);
  if (!workspace) throw new Error(`未找到 workspace: ${input.joinWorkspaceId}`);

  const existing = listMembers(input.joinWorkspaceId).find(
    (m) => m.agentDefinitionId === def.id,
  );
  if (existing) return { def, member: existing, joinedNow: false };

  const member = await addMember(input.joinWorkspaceId, def.id, generateAgentUserId(def.slug));
  if (input.setAsDefault) {
    setDefaultAgent(input.joinWorkspaceId, member.instanceId);
  }
  return { def, member, joinedNow: true };
}
```

- [ ] **Step 4: 跑测试确认绿**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/agent/preset.test.ts
```
预期：PASS（全部用例）。若 `getAgentDefinition` 返回类型无 `modelName` 直接字段断言报错，以 `listAgentDefinitions().find(...)` 的返回为准修正断言（electron 端 `getAgentDefinition` 返回 `AgentDefinition`，`modelName` 字段存在）。

- [ ] **Step 5: 跑邻近回归（builtin / membership）**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/agent/builtin.test.ts tests/agent/membership-crud.test.ts
```
预期：PASS。

- [ ] **Step 6: Commit**

```bash
git add electron/src/main/agent/preset.ts electron/src/main/agent/builtin.ts electron/src/main/agent/crud.ts electron/tests/agent/preset.test.ts
git commit -m "feat: 预设 agent 按需启用 def 层（enablePresetDef/enablePresetWithJoin + suggestions 辅助）"
```

---

### Task 2: IPC 通道 — `agent:enablePreset` handler + preload + 双端契约

**Files:**
- Modify: `electron/src/main/agent/ipc.handlers.ts`（新 handler + import）
- Modify: `electron/src/preload/index.ts:70` 附近（agent 段加一行）
- Modify: `renderer/src/ipc/types.d.ts`（AddMemberInput 后加两个接口；ApiSurface agent 段 `updateDefinition` 后加一行）

**Interfaces:**
- Consumes: Task 1 的 `enablePresetWithJoin` / `EnablePresetWithJoinInput`；既有 `resolveApiKey` / `buildSpawnOpts` / `startAgentRuntime` / `getWorkspace`
- Produces（Task 4 依赖）: renderer `ipc.agent.enablePreset(input: EnablePresetInput): Promise<EnablePresetResult>`

- [ ] **Step 1: electron handler**

`electron/src/main/agent/ipc.handlers.ts` import 区追加（`./builtin` 的 import 行合并）：

```ts
import { enablePresetWithJoin, type EnablePresetWithJoinInput } from './preset';
```

`registerAgentHandlers()` 内（`agent:addMember` handler 之后）追加：

```ts
  // 预设 agent 按需启用（spec 2026-09-22）：def 入库 + 模型写入 +（可选）加入并启动。
  // DB 语义在 preset.ts（可测）；此处仅补 runtime 启动（与 agent:addMember 同模式）。
  ipcMain.handle('agent:enablePreset', async (_evt, input: EnablePresetWithJoinInput) => {
    const outcome = await enablePresetWithJoin(input);
    if (outcome.joinedNow && outcome.member && input.joinWorkspaceId) {
      const workspace = getWorkspace(input.joinWorkspaceId);
      if (!workspace) throw new Error(`未找到 workspace: ${input.joinWorkspaceId}`);
      const providerId = outcome.def.modelProviderId;
      if (providerId) {
        const apiKey = await resolveApiKey(outcome.member.instanceId, providerId);
        await startAgentRuntime(
          await buildSpawnOpts({
            instanceId: outcome.member.instanceId,
            agentUserId: outcome.member.agentUserId,
            workspaceId: input.joinWorkspaceId,
            workspaceDir: workspace.directoryPath,
            def: outcome.def,
            llmApiKey: apiKey,
          }),
        );
      }
    }
    return { def: outcome.def, member: outcome.member };
  });
```

- [ ] **Step 2: preload 暴露**

`electron/src/preload/index.ts` agent 段（`updateDefinition` 行后）：

```ts
    enablePreset: (input) => invoke('agent:enablePreset', input),
```

- [ ] **Step 3: renderer 契约类型**

`renderer/src/ipc/types.d.ts` —— `AddMemberInput` 接口（约 292-298 行）之后追加：

```ts
/** agent:enablePreset 入参（spec 2026-09-22 资源库预设 agent 启用与 LLM 配置） */
export interface EnablePresetInput {
  /** 预设 agent slug（resources/agents/<slug>.yaml） */
  slug: string;
  modelProviderId: string;
  modelName: string;
  thinkingJson?: ThinkingConfig | null;
  /** 传入则加入该 workspace 并启动（幂等） */
  joinWorkspaceId?: string;
  /** 仅 joinWorkspaceId 存在时生效 */
  setAsDefault?: boolean;
}

/** agent:enablePreset 返回 */
export interface EnablePresetResult {
  def: AgentDefinition;
  member: WorkspaceAgentMember | null;
}
```

ApiSurface 的 `agent` 段（约 1241 行起，`updateDefinition` 声明之后）追加：

```ts
    /** 预设 agent 按需启用（spec 2026-09-22）：def 入库 + 模型 + 可选加入/设默认 */
    enablePreset(input: EnablePresetInput): Promise<EnablePresetResult>;
```

- [ ] **Step 4: 双端 typecheck 锁契约**

```bash
npx pnpm@9.0.0 typecheck
```
预期：两个 workspace 0 error（IPC 三层：handler / preload / types.d.ts 形状一致）。

- [ ] **Step 5: Commit**

```bash
git add electron/src/main/agent/ipc.handlers.ts electron/src/preload/index.ts renderer/src/ipc/types.d.ts
git commit -m "feat: agent:enablePreset IPC 通道（handler + preload + 双端契约）"
```

---

### Task 3: `agentEnabled` 数据契约 — catalog-adapter 计算

**Files:**
- Modify: `electron/src/main/resource/types.ts:54`（builtin namespace 加字段）
- Modify: `electron/src/main/resource/catalog-adapter.ts`（计算逻辑）
- Modify: `renderer/src/ipc/types.d.ts:672`（ResourceItem.builtin 同步）
- Test: `electron/tests/resource/catalog-adapter-agent-enabled.test.ts`（新建）

**Interfaces:**
- Consumes: `fromCatalogItem(item: MarketplaceItem, source: ResourceSource)`（既有签名不变）；`listAgentDefinitions()`（agent/crud）
- Produces（Task 5 依赖）: `ResourceItem.builtin.agentEnabled?: boolean`——仅 `type='agent' && source='builtin'` 时为布尔值，其余 undefined

- [ ] **Step 1: 写失败测试**

创建 `electron/tests/resource/catalog-adapter-agent-enabled.test.ts`：

```ts
// electron/tests/resource/catalog-adapter-agent-enabled.test.ts
//
// agentEnabled 标志（spec 2026-09-22 §6）：builtin agent 项按 agent_definitions
// 同 slug 匹配计算启用态；marketplace / 非 agent 项不带该字段。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb } from '../../src/main/storage/db';
import { saveAgentDefinition } from '../../src/main/agent/crud';
import { fromCatalogItem } from '../../src/main/resource/catalog-adapter';
import type { MarketplaceItem } from '../../src/main/marketplace/types';
import type { AgentDefinition } from '../../src/main/agent/types';

const tmpRoot = path.join(os.tmpdir(), `ap-catalog-enabled-${Date.now()}`);

const AGENT_ITEM: MarketplaceItem = {
  id: 'agent-coder', type: 'agent', slug: 'coder', name: '程序员', version: '1.0.0',
  author: 'Momo Studio', description: '写代码', readme: '# coder', tags: [], category: 'dev',
  iconEmoji: '💻', verificationStatus: 'official', downloadUrl: '', checksum: '',
  sizeBytes: 1, installCount: 0,
};

const MCP_ITEM: MarketplaceItem = {
  ...AGENT_ITEM, id: 'mcp-foo', type: 'mcp', slug: 'foo-server', name: 'Foo MCP',
};

function mkDef(slug: string, source: AgentDefinition['source']): AgentDefinition {
  return {
    id: `def-${slug}`, name: slug, slug, version: '1.0.0', runtime: 'declarative',
    systemPrompt: 'p', defaultTools: [], source, description: '', iconEmoji: '🤖',
    defaultMcps: [], defaultSkills: [], workspaceId: null,
    modelProviderId: 'p1', modelName: 'm1', thinkingJson: null,
  };
}

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

describe('fromCatalogItem — builtin agent 启用态', () => {
  it('def 不存在（未启用）→ agentEnabled=false', () => {
    const r = fromCatalogItem(AGENT_ITEM, 'builtin');
    expect(r.builtin?.agentEnabled).toBe(false);
  });

  it('同 slug def 存在（任意 source——marketplace 装过同口径复用）→ agentEnabled=true', () => {
    saveAgentDefinition(mkDef('coder', 'builtin'));
    const r = fromCatalogItem(AGENT_ITEM, 'builtin');
    expect(r.builtin?.agentEnabled).toBe(true);
  });

  it('非 agent 类型 / marketplace source → 不带 agentEnabled 字段', () => {
    const mcp = fromCatalogItem(MCP_ITEM, 'builtin');
    expect(mcp.builtin?.agentEnabled).toBeUndefined();
    const market = fromCatalogItem(AGENT_ITEM, 'marketplace');
    expect(market.builtin).toBeUndefined();
  });
});
```

- [ ] **Step 2: 跑测试确认红**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/resource/catalog-adapter-agent-enabled.test.ts
```
预期：FAIL —— `agentEnabled` 为 undefined。

- [ ] **Step 3: 实现**

3a. `electron/src/main/resource/types.ts` 的 `builtin?: { category?...; tags?... }` 改为：

```ts
  /** builtin 项的扩展元数据 */
  builtin?: {
    category?: string;
    tags?: string[];
    /** 仅 type=agent：预设已启用（agent_definitions 存在同 slug def）。spec 2026-09-22 启用链路 */
    agentEnabled?: boolean;
  };
```

3b. `electron/src/main/resource/catalog-adapter.ts`：import 区加 `import { listAgentDefinitions } from '../agent/crud';`；`fromCatalogItem` 内 `installed` 计算后加：

```ts
  // 预设启用态（spec 2026-09-22 §6）：仅 builtin agent 计算——按 slug 匹配
  // agent_definitions（与 marketplace install 的 slug 复用同口径，不分 source）
  const agentEnabled =
    source === 'builtin' && item.type === 'agent'
      ? listAgentDefinitions().some((d) => d.slug === item.slug)
      : undefined;
```

返回对象的 `builtin` 字段改为：

```ts
    builtin:
      source === 'builtin'
        ? {
            category: item.category,
            tags: item.tags,
            ...(agentEnabled !== undefined ? { agentEnabled } : {}),
          }
        : undefined,
```

3c. `renderer/src/ipc/types.d.ts` 的 `ResourceItem.builtin`（约 672 行）同步加：

```ts
  builtin?: {
    category?: string;
    tags?: string[];
    /** 仅 type=agent：预设已启用（spec 2026-09-22） */
    agentEnabled?: boolean;
  };
```

- [ ] **Step 4: 跑测试确认绿 + typecheck**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/resource/catalog-adapter-agent-enabled.test.ts
cd .. && npx pnpm@9.0.0 typecheck
```
预期：PASS + 0 error。

- [ ] **Step 5: Commit**

```bash
git add electron/src/main/resource/types.ts electron/src/main/resource/catalog-adapter.ts renderer/src/ipc/types.d.ts electron/tests/resource/catalog-adapter-agent-enabled.test.ts
git commit -m "feat: ResourceItem.builtin.agentEnabled 启用态标志（catalog-adapter slug 匹配计算）"
```

---

### Task 4: `EnablePresetDialog` 组件

**Files:**
- Create: `renderer/src/components/agent/EnablePresetDialog.tsx`
- Test: `renderer/src/components/agent/EnablePresetDialog.test.tsx`

**Interfaces:**
- Consumes: Task 2 的 `ipc.agent.enablePreset`；既有 `ipc.agent.updateDefinition` / `ipc.settings.getGlobal` / `ProviderModelPicker` / `ThinkingOverrideControl` / `useAgentStore` / `useWorkspaceStore` / `useProviderStore`
- Produces（Task 5 依赖）: `<EnablePresetDialog slug name def? onClose />`——`def` 缺省 = 启用模式（enablePreset + 两个 checkbox）；`def` 传入 = 编辑模式（updateDefinition + pendingRestart）

- [ ] **Step 1: 写失败测试**

创建 `renderer/src/components/agent/EnablePresetDialog.test.tsx`（ipc client mock 模式参考 `ProviderModelPicker.test.tsx` / `DefinitionEditor.test.tsx`）：

```tsx
// renderer/src/components/agent/EnablePresetDialog.test.tsx
//
// 启用/配置弹窗行为（spec 2026-09-22 §4）：
//   - 启用模式：必填拦截；保存调用 enablePreset（含 joinWorkspaceId/setAsDefault 联动）
//   - 编辑模式：预填 def 模型；保存调用 updateDefinition（仅模型字段）
//   - 默认模型预填（defaultChatModel）
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { EnablePresetDialog } from './EnablePresetDialog';
import { ipc } from '../../ipc/client';
import { useWorkspaceStore } from '../../stores/workspace.store';
import type { AgentDefinition } from '../../ipc/types';

vi.mock('../../ipc/client', () => ({
  ipc: {
    settings: { getGlobal: vi.fn() },
    provider: { list: vi.fn(), listModels: vi.fn() },
    agent: {
      enablePreset: vi.fn(),
      updateDefinition: vi.fn(),
      list: vi.fn(),
      listMembers: vi.fn(),
    },
  },
}));

const DEF: AgentDefinition = {
  id: 'builtin-coder', name: '程序员', slug: 'coder', version: '1.0.0',
  runtime: 'declarative', systemPrompt: 'p', defaultTools: [], source: 'builtin',
  description: '', iconEmoji: '💻', workspaceId: null,
  modelProviderId: 'p1', modelName: 'm-old', thinkingJson: null,
};

/** 选供应商与模型（picker 两个 Select：第 1 个=供应商，第 2 个=模型） */
function pickModel(providerId: string, modelId: string): void {
  const combos = screen.getAllByRole('combobox');
  fireEvent.change(combos[0]!, { target: { value: providerId } });
  fireEvent.change(combos[1]!, { target: { value: modelId } });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(ipc.settings.getGlobal).mockResolvedValue({} as never);
  vi.mocked(ipc.provider.list).mockResolvedValue([
    { id: 'p1', name: '供应商1', baseUrl: 'https://a', defaultModel: null, isDefault: false, createdAt: '', platform: 'openai', presetKey: null },
    { id: 'p2', name: '供应商2', baseUrl: 'https://b', defaultModel: null, isDefault: false, createdAt: '', platform: 'anthropic', presetKey: null },
  ] as never);
  vi.mocked(ipc.provider.listModels).mockResolvedValue([
    { providerId: 'p1', modelId: 'm-1', enabled: true, addedAt: 1, contextWindow: null, thinkingJson: null, reasoning: { kind: 'none' }, effectiveWindow: null },
  ] as never);
  vi.mocked(ipc.agent.listMembers).mockResolvedValue([]);
  useWorkspaceStore.setState({ workspaces: [], activeWorkspaceId: null });
});

describe('EnablePresetDialog — 启用模式', () => {
  it('模型未选：提交显示错误，不调 enablePreset', async () => {
    render(<EnablePresetDialog slug="coder" name="程序员" onClose={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: /启用$/ }));
    expect(await screen.findByText(/请选择模型供应商与模型/)).toBeInTheDocument();
    expect(ipc.agent.enablePreset).not.toHaveBeenCalled();
  });

  it('保存：调用 enablePreset，无 workspace 时不带 join 字段', async () => {
    render(<EnablePresetDialog slug="coder" name="程序员" onClose={() => {}} />);
    pickModel('p1', 'm-1');
    fireEvent.click(await screen.findByRole('button', { name: /启用$/ }));
    await waitFor(() => expect(ipc.agent.enablePreset).toHaveBeenCalledTimes(1));
    expect(ipc.agent.enablePreset).toHaveBeenCalledWith({
      slug: 'coder', modelProviderId: 'p1', modelName: 'm-1', thinkingJson: null,
    });
  });

  it('有激活 workspace 且勾选加入：带 joinWorkspaceId', async () => {
    useWorkspaceStore.setState({
      workspaces: [{ id: 'ws-1', name: 'w', description: '', directoryPath: '/tmp/w', gitInitialized: false, createdAt: '', ownerId: 'u', iconEmoji: '📁', defaultAgentInstanceId: null }],
      activeWorkspaceId: 'ws-1',
    });
    render(<EnablePresetDialog slug="coder" name="程序员" onClose={() => {}} />);
    pickModel('p1', 'm-1');
    // 「加入当前工作空间」默认勾选
    fireEvent.click(await screen.findByRole('button', { name: /启用$/ }));
    await waitFor(() => expect(ipc.agent.enablePreset).toHaveBeenCalledTimes(1));
    expect(ipc.agent.enablePreset).toHaveBeenCalledWith({
      slug: 'coder', modelProviderId: 'p1', modelName: 'm-1', thinkingJson: null,
      joinWorkspaceId: 'ws-1', setAsDefault: false,
    });
  });

  it('取消勾选加入：不带 join 字段且无「设为默认」checkbox', async () => {
    useWorkspaceStore.setState({
      workspaces: [{ id: 'ws-1', name: 'w', description: '', directoryPath: '/tmp/w', gitInitialized: false, createdAt: '', ownerId: 'u', iconEmoji: '📁', defaultAgentInstanceId: null }],
      activeWorkspaceId: 'ws-1',
    });
    render(<EnablePresetDialog slug="coder" name="程序员" onClose={() => {}} />);
    const joinBox = await screen.findByRole('checkbox', { name: /加入当前工作空间/ });
    fireEvent.click(joinBox); // 取消勾选
    expect(screen.queryByRole('checkbox', { name: /设为默认会话 agent/ })).not.toBeInTheDocument();
    pickModel('p1', 'm-1');
    fireEvent.click(screen.getByRole('button', { name: /启用$/ }));
    await waitFor(() => expect(ipc.agent.enablePreset).toHaveBeenCalledTimes(1));
    expect(ipc.agent.enablePreset).toHaveBeenCalledWith({
      slug: 'coder', modelProviderId: 'p1', modelName: 'm-1', thinkingJson: null,
    });
  });
});

describe('EnablePresetDialog — 编辑模式（配置）', () => {
  it('预填 def 模型；保存调用 updateDefinition（仅模型字段）', async () => {
    render(<EnablePresetDialog slug="coder" name="程序员" def={DEF} onClose={() => {}} />);
    // 编辑模式无加入 checkbox
    expect(screen.queryByRole('checkbox', { name: /加入当前工作空间/ })).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByRole('combobox')[0]).toHaveValue('p1'));
    pickModel('p1', 'm-1');
    fireEvent.click(screen.getByRole('button', { name: /保存$/ }));
    await waitFor(() => expect(ipc.agent.updateDefinition).toHaveBeenCalledTimes(1));
    expect(ipc.agent.updateDefinition).toHaveBeenCalledWith({
      id: 'builtin-coder', modelProviderId: 'p1', modelName: 'm-1', thinkingJson: null,
    });
    expect(ipc.agent.enablePreset).not.toHaveBeenCalled();
  });
});

describe('EnablePresetDialog — 默认模型预填', () => {
  it('settings.defaultChatModel 存在 → 预填 provider+model', async () => {
    vi.mocked(ipc.settings.getGlobal).mockResolvedValue({
      defaultChatModel: { providerId: 'p1', modelId: 'm-1' },
    } as never);
    render(<EnablePresetDialog slug="coder" name="程序员" onClose={() => {}} />);
    await waitFor(() => expect(screen.getAllByRole('combobox')[0]).toHaveValue('p1'));
    await waitFor(() => expect(screen.getAllByRole('combobox')[1]).toHaveValue('m-1'));
  });
});
```

- [ ] **Step 2: 跑测试确认红**

```bash
cd renderer && npx pnpm@9.0.0 vitest run src/components/agent/EnablePresetDialog.test.tsx
```
预期：FAIL —— 组件模块不存在。

- [ ] **Step 3: 实现组件**

创建 `renderer/src/components/agent/EnablePresetDialog.tsx`：

```tsx
// renderer/src/components/agent/EnablePresetDialog.tsx
//
// 预设 agent 启用 / 配置弹窗（spec 2026-09-22 资源库预设 agent 启用与 LLM 配置）。
//
// 两种模式：
//   - enable（def 未传）：启用即配——enablePreset IPC 一步完成 def 入库 + 模型写入
//     +（可选）加入当前工作空间 + 设为默认会话 agent；两个 checkbox 仅此模式渲染
//   - edit（def 传入）：配置——updateDefinition 只写模型字段（MemberEditDialog
//     模型区同模式）；保存后若当前 ws 有运行中成员 → pendingRestart 提示态
//
// 预填链：edit 从 def；enable 从全局默认模型 defaultChatModel（供应商仍存在时），
// 其次按 builtinSuggestions 的 suggestedPlatform 预选首个匹配平台的供应商。
import { useEffect, useState, type FormEvent } from 'react';
import { ipc } from '../../ipc/client';
import { useAgentStore } from '../../stores/agent.store';
import { useWorkspaceStore } from '../../stores/workspace.store';
import { useProviderStore } from '../../stores/provider.store';
import { Button } from '../ui/Button';
import { Checkbox } from '../ui/Checkbox';
import { Dialog } from '../ui/Dialog';
import { ProviderModelPicker } from './ProviderModelPicker';
import { ThinkingOverrideControl } from './ThinkingOverrideControl';
import type {
  AgentDefinition,
  ReasoningCapability,
  ThinkingConfig,
  WorkspaceAgentMember,
} from '../../ipc/types';

interface Props {
  /** 预设 slug（enable 模式必填；edit 模式用于 suggestions 平台预选） */
  slug: string;
  /** 展示名（标题） */
  name: string;
  /** 编辑模式传入已启用 def；undefined = 启用模式 */
  def?: AgentDefinition;
  onClose: () => void;
}

export function EnablePresetDialog({ slug, name, def, onClose }: Props) {
  const isEdit = def !== undefined;
  const workspace = useWorkspaceStore((s) => s.getActive());
  const providers = useProviderStore((s) => s.providers);
  const loadProviders = useProviderStore((s) => s.loadProviders);
  const members = useAgentStore((s) => s.members);
  const loadMembers = useAgentStore((s) => s.loadMembers);
  const builtinSuggestions = useAgentStore((s) => s.builtinSuggestions);
  const stopMember = useAgentStore((s) => s.stopMember);
  const startMember = useAgentStore((s) => s.startMember);

  const [providerId, setProviderId] = useState(def?.modelProviderId ?? '');
  const [modelName, setModelName] = useState(def?.modelName ?? '');
  const [modelCapability, setModelCapability] = useState<ReasoningCapability | null>(null);
  const [thinkingJson, setThinkingJson] = useState<ThinkingConfig | null>(def?.thinkingJson ?? null);
  const [join, setJoin] = useState(true);
  const [setAsDefault, setSetAsDefault] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // 保存成功 + 当前 ws 有运行中成员（仅 edit 模式）→ 「待重启」提示态
  const [pendingRestartMember, setPendingRestartMember] = useState<WorkspaceAgentMember | null>(null);

  useEffect(() => {
    void loadProviders();
  }, [loadProviders]);

  // 编辑模式：拉当前 ws 成员（保存后判定 pendingRestart 用）
  useEffect(() => {
    if (isEdit && workspace) void loadMembers(workspace.id);
  }, [isEdit, workspace, loadMembers]);

  // 启用模式预填①：全局默认模型（供应商仍存在）
  useEffect(() => {
    if (isEdit) return;
    let cancelled = false;
    void (async () => {
      try {
        const g = await ipc.settings.getGlobal();
        if (cancelled) return;
        const ref = g.defaultChatModel;
        if (ref && ref.providerId && ref.modelId) {
          setProviderId(ref.providerId);
          setModelName(ref.modelId);
        }
      } catch {
        // 预填失败静默——用户手选
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isEdit]);

  // 启用模式预填②：defaultChatModel 未命中时，按 suggestedPlatform 预选首个匹配供应商
  useEffect(() => {
    if (isEdit || providerId) return;
    const suggestion = builtinSuggestions[`builtin-${slug}`];
    if (!suggestion?.suggestedPlatform) return;
    const hit = providers.find((p) => p.platform === suggestion.suggestedPlatform);
    if (hit) setProviderId(hit.id);
  }, [isEdit, providerId, providers, builtinSuggestions, slug]);

  const handleSubmit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (!providerId || !modelName.trim()) {
      setError('请选择模型供应商与模型');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (!isEdit) {
        await ipc.agent.enablePreset({
          slug,
          modelProviderId: providerId,
          modelName: modelName.trim(),
          thinkingJson,
          ...(join && workspace ? { joinWorkspaceId: workspace.id, setAsDefault } : {}),
        });
        onClose();
      } else {
        await ipc.agent.updateDefinition({
          id: def.id,
          modelProviderId: providerId,
          modelName: modelName.trim(),
          thinkingJson,
        });
        const running = members.find(
          (m) => m.agentDefinitionId === def.id && m.lastRunning,
        );
        if (running) {
          setPendingRestartMember(running);
        } else {
          onClose();
        }
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const handleRestartNow = async (): Promise<void> => {
    if (!pendingRestartMember) return;
    setSaving(true);
    setError(null);
    try {
      await stopMember(pendingRestartMember.instanceId);
      await startMember(pendingRestartMember, pendingRestartMember.workspaceId);
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  // 待重启态吞掉 Esc / 遮罩关闭（MemberEditDialog 同模式，防误关重启提示）
  const handleDialogClose = pendingRestartMember ? () => undefined : onClose;

  return (
    <Dialog
      open
      onClose={handleDialogClose}
      title={isEdit ? `配置 Agent：${def.iconEmoji} ${def.name}` : `启用预设 Agent：${name}`}
      width={448}
    >
      <form onSubmit={handleSubmit} className="flex flex-col gap-3">
        {!isEdit && (
          <div className="text-xs text-tertiary">
            启用将把预设写入全局定义并配置模型；勾选加入后立即可在会话中使用。
          </div>
        )}

        <ProviderModelPicker
          providerId={providerId}
          modelId={modelName}
          onProviderChange={setProviderId}
          onModelChange={(id) => {
            setModelName(id);
            // 换模型即重置覆盖，防旧模型档位残留（含换供应商联动清空）
            setThinkingJson(null);
          }}
          onModelInfo={(m) => setModelCapability(m?.reasoning ?? null)}
        />
        <ThinkingOverrideControl
          capability={modelCapability}
          value={thinkingJson}
          onChange={setThinkingJson}
        />

        {!isEdit && (
          <div className="border-t border-subtle pt-3 flex flex-col gap-2">
            <Checkbox
              label="加入当前工作空间"
              checked={!!workspace && join}
              disabled={!workspace}
              onChange={(e) => setJoin(e.target.checked)}
            />
            {!workspace && (
              <div className="text-xs text-tertiary ml-6">无激活工作空间——仅启用全局定义</div>
            )}
            {join && workspace && (
              <Checkbox
                label="设为默认会话 agent"
                checked={setAsDefault}
                onChange={(e) => setSetAsDefault(e.target.checked)}
              />
            )}
          </div>
        )}

        {error && <div className="text-status-error text-sm">{error}</div>}
        <div className="flex gap-2 justify-end">
          <Button variant="ghost" type="button" onClick={onClose} disabled={saving}>
            取消
          </Button>
          <Button type="submit" disabled={saving}>
            {saving ? '保存中…' : isEdit ? '保存' : '启用'}
          </Button>
        </div>

        {pendingRestartMember && (
          <div className="border-t border-subtle pt-3 flex flex-col gap-2">
            <div className="text-sm text-secondary">
              已保存。该 agent 正在运行，<span className="text-accent-600 dark:text-accent-300">需重启</span>才能生效。
            </div>
            <div className="flex gap-2 justify-end">
              <Button variant="ghost" type="button" onClick={onClose} disabled={saving}>
                稍后
              </Button>
              <Button type="button" onClick={() => void handleRestartNow()} disabled={saving}>
                {saving ? '重启中…' : '立即重启'}
              </Button>
            </div>
          </div>
        )}
      </form>
    </Dialog>
  );
}
```

- [ ] **Step 4: 跑测试确认绿**

```bash
cd renderer && npx pnpm@9.0.0 vitest run src/components/agent/EnablePresetDialog.test.tsx
```
预期：PASS。若 Checkbox 的可访问名与断言不符（label 关联方式差异），按 `Checkbox` 组件实际渲染调整查询（`aria-label` / label 文本），不改组件行为。

- [ ] **Step 5: Commit**

```bash
git add renderer/src/components/agent/EnablePresetDialog.tsx renderer/src/components/agent/EnablePresetDialog.test.tsx
git commit -m "feat: EnablePresetDialog 启用/配置弹窗（启用即配 + 加入 ws + 重启提示）"
```

---

### Task 5: 资源库入口 — ResourceDetail 三态按钮 + View 接线

**Files:**
- Modify: `renderer/src/components/resource-library/ResourceDetail.tsx`（Props 加 `onEnable`/`onConfigure`；按钮区三态）
- Modify: `renderer/src/components/resource-library/ResourceLibraryView.tsx`（`presetTarget` state + `openPresetDialog` + 弹窗渲染）
- Test: `renderer/src/components/resource-library/ResourceDetail.test.tsx`（适配 + 新用例）

**Interfaces:**
- Consumes: Task 3 的 `ResourceItem.builtin.agentEnabled`；Task 4 的 `<EnablePresetDialog>`；既有 `ipc.agent.list()`、`useAgentStore`
- Produces: `ResourceDetail` Props 新增 `onEnable?: (id: string) => void` / `onConfigure?: (id: string) => void`

- [ ] **Step 1: 写失败测试（先改 ResourceDetail.test.tsx，再补 View 级用例）**

**1a. `ResourceDetail.test.tsx`** —— 「builtin (removable=false): 不显示删除按钮」用例（170-177 行）的基线 item 是 builtin agent——适配后 builtin agent 不再渲染「已安装」静态标记，改为「启用」按钮。将该用例改为非 agent 的 builtin 项（保留已安装标记语义），并新增三态用例：

```tsx
  it('builtin mcp (removable=false): 不显示删除按钮，保留「已安装」静态标记', () => {
    const onDelete = vi.fn();
    const item = baseItem({ id: 'builtin-mcp-foo', type: 'mcp', removable: false });
    render(<ResourceDetail item={item} onClose={() => {}} onDelete={onDelete} />);
    expect(screen.getByText(/已安装/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /删除/ })).not.toBeInTheDocument();
  });
```

文件尾部新增 describe：

```tsx
describe('ResourceDetail - 预设 agent 启用/配置（spec 2026-09-22）', () => {
  it('builtin agent 未启用：显示「启用」按钮并触发 onEnable', () => {
    const onEnable = vi.fn();
    const item = baseItem({ builtin: { agentEnabled: false } });
    render(<ResourceDetail item={item} onClose={() => {}} onEnable={onEnable} />);
    fireEvent.click(screen.getByRole('button', { name: '启用' }));
    expect(onEnable).toHaveBeenCalledWith('builtin-agent-pm');
    // 未启用不再显示误导性的「已安装」标记
    expect(screen.queryByText(/已安装/)).not.toBeInTheDocument();
  });

  it('builtin agent 已启用：显示「配置」按钮 + 「已启用」标记，无「启用」', () => {
    const onConfigure = vi.fn();
    const item = baseItem({ builtin: { agentEnabled: true } });
    render(<ResourceDetail item={item} onClose={() => {}} onConfigure={onConfigure} />);
    expect(screen.getByText(/已启用/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '配置' }));
    expect(onConfigure).toHaveBeenCalledWith('builtin-agent-pm');
    expect(screen.queryByRole('button', { name: '启用' })).not.toBeInTheDocument();
  });

  it('marketplace agent 已安装：显示「配置」按钮', () => {
    const onConfigure = vi.fn();
    const item = baseItem({
      id: 'marketplace-agent-coder', source: 'marketplace', installed: true,
      installable: false, removable: true,
    });
    render(<ResourceDetail item={item} onClose={() => {}} onConfigure={onConfigure} />);
    fireEvent.click(screen.getByRole('button', { name: '配置' }));
    expect(onConfigure).toHaveBeenCalledWith('marketplace-agent-coder');
  });

  it('marketplace agent 未安装：无「配置」按钮（先安装）', () => {
    const item = baseItem({
      id: 'marketplace-agent-coder', source: 'marketplace', installed: false,
      installable: true,
    });
    render(<ResourceDetail item={item} onClose={() => {}} onConfigure={vi.fn()} />);
    expect(screen.queryByRole('button', { name: '配置' })).not.toBeInTheDocument();
  });
});
```

**1b. `ResourceLibraryView.test.tsx`** —— mockApi 桩补两个方法（EnablePresetDialog 挂载需要）+ 新增启用路径的 View 级用例。

mockApi 相关改动（该文件 `window.api` 桩模式）：

```ts
// 桩声明区（agentListDefinitions 等之后）追加：
const settingsGetGlobal = vi.fn();
const agentListMembers = vi.fn();

// mockApi 对象追加 settings 命名空间；agent 段追加 listMembers：
const mockApi = {
  // ...既有各段不动...
  settings: {
    getGlobal: settingsGetGlobal,
  },
  agent: {
    list: agentListDefinitions,
    createCustom: agentCreateCustom,
    updateDefinition: agentUpdateDefinition,
    listMembers: agentListMembers,
  },
};

// beforeEach 的重置数组追加 settingsGetGlobal / agentListMembers；
// 默认返回值追加：
  settingsGetGlobal.mockResolvedValue({});
  agentListMembers.mockResolvedValue([]);
```

文件尾部新增 describe（沿用本文件既有 fixture 模式）：

```tsx
describe('ResourceLibraryView — 预设 agent 启用入口（spec 2026-09-22）', () => {
  it('builtin agent 未启用：详情点「启用」→ 弹「启用预设 Agent」对话框（enable 模式）', async () => {
    resourceList.mockResolvedValue([
      baseItem({
        slug: 'coder',
        name: '程序员',
        builtin: { agentEnabled: false },
      }),
    ]);
    agentListDefinitions.mockResolvedValue([]);

    render(<ResourceLibraryView />);
    await waitFor(() => expect(screen.getByText('程序员')).toBeInTheDocument());

    fireEvent.click(screen.getByText('程序员'));
    await waitFor(() => {
      expect(screen.getAllByText('程序员').length).toBeGreaterThanOrEqual(2);
    });
    fireEvent.click(screen.getByRole('button', { name: '启用' }));

    await waitFor(() => {
      expect(screen.getByText(/启用预设 Agent/)).toBeInTheDocument();
    });
  });

  it('builtin agent 已启用：详情点「配置」→ 弹「配置 Agent」对话框（edit 模式）', async () => {
    resourceList.mockResolvedValue([
      baseItem({
        slug: 'coder',
        name: '程序员',
        builtin: { agentEnabled: true },
      }),
    ]);
    agentListDefinitions.mockResolvedValue([
      {
        id: 'builtin-coder', name: '程序员', slug: 'coder', version: '1.0.0',
        runtime: 'declarative', systemPrompt: 'p', defaultTools: [], source: 'builtin',
        description: '', iconEmoji: '💻', defaultMcps: [], defaultSkills: [],
        workspaceId: null, modelProviderId: 'p1', modelName: 'gpt-4o',
      },
    ]);

    render(<ResourceLibraryView />);
    await waitFor(() => expect(screen.getByText('程序员')).toBeInTheDocument());

    fireEvent.click(screen.getByText('程序员'));
    await waitFor(() => {
      expect(screen.getAllByText('程序员').length).toBeGreaterThanOrEqual(2);
    });
    fireEvent.click(screen.getByRole('button', { name: '配置' }));

    await waitFor(() => {
      expect(screen.getByText(/配置 Agent/)).toBeInTheDocument();
    });
  });
});
```

- [ ] **Step 2: 跑测试确认红**

```bash
cd renderer && npx pnpm@9.0.0 vitest run src/components/resource-library/ResourceDetail.test.tsx
```
预期：新用例 FAIL（无「启用」/「配置」按钮）；原「builtin (removable=false)」用例已按 Step 1 改为 mcp 基线。

- [ ] **Step 3: 实现 ResourceDetail**

3a. import 行加 `Settings2`：`import { Bot, Check, Package, Pencil, Puzzle, Settings2, Trash2, X } from 'lucide-react';`

3b. Props 接口加：

```tsx
  /** builtin agent 未启用 → 弹启用表单（spec 2026-09-22） */
  onEnable?: (id: string) => void;
  /** builtin 已启用 / marketplace 已安装 agent → 弹配置表单 */
  onConfigure?: (id: string) => void;
```

函数签名解构加 `onEnable, onConfigure`。

3c. 底部按钮区（`<div className="px-4 py-3 border-t border-subtle flex gap-2">`）改为：

```tsx
      <div className="px-4 py-3 border-t border-subtle flex gap-2">
        {/* 安装按钮：仅 installable 且未安装时显示（p2p 源文案为「导入」） */}
        {item.installable && !item.installed && onInstall && (
          <Button size="sm" onClick={() => onInstall(item.id)}>
            {item.source === 'p2p' ? '导入' : '安装'}
          </Button>
        )}
        {/* 编辑按钮：仅 custom agent（installed）显示——挂载 DefinitionEditor 编辑定义 */}
        {item.type === 'agent' && item.source === 'custom' && item.installed && onEdit && (
          <Button
            size="sm"
            onClick={() => onEdit(item.id)}
            className="inline-flex items-center gap-1"
          >
            <Pencil size={12} strokeWidth={1.75} aria-hidden />
            编辑
          </Button>
        )}
        {/* 启用按钮：builtin agent 未启用（def 不在库）——落库 + 配模型一步完成（spec 2026-09-22） */}
        {item.type === 'agent' && item.source === 'builtin' && !item.builtin?.agentEnabled && onEnable && (
          <Button size="sm" onClick={() => onEnable(item.id)}>
            启用
          </Button>
        )}
        {/* 配置按钮：builtin 已启用 / marketplace 已安装（def 已落库，可改模型） */}
        {item.type === 'agent' && onConfigure &&
          ((item.source === 'builtin' && item.builtin?.agentEnabled) ||
            (item.source === 'marketplace' && item.installed)) && (
          <Button
            size="sm"
            onClick={() => onConfigure(item.id)}
            className="inline-flex items-center gap-1"
          >
            <Settings2 size={12} strokeWidth={1.75} aria-hidden />
            配置
          </Button>
        )}
        {/* 删除按钮：仅 installed 且 removable 时显示（custom 上传项） */}
        {item.installed && item.removable && onDelete && (
          <Button
            size="sm"
            variant="danger"
            onClick={() => onDelete(item.id)}
            className="inline-flex items-center gap-1"
          >
            <Trash2 size={12} strokeWidth={1.75} aria-hidden />
            删除
          </Button>
        )}
        {/* 已启用标记：builtin agent def 已在库（区别于「已安装」的随应用分发语义） */}
        {item.type === 'agent' && item.source === 'builtin' && item.builtin?.agentEnabled && (
          <span className="inline-flex items-center gap-1 text-xs text-status-success self-center">
            <Check size={12} strokeWidth={1.75} aria-hidden />
            已启用
          </span>
        )}
        {/* 已安装静态标记：installed 且不可删除（builtin 非 agent 项）时显示 */}
        {item.installed && !item.removable && !(item.type === 'agent' && item.source === 'builtin') && (
          <span className="inline-flex items-center gap-1 text-xs text-status-success self-center">
            <Check size={12} strokeWidth={1.75} aria-hidden />
            已安装
          </span>
        )}
      </div>
```

同时更新文件头注释（第 10-15 行按钮区说明）追加两行：

```tsx
//   - builtin agent 未启用            → 「启用」按钮（onEnable；spec 2026-09-22）
//   - builtin 已启用 / marketplace 装 → 「配置」按钮（onConfigure）+ builtin「已启用」标记
```

- [ ] **Step 4: ResourceLibraryView 接线**

4a. import 区加：

```tsx
import { useAgentStore } from '../../stores/agent.store';
import { useWorkspaceStore } from '../../stores/workspace.store';
import { EnablePresetDialog } from '../agent/EnablePresetDialog';
```

4b. 组件体内（`editingDef` state 之后）加：

```tsx
  // 预设 agent 启用/配置弹窗目标（def 缺省 = 启用模式；已启用/marketplace = 配置模式）
  const [presetTarget, setPresetTarget] = useState<{
    slug: string;
    name: string;
    def?: AgentDefinition;
  } | null>(null);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const loadDefinitions = useAgentStore((s) => s.loadDefinitions);
  const loadMembers = useAgentStore((s) => s.loadMembers);
```

4c. `handleEditAgent` 之后加：

```tsx
  // 预设 agent 打开启用/配置弹窗：按 slug 查全局定义——查到 = 配置模式（def 传入），
  // 查不到 = 启用模式（enablePreset 落库）。slug 口径与 catalog-adapter 的
  // agentEnabled 计算、marketplace install 的 def 复用一致（同 slug 即同一预设）。
  const openPresetDialog = async (itemId: string): Promise<void> => {
    const item = items.find((i) => i.id === itemId);
    if (!item || item.type !== 'agent') return;
    try {
      const defs = await ipc.agent.list();
      const def = defs.find((d) => d.slug === item.slug);
      setPresetTarget({ slug: item.slug, name: item.name, def });
    } catch (err) {
      console.error('打开预设 agent 配置失败', {
        itemId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  // 弹窗关闭：刷新资源列表（agentEnabled 态）+ agent store（definitions/members）
  const closePresetDialog = (): void => {
    setPresetTarget(null);
    void load();
    void loadDefinitions(activeWorkspaceId ?? undefined);
    if (activeWorkspaceId) void loadMembers(activeWorkspaceId);
  };
```

4d. `<ResourceDetail>`（238-246 行）Props 追加：

```tsx
          onEnable={openPresetDialog}
          onConfigure={openPresetDialog}
```

4e. `{editingDef && ...}` 块之后加：

```tsx
      {presetTarget && (
        <EnablePresetDialog
          slug={presetTarget.slug}
          name={presetTarget.name}
          def={presetTarget.def}
          onClose={closePresetDialog}
        />
      )}
```

- [ ] **Step 5: 跑测试确认绿 + 邻近回归**

```bash
cd renderer && npx pnpm@9.0.0 vitest run src/components/resource-library/ResourceDetail.test.tsx src/components/resource-library/ResourceLibraryView.test.tsx
```
预期：PASS。`ResourceLibraryView.test.tsx` 若有断言 builtin agent 详情「已安装」的用例，按新三态语义适配（未启用 → 「启用」按钮）。

- [ ] **Step 6: Commit**

```bash
git add renderer/src/components/resource-library/ResourceDetail.tsx renderer/src/components/resource-library/ResourceLibraryView.tsx renderer/src/components/resource-library/ResourceDetail.test.tsx
git commit -m "feat: 资源库预设 agent 启用/配置入口（详情面板三态按钮 + EnablePresetDialog 接线）"
```

---

### Task 6: marketplace 安装后配置引导

**Files:**
- Modify: `renderer/src/stores/resource.store.ts:91-104`（`installResource` 返回 `Promise<boolean>`）
- Modify: `renderer/src/components/resource-library/ResourceLibraryView.tsx`（`handleInstall` 包装两处 `onInstall`）
- Test: `renderer/src/stores/resource.store.test.ts`（返回值契约）；`renderer/src/components/resource-library/ResourceLibraryView.test.tsx`（引导触发用例）

**Interfaces:**
- Consumes: Task 5 的 `openPresetDialog`；既有 `installResource`
- Produces: `installResource(id): Promise<boolean>`（true=安装成功；false=失败，错误已在 store.error）

- [ ] **Step 1: 写失败测试**

`renderer/src/stores/resource.store.test.ts` 的 `describe('resource.store — install 反馈闭环')` 内追加（直接用本文件既有的 `resourceInstall` 桩）：

```ts
  it('installResource 返回成功布尔值（true=成功；false=失败且 error 落位）——安装引导依据', async () => {
    resourceInstall.mockResolvedValue(undefined);
    const ok1 = await useResourceStore.getState().installResource('marketplace-agent-coder');
    expect(ok1).toBe(true);
    expect(useResourceStore.getState().error).toBeNull();

    resourceInstall.mockRejectedValueOnce(new Error('网络超时'));
    const ok2 = await useResourceStore.getState().installResource('marketplace-agent-coder');
    expect(ok2).toBe(false);
    expect(useResourceStore.getState().error).toContain('网络超时');
  });
```

`renderer/src/components/resource-library/ResourceLibraryView.test.tsx` 文件尾部追加（fixture 用本文件 `baseItem` / `window.api` 桩；settings/listMembers 桩已由 Task 5 补入）：

```tsx
describe('ResourceLibraryView — marketplace 安装后配置引导（spec §7）', () => {
  it('marketplace agent 安装成功 → 自动弹「配置 Agent」引导', async () => {
    resourceList.mockResolvedValue([
      baseItem({
        id: 'marketplace-agent-coder',
        source: 'marketplace',
        slug: 'coder',
        name: '程序员',
        description: '写代码',
        installed: false,
        installable: true,
        removable: false,
      }),
    ]);
    resourceInstall.mockResolvedValue(undefined);
    agentListDefinitions.mockResolvedValue([
      {
        id: 'def-mkt-coder', name: '程序员', slug: 'coder', version: '1.0.0',
        runtime: 'declarative', systemPrompt: 'p', defaultTools: [], source: 'marketplace',
        description: '', iconEmoji: '💻', defaultMcps: [], defaultSkills: [],
        workspaceId: null, modelProviderId: null, modelName: 'claude-3-5-sonnet',
      },
    ]);

    render(<ResourceLibraryView />);
    await waitFor(() => expect(screen.getByText('程序员')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: '安装' }));

    // 安装成功 → 查全局定义（同 slug）→ 弹「配置 Agent」对话框（edit 模式）
    await waitFor(() => {
      expect(screen.getByText(/配置 Agent/)).toBeInTheDocument();
    });
  });

  it('marketplace agent 安装失败 → 不弹引导，错误横幅照常（ok=false 短路）', async () => {
    resourceList.mockResolvedValue([
      baseItem({
        id: 'marketplace-agent-gone', source: 'marketplace', slug: 'gone',
        name: '离线市场项', description: '不可达', installed: false,
        installable: true, removable: false,
      }),
    ]);
    resourceInstall.mockRejectedValueOnce(new Error('下载超时'));

    render(<ResourceLibraryView />);
    await waitFor(() => expect(screen.getByText('离线市场项')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: '安装' }));

    await waitFor(() => {
      expect(screen.getByText(/导入失败/)).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.queryByText(/配置 Agent/)).not.toBeInTheDocument();
    });
  });
});
```

- [ ] **Step 2: 跑测试确认红**

```bash
cd renderer && npx pnpm@9.0.0 vitest run src/stores/resource.store.test.ts src/components/resource-library/ResourceLibraryView.test.tsx
```
预期：新用例 FAIL（返回值 undefined / 无引导弹窗）。

- [ ] **Step 3: 实现**

3a. `resource.store.ts`：接口签名 `installResource: (id: string) => Promise<boolean>;` 实现 `catch` 分支末尾加 `return false;`、成功分支末尾加 `return true;`，并更新方法上方注释（"返回是否成功（false 时错误在 error 字段）——marketplace agent 安装引导据此触发"）。

3b. `ResourceLibraryView.tsx`：`openPresetDialog` 之后加：

```tsx
  // 安装包装（spec §7 marketplace 同修）：成功且是 marketplace agent → 弹配置引导
  // （def 刚落库 modelProviderId=NULL，引导一步配模型；取消亦可稍后从「配置」按钮再配）
  const handleInstall = async (itemId: string): Promise<void> => {
    const item = items.find((i) => i.id === itemId);
    const ok = await installResource(itemId);
    if (ok && item?.type === 'agent' && item.source === 'marketplace') {
      await openPresetDialog(itemId);
    }
  };
```

`<ResourceCard onInstall={installResource}>`（228 行）与 `<ResourceDetail onInstall={installResource}>`（242 行）均改为 `onInstall={handleInstall}`。

- [ ] **Step 4: 跑测试确认绿**

```bash
cd renderer && npx pnpm@9.0.0 vitest run src/stores/resource.store.test.ts src/components/resource-library/ResourceLibraryView.test.tsx
```
预期：PASS。

- [ ] **Step 5: Commit**

```bash
git add renderer/src/stores/resource.store.ts renderer/src/components/resource-library/ResourceLibraryView.tsx renderer/src/stores/resource.store.test.ts renderer/src/components/resource-library/ResourceLibraryView.test.tsx
git commit -m "feat: marketplace agent 安装后配置引导（installResource 布尔返回 + 安装即弹配置）"
```

---

### Task 7: 启动接线 + 全量回归收口

**Files:**
- Modify: `electron/src/main/index.ts`（`runMigrations()` 后加一行）

**Interfaces:**
- Consumes: Task 1 的 `loadBuiltinSuggestionsOnly`

- [ ] **Step 1: 启动接线**

`electron/src/main/index.ts`：import 区加 `import { loadBuiltinSuggestionsOnly } from './agent/builtin';`；`runMigrations();`（73 行）之后加：

```ts
// v2.1 预设 agent 启用链路（spec 2026-09-22）：启动只填 suggestions Map（平台
// 预选用），不落 agent_definitions——def 行仅在用户于资源库点「启用」时写入。
loadBuiltinSuggestionsOnly();
```

- [ ] **Step 2: 全量验证**

```bash
nvm use 20
npx pnpm@9.0.0 typecheck
npx pnpm@9.0.0 test
```
预期：typecheck 0 error；两 workspace 全部测试 PASS。任何与本链路无关的既有失败：记录并单独上报，不在本任务修（不扩 scope）。

- [ ] **Step 3: spec 验收核对（对照 `docs/specs/2026-09-22-resource-preset-agent-enable-design.md` §10）**

逐条核对是否可由本计划交付物推导满足：
1. 资源库「系统预置」agent：启用 → 选模型 → 勾选加入 → `AddAgentDialog`/协作会话可选、设默认后快速会话直达（Task 1/2/4/5 链路）
2. 启用后 spawn 不再报「未配置 modelProviderId」（enablePreset 写入 + addMember 守卫通过）
3. 「配置」按钮改模型/思维 + 运行中成员重启提示（Task 4 edit 模式）
4. marketplace 安装后自动弹配置引导 + 详情面板常驻「配置」（Task 5/6）
5. 重启后启用状态持久（DB 为准——saveAgentDefinition 落库）
6. typecheck + 全量测试通过（Step 2）

GUI 级端到端验收（真机 `pnpm dev` 走一遍启用→会话对话）留给用户主机验收——容器内无 GUI。

- [ ] **Step 4: Commit**

```bash
git add electron/src/main/index.ts
git commit -m "feat: 启动轻量加载 builtin suggestions（不落库，预选数据开箱可用）"
```

---

## 任务依赖

Task 1 → Task 2 → Task 4（契约链）；Task 3 独立（可与 Task 2 并行）；Task 5 依赖 Task 3+4；Task 6 依赖 Task 5；Task 7 收尾。串行执行顺序 1→7 即可。
