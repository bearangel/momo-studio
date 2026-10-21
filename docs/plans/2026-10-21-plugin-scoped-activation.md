# 插件按工作空间激活与能力授权 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 插件激活模型从「全局装即全量」反转为「安装即作用域 + agent 级逐项授权 + 停用即时全熄」。

**Architecture:** 总闸（plugin_enablements，行缺失=停用）与授权（既有三层能力合并）两层正交。安装链写单行 enablement、零 allocation 写入；spawn 装配面按授权集过滤（skill ∩ merged、tool 白名单滤 modulePaths、MCP 零改动）；setEnabled 双向重建运行时并停用清 MCP 池。

**Tech Stack:** Electron 主进程（CommonJS/TS strict）+ React renderer + better-sqlite3 迁移 + vitest（electron 集中 tests/，renderer 贴源）。

**Spec:** `docs/specs/2026-10-21-plugin-scoped-activation-design.md`（本计划 Task 1 含一处 spec 修订：skill 存量物化由迁移改为启动期回填——迁移是纯 SQL 无法扫盘）

## Global Constraints

- Node 24（`source ~/.nvm/nvm.sh && nvm use 24`）；包管理 `npx pnpm@9.0.0`
- DB 重度测试显式 `--pool=forks`；vitest 非正常退出后清孤儿进程（`ps -axo pid,ppid,command | grep "[v]itest" | awk '$2==1'` kill）
- ABI 纪律：vitest 需 Node ABI（`cd node_modules/.pnpm/better-sqlite3@12.11.1/node_modules/better-sqlite3 && npx prebuild-install && codesign --force --sign - build/Release/better_sqlite3.node`）；真机 App 需 Electron ABI（`cd electron && npx electron-rebuild -f -w better-sqlite3`）
- TS strict：禁 `any` / `@ts-ignore` / `as any`；注释一律中文；renderer 只用语义 token
- Commit：`GIT_MASTER=1 git commit -m '<conventional>' -m "Ultraworked with [Sisyphus](https://github.com/code-yeongyu/oh-my-openagent)" -m "Co-authored-by: Sisyphus <clio-agent@sisyphuslabs.ai>"`；不动版本号
- 单测位置：electron 集中 `electron/tests/`（镜像 src）；renderer 贴源同目录

## Review Focus

1. **停用窗口 MCP 复活**：invalidate 池后，带旧快照的调用不得 re-spawn server——T6 测试钉「停用后 buildSpawnOpts 产物 mcpNames 不含插件名 + 池实例失效调用序」
2. **组模式授权 × 黑名单优先交叉**：`plugin:x/*` 授权 + 精确名禁用同存时禁用胜出——T5 测试覆盖四组合（组授权/精确授权 × 组禁/精确禁）
3. **新建 ws 旧插件应全停**：`backfillPluginMcpsForWorkspace` 摘除后新 ws 无任何注入——T3 测试
4. **回填次序**：迁移先于 handler 注册执行（启动序既有保证）；066 跑完后「无行=停用」只对未回填对象成立（新 ws/新装）——T1/T2 测试各钉一半
5. **启动回填误授权新装插件**：`installed_at >= 截止日` 的插件不得被授 skill——T4 测试
6. **missing 态插件 getDetail / 列表容错**：目录消失不崩——T8/T9 测试

---

### Task 1: 迁移 066 + spec 修订

**Files:**
- Create: `electron/src/main/storage/migrations/066_plugin_scoped_activation.ts`
- Modify: `electron/src/main/storage/migrations/index.ts`（import + 数组追加，紧随 migration065）
- Modify: `docs/specs/2026-10-21-plugin-scoped-activation-design.md` §4（skill 物化改启动期回填）
- Test: `electron/tests/storage/migration-066.test.ts`

**Interfaces:**
- Produces: `export const migration066: { version: 66; up: string; down: string }`（形态镜像 migration065）

- [ ] **Step 1: 写失败测试**

