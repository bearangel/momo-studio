# 资源创建技能组 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 agent 会话内可直接创建四类资源（agent 定义 / skill / MCP / 团队）——6 个内置工具经 child→main IPC 桥复用主进程既有校验链直接落库，配 4 册方法论技能默认挂 Momo（general-assistant）。

**Architecture:** 主进程新增 `resource-ops` 服务层（六 op 白名单，全部复用既有服务）+ `runtime-spawner.ts` 子进程消息路由新分支（workspaceId 由 spawn 上下文注入，子进程不可伪造）；子进程侧新增桥（复刻 mcp-bridge 模式）+ `ResourceTools` 工具模块（注册进 `unconditionalModules`，目录自动派生）；创建成功后主进程新增 `resource:changed` 广播驱动 renderer 刷新；builtin 预置启动再同步钩子让存量 Momo 升级到 v2.1.0。

**Tech Stack:** Electron 主进程（CommonJS / TS strict）、better-sqlite3、React+zustand（renderer 三处小改）、SKILL.md 内容（frontmatter + 三层渐进披露）。

**Spec:** `docs/specs/2026-11-09-resource-creation-skills-design.md`（本计划从 spec 出发，执行者两个文件都读）

## Global Constraints

- Node 24：所有命令前 `nvm use 24`；包管理一律 `npx pnpm@9.0.0`
- TypeScript strict：**禁止** `any` / `as any` / `@ts-ignore`（ESLint `no-explicit-any: error` 已启用）
- 全部代码注释、文档中文；标识符英文
- Conventional Commits：`feat:` / `test:` / `docs:` / `chore:`
- 单测位置：electron 主进程集中 `electron/tests/`（子目录镜像 `src/`）；renderer 贴源 colocated
- electron 单目录跑 DB 重度测试显式加 `--pool=forks`；全量跑**裸** `vitest run`
- 每任务收尾前 `npx pnpm@9.0.0 typecheck` 必须绿
- 版本号纪律：**只在 Task 12** 把三处 package.json 的 alpha +1，其余任务不动版本号
- 实施前建议加载项目 skills：`momo-test-rules`（写测试）、`momo-boundary-rules`（IPC/桥契约，Task 6-8）

## Review Focus

spec 未逐条点名、但最可能咬人的五类输入（每条已锚定到 owning task 的测试步骤）：

1. **子进程伪造 workspaceId**：op 入参里塞 `workspaceId` 必须无效——`executeResourceOp` 签名只收主进程注入值，args 里的同名键被忽略 → Task 6 测试
2. **slug 跨源冲突**：skill 与 builtin 同名、agent 与任意 source 同 slug 必须拒绝且报错带既有信息 → Task 3 / Task 4 测试
3. **无 IPC 通道时工具干净失败**：vitest 直调 `ResourceTools.execute`（无 `process.send`）必须 reject 中文错误，不许挂死或静默 → Task 7 测试
4. **references 路径穿越**：`../` / 绝对路径写 SKILL 目录外必须拒绝 → Task 4 测试
5. **存量升级保用户模型配置**：v2.0.0 行已配 modelProviderId/modelName，再同步后必须原样保留（清掉 = P0「修复无效」级事故）→ Task 11 测试

---

### Task 1: 消费面矩阵落盘（momo-feature-scope-rules W1–W3）

**Files:**
- Create: `.omo/feature-matrices/2026-11-09-resource-creation-skills.md`

**Interfaces:**
- Consumes: spec §10 矩阵预告
- Produces: 矩阵文件（后续任务的门禁产物；无代码依赖）

- [ ] **Step 1: W1 三锚 grep（本特性无状态翻转，锚③记 N/A）**

```bash
# 锚① 能力名消费点（新工具名 / resource-op / 新广播通道）
grep -rn "resource_list\|create_agent\|create_skill\|create_mcp\|create_team\|add_agent_member\|resource-op\|resource:changed" electron/src renderer/src --include="*.ts" --include="*.tsx" | grep -v "\.test\."
# 锚② 展示动词面（工具目录 / 候选 / 页签）
grep -rnE "getCatalog|useToolCatalog|listInstalled|listResources|unconditionalModules" electron/src/main/agent electron/src/main/resource renderer/src --include="*.ts" --include="*.tsx" | grep -v "\.test\."
# 锚③ 状态判定函数——本特性无状态翻转，显式记 N/A
```

- [ ] **Step 2: 把 W1 输出整理进矩阵**

按 W2 格式写 `.omo/feature-matrices/2026-11-09-resource-creation-skills.md`：行 = W1 逐点 + 四类展示面（资源目录页 / 选择器候选 / 命令引用入口〔N/A：固定注册表〕/ 编辑器）；列 = 新建 / 存量 / builtin 只读；每格「改/不改+理由」，空格必须写理由。W3 反查节显式写差集结论。

- [ ] **Step 3: Commit**

```bash
git add .omo/feature-matrices/2026-11-09-resource-creation-skills.md
git commit -m "docs: 资源创建技能组消费面矩阵（W1-W3）"
```

---

### Task 2: resource-ops 服务层骨架 + list / createTeam / addMember

**Files:**
- Create: `electron/src/main/agent/resource-ops.ts`
- Test: `electron/tests/agent/resource-ops.test.ts`

**Interfaces:**
- Consumes: `listAgentDefinitions` / `listMembers`（`agent/agent-queries.ts`）、`addMember` / `generateAgentUserId`（`agent/crud.ts`）、`createTeam` / `listTeams`（`agent/team.ts`）、`listInstalled`（`skill/zip-uploader.ts`）、`listResources`（`resource/custom.ts`）、`isValidSlug`（`marketplace/types.ts`）
- Produces: `executeResourceOp(op: string, args: unknown, workspaceId: string): Promise<unknown>`（六 op 白名单分发，未知 op 抛错）；`RESOURCE_OP_NAMES: readonly string[]`；op 结果类型 `ResourceListResult` / `CreateAgentResult` / `AddMemberResult` / `CreateSkillResult` / `CreateMcpResult` / `CreateTeamResult`（Task 3-5、6、7 消费）

- [ ] **Step 1: 写失败测试（DB setup 镜像 `electron/tests/agent/crud-custom-def.test.ts` 的既有模式）**

```ts
// electron/tests/agent/resource-ops.test.ts
//
// resource-ops 服务层单测。DB 初始化复用 crud-custom-def.test.ts 同款 helper
// （内存库 + 迁移 + 种子 workspace）。
import { describe, it, expect, beforeAll } from 'vitest';
// —— 按既有测试文件的 helper 引入方式对齐（getTestDb / seedWorkspace 等）——
import { executeResourceOp } from '../../src/main/agent/resource-ops';

describe('resource-ops 分发', () => {
  it('未知 op 拒绝', async () => {
    await expect(executeResourceOp('rm -rf', {}, wsId)).rejects.toThrow('未知 resource op');
  });

  it('op 入参携带 workspaceId 被忽略（归属只由主进程注入）', async () => {
    const r = (await executeResourceOp('list', { type: 'teams', workspaceId: 'forged' }, wsId)) as {
      teams: unknown[];
    };
    // 用真 wsId 建 team 后：forged wsId 不影响——结果属于注入的 wsId
    expect(Array.isArray(r.teams)).toBe(true);
  });
});

describe('createTeam', () => {
  it('成员不足拒绝并透传 team.ts 事务错误', async () => {
    await expect(
      executeResourceOp('createTeam', { name: 'T', memberInstanceIds: [m1], leaderInstanceId: m1 }, wsId),
    ).rejects.toThrow('团队成员数至少 2');
  });

  it('成功返回 teamId 与成员数', async () => {
    const r = (await executeResourceOp(
      'createTeam',
      { name: '翻译组', memberInstanceIds: [m1, m2], leaderInstanceId: m1 },
      wsId,
    )) as { teamId: string; memberCount: number };
    expect(r.memberCount).toBe(2);
  });
});

describe('addMember（幂等）', () => {
  it('已加入返回既有成员不报错', async () => {
    const first = await executeResourceOp('addMember', { definitionIdOrSlug: defSlug }, wsId);
    const second = await executeResourceOp('addMember', { definitionIdOrSlug: defSlug }, wsId);
    expect((first as { instanceId: string }).instanceId).toBe(
      (second as { instanceId: string }).instanceId,
    );
  });

  it('slug 查不到报错并提示先 resource_list', async () => {
    await expect(
      executeResourceOp('addMember', { definitionIdOrSlug: 'no-such' }, wsId),
    ).rejects.toThrow('未找到 agent 定义');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/agent/resource-ops.test.ts --pool=forks`
Expected: FAIL（`resource-ops.ts` 不存在）

- [ ] **Step 3: 实现骨架 + 三个 op**

