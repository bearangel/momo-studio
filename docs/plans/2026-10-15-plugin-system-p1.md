# 插件系统 P1 实施计划：PluginRegistry + 安装链 + 资源库插件页

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地插件系统 P1——momo-plugin.json manifest 校验管线、zip / dev 目录两条安装链、机器级注册表 + workspace 级启停（DB 迁移 057）、资源库第四类型页「插件」。「装得上、管得了」。

**Architecture:** 新增 `electron/src/main/plugin/` 域模块（types / manifest / registry / installer / ipc.handlers），声明式组件**不激活**（skills/agents/mcp 激活属 P2，本计划只做注册与展示）。插件行映射进现有 `ResourceItem`（type='plugin', source='custom'，插件特有信息放新增 `plugin` namespace），资源库 UI 复用 TypePageShell 同构骨架。

**Tech Stack:** Electron 主进程（CJS）、better-sqlite3（内联 SQL 迁移）、adm-zip（复用 skill zip 链）、React + zustand（renderer）。

**Spec:** `docs/specs/2026-10-15-plugin-system-design.md`（本计划论证自 spec §2 §7 §8；执行者须同时读 spec）

## Global Constraints

- Node 20 LTS（容器内先 `nvm use 20`）；TypeScript strict，禁 `any` / `@ts-ignore` / `as any`
- 所有代码注释、错误消息中文；Conventional Commits（`feat:` / `test:` / `docs:`）
- IPC 契约改动 = 三层同改（`renderer/src/ipc/types.d.ts` + `electron/src/preload/index.ts` + 主进程 handler），改完**双 workspace typecheck**（`npx pnpm@9.0.0 typecheck`）——momo-boundary-rules 域
- 测试位置：electron 主进程集中 `electron/tests/`（镜像 src 结构 → `electron/tests/plugin/`）；renderer 贴源 colocated
- 测试保真按 momo-test-rules：IPC handler 测试用 `vi.mock('electron')` + `vi.hoisted` 范式；DB/安装链测试用 tmpdir + `AP_USER_DATA_DIR` + `runMigrations()` 真实链
- renderer UI 只用语义 token + lucide-react 16px stroke 1.75，禁标准 Tailwind 色阶与 emoji 图标（docs/dev/design-system.md）
- **UI 任务（Task 9）执行前按 momo-ui-preview-rules 走静态预览门禁**（新弹窗 + 第四类型页属 P1 变更，须预览确认后实现）
- 版本纪律：本计划收尾只把三处 package.json alpha 号 +1，不动产品版本号

## Review Focus

spec 隐含但易漏的输入类，逐条钉进 owning task 的测试：

1. **zip bomb**（解压累计超限）→ Task 4 测试：构造 uncompressed 超上限 zip 断言拒装（现有 skill 链无此守卫，插件链新增）
2. **zip entry 路径穿越**（entryName 含 `..` / 绝对路径）→ Task 4 测试：断言跳过或拒装，installed 目录无越界文件
3. **manifest components 路径越界**（`../` / 绝对路径 / 反斜杠）→ Task 2 测试：断言 `PluginManifestError` 带字段路径
4. **minAppVersion 高于当前版本** → Task 4 测试：断言中文拒装消息
5. **dev 目录被删除**（注册后源目录消失）→ Task 3/6 测试：断言 list 返回 `state: 'missing'`，UI 可见降级态而非崩溃

---

### Task 1: DB 迁移 057（plugins + plugin_enablements 两表）

**Files:**
- Create: `electron/src/main/storage/migrations/057_plugin_registry.ts`
- Modify: `electron/src/main/storage/migrations/index.ts`（import + MIGRATIONS 数组末尾追加）
- Test: `electron/tests/storage/migration-057-plugin-registry.test.ts`

**Interfaces:**
- Consumes: `runMigrations()`（db.ts，现有）
- Produces: `migration057: { version: 57, up: string, down: string }`；两张表 `plugins(id, version, manifest_json, state, source, source_path, installed_at)` 与 `plugin_enablements(workspace_id, plugin_id, enabled)`，后续任务 CRUD 依赖

- [ ] **Step 1: 写失败测试**（照 migration-056-system-sender.test.ts 范式）

```ts
// electron/tests/storage/migration-057-plugin-registry.test.ts
// 057 迁移锁：两表结构 + 注册锁 + 幂等重放（范式同 migration-056-system-sender.test.ts）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDb, getDb } from '../../src/main/storage/db';
import { runMigrations } from '../../src/main/storage/db';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-mig057-'));

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
});
afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

describe('migration 057 plugin registry', () => {
  it('runMigrations 后两表存在且可写', () => {
    runMigrations();
    const db = getDb();
    db.prepare(
      `INSERT INTO plugins (id, version, manifest_json, state, source, installed_at)
       VALUES ('cg', '0.1.0', '{}', 'active', 'zip', '2026-10-15T00:00:00Z')`,
    ).run();
    db.prepare(
      `INSERT INTO plugin_enablements (workspace_id, plugin_id, enabled) VALUES ('ws1', 'cg', 0)`,
    ).run();
    const row = db
      .prepare(`SELECT plugin_id, enabled FROM plugin_enablements WHERE workspace_id = 'ws1'`)
      .get() as { plugin_id: string; enabled: number };
    expect(row).toEqual({ plugin_id: 'cg', enabled: 0 });
  });

  it('schema_migrations 注册锁：version 57 已登记', () => {
    runMigrations();
    const row = getDb()
      .prepare(`SELECT version FROM schema_migrations WHERE version = 57`)
      .get();
    expect(row).toBeTruthy();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/storage/migration-057-plugin-registry.test.ts`
Expected: FAIL（version 57 未注册 / 表不存在）

- [ ] **Step 3: 实现迁移模块 + 注册**

```ts
// electron/src/main/storage/migrations/057_plugin_registry.ts
// 插件系统 P1（spec 2026-10-15 §7.1）：机器级注册表 + workspace 级启停两表。
// 模块内带 down 供测试直调；迁移数组只接 .up（约定同 032-056）。
export interface Migration057 {
  version: number;
  up: string;
  down: string;
}

export const migration057: Migration057 = {
  version: 57,
  up: `
    -- 机器级插件注册表。source: 'zip'（安装目录不可变副本）| 'dev'（源目录直读不拷贝）。
    -- state: 'active' | 'missing'（dev 源目录消失时由读路径标降级，见 plugin/registry.ts）
    CREATE TABLE plugins (
      id            TEXT PRIMARY KEY NOT NULL,
      version       TEXT NOT NULL,
      manifest_json TEXT NOT NULL,
      state         TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'missing')),
      source        TEXT NOT NULL CHECK (source IN ('zip', 'dev')),
      source_path   TEXT,
      installed_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- workspace 级启停。行缺失 = 启用（默认开启语义，仅禁用/重启用落行）。
    CREATE TABLE plugin_enablements (
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      plugin_id    TEXT NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
      enabled      INTEGER NOT NULL CHECK (enabled IN (0, 1)),
      PRIMARY KEY (workspace_id, plugin_id)
    );
  `.trim(),
  down: `
    DROP TABLE IF EXISTS plugin_enablements;
    DROP TABLE IF EXISTS plugins;
  `.trim(),
};
```

`index.ts` 顶部加 `import { migration057 } from './057_plugin_registry';`，MIGRATIONS 数组末尾追加：

```ts
{
  // 插件系统 P1（spec 2026-10-15 §7.1）：plugins + plugin_enablements 两表。
  version: migration057.version,
  sql: migration057.up,
},
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/storage/migration-057-plugin-registry.test.ts`
Expected: PASS（2 个用例）

- [ ] **Step 5: 全量迁移测试回归**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/storage/`
Expected: PASS（无既有迁移测试回归）

- [ ] **Step 6: Commit**

```bash
git add electron/src/main/storage/migrations/057_plugin_registry.ts electron/src/main/storage/migrations/index.ts electron/tests/storage/migration-057-plugin-registry.test.ts
git commit -m "feat: 插件注册表迁移 057（plugins + plugin_enablements，spec §7.1）"
```

---

### Task 2: manifest 解析与校验模块（纯函数，无 DB）

**Files:**
- Create: `electron/src/main/plugin/types.ts`
- Create: `electron/src/main/plugin/manifest.ts`
- Test: `electron/tests/plugin/manifest.test.ts`

**Interfaces:**
- Consumes: `isValidSlug` / `isValidVersion`（`../marketplace/types`，现有）
- Produces:
  - `PluginManifest`（完整清单类型：id/name/version/description/author/minAppVersion/components/config/permissions）
  - `parseManifest(raw: string): PluginManifest`——JSON 解析 + 顶层形状，坏输入抛中文错
  - `validateManifest(manifest: PluginManifest, pluginRoot: string): void`——spec §2.4 校验 1-4 步，违规抛 `PluginManifestError`（`issues: Array<{ field: string; message: string }>`，message 聚合带字段路径）

- [ ] **Step 1: 写失败测试**

```ts
// electron/tests/plugin/manifest.test.ts
// manifest 校验管线（spec §2.4 步骤 1-4）纯函数锁：形状 / 白名单 / 路径安全 / 存在性
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseManifest, validateManifest, PluginManifestError } from '../../src/main/plugin/manifest';

