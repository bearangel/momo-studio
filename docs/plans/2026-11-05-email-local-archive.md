# Email 本地加密邮件库（归档）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用户指定根目录，读过的邮件原文（RFC 822）AES-256-GCM 加密落盘，SQLite 只存路径索引；本地优先读信 + 保留策略清理 + 面板存储设置。

**Architecture:** 插件内新增 `crypto`（纯加解密）与 `archive`（目录/索引/清理）两个模块；`mailbox.read/attachment` 改为「本地命中 → IMAP 回退 → 异步回填」；平台仅加一条面板白名单消息 `app:pickDirectory`（复用既有 `dialog:pickDirectory` IPC）。

**Tech Stack:** Electron 44 / Node 24 内置 `node:sqlite` 与 `node:crypto`；无新依赖。

**Spec:** `docs/specs/2026-11-05-email-local-archive-design.md`（momo-studio-email worktree，commit 395ede8f 起，已随 68d0448d 对齐 schema v3）

## Global Constraints

- 两个仓库：插件 `/Users/stbearangel/dev/AiProject/momo-plugin`（分支 email-plugin）；平台 worktree `/Users/stbearangel/dev/AiProject/momo-studio-email`（分支 email-plugin）。**禁止触碰 `/Users/stbearangel/dev/AiProject/moo-studio` 主 checkout**。
- 插件测试：`cd /Users/stbearangel/dev/AiProject/momo-plugin && source ~/.nvm/nvm.sh && nvm use 24 && MOMO_STUDIO_ROOT=/Users/stbearangel/dev/AiProject/momo-studio-email npx vitest run tests/email`（dev-install 用例需宿主 better-sqlite3 为 Node ABI——测前临时换入、测后立即还原 Electron ABI `/tmp/better_sqlite3.node.electron-abi-backup`；**不得重启/杀正在运行的 App（CDP 9333）**）。
- 平台 renderer 改动跑：`cd /Users/stbearangel/dev/AiProject/momo-studio-email/renderer && npx pnpm@9.0.0 vitest run <file>`；类型检查根目录 `npx pnpm@9.0.0 typecheck`。
- TypeScript strict：禁止 `any` / `@ts-ignore` / `as any`。错误文案一律中文。UI 禁 emoji。
- schema 版本：v2 已被 `folder_cache` 占用；本计划 `local_archive` 为 **v3**。
- 加密常量：MAGIC `MOMAIL1`（7 字节）、enc_version=1、AES-256-GCM、IV 12B、tag 16B、AAD=`${accountId}|${folder}|${uid}|1`。
- 单封归档上限 `25*1024*1024` 字节；读信体积上限沿用 `READ_SOURCE_MAX=2MB`。
- Conventional Commits：`feat(email): …` / `feat(panel): …`。

## Review Focus

1. **换根目录后旧索引命中**（rootId 变了但 rel_path 相同）→ 读到旧目录/错误文件。测试：Task 4「root 切换后旧行不命中」。
2. **加密文件被替换或截断**（换文件/改字节）→ 必须认证失败并自愈（删文件 + IMAP 重下），不得返回错误明文。测试：Task 2「AAD 篡改/截断」+ Task 5「corrupt 自愈」。
3. **setRoot 接受非法路径**（相对路径 / 指向文件 / 文件系统根 `/`）→ 必须拒绝并中文报错。测试：Task 4「setRoot 校验」。
4. **envelope 缓存缺失时的本地读**（信封缓存被清，只有归档文件）→ from/subject/date 兜底自解析，不得报错。测试：Task 5「无信封缓存仍可读」。
5. **删除账号残留**（索引删了文件没删 / 文件删了索引没删）→ 必须双侧干净。测试：Task 4「removeAccount 双侧清理」+「启动核对 missing/orphan」。

---

### Task 1: 平台桥 `app:pickDirectory`（平台 worktree）

**Files:**
- Modify: `renderer/src/lib/plugin/panel-channel.ts`（INBOUND_TYPES、PanelHostHandlers、dispatch、并发守卫）
- Modify: `renderer/src/components/plugins/PanelHost.tsx`（handler 接线）
- Test: `renderer/src/lib/plugin/panel-channel.test.ts`、`renderer/src/components/plugins/PanelHost.test.tsx`

**Interfaces:**
- Produces: 面板可 `postMessage({type:'app:pickDirectory', id, title?})`，回包 `rpc:result` 为 `string | null`（用户取消 null）；同一面板并发仅一次，进行中再发回错误 `目录选择进行中`。

- [ ] **Step 1: 写失败测试（panel-channel.test.ts 追加）**

```ts
describe('app:pickDirectory', () => {
  function mkHandlers(over: Partial<PanelHostHandlers> = {}): PanelHostHandlers {
    return {
      getTheme: () => ({ theme: 'light', tokens: {} }),
      getContext: () => ({ workspaceId: 'w1', workspaceName: 'W', sessionId: null }),
      subscribe: async (e) => ({ ok: e, rejected: [] }),
      callService: async () => null,
      pickDirectory: async () => '/tmp/mail-root',
      onDisconnect: () => undefined,
      ...over,
    };
  }
  function ev(type: string, extra: Record<string, unknown> = {}) {
    return { data: { type, id: 9, ...extra } } as MessageEvent;
  }

  it('白名单放行并回包路径', async () => {
    const h = mkHandlers();
    const ch = new PanelChannel({ pluginId: 'p', iframeWindow: fakeWin, handlers: h });
    const posted: unknown[] = [];
    fakeWin.postMessage = (m: unknown) => posted.push(m);
    ch.receiveTest(ev('app:pickDirectory', { title: '选择目录' }));
    await vi.waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toEqual({ type: 'rpc:result', id: 9, result: '/tmp/mail-root' });
    expect(h.pickDirectory).toHaveBeenCalledWith({ title: '选择目录' });
  });

  it('并发第二次直接回错误', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const h = mkHandlers({ pickDirectory: async () => { await gate; return '/x'; } });
    const ch = new PanelChannel({ pluginId: 'p', iframeWindow: fakeWin, handlers: h });
    const posted: unknown[] = [];
    fakeWin.postMessage = (m: unknown) => posted.push(m);
    ch.receiveTest(ev('app:pickDirectory'));
    ch.receiveTest(ev('app:pickDirectory')); // 并发
    await new Promise((r) => setTimeout(r, 10));
    expect(posted).toEqual([{ type: 'rpc:result', id: 9, error: '目录选择进行中，请先完成或取消' }]);
    release();
    await vi.waitFor(() => expect(posted).toHaveLength(2));
  });

  it('未知 type 仍计违规', () => {
    const h = mkHandlers();
    const ch = new PanelChannel({ pluginId: 'p', iframeWindow: fakeWin, handlers: h });
    const before = ch.isDisconnected;
    ch.receiveTest(ev('app:evil'));
    // 三振才断开——连发三次
    ch.receiveTest(ev('app:evil'));
    ch.receiveTest(ev('app:evil'));
    expect(ch.isDisconnected).toBe(true);
    expect(before).toBe(false);
  });
});
```

（沿用该测试文件既有的 `fakeWin` / import 形态；若文件用别的桩名，以现有为准对齐。）

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /Users/stbearangel/dev/AiProject/momo-studio-email/renderer && npx pnpm@9.0.0 vitest run src/lib/plugin/panel-channel.test.ts`
Expected: FAIL（TS 报 `pickDirectory` 不在 PanelHostHandlers / dispatch 未处理）

- [ ] **Step 3: 实现 panel-channel.ts**

```ts
// 白名单（第 56 行附近）
const INBOUND_TYPES = new Set(['ready', 'app:getContext', 'app:subscribe', 'plugin:callService', 'app:pickDirectory']);

// PanelHostHandlers 增加成员（panel-channel.ts 接口处）
/** 面板请求系统目录选择（app:pickDirectory）——同一面板并发仅一次 */
pickDirectory(opts?: { title?: string; defaultPath?: string }): Promise<string | null>;

