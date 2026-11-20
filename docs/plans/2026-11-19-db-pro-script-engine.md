# db-pro 通用脚本执行引擎（A 期）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans（用户裁定：主会话直做，**不委派子 agent**）。Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 db-pro 增加引擎中立的 SQL 脚本执行通道（四库切分 profile + 逐条顺序执行 + 脚本级人工批准 + dry-run + 执行历史），使 DAP-E 种子脚本模板可在插件内完整执行。

**Architecture:** 切分器与分类器为纯函数模块（`engine/script-splitter.js`），运行于 db-engine 子进程；引擎新增 `scriptAnalyze` / `scriptRun` 两个 RPC op，`scriptRun` 取池内专用连接（驱动新增 `openSession()`）逐条执行；service 以「提交 → 人工批准 → 后台作业 → `script_status` 轮询」编排（仿 `write-state.js`），执行历史落 `script-history.jsonl`。

**Tech Stack:** Node 24（CJS）、纯 JS 驱动（mysql2 / pg / oracledb / dmdb）、vitest、NDJSON JSON-RPC 子进程协议。

**Spec:** `docs/specs/2026-11-19-db-pro-script-engine-and-connection-panel-design.md`（§5 全篇 + D13）

## Global Constraints

- Node 24 LTS；插件代码 CommonJS（`'use strict'`，`module.exports`）。
- **零外部依赖**：切分器纯 JS 自研，禁止引入 SQL parser 包或外部 CLI（mysql/psql/sqlplus/disql）。
- 测试：`cd /Users/stbearangel/dev/AiProject/momo-plugin && npx vitest run tests/db-pro/<file>`；四库集成门控 `DBPRO_INTEGRATION=1 NODE_OPTIONS=--openssl-legacy-provider`（docker compose 在 `../momo-plugin/tests/docker/docker-compose.yml`）。
- **不硬编码任何业务表名/脚本号语义**（D3）：幂等归脚本自己；`@__script_no` 仅作展示与历史索引。
- 不强制外层事务（D5）；专用连接独占整脚本（D6）；不阻塞单次调用——后台作业 + `script_status`（D13）。
- 工具调用桥上限 60s：`script_execute` / `script_status` 必须立即返回。
- Conventional Commits；中文注释；**不得改任何 package.json 版本号**。
- 提交只在用户要求时执行（本计划中每任务的 `git commit` 步骤保留为纪律步骤，实际执行前以用户指令为准）。

## Review Focus

以下五类输入/失败模式最可能咬到真实使用者，每个都必须有对应任务的测试钉住：

1. **MySQL 存储过程模板（`DELIMITER //` + 体内分号 + 事务）**——切分器不得在过程体内截断；二次执行必须由脚本自身幂等整体 SKIP。
2. **Oracle/DM PL/SQL 块深度**——嵌套 `IF/LOOP/CASE`、`END IF`/`END LOOP`、字符串字面量里的 `END;` 不得误切；匿名块与 `CREATE PROCEDURE` 都要正确。
3. **会话提交语义**——Oracle/DM 非自动提交：成功结束必须 COMMIT（否则写静默蒸发）、失败必须 ROLLBACK；MySQL/PG 自动提交不做收尾（原生 CLI 语义）。
4. **审批重放**——同一 `requestId` 的 `script_status` 被多次调用，脚本至多执行一次；执行中断后返回 `exec_unknown` 而不是重跑。
5. **长脚本与 60s 桥**——批准后脚本在后台跑；轮询恒为短返回；整脚本超时中止并返回已完成部分。

---

### Task 1: 切分器核心（引号 / 注释 / 分号 / 行号）

**Files:**
- Create: `plugins/db-pro/engine/script-splitter.js`
- Test: `tests/db-pro/script-splitter.test.mjs`

**Interfaces:**
- Produces: `splitStatements(script: string, dialect: string) → { statements: Array<{idx:number, line:number, text:string, keyword:string}>, warnings: Array<{line:number, type:string, message:string}> }`；`class SplitterError extends Error { line: number }`。

- [ ] **Step 1: 写失败测试**

```js
// tests/db-pro/script-splitter.test.mjs
import { describe, it, expect } from 'vitest';
import m from '../../plugins/db-pro/engine/script-splitter.js';
const { splitStatements, SplitterError } = m;

describe('splitStatements · 基础切分', () => {
  it('两条语句按分号切分，行号/首词正确', () => {
    const r = splitStatements('SELECT 1;\nSELECT 2;', 'mysql');
    expect(r.statements.map((s) => s.text)).toEqual(['SELECT 1', 'SELECT 2']);
    expect(r.statements.map((s) => s.line)).toEqual([1, 2]);
    expect(r.statements.map((s) => s.keyword)).toEqual(['select', 'select']);
    expect(r.statements.map((s) => s.idx)).toEqual([1, 2]);
  });
  it('字符串与注释里的分号不切分', () => {
    const r = splitStatements("SELECT 'a;b', 2 -- x;y\n;", 'mysql');
    expect(r.statements).toHaveLength(1);
    expect(r.statements[0].text).toContain("'a;b'");
  });
  it('块注释跨行 + 尾语句无分号容忍', () => {
    const r = splitStatements('/* a;\nb */ SELECT 1', 'mysql');
    expect(r.statements.map((s) => s.text)).toEqual(['SELECT 1']);
  });
  it('未闭合单引号 → SplitterError 带行号', () => {
    try {
      splitStatements("SELECT 'oops", 'mysql');
      expect.unreachable('应当抛错');
    } catch (err) {
      expect(err).toBeInstanceOf(SplitterError);
      expect(err.line).toBe(1);
      expect(err.message).toContain('未闭合');
    }
  });
  it('空脚本 / 纯注释 → 0 条语句', () => {
    expect(splitStatements('', 'mysql').statements).toEqual([]);
    expect(splitStatements('-- hi\n/* x */', 'mysql').statements).toEqual([]);
  });
  it('未知方言拒绝', () => {
    expect(() => splitStatements('SELECT 1', 'sqlite')).toThrow(/不支持的脚本方言/);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /Users/stbearangel/dev/AiProject/momo-plugin && npx vitest run tests/db-pro/script-splitter.test.mjs`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现最小切分器**

```js
// plugins/db-pro/engine/script-splitter.js
'use strict';
// 通用 SQL 脚本切分器（spec 2026-11-19 §5.2）：引擎中立 tokenizer + 每库 profile。
// 纯函数模块——不依赖驱动/协议；engine（执行）与 service（dry-run/审批摘要）共用。

class SplitterError extends Error {
  constructor(message, line) {
    super(message);
    this.name = 'SplitterError';
    this.line = line;
  }
}

const DIALECTS = new Set(['mysql', 'postgres', 'postgresql', 'oracle', 'dm', 'dameng']);

function normalizeDialect(raw) {
  const d = String(raw ?? 'mysql');
  if (d === 'postgresql') return 'postgres';
  if (d === 'dameng') return 'dm';
  if (!DIALECTS.has(d)) throw new SplitterError(`不支持的脚本方言 "${d}"`, 1);
  return d;
}

function firstKeyword(text) {
  const m = String(text).trim().match(/^[A-Za-z]+/);
  return m ? m[0].toLowerCase() : '';
}

function splitStatements(scriptRaw, dialectRaw) {
  const dialect = normalizeDialect(dialectRaw);
  const src = String(scriptRaw ?? '');
  const statements = [];
  const warnings = [];
  let buf = '';
  let line = 1;
  let stmtLine = 1;
  let quote = null; // ' | " | `
  let blockComment = false;
  let lineComment = false;
  let atLineStart = true;

  function flush() {
    const text = buf.trim();
    buf = '';
    if (text !== '') {
      statements.push({ idx: statements.length + 1, line: stmtLine, text, keyword: firstKeyword(text) });
    }
  }

  function markStartIfNeeded(c) {
    if (buf.trim() === '' && !/\s/.test(c)) stmtLine = line;
  }

  for (let i = 0; i < src.length; i += 1) {
    const c = src[i];
    const next = src[i + 1];

    if (c === '\n') {
      buf += c;
      line += 1;
      atLineStart = true;
      lineComment = false;
      continue;
    }

    if (quote === null && !blockComment && !lineComment) {
      markStartIfNeeded(c);
      // 行注释（-- 后须空白/行尾；MySQL 语法）与 MySQL # 注释
      if (c === '-' && next === '-') {
        const after = src[i + 2];
        if (after === undefined || /\s/.test(after)) {
          lineComment = true;
          buf += c;
          continue;
        }
      }
      if (dialect === 'mysql' && c === '#') {
        lineComment = true;
        buf += c;
        continue;
      }
      if (c === '/' && next === '*') {
        blockComment = true;
        buf += c;
        continue;
      }
    }

    if (lineComment) { buf += c; continue; }

    if (blockComment) {
      buf += c;
      if (c === '*' && next === '/') { buf += next; i += 1; blockComment = false; }
      continue;
    }

    if (quote !== null) {
      buf += c;
      if (dialect === 'mysql' && c === '\\' && quote !== '`') {
        if (next !== undefined) { buf += next; i += 1; }
        continue;
      }
      if (c === quote) {
        if (next === quote) { buf += next; i += 1; continue; } // 双写转义
        quote = null;
      }
      continue;
    }

    if (c === "'" || c === '"' || (dialect === 'mysql' && c === '`')) {
      quote = c;
      buf += c;
      atLineStart = false;
      continue;
    }

    if (c === ';') {
      flush();
      atLineStart = false;
      continue;
    }

    buf += c;
    atLineStart = false;
  }

  if (quote !== null) throw new SplitterError(`第 ${line} 行：${quote} 引号未闭合`, line);
  if (blockComment) throw new SplitterError(`第 ${line} 行：块注释未闭合`, line);
  flush();
  return { statements, warnings };
}

function summarize(statements) {
  const counts = {};
  const tables = [];
  for (const s of statements) {
    const cls = s.cls ?? 'unknown';
    counts[cls] = (counts[cls] ?? 0) + 1;
    for (const t of s.tables ?? []) if (!tables.includes(t)) tables.push(t);
  }
  return { statementCount: statements.length, counts, tables };
}

function extractScriptNo(scriptRaw) {
  const m = String(scriptRaw ?? '').match(/@__script_no\s*=\s*'([^']+)'/i)
    ?? String(scriptRaw ?? '').match(/SCRIPT_NO\s*[:=]\s*([A-Za-z0-9_.-]+)/i);
  return m ? m[1] : null;
}

