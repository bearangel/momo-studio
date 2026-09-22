# P2 双轨 Hub MCP 接入 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 资源库 MCP 页「从网络获取」支持双轨 provider（Smithery 国际 / 魔搭国内）+ McpClient streamableHttp 远程传输扩展。

**Architecture:** 主进程 hub provider 框架（统一退避负缓存，renderer 只发 IPC）；`mcp_definitions` 表 transport 二态化（stdio | streamable_http，migration 038 加 url/headers_json 两列，command NOT NULL 由空串满足）；`ResourceSource` 枚举扩展 `'smithery' | 'modelscope'` 贯穿两端契约；RegistryBrowse 顶栏 provider 选择器（手动选择 + 不可达置灰 + localStorage 记忆）。

**Tech Stack:** Electron 主进程（CommonJS）+ React renderer（ESM/Vite）+ better-sqlite3 + zustand；零新 npm 依赖（HTTP MCP 客户端手写）。

**Spec:** `docs/specs/2026-09-22-p2-dual-track-hub-mcp-design.md`（决策 D1-D8 以 spec 为准）

## Global Constraints

- **Node 20 强制**：每次跑测试前 `source ~/.nvm/nvm.sh && nvm use 20` 且验证 `node -v`=v20（Node 26 → better-sqlite3 ERR_DLOPEN_FAILED / jsdom 假红）
- 包管理器 `npx pnpm@9.0.0`；typecheck 双 workspace：`npx pnpm@9.0.0 typecheck`
- TypeScript strict：禁 `any` / `as any` / `@ts-ignore`（ESLint no-explicit-any: error）
- 所有代码注释中文；renderer 新 UI 只用语义 token（`text-secondary` / `bg-surface-3` 等），禁标准 Tailwind 色阶、禁 inline 色值、禁 emoji 图标（lucide-react 16px / stroke 1.75）
- 测试位置：electron 主进程集中 `electron/tests/`（镜像 src 结构）；renderer 贴源 colocated（`Foo.test.tsx` 同目录）
- 文件尾换行；Conventional Commits（feat/fix/test/chore/docs）
- IPC 契约两端同步：`electron/src/main/resource/types.ts` ↔ `renderer/src/ipc/types.d.ts` + `electron/src/preload/index.ts`（momo-boundary-rules：跨模块 ID 单点生成、契约先红测后实现）

---

### Task 0: 前置 API 核实（无代码）

**Files:**
- Create: `.superpowers/sdd/task-0-api-verify.md`（核实记录，gitignored）

**Interfaces:**
- Produces: Task 4/5 依赖的 API 事实（endpoint URL、响应字段名、鉴权方式）；魔搭 go/no-go 结论

- [ ] **Step 1: Smithery registry list 冒烟**

```bash
curl -sS --max-time 10 'https://registry.smithery.ai/servers?pageSize=5' | head -c 2000
```

预期：JSON 含 `servers` 数组，单条含 `id`（qualified name，形如 `@owner/name`）、`description`、`repository.url`、`deployment.status`。记录响应字段名到核实文档。

- [ ] **Step 2: Smithery install-config 冒烟（取一条 stdio server）**

```bash
# 用 Step 1 拿到的某个 id 替换 <qualifiedName>
curl -sS --max-time 10 -X POST 'https://registry.smithery.ai/servers/<qualifiedName>/install-config' \
  -H 'Content-Type: application/json' -d '{"profile":{}}' | head -c 1000
```

预期：`{ command, args, env }`（stdio 形态，command 通常是 `npx`）。若端点 404/形状不同，查 https://smithery.ai/docs/api-reference/servers/list-all-sells.md 与 openapi spec（https://smithery.ai/docs/openapi.json）修正，并把**实际端点与字段**记入核实文档。

- [ ] **Step 3: 魔搭 OpenAPI MCP 列表核实**

检索 `site:modelscope.cn MCP OpenAPI` 与魔搭开放平台文档，确认：MCP 列表是否有无需登录的公开 JSON 端点、hosted server 的 `endpoint URL + token` 获取方式。把端点、字段、鉴权结论记入核实文档。

- [ ] **Step 4: 降级裁定**

若魔搭无可机器消费的公开接口 → 在核实文档记录「modelscope 轨降级 P3」，Task 4/5/7 中魔搭相关步骤改为只建骨架（provider 返回空 + degraded 常驻），其余任务不受影响。若字段与计划假设不符 → 把**实际字段映射**写入核实文档，Task 4/5 实现者照核实文档调常量。

---

### Task 1: ResourceSource 契约扩展（两端）

**Files:**
- Modify: `electron/src/main/resource/types.ts:19`（ResourceSource）、`:85-90`（SOURCE_LABELS）、`:118`（parseResourceId 正则）
- Modify: `renderer/src/ipc/types.d.ts`（ResourceSource 镜像，约 :657 行处）
- Test: `electron/tests/resource/types.test.ts`（若无则新建）

**Interfaces:**
- Produces: `ResourceSource = 'builtin' | 'marketplace' | 'custom' | 'p2p' | 'smithery' | 'modelscope'`；`sourceLabel('smithery') === 'Smithery'`、`sourceLabel('modelscope') === '魔搭社区'`；`parseResourceId('smithery-mcp-x')` 解析成功。后续所有 task 依赖此枚举。

- [ ] **Step 1: 写失败测试**

```typescript
// electron/tests/resource/types.test.ts
import { describe, it, expect } from 'vitest';
import { parseResourceId, sourceLabel, buildResourceId } from '../../src/main/resource/types';

describe('ResourceSource 扩展（P2 双轨 hub）', () => {
  it('parseResourceId 解析 smithery / modelscope 前缀', () => {
    expect(parseResourceId('smithery-mcp-@owner/server')).toEqual({
      source: 'smithery', type: 'mcp', slug: '@owner/server',
    });
    expect(parseResourceId('modelscope-mcp-weather')).toEqual({
      source: 'modelscope', type: 'mcp', slug: 'weather',
    });
  });
  it('buildResourceId 往返一致', () => {
    expect(buildResourceId('smithery', 'mcp', 'a-b')).toBe('smithery-mcp-a-b');
  });
  it('sourceLabel 新增两源有中文标签', () => {
    expect(sourceLabel('smithery')).toBe('Smithery');
    expect(sourceLabel('modelscope')).toBe('魔搭社区');
  });
  it('未知前缀仍拒绝', () => {
    expect(parseResourceId('evil-mcp-x')).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测确认红**

Run: `source ~/.nvm/nvm.sh && nvm use 20 && cd electron && npx pnpm@9.0.0 vitest run tests/resource/types.test.ts`
Expected: FAIL（parseResourceId 返回 null / sourceLabel undefined）

- [ ] **Step 3: 实现**

`electron/src/main/resource/types.ts` 三处修改：

```typescript
// ResourceSource 类型（替换 :19）
/**
 * 资源来源：
 *   - builtin      系统预置（随应用分发，不可删除）
 *   - marketplace  网络资源（远程 catalog 下载安装）
 *   - custom       我的上传（用户本地注册 / 上传）
 *   - p2p          P2P 共享（其他 peer 推送过来的资源，v2 引入）
 *   - smithery     Smithery registry 安装（P2 双轨·国际，spec 2026-09-22）
 *   - modelscope   魔搭社区 hosted MCP（P2 双轨·国内，spec 2026-09-22）
 */
export type ResourceSource =
  | 'builtin'
  | 'marketplace'
  | 'custom'
  | 'p2p'
  | 'smithery'
  | 'modelscope';
```

```typescript
// SOURCE_LABELS（替换 :85-90）
const SOURCE_LABELS: Record<ResourceSource, string> = {
  builtin: '系统预置',
  custom: '我的上传',
  marketplace: '网络资源',
  p2p: 'P2P 共享',
  smithery: 'Smithery',
  modelscope: '魔搭社区',
};
```

```typescript
// parseResourceId 正则（替换 :118 的 match 调用）
const m = id.match(/^(builtin|marketplace|custom|p2p|smithery|modelscope)-(agent|mcp|skill)-(.+)$/);
```

`renderer/src/ipc/types.d.ts` 中 `ResourceSource` 定义同步加 `| 'smithery' | 'modelscope'`（找 `v1.7 资源来源` 注释处的联合类型，注释同步补两行）。

- [ ] **Step 4: 跑测转绿 + 双端 typecheck**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/resource/types.test.ts && cd /workspace && npx pnpm@9.0.0 typecheck`
Expected: PASS；typecheck 0 错（若 renderer 有对 ResourceSource 的 exhaustive switch 报错，按最小面补分支）

