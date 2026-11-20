# db-pro 连接管理面板与权限矩阵（B 期）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans（用户裁定：主会话直做，**不委派子 agent**）。Steps use checkbox (`- [ ]`) syntax.

**Goal:** 把 db-pro 连接配置从 manifest 设置键迁到插件面板管理（侧栏连接列表 + 右侧编辑 + 权限选择），并落地逐连接 8 位权限矩阵（配置态闸）+ 迁移保等效。

**Architecture:** service 自有连接存储（`data/connections.json` 元数据 + 密钥经 `ctx.secrets` 入 keytar）→ 面板（`panel/` 单文件 vanilla JS，经 PanelChannel `callService` 调 RPC）→ 引擎 configure 携带 `permissions` 做纵深防御；manifest 设置页只留三个插件级参数。

**Tech Stack:** Node 24 CJS、zustand-free 面板原生 JS、PanelChannel（ready/getContext/callService）、vitest。

**Spec:** `docs/specs/2026-11-19-db-pro-script-engine-and-connection-panel-design.md`（§6 全篇 + D9–D12）

**前置事实（本轮已核实，替代 spec §8 V2/V3）：**
- `ctx.getConfig()` = 宿主 `readPluginConfigJson` 原始 JSON + 敏感 overlay（**不按 schema 过滤**）——manifest 删键后旧 conn 值仍可读；
- `ctx.getDataDir()` = `resolvePluginDataDir(id)` = 全局 `<pluginsDir>/data/<id>`（非 per-workspace）——连接全局存储成立；
- `ctx.secrets` 键域 `plugin/<id>/secret/<key>`，键须匹配 `^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$`（**不允许 `-`**）。

## Global Constraints

- Node 24、CommonJS、零外部依赖；面板零构建链（单 HTML）。
- **UI 预览门禁（P1 新页面）**：B1 产出静态预览 → 用户明确确认后才可执行 B8；预览落 `.omo/previews/`（gitignored），明暗双主题并排、真实 token、真实感文案。
- 密钥明文只进 keytar；`connections.list` 只回非敏感投影（scheme/host/port/database/是否已配置），password 恒不回显。
- 迁移**保等效**：旧连接导入为全 8 权限位（D10）；迁移幂等（connections.json 存在即跳过）。
- 宿主零代码改动；不改任何 `package.json` 版本号；commit 仅在用户要求时执行（以下提交步骤为纪律步骤）。

## Review Focus

1. **密钥不泄漏**：`connections.list`/日志/错误文案绝不出现 URL 密码；面板编辑态只在用户输入时可见明文。
2. **迁移保等效**：旧 conn1–6 全部导入且全权限位；重复启动不重复导入；老 keytar 键被清除（杜绝双源）。
3. **权限双闸**：缺位在「配置态」拒绝（query/exec/script 三通道 + script 逐条分类），批过位后人工门照旧。
4. **删除/改名的原子性**：删连接后引擎池被关闭、default 指针自动收敛；改名后人工请求载荷中的旧名不能继续命中池。
5. **面板与宿主契约**：iframe 内 `callService` 失败、连接测试失败、URL 非法均有可见错误，不出现白屏/静默。

---

### Task B1: 面板静态预览稿（用户门禁，先于一切 UI 代码）

**Files:**
- Create: `.omo/previews/db-pro-connections.html`（gitignored，不入库）

**Interfaces:**
- Produces: 已获用户确认的布局定值清单（宽度/字号/间距/token/交互态），供 B8 逐项落码。

- [ ] **Step 1: 从 `renderer/src/styles/globals.css` 复制 `:root` / `.dark` 真实变量**，页面同时并排渲染明暗两栏（每栏一个完整面板实例）。
- [ ] **Step 2: 出左栏 + 右栏完整形态**：
  - 左栏 220px：标题「数据库」+「+ 新增连接」按钮 + 连接项（引擎图标、名称、权限徽标「只读/读写/全权」、默认★、hover 态）+ 空态文案；
  - 右栏：名称输入、描述输入、连接 URL（已配置占位「已配置 · 点击更换」与输入态两种并排）、权限区（预设 4 radio + 8 个细粒度 checkbox，勾选态示例「读写」）、「测试连接」按钮 + 成功/失败两种结果行、底部「保存 / 取消」；
  - 真实感 mock：`mysql_dev（MySQL · 只读）`、`oracle_prod（Oracle · 全权★）`、`dm_report`。
- [ ] **Step 3: macOS 打开预览**：`open .omo/previews/db-pro-connections.html`，向用户说明定值清单，**停下等待明确确认**。
- [ ] **Step 4: 用户确认后**把定值清单写入本节（宽度/字号/token/图标名/交互态），作为 B8 的对照合同。若用户提修改 → 改预览 → 再确认，不得先写产品代码。

---

### Task B2: 权限位模型（纯函数）

**Files:**
- Create: `plugins/db-pro/engine/permissions.js`
- Test: `tests/db-pro/permissions.test.mjs`

**Interfaces:**
- Produces: `PERMISSION_BITS`（8 位）、`PRESETS`、`normalizePermissions(raw) → string[]`、`requiredBitsForClass(cls) → string[]`、`missingBits(permissions, cls) → string[]`、`hasBit(permissions, bit) → boolean`、`LEGACY_FULL`（全 8 位）。

- [ ] **Step 1: 写失败测试**

