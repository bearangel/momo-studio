# 沙箱工具链安装授权 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 沙箱工具链写授权——默认 deny + 非阻塞会话 grant/设置双态放行工具链目录写入，配拦截提示层与引导卡，消灭 agent 即兴绕路。

**Architecture:** 复用修订 B 全链（设置态单点判定 + 子进程桥查询 + 结果签名检测 + 一次性引导卡），授权只扩「写目录集」一个维度；黑名单/敏感目录 deny/网络双态不动。

**Tech Stack:** Electron 主进程（CommonJS）+ seatbelt/bwrap profile 渲染 + React/zustand renderer + vitest。

**Spec:** `docs/specs/2026-10-01-sandbox-toolchain-grant.md`（执行者须同时阅读）

## Global Constraints

- 分支：`feat/sandbox-toolchain-grant` 自 **main** 切出（独立于 feat/multi-language-lsp；执行开始时停 dev app 再切分支——tsc watch 跟随工作树）
- Node 20（`nvm use 20`）；`npx pnpm@9.0.0`；TypeScript strict 禁 any/@ts-ignore；注释中文；Conventional Commits
- electron 测试集中 `tests/`（sandbox 域既有 `tests/sandbox/`）；renderer 贴源 colocated
- IPC 契约改动（Task 5/6）后双 workspace `npx pnpm@9.0.0 typecheck`
- 宿主 electron 全量基线预存失败 = 16（与 main 同集即过）；分片跑
- UI：语义 token only + lucide 16px/1.75（momo-ui-preview-rules：SandboxNotice 加卡与面板新区块按 spec 文案实现，形态随既有卡/区块，属 P2 豁免类——spec 已含逐字文案）
- 线协议铁律（boundary-rules）：net-trust-op 载荷**只加字段不改形状**（payload 加 `toolchainOn`、请求加 `workspaceId` 可选）；旧消费者/旧载荷必须兼容

## Review Focus

1. **非沙箱环境写失败不得触发提示/卡**（win-powershell / unsandboxed tag）→ Task 4 Step 1「非沙箱 tag 不触发」用例
2. **未授权时 profile 绝不包含工具链目录**（默认安全方向）→ Task 3 Step 1「未授权态零目录 + 授权态目录出现」双断言
3. **grant 按 workspace 键控**——A workspace 授权不波及 B → Task 2 Step 1「跨 workspace 隔离」用例
4. **默认 deny + 无 grant → toolchainOn 恒 false**（含旧载荷无 workspaceId 时 grant 按 false）→ Task 2 Step 1「默认态/旧载荷」用例
5. **提示层三条件缺一不可**（EPERM 无 HOME 特征不触发——workspace 内 EPERM 是别的问题，不得误导）→ Task 4 Step 1「条件组合矩阵」用例

---

### Task 1: 授权状态层（设置键 + grant 表 + 目录展开）

**Files:**
- Modify: `electron/src/main/settings/crud.ts`（GlobalSettings 加两可选键，读侧透传——**不写默认值进 JSON**，同 sandboxNetworkPolicy 注释纪律）
- Modify: `electron/src/main/sandbox/settings.ts`（SandboxSettings 扩展 + 默认值 + 懒迁移）
- Create: `electron/src/main/sandbox/toolchain-grant.ts`
- Test: `electron/tests/sandbox/toolchain-grant.test.ts`（新建）；`electron/tests/sandbox/settings.test.ts`（如无则新建贴源）

**Interfaces:**
- Produces:
  - `GlobalSettings.sandboxToolchainPolicy?: 'deny' | 'allow'`、`sandboxToolchainDirs?: string[]`（字面 `~/` 前缀存储）
  - `SandboxSettings { mode; networkPolicy; toolchainPolicy: 'deny'|'allow'; toolchainDirs: string[] }`（getSandboxSettings 返回，默认 `deny` + `DEFAULT_TOOLCHAIN_DIRS`）
  - `DEFAULT_TOOLCHAIN_DIRS: string[]`（导出，五项）
  - `grantToolchainWorkspace(workspaceId: string): void` / `hasToolchainGrant(workspaceId: string): boolean` / `__clearToolchainGrantsForTest(): void`（toolchain-grant.ts，内存 Map）
  - `expandToolchainDirs(raw: string[], home: string): string[]`（`~` 展开 + realpath 归一[失败 resolve 兜底] + 去重 + 过滤空行/空串；npm prefix 项特殊展开）

- [ ] **Step 1: 写失败测试**

```typescript
// electron/tests/sandbox/toolchain-grant.test.ts
// 授权状态层契约（spec §4）：grant 表 workspace 键控 + app 运行期语义（测试内
// 显式清理）；目录展开归一（~/ 前缀 / realpath / 去重 / npm prefix 特殊项）。
import { describe, it, expect, beforeEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import {
  grantToolchainWorkspace, hasToolchainGrant, __clearToolchainGrantsForTest,
  expandToolchainDirs, DEFAULT_TOOLCHAIN_DIRS,
} from '../../src/main/sandbox/toolchain-grant';

beforeEach(() => __clearToolchainGrantsForTest());

describe('grant 表', () => {
  it('默认无授权；置位后命中；workspace 键控隔离（A 授权不波及 B）', () => {
    expect(hasToolchainGrant('ws-a')).toBe(false);
    grantToolchainWorkspace('ws-a');
    expect(hasToolchainGrant('ws-a')).toBe(true);
    expect(hasToolchainGrant('ws-b')).toBe(false); // Review Focus 3
  });

  it('重复置位幂等', () => {
    grantToolchainWorkspace('ws-a');
    grantToolchainWorkspace('ws-a');
    expect(hasToolchainGrant('ws-a')).toBe(true);
  });
});

describe('expandToolchainDirs', () => {
  const home = os.homedir();
  it('~/ 前缀展开为绝对路径并去重', () => {
    const out = expandToolchainDirs(['~/.rustup', '~/.rustup', '~/.cargo'], home);
    expect(out).toHaveLength(2);
    expect(out.every((d) => path.isAbsolute(d))).toBe(true);
  });

  it('npm:<prefix> 特殊项经 npm prefix 探测展开（注入 fake 探测）', () => {
    // DEFAULT_TOOLCHAIN_DIRS 第四项存储为 'npm:global-prefix' 占位——
    // expandToolchainDirs 注入 fakeNpmPrefix 解析（生产缺省探测+缓存）
    const out = expandToolchainDirs(['npm:global-prefix'], home, { npmPrefix: '/fake/npm-global' });
    expect(out).toEqual(['/fake/npm-global']);
  });

  it('空串/空白行过滤；realpath 失败回退 path.resolve（不抛错）', () => {
    const out = expandToolchainDirs(['', '   ', '~/.not-exist-dir-xyz'], home);
    expect(out).toEqual([path.resolve(home, '.not-exist-dir-xyz')]);
  });

  it('DEFAULT_TOOLCHAIN_DIRS 预置五项（spec D3）', () => {
    expect(DEFAULT_TOOLCHAIN_DIRS).toEqual([
      '~/.rustup', '~/.cargo', '~/go', 'npm:global-prefix', 'pip:user',
    ]);
  });
});
```

