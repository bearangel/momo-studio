# 邮件插件（email）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现多邮箱收发插件（IMAP/SMTP + 邮件面板 + 7 个 agent 工具 + skill + 预置邮件助手），外加 moo-studio 一处平台扩展（`PluginServiceCtx.secrets`）。

**Architecture:** 标准全组件插件（方案 A）：service 主进程常驻（账号管理 + IMAP/SMTP + 信封轻缓存 + 草稿状态机）；tools 经 callService RPC 调 service，附件落盘走 ToolContext.wsFs + 变更记账；panel 为 `location: page` 沙箱 iframe 三栏 UI；发送门禁三层（行为契约 + draft_id 强绑定 + 面板草稿箱可视）。

**Tech Stack:** 插件侧纯 CJS JS（无构建）+ imapflow / nodemailer / mailparser（vendor 内嵌，全纯 JS）；平台侧 TypeScript strict。

**Spec:** `docs/specs/2026-11-05-email-plugin-design.md`（本计划从 spec 出发，执行者两份都读）

## Global Constraints

- Node 24（`nvm use 24`）；moo-studio 用 `npx pnpm@9.0.0`；momo-plugin vendor 内用 `npm`
- moo-studio 改动 TypeScript strict：禁 `any` / `@ts-ignore` / `as any`
- 插件 JS（CJS）**不得 require electron 或宿主内部模块**；vendor 依赖用相对路径 `require('../vendor/node_modules/<pkg>')`（office-pro 先例）
- 工具模块**一文件一工具，文件名 = 工具短名**（manifest cross-ref 硬校验；短名正则 `/^[a-z][a-z0-9_-]*$/`，不得与内置工具重名）
- 密码/授权码只进 keytar（`ctx.secrets`）；`accounts.json` / 日志 / 工具返回值永不出现明文凭据
- dataDir JSON 一律 tmp+rename 原子写；读侧损坏一律丢弃重建不抛
- 加密强制：`tlsMode ∈ {'tls','starttls'}`，明文端口（裸 25/143）双守门拒绝
- 数值上限（spec §6/§10）：save_attachment 单附件 ≤10MB；draft 附件总量 ≤25MB；list_mails pageSize 缺省 20 上限 50；信封缓存每 folder 500 条 FIFO；正文截断 200KB；read_mail 拒收 source >2MB；草稿 24h 过期；IMAP 单操作超时 30s（可注入缩短供测试）
- 测试位置：moo-studio → `electron/tests/plugin|storage/`（DB 重度目录跑加 `--pool=forks`）；momo-plugin → `tests/email/`（宿主校验器经 `tests/host.ts` 动态 import，`describe.skipIf(!HOST_READY)` 容忍宿主缺失）
- Conventional Commits；两仓库都不动版本号；`momo-plugin.json` 版本固定 `0.1.0`
- 插件 dev 装载流：宿主「插件设置 → 开发目录装载」指向 `<momo-plugin>/plugins/email`（`installPluginDevDir` 直读源目录，改码→重载即生效）

## Review Focus

（spec 隐含但易咬人的五类输入；每条已绑定归属任务的测试）

1. **凭据泄漏面**——工具返回/错误信息带出授权码 → Task 5（list 形状断言无密码字段）+ Task 10（透传断言）
2. **明文连接降级**——用户配裸 25/143 或非法 tlsMode → Task 5（add/update 校验拒绝）+ Task 9（连接参数仅 tls/starttls 映射）
3. **RPC base64 炸弹**——超大附件经 callService 拉爆内存 → Task 8（service 侧 10MB 拒）+ Task 11（工具侧 10MB/25MB 双守门）
4. **草稿重放/伪造**——send_draft 传不存在/已 sent 的 draftId、绕过起草直接发 → Task 7（状态机拒绝 + envelope 收件人只来自草稿登记）+ Task 11（send_draft 仅 draftId 无收件人参数）
5. **缓存/登记文件损坏**——手写恶意超大/损坏 JSON → Task 6（损坏读 null 重建）+ Task 5/7（accounts/drafts 损坏容错）

---

## Phase 0 — 平台扩展（moo-studio 仓库，workdir `/Users/stbearangel/dev/AiProject/moo-studio`）

### Task 1: keychain 门面前缀枚举

**Files:**
- Modify: `electron/src/main/storage/keychain.ts`
- Test: `electron/tests/storage/keychain.test.ts`（既有 FakeKeytar 扩展）

**Interfaces:**
- Produces: `findSecretKeysByPrefix(prefix: string): Promise<string[]>`（导出）；`KeytarLike` 增加 `findCredentials`

- [ ] **Step 1: 写失败测试**（keychain.test.ts 追加；FakeKeytar 按其现有存储 Map 补 `findCredentials`：遍历存储过滤 service，映射为 `[{account, password}]`）

```ts
it('findSecretKeysByPrefix 按服务名前缀枚举账号键（插件自管 secrets 清理依赖）', async () => {
  await setSecret('plugin.email.secret.account:acc1', 'x');
  await setSecret('plugin.email.secret.account:acc2', 'y');
  await setSecret('plugin.other.secret.k', 'z');
  const keys = await findSecretKeysByPrefix('plugin.email.secret.');
  expect([...keys].sort()).toEqual([
    'plugin.email.secret.account:acc1',
    'plugin.email.secret.account:acc2',
  ]);
  expect(await findSecretKeysByPrefix('plugin.none.secret.')).toEqual([]);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/storage/keychain.test.ts --pool=forks`
Expected: FAIL（findSecretKeysByPrefix 未定义）

- [ ] **Step 3: 最小实现**（keychain.ts）