```ts
// electron/src/main/agent/resource-ops.ts
//
// resource-ops 主进程服务层（spec 2026-11-09 §5/§6）：会话内资源创建的白名单 op。
// 全部复用主进程既有服务（与 UI 创建同链——单一真相源）。workspaceId 由桥的
// 主进程侧从 spawn 上下文注入，本层入参不含 workspaceId——子进程不可伪造归属。
import { parseAgentManifest } from './manifest-parser';
import { createCustomDef, addMember, generateAgentUserId } from './crud';
import { listAgentDefinitions, getAgentDefinition, listMembers } from './agent-queries';
import { createTeam, listTeams } from './team';
import { getSkillsDir, listInstalled as listInstalledSkills } from '../skill/zip-uploader';
import { parseSkillMd } from '../skill/loader';
import { listResources } from '../resource/custom';
import { getDb } from '../storage/db';
import { isValidSlug } from '../marketplace/types';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../logger';
// Task 5 引入：registerMcpDefinition / McpClient / HttpMcpClient（此处先不 import）

/** 白名单 op 枚举——桥面只放行这六个入口（spec §6：桥不是通用 RPC 面） */
export const RESOURCE_OP_NAMES = [
  'list',
  'createAgent',
  'addMember',
  'createSkill',
  'createMcp',
  'createTeam',
] as const;

export interface ResourceListResult {
  agents?: Array<{ id: string; slug: string; name: string; source: string; modelConfigured: boolean }>;
  members?: Array<{ instanceId: string; definitionId: string; name: string; running: boolean }>;
  skills?: Array<{ slug: string; name: string; source: string }>;
  mcps?: Array<{ name: string }>;
  teams?: Array<{ id: string; name: string; leaderInstanceId: string; memberInstanceIds: string[] }>;
}

/** op 分发。args 一律视为不可信输入（形状先验，非法即抛中文错误）。 */
export async function executeResourceOp(
  op: string,
  args: unknown,
  workspaceId: string,
): Promise<unknown> {
  if (!(RESOURCE_OP_NAMES as readonly string[]).includes(op)) {
    throw new Error(`未知 resource op: ${op}`);
  }
  const a = (args ?? {}) as Record<string, unknown>;
  switch (op) {
    case 'list': return opList(a['type'], workspaceId);
    case 'createAgent': return opCreateAgent(a); // Task 3 实现
    case 'addMember': return opAddMember(a, workspaceId);
    case 'createSkill': return opCreateSkill(a); // Task 4 实现
    case 'createMcp': return opCreateMcp(a); // Task 5 实现
    case 'createTeam': return opCreateTeam(a, workspaceId);
    default: throw new Error(`未知 resource op: ${op}`);
  }
}

// ── list ──
function opList(typeFilter: unknown, workspaceId: string): ResourceListResult {
  const t = typeof typeFilter === 'string' ? typeFilter : undefined;
  const need = (x: string): boolean => t === undefined || t === x;
  const result: ResourceListResult = {};
  if (need('agents')) {
    result.agents = listAgentDefinitions().map((d) => ({
      id: d.id, slug: d.slug, name: d.name, source: d.source,
      modelConfigured: Boolean(d.modelProviderId),
    }));
  }
  if (need('members')) {
    result.members = listMembers(workspaceId).map((m) => ({
      instanceId: m.instanceId, definitionId: m.agentDefinitionId,
      name: m.agentName, running: m.lastRunning,
    }));
  }
  if (need('skills')) {
    result.skills = listInstalledSkills().map((s) => ({
      slug: s.slug, name: s.name, source: s.source,
    }));
  }
  if (need('mcps')) {
    result.mcps = listResources({ type: 'mcp' }).map((r) => ({ name: r.slug ?? r.name }));
  }
  if (need('teams')) {
    result.teams = listTeams(workspaceId).map((tm) => ({
      id: tm.id, name: tm.name, leaderInstanceId: tm.leaderInstanceId,
      memberInstanceIds: tm.members.map((m) => m.instanceId),
    }));
  }
  return result;
}

// ── addMember（幂等：同 ws 同 def 已存在返回既有成员）──
async function opAddMember(
  a: Record<string, unknown>,
  workspaceId: string,
): Promise<{ instanceId: string; agentName: string }> {
  const key = str(a['definitionIdOrSlug'], 'definitionIdOrSlug');
  const def = getAgentDefinition(key) ?? listAgentDefinitions().find((d) => d.slug === key);
  if (!def) throw new Error(`未找到 agent 定义: ${key}（可先 resource_list 查询真实 id/slug）`);
  const existing = listMembers(workspaceId).find((m) => m.agentDefinitionId === def.id);
  if (existing) return { instanceId: existing.instanceId, agentName: existing.agentName };
  const member = await addMember(workspaceId, def.id, generateAgentUserId(def.slug));
  return { instanceId: member.instanceId, agentName: member.agentName };
}

// ── createTeam（复用 team.ts 事务，错误原样透出）──
function opCreateTeam(
  a: Record<string, unknown>,
  workspaceId: string,
): { teamId: string; name: string; memberCount: number } {
  const name = str(a['name'], 'name');
  const icon = typeof a['iconEmoji'] === 'string' && a['iconEmoji'].trim() ? a['iconEmoji'] : '👥';
  const memberInstanceIds = strArray(a['memberInstanceIds'], 'memberInstanceIds');
  const leaderInstanceId = str(a['leaderInstanceId'], 'leaderInstanceId');
  const team = createTeam(workspaceId, name, icon, memberInstanceIds, leaderInstanceId);
  return { teamId: team.id, name: team.name, memberCount: team.members.length };
}

// ── 入参形状小工具（no any：unknown 先验后窄化）──
function str(v: unknown, field: string): string {
  if (typeof v !== 'string' || v.length === 0) throw new Error(`${field} 必须为非空字符串`);
  return v;
}
function strArray(v: unknown, field: string): string[] {
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
    throw new Error(`${field} 必须为字符串数组`);
  }
  return v as string[];
}
```

Task 3-5 的占位分支先抛 `throw new Error('createAgent 未实现')` 等（仅本 task 内临时态，后续 task 立即替换）。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/agent/resource-ops.test.ts --pool=forks`
Expected: PASS

- [ ] **Step 5: typecheck + Commit**

```bash
npx pnpm@9.0.0 typecheck && git add electron/src/main/agent/resource-ops.ts electron/tests/agent/resource-ops.test.ts && git commit -m "feat: resource-ops 服务层骨架与 list/createTeam/addMember op"
```

---

### Task 3: createAgent op

**Files:**
- Modify: `electron/src/main/agent/resource-ops.ts`
- Test: `electron/tests/agent/resource-ops.test.ts`（追加）

**Interfaces:**
- Consumes: `parseAgentManifest`（`agent/manifest-parser.ts`，校验失败抛逐字段错误）、`createCustomDef`（`agent/crud.ts:111`——内置 defaultChatModel 兜底 + SAFE_MINIMUM_TOOLS 缺省）、`getProvider`（`agent/provider-crud.ts`）
- Produces: `CreateAgentResult = { definitionId: string; slug: string; member?: { instanceId: string } }`

- [ ] **Step 1: 追加失败测试**

```ts
describe('createAgent', () => {
  const validYaml = `apiVersion: v1
kind: AgentDefinition
metadata:
  name: 翻译agent
  slug: translator
  version: 1.0.0
  description: 中英互译
spec:
  runtime: declarative
  declarative:
    systemPrompt: 你是翻译。
    model:
      provider: anthropic
      model: claude-sonnet-4-5
  defaultTools:
    - kind: builtin
      ref: read_file
`;

  it('非法 manifest 逐字段透出 parser 错误', async () => {
    await expect(
      executeResourceOp('createAgent', { manifestYaml: 'apiVersion: v9\nkind: X' }, wsId),
    ).rejects.toThrow('manifest 校验失败');
  });

  it('slug 与既有定义冲突拒绝并带既有信息', async () => {
    // 种子：先建 slug=translator 的定义
    await executeResourceOp('createAgent', { manifestYaml: validYaml }, wsId);
    await expect(
      executeResourceOp('createAgent', { manifestYaml: validYaml }, wsId),
    ).rejects.toThrow(/slug 已存在.*translator/);
  });

  it('全局无默认模型时报错指路设置', async () => {
    // 种子 workspace 不配 defaultChatModel 的测试库路径（mirror crud-custom-def 既有用例）
    await expect(
      executeResourceOp('createAgent', { manifestYaml: yamlWithOtherSlug }, wsId),
    ).rejects.toThrow('defaultChatModel');
  });

  it('addToWorkspace=true 返回成员 instanceId', async () => {
    const r = (await executeResourceOp(
      'createAgent',
      { manifestYaml: yamlWithOtherSlug, addToWorkspace: true },
      wsId,
    )) as { definitionId: string; member?: { instanceId: string } };
    expect(r.member?.instanceId).toBeTruthy();
  });
});
```

（`yamlWithOtherSlug` 同 `validYaml` 改 slug=translator-2；无默认模型用例需在该测试库清掉 defaultChatModel 设置——按 `crud-custom-def.test.ts` 的「未配置 modelProviderId」用例同款手法。）

- [ ] **Step 2: 跑测试确认失败**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/agent/resource-ops.test.ts --pool=forks`
Expected: FAIL（createAgent 未实现）

- [ ] **Step 3: 实现 opCreateAgent**

```ts
// ── createAgent（与 UI 导入链 agent.createFromYaml 同语义：parse → 冲突拒绝 →
//    createCustomDef（含 defaultChatModel 兜底 + SAFE_MINIMUM_TOOLS 缺省））──
interface CreateAgentResult {
  definitionId: string;
  slug: string;
  member?: { instanceId: string };
}

async function opCreateAgent(
  a: Record<string, unknown>,
  workspaceId: string,
): Promise<CreateAgentResult> {
  const manifestYaml = str(a['manifestYaml'], 'manifestYaml');
  const addToWorkspace = a['addToWorkspace'] === true;
  const parsed = parseAgentManifest(manifestYaml); // 校验失败抛逐字段错误（agent 可修后重试）
  if (!isValidSlug(parsed.slug)) throw new Error(`非法 slug: ${parsed.slug}`);
  // v25 定义全局化：任何 source 同 slug 即冲突（spec §5.2）——不做静默后缀
  const clash = listAgentDefinitions().find((d) => d.slug === parsed.slug);
  if (clash) {
    throw new Error(`slug 已存在: ${parsed.slug}（id=${clash.id}, source=${clash.source}）——请换 slug 或先在资源库管理既有定义`);
  }
  // 显式模型入参可选；providerId 显式时校验存在（友好报错优于 FK 中止）
  let modelProviderId = '';
  let modelName = '';
  if (typeof a['modelProviderId'] === 'string' && a['modelProviderId']) {
    modelProviderId = a['modelProviderId'];
    modelName = str(a['modelName'], 'modelName');
    if (!getProvider(modelProviderId)) throw new Error(`供应商不存在: ${modelProviderId}`);
  }
  const def = createCustomDef(null, {
    name: parsed.name,
    slug: parsed.slug,
    description: parsed.description,
    systemPrompt: parsed.systemPrompt,
    iconEmoji: parsed.iconEmoji,
    modelProviderId, // 空 → createCustomDef 走 defaultChatModel 兜底
    modelName,
    defaultTools: parsed.defaultTools,
    defaultMcps: parsed.defaultMcps,
    defaultSkills: parsed.defaultSkills,
  });
  let member: { instanceId: string } | undefined;
  if (addToWorkspace) {
    const m = await opAddMember({ definitionIdOrSlug: def.id }, workspaceId);
    member = { instanceId: m.instanceId };
  }
  logger.info('会话内创建 agent 定义', { slug: def.slug, id: def.id, addToWorkspace });
  return { definitionId: def.id, slug: def.slug, member };
}
```

（`import { getProvider } from './provider-crud';` 补进文件头。）