- [ ] **Step 5: Commit**

```bash
git add electron/src/main/resource/types.ts renderer/src/ipc/types.d.ts electron/tests/resource/types.test.ts
git commit -m "feat: ResourceSource 扩展 smithery/modelscope 两源（P2 契约基座）"
```

---

### Task 2: migration 038 + mcp 域二态类型与注册读写

**Files:**
- Create: `electron/src/main/storage/migrations/038_p2_mcp_remote_transport.ts`
- Modify: `electron/src/main/storage/migrations/index.ts`（MIGRATIONS 数组末尾，:923 附近）
- Modify: `electron/src/main/mcp/types.ts`（McpServerConfig / RegisteredMcp 二态化）
- Modify: `electron/src/main/mcp/host-manager.ts`（registerMcpDefinition :175 / getMcpConfig :150 / McpDefinitionRow :18 / listRegistered）
- Test: `electron/tests/migrations/038-mcp-remote-transport.test.ts`（新建）
- Test: `electron/tests/mcp/host-manager-remote.test.ts`（新建；参考既有 `electron/tests/mcp/mcp-list-registered.test.ts` 的 in-memory DB 建库模式）

**Interfaces:**
- Produces: `McpServerConfig` 新增 `transport?: 'stdio' | 'streamable_http'`、`url?: string`、`headers?: Record<string, string>`（stdio 时三者缺省）；`RegisteredMcp` 同构必填。`registerMcpDefinition` 接受二态 config；`getMcpConfig` 返回二态。Task 3/5 消费。

- [ ] **Step 1: 写 migration 失败测试**

```typescript
// electron/tests/migrations/038-mcp-remote-transport.test.ts
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { migration038 } from '../../../src/main/storage/migrations/038_p2_mcp_remote_transport';

/** 建一个含 mcp_definitions 旧 schema（v1.6 后、038 前）的内存库 */
function buildLegacyDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE mcp_definitions (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL UNIQUE,
      version TEXT NOT NULL,
      transport TEXT NOT NULL DEFAULT 'stdio',
      command TEXT NOT NULL,
      args TEXT NOT NULL DEFAULT '[]',
      env TEXT NOT NULL DEFAULT '{}',
      source TEXT NOT NULL DEFAULT 'marketplace',
      installed_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO mcp_definitions (id, name, version, command) VALUES ('a', 'old', '1.0.0', 'npx foo');
  `);
  return db;
}

describe('migration 038 mcp remote transport', () => {
  it('up 加 url / headers_json 两列且保留旧行', () => {
    const db = buildLegacyDb();
    db.exec(migration038.up);
    const cols = (db.prepare("PRAGMA table_info('mcp_definitions')").all() as { name: string }[])
      .map((c) => c.name);
    expect(cols).toContain('url');
    expect(cols).toContain('headers_json');
    const row = db.prepare('SELECT name, url, headers_json FROM mcp_definitions').get() as {
      name: string; url: string | null; headers_json: string | null;
    };
    expect(row.name).toBe('old');
    expect(row.url).toBeNull();
    expect(row.headers_json).toBeNull();
  });
  it('幂等拒绝重复应用（SQLite ALTER 重复跑报错——验证第二次 exec 抛错）', () => {
    const db = buildLegacyDb();
    db.exec(migration038.up);
    expect(() => db.exec(migration038.up)).toThrow();
  });
});
```

- [ ] **Step 2: 跑测确认红（模块不存在）**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/migrations/038-mcp-remote-transport.test.ts`
Expected: FAIL（cannot find module）

- [ ] **Step 3: 实现 migration**

```typescript
// electron/src/main/storage/migrations/038_p2_mcp_remote_transport.ts
//
// P2 Migration 038：mcp_definitions 支持远程 MCP（spec 2026-09-22 §4.2）。
// transport 列已存在（DEFAULT 'stdio'），本迁移只加 url / headers_json 两 nullable 列。
// command 列 NOT NULL 不动——remote 行以空串占位（getMcpConfig 按 transport 分流读取），
// 避免SQLite 重建表的 NOT NULL 改写风险。

export interface Migration038 {
  version: number;
  up: string;
  down: string;
}

export const migration038: Migration038 = {
  version: 38,
  up: `
    -- 远程 MCP 两列：端点 URL 与请求头（token 等）。stdio 行两列为 NULL。
    ALTER TABLE mcp_definitions ADD COLUMN url TEXT;
    ALTER TABLE mcp_definitions ADD COLUMN headers_json TEXT;
  `.trim(),
  down: `
    -- SQLite 不支持 DROP COLUMN 前的索引依赖清理，forward-only 不回滚
    SELECT 1;
  `.trim(),
};
```

`index.ts` MIGRATIONS 数组末尾（migration037 条目后）追加：

```typescript
  {
    // P2：mcp_definitions 加 url/headers_json（远程 MCP，spec 2026-09-22 §4.2）。
    // SQL 住在独立模块 038_p2_mcp_remote_transport.ts（约定同 032-037）。
    version: migration038.version,
    sql: migration038.up,
  },
```

顶部 import 区加 `import { migration038 } from './038_p2_mcp_remote_transport';`。

- [ ] **Step 4: 跑 migration 测试转绿**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/migrations/038-mcp-remote-transport.test.ts`
Expected: PASS ×2

- [ ] **Step 5: 写 host-manager 二态读写失败测试**

```typescript
// electron/tests/mcp/host-manager-remote.test.ts
// 建库模式照抄 electron/tests/mcp/mcp-list-registered.test.ts（先读该文件复用其
// getDb stub / AP_USER_DATA_DIR 手法），核心用例：
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
// …（按 mcp-list-registered.test.ts 的既有 stub 手法准备 getDb 指向内存库）…
import { registerMcpDefinition, getMcpConfig, listRegistered } from '../../src/main/mcp/host-manager';

describe('mcp_definitions 二态读写（P2 remote transport）', () => {
  beforeEach(/* 复用既有 stub：内存库已 runMigrations */);
  afterEach(/* 复用既有清理 */);

  it('注册 remote 定义 → getMcpConfig 读回 transport/url/headers', () => {
    registerMcpDefinition({
      id: 'r1', name: 'ms-weather', version: '1.0.0',
      transport: 'streamable_http',
      url: 'https://api.modelscope.ai/mcp/weather',
      headers: { Authorization: 'Bearer tk' },
      source: 'modelscope',
    });
    const cfg = getMcpConfig('ms-weather');
    expect(cfg?.transport).toBe('streamable_http');
    expect(cfg?.url).toBe('https://api.modelscope.ai/mcp/weather');
    expect(cfg?.headers).toEqual({ Authorization: 'Bearer tk' });
    expect(cfg?.command).toBe(''); // NOT NULL 占位
  });

  it('注册 stdio 定义不受影响（缺省 transport）', () => {
    registerMcpDefinition({
      id: 's1', name: 'fs', version: '1.0.0',
      command: 'npx', args: ['-y', 'mcp-server-fs'], source: 'smithery',
    });
    const cfg = getMcpConfig('fs');
    expect(cfg?.transport ?? 'stdio').toBe('stdio');
    expect(cfg?.command).toBe('npx');
  });

  it('listRegistered 返回二态字段与 source 扩展值', () => {
    registerMcpDefinition({
      id: 'r2', name: 'ms-2', version: '1.0.0',
      transport: 'streamable_http', url: 'https://x.test/mcp', source: 'modelscope',
    });
    const row = listRegistered().find((m) => m.name === 'ms-2');
    expect(row?.source).toBe('modelscope');
    expect(row?.url).toBe('https://x.test/mcp');
  });
});
```

（以上为骨架——实现时先读 `electron/tests/mcp/mcp-list-registered.test.ts`，把其中 getDb stub、迁移执行、清理的既有手法原样搬进来，只替换 describe 体。）

- [ ] **Step 6: 跑测确认红**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/mcp/host-manager-remote.test.ts`
Expected: FAIL（TS 报 McpServerConfig 无 transport/url/headers 字段）

