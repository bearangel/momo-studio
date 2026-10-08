# 通用工作空间外写授权（目录白名单）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 v2.5 工具链专项写授权泛化为通用目录白名单——agent 任何工作空间外写被拦时，主进程单点检测推送 `sandbox:writeBlocked` 事件，renderer 直弹授权卡（拒绝 / 本会话允许 / 本工作空间始终允许），授权按具体目录三层合成进沙箱 profile。

**Architecture:** 双检分工（子进程 append 提示段答 agent；主进程 stream-relay onFlush 事件检测答用户卡）；授权数据走 kv_store（session/ws 两键，会话删除即清理）；net-trust-op 应答只加 `extraDirs` 字段（子进程请求零改动，sessionId 由主进程从 streamSessionId 映射）；renderer 废除 6 环文本扫描链。

**Tech Stack:** Electron 主进程（CommonJS）+ React renderer（ESM）+ better-sqlite3 kv_store + zustand。

**Spec:** `docs/specs/2026-10-03-general-write-grant-design.md`（本计划的一切语义以 spec 为准；执行者须同时读 spec）

## Global Constraints

- Node 20（`nvm use 20`）；`npx pnpm@9.0.0`；测试 `cd electron && npx pnpm@9.0.0 vitest run <path>`（renderer 同理）
- TypeScript strict：禁 `any` / `@ts-ignore` / `as any`（ESLint error 机械强制）
- 注释中文、标识符英文；Conventional Commits（`feat:` / `fix:` / `test:` / `refactor:`）
- 线协议铁律：只加字段/只加通道，不改既有字段含义（momo-boundary-rules）
- IPC 契约变更必须双 workspace typecheck：`npx pnpm@9.0.0 typecheck`
- renderer UI 只用语义 token（`bg-surface-1` / `text-secondary` / `text-status-warning`），图标 lucide-react 16px stroke 1.75，禁 emoji
- 单测位置：electron 集中 `electron/tests/`（镜像 src）；renderer 贴源 colocated
- 宿主已知怪癖：`tests/settings/` 需 `--pool=forks` 单跑；全量跑遇 SIGSEGV 先分目录重跑判定 flaky（stash 对照法判回归）

## Review Focus

1. **cargo 实录 stdout-only EPERM 带路径**（曾整链漏检的原始 bug 形态）→ Task 2 语料测试锁 `detectWriteBlocked` + `extractBlockedPaths`
2. **路径提取失败（空 dirs）卡死路**——按钮可点但授权空数组 → Task 7 降级测试（两授权按钮禁用、仅去设置）
3. **旧子进程载荷（无 workspaceId / 无 sessionId 映射失败）**——兼容破坏或误授予 → Task 3 兼容测试（extraDirs 空数组不抛错）
4. **agent 重试事件风暴**——同 dirs 重复推送反复弹卡 → Task 7 去重测试（pending 覆盖不重弹）
5. **会话/工作空间删除后授权残留**（越权残留面）→ Task 1 清理挂接测试（deleteSession/deleteWorkspace 后 KV 键消失）

---

### Task 1: write-grant 存储层（KV 读写 + 生命周期清理）

**Files:**
- Create: `electron/src/main/sandbox/write-grant.ts`
- Modify: `electron/src/main/storage/sessions/repo.ts`（deleteSession，约 :92）
- Modify: `electron/src/main/workspace/crud.ts`（deleteWorkspace，约 :113 附近）
- Test: `electron/tests/sandbox/write-grant.test.ts`

**Interfaces:**
- Consumes: `expandToolchainDirs(raw: string[], home: string, opts?): string[]`（toolchain-grant.ts 既有——绝对路径原样透传 + realpath 归一，复用作归一化器）；`getDb()`。
- Produces（后续 Task 3/5 依赖，签名精确）:
  - `grantWriteDirs(scope: 'session' | 'workspace', key: string, dirs: string[]): void`
  - `revokeWriteDir(scope: 'session' | 'workspace', key: string, dir: string): void`
  - `getGrantedDirs(sessionId: string | null, workspaceId: string | null): string[]`（两键合并、已归一去重；null 键跳过该层）
  - `listWorkspaceGrants(): Array<{ workspaceId: string; dirs: string[] }>`（设置页 Task 8 用）
  - `clearSessionGrants(sessionId: string): void` / `clearWorkspaceGrants(workspaceId: string): void`
  - `__clearWriteGrantsForTest(): void`

- [ ] **Step 1: 写失败测试**

```typescript
// electron/tests/sandbox/write-grant.test.ts
// write-grant 存储层（spec §3/§4）：KV 两键读写、三层合成、生命周期清理。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  grantWriteDirs, revokeWriteDir, getGrantedDirs, listWorkspaceGrants,
  clearSessionGrants, clearWorkspaceGrants, __clearWriteGrantsForTest,
} from '../../src/main/sandbox/write-grant';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { deleteSession } from '../../src/main/storage/sessions/repo';

const tmpRoot = path.join(os.tmpdir(), `write-grant-test-${Date.now()}`);

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  __clearWriteGrantsForTest();
});
afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

describe('write-grant 存储（spec §3/§4）', () => {
  it('grantWriteDirs 归一化存储：~/ 前缀展开 + 去重', () => {
    const home = os.homedir();
    grantWriteDirs('session', 's-1', ['~/.cargo', `${home}/.cargo`, '/opt/local/lib']);
    const dirs = getGrantedDirs('s-1', null);
    // ~/ 展开与绝对路径字面重复 → 归一去重后 2 条
    expect(dirs).toHaveLength(2);
    expect(dirs).toContain(path.join(home, '.cargo'));
    expect(dirs).toContain('/opt/local/lib');
  });

  it('会话层 ∪ 工作空间层合并；null 键跳过该层', () => {
    grantWriteDirs('session', 's-1', ['/tmp/a']);
    grantWriteDirs('workspace', 'w-1', ['/tmp/b']);
    expect(getGrantedDirs('s-1', 'w-1').sort()).toEqual(['/tmp/a', '/tmp/b']);
    expect(getGrantedDirs(null, 'w-1')).toEqual(['/tmp/b']);
    expect(getGrantedDirs('s-1', null)).toEqual(['/tmp/a']);
    expect(getGrantedDirs(null, null)).toEqual([]);
  });

  it('revokeWriteDir 移除单条；不存在的 dir no-op', () => {
    grantWriteDirs('workspace', 'w-1', ['/tmp/a', '/tmp/b']);
    revokeWriteDir('workspace', 'w-1', '/tmp/a');
    expect(getGrantedDirs(null, 'w-1')).toEqual(['/tmp/b']);
    expect(() => revokeWriteDir('workspace', 'w-1', '/nope')).not.toThrow();
  });

  it('KV 持久：重读仍有效（重启语义）', () => {
    grantWriteDirs('session', 's-1', ['/tmp/x']);
    // 直接读 kv_store 验证落库形状（JSON 数组）
    const row = getDb().prepare(
      "SELECT value FROM kv_store WHERE key = 'sandbox_write_grant_session_s-1'",
    ).get() as { value: string };
    expect(JSON.parse(row.value)).toEqual(['/tmp/x']);
  });

  it('listWorkspaceGrants 列出全部工作空间授权', () => {
    grantWriteDirs('workspace', 'w-1', ['/tmp/a']);
    grantWriteDirs('workspace', 'w-2', ['/tmp/b']);
    const all = listWorkspaceGrants().sort((x, y) => x.workspaceId.localeCompare(y.workspaceId));
    expect(all).toEqual([
      { workspaceId: 'w-1', dirs: ['/tmp/a'] },
      { workspaceId: 'w-2', dirs: ['/tmp/b'] },
    ]);
  });

  it('生命周期：clearSessionGrants / deleteSession 挂接清理（spec §4）', () => {
    grantWriteDirs('session', 's-1', ['/tmp/a']);
    clearSessionGrants('s-1');
    expect(getGrantedDirs('s-1', null)).toEqual([]);
    // deleteSession 挂接验证：再授一个后走会话删除
    grantWriteDirs('session', 's-2', ['/tmp/b']);
    deleteSession('s-2');
    expect(getGrantedDirs('s-2', null)).toEqual([]);
    const cnt = getDb().prepare(
      "SELECT COUNT(*) AS c FROM kv_store WHERE key = 'sandbox_write_grant_session_s-2'",
    ).get() as { c: number };
    expect(cnt.c).toBe(0);
  });

  it('生命周期：deleteWorkspace 挂接清理工作空间键', () => {
    // workspace/crud.ts 删除路径（实现里挂 clearWorkspaceGrants）
    const { deleteWorkspace } = await import('../../src/main/workspace/crud');
    // （workspace 插入略——crud 测试基建重；此处直接验证函数挂接：手工插入行）
    grantWriteDirs('workspace', 'w-del', ['/tmp/a']);
    getDb().prepare(
      'INSERT INTO workspaces (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)',
    ).run('w-del', '临时', Date.now(), Date.now());
    deleteWorkspace('w-del');
    expect(getGrantedDirs(null, 'w-del')).toEqual([]);
  });
});
```