```typescript
// electron/tests/storage/migration-066.test.ts
// 迁移 066：enablements 全量回填（存量 A——全部 ws × plugin 保持启用）。
// skill 物化不在迁移内（纯 SQL 无法扫盘）——由启动期回填承担（Task 4）。
import { describe, it, expect, beforeEach } from 'vitest';
import { runMigrationsForTest } from '../../src/main/storage/db';
// ↑ 若 db.ts 无此导出，镜像 tests/storage/ 下既有迁移测试的启动方式（grep runMigrations）
import { getDb } from '../../src/main/storage/db';

describe('migration 066 plugin scoped activation', () => {
  beforeEach(() => {
    process.env.AP_USER_DATA_DIR = `/tmp/m066-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    runMigrationsForTest();
  });

  it('存量 ws × plugin 全部回填 enabled=1', () => {
    const db = getDb();
    db.prepare(
      `INSERT INTO workspaces (id, name, directory_path, created_at) VALUES ('w1', 'W1', '/tmp/w1', datetime('now'))`,
    ).run();
    db.prepare(
      `INSERT INTO plugins (id, version, manifest_json, state, source, installed_at)
       VALUES ('p1', '1.0.0', '{}', 'active', 'dev', '2026-01-01')`,
    ).run();
    runMigrationsForTest(); // 幂等重放（若 runner 支持指定版本则升到 66）
    const rows = db
      .prepare(`SELECT workspace_id, enabled FROM plugin_enablements WHERE plugin_id = 'p1'`)
      .all() as Array<{ workspace_id: string; enabled: number }>;
    expect(rows).toEqual([{ workspace_id: 'w1', enabled: 1 }]);
  });

  it('down 清除回填行（保守：仅删 enabled=1 全 ws 对齐行集）', () => {
    // 与 065 down 风格一致：down 保守可不完全逆
    const db = getDb();
    db.prepare(`DELETE FROM plugin_enablements`).run();
    expect(db.prepare(`SELECT COUNT(*) c FROM plugin_enablements`).get()).toMatchObject({ c: 0 });
  });
});
```

注：`runMigrationsForTest` 名称以既有迁移测试为准（`grep -rn "migrat" electron/tests/storage/ --include="*.test.ts" -l` 找最近一个迁移测试文件镜像其夹具）。**066 必须在迁移后注册进数组，否则存量库升级即全停**。

- [ ] **Step 2: 跑测试确认失败**

```bash
source ~/.nvm/nvm.sh && nvm use 24 >/dev/null && cd electron && npx pnpm@9.0.0 vitest run tests/storage/migration-066.test.ts --pool=forks
```
预期：FAIL（migration066 不存在 / 版本未达 66）

- [ ] **Step 3: 实现**

```typescript
// electron/src/main/storage/migrations/066_plugin_scoped_activation.ts
//
// 插件作用域激活（spec 2026-10-21 §4）：enablements 默认语义翻转为「行缺失=停用」，
// 本迁移为存量库一次性回填全部 (ws × plugin) = enabled=1（存量决策 A：保持现状）。
// 新装插件 / 新建 ws 不回填——走安装链单行写入（spec §5）。
// skill 授权物化不在迁移内（纯 SQL 无法扫盘取 slug）——启动期回填承担（installed_at 截止日判定）。
export interface Migration066 {
  version: number;
  up: string;
  down: string;
}

export const migration066: Migration066 = {
  version: 66,
  up: `
    INSERT OR IGNORE INTO plugin_enablements (workspace_id, plugin_id, enabled)
      SELECT w.id, p.id, 1 FROM workspaces w CROSS JOIN plugins p;
  `.trim(),
  down: `
    -- down 保守：回填行与用户手写行不可区分，只删「全 ws 对齐」的行集合
    DELETE FROM plugin_enablements
    WHERE (plugin_id, workspace_id) IN (
      SELECT pe.plugin_id, pe.workspace_id FROM plugin_enablements pe
      JOIN plugins p ON p.id = pe.plugin_id
      WHERE (SELECT COUNT(*) FROM workspaces) =
        (SELECT COUNT(*) FROM plugin_enablements WHERE plugin_id = pe.plugin_id AND enabled = 1)
    );
  `.trim(),
};
```

`index.ts` 追加（紧随 migration065 同款形态）：

```typescript
import { migration066 } from './066_plugin_scoped_activation';
// 数组内：...migration065 的注册项之后追加 migration066 的注册项（同款展开形态）
```

同时修订 spec §4 第 2 条为：「**存量 skill 授权物化（启动期回填）**：迁移是纯 SQL 无法扫盘取 skill slug——由 app 启动后 `backfillLegacyPluginSkillGrants()`（installed_at < 2026-10-21 截止，INSERT OR IGNORE 幂等）承担，见 Task 4」。

- [ ] **Step 4: 跑测试确认通过**（同 Step 2 命令，预期 PASS）

- [ ] **Step 5: Commit**

```bash
cd /Users/stbearangel/dev/AiProject/moo-studio && GIT_MASTER=1 git add -A && GIT_MASTER=1 git commit -m 'feat: 迁移 066 插件作用域激活存量回填（spec 同步修订——skill 物化改启动期回填）' -m "Ultraworked with [Sisyphus](https://github.com/code-yeongyu/oh-my-openagent)" -m "Co-authored-by: Sisyphus <clio-agent@sisyphuslabs.ai>"
```

---

### Task 2: isPluginEnabled 默认语义翻转

**Files:**
- Modify: `electron/src/main/plugin/registry.ts:84-89`
- Modify: `electron/src/main/plugin/ipc.handlers.ts`（setEnabled ×2 / setConfig ×1 的 stillEnabled 查询）
- Modify: `electron/src/main/plugin/resources.ts:40` 及注释、`electron/src/main/resource/types.ts:105`、`renderer/src/ipc/types.d.ts:955`（「行缺失 = 启用」注释改「行缺失 = 停用」）
- Test: `electron/tests/plugin/registry.test.ts`（翻转既有断言 + 新用例）

**Interfaces:**
- Consumes: Task 1 的迁移回填（存量行在场）
- Produces: `isPluginEnabled(pluginId, workspaceId): boolean`——行缺失返回 **false**（签名不变，全部 13 调用点零改动）

- [ ] **Step 1: 失败测试**（registry.test.ts 追加；若既有用例断言「行缺失=启用」先翻转它）

```typescript
it('行缺失 = 停用（scoped activation 语义翻转）', () => {
  expect(isPluginEnabled('no-row-plugin', 'ws1')).toBe(false);
});
it('显式 enabled=1 行 = 启用；enabled=0 = 停用', () => {
  setPluginEnabled('p-flip', 'ws1', true);
  expect(isPluginEnabled('p-flip', 'ws1')).toBe(true);
  setPluginEnabled('p-flip', 'ws1', false);
  expect(isPluginEnabled('p-flip', 'ws1')).toBe(false);
});
```

（夹具镜像该文件既有用例的建库方式）

- [ ] **Step 2: 跑测试确认失败**

```bash
source ~/.nvm/nvm.sh && nvm use 24 >/dev/null && cd electron && npx pnpm@9.0.0 vitest run tests/plugin/registry.test.ts --pool=forks
```

- [ ] **Step 3: 实现**

registry.ts：

```typescript
/**
 * workspace 级启停解析（spec 2026-10-21 §2）：行缺失 = 停用（scoped 语义；
 * 存量库由迁移 066 回填 enabled=1 保现状，新装/新 ws 走安装链单行写入）。
 */