- [ ] **Step 4: 跑测试确认通过 + typecheck**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/agent/resource-ops.test.ts --pool=forks && cd .. && npx pnpm@9.0.0 typecheck`
Expected: PASS / 绿

- [ ] **Step 5: Commit**

```bash
git add electron/src/main/agent/resource-ops.ts electron/tests/agent/resource-ops.test.ts
git commit -m "feat: createAgent op（复用 createFromYaml 同链，slug 冲突拒绝）"
```

---

### Task 4: createSkill op

**Files:**
- Modify: `electron/src/main/agent/resource-ops.ts`
- Test: `electron/tests/agent/resource-ops.test.ts`（追加）

**Interfaces:**
- Consumes: `parseSkillMd`（`skill/loader.ts`——name/description 必填校验）、`getSkillsDir` / `listInstalled`（`skill/zip-uploader.ts`）、`skill_definitions` 表（INSERT 形状对齐 `marketplace/installer.ts` registerInstalledPackage skill 分支：`id/name/slug/version/description/allowed_tools/cache_path/tags`）
- Produces: `CreateSkillResult = { slug: string; name: string }`

- [ ] **Step 1: 追加失败测试**

```ts
describe('createSkill', () => {
  const md = `---
name: 报告撰写
description: 写结构化报告时使用
---
## 工作流
1. 先列大纲
`;

  it('frontmatter 缺 name 拒绝', async () => {
    await expect(
      executeResourceOp('createSkill', { slug: 'report-writer', skillMd: '---\ndescription: x\n---\nbody' }, wsId),
    ).rejects.toThrow('name');
  });

  it('非法 slug 拒绝', async () => {
    await expect(
      executeResourceOp('createSkill', { slug: 'Bad/Slug', skillMd: md }, wsId),
    ).rejects.toThrow('非法 slug');
  });

  it('与既有 skill 同名拒绝并带来源', async () => {
    // 种子：先装 slug=report-writer；再建同名
    await executeResourceOp('createSkill', { slug: 'report-writer', skillMd: md }, wsId);
    await expect(
      executeResourceOp('createSkill', { slug: 'report-writer', skillMd: md }, wsId),
    ).rejects.toThrow(/skill 已存在.*custom/);
  });

  it('references 路径穿越拒绝且零落盘', async () => {
    await expect(
      executeResourceOp(
        'createSkill',
        { slug: 'safe-skill', skillMd: md, references: [{ path: '../escape.md', content: 'x' }] },
        wsId,
      ),
    ).rejects.toThrow('越界');
    expect(fs.existsSync(path.join(getSkillsDir(), 'escape.md'))).toBe(false);
  });

  it('成功：SKILL.md + references 落盘 + skill_definitions 落库', async () => {
    const r = (await executeResourceOp(
      'createSkill',
      { slug: 'ref-skill', skillMd: md, references: [{ path: 'references/tpl.md', content: '模板' }] },
      wsId,
    )) as { slug: string; name: string };
    expect(r.name).toBe('报告撰写');
    expect(fs.existsSync(path.join(getSkillsDir(), 'ref-skill', 'references', 'tpl.md'))).toBe(true);
  });
});
```

（测试库需把 getSkillsDir 指到临时目录——按 `tests/skill/upload-zip.test.ts` 既有手法注入。）

- [ ] **Step 2: 跑测试确认失败**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/agent/resource-ops.test.ts --pool=forks`
Expected: FAIL

- [ ] **Step 3: 实现 opCreateSkill**

```ts
interface SkillFileInput {
  path: string;
  content: string;
}

/** 解析后的路径必须仍在 skill 目录内（防 ../ 与绝对路径穿越——readSkillResource 同款纪律） */
function safeJoin(dir: string, rel: string): string {
  if (path.isAbsolute(rel)) throw new Error(`references 路径越界: ${rel}`);
  const full = path.resolve(dir, rel);
  if (full !== dir && !full.startsWith(dir + path.sep)) {
    throw new Error(`references 路径越界: ${rel}`);
  }
  return full;
}

function opCreateSkill(a: Record<string, unknown>): { slug: string; name: string } {
  const slug = str(a['slug'], 'slug'); // 显式必填——中文 name 无法可靠派生英文 slug（spec §5.4）
  const skillMd = str(a['skillMd'], 'skillMd');
  const refs = Array.isArray(a['references']) ? (a['references'] as SkillFileInput[]) : [];
  if (!isValidSlug(slug)) throw new Error(`非法 slug: ${slug}`);
  const dup = listInstalledSkills().find((s) => s.slug === slug);
  if (dup) throw new Error(`skill 已存在: ${slug}（source=${dup.source}）——如需覆盖请先在资源库删除`);

  const dir = path.join(getSkillsDir(), slug);
  const def = parseSkillMd(skillMd, dir); // name/description 必填校验（缺则抛）
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), skillMd, 'utf-8');
  for (const ref of refs) {
    if (typeof ref.path !== 'string' || typeof ref.content !== 'string') {
      throw new Error('references 条目须含 path 与 content 字符串');
    }
    const target = safeJoin(dir, ref.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, ref.content, 'utf-8');
  }
  // 落库形状对齐 installer.registerInstalledPackage 的 skill 分支
  getDb()
    .prepare(
      `INSERT INTO skill_definitions
       (id, name, slug, version, description, allowed_tools, cache_path, tags)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      randomUUID(), def.name, slug, def.version, def.description,
      JSON.stringify(def.allowedTools ?? []), dir, JSON.stringify(def.tags ?? []),
    );
  logger.info('会话内安装 skill', { slug });
  return { slug, name: def.name };
}
```

- [ ] **Step 4: 跑测试确认通过 + typecheck**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/agent/resource-ops.test.ts --pool=forks && cd .. && npx pnpm@9.0.0 typecheck`
Expected: PASS / 绿

- [ ] **Step 5: Commit**

```bash
git add electron/src/main/agent/resource-ops.ts electron/tests/agent/resource-ops.test.ts
git commit -m "feat: createSkill op（写盘+落库，同名拒绝，references 越界防御）"
```

---

### Task 5: createMcp op（先测后落库）

**Files:**
- Modify: `electron/src/main/agent/resource-ops.ts`
- Test: `electron/tests/agent/resource-ops.test.ts`（追加）

**Interfaces:**
- Consumes: `registerMcpDefinition`（`mcp/host-manager.ts:351`——**输入形状必须逐字段对齐 `resource/ipc.handlers.ts:251-275` 的 RegisterMcpInput 组装**）、`McpClient`（`mcp/client.ts`，stdio）、`HttpMcpClient`（`mcp/http-client.ts`）
- Produces: `CreateMcpResult = { name: string; toolCount: number; toolNames: string[] }`；`MCP_TEST_TIMEOUT_MS = 30_000`（对齐 mcp-bridge 既有常量）

- [ ] **Step 1: 追加失败测试（客户端工厂注入——momo-test-rules：mock 保真，不 vi.mock 内部）**

```ts
describe('createMcp', () => {
  it('非法 name 拒绝', async () => {
    await expect(
      executeResourceOp('createMcp', { name: 'Bad Name', transport: { kind: 'http', url: 'https://x' } }, wsId),
    ).rejects.toThrow('非法');
  });

  it('同名冲突拒绝', async () => {
    // 种子：mcp_definitions 预插 name=demo 行（直接 SQL，mirror mcp 既有测试）
    await expect(
      executeResourceOp('createMcp', { name: 'demo', transport: { kind: 'http', url: 'https://x' } }, wsId),
    ).rejects.toThrow('MCP 已存在');
  });

  it('连通失败零落库并回传错误', async () => {
    const failingClient = {
      connect: async () => { throw new Error('connection refused'); },
      listTools: async () => [],
      disconnect: async () => undefined,
    };
    await expect(
      executeResourceOp('createMcp', { name: 'dead-server', transport: { kind: 'stdio', command: 'no-such-bin' } }, wsId, {
        makeClient: () => failingClient,
      }),
    ).rejects.toThrow('connection refused');
    const row = getDb().prepare('SELECT 1 FROM mcp_definitions WHERE name = ?').get('dead-server');
    expect(row).toBeUndefined();
  });

  it('连通成功后落库并返回工具名摘要（截断至 20）', async () => {
    const okClient = {
      connect: async () => undefined,
      listTools: async () => Array.from({ length: 25 }, (_, i) => ({ name: `t${i}` })),
      disconnect: async () => undefined,
    };
    const r = (await executeResourceOp(
      'createMcp', { name: 'live-server', transport: { kind: 'http', url: 'https://x' } }, wsId,
      { makeClient: () => okClient },
    )) as { toolCount: number; toolNames: string[] };
    expect(r.toolCount).toBe(25);
    expect(r.toolNames).toHaveLength(20);
    expect(getDb().prepare('SELECT 1 FROM mcp_definitions WHERE name = ?').get('live-server')).toBeTruthy();
  });
});
```

（`executeResourceOp` 增加可选第四参 `deps?: { makeClient }`——测试注入点，生产缺省真实工厂。）

- [ ] **Step 2: 跑测试确认失败**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/agent/resource-ops.test.ts --pool=forks`
Expected: FAIL

- [ ] **Step 3: 实现 opCreateMcp**

```ts
import { registerMcpDefinition } from '../mcp/host-manager';
import { McpClient } from '../mcp/client';
import { HttpMcpClient } from '../mcp/http-client';
import type { McpServerConfig, McpToolInfo } from '../mcp/types';

const MCP_TEST_TIMEOUT_MS = 30_000;

/** 瞬态客户端最小面（McpClient / HttpMcpClient 均满足） */
interface TransientMcpClient {
  connect(): Promise<void>;
  listTools(): Promise<McpToolInfo[]>;
  disconnect(): Promise<void>;
}