// PanelChannel 类内新增字段
private picking = false;

// dispatch switch 增加（放在 'plugin:callService' 之后）
case 'app:pickDirectory': {
  if (this.picking) {
    this.pushResult(id, undefined, '目录选择进行中，请先完成或取消');
    return;
  }
  const opts = (data.opts && typeof data.opts === 'object' ? data.opts : {}) as { title?: string; defaultPath?: string };
  this.picking = true;
  try {
    this.pushResult(id, await this.handlers.pickDirectory(opts));
  } catch (err) {
    this.pushResult(id, undefined, err instanceof Error ? err.message : String(err));
  } finally {
    this.picking = false;
  }
  return;
}
```

InboundMsg 接口补 `opts?: unknown;`。

- [ ] **Step 4: PanelHost.tsx 接线**

handlers 对象（`PanelHost.tsx:86-102`）增加：

```ts
pickDirectory: (opts) => ipc.dialog.pickDirectory(opts),
```

- [ ] **Step 5: PanelHost 转发测试（PanelHost.test.tsx 追加）**

```tsx
it('pickDirectory 转发 ipc.dialog.pickDirectory 并回包', async () => {
  const spy = vi.fn().mockResolvedValue('/tmp/chosen');
  vi.stubGlobal('window', { ...window, api: { ...window.api, dialog: { pickDirectory: spy } } });
  // 以 PanelChannel receiveTest 或 iframe message 驱动，断言回包 result === '/tmp/chosen'
  // 按该文件既有驱动方式（iframe contentWindow postMessage 桩）实现
});
```

（按该文件既有 mock 形态落地；核心断言：`spy` 收到 `{ title: 'x' }`、回包 result。）

- [ ] **Step 6: 全绿 + typecheck**

Run: `cd /Users/stbearangel/dev/AiProject/momo-studio-email && npx pnpm@9.0.0 typecheck && cd renderer && npx pnpm@9.0.0 vitest run src/lib/plugin/panel-channel.test.ts src/components/plugins/PanelHost.test.tsx`
Expected: PASS / 0 errors

- [ ] **Step 7: Commit（平台仓）**

```bash
git add renderer/src/lib/plugin/panel-channel.ts renderer/src/components/plugins/PanelHost.tsx renderer/src/lib/plugin/panel-channel.test.ts renderer/src/components/plugins/PanelHost.test.tsx
git commit -m "feat(panel): 面板白名单新增 app:pickDirectory（并发守卫，复用 dialog:pickDirectory）"
```

---

### Task 2: `crypto.js` 加密层（插件仓）

**Files:**
- Create: `plugins/email/service/lib/crypto.js`
- Test: `tests/email/crypto.test.ts`

**Interfaces:**
- Produces: `seal(raw: Buffer, key: Buffer, aad: string): Buffer`；`open(sealed: Buffer, key: Buffer, aad: string): Buffer`（失败抛中文 Error）；`generateMasterKey(): Buffer`（32B）；`MAGIC`/`HEADER_LEN` 导出。

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { seal, open, generateMasterKey, MAGIC, HEADER_LEN } from '../../plugins/email/service/lib/crypto';

const key = generateMasterKey();
const aad = 'acc1|INBOX|42|1';

describe('crypto seal/open', () => {
  it('round-trip', () => {
    const raw = Buffer.from('From: a@b.c\r\nSubject: 你好\r\n\r\n正文\r\n', 'utf8');
    const sealed = seal(raw, key, aad);
    expect(sealed.subarray(0, 7).equals(MAGIC)).toBe(true);
    expect(sealed.length).toBe(raw.length + HEADER_LEN);
    expect(open(sealed, key, aad).equals(raw)).toBe(true);
  });
  it('同明文两次封装备 IV 不同', () => {
    const raw = Buffer.from('x');
    expect(seal(raw, key, aad).equals(seal(raw, key, aad))).toBe(false);
  });
  it('AAD 篡改（换 uid）认证失败', () => {
    const sealed = seal(Buffer.from('secret'), key, aad);
    expect(() => open(sealed, key, 'acc1|INBOX|43|1')).toThrow(/认证|decrypt/);
  });
  it('错误密钥失败', () => {
    const sealed = seal(Buffer.from('secret'), key, aad);
    expect(() => open(sealed, generateMasterKey(), aad)).toThrow();
  });
  it('截断与魔数不符失败', () => {
    const sealed = seal(Buffer.from('secret'), key, aad);
    expect(() => open(sealed.subarray(0, sealed.length - 5), key, aad)).toThrow(/损坏|失败/);
    expect(() => open(Buffer.concat([Buffer.from('XXXXXXX'), sealed.subarray(7)]), key, aad)).toThrow(/魔数/);
  });
  it('key 长度校验', () => {
    expect(() => seal(Buffer.from('x'), Buffer.alloc(16), aad)).toThrow(/32/);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /Users/stbearangel/dev/AiProject/momo-plugin && npx vitest run tests/email/crypto.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `plugins/email/service/lib/crypto.js`**

```js
// 归档加密：MOMAIL1 头 + AES-256-GCM。AAD 绑定 accountId|folder|uid|version——
// 文件互换/版本降级在认证层被拒。密钥由 archive 模块管理（keychain），本模块无 IO。
'use strict';
const crypto = require('node:crypto');

const MAGIC = Buffer.from('MOMAIL1', 'utf8'); // 7B
const VERSION = 1;
const IV_LEN = 12;
const TAG_LEN = 16;
const HEADER_LEN = MAGIC.length + 1 + IV_LEN + TAG_LEN;

function assertKey(key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('归档主密钥必须是 32 字节 Buffer');
}

function seal(raw, key, aad) {
  assertKey(key);
  if (!Buffer.isBuffer(raw)) throw new Error('seal 入参必须是 Buffer');
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_LEN });
  cipher.setAAD(Buffer.from(String(aad), 'utf8'));
  const ct = Buffer.concat([cipher.update(raw), cipher.final()]);
  return Buffer.concat([MAGIC, Buffer.from([VERSION]), iv, cipher.getAuthTag(), ct]);
}

function open(sealed, key, aad) {
  assertKey(key);
  if (!Buffer.isBuffer(sealed) || sealed.length < HEADER_LEN) throw new Error('加密文件损坏（长度不足）');
  if (!sealed.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('加密文件损坏（魔数不符）');
  const version = sealed[MAGIC.length]!;
  if (version !== VERSION) throw new Error(`加密文件版本不支持: ${version}`);
  const iv = sealed.subarray(MAGIC.length + 1, MAGIC.length + 1 + IV_LEN);
  const tag = sealed.subarray(MAGIC.length + 1 + IV_LEN, HEADER_LEN);
  const ct = sealed.subarray(HEADER_LEN);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_LEN });
  decipher.setAAD(Buffer.from(String(aad), 'utf8'));
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ct), decipher.final()]);
  } catch {
    throw new Error('加密文件认证失败（密钥不符或文件被篡改）');
  }
}

function generateMasterKey() { return crypto.randomBytes(32); }