注意：`workspaces` 表列名以实际 schema 为准（执行时先 `PRAGMA table_info(workspaces)` 对齐；insert 列不匹配时按实际列改写测试夹具，断言不变）。

- [ ] **Step 2: 跑红**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/sandbox/write-grant.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

```typescript
// electron/src/main/sandbox/write-grant.ts
// 通用写授权存储（spec §3/§4）：session/ws 两键 KV，值为归一化绝对路径数组。
// 会话授权随 deleteSession 清理；工作空间授权随 deleteWorkspace 清理。
import os from 'node:os';
import { getDb } from '../storage/db';
import { expandToolchainDirs } from './toolchain-grant';

type Scope = 'session' | 'workspace';

function kvKey(scope: Scope, key: string): string {
  return scope === 'session'
    ? `sandbox_write_grant_session_${key}`
    : `sandbox_write_grant_ws_${key}`;
}

function readKey(scope: Scope, key: string): string[] {
  const row = getDb().prepare('SELECT value FROM kv_store WHERE key = ?').get(kvKey(scope, key)) as
    | { value: string }
    | undefined;
  if (!row) return [];
  try {
    const parsed = JSON.parse(row.value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((d): d is string => typeof d === 'string');
  } catch {
    return []; // 损坏行按空处理（账本卫生不抛错）
  }
}

function writeKey(scope: Scope, key: string, dirs: string[]): void {
  getDb()
    .prepare(
      `INSERT INTO kv_store (key, value, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
    )
    .run(kvKey(scope, key), JSON.stringify(dirs));
}

/** 授权（spec §3）：写入前归一化（~/ 展开 + realpath 去重——复用 expandToolchainDirs 的绝对路径透传语义） */
export function grantWriteDirs(scope: Scope, key: string, dirs: string[]): void {
  const normalized = expandToolchainDirs(dirs, os.homedir());
  if (normalized.length === 0) return;
  const merged = [...new Set([...readKey(scope, key), ...normalized])];
  writeKey(scope, key, merged);
}

export function revokeWriteDir(scope: Scope, key: string, dir: string): void {
  writeKey(scope, key, readKey(scope, key).filter((d) => d !== dir));
}

/** 三层合成的动态两层（预置清单在 resolveShellSpawn 另行合成）——null 键跳过该层 */
export function getGrantedDirs(sessionId: string | null, workspaceId: string | null): string[] {
  const out: string[] = [];
  if (sessionId !== null) out.push(...readKey('session', sessionId));
  if (workspaceId !== null) out.push(...readKey('workspace', workspaceId));
  return [...new Set(out)];
}

/** 设置页（spec §8）：全部工作空间持久授权 */
export function listWorkspaceGrants(): Array<{ workspaceId: string; dirs: string[] }> {
  const rows = getDb()
    .prepare("SELECT key, value FROM kv_store WHERE key LIKE 'sandbox_write_grant_ws_%'")
    .all() as Array<{ key: string; value: string }>;
  return rows.map((r) => ({
    workspaceId: r.key.slice('sandbox_write_grant_ws_'.length),
    dirs: readKey('workspace', r.key.slice('sandbox_write_grant_ws_'.length)),
  }));
}

export function clearSessionGrants(sessionId: string): void {
  getDb().prepare('DELETE FROM kv_store WHERE key = ?').run(kvKey('session', sessionId));
}

export function clearWorkspaceGrants(workspaceId: string): void {
  getDb().prepare('DELETE FROM kv_store WHERE key = ?').run(kvKey('workspace', workspaceId));
}

export function __clearWriteGrantsForTest(): void {
  getDb()
    .prepare("DELETE FROM kv_store WHERE key LIKE 'sandbox_write_grant_%'")
    .run();
}
```

挂接清理（两处各加一行 + 中文注释）：

`storage/sessions/repo.ts` `deleteSession`：
```typescript
import { clearSessionGrants } from '../../sandbox/write-grant';
export function deleteSession(id: string): void {
  getDb().prepare('DELETE FROM sessions WHERE id = ?').run(id);
  // 会话授权随会话清理（spec §4 生命周期）——storage 层不 import 业务层的循环
  // 依赖检查：sandbox/write-grant 只依赖 storage/db，方向安全
  clearSessionGrants(id);
}
```

`workspace/crud.ts` `deleteWorkspace`（:113 的 DELETE 语句后）：
```typescript
clearWorkspaceGrants(id);
```
（import 与注释同理；若该函数有事务包裹，清理放事务内同一语句组。）

- [ ] **Step 4: 跑绿**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/sandbox/write-grant.test.ts`
Expected: PASS（6 用例全绿；workspaces 夹具列名若不符按实际 schema 修夹具）

- [ ] **Step 5: 相邻回归 + 提交**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/sandbox/ tests/storage/`
Expected: PASS（storage 套件不因 import 方向破坏）

```bash
git add electron/src/main/sandbox/write-grant.ts electron/tests/sandbox/write-grant.test.ts electron/src/main/storage/sessions/repo.ts electron/src/main/workspace/crud.ts
git commit -m "feat(sandbox): write-grant 存储层——KV 两键 + 生命周期清理挂接"
```

---

### Task 2: 检测通用化 + 路径提取器（纯函数层）

**Files:**
- Modify: `electron/src/main/agent/tools/sandbox-write-hint.ts`（全文重构）
- Modify: `electron/src/main/agent/tools/shell-tools.ts`（检测调用点改名 + 传 stdout，现状已传）
- Test: `electron/tests/agent/tools/sandbox-write-hint.test.ts`（重写扩展）

**Interfaces:**
- Produces（Task 4 主进程检测复用同一模块——纯函数无 DB/子进程依赖，双端可 import）:
  - `detectWriteBlocked(tag: string, command: string, stderr: string, stdout = ''): boolean`（取代 `detectHomeWriteBlocked`）
  - `extractBlockedPaths(command: string, stderr: string, stdout = ''): string[]`（原始绝对路径候选，去重上限 3）
  - `normalizeGrantDirs(paths: string[], home: string): string[]`（HOME 一级归并 / 非 HOME 最近存在祖先；去重上限 3）
  - `WRITE_BLOCKED_HINT: string`（通用版文案，spec §6.5）

- [ ] **Step 1: 重写测试（含实录语料）**

```typescript
// electron/tests/agent/tools/sandbox-write-hint.test.ts —— 关键新增用例（保留并改造既有断言风格）
import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import {
  detectWriteBlocked, extractBlockedPaths, normalizeGrantDirs, WRITE_BLOCKED_HINT,
} from '../../../src/main/agent/tools/sandbox-write-hint';

// 2026-10-03 hello-rust 会话实录（seq 964 形态）：cargo 错误全在 stdout、带完整路径
const CARGO_STDOUT = [
  '    Updating crates.io index',
  'error: failed to download `fastrand v2.5.0`',
  '',
  'Caused by:',
  `  failed to open /Users/tester/.cargo/registry/cache/index.crates.io-6f17d22bba15001f/fastrand-2.5.0.crate`,
  '',
  'Caused by:',
  '  Operation not permitted (os error 1)',
].join('\n');

describe('detectWriteBlocked（通用化，spec §5.2）', () => {
  it('cargo 实录：stdout-only EPERM + 路径 → 触发（原 P0 形态回归锁）', () => {
    expect(detectWriteBlocked('seatbelt/net-on', 'cargo build', '', CARGO_STDOUT)).toBe(true);
  });
  it('cp stderr EPERM（非 HOME 路径）→ 触发（通用化：HOME 特征不再是必要条件）', () => {
    expect(detectWriteBlocked('bwrap/net-on', 'cp a.txt /opt/local/lib/x.txt', 'cp: /opt/local/lib/x.txt: Operation not permitted', '')).toBe(true);
  });
  it('非沙箱 tag 不触发；无写拒绝签名不触发', () => {
    expect(detectWriteBlocked('win-powershell', 'cargo build', '', CARGO_STDOUT)).toBe(false);
    expect(detectWriteBlocked('seatbelt/net-on', 'ls ~', 'some noise', '')).toBe(false);
  });
});

describe('extractBlockedPaths（spec §5.2 路径提取器）', () => {
  it('cargo 实录：提取 ~/.cargo/registry/... crate 路径', () => {
    const paths = extractBlockedPaths('cargo build', '', CARGO_STDOUT);
    expect(paths).toContain('/Users/tester/.cargo/registry/cache/index.crates.io-6f17d22bba15001f/fastrand-2.5.0.crate');
  });
  it('cp stderr：提取错误行路径', () => {
    expect(extractBlockedPaths('cp a /opt/x', 'cp: /opt/x: Operation not permitted', ''))
      .toContain('/opt/x');
  });
  it('无路径错误 → 空数组（降级路径语料）', () => {
    expect(extractBlockedPaths('something', 'Operation not permitted', '')).toEqual([]);
  });
});

