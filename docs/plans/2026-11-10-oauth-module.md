# 公共 OAuth 模块 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Electron 主进程新增通用 OAuth 2.1（授权码 + PKCE）内核与适配器层，先打通远程 MCP 的授权、刷新、401 重授权与连接池重建。

**Architecture:** 新增 `electron/src/main/oauth/` 域：`protocol/` 只懂标准协议，`service.ts` 编排，`adapters/mcp.ts` 把消费者翻译成 `AuthRequirement` / `AuthMaterial`。MCP 侧在唯一建连漏斗 `getOrStartMcp` 注入 headers/env，并把 `HttpMcpClient` 的失败升级为可判别状态码的结构化错误。Token 只落 keychain，元数据落新表 `oauth_connections`。

**Tech Stack:** Node 24 / Electron 44（主进程 CommonJS）、TypeScript strict、better-sqlite3（内联 SQL 迁移）、keytar（经 `storage/keychain.ts` 门面）、全局 `fetch` + 可选 undici Agent、React + zustand（renderer）、vitest。

**Spec:** `docs/specs/2026-11-10-oauth-module-design.md`

## Global Constraints

- Node 24 LTS（`nvm use 24`）；容器内 pnpm 未全局安装，一律 `npx pnpm@9.0.0 …`。
- TypeScript strict：禁止 `any` / `@ts-ignore` / `as any`；ESLint `no-explicit-any: error`。
- 所有代码注释、文档使用中文；代码标识符英文。
- SQLite 迁移必须是**内联 SQL 字符串常量**（`.sql` 文件不会进 `dist/`）；下一版本号 = **079**。
- 单测位置：electron 主进程集中 `electron/tests/`（镜像 `src/` 结构）；renderer 贴源 colocated（`Foo.test.tsx` 与 `Foo.tsx` 同目录）；根 `tests/` 只放 Playwright e2e。
- DB 重度目录跑测试显式加 `--pool=forks`；全量跑**裸 `vitest run`**（CLI 加 `--pool=forks` 会覆盖 projects 配置）。
- 特性提交**一律不动 `package.json` 版本号**。
- UI 只用语义 token（`bg-surface-*` / `text-secondary` 等），禁标准 Tailwind 色阶、禁 inline 硬编码颜色、禁 emoji；图标用 lucide-react（16px / stroke 1.75）；状态色走 `lib/task-status.ts`。
- Token 永不写入 SQLite / JSON / 日志 / 错误详情；日志统一经 `util/redact.ts`。
- 回环服务器只 bind `127.0.0.1` 或 `localhost`，绝不 bind `0.0.0.0`。
- 迁移 forward-only：079 一次写定，后续变更追加新迁移。

## Review Focus

- **回调参数异常**：缺 `code`、`state` 不匹配、重复回调（重放）、路径不符——必须拒绝且不消耗流程状态；用户应看到明确中文原因，而不是静默超时。
- **固定回调端口冲突**：`EADDRINUSE` 必须报 `redirect_port_in_use` 且不静默回落随机（否则 redirect_uri 与 AS 注册值不一致，失败原因极难定位）。
- **刷新响应的缺省字段**：`refresh_token` 未返回（应保留旧值）、`expires_in` 缺失（应视为不过期）、`token_type` 非 Bearer（仍按 Bearer 注入并保留原值）。
- **同一连接被多个 MCP 引用**：刷新/撤销必须扇出驱逐全部引用实例，漏一个就会出现「有的服务器能用、有的不能」。
- **非 loopback 的 `http://` 端点**：包括 discovery 返回的端点，必须拒绝；用户手工填 `http://example.com` 时应得到 `insecure_endpoint`。
- **系统密钥环不可用**（Linux 无 Secret Service）：必须报 `keychain_unavailable`，不得静默降级为内存凭据。

---

## 文件结构（先锁边界）

**新增（electron）**

```
electron/src/main/util/url-guard.ts                       共享 scheme/host 判定
electron/src/main/storage/migrations/079_oauth_module.ts   新表 + mcp 两列
electron/src/main/oauth/types.ts                           对外类型 + OAuthFailure
electron/src/main/oauth/keys.ts                            keychain 键族与 token 读写
electron/src/main/oauth/store.ts                           oauth_connections CRUD
electron/src/main/oauth/presets.ts                         常用服务预设（纯常量）
electron/src/main/oauth/protocol/endpoint-guard.ts         端点准入
electron/src/main/oauth/protocol/pkce.ts                   verifier/challenge/state
electron/src/main/oauth/protocol/http.ts                   FetchLike + TLS 放宽
electron/src/main/oauth/protocol/token.ts                  交换/刷新/撤销
electron/src/main/oauth/protocol/discovery.ts              资源元数据 + AS 元数据
electron/src/main/oauth/protocol/registration.ts           DCR
electron/src/main/oauth/protocol/authorize.ts              授权 URL
electron/src/main/oauth/protocol/loopback-server.ts        一次性回环回调
electron/src/main/oauth/lifecycle.ts                       刷新调度/单飞/事件
electron/src/main/oauth/service.ts                         编排
electron/src/main/oauth/adapters/mcp.ts                    MCP 适配器
electron/src/main/oauth/ipc.handlers.ts                    oauth:* 通道
```

**修改（electron）**

```
electron/src/main/storage/migrations/index.ts      注册 079
electron/src/main/mcp/types.ts                     + oauthConnectionId / oauthEnvVar
electron/src/main/mcp/host-manager.ts              列映射 / 注入 / 扇出驱逐
electron/src/main/mcp/http-client.ts               结构化 McpHttpError
electron/src/main/resource/ipc.handlers.ts         misc:openExternal 口径
electron/src/main/agent/provider-crud.ts           复用 util/url-guard
electron/src/main/agent/provider-ipc.ts            复用 util/url-guard
electron/src/main/ipc/index.ts                     注册 oauth handlers
electron/src/main/index.ts                         启动/停止 OAuth 生命周期
electron/src/main/plugin/service-manager.ts        + ctx.oauth（P4）
electron/src/preload/index.ts                      + oauth 命名空间
```

**新增（renderer）**

```
renderer/src/components/settings/ConnectionsSettings.tsx
renderer/src/components/settings/ConnectionsSettings.test.tsx
renderer/src/components/oauth/AddConnectionDialog.tsx
renderer/src/components/oauth/AuthorizeDialog.tsx
renderer/src/components/oauth/AuthorizeDialog.test.tsx
```

**修改（renderer）**

```
renderer/src/ipc/types.d.ts                                    OAuthApiSurface + ApiSurface.oauth + MCP 字段
renderer/src/stores/settings.store.ts                          + 'connections'
renderer/src/components/settings/SettingsNav.tsx               新分类
renderer/src/components/settings/SettingsView.tsx              渲染新页
renderer/src/components/resource-library/McpConfigDialog.tsx   https 修正 + 认证区块
renderer/src/components/agent/RegisterMcpDialog.tsx            认证区块
renderer/src/components/resource-library/ResourceLibraryView.tsx  授权横幅接线
```

---

## Task 1: 共享 URL 守卫 + `misc:openExternal` 放行回环 http

**Files:**
- Create: `electron/src/main/util/url-guard.ts`
- Test: `electron/tests/util/url-guard.test.ts`
- Modify: `electron/src/main/agent/provider-crud.ts:395-398`
- Modify: `electron/src/main/agent/provider-ipc.ts:27-30`
- Modify: `electron/src/main/resource/ipc.handlers.ts:481-493`

**Interfaces:**
- Consumes: 无
- Produces: `isLoopbackHost(hostname: string): boolean`、`isHttpsOrLoopbackHttp(url: string): boolean`

- [ ] **Step 1: 写失败测试**

```ts
// electron/tests/util/url-guard.test.ts
import { describe, it, expect } from 'vitest';
import { isLoopbackHost, isHttpsOrLoopbackHttp } from '../../src/main/util/url-guard';

describe('isLoopbackHost', () => {
  it('识别四种回环写法（含大小写）', () => {
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('LOCALHOST')).toBe(true);
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('::1')).toBe(true);
    expect(isLoopbackHost('0.0.0.0')).toBe(true);
  });
  it('非回环一律 false', () => {
    expect(isLoopbackHost('example.com')).toBe(false);
    expect(isLoopbackHost('127.0.0.2')).toBe(false);
  });
});

describe('isHttpsOrLoopbackHttp', () => {
  it('https 任意主机放行', () => {
    expect(isHttpsOrLoopbackHttp('https://example.com/a')).toBe(true);
  });
  it('http 仅回环放行', () => {
    expect(isHttpsOrLoopbackHttp('http://127.0.0.1:51789/callback')).toBe(true);
    expect(isHttpsOrLoopbackHttp('http://localhost:8080/x')).toBe(true);
    expect(isHttpsOrLoopbackHttp('http://example.com/x')).toBe(false);
    expect(isHttpsOrLoopbackHttp('http://192.168.1.5:8080/x')).toBe(false);
  });
  it('非法 URL / 其他 scheme 拒绝', () => {
    expect(isHttpsOrLoopbackHttp('')).toBe(false);
    expect(isHttpsOrLoopbackHttp('ftp://127.0.0.1/x')).toBe(false);
    expect(isHttpsOrLoopbackHttp('not a url')).toBe(false);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/util/url-guard.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

```ts
// electron/src/main/util/url-guard.ts
//
// 共享 URL 准入判定（OAuth / LLM provider / MCP 三处同口径）。
// 口径：https 任意主机；http 仅回环（本地研发场景）。
// 注意：0.0.0.0 视为回环是既有语义（provider-crud 先例），但**监听**永不 bind 0.0.0.0。

export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '0.0.0.0';
}

export function isHttpsOrLoopbackHttp(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'https:') return true;
    return parsed.protocol === 'http:' && isLoopbackHost(parsed.hostname);
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: 三处调用点改用它**

`provider-crud.ts` / `provider-ipc.ts`：删除本地 `isLoopbackHost` 定义，改为

```ts
import { isLoopbackHost } from '../util/url-guard';
```

保留原有 `parsed.protocol === 'http:' && !isLoopbackHost(parsed.hostname)` 调用形态。

`resource/ipc.handlers.ts` 的 `misc:openExternal` 改为：

```ts
  ipcMain.handle('misc:openExternal', async (_evt, url: string) => {
    if (typeof url !== 'string' || url === '') {
      throw new Error('链接不能为空');
    }
    // 2026-11-10 OAuth：本地研发需要打开 http://127.0.0.1 授权页——
    // 口径统一为 https 任意 + http 仅回环（非回环 http 会明文传 token，拒绝）。
    if (!isHttpsOrLoopbackHttp(url)) {
      throw new Error('仅支持打开 https:// 或本机回环 http:// 链接');
    }
    await shell.openExternal(url);
  });
```

- [ ] **Step 5: 运行测试**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/util/url-guard.test.ts`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add electron/src/main/util/url-guard.ts electron/tests/util/url-guard.test.ts \
  electron/src/main/agent/provider-crud.ts electron/src/main/agent/provider-ipc.ts \
  electron/src/main/resource/ipc.handlers.ts
git commit -m "feat: 共享 URL 守卫 + 外链放行本机回环 http"
```

---

## Task 2: 迁移 079（新表 + MCP 两列）

**Files:**
- Create: `electron/src/main/storage/migrations/079_oauth_module.ts`
- Modify: `electron/src/main/storage/migrations/index.ts`
- Test: `electron/tests/storage/079-oauth-module.test.ts`

**Interfaces:**
- Consumes: 无
- Produces: 表 `oauth_connections`（列见 spec §6.2）、`mcp_definitions.oauth_connection_id`、`mcp_definitions.oauth_env_var`

- [ ] **Step 1: 写失败测试**

```ts
// electron/tests/storage/079-oauth-module.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';

const tmpRoot = path.join(os.tmpdir(), `ap-mig079-${Date.now()}-${process.pid}`);

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

function columns(table: string): string[] {
  const rows = getDb().prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.map((r) => r.name);
}

describe('migration 079 OAuth 模块', () => {
  it('建 oauth_connections 表且列齐全', () => {
    const cols = columns('oauth_connections');
    for (const c of [
      'id', 'provider_key', 'display_name', 'account_label', 'issuer',
      'authorization_endpoint', 'token_endpoint', 'registration_endpoint',
      'revocation_endpoint', 'userinfo_endpoint', 'client_id', 'client_auth_method',
      'scopes', 'resource', 'extra_authorize_params', 'extra_token_params',
      'redirect_host', 'redirect_port', 'allow_insecure_tls', 'status',
      'expires_at', 'last_refreshed_at', 'source', 'created_at', 'updated_at',
    ]) {
      expect(cols).toContain(c);
    }
  });

  it('mcp_definitions 增两列且存量行为 NULL', () => {
    const cols = columns('mcp_definitions');
    expect(cols).toContain('oauth_connection_id');
    expect(cols).toContain('oauth_env_var');
    getDb()
      .prepare(
        `INSERT INTO mcp_definitions (id, name, version, transport, command, args)
         VALUES ('m1', 'legacy', '1.0.0', 'stdio', 'echo', '[]')`,
      )
      .run();
    const row = getDb()
      .prepare('SELECT oauth_connection_id, oauth_env_var FROM mcp_definitions WHERE id = ?')
      .get('m1') as { oauth_connection_id: string | null; oauth_env_var: string | null };
    expect(row.oauth_connection_id).toBeNull();
    expect(row.oauth_env_var).toBeNull();
  });

  it('默认值正确（回环主机 / 未放宽 TLS / connected）', () => {
    getDb()
      .prepare(
        `INSERT INTO oauth_connections
           (id, provider_key, display_name, authorization_endpoint, token_endpoint,
            client_id, created_at, updated_at)
         VALUES ('c1', 'pk', 'GitHub', 'https://a/auth', 'https://a/token', 'cid', 'now', 'now')`,
      )
      .run();
    const row = getDb()
      .prepare(
        'SELECT redirect_host, redirect_port, allow_insecure_tls, status, client_auth_method FROM oauth_connections WHERE id = ?',
      )
      .get('c1') as Record<string, unknown>;
    expect(row.redirect_host).toBe('127.0.0.1');
    expect(row.redirect_port).toBeNull();
    expect(row.allow_insecure_tls).toBe(0);
    expect(row.status).toBe('connected');
    expect(row.client_auth_method).toBe('none');
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/storage/079-oauth-module.test.ts --pool=forks`
Expected: FAIL（表不存在）

- [ ] **Step 3: 实现迁移并注册**

```ts
// electron/src/main/storage/migrations/079_oauth_module.ts
// 公共 OAuth 模块（spec 2026-11-10）：oauth_connections 元数据表 + mcp_definitions
// 两列绑定。密文不落本表（access/refresh/client_secret 全走 keychain 门面）。
import type { Migration } from './index';

export const migration079: Migration = {
  version: 79,
  sql: `