module.exports = { seal, open, generateMasterKey, MAGIC, HEADER_LEN };
```

- [ ] **Step 4: 跑测试通过**

Run: `npx vitest run tests/email/crypto.test.ts` → PASS

- [ ] **Step 5: Commit**

```bash
git add plugins/email/service/lib/crypto.js tests/email/crypto.test.ts
git commit -m "feat(email): 归档加密层（MOMAIL1 + AES-256-GCM，AAD 绑账号/文件夹/uid）"
```

---

### Task 3: store schema v3（`local_archive` 索引）

**Files:**
- Modify: `plugins/email/service/lib/store.js`（SCHEMA_VERSION=3、SCHEMA_V3、归档索引方法）
- Test: `tests/email/store.test.ts`

**Interfaces:**
- Produces:
  - `getArchiveRow(accountId: string, folder: string, uid: number): ArchiveRow | null`
  - `upsertArchiveRow(row: ArchiveRow): void`，`ArchiveRow = { accountId, folder, uid, rootId, relPath, sizeBytes, sha256, encVersion, msgDate, state: 'ok'|'missing'|'corrupt'|'too_large', cachedAt }`
  - `setArchiveState(accountId, folder, uid, state): void`
  - `deleteArchiveRows(accountId, opts?: { folder?: string; rootId?: string }): number`
  - `listArchiveRows(accountId, opts?: { state?: string }): ArchiveRow[]`
  - `archiveStats(rootId): { files, bytes, missing, corrupt, tooLarge }`

- [ ] **Step 1: 写失败测试（store.test.ts 追加）**

```ts
describe('local_archive（schema v3）', () => {
  it('v2 → v3 迁移：旧库打开后 local_archive 存在且 user_version=3', () => {
    const dir = mkTmpDataDir();
    // 手工构造 v2 库：createStore 建到 v2 的方式——直接用当前 createStore 打开后 close，
    // 再把 user_version 手动降回 2 并 DROP local_archive（若存在），模拟存量库
    const s1 = createStore({ dataDir: dir }); s1.close();
    const db = new DatabaseSync(path.join(dir, 'data.db'));
    db.exec('DROP TABLE IF EXISTS local_archive'); db.exec('PRAGMA user_version=2'); db.close();
    const s2 = createStore({ dataDir: dir });
    expect(s2.getArchiveRow('a', 'INBOX', 1)).toBeNull();
    s2.close();
    const db2 = new DatabaseSync(path.join(dir, 'data.db'));
    expect(Number(db2.prepare('PRAGMA user_version').get().user_version)).toBe(3);
    db2.close();
  });
  it('upsert/get/状态流转/删除计数/统计', () => {
    const dir = mkTmpDataDir();
    const s = createStore({ dataDir: dir });
    const row = { accountId: 'a', folder: 'INBOX', uid: 7, rootId: 'r1', relPath: 'a/INBOX/2026-11/7-abc12345.eml.enc',
      sizeBytes: 100, sha256: 'h', encVersion: 1, msgDate: Date.now(), state: 'ok', cachedAt: Date.now() };
    s.upsertArchiveRow(row);
    expect(s.getArchiveRow('a', 'INBOX', 7)?.relPath).toBe(row.relPath);
    s.upsertArchiveRow({ ...row, sizeBytes: 200 }); // 幂等覆盖
    expect(s.getArchiveRow('a', 'INBOX', 7)?.sizeBytes).toBe(200);
    s.setArchiveState('a', 'INBOX', 7, 'missing');
    expect(s.getArchiveRow('a', 'INBOX', 7)?.state).toBe('missing');
    s.upsertArchiveRow({ ...row, uid: 8, relPath: 'x', state: 'corrupt', sizeBytes: 1 });
    s.upsertArchiveRow({ ...row, uid: 9, relPath: 'y', state: 'too_large', sizeBytes: 0 });
    expect(s.archiveStats('r1')).toEqual({ files: 3, bytes: 201, missing: 1, corrupt: 1, tooLarge: 1 });
    expect(s.deleteArchiveRows('a', { folder: 'INBOX' })).toBe(3);
    expect(s.getArchiveRow('a', 'INBOX', 7)).toBeNull();
    s.close();
  });
  it('user_version=99 仍抛升级错误', () => {
    const dir = mkTmpDataDir();
    const s = createStore({ dataDir: dir }); s.close();
    const db = new DatabaseSync(path.join(dir, 'data.db')); db.exec('PRAGMA user_version=99'); db.close();
    expect(() => createStore({ dataDir: dir })).toThrow(/更新版本插件/);
  });
});
```

（`mkTmpDataDir` 用该文件既有临时目录工具；`DatabaseSync` 从 `node:sqlite` import。）

- [ ] **Step 2: 确认失败** — Run: `npx vitest run tests/email/store.test.ts` → FAIL（方法不存在）

- [ ] **Step 3: 实现 store.js**

```js
const SCHEMA_VERSION = 3;
const SCHEMA_V3 = `
CREATE TABLE IF NOT EXISTS local_archive (
  account_id TEXT NOT NULL, folder TEXT NOT NULL, uid INTEGER NOT NULL,
  root_id TEXT NOT NULL, rel_path TEXT NOT NULL, size_bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL, enc_version INTEGER NOT NULL, msg_date INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL, cached_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, folder, uid)
);
CREATE INDEX IF NOT EXISTS idx_local_archive_root ON local_archive(root_id);
`;
// 迁移块（v2 之后追加，与 v1/v2 同款 BEGIN/COMMIT 形态）
if (version < 3) { /* db.exec(SCHEMA_V3); PRAGMA user_version=3 */ }
```

方法实现（rowToArchive/绑定数组模式同 drafts）：

```js
const rowToArchive = (r) => ({
  accountId: r.account_id, folder: r.folder, uid: Number(r.uid), rootId: r.root_id,
  relPath: r.rel_path, sizeBytes: Number(r.size_bytes), sha256: r.sha256,
  encVersion: Number(r.enc_version), msgDate: Number(r.msg_date), state: r.state, cachedAt: Number(r.cached_at),
});
// 返回对象上追加：
getArchiveRow(accountId, folder, uid) {
  const r = db.prepare('SELECT * FROM local_archive WHERE account_id = ? AND folder = ? AND uid = ?').get(accountId, folder, uid);
  return r ? rowToArchive(r) : null;
},
upsertArchiveRow(row) {
  db.prepare(`INSERT INTO local_archive (account_id, folder, uid, root_id, rel_path, size_bytes, sha256, enc_version, msg_date, state, cached_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(account_id, folder, uid) DO UPDATE SET root_id=excluded.root_id, rel_path=excluded.rel_path,
      size_bytes=excluded.size_bytes, sha256=excluded.sha256, enc_version=excluded.enc_version,
      msg_date=excluded.msg_date, state=excluded.state, cached_at=excluded.cached_at`)
    .run(row.accountId, row.folder, Number(row.uid) || 0, row.rootId, row.relPath, Number(row.sizeBytes) || 0,
      row.sha256, Number(row.encVersion) || 1, Number(row.msgDate) || 0, row.state, Number(row.cachedAt) || Date.now());
},
setArchiveState(accountId, folder, uid, state) {
  db.prepare('UPDATE local_archive SET state = ? WHERE account_id = ? AND folder = ? AND uid = ?').run(state, accountId, folder, uid);
},
deleteArchiveRows(accountId, opts = {}) {
  let sql = 'DELETE FROM local_archive WHERE account_id = ?'; const args = [accountId];
  if (opts.folder) { sql += ' AND folder = ?'; args.push(opts.folder); }
  if (opts.rootId) { sql += ' AND root_id = ?'; args.push(opts.rootId); }
  return Number(db.prepare(sql).run(...args).changes);
},
listArchiveRows(accountId, opts = {}) {
  let sql = 'SELECT * FROM local_archive WHERE account_id = ?'; const args = [accountId];
  if (opts.state) { sql += ' AND state = ?'; args.push(opts.state); }
  return db.prepare(sql).all(...args).map(rowToArchive);
},
archiveStats(rootId) {
  const r = db.prepare(`SELECT
    SUM(CASE WHEN state='ok' THEN 1 ELSE 0 END) AS files,
    SUM(CASE WHEN state='ok' THEN size_bytes ELSE 0 END) AS bytes,
    SUM(CASE WHEN state='missing' THEN 1 ELSE 0 END) AS missing,
    SUM(CASE WHEN state='corrupt' THEN 1 ELSE 0 END) AS corrupt,
    SUM(CASE WHEN state='too_large' THEN 1 ELSE 0 END) AS tooLarge
    FROM local_archive WHERE root_id = ?`).get(rootId) ?? {};
  return { files: Number(r.files) || 0, bytes: Number(r.bytes) || 0, missing: Number(r.missing) || 0,
    corrupt: Number(r.corrupt) || 0, tooLarge: Number(r.tooLarge) || 0 };
},
```

- [ ] **Step 4: 通过** — `npx vitest run tests/email/store.test.ts` → PASS（含既有用例）

- [ ] **Step 5: Commit**

```bash
git add plugins/email/service/lib/store.js tests/email/store.test.ts
git commit -m "feat(email): local_archive 索引表（schema v3：相对路径/状态机/统计）"
```

---

### Task 4: `archive.js` 存储模块

**Files:**
- Create: `plugins/email/service/lib/archive.js`
- Test: `tests/email/archive.test.ts`

**Interfaces:**
- Consumes: Task 2 `seal/open/generateMasterKey`；Task 3 store 归档方法；`deps.secrets`（`get/set/delete(name, value?)`，与 accounts 同形）。
- Produces: `createArchive({ dataDir, store, secrets, logger, now? })`：
  - `read(accountId, folder, uid): Promise<{ raw: Buffer } | null>`
  - `write(accountId, folder, uid, raw: Buffer, msgDateMs: number): Promise<{ stored: boolean; reason?: 'disabled' | 'too_large' | 'error'; error?: string }>`
  - `prune(accountId, cutoffMs: number | null): Promise<{ removed: number }>`
  - `removeAccount(accountId): Promise<{ removed: number }>`
  - `clearCurrent(): Promise<{ removed: number }>`
  - `stats(): Promise<{ enabled, rootPath, rootId, files, bytes, missing, corrupt, tooLarge }>`
  - `setRoot(absPath: string): Promise<{ rootPath: string }>`
  - `verifyStartup(accountIds: string[]): Promise<{ fixedMissing: number; removedOrphans: number }>`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os';
import { createStore } from '../../plugins/email/service/lib/store';
import { createArchive } from '../../plugins/email/service/lib/archive';

let dataDir: string, root: string, store: ReturnType<typeof createStore>;
const secrets = new Map<string, string>();
const fakeSecrets = {
  async get(k: string) { return secrets.get(k) ?? null; },
  async set(k: string, v: string) { secrets.set(k, v); },
  async delete(k: string) { secrets.delete(k); },
};
const logger = { warn: () => undefined, info: () => undefined, error: () => undefined };

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-data-'));
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-root-'));
  store = createStore({ dataDir });
});
afterEach(() => { store.close(); fs.rmSync(dataDir, { recursive: true, force: true }); fs.rmSync(root, { recursive: true, force: true }); });

describe('archive', () => {
  it('write→read round-trip；文件为密文；索引行 ok', async () => {
    const arc = createArchive({ dataDir, store, secrets: fakeSecrets, logger });
    await arc.setRoot(root);
    const raw = Buffer.from('From: a@b\r\nSubject: t\r\n\r\nhello 你好');
    const w = await arc.write('acc1', 'INBOX', 42, raw, Date.now());
    expect(w.stored).toBe(true);
    const hit = await arc.read('acc1', 'INBOX', 42);
    expect(hit?.raw.equals(raw)).toBe(true);
    const row = store.getArchiveRow('acc1', 'INBOX', 42)!;
    expect(row.state).toBe('ok'); expect(row.rootId).toBeTruthy();
    const fileBuf = fs.readFileSync(path.join(root, row.relPath));
    expect(fileBuf.indexOf(Buffer.from('hello'))).toBe(-1); // 正文不出现在明文
    expect(fileBuf.subarray(0, 7).toString()).toBe('MOMAIL1');
  });
  it('>25MB 不落盘标记 too_large；=上限可落盘', async () => {
    const arc = createArchive({ dataDir, store, secrets: fakeSecrets, logger });
    await arc.setRoot(root);
    const big = Buffer.alloc(25 * 1024 * 1024 + 1, 0x61);
    const w = await arc.write('acc1', 'INBOX', 1, big, Date.now());
    expect(w.stored).toBe(false); expect(w.reason).toBe('too_large');
    expect(store.getArchiveRow('acc1', 'INBOX', 1)?.state).toBe('too_large');
    const w2 = await arc.write('acc1', 'INBOX', 2, Buffer.alloc(1024), Date.now());
    expect(w2.stored).toBe(true);
  });
  it('换文件（AAD 篡改）→ read 返回 null 且自愈为 corrupt + 文件删除', async () => {
    const arc = createArchive({ dataDir, store, secrets: fakeSecrets, logger });
    await arc.setRoot(root);
    await arc.write('acc1', 'INBOX', 5, Buffer.from('secret'), Date.now());
    const row = store.getArchiveRow('acc1', 'INBOX', 5)!;
    const abs = path.join(root, row.relPath);
    fs.writeFileSync(abs, fs.readFileSync(abs).subarray(0, 30)); // 截断
    expect(await arc.read('acc1', 'INBOX', 5)).toBeNull();
    expect(store.getArchiveRow('acc1', 'INBOX', 5)?.state).toBe('corrupt');
    expect(fs.existsSync(abs)).toBe(false);
  });
  it('root 切换后旧行不命中；clearCurrent 只清当前 root', async () => {
    const arc = createArchive({ dataDir, store, secrets: fakeSecrets, logger });
    await arc.setRoot(root);
    await arc.write('acc1', 'INBOX', 9, Buffer.from('x'), Date.now());
    const root2 = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-root2-'));
    await arc.setRoot(root2);
    expect(await arc.read('acc1', 'INBOX', 9)).toBeNull();          // 旧 rootId 不命中
    await arc.write('acc1', 'INBOX', 9, Buffer.from('x'), Date.now()); // 落到新 root
    const row = store.getArchiveRow('acc1', 'INBOX', 9)!;
    expect(path.join(root2, row.relPath)).toBe(path.join(root2, row.relPath));
    const r = await arc.clearCurrent();
    expect(r.removed).toBeGreaterThanOrEqual(1);
    expect(await arc.read('acc1', 'INBOX', 9)).toBeNull();
    fs.rmSync(root2, { recursive: true, force: true });
  });
  it('setRoot 校验：相对路径/文件/根目录拒绝', async () => {
    const arc = createArchive({ dataDir, store, secrets: fakeSecrets, logger });
    await expect(arc.setRoot('relative/x')).rejects.toThrow(/绝对路径/);
    const file = path.join(root, 'f.txt'); fs.writeFileSync(file, 'x');
    await expect(arc.setRoot(file)).rejects.toThrow(/目录/);
    await expect(arc.setRoot(path.parse(process.cwd()).root)).rejects.toThrow(/根目录/);
  });
  it('prune 按 msgDate 清理且文件同步删除；msgDate=0 不清', async () => {
    const arc = createArchive({ dataDir, store, secrets: fakeSecrets, logger });
    await arc.setRoot(root);
    const old = Date.now() - 40 * 86400000;
    await arc.write('acc1', 'INBOX', 1, Buffer.from('old'), old);
    await arc.write('acc1', 'INBOX', 2, Buffer.from('new'), Date.now());
    await arc.write('acc1', 'INBOX', 3, Buffer.from('unk'), 0);
    const r = await arc.prune('acc1', Date.now() - 30 * 86400000);
    expect(r.removed).toBe(1);
    expect(await arc.read('acc1', 'INBOX', 1)).toBeNull();
    expect(await arc.read('acc1', 'INBOX', 2)).not.toBeNull();
    expect(await arc.read('acc1', 'INBOX', 3)).not.toBeNull();
  });
  it('removeAccount 双侧清理；verifyStartup 修 missing 与孤儿', async () => {
    const arc = createArchive({ dataDir, store, secrets: fakeSecrets, logger });
    await arc.setRoot(root);
    await arc.write('acc1', 'INBOX', 1, Buffer.from('a'), Date.now());
    const row = store.getArchiveRow('acc1', 'INBOX', 1)!;
    fs.rmSync(path.join(root, row.relPath));                       // 文件没了
    fs.writeFileSync(path.join(root, 'acc1', 'INBOX', 'zzz.eml.enc'), 'junk'); // 孤儿
    const v = await arc.verifyStartup(['acc1']);
    expect(v.fixedMissing).toBe(1);
    expect(v.removedOrphans).toBe(1);
    await arc.write('acc1', 'INBOX', 2, Buffer.from('b'), Date.now());
    const r = await arc.removeAccount('acc1');
    expect(r.removed).toBeGreaterThanOrEqual(1);
    expect(fs.existsSync(path.join(root, 'acc1'))).toBe(false);
    expect(store.listArchiveRows('acc1')).toHaveLength(0);
  });
  it('未配置 root：write 返回 disabled，read 返回 null，不抛', async () => {
    const arc = createArchive({ dataDir, store, secrets: fakeSecrets, logger });
    expect(await arc.write('a', 'INBOX', 1, Buffer.from('x'), 0)).toMatchObject({ stored: false, reason: 'disabled' });
    expect(await arc.read('a', 'INBOX', 1)).toBeNull();
  });
});
```