describe('normalizeGrantDirs（spec §5.2 归一：显示即所授）', () => {
  const home = os.homedir();
  it('HOME 下路径归并到 HOME 第一级（~/.cargo/registry/x → ~/.cargo）', () => {
    expect(normalizeGrantDirs([path.join(home, '.cargo/registry/cache/a.crate')], home))
      .toEqual([path.join(home, '.cargo')]);
  });
  it('非 HOME 路径取最近存在祖先（/tmp 必存在）', () => {
    const out = normalizeGrantDirs(['/tmp/momo-sb-123/a/b/c.sb'], '/nonexistent-home');
    expect(out).toEqual(['/tmp']);
  });
  it('去重 + 上限 3', () => {
    const out = normalizeGrantDirs([
      path.join(home, '.cargo/registry/a'), path.join(home, '.cargo/git/db/b'),
      path.join(home, '.rustup/toolchains/c'), path.join(home, '.go/d'),
    ], home);
    expect(out).toEqual([path.join(home, '.cargo'), path.join(home, '.rustup'), path.join(home, '.go')].map(p => p).slice(0, 3));
  });
});

describe('WRITE_BLOCKED_HINT 文案（spec §6.5 通用版）', () => {
  it('新前缀句 + 指引授权卡 + 反绕过三要素', () => {
    expect(WRITE_BLOCKED_HINT).toContain('工作空间外路径写入被沙箱拦截');
    expect(WRITE_BLOCKED_HINT).toContain('授权');
    expect(WRITE_BLOCKED_HINT).toContain('不要用临时目录或缓存重定向绕过');
  });
});
```

（`normalizeGrantDirs` 第三例断言里去掉多余的 `.map(p => p)`——写成 `expect(out).toEqual([path.join(home,'.cargo'), path.join(home,'.rustup'), path.join(home,'.go')].slice(0,3))`；`.go/d` 归并为 `~/.go`。）

- [ ] **Step 2: 跑红**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/agent/tools/sandbox-write-hint.test.ts`
Expected: FAIL（新函数不存在 / 旧函数名残留）

- [ ] **Step 3: 实现（sandbox-write-hint.ts 全文）**

```typescript
// electron/src/main/agent/tools/sandbox-write-hint.ts
// 沙箱写拦截检测 + 提示 + 路径提取（spec §5.2）——纯函数，子进程（append 提示）
// 与主进程（writeBlocked 事件检测）双端复用。
// 2026-10-03 通用化：HOME 特征从触发必要条件降级为提取辅助；新增路径提取与归一。

/** 写拒绝签名（合并扫描 stderr+stdout——cargo 家族错误打 stdout，实录教训） */
const WRITE_DENY_SIGNATURES: RegExp[] = [
  /Operation not permitted/i,
  /Permission denied/i,
  /Read-only file system/i,
  /Read-only filesystem/i,
];

/** 沙箱化 tag 前缀（seatbelt/bwrap；win/plain/unsandboxed 不检） */
const SANDBOXED_TAG = /^(?:seatbelt|bwrap)\//;

/** 路径 token：绝对路径（含 /Users、/home、/tmp、/opt、/usr、/var、/private 前缀场景自然覆盖） */
const PATH_TOKEN = /(?<![\w~])(\/[^\s'"`:,;|<>()[\]]+)/g;

export function detectWriteBlocked(tag: string, command: string, stderr: string, stdout = ''): boolean {
  if (!SANDBOXED_TAG.test(tag)) return false;
  const combined = `${stderr}\n${stdout}`;
  return WRITE_DENY_SIGNATURES.some((re) => re.test(combined));
}

export function extractBlockedPaths(command: string, stderr: string, stdout = ''): string[] {
  const combined = `${stderr}\n${stdout}`;
  if (!WRITE_DENY_SIGNATURES.some((re) => re.test(combined))) return [];
  const out: string[] = [];
  const collect = (text: string): void => {
    for (const line of text.split('\n')) {
      // 只从「错误相关行」提路径：含签名、Caused by、failed、cannot、denied 的行
      if (!/(error|caused by|failed|cannot|denied|not permitted|permission)/i.test(line)) continue;
      for (const m of line.matchAll(PATH_TOKEN)) {
        const p = m[1];
        if (!out.includes(p)) out.push(p);
        if (out.length >= 3) return;
      }
    }
  };
  collect(stderr);
  collect(stdout);
  collect(command); // 命令参数兜底（写命令目标）
  return out.slice(0, 3);
}

/** 归一（spec §5.2 显示即所授）：HOME 下归并到第一级；非 HOME 取最近存在祖先 */
export function normalizeGrantDirs(paths: string[], home: string): string[] {
  const out: string[] = [];
  for (const raw of paths) {
    let dir: string | null = null;
    if (raw.startsWith(`${home}/`)) {
      dir = path.join(home, raw.slice(home.length + 1).split('/')[0]);
    } else {
      // 最近存在祖先：逐级上溯到 fs 存在的目录（不存在的深路径上溯，/tmp 必命中）
      let cur: string | null = raw;
      while (cur !== null && cur !== '/') {
        try {
          fs.statSync(cur);
          dir = cur;
          break;
        } catch {
          const next = path.dirname(cur);
          cur = next === cur ? null : next;
        }
      }
    }
    if (dir !== null && !out.includes(dir)) out.push(dir);
    if (out.length >= 3) break;
  }
  return out;
}

export const WRITE_BLOCKED_HINT =
  '⚠ 工作空间外路径写入被沙箱拦截。请暂停后续重试并告知用户：用户界面会弹出授权卡（选择本会话或本工作空间放行具体目录），用户操作完成后重试同一命令即可。不要用临时目录或缓存重定向绕过。';
```

（文件头补 `import fs from 'node:fs'; import path from 'node:path';`；`command` 参数在 `extractBlockedPaths` 兜底收集。）

shell-tools.ts 调用点（现 :324 附近）：
```typescript
if (detectWriteBlocked(plan.tag, command, stderr, stdout)) {
  result += `\n\n${WRITE_BLOCKED_HINT}`;
}
```
import 行同步改名（删 `detectHomeWriteBlocked` import，新增 `detectWriteBlocked`）。旧导出 `detectHomeWriteBlocked` **直接删除**（调用点唯一，不留别名）。

- [ ] **Step 4: 跑绿 + 相邻回归**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/agent/tools/sandbox-write-hint.test.ts tests/agent/tools/shell-tools.test.ts tests/agent/tools/shell-net-trust.test.ts`
Expected: PASS（shell 套件随调用点改名通过；若 shell-net-trust 锁了旧函数名，同步改造其断言）

- [ ] **Step 5: 提交**

```bash
git add electron/src/main/agent/tools/sandbox-write-hint.ts electron/src/main/agent/tools/shell-tools.ts electron/tests/agent/tools/sandbox-write-hint.test.ts electron/tests/agent/tools/shell-net-trust.test.ts
git commit -m "feat(sandbox): 检测通用化 detectWriteBlocked + 路径提取器 + 归一规则"
```

---

### Task 3: 线协议扩展（handleNetTrustOp extraDirs + 桥 + resolveShellSpawn）

**Files:**
- Modify: `electron/src/main/sandbox/network-trust.ts`（handleNetTrustOp + NetTrustOpResult）
- Modify: `electron/src/main/agent/tools/net-trust-bridge.ts`（EffectiveNetworkDecision +extraDirs）
- Modify: `electron/src/main/agent/tools/shell-tools.ts`（execute 内 extraDirs 透传）
- Modify: `electron/src/main/sandbox/index.ts`（resolveShellSpawn opts）
- Modify: `electron/src/main/sandbox/types.ts`（ShellSandboxPolicy.toolchainDirs → extraWriteDirs）
- Modify: `electron/src/main/sandbox/policy.ts`、`electron/src/main/sandbox/macos.ts`、`electron/src/main/sandbox/linux.ts`（字段更名跟进）
- Test: `electron/tests/sandbox/network-trust.test.ts`、`electron/tests/sandbox/resolve-spawn.test.ts`

**Interfaces:**
- Consumes: Task 1 `getGrantedDirs(sessionId, workspaceId)`；Task 2 无依赖。
- Produces:
  - `NetTrustOpResult` ok payload：`{ netOn: boolean; toolchainOn: boolean; extraDirs: string[] }`
  - 桥 `EffectiveNetworkDecision`：同三字段（子进程镜像）
  - `resolveShellSpawn(workspaceDir, command, opts?: { networkEnabled?: boolean; toolchainEnabled?: boolean; extraDirs?: string[] })`
  - `ShellSandboxPolicy.extraWriteDirs: string[]`（预置 + 动态授权并集；macos/linux builder 消费字段更名）