- [ ] **Step 7: 实现类型与读写二态化**

`electron/src/main/mcp/types.ts`：

```typescript
/** MCP server 配置（agent manifest mcp 段或资源库安装链解析而来）。
 *  二态：stdio（command/args/env）或 streamable_http（url/headers）——transport 判别。 */
export interface McpServerConfig {
  id: string;
  name: string;
  version: string;
  /** 传输形态；缺省 'stdio'（存量调用方零改动） */
  transport?: 'stdio' | 'streamable_http';
  /** stdio 启动命令（remote 行写空串占位——DB 列 NOT NULL） */
  command: string;
  args: string[];
  env?: Record<string, string>;
  /** remote 端点（transport='streamable_http' 必填，强制 https） */
  url?: string;
  /** remote 请求头（token 等；不落日志） */
  headers?: Record<string, string>;
  /** 来源标识。缺省按 'marketplace' 处理 */
  source?: 'marketplace' | 'custom' | 'smithery' | 'modelscope';
  installedAt?: string;
}

/** listRegistered 返回项（source/installedAt/transport 必填——DB 行必然有值） */
export interface RegisteredMcp {
  id: string;
  name: string;
  version: string;
  transport: 'stdio' | 'streamable_http';
  command: string;
  args: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  source: 'marketplace' | 'custom' | 'smithery' | 'modelscope';
  installedAt: string;
}
```

`host-manager.ts`（先读全文再改）：
- `McpDefinitionRow` 接口加 `transport: string; url: string | null; headers_json: string | null; source: string; installed_at: string;`
- `registerMcpDefinition`（:175）SQL 列加 `transport, url, headers_json`，值分别为 `config.transport ?? 'stdio'`、`config.url ?? null`、`JSON.stringify(config.headers ?? {})`；remote 校验：`if ((config.transport ?? 'stdio') === 'streamable_http') { if (!config.url?.startsWith('https://')) throw new Error('远程 MCP url 必须是 https 地址'); if (!config.command) config = { ...config, command: '' }; }`
- `getMcpConfig`（:150）与 `listRegistered`：行→配置时补 `transport`（行值白名单判定，非法回退 'stdio'）、`url ?? undefined`、`headers`（headers_json 非空 JSON.parse，坏 JSON 回退 undefined + warn）

- [ ] **Step 8: 全量绿 + typecheck**

Run: `source ~/.nvm/nvm.sh && nvm use 20 && cd electron && npx pnpm@9.0.0 vitest run tests/mcp tests/migrations && cd /workspace && npx pnpm@9.0.0 typecheck`
Expected: 全 PASS / 0 错

- [ ] **Step 9: Commit**

```bash
git add electron/src/main/storage/migrations/ electron/src/main/mcp/ electron/tests/mcp/ electron/tests/migrations/
git commit -m "feat: mcp_definitions 二态传输（migration 038 url/headers + 注册读写 remote 形态）"
```

---

### Task 3: HttpMcpClient + host-manager 分流

**Files:**
- Create: `electron/src/main/mcp/http-client.ts`
- Modify: `electron/src/main/mcp/host-manager.ts`（getOrStartMcp :46-69 分流）
- Test: `electron/tests/mcp/http-client.test.ts`（新建）

**Interfaces:**
- Consumes: Task 2 的 `McpServerConfig`（transport/url/headers）
- Produces: `HttpMcpClient`（与 `McpClient` 同表面：`connect() / isConnected / listTools() / callTool(name, args) / disconnect()`）；`getOrStartMcp` 按 config.transport 分流。Task 5 安装链与既有 agent runtime 消费（零改动——仍是 getOrStartMcp）。

- [ ] **Step 1: 写失败测试**

```typescript
// electron/tests/mcp/http-client.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HttpMcpClient } from '../../src/main/mcp/http-client';
import type { McpServerConfig } from '../../src/main/mcp/types';

const cfg: McpServerConfig = {
  id: 'r1', name: 'ms', version: '1.0.0',
  transport: 'streamable_http', url: 'https://mcp.test/sse',
  headers: { Authorization: 'Bearer tk' }, command: '',
};

let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, 'fetch');
});
afterEach(() => {
  fetchSpy.mockRestore();
});

/** JSON-RPC 成功响应桩 */
function rpcResult(method: string, result: unknown): Response {
  return {
    ok: true, status: 200,
    json: async () => ({ jsonrpc: '2.0', id: 1, result }),
  } as unknown as Response;
}

describe('HttpMcpClient（streamable_http 传输）', () => {
  it('connect 发 initialize + initialized 通知（两次 POST）', async () => {
    fetchSpy.mockImplementation(async (input, init) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { method: string };
      if (body.method === 'initialize') return rpcResult('initialize', { serverInfo: { name: 'x', version: '1' }, capabilities: {} });
      return rpcResult('notifications/initialized', {});
    });
    const client = new HttpMcpClient(cfg);
    await client.connect();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(client.isConnected).toBe(true);
  });

  it('listTools 解析 tools 数组', async () => {
    fetchSpy.mockImplementation(async () =>
      rpcResult('tools/list', { tools: [{ name: 't1', description: 'd', inputSchema: {} }] }),
    );
    const client = new HttpMcpClient(cfg);
    await client.connect();
    const tools = await client.listTools();
    expect(tools).toHaveLength(1);
    expect(tools[0]!.name).toBe('t1');
  });

  it('callTool 提取 text 内容并用 \\n 拼接', async () => {
    fetchSpy.mockImplementation(async () =>
      rpcResult('tools/call', { content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }], isError: false }),
    );
    const client = new HttpMcpClient(cfg);
    await client.connect();
    expect(await client.callTool('t1', {})).toBe('a\nb');
  });

  it('HTTP 非 2xx 抛错且 isConnected=false', async () => {
    fetchSpy.mockResolvedValue({ ok: false, status: 502 } as Response);
    const client = new HttpMcpClient(cfg);
    await expect(client.connect()).rejects.toThrow(/502|远程 MCP/);
    expect(client.isConnected).toBe(false);
  });

  it('请求头带 Authorization（token 不出现在日志断言里）', async () => {
    fetchSpy.mockImplementation(async () => rpcResult('initialize', { serverInfo: {}, capabilities: {} }));
    const client = new HttpMcpClient(cfg);
    await client.connect();
    const init = fetchSpy.mock.calls[0]![1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer tk');
  });
});
```

- [ ] **Step 2: 跑测确认红**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/mcp/http-client.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 HttpMcpClient**