```ts
export type KeytarLike = Pick<
  typeof Keytar,
  'setPassword' | 'getPassword' | 'deletePassword' | 'findCredentials'
>;

/** 前缀枚举（插件自管 secrets 卸载级联用）：返回命中前缀的账号键列表 */
export async function findSecretKeysByPrefix(prefix: string): Promise<string[]> {
  const creds = await loadKeytar().findCredentials(keychainServiceName());
  return creds.map((c) => c.account).filter((a) => a.startsWith(prefix));
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: 同 Step 2。Expected: PASS（含既有全部用例）

- [ ] **Step 5: Commit**

```bash
git add electron/src/main/storage/keychain.ts electron/tests/storage/keychain.test.ts
git commit -m "feat: keychain 门面支持前缀枚举（插件自管 secrets 卸载清理依赖）"
```

### Task 2: PluginServiceCtx.secrets 接线

**Files:**
- Modify: `electron/src/main/plugin/config-store.ts`（新增两个导出）
- Modify: `electron/src/main/plugin/service-manager.ts`（接口 + ctx 组装）
- Test: `electron/tests/plugin/service-manager.test.ts`（追加）

**Interfaces:**
- Consumes: keychain 门面 `getSecret/setSecret/deleteSecret`
- Produces: `pluginSecretRef(pluginId, key): string`；`isValidPluginSecretKey(key): boolean`；`PluginSecretsApi { get/set/delete }`；`PluginServiceCtx.secrets`

- [ ] **Step 1: 写失败测试**（service-manager.test.ts 追加；沿用该文件既有假插件 harness——其 service/index.js 的 createService 捕获 ctx 到测试全局）

```ts
it('ctx.secrets：set/get/delete 走 keytar，键域 plugin.<id>.secret.<key>；非法键拒绝', async () => {
  const writes: Array<[string, string, string]> = [];
  setKeytarBackendForTest({
    async setPassword(service, account, password) { writes.push([service, account, password]); },
    async getPassword(_s, account) { return account.endsWith(':pw') ? 'secret-v' : null; },
    async deletePassword() {},
    async findCredentials() { return []; },
  });
  // …既有 harness：安装 service 型 dev 插件 'secrets-demo'（createService 捕获 ctx）…
  const started = await startPluginService(makeServiceRec('secrets-demo'));
  expect(started).toBe(true);
  const secrets = capturedCtx!.secrets;
  await secrets.set('account:acc1:pw', 'raw-pw');
  expect(writes[0]![0]).toBe(keychainServiceName());
  expect(writes[0]![1]).toBe('plugin.secrets-demo.secret.account:acc1:pw');
  expect(await secrets.get('account:acc1:pw')).toBe('secret-v');
  await expect(secrets.set('bad key!')).rejects.toThrow('非法 secret 键');
  await expect(secrets.get('../escape')).rejects.toThrow('非法 secret 键');
  await stopPluginService('secrets-demo');
  __resetKeychainImplForTest();
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/plugin/service-manager.test.ts --pool=forks`
Expected: FAIL（ctx.secrets 为 undefined）

- [ ] **Step 3: 实现**

config-store.ts（紧邻 `sensitiveRef`）：

```ts
/** 插件自管 secret 键（service ctx.secrets 面）：与 config 敏感键同域点分惯例，域后缀区分 */
export function pluginSecretRef(pluginId: string, key: string): string {
  return `plugin.${pluginId}.secret.${key}`;
}

/** secret 键白名单：字母数字开头，主体 [A-Za-z0-9_.:-]，总长 ≤128（拒 glob/路径注入面） */
export function isValidPluginSecretKey(key: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(key);
}
```

service-manager.ts 接口区新增：

```ts
/** 插件自管 secrets（邮件插件起）：keytar 代理，键域 plugin.<id>.secret.<key> */
export interface PluginSecretsApi {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}
```

`PluginServiceCtx` 增加必填 `secrets: PluginSecretsApi;`；`doStartPluginService` ctx 组装新增（imports：keychain 三函数 + config-store 两函数）：

```ts
const guard = (key: string): string => {
  if (!isValidPluginSecretKey(key)) throw new Error(`非法 secret 键: ${key}`);
  return pluginSecretRef(rec.id, key);
};
// ctx 字面量内追加：
  secrets: {
    get: (key) => getSecret(guard(key)),
    set: (key, value) => setSecret(guard(key), value),
    delete: (key) => deleteSecret(guard(key)),
  },
```

既有测试桩若自建 PluginServiceCtx 形状，补最小 secrets 桩直到 typecheck 绿。

- [ ] **Step 4: 跑测试 + typecheck**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/plugin/service-manager.test.ts --pool=forks && cd .. && npx pnpm@9.0.0 typecheck`
Expected: PASS / 0 error

- [ ] **Step 5: Commit**

```bash
git add electron/src/main/plugin/config-store.ts electron/src/main/plugin/service-manager.ts electron/tests/plugin/service-manager.test.ts
git commit -m "feat: PluginServiceCtx.secrets——插件自管凭据 keytar 代理"
```

### Task 3: 卸载级联清理自管 secrets

**Files:**
- Modify: `electron/src/main/plugin/installer.ts`（uninstallPlugin 内，既有 sensitive config 清理块之后）
- Test: `electron/tests/plugin/installer.test.ts`（追加）

**Interfaces:**
- Consumes: Task 1 `findSecretKeysByPrefix`；键域约定 `plugin.<id>.secret.`

- [ ] **Step 1: 写失败测试**

```ts
it('卸载 keepData=false 前缀级联清理自管 secrets；keepData=true 不清', async () => {
  const deleted: string[] = [];
  setKeytarBackendForTest({
    async setPassword() {},
    async getPassword() { return null; },
    async deletePassword(_s, account) { deleted.push(account); },
    async findCredentials() {
      return [
        { account: 'plugin.email.secret.account:acc1', password: 'x' },
        { account: 'plugin.email.secret.account:acc2', password: 'y' },
        { account: 'plugin.other.secret.k', password: 'z' },
      ];
    },
  });
  // …既有 harness：安装 dev 插件 'email-cascade'…
  uninstallPlugin('email-cascade', true);
  expect(deleted).toEqual([]);
  installPluginDevDir(devDir, '9.9.9', wsId);
  uninstallPlugin('email-cascade', false);
  expect([...deleted].sort()).toEqual([
    'plugin.email.secret.account:acc1',
    'plugin.email.secret.account:acc2',
  ]);
  __resetKeychainImplForTest();
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/plugin/installer.test.ts --pool=forks`
Expected: FAIL（deleted 为空）

- [ ] **Step 3: 实现**（uninstall 函数内、`evictPluginConfigCache` 之前；函数是同步的，沿用既有 fire-and-forget 模式）

```ts
// 插件自管 secrets（service ctx.secrets 面）前缀级联：keytar 枚举，无注册表依赖；
// 失败不阻断卸载（残留键无外送面——仅本机 keychain）
{
  const prefix = `plugin.${id}.secret.`;
  void findSecretKeysByPrefix(prefix)
    .then((keys) => Promise.allSettled(keys.map((k) => deleteSecret(k))))
    .catch(() => undefined);
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: 同 Step 2。Expected: PASS（含既有用例）

- [ ] **Step 5: Commit**

```bash
git add electron/src/main/plugin/installer.ts electron/tests/plugin/installer.test.ts
git commit -m "feat: 插件卸载前缀级联清理自管 secrets"
```

---

## Phase 1 — 插件骨架（momo-plugin 仓库，workdir `/Users/stbearangel/dev/AiProject/momo-plugin`）

### Task 4: manifest + vendor + 目录骨架

**Files:**
- Create: `plugins/email/momo-plugin.json`、`plugins/email/vendor/package.json`
- Create 目录（`.gitkeep` 占位）：`tools/`、`service/lib/`、`skills/email-ops/`、`agents/`、`panel/`
- Test: `tests/email/fixtures.ts`、`tests/email/manifest.test.ts`

**Interfaces:**
- Produces: `PLUGIN_ROOT`、`VENDOR_REAL`（tests/email/fixtures.ts 导出，后续测试共用）

- [ ] **Step 1: 写 manifest 校验测试**

`tests/email/fixtures.ts`：

```ts
// email 插件测试共享夹具（officepro/fixtures.ts 同款模式）
import fs from 'node:fs';
import path from 'node:path';

export const PLUGIN_ROOT = path.resolve(__dirname, '..', '..', 'plugins', 'email');

/** vendor 在位标记（vendor 目录 npm install 后；service 集成用例消费） */
export const VENDOR_REAL = fs.existsSync(path.join(PLUGIN_ROOT, 'vendor', 'node_modules', 'imapflow'));
```

`tests/email/manifest.test.ts`：

```ts
// manifest 校验锁：宿主 validateManifest + 组件五项路径形状
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { HOST_READY, hostImport } from '../host';
import { PLUGIN_ROOT } from './fixtures';

let validateManifest: ((m: unknown, root: string) => void) | null = null;

describe.skipIf(!HOST_READY)('email 插件 manifest', () => {
  beforeAll(async () => {
    const mod = (await hostImport('plugin/manifest.ts')) as unknown as {
      validateManifest: (m: unknown, root: string) => void;
    };
    validateManifest = mod.validateManifest;
  });

  it('manifest 通过 validateManifest（组件目录全部在位）', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, 'momo-plugin.json'), 'utf-8'));
    expect(manifest.id).toBe('email');
    validateManifest!(manifest, PLUGIN_ROOT);
  });

  it('组件五项齐全且为 ./ 相对路径', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, 'momo-plugin.json'), 'utf-8'));
    for (const k of ['tools', 'service', 'skills', 'agents', 'panel'] as const) {
      expect(manifest.components[k]).toMatch(/^\.\//);
    }
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/email/manifest.test.ts`
Expected: FAIL（momo-plugin.json 不存在）

- [ ] **Step 3: 创建骨架**

`plugins/email/momo-plugin.json`：

```json
{
  "id": "email",
  "name": "邮件",
  "version": "0.1.0",
  "description": "多邮箱收发助手：IMAP/SMTP 多账号管理 + 邮件面板 + agent 工具集与邮件助手预置",
  "components": {
    "tools": "./tools",
    "service": "./service",
    "skills": "./skills",
    "agents": "./agents",
    "panel": "./panel"
  }
}
```

（刻意不设 `minAppVersion`：secrets 扩展落在 2.1.0-alpha 线，semver 预发布比较会误拒当前宿主；发布 hub 前统一定版。）

`plugins/email/vendor/package.json`：

```json
{
  "name": "email-vendor",
  "private": true,
  "version": "0.0.0",
  "dependencies": {
    "imapflow": "^1.0.191",
    "mailparser": "^3.7.0",
    "nodemailer": "^6.9.16"
  }
}
```

目录占位：`mkdir -p plugins/email/tools plugins/email/service/lib plugins/email/panel plugins/email/skills/email-ops plugins/email/agents`，每个空目录放 `.gitkeep`。根 `.gitignore` 追加（若未覆盖）：`plugins/*/vendor/node_modules/`。

- [ ] **Step 4: vendor 安装**

Run: `cd plugins/email/vendor && npm install --no-audit --no-fund && node -e "require('./node_modules/imapflow');require('./node_modules/nodemailer');require('./node_modules/mailparser');console.log('vendor ok')"`
Expected: 输出 `vendor ok`

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run tests/email/manifest.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add plugins/email tests/email .gitignore
git commit -m "feat(email): 插件骨架——manifest + vendor 依赖（imapflow/nodemailer/mailparser）"
```

### Task 5: 账号存储 lib/accounts.js

**Files:**
- Create: `plugins/email/service/lib/accounts.js`
- Test: `tests/email/service-accounts.test.ts`

**Interfaces:**
- Consumes: DI 注入 `secrets`（`{get,set,delete}`，形状同 `ctx.secrets`）、`dataDir`
- Produces: `createAccountStore({ dataDir, secrets })` → `{ list, add, update, remove, get, setPassword, getPassword, markHealth }`；`PRESETS`；`presetFor(email)`；记录形 `{ id, email, displayName, username, imap:{host,port,tlsMode}, smtp:{host,port,tlsMode}, createdAt, health:{state:'unknown'|'ok'|'error', message?} }`

- [ ] **Step 1: 写失败测试**

```ts
// tests/email/service-accounts.test.ts
// 脱敏形状 / 明文拒绝 / 密码走 secrets / 损坏容错 / 健康态（Review Focus 1/2/5）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAccountStore, PRESETS } from '../../plugins/email/service/lib/accounts';

function makeSecrets() {
  const m = new Map<string, string>();
  return {
    m,
    async get(k: string) { return m.get(k) ?? null; },
    async set(k: string, v: string) { m.set(k, v); },
    async delete(k: string) { m.delete(k); },
  };
}

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'email-acc-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('accounts store', () => {
  it('add→list：记录无任何密码字段（脱敏），凭据只进 secrets', async () => {
    const secrets = makeSecrets();
    const store = createAccountStore({ dataDir: dir, secrets });
    const rec = await store.add({
      email: 'me@qq.com', displayName: '我', username: 'me@qq.com', password: 'auth-code',
      imap: { host: 'imap.qq.com', port: 993, tlsMode: 'tls' },
      smtp: { host: 'smtp.qq.com', port: 465, tlsMode: 'tls' },
    });
    const listed = await store.list();
    expect(listed).toHaveLength(1);
    const s = JSON.stringify(listed[0]);
    expect(s).not.toContain('auth-code');
    expect(s).not.toContain('password');
    expect(secrets.m.get(`account:${rec.id}`)).toBe('auth-code');
  });

  it('明文/非法 tlsMode 拒绝（双守门第一道）', async () => {
    const store = createAccountStore({ dataDir: dir, secrets: makeSecrets() });
    await expect(store.add({
      email: 'a@b.c', username: 'a@b.c', password: 'x',
      imap: { host: 'h', port: 143, tlsMode: 'plain' as never },
      smtp: { host: 'h', port: 465, tlsMode: 'tls' },
    })).rejects.toThrow('tlsMode');
    await expect(store.add({
      email: 'a@b.c', username: 'a@b.c', password: 'x',
      imap: { host: 'h', port: 0, tlsMode: 'tls' },
      smtp: { host: 'h', port: 465, tlsMode: 'tls' },
    })).rejects.toThrow('端口');
  });

  it('update 不触碰密码；remove 连带清 secrets；email 唯一', async () => {
    const secrets = makeSecrets();
    const store = createAccountStore({ dataDir: dir, secrets });
    const a = await store.add({ email: 'a@b.c', username: 'a@b.c', password: 'p1',
      imap: PRESETS.qq.imap, smtp: PRESETS.qq.smtp });
    await store.update(a.id, { displayName: '改名' });
    expect(secrets.m.get(`account:${a.id}`)).toBe('p1');
    await expect(store.add({ email: 'a@b.c', username: 'a@b.c', password: 'p2',
      imap: PRESETS.qq.imap, smtp: PRESETS.qq.smtp })).rejects.toThrow('已存在');
    await store.remove(a.id);
    expect(secrets.m.has(`account:${a.id}`)).toBe(false);
    expect(await store.list()).toEqual([]);
  });

  it('accounts.json 损坏 → 空表重建不抛', async () => {
    fs.writeFileSync(path.join(dir, 'accounts.json'), '{broken', 'utf-8');
    const store = createAccountStore({ dataDir: dir, secrets: makeSecrets() });
    expect(await store.list()).toEqual([]);
  });

  it('markHealth 落账号健康态', async () => {
    const store = createAccountStore({ dataDir: dir, secrets: makeSecrets() });
    const a = await store.add({ email: 'a@b.c', username: 'a@b.c', password: 'p',
      imap: PRESETS.qq.imap, smtp: PRESETS.qq.smtp });
    await store.markHealth(a.id, 'error', '认证失败：授权码可能过期');
    expect((await store.get(a.id))!.health).toEqual({ state: 'error', message: '认证失败：授权码可能过期' });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/email/service-accounts.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现** `plugins/email/service/lib/accounts.js`

```js
// 账号存储：accounts.json 元数据（无密码）+ ctx.secrets 凭据（keytar）。
// 纪律：密码永不入 JSON/日志/返回值；tmp+rename 原子写；读侧损坏丢弃重建。
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const TLS_MODES = ['tls', 'starttls'];
const PORT_MIN = 1;
const PORT_MAX = 65535;

/** 常见邮箱预设（表单一键填充；仍可全自定义） */
const PRESETS = {
  qq: { imap: { host: 'imap.qq.com', port: 993, tlsMode: 'tls' }, smtp: { host: 'smtp.qq.com', port: 465, tlsMode: 'tls' } },
  '163': { imap: { host: 'imap.163.com', port: 993, tlsMode: 'tls' }, smtp: { host: 'smtp.163.com', port: 465, tlsMode: 'tls' } },
  gmail: { imap: { host: 'imap.gmail.com', port: 993, tlsMode: 'tls' }, smtp: { host: 'smtp.gmail.com', port: 465, tlsMode: 'tls' } },
  outlook: { imap: { host: 'outlook.office365.com', port: 993, tlsMode: 'tls' }, smtp: { host: 'smtp.office365.com', port: 587, tlsMode: 'starttls' } },
};

function presetFor(email) {
  const domain = String(email || '').split('@')[1] || '';
  if (domain === 'qq.com' || domain === 'foxmail.com') return PRESETS.qq;
  if (domain.endsWith('163.com')) return PRESETS['163'];
  if (domain === 'gmail.com') return PRESETS.gmail;
  if (domain.endsWith('outlook.com') || domain.endsWith('hotmail.com')) return PRESETS.outlook;
  return null;
}

function createAccountStore({ dataDir, secrets }) {
  const file = path.join(dataDir, 'accounts.json');
  const readAll = () => {
    try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { return []; }
  };
  const writeAll = (rows) => {
    fs.mkdirSync(dataDir, { recursive: true });
    const tmp = file + '.tmp-' + process.pid + '-' + Date.now();
    fs.writeFileSync(tmp, JSON.stringify(rows, null, 2), 'utf-8');
    fs.renameSync(tmp, file);
  };
  const checkEndpoint = (label, ep) => {
    if (!ep || typeof ep.host !== 'string' || ep.host.trim() === '') throw new Error(`${label}.host 不能为空`);
    if (!Number.isInteger(ep.port) || ep.port < PORT_MIN || ep.port > PORT_MAX) {
      throw new Error(`${label} 端口非法（${ep && ep.port}）`);
    }
    if (!TLS_MODES.includes(ep.tlsMode)) {
      throw new Error(`${label}.tlsMode 必须是 tls/starttls（明文连接拒绝）`);
    }
  };
  return {
    PRESETS, presetFor,
    async list() {
      return readAll().map(({ id, email, displayName, username, imap, smtp, createdAt, health }) =>
        ({ id, email, displayName, username, imap, smtp, createdAt, health }));
    },
    async get(id) { return readAll().find((r) => r.id === id) || null; },
    async add(input) {
      const rows = readAll();
      if (rows.some((r) => r.email === input.email)) throw new Error(`邮箱已存在: ${input.email}`);
      checkEndpoint('imap', input.imap);
      checkEndpoint('smtp', input.smtp);
      const { password, ...meta } = input;
      const rec = {
        id: 'acc_' + crypto.randomUUID(),
        createdAt: new Date().toISOString(),
        health: { state: 'unknown' },
        ...meta,
        imap: { ...input.imap },
        smtp: { ...input.smtp },
      };
      rows.push(rec);
      writeAll(rows);
      await secrets.set('account:' + rec.id, String(password || ''));
      return rec;
    },
    async update(id, patch) {
      const rows = readAll();
      const i = rows.findIndex((r) => r.id === id);
      if (i < 0) throw new Error(`账号不存在: ${id}`);
      if (patch.imap) checkEndpoint('imap', { ...rows[i].imap, ...patch.imap });
      if (patch.smtp) checkEndpoint('smtp', { ...rows[i].smtp, ...patch.smtp });
      const next = { ...rows[i], ...patch, id: rows[i].id, createdAt: rows[i].createdAt };
      delete next.password; // 永不经 update 落密码
      rows[i] = next;
      writeAll(rows);
      return next;
    },
    async remove(id) {
      const rows = readAll();
      const next = rows.filter((r) => r.id !== id);
      if (next.length === rows.length) return;
      writeAll(next);
      await secrets.delete('account:' + id).catch(() => undefined);
    },
    async setPassword(id, pw) { await secrets.set('account:' + id, pw); },
    async getPassword(id) { return secrets.get('account:' + id); },
    async markHealth(id, state, message) {
      const rows = readAll();
      const i = rows.findIndex((r) => r.id === id);
      if (i < 0) return;
      rows[i].health = { state, ...(message ? { message } : {}) };
      writeAll(rows);
    },
  };
}

module.exports = { createAccountStore, PRESETS, presetFor };
```

- [ ] **Step 4: 跑测试确认通过**

Run: 同 Step 2。Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add plugins/email/service/lib/accounts.js tests/email/service-accounts.test.ts
git commit -m "feat(email): 账号存储——元数据 JSON + secrets 凭据 + 明文拒绝"
```

### Task 6: 信封缓存 lib/envelope-cache.js

**Files:**
- Create: `plugins/email/service/lib/envelope-cache.js`
- Test: `tests/email/service-envelope-cache.test.ts`

**Interfaces:**
- Produces: `createEnvelopeCache({ dataDir })` → `{ read(accountId, folder), write(accountId, folder, envelopes) }`；信封条目 `{ uid, subject, from, to, date, seen, hasAttachments, size }`；缓存形 `{ items, savedAt }`

- [ ] **Step 1: 写失败测试**

```ts
// tests/email/service-envelope-cache.test.ts
// 有界淘汰 / 损坏重建 / 路径消毒（Review Focus 5）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { createEnvelopeCache } from '../../plugins/email/service/lib/envelope-cache';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'email-cache-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const mk = (uid: number, date = '2026-11-01T00:00:00Z') => ({
  uid, subject: `s${uid}`, from: 'a@b.c', to: 'd@e.f', date, seen: false, hasAttachments: false, size: 100,
});

describe('envelope cache', () => {
  it('write→read 回读并携带 savedAt 元数据', () => {
    const c = createEnvelopeCache({ dataDir: dir });
    c.write('acc1', 'INBOX', [mk(1), mk(2)]);
    const hit = c.read('acc1', 'INBOX')!;
    expect(hit.items.map((e: { uid: number }) => e.uid)).toEqual([1, 2]);
    expect(typeof hit.savedAt).toBe('number');
  });

  it('有界 500 条：写 501 只留最新 500（uid 最大在前）', () => {
    const c = createEnvelopeCache({ dataDir: dir });
    const batch = Array.from({ length: 501 }, (_, i) => mk(i + 1));
    c.write('acc1', 'INBOX', batch);
    const hit = c.read('acc1', 'INBOX')!;
    expect(hit.items.length).toBe(500);
    expect(hit.items[0]!.uid).toBe(501);
  });

  it('损坏 JSON → read 返回 null（丢弃重建）', () => {
    const c = createEnvelopeCache({ dataDir: dir });
    c.write('acc1', 'INBOX', [mk(1)]);
    fs.writeFileSync(path.join(dir, 'cache', 'acc1', 'INBOX.json'), '{broken', 'utf-8');
    expect(c.read('acc1', 'INBOX')).toBeNull();
  });

  it('folder 名含路径段/穿越拒绝；层级分隔合法可写', () => {
    const c = createEnvelopeCache({ dataDir: dir });
    expect(() => c.write('acc1', '../evil', [mk(1)])).toThrow('folder');
    expect(() => c.write('acc1', 'a/../b', [mk(1)])).toThrow('folder');
    c.write('acc1', 'INBOX/Sub', [mk(1)]);
    expect(c.read('acc1', 'INBOX/Sub')!.items).toHaveLength(1);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/email/service-envelope-cache.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

```js
// 信封缓存：cache/<accountId>/<encodedFolder>.json，有界 500 条（最新 uid 在前）。
// 非真相源——读侧任何损坏返回 null 交上层重拉 IMAP。
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const MAX_ITEMS = 500;

function safeName(folder) {
  const segs = String(folder || '').split('/');
  if (String(folder).includes('\\') || segs.some((s) => s === '' || s === '.' || s === '..')) {
    throw new Error(`folder 名非法（拒绝路径段）: ${folder}`);
  }
  return segs.map(encodeURIComponent).join('/');
}

function normalizeEnvelopes(list) {
  return (Array.isArray(list) ? list : []).filter((e) => e && Number.isInteger(e.uid));
}

function createEnvelopeCache({ dataDir }) {
  const fileOf = (accountId, folder) => path.join(dataDir, 'cache', accountId, safeName(folder) + '.json');
  return {
    read(accountId, folder) {
      try {
        const parsed = JSON.parse(fs.readFileSync(fileOf(accountId, folder), 'utf-8'));
        if (!parsed || !Array.isArray(parsed.items)) return null;
        return parsed;
      } catch {
        return null;
      }
    },
    write(accountId, folder, envelopes) {
      const items = normalizeEnvelopes(envelopes)
        .sort((a, b) => b.uid - a.uid)
        .slice(0, MAX_ITEMS);
      const target = fileOf(accountId, folder);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const tmp = target + '.tmp-' + process.pid + '-' + Date.now();
      fs.writeFileSync(tmp, JSON.stringify({ items, savedAt: Date.now() }, null, 2), 'utf-8');
      fs.renameSync(tmp, target);
    },
  };
}

module.exports = { createEnvelopeCache, MAX_ITEMS };
```

- [ ] **Step 4: 跑测试确认通过**

Run: 同 Step 2。Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add plugins/email/service/lib/envelope-cache.js tests/email/service-envelope-cache.test.ts
git commit -m "feat(email): 信封缓存——有界 500 + 损坏重建 + 路径消毒"
```

### Task 7: RFC822 生成 + 草稿状态机

**Files:**
- Create: `plugins/email/service/lib/rfc822.js`、`plugins/email/service/lib/drafts.js`
- Test: `tests/email/service-drafts.test.ts`

**Interfaces:**
- Produces: `renderRawMail({ nodemailerLib, from, to, cc, subject, text, attachments })` → `Promise<Buffer>`（attachments 元素 `{filename, contentType, data: Buffer}`）；`createDrafts({ dataDir, now, renderMail, smtpSend, mailbox })` → `{ save, list, get, send, discard, sweep }`
- save 入参：`{ accountId, account, to: string[], cc: string[], subject, text, attachments: [{filename, contentType, data: Buffer}] }`
- `smtpSend(accountId, raw, envelope)`——envelope 收件人**只来自草稿登记条目**（门禁纵深）
- mailbox 依赖面：`draftsFolder(accountId)`、`sentFolder(accountId)`、`append(accountId, folder, raw)`、`deleteMessage(accountId, folder, uid)`

- [ ] **Step 1: 写失败测试**

```ts
// tests/email/service-drafts.test.ts
// 状态机：save→pending、send 仅 pending、重放/不存在拒绝、24h 过期、SMTP 失败保 pending、25MB 守门（Review Focus 3/4）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { createDrafts } from '../../plugins/email/service/lib/drafts';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'email-drafts-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

function makeHarness(over: { smtpSend?: () => Promise<void> } = {}) {
  const appended: Array<{ folder: string; raw: Buffer }> = [];
  const deleted: Array<{ folder: string; uid: number }> = [];
  let sentEnv: unknown = null;
  let sentRaw: Buffer | null = null;
  const mailbox = {
    draftsFolder: async () => 'Drafts',
    sentFolder: async () => 'Sent',
    append: async (_acc: string, folder: string, raw: Buffer) => { appended.push({ folder, raw }); return 100 + appended.length; },
    deleteMessage: async (_acc: string, folder: string, uid: number) => { deleted.push({ folder, uid }); },
  };
  let nowMs = Date.parse('2026-11-05T10:00:00Z');
  const drafts = createDrafts({
    dataDir: dir,
    now: () => new Date(nowMs),
    renderMail: async (i: { subject: string }) => Buffer.from(`RAW:${i.subject}`),
    smtpSend: over.smtpSend ?? (async (_accId: string, raw: Buffer, envelope: unknown) => { sentRaw = raw; sentEnv = envelope; }),
    mailbox,
  });
  return { drafts, appended, deleted, sentEnv: () => sentEnv, sentRaw: () => sentRaw, setNow: (ms: number) => { nowMs = ms; } };
}

const ACCOUNT = { id: 'acc1', email: 'me@qq.com' };
const INPUT = {
  accountId: 'acc1', account: ACCOUNT,
  to: ['x@y.z'], cc: [], subject: '报价', text: '正文内容', attachments: [],
};

describe('drafts state machine', () => {
  it('save → APPEND Drafts + pending；send → SMTP(envelope 收件人=草稿登记) + APPEND Sent + 删草稿 + sent', async () => {
    const h = makeHarness();
    const d = await h.drafts.save(INPUT);
    expect(d.status).toBe('pending');
    expect(h.appended[0]!.folder).toBe('Drafts');
    await h.drafts.send(d.id);
    expect((await h.drafts.get(d.id))!.status).toBe('sent');
    expect(h.appended[1]!.folder).toBe('Sent');
    expect(h.deleted[0]!.folder).toBe('Drafts');
    expect(h.sentRaw()!.toString()).toBe('RAW:报价');
    expect(h.sentEnv()).toMatchObject({ from: 'me@qq.com', to: ['x@y.z'] });
  });

  it('send 拒绝：不存在 / 已 sent（重放拒绝）', async () => {
    const h = makeHarness();
    await expect(h.drafts.send('nope')).rejects.toThrow('不存在');
    const d = await h.drafts.save(INPUT);
    await h.drafts.send(d.id);
    await expect(h.drafts.send(d.id)).rejects.toThrow('不可发送');
  });

  it('SMTP 失败 → 状态保持 pending + lastError（可重试）', async () => {
    const h = makeHarness({ smtpSend: async () => { throw new Error('554 rejected'); } });
    const d = await h.drafts.save(INPUT);
    await expect(h.drafts.send(d.id)).rejects.toThrow('554');
    const rec = await h.drafts.get(d.id);
    expect(rec!.status).toBe('pending');
    expect(rec!.lastError).toContain('554');
  });

  it('24h 过期 sweep → discarded', async () => {
    const h = makeHarness();
    const d = await h.drafts.save(INPUT);
    h.setNow(Date.parse('2026-11-05T10:00:00Z') + 25 * 3600 * 1000);
    await h.drafts.sweep();
    expect((await h.drafts.get(d.id))!.status).toBe('discarded');
  });

  it('附件总量 >25MB 拒绝', async () => {
    const h = makeHarness();
    const big = Buffer.alloc(26 * 1024 * 1024);
    await expect(h.drafts.save({ ...INPUT, attachments: [{ filename: 'big.bin', contentType: 'application/octet-stream', data: big }] }))
      .rejects.toThrow('25MB');
  });

  it('drafts.json 损坏 → list 空表不抛', async () => {
    fs.writeFileSync(path.join(dir, 'drafts.json'), '{broken', 'utf-8');
    const h = makeHarness();
    expect(await h.drafts.list()).toEqual([]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/email/service-drafts.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

`plugins/email/service/lib/rfc822.js`：

```js
// RFC822 原始报文生成：streamTransport 渲染一次拿 Buffer（APPEND Drafts/Sent 用）。
'use strict';

/** attachments: [{ filename, contentType, data: Buffer }] */
async function renderRawMail({ nodemailerLib, from, to, cc, subject, text, attachments }) {
  const transport = nodemailerLib.createTransport({ streamTransport: true, buffer: true });
  const msg = await transport.sendMail({
    from, to, cc, subject, text,
    attachments: (attachments || []).map((a) => ({
      filename: a.filename, contentType: a.contentType, content: a.data,
    })),
  });
  return msg.message; // Buffer（完整 RFC822）
}

module.exports = { renderRawMail };
```

`plugins/email/service/lib/drafts.js`：

```js
// 草稿状态机：pending → sent | discarded（24h 过期）。真相链 = IMAP 目录 + drafts.json 登记。
// send 仅接受已存在草稿 id；收件人在起草时定型，envelope 透传自登记条目（门禁纵深 1）。
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const EXPIRE_MS = 24 * 3600 * 1000;
const ATTACH_TOTAL_MAX = 25 * 1024 * 1024;

function createDrafts({ dataDir, now = () => new Date(), renderMail, smtpSend, mailbox }) {
  const file = path.join(dataDir, 'drafts.json');
  const readAll = () => {
    try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { return []; }
  };
  const writeAll = (rows) => {
    fs.mkdirSync(dataDir, { recursive: true });
    const tmp = file + '.tmp-' + process.pid + '-' + Date.now();
    fs.writeFileSync(tmp, JSON.stringify(rows, null, 2), 'utf-8');
    fs.renameSync(tmp, file);
  };
  const patch = (id, fn) => {
    const rows = readAll();
    const i = rows.findIndex((r) => r.id === id);
    if (i < 0) throw new Error(`草稿不存在: ${id}`);
    rows[i] = fn(rows[i]);
    writeAll(rows);
    return rows[i];
  };

  return {
    async save(input) {
      // input: { accountId, account, to: string[], cc: string[], subject, text, attachments: [{filename, contentType, data: Buffer}] }
      const total = (input.attachments || []).reduce((n, a) => n + (a.data ? a.data.length : 0), 0);
      if (total > ATTACH_TOTAL_MAX) throw new Error(`附件总量超过 25MB 上限（${total} 字节）`);
      const mailInput = {
        from: input.account.email, to: input.to, cc: input.cc || [],
        subject: input.subject, text: input.text, attachments: input.attachments || [],
      };
      const raw = await renderMail(mailInput);
      const folder = await mailbox.draftsFolder(input.accountId);
      const uid = await mailbox.append(input.accountId, folder, raw);
      const rec = {
        id: 'draft_' + crypto.randomUUID(), accountId: input.accountId, uid, status: 'pending',
        to: input.to, cc: input.cc || [], subject: input.subject, fromAddr: input.account.email,
        summary: String(input.text || '').slice(0, 120),
        attachmentNames: (input.attachments || []).map((a) => a.filename),
        inputPayload: {
          ...mailInput,
          attachments: (input.attachments || []).map((a) => ({
            filename: a.filename, contentType: a.contentType, dataBase64: a.data.toString('base64'),
          })),
        },
        createdAt: now().toISOString(), sentAt: null, lastError: null,
      };
      writeAll([...readAll(), rec]);
      return rec;
    },
    async list() { await this.sweep(); return readAll(); },
    async get(id) { return readAll().find((r) => r.id === id) || null; },
    async send(id) {
      const rec = readAll().find((r) => r.id === id);
      if (!rec) throw new Error(`草稿不存在: ${id}`);
      if (rec.status !== 'pending') throw new Error(`草稿状态为 ${rec.status}，不可发送`);
      try {
        const p = rec.inputPayload;
        const raw = await renderMail({
          ...p,
          attachments: (p.attachments || []).map((a) => ({
            filename: a.filename, contentType: a.contentType, data: Buffer.from(a.dataBase64, 'base64'),
          })),
        });
        await smtpSend(rec.accountId, raw, { from: rec.fromAddr, to: rec.to, cc: rec.cc });
        const sent = await mailbox.sentFolder(rec.accountId);
        await mailbox.append(rec.accountId, sent, raw).catch(() => undefined); // Sent 归档失败不阻断
        const draftsFolder = await mailbox.draftsFolder(rec.accountId);
        await mailbox.deleteMessage(rec.accountId, draftsFolder, rec.uid).catch(() => undefined);
        return patch(id, (r) => ({ ...r, status: 'sent', sentAt: now().toISOString(), lastError: null }));
      } catch (err) {
        const msg = String((err && err.message) || err);
        patch(id, (r) => ({ ...r, lastError: msg }));
        throw new Error(`发送失败（草稿已保留可重试）: ${msg}`);
      }
    },
    async discard(id) {
      const rec = readAll().find((r) => r.id === id);
      if (!rec) return;
      if (rec.status === 'pending') {
        const folder = await mailbox.draftsFolder(rec.accountId);
        await mailbox.deleteMessage(rec.accountId, folder, rec.uid).catch(() => undefined);
      }
      patch(id, (r) => ({ ...r, status: 'discarded' }));
    },
    async sweep() {
      const cutoff = now().getTime() - EXPIRE_MS;
      const rows = readAll();
      let dirty = false;
      for (const r of rows) {
        if (r.status === 'pending' && Date.parse(r.createdAt) < cutoff) {
          r.status = 'discarded';
          r.expireReason = '24h 未确认自动作废';
          dirty = true;
        }
      }
      if (dirty) writeAll(rows);
    },
  };
}

module.exports = { createDrafts, EXPIRE_MS };
```

- [ ] **Step 4: 跑测试确认通过**

Run: 同 Step 2。Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add plugins/email/service/lib/rfc822.js plugins/email/service/lib/drafts.js tests/email/service-drafts.test.ts
git commit -m "feat(email): RFC822 生成 + 草稿状态机（24h 过期/重放拒绝/失败保留）"
```

### Task 8: mailbox 域（IMAP 适配）

**Files:**
- Create: `plugins/email/service/lib/mailbox.js`
- Test: `tests/email/service-mailbox.test.ts`

**Interfaces:**
- Consumes: accountStore 视图（`get(id)` + `getPassword(id)`）、envelope cache；注入 `imapConnect(account, password)` → adapter `{ list(), search(folder, criteria), fetchEnvelopes(folder, uids), fetchSource(uid), status(folder), append(folder, raw), deleteMessage(folder, uid), close() }`；注入 `parseMail(source)`；注入 `opTimeoutMs`（缺省 30000）
- Produces: `createMailbox({ accountStore, cache, imapConnect, parseMail, opTimeoutMs })` → `{ folders, envelopes, read, attachment, draftsFolder, sentFolder, append, deleteMessage, closeAll }`；`CACHE_TTL_MS = 300000`

- [ ] **Step 1: 写失败测试**

```ts
// tests/email/service-mailbox.test.ts
// folders 探测 / 缓存优先与强制刷新 / 过滤参数 / 正文守门 / 附件上限 / 超时（Review Focus 2/3/5）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { createMailbox, CACHE_TTL_MS } from '../../plugins/email/service/lib/mailbox';
import { createEnvelopeCache } from '../../plugins/email/service/lib/envelope-cache';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'email-mbox-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const ACC = { id: 'acc1', email: 'me@qq.com', imap: { host: 'imap.qq.com', port: 993, tlsMode: 'tls' } };

function makeImap(script: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const conn = {
    calls,
    lastCrit: null as unknown,
    async list() { calls.push('list'); return script.list ?? [
      { path: 'INBOX', specialUse: '\\Inbox' },
      { path: '草稿箱', specialUse: '\\Drafts' },
      { path: '已发送', specialUse: '\\Sent' },
    ]; },
    async search(_f: string, crit: unknown) { calls.push('search'); conn.lastCrit = crit; return script.uids ?? [3, 2, 1]; },
    async fetchEnvelopes() { calls.push('fetch'); return script.envelopes ?? [
      { uid: 3, subject: 's3', from: 'a@b.c', to: 'me@qq.com', date: '2026-11-05T09:00:00Z', seen: false, hasAttachments: false, size: 1200 },
      { uid: 2, subject: 's2', from: 'd@e.f', to: 'me@qq.com', date: '2026-11-05T08:00:00Z', seen: true, hasAttachments: true, size: 900 },
      { uid: 1, subject: 's1', from: 'g@h.i', to: 'me@qq.com', date: '2026-11-04T08:00:00Z', seen: false, hasAttachments: false, size: 800 },
    ]; },
    async fetchSource(uid: number) { calls.push('source'); return Buffer.from(`SRC:${uid}`); },
    async status() { calls.push('status'); return { unseen: 2 }; },
    async append() { calls.push('append'); return 42; },
    async deleteMessage() { calls.push('delete'); },
    async close() { calls.push('close'); },
  };
  return conn;
}

function makeMailbox(conn: ReturnType<typeof makeImap>, over: Record<string, unknown> = {}) {
  const cache = createEnvelopeCache({ dataDir: dir });
  const accountStore = {
    async get(id: string) { return id === 'acc1' ? ACC : null; },
    async getPassword() { return 'pw'; },
  };
  return createMailbox({
    accountStore, cache, imapConnect: async () => conn,
    parseMail: async () => ({ text: '正文', html: null, attachments: [{ partId: '1.1', filename: 'a.pdf', contentType: 'application/pdf', content: Buffer.from('pdf') }] }),
    opTimeoutMs: 60,
    ...over,
  } as never);
}

describe('mailbox', () => {
  it('folders：specialUse 探测 + 中文/常用名 fallback', async () => {
    const mb = makeMailbox(makeImap());
    const f = await mb.folders('acc1');
    expect(f.drafts).toBe('草稿箱');
    expect(f.sent).toBe('已发送');
    const conn2 = makeImap({ list: [{ path: 'INBOX' }, { path: 'Drafts' }, { path: 'Sent Items' }] });
    const f2 = await makeMailbox(conn2).folders('acc1');
    expect(f2.drafts).toBe('Drafts');
    expect(f2.sent).toBe('Sent Items');
  });

  it('envelopes：首次拉 IMAP 落缓存；TTL 内二次不触网；force 强制刷新', async () => {
    const conn = makeImap();
    const mb = makeMailbox(conn);
    await mb.envelopes('acc1', 'INBOX', {});
    await mb.envelopes('acc1', 'INBOX', {});
    expect(conn.calls.filter((c) => c === 'search')).toHaveLength(1);
    await mb.envelopes('acc1', 'INBOX', { force: true });
    expect(conn.calls.filter((c) => c === 'search')).toHaveLength(2);
  });

  it('filter 透传 search 条件；pageSize 钳制 ≤50', async () => {
    const conn = makeImap();
    const mb = makeMailbox(conn);
    const page = await mb.envelopes('acc1', 'INBOX', {
      filter: { since: '2026-11-05', unreadOnly: true, from: 'a@b.c', subject: '报价' }, pageSize: 999,
    });
    expect(page.items.length).toBeLessThanOrEqual(50);
    expect(conn.lastCrit).toMatchObject({ since: '2026-11-05', unseen: true, from: 'a@b.c', subject: '报价' });
  });

  it('read：>2MB 拒收；text >200KB 截断标注', async () => {
    const conn = makeImap({ envelopes: [{ uid: 1, subject: 's', from: 'a@b.c', to: 'm', date: '2026-11-05T00:00:00Z', seen: false, hasAttachments: true, size: 3 * 1024 * 1024 }] });
    await expect(makeMailbox(conn).read('acc1', 'INBOX', 1)).rejects.toThrow('2MB');
    const mb2 = makeMailbox(makeImap(), { parseMail: async () => ({ text: 'x'.repeat(250 * 1024), html: null, attachments: [] }) });
    const r = await mb2.read('acc1', 'INBOX', 3);
    expect(r.text.length).toBeLessThanOrEqual(200 * 1024 + 40);
    expect(r.truncated).toBe(true);
  });

  it('attachment：≤10MB 守门 + partId 命中返回 base64', async () => {
    const conn = makeImap({ envelopes: [{ uid: 2, subject: 's', from: 'a@b.c', to: 'm', date: '2026-11-05T00:00:00Z', seen: true, hasAttachments: true, size: 11 * 1024 * 1024 }] });
    await expect(makeMailbox(conn).attachment('acc1', 'INBOX', 2, '1.1')).rejects.toThrow('10MB');
    const a = await makeMailbox(makeImap()).attachment('acc1', 'INBOX', 2, '1.1');
    expect(a.filename).toBe('a.pdf');
    expect(a.base64).toBe(Buffer.from('pdf').toString('base64'));
  });

  it('单操作超时 → 中文错误', async () => {
    const hang = makeImap();
    (hang as unknown as { search: unknown }).search = () => new Promise(() => undefined);
    await expect(makeMailbox(hang).envelopes('acc1', 'INBOX', {})).rejects.toThrow('超时');
  });

  it('TTL 常量 5min', () => { expect(CACHE_TTL_MS).toBe(300000); });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/email/service-mailbox.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现** `plugins/email/service/lib/mailbox.js`

```js
// mailbox：IMAP 域适配层。缓存优先（信封 TTL 5min）；正文/附件按需；全部操作 30s 超时。
// 连接复用：每账号一条，10min 空闲回收。
'use strict';

const CACHE_TTL_MS = 5 * 60 * 1000;
const READ_SOURCE_MAX = 2 * 1024 * 1024;   // read_mail 全源上限
const TEXT_TRUNCATE = 200 * 1024;           // 正文截断
const ATTACH_MAX = 10 * 1024 * 1024;        // 附件 RPC 上限
const IDLE_MS = 10 * 60 * 1000;             // 连接空闲回收

const DRAFT_NAMES = ['drafts', '草稿箱', '草稿', 'draft'];
const SENT_NAMES = ['sent', '已发送', '已发送邮件', 'sent messages', 'sent items'];

function createMailbox({ accountStore, cache, imapConnect, parseMail, opTimeoutMs = 30000 }) {
  const conns = new Map(); // accountId → { conn, lastUsed }

  async function connOf(accountId) {
    const hit = conns.get(accountId);
    if (hit && Date.now() - hit.lastUsed < IDLE_MS) { hit.lastUsed = Date.now(); return hit.conn; }
    if (hit) { await hit.conn.close().catch(() => undefined); conns.delete(accountId); }
    const acc = await accountStore.get(accountId);
    if (!acc) throw new Error(`账号不存在: ${accountId}`);
    const pw = await accountStore.getPassword(accountId);
    const conn = await imapConnect(acc, pw);
    conns.set(accountId, { conn, lastUsed: Date.now() });
    return conn;
  }
  const withTimeout = (label, p) => Promise.race([
    p,
    new Promise((_r, rej) => setTimeout(() => rej(new Error(`IMAP ${label} 超时（${opTimeoutMs}ms）`)), opTimeoutMs)),
  ]);

  return {
    CACHE_TTL_MS,
    async folders(accountId) {
      const conn = await connOf(accountId);
      const raw = await withTimeout('list', conn.list());
      const norm = (s) => String(s || '').toLowerCase().replace(/\s/g, '');
      const drafts = raw.find((f) => f.specialUse === '\\Drafts')?.path
        ?? raw.find((f) => DRAFT_NAMES.includes(norm(f.path)))?.path ?? null;
      const sent = raw.find((f) => f.specialUse === '\\Sent')?.path
        ?? raw.find((f) => SENT_NAMES.includes(norm(f.path)))?.path ?? null;
      return { all: raw, drafts, sent };
    },
    async draftsFolder(accountId) { return (await this.folders(accountId)).drafts ?? 'INBOX'; },
    async sentFolder(accountId) { return (await this.folders(accountId)).sent ?? 'INBOX'; },
    async envelopes(accountId, folder, { page = 1, pageSize = 20, filter, force = false } = {}) {
      const size = Math.min(Math.max(Math.trunc(pageSize) || 20, 1), 50);
      let list;
      if (force) {
        const conn = await connOf(accountId);
        const crit = {};
        if (filter) {
          if (filter.since) crit.since = filter.since;
          if (filter.unreadOnly) crit.unseen = true;
          if (filter.from) crit.from = filter.from;
          if (filter.subject) crit.subject = filter.subject;
        }
        const uids = await withTimeout('search', conn.search(folder, crit));
        list = await withTimeout('fetch', conn.fetchEnvelopes(folder, uids));
        cache.write(accountId, folder, list);
      } else {
        const cached = cache.read(accountId, folder);
        if (cached && Date.now() - cached.savedAt < CACHE_TTL_MS) {
          list = cached.items;
        } else {
          const conn = await connOf(accountId);
          const uids = await withTimeout('search', conn.search(folder, {}));
          list = await withTimeout('fetch', conn.fetchEnvelopes(folder, uids));
          cache.write(accountId, folder, list);
        }
      }
      const start = (Math.max(Math.trunc(page) || 1, 1) - 1) * size;
      return { items: list.slice(start, start + size), total: list.length, page: Math.max(Math.trunc(page) || 1, 1), pageSize: size };
    },
    async read(accountId, folder, uid) {
      const conn = await connOf(accountId);
      const uids = await withTimeout('search', conn.search(folder, {}));
      const envs = await withTimeout('fetch', conn.fetchEnvelopes(folder, uids));
      const env = envs.find((e) => e.uid === uid);
      if (!env) throw new Error(`邮件不存在（folder=${folder} uid=${uid}）`);
      if ((env.size || 0) > READ_SOURCE_MAX) {
        throw new Error(`邮件体积 ${(env.size / 1048576).toFixed(1)}MB 超过 2MB 读取上限——附件请用 save_attachment`);
      }
      const source = await withTimeout('source', conn.fetchSource(uid));
      const parsed = await parseMail(source);
      const text = String(parsed.text || '');
      const truncated = text.length > TEXT_TRUNCATE;
      return {
        uid, subject: env.subject, from: env.from, to: env.to, date: env.date, seen: env.seen,
        text: truncated ? text.slice(0, TEXT_TRUNCATE) + '\n…（已截断，全文 200KB 上限）' : text,
        html: parsed.html || null, truncated,
        attachments: (parsed.attachments || []).map((a) => ({
          partId: a.partId, filename: a.filename, contentType: a.contentType, size: a.content ? a.content.length : 0,
        })),
      };
    },
    async attachment(accountId, folder, uid, partId) {
      const conn = await connOf(accountId);
      const uids = await withTimeout('search', conn.search(folder, {}));
      const envs = await withTimeout('fetch', conn.fetchEnvelopes(folder, uids));
      const env = envs.find((e) => e.uid === uid);
      if (env && (env.size || 0) > ATTACH_MAX) {
        throw new Error(`附件载体超过 10MB 上限（邮件 ${(env.size / 1048576).toFixed(1)}MB）`);
      }
      const source = await withTimeout('source', conn.fetchSource(uid));
      const parsed = await parseMail(source);
      const att = (parsed.attachments || []).find((a) => a.partId === partId);
      if (!att) throw new Error(`附件不存在: partId=${partId}`);
      if (att.content.length > ATTACH_MAX) throw new Error(`附件超过 10MB 上限（${att.filename}）`);
      return { filename: att.filename, contentType: att.contentType, base64: att.content.toString('base64') };
    },
    async append(accountId, folder, raw) {
      const conn = await connOf(accountId);
      return withTimeout('append', conn.append(folder, raw));
    },
    async deleteMessage(accountId, folder, uid) {
      const conn = await connOf(accountId);
      return withTimeout('delete', conn.deleteMessage(folder, uid));
    },
    async closeAll() {
      for (const { conn } of conns.values()) await conn.close().catch(() => undefined);
      conns.clear();
    },
  };
}

module.exports = { createMailbox, CACHE_TTL_MS };
```

- [ ] **Step 4: 跑测试确认通过**

Run: 同 Step 2。Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add plugins/email/service/lib/mailbox.js tests/email/service-mailbox.test.ts
git commit -m "feat(email): mailbox 域——缓存优先/正文守门/附件上限/超时守卫"
```

### Task 9: service 入口组装

**Files:**
- Create: `plugins/email/service/index.js`
- Test: `tests/email/service-index.test.ts`

**Interfaces:**
- Consumes: Task 5-8 全部 lib；`ctx.secrets` / `ctx.getDataDir()` / `ctx.logger`
- Produces: `createService(ctx)` → `{ start, stop, handle }`（宿主契约）；`buildService(deps)`（依赖注入内核，deps：`{ dataDir, secrets, logger, imapflow, nodemailerLib, mailparserLib }`）；方法目录 `accounts.list|add|update|delete|test`、`folders.list`、`mails.list|refresh|get`、`attachments.get`、`drafts.save|list|send|discard`

- [ ] **Step 1: 写失败测试**

```ts
// tests/email/service-index.test.ts
// handle 路由 / 未知方法 / accounts.test 双探测 / tlsMode 映射 / drafts.save→send 全链
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { buildService } from '../../plugins/email/service/index';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'email-svc-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

class FakeImapFlow {
  opts: unknown;
  constructor(opts: unknown) { this.opts = opts; }
  async connect() {}
  async logout() {}
  async list() { return [{ path: 'INBOX', specialUse: '\\Inbox' }, { path: 'Drafts', specialUse: '\\Drafts' }, { path: 'Sent', specialUse: '\\Sent' }]; }
  async search() { return [1]; }
  async *fetch() {
    yield { uid: 1, envelope: { subject: 's', from: [{ address: 'a@b.c' }], to: [{ address: 'm@n.o' }], date: new Date('2026-11-05T00:00:00Z') }, flags: new Set(), bodyStructure: {}, size: 100 };
  }
  async fetchOne() { return { source: Buffer.from('MIME') }; }
  async append() { return { uid: 7 }; }
  async messageDelete() {}
  async close() {}
}
function makeDeps(over: Record<string, unknown> = {}) {
  return {
    dataDir: dir,
    secrets: { get: async () => null, set: async () => {}, delete: async () => {} },
    logger: { info() {}, warn() {}, error() {} },
    imapflow: FakeImapFlow,
    nodemailerLib: { createTransport: () => ({ verify: async () => true, sendMail: async () => ({ ok: true }) }) },
    mailparserLib: { simpleParser: async () => ({ text: 't', html: null, attachments: [] }) },
    ...over,
  } as never;
}

const ACC_INPUT = {
  email: 'a@qq.com', username: 'a@qq.com', password: 'pw',
  imap: { host: 'imap.qq.com', port: 993, tlsMode: 'tls' },
  smtp: { host: 'smtp.qq.com', port: 465, tlsMode: 'tls' },
};

describe('service index', () => {
  it('accounts.add→list→folders.list→mails.list 全链（fake vendor）', async () => {
    const svc = buildService(makeDeps());
    await svc.start();
    await svc.handle('accounts.add', ACC_INPUT);
    const accounts = await svc.handle('accounts.list', {});
    expect(accounts).toHaveLength(1);
    const f = await svc.handle('folders.list', { accountId: accounts[0].id });
    expect(f.drafts).toBe('Drafts');
    const page = await svc.handle('mails.list', { accountId: accounts[0].id, folder: 'INBOX' });
    expect(page.items[0].subject).toBe('s');
    await svc.stop();
  });

  it('未知方法 → 中文错误（fail loud）', async () => {
    const svc = buildService(makeDeps());
    await expect(svc.handle('nope.nothing', {})).rejects.toThrow('未知方法');
  });

  it('accounts.test：IMAP login + SMTP verify 双探测通过', async () => {
    const svc = buildService(makeDeps());
    await svc.handle('accounts.add', ACC_INPUT);
    expect(await svc.handle('accounts.test', { email: 'a@qq.com' })).toEqual({ ok: true });
  });

  it('tlsMode=tls → ImapFlow secure:true（starttls → requireTLS，明文不可能构造）', async () => {
    let seen: unknown;
    class Spy extends FakeImapFlow { constructor(o: unknown) { super(o); seen = o; } }
    const svc = buildService(makeDeps({ imapflow: Spy }));
    await svc.handle('accounts.add', ACC_INPUT);
    await svc.handle('mails.list', { accountId: (await svc.handle('accounts.list', {}))[0].id, folder: 'INBOX' });
    expect(seen).toMatchObject({ secure: true });
  });

  it('drafts.save（base64 附件）→ drafts.send 状态机全链', async () => {
    const svc = buildService(makeDeps());
    await svc.handle('accounts.add', ACC_INPUT);
    const accId = (await svc.handle('accounts.list', {}))[0].id;
    const d = await svc.handle('drafts.save', {
      accountId: accId, to: 'x@y.z', subject: 'S', text: 'T',
      attachments: [{ filename: 'a.bin', contentType: 'application/octet-stream', base64: Buffer.from('bin').toString('base64') }],
    });
    expect(d.status).toBe('pending');
    const sent = await svc.handle('drafts.send', { draftId: d.id });
    expect(sent.status).toBe('sent');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/email/service-index.test.ts`
Expected: FAIL（index.js 不存在）

- [ ] **Step 3: 实现** `plugins/email/service/index.js`

```js
// email service：createService(ctx)（宿主契约）→ buildService 内核（依赖注入可测）。
// 不 require electron/宿主内部模块；vendor 相对路径引入。
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createAccountStore } = require('./lib/accounts');
const { createEnvelopeCache } = require('./lib/envelope-cache');
const { createMailbox } = require('./lib/mailbox');
const { createDrafts } = require('./lib/drafts');
const { renderRawMail } = require('./lib/rfc822');

function vendor(name) { return require(path.join(__dirname, '..', 'vendor', 'node_modules', name)); }

/** smtp transport 构造（tlsMode 映射强制加密——明文不可能构造） */
function smtpTransportOf(nodemailerLib, acc, pw) {
  return acc.smtp.tlsMode === 'tls'
    ? nodemailerLib.createTransport({ host: acc.smtp.host, port: acc.smtp.port, secure: true, auth: { user: acc.username, pass: pw } })
    : nodemailerLib.createTransport({ host: acc.smtp.host, port: acc.smtp.port, secure: false, requireTLS: true, auth: { user: acc.username, pass: pw } });
}

/** ImapFlow → mailbox adapter 契约 */
function imapAdapterFor(ImapFlow) {
  return async (account, password) => {
    const secure = account.imap.tlsMode === 'tls';
    const client = new ImapFlow({
      host: account.imap.host, port: account.imap.port, secure,
      requireTLS: !secure,
      auth: { user: account.username, pass: password },
      logger: false,
    });
    await client.connect();
    return {
      list: async () => (await client.list()).map((f) => ({ path: f.path, specialUse: f.specialUse || null })),
      search: async (folder, crit) => {
        const s = { ...crit };
        if (Object.keys(s).length === 0) s.all = true;
        return client.search({ folder, ...s }, { uid: true }) ?? [];
      },
      fetchEnvelopes: async (folder, uids) => {
        const out = [];
        for await (const msg of client.fetch(uids, { envelope: true, bodyStructure: true, size: true }, { folder, uid: true })) {
          out.push({
            uid: msg.uid,
            subject: msg.envelope?.subject ?? '',
            from: msg.envelope?.from?.[0]?.address ?? '',
            to: msg.envelope?.to?.[0]?.address ?? '',
            date: msg.envelope?.date?.toISOString?.() ?? null,
            seen: Boolean(msg.flags?.has?.('\\Seen')),
            hasAttachments: Boolean(msg.bodyStructure?.childNodes?.some?.((c) => c.disposition === 'attachment')),
            size: msg.size ?? 0,
          });
        }
        return out;
      },
      fetchSource: async (uid) => {
        const r = await client.fetchOne(String(uid), { source: true }, { uid: true });
        if (!r || !r.source) throw new Error('邮件源获取失败');
        return r.source;
      },
      status: async (folder) => client.status(folder, { unseen: true }),
      append: async (folder, raw) => (await client.append(folder, raw))?.uid ?? 0,
      deleteMessage: async (folder, uid) => { await client.messageDelete(String(uid), { folder, uid: true }); },
      close: async () => { await client.logout().catch(() => client.close?.()); },
    };
  };
}

function buildService(deps) {
  const { dataDir, secrets, logger } = deps;
  fs.mkdirSync(dataDir, { recursive: true });
  const accountStore = createAccountStore({ dataDir, secrets });
  const cache = createEnvelopeCache({ dataDir });
  const imapConnect = deps.imapConnect ?? imapAdapterFor(deps.imapflow);
  const parseMail = deps.parseMail ?? ((src) => deps.mailparserLib.simpleParser(src));
  const mailbox = createMailbox({ accountStore, cache, imapConnect, parseMail, opTimeoutMs: 30000 });
  const renderMail = async (input) => renderRawMail({ nodemailerLib: deps.nodemailerLib, ...input });
  const smtpSend = async (accountId, raw, envelope) => {
    const acc = await accountStore.get(accountId);
    const pw = await accountStore.getPassword(accountId);
    await smtpTransportOf(deps.nodemailerLib, acc, pw).sendMail({ raw, envelope });
  };
  const drafts = createDrafts({ dataDir, renderMail, smtpSend, mailbox });

  const ROUTES = {
    'accounts.list': () => accountStore.list(),
    'accounts.add': (p) => accountStore.add(p),
    'accounts.update': (p) => accountStore.update(p.id, p.patch ?? {}),
    'accounts.delete': (p) => accountStore.remove(p.id),
    'accounts.test': async (p) => {
      const acc = (await accountStore.list()).find((a) => a.email === p.email);
      if (!acc) throw new Error(`账号不存在: ${p.email}`);
      const pw = await accountStore.getPassword(acc.id);
      try {
        const conn = await imapConnect(acc, pw);
        await conn.close();
        await smtpTransportOf(deps.nodemailerLib, acc, pw).verify();
        await accountStore.markHealth(acc.id, 'ok');
        return { ok: true };
      } catch (err) {
        const msg = String((err && err.message) || err);
        await accountStore.markHealth(acc.id, 'error', msg);
        return { ok: false, error: msg };
      }
    },
    'folders.list': (p) => mailbox.folders(p.accountId),
    'mails.list': (p) => mailbox.envelopes(p.accountId, p.folder ?? 'INBOX',
      { page: p.page, pageSize: p.pageSize, filter: p.filter, force: false }),
    'mails.refresh': (p) => mailbox.envelopes(p.accountId, p.folder ?? 'INBOX',
      { force: true, filter: p.filter }),
    'mails.get': (p) => mailbox.read(p.accountId, p.folder, p.uid),
    'attachments.get': (p) => mailbox.attachment(p.accountId, p.folder, p.uid, p.partId),
    'drafts.save': async (p) => {
      const account = await accountStore.get(p.accountId);
      if (!account) throw new Error(`账号不存在: ${p.accountId}`);
      return drafts.save({
        accountId: p.accountId, account,
        to: Array.isArray(p.to) ? p.to : (typeof p.to === 'string' ? [p.to] : []),
        cc: Array.isArray(p.cc) ? p.cc : [],
        subject: String(p.subject || ''), text: String(p.text || ''),
        attachments: (p.attachments || []).map((a) => ({
          filename: a.filename, contentType: a.contentType, data: Buffer.from(a.base64, 'base64'),
        })),
      });
    },
    'drafts.list': () => drafts.list(),
    'drafts.send': (p) => drafts.send(p.draftId),
    'drafts.discard': (p) => drafts.discard(p.draftId),
  };

  return {
    async start() { await drafts.sweep(); logger.info?.('email service started'); },
    async stop() { await mailbox.closeAll(); },
    async handle(method, params) {
      const fn = ROUTES[method];
      if (!fn) throw new Error(`未知方法: ${method}`);
      return fn(params ?? {});
    },
  };
}

/** 宿主入口（service-manager createRequire 装载） */
module.exports.createService = function createService(ctx) {
  const svc = buildService({
    dataDir: ctx.getDataDir(),
    secrets: ctx.secrets,
    logger: ctx.logger,
    imapflow: vendor('imapflow').ImapFlow,
    nodemailerLib: vendor('nodemailer'),
    mailparserLib: vendor('mailparser'),
  });
  return {
    start: () => svc.start().catch((err) => { ctx.logger.error('email service start 失败: ' + err.message); }),
    stop: () => svc.stop(),
    handle: (method, params) => svc.handle(method, params),
  };
};
module.exports.buildService = buildService;
```

- [ ] **Step 4: 跑测试 + vendor 冒烟**

Run: `npx vitest run tests/email/service-index.test.ts && node -e "const s=require('./plugins/email/service/index.js'); console.log(typeof s.createService, typeof s.buildService)"`
Expected: PASS / 输出 `function function`

⚠️ callService 桥超时对齐：读 `electron/src/main/agent/plugin-hook-bridge.ts` 的 `requestPluginCallService` 超时值；若 < 30s，把 index.js 的 `opTimeoutMs: 30000` 调到桥超时 −2s 并在注释记录依据（IMAP 慢操作不能被桥先杀导致无中文错误）。

- [ ] **Step 5: Commit**

```bash
git add plugins/email/service/index.js tests/email/service-index.test.ts
git commit -m "feat(email): service 入口——方法路由/连接适配/宿主契约"
```

### Task 10: 只读工具 ×4

**Files:**
- Create: `plugins/email/tools/list_accounts.js`、`list_folders.js`、`list_mails.js`、`read_mail.js`
- Test: `tests/email/tools-readonly.test.ts`

**Interfaces:**
- Consumes: `createTools(pctx)`（PluginToolCtx：`pctx.callService(method, params)`）
- Produces: 四个 ToolModule（`getDefs/getCatalog/handles/execute`，短名=文件名；execute 返回 JSON 字符串）

- [ ] **Step 1: 写失败测试**

```ts
// tests/email/tools-readonly.test.ts
// 模块形状（文件名=短名）/ callService 转发 / pageSize 钳制 / 参数缺失中文错误
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const load = (f: string): { createTools(pctx: unknown): {
  getDefs(): Array<{ name: string; inputSchema: { type: string } }>;
  getCatalog(): Array<{ name: string }>;
  handles(n: string): boolean;
  execute(n: string, args: Record<string, unknown>, ctx?: unknown): Promise<string>;
} } => require(path.resolve(__dirname, '../../plugins/email/tools', f));

function fakeCtx() {
  const calls: Array<{ method: string; params: unknown }> = [];
  return {
    calls,
    getConfig: () => ({}),
    getDataDir: () => '/tmp/x',
    logger: { info() {}, warn() {} },
    callService: async (method: string, params: unknown) => { calls.push({ method, params }); return { ok: true }; },
  };
}

describe('只读工具', () => {
  it.each([
    ['list_accounts.js', 'list_accounts'],
    ['list_folders.js', 'list_folders'],
    ['list_mails.js', 'list_mails'],
    ['read_mail.js', 'read_mail'],
  ] as const)('%s：短名=文件名，schema object，handles 精确匹配', (file, name) => {
    const tools = load(file).createTools(fakeCtx());
    const defs = tools.getDefs();
    expect(defs).toHaveLength(1);
    expect(defs[0]!.name).toBe(name);
    expect(defs[0]!.inputSchema.type).toBe('object');
    expect(tools.handles(name)).toBe(true);
    expect(tools.handles('other')).toBe(false);
    expect(tools.getCatalog()[0]!.name).toBe(name);
  });

  it('list_accounts：转发 accounts.list；返回 JSON 无 password 面', async () => {
    const ctx = fakeCtx();
    ctx.callService = async () => [{ id: 'acc1', email: 'a@b.c', displayName: 'A', username: 'a@b.c', imap: {}, smtp: {}, health: { state: 'ok' } }];
    const out = await load('list_accounts.js').createTools(ctx).execute('list_accounts', {});
    expect(ctx.calls[0]!.method).toBe('accounts.list');
    expect(JSON.parse(out)[0]).not.toHaveProperty('password');
  });

  it('list_folders：转发 folders.list {accountId}', async () => {
    const ctx = fakeCtx();
    await load('list_folders.js').createTools(ctx).execute('list_folders', { accountId: 'acc1' });
    expect(ctx.calls[0]).toMatchObject({ method: 'folders.list', params: { accountId: 'acc1' } });
  });

  it('list_mails：pageSize 钳制 [1,50]，page 缺省 1，folder 缺省 INBOX', async () => {
    const ctx = fakeCtx();
    const tools = load('list_mails.js').createTools(ctx);
    await tools.execute('list_mails', { accountId: 'a', pageSize: 999 });
    expect(ctx.calls[0]!.params).toMatchObject({ pageSize: 50, page: 1, folder: 'INBOX' });
    await tools.execute('list_mails', { accountId: 'a', pageSize: 0 });
    expect((ctx.calls[1]!.params as { pageSize: number }).pageSize).toBe(1);
  });

  it('read_mail/list_folders：必填参数缺失 → 中文错误（不进 service）', async () => {
    const ctx = fakeCtx();
    await expect(load('read_mail.js').createTools(ctx).execute('read_mail', { accountId: 'a' })).rejects.toThrow('uid');
    await expect(load('list_folders.js').createTools(ctx).execute('list_folders', {})).rejects.toThrow('accountId');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/email/tools-readonly.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现四模块**（一文件一工具，全文如下）

`tools/list_accounts.js`：

```js
// list_accounts：列出已配置邮箱账号（脱敏，无凭据）。
'use strict';
const DEF = {
  name: 'list_accounts',
  description: '列出用户已配置的全部邮箱账号（id、邮箱地址、显示名、健康状态）。返回不含任何凭据。摘要/群发类任务先调用本工具确定账号范围。',
  inputSchema: { type: 'object', properties: {}, required: [] },
};
module.exports.createTools = function createTools(pctx) {
  return {
    getDefs() { return [{ ...DEF }]; },
    getCatalog() { return [{ name: DEF.name, displayName: '邮箱账号列表', description: DEF.description, category: '邮件', categoryEmoji: '', defaultOn: false }]; },
    handles(n) { return n === DEF.name; },
    async execute(n) {
      if (n !== DEF.name) throw new Error(`未知工具: ${n}`);
      const accounts = await pctx.callService('accounts.list', {});
      return JSON.stringify(accounts, null, 2);
    },
  };
};
```

`tools/list_folders.js`：

```js
// list_folders：列出账号的邮箱文件夹树（INBOX/草稿/已发送/自定义）。
'use strict';
const DEF = {
  name: 'list_folders',
  description: '列出指定账号的邮箱文件夹（含 special-use 标记与草稿/已发送归位）。读草稿或核对已发送时先用本工具。',
  inputSchema: {
    type: 'object',
    properties: { accountId: { type: 'string', description: '账号 id（list_accounts 返回）' } },
    required: ['accountId'],
  },
};
module.exports.createTools = function createTools(pctx) {
  return {
    getDefs() { return [{ ...DEF }]; },
    getCatalog() { return [{ name: DEF.name, displayName: '邮箱文件夹树', description: DEF.description, category: '邮件', categoryEmoji: '', defaultOn: false }]; },
    handles(n) { return n === DEF.name; },
    async execute(n, args) {
      if (n !== DEF.name) throw new Error(`未知工具: ${n}`);
      if (typeof args.accountId !== 'string' || args.accountId === '') throw new Error('参数 accountId 缺失');
      const folders = await pctx.callService('folders.list', { accountId: args.accountId });
      return JSON.stringify(folders, null, 2);
    },
  };
};
```

`tools/list_mails.js`：

```js
// list_mails：分页列邮件（过滤：时间/未读/发件人/主题）。
'use strict';
const DEF = {
  name: 'list_mails',
  description: '列出账号某文件夹的邮件信封（分页，默认 20 条/页、上限 50）。过滤参数：since（YYYY-MM-DD）、unreadOnly、from、subject 关键词。摘要任务先用它圈定范围，忌直接 read_mail 全量读。',
  inputSchema: {
    type: 'object',
    properties: {
      accountId: { type: 'string', description: '账号 id' },
      folder: { type: 'string', description: '文件夹（缺省 INBOX）' },
      page: { type: 'number', description: '页码（缺省 1）' },
      pageSize: { type: 'number', description: '每页条数 1-50（缺省 20）' },
      filter: {
        type: 'object', description: '{ since?, unreadOnly?, from?, subject? }',
        properties: { since: { type: 'string' }, unreadOnly: { type: 'boolean' }, from: { type: 'string' }, subject: { type: 'string' } },
      },
    },
    required: ['accountId'],
  },
};
module.exports.createTools = function createTools(pctx) {
  const clampSize = (v) => Math.min(Math.max(Math.trunc(Number(v) || 20), 1), 50);
  return {
    getDefs() { return [{ ...DEF }]; },
    getCatalog() { return [{ name: DEF.name, displayName: '邮件列表', description: DEF.description, category: '邮件', categoryEmoji: '', defaultOn: false }]; },
    handles(n) { return n === DEF.name; },
    async execute(n, args) {
      if (n !== DEF.name) throw new Error(`未知工具: ${n}`);
      if (typeof args.accountId !== 'string' || args.accountId === '') throw new Error('参数 accountId 缺失');
      const page = await pctx.callService('mails.list', {
        accountId: args.accountId,
        folder: typeof args.folder === 'string' && args.folder !== '' ? args.folder : 'INBOX',
        page: Math.max(Math.trunc(Number(args.page) || 1), 1),
        pageSize: clampSize(args.pageSize),
        filter: args.filter ?? {},
      });
      return JSON.stringify(page, null, 2);
    },
  };
};
```

`tools/read_mail.js`：

```js
// read_mail：读单封邮件全文（200KB 截断保护 + 附件清单）。
'use strict';
const DEF = {
  name: 'read_mail',
  description: '读取单封邮件完整内容：正文（纯文本优先，>200KB 截断）+ 附件清单（partId/文件名/大小）。附件本体用 save_attachment 保存到工作区。超 2MB 的邮件会被拒收——改用 save_attachment。',
  inputSchema: {
    type: 'object',
    properties: {
      accountId: { type: 'string' }, folder: { type: 'string' }, uid: { type: 'number', description: 'list_mails 返回的邮件 uid' },
    },
    required: ['accountId', 'folder', 'uid'],
  },
};
module.exports.createTools = function createTools(pctx) {
  return {
    getDefs() { return [{ ...DEF }]; },
    getCatalog() { return [{ name: DEF.name, displayName: '读邮件', description: DEF.description, category: '邮件', categoryEmoji: '', defaultOn: false }]; },
    handles(n) { return n === DEF.name; },
    async execute(n, args) {
      if (n !== DEF.name) throw new Error(`未知工具: ${n}`);
      for (const k of ['accountId', 'folder']) {
        if (typeof args[k] !== 'string' || args[k] === '') throw new Error(`参数 ${k} 缺失`);
      }
      if (typeof args.uid !== 'number' || !Number.isInteger(args.uid)) throw new Error('参数 uid 缺失或非整数');
      const mail = await pctx.callService('mails.get', { accountId: args.accountId, folder: args.folder, uid: args.uid });
      return JSON.stringify(mail, null, 2);
    },
  };
};
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/email/tools-readonly.test.ts tests/email/service-index.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add plugins/email/tools tests/email/tools-readonly.test.ts
git commit -m "feat(email): 只读工具×4——账号/文件夹/列表/读信"
```

### Task 11: 写侧工具 ×3（附件/起草/发送）

**Files:**
- Create: `plugins/email/tools/save_attachment.js`、`draft_mail.js`、`send_draft.js`
- Test: `tests/email/tools-write.test.ts`

**Interfaces:**
- Consumes: `pctx.callService`；`ToolContext` 第三参（`wsFs.assertInWorkspace`、`recordFileChange?`、`readTracker?`、`roomId`、`parentStreamSessionId`）
- Produces: 三模块；save_attachment 落盘链 = assertInWorkspace → readTracker（覆盖时）→ fs 写 → recordFileChange

- [ ] **Step 1: 写失败测试**

```ts
// tests/email/tools-write.test.ts
// save_attachment 记账链/双守门、draft_mail 25MB、send_draft 仅 draftId（Review Focus 3/4）
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';

const load = (f: string): { createTools(pctx: unknown): {
  getDefs(): Array<{ name: string }>;
  handles(n: string): boolean;
  execute(n: string, args: Record<string, unknown>, ctx?: unknown): Promise<string>;
} } => require(path.resolve(__dirname, '../../plugins/email/tools', f));

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'email-tools-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

function makeCtx(service: Record<string, (p: unknown) => unknown> = {}) {
  const writes: Array<[string, string, string]> = [];
  const toolCtx = {
    wsFs: { assertInWorkspace: (rel: string) => path.join(dir, rel) },
    recordFileChange: async (name: string, rel: string, op: string) => { writes.push([name, rel, op]); },
    readTracker: { assertRead() {} },
    roomId: 'r', streamSessionId: 's',
  };
  const pctx = {
    getConfig: () => ({}), getDataDir: () => dir, logger: { info() {}, warn() {} },
    callService: async (method: string, params: unknown) => {
      if (method === 'attachments.get') {
        return service.attachments_get ? service.attachments_get(params) : { filename: 'a.pdf', contentType: 'application/pdf', base64: Buffer.from('pdf-bytes').toString('base64') };
      }
      if (method === 'drafts.save') {
        return service.drafts_save ? service.drafts_save(params) : { id: 'draft_x', status: 'pending' };
      }
      if (method === 'drafts.send') {
        return service.drafts_send ? service.drafts_send(params) : { status: 'sent' };
      }
      throw new Error('unexpected ' + method);
    },
  };
  return { pctx, toolCtx, writes };
}

describe('save_attachment', () => {
  it('全链：拉附件 → 工作区落盘 → recordFileChange(create)', async () => {
    const { pctx, toolCtx, writes } = makeCtx();
    const out = await load('save_attachment.js').createTools(pctx).execute('save_attachment',
      { accountId: 'a', folder: 'INBOX', uid: 2, partId: '1.1', destPath: 'docs/a.pdf' }, toolCtx);
    const parsed = JSON.parse(out);
    expect(parsed.saved).toBe('docs/a.pdf');
    expect(fs.readFileSync(path.join(dir, 'docs/a.pdf')).toString()).toBe('pdf-bytes');
    expect(writes[0]).toEqual(['plugin:email/save_attachment', 'docs/a.pdf', 'create']);
  });

  it('工具侧 10MB 双守门（service 放行也拒）', async () => {
    const big = Buffer.alloc(10 * 1024 * 1024 + 1);
    const { pctx, toolCtx } = makeCtx({ attachments_get: async () => ({ filename: 'big', contentType: 'x', base64: big.toString('base64') }) });
    await expect(load('save_attachment.js').createTools(pctx).execute('save_attachment',
      { accountId: 'a', folder: 'INBOX', uid: 1, partId: '1', destPath: 'big' }, toolCtx)).rejects.toThrow('10MB');
  });

  it('缺 wsFs 注入 → 明确报错不降级', async () => {
    const { pctx } = makeCtx();
    await expect(load('save_attachment.js').createTools(pctx).execute('save_attachment',
      { accountId: 'a', folder: 'INBOX', uid: 1, partId: '1', destPath: 'x' }, {})).rejects.toThrow('wsFs');
  });
});

describe('draft_mail', () => {
  it('工作区附件读取 → base64 组装 → drafts.save；25MB 累计拒绝', async () => {
    const { pctx, toolCtx } = makeCtx();
    fs.writeFileSync(path.join(dir, 'att.bin'), Buffer.from('bin'));
    const tools = load('draft_mail.js').createTools(pctx);
    const out = await tools.execute('draft_mail',
      { accountId: 'a', to: 'x@y.z', subject: 'S', text: 'T', attachments: ['att.bin'] }, toolCtx);
    expect(JSON.parse(out).draftId).toBe('draft_x');
    fs.writeFileSync(path.join(dir, 'big.bin'), Buffer.alloc(26 * 1024 * 1024));
    await expect(tools.execute('draft_mail',
      { accountId: 'a', to: 'x@y.z', subject: 'S', text: 'T', attachments: ['big.bin'] }, toolCtx)).rejects.toThrow('25MB');
  });

  it('附件路径必须在工作区内（assertInWorkspace 抛错透传）', async () => {
    const { pctx, toolCtx } = makeCtx();
    const tools = load('draft_mail.js').createTools(pctx);
    await expect(tools.execute('draft_mail',
      { accountId: 'a', to: 'x@y.z', subject: 'S', text: 'T', attachments: ['../evil.bin'] }, toolCtx)).rejects.toThrow();
  });
});

describe('send_draft', () => {
  it('仅认 draftId 转发，无收件人参数面；缺失拒绝', async () => {
    const { pctx } = makeCtx();
    let seenParams: unknown;
    const pctx2 = { ...pctx, callService: async (_m: string, params: unknown) => { seenParams = params; return { status: 'sent' }; } };
    const tools = load('send_draft.js').createTools(pctx2);
    await tools.execute('send_draft', { draftId: 'draft_x' });
    expect(seenParams).toEqual({ draftId: 'draft_x' });
    await expect(tools.execute('send_draft', {})).rejects.toThrow('draftId');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/email/tools-write.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现三模块**

`tools/save_attachment.js`：

```js
// save_attachment：邮件附件保存到工作区（wsFs 边界 + 变更记账；10MB 双守门第二道）。
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const ATTACH_MAX = 10 * 1024 * 1024;

const DEF = {
  name: 'save_attachment',
  description: '把邮件附件保存到当前工作区指定路径（相对路径）。单附件 ≤10MB。覆盖已存在文件需先读过该文件（Read-before-Edit 门禁）。',
  inputSchema: {
    type: 'object',
    properties: {
      accountId: { type: 'string' }, folder: { type: 'string' }, uid: { type: 'number' },
      partId: { type: 'string', description: 'read_mail 返回的附件 partId' },
      destPath: { type: 'string', description: '工作区相对路径（如 docs/报告.pdf）' },
    },
    required: ['accountId', 'folder', 'uid', 'partId', 'destPath'],
  },
};
module.exports.createTools = function createTools(pctx) {
  return {
    getDefs() { return [{ ...DEF }]; },
    getCatalog() { return [{ name: DEF.name, displayName: '附件存工作区', description: DEF.description, category: '邮件', categoryEmoji: '', defaultOn: false }]; },
    handles(n) { return n === DEF.name; },
    async execute(n, args, ctx) {
      if (n !== DEF.name) throw new Error(`未知工具: ${n}`);
      for (const k of ['accountId', 'folder', 'partId', 'destPath']) {
        if (typeof args[k] !== 'string' || args[k] === '') throw new Error(`参数 ${k} 缺失`);
      }
      if (!Number.isInteger(args.uid)) throw new Error('参数 uid 缺失');
      if (typeof ctx.wsFs?.assertInWorkspace !== 'function') {
        throw new Error('save_attachment 需要宿主注入 wsFs（App 版本过旧或运行时未装配）——请升级 Momo Studio');
      }
      const att = await pctx.callService('attachments.get', { accountId: args.accountId, folder: args.folder, uid: args.uid, partId: args.partId });
      const buf = Buffer.from(String(att.base64 || ''), 'base64');
      if (buf.length > ATTACH_MAX) throw new Error(`附件超过 10MB 上限（${buf.length} 字节）`);
      const abs = ctx.wsFs.assertInWorkspace(args.destPath);
      const existed = fs.existsSync(abs);
      if (existed && ctx.readTracker && typeof ctx.readTracker.assertRead === 'function') {
        ctx.readTracker.assertRead(ctx.roomId, ctx.parentStreamSessionId, abs);
      }
      const before = existed ? fs.readFileSync(abs) : null;
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, buf);
      if (typeof ctx.recordFileChange === 'function') {
        ctx.recordFileChange('plugin:email/save_attachment', args.destPath, existed ? 'modify' : 'create', before, buf);
      }
      return JSON.stringify({ saved: args.destPath, bytes: buf.length, filename: att.filename }, null, 2);
    },
  };
};
```

`tools/draft_mail.js`：

```js
// draft_mail：起草邮件（存草稿，不发送）。附件 = 工作区相对路径数组（wsFs 边界 + 25MB 累计守门）。
'use strict';
const fs = require('node:fs');

const ATTACH_TOTAL_MAX = 25 * 1024 * 1024;

const DEF = {
  name: 'draft_mail',
  description: '起草邮件并存入草稿箱（不发送）。收件人/主题/正文在此时定型；附件用工作区相对路径。起草后必须在回复中展示完整内容并征求用户确认，确认后才可调用 send_draft。',
  inputSchema: {
    type: 'object',
    properties: {
      accountId: { type: 'string', description: '发件账号 id（缺省取第一个账号）' },
      to: { type: 'string', description: '收件人邮箱（多个用逗号分隔）' },
      cc: { type: 'string', description: '抄送（可省）' },
      subject: { type: 'string' },
      text: { type: 'string', description: '正文（纯文本）' },
      attachments: { type: 'array', items: { type: 'string' }, description: '工作区相对路径列表（总量 ≤25MB）' },
    },
    required: ['to', 'subject', 'text'],
  },
};
const splitAddrs = (v) => String(v || '').split(/[,，;；]/).map((s) => s.trim()).filter(Boolean);

module.exports.createTools = function createTools(pctx) {
  return {
    getDefs() { return [{ ...DEF }]; },
    getCatalog() { return [{ name: DEF.name, displayName: '起草邮件', description: DEF.description, category: '邮件', categoryEmoji: '', defaultOn: false }]; },
    handles(n) { return n === DEF.name; },
    async execute(n, args, ctx) {
      if (n !== DEF.name) throw new Error(`未知工具: ${n}`);
      const to = splitAddrs(args.to);
      if (to.length === 0) throw new Error('参数 to 缺失（至少一个收件人）');
      if (typeof ctx.wsFs?.assertInWorkspace !== 'function') {
        throw new Error('draft_mail 需要宿主注入 wsFs——请升级 Momo Studio');
      }
      const files = [];
      let total = 0;
      for (const rel of Array.isArray(args.attachments) ? args.attachments : []) {
        if (typeof rel !== 'string' || rel === '') continue;
        const abs = ctx.wsFs.assertInWorkspace(rel);
        const data = fs.readFileSync(abs);
        total += data.length;
        if (total > ATTACH_TOTAL_MAX) throw new Error(`附件总量超过 25MB 上限（已累计 ${total} 字节）`);
        files.push({ filename: rel.split('/').pop(), contentType: 'application/octet-stream', base64: data.toString('base64') });
      }
      const draft = await pctx.callService('drafts.save', {
        accountId: typeof args.accountId === 'string' && args.accountId !== '' ? args.accountId : '__first__',
        to, cc: splitAddrs(args.cc),
        subject: String(args.subject || ''), text: String(args.text || ''),
        attachments: files,
      });
      return JSON.stringify({
        draftId: draft.id, status: draft.status, to, subject: draft.subject,
        hint: '草稿已存入草稿箱——需用户明确确认后才能调用 send_draft（或用户在邮件面板手动发送）',
      }, null, 2);
    },
  };
};
```

（Task 9 `ROUTES['drafts.save']` 补首账号回退：`p.accountId === '__first__'` 时取 `list()[0]`，无账号则抛中文错误「尚未配置邮箱账号」。写在本 Step 一并落地并回归 service-index 测试。）

`tools/send_draft.js`：

```js
// send_draft：发送已确认草稿（仅 draftId——收件人不可在此指定，门禁纵深）。
'use strict';
const DEF = {
  name: 'send_draft',
  description: '发送指定草稿。【行为契约】仅当用户已明确确认发送（看过完整内容并同意）后才允许调用；禁止未经确认直接发送。草稿 id 来自 draft_mail 返回值。',
  inputSchema: {
    type: 'object',
    properties: { draftId: { type: 'string', description: 'draft_mail 返回的草稿 id' } },
    required: ['draftId'],
  },
};
module.exports.createTools = function createTools(pctx) {
  return {
    getDefs() { return [{ ...DEF }]; },
    getCatalog() { return [{ name: DEF.name, displayName: '发送草稿', description: DEF.description, category: '邮件', categoryEmoji: '', defaultOn: false }]; },
    handles(n) { return n === DEF.name; },
    async execute(n, args) {
      if (n !== DEF.name) throw new Error(`未知工具: ${n}`);
      if (typeof args.draftId !== 'string' || args.draftId === '') throw new Error('参数 draftId 缺失');
      const result = await pctx.callService('drafts.send', { draftId: args.draftId });
      return JSON.stringify(result, null, 2);
    },
  };
};
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/email/tools-write.test.ts tests/email/service-index.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add plugins/email/tools tests/email/tools-write.test.ts
git commit -m "feat(email): 写侧工具×3——附件存工作区/起草/确认发送"
```

### Task 12: skill + 预置 agent

**Files:**
- Create: `plugins/email/skills/email-ops/SKILL.md`、`plugins/email/agents/email-assistant.yaml`
- Test: `tests/email/preset.test.ts`

**Interfaces:**
- Produces: skill slug `email-ops`；agent slug `email-assistant`（**spec 层** defaultTools 七工具 + defaultSkills email-ops；`spec.declarative.model` 为宿主 parser 必需的「建议块」，真正的模型绑定由 resolveModelBinding 走全局默认）

- [ ] **Step 1: 写失败测试**

```ts
// tests/email/preset.test.ts
// SKILL.md 宿主解析 + agent YAML 断言 + manifest 完整校验（此刻 tools/skills/agents 全在位，cross-ref 生效）
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { HOST_READY, hostImport, hostRequire } from '../host';
import { PLUGIN_ROOT } from './fixtures';

let parseSkillMd: ((md: string, dir: string) => { slug: string; name: string; description: string; body: string }) | null = null;
let validateManifest: ((m: unknown, root: string) => void) | null = null;
let yamlLoad: ((t: string) => Record<string, unknown>) | null = null;

describe.skipIf(!HOST_READY)('email 预置 skill/agent/manifest', () => {
  beforeAll(async () => {
    parseSkillMd = ((await hostImport('skill/loader.ts')) as unknown as { parseSkillMd: (md: string, dir: string) => { slug: string } }).parseSkillMd;
    validateManifest = ((await hostImport('plugin/manifest.ts')) as unknown as { validateManifest: (m: unknown, root: string) => void }).validateManifest;
    yamlLoad = hostRequire<{ load: (t: string) => Record<string, unknown> }>('js-yaml').load;
  });

  it('SKILL.md 解析通过且含关键章节', () => {
    const md = fs.readFileSync(path.join(PLUGIN_ROOT, 'skills/email-ops/SKILL.md'), 'utf-8');
    const def = parseSkillMd!(md, path.join(PLUGIN_ROOT, 'skills/email-ops'));
    expect(def.slug).toBe('email-ops');
    expect(def.body).toContain('发送契约');
    expect(def.body).toContain('错误处置');
  });

  it('agent YAML：spec 层七工具 ref + defaultSkills=[email-ops] + model 建议块', () => {
    const raw = yamlLoad!(fs.readFileSync(path.join(PLUGIN_ROOT, 'agents/email-assistant.yaml'), 'utf-8')) as {
      metadata?: { slug?: string };
      spec?: {
        declarative?: { systemPrompt?: string; model?: { provider?: string; model?: string } };
        defaultTools?: Array<{ ref?: string }>;
        defaultSkills?: Array<{ ref?: string }>;
      };
    };
    expect(raw.metadata?.slug).toBe('email-assistant');
    // 宿主跨引用校验（plugin/manifest.ts:216）与 parser（agent/manifest-parser.ts:86）都读 spec 层
    const refs = (raw.spec?.defaultTools ?? []).map((t) => t.ref ?? '');
    for (const t of ['list_accounts', 'list_folders', 'list_mails', 'read_mail', 'save_attachment', 'draft_mail', 'send_draft']) {
      expect(refs).toContain(`plugin:email/${t}`);
    }
    expect(raw.spec?.defaultSkills?.map((s) => s.ref)).toEqual(['email-ops']);
    expect(raw.spec?.declarative?.model).toMatchObject({ provider: 'anthropic' });
    expect(raw.spec?.declarative?.systemPrompt).toContain('确认');
  });

  it('宿主 parseAgentManifestWithSuggestion 实解析：八工具入库 + 模型绑定留空（走全局默认）', async () => {
    const mod = (await hostImport('agent/manifest-parser.ts')) as unknown as {
      parseAgentManifestWithSuggestion(yaml: string): {
        def: {
          slug: string;
          defaultTools: Array<{ ref: string }>;
          defaultSkills: Array<{ ref: string }>;
          modelProviderId: string | null;
        };
      };
    };
    const { def } = mod.parseAgentManifestWithSuggestion(
      fs.readFileSync(path.join(PLUGIN_ROOT, 'agents/email-assistant.yaml'), 'utf-8'),
    );
    expect(def.slug).toBe('email-assistant');
    expect(def.defaultTools).toHaveLength(8); // read_file + 七个 plugin:email/* 工具
    expect(def.defaultTools.map((t) => t.ref)).toContain('plugin:email/send_draft');
    expect(def.defaultSkills.map((s) => s.ref)).toEqual(['email-ops']);
    expect(def.modelProviderId).toBeNull(); // 绑定留空 → resolveModelBinding 走全局默认聊天模型
  });

  it('manifest 通过完整 validateManifest（cross-ref：工具文件名 ↔ defaultTools、skills 子目录）', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, 'momo-plugin.json'), 'utf-8'));
    expect(() => validateManifest!(manifest, PLUGIN_ROOT)).not.toThrow();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/email/preset.test.ts`
Expected: FAIL（文件不存在）

- [ ] **Step 3: 实现两文件**

`skills/email-ops/SKILL.md`：

```markdown
---
name: email-ops
description: 邮箱操作方法论——多账号经 plugin:email/* 工具集收发邮件的正确姿势与发送契约
---

# email-ops

## 工具速查

- `plugin:email/list_accounts` 已配置账号（脱敏；带健康态）
- `plugin:email/list_folders` 文件夹树（草稿/已发送归位探测）
- `plugin:email/list_mails` 信封分页（filter：since/unreadOnly/from/subject；每页 ≤50）
- `plugin:email/read_mail` 单封全文（>200KB 截断；>2MB 拒收）
- `plugin:email/save_attachment` 附件存工作区（≤10MB；路径为工作区相对路径）
- `plugin:email/draft_mail` 起草（不发送；附件=工作区相对路径数组，总量 ≤25MB）
- `plugin:email/send_draft` 发送已确认草稿（仅 draftId）

## 操作方法论

1. 先 `list_accounts` 定账号（多账号逐一处理，单账号失败不拖全局——按失败原因报告）
2. `list_mails` 用 filter 圈定范围（日期/未读/发件人/主题），忌全量 read_mail
3. 按需 `read_mail` 细读重点邮件；摘要按发件人/主题线索分组，未读与回复链优先，提取时限词（截止/回复期限）

## 起草规范

- 称谓得体；回复引用关键原文（简摘，不整段粘贴）；落款默认跟随账号显示名
- 附件给工作区相对路径；超限（单件 10MB / 总量 25MB）提前告知用户调整

## 发送契约（硬规则）

1. `draft_mail` 起草后，**必须在回复中完整展示**收件人/主题/正文/附件清单
2. 明确询问「确认发送？」，等待用户答复
3. 仅当用户明确同意（如「确认发送」「发吧」）才调用 `send_draft`
4. 禁止：未经确认调用 send_draft；谎称已发送——发送成功以 send_draft 返回 sent 为准，失败如实报告原因
5. 用户要求修改 → 重新 draft_mail（旧草稿会 24h 自动作废，或建议用户在面板放弃）

## 错误处置

| 症状 | 处置 |
|---|---|
| 认证失败（auth） | 提示用户到邮件面板检查授权码（可能过期/IMAP 未开启），勿重试轰炸 |
| 文件夹不存在 | 先 `list_folders` 拿准确路径（中文文件夹名常见） |
| 附件超限 | 明确报数值上限，建议用户改用小文件或网盘链接 |
| 邮件 >2MB | 改用 save_attachment 按附件取 |
| 超时 | 提示网络状况，缓存列表仍可用（降级） |
```

`agents/email-assistant.yaml`：

```yaml
# 邮件助手（email）——读邮析信、摘要、代发。发送走草稿+确认契约（spec §7）。
apiVersion: v1
kind: AgentDefinition
metadata:
  name: 邮件助手
  slug: email-assistant
  version: 0.1.0
  description: 读邮箱、分析邮件、生成摘要，按要求起草并发送邮件——多邮箱经 plugin:email/* 工具集。
spec:
  runtime: declarative
  declarative:
    systemPrompt: |
      你是邮件助手——用户邮箱的读信、摘要与代发专家。

      工作流：
      1. 任何邮箱任务先加载 email-ops 技能并遵守全部纪律
      2. 摘要任务：list_accounts 定账号 → list_mails 圈范围 → 按需 read_mail → 按发件人/主题线索分组输出，未读与回复链优先，标注时限词
      3. 代发任务：按用户要求 draft_mail 起草 → 回复中完整展示收件人/主题/正文/附件 → 询问「确认发送？」
      4. 用户确认后 send_draft；发送结果如实报告

      硬规则：
      - NEVER: 未经用户明确确认就调用 send_draft；谎称已发送；在输出中出现任何授权码/密码
      - ALWAYS: 多账号任务单账号失败继续其余并如实报告失败原因；回复邮件先读原信拿上下文
    # 宿主 manifest-parser 硬性要求 model 块（provider 仅 openai/anthropic）。
    # 它是「建议位」不是绑定：modelProviderId 保持 null，真正绑定由
    # agent-sync 的 resolveModelBinding 走全局默认聊天模型。
    model:
      provider: anthropic
      model: claude-sonnet-4-5
  # defaultTools / defaultSkills 必须在 spec 层——宿主 parser 与 cross-ref 校验都只读这里
  defaultTools:
    - kind: builtin
      ref: read_file
    - kind: builtin
      ref: plugin:email/list_accounts
    - kind: builtin
      ref: plugin:email/list_folders
    - kind: builtin
      ref: plugin:email/list_mails
    - kind: builtin
      ref: plugin:email/read_mail
    - kind: builtin
      ref: plugin:email/save_attachment
    - kind: builtin
      ref: plugin:email/draft_mail
    - kind: builtin
      ref: plugin:email/send_draft
  defaultSkills:
    - kind: skill
      ref: email-ops
```

（宿主契约：`model` 块必需但仅作 suggestion（`modelProviderId` 解析为 null → resolveModelBinding 落全局默认聊天模型）；`defaultTools/defaultSkills` 必须在 spec 层，否则 parser 不注入工具且 cross-ref 校验空转。）

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/email/preset.test.ts`
Expected: PASS（此刻 manifest cross-ref 生效——文件名=工具短名被宿主校验锁定）

- [ ] **Step 5: Commit**

```bash
git add plugins/email/skills plugins/email/agents tests/email/preset.test.ts
git commit -m "feat(email): email-ops 技能 + 邮件助手预置 agent"
```

### Task 13: panel 三栏 UI

**Files:**
- Create: `plugins/email/panel/panel.json`、`plugins/email/panel/index.html`
- Test: `tests/email/panel-static.test.ts`
- 删除 `.gitkeep`（目录已有实体文件）

**Interfaces:**
- Consumes: PanelChannel 协议（`ready` 握手 → `rpc:result` 回包；`plugin:callService` {method, params}）；主题快照（ready 回包 result.tokens，语义 token → CSS 变量）
- Produces: 面板 `{id: mail, title: 邮件, icon: lucide:mail, location: page, entry: ./index.html}`

- [ ] **Step 1: 写失败测试**

```ts
// tests/email/panel-static.test.ts
// panel.json 形状 + 宿主 validatePanelsAtRoot + index.html 关键交互锚点
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { HOST_READY, hostImport } from '../host';
import { PLUGIN_ROOT } from './fixtures';

let validatePanelsAtRoot: ((root: string, manifest: unknown, pluginId: string) => unknown) | null = null;

describe.skipIf(!HOST_READY)('email panel', () => {
  beforeAll(async () => {
    validatePanelsAtRoot = ((await hostImport('plugin/panel-sync.ts')) as unknown as {
      validatePanelsAtRoot: (root: string, manifest: unknown, pluginId: string) => unknown;
    }).validatePanelsAtRoot;
  });

  it('panel.json 形状 + 宿主校验通过', () => {
    const decl = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, 'panel/panel.json'), 'utf-8'));
    expect(decl.panels).toHaveLength(1);
    expect(decl.panels[0]).toMatchObject({ id: 'mail', location: 'page', icon: 'lucide:mail' });
    const manifest = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, 'momo-plugin.json'), 'utf-8'));
    expect(() => validatePanelsAtRoot!(PLUGIN_ROOT, manifest, 'email')).not.toThrow();
  });

  it('index.html 含三栏挂载点与关键 service 方法锚点', () => {
    const html = fs.readFileSync(path.join(PLUGIN_ROOT, 'panel/index.html'), 'utf-8');
    for (const anchor of [
      'id="folders"', 'id="maillist"', 'id="reader"', 'id="account-form"',
      'accounts.add', 'accounts.test', 'accounts.delete',
      'mails.list', 'mails.refresh', 'mails.get',
      'drafts.send', 'drafts.discard',
    ]) {
      expect(html).toContain(anchor);
    }
    // HTML 邮件渲染必须走嵌套沙箱 iframe（spec §8/§11）
    expect(html).toContain('sandbox=""');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/email/panel-static.test.ts`
Expected: FAIL（panel.json 不存在）

- [ ] **Step 3: 实现**

`panel/panel.json`：

```json
{
  "panels": [
    { "id": "mail", "title": "邮件", "icon": "lucide:mail", "location": "page", "entry": "./index.html" }
  ]
}
```

`panel/index.html`——完整单文件实现（无构建，inline JS/CSS；协议同 codegraph：`parent.postMessage('*')` + `rpc:result` 回包；ready 回包 `result.tokens` 有则注入 CSS 变量跟随主题）：

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>邮件</title>
<style>
  :root { --bg:#fff; --s1:#f7f7f8; --s2:#eeeef0; --tx:#1a1a1e; --tx2:#66666e; --tx3:#99999f; --bd:#e2e2e5; --acc:#3b6ef5; --err:#d33; --ok:#3a3; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font: 12.5px/1.6 -apple-system, 'PingFang SC', sans-serif; height: 100vh; display: flex; color: var(--tx); background: var(--bg); }
  .col-left { width: 200px; border-right: 1px solid var(--bd); overflow: auto; padding: 8px; flex-shrink: 0; }
  .col-mid { width: 320px; border-right: 1px solid var(--bd); display: flex; flex-direction: column; flex-shrink: 0; }
  .col-right { flex: 1; overflow: auto; }
  .acc { padding: 6px 8px; border-radius: 6px; cursor: pointer; font-weight: 600; display: flex; align-items: center; gap: 6px; }
  .acc:hover, .acc.on { background: var(--s2); }
  .acc .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--ok); flex-shrink: 0; }
  .acc .dot.err { background: var(--err); }
  .folder { padding: 3px 8px 3px 22px; color: var(--tx2); cursor: pointer; border-radius: 4px; display: flex; justify-content: space-between; }
  .folder:hover, .folder.on { background: var(--s2); color: var(--tx); }
  .folder .n { color: var(--tx3); }
  .toolbar { display: flex; gap: 6px; padding: 8px; border-bottom: 1px solid var(--bd); }
  input, select, textarea { font: inherit; border: 1px solid var(--bd); border-radius: 5px; padding: 4px 8px; background: var(--bg); color: var(--tx); min-width: 0; }
  .mail { padding: 7px 10px; border-bottom: 1px solid var(--bd); cursor: pointer; }
  .mail:hover, .mail.on { background: var(--s1); }
  .mail .subj { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .mail.unread .subj::before { content: '● '; color: var(--acc); }
  .mail .meta { display: flex; justify-content: space-between; color: var(--tx3); font-size: 11px; }
  .mail .meta .att { color: var(--acc); }
  .pager { display: flex; gap: 8px; align-items: center; justify-content: center; padding: 6px; color: var(--tx3); }
  button { font: inherit; border: 1px solid var(--bd); background: var(--s1); color: var(--tx); border-radius: 5px; padding: 4px 10px; cursor: pointer; }
  button.pri { background: var(--acc); border-color: var(--acc); color: #fff; }
  button:disabled { opacity: .5; cursor: default; }
  .hd { padding: 10px 14px; border-bottom: 1px solid var(--bd); }
  .hd .subj { font-size: 14px; font-weight: 700; }
  .hd .m { color: var(--tx2); font-size: 11.5px; }
  .body { padding: 12px 14px; white-space: pre-wrap; word-break: break-word; }
  .att-row { display: flex; gap: 10px; padding: 3px 0; color: var(--tx2); }
  .hint { color: var(--tx3); font-size: 11px; }
  .status { padding: 4px 8px; min-height: 20px; color: var(--tx3); }
  .status.err { color: var(--err); }
  #account-form { position: fixed; inset: 0; background: rgba(0,0,0,.35); display: none; align-items: center; justify-content: center; }
  #account-form .box { background: var(--bg); border: 1px solid var(--bd); border-radius: 10px; padding: 16px; width: 380px; display: flex; flex-direction: column; gap: 8px; }
  #account-form label { font-size: 11px; color: var(--tx2); }
  .draft .ops { display: flex; gap: 8px; margin-top: 6px; }
</style>
</head>
<body>
  <div class="col-left">
    <div class="toolbar"><button class="pri" onclick="openAccountForm()">+ 添加账号</button></div>
    <div id="folders"></div>
  </div>
  <div class="col-mid">
    <div class="toolbar">
      <input id="q" placeholder="搜索主题/发件人" style="flex:1" onkeydown="if(event.key==='Enter')reloadList()">
      <button onclick="reloadList(true)">刷新</button>
    </div>
    <div id="maillist" style="flex:1;overflow:auto"></div>
    <div class="pager">
      <button onclick="turnPage(-1)">‹ 上一页</button>
      <span id="pageinfo"></span>
      <button onclick="turnPage(1)">下一页 ›</button>
    </div>
  </div>
  <div class="col-right"><div id="reader"><p class="hint" style="padding:14px">选择左侧邮件查看</p></div></div>

  <div id="account-form">
    <div class="box">
      <b>添加邮箱账号</b>
      <label>常用预设</label>
      <select id="f-preset" onchange="applyPreset()"><option value="">— 选择或自定义 —</option><option value="qq">QQ 邮箱</option><option value="163">163 邮箱</option><option value="gmail">Gmail</option><option value="outlook">Outlook</option></select>
      <label>邮箱地址</label><input id="f-email" placeholder="you@example.com" oninput="applyPreset()">
      <label>显示名（可选）</label><input id="f-name">
      <label>IMAP 服务器 / 端口 / 加密</label>
      <div style="display:flex;gap:6px"><input id="f-ih" style="flex:1"><input id="f-ip" style="width:64px"><select id="f-it"><option value="tls">TLS(993)</option><option value="starttls">STARTTLS(143)</option></select></div>
      <label>SMTP 服务器 / 端口 / 加密</label>
      <div style="display:flex;gap:6px"><input id="f-sh" style="flex:1"><input id="f-sp" style="width:64px"><select id="f-st"><option value="tls">TLS(465)</option><option value="starttls">STARTTLS(587)</option></select></div>
      <label>用户名（通常=邮箱地址）</label><input id="f-user">
      <label>授权码 / 应用密码（不回显，存系统钥匙串）</label><input id="f-pw" type="password">
      <div style="display:flex;gap:8px;justify-content:flex-end">
        <button onclick="closeAccountForm()">取消</button>
        <button onclick="testAccount()">测试连接</button>
        <button class="pri" onclick="saveAccount()">保存</button>
      </div>
      <div class="status" id="f-status"></div>
    </div>
  </div>

<script>
  // PanelChannel 胶水（codegraph 同款协议）：postMessage '*' + rpc:result 回包 + ready 握手
  var seq = 0, pending = {};
  function send(type, extra) {
    var id = ++seq;
    parent.postMessage(Object.assign({ type: type, id: id }, extra || {}), '*');
    return new Promise(function (resolve, reject) {
      pending[id] = { resolve: resolve, reject: reject };
      setTimeout(function () { if (pending[id]) { pending[id].reject(new Error('rpc 超时')); delete pending[id]; } }, 30000);
    });
  }
  window.addEventListener('message', function (ev) {
    var m = ev.data;
    if (!m || m.type !== 'rpc:result' || !pending[m.id]) return;
    if (m.error !== undefined) pending[m.id].reject(new Error(String(m.error)));
    else pending[m.id].resolve(m.result);
    delete pending[m.id];
  });
  function call(method, params) { return send('plugin:callService', { method: method, params: params || {} }); }

  // 状态
  var S = { accounts: [], accId: null, folders: null, folder: 'INBOX', page: 1, pageSize: 20, total: 0, mails: [] };
  var PRESETS = {
    qq: { ih: 'imap.qq.com', ip: 993, it: 'tls', sh: 'smtp.qq.com', sp: 465, st: 'tls' },
    '163': { ih: 'imap.163.com', ip: 993, it: 'tls', sh: 'smtp.163.com', sp: 465, st: 'tls' },
    gmail: { ih: 'imap.gmail.com', ip: 993, it: 'tls', sh: 'smtp.gmail.com', sp: 465, st: 'tls' },
    outlook: { ih: 'outlook.office365.com', ip: 993, it: 'tls', sh: 'smtp.office365.com', sp: 587, st: 'starttls' },
  };
  function $(id) { return document.getElementById(id); }
  function esc(s) { var d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }

  // 主题跟随：ready 回包携 tokens（有则覆写 CSS 变量）
  function applyTheme(res) {
    if (!res || !res.tokens) return;
    var map = { '--bg': 'bg-canvas', '--s1': 'surface-1', '--s2': 'surface-2', '--tx': 'text-primary', '--tx2': 'text-secondary', '--tx3': 'text-tertiary', '--bd': 'border-subtle', '--acc': 'accent-500' };
    var st = document.documentElement.style;
    for (var k in map) { var v = res.tokens['--' + map[k]]; if (v) st.setProperty(k, v); }
  }

  function renderAccounts() {
    var h = '';
    S.accounts.forEach(function (a) {
      h += '<div class="acc' + (a.id === S.accId ? ' on' : '') + '" onclick="pickAccount(\'' + a.id + '\')">' +
        '<span class="dot' + (a.health && a.health.state === 'error' ? ' err' : '') + '" title="' + esc(a.health && a.health.message || '') + '"></span>' + esc(a.displayName || a.email) +
        (a.health && a.health.state === 'error' ? ' <span class="hint">!</span>' : '') + '</div>';
      if (a.id === S.accId && S.folders) {
        var items = [{ p: 'INBOX', t: '收件箱' }, { p: S.folders.drafts, t: '草稿箱' }, { p: S.folders.sent, t: '已发送' }];
        items.forEach(function (it) {
          if (!it.p) return;
          h += '<div class="folder' + (S.folder === it.p ? ' on' : '') + '" onclick="pickFolder(\'' + esc(it.p) + '\')"><span>' + it.t + '</span></div>';
        });
      }
    });
    h += '<div class="folder" style="color:var(--tx3)" onclick="delAccount()">删除当前账号…</div>';
    $('folders').innerHTML = h || '<p class="hint" style="padding:8px">尚未配置邮箱——点击「+ 添加账号」</p>';
  }

  function renderList() {
    var h = '';
    S.mails.forEach(function (m) {
      h += '<div class="mail' + (!m.seen ? ' unread' : '') + (m.uid === S.selUid ? ' on' : '') + '" onclick="openMail(' + m.uid + ')">' +
        '<div class="subj">' + esc(m.subject || '(无主题)') + '</div>' +
        '<div class="meta"><span>' + esc(m.from) + '</span><span>' + (m.hasAttachments ? '<span class="att">附件 </span>' : '') + esc((m.date || '').slice(0, 16).replace('T', ' ')) + '</span></div></div>';
    });
    $('maillist').innerHTML = h || '<p class="hint" style="padding:10px">无邮件</p>';
    $('pageinfo').textContent = S.page + ' / ' + Math.max(1, Math.ceil(S.total / S.pageSize)) + '（' + S.total + '）';
  }

  function renderDraftBox() {
    call('drafts.list').then(function (ds) {
      var pendingDrafts = ds.filter(function (d) { return d.status === 'pending'; });
      if (S.folder !== (S.folders && S.folders.drafts) || pendingDrafts.length === 0) return;
      var h = '<div style="padding:8px 10px;border-bottom:1px solid var(--bd)"><b>待确认草稿（' + pendingDrafts.length + '）</b></div>';
      pendingDrafts.forEach(function (d) {
        h += '<div class="mail draft" style="margin:0"><div class="subj">→ ' + esc((d.to || []).join(', ')) + '：' + esc(d.subject) + '</div>' +
          '<div class="meta"><span>' + esc(d.summary) + '</span></div>' +
          '<div class="ops"><button class="pri" onclick="sendDraft(\'' + d.id + '\')">发送</button><button onclick="discardDraft(\'' + d.id + '\')">放弃</button></div></div>';
      });
      $('maillist').innerHTML = h + $('maillist').innerHTML;
    }).catch(function () {});
  }

  function reloadList(force) {
    if (!S.accId) return;
    var filter = {};
    var q = $('q').value.trim();
    if (q) filter.subject = q;
    call('mails.' + (force ? 'refresh' : 'list'), { accountId: S.accId, folder: S.folder, page: S.page, pageSize: S.pageSize, filter: filter })
      .then(function (p) { S.mails = p.items || []; S.total = p.total || 0; renderList(); if (!force) renderDraftBox(); })
      .catch(function (e) { $('maillist').innerHTML = '<p class="hint" style="padding:10px;color:var(--err)">' + esc(e.message) + '</p>'; });
  }

  function openMail(uid) {
    S.selUid = uid;
    renderList();
    $('reader').innerHTML = '<p class="hint" style="padding:14px">读取中…</p>';
    call('mails.get', { accountId: S.accId, folder: S.folder, uid: uid }).then(function (m) {
      var h = '<div class="hd"><div class="subj">' + esc(m.subject) + '</div>' +
        '<div class="m">发件人 ' + esc(m.from) + ' · ' + esc((m.date || '').replace('T', ' ').slice(0, 19)) + (m.truncated ? ' · <span style="color:var(--err)">正文已截断</span>' : '') + '</div></div>';
      if (m.html) {
        h += '<iframe sandbox="" style="width:100%;height:60%;border:0" srcdoc="' + esc(m.html).replace(/"/g, '&quot;') + '"></iframe><p class="hint" style="padding:0 14px">HTML 邮件以全惰性 iframe 渲染（脚本/远程资源已禁用）</p>';
      } else {
        h += '<div class="body">' + esc(m.text) + '</div>';
      }
      if (m.attachments && m.attachments.length) {
        h += '<div class="hd"><b>附件</b>（保存到工作区请在会话中让邮件助手处理）</div><div style="padding:0 14px 14px">';
        m.attachments.forEach(function (a) { h += '<div class="att-row">[附件] ' + esc(a.filename) + ' <span class="hint">' + Math.ceil((a.size || 0) / 1024) + ' KB</span></div>'; });
        h += '</div>';
      }
      $('reader').innerHTML = h;
    }).catch(function (e) { $('reader').innerHTML = '<p class="hint" style="padding:14px;color:var(--err)">' + esc(e.message) + '</p>'; });
  }

  // —— 账号表单 ——
  function openAccountForm() { $('account-form').style.display = 'flex'; $('f-status').textContent = ''; }
  function closeAccountForm() { $('account-form').style.display = 'none'; }
  function applyPreset() {
    var key = $('f-preset').value || ($('f-email').value || '').split('@')[1];
    if (key === 'foxmail.com') key = 'qq';
    if (key && PRESETS[key]) { var p = PRESETS[key]; $('f-ih').value = p.ih; $('f-ip').value = p.ip; $('f-it').value = p.it; $('f-sh').value = p.sh; $('f-sp').value = p.sp; $('f-st').value = p.st; $('f-user').value = $('f-email').value; }
  }
  function formInput() {
    return { email: $('f-email').value.trim(), displayName: $('f-name').value.trim() || null, username: $('f-user').value.trim() || $('f-email').value.trim(), password: $('f-pw').value,
      imap: { host: $('f-ih').value.trim(), port: Number($('f-ip').value), tlsMode: $('f-it').value },
      smtp: { host: $('f-sh').value.trim(), port: Number($('f-sp').value), tlsMode: $('f-st').value } };
  }
  function testAccount() {
    $('f-status').className = 'status'; $('f-status').textContent = '连接测试中…';
    call('accounts.test', formInput()).then(function (r) {
      $('f-status').className = 'status' + (r.ok ? '' : ' err');
      $('f-status').textContent = r.ok ? '连接成功 ✓（可保存）' : '失败：' + r.error;
    }).catch(function (e) { $('f-status').className = 'status err'; $('f-status').textContent = e.message; });
  }
  function saveAccount() {
    call('accounts.add', formInput()).then(function () { closeAccountForm(); boot(); })
      .catch(function (e) { $('f-status').className = 'status err'; $('f-status').textContent = e.message; });
  }
  function delAccount() {
    if (!S.accId || !confirm('删除该邮箱账号？（本地配置与凭据，不动服务器）')) return;
    call('accounts.delete', { id: S.accId }).then(function () { S.accId = null; boot(); }).catch(function (e) { alert(e.message); });
  }

  // —— 草稿操作（人工确认发送通道）——
  function sendDraft(id) { if (!confirm('确认发送这封草稿？')) return; call('drafts.send', { draftId: id }).then(reloadList).catch(function (e) { alert('发送失败：' + e.message); reloadList(true); }); }
  function discardDraft(id) { call('drafts.discard', { draftId: id }).then(reloadList).catch(function (e) { alert(e.message); }); }

  function pickAccount(id) { S.accId = id; S.folder = 'INBOX'; S.page = 1; call('folders.list', { accountId: id }).then(function (f) { S.folders = f; renderAccounts(); reloadList(); }); }
  function pickFolder(p) { S.folder = p; S.page = 1; renderAccounts(); reloadList(); }
  function turnPage(d) { S.page = Math.max(1, S.page + d); reloadList(); }

  function boot() {
    call('accounts.list').then(function (accs) {
      S.accounts = accs || [];
      if (!S.accId && S.accounts.length) { pickAccount(S.accounts[0].id); } else { renderAccounts(); }
    }).catch(function (e) { $('folders').innerHTML = '<p class="hint" style="padding:8px;color:var(--err)">' + esc(e.message) + '</p>'; });
  }

  send('ready').then(function (res) { applyTheme(res && res.result ? res.result : res); boot(); setInterval(function () { if (S.accId) reloadList(); }, 60000); });
</script>
</body>
</html>
```

（注意：`accounts.test` 直收表单输入——Task 9 `ROUTES['accounts.test']` 增补：`p.email` 匹配不到既有账号且带 `imap/smtp/password` 字段时，用表单参数临时探测（不落库、不写 secrets）；即「先测后存」。写在本 Step 一并落地 + 回归 service-index 测试补一用例。）

- [ ] **Step 4: 跑测试确认通过 + 手动走查**

Run: `npx vitest run tests/email/panel-static.test.ts tests/email/service-index.test.ts`
Expected: PASS

手动走查（dev 装载后，容器外 macOS 主机 `pnpm dev`）：插件设置 → 开发目录装载 `plugins/email` → 活动栏出现「邮件」页 → 空态提示 → 添加账号表单预设填充 →（有真码时）测试连接。

- [ ] **Step 5: Commit**

```bash
git add plugins/email/panel tests/email/panel-static.test.ts plugins/email/service/index.js tests/email/service-index.test.ts
git commit -m "feat(email): 邮件面板三栏 UI——账号管理/列表/阅读器/草稿箱 + accounts.test 先测后存"
```

### Task 14: 全链路集成冒烟 + 双仓全绿

**Files:**
- Test: `tests/email/dev-install.test.ts`（新建）

**Interfaces:**
- Consumes: 宿主 `installPluginDevDir` / `loadPluginToolModules` / `validatePanelsAtRoot` / `buildService`（本插件）；`tests/dev-install-probe.test.ts` 的隔离范式

- [ ] **Step 1: 写集成测试**（范式照抄 `tests/dev-install-probe.test.ts`：`AP_USER_DATA_DIR` 环境变量隔离宿主 userData + `HOST_READY` skipIf；不重复造轮子——先读该文件再写）

```ts
// tests/email/dev-install.test.ts
// dev 目录装载全链路：manifest/panel 校验 → 7 工具装配 → service 启动 → agents 落库
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { HOST_READY, hostImport } from '../host';
import { PLUGIN_ROOT, VENDOR_REAL } from './fixtures';

// （隔离与工作空间夹具：复制 dev-install-probe.test.ts 的 AP_USER_DATA_DIR + 临时工作区
//  setup/teardown——含 installPluginDevDir 所需 originWorkspaceId 的建库步骤）

describe.skipIf(!HOST_READY)('email dev 装载全链路', () => {
  beforeAll(() => { /* 同 dev-install-probe：设 AP_USER_DATA_DIR → 建库/工作区 */ });
  afterAll(() => { /* 清理：卸载插件 + 删临时 userData */ });

  it('installPluginDevDir 成功注册（manifest + panel 双校验过）', async () => {
    const { installPluginDevDir } = await hostImport('plugin/installer.ts') as never as {
      installPluginDevDir(dir: string, appVersion: string, wsId: string): { id: string };
    };
    const rec = installPluginDevDir(PLUGIN_ROOT, '9.9.9', wsId);
    expect(rec.id).toBe('email');
  });

  it('7 个工具模块全部装配（loadPluginToolModules 零 failures）', async () => {
    const { loadPluginToolModules } = await hostImport('agent/tools/plugin-tools.ts') as never as {
      loadPluginToolModules(refs: unknown[], log: (m: string, meta?: unknown) => void): {
        modules: Array<{ getDefs(): Array<{ name: string }> }>;
        failures: unknown[];
      };
    };
    const modulePaths = fs.readdirSync(path.join(PLUGIN_ROOT, 'tools'))
      .filter((f) => f.endsWith('.js'))
      .map((f) => path.join(PLUGIN_ROOT, 'tools', f));
    expect(modulePaths).toHaveLength(7);
    const r = loadPluginToolModules([{ pluginId: 'email', modulePaths, config: {}, dataDir: '/tmp/x' }], () => {});
    expect(r.failures).toEqual([]);
    const names = r.modules.flatMap((m) => m.getDefs().map((d) => d.name)).sort();
    expect(names).toEqual([
      'plugin:email/draft_mail', 'plugin:email/list_accounts', 'plugin:email/list_folders',
      'plugin:email/list_mails', 'plugin:email/read_mail', 'plugin:email/save_attachment',
      'plugin:email/send_draft',
    ]);
  });

  it.skipIf(!VENDOR_REAL)('createService 冒烟：start → 未知方法中文错误 → stop（真 vendor require 链）', async () => {
    const svc = require(path.join(PLUGIN_ROOT, 'service', 'index.js')).createService({
      getDataDir: () => fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'email-smoke-')),
      secrets: { get: async () => null, set: async () => {}, delete: async () => {} },
      logger: { info() {}, warn() {}, error() {} },
    });
    await svc.start();
    await expect(svc.handle('nope', {})).rejects.toThrow('未知方法');
    await svc.stop();
  });
});
```

- [ ] **Step 2: 跑测试**（vendor 已在位）

Run: `npx vitest run tests/email/dev-install.test.ts`
Expected: PASS（若 dev-install-probe 的 DB 隔离范式在此环境不可用——hostImport 阶段即抛——改用其同款 skipIf 守卫并在断言面保留工具装配用例）

- [ ] **Step 3: 双仓全绿**

Run（momo-plugin）: `npx vitest run`
Run（moo-studio 根）: `npx pnpm@9.0.0 typecheck && npx pnpm@9.0.0 --filter momo-studio-electron test`
Expected: 全绿（electron 全量若遇既有无关失败，记录并只保证 plugin/storage 目录与本计划改动相关用例绿）

- [ ] **Step 4: Commit**

```bash
git add tests/email/dev-install.test.ts
git commit -m "test(email): dev 装载全链路冒烟——manifest/工具装配/service/vendor require"
```

### Task 15: 真机验收 + README

**Files:**
- Create: `plugins/email/README.md`

- [ ] **Step 1: 写 README**

```markdown
# email 邮件插件（Momo Studio）

多邮箱收发助手：IMAP/SMTP 多账号 + 邮件面板（page 三栏）+ 7 个 agent 工具 + email-ops 技能 + 邮件助手预置 agent。设计 spec：moo-studio `docs/specs/2026-11-05-email-plugin-design.md`。

## 安装（开发流）

1. `cd vendor && npm install`（imapflow/nodemailer/mailparser，纯 JS 零 ABI）
2. Momo Studio → 设置 → 插件 → 开发目录装载 → 选本目录（`plugins/email`）
3. 资源库启用「邮件助手」agent（默认全局聊天模型）

## 使用

- **面板**：活动栏「邮件」页——添加账号（预设一键填充 + 测试连接）→ 收件箱/草稿/已发送
- **会话**：对邮件助手说「总结今天所有邮箱的新邮件」「给 xx@yy.com 回信说…」
- **发送门禁**：agent 只能起草；会话内展示全文并经你确认（或面板草稿箱手动点发送）才真发

## 验收记录（真邮箱）

| 场景 | 结果 | 日期 |
|---|---|---|
| QQ 邮箱添加（授权码）+ 测试连接 | ☐ | |
| 列表/读信/未读标记 | ☐ | |
| 会话摘要（多账号） | ☐ | |
| 起草 → 会话确认发送 → 面板 Sent 同步 | ☐ | |
| 附件：读邮件附件存工作区 / 发送带工作区附件 | ☐ | |
```

- [ ] **Step 2: 真机验收**（macOS 主机 `cd ~/dev/AiProject/moo-studio && pnpm dev`；加载 momo-acceptance skill 走 App 级验收，隔离 profile）

走查清单（全部通过后在 README 验收记录表打勾填日期）：
1. dev 装载 → 活动栏「邮件」页出现；无账号空态
2. QQ/163 真授权码添加账号 → 测试连接 ✓ → 列表秒开（缓存）→ 强制刷新增量
3. 读信：纯文本直显；HTML 邮件惰性 iframe（无脚本执行/无远程图片）
4. 会话：「总结今天的新邮件」→ 摘要含发件人分组 + 未读优先标注
5. 会话：「给 xx 回一封…」→ agent 展示全文征确认 → 回复「确认发送」→ 面板已发送出现该邮件
6. 面板草稿箱直接发送（不经会话）→ 同样落 Sent
7. 附件：让 agent 把某封邮件附件存工作区（变更账本可见）；起草带工作区附件并发送
8. 停用插件 → 面板消失、agent 工具不可用；卸载（keepData=false）→ keytar 凭据清空（钥匙串访问.app 验证 `plugin.email.secret.*`）

- [ ] **Step 3: Commit**

```bash
git add plugins/email/README.md
git commit -m "docs(email): README——安装/使用/验收记录"
```

---

## 计划自审记录

- **Spec 覆盖**：spec §2 目录（Task 4）、§3 secrets（Task 1-3）、§5 service 全方法目录（Task 5-9）、§6 七工具（Task 10-11）、§7 门禁三层（Task 7/11/12/13）、§8 panel（Task 13）、§9 skill/agent（Task 12）、§10 错误表（散布各任务测试）、§11 安全（Review Focus + 各守门）、§12 测试策略（各任务 + Task 14/15）、§13 交付边界（Phase 0/1 划分）——逐节对齐无缺口
- **占位符**：无 TBD/「稍后实现」；Task 14 Step 1 引用既有 dev-install-probe 范式属具体指针非占位
- **类型/签名一致性**：`drafts.save` 入参（account 整对象 + attachments[].data: Buffer）在 Task 7（定义）/Task 9（ROUTES base64 解码）/Task 11（工具侧组装）三处签名一致；`smtpSend(accountId, raw, envelope)` 同；`folders.list` 方法名在 Task 9（ROUTES）/Task 10（工具转发）一致
- **Review Focus**：五条全部绑定到具体任务的测试步骤（见节首映射）