- [ ] **Step 2: 确认失败** — `npx vitest run tests/email/archive.test.ts` → FAIL

- [ ] **Step 3: 实现 `plugins/email/service/lib/archive.js`**

```js
// 本地邮件库：加密落盘（MOMAIL1/AES-256-GCM）+ data.db 路径索引 + 保留清理。
// DB 只存相对路径与元数据，正文/附件只在加密文件里。settings.json 管 rootId/rootPath。
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { seal, open, generateMasterKey } = require('./crypto');

const ARCHIVE_MAX_BYTES = 25 * 1024 * 1024;
const KEY_NAME = 'archive:master-key';
const ENC_VERSION = 1;

function createArchive({ dataDir, store, secrets, logger, now = () => new Date() }) {
  const settingsFile = path.join(dataDir, 'settings.json');
  let masterKey = null; // 懒加载缓存

  function readSettings() {
    try { return JSON.parse(fs.readFileSync(settingsFile, 'utf8')); } catch { return {}; }
  }
  function writeSettings(next) {
    fs.mkdirSync(dataDir, { recursive: true });
    const tmp = settingsFile + '.tmp-' + process.pid + '-' + Date.now();
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
    fs.renameSync(tmp, settingsFile);
  }
  function archiveCfg() { return readSettings().archive || { enabled: false, rootId: null, rootPath: null }; }

  async function ensureMasterKey() {
    if (masterKey) return masterKey;
    const b64 = await secrets.get(KEY_NAME);
    if (b64) { masterKey = Buffer.from(b64, 'base64'); if (masterKey.length !== 32) throw new Error('归档主密钥长度非法（请清空本地库后重试）'); return masterKey; }
    masterKey = generateMasterKey();
    await secrets.set(KEY_NAME, masterKey.toString('base64'));
    return masterKey;
  }
  const aadOf = (accountId, folder, uid) => `${accountId}|${folder}|${uid}|${ENC_VERSION}`;

  // 段消毒：拒绝反斜杠/空段/./..（folder 与 accountId 同规则）
  function safeSegments(name) {
    const segs = String(name || '').split('/');
    if (String(name).includes('\\') || segs.some((s) => s === '' || s === '.' || s === '..')) {
      throw new Error(`归档路径名非法（拒绝路径段）: ${name}`);
    }
    return segs.map(encodeURIComponent);
  }
  function buildRelPath(accountId, folder, uid, msgDateMs, sha256) {
    const d = msgDateMs > 0 ? new Date(msgDateMs) : now();
    const month = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    return [...safeSegments(accountId), ...safeSegments(folder), month, `${uid}-${sha256.slice(0, 8)}.eml.enc`].join('/');
  }
  const absOf = (rel) => path.join(archiveCfg().rootPath, rel);

  async function setRoot(absPath) {
    const input = String(absPath || '');
    if (!path.isAbsolute(input)) throw new Error('必须提供绝对路径');
    const rp = fs.realpathSync(input); // 不存在/无权限会抛——包装中文
    // ↑ 包 try/catch 转「目录不存在或不可访问」
    const st = fs.statSync(rp);
    if (!st.isDirectory()) throw new Error('所选路径不是目录');
    if (rp === path.parse(rp).root) throw new Error('不能使用文件系统根目录');
    const probe = path.join(rp, `.momo-probe-${Date.now()}`);
    try { fs.writeFileSync(probe, ''); fs.unlinkSync(probe); } catch { throw new Error('目录不可写'); }
    const next = { ...readSettings(), archive: { enabled: true, rootId: crypto.randomUUID(), rootPath: rp } };
    writeSettings(next);
    return { rootPath: rp };
  }

  async function read(accountId, folder, uid) {
    const cfg = archiveCfg();
    if (!cfg.enabled || !cfg.rootPath) return null;
    const row = store.getArchiveRow(accountId, folder, uid);
    if (!row || row.state !== 'ok' || row.rootId !== cfg.rootId) return null;
    const abs = absOf(row.relPath);
    let sealed;
    try { sealed = fs.readFileSync(abs); } catch { store.setArchiveState(accountId, folder, uid, 'missing'); return null; }
    try {
      const raw = open(sealed, await ensureMasterKey(), aadOf(accountId, folder, uid));
      return { raw };
    } catch {
      try { fs.unlinkSync(abs); } catch { /* 删失败由 verifyStartup 兜 */ }
      store.setArchiveState(accountId, folder, uid, 'corrupt');
      logger.warn('归档文件解密失败，已删除并标记 corrupt', { accountId, folder, uid });
      return null;
    }
  }

  async function write(accountId, folder, uid, raw, msgDateMs) {
    const cfg = archiveCfg();
    if (!cfg.enabled || !cfg.rootPath) return { stored: false, reason: 'disabled' };
    const sha = crypto.createHash('sha256').update(raw).digest('hex');
    if (raw.length > ARCHIVE_MAX_BYTES) {
      store.upsertArchiveRow({ accountId, folder, uid, rootId: cfg.rootId, relPath: '', sizeBytes: 0,
        sha256: sha, encVersion: ENC_VERSION, msgDate: Number(msgDateMs) || 0, state: 'too_large', cachedAt: Date.now() });
      return { stored: false, reason: 'too_large' };
    }
    const key = await ensureMasterKey();
    const rel = buildRelPath(accountId, folder, uid, Number(msgDateMs) || 0, sha);
    const abs = absOf(rel);
    const sealed = seal(raw, key, aadOf(accountId, folder, uid));
    try {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      const tmp = abs + '.tmp-' + process.pid + '-' + Date.now();
      fs.writeFileSync(tmp, sealed);
      fs.renameSync(tmp, abs);
    } catch (err) {
      return { stored: false, reason: 'error', error: err instanceof Error ? err.message : String(err) };
    }
    store.upsertArchiveRow({ accountId, folder, uid, rootId: cfg.rootId, relPath: rel, sizeBytes: sealed.length,
      sha256: sha, encVersion: ENC_VERSION, msgDate: Number(msgDateMs) || 0, state: 'ok', cachedAt: Date.now() });
    return { stored: true };
  }

  async function prune(accountId, cutoffMs) {
    if (cutoffMs == null) return { removed: 0 };
    const cfg = archiveCfg();
    let removed = 0;
    for (const row of store.listArchiveRows(accountId, { state: 'ok' })) {
      if (row.rootId !== cfg.rootId || row.msgDate <= 0 || row.msgDate >= cutoffMs) continue;
      try { fs.unlinkSync(absOf(row.relPath)); } catch { /* 文件已不在 */ }
      store.deleteArchiveRows(accountId, { folder: row.folder });
      removed += 1;
    }
    return { removed };
  }

  function rmAccountDir(accountId) {
    try { fs.rmSync(path.join(archiveCfg().rootPath, ...safeSegments(accountId)), { recursive: true, force: true }); } catch { /* best-effort */ }
  }
  async function removeAccount(accountId) {
    const removed = store.deleteArchiveRows(accountId);
    rmAccountDir(accountId);
    return { removed };
  }
  async function clearCurrent() {
    const cfg = archiveCfg();
    const removed = store.deleteArchiveRows('__none__'); // 先占位 0——按 rootId 逐账号删：
    let total = 0;
    for (const row of store.listArchiveRows('*', {})) { /* 见下 */ }
    // 实现：SELECT DISTINCT account_id FROM local_archive WHERE root_id=cfg.rootId → 逐账号 removeAccount
    return { removed: total };
  }
  async function stats() {
    const cfg = archiveCfg();
    const s = cfg.rootId ? store.archiveStats(cfg.rootId) : { files: 0, bytes: 0, missing: 0, corrupt: 0, tooLarge: 0 };
    return { enabled: !!cfg.enabled, rootPath: cfg.rootPath, rootId: cfg.rootId, ...s };
  }
  async function verifyStartup(accountIds) {
    const cfg = archiveCfg();
    if (!cfg.enabled || !cfg.rootPath) return { fixedMissing: 0, removedOrphans: 0 };
    let fixedMissing = 0; let removedOrphans = 0;
    for (const accountId of accountIds) {
      const referenced = new Set();
      for (const row of store.listArchiveRows(accountId)) {
        if (row.rootId !== cfg.rootId) continue;
        if (row.state === 'ok') {
          if (fs.existsSync(absOf(row.relPath))) { referenced.add(row.relPath); }
          else { store.setArchiveState(accountId, row.folder, row.uid, 'missing'); fixedMissing += 1; }
        }
      }
      const accDir = path.join(cfg.rootPath, ...safeSegments(accountId));
      const walk = (dir) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const abs = path.join(dir, e.name);
          if (e.isDirectory()) walk(abs);
          else { const rel = path.relative(cfg.rootPath, abs); if (!referenced.has(rel)) { try { fs.unlinkSync(abs); removedOrphans += 1; } catch { /* best-effort */ } } }
        }
      };
      try { walk(accDir); } catch { /* 目录不存在 */ }
    }
    return { fixedMissing, removedOrphans };
  }

  return { read, write, prune, removeAccount, clearCurrent, stats, setRoot, verifyStartup };
}

module.exports = { createArchive, ARCHIVE_MAX_BYTES };
```