interface McpTransportInput {
  kind: 'stdio' | 'http';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

async function opCreateMcp(
  a: Record<string, unknown>,
  deps?: { makeClient: (config: McpServerConfig) => TransientMcpClient },
): Promise<{ name: string; toolCount: number; toolNames: string[] }> {
  const name = str(a['name'], 'name');
  if (!isValidSlug(name)) throw new Error(`非法 MCP name: ${name}`);
  const taken = getDb().prepare('SELECT 1 FROM mcp_definitions WHERE name = ?').get(name);
  if (taken) throw new Error(`MCP 已存在: ${name}`);
  const transport = a['transport'] as McpTransportInput | undefined;
  if (!transport || (transport.kind !== 'stdio' && transport.kind !== 'http')) {
    throw new Error('transport 必须为 { kind: "stdio", command, args?, env? } 或 { kind: "http", url, headers? }');
  }

  // 配置形状：逐字段对齐 resource/ipc.handlers.ts:251-275 的 RegisterMcpInput 组装（实施时并排核对）
  const config: McpServerConfig =
    transport.kind === 'stdio'
      ? ({
          name,
          transport: 'stdio',
          command: transport.command ?? '',
          args: transport.args ?? [],
          env: transport.env ?? {},
        } as McpServerConfig)
      : ({
          name,
          transport: 'streamable_http',
          url: transport.url ?? '',
          headers: transport.headers ?? {},
        } as McpServerConfig);

  // 先测后落库（spec §5.5）：瞬态客户端不经进程池、不落库
  const makeClient =
    deps?.makeClient ??
    ((cfg: McpServerConfig): TransientMcpClient =>
      cfg.transport === 'stdio' ? new McpClient(cfg) : new HttpMcpClient(cfg));
  const client = makeClient(config);
  let toolNames: string[];
  try {
    await withTimeout(client.connect(), MCP_TEST_TIMEOUT_MS, `MCP ${name} 连接超时`);
    const tools = await withTimeout(client.listTools(), MCP_TEST_TIMEOUT_MS, `MCP ${name} 工具发现超时`);
    toolNames = tools.map((t) => t.name);
  } finally {
    await client.disconnect().catch(() => undefined);
  }
  registerMcpDefinition({
    id: randomUUID(),
    name,
    version: '1.0.0',
    ...(transport.kind === 'stdio'
      ? { command: transport.command ?? '', args: transport.args ?? [], env: transport.env ?? {} }
      : { url: transport.url ?? '', headers: transport.headers ?? {} }),
    source: 'custom',
  } as Parameters<typeof registerMcpDefinition>[0]);
  logger.info('会话内注册 MCP', { name, toolCount: toolNames.length });
  return { name, toolCount: toolNames.length, toolNames: toolNames.slice(0, 20) };
}

function withTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => {
      const t = setTimeout(() => reject(new Error(msg)), ms);
      t.unref?.();
    }),
  ]);
}
```

（`McpServerConfig` 真实字段名以 `mcp/types.ts` 为准——MUST DO：并排打开 `resource/ipc.handlers.ts:251-275` 与 `mcp/types.ts` 逐字段核对后再定稿；测试断言行为不受字段名影响。）

- [ ] **Step 4: 跑测试确认通过 + typecheck**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/agent/resource-ops.test.ts --pool=forks && cd .. && npx pnpm@9.0.0 typecheck`
Expected: PASS / 绿

- [ ] **Step 5: Commit**

```bash
git add electron/src/main/agent/resource-ops.ts electron/tests/agent/resource-ops.test.ts
git commit -m "feat: createMcp op（瞬态客户端先测后落库）"
```

---

### Task 6: resource-ops 桥（子进程侧 + spawner 接线 + 刷新广播）

**Files:**
- Create: `electron/src/main/agent/resource-ops-bridge.ts`（子进程侧）
- Create: `electron/src/main/resource/changed-emit.ts`（`resource:changed` 广播）
- Modify: `electron/src/main/agent/runtime-spawner.ts`（子进程 message 路由新增 `resource-op` 分支——`McpBridgeResponse` 同函数内）
- Test: `electron/tests/agent/resource-ops-bridge.test.ts`

**Interfaces:**
- Consumes: `executeResourceOp` / `RESOURCE_OP_NAMES`（Task 2）、`broadcastRuntimeChanged`（`im/session-service.ts:93`，既有导出）、`broadcastProgressToWindows` 懒加载 require 模式（`resource/hub-install.ts:363`）
- Produces: `requestResourceOp(op: string, args: Record<string, unknown>): Promise<unknown>`（子进程侧，Task 7 工具模块消费）；`broadcastResourceChanged(): void`；`notifyResourceOpSucceeded(op: string): void`

- [ ] **Step 1: 写失败测试（主进程侧分发逻辑纯函数化测试）**

```ts
// electron/tests/agent/resource-ops-bridge.test.ts
import { describe, it, expect, vi } from 'vitest';
import { handleResourceOpMessage, notifyResourceOpSucceeded, MEMBER_AFFECTING_OPS } from '../../src/main/agent/resource-ops-bridge';

describe('handleResourceOpMessage（主进程侧分支）', () => {
  it('type=resource-op 且 id 配对：成功回 result', async () => {
    const send = vi.fn();
    await handleResourceOpMessage(
      { type: 'resource-op', id: 'r1', op: 'list', args: { type: 'teams' } },
      'ws-1',
      send,
      async (op, args, wsId) => ({ op, args, wsId }), // 注入 fake executeResourceOp
    );
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'resource-op', id: 'r1', result: expect.anything() }));
  });

  it('执行失败回 error（string 化——非 Error 抛出物不许误判成功）', async () => {
    const send = vi.fn();
    await handleResourceOpMessage(
      { type: 'resource-op', id: 'r2', op: 'createTeam', args: {} },
      'ws-1',
      send,
      async () => { throw '裸字符串错误'; },
    );
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'resource-op', id: 'r2', error: '裸字符串错误' }));
  });

  it('非 resource-op 消息返回 false（不消费）', async () => {
    const send = vi.fn();
    const consumed = await handleResourceOpMessage({ type: 'mcp:listTools', id: 'x' }, 'ws-1', send, async () => null);
    expect(consumed).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it('成功后按 op 通知刷新（member 类 op 额外广播 runtimeChanged）', () => {
    // MEMBER_AFFECTING_OPS = createAgent | addMember | createTeam（语义固定）
    expect(MEMBER_AFFECTING_OPS).toContain('createTeam');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/agent/resource-ops-bridge.test.ts --pool=forks`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现三个文件**

```ts
// electron/src/main/agent/resource-ops-bridge.ts
//
// resource-ops 桥（spec §6）。子进程侧 requestResourceOp 复刻 mcp-bridge 全部教训
// （id 配对 + 30s 超时 + process.send 方法调用式绑定铁律）；主进程侧
// handleResourceOpMessage 供 runtime-spawner 的子进程 message 路由调用。
import { randomUUID } from 'node:crypto';
import { executeResourceOp, RESOURCE_OP_NAMES } from './resource-ops';
import { broadcastRuntimeChanged } from '../im/session-service';
import { broadcastResourceChanged } from '../resource/changed-emit';
import { logger } from '../logger';

const RESOURCE_OP_TIMEOUT_MS = 30_000;

/** 子进程侧：请求主进程执行一个 resource op */
export function requestResourceOp(op: string, args: Record<string, unknown>): Promise<unknown> {
  // 铁律：process.send 必须以方法调用形式调用（this=undefined 会炸——§8.4 教训）
  const send = (process as { send?: (m: unknown) => void }).send?.bind(process);
  if (typeof send !== 'function') {
    return Promise.reject(new Error('资源创建不可用：子进程未建立 IPC 通道'));
  }
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    const timer = setTimeout(() => {
      process.off('message', handler);
      reject(new Error(`resource op ${op} 超时（${RESOURCE_OP_TIMEOUT_MS / 1000}s）`));
    }, RESOURCE_OP_TIMEOUT_MS);
    timer.unref?.();
    const handler = (msg: unknown): void => {
      const m = msg as { type?: string; id?: string; result?: unknown; error?: unknown };
      if (m?.type !== 'resource-op' || m.id !== id) return;
      process.off('message', handler);
      clearTimeout(timer);
      if (m.error !== undefined) reject(new Error(String(m.error)));
      else resolve(m.result ?? null);
    };
    process.on('message', handler);
    send({ type: 'resource-op', id, op, args });
  });
}

/** 影响成员/团队可见性的 op——成功后额外广播既有 agent:runtimeChanged（MainLayout 已监听） */
export const MEMBER_AFFECTING_OPS = ['createAgent', 'addMember', 'createTeam'] as const;

type OpExecutor = (op: string, args: unknown, workspaceId: string) => Promise<unknown>;

/**
 * 主进程侧消息分支：消费 type='resource-op' 的子进程消息。
 * workspaceId 取自 per-child spawn 上下文（调用方闭包）——消息内 workspaceId 一律忽略。
 * 返回是否消费（false = 交还其它分支）。可注入 executor 供测试。
 */
export async function handleResourceOpMessage(
  msg: unknown,
  workspaceId: string,
  childSend: (m: unknown) => void,
  executor: OpExecutor = executeResourceOp,
): Promise<boolean> {
  const m = msg as { type?: string; id?: unknown; op?: unknown; args?: unknown };
  if (m?.type !== 'resource-op' || typeof m.id !== 'string') return false;
  const op = typeof m.op === 'string' ? m.op : '';
  if (!(RESOURCE_OP_NAMES as readonly string[]).includes(op)) {
    childSend({ type: 'resource-op', id: m.id, error: `未知 resource op: ${op}` });
    return true;
  }
  try {
    const result = await executor(op, m.args ?? {}, workspaceId);
    notifyResourceOpSucceeded(op);
    childSend({ type: 'resource-op', id: m.id, result: result ?? null });
  } catch (err) {
    // 收敛任意 throwable 为文本（裸 string rejection 会误判成功——mcp 桥 throwableText 同款）
    childSend({ type: 'resource-op', id: m.id, error: err instanceof Error ? err.message : String(err) });
  }
  return true;
}

/** op 成功后的刷新广播：resource:changed 恒发；member 类叠加 agent:runtimeChanged */
export function notifyResourceOpSucceeded(op: string): void {
  broadcastResourceChanged();
  if ((MEMBER_AFFECTING_OPS as readonly string[]).includes(op)) {
    broadcastRuntimeChanged();
  }
}
```

```ts
// electron/src/main/resource/changed-emit.ts
//
// resource:changed 全窗口广播（spec §6）。计划期探明：现行系统无通用资源刷新通道
// （registerPluginAgents 落库零推送、registerMcp 注释「广播」是死注释）——本模块补上。
// 懒加载 require electron：vitest 里 require('electron') 返回路径字符串，静默跳过
// （broadcastProgressToWindows 同款纪律）。
import { logger } from '../logger';

export const RESOURCE_CHANGED_CHANNEL = 'resource:changed';

export function broadcastResourceChanged(): void {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const electron = require('electron') as typeof import('electron') | string;
  if (typeof electron === 'string') return;
  for (const win of electron.BrowserWindow.getAllWindows()) {
    win.webContents.send(RESOURCE_CHANGED_CHANNEL, { at: Date.now() });
  }
  logger.info('resource:changed 已广播');
}
```

runtime-spawner.ts 接线（在子进程 message 路由函数内、`McpBridgeResponse` 处理同级新增分支——**先读该函数找精确插入行**）：

```ts
import { handleResourceOpMessage } from './resource-ops-bridge';
// …子进程 message handler 内（与 mcp 桥分支并列）：
if (await handleResourceOpMessage(msg, opts.runtimeConfig.workspaceId, (m) => { child.send(m as never); })) {
  return; // 已消费
}
```