export function isPluginEnabled(pluginId: string, workspaceId: string): boolean {
  const row = getDb()
    .prepare(`SELECT enabled FROM plugin_enablements WHERE workspace_id = ? AND plugin_id = ?`)
    .get(workspaceId, pluginId) as { enabled: number } | undefined;
  return row?.enabled === 1;
}
```

ipc.handlers.ts 三处 stillEnabled（setEnabled hooks 段 / service 段、setConfig 段）统一替换为：

```typescript
const stillEnabled = getDb()
  .prepare(
    `SELECT COUNT(*) AS n FROM plugin_enablements WHERE plugin_id = ? AND enabled = 1`,
  )
  .get(id) as { n: number };
```

（三处入参名不同——按各处既有变量替换；LEFT JOIN 形态废除）

- [ ] **Step 4: 回归**——`tests/plugin/ tests/agent/ --pool=forks` 全绿（装配/面板/service 域用例在「无行」夹具下可能需补 enablement 行——逐个失败用例在其夹具 seed 加 `setPluginEnabled(id, ws, true)`，不改断言语义）

- [ ] **Step 5: Commit**

```bash
GIT_MASTER=1 git add -A && GIT_MASTER=1 git commit -m 'feat: isPluginEnabled 行缺失语义翻转为停用（stillEnabled 三处查询同步）' -m "Ultraworked with [Sisyphus](https://github.com/code-yeongyu/oh-my-openagent)" -m "Co-authored-by: Sisyphus <clio-agent@sisyphuslabs.ai>"
```

---

### Task 3: 安装链作用域化

**Files:**
- Modify: `electron/src/main/plugin/installer.ts`（installPluginZip/installPluginDevDir 增参 + 写单行 enablement；activateDeclarativeComponents 去 assignPluginMcpsToAllWorkspaces）
- Modify: `electron/src/main/plugin/ipc.handlers.ts`（installZip/installDevDir 通道增参 + getActiveWorkspaceId 兜底）
- Modify: `electron/src/main/plugin/mcp-sync.ts`（删 assignPluginMcpsToAllWorkspaces / backfillPluginMcpsForWorkspace）
- Modify: 调用点摘除——`grep -rn "backfillPluginMcpsForWorkspace" electron/src`（createWorkspace 处）
- Modify: `electron/src/preload/index.ts`、`renderer/src/ipc/types.d.ts`（installZip/installDevDir 增第三参）
- Modify: `renderer/src/components/resource-library/InstallPluginZipDialog.tsx` / `RegisterPluginDirDialog.tsx`（传 activeWorkspaceId）
- Test: `electron/tests/plugin/install-scoped.test.ts`、`renderer/src/components/resource-library/InstallPluginZipDialog.test.tsx`（更新调用断言）

**Interfaces:**
- Produces: `installPluginZip(data: Buffer, currentAppVersion: string, originWorkspaceId: string)`、`installPluginDevDir(dir: string, currentAppVersion: string, originWorkspaceId: string)`；IPC `plugin:installZip(data, filename, workspaceId?)` / `plugin:installDevDir(dir, workspaceId?)`（缺省取 `getActiveWorkspaceId()`，仍空 → throw「无活动工作空间，无法确定安装作用域」）
- 退役: `assignPluginMcpsToAllWorkspaces` / `backfillPluginMcpsForWorkspace`（连同测试 `plugin-mcp-autoassign.test.ts` 删除或改写为「不注入」断言）

- [ ] **Step 1: 失败测试**

```typescript
// electron/tests/plugin/install-scoped.test.ts
// 安装即作用域（spec §5）：写单行 enablement(安装ws=1)、allocation 零写入、
// 无活动 ws 报错；新建 ws 不回填（backfill 摘除的回归锚）。
import { describe, it, expect, beforeEach } from 'vitest';
// 夹具镜像 tests/plugin/installer.test.ts：临时 plugins 目录 + AP_USER_DATA_DIR 隔离库
// （该文件已有完整 zip 构造 helper——直接复用其 makeZip/seedWorkspaces 工具，或提取共用）