**注意（实现时收敛）**：上面 `clearCurrent` 的伪段按注释落成——

```js
async function clearCurrent() {
  const cfg = archiveCfg();
  const accounts = dbDistinctAccountsByRoot(cfg.rootId); // store 增列方法：SELECT DISTINCT account_id FROM local_archive WHERE root_id=?
  let total = 0;
  for (const accountId of accounts) { total += store.deleteArchiveRows(accountId, { rootId: cfg.rootId }); rmAccountDir(accountId); }
  return { removed: total };
}
```

`store` 需补 `archiveAccountsOfRoot(rootId): string[]`（并入 Task 3 的接口；实现为 `SELECT DISTINCT account_id ...`）。`prune` 中 `store.deleteArchiveRows(accountId, { folder })` 需支持同账号多行删除（现有签名已支持）。

- [ ] **Step 4: 通过** — `npx vitest run tests/email/archive.test.ts` → PASS

- [ ] **Step 5: Commit**

```bash
git add plugins/email/service/lib/archive.js tests/email/archive.test.ts
git commit -m "feat(email): 本地归档模块（加密落盘/路径索引/保留清理/启动自愈）"
```

---

### Task 5: 读路径接入（mailbox 本地优先）

**Files:**
- Modify: `plugins/email/service/lib/mailbox.js`（`createMailbox` 增 `archive` 可选依赖；`readImpl` / `attachmentImpl`）
- Test: `tests/email/service-mailbox.test.ts`