- [ ] **Step 1: 写失败测试**

`network-trust.test.ts` 新增（沿用既有 describe 风格与 kv 夹具）：
```typescript
it('effective 返回 extraDirs：三层合成（session ∪ ws；预置在 spawn 侧另行合成）', async () => {
  grantWriteDirs('session', 's-1', ['/tmp/ses']);
  grantWriteDirs('workspace', 'w-1', ['/tmp/ws']);
  const r = await handleNetTrustOp({ type: 'net-trust-op', requestId: 'r1', op: 'effective', streamSessionId: 'ss-1', workspaceId: 'w-1' });
  // streamSessionId 'ss-1' 无消息映射 → sessionId null → 只 ws 层（兼容语义）
  expect(r).toEqual({ ok: true, payload: { netOn: false, toolchainOn: false, extraDirs: ['/tmp/ws'] } });
});

it('sessionId 经 streamSessionId 映射命中 → session 层参与合成', async () => {
  // 夹具：插一条 message，stream_session_id='ss-map'，session_id='s-map'
  // （messages 表 insert 按实际 schema 列名；workspace_id 给 'w-1'）
  grantWriteDirs('session', 's-map', ['/tmp/ses']);
  const r = await handleNetTrustOp({ type: 'net-trust-op', requestId: 'r2', op: 'effective', streamSessionId: 'ss-map', workspaceId: 'w-1' });
  expect(r.ok && r.payload.extraDirs).toContain('/tmp/ses');
});

it('旧载荷（无 workspaceId）→ extraDirs 恒空数组不抛错（兼容铁律）', async () => {
  const r = await handleNetTrustOp({ type: 'net-trust-op', requestId: 'r3', op: 'effective', streamSessionId: 'ss-x' });
  expect(r).toEqual({ ok: true, payload: { netOn: false, toolchainOn: false, extraDirs: [] } });
});
```

`resolve-spawn.test.ts` 新增：
```typescript
it('extraDirs 与预置清单并集进 policy（授权后下一次调用立即生效）', () => {
  __setSandboxSettingsForTest({ ...baseSettings, sandboxToolchainPolicy: 'deny' });
  const plan = resolveShellSpawn('/ws', 'cargo build', { toolchainEnabled: false, extraDirs: ['/tmp/granted'] });
  // 断言经 policy：wrapped 计划的 args 构建源——直接测 buildPolicy 产物或经 plan 序列化断言
  // （沿用本文件既有断言手法：seatbelt 场景断言 profile 文件内容含 /tmp/granted RW）
  const profile = fs.readFileSync((plan as { cleanupFiles: string[] }).cleanupFiles[0], 'utf-8');
  expect(profile).toContain('(allow file-write* (subpath "/tmp/granted"))');
});
```

（seatbelt RW 写法以 macos.ts 既有渲染模板为准——执行时对齐真实输出断言子串，如 `(subpath "/tmp/granted")`。）

- [ ] **Step 2: 跑红**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/sandbox/network-trust.test.ts tests/sandbox/resolve-spawn.test.ts`
Expected: FAIL（extraDirs 不存在）

- [ ] **Step 3: 实现**

`network-trust.ts`：
```typescript
import { getGrantedDirs } from './write-grant';
import { getMessageByStreamSessionId } from '../storage/messages/repo';

export type NetTrustOpResult =
  | { ok: true; payload: { netOn: boolean; toolchainOn: boolean; extraDirs: string[] } }
  | { ok: false; error: string };

// handleNetTrustOp 内：
const toolchainOn = settings.toolchainPolicy === 'allow' ||
  (parsed.workspaceId !== undefined && false /* 旧 grants 已下线，toolchainOn 仅剩永久开关 */);
// extraDirs：streamSessionId → 聊天会话映射（主进程单点，子进程零改动，spec §5.3）
let sessionId: string | null = null;
try {
  sessionId = getMessageByStreamSessionId(parsed.streamSessionId)?.sessionId ?? null;
} catch { sessionId = null; }
const extraDirs = getGrantedDirs(sessionId, parsed.workspaceId ?? null);
return { ok: true, payload: { netOn, toolchainOn, extraDirs } };
```
（`hasToolchainGrant` import 删除；grants 判定不再存在——toolchainOn = 永久开关 || false。旧 `sandbox:grantToolchain` 走 Task 5 下线。）

注意：`getMessageByStreamSessionId` 精确命中 base；`#roll` 后缀行映射不到 → session 层缺省（保守安全方向，可接受；注释说明）。

`net-trust-bridge.ts`：
```typescript
export interface EffectiveNetworkDecision {
  netOn: boolean;
  toolchainOn: boolean;
  /** 通用写授权目录（spec §6.1）：主进程三层合成的动态两层（已归一绝对路径） */
  extraDirs: string[];
}
```
（应答解析处对缺 `extraDirs` 的旧主进程应答兜底 `?? []`——两端混跑安全。）

`shell-tools.ts` execute：
```typescript
net = await requestEffectiveNetwork(ctx.streamSessionId, ctx.workspaceId);
// ...
const plan = resolveShellSpawn(ctx.workspaceDir, command, net === null ? undefined : {
  networkEnabled: net.netOn,
  toolchainEnabled: net.toolchainOn,
  extraDirs: net.extraDirs,
});
```

`sandbox/index.ts`：
```typescript
export function resolveShellSpawn(
  workspaceDir: string,
  command: string,
  opts?: { networkEnabled?: boolean; toolchainEnabled?: boolean; extraDirs?: string[] },
): SpawnPlan {
  // 预置清单（授权态）∪ 动态授权目录（恒参与——授权即生效，与预置开关独立）
  const presetDirs = opts?.toolchainEnabled ? expandToolchainDirs(settings.toolchainDirs, os.homedir()) : [];
  const extraWriteDirs = [...new Set([...presetDirs, ...(opts?.extraDirs ?? [])])];
  const policy = buildPolicy(workspaceDir, networkEnabled, extraWriteDirs);
  // ...其余不变
```

`types.ts`：`ShellSandboxPolicy.toolchainDirs: string[]` → 更名 `extraWriteDirs: string[]`（注释更新为「预置清单 ∪ 动态授权并集」）；`policy.ts` / `macos.ts` / `linux.ts` 消费点字段名跟进（机械更名，行为不变）。

- [ ] **Step 4: 跑绿 + 相邻回归**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/sandbox/ tests/agent/tools/shell-sandbox-wiring.test.ts`
Expected: PASS（darwin 基线 1 失败为已知预存；其余全绿。resolve-spawn 既有 7 失败为宿主基线——只要求**不新增**失败）

- [ ] **Step 5: 提交**

```bash
git add electron/src/main/sandbox/ electron/src/main/agent/tools/net-trust-bridge.ts electron/src/main/agent/tools/shell-tools.ts electron/tests/sandbox/
git commit -m "feat(sandbox): net-trust-op 应答扩展 extraDirs + spawn 并集进 profile"
```

---

### Task 4: 主进程事件检测 + sandbox:writeBlocked 推送

**Files:**
- Create: `electron/src/main/sandbox/write-blocked-emit.ts`
- Modify: `electron/src/main/agent/stream-relay.ts`（getEventBuffer onFlush 内挂检测）
- Test: `electron/tests/sandbox/write-blocked-emit.test.ts`

**Interfaces:**
- Consumes: Task 2 `detectWriteBlocked / extractBlockedPaths / normalizeGrantDirs`；`getMessageByStreamSessionId`（sessionId/workspaceId 解析）。
- Produces:
  - `inspectEventBatch(events: MessageEventRow[]): WriteBlockedSignal | null`（纯检测：批次内 tool_call_result 命中 → 组装信号；command 由内部 callId→command 环形缓存关联——**有状态**，模块级 Map，上限 100）
  - `WriteBlockedSignal = { sessionId: string | null; workspaceId: string | null; dirs: string[]; command: string }`
  - stream-relay 接线：`const sig = inspectEventBatch(events); if (sig) win.webContents.send('sandbox:writeBlocked', sig);`

- [ ] **Step 1: 写失败测试**

```typescript
// electron/tests/sandbox/write-blocked-emit.test.ts
// 主进程事件检测（spec §5.1/§5.3）：批次 tool_call_result 命中 → 组装 writeBlocked 信号。
import { describe, it, expect, beforeEach } from 'vitest';
import { inspectEventBatch, __resetInspectStateForTest } from '../../src/main/sandbox/write-blocked-emit';
import type { MessageEventRow } from '../../src/main/storage/messages/events-repo';