describe('安装即作用域', () => {
  beforeEach(() => { /* 镜像 installer.test.ts 夹具 */ });

  it('安装于 ws1 → enablements 仅 (ws1,plugin,1) 一行，workspace_allocations 零写入', async () => {
    seedWorkspace('ws1'); seedWorkspace('ws2');
    const rec = await installPluginZip(makeZip('p-scoped'), '2.1.0', 'ws1');
    const db = getDb();
    const rows = db.prepare(`SELECT * FROM plugin_enablements WHERE plugin_id = ?`).all(rec.id);
    expect(rows).toEqual([{ workspace_id: 'ws1', plugin_id: 'p-scoped', enabled: 1 }]);
    const allocs = db
      .prepare(`SELECT COUNT(*) c FROM workspace_allocations WHERE capability_type = 'mcp' AND capability_ref = 'cgx'`)
      .get();
    expect(allocs).toMatchObject({ c: 0 });
  });

  it('无 origin ws → 报错且不落盘', async () => {
    await expect(installPluginZip(makeZip('p-noWs'), '2.1.0', '')).rejects.toThrow('无法确定安装作用域');
  });
});
```

- [ ] **Step 2: 确认失败**（同 Task 1 命令式，跑 `tests/plugin/install-scoped.test.ts`）

- [ ] **Step 3: 实现**

installer.ts 两处签名改 `originWorkspaceId: string`（入口即校验空串 throw「无活动工作空间，无法确定安装作用域」——在 upsert **前**抛，staging 不残留）；`activateDeclarativeComponents` 内：

```typescript
try {
  // scoped activation（spec §5）：MCP 定义照常注册（能力池），allocation 零写入
  syncPluginMcps(rec);
} catch (err) { /* 既有 warn 形态 */ }
setPluginEnabled(rec.id, originWorkspaceId, true); // 安装 ws 单行启用
```

（activateDeclarativeComponents 增参 originWorkspaceId 透传）；mcp-sync.ts 删两个函数；ipc.handlers.ts 两通道改 `(data, _filename, workspaceId?: string)` → `workspaceId ?? getActiveWorkspaceId() ?? ''` 传入；preload/types.d.ts 增参 `workspaceId?: string`；两个 Dialog 用 `useWorkspaceStore((s) => s.activeWorkspaceId)` 传出。`grep -rn "assignPluginMcpsToAllWorkspaces\|backfillPluginMcpsForWorkspace" electron/ --include="*.ts"` 确认零残留（含测试改写）。

- [ ] **Step 4: 回归**——`tests/plugin/ --pool=forks` + `cd renderer && npx pnpm@9.0.0 vitest run src/components/resource-library/`

- [ ] **Step 5: Commit**

```bash
GIT_MASTER=1 git add -A && GIT_MASTER=1 git commit -m 'feat: 安装即作用域——安装链单行 enablement + D2 全空间注入退役' -m "Ultraworked with [Sisyphus](https://github.com/code-yeongyu/oh-my-openagent)" -m "Co-authored-by: Sisyphus <clio-agent@sisyphuslabs.ai>"
```

---

### Task 4: 启动期存量 skill 授权回填

**Files:**
- Create: `electron/src/main/plugin/legacy-grants.ts`
- Modify: `electron/src/main/plugin/boot-reactivation.ts` 或 app 启动装配点（`grep -rn "syncPluginHooks" electron/src/main --include="*.ts" -l` 定位既有 boot 激活链，紧随其后调用）
- Test: `electron/tests/plugin/legacy-grants.test.ts`

**Interfaces:**
- Produces: `export function backfillLegacyPluginSkillGrants(cutoffIso = '2026-10-21'): void`——`installed_at < cutoff` 的插件 × 全部 ws × `listAllPluginSkills()` slug → `INSERT OR IGNORE INTO workspace_allocations (ws,'skill',slug)`；幂等

- [ ] **Step 1: 失败测试**

```typescript
// electron/tests/plugin/legacy-grants.test.ts
// 截止日语义：pre-cutoff 授、post-cutoff 不授、幂等重放、目录缺失静默跳过
it('pre-cutoff 插件 skill 写入全部 ws 的 skill allocation；post-cutoff 不写', () => {
  seedPlugin('p-old', { installedAt: '2026-10-01', skills: ['sk-old'] });
  seedPlugin('p-new', { installedAt: '2026-10-22', skills: ['sk-new'] });
  seedWorkspace('w1');
  backfillLegacyPluginSkillGrants('2026-10-21');
  const refs = skillAllocationRefs(); // SELECT capability_ref FROM workspace_allocations WHERE capability_type='skill'
  expect(refs).toContain('sk-old');
  expect(refs).not.toContain('sk-new');
});
it('重放幂等（二次调用行数不变）', () => { /* 同上再跑一次断言行数相等 */ });
```

（seedPlugin 夹具：临时目录建 skills/<slug>/SKILL.md + plugins 行——镜像 tests/plugin/ 夹具风格）

- [ ] **Step 2: 确认失败** → **Step 3: 实现**

```typescript
// electron/src/main/plugin/legacy-grants.ts
// 存量 skill 授权回填（spec §4 修订版）：installed_at 截止日前的插件，其 skill
// 授权物化为 ws allocation 行（存量决策 A——存量 agent 继续可见）。幂等可重放。
import { listPlugins } from './registry';
import { listAllPluginSkills, resolvePluginRoot } from './assembly';
import { getDb } from '../storage/db';