（settings 扩展测试：`getSandboxSettings` 无键时返回 `toolchainPolicy: 'deny'` + 默认五项目录；kv 有 `sandboxToolchainPolicy: 'allow'` 与自定义 dirs 时透传——用 `__setSandboxSettingsForTest` 之外的 DB 路径测试按既有 settings.test 模式，若无 DB fixture 则该文件聚焦 toolchain-grant，settings 透传由 Task 2 的 effective 测试间接锁。实现者按仓库既有 `tests/sandbox/` 或 `tests/settings/` 测试形态落位。）

- [ ] **Step 2: 跑红**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/sandbox/toolchain-grant.test.ts
```

- [ ] **Step 3: 实现**

(a) `settings/crud.ts` GlobalSettings 接口加（跟随 sandboxNetworkPolicy 注释纪律——可选键、不写默认值进 JSON）：

```typescript
  /** 沙箱工具链目录写入策略（'deny' 默认 / 'allow' 永久允许）；读侧经 sandbox/settings.ts 懒迁移 */
  sandboxToolchainPolicy?: 'deny' | 'allow';
  /** 可授权写入的工具链目录清单（字面 ~/ 前缀 + 'npm:global-prefix'/'pip:user' 占位项） */
  sandboxToolchainDirs?: string[];
```

读侧 `parsed.sandboxToolchainPolicy` / `parsed.sandboxToolchainDirs` 透传（`?? undefined`）。

(b) `sandbox/settings.ts` 扩展：

```typescript
import { DEFAULT_TOOLCHAIN_DIRS } from './toolchain-grant';

export interface SandboxSettings {
  mode: SandboxMode;
  networkPolicy: NetworkPolicy;
  /** 工具链目录写入双态（本设计）：deny 默认 / allow 永久 */
  toolchainPolicy: 'deny' | 'allow';
  /** 可授权目录清单（字面形态，展开归一在消费侧 expandToolchainDirs） */
  toolchainDirs: string[];
}
```

`getSandboxSettings` 返回时：`toolchainPolicy: g.sandboxToolchainPolicy === 'allow' ? 'allow' : 'deny'`（非法值/缺省一律 deny——**默认安全方向**）；`toolchainDirs: Array.isArray(g.sandboxToolchainDirs) && g.sandboxToolchainDirs.length > 0 ? g.sandboxToolchainDirs : [...DEFAULT_TOOLCHAIN_DIRS]`。**不做懒迁移写回**（缺省 deny 即期望值，无需回写）。

(c) 新建 `toolchain-grant.ts`：

```typescript
// electron/src/main/sandbox/toolchain-grant.ts
// 会话 grant 表（spec §4）：「本会话允许」置位，app 运行期有效（重启自然失效）。
// 非阻塞——与已下线的阻塞 sessionGrants 不同物（修订 B 教训：阻塞等待必超时）。
// 目录展开：字面 ~/ 前缀 + npm/pip 占位项 → 归一绝对路径（realpath 优先，失败
// resolve 兜底——目录未创建时 allow 不存在路径无害）。
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** 预置默认五项（spec D3）。npm/pip 为占位项，展开时探测解析 */
export const DEFAULT_TOOLCHAIN_DIRS: string[] = [
  '~/.rustup', '~/.cargo', '~/go', 'npm:global-prefix', 'pip:user',
];

const grants = new Set<string>();

export function grantToolchainWorkspace(workspaceId: string): void {
  grants.add(workspaceId);
}

export function hasToolchainGrant(workspaceId: string): boolean {
  return grants.has(workspaceId);
}

export function __clearToolchainGrantsForTest(): void {
  grants.clear();
}

/** npm 全局 prefix 探测（同步、模块级缓存一次） */
let npmPrefixCache: string | null | undefined;
function resolveNpmPrefix(): string | null {
  if (npmPrefixCache !== undefined) return npmPrefixCache;
  try {
    npmPrefixCache = execSync('npm prefix -g', { encoding: 'utf-8', timeout: 10_000 }).trim() || null;
  } catch {
    npmPrefixCache = null; // npm 不可用：占位项静默跳过
  }
  return npmPrefixCache;
}

/** pip --user base 目录推导（~/Library/Python/X.Y 或 ~/.local——平台分支） */
function resolvePipUser(home: string): string {
  return process.platform === 'darwin'
    ? path.join(home, 'Library', 'Python') // 版本号目录的父目录（宽匹配）
    : path.join(home, '.local');
}

function realpathOrResolve(p: string): string {
  try { return fs.realpathSync(p); } catch { return path.resolve(p); }
}