-- OAuth 连接元数据（撤销保留行；物理删除需无引用）
CREATE TABLE IF NOT EXISTS oauth_connections (
  id                     TEXT PRIMARY KEY NOT NULL,
  provider_key           TEXT NOT NULL,
  display_name           TEXT NOT NULL,
  account_label          TEXT NOT NULL DEFAULT '',
  issuer                 TEXT,
  authorization_endpoint TEXT NOT NULL,
  token_endpoint         TEXT NOT NULL,
  registration_endpoint  TEXT,
  revocation_endpoint    TEXT,
  userinfo_endpoint      TEXT,
  client_id              TEXT NOT NULL,
  client_auth_method     TEXT NOT NULL DEFAULT 'none',
  scopes                 TEXT NOT NULL DEFAULT '',
  resource               TEXT,
  extra_authorize_params TEXT NOT NULL DEFAULT '{}',
  extra_token_params     TEXT NOT NULL DEFAULT '{}',
  redirect_host          TEXT NOT NULL DEFAULT '127.0.0.1',
  redirect_port          INTEGER,
  allow_insecure_tls     INTEGER NOT NULL DEFAULT 0,
  status                 TEXT NOT NULL DEFAULT 'connected',
  expires_at             TEXT,
  last_refreshed_at      TEXT,
  source                 TEXT NOT NULL DEFAULT 'manual',
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_oauth_connections_provider ON oauth_connections(provider_key);

-- MCP 绑定（空 = 不走 OAuth，存量行零行为变化）
ALTER TABLE mcp_definitions ADD COLUMN oauth_connection_id TEXT;
ALTER TABLE mcp_definitions ADD COLUMN oauth_env_var TEXT;
`,
};
```

`index.ts` 顶部加 import，并在 `MIGRATIONS` 数组末尾追加：

```ts
import { migration079 } from './079_oauth_module';
// …数组末尾：
  {
    // 公共 OAuth 模块（spec 2026-11-10）：oauth_connections 元数据表 +
    // mcp_definitions 绑定两列（oauth_connection_id / oauth_env_var）。
    version: migration079.version,
    sql: migration079.sql,
  },
```

- [ ] **Step 4: 运行测试**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/storage/079-oauth-module.test.ts tests/storage/db.test.ts --pool=forks`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add electron/src/main/storage/migrations/079_oauth_module.ts \
  electron/src/main/storage/migrations/index.ts \
  electron/tests/storage/079-oauth-module.test.ts
git commit -m "feat: 迁移 079 OAuth 连接表与 MCP 绑定列"
```

---

## Task 3: 类型、keychain 键族、连接 store

**Files:**
- Create: `electron/src/main/oauth/types.ts`
- Create: `electron/src/main/oauth/keys.ts`
- Create: `electron/src/main/oauth/store.ts`
- Test: `electron/tests/oauth/store.test.ts`

**Interfaces:**
- Consumes: 迁移 079 的 `oauth_connections` 表
- Produces:
  - `OAuthErrorCode`（13 值）、`class OAuthFailure extends Error { code; connectionId?; detail? }`
  - `OAuthConnection` / `OAuthConnectionInsert` / `OAuthTokenSet` / `AuthMaterial` / `AuthRequirement` / `ConnectionView`
  - `accessTokenKey(id)` / `refreshTokenKey(id)` / `clientSecretKey(id)`
  - `saveTokenSet(id, set)` / `loadTokenSet(id)` / `clearTokenSet(id)`
  - `insertConnection(input)` / `getConnection(id)` / `listConnections()` / `findReusable(providerKey)` / `updateConnection(id, patch)` / `deleteConnection(id)`

- [ ] **Step 1: 写失败测试**

```ts
// electron/tests/oauth/store.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runMigrations, closeDb } from '../../src/main/storage/db';
import { setKeychainImpl, __resetKeychainImplForTest } from '../../src/main/storage/keychain';
import {
  insertConnection, getConnection, listConnections, findReusable,
  updateConnection, deleteConnection,
} from '../../src/main/oauth/store';
import {
  accessTokenKey, refreshTokenKey, clientSecretKey,
  saveTokenSet, loadTokenSet, clearTokenSet,
} from '../../src/main/oauth/keys';

const tmpRoot = path.join(os.tmpdir(), `ap-oauth-store-${Date.now()}-${process.pid}`);
const vault = new Map<string, string>();

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  vault.clear();
  setKeychainImpl({
    setSecret: async (k, v) => { vault.set(k, v); },
    getSecret: async (k) => vault.get(k) ?? null,
    deleteSecret: async (k) => { vault.delete(k); },
  });
});

afterEach(() => {
  __resetKeychainImplForTest();
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

const base = {
  providerKey: 'https://auth.example.com|cid||repo read',
  displayName: 'Example',
  authorizationEndpoint: 'https://auth.example.com/authorize',
  tokenEndpoint: 'https://auth.example.com/token',
  clientId: 'cid',
  scopes: 'repo read',
  source: 'manual' as const,
};

describe('oauth store', () => {
  it('插入后可读，默认值正确', () => {
    const c = insertConnection(base);
    expect(c.redirectHost).toBe('127.0.0.1');
    expect(c.redirectPort).toBeNull();
    expect(c.allowInsecureTls).toBe(false);
    expect(c.status).toBe('connected');
    expect(getConnection(c.id)?.displayName).toBe('Example');
  });

  it('findReusable 只返回 connected 且未过期的连接', () => {
    const c = insertConnection({ ...base, expiresAt: new Date(Date.now() + 3600_000).toISOString() });
    expect(findReusable(base.providerKey)?.id).toBe(c.id);
    updateConnection(c.id, { status: 'needs_reauth' });
    expect(findReusable(base.providerKey)).toBeNull();
  });

  it('findReusable 对过期连接返回 null', () => {
    insertConnection({ ...base, expiresAt: new Date(Date.now() - 1000).toISOString() });
    expect(findReusable(base.providerKey)).toBeNull();
  });

  it('list 按创建时间倒序', () => {
    insertConnection({ ...base, providerKey: 'pk-a', displayName: 'A' });
    insertConnection({ ...base, providerKey: 'pk-b', displayName: 'B' });
    expect(listConnections().map((c) => c.displayName)).toEqual(['B', 'A']);
  });

  it('token 三键写入/读取/清理', async () => {
    const c = insertConnection(base);
    await saveTokenSet(c.id, {
      accessToken: 'at', refreshToken: 'rt', expiresAt: null, tokenType: 'Bearer', scope: 'repo',
    });
    expect(vault.get(accessTokenKey(c.id))).toBe('at');
    expect(vault.get(refreshTokenKey(c.id))).toBe('rt');
    expect((await loadTokenSet(c.id))?.refreshToken).toBe('rt');
    await clearTokenSet(c.id);
    expect(await loadTokenSet(c.id)).toBeNull();
  });

  it('deleteConnection 同时清密钥', async () => {
    const c = insertConnection(base);
    await saveTokenSet(c.id, {
      accessToken: 'at', refreshToken: null, expiresAt: null, tokenType: 'Bearer', scope: null,
    });
    deleteConnection(c.id);
    expect(getConnection(c.id)).toBeNull();
    expect(vault.has(accessTokenKey(c.id))).toBe(false);
    expect(vault.has(refreshTokenKey(c.id))).toBe(false);
    expect(vault.has(clientSecretKey(c.id))).toBe(false);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/oauth/store.test.ts --pool=forks`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `types.ts`**

```ts
// electron/src/main/oauth/types.ts
//
// 公共 OAuth 模块对外类型（spec 2026-11-10 §6/§15）。
// 约束：本文件不得 import 任何 electron / DB / keychain 模块（纯类型 + 错误类），
// 供 protocol/ store/ service/ 三层共用，避免循环依赖。

export type OAuthErrorCode =
  | 'needs_reauth'
  | 'authorization_pending'
  | 'authorization_cancelled'
  | 'authorization_timeout'
  | 'discovery_failed'
  | 'registration_failed'
  | 'token_exchange_failed'
  | 'refresh_failed'
  | 'no_connection'
  | 'insecure_endpoint'
  | 'redirect_port_in_use'
  | 'keychain_unavailable'
  | 'oauth_env_var_required';

export class OAuthFailure extends Error {
  constructor(
    readonly code: OAuthErrorCode,
    message: string,
    readonly connectionId?: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'OAuthFailure';
  }
}

export type OAuthConnectionStatus = 'connected' | 'needs_reauth' | 'revoked';
export type OAuthConnectionSource = 'manual' | 'mcp' | 'preset';
export type ClientAuthMethod = 'none' | 'client_secret_post' | 'client_secret_basic';

export interface OAuthConnection {
  id: string;
  providerKey: string;
  displayName: string;
  accountLabel: string;
  issuer: string | null;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint: string | null;
  revocationEndpoint: string | null;
  userinfoEndpoint: string | null;
  clientId: string;
  clientAuthMethod: ClientAuthMethod;
  scopes: string;
  resource: string | null;
  extraAuthorizeParams: Record<string, string>;
  extraTokenParams: Record<string, string>;
  redirectHost: string;
  redirectPort: number | null;
  allowInsecureTls: boolean;
  status: OAuthConnectionStatus;
  expiresAt: string | null;
  lastRefreshedAt: string | null;
  source: OAuthConnectionSource;
  createdAt: string;
  updatedAt: string;
}

export interface OAuthConnectionInsert {
  providerKey: string;
  displayName: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  clientId: string;
  accountLabel?: string;
  issuer?: string | null;
  registrationEndpoint?: string | null;
  revocationEndpoint?: string | null;
  userinfoEndpoint?: string | null;
  clientAuthMethod?: ClientAuthMethod;
  scopes?: string;
  resource?: string | null;
  extraAuthorizeParams?: Record<string, string>;
  extraTokenParams?: Record<string, string>;
  redirectHost?: string;
  redirectPort?: number | null;
  allowInsecureTls?: boolean;
  status?: OAuthConnectionStatus;
  expiresAt?: string | null;
  source?: OAuthConnectionSource;
}

export interface OAuthTokenSet {
  accessToken: string;
  refreshToken: string | null;
  /** ISO；null = 不过期 */
  expiresAt: string | null;
  tokenType: string;
  scope: string | null;
}

/** 消费方可用的认证材料（不含 accessToken 字段名） */
export interface AuthMaterial {
  headers?: Record<string, string>;
  env?: Record<string, string>;
  expiresAt?: string | null;
  connectionId: string;
}

/** 授权条件（流程中间产物；clientSecret 仅在流程内存中存在，不落库） */
export interface AuthRequirement {
  providerKey: string;
  displayName: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  issuer: string | null;
  registrationEndpoint: string | null;
  revocationEndpoint: string | null;
  userinfoEndpoint: string | null;
  clientId: string | null;
  clientSecret?: string | null;
  clientAuthMethod: ClientAuthMethod;
  scopes: string;
  resource: string | null;
  extraAuthorizeParams: Record<string, string>;
  extraTokenParams: Record<string, string>;
  redirectHost: string;
  redirectPort: number | null;
  allowInsecureTls: boolean;
  source: OAuthConnectionSource;
}

/** renderer 可见视图（永不含 token） */
export interface ConnectionView {
  id: string;
  displayName: string;
  accountLabel: string;
  status: OAuthConnectionStatus;
  scopes: string;
  expiresAt: string | null;
  source: OAuthConnectionSource;
}
```

- [ ] **Step 4: 实现 `keys.ts`**

```ts
// electron/src/main/oauth/keys.ts
//
// OAuth 密钥键族（spec §6.4）。全部经 storage/keychain 门面，绝不落 SQLite。
// 前缀 oauth. 供 findSecretKeysByPrefix('oauth.') 做整域清理。
// 过期/范围等元数据在 SQLite 行上——本层只存密文。
import { getSecret, setSecret, deleteSecret } from '../storage/keychain';
import type { OAuthTokenSet } from './types';

export function accessTokenKey(connectionId: string): string {
  return `oauth.${connectionId}.access_token`;
}
export function refreshTokenKey(connectionId: string): string {
  return `oauth.${connectionId}.refresh_token`;
}
export function clientSecretKey(connectionId: string): string {
  return `oauth.${connectionId}.client_secret`;
}

export async function saveTokenSet(connectionId: string, set: OAuthTokenSet): Promise<void> {
  await setSecret(accessTokenKey(connectionId), set.accessToken);
  if (set.refreshToken) {
    await setSecret(refreshTokenKey(connectionId), set.refreshToken);
  } else {
    await deleteSecret(refreshTokenKey(connectionId));
  }
}

export async function loadTokenSet(connectionId: string): Promise<OAuthTokenSet | null> {
  const accessToken = await getSecret(accessTokenKey(connectionId));
  if (!accessToken) return null;
  const refreshToken = await getSecret(refreshTokenKey(connectionId));
  return {
    accessToken,
    refreshToken,
    expiresAt: null, // 权威过期时间在 SQLite 行
    tokenType: 'Bearer',
    scope: null,
  };
}

export async function clearTokenSet(connectionId: string): Promise<void> {
  await deleteSecret(accessTokenKey(connectionId));
  await deleteSecret(refreshTokenKey(connectionId));
  await deleteSecret(clientSecretKey(connectionId));
}
```

- [ ] **Step 5: 实现 `store.ts`**

```ts
// electron/src/main/oauth/store.ts
//
// oauth_connections CRUD（spec §6.2）。元数据进 SQLite，密文走 keychain（keys.ts）。
// 时间戳统一 ISO 字符串；过期判定用 Date.parse（无效/空视为不过期以外的语义见下）。
import { randomUUID } from 'node:crypto';
import { getDb } from '../storage/db';
import { clearTokenSet } from './keys';
import type {
  OAuthConnection, OAuthConnectionInsert, OAuthConnectionStatus,
  ClientAuthMethod, OAuthConnectionSource,
} from './types';

interface Row {
  id: string;
  provider_key: string;
  display_name: string;
  account_label: string;
  issuer: string | null;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint: string | null;
  revocation_endpoint: string | null;
  userinfo_endpoint: string | null;
  client_id: string;
  client_auth_method: string;
  scopes: string;
  resource: string | null;
  extra_authorize_params: string;
  extra_token_params: string;
  redirect_host: string;
  redirect_port: number | null;
  allow_insecure_tls: number;
  status: string;
  expires_at: string | null;
  last_refreshed_at: string | null;
  source: string;
  created_at: string;
  updated_at: string;
}

const COLUMNS =
  'id, provider_key, display_name, account_label, issuer, authorization_endpoint, token_endpoint, ' +
  'registration_endpoint, revocation_endpoint, userinfo_endpoint, client_id, client_auth_method, ' +
  'scopes, resource, extra_authorize_params, extra_token_params, redirect_host, redirect_port, ' +
  'allow_insecure_tls, status, expires_at, last_refreshed_at, source, created_at, updated_at';

const PLACEHOLDERS = COLUMNS.split(',').map(() => '?').join(', ');

function parseRecord(raw: string): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    return parsed as Record<string, string>;
  } catch {
    return {};
  }
}

function rowToConnection(row: Row): OAuthConnection {
  return {
    id: row.id,
    providerKey: row.provider_key,
    displayName: row.display_name,
    accountLabel: row.account_label,
    issuer: row.issuer,
    authorizationEndpoint: row.authorization_endpoint,
    tokenEndpoint: row.token_endpoint,
    registrationEndpoint: row.registration_endpoint,
    revocationEndpoint: row.revocation_endpoint,
    userinfoEndpoint: row.userinfo_endpoint,
    clientId: row.client_id,
    clientAuthMethod: row.client_auth_method as ClientAuthMethod,
    scopes: row.scopes,
    resource: row.resource,
    extraAuthorizeParams: parseRecord(row.extra_authorize_params),
    extraTokenParams: parseRecord(row.extra_token_params),
    redirectHost: row.redirect_host,
    redirectPort: row.redirect_port,
    allowInsecureTls: row.allow_insecure_tls !== 0,
    status: row.status as OAuthConnectionStatus,
    expiresAt: row.expires_at,
    lastRefreshedAt: row.last_refreshed_at,
    source: row.source as OAuthConnectionSource,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function insertConnection(input: OAuthConnectionInsert): OAuthConnection {
  const now = new Date().toISOString();
  const row: Row = {
    id: randomUUID(),
    provider_key: input.providerKey,
    display_name: input.displayName,
    account_label: input.accountLabel ?? '',
    issuer: input.issuer ?? null,
    authorization_endpoint: input.authorizationEndpoint,
    token_endpoint: input.tokenEndpoint,
    registration_endpoint: input.registrationEndpoint ?? null,
    revocation_endpoint: input.revocationEndpoint ?? null,
    userinfo_endpoint: input.userinfoEndpoint ?? null,
    client_id: input.clientId,
    client_auth_method: input.clientAuthMethod ?? 'none',
    scopes: input.scopes ?? '',
    resource: input.resource ?? null,
    extra_authorize_params: JSON.stringify(input.extraAuthorizeParams ?? {}),
    extra_token_params: JSON.stringify(input.extraTokenParams ?? {}),
    redirect_host: input.redirectHost ?? '127.0.0.1',
    redirect_port: input.redirectPort ?? null,
    allow_insecure_tls: input.allowInsecureTls ? 1 : 0,
    status: input.status ?? 'connected',
    expires_at: input.expiresAt ?? null,
    last_refreshed_at: null,
    source: input.source ?? 'manual',
    created_at: now,
    updated_at: now,
  };
  getDb()
    .prepare(`INSERT INTO oauth_connections (${COLUMNS}) VALUES (${PLACEHOLDERS})`)
    .run(
      row.id, row.provider_key, row.display_name, row.account_label, row.issuer,
      row.authorization_endpoint, row.token_endpoint, row.registration_endpoint,
      row.revocation_endpoint, row.userinfo_endpoint, row.client_id, row.client_auth_method,
      row.scopes, row.resource, row.extra_authorize_params, row.extra_token_params,
      row.redirect_host, row.redirect_port, row.allow_insecure_tls, row.status,
      row.expires_at, row.last_refreshed_at, row.source, row.created_at, row.updated_at,
    );
  return rowToConnection(row);
}

export function getConnection(id: string): OAuthConnection | null {
  const row = getDb()
    .prepare(`SELECT ${COLUMNS} FROM oauth_connections WHERE id = ?`)
    .get(id) as Row | undefined;
  return row ? rowToConnection(row) : null;
}

export function listConnections(): OAuthConnection[] {
  const rows = getDb()
    .prepare(`SELECT ${COLUMNS} FROM oauth_connections ORDER BY created_at DESC, id DESC`)
    .all() as Row[];
  return rows.map(rowToConnection);
}

/** 复用检查：同 provider_key、connected、未过期（null expires_at 视为不过期） */
export function findReusable(providerKey: string): OAuthConnection | null {
  const row = getDb()
    .prepare(
      `SELECT ${COLUMNS} FROM oauth_connections
       WHERE provider_key = ? AND status = 'connected'
       ORDER BY created_at DESC, id DESC LIMIT 1`,
    )
    .get(providerKey) as Row | undefined;
  if (!row) return null;
  if (row.expires_at && Date.parse(row.expires_at) <= Date.now()) return null;
  return rowToConnection(row);
}

const PATCHABLE = {
  status: 'status',
  expiresAt: 'expires_at',
  lastRefreshedAt: 'last_refreshed_at',
  accountLabel: 'account_label',
  clientId: 'client_id',
  registrationEndpoint: 'registration_endpoint',
  revocationEndpoint: 'revocation_endpoint',
  userinfoEndpoint: 'userinfo_endpoint',
  clientAuthMethod: 'client_auth_method',
} as const;

type Patch = Partial<Pick<OAuthConnection,
  'status' | 'expiresAt' | 'lastRefreshedAt' | 'accountLabel' | 'clientId' |
  'registrationEndpoint' | 'revocationEndpoint' | 'userinfoEndpoint' | 'clientAuthMethod'>>;

export function updateConnection(id: string, patch: Patch): void {
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const [key, column] of Object.entries(PATCHABLE)) {
    const value = patch[key as keyof Patch];
    if (value === undefined) continue;
    sets.push(`${column} = ?`);
    values.push(value);
  }
  sets.push('updated_at = ?');
  values.push(new Date().toISOString());
  values.push(id);
  getDb().prepare(`UPDATE oauth_connections SET ${sets.join(', ')} WHERE id = ?`).run(...values);
}

/** 物理删除（调用前必须已确认无引用——service.removeConnection 负责阻断） */
export function deleteConnection(id: string): void {
  getDb().prepare('DELETE FROM oauth_connections WHERE id = ?').run(id);
  // 跨存储无法原子：先删行再清密钥，失败只留孤儿密钥（无害）
  void clearTokenSet(id).catch(() => undefined);
}
```

- [ ] **Step 6: 运行测试**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/oauth/store.test.ts --pool=forks`
Expected: PASS

- [ ] **Step 7: 提交**

```bash
git add electron/src/main/oauth/types.ts electron/src/main/oauth/keys.ts \
  electron/src/main/oauth/store.ts electron/tests/oauth/store.test.ts
git commit -m "feat: OAuth 类型、keychain 键族与连接 store"
```

---

## Task 4: PKCE 与端点准入

**Files:**
- Create: `electron/src/main/oauth/protocol/pkce.ts`
- Create: `electron/src/main/oauth/protocol/endpoint-guard.ts`
- Test: `electron/tests/oauth/pkce.test.ts`
- Test: `electron/tests/oauth/endpoint-guard.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `isHttpsOrLoopbackHttp`；Task 3 的 `OAuthFailure`
- Produces:
  - `createVerifier(): string`、`challengeFor(verifier: string): string`、`createPkcePair(): { verifier; challenge }`、`createState(): string`
  - `assertEndpointAllowed(url: string): void`（失败抛 `OAuthFailure('insecure_endpoint')`）

- [ ] **Step 1: 写失败测试**

```ts
// electron/tests/oauth/pkce.test.ts
import { describe, it, expect } from 'vitest';
import { challengeFor, createPkcePair, createState } from '../../src/main/oauth/protocol/pkce';

describe('pkce', () => {
  it('匹配 RFC 7636 附录 B 向量', () => {
    expect(challengeFor('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
  });
  it('生成 43 字符 base64url verifier 与对应 challenge', () => {
    const { verifier, challenge } = createPkcePair();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(challenge).toBe(challengeFor(verifier));
  });
  it('state 每次不同且 URL 安全', () => {
    const a = createState();
    const b = createState();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});
```

```ts
// electron/tests/oauth/endpoint-guard.test.ts
import { describe, it, expect } from 'vitest';
import { assertEndpointAllowed } from '../../src/main/oauth/protocol/endpoint-guard';
import { OAuthFailure } from '../../src/main/oauth/types';

describe('assertEndpointAllowed', () => {
  it('https 任意主机通过', () => {
    expect(() => assertEndpointAllowed('https://auth.example.com/token')).not.toThrow();
  });
  it('http 回环通过', () => {
    expect(() => assertEndpointAllowed('http://127.0.0.1:8080/token')).not.toThrow();
    expect(() => assertEndpointAllowed('http://localhost:8080/token')).not.toThrow();
  });
  it('非回环 http 抛 insecure_endpoint', () => {
    try {
      assertEndpointAllowed('http://example.com/token');
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(OAuthFailure);
      expect((err as OAuthFailure).code).toBe('insecure_endpoint');
    }
  });
  it('非法 URL / 其他 scheme 抛 insecure_endpoint', () => {
    expect(() => assertEndpointAllowed('ftp://127.0.0.1/x')).toThrow(OAuthFailure);
    expect(() => assertEndpointAllowed('not a url')).toThrow(OAuthFailure);
    expect(() => assertEndpointAllowed('')).toThrow(OAuthFailure);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/oauth/pkce.test.ts tests/oauth/endpoint-guard.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

```ts
// electron/src/main/oauth/protocol/pkce.ts
//
// RFC 7636 PKCE（S256）+ OAuth state。随机源 node:crypto。
import { createHash, randomBytes } from 'node:crypto';

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** 32 字节随机 → 43 字符 base64url（RFC 7636 §4.1 允许 43-128） */
export function createVerifier(): string {
  return base64url(randomBytes(32));
}

export function challengeFor(verifier: string): string {
  return base64url(createHash('sha256').update(verifier).digest());
}

export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = createVerifier();
  return { verifier, challenge: challengeFor(verifier) };
}

/** 16 字节随机 base64url（CSRF 防护） */
export function createState(): string {
  return base64url(randomBytes(16));
}
```

```ts
// electron/src/main/oauth/protocol/endpoint-guard.ts
//
// 端点准入（spec §7.1/§10）：https 任意；http 仅回环。作用于用户配置端点与
// **discovery 返回的端点**——防远程 MCP 用 WWW-Authenticate 把用户引向明文 AS。
import { isHttpsOrLoopbackHttp } from '../../util/url-guard';
import { OAuthFailure } from '../types';

export function assertEndpointAllowed(url: string): void {
  if (!isHttpsOrLoopbackHttp(url)) {
    throw new OAuthFailure(
      'insecure_endpoint',
      '授权端点必须使用 https://（本机回环地址可用 http://）',
      undefined,
      url,
    );
  }
}
```

- [ ] **Step 4: 运行测试**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/oauth/pkce.test.ts tests/oauth/endpoint-guard.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add electron/src/main/oauth/protocol/pkce.ts \
  electron/src/main/oauth/protocol/endpoint-guard.ts \
  electron/tests/oauth/pkce.test.ts electron/tests/oauth/endpoint-guard.test.ts
git commit -m "feat: PKCE 与 OAuth 端点准入"
```

---

## Task 5: HTTP 通道与 token 交换/刷新/撤销

**Files:**
- Create: `electron/src/main/oauth/protocol/http.ts`
- Create: `electron/src/main/oauth/protocol/token.ts`
- Test: `electron/tests/oauth/token.test.ts`

**Interfaces:**
- Consumes: Task 3 `OAuthTokenSet` / `OAuthFailure` / `ClientAuthMethod`；Task 4 `assertEndpointAllowed`
- Produces:
  - `interface FetchInit { method?; headers?; body?; signal?; dispatcher? }`、`type FetchLike`
  - `resolveFetch(allowInsecureTls: boolean): FetchLike`
  - `exchangeCode(req): Promise<OAuthTokenSet>`、`refreshTokens(req): Promise<OAuthTokenSet>`、`revokeToken(req): Promise<void>`

- [ ] **Step 1: 写失败测试（真实本地 HTTP fixture，不 mock fetch）**

```ts
// electron/tests/oauth/token.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { exchangeCode, refreshTokens, revokeToken } from '../../src/main/oauth/protocol/token';

let server: http.Server;
let base = '';
let lastBody = '';
let lastAuth = '';
let respond: { status: number; body: unknown } = { status: 200, body: {} };

beforeEach(async () => {
  lastBody = '';
  lastAuth = '';
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += String(c); });
    req.on('end', () => {
      lastBody = body;
      lastAuth = req.headers.authorization ?? '';
      res.writeHead(respond.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(respond.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const exchangeReq = {
  tokenEndpoint: '',
  clientId: 'cid',
  clientAuthMethod: 'none' as const,
  code: 'the-code',
  codeVerifier: 'the-verifier',
  redirectUri: 'http://127.0.0.1:51789/callback',
  extraParams: {},
  allowInsecureTls: false,
};

describe('exchangeCode', () => {
  it('发 form-urlencoded 并解析响应（含 expires_in → 本地 ISO）', async () => {
    respond = {
      status: 200,
      body: { access_token: 'at', refresh_token: 'rt', expires_in: 3600, token_type: 'Bearer', scope: 'repo' },
    };
    const set = await exchangeCode({ ...exchangeReq, tokenEndpoint: `${base}/token` });
    expect(lastBody).toContain('grant_type=authorization_code');
    expect(lastBody).toContain('code=the-code');
    expect(lastBody).toContain('code_verifier=the-verifier');
    expect(lastBody).toContain('client_id=cid');
    expect(set.accessToken).toBe('at');
    expect(set.refreshToken).toBe('rt');
    expect(set.tokenType).toBe('Bearer');
    expect(set.scope).toBe('repo');
    expect(set.expiresAt).not.toBeNull();
  });

  it('client_secret_post 把 secret 放 body', async () => {
    respond = { status: 200, body: { access_token: 'at' } };
    await exchangeCode({
      ...exchangeReq, tokenEndpoint: `${base}/token`,
      clientAuthMethod: 'client_secret_post', clientSecret: 'sec',
    });
    expect(lastBody).toContain('client_secret=sec');
  });

  it('client_secret_basic 用 Authorization 头且做 URL 编码', async () => {
    respond = { status: 200, body: { access_token: 'at' } };
    await exchangeCode({
      ...exchangeReq, tokenEndpoint: `${base}/token`,
      clientAuthMethod: 'client_secret_basic', clientSecret: 's c',
    });
    expect(lastAuth.startsWith('Basic ')).toBe(true);
    expect(Buffer.from(lastAuth.slice(6), 'base64').toString()).toBe('cid:s%20c');
  });

  it('缺 access_token 抛 token_exchange_failed', async () => {
    respond = { status: 200, body: { token_type: 'Bearer' } };
    await expect(exchangeCode({ ...exchangeReq, tokenEndpoint: `${base}/token` }))
      .rejects.toMatchObject({ code: 'token_exchange_failed' });
  });

  it('400 + invalid_grant 抛 token_exchange_failed 且 detail 带错误码', async () => {
    respond = { status: 400, body: { error: 'invalid_grant', error_description: 'bad code' } };
    await expect(exchangeCode({ ...exchangeReq, tokenEndpoint: `${base}/token` }))
      .rejects.toMatchObject({ code: 'token_exchange_failed', detail: 'invalid_grant' });
  });
});

describe('refreshTokens', () => {
  const refreshReq = {
    tokenEndpoint: '',
    clientId: 'cid',
    clientAuthMethod: 'none' as const,
    refreshToken: 'rt-old',
    extraParams: {},
    allowInsecureTls: false,
  };

  it('grant_type=refresh_token；响应无 refresh_token 时返回 null（调用方保留旧值）', async () => {
    respond = { status: 200, body: { access_token: 'at2', expires_in: 60 } };
    const set = await refreshTokens({ ...refreshReq, tokenEndpoint: `${base}/token` });
    expect(lastBody).toContain('grant_type=refresh_token');
    expect(lastBody).toContain('refresh_token=rt-old');
    expect(set.accessToken).toBe('at2');
    expect(set.refreshToken).toBeNull();
  });

  it('invalid_grant 抛 needs_reauth', async () => {
    respond = { status: 400, body: { error: 'invalid_grant' } };
    await expect(refreshTokens({ ...refreshReq, tokenEndpoint: `${base}/token` }))
      .rejects.toMatchObject({ code: 'needs_reauth' });
  });

  it('5xx 抛 refresh_failed（可重试）', async () => {
    respond = { status: 503, body: {} };
    await expect(refreshTokens({ ...refreshReq, tokenEndpoint: `${base}/token` }))
      .rejects.toMatchObject({ code: 'refresh_failed' });
  });
});

describe('revokeToken', () => {
  it('POST token 到撤销端点', async () => {
    respond = { status: 200, body: {} };
    await revokeToken({
      revocationEndpoint: `${base}/revoke`, token: 'at', tokenTypeHint: 'access_token',
      clientId: 'cid', clientAuthMethod: 'none', allowInsecureTls: false,
    });
    expect(lastBody).toContain('token=at');
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/oauth/token.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `http.ts`**

```ts
// electron/src/main/oauth/protocol/http.ts
//
// OAuth 出站 HTTP 通道。默认全局 fetch；allowInsecureTls（仅回环连接可开）时用
// 独立 undici Agent 关闭证书校验——作用域仅该连接的 OAuth 请求，不碰全局，
// 也不影响 MCP 自身 fetch（spec §7.2）。
import { Agent } from 'undici';

export interface FetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
  dispatcher?: unknown;
}

export type FetchLike = (url: string, init: FetchInit) => Promise<Response>;

let insecureAgent: Agent | null = null;

export const defaultFetch: FetchLike = (url, init) => fetch(url, init as RequestInit);

function insecureFetch(url: string, init: FetchInit): Promise<Response> {
  if (!insecureAgent) {
    insecureAgent = new Agent({ connect: { rejectUnauthorized: false } });
  }
  return fetch(url, { ...(init as RequestInit), dispatcher: insecureAgent } as RequestInit);
}

export function resolveFetch(allowInsecureTls: boolean): FetchLike {
  return allowInsecureTls ? insecureFetch : defaultFetch;
}
```

- [ ] **Step 4: 实现 `token.ts`**

```ts
// electron/src/main/oauth/protocol/token.ts
//
// RFC 6749 token 端点：授权码交换 / refresh / revoke。
// 响应归一为 OAuthTokenSet；错误归一为 OAuthFailure（refresh 的 invalid_grant
// 直接映射 needs_reauth，供生命周期置位）。
import { OAuthFailure, type ClientAuthMethod, type OAuthTokenSet } from '../types';
import { assertEndpointAllowed } from './endpoint-guard';
import { resolveFetch, type FetchLike } from './http';

const TIMEOUT_MS = 30_000;

interface TokenRequestBase {
  tokenEndpoint: string;
  clientId: string;
  clientAuthMethod: ClientAuthMethod;
  clientSecret?: string | null;
  extraParams: Record<string, string>;
  allowInsecureTls: boolean;
  fetchImpl?: FetchLike;
}

export interface ExchangeCodeRequest extends TokenRequestBase {
  code: string;
  codeVerifier: string;
  redirectUri: string;
}

export interface RefreshRequest extends TokenRequestBase {
  refreshToken: string;
}

export interface RevokeRequest {
  revocationEndpoint: string;
  token: string;
  tokenTypeHint: 'access_token' | 'refresh_token';
  clientId: string;
  clientAuthMethod: ClientAuthMethod;
  clientSecret?: string | null;
  allowInsecureTls: boolean;
  fetchImpl?: FetchLike;
}

interface TokenResponseShape {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  token_type?: unknown;
  scope?: unknown;
  error?: unknown;
  error_description?: unknown;
}

function applyClientAuth(
  method: ClientAuthMethod,
  body: URLSearchParams,
  headers: Record<string, string>,
  clientId: string,
  clientSecret?: string | null,
): void {
  if (method === 'none') {
    body.set('client_id', clientId);
    return;
  }
  if (method === 'client_secret_post') {
    body.set('client_id', clientId);
    body.set('client_secret', clientSecret ?? '');
    return;
  }
  // client_secret_basic：id/secret 先 URL 编码再拼（RFC 6749 §2.3.1）
  const pair = `${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret ?? '')}`;
  headers.Authorization = `Basic ${Buffer.from(pair).toString('base64')}`;
}

function parseTokenResponse(
  status: number,
  raw: TokenResponseShape,
  failureCode: 'token_exchange_failed' | 'refresh_failed',
): OAuthTokenSet {
  const error = typeof raw.error === 'string' ? raw.error : null;
  if (status >= 400 || error) {
    const code = failureCode === 'refresh_failed' && error === 'invalid_grant'
      ? 'needs_reauth'
      : failureCode;
    const description = typeof raw.error_description === 'string' ? raw.error_description : undefined;
    throw new OAuthFailure(
      code,
      description ?? `令牌端点返回 ${status}`,
      undefined,
      error ?? String(status),
    );
  }
  if (typeof raw.access_token !== 'string' || raw.access_token === '') {
    throw new OAuthFailure(failureCode, '令牌端点响应缺少 access_token');
  }
  const expiresIn = typeof raw.expires_in === 'number' ? raw.expires_in : null;
  return {
    accessToken: raw.access_token,
    refreshToken:
      typeof raw.refresh_token === 'string' && raw.refresh_token !== '' ? raw.refresh_token : null,
    expiresAt: expiresIn === null ? null : new Date(Date.now() + expiresIn * 1000).toISOString(),
    tokenType: typeof raw.token_type === 'string' && raw.token_type !== '' ? raw.token_type : 'Bearer',
    scope: typeof raw.scope === 'string' ? raw.scope : null,
  };
}

async function postForm(
  url: string,
  body: URLSearchParams,
  headers: Record<string, string>,
  fetchImpl: FetchLike,
): Promise<{ status: number; json: TokenResponseShape }> {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: {
      ...headers,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: body.toString(),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await response.text();
  let json: TokenResponseShape = {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === 'object' && parsed !== null) json = parsed as TokenResponseShape;
  } catch {
    // 非 JSON 响应：交给状态码分支统一报错
  }
  return { status: response.status, json };
}

export async function exchangeCode(req: ExchangeCodeRequest): Promise<OAuthTokenSet> {
  assertEndpointAllowed(req.tokenEndpoint);
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: req.code,
    code_verifier: req.codeVerifier,
    redirect_uri: req.redirectUri,
  });
  const headers: Record<string, string> = {};
  applyClientAuth(req.clientAuthMethod, body, headers, req.clientId, req.clientSecret);
  for (const [k, v] of Object.entries(req.extraParams)) body.set(k, v);
  const { status, json } = await postForm(
    req.tokenEndpoint, body, headers, req.fetchImpl ?? resolveFetch(req.allowInsecureTls),
  );
  return parseTokenResponse(status, json, 'token_exchange_failed');
}

