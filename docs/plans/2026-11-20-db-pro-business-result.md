# db-pro 业务成功判定与执行预检（C 期）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 script_execute 回执区分「语句成功」与「业务成功」（双层判定），会话自动对齐 collation，dryrun 连库预检，逐条明细 + 一键核验，报错附可用连接（R1–R7 全量）。

**Architecture:** 引擎结果协议加字段（outputs/businessStatus/verification）、mysql 会话捕获 CALL 结果集并对齐 collation、新增 scriptPrecheck 引擎方法（连库只读预检）、连接级可选 scriptJudge 配置（层 2 权威判定）、service/tools/panel 配套。

**Tech Stack:** 纯 JS（CommonJS 插件侧）+ vitest（.test.mjs ESM）+ docker MySQL 8 集成（样本包 fixtures）。

**Spec:** `moo-studio/docs/specs/2026-11-20-db-pro-business-result-and-precheck-design.md`（本计划从 spec 出发，执行者须同时读 spec）

## Global Constraints

- 所有代码注释中文；标识符英文
- 测试放 `tests/db-pro/*.test.mjs`（vitest ESM，`import m from '../../plugins/db-pro/...'`）；集成测试沿用端口探测 + `DBPRO_MYSQL` 环境变量门控（缺省 `mysql://root:dbpro123@127.0.0.1:13306/dbpro`）
- 集成测试带 `DBPRO_INTEGRATION` 语义不变：端口不通整文件 skip
- 分支：momo-plugin `feat/db-pro-business-result`（自 main 切出）；commit 用 `git -c user.name=stbearangel -c user.email=stbearangel@stbearangel-mac-24006.local commit`；Conventional Commits（feat:/fix:/test:/docs:）
- 不动 package.json 版本号；不委派子 agent
- 面板改动（Task 11）为 P1 UI 变更：先静态预览（`.omo/previews/db-pro-script-judge.html`）经用户确认再实现
- affectedRows 语义修正处如实同步旧断言（spec C9），不为兼容保留失真语义

## Review Focus

| # | 输入类/失效模式 | 期望行为 | 锁定任务 |
|---|---|---|---|
| 1 | CALL 返回 `[rows]` 无尾 OK 包 / `[ok, rows, ok]` 混合形态 | outputs/affectedRows 不炸、不误报 | Task 2 |
| 2 | failPattern 配了非法正则（如 `^[`） | store 校验拒绝；引擎侧 try/catch 兜底默认正则 | Task 6 |
| 3 | 层 2 日志表无 sortColumn 且探测不到自增主键 | 层 2 降级告警，不猜排序 | Task 6 |
| 4 | UK 列含非字面量（@var/函数/NULL 占位不一致） | 该表静默跳过，不误报冲突 | Task 8 |
| 5 | 核验表名为保留字/非法标识符 | quoteIdent 转义；非法 → count=null 不炸 | Task 5 |
| 6 | onError=continue：部分语句 failed 且层 1 命中 | businessStatus 仍 failed（语句失败优先级最高） | Task 4 |

---

### Task 1: splitter 模板缺陷静态警告（spec §6 附带）

**Files:**
- Modify: `plugins/db-pro/engine/script-splitter.js`
- Test: `tests/db-pro/script-splitter.test.mjs`

**Interfaces:**
- Produces: `detectTemplateIssues(statements) → [{line, type: 'handler_order', message}]`（新增导出；engine Task 4 的 scriptAnalyze/scriptRun 会把结果并入 warnings）

- [ ] **Step 1: 写失败测试**（追加到 script-splitter.test.mjs）

```js
import { splitStatements, detectTemplateIssues } from '../../plugins/db-pro/engine/script-splitter.js';

describe('detectTemplateIssues handler 顺序', () => {
  const BAD = `DELIMITER //
CREATE PROCEDURE sp_x()
BEGIN
  DECLARE EXIT HANDLER FOR SQLEXCEPTION
  BEGIN
    ROLLBACK;
    GET DIAGNOSTICS CONDITION 1 @e = MESSAGE_TEXT;
  END;
  START TRANSACTION;
END//
DELIMITER ;`;
  const GOOD = BAD.replace('ROLLBACK;\n    GET DIAGNOSTICS', 'GET DIAGNOSTICS CONDITION 1 @e = MESSAGE_TEXT;\n    ROLLBACK;').replace(/GET DIAGNOSTICS CONDITION 1 @e = MESSAGE_TEXT;\n    ROLLBACK;\n    GET DIAGNOSTICS CONDITION 1 @e = MESSAGE_TEXT;/, 'GET DIAGNOSTICS CONDITION 1 @e = MESSAGE_TEXT;\n    ROLLBACK;');
  it('ROLLBACK 先于 GET DIAGNOSTICS 告警', () => {
    const { statements } = splitStatements(BAD, 'mysql');
    const issues = detectTemplateIssues(statements);
    expect(issues.length).toBe(1);
    expect(issues[0].type).toBe('handler_order');
    expect(issues[0].message).toContain('吞错');
  });
  it('顺序正确不告警', () => {
    const { statements } = splitStatements(GOOD, 'mysql');
    expect(detectTemplateIssues(statements)).toEqual([]);
  });
  it('无 handler 不误报', () => {
    const { statements } = splitStatements('INSERT INTO t VALUES (1);', 'mysql');
    expect(detectTemplateIssues(statements)).toEqual([]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /Users/stbearangel/dev/AiProject/momo-plugin && npx vitest run tests/db-pro/script-splitter.test.mjs`
Expected: FAIL（detectTemplateIssues 不是函数）

- [ ] **Step 3: 实现**（script-splitter.js 末尾导出前）

```js
// 模板缺陷检测（spec 2026-11-20 §6 附带）：EXIT HANDLER 内 ROLLBACK 先于
// GET DIAGNOSTICS——MySQL ROLLBACK 会清空诊断区，真实错误被吞成 [?] Unknown error。
// MySQL 语法启发式：仅扫 procedure 语句文本，命中即告警（非阻断）。
function detectTemplateIssues(statements) {
  const issues = [];
  for (const s of statements) {
    if (s.cls !== 'procedure' || !/CREATE\s+PROCEDURE/i.test(s.text)) continue;
    const m = s.text.match(/EXIT\s+HANDLER[^;]*\sBEGIN([\s\S]*?)END/si);
    if (!m) continue;
    const body = m[1];
    const rb = body.search(/\bROLLBACK\b/i);
    const gd = body.search(/\bGET\s+DIAGNOSTICS\b/i);
    if (rb >= 0 && gd >= 0 && rb < gd) {
      issues.push({
        line: s.line,
        type: 'handler_order',
        message: `第 ${s.line} 行存储过程 EXIT HANDLER 内 ROLLBACK 先于 GET DIAGNOSTICS——回滚会清空诊断区吞错（真实错误变 [?] Unknown error）。建议模板改为先取诊断再回滚。`,
      });
    }
  }
  return issues;
}
```

module.exports 增补 `detectTemplateIssues`。

- [ ] **Step 4: 跑测试确认通过**（同 Step 2 命令，Expected: PASS）
- [ ] **Step 5: Commit**

```bash
git add plugins/db-pro/engine/script-splitter.js tests/db-pro/script-splitter.test.mjs
git -c user.name=stbearangel -c user.email=stbearangel@stbearangel-mac-24006.local commit -m "feat(db-pro): splitter 检测 handler 内 ROLLBACK 先于 GET DIAGNOSTICS 吞错模板"
```

---

### Task 2: mysql 会话 CALL 输出捕获 + affectedRows 语义修正（spec §4.1/§7.1）

**Files:**
- Modify: `plugins/db-pro/engine/drivers/mysql.js`
- Test: `tests/db-pro/driver-mysql.test.mjs`

**Interfaces:**
- Produces: `normalizeMysqlResults(res) → { affectedRows: number, outputs: [{columns: string[], rows: string[][]}] | null }`（纯函数，导出）
- Produces: `createMysqlSession(conn, timeoutMs) → session`（导出；openSession 内部改调它）。session 契约 v2：`exec(sql) → {affectedRows, outputs?}`；`count(table) → number|null`（Task 5 其他驱动跟进）
- outputs 有界：每结果集前 50 行、单元格 200 字截断（常量 `OUTPUT_MAX_ROWS`/`OUTPUT_CELL_MAX`）

- [ ] **Step 1: 写失败测试**