export function expandToolchainDirs(
  raw: string[],
  home: string,
  opts?: { npmPrefix?: string },
): string[] {
  const out: string[] = [];
  for (const item of raw) {
    const s = item.trim();
    if (s === '') continue;
    let abs: string | null = null;
    if (s === 'npm:global-prefix') {
      abs = opts?.npmPrefix ?? resolveNpmPrefix();
    } else if (s === 'pip:user') {
      abs = resolvePipUser(home);
    } else if (s === '~') {
      abs = home;
    } else if (s.startsWith('~/')) {
      abs = path.join(home, s.slice(2));
    } else {
      abs = s; // 用户清单里的绝对路径原样
    }
    if (abs === null || abs === '') continue;
    const norm = realpathOrResolve(abs);
    if (!out.includes(norm)) out.push(norm);
  }
  return out;
}
```

- [ ] **Step 4: 跑绿 + typecheck**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/sandbox/
npx pnpm@9.0.0 typecheck
```

- [ ] **Step 5: Commit**

```bash
git add electron/src/main/sandbox/ electron/src/main/settings/crud.ts electron/tests/sandbox/
git commit -m "feat: 工具链授权状态层（设置双键 + 会话 grant 表 + 目录展开）"
```

---

### Task 2: effective op 双字段（主进程对端）

**Files:**
- Modify: `electron/src/main/sandbox/network-trust.ts`
- Test: `electron/tests/sandbox/network-trust.test.ts`（扩展）

**Interfaces:**
- Consumes: `getSandboxSettings()`（Task 1 扩展后含 toolchain 字段）、`hasToolchainGrant`（Task 1）
- Produces: effective op 载荷 `{ netOn: boolean; toolchainOn: boolean }`；请求载荷新增可选 `workspaceId?: string`（缺省 grant 按 false——向后兼容）

- [ ] **Step 1: 写失败测试（扩展 tests/sandbox/network-trust.test.ts）**

```typescript
// 追加 describe（沿用该文件既有 import 与 harness 形态）
describe('effective op 工具链双字段（spec §6）', () => {
  it('默认 deny 且无 grant → toolchainOn=false', async () => {
    __setSandboxSettingsForTest({ mode: 'strict', networkPolicy: 'allow', toolchainPolicy: 'deny', toolchainDirs: [...] });
    __clearToolchainGrantsForTest();
    const r = await handleNetTrustOp({ type: 'net-trust-op', requestId: 'r1', op: 'effective', streamSessionId: 's1', workspaceId: 'ws-a' });
    expect(r).toEqual({ ok: true, payload: { netOn: true, toolchainOn: false } }); // Review Focus 4
  });

  it('会话 grant 置位 → toolchainOn=true；跨 workspace 隔离', async () => {
    grantToolchainWorkspace('ws-a');
    const r = await handleNetTrustOp({ ..., workspaceId: 'ws-a' });
    expect(r.ok && r.payload.toolchainOn).toBe(true);
    const r2 = await handleNetTrustOp({ ..., requestId: 'r2', workspaceId: 'ws-b' });
    expect(r2.ok && r2.payload.toolchainOn).toBe(false); // Review Focus 3
  });

  it('policy=allow → 无 grant 也 true（永久开）', async () => {
    __setSandboxSettingsForTest({ ..., toolchainPolicy: 'allow', ... });
    const r = await handleNetTrustOp({ ..., workspaceId: 'ws-x' });
    expect(r.ok && r.payload.toolchainOn).toBe(true);
  });

  it('旧载荷（无 workspaceId）→ grant 按 false 兼容', async () => {
    grantToolchainWorkspace('ws-a');
    const r = await handleNetTrustOp({ type: 'net-trust-op', requestId: 'r3', op: 'effective', streamSessionId: 's1' });
    expect(r.ok && r.payload.toolchainOn).toBe(false); // Review Focus 4 兼容
  });
});
```

（`...` 处按既有用例的字段全量补齐——`__setSandboxSettingsForTest` 新增两字段后既有用例的注入对象需同步补字段，TS 会指出每一处。）

- [ ] **Step 2: 跑红 → Step 3: 实现**

`network-trust.ts` 修改：

```typescript
// NetTrustOpMsg 加可选字段：workspaceId?: string（grant 按 workspace 键控）
// handleNetTrustOp 的 effective 分支改为：
    const settings = getSandboxSettings();
    const netOn = settings.networkPolicy === 'allow';
    // 工具链写授权（spec §4 单点判定）：永久开 || 会话 grant（旧载荷无 workspaceId 按 false）
    const toolchainOn =
      settings.toolchainPolicy === 'allow' ||
      (parsed.workspaceId !== undefined && hasToolchainGrant(parsed.workspaceId));
    return { ok: true, payload: { netOn, toolchainOn } };
```

（`NetTrustOpResult` 的 payload 类型改为 `{ netOn: boolean; toolchainOn: boolean }`；import hasToolchainGrant。）

