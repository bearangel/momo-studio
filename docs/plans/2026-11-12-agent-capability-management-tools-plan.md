# 会话内 agent 能力管理工具 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把会话内资源工具从「只能创建」补成「能管理既有」——成员级/定义级能力增减、skill/MCP 更新、读面补全、扩权确认通道、自动重启生效。

**Architecture:** 细粒度 5 工具（`describe_agent` / `update_agent_capabilities` / `update_agent_profile` / `update_skill` / `update_mcp`）经既有 resource-ops 白名单桥（7→12 op）在主进程执行；确认门在桥内（`executeResourceOp` 前），子进程无法绕过；member 级 delta 复用 `setAssignmentDeltas`，definition 级复用 `updateAgentDefinition` + 停机链；生效走 stop+`ensureMemberRuntime`（= UI 立即重启）或 respawn-on-idle（自改）。

**Tech Stack:** Electron 主进程（CommonJS + better-sqlite3）、React renderer（Vite ESM）、vitest 双 workspace、内联 SQL migration。

**Spec:** `docs/specs/2026-11-12-agent-capability-management-tools-design.md`（含 7 条用户裁定链与 16 条事实锚，执行前必读）

## Global Constraints

- Node 24（`nvm use 24`）；包管理一律 `npx pnpm@9.0.0`
- TypeScript strict：禁 `any` / `@ts-ignore` / `as any`（ESLint no-explicit-any: error）
- 所有代码注释、文档中文；标识符英文；Conventional Commits（`feat:` / `test:` / `docs:` / `chore:`）
- 版本纪律：**只在 Task 15 把三处 `package.json` alpha +1**，此前任何任务不动版本号
- 单测位置：electron 主进程测试集中 `electron/tests/` 镜像 `src/` 结构；renderer 贴源 colocated（配置显式 include，放别处不执行）
- DB 重度测试目录（tests/agent、tests/storage）单跑显式 `--pool=forks`；全量回归**裸 `vitest run`**（CLI --pool 会掰坏 projects 双池）
- IPC 面改动（preload 三层引用 renderer types.d.ts）→ 双 workspace typecheck 必须过
- renderer UI：语义 token（`bg-surface-*` / `text-secondary`）、lucide-react 图标 16px / stroke 1.75、禁 emoji 图标、禁硬编码颜色（Task 12 属 P1 级 UI，先预览过审再实现）
- 测试纪律：加载 `momo-test-rules`（业务逻辑用真实实现，不 mock DB；mock 只打 runtime/electron 边界）；桥/IPC 任务加载 `momo-boundary-rules`
- 每个 Task 结束跑该 Task 的测试文件；Task 15 才跑全量

## Review Focus

1. **确认等待期目标 child 被停**（用户停 agent / 关会话）→ pending 表按 childKey 清空、子进程侧收到拒绝而非悬挂 → Task 9 用例 `child 退出清空 pending 并按拒绝收敛`
2. **多窗口/双击同时处置**同一确认卡 → 只执行一次 → Task 9 用例 `先到先得：迟到的 reply 是 no-op`
3. **add 的 ref 恰好已在 L1**（定义自带）→ 新 delta 不产生冗余 added 条目 → Task 2 parity 用例（parity-3）
4. **updateSkill references 含 `../` 越界路径** → 拒绝且零落盘（目录不留半成品）→ Task 7 用例 `references 越界拒绝且零落盘`
5. **后台链信号必须来自 spawn 闭包**而非子进程消息体（子进程不可伪造归属/身份）→ Task 10 用例 `background 取自 ctx 闭包而非消息体`

---

### Task 1: 消费面矩阵落盘（实现前置门禁）

**Files:**
- Create: `.omo/feature-matrices/2026-11-12-agent-capability-management.md`（gitignored，落盘即产物）

**Interfaces:**
- Consumes: spec §12 摘要表、`momo-feature-scope-rules` W1–W5
- Produces: 矩阵文件（后续任务的消费面裁定依据；Task 15 验收回填证据列）

- [ ] **Step 1: 跑 W1 三锚 grep 并把输出整理进矩阵「W1 消费点清单」节**

```bash
# 锚① 能力名消费点
grep -rn "updateCapabilities\|updateProfile\|updateSkill\|updateMcp\|describeAgent\|agent-op-confirm" electron/src renderer/src --include="*.ts" --include="*.tsx" | grep -v "\.test\."
# 锚② 展示动词面（资源目录 / 候选列表 / 页签）
grep -rnE "tools:getCatalog|CapabilityTabs|resource:changed|MEMBER_AFFECTING" electron/src/main renderer/src --include="*.ts" --include="*.tsx" | grep -v "\.test\."
# 锚③ 状态读取点（本次无状态翻转类改动——写「不适用：纯新增能力面，无既有状态判定函数语义变化」）
```

- [ ] **Step 2: 写矩阵主体**——行 = W1 清单逐点 + 四类展示面（资源目录页签 / 选择器候选 / 命令引用入口 / 各编辑器）；列 = 新建 / 存量 / builtin 只读；每格「改/不改 + 理由」，空格必须写理由。四类展示面至少各一行（spec §12 已给摘要，展开成格）
- [ ] **Step 3: 写「反查」节**（W1 清单 ∖ 矩阵行 的差集，逐点裁定或显式写「差集为空」）
- [ ] **Step 4: 写「门禁」节**——W4 八问逐项作答（⑦ 生效层 = spawn 装配 + MCP 池驱逐 + respawn-on-idle，可见层 = 目录 / 成员编辑 / 资源库页签，两层分别裁定；⑧ = Task 15 的存量迁移场景 + builtin 只读场景）
- [ ] **Step 5: 确认矩阵存在且四类展示面各有行**

Run: `test -f .omo/feature-matrices/2026-11-12-agent-capability-management.md && grep -c "资源目录\|选择器候选\|命令引用\|编辑器" .omo/feature-matrices/2026-11-12-agent-capability-management.md`
Expected: 计数 ≥ 4

---

### Task 2: delta 纯函数模块 + parity 契约锁

**Files:**
- Create: `electron/src/main/agent/resource-ops-delta.ts`（**零 electron import 的纯模块**——parity 测试要跨 workspace 引 renderer lib）
- Test: `electron/tests/agent/resource-ops-delta-parity.test.ts`

**Interfaces:**
- Consumes: 类型 `AssignmentDeltas`（`./assignment-capabilities`，type-only import 不算运行时依赖）、`MergedCapabilities`（`./capability-merger` type-only）
- Produces（后续 Task 5 依赖，签名不得漂移）:

```ts
export interface CapabilityDeltaInput { skills?: string[]; mcps?: string[]; tools?: string[]; pluginTools?: string[] }
export interface CapabilityChangeRequest { add?: CapabilityDeltaInput; remove?: CapabilityDeltaInput }
export interface DeltaBaseline {
  tools: string[]; mcps: string[]; skills: string[];
  /** L1∪L2 基线中已授权的 plugin: refs（ws 授予 ∪ def 声明 − def 禁用） */
  baseGrantedPlugin: string[];
}
export interface EffectiveState {
  tools: string[]; mcps: string[]; skills: string[];
  /** 当前生效的 plugin: refs */
  grantedPlugin: string[];
}
export function applyCapabilityDelta(base: DeltaBaseline, current: EffectiveState, req: CapabilityChangeRequest): AssignmentDeltas
```

- [ ] **Step 1: 写失败测试**（沿 resource-ops.test.ts 头部夹具风格说明；本文件**不需要 DB**——纯函数测试）

```ts
// electron/tests/agent/resource-ops-delta-parity.test.ts
// 契约锁（spec §6.4）：主进程 applyCapabilityDelta 与 renderer computeDeltas 同语义。
// capability-helpers.ts 为纯 TS（无 DOM 依赖），跨 workspace 相对导入在 vitest 可行。
import { describe, it, expect } from 'vitest';
import { applyCapabilityDelta } from '../../src/main/agent/resource-ops-delta';
import { computeDeltas, EMPTY_DELTAS } from '../../../renderer/src/lib/capability-helpers';

const base = { tools: ['read_file'], mcps: [], skills: ['create-agent'], baseGrantedPlugin: ['plugin:office/run_js'] };

describe('applyCapabilityDelta 纯语义', () => {
  it('add 已在基线的 ref 不产生冗余 added 条目', () => {
    const out = applyCapabilityDelta(
      base,
      { tools: ['read_file'], mcps: [], skills: ['create-agent'], grantedPlugin: ['plugin:office/run_js'] },
      { add: { skills: ['create-agent'] } },
    );
    expect(out.addedSkills).toEqual([]);   // 已在 L1，无需 delta
    expect(out.removedSkills).toEqual([]);
  });

  it('remove 基线自有 ref 记入 removed（member 分支语义）', () => {
    const out = applyCapabilityDelta(
      base,
      { tools: ['read_file'], mcps: [], skills: ['create-agent'], grantedPlugin: ['plugin:office/run_js'] },
      { remove: { tools: ['read_file'] } },
    );
    expect(out.removedTools).toEqual(['read_file']);
    expect(out.addedTools).toEqual([]);
  });

  it('同 ref 同现 add+remove → remove 胜（与 mergeCapabilities 保守语义对齐）', () => {
    const out = applyCapabilityDelta(
      base,
      { tools: [], mcps: [], skills: [], grantedPlugin: [] },
      { add: { tools: ['bash'] }, remove: { tools: ['bash'] } },
    );
    expect(out.addedTools).toEqual([]);
    expect(out.removedTools).toEqual([]); // 既非基线也无净变化
  });

  it('plugin 双向：remove 基线授权 → removedPluginTools；再 add 新插件 → addedPluginTools', () => {
    const out = applyCapabilityDelta(
      base,
      { tools: ['read_file'], mcps: [], skills: [], grantedPlugin: ['plugin:office/run_js'] },
      { add: { pluginTools: ['plugin:email/send'] }, remove: { pluginTools: ['plugin:office/run_js'] } },
    );
    expect(out.addedPluginTools).toEqual(['plugin:email/send']);
    expect(out.removedPluginTools).toEqual(['plugin:office/run_js']);
  });

  it('空请求 → 全空 deltas（no-op）', () => {
    const out = applyCapabilityDelta(base, { tools: ['read_file'], mcps: [], skills: [], grantedPlugin: [] }, {});
    expect(out).toEqual({ ...EMPTY_DELTAS, addedPluginTools: [], removedPluginTools: [] });
  });
});

describe('parity：与 renderer computeDeltas 同输入同输出（spec §6.4 同源铁律）', () => {
  const cases: Array<{ name: string; base: ReturnType<typeof mkCaps>; value: ReturnType<typeof mkCaps> }> = [];
  const mkCaps = (t: string[], m: string[], s: string[]) => ({ tools: t, mcps: m, skills: s });

  it('parity-1 加新技能后 effective 集 → 双侧 deltas 全等', () => {
    const value = mkCaps(['read_file'], [], ['create-agent', 'weather']);
    cases.push({ name: 'p1', base: mkCaps(base.tools, [], ['create-agent']), value });
    const ours = applyCapabilityDelta(
      { ...base, baseGrantedPlugin: [] },
      { tools: base.tools, mcps: [], skills: ['create-agent'], grantedPlugin: [] },
      { add: { skills: ['weather'] } },
    );
    const theirs = computeDeltas(value, mkCaps(base.tools, [], ['create-agent']));
    expect({ a: ours.addedSkills, r: ours.removedSkills }).toEqual({ a: theirs.addedSkills, r: theirs.removedSkills });
    expect(ours.addedSkills).toEqual(['weather']);
  });

  it('parity-2 既有 added 被撤销 → added 剔除而非记 removed', () => {
    // 现状：weather 是旧 delta 加进来的（不在基线）；remove weather 后应回到全空
    const ours = applyCapabilityDelta(
      { ...base, skills: ['create-agent'], baseGrantedPlugin: [] },
      { tools: base.tools, mcps: [], skills: ['create-agent', 'weather'], grantedPlugin: [] },
      { remove: { skills: ['weather'] } },
    );
    const theirs = computeDeltas(mkCaps(base.tools, [], ['create-agent']), mkCaps(base.tools, [], ['create-agent']));
    expect(ours.addedSkills).toEqual([]);
    expect(ours.removedSkills).toEqual([]);
    expect(theirs.addedSkills).toEqual([]);
  });

  it('parity-3 基线自带 ref 被 remove → removed 记录（双侧一致）', () => {
    const ours = applyCapabilityDelta(
      { ...base, baseGrantedPlugin: [] },
      { tools: base.tools, mcps: [], skills: ['create-agent'], grantedPlugin: [] },
      { remove: { skills: ['create-agent'] } },
    );
    const theirs = computeDeltas(mkCaps(base.tools, [], []), mkCaps(base.tools, [], ['create-agent']));
    expect(ours.removedSkills).toEqual(['create-agent']);
    expect(theirs.removedSkills).toEqual(['create-agent']);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/agent/resource-ops-delta-parity.test.ts --pool=forks`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现纯函数**