```js
import { describe, it, expect } from 'vitest';
import m from '../../plugins/db-pro/engine/drivers/mysql.js';
const { normalizeMysqlResults } = m;

const okPacket = (n) => ({ affectedRows: n });
const rows = (cols, vals) => [Object.fromEntries(cols.map((c, i) => [c, vals[i]]))];

describe('normalizeMysqlResults（CALL 多结果集形态）', () => {
  it('纯 OK 包：只有影响行数', () => {
    const r = normalizeMysqlResults(okPacket(3));
    expect(r).toEqual({ affectedRows: 3, outputs: null });
  });
  it('CALL [rows, ok]：输出捕获 + 尾部 OK 为影响行数', () => {
    const r = normalizeMysqlResults([rows(['execution_status'], ['[FAIL] S00971511 -- [23000] dup']), okPacket(0)]);
    expect(r.affectedRows).toBe(0);
    expect(r.outputs).toEqual([{ columns: ['execution_status'], rows: [['[FAIL] S00971511 -- [23000] dup']] }]);
  });
  it('CALL [rows] 无尾 OK 包：影响行数 0（Review Focus 1）', () => {
    const r = normalizeMysqlResults([rows(['a'], ['x'])]);
    expect(r.affectedRows).toBe(0);
    expect(r.outputs.length).toBe(1);
  });
  it('多结果集 [ok, rows, ok]', () => {
    const r = normalizeMysqlResults([okPacket(1), rows(['a'], ['y']), okPacket(5)]);
    expect(r.affectedRows).toBe(5);
    expect(r.outputs).toEqual([{ columns: ['a'], rows: [['y']] }]);
  });
  it('有界：50 行截断 + 200 字截断', () => {
    const many = Array.from({ length: 60 }, (_, i) => rows(['v'], [String(i)]));
    const r = normalizeMysqlResults([...many, okPacket(0)]);
    expect(r.outputs[0].rows.length).toBe(50);
    const long = 'x'.repeat(300);
    const r2 = normalizeMysqlResults([rows(['v'], [long])]);
    expect(r2.outputs[0].rows[0][0].length).toBe(200);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**（`npx vitest run tests/db-pro/driver-mysql.test.mjs`，Expected: FAIL）

- [ ] **Step 3: 实现**（mysql.js）

在 `cell` 归一化函数之后加：

```js
// ── 脚本通道结果归一（spec 2026-11-20 §4.1/§7.1）──────────────────
// mysql2 query() 对 CALL 返回 [结果集数组, fields]；结果集元素可能是
// 行数组（有输出）或 OkPacket（DML 尾包）。旧实现把结果集个数当影响
// 行数——废除：输出捕获进 outputs（有界），影响行数取最后一个 OkPacket。
const OUTPUT_MAX_ROWS = 50;
const OUTPUT_CELL_MAX = 200;

function isOkPacket(x) {
  return x !== null && typeof x === 'object' && !Array.isArray(x)
    && ('affectedRows' in x || 'insertId' in x || 'serverStatus' in x);
}

function toOutput(set) {
  if (!Array.isArray(set) || set.length === 0) return null;
  const first = set[0];
  const columns = Object.keys(first ?? {});
  if (columns.length === 0) return null;
  const outRows = set.slice(0, OUTPUT_MAX_ROWS)
    .map((r) => columns.map((c) => String(cell(r[c]) ?? '').slice(0, OUTPUT_CELL_MAX)));
  return { columns, rows: outRows };
}

function normalizeMysqlResults(res) {
  // 形态 A：直接 OkPacket（普通 DML/DDL）
  if (isOkPacket(res)) return { affectedRows: res.affectedRows ?? 0, outputs: null };
  // 形态 B：单 SELECT 行数组（session 内偶发 SELECT）
  if (Array.isArray(res) && res.length > 0 && !isOkPacket(res[0]) && !Array.isArray(res[0])) {
    const out = toOutput(res);
    return { affectedRows: out ? out.rows.length : 0, outputs: out ? [out] : null };
  }
  // 形态 C：CALL 多结果集数组
  if (Array.isArray(res)) {
    const outputs = res.map(toOutput).filter(Boolean);
    const lastOk = [...res].reverse().find(isOkPacket);
    return { affectedRows: lastOk?.affectedRows ?? 0, outputs: outputs.length > 0 ? outputs : null };
  }
  return { affectedRows: 0, outputs: null };
}

/** 会话工厂（导出以便单测注入假 conn）：exec 带 outputs；count 供核验快照（Task 5） */
function createMysqlSession(conn, timeoutMs) {
  return {
    async exec(sql) {
      const [res] = await conn.query({ sql, timeout: timeoutMs });
      return normalizeMysqlResults(res);
    },
    async count(table) {
      try {
        const [res] = await conn.query({ sql: `SELECT COUNT(*) AS c FROM ${quoteIdent(table)}`, timeout: timeoutMs });
        const v = Array.isArray(res) ? res[0]?.c : undefined;
        return typeof v === 'number' ? v : null;
      } catch { return null; } // 表不存在/非法名 → null（Review Focus 5）
    },
    async finish() {},
    async close() { conn.release(); },
  };
}
```

`openSession()` 改为：

```js
async openSession() {
  const conn = await pool.getConnection();
  return createMysqlSession(conn, timeoutMs);
},
```

module.exports 增补 `normalizeMysqlResults, createMysqlSession`。

- [ ] **Step 4: 跑测试确认通过**
- [ ] **Step 5: Commit**

```bash
git add plugins/db-pro/engine/drivers/mysql.js tests/db-pro/driver-mysql.test.mjs
git -c user.name=stbearangel -c user.email=stbearangel@stbearangel-mac-24006.local commit -m "feat(db-pro): mysql 会话捕获 CALL 结果集 + affectedRows 语义修正"
```

---

### Task 3: mysql 会话 collation 自动对齐（spec §5，R3）

**Files:**
- Modify: `plugins/db-pro/engine/drivers/mysql.js`（createMysqlSession 内）
- Test: `tests/db-pro/driver-mysql.test.mjs`

**Interfaces:**
- Consumes: Task 2 的 `createMysqlSession(conn, timeoutMs)`
- Produces: openSession 建连后自动对齐；脚本自带 SET NAMES 后执行自然覆盖

- [ ] **Step 1: 写失败测试**

```js
import { createMysqlSession } from '../../plugins/db-pro/engine/drivers/mysql.js';

function fakeConn(sends) {
  // sends: 每条 query(sql) 的应答队列；记录收到的 sql 序列
  const log = [];
  return {
    log,
    async query(opts) {
      log.push(opts.sql);
      const r = sends.shift();
      if (typeof r === 'function') return [r(opts.sql)];
      return [r];
    },
    release() {},
  };
}