```js
// tests/db-pro/permissions.test.mjs
import { describe, it, expect } from 'vitest';
import p from '../../plugins/db-pro/engine/permissions.js';
const { PERMISSION_BITS, PRESETS, normalizePermissions, requiredBitsForClass, missingBits, LEGACY_FULL } = p;

describe('权限位模型', () => {
  it('8 位 + 预设档', () => {
    expect(PERMISSION_BITS).toHaveLength(8);
    expect(PRESETS.read).toEqual(['query']);
    expect(PRESETS.readwrite).toEqual(['query', 'insert', 'update', 'delete']);
    expect(PRESETS.full).toEqual(PERMISSION_BITS);
  });
  it('normalize：去未知位/去重/排序稳定', () => {
    expect(normalizePermissions(['script', 'query', 'bogus', 'query'])).toEqual(['query', 'script']);
    expect(normalizePermissions(undefined)).toEqual([]);
  });
  it('分类 → 所需位', () => {
    expect(requiredBitsForClass('read')).toEqual(['query']);
    expect(requiredBitsForClass('merge')).toEqual(['insert', 'update', 'delete']);
    expect(requiredBitsForClass('ddl_table')).toEqual(['ddl_table']);
    expect(requiredBitsForClass('block')).toEqual(['procedure']);
    expect(requiredBitsForClass('session')).toEqual([]);
    expect(requiredBitsForClass('priv')).toEqual([]);
  });
  it('missingBits 返回缺失集合', () => {
    expect(missingBits(['query'], 'insert')).toEqual(['insert']);
    expect(missingBits(PRESETS.full, 'ddl_table')).toEqual([]);
  });
  it('LEGACY_FULL = 全 8 位（迁移保等效）', () => {
    expect([...LEGACY_FULL].sort()).toEqual([...PERMISSION_BITS].sort());
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /Users/stbearangel/dev/AiProject/momo-plugin && npx vitest run tests/db-pro/permissions.test.mjs`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