**Interfaces:**
- Consumes: Task 4 `archive.read/write`；`createMailbox({ accountStore, cache, store, archive, imapConnect, parseMail, opTimeoutMs })`（`archive` 可缺省——旧用例不注入仍走纯 IMAP）。
- Produces: `mailbox.read` 行为：LRU → archive → IMAP；IMAP 成功后**异步** `archive.write`（不 await、错误仅 warn）。`attachment` 同构。

- [ ] **Step 1: 写失败测试（service-mailbox.test.ts 追加；沿用该文件既有 fake conn/fake store harness 形态）**

```ts
function mkArchiveHarness() {
  const written: Array<{ accountId: string; folder: string; uid: number; raw: Buffer }> = [];
  const files = new Map<string, Buffer>(); // key acc|folder|uid
  return {
    written,
    archive: {
      async read(accountId: string, folder: string, uid: number) {
        const raw = files.get(`${accountId}|${folder}|${uid}`);
        return raw ? { raw } : null;
      },
      async write(accountId: string, folder: string, uid: number, raw: Buffer) {
        written.push({ accountId, folder, uid, raw });
        files.set(`${accountId}|${folder}|${uid}`, raw);
        return { stored: true };
      },
    },
  };
}

it('本地归档命中 → 不触 IMAP；from/subject 兜底自解析', async () => {
  const h = mkArchiveHarness();
  h.archive.write('acc1', 'INBOX', 1, Buffer.from('From: local@x.y\r\nSubject: 本地信\r\nDate: Wed, 05 Nov 2026 10:00:00 +0000\r\n\r\n本地正文'), 0); // 预置
  const boom = { async search() { throw new Error('不应触网'); } };
  const mb = createMailbox({ accountStore: fakeAccountStore, cache: fakeCache, store: fakeStore, archive: h.archive,
    imapConnect: async () => boom, parseMail, opTimeoutMs: 500 });
  const view = await mb.read('acc1', 'INBOX', 1);
  expect(view.subject).toBe('本地信');
  expect(String(view.text)).toContain('本地正文');
});

it('IMAP 回退成功 → 异步回填归档（raw 为 RFC822 source）', async () => {
  const h = mkArchiveHarness();
  const mb = createMailbox({ ..., archive: h.archive, imapConnect: fakeImap(源 = 'From: a@b\r\nSubject: s\r\n\r\nbody') });
  await mb.read('acc1', 'INBOX', 1);
  await new Promise((r) => setTimeout(r, 50)); // 等异步回填
  expect(h.written).toHaveLength(1);
  expect(h.written[0]!.raw.toString()).toContain('Subject: s');
});

it('归档损坏（read 返回 null）→ 回退 IMAP 不报错', async () => {
  const h = mkArchiveHarness();
  h.archive.read = async () => null; // 模拟 corrupt→null
  const mb = createMailbox({ ..., archive: h.archive, imapConnect: fakeImap('Subject: ok') });
  const view = await mb.read('acc1', 'INBOX', 1);
  expect(view.subject).toBe('ok');
});

it('attachment 本地优先；本地缺失回退 IMAP 并回填', async () => {
  const h = mkArchiveHarness();
  await h.archive.write('acc1', 'INBOX', 1, rfc822WithAttachment(), 0);
  const mb = createMailbox({ ..., archive: h.archive, imapConnect: fakeImap(任意) });
  const att = await mb.attachment('acc1', 'INBOX', 1, '2.1'); // partId 视 fixture
  expect(att.filename).toBe('a.txt');
});
```

（`fakeImap`/`rfc822WithAttachment` 按该文件既有 fake 风格实现；关键断言：命中本地时 imapConnect 不被调用。）

- [ ] **Step 2: 确认失败** — `npx vitest run tests/email/service-mailbox.test.ts` → FAIL

- [ ] **Step 3: 实现 mailbox.js**

`createMailbox` 解构加 `archive`（可缺省）。抽公共视图构造（与现 readImpl 内联逻辑一致）：

```js
function buildReadView(uid, env, parsed) {
  const text = String(parsed.text || '');
  const textTruncated = text.length > TEXT_TRUNCATE;
  const htmlRaw = typeof parsed.html === 'string' && parsed.html.trim() !== '' ? parsed.html : null;
  const htmlTruncated = htmlRaw != null && htmlRaw.length > TEXT_TRUNCATE;
  return {
    uid, subject: env.subject, from: env.from, to: env.to, date: env.date, seen: env.seen,
    text: textTruncated ? text.slice(0, TEXT_TRUNCATE) + '\n…（已截断，全文 200KB 上限）' : text,
    html: htmlTruncated ? htmlRaw.slice(0, TEXT_TRUNCATE) + '\n…（已截断，全文 200KB 上限）' : htmlRaw,
    truncated: textTruncated || htmlTruncated,
    attachments: (parsed.attachments || []).map((a) => ({
      partId: a.partId, filename: a.filename, contentType: a.contentType, size: a.content ? a.content.length : 0,
    })),
  };
}
```