export async function refreshTokens(req: RefreshRequest): Promise<OAuthTokenSet> {
  assertEndpointAllowed(req.tokenEndpoint);
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: req.refreshToken,
  });
  const headers: Record<string, string> = {};
  applyClientAuth(req.clientAuthMethod, body, headers, req.clientId, req.clientSecret);
  for (const [k, v] of Object.entries(req.extraParams)) body.set(k, v);
  const { status, json } = await postForm(
    req.tokenEndpoint, body, headers, req.fetchImpl ?? resolveFetch(req.allowInsecureTls),
  );
  return parseTokenResponse(status, json, 'refresh_failed');
}

/** 撤销：尽力而为，失败吞掉（spec §11） */
export async function revokeToken(req: RevokeRequest): Promise<void> {
  try {
    assertEndpointAllowed(req.revocationEndpoint);
    const body = new URLSearchParams({ token: req.token, token_type_hint: req.tokenTypeHint });
    const headers: Record<string, string> = {};
    applyClientAuth(req.clientAuthMethod, body, headers, req.clientId, req.clientSecret);
    await postForm(
      req.revocationEndpoint, body, headers, req.fetchImpl ?? resolveFetch(req.allowInsecureTls),
    );
  } catch {
    // 撤销失败不阻塞断开主流程
  }
}
```

- [ ] **Step 5: 运行测试**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/oauth/token.test.ts`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add electron/src/main/oauth/protocol/http.ts electron/src/main/oauth/protocol/token.ts \
  electron/tests/oauth/token.test.ts
git commit -m "feat: OAuth token 交换/刷新/撤销与出站通道"
```

---

## Task 6: 发现（资源元数据 + 授权服务器元数据）

**Files:**
- Create: `electron/src/main/oauth/protocol/discovery.ts`
- Test: `electron/tests/oauth/discovery.test.ts`

**Interfaces:**
- Consumes: Task 4 `assertEndpointAllowed`；Task 5 `FetchLike` / `resolveFetch`
- Produces:
  - `parseResourceMetadataUrl(wwwAuthenticate: string): string | null`
  - `discoverAuthorizationServer(issuerUrl: string, fetchImpl?): Promise<AuthServerMetadata>`
  - `discoverForResource(resourceUrl: string, wwwAuthenticate: string | null, fetchImpl?): Promise<AuthServerMetadata>`
  - `interface AuthServerMetadata { issuer; authorizationEndpoint; tokenEndpoint; registrationEndpoint; revocationEndpoint; userinfoEndpoint; scopesSupported }`

- [ ] **Step 1: 写失败测试**

```ts
// electron/tests/oauth/discovery.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  parseResourceMetadataUrl, discoverAuthorizationServer, discoverForResource,
} from '../../src/main/oauth/protocol/discovery';

let server: http.Server;
let base = '';
let routes: Record<string, unknown> = {};