```ts
// electron/src/main/agent/resource-ops-delta.ts
// member 级能力增量计算的单一真相源（spec §6.4）。
// 铁律：本模块零运行时 import（类型除外）——parity 测试跨 workspace 引 renderer
// capability-helpers，任何 electron 依赖都会把渲染层测试环境拽进来。
// 语义对齐 renderer computeDeltas：新终态 = (现状 ∪ add) − remove；
// deltas = 终态相对基线的差（added = 终态−基线，removed = 基线−终态）。
import type { AssignmentDeltas } from './assignment-capabilities';

export interface CapabilityDeltaInput { skills?: string[]; mcps?: string[]; tools?: string[]; pluginTools?: string[] }
export interface CapabilityChangeRequest { add?: CapabilityDeltaInput; remove?: CapabilityDeltaInput }
export interface DeltaBaseline { tools: string[]; mcps: string[]; skills: string[]; baseGrantedPlugin: string[] }
export interface EffectiveState { tools: string[]; mcps: string[]; skills: string[]; grantedPlugin: string[] }

function union(a: string[], b: string[]): string[] { return [...new Set([...a, ...b])]; }
function subtract(a: string[], b: string[]): string[] { const s = new Set(b); return a.filter((x) => !s.has(x)); }

/** 数组入参归一：非数组或含非字符串项 → undefined（调用方 fail-fast 已挡，这里防御归一） */
function refs(v: unknown): string[] { return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []; }

export function applyCapabilityDelta(base: DeltaBaseline, current: EffectiveState, req: CapabilityChangeRequest): AssignmentDeltas {
  // 终态 = (现状 ∪ add) − remove（union→subtract 顺序天然保证「同 ref add+remove → remove 胜」）
  const add = req.add ?? {};
  const rm = req.remove ?? {};
  const nextTools = subtract(union(current.tools, refs(add.tools)), refs(rm.tools));
  const nextMcps = subtract(union(current.mcps, refs(add.mcps)), refs(rm.mcps));
  const nextSkills = subtract(union(current.skills, refs(add.skills)), refs(rm.skills));
  const nextPlugin = subtract(union(current.grantedPlugin, refs(add.pluginTools)), refs(rm.pluginTools));
  return {
    addedTools: subtract(nextTools, base.tools),
    removedTools: subtract(base.tools, nextTools),
    addedMcps: subtract(nextMcps, base.mcps),
    removedMcps: subtract(base.mcps, nextMcps),
    addedSkills: subtract(nextSkills, base.skills),
    removedSkills: subtract(base.skills, nextSkills),
    addedPluginTools: subtract(nextPlugin, base.baseGrantedPlugin),
    removedPluginTools: subtract(base.baseGrantedPlugin, nextPlugin),
  };
}
```