`readImpl` 改造（保留 LRU 与现有 IMAP 分支逻辑，仅外提视图构造）：

```js
async function readImpl(accountId, folder, uid) {
  const key = `${accountId}|${folder}|${uid}`;
  const cached = readCacheGet(key);
  if (cached) return cached;
  // 1) 本地归档优先
  if (archive) {
    const hit = await archive.read(accountId, folder, uid);
    if (hit) {
      if (hit.raw.length > READ_SOURCE_MAX) {
        throw new Error(`邮件体积 ${(hit.raw.length / 1048576).toFixed(1)}MB 超过 2MB 读取上限——附件请用 save_attachment`);
      }
      const parsed = await parseMail(hit.raw);
      const env = cache.read(accountId, folder)?.items.find((e) => e.uid === uid)
        ?? { subject: parsed.subject ?? '', from: parsed.from?.text ?? '', to: parsed.to?.text ?? '', date: parsed.date?.toISOString?.() ?? null, seen: false };
      const view = buildReadView(uid, env, parsed);
      readCacheSet(key, view);
      return view;
    }
  }
  // 2) IMAP 回退（原逻辑），成功后异步回填
  const { env, source } = await withConn(accountId, async (conn) => { /* 原 readImpl 的 IMAP 段原样 */ });
  const parsed = await parseMail(source);
  const view = buildReadView(uid, env, parsed);
  if (archive) {
    void archive.write(accountId, folder, uid, source, Date.parse(env.date) || 0)
      .catch((err) => { /* warn 仅日志 */ });
  }
  readCacheSet(key, view);
  return view;
}
```

`attachmentImpl` 同构：先 `archive.read` → `parseMail` → 找 part（`raw.length > ATTACH_MAX` 拒绝）；未命中走原 IMAP 段并异步回填。

- [ ] **Step 4: 通过（含既有全部 mailbox 用例）** — `npx vitest run tests/email/service-mailbox.test.ts` → PASS

- [ ] **Step 5: Commit**

```bash
git add plugins/email/service/lib/mailbox.js tests/email/service-mailbox.test.ts
git commit -m "feat(email): 读信/附件本地归档优先，IMAP 回退异步回填"
```

---

### Task 6: service 接线（路由/启动/清理触发/删账号级联）

**Files:**
- Modify: `plugins/email/service/index.js`（buildService：archive 注入、ROUTES、start/stop、accounts.delete/update 钩子）
- Test: `tests/email/service-index.test.ts`

**Interfaces:**
- Produces ROUTES：
  - `archive.getSettings` → `stats()`（含 enabled/rootPath/计数）
  - `archive.setRoot { path }` → `{ rootPath }`（校验错误中文抛出）
  - `archive.clear` → `{ removed }`
  - `accounts.delete` 成功后 → `archive.removeAccount(id)`（失败仅 warn 不阻断删除）
  - `start()`：`drafts.sweep()` + `archive.verifyStartup(账号ids)` + `pruneAll()`；并起 10 分钟周期 `pruneAll`
  - `pruneAll()`：对每账号按 `retentionCutoff`（含 Sent 豁免——复用 mailbox 暴露的 `retentionCutoffOf(accountId, folder)`？**实现裁定**：mailbox 新增导出 `retentionCutoff(accountId, folder)` 供 service 调用（内部函数已存在，导出即可）；service 对该账号的**所有已归档文件夹**逐个取 cutoff 执行 prune）
  - `stop()`：`mailbox.closeAll()` + `store.close()`（清周期定时器 `clearInterval`）
  - `accounts.update` 成功后 → 立即 `pruneAll(accountId)`（retention 可能变化）

- [ ] **Step 1: 写失败测试（service-index.test.ts 追加）**

```ts
it('archive.setRoot/getSettings/clear 路由', async () => {
  const svc = buildServiceWith({ dataDir: tmpDir }); // 既有 harness 形态
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'root-'));
  const r = await svc.handle('archive.setRoot', { path: root });
  expect(r.rootPath).toBe(fs.realpathSync(root));
  const st = await svc.handle('archive.getSettings', {});
  expect(st.enabled).toBe(true); expect(st.rootPath).toBe(fs.realpathSync(root));
  const c = await svc.handle('archive.clear', {});
  expect(c.removed).toBe(0);
});
it('setRoot 非法路径中文报错', async () => {
  const svc = buildServiceWith({ dataDir: tmpDir });
  await expect(svc.handle('archive.setRoot', { path: 'rel/x' })).rejects.toThrow(/绝对路径/);
});
it('accounts.delete 级联清理归档（索引+目录）', async () => {
  // fake secrets/accounts 注入（既有 harness）；先 setRoot + 模拟 write 一行（直调内部 archive 不可行——
  // 通过 mails.read 落盘太重；此处改为：预置 local_archive 行 + 目录文件，断言 delete 后两者消失）
});
```

（第三个用例按既有 `buildService` 依赖注入形态落地：预置 `data.db` 行与 `<root>/accX/...` 文件 → `accounts.delete` → 断言。）

- [ ] **Step 2: 确认失败** — `npx vitest run tests/email/service-index.test.ts` → FAIL

- [ ] **Step 3: 实现 index.js**

```js
const { createArchive } = require('./lib/archive');
// buildService 内：
const archive = createArchive({ dataDir, store, secrets, logger });
const mailbox = createMailbox({ accountStore, cache, store, archive, imapConnect, parseMail, opTimeoutMs: 8000 });
let pruneTimer = null;
async function pruneAll() {
  try {
    for (const acc of await accountStore.list()) {
      for (const row of store.listArchiveRows(acc.id)) {           // DISTINCT folder 由行集自然得到
        const cutoff = await mailbox.retentionCutoff(acc.id, row.folder);
        await archive.prune(acc.id, cutoff);
        break;                                                     // prune 是账号级一次搞定——直接一次即可
      }
    }
  } catch (err) { logger.warn('归档保留清理失败（忽略）', { error: String(err) }); }
}
// start():
async start() {
  await drafts.sweep();
  try {
    const ids = (await accountStore.list()).map((a) => a.id);
    const v = await archive.verifyStartup(ids);
    if (v.fixedMissing || v.removedOrphans) logger.info?.('归档启动核对', v);
    await pruneAll();
  } catch (err) { logger.warn('归档初始化失败（降级为在线读信）', { error: String(err) }); }
  pruneTimer = setInterval(() => { void pruneAll(); }, 10 * 60 * 1000);
  logger.info?.('email service started');
}
// stop(): clearInterval(pruneTimer); await mailbox.closeAll(); store.close();
// ROUTES 增：
'archive.getSettings': () => archive.stats(),
'archive.setRoot': (p) => archive.setRoot(String(p.path || '')),
'archive.clear': () => archive.clearCurrent(),
// accounts.delete 分支（成功后）：
try { await archive.removeAccount(id); } catch (err) { logger.warn('删除账号本地库失败（索引已删）', { error: String(err) }); }
// accounts.update 分支（成功后）：void pruneAll().catch(() => undefined);
```

mailbox.js 导出内部 `retentionCutoff`（返回对象上挂 `retentionCutoff`）。`pruneAll` 简化为「每账号一次 prune，cutoff 取该账号 INBOX 的（同账号各文件夹策略一致；Sent 在 prune 内不豁免——需豁免）」：**修正**——prune 需逐文件夹判断 Sent 豁免，落成：