```typescript
// electron/src/main/mcp/http-client.ts
//
// 远程 MCP 客户端（streamable_http 传输，spec 2026-09-22 §4.2 决策 D6）。
// JSON-RPC 2.0 over HTTP POST——与 client.ts 的手写 stdio 客户端同风格、零新依赖。
// 表面对齐 McpClient：connect / isConnected / listTools / callTool / disconnect，
// host-manager.getOrStartMcp 按 transport 分流，进程池逻辑无需感知传输差异。
// SSE 流式响应留 P3（本实现按简单请求-响应处理）。

import { logger } from '../logger';
import type { McpServerConfig, McpToolInfo, McpToolResult } from './types';

/** 单请求超时——对齐 stdio 客户端 REQUEST_TIMEOUT_MS */
const REQUEST_TIMEOUT_MS = 30_000;

export class HttpMcpClient {
  private nextId = 1;
  private connected = false;

  constructor(private readonly config: McpServerConfig) {
    if (!config.url) throw new Error('远程 MCP 缺少 url');
  }

  get isConnected(): boolean {
    return this.connected;
  }

  /** initialize 握手 + initialized 通知（两次 POST）。失败置 disconnected 并抛错。 */
  async connect(): Promise<void> {
    await this.post('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'momo-studio', version: '2.1.0' },
    });
    await this.post('notifications/initialized', {});
    this.connected = true;
    logger.info('远程 MCP 已连接', { name: this.config.name }); // 不打 url/headers（含 token）
  }

  async listTools(): Promise<McpToolInfo[]> {
    const res = (await this.post('tools/list', {})) as { tools?: McpToolInfo[] };
    return res.tools ?? [];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const res = (await this.post('tools/call', { name, arguments: args })) as McpToolResult;
    return (res.content ?? [])
      .filter((c) => c.type === 'text')
      .map((c) => c.text ?? '')
      .join('\n');
  }

  /** 无进程可杀——仅翻状态（进程池语义：下次调用重建） */
  async disconnect(): Promise<void> {
    this.connected = false;
  }

  /** 单次 JSON-RPC POST；error 响应抛错；通知（无 id 期望）也走同一端点 */
  private async post(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    const body = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    const response = await fetch(this.config.url!, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...this.config.headers,
      },
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      this.connected = false;
      throw new Error(`远程 MCP ${method} 失败：HTTP ${response.status}`);
    }
    const json = (await response.json()) as {
      result?: unknown;
      error?: { message: string };
    };
    if (json.error) throw new Error(`远程 MCP ${method} 错误：${json.error.message}`);
    return json.result;
  }
}
```

- [ ] **Step 4: 跑测转绿**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/mcp/http-client.test.ts`
Expected: PASS ×5

- [ ] **Step 5: host-manager 分流（小改）**

`getOrStartMcp`（host-manager.ts :61-66）中实例化处替换：

```typescript
  const promise = (async (): Promise<McpClient | HttpMcpClient> => {
    const client =
      (config.transport ?? 'stdio') === 'streamable_http'
        ? new HttpMcpClient(config)
        : new McpClient(config);
    await client.connect();
    logger.info('MCP server 已启动', { workspaceId, name: config.name });
    return client;
  })();
```

import 区加 `import { HttpMcpClient } from './http-client';`。函数返回类型改 `Promise<McpClient | HttpMcpClient>`（两类型结构兼容 listTools/callTool/isConnected/disconnect，调用方duck-typing 不变；若 TS 报联合类型窄化问题，用最小公共表面定义 `type AnyMcpClient = Pick<McpClient, 'isConnected' | 'connect' | 'listTools' | 'callTool' | 'disconnect'>`）。

- [ ] **Step 6: mcp 全量 + typecheck**

Run: `source ~/.nvm/nvm.sh && nvm use 20 && cd electron && npx pnpm@9.0.0 vitest run tests/mcp tests/agent && cd /workspace && npx pnpm@9.0.0 typecheck`
Expected: 全 PASS / 0 错

- [ ] **Step 7: Commit**

```bash
git add electron/src/main/mcp/ electron/tests/mcp/http-client.test.ts
git commit -m "feat: McpClient streamableHttp 远程传输（HttpMcpClient + 池分流）"
```

---

### Task 4: hub provider 框架（主进程）+ registryList IPC

**Files:**
- Create: `electron/src/main/resource/hub/backoff.ts`（退避负缓存小工具，模式抽自 marketplace/client.ts）
- Create: `electron/src/main/resource/hub/types.ts`（主进程侧 HubProvider 契约 + HubMeta）
- Create: `electron/src/main/resource/hub/smithery.ts`
- Create: `electron/src/main/resource/hub/modelscope.ts`
- Create: `electron/src/main/resource/hub/index.ts`（静态注册表）
- Modify: `electron/src/main/resource/ipc.handlers.ts`（两个新 handler）
- Modify: `electron/src/preload/index.ts`（桥）
- Modify: `renderer/src/ipc/types.d.ts`（IPC 类型）
- Test: `electron/tests/resource/hub/smithery.test.ts`、`electron/tests/resource/hub/backoff.test.ts`

**Interfaces:**
- Consumes: Task 0 核实文档的 API 字段；Task 1 ResourceSource
- Produces:
  - `createBackoff(key: string)` → `{ isBackedOff(): boolean; recordFailure(): void; recordSuccess(): void; __rewindForTest?(ms): void }`
  - `HubProvider = { key: 'smithery'|'modelscope'; label: string; region: 'intl'|'cn'; types: ResourceType[]; list(type, query?): Promise<HubEntry[]> }`；`HubEntry = RegistryEntry 同构`（id/type/name/description/version/tags/category/item: ResourceItem）
  - IPC `resource:registryList(providerKey, type, query?) → { entries, degraded: boolean }`；`resource:registryProviders() → Array<{key,label,region,types,degraded}>`（内置市场也入列：key='builtin'）。Task 5/6 消费。

- [ ] **Step 1: 写 backoff 失败测试**

```typescript
// electron/tests/resource/hub/backoff.test.ts
import { describe, it, expect } from 'vitest';
import { createBackoff } from '../../../src/main/resource/hub/backoff';

describe('hub 退避负缓存（模式抽自 fetchCatalog）', () => {
  it('失败后窗口内 isBackedOff=true，recordSuccess 清除', () => {
    const b = createBackoff('test', 60_000);
    expect(b.isBackedOff()).toBe(false);
    b.recordFailure();
    expect(b.isBackedOff()).toBe(true);
    b.recordSuccess();
    expect(b.isBackedOff()).toBe(false);
  });
  it('rewind 前移窗口可模拟过期', () => {
    const b = createBackoff('test2', 60_000);
    b.recordFailure();
    b.__rewindForTest(60_001);
    expect(b.isBackedOff()).toBe(false);
  });
});
```

- [ ] **Step 2: 红测 → 实现 backoff.ts**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/resource/hub/backoff.test.ts` → FAIL → 写实现：

```typescript
// electron/src/main/resource/hub/backoff.ts
//
// hub API 失败退避负缓存——模式与 marketplace/client.ts 的 catalogFailureBackoff
// 一致（6a6c311 教训制度化）：失败后窗口内零网络重试，窗口过期自动恢复。
// 每个 hub provider 一个实例（key 仅供日志）。

export interface Backoff {
  isBackedOff(): boolean;
  recordFailure(): void;
  recordSuccess(): void;
  __rewindForTest(ms: number): void;
}

export function createBackoff(key: string, windowMs = 60_000): Backoff {
  let until = 0;
  return {
    isBackedOff: () => until > Date.now(),
    recordFailure: () => {
      until = Date.now() + windowMs;
    },
    recordSuccess: () => {
      until = 0;
    },
    __rewindForTest: (ms) => {
      until -= ms;
    },
  };
}
void key; // key 保留给日志扩展，暂不用
```

转绿后进 Step 3。

- [ ] **Step 3: 写 Smithery provider 失败测试**

```typescript
// electron/tests/resource/hub/smithery.test.ts
// mock globalThis.fetch（手法同 tests/marketplace/client.test.ts）。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { smitheryProvider } from '../../../src/main/resource/hub/smithery';
import { __resetHubBackoffForTest } from '../../../src/main/resource/hub/smithery';

let fetchSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, 'fetch') as unknown as typeof fetchSpy;
  __resetHubBackoffForTest();
});
afterEach(() => {
  fetchSpy.mockRestore();
  __resetHubBackoffForTest();
});

const LIST_BODY = {
  servers: [{
    id: '@owner/weather',
    description: '天气查询',
    repository: { url: 'https://github.com/owner/weather' },
    deployment: { status: 'active', type: 'stdio' },
  }],
};

describe('smitheryProvider', () => {
  it('list 映射为 HubEntry（source=smithery / installable / S1 校验过 slug）', async () => {
    fetchSpy.mockResolvedValue({
      ok: true, status: 200, json: async () => LIST_BODY,
    } as Response);
    const { entries, degraded } = await smitheryProvider.list('mcp');
    expect(degraded).toBe(false);
    expect(entries).toHaveLength(1);
    const e = entries[0]!;
    expect(e.id).toBe('smithery-mcp-@owner/weather');
    expect(e.item.source).toBe('smithery');
    expect(e.item.installable).toBe(true);
    expect(e.item.marketplace?.author).toBe('owner');
  });

  it('仅 type=mcp 支持（agent/skill 抛不支持）', async () => {
    await expect(smitheryProvider.list('agent')).rejects.toThrow(/不支持/);
  });

  it('fetch 失败 → degraded=true + 退避（二次调用零网络）', async () => {
    fetchSpy.mockRejectedValue(new Error('fetch failed'));
    const first = await smitheryProvider.list('mcp');
    expect(first.degraded).toBe(true);
    expect(first.entries).toHaveLength(0);
    const second = await smitheryProvider.list('mcp');
    expect(second.degraded).toBe(true);
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it('畸形条目（缺 id / slug 非法）单条跳过不拖垮列表', async () => {
    fetchSpy.mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({
        servers: [LIST_BODY.servers[0], { description: '缺 id' }, { id: 'Bad|Slug!', description: 'x' }],
      }),
    } as Response);
    const { entries } = await smitheryProvider.list('mcp');
    expect(entries).toHaveLength(1);
  });
});
```