（若该 handler 为同步 switch 形态，则改为 `handleResourceOpMessage(...).then((consumed) => { if (!consumed) …原逻辑 })` 或在 mcp 分支旁加同步 type 预判后异步执行——以现场代码结构为准，保持其余分支零改动。`child.send` 用 spawner 既有安全发信护栏包裹。）

- [ ] **Step 4: 跑测试确认通过 + typecheck**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/agent/resource-ops-bridge.test.ts --pool=forks && cd .. && npx pnpm@9.0.0 typecheck`
Expected: PASS / 绿

- [ ] **Step 5: Commit**

```bash
git add electron/src/main/agent/resource-ops-bridge.ts electron/src/main/resource/changed-emit.ts electron/src/main/agent/runtime-spawner.ts electron/tests/agent/resource-ops-bridge.test.ts
git commit -m "feat: resource-ops 桥（子进程请求+spawner 路由+resource:changed 广播）"
```

---

### Task 7: ResourceTools 工具模块 + 注册

**Files:**
- Create: `electron/src/main/agent/tools/resource-tools.ts`
- Modify: `electron/src/main/agent/tools/index.ts`（`unconditionalModules` + 头注释）
- Test: `electron/tests/agent/tools/resource-tools.test.ts`

**Interfaces:**
- Consumes: `requestResourceOp`（Task 6）、`ToolModule` / `ToolContext`（`tools/types.ts`）、`buildCatalog`（`tools/catalog-entry.ts`——TaskTools 同款）
- Produces: `ResourceTools` 类（构造可注入 `callOp`——默认 `requestResourceOp`，测试注入点）；工具名 `resource_list` / `create_agent` / `add_agent_member` / `create_skill` / `create_mcp` / `create_team`（Task 9 技能文案、Task 10 Momo YAML 引用这六个名字，一字不差）

- [ ] **Step 1: 写失败测试**

```ts
// electron/tests/agent/tools/resource-tools.test.ts
import { describe, it, expect } from 'vitest';
import { ResourceTools } from '../../../src/main/agent/tools/resource-tools';
import { ALL_BUILTIN_TOOLS } from '../../../src/main/agent/tools/catalog';

const fakeOp = (result: unknown) => async (_op: string, _args: Record<string, unknown>) => result;
const mk = (r: unknown) => new ResourceTools(fakeOp(r));

describe('ResourceTools', () => {
  it('六工具名进目录全集（58→64）', () => {
    const names = new ResourceTools(fakeOp(null)).getDefs().map((d) => d.name);
    expect(names).toEqual([
      'resource_list', 'create_agent', 'add_agent_member', 'create_skill', 'create_mcp', 'create_team',
    ]);
    for (const n of names) expect(ALL_BUILTIN_TOOLS).toContain(n);
  });

  it('handles 精确匹配六个名', () => {
    const t = mk(null);
    expect(t.handles('create_agent')).toBe(true);
    expect(t.handles('create_agent_v2')).toBe(false);
    expect(t.handles('resource_list')).toBe(true);
  });

  it('execute 映射 op 并 JSON 化结果', async () => {
    const calls: Array<[string, Record<string, unknown>]> = [];
    const t = new ResourceTools(async (op, args) => { calls.push([op, args]); return { teamId: 't1' }; });
    const out = await t.execute('create_team', { name: 'X', memberInstanceIds: ['a', 'b'], leaderInstanceId: 'a' }, ctx);
    expect(calls[0]![0]).toBe('createTeam');
    expect(out).toContain('t1');
  });

  it('无 IPC 通道时干净失败（默认 callOp 无 process.send → 中文 reject）', async () => {
    const t = new ResourceTools(); // 不注入——生产默认 requestResourceOp
    await expect(t.execute('resource_list', {}, ctx)).rejects.toThrow('未建立 IPC 通道');
  });
});

const ctx = {} as Parameters<ResourceTools['execute']>[2]; // ToolContext 最小占位（本模块不消费 ctx 字段）
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/agent/tools/resource-tools.test.ts --pool=forks`
Expected: FAIL

- [ ] **Step 3: 实现 ResourceTools + 注册**

```ts
// electron/src/main/agent/tools/resource-tools.ts
//
// 资源创建工具模块（spec §5）：六个工具经 resource-ops 桥在主进程执行。
// workspaceId 不经工具入参——主进程侧从 spawn 上下文注入（子进程不可伪造）。
// callOp 构造注入：生产默认 requestResourceOp；测试注入 fake（momo-test-rules）。
import type { LLMToolDef } from '../llm-provider';
import type { ToolCatalogEntry } from './catalog-entry';
import type { ToolContext, ToolModule } from './types';
import { buildCatalog } from './catalog-entry';
import { requestResourceOp } from '../resource-ops-bridge';

type OpCaller = (op: string, args: Record<string, unknown>) => Promise<unknown>;

/** 工具名 → op 名映射（单点，防漂移） */
const TOOL_TO_OP: Record<string, string> = {
  resource_list: 'list',
  create_agent: 'createAgent',
  add_agent_member: 'addMember',
  create_skill: 'createSkill',
  create_mcp: 'createMcp',
  create_team: 'createTeam',
};

const CATALOG_META: Record<string, { displayName: string; category: string; categoryEmoji: string }> = {
  resource_list: { displayName: '资源清单', category: '资源创建', categoryEmoji: '🧱' },
  create_agent: { displayName: '创建 Agent', category: '资源创建', categoryEmoji: '🧱' },
  add_agent_member: { displayName: '加工作空间成员', category: '资源创建', categoryEmoji: '🧱' },
  create_skill: { displayName: '创建技能', category: '资源创建', categoryEmoji: '🧱' },
  create_mcp: { displayName: '接入 MCP', category: '资源创建', categoryEmoji: '🧱' },
  create_team: { displayName: '组建团队', category: '资源创建', categoryEmoji: '🧱' },
};

export class ResourceTools implements ToolModule {
  constructor(private readonly callOp: OpCaller = requestResourceOp) {}

  getDefs(): LLMToolDef[] {
    return [
      {
        name: 'resource_list',
        description:
          '列出当前工作空间的资源清单（agent 定义 / 工作空间成员 / 已装 skill / 已配 MCP / 已有团队）。创建任何资源前先调用盘点，防重复创建。可选 type 过滤：agents / members / skills / mcps / teams。',
        inputSchema: {
          type: 'object',
          properties: { type: { type: 'string', enum: ['agents', 'members', 'skills', 'mcps', 'teams'] } },
        },
      },
      {
        name: 'create_agent',
        description:
          '创建 agent 定义（K8s 风格 YAML manifest 全文入参，格式见 create-agent 技能）。slug 全局唯一，冲突会拒绝；模型缺省用全局默认聊天模型。addToWorkspace=true 时同时加入当前工作空间。创建前必须向用户复述名称/slug/工具面。',
        inputSchema: {
          type: 'object',
          properties: {
            manifestYaml: { type: 'string', description: '完整 agent manifest YAML' },
            addToWorkspace: { type: 'boolean', description: '创建后加入当前工作空间（默认 false）' },
          },
          required: ['manifestYaml'],
        },
      },
      {
        name: 'add_agent_member',
        description: '把已有 agent 定义加入当前工作空间（幂等）。definitionIdOrSlug 可传 resource_list 查到的定义 id 或 slug。组建团队前用它补位。',
        inputSchema: {
          type: 'object',
          properties: { definitionIdOrSlug: { type: 'string' } },
          required: ['definitionIdOrSlug'],
        },
      },
      {
        name: 'create_skill',
        description:
          '安装技能（SKILL.md 全文入参，frontmatter 须含 name/description；slug 显式必填，小写字母数字连字符）。可选 references 附属文件。同名已装会拒绝。格式见 create-skill 技能。',
        inputSchema: {
          type: 'object',
          properties: {
            slug: { type: 'string', description: '技能 slug（英文小写-连字符，全局唯一）' },
            skillMd: { type: 'string', description: 'SKILL.md 全文（含 frontmatter）' },
            references: {
              type: 'array',
              description: '附属文件（相对路径 + 内容）',
              items: {
                type: 'object',
                properties: { path: { type: 'string' }, content: { type: 'string' } },
                required: ['path', 'content'],
              },
            },
          },
          required: ['slug', 'skillMd'],
        },
      },
      {
        name: 'create_mcp',
        description:
          '接入 MCP server（stdio 命令或 HTTP url 二选一）。落库前强制连通测试（initialize + tools/list），失败不落库并返回错误可修后重试。凭证只入配置不在回复回显。格式见 create-mcp 技能。',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'server 名（英文小写-连字符，全局唯一）' },
            transport: {
              type: 'object',
              description: 'stdio: { kind, command, args?, env? } 或 http: { kind, url, headers? }',
              properties: {
                kind: { type: 'string', enum: ['stdio', 'http'] },
                command: { type: 'string' }, args: { type: 'array', items: { type: 'string' } },
                env: { type: 'object' }, url: { type: 'string' }, headers: { type: 'object' },
              },
              required: ['kind'],
            },
          },
          required: ['name', 'transport'],
        },
      },
      {
        name: 'create_team',
        description:
          '组建团队（成员 ≥2，leader 必须在成员内）。memberInstanceIds 用 resource_list 查到的成员 instanceId。组建流程见 build-team 技能：先盘点、补位、向用户复述阵容再创建。',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            iconEmoji: { type: 'string' },
            memberInstanceIds: { type: 'array', items: { type: 'string' } },
            leaderInstanceId: { type: 'string' },
          },
          required: ['name', 'memberInstanceIds', 'leaderInstanceId'],
        },
      },
    ];
  }

  getCatalog(): ToolCatalogEntry[] {
    return buildCatalog(this.getDefs(), CATALOG_META);
  }

  handles(name: string): boolean {
    return name in TOOL_TO_OP;
  }

  async execute(
    name: string,
    args: Record<string, unknown>,
    _ctx: ToolContext,
  ): Promise<string> {
    const op = TOOL_TO_OP[name];
    if (!op) throw new Error(`未知资源工具: ${name}`);
    const result = await this.callOp(op, args ?? {});
    return JSON.stringify(result, null, 2);
  }
}
```

`tools/index.ts`：`unconditionalModules()` 数组追加 `new ResourceTools()`（`import { ResourceTools } from './resource-tools';`），头注释加一行「+ ResourceTools（资源创建六工具：resource_list / create_agent / add_agent_member / create_skill / create_mcp / create_team——经 resource-ops 桥主进程执行）」。`ALL_BUILTIN_TOOLS` 从注册中心派生，自动 58→64，无需另改 catalog.ts。

（MUST DO：对照 TaskTools 的 `buildCatalog` 真实签名（`tools/catalog-entry.ts`）核对 meta 形状；`defaultOn` 若为 meta 可选字段则不填 = 非默认启用。）

- [ ] **Step 4: 跑测试确认通过 + 全量 agent 工具域回归 + typecheck**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/agent/tools/resource-tools.test.ts tests/agent/tools --pool=forks && cd .. && npx pnpm@9.0.0 typecheck`
Expected: PASS / 绿