- [ ] **Step 4: 跑绿 + Commit**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/sandbox/network-trust.test.ts
git add electron/src/main/sandbox/network-trust.ts electron/tests/sandbox/network-trust.test.ts
git commit -m "feat: effective op 扩展工具链授权双字段（向后兼容）"
```

---

### Task 3: policy + 双平台 profile + resolveShellSpawn

**Files:**
- Modify: `electron/src/main/sandbox/types.ts`（ShellSandboxPolicy 加 `toolchainDirs: string[]`）
- Modify: `electron/src/main/sandbox/policy.ts`（buildPolicy 第三参，缺省 `[]`）
- Modify: `electron/src/main/sandbox/macos.ts`（allow file-write* 追加）
- Modify: `electron/src/main/sandbox/linux.ts`（--bind 追加）
- Modify: `electron/src/main/sandbox/index.ts`（resolveShellSpawn opts.toolchainEnabled）
- Test: `tests/sandbox/macos.test.ts`、`tests/sandbox/linux.test.ts`、`tests/sandbox/resolve-spawn.test.ts`（均扩展）

**Interfaces:**
- Consumes: `getSandboxSettings().toolchainDirs`、`expandToolchainDirs`（Task 1）
- Produces: `buildPolicy(workspaceDir, networkEnabled, toolchainDirs?: string[])`；`resolveShellSpawn(workspaceDir, command, opts?: { networkEnabled?; toolchainEnabled? })`

- [ ] **Step 1: 写失败测试（三文件扩展，各追加用例）**

```typescript
// macos.test.ts 追加：
it('授权态：工具链目录逐个出现在 allow file-write*，deny default 语义不变', () => {
  const p = { workspaceDir: '/ws', homeDir: '/Users/u', tmpDir: '/tmp', sensitiveDirs: ['/Users/u/.ssh'], networkEnabled: true, toolchainDirs: ['/Users/u/.rustup', '/Users/u/.cargo'] };
  const prof = renderSeatbeltProfile(p);
  expect(prof).toContain('(allow file-write* (subpath "/Users/u/.rustup"))');
  expect(prof).toContain('(allow file-write* (subpath "/Users/u/.cargo"))');
  expect(prof).toContain('(deny file-read* (subpath "/Users/u/.ssh"))'); // 敏感 deny 不受影响
});
it('未授权（空数组）：profile 无任何工具链目录行', () => {
  const p = { ..., toolchainDirs: [] };
  expect(renderSeatbeltProfile(p)).not.toContain('.rustup'); // Review Focus 2
});

// linux.test.ts 追加：
it('授权态：每目录追加 --bind <dir> <dir>；未授权零追加', () => {
  const base = buildBwrapArgs({ ..., toolchainDirs: ['/home/u/.rustup'] });
  expect(base).toContain('--bind'); expect(base).toContain('/home/u/.rustup');
  const none = buildBwrapArgs({ ..., toolchainDirs: [] });
  expect(none.filter((a) => a === '/home/u/.rustup')).toHaveLength(0);
});