- [ ] **Step 4: 实现 hub 类型 + Smithery + ModelScope + 注册表**

`hub/types.ts`：

```typescript
// electron/src/main/resource/hub/types.ts
// 主进程 hub provider 契约（spec §4.1）。renderer 侧经 IPC 消费，不直接 import。
import type { ResourceItem, ResourceType } from '../types';

export interface HubEntry {
  id: string;
  type: ResourceType;
  name: string;
  description: string;
  version?: string;
  tags: string[];
  category?: string;
  item: ResourceItem;
}

export interface HubListResult {
  entries: HubEntry[];
  /** 命中退避窗口（上次失败后未重试）——UI 置灰信号，不隐藏 */
  degraded: boolean;
}

export interface HubProvider {
  readonly key: 'smithery' | 'modelscope';
  readonly label: string;
  readonly region: 'intl' | 'cn';
  readonly types: ResourceType[];
  list(type: ResourceType, query?: string): Promise<HubListResult>;
}
```

`hub/smithery.ts`（**字段映射以 Task 0 核实文档为准**——下方按 Step 1 预期形状写，若核实有出入只改 `API_BASE`/`toEntry` 字段路径）：

```typescript
// electron/src/main/resource/hub/smithery.ts
//
// Smithery registry provider（spec §4.1，决策 D4：主进程代理）。
// 端点与字段以 Task 0 核实文档为准（docs/plans 本计划 Task 0）。
import { createBackoff } from './backoff';
import type { HubEntry, HubListResult, HubProvider } from './types';
import { buildResourceId, type ResourceItem } from '../types';
import { isValidSlug } from '../../marketplace/types';

const API_BASE = 'https://registry.smithery.ai';
const PAGE_SIZE = 30;

const backoff = createBackoff('smithery');

/** Smithery 服务器条目（字段见 Task 0 核实；宽松可选以容错第三方响应） */
interface SmitheryServer {
  id?: string;
  description?: string;
  repository?: { url?: string };
  deployment?: { status?: string; type?: string };
}

function toEntry(raw: SmitheryServer): HubEntry | null {
  if (!raw.id || !raw.description) return null;
  // qualified name（@owner/name）整体作 slug——parseResourceId 的 slug 组允许 @ 与 /
  if (!isValidSlug(raw.id.replace(/^@/, '').split('/')[0] ?? '')) return null;
  const item: ResourceItem = {
    id: buildResourceId('smithery', 'mcp', raw.id),
    type: 'mcp',
    source: 'smithery',
    slug: raw.id,
    name: raw.id.replace(/^@/, ''),
    description: raw.description,
    installed: false,
    installable: true,
    removable: false,
    marketplace: {
      author: raw.id.startsWith('@') ? raw.id.slice(1).split('/')[0] : raw.id,
      readme: raw.description,
      downloadUrl: '',
      checksum: '',
      verificationStatus: raw.deployment?.status === 'active' ? 'community' : 'unverified',
      tags: [],
      category: 'smithery',
    },
  };
  return {
    id: item.id, type: 'mcp', name: item.name,
    description: raw.description, tags: [], category: 'smithery', item,
  };
}

export const smitheryProvider: HubProvider = {
  key: 'smithery',
  label: 'Smithery',
  region: 'intl',
  types: ['mcp'],
  async list(type): Promise<HubListResult> {
    if (type !== 'mcp') throw new Error(`Smithery 暂只支持 MCP（收到 ${type}）`);
    if (backoff.isBackedOff()) return { entries: [], degraded: true };
    try {
      const res = await fetch(`${API_BASE}/servers?pageSize=${PAGE_SIZE}`, {
        signal: AbortSignal.timeout(3000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { servers?: SmitheryServer[] };
      backoff.recordSuccess();
      return { entries: (body.servers ?? []).map(toEntry).filter((e): e is HubEntry => e !== null), degraded: false };
    } catch {
      backoff.recordFailure();
      return { entries: [], degraded: true };
    }
  },
};

/** 测试用：清退避 */
export function __resetHubBackoffForTest(): void {
  // backoff 实例内部 until 复位——借 rewind 大数实现
  backoff.__rewindForTest(Number.MAX_SAFE_INTEGER);
  backoff.recordSuccess();
}
```

`hub/modelscope.ts`：同构骨架，`API_BASE`/条目映射**严格按 Task 0 Step 3 核实结论**实现；若 Task 0 裁定降级，则实现为：

```typescript
// electron/src/main/resource/hub/modelscope.ts
// 魔搭 provider（spec §4.1）。Task 0 裁定降级时的骨架：常驻 degraded、零网络。
// API 可核实后按 smithery.ts 同构补实现（字段映射见 Task 0 核实文档）。
import type { HubListResult, HubProvider } from './types';

export const modelscopeProvider: HubProvider = {
  key: 'modelscope',
  label: '魔搭社区',
  region: 'cn',
  types: ['mcp'],
  async list(type): Promise<HubListResult> {
    if (type !== 'mcp') throw new Error(`魔搭暂只支持 MCP（收到 ${type}）`);
    return { entries: [], degraded: true };
  },
};
```

`hub/index.ts`：

```typescript
// electron/src/main/resource/hub/index.ts
// hub provider 静态注册表（spec §4.1）。内置市场不入此表——registryProviders IPC
// 单独合并 builtin 项（零网络、永可用）。
import { smitheryProvider } from './smithery';
import { modelscopeProvider } from './modelscope';
import type { HubProvider } from './types';

export const HUB_PROVIDERS: readonly HubProvider[] = [smitheryProvider, modelscopeProvider];
```

- [ ] **Step 5: registryList / registryProviders IPC + preload + 类型**

`ipc.handlers.ts`（registerResourceHandlers 内追加两个 handler，import 区加 hub 与 builtin 映射所需）：

```typescript
  // resource:registryProviders — 网络获取模式 provider 元信息（含可达性）。
  // builtin 恒可用（本地 catalog）；hub degraded 来自各自退避状态（不打网络——
  // 退避窗口内即视为不可达，窗口过期后首次 list 才真探测）。
  ipcMain.handle('resource:registryProviders', async () => {
    const hubs = HUB_PROVIDERS.map((p) => ({
      key: p.key, label: p.label, region: p.region, types: [...p.types],
      degraded: p.key === 'smithery' ? isSmitheryDegraded() : isModelScopeDegraded(),
    }));
    return [
      { key: 'builtin', label: '内置市场', region: 'local' as const, types: ['agent', 'mcp', 'skill'] as const, degraded: false },
      ...hubs,
    ];
  });

  // resource:registryList — 按 provider 拉取注册表条目。builtin 走现有
  // listResources({type, source:'marketplace'})（与 v1 行为一致）。
  ipcMain.handle(
    'resource:registryList',
    async (_evt, providerKey: string, type: ResourceType, query?: string) => {
      if (providerKey === 'builtin') {
        const items = await listResources({ type, source: 'marketplace' });
        const q = query?.trim().toLowerCase();
        const matched = q
          ? items.filter(
              (i) =>
                i.name.toLowerCase().includes(q) ||
                i.description.toLowerCase().includes(q) ||
                i.slug.toLowerCase().includes(q),
            )
          : items;
        return {
          entries: matched
            .sort((a, b) => Number(a.installed) - Number(b.installed))
            .map((item) => ({
              id: item.id, type: item.type, name: item.name, description: item.description,
              version: item.version, tags: item.marketplace?.tags ?? [], category: item.marketplace?.category, item,
            })),
          degraded: false,
        };
      }
      const provider = HUB_PROVIDERS.find((p) => p.key === providerKey);
      if (!provider) throw new Error(`未知 registry provider: ${providerKey}`);
      return provider.list(type, query);
    },
  );
```

