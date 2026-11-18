# db-pro 数据库插件实施计划

> **执行者注意**：本计划须配合 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务执行。步骤用 `- [ ]` 复选框跟踪。

**Goal:** 实现 db-pro 插件——agent 可查 MySQL/PostgreSQL/Oracle/达梦（只读直查 + 写操作人工批准两段式），以 momo-studio 原生插件形态交付。

**Architecture:** 方案 B（spec §3）：agent 工具（`plugin:db-pro/*`，薄壳）→ `callService` → 主进程常驻 service（引擎子进程管理 + 写两段式状态机）→ db-engine 子进程（`node --openssl-legacy-provider`，四驱动连接池 + 只读校验器）。宿主侧唯一改动：`PluginServiceCtx` 注入 `humanGate` + tool_gate 面板 db 渲染分支 + answer 路由旁路。

**Tech Stack:** 插件仓（`../momo-plugin`，CJS）：mysql2 ^3.24 / pg ^8.23 / oracledb ^26（thin）/ dmdb ^1.0.52452（全纯 JS，零 native binding）。宿主仓（本仓）：TypeScript strict。

**Spec:** `docs/specs/2026-11-17-db-pro-plugin-design.md`（本计划从 spec 出发，执行者须同时读 spec）

## Global Constraints

- Node 24：两仓统一 `nvm use 24`；宿主仓命令前缀 `npx pnpm@9.0.0`；插件依赖在 `plugins/db-pro/` 内直接 `npm install`
- 宿主仓 TypeScript strict：禁 `any` / `@ts-ignore` / `as any`；插件运行时代码为 CJS + `'use strict'` + 中文注释
- 四驱动只准纯 JS 包，**禁止引入任何 native binding 依赖**（ABI 噩梦红线）
- 连接串只经引擎 stdin 传递：禁止进 argv（`ps` 可见）、禁止写日志、禁止落盘；日志输出一律脱敏
- 测试位置：宿主 `electron/tests/**`（集中）与 renderer 贴源；插件仓 `tests/db-pro/*.test.mjs`（ESM 测试文件引 CJS 源，default interop）
- Conventional Commits（插件仓 `feat(db-pro):` / 宿主仓 `feat(plugin):`）；不 push 远端
- 插件仓路径 `../momo-plugin`（sibling）。**Task 1 首步确认存在**；缺失则停下问用户仓库地址，不擅自 clone
- `spike/RESULT.md`（Task 1 产出）是 Task 13 Runtime 阶梯实现的输入

## Review Focus

执行者读完 spec 后对照——五类最可能咬人的输入/失效模式，均已锚定到归属任务的测试：

1. **只读校验绕过**：注释/字符串藏分号、`WITH…INSERT`、`SELECT…FOR UPDATE`、`INTO OUTFILE`、以及误杀面 `SHOW CREATE TABLE`（外层含 CREATE 关键词）→ Task 4 穷举单测（含全部正负例）
2. **dmdb API 形状不确定**（createPool 选项名 / 结果集形状 / lastExecInfo.explain / DBMS_METADATA 可用性——达梦无公开 API 文档）→ Task 17 集成测试是仲裁者；驱动文件头已标注「以集成实测校正」，集成失败时改驱动不改契约（方言 SQL 映射以真库行为为准修正并锁定样本）
3. **写重复执行**：service/引擎重启后 approved 请求重放 → Task 14 `write-log.jsonl` 持久化 + `replayed` 语义测试（幂等：同一 requestId 至多执行一次）
4. **sessionId 断链**：write 不带 sessionId → human_requests NOT NULL 崩 / 面板不显示 → Task 15 工具层注入 `toolCtx.streamSessionId` + Task 14 守卫测试
5. **Runtime 阶梯失效**：ELECTRON_RUN_AS_NODE 无 legacy provider（达梦握手报 6071 加密错误）→ Task 1 Spike 判定阶梯命中级 + Task 18 手验 dm 真连接

---

## Phase 0 — Spike

### Task 1: [momo-plugin] Spike #0：Runtime 阶梯验证 + 四库 docker 环境

**Files:**
- Create: `../momo-plugin/tests/docker/docker-compose.yml`
- Create: `../momo-plugin/plugins/db-pro/package.json`
- Create: `../momo-plugin/plugins/db-pro/spike/spike-openssl.js`
- Create: `../momo-plugin/plugins/db-pro/spike/RESULT.md`（步骤产出，结论回填）
- Modify: `../momo-plugin/.gitignore`（追加 `plugins/db-pro/node_modules/`，若已含 `node_modules` 通配则跳过）

**Interfaces:**
- Produces: `spike/RESULT.md` 的「阶梯命中级别」结论（Task 13 消费）；docker 四库端口约定（Task 17 消费）：mysql `127.0.0.1:13306`、pg `:15432`、oracle `:11521/FREEPDB1`、dm `:15236`

- [ ] **Step 1: 确认插件仓存在**

Run: `ls ../momo-plugin/plugins`（应有 codegraph 目录）
若目录不存在：**停下询问用户** momo-plugin 仓库地址，不要擅自 clone。

- [ ] **Step 2: 写 docker-compose（四库）**

`../momo-plugin/tests/docker/docker-compose.yml`：

```yaml
# db-pro 集成测试四库（OrbStack）。宿主端口避开常用口。
services:
  mysql:
    image: mysql:8
    container_name: dbpro-mysql
    environment:
      MYSQL_ROOT_PASSWORD: dbpro123
      MYSQL_DATABASE: dbpro
    ports: ["13306:3306"]
  pg:
    image: postgres:16
    container_name: dbpro-pg
    environment:
      POSTGRES_PASSWORD: dbpro123
      POSTGRES_DB: dbpro
    ports: ["15432:5432"]
  oracle:
    image: gvenzl/oracle-free:23-slim
    container_name: dbpro-oracle
    environment:
      APP_USER: dbpro
      APP_USER_PASSWORD: dbpro123
    ports: ["11521:1521"]
  dm:
    image: chillzhuang/dm:8.1.2.128
    container_name: dbpro-dm
    environment:
      PAGE_SIZE: "16"
      LD_LIBRARY_PATH: /opt/dmdbms/bin
      INSTANCE_NAME: dm8_test
    ports: ["15236:5236"]
```

若 `chillzhuang/dm` 镜像拉取失败：从达梦官网下载 dm8 docker tar 包 `docker load` 替代，并在 RESULT.md 记录实际镜像与 SYSDBA 初始口令（该镜像常见初始口令 `SYSDBA/SYSDBA` 或 `SYSDBA/SYSDBA001`，以容器日志/disql 实测为准回填）。

- [ ] **Step 3: 写插件 package.json + 装依赖**

`../momo-plugin/plugins/db-pro/package.json`：

```json
{
  "name": "momo-plugin-db-pro",
  "version": "0.1.0",
  "private": true,
  "description": "db-pro 插件运行时依赖（四库纯 JS 驱动）",
  "dependencies": {
    "mysql2": "^3.24.6",
    "pg": "^8.23.1",
    "oracledb": "^26.0.0",
    "dmdb": "^1.0.52452"
  }
}
```

Run: `cd ../momo-plugin/plugins/db-pro && npm install`
Expected: 四包安装成功，零 native 编译产物。

- [ ] **Step 4: 起四库**

Run: `docker compose -f ../momo-plugin/tests/docker/docker-compose.yml up -d && docker ps --format '{{.Names}} {{.Status}}'`
Expected: 四容器 Up（oracle/dm 首启初始化需 1-3 分钟，`docker logs dbpro-dm 2>&1 | tail -5` 看到 instance ready 再继续）。

- [ ] **Step 5: 写 spike 脚本**

`../momo-plugin/plugins/db-pro/spike/spike-openssl.js`：

```js
// Spike #0：判定 Runtime 阶梯（spec §3.2 / D4）。
// 用法（均在 plugins/db-pro 目录下执行）：
//   node --openssl-legacy-provider spike/spike-openssl.js [--connect]
//   ELECTRON_RUN_AS_NODE=1 <electron二进制> --openssl-legacy-provider spike/spike-openssl.js --connect
'use strict';
const crypto = require('node:crypto');

function legacyProbe() {
  // OpenSSL 3 默认 provider 不含 DES/MD4 等 legacy 算法；开 legacy provider 后可见。
  // 达梦握手加密依赖 legacy cipher（spec §1.3 事实 3）。
  let desEde3Cbc = false;
  try {
    crypto.createCipheriv('des-ede3-cbc', Buffer.alloc(24), Buffer.alloc(8));
    desEde3Cbc = true;
  } catch {
    desEde3Cbc = false;
  }
  return { md4: crypto.getHashes().includes('md4'), desEde3Cbc };
}

async function dmConnect() {
  const dmdb = require('dmdb');
  const host = process.env.DBPRO_DM_HOST ?? '127.0.0.1';
  const port = Number(process.env.DBPRO_DM_PORT ?? 15236);
  const user = process.env.DBPRO_DM_USER ?? 'SYSDBA';
  const password = process.env.DBPRO_DM_PASSWORD ?? 'SYSDBA';
  const pool = await dmdb.createPool({ host, port, user, password });
  await pool.execute('SELECT 1 AS OK FROM DUAL');
  await pool.close();
}

async function main() {
  console.log('node:', process.version, '| execPath:', process.execPath);
  console.log('execArgv:', process.execArgv.join(' '));
  console.log('legacy algorithms:', JSON.stringify(legacyProbe()));
  if (process.argv.includes('--connect')) {
    await dmConnect();
    console.log('[dm] legacy provider 生效且达梦握手成功');
  }
}
main().catch((err) => {
  console.error('[spike] 失败:', err.message);
  process.exit(1);
});
```

- [ ] **Step 6: 阶梯 L2 判定——系统 node + flag**

Run: `cd ../momo-plugin/plugins/db-pro && node --openssl-legacy-provider spike/spike-openssl.js --connect`
Expected: `legacy algorithms: {"md4":true,...}` + `[dm] …成功`。若 createPool 报 6071/加密类错误 → 达梦侧口令或镜像问题，先修容器再重试。

- [ ] **Step 7: 阶梯 L1 判定——ELECTRON_RUN_AS_NODE（首选）**

定位 Electron 二进制：`ls ../momo-studio/node_modules/electron/dist/`（macOS 为 `dist/Electron.app/Contents/MacOS/Electron`）。

```bash
cd ../momo-plugin/plugins/db-pro && \
ELECTRON_RUN_AS_NODE=1 ../../../momo-studio/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron \
  --openssl-legacy-provider spike/spike-openssl.js --connect
```
Expected（L1 命中）: 同 Step 6 成功输出（node 版本显示 24.x 线）。
失败形态（L1 不命中）: `legacy algorithms: {"md4":false,…}` 或握手错误 → 记录失败输出全文。

- [ ] **Step 8: 写 RESULT.md**

`../momo-plugin/plugins/db-pro/spike/RESULT.md`：

```markdown
# Spike #0 结论（Runtime 阶梯）

日期：<执行日>

| 级别 | Runtime | legacy provider | dm 真握手 | 结论 |
|---|---|---|---|---|
| L1（首选） | ELECTRON_RUN_AS_NODE + --openssl-legacy-provider | <true/false> | <ok/失败原因> | <命中/不命中> |
| L2（回退 A） | 系统 node + --openssl-legacy-provider | <true/false> | <ok/失败原因> | <命中/不命中> |
| L3（回退 B） | vendor node 二进制 | — | — | 未测（仅 L1/L2 均不命中时启用） |

**最终阶梯命中：L<n>**——Task 13 spawnLadderArgs 按此实现。

附注（dm 容器镜像与口令、异常输出全文）：<按实回填>
```

- [ ] **Step 9: 提交**

```bash
git -C ../momo-plugin add plugins/db-pro/package.json plugins/db-pro/spike tests/docker .gitignore
git -C ../momo-plugin commit -m "feat(db-pro): Spike #0 Runtime 阶梯验证 + 四库 docker 环境"
```

（`node_modules/` 不入库。）

---

## Phase A — 引擎（momo-plugin 仓）

### Task 2: 插件骨架 + dev 安装验证

**Files:**
- Create: `../momo-plugin/plugins/db-pro/momo-plugin.json`
- Create: `../momo-plugin/plugins/db-pro/tools/index.js`（最小桩，Task 15 落全量）
- Create: `../momo-plugin/plugins/db-pro/service/index.js`（最小桩，Task 13/14 落实现）
- Create: `../momo-plugin/plugins/db-pro/skills/db-usage/SKILL.md`（最小可用，Task 16 扩全）

**Interfaces:**
- Consumes: 宿主 manifest 校验（`electron/src/main/plugin/manifest.ts`：components 路径须存在；service 入口为 `<root>/<components.service>/index.js` 且导出 `createService`；tools 目录内 `.js` 模块导出 `createTools`）
- Produces: 插件 id `db-pro`；工具命名空间 `plugin:db-pro/*`（宿主自动加前缀）；config 槽位键形（Task 13 `config-connections.js` 消费同一批键名）

- [ ] **Step 1: 写 manifest（全量 config schema——槽位制，spec §4.3）**

`../momo-plugin/plugins/db-pro/momo-plugin.json`：

```json
{
  "id": "db-pro",
  "name": "db-pro 数据库工具",
  "version": "0.1.0",
  "description": "MySQL / PostgreSQL / Oracle / 达梦 查询：只读直查 + 写操作人工批准（多连接）",
  "minAppVersion": "2.1.0",
  "components": { "tools": "./tools", "service": "./service", "skills": "./skills" },
  "config": {
    "type": "object",
    "properties": {
      "conn1_url": { "type": "string", "title": "连接 1 · URL（mysql:// postgres:// oracle:// dm://）", "sensitive": true },
      "conn1_name": { "type": "string", "title": "连接 1 · 名称（缺省 conn1）" },
      "conn2_url": { "type": "string", "title": "连接 2 · URL", "sensitive": true },
      "conn2_name": { "type": "string", "title": "连接 2 · 名称（缺省 conn2）" },
      "conn3_url": { "type": "string", "title": "连接 3 · URL", "sensitive": true },
      "conn3_name": { "type": "string", "title": "连接 3 · 名称（缺省 conn3）" },
      "conn4_url": { "type": "string", "title": "连接 4 · URL", "sensitive": true },
      "conn4_name": { "type": "string", "title": "连接 4 · 名称（缺省 conn4）" },
      "conn5_url": { "type": "string", "title": "连接 5 · URL", "sensitive": true },
      "conn5_name": { "type": "string", "title": "连接 5 · 名称（缺省 conn5）" },
      "conn6_url": { "type": "string", "title": "连接 6 · URL", "sensitive": true },
      "conn6_name": { "type": "string", "title": "连接 6 · 名称（缺省 conn6）" },
      "default_connection": { "type": "string", "title": "缺省连接名（工具省略 connection 时使用）" },
      "readonly_max_rows": { "type": "number", "title": "只读查询返回行数上限（缺省 200）" },
      "query_timeout_ms": { "type": "number", "title": "单查询超时毫秒（缺省 30000）" }
    }
  }
}
```

注意：config 属性键须匹配宿主 `isConfigKey`（`/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/`，无点号）——上述键全部合法。

- [ ] **Step 2: 写 tools 桩**

`../momo-plugin/plugins/db-pro/tools/index.js`：

```js
'use strict';
// 骨架占位（Task 15 落全量 11 工具）：保证 manifest 校验与宿主加载通过。
function createTools() {
  return {
    getDefs: () => [],
    getCatalog: () => [],
    handles: () => false,
    execute: async () => {
      throw new Error('db-pro 工具面尚未实现（Task 15）');
    },
  };
}
module.exports = { createTools };
```

- [ ] **Step 3: 写 service 桩**

`../momo-plugin/plugins/db-pro/service/index.js`：

```js
'use strict';
// 骨架占位（Task 13/14 落实现）。
function createService(ctx) {
  return {
    async start() {
      ctx.logger.info('db-pro service 骨架启动（实现见 Task 13/14）');
    },
    async stop() {},
    async handle() {
      throw new Error('db-pro service 尚未实现（Task 13/14）');
    },
  };
}
module.exports = { createService };
```

- [ ] **Step 4: 写 skill 最小版**

`../momo-plugin/plugins/db-pro/skills/db-usage/SKILL.md`：

```markdown
---
name: db-usage
description: 使用 db-pro 插件查询数据库的正确姿势（只读直查 + 写操作人工批准两段式）
---

# db-pro 数据库查询指引

核心规则：查询前先探索结构（list_connections → list_tables → describe_table）；
写操作必须 write → 用户批准 → write_status 两段式，批准前绝不声称已执行。
（骨架版本，Task 16 扩全。）
```

- [ ] **Step 5: dev 安装验证（宿主 app 手验）**

Run: `npx pnpm@9.0.0 dev`（宿主仓根目录）
操作：设置 → 插件 → 开发目录安装 → 选 `../momo-plugin/plugins/db-pro`。
Expected: 资源库出现「db-pro」插件卡；skills 页签出现 db-usage；主进程日志见 `db-pro service 骨架启动`；无 manifest 校验错误。

- [ ] **Step 6: 提交**

```bash
git -C ../momo-plugin add plugins/db-pro
git -C ../momo-plugin commit -m "feat(db-pro): 插件骨架（manifest 槽位 config + tools/service 桩 + skill 最小版）"
```

### Task 3: 引擎协议核心 protocol.js

**Files:**
- Create: `../momo-plugin/plugins/db-pro/engine/protocol.js`
- Test: `../momo-plugin/tests/db-pro/protocol.test.mjs`

**Interfaces:**
- Produces（后续任务全部依赖）:
  - `runServer(dispatch: (method: string, params: object) => Promise<unknown>): void` —— stdin NDJSON → dispatch → stdout NDJSON
  - `createLineFramer(): { feed(chunk: string): string[]; flush(): string[] }`
  - `class EngineError extends Error { code: string }`；`CODES = { BAD_REQUEST:'bad_request', UNKNOWN_METHOD:'unknown_method', VALIDATION:'readonly_rejected', CONN:'connection_failed', TIMEOUT:'query_timeout', DRIVER:'driver_error', INTERNAL:'internal' }`
  - 线上形态：请求 `{id:number, method:string, params:object}`；响应 `{id, result:object}` 或 `{id, error:{code, message}}`（error.code=`readonly_rejected` 即只读校验拒绝）

- [ ] **Step 1: 写失败测试**

`../momo-plugin/tests/db-pro/protocol.test.mjs`：