describe('mysql 会话 collation 对齐（R3）', () => {
  it('会话≠库默认 → 发 SET NAMES 对齐', async () => {
    const conn = fakeConn([
      [{ cs: 'utf8mb4', dbColl: 'utf8mb4_0900_ai_ci', connColl: 'utf8mb4_unicode_ci' }],
      { affectedRows: 0 },
    ]);
    const s = createMysqlSession(conn, 30_000);
    await s.exec('SELECT 1');
    expect(conn.log[0]).toContain('@@collation_database');
    expect(conn.log[1]).toBe('SET NAMES utf8mb4 COLLATE utf8mb4_0900_ai_ci');
  });
  it('会话=库默认 → 不发 SET NAMES', async () => {
    const conn = fakeConn([
      [{ cs: 'utf8mb4', dbColl: 'utf8mb4_0900_ai_ci', connColl: 'utf8mb4_0900_ai_ci' }],
    ]);
    const s = createMysqlSession(conn, 30_000);
    await s.exec('SELECT 1');
    expect(conn.log.length).toBe(2); // 只探查 + 业务语句
    expect(conn.log[1]).toBe('SELECT 1');
  });
  it('探查失败（权限等）→ 静默跳过不阻断', async () => {
    const conn = fakeConn([() => { throw new Error('no priv'); }]);
    const s = createMysqlSession(conn, 30_000);
    await s.exec('SELECT 1');
    expect(conn.log[1]).toBe('SELECT 1');
  });
});
```

注意：createMysqlSession 改为**懒对齐**——首次 exec 前做一次探查（openSession 时做也行，但工厂被 Task 2 定义为构造即用；采用「首次 exec 前」一次性标志位实现，保证 `createMysqlSession(conn)` 单测可控）。

- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现**（createMysqlSession 开头加状态，exec 前对齐）

```js
function createMysqlSession(conn, timeoutMs) {
  let aligned = false;
  async function alignCollationOnce() {
    // R3（spec §5）：会话 collation（驱动默认 utf8mb4_unicode_ci）≠ 目标库默认
    // （如 utf8mb4_0900_ai_ci）时，过程/用户变量与表列比较会炸 Illegal mix of
    // collations——对齐到 @@collation_database；脚本自带 SET NAMES 时后执行自然覆盖。
    if (aligned) return;
    aligned = true;
    try {
      const [res] = await conn.query({
        sql: 'SELECT @@character_set_database AS cs, @@collation_database AS dbColl, @@collation_connection AS connColl',
        timeout: timeoutMs,
      });
      const r = Array.isArray(res) ? res[0] : null;
      if (r && r.dbColl && r.dbColl !== r.connColl && /^[A-Za-z0-9_]+$/.test(String(r.cs))) {
        await conn.query({ sql: `SET NAMES ${r.cs} COLLATE ${r.dbColl}`, timeout: timeoutMs });
      }
    } catch { /* 探查失败不阻断脚本执行 */ }
  }
  return {
    async exec(sql) {
      await alignCollationOnce();
      const [res] = await conn.query({ sql, timeout: timeoutMs });
      return normalizeMysqlResults(res);
    },
    // count/finish/close 同 Task 2（count 无需对齐——COUNT 无字符串比较）
    ...
  };
}
```

- [ ] **Step 4: 跑测试确认通过**（含 Task 2 全量回绿）
- [ ] **Step 5: Commit** `feat(db-pro): mysql 会话自动对齐目标库 collation（R3）`

---

### Task 4: engine scriptRun 结果富化 + 层 1 业务判定（spec §4.1/§4.3/§7.1）

**Files:**
- Modify: `plugins/db-pro/engine/engine.js`（scriptRun case + scriptAnalyze case 并入模板警告）
- Test: `tests/db-pro/engine.test.mjs`

**Interfaces:**
- Consumes: Task 2 `exec → {affectedRows, outputs?}`；Task 1 `detectTemplateIssues`
- Produces: scriptRun 返回值 v2：

```js
{
  ok, total, executed,
  results: [{ idx, line, kind /*=keyword*/, status, affectedRows, outputs /*可能 null*/, error?, durationMs }],
  businessStatus: 'ok' | 'failed',
  businessError?: string,          // 失败时必带（语句错误/层1命中行/层2 ERROR_MESSAGE）
  businessSource?: 'statement' | 'layer1_marker' | 'layer2_logtable',
  failedAtIndex?, error?,          // 语句级失败原字段保留
  durationMs,
}
```

- Produces: `scanFailureMarker(outputs, pattern) → string | null`（引擎内函数，Task 6 层 2 复用判定链）

- [ ] **Step 1: 写失败测试**（engine.test.mjs，利用 createDispatcher 可注入 pools）

```js
// 假会话：按语句序返回预设应答
function fakePoolSession(perStatement) {
  let i = 0;
  return {
    async exec(sql) { const r = perStatement[i++] ?? { affectedRows: 0, outputs: null }; return r; },
    async count() { return null; },
    async finish() {}, async close() {},
  };
}
function makeEngine(sessionImpl) {
  const pool = { query: async () => ({ columns: [], rows: [] }), ping: async () => undefined,
    openSession: async () => sessionImpl, close: async () => undefined };
  const { dispatch } = createDispatcher(() => { throw new Error('no driver'); }, new Map([
    ['c1', { name: 'c1', url: 'mysql://x/y', queryTimeoutMs: 30000, permissions: ['read','insert','update','delete','ddl','script'], pool }],
  ]));
  return dispatch;
}

const SCRIPT = `SET @a = 1;
DROP PROCEDURE IF EXISTS sp;
CALL sp();
DROP PROCEDURE IF EXISTS sp;`;

it('语句全成功 + 层1 命中 [FAIL] → businessStatus failed + businessError 透传', async () => {
  const dispatch = makeEngine(fakePoolSession([
    { affectedRows: 0, outputs: null },
    { affectedRows: 0, outputs: null },
    { affectedRows: 0, outputs: [{ columns: ['execution_status'], rows: [['[FAIL] S00971511 -- [23000] Duplicate entry']] }] },
    { affectedRows: 0, outputs: null },
  ]));
  const r = await dispatch('scriptRun', { connection: 'c1', script: SCRIPT });
  expect(r.ok).toBe(true);            // 语句层全成功
  expect(r.results.every((x) => x.status === 'ok')).toBe(true);
  expect(r.businessStatus).toBe('failed');
  expect(r.businessSource).toBe('layer1_marker');
  expect(r.businessError).toContain('[23000]');
  expect(r.results[2].kind).toBe('call');
  expect(r.results[2].outputs[0].rows[0][0]).toContain('[FAIL]');
});

it('onError=continue 语句失败 + 层1 命中 → 语句失败优先（Review Focus 6）', async () => {
  const dispatch = makeEngine(fakePoolSession([
    { affectedRows: 0, outputs: null },
    new Promise(() => { throw new Error('boom'); }), // exec 直接抛
  ]));
  const r = await dispatch('scriptRun', { connection: 'c1', script: 'SET @a=1;\nINSERT INTO t VALUES (1);', onError: 'continue' });
  expect(r.ok).toBe(false);
  expect(r.businessStatus).toBe('failed');
  expect(r.businessSource).toBe('statement');
});

it('无命中 → businessStatus ok', async () => {
  const dispatch = makeEngine(fakePoolSession([{ affectedRows: 2, outputs: null }]));
  const r = await dispatch('scriptRun', { connection: 'c1', script: 'INSERT INTO t VALUES (1);' });
  expect(r.businessStatus).toBe('ok');
});

it('scriptAnalyze 并入 handler_order 警告', async () => {
  const dispatch = makeEngine(fakePoolSession([]));
  const r = await dispatch('scriptAnalyze', { script: 'DELIMITER //\nCREATE PROCEDURE sp_x()\nBEGIN\n DECLARE EXIT HANDLER FOR SQLEXCEPTION\n BEGIN\n  ROLLBACK;\n  GET DIAGNOSTICS CONDITION 1 @e = MESSAGE_TEXT;\n END;\nEND//\nDELIMITER ;', dialect: 'mysql' });
  expect(r.warnings.some((w) => w.type === 'handler_order')).toBe(true);
});
```

（fakePoolSession 第二例中 exec 抛错用同步 throw 即可——`async exec() { if (i===1) throw new Error('boom'); ... }`，按此写。）

- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现**（engine.js scriptRun 循环改造）

```js
const DEFAULT_FAIL_PATTERN = /^\[FAIL\]/;