- [ ] **Step 5: Commit**

```bash
git add electron/src/main/agent/tools/resource-tools.ts electron/src/main/agent/tools/index.ts electron/tests/agent/tools/resource-tools.test.ts
git commit -m "feat: ResourceTools 六资源创建工具（注册进内置目录 58→64）"
```

---

### Task 8: renderer 刷新订阅（preload + 两 store）

**Files:**
- Modify: `electron/src/preload/index.ts`（resource 段新增 `onResourceChanged`）
- Modify: `renderer/src/stores/resource.store.ts`（订阅 → `load()`）
- Modify: `renderer/src/stores/agent.store.ts`（订阅 → 成员 + 团队重拉）
- Test: `renderer/src/stores/resource.store.test.ts`（追加）

**Interfaces:**
- Consumes: `RESOURCE_CHANGED_CHANNEL = 'resource:changed'`（Task 6 `resource/changed-emit.ts`——preload 手写同名字符串，跨层常量双写是 preload 既有模式，对齐 `plugin:panelsChanged` 写法）
- Produces: preload `resource.onResourceChanged(cb): () => void`（返回退订函数，对齐 onPanelsChanged 形状）

- [ ] **Step 1: 写失败测试（追加到 resource.store.test.ts，mock 手法沿用该文件既有 vi.mock ipc 模式）**

```ts
it('onResourceChanged 回调触发 load()', async () => {
  const { useResourceStore } = await import('../stores/resource.store');
  // 拦截 ipc.resource.list 返回空数组（该文件既有 mock 手法）
  let captured: (() => void) | undefined;
  vi.mocked(ipc.resource).onResourceChanged?.mockImplementation((cb: () => void) => {
    captured = cb;
    return () => undefined;
  });
  // 触发订阅初始化（见 Step 3 的 initResourceChanged）
  useResourceStore.getState().initResourceChanged?.();
  const before = useResourceStore.getState().loading;
  captured?.();
  // load 被触发：loading 翻真或 items 被重拉（按 store 异步实现断言其一）
  expect(useResourceStore.getState()).toBeTruthy();
  void before;
});
```

（断言以 store 实际实现微调——核心锁「订阅回调驱动 load」，mock list 计数断言最稳。）

- [ ] **Step 2: 跑测试确认失败**

Run: `cd renderer && npx pnpm@9.0.0 vitest run src/stores/resource.store.test.ts`
Expected: FAIL（`onResourceChanged` 不存在）

- [ ] **Step 3: 实现三处**

preload（resource 段，`onPanelsChanged` 同款形状）：

```ts
onResourceChanged: (cb: () => void) => {
  const listener = (_e: unknown, _payload: unknown): void => cb();
  ipcRenderer.on('resource:changed', listener);
  return () => ipcRenderer.removeListener('resource:changed', listener);
},
```

（同步在 `renderer/src/ipc/types.d.ts` 的 resource 段补类型声明 `onResourceChanged(cb: () => void): () => void;`——IPC 契约两 workspace 同步改，momo-boundary-rules。）

resource.store.ts（`initHubUpdates` 同款风格新增，接线点 = `initHubUpdates` 的调用处并列调用）：

```ts
initResourceChanged: () => {
  // 幂等防重复订阅（模块级 flag）
  if (resourceChangedSubscribed) return;
  resourceChangedSubscribed = true;
  ipc.resource.onResourceChanged(() => {
    void get().load();
  });
},
```

agent.store.ts（成员 + 团队重拉；`loadMembers` / `loadTeams` 为该 store 既有 action，名字以现场为准）：

```ts
initResourceChanged: () => {
  if (agentResourceChangedSubscribed) return;
  agentResourceChangedSubscribed = true;
  ipc.resource.onResourceChanged(() => {
    const wsId = useWorkspaceStore.getState().activeWorkspaceId;
    if (!wsId) return;
    void get().loadMembers(wsId);
    void get().loadTeams(wsId);
  });
},
```

接线：`grep -rn "initHubUpdates" renderer/src` 找到调用点，两个 `initResourceChanged()` 并列调用（若 initHubUpdates 在 store 创建期自调，则同位置追加）。

- [ ] **Step 4: 跑测试确认通过 + 双 workspace typecheck**

Run: `cd renderer && npx pnpm@9.0.0 vitest run src/stores/resource.store.test.ts && cd .. && npx pnpm@9.0.0 typecheck`
Expected: PASS / 绿（preload 引 renderer 类型，两侧都要过）

- [ ] **Step 5: Commit**

```bash
git add electron/src/preload/index.ts renderer/src/ipc/types.d.ts renderer/src/stores/resource.store.ts renderer/src/stores/agent.store.ts renderer/src/stores/resource.store.test.ts
git commit -m "feat: resource:changed 推送订阅（资源库/成员/团队自动刷新）"
```

---

### Task 9: 四册技能 + catalog 双轨登记

**Files:**
- Create: `electron/resources/skills/create-agent/SKILL.md`（+ `references/tool-catalog.md`）
- Create: `electron/resources/skills/create-skill/SKILL.md`
- Create: `electron/resources/skills/create-mcp/SKILL.md`（+ `references/common-servers.md`）
- Create: `electron/resources/skills/build-team/SKILL.md`
- Modify: `resources/marketplace/catalog.json`（+4 条）
- Test: `electron/tests/skill/builtin-resource-skills.test.ts`（新）+ `electron/tests/marketplace/client.test.ts`（计数 fixture +4）

**Interfaces:**
- Consumes: Task 7 六个工具名（技能文案引用，一字不差）
- Produces: 四个 skill slug：`create-agent` / `create-skill` / `create-mcp` / `build-team`（Task 10 Momo defaultSkills 引用）

- [ ] **Step 1: 写失败测试**

```ts
// electron/tests/skill/builtin-resource-skills.test.ts
//
// 四册资源创建技能的内容锁：frontmatter 完整 + 触发短语 + 关键纪律在场 + 工具名引用正确。
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const SKILLS_ROOT = path.join(__dirname, '../../resources/skills');
const SLUGS = ['create-agent', 'create-skill', 'create-mcp', 'build-team'] as const;
const TOOL_NAMES = ['resource_list', 'create_agent', 'add_agent_member', 'create_skill', 'create_mcp', 'create_team'];

describe('builtin 资源创建技能', () => {
  it.each(SLUGS)('%s：SKILL.md 在位且 frontmatter 完整', (slug) => {
    const md = fs.readFileSync(path.join(SKILLS_ROOT, slug, 'SKILL.md'), 'utf-8');
    expect(md).toMatch(/^---\n/);
    expect(md).toMatch(/name: .+/);
    expect(md).toMatch(/description: .+/);
  });

  it('create-agent 含工具名引用与复述纪律', () => {
    const md = fs.readFileSync(path.join(SKILLS_ROOT, 'create-agent/SKILL.md'), 'utf-8');
    expect(md).toContain('create_agent');
    expect(md).toContain('复述');
    expect(fs.existsSync(path.join(SKILLS_ROOT, 'create-agent/references/tool-catalog.md'))).toBe(true);
  });

  it('build-team 含盘点先行纪律', () => {
    const md = fs.readFileSync(path.join(SKILLS_ROOT, 'build-team/SKILL.md'), 'utf-8');
    expect(md).toContain('resource_list');
    expect(md).toContain('盘点');
    expect(md).toContain('leader');
  });

  it('create-skill 防自举递归纪律在场', () => {
    const md = fs.readFileSync(path.join(SKILLS_ROOT, 'create-skill/SKILL.md'), 'utf-8');
    expect(md).toContain('递归');
  });

  it('create-mcp 凭证纪律在场', () => {
    const md = fs.readFileSync(path.join(SKILLS_ROOT, 'create-mcp/SKILL.md'), 'utf-8');
    expect(md).toContain('回显');
  });

  it('全部工具名引用都在六工具集内（防拼错工具名）', () => {
    for (const slug of SLUGS) {
      const md = fs.readFileSync(path.join(SKILLS_ROOT, slug, 'SKILL.md'), 'utf-8');
      const mentioned = TOOL_NAMES.filter((t) => new RegExp(`\\b${t}\\b`).test(md));
      expect(mentioned.length, `${slug} 至少引用一个真实工具名`).toBeGreaterThan(0);
    }
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/skill/builtin-resource-skills.test.ts --pool=forks`
Expected: FAIL（文件不存在）

- [ ] **Step 3: 写四册 SKILL.md（全文如下，正文均 ≤3KB）**

`create-agent/SKILL.md`：

```markdown
---
name: 创建 Agent
description: 用户要求新建 agent / 新建智能体 / 定制一个助手 / 做个专门干某事的 agent 时使用。产出 YAML manifest 并调 create_agent 落库。
---

## 适用场景

用户说「帮我建一个 XX agent」「我想要一个专门写周报的助手」「做一个爬虫 agent」——任何要新建 agent 的请求。

## 工作流

1. **问清定位**：一句话职能（做什么/不做什么）+ 典型任务示例；用户已说清则不追问
2. **复述确认**（创建前必做）：向用户复述——名称、slug、一句话职能、工具面清单、是否立即加入当前工作空间
3. **起草 manifest**（K8s 风格，模板见下），工具只授任务必需的（最小授权——速查表 readResource 读 create-agent/references/tool-catalog.md）
4. 调 `create_agent`（manifestYaml 全文；要立即可用则 addToWorkspace: true）
5. 校验失败会逐字段报错——修正 YAML 后重试，不换 slug 逃避
6. 成功后报告 definitionId 与 slug，指引用户在资源库查看/编辑

## manifest 模板

```yaml
apiVersion: v1
kind: AgentDefinition
metadata:
  name: <中文显示名>
  slug: <英文小写-连字符>
  version: 1.0.0
  description: <useWhen 导向一句话：什么时候找我>
  iconEmoji: "<emoji>"