function mkStart(callId: string, command: string): MessageEventRow {
  return { id: `e-${callId}-s`, messageId: 'm-1', seq: 1, eventType: 'tool_call_start',
    payload: { callId, toolName: 'bash', args: { command } }, createdAt: Date.now() } as MessageEventRow;
}
function mkResult(callId: string, result: string): MessageEventRow {
  return { id: `e-${callId}-r`, messageId: 'm-1', seq: 2, eventType: 'tool_call_result',
    payload: { callId, toolName: 'bash', result, success: false }, createdAt: Date.now() } as MessageEventRow;
}

const CARGO_FAIL = 'error: failed to open /Users/tester/.cargo/registry/cache/a.crate\n\nCaused by:\n  Operation not permitted (os error 1)';

describe('inspectEventBatch（spec §5.3）', () => {
  beforeEach(() => __resetInspectStateForTest());

  it('start+result 同批：命中 → dirs 归一 + command 关联', () => {
    const sig = inspectEventBatch([mkStart('c1', 'cargo build'), mkResult('c1', CARGO_FAIL)]);
    expect(sig).not.toBeNull();
    expect(sig!.command).toBe('cargo build');
    expect(sig!.dirs).toEqual(['/Users/tester/.cargo']); // HOME 一级归一
  });

  it('start 先批、result 后批：环形缓存跨批关联 command', () => {
    expect(inspectEventBatch([mkStart('c2', 'cargo run')])).toBeNull();
    const sig = inspectEventBatch([mkResult('c2', CARGO_FAIL)]);
    expect(sig?.command).toBe('cargo run');
  });

  it('非 bash / 未命中签名批次 → null', () => {
    expect(inspectEventBatch([mkResult('c3', 'ok output')])).toBeNull();
  });

  it('result 命中但消息映射缺消息行（无 sessionId）→ sessionId null（卡按钮降级依据）', () => {
    const sig = inspectEventBatch([mkStart('c4', 'x'), mkResult('c4', CARGO_FAIL)]);
    expect(sig?.sessionId).toBeNull();
  });
});
```
（sessionId/workspaceId 解析经 `getMessageByStreamSessionId(messageId 关联的 stream_session_id)`——`MessageEventRow` 无 streamSessionId，实现需经 `getMessage(messageId)` 拿 `streamSessionId + workspaceId` 再映射 session。测试用内存 DB 夹具插消息行（沿用 write-grant.test.ts 夹具法）；无行 → null 用例即测该降级。）

- [ ] **Step 2: 跑红**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/sandbox/write-blocked-emit.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

```typescript
// electron/src/main/sandbox/write-blocked-emit.ts
// 主进程 writeBlocked 检测（spec §5.1/§5.3）：stream-relay onFlush 批次的唯一消费者。
// callId→command 环形缓存跨批关联；sessionId/workspaceId 经 messages 表解析（缓存）。
import os from 'node:os';
import type { MessageEventRow } from '../storage/messages/events-repo';
import { getMessage, getMessageByStreamSessionId } from '../storage/messages/repo';
import { detectWriteBlocked, extractBlockedPaths, normalizeGrantDirs } from '../agent/tools/sandbox-write-hint';

const commandByCallId = new Map<string, string>();
const COMMAND_CACHE_MAX = 100;

export interface WriteBlockedSignal {
  sessionId: string | null;
  workspaceId: string | null;
  dirs: string[];
  command: string;
}

export function __resetInspectStateForTest(): void {
  commandByCallId.clear();
}

export function inspectEventBatch(events: MessageEventRow[]): WriteBlockedSignal | null {
  // 1) 缓存 start 的 command
  for (const e of events) {
    if (e.eventType !== 'tool_call_start') continue;
    const callId = e.payload.callId;
    const cmd = (e.payload.args as Record<string, unknown> | undefined)?.command;
    if (typeof callId === 'string' && typeof cmd === 'string' && cmd !== '') {
      if (commandByCallId.size >= COMMAND_CACHE_MAX) {
        const first = commandByCallId.keys().next().value;
        if (first !== undefined) commandByCallId.delete(first);
      }
      commandByCallId.set(callId, cmd);
    }
  }
  // 2) result 检测（bash 工具；tag 不在事件里——检测函数 tag 判定放宽：这里直接给沙箱前缀）
  for (const e of events) {
    if (e.eventType !== 'tool_call_result') continue;
    if (e.payload.toolName !== 'bash') continue;
    const result = e.payload.result;
    if (typeof result !== 'string') continue;
    const callId = e.payload.callId;
    const command = typeof callId === 'string' ? commandByCallId.get(callId) ?? '' : '';
    if (!detectWriteBlocked('seatbelt/x', command, result)) continue;
    const dirs = normalizeGrantDirs(extractBlockedPaths(command, result), os.homedir());
    // 3) 会话/工作空间解析（消息行缓存省每批 DB 往返）
    let sessionId: string | null = null;
    let workspaceId: string | null = null;
    try {
      const msg = getMessage(e.messageId);
      if (msg) {
        workspaceId = msg.workspaceId ?? null;
        sessionId = getMessageByStreamSessionId(msg.streamSessionId ?? '')?.sessionId ?? null;
      }
    } catch { /* DB 异常降级 null——卡按钮禁用路径 */ }
    return { sessionId, workspaceId, dirs, command: command.slice(0, 200) };
  }
  return null;
}
```
（`getMessage` 若 repo 无此按 id 函数，用既有的等价查询（`SELECT * FROM messages WHERE id = ?`）——执行时以 repo 实际导出名为准。`detectWriteBlocked` 的 tag 参数传 `'seatbelt/x'` 过前缀门：主进程侧不区分平台（bwrap/seatbelt 同语义），注释说明。）

stream-relay.ts `getEventBuffer` onFlush 内、`win.webContents.send('session:message_event_batch', ...)` 前后：
```typescript
// 通用写拦截检测（spec §5.3）：命中即推 sandbox:writeBlocked（renderer 直弹授权卡）
try {
  const signal = inspectEventBatch(events);
  if (signal) win.webContents.send('sandbox:writeBlocked', signal);
} catch { /* 检测失败不阻断消息主路径 */ }
```

- [ ] **Step 4: 跑绿 + relay 回归**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/sandbox/write-blocked-emit.test.ts tests/agent/stream-relay.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add electron/src/main/sandbox/write-blocked-emit.ts electron/src/main/agent/stream-relay.ts electron/tests/sandbox/write-blocked-emit.test.ts
git commit -m "feat(sandbox): 主进程事件检测 + sandbox:writeBlocked 推送"
```

---

### Task 5: IPC handlers（grantWrite/revokeWrite + grantToolchain 下线 + SandboxInfo 收缩）

**Files:**
- Modify: `electron/src/main/sandbox/ipc.handlers.ts`
- Modify: `electron/src/main/sandbox/toolchain-grant.ts`（grants Set 机制整体下线——spec §9）
- Test: `electron/tests/sandbox/ipc.handlers.test.ts`、`electron/tests/sandbox/toolchain-grant.test.ts`（grants 相关用例退役，expandToolchainDirs/DEFAULT_TOOLCHAIN_DIRS 用例保留）

**Interfaces:**
- Consumes: Task 1 `grantWriteDirs / revokeWriteDir`。
- Produces（Task 6/7 契约）:
  - `sandbox:grantWrite { scope: 'session' | 'workspace'; key: string; dirs: string[] }` → void（非法形状抛错）
  - `sandbox:revokeWrite { scope; key; dir: string }` → void
  - `SandboxInfo` 删 `toolchainPromptDismissed` 字段；`sandbox:grantToolchain` / `KV_TOOLCHAIN` / `grantToolchainWorkspace` import 删除

- [ ] **Step 1: 改测试（改造既有 grantToolchain 两用例 + 新增 grantWrite）**