- [ ] **Step 4: 跑测试确认全绿**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/agent/resource-ops-delta-parity.test.ts --pool=forks`
Expected: PASS（全部用例）

- [ ] **Step 5: Commit**

```bash
git add electron/src/main/agent/resource-ops-delta.ts electron/tests/agent/resource-ops-delta-parity.test.ts
git commit -m "feat: 会话内能力管理——member 级 delta 纯函数与 renderer 同源契约锁"
```

---

### Task 3: `describeAgent` op（读面先行）

**Files:**
- Modify: `electron/src/main/agent/resource-ops.ts`（RESOURCE_OP_NAMES + 分发 + op 实现）
- Test: `electron/tests/agent/resource-ops.test.ts`（扩 describe 块，复用既有 beforeEach 夹具）

**Interfaces:**
- Consumes: `getMemberByInstanceId` / `listMembers`（`./agent-queries`）、`getAgentDefinition`、`getEffectiveCapabilities` 同源三件套（`readAllocationLayer` / `readAssignmentDeltas` / `mergeCapabilities`）
- Produces: `RESOURCE_OP_NAMES` 含 `'describeAgent'`；`executeResourceOp('describeAgent', { agent }, wsId)` 返回 spec §5.1 形状；另导出内部复用的目标解析函数：

```ts
/** agent 入参解析（describe/updateCapabilities/updateProfile 共用）：instanceId → 成员表 definitionId 匹配 → slug 反查 */
export function resolveAgentTarget(agent: string, workspaceId: string): { member: WorkspaceAgentMember; def: AgentDefinition } | null
```

- [ ] **Step 1: 写失败测试**（追加到 resource-ops.test.ts；夹具已有 m1（ws-r/def-a 成员））

```ts
describe('describeAgent（读面）', () => {
  it('instanceId 直查：定义 + 生效集 + 三层归因 + 跨 ws 计数', async () => {
    const r = await executeResourceOp('describeAgent', { agent: m1 }, wsId);
    expect(r).toMatchObject({
      definition: { id: 'def-a', slug: 'agent-a', name: '甲', source: 'builtin' },
      member: { instanceId: m1 },
    });
    // def-a 无 defaultTools/Mcps/Skills 夹具值 → attribution 三段可断言空集形状
    expect(r.attribution).toHaveProperty('fromDefinition');
    expect(r.attribution).toHaveProperty('memberAdded');
    expect(typeof r.otherWorkspaceMembers).toBe('number');
  });

  it('slug 反查：当前 ws 内按 slug 定位唯一成员', async () => {
    const r = await executeResourceOp('describeAgent', { agent: 'agent-a' }, wsId);
    expect(r.member.instanceId).toBe(m1);
  });

  it('查无目标报可行动错误', async () => {
    await expect(executeResourceOp('describeAgent', { agent: 'no-such' }, wsId)).rejects.toThrow('resource_list');
  });

  it('member delta 反映进 attribution.memberAdded', async () => {
    getDb().prepare(
      `INSERT INTO agent_assignment_capabilities (assignment_id, capability_type, mode, ref) VALUES (?, 'skill', 'add', 'weather')`,
    ).run(m1);
    const r = await executeResourceOp('describeAgent', { agent: m1 }, wsId);
    expect(r.attribution.memberAdded).toContain('weather');
    expect(r.effective.skills).toContain('weather');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/agent/resource-ops.test.ts --pool=forks`
Expected: FAIL（`未知 resource op: describeAgent`）

- [ ] **Step 3: 实现**——`RESOURCE_OP_NAMES` 数组追加 `'describeAgent'`；分发 switch 加 `case 'describeAgent': return opDescribeAgent(a, workspaceId);`；实现：

```ts
// ── describeAgent（读面，spec §5.1）──
export interface DescribeAgentResult {
  definition: { id: string; slug: string; name: string; source: string; modelProviderId: string; modelName: string;
    defaultTools: Array<{ kind: string; ref: string }>; defaultMcps: unknown[]; defaultSkills: unknown[];
    deniedTools: string[] };
  member: { instanceId: string; running: boolean };
  effective: { tools: string[]; mcps: string[]; skills: string[] };
  attribution: { fromDefinition: string[]; fromWorkspace: string[]; memberAdded: string[]; memberRemoved: string[] };
  otherWorkspaceMembers: number;
}

export function resolveAgentTarget(agent: string, workspaceId: string): { member: WorkspaceAgentMember; def: AgentDefinition } | null {
  const byInstance = getMemberByInstanceId(agent);
  if (byInstance) {
    const def = getAgentDefinition(byInstance.agentDefinitionId);
    if (def) return { member: byInstance, def };
    return null;
  }
  const byDefId = listMembers(workspaceId).find((m) => m.agentDefinitionId === agent);
  if (byDefId) {
    const def = getAgentDefinition(byDefId.agentDefinitionId);
    if (def) return { member: byDefId, def };
  }
  const bySlugDef = listAgentDefinitions().find((d) => d.slug === agent);
  if (bySlugDef) {
    const m = listMembers(workspaceId).find((x) => x.agentDefinitionId === bySlugDef.id);
    if (m) return { member: m, def: bySlugDef };
  }
  return null;
}

function opDescribeAgent(a: Record<string, unknown>, workspaceId: string): DescribeAgentResult {
  const key = str(a['agent'], 'agent');
  const target = resolveAgentTarget(key, workspaceId);
  if (!target) throw new Error(`未找到 agent 成员: ${key}（可先 resource_list 查询真实 instanceId/slug）`);
  const { member, def } = target;
  const alloc = readAllocationLayer(member.workspaceId);
  const deltas = readAssignmentDeltas(member.instanceId);
  const merged = mergeCapabilities(def, alloc, deltas);
  const defRefs = [
    ...def.defaultTools.map((t) => t.ref),
    ...def.defaultMcps.map((m) => m.ref),
    ...def.defaultSkills.map((s) => s.ref),
  ];
  const wsRefs = [...alloc.tools, ...alloc.mcps, ...alloc.skills];
  const otherWs = getDb()
    .prepare('SELECT COUNT(DISTINCT workspace_id) AS n FROM workspace_agent_members WHERE agent_definition_id = ? AND workspace_id != ?')
    .get(def.id, member.workspaceId) as { n: number };
  return {
    definition: {
      id: def.id, slug: def.slug, name: def.name, source: def.source,
      modelProviderId: def.modelProviderId, modelName: def.modelName,
      defaultTools: def.defaultTools, defaultMcps: def.defaultMcps, defaultSkills: def.defaultSkills,
      deniedTools: def.deniedTools ?? [],
    },
    member: { instanceId: member.instanceId, running: member.lastRunning },
    effective: { tools: merged.tools, mcps: merged.mcps, skills: merged.skills },
    attribution: {
      fromDefinition: defRefs,
      fromWorkspace: wsRefs.filter((r) => !defRefs.includes(r)),
      memberAdded: [...deltas.addedTools, ...deltas.addedMcps, ...deltas.addedSkills, ...deltas.addedPluginTools],
      memberRemoved: [...deltas.removedTools, ...deltas.removedMcps, ...deltas.removedSkills, ...deltas.removedPluginTools],
    },
    otherWorkspaceMembers: otherWs.n,
  };
}
```

import 追加：`WorkspaceAgentMember / AgentDefinition`（`./types`）、`getMemberByInstanceId`（`./agent-queries`）、`mergeCapabilities / readAllocationLayer / readAssignmentDeltas`（`./capability-merger`）。

- [ ] **Step 4: 跑测试确认全绿**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/agent/resource-ops.test.ts --pool=forks`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add electron/src/main/agent/resource-ops.ts electron/tests/agent/resource-ops.test.ts
git commit -m "feat: 会话内能力管理——describeAgent 读面（定义+生效集+三层归因+跨工作空间计数）"
```

---

### Task 4: respawn-on-idle 机制（runtime-registry）

**Files:**
- Modify: `electron/src/main/agent/runtime-registry.ts`（pendingRespawn + onIdle 包装 + stop 清除）
- Test: `electron/tests/agent/resource-ops-restart.test.ts`（Create；本文件测 registry 与 op 两侧，Task 5 继续扩）

**Interfaces:**
- Consumes: `stopAgentRuntime`（同文件既有）、`ensureMemberRuntime`（`./start-chain`——注意 import 环：start-chain 已 import runtime-registry，本文件须**动态 import** 打破回环，与 resource-ops-bridge 同款纪律）
- Produces（Task 5 依赖）:

```ts
/** 标记成员回合归零后自动 stop+拉起（spec §8 自改场景）。幂等。 */
export function requestRespawnAfterIdle(instanceId: string): void
```

- [ ] **Step 1: 写失败测试**

```ts
// electron/tests/agent/resource-ops-restart.test.ts
// restart 语义双面测试（spec §8）：本 Task 覆盖 respawn-on-idle 机制；Task 5 扩 op 三行场景。
// 沿 resource-ops.test.ts 夹具；registry 依赖 mock 打在运行时边界。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';

vi.mock('../../src/main/agent/runtime-status', () => ({ isAgentRunning: vi.fn(() => false) }));

const tmpRoot = path.join(os.tmpdir(), `ap-restart-${Date.now()}`);
let wsId = ''; let m1 = '';

beforeEach(async () => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  const db = getDb();
  db.prepare(`INSERT INTO workspaces (id, name, description, directory_path, git_initialized, owner_id, icon_emoji)
              VALUES (?, 'w', '', '/tmp', 0, '@o:s', '📁')`).run('ws-x');
  db.prepare(`INSERT INTO agent_definitions (id, name, slug, version, system_prompt, model_name)
              VALUES ('def-1', '一', 'agent-1', '1', 'p', 'm')`).run();
  const row = db.prepare(`INSERT INTO workspace_agent_members (workspace_id, agent_definition_id, agent_user_id)
                          VALUES ('ws-x', 'def-1', '@a:1')`).run();
  m1 = row.lastInsertRowid as string;
  wsId = 'ws-x';
});
afterEach(() => { closeDb(); fs.rmSync(tmpRoot, { recursive: true, force: true }); delete process.env.AP_USER_DATA_DIR; });

describe('respawn-on-idle（runtime-registry）', () => {
  it('requestRespawnAfterIdle 幂等登记；idle 边沿触发 stop + 拉起', async () => {
    vi.resetModules();
    const ensure = vi.fn();
    vi.doMock('../../src/main/agent/start-chain', () => ({ ensureMemberRuntime: ensure }));
    const reg = await import('../../src/main/agent/runtime-registry');
    const stopSpy = vi.spyOn(reg, 'stopAgentRuntime').mockResolvedValue(undefined);
    reg.requestRespawnAfterIdle(m1);
    reg.requestRespawnAfterIdle(m1); // 幂等
    await reg.__drainRespawnQueueForTest(); // 测试后门：直接驱动 idle 处理（避免依赖真实 runner）
    expect(stopSpy).toHaveBeenCalledWith(m1);
    expect(ensure).toHaveBeenCalledWith(m1);
  });

  it('stopAgentRuntime 清除 pending 标记（防 stop→idle→重复 respawn）', async () => {
    vi.resetModules();
    vi.doMock('../../src/main/agent/start-chain', () => ({ ensureMemberRuntime: vi.fn() }));
    const reg = await import('../../src/main/agent/runtime-registry');
    const stopSpy = vi.spyOn(reg, 'stopAgentRuntime').mockResolvedValue(undefined);
    reg.requestRespawnAfterIdle(m1);
    await reg.stopAgentRuntime(m1);
    await reg.__drainRespawnQueueForTest();
    expect(stopSpy).toHaveBeenCalledTimes(1); // 只剩手动那次
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/agent/resource-ops-restart.test.ts --pool=forks`
Expected: FAIL（requestRespawnAfterIdle 不存在）

- [ ] **Step 3: 实现**（runtime-registry.ts 追加；`registerTaskDrivenRuntime` 的 `onIdle` 改为包装）：

```ts
// ── respawn-on-idle（spec §8）：自改场景的回合后换芯 ──
const pendingRespawn = new Set<string>();

export function requestRespawnAfterIdle(instanceId: string): void {
  pendingRespawn.add(instanceId);
  logger.info('登记回合后 respawn', { instanceId });
}

/** idle 边沿处理（runner onIdle 末尾调用；测试后门 __drainRespawnQueueForTest 同体） */
export async function drainRespawnQueue(instanceId: string): Promise<void> {
  if (!pendingRespawn.has(instanceId)) return;
  pendingRespawn.delete(instanceId);
  try {
    await stopAgentRuntime(instanceId);
    // 动态 import 打破 start-chain ↔ runtime-registry 回环（resource-ops-bridge 同款纪律）
    const { ensureMemberRuntime } = await import('./start-chain');
    await ensureMemberRuntime(instanceId);
    logger.info('respawn 完成（idle 边沿）', { instanceId });
  } catch (err) {
    logger.warn('respawn 失败（保留停止态，下次派发自然拉起）', { instanceId, error: String(err) });
  }
}

/** 测试后门：不经真实 runner 直接驱动 idle 处理 */
export async function __drainRespawnQueueForTest(instanceId?: string): Promise<void> {
  if (instanceId) return drainRespawnQueue(instanceId);
  for (const id of [...pendingRespawn]) await drainRespawnQueue(id);
}
```

- `stopAgentRuntime`（`runtime-registry.ts:268`）函数体首行加 `pendingRespawn.delete(instanceId);`
- `registerTaskDrivenRuntime` 的 runner 构造里 `onIdle: notifyRunnerIdle` 改为：

```ts
onIdle: (assignmentId, forcedExit, roundStartedAt) => {
  notifyRunnerIdle(assignmentId, forcedExit, roundStartedAt);
  void drainRespawnQueue(assignmentId);
},
```

- [ ] **Step 4: 跑测试确认全绿**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/agent/resource-ops-restart.test.ts --pool=forks`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add electron/src/main/agent/runtime-registry.ts electron/tests/agent/resource-ops-restart.test.ts
git commit -m "feat: 会话内能力管理——respawn-on-idle（自改场景回合后换芯）"
```

---

### Task 5: `updateCapabilities` op（含 restart 接线）

**Files:**
- Modify: `electron/src/main/agent/resource-ops.ts`
- Test: `electron/tests/agent/resource-ops.test.ts`（扩 updateCapabilities 块）

**Interfaces:**
- Consumes: Task 2 `applyCapabilityDelta`、Task 3 `resolveAgentTarget`、Task 4 `requestRespawnAfterIdle`（动态 import `./runtime-registry`）、既有 `setAssignmentDeltas` / `updateAgentDefinition` / `stopRunningInstancesByDefinition`（`./crud:608`）/ `stopAgentRuntime` + `ensureMemberRuntime` / `isAgentRunning`（`./runtime-status`）/ `collectKnownToolNames`（`./known-tool-names`）/ `listInstalled`（`../skill/zip-uploader`）/ `listRegistered`（`../mcp/host-manager`）
- Produces: op `'updateCapabilities'`；`executeResourceOp` 第 4 参扩 `OpContext`（本 Task 只定义类型并透传，桥接线在 Task 10）：

```ts
export interface OpContext { background: boolean; callerInstanceId?: string }
export async function executeResourceOp(op: string, args: unknown, workspaceId: string, deps?: ResourceOpDeps, ctx?: OpContext): Promise<unknown>
```

- [ ] **Step 1: 写失败测试**（追加 describe 块；夹具沿用。skill 夹具：`fs.mkdirSync(path.join(getSkillsDir(), 'weather')); fs.writeFileSync(path.join(getSkillsDir(), 'weather', 'SKILL.md'), '---\nname: w\ndescription: d\n---\nb')`；builtin ref 校验用已知名 `'read_file'`——若 `collectKnownToolNames` 在测试环境不可用则沿既有 mock 纪律 mock 之）

```ts
describe('updateCapabilities', () => {
  const seedSkill = (slug: string): void => {
    const dir = path.join(getSkillsDir(), slug);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${slug}\ndescription: d\n---\nbody`);
  };

  it('member 加 skill：delta 落库 + restart=deferred 返回 needsRestart', async () => {
    seedSkill('weather');
    const r = await executeResourceOp('updateCapabilities',
      { agent: m1, add: { skills: ['weather'] }, restart: 'deferred' }, wsId, undefined, { background: false });
    expect(r.appliedTo).toBe('member');
    expect(r.needsRestart).toBe(true);
    const deltas = getDb().prepare('SELECT * FROM agent_assignment_capabilities WHERE assignment_id = ?').all(m1);
    expect(deltas.some((d) => d.ref === 'weather' && d.mode === 'add')).toBe(true);
  });

  it('ref 校验 fail-fast：全部非法项一次报出，零落库', async () => {
    seedSkill('weather');
    await expect(executeResourceOp('updateCapabilities',
      { agent: m1, add: { skills: ['weather', 'ghost-skill'], tools: ['no_such_tool'] } }, wsId))
      .rejects.toThrow(/ghost-skill.*no_such_tool|no_such_tool.*ghost-skill/s);
    const n = getDb().prepare('SELECT COUNT(*) c FROM agent_assignment_capabilities').get() as { c: number };
    expect(n.c).toBe(0);
  });

  it('scope=definition 且 builtin 定义 → 拒绝并指路 member/UI', async () => {
    await expect(executeResourceOp('updateCapabilities',
      { agent: m1, scope: 'definition', add: { skills: [] }, remove: {} }, wsId))
      .rejects.toThrow('builtin');
  });

  it('definition 分支（custom def）：增量落 def.defaultSkills + 停机返回 stoppedInstances', async () => {
    seedSkill('weather');
    // 造 custom def + 成员（夹具 def-a 是 builtin 源——insert source 缺省值确认后按实际补 'custom'）
    getDb().prepare(`INSERT INTO agent_definitions (id, name, slug, version, system_prompt, model_name, source)
                     VALUES ('def-custom', '自', 'agent-custom', '1', 'p', 'm', 'custom')`).run();
    const cm = (await addMember(wsId, 'def-custom', '@c:1')).instanceId;
    const r = await executeResourceOp('updateCapabilities',
      { agent: cm, scope: 'definition', add: { skills: ['weather'] } }, wsId);
    expect(r.appliedTo).toBe('definition');
    expect(typeof r.stoppedInstances).toBe('number');
    const def = getDb().prepare('SELECT default_skills FROM agent_definitions WHERE id = ?').get('def-custom');
    expect(JSON.parse(def.default_skills)).toEqual([{ kind: 'skill', ref: 'weather' }]);
  });

  it('otherWorkspaceMembers：另一 ws 同 def 成员计数', async () => {
    seedSkill('weather');
    getDb().prepare(`INSERT INTO workspaces (id, name, description, directory_path, git_initialized, owner_id, icon_emoji)
                     VALUES ('ws-2', '二', '', '/tmp', 0, '@o:s', '📁')`).run();
    await addMember('ws-2', 'def-a', '@a:2');
    const r = await executeResourceOp('updateCapabilities',
      { agent: m1, add: { skills: ['weather'] }, restart: 'deferred' }, wsId, undefined, { background: false });
    expect(r.otherWorkspaceMembers).toBe(1);
  });

  it('restart=auto 且目标≠自身且在跑 → stop + 拉起（restarted: true）', async () => {
    seedSkill('weather');
    const { isAgentRunning } = await import('../../src/main/agent/runtime-status');
    vi.mocked(isAgentRunning).mockReturnValue(true);
    const r = await executeResourceOp('updateCapabilities',
      { agent: m1, add: { skills: ['weather'] } }, wsId, undefined, { background: false, callerInstanceId: 'someone-else' });
    expect(r.restarted).toBe(true);
  });

  it('restart=auto 且目标==自身 → 挂 respawn-on-idle（effectiveFrom: next-turn，绝不 mid-call 杀自己）', async () => {
    seedSkill('weather');
    const r = await executeResourceOp('updateCapabilities',
      { agent: m1, add: { skills: ['weather'] } }, wsId, undefined, { background: false, callerInstanceId: m1 });
    expect(r.effectiveFrom).toBe('next-turn');
    expect(r.restarted).toBeUndefined();
  });

  it('目标未在跑 → needsRestart: false（下次派发现算快照）', async () => {
    seedSkill('weather');
    const r = await executeResourceOp('updateCapabilities',
      { agent: m1, add: { skills: ['weather'] } }, wsId, undefined, { background: false, callerInstanceId: 'x' });
    expect(r.needsRestart).toBe(false);
  });

  it('空请求（无 add 无 remove）报错', async () => {
    await expect(executeResourceOp('updateCapabilities', { agent: m1 }, wsId)).rejects.toThrow('至少');
  });
});
```

（注：文件顶部既有 `vi.mock('runtime-registry')` 需扩为 `{ stopAgentRuntime: vi.fn(), requestRespawnAfterIdle: vi.fn() }`；`start-chain` 的 `ensureMemberRuntime` 同样 mock。）

- [ ] **Step 2: 跑测试确认失败**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/agent/resource-ops.test.ts --pool=forks`
Expected: FAIL（未知 op）

- [ ] **Step 3: 实现**——要点（完整代码按下列骨架落 resource-ops.ts，中文注释沿仓风格）：

```ts
case 'updateCapabilities': return opUpdateCapabilities(a, workspaceId, ctx);

// 骨架：
// 1. strArray 归一 add/remove 四字段；两者全空 → throw 'add 与 remove 至少其一'
// 2. resolveAgentTarget；scope = a.scope === 'definition' ? 'definition' : 'member'
// 3. ref 校验（fail-fast 聚合）：
//    tools → collectKnownToolNames(workspaceId)（动态 import known-tool-names，环安全时顶层）
//    pluginTools → 同上（插件全名本就在已知集）
//    skills → listInstalled() 的 slug 集；mcps → listRegistered() 的 name 集
//    非法项聚合 `非法引用: skill=ghost-skill, tool=no_such_tool` 一次抛出
// 4. scope=definition：def.source === 'builtin' → throw（§11 文案）；终态 = (def.default* refs ∪ add) − remove；
//    updateAgentDefinition({ id, defaultTools/Mcps/Skills: 终态映射回 {kind,ref} 数组 })；
//    stopped = await stopRunningInstancesByDefinition(def.id)；返回 { appliedTo:'definition', stoppedInstances: stopped.length, otherWorkspaceMembers }
// 5. scope=member：
//    alloc = readAllocationLayer(ws)；oldDeltas = readAssignmentDeltas(m.instanceId)；
//    merged = mergeCapabilities(def, alloc, oldDeltas)；
//    baseGrantedPlugin = [...new Set([...alloc.tools, ...def.defaultTools.map(t=>t.ref)])].filter(r => r.startsWith('plugin:') && !(def.deniedTools ?? []).some(p => 匹配));
//    grantedPlugin = 主侧 effectivePluginGranted（(baseGrantedPlugin ∪ old.addedPluginTools) − (old.removedPluginTools ∪ def.deniedTools 匹配)）
//    newDeltas = applyCapabilityDelta({tools: def.defaultTools refs ∪ alloc.tools, mcps:…, skills:…, baseGrantedPlugin}, {…merged, grantedPlugin}, {add, remove})
//    setAssignmentDeltas(m.instanceId, newDeltas)
// 6. restart 接线（仅 member 分支；spec §8 三行表）：
//    restart = a.restart === 'deferred' ? 'deferred' : 'auto'
//    if (restart === 'deferred') → needsRestart: true
//    else if (ctx?.callerInstanceId === m.instanceId) → requestRespawnAfterIdle(m.instanceId)（动态 import './runtime-registry'）；effectiveFrom: 'next-turn'
//    else if (isAgentRunning(m.instanceId)) → await stopAgentRuntime(m.instanceId); await ensureMemberRuntime(m.instanceId)（动态 import './start-chain'）；restarted: true
//    else → needsRestart: false
// 7. 返回 { appliedTo:'member', changed:{adds, removes}, effective: 重新 merge 后的 merged', needsRestart?/restarted?/effectiveFrom?, otherWorkspaceMembers }
```

- [ ] **Step 4: 跑测试确认全绿**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/agent/resource-ops.test.ts tests/agent/resource-ops-delta-parity.test.ts --pool=forks`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add electron/src/main/agent/resource-ops.ts electron/tests/agent/resource-ops.test.ts
git commit -m "feat: 会话内能力管理——updateCapabilities（member/definition 双 scope、fail-fast 校验、restart 接线）"
```

---

### Task 6: `updateProfile` op

**Files:**
- Modify: `electron/src/main/agent/resource-ops.ts`
- Test: `electron/tests/agent/resource-ops.test.ts`（扩块）

**Interfaces:**
- Consumes: `resolveAgentTarget`（Task 3）、`updateAgentDefinition` / `stopRunningInstancesByDefinition`、`getProvider`（`./provider-crud`）
- Produces: op `'updateProfile'`

- [ ] **Step 1: 写失败测试**

```ts
describe('updateProfile', () => {
  it('custom def 改 name/systemPrompt/model：落库 + 停机计数', async () => {
    getDb().prepare(`INSERT INTO agent_definitions (id, name, slug, version, system_prompt, model_name, source)
                     VALUES ('def-p', '改前', 'agent-p', '1', 'p0', 'm0', 'custom')`).run();
    const pm = (await addMember(wsId, 'def-p', '@p:1')).instanceId;
    const r = await executeResourceOp('updateProfile',
      { agent: pm, name: '改后', systemPrompt: 'p1', model: { providerId: provId, modelName: 'glm-5' } }, wsId);
    expect(r.definition.name).toBe('改后');
    const row = getDb().prepare('SELECT name, system_prompt, model_provider_id FROM agent_definitions WHERE id = ?').get('def-p');
    expect(row).toMatchObject({ name: '改后', system_prompt: 'p1', model_provider_id: provId });
    expect(typeof r.stoppedInstances).toBe('number');
  });

  it('builtin 定义拒绝（含指路文案）', async () => {
    await expect(executeResourceOp('updateProfile', { agent: m1, name: 'x' }, wsId))
      .rejects.toThrow('builtin 预设定义只读');
  });

  it('model.providerId 不存在 → 友好报错（沿 opCreateAgent 口径）', async () => {
    getDb().prepare(`INSERT INTO agent_definitions (id, name, slug, version, system_prompt, model_name, source)
                     VALUES ('def-q', 'q', 'agent-q', '1', 'p', 'm', 'custom')`).run();
    const qm = (await addMember(wsId, 'def-q', '@q:1')).instanceId;
    await expect(executeResourceOp('updateProfile',
      { agent: qm, model: { providerId: 'nope', modelName: 'm' } }, wsId)).rejects.toThrow('供应商不存在');
  });

  it('deniedTools 整列覆盖；全字段缺省 → no-op 更新（值不变）', async () => {
    getDb().prepare(`INSERT INTO agent_definitions (id, name, slug, version, system_prompt, model_name, source)
                     VALUES ('def-r', 'r', 'agent-r', '1', 'p', 'm', 'custom')`).run();
    const rm = (await addMember(wsId, 'def-r', '@r:1')).instanceId;
    await executeResourceOp('updateProfile', { agent: rm, deniedTools: ['bash'] }, wsId);
    const row = getDb().prepare('SELECT denied_tools FROM agent_definitions WHERE id = ?').get('def-r');
    expect(JSON.parse(row.denied_tools)).toEqual(['bash']);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**（同上命令，期望 `未知 resource op: updateProfile`）
- [ ] **Step 3: 实现**——分发加 case；骨架：

```ts
// opUpdateProfile(a, workspaceId):
// 1. target = resolveAgentTarget(str(a.agent), workspaceId)；def.source==='builtin' → throw 'builtin 预设定义只读。给成员调整能力请用 update_agent_capabilities（默认 member scope）；改定义请在资源库 UI（自定义 agent）'
// 2. model 块：providerId 非空时 getProvider 校验（不存在 throw `供应商不存在: …`）
// 3. updateAgentDefinition({ id, name?, description?, systemPrompt?, iconEmoji?,
//      modelProviderId: model?.providerId, modelName: model?.modelName, deniedTools? })
//    —— 注意 updateAgentDefinition 的「undefined=不改」语义与入参透传对齐
// 4. stopped = await stopRunningInstancesByDefinition(def.id)
// 5. 返回 { definition: 读回行, stoppedInstances: stopped.length }
```

- [ ] **Step 4: 跑测试确认全绿**（同 Task 5 命令）
- [ ] **Step 5: Commit**

```bash
git add electron/src/main/agent/resource-ops.ts electron/tests/agent/resource-ops.test.ts
git commit -m "feat: 会话内能力管理——updateProfile（档案/模型/禁用串，builtin 只读保护）"
```

---

### Task 7: `updateSkill` op

**Files:**
- Modify: `electron/src/main/agent/resource-ops.ts`
- Test: `electron/tests/agent/resource-ops.test.ts`（扩块）

**Interfaces:**
- Consumes: `getSkillsDir` / `listInstalled`（`../skill/zip-uploader`）、`parseSkillMd`（`../skill/loader`）、`safeJoin`（本文件既有）
- Produces: op `'updateSkill'`；返回 `{ slug, name, refCount, agentsUsingIt, needsRestart }`

- [ ] **Step 1: 写失败测试**

```ts
describe('updateSkill', () => {
  const seedCustom = (slug: string): void => {
    const dir = path.join(getSkillsDir(), slug);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: 旧名\ndescription: 旧\n---\n旧正文');
    fs.writeFileSync(path.join(dir, '.sha256'), 'deadbeef'); // custom 源标记
  };

  it('custom 源全量替换：SKILL.md/references/.sha256 全部换新', async () => {
    seedCustom('my-skill');
    const r = await executeResourceOp('updateSkill', {
      slug: 'my-skill',
      skillMd: '---\nname: 新名\ndescription: 新\n---\n新正文',
      references: [{ path: 'refs/a.md', content: 'A' }],
    }, wsId);
    expect(r.name).toBe('新名');
    expect(fs.readFileSync(path.join(getSkillsDir(), 'my-skill', 'refs', 'a.md'), 'utf-8')).toBe('A');
    const hash = fs.readFileSync(path.join(getSkillsDir(), 'my-skill', '.sha256'), 'utf-8');
    expect(hash).not.toBe('deadbeef');
  });

  it('references 越界拒绝且零落盘（Review Focus ④）', async () => {
    seedCustom('my-skill');
    await expect(executeResourceOp('updateSkill', {
      slug: 'my-skill', skillMd: '---\nname: n\ndescription: d\n---\nb',
      references: [{ path: '../escape.md', content: 'x' }],
    }, wsId)).rejects.toThrow('越界');
    expect(fs.existsSync(path.join(getSkillsDir(), 'escape.md'))).toBe(false);
    // 旧内容原样保留（不是先删后炸）
    expect(fs.readFileSync(path.join(getSkillsDir(), 'my-skill', 'SKILL.md'), 'utf-8')).toContain('旧正文');
  });

  it('slug 不存在 → 指路 create_skill', async () => {
    await expect(executeResourceOp('updateSkill',
      { slug: 'ghost', skillMd: '---\nname: n\ndescription: d\n---\nb' }, wsId))
      .rejects.toThrow('create_skill');
  });

  it('非 custom 源（无 .sha256 标记）拒绝并引导 UI', async () => {
    const dir = path.join(getSkillsDir(), 'builtin-like');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: b\ndescription: d\n---\nb');
    await expect(executeResourceOp('updateSkill',
      { slug: 'builtin-like', skillMd: '---\nname: n\ndescription: d\n---\nb' }, wsId))
      .rejects.toThrow('资源库');
  });

  it('agentsUsingIt：引用该 skill 的成员行计数', async () => {
    seedCustom('shared-skill');
    getDb().prepare(`INSERT INTO agent_definitions (id, name, slug, version, system_prompt, model_name, source, default_skills)
                     VALUES ('def-s', 's', 'agent-s', '1', 'p', 'm', 'custom', ?)`).run(JSON.stringify([{ kind: 'skill', ref: 'shared-skill' }]));
    await addMember(wsId, 'def-s', '@s:1');
    const r = await executeResourceOp('updateSkill',
      { slug: 'shared-skill', skillMd: '---\nname: n\ndescription: d\n---\nb' }, wsId);
    expect(r.agentsUsingIt).toBeGreaterThanOrEqual(1);
    expect(r.needsRestart).toBe(true);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现**——骨架：

```ts
// opUpdateSkill(a, _wsId):
// 1. slug/skillMd str 必填；dir = getSkillsDir()/slug；SKILL.md 不存在 → throw `skill 不存在: slug（新建请用 create_skill）`
// 2. .sha256 不存在 → throw `仅 custom 源技能可更新（请在 资源库 → 技能 管理: slug）`
// 3. parseSkillMd 校验 frontmatter（缺 name/description 抛）
// 4. references 归一（沿 opCreateSkill 的 SkillFileInput 形状）+ safeJoin 全量先验——任一越界抛 `references 路径越界: …`，**零落盘**
// 5. 全量替换：fs.rmSync(dir, {recursive, force}) → mkdir → 写 SKILL.md / references / 重算 .sha256（form-create.ts:27 同款）
// 6. agentsUsingIt：SELECT COUNT(*) FROM workspace_agent_members m JOIN agent_definitions d ON d.id = m.agent_definition_id WHERE d.default_skills LIKE '%"slug"%' OR EXISTS(delta add 行 ref=slug)
//    —— 用 JSON like 初筛 + JS 精确解析复核（防 substring 误报）；delta 侧查 agent_assignment_capabilities ref=slug AND mode='add'
// 7. needsRestart: agentsUsingIt > 0
```

- [ ] **Step 4: 跑测试确认全绿**
- [ ] **Step 5: Commit**

```bash
git add electron/src/main/agent/resource-ops.ts electron/tests/agent/resource-ops.test.ts
git commit -m "feat: 会话内能力管理——updateSkill（custom 源全量替换 + 引用面提示）"
```

---

### Task 8: `updateMcp` op

**Files:**
- Modify: `electron/src/main/agent/resource-ops.ts`
- Test: `electron/tests/agent/resource-ops.test.ts`（扩块，沿 createMcp 的 deps.makeClient 注入手法）

**Interfaces:**
- Consumes: `listRegistered` / `updateMcpEntryDefinition`（`../mcp/host-manager`）、`updateMcpEntry`（`../resource/mcp-config`）、`McpClient` / `HttpMcpClient` / `McpHttpError`、既有 `withTimeout` / `MCP_TEST_TIMEOUT_MS` / `TransientMcpClient` / `ResourceOpDeps.makeClient`
- Produces: op `'updateMcp'`；返回 `{ name, toolCount, toolNames, needsAuthorization?, notice? }`

- [ ] **Step 1: 写失败测试**（沿 createMcp 块的 fake client 夹具）

```ts
describe('updateMcp', () => {
  const seedMcp = (name: string): void => {
    getDb().prepare(`INSERT INTO mcp_definitions (id, name, version, transport, command, args, source)
                     VALUES (?, ?, '1.0.0', 'stdio', 'old-cmd', '[]', 'custom')`).run(`mid-${name}`, name);
  };
  const mkDeps = (fail?: 'oauth'): { deps: ResourceOpDeps } => ({
    deps: {
      makeClient: () => ({
        connect: async () => { if (fail === 'oauth') throw new McpHttpError('unauthorized', 401); },
        listTools: async () => [{ name: 't1' }, { name: 't2' }] as McpToolInfo[],
        disconnect: async () => undefined,
      }),
    },
  });

  it('先测后落库：连通通过 → updateMcpEntry 收到新 command', async () => {
    seedMcp('fs');
    const r = await executeResourceOp('updateMcp',
      { name: 'fs', transport: { kind: 'stdio', command: 'new-cmd' } }, wsId, mkDeps().deps);
    expect(r.toolCount).toBe(2);
    const row = getDb().prepare('SELECT command FROM mcp_definitions WHERE name = ?').get('fs');
    expect(row.command).toBe('new-cmd');
  });

  it('连通失败零落库（命令未变）', async () => {
    seedMcp('fs');
    const deps = { makeClient: () => ({ connect: async () => { throw new Error('ECONNREFUSED'); }, listTools: async () => [], disconnect: async () => undefined }) };
    await expect(executeResourceOp('updateMcp',
      { name: 'fs', transport: { kind: 'stdio', command: 'new-cmd' } }, wsId, deps))
      .rejects.toThrow('ECONNREFUSED');
    expect(getDb().prepare('SELECT command FROM mcp_definitions WHERE name = ?').get('fs').command).toBe('old-cmd');
  });

  it('OAuth 401 → needsAuthorization 例外（落库 + 引导文案）', async () => {
    seedMcp('oauth-mcp');
    const r = await executeResourceOp('updateMcp',
      { name: 'oauth-mcp', transport: { kind: 'http', url: 'https://x/v1' } }, wsId, mkDeps('oauth').deps);
    expect(r.needsAuthorization).toBe(true);
    expect(r.notice).toContain('授权');
  });

  it('name 未注册 → 指路 create_mcp', async () => {
    await expect(executeResourceOp('updateMcp',
      { name: 'ghost', transport: { kind: 'stdio', command: 'c' } }, wsId, mkDeps().deps))
      .rejects.toThrow('create_mcp');
  });

  it('凭证不回显：返回与 throw 信息不含 headers 值', async () => {
    seedMcp('sec');
    const r = await executeResourceOp('updateMcp',
      { name: 'sec', transport: { kind: 'http', url: 'https://x/v1', headers: { Authorization: 'Bearer sekret' } } },
      wsId, mkDeps().deps);
    expect(JSON.stringify(r)).not.toContain('sekret');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现**——骨架：

```ts
// opUpdateMcp(a, deps):
// 1. name str；listRegistered() 查无 → throw `MCP 不存在: name（新建请用 create_mcp）`
// 2. transport 归一（沿 opCreateMcp 同款形状先验）组装 McpEntryUpdateInput：
//    stdio → { transport:'stdio', command, args?, env?, cwd? }
//    http  → { transport:'streamable_http', command:'', url, headers? }
// 3. 瞬态客户端连通测试（deps.makeClient ?? 真实工厂；connect + listTools 各 30s withTimeout）：
//    失败 throw（零落库）；McpHttpError 401/403 → updateMcpEntry(name, input) 落库后
//    返回 { name, toolCount:0, toolNames:[], needsAuthorization:true, notice: R14 同款引导文案 }
// 4. 通过 → await updateMcpEntry(name, input)（resource/mcp-config——内部保 id/source + 池驱逐）
// 5. 返回 { name, toolCount, toolNames: tools.map(t=>t.name).slice(0,20) }
```

- [ ] **Step 4: 跑测试确认全绿**
- [ ] **Step 5: Commit**

```bash
git add electron/src/main/agent/resource-ops.ts electron/tests/agent/resource-ops.test.ts
git commit -m "feat: 会话内能力管理——updateMcp（先测后落库 + OAuth 例外 + 凭证不回显）"
```

---

### Task 9: 确认通道模块 `agent-op-confirm.ts` + IPC 注册

**Files:**
- Create: `electron/src/main/agent/agent-op-confirm.ts`
- Modify: `electron/src/main/ipc/index.ts`（`registerAgentOpConfirmHandlers()` 挂载——与 `registerResourceHandlers` 同位）
- Test: `electron/tests/agent/resource-op-confirm.test.ts`（Create；mock electron）

**Interfaces:**
- Consumes: `BrowserWindow` / `ipcMain`（electron）、`logger`
- Produces（Task 10 依赖）:

```ts
export const AGENT_OP_CONFIRM_REQUEST_CHANNEL = 'agent-op-confirm:request';
export const CONFIRM_WAIT_MS = 10 * 60_000;
export interface AgentOpConfirmPayload {
  requestId: string; workspaceId: string;
  requester: { agentName: string; op: string; toolName: string };
  diff: {
    target: { kind: 'member' | 'definition' | 'skill' | 'mcp'; name: string; workspaceName?: string };
    scope?: 'member' | 'definition';
    adds: Array<{ field: 'skills' | 'mcps' | 'tools' | 'pluginTools'; ref: string }>;
    removes: Array<{ field: 'skills' | 'mcps' | 'tools' | 'pluginTools'; ref: string }>;
    fieldChanges?: Array<{ field: string; before?: string; after?: string }>;
  };
  riskNote?: string;
  expiresAt: number;
}
export type AgentOpConfirmOutcome = { allowed: boolean; reason: string };
export function requestAgentOpConfirm(payload: Omit<AgentOpConfirmPayload, 'requestId' | 'expiresAt'>, childKey: string): Promise<AgentOpConfirmOutcome>
export function resolvePendingByChildExit(childKey: string): void
export function registerAgentOpConfirmHandlers(): void
```

- [ ] **Step 1: 写失败测试**

```ts
// electron/tests/agent/resource-op-confirm.test.ts
// 确认通道四出口 + 先到先得（spec §7）。electron mock：BrowserWindow.getAllWindows / ipcMain.handle。
import { describe, it, expect, vi, beforeEach } from 'vitest';

const windows: Array<{ webContents: { send: ReturnType<typeof vi.fn> } }> = [];
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => windows },
  ipcMain: { handle: vi.fn() },
}));

import {
  requestAgentOpConfirm, resolvePendingByChildExit, CONFIRM_WAIT_MS,
  __resolveForTest, __resetPendingForTest,
} from '../../src/main/agent/agent-op-confirm';

beforeEach(() => { windows.length = 0; __resetPendingForTest(); });

describe('requestAgentOpConfirm', () => {
  const base = {
    workspaceId: 'ws', requester: { agentName: 'Momo', op: 'updateCapabilities', toolName: 'update_agent_capabilities' },
    diff: { target: { kind: 'member' as const, name: 'A' }, adds: [{ field: 'skills' as const, ref: 'weather' }], removes: [] },
  };

  it('allow 出口：广播 → reply(true) → resolve allowed', async () => {
    const w = { webContents: { send: vi.fn() } }; windows.push(w);
    const p = requestAgentOpConfirm(base, 'child-1');
    expect(w.webContents.send).toHaveBeenCalledTimes(1);
    const payload = w.webContents.send.mock.calls[0][1];
    await __resolveForTest(payload.requestId, true);
    await expect(p).resolves.toEqual({ allowed: true, reason: '' });
  });

  it('deny 出口：reason 回传', async () => {
    windows.push({ webContents: { send: vi.fn() } });
    const p = requestAgentOpConfirm(base, 'child-1');
    const payload = windows[0].webContents.send.mock.calls[0][1];
    await __resolveForTest(payload.requestId, false);
    await expect(p).resolves.toMatchObject({ allowed: false });
  });

  it('timeout 出口：CONFIRM_WAIT_MS 后按拒绝收敛（文案含「确认超时」）', async () => {
    vi.useFakeTimers();
    windows.push({ webContents: { send: vi.fn() } });
    const p = requestAgentOpConfirm(base, 'child-1');
    vi.advanceTimersByTime(CONFIRM_WAIT_MS + 1);
    await expect(p).resolves.toMatchObject({ allowed: false, reason: expect.stringContaining('确认超时') });
    vi.useRealTimers();
  });

  it('child 退出出口：resolvePendingByChildExit 按拒绝收敛（Review Focus ①）', async () => {
    windows.push({ webContents: { send: vi.fn() } });
    const p = requestAgentOpConfirm(base, 'child-9');
    resolvePendingByChildExit('child-9');
    await expect(p).resolves.toMatchObject({ allowed: false });
  });

  it('先到先得：迟到的 reply 是 no-op（Review Focus ②）', async () => {
    windows.push({ webContents: { send: vi.fn() } });
    const p = requestAgentOpConfirm(base, 'child-1');
    const payload = windows[0].webContents.send.mock.calls[0][1];
    await __resolveForTest(payload.requestId, true);
    await expect(__resolveForTest(payload.requestId, true)).resolves.toMatchObject({ skipped: true });
    await expect(p).resolves.toMatchObject({ allowed: true });
  });

  it('零窗口（无人在场）→ 立即拒绝不广播', async () => {
    await expect(requestAgentOpConfirm(base, 'child-1')).resolves.toMatchObject({ allowed: false });
  });

  it('expiresAt = now + CONFIRM_WAIT_MS；requestId 为 UUID', async () => {
    windows.push({ webContents: { send: vi.fn() } });
    requestAgentOpConfirm(base, 'child-1');
    const payload = windows[0].webContents.send.mock.calls[0][1];
    expect(payload.expiresAt).toBeGreaterThan(Date.now() + CONFIRM_WAIT_MS - 5_000);
    expect(payload.requestId).toMatch(/^[0-9a-f-]{36}$/);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/agent/resource-op-confirm.test.ts --pool=forks`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

```ts
// electron/src/main/agent/agent-op-confirm.ts
// 扩权确认通道（spec §7）：主进程单点裁决，四出口（allow/deny/timeout/child 退出）。
// vitest 里 require('electron') 返回路径字符串——沿 changed-emit 懒加载纪律。
import { randomUUID } from 'node:crypto';
import { logger } from '../logger';

export const AGENT_OP_CONFIRM_REQUEST_CHANNEL = 'agent-op-confirm:request';
export const CONFIRM_WAIT_MS = 10 * 60_000; // 对齐 write-grant F5（spec §7.2）

export interface AgentOpConfirmPayload { /* …接口区给出的完整形状… */ }
export type AgentOpConfirmOutcome = { allowed: boolean; reason: string };

interface PendingEntry {
  payload: AgentOpConfirmPayload;
  resolve: (o: AgentOpConfirmOutcome) => void;
  childKey: string;
  timer: NodeJS.Timeout;
}

const pending = new Map<string, PendingEntry>();

function broadcast(channel: string, payload: unknown): number {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const electron = require('electron') as typeof import('electron') | string;
  if (typeof electron === 'string') return 0;
  const wins = electron.BrowserWindow.getAllWindows();
  for (const w of wins) w.webContents.send(channel, payload);
  return wins.length;
}

function settle(id: string, o: AgentOpConfirmOutcome): void {
  const e = pending.get(id);
  if (!e) return;
  clearTimeout(e.timer);
  pending.delete(id);
  logger.info('能力变更确认裁决', { requestId: id, op: e.payload.requester.op, allowed: o.allowed, reason: o.reason });
  e.resolve(o);
}

export function requestAgentOpConfirm(
  base: Omit<AgentOpConfirmPayload, 'requestId' | 'expiresAt'>,
  childKey: string,
): Promise<AgentOpConfirmOutcome> {
  const payload: AgentOpConfirmPayload = { ...base, requestId: randomUUID(), expiresAt: Date.now() + CONFIRM_WAIT_MS };
  return new Promise((resolve) => {
    const winCount = broadcast(AGENT_OP_CONFIRM_REQUEST_CHANNEL, payload);
    if (winCount === 0) { resolve({ allowed: false, reason: '当前无可用窗口（无人在场），已拒绝' }); return; }
    const timer = setTimeout(() => settle(payload.requestId, { allowed: false, reason: `确认超时（${CONFIRM_WAIT_MS / 60000} 分钟未处置），已拒绝` }), CONFIRM_WAIT_MS);
    timer.unref?.();
    pending.set(payload.requestId, { payload, resolve, childKey, timer });
  });
}

export function resolvePendingByChildExit(childKey: string): void {
  for (const [id, e] of [...pending]) {
    if (e.childKey === childKey) settle(id, { allowed: false, reason: '请求方运行时已退出，确认取消' });
  }
}

export function registerAgentOpConfirmHandlers(): void {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { ipcMain } = require('electron') as typeof import('electron');
  ipcMain.handle('agent-op-confirm:reply', (_evt, input: { requestId?: unknown; allowed?: unknown }) => {
    if (typeof input?.requestId !== 'string') return { skipped: true };
    const known = pending.has(input.requestId);
    settle(input.requestId, { allowed: input.allowed === true, reason: input.allowed === true ? '' : '用户在确认卡上拒绝了本次变更' });
    return { skipped: !known };
  });
}

// 测试后门
export async function __resolveForTest(id: string, allowed: boolean): Promise<{ skipped: boolean }> {
  const known = pending.has(id);
  settle(id, { allowed, reason: allowed ? '' : '测试拒绝' });
  return { skipped: !known };
}
export function __resetPendingForTest(): void {
  for (const [, e] of pending) { clearTimeout(e.timer); e.resolve({ allowed: false, reason: '测试重置' }); }
  pending.clear();
}
```

ipc/index.ts：在 `registerResourceHandlers()` 调用旁加 `registerAgentOpConfirmHandlers();`（import 自 `../agent/agent-op-confirm`）。

- [ ] **Step 4: 跑测试确认全绿**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/agent/resource-op-confirm.test.ts --pool=forks`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add electron/src/main/agent/agent-op-confirm.ts electron/src/main/ipc/index.ts electron/tests/agent/resource-op-confirm.test.ts
git commit -m "feat: 会话内能力管理——扩权确认通道（四出口 + 先到先得 + child 退出清理）"
```

---

### Task 10: 桥改造——确认门接线 + per-op 超时 + ctx 注入 + 广播矩阵

**Files:**
- Modify: `electron/src/main/agent/resource-ops-bridge.ts`、`electron/src/main/agent/runtime-spawner.ts:499` 一带、`electron/src/main/agent/resource-ops.ts`（新增导出 `confirmTierForOp` / `buildConfirmPayload`）
- Test: `electron/tests/agent/resource-ops-bridge.test.ts`（既有文件扩块；无既有则 Create，沿 resource-ops.test.ts 非 DB 夹具）

**Interfaces:**
- Consumes: Task 9 `requestAgentOpConfirm` / `resolvePendingByChildExit`、Task 3 `resolveAgentTarget`
- Produces:

```ts
// resource-ops.ts 导出（确认档位单一真相源，spec §5.6）
export function confirmTierForOp(op: string, args: Record<string, unknown>): 'required' | 'none'
// resource-ops.ts 导出（diff 主进程真相源，spec §7.1）
export function buildConfirmPayload(op: string, args: Record<string, unknown>, workspaceId: string): Omit<AgentOpConfirmPayload, 'requestId' | 'expiresAt'> | null
// resource-ops-bridge.ts 签名扩展
export async function handleResourceOpMessage(
  msg: unknown, workspaceId: string, childSend: (m: unknown) => void,
  executor?: OpExecutor, ctx?: { background: boolean; callerInstanceId?: string },
): Promise<boolean>
```

- [ ] **Step 1: 写失败测试**

```ts
describe('resource-ops-bridge 确认门（spec §7/§10）', () => {
  const executor = vi.fn(async (op: string) => ({ ok: op }));
  const send = vi.fn();

  it('确认档位矩阵：describeAgent=none / updateProfile·updateSkill·updateMcp=required / updateCapabilities 按 add 与 scope 判', () => {
    expect(confirmTierForOp('describeAgent', {})).toBe('none');
    expect(confirmTierForOp('updateProfile', {})).toBe('required');
    expect(confirmTierForOp('updateSkill', {})).toBe('required');
    expect(confirmTierForOp('updateMcp', {})).toBe('required');
    expect(confirmTierForOp('updateCapabilities', { add: { skills: ['x'] } })).toBe('required');
    expect(confirmTierForOp('updateCapabilities', { scope: 'definition', remove: { tools: ['bash'] } })).toBe('required');
    expect(confirmTierForOp('updateCapabilities', { remove: { tools: ['bash'] } })).toBe('none'); // 纯减权免确认
    expect(confirmTierForOp('createAgent', {})).toBe('none'); // 既有 create 零变化
  });

  it('需确认 op：用户允许 → executor 执行且 ctx 透传', async () => {
    const allow = vi.fn(async () => ({ allowed: true, reason: '' }));
    vi.doMock('../../src/main/agent/agent-op-confirm', () => ({ requestAgentOpConfirm: allow, resolvePendingByChildExit: vi.fn() }));
    const m = { type: 'resource-op', id: 'r1', op: 'updateProfile', args: { agent: 'x' } };
    await handleResourceOpMessage(m, 'ws-1', send, executor, { background: false, callerInstanceId: 'me' });
    expect(allow).toHaveBeenCalledTimes(1);
    expect(executor).toHaveBeenCalledWith('updateProfile', expect.anything(), 'ws-1', undefined, { background: false, callerInstanceId: 'me' });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'resource-op', id: 'r1', result: { ok: 'updateProfile' } }));
  });

  it('用户拒绝 → executor 不执行，错误文案回子进程', async () => {
    const deny = vi.fn(async () => ({ allowed: false, reason: '用户在确认卡上拒绝了本次变更' }));
    vi.doMock('../../src/main/agent/agent-op-confirm', () => ({ requestAgentOpConfirm: deny, resolvePendingByChildExit: vi.fn() }));
    await handleResourceOpMessage({ type: 'resource-op', id: 'r2', op: 'updateMcp', args: {} }, 'ws-1', send, executor, { background: false });
    expect(executor).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: 'resource-op', id: 'r2', error: expect.stringContaining('拒绝') }));
  });

  it('后台链 fail-closed：background=true 的需确认 op 立即拒绝、不弹卡（spec §7.3）', async () => {
    const allow = vi.fn();
    vi.doMock('../../src/main/agent/agent-op-confirm', () => ({ requestAgentOpConfirm: allow, resolvePendingByChildExit: vi.fn() }));
    await handleResourceOpMessage({ type: 'resource-op', id: 'r3', op: 'updateProfile', args: {} }, 'ws-1', send, executor, { background: true });
    expect(allow).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ error: expect.stringContaining('后台') }));
  });

  it('background 取自 ctx 闭包而非消息体（Review Focus ⑤）', async () => {
    await handleResourceOpMessage(
      { type: 'resource-op', id: 'r4', op: 'updateProfile', args: {}, background: false }, // 消息体伪造 false
      'ws-1', send, executor, { background: true });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ error: expect.stringContaining('后台') }));
  });

  it('免确认 op 直通：describeAgent 不触碰确认通道', async () => {
    const allow = vi.fn();
    vi.doMock('../../src/main/agent/agent-op-confirm', () => ({ requestAgentOpConfirm: allow, resolvePendingByChildExit: vi.fn() }));
    await handleResourceOpMessage({ type: 'resource-op', id: 'r5', op: 'describeAgent', args: {} }, 'ws-1', send, executor, { background: false });
    expect(allow).not.toHaveBeenCalled();
    expect(executor).toHaveBeenCalled();
  });

  it('per-op 超时：需确认 op 子进程等待 10min30s，普通 op 维持 30s', () => {
    expect(confirmWaitBudgetMs('updateProfile')).toBe(10 * 60_000 + 30_000);
    expect(confirmWaitBudgetMs('describeAgent')).toBe(30_000);
    expect(confirmWaitBudgetMs('createAgent')).toBe(30_000);
  });

  it('广播矩阵：updateCapabilities → resource:changed + runtimeChanged；updateSkill → 仅 resource:changed；describeAgent → 零广播', () => {
    expect(memberAffecting('updateCapabilities')).toBe(true);
    expect(memberAffecting('updateSkill')).toBe(false);
    expect(memberAffecting('describeAgent')).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现**——要点：

```ts
// resource-ops.ts：
export function confirmTierForOp(op, args) { /* §5.6 矩阵逐字实现（见测试用例枚举）*/ }
export function buildConfirmPayload(op, args, workspaceId) {
  // updateCapabilities/updateProfile → resolveAgentTarget 取 target 名 + workspace 名（getWorkspace）；
  //   adds/removes 由 args 直接映射；profile 字段 fieldChanges（before 可省——只展示 after，避免回显 prompt 全文）
  // updateSkill → target { kind:'skill', name: slug }；updateMcp → { kind:'mcp', name }
  // riskNote：add 含 tools/pluginTools → '将授予新工具（扩权）'；scope=definition → '将修改 agent 定义（全局生效）'
  // 返回 null 表示无需确认（tier=none 时桥不调用）
}
// resource-ops-bridge.ts：
// - RESOURCE_OP_TIMEOUT_MS 拆分：confirmWaitBudgetMs(op) = tier==='required' ? 10min30s : 30s；
//   requestResourceOp 的 timer 用该值
// - handleResourceOpMessage 新 ctx 参数；流程：
//   tier = confirmTierForOp(op, args)
//   if (tier === 'required') {
//     if (ctx?.background) → childSend error '后台任务链中没有确认人在场。能力变更请在工作空间会话中直接提出，由你本人确认。'
//     else { const o = await requestAgentOpConfirm(buildConfirmPayload(...), childKey=workspaceId+child 键);
//            if (!o.allowed) → childSend error `用户拒绝了本次变更${o.reason ? '：'+o.reason : ''}`; return true }
//   }
//   result = await executor(op, args, workspaceId, undefined, ctx)
// - MEMBER_AFFECTING_OPS += 'updateCapabilities' | 'updateProfile'（memberAffecting 导出）
// - child exit 清理：runtime-spawner 的 onExit 回调（registerTaskDrivenRuntime spawn 闭包内）追加 resolvePendingByChildExit(childKey)
// runtime-spawner.ts:499 调用点：handleResourceOpMessage(msg, runtimeConfig.workspaceId, send, undefined,
//   { background: runtimeConfig.parentStreamSessionId !== undefined, callerInstanceId: runtimeConfig.agentAssignmentId })
```

（childKey 取 `instanceId:child.pid` 或 spawner 闭包内既有唯一键——以 spawner 现有 child 标识为准，exit 回调与请求侧同键。）

- [ ] **Step 4: 跑测试确认全绿**（跑 bridge + confirm + ops 三文件）
- [ ] **Step 5: Commit**

```bash
git add electron/src/main/agent/resource-ops.ts electron/src/main/agent/resource-ops-bridge.ts electron/src/main/agent/runtime-spawner.ts electron/tests/agent/resource-ops-bridge.test.ts
git commit -m "feat: 会话内能力管理——桥内确认门（档位矩阵/后台链 fail-closed/ctx 闭包注入/per-op 超时）"
```

---

### Task 11: 工具面 +5 defs + catalog 联动

**Files:**
- Modify: `electron/src/main/agent/tools/resource-tools.ts`（TOOL_TO_OP + getDefs + CATALOG_META）
- Test: `electron/tests/agent/tools/resource-tools.test.ts`（既有文件扩块）

**Interfaces:**
- Consumes: Task 3–8 的 op 名
- Produces: 5 个 LLMToolDef（schema 按 spec §5.1–5.5 逐字落，description 含「确认纪律」与「scope 缺省 member」语义）+ catalog 分类「资源管理」`defaultOn: false`

- [ ] **Step 1: 写失败测试**

```ts
describe('资源管理工具面（spec §5）', () => {
  const tools = new ResourceTools(vi.fn(async () => ({})));
  const names = tools.getDefs().map((d) => d.name);

  it('五工具齐备且 handles/op 映射正确', () => {
    for (const n of ['describe_agent', 'update_agent_capabilities', 'update_agent_profile', 'update_skill', 'update_mcp']) {
      expect(names).toContain(n);
      expect(tools.handles(n)).toBe(true);
    }
  });

  it('update_agent_capabilities 的 scope 缺省语义写进 description', () => {
    const def = tools.getDefs().find((d) => d.name === 'update_agent_capabilities')!;
    expect(def.description).toContain('member');
    expect(def.description).toContain('definition');
  });

  it('catalog：分类「资源管理」、defaultOn 全 false、riskNote 就位（buildCatalog fail-fast 兜底）', () => {
    const cat = tools.getCatalog();
    const upd = cat.find((c) => c.name === 'update_agent_capabilities')!;
    expect(upd.category).toBe('资源管理');
    expect(upd.defaultOn).toBe(false);
    expect(upd.riskNote).toBeTruthy();
    expect(cat.find((c) => c.name === 'update_mcp')!.riskNote).toBeTruthy();
  });

  it('execute 经 callOp 透传 op 与 args', async () => {
    const callOp = vi.fn(async () => ({ ok: 1 }));
    await new ResourceTools(callOp).execute('describe_agent', { agent: 'x' }, {} as never);
    expect(callOp).toHaveBeenCalledWith('describeAgent', { agent: 'x' });
  });
});
```

另：更新 `tests/storage/migrations/077_*.test.ts` 与 catalog 全集测试中「冻结名单计数」断言由 64 → 69（若断言位于独立 fixture 文件，同步之；077 文件头注释既定流程）。

- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现**——TOOL_TO_OP 加五行映射；getDefs 按 spec §5 逐字写五条 LLMToolDef（inputSchema 与 spec 一致：`update_agent_capabilities` 的 `add/remove/pluginTools/scope/restart`，`update_skill` 的 `slug/skillMd/references`，`update_mcp` 的 `name/transport`）；CATALOG_META 加五条（displayName：查看智能体/调整智能体能力/编辑智能体档案/更新技能/更新 MCP）。
- [ ] **Step 4: 跑测试确认全绿**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/agent/tools/resource-tools.test.ts --pool=forks`

- [ ] **Step 5: Commit**

```bash
git add electron/src/main/agent/tools/resource-tools.ts electron/tests/agent/tools/resource-tools.test.ts
git commit -m "feat: 会话内能力管理——资源管理五工具面与目录元数据"
```

---

### Task 12: preload 通道 + renderer store + 确认卡（P1 预览门禁）

**Files:**
- Modify: `electron/src/preload/index.ts`、`renderer/src/ipc/types.d.ts`（镜像）、`renderer/src/App.tsx`（挂卡订阅）
- Create: `renderer/src/stores/agent-op-confirm.store.ts`、`renderer/src/components/AgentOpConfirmCard.tsx`
- Test: colocated `renderer/src/stores/agent-op-confirm.store.test.ts`、`renderer/src/components/AgentOpConfirmCard.test.tsx`

**Interfaces:**
- Consumes: Task 9 的 channel / reply IPC；`components/ui/Dialog`、lucide-react、语义 token
- Produces（preload 面，types.d.ts 同步镜像）:

```ts
onAgentOpConfirmRequest: (cb: (payload: AgentOpConfirmPayload) => void) => () => void
replyAgentOpConfirm: (requestId: string, allowed: boolean) => Promise<{ skipped: boolean }>
```

- [ ] **Step 1: **P1 预览门禁**——实现前先出静态预览（momo-ui-preview-rules）：确认卡线框图（标题/diff 行/风险高亮/双按钮）经用户预览确认后再写组件**
- [ ] **Step 2: 写失败测试**（store：receive → pending 置位、reply → 调 ipc 并清 pending、过期清扫（expiresAt 判定）；组件：diff 渲染 +/− 行、fieldChanges before→after、riskNote 高亮、双按钮点击 → reply）
- [ ] **Step 3: 实现**——preload 沿 `agent:runtimeChanged` 订阅模式（`ipcRenderer.on` + 返回退订函数）；store 沿 write-grant.store 结构（pending 单卡 + TTL 清扫）；组件：Dialog + `+`/`−` 行用 `text-secondary` 语义 token、`TriangleAlert` 图标（16px/1.75）承载 riskNote
- [ ] **Step 4: 跑测试 + 双 workspace typecheck**

Run: `cd renderer && npx pnpm@9.0.0 vitest run src/stores/agent-op-confirm.store.test.ts src/components/AgentOpConfirmCard.test.tsx && cd .. && npx pnpm@9.0.0 typecheck`
Expected: PASS / typecheck 双绿

- [ ] **Step 5: Commit**

```bash
git add electron/src/preload/index.ts renderer/src/ipc/types.d.ts renderer/src/App.tsx renderer/src/stores/agent-op-confirm.store.ts renderer/src/stores/agent-op-confirm.store.test.ts renderer/src/components/AgentOpConfirmCard.tsx renderer/src/components/AgentOpConfirmCard.test.tsx
git commit -m "feat: 会话内能力管理——renderer 确认卡（全局 Dialog + diff 渲染 + 先到先得回执）"
```

---

### Task 13: Momo 升级 + migration 079

**Files:**
- Modify: `electron/resources/agents/general-assistant.yaml`（version 2.2.0；defaultTools 64→69 追加五工具；defaultSkills 4→5 追加 `manage-agent`）
- Create: `electron/src/main/storage/migrations/079_momo_capability_management_tools.ts`（077 同式整列替换）
- Modify: `electron/src/main/storage/migrations/index.ts`（登记 079）、`resources/marketplace/catalog.json`（见 Task 14 一并 +1 条——本 Task 只动 yaml/migration/测试）
- Test: Create `electron/tests/storage/migrations/079_momo_capability_management_tools.test.ts`；Modify 077 测试冻结名单指向（其文件头既定流程）

**Interfaces:**
- Consumes: 077 的迁移模式（TOOLS_JSON 自包含 + `WHERE source='builtin' AND slug='general-assistant'`）
- Produces: `MOMO_V22_ALL_BUILTIN_TOOL_REFS`（69 项冻结名单导出，供测试 import）

- [ ] **Step 1: 写失败测试**

```ts
// 079 测试要点（077 测试同构三件套）：
// 1. 冻结名单计数 = 69 且排序后与 catalog ALL_BUILTIN_TOOLS 严格相等（一致性锁）
// 2. 迁移执行后 builtin general-assistant 行 default_tools = 69 项 JSON
// 3. 幂等：重复执行结果不变
// 4. 只命中 builtin + general-assistant（custom 行不动）
```

（具体断言代码沿 `077_momo_resource_creation_tools` 对应测试文件的结构逐句改数。）

- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现**——077 文件整拷改：冻结名单 = 077 的 64 项 + 资源管理 5 项（`describe_agent`, `update_agent_capabilities`, `update_agent_profile`, `update_skill`, `update_mcp`）；yaml 升版与两列表更（skills 含 `manage-agent`——册在 Task 14 落盘，本 Task 先引用，测试只断言 tools 数与 skills 含名）。
- [ ] **Step 4: 跑 077/079/catalog 计数测试全绿**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/storage/migrations/079_momo_capability_management_tools.test.ts tests/storage/migrations/077_momo_resource_creation_tools.test.ts --pool=forks`

- [ ] **Step 5: Commit**

```bash
git add electron/resources/agents/general-assistant.yaml electron/src/main/storage/migrations/079_momo_capability_management_tools.ts electron/src/main/storage/migrations/index.ts electron/tests/storage/migrations/
git commit -m "feat: 会话内能力管理——Momo v2.2.0 工具集 64→69 与存量迁移 079"
```

---

### Task 14: 技能册 `manage-agent` + catalog.json

**Files:**
- Create: `electron/resources/skills/manage-agent/SKILL.md`
- Modify: `resources/marketplace/catalog.json`（+1 条）

**Interfaces:**
- Consumes: spec §10 全文
- Produces: 技能册（触发短语 + 工作流 + 硬规则）；catalog 条目沿既有 create-agent 条目形状

- [ ] **Step 1: 写 SKILL.md**（frontmatter：name「管理智能体」、description 覆盖「给 agent 加技能/加工具/接 MCP/去掉能力/改 prompt/换模型/更新技能内容/更新 MCP 配置/删除引导」触发短语；正文四节：适用场景 / 工作流（盘点→describe→复述→update→确认结果转告生效时机）/ 输出规范 / 硬规则——**删除拒答清单**逐条 + 话术模板 + NEVER bash/sqlite/文件系统绕过 + NEVER slug 冲突换名重建 + NEVER 确认被拒后复读重试 + NEVER 未经用户明示用 definition scope；ALWAYS 改前 describe_agent + 复述变更清单）
- [ ] **Step 2: catalog.json +1 条**（沿 create-agent 条目的 id/version/entry 形状，type=skill）
- [ ] **Step 3: 验证**——`node -e "JSON.parse(require('fs').readFileSync('resources/marketplace/catalog.json','utf8'))"` 通过；SKILL.md frontmatter 与 `parseSkillMd` 兼容（yaml 键名 name/description）
- [ ] **Step 4: Commit**

```bash
git add electron/resources/skills/manage-agent/SKILL.md resources/marketplace/catalog.json
git commit -m "feat: 会话内能力管理——manage-agent 技能册与目录登记"
```

---

### Task 15: 收尾——版本 / 全量回归 / 真机验收

**Files:**
- Modify: 三处 `package.json`（root / electron / renderer）alpha +1
- Test: 全量 vitest + 双 typecheck + e2e 冒烟 + 真机验收（momo-acceptance）

**Interfaces:**
- Consumes: 全部前序任务；`.omo/feature-matrices/2026-11-12-agent-capability-management.md`（W5 回填）
- Produces: 验收证据（.omo/qa-reports/ 报告 + 矩阵回填）

- [ ] **Step 1: 三处 package.json alpha +1**（如 `2.1.0-alpha.N` → `alpha.N+1`；不动终版号）
- [ ] **Step 2: 双 workspace typecheck**

Run: `npx pnpm@9.0.0 typecheck`
Expected: 双绿

- [ ] **Step 3: 全量回归（裸 run，勿加 --pool）**

Run: `npx pnpm@9.0.0 test`
Expected: 全绿；若非正常退出（exit 139/137）按 AGENTS.md 清理孤儿 vitest worker 并复跑

- [ ] **Step 4: 真机验收（加载 momo-acceptance 技能，隔离实例 + CDP）**——spec §13.3 八锚点逐条执行并留证：主链 / 拒绝链 / 后台链 / 自改链 / 存量迁移 / builtin 只读 / 删除拒答零变动 / UI 反向（工具目录 69 项 + 成员编辑勾选）
- [ ] **Step 5: 消费面矩阵 W5 回填**（每格证据：测试名 / 截图 / 报告路径；含至少一个存量 + 一个 builtin 只读场景）
- [ ] **Step 6: Commit**

```bash
git add package.json electron/package.json renderer/package.json
git commit -m "chore: 会话内能力管理合入——alpha 版本号 +1（版本纪律：不动终版号）"
```

---

## 自审记录（writing-plans Self-Review）

1. **Spec coverage**：§5 五工具 → Task 3/5/6/7/8（op）+ Task 11（defs）；§6 → Task 2/3/5/10（白名单、广播矩阵、校验、parity）；§7 → Task 9/10/12；§8 → Task 4/5；§9 → Task 13；§10 → Task 14；§11 保护散落 Task 5/6/7/8 用例；§12 → Task 1/15；§13 → 各 Task 测试 + Task 15；§14 交付物全数有主。无缺口。
2. **Placeholder scan**：Task 13/14 的测试与文案以「077 同构逐句改数」「spec §10 全文落盘」表述——锚的是仓库既有文件与 spec 全文而非 TBD，执行者可直接照抄改数；其余任务均含可运行代码。
3. **Type consistency**：`applyCapabilityDelta` / `resolveAgentTarget` / `requestRespawnAfterIdle` / `confirmTierForOp` / `buildConfirmPayload` / `AgentOpConfirmPayload` / `OpContext` 在定义任务与消费任务间签名一致（Interfaces 区互引核对）。
4. **Review Focus**：五条全部映射到 owning task 的具名用例（T9×2 / T2 parity-3 / T7 / T10）。