```js
'use strict';
// 逐连接权限位（spec 2026-11-19 §6.4）：配置态闸；人工批准为独立运行态闸。

const PERMISSION_BITS = ['query', 'insert', 'update', 'delete', 'ddl_table', 'ddl_other', 'procedure', 'script'];
const BIT_SET = new Set(PERMISSION_BITS);

const PRESETS = {
  read: ['query'],
  readwrite: ['query', 'insert', 'update', 'delete'],
  full: [...PERMISSION_BITS],
};

const LEGACY_FULL = [...PERMISSION_BITS];

/** 语句分类 → 所需权限位（session/txn 中性，priv 由通道直接拒绝） */
const CLASS_BITS = {
  read: ['query'],
  insert: ['insert'],
  update: ['update'],
  delete: ['delete'],
  merge: ['insert', 'update', 'delete'],
  ddl_table: ['ddl_table'],
  ddl_other: ['ddl_other'],
  procedure: ['procedure'],
  block: ['procedure'],
  session: [],
  txn: [],
  priv: [],
  unknown: [],
};

function normalizePermissions(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  for (const v of raw) {
    if (typeof v === 'string' && BIT_SET.has(v)) seen.add(v);
  }
  return PERMISSION_BITS.filter((b) => seen.has(b));
}

function requiredBitsForClass(cls) {
  return CLASS_BITS[cls] ?? [];
}

function hasBit(permissions, bit) {
  return Array.isArray(permissions) && permissions.includes(bit);
}

function missingBits(permissions, cls) {
  const need = requiredBitsForClass(cls);
  return need.filter((b) => !hasBit(permissions, b));
}

module.exports = { PERMISSION_BITS, PRESETS, LEGACY_FULL, normalizePermissions, requiredBitsForClass, hasBit, missingBits };
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd /Users/stbearangel/dev/AiProject/momo-plugin && npx vitest run tests/db-pro/permissions.test.mjs`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
cd /Users/stbearangel/dev/AiProject/momo-plugin
git add plugins/db-pro/engine/permissions.js tests/db-pro/permissions.test.mjs
git commit -m "feat(db-pro): 逐连接权限位模型（8 位+预设档）"
```

---

### Task B3: 引擎权限 enforcement + `probe`（测试连接）

**Files:**
- Modify: `plugins/db-pro/engine/engine.js`、`plugins/db-pro/engine/protocol.js`（如需新错误码）
- Test: `tests/db-pro/engine.test.mjs`（追加）

**Interfaces:**
- Consumes: `permissions.js`；连接配置项新增 `permissions: string[]`（缺省 = 全 8 位，向后兼容 A 期）。
- Produces: `dispatch('probe', {url, queryTimeoutMs}) → {ok:true}`（临时建池 ping 后关闭）；`query`/`explain`/`meta.*` 需 `query` 位；`exec` 按 `classifyStatement` 分类核位；`scriptRun` 需 `script` 位 + 逐条分类核位。

- [ ] **Step 1: 写失败测试（fake driver）**

```js
// tests/db-pro/engine.test.mjs（追加）
describe('权限 enforcement（配置态闸）', () => {
  async function setup(permissions) {
    const f = fakeDriver(); // 复用文件内既有 fakeDriver（含 query/exec/close）
    const d = createDispatcher(() => ({ createPool: async () => f.pool }), new Map());
    await d.dispatch('configure', {
      connections: [{ name: 'ro', url: 'mysql://u:p@h/d', queryTimeoutMs: 1000, ...(permissions ? { permissions } : {}) }],
    });
    return d;
  }

  it('只读连接：query 放行、exec 拒（未授权 insert）', async () => {
    const d = await setup(['query']);
    const q = await d.dispatch('query', { connection: 'ro', sql: 'SELECT 1', maxRows: 5 });
    expect(q.rows).toEqual([[1]]);
    await expect(d.dispatch('exec', { connection: 'ro', sql: 'INSERT INTO t VALUES (1)' }))
      .rejects.toMatchObject({ code: 'readonly_rejected' });
    await expect(d.dispatch('exec', { connection: 'ro', sql: 'INSERT INTO t VALUES (1)' }))
      .rejects.toThrow(/insert/);
  });

  it('读写连接：insert 放行、DDL 拒（未授权 ddl_table）', async () => {
    const d = await setup(['query', 'insert', 'update', 'delete']);
    const r = await d.dispatch('exec', { connection: 'ro', sql: 'INSERT INTO t VALUES (1)' });
    expect(r.affectedRows).toBe(1);
    await expect(d.dispatch('exec', { connection: 'ro', sql: 'DROP TABLE t' })).rejects.toThrow(/ddl_table/);
  });

  it('缺省 permissions（A 期老配置）→ 全权放行（兼容）', async () => {
    const d = await setup(undefined);
    await expect(d.dispatch('exec', { connection: 'ro', sql: 'DROP TABLE t' })).resolves.toBeTruthy();
  });

  it('scriptRun：无 script 位即拒；逐条分类缺位定位到语句', async () => {
    const ro = await setup(['query']);
    await expect(ro.dispatch('scriptRun', { connection: 'ro', script: 'SELECT 1;' })).rejects.toThrow(/script/);
    const rw = await setup(['query', 'script']);
    await expect(rw.dispatch('scriptRun', { connection: 'ro', script: 'SELECT 1;\nDROP TABLE t;' }))
      .rejects.toThrow(/第 2 条.*ddl_table/);
  });

  it('probe：临时建池 ping 后关闭（不污染池）', async () => {
    const closed = [];
    const pools = new Map();
    const d = createDispatcher(() => ({
      createPool: async () => ({ async ping() {}, async close() { closed.push(1); } }),
    }), pools);
    await expect(d.dispatch('probe', { url: 'mysql://u:p@h/d' })).resolves.toEqual({ ok: true });
    expect(closed).toHaveLength(1);
    expect(pools.size).toBe(0);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /Users/stbearangel/dev/AiProject/momo-plugin && npx vitest run tests/db-pro/engine.test.mjs`
Expected: FAIL（权限未生效/未知方法 probe）

- [ ] **Step 3: 实现**

`engine.js` 顶部引入：

```js
const { classifyStatement } = require('./script-splitter');
const { LEGACY_FULL, hasBit, missingBits, requiredBitsForClass } = require('./permissions');
```

`pools` 句柄增存权限：

```js
        pools.set(c.name, {
          name: c.name, url: c.url, queryTimeoutMs: c.queryTimeoutMs,
          permissions: Array.isArray(c.permissions) ? c.permissions : LEGACY_FULL,
          pool,
        });
```

diff 判定含权限：`applyConfigure` 关闭条件追加 `|| JSON.stringify(h.permissions) !== JSON.stringify(n.permissions ?? LEGACY_FULL)`；同名重建条件同步。

新增辅助（模块内）：

```js
  function permsOf(name) {
    const h = pools.get(name);
    return h ? h.permissions : LEGACY_FULL;
  }

  function assertPerm(name, cls) {
    const need = requiredBitsForClass(cls);
    const missing = need.filter((b) => !hasBit(permsOf(name), b));
    if (missing.length > 0) {
      throw new EngineError(
        CODES.VALIDATION,
        `连接 "${name}" 未授权 ${missing.join('/')} 操作——请在插件面板「数据库」中调整该连接权限`,
      );
    }
  }

  function assertScriptPerm(name, statements) {
    if (!hasBit(permsOf(name), 'script')) {
      throw new EngineError(CODES.VALIDATION, `连接 "${name}" 未授权脚本执行——请在插件面板「数据库」中开启该权限`);
    }
    for (const s of statements) {
      const missing = s.cls === 'priv' ? ['priv(禁止)'] : missingBits(permsOf(name), s.cls);
      if (missing.length > 0) {
        throw new EngineError(
          CODES.VALIDATION,
          `第 ${s.idx} 条（第 ${s.line} 行）需要 ${missing.join('/')} 权限——连接 "${name}" 未授权`,
        );
      }
    }
  }
```

接线：
- `case 'query'` / `case 'explain'` / 各 `meta.*`：分支开头 `assertPerm(params.connection, 'read');`
- `case 'exec'`：先分类再核位：

```js
      case 'exec': {
        const cls = classifyStatement(params.sql).cls;
        if (cls === 'priv') {
          throw new EngineError(CODES.VALIDATION, '不支持 GRANT/REVOKE 等权限管理语句（DBA 域）');
        }
        assertPerm(params.connection, cls);
        return await mustPool(params.connection).exec(params.sql);
      }
```

- `scriptRun`：在 GRANT 预检后追加 `assertScriptPerm(params.connection, statements);`
- 新 op：

```js
      case 'probe': {
        const proto = new URL(params.url).protocol.replace(':', '');
        const loader = DIALECT_LOADERS[proto];
        if (!loader) throw new EngineError(CODES.CONN, `不支持的连接协议 "${proto}://"（支持 mysql/postgres/oracle/dm）`);
        const tmp = await loader().createPool(params.url, { queryTimeoutMs: params.queryTimeoutMs ?? 30_000 });
        try { await tmp.ping(); } finally { await tmp.close().catch(() => undefined); }
        return { ok: true };
      }
```

- [ ] **Step 4: 跑测试确认通过（含 A 期脚本测试回归）**

Run: `cd /Users/stbearangel/dev/AiProject/momo-plugin && npx vitest run tests/db-pro/engine.test.mjs tests/db-pro/script-splitter.test.mjs`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
cd /Users/stbearangel/dev/AiProject/momo-plugin
git add plugins/db-pro/engine/engine.js tests/db-pro/engine.test.mjs
git commit -m "feat(db-pro): 引擎按连接权限位校验（query/exec/script 三通道）+ probe"
```

---

### Task B4: 连接存储 + 旧配置迁移

**Files:**
- Create: `plugins/db-pro/service/connections-store.js`
- Test: `tests/db-pro/connections-store.test.mjs`

**Interfaces:**
- Consumes: `ctx.getDataDir()`（全局）、`ctx.secrets`（get/set/delete）、`ctx.getConfig()`（迁移读取原始旧键）。
- Produces: `createConnectionsStore({dataDir, secrets, log}) → {listProjection(), listForEngine(), create(input), update(id, patch), remove(id), setDefault(id), resolveUrl(id), migrateLegacy(legacyConfig)}`；
  - 记录形状 `{id, name, description, permissions[], isDefault, createdAt, updatedAt}`；URL 存 `secrets` 键 `conn.<id>.url`；
  - `listProjection()` 不含 URL 明文；`listForEngine()` 回 `{name, url, permissions}`（URL 从 secrets 解析并缓存）。

- [ ] **Step 1: 写失败测试**

```js
// tests/db-pro/connections-store.test.mjs
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import m from '../../plugins/db-pro/service/connections-store.js';
const { createConnectionsStore } = m;

function mkStore(initialSecrets = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbpro-conns-'));
  const kv = new Map(Object.entries(initialSecrets));
  const secrets = {
    async get(k) { return kv.get(k) ?? null; },
    async set(k, v) { kv.set(k, v); },
    async delete(k) { kv.delete(k); },
    kv,
  };
  return { dir, kv, secrets, store: createConnectionsStore({ dataDir: dir, secrets, log: () => undefined }) };
}

describe('connections-store CRUD', () => {
  it('create 校验名称唯一/URL scheme；URL 只入 secrets，投影不含明文', async () => {
    const { store, kv } = mkStore();
    const rec = await store.create({ name: 'dev', description: '开发库', url: 'mysql://u:secret@h:3306/d', permissions: ['query'] });
    expect(rec.id).toMatch(/^c_[a-z0-9]+$/);
    expect(kv.get(`conn.${rec.id}.url`)).toContain('secret');
    const proj = store.listProjection();
    expect(JSON.stringify(proj)).not.toContain('secret');
    expect(proj[0]).toMatchObject({ name: 'dev', dialect: 'mysql', hasUrl: true, permissions: ['query'] });
    await expect(store.create({ name: 'dev', url: 'mysql://u:p@h/d' })).rejects.toThrow(/已存在/);
    await expect(store.create({ name: 'bad', url: 'sqlite://x' })).rejects.toThrow(/协议/);
  });
  it('update 改名/换 URL/改权限；remove 清密钥；setDefault 单点', async () => {
    const { store, kv } = mkStore();
    const a = await store.create({ name: 'a', url: 'mysql://u:p@h/a', permissions: ['query'] });
    const b = await store.create({ name: 'b', url: 'postgres://u:p@h/b', permissions: ['query'] });
    await store.update(a.id, { name: 'a2', permissions: ['query', 'insert'] });
    expect(store.listProjection().find((x) => x.id === a.id)).toMatchObject({ name: 'a2', permissions: ['query', 'insert'] });
    await store.setDefault(b.id);
    expect(store.listProjection().filter((x) => x.isDefault)).toHaveLength(1);
    await store.remove(a.id);
    expect(kv.get(`conn.${a.id}.url`)).toBeUndefined();
    expect(store.listProjection()).toHaveLength(1);
  });
  it('listForEngine 解析 URL；secrets 缺失的连接跳过并告警', async () => {
    const { store, secrets } = mkStore();
    const a = await store.create({ name: 'a', url: 'mysql://u:p@h/a', permissions: ['query'] });
    const bad = await store.create({ name: 'bad', url: 'mysql://u:p@h/b', permissions: ['query'] });
    await secrets.delete(`conn.${bad.id}.url`);
    const rows = await store.listForEngine();
    expect(rows).toEqual([{ name: 'a', url: 'mysql://u:p@h/a', permissions: ['query'] }]);
    expect(rows.some((r) => r.name === 'bad')).toBe(false);
  });
});

describe('migrateLegacy（保等效）', () => {
  it('旧 conn1–6 导入：全权限位 + default 标记 + 清旧密钥；幂等', async () => {
    const legacy = {
      conn1_url: 'mysql://u:p@h/a', conn1_name: 'mysql',
      conn2_url: 'dm://SYSDBA:SYSDBA001@h:5236', conn2_name: 'dm_test',
      default_connection: 'dm_test',
    };
    const { store, kv, secrets } = mkStore({ conn1_url: legacy.conn1_url, conn2_url: legacy.conn2_url });
    await store.migrateLegacy(legacy);
    const proj = store.listProjection();
    expect(proj).toHaveLength(2);
    expect(proj.every((x) => x.permissions.length === 8)).toBe(true);
    expect(proj.find((x) => x.isDefault)?.name).toBe('dm_test');
    expect(kv.get('conn1_url')).toBeUndefined();
    expect(kv.get('conn2_url')).toBeUndefined();
    await store.migrateLegacy(legacy);
    expect(store.listProjection()).toHaveLength(2);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /Users/stbearangel/dev/AiProject/momo-plugin && npx vitest run tests/db-pro/connections-store.test.mjs`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

```js
'use strict';
// 连接存储（spec 2026-11-19 §6.1/§6.2）：元数据 connections.json（全局）；
// URL 明文只进 keytar（secrets 键 conn.<id>.url）。迁移旧 conn1–6 保等效全权限位。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { LEGACY_FULL, normalizePermissions, PRESETS } = require('../engine/permissions');

const FILE = 'connections.json';
const SCHEMES = new Set(['mysql', 'postgres', 'postgresql', 'oracle', 'dm', 'dameng']);

function newId() {
  return `c_${crypto.randomBytes(4).toString('hex')}`;
}

function dialectOf(url) {
  try {
    return new URL(url).protocol.replace(':', '');
  } catch {
    return 'unknown';
  }
}

function createConnectionsStore({ dataDir, secrets, log }) {
  const file = path.join(dataDir, FILE);
  const urlCache = new Map();

  function readAll() {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  function writeAll(records) {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(records, null, 1) + '\n');
  }

  let records = readAll();

  function assertNameFree(name, exceptId) {
    if (records.some((r) => r.name === name && r.id !== exceptId)) throw new Error(`连接名 "${name}" 已存在——请换一个名称`);
  }

  function assertUrl(url) {
    let u;
    try { u = new URL(url); } catch { throw new Error('连接 URL 非法——示例：mysql://user:pass@host:3306/db'); }
    const scheme = u.protocol.replace(':', '');
    if (!SCHEMES.has(scheme)) throw new Error(`不支持的连接协议 "${scheme}://"（支持 mysql/postgres/oracle/dm）`);
  }

  function secretKey(id) { return `conn.${id}.url`; }

  /**
   * 面板投影：不含 URL 明文。dialect 从 secret 的 scheme 推断（缓存）；
   * secrets 无值时 dialect=unknown + hasUrl=false。
   */
  function listProjection() {
    return records.map((r) => {
      const cached = urlCache.get(r.id);
      const hasUrl = cached !== undefined;
      return {
        id: r.id, name: r.name, description: r.description ?? '',
        permissions: r.permissions, isDefault: r.isDefault === true,
        dialect: hasUrl ? dialectOf(cached) : 'unknown',
        hasUrl,
      };
    });
  }

  /** 预热 URL 缓存（面板 list / service ensureConfig 前调用） */
  async function warm() {
    for (const r of records) {
      if (urlCache.has(r.id)) continue;
      const url = await secrets.get(secretKey(r.id));
      if (url) urlCache.set(r.id, url);
    }
  }

  async function listForEngine() {
    const out = [];
    for (const r of records) {
      let url = urlCache.get(r.id);
      if (!url) {
        url = await secrets.get(secretKey(r.id));
        if (!url) {
          log('连接缺少密钥，已跳过', { id: r.id, name: r.name });
          continue;
        }
        urlCache.set(r.id, url);
      }
      out.push({ name: r.name, url, permissions: r.permissions });
    }
    return out;
  }

  async function create(input) {
    const name = String(input.name ?? '').trim();
    if (name === '') throw new Error('连接名称不能为空');
    assertNameFree(name);
    const url = String(input.url ?? '').trim();
    if (url === '') throw new Error('连接 URL 不能为空');
    assertUrl(url);
    const id = newId();
    const permissions = normalizePermissions(input.permissions?.length ? input.permissions : PRESETS.read);
    const rec = { id, name, description: String(input.description ?? ''), permissions, isDefault: records.length === 0, createdAt: Date.now(), updatedAt: Date.now() };
    await secrets.set(secretKey(id), url);
    urlCache.set(id, url);
    records = [...records, rec];
    writeAll(records);
    return rec;
  }

  async function update(id, patch) {
    const rec = records.find((r) => r.id === id);
    if (!rec) throw new Error('连接不存在');
    if (typeof patch.name === 'string') {
      const name = patch.name.trim();
      if (name === '') throw new Error('连接名称不能为空');
      assertNameFree(name, id);
      rec.name = name;
    }
    if (typeof patch.description === 'string') rec.description = patch.description;
    if (Array.isArray(patch.permissions)) rec.permissions = normalizePermissions(patch.permissions);
    if (typeof patch.url === 'string' && patch.url.trim() !== '') {
      assertUrl(patch.url.trim());
      await secrets.set(secretKey(id), patch.url.trim());
      urlCache.set(id, patch.url.trim());
    }
    rec.updatedAt = Date.now();
    writeAll(records);
    return rec;
  }

  async function remove(id) {
    if (!records.some((r) => r.id === id)) throw new Error('连接不存在');
    records = records.filter((r) => r.id !== id);
    await secrets.delete(secretKey(id));
    urlCache.delete(id);
    if (records.length > 0 && !records.some((r) => r.isDefault)) records[0].isDefault = true;
    writeAll(records);
  }

  async function setDefault(id) {
    if (!records.some((r) => r.id === id)) throw new Error('连接不存在');
    for (const r of records) r.isDefault = r.id === id;
    writeAll(records);
  }

  async function migrateLegacy(legacyConfig) {
    if (records.length > 0) return { migrated: 0 };
    const found = [];
    for (let i = 1; i <= 6; i += 1) {
      const url = typeof legacyConfig[`conn${i}_url`] === 'string' ? legacyConfig[`conn${i}_url`].trim() : '';
      if (url === '') continue;
      const name = typeof legacyConfig[`conn${i}_name`] === 'string' && legacyConfig[`conn${i}_name`].trim() !== ''
        ? legacyConfig[`conn${i}_name`].trim() : `conn${i}`;
      found.push({ name, url });
    }
    if (found.length === 0) return { migrated: 0 };
    const defName = typeof legacyConfig.default_connection === 'string' ? legacyConfig.default_connection.trim() : '';
    const next = [];
    for (const [idx, item] of found.entries()) {
      const id = newId();
      await secrets.set(secretKey(id), item.url);
      urlCache.set(id, item.url);
      next.push({
        id, name: item.name, description: '（自旧版配置迁移）', permissions: [...LEGACY_FULL],
        isDefault: defName ? item.name === defName : idx === 0, createdAt: Date.now(), updatedAt: Date.now(),
      });
    }
    records = next;
    if (!records.some((r) => r.isDefault)) records[0].isDefault = true;
    writeAll(records);
    for (let i = 1; i <= 6; i += 1) await secrets.delete(`conn${i}_url`).catch(() => undefined);
    return { migrated: records.length };
  }

  return { listProjection, listForEngine, warm, create, update, remove, setDefault, migrateLegacy };
}

module.exports = { createConnectionsStore };
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd /Users/stbearangel/dev/AiProject/momo-plugin && npx vitest run tests/db-pro/connections-store.test.mjs`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
cd /Users/stbearangel/dev/AiProject/momo-plugin
git add plugins/db-pro/service/connections-store.js tests/db-pro/connections-store.test.mjs
git commit -m "feat(db-pro): 连接存储（元数据+keytar 密钥+旧配置保等效迁移）"
```

---

### Task B5: service 接线（store / RPC / 异步 ensureConfig）

**Files:**
- Modify: `plugins/db-pro/service/index.js`、`plugins/db-pro/service/config-connections.js`（`diffConnections` 含权限）
- Test: `tests/db-pro/config-connections.test.mjs`（追加 diff 权限用例）

**Interfaces:**
- Consumes: `createConnectionsStore`；engine `probe`。
- Produces: service 方法 `connectionsList` / `connectionsCreate` / `connectionsUpdate` / `connectionsRemove` / `connectionsSetDefault` / `connectionsTest`；`ensureConfig` 改走 `store.listForEngine()`（异步）；`defaultConnection()` 取 store 投影的 `isDefault`。

- [ ] **Step 1: 写失败测试（diff 权限）**

```js
// tests/db-pro/config-connections.test.mjs（追加）
describe('diffConnections 含权限', () => {
  it('权限变化 → true', () => {
    const a = [{ name: 'a', url: 'mysql://u:p@h/d', queryTimeoutMs: 30000, permissions: ['query'] }];
    const b = [{ name: 'a', url: 'mysql://u:p@h/d', queryTimeoutMs: 30000, permissions: ['query', 'insert'] }];
    expect(diffConnections(a, b)).toBe(true);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /Users/stbearangel/dev/AiProject/momo-plugin && npx vitest run tests/db-pro/config-connections.test.mjs`
Expected: FAIL

- [ ] **Step 3: 实现**

`config-connections.js`：

```js
function diffConnections(prev, next) {
  if (prev.length !== next.length) return true;
  const byName = new Map(prev.map((c) => [c.name, c]));
  for (const n of next) {
    const p = byName.get(n.name);
    if (!p || p.url !== n.url || p.queryTimeoutMs !== n.queryTimeoutMs) return true;
    if (JSON.stringify(p.permissions ?? null) !== JSON.stringify(n.permissions ?? null)) return true;
  }
  return false;
}
```

`service/index.js`：

```js
const { createConnectionsStore } = require('./connections-store');
```

`createService` 内、`scriptState` 之后：

```js
  const store = createConnectionsStore({
    dataDir: ctx.getDataDir(),
    secrets: ctx.secrets,
    log: (msg, meta) => ctx.logger.warn(msg, meta),
  });

  async function reloadConnections() {
    await store.warm();
    const conns = (await store.listForEngine()).map((c) => ({
      ...c,
      queryTimeoutMs: sanitizeTimeoutMs(ctx.getConfig().query_timeout_ms),
    }));
    if (diffConnections(lastConnections, conns)) {
      try {
        const r = await rpc('configure', { connections: conns }, ENGINE_BOOT_TIMEOUT_MS);
        lastUnavailable = new Map((r.unavailable ?? []).map((u) => [u.name, u.reason]));
        lastConnections = conns;
      } catch (err) {
        ctx.logger.warn('连接配置下发失败（下次调用重试）', { error: err.message });
      }
    }
  }

  async function ensureConfig() {
    if (store.listProjection().length === 0) {
      const r = await store.migrateLegacy(ctx.getConfig());
      if (r.migrated > 0) ctx.logger.info(`已从旧版配置迁移 ${r.migrated} 个数据库连接`);
    }
    await reloadConnections();
  }
```

`defaultConnection()` 改为：

```js
  function defaultConnection() {
    const proj = store.listProjection();
    const def = proj.find((c) => c.isDefault);
    return (def ?? proj[0])?.name ?? '';
  }
```

`start()` 改为：

```js
    async start() {
      try {
        await ensureConfig();
      } catch (err) {
        ctx.logger.warn('db-pro 连接初始化失败（修配置后自动生效）', { error: err.message });
      }
      try {
        await bootEngine();
      } catch (err) {
        ctx.logger.warn('db-pro 引擎首启失败（退避重试中）', { error: err.message });
        scheduleRestart();
      }
    },
```

`handle` 追加 RPC：

```js
    if (method === 'connectionsList') {
      await store.warm();
      return { connections: store.listProjection() };
    }
    if (method === 'connectionsCreate') {
      await store.create(params);
      await reloadConnections();
      return { connections: store.listProjection() };
    }
    if (method === 'connectionsUpdate') {
      await store.update(String(params.id), params.patch ?? params);
      await reloadConnections();
      return { connections: store.listProjection() };
    }
    if (method === 'connectionsRemove') {
      await store.remove(String(params.id));
      await reloadConnections();
      return { connections: store.listProjection() };
    }
    if (method === 'connectionsSetDefault') {
      await store.setDefault(String(params.id));
      return { connections: store.listProjection() };
    }
    if (method === 'connectionsTest') {
      const target = params.url
        ? { url: String(params.url) }
        : await (async () => {
            const rows = await store.listForEngine();
            const hit = rows.find((r) => r.name === String(params.name));
            if (!hit) throw new Error('连接不存在或缺少密钥');
            return hit;
          })();
      return await rpc('probe', { url: target.url, queryTimeoutMs: sanitizeTimeoutMs(ctx.getConfig().query_timeout_ms) }, 20_000);
    }
```

（`listConnections` 原实现改为回 store 投影 + 引擎可用性合并：`ok` 依据 `lastUnavailable`。）

- [ ] **Step 4: 跑测试确认通过 + 全量 db-pro 单测**

Run: `cd /Users/stbearangel/dev/AiProject/momo-plugin && npx vitest run tests/db-pro/`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
cd /Users/stbearangel/dev/AiProject/momo-plugin
git add plugins/db-pro/service/index.js plugins/db-pro/service/config-connections.js tests/db-pro/config-connections.test.mjs
git commit -m "feat(db-pro): service 接线连接存储 RPC 与异步配置下发"
```

---

### Task B6: 脚本/写通道「审批前」权限预检（人话错误）

**Files:**
- Modify: `plugins/db-pro/service/script-state.js`（submit 内、分析后比对权限）
- Test: `tests/db-pro/script-state.test.mjs`（追加）

**Interfaces:**
- Consumes: analyze 回包 + `permissionsOf(connection) → string[]` 注入（service 侧从 store 解析）。
- Produces: 缺位在**建卡前**拒绝：`throw new Error('脚本第 N 条（第 L 行）需要 X 权限——连接 "y" 未授权…')`；dryrun 同样适用。

- [ ] **Step 1: 写失败测试**

```js
// tests/db-pro/script-state.test.mjs（追加）
describe('审批前权限预检', () => {
  it('缺 script 位 → submit 直接拒（不建卡）', async () => {
    const { state, gate } = makeDeps({ permissionsOf: async () => ['query'] });
    await expect(state.submit({ connection: 'c', script: 'SELECT 1', sessionId: 's' }))
      .rejects.toThrow(/script/);
    expect(gate.created).toHaveLength(0);
  });
  it('逐条分类缺位 → 报语句序号与缺失位', async () => {
    const { state } = makeDeps({ permissionsOf: async () => ['query', 'script'] });
    await expect(state.submit({ connection: 'c', script: 'SELECT 1;\nDROP TABLE t;', sessionId: 's' }))
      .rejects.toThrow(/第 2 条.*ddl_table/);
  });
  it('权限齐 → 正常建卡', async () => {
    const { state, gate } = makeDeps({ permissionsOf: async () => ['query', 'script', 'insert'] });
    const r = await state.submit({ connection: 'c', script: 'SELECT 1', sessionId: 's' });
    expect(r.status).toBe('pending');
    expect(gate.created).toHaveLength(1);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /Users/stbearangel/dev/AiProject/momo-plugin && npx vitest run tests/db-pro/script-state.test.mjs`
Expected: FAIL（无权限预检）

- [ ] **Step 3: 实现**

`script-state.js` 工厂签名加 `permissionsOf`（缺省 `async () => LEGACY_FULL`，保持既有测试兼容），import `hasBit/missingBits`；`submit` 在 `analysis` 之后、`dryrun` 返回之前插入：

```js
    const perms = await permissionsOf(connection);
    if (!hasBit(perms, 'script')) {
      throw new Error(`连接 "${connection}" 未授权脚本执行——请在插件面板「数据库」中开启该连接权限`);
    }
    for (const s of analysis.statements ?? []) {
      const missing = s.cls === 'priv' ? ['GRANT/REVOKE 不支持'] : missingBits(perms, s.cls);
      if (missing.length > 0) {
        throw new Error(`脚本第 ${s.idx} 条（第 ${s.line} 行）需要 ${missing.join('/')} 权限——连接 "${connection}" 未授权`);
      }
    }
```

`service/index.js` 注入：

```js
    permissionsOf: async (name) => {
      const rows = await store.listForEngine().catch(() => []);
      const hit = rows.find((r) => r.name === name);
      return hit ? hit.permissions : LEGACY_FULL;
    },
```

（`script-state.js` import：`const { LEGACY_FULL, hasBit, missingBits } = require('../engine/permissions');`）

- [ ] **Step 4: 跑测试确认通过**

Run: `cd /Users/stbearangel/dev/AiProject/momo-plugin && npx vitest run tests/db-pro/script-state.test.mjs`
Expected: PASS（既有用例仍绿——缺省 permissionsOf 全权）

- [ ] **Step 5: 提交**

```bash
cd /Users/stbearangel/dev/AiProject/momo-plugin
git add plugins/db-pro/service/script-state.js plugins/db-pro/service/index.js tests/db-pro/script-state.test.mjs
git commit -m "feat(db-pro): 脚本通道审批前权限预检（逐条分类人话定位）"
```

---

### Task B7: manifest 瘦身（设置页只留插件级参数）

**Files:**
- Modify: `plugins/db-pro/momo-plugin.json`

**Interfaces:**
- Produces: config.properties 仅 `readonly_max_rows` / `query_timeout_ms` / `script_timeout_ms`；迁移在 B5 已就位（ctx.getConfig 原始 JSON 仍读到旧键）。

- [ ] **Step 1: 删除 13 个连接键**（conn1–6_url、conn1–6_name、default_connection），保留三个参数键。
- [ ] **Step 2: 校验 JSON 合法 + 单测回归**

Run: `cd /Users/stbearangel/dev/AiProject/momo-plugin && node -e "JSON.parse(require('fs').readFileSync('plugins/db-pro/momo-plugin.json','utf8'));console.log('ok')" && npx vitest run tests/db-pro/`
Expected: JSON ok；测试全绿

- [ ] **Step 3: 提交**

```bash
cd /Users/stbearangel/dev/AiProject/momo-plugin
git add plugins/db-pro/momo-plugin.json
git commit -m "feat(db-pro): manifest 瘦身（连接配置迁面板，设置页只留插件级参数）"
```

---

### Task B8: 面板实现（须 B1 预览已获用户确认）

**Files:**
- Create: `plugins/db-pro/panel/panel.json`、`plugins/db-pro/panel/index.html`
- Modify: `plugins/db-pro/momo-plugin.json`（`components.panel: "./panel"`）

**Interfaces:**
- Consumes: RPC `connectionsList/Create/Update/Remove/SetDefault/Test`；PanelChannel 协议（`ready` / `plugin:callService` / 主题 tokens）。
- Produces: page 挂载位面板（左栏连接列表 + 右栏编辑 + 权限预设/细粒度 + 测试连接）。

- [ ] **Step 1: panel.json**

```json
{
  "panels": [
    { "id": "connections", "title": "数据库", "icon": "lucide:database", "location": "page", "entry": "./index.html" }
  ]
}
```

- [ ] **Step 2: 按 B1 批准稿的**定值清单**逐项实现 `index.html`**（单文件 vanilla JS；主题经 ready 回包 tokens 映射；RPC 走 `plugin:callService`；email 面板为同款先例）。
- [ ] **Step 3: 面板自检（无宿主也能验）**：用 `python3 -m http.server` 打开页面时 RPC 应失败并显示错误行（不白屏）；随后在 dev app 内实测。
- [ ] **Step 4: 属性级对照验收**：逐项核对 B1 定值清单（grep 代码 + dev app `getComputedStyle`），再整页截图对照预览；偏差回预览门禁。
- [ ] **Step 5: 提交**

```bash
cd /Users/stbearangel/dev/AiProject/momo-plugin
git add plugins/db-pro/panel plugins/db-pro/momo-plugin.json
git commit -m "feat(db-pro): 连接管理面板（列表/编辑/权限/测试连接）"
```

---

### Task B9: 文档 + 手工验收清单

**Files:**
- Modify: `plugins/db-pro/README.md`

- [ ] **Step 1: README 更新**：连接在「数据库」面板管理；8 权限位表 + 预设档；迁移说明（旧设置页配置自动导入、全权限保等效）；`script_timeout_ms` 等设置项说明。
- [ ] **Step 2: 手测清单**（dev app + 用户 profile）：
  1. 面板打开 → 旧连接已迁移（名称/默认★/全权徽标）；旧 keytar 键已清（重启不重复导入）；
  2. 新建连接（含错误 URL/重名/密码）→ 校验文案正确；保存后 `list_connections` 可见；
  3. 权限矩阵：只读连接上 agent `write` → 拒（人话）；`script_execute` 缺 script 位 → 审批前拒；把权限改读写后 `write` 走人工批准成功；
  4. 测试连接成功/失败两态；删除连接后默认星标收敛；
  5. 设置页只剩三个参数项（无 conn 键）；
  6. 既有 A 期脚本全链路回归（dryrun → 批准 → 执行 → 历史）。
- [ ] **Step 3: 全量回归 + 提交**

```bash
cd /Users/stbearangel/dev/AiProject/momo-plugin
npx vitest run tests/db-pro/ && DBPRO_INTEGRATION=1 NODE_OPTIONS=--openssl-legacy-provider npx vitest run tests/db-pro/integration.test.mjs
git add plugins/db-pro/README.md
git commit -m "docs(db-pro): 连接面板与权限矩阵说明 + 迁移指引"
```

---

## 执行裁定

- 用户裁定：**不委派子 agent**，主会话直做。
- **B1 是硬门禁**：预览未获明确确认前，B8 不得开始；B2–B7 可在计划批准后先行（纯后端）。
- 分支策略：独立分支 `feat/db-pro-connection-panel`（自当前 `feat/db-pro-script-engine` HEAD 切出或待 A 合并后自 main 切出，以用户整合决策为准）。
- 版本号纪律：不触碰任何 `package.json` 版本。