module.exports = { splitStatements, summarize, extractScriptNo, firstKeyword, SplitterError };
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd /Users/stbearangel/dev/AiProject/momo-plugin && npx vitest run tests/db-pro/script-splitter.test.mjs`
Expected: PASS（6 用例）

- [ ] **Step 5: 提交**

```bash
cd /Users/stbearangel/dev/AiProject/momo-plugin
git add plugins/db-pro/engine/script-splitter.js tests/db-pro/script-splitter.test.mjs
git commit -m "feat(db-pro): 脚本切分器核心（引号/注释/分号/行号）"
```

---

### Task 2: MySQL `DELIMITER` 指令

**Files:**
- Modify: `plugins/db-pro/engine/script-splitter.js`
- Test: `tests/db-pro/script-splitter.test.mjs`（追加）

**Interfaces:**
- Consumes: Task 1 的 `splitStatements`。
- Produces: `DELIMITER <tok>` 行切换终结符（多字符，如 `//`）；指令行本身不产出语句。

- [ ] **Step 1: 写失败测试（真实 DAP-E 模板形态）**

```js
describe('splitStatements · MySQL DELIMITER', () => {
  it('过程体内的分号不切分，DELIMITER 切到 // 后再切回 ;', () => {
    const script = [
      "SET @__script_no = 'S00971511';",
      'DELIMITER //',
      'CREATE PROCEDURE p_demo()',
      'BEGIN',
      '  INSERT INTO t VALUES (1);',
      '  INSERT INTO t VALUES (2);',
      'END //',
      'DELIMITER ;',
      'CALL p_demo();',
    ].join('\n');
    const r = splitStatements(script, 'mysql');
    expect(r.statements).toHaveLength(3);
    expect(r.statements[0].keyword).toBe('set');
    expect(r.statements[1].keyword).toBe('create');
    expect(r.statements[1].text).toContain('INSERT INTO t VALUES (2);');
    expect(r.statements[1].text.trim().endsWith('END')).toBe(true);
    expect(r.statements[2].keyword).toBe('call');
    expect(r.statements[1].line).toBe(3);
  });
  it('DELIMITER 行本身不产出语句', () => {
    const r = splitStatements('DELIMITER //\nSELECT 1//\nDELIMITER ;\nSELECT 2;', 'mysql');
    expect(r.statements.map((s) => s.text)).toEqual(['SELECT 1', 'SELECT 2']);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /Users/stbearangel/dev/AiProject/momo-plugin && npx vitest run tests/db-pro/script-splitter.test.mjs`
Expected: FAIL（过程体被切成多条）

- [ ] **Step 3: 实现 DELIMITER 行识别与多字符终结符**

在 `splitStatements` 内、进入字符循环前加入状态与行首判定：

```js
  let terminator = ';';
  // 行首 DELIMITER 判定（仅 MySQL；要求当前缓冲无实质内容——指令独立成行）
  function tryDelimiterDirective(at) {
    if (dialect !== 'mysql' || !atLineStart || buf.trim() !== '') return -1;
    const rest = src.slice(at);
    const m = rest.match(/^delimiter[ \t]+(\S+)[ \t]*\r?\n?/i);
    if (!m) return -1;
    terminator = m[1];
    return at + m[0].length - 1;
  }
```

把 `atLineStart = true` 的处理改为：换行后若命中指令则跳到指令行尾：

```js
    if (c === '\n') {
      buf += c;
      line += 1;
      atLineStart = true;
      lineComment = false;
      continue;
    }

    if (atLineStart && buf.trim() === '') {
      const skipTo = tryDelimiterDirective(i);
      if (skipTo >= 0) {
        // 指令行整行消费；行号按消费内容推进
        const consumed = src.slice(i, skipTo + 1);
        line += (consumed.match(/\n/g) ?? []).length;
        i = skipTo;
        atLineStart = true;
        continue;
      }
    }
```

终结符判定处改为多字符匹配：

```js
    if (src.startsWith(terminator, i)) {
      flush();
      i += terminator.length - 1;
      atLineStart = false;
      continue;
    }
```

（删除原 `if (c === ';')` 分支。）

- [ ] **Step 4: 跑测试确认通过（含 Task 1 回归）**

Run: `cd /Users/stbearangel/dev/AiProject/momo-plugin && npx vitest run tests/db-pro/script-splitter.test.mjs`
Expected: PASS（8 用例）

- [ ] **Step 5: 提交**

```bash
cd /Users/stbearangel/dev/AiProject/momo-plugin
git add plugins/db-pro/engine/script-splitter.js tests/db-pro/script-splitter.test.mjs
git commit -m "feat(db-pro): 切分器支持 MySQL DELIMITER 指令"
```

---

### Task 3: PostgreSQL 美元引用与元命令拒绝

**Files:**
- Modify: `plugins/db-pro/engine/script-splitter.js`
- Test: `tests/db-pro/script-splitter.test.mjs`（追加）