`ipc.handlers.test.ts`：删除上一轮加的 `sandbox:grantToolchain` describe（两用例整体退役）；新增：
```typescript
describe('sandbox:grantWrite / revokeWrite', () => {
  it('grantWrite 写 KV（归一后）+ revokeWrite 移除', () => {
    const grant = ipcHandlers.get('sandbox:grantWrite') as (e: unknown, a: unknown) => void;
    grant(null, { scope: 'session', key: 's-1', dirs: ['/tmp/grant-a'] });
    const row = getDb().prepare("SELECT value FROM kv_store WHERE key='sandbox_write_grant_session_s-1'").get() as { value: string };
    expect(JSON.parse(row.value)).toEqual(['/tmp/grant-a']);
    const revoke = ipcHandlers.get('sandbox:revokeWrite') as (e: unknown, a: unknown) => void;
    revoke(null, { scope: 'session', key: 's-1', dir: '/tmp/grant-a' });
    expect(getDb().prepare("SELECT COUNT(*) c FROM kv_store WHERE key='sandbox_write_grant_session_s-1'").get()).toEqual({ c: 0 });
  });

  it('非法载荷（scope 越界 / key 空 / dirs 空）→ 抛错不写', () => {
    const grant = ipcHandlers.get('sandbox:grantWrite') as (e: unknown, a: unknown) => void;
    expect(() => grant(null, { scope: 'global', key: 'k', dirs: ['/tmp/a'] })).toThrow();
    expect(() => grant(null, { scope: 'session', key: '', dirs: ['/tmp/a'] })).toThrow();
    expect(() => grant(null, { scope: 'session', key: 'k', dirs: [] })).not.toThrow(); // 空数组归一后为空 → no-op 不抛
    expect(getDb().prepare("SELECT COUNT(*) c FROM kv_store WHERE key LIKE 'sandbox_write_grant_%'").get()).toEqual({ c: 0 });
  });

  it('sandbox:grantToolchain 通道已下线（不再注册）', () => {
    expect(ipcHandlers.has('sandbox:grantToolchain')).toBe(false);
  });

  it('SandboxInfo 不再含 toolchainPromptDismissed（事件驱动卡）', () => {
    expect('toolchainPromptDismissed' in buildInfo()).toBe(false);
  });
});
```
（`KV_TOOLCHAIN` 键名锁用例删除或改为断言导出不存在——随 import 一并退役。）

- [ ] **Step 2: 跑红 → Step 3: 实现 → Step 4: 跑绿**

`ipc.handlers.ts`：删 `grantToolchainWorkspace` import、`KV_TOOLCHAIN` 常量与 PROMPT_KV.toolchain 项、`sandbox:grantToolchain` handler、`SandboxInfo.toolchainPromptDismissed` 字段及 buildInfo 读行；`dismissPrompt` kind 收窄为 `'bwrap' | 'winPolicy' | 'netOff'`（PROMPT_KV 表同步）。新增：

`toolchain-grant.ts` 同步下线（spec §9：grants 机制被 write-grant 取代）：
```typescript
// 删除：const grants = new Set<string>()、grantToolchainWorkspace、hasToolchainGrant、
// __clearToolchainGrantsForTest —— 整段移除（DEFAULT_TOOLCHAIN_DIRS / expandToolchainDirs /
// resolveNpmPrefix / resolvePipUser / realpathOrResolve 保留——预置清单与归一化仍依赖）
```
连带清理引用：`tests/sandbox/toolchain-grant.test.ts` 删 grants 三函数用例（保留展开/默认清单用例）；`tests/sandbox/network-trust.test.ts` 若有 `__clearToolchainGrantsForTest` 引用改用 `__clearWriteGrantsForTest`。

```typescript
ipcMain.handle('sandbox:grantWrite', (_e, arg: unknown) => {
  const a = arg as { scope?: unknown; key?: unknown; dirs?: unknown };
  if (a.scope !== 'session' && a.scope !== 'workspace') throw new Error('scope 非法');
  if (typeof a.key !== 'string' || a.key === '') throw new Error('key 缺失');
  if (!Array.isArray(a.dirs) || a.dirs.some((d) => typeof d !== 'string')) throw new Error('dirs 非法');
  grantWriteDirs(a.scope, a.key, a.dirs);
  logger.info('写授权已授予', { scope: a.scope, key: a.key, count: a.dirs.length });
});
ipcMain.handle('sandbox:revokeWrite', (_e, arg: unknown) => {
  const a = arg as { scope?: unknown; key?: unknown; dir?: unknown };
  if (a.scope !== 'session' && a.scope !== 'workspace') throw new Error('scope 非法');
  if (typeof a.key !== 'string' || a.key === '') throw new Error('key 缺失');
  if (typeof a.dir !== 'string') throw new Error('dir 缺失');
  revokeWriteDir(a.scope, a.key, a.dir);
});
```

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/sandbox/ipc.handlers.test.ts`
Expected: PASS（本文件全绿）

- [ ] **Step 5: 提交**

```bash
git add electron/src/main/sandbox/ipc.handlers.ts electron/src/main/sandbox/toolchain-grant.ts electron/tests/sandbox/ipc.handlers.test.ts electron/tests/sandbox/toolchain-grant.test.ts electron/tests/sandbox/network-trust.test.ts
git commit -m "feat(sandbox): grantWrite/revokeWrite IPC + grants 机制下线"
```

---

### Task 6: renderer 契约与订阅（旧链废除 + onWriteBlocked）

**Files:**
- Modify: `renderer/src/ipc/types.d.ts`（sandbox 契约：删 grantToolchain，加 grantWrite/revokeWrite/onWriteBlocked；删 SandboxInfo.toolchainPromptDismissed）
- Modify: `electron/src/preload/index.ts`（同形状）
- Modify: `renderer/src/ipc/client.ts`（ipc.sandbox 方法）
- Modify: `renderer/src/stores/stream.store.ts`（删子串扫描链）
- Create: `renderer/src/stores/write-grant.store.ts`（pending 事件 + 拒绝记忆）
- Test: `renderer/src/stores/stream.store.test.ts`（删双端锁）、`renderer/src/stores/write-grant.store.test.ts`（新）

**Interfaces:**
- Consumes: Task 5 IPC 契约；Task 4 事件载荷 `WriteBlockedSignal`（renderer 镜像类型 `WriteBlockedEvent`）。
- Produces（Task 7/8 依赖）:
  - `WriteBlockedEvent = { sessionId: string | null; workspaceId: string | null; dirs: string[]; command: string }`（types.d.ts）
  - write-grant.store：`{ pending: WriteBlockedEvent | null; receiveWriteBlocked(e): void（同 dirs 覆盖去重）；denyPending(): void（记忆 `${sessionId}|${dirs.join(',')}）`；resolvePending(): void }` + `isDenied(e): boolean` 选择器
  - 订阅接线：App.tsx `useEffect(() => ipc.sandbox.onWriteBlocked((e) => useWriteGrantStore.getState().receiveWriteBlocked(e)), [])`

- [ ] **Step 1: write-grant.store 失败测试**

```typescript
// renderer/src/stores/write-grant.store.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { useWriteGrantStore } from './write-grant.store';

const EVT = { sessionId: 's-1', workspaceId: 'w-1', dirs: ['/Users/x/.cargo'], command: 'cargo build' };

beforeEach(() => useWriteGrantStore.getState().__resetForTest());

describe('write-grant.store（spec §5.3/§7）', () => {
  it('receive 置 pending；同 dirs 重复事件覆盖不重弹语义（引用替换）', () => {
    useWriteGrantStore.getState().receiveWriteBlocked(EVT);
    useWriteGrantStore.getState().receiveWriteBlocked({ ...EVT, command: 'cargo run' });
    const p = useWriteGrantStore.getState().pending;
    expect(p?.command).toBe('cargo run'); // 覆盖为最新
    expect(p).toBe(useWriteGrantStore.getState().pending); // 同引用（未清不重置）
  });

  it('denyPending 记忆同会话同 dirs：后续同 dirs 事件不再置 pending', () => {
    useWriteGrantStore.getState().receiveWriteBlocked(EVT);
    useWriteGrantStore.getState().denyPending();
    expect(useWriteGrantStore.getState().pending).toBeNull();
    useWriteGrantStore.getState().receiveWriteBlocked(EVT);
    expect(useWriteGrantStore.getState().pending).toBeNull(); // 被拒绝记忆压下
    useWriteGrantStore.getState().receiveWriteBlocked({ ...EVT, dirs: ['/other'] });
    expect(useWriteGrantStore.getState().pending).not.toBeNull(); // 不同 dirs 仍弹
  });

  it('resolvePending 清 pending 不记忆（授权成功路径）', () => {
    useWriteGrantStore.getState().receiveWriteBlocked(EVT);
    useWriteGrantStore.getState().resolvePending();
    expect(useWriteGrantStore.getState().pending).toBeNull();
    useWriteGrantStore.getState().receiveWriteBlocked(EVT);
    expect(useWriteGrantStore.getState().pending).not.toBeNull();
  });
});
```

- [ ] **Step 2: 跑红 → Step 3: 实现 store + 契约 + 订阅**

store（`renderer/src/stores/write-grant.store.ts`）：
```typescript
// 通用写授权卡状态（spec §5.3/§7）：pending=未处置事件；拒绝按 会话+dirs 记忆（内存，重启遗忘）。
import { create } from 'zustand';
import type { WriteBlockedEvent } from '../ipc/types';

const deniedKeys = new Set<string>();
const denyKey = (e: WriteBlockedEvent): string => `${e.sessionId ?? '∅'}|${e.dirs.join(',')}`;