// 层 1 失败标记扫描（spec §4.1）：任一输出单元格命中即业务失败，返回命中行全文
function scanFailureMarker(outputs, pattern = DEFAULT_FAIL_PATTERN) {
  for (const out of outputs ?? []) {
    for (const row of out.rows ?? []) {
      for (const cellText of row) {
        if (pattern.test(cellText)) return cellText;
      }
    }
  }
  return null;
}
```

scriptRun 循环内改为：

```js
const t0 = Date.now();
try {
  const r = await session.exec(s.text);
  results.push({ idx: s.idx, line: s.line, kind: s.keyword, status: 'ok',
    affectedRows: r.affectedRows ?? 0, outputs: r.outputs ?? null, durationMs: Date.now() - t0 });
} catch (err) { /* 同现状，追加 kind: s.keyword, durationMs */ }
```

循环后、`session.finish` 前后（finish 在语句全成时 COMMIT——层 2 查询须在 finish 之后才能看到已提交日志；实现顺序：finish → 判定链）：

```js
await session.finish(failure === null);
// 判定链（spec §4.3）：语句失败 > 层 2（Task 6 接入）> 层 1 > ok
let businessStatus = 'ok';
let businessError = null;
let businessSource = null;
if (failure !== null) {
  businessStatus = 'failed';
  businessError = failure.message;
  businessSource = 'statement';
} else {
  const marker = scanFailureMarker(results.flatMap((x) => x.outputs ?? []));
  if (marker) { businessStatus = 'failed'; businessError = marker; businessSource = 'layer1_marker'; }
}
```

返回对象追加 `businessStatus, businessError?, businessSource?`。scriptAnalyze case 追加：

```js
const issues = detectTemplateIssues(r.statements);
if (issues.length > 0) r.warnings.push(...issues);
```

（import 行补 `detectTemplateIssues`。）

- [ ] **Step 4: 跑测试确认通过**（engine.test.mjs 全量——旧断言若因 results 加字段失败，检查是否语义断言，按 C9 如实同步）
- [ ] **Step 5: Commit** `feat(db-pro): scriptRun 逐条明细 + 层1 [FAIL] 业务判定`

---

### Task 5: R6 执行前后核验快照（spec §7.2）

**Files:**
- Modify: `plugins/db-pro/engine/drivers/{mysql,pg,oracle,dm}.js`（session 增 count）
- Modify: `plugins/db-pro/engine/engine.js`
- Test: `tests/db-pro/engine.test.mjs`

**Interfaces:**
- Consumes: splitter `summary.tables`（scriptRun 内重算）
- Produces: session 契约增 `count(table) → number|null`（mysql 已在 Task 2 落；本任务补 pg/oracle/dm）
- Produces: scriptRun 返回追加 `verification: [{table, before: number|null, after: number|null, delta: number|null}]`（前 20 张表）

- [ ] **Step 1: 写失败测试**

```js
it('核验快照：前后 COUNT 与 delta（含 CREATE 前 null 场景）', async () => {
  const counts = { existing_t: { before: 5, after: 8 } };
  const seen = [];
  const session = {
    async exec() { return { affectedRows: 0, outputs: null }; },
    async count(table) { seen.push(table); return counts[table]?.before ?? null; },
    async finish() {}, async close() {},
  };
  // count 被 engine 调两次（before/after）——用调用次数区分
  let phase = 0;
  session.count = async (t) => {
    const v = phase === 0 ? (counts[t]?.before ?? null) : (counts[t]?.after ?? null);
    return v;
  };
  const dispatch = makeEngine(session);
  const r = await dispatch('scriptRun', { connection: 'c1', script: 'INSERT INTO existing_t VALUES (1);' });
  phase = 1; // 语句已跑完——直接构造 after 断言（见下：实现里 before/after 两次调用）
  expect(r.verification).toEqual([{ table: 'existing_t', before: 5, after: 8, delta: 3 }]);
});
```

（实现时 before 快照在语句循环前、after 在判定链后各调一次 `session.count`——上面测试通过把 `phase` 翻转挂在 dispatch 返回前不现实；改为：fake session 的 count 内部用 seen 次数自增翻转 `phase`。写测试时按实现语义：第 1 次调用返回 before、第 2 次返回 after。）

简化测试（推荐落这个形态）：

```js
it('核验快照：before/after 两次 count + delta', async () => {
  const perTable = { t1: [5, 8], t2: [null, 3], t3: [2, null] };
  const callCount = new Map();
  const session = {
    async exec() { return { affectedRows: 0, outputs: null }; },
    async count(t) {
      const n = (callCount.get(t) ?? 0); callCount.set(t, n + 1);
      return perTable[t][n] ?? null;
    },
    async finish() {}, async close() {},
  };
  const dispatch = makeEngine(session);
  const r = await dispatch('scriptRun', { connection: 'c1',
    script: 'INSERT INTO t1 VALUES (1);\nINSERT INTO t2 VALUES (1);\nDROP TABLE t3;' });
  expect(r.verification).toEqual([
    { table: 't1', before: 5, after: 8, delta: 3 },
    { table: 't2', before: null, after: 3, delta: null },
    { table: 't3', before: 2, after: null, delta: null },
  ]);
});
it('表数超 20 只取前 20', async () => { /* 构造 25 张表脚本，断言 verification.length === 20 */ });
```

- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现**

pg/oracle/dm 的 session 各加（pg 用 `"` 包裹转双写；oracle/dm 双引号 + 不折大小写——表名按 splitter 原样）：

```js
// pg
function quoteIdentPg(name) {
  if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(name)) return null; // 非法则 count 返 null
  return `"${name}"`;
}
async count(table) {
  const q = quoteIdentPg(table);
  if (!q) return null;
  try {
    const res = await client.query({ text: `SELECT COUNT(*)::int AS c FROM ${q}`, values: [] });
    return typeof res.rows?.[0]?.c === 'number' ? res.rows[0].c : null;
  } catch { return null; }
},
// oracle / dm
async count(table) {
  if (!/^[A-Za-z_][A-Za-z0-9_$#]*$/.test(table)) return null;
  try {
    const res = await conn.execute(`SELECT COUNT(*) AS C FROM "${table}"`);
    const v = res.rows?.[0]?.[0] ?? res.rows?.[0]?.C;
    return typeof v === 'number' ? v : Number(v) || null;
  } catch { return null; }
},
```

engine.js scriptRun：语句循环前

```js
// R6 核验快照（spec §7.2）：推断表前 20 张；同会话前后 COUNT，delta=净增删
const verifyTables = [...new Set(statements.flatMap((s) => s.tables ?? []))].slice(0, 20);
const before = new Map();
for (const t of verifyTables) before.set(t, await session.count(t));
```

判定链之后：

```js
const verification = verifyTables.map((t) => {
  const after = session.count ? null : null; // 占位——见下
  return null;
});
// 实际实现：for 循环 await after，组装 {table, before, after, delta}
```

（实际代码：

```js
const verification = [];
for (const t of verifyTables) {
  const b = before.get(t) ?? null;
  const a = await session.count(t);
  verification.push({ table: t, before: b, after: a,
    delta: b !== null && a !== null ? a - b : null });
}
```

返回对象追加 `verification`（verifyTables.length > 0 时才有该字段）。）

- [ ] **Step 4: 跑测试确认通过**
- [ ] **Step 5: Commit** `feat(db-pro): 执行前后核验快照（表×行数，R6）`

---

### Task 6: 层 2 scriptJudge 权威判定 + 连接配置接线（spec §4.2/§8.2/§8.3）

**Files:**
- Modify: `plugins/db-pro/service/connections-store.js`
- Modify: `plugins/db-pro/engine/engine.js`（configure 存 scriptJudge + scriptRun 层 2 查询 + 判定链接入层 2）
- Test: `tests/db-pro/connections-store.test.mjs`、`tests/db-pro/engine.test.mjs`

**Interfaces:**
- Produces: 连接对象可选字段 `scriptJudge: { logTable?, scriptNoColumn?, statusColumn?, errorColumn?, okValue?, failPattern?, sortColumn? }`
- 校验规则（§8.2）：logTable/scriptNoColumn/statusColumn 三项须同时给出方生效；errorColumn/okValue/sortColumn 可选（okValue 缺省=非空即失败判定按 status !== okValue；实际语义：配置了 okValue 用等值，未配 okValue 视为不可判——**采用：okValue 必填才启用层 2 判定**，与 spec §8.2「okValue 缺省按非空即失败」冲突时以本计划为准：okValue 必填，简化歧义）；failPattern 独立生效、须可 `new RegExp` 编译
- Produces: `normalizeScriptJudge(input) → scriptJudge | null`（store 导出，engine 兜底用）

**修正 spec 歧义**：spec §8.2 写「okValue 缺省按非空即失败判定」语义含糊——本计划定为 **okValue 必填**（四项 logTable/scriptNoColumn/statusColumn/okValue 齐备层 2 才启用），写入 spec 修订一行（执行时顺带改 spec 文件该句为「okValue 必填」）。

- [ ] **Step 1: 写失败测试**（connections-store.test.mjs）

```js
import { createConnectionsStore, normalizeScriptJudge } from '../../plugins/db-pro/service/connections-store.js';

describe('normalizeScriptJudge', () => {
  it('完整配置通过', () => {
    const j = normalizeScriptJudge({ logTable: 'DAP_E_SCRIPT_EXECUTION_LOG', scriptNoColumn: 'SCRIPT_NO',
      statusColumn: 'EXECUTION_STATUS', errorColumn: 'ERROR_MESSAGE', okValue: 1, sortColumn: 'ID' });
    expect(j.logTable).toBe('DAP_E_SCRIPT_EXECUTION_LOG');
  });
  it('三项必填缺一 → 层2 判定关闭（failPattern 仍保留）', () => {
    const j = normalizeScriptJudge({ logTable: 'T', scriptNoColumn: 'S' , statusColumn: '', failPattern: '^\\[X\\]' });
    expect(j.logTable).toBeUndefined();
    expect(j.failPattern).toBe('^\\[X\\]');
  });
  it('非法正则拒绝（Review Focus 2）', () => {
    expect(() => normalizeScriptJudge({ failPattern: '^[' })).toThrow(/正则/);
  });
  it('非对象/null → null', () => {
    expect(normalizeScriptJudge(null)).toBeNull();
    expect(normalizeScriptJudge('x')).toBeNull();
  });
  it('create/update 持久化 scriptJudge 并在 listForEngine 透出', async () => {
    // 依既有 store 测试的 tmpdir+fake secrets 范式：create 带 scriptJudge → listForEngine[0].scriptJudge.logTable === 'T'
  });
});
```