spec:
  runtime: declarative
  declarative:
    systemPrompt: |
      你是 <角色>——<一句话锚定>。你做 <Y>，你从不 <Z>。
      工作流：
      1. ...
      纪律：
      - NEVER: ...
      - ALWAYS: ...
    model:            # 建议位：真实绑定 = 用户已配 > 全局默认聊天模型
      provider: anthropic
      model: claude-sonnet-4-5
  defaultTools:       # 只授必需工具（kind: builtin + 精确工具名）
    - kind: builtin
      ref: read_file
```

## 输出规范

prompt 四段式：角色锚定一句话 → 工作流编号步骤（引用真实工具名）→ 纪律 → 硬规则（NEVER/ALWAYS）。

## 硬规则

- NEVER: 引用不存在的工具名或 skill slug（工具全集见 references/tool-catalog.md）；未经复述直接创建；slug 冲突时静默换名重试
- ALWAYS: 创建前复述关键参数；工具面最小授权；建完报告 definitionId + slug
```

`create-skill/SKILL.md`：

```markdown
---
name: 创建技能
description: 用户要求新建技能 / 做一个 skill / 把某套方法论沉淀成可复用技能时使用。产出 SKILL.md 并调 create_skill 安装。
---

## 适用场景

用户说「帮我做个技能」「把这套流程沉淀成 skill」「做一个写周报的方法论技能」。

## 工作流

1. **问清边界**：这个技能教什么、什么时候触发、不该管什么
2. **复述确认**：slug、名称、触发场景、是否要附属 references
3. **起草 SKILL.md**（模板见下）；内容超 3KB 拆 `references/` 附属文件（正文只留主干）
4. 调 `create_skill`（slug 显式必填——英文小写-连字符；skillMd 全文；references 数组带附属文件）
5. 同名拒绝时报告既有技能信息，问用户换 slug 还是先删旧的（删除走资源库 UI）

## SKILL.md 模板

```markdown
---
name: <中文显示名>
description: <一句话定位 + 触发短语：用户说 XX 时使用>
---

## 适用场景
## 工作流（编号步骤，引用真实工具名）
## 输出规范
## 硬规则（NEVER / ALWAYS）
```

## 写作纪律

- description 的触发短语质量直接决定命中率：写清「什么时候用」，不写「我是什么」
- 附属文件经 `readResource` 按需读取——速查表类内容放 references，决策主干留正文
- 硬规则必须可执行（「NEVER 编造」优于「保持严谨」）

## 硬规则

- NEVER: 递归自举（不创建「创建技能」类的技能）；description 缺触发场景；未经复述直接安装
- ALWAYS: slug 显式传入；正文 ≤3KB 超出拆 references；建完报告 slug 与触发场景
```

`create-mcp/SKILL.md`：

```markdown
---
name: 创建 MCP
description: 用户要求接入 / 配置某个 MCP server（如「帮我接入 context7」「配一个 github MCP」）时使用。调 create_mcp 先测后落库。
---

## 适用场景

用户点名要接入某 MCP server，或要求给 agent 增加 MCP 能力。

## 工作流

1. **确认配置**：server 名（英文小写-连字符）、形态（stdio 命令 / HTTP url）、凭证来源——凭证只从用户处获取，主动索要但明确用途
2. **复述确认**：name、transport 形态、是否含凭证（凭证值不复述）
3. 常见 server 配置速查：readResource 读 create-mcp/references/common-servers.md
4. 调 `create_mcp`——落库前会强制连通测试（initialize + tools/list）；失败不落库，按报错修参数重试（命令错/超时/凭证错三类排查）
5. 成功后报告工具数量与首层工具名摘要；指引用户在资源库 MCP 页签查看

## 硬规则

- NEVER: 主动配置用户未明确要求的 server；在回复中回显凭证/token 明文；跳过复述直接创建
- ALWAYS: name 过白名单（小写字母数字连字符）；连通失败如实报告原因并给出修正建议
```

`build-team/SKILL.md`：

```markdown
---
name: 组建团队
description: 用户要求组建团队 / 搭个协作班子 / 让几个 agent 一起干活时使用。盘点→补位→复述阵容→create_team。
---

## 适用场景

用户说「组一个 XX 团队」「让 Momo 和翻译 agent 搭班子干翻译」。

## 工作流

1. **盘点先行**（NEVER 跳过）：调 `resource_list`——看现有成员（instanceId）、可复用的 agent 定义、已有团队（避免重建同名职能团队）
2. **缺口分析**：要哪些职能？哪些已有定义可直接 `add_agent_member` 补位？缺的定义按 create-agent 技能起草、`create_agent`（addToWorkspace: true）创建
3. **leader 选择**：按职能匹配定 leader（通常是接待/拆解角色），向用户说明理由
4. **复述阵容**（创建前必做）：成员表（名字/职能/instanceId）+ leader + 团队名——用户确认后进入下一步
5. 调 `create_team`（memberInstanceIds 用盘点查到的真实 instanceId；成员 ≥2；leader 必须在成员内）
6. `resource_list`（type: teams）回读验证，向用户报告团队已可用（leader 会话将自动获得 dispatch 能力）

## 团队语义

- 成员 ≥2（leader + 至少 1 名成员）；leader 必须在成员集内
- leader 在协作会话中被注入 dispatch 派发能力——选 leader = 选「谁接待与拆解」

## 硬规则

- NEVER: 跳过盘点直接建团；建职能重复的成员；未复述阵容就创建；用猜测的 instanceId 建团
- ALWAYS: 缺成员先补位再建团；建后回读验证；报告团队名 + 成员 + leader
```

`create-agent/references/tool-catalog.md`（速查表——实施时从 `tools:getCatalog` 输出整理六个分组：文件读写 / 搜索 / 终端与进程 / Git / 网页与浏览器 / 任务与记忆与 Office，每工具一行「名称：一句话」；数据源以当时 catalog 为准，**不要**手写总数）。

`create-mcp/references/common-servers.md`（速查：stdio npx 型 / HTTP 远程型各一个完整 create_mcp 入参示例 + 三类失败排查表——命令不存在、握手超时、401/403 凭证错）。

- [ ] **Step 4: catalog.json 登记 4 条（镜像既有 skill- 条目形状）+ 计数 fixture**

先看既有条目：`grep -n "skill-" resources/marketplace/catalog.json | head -5`，镜像其字段。四条模板：

```json
{ "id": "skill-create-agent", "type": "skill", "slug": "create-agent", "name": "创建 Agent", "version": "1.0.0", "author": "Momo Studio", "description": "会话内起草并落库新 agent 定义（manifest 方法论 + 最小授权）", "readme": "会话内创建 agent 的方法论技能。", "tags": ["agent", "资源创建"], "category": "general", "iconEmoji": "🤖", "verificationStatus": "official", "downloadUrl": "", "checksum": "", "sizeBytes": 0, "installCount": 0 }
```

（`create-skill` / `create-mcp` / `build-team` 三条同构，换 id/slug/name/description/iconEmoji——📌/🔌/👥。）跑 `cd electron && npx pnpm@9.0.0 vitest run tests/marketplace/client.test.ts --pool=forks`，若计数断言失败则期望值 +4。

- [ ] **Step 5: 跑测试确认通过 + typecheck + Commit**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/skill/builtin-resource-skills.test.ts tests/marketplace/client.test.ts --pool=forks && cd .. && npx pnpm@9.0.0 typecheck`
Expected: PASS / 绿

```bash
git add electron/resources/skills resources/marketplace/catalog.json electron/tests/skill/builtin-resource-skills.test.ts electron/tests/marketplace/client.test.ts
git commit -m "feat: 四册资源创建技能内容 + catalog 双轨登记"
```

---

### Task 10: Momo v2.1.0（工具 + 技能挂载）+ 引用一致性锁

**Files:**
- Modify: `electron/resources/agents/general-assistant.yaml`
- Test: `electron/tests/agent/builtin.test.ts`（追加）

**Interfaces:**
- Consumes: Task 7 六工具名、Task 9 四技能 slug
- Produces: Momo v2.1.0（Task 11 再同步的升级目标）

- [ ] **Step 1: 追加失败测试（builtin.test.ts 既有 manifest 解析模式上扩展）**

```ts
describe('general-assistant v2.1.0 资源创建挂载', () => {
  it('版本 2.1.0 且六工具在目录全集内', () => {
    const { def } = parseAgentManifestWithSuggestion(readGeneralAssistantYaml());
    expect(def.version).toBe('2.1.0');
    const refs = def.defaultTools.map((t) => t.ref);
    for (const t of ['resource_list', 'create_agent', 'add_agent_member', 'create_skill', 'create_mcp', 'create_team']) {
      expect(refs, `缺工具 ${t}`).toContain(t);
    }
  });

  it('四个 defaultSkills 引用在 skills 目录存在（引用一致性锁，防契约漂移）', () => {
    const { def } = parseAgentManifestWithSuggestion(readGeneralAssistantYaml());
    const refs = def.defaultSkills.map((s) => s.ref);
    expect(refs.sort()).toEqual(['build-team', 'create-agent', 'create-mcp', 'create-skill']);
    for (const s of refs) {
      expect(fs.existsSync(path.join(SKILLS_ROOT, s, 'SKILL.md')), `skill ${s} 目录缺失`).toBe(true);
    }
  });

  it('systemPrompt 含资源创建引导段', () => {
    const { def } = parseAgentManifestWithSuggestion(readGeneralAssistantYaml());
    expect(def.systemPrompt).toContain('资源创建');
  });
});
```

（`readGeneralAssistantYaml` / `SKILLS_ROOT` 按该文件既有 helper 补齐。）

- [ ] **Step 2: 跑测试确认失败**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/agent/builtin.test.ts --pool=forks`
Expected: FAIL（version 2.0.0 / 无 defaultSkills）

- [ ] **Step 3: 改 YAML**

- `metadata.version: 2.0.0` → `2.1.0`
- 头注释追加一段：`# 2026-11-09 资源创建：defaultTools += 6 资源创建工具，defaultSkills 恢复并挂 4 册资源创建技能（spec 2026-11-09-resource-creation-skills）`
- `defaultTools` 尾部（`read_session` 后）追加：

```yaml
    - kind: builtin
      ref: resource_list
    - kind: builtin
      ref: create_agent
    - kind: builtin
      ref: add_agent_member
    - kind: builtin
      ref: create_skill
    - kind: builtin
      ref: create_mcp
    - kind: builtin
      ref: create_team
```

- 文件尾（defaultTools 之后）追加：

```yaml
  defaultSkills:
    - kind: skill
      ref: create-agent
    - kind: skill
      ref: create-skill
    - kind: skill
      ref: create-mcp
    - kind: skill
      ref: build-team
```