interface WriteGrantState {
  pending: WriteBlockedEvent | null;
  receiveWriteBlocked: (e: WriteBlockedEvent) => void;
  denyPending: () => void;
  resolvePending: () => void;
  __resetForTest: () => void;
}

export const useWriteGrantStore = create<WriteGrantState>((set, get) => ({
  pending: null,
  receiveWriteBlocked: (e) => {
    if (deniedKeys.has(denyKey(e))) return; // 拒绝记忆（同会话同 dirs 不再骚扰）
    set({ pending: e }); // 覆盖式单卡（事件风暴去重，spec §5.3）
  },
  denyPending: () => {
    const p = get().pending;
    if (p) deniedKeys.add(denyKey(p));
    set({ pending: null });
  },
  resolvePending: () => set({ pending: null }),
  __resetForTest: () => { deniedKeys.clear(); set({ pending: null }); },
}));
```

契约三处同步（types.d.ts / preload / client）：
```typescript
// types.d.ts（renderer 独立定义，仅结构对齐）
export interface WriteBlockedEvent {
  sessionId: string | null;
  workspaceId: string | null;
  dirs: string[];
  command: string;
}
// sandbox 命名空间：删 grantToolchain/toolchainPromptDismissed；加——
grantWrite(arg: { scope: 'session' | 'workspace'; key: string; dirs: string[] }): Promise<void>;
revokeWrite(arg: { scope: 'session' | 'workspace'; key: string; dir: string }): Promise<void>;
onWriteBlocked(cb: (e: WriteBlockedEvent) => void): () => void;
```
（preload 形态照抄既有 `onMessage`/`sandbox.*` 包装模式——`ipcRenderer.on('sandbox:writeBlocked', (_e, payload) => cb(payload))` + 返回解绑函数。）

App.tsx 订阅（`useEffect(() => subscribeSessionChannels(), [])` 旁新增一行）：
```typescript
useEffect(
  () => ipc.sandbox.onWriteBlocked((e) => useWriteGrantStore.getState().receiveWriteBlocked(e)),
  [],
);
```

stream.store.ts 删除：`TOOLCHAIN_WRITE_BLOCKED_SNIPPET`、`TOOLCHAIN_COMMAND_PREVIEW_MAX`、`toolchainWriteBlockedSeen`、`lastToolchainBlockedCommand`、`markToolchainWriteBlockedSeen`、applyEventBatch 内对应扫描段（**netBlocked 链原样保留**）。`stream.store.test.ts` 删 WRITE_BLOCKED_HINT 全文锁用例（renderer 不再消费该文案）。

- [ ] **Step 4: 跑绿 + typecheck（IPC 契约门禁）**

Run: `cd renderer && npx pnpm@9.0.0 vitest run src/stores/`；`npx pnpm@9.0.0 typecheck`
Expected: PASS + 双 Done（SandboxNotice 引用旧字段会在 typecheck 报错——Task 7 改造前的预期中间态，**本任务结束时 SandboxNotice 同步最小修补**（删对已删字段/方法的引用，卡临时退化为不显示 toolchain 卡），保证分支可编译）

- [ ] **Step 5: 提交**

```bash
git add renderer/src electron/src/preload/index.ts
git commit -m "feat(renderer): writeBlocked 订阅 + write-grant.store + 旧扫描链废除"
```

---

### Task 7: 通用授权卡（SandboxNotice 改造）

**Files:**
- Modify: `renderer/src/components/settings/SandboxNotice.tsx`（工具链卡 → 通用写授权卡）
- Test: `renderer/src/components/settings/SandboxNotice.test.tsx`（工具链卡用例块重写）

**Interfaces:**
- Consumes: Task 6 `useWriteGrantStore` / `ipc.sandbox.grantWrite`；`useWorkspaceStore.activeWorkspaceId`（workspace 键兜底——事件 workspaceId 为 null 时用激活 workspace）。
- Produces: 无（终端 UI）。

- [ ] **Step 1: 重写卡用例（替代原「工具链写拦截引导卡」describe 块）**

```tsx
describe('SandboxNotice：通用写授权卡（spec §7）', () => {
  it('pending 事件 → 渲染卡：命令预览 + 目录列表 + 三按钮', async () => {
    act(() => {
      useWriteGrantStore.getState().__resetForTest();
      useWriteGrantStore.getState().receiveWriteBlocked({ sessionId: 's-1', workspaceId: 'w-1', dirs: ['/Users/x/.cargo'], command: 'cargo build' });
    });
    render(<SandboxNotice />);
    expect(screen.getByText(/agent 请求写入工作空间外的目录/)).toBeInTheDocument();
    expect(screen.getByText('/Users/x/.cargo')).toBeInTheDocument();
    expect(screen.getByText('cargo build')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '拒绝' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '本会话允许' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '本工作空间始终允许' })).toBeInTheDocument();
  });

  it('本会话允许 → grantWrite(session, sessionId, dirs) + 卡消失', async () => {
    grantWriteMock.mockResolvedValue(undefined);
    act(() => {
      useWriteGrantStore.getState().__resetForTest();
      useWriteGrantStore.getState().receiveWriteBlocked({ sessionId: 's-1', workspaceId: 'w-1', dirs: ['/d'], command: 'x' });
    });
    render(<SandboxNotice />);
    fireEvent.click(screen.getByRole('button', { name: '本会话允许' }));
    await waitFor(() => expect(grantWriteMock).toHaveBeenCalledWith({ scope: 'session', key: 's-1', dirs: ['/d'] }));
    await waitFor(() => expect(screen.queryByTestId('sandbox-notice')).toBeNull());
  });

  it('本工作空间始终允许 → grantWrite(workspace, workspaceId, dirs)', async () => {
    grantWriteMock.mockResolvedValue(undefined);
    act(() => {
      useWriteGrantStore.getState().__resetForTest();
      useWriteGrantStore.getState().receiveWriteBlocked({ sessionId: 's-1', workspaceId: 'w-1', dirs: ['/d'], command: 'x' });
    });
    render(<SandboxNotice />);
    fireEvent.click(screen.getByRole('button', { name: '本工作空间始终允许' }));
    await waitFor(() => expect(grantWriteMock).toHaveBeenCalledWith({ scope: 'workspace', key: 'w-1', dirs: ['/d'] }));
  });

  it('拒绝 → 卡消失 + 同 dirs 不再弹（拒绝记忆）', () => {
    act(() => {
      useWriteGrantStore.getState().__resetForTest();
      useWriteGrantStore.getState().receiveWriteBlocked({ sessionId: 's-1', workspaceId: 'w-1', dirs: ['/d'], command: 'x' });
    });
    render(<SandboxNotice />);
    fireEvent.click(screen.getByRole('button', { name: '拒绝' }));
    expect(screen.queryByTestId('sandbox-notice')).toBeNull();
    act(() => { useWriteGrantStore.getState().receiveWriteBlocked({ sessionId: 's-1', workspaceId: 'w-1', dirs: ['/d'], command: 'x' }); });
    expect(screen.queryByTestId('sandbox-notice')).toBeNull();
  });

  it('空 dirs（路径提取失败）→ 两授权按钮禁用 + 降级文案 + 去设置可用', () => {
    act(() => {
      useWriteGrantStore.getState().__resetForTest();
      useWriteGrantStore.getState().receiveWriteBlocked({ sessionId: 's-1', workspaceId: 'w-1', dirs: [], command: 'mystery-tool install' });
    });
    render(<SandboxNotice />);
    expect(screen.getByRole('button', { name: '本会话允许' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '本工作空间始终允许' })).toBeDisabled();
    expect(screen.getByText(/未能定位具体目录/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '去设置' })).toBeInTheDocument();
  });

  it('无 sessionId/workspaceId（映射失败）→ 会话/工作空间按钮分别禁用（防误写）', () => {
    act(() => {
      useWriteGrantStore.getState().__resetForTest();
      useWriteGrantStore.getState().receiveWriteBlocked({ sessionId: null, workspaceId: 'w-1', dirs: ['/d'], command: 'x' });
    });
    render(<SandboxNotice />);
    expect(screen.getByRole('button', { name: '本会话允许' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '本工作空间始终允许' })).not.toBeDisabled();
  });
});
```
（mock：`grantWriteMock` 加进 window.api.sandbox 桩；既有 makeInfo/getStateMock 夹具保留给 netOff/bwrap 卡用例。）

- [ ] **Step 2: 跑红 → Step 3: 实现卡**

SandboxNotice.tsx 工具链卡分支替换为：
```tsx
const writePending = useWriteGrantStore((s) => s.pending);
const denyPending = useWriteGrantStore((s) => s.denyPending);
const resolvePending = useWriteGrantStore((s) => s.resolvePending);
// 显示优先级（spec §7 卡并入既有单卡容器优先级链）：netOff > writeBlocked > bwrap > winPolicy
const showWriteBlocked = !showNetOff && writePending !== null;