```js
// 引擎协议核心单测：帧解析 + runServer 分发（fake dispatcher 注入）
import { describe, it, expect, vi } from 'vitest';
import protoMod from '../../plugins/db-pro/engine/protocol.js';
const { CODES, EngineError, createLineFramer, runServer } = protoMod;

const settle = () => new Promise((r) => setTimeout(r, 20));

describe('createLineFramer', () => {
  it('跨 chunk 半行拼接', () => {
    const f = createLineFramer();
    expect(f.feed('{"a":1}\n{"b"')).toEqual(['{"a":1}']);
    expect(f.feed(':2}\n')).toEqual(['{"b":2}']);
  });
  it('空行跳过 + flush 冲刷尾部残留', () => {
    const f = createLineFramer();
    expect(f.feed('  \n{"x"')).toEqual([]);
    expect(f.flush()).toEqual(['{"x"}']);
  });
});

describe('runServer', () => {
  it('result 通道：dispatcher 返回值原样回带 id', async () => {
    const writes = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((s) => { writes.push(String(s)); return true; });
    const emit = (line) => process.stdin.emit('data', Buffer.from(line));
    try {
      runServer(async (method, params) => ({ echoed: method, params }));
      emit(JSON.stringify({ id: 7, method: 'ping', params: { a: 1 } }) + '\n');
      await settle();
      const resp = JSON.parse(writes.find((w) => w.includes('"id":7')));
      expect(resp.result).toEqual({ echoed: 'ping', params: { a: 1 } });
    } finally {
      spy.mockRestore();
      process.stdin.removeAllListeners('data');
    }
  });
  it('EngineError 带 code；普通错误落 INTERNAL；非法 JSON 回 BAD_REQUEST', async () => {
    const writes = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((s) => { writes.push(String(s)); return true; });
    const emit = (line) => process.stdin.emit('data', Buffer.from(line));
    try {
      runServer(async () => { throw new EngineError(CODES.VALIDATION, '只读拒绝'); });
      emit('{"id":1,"method":"x"}\n');
      await settle();
      runServer(async () => { throw new Error('boom'); });
      emit('{"id":2,"method":"x"}\n');
      emit('not-json\n');
      await settle();
      expect(JSON.parse(writes.find((w) => w.includes('"id":1'))).error).toEqual({ code: 'readonly_rejected', message: '只读拒绝' });
      expect(JSON.parse(writes.find((w) => w.includes('"id":2'))).error.code).toBe('internal');
      expect(JSON.parse(writes.find((w) => w.includes('"id":null'))).error.code).toBe('bad_request');
    } finally {
      spy.mockRestore();
      process.stdin.removeAllListeners('data');
    }
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd ../momo-plugin && npx vitest run tests/db-pro/protocol.test.mjs`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现 protocol.js**

`../momo-plugin/plugins/db-pro/engine/protocol.js`：

```js
'use strict';
// 引擎协议（spec §4.4）：NDJSON JSON-RPC——stdin 每行一个请求、stdout 每行一个响应。

/** 协议错误码（只读拒绝 = readonly_rejected，上层据此给人话提示） */
const CODES = {
  BAD_REQUEST: 'bad_request',
  UNKNOWN_METHOD: 'unknown_method',
  VALIDATION: 'readonly_rejected',
  CONN: 'connection_failed',
  TIMEOUT: 'query_timeout',
  DRIVER: 'driver_error',
  INTERNAL: 'internal',
};

class EngineError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'EngineError';
    this.code = code;
  }
}

/** 行分帧器：喂入 chunk，产出完整行；半行缓冲跨 chunk 拼接 */
function createLineFramer() {
  let buf = '';
  return {
    feed(chunk) {
      buf += chunk;
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      return lines.filter((l) => l.trim() !== '');
    },
    flush() {
      const rest = buf.trim();
      buf = '';
      return rest === '' ? [] : [rest];
    },
  };
}

/**
 * 服务主循环：stdin 帧解析 → dispatcher → stdout 写响应。
 * dispatcher 抛 EngineError 走 error.code，其他错误落 internal。
 */
function runServer(dispatcher) {
  const framer = createLineFramer();
  const write = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
  process.stdin.on('data', (chunk) => {
    for (const line of framer.feed(String(chunk))) {
      let req = null;
      try {
        req = JSON.parse(line);
      } catch {
        write({ id: null, error: { code: CODES.BAD_REQUEST, message: '非法 JSON 行' } });
        continue;
      }
      if (req === null || typeof req !== 'object' || typeof req.method !== 'string') {
        write({ id: typeof req?.id === 'number' ? req.id : null, error: { code: CODES.BAD_REQUEST, message: '请求须为 {id, method, params}' } });
        continue;
      }
      void Promise.resolve()
        .then(() => dispatcher(req.method, req.params ?? {}))
        .then((result) => write({ id: req.id, result }))
        .catch((err) => {
          const code = err instanceof EngineError ? err.code : CODES.INTERNAL;
          write({ id: req.id, error: { code, message: err instanceof Error ? err.message : String(err) } });
        });
    }
  });
}

module.exports = { CODES, EngineError, createLineFramer, runServer };
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd ../momo-plugin && npx vitest run tests/db-pro/protocol.test.mjs`
Expected: PASS（4 用例全绿）。

- [ ] **Step 5: 提交**

```bash
git -C ../momo-plugin add plugins/db-pro/engine/protocol.js tests/db-pro/protocol.test.mjs
git -C ../momo-plugin commit -m "feat(db-pro): 引擎 NDJSON JSON-RPC 协议核心（分帧/分发/错误码）"
```

### Task 4: 只读 SQL 校验器

**Files:**
- Create: `../momo-plugin/plugins/db-pro/engine/sql-validator.js`
- Test: `../momo-plugin/tests/db-pro/sql-validator.test.mjs`

**Interfaces:**
- Produces:
  - `assertReadOnly(sql: string): { ok: true } | { ok: false, reason: string }`（引擎 query 前置，Task 9 消费）
  - `classifyWrite(sql: string): { opClass: 'DML' | 'DDL' | 'REJECT', reason?: string }`（service write 前置，Task 14 消费）
  - `stripLiteralsAndComments(sql)` / `outerSkeleton(sql)`（导出仅为测试与复用）

- [ ] **Step 1: 写失败测试（穷举——Review Focus #1 的锚）**

`../momo-plugin/tests/db-pro/sql-validator.test.mjs`：

```js
// 只读校验穷举（spec §6.1）：白名单 / 禁多语句 / 拒锁 / 注释与字面量剥离 / 误杀面
import { describe, it, expect } from 'vitest';
import v from '../../plugins/db-pro/engine/sql-validator.js';
const { assertReadOnly, classifyWrite } = v;

describe('assertReadOnly 正例（必须放行）', () => {
  const ok = [
    'SELECT 1',
    "select * from t where name = 'x'",
    "SELECT 'a;b' AS c",                          // 字符串里的分号不触发多语句
    "SELECT * FROM t WHERE note = 'update soon'", // 字符串里的写词不触发
    'SHOW CREATE TABLE dbpro.t',                  // 外层含 CREATE 关键词但不误杀（首词 SHOW）
    'DESCRIBE t',
    'EXPLAIN SELECT * FROM t',
    'WITH c AS (SELECT 1) SELECT * FROM c',       // CTE 读
    'SELECT /* 注释; 含分号 */ 1',                 // 块注释里的分号
    'SELECT 1 -- 行注释 UPDATE',
  ];
  for (const sql of ok) it(sql.slice(0, 40), () => expect(assertReadOnly(sql).ok).toBe(true));
});

describe('assertReadOnly 负例（必须拒绝且 reason 人话）', () => {
  const bad = [
    ['UPDATE t SET a = 1', '首词'],
    ['DELETE FROM t', '首词'],
    ['INSERT INTO t VALUES (1)', '首词'],
    ['SELECT * FROM t FOR UPDATE', '锁定子句'],
    ['select 1 for share', '锁定子句'],
    ['SELECT 1; DROP TABLE t', '多语句'],
    ['SELECT 1;SELECT 2', '多语句'],
    ['WITH c AS (SELECT 1) INSERT INTO t SELECT * FROM c', '写关键词'],
    ["SELECT 1 INTO OUTFILE '/tmp/x'", 'OUTFILE'],
    ['TRUNCATE TABLE t', '首词'],
    ['', 'SQL 为空'],
    ['   ', 'SQL 为空'],
    ['CREATE TABLE t (a int)', '首词'],
  ];
  for (const [sql, why] of bad) it(`${why}：${sql.slice(0, 40) || '(空)'}`, () => {
    const r = assertReadOnly(sql);
    expect(r.ok).toBe(false);
    expect(r.reason.length).toBeGreaterThan(4);
  });
});

describe('classifyWrite', () => {
  it.each([
    ['INSERT INTO t VALUES (1)', 'DML'],
    ['update t set a=1', 'DML'],
    ['DELETE FROM t', 'DML'],
    ['MERGE INTO t USING s ON (1=1)', 'DML'],
    ['CREATE TABLE x (a int)', 'DDL'],
    ['DROP TABLE x', 'DDL'],
    ['ALTER TABLE x ADD c int', 'DDL'],
    ['TRUNCATE TABLE x', 'DDL'],
  ])('%s → %s', (sql, opClass) => expect(classifyWrite(sql).opClass).toBe(opClass));
  it.each([
    ['SELECT 1', 'REJECT'],
    ['GRANT ALL ON t TO u', 'REJECT'],
    ['EXEC pkg.proc', 'REJECT'],
    ['DELETE FROM t; SELECT 1', 'REJECT'], // 多语句拒绝
  ])('%s → %s', (sql, opClass) => expect(classifyWrite(sql).opClass).toBe(opClass));
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd ../momo-plugin && npx vitest run tests/db-pro/sql-validator.test.mjs`
Expected: FAIL。

- [ ] **Step 3: 实现 sql-validator.js**

`../momo-plugin/plugins/db-pro/engine/sql-validator.js`：