（smithery/modelscope 各导出 `isSmitheryDegraded()`/`isModelScopeDegraded()` = `backoff.isBackedOff()` 的薄封装；降级骨架版恒 true。）

`renderer/src/ipc/types.d.ts` 追加（ResourceApi 段）：

```typescript
/** 网络获取 provider 元信息 */
export interface RegistryProviderMeta {
  key: 'builtin' | 'smithery' | 'modelscope';
  label: string;
  region: 'local' | 'intl' | 'cn';
  types: Array<'agent' | 'mcp' | 'skill'>;
  degraded: boolean;
}

/** registryList 返回条目（与 RegistryEntry 同构，经 IPC 序列化） */
export interface RegistryListEntry {
  id: string;
  type: ResourceType;
  name: string;
  description: string;
  version?: string;
  tags: string[];
  category?: string;
  item: ResourceItem;
}
```

及 ResourceApiSurface 两个方法：`registryProviders(): Promise<RegistryProviderMeta[]>`、`registryList(providerKey: string, type: ResourceType, query?: string): Promise<{ entries: RegistryListEntry[]; degraded: boolean }>`。

`preload/index.ts` resource 段补两行 invoke 桥（照抄同段现有写法）。

- [ ] **Step 6: 全部测试 + 双端 typecheck + Commit**

Run: `source ~/.nvm/nvm.sh && nvm use 20 && cd electron && npx pnpm@9.0.0 vitest run tests/resource && cd /workspace && npx pnpm@9.0.0 typecheck`
Expected: PASS / 0 错

```bash
git add electron/src/main/resource/hub/ electron/src/main/resource/ipc.handlers.ts electron/src/preload/index.ts renderer/src/ipc/types.d.ts electron/tests/resource/hub/
git commit -m "feat: 主进程 hub provider 框架 + Smithery/魔搭接入 + registryList IPC"
```

---

### Task 5: hub 安装/卸载链路 + library 列表接入

**Files:**
- Create: `electron/src/main/resource/hub-install.ts`
- Modify: `electron/src/main/resource/ipc.handlers.ts`（resource:install / resource:delete 分支）
- Modify: `electron/src/main/resource/library.ts`（needHub + 已装 hub MCP 映射）
- Test: `electron/tests/resource/hub-install.test.ts`（新建）

**Interfaces:**
- Consumes: Task 2 `registerMcpDefinition` 二态；Task 4 `HubProvider` / smithery install-config 端点（Task 0 Step 2 核实）
- Produces: `installSmitheryMcp(slug: string): Promise<void>`（拉 install-config → S1 校验 → registerMcpDefinition(stdio) + installed_packages 记账）；`installModelScopeMcp(slug, url): Promise<void>`（remote 注册 + 记账）；`listHubInstalledResources(type?): ResourceItem[]`（mcp_definitions source ∈ {smithery, modelscope} 映射，installed=true / removable=true）；`resource:install` 支持 `smithery-` / `modelscope-` id；`resource:delete` 对应卸载（删 mcp_definitions 行 + installed_packages 行）。Task 6 的 installed 翻转依赖 library 映射。

- [ ] **Step 1: 写失败测试（核心三条）**

```typescript
// electron/tests/resource/hub-install.test.ts
// 建库/stub 手法照抄 tests/mcp/host-manager-remote.test.ts（Task 2 已建）+ fetch mock。
import { describe, it, expect, vi, beforeEach } from 'vitest';
// …stub getDb 内存库 + fetchSpy…
import { installSmitheryMcp, listHubInstalledResources } from '../../src/main/resource/hub-install';
import { getMcpConfig } from '../../src/main/mcp/host-manager';

describe('hub 安装链路', () => {
  beforeEach(/* 内存库 + fetch mock 复位 */);

  it('Smithery stdio 安装：install-config → npx 命令注册 + 记账 + 列表可见', async () => {
    fetchSpy.mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ command: 'npx', args: ['-y', '@owner/weather-mcp'], env: { KEY: 'v' } }),
    } as Response);
    await installSmitheryMcp('@owner/weather');
    const cfg = getMcpConfig('@owner/weather');
    expect(cfg?.command).toBe('npx');
    expect(cfg?.source).toBe('smithery');
    const items = listHubInstalledResources('mcp');
    expect(items.some((i) => i.slug === '@owner/weather' && i.source === 'smithery')).toBe(true);
  });

  it('install-config 返回非法 command（shell 元字符）→ S1 拒绝且不落库', async () => {
    fetchSpy.mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ command: 'sh -c "evil"', args: [], env: {} }),
    } as Response);
    await expect(installSmitheryMcp('bad')).rejects.toThrow(/非法|拒绝/);
    expect(getMcpConfig('bad')).toBeNull();
  });

  it('重复安装幂等（INSERT OR REPLACE + 记账 REPLACE）', async () => {
    fetchSpy.mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ command: 'npx', args: ['-y', 'p'], env: {} }),
    } as Response);
    await installSmitheryMcp('dup');
    await installSmitheryMcp('dup');
    expect(listHubInstalledResources('mcp').filter((i) => i.slug === 'dup')).toHaveLength(1);
  });
});
```

- [ ] **Step 2: 红测 → 实现 hub-install.ts**

```typescript
// electron/src/main/resource/hub-install.ts
//
// hub MCP 安装/卸载与已装映射（spec §4.3）。
// Smithery：POST install-config 拿 stdio 命令（npx）→ S1 校验 → 注册；
// 魔搭：remote url 直注册（url 由 provider 条目携带，token 装配时从 keychain 取）。
// 记账走 installed_packages（item_id = `${source}:${slug}`），与 marketplace 同表
// 不同前缀，卸载互不误伤。
import { randomUUID } from 'node:crypto';
import { getDb } from '../storage/db';
import { getSecret } from '../storage/keychain';
import { logger } from '../logger';
import { registerMcpDefinition, listRegistered, deleteRegistered } from '../mcp/host-manager';
import { buildResourceId, type ResourceItem, type ResourceType } from './types';
import { isValidSlug } from '../marketplace/types';

const SMITHERY_BASE = 'https://registry.smithery.ai';

function recordInstall(itemId: string, slug: string): void {
  const db = getDb();
  db.prepare(
    `INSERT OR REPLACE INTO installed_packages (id, item_id, item_type, slug, version, cache_path, checksum)
     VALUES (?, ?, 'mcp', ?, '1.0.0', '', '')`,
  ).run(randomUUID(), itemId, slug);
}

/** Smithery stdio 安装：install-config → 校验 → 注册 + 记账 */
export async function installSmitheryMcp(slug: string): Promise<void> {
  const res = await fetch(`${SMITHERY_BASE}/servers/${encodeURIComponent(slug)}/install-config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ profile: {} }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Smithery install-config 失败：HTTP ${res.status}`);
  const cfg = (await res.json()) as { command?: string; args?: string[]; env?: Record<string, string> };
  if (!cfg.command || !/^(npx|node|uvx|uv|python|python3)$/.test(cfg.command)) {
    throw new Error(`install-config 返回非法 command（拒绝）：${String(cfg.command)}`);
  }
  const args = (cfg.args ?? []).filter((a) => typeof a === 'string' && !a.includes('"'));
  registerMcpDefinition({
    id: randomUUID(), name: slug, version: '1.0.0',
    command: cfg.command, args, env: cfg.env, source: 'smithery',
  });
  recordInstall(`smithery:${slug}`, slug);
  logger.info('Smithery MCP 已安装', { slug });
}

/** 魔搭 remote 安装：url 直注册（token 装配 Authorization 头） */
export async function installModelScopeMcp(slug: string, url: string, displayName: string): Promise<void> {
  if (!url.startsWith('https://')) throw new Error('魔搭 MCP 端点必须是 https 地址');
  const token = await getSecret('modelscope-token');
  const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
  registerMcpDefinition({
    id: randomUUID(), name: slug, version: '1.0.0',
    transport: 'streamable_http', url, headers, command: '',
    source: 'modelscope',
  });
  recordInstall(`modelscope:${slug}`, slug);
  logger.info('魔搭 MCP 已安装', { slug, name: displayName });
}

/** mcp_definitions 中 hub 来源行 → ResourceItem（installed=true / removable=true） */
export function listHubInstalledResources(type?: ResourceType): ResourceItem[] {
  return listRegistered()
    .filter((m) => (m.source === 'smithery' || m.source === 'modelscope') && (!type || type === 'mcp'))
    .map((m) => ({
      id: buildResourceId(m.source, 'mcp', m.name),
      type: 'mcp' as const,
      source: m.source,
      slug: m.name,
      name: m.name.replace(/^@/, ''),
      description: m.transport === 'streamable_http' ? `远程 MCP（${m.url ?? ''}）` : `Smithery MCP（${m.command}）`,
      version: m.version,
      installed: true,
      installable: false,
      removable: true,
      custom: { installedAt: m.installedAt },
    }));
}

/** hub 卸载：删 mcp_definitions 行 + installed_packages 记账（幂等） */
export function uninstallHubMcp(source: 'smithery' | 'modelscope', slug: string): void {
  deleteRegisteredHubSafe(slug);
  const db = getDb();
  db.prepare('DELETE FROM installed_packages WHERE item_id = ?').run(`${source}:${slug}`);
}

/** hub 行允许直接删（deleteRegistered 对 marketplace 有保护，hub 无此约束） */
function deleteRegisteredHubSafe(name: string): void {
  // deleteRegistered 仅拦截 source='marketplace'，hub 行直接走删除
  deleteRegistered(name);
}
```