（engine.test.mjs 层 2 判定测试：fake session 的 exec 按 sql 前缀返回日志行结果集——层 2 查询走 session.exec，故可复用 fake：）

```js
it('层2 权威判定：日志表 STATUS=0 → businessStatus failed + ERROR_MESSAGE 透传', async () => {
  const calls = [];
  const session = {
    async exec(sql) {
      calls.push(sql);
      if (/EXECUTION_STATUS/.test(sql)) return { affectedRows: 0,
        outputs: [{ columns: ['EXECUTION_STATUS', 'ERROR_MESSAGE'], rows: [[0, '[HY000] Illegal mix']] }] };
      return { affectedRows: 0, outputs: null };
    },
    async count() { return null; },
    async finish() {}, async close() {},
  };
  const pool = { /* 同 makeEngine，handle 带 scriptJudge 完整四项 */ };
  const r = await dispatch('scriptRun', { connection: 'c1',
    script: "SET @__script_no = 'S00971511';\nCALL sp();" });
  expect(r.businessStatus).toBe('failed');
  expect(r.businessSource).toBe('layer2_logtable');
  expect(r.businessError).toContain('[HY000]');
});
it('层2 无排序列且无自增主键 → 降级告警不猜（Review Focus 3）', async () => {
  // exec 对 SHOW/探测类返回空；断言 businessSource === 'layer1_marker' 或 'ok'，
  // 且 result.layer2Note 包含「不可用」
});
```

- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现**

connections-store.js：

```js
// 层 2 脚本判定配置归一（spec 2026-11-20 §8.2/§8.3）：四项必填（logTable/
// scriptNoColumn/statusColumn/okValue）齐备层 2 才启用；failPattern 独立生效。
const IDENT_RE = /^[A-Za-z0-9_$#]{1,64}$/;
function normalizeScriptJudge(input) {
  if (input === null || typeof input !== 'object') return null;
  const out = {};
  const { logTable, scriptNoColumn, statusColumn, errorColumn, okValue, failPattern, sortColumn } = input;
  if (typeof failPattern === 'string' && failPattern !== '') {
    try { new RegExp(failPattern); } catch { throw new Error('scriptJudge.failPattern 不是合法正则'); }
    out.failPattern = failPattern;
  }
  const coreOk = [logTable, scriptNoColumn, statusColumn].every((v) => typeof v === 'string' && IDENT_RE.test(v))
    && okValue !== undefined && okValue !== null && okValue !== '';
  if (coreOk) {
    out.logTable = logTable; out.scriptNoColumn = scriptNoColumn; out.statusColumn = statusColumn;
    out.okValue = okValue;
    if (typeof errorColumn === 'string' && IDENT_RE.test(errorColumn)) out.errorColumn = errorColumn;
    if (typeof sortColumn === 'string' && IDENT_RE.test(sortColumn)) out.sortColumn = sortColumn;
  }
  return Object.keys(out).length > 0 ? out : null;
}
```

create/update 接 `scriptJudge = normalizeScriptJudge(input.scriptJudge) ?? undefined`；记录对象存 `scriptJudge`；`listForEngine` 输出增 `scriptJudge: r.scriptJudge ?? null`；`listProjection` 同步透出（Task 11 面板编辑回填用）。

engine.js：configure 池 handle 增存 `scriptJudge: c.scriptJudge ?? null`（diff 判变条件补 `JSON.stringify(h.scriptJudge) !== JSON.stringify(c.scriptJudge ?? null)`）。scriptRun 判定链插入层 2（在层 1 之前）：

```js
} else {
  const judge = handle.scriptJudge;
  let l2 = null;
  if (judge?.logTable && scriptNo) {
    l2 = await queryScriptLog(session, judge, scriptNo); // 见下
  }
  if (l2?.status === 'failed' || l2?.status === 'ok') {
    businessStatus = l2.status === 'ok' ? 'ok' : 'failed';
    businessError = l2.status === 'ok' ? null : (l2.error ?? '（日志表未提供错误信息）');
    businessSource = 'layer2_logtable';
  } else {
    const pattern = judge?.failPattern ? compilePattern(judge.failPattern) : DEFAULT_FAIL_PATTERN;
    const marker = scanFailureMarker(results.flatMap((x) => x.outputs ?? []), pattern);
    if (marker) { businessStatus = 'failed'; businessError = marker; businessSource = 'layer1_marker'; }
  }
}
function compilePattern(p) { try { return new RegExp(p); } catch { return DEFAULT_FAIL_PATTERN; } } // Review Focus 2 兜底
```

`queryScriptLog(session, judge, scriptNo)`（engine 内函数）：

```js
// 层 2 权威判定（spec §4.2）：排序依据 sortColumn > 探测自增主键 > 不可用告警
async function queryScriptLog(session, judge, scriptNo) {
  try {
    let orderCol = judge.sortColumn ?? null;
    if (!orderCol) {
      const pk = await session.exec(
        `SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '${judge.logTable}' AND EXTRA LIKE '%auto_increment%'`);
      const v = pk?.outputs?.[0]?.rows?.[0]?.[0];
      if (typeof v === 'string' && IDENT_RE_OK(v)) orderCol = v;
    }
    if (!orderCol) return { status: 'unavailable', note: '日志表无排序列（未配 sortColumn 且探测不到自增主键）——层 2 不可用' };
    const cols = [judge.statusColumn, ...(judge.errorColumn ? [judge.errorColumn] : []), orderCol].join(', ');
    const r = await session.exec(
      `SELECT ${cols} FROM ${judge.logTable} WHERE ${judge.scriptNoColumn} = '${scriptNo.replace(/'/g, "''")}' ORDER BY ${orderCol} DESC LIMIT 1`);
    const row = r?.outputs?.[0]?.rows?.[0];
    if (!row) return { status: 'unavailable', note: '日志表无该脚本号记录' };
    const statusVal = row[0];
    const errVal = judge.errorColumn ? row[1] : null;
    const ok = String(statusVal) === String(judge.okValue);
    return ok ? { status: 'ok' } : { status: 'failed', error: errVal && errVal !== 'NULL' ? String(errVal) : null };
  } catch (err) {
    return { status: 'unavailable', note: `层 2 查询失败：${err.message}` };
  }
}
```

unavailable 时结果对象带 `layer2Note`（回执呈现降级原因）。scriptNo 由 `extractScriptNo(params.script)` 取（import 补）。

- [ ] **Step 4: 跑测试确认通过**（两文件全量）
- [ ] **Step 5: Commit** `feat(db-pro): 层2 scriptJudge 权威业务判定 + 连接配置接线`

---

### Task 7: R7 连接报错附可用列表（spec §8.1）

**Files:**
- Modify: `plugins/db-pro/engine/engine.js`
- Test: `tests/db-pro/engine.test.mjs`

**Interfaces:**
- Produces: `connError(name) → EngineError`（mustPool 与 scriptRun 共用；文案含可用连接或零连接提示）

- [ ] **Step 1: 写失败测试**

```js
it('未配置连接报错附可用列表（R7）', async () => {
  const dispatch = makeEngine(fakePoolSession([])); // 已有 c1
  await expect(dispatch('query', { connection: 'nope', sql: 'SELECT 1' })).rejects.toThrow(/当前可用：c1/);
});
it('零连接时提示去面板添加', async () => {
  const { dispatch } = createDispatcher(() => { throw new Error(); }, new Map());
  await expect(dispatch('query', { connection: 'x', sql: 'SELECT 1' })).rejects.toThrow(/当前无已配置连接/);
});
it('scriptRun 同样受益', async () => {
  const dispatch = makeEngine(fakePoolSession([]));
  await expect(dispatch('scriptRun', { connection: 'ghost', script: 'SELECT 1;' })).rejects.toThrow(/当前可用：c1/);
});
```

- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现**

```js
// R7（spec §8.1）：报错附可用连接，便于误用旧名自我纠错
function connError(name) {
  const reason = unavailable.get(name);
  const avail = [...pools.keys()];
  const tail = avail.length === 0 ? '当前无已配置连接——请到插件面板添加' : `当前可用：${avail.join('、')}`;
  return new EngineError(CODES.CONN, reason
    ? `连接 "${name}" 配置失败：${reason}`
    : `未配置的连接 "${name}"（${tail}）`);
}
```

mustPool 尾部与 scriptRun 头部的手写报错都改 `throw connError(name)`（scriptRun 保留其「请修正连接串后重试」语义即 reason 分支文案）。

- [ ] **Step 4: 跑测试确认通过**
- [ ] **Step 5: Commit** `feat(db-pro): 连接报错附可用连接列表（R7）`

---

### Task 8: scriptPrecheck 连库预检（spec §6，R4）

**Files:**
- Create: `plugins/db-pro/engine/precheck.js`
- Modify: `plugins/db-pro/engine/engine.js`（dispatch 增 case）
- Test: `tests/db-pro/precheck.test.mjs`（新建）

**Interfaces:**
- Consumes: pool.query（information_schema 只读查询）、splitter 语句集
- Produces: `runPrecheck(pool, statements, dialect) → { supported: boolean, note?: string, items: [{level: 'info'|'warn'|'high', code, message}] }`
- engine case：`scriptPrecheck { connection, script }` → assertPerm(name,'read') 后 `runPrecheck(...)`；非 mysql → `{ supported: false, note: '该方言暂不支持预检' }`

- [ ] **Step 1: 写失败测试**（假 pool.query 按 SQL 特征返回 canned information_schema 数据；样本表结构照 DAP_E 三表最小化）

```js
import { describe, it, expect } from 'vitest';
import { runPrecheck, extractInsertInfo } from '../../plugins/db-pro/engine/precheck.js';