```js
'use strict';
// 只读 SQL 校验器（spec §6.1）——引擎层纵深防御，不信任 LLM 遵守工具描述。
// 策略：剥离字面量/注释 → 禁分号（多语句）→ 拒锁子句/OUTFILE（全文检测，
// 接受误杀）→ 首词白名单 → SELECT/WITH 主语句的外层写关键词检测
// （SHOW CREATE TABLE 等只读前缀语句不检测——防误杀）。
// 误杀面由剥离步骤消除；仍误杀的合法 SQL 接受并引导改写（spec R4）。

const READ_FIRST_WORDS = new Set(['select', 'show', 'describe', 'desc', 'explain', 'with']);
/** 锁定与文件导出子句：全文检测（含子查询内——误杀可接受，spec R4） */
const DENY_CLAUSES = /\bfor\s+update\b|\bfor\s+share\b|\block\s+in\s+share\s+mode\b|\binto\s+(outfile|dumpfile)\b/i;
/** 外层写关键词（仅 SELECT/WITH 主语句检测——SHOW CREATE TABLE 等不误杀） */
const WRITE_KEYWORDS = /\b(insert|update|delete|merge|create|drop|alter|truncate|rename|grant|revoke|call|exec|execute|lock|load|set|vacuum|analyze|comment|audit|flashback|purge|shutdown|commit|rollback|savepoint)\b/i;

/** 剥离字符串字面量（'…"…`，双写转义）与注释（-- / # / 块），占位为空格 */
function stripLiteralsAndComments(sql) {
  let out = '';
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    const two = sql.slice(i, i + 2);
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      i += 1;
      while (i < n) {
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) { i += 2; continue; } // 双写转义
          i += 1;
          break;
        }
        i += 1;
      }
      out += ' ';
      continue;
    }
    if (two === '--' || c === '#') {
      while (i < n && sql[i] !== '\n') i += 1;
      continue;
    }
    if (two === '/*') {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? n : end + 2;
      out += ' ';
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/** 括号深度 0 的骨架（子查询/函数体挖空） */
function outerSkeleton(stripped) {
  let out = '';
  let depth = 0;
  for (const c of stripped) {
    if (c === '(') { depth += 1; out += ' '; continue; }
    if (c === ')') { depth = Math.max(0, depth - 1); out += ' '; continue; }
    out += depth === 0 ? c : ' ';
  }
  return out;
}

function firstWordOf(skeleton) {
  return (skeleton.trim().match(/^[a-zA-Z]+/) ?? [''])[0].toLowerCase();
}

/** 只读校验：通过 {ok:true}；拒绝 {ok:false, reason}（人话 + 改正指引） */
function assertReadOnly(sqlRaw) {
  if (typeof sqlRaw !== 'string' || sqlRaw.trim() === '') return { ok: false, reason: 'SQL 为空' };
  const stripped = stripLiteralsAndComments(sqlRaw);
  if (stripped.includes(';')) {
    return { ok: false, reason: '拒绝多语句（检测到分号）。请每次只执行一条语句。' };
  }
  if (DENY_CLAUSES.test(stripped)) {
    return { ok: false, reason: '拒绝锁定/导出子句（FOR UPDATE / FOR SHARE / LOCK IN SHARE MODE / INTO OUTFILE）。' };
  }
  const skeleton = outerSkeleton(stripped);
  const firstWord = firstWordOf(skeleton);
  if (!READ_FIRST_WORDS.has(firstWord)) {
    return { ok: false, reason: `首词 "${firstWord || '(空)'}" 不在只读白名单（SELECT/SHOW/DESCRIBE/EXPLAIN/WITH）。写操作请使用 write 工具发起人工批准。` };
  }
  if (firstWord === 'select' || firstWord === 'with') {
    const m = skeleton.match(WRITE_KEYWORDS);
    if (m) {
      return { ok: false, reason: `外层语句包含写关键词 "${m[0].toUpperCase()}"。写操作请使用 write 工具发起人工批准。` };
    }
  }
  return { ok: true };
}

/** 写操作分类（service write 前置，spec §5.2） */
function classifyWrite(sqlRaw) {
  if (typeof sqlRaw !== 'string' || sqlRaw.trim() === '') return { opClass: 'REJECT', reason: 'SQL 为空' };
  const stripped = stripLiteralsAndComments(sqlRaw);
  if (stripped.includes(';')) return { opClass: 'REJECT', reason: '拒绝多语句——每次一条' };
  const firstWord = firstWordOf(outerSkeleton(stripped));
  if (['insert', 'update', 'delete', 'merge'].includes(firstWord)) return { opClass: 'DML' };
  if (['create', 'drop', 'alter', 'truncate', 'rename', 'comment'].includes(firstWord)) return { opClass: 'DDL' };
  return { opClass: 'REJECT', reason: `不支持的写操作首词 "${firstWord}"` };
}

module.exports = { assertReadOnly, classifyWrite, stripLiteralsAndComments, outerSkeleton };
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd ../momo-plugin && npx vitest run tests/db-pro/sql-validator.test.mjs`
Expected: PASS（穷举全绿）。

- [ ] **Step 5: 提交**

```bash
git -C ../momo-plugin add plugins/db-pro/engine/sql-validator.js tests/db-pro/sql-validator.test.mjs
git -C ../momo-plugin commit -m "feat(db-pro): 只读 SQL 校验器（白名单/禁多语句/拒锁，穷举锁定）"
```

### Task 5: MySQL 驱动适配层

**Files:**
- Create: `../momo-plugin/plugins/db-pro/engine/drivers/mysql.js`
- Test: `../momo-plugin/tests/db-pro/driver-mysql.test.mjs`（纯函数部分；全链路在 Task 17 集成覆盖）

**Interfaces:**
- Consumes: 无（本任务确立四驱动共享契约）
- Produces（**四驱动统一 Pool 契约**，Task 6/7/8 实现同一契约、Task 9 消费）:
  - `createPool(connUrl: string, opts: { queryTimeoutMs?: number }) → Promise<Pool>`
  - `Pool`：`dialect: string`；`ping()`；`query(sql, maxRows) → {columns, rows, total, truncated}`；`listSchemas() → string[]`；`listTables(schema?) → {schema,name,type}[]`；`listViews(schema?) → {schema,name}[]`；`describe(schema, table) → {columns, indexes, rowEstimate}`；`columns(schema, table) → Column[]`；`ddl(schema, table) → string`；`explain(sql) → {text, operators, summary}`；`exec(sql) → {affectedRows}`；`close()`

- [ ] **Step 1: 写失败测试（纯函数：URL 解析 + 标识符守卫）**

`../momo-plugin/tests/db-pro/driver-mysql.test.mjs`：

```js
import { describe, it, expect } from 'vitest';
import m from '../../plugins/db-pro/engine/drivers/mysql.js';
const { parseUrl, quoteIdent } = m;

describe('mysql parseUrl', () => {
  it('常规形态', () => {
    const c = parseUrl('mysql://root:dbpro123@127.0.0.1:13306/dbpro');
    expect(c).toEqual({ host: '127.0.0.1', port: 13306, user: 'root', password: 'dbpro123', database: 'dbpro' });
  });
  it('URL 编码的特殊字符密码（@ 与 :）', () => {
    const c = parseUrl('mysql://u:p%40ss%3Aword@h:3306/db');
    expect(c.password).toBe('p@ss:word');
  });
  it('缺端口默认 3306', () => {
    expect(parseUrl('mysql://u:p@h/db').port).toBe(3306);
  });
  it('非 mysql 协议拒绝', () => {
    expect(() => parseUrl('postgres://u:p@h/db')).toThrow(/mysql/);
  });
});

describe('mysql quoteIdent', () => {
  it('合法标识符加反引号', () => expect(quoteIdent('dbpro')).toBe('`dbpro`'));
  it('注入面拒绝（分号/点/空格）', () => {
    expect(() => quoteIdent('a;b')).toThrow();
    expect(() => quoteIdent('a.b')).toThrow();
    expect(() => quoteIdent('a b')).toThrow();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd ../momo-plugin && npx vitest run tests/db-pro/driver-mysql.test.mjs`
Expected: FAIL。

- [ ] **Step 3: 实现 mysql.js**

`../momo-plugin/plugins/db-pro/engine/drivers/mysql.js`：

```js
'use strict';
// MySQL 适配层（mysql2/promise，纯 JS）。URL：mysql://user:pass@host:3306/dbname
// 元数据走 information_schema；DDL 走 SHOW CREATE TABLE（spec §4.4）。
const mysql = require('mysql2/promise');

function parseUrl(url) {
  const u = new URL(url);
  if (u.protocol !== 'mysql:') throw new Error(`MySQL 连接串协议须为 mysql://（收到 ${u.protocol}//）`);
  return {
    host: u.hostname,
    port: Number(u.port || 3306),
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: decodeURIComponent(u.pathname.replace(/^\//, '')),
  };
}

function quoteIdent(v) {
  if (!/^[A-Za-z0-9_$]+$/.test(String(v))) throw new Error(`非法标识符: ${v}`);
  return `\`${v}\``;
}

function lit(v) {
  return v === null || v === undefined ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`;
}

/** Buffer → hex（BIT 列）；其余原样 */
function cell(c) {
  return Buffer.isBuffer(c) ? c.toString('hex') : c;
}

async function createPool(connUrl, opts = {}) {
  const timeoutMs = opts.queryTimeoutMs ?? 30_000;
  const cfg = parseUrl(connUrl);
  const pool = mysql.createPool({
    ...cfg,
    connectionLimit: 4,
    multipleStatements: false,
    dateStrings: true,
    supportBigNumbers: true,
  });

  /** 统一 run：SELECT/SHOW → rows 形态；无结果集语句 → header 形态 */
  async function run(sql, maxRows) {
    const [res, fields] = await pool.query({ sql, timeout: timeoutMs, rowsAsArray: true });
    if (!Array.isArray(res)) return { kind: 'header', affectedRows: res.affectedRows ?? 0 };
    const rows = res.map((r) => r.map(cell));
    const columns = (fields ?? []).map((f) => f.name);
    const truncated = rows.length > maxRows;
    return { kind: 'rows', columns, rows: truncated ? rows.slice(0, maxRows) : rows, total: rows.length, truncated };
  }

  async function describe(schema, table) {
    const cols = await run(
      `SELECT column_name, column_type, is_nullable, column_default, column_key, column_comment
         FROM information_schema.columns
        WHERE table_schema = ${lit(schema)} AND table_name = ${lit(table)}
        ORDER BY ordinal_position`, 2_000);
    const idx = await run(
      `SELECT index_name, column_name, non_unique
         FROM information_schema.statistics
        WHERE table_schema = ${lit(schema)} AND table_name = ${lit(table)}
        ORDER BY seq_in_index`, 2_000);
    const est = await run(
      `SELECT table_rows FROM information_schema.tables
        WHERE table_schema = ${lit(schema)} AND table_name = ${lit(table)}`, 1);
    const byName = new Map();
    const indexes = [];
    for (const [name, column, nonUnique] of idx.rows) {
      if (!byName.has(name)) {
        const ix = { name, columns: [], unique: Number(nonUnique) === 0 };
        byName.set(name, ix);
        indexes.push(ix);
      }
      byName.get(name).columns.push(column);
    }
    return {
      columns: cols.rows.map(([name, type, nullable, dflt, key, comment]) => ({
        name, type, nullable: nullable === 'YES', default: dflt ?? null, key, comment,
      })),
      indexes,
      rowEstimate: est.rows[0]?.[0] ?? null,
    };
  }

  return {
    dialect: 'mysql',
    ping: () => pool.query('SELECT 1'),
    async query(sql, maxRows) {
      const r = await run(sql, maxRows);
      if (r.kind !== 'rows') throw new Error('该语句未返回结果集');
      return r;
    },
    async listSchemas() {
      const r = await run('SELECT schema_name FROM information_schema.schemata ORDER BY schema_name', 1_000);
      return r.rows.map((x) => x[0]);
    },
    async listTables(schema) {
      const s = schema ?? cfg.database;
      const r = await run(
        `SELECT table_schema, table_name, table_type FROM information_schema.tables
          WHERE table_schema = ${lit(s)} ORDER BY table_name`, 5_000);
      return r.rows.map(([sch, name, t]) => ({ schema: sch, name, type: t === 'VIEW' ? 'view' : 'table' }));
    },
    async listViews(schema) {
      const t = await this.listTables(schema);
      return t.filter((x) => x.type === 'view').map(({ schema: sch, name }) => ({ schema: sch, name }));
    },
    describe,
    async columns(schema, table) {
      return (await describe(schema, table)).columns;
    },
    async ddl(schema, table) {
      const r = await run(`SHOW CREATE TABLE ${quoteIdent(schema)}.${quoteIdent(table)}`, 1);
      return String(r.rows[0]?.[1] ?? '');
    },
    async explain(sql) {
      const r = await run(`EXPLAIN ${sql}`, 64);
      const text = [r.columns.join(' | '), ...r.rows.map((row) => row.join(' | '))].join('\n');
      return { text, operators: [], summary: `${r.rows.length} 行计划` };
    },
    async exec(sql) {
      const r = await run(sql, 0);
      return { affectedRows: r.kind === 'header' ? r.affectedRows : r.rows.length };
    },
    async close() {
      await pool.end();
    },
  };
}

module.exports = { createPool, parseUrl, quoteIdent };
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd ../momo-plugin && npx vitest run tests/db-pro/driver-mysql.test.mjs`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git -C ../momo-plugin add plugins/db-pro/engine/drivers/mysql.js tests/db-pro/driver-mysql.test.mjs
git -C ../momo-plugin commit -m "feat(db-pro): MySQL 驱动适配层（information_schema 元数据 + SHOW CREATE DDL）"
```

### Task 6: PostgreSQL 驱动适配层

**Files:**
- Create: `../momo-plugin/plugins/db-pro/engine/drivers/pg.js`
- Test: `../momo-plugin/tests/db-pro/driver-pg.test.mjs`

**Interfaces:**
- Consumes: Task 5 统一 Pool 契约
- Produces: 同契约（postgres 方言）；DDL 为 catalog 拼装（spec §4.4——PG 无原生单表 DDL 查询）；`statement_timeout` 池级生效

- [ ] **Step 1: 写失败测试**

`../momo-plugin/tests/db-pro/driver-pg.test.mjs`：

```js
import { describe, it, expect } from 'vitest';
import m from '../../plugins/db-pro/engine/drivers/pg.js';
const { parseUrl } = m;

describe('pg parseUrl', () => {
  it('常规形态', () => {
    expect(parseUrl('postgres://u:p@127.0.0.1:15432/dbpro')).toEqual({
      host: '127.0.0.1', port: 15432, user: 'u', password: 'p', database: 'dbpro',
    });
  });
  it('postgresql:// 别名与 URL 编码密码', () => {
    const c = parseUrl('postgresql://u:p%40w@h/db');
    expect(c.password).toBe('p@w');
  });
  it('缺端口默认 5432', () => {
    expect(parseUrl('postgres://u:p@h/db').port).toBe(5432);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd ../momo-plugin && npx vitest run tests/db-pro/driver-pg.test.mjs`
Expected: FAIL。

- [ ] **Step 3: 实现 pg.js**

`../momo-plugin/plugins/db-pro/engine/drivers/pg.js`：

```js
'use strict';
// PostgreSQL 适配层（pg，纯 JS）。URL：postgres://user:pass@host:5432/dbname
// statement_timeout 池级生效（超时由服务端掐断）；DDL 由 catalog 拼装（spec §4.4）。
const { Pool } = require('pg');

function parseUrl(url) {
  const u = new URL(url);
  if (u.protocol !== 'postgres:' && u.protocol !== 'postgresql:') {
    throw new Error(`PG 连接串协议须为 postgres://（收到 ${u.protocol}//）`);
  }
  return {
    host: u.hostname,
    port: Number(u.port || 5432),
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: decodeURIComponent(u.pathname.replace(/^\//, '')),
  };
}

function qi(v) {
  if (!/^[A-Za-z0-9_$]+$/.test(String(v))) throw new Error(`非法标识符: ${v}`);
  return `"${v}"`;
}

async function createPool(connUrl, opts = {}) {
  const timeoutMs = opts.queryTimeoutMs ?? 30_000;
  const pool = new Pool({ connectionString: connUrl, max: 4, statement_timeout: timeoutMs });

  async function run(sql, values, maxRows) {
    const res = await pool.query({ text: sql, values: values ?? [], rowMode: 'array' });
    const rows = res.rows.map((r) => r.map((c) => {
      if (c === null || typeof c !== 'object' || c instanceof Date) return c;
      return JSON.stringify(c); // 数组/JSONB 等对象值串化
    }));
    const columns = (res.fields ?? []).map((f) => f.name);
    const truncated = rows.length > maxRows;
    return { columns, rows: truncated ? rows.slice(0, maxRows) : rows, total: rows.length, truncated, rowCount: res.rowCount ?? rows.length };
  }

  async function describe(schema, table) {
    const cols = await run(
      `SELECT c.column_name, c.data_type, c.is_nullable, c.column_default, pgd.description
         FROM information_schema.columns c
         LEFT JOIN pg_catalog.pg_statio_all_tables st
           ON st.schemaname = c.table_schema AND st.relname = c.table_name
         LEFT JOIN pg_catalog.pg_description pgd
           ON pgd.objoid = st.relid AND pgd.objsubid = c.ordinal_position
        WHERE c.table_schema = $1 AND c.table_name = $2
        ORDER BY c.ordinal_position`, [schema, table], 2_000);
    const pk = await run(
      `SELECT a.attname
         FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
        WHERE i.indrelid = ($1 || '.' || $2)::regclass AND i.indisprimary`, [schema, table], 100);
    const est = await run(
      `SELECT reltuples::bigint FROM pg_class WHERE oid = ($1 || '.' || $2)::regclass`, [schema, table], 1);
    return {
      columns: cols.rows.map(([name, type, nullable, dflt, comment]) => ({
        name, type, nullable: nullable === 'YES', default: dflt ?? null,
        key: pk.rows.some((x) => x[0] === name) ? 'PRI' : '', comment,
      })),
      indexes: [{ name: 'PRIMARY', columns: pk.rows.map((x) => x[0]), unique: true }],
      rowEstimate: est.rows[0]?.[0] ?? null,
    };
  }

  return {
    dialect: 'postgres',
    ping: () => pool.query('SELECT 1'),
    async query(sql, maxRows) {
      return await run(sql, [], maxRows);
    },
    async listSchemas() {
      const r = await run(
        `SELECT nspname FROM pg_namespace
          WHERE nspname NOT LIKE 'pg\\_%' AND nspname <> 'information_schema'
          ORDER BY nspname`, [], 1_000);
      return r.rows.map((x) => x[0]);
    },
    async listTables(schema) {
      const s = schema ?? 'public';
      const r = await run(
        `SELECT schemaname, tablename, 'table' FROM pg_tables WHERE schemaname = $1
          UNION ALL
         SELECT schemaname, viewname, 'view' FROM pg_views WHERE schemaname = $1
          ORDER BY 2`, [s], 5_000);
      return r.rows.map(([sch, name, kind]) => ({ schema: sch, name, type: kind }));
    },
    async listViews(schema) {
      const s = schema ?? 'public';
      const r = await run(`SELECT schemaname, viewname FROM pg_views WHERE schemaname = $1 ORDER BY viewname`, [s], 2_000);
      return r.rows.map(([sch, name]) => ({ schema: sch, name }));
    },
    describe,
    async columns(schema, table) {
      return (await describe(schema, table)).columns;
    },
    async ddl(schema, table) {
      const d = await describe(schema, table);
      const lines = d.columns.map((c) =>
        `  ${qi(c.name)} ${c.type}${c.nullable === false ? ' NOT NULL' : ''}${c.default !== null ? ` DEFAULT ${c.default}` : ''}`);
      const pk = d.indexes[0]?.columns ?? [];
      if (pk.length > 0) lines.push(`  PRIMARY KEY (${pk.map(qi).join(', ')})`);
      return `-- PG DDL 由 catalog 拼装（spec §4.4）\nCREATE TABLE ${qi(schema)}.${qi(table)} (\n${lines.join(',\n')}\n);`;
    },
    async explain(sql) {
      const r = await run(`EXPLAIN ${sql}`, [], 64);
      return { text: r.rows.map((x) => x[0]).join('\n'), operators: [], summary: `${r.rows.length} 行计划` };
    },
    async exec(sql) {
      const res = await pool.query({ text: sql, values: [] });
      return { affectedRows: res.rowCount ?? 0 };
    },
    async close() {
      await pool.end();
    },
  };
}

module.exports = { createPool, parseUrl };
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd ../momo-plugin && npx vitest run tests/db-pro/driver-pg.test.mjs`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git -C ../momo-plugin add plugins/db-pro/engine/drivers/pg.js tests/db-pro/driver-pg.test.mjs
git -C ../momo-plugin commit -m "feat(db-pro): PostgreSQL 驱动适配层（catalog 拼装 DDL）"
```

### Task 7: Oracle 驱动适配层（thin 模式）

**Files:**
- Create: `../momo-plugin/plugins/db-pro/engine/drivers/oracle.js`
- Test: `../momo-plugin/tests/db-pro/driver-oracle.test.mjs`

**Interfaces:**
- Consumes: Task 5 统一 Pool 契约
- Produces: 同契约（oracle 方言）；边界：**仅 thin 模式（12c+），11g 不支持**（spec D8）；URL 必须带服务名 `oracle://u:p@host:1521/SERVICE`；DDL 走 `DBMS_METADATA.GET_DDL`；EXPLAIN 走 `EXPLAIN PLAN` + `DBMS_XPLAN.DISPLAY`

- [ ] **Step 1: 写失败测试**

`../momo-plugin/tests/db-pro/driver-oracle.test.mjs`：

```js
import { describe, it, expect } from 'vitest';
import m from '../../plugins/db-pro/engine/drivers/oracle.js';
const { parseUrl } = m;

describe('oracle parseUrl', () => {
  it('常规形态（服务名进 connectString）', () => {
    expect(parseUrl('oracle://dbpro:dbpro123@127.0.0.1:11521/FREEPDB1').connectString)
      .toBe('127.0.0.1:11521/FREEPDB1');
  });
  it('缺服务名拒绝（thin 必须服务名连接）', () => {
    expect(() => parseUrl('oracle://u:p@h:1521')).toThrow(/服务名/);
  });
  it('URL 编码密码', () => {
    expect(parseUrl('oracle://u:p%40w@h:1521/SVC').password).toBe('p@w');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd ../momo-plugin && npx vitest run tests/db-pro/driver-oracle.test.mjs`
Expected: FAIL。

- [ ] **Step 3: 实现 oracle.js**

`../momo-plugin/plugins/db-pro/engine/drivers/oracle.js`：

```js
'use strict';
// Oracle 适配层（oracledb thin 模式——12c+ 免 Instant Client；11g 不支持，spec D8）。
// URL：oracle://user:pass@host:1521/SERVICE_NAME（服务名必填）。
// 目录走 ALL_* 兼容视图；DDL 走 DBMS_METADATA；EXPLAIN 走 EXPLAIN PLAN + DBMS_XPLAN。
const oracledb = require('oracledb');
oracledb.fetchAsString = [oracledb.CLOB]; // DBMS_METADATA 等 CLOB 直接取文本

function parseUrl(url) {
  const u = new URL(url);
  if (u.protocol !== 'oracle:') throw new Error(`Oracle 连接串协议须为 oracle://（收到 ${u.protocol}//）`);
  const service = decodeURIComponent(u.pathname.replace(/^\//, ''));
  if (service === '') throw new Error('Oracle 连接串须带服务名：oracle://user:pass@host:1521/SERVICE');
  return {
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    connectString: `${u.hostname}:${u.port || 1521}/${service}`,
  };
}

async function createPool(connUrl, opts = {}) {
  const timeoutMs = opts.queryTimeoutMs ?? 30_000;
  const cfg = parseUrl(connUrl);
  const pool = await oracledb.createPool({
    user: cfg.user,
    password: cfg.password,
    connectString: cfg.connectString,
    poolMin: 0,
    poolMax: 4,
    poolIncrement: 1,
  });

  async function withConn(fn) {
    const conn = await pool.getConnection();
    try {
      conn.callTimeout = timeoutMs;
      return await fn(conn);
    } finally {
      await conn.close();
    }
  }

  async function runRows(sql, binds, maxRows) {
    return await withConn(async (conn) => {
      const res = await conn.execute(sql, binds ?? {}, { outFormat: oracledb.OUT_FORMAT_ARRAY, maxRows: maxRows + 1 });
      const rows = (res.rows ?? []).map((r) => r.map((c) => {
        if (c === null || typeof c !== 'object' || c instanceof Date) return c;
        return JSON.stringify(c);
      }));
      const truncated = rows.length > maxRows;
      return {
        columns: (res.metaData ?? []).map((md) => md.name),
        rows: truncated ? rows.slice(0, maxRows) : rows,
        total: rows.length,
        truncated,
      };
    });
  }

  async function describe(schema, table) {
    const cols = await runRows(
      `SELECT column_name,
              data_type || CASE WHEN char_length IS NOT NULL THEN '(' || char_length || ')' ELSE '' END,
              nullable, data_default
         FROM all_tab_columns WHERE owner = :o AND table_name = :t ORDER BY column_id`,
      { o: schema, t: table }, 2_000);
    const idxCols = await runRows(
      `SELECT i.index_name, c.column_name, i.uniqueness
         FROM all_indexes i
         JOIN all_ind_columns c ON c.index_name = i.index_name AND c.index_owner = i.owner
        WHERE i.table_owner = :o AND i.table_name = :t
        ORDER BY c.column_position`,
      { o: schema, t: table }, 2_000);
    const est = await runRows(
      `SELECT num_rows FROM all_tables WHERE owner = :o AND table_name = :t`,
      { o: schema, t: table }, 1);
    const byName = new Map();
    const indexes = [];
    for (const [name, column, uniq] of idxCols.rows) {
      if (!byName.has(name)) {
        const ix = { name, columns: [], unique: uniq === 'UNIQUE' };
        byName.set(name, ix);
        indexes.push(ix);
      }
      byName.get(name).columns.push(column);
    }
    return {
      columns: cols.rows.map(([name, type, nullable, dflt]) => ({
        name, type, nullable: nullable === 'Y', default: dflt ?? null, key: '', comment: '',
      })),
      indexes,
      rowEstimate: est.rows[0]?.[0] ?? null,
    };
  }

  return {
    dialect: 'oracle',
    async ping() {
      await runRows('SELECT 1 FROM dual', {}, 1);
    },
    async query(sql, maxRows) {
      return await runRows(sql, {}, maxRows);
    },
    async listSchemas() {
      const r = await runRows(
        `SELECT username FROM all_users WHERE oracle_maintained = 'N' ORDER BY username`, {}, 2_000);
      return r.rows.map((x) => x[0]);
    },
    async listTables(schema) {
      const o = schema ?? cfg.user.toUpperCase();
      const r = await runRows(
        `SELECT owner, table_name, 'table' FROM all_tables WHERE owner = :o
          UNION ALL
         SELECT owner, view_name, 'view' FROM all_views WHERE owner = :o
          ORDER BY 2`, { o }, 5_000);
      return r.rows.map(([s, n, t]) => ({ schema: s, name: n, type: t }));
    },
    async listViews(schema) {
      const o = schema ?? cfg.user.toUpperCase();
      const r = await runRows(`SELECT owner, view_name FROM all_views WHERE owner = :o ORDER BY view_name`, { o }, 2_000);
      return r.rows.map(([s, n]) => ({ schema: s, name: n }));
    },
    describe,
    async columns(schema, table) {
      return (await describe(schema, table)).columns;
    },
    async ddl(schema, table) {
      const r = await runRows(
        `SELECT DBMS_METADATA.GET_DDL('TABLE', :t, :s) FROM dual`, { t: table, s: schema }, 1);
      return String(r.rows[0]?.[0] ?? '');
    },
    async explain(sql) {
      return await withConn(async (conn) => {
        await conn.execute(`EXPLAIN PLAN FOR ${sql}`); // 仅生成计划，不执行语句
        const res = await conn.execute(
          'SELECT plan_table_output FROM TABLE(DBMS_XPLAN.DISPLAY())',
          {}, { outFormat: oracledb.OUT_FORMAT_ARRAY, maxRows: 128 });
        const lines = (res.rows ?? []).map((r) => String(r[0] ?? ''));
        return { text: lines.join('\n'), operators: [], summary: lines.find((l) => l.includes('Cost')) ?? '' };
      });
    },
    async exec(sql) {
      return await withConn(async (conn) => {
        const res = await conn.execute(sql);
        return { affectedRows: res.rowsAffected ?? 0 };
      });
    },
    async close() {
      await pool.close();
    },
  };
}

module.exports = { createPool, parseUrl };
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd ../momo-plugin && npx vitest run tests/db-pro/driver-oracle.test.mjs`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git -C ../momo-plugin add plugins/db-pro/engine/drivers/oracle.js tests/db-pro/driver-oracle.test.mjs
git -C ../momo-plugin commit -m "feat(db-pro): Oracle 驱动适配层（thin 模式，DBMS_METADATA DDL）"
```

### Task 8: 达梦驱动适配层（explain 特化）

**Files:**
- Create: `../momo-plugin/plugins/db-pro/engine/drivers/dm.js`
- Test: `../momo-plugin/tests/db-pro/driver-dm.test.mjs`

**Interfaces:**
- Consumes: Task 5 统一 Pool 契约
- Produces: 同契约（dm 方言）；`parseExplainPlan(text)` 导出（explain 解析器，Task 17 用真实计划文本锁定样本）
- ⚠️ **Review Focus #2**：dmdb 的 createPool 选项名 / execute 结果集形状 / lastExecInfo 形态以 Task 17 集成实测为准；本任务按 node-oracledb 同构假设实现（dmdb API 模仿 oracledb），集成失败改驱动不改契约

- [ ] **Step 1: 写失败测试**

`../momo-plugin/tests/db-pro/driver-dm.test.mjs`：

```js
import { describe, it, expect } from 'vitest';
import m from '../../plugins/db-pro/engine/drivers/dm.js';
const { parseUrl, parseExplainPlan } = m;

describe('dm parseUrl', () => {
  it('常规形态 + 默认 schema = 用户名大写', () => {
    const c = parseUrl('dm://SYSDBA:SYSDBA@127.0.0.1:15236');
    expect(c).toEqual({ host: '127.0.0.1', port: 15236, user: 'SYSDBA', password: 'SYSDBA', schema: 'SYSDBA' });
  });
  it('显式 schema 段', () => {
    expect(parseUrl('dm://u:p@h:5236/APP').schema).toBe('APP');
  });
  it('dameng:// 别名与 URL 编码密码', () => {
    expect(parseUrl('dameng://u:p%40w@h:5236').password).toBe('p@w');
  });
  it('缺端口默认 5236', () => {
    expect(parseUrl('dm://u:p@h').port).toBe(5236);
  });
});

describe('parseExplainPlan（lastExecInfo.explain 文本）', () => {
  it('算子行 #OP 提取 + 首行摘要', () => {
    const text = [
      '1   ##NSET2: [0, 1, 4]',
      '2     #PRJT2: [0, 1, 4]',
      '3       #CSCN2: [0, 100, 4]; INDEX33558972(T)',
    ].join('\n');
    const p = parseExplainPlan(text);
    expect(p.operators).toEqual(['NSET2', 'PRJT2', 'CSCN2']);
    expect(p.summary).toContain('NSET2');
    expect(p.text).toBe(text);
  });
  it('空文本容忍', () => {
    expect(parseExplainPlan('')).toEqual({ text: '', operators: [], summary: '' });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd ../momo-plugin && npx vitest run tests/db-pro/driver-dm.test.mjs`
Expected: FAIL。

- [ ] **Step 3: 实现 dm.js**

`../momo-plugin/plugins/db-pro/engine/drivers/dm.js`：

```js
'use strict';
// 达梦 DM8 适配层（dmdb 官方 npm 驱动，纯 JS）。URL：dm://user:pass@host:5236[/SCHEMA]
// 关键特化（spec §1.3 事实 3）：EXPLAIN 不返回结果集——计划文本在驱动
// lastExecInfo.explain，本层读取并解析为 {text, operators, summary}。
// ⚠️ dmdb 无公开 API 文档：createPool 选项 / execute 结果形状按 node-oracledb
// 同构假设实现，以 Task 17 集成实测校正（Review Focus #2）。
const dmdb = require('dmdb');

function parseUrl(url) {
  const u = new URL(url);
  if (u.protocol !== 'dm:' && u.protocol !== 'dameng:') {
    throw new Error(`达梦连接串协议须为 dm://（收到 ${u.protocol}//）`);
  }
  const user = decodeURIComponent(u.username);
  const schema = decodeURIComponent(u.pathname.replace(/^\//, ''));
  return {
    host: u.hostname,
    port: Number(u.port || 5236),
    user,
    password: decodeURIComponent(u.password),
    schema: schema !== '' ? schema.toUpperCase() : user.toUpperCase(),
  };
}

/** 计划文本解析：算子行形如 `2  #PRJT2: [...]`——#后的算子名序列 + 首行摘要 */
function parseExplainPlan(text) {
  const t = String(text ?? '');
  const lines = t.split('\n').map((l) => l.trim()).filter(Boolean);
  const operators = lines
    .map((l) => (l.match(/#\s*([A-Z][A-Z0-9]*)/) ?? [])[1])
    .filter(Boolean);
  return { text: t, operators, summary: lines[0] ?? '' };
}

/** 结果行归一：dmdb 行可能为数组（oracledb ARRAY 形态）或对象（metaData 序） */
function normalizeRows(res) {
  const meta = (res.metaData ?? []).map((md) => md.name);
  const raw = res.rows ?? [];
  const rows = raw.map((r) => (Array.isArray(r) ? r : meta.map((k) => r?.[k])));
  const columns = meta.length > 0
    ? meta
    : (raw[0] !== undefined && !Array.isArray(raw[0]) ? Object.keys(raw[0]) : []);
  return { columns, rows };
}

async function createPool(connUrl, opts = {}) {
  const cfg = parseUrl(connUrl);
  const pool = await dmdb.createPool({ host: cfg.host, port: cfg.port, user: cfg.user, password: cfg.password });

  async function withConn(fn) {
    const conn = await pool.getConnection();
    try {
      return await fn(conn);
    } finally {
      await conn.close();
    }
  }

  async function runRows(sql, binds, maxRows) {
    return await withConn(async (conn) => {
      const res = await conn.execute(sql, binds ?? {});
      const { columns, rows } = normalizeRows(res);
      const norm = rows.map((r) => r.map((c) => {
        if (c === null || typeof c !== 'object' || c instanceof Date) return c;
        return JSON.stringify(c);
      }));
      const truncated = norm.length > maxRows;
      return { columns, rows: truncated ? norm.slice(0, maxRows) : norm, total: norm.length, truncated };
    });
  }

  async function describe(schema, table) {
    const cols = await runRows(
      `SELECT COLUMN_NAME, DATA_TYPE, NULLABLE, DATA_DEFAULT
         FROM ALL_TAB_COLUMNS WHERE OWNER = :o AND TABLE_NAME = :t ORDER BY COLUMN_ID`,
      { o: schema, t: table }, 2_000);
    const est = await runRows(
      `SELECT NUM_ROWS FROM ALL_TABLES WHERE OWNER = :o AND TABLE_NAME = :t`, { o: schema, t: table }, 1);
    return {
      columns: cols.rows.map(([name, type, nullable, dflt]) => ({
        name: String(name), type: String(type), nullable: String(nullable) === 'Y', default: dflt ?? null, key: '', comment: '',
      })),
      indexes: [],
      rowEstimate: est.rows[0]?.[0] ?? null,
    };
  }

  return {
    dialect: 'dm',
    async ping() {
      await runRows('SELECT 1 FROM DUAL', {}, 1);
    },
    async query(sql, maxRows) {
      return await runRows(sql, {}, maxRows);
    },
    async listSchemas() {
      const r = await runRows(`SELECT USERNAME FROM ALL_USERS ORDER BY USERNAME`, {}, 2_000);
      return r.rows.map((x) => String(x[0]));
    },
    async listTables(schema) {
      const o = schema ?? cfg.schema;
      const r = await runRows(
        `SELECT OWNER, TABLE_NAME, 'table' FROM ALL_TABLES WHERE OWNER = :o
          UNION ALL
         SELECT OWNER, VIEW_NAME, 'view' FROM ALL_VIEWS WHERE OWNER = :o
          ORDER BY 2`, { o }, 5_000);
      return r.rows.map(([s, n, t]) => ({ schema: String(s), name: String(n), type: String(t) }));
    },
    async listViews(schema) {
      const o = schema ?? cfg.schema;
      const r = await runRows(`SELECT OWNER, VIEW_NAME FROM ALL_VIEWS WHERE OWNER = :o ORDER BY VIEW_NAME`, { o }, 2_000);
      return r.rows.map(([s, n]) => ({ schema: String(s), name: String(n) }));
    },
    describe,
    async columns(schema, table) {
      return (await describe(schema, table)).columns;
    },
    async ddl(schema, table) {
      // DM8 兼容 DBMS_METADATA 包；若集成实测不可用，改 catalog 拼装（同 pg.js ddl 实现）
      const r = await runRows(
        `SELECT DBMS_METADATA.GET_DDL('TABLE', :t, :s) FROM DUAL`, { t: table, s: schema }, 1);
      return String(r.rows[0]?.[0] ?? '');
    },
    async explain(sql) {
      return await withConn(async (conn) => {
        await conn.execute(`EXPLAIN ${sql}`);
        const text = conn.lastExecInfo?.explain ?? '';
        if (text === '') throw new Error('达梦未返回执行计划（lastExecInfo.explain 为空）');
        return parseExplainPlan(text);
      });
    },
    async exec(sql) {
      return await withConn(async (conn) => {
        const res = await conn.execute(sql);
        return { affectedRows: res.rowsAffected ?? 0 };
      });
    },
    async close() {
      await pool.close();
    },
  };
}

module.exports = { createPool, parseUrl, parseExplainPlan };
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd ../momo-plugin && npx vitest run tests/db-pro/driver-dm.test.mjs`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git -C ../momo-plugin add plugins/db-pro/engine/drivers/dm.js tests/db-pro/driver-dm.test.mjs
git -C ../momo-plugin commit -m "feat(db-pro): 达梦驱动适配层（lastExecInfo.explain 特化解析）"
```

### Task 9: 引擎主体 engine.js（连接池 + 调度 + 校验接线）

**Files:**
- Create: `../momo-plugin/plugins/db-pro/engine/engine.js`
- Test: `../momo-plugin/tests/db-pro/engine.test.mjs`

**Interfaces:**
- Consumes: Task 3 `runServer/EngineError/CODES`、Task 4 `assertReadOnly`、Task 5-8 四驱动 `createPool` 契约
- Produces（Task 13 service 经 stdin 消费的方法面）:
  - `ping → {ready}`；`configure {connections:[{name,url,queryTimeoutMs}]} → {configured}`（diff：变更/移除的连接关池重建）；`connTest {name} → {ok}`；`query {connection, sql, maxRows}`（前置 assertReadOnly，拒绝码 `readonly_rejected`）；`meta.listSchemas {connection}`；`meta.listTables {connection, schema?}`；`meta.listViews {connection, schema?}`；`meta.describe {connection, schema, table}`；`meta.columns {connection, schema, table}`；`meta.ddl {connection, schema, table}`；`explain {connection, sql}`；`exec {connection, sql}`（仅 service 批准后调用）
  - `createDispatcher(loadDriver?, pools?)` 可注入工厂（单测用 fake 驱动）

- [ ] **Step 1: 写失败测试**

`../momo-plugin/tests/db-pro/engine.test.mjs`：

```js
// 引擎主体单测：fake 驱动注入——configure diff / 只读校验接线 / 未配置连接错误 / 未知方法
import { describe, it, expect } from 'vitest';
import engineMod from '../../plugins/db-pro/engine/engine.js';
const { createDispatcher } = engineMod;

function fakeDriver() {
  const closed = [];
  const pool = {
    dialect: 'mysql',
    ping: async () => undefined,
    query: async () => ({ columns: ['a'], rows: [[1]], total: 1, truncated: false }),
    listSchemas: async () => ['s1'],
    listTables: async () => [{ schema: 's1', name: 't1', type: 'table' }],
    listViews: async () => [],
    describe: async () => ({ columns: [], indexes: [], rowEstimate: 1 }),
    columns: async () => [],
    ddl: async () => 'CREATE TABLE t1 (a int)',
    explain: async () => ({ text: 'plan', operators: [], summary: '' }),
    exec: async () => ({ affectedRows: 1 }),
    close: async () => { closed.push(true); },
  };
  return { pool, closed };
}

const CFG = (url = 'mysql://u:p@h:3306/db') => [{ name: 'c1', url, queryTimeoutMs: 30000 }];

describe('createDispatcher', () => {
  it('configure 建池 + query 全链（只读校验通过）', async () => {
    const f = fakeDriver();
    const d = createDispatcher(() => () => ({ createPool: async () => f.pool }));
    const r = await d.dispatch('configure', { connections: CFG() });
    expect(r.configured).toBe(1);
    const q = await d.dispatch('query', { connection: 'c1', sql: 'SELECT 1', maxRows: 10 });
    expect(q.rows).toEqual([[1]]);
  });

  it('query 写语句被只读校验拒绝（readonly_rejected），不到驱动', async () => {
    const f = fakeDriver();
    const d = createDispatcher(() => () => ({ createPool: async () => f.pool }));
    await d.dispatch('configure', { connections: CFG() });
    await expect(d.dispatch('query', { connection: 'c1', sql: 'DELETE FROM t' }))
      .rejects.toMatchObject({ code: 'readonly_rejected' });
  });

  it('configure diff：URL 变更 → 旧池 close、新池建立', async () => {
    const f1 = fakeDriver();
    const f2 = fakeDriver();
    let which = 0;
    const d = createDispatcher(() => () => ({ createPool: async () => (which === 0 ? f1.pool : f2.pool) }));
    await d.dispatch('configure', { connections: CFG() });
    which = 1;
    await d.dispatch('configure', { connections: CFG('mysql://u:p@h:3306/db2') });
    expect(f1.closed).toHaveLength(1);
    const q = await d.dispatch('query', { connection: 'c1', sql: 'SELECT 1' });
    expect(q.rows).toEqual([[1]]);
  });

  it('未配置连接 → connection_failed；未知方法 → unknown_method', async () => {
    const d = createDispatcher(() => () => ({ createPool: async () => fakeDriver().pool }));
    await expect(d.dispatch('connTest', { name: 'nope' })).rejects.toMatchObject({ code: 'connection_failed' });
    await expect(d.dispatch('bogus', {})).rejects.toMatchObject({ code: 'unknown_method' });
  });

  it('exec 直通驱动（service 批准后路径，引擎不校验——信任边界在 service）', async () => {
    const f = fakeDriver();
    const d = createDispatcher(() => () => ({ createPool: async () => f.pool }));
    await d.dispatch('configure', { connections: CFG() });
    const r = await d.dispatch('exec', { connection: 'c1', sql: 'UPDATE t SET a=1' });
    expect(r.affectedRows).toBe(1);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd ../momo-plugin && npx vitest run tests/db-pro/engine.test.mjs`
Expected: FAIL。

- [ ] **Step 3: 实现 engine.js**

`../momo-plugin/plugins/db-pro/engine/engine.js`：

```js
'use strict';
// db-pro 引擎子进程主体（spec §4.4）：连接池 Map + 方法调度 + 只读校验接线。
// 协议：NDJSON JSON-RPC（protocol.js）；驱动懒加载（缺方言不拖垮其他连接）。
const { runServer, EngineError, CODES } = require('./protocol');
const { assertReadOnly } = require('./sql-validator');

const DIALECT_LOADERS = {
  mysql: () => require('./drivers/mysql'),
  postgres: () => require('./drivers/pg'),
  postgresql: () => require('./drivers/pg'),
  oracle: () => require('./drivers/oracle'),
  dm: () => require('./drivers/dm'),
  dameng: () => require('./drivers/dm'),
};

function createDispatcher(loadDriver = (d) => DIALECT_LOADERS[d](), pools = new Map()) {
  function mustPool(name) {
    const h = pools.get(name);
    if (!h) throw new EngineError(CODES.CONN, `未配置的连接 "${name}"——请在插件设置中配置后重试`);
    return h.pool;
  }

  async function applyConfigure(connections) {
    const next = new Map((connections ?? []).map((c) => [c.name, c]));
    // 关闭：不在新配置、或 url/timeout 变化的
    for (const [name, h] of pools) {
      const n = next.get(name);
      if (!n || n.url !== h.url || n.queryTimeoutMs !== h.queryTimeoutMs) {
        pools.delete(name);
        void h.pool.close().catch(() => undefined);
      }
    }
    // 新建
    for (const c of connections ?? []) {
      const cur = pools.get(c.name);
      if (cur && cur.url === c.url && cur.queryTimeoutMs === c.queryTimeoutMs) continue;
      const proto = new URL(c.url).protocol.replace(':', '');
      const loader = DIALECT_LOADERS[proto];
      if (!loader) throw new EngineError(CODES.CONN, `不支持的连接协议 "${proto}://"（支持 mysql/postgres/oracle/dm）`);
      const pool = await loadDriver(proto).createPool(c.url, { queryTimeoutMs: c.queryTimeoutMs });
      pools.set(c.name, { name: c.name, url: c.url, queryTimeoutMs: c.queryTimeoutMs, pool });
    }
  }

  async function dispatch(method, params) {
    switch (method) {
      case 'ping': return { ready: true };
      case 'configure':
        await applyConfigure(params.connections);
        return { configured: pools.size };
      case 'connTest':
        await mustPool(params.name).ping();
        return { ok: true };
      case 'query': {
        const check = assertReadOnly(params.sql);
        if (!check.ok) throw new EngineError(CODES.VALIDATION, check.reason);
        return await mustPool(params.connection).query(params.sql, params.maxRows ?? 200);
      }
      case 'meta.listSchemas': return { schemas: await mustPool(params.connection).listSchemas() };
      case 'meta.listTables': return { tables: await mustPool(params.connection).listTables(params.schema) };
      case 'meta.listViews': return { views: await mustPool(params.connection).listViews(params.schema) };
      case 'meta.describe': return await mustPool(params.connection).describe(params.schema, params.table);
      case 'meta.columns': return { columns: await mustPool(params.connection).columns(params.schema, params.table) };
      case 'meta.ddl': return { ddl: await mustPool(params.connection).ddl(params.schema, params.table) };
      case 'explain': return await mustPool(params.connection).explain(params.sql);
      // exec 仅由 service 在人工批准后调用（spec §6.2：引擎协议不暴露给 agent）
      case 'exec': return await mustPool(params.connection).exec(params.sql);
      default: throw new EngineError(CODES.UNKNOWN_METHOD, `未知方法: ${method}`);
    }
  }

  return { dispatch, pools, applyConfigure };
}

if (require.main === module) {
  const { dispatch, pools } = createDispatcher();
  process.on('SIGTERM', () => {
    void Promise.allSettled([...pools.values()].map((h) => h.pool.close())).then(() => process.exit(0));
  });
  runServer(dispatch);
}

module.exports = { createDispatcher };
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd ../momo-plugin && npx vitest run tests/db-pro/engine.test.mjs`
Expected: PASS（5 用例）。

- [ ] **Step 5: 提交**

```bash
git -C ../momo-plugin add plugins/db-pro/engine/engine.js tests/db-pro/engine.test.mjs
git -C ../momo-plugin commit -m "feat(db-pro): 引擎主体（连接池 diff 调度 + 只读校验接线）"
```

---

## Phase B — 宿主扩展（momo-studio 仓）

### Task 10: [momo-studio] PluginServiceCtx 注入 humanGate

**Files:**
- Modify: `electron/src/main/plugin/types.ts`（`PluginServiceCtx` 增加可选 `humanGate`；新增 `PluginHumanGate`/`HumanRequestRowLike` 接口）
- Create: `electron/src/main/plugin/human-gate.ts`
- Modify: `electron/src/main/plugin/service-manager.ts`（ctx 构造处注入，`doStartPluginService` 约 L133-152）
- Test: `electron/tests/plugin/human-gate.test.ts`

**Interfaces:**
- Produces（插件 service 侧消费面，Task 13/14 依赖）:
  - `ctx.humanGate?.create({ sessionId: string; taskId?: string | null; title: string; prompt?: string; payloadJson?: string }) → Promise<string>`（返回 human_requests 行 id）
  - `ctx.humanGate?.status(id) → Promise<{ id; status: 'pending'|'answered'|'expired'|'cancelled'|'superseded'; answerJson: string | null; payloadJson: string | null } | null>`
  - 落库 kind 恒 `tool_gate`；timeoutPolicy 缺省 `keep_waiting`（人工批准无超时，spec §8）

- [ ] **Step 1: 定位 PluginServiceCtx 定义**

Run: `grep -n "PluginServiceCtx" electron/src/main/plugin/types.ts`
（若不在 types.ts，按 grep 结果定位实际文件，后续修改同文件。）

- [ ] **Step 2: types.ts 增加接口**

在 `PluginServiceCtx` 接口体内（`oauth` 字段之后）追加：

```ts
  /** db-pro 先行（spec 2026-11-17 §7-1）：人工请求门——插件不直接 import 内部
   *  模块，主进程能力经 ctx 注入（execSandboxed 同款先例）。注入体见 human-gate.ts */
  humanGate?: PluginHumanGate;
```

在同文件新增（导出）：

```ts
/** 插件面的人工请求行投影（避免整行 repo 类型跨域泄漏；payloadJson 供两段式取回执行参数） */
export interface HumanRequestRowLike {
  id: string;
  status: 'pending' | 'answered' | 'expired' | 'cancelled' | 'superseded';
  answerJson: string | null;
  payloadJson: string | null;
}

/** 人工请求门 ctx 面（spec 2026-11-17 §7-1）：create 落 kind=tool_gate 行，
 *  timeoutPolicy 缺省 keep_waiting（人工批准无超时，sweeper 只回收带 deadline 的行） */
export interface PluginHumanGate {
  create(input: {
    sessionId: string;
    taskId?: string | null;
    title: string;
    prompt?: string;
    payloadJson?: string;
  }): Promise<string>;
  status(id: string): Promise<HumanRequestRowLike | null>;
}
```

- [ ] **Step 3: 写 human-gate.ts**

`electron/src/main/plugin/human-gate.ts`：

```ts
// electron/src/main/plugin/human-gate.ts
//
// 插件 service ctx 的 human-gate 注入体（spec 2026-11-17 §7-1）。
// 沿 execSandboxed 注入先例：插件不直接 import 内部模块，主进程能力经 ctx 下发。
import {
  insertHumanRequest,
  getHumanRequest,
} from '../storage/tasks/human-requests-repo';
import type { PluginHumanGate, HumanRequestRowLike } from './types';

/** buildPluginHumanGateApi：无状态闭包——直接映射 human-requests-repo 读写面 */
export function buildPluginHumanGateApi(): PluginHumanGate {
  return {
    create: async (input) => {
      if (typeof input.sessionId !== 'string' || input.sessionId === '') {
        throw new Error('humanGate.create 缺少 sessionId（工具层须注入会话 id）');
      }
      const row = insertHumanRequest({
        sessionId: input.sessionId,
        taskId: input.taskId ?? null,
        kind: 'tool_gate',
        title: input.title,
        prompt: input.prompt ?? '',
        payloadJson: input.payloadJson ?? null,
        // timeoutPolicy 缺省 keep_waiting——人工批准无超时（spec §8）
      });
      return row.id;
    },
    status: async (id): Promise<HumanRequestRowLike | null> => {
      const row = getHumanRequest(id);
      if (!row) return null;
      return { id: row.id, status: row.status, answerJson: row.answerJson, payloadJson: row.payloadJson };
    },
  };
}
```

- [ ] **Step 4: service-manager.ts 注入**

`electron/src/main/plugin/service-manager.ts`：顶部 import 区追加：

```ts
import { buildPluginHumanGateApi } from './human-gate';
```

`doStartPluginService` 的 ctx 构造（约 L133-152）在 `oauth: buildPluginOAuthApi(),` 之后追加一行：

```ts
      humanGate: buildPluginHumanGateApi(),
```

- [ ] **Step 5: 写测试（真库——沿 tool-gate-persistence.test.ts harness）**

`electron/tests/plugin/human-gate.test.ts`：

```ts
// humanGate 注入体契约锁（spec 2026-11-17 §7-1）：
//   1) create：落 kind=tool_gate 行（sessionId/taskId/payload 透传、keep_waiting）
//   2) status：投影字段（含 payloadJson）| 未知 id → null
//   3) create 缺 sessionId → 拒（Review Focus #4 守卫）
// DB 初始化照抄 electron/tests/task/tool-gate-persistence.test.ts 的 beforeAll 写法。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
// ↓↓↓ 照抄 tool-gate-persistence.test.ts L18-49 中与本测试相关的 import 与 DB 初始化
import { buildPluginHumanGateApi } from '../../src/main/plugin/human-gate';
import { listPendingBySession } from '../../src/main/storage/tasks/human-requests-repo';
import { runMigrations, closeDb } from '../../src/main/storage/db';

beforeAll(() => {
  // 与 tool-gate-persistence.test.ts 同款（tmp 目录 + runMigrations）
});
afterAll(() => { void closeDb(); });

describe('buildPluginHumanGateApi', () => {
  const gate = buildPluginHumanGateApi();

  it('create 落 kind=tool_gate 行 + payload 透传 + keep_waiting', async () => {
    const payloadJson = JSON.stringify({ db: { connection: 'conn1', sql: 'UPDATE t SET a=1', opClass: 'DML' } });
    const id = await gate.create({ sessionId: 'sess-1', taskId: 'task-9', title: '数据库写请求（DML）', payloadJson });
    const rows = listPendingBySession('sess-1');
    const row = rows.find((r) => r.id === id);
    expect(row).toBeDefined();
    expect(row?.kind).toBe('tool_gate');
    expect(row?.status).toBe('pending');
    expect(row?.taskId).toBe('task-9');
    expect(row?.timeoutPolicy).toBe('keep_waiting');
    expect(row?.payloadJson).toBe(payloadJson);
  });

  it('status 返回投影（含 payloadJson）；未知 id → null', async () => {
    const payloadJson = '{"db":{"connection":"c","sql":"s","opClass":"DDL"}}';
    const id = await gate.create({ sessionId: 'sess-2', title: 't', payloadJson });
    const s = await gate.status(id);
    expect(s).toMatchObject({ id, status: 'pending', answerJson: null, payloadJson });
    expect(await gate.status('nonexistent')).toBeNull();
  });

  it('create 缺 sessionId 拒绝（防 NOT NULL 崩 + 面板断链）', async () => {
    await expect(gate.create({ sessionId: '', title: 't' })).rejects.toThrow(/sessionId/);
  });
});
```

（beforeAll 具体写法以 tool-gate-persistence.test.ts 为准照抄——该文件已验证 human_requests 真库测试可行。）

- [ ] **Step 6: 跑测试确认通过**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/plugin/human-gate.test.ts --pool=forks`
Expected: PASS（3 用例）。

- [ ] **Step 7: 提交**

```bash
git add electron/src/main/plugin/types.ts electron/src/main/plugin/human-gate.ts electron/src/main/plugin/service-manager.ts electron/tests/plugin/human-gate.test.ts
git commit -m "feat(plugin): PluginServiceCtx 注入 humanGate（人工请求门 ctx 扩展，db-pro 先行）"
```

### Task 11: [momo-studio] handleToolGateAnswer db 载荷旁路

**Files:**
- Modify: `electron/src/main/sandbox/write-blocked-emit.ts`（`handleToolGateAnswer`，约 L212 起）
- Test: `electron/tests/task/tool-gate-db-payload.test.ts`

**Interfaces:**
- Consumes: human_requests 行的 `payloadJson` 为 `{db:{connection,sql,opClass}}` 形态（Task 14 写入）时，**不走** `grantWriteDirs`（沙箱文件授予语义不适用 db 写，spec §7-3）
- Produces: db 形态 approve/deny 的语义消费者是插件 service 的 status 轮询（Task 14）——本任务只是旁路（不授目录、不崩、不留孤儿授予）

- [ ] **Step 1: 读现状函数**

Run: `sed -n '200,240p' electron/src/main/sandbox/write-blocked-emit.ts`
（确认 `handleToolGateAnswer(requestId, answer)` 的现状实现与行号，以下 diff 按实际微调。）

- [ ] **Step 2: 写失败测试**

`electron/tests/task/tool-gate-db-payload.test.ts`：

```ts
// db 形态 tool_gate 答复旁路（spec 2026-11-17 §7-3）：
//   1) db payload + approve → 不产生任何会话写授权（grantWriteDirs 不被调用）
//   2) 对照组：沙箱形态 payload + approve → 照旧授予（既有行为不受影响）
// DB 初始化照抄 electron/tests/task/tool-gate-persistence.test.ts 的 beforeAll 写法。
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
// ↓↓↓ 照抄 tool-gate-persistence.test.ts L18-49 相关 import 与 DB 初始化
import { handleToolGateAnswer } from '../../src/main/sandbox/write-blocked-emit';
import { insertHumanRequest } from '../../src/main/storage/tasks/human-requests-repo';
import { getGrantedDirs, __clearWriteGrantsForTest } from '../../src/main/sandbox/write-grant';

beforeAll(() => { /* 照抄 tool-gate-persistence.test.ts 的 DB 初始化 */ });
afterAll(() => { void closeDb(); });

describe('handleToolGateAnswer db 载荷旁路', () => {
  it('db payload + approve：不产生写授权、不抛错', () => {
    __clearWriteGrantsForTest('session', 'sess-db');
    const row = insertHumanRequest({
      sessionId: 'sess-db',
      kind: 'tool_gate',
      title: '数据库写请求（DML）',
      payloadJson: JSON.stringify({ db: { connection: 'conn1', sql: 'UPDATE t SET a=1', opClass: 'DML' } }),
    });
    expect(() => handleToolGateAnswer(row.id, { decision: 'approve' })).not.toThrow();
    expect(getGrantedDirs('session', 'sess-db')).toHaveLength(0);
  });

  it('对照组：沙箱形态 payload + approve → 照旧授予', () => {
    __clearWriteGrantsForTest('session', 'sess-fs');
    const row = insertHumanRequest({
      sessionId: 'sess-fs',
      kind: 'tool_gate',
      title: '写入请求',
      payloadJson: JSON.stringify({ toolName: 'bash', command: 'echo hi', dirs: ['/tmp/x'] }),
    });
    handleToolGateAnswer(row.id, { decision: 'approve' });
    expect(getGrantedDirs('session', 'sess-fs')).toContain('/tmp/x');
  });
});
```

（payload 字段名以现状 `parseGate`/`handleToolGateAnswer` 实际消费的形态为准——Step 1 读码后对齐对照组字段；`getGrantedDirs` 签名照 tool-gate-persistence.test.ts L48 用法。）

- [ ] **Step 3: 跑测试确认失败**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/task/tool-gate-db-payload.test.ts --pool=forks`
Expected: 用例 1 FAIL（现状实现对 db payload 解析 dirs 会崩或授予空/异常）。

- [ ] **Step 4: 实现旁路**

`electron/src/main/sandbox/write-blocked-emit.ts` —— `handleToolGateAnswer` 函数体开头（取到 row 之后、解析 gate/dirs 之前）插入：

```ts
  // db-pro（spec 2026-11-17 §7-3）：db 形态载荷（{db:{connection,sql,opClass}}）
  // 无 dirs 可授——approve/deny 语义由插件 service 轮询 status 消费，
  // 沙箱授予链路直接旁路（不授予、不广播拒绝——答复本身已落库）。
  if (isDbGatePayload(row.payloadJson)) return;
```

同文件新增私有 helper（放在 parseGate 附近）：

```ts
/** db-pro 载荷判定：payloadJson 解析为对象且含 db 键 */
function isDbGatePayload(payloadJson: string | null): boolean {
  if (!payloadJson) return false;
  try {
    const parsed = JSON.parse(payloadJson) as { db?: unknown };
    return typeof parsed.db === 'object' && parsed.db !== null;
  } catch {
    return false;
  }
}
```

- [ ] **Step 5: 跑测试确认通过 + 邻接回归**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/task/tool-gate-db-payload.test.ts tests/task/tool-gate-persistence.test.ts --pool=forks`
Expected: 全 PASS（新 2 例 + 既有 persistence 套件不回归）。

- [ ] **Step 6: 提交**

```bash
git add electron/src/main/sandbox/write-blocked-emit.ts electron/tests/task/tool-gate-db-payload.test.ts
git commit -m "feat(task): tool_gate 答复路由旁路 db 形态载荷（db-pro 写批准消费位）"
```

### Task 12: [momo-studio] ToolGateBody db 载荷渲染分支

**Files:**
- Modify: `renderer/src/components/im/HumanRequestPanel.tsx`（`ToolGateBody` + 新增 `parseDbGate`）
- Test: `renderer/src/components/im/HumanRequestPanel.test.tsx`（追加用例）

**Interfaces:**
- Consumes: 行 `payloadJson` 为 `{db:{connection,sql,opClass}}`（Task 14 写入形态）
- Produces: db 卡片 = 描述行（`{opClass} 写请求 · 连接 {connection}`）+ SQL 块（复用 `CmdBlock`）+ **两键**（允许本次 / 拒绝——**不渲染「允许本会话」**，spec §5.2②）

- [ ] **Step 1: 写失败测试（追加到既有测试文件）**

`renderer/src/components/im/HumanRequestPanel.test.tsx` 末尾追加：

```tsx
// db-pro db 载荷渲染（spec 2026-11-17 §7-2）
describe('HumanRequestPanel · db 形态 tool_gate', () => {
  const DB_GATE_JSON = JSON.stringify({
    db: { connection: 'conn1', sql: 'UPDATE orders SET status = 1 WHERE id = 42', opClass: 'DML' },
  });

  it('渲染连接名与 SQL，无「允许本会话」按钮', () => {
    const row = makeRow({ kind: 'tool_gate', payloadJson: DB_GATE_JSON, sessionId: 'sess-db' });
    // makeRow/渲染辅助照本文件既有 tool_gate 用例（TOOL_GATE_JSON 一组）同款写法
    const props = buildPanelProps([row]); // ← 用既有用例的 props 构造方式（mockApi + listMock 返回该行）
    render(<HumanRequestPanel sessionId="sess-db" {...props} />);
    expect(screen.getByText(/conn1/)).toBeTruthy();
    expect(screen.getByText(/UPDATE orders SET status = 1/)).toBeTruthy();
    expect(screen.queryByText('允许本会话')).toBeNull();
    expect(screen.getByText('允许本次')).toBeTruthy();
    expect(screen.getByText('拒绝')).toBeTruthy();
  });

  it('批准 → human.answer({decision:"approve"})（无 scope 注记）', () => {
    const row = makeRow({ kind: 'tool_gate', payloadJson: DB_GATE_JSON, sessionId: 'sess-db' });
    render(<HumanRequestPanel sessionId="sess-db" /* props 同上 */ />);
    fireEvent.click(screen.getByText('允许本次'));
    expect(answerMock).toHaveBeenCalledWith(row.id, { decision: 'approve' });
  });
});
```

（`makeRow` / `buildPanelProps` / mock 断言风格**照本文件既有 tool_gate 用例**（L75 `TOOL_GATE_JSON` 一组）照抄调整——字段名与 store 接线以既有用例为准。）

- [ ] **Step 2: 跑测试确认失败**

Run: `cd renderer && npx pnpm@9.0.0 vitest run src/components/im/HumanRequestPanel.test.tsx`
Expected: 新用例 FAIL（现状 ToolGateBody 对 db payload 显示 fallback prompt 行 + 三个按钮）。

- [ ] **Step 3: 实现渲染分支**

`renderer/src/components/im/HumanRequestPanel.tsx`：

新增 helper（`parseToolGate` 旁）：

```tsx
/** db-pro 载荷（spec 2026-11-17 §7-2）：{db:{connection,sql,opClass}} */
function parseDbGate(row: HumanRequestRow): { connection: string; sql: string; opClass: string } | null {
  if (!row.payloadJson) return null;
  try {
    const p = JSON.parse(row.payloadJson) as { db?: { connection?: unknown; sql?: unknown; opClass?: unknown } };
    const d = p?.db;
    if (d && typeof d.connection === 'string' && typeof d.sql === 'string' && typeof d.opClass === 'string') {
      return { connection: d.connection, sql: d.sql, opClass: d.opClass };
    }
  } catch {
    // 非 JSON / 非 db 形态 → 走既有沙箱载荷渲染
  }
  return null;
}
```

`ToolGateBody` 内修改（`const gate = parseToolGate(row);` 之后加 `const db = parseDbGate(row);`）：

```tsx
      {/* 描述行（未决态）/ 超时策略行（预警态） */}
      <div className="text-[11px] leading-4 text-tertiary">
        {warn
          ? TIMEOUT_POLICY_HINT[row.timeoutPolicy]
          : db !== null
            ? `${db.opClass} 写请求 · 连接 ${db.connection}`
            : gate !== null
              ? `${gate.toolName} 工具请求写入 ${gate.dirs.length} 个目录。`
              : row.prompt}
      </div>
      {db !== null && <CmdBlock command={`$ ${db.sql}`} />}
      {db === null && gate !== null && <CmdBlock command={`$ ${gate.command}`} />}
      {db === null && gate !== null && <Chips items={gate.dirs} />}
```

按钮区：把「允许本会话」按钮包进 `{db === null && (…)}` 条件（其余两键不变）。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd renderer && npx pnpm@9.0.0 vitest run src/components/im/HumanRequestPanel.test.tsx`
Expected: 全 PASS（既有用例不回归 + 新 2 例绿）。

- [ ] **Step 5: 提交**

```bash
git add renderer/src/components/im/HumanRequestPanel.tsx renderer/src/components/im/HumanRequestPanel.test.tsx
git commit -m "feat(ui): 人工请求面板 tool_gate 支持 db 载荷渲染（SQL 卡片 + 无会话级豁免）"
```

---

## Phase C — service 与工具面（momo-plugin 仓）

### Task 13: service 引擎进程管理 + 配置解析 + 读代理

**Files:**
- Create: `../momo-plugin/plugins/db-pro/service/config-connections.js`
- Modify: `../momo-plugin/plugins/db-pro/service/index.js`（替换 Task 2 桩）
- Test: `../momo-plugin/tests/db-pro/config-connections.test.mjs`

**Interfaces:**
- Consumes: Task 9 引擎方法面（stdin 消费）；宿主 `PluginServiceCtx`（getConfig/getDataDir/logger/**humanGate**——Task 10）；Task 1 `spike/RESULT.md` 的阶梯命中级别
- Produces（Task 15 tools 经 `callService` 消费）: `handle(method, params)` 方法面 = `listConnections` / `query` / `meta.listSchemas` / `meta.listTables` / `meta.listViews` / `meta.describe` / `meta.columns` / `meta.ddl` / `explain` / `write`（Task 14）/ `writeStatus`（Task 14）；`connectionsFromConfig(config)` / `diffConnections(prev, next)` 纯函数导出

- [ ] **Step 1: 写失败测试（纯函数）**

`../momo-plugin/tests/db-pro/config-connections.test.mjs`：

```js
import { describe, it, expect } from 'vitest';
import m from '../../plugins/db-pro/service/config-connections.js';
const { connectionsFromConfig, diffConnections } = m;

describe('connectionsFromConfig（槽位制，spec §4.3）', () => {
  it('空配置 → 空连接列表', () => {
    expect(connectionsFromConfig({})).toEqual([]);
  });
  it('槽位缺省名 conn<n>；空槽跳过；timeout 归一', () => {
    const conns = connectionsFromConfig({
      conn2_url: 'mysql://u:p@h/db2',
      conn3_url: 'dm://SYSDBA:SYSDBA@h:5236',
      conn3_name: 'prod_dm',
      query_timeout_ms: 5000,
    });
    expect(conns).toEqual([
      { name: 'conn2', url: 'mysql://u:p@h/db2', queryTimeoutMs: 5000 },
      { name: 'prod_dm', url: 'dm://SYSDBA:SYSDBA@h:5236', queryTimeoutMs: 5000 },
    ]);
  });
  it('连接名重复拒绝（人话错误）', () => {
    expect(() => connectionsFromConfig({
      conn1_url: 'mysql://u:p@h/a', conn1_name: 'dup',
      conn2_url: 'mysql://u:p@h/b', conn2_name: 'dup',
    })).toThrow(/重复/);
  });
  it('URL 非字符串/空白按空槽处理', () => {
    expect(connectionsFromConfig({ conn1_url: '   ' })).toEqual([]);
  });
});

describe('diffConnections', () => {
  const A = [{ name: 'a', url: 'mysql://u:p@h/d', queryTimeoutMs: 30000 }];
  it('相同 → false', () => {
    expect(diffConnections(A, [{ name: 'a', url: 'mysql://u:p@h/d', queryTimeoutMs: 30000 }])).toBe(false);
  });
  it('URL 变化 / 增删连接 → true', () => {
    expect(diffConnections(A, [{ name: 'a', url: 'mysql://u:p@h/d2', queryTimeoutMs: 30000 }])).toBe(true);
    expect(diffConnections(A, [])).toBe(true);
    expect(diffConnections([], A)).toBe(true);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd ../momo-plugin && npx vitest run tests/db-pro/config-connections.test.mjs`
Expected: FAIL。

- [ ] **Step 3: 实现 config-connections.js**

`../momo-plugin/plugins/db-pro/service/config-connections.js`：

```js
'use strict';
// 配置 → 连接定义（spec §4.3 槽位制：conn1..conn6）+ diff 判定（顺序不敏感）。
const SLOT_COUNT = 6;

function connectionsFromConfig(config) {
  const conns = [];
  const seen = new Set();
  for (let i = 1; i <= SLOT_COUNT; i++) {
    const urlRaw = config[`conn${i}_url`];
    const url = typeof urlRaw === 'string' ? urlRaw.trim() : '';
    if (url === '') continue;
    const nameRaw = config[`conn${i}_name`];
    const name = typeof nameRaw === 'string' && nameRaw.trim() !== '' ? nameRaw.trim() : `conn${i}`;
    if (seen.has(name)) throw new Error(`连接名重复: "${name}"（conn${i}）——请为每个槽位设置唯一 name`);
    seen.add(name);
    conns.push({ name, url, queryTimeoutMs: Number(config.query_timeout_ms) || 30_000 });
  }
  return conns;
}

/** 有变化返回 true（按名比对 url/timeout；数量不等即变） */
function diffConnections(prev, next) {
  if (prev.length !== next.length) return true;
  const byName = new Map(prev.map((c) => [c.name, c]));
  for (const n of next) {
    const p = byName.get(n.name);
    if (!p || p.url !== n.url || p.queryTimeoutMs !== n.queryTimeoutMs) return true;
  }
  return false;
}

module.exports = { connectionsFromConfig, diffConnections, SLOT_COUNT };
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd ../momo-plugin && npx vitest run tests/db-pro/config-connections.test.mjs`
Expected: PASS。

- [ ] **Step 5: 实现 service/index.js（替换桩；write/writeStatus 在 Task 14 接入）**

`../momo-plugin/plugins/db-pro/service/index.js` 全量替换：

```js
'use strict';
// db-pro service（主进程常驻，spec §4.2）：引擎子进程生命周期 / 配置解析与
// 每次 diff / 读代理 / 写两段式（write-state.js）。Runtime 阶梯按 spike/RESULT.md。
const { spawn } = require('node:child_process');
const path = require('node:path');
const { connectionsFromConfig, diffConnections } = require('./config-connections');
const { createWriteState } = require('./write-state');

const ENGINE_BOOT_TIMEOUT_MS = 8_000;
/** 退避序列（spec §8：1s / 5s / 30s 封顶；成功后归零） */
const BACKOFF_STEPS_MS = [1_000, 5_000, 30_000];

const READ_METHODS = new Set([
  'query', 'meta.listSchemas', 'meta.listTables', 'meta.listViews',
  'meta.describe', 'meta.columns', 'meta.ddl', 'explain',
]);

function createService(ctx) {
  const engineEntry = path.join(__dirname, '..', 'engine', 'engine.js');
  let child = null;
  let nextId = 1;
  let stopping = false;
  let backoffIdx = -1; // -1 = 未在退避
  let restartTimer = null;
  let lastConnections = [];
  const pending = new Map(); // rpc id → {resolve, reject, timer}

  const writeState = createWriteState({
    humanGate: () => {
      if (!ctx.humanGate) throw new Error('宿主未注入 humanGate（需包含 Task 10 的 momo-studio 版本）');
      return ctx.humanGate;
    },
    execSql: (connection, sql) => rpc('exec', { connection, sql }),
    dataDir: ctx.getDataDir(),
    log: (msg, meta) => ctx.logger.warn(msg, meta),
  });

  // ── 引擎进程管理 ─────────────────────────────────────────────
  function spawnEngine() {
    // Runtime 阶梯（spec §3.2/D4）：L1 = ELECTRON_RUN_AS_NODE + legacy provider。
    // ← 若 spike/RESULT.md 判定 L1 不命中：按其结论改为系统 node 探测或 vendor
    //   node 路径（三选一，实现只改这两行 + env）。
    const command = process.execPath;
    const args = ['--openssl-legacy-provider', engineEntry];
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', MOMO_DBPRO_ENGINE: '1' };
    child = spawn(command, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = '';
    child.stdout.setEncoding('utf-8');
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        if (line.trim() === '') continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        const p = pending.get(msg.id);
        if (!p) continue;
        pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) p.reject(Object.assign(new Error(msg.error.message), { code: msg.error.code }));
        else p.resolve(msg.result);
      }
    });
    child.stderr.setEncoding('utf-8');
    child.stderr.on('data', (chunk) => ctx.logger.info(`db-pro 引擎 stderr: ${chunk.trim().slice(0, 400)}`));
    child.on('error', (err) => onEngineExit(`spawn 失败: ${err.message}`));
    child.on('exit', (code) => onEngineExit(`退出 code=${code}`));
  }

  function onEngineExit(reason) {
    if (stopping || !child) return;
    child = null;
    for (const [, p] of pending) {
      clearTimeout(p.timer);
      p.reject(new Error(`db-pro 引擎进程已退出（${reason}）——自动重启中，请稍后重试`));
    }
    pending.clear();
    scheduleRestart();
  }

  function scheduleRestart() {
    backoffIdx = Math.min(backoffIdx + 1, BACKOFF_STEPS_MS.length - 1);
    const delay = BACKOFF_STEPS_MS[Math.max(backoffIdx, 0)];
    ctx.logger.warn(`db-pro 引擎异常退出，${delay}ms 后重启（第 ${backoffIdx + 1} 次）`);
    restartTimer = setTimeout(() => void bootEngine().catch(scheduleRestart), delay);
  }

  async function bootEngine() {
    clearTimeout(restartTimer);
    spawnEngine();
    await rpc('ping', {}, ENGINE_BOOT_TIMEOUT_MS);
    if (lastConnections.length > 0) {
      await rpc('configure', { connections: lastConnections }, ENGINE_BOOT_TIMEOUT_MS);
    }
    backoffIdx = -1; // 成功后退避归零
  }

  function rpc(method, params, timeoutMs = 30_000) {
    if (!child || child.killed) {
      return Promise.reject(new Error('db-pro 引擎未运行（重启中，请稍后重试）'));
    }
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(Object.assign(new Error(`引擎请求超时: ${method} (${timeoutMs / 1000}s)——可用 WHERE/LIMIT 缩小查询`), { code: 'query_timeout' }));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }

  // ── 配置 diff（每次调用兜底比对，spec §5.3）─────────────────
  async function ensureConfig() {
    const conns = connectionsFromConfig(ctx.getConfig());
    if (diffConnections(lastConnections, conns)) {
      lastConnections = conns;
      await rpc('configure', { connections: conns }, ENGINE_BOOT_TIMEOUT_MS);
    }
  }

  function defaultConnection() {
    const cfg = ctx.getConfig();
    const explicit = typeof cfg.default_connection === 'string' && cfg.default_connection.trim() !== ''
      ? cfg.default_connection.trim() : '';
    if (explicit) return explicit;
    return lastConnections[0]?.name ?? '';
  }

  function dialectOf(url) {
    return new URL(url).protocol.replace(':', '');
  }

  async function handle(method, params) {
    if (method === 'write') return writeState.request(params);
    if (method === 'writeStatus') return writeState.status(params);
    if (method === 'listConnections') {
      if (child) await ensureConfig();
      return { connections: lastConnections.map((c) => ({ name: c.name, dialect: dialectOf(c.url) })) };
    }
    if (READ_METHODS.has(method)) {
      if (!child) throw new Error('db-pro 引擎未就绪（启动中/重启中，请稍后重试）');
      await ensureConfig();
      const p = { ...params };
      if (!p.connection) p.connection = defaultConnection();
      if (method === 'query') {
        p.maxRows = p.maxRows ?? Number(ctx.getConfig().readonly_max_rows) || 200;
      }
      return await rpc(method, p);
    }
    throw new Error(`未知 service 方法: ${method}`);
  }

  return {
    async start() {
      try {
        lastConnections = connectionsFromConfig(ctx.getConfig());
      } catch (err) {
        ctx.logger.warn('db-pro 配置解析失败（连接暂不可用，修配置后自动生效）', { error: err.message });
        lastConnections = [];
      }
      try {
        await bootEngine();
      } catch (err) {
        ctx.logger.warn('db-pro 引擎首启失败（退避重试中）', { error: err.message });
        scheduleRestart();
      }
    },
    async stop() {
      stopping = true;
      clearTimeout(restartTimer);
      if (child) { child.kill('SIGTERM'); child = null; }
      for (const [, p] of pending) {
        clearTimeout(p.timer);
        p.reject(new Error('插件已停止'));
      }
      pending.clear();
    },
    handle,
  };
}

module.exports = { createService };
```

注意：本步骤会临时引用 `./write-state`（Task 14 才创建）——**先创建 Task 14 Step 3 的 write-state.js 再跑本任务的验证**；或本步骤先注释掉 `createWriteState` 两行、Task 14 恢复（二选一，推荐前者：两任务连续执行）。

- [ ] **Step 6: 验证（连带 Task 14 的 write-state）**

Run: `cd ../momo-plugin && npx vitest run tests/db-pro/`
Expected: 既有全部测试 PASS（service 无独立单测——进程管理由 Task 18 手验覆盖；纯函数已在本任务锁定）。

- [ ] **Step 7: 提交（与 Task 14 合并提交或分别提交均可——文件不重叠时分别提交）**

```bash
git -C ../momo-plugin add plugins/db-pro/service tests/db-pro/config-connections.test.mjs
git -C ../momo-plugin commit -m "feat(db-pro): service 引擎进程管理（阶梯 spawn/退避重启/config diff 读代理）"
```

### Task 14: service 写两段式状态机

**Files:**
- Create: `../momo-plugin/plugins/db-pro/service/write-state.js`
- Test: `../momo-plugin/tests/db-pro/write-state.test.mjs`

**Interfaces:**
- Consumes: Task 10 `ctx.humanGate`（create/status）；Task 4 `classifyWrite`；Task 13 `rpc('exec')`
- Produces（Task 15 工具面）:
  - `request({ connection, sql, sessionId, taskId }) → { requestId, status: 'pending' }`；缺 sessionId / opClass REJECT 直接抛错
  - `status({ requestId }) → { status: 'pending'|'denied'|'executed'|'not_found'|…, affectedRows?, note?, replayed? }`
  - 幂等执行：`write-log.jsonl`（dataDir）持久化 `{requestId, affectedRows, at}`；同一 requestId 至多执行一次（重启安全——Review Focus #3）

- [ ] **Step 1: 写失败测试（全转移覆盖）**

`../momo-plugin/tests/db-pro/write-state.test.mjs`：

```js
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import stateMod from '../../plugins/db-pro/service/write-state.js';
const { createWriteState } = stateMod;

function mkHarness({ answer, rows = {} } = {}) {
  const execSql = vi.fn(async () => ({ affectedRows: 3 }));
  const humanGate = {
    create: vi.fn(async () => 'req-1'),
    status: vi.fn(async (id) => rows[id] ?? null),
  };
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbpro-ws-'));
  const state = createWriteState({
    humanGate: () => humanGate,
    execSql,
    dataDir,
    log: () => undefined,
  });
  return { state, execSql, humanGate, dataDir };
}

describe('write.request', () => {
  it('合法 DML → humanGate.create 收到完整载荷，返回 pending', async () => {
    const h = mkHarness();
    const r = await h.state.request({ connection: 'conn1', sql: 'UPDATE t SET a=1', sessionId: 's1', taskId: 't1' });
    expect(r).toEqual({ requestId: 'req-1', status: 'pending' });
    expect(h.humanGate.create).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 's1',
      taskId: 't1',
      payloadJson: expect.stringContaining('"opClass":"DML"'),
    }));
  });
  it('缺 sessionId 拒绝（Review Focus #4）', async () => {
    const h = mkHarness();
    await expect(h.state.request({ connection: 'c', sql: 'DELETE FROM t', sessionId: '' }))
      .rejects.toThrow(/sessionId/);
  });
  it('只读语句 / 不支持首词 / 多语句拒绝', async () => {
    const h = mkHarness();
    await expect(h.state.request({ connection: 'c', sql: 'SELECT 1', sessionId: 's' })).rejects.toThrow(/拒绝/);
    await expect(h.state.request({ connection: 'c', sql: 'GRANT ALL', sessionId: 's' })).rejects.toThrow(/拒绝/);
    await expect(h.state.request({ connection: 'c', sql: 'DELETE FROM t; SELECT 1', sessionId: 's' })).rejects.toThrow(/拒绝/);
    expect(h.humanGate.create).not.toHaveBeenCalled();
  });
});

describe('write.status（两段式全转移）', () => {
  it('pending → 如实返回 pending（不执行）', async () => {
    const h = mkHarness();
    const r = await h.state.status({ requestId: 'r' });
    h.humanGate.status.mockResolvedValueOnce({ id: 'r', status: 'pending', answerJson: null, payloadJson: '{}' });
    // 直接构造 status 返回 pending 行
    const h2 = mkHarness();
    h2.humanGate.status.mockResolvedValueOnce({ id: 'r', status: 'pending', answerJson: null, payloadJson: '{"db":{"connection":"c","sql":"UPDATE t SET a=1","opClass":"DML"}}' });
    expect(await h2.state.status({ requestId: 'r' })).toEqual({ status: 'pending' });
    expect(h2.execSql).not.toHaveBeenCalled();
  });
  it('answered+deny → denied + 附言；不执行', async () => {
    const h = mkHarness();
    h.humanGate.status.mockResolvedValueOnce({
      id: 'r', status: 'answered',
      answerJson: JSON.stringify({ decision: 'deny', text: '危险操作' }),
      payloadJson: '{"db":{"connection":"c","sql":"UPDATE t SET a=1","opClass":"DML"}}',
    });
    expect(await h.state.status({ requestId: 'r' })).toEqual({ status: 'denied', note: '危险操作' });
    expect(h.execSql).not.toHaveBeenCalled();
  });
  it('answered+approve → 执行一次并返回 affectedRows；再次 status → replayed', async () => {
    const h = mkHarness();
    const row = {
      id: 'r', status: 'answered',
      answerJson: JSON.stringify({ decision: 'approve' }),
      payloadJson: '{"db":{"connection":"conn1","sql":"UPDATE t SET a=1","opClass":"DML"}}',
    };
    h.humanGate.status.mockResolvedValue(row);
    expect(await h.state.status({ requestId: 'r' })).toEqual({ status: 'executed', affectedRows: 3 });
    expect(h.execSql).toHaveBeenCalledWith('conn1', 'UPDATE t SET a=1');
    // 幂等：同 requestId 再查不重复执行
    expect(await h.state.status({ requestId: 'r' })).toEqual({ status: 'executed', affectedRows: 3, replayed: true });
    expect(h.execSql).toHaveBeenCalledTimes(1);
  });
  it('重启恢复：write-log.jsonl 已记录的 requestId 不再执行（Review Focus #3）', async () => {
    const h = mkHarness();
    // 预置历史执行记录（模拟上一次进程已执行、重启后重建 state）
    fs.appendFileSync(path.join(h.dataDir, 'write-log.jsonl'), JSON.stringify({ requestId: 'done-1', affectedRows: 7, at: 1 }) + '\n');
    const state2 = stateMod.createWriteState({
      humanGate: () => h.humanGate, execSql: h.execSql, dataDir: h.dataDir, log: () => undefined,
    });
    h.humanGate.status.mockResolvedValue({
      id: 'done-1', status: 'answered',
      answerJson: JSON.stringify({ decision: 'approve' }),
      payloadJson: '{"db":{"connection":"c","sql":"UPDATE t SET a=1","opClass":"DML"}}',
    });
    expect(await state2.status({ requestId: 'done-1' })).toEqual({ status: 'executed', affectedRows: 7, replayed: true });
    expect(h.execSql).not.toHaveBeenCalled();
  });
  it('not_found / 载荷损坏 → 人话状态', async () => {
    const h = mkHarness();
    h.humanGate.status.mockResolvedValueOnce(null);
    expect(await h.state.status({ requestId: 'gone' })).toEqual({ status: 'not_found' });
    h.humanGate.status.mockResolvedValueOnce({ id: 'bad', status: 'answered', answerJson: JSON.stringify({ decision: 'approve' }), payloadJson: 'not-json' });
    expect(await h.state.status({ requestId: 'bad' })).toEqual({ status: 'invalid_payload' });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd ../momo-plugin && npx vitest run tests/db-pro/write-state.test.mjs`
Expected: FAIL。

- [ ] **Step 3: 实现 write-state.js**

`../momo-plugin/plugins/db-pro/service/write-state.js`：

```js
'use strict';
// 写两段式状态机（spec §5.2 / §4.2）：write → human_requests(tool_gate, db 载荷)
// → writeStatus 轮询 → approved 才执行。幂等保护（spec D7）：执行记录追加
// write-log.jsonl（进程重启后重建内存 Map）——同一 requestId 至多执行一次，
// 宁可 replayed 返回缓存结果，绝不重复执行写。
const fs = require('node:fs');
const path = require('node:path');
const { classifyWrite } = require('../engine/sql-validator');

const WRITE_LOG = 'write-log.jsonl';

function readLogEntries(dataDir) {
  try {
    return fs.readFileSync(path.join(dataDir, WRITE_LOG), 'utf-8')
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function createWriteState({ humanGate, execSql, dataDir, log }) {
  const writeLogPath = path.join(dataDir, WRITE_LOG);
  const executed = new Map(readLogEntries(dataDir).map((e) => [e.requestId, e]));

  function appendLog(entry) {
    try {
      fs.appendFileSync(writeLogPath, JSON.stringify(entry) + '\n');
    } catch (err) {
      log('db-pro 写日志追加失败（幂等保护降级为内存态）', { error: err.message });
    }
  }

  async function request(p) {
    const sql = typeof p.sql === 'string' ? p.sql : '';
    const connection = typeof p.connection === 'string' && p.connection !== '' ? p.connection : '';
    if (connection === '') throw new Error('write 须指定 connection');
    if (typeof p.sessionId !== 'string' || p.sessionId === '') {
      throw new Error('write 缺少 sessionId（工具层注入失败——面板将不可见）');
    }
    const { opClass, reason } = classifyWrite(sql);
    if (opClass === 'REJECT') throw new Error(`写请求被拒绝：${reason}`);
    const id = await humanGate().create({
      sessionId: p.sessionId,
      taskId: typeof p.taskId === 'string' ? p.taskId : null,
      title: `数据库写请求（${opClass}）`,
      payloadJson: JSON.stringify({ db: { connection, sql, opClass } }),
    });
    return { requestId: id, status: 'pending' };
  }

  async function status(p) {
    const requestId = String(p.requestId ?? '');
    if (requestId === '') throw new Error('writeStatus 缺少 requestId');
    const row = await humanGate().status(requestId);
    if (!row) return { status: 'not_found' };
    if (row.status !== 'answered') return { status: row.status };
    let answer = null;
    try { answer = row.answerJson ? JSON.parse(row.answerJson) : null; } catch { answer = null; }
    if (answer?.decision === 'deny') {
      return { status: 'denied', note: typeof answer.text === 'string' ? answer.text : '' };
    }
    if (answer?.decision !== 'approve') {
      return { status: 'unknown', note: `意外答复形态: ${row.answerJson ?? '（空）'}` };
    }
    if (executed.has(requestId)) {
      return { status: 'executed', affectedRows: executed.get(requestId).affectedRows, replayed: true };
    }
    let payload = null;
    try { payload = row.payloadJson ? JSON.parse(row.payloadJson).db : null; } catch { payload = null; }
    if (!payload || typeof payload.sql !== 'string' || typeof payload.connection !== 'string') {
      return { status: 'invalid_payload' };
    }
    const r = await execSql(payload.connection, payload.sql);
    const entry = { requestId, affectedRows: r.affectedRows, at: Date.now() };
    executed.set(requestId, entry);
    appendLog(entry);
    return { status: 'executed', affectedRows: r.affectedRows };
  }

  return { request, status };
}

module.exports = { createWriteState };
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd ../momo-plugin && npx vitest run tests/db-pro/write-state.test.mjs tests/db-pro/config-connections.test.mjs`
Expected: PASS（含 Task 13 纯函数——write-state 落地后 service/index.js 引用闭环）。

- [ ] **Step 5: 提交**

```bash
git -C ../momo-plugin add plugins/db-pro/service/write-state.js tests/db-pro/write-state.test.mjs
git -C ../momo-plugin commit -m "feat(db-pro): 写两段式状态机（human-gate + write-log 幂等保护）"
```

### Task 15: tools 工具面（11 工具 + 结果渲染）

**Files:**
- Create: `../momo-plugin/plugins/db-pro/engine/format.js`
- Modify: `../momo-plugin/plugins/db-pro/tools/index.js`（全量替换 Task 2 桩）
- Test: `../momo-plugin/tests/db-pro/tools.test.mjs`

**Interfaces:**
- Consumes: Task 13 service `handle` 方法面；宿主 `PluginToolCtx.callService(method, params, {timeoutMs})`；`ToolContext.streamSessionId/taskId`（execute 第三参——Review Focus #4 的注入点）
- Produces: 11 个工具 `plugin:db-pro/<短名>`（宿主加前缀）：`list_connections / list_schemas / list_tables / list_views / describe_table / list_columns / get_ddl / query / explain_query / write / write_status`；`formatTable(columns, rows, note)` 导出

- [ ] **Step 1: 写失败测试**

`../momo-plugin/tests/db-pro/tools.test.mjs`：

```js
import { describe, it, expect, vi } from 'vitest';
import fmt from '../../plugins/db-pro/engine/format.js';
const { formatTable } = fmt;
import toolsMod from '../../plugins/db-pro/tools/index.js';
const { createTools } = toolsMod;

describe('formatTable', () => {
  it('表头 + 行 + 注脚；长单元格截断', () => {
    const out = formatTable(['id', 'name'], [[1, 'x'.repeat(80)], [2, 'b']], '2 行');
    expect(out.split('\n')[0]).toContain('id');
    expect(out.split('\n')[1]).toContain('---');
    expect(out).not.toContain('x'.repeat(60)); // 48 字符截断
    expect(out.endsWith('2 行')).toBe(true);
  });
  it('空结果集容忍', () => {
    expect(formatTable(['a'], [], null)).toContain('a');
  });
});

describe('createTools', () => {
  function mk() {
    const callService = vi.fn(async (method) => {
      if (method === 'query') return { columns: ['a'], rows: [[1], [2]], total: 2, truncated: false };
      if (method === 'write') return { requestId: 'rq-1', status: 'pending' };
      if (method === 'writeStatus') return { status: 'executed', affectedRows: 3 };
      if (method === 'listConnections') return { connections: [{ name: 'conn1', dialect: 'mysql' }] };
      return { schemas: ['public'] };
    });
    const tools = createTools({ callService, logger: { info: () => {}, warn: () => {} } });
    const toolCtx = { streamSessionId: 'sess-x', taskId: 'task-y' };
    return { tools, callService, toolCtx };
  }

  it('11 个工具定义 + 短名合法（宿主 SHORT_NAME_RE）', () => {
    const { tools } = mk();
    const defs = tools.getDefs();
    expect(defs).toHaveLength(11);
    for (const d of defs) expect(d.name).toMatch(/^[a-z][a-z0-9_]*$/);
    expect(tools.getDefs().map((d) => d.name)).toEqual(expect.arrayContaining(['query', 'write', 'write_status']));
  });

  it('query：callService 注入 sessionId/taskId（Review Focus #4）+ 表格渲染', async () => {
    const { tools, callService, toolCtx } = mk();
    const out = await tools.execute('query', { sql: 'SELECT 1' }, toolCtx);
    expect(callService).toHaveBeenCalledWith('query',
      expect.objectContaining({ sql: 'SELECT 1', sessionId: 'sess-x', taskId: 'task-y' }),
      { timeoutMs: 60000 });
    expect(out).toContain('a');
    expect(out).toContain('1');
  });

  it('write：渲染 pending 指引（不谎称已执行）', async () => {
    const { tools, toolCtx } = mk();
    const out = await tools.execute('write', { connection: 'c', sql: 'UPDATE t SET a=1' }, toolCtx);
    expect(out).toContain('rq-1');
    expect(out).toContain('批准');
  });

  it('write_status：executed 渲染影响行数；未知工具拒绝', async () => {
    const { tools, toolCtx } = mk();
    const out = await tools.execute('write_status', { requestId: 'r' }, toolCtx);
    expect(out).toContain('3');
    await expect(tools.execute('bogus', {}, toolCtx)).rejects.toThrow(/未知工具/);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd ../momo-plugin && npx vitest run tests/db-pro/tools.test.mjs`
Expected: FAIL。

- [ ] **Step 3: 实现 format.js**

`../momo-plugin/plugins/db-pro/engine/format.js`：

```js
'use strict';
// LLM 友好固定宽文本表（tools 层 query 结果渲染）。单元格 48 字符截断。

const MAX_CELL = 48;

function formatTable(columns, rows, note) {
  const sample = rows.slice(0, 50);
  const widths = columns.map((c, i) => {
    const longest = sample.reduce((m, r) => Math.max(m, String(r[i] ?? 'NULL').length), 0);
    return Math.min(MAX_CELL, Math.max(String(c).length, longest));
  });
  const line = (cells) => cells.map((c, i) => String(c ?? 'NULL').slice(0, widths[i]).padEnd(widths[i])).join(' | ');
  const out = [line(columns), widths.map((w) => '-'.repeat(w)).join('-+-')];
  for (const r of rows) out.push(line(r).trimEnd());
  if (note) out.push(String(note));
  return out.join('\n');
}

module.exports = { formatTable };
```

- [ ] **Step 4: 实现 tools/index.js（全量替换）**

`../momo-plugin/plugins/db-pro/tools/index.js`：

```js
'use strict';
// db-pro 工具面（spec §4.1，11 工具）：薄壳——定义 + callService 透传 + 结果渲染。
// 行为边界写入工具描述（防 LLM 误用，momo-test-rules）；write 注入 sessionId/taskId
//（toolCtx.streamSessionId——人工请求面板可见性的锚，spec §7-1）。
const { formatTable } = require('../engine/format');

const CALL_TIMEOUT_MS = 60_000; // 桥上限（spec §2 事实 1）

const DEFS = [
  {
    name: 'list_connections',
    description: '列出已配置的数据库连接（名称 + 类型，不含凭据）。查询前先调用此工具确认可用连接。',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'list_schemas',
    description: '列出指定数据库的 schema 清单。',
    parameters: {
      type: 'object',
      properties: { connection: { type: 'string', description: '连接名（省略用缺省连接）' } },
      required: [],
    },
  },
  {
    name: 'list_tables',
    description: '列出表清单（含视图，type 区分）。',
    parameters: {
      type: 'object',
      properties: {
        connection: { type: 'string', description: '连接名（省略用缺省连接）' },
        schema: { type: 'string', description: 'schema（省略用连接缺省）' },
      },
      required: [],
    },
  },
  {
    name: 'list_views',
    description: '列出视图清单。',
    parameters: {
      type: 'object',
      properties: {
        connection: { type: 'string', description: '连接名（省略用缺省连接）' },
        schema: { type: 'string', description: 'schema（省略用连接缺省）' },
      },
      required: [],
    },
  },
  {
    name: 'describe_table',
    description: '表结构概要：列 / 索引 / 行数估算。',
    parameters: {
      type: 'object',
      properties: {
        connection: { type: 'string', description: '连接名（省略用缺省连接）' },
        schema: { type: 'string', description: 'schema（省略用连接缺省）' },
        table: { type: 'string', description: '表名' },
      },
      required: ['table'],
    },
  },
  {
    name: 'list_columns',
    description: '列明细（名称/类型/可空/默认值/注释）。',
    parameters: {
      type: 'object',
      properties: {
        connection: { type: 'string', description: '连接名（省略用缺省连接）' },
        schema: { type: 'string', description: 'schema（省略用连接缺省）' },
        table: { type: 'string', description: '表名' },
      },
      required: ['table'],
    },
  },
  {
    name: 'get_ddl',
    description: '建表 DDL（MySQL=SHOW CREATE；Oracle/达梦=DBMS_METADATA；PG=catalog 拼装）。',
    parameters: {
      type: 'object',
      properties: {
        connection: { type: 'string', description: '连接名（省略用缺省连接）' },
        schema: { type: 'string', description: 'schema（省略用连接缺省）' },
        table: { type: 'string', description: '表名' },
      },
      required: ['table'],
    },
  },
  {
    name: 'query',
    description: '只读 SQL 查询。仅允许 SELECT / SHOW / DESCRIBE / EXPLAIN / WITH(主语句为 SELECT)；禁止多语句与 FOR UPDATE。默认行数上限 200、超时 30s。写操作必须用 write 工具。',
    parameters: {
      type: 'object',
      properties: {
        connection: { type: 'string', description: '连接名（省略用缺省连接）' },
        sql: { type: 'string', description: '只读 SQL 语句（单条）' },
      },
      required: ['sql'],
    },
  },
  {
    name: 'explain_query',
    description: '查看执行计划（达梦经 lastExecInfo 特化解析）。',
    parameters: {
      type: 'object',
      properties: {
        connection: { type: 'string', description: '连接名（省略用缺省连接）' },
        sql: { type: 'string', description: '要分析的 SELECT 语句' },
      },
      required: ['sql'],
    },
  },
  {
    name: 'write',
    description: '发起写操作（INSERT/UPDATE/DELETE/MERGE=DDL 外的 DML；CREATE/DROP/ALTER/TRUNCATE=DDL）。不直接执行——创建人工批准请求，须提醒用户在「人工请求」面板批准/拒绝，随后用 write_status 查询结果。批准前不得声称已执行。',
    parameters: {
      type: 'object',
      properties: {
        connection: { type: 'string', description: '连接名（必填）' },
        sql: { type: 'string', description: '单条写语句' },
      },
      required: ['connection', 'sql'],
    },
  },
  {
    name: 'write_status',
    description: '查询写请求的人工批准状态。approved 时此刻执行并返回影响行数（同一请求只执行一次）；denied 返回拒绝理由；pending 表示仍在等待。',
    parameters: {
      type: 'object',
      properties: { requestId: { type: 'string', description: 'write 返回的请求 ID' } },
      required: ['requestId'],
    },
  },
];

const METHOD_OF = {
  list_connections: 'listConnections',
  list_schemas: 'meta.listSchemas',
  list_tables: 'meta.listTables',
  list_views: 'meta.listViews',
  describe_table: 'meta.describe',
  list_columns: 'meta.columns',
  get_ddl: 'meta.ddl',
  query: 'query',
  explain_query: 'explain',
  write: 'write',
  write_status: 'writeStatus',
};

function render(name, res) {
  if (name === 'query') {
    const note = res.truncated
      ? `…（共 ${res.total} 行，已截断至 ${res.rows.length} 行——可用 WHERE/LIMIT 缩小）`
      : `${res.rows.length} 行`;
    return formatTable(res.columns, res.rows, note);
  }
  if (name === 'explain_query') {
    return `${res.text}${res.summary ? `\n摘要: ${res.summary}` : ''}`;
  }
  if (name === 'write') {
    return `写请求已创建（requestId: ${res.requestId}），等待用户在「人工请求」面板批准。请提醒用户处理，随后调用 write_status 查询结果——批准前不会执行任何写操作。`;
  }
  if (name === 'write_status') {
    if (res.status === 'executed') {
      return `已执行${res.replayed ? '（此前已执行，本次返回缓存结果）'}，影响行数: ${res.affectedRows}`;
    }
    if (res.status === 'denied') {
      return `用户拒绝了该写请求。${res.note ? `附言：${res.note}` : ''}`;
    }
    if (res.status === 'pending') return '仍在等待用户批准。';
    return `请求状态: ${res.status}${res.note ? `（${res.note}）` : ''}`;
  }
  if (name === 'list_connections') {
    return res.connections.length === 0
      ? '（未配置连接——请在 设置 → 插件 → db-pro 配置连接串）'
      : res.connections.map((c) => `- ${c.name}（${c.dialect}）`).join('\n');
  }
  if (name === 'get_ddl') return res.ddl;
  return JSON.stringify(res, null, 2);
}

function createTools(ctx) {
  return {
    getDefs: () => DEFS.map((d) => ({ ...d })),
    getCatalog: () => DEFS.map((d) => ({
      name: d.name,
      displayName: d.name,
      description: d.description,
      category: '插件 db-pro',
      categoryEmoji: '',
      defaultOn: false,
    })),
    handles: () => true,
    execute: async (name, args, toolCtx) => {
      const method = METHOD_OF[name];
      if (!method) throw new Error(`未知工具: ${name}`);
      const res = await ctx.callService(
        method,
        { ...args, sessionId: toolCtx.streamSessionId, taskId: toolCtx.taskId ?? null },
        { timeoutMs: CALL_TIMEOUT_MS },
      );
      return render(name, res);
    },
  };
}

module.exports = { createTools };
```

- [ ] **Step 5: 跑测试确认通过**

Run: `cd ../momo-plugin && npx vitest run tests/db-pro/tools.test.mjs`
Expected: PASS（6 用例）。

- [ ] **Step 6: 提交**

```bash
git -C ../momo-plugin add plugins/db-pro/tools/index.js plugins/db-pro/engine/format.js tests/db-pro/tools.test.mjs
git -C ../momo-plugin commit -m "feat(db-pro): 11 工具面（callService 透传 + sessionId 注入 + 结果渲染）"
```

### Task 16: skill 指引 + README + 打包说明

**Files:**
- Modify: `../momo-plugin/plugins/db-pro/skills/db-usage/SKILL.md`（全量替换）
- Create: `../momo-plugin/plugins/db-pro/README.md`

**Interfaces:** 无代码接口——agent 行为引导与使用者文档。

- [ ] **Step 1: 写全量 SKILL.md**

`../momo-plugin/plugins/db-pro/skills/db-usage/SKILL.md` 全量替换：

```markdown
---
name: db-usage
description: 使用 db-pro 插件查询数据库的正确姿势：先探索结构再只读查询；写操作走人工批准两段式
---

# db-pro 数据库查询指引

## 工具面

- 探索：`list_connections` → `list_schemas` → `list_tables` / `list_views` → `describe_table` / `list_columns` / `get_ddl`
- 查询：`query`（只读：SELECT/SHOW/DESCRIBE/EXPLAIN/WITH-SELECT；禁多语句与 FOR UPDATE）
- 计划：`explain_query`
- 写（两段式）：`write` 创建请求（不执行）→ 提醒用户在「人工请求」面板处理 → `write_status` 查结果

## 姿势

1. 先 `list_connections` 确认可用连接；未配置时引导用户到 设置 → 插件 → db-pro 配置连接串（槽位 conn1-6，URL 形如 `mysql://user:pass@host:3306/db`、`postgres://…`、`oracle://user:pass@host:1521/服务名`、`dm://user:pass@host:5236`）
2. 查询前先 `describe_table` / `list_columns` 了解结构，避免瞎猜列名
3. 大表必加 WHERE / LIMIT；`query` 默认行数上限 200、超时 30s（超限截断并提示总数）
4. 写操作：`write` 后必须告知用户需要批准；**批准前绝不声称"已完成"**；用户批准后用 `write_status` 取结果（同一请求只会执行一次）
5. 被只读校验拒绝时不要绕——改写 SQL（如去掉 FOR UPDATE）或改用 `write`

## 错误对照

- 引擎未就绪 / 已退出 → 稍等重试（自动重启中）
- 连接失败 → 引导检查连接串与网络（密码不回显）
- query 超时 → 缩小结果集（WHERE / 分页）
- 达梦握手加密失败 → 环境问题，引导用户查看插件日志
```

- [ ] **Step 2: 写 README.md**

`../momo-plugin/plugins/db-pro/README.md`：

```markdown
# db-pro —— 数据库查询插件（momo-studio）

agent 可查询 MySQL / PostgreSQL / Oracle（12c+ thin）/ 达梦 DM8：**只读直查 + 写操作人工批准**（两段式，多连接池）。设计依据：momo-studio `docs/specs/2026-11-17-db-pro-plugin-design.md`。

## 安装（dev 流）

momo-studio → 设置 → 插件 → 开发目录安装 → 选本目录。依赖：`npm install`（本目录内）。

## 配置（设置 → 插件 → db-pro）

- 槽位 `conn1`-`conn6`：URL（敏感，入 keytar）+ 可选名称。格式：
  `mysql://user:pass@host:3306/db` · `postgres://user:pass@host:5432/db` · `oracle://user:pass@host:1521/服务名`（Oracle 11g 不支持） · `dm://user:pass@host:5236`
- `default_connection` / `readonly_max_rows`（200）/ `query_timeout_ms`（30000）

## 测试

```bash
# 单测（Node 24）
cd ../momo-plugin && npx vitest run tests/db-pro/
# 四库集成（OrbStack docker）
docker compose -f tests/docker/docker-compose.yml up -d
DBPRO_INTEGRATION=1 npx vitest run tests/db-pro/integration.test.mjs
```

## 打包分发

```bash
cd plugins/db-pro && npm install --omit=dev
cd .. && zip -r db-pro-<version>.zip db-pro -x 'db-pro/spike/*' 'db-pro/.git/*'
```
（zip 内含 node_modules——四驱动全纯 JS，无平台 ABI 问题。）

## 许可备注

- 插件代码：随 momo-plugin 仓双授权（AGPL-3.0 + 商业授权）
- `dmdb` npm 包为达梦官方闭源许可（Proprietary）——仅作为依赖分发，见其 npm 页
```

- [ ] **Step 3: 提交**

```bash
git -C ../momo-plugin add plugins/db-pro/skills/db-usage/SKILL.md plugins/db-pro/README.md
git -C ../momo-plugin commit -m "docs(db-pro): skill 使用指引 + README（配置/测试/打包）"
```

---

## Phase D — 集成与验收

### Task 17: 四库 docker 集成测试

**Files:**
- Create: `../momo-plugin/tests/db-pro/integration.test.mjs`

**Interfaces:**
- Consumes: Task 1 docker 四库（mysql `:13306` / pg `:15432` / oracle `:11521/FREEPDB1` / dm `:15236`）；Task 5-8 驱动、Task 9 引擎
- **本任务是 Review Focus #2（dmdb API 形状）的仲裁者**：集成失败 → 改驱动实现（不改契约、不改测试期望；方言 SQL 映射以真库行为为准修正并在测试样本锁定）

- [ ] **Step 1: 写集成测试（env 门控——无 docker 时 skip 不红）**

`../momo-plugin/tests/db-pro/integration.test.mjs`：

```js
// 四库真库集成（spec §9）：docker compose（tests/docker/）+ DBPRO_INTEGRATION=1 门控。
// 覆盖每库：建池 → ping → 建表(exec) → 插入 → query → 元数据五件 → ddl → explain → 清理。
// 达梦/Oracle 首跑即 Review Focus #2 仲裁：API 形状不符改驱动、方言 SQL 以实测修正。
import { describe, it, expect, beforeAll } from 'vitest';

const ON = process.env.DBPRO_INTEGRATION === '1';

const CASES = [
  {
    dialect: 'mysql',
    url: () => process.env.DBPRO_MYSQL ?? 'mysql://root:dbpro123@127.0.0.1:13306/dbpro',
    createTable: 'CREATE TABLE dbpro_t (id INT PRIMARY KEY, name VARCHAR(40))',
    insert: "INSERT INTO dbpro_t VALUES (1, 'a')",
    select: 'SELECT id, name FROM dbpro_t ORDER BY id',
    ddlContains: 'CREATE TABLE',
    drop: 'DROP TABLE dbpro_t',
  },
  {
    dialect: 'postgres',
    url: () => process.env.DBPRO_PG ?? 'postgres://postgres:dbpro123@127.0.0.1:15432/dbpro',
    createTable: 'CREATE TABLE dbpro_t (id INT PRIMARY KEY, name VARCHAR(40))',
    insert: "INSERT INTO dbpro_t VALUES (1, 'a')",
    select: 'SELECT id, name FROM dbpro_t ORDER BY id',
    ddlContains: 'CREATE TABLE',
    drop: 'DROP TABLE dbpro_t',
  },
  {
    dialect: 'oracle',
    url: () => process.env.DBPRO_ORACLE ?? 'oracle://dbpro:dbpro123@127.0.0.1:11521/FREEPDB1',
    createTable: 'CREATE TABLE dbpro_t (id NUMBER PRIMARY KEY, name VARCHAR2(40))',
    insert: "INSERT INTO dbpro_t VALUES (1, 'a')",
    select: 'SELECT id, name FROM dbpro_t ORDER BY id',
    ddlContains: 'CREATE TABLE',
    drop: 'DROP TABLE dbpro_t',
  },
  {
    dialect: 'dm',
    url: () => process.env.DBPRO_DM ?? 'dm://SYSDBA:SYSDBA@127.0.0.1:15236',
    createTable: 'CREATE TABLE dbpro_t (id INT PRIMARY KEY, name VARCHAR(40))',
    insert: "INSERT INTO dbpro_t VALUES (1, 'a')",
    select: 'SELECT id, name FROM dbpro_t ORDER BY id',
    ddlContains: 'CREATE TABLE', // DBMS_METADATA 不可用时改 catalog 拼装并放宽为 'dbpro_t'
    drop: 'DROP TABLE dbpro_t',
  },
];

describe.skipIf(!ON)('四库集成', () => {
  for (const c of CASES) {
    describe(c.dialect, () => {
      let pool;
      beforeAll(async () => {
        const driver = {
          mysql: () => import('../../plugins/db-pro/engine/drivers/mysql.js'),
          postgres: () => import('../../plugins/db-pro/engine/drivers/pg.js'),
          oracle: () => import('../../plugins/db-pro/engine/drivers/oracle.js'),
          dm: () => import('../../plugins/db-pro/engine/drivers/dm.js'),
        }[c.dialect];
        const mod = await driver();
        const createPool = mod.default?.createPool ?? mod.createPool;
        pool = await createPool(c.url(), { queryTimeoutMs: 15_000 });
      });

      it('ping + 建表 + 插入', async () => {
        await pool.ping();
        await pool.exec(c.drop).catch(() => undefined); // 幂等清场
        await pool.exec(c.createTable);
        const r = await pool.exec(c.insert);
        expect(r.affectedRows).toBeGreaterThanOrEqual(1);
      });
      it('query 返回插入行', async () => {
        const r = await pool.query(c.select, 10);
        expect(r.rows).toEqual([[1, 'a']]);
        expect(r.columns.slice(0, 2).map((x) => String(x).toUpperCase())).toEqual(['ID', 'NAME']);
      });
      it('元数据：schemas / tables / describe / columns', async () => {
        const schemas = await pool.listSchemas();
        expect(schemas.length).toBeGreaterThan(0);
        const tables = await pool.listTables();
        expect(tables.map((t) => String(t.name).toUpperCase())).toContain('DBPRO_T');
        const d = await pool.describe(undefined, 'DBPRO_T');
        expect(d.columns.length).toBe(2);
        const cols = await pool.columns(undefined, 'DBPRO_T');
        expect(cols.map((x) => String(x.name).toUpperCase())).toEqual(['ID', 'NAME']);
      });
      it('ddl', async () => {
        const ddl = await pool.ddl(undefined, 'DBPRO_T');
        expect(String(ddl).toUpperCase()).toContain(c.ddlContains);
      });
      it('explain（达梦走 lastExecInfo 特化——本用例即仲裁点）', async () => {
        const p = await pool.explain(c.select);
        expect(p.text.length).toBeGreaterThan(0);
      });
      it('清场', async () => {
        await pool.exec(c.drop);
        await pool.close();
      });
    });
  }
});
```

（`describe/schema` 参数传 `undefined` 走各驱动缺省 schema；若某方言缺省推导失败（如 Oracle 用户名大小写），在该 CASE 加 `schema: 'DBPRO'` 字段并透传——以实测为准。）

- [ ] **Step 2: 起库并跑集成**

```bash
docker compose -f ../momo-plugin/tests/docker/docker-compose.yml up -d
cd ../momo-plugin && DBPRO_INTEGRATION=1 npx vitest run tests/db-pro/integration.test.mjs
```

Expected: 四库 × 6 用例全绿。

**失败处置（Review Focus #2）**：
- dmdb `createPool` 选项名不符 → 改 `drivers/dm.js` 的选项对象（如 `connectString` 形态）后重跑
- 结果集形状不符（无 `rows`/`metaData`）→ 改 `normalizeRows` 归一逻辑
- `lastExecInfo.explain` 为空 → 检查 EXPLAIN 语法（DM 为 `EXPLAIN <sql>`），并把真实计划文本样本回填 `driver-dm.test.mjs` 的 `parseExplainPlan` 用例
- `DBMS_METADATA` 不可用 → dm.ddl 改 catalog 拼装（照抄 pg.js 的 ddl 实现），`ddlContains` 放宽
- Oracle `ALL_USERS.ORACLE_MAINTAINED` 不存在（老版本）→ 过滤条件改 `WHERE username NOT IN ('SYS','SYSTEM')`

每次改驱动后：单测 + 集成一起重跑；修正点回填对应单测样本（锁定，防回归）。

- [ ] **Step 3: 插件仓全量回归**

Run: `cd ../momo-plugin && npx vitest run tests/db-pro/`
Expected: 全绿（含集成，env 仍在）。

- [ ] **Step 4: 提交**

```bash
git -C ../momo-plugin add tests/db-pro/integration.test.mjs plugins/db-pro
git -C ../momo-plugin commit -m "test(db-pro): 四库 docker 集成（dmdb API 形状仲裁锁定）"
```

### Task 18: 端到端 dev 链手验（spec §11.3/§11.4）

**Files:** 无新文件——手验清单 + 发现问题回修对应任务。

**Interfaces:** Consumes 全部前置任务。

- [ ] **Step 1: 启动与安装**

```bash
npx pnpm@9.0.0 dev
```
设置 → 插件 → db-pro 已是 dev 安装（Task 2）→ 配置 `conn1_url = mysql://root:dbpro123@127.0.0.1:13306/dbpro`、`conn2_url = dm://SYSDBA:SYSDBA@127.0.0.1:15236`、`conn2_name = dm_test`。
Expected: 保存后主进程日志见引擎 configure；无报错。

- [ ] **Step 2: 只读链路（mysql）**

任一会话对 agent 说：「用 db-pro 列出 mysql 连接的库和表，然后查 dbpro 库里任意一张表的前 5 行」。
Expected: agent 依次调 `list_connections` → `list_schemas`/`list_tables` → `query`；工具卡片正常渲染表格；**尝试让它执行 `UPDATE` 时 agent 应改走 write 或被 query 拒绝**（只读校验负例实测）。

- [ ] **Step 3: 写批准链路（两段式）**

对 agent 说：「在 dbpro 库建一张表 dbpro_e2e(id int, name varchar(20)) 并插入一行」。
Expected:
1. agent 调 `write`（DDL）→ 返回 requestId + 提醒等待批准
2. 会话「人工请求」面板出现卡片：**显示 SQL + 连接名 + DDL 标签，无「允许本会话」按钮**（Task 12 验收点）
3. 点「拒绝」→ agent 下次 `write_status` 收到拒绝
4. 重发 write → 点「允许本次」→ `write_status` 返回 executed（DDL affectedRows）
5. 再让 agent 重复查同一 requestId → replayed 缓存结果（幂等验收点）

- [ ] **Step 4: 达梦链路（Runtime 阶梯真机验证——Review Focus #5）**

对 agent 说：「用 dm_test 连接查达梦的表清单和 dbpro_t 的执行计划」。
Expected: 连接成功（若握手报 6071/加密错误 → spike/RESULT.md 阶梯与真机不符：按 Task 13 的注释位置改 spawn 阶梯，回填 RESULT.md）；`explain_query` 返回计划文本。

- [ ] **Step 5: 崩溃恢复**

`ps aux | grep MOMO_DBPRO_ENGINE` 找到引擎进程 `kill <pid>`，随后立即让 agent 再查一次。
Expected: 首次调用返回「引擎已退出/重启中」人话错误；数秒后重试成功；**pending 中的写请求不受影响**（批准后 write_status 仍可执行一次）。

- [ ] **Step 6: 问题回修与记录**

手验发现的问题回修对应任务文件并补充测试；全部通过后在本计划勾选完毕。

### Task 19: [momo-studio] 收尾验证与账本

**Files:**
- Modify: `CHANGELOG.md`（研发账本条目）
- Modify: 三处 `package.json`（root / electron / renderer——alpha 号 +1，按 `docs/dev/release.md` 研发期版本号策略）

**Interfaces:** 无。

- [ ] **Step 1: 宿主仓类型检查**

Run: `npx pnpm@9.0.0 typecheck`
Expected: 双 workspace 零错误（Task 10-12 改动面）。

- [ ] **Step 2: 宿主仓定向套件**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/plugin tests/task --pool=forks`
Run: `cd renderer && npx pnpm@9.0.0 vitest run src/components/im/HumanRequestPanel.test.tsx`
Expected: 全绿（含既有回归）。

- [ ] **Step 3: 全量冒烟**

Run: `npx pnpm@9.0.0 test`
Expected: 无新增失败（存量失败甄别与本特性无关）。

- [ ] **Step 4: 账本与版本**

- `CHANGELOG.md` 追加 db-pro 特性条目（研发账本风格：能力/边界/验收状态）
- 三处 `package.json` alpha 号 +1（合入特性；若本次不视为大特性合入，以用户裁定为准——执行者不确定时问用户）

- [ ] **Step 5: 提交**

```bash
git add CHANGELOG.md package.json electron/package.json renderer/package.json
git commit -m "chore: db-pro 插件宿主扩展收尾（账本 + alpha 版本号）"
```

---

## 计划自审记录（writing-plans Self-Review）

1. **Spec 覆盖**：§3 架构→Task 2/9/13；§4.1 工具面（11 个）→Task 15；§4.2 service→Task 13/14；§4.3 config 槽位→Task 2 manifest + Task 13 config-connections；§4.4 引擎/驱动→Task 3-9；§5.1-5.3 数据流→Task 13/14/15；§6.1 只读校验→Task 4；§6.2 写批准→Task 10/11/14；§6.3 凭据→manifest sensitive + stdin 传配置（Task 13）；§7 宿主改动三项→Task 10/11/12；§8 错误处理→Task 13（退避）/Task 14（幂等）/工具描述；§9 测试策略→Task 3-15 单测 + Task 17 集成 + Task 18 手验；§10 非目标→未越界；§11 验证→Task 18/19。**无缺口**。
2. **占位符扫描**：宿主测试中「照抄 tool-gate-persistence.test.ts 初始化」两处为**对既有代码的显式引用**（harness 已存在于仓库，非 TBD）；Task 12 测试的 `makeRow/buildPanelProps` 同理引用既有测试文件模式。其余无 TBD/TODO。
3. **类型一致性**：Pool 契约（Task 5 定义，6/7/8 同构，9 消费）、引擎方法面（Task 9 Interfaces 与 Task 13 READ_METHODS 一致）、service 方法名（Task 13 Interfaces 与 Task 15 METHOD_OF 一致：listConnections/query/meta.*/explain/write/writeStatus）、humanGate 面（Task 10 types 与 Task 14 消费一致）、payload 形态 `{db:{connection,sql,opClass}}`（Task 10 测试 / Task 11 判定 / Task 12 渲染 / Task 14 写入四处一致）。
4. **Review Focus→测试锚**：#1→Task 4；#2→Task 17（+dm 驱动标注）；#3→Task 14 重启恢复用例；#4→Task 15 注入断言 + Task 14 守卫 + Task 10 create 拒空；#5→Task 1 + Task 18 Step 4。