beforeEach(async () => {
  routes = {};
  server = http.createServer((req, res) => {
    const hit = routes[req.url ?? '/'];
    if (hit === undefined) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{}');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(hit));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('parseResourceMetadataUrl', () => {
  it('解析带引号的 resource_metadata', () => {
    expect(
      parseResourceMetadataUrl('Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource"'),
    ).toBe('https://mcp.example.com/.well-known/oauth-protected-resource');
  });
  it('无该参数返回 null', () => {
    expect(parseResourceMetadataUrl('Bearer realm="x"')).toBeNull();
    expect(parseResourceMetadataUrl('')).toBeNull();
  });
});

describe('discoverAuthorizationServer', () => {
  it('优先 RFC 8414 路径，校验 issuer 一致', async () => {
    routes['/.well-known/oauth-authorization-server'] = {
      issuer: base,
      authorization_endpoint: `${base}/authorize`,
      token_endpoint: `${base}/token`,
      registration_endpoint: `${base}/register`,
      scopes_supported: ['repo', 'read'],
    };
    const meta = await discoverAuthorizationServer(base);
    expect(meta.authorizationEndpoint).toBe(`${base}/authorize`);
    expect(meta.registrationEndpoint).toBe(`${base}/register`);
    expect(meta.scopesSupported).toEqual(['repo', 'read']);
  });

  it('RFC 8414 404 时回退 OIDC 发现', async () => {
    routes['/.well-known/openid-configuration'] = {
      issuer: base,
      authorization_endpoint: `${base}/oauth2/auth`,
      token_endpoint: `${base}/oauth2/token`,
    };
    const meta = await discoverAuthorizationServer(base);
    expect(meta.tokenEndpoint).toBe(`${base}/oauth2/token`);
  });

  it('issuer 与来源不一致抛 discovery_failed', async () => {
    routes['/.well-known/oauth-authorization-server'] = {
      issuer: 'https://evil.example.com',
      authorization_endpoint: `${base}/authorize`,
      token_endpoint: `${base}/token`,
    };
    await expect(discoverAuthorizationServer(base)).rejects.toMatchObject({ code: 'discovery_failed' });
  });

  it('两条路径都 404 抛 discovery_failed', async () => {
    await expect(discoverAuthorizationServer(base)).rejects.toMatchObject({ code: 'discovery_failed' });
  });

  it('元数据里的非回环 http 端点被拒（insecure_endpoint）', async () => {
    routes['/.well-known/oauth-authorization-server'] = {
      issuer: base,
      authorization_endpoint: 'http://example.com/authorize',
      token_endpoint: `${base}/token`,
    };
    await expect(discoverAuthorizationServer(base)).rejects.toMatchObject({ code: 'insecure_endpoint' });
  });
});

describe('discoverForResource', () => {
  it('经 WWW-Authenticate 资源元数据找到 AS', async () => {
    routes['/.well-known/oauth-protected-resource'] = { authorization_servers: [base] };
    routes['/.well-known/oauth-authorization-server'] = {
      issuer: base,
      authorization_endpoint: `${base}/authorize`,
      token_endpoint: `${base}/token`,
    };
    const meta = await discoverForResource(
      `${base}/mcp`,
      `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`,
    );
    expect(meta.authorizationEndpoint).toBe(`${base}/authorize`);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/oauth/discovery.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

```ts
// electron/src/main/oauth/protocol/discovery.ts
//
// OAuth 发现（spec §7.2）：
//   1. 401 WWW-Authenticate 的 resource_metadata（RFC 9728）
//   2. 资源元数据的 authorization_servers[]
//   3. 每个 issuer：/.well-known/oauth-authorization-server（RFC 8414）
//      回退 /.well-known/openid-configuration（OIDC）
//   4. issuer 字段必须与来源一致（RFC 8414 §3.3）
// 所有端点（含发现结果）过 assertEndpointAllowed。
import { assertEndpointAllowed } from './endpoint-guard';
import { resolveFetch, type FetchLike } from './http';
import { OAuthFailure } from '../types';

const TIMEOUT_MS = 30_000;

export interface AuthServerMetadata {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint: string | null;
  revocationEndpoint: string | null;
  userinfoEndpoint: string | null;
  scopesSupported: string[];
}

interface ResourceMetadataShape {
  authorization_servers?: unknown;
}

interface AsMetadataShape {
  issuer?: unknown;
  authorization_endpoint?: unknown;
  token_endpoint?: unknown;
  registration_endpoint?: unknown;
  revocation_endpoint?: unknown;
  userinfo_endpoint?: unknown;
  scopes_supported?: unknown;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function trimTrailingSlash(url: string): string {
  return url.replace(/\/$/, '');
}

/** WWW-Authenticate 里取 resource_metadata="…"（容忍无引号） */
export function parseResourceMetadataUrl(wwwAuthenticate: string): string | null {
  const match = /resource_metadata\s*=\s*"?([^"\s,]+)"?/i.exec(wwwAuthenticate);
  return match ? match[1] : null;
}

async function getJson(url: string, fetchImpl: FetchLike): Promise<unknown | null> {
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) return null;
    return JSON.parse(await response.text()) as unknown;
  } catch {
    return null;
  }
}

export async function discoverAuthorizationServer(
  issuerUrl: string,
  fetchImpl?: FetchLike,
): Promise<AuthServerMetadata> {
  const issuer = trimTrailingSlash(issuerUrl);
  const fetchFn = fetchImpl ?? resolveFetch(issuer.startsWith('http://'));
  const candidates = [
    `${issuer}/.well-known/oauth-authorization-server`,
    `${issuer}/.well-known/openid-configuration`,
  ];
  for (const candidate of candidates) {
    const raw = await getJson(candidate, fetchFn);
    if (raw === null) continue;
    const data = raw as AsMetadataShape;
    const declaredIssuer = asString(data.issuer);
    const authorizationEndpoint = asString(data.authorization_endpoint);
    const tokenEndpoint = asString(data.token_endpoint);
    if (!declaredIssuer || !authorizationEndpoint || !tokenEndpoint) continue;
    if (trimTrailingSlash(declaredIssuer) !== issuer) {
      throw new OAuthFailure(
        'discovery_failed', '授权服务器元数据 issuer 与来源不一致', undefined, declaredIssuer,
      );
    }
    // 发现结果同样过准入——防被恶意资源元数据引向明文 AS
    assertEndpointAllowed(authorizationEndpoint);
    assertEndpointAllowed(tokenEndpoint);
    const registrationEndpoint = asString(data.registration_endpoint);
    const revocationEndpoint = asString(data.revocation_endpoint);
    const userinfoEndpoint = asString(data.userinfo_endpoint);
    if (registrationEndpoint) assertEndpointAllowed(registrationEndpoint);
    if (revocationEndpoint) assertEndpointAllowed(revocationEndpoint);
    if (userinfoEndpoint) assertEndpointAllowed(userinfoEndpoint);
    return {
      issuer: declaredIssuer,
      authorizationEndpoint,
      tokenEndpoint,
      registrationEndpoint,
      revocationEndpoint,
      userinfoEndpoint,
      scopesSupported: Array.isArray(data.scopes_supported)
        ? data.scopes_supported.filter((s): s is string => typeof s === 'string')
        : [],
    };
  }
  throw new OAuthFailure('discovery_failed', `无法发现授权服务器：${issuer}`);
}

export async function discoverForResource(
  resourceUrl: string,
  wwwAuthenticate: string | null,
  fetchImpl?: FetchLike,
): Promise<AuthServerMetadata> {
  const fetchFn = fetchImpl ?? resolveFetch(resourceUrl.startsWith('http://'));
  const metadataUrl = wwwAuthenticate ? parseResourceMetadataUrl(wwwAuthenticate) : null;
  const candidates = metadataUrl
    ? [metadataUrl]
    : [`${trimTrailingSlash(resourceUrl)}/.well-known/oauth-protected-resource`];
  for (const candidate of candidates) {
    assertEndpointAllowed(candidate);
    const raw = await getJson(candidate, fetchFn);
    if (raw === null) continue;
    const servers = (raw as ResourceMetadataShape).authorization_servers;
    if (!Array.isArray(servers)) continue;
    for (const server of servers) {
      if (typeof server !== 'string' || server === '') continue;
      assertEndpointAllowed(server);
      try {
        return await discoverAuthorizationServer(server, fetchFn);
      } catch {
        // 该 issuer 不可用，继续下一个
      }
    }
  }
  throw new OAuthFailure('discovery_failed', '无法从资源元数据发现授权服务器');
}
```

- [ ] **Step 4: 运行测试**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/oauth/discovery.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add electron/src/main/oauth/protocol/discovery.ts electron/tests/oauth/discovery.test.ts
git commit -m "feat: OAuth 资源元数据与授权服务器发现"
```

---

## Task 7: 动态客户端注册 + 授权 URL 构造

**Files:**
- Create: `electron/src/main/oauth/protocol/registration.ts`
- Create: `electron/src/main/oauth/protocol/authorize.ts`
- Test: `electron/tests/oauth/registration.test.ts`

**Interfaces:**
- Consumes: Task 4 `assertEndpointAllowed`；Task 5 `FetchLike` / `resolveFetch`
- Produces:
  - `registerClient(req): Promise<{ clientId: string; clientSecret: string | null; authMethod: ClientAuthMethod }>`
  - `buildAuthorizationUrl(req): string`

- [ ] **Step 1: 写失败测试**

```ts
// electron/tests/oauth/registration.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { registerClient } from '../../src/main/oauth/protocol/registration';
import { buildAuthorizationUrl } from '../../src/main/oauth/protocol/authorize';

let server: http.Server;
let base = '';
let lastBody: Record<string, unknown> = {};
let respond: { status: number; body: unknown } = { status: 201, body: {} };

beforeEach(async () => {
  lastBody = {};
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += String(c); });
    req.on('end', () => {
      lastBody = JSON.parse(body || '{}') as Record<string, unknown>;
      res.writeHead(respond.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(respond.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('registerClient', () => {
  it('POST 注册并解析 client_id / secret / auth method', async () => {
    respond = {
      status: 201,
      body: { client_id: 'dcr-1', client_secret: 's', token_endpoint_auth_method: 'client_secret_post' },
    };
    const result = await registerClient({
      registrationEndpoint: `${base}/register`,
      redirectUris: ['http://127.0.0.1:51789/callback'],
      clientName: 'Momo Studio',
      scopes: 'repo read',
      allowInsecureTls: false,
    });
    expect(lastBody.redirect_uris).toEqual(['http://127.0.0.1:51789/callback']);
    expect(lastBody.client_name).toBe('Momo Studio');
    expect(lastBody.grant_types).toEqual(['authorization_code', 'refresh_token']);
    expect(result).toEqual({ clientId: 'dcr-1', clientSecret: 's', authMethod: 'client_secret_post' });
  });

  it('缺 client_id 抛 registration_failed', async () => {
    respond = { status: 201, body: {} };
    await expect(registerClient({
      registrationEndpoint: `${base}/register`,
      redirectUris: ['http://127.0.0.1:1/callback'],
      clientName: 'Momo Studio',
      scopes: '',
      allowInsecureTls: false,
    })).rejects.toMatchObject({ code: 'registration_failed' });
  });
});

describe('buildAuthorizationUrl', () => {
  it('含必需参数与 resource/extra', () => {
    const url = buildAuthorizationUrl({
      authorizationEndpoint: 'https://a.example.com/authorize',
      clientId: 'cid',
      redirectUri: 'http://127.0.0.1:51789/callback',
      scopes: 'repo read',
      state: 'st',
      codeChallenge: 'ch',
      resource: 'https://mcp.example.com',
      extraParams: { prompt: 'consent' },
    });
    const parsed = new URL(url);
    expect(parsed.searchParams.get('response_type')).toBe('code');
    expect(parsed.searchParams.get('code_challenge_method')).toBe('S256');
    expect(parsed.searchParams.get('code_challenge')).toBe('ch');
    expect(parsed.searchParams.get('state')).toBe('st');
    expect(parsed.searchParams.get('scope')).toBe('repo read');
    expect(parsed.searchParams.get('resource')).toBe('https://mcp.example.com');
    expect(parsed.searchParams.get('prompt')).toBe('consent');
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/oauth/registration.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

```ts
// electron/src/main/oauth/protocol/registration.ts
//
// RFC 7591 动态客户端注册。桌面公共客户端（PKCE）通常拿到 authMethod='none'；
// 若服务端返回 secret 且指定了认证方式则原样保存（走 keychain）。
import { assertEndpointAllowed } from './endpoint-guard';
import { resolveFetch, type FetchLike } from './http';
import { OAuthFailure, type ClientAuthMethod } from '../types';

const TIMEOUT_MS = 30_000;

export interface RegisterClientRequest {
  registrationEndpoint: string;
  redirectUris: string[];
  clientName: string;
  scopes: string;
  allowInsecureTls: boolean;
  fetchImpl?: FetchLike;
}

export interface RegisterClientResult {
  clientId: string;
  clientSecret: string | null;
  authMethod: ClientAuthMethod;
}

function normalizeAuthMethod(raw: unknown): ClientAuthMethod {
  if (raw === 'client_secret_post' || raw === 'client_secret_basic') return raw;
  return 'none';
}

export async function registerClient(req: RegisterClientRequest): Promise<RegisterClientResult> {
  assertEndpointAllowed(req.registrationEndpoint);
  const fetchFn = req.fetchImpl ?? resolveFetch(req.allowInsecureTls);
  const payload = {
    client_name: req.clientName,
    redirect_uris: req.redirectUris,
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    ...(req.scopes ? { scope: req.scopes } : {}),
  };
  let json: Record<string, unknown> = {};
  let status = 0;
  try {
    const response = await fetchFn(req.registrationEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    status = response.status;
    const parsed: unknown = JSON.parse(await response.text());
    if (typeof parsed === 'object' && parsed !== null) json = parsed as Record<string, unknown>;
  } catch (err) {
    throw new OAuthFailure(
      'registration_failed', '动态客户端注册请求失败', undefined, (err as Error).message,
    );
  }
  const clientId = typeof json.client_id === 'string' ? json.client_id : null;
  if (!clientId) {
    throw new OAuthFailure('registration_failed', `动态客户端注册失败（HTTP ${status}）`);
  }
  return {
    clientId,
    clientSecret: typeof json.client_secret === 'string' ? json.client_secret : null,
    authMethod: normalizeAuthMethod(json.token_endpoint_auth_method),
  };
}
```

```ts
// electron/src/main/oauth/protocol/authorize.ts
//
// 授权 URL 构造（RFC 6749 §4.1.1 + PKCE + RFC 8707 resource）。
import { assertEndpointAllowed } from './endpoint-guard';

export interface BuildAuthorizationUrlRequest {
  authorizationEndpoint: string;
  clientId: string;
  redirectUri: string;
  scopes: string;
  state: string;
  codeChallenge: string;
  resource: string | null;
  extraParams: Record<string, string>;
}

export function buildAuthorizationUrl(req: BuildAuthorizationUrlRequest): string {
  assertEndpointAllowed(req.authorizationEndpoint);
  const url = new URL(req.authorizationEndpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', req.clientId);
  url.searchParams.set('redirect_uri', req.redirectUri);
  if (req.scopes) url.searchParams.set('scope', req.scopes);
  url.searchParams.set('state', req.state);
  url.searchParams.set('code_challenge', req.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  if (req.resource) url.searchParams.set('resource', req.resource);
  for (const [key, value] of Object.entries(req.extraParams)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}
```

- [ ] **Step 4: 运行测试**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/oauth/registration.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add electron/src/main/oauth/protocol/registration.ts \
  electron/src/main/oauth/protocol/authorize.ts electron/tests/oauth/registration.test.ts
git commit -m "feat: OAuth 动态客户端注册与授权 URL"
```

---

## Task 8: 回环回调服务器（真实 socket）

**Files:**
- Create: `electron/src/main/oauth/protocol/loopback-server.ts`
- Test: `electron/tests/oauth/loopback-server.test.ts`

**Interfaces:**
- Consumes: Task 3 `OAuthFailure`
- Produces:
  - `startLoopbackServer(opts): Promise<LoopbackServer>`
  - `interface LoopbackServer { readonly redirectUri: string; waitForCallback(): Promise<{ code: string }>; close(): Promise<void> }`
  - `parseManualCallback(input: string, expectedState: string): string`

- [ ] **Step 1: 写失败测试**

```ts
// electron/tests/oauth/loopback-server.test.ts
import { describe, it, expect } from 'vitest';
import { startLoopbackServer, parseManualCallback } from '../../src/main/oauth/protocol/loopback-server';
import { OAuthFailure } from '../../src/main/oauth/types';

describe('startLoopbackServer', () => {
  it('随机端口，收到正确 state 返回 code 并关闭', async () => {
    const server = await startLoopbackServer({
      host: '127.0.0.1', port: null, expectedState: 'st-1', timeoutMs: 5000,
    });
    expect(server.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    const waiting = server.waitForCallback();
    const response = await fetch(`${server.redirectUri}?code=abc&state=st-1`);
    expect(response.status).toBe(200);
    await expect(waiting).resolves.toEqual({ code: 'abc' });
    await server.close();
  });

  it('state 不匹配返回 400 且继续等待后续正确回调', async () => {
    const server = await startLoopbackServer({
      host: '127.0.0.1', port: null, expectedState: 'st-2', timeoutMs: 5000,
    });
    const waiting = server.waitForCallback();
    const bad = await fetch(`${server.redirectUri}?code=x&state=wrong`);
    expect(bad.status).toBe(400);
    const good = await fetch(`${server.redirectUri}?code=ok&state=st-2`);
    expect(good.status).toBe(200);
    await expect(waiting).resolves.toEqual({ code: 'ok' });
    await server.close();
  });

  it('路径不符返回 404 且不影响等待', async () => {
    const server = await startLoopbackServer({
      host: '127.0.0.1', port: null, expectedState: 'st-3', timeoutMs: 5000,
    });
    const waiting = server.waitForCallback();
    const origin = new URL(server.redirectUri).origin;
    expect((await fetch(`${origin}/other?code=x&state=st-3`)).status).toBe(404);
    await fetch(`${server.redirectUri}?code=ok&state=st-3`);
    await expect(waiting).resolves.toEqual({ code: 'ok' });
    await server.close();
  });

  it('缺 code 返回 400 并继续等待', async () => {
    const server = await startLoopbackServer({
      host: '127.0.0.1', port: null, expectedState: 'st-4', timeoutMs: 5000,
    });
    const waiting = server.waitForCallback();
    expect((await fetch(`${server.redirectUri}?state=st-4`)).status).toBe(400);
    await fetch(`${server.redirectUri}?code=ok&state=st-4`);
    await expect(waiting).resolves.toEqual({ code: 'ok' });
    await server.close();
  });

  it('超时抛 authorization_timeout', async () => {
    const server = await startLoopbackServer({
      host: '127.0.0.1', port: null, expectedState: 'st-5', timeoutMs: 50,
    });
    await expect(server.waitForCallback()).rejects.toMatchObject({ code: 'authorization_timeout' });
    await server.close();
  });

  it('固定端口被占用抛 redirect_port_in_use', async () => {
    const first = await startLoopbackServer({
      host: '127.0.0.1', port: null, expectedState: 'a', timeoutMs: 5000,
    });
    const port = Number(new URL(first.redirectUri).port);
    await expect(startLoopbackServer({
      host: '127.0.0.1', port, expectedState: 'b', timeoutMs: 5000,
    })).rejects.toMatchObject({ code: 'redirect_port_in_use' });
    await first.close();
  });
});

describe('parseManualCallback', () => {
  it('接受完整回调 URL', () => {
    expect(parseManualCallback('http://127.0.0.1:51789/callback?code=abc&state=st', 'st')).toBe('abc');
  });
  it('接受裸 code', () => {
    expect(parseManualCallback('abc', 'st')).toBe('abc');
  });
  it('state 不匹配抛 authorization_cancelled', () => {
    try {
      parseManualCallback('http://127.0.0.1:51789/callback?code=abc&state=no', 'st');
      expect.unreachable();
    } catch (err) {
      expect((err as OAuthFailure).code).toBe('authorization_cancelled');
    }
  });
  it('URL 缺 code 抛 token_exchange_failed', () => {
    expect(() => parseManualCallback('http://127.0.0.1:51789/callback?state=st', 'st'))
      .toThrow(OAuthFailure);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/oauth/loopback-server.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

```ts
// electron/src/main/oauth/protocol/loopback-server.ts
//
// 一次性回环回调服务器（RFC 8252 §7.3）。约束（spec §7.1/§10）：
//   - 只 bind 127.0.0.1 / localhost，绝不 bind 0.0.0.0
//   - 路径固定 /callback；state 不匹配 400 并继续等待（防误杀用户二次尝试）
//   - 命中后立即关连接；超时抛 authorization_timeout
//   - 固定端口 EADDRINUSE 抛 redirect_port_in_use，不静默回落随机
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { OAuthFailure } from '../types';

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const CALLBACK_PATH = '/callback';

export interface LoopbackServerOptions {
  host: string;
  port?: number | null;
  expectedState: string;
  timeoutMs?: number;
}

export interface LoopbackServer {
  readonly redirectUri: string;
  waitForCallback(): Promise<{ code: string }>;
  close(): Promise<void>;
}

const OK_HTML =
  '<!doctype html><html><body style="font-family:system-ui;padding:32px">' +
  '<h2>授权完成</h2><p>可以关闭此页面并返回 Momo Studio。</p></body></html>';

const FAIL_HTML = (reason: string): string =>
  '<!doctype html><html><body style="font-family:system-ui;padding:32px">' +
  `<h2>授权未完成</h2><p>${reason}</p></body></html>`;

export async function startLoopbackServer(opts: LoopbackServerOptions): Promise<LoopbackServer> {
  const host = opts.host === 'localhost' ? 'localhost' : '127.0.0.1';
  let settle: ((value: { code: string }) => void) | null = null;
  let fail: ((err: Error) => void) | null = null;
  let finished = false;
  let timer: NodeJS.Timeout | null = null;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
    if (url.pathname !== CALLBACK_PATH) {
      res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
      res.end(FAIL_HTML('未知回调路径'));
      return;
    }
    if (finished) {
      res.writeHead(409, { 'content-type': 'text/html; charset=utf-8' });
      res.end(FAIL_HTML('该授权请求已完成，请勿重复刷新。'));
      return;
    }
    const state = url.searchParams.get('state');
    const code = url.searchParams.get('code');
    const error = url.searchParams.get('error');
    if (error) {
      res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
      res.end(FAIL_HTML(`授权被拒绝：${error}`));
      finished = true;
      fail?.(new OAuthFailure('authorization_cancelled', `授权被拒绝：${error}`));
      return;
    }
    if (state !== opts.expectedState) {
      // state 不匹配不足以终止流程（可能是旧标签页/攻击尝试）——拒绝本次并继续等待
      res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
      res.end(FAIL_HTML('state 校验失败，请从 Momo Studio 重新发起授权。'));
      return;
    }
    if (!code) {
      res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
      res.end(FAIL_HTML('回调缺少 code 参数。'));
      return;
    }
    finished = true;
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(OK_HTML);
    settle?.({ code });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException): void => {
      if (err.code === 'EADDRINUSE') {
        reject(new OAuthFailure('redirect_port_in_use', `回调端口 ${opts.port} 已被占用`));
        return;
      }
      reject(new OAuthFailure('authorization_cancelled', `回环服务器启动失败：${err.message}`));
    };
    server.once('error', onError);
    server.listen(opts.port ?? 0, host, () => {
      server.off('error', onError);
      resolve();
    });
  });

  const address = server.address() as AddressInfo;
  const redirectUri = `http://${host}:${address.port}${CALLBACK_PATH}`;

  const close = async (): Promise<void> => {
    if (timer) clearTimeout(timer);
    timer = null;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };

  const waitForCallback = (): Promise<{ code: string }> =>
    new Promise<{ code: string }>((resolve, reject) => {
      settle = resolve;
      fail = reject;
      timer = setTimeout(() => {
        if (finished) return;
        finished = true;
        reject(new OAuthFailure('authorization_timeout', '等待授权回调超时（10 分钟）'));
      }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    }).finally(() => {
      if (timer) clearTimeout(timer);
      timer = null;
      void close();
    });

  return { redirectUri, waitForCallback, close };
}

/** 手动回调（spec §10）：接受完整回调 URL 或裸 code；state 必须匹配 */
export function parseManualCallback(input: string, expectedState: string): string {
  const trimmed = input.trim();
  if (trimmed === '') {
    throw new OAuthFailure('authorization_cancelled', '回调内容为空');
  }
  // 裸 code 形态：不含 :// 且无查询串
  if (!trimmed.includes('://') && !trimmed.includes('?')) {
    return trimmed;
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new OAuthFailure('token_exchange_failed', '无法解析回调 URL');
  }
  if (parsed.searchParams.get('state') !== expectedState) {
    throw new OAuthFailure('authorization_cancelled', 'state 校验失败，请重新发起授权');
  }
  const error = parsed.searchParams.get('error');
  if (error) {
    throw new OAuthFailure('authorization_cancelled', `授权被拒绝：${error}`);
  }
  const code = parsed.searchParams.get('code');
  if (!code) {
    throw new OAuthFailure('token_exchange_failed', '回调 URL 缺少 code 参数');
  }
  return code;
}
```

- [ ] **Step 4: 运行测试**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/oauth/loopback-server.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add electron/src/main/oauth/protocol/loopback-server.ts \
  electron/tests/oauth/loopback-server.test.ts
git commit -m "feat: OAuth 回环回调服务器与手动回调解析"
```

---

## Task 9: 预设表 + 服务编排（begin / complete / manual / disconnect / remove）

**Files:**
- Create: `electron/src/main/oauth/presets.ts`
- Create: `electron/src/main/oauth/service.ts`
- Test: `electron/tests/oauth/service.test.ts`

**Interfaces:**
- Consumes: Task 3 store/keys/types；Task 4 pkce/guard；Task 5 token；Task 6 discovery；Task 7 registration/authorize；Task 8 loopback；`mcp/host-manager.getMcpConfig`
- Produces:
  - `listPresets(): ProviderPreset[]`、`loadPreset(key: string): ManualAuthInput | null`
  - `beginAuthorization(input: BeginInput): Promise<BeginResult>`
  - `completeWithManualCallback({ pendingId, input }): Promise<ConnectionView>`
  - `cancelAuthorization(pendingId): Promise<void>`
  - `listConnectionViews()` / `getConnectionView(id)` / `disconnect(id)` / `removeConnection(id)`
  - `resolveAuthMaterial(connectionId: string, target: McpAuthTarget): Promise<AuthMaterial>`（Task 11 实现，本任务先导出 `loadConnectionForConsumer`）
  - `setOAuthChangeListener(listener | null): void`
  - `computeProviderKey(req): string`

> **依赖方向铁律**：`oauth/*` 可以 import `mcp/host-manager`（`getMcpConfig`），但 `mcp/host-manager` **绝不** import `oauth/*`——Task 13 用 setter 注入反接。

- [ ] **Step 1: 写失败测试**

```ts
// electron/tests/oauth/service.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { setKeychainImpl, __resetKeychainImplForTest } from '../../src/main/storage/keychain';
import {
  beginAuthorization, completeWithManualCallback, listConnectionViews,
  disconnect, removeConnection, setOAuthChangeListener, cancelAuthorization,
} from '../../src/main/oauth/service';

const tmpRoot = path.join(os.tmpdir(), `ap-oauth-service-${Date.now()}-${process.pid}`);
const vault = new Map<string, string>();

let server: http.Server;
let base = '';

beforeEach(async () => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  vault.clear();
  setKeychainImpl({
    setSecret: async (k, v) => { vault.set(k, v); },
    getSecret: async (k) => vault.get(k) ?? null,
    deleteSecret: async (k) => { vault.delete(k); },
  });
  setOAuthChangeListener(null);

  server = http.createServer((req, res) => {
    if (req.url === '/token') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600, token_type: 'Bearer',
      }));
      return;
    }
    if (req.url === '/userinfo') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ login: 'bearangel' }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  setOAuthChangeListener(null);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  __resetKeychainImplForTest();
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

const manual = {
  displayName: 'Local AS',
  authorizationEndpoint: '',
  tokenEndpoint: '',
  clientId: 'cid',
  scopes: 'repo',
  userinfoEndpoint: null as string | null,
  clientAuthMethod: 'none' as const,
  redirectHost: '127.0.0.1',
  redirectPort: null as number | null,
  allowInsecureTls: false,
  extraAuthorizeParams: {},
  extraTokenParams: {},
};

async function createConnection(): Promise<string> {
  const begin = await beginAuthorization({
    manual: {
      ...manual,
      authorizationEndpoint: `${base}/authorize`,
      tokenEndpoint: `${base}/token`,
    },
  });
  const state = new URL(begin.authorizationUrl!).searchParams.get('state')!;
  const view = await completeWithManualCallback({
    pendingId: begin.pendingId!,
    input: `${begin.redirectUri}?code=a&state=${state}`,
  });
  return view.id;
}

describe('manual 授权全链', () => {
  it('begin 返回授权 URL；手动回调完成并落库 + 落密钥 + userinfo 账号名', async () => {
    const begin = await beginAuthorization({
      manual: {
        ...manual,
        authorizationEndpoint: `${base}/authorize`,
        tokenEndpoint: `${base}/token`,
        userinfoEndpoint: `${base}/userinfo`,
      },
    });
    expect(begin.pendingId).toBeTruthy();
    expect(begin.authorizationUrl).toContain('/authorize?');
    expect(begin.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);

    const state = new URL(begin.authorizationUrl!).searchParams.get('state')!;
    const view = await completeWithManualCallback({
      pendingId: begin.pendingId!,
      input: `${begin.redirectUri}?code=abc&state=${state}`,
    });
    expect(view.displayName).toBe('Local AS');
    expect(view.accountLabel).toBe('bearangel');
    expect(view.status).toBe('connected');
    expect(vault.get(`oauth.${view.id}.access_token`)).toBe('at-1');
    expect(vault.get(`oauth.${view.id}.refresh_token`)).toBe('rt-1');
    expect(listConnectionViews()).toHaveLength(1);
  });

  it('同一 providerKey 第二次授权复用已有连接', async () => {
    const created = await createConnection();
    const second = await beginAuthorization({
      manual: {
        ...manual,
        authorizationEndpoint: `${base}/authorize`,
        tokenEndpoint: `${base}/token`,
      },
    });
    expect(second.existingConnectionId).toBe(created);
    expect(second.pendingId).toBeNull();
    expect(second.authorizationUrl).toBeNull();
  });

  it('state 不匹配不消耗 pending（可重试）', async () => {
    const begin = await beginAuthorization({
      manual: {
        ...manual,
        authorizationEndpoint: `${base}/authorize`,
        tokenEndpoint: `${base}/token`,
      },
    });
    await expect(completeWithManualCallback({
      pendingId: begin.pendingId!,
      input: 'http://127.0.0.1:1/callback?code=x&state=bad',
    })).rejects.toMatchObject({ code: 'authorization_cancelled' });
    const state = new URL(begin.authorizationUrl!).searchParams.get('state')!;
    const view = await completeWithManualCallback({
      pendingId: begin.pendingId!, input: `${begin.redirectUri}?code=ok&state=${state}`,
    });
    expect(view.id).toBeTruthy();
  });

  it('cancel 后 pending 不可再用', async () => {
    const begin = await beginAuthorization({
      manual: {
        ...manual,
        authorizationEndpoint: `${base}/authorize`,
        tokenEndpoint: `${base}/token`,
      },
    });
    await cancelAuthorization(begin.pendingId!);
    await expect(completeWithManualCallback({ pendingId: begin.pendingId!, input: 'abc' }))
      .rejects.toMatchObject({ code: 'authorization_cancelled' });
  });
});

describe('disconnect / removeConnection', () => {
  it('disconnect 清密钥、置 revoked、绑定保留、事件触发', async () => {
    const id = await createConnection();
    getDb()
      .prepare(`INSERT INTO mcp_definitions (id, name, version, transport, command, args, oauth_connection_id)
                VALUES ('m1', 'gh', '1.0.0', 'streamable_http', '', '[]', ?)`)
      .run(id);
    const events: string[] = [];
    setOAuthChangeListener((cid, kind) => events.push(`${cid}:${kind}`));
    const result = await disconnect(id);
    expect(result.affectedMcpNames).toEqual(['gh']);
    expect(vault.get(`oauth.${id}.access_token`)).toBeUndefined();
    expect(listConnectionViews()[0].status).toBe('revoked');
    const row = getDb().prepare('SELECT oauth_connection_id FROM mcp_definitions WHERE id = ?')
      .get('m1') as { oauth_connection_id: string };
    expect(row.oauth_connection_id).toBe(id);
    expect(events).toContain(`${id}:revoked`);
  });

  it('removeConnection 被引用时拒绝（no_connection）', async () => {
    const id = await createConnection();
    getDb()
      .prepare(`INSERT INTO mcp_definitions (id, name, version, transport, command, args, oauth_connection_id)
                VALUES ('m1', 'gh', '1.0.0', 'streamable_http', '', '[]', ?)`)
      .run(id);
    await expect(removeConnection(id)).rejects.toMatchObject({ code: 'no_connection' });
    expect(listConnectionViews()).toHaveLength(1);
  });

  it('removeConnection 无引用时彻底删除并清密钥', async () => {
    const id = await createConnection();
    expect(await removeConnection(id)).toEqual({ affectedMcpNames: [] });
    expect(listConnectionViews()).toHaveLength(0);
    expect(vault.get(`oauth.${id}.access_token`)).toBeUndefined();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/oauth/service.test.ts --pool=forks`
Expected: FAIL

- [ ] **Step 3: 实现 `presets.ts`**

```ts
// electron/src/main/oauth/presets.ts
//
// 常用服务预设（纯常量，不含密钥）。只提供端点与默认 scope；
// client_id 需用户自填（各服务要求不同，且平台无法替用户注册）。
import type { ManualAuthInput } from './service';

export interface ProviderPreset {
  key: string;
  label: string;
  input: Omit<ManualAuthInput, 'displayName'> & { displayName: string };
}

const PRESETS: ProviderPreset[] = [
  {
    key: 'github',
    label: 'GitHub',
    input: {
      displayName: 'GitHub',
      authorizationEndpoint: 'https://github.com/login/oauth/authorize',
      tokenEndpoint: 'https://github.com/login/oauth/access_token',
      clientId: '',
      clientAuthMethod: 'client_secret_post',
      scopes: 'read:user',
      userinfoEndpoint: 'https://api.github.com/user',
      extraAuthorizeParams: {},
      extraTokenParams: {},
    },
  },
  {
    key: 'google',
    label: 'Google',
    input: {
      displayName: 'Google',
      authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenEndpoint: 'https://oauth2.googleapis.com/token',
      clientId: '',
      clientAuthMethod: 'client_secret_post',
      scopes: 'openid email profile',
      userinfoEndpoint: 'https://openidconnect.googleapis.com/v1/userinfo',
      extraAuthorizeParams: { access_type: 'offline', prompt: 'consent' },
      extraTokenParams: {},
    },
  },
  {
    key: 'notion',
    label: 'Notion',
    input: {
      displayName: 'Notion',
      authorizationEndpoint: 'https://api.notion.com/v1/oauth/authorize',
      tokenEndpoint: 'https://api.notion.com/v1/oauth/token',
      clientId: '',
      clientAuthMethod: 'client_secret_basic',
      scopes: '',
      userinfoEndpoint: null,
      extraAuthorizeParams: { owner: 'user' },
      extraTokenParams: {},
    },
  },
];

/** 返回完整预设（含端点与默认 scope）——renderer 用它预先填满「自定义端点」表单 */
export function listPresets(): ProviderPreset[] {
  return PRESETS;
}

export function loadPreset(key: string): (Omit<ManualAuthInput, 'displayName'> & { displayName: string }) | null {
  return PRESETS.find((p) => p.key === key)?.input ?? null;
}
```

- [ ] **Step 4: 实现 `service.ts`**

```ts
// electron/src/main/oauth/service.ts
//
// OAuth 编排层（spec §8）。职责边界：
//   - 只做流程编排与状态机，不含 UI、不含消费者知识
//   - 令牌只在主进程内流转；对外只交付 ConnectionView / AuthMaterial
//   - 连接变更经 setOAuthChangeListener 通知（MCP 池驱逐由消费方订阅）
// 依赖方向：oauth/* 可 import mcp/host-manager；反向禁止（mcp 侧用 setter 注入反接，见 Task 12）。
import { randomUUID } from 'node:crypto';
import { logger } from '../logger';
import { getDb } from '../storage/db';
import { getSecret, setSecret } from '../storage/keychain';
import {
  insertConnection, getConnection, listConnections, findReusable,
  updateConnection, deleteConnection,
} from './store';
import { clientSecretKey, clearTokenSet, loadTokenSet, saveTokenSet } from './keys';
import { createPkcePair, createState } from './protocol/pkce';
import { exchangeCode, revokeToken } from './protocol/token';
import { discoverForResource } from './protocol/discovery';
import { registerClient } from './protocol/registration';
import { buildAuthorizationUrl } from './protocol/authorize';
import { startLoopbackServer, parseManualCallback, type LoopbackServer } from './protocol/loopback-server';
import { resolveFetch } from './protocol/http';
import { loadPreset } from './presets';
import { getMcpConfig } from '../mcp/host-manager';
import {
  OAuthFailure, type AuthRequirement, type ClientAuthMethod, type ConnectionView,
  type OAuthConnection, type OAuthConnectionSource,
} from './types';

export type OnConnectionChanged = (
  connectionId: string,
  kind: 'refreshed' | 'needs_reauth' | 'revoked',
) => void;

let changeListener: OnConnectionChanged | null = null;

export function setOAuthChangeListener(listener: OnConnectionChanged | null): void {
  changeListener = listener;
}

export function emitOAuthChange(
  connectionId: string,
  kind: 'refreshed' | 'needs_reauth' | 'revoked',
): void {
  try {
    changeListener?.(connectionId, kind);
  } catch (err) {
    // 监听方异常不得影响主流程
    logger.warn('OAuth 变更监听异常', { error: (err as Error).message });
  }
}

export interface ManualAuthInput {
  displayName: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  clientId: string;
  clientSecret?: string | null;
  clientAuthMethod?: ClientAuthMethod;
  scopes?: string;
  resource?: string | null;
  issuer?: string | null;
  revocationEndpoint?: string | null;
  userinfoEndpoint?: string | null;
  redirectHost?: string;
  redirectPort?: number | null;
  allowInsecureTls?: boolean;
  extraAuthorizeParams?: Record<string, string>;
  extraTokenParams?: Record<string, string>;
}

export type BeginInput =
  | { manual: ManualAuthInput }
  | { presetKey: string }
  | { mcpName: string };

export interface BeginResult {
  pendingId: string | null;
  authorizationUrl: string | null;
  redirectUri: string | null;
  existingConnectionId: string | null;
}

interface PendingAuthorization {
  id: string;
  requirement: AuthRequirement;
  verifier: string;
  state: string;
  redirectUri: string;
  server: LoopbackServer;
  createdAt: number;
}

const pending = new Map<string, PendingAuthorization>();
const PENDING_TTL_MS = 10 * 60 * 1000;

function sweepPending(): void {
  const now = Date.now();
  for (const [id, item] of pending) {
    if (now - item.createdAt > PENDING_TTL_MS) {
      pending.delete(id);
      void item.server.close();
    }
  }
}

export function toConnectionView(conn: OAuthConnection): ConnectionView {
  return {
    id: conn.id,
    displayName: conn.displayName,
    accountLabel: conn.accountLabel,
    status: conn.status,
    scopes: conn.scopes,
    expiresAt: conn.expiresAt,
    source: conn.source,
  };
}

export function listConnectionViews(): ConnectionView[] {
  return listConnections().map(toConnectionView);
}

export function getConnectionView(id: string): ConnectionView | null {
  const conn = getConnection(id);
  return conn ? toConnectionView(conn) : null;
}

/** provider_key 归一：identity|client_id|resource|scopes；identity = issuer ?? authorization origin */
export function computeProviderKey(req: Pick<AuthRequirement,
  'issuer' | 'authorizationEndpoint' | 'clientId' | 'resource' | 'scopes'>): string {
  let identity = req.issuer;
  if (!identity) {
    try {
      identity = new URL(req.authorizationEndpoint).origin;
    } catch {
      identity = req.authorizationEndpoint;
    }
  }
  return [identity, req.clientId ?? '', req.resource ?? '', req.scopes].join('|');
}

/** manual / preset / mcp 三态 → AuthRequirement（mcp 分支做发现） */
async function buildRequirement(input: BeginInput): Promise<AuthRequirement> {
  if ('manual' in input) {
    const m = input.manual;
    const req: AuthRequirement = {
      providerKey: '',
      displayName: m.displayName,
      authorizationEndpoint: m.authorizationEndpoint,
      tokenEndpoint: m.tokenEndpoint,
      issuer: m.issuer ?? null,
      registrationEndpoint: null,
      revocationEndpoint: m.revocationEndpoint ?? null,
      userinfoEndpoint: m.userinfoEndpoint ?? null,
      clientId: m.clientId,
      clientSecret: m.clientSecret ?? null,
      clientAuthMethod: m.clientAuthMethod ?? 'none',
      scopes: m.scopes ?? '',
      resource: m.resource ?? null,
      extraAuthorizeParams: m.extraAuthorizeParams ?? {},
      extraTokenParams: m.extraTokenParams ?? {},
      redirectHost: m.redirectHost ?? '127.0.0.1',
      redirectPort: m.redirectPort ?? null,
      allowInsecureTls: m.allowInsecureTls ?? false,
      source: 'manual',
    };
    req.providerKey = computeProviderKey(req);
    return req;
  }

  if ('presetKey' in input) {
    const preset = loadPreset(input.presetKey);
    if (!preset) throw new OAuthFailure('no_connection', `未知的服务预设：${input.presetKey}`);
    return buildRequirement({ manual: preset });
  }

  const config = getMcpConfig(input.mcpName);
  if (!config) throw new OAuthFailure('no_connection', `MCP ${input.mcpName} 未注册`);
  if ((config.transport ?? 'stdio') !== 'streamable_http' || !config.url) {
    throw new OAuthFailure('no_connection', `MCP ${input.mcpName} 不是远程条目，无法使用 OAuth`);
  }
  const meta = await discoverForResource(config.url, null);
  const req: AuthRequirement = {
    providerKey: '',
    displayName: config.name,
    authorizationEndpoint: meta.authorizationEndpoint,
    tokenEndpoint: meta.tokenEndpoint,
    issuer: meta.issuer,
    registrationEndpoint: meta.registrationEndpoint,
    revocationEndpoint: meta.revocationEndpoint,
    userinfoEndpoint: meta.userinfoEndpoint,
    clientId: null,
    clientAuthMethod: 'none',
    scopes: meta.scopesSupported.join(' '),
    resource: config.url,
    extraAuthorizeParams: {},
    extraTokenParams: {},
    redirectHost: '127.0.0.1',
    redirectPort: null,
    allowInsecureTls: config.url.startsWith('http://'),
    source: 'mcp',
  };
  req.providerKey = computeProviderKey(req);
  return req;
}

async function ensureClientRegistration(
  req: AuthRequirement,
  redirectUri: string,
): Promise<AuthRequirement> {
  if (req.clientId) return req;
  if (!req.registrationEndpoint) {
    throw new OAuthFailure('registration_failed', '该授权服务器不支持动态注册，请手工填写 client_id');
  }
  const result = await registerClient({
    registrationEndpoint: req.registrationEndpoint,
    redirectUris: [redirectUri],
    clientName: 'Momo Studio',
    scopes: req.scopes,
    allowInsecureTls: req.allowInsecureTls,
  });
  return {
    ...req,
    clientId: result.clientId,
    clientAuthMethod: result.authMethod,
    clientSecret: result.clientSecret,
  };
}

export async function beginAuthorization(input: BeginInput): Promise<BeginResult> {
  sweepPending();
  let requirement = await buildRequirement(input);

  // 复用检查（provider_key 相同且有效 → 不新建、不弹浏览器）
  // 注意：MCP 分支此时 clientId 必为 null（DCR 尚未发生），provider_key 里的
  // client_id 段为空串——同一 MCP 第二次授权时重算仍为空串，因此能正确复用。
  // 若在此处加 `if (requirement.clientId)` 守卫，MCP 分支将永远跳过复用（已修）。
  {
    const reusable = findReusable(computeProviderKey(requirement));
    if (reusable) {
      return {
        pendingId: null,
        authorizationUrl: null,
        redirectUri: null,
        existingConnectionId: reusable.id,
      };
    }
  }

  const { verifier, challenge } = createPkcePair();
  const state = createState();
  // 需要 DCR 时必须先起服务器拿实际端口——注册要带 redirect_uri
  const server = await startLoopbackServer({
    host: requirement.redirectHost,
    port: requirement.redirectPort,
    expectedState: state,
  });
  requirement = await ensureClientRegistration(requirement, server.redirectUri);

  const authorizationUrl = buildAuthorizationUrl({
    authorizationEndpoint: requirement.authorizationEndpoint,
    clientId: requirement.clientId ?? '',
    redirectUri: server.redirectUri,
    scopes: requirement.scopes,
    state,
    codeChallenge: challenge,
    resource: requirement.resource,
    extraParams: requirement.extraAuthorizeParams,
  });

  const pendingId = randomUUID();
  pending.set(pendingId, {
    id: pendingId,
    requirement,
    verifier,
    state,
    redirectUri: server.redirectUri,
    server,
    createdAt: Date.now(),
  });

  // 浏览器回调路径：成功后走同一条完成链（异步，不阻塞 begin 返回）
  void server
    .waitForCallback()
    .then(({ code }) => finishAuthorization(pendingId, code))
    .catch((err: unknown) => {
      logger.warn('OAuth 回环授权未完成', { pendingId, error: (err as Error).message });
      pending.delete(pendingId);
    });

  return { pendingId, authorizationUrl, redirectUri: server.redirectUri, existingConnectionId: null };
}

export async function completeWithManualCallback(input: {
  pendingId: string;
  input: string;
}): Promise<ConnectionView> {
  const item = pending.get(input.pendingId);
  if (!item) throw new OAuthFailure('authorization_cancelled', '授权流程已失效，请重新发起');
  // state 校验失败时保留 pending（用户可重试）——parseManualCallback 抛错在前
  const code = parseManualCallback(input.input, item.state);
  return finishAuthorization(input.pendingId, code);
}

export async function cancelAuthorization(pendingId: string): Promise<void> {
  const item = pending.get(pendingId);
  if (!item) return;
  pending.delete(pendingId);
  await item.server.close();
}

async function fetchAccountLabel(
  req: AuthRequirement,
  accessToken: string,
  allowInsecureTls: boolean,
): Promise<string> {
  if (!req.userinfoEndpoint) return '';
  try {
    const fetchFn = resolveFetch(allowInsecureTls);
    const response = await fetchFn(req.userinfoEndpoint, {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return '';
    const body = (await response.json()) as Record<string, unknown>;
    for (const key of ['login', 'preferred_username', 'email', 'name', 'sub']) {
      const value = body[key];
      if (typeof value === 'string' && value !== '') return value;
    }
    return '';
  } catch {
    return '';
  }
}

async function finishAuthorization(pendingId: string, code: string): Promise<ConnectionView> {
  const item = pending.get(pendingId);
  if (!item) throw new OAuthFailure('authorization_cancelled', '授权流程已失效，请重新发起');
  pending.delete(pendingId);
  const req = item.requirement;

  const tokens = await exchangeCode({
    tokenEndpoint: req.tokenEndpoint,
    clientId: req.clientId ?? '',
    clientAuthMethod: req.clientAuthMethod,
    clientSecret: req.clientSecret,
    code,
    codeVerifier: item.verifier,
    redirectUri: item.redirectUri,
    extraParams: req.extraTokenParams,
    allowInsecureTls: req.allowInsecureTls,
  });

  const accountLabel = await fetchAccountLabel(req, tokens.accessToken, req.allowInsecureTls);

  const stored = insertConnection({
    providerKey: req.providerKey,
    displayName: req.displayName,
    authorizationEndpoint: req.authorizationEndpoint,
    tokenEndpoint: req.tokenEndpoint,
    clientId: req.clientId ?? '',
    accountLabel,
    issuer: req.issuer,
    registrationEndpoint: req.registrationEndpoint,
    revocationEndpoint: req.revocationEndpoint,
    userinfoEndpoint: req.userinfoEndpoint,
    clientAuthMethod: req.clientAuthMethod,
    scopes: req.scopes,
    resource: req.resource,
    extraAuthorizeParams: req.extraAuthorizeParams,
    extraTokenParams: req.extraTokenParams,
    redirectHost: req.redirectHost,
    redirectPort: req.redirectPort,
    allowInsecureTls: req.allowInsecureTls,
    status: 'connected',
    expiresAt: tokens.expiresAt,
    source: req.source,
  });

  try {
    await saveTokenSet(stored.id, tokens);
    if (req.clientSecret) {
      await setSecret(clientSecretKey(stored.id), req.clientSecret);
    }
  } catch (err) {
    // 密钥环不可用（Linux 无 Secret Service 等）——删行避免留下无凭据的孤儿
    deleteConnection(stored.id);
    throw new OAuthFailure(
      'keychain_unavailable',
      '系统密钥环不可用，无法保存授权凭据',
      stored.id,
      (err as Error).message,
    );
  }

  return toConnectionView(stored);
}

/** 查询引用某连接的 MCP 名（断开/删除前展示影响面） */
export function listMcpNamesByConnection(connectionId: string): string[] {
  const rows = getDb()
    .prepare('SELECT name FROM mcp_definitions WHERE oauth_connection_id = ? ORDER BY name')
    .all(connectionId) as Array<{ name: string }>;
  return rows.map((r) => r.name);
}

async function revokeBestEffort(conn: OAuthConnection): Promise<void> {
  if (!conn.revocationEndpoint) return;
  const tokenSet = await loadTokenSet(conn.id);
  if (!tokenSet) return;
  const clientSecret = await getSecret(clientSecretKey(conn.id));
  await revokeToken({
    revocationEndpoint: conn.revocationEndpoint,
    token: tokenSet.accessToken,
    tokenTypeHint: 'access_token',
    clientId: conn.clientId,
    clientAuthMethod: conn.clientAuthMethod,
    clientSecret,
    allowInsecureTls: conn.allowInsecureTls,
  });
}

/** 断开：撤销 + 清密钥 + 置 revoked；绑定保留（用户可一键重授权） */
export async function disconnect(id: string): Promise<{ affectedMcpNames: string[] }> {
  const conn = getConnection(id);
  if (!conn) throw new OAuthFailure('no_connection', '连接不存在');
  const affectedMcpNames = listMcpNamesByConnection(id);
  await revokeBestEffort(conn);
  await clearTokenSet(id);
  updateConnection(id, { status: 'revoked', expiresAt: null, lastRefreshedAt: null });
  emitOAuthChange(id, 'revoked');
  return { affectedMcpNames };
}

/** 物理删除：有引用则拒绝（对齐 deleteProvider 的引用阻断语义） */
export async function removeConnection(id: string): Promise<{ affectedMcpNames: string[] }> {
  const conn = getConnection(id);
  if (!conn) throw new OAuthFailure('no_connection', '连接不存在');
  const affectedMcpNames = listMcpNamesByConnection(id);
  if (affectedMcpNames.length > 0) {
    throw new OAuthFailure(
      'no_connection',
      `该连接仍被 ${affectedMcpNames.length} 个 MCP 服务器使用，请先解除绑定`,
      id,
      affectedMcpNames.join(', '),
    );
  }
  deleteConnection(id);
  return { affectedMcpNames: [] };
}
```

- [ ] **Step 5: 运行测试**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/oauth/service.test.ts --pool=forks`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add electron/src/main/oauth/presets.ts electron/src/main/oauth/service.ts \
  electron/tests/oauth/service.test.ts
git commit -m "feat: OAuth 服务编排（授权/手动回调/断开/删除）"
```

---

## Task 10: 生命周期（主动刷新 / 单飞 / 轮换 / 失败分类）

**Files:**
- Create: `electron/src/main/oauth/lifecycle.ts`
- Test: `electron/tests/oauth/lifecycle.test.ts`

**Interfaces:**
- Consumes: Task 3 `getConnection` / `updateConnection` / `loadTokenSet` / `saveTokenSet` / `clientSecretKey`；Task 5 `refreshTokens`；Task 9 `emitOAuthChange`
- Produces:
  - `ensureFreshAccessToken(connectionId: string): Promise<string>`（过期前 5 分钟主动刷新）
  - `startOAuthLifecycle(): void` / `stopOAuthLifecycle(): void`（60s 扫描）
  - `__resetOAuthLifecycleForTest(): void`（清单飞表与退避计数）

- [ ] **Step 1: 写失败测试**

```ts
// electron/tests/oauth/lifecycle.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runMigrations, closeDb } from '../../src/main/storage/db';
import { setKeychainImpl, __resetKeychainImplForTest } from '../../src/main/storage/keychain';
import { insertConnection, getConnection, updateConnection } from '../../src/main/oauth/store';
import { saveTokenSet, accessTokenKey, refreshTokenKey } from '../../src/main/oauth/keys';
import { ensureFreshAccessToken } from '../../src/main/oauth/lifecycle';

const tmpRoot = path.join(os.tmpdir(), `ap-oauth-life-${Date.now()}-${process.pid}`);
const vault = new Map<string, string>();

let server: http.Server;
let base = '';
let tokenCalls = 0;
let tokenResponse: { status: number; body: unknown } = { status: 200, body: {} };

beforeEach(async () => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  vault.clear();
  tokenCalls = 0;
  setKeychainImpl({
    setSecret: async (k, v) => { vault.set(k, v); },
    getSecret: async (k) => vault.get(k) ?? null,
    deleteSecret: async (k) => { vault.delete(k); },
  });
  server = http.createServer((req, res) => {
    tokenCalls += 1;
    res.writeHead(tokenResponse.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(tokenResponse.body));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  __resetKeychainImplForTest();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

function seed(expiresInMs: number | null): string {
  const conn = insertConnection({
    providerKey: 'pk',
    displayName: 'T',
    authorizationEndpoint: 'https://unused.example.com/a',
    tokenEndpoint: `${base}/token`,
    clientId: 'cid',
    scopes: '',
    expiresAt: expiresInMs === null ? null : new Date(Date.now() + expiresInMs).toISOString(),
  });
  vault.set(accessTokenKey(conn.id), 'old-at');
  vault.set(refreshTokenKey(conn.id), 'old-rt');
  return conn.id;
}

describe('ensureFreshAccessToken', () => {
  it('临近过期时刷新并轮换 refresh_token', async () => {
    const id = seed(60_000); // 1 分钟后过期 < 5 分钟阈值
    tokenResponse = {
      status: 200,
      body: { access_token: 'new-at', refresh_token: 'new-rt', expires_in: 3600 },
    };
    const token = await ensureFreshAccessToken(id);
    expect(token).toBe('new-at');
    expect(tokenCalls).toBe(1);
    expect(vault.get(refreshTokenKey(id))).toBe('new-rt');
    expect(getConnection(id)?.expiresAt).not.toBeNull();
  });

  it('未临近过期不刷新', async () => {
    const id = seed(3600_000);
    expect(await ensureFreshAccessToken(id)).toBe('old-at');
    expect(tokenCalls).toBe(0);
  });

  it('无 expiresAt 视为不过期，不刷新', async () => {
    const id = seed(null);
    expect(await ensureFreshAccessToken(id)).toBe('old-at');
    expect(tokenCalls).toBe(0);
  });

  it('并发 3 次只发 1 个刷新请求（单飞）', async () => {
    const id = seed(60_000);
    tokenResponse = { status: 200, body: { access_token: 'new-at', expires_in: 3600 } };
    const results = await Promise.all([
      ensureFreshAccessToken(id),
      ensureFreshAccessToken(id),
      ensureFreshAccessToken(id),
    ]);
    expect(results).toEqual(['new-at', 'new-at', 'new-at']);
    expect(tokenCalls).toBe(1);
  });

  it('响应无 refresh_token 时保留旧值', async () => {
    const id = seed(60_000);
    tokenResponse = { status: 200, body: { access_token: 'new-at', expires_in: 3600 } };
    await ensureFreshAccessToken(id);
    expect(vault.get(refreshTokenKey(id))).toBe('old-rt');
  });

  it('invalid_grant 置 needs_reauth 并抛错', async () => {
    const id = seed(60_000);
    tokenResponse = { status: 400, body: { error: 'invalid_grant' } };
    await expect(ensureFreshAccessToken(id)).rejects.toMatchObject({ code: 'needs_reauth' });
    expect(getConnection(id)?.status).toBe('needs_reauth');
  });

  it('已 revoked 的连接拒绝刷新（needs_reauth）', async () => {
    const id = seed(60_000);
    updateConnection(id, { status: 'revoked' });
    await expect(ensureFreshAccessToken(id)).rejects.toMatchObject({ code: 'needs_reauth' });
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/oauth/lifecycle.test.ts --pool=forks`
Expected: FAIL

- [ ] **Step 3: 实现**

```ts
// electron/src/main/oauth/lifecycle.ts
//
// 令牌生命周期（spec §11）：
//   - 过期前 5 分钟主动刷新；无 expires_at 视为不过期
//   - 单飞：同一连接并发刷新只发一个请求
//   - 轮换：响应带新 refresh_token 覆盖旧值；未带则保留旧值
//   - 失败分类：invalid_grant → needs_reauth（保留行，用户可重授权）；
//     网络/5xx → 退避重试（1m/5m/15m），3 次后同样落 needs_reauth
//   - 60s 扫描器（startOAuthLifecycle）覆盖「长期不用也会过期」的场景
import { logger } from '../logger';
import { getSecret } from '../storage/keychain';
import { getConnection, listConnections, updateConnection } from './store';
import { clientSecretKey, loadTokenSet, refreshTokenKey, saveTokenSet } from './keys';
import { refreshTokens } from './protocol/token';
import { emitOAuthChange } from './service';
import { OAuthFailure } from './types';

const REFRESH_AHEAD_MS = 5 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 1000;
const BACKOFF_MS = [60_000, 300_000, 900_000];

const inflight = new Map<string, Promise<string>>();
const retryCount = new Map<string, number>();
let sweeper: NodeJS.Timeout | null = null;

/** 测试缝：清零单飞表与退避计数 */
export function __resetOAuthLifecycleForTest(): void {
  inflight.clear();
  retryCount.clear();
}

export interface OAuthLifecycleTestHooks {
  /** 覆盖退避等待（测试跳过长延时） */
  waitBeforeRetry?: (attempt: number) => Promise<void>;
}

const defaultHooks: Required<OAuthLifecycleTestHooks> = {
  waitBeforeRetry: (attempt) =>
    new Promise((resolve) => setTimeout(resolve, BACKOFF_MS[attempt] ?? BACKOFF_MS[2])),
};

let hooks: Required<OAuthLifecycleTestHooks> = defaultHooks;

export function setOAuthLifecycleTestHooks(next: OAuthLifecycleTestHooks): void {
  hooks = { ...defaultHooks, ...next };
}

function needsRefresh(expiresAt: string | null): boolean {
  if (!expiresAt) return false;
  return Date.parse(expiresAt) - Date.now() <= REFRESH_AHEAD_MS;
}

async function doRefresh(connectionId: string): Promise<string> {
  const conn = getConnection(connectionId);
  if (!conn) throw new OAuthFailure('no_connection', '连接不存在', connectionId);
  if (conn.status === 'revoked' || conn.status === 'needs_reauth') {
    throw new OAuthFailure('needs_reauth', '连接已失效，请重新授权', connectionId);
  }
  const tokenSet = await loadTokenSet(connectionId);
  if (!tokenSet) {
    updateConnection(connectionId, { status: 'needs_reauth' });
    emitOAuthChange(connectionId, 'needs_reauth');
    throw new OAuthFailure('needs_reauth', '连接缺少凭据，请重新授权', connectionId);
  }
  if (!tokenSet.refreshToken) {
    // 无 refresh_token：只能等用户重新授权（短期 token 场景）
    updateConnection(connectionId, { status: 'needs_reauth' });
    emitOAuthChange(connectionId, 'needs_reauth');
    throw new OAuthFailure('needs_reauth', '该连接没有 refresh_token，请重新授权', connectionId);
  }
  const clientSecret = await getSecret(clientSecretKey(connectionId));

  let lastError: unknown = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const next = await refreshTokens({
        tokenEndpoint: conn.tokenEndpoint,
        clientId: conn.clientId,
        clientAuthMethod: conn.clientAuthMethod,
        clientSecret,
        refreshToken: tokenSet.refreshToken,
        extraParams: conn.extraTokenParams,
        allowInsecureTls: conn.allowInsecureTls,
      });
      // 响应未带 refresh_token 时保留旧值
      const effectiveRefresh = next.refreshToken ?? tokenSet.refreshToken;
      await saveTokenSet(connectionId, { ...next, refreshToken: effectiveRefresh });
      updateConnection(connectionId, {
        status: 'connected',
        expiresAt: next.expiresAt,
        lastRefreshedAt: new Date().toISOString(),
      });
      retryCount.delete(connectionId);
      emitOAuthChange(connectionId, 'refreshed');
      return next.accessToken;
    } catch (err) {
      lastError = err;
      if (err instanceof OAuthFailure && err.code === 'needs_reauth') {
        updateConnection(connectionId, { status: 'needs_reauth' });
        emitOAuthChange(connectionId, 'needs_reauth');
        throw err;
      }
      // 网络 / 5xx → 退避重试
      if (attempt < 2) await hooks.waitBeforeRetry(attempt);
    }
  }
  logger.warn('OAuth 刷新重试耗尽', { connectionId });
  updateConnection(connectionId, { status: 'needs_reauth' });
  emitOAuthChange(connectionId, 'needs_reauth');
  throw lastError instanceof OAuthFailure
    ? lastError
    : new OAuthFailure('refresh_failed', '令牌刷新失败', connectionId);
}

/** 单飞入口：返回可用 access token（必要时刷新） */
export function ensureFreshAccessToken(connectionId: string): Promise<string> {
  const existing = inflight.get(connectionId);
  if (existing) return existing;
  const task = (async () => {
    const conn = getConnection(connectionId);
    if (!conn) throw new OAuthFailure('no_connection', '连接不存在', connectionId);
    if (!needsRefresh(conn.expiresAt)) {
      const set = await loadTokenSet(connectionId);
      if (!set) {
        updateConnection(connectionId, { status: 'needs_reauth' });
        emitOAuthChange(connectionId, 'needs_reauth');
        throw new OAuthFailure('needs_reauth', '连接缺少凭据，请重新授权', connectionId);
      }
      return set.accessToken;
    }
    return doRefresh(connectionId);
  })().finally(() => {
    inflight.delete(connectionId);
  });
  inflight.set(connectionId, task);
  return task;
}

function sweepOnce(): void {
  for (const conn of listConnections()) {
    if (conn.status !== 'connected') continue;
    if (!needsRefresh(conn.expiresAt)) continue;
    void ensureFreshAccessToken(conn.id).catch(() => undefined);
  }
}

/** 启动 60s 扫描（main boot 调用一次；重复调用幂等） */
export function startOAuthLifecycle(): void {
  if (sweeper) return;
  sweeper = setInterval(sweepOnce, SWEEP_INTERVAL_MS);
  // 启动即扫一遍
  sweepOnce();
}

export function stopOAuthLifecycle(): void {
  if (sweeper) clearInterval(sweeper);
  sweeper = null;
}

// refreshTokenKey 仅为提示键族存在；此处显式引用避免误删
void refreshTokenKey;
```

- [ ] **Step 4: 运行测试**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/oauth/lifecycle.test.ts --pool=forks`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add electron/src/main/oauth/lifecycle.ts electron/tests/oauth/lifecycle.test.ts
git commit -m "feat: OAuth 生命周期（主动刷新/单飞/轮换/失败分类）"
```

---

## Task 11: MCP 适配器与 `resolveAuthMaterial`

**Files:**
- Create: `electron/src/main/oauth/adapters/mcp.ts`
- Test: `electron/tests/oauth/mcp-adapter.test.ts`

**Interfaces:**
- Consumes: Task 10 `ensureFreshAccessToken`；Task 3 `AuthMaterial` / `OAuthFailure`；`mcp/types.McpServerConfig`
- Produces:
  - `interface McpAuthTarget { url?: string | null; transport?: 'stdio' | 'streamable_http'; envVar?: string | null }`
  - `resolveMcpAuthMaterial(connectionId: string, target: McpAuthTarget): Promise<AuthMaterial>`
  - `applyMcpMaterial(config: McpServerConfig, material: AuthMaterial): McpServerConfig`
  - `wireMcpOAuth(): void`（把解析器注入 `host-manager.setMcpAuthResolver`）

- [ ] **Step 1: 写失败测试**

```ts
// electron/tests/oauth/mcp-adapter.test.ts
import { describe, it, expect } from 'vitest';
import { applyMcpMaterial } from '../../src/main/oauth/adapters/mcp';
import type { McpServerConfig } from '../../src/main/mcp/types';

const httpConfig: McpServerConfig = {
  id: 'm1', name: 'gh', version: '1.0.0', transport: 'streamable_http',
  command: '', args: [], url: 'https://mcp.example.com', headers: { 'X-Existing': '1' },
};

const stdioConfig: McpServerConfig = {
  id: 'm2', name: 'local', version: '1.0.0', transport: 'stdio',
  command: 'node', args: ['server.js'], env: { PATH: '/usr/bin' },
};

describe('applyMcpMaterial', () => {
  it('http：Authorization 注入且覆盖手填值，其他 header 保留', () => {
    const out = applyMcpMaterial(httpConfig, {
      connectionId: 'c1',
      headers: { Authorization: 'Bearer at' },
    });
    expect(out.headers).toEqual({ 'X-Existing': '1', Authorization: 'Bearer at' });
    expect(out.url).toBe(httpConfig.url);
  });

  it('http：OAuth 覆盖手填 Authorization', () => {
    const out = applyMcpMaterial(
      { ...httpConfig, headers: { Authorization: 'Bearer manual' } },
      { connectionId: 'c1', headers: { Authorization: 'Bearer oauth' } },
    );
    expect(out.headers?.Authorization).toBe('Bearer oauth');
  });

  it('stdio：env 合并，不覆盖 PATH', () => {
    const out = applyMcpMaterial(stdioConfig, {
      connectionId: 'c1',
      env: { GITHUB_TOKEN: 'at' },
    });
    expect(out.env).toEqual({ PATH: '/usr/bin', GITHUB_TOKEN: 'at' });
  });

  it('不修改入参（返回新对象）', () => {
    applyMcpMaterial(httpConfig, { connectionId: 'c1', headers: { Authorization: 'Bearer at' } });
    expect(httpConfig.headers).toEqual({ 'X-Existing': '1' });
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/oauth/mcp-adapter.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

```ts
// electron/src/main/oauth/adapters/mcp.ts
//
// MCP 适配器（spec §9）。职责：
//   - 把连接凭据翻译成 MCP 消费形态（http → Authorization header；stdio → 环境变量）
//   - 把解析器注入 host-manager（setter 反接，避免 mcp ↔ oauth 循环依赖）
// 令牌不出主进程：这里拿到的 access token 只用于拼 header/env，随后随 config 进入
// transport 构造，不会流向 renderer。
import { logger } from '../../logger';
import { getConnection } from '../store';
import { ensureFreshAccessToken } from '../lifecycle';
import { setMcpAuthResolver } from '../../mcp/host-manager';
import { OAuthFailure, type AuthMaterial } from '../types';
import type { McpServerConfig } from '../../mcp/types';

export interface McpAuthTarget {
  url?: string | null;
  transport?: 'stdio' | 'streamable_http';
  envVar?: string | null;
}

export async function resolveMcpAuthMaterial(
  connectionId: string,
  target: McpAuthTarget,
): Promise<AuthMaterial> {
  const conn = getConnection(connectionId);
  if (!conn) throw new OAuthFailure('no_connection', 'OAuth 连接不存在', connectionId);
  const accessToken = await ensureFreshAccessToken(connectionId);

  if ((target.transport ?? 'stdio') === 'streamable_http') {
    return {
      connectionId,
      headers: { Authorization: `Bearer ${accessToken}` },
      expiresAt: conn.expiresAt,
    };
  }
  const envVar = target.envVar?.trim();
  if (!envVar) {
    throw new OAuthFailure(
      'oauth_env_var_required',
      'stdio MCP 绑定 OAuth 时必须指定注入的环境变量名',
      connectionId,
    );
  }
  return {
    connectionId,
    env: { [envVar]: accessToken },
    expiresAt: conn.expiresAt,
  };
}

export function applyMcpMaterial(config: McpServerConfig, material: AuthMaterial): McpServerConfig {
  const next: McpServerConfig = { ...config };
  if (material.headers) {
    // OAuth 覆盖手填（避免两套凭据打架）
    next.headers = { ...(config.headers ?? {}), ...material.headers };
  }
  if (material.env) {
    next.env = { ...(config.env ?? {}), ...material.env };
  }
  return next;
}

/** boot 时调用一次：host-manager 在建连前回调本解析器 */
export function wireMcpOAuth(): void {
  setMcpAuthResolver(async (config) => {
    if (!config.oauthConnectionId) return null;
    const material = await resolveMcpAuthMaterial(config.oauthConnectionId, {
      url: config.url,
      transport: config.transport ?? 'stdio',
      envVar: config.oauthEnvVar ?? null,
    });
    return applyMcpMaterial(config, material);
  });
  logger.info('MCP OAuth 认证解析器已接线');
}
```

- [ ] **Step 4: 运行测试**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/oauth/mcp-adapter.test.ts`
Expected: PASS（前置：Task 12 的 `setMcpAuthResolver` 已落地）

- [ ] **Step 5: 提交**

```bash
git add electron/src/main/oauth/adapters/mcp.ts electron/tests/oauth/mcp-adapter.test.ts
git commit -m "feat: MCP OAuth 适配器与认证材料解析"
```

---

## Task 12: MCP 绑定字段 + 认证解析器注入点 + 扇出驱逐

> **执行顺序提示**：Task 11（适配器）依赖本任务的 `setMcpAuthResolver`。若按编号顺序执行，请先完成本任务的 Step 1-4 再回到 Task 11 的 Step 4 验证。

**Files:**
- Modify: `electron/src/main/mcp/types.ts`
- Modify: `electron/src/main/mcp/host-manager.ts`
- Test: `electron/tests/mcp/oauth-binding.test.ts`

**Interfaces:**
- Consumes: 迁移 079 的两列
- Produces:
  - `McpServerConfig.oauthConnectionId?: string`、`McpServerConfig.oauthEnvVar?: string`
  - `RegisteredMcp` 同名两字段
  - `setMcpAuthResolver(resolver: ((config: McpServerConfig) => Promise<McpServerConfig | null>) | null): void`
  - `setMcpOAuthBinding(name: string, connectionId: string | null, envVar: string | null): void`
  - `evictMcpsByConnection(connectionId: string): Promise<string[]>`

- [ ] **Step 1: 写失败测试（真实 HTTP MCP fixture，断言 Authorization 注入与驱逐）**

```ts
// electron/tests/mcp/oauth-binding.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import {
  getMcpConfig, getOrStartMcp, listMcpTools, setMcpAuthResolver,
  setMcpOAuthBinding, evictMcpsByConnection,
} from '../../src/main/mcp/host-manager';

const tmpRoot = path.join(os.tmpdir(), `ap-mcp-oauth-${Date.now()}-${process.pid}`);

let server: http.Server;
let base = '';
let lastAuth = '';

beforeEach(async () => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  lastAuth = '';
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += String(c); });
    req.on('end', () => {
      lastAuth = req.headers.authorization ?? '';
      const msg = JSON.parse(body || '{}') as { id?: number; method?: string };
      if (msg.method === 'initialize') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'fixture', version: '1' } } }));
        return;
      }
      if (msg.method === 'tools/list') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [] } }));
        return;
      }
      res.writeHead(202);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  getDb()
    .prepare(
      `INSERT INTO mcp_definitions (id, name, version, transport, command, args)
       VALUES ('m1', 'fixture', '1.0.0', 'streamable_http', '', '[]')`,
    )
    .run();
});

afterEach(async () => {
  setMcpAuthResolver(null);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

describe('setMcpOAuthBinding', () => {
  it('写绑定与 env 变量名，getMcpConfig 可读回', () => {
    setMcpOAuthBinding('fixture', 'conn-1', 'GH_TOKEN');
    const config = getMcpConfig('fixture');
    expect(config?.oauthConnectionId).toBe('conn-1');
    expect(config?.oauthEnvVar).toBe('GH_TOKEN');
  });

  it('传 null 清空绑定', () => {
    setMcpOAuthBinding('fixture', 'conn-1', null);
    setMcpOAuthBinding('fixture', null, null);
    expect(getMcpConfig('fixture')?.oauthConnectionId).toBeUndefined();
    expect(getMcpConfig('fixture')?.oauthEnvVar).toBeUndefined();
  });
});

describe('getOrStartMcp 注入与扇出驱逐', () => {
  it('已绑定连接时调用 resolver，其返回的 headers 生效', async () => {
    getDb().prepare('UPDATE mcp_definitions SET url = ? WHERE id = ?').run(`${base}/mcp`, 'm1');
    setMcpOAuthBinding('fixture', 'conn-1', null);
    const calls: string[] = [];
    setMcpAuthResolver(async (config) => {
      calls.push(config.name);
      return { ...config, headers: { ...(config.headers ?? {}), Authorization: 'Bearer injected' } };
    });
    await getOrStartMcp('ws-1', getMcpConfig('fixture')!);
    expect(calls).toEqual(['fixture']);
    expect(lastAuth).toBe('Bearer injected');
  });

  it('未绑定连接时不调用 resolver', async () => {
    getDb().prepare('UPDATE mcp_definitions SET url = ? WHERE id = ?').run(`${base}/mcp`, 'm1');
    const calls: string[] = [];
    setMcpAuthResolver(async (config) => { calls.push(config.name); return config; });
    await getOrStartMcp('ws-1', getMcpConfig('fixture')!);
    expect(calls).toEqual([]);
  });

  it('evictMcpsByConnection 驱逐该连接引用的全部实例（含多 workspace）', async () => {
    getDb().prepare('UPDATE mcp_definitions SET url = ? WHERE id = ?').run(`${base}/mcp`, 'm1');
    setMcpOAuthBinding('fixture', 'conn-1', null);
    setMcpAuthResolver(async (config) => config);
    await getOrStartMcp('ws-1', getMcpConfig('fixture')!);
    await getOrStartMcp('ws-2', getMcpConfig('fixture')!);
    const names = await evictMcpsByConnection('conn-1');
    expect(names).toEqual(['fixture']);
    await expect(listMcpTools('ws-1', 'fixture')).rejects.toThrow(/未启动/);
    await expect(listMcpTools('ws-2', 'fixture')).rejects.toThrow(/未启动/);
  });

  it('evictMcpsByConnection 对无引用连接返回空数组', async () => {
    expect(await evictMcpsByConnection('nobody')).toEqual([]);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/mcp/oauth-binding.test.ts --pool=forks`
Expected: FAIL（字段/函数不存在）

- [ ] **Step 3: 改 `mcp/types.ts`**

```ts
// McpServerConfig 内追加（headers 字段之后）
  /** 绑定的 OAuth 连接 id（空 = 不走 OAuth；仅 DB 行读取赋值） */
  oauthConnectionId?: string;
  /** stdio 形态下 OAuth token 注入的环境变量名（http 形态忽略） */
  oauthEnvVar?: string;
```

```ts
// RegisteredMcp 内追加（headers 之后）
  /** OAuth 绑定（DB 行 NULL → undefined） */
  oauthConnectionId?: string;
  oauthEnvVar?: string;
```

- [ ] **Step 4: 改 `mcp/host-manager.ts`**

(1) `McpDefinitionRow` 加两列：

```ts
  oauth_connection_id: string | null;
  oauth_env_var: string | null;
```

(2) `rowToRegistered` 映射：

```ts
    oauthConnectionId: row.oauth_connection_id ?? undefined,
    oauthEnvVar: row.oauth_env_var ?? undefined,
```

(3) 两处 SELECT 列表（`getMcpConfig` 与 `listRegistered`）在 `enabled` 后追加 `, oauth_connection_id, oauth_env_var`。

(4) 文件末尾追加：

```ts
/**
 * OAuth 认证解析器（setter 反接，spec §9.2）。
 * host-manager 不 import oauth 业务模块——由 oauth/adapters/mcp.wireMcpOAuth()
 * 在 boot 时注入，避免 mcp ↔ oauth 循环依赖。
 */
type McpAuthResolver = (config: McpServerConfig) => Promise<McpServerConfig | null>;

let authResolver: McpAuthResolver | null = null;

export function setMcpAuthResolver(resolver: McpAuthResolver | null): void {
  authResolver = resolver;
}

/** 写 OAuth 绑定（仅 UPDATE 两列；连接状态校验由 OAuth 服务层负责） */
export function setMcpOAuthBinding(
  mcpName: string,
  connectionId: string | null,
  envVar: string | null,
): void {
  const info = getDb()
    .prepare('UPDATE mcp_definitions SET oauth_connection_id = ?, oauth_env_var = ? WHERE name = ?')
    .run(connectionId, envVar, mcpName);
  if (info.changes === 0) throw new Error(`MCP ${mcpName} 未注册`);
  logger.info('MCP OAuth 绑定已更新', { name: mcpName, bound: connectionId !== null });
}

/** 按连接扇出驱逐：同一连接可能被多个 MCP、多个 workspace 引用 */
export async function evictMcpsByConnection(connectionId: string): Promise<string[]> {
  const rows = getDb()
    .prepare('SELECT name FROM mcp_definitions WHERE oauth_connection_id = ?')
    .all(connectionId) as Array<{ name: string }>;
  const names = rows.map((r) => r.name);
  await Promise.all(names.map((name) => evictMcpByName(name)));
  return names;
}
```

(5) `getOrStartMcp` 内，在插件模板展开之后、构造 client 之前插入：

```ts
    // OAuth 注入（spec §9.2）：解析器由 oauth 域注入；未绑定连接时零开销
    if (effective.oauthConnectionId && authResolver) {
      const withAuth = await authResolver(effective);
      if (withAuth) effective = withAuth;
    }
```

- [ ] **Step 5: 运行测试**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/mcp/oauth-binding.test.ts --pool=forks`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add electron/src/main/mcp/types.ts electron/src/main/mcp/host-manager.ts \
  electron/tests/mcp/oauth-binding.test.ts
git commit -m "feat: MCP OAuth 绑定字段、认证注入点与扇出驱逐"
```

---

## Task 13: 结构化 401 + 微触发

**Files:**
- Modify: `electron/src/main/mcp/http-client.ts`
- Modify: `electron/src/main/mcp/host-manager.ts`
- Create: `electron/src/main/oauth/mcp-trigger.ts`
- Test: `electron/tests/mcp/oauth-401.test.ts`

**Interfaces:**
- Consumes: Task 12 `evictMcpsByConnection` / `setMcpOAuthBinding` / `setMcpAuthResolver`；Task 9 `beginAuthorization` / `computeProviderKey`
- Produces:
  - `class McpHttpError extends Error { method; status; wwwAuthenticate }`
  - `beginAuthorizationForMcp(mcpName: string): Promise<BeginResult>`（授权成功后回写绑定）
  - `bindConnectionToMcp(mcpName, connectionId, envVar?): Promise<void>`

- [ ] **Step 1: 写失败测试**

```ts
// electron/tests/mcp/oauth-401.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { getMcpConfig, getOrStartMcp, setMcpAuthResolver } from '../../src/main/mcp/host-manager';
import { McpHttpError, HttpMcpClient } from '../../src/main/mcp/http-client';
import { bindConnectionToMcp } from '../../src/main/oauth/mcp-trigger';

const tmpRoot = path.join(os.tmpdir(), `ap-mcp-401-${Date.now()}-${process.pid}`);

let server: http.Server;
let base = '';

beforeEach(async () => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  server = http.createServer((req, res) => {
    res.writeHead(401, {
      'content-type': 'application/json',
      'www-authenticate': 'Bearer resource_metadata="https://auth.example.com/.well-known/oauth-protected-resource"',
    });
    res.end(JSON.stringify({ error: 'unauthorized' }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  getDb()
    .prepare(
      `INSERT INTO mcp_definitions (id, name, version, transport, command, args, url, oauth_connection_id)
       VALUES ('m1', 'needs-auth', '1.0.0', 'streamable_http', '', '[]', ?, 'conn-1')`,
    )
    .run(`${base}/mcp`);
});

afterEach(async () => {
  setMcpAuthResolver(null);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

describe('McpHttpError', () => {
  it('客户端层 401 抛结构化错误，带 status 与 www-authenticate', async () => {
    // 直接测 HttpMcpClient：host-manager 会把 401 翻译成 OAuthFailure，
    // 结构化信息在客户端边界断言（否则该分支永远看不到）
    const client = new HttpMcpClient({
      id: 'm1', name: 'needs-auth', version: '1.0.0', transport: 'streamable_http',
      command: '', args: [], url: `${base}/mcp`,
    });
    try {
      await client.connect();
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(McpHttpError);
      const httpErr = err as McpHttpError;
      expect(httpErr.status).toBe(401);
      expect(httpErr.wwwAuthenticate).toContain('resource_metadata=');
    }
  });

  it('已绑定连接遇 401 抛 needs_reauth（带 connectionId），且池不留死实例', async () => {
    setMcpAuthResolver(async (config) => config);
    await expect(getOrStartMcp('ws-1', getMcpConfig('needs-auth')!))
      .rejects.toMatchObject({ code: 'needs_reauth', connectionId: 'conn-1' });
  });
});

describe('bindConnectionToMcp', () => {
  it('写绑定并驱逐该 MCP 的全部池实例', async () => {
    await bindConnectionToMcp('needs-auth', 'conn-1', 'GH_TOKEN');
    const row = getDb()
      .prepare('SELECT oauth_connection_id, oauth_env_var FROM mcp_definitions WHERE name = ?')
      .get('needs-auth') as { oauth_connection_id: string; oauth_env_var: string };
    expect(row.oauth_connection_id).toBe('conn-1');
    expect(row.oauth_env_var).toBe('GH_TOKEN');
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/mcp/oauth-401.test.ts --pool=forks`
Expected: FAIL

- [ ] **Step 3: 改 `http-client.ts`**

文件顶部（imports 之后）加：

```ts
/**
 * 远程 MCP 结构化 HTTP 失败（spec §9.3）。
 * 401/403 需要驱动 OAuth 重授权，字符串错误无法判别——status 与
 * WWW-Authenticate 原样带出，由 host-manager 翻译成 OAuthFailure。
 */
export class McpHttpError extends Error {
  constructor(
    readonly method: string,
    readonly status: number,
    readonly wwwAuthenticate: string | null,
  ) {
    super(`远程 MCP ${method} 失败：HTTP ${status}`);
    this.name = 'McpHttpError';
  }
}
```

`rpc()` 的 `if (!response.ok)` 分支改为：

```ts
    if (!response.ok) {
      this.connected = false;
      throw new McpHttpError(method, response.status, response.headers.get('www-authenticate'));
    }
```

`notify()` 同理：

```ts
    if (!response.ok) {
      this.connected = false;
      throw new McpHttpError(method, response.status, response.headers.get('www-authenticate'));
    }
```

- [ ] **Step 4: 改 `host-manager.getOrStartMcp` 的 connect 调用**

```ts
    // 401/403 → OAuth 语义错误（已绑定=连接失效；未绑定=提示可授权）
    try {
      await client.connect();
    } catch (err) {
      if (err instanceof McpHttpError && (err.status === 401 || err.status === 403)) {
        pool.delete(key);
        void client.disconnect().catch(() => undefined);
        if (effective.oauthConnectionId) {
          throw new OAuthFailure(
            'needs_reauth',
            `MCP ${config.name} 的授权已失效，请重新授权`,
            effective.oauthConnectionId,
            err.wwwAuthenticate ?? undefined,
          );
        }
        throw new OAuthFailure(
          'needs_reauth',
          `MCP ${config.name} 需要授权（HTTP ${err.status}）`,
          undefined,
          err.wwwAuthenticate ?? undefined,
        );
      }
      throw err;
    }
```

顶部 import：

```ts
import { McpHttpError } from './http-client';
import { OAuthFailure } from '../oauth/types';
```

> 只 import `oauth/types`（叶子模块，无反向依赖）——不违反 Task 9 的依赖方向铁律。

- [ ] **Step 5: 新建 `oauth/mcp-trigger.ts`**

```ts
// electron/src/main/oauth/mcp-trigger.ts
//
// MCP 微触发（spec §9.4）：授权成功后回写绑定并驱逐池实例，
// renderer 收到 connected 事件后用既有 mcp:start 完成重连（主进程不猜 workspace）。
import { logger } from '../logger';
import { getMcpConfig, evictMcpByName, setMcpOAuthBinding } from '../mcp/host-manager';
import { beginAuthorization, type BeginResult } from './service';
import { OAuthFailure } from './types';

export async function bindConnectionToMcp(
  mcpName: string,
  connectionId: string,
  envVar: string | null = null,
): Promise<void> {
  const config = getMcpConfig(mcpName);
  if (!config) throw new OAuthFailure('no_connection', `MCP ${mcpName} 未注册`);
  setMcpOAuthBinding(mcpName, connectionId, (config.transport ?? 'stdio') === 'stdio' ? envVar : null);
  await evictMcpByName(mcpName);
  logger.info('MCP 已绑定 OAuth 连接', { name: mcpName });
}

/** 一键「授权 + 绑定」：begin 返回后由 renderer 打开浏览器，完成后走 complete 事件回写 */
export async function beginAuthorizationForMcp(
  mcpName: string,
  envVar: string | null = null,
): Promise<BeginResult & { mcpName: string; envVar: string | null }> {
  const result = await beginAuthorization({ mcpName });
  if (result.existingConnectionId) {
    await bindConnectionToMcp(mcpName, result.existingConnectionId, envVar);
  }
  return { ...result, mcpName, envVar };
}
```

> 浏览器回环完成的异步路径里，由 `oauth:authorizationChanged` 的推送消费方（IPC 层）调用 `bindConnectionToMcp`——见 Task 14。

- [ ] **Step 6: 运行测试**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/mcp/oauth-401.test.ts --pool=forks`
Expected: PASS

- [ ] **Step 7: 提交**

```bash
git add electron/src/main/mcp/http-client.ts electron/src/main/mcp/host-manager.ts \
  electron/src/main/oauth/mcp-trigger.ts electron/tests/mcp/oauth-401.test.ts
git commit -m "feat: MCP 结构化 401 与 OAuth 微触发绑定"
```

---

## Task 14: IPC + preload + 类型 + 契约锁 + boot 接线

**Files:**
- Create: `electron/src/main/oauth/ipc.handlers.ts`
- Modify: `electron/src/main/oauth/service.ts`（补完成事件）
- Modify: `electron/src/main/ipc/index.ts`
- Modify: `electron/src/main/index.ts`
- Modify: `electron/src/preload/index.ts`
- Modify: `renderer/src/ipc/types.d.ts`
- Test: `electron/tests/ipc/preload-oauth-channel-contract.test.ts`

**Interfaces:**
- Consumes: Task 9/10/11/12/13 全部服务函数
- Produces: `registerOAuthHandlers(): void`、`setAuthorizationCompleteListener(listener | null): void`、`ApiSurface.oauth`

- [ ] **Step 1: 给 `service.ts` 补「授权完成」监听（loopback 异步路径的通知口）**

```ts
// 文件顶部区域（setOAuthChangeListener 附近）追加
export type OnAuthorizationComplete = (pendingId: string, view: ConnectionView) => void;

let authorizationCompleteListener: OnAuthorizationComplete | null = null;

/** loopback 异步完成时通知 IPC 层（回写 MCP 绑定 + 推送 renderer） */
export function setAuthorizationCompleteListener(
  listener: OnAuthorizationComplete | null,
): void {
  authorizationCompleteListener = listener;
}
```

`finishAuthorization` 末尾（`return toConnectionView(stored);` 之前）：

```ts
  const view = toConnectionView(stored);
  authorizationCompleteListener?.(pendingId, view);
  return view;
```

- [ ] **Step 2: 写失败测试（源码级通道契约）**

```ts
// electron/tests/ipc/preload-oauth-channel-contract.test.ts
//
// 契约锁：oauth:* 通道在 main handler 与 preload 两侧必须一一对应。
// 与 preload-hub-channel-contract 同手法（源码文本机械比对，无需起 Electron）。
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

function read(rel: string): string {
  return fs.readFileSync(path.join(__dirname, '../../..', rel), 'utf-8');
}

function extractChannels(source: string): string[] {
  const matches = source.match(/'oauth:[A-Za-z]+'/g) ?? [];
  return [...new Set(matches.map((m) => m.slice(1, -1)))].sort();
}

describe('oauth 通道契约', () => {
  it('main handler 与 preload 两侧通道集完全一致', () => {
    const main = extractChannels(read('electron/src/main/oauth/ipc.handlers.ts'));
    const preload = extractChannels(read('electron/src/preload/index.ts'));
    expect(main.length).toBeGreaterThan(0);
    expect(preload).toEqual(main);
  });

  it('renderer 类型面声明了 oauth 命名空间', () => {
    const types = read('renderer/src/ipc/types.d.ts');
    expect(types).toContain('OAuthApiSurface');
    expect(types).toContain('oauth: OAuthApiSurface');
  });
});
```

- [ ] **Step 3: 运行确认失败**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/ipc/preload-oauth-channel-contract.test.ts`
Expected: FAIL

- [ ] **Step 4: 实现 `ipc.handlers.ts`**

```ts
// electron/src/main/oauth/ipc.handlers.ts
//
// oauth:* IPC 注册入口（thin adapter，零业务逻辑）。服务实例在 invoke 时刻解析
// （boot 顺序：registerIpcHandlers 先于 OAuth 生命周期启动）。
// 推送：oauth:authorizationChanged（流程状态）、oauth:connectionsChanged（列表刷新）。
import { ipcMain, BrowserWindow } from 'electron';
import { logger } from '../logger';
import { evictMcpsByConnection } from '../mcp/host-manager';
import {
  beginAuthorization, completeWithManualCallback, cancelAuthorization,
  listConnectionViews, getConnectionView, disconnect, removeConnection,
  setOAuthChangeListener, setAuthorizationCompleteListener,
} from './service';
import { beginAuthorizationForMcp, bindConnectionToMcp } from './mcp-trigger';
import { listPresets } from './presets';
import { OAuthFailure, type ConnectionView } from './types';

const AUTHORIZATION_CHANGED = 'oauth:authorizationChanged';
const CONNECTIONS_CHANGED = 'oauth:connectionsChanged';

/** pendingId → 绑定的 MCP（loopback 完成后回写用） */
const pendingMcpIntent = new Map<string, { mcpName: string; envVar: string | null }>();

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload);
  }
}

export function registerOAuthHandlers(): void {
  // 令牌刷新/撤销 → 扇出驱逐 + 推送列表刷新
  setOAuthChangeListener(async (connectionId, kind) => {
    try {
      await evictMcpsByConnection(connectionId);
    } catch (err) {
      logger.warn('OAuth 变更后驱逐 MCP 池失败', { error: (err as Error).message });
    }
    broadcast(CONNECTIONS_CHANGED, { at: Date.now(), connectionId, kind });
  });

  // loopback 异步完成 → 回写绑定 + 推送
  setAuthorizationCompleteListener((pendingId, view) => {
    const intent = pendingMcpIntent.get(pendingId);
    pendingMcpIntent.delete(pendingId);
    const finish = async (): Promise<void> => {
      if (intent) {
        await bindConnectionToMcp(intent.mcpName, view.id, intent.envVar);
      }
      broadcast(AUTHORIZATION_CHANGED, { pendingId, status: 'connected', connectionId: view.id });
      broadcast(CONNECTIONS_CHANGED, { at: Date.now(), connectionId: view.id, kind: 'connected' });
    };
    void finish().catch((err: unknown) => {
      broadcast(AUTHORIZATION_CHANGED, {
        pendingId,
        status: 'failed',
        error: { code: 'no_connection', message: (err as Error).message },
      });
    });
  });

  ipcMain.handle('oauth:listConnections', () => listConnectionViews());

  ipcMain.handle('oauth:getConnection', (_evt, id: string) => getConnectionView(id));

  ipcMain.handle('oauth:listPresets', () => listPresets());

  ipcMain.handle('oauth:beginAuthorization', async (_evt, input: unknown) => {
    if (typeof input !== 'object' || input === null) {
      throw new OAuthFailure('no_connection', '授权参数无效');
    }
    return beginAuthorization(input as Parameters<typeof beginAuthorization>[0]);
  });

  ipcMain.handle('oauth:beginAuthorizationForMcp', async (_evt, mcpName: string, envVar: string | null) => {
    if (typeof mcpName !== 'string' || mcpName === '') {
      throw new OAuthFailure('no_connection', 'MCP 名称不能为空');
    }
    const result = await beginAuthorizationForMcp(mcpName, envVar ?? null);
    if (result.pendingId) {
      pendingMcpIntent.set(result.pendingId, { mcpName, envVar: envVar ?? null });
    }
    return result;
  });

  ipcMain.handle(
    'oauth:completeWithManualCallback',
    async (_evt, payload: { pendingId: string; input: string }) => {
      const view: ConnectionView = await completeWithManualCallback(payload);
      const intent = pendingMcpIntent.get(payload.pendingId);
      pendingMcpIntent.delete(payload.pendingId);
      if (intent) await bindConnectionToMcp(intent.mcpName, view.id, intent.envVar);
      broadcast(AUTHORIZATION_CHANGED, {
        pendingId: payload.pendingId, status: 'connected', connectionId: view.id,
      });
      broadcast(CONNECTIONS_CHANGED, { at: Date.now(), connectionId: view.id, kind: 'connected' });
      return view;
    },
  );

  ipcMain.handle('oauth:cancelAuthorization', async (_evt, pendingId: string) => {
    pendingMcpIntent.delete(pendingId);
    await cancelAuthorization(pendingId);
    broadcast(AUTHORIZATION_CHANGED, { pendingId, status: 'cancelled' });
  });

  ipcMain.handle('oauth:disconnect', async (_evt, id: string) => disconnect(id));

  ipcMain.handle('oauth:removeConnection', async (_evt, id: string) => removeConnection(id));

  logger.info('OAuth IPC handlers 已注册');
}
```

- [ ] **Step 5: 注册 + boot 接线**

`electron/src/main/ipc/index.ts`：import 后在 `registerProviderHandlers();` 之后加一行：

```ts
  registerOAuthHandlers();
```

`electron/src/main/index.ts`：

```ts
// app.whenReady 内，wireKeychainScope(...) 之后：
  wireMcpOAuth();
  startOAuthLifecycle();
```

```ts
// before-quit 回调内：
  stopOAuthLifecycle();
```

import 语句：

```ts
import { wireMcpOAuth } from './oauth/adapters/mcp';
import { startOAuthLifecycle, stopOAuthLifecycle } from './oauth/lifecycle';
```

- [ ] **Step 6: preload 命名空间**

```ts
// electron/src/preload/index.ts —— api 对象内（mcp 命名空间之后）
  oauth: {
    listConnections: () => invoke('oauth:listConnections'),
    getConnection: (id: string) => invoke('oauth:getConnection', id),
    listPresets: () => invoke('oauth:listPresets'),
    beginAuthorization: (input: unknown) => invoke('oauth:beginAuthorization', input),
    beginAuthorizationForMcp: (mcpName: string, envVar: string | null) =>
      invoke('oauth:beginAuthorizationForMcp', mcpName, envVar),
    completeWithManualCallback: (payload: { pendingId: string; input: string }) =>
      invoke('oauth:completeWithManualCallback', payload),
    cancelAuthorization: (pendingId: string) => invoke('oauth:cancelAuthorization', pendingId),
    disconnect: (id: string) => invoke('oauth:disconnect', id),
    removeConnection: (id: string) => invoke('oauth:removeConnection', id),
    onAuthorizationChanged: (callback: (payload: AuthorizationChangedPayload) => void) => {
      const handler = (_e: IpcRendererEvent, payload: AuthorizationChangedPayload): void => callback(payload);
      ipcRenderer.on('oauth:authorizationChanged', handler);
      return () => { ipcRenderer.off('oauth:authorizationChanged', handler); };
    },
    onConnectionsChanged: (callback: (payload: { at: number }) => void) => {
      const handler = (_e: IpcRendererEvent, payload: { at: number }): void => callback(payload);
      ipcRenderer.on('oauth:connectionsChanged', handler);
      return () => { ipcRenderer.off('oauth:connectionsChanged', handler); };
    },
  },
```

同时把 `AuthorizationChangedPayload`、`OAuthApiSurface` 加入顶部 type import 列表。

- [ ] **Step 7: renderer 类型**

```ts
// renderer/src/ipc/types.d.ts —— 新接口（放在 ApiSurface 之前）
export type OAuthConnectionStatus = 'connected' | 'needs_reauth' | 'revoked';

export interface OAuthConnectionView {
  id: string;
  displayName: string;
  accountLabel: string;
  status: OAuthConnectionStatus;
  scopes: string;
  expiresAt: string | null;
  source: 'manual' | 'mcp' | 'preset';
}

export interface OAuthBeginResult {
  pendingId: string | null;
  authorizationUrl: string | null;
  redirectUri: string | null;
  existingConnectionId: string | null;
}

export interface OAuthFailurePayload {
  code: string;
  message: string;
  connectionId?: string;
  detail?: string;
}

export interface AuthorizationChangedPayload {
  pendingId: string;
  status: 'connected' | 'failed' | 'cancelled';
  connectionId?: string;
  error?: OAuthFailurePayload;
}

/** 预设携带完整端点与默认 scope——renderer 用它预填「自定义端点」表单 */
export interface OAuthProviderPresetInput {
  displayName: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  clientId: string;
  clientAuthMethod?: 'none' | 'client_secret_post' | 'client_secret_basic';
  scopes?: string;
  resource?: string | null;
  issuer?: string | null;
  revocationEndpoint?: string | null;
  userinfoEndpoint?: string | null;
  redirectHost?: string;
  redirectPort?: number | null;
  allowInsecureTls?: boolean;
  extraAuthorizeParams?: Record<string, string>;
  extraTokenParams?: Record<string, string>;
}

export interface OAuthProviderPreset {
  key: string;
  label: string;
  input: OAuthProviderPresetInput;
}

export interface OAuthApiSurface {
  listConnections(): Promise<OAuthConnectionView[]>;
  getConnection(id: string): Promise<OAuthConnectionView | null>;
  listPresets(): Promise<OAuthProviderPreset[]>;
  beginAuthorization(input: unknown): Promise<OAuthBeginResult>;
  beginAuthorizationForMcp(mcpName: string, envVar: string | null): Promise<OAuthBeginResult>;
  completeWithManualCallback(payload: { pendingId: string; input: string }): Promise<OAuthConnectionView>;
  cancelAuthorization(pendingId: string): Promise<void>;
  disconnect(id: string): Promise<{ affectedMcpNames: string[] }>;
  removeConnection(id: string): Promise<{ affectedMcpNames: string[] }>;
  onAuthorizationChanged(callback: (payload: AuthorizationChangedPayload) => void): () => void;
  onConnectionsChanged(callback: (payload: { at: number }) => void): () => void;
}
```

`ApiSurface` 内（`mcp` 之后）加：

```ts
  oauth: OAuthApiSurface;
```

MCP 视图同步加字段（`McpEditView`）：

```ts
  /** OAuth 绑定（无绑定为 undefined） */
  oauthConnectionId?: string;
  oauthEnvVar?: string;
```

- [ ] **Step 8: 运行契约测试 + 双 workspace typecheck**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/ipc/preload-oauth-channel-contract.test.ts`
Expected: PASS

Run: `npx pnpm@9.0.0 typecheck`
Expected: 0 error

- [ ] **Step 9: 提交**

```bash
git add electron/src/main/oauth/ipc.handlers.ts electron/src/main/oauth/service.ts \
  electron/src/main/ipc/index.ts electron/src/main/index.ts \
  electron/src/preload/index.ts renderer/src/ipc/types.d.ts \
  electron/tests/ipc/preload-oauth-channel-contract.test.ts
git commit -m "feat: OAuth IPC、preload 契约与 boot 接线"
```

---

## Task 15: 设置页「连接」管理（UI，P1 预览门禁）

> **门禁**：本任务属 `momo-ui-preview-rules` 的 P1（新页面 + 新组件）。**Step 1 必须先产出静态预览并取得用户确认**，未确认不得进入 Step 2。

**Files:**
- Create: `renderer/src/components/settings/ConnectionsSettings.tsx`
- Create: `renderer/src/components/settings/ConnectionsSettings.test.tsx`
- Create: `renderer/src/components/oauth/AddConnectionDialog.tsx`
- Create: `renderer/src/components/oauth/AuthorizeDialog.tsx`
- Create: `renderer/src/components/oauth/AuthorizeDialog.test.tsx`
- Modify: `renderer/src/stores/settings.store.ts`
- Modify: `renderer/src/components/settings/SettingsNav.tsx`
- Modify: `renderer/src/components/settings/SettingsView.tsx`

**Interfaces:**
- Consumes: `ipc.oauth.*`（Task 14）、`ipc.misc.openExternal`
- Produces: `<ConnectionsSettings />`、`<AddConnectionDialog onClose onCreated />`、`<AuthorizeDialog pendingId authorizationUrl redirectUri onSuccess onClose />`

- [ ] **Step 1: 静态预览（门禁）**

按 `momo-ui-preview-rules` 生成三种状态的静态预览（列表有数据 / 空态 / 授权等待弹窗），交用户确认布局与文案后再实现。

- [ ] **Step 2: 分类键与导航**

`settings.store.ts`：`SettingsCategory` 联合追加 `| 'connections'`。
`SettingsNav.tsx`：import `Link2`，在 `model_provider` 之后插入：

```tsx
  { key: 'connections', label: '连接', icon: Link2 },
```

`SettingsView.tsx`：import 组件并在内容区分支渲染 `<ConnectionsSettings />`。

- [ ] **Step 3: 写失败测试（列表 / 空态 / 断开确认）**

```tsx
// renderer/src/components/settings/ConnectionsSettings.test.tsx
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ConnectionsSettings } from './ConnectionsSettings';

const listConnections = vi.fn();
const disconnect = vi.fn();
const removeConnection = vi.fn();
const onConnectionsChanged = vi.fn(() => () => undefined);

const mockApi = {
  oauth: { listConnections, disconnect, removeConnection, onConnectionsChanged },
};

beforeEach(() => {
  vi.clearAllMocks();
  (globalThis as unknown as { window: { api: typeof mockApi } }).window.api = mockApi;
  listConnections.mockResolvedValue([]);
});

describe('ConnectionsSettings', () => {
  it('空态给出新增引导', async () => {
    render(<ConnectionsSettings />);
    expect(await screen.findByText('还没有任何授权连接')).toBeTruthy();
  });

  it('列出连接并显示状态徽标', async () => {
    listConnections.mockResolvedValue([
      { id: 'c1', displayName: 'GitHub', accountLabel: 'bearangel', status: 'connected', scopes: 'repo', expiresAt: null, source: 'manual' },
      { id: 'c2', displayName: 'Notion', accountLabel: '', status: 'needs_reauth', scopes: '', expiresAt: null, source: 'mcp' },
    ]);
    render(<ConnectionsSettings />);
    expect(await screen.findByText('GitHub')).toBeTruthy();
    expect(screen.getByText('bearangel')).toBeTruthy();
    expect(screen.getByText('需重新授权')).toBeTruthy();
  });

  it('断开需二次确认并调用 disconnect', async () => {
    listConnections.mockResolvedValue([
      { id: 'c1', displayName: 'GitHub', accountLabel: '', status: 'connected', scopes: '', expiresAt: null, source: 'manual' },
    ]);
    disconnect.mockResolvedValue({ affectedMcpNames: [] });
    render(<ConnectionsSettings />);
    fireEvent.click(await screen.findByRole('button', { name: '断开' }));
    fireEvent.click(await screen.findByRole('button', { name: '确认断开' }));
    await waitFor(() => expect(disconnect).toHaveBeenCalledWith('c1'));
  });
});
```

- [ ] **Step 4: 运行确认失败**

Run: `cd renderer && npx pnpm@9.0.0 vitest run src/components/settings/ConnectionsSettings.test.tsx`
Expected: FAIL

- [ ] **Step 5: 实现 `ConnectionsSettings.tsx`**

结构（用既有 `Button` / `Dialog` / 语义 token；图标 16px stroke 1.75）：

```tsx
// renderer/src/components/settings/ConnectionsSettings.tsx
//
// 设置 → 连接：OAuth 连接列表与生命周期操作（spec §13.1）。
// 只消费 ConnectionView（无 token）；断开/移除均二次确认，移除被引用时展示影响面并失败。
import { useEffect, useState } from 'react';
import { Link2, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { ipc } from '../../ipc/client';
import type { OAuthConnectionView } from '../../ipc/types';
import { Button } from '../ui/Button';
import { AddConnectionDialog } from '../oauth/AddConnectionDialog';

const STATUS_LABEL: Record<OAuthConnectionView['status'], string> = {
  connected: '已连接',
  needs_reauth: '需重新授权',
  revoked: '已断开',
};

export function ConnectionsSettings() {
  const [items, setItems] = useState<OAuthConnectionView[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [confirming, setConfirming] = useState<{ id: string; kind: 'disconnect' | 'remove' } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = async (): Promise<void> => {
    setItems(await ipc.oauth.listConnections());
    setLoading(false);
  };

  useEffect(() => {
    void reload();
    return ipc.oauth.onConnectionsChanged(() => { void reload(); });
  }, []);

  const runAction = async (
    fn: () => Promise<{ affectedMcpNames: string[] }>,
  ): Promise<void> => {
    setError(null);
    try {
      await fn();
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setConfirming(null);
    }
  };

  return (
    <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-medium text-primary">连接</h2>
          <p className="text-xs text-tertiary mt-1">
            OAuth 授权凭据统一在这里管理；MCP 与其他工具引用这些连接。
          </p>
        </div>
        <Button size="sm" onClick={() => setAdding(true)}>
          <Plus size={14} strokeWidth={1.75} aria-hidden />
          新增连接
        </Button>
      </div>

      {error && <div className="text-status-error text-sm">{error}</div>}

      {loading ? (
        <div className="text-sm text-tertiary">加载中…</div>
      ) : items.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-3 text-sm text-tertiary py-16">
          <Link2 size={20} strokeWidth={1.75} aria-hidden />
          还没有任何授权连接
          <Button variant="secondary" size="sm" onClick={() => setAdding(true)}>
            新增连接
          </Button>
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {items.map((item) => (
            <li
              key={item.id}
              className="rounded-md border border-subtle bg-surface-1 px-3 py-2 flex items-center gap-3"
            >
              <div className="flex flex-col min-w-0">
                <span className="text-sm text-primary truncate">{item.displayName}</span>
                <span className="text-xs text-tertiary truncate">
                  {item.accountLabel || '未命名账号'}
                  {item.scopes ? ` · ${item.scopes}` : ''}
                </span>
              </div>
              <span className="ml-auto text-xs px-2 py-0.5 rounded-full bg-surface-3 text-secondary">
                {STATUS_LABEL[item.status]}
              </span>
              <span className="text-xs text-tertiary">
                {item.expiresAt ? `到期 ${new Date(item.expiresAt).toLocaleString()}` : '长期有效'}
              </span>
              {confirming?.id === item.id ? (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-status-warning">
                    {confirming.kind === 'remove' ? '确认移除该连接？' : '确认断开该连接？'}
                  </span>
                  <Button
                    size="sm"
                    variant={confirming.kind === 'remove' ? 'danger' : 'secondary'}
                    onClick={() => {
                      const kind = confirming.kind;
                      void runAction(() =>
                        kind === 'remove'
                          ? ipc.oauth.removeConnection(item.id)
                          : ipc.oauth.disconnect(item.id),
                      );
                    }}
                  >
                    {confirming.kind === 'remove' ? '确认移除' : '确认断开'}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setConfirming(null)}>
                    取消
                  </Button>
                </div>
              ) : (
                <div className="flex items-center gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label="重新授权"
                    title="重新授权"
                    onClick={() => setAdding(true)}
                  >
                    <RefreshCw size={14} strokeWidth={1.75} aria-hidden />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label="断开"
                    onClick={() => setConfirming({ id: item.id, kind: 'disconnect' })}
                  >
                    断开
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label="移除"
                    title="移除"
                    onClick={() => setConfirming({ id: item.id, kind: 'remove' })}
                  >
                    <Trash2 size={14} strokeWidth={1.75} aria-hidden />
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {adding && (
        <AddConnectionDialog
          onClose={() => setAdding(false)}
          onCreated={() => {
            setAdding(false);
            void reload();
          }}
        />
      )}
    </div>
  );
}
```

> 授权等待弹窗由 `AddConnectionDialog` 自己持有（拿到 `authorizationUrl` 后挂载 `AuthorizeDialog`），设置页只负责列表与生命周期操作。

- [ ] **Step 6: 实现 `AuthorizeDialog.tsx`**

```tsx
// renderer/src/components/oauth/AuthorizeDialog.tsx
//
// 授权等待弹窗（spec §13.3）：展示 redirect_uri（可复制）、用系统浏览器打开授权页、
// 订阅 oauth:authorizationChanged；常驻「无法自动回调？」手动粘贴入口（容器/远程开发）。
import { useEffect, useState } from 'react';
import { Copy, KeyRound } from 'lucide-react';
import { ipc } from '../../ipc/client';
import type { AuthorizationChangedPayload } from '../../ipc/types';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { Input } from '../ui/Input';

interface Props {
  pendingId: string;
  authorizationUrl: string;
  redirectUri: string;
  onSuccess: () => void;
  onClose: () => void;
}

export function AuthorizeDialog({ pendingId, authorizationUrl, redirectUri, onSuccess, onClose }: Props) {
  const [manual, setManual] = useState('');
  const [openManual, setOpenManual] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [opened, setOpened] = useState(false);

  // 打开系统浏览器（复用既有 misc:openExternal：https 任意 + 本机回环 http）
  useEffect(() => {
    if (opened) return;
    setOpened(true);
    void ipc.misc.openExternal(authorizationUrl).catch((err: unknown) => {
      setError(err instanceof Error ? err.message : String(err));
    });
  }, [authorizationUrl, opened]);

  useEffect(() => {
    return ipc.oauth.onAuthorizationChanged((payload: AuthorizationChangedPayload) => {
      if (payload.pendingId !== pendingId) return;
      if (payload.status === 'connected') onSuccess();
      else if (payload.status === 'failed') setError(payload.error?.message ?? '授权失败');
    });
  }, [pendingId, onSuccess]);

  const submitManual = async (): Promise<void> => {
    setSubmitting(true);
    setError(null);
    try {
      await ipc.oauth.completeWithManualCallback({ pendingId, input: manual });
      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const copyRedirect = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(redirectUri);
    } catch {
      setError('复制失败，请手动选中复制');
    }
  };

  const handleClose = (): void => {
    void ipc.oauth.cancelAuthorization(pendingId).catch(() => undefined);
    onClose();
  };

  return (
    <Dialog
      open
      onClose={handleClose}
      title="等待授权"
      icon={<KeyRound size={16} strokeWidth={1.75} aria-hidden />}
      width={480}
      footer={<Button variant="ghost" onClick={handleClose}>取消</Button>}
    >
      <div className="flex flex-col gap-3 text-sm">
        <p className="text-secondary">
          {opened ? '已在浏览器中打开授权页，完成授权后会自动返回。' : '正在打开浏览器…'}
        </p>
        {error && <div className="text-status-error">{error}</div>}
        <div className="flex flex-col gap-1">
          <span className="text-xs text-tertiary">回调地址（请在你使用的授权服务中登记）</span>
          <div className="flex items-center gap-2">
            <code className="flex-1 min-w-0 truncate rounded border border-subtle bg-surface-2 px-2 py-1 text-xs text-secondary">
              {redirectUri}
            </code>
            <Button size="sm" variant="ghost" aria-label="复制回调地址" onClick={() => void copyRedirect()}>
              <Copy size={14} strokeWidth={1.75} aria-hidden />
            </Button>
          </div>
        </div>
        {openManual ? (
          <div className="flex flex-col gap-2">
            <Input
              label="粘贴浏览器地址栏的完整回调 URL（或仅 code）"
              value={manual}
              onChange={(e) => setManual(e.target.value)}
              placeholder="http://127.0.0.1:51789/callback?code=…&state=…"
            />
            <Button
              size="sm"
              disabled={submitting || manual.trim() === ''}
              onClick={() => void submitManual()}
            >
              提交
            </Button>
          </div>
        ) : (
          <button
            type="button"
            className="text-xs text-accent-600 dark:text-accent-300 underline self-start"
            onClick={() => setOpenManual(true)}
          >
            无法自动回调？手动粘贴
          </button>
        )}
      </div>
    </Dialog>
  );
}
```

同时把顶部 import 补全为：

```tsx
import { useEffect, useState } from 'react';
import { Copy, KeyRound } from 'lucide-react';
```

> 顶部 import 已在上方代码块内给出（`Copy` / `KeyRound`），实现时按预览确认的间距与文案微调，不得改变交互契约（复制、手动粘贴、取消）。

- [ ] **Step 7: `AddConnectionDialog.tsx`（三模式）**

```tsx
// renderer/src/components/oauth/AddConnectionDialog.tsx
//
// 新增连接（spec §13.2）。三模式用普通 tab 按钮（aria-pressed）实现，避免依赖
// Segmented 的既定 API；预设只做「预填」——最终统一走 manual 入参，避免为预设
// 单开一条 BeginInput 分支（减少服务层可变面）。
import { useEffect, useState } from 'react';
import { ipc } from '../../ipc/client';
import type { OAuthBeginResult, OAuthProviderPreset } from '../../ipc/types';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { Input } from '../ui/Input';
import { AuthorizeDialog } from './AuthorizeDialog';

type Mode = 'mcp' | 'preset' | 'manual';

interface Props {
  onClose: () => void;
  onCreated: () => void;
}

interface ManualForm {
  displayName: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  clientId: string;
  clientSecret: string;
  scopes: string;
  userinfoEndpoint: string;
  redirectHost: '127.0.0.1' | 'localhost';
  redirectPort: string;
  allowInsecureTls: boolean;
}

const EMPTY_FORM: ManualForm = {
  displayName: '',
  authorizationEndpoint: '',
  tokenEndpoint: '',
  clientId: '',
  clientSecret: '',
  scopes: '',
  userinfoEndpoint: '',
  redirectHost: '127.0.0.1',
  redirectPort: '',
  allowInsecureTls: false,
};

export function AddConnectionDialog({ onClose, onCreated }: Props) {
  const [mode, setMode] = useState<Mode>('manual');
  const [presets, setPresets] = useState<OAuthProviderPreset[]>([]);
  const [mcpItems, setMcpItems] = useState<Array<{ slug: string; title: string }>>([]);
  const [mcpName, setMcpName] = useState('');
  const [presetKey, setPresetKey] = useState('');
  const [form, setForm] = useState<ManualForm>(EMPTY_FORM);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [authorizing, setAuthorizing] = useState<{
    pendingId: string; authorizationUrl: string; redirectUri: string;
  } | null>(null);

  useEffect(() => {
    void ipc.oauth.listPresets().then(setPresets);
    void ipc.resource
      .list({ type: 'mcp' })
      .then((items) => setMcpItems(items.map((i) => ({ slug: i.slug, title: i.title }))));
  }, []);

  const patch = (next: Partial<ManualForm>): void => setForm((prev) => ({ ...prev, ...next }));

  const applyPreset = (key: string): void => {
    setPresetKey(key);
    const preset = presets.find((p) => p.key === key);
    if (!preset) return;
    setForm({
      ...EMPTY_FORM,
      displayName: preset.input.displayName,
      authorizationEndpoint: preset.input.authorizationEndpoint,
      tokenEndpoint: preset.input.tokenEndpoint,
      clientId: preset.input.clientId,
      scopes: preset.input.scopes ?? '',
      userinfoEndpoint: preset.input.userinfoEndpoint ?? '',
      redirectHost: preset.input.redirectHost === 'localhost' ? 'localhost' : '127.0.0.1',
      redirectPort: preset.input.redirectPort ? String(preset.input.redirectPort) : '',
      allowInsecureTls: preset.input.allowInsecureTls ?? false,
    });
  };

  const handleResult = (result: OAuthBeginResult): void => {
    if (result.existingConnectionId) {
      onCreated();
      return;
    }
    if (result.pendingId && result.authorizationUrl && result.redirectUri) {
      setAuthorizing({
        pendingId: result.pendingId,
        authorizationUrl: result.authorizationUrl,
        redirectUri: result.redirectUri,
      });
    }
  };

  const submit = async (): Promise<void> => {
    setSubmitting(true);
    setError(null);
    try {
      if (mode === 'mcp') {
        if (!mcpName) throw new Error('请选择要授权的 MCP 服务器');
        handleResult(await ipc.oauth.beginAuthorizationForMcp(mcpName, null));
        return;
      }
      if (!form.authorizationEndpoint.trim() || !form.tokenEndpoint.trim() || !form.clientId.trim()) {
        throw new Error('授权端点、令牌端点与 client_id 必填');
      }
      const port = form.redirectPort.trim() === '' ? null : Number(form.redirectPort);
      if (port !== null && (!Number.isInteger(port) || port <= 0 || port > 65535)) {
        throw new Error('回调端口必须是 1-65535 的整数');
      }
      handleResult(
        await ipc.oauth.beginAuthorization({
          manual: {
            displayName: form.displayName.trim() || '未命名连接',
            authorizationEndpoint: form.authorizationEndpoint.trim(),
            tokenEndpoint: form.tokenEndpoint.trim(),
            clientId: form.clientId.trim(),
            clientSecret: form.clientSecret.trim() || null,
            scopes: form.scopes.trim(),
            userinfoEndpoint: form.userinfoEndpoint.trim() || null,
            redirectHost: form.redirectHost,
            redirectPort: port,
            allowInsecureTls: form.allowInsecureTls,
          },
        }),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const loopbackEndpoint =
    form.authorizationEndpoint.trim().startsWith('http://127.0.0.1') ||
    form.authorizationEndpoint.trim().startsWith('http://localhost');

  return (
    <Dialog
      open
      onClose={onClose}
      title="新增 OAuth 连接"
      width={560}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>取消</Button>
          <Button
            disabled={submitting}
            onClick={() => {
              void submit();
            }}
          >
            {submitting ? '正在发起…' : '开始授权'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 text-sm">
        <div className="flex gap-1" role="tablist" aria-label="连接来源">
          {([
            ['manual', '自定义端点'],
            ['preset', '常用服务'],
            ['mcp', '从 MCP 发现'],
          ] as Array<[Mode, string]>).map(([key, label]) => (
            <Button
              key={key}
              size="sm"
              variant={mode === key ? 'secondary' : 'ghost'}
              aria-pressed={mode === key}
              onClick={() => setMode(key)}
            >
              {label}
            </Button>
          ))}
        </div>

        {error && <div className="text-status-error">{error}</div>}

        {mode === 'mcp' ? (
          <label className="flex flex-col gap-1">
            <span className="text-sm text-secondary">MCP 服务器</span>
            <select
              className="rounded-md border border-subtle bg-surface-2 px-3 py-2 text-[13px] text-primary"
              value={mcpName}
              onChange={(e) => setMcpName(e.target.value)}
            >
              <option value="">请选择…</option>
              {mcpItems.map((item) => (
                <option key={item.slug} value={item.slug}>{item.title}</option>
              ))}
            </select>
            <span className="text-xs text-tertiary">
              将从服务器的 OAuth 资源元数据自动发现授权服务器（需要该服务器声明 OAuth）。
            </span>
          </label>
        ) : (
          <div className="flex flex-col gap-2">
            {mode === 'preset' && (
              <label className="flex flex-col gap-1">
                <span className="text-sm text-secondary">服务</span>
                <select
                  className="rounded-md border border-subtle bg-surface-2 px-3 py-2 text-[13px] text-primary"
                  value={presetKey}
                  onChange={(e) => applyPreset(e.target.value)}
                >
                  <option value="">请选择…</option>
                  {presets.map((p) => (
                    <option key={p.key} value={p.key}>{p.label}</option>
                  ))}
                </select>
              </label>
            )}
            <Input label="名称" value={form.displayName} onChange={(e) => patch({ displayName: e.target.value })} />
            <Input
              label="授权端点"
              value={form.authorizationEndpoint}
              placeholder="https://…/authorize"
              onChange={(e) => patch({ authorizationEndpoint: e.target.value })}
            />
            <Input
              label="令牌端点"
              value={form.tokenEndpoint}
              placeholder="https://…/token"
              onChange={(e) => patch({ tokenEndpoint: e.target.value })}
            />
            <Input label="Client ID" value={form.clientId} onChange={(e) => patch({ clientId: e.target.value })} />
            <Input
              label="Client Secret（可空；公共客户端留空）"
              type="password"
              value={form.clientSecret}
              onChange={(e) => patch({ clientSecret: e.target.value })}
            />
            <Input label="Scope（空格分隔）" value={form.scopes} onChange={(e) => patch({ scopes: e.target.value })} />
            <Input
              label="用户信息端点（可空，用于回填账号名）"
              value={form.userinfoEndpoint}
              placeholder="https://…/userinfo"
              onChange={(e) => patch({ userinfoEndpoint: e.target.value })}
            />
            <div className="flex items-end gap-2">
              <label className="flex flex-col gap-1">
                <span className="text-sm text-secondary">回调主机</span>
                <select
                  className="rounded-md border border-subtle bg-surface-2 px-3 py-2 text-[13px] text-primary"
                  value={form.redirectHost}
                  onChange={(e) => patch({ redirectHost: e.target.value === 'localhost' ? 'localhost' : '127.0.0.1' })}
                >
                  <option value="127.0.0.1">127.0.0.1</option>
                  <option value="localhost">localhost</option>
                </select>
              </label>
              <Input
                label="回调端口（留空=随机）"
                value={form.redirectPort}
                onChange={(e) => patch({ redirectPort: e.target.value })}
              />
            </div>
            {loopbackEndpoint && (
              <label className="flex items-center gap-2 text-xs text-secondary">
                <input
                  type="checkbox"
                  checked={form.allowInsecureTls}
                  onChange={(e) => patch({ allowInsecureTls: e.target.checked })}
                />
                忽略自签证书（仅本地开发）
              </label>
            )}
          </div>
        )}
      </div>

      {authorizing && (
        <AuthorizeDialog
          pendingId={authorizing.pendingId}
          authorizationUrl={authorizing.authorizationUrl}
          redirectUri={authorizing.redirectUri}
          onSuccess={onCreated}
          onClose={() => setAuthorizing(null)}
        />
      )}
    </Dialog>
  );
}
```

> 说明：`ipc.resource.list({ type: 'mcp' })` 返回项含 `slug` / `title`（既有资源库列表契约）；非远程条目在选择后由服务层给出明确中文错误，不在 UI 预先猜测 transport。

- [ ] **Step 8: 运行 renderer 测试**

Run: `cd renderer && npx pnpm@9.0.0 vitest run src/components/settings/ConnectionsSettings.test.tsx src/components/oauth`
Expected: PASS

- [ ] **Step 9: 提交**

```bash
git add renderer/src/components/settings/ConnectionsSettings.tsx \
  renderer/src/components/settings/ConnectionsSettings.test.tsx \
  renderer/src/components/oauth/AddConnectionDialog.tsx \
  renderer/src/components/oauth/AuthorizeDialog.tsx \
  renderer/src/components/oauth/AuthorizeDialog.test.tsx \
  renderer/src/stores/settings.store.ts \
  renderer/src/components/settings/SettingsNav.tsx \
  renderer/src/components/settings/SettingsView.tsx
git commit -m "feat: 设置页 OAuth 连接管理与授权弹窗"
```

---

## Task 16: MCP 弹窗认证区块 + 授权横幅 + `McpConfigDialog` https 修正

> **门禁**：新增 UI 区块属 P1，先出预览确认。

**Files:**
- Create: `renderer/src/lib/url-guard.ts`
- Create: `renderer/src/components/oauth/McpAuthSection.tsx`
- Create: `renderer/src/components/oauth/McpAuthSection.test.tsx`
- Modify: `renderer/src/components/resource-library/McpConfigDialog.tsx`
- Modify: `renderer/src/components/agent/RegisterMcpDialog.tsx`
- Modify: `electron/src/main/resource/mcp-config.ts`（`McpEditView` 补两字段）
- Modify: `electron/src/main/oauth/ipc.handlers.ts`（`oauth:unbindMcp`）
- Modify: `electron/src/main/oauth/mcp-trigger.ts`（`unbindMcpOAuth`）
- Modify: `electron/src/preload/index.ts` + `renderer/src/ipc/types.d.ts`（`oauth:unbindMcp`）
- Test: `renderer/src/components/resource-library/McpConfigDialog.test.tsx`（补 http 回环用例）

**Interfaces:**
- Consumes: `ipc.oauth.beginAuthorizationForMcp` / `unbindMcp` / `listConnections`
- Produces: `<McpAuthSection mcpName transport connectionId envVar onChange />`；`isHttpsOrLoopbackHttp(url)`（renderer 镜像）

- [ ] **Step 1: 静态预览（门禁）**

出 MCP 配置弹窗「认证」区块的三种状态预览：未绑定 / 已绑定已连接 / 需重新授权。

- [ ] **Step 2: renderer URL 守卫镜像 + `McpConfigDialog` 修正**

```ts
// renderer/src/lib/url-guard.ts
// 与 electron/src/main/util/url-guard.ts 同构（双端契约）：https 任意 + http 仅回环。
export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '0.0.0.0';
}

export function isHttpsOrLoopbackHttp(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'https:') return true;
    return parsed.protocol === 'http:' && isLoopbackHost(parsed.hostname);
  } catch {
    return false;
  }
}
```

`McpConfigDialog.tsx`：`canSubmit` 改

```ts
  const canSubmit = isHttpsOrLoopbackHttp(url.trim()) && !missingRequired && !lockAll;
```

并更新文件头注释（原文写「url 非 https 禁提交」，改为「非 https 且非回环 http 禁提交」）。测试补：

```tsx
  it('允许 http://127.0.0.1 端点提交，拒绝 http://example.com', async () => {
    // getMcpConfig 返回 bare=true + url=http://127.0.0.1:8080/mcp
    // 填写后提交按钮可用；改为 http://example.com 后禁用
  });
```

- [ ] **Step 3: 写失败测试（认证区块）**

```tsx
// renderer/src/components/oauth/McpAuthSection.test.tsx
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { McpAuthSection } from './McpAuthSection';

const listConnections = vi.fn();
const beginAuthorizationForMcp = vi.fn();
const unbindMcp = vi.fn();
const openExternal = vi.fn();
const mockApi = {
  oauth: { listConnections, beginAuthorizationForMcp, unbindMcp },
  misc: { openExternal },
};

beforeEach(() => {
  vi.clearAllMocks();
  (globalThis as unknown as { window: { api: typeof mockApi } }).window.api = mockApi;
  listConnections.mockResolvedValue([
    { id: 'c1', displayName: 'GitHub', accountLabel: 'bearangel', status: 'connected', scopes: '', expiresAt: null, source: 'manual' },
  ]);
});

describe('McpAuthSection', () => {
  it('未绑定时展示「授权」按钮，点击发起 beginAuthorizationForMcp 并打开浏览器', async () => {
    beginAuthorizationForMcp.mockResolvedValue({
      pendingId: 'p1',
      authorizationUrl: 'https://auth.example.com/authorize?x=1',
      redirectUri: 'http://127.0.0.1:51789/callback',
      existingConnectionId: null,
    });
    const onChange = vi.fn();
    render(<McpAuthSection mcpName="gh" transport="streamable_http" connectionId={undefined} envVar={undefined} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: '授权' }));
    await waitFor(() => expect(beginAuthorizationForMcp).toHaveBeenCalledWith('gh', null));
  });

  it('已绑定时展示连接名与「解除绑定」', async () => {
    unbindMcp.mockResolvedValue(undefined);
    const onChange = vi.fn();
    render(<McpAuthSection mcpName="gh" transport="streamable_http" connectionId="c1" envVar={undefined} onChange={onChange} />);
    expect(await screen.findByText(/GitHub/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '解除绑定' }));
    await waitFor(() => expect(unbindMcp).toHaveBeenCalledWith('gh'));
  });

  it('stdio 且未填环境变量名时授权按钮禁用并提示', () => {
    render(<McpAuthSection mcpName="local" transport="stdio" connectionId={undefined} envVar={undefined} onChange={vi.fn()} />);
    expect(screen.getByText('请先填写注入的环境变量名')).toBeTruthy();
  });
});
```

- [ ] **Step 4: 运行确认失败**

Run: `cd renderer && npx pnpm@9.0.0 vitest run src/components/oauth/McpAuthSection.test.tsx`
Expected: FAIL

- [ ] **Step 5: 实现 `McpAuthSection.tsx`**

```tsx
// renderer/src/components/oauth/McpAuthSection.tsx
//
// MCP 弹窗「认证」区块（spec §13.4）：OAuth 开关 + 连接选择 + 一键授权 + 状态徽标。
// 授权成功后由主进程回写绑定并驱逐池；本组件通过 onChange 通知父弹窗刷新回显，
// 父弹窗负责用既有 mcp:start 完成重连（当前 workspace 上下文在父层）。
import { useEffect, useState } from 'react';
import { KeyRound } from 'lucide-react';
import { ipc } from '../../ipc/client';
import type { OAuthConnectionView } from '../../ipc/types';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { AuthorizeDialog } from './AuthorizeDialog';

interface Props {
  mcpName: string;
  transport: 'stdio' | 'streamable_http';
  connectionId?: string;
  envVar?: string;
  onChange: (next: { connectionId: string; envVar: string }) => void;
  onAuthorized?: () => void;
}

export function McpAuthSection({ mcpName, transport, connectionId, envVar, onChange, onAuthorized }: Props) {
  const [connections, setConnections] = useState<OAuthConnectionView[]>([]);
  const [authorizing, setAuthorizing] = useState<{ pendingId: string; authorizationUrl: string; redirectUri: string } | null>(null);
  const [envDraft, setEnvDraft] = useState(envVar ?? '');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void ipc.oauth.listConnections().then(setConnections);
  }, []);

  const missingEnvVar = transport === 'stdio' && envDraft.trim() === '';
  const bound = connectionId ? connections.find((c) => c.id === connectionId) : undefined;

  const authorize = async (): Promise<void> => {
    setError(null);
    try {
      const result = await ipc.oauth.beginAuthorizationForMcp(mcpName, envDraft.trim() || null);
      if (result.existingConnectionId) {
        onChange({ connectionId: result.existingConnectionId, envVar: envDraft });
        onAuthorized?.();
        return;
      }
      if (result.pendingId && result.authorizationUrl && result.redirectUri) {
        setAuthorizing({
          pendingId: result.pendingId,
          authorizationUrl: result.authorizationUrl,
          redirectUri: result.redirectUri,
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const unbind = async (): Promise<void> => {
    setError(null);
    try {
      await ipc.oauth.unbindMcp(mcpName);
      onChange({ connectionId: '', envVar: envDraft });
      onAuthorized?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const statusLabel = bound
    ? bound.status === 'connected'
      ? '已连接'
      : bound.status === 'needs_reauth'
        ? '需重新授权'
        : '已断开'
    : '';

  return (
    <div className="flex flex-col gap-2 rounded-md border border-subtle bg-surface-1 px-3 py-2">
      <div className="flex items-center gap-2 text-sm text-primary">
        <KeyRound size={16} strokeWidth={1.75} aria-hidden />
        认证
      </div>

      {bound ? (
        <div className="flex items-center gap-2 text-xs text-secondary">
          <span className="truncate">
            {bound.displayName}
            {bound.accountLabel ? ` · ${bound.accountLabel}` : ''}
          </span>
          <span className="px-2 py-0.5 rounded-full bg-surface-3">{statusLabel}</span>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              void unbind();
            }}
          >
            解除绑定
          </Button>
        </div>
      ) : (
        <div className="flex items-center gap-2 text-xs text-tertiary flex-wrap">
          未绑定 OAuth 连接
          <Button
            size="sm"
            variant="secondary"
            disabled={missingEnvVar}
            onClick={() => {
              void authorize();
            }}
          >
            授权
          </Button>
          {missingEnvVar && <span className="text-status-warning">请先填写注入的环境变量名</span>}
        </div>
      )}

      {transport === 'stdio' && (
        <Input
          label="注入的环境变量名"
          value={envDraft}
          placeholder="GITHUB_TOKEN"
          onChange={(e) => {
            setEnvDraft(e.target.value);
            onChange({ connectionId: connectionId ?? '', envVar: e.target.value });
          }}
        />
      )}

      {error && <div className="text-status-error text-xs">{error}</div>}

      {authorizing && (
        <AuthorizeDialog
          pendingId={authorizing.pendingId}
          authorizationUrl={authorizing.authorizationUrl}
          redirectUri={authorizing.redirectUri}
          onSuccess={() => {
            setAuthorizing(null);
            void ipc.oauth.listConnections().then(setConnections);
            onAuthorized?.();
          }}
          onClose={() => setAuthorizing(null)}
        />
      )}
    </div>
  );
}
```

- [ ] **Step 6: 主进程补 `unbindMcp` 与编辑视图字段**

`oauth/mcp-trigger.ts` 追加：

```ts
/** 解除绑定（清两列 + 驱逐池）；不影响连接本身 */
export async function unbindMcpOAuth(mcpName: string): Promise<void> {
  const config = getMcpConfig(mcpName);
  if (!config) throw new OAuthFailure('no_connection', `MCP ${mcpName} 未注册`);
  setMcpOAuthBinding(mcpName, null, null);
  await evictMcpByName(mcpName);
}
```

`oauth/ipc.handlers.ts` 追加（并在 preload / types.d.ts 同步）：

```ts
  ipcMain.handle('oauth:unbindMcp', async (_evt, mcpName: string) => {
    if (typeof mcpName !== 'string' || mcpName === '') {
      throw new OAuthFailure('no_connection', 'MCP 名称不能为空');
    }
    await unbindMcpOAuth(mcpName);
    broadcast('oauth:connectionsChanged', { at: Date.now() });
  });
```

`resource/mcp-config.ts`：**两个视图都补字段**（`McpConfigView` 供 `McpConfigDialog`、`McpEditView` 供 `RegisterMcpDialog`）：

```ts
// 两个 interface 内各加：
  /** OAuth 绑定（无绑定为 undefined） */
  oauthConnectionId?: string;
  oauthEnvVar?: string;
```

`getMcpConfigView` 与 `getMcpEditView` 的返回对象各加：

```ts
    oauthConnectionId: (def as RegisteredMcp).oauthConnectionId,
    oauthEnvVar: (def as RegisteredMcp).oauthEnvVar,
```

`renderer/src/ipc/types.d.ts` 的 `McpConfigView` / `McpEditView` 镜像同步这两行。

- [ ] **Step 7: 接入两个弹窗**

`McpConfigDialog.tsx`：

```tsx
// 组件内新增状态
const [oauthConnectionId, setOauthConnectionId] = useState<string | undefined>(undefined);
const [oauthEnvVar, setOauthEnvVar] = useState<string | undefined>(undefined);

// 挂载回填（既有 getMcpConfig .then 内）
setOauthConnectionId(v.oauthConnectionId);
setOauthEnvVar(v.oauthEnvVar);

// 表单末尾（headers 区下方）
{view && (
  <McpAuthSection
    mcpName={name}
    transport={view.transport}
    connectionId={oauthConnectionId}
    envVar={oauthEnvVar}
    onChange={(next) => {
      setOauthConnectionId(next.connectionId || undefined);
      setOauthEnvVar(next.envVar || undefined);
    }}
  />
)}
```

`RegisterMcpDialog.tsx`：
- `edit` 态回填 `oauthConnectionId` / `oauthEnvVar`（来自 `resource.getMcpEditView`）
- HTTP 态与 stdio 高级区各渲染 `McpAuthSection`（props 同上，`onAuthorized` 中重新 `mcp.start`）
- 提交时 `mcp.start` 失败的错误要保留 `code`：`normalizeIpcError` 已剥前缀，但 code 在 `OAuthFailure` 的 message 之外——采用约定：主进程错误文案以 `[needs_reauth]` 前缀开头，renderer 侧解析前缀设置 `errorCode`。**更稳的做法**：`mcp:start` 在 host-manager 抛 `OAuthFailure` 时，错误 message 以 `MCP 需要授权` 开头，renderer 用该前缀判定。

```tsx
  // 错误区（既有 error 渲染处旁边）
  {errorCode === 'needs_reauth' && (
    <div className="text-status-warning text-sm flex items-center gap-2">
      该服务器需要 OAuth 授权
      <Button size="sm" variant="secondary" onClick={() => void authorizeAndRetry()}>去授权</Button>
    </div>
  )}
```

`authorizeAndRetry`：

```tsx
  const authorizeAndRetry = async (): Promise<void> => {
    const result = await ipc.oauth.beginAuthorizationForMcp(
      edit ? edit.name : trimmedName,
      oauthEnvVar ?? null,
    );
    if (result.existingConnectionId) {
      await ipc.mcp.start(activeWorkspaceId, edit ? edit.name : trimmedName);
      onSuccess();
      return;
    }
    if (result.pendingId && result.authorizationUrl && result.redirectUri) {
      setAuthorizing({
        pendingId: result.pendingId,
        authorizationUrl: result.authorizationUrl,
        redirectUri: result.redirectUri,
      });
    }
  };
```

- [ ] **Step 8: 运行测试**

Run: `cd renderer && npx pnpm@9.0.0 vitest run src/components/oauth src/components/resource-library/McpConfigDialog.test.tsx src/components/agent/RegisterMcpDialog.test.tsx`
Expected: PASS

Run: `npx pnpm@9.0.0 typecheck`
Expected: 0 error

- [ ] **Step 9: 提交**

```bash
git add renderer/src/lib/url-guard.ts renderer/src/components/oauth/McpAuthSection.tsx \
  renderer/src/components/oauth/McpAuthSection.test.tsx \
  renderer/src/components/resource-library/McpConfigDialog.tsx \
  renderer/src/components/resource-library/McpConfigDialog.test.tsx \
  renderer/src/components/agent/RegisterMcpDialog.tsx \
  electron/src/main/resource/mcp-config.ts electron/src/main/oauth/ipc.handlers.ts \
  electron/src/main/oauth/mcp-trigger.ts electron/src/preload/index.ts \
  renderer/src/ipc/types.d.ts
git commit -m "feat: MCP 弹窗 OAuth 认证区块与授权微触发"
```

---

## Task 17: 插件扩展点 `ctx.oauth`（只读）

**Files:**
- Create: `electron/src/main/plugin/oauth-ctx.ts`
- Modify: `electron/src/main/plugin/service-manager.ts`
- Test: `electron/tests/plugin/oauth-ctx.test.ts`

**Interfaces:**
- Consumes: Task 9 `listConnectionViews`；Task 3 `loadTokenSet`
- Produces:
  - `interface PluginOAuthApi { listConnections(): Promise<Array<{id;displayName;accountLabel;status;expiresAt}>>; getAccessToken(connectionId: string): Promise<string | null> }`
  - `buildPluginOAuthApi(): PluginOAuthApi`
  - `PluginServiceCtx.oauth: PluginOAuthApi`

- [ ] **Step 1: 写失败测试**

```ts
// electron/tests/plugin/oauth-ctx.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runMigrations, closeDb } from '../../src/main/storage/db';
import { setKeychainImpl, __resetKeychainImplForTest } from '../../src/main/storage/keychain';
import { insertConnection } from '../../src/main/oauth/store';
import { saveTokenSet } from '../../src/main/oauth/keys';
import { buildPluginOAuthApi } from '../../src/main/plugin/oauth-ctx';

const tmpRoot = path.join(os.tmpdir(), `ap-plugin-oauth-${Date.now()}-${process.pid}`);

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  const vault = new Map<string, string>();
  setKeychainImpl({
    setSecret: async (k, v) => { vault.set(k, v); },
    getSecret: async (k) => vault.get(k) ?? null,
    deleteSecret: async (k) => { vault.delete(k); },
  });
});

afterEach(() => {
  __resetKeychainImplForTest();
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

describe('buildPluginOAuthApi', () => {
  it('listConnections 只返回元数据（无 token 字段）', async () => {
    const conn = insertConnection({
      providerKey: 'pk',
      displayName: 'GitHub',
      authorizationEndpoint: 'https://a/auth',
      tokenEndpoint: 'https://a/token',
      clientId: 'cid',
      accountLabel: 'bearangel',
    });
    await saveTokenSet(conn.id, {
      accessToken: 'secret-at', refreshToken: null, expiresAt: null, tokenType: 'Bearer', scope: null,
    });
    const api = buildPluginOAuthApi();
    const list = await api.listConnections();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: conn.id, displayName: 'GitHub', accountLabel: 'bearangel' });
    expect(JSON.stringify(list)).not.toContain('secret-at');
    expect(Object.keys(list[0])).not.toContain('accessToken');
  });

  it('getAccessToken 返回 token；未知 id 返回 null', async () => {
    const conn = insertConnection({
      providerKey: 'pk2',
      displayName: 'X',
      authorizationEndpoint: 'https://b/auth',
      tokenEndpoint: 'https://b/token',
      clientId: 'cid',
    });
    await saveTokenSet(conn.id, {
      accessToken: 'at-1', refreshToken: null, expiresAt: null, tokenType: 'Bearer', scope: null,
    });
    const api = buildPluginOAuthApi();
    expect(await api.getAccessToken(conn.id)).toBe('at-1');
    expect(await api.getAccessToken('missing')).toBeNull();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/plugin/oauth-ctx.test.ts --pool=forks`
Expected: FAIL

- [ ] **Step 3: 实现 `plugin/oauth-ctx.ts`**

```ts
// electron/src/main/plugin/oauth-ctx.ts
//
// 插件 ctx.oauth（spec §12.3，本轮只读）。
// 信任边界：getAccessToken 把 token 交给插件 service 进程，语义等价 ctx.secrets——
// 插件是用户本地安装的代码，已有同级别能力；文档必须明示。
import { listConnectionViews } from '../oauth/service';
import { loadTokenSet } from '../oauth/keys';

export interface PluginOAuthConnectionSummary {
  id: string;
  displayName: string;
  accountLabel: string;
  status: 'connected' | 'needs_reauth' | 'revoked';
  expiresAt: string | null;
}

export interface PluginOAuthApi {
  listConnections(): Promise<PluginOAuthConnectionSummary[]>;
  /** 注意：token 跨进程暴露，信任级别等价 ctx.secrets */
  getAccessToken(connectionId: string): Promise<string | null>;
}

export function buildPluginOAuthApi(): PluginOAuthApi {
  return {
    listConnections: async () =>
      listConnectionViews().map((c) => ({
        id: c.id,
        displayName: c.displayName,
        accountLabel: c.accountLabel,
        status: c.status,
        expiresAt: c.expiresAt,
      })),
    getAccessToken: async (connectionId) => {
      const set = await loadTokenSet(connectionId);
      return set?.accessToken ?? null;
    },
  };
}
```

- [ ] **Step 4: 注入到 `PluginServiceCtx`**

`service-manager.ts`：

```ts
import { buildPluginOAuthApi, type PluginOAuthApi } from './oauth-ctx';
```

`PluginServiceCtx` 增字段：

```ts
  oauth: PluginOAuthApi;
```

ctx 构造对象内、`secrets` 之后：

```ts
      oauth: buildPluginOAuthApi(),
```

- [ ] **Step 5: 运行测试 + typecheck**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/plugin/oauth-ctx.test.ts --pool=forks`
Expected: PASS

Run: `npx pnpm@9.0.0 typecheck`
Expected: 0 error

- [ ] **Step 6: 提交**

```bash
git add electron/src/main/plugin/oauth-ctx.ts electron/src/main/plugin/service-manager.ts \
  electron/tests/plugin/oauth-ctx.test.ts
git commit -m "feat: 插件 ctx.oauth 只读扩展点"
```

---

## Task 18: 全量验证与 App 级验收

**Files:**
- 无新增代码；产出 `.omo/qa-reports/` 验收报告

**Interfaces:**
- Consumes: Task 1-17 全部
- Produces: 验收结论（通过 / 问题清单）

- [ ] **Step 1: 静态检查与全量测试**

```bash
nvm use 24
npx pnpm@9.0.0 typecheck
npx pnpm@9.0.0 lint
npx pnpm@9.0.0 test
```

Expected: 全部 0 error / 全部通过。若有 vitest 非正常退出（139/137），按 AGENTS.md 清理孤儿 worker。

- [ ] **Step 2: 构建**

```bash
npx pnpm@9.0.0 build
```

Expected: exit 0。

- [ ] **Step 3: App 级验收（按 `momo-acceptance` 隔离实例 + CDP）**

| # | 场景 | 期望 |
|---|---|---|
| A1 | 设置 → 连接 → 新增 → 自定义端点（指向本地 http AS） | 弹出授权等待对话框，`redirect_uri` 可复制，浏览器打开授权页 |
| A2 | 完成授权（或手动粘贴回调 URL） | 连接列表出现该连接，状态「已连接」 |
| A3 | MCP 配置弹窗绑定该连接 → 保存 → 启动 | 服务器连接成功，工具可列出 |
| A4 | 撤销连接 | 连接状态「已断开」，引用它的 MCP 启动报「授权已失效」并提供「去授权」 |
| A5 | 断开后重新授权同一 provider | 复用检查生效或新建连接（取决于 provider_key），MCP 可再次启动 |
| A6 | 重启 App | 连接仍在，MCP 免登录可用 |
| A7 | MCP 未绑定 + 服务器返回 401 | 提交时出现「该服务器需要 OAuth 授权 + 去授权」 |
| A8 | 固定端口被占用 | 报「回调端口 N 已被占用」，不静默改用随机端口 |
| A9 | 手动回调：粘贴错误 state | 拒绝并提示，pending 仍可重试 |
| A10 | `http://example.com` 作为授权端点 | 报「必须使用 https://（本机回环可用 http://）」 |

- [ ] **Step 4: 日志/脱敏抽查**

在 A1-A7 期间检查 `~/.momo-studio/logs/`（或隔离实例目录）：不得出现 `access_token` / `refresh_token` / `client_secret` 字面值；`Authorization:` 后应为脱敏形态。

- [ ] **Step 5: 产出报告**

写入 `.omo/qa-reports/2026-11-10-oauth-module.md`：环境（App 版本 / commit）、逐项结论（通过 / 失败 + 复现步骤 + 截图路径）、遗留问题清单。

- [ ] **Step 6: 提交**

```bash
git add .omo/qa-reports/2026-11-10-oauth-module.md
git commit -m "test: OAuth 模块 App 级验收报告"
```

> `.omo/` 若被 gitignore，则只保留本地报告，不提交。

---

## 已知偏差与待确认项（spec erratum）

1. **`provider_key` 的 client_id 段**：spec §6.5 定义为 `identity|client_id|resource|scopes`。MCP 动态注册（DCR）分支在**注册之前**计算 key，此时 `client_id` 为空串——这是为了让同一 MCP 第二次授权能命中复用（否则每次 DCR 都产生新 client_id，永不复用）。后果：DCR 连接行的 `client_id` 列有值，而 `provider_key` 中该段为空。手工端点路径完全符合 spec。建议在 spec 补一句「DCR 分支的 key 在注册前定型，client_id 段为空」，实现按本计划执行。**若要求严格按字面，需改为注册后再算 key 并放弃 MCP 复用**——不推荐。
2. **Task 11 与 Task 12 的执行顺序**：适配器依赖 `setMcpAuthResolver`，若按编号顺序执行，先落 Task 12 的 Step 1-4。

---

## 自检（写作者已完成）

**1. Spec 覆盖**

| Spec 章节 | 对应任务 |
|---|---|
| §6 域模型 / 数据落点 | Task 2、3 |
| §7 协议内核（七模块） | Task 4、5、6、7、8 |
| §8 授权流程（含手动回调） | Task 9 |
| §9 适配器 / 注入 / 401 / 微触发 / 扇出驱逐 | Task 11、12、13 |
| §10 本地研发支持（scheme / 固定端口 / 手动回调 / TLS / 复制 redirect） | Task 1、8、9、15、16 |
| §11 生命周期 | Task 10 |
| §12 IPC / preload / 插件 | Task 14、17 |
| §13 UI 四处 | Task 15、16 |
| §14 安全不变量 | Task 1、4、6、8、9、10、18 |
| §15 错误码 | Task 3（定义）、9、10、12、13（使用） |
| §16 测试策略 | 各任务内嵌 + Task 18 |
| §17 分期 | Task 1-18 按 P1→P4 顺序 |

**2. 占位符扫描**：无 TBD/TODO/待补代码。三个 UI 组件（ConnectionsSettings / AuthorizeDialog / AddConnectionDialog / McpAuthSection）均给出完整可粘贴的 JSX 与交互处理；视觉间距与文案在 Task 15/16 的 Step 1 预览门禁中定稿，实现不得改变交互契约。

**3. 类型一致性**：`OAuthFailure.code` 全任务同源；`AuthMaterial` / `AuthRequirement` / `ConnectionView` 仅在 Task 3 定义；`setMcpAuthResolver` 在 Task 12 定义、Task 11/13/14 使用；`beginAuthorizationForMcp` 签名在 Task 13 定义、Task 14/16 使用，参数 `(mcpName, envVar)` 保持一致。

**4. Review Focus 覆盖**

| 焦点 | 归属任务 |
|---|---|
| 回调缺 code / state 不匹配 / 重放 / 路径不符 | Task 8（单测）、Task 9（pending 不消耗） |
| 固定端口冲突不回落 | Task 8（单测） |
| 刷新响应缺 refresh_token / expires_in 缺失 | Task 5、Task 10（单测） |
| 同连接多 MCP 扇出驱逐 | Task 12（双 workspace 用例） |
| 非 loopback http 端点（含 discovery 结果） | Task 4、Task 6（单测） |
| keychain 不可用 | Task 9（写入失败 → `keychain_unavailable` + 回滚行） |

---

## 执行方式

计划已保存。请审阅后选择执行方式：

- **Subagent-driven（推荐）**：18 个任务存在明确的前后依赖（协议层 → 编排 → MCP 接入 → UI），逐任务独立实现 + 独立审查能把「契约漂移」挡在早期；代价是每任务一份新上下文。
- **Native**：我在本会话按顺序实现全部任务，最后统一审查；最快，但中途的错误要到最后才暴露。

推荐 **Subagent-driven**：本计划跨 30+ 文件、涉及两个 workspace 的 IPC 契约镜像，单点漂移会被 typecheck 抓住但语义漂移（如通道三处不一致、池驱逐漏扇出）需要独立审查拦截。