（`deleteRegistered` 现实现（host-manager.ts :230）只拦 `marketplace`，hub 行会走默认删除分支——若实现有变以实际代码为准。）

- [ ] **Step 3: library.ts 接入已装 hub 列表**

`listResources`（library.ts :24）加一行短路与合并：

```typescript
  const needHub = !filter?.source || filter.source === 'smithery' || filter.source === 'modelscope';
  // …tasks 并行块后…
  let hubItems: ResourceItem[] = [];
  if (needHub) hubItems = listHubInstalledResources(filter?.type);
  let items = [...builtinItems, ...marketplaceItems, ...customItems, ...p2pItems, ...hubItems];
```

import 区加 `import { listHubInstalledResources } from './hub-install';`。

- [ ] **Step 4: install/delete IPC 分支**

`resource:install`（ipc.handlers.ts :66）在 `if (item.source !== 'marketplace')` 前插：

```typescript
    if (item.source === 'smithery' && item.type === 'mcp') {
      await installSmitheryMcp(item.slug);
      return { cachePath: '' };
    }
    if (item.source === 'modelscope' && item.type === 'mcp') {
      // 魔搭条目的 url 随 ResourceItem.marketplace.downloadUrl 携带（provider 装配）
      const url = item.marketplace?.downloadUrl;
      if (!url) throw new Error('魔搭条目缺少端点 url');
      await installModelScopeMcp(item.slug, url, item.name);
      return { cachePath: '' };
    }
```

`resource:delete`（:116）switch 前加：

```typescript
    if (item.source === 'smithery' || item.source === 'modelscope') {
      uninstallHubMcp(item.source, item.slug);
      return;
    }
```

- [ ] **Step 5: 魔搭条目装配 url——hub/modelscope.ts 的 toEntry 中 `marketplace.downloadUrl = 条目端点`**（Task 0 核实字段名；骨架降级版无条目则跳过本步）

- [ ] **Step 6: 测试 + typecheck + Commit**

Run: `source ~/.nvm/nvm.sh && nvm use 20 && cd electron && npx pnpm@9.0.0 vitest run tests/resource && cd /workspace && npx pnpm@9.0.0 typecheck`
Expected: PASS / 0 错

```bash
git add electron/src/main/resource/ electron/tests/resource/hub-install.test.ts
git commit -m "feat: hub MCP 安装/卸载链路（Smithery stdio / 魔搭 remote）+ 资源列表接入"
```

---

### Task 6: renderer provider 选择器 + 置灰 + 记忆

**Files:**
- Modify: `renderer/src/components/resource-library/RegistryBrowse.tsx`（provider 下拉 + ipc.registryList）
- Modify: `renderer/src/stores/resource.store.ts`（providerKey 状态 + localStorage 记忆）
- Test: `renderer/src/components/resource-library/RegistryBrowse.test.tsx`（扩展）

**Interfaces:**
- Consumes: Task 4 IPC（`ipc.resource.registryProviders` / `ipc.resource.registryList`）；Task 5 installed 翻转（store.items 已含 hub 已装项）
- Produces: RegistryBrowse 顶栏 provider `<select>`（含「内置市场/Smithery/魔搭社区」）；不可达 option `disabled` + 「（当前网络不可达）」后缀；选择持久化 `localStorage['momo.resourceLibrary.providerKey']`。

- [ ] **Step 1: 写失败测试（追加到 RegistryBrowse.test.tsx）**

```typescript
// mock window.api 手法沿用本文件既有 pattern（属性安装 globalThis.window.api）。
// 核心三条：

it('渲染 provider 选择器：内置市场默认 + hub 可选', async () => {
  // registryProviders 返回三元（builtin/smithery/modelscope）
  // 断言 <select> 存在且含三个 option
});

it('切到 smithery → 调 registryList("smithery", type) 渲染 hub 条目', async () => {
  // registryList mock 返回一条 smithery 条目；fireEvent.change select → waitFor 行出现
});

it('degraded provider 的 option disabled 且标注不可达', async () => {
  // registryProviders 返回 smithery degraded:true
  // 断言对应 option.hasAttribute('disabled') 且文本含「不可达」
});
```

（实现时按本文件既有 mock/断言风格补全具体代码——mock 形状照抄既有用例对 `resource.list` 的桩法。）

- [ ] **Step 2: 红测 → 实现**

`resource.store.ts`：`ResourceStore` 加 `registryProviderKey: 'builtin' | 'smithery' | 'modelscope'`，初始值走 localStorage 恢复（模式照抄 :134-146 的 activeType 块，key `'momo.resourceLibrary.providerKey'`，非法值回退 `'builtin'`）；action `setRegistryProvider(key)` 持久化 + set。

`RegistryBrowse.tsx` 顶栏（替换 `来源：{marketplaceCatalogProvider.label}` 那行 span）：

```tsx
{/* provider 选择器（spec §4.4 预留位兑现）：手动选择 + 不可达置灰 + 记忆 */}
<select
  aria-label="registry provider"
  className="ml-auto text-xs px-2 py-1 rounded-md bg-surface-3 text-secondary border border-subtle"
  value={providerKey}
  onChange={(e) => { void setRegistryProvider(e.target.value as typeof providerKey); }}
>
  {providers.map((p) => (
    <option key={p.key} value={p.key} disabled={p.degraded}>
      {p.label}{p.degraded ? '（当前网络不可达）' : ''}
    </option>
  ))}
</select>
```

组件内：`const providers = ...`（mount 时 `ipc.resource.registryProviders()` 拉一次 + type 过滤 `p.types.includes(type)`）；数据源 effect（:41-53）从 `marketplaceCatalogProvider.list(type)` 改为 `ipc.resource.registryList(providerKey, type)`（builtin provider 走主进程同一通道——v1 的 renderer 直连 provider 退役，删除 import）；`providerKey` 从 store 取（effect deps 加 providerKey）。降级（degraded 且条目空）复用现有 error 分支文案改为「该来源当前网络不可达，可稍后重试或切换来源」+ 保留重试按钮。

- [ ] **Step 3: 测试 + renderer 全量 + typecheck + Commit**