const grantNow = async (scope: 'session' | 'workspace'): Promise<void> => {
  if (!writePending) return;
  const key = scope === 'session' ? writePending.sessionId : writePending.workspaceId ?? activeWorkspaceId;
  if (!key || writePending.dirs.length === 0) return;
  setBusy(true);
  try {
    await ipc.sandbox.grantWrite({ scope, key, dirs: writePending.dirs });
    resolvePending();
  } finally { setBusy(false); }
};
```
JSX（showWriteBlocked 分支）：
```tsx
<p className="mb-3 leading-relaxed">agent 请求写入工作空间外的目录。可放行下列目录（本会话或本工作空间），或拒绝。</p>
{writePending.dirs.length > 0 ? (
  <ul className="mb-3 space-y-1">
    {writePending.dirs.map((d) => (
      <li key={d}><code className="border border-subtle bg-canvas rounded px-2 py-1 font-mono text-xs text-secondary select-all break-all">{d}</code></li>
    ))}
  </ul>
) : (
  <p className="mb-3 text-xs text-status-warning">未能定位具体目录（工具错误未带路径）。可到 设置→安全沙箱 手动配置预置清单。</p>
)}
<code className="block border border-subtle bg-canvas rounded px-2 py-1.5 font-mono text-xs text-secondary select-all break-all mb-3">{writePending.command}</code>
<div className="flex justify-end gap-2">
  <Button variant="ghost" onClick={() => setActiveView('settings')}>去设置</Button>
  <Button variant="ghost" onClick={() => denyPending()}>拒绝</Button>
  <Button onClick={() => void grantNow('session').catch(() => {})}
    disabled={busy || writePending.sessionId === null || writePending.dirs.length === 0}>
    本会话允许
  </Button>
  <Button onClick={() => void grantNow('workspace').catch(() => {})}
    disabled={busy || (writePending.workspaceId === null && activeWorkspaceId === null) || writePending.dirs.length === 0}>
    本工作空间始终允许
  </Button>
</div>
```
（旧 showToolchain / grantNow 旧版 / restoreAndGrant / DEFAULT_TOOLCHAIN_DIRS import 全部删除；X 关闭按钮对 writeBlocked 卡调 denyPending——语义即拒绝。bwrap/winPolicy/netOff 卡与既有逻辑不动。）

- [ ] **Step 4: 跑绿 + renderer 全量**

Run: `cd renderer && npx pnpm@9.0.0 vitest run src/`
Expected: PASS（2038±基线全绿）

- [ ] **Step 5: 提交**

```bash
git add renderer/src/components/settings/SandboxNotice.tsx renderer/src/components/settings/SandboxNotice.test.tsx
git commit -m "feat(renderer): 通用写授权卡——三按钮 + 空 dirs 降级 + 拒绝记忆"
```

---

### Task 8: 设置页「已授权目录」小节（可撤销）

**Files:**
- Modify: `electron/src/main/sandbox/ipc.handlers.ts`（新增 `sandbox:listWriteGrants`）
- Modify: `renderer/src/ipc/types.d.ts` + `electron/src/preload/index.ts` + `renderer/src/ipc/client.ts`
- Modify: `renderer/src/components/settings/SandboxSettingsPanel.tsx`
- Test: `electron/tests/sandbox/ipc.handlers.test.ts`、`renderer/src/components/settings/SandboxSettingsPanel.test.tsx`

**Interfaces:**
- Consumes: Task 1 `listWorkspaceGrants()`；Task 5 `revokeWrite`。
- Produces: `sandbox:listWriteGrants(): Promise<Array<{ workspaceId: string; dirs: string[] }>>`

- [ ] **Step 1: 失败测试**

electron 侧：
```typescript
it('sandbox:listWriteGrants 列出工作空间持久授权', async () => {
  const h = ipcHandlers.get('sandbox:listWriteGrants') as () => Array<{ workspaceId: string; dirs: string[] }>;
  // 授权两条（借 grantWrite handler）
  const grant = ipcHandlers.get('sandbox:grantWrite') as (e: unknown, a: unknown) => void;
  grant(null, { scope: 'workspace', key: 'w-1', dirs: ['/tmp/a'] });
  grant(null, { scope: 'workspace', key: 'w-2', dirs: ['/tmp/b'] });
  expect(h().sort((x, y) => x.workspaceId.localeCompare(y.workspaceId))).toEqual([
    { workspaceId: 'w-1', dirs: ['/tmp/a'] }, { workspaceId: 'w-2', dirs: ['/tmp/b'] },
  ]);
});
```
renderer 侧（SandboxSettingsPanel.test.tsx）：
```tsx
it('已授权目录小节：列出工作空间授权 + 删除调 revokeWrite（spec §8）', async () => {
  listWriteGrantsMock.mockResolvedValue([{ workspaceId: 'w-1', dirs: ['/tmp/a'] }]);
  renderSettings();
  await waitFor(() => expect(screen.getByText('/tmp/a')).toBeInTheDocument());
  fireEvent.click(screen.getByRole('button', { name: '删除' }));
  await waitFor(() => expect(revokeWriteMock).toHaveBeenCalledWith({ scope: 'workspace', key: 'w-1', dir: '/tmp/a' }));
});
```
（mock 桩形态照抄本文件既有 window.api 桩法。）

- [ ] **Step 2: 跑红 → Step 3: 实现**

ipc.handlers.ts：
```typescript
ipcMain.handle('sandbox:listWriteGrants', () => listWorkspaceGrants());
```
（import 补 `listWorkspaceGrants`。）

SandboxSettingsPanel：工具链清单区块下方新增小节（语义 token；标题「已授权目录（工作空间持久）」；空态文案「暂无持久授权」；每条 = workspace 名（有 workspace store 映射则显示名，否则短 id）+ 目录 code + 删除按钮；删除后本地列表过滤 + revokeWrite）。

- [ ] **Step 4: 跑绿 + typecheck → Step 5: 提交**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/sandbox/ipc.handlers.test.ts`；`cd ../renderer && npx pnpm@9.0.0 vitest run src/components/settings/`；`npx pnpm@9.0.0 typecheck`

```bash
git add electron/src/main/sandbox/ipc.handlers.ts electron/src/preload/index.ts renderer/src
git commit -m "feat(settings): 已授权目录小节——列表 + 逐条撤销"
```

---

### Task 9: 回归锁 + 全量验证 + 文档收尾

**Files:**
- Test: `renderer/src/stores/stream.store.test.ts`（回归锁追加）
- Modify: `docs/specs/2026-10-03-general-write-grant-design.md`（状态行 → 已实施）

- [ ] **Step 1: 回归锁（子串扫描防复活）**

stream.store.test.ts 追加：
```typescript
it('回归锁：stream.store 源码不含写拦截子串扫描（事件驱动后旧链不得复活）', async () => {
  const src = await import('fs').then((fs) => fs.readFileSync(new URL('./stream.store.ts', import.meta.url), 'utf-8'));
  expect(src).not.toContain('非工作空间路径写入被沙箱拦截');
  expect(src).not.toContain('工作空间外路径写入被沙箱拦截');
});
```

- [ ] **Step 2: 全量验证**

Run:
```bash
cd electron && npx pnpm@9.0.0 vitest run --exclude 'tests/settings/**'   # 分目录跑其余；tests/settings/ --pool=forks 单跑
npx pnpm@9.0.0 typecheck
cd ../renderer && npx pnpm@9.0.0 vitest run src/
```
Expected: 全绿（已知宿主基线除外：shell-sandbox-wiring 1 darwin、resolve-spawn 7、p2p lan-transport 1 预存——**不新增**失败；遇 SIGSEGV 分目录重跑 + stash 对照判回归）

- [ ] **Step 3: spec 状态更新 + 提交**

```bash
git add renderer/src/stores/stream.store.test.ts docs/specs/2026-10-03-general-write-grant-design.md
git commit -m "test(renderer): 写拦截子串扫描回归锁 + spec 状态收尾"
```

- [ ] **Step 4: GUI 验收准备**

```bash
cd electron && npx electron-rebuild -f -w better-sqlite3   # 若此前为跑测试切过 Node ABI
cd .. && npx pnpm@9.0.0 dev
```
验收清单（交付用户）：① 清空预置清单 + deny 下让 agent 装依赖 → 卡弹（显示 ~/.cargo + 命令 + 三按钮）；② 本会话允许 → agent 重试即过；③ 重启 app 同会话再测 → 授权仍在（会话持久）；④ 新会话同目录 → 卡再弹 → 工作空间始终允许 → 新会话不再弹；⑤ 拒绝 → 同目录不再弹、agent 收敛；⑥ 设置页可见持久授权并可删除；⑦ 空路径场景（构造 mystery 工具）→ 降级文案。