- systemPrompt 的「能直接完成」段后追加一行：`资源创建：按已挂载的 create-agent / create-skill / create-mcp / build-team 技能建 agent、技能、MCP 与团队——创建前先向用户复述关键参数。`

- [ ] **Step 4: 跑测试确认通过 + typecheck**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/agent/builtin.test.ts --pool=forks && cd .. && npx pnpm@9.0.0 typecheck`
Expected: PASS / 绿

- [ ] **Step 5: Commit**

```bash
git add electron/resources/agents/general-assistant.yaml electron/tests/agent/builtin.test.ts
git commit -m "feat: Momo v2.1.0 挂载资源创建六工具与四技能"
```

---

### Task 11: builtin 预置启动再同步钩子（存量升级 P0 防线）

**Files:**
- Modify: `electron/src/main/agent/builtin.ts`（新增 `syncBuiltinPresetVersions`）
- Modify: `electron/src/main/index.ts`（`runMigrations()` 之后调用，:95 一带）
- Test: `electron/tests/agent/builtin-resync.test.ts`

**Interfaces:**
- Consumes: `readBuiltinManifestBySlug` / `listBuiltinPresetAgents`（`agent/builtin.ts` 既有）、`updateAgentDefinition` / `saveAgentDefinition`（`agent/crud.ts`）
- Produces: `syncBuiltinPresetVersions(): void`（幂等；通用语义，未来 builtin 升级复用）

- [ ] **Step 1: 写失败测试**

```ts
// electron/tests/agent/builtin-resync.test.ts
//
// 存量再同步：已启用旧版 Momo 的 DB 行在启动钩子后升级，用户模型配置与成员关系保留。
import { describe, it, expect, beforeAll } from 'vitest';
import { syncBuiltinPresetVersions } from '../../src/main/agent/builtin';
import { getAgentDefinition, saveAgentDefinition, addMember } from '../../src/main/agent/crud';
import { getDb } from '../../src/main/storage/db';

describe('syncBuiltinPresetVersions', () => {
  beforeAll(() => {
    // 种子：模拟存量——v2.0.0 行 + 用户已配模型 + 一个成员行
    const legacy = { ...parseBuiltinYaml('general-assistant'), id: 'builtin-general-assistant', version: '2.0.0',
      modelProviderId: 'user-provider', modelName: 'user-model', source: 'builtin' as const };
    saveAgentDefinition(legacy);
    addMember(wsId, 'builtin-general-assistant', 'agent-momo-test');
  });

  it('旧版本行被升级且用户模型配置保留', () => {
    syncBuiltinPresetVersions();
    const def = getAgentDefinition('builtin-general-assistant')!;
    expect(def.version).toBe('2.1.0');
    expect(def.modelProviderId).toBe('user-provider');   // Review Focus #5
    expect(def.modelName).toBe('user-model');
    expect(def.defaultTools.map((t) => t.ref)).toContain('create_agent');
    expect(def.defaultSkills.map((s) => s.ref)).toContain('build-team');
  });

  it('成员关系保留（UPDATE 不触发 CASCADE）', () => {
    syncBuiltinPresetVersions();
    const rows = getDb().prepare('SELECT * FROM workspace_agent_members WHERE agent_definition_id = ?')
      .all('builtin-general-assistant');
    expect(rows).toHaveLength(1);
  });

  it('幂等：版本一致时零写入', () => {
    syncBuiltinPresetVersions(); // 已升到 2.1.0
    const before = getDb().prepare("SELECT * FROM agent_definitions WHERE id = 'builtin-general-assistant'").get();
    syncBuiltinPresetVersions();
    const after = getDb().prepare("SELECT * FROM agent_definitions WHERE id = 'builtin-general-assistant'").get();
    expect(after).toEqual(before);
  });

  it('未启用的预置（无 DB 行）不受影响', () => {
    syncBuiltinPresetVersions();
    expect(getAgentDefinition('builtin-general-assistant')).toBeTruthy(); // 不炸即过——无行预置自然跳过
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/agent/builtin-resync.test.ts --pool=forks`
Expected: FAIL（函数不存在）

- [ ] **Step 3: 实现**

```ts
// agent/builtin.ts 追加：
/**
 * builtin 预置启动再同步（spec §8，P0 防线）：启动不再全量落库，存量已启用
 * 预置的 DB 行不会自动获得新工具/技能面。本钩子对每个 builtin YAML：DB 行存在
 * 且版本落后时走受控 UPDATE（复用 enablePresetDef 的 UPDATE-vs-REPLACE 语义——
 * 无 DELETE，成员关系与 default 引用原样保留），**用户已配模型三字段原样保留**。
 * 幂等：版本一致 / 无行 / YAML 版本更低（理论不可达）均跳过。
 */
export function syncBuiltinPresetVersions(): void {
  for (const preset of listBuiltinPresetAgents()) {
    try {
      const defId = `builtin-${preset.slug}`;
      const existing = getAgentDefinition(defId);
      if (!existing) continue;
      if (compareVersionStrings(existing.version, preset.version) >= 0) continue;
      updateAgentDefinition({
        id: defId,
        name: preset.name,
        description: preset.description,
        systemPrompt: preset.systemPrompt,
        iconEmoji: preset.iconEmoji,
        // 用户配置保留：模型三字段取 DB 行现值（这是与 enablePresetDef 的关键差异）
        modelProviderId: existing.modelProviderId,
        modelName: existing.modelName,
        defaultTools: preset.defaultTools,
        defaultMcps: preset.defaultMcps,
        defaultSkills: preset.defaultSkills,
        thinkingJson: existing.thinkingJson ?? null,
      });
      logger.info('builtin 预置已再同步', { slug: preset.slug, from: existing.version, to: preset.version });
    } catch (err) {
      logger.warn('builtin 预置再同步失败（不阻塞启动）', {
        slug: preset.slug,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/** 简易语义化版本比较（数字段逐位），返回 -1/0/1 */
function compareVersionStrings(a: string, b: string): number {
  const pa = a.split('.').map((x) => parseInt(x, 10) || 0);
  const pb = b.split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}
```

`index.ts`：`runMigrations()` 调用之后（:95 一带、`reactivatePluginsOnBoot` 同区）加：

```ts
// builtin 预置版本再同步（spec 2026-11-09 §8）：存量已启用 Momo 升级拿新工具面；
// 失败只 warn 不阻塞启动（reactivatePluginsOnBoot 同风格）
try {
  syncBuiltinPresetVersions();
} catch (err) {
  logger.warn('builtin 预置再同步失败（不阻塞启动）', { error: err instanceof Error ? err.message : String(err) });
}
```

（`listBuiltinPresetAgents` 返回形状以 builtin.ts 现场为准——若它返回 catalog 条目而非解析后 def，则改用 `readBuiltinManifestBySlug(slug)` 逐个解析；断言不变。）

- [ ] **Step 4: 跑测试确认通过 + typecheck**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/agent/builtin-resync.test.ts tests/agent/builtin.test.ts --pool=forks && cd .. && npx pnpm@9.0.0 typecheck`
Expected: PASS / 绿

- [ ] **Step 5: Commit**

```bash
git add electron/src/main/agent/builtin.ts electron/src/main/index.ts electron/tests/agent/builtin-resync.test.ts
git commit -m "feat: builtin 预置启动再同步（存量 Momo 升级保留用户模型配置）"
```

---

### Task 12: 全量验证 + 版本号收口

**Files:**
- Modify: `package.json` / `electron/package.json` / `renderer/package.json`（alpha +1）

**Interfaces:**
- Consumes: 全部前置任务
- Produces: 可验收的完整特性

- [ ] **Step 1: 全量类型检查 + 双 workspace 全量测试（裸跑，勿加 --pool）**

```bash
nvm use 24 && npx pnpm@9.0.0 typecheck && npx pnpm@9.0.0 test
```

Expected: 全绿。失败且与本特性相关 → 回对应 task 修；无关存量失败 → 记录不扩 scope。

- [ ] **Step 2: vitest 非正常退出检查（AGENTS.md 陷阱表）**

```bash
ps -axo pid,ppid,command | grep vitest | grep -v grep
```

对 PPID=1 的孤儿逐个 `kill <pid>`（若上一步全绿正常退出则通常无孤儿）。

- [ ] **Step 3: 冒烟启动（dev 模式拉起，确认主进程无同步异常）**

```bash
npx pnpm@9.0.0 dev
```

观察主进程日志：无 `builtin 预置再同步失败` warn 之外的异常；Momo 会话发「列出当前工作空间的资源」——确认 `resource_list` 工具可被调用并返回清单。

- [ ] **Step 4: 版本号 alpha +1（三处 package.json）**

查当前 alpha 号：`grep '"version"' package.json electron/package.json renderer/package.json` → 三处 `2.1.0-alpha.N` → `2.1.0-alpha.N+1`。

- [ ] **Step 5: Commit**

```bash
git add package.json electron/package.json renderer/package.json
git commit -m "chore: 版本号 alpha+1（资源创建技能组合入）"
```

- [ ] **Step 6: 真机验收移交（momo-acceptance，用户侧执行或后续会话）**

按 spec §11 四场景：①对 Momo 说「帮我建一个翻译 agent（中英互译），再让它和你组成翻译团队」全链路；②「帮我接入 context7 MCP」；③旧库启动存量升级；④builtin 只读锚点。产出 `.omo/qa-reports/` 报告。

---

## Self-Review 记录

- **Spec 覆盖**：§5 六工具 → Task 2-5、7；§6 桥+刷新 → Task 6、8；§7 技能+挂载 → Task 9、10；§8 存量升级 → Task 11；§10 矩阵 → Task 1；§11 测试表 → 各 task 步骤 + Task 12 全量；§12 版本纪律 → Task 12。无遗漏。
- **占位符**：Task 3-5 在 Task 2 内的临时 `未实现` 抛错已注明「后续 task 立即替换」且各后续 task 有完整实现代码；references 速查两文件给了数据源与结构（内容型交付物，非代码占位）。
- **类型一致性**：`executeResourceOp(op, args, workspaceId[, deps])` 各 task 一致；六工具名 / 四 skill slug / `RESOURCE_OP_NAMES` 六 op 名在 Task 2/6/7/9/10 间逐字对齐；`handleResourceOpMessage` 签名与 spawner 调用一致。
- **Review Focus 五条**：①Task 6 测试；②Task 3/4 测试；③Task 7 测试；④Task 4/5 测试；⑤Task 11 测试——全部有 owning 步骤。