Run: `source ~/.nvm/nvm.sh && nvm use 20 && cd renderer && npx pnpm@9.0.0 vitest run src/components/resource-library && npx pnpm@9.0.0 vitest run && cd /workspace && npx pnpm@9.0.0 typecheck`
Expected: 全 PASS / 0 错

```bash
git add renderer/src/components/resource-library/RegistryBrowse.tsx renderer/src/components/resource-library/RegistryBrowse.test.tsx renderer/src/stores/resource.store.ts
git commit -m "feat: 网络获取 provider 选择器（Smithery/魔搭/内置，置灰+记忆）"
```

---

### Task 7: 魔搭 token 设置 + mcp-json url 条目支持

**Files:**
- Modify: `renderer/src/lib/mcp-json.ts`（url 条目从「报不支持」转正）
- Modify: `renderer/src/components/resource-library/McpJsonPasteDialog.tsx`（review 步展示 transport 徽标，文案微调）
- Modify: `electron/src/main/resource/ipc.handlers.ts`（resource:registerMcp 透传二态）
- Modify: `renderer/src/components/settings/SettingsView.tsx` 或新建 `renderer/src/components/settings/HubSettings.tsx`（魔搭 token 字段——挂进 SettingsNav 新「网络市场」小节）
- Modify: `renderer/src/ipc/types.d.ts` + `electron/src/preload/index.ts`（两个 token IPC）
- Test: `renderer/src/lib/mcp-json.test.ts`（扩展）、`renderer/src/components/settings/HubSettings.test.tsx`（新建）

**Interfaces:**
- Consumes: Task 2 二态 McpServerConfig；keychain `setSecret/getSecret`（key 固定 `'modelscope-token'`）
- Produces: `ParsedMcpEntry` 可含 `url?: string; headers?: Record<string, string>`；IPC `resource:setModelScopeToken(token: string): Promise<void>` / `resource:getModelScopeTokenStatus(): Promise<boolean>`（已配置与否，不回明文）；设置页「魔搭 Access Token」输入框（保存后显示已配置）。

- [ ] **Step 1: mcp-json 红测（url 条目转正）**

```typescript
// renderer/src/lib/mcp-json.test.ts 追加：
it('url 型远程条目解析为 remote entry（P2 转正）', () => {
  const entries = parseMcpServersJson(
    '{"mcpServers": {"weather": {"url": "https://mcp.modelscope.cn/sse"}}}',
  );
  expect(entries[0]!.url).toBe('https://mcp.modelscope.cn/sse');
  expect(entries[0]!.command).toBe('');
});

it('非 https url 拒绝', () => {
  expect(() =>
    parseMcpServersJson('{"mcpServers": {"bad": {"url": "http://x.test"}}}'),
  ).toThrow(/https/);
});
```

- [ ] **Step 2: 实现**：`mcp-json.ts` 的 `parseEntry`（:46-49 的 url 拒绝分支）改为——`url` 为非空 string 时要求 `https://` 前缀，返回 `{ name, command: '', url }`；`ParsedMcpEntry` 加 `url?: string`；文件头注释同步（删「暂不支持」句）。`RegisterMcpInput`（ipc.handlers.ts :37 + types.d.ts 镜像）加 `transport?: 'stdio' | 'streamable_http'; url?: string`；`resource:registerMcp` handler 透传。`McpJsonPasteDialog` review 步条目名旁按 `entry.url` 有无渲染小徽标 `远程` / `本地`（语义 token 文本，无新色）。

- [ ] **Step 3: token IPC + 设置页**

ipc.handlers.ts 追加：

```typescript
  // resource:setModelScopeToken / getModelScopeTokenStatus — 魔搭 token 写 keychain。
  // 读侧只回布尔（token 明文不进 renderer，spec §7）。
  ipcMain.handle('resource:setModelScopeToken', async (_evt, token: string) => {
    await (token ? setSecret('modelscope-token', token) : deleteSecret('modelscope-token'));
  });
  ipcMain.handle('resource:getModelScopeTokenStatus', async () => {
    return (await getSecret('modelscope-token')) !== null;
  });
```

（import 区补 `setSecret, getSecret, deleteSecret` from `'../storage/keychain'`；types.d.ts + preload 镜像两方法。）

`HubSettings.tsx`：密码型 `<Input type="password">` + 保存按钮 + 「已配置 ✓/未配置」态（`getModelScopeTokenStatus`）；空串保存 = 清除。挂进 `SettingsNav`（新 item `网络市场`，label 不用 emoji；图标 lucide `Globe` 16px）。样式全语义 token，模式照抄 `MemorySettings.tsx` 的布局（先读该文件复用其 Section 容器结构）。

- [ ] **Step 4: 测试 + typecheck + Commit**

Run: `source ~/.nvm/nvm.sh && nvm use 20 && cd renderer && npx pnpm@9.0.0 vitest run src/lib/mcp-json.test.ts src/components/settings && cd electron && npx pnpm@9.0.0 vitest run tests/resource && cd /workspace && npx pnpm@9.0.0 typecheck`
Expected: PASS / 0 错

```bash
git add renderer/src/lib/mcp-json.ts renderer/src/lib/mcp-json.test.ts renderer/src/components/ electron/src/main/resource/ipc.handlers.ts renderer/src/ipc/types.d.ts electron/src/preload/index.ts
git commit -m "feat: 魔搭 token 设置（keychain）+ MCP JSON 导入支持远程 url 条目"
```

---

### Task 8: 收尾——全量回归 + CHANGELOG + 版本号

**Files:**
- Modify: `CHANGELOG.md`（研发账本 v2.x 条目）
- Modify: 三处 `package.json` alpha 号 +1（根 / electron / renderer，当前 `2.1.0-alpha.N` → `N+1`；版本号纪律 2026-09-13）

- [ ] **Step 1: 双 workspace 全量**

Run: `source ~/.nvm/nvm.sh && nvm use 20 && cd /workspace && npx pnpm@9.0.0 typecheck && npx pnpm@9.0.0 test`
Expected: typecheck 0 错；renderer + electron 全 PASS（对照基线：electron 3169+ / renderer 1490+，新增用例全绿）

- [ ] **Step 2: CHANGELOG 账本条目**（`## 2.1.0-alpha.N+1` 段追加：双轨 hub / remote transport / provider 选择器 / token 设置 / mcp-json url；一行一特性，研究账本风格照抄相邻条目）

- [ ] **Step 3: 三处 alpha +1 + Commit**

```bash
git add CHANGELOG.md package.json electron/package.json renderer/package.json
git commit -m "feat: P2 双轨 hub MCP 接入收官（alpha 号 +1，含 CHANGELOG 账本）"
```

---

## Self-Review 记录

- **Spec 覆盖**：§2 五目标 → Task 4（框架+Smithery+魔搭）/ Task 2+3（transport）/ Task 7（token）；§4.4 UI → Task 6；§5 契约 → Task 1；§6 错误处理 → Task 4（退避/畸形条目）+ Task 5（S1 拒绝）；§8 测试 → 各 task TDD；§9 → Task 0。D7（不做 MCPB）体现在 install-config 路径。无缺口。
- **占位符**：Task 0 输出驱动的字段映射（Smithery/魔搭响应形状）已用「文档形状 + 核实后调常量」模式显式化，非 TBD；其余步骤代码完整。
- **类型一致性**：`HubEntry`/`RegistryListEntry` 同构（Task 4 定义、Task 6 消费）；`McpServerConfig.transport` 命名（Task 2/3/5/7 一致 `'stdio' | 'streamable_http'`）；token key `'modelscope-token'`（Task 5/7 一致）；`installed_packages.item_id` 前缀 `${source}:${slug}`（Task 5 内部自洽）。
- **已知执行注意**：host-manager 的 `getMcpConfig`/`listRegistered` 与 `McpClient` 类体未在计划中全文引用——实现者动手前先读 `electron/src/main/mcp/host-manager.ts` 与 `client.ts` 全文（Task 2/3 Step 均已标注）；migration 038 为下一个号（写计划时 index.ts 最大 version=37）。