// resolve-spawn.test.ts 追加：
it('opts.toolchainEnabled=true 时 policy.toolchainDirs 来自设置清单展开（expandToolchainDirs 归一）', () => {
  __setSandboxSettingsForTest({ mode: 'strict', networkPolicy: 'allow', toolchainPolicy: 'deny', toolchainDirs: ['~/.rustup'] });
  __setSandboxStateForTest({ platform: 'darwin', sandboxTool: 'seatbelt', toolVersion: null, available: true, unavailableReason: null, windowsShell: null, executionPolicy: null, probedAt: Date.now() });
  const plan = resolveShellSpawn('/ws', 'rustup component add x', { networkEnabled: true, toolchainEnabled: true });
  // plan.kind === 'wrapped' 时读 profile 文件内容断言含归一后的 .rustup 路径
  if (plan.kind === 'wrapped') {
    const prof = fs.readFileSync(plan.args[plan.args.indexOf('-f') + 1], 'utf-8');
    expect(prof).toContain('.rustup');
  }
  expect(plan.kind).toBe('wrapped');
});
it('未传 toolchainEnabled（既有调用方）→ 行为与旧版一致（目录集空）', () => {
  const plan = resolveShellSpawn('/ws', 'ls', {});
  // tag 仍为 seatbelt/net-on；不抛错（向后兼容）
  expect(plan.kind).toBe('wrapped');
});
```

（`...` 按各测试文件既有 mkPolicy/mkState helper 的实际形态补全。）

- [ ] **Step 2: 跑红 → Step 3: 实现**

(a) `types.ts` ShellSandboxPolicy 加 `toolchainDirs: string[];`（注释：授权态非空；归一绝对路径）。
(b) `policy.ts`：

```typescript
export function buildPolicy(workspaceDir: string, networkEnabled: boolean, toolchainDirs: string[] = []): ShellSandboxPolicy {
  // ...既有内容，返回对象加：
    toolchainDirs: [...new Set(toolchainDirs)],
```

(c) `macos.ts` renderSeatbeltProfile 在 workspace 写 allow 行后追加：

```typescript
  // 工具链目录授权（spec §9）：每目录单独 allow；deny default 与 sensitiveDirs
  // deny 的后置覆盖语义不变——授权只扩写维度
  const toolchainRules = policy.toolchainDirs
    .map((d) => `(allow file-write* (subpath ${escapeSeatbeltString(d)}))`)
    .join('\n');
```

模板中 `${toolchainRules}` 插在网络规则前。
(d) `linux.ts` buildBwrapArgs：workspace `--bind` 之后对每目录追加 `'--bind', d, d`（形态随该文件既有 args 组装）。
(e) `index.ts` resolveShellSpawn：

```typescript
  const networkEnabled = opts?.networkEnabled ?? (settings.networkPolicy === 'allow');
  const toolchainDirs = opts?.toolchainEnabled
    ? expandToolchainDirs(settings.toolchainDirs, os.homedir())
    : [];
  const policy = buildPolicy(workspaceDir, networkEnabled, toolchainDirs);
```

- [ ] **Step 4: 跑绿（tests/sandbox/ 全目录 + 既有回归）+ typecheck → Step 5: Commit**

```bash
git add electron/src/main/sandbox/ electron/tests/sandbox/
git commit -m "feat: 沙箱 profile 支持工具链目录写授权（seatbelt/bwrap 双平台）"
```

---

### Task 4: 拦截提示层 + shell-tools 接线

**Files:**
- Create: `electron/src/main/agent/tools/sandbox-write-hint.ts`
- Modify: `electron/src/main/agent/tools/shell-tools.ts`（execute 内：effective 查询传 workspaceId + plan opts 加 toolchainEnabled + 结果尾部提示）
- Modify: `electron/src/main/agent/tools/net-trust-bridge.ts`（payload 加 workspaceId；EffectiveNetworkDecision 加 toolchainOn）
- Test: `electron/tests/agent/tools/sandbox-write-hint.test.ts`（新建）；`tests/agent/tools/shell-net-trust.test.ts`、`tests/agent/tools/shell-tools.test.ts`（扩展）

**Interfaces:**
- Consumes: Task 2/3 产出（effective 双字段、resolveShellSpawn opts）
- Produces: `detectHomeWriteBlocked(tag: string, command: string, stderr: string): boolean`；`WRITE_BLOCKED_HINT: string`（固定提示段，逐字锁）

- [ ] **Step 1: 写失败测试**

```typescript
// electron/tests/agent/tools/sandbox-write-hint.test.ts
// 提示层三条件矩阵（spec §7）：沙箱 tag × 写拒绝签名 × HOME 特征——缺一不触发。
import { describe, it, expect } from 'vitest';
import { detectHomeWriteBlocked, WRITE_BLOCKED_HINT } from '../../../src/main/agent/tools/sandbox-write-hint';

const EPERM_STDERR = 'error: could not write to /Users/u/.rustup: Operation not permitted';

describe('detectHomeWriteBlocked 三条件矩阵', () => {
  it('全命中 → true（seatbelt tag + EPERM + ~/.rustup 命令特征）', () => {
    expect(detectHomeWriteBlocked('seatbelt/net-on', 'rustup component add rust-analyzer', EPERM_STDERR)).toBe(true);
  });
  it('非沙箱 tag（win-powershell / unsandboxed）→ 永不触发（Review Focus 1）', () => {
    expect(detectHomeWriteBlocked('win-powershell', 'npm install -g x', EPERM_STDERR)).toBe(false);
    expect(detectHomeWriteBlocked('unsandboxed:reason', 'npm i -g', EPERM_STDERR)).toBe(false);
  });
  it('EPERM 但无 HOME 特征（workspace 内权限问题）→ 不触发（Review Focus 5）', () => {
    expect(detectHomeWriteBlocked('seatbelt/net-on', 'cargo build', 'error: EPERM on /ws/target')).toBe(false);
  });
  it('HOME 特征但无写拒绝签名 → 不触发', () => {
    expect(detectHomeWriteBlocked('seatbelt/net-on', 'ls ~/.rustup', 'no such directory')).toBe(false);
  });
  it('stderr 里的 HOME 展开路径也算特征（$HOME 未展开形态）', () => {
    expect(detectHomeWriteBlocked('bwrap/net-on', 'echo hi', 'cp: /Users/u/.cargo/bin/x: Permission denied')).toBe(true);
  });
  it('WRITE_BLOCKED_HINT 逐字锁定（renderer 检测依赖固定子串）', () => {
    expect(WRITE_BLOCKED_HINT).toContain('非工作空间路径写入被沙箱拦截');
    expect(WRITE_BLOCKED_HINT).toContain('不要尝试下载到临时目录');
  });
});
```

- [ ] **Step 2: 跑红 → Step 3: 实现**

(a) 新建 `sandbox-write-hint.ts`：

```typescript
// electron/src/main/agent/tools/sandbox-write-hint.ts
// 沙箱 HOME 写拦截提示层（spec §7）：三条件（沙箱 tag × 写拒绝签名 × HOME 路径
// 特征）全命中时，bash 结果尾部追加固定提示——同时服务 LLM（知道该请求用户而非
// 绕路——2026-10-01 两起实证：.momo-scratch 本装与 /tmp 下载）与 renderer
// stream.store（固定子串检测置引导卡）。
const WRITE_DENY_SIGNATURES: readonly RegExp[] = [
  /EPERM/i,
  /Operation not permitted/i,
  /Permission denied/i,
  /Read-only file system/i,
];
const HOME_FEATURE = /(?:~\/|\$HOME\b|\/Users\/|\/home\/)/;

export function detectHomeWriteBlocked(tag: string, command: string, stderr: string): boolean {
  const sandboxed = /^(?:seatbelt|bwrap)\//.test(tag);
  if (!sandboxed) return false;
  const writeDenied = WRITE_DENY_SIGNATURES.some((re) => re.test(stderr));
  if (!writeDenied) return false;
  return HOME_FEATURE.test(command) || HOME_FEATURE.test(stderr);
}

export const WRITE_BLOCKED_HINT =
  '⚠ 非工作空间路径写入被沙箱拦截。若这是工具链/依赖的安装步骤：请让用户点击会话中的引导卡授权（本会话有效），或请用户在终端自行执行；用户操作后重试同一命令即可。不要尝试下载到临时目录或工作区缓存绕过——那对系统工具注册不可见。';
```

(b) `net-trust-bridge.ts`：`EffectiveNetworkDecision` 加 `toolchainOn: boolean`；`requestEffectiveNetwork(streamSessionId: string, workspaceId?: string)`；`sendNetTrustOp` payload 加 `workspaceId`（undefined 时省略——JSON 序列化自然丢键，主进程按旧载荷处理）。

(c) `shell-tools.ts` execute 三处：

```typescript
    // effective 查询带上 workspaceId（工具链 grant 键控；旧签名兼容）
    net = await requestEffectiveNetwork(ctx.streamSessionId, ctx.workspaceId);
    ...
    const plan = resolveShellSpawn(
      ctx.workspaceDir,
      command,
      {
        networkEnabled: net === null ? undefined : net.netOn,
        toolchainEnabled: net === null ? undefined : net.toolchainOn, // 新增
      },
    );
```

结果组装处（close 回调 parts 拼接前）：

```typescript
          // HOME 写拦截提示（spec §7）：三条件命中才追加，同服 LLM 与 renderer
          if (detectHomeWriteBlocked(plan.tag, command, stderr)) {
            parts.push(WRITE_BLOCKED_HINT);
          }
```

（`shell-net-trust.test.ts` 既有断言的 payload 形状需同步加 toolchainOn 字段；`shell-tools.test.ts` 补一条：stderr 含 EPERM + 命令含 `~/` + plan mock tag seatbelt → 结果含提示子串——该文件既有 runBashToCompletion 真跑模式可复用。）

- [ ] **Step 4: 跑绿（sandbox-write-hint + shell 两个测试文件 + tests/sandbox/ 回归）+ typecheck → Step 5: Commit**

```bash
git add electron/src/main/agent/tools/ electron/tests/
git commit -m "feat: bash 结果 HOME 写拦截提示层 + effective 双态接线"
```

---

### Task 5: 主进程 sandbox IPC 扩展 + renderer 契约

**Files:**
- Modify: `electron/src/main/sandbox/ipc.handlers.ts`
- Modify: `renderer/src/ipc/types.d.ts` + `electron/src/preload/index.ts`
- Test: `electron/tests/sandbox/ipc-handlers.test.ts`（新建或扩展既有）

**Interfaces:**
- Consumes: `grantToolchainWorkspace`（Task 1）、`getSandboxSettings` 扩展（Task 1）
- Produces:
  - invoke `sandbox:grantToolchain(workspaceId: string): Promise<void>`
  - `SandboxInfo.settings` 加 `{ toolchainPolicy; toolchainDirs }`；`SandboxInfo.toolchainPromptDismissed: boolean`
  - `dismissPrompt(kind)` 联合类型加 `'toolchain'`
  - renderer types.d.ts 镜像（含 `ToolchainPolicy = 'deny' | 'allow'`）

- [ ] **Step 1: 写失败测试**

```typescript
// tests/sandbox/ipc-handlers.test.ts（若无既有文件则新建；DB fixture 按 tests/sandbox 其他文件形态）
import { describe, it, expect } from 'vitest';
// 该文件聚焦可单测的纯逻辑；ipcMain.handle 注册形态以 typecheck + renderer 侧集成测试兜底
import { buildInfo, KV_TOOLCHAIN } from '../../src/main/sandbox/ipc.handlers';

describe('SandboxInfo 扩展（spec §10）', () => {
  it('buildInfo 含 toolchainPromptDismissed 与 settings 两新字段', () => {
    const info = buildInfo();
    expect(info).toHaveProperty('toolchainPromptDismissed');
    expect(info.settings).toHaveProperty('toolchainPolicy');
    expect(info.settings).toHaveProperty('toolchainDirs');
  });
});
```

（KV_TOOLCHAIN 需导出供测试。grantToolchain invoke 的 grant 表副作用在 Task 1 已锁，此处注册形态随 registerSandboxIpc 既有三 handler 同型。）

- [ ] **Step 2: 跑红 → Step 3: 实现**

`ipc.handlers.ts`：

```typescript
const KV_TOOLCHAIN = 'sandbox_toolchain_prompt_dismissed';
// SandboxInfo 加：
  /** 工具链写拦截引导卡是否已关闭 */
  toolchainPromptDismissed: boolean;
// buildInfo() settings 行天然含新字段（getSandboxSettings 已扩展）+ readKvFlag(KV_TOOLCHAIN)
// registerSandboxIpc 加：
  ipcMain.handle('sandbox:grantToolchain', (_e, workspaceId: string) => {
    if (typeof workspaceId !== 'string' || workspaceId === '') throw new Error('workspaceId 缺失');
    grantToolchainWorkspace(workspaceId);
    // 同步置一次性 flag（用户已行动，卡不再弹）
    getDb().prepare(`INSERT INTO kv_store (key, value, updated_at) VALUES (?, '1', datetime('now'))
      ON CONFLICT(key) DO UPDATE SET value = '1', updated_at = datetime('now')`).run(KV_TOOLCHAIN);
    logger.info('工具链写授权已授予（本会话）', { workspaceId });
  });
// dismissPrompt kind 联合加 'toolchain' → 映射 KV_TOOLCHAIN（既有三元改为查表）
```

（dismissPrompt 的 kind 映射改为 `Record<string, string>` 查表：`{ bwrap: KV_BWRAP, winPolicy: KV_WINPOLICY, netOff: KV_NETOFF, toolchain: KV_TOOLCHAIN }`。）

renderer `types.d.ts`：`SandboxInfo` 加 `toolchainPromptDismissed: boolean`、settings 加两字段；`SandboxApiSurface` 加 `grantToolchain(workspaceId: string): Promise<void>`；`dismissPrompt` kind 加 `'toolchain'`；导出 `export type ToolchainPolicy = 'deny' | 'allow';`。preload `sandbox` 组加 `grantToolchain: (workspaceId: string) => invoke('sandbox:grantToolchain', workspaceId)`。

- [ ] **Step 4: 跑绿 + 双 workspace typecheck → Step 5: Commit**

```bash
git add electron/src/main/sandbox/ipc.handlers.ts electron/src/preload/index.ts renderer/src/ipc/types.d.ts electron/tests/sandbox/
git commit -m "feat: sandbox IPC 授权通道（grantToolchain）与卡 flag 扩展"
```

---

### Task 6: renderer 检测 + 引导卡

**Files:**
- Modify: `renderer/src/stores/stream.store.ts`（toolchainWriteBlockedSeen 检测 + 置位）
- Modify: `renderer/src/components/settings/SandboxNotice.tsx`（第四卡）
- Test: `renderer/src/stores/stream.store.test.ts`（若无则新建贴源）；`renderer/src/components/settings/SandboxNotice.test.tsx`（扩展）

**Interfaces:**
- Consumes: `WRITE_BLOCKED_HINT` 固定子串「非工作空间路径写入被沙箱拦截」（Task 4——renderer 侧硬编码同一子串常量，两端测试逐字锁）；`ipc.sandbox.grantToolchain`（Task 5）
- Produces: `useStreamStore` 加 `toolchainWriteBlockedSeen: boolean` + `markToolchainWriteBlockedSeen: () => void`

- [ ] **Step 1: 写失败测试**

```typescript
// stream.store.test.ts（贴源新建或扩展）
import { describe, it, expect } from 'vitest';
import { useStreamStore } from './stream.store';
import type { MessageEventRow } from '../ipc/types';

function toolResultEvent(result: string): MessageEventRow {
  return { id: 'e1', messageId: 'm1', seq: 1, eventType: 'tool_call_result', payload: { result }, createdAt: Date.now() } as MessageEventRow;
}

describe('工具链写拦截检测（spec §7/§8）', () => {
  it('结果含固定子串 → toolchainWriteBlockedSeen 置位（一次性）', () => {
    useStreamStore.getState().reset();
    useStreamStore.getState().applyEventBatch([
      toolResultEvent('exit_code: 1\nsandbox: seatbelt/net-on\nstderr:\nEPERM ...\n⚠ 非工作空间路径写入被沙箱拦截。若这是工具链/依赖的安装步骤：...'),
    ]);
    expect(useStreamStore.getState().toolchainWriteBlockedSeen).toBe(true);
  });

  it('普通 bash 结果不置位', () => {
    useStreamStore.getState().reset();
    useStreamStore.getState().applyEventBatch([toolResultEvent('exit_code: 0\n(无输出)')]);
    expect(useStreamStore.getState().toolchainWriteBlockedSeen).toBe(false);
  });
});
```

`SandboxNotice.test.tsx` 扩展（沿用既有 mock 形态）：

```typescript
it('工具链卡：检测标志 + 未 dismiss + deny 策略 → 渲染；「本会话允许」调 grantToolchain(activeWorkspaceId) 并 dismiss', async () => {
  // mock ipc.sandbox.getState 返回 { ..., settings: { mode:'strict', networkPolicy:'allow', toolchainPolicy:'deny', toolchainDirs:[...] }, toolchainPromptDismissed:false }
  // mock workspace store active workspace id 'ws-1'；mock ipc.sandbox.grantToolchain resolved
  // 置 useStreamStore markToolchainWriteBlockedSeen()
  render(<SandboxNotice />);
  expect(screen.getByText(/工具链目录/)).toBeTruthy();
  await userEvent.click(screen.getByRole('button', { name: '本会话允许' }));
  await waitFor(() => expect(ipc.sandbox.grantToolchain).toHaveBeenCalledWith('ws-1'));
});
it('toolchainPromptDismissed=true → 不渲染', () => { /* 同型 */ });
```

- [ ] **Step 2: 跑红 → Step 3: 实现**

(a) `stream.store.ts`：

```typescript
/** 工具链写拦截固定子串（与 electron 侧 WRITE_BLOCKED_HINT 同源逐字——两端测试各自锁） */
const TOOLCHAIN_WRITE_BLOCKED_SNIPPET = '非工作空间路径写入被沙箱拦截';
// applyEventBatch 内 netBlocked 检测旁并列：
    const toolchainBlocked = batch.some(
      (e) =>
        e.eventType === 'tool_call_result' &&
        typeof e.payload.result === 'string' &&
        e.payload.result.includes(TOOLCHAIN_WRITE_BLOCKED_SNIPPET),
    );
// set 返回对象并列：...(toolchainBlocked ? { toolchainWriteBlockedSeen: true } : {})
// state/接口加 toolchainWriteBlockedSeen: boolean（初始 false，reset 不清——同一一次性语义）
// markToolchainWriteBlockedSeen 与 markNetBlockedSeen 同型
```

(b) `SandboxNotice.tsx` 第四卡（显隐条件与优先级——netOff 最优先既有，工具链条目排其后、bwrap/winPolicy 之前）：

```tsx
  const toolchainWriteBlockedSeen = useStreamStore((s) => s.toolchainWriteBlockedSeen);
  // workspace 上下文：active workspace id（workspace.store 既有选择器，实现时按实际 selector 名对齐）
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const showToolchain =
    !showNetOff &&
    toolchainWriteBlockedSeen &&
    !info.toolchainPromptDismissed &&
    info.settings.toolchainPolicy === 'deny';
  // 主体分支（showToolchain 时渲染）：
  //   标题「agent 需要写入工具链目录」
  //   说明：「bash 的工具链/依赖安装（如 rustup、npm -g）被沙箱拦截。可本会话放行（仅清单内目录），或到设置永久开启。」
  //   动作：「去设置」（ghost，setActiveView('settings')）+「本会话允许」（primary）：
  const grantNow = async (): Promise<void> => {
    if (!activeWorkspaceId) return;
    await ipc.sandbox.grantToolchain(activeWorkspaceId);
    setInfo({ ...info, toolchainPromptDismissed: true });
  };
```

- [ ] **Step 4: 跑绿 + renderer 全量 + 双 typecheck → Step 5: Commit**

```bash
git add renderer/src electron/src/preload/index.ts
git commit -m "feat: 工具链写拦截检测与引导卡（本会话允许/去设置）"
```

---

### Task 7: 设置面板扩展

**Files:**
- Modify: `renderer/src/components/settings/SandboxSettingsPanel.tsx`
- Test: `renderer/src/components/settings/SandboxSettingsPanel.test.tsx`（扩展）

**Interfaces:**
- Consumes: `ipc.settings.updateGlobal`（既有）、`SandboxInfo.settings.toolchainPolicy/toolchainDirs`（Task 5）
- Produces: 无（叶子）

- [ ] **Step 1: 写失败测试（扩展既有文件）**

```typescript
it('工具链双态 radio：deny 默认渲染；点击 allow 保存 updateGlobal({ sandboxToolchainPolicy: "allow" })', async () => {
  // mock getState 返回含 toolchainPolicy:'deny'；点击 allow label → 断言 updateGlobal 调参
});
it('目录清单 textarea：初值为设置清单每行一项；编辑后保存；恢复默认按钮写回 DEFAULT 五项', async () => {
  // mock toolchainDirs: ['~/.rustup']；断言 textarea 初值 "~/.rustup"
  // 改为 "~/.rustup\n~/extra" 触发保存（失焦或按钮——实现用显式「保存清单」按钮，断言 updateGlobal({ sandboxToolchainDirs: [...] })）
  // 点「恢复默认」→ updateGlobal({ sandboxToolchainDirs: ['~/.rustup','~/.cargo','~/go','npm:global-prefix','pip:user'] })
});
```

- [ ] **Step 2: 跑红 → Step 3: 实现**

`SandboxSettingsPanel.tsx` 网络出站区块后追加两个 fieldset（复用既有 save 乐观更新模式）：

```tsx
      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium text-primary">工具链目录写入</legend>
        {TOOLCHAIN_POLICY_OPTIONS.map((o) => (
          <label key={o.value} className="flex items-start gap-2 text-sm text-secondary">
            <input type="radio" name="sandbox-toolchain-policy" checked={info.settings.toolchainPolicy === o.value}
              onChange={() => save({ sandboxToolchainPolicy: o.value } as never)}
              className="mt-1" aria-label={o.label} />
            <span>{o.label}——{o.hint}</span>
          </label>
        ))}
        <p className="text-xs text-tertiary">仅影响清单内目录；拦截时会话引导卡可临时授权。</p>
      </fieldset>

      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium text-primary">工具链目录清单</legend>
        <textarea
          aria-label="工具链目录清单"
          className="w-full min-h-24 rounded-md border border-subtle bg-surface-1 p-2 font-mono text-xs text-secondary"
          value={dirsText}
          onChange={(e) => setDirsText(e.target.value)}
        />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={resetDirs}>恢复默认</Button>
          <Button size="sm" onClick={() => void saveDirs()}>保存清单</Button>
        </div>
        <p className="text-xs text-tertiary">每行一个路径；支持 ~ 前缀；npm:global-prefix / pip:user 为自动探测项。</p>
      </fieldset>
```

（`TOOLCHAIN_POLICY_OPTIONS`：deny「拦截（默认）——沙箱内不可写工具链目录」/ allow「永久允许——清单内目录可写」；`dirsText` state 初值 = `info.settings.toolchainDirs.join('\n')`，info 刷新时同步；saveDirs → `updateGlobal({ sandboxToolchainDirs: dirsText.split('\n').map(s=>s.trim()).filter(Boolean) })`；resetDirs → 设回五项默认并保存。`save` 扩展接受 toolchain patch——类型按 updateGlobal 的 Partial<GlobalSettings> 镜像契约。）

- [ ] **Step 4: 跑绿 + renderer 全量 + 双 typecheck → Step 5: Commit**

```bash
git add renderer/src/components/settings/
git commit -m "feat: 沙箱设置面板工具链双态与目录清单编辑"
```

---

### Task 8: 全局验证 + 手动验收清单 + 账本

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: 全局验证**

```bash
npx pnpm@9.0.0 typecheck
cd electron && npx pnpm@9.0.0 vitest run tests/sandbox/ tests/agent/tools/shell-net-trust.test.ts tests/agent/tools/shell-tools.test.ts tests/agent/tools/sandbox-write-hint.test.ts
cd renderer && npx pnpm@9.0.0 vitest run src/
grep -rn "WRITE_BLOCKED_HINT\|非工作空间路径写入被沙箱拦截" electron/src renderer/src --include='*.ts' --include='*.tsx' | wc -l
```

预期：typecheck 双过；测试零新增失败（基线 16 口径）；grep ≥ 3（electron 常量 + shell-tools 引用 + renderer 子串）。

- [ ] **Step 2: 手动验收（控制器移交用户，子代理不执行 GUI）**

1. 终端先删组件模拟场景：`rustup component remove rust-analyzer`（若已装）
2. dev 模式新会话：「lsp 检查 hello_world」→ agent 跑 `rustup component add` → 结果尾部出现「⚠ 非工作空间路径写入被沙箱拦截…」且 agent 转而请求授权（不绕路 /tmp）
3. 会话出现引导卡 → 点「本会话允许」→ 告知 agent 已授权 → 重试成功
4. LSP 面板 rust-analyzer 转正 → `lsp_diagnostics` 实调成功（闭环 2026-10-01 Rust 会话之坑）
5. 设置→安全沙箱：新双态 radio + 目录清单可见；改 allow 后无卡场景验证
6. 重启 app → grant 失效（deny 回默认）——「本会话」语义验证

- [ ] **Step 3: CHANGELOG 条目（2.1.0-alpha 小节追加，不动版本号）**

```markdown
- **沙箱工具链安装授权**：bash 工具链/依赖全局安装（rustup / npm -g / go install / pip --user）遇沙箱写拦截时给出结构化提示并弹一次性引导卡——「本会话允许」grant 或设置页永久 allow（双态 + 可编辑目录清单，预置五项）；授权仅扩写目录集维度（seatbelt/bwrap profile 追加 allow），黑名单/敏感目录 deny/网络双态不变。spec：`docs/specs/2026-10-01-sandbox-toolchain-grant.md`
```

- [ ] **Step 4: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs: 沙箱工具链授权研发账本条目"
```

---

## 任务依赖关系

- Task 1 → Task 2 → {Task 3, Task 4} → Task 5 → Task 6 → Task 7 → Task 8
- Task 3 与 Task 4 在 Task 2 后可并行（Task 4 的 shell-tools 接线消费 Task 3 的 opts.toolchainEnabled——严格序 3 先于 4 的接线步；纯函数提示层可与 3 并行）
- 执行开始时：停 dev app → `git checkout main && git checkout -b feat/sandbox-toolchain-grant`