// 假 pool：按 sql 关键特征路由
function fakePool(over) {
  return { query: async (sql) => {
    if (/information_schema\.TABLES/i.test(sql)) return over.tables;       // [[TABLE_NAME, TABLE_COLLATION], ...]
    if (/information_schema\.COLUMNS/i.test(sql)) return over.columns;     // [[COLUMN_NAME], ...]
    if (/information_schema\.STATISTICS/i.test(sql)) return over.stats;    // [[INDEX_NAME, COLUMN_NAME, NON_UNIQUE], ...]
    if (/COUNT\(\*\)/i.test(sql)) return over.counts.shift() ?? [[0]];     // [[n]]
    throw new Error('unexpected: ' + sql);
  } };
}

describe('extractInsertInfo（INSERT 解析纯函数）', () => {
  it('普通 INSERT：表/列/字面量元组', () => {
    const r = extractInsertInfo("INSERT INTO t (a, b, c) VALUES (1, 'x', NULL);");
    expect(r).toEqual({ table: 't', columns: ['a', 'b', 'c'], literals: ['1', "'x'", 'NULL'] });
  });
  it('含变量/函数 → literals 该位为 null（Review Focus 4）', () => {
    const r = extractInsertInfo('INSERT INTO t (a, b) VALUES (@v, NOW());');
    expect(r.literals).toEqual([null, null]);
  });
  it('无列清单 INSERT → columns null', () => {
    expect(extractInsertInfo('INSERT INTO t VALUES (1);').columns).toBeNull();
  });
});