**Interfaces:**
- Produces: PG profile——`$tag$…$tag$` 块内不切分；行首 `\` 元命令抛 `SplitterError`。

- [ ] **Step 1: 写失败测试**

```js
describe('splitStatements · PostgreSQL profile', () => {
  it('CREATE FUNCTION $$ 体内分号不切分', () => {
    const script = [
      'CREATE FUNCTION f_demo() RETURNS void AS $$',
      'BEGIN',
      '  INSERT INTO t VALUES (1);',
      'END;',
      '$$ LANGUAGE plpgsql;',
      'SELECT f_demo();',
    ].join('\n');
    const r = splitStatements(script, 'postgres');
    expect(r.statements).toHaveLength(2);
    expect(r.statements[0].keyword).toBe('create');
    expect(r.statements[1].keyword).toBe('select');
  });
  it('带标签的美元引用 $body$ 正常闭合', () => {
    const r = splitStatements('DO $body$ BEGIN PERFORM 1; END $body$;\nSELECT 1;', 'postgresql');
    expect(r.statements).toHaveLength(2);
  });
  it('行首反斜杠元命令 → 明确拒绝', () => {
    expect(() => splitStatements('\\i /tmp/a.sql\nSELECT 1;', 'postgres'))
      .toThrow(/psql 元命令/);
  });
  it('未闭合美元引用 → 报错', () => {
    expect(() => splitStatements('CREATE FUNCTION f() AS $$ BEGIN RETURN;', 'postgres'))
      .toThrow(/美元引用/);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /Users/stbearangel/dev/AiProject/momo-plugin && npx vitest run tests/db-pro/script-splitter.test.mjs`
Expected: FAIL

- [ ] **Step 3: 实现美元引用与元命令拒绝**

新增状态 `let dollarTag = null;`，并在引号判定之前插入：

```js
    if (dialect === 'postgres' && atLineStart && buf.trim() === '' && c === '\\') {
      throw new SplitterError(`第 ${line} 行：不支持 psql 元命令（\\...）——请将目标文件内容内联为 SQL`, line);
    }

    if (dialect === 'postgres' && dollarTag === null && c === '$') {
      const m = src.slice(i).match(/^\$([A-Za-z_][A-Za-z0-9_]*)?\$/);
      if (m) {
        dollarTag = m[0];
        buf += m[0];
        i += m[0].length - 1;
        atLineStart = false;
        continue;
      }
    }

    if (dollarTag !== null) {
      if (src.startsWith(dollarTag, i)) {
        buf += dollarTag;
        i += dollarTag.length - 1;
        dollarTag = null;
        atLineStart = false;
        continue;
      }
      buf += c;
      atLineStart = false;
      continue;
    }
```

收尾校验追加：

```js
  if (dollarTag !== null) throw new SplitterError(`第 ${line} 行：美元引用 ${dollarTag} 未闭合`, line);
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd /Users/stbearangel/dev/AiProject/momo-plugin && npx vitest run tests/db-pro/script-splitter.test.mjs`
Expected: PASS（12 用例）

- [ ] **Step 5: 提交**

```bash
cd /Users/stbearangel/dev/AiProject/momo-plugin
git add plugins/db-pro/engine/script-splitter.js tests/db-pro/script-splitter.test.mjs
git commit -m "feat(db-pro): 切分器支持 PG 美元引用与元命令拒绝"
```

---

### Task 4: Oracle / DM profile（PL/SQL 深度 + `/` + 指令处置 + EXEC 包装）

**Files:**
- Modify: `plugins/db-pro/engine/script-splitter.js`
- Test: `tests/db-pro/script-splitter.test.mjs`（追加）

**Interfaces:**
- Produces: oracle/dm profile——`;` 仅在块深度 0 终结；独行 `/` 终结；过滤 `SET/PROMPT/SHOW/CLEAR/DEFINE/UNDEFINE/SPOOL`（warning）；拒绝 `EXIT/QUIT/WHENEVER/HOST/START/@`；`EXEC <expr>` 包装为 `BEGIN <expr>; END;`。

- [ ] **Step 1: 写失败测试**

```js
describe('splitStatements · Oracle/DM profile', () => {
  const oracleScript = [
    'SET SERVEROUTPUT ON',
    'CREATE OR REPLACE PROCEDURE p_demo AS',
    '  v NUMBER := 0;',
    'BEGIN',
    '  IF v = 0 THEN',
    '    INSERT INTO t VALUES (1);',
    '  ELSE',
    '    LOOP',
    '      v := v + 1;',
    '      EXIT WHEN v > 2;',
    '    END LOOP;',
    '  END IF;',
    'END;',
    '/',
    'EXEC p_demo',
    'COMMIT;',
  ].join('\n');

  it('过程体内分号不切分；独行 / 终结；EXEC 包装；SET 指令过滤并警告', () => {
    const r = splitStatements(oracleScript, 'oracle');
    expect(r.warnings.some((w) => w.type === 'filtered_directive')).toBe(true);
    expect(r.statements.map((s) => s.keyword)).toEqual(['create', 'begin', 'commit']);
    expect(r.statements[0].text).toContain('END LOOP;');
    expect(r.statements[1].text).toMatch(/^BEGIN\s+p_demo\s*;\s*END$/);
  });
  it('匿名块 BEGIN…END; 作为单条语句', () => {
    const r = splitStatements('BEGIN\n  DELETE FROM t;\nEND;\nSELECT 1 FROM dual;', 'dm');
    expect(r.statements).toHaveLength(2);
    expect(r.statements[0].keyword).toBe('begin');
  });
  it('字符串里的 END; 不干扰深度', () => {
    const r = splitStatements("BEGIN\n  INSERT INTO t VALUES ('END;');\nEND;\nSELECT 1 FROM dual;", 'oracle');
    expect(r.statements).toHaveLength(2);
  });
  it('控制流指令拒绝（EXIT / WHENEVER / @include）', () => {
    expect(() => splitStatements('EXIT\n', 'oracle')).toThrow(/不支持.*EXIT|控制流/);
    expect(() => splitStatements('@a.sql\n', 'dm')).toThrow(/不支持/);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /Users/stbearangel/dev/AiProject/momo-plugin && npx vitest run tests/db-pro/script-splitter.test.mjs`
Expected: FAIL

- [ ] **Step 3: 实现 Oracle/DM profile**

加入状态与辅助（放在 `splitStatements` 内）：

```js
  const isPlsql = dialect === 'oracle' || dialect === 'dm';
  let depth = 0;
  let skipEndQualifier = false;
  let blockMode = false;

  const FILTER_DIRECTIVES = /^(set|prompt|show|clear|define|undefine|spool)\b/i;
  const REJECT_DIRECTIVES = /^(exit|quit|whenever|host|start|@@?)\b/i;

  function handlePlsqlWord(word) {
    const w = word.toLowerCase();
    if (skipEndQualifier && (w === 'if' || w === 'loop' || w === 'case')) {
      skipEndQualifier = false;
      return;
    }
    if (w === 'end') { depth = Math.max(0, depth - 1); skipEndQualifier = true; return; }
    if (w === 'begin' || w === 'loop' || w === 'case' || w === 'if') depth += 1;
  }
```

行首指令与 `/` 处置（放在 DELIMITER 判定之后）：

```js
    if (isPlsql && atLineStart && buf.trim() === '') {
      const rest = src.slice(i);
      const filtered = rest.match(/^(set|prompt|show|clear|define|undefine|spool)\b[^\n]*\r?\n?/i);
      if (filtered) {
        warnings.push({ line, type: 'filtered_directive', message: `已忽略 SQL*Plus 指令：${filtered[0].trim()}` });
        const consumed = filtered[0];
        line += (consumed.match(/\n/g) ?? []).length;
        i += consumed.length - 1;
        atLineStart = true;
        continue;
      }
      const rejected = rest.match(/^(exit|quit|whenever|host|start|@@?)\b/i);
      if (rejected) {
        throw new SplitterError(`第 ${line} 行：不支持控制流/包含指令 "${rejected[1].toUpperCase()}"——请内联脚本内容并移除该指令`, line);
      }
      if (/^\/[ \t]*\r?\n?/.test(rest)) {
        flush();
        const consumed = rest.match(/^\/[ \t]*\r?\n?/)[0];
        line += (consumed.match(/\n/g) ?? []).length;
        i += consumed.length - 1;
        atLineStart = true;
        continue;
      }
    }
```

块深度与终结判定（替换终结符分支）：

```js
    if (isPlsql && /[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z_]/.test(src[j])) j += 1;
      const word = src.slice(i, j);
      if (blockMode || /^(begin|declare|create)$/i.test(word)) blockMode = true;
      handlePlsqlWord(word);
      buf += word;
      i = j - 1;
      atLineStart = false;
      continue;
    }

    if (isPlsql) {
      if (src.startsWith(';', i) && depth > 0) { buf += c; atLineStart = false; continue; }
    }

    if (src.startsWith(terminator, i)) { ... }
```

`flush` 后追加 EXEC 包装（在返回前统一后处理）：

```js
  for (const s of statements) {
    if (isPlsql && (s.keyword === 'exec' || s.keyword === 'execute')) {
      const expr = s.text.replace(/^(exec|execute)\s+/i, '');
      s.text = `BEGIN ${expr}; END`;
      s.keyword = 'begin';
    }
  }
```

（`FILTER_DIRECTIVES` / `REJECT_DIRECTIVES` 常量若未直接使用则删除，避免未使用变量。）

- [ ] **Step 4: 跑测试确认通过（全量切分器回归）**

Run: `cd /Users/stbearangel/dev/AiProject/momo-plugin && npx vitest run tests/db-pro/script-splitter.test.mjs`
Expected: PASS（16 用例）

- [ ] **Step 5: 提交**

```bash
cd /Users/stbearangel/dev/AiProject/momo-plugin
git add plugins/db-pro/engine/script-splitter.js tests/db-pro/script-splitter.test.mjs
git commit -m "feat(db-pro): 切分器支持 Oracle/DM PL/SQL profile"
```

---

### Task 5: 语句分类器 / 表推断 / 脚本号

**Files:**
- Modify: `plugins/db-pro/engine/script-splitter.js`
- Test: `tests/db-pro/script-splitter.test.mjs`（追加）

**Interfaces:**
- Produces: `classifyStatement(text) → {cls: 'read'|'insert'|'update'|'delete'|'merge'|'ddl_table'|'ddl_other'|'procedure'|'session'|'txn'|'block'|'priv'|'unknown', tables: string[]}`；`splitStatements` 产出的每条语句带 `cls` 与 `tables`；`summarize` / `extractScriptNo` 可直接用。

- [ ] **Step 1: 写失败测试**

```js
import { classifyStatement, summarize, extractScriptNo } from '../../plugins/db-pro/engine/script-splitter.js';

describe('classifyStatement / summarize / extractScriptNo', () => {
  it.each([
    ['SELECT * FROM t', 'read'],
    ['INSERT INTO t VALUES (1)', 'insert'],
    ['UPDATE t SET a = 1', 'update'],
    ['DELETE FROM t', 'delete'],
    ['MERGE INTO t USING s ON (1=1)', 'merge'],
    ['TRUNCATE TABLE t', 'ddl_table'],
    ['CREATE TABLE t (id INT)', 'ddl_table'],
    ['DROP TABLE IF EXISTS t', 'ddl_table'],
    ['ALTER TABLE t ADD c INT', 'ddl_table'],
    ['CREATE INDEX ix ON t(a)', 'ddl_other'],
    ['CREATE OR REPLACE VIEW v AS SELECT 1', 'ddl_other'],
    ['CREATE PROCEDURE p() BEGIN END', 'procedure'],
    ['CALL p()', 'procedure'],
    ['SET @x = 1', 'session'],
    ['START TRANSACTION', 'txn'],
    ['COMMIT', 'txn'],
    ['BEGIN DELETE FROM t; END', 'block'],
    ['GRANT SELECT ON t TO u', 'priv'],
  ])('%s → %s', (sql, cls) => {
    expect(classifyStatement(sql).cls).toBe(cls);
  });

  it('表推断去引号/去重', () => {
    const r = classifyStatement('INSERT INTO `db`.`t` SELECT * FROM t');
    expect(r.tables).toContain('t');
  });

  it('summarize 计数与表并集', () => {
    const r = splitStatements("INSERT INTO a VALUES (1);\nUPDATE b SET x=1;\nSELECT 1;", 'mysql');
    const s = summarize(r.statements);
    expect(s.statementCount).toBe(3);
    expect(s.counts).toEqual({ insert: 1, update: 1, read: 1 });
    expect(s.tables).toEqual(expect.arrayContaining(['a', 'b']));
  });

  it('extractScriptNo 从 @__script_no 与注释兜底', () => {
    expect(extractScriptNo("SET @__script_no = 'S00971511';")).toBe('S00971511');
    expect(extractScriptNo('-- SCRIPT_NO: S00957558')).toBe('S00957558');
    expect(extractScriptNo('SELECT 1')).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /Users/stbearangel/dev/AiProject/momo-plugin && npx vitest run tests/db-pro/script-splitter.test.mjs`
Expected: FAIL（classifyStatement 未导出）

- [ ] **Step 3: 实现分类器与推断**

```js
const TABLE_PATTERNS = [
  /\b(?:insert\s+into|replace\s+into|merge\s+into)\s+([A-Za-z0-9_$."`[\]]+)/i,
  /\bupdate\s+([A-Za-z0-9_$."`[\]]+)/i,
  /\bdelete\s+from\s+([A-Za-z0-9_$."`[\]]+)/i,
  /\btruncate\s+table\s+([A-Za-z0-9_$."`[\]]+)/i,
  /\b(?:create|drop|alter)\s+table\s+(?:if\s+(?:not\s+)?exists\s+)?([A-Za-z0-9_$."`[\]]+)/i,
  /\bcreate\s+(?:unique\s+)?index\s+\S+\s+on\s+([A-Za-z0-9_$."`[\]]+)/i,
];

function inferTables(text) {
  const out = [];
  for (const re of TABLE_PATTERNS) {
    const m = text.match(re);
    if (!m) continue;
    const name = m[1].replace(/["`[\]]/g, '').split('.').pop();
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

function classifyStatement(textRaw) {
  const text = String(textRaw ?? '');
  const first = firstKeyword(text);
  const second = (text.trim().match(/^[A-Za-z]+\s+(?:or\s+replace\s+)?([A-Za-z]+)/i) ?? [])[1]?.toLowerCase() ?? '';
  let cls = 'unknown';
  if (['select', 'show', 'desc', 'describe', 'explain', 'with'].includes(first)) cls = 'read';
  else if (first === 'insert') cls = 'insert';
  else if (first === 'update') cls = 'update';
  else if (first === 'delete') cls = 'delete';
  else if (first === 'merge') cls = 'merge';
  else if (first === 'truncate') cls = 'ddl_table';
  else if (first === 'create' || first === 'drop' || first === 'alter') {
    if (second === 'table') cls = 'ddl_table';
    else if (['procedure', 'function', 'package', 'trigger'].includes(second)) cls = 'procedure';
    else if (['view', 'index', 'sequence', 'trigger'].includes(second)) cls = 'ddl_other';
    else cls = 'ddl_other';
  } else if (first === 'call' || first === 'exec' || first === 'execute') cls = 'procedure';
  else if (first === 'set' || first === 'use') cls = 'session';
  else if (['start', 'commit', 'rollback', 'savepoint'].includes(first)) cls = 'txn';
  else if (first === 'begin' || first === 'declare') cls = 'block';
  else if (first === 'grant' || first === 'revoke') cls = 'priv';
  return { cls, tables: inferTables(text) };
}
```

`flush()` 内改为携带分类：

```js
    if (text !== '') {
      const { cls, tables } = classifyStatement(text);
      statements.push({ idx: statements.length + 1, line: stmtLine, text, keyword: firstKeyword(text), cls, tables });
    }
```

导出 `classifyStatement` 与 `inferTables`。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd /Users/stbearangel/dev/AiProject/momo-plugin && npx vitest run tests/db-pro/script-splitter.test.mjs`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
cd /Users/stbearangel/dev/AiProject/momo-plugin
git add plugins/db-pro/engine/script-splitter.js tests/db-pro/script-splitter.test.mjs
git commit -m "feat(db-pro): 脚本语句分类器与表推断"
```

---

### Task 6: 引擎 `scriptAnalyze` / `scriptRun`

**Files:**
- Modify: `plugins/db-pro/engine/engine.js`
- Test: `tests/db-pro/engine.test.mjs`（追加）

**Interfaces:**
- Consumes: `splitStatements` / `summarize` / `extractScriptNo`；驱动 `openSession()`（Task 7 提供；本任务用 fake）。
- Produces:
  - `dispatch('scriptAnalyze', {script, dialect}) → {statements, warnings, summary, scriptNo}`
  - `dispatch('scriptRun', {connection, script, onError, scriptTimeoutMs}) → {ok, total, executed, results:[{idx,line,status,affectedRows?|error?}], failedAtIndex?, error?, durationMs}`
  - 会话契约：`session.exec(sql) → {affectedRows}`、`session.finish(ok: boolean)`、`session.close()`。

- [ ] **Step 1: 写失败测试**

```js
// tests/db-pro/engine.test.mjs（追加）
describe('scriptAnalyze / scriptRun（fake driver）', () => {
  function fakeDriver() {
    const execLog = [];
    return {
      execLog,
      async createPool(url) {
        return {
          url,
          async ping() {},
          async close() {},
          async openSession() {
            return {
              async exec(sql) {
                execLog.push(sql);
                if (sql.includes('BOOM')) throw new Error('boom');
                return { affectedRows: 1 };
              },
              async finish(ok) { execLog.push(ok ? 'finish:ok' : 'finish:fail'); },
              async close() { execLog.push('close'); },
            };
          },
        };
      },
    };
  }

  async function setup() {
    const { createDispatcher } = await import('../../plugins/db-pro/engine/engine.js');
    const fake = fakeDriver();
    const pools = new Map();
    const d = createDispatcher(() => fake, pools);
    await d.dispatch('configure', { connections: [{ name: 't', url: 'mysql://u:p@h/d', queryTimeoutMs: 1000 }] });
    return { d, fake };
  }

  it('scriptAnalyze 返回语句清单/摘要/脚本号，不触碰连接', async () => {
    const { d, fake } = await setup();
    const r = await d.dispatch('scriptAnalyze', { script: "SET @__script_no = 'X1';\nINSERT INTO a VALUES (1);", dialect: 'mysql' });
    expect(r.statements).toHaveLength(2);
    expect(r.scriptNo).toBe('X1');
    expect(r.summary.counts).toEqual({ session: 1, insert: 1 });
    expect(fake.execLog).toEqual([]);
  });

  it('scriptRun 顺序执行、收尾 ok、关闭会话', async () => {
    const { d, fake } = await setup();
    const r = await d.dispatch('scriptRun', { connection: 't', script: 'SELECT 1; SELECT 2;', onError: 'abort' });
    expect(r.ok).toBe(true);
    expect(r.executed).toBe(2);
    expect(fake.execLog).toEqual(['SELECT 1', 'SELECT 2', 'finish:ok', 'close']);
  });

  it('abort 失败即停并定位', async () => {
    const { d, fake } = await setup();
    const r = await d.dispatch('scriptRun', { connection: 't', script: 'SELECT 1; SELECT BOOM; SELECT 3;', onError: 'abort' });
    expect(r.ok).toBe(false);
    expect(r.failedAtIndex).toBe(2);
    expect(r.executed).toBe(2);
    expect(fake.execLog).toEqual(['SELECT 1', 'SELECT BOOM', 'finish:fail', 'close']);
  });

  it('continue 采集全部错误', async () => {
    const { d } = await setup();
    const r = await d.dispatch('scriptRun', { connection: 't', script: 'SELECT BOOM; SELECT 1;', onError: 'continue' });
    expect(r.ok).toBe(false);
    expect(r.results.filter((x) => x.status === 'failed')).toHaveLength(1);
    expect(r.executed).toBe(2);
  });

  it('GRANT 语句在预检即拒', async () => {
    const { d } = await setup();
    await expect(d.dispatch('scriptRun', { connection: 't', script: 'GRANT SELECT ON a TO b;', onError: 'abort' }))
      .rejects.toThrow(/GRANT|REVOKE/);
  });

  it('未配置连接 → 人话错误', async () => {
    const { d } = await setup();
    await expect(d.dispatch('scriptRun', { connection: 'nope', script: 'SELECT 1;' }))
      .rejects.toThrow(/未配置的连接/);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /Users/stbearangel/dev/AiProject/momo-plugin && npx vitest run tests/db-pro/engine.test.mjs`
Expected: FAIL（未知方法 scriptAnalyze）

- [ ] **Step 3: 实现两个 op**

在 `engine.js` 顶部引入：

```js
const { splitStatements, summarize, extractScriptNo } = require('./script-splitter');

/** 连接 URL → 方言（脚本 profile 选择） */
function dialectOfUrl(url) {
  try {
    return new URL(url).protocol.replace(':', '');
  } catch {
    return 'mysql';
  }
}
```

`dispatch` 内新增（放在 `case 'exec'` 之前）：

```js
      case 'scriptAnalyze': {
        const r = splitStatements(params.script, params.dialect ?? 'mysql');
        return { ...r, summary: summarize(r.statements), scriptNo: extractScriptNo(params.script) };
      }
      // 脚本执行仅由 service 在人工批准后调用（与 exec 同侧边界）
      case 'scriptRun': {
        const handle = pools.get(params.connection);
        if (!handle) {
          const reason = unavailable.get(params.connection);
          throw new EngineError(CODES.CONN, reason
            ? `连接 "${params.connection}" 配置失败：${reason}`
            : `未配置的连接 "${params.connection}"——请在插件设置中配置后重试`);
        }
        const dialect = dialectOfUrl(handle.url);
        const { statements } = splitStatements(params.script, dialect);
        if (statements.length === 0) return { ok: true, total: 0, executed: 0, results: [], durationMs: 0 };
        const priv = statements.find((s) => s.cls === 'priv');
        if (priv) {
          throw new EngineError(CODES.VALIDATION, `第 ${priv.idx} 条为 GRANT/REVOKE——脚本通道不支持权限管理语句（DBA 域）`);
        }
        const onError = params.onError === 'continue' ? 'continue' : 'abort';
        const timeoutMs = Number.isFinite(params.scriptTimeoutMs) ? params.scriptTimeoutMs : 600_000;
        const started = Date.now();
        const session = await handle.pool.openSession();
        const results = [];
        let failedAtIndex = null;
        let failure = null;
        try {
          for (const s of statements) {
            if (Date.now() - started > timeoutMs) {
              failure = { code: 'script_timeout', message: `整脚本超时（${Math.round(timeoutMs / 1000)}s）——已中止`, line: s.line };
              break;
            }
            try {
              const r = await session.exec(s.text);
              results.push({ idx: s.idx, line: s.line, status: 'ok', affectedRows: r.affectedRows ?? 0 });
            } catch (err) {
              results.push({ idx: s.idx, line: s.line, status: 'failed', error: err instanceof Error ? err.message : String(err) });
              if (failedAtIndex === null) {
                failedAtIndex = s.idx;
                failure = { code: err?.code ?? 'driver_error', message: err instanceof Error ? err.message : String(err), line: s.line };
              }
              if (onError === 'abort') break;
            }
          }
          await session.finish(failure === null);
        } finally {
          await session.close();
        }
        return {
          ok: failure === null,
          total: statements.length,
          executed: results.length,
          results,
          ...(failedAtIndex !== null ? { failedAtIndex } : {}),
          ...(failure !== null ? { error: failure } : {}),
          durationMs: Date.now() - started,
        };
      }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd /Users/stbearangel/dev/AiProject/momo-plugin && npx vitest run tests/db-pro/engine.test.mjs`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
cd /Users/stbearangel/dev/AiProject/momo-plugin
git add plugins/db-pro/engine/engine.js tests/db-pro/engine.test.mjs
git commit -m "feat(db-pro): 引擎新增 scriptAnalyze/scriptRun"
```

---

### Task 7: 四驱动 `openSession()` + 集成验证

**Files:**
- Modify: `plugins/db-pro/engine/drivers/mysql.js`、`pg.js`、`oracle.js`、`dm.js`
- Test: `tests/db-pro/script-session.integration.test.mjs`（新建）

**Interfaces:**
- Produces: 每个 `createPool()` 返回对象新增 `openSession() → {exec(sql)→{affectedRows}, finish(ok:boolean)→Promise<void>, close()→Promise<void>}`。
- 提交语义：mysql/pg 自动提交（`finish` 空实现）；oracle/dm 非自动提交（`finish(true)` COMMIT / `finish(false)` ROLLBACK）。

- [ ] **Step 1: 写集成测试（门控 DBPRO_INTEGRATION=1）**

```js
// tests/db-pro/script-session.integration.test.mjs
import { describe, it, expect } from 'vitest';
import net from 'node:net';

const ON = process.env.DBPRO_INTEGRATION === '1';
function reachable(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const s = net.connect({ port, host, timeout: 1500 });
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => resolve(false));
    s.once('timeout', () => { s.destroy(); resolve(false); });
  });
}

const CASES = [
  { dialect: 'mysql', port: 13306, loader: () => import('../../plugins/db-pro/engine/drivers/mysql.js'),
    url: process.env.DBPRO_MYSQL ?? 'mysql://root:dbpro123@127.0.0.1:13306/dbpro', autoCommit: true },
  { dialect: 'postgres', port: 15432, loader: () => import('../../plugins/db-pro/engine/drivers/pg.js'),
    url: process.env.DBPRO_PG ?? 'postgres://postgres:dbpro123@127.0.0.1:15432/dbpro', autoCommit: true },
  { dialect: 'oracle', port: 11521, loader: () => import('../../plugins/db-pro/engine/drivers/oracle.js'),
    url: process.env.DBPRO_ORACLE ?? 'oracle://pdbadmin:dbpro123@127.0.0.1:11521/FREEPDB1', autoCommit: false },
  { dialect: 'dm', port: 15236, loader: () => import('../../plugins/db-pro/engine/drivers/dm.js'),
    url: process.env.DBPRO_DM ?? 'dm://SYSDBA:SYSDBA001@127.0.0.1:15236', autoCommit: false },
];

describe.skipIf(!ON)('脚本会话（四库）', () => {
  for (const c of CASES) {
    it(`${c.dialect}: 会话内提交成功 / abort 回滚（非自动提交方言）`, async () => {
      if (!(await reachable(c.port))) return;
      const mod = await c.loader();
      const pool = await mod.createPool(c.url, { queryTimeoutMs: 30_000 });
      const t = c.dialect === 'oracle' || c.dialect === 'dm' ? 'DBPRO_SESSION_T' : 'dbpro_session_t';
      try {
        // 建表（会话外）
        const prep = await pool.openSession();
        await prep.exec(`DROP TABLE ${t}`).catch(() => undefined);
        await prep.exec(`CREATE TABLE ${t} (id INT)`);
        await prep.finish(true);
        await prep.close();

        // 成功路径：插入 + finish(true) → 新会话可读到
        const s1 = await pool.openSession();
        await s1.exec(`INSERT INTO ${t} VALUES (1)`);
        await s1.finish(true);
        await s1.close();

        const s2 = await pool.openSession();
        await s2.exec(`DELETE FROM ${t}`);
        await s2.finish(false); // abort → oracle/dm 回滚
        await s2.close();

        const check = await pool.query(`SELECT id FROM ${t}`, 10);
        if (c.autoCommit) {
          expect(check.rows.length).toBe(0); // 自动提交方言：DELETE 已生效
        } else {
          expect(check.rows.length).toBe(1); // 非自动提交：DELETE 被回滚
        }
      } finally {
        const cleanup = await pool.openSession();
        await cleanup.exec(`DROP TABLE ${t}`).catch(() => undefined);
        await cleanup.finish(true).catch(() => undefined);
        await cleanup.close().catch(() => undefined);
        await pool.close();
      }
    });
  }
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /Users/stbearangel/dev/AiProject/momo-plugin && DBPRO_INTEGRATION=1 NODE_OPTIONS=--openssl-legacy-provider npx vitest run tests/db-pro/script-session.integration.test.mjs`
Expected: FAIL（`openSession is not a function`）

- [ ] **Step 3: 四个驱动各加 `openSession()`**

mysql（`plugins/db-pro/engine/drivers/mysql.js`，`createPool` 返回对象内）：

```js
    async openSession() {
      const conn = await pool.getConnection();
      return {
        async exec(sql) {
          const [res] = await conn.query({ sql, timeout: timeoutMs });
          const affectedRows = Array.isArray(res) ? res.length : (res.affectedRows ?? 0);
          return { affectedRows };
        },
        // 自动提交方言：语句落地即持久——不做收尾
        async finish() {},
        async close() { conn.release(); },
      };
    },
```

pg（`pg.js`）：

```js
    async openSession() {
      const client = await pool.connect();
      return {
        async exec(sql) {
          const res = await client.query({ text: sql, values: [] });
          return { affectedRows: res.rowCount ?? 0 };
        },
        async finish() {},
        async close() { client.release(); },
      };
    },
```

oracle（`oracle.js`）：

```js
    async openSession() {
      const conn = await pool.getConnection();
      conn.callTimeout = timeoutMs;
      return {
        async exec(sql) {
          const res = await conn.execute(sql, {}, { autoCommit: false });
          return { affectedRows: res.rowsAffected ?? 0 };
        },
        async finish(ok) {
          try { if (ok) await conn.commit(); else await conn.rollback(); } catch { /* 收尾失败不掩盖主结果 */ }
        },
        async close() { try { await conn.close(); } catch { /* 已失效 */ } },
      };
    },
```

dm（`dm.js`）：

```js
    async openSession() {
      const conn = await pool.getConnection();
      return {
        async exec(sql) {
          const res = await conn.execute(sql);
          return { affectedRows: res.rowsAffected ?? 0 };
        },
        async finish(ok) {
          try { if (ok) await conn.commit(); else await conn.rollback(); } catch { /* 收尾失败不掩盖主结果 */ }
        },
        async close() { try { await conn.close(); } catch { /* 已失效 */ } },
      };
    },
```

- [ ] **Step 4: 跑集成测试确认通过（容器需已起）**

Run: `cd /Users/stbearangel/dev/AiProject/momo-plugin/tests/docker && docker compose up -d && cd ../.. && DBPRO_INTEGRATION=1 NODE_OPTIONS=--openssl-legacy-provider npx vitest run tests/db-pro/script-session.integration.test.mjs`
Expected: PASS（四库各 1 用例；容器未起的库 skip）

- [ ] **Step 5: 提交**

```bash
cd /Users/stbearangel/dev/AiProject/momo-plugin
git add plugins/db-pro/engine/drivers/*.js tests/db-pro/script-session.integration.test.mjs
git commit -m "feat(db-pro): 四驱动新增脚本会话（专用连接+提交语义）"
```

---

### Task 8: service `script-state`（提交 / 轮询 / 后台作业 / 历史）

**Files:**
- Create: `plugins/db-pro/service/script-state.js`
- Test: `tests/db-pro/script-state.test.mjs`

**Interfaces:**
- Consumes: `humanGate()`（宿主注入；`.create({sessionId, taskId, title, prompt, payloadJson})` / `.status(id)`）、`analyze(connection, script, dialect) → {statements, warnings, summary, scriptNo}`、`run(payload) → engine scriptRun 结果`、`dataDir`、`log`。
- Produces: `createScriptState({humanGate, analyze, run, dataDir, log}) → {submit(p), status(p), history(p)}`；submit 返回 `{requestId, status:'pending', summary}` 或 dryrun 分析；status 返回 `{status:'pending'|'denied'|'expired'|'running'|'executed'|'exec_unknown'|'not_found'|'invalid_payload', ...}`。

- [ ] **Step 1: 写失败测试**

```js
// tests/db-pro/script-state.test.mjs
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import m from '../../plugins/db-pro/service/script-state.js';
const { createScriptState } = m;

function makeDeps(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbpro-script-'));
  const rows = new Map();
  let n = 0;
  const gate = {
    async create(input) {
      n += 1;
      const id = `req-${n}`;
      rows.set(id, { id, status: 'pending', answerJson: null, payloadJson: input.payloadJson });
      gate.created.push(input);
      return id;
    },
    async status(id) { return rows.get(id) ?? null; },
    created: [],
  };
  const state = createScriptState({
    humanGate: () => gate,
    analyze: async () => ({
      statements: [
        { idx: 1, line: 1, text: "SET @__script_no = 'S1'", keyword: 'set', cls: 'session', tables: [] },
        { idx: 2, line: 2, text: 'INSERT INTO a VALUES (1)', keyword: 'insert', cls: 'insert', tables: ['a'] },
      ],
      warnings: [],
      summary: { statementCount: 2, counts: { session: 1, insert: 1 }, tables: ['a'] },
      scriptNo: 'S1',
    }),
    run: async () => ({ ok: true, total: 2, executed: 2, results: [], durationMs: 5 }),
    dataDir: dir,
    log: () => undefined,
    ...overrides,
  });
  return { state, gate, rows, dir };
}

describe('script-state · submit', () => {
  it('dryrun 直接返回分析，不建人工请求', async () => {
    const { state, gate } = makeDeps();
    const r = await state.submit({ connection: 'c', script: 'SELECT 1', sessionId: 's', dryrun: true });
    expect(r.dryrun).toBe(true);
    expect(r.scriptNo).toBe('S1');
    expect(gate.created).toHaveLength(0);
  });
  it('正常提交建 tool_gate 卡：标题带脚本号/语句数，payload 含 script 全文', async () => {
    const { state, gate } = makeDeps();
    const r = await state.submit({ connection: 'c', script: 'X', sessionId: 's' });
    expect(r).toEqual({ requestId: 'req-1', status: 'pending', summary: expect.any(Object) });
    const card = gate.created[0];
    expect(card.title).toContain('S1');
    expect(card.title).toContain('2 语句');
    const payload = JSON.parse(card.payloadJson);
    expect(payload.db.kind).toBe('script');
    expect(payload.db.script).toBe('X');
    expect(payload.db.opClass).toBe('script');
  });
  it('缺少 sessionId / connection → 人话错误', async () => {
    const { state } = makeDeps();
    await expect(state.submit({ connection: 'c', script: 'X' })).rejects.toThrow(/sessionId/);
    await expect(state.submit({ connection: '', script: 'X', sessionId: 's' })).rejects.toThrow(/connection/);
  });
  it('脚本超 2MB 拒绝', async () => {
    const { state } = makeDeps();
    await expect(state.submit({ connection: 'c', script: 'x'.repeat(2 * 1024 * 1024 + 1), sessionId: 's' }))
      .rejects.toThrow(/2MB/);
  });
});

describe('script-state · status', () => {
  it('approve → 后台执行 → running → executed（至多执行一次）', async () => {
    let runs = 0;
    const { state, rows } = makeDeps({ run: async () => { runs += 1; return { ok: true, total: 2, executed: 2, results: [], durationMs: 1 }; } });
    const { requestId } = await state.submit({ connection: 'c', script: 'X', sessionId: 's' });
    rows.get(requestId).status = 'answered';
    rows.get(requestId).answerJson = JSON.stringify({ decision: 'approve' });
    const r1 = await state.status({ requestId });
    expect(['running', 'executed']).toContain(r1.status);
    const r2 = await state.status({ requestId });
    expect(r2.status).toBe('executed');
    expect(runs).toBe(1);
  });
  it('deny → denied 带附言', async () => {
    const { state, rows } = makeDeps();
    const { requestId } = await state.submit({ connection: 'c', script: 'X', sessionId: 's' });
    rows.get(requestId).status = 'answered';
    rows.get(requestId).answerJson = JSON.stringify({ decision: 'deny', text: '别跑' });
    expect(await state.status({ requestId })).toEqual({ status: 'denied', note: '别跑' });
  });
  it('执行失败 → failed 并记录历史', async () => {
    const { state, rows, dir } = makeDeps({ run: async () => ({ ok: false, total: 2, executed: 2, results: [], failedAtIndex: 2, error: { code: 'x', message: 'boom', line: 9 }, durationMs: 3 }) });
    const { requestId } = await state.submit({ connection: 'c', script: 'X', sessionId: 's' });
    rows.get(requestId).status = 'answered';
    rows.get(requestId).answerJson = JSON.stringify({ decision: 'approve' });
    await state.status({ requestId });
    for (let i = 0; i < 50; i += 1) {
      const r = await state.status({ requestId });
      if (r.status === 'executed' || r.status === 'failed') break;
      await new Promise((res) => setTimeout(res, 5));
    }
    const hist = await state.history({ limit: 10 });
    expect(hist.entries[0].result).toBe('failed');
    expect(fs.existsSync(path.join(dir, 'script-history.jsonl'))).toBe(true);
  });
  it('未知 requestId → not_found', async () => {
    const { state } = makeDeps();
    expect(await state.status({ requestId: 'nope' })).toEqual({ status: 'not_found' });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /Users/stbearangel/dev/AiProject/momo-plugin && npx vitest run tests/db-pro/script-state.test.mjs`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 script-state**

```js
// plugins/db-pro/service/script-state.js
'use strict';
// 脚本执行编排（spec 2026-11-19 §5.1/§5.4/§5.5，D13）：
// submit → human_requests(tool_gate, db.kind='script') → status 轮询 →
// approve 即启动后台作业（不阻塞轮询）→ 结果缓存 + 历史落账。
// 重放保护（同 write-state D7）：同一 requestId 至多执行一次；中断 → exec_unknown。
const fs = require('node:fs');
const path = require('node:path');

const HISTORY_FILE = 'script-history.jsonl';
const MAX_SCRIPT_BYTES = 2 * 1024 * 1024;
const MAX_STATEMENTS = 10_000;
const HISTORY_MAX_BYTES = 5 * 1024 * 1024;
const HISTORY_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

function readEntries(file) {
  try {
    return fs.readFileSync(file, 'utf-8').split('\n').filter((l) => l.trim() !== '')
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch {
    return [];
  }
}

function createScriptState({ humanGate, analyze, run, dataDir, log }) {
  const file = path.join(dataDir, HISTORY_FILE);
  // Map<requestId, 最新记录>：attempting / executed / failed / denied
  const records = new Map(readEntries(file).map((e) => [e.requestId, e]));
  // Map<requestId, {state:'running'|'done', result?}>：进程内作业态（重启即失效）
  const jobs = new Map();

  function append(entry) {
    try { fs.appendFileSync(file, JSON.stringify(entry) + '\n'); } catch (err) {
      log('db-pro 脚本历史追加失败（重放保护降级为内存态）', { error: err.message });
    }
    records.set(entry.requestId, entry);
    rotate();
  }

  function rotate() {
    try {
      const st = fs.statSync(file);
      if (st.size <= HISTORY_MAX_BYTES) return;
      const cutoff = Date.now() - HISTORY_MAX_AGE_MS;
      const keep = readEntries(file).filter((e) => e.status === 'attempting' || (e.at ?? 0) >= cutoff);
      fs.writeFileSync(file, keep.map((e) => JSON.stringify(e)).join('\n') + (keep.length ? '\n' : ''));
    } catch { /* 轮转失败不影响主路径 */ }
  }

  async function submit(p) {
    const connection = typeof p.connection === 'string' && p.connection !== '' ? p.connection : '';
    if (connection === '') throw new Error('script_execute 须指定 connection');
    if (typeof p.sessionId !== 'string' || p.sessionId === '') {
      throw new Error('script_execute 缺少 sessionId（工具层注入失败——面板将不可见）');
    }
    const script = typeof p.script === 'string' ? p.script : '';
    if (Buffer.byteLength(script, 'utf-8') > MAX_SCRIPT_BYTES) throw new Error('脚本超过 2MB 上限——请拆分后分批执行');
    const analysis = await analyze(connection, script);
    if ((analysis.statements?.length ?? 0) > MAX_STATEMENTS) {
      throw new Error(`脚本语句数超过 ${MAX_STATEMENTS} 条上限——请拆分后分批执行`);
    }
    if (analysis.statements?.length === 0) {
      return { dryrun: p.dryrun === true, statements: [], warnings: analysis.warnings ?? [], summary: analysis.summary, scriptNo: analysis.scriptNo, note: '0 条语句（空脚本/纯注释/纯客户端指令）' };
    }
    if (p.dryrun === true) {
      return { dryrun: true, statements: analysis.statements, warnings: analysis.warnings, summary: analysis.summary, scriptNo: analysis.scriptNo };
    }
    const onError = p.onError === 'continue' ? 'continue' : 'abort';
    const counts = analysis.summary?.counts ?? {};
    const countText = Object.entries(counts).map(([k, v]) => `${k}×${v}`).join(' · ');
    const tables = analysis.summary?.tables ?? [];
    const risk = [];
    const ddl = (counts.ddl_table ?? 0) + (counts.ddl_other ?? 0);
    if (ddl > 0) risk.push(`DDL×${ddl}`);
    if ((counts.merge ?? 0) > 0) risk.push(`MERGE×${counts.merge}`);
    const head = script.split('\n').slice(0, 20).join('\n');
    const id = await humanGate().create({
      sessionId: p.sessionId,
      taskId: typeof p.taskId === 'string' ? p.taskId : null,
      title: `脚本执行：${analysis.scriptNo ?? '未识别'} · ${connection} · ${analysis.statements.length} 语句`,
      prompt: [
        `分类：${countText || '（无）'}`,
        tables.length > 0 ? `目标表（推断）：${tables.join(', ')}` : '目标表（推断）：无',
        risk.length > 0 ? `风险：${risk.join(' · ')}` : '风险：无 DDL/MERGE',
        `失败策略：${onError === 'abort' ? '失败即停' : '继续执行'}`,
        `脚本头部预览：\n${head}`,
      ].join('\n'),
      payloadJson: JSON.stringify({
        db: { kind: 'script', connection, sql: head, opClass: 'script', script, onError, summary: analysis.summary, scriptNo: analysis.scriptNo },
      }),
    });
    return { requestId: id, status: 'pending', summary: analysis.summary, scriptNo: analysis.scriptNo };
  }

  async function status(p) {
    const requestId = String(p.requestId ?? '');
    if (requestId === '') throw new Error('script_status 缺少 requestId');
    const row = await humanGate().status(requestId);
    if (!row) return { status: 'not_found' };
    if (row.status !== 'answered') return { status: row.status };

    let answer = null;
    try { answer = row.answerJson ? JSON.parse(row.answerJson) : null; } catch { answer = null; }
    if (answer?.decision === 'deny') {
      if (records.get(requestId)?.status !== 'denied') append({ requestId, status: 'denied', at: Date.now() });
      return { status: 'denied', note: typeof answer.text === 'string' ? answer.text : '' };
    }
    if (answer?.decision !== 'approve') return { status: 'unknown', note: `意外答复形态: ${row.answerJson ?? '（空）'}` };

    const prior = records.get(requestId);
    if (prior?.status === 'attempting' && !jobs.has(requestId)) {
      return { status: 'exec_unknown', note: '此前执行中断（超时/引擎崩溃），结果未知——请人工核查数据库实际状态后重新发起' };
    }
    if (prior && prior.status !== 'attempting' && prior.status !== 'requested') {
      return { status: 'executed', result: prior.result, replayed: true };
    }

    let job = jobs.get(requestId);
    if (!job) {
      let payload = null;
      try { payload = row.payloadJson ? JSON.parse(row.payloadJson).db : null; } catch { payload = null; }
      if (!payload || payload.kind !== 'script' || typeof payload.script !== 'string' || typeof payload.connection !== 'string') {
        return { status: 'invalid_payload' };
      }
      append({ requestId, status: 'attempting', at: Date.now(), connection: payload.connection, scriptNo: payload.scriptNo ?? null });
      const started = Date.now();
      const promise = Promise.resolve()
        .then(() => run(payload))
        .then((result) => {
          const entry = {
            requestId, status: result.ok ? 'executed' : 'failed', at: Date.now(),
            connection: payload.connection, scriptNo: payload.scriptNo ?? null,
            statementCount: result.total, executed: result.executed,
            failedAtIndex: result.failedAtIndex ?? null,
            errorSummary: result.error?.message ?? null,
            durationMs: result.durationMs, tables: payload.summary?.tables ?? [],
            result,
          };
          append(entry);
          jobs.set(requestId, { state: 'done', result });
          return result;
        })
        .catch((err) => {
          const entry = {
            requestId, status: 'failed', at: Date.now(), connection: payload.connection,
            scriptNo: payload.scriptNo ?? null, errorSummary: err instanceof Error ? err.message : String(err),
            durationMs: Date.now() - started, result: null,
          };
          append(entry);
          const result = { ok: false, error: { code: 'service_error', message: entry.errorSummary }, durationMs: entry.durationMs };
          jobs.set(requestId, { state: 'done', result });
          return result;
        });
      job = { state: 'running', promise };
      jobs.set(requestId, job);
      // 立即返回 running；作业完成态由后续轮询读取
      void promise;
    }
    if (jobs.get(requestId).state === 'done') {
      return { status: 'executed', result: jobs.get(requestId).result };
    }
    return { status: 'running' };
  }

  async function history(p) {
    const limit = Number.isFinite(p.limit) && p.limit > 0 ? Math.min(Math.floor(p.limit), 200) : 20;
    const connection = typeof p.connection === 'string' && p.connection !== '' ? p.connection : null;
    const entries = readEntries(file)
      .filter((e) => e.status !== 'attempting')
      .filter((e) => (connection === null ? true : e.connection === connection))
      .sort((a, b) => (b.at ?? 0) - (a.at ?? 0))
      .slice(0, limit)
      .map((e) => ({
        requestId: e.requestId, at: e.at, connection: e.connection, scriptNo: e.scriptNo ?? null,
        result: e.status === 'executed' ? 'ok' : e.status === 'failed' ? 'failed' : e.status,
        statementCount: e.statementCount ?? null, failedAtIndex: e.failedAtIndex ?? null,
        errorSummary: e.errorSummary ?? null, durationMs: e.durationMs ?? null,
      }));
    return { entries };
  }

  return { submit, status, history };
}

module.exports = { createScriptState, MAX_SCRIPT_BYTES, MAX_STATEMENTS };
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd /Users/stbearangel/dev/AiProject/momo-plugin && npx vitest run tests/db-pro/script-state.test.mjs`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
cd /Users/stbearangel/dev/AiProject/momo-plugin
git add plugins/db-pro/service/script-state.js tests/db-pro/script-state.test.mjs
git commit -m "feat(db-pro): 脚本执行编排（审批/后台作业/历史/重放保护）"
```

---

### Task 9: service 接线 + `script_timeout_ms` 配置

**Files:**
- Modify: `plugins/db-pro/service/index.js`、`plugins/db-pro/service/config-connections.js`、`plugins/db-pro/momo-plugin.json`
- Test: `tests/db-pro/config-connections.test.mjs`（追加）

**Interfaces:**
- Consumes: `createScriptState`；`rpc('scriptAnalyze'|'scriptRun')`。
- Produces: service 方法 `scriptExecute` / `scriptStatus` / `scriptHistory`；`sanitizeScriptTimeoutMs(raw)`（缺省 600000，最小 10000，最大 3600000）。

- [ ] **Step 1: 写失败测试**

```js
// tests/db-pro/config-connections.test.mjs（追加）
import { sanitizeScriptTimeoutMs } from '../../plugins/db-pro/service/config-connections.js';
describe('sanitizeScriptTimeoutMs', () => {
  it('缺省/非法 → 600000；下限 10000；上限 3600000', () => {
    expect(sanitizeScriptTimeoutMs(undefined)).toBe(600_000);
    expect(sanitizeScriptTimeoutMs('abc')).toBe(600_000);
    expect(sanitizeScriptTimeoutMs(-1)).toBe(600_000);
    expect(sanitizeScriptTimeoutMs(5_000)).toBe(10_000);
    expect(sanitizeScriptTimeoutMs(120_000)).toBe(120_000);
    expect(sanitizeScriptTimeoutMs(99_999_999)).toBe(3_600_000);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /Users/stbearangel/dev/AiProject/momo-plugin && npx vitest run tests/db-pro/config-connections.test.mjs`
Expected: FAIL（未导出）

- [ ] **Step 3: 实现 sanitizer + service 接线 + manifest 键**

`config-connections.js` 追加：

```js
/** 整脚本超时净化：非有限/负数 → 缺省 600s；下限 10s；上限 3600s */
function sanitizeScriptTimeoutMs(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 600_000;
  return Math.min(Math.max(n, 10_000), 3_600_000);
}
```

并加入 `module.exports`。

`service/index.js`：

1) 顶部引入：

```js
const { connectionsFromConfig, diffConnections, sanitizeTimeoutMs, sanitizeScriptTimeoutMs, validateWriteConnection } = require('./config-connections');
const { createScriptState } = require('./script-state');
```

2) `createService` 内、`writeState` 之后创建脚本编排：

```js
  const scriptState = createScriptState({
    humanGate: () => {
      if (!ctx.humanGate) throw new Error('宿主未注入 humanGate（需包含该扩展的 momo-studio 版本）');
      return ctx.humanGate;
    },
    analyze: async (connection, script) => {
      if (!child) throw new Error('db-pro 引擎未就绪（启动中/重启中，请稍后重试）');
      return await rpc('scriptAnalyze', { script, dialect: dialectOfUrl(connection) }, 30_000);
    },
    run: async (payload) => {
      if (!child) throw new Error('db-pro 引擎未就绪（脚本作业中止）');
      const timeoutMs = sanitizeScriptTimeoutMs(ctx.getConfig().script_timeout_ms);
      return await rpc('scriptRun', {
        connection: payload.connection,
        script: payload.script,
        onError: payload.onError,
        scriptTimeoutMs: timeoutMs,
      }, timeoutMs + 5_000);
    },
    dataDir: ctx.getDataDir(),
    log: (msg, meta) => ctx.logger.warn(msg, meta),
  });
```

3) `dialectOf` 旁新增（按连接名取 URL 的方言）：

```js
  function dialectOfUrl(name) {
    const conn = lastConnections.find((c) => c.name === name);
    return conn ? dialectOf(conn.url) : 'mysql';
  }
```

4) `handle` 内新增（放在 `writeStatus` 之后）：

```js
    if (method === 'scriptExecute') {
      if (child) await ensureConfig();
      // 缺省连接补齐（spec §5.6：connection 省略取 is_default/defaultConnection）
      const withConn = params.connection ? params : { ...params, connection: defaultConnection() };
      validateWriteConnection(lastConnections, withConn.connection);
      return scriptState.submit(withConn);
    }
    if (method === 'scriptStatus') return scriptState.status(params);
    if (method === 'scriptHistory') return scriptState.history(params);
```

5) `momo-plugin.json` 的 `config.properties` 新增：

```json
"script_timeout_ms": {
  "type": "number",
  "title": "整脚本执行超时毫秒（缺省 600000；下限 10000，上限 3600000）"
}
```

- [ ] **Step 4: 跑测试确认通过（含既有 service 相关回归）**

Run: `cd /Users/stbearangel/dev/AiProject/momo-plugin && npx vitest run tests/db-pro/config-connections.test.mjs tests/db-pro/service-diag.test.mjs`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
cd /Users/stbearangel/dev/AiProject/momo-plugin
git add plugins/db-pro/service/index.js plugins/db-pro/service/config-connections.js plugins/db-pro/momo-plugin.json tests/db-pro/config-connections.test.mjs
git commit -m "feat(db-pro): service 接线脚本编排 + script_timeout_ms 配置"
```

---

### Task 10: 三个新工具（execute / status / history）

**Files:**
- Modify: `plugins/db-pro/tools/index.js`
- Test: `tests/db-pro/tools.test.mjs`（追加）

**Interfaces:**
- Consumes: service 方法 `scriptExecute` / `scriptStatus` / `scriptHistory`。
- Produces: 工具名 `script_execute` / `script_status` / `script_history`；`script_execute` 注入 `sessionId`/`taskId` 同 write；`on_error`/`max_rows` 参数映射。

- [ ] **Step 1: 写失败测试**

```js
// tests/db-pro/tools.test.mjs（追加）
describe('script_* 工具', () => {
  function fakeCtx() {
    const calls = [];
    return {
      calls,
      callService: async (method, params) => {
        calls.push({ method, params });
        if (method === 'scriptExecute') return { requestId: 'r1', status: 'pending', scriptNo: 'S1', summary: { statementCount: 2 } };
        if (method === 'scriptStatus') return { status: 'executed', result: { ok: true, total: 2, executed: 2, durationMs: 3 } };
        return { entries: [] };
      },
    };
  }

  it('script_execute 透传并注入 sessionId/taskId，渲染待批准文案', async () => {
    const { createTools } = await import('../../plugins/db-pro/tools/index.js');
    const ctx = fakeCtx();
    const tools = createTools(ctx);
    const text = await tools.execute('script_execute', { connection: 'c', script: 'X', on_error: 'continue' }, { roomId: 'room1', taskId: 't1' });
    expect(ctx.calls[0].method).toBe('scriptExecute');
    expect(ctx.calls[0].params).toMatchObject({ connection: 'c', script: 'X', onError: 'continue', sessionId: 'room1', taskId: 't1' });
    expect(text).toContain('等待用户批准');
  });

  it('script_status executed → 返回执行摘要', async () => {
    const { createTools } = await import('../../plugins/db-pro/tools/index.js');
    const tools = createTools(fakeCtx());
    const text = await tools.execute('script_status', { requestId: 'r1' }, { roomId: 'room1' });
    expect(text).toContain('已执行');
  });

  it('category 前缀与 defaultOn 缺省', async () => {
    const { createTools } = await import('../../plugins/db-pro/tools/index.js');
    const catalog = createTools(fakeCtx()).getCatalog();
    const item = catalog.find((c) => c.name === 'script_execute');
    expect(item.category).toBe('插件 db-pro');
    expect(item.defaultOn).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /Users/stbearangel/dev/AiProject/momo-plugin && npx vitest run tests/db-pro/tools.test.mjs`
Expected: FAIL

- [ ] **Step 3: 实现工具定义与渲染**

`DEFS` 追加：

```js
  {
    name: 'script_execute',
    description: '执行 SQL 脚本（多语句，支持 DELIMITER/存储过程/会话变量/事务）。不直接执行——创建脚本级人工批准请求；批准后脚本在后台运行。先调 script_status 轮询结果。可用 dryrun:true 只做静态分析（不连库不审批）。幂等由脚本自身保证。',
    inputSchema: {
      type: 'object',
      properties: {
        connection: { type: 'string', description: '连接名（省略用缺省连接）' },
        script: { type: 'string', description: '脚本全文（≤2MB、≤10000 条语句）' },
        on_error: { type: 'string', enum: ['abort', 'continue'], description: '失败策略（省略 abort=失败即停）' },
        dryrun: { type: 'boolean', description: 'true=只做静态分析并返回语句清单' },
      },
      required: ['script'],
    },
  },
  {
    name: 'script_status',
    description: '查询脚本执行状态：pending（待批准）/ denied / running（后台执行中）/ executed（含逐条摘要）/ exec_unknown（执行中断，勿重跑，先人工核查）/ not_found。',
    inputSchema: {
      type: 'object',
      properties: { requestId: { type: 'string', description: 'script_execute 返回的请求 ID' } },
      required: ['requestId'],
    },
  },
  {
    name: 'script_history',
    description: '查询脚本执行历史（谁/何时/哪个库/脚本号/结果）。历史仅供参考——是否重复执行由脚本自身幂等逻辑决定。',
    inputSchema: {
      type: 'object',
      properties: {
        connection: { type: 'string', description: '按连接过滤（省略=全部）' },
        limit: { type: 'number', description: '返回条数（缺省 20，上限 200）' },
      },
      required: [],
    },
  },
```

`METHOD_OF` 追加：

```js
  script_execute: 'scriptExecute',
  script_status: 'scriptStatus',
  script_history: 'scriptHistory',
```

`execute` 内参数映射追加：

```js
      if (mapped.on_error !== undefined) mapped.onError = mapped.on_error;
```

`render` 追加：

```js
  if (name === 'script_execute') {
    if (res.dryrun) {
      const lines = (res.statements ?? []).map((s) => `${s.idx}. [${s.cls}] L${s.line} ${s.keyword}${s.tables?.length ? ` → ${s.tables.join(',')}` : ''}`);
      return `静态分析（未执行）：${res.statements?.length ?? 0} 条语句${res.scriptNo ? ` · 脚本号 ${res.scriptNo}` : ''}\n${lines.join('\n')}`;
    }
    if (res.note) return `脚本${res.note}——未执行。`;
    return `脚本执行请求已创建（requestId: ${res.requestId}，${res.summary?.statementCount ?? '?'} 条语句${res.scriptNo ? ` · 脚本号 ${res.scriptNo}` : ''}），等待用户批准。请提醒用户后调用 script_status 轮询——批准前不会执行任何语句。`;
  }
  if (name === 'script_status') {
    if (res.status === 'pending') return '仍在等待用户批准脚本执行。';
    if (res.status === 'denied') return `用户拒绝了脚本执行。${res.note ? `附言：${res.note}` : ''}`;
    if (res.status === 'running') return '脚本正在后台执行，请稍候继续轮询。';
    if (res.status === 'exec_unknown') return `执行结果未知（中断）：${res.note ?? ''}请人工核查数据库状态，勿直接重跑。`;
    if (res.status === 'executed') {
      const r = res.result ?? {};
      const once = res.replayed ? '（本次返回缓存结果）' : '';
      if (r.ok === false) {
        return `脚本执行失败${once}：已执行 ${r.executed}/${r.total} 条；失败在第 ${r.failedAtIndex} 条（第 ${r.error?.line} 行）——${r.error?.message ?? ''}`;
      }
      return `脚本已执行${once}：${r.executed}/${r.total} 条语句成功，耗时 ${r.durationMs}ms。`;
    }
    return `状态: ${res.status}${res.note ? `（${res.note}）` : ''}`;
  }
  if (name === 'script_history') {
    if (!res.entries?.length) return '（暂无脚本执行历史）';
    return res.entries.map((e) => `- ${new Date(e.at).toISOString()} ${e.connection} ${e.scriptNo ?? '-'} ${e.result}${e.failedAtIndex ? ` @第${e.failedAtIndex}条` : ''}${e.errorSummary ? `（${e.errorSummary}）` : ''}`).join('\n');
  }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd /Users/stbearangel/dev/AiProject/momo-plugin && npx vitest run tests/db-pro/tools.test.mjs`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
cd /Users/stbearangel/dev/AiProject/momo-plugin
git add plugins/db-pro/tools/index.js tests/db-pro/tools.test.mjs
git commit -m "feat(db-pro): 新增 script_execute/script_status/script_history 工具"
```

---

### Task 11: 真实模板端到端（MySQL 幂等两次执行）+ 文档

**Files:**
- Create: `tests/db-pro/script-e2e.integration.test.mjs`
- Modify: `plugins/db-pro/README.md`

**Interfaces:**
- Consumes: Task 1–10 全部模块（splitter + engine + drivers）。
- Produces: 真实 DAP-E 模板形状的端到端验证：一次执行成功、二次执行整体 SKIP。

- [ ] **Step 1: 写集成测试**

```js
// tests/db-pro/script-e2e.integration.test.mjs
import { describe, it, expect } from 'vitest';
import { createDispatcher } from '../../plugins/db-pro/engine/engine.js';

const ON = process.env.DBPRO_INTEGRATION === '1';
const MYSQL_URL = process.env.DBPRO_MYSQL ?? 'mysql://root:dbpro123@127.0.0.1:13306/dbpro';

// DAP-E 种子脚本模板形状（不硬编码业务表名——模板自建演示表与日志表）
const SCRIPT = `
SET @__script_no = 'S_TEST_0001';
DELIMITER //
CREATE PROCEDURE p_demo_seed()
BEGIN
  DECLARE v_done INT DEFAULT 0;
  DECLARE EXIT HANDLER FOR SQLEXCEPTION
  BEGIN
    ROLLBACK;
    INSERT INTO script_log (script_no, ok) VALUES (@__script_no, 0);
    RESIGNAL;
  END;
  SELECT COUNT(*) INTO v_done FROM script_log WHERE script_no = @__script_no AND ok = 1;
  IF v_done > 0 THEN
    SELECT 'SKIP' AS result;
  ELSE
    START TRANSACTION;
    INSERT INTO seed_t (name) VALUES ('a');
    INSERT INTO seed_t (name) VALUES ('b');
    INSERT INTO script_log (script_no, ok) VALUES (@__script_no, 1);
    COMMIT;
    SELECT 'DONE' AS result;
  END IF;
END //
DELIMITER ;
CALL p_demo_seed();
`;

describe.skipIf(!ON)('MySQL 脚本 E2E · DAP-E 模板形状', () => {
  it('首次执行落库、二次执行整体 SKIP', async () => {
    const pools = new Map();
    const d = createDispatcher(undefined, pools);
    // 建演示表（走既有 exec 通道）
    await d.dispatch('configure', { connections: [{ name: 'e2e', url: MYSQL_URL, queryTimeoutMs: 30_000 }] });
    await d.dispatch('exec', { connection: 'e2e', sql: 'DROP TABLE IF EXISTS script_log' });
    await d.dispatch('exec', { connection: 'e2e', sql: 'DROP TABLE IF EXISTS seed_t' });
    await d.dispatch('exec', { connection: 'e2e', sql: 'DROP PROCEDURE IF EXISTS p_demo_seed' });
    await d.dispatch('exec', { connection: 'e2e', sql: 'CREATE TABLE seed_t (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(20))' });
    await d.dispatch('exec', { connection: 'e2e', sql: 'CREATE TABLE script_log (script_no VARCHAR(40), ok TINYINT)' });

    const first = await d.dispatch('scriptRun', { connection: 'e2e', script: SCRIPT, onError: 'abort' });
    expect(first.ok).toBe(true);
    expect(first.executed).toBeGreaterThanOrEqual(4);

    const rows1 = await d.dispatch('query', { connection: 'e2e', sql: 'SELECT COUNT(*) AS n FROM seed_t', maxRows: 10 });
    expect(Number(rows1.rows[0][0])).toBe(2);

    const second = await d.dispatch('scriptRun', { connection: 'e2e', script: SCRIPT, onError: 'abort' });
    expect(second.ok).toBe(true);

    const rows2 = await d.dispatch('query', { connection: 'e2e', sql: 'SELECT COUNT(*) AS n FROM seed_t', maxRows: 10 });
    expect(Number(rows2.rows[0][0])).toBe(2); // 幂等：无新增

    await d.dispatch('exec', { connection: 'e2e', sql: 'DROP PROCEDURE IF EXISTS p_demo_seed' });
    await d.dispatch('exec', { connection: 'e2e', sql: 'DROP TABLE IF EXISTS script_log' });
    await d.dispatch('exec', { connection: 'e2e', sql: 'DROP TABLE IF EXISTS seed_t' });
    for (const h of pools.values()) await h.pool.close().catch(() => undefined);
  }, 120_000);
});
```

- [ ] **Step 2: 跑测试确认失败/通过定位**

Run: `cd /Users/stbearangel/dev/AiProject/momo-plugin && DBPRO_INTEGRATION=1 NODE_OPTIONS=--openssl-legacy-provider npx vitest run tests/db-pro/script-e2e.integration.test.mjs`
Expected: 首次运行暴露真实驱动/切分问题（如 DELIMITER 行号、CALL 执行），逐一修复——本任务即“真实运行时语义”回归锁。

- [ ] **Step 3: 修复暴露的问题（仅修到测试绿，不扩大范围）**

常见修复点：
- MySQL `CALL p_demo_seed()` 返回多结果集时 mysql2 的 `[res]` 形态不同 → `openSession().exec` 兼容数组/对象/多结果集。
- `DELIMITER` 行在 `atLineStart` + `buf` 含前一条语句残留换行 → `flush` 后重置 `buf` 与 `atLineStart`。

- [ ] **Step 4: README 增补脚本通道说明**

`plugins/db-pro/README.md` 追加一节（中文）：

```markdown
## 脚本执行通道（script_execute）

- 支持一次提交多语句脚本（MySQL `DELIMITER`、PG 美元引用、Oracle/DM PL/SQL 块与 `/`）。
- 流程：`script_execute` → 用户在「人工请求」面板批准 → 后台执行 → `script_status` 轮询。
- `dryrun: true` 只做静态分析（语句清单/目标表/分类计数），不连库不审批。
- 幂等/留痕由脚本自身实现；工具只记录通用执行历史（`script_history`）。
- 限额：脚本 ≤ 2MB、语句 ≤ 10000、整脚本超时缺省 600s（`script_timeout_ms`）。
```

- [ ] **Step 5: 全量回归 + 提交**

Run: `cd /Users/stbearangel/dev/AiProject/momo-plugin && npx vitest run tests/db-pro/ && DBPRO_INTEGRATION=1 NODE_OPTIONS=--openssl-legacy-provider npx vitest run tests/db-pro/script-session.integration.test.mjs tests/db-pro/script-e2e.integration.test.mjs`
Expected: 全部 PASS

```bash
cd /Users/stbearangel/dev/AiProject/momo-plugin
git add tests/db-pro/script-e2e.integration.test.mjs plugins/db-pro/README.md
git commit -m "test(db-pro): 脚本通道真实模板 E2E（幂等二次执行 SKIP）"
```

---

## 手工验收清单（A 期收口，宿主零改动验证）

代码任务全绿后，在 dev app（`pnpm dev`，tmux `momo-dev`）与用户 profile 四连接上走一遍：

1. **审批卡渲染**：agent 调 `script_execute`（连接 `mysql`，贴 S00971511 全文）→ 人工请求面板出现「脚本执行：S00971511 · mysql · N 语句」卡，正文含分类计数/目标表/风险/头部预览；payload 中的 `script` 全文不显示在卡片上。
2. **批准链路**：批准 → `script_status` 先返回 running，后返回 executed（计数正确）；拒绝一次 → denied 带附言。
3. **幂等验证**：对真实 dev 库（`dape_dev_84`）执行 S00971511 两遍——第二遍响应中脚本自身返回 SKIP、业务表无重复行。
4. **exec_unknown**：执行中 kill 引擎进程（`pkill -f engine.js`）→ `script_status` 返回 exec_unknown，且再次轮询不重跑。
5. **历史可查**：`script_history` 能看到上述记录的库/脚本号/结果。
6. **既有通道回归**：`query` / `write` / `write_status` 行为与 A 期前一致（宿主全量测试 + 手测一条写）。

---

## 执行裁定（本轮）

- 用户已裁定：**不委派子 agent**，本会话直做（`superpowers:executing-plans` 路径）。
- A 期完成后：真机验收（dev app + 四库 docker）→ 更新 spec 验收状态 → 用户审阅后合并；B 期（连接面板 + 权限矩阵）另写计划（接口以 A 期实测为准）。
- 版本号纪律：本轮不触碰任何 `package.json` 版本。