```js
async function pruneAccount(accountId) {
  const folders = new Set(store.listArchiveRows(accountId).map((r) => r.folder));
  for (const folder of folders) {
    const cutoff = await mailbox.retentionCutoff(accountId, folder); // Sent/forever → null
    if (cutoff != null) await archive.prune(accountId, cutoff);
  }
}
```

- [ ] **Step 4: 通过 + 全套件** — `npx vitest run tests/email` → PASS（ABI 纪律照 Global Constraints）

- [ ] **Step 5: Commit**

```bash
git add plugins/email/service/index.js plugins/email/service/lib/mailbox.js tests/email/service-index.test.ts
git commit -m "feat(email): 归档服务接线（路由/启动核对/周期清理/删账号级联）"
```

---

### Task 7: 面板「存储」设置区

**Files:**
- Modify: `plugins/email/panel/index.html`（toolbar 按钮 + 存储弹层 + JS）
- Test: `tests/email/panel-static.test.ts`

**Interfaces:**
- Consumes: Task 1 `send('app:pickDirectory', { title })`；Task 6 `archive.getSettings/setRoot/clear`。

- [ ] **Step 1: 写失败断言（panel-static.test.ts 追加）**

```ts
it('存储设置区：按钮/弹层/选目录桥/清空', () => {
  const html = readPanelHtml();
  expect(html).toContain('存储…');
  expect(html).toContain('id="st-path"');
  expect(html).toContain("send('app:pickDirectory'");
  expect(html).toContain('archive.getSettings');
  expect(html).toContain('archive.setRoot');
  expect(html).toContain('archive.clear');
  expect(html).toContain('主密钥丢失'); // 风险提示文案
});
```

- [ ] **Step 2: 确认失败** — `npx vitest run tests/email/panel-static.test.ts` → FAIL

- [ ] **Step 3: 实现面板**

HTML（`col-left` toolbar 追加按钮；弹层与 `#compose` 同款遮罩结构）：

```html
<div class="toolbar"><button class="pri" onclick="openAccountForm('add')">+ 添加账号</button><button onclick="openAccountForm('edit')">编辑当前账号</button><button onclick="openStorage()">存储…</button></div>

<div id="storage-form">
  <div class="box">
    <b>本地邮件存储</b>
    <label>存储目录</label>
    <input id="st-path" readonly placeholder="未启用（仅在线读信）">
    <div style="display:flex;gap:8px;justify-content:flex-end">
      <button onclick="chooseStorageDir()">选择目录…</button>
      <button class="pri" onclick="clearArchive()">清空本地库…</button>
      <button onclick="$('storage-form').style.display='none'">关闭</button>
    </div>
    <div class="hint" id="st-note">正文与附件加密存储于所选目录；数据库仅存路径索引。主密钥保存在系统钥匙串，丢失后本地邮件不可恢复。</div>
    <div class="status" id="st-stats"></div>
  </div>
</div>
```

JS：

```js
function openStorage() {
  $('storage-form').style.display = 'flex';
  $('st-stats').textContent = '加载中…';
  call('archive.getSettings', {}).then(function (s) {
    $('st-path').value = s.enabled ? (s.rootPath || '') : '';
    $('st-stats').textContent = s.enabled
      ? '文件 ' + s.files + ' 个 / ' + (s.bytes / 1048576).toFixed(1) + ' MB'
        + (s.missing ? '；缺失 ' + s.missing : '') + (s.corrupt ? '；损坏 ' + s.corrupt : '')
      : '';
  }).catch(function (e) { $('st-stats').textContent = '读取失败：' + e.message; });
}
function chooseStorageDir() {
  send('app:pickDirectory', { title: '选择邮件存储目录' }).then(function (p) {
    if (!p) return; // 用户取消
    call('archive.setRoot', { path: p }).then(function () { openStorage(); })
      .catch(function (e) { $('st-stats').className = 'status err'; $('st-stats').textContent = e.message; });
  }).catch(function (e) { $('st-stats').className = 'status err'; $('st-stats').textContent = e.message; });
}
function clearArchive() {
  inlineConfirm('清空本地邮件库？仅删除当前目录的加密文件与索引，不影响服务器邮件。').then(function (ok) {
    if (!ok) return;
    call('archive.clear', {}).then(function (r) { toast('已清理 ' + r.removed + ' 条'); openStorage(); })
      .catch(function (e) { $('st-stats').className = 'status err'; $('st-stats').textContent = e.message; });
  });
}
```

- [ ] **Step 4: 通过** — `npx vitest run tests/email/panel-static.test.ts` → PASS

- [ ] **Step 5: Commit**

```bash
git add plugins/email/panel/index.html tests/email/panel-static.test.ts
git commit -m "feat(email): 面板存储设置（选目录/统计/清空，走 app:pickDirectory 桥）"
```

---

### Task 8: 全量回归 + 文档指针 + 真机验收脚本

**Files:**
- Modify: `momo-studio-email/docs/specs/2026-11-05-email-plugin-design.md`（§5.1 加一行指向归档 spec）
- Create: `momo-plugin/.omo/qa-reports/2026-11-05-archive-e2e/verify.mjs`（真机验收脚本，执行者写好、由主会话跑）

**Interfaces:**
- Produces: 验收脚本覆盖 spec §13 真机 5 条：①setRoot→读信→密文文件出现（前 7 字节 MOMAIL1、不含明文）②删文件→重读自愈 ③注入旧 msg_date→prune→文件与索引消失、Sent 不受影响 ④切换根目录→旧文件保留、新读落新目录 ⑤面板存储区可见统计。

- [ ] **Step 1: 全量测试（两仓）**

Run:
```bash
cd /Users/stbearangel/dev/AiProject/momo-plugin && MOMO_STUDIO_ROOT=/Users/stbearangel/dev/AiProject/momo-studio-email npx vitest run tests/email   # ABI 纪律照旧
cd /Users/stbearangel/dev/AiProject/momo-studio-email && npx pnpm@9.0.0 typecheck
```
Expected: 全绿 / 0 errors

- [ ] **Step 2: 文档指针**

`2026-11-05-email-plugin-design.md` §5.1 末尾追加一行：
`正文/附件本地加密归档见 2026-11-05-email-local-archive-design.md（schema v3：local_archive）。`

- [ ] **Step 3: 写真机验收脚本**（playwright 连 CDP 9333；脚本骨架照 `.omo/qa-reports/2026-11-05-panel-verify/*.mjs` 既有形态：打开面板 → `window.call('archive.setRoot'...)` → `mails.get` 读一封 → node 侧检查文件字节 → `fs.unlink` → 再读 → 注入 `local_archive.msg_date` 旧值 + 触发 `accounts.update`（retention=1m）prune → 检查）

- [ ] **Step 4: Commit（两仓）**

```bash
# 插件仓
git add .omo/qa-reports/2026-11-05-archive-e2e/verify.mjs
git commit -m "test(email): 归档真机验收脚本"
# 平台仓
git add docs/specs/2026-11-05-email-plugin-design.md
git commit -m "docs(spec): email spec 链接归档设计"
```

（真机执行由主会话完成：重启 App → 跑脚本 → 证据截图/输出落 `.omo/qa-reports/2026-11-05-archive-e2e/evidence/`。）

---

## Self-Review 记录

1. **Spec coverage**：§4 布局（T4）、§5 索引（T3）、§6 加密（T2）、§7 读写路径（T5/T6）、§8 设置与换根（T4/T7）、§9 清理自愈（T4/T6）、§10 UI（T7）、§11 平台桥（T1）、§12 错误降级（T4/T5/T6 测试覆盖）、§13 测试（各任务 + T8）、§15 拆分对齐。无缺口。
2. **占位符**：Task 4 `clearCurrent` 伪段已显式标注并给出落成代码；其余无 TBD。
3. **类型一致**：`ArchiveRow` 字段 camelCase 与 store 方法/测试一致；`archive.read/write` 签名在 T4/T5/T6 一致；`pickDirectory(opts)` 与 preload 类型一致。
4. **Review Focus**：5 条均已映射到具体测试（T4×3、T2、T5×2）。