const CUTOFF = '2026-10-21';

export function backfillLegacyPluginSkillGrants(cutoffIso: string = CUTOFF): void {
  const legacy = listPlugins().filter((p) => p.installedAt < cutoffIso && p.state === 'active');
  if (legacy.length === 0) return;
  const slugsByPlugin = new Map<string, string[]>();
  for (const p of legacy) {
    if (resolvePluginRoot(p) === null) continue; // missing 态跳过（目录恢复后重放补）
    slugsByPlugin.set(
      p.id,
      listAllPluginSkills().filter((s) => s.pluginId === p.id).map((s) => s.slug),
    );
  }
  const wsIds = getDb().prepare(`SELECT id FROM workspaces`).all() as Array<{ id: string }>;
  const ins = getDb().prepare(
    `INSERT OR IGNORE INTO workspace_allocations (workspace_id, capability_type, capability_ref) VALUES (?, 'skill', ?)`,
  );
  for (const { id: ws } of wsIds) {
    for (const slugs of slugsByPlugin.values()) for (const s of slugs) ins.run(ws, s);
  }
}
```

boot 接线：在既有插件 boot 激活链（grep 定位）末尾加 `try { backfillLegacyPluginSkillGrants(); } catch { /* warn */ }`。

- [ ] **Step 4: 确认通过 + Commit**

```bash
GIT_MASTER=1 git add -A && GIT_MASTER=1 git commit -m 'feat: 存量插件 skill 授权启动期幂等回填（installed_at 截止日判定）' -m "Ultraworked with [Sisyphus](https://github.com/code-yeongyu/oh-my-openagent)" -m "Co-authored-by: Sisyphus <clio-agent@sisyphuslabs.ai>"
```

---

### Task 5: 装配链翻转（skill ∩ merged / tool 白名单）

**Files:**
- Modify: `electron/src/main/plugin/assembly.ts`（新增 `filterPluginToolRefsByGrant` + `toolRefMatches`）
- Modify: `electron/src/main/agent/spawn-helpers.ts`（buildSpawnOpts 的 skills / pluginTools 两行）
- Test: `electron/tests/plugin/assembly-grants.test.ts`

**Interfaces:**
- Produces:
  - `export function filterPluginToolRefsByGrant(refs: PluginToolRef[], grants: string[], denied: string[]): PluginToolRef[]`——modulePaths 按 `plugin:<id>/<basename 去掉 .js>` 匹配 grants（精确名或 `plugin:<id>/*` 组模式），再被 denied（组/精确）剔除；modulePaths 全空的 ref 丢弃
  - `export function toolRefMatches(fullName: string, patterns: string[]): boolean`——精确相等或 `plugin:<id>/*` 前缀组
- spawn-helpers 接线（形状）：

```typescript
// buildSpawnOpts 内，mergeCapabilities 之后：
const pluginSkillRefs = buildPluginSkillRefs(workspaceId);
const pluginSkillSlugs = new Set(pluginSkillRefs.map((r) => r.slug));
// …skills: [
//   ...resolveSkillSlugs(merged.skills.filter((s) => !pluginSkillSlugs.has(s))),
//   ...pluginSkillRefs.filter((r) => merged.skills.includes(r.slug)),
// ]
// …pluginTools: filterPluginToolRefsByGrant(
//   buildPluginToolRefs(workspaceId),
//   [...new Set([...allocation.tools, ...(deltas.addedPluginTools ?? [])])],
//   merged.deniedTools,
// ),
```

- [ ] **Step 1: 失败测试**（覆盖 Review Focus 2 的四组合 + skill 门 + 全滤丢弃）

```typescript
// electron/tests/plugin/assembly-grants.test.ts
// 夹具：临时插件目录 tools/a.js + tools/b.js + skills/sk1/SKILL.md，plugins 行 + enablements 行
describe('装配授权过滤', () => {
  it('tool：组授权 plugin:p/* → a/b 均装配；叠加精确禁 plugin:p/a → 仅 b', () => { /* 断言 refs[0].modulePaths basename */ });
  it('tool：精确授权 plugin:p/a → 仅 a；无授权 → refs 为空（全滤丢弃）', () => {});
  it('tool：授权 ∪ addedPluginTools（成员勾选）参与 grants', () => {});
  it('skill：插件 skill 仅当 slug ∈ merged 入参才产出（由 spawn-helpers 组合——此处测 buildPluginSkillRefs 原样 + 过滤式由 spawn-helpers 测试覆盖）', () => {});
});
```

另在 `tests/agent/spawn-helpers-*.test.ts` 风格文件加一个组合用例：seed def（无插件声明）+ allocation 含 `plugin:p/*` + 插件启用 → buildSpawnOpts 产物 pluginTools 含该模块；去掉 allocation → 不含；merged.skills 含 'sk1' → skills 含插件 cachePath，不含则无。

- [ ] **Step 2: 确认失败** → **Step 3: 实现**（assembly.ts 加两个纯函数 + spawn-helpers 两行接线，如 Interfaces 形状）→ **Step 4: 回归** `tests/plugin/ tests/agent/ --pool=forks` → **Step 5: Commit**

```bash
GIT_MASTER=1 git add -A && GIT_MASTER=1 git commit -m 'feat: 装配链授权翻转——插件 skill 进三层合并、工具白名单滤装配快照' -m "Ultraworked with [Sisyphus](https://github.com/code-yeongyu/oh-my-openagent)" -m "Co-authored-by: Sisyphus <clio-agent@sisyphuslabs.ai>"
```

---

### Task 6: setEnabled 双向重建 + 停用清 MCP 池

**Files:**
- Modify: `electron/src/main/plugin/reload.ts`（抽 `export async function rebuildWorkspaceRuntimes(pluginId: string, workspaceId: string): Promise<void>`——原 rebuildAffectedRuntimes 内循环体；后者改为逐 ws 调它，行为不变）
- Modify: `electron/src/main/plugin/ipc.handlers.ts` setEnabled 通道（末尾追加）
- Test: `electron/tests/plugin/setenabled-rebuild.test.ts`

**Interfaces:**
- Produces: `rebuildWorkspaceRuntimes(pluginId, workspaceId)`——该 ws `lastRunning` 成员逐个 stop→start（新 opts；失败 warn 继续，镜像 reload 语义）
- setEnabled 追加段：

```typescript
// scoped activation（spec §7）：启停双向重建该 ws 在线成员（停用=能力立即摘除；
// 启用=授权面立即生效）。停用方向先失效该插件 MCP 池实例（防残留与按需复活）。
const serverNames = getDb()
  .prepare(`SELECT name FROM mcp_definitions WHERE plugin_id = ?`)
  .all(id) as Array<{ name: string }>;
if (!enabled) for (const { name } of serverNames) invalidateMcpByName(name);
void rebuildWorkspaceRuntimes(id, workspaceId).catch((err) =>
  logger.warn('启停运行时重建失败（下一 spawn 新装配兜底）', { pluginId: id, error: String(err) }),
);
```

（invalidateMcpByName 已在该文件 import ✓；logger 已 import ✓）

- [ ] **Step 1: 失败测试**——seed：ws + 插件（mcp 定义 `cgx`）+ lastRunning 成员（mock runtime-registry stop/start 计数，镜像 tests/plugin/reload 类测试的 mock 方式）。断言：setEnabled(false) → stop/start 各一次 + invalidate 被调（mock host-manager）+ 重建后 buildSpawnOpts 的 mcpNames 不含 cgx（组合断言：调用 isPluginEnabled 已 false + filterDisabledPluginMcps 生效——直接断言 mock 的 start 收到新 opts.mcpNames 不含 'cgx'）
- [ ] **Step 2: 确认失败** → **Step 3: 实现** → **Step 4: 回归** → **Step 5: Commit**

```bash
GIT_MASTER=1 git add -A && GIT_MASTER=1 git commit -m 'feat: 插件启停即时生效——双向运行时重建 + 停用清 MCP 池（冻结语义收窄至配置变更）' -m "Ultraworked with [Sisyphus](https://github.com/code-yeongyu/oh-my-openagent)" -m "Co-authored-by: Sisyphus <clio-agent@sisyphuslabs.ai>"
```

---

### Task 7: 卸载级联清授权行

**Files:**
- Create: `electron/src/main/agent/grant-cleanup.ts`（或并入 assignment-capabilities.ts——按该文件内聚度定）
- Modify: `electron/src/main/plugin/installer.ts` uninstallPlugin（removePluginRecord 之前、目录删除之前调用）
- Test: `electron/tests/plugin/uninstall-grants.test.ts`

**Interfaces:**
- Produces: `export function removePluginCapabilityGrants(pluginId: string, skillSlugs: string[]): void`

```typescript
// agent_assignment_capabilities：plugin_tool 前缀 + 组模式行；skill 精确行
// workspace_allocations：skill 精确行（mcp 行由既有 removePluginMcps 清）
const db = getDb();
db.prepare(`DELETE FROM agent_assignment_capabilities WHERE capability_type='plugin_tool' AND (ref LIKE ? OR ref = ?)`)
  .run(`plugin:${pluginId}/%`, `plugin:${pluginId}/*`);
if (skillSlugs.length > 0) {
  const ph = skillSlugs.map(() => '?').join(',');
  db.prepare(`DELETE FROM agent_assignment_capabilities WHERE capability_type='skill' AND ref IN (${ph})`).run(...skillSlugs);
  db.prepare(`DELETE FROM workspace_allocations WHERE capability_type='skill' AND capability_ref IN (${ph})`).run(...skillSlugs);
}
```

uninstallPlugin 接线（在 `removePluginAgents` 附近，**先于目录删除**取 slug）：

```typescript
try {
  const slugs = listAllPluginSkills().filter((s) => s.pluginId === id).map((s) => s.slug);
  removePluginCapabilityGrants(id, slugs);
} catch (err) { logger.warn('插件卸载：授权行级联清理失败', { pluginId: id, error: String(err) }); }
```

- [ ] **Step 1: 失败测试**（seed 授权行 → 卸载 → 断言零残留）→ **Step 2-5: 同环 + Commit**

```bash
GIT_MASTER=1 git add -A && GIT_MASTER=1 git commit -m 'feat: 卸载级联清理插件能力授权行（防同 id 重装冒用继承）' -m "Ultraworked with [Sisyphus](https://github.com/code-yeongyu/oh-my-openagent)" -m "Co-authored-by: Sisyphus <clio-agent@sisyphuslabs.ai>"
```

---

### Task 8: plugin:getDetail IPC

**Files:**
- Create: `electron/src/main/plugin/inventory.ts`
- Modify: `electron/src/main/plugin/ipc.handlers.ts`（注册通道）、`electron/src/preload/index.ts`、`renderer/src/ipc/types.d.ts`（PluginDetail 类型 + PluginApiSurface.getDetail）
- Test: `electron/tests/plugin/inventory.test.ts`

**Interfaces:**
- Produces:

```typescript
// electron/src/main/plugin/inventory.ts
export interface PluginDetail {
  pluginId: string;
  mcps: Array<{ name: string }>;                       // mcp_definitions WHERE plugin_id=?
  tools: Array<{ fullName: string; description: string; pluginName: string }>; // listAssembledToolDefs(ws?) 过滤本插件（ws 可选——停用 ws 下为空，传 undefined 用全量 active 扫描）
  skills: Array<{ slug: string }>;                     // listAllPluginSkills 过滤
  agents: Array<{ id: string; name: string }>;         // agent_definitions WHERE source='plugin' AND id LIKE 'plugin:<id>:%'
  panels: Array<{ panelId: string; title: string }>;   // manifest.components.panel 存在性（无 per-panel 清单则 [{panelId:'default', title:'插件面板'}]，以 listPluginPanels 可用性为准——实施时对齐）
  service: boolean;                                    // !!manifest.components.service
  config: boolean;                                     // !!manifest.config
}
export function getPluginDetail(pluginId: string, workspaceId?: string): PluginDetail
```

（missing 态：各数组空 + service/config false，不 throw——Review Focus 6）

- [ ] **Step 1: 失败测试**（含 missing 容错用例）→ **Step 2-5: 同环 + Commit**

```bash
GIT_MASTER=1 git add -A && GIT_MASTER=1 git commit -m 'feat: 插件明细组件清单 IPC（MCP/工具/skill/agent/面板/service/config）' -m "Ultraworked with [Sisyphus](https://github.com/code-yeongyu/oh-my-openagent)" -m "Co-authored-by: Sisyphus <clio-agent@sisyphuslabs.ai>"
```

---

### Task 9: renderer 列表面（P1 预览门禁 → 开关+徽标+明细）

**Files:**
- Create: `renderer/src/components/resource-library/PluginManageSection.tsx` + 贴源 `PluginManageSection.test.tsx`
- Modify: `renderer/src/components/resource-library/ResourceLibraryView.tsx`（插件页签改用新组件；`grep -n "type: 'plugin'" renderer/src/components/resource-library/ResourceLibraryView.tsx` 定位列表调用，resource.list 增 `workspaceId: activeWorkspaceId ?? undefined`）
- Modify: `renderer/src/stores/*`（若插件列表已有 store 选型则跟随；否则组件内自取，与 PluginSettings 同款 useWorkspaceStore）

**Interfaces:**
- Consumes: `ResourceItem.plugin.enabled`（Task 2 后按活动 ws 真实反映）、`ipc.plugin.setEnabled`、`ipc.plugin.getDetail`（Task 8）
- Produces: `<PluginManageSection items={ResourceItem[]} />`——行：名称/版本/徽标（已启用=text-status-success、已停用=text-tertiary、missing=text-status-error）/开关（Checkbox 调 setEnabled(id, activeWs, next) 后本地刷新）；行展开：getDetail 清单分组渲染

- [ ] **Step 0: P1 预览门禁**——按 `momo-ui-preview-rules` 产出静态预览（HTML 骨架 + 语义 token 类）请用户确认后实现；用户豁免则记录三条件裁定
- [ ] **Step 1: 失败测试**——jsdom 渲染：mock ipc（setEnabled/getDetail/list），断言徽标文案、开关调用参数、展开明细分组标题（MCP/工具/Skill/Agent）
- [ ] **Step 2: 确认失败** → **Step 3: 实现**（受控组件 + useWorkspaceStore activeWorkspaceId；刷新走 `ipc.resource.list({type:'plugin', workspaceId})` 重拉）→ **Step 4: 回归** `cd renderer && npx pnpm@9.0.0 vitest run src/components/resource-library/` → **Step 5: Commit**

```bash
GIT_MASTER=1 git add -A && GIT_MASTER=1 git commit -m 'feat: 资源库插件管理面——工作空间级启停开关/徽标/组件明细清单' -m "Ultraworked with [Sisyphus](https://github.com/code-yeongyu/oh-my-openagent)" -m "Co-authored-by: Sisyphus <clio-agent@sisyphuslabs.ai>"
```

---

### Task 10: PluginToolsSection 受控化 + 成员授权翻转

**Files:**
- Modify: `renderer/src/components/agent/PluginToolsSection.tsx`（props 改 `checkedFullNames: string[]` + `onChange(next: string[])`；渲染 checked=命中）
- Modify: `renderer/src/lib/capability-helpers.ts`（`computePluginToolDeltas`/`effectivePluginDenied` 翻转为授权模型：新增 `effectivePluginAllowed(defDenied, deltas)`、`computePluginToolGrantDeltas`；旧函数若 DefinitionEditor 仍用则保留 denied 形态并注明双语义）
- Modify: `renderer/src/components/agent/MemberEditDialog.tsx`（插件工具区改授权换算——初值 = effectivePluginAllowed，保存 = computePluginToolGrantDeltas）
- Modify: `renderer/src/components/agent/DefinitionEditor.tsx`（props 适配：deniedTools → checkedFullNames = 全量 − denied（computeDeniedTools 保留供换算））
- Test: 贴源 `PluginToolsSection.test.tsx`、`capability-helpers.test.ts`、`MemberEditDialog.test.tsx`（更新断言）

**Interfaces:**
- Produces: `PluginToolsSectionProps { tools: PluginToolInfo[]; checkedFullNames: string[]; onChange(next: string[]): void; disabled: boolean }`；`effectivePluginAllowed(defDenied: string[], deltas: {addedPluginTools?: string[]; removedPluginTools?: string[]}): string[]`——语义：勾选 = 授权（addedPluginTools），未勾 = 未授权或被 def 禁

- [ ] **Step 1: 失败测试**（受控组件渲染 + 授权换算四组合）→ **Step 2: 确认失败** → **Step 3: 实现** → **Step 4: 回归** `cd renderer && npx pnpm@9.0.0 vitest run src/components/agent/ src/lib/` → **Step 5: Commit**

```bash
GIT_MASTER=1 git add -A && GIT_MASTER=1 git commit -m 'feat: 插件工具成员授权模型——PluginToolsSection 受控化与勾选语义真翻转' -m "Ultraworked with [Sisyphus](https://github.com/code-yeongyu/oh-my-openagent)" -m "Co-authored-by: Sisyphus <clio-agent@sisyphuslabs.ai>"
```

---

### Task 11: 全量回归 + 真机验收

**Files:** 无新文件（验收产物落 `.omo/qa-reports/`）

- [ ] **Step 1: mono typecheck**——`npx pnpm@9.0.0 typecheck`，过滤既有 tests 域类型债（`grep -vE "tests/(agent|im|compaction|mcp/http|task|integration|session|storage)"`）后须零新增
- [ ] **Step 2: 全量测试**——两 workspace `npx pnpm@9.0.0 test`（ABI 切 Node 侧 + forks + 清孤儿）
- [ ] **Step 3: 真机验收**（`momo-acceptance` skill；ABI 切 Electron 侧 + 重启 App）锚点：
  1. 存量：dape ws 停用 codegraph → 在线 agent 重建 → 新会话无 codegraph 工具 → 重启用恢复
  2. 存量：Momo 成员勾选 codegraph MCP → 会话真机调用 `codegraph_explore` 成功
  3. 新装：zip 装于 ws X → X 徽标已启用、ws Y 已停用 → Y 启用 → agent 勾选授权生效
  4. 存量 skill：codegraph-usage 对现有 agent 可见（066+回填后）→ 取消勾选消失
  5. 新建 ws：全部插件默认停用
- [ ] **Step 4: 验收报告**——`.omo/qa-reports/2026-10-21-plugin-scoped-activation/report.md`

---

## Self-Review 记录

1. **Spec 覆盖**：§4→T1/T4；§5→T3；§6→T5；§7→T6；§8→T7；§9①→T9；§9②→T8/T9；§9③→T10（MCP/skill 页签零改动——CapabilityTabs 数据源已含 plugin 行，勾选态=合并终态，无需任务）；§10 矩阵由 T2-T10 组合覆盖；§11 锚点→T11。**无缺口**。
2. **占位符**：夹具「镜像既有测试」处均为真实存在的锚（文件名给出 + grep 命令给出），非 TBD。
3. **类型一致**：`filterPluginToolRefsByGrant`/`rebuildWorkspaceRuntimes`/`removePluginCapabilityGrants`/`getPluginDetail`/`PluginManageSection` 前后一致；`migration066` 形态镜像 065。
4. **Review Focus**：六条均有对应任务测试（见各任务）。