function mkRoot(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-pkg-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return root;
}

const BASE = {
  id: 'codegraph',
  name: 'Codegraph',
  version: '0.1.0',
  description: '代码图谱',
  components: { tools: './tools' },
};

describe('parseManifest', () => {
  it('坏 JSON 抛中文错', () => {
    expect(() => parseManifest('{oops')).toThrow(/manifest 不是合法 JSON/);
  });
  it('缺必填字段抛错并列出字段', () => {
    expect(() => parseManifest(JSON.stringify({ id: 'x' }))).toThrow(/name/);
  });
});

describe('validateManifest', () => {
  it('合法 manifest 通过', () => {
    const root = mkRoot({ 'tools/cg.js': 'module.exports = {};' });
    expect(() => validateManifest(parseManifest(JSON.stringify(BASE)), root)).not.toThrow();
  });

  it('id 不在白名单抛 PluginManifestError 且 issue 带字段路径', () => {
    const root = mkRoot({ 'tools/cg.js': '' });
    const bad = { ...BASE, id: 'Bad Id!' };
    try {
      validateManifest(parseManifest(JSON.stringify(bad)), root);
      throw new Error('应当抛错');
    } catch (err) {
      expect(err).toBeInstanceOf(PluginManifestError);
      expect((err as PluginManifestError).issues[0].field).toBe('id');
    }
  });

  it('components 路径越界（../ 与绝对路径与反斜杠）逐一拒绝', () => {
    const root = mkRoot({ 'tools/cg.js': '' });
    for (const evil of ['../escape', '/etc/passwd', '.\\\\evil']) {
      const bad = { ...BASE, components: { tools: evil } };
      const issues = (() => {
        try {
          validateManifest(parseManifest(JSON.stringify(bad)), root);
          return [];
        } catch (err) {
          return err instanceof PluginManifestError ? err.issues : [];
        }
      })();
      expect(issues.some((i) => i.field.startsWith('components.tools'))).toBe(true);
    }
  });

  it('声明的组件目录不存在拒绝', () => {
    const root = mkRoot({});
    expect(() => validateManifest(parseManifest(JSON.stringify(BASE)), root)).toThrow(
      /components\.tools/,
    );
  });

  it('version 不在白名单拒绝', () => {
    const root = mkRoot({ 'tools/cg.js': '' });
    expect(() =>
      validateManifest(parseManifest(JSON.stringify({ ...BASE, version: 'a b' })), root),
    ).toThrow(PluginManifestError);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/plugin/manifest.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 types.ts + manifest.ts**

```ts
// electron/src/main/plugin/types.ts
// 插件域类型（spec 2026-10-15 §2）。跨 IPC 的结构保持纯数据（无方法）。

/** manifest.components——全部可选，声明根路径则扫描其内部，未声明不可见 */
export interface PluginManifestComponents {
  tools?: string;
  service?: string;
  skills?: string;
  agents?: string;
  mcp?: string;
  hooks?: string;
  panel?: string;
}

/** 权限声明（v1 只记录 + 设置页展示，不强制执行，spec §7.3） */
export interface PluginPermissionDecls {
  fs?: string[];
  network?: string[];
  subprocess?: boolean;
}

/** config 字段：JSON-Schema-lite 透传（type/properties/required），宿主按其渲染设置表单 */
export interface PluginConfigSchema {
  [key: string]: unknown;
}

/** momo-plugin.json 完整形状 */
export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  author?: { name: string };
  minAppVersion?: string;
  components: PluginManifestComponents;
  config?: PluginConfigSchema;
  permissions?: PluginPermissionDecls;
}

/** 注册表行（plugins 表 + 读路径派生态） */
export interface PluginRecord {
  id: string;
  version: string;
  manifestJson: string;
  state: 'active' | 'missing';
  source: 'zip' | 'dev';
  sourcePath: string | null;
  installedAt: string;
}
```

```ts
// electron/src/main/plugin/manifest.ts
// manifest 解析 + 校验管线（spec §2.4 步骤 1-4，全部拒绝式、fail loud）。
// 步骤 5（交叉引用：agents defaultSkills/defaultTools）在 P2 组件激活时补——
// P1 尚不解析 agent YAML 内容。
import fs from 'node:fs';
import path from 'node:path';
import { isValidSlug, isValidVersion } from '../marketplace/types';
import type { PluginManifest, PluginManifestComponents } from './types';

export interface ManifestIssue {
  field: string;
  message: string;
}

export class PluginManifestError extends Error {
  constructor(public readonly issues: ManifestIssue[]) {
    super(issues.map((i) => `${i.field}: ${i.message}`).join('\n'));
    this.name = 'PluginManifestError';
  }
}

/** 单个 component 声明路径的合法键（用于错误字段路径） */
const COMPONENT_KEYS: Array<keyof PluginManifestComponents> = [
  'tools', 'service', 'skills', 'agents', 'mcp', 'hooks', 'panel',
];

/** components 路径安全解析：必须 ./ 开头、无 .. 与反斜杠、resolve 后落在 root 内 */
export function resolveComponentPath(root: string, declared: string): string | null {
  if (!declared.startsWith('./')) return null;
  if (declared.includes('..') || declared.includes('\\')) return null;
  const abs = path.resolve(root, declared);
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  return abs;
}

/** JSON 解析 + 顶层必填形状（步骤 1） */
export function parseManifest(raw: string): PluginManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('manifest 不是合法 JSON');
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('manifest 顶层必须是对象');
  }
  const m = parsed as Record<string, unknown>;
  for (const key of ['id', 'name', 'version', 'description', 'components']) {
    if (m[key] === undefined) {
      throw new Error(`manifest 缺必填字段: ${key}`);
    }
  }
  return parsed as PluginManifest;
}

/** 校验步骤 2-4：白名单 / 路径安全 / 组件存在性。违规聚合抛 PluginManifestError */
export function validateManifest(manifest: PluginManifest, pluginRoot: string): void {
  const issues: ManifestIssue[] = [];

  if (!isValidSlug(manifest.id)) {
    issues.push({ field: 'id', message: `非法插件 id（白名单外字符）: ${manifest.id}` });
  }
  if (!isValidVersion(manifest.version)) {
    issues.push({ field: 'version', message: `非法版本号: ${manifest.version}` });
  }

  for (const key of COMPONENT_KEYS) {
    const declared = manifest.components[key];
    if (declared === undefined) continue;
    if (typeof declared !== 'string' || declared === '') {
      issues.push({ field: `components.${key}`, message: '必须是非空字符串路径' });
      continue;
    }
    const abs = resolveComponentPath(pluginRoot, declared);
    if (abs === null) {
      issues.push({
        field: `components.${key}`,
        message: `路径不合法（须 ./ 开头、不含 .. 与反斜杠、落在插件根内）: ${declared}`,
      });
      continue;
    }
    if (!fs.existsSync(abs)) {
      issues.push({ field: `components.${key}`, message: `声明的路径不存在: ${declared}` });
    }
  }

  if (issues.length > 0) throw new PluginManifestError(issues);
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/plugin/manifest.test.ts`
Expected: PASS（7 个用例）

- [ ] **Step 5: Commit**

```bash
git add electron/src/main/plugin/types.ts electron/src/main/plugin/manifest.ts electron/tests/plugin/manifest.test.ts
git commit -m "feat: 插件 manifest 解析与校验管线（白名单/路径安全/存在性，spec §2.4）"
```

---

### Task 3: 路径 helper + 注册表 CRUD + 启停解析

**Files:**
- Modify: `electron/src/main/paths.ts`（加 `resolvePluginsDir` / `resolvePluginInstalledDir` / `resolvePluginDataDir`）
- Create: `electron/src/main/plugin/registry.ts`
- Test: `electron/tests/plugin/registry.test.ts`

**Interfaces:**
- Consumes: `getDb()`（storage/db）、`PluginRecord`（Task 2）
- Produces:
  - `listPlugins(): PluginRecord[]`——dev 源做 missing 检测（sourcePath 目录消失 → state='missing'，并回写 DB）
  - `getPlugin(id: string): PluginRecord | null`
  - `upsertPlugin(rec: PluginRecord): void`
  - `removePluginRecord(id: string): void`
  - `isPluginEnabled(pluginId: string, workspaceId: string): boolean`——行缺失 = true
  - `setPluginEnabled(pluginId: string, workspaceId: string, enabled: boolean): void`
  - `resolvePluginsDir(): string` 等（paths.ts）

- [ ] **Step 1: 写失败测试**

```ts
// electron/tests/plugin/registry.test.ts
// 注册表 CRUD + 启停语义锁（行缺失 = 启用；dev 源 missing 检测）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDb } from '../../src/main/storage/db';
import { runMigrations } from '../../src/main/storage/db';
import {
  listPlugins, upsertPlugin, getPlugin, removePluginRecord,
  isPluginEnabled, setPluginEnabled,
} from '../../src/main/plugin/registry';
import type { PluginRecord } from '../../src/main/plugin/types';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-preg-'));

function mkRec(over: Partial<PluginRecord> = {}): PluginRecord {
  return {
    id: 'cg', version: '0.1.0', manifestJson: '{}', state: 'active',
    source: 'zip', sourcePath: null, installedAt: '2026-10-15T00:00:00Z',
    ...over,
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

describe('registry CRUD', () => {
  it('upsert 后可 get / list；重复 upsert 同 id 覆盖不重复', () => {
    upsertPlugin(mkRec());
    upsertPlugin(mkRec({ version: '0.2.0' }));
    expect(listPlugins()).toHaveLength(1);
    expect(getPlugin('cg')?.version).toBe('0.2.0');
  });

  it('removePluginRecord 删除行', () => {
    upsertPlugin(mkRec());
    removePluginRecord('cg');
    expect(getPlugin('cg')).toBeNull();
  });
});

describe('启停语义（spec §7.1：行缺失 = 启用）', () => {
  it('无行 → enabled true；置 0 → false；重启用 → true', () => {
    upsertPlugin(mkRec());
    expect(isPluginEnabled('cg', 'ws1')).toBe(true);
    setPluginEnabled('cg', 'ws1', false);
    expect(isPluginEnabled('cg', 'ws1')).toBe(false);
    expect(isPluginEnabled('cg', 'ws2')).toBe(true); // 其他 workspace 不受影响
    setPluginEnabled('cg', 'ws1', true);
    expect(isPluginEnabled('cg', 'ws1')).toBe(true);
  });
});

describe('dev 源 missing 检测', () => {
  it('sourcePath 目录消失 → listPlugins 标 missing', () => {
    const devDir = path.join(tmpRoot, 'my-plugin');
    fs.mkdirSync(devDir, { recursive: true });
    upsertPlugin(mkRec({ source: 'dev', sourcePath: devDir }));
    expect(listPlugins()[0].state).toBe('active');
    fs.rmSync(devDir, { recursive: true, force: true });
    expect(listPlugins()[0].state).toBe('missing');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/plugin/registry.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 paths.ts 增量 + registry.ts**

`paths.ts` 追加（对齐现有 `resolveSkillsDir` 模式：自动 mkdir + `AP_USER_DATA_DIR` 可注入）：

```ts
/** 插件子系统根目录 <userData>/plugins/（spec §7.1） */
export function resolvePluginsDir(): string {
  const dir = path.join(resolveUserDataDir(), 'plugins');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 不可变安装目录 <userData>/plugins/installed/<id>/<version>/（zip 源） */
export function resolvePluginInstalledDir(id: string, version: string): string {
  return path.join(resolvePluginsDir(), 'installed', id, version);
}

/** 跨更新持久数据目录 <userData>/plugins/data/<id>/（卸载时按 keepData 决定去留） */
export function resolvePluginDataDir(id: string): string {
  return path.join(resolvePluginsDir(), 'data', id);
}
```

```ts
// electron/src/main/plugin/registry.ts
// plugins / plugin_enablements 两表的读写门面（spec §7.1）。
// dev 源 missing 检测在读路径完成（目录消失标 missing 并回写，UI 可见降级态）。
import fs from 'node:fs';
import { getDb } from '../storage/db';
import type { PluginRecord } from './types';

interface PluginRow {
  id: string; version: string; manifest_json: string;
  state: string; source: string; source_path: string | null; installed_at: string;
}

function rowToRecord(row: PluginRow): PluginRecord {
  return {
    id: row.id, version: row.version, manifestJson: row.manifest_json,
    state: row.state as PluginRecord['state'],
    source: row.source as PluginRecord['source'],
    sourcePath: row.source_path, installedAt: row.installed_at,
  };
}

export function listPlugins(): PluginRecord[] {
  const rows = getDb().prepare(`SELECT * FROM plugins ORDER BY id`).all() as PluginRow[];
  const db = getDb();
  const out: PluginRecord[] = [];
  for (const row of rows) {
    const rec = rowToRecord(row);
    // dev 源目录消失 → missing（回写 DB，供 UI 徽标与 P2 装配跳过）
    if (rec.source === 'dev' && rec.sourcePath && !fs.existsSync(rec.sourcePath)) {
      if (rec.state !== 'missing') {
        db.prepare(`UPDATE plugins SET state = 'missing' WHERE id = ?`).run(rec.id);
        rec.state = 'missing';
      }
    }
    out.push(rec);
  }
  return out;
}

export function getPlugin(id: string): PluginRecord | null {
  const row = getDb().prepare(`SELECT * FROM plugins WHERE id = ?`).get(id) as PluginRow | undefined;
  return row ? rowToRecord(row) : null;
}

export function upsertPlugin(rec: PluginRecord): void {
  getDb()
    .prepare(
      `INSERT INTO plugins (id, version, manifest_json, state, source, source_path, installed_at)
       VALUES (@id, @version, @manifestJson, @state, @source, @sourcePath, @installedAt)
       ON CONFLICT(id) DO UPDATE SET
         version = excluded.version, manifest_json = excluded.manifest_json,
         state = excluded.state, source = excluded.source,
         source_path = excluded.source_path, installed_at = excluded.installed_at`,
    )
    .run(rec as unknown as Record<string, unknown>);
}

export function removePluginRecord(id: string): void {
  getDb().prepare(`DELETE FROM plugins WHERE id = ?`).run(id);
}

/** 行缺失 = 启用（默认开启语义，spec §7.1）；plugin_enablements FK 到 plugins，须先 upsert */
export function isPluginEnabled(pluginId: string, workspaceId: string): boolean {
  const row = getDb()
    .prepare(`SELECT enabled FROM plugin_enablements WHERE workspace_id = ? AND plugin_id = ?`)
    .get(workspaceId, pluginId) as { enabled: number } | undefined;
  return row?.enabled !== 0;
}

export function setPluginEnabled(pluginId: string, workspaceId: string, enabled: boolean): void {
  getDb()
    .prepare(
      `INSERT INTO plugin_enablements (workspace_id, plugin_id, enabled) VALUES (?, ?, ?)
       ON CONFLICT(workspace_id, plugin_id) DO UPDATE SET enabled = excluded.enabled`,
    )
    .run(workspaceId, pluginId, enabled ? 1 : 0);
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/plugin/registry.test.ts`
Expected: PASS（5 个用例）

- [ ] **Step 5: Commit**

```bash
git add electron/src/main/paths.ts electron/src/main/plugin/registry.ts electron/tests/plugin/registry.test.ts
git commit -m "feat: 插件注册表门面 + plugins 目录路径 helper（启停默认开启语义，spec §7.1）"
```

---

### Task 4: zip 安装器（含 zip bomb 守卫 + minAppVersion + 原子落位）

**Files:**
- Modify: `electron/src/main/skill/zip-uploader.ts`（仅导出 `isIgnoredEntry`，供复用）
- Create: `electron/src/main/plugin/installer.ts`
- Test: `electron/tests/plugin/installer.test.ts`

**Interfaces:**
- Consumes: `parseManifest` / `validateManifest`（Task 2）、`upsertPlugin`（Task 3）、`isIgnoredEntry`（zip-uploader 导出）、AdmZip、`resolvePluginsDir` / `resolvePluginInstalledDir`
- Produces:
  - `installPluginZip(data: Buffer, currentAppVersion: string): Promise<PluginRecord>`——校验→staging 解压→manifest 校验（对 staging 根）→minAppVersion→原子移入 installed→注册表落行
  - `uninstallPlugin(id: string, keepData: boolean): void`——删行 + 删 installed 目录（zip 源）/仅删行（dev 源保留用户目录）+ 按 keepData 删 data 目录
  - `compareVersionLoose(a: string, b: string): number`——数字三元组比较（prerelease 忽略），a<b 返回 -1

- [ ] **Step 1: 写失败测试**

```ts
// electron/tests/plugin/installer.test.ts
// zip 安装全链（真实 tmpdir + 真实 zip 构造，范式同 upload-zip.test.ts）：
// bomb 守卫 / entry 穿越 / manifest 拒绝 / minAppVersion / 幂等重装 / 卸载
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { closeDb } from '../../src/main/storage/db';
import { runMigrations } from '../../src/main/storage/db';
import { installPluginZip, uninstallPlugin, compareVersionLoose } from '../../src/main/plugin/installer';
import { getPlugin } from '../../src/main/plugin/registry';
import { resolvePluginInstalledDir, resolvePluginDataDir } from '../../src/main/paths';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-pinst-'));

function makePluginZip(files: Record<string, string>): Buffer {
  const zip = new AdmZip();
  for (const [rel, content] of Object.entries(files)) zip.addFile(rel, Buffer.from(content));
  return zip.toBuffer();
}

const VALID_FILES: Record<string, string> = {
  'momo-plugin.json': JSON.stringify({
    id: 'cg', name: 'Codegraph', version: '0.1.0', description: '图谱',
    components: { tools: './tools' },
  }),
  'tools/cg.js': 'module.exports.createTools = () => ({});',
};

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

describe('installPluginZip', () => {
  it('合法 zip 落位 installed/<id>/<version> 并注册', async () => {
    const rec = await installPluginZip(makePluginZip(VALID_FILES), '2.1.0');
    expect(rec.id).toBe('cg');
    const dir = resolvePluginInstalledDir('cg', '0.1.0');
    expect(fs.existsSync(path.join(dir, 'momo-plugin.json'))).toBe(true);
    expect(getPlugin('cg')?.version).toBe('0.1.0');
  });

  it('zip bomb：累计解压超上限拒装（200MB 上限，构造 3 个 80MB 假 entry 压缩后极小）', async () => {
    const zip = new AdmZip();
    zip.addFile('momo-plugin.json', Buffer.from(JSON.stringify({
      id: 'bomb', name: 'B', version: '0.1.0', description: '', components: {},
    })));
    const big = Buffer.alloc(80 * 1024 * 1024, 1); // 全 1 字节，DEFLATE 后极小
    zip.addFile('a.bin', big);
    zip.addFile('b.bin', big);
    zip.addFile('c.bin', big);
    await expect(installPluginZip(zip.toBuffer(), '2.1.0')).rejects.toThrow(/解压总量超限/);
  });

  it('entry 路径穿越（../）跳过，installed 无越界文件', async () => {
    const zip = new AdmZip();
    zip.addFile('momo-plugin.json', Buffer.from(JSON.stringify({
      id: 'evil', name: 'E', version: '0.1.0', description: '', components: {},
    })));
    zip.addFile('../escape.txt', Buffer.from('x'));
    await installPluginZip(zip.toBuffer(), '2.1.0');
    expect(fs.existsSync(path.join(tmpRoot, 'escape.txt'))).toBe(false);
    const dir = resolvePluginInstalledDir('evil', '0.1.0');
    expect(fs.readdirSync(dir)).toContain('momo-plugin.json');
    expect(fs.readdirSync(dir)).not.toContain('escape.txt');
  });

  it('manifest 校验失败拒装且不留 staging 残留', async () => {
    const bad = { ...VALID_FILES, 'momo-plugin.json': JSON.stringify({ id: 'X!', name: 'x', version: '0.1.0', description: '', components: {} }) };
    await expect(installPluginZip(makePluginZip(bad), '2.1.0')).rejects.toThrow(/id/);
    expect(fs.readdirSync(path.join(tmpRoot, 'plugins')).filter((f) => f.startsWith('.staging'))).toHaveLength(0);
  });

  it('minAppVersion 高于当前版本拒装（中文消息）', async () => {
    const newer = { ...VALID_FILES, 'momo-plugin.json': JSON.stringify({
      id: 'cg', name: 'C', version: '0.1.0', description: '',
      components: { tools: './tools' }, minAppVersion: '2.2.0',
    }) };
    await expect(installPluginZip(makePluginZip(newer), '2.1.0')).rejects.toThrow(/需要应用版本.*2\.2\.0/);
  });

  it('同 id 新版本重装 = 替换（单版本驻留，旧目录消失）', async () => {
    await installPluginZip(makePluginZip(VALID_FILES), '2.1.0');
    const v2 = { ...VALID_FILES, 'momo-plugin.json': JSON.stringify({
      id: 'cg', name: 'Codegraph', version: '0.2.0', description: '图谱',
      components: { tools: './tools' },
    }) };
    await installPluginZip(makePluginZip(v2), '2.1.0');
    expect(fs.existsSync(resolvePluginInstalledDir('cg', '0.1.0'))).toBe(false);
    expect(fs.existsSync(resolvePluginInstalledDir('cg', '0.2.0'))).toBe(true);
  });
});

describe('uninstallPlugin', () => {
  it('zip 源卸载删行删目录；keepData=false 删 data', async () => {
    await installPluginZip(makePluginZip(VALID_FILES), '2.1.0');
    const dataDir = resolvePluginDataDir('cg');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'state.json'), '{}');
    uninstallPlugin('cg', false);
    expect(getPlugin('cg')).toBeNull();
    expect(fs.existsSync(resolvePluginInstalledDir('cg', '0.1.0'))).toBe(false);
    expect(fs.existsSync(dataDir)).toBe(false);
  });

  it('keepData=true 保留 data 目录', async () => {
    await installPluginZip(makePluginZip(VALID_FILES), '2.1.0');
    const dataDir = resolvePluginDataDir('cg');
    fs.mkdirSync(dataDir, { recursive: true });
    uninstallPlugin('cg', true);
    expect(fs.existsSync(dataDir)).toBe(true);
  });
});

describe('compareVersionLoose', () => {
  it('数字三元组比较，prerelease 忽略', () => {
    expect(compareVersionLoose('2.1.0-alpha.5', '2.1.0')).toBe(0);
    expect(compareVersionLoose('2.1.0', '2.2.0')).toBe(-1);
    expect(compareVersionLoose('2.10.0', '2.9.0')).toBe(1);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/plugin/installer.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

`zip-uploader.ts` 改一行——`function isIgnoredEntry` 改为 `export function isIgnoredEntry`（注释注明：插件安装器复用，语义同 skill 链）。

```ts
// electron/src/main/plugin/installer.ts
// zip 安装 / 卸载链（spec §7.2）。复用 skill zip 链骨架（AdmZip + isIgnoredEntry +
// 三层路径防御），新增：zip bomb 守卫 / manifest 校验 / minAppVersion / 原子落位。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import AdmZip from 'adm-zip';
import { isIgnoredEntry } from '../skill/zip-uploader';
import { resolvePluginsDir, resolvePluginInstalledDir, resolvePluginDataDir } from '../paths';
import { parseManifest, validateManifest } from './manifest';
import { upsertPlugin, getPlugin, removePluginRecord } from './registry';
import type { PluginRecord } from './types';

/** zip bomb 守卫：累计解压上限 200MB（现有 skill 链无此守卫，插件链新增，spec Review Focus #1） */
const MAX_TOTAL_UNCOMPRESSED = 200 * 1024 * 1024;
/** entry 数量上限 */
const MAX_ENTRIES = 5000;
/** manifest entry 在 zip 内的查找深度上限（根 或 单层包裹目录） */
const MANIFEST_NAME = 'momo-plugin.json';

/** 宽松版本比较：数字三元组，prerelease 忽略。a<b → -1，a>b → 1，相等 → 0 */
export function compareVersionLoose(a: string, b: string): number {
  const pa = (a.match(/\d+/g) ?? []).map(Number);
  const pb = (b.match(/\d+/g) ?? []).map(Number);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
}

/**
 * zip 安装：staging 解压 → manifest 校验（对 staging 根）→ minAppVersion →
 * 原子移入 installed/<id>/<version>/ → 注册表落行。失败清 staging 不留残留。
 */
export async function installPluginZip(data: Buffer, currentAppVersion: string): Promise<PluginRecord> {
  const zip = new AdmZip(data);
  const entries = zip.getEntries().filter((e) => !e.isDirectory && !isIgnoredEntry(e.entryName));
  if (entries.length > MAX_ENTRIES) throw new Error(`zip 条目数超限（>${MAX_ENTRIES}）`);

  let total = 0;
  for (const e of entries) total += e.header.size;
  if (total > MAX_TOTAL_UNCOMPRESSED) throw new Error(`解压总量超限（${total} > ${MAX_TOTAL_UNCOMPRESSED} 字节）`);

  // manifest 定位：根 或 单层包裹目录（macOS「压缩文件夹」产物）
  const manifestEntry =
    entries.find((e) => e.entryName === MANIFEST_NAME) ??
    entries.find((e) => /^[^/]+\/momo-plugin\.json$/.test(e.entryName));
  if (!manifestEntry) throw new Error('zip 内未找到 momo-plugin.json（根目录或单层包裹目录）');
  const prefix = manifestEntry.entryName === MANIFEST_NAME
    ? ''
    : manifestEntry.entryName.slice(0, -MANIFEST_NAME.length);

  const manifest = parseManifest(manifestEntry.getData().toString('utf-8'));

  // minAppVersion 硬校验（spec §2.3）
  if (manifest.minAppVersion && compareVersionLoose(currentAppVersion, manifest.minAppVersion) < 0) {
    throw new Error(`插件需要应用版本 ≥ ${manifest.minAppVersion}，当前 ${currentAppVersion}`);
  }

  const staging = path.join(resolvePluginsDir(), `.staging-${manifest.id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const target = resolvePluginInstalledDir(manifest.id, manifest.version);
  try {
    fs.mkdirSync(staging, { recursive: true });
    for (const e of entries) {
      let rel = e.entryName;
      if (prefix && rel.startsWith(prefix)) rel = rel.slice(prefix.length);
      // 三层路径防御（同 skill 链）：entryName 含 .. 跳过；resolve 后必须在 staging 内
      if (rel.split('/').includes('..') || rel.startsWith('/') || path.isAbsolute(rel)) continue;
      const abs = path.resolve(staging, rel);
      if (abs !== staging && !abs.startsWith(staging + path.sep)) continue;
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, e.getData());
    }
    validateManifest(manifest, staging);

    // 原子落位：先移走旧版（若同路径），再 rename staging → target
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
    fs.renameSync(staging, target);

    const rec: PluginRecord = {
      id: manifest.id, version: manifest.version,
      manifestJson: JSON.stringify(manifest), state: 'active',
      source: 'zip', sourcePath: null, installed_at: new Date().toISOString(),
    };
    upsertPlugin(rec);
    // 同 id 旧版本目录清理（单版本驻留，spec §7.1）
    const versionRoot = path.dirname(target);
    for (const dir of fs.readdirSync(versionRoot)) {
      if (dir !== manifest.version) fs.rmSync(path.join(versionRoot, dir), { recursive: true, force: true });
    }
    return rec;
  } catch (err) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw err;
  }
}

/** 卸载：删注册行 + 删 installed 目录（zip 源；dev 源保留用户源目录）+ 按 keepData 决定 data 去留 */
export function uninstallPlugin(id: string, keepData: boolean): void {
  const rec = getPlugin(id);
  if (!rec) throw new Error(`插件不存在: ${id}`);
  removePluginRecord(id);
  if (rec.source === 'zip') {
    const idRoot = path.join(resolvePluginsDir(), 'installed', id);
    fs.rmSync(idRoot, { recursive: true, force: true });
  }
  if (!keepData) {
    fs.rmSync(resolvePluginDataDir(id), { recursive: true, force: true });
  }
}
```

（`installed_at` 字段名注意：`PluginRecord` 用 `installedAt`，DB 列 `installed_at`——upsert 参数对象走 `@installedAt` 命名参数与 SQL `@installed_at` 不一致。**修正**：Task 3 的 upsert SQL 命名参数统一用 `@installedAt` 对齐对象属性（better-sqlite3 命名参数匹配对象 key，SQL 里写 `@installedAt` 即可）。执行时以测试为准修正两处任一侧。）

- [ ] **Step 4: 跑测试确认通过**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/plugin/installer.test.ts`
Expected: PASS（9 个用例）

- [ ] **Step 5: Commit**

```bash
git add electron/src/main/skill/zip-uploader.ts electron/src/main/plugin/installer.ts electron/tests/plugin/installer.test.ts
git commit -m "feat: 插件 zip 安装器（bomb 守卫/manifest 校验/minAppVersion/原子落位/卸载，spec §7.2）"
```

---

### Task 5: dev 目录注册

**Files:**
- Modify: `electron/src/main/plugin/installer.ts`（追加 `installPluginDevDir`）
- Test: `electron/tests/plugin/install-dev-dir.test.ts`

**Interfaces:**
- Consumes: `parseManifest` / `validateManifest`（Task 2）、`upsertPlugin`（Task 3）
- Produces: `installPluginDevDir(dir: string, currentAppVersion: string): PluginRecord`——绝对化 + 目录存在 + manifest 校验（对源目录）+ minAppVersion + 落行（source='dev', sourcePath=绝对路径，不拷贝）

- [ ] **Step 1: 写失败测试**

```ts
// electron/tests/plugin/install-dev-dir.test.ts
// dev 目录注册（spec §7.2）：不拷贝 / 直读源目录 / 校验链与 zip 一致
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDb } from '../../src/main/storage/db';
import { runMigrations } from '../../src/main/storage/db';
import { installPluginDevDir } from '../../src/main/plugin/installer';
import { getPlugin } from '../../src/main/plugin/registry';
import { resolvePluginsDir } from '../../src/main/paths';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-pdev-'));

function mkDevPlugin(dir: string, id = 'cg'): void {
  fs.mkdirSync(path.join(dir, 'tools'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'momo-plugin.json'), JSON.stringify({
    id, name: 'Codegraph', version: '0.1.0', description: '图谱',
    components: { tools: './tools' },
  }));
  fs.writeFileSync(path.join(dir, 'tools', 'cg.js'), 'module.exports.createTools = () => ({});');
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

describe('installPluginDevDir', () => {
  it('注册 dev 源：不拷贝、直读源目录、重复注册刷新版本', () => {
    const devDir = path.join(tmpRoot, 'codegraph-plugin');
    mkDevPlugin(devDir);
    const rec = installPluginDevDir(devDir, '2.1.0');
    expect(rec.source).toBe('dev');
    expect(rec.sourcePath).toBe(path.resolve(devDir));
    expect(getPlugin('cg')?.version).toBe('0.1.0');
    // 不拷贝：installed 下无该插件目录
    expect(fs.existsSync(path.join(resolvePluginsDir(), 'installed', 'cg'))).toBe(false);
    // 源目录改版本后重注册 → 行版本刷新
    fs.writeFileSync(path.join(devDir, 'momo-plugin.json'), JSON.stringify({
      id: 'cg', name: 'Codegraph', version: '0.2.0', description: '图谱',
      components: { tools: './tools' },
    }));
    installPluginDevDir(devDir, '2.1.0');
    expect(getPlugin('cg')?.version).toBe('0.2.0');
  });

  it('目录不存在抛中文错', () => {
    expect(() => installPluginDevDir(path.join(tmpRoot, 'nope'), '2.1.0')).toThrow(/不存在/);
  });

  it('manifest 校验失败抛 PluginManifestError', () => {
    const devDir = path.join(tmpRoot, 'bad-plugin');
    fs.mkdirSync(path.join(devDir, 'tools'), { recursive: true });
    fs.writeFileSync(path.join(devDir, 'momo-plugin.json'), JSON.stringify({
      id: 'BAD', name: 'x', version: '0.1.0', description: '', components: { tools: './tools' },
    }));
    expect(() => installPluginDevDir(devDir, '2.1.0')).toThrow(/id/);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/plugin/install-dev-dir.test.ts`
Expected: FAIL（函数不存在）

- [ ] **Step 3: installer.ts 追加实现**

```ts
/** dev 目录注册：不拷贝，直读源目录（改码→重载即生效的开发流，spec §7.2） */
export function installPluginDevDir(dir: string, currentAppVersion: string): PluginRecord {
  const abs = path.resolve(dir);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
    throw new Error(`dev 插件目录不存在: ${abs}`);
  }
  const manifestPath = path.join(abs, MANIFEST_NAME);
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`目录内未找到 momo-plugin.json: ${manifestPath}`);
  }
  const manifest = parseManifest(fs.readFileSync(manifestPath, 'utf-8'));
  if (manifest.minAppVersion && compareVersionLoose(currentAppVersion, manifest.minAppVersion) < 0) {
    throw new Error(`插件需要应用版本 ≥ ${manifest.minAppVersion}，当前 ${currentAppVersion}`);
  }
  validateManifest(manifest, abs);
  const rec: PluginRecord = {
    id: manifest.id, version: manifest.version,
    manifestJson: JSON.stringify(manifest), state: 'active',
    source: 'dev', sourcePath: abs, installed_at: new Date().toISOString(),
  };
  upsertPlugin(rec);
  return rec;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/plugin/install-dev-dir.test.ts`
Expected: PASS（3 个用例）

- [ ] **Step 5: Commit**

```bash
git add electron/src/main/plugin/installer.ts electron/tests/plugin/install-dev-dir.test.ts
git commit -m "feat: 插件 dev 目录注册（直读源目录不拷贝，spec §7.2）"
```

---

### Task 6: 资源库集成（ResourceItem plugin 行 + ResourceType 双处扩展）

**Files:**
- Modify: `electron/src/main/resource/types.ts`（ResourceType 加 'plugin'；ResourceItem 加 plugin namespace；`parseResourceId` 正则加 plugin）
- Create: `electron/src/main/plugin/resources.ts`（listPluginResourceRows）
- Modify: `electron/src/main/resource/library.ts`（listResources 聚合接入 plugin 行——按现有 listBuiltinResources/listCustomResources 聚合点）
- Test: `electron/tests/plugin/resources.test.ts`

**Interfaces:**
- Consumes: `listPlugins`（Task 3）
- Produces:
  - `listPluginResourceRows(workspaceId?: string): ResourceItem[]`——plugins 行 → ResourceItem（type='plugin', source='custom'，`plugin` namespace：{ state, devSource, sourcePath, components, enabled }）
  - `ResourceItem.plugin?: { state: 'active' | 'missing'; devSource: boolean; sourcePath: string | null; components: string[]; enabled: boolean }`
  - `ResourceType` 含 `'plugin'`（electron + renderer 双处，renderer 侧在 Task 8）

- [ ] **Step 1: 写失败测试**

```ts
// electron/tests/plugin/resources.test.ts
// 插件行 → ResourceItem 映射 + 启停入行 + missing 降级态透出
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDb } from '../../src/main/storage/db';
import { runMigrations } from '../../src/main/storage/db';
import { upsertPlugin, setPluginEnabled } from '../../src/main/plugin/registry';
import { listPluginResourceRows } from '../../src/main/plugin/resources';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-pres-'));

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

describe('listPluginResourceRows', () => {
  it('映射 ResourceItem：type=plugin / source=custom / id 三段式 / components 列表', () => {
    upsertPlugin({
      id: 'cg', version: '0.1.0',
      manifestJson: JSON.stringify({
        id: 'cg', name: 'Codegraph', version: '0.1.0', description: '图谱',
        components: { tools: './tools', panel: './panel' },
      }),
      state: 'active', source: 'zip', sourcePath: null, installedAt: '2026-10-15T00:00:00Z',
    });
    const rows = listPluginResourceRows('ws1');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 'custom-plugin-cg', type: 'plugin', source: 'custom', slug: 'cg',
      name: 'Codegraph', installed: true, removable: true,
    });
    expect(rows[0].plugin).toMatchObject({ state: 'active', devSource: false, components: ['tools', 'panel'], enabled: true });
  });

  it('workspaceId 传入时 enabled 反映启停', () => {
    upsertPlugin({
      id: 'cg', version: '0.1.0', manifestJson: '{}',
      state: 'active', source: 'zip', sourcePath: null, installedAt: 'x',
    });
    setPluginEnabled('cg', 'ws1', false);
    expect(listPluginResourceRows('ws1')[0].plugin?.enabled).toBe(false);
    expect(listPluginResourceRows('ws2')[0].plugin?.enabled).toBe(true);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/plugin/resources.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

`resource/types.ts` 三处增量：

```ts
// ResourceType 联合类型加一项：
export type ResourceType = 'agent' | 'mcp' | 'skill' | 'plugin';

// ResourceItem 追加 namespace（放 p2p 之后）：
/** plugin 项的扩展元数据（P1：注册与展示；组件激活在 P2，spec §10） */
plugin?: {
  state: 'active' | 'missing';
  devSource: boolean;
  sourcePath: string | null;
  /** manifest.components 声明的组件键列表（UI 详情展示） */
  components: string[];
  /** 当前 workspace 启停态（行缺失 = 启用） */
  enabled: boolean;
};

// parseResourceId 正则同步（否则 plugin id 反解返回 null）：
const m = id.match(/^(builtin|marketplace|custom|p2p|smithery)-(agent|mcp|skill|plugin)-(.+)$/);
```

```ts
// electron/src/main/plugin/resources.ts
// 插件注册表行 → ResourceItem 映射（资源库第四类型页数据源，spec §8.1）
import { buildResourceId, type ResourceItem } from '../resource/types';
import { listPlugins, isPluginEnabled } from './registry';
import type { PluginManifest } from './types';

export function listPluginResourceRows(workspaceId?: string): ResourceItem[] {
  return listPlugins().map((rec) => {
    let manifest: PluginManifest;
    try {
      manifest = JSON.parse(rec.manifestJson) as PluginManifest;
    } catch {
      manifest = { id: rec.id, name: rec.id, version: rec.version, description: '', components: {} };
    }
    return {
      id: buildResourceId('custom', 'plugin', rec.id),
      type: 'plugin' as const,
      source: 'custom' as const,
      slug: rec.id,
      name: manifest.name,
      description: manifest.description,
      version: rec.version,
      installed: true,
      installable: false,
      removable: true,
      plugin: {
        state: rec.state,
        devSource: rec.source === 'dev',
        sourcePath: rec.sourcePath,
        components: Object.keys(manifest.components ?? {}),
        enabled: workspaceId ? isPluginEnabled(rec.id, workspaceId) : true,
      },
    };
  });
}
```

`resource/library.ts` 的 `listResources(filter)` 聚合处接入（找到现有 builtin/custom 市场聚合函数，按同构方式追加）：

```ts
// filter.type 为 'plugin' 或 undefined 时追加插件行（workspaceId 从现有调用链传入——
// 若 listResources 现签名无 workspaceId，则按现有 custom 行的取法对齐，缺省不带启停态）
if (!filter.type || filter.type === 'plugin') {
  rows.push(...listPluginResourceRows(workspaceId));
}
```

（执行注：`library.ts` 的实际签名与聚合点以现场代码为准——test 只锁 `listPluginResourceRows` 行形状；library 接入后补一条「filter.type='plugin' 只返回插件行」的集成断言进本测试文件。）

- [ ] **Step 4: 跑测试确认通过**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/plugin/resources.test.ts`
Expected: PASS（2-3 个用例）

- [ ] **Step 5: 既有 resource 测试回归**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/resource/`
Expected: PASS（ResourceType 扩展不破坏现有三类型行为；若 `parseResourceId` 有用例锁旧正则需同步断言扩展）

- [ ] **Step 6: Commit**

```bash
git add electron/src/main/resource/types.ts electron/src/main/resource/library.ts electron/src/main/plugin/resources.ts electron/tests/plugin/resources.test.ts
git commit -m "feat: 资源库接入插件行（ResourceType 扩展 + plugin namespace，spec §8.1）"
```

---

### Task 7: plugin:* IPC handlers + 主进程接线

**Files:**
- Create: `electron/src/main/plugin/ipc.handlers.ts`
- Modify: `electron/src/main/ipc/index.ts`（import + 调用 `registerPluginHandlers()`）
- Test: `electron/tests/plugin/ipc-handlers.test.ts`

**Interfaces:**
- Consumes: `installPluginZip` / `installPluginDevDir` / `uninstallPlugin`（Task 4/5）、`setPluginEnabled`（Task 3）、当前应用版本（`app.getVersion()`，测试注入）
- Produces（通道契约，renderer 侧 Task 8 对齐）:
  - `plugin:installZip(data: Uint8Array, filename: string): Promise<PluginSummary>`
  - `plugin:installDevDir(dir: string): Promise<PluginSummary>`
  - `plugin:setEnabled(id: string, workspaceId: string, enabled: boolean): Promise<void>`
  - `plugin:uninstall(id: string, keepData: boolean): Promise<void>`
  - `PluginSummary = { id, name, version, description, state, source, components: string[] }`

- [ ] **Step 1: 写失败测试**（vi.mock electron 范式，照 ipc-handlers.test.ts:31-53）

```ts
// electron/tests/plugin/ipc-handlers.test.ts
// IPC 边界锁：通道注册 / 参数透传 / Uint8Array→Buffer / 中文异常（真实安装链由
// installer.test.ts 覆盖，本文件 mock 安装函数只锁调用形状——仓库既有分工惯例）
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { appGetVersion } = vi.hoisted(() => ({ appGetVersion: vi.fn() }));
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  app: { getVersion: appGetVersion },
}));

const installFns = vi.hoisted(() => ({
  installZip: vi.fn(),
  installDev: vi.fn(),
  uninstall: vi.fn(),
}));
vi.mock('../../src/main/plugin/installer', () => installFns);
vi.mock('../../src/main/plugin/registry', () => ({
  setPluginEnabled: vi.fn(),
}));

import { ipcMain } from 'electron';
import { registerPluginHandlers } from '../../src/main/plugin/ipc.handlers';

function handlerOf(channel: string): (...args: unknown[]) => unknown {
  const call = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls.find(
    (c: unknown[]) => c[0] === channel,
  );
  return call![1] as (...args: unknown[]) => unknown;
}

describe('registerPluginHandlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    appGetVersion.mockReturnValue('2.1.0');
    registerPluginHandlers();
  });

  it('注册 4 个 plugin 通道', () => {
    const channels = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[0]);
    expect(channels).toEqual(expect.arrayContaining([
      'plugin:installZip', 'plugin:installDevDir', 'plugin:setEnabled', 'plugin:uninstall',
    ]));
  });

  it('installZip：Uint8Array 转 Buffer 后透传 + 传当前版本', async () => {
    installFns.installZip.mockResolvedValueOnce({ id: 'cg' });
    const arr = new Uint8Array([1, 2, 3]);
    await handlerOf('plugin:installZip')({}, arr, 'cg.zip');
    const [buf, version] = installFns.installZip.mock.calls[0];
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(version).toBe('2.1.0');
  });

  it('installZip 安装函数抛错 → handler reject（中文透传）', async () => {
    installFns.installZip.mockRejectedValueOnce(new Error('解压总量超限'));
    await expect(handlerOf('plugin:installZip')({}, new Uint8Array(), 'x.zip')).rejects.toThrow(/解压总量超限/);
  });

  it('setEnabled 三参透传', async () => {
    await handlerOf('plugin:setEnabled')({}, 'cg', 'ws1', false);
    const { setPluginEnabled } = await import('../../src/main/plugin/registry');
    expect(setPluginEnabled).toHaveBeenCalledWith('cg', 'ws1', false);
  });

  it('uninstall 两参透传', async () => {
    await handlerOf('plugin:uninstall')({}, 'cg', true);
    expect(installFns.uninstall).toHaveBeenCalledWith('cg', true);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/plugin/ipc-handlers.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 + 接线**

```ts
// electron/src/main/plugin/ipc.handlers.ts
// plugin:* IPC 通道（spec §2/§7）。错误约定：直接 throw 中文 Error，renderer 剥前缀后
// 原文展示（同 resource:* 惯例）。二进制传输：renderer 传 Uint8Array，此处归一 Buffer。
import { ipcMain, app } from 'electron';
import { installPluginZip, installPluginDevDir, uninstallPlugin } from './installer';
import { setPluginEnabled } from './registry';
import type { PluginRecord } from './types';
import type { PluginManifest } from './types';

/** 安装结果摘要（renderer 展示用；跨 IPC 纯数据） */
export interface PluginSummary {
  id: string;
  name: string;
  version: string;
  description: string;
  state: 'active' | 'missing';
  source: 'zip' | 'dev';
  components: string[];
}

function toSummary(rec: PluginRecord): PluginSummary {
  let manifest: PluginManifest;
  try {
    manifest = JSON.parse(rec.manifestJson) as PluginManifest;
  } catch {
    manifest = { id: rec.id, name: rec.id, version: rec.version, description: '', components: {} };
  }
  return {
    id: rec.id, name: manifest.name, version: rec.version,
    description: manifest.description, state: rec.state, source: rec.source,
    components: Object.keys(manifest.components ?? {}),
  };
}

/** 注册 plugin:* 通道。app ready 后由 registerIpcHandlers（ipc/index.ts）统一调用。 */
export function registerPluginHandlers(): void {
  ipcMain.handle('plugin:installZip', async (_evt, data: Uint8Array, _filename: string) => {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    return toSummary(await installPluginZip(buf, app.getVersion()));
  });

  ipcMain.handle('plugin:installDevDir', (_evt, dir: string) => {
    return toSummary(installPluginDevDir(dir, app.getVersion()));
  });

  ipcMain.handle('plugin:setEnabled', (_evt, id: string, workspaceId: string, enabled: boolean) => {
    setPluginEnabled(id, workspaceId, enabled);
  });

  ipcMain.handle('plugin:uninstall', (_evt, id: string, keepData: boolean) => {
    uninstallPlugin(id, keepData);
  });
}
```

`ipc/index.ts`：顶部 `import { registerPluginHandlers } from '../plugin/ipc.handlers';`，在 `registerResourceHandlers();` 之后追加一行 `registerPluginHandlers();`。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/plugin/ipc-handlers.test.ts`
Expected: PASS（5 个用例）

- [ ] **Step 5: Commit**

```bash
git add electron/src/main/plugin/ipc.handlers.ts electron/src/main/ipc/index.ts electron/tests/plugin/ipc-handlers.test.ts
git commit -m "feat: plugin:* IPC 四通道（installZip/installDevDir/setEnabled/uninstall）"
```

---

### Task 8: renderer IPC 契约（types.d.ts + preload）

**Files:**
- Modify: `renderer/src/ipc/types.d.ts`（ResourceType 加 'plugin'、ResourceItem 加 plugin namespace、PluginSummary 类型、ApiSurface 加 plugin 四方法）
- Modify: `electron/src/preload/index.ts`（import 类型 + plugin 命名空间暴露）

**Interfaces:**
- Consumes: Task 7 的通道契约
- Produces: renderer 可调 `ipc.plugin.installZip(buffer, filename)` / `ipc.plugin.installDevDir(dir)` / `ipc.plugin.setEnabled(id, workspaceId, enabled)` / `ipc.plugin.uninstall(id, keepData)`（client.ts 是通用 Proxy，无需改动）

- [ ] **Step 1: types.d.ts 增量**

在 `ResourceType` 定义处（:860 附近）扩为 `'agent' | 'mcp' | 'skill' | 'plugin'`；在 renderer 侧 `ResourceItem`（:922 附近）追加与 electron 侧同构的 `plugin` namespace（renderer 独立定义、仅结构对齐——仓库惯例）；新增：

```ts
/**
 * 插件安装结果摘要（plugin:installZip / installDevDir 返回形状）。
 * 与 electron 端 plugin/ipc.handlers.ts 的 PluginSummary 结构对齐（renderer 独立定义）。
 */
export interface PluginSummary {
  id: string;
  name: string;
  version: string;
  description: string;
  state: 'active' | 'missing';
  source: 'zip' | 'dev';
  components: string[];
}

/** 插件域 IPC 面（P1：安装 / 启停 / 卸载；重载动作 P2 工具激活时引入） */
export interface PluginApiSurface {
  installZip(data: Uint8Array, filename: string): Promise<PluginSummary>;
  installDevDir(dir: string): Promise<PluginSummary>;
  setEnabled(id: string, workspaceId: string, enabled: boolean): Promise<void>;
  uninstall(id: string, keepData: boolean): Promise<void>;
}
```

`ApiSurface` 接口追加 `plugin: PluginApiSurface;`。

- [ ] **Step 2: preload 增量**

`electron/src/preload/index.ts`：类型 import 列表加 `PluginSummary, PluginApiSurface`，`const api: ApiSurface = {` 内追加（紧随 `resource: {...}` 命名空间之后）：

```ts
plugin: {
  installZip: (data: Uint8Array, filename: string) =>
    invoke<PluginSummary>('plugin:installZip', data, filename),
  installDevDir: (dir: string) => invoke<PluginSummary>('plugin:installDevDir', dir),
  setEnabled: (id: string, workspaceId: string, enabled: boolean) =>
    invoke<void>('plugin:setEnabled', id, workspaceId, enabled),
  uninstall: (id: string, keepData: boolean) => invoke<void>('plugin:uninstall', id, keepData),
},
```

- [ ] **Step 3: 双 workspace typecheck**

Run: `npx pnpm@9.0.0 typecheck`
Expected: 双 workspace 0 错误（momo-boundary-rules：契约两端同改同检）

- [ ] **Step 4: Commit**

```bash
git add renderer/src/ipc/types.d.ts electron/src/preload/index.ts
git commit -m "feat: renderer 插件 IPC 契约（types.d.ts + preload plugin 命名空间）"
```

---

### Task 9: 资源库插件页 UI（预览门禁 → 实现）

**Files:**
- Modify: `renderer/src/components/resource-library/TypeSidebar.tsx`（TYPES 加 plugin 项，lucide `Puzzle`）
- Modify: `renderer/src/components/resource-library/TypePageShell.tsx`（EMPTY_COPY / ADD_LABEL 补 plugin；`onTogglePlugin?: (item: ResourceItem, next: boolean) => void` prop）
- Modify: `renderer/src/components/resource-library/ResourceLibraryView.tsx`（addItemsFor plugin 分支 + 两弹窗开关 + store 接线）
- Modify: `renderer/src/stores/resource.store.ts`（持久化白名单扩 plugin + `setPluginEnabled` action）
- Modify: `renderer/src/components/resource-library/ResourceRow.tsx`（TYPE_ICON 加 plugin）
- Modify: `renderer/src/components/resource-library/ResourceDetail.tsx`（plugin 分支：组件清单 + dev 路径 + 状态徽标 + 卸载按钮）
- Create: `renderer/src/components/resource-library/InstallPluginZipDialog.tsx`（+ colocated test）
- Create: `renderer/src/components/resource-library/RegisterPluginDirDialog.tsx`（+ colocated test）

**Interfaces:**
- Consumes: `ipc.plugin.*`（Task 8）、`ResourceItem.plugin` namespace（Task 6/8）、workspace id 来源对齐 resource.store 现有取法
- Produces: 资源库第四页「插件」——zip 安装弹窗 / dev 目录注册弹窗 / 行内启停开关 / 详情卸载（keepData 问询）

- [ ] **Step 1: 静态预览门禁（momo-ui-preview-rules P1 变更）**

按 skill 流程向用户呈现静态预览（第四页入口位置 / 两弹窗线框 / 详情面板 plugin 分支布局），**获确认后再实现**。预览产出物与确认记录留 `.omo/`。

- [ ] **Step 2: 写失败测试（先锁行为再写组件）**

`InstallPluginZipDialog.test.tsx`（colocated，照 ImportAgentYamlDialog.test.tsx 模式）：选 zip → 调 `ipc.plugin.installZip` → 成功文案含插件名 / 失败红字不关弹窗 / 导入中锁关。`RegisterPluginDirDialog.test.tsx`：路径输入 → `installDevDir` → 同款三态。`TypePageShell.test.tsx` 更新：type='plugin' 渲染插件空态文案与启停开关调用。

- [ ] **Step 3: 实现全部 UI 增量**

要点（组件代码按预览确认稿实现，遵循语义 token + lucide 16px/1.75）：

```ts
// TypeSidebar TYPES 追加：
{ key: 'plugin', label: '插件' },

// TypePageShell 两个 Record 补齐（否则 TS 报错——缺 key 的 Record<ResourceType, string>）：
EMPTY_COPY.plugin = '还没有安装插件。插件把工具、技能、Agent、面板打包成一体的扩展。';
ADD_LABEL.plugin = '安装插件';

// resource.store 持久化白名单（:198-199）扩为含 'plugin'；
// setPluginEnabled action 仿 setMcpEnabled（:150-164）：调 ipc → 失败落 error →
// 成功设 installNotice → await load() 刷新。

// ResourceLibraryView.addItemsFor('plugin') 返回两项：
//   { key: 'zip', title: '安装插件 zip…', icon: PackagePlus, onSelect: 打开 InstallPluginZipDialog }
//   { key: 'dev', title: '注册开发目录…', icon: FolderGit2, onSelect: 打开 RegisterPluginDirDialog }
// View 层新增两个 useState 开关 + 条件渲染；onTogglePlugin={(_, next) => void store.setPluginEnabled(item.slug, workspaceId, next)}

// ResourceDetail plugin 分支：组件清单（components.map → chip）、dev 源显示 sourcePath、
// missing 状态徽标（text-status-warning）、卸载按钮 → 复用 PromptDialog 问「是否保留插件数据目录」
// → ipc.plugin.uninstall(item.slug, keepData) → 刷新。
```

- [ ] **Step 4: renderer 测试 + lint**

Run: `cd renderer && npx pnpm@9.0.0 vitest run src/components/resource-library/`
Expected: PASS（含新增两组件测试与 TypePageShell 更新）

Run: `npx pnpm@9.0.0 typecheck`
Expected: 0 错误

- [ ] **Step 5: Commit**

```bash
git add renderer/src/components/resource-library/ renderer/src/stores/resource.store.ts
git commit -m "feat: 资源库插件页（zip 安装/dev 注册弹窗 + 启停 + 详情卸载，spec §8.1）"
```

---

### Task 10: 收官——全量守护 + 变更账本 + alpha 号

**Files:**
- Modify: `CHANGELOG.md`（v2.1 研发账本新增「插件系统 P1」条目：manifest 校验 / zip+dev 安装链 / 注册表与启停 / 资源库插件页）
- Modify: 三处 `package.json` alpha 号 +1（根 / electron / renderer，按 docs/dev/release.md 研发期策略）

- [ ] **Step 1: 全量守护**

Run: `npx pnpm@9.0.0 typecheck && npx pnpm@9.0.0 test`
Expected: 双 workspace 全绿（任何由本计划引入的失败须修复；预存失败单独报告不扩scope）

- [ ] **Step 2: dev 冒烟（macOS 主机）**

Run: `npx pnpm@9.0.0 dev` → 手工走查：资源库出现「插件」页 → 注册一个 dev 目录插件（用本仓库内构造的 fixture 插件目录）→ 卡片出现（components 列表）→ 启停开关生效 → 卸载（保留数据）→ data 目录留存。截图留档。

- [ ] **Step 3: CHANGELOG + alpha 号**

三处 package.json `2.1.0-alpha.N` → N+1；CHANGELOG.md 按研发账本格式记 P1 条目（不改产品版本号定稿）。

- [ ] **Step 4: Commit**

```bash
git add CHANGELOG.md package.json electron/package.json renderer/package.json
git commit -m "chore: 插件系统 P1 收官（CHANGELOG 研发账本 + alpha 号 +1）"
```

---

## P1 边界（执行者须知）

- **组件不激活**：skills / agents / mcp / tools / service / panel 的运行时激活全部属 P2-P4。P1 插件卡只展示 manifest 元信息（组件清单、版本、启停态）
- **「重载插件」动作不在 P1**（P2 工具模块加载后才需要）
- **workspaceId 链路**：resource:list 现有签名若无 workspaceId，则 P1 插件行 enabled 缺省 true，启停后由前端本地刷新——真实 per-workspace 过滤在 P2 AGENT_CONFIG 装配时闭环（spec §4.2）
- settings 页插件面板（workspace 级启停的第二个入口）留 P2，P1 启停在资源库页内完成

## Self-Review 记录

- **Spec 覆盖**：§2 manifest+校验（Task 2/4）✓ §7.1 存储/状态模型（Task 1/3）✓ §7.2 安装来源/更新/卸载（Task 4/5）✓ §8.1 验收前半「资源库出现插件卡」（Task 6/9）✓ §7.3 强制项中 P1 相关的路径安全/白名单（Task 2/4）✓——§8.1 后半（service/工具/面板激活）属 P2+，与 P1 边界一致
- **占位符扫描**：无 TBD/TODO；Task 6 library.ts 接入与 Task 9 UI 代码为「按现场签名/预览稿对齐」的受控增量，均已给出锚点与验收断言，非空洞占位
- **类型一致性**：`PluginRecord.installedAt` vs DB `installed_at` 命名参数错位已在 Task 4 Step 3 内标注修正方案（以测试为准）；`PluginSummary` 四字段在 Task 7/8 两处定义同构
- **Review Focus 落位**：五项分别钉在 Task 4（bomb/穿越/minAppVersion）、Task 2（components 越界）、Task 3（dev missing）测试