describe('runPrecheck', () => {
  const STMTS = (arr) => arr.map((t, i) => ({ idx: i + 1, line: 1, text: t, keyword: t.split(' ')[0].toLowerCase(), cls: 'insert', tables: [extractInsertInfo(t)?.table].filter(Boolean) }));
  it('表缺失 → warn（顺序感知：脚本内先 CREATE 不算缺）', async () => {
    const pool = fakePool({ tables: { get: () => [[ 'existing' ]] } });
    // tables 用函数形态更简单：直接给 [[..]] 按表名过滤——实现 query 面向 information_schema WHERE TABLE_NAME IN (...)，
    // 测试 canned 返回存在的表名集合
  });
  // 按实现写四组：缺表 / 列不匹配（缺列+多列）/ UK 冲突 high / collation 不一致 warn
  it('UK 冲突预演：全 UK 列字面量齐备 → COUNT>0 报 high', async () => {
    const stmts = STMTS(["INSERT INTO t (uk1, uk2, v) VALUES ('a', 'b', 1)"]);
    const pool = fakePool({
      tables: [['t']],
      columns: [['uk1'], ['uk2'], ['v']],
      stats: [['PRIMARY', 'id', 0], ['UK_X', 'uk1', 0], ['UK_X', 'uk2', 0]],
      counts: [[1]],
    });
    const r = await runPrecheck(pool, stmts, 'mysql');
    const hit = r.items.find((x) => x.code === 'uk_conflict');
    expect(hit.level).toBe('high');
    expect(hit.message).toContain('t');
  });
  it('UK 列字面量不齐 → 静默跳过（Review Focus 4）', async () => {
    const stmts = STMTS(['INSERT INTO t (uk1, uk2, v) VALUES (@a, \'b\', 1)']);
    const pool = fakePool({ tables: [['t']], columns: [['uk1'], ['uk2'], ['v']],
      stats: [['UK_X', 'uk1', 0], ['UK_X', 'uk2', 0]], counts: [] });
    const r = await runPrecheck(pool, stmts, 'mysql');
    expect(r.items.some((x) => x.code === 'uk_conflict')).toBe(false);
  });
  it('非 mysql → supported false', async () => {
    const r = await runPrecheck(null, [], 'oracle');
    expect(r.supported).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**（precheck.js 不存在）

- [ ] **Step 3: 实现**（precheck.js 骨架——完整实现四检查）

```js
'use strict';
// 连库预检（spec 2026-11-20 §6，R4）：只读查询 information_schema + COUNT 探测。
// 全部产出分级 items，不阻断；MySQL 先行，其余方言显式不支持。
const PRECHECK_TIMEOUT_MS = 5_000;
const TABLE_CAP = 50; // 参与检查的目标表上限

// ── INSERT 静态解析（纯函数）──────────────────────────────────
// 返回 {table, columns|null, literals[]}：literals 每列一个，非字面量位为 null。
// 字面量形态：'str' / 数字 / NULL / TRUE / FALSE；其余（@var、函数、表达式）= null。
function extractInsertInfo(text) {
  const m = String(text).match(/insert\s+into\s+([A-Za-z0-9_$."`[\]]+)\s*(\(([^()]*(?:\([^()]*\)[^()]*)*)\))?\s*values\s*\(/i);
  if (!m) return null;
  const table = m[1].replace(/["`[\]]/g, '').split('.').pop();
  let columns = null;
  if (m[3]) columns = m[3].split(',').map((c) => c.trim().replace(/["`]/g, ''));
  // 取 VALUES 后第一个顶层元组
  const vIdx = String(text).toLowerCase().indexOf('values');
  const tail = String(text).slice(vIdx);
  const open = tail.indexOf('(');
  if (open < 0) return { table, columns, literals: null };
  let depth = 0, end = -1;
  for (let i = open; i < tail.length; i += 1) {
    const c = tail[i];
    if (c === '(') depth += 1;
    else if (c === ')') { depth -= 1; if (depth === 0) { end = i; break; } }
  }
  if (end < 0) return { table, columns, literals: null };
  const tuple = tail.slice(open + 1, end);
  const literals = splitTopLevel(tuple).map((v) => {
    const t = v.trim();
    if (/^'(?:[^']|'')*'$/.test(t) || /^-?\d+(\.\d+)?$/.test(t) || /^(NULL|TRUE|FALSE)$/i.test(t)) return t;
    return null;
  });
  return { table, columns, literals };
}

function splitTopLevel(s) {
  const out = []; let depth = 0, cur = '', q = null;
  for (const c of s) {
    if (q) { cur += c; if (c === q) q = null; continue; }
    if (c === "'" ) { q = c; cur += c; continue; }
    if (c === '(') depth += 1;
    if (c === ')') depth -= 1;
    if (c === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim() !== '') out.push(cur);
  return out;
}
```

`runPrecheck(pool, statements, dialect)`：
1. 非 mysql → `{ supported: false, note: '该方言暂不支持预检' }`
2. 收集目标表（inferTables 并集，cap 50）+ 脚本内 CREATE TABLE 名集（顺序感知）
3. 查 `information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (...)` → 存在表集 + collation 映射；缺表（不在库也不在 CREATE 集）→ `{level:'warn', code:'table_missing'}`
4. 查 `information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (...)` → 列集；对每条 INSERT（含 procedure 语句文本内全局 `extractInsertInfo` 扫描——用 `text.match(/insert\s+into[^;]+/gi)` 逐段）列匹配：columns 有值才查（无列清单跳过）；缺列/未知列 → `{level:'warn', code:'column_mismatch'}`（message 列出明细）
5. 查 `information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (...)` → 每表 UK 组（NON_UNIQUE=0 含 PRIMARY）；对每 INSERT：UK 组全列在 literals 有字面量 → `SELECT COUNT(*) FROM t WHERE col1 = lit1 AND col2 = lit2`（lit 为字符串时参数化转义：`'x'` → 值单引号双写；标识符走白名单正则）→ COUNT>0 → `{level:'high', code:'uk_conflict'}`
6. collation：`SELECT @@collation_database` vs TABLES.TABLE_COLLATION → 不一致 → `{level:'warn', code:'collation_mismatch'}`
7. 每步 try/catch：单项查询失败 → `{level:'info', code:'skipped', message: '...预检跳过：...'}`；总时长硬顶 30s（Date.now 差值检查）

engine.js dispatch 增：

```js
case 'scriptPrecheck': {
  assertPerm(params.connection, 'read');
  const handle = pools.get(params.connection);
  if (!handle) throw connError(params.connection);
  const { statements } = splitStatements(params.script, dialectOfUrl(handle.url));
  return await runPrecheck(handle.pool, statements, dialectOfUrl(handle.url));
}
```

- [ ] **Step 4: 跑测试确认通过**
- [ ] **Step 5: Commit** `feat(db-pro): scriptPrecheck 连库预检（表/列/UK/collation，R4）`

---

### Task 9: service 接线——dryrun 并入预检 + 历史落账扩展（spec §3/§7.1）

**Files:**
- Modify: `plugins/db-pro/service/index.js`（scriptState 增 precheck 依赖）
- Modify: `plugins/db-pro/service/script-state.js`
- Test: `tests/db-pro/script-state.test.mjs`

**Interfaces:**
- Consumes: Task 8 `scriptPrecheck` rpc
- Produces: scriptState deps 增 `precheck: async (connection, script) → precheckResult`（出错时 service 层捕获 → `{ supported: false, note: '预检跳过：连接不可达（...）' }`）
- Produces: dryrun 回执 `{ dryrun: true, statements, warnings, summary, scriptNo, precheck: { ran: boolean, supported, note?, items? } }`
- Produces: history 条目增 `businessStatus`/`businessError` 字段（从 result 透传）

- [ ] **Step 1: 写失败测试**

```js
it('dryrun 并入 precheck items（默认开启）', async () => {
  const state = makeState({ precheck: async () => ({ supported: true, items: [{ level: 'high', code: 'uk_conflict', message: 't 与已存在记录冲突' }] }) });
  const r = await state.submit({ connection: 'c1', sessionId: 's', script: 'INSERT INTO t VALUES (1);', dryrun: true });
  expect(r.precheck.ran).toBe(true);
  expect(r.precheck.items[0].code).toBe('uk_conflict');
});
it('precheck 抛错（连接不可达）→ 降级提示不阻断', async () => {
  const state = makeState({ precheck: async () => { throw new Error('引擎请求超时'); } });
  const r = await state.submit({ connection: 'c1', sessionId: 's', script: 'INSERT INTO t VALUES (1);', dryrun: true });
  expect(r.precheck.ran).toBe(false);
  expect(r.precheck.note).toContain('预检跳过');
  expect(r.statements.length).toBe(1); // 静态部分仍在
});
it('history 携带 businessStatus', async () => {
  // 走完 approve→status→executed 的既有用例范式；run 返回 { ok: true, businessStatus: 'failed', businessError: '[FAIL] x', ... }
  // 断言 history()[0].businessStatus === 'failed' 且 businessError 含 [FAIL]
});
```

- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现**

service/index.js scriptState deps 增：

```js
precheck: async (connection, script) => {
  if (!child) throw new Error('db-pro 引擎未就绪');
  return await rpc('scriptPrecheck', { connection, script }, 35_000);
},
```

script-state.js submit dryrun 分支改：

```js
if (p.dryrun === true) {
  let precheck = { ran: false, note: '预检跳过：未执行' };
  try {
    const pc = await precheck(connection, script);
    precheck = { ran: true, ...pc };
  } catch (err) {
    precheck = { ran: false, note: `预检跳过：${err.message}` };
  }
  return { dryrun: true, statements: analysis.statements, warnings: analysis.warnings, summary: analysis.summary, scriptNo: analysis.scriptNo, precheck };
}
```

（deps 解构增 `precheck`，缺省 `async () => { throw new Error('precheck 未注入'); }`。）history map 增两字段：

```js
businessStatus: e.result?.businessStatus ?? null,
businessError: e.result?.businessError ?? null,
```

append executed/failed 落账已带全量 result，无需改。

- [ ] **Step 4: 跑测试确认通过**
- [ ] **Step 5: Commit** `feat(db-pro): dryrun 并入连库预检 + 历史携带业务状态`

---

### Task 10: tools 回执与描述（spec §8.4）

**Files:**
- Modify: `plugins/db-pro/tools/index.js`
- Test: `tests/db-pro/tools.test.mjs`

**Interfaces:**
- Consumes: script_status result v2（businessStatus/businessError/verification/results[].kind/outputs）、dryrun precheck 块
- Produces: render 文案（见测试断言）；DEFS 两处描述更新

- [ ] **Step 1: 写失败测试**

```js
it('script_status executed：摘要行区分语句/业务 + 逐条明细 + 核验', () => {
  const out = render('script_status', { status: 'executed', result: {
    ok: true, total: 8, executed: 8, durationMs: 1200,
    businessStatus: 'failed', businessSource: 'layer1_marker',
    businessError: '[FAIL] S00971511 -- [23000] Duplicate entry',
    results: [{ idx: 3, line: 10, kind: 'call', status: 'ok', affectedRows: 0, durationMs: 500,
      outputs: [{ columns: ['execution_status'], rows: [['[FAIL] S00971511 -- [23000] Duplicate entry']] }] }],
    verification: [{ table: 'DAP_E_MCP_TOOL', before: 18, after: 23, delta: 5 }],
  } });
  expect(out).toContain('语句 8/8 成功');
  expect(out).toContain('业务结果：失败');
  expect(out).toContain('[23000]');
  expect(out).toContain('#3 call');
  expect(out).toContain('DAP_E_MCP_TOOL: +5 (18→23)');
  expect(out).toContain('参考值');
});
it('script_status executed 业务成功（层2）', () => {
  const out = render('script_status', { status: 'executed', result: {
    ok: true, total: 8, executed: 8, durationMs: 100, businessStatus: 'ok', businessSource: 'layer2_logtable',
    results: [], verification: [] } });
  expect(out).toContain('业务结果：成功');
  expect(out).toContain('日志表');
});
it('dryrun 回执呈现 precheck 分级项', () => {
  const out = render('script_execute', { dryrun: true, statements: [], summary: { statementCount: 1, counts: {}, tables: [] },
    scriptNo: 'S1', precheck: { ran: true, supported: true, items: [{ level: 'high', code: 'uk_conflict', message: 't 冲突' }] } });
  expect(out).toContain('[high]');
  expect(out).toContain('t 冲突');
});
it('工具描述含业务判定与预检说明', () => {
  const defs = DEFS(); // 或经 createTools({ callService }).getDefs()
  const se = defs.find((d) => d.name === 'script_execute');
  expect(se.description).toContain('业务');
  expect(se.description).toContain('预检');
});
```

- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现**（render/script_status executed 分支重写 + dryrun 分支 + 两处 description；明细最多列 30 条 + 溢出行「…共 N 条」；outputs 单元格截 120 字）
- [ ] **Step 4: 跑测试确认通过**（tools.test.mjs 全量——旧 render 断言按 C9 同步）
- [ ] **Step 5: Commit** `feat(db-pro): script 回执区分语句/业务结果 + 预检分级呈现`

---

### Task 11: ~~面板「脚本判定」高级区~~（**C10 取消——层 2 整体不做，2026-11-20 执行期裁定**）

**Files:**
- Create: `.omo/previews/db-pro-script-judge.html`（momo-studio 仓，静态预览）
- Modify: `plugins/db-pro/panel/index.html`
- Test: 无面板单测（沿 B 期惯例）；真机验收在 Task 13

**Interfaces:**
- Consumes: Task 6 store scriptJudge（listProjection 透出回填；connectionsUpdate patch.scriptJudge）

- [ ] **Step 1: 静态预览**——按 B 期预览范式做「编辑抽屉 + 可折叠『脚本判定』区（七字段 + 说明文案）」静态 HTML，**交用户确认后**再动 panel（P1 门禁；用户口头确认即记录于 commit message）
- [ ] **Step 2: 实现**——panel/index.html 编辑抽屉权限 fieldset 后加：

```html
<details class="advanced" id="judge-group" style="margin-top:10px">
  <summary style="cursor:pointer;color:var(--text-secondary)">脚本判定（可选：业务成功权威判定）</summary>
  <div class="form-grid">
    <label>执行日志表<input name="logTable" placeholder="DAP_E_SCRIPT_EXECUTION_LOG"/></label>
    <label>脚本号列<input name="scriptNoColumn" placeholder="SCRIPT_NO"/></label>
    <label>状态列<input name="statusColumn" placeholder="EXECUTION_STATUS"/></label>
    <label>成功状态值<input name="okValue" placeholder="1"/></label>
    <label>错误列（可选）<input name="errorColumn" placeholder="ERROR_MESSAGE"/></label>
    <label>排序列（可选）<input name="sortColumn" placeholder="ID"/></label>
    <label>失败标记正则（默认 ^\[FAIL\]）<input name="failPattern" placeholder="^\[FAIL\]"/></label>
  </div>
  <p class="hint">四项必填（日志表/脚本号列/状态列/成功值）启用权威判定；失败标记正则独立生效。</p>
</details>
```

（样式类沿用面板既有 form-grid/hint；保存时组装 `scriptJudge` 对象——logTable 为空则不发送该字段即清除配置；编辑回填自 listProjection。）
- [ ] **Step 3: 手动冒烟**——dev app `window.api.plugin.reload('db-pro')` 后：建连接配 scriptJudge → 保存 → 重开抽屉回填正确；清空保存 → listProjection 无 scriptJudge
- [ ] **Step 4: Commit** `feat(db-pro): 连接面板新增脚本判定高级区（层2 配置入口）`

---

### Task 12: 样本 fixtures + 集成测试（spec §9）

**Files:**
- Create: `tests/db-pro/fixtures/db-tool-sample/{01..05}.sql`（自 `/Users/stbearangel/Desktop/momo-studio-需求/db工具优化-文档与样本数据包/db-tool-sample/` 拷贝 01/02/03/04/05）
- Create: `tests/db-pro/business-result.integration.test.mjs`

**Interfaces:**
- Consumes: engine createDispatcher（真实 driver + pools 注入：`dispatch('configure', { connections: [{ name: 'dape', url: DBPRO_MYSQL 精确到 db_tool_sample 库, permissions: 全 8 位, scriptJudge: {...} }] })`）
- 场景建库：`DROP DATABASE IF EXISTS db_tool_sample; CREATE DATABASE db_tool_sample CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;` + 执行 01/02（splitStatements 切分后逐条 session.exec 或 pool.query——集成直接 pool.query 逐条）

- [ ] **Step 1: 拷贝 fixtures**（原样拷贝，不改内容；01/02 为建现场，03/04/05 为被测脚本）
- [ ] **Step 2: 写集成测试**（沿用 integration.test.mjs 的端口探测门控范式）

```js
// 场景矩阵（每场景独立 describe；库级 beforeEach 重建现场保证隔离）
// 1. 基线 03：scriptRun → ok、businessStatus 'ok'（层2 判定 STATUS=1）、verification
//    含三表 delta 3/5/5、日志表最新行 STATUS=1
// 2. P0 04：scriptRun 语句全 ok、businessStatus 'failed'、businessError 含 [FAIL] 与 23000
//    （层2 与层1 双源一致）、verification delta 0
// 3. 吞错 05：businessStatus 'failed'、businessError 含 '[?] Unknown error'、
//    scriptAnalyze warnings 含 handler_order
// 4. R3 05：执行期无 'Illegal mix of collations'（结果全部语句 ok——collation 已自动对齐，
//    失败只来自 handler 捕获的业务错误）
// 5. R4 04 dryrun：scriptPrecheck items 含 code 'uk_conflict' level 'high'，message 含 91022 相关表
// 6. R4 列匹配：构造 'INSERT INTO DAP_E_MCP_ENDPOINT (BAD_COL) ...' 单句脚本 → column_mismatch warn
// 7. R7：dispatch('query', { connection: '不存在', ... }) 拒绝且文案含 'dape'
```

断言要点：04 场景须先 02 灌数（91115/90045 已存在）才构成 UK 冲突；层 2 scriptJudge 配 `{ logTable: 'DAP_E_SCRIPT_EXECUTION_LOG', scriptNoColumn: 'SCRIPT_NO', statusColumn: 'EXECUTION_STATUS', errorColumn: 'ERROR_MESSAGE', okValue: '1', sortColumn: 'ID' }`（注意 01 DDL 里日志表若有自增主键则 sortColumn 可省——按 fixture 实际 DDL 定，写测试前先读 01）。

- [ ] **Step 3: 跑集成**（docker compose 起四库后 `DBPRO_INTEGRATION=1 NODE_OPTIONS=--openssl-legacy-provider npx vitest run tests/db-pro/business-result.integration.test.mjs`）
- [ ] **Step 4: 全量回归**——`npx vitest run tests/db-pro/`：旧 190+30 保持绿；受 affectedRows/回执形状影响的旧断言按 C9 如实同步（预计 script-session/e2e/tools 三处）
- [ ] **Step 5: Commit** `test(db-pro): 样本包集成回归（基线/UK冲突/吞错/collation/预检/R7 全场景）`

---

### Task 13: README + 真机验收（spec §9.4）

**Files:**
- Modify: `plugins/db-pro/README.md`
- Create: `.omo/qa-reports/2026-11-20-db-pro-c-acceptance/report.md`（momo-studio 仓）

- [ ] **Step 1: README 增「业务成功判定」（双层机制/配置法/优先级）与「执行预检」（四检查/分级/方言支持）两节**
- [ ] **Step 2: 真机验收（momo-acceptance 流程）**——dev app + CDP：
  - 面板：连接编辑「脚本判定」高级区配置 DAP-E 四项 → 截图
  - 会话内 `script_execute`（04 场景，docker 库现场已建）→ 审批 → `script_status` 回执截图（业务失败 + [FAIL][23000] + verification）
  - `script_execute dryrun`（04）→ 预检 high 冲突项截图
  - 报告落 `.omo/qa-reports/2026-11-20-db-pro-c-acceptance/`（含 R1–R7 对勾表）
- [ ] **Step 3: 汇报**——分支推远端（`git push -u origin feat/db-pro-business-result`），等用户裁定合并 main（不自行合并）

---

## Self-Review 记录

1. **Spec 覆盖**：R1(§4 T4/T6) R2(§4.1 T2/T4/T10) R3(§5 T3) R4(§6 T8/T9) R5(§7.1 T4/T10) R6(§7.2 T5/T10) R7(§8.1 T7) 面板(§8.2 T11) 数据(§8.3 T6) 文案(§8.4 T10/T13) 测试(§9 T12/T13)——无缺口
2. **占位符**：无 TBD；Task 5/8 中标「实际实现」处的代码为最终形态
3. **类型一致**：session 契约 v2（exec→{affectedRows,outputs?}/count/finish/close）跨 T2/T3/T4/T5 一致；scriptRun 返回 v2 字段跨 T4/T5/T6/T9/T10 一致；scriptJudge 七字段跨 T6/T11 一致
4. **Review Focus**：六项全部有锁定任务测试（见表）
5. **已知 spec 修订**：okValue 由「缺省可判」改为「必填」（Task 6 内执行时同步改 spec §8.2 该句）
