# 安全沙箱「全盘可写」开关实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增全局沙箱写域开关 `sandboxWritePolicy`（confined/full-disk）——full-disk 下 bash 与插件执行通道除 OS 核心目录外全盘可写。

**Architecture:** 照 `networkPolicy` 的完整先例路径：GlobalSettings kv 新键（crud 层只透传）→ `sandbox/settings.ts` 懒迁移 → net-trust 线协议 payload 加字段过桥到子进程 → `resolveShellSpawn(opts.writeScope)` / `resolveSandboxedSpawn(settings)` → `buildPolicy` 第 4 参 → seatbelt/bwrap 各加 full-disk 渲染分支（后置覆盖语义）。

**Tech Stack:** Electron 主进程（CommonJS）+ React renderer（ESM）；vitest；better-sqlite3 kv。

**Spec:** `docs/specs/2026-11-05-sandbox-full-disk-write-design.md`（计划从 spec 立论，执行者两份都读）

## Global Constraints

- Node 24（`nvm use 24`）；包管理 `npx pnpm@9.0.0`
- TypeScript strict：**禁止** `any` / `@ts-ignore` / `as any`
- 所有代码注释中文；Conventional Commits（`feat:`/`test:`）；不动版本号
- renderer 只用语义 token + lucide 图标（设计系统 v2.1）；禁 Tailwind 标准色阶
- 单测位置：electron 集中 `electron/tests/`（镜像 src 结构）；renderer 贴源
- vitest 单目录跑 DB 重度套件显式 `--pool=forks`；electron 全量必须裸 `vitest run`
- **环境注意**：better-sqlite3 当前为 Electron ABI 149（tmux `momo-dev` dev 实例在用）。跑 electron vitest 前需翻回 Node ABI：`cd node_modules/better-sqlite3 && npx prebuild-install`（必要时对 `.pnpm/better-sqlite3@*/.../better_sqlite3.node` ad-hoc 重签，见 AGENTS.md 陷阱表）——**翻转前先与用户确认可停 dev 实例**。typecheck 不受 ABI 影响。
- 线协议改动（net-trust payload 加字段）必须**两端同 commit**（momo-boundary-rules）

## Review Focus

1. **新旧混跑**：新主进程 + 旧子进程应答缺 `writePolicy` / 脏值 → 必须兜底 `confined`（桥规范化测试，Task 5）。
2. **脏设置值**：kv JSON 手改 `sandboxWritePolicy: "FULL-DISK"` 等非法值 → 收敛 `confined` 并写回、不抛错（Task 1 settings.test.ts）。
3. **规则次序**：seatbelt re-allow 必须殿后于全部核心 deny；bwrap `/usr/local` re-bind 必须殿后于核心 ro-bind——次序错 = 全盘开关写域泄漏或过窄（Task 3/4 快照锁次序，非仅锁集合）。
4. **幽灵路径**：linux 核心条目不存在（usr-merge/CI fixture-less）→ 跳过不得打挂 spawn（Task 4）。
5. **关开关回归**：full-disk → confined 切回后 profile/args 与既有快照**字节一致**——既有 confined 快照用例保持原样通过即反证（Task 3/4 不改既有快照）。

---

### Task 1: 类型与设置层（SandboxWritePolicy + 懒迁移 + 全仓 override 调用点清扫）

**Files:**
- Modify: `electron/src/main/sandbox/types.ts`
- Modify: `electron/src/main/settings/crud.ts`（GlobalSettings 增键 + 两处透传）
- Modify: `electron/src/main/sandbox/settings.ts`
- Test: `electron/tests/sandbox/settings.test.ts`
- Sweep: 全仓 `__setSandboxSettingsForTest` 调用点（约 16 处）

**Interfaces:**
- Produces: `type SandboxWritePolicy = 'confined' | 'full-disk'`（types.ts，后续所有任务消费）
- Produces: `SandboxSettings { mode: SandboxMode; networkPolicy: NetworkPolicy; writePolicy: SandboxWritePolicy }`
- Produces: `GlobalSettings.sandboxWritePolicy?: 'confined' | 'full-disk'`

- [ ] **Step 1: 写失败测试**（settings.test.ts 追加 describe；该文件既有 DB fixture 形态照抄——先读文件头确认 beforeEach 的 in-memory DB 挂载方式）

```ts
describe('writePolicy（2026-11-05 全盘可写 spec §5.1）', () => {
  it('kv 缺省（新装/老库）→ confined 且写回新键', () => {
    expect(getSandboxSettings().writePolicy).toBe('confined');
    expect(getGlobalSettings().sandboxWritePolicy).toBe('confined'); // 迁移已落盘
  });
  it('脏值（"FULL-DISK" 大写脏值）→ 收敛 confined 写回', () => {
    updateGlobalSettings({ sandboxWritePolicy: 'FULL-DISK' as never });
    expect(getSandboxSettings().writePolicy).toBe('confined');
    expect(getGlobalSettings().sandboxWritePolicy).toBe('confined');
  });
  it('合法值透传不写回', () => {
    updateGlobalSettings({ sandboxWritePolicy: 'full-disk' });
    expect(getSandboxSettings().writePolicy).toBe('full-disk');
  });
  it('testOverride 携带 writePolicy', () => {
    __setSandboxSettingsForTest({ mode: 'strict', networkPolicy: 'allow', writePolicy: 'full-disk' });
    try { expect(getSandboxSettings().writePolicy).toBe('full-disk'); }
    finally { __setSandboxSettingsForTest(null); }
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/sandbox/settings.test.ts --pool=forks`
Expected: FAIL——`writePolicy` 属性不存在（类型错误/undefined）

- [ ] **Step 3: 实现**

`types.ts` 追加：

```ts
/** 沙箱写域（2026-11-05 全盘可写 spec §5.3）：confined=workspace+tmp+动态授权（现行，默认安全方向）；full-disk=除 OS 核心目录外全盘可写 */
export type SandboxWritePolicy = 'confined' | 'full-disk';
```

`crud.ts`：GlobalSettings 接口 `journalQuotaMb` 字段后追加（**不给默认值**——sandboxNetworkPolicy 同纪律，防止 update 合并烤进 JSON 污染迁移判定）：

```ts
  /**
   * 沙箱写域策略（2026-11-05 全盘可写 spec §5.1）。读侧只在 kv 有行时透传
   * （缺省 undefined），迁移收敛在 sandbox/settings.ts——此处给默认值会被
   * updateGlobalSettings 读改写合并烤进 JSON，污染迁移判定（sandboxNetworkPolicy 先例）。
   */
  sandboxWritePolicy?: 'confined' | 'full-disk';
```

`getGlobalSettings` 两处返回对象：无行分支**不加该键**；有行分支 `sandboxToolchainDirs` 透传行后加 `sandboxWritePolicy: parsed.sandboxWritePolicy,`。

`settings.ts`：import 增 `SandboxWritePolicy`；接口与读取改为：

```ts
import { getGlobalSettings, updateGlobalSettings } from '../settings/crud';
import type { SandboxMode, SandboxWritePolicy } from './types';

export interface SandboxSettings {
  mode: SandboxMode;
  networkPolicy: NetworkPolicy;
  writePolicy: SandboxWritePolicy;
}

export function getSandboxSettings(): SandboxSettings {
  if (testOverride) return { ...testOverride };
  const g = getGlobalSettings();
  const mode: SandboxMode = g.sandboxMode === 'permissive' ? 'permissive' : 'strict';
  // 写域懒迁移（spec §5.1，networkPolicy 先例）：缺失（新装）/ 脏值一律收敛
  // 'confined' 并写回；写失败不阻断读取。合法值透传不写回。
  let writePolicy: SandboxWritePolicy;
  if (g.sandboxWritePolicy === 'confined' || g.sandboxWritePolicy === 'full-disk') {
    writePolicy = g.sandboxWritePolicy;
  } else {
    writePolicy = 'confined';
    try {
      updateGlobalSettings({ sandboxWritePolicy: 'confined' });
    } catch {
      // 迁移写失败（DB 异常等）：按推导值继续返回
    }
  }
  if (g.sandboxNetworkPolicy === 'deny') {
    return { mode, networkPolicy: 'deny', writePolicy };
  }
  if (g.sandboxNetworkPolicy === 'allow') {
    return { mode, networkPolicy: 'allow', writePolicy };
  }
  try {
    updateGlobalSettings({ sandboxNetworkPolicy: 'allow' });
  } catch {
    // 迁移写失败（DB 异常等）：按推导值继续返回
  }
  return { mode, networkPolicy: 'allow', writePolicy };
}
```

- [ ] **Step 4: 全仓调用点清扫**（`SandboxSettings` 增必填字段 → 编译期暴露全部调用点）

Run: `cd electron && grep -rn "__setSandboxSettingsForTest({" tests/ src/ | grep -v "null"`
对每一处在既有对象字面量补 `writePolicy: 'confined'`（语义：这些用例都测 confined 行为）。涉及已知文件：`tests/sandbox/settings.test.ts`、`ipc.handlers.test.ts`、`network-trust.test.ts`、`bwrap-integration.test.ts`、`resolve-spawn.test.ts`、`sandboxed-spawn.test.ts`、`tests/agent/tools/shell-tools.test.ts`、`shell-net-trust.test.ts`、`tests/agent/tools/shell-tools-abort.test.ts`、`tests/agent/runtime-sandbox-probe-wiring.test.ts` 等——以 grep 实时结果为准。

- [ ] **Step 5: 跑测试确认通过**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/sandbox/ --pool=forks && npx pnpm@9.0.0 exec tsc -p tsconfig.test.json --noEmit`
Expected: PASS（含既有全部 sandbox 用例——证明清扫无遗漏）

- [ ] **Step 6: Commit**

```bash
git add electron/src/main/sandbox/types.ts electron/src/main/sandbox/settings.ts electron/src/main/settings/crud.ts electron/tests/
git commit -m "feat: 沙箱写域设置层——sandboxWritePolicy 键 + 懒迁移收敛 confined（全盘可写 spec §5.1）"
```

---

### Task 2: 策略层（ShellSandboxPolicy.writeScope + 核心目录清单常量）

**Files:**
- Modify: `electron/src/main/sandbox/types.ts`（ShellSandboxPolicy）
- Modify: `electron/src/main/sandbox/policy.ts`
- Test: `electron/tests/sandbox/policy.test.ts`
- Sweep: `electron/tests/sandbox/macos.test.ts` / `linux.test.ts` 的 `mkPolicy` helper

**Interfaces:**
- Consumes: Task 1 的 `SandboxWritePolicy`
- Produces: `ShellSandboxPolicy.writeScope: SandboxWritePolicy`（必填——Task 3/4 消费）
- Produces: `buildPolicy(workspaceDir: string, networkEnabled: boolean, extraWriteDirs: string[] = [], writeScope: SandboxWritePolicy = 'confined')`
- Produces: 常量 `FULL_DISK_WRITE_DENY_DARWIN` / `FULL_DISK_WRITE_DENY_LINUX` / `FULL_DISK_WRITE_REALLOW`

- [ ] **Step 1: 写失败测试**（policy.test.ts 追加；文件既有 describe 形态照抄）

```ts
describe('writeScope + 核心目录清单（spec §5.3）', () => {
  it('buildPolicy 第 4 参缺省 confined（既有调用方零改动）', () => {
    expect(buildPolicy('/tmp/ws', false).writeScope).toBe('confined');
  });
  it('full-disk 透传', () => {
    expect(buildPolicy('/tmp/ws', false, [], 'full-disk').writeScope).toBe('full-disk');
  });
  it('清单形态锁：darwin 七条 + linux 七条 + re-allow 常量（spec §5.3 定案不得增删）', () => {
    expect([...FULL_DISK_WRITE_DENY_DARWIN]).toEqual(['/System', '/bin', '/sbin', '/usr', '/etc', '/private/etc', '/Library']);
    expect([...FULL_DISK_WRITE_DENY_LINUX]).toEqual(['/usr', '/etc', '/bin', '/sbin', '/lib', '/lib64', '/boot']);
    expect(FULL_DISK_WRITE_REALLOW).toBe('/usr/local');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/sandbox/policy.test.ts --pool=forks`
Expected: FAIL——`FULL_DISK_WRITE_DENY_DARWIN` 未导出 / `writeScope` 不存在

- [ ] **Step 3: 实现**

`types.ts` ShellSandboxPolicy `extraWriteDirs` 字段后追加：

```ts
  /** 写域（spec 2026-11-05 §5.3）：confined=现行（workspace+tmp+extraWriteDirs）；
   * full-disk=全盘可写除 OS 核心目录（清单见 policy.ts，sensitiveDirs 读遮蔽两态共用） */
  writeScope: SandboxWritePolicy;
```

`policy.ts`：import 类型 + 常量导出 + buildPolicy 签名扩展：

```ts
import type { ShellSandboxPolicy, SandboxWritePolicy } from './types';

/** 全盘可写模式下仍禁写的 OS 核心目录（spec 2026-11-05 §5.3 定案，不得增删）：
 * /private/var 刻意不进（macOS TMPDIR /var/folders 在内）；/opt/homebrew、~/.nvm
 * 等工具链位置刻意不在清单（开关核心价值）；/etc 与 /private/etc 双形态双保险 */
export const FULL_DISK_WRITE_DENY_DARWIN = [
  '/System', '/bin', '/sbin', '/usr', '/etc', '/private/etc', '/Library',
] as const;
export const FULL_DISK_WRITE_DENY_LINUX = [
  '/usr', '/etc', '/bin', '/sbin', '/lib', '/lib64', '/boot',
] as const;
/** 核心目录中的用户工具链例外（Intel homebrew / 手装工具惯常位置）——平台渲染层后置 re-allow */
export const FULL_DISK_WRITE_REALLOW = '/usr/local';

export function buildPolicy(
  workspaceDir: string,
  networkEnabled: boolean,
  extraWriteDirs: string[] = [],
  writeScope: SandboxWritePolicy = 'confined',
): ShellSandboxPolicy {
  // ...既有函数体不动，返回对象追加：
  //   writeScope,
}
```

- [ ] **Step 4: mkPolicy helper 清扫**（writeScope 必填 → macos/linux 测试 helper 编译期暴露）

`electron/tests/sandbox/macos.test.ts` 与 `linux.test.ts` 的 `mkPolicy` 各在 spread 前补默认值：

```ts
    sensitiveDirs: [], networkEnabled: false, extraWriteDirs: [], writeScope: 'confined', ...over,
```

同时把两文件**既有快照用例**的固定 policy 对象字面量补 `writeScope: 'confined' as const`——**快照期望值本身一字不改**（confined 渲染字节不变的回归锁，Review Focus #5）。

- [ ] **Step 5: 跑测试确认通过**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/sandbox/policy.test.ts tests/sandbox/macos.test.ts tests/sandbox/linux.test.ts --pool=forks`
Expected: PASS（既有快照原样通过——policy 层还没消费 writeScope，渲染未变）

- [ ] **Step 6: Commit**

```bash
git add electron/src/main/sandbox/types.ts electron/src/main/sandbox/policy.ts electron/tests/sandbox/
git commit -m "feat: 沙箱策略层——writeScope 维度 + OS 核心目录 deny 清单常量（全盘可写 spec §5.3）"
```

---

### Task 3: macOS Seatbelt full-disk 渲染分支

**Files:**
- Modify: `electron/src/main/sandbox/macos.ts`
- Test: `electron/tests/sandbox/macos.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `policy.writeScope`、`FULL_DISK_WRITE_DENY_DARWIN`、`FULL_DISK_WRITE_REALLOW`
- Produces: full-disk 态 profile 写剖面（Task 5 的 tag 与 Task 7 主机验收消费）

- [ ] **Step 1: 写失败测试**（macos.test.ts 追加）

```ts
describe('full-disk 写域（spec §5.4）', () => {
  const fd: ShellSandboxPolicy = {
    workspaceDir: '/Users/dev/snapshot-ws', homeDir: '/Users/dev',
    tmpDir: '/private/var/folders/xx/T', sensitiveDirs: ['/Users/dev/.ssh'],
    networkEnabled: false, extraWriteDirs: [], writeScope: 'full-disk',
  };
  it('快照：全盘 allow → 核心 deny 逐条 → /usr/local re-allow 殿后（后匹配优先——次序即正确性）', () => {
    expect(renderSeatbeltProfile(fd)).toMatchInlineSnapshot(`
      "(version 1)
      (deny default)
      (allow file-read* (subpath \\"/\\"))
      (deny file-read* (subpath \\"/Users/dev/.ssh\\"))
      (allow file-write* (subpath \\"/\\"))
      (deny file-write* (subpath \\"/System\\"))
      (deny file-write* (subpath \\"/bin\\"))
      (deny file-write* (subpath \\"/sbin\\"))
      (deny file-write* (subpath \\"/usr\\"))
      (deny file-write* (subpath \\"/etc\\"))
      (deny file-write* (subpath \\"/private/etc\\"))
      (deny file-write* (subpath \\"/Library\\"))
      (allow file-write* (subpath \\"/usr/local\\"))
      (allow file-write* (literal \\"/dev/null\\"))
      (allow process-exec process-fork)
      (allow signal (target self))
      (allow file-ioctl sysctl-read mach-lookup)
      "
    `);
  });
  it('次序锁：re-allow 在 deny /usr 之后；全盘 allow 在所有 deny 之前', () => {
    const p = renderSeatbeltProfile(fd);
    expect(p.indexOf('(allow file-write* (subpath "/usr/local"))')).toBeGreaterThan(p.indexOf('(deny file-write* (subpath "/usr"))'));
    expect(p.indexOf('(allow file-write* (subpath "/"))')).toBeLessThan(p.indexOf('(deny file-write* (subpath "/System"))'));
  });
  it('sensitiveDirs 读遮蔽共存（写域与读遮蔽正交）', () => {
    expect(renderSeatbeltProfile(fd)).toContain('(deny file-read* (subpath "/Users/dev/.ssh"))');
  });
  it('confined 态无全盘写行（既有行为反证）', () => {
    const c = { ...fd, writeScope: 'confined' as const };
    expect(renderSeatbeltProfile(c)).not.toContain('(allow file-write* (subpath "/"))');
  });
});
```

（快照首跑可用 `--update` 生成后**人工核对次序**再固化——次序是断言主体，Review Focus #3）

- [ ] **Step 2: 跑测试确认失败**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/sandbox/macos.test.ts --pool=forks`
Expected: FAIL——profile 无 full-disk 写剖面

- [ ] **Step 3: 实现**（macos.ts——写剖面抽成两态分支，读剖面/deny 规则/网络规则不动）

```ts
import { FULL_DISK_WRITE_DENY_DARWIN, FULL_DISK_WRITE_REALLOW } from './policy';

export function renderSeatbeltProfile(policy: ShellSandboxPolicy): string {
  const denyRules = policy.sensitiveDirs
    .map((d) => `(deny file-read* (subpath ${escapeSeatbeltString(d)}))`)
    .join('\n');
  const networkRule = policy.networkEnabled ? '(allow network*)\n' : '';
  const toolchainSection = policy.extraWriteDirs.length > 0
    ? `${policy.extraWriteDirs.map((d) => `(allow file-write* (subpath ${escapeSeatbeltString(d)}))`).join('\n')}\n`
    : '';
  // 写剖面两态（spec 2026-11-05 §5.4）：confined=现行 workspace/tmp+授权目录；
  // full-disk=全盘 allow → 核心目录 deny 逐条后置 → /usr/local re-allow 殿后——
  // Seatbelt 后匹配优先，次序即正确性（快照测试锁次序非仅集合）。
  // join('\n') 形态刻意：confined 空 extraDirs 时与既有模板逐字节等价（原模板
  // `${toolchainSection}(allow process-exec…)` 行内拼接——空 section 无多余 \n，
  // 字符串拼接 `"…\n${toolchainSection}"` 会双换行炸既有快照）
  const writeSection = policy.writeScope === 'full-disk'
    ? [
        `(allow file-write* (subpath ${escapeSeatbeltString('/')}))`,
        ...FULL_DISK_WRITE_DENY_DARWIN.map((d) => `(deny file-write* (subpath ${escapeSeatbeltString(d)}))`),
        `(allow file-write* (subpath ${escapeSeatbeltString(FULL_DISK_WRITE_REALLOW)}))`,
        '(allow file-write* (literal "/dev/null"))',
      ].join('\n')
    : [
        `(allow file-write* (subpath ${escapeSeatbeltString(policy.workspaceDir)}) (subpath ${escapeSeatbeltString(policy.tmpDir)}) (subpath "/private/tmp"))`,
        '(allow file-write* (literal "/dev/null"))',
        ...policy.extraWriteDirs.map((d) => `(allow file-write* (subpath ${escapeSeatbeltString(d)}))`),
      ].join('\n');
  return `(version 1)
(deny default)
(allow file-read* (subpath ${escapeSeatbeltString('/')}))
${denyRules}
${writeSection}
(allow process-exec process-fork)
(allow signal (target self))
(allow file-ioctl sysctl-read mach-lookup)
${networkRule}`;
}
```

（注意：confined 分支的 `${toolchainSection}` 从模板行内挪进 writeSection 末行——既有 confined 快照的行序与字节必须保持一致，跑既有快照即验证。）

- [ ] **Step 4: 跑测试确认通过**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/sandbox/macos.test.ts --pool=forks`
Expected: PASS——新用例绿 + **既有 confined 快照原样绿**（Review Focus #5）

- [ ] **Step 5: Commit**

```bash
git add electron/src/main/sandbox/macos.ts electron/tests/sandbox/macos.test.ts
git commit -m "feat: seatbelt full-disk 写剖面——全盘 allow + 核心目录后置 deny + /usr/local re-allow 殿后"
```

---

### Task 4: Linux bwrap full-disk 渲染分支

**Files:**
- Modify: `electron/src/main/sandbox/linux.ts`
- Test: `electron/tests/sandbox/linux.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `policy.writeScope`、`FULL_DISK_WRITE_DENY_LINUX`、`FULL_DISK_WRITE_REALLOW`
- Produces: full-disk 态 bwrap args 全序（Task 7 消费）

- [ ] **Step 1: 写失败测试**（linux.test.ts 追加）

```ts
describe('full-disk 写域（spec §5.4）', () => {
  const fd: ShellSandboxPolicy = {
    workspaceDir: '/tmp/snapshot-ws', homeDir: '/home/snapshot', tmpDir: '/tmp',
    sensitiveDirs: ['/home/u/.ssh'], networkEnabled: false,
    extraWriteDirs: [], writeScope: 'full-disk',
  };
  it('次序锁：--bind / / 前置 → 敏感遮盖 → 核心 ro-bind → /usr/local re-bind 殿后', () => {
    const args = buildBwrapArgs(fd);
    const idx = (frag: string): number => args.indexOf(frag);
    // 前 3 项必须是 --bind / /
    expect(args.slice(0, 3)).toEqual(['--bind', '/', '/']);
    expect(idx('/usr/local')).toBeGreaterThan(args.lastIndexOf('--ro-bind'));      // re-bind 殿后
    expect(args.indexOf('/usr', idx('/usr/local'))).toBe(-1);                      // /usr ro-bind 在 re-bind 之前
    expect(idx('/home/u/.ssh')).toBeLessThan(idx('/usr/local'));                  // 敏感遮盖在核心降级之前
    expect(args).toContain('--tmpfs');
  });
  it('幽灵核心条目跳过：fixture 内伪造存在的核心路径（usr-merge symlink 形态由存在性过滤兜底）', () => {
    // /lib 等在多数 macOS 开发机不存在——断言「不存在条目零出现」且不抛
    const args = buildBwrapArgs(fd);
    for (const core of ['/boot', '/lib', '/lib64']) {
      if (!fs.existsSync(core)) {
        expect(args.filter((a) => a === core)).toHaveLength(0);
      }
    }
  });
  it('confined 态无 --bind / /（既有行为反证）', () => {
    expect(buildBwrapArgs({ ...fd, writeScope: 'confined' as const }).slice(0, 3))
      .toEqual(['--ro-bind', '/', '/']);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/sandbox/linux.test.ts --pool=forks`
Expected: FAIL——首参仍为 `--ro-bind / /`

- [ ] **Step 3: 实现**（linux.ts——根挂载两态 + 核心 ro-bind 段插在敏感遮盖与 workspace bind 之间）

```ts
import { FULL_DISK_WRITE_DENY_LINUX, FULL_DISK_WRITE_REALLOW } from './policy';

export function buildBwrapArgs(policy: ShellSandboxPolicy): string[] {
  // 根挂载两态（spec 2026-11-05 §5.4）：confined=全盘只读；full-disk=全盘 RW，
  // 核心目录随后置 ro-bind 降回只读（bwrap 后挂载覆盖先挂载——次序即正确性）
  const args: string[] = policy.writeScope === 'full-disk'
    ? ['--bind', '/', '/']
    : ['--ro-bind', '/', '/'];
  for (const dir of policy.sensitiveDirs) {
    // （既有循环原样——敏感遮盖在全盘 bind 之后，后置覆盖仍生效）
    let isFile = false;
    try {
      isFile = fs.statSync(dir).isFile();
    } catch {
      // 条目不存在：tmpfs 自建挂载点，与旧行为一致
    }
    if (isFile) args.push('--ro-bind', '/dev/null', dir);
    else args.push('--tmpfs', dir);
  }
  if (policy.writeScope === 'full-disk') {
    // 核心目录逐条降回只读；存在性过滤在本消费点（extraWriteDirs 先例——单条
    // 幽灵路径不得打挂整个 spawn；usr-merge symlink 条目 ro-bind 跟随解析无害）
    for (const core of FULL_DISK_WRITE_DENY_LINUX) {
      if (!fs.existsSync(core)) continue;
      args.push('--ro-bind', core, core);
    }
    if (fs.existsSync(FULL_DISK_WRITE_REALLOW)) {
      args.push('--bind', FULL_DISK_WRITE_REALLOW, FULL_DISK_WRITE_REALLOW);
    }
  }
  args.push('--bind', policy.workspaceDir, policy.workspaceDir);
  // （extraWriteDirs 循环、/tmp bind、--dev/--proc、--unshare-net、加固参数——原样保留）
  // ...
  return args;
}
```

（实现时函数尾部原样保留；上面的省略号仅指「既有代码不动」，落盘代码必须完整。）

- [ ] **Step 4: 跑测试确认通过**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/sandbox/linux.test.ts --pool=forks`
Expected: PASS——新用例绿 + 既有 confined 快照原样绿

- [ ] **Step 5: Commit**

```bash
git add electron/src/main/sandbox/linux.ts electron/tests/sandbox/linux.test.ts
git commit -m "feat: bwrap full-disk 写剖面——bind 全盘 RW + 核心目录后置 ro-bind + /usr/local re-bind"
```

---

### Task 5: 线协议 + 入口接线（net-trust payload 三键 + resolve 双入口 + /fdw tag）

**Files:**
- Modify: `electron/src/main/sandbox/network-trust.ts`
- Modify: `electron/src/main/agent/tools/net-trust-bridge.ts`
- Modify: `electron/src/main/agent/tools/shell-tools.ts`（bashOnce opts）
- Modify: `electron/src/main/sandbox/index.ts`（两个 resolve + tag）
- Test: `electron/tests/sandbox/network-trust.test.ts`、`electron/tests/agent/tools/shell-net-trust.test.ts`、`electron/tests/sandbox/resolve-spawn.test.ts`、`electron/tests/sandbox/sandboxed-spawn.test.ts`

**Interfaces:**
- Consumes: Task 1 `SandboxWritePolicy`、Task 2 `buildPolicy` 第 4 参
- Produces: 线协议 payload `{ netOn: boolean; extraDirs: string[]; writePolicy: SandboxWritePolicy }`（**两端同 commit**）
- Produces: `resolveShellSpawn` 第 3 参 opts 增 `writeScope?: SandboxWritePolicy`
- Produces: spawn tag 形态 `<tool>/<netTag>[/fdw]`（confined 无后缀）

- [ ] **Step 1: 写失败测试**

`network-trust.test.ts`——**形状锁两键 → 三键同 commit 扩**（约 line 57-66 / 181-188 的 `toEqual` 精确断言与键锁）：

```ts
// 既有 'policy=allow' / 'policy=deny' 两用例的期望改为（writePolicy 随 settings 下行）：
expect(r).toEqual({ ok: true, payload: { netOn: true, extraDirs: [], writePolicy: 'confined' } });
expect(r).toEqual({ ok: true, payload: { netOn: false, extraDirs: [], writePolicy: 'confined' } });
// 形状锁用例（原 '恰好 {netOn, extraDirs} 两键'）：
it('payload 形状锁：恰好 {netOn, extraDirs, writePolicy} 三键（2026-11-05 写域过桥）', async () => {
  /* 既有 setup 照抄 */
  expect(r.ok).toBe(true);
  if (r.ok) expect(Object.keys(r.payload).sort()).toEqual(['extraDirs', 'netOn', 'writePolicy']);
});
// 新增：
it('settings full-disk → writePolicy 下行 full-disk', async () => {
  __setSandboxSettingsForTest({ mode: 'strict', networkPolicy: 'allow', writePolicy: 'full-disk' });
  try {
    const r = await handleNetTrustOp({ type: 'net-trust-op', requestId: 'r1', op: 'effective', streamSessionId: 's' });
    expect(r).toEqual({ ok: true, payload: { netOn: true, extraDirs: [], writePolicy: 'full-disk' } });
  } finally { __setSandboxSettingsForTest(null); }
});
```

`shell-net-trust.test.ts`——桥形状锁与规范化（既有 line 199 两键锁改三键；`effectiveMock.mockResolvedValue({ netOn: false, extraDirs: [] })` 各处补 `writePolicy: 'confined'`）：

```ts
it('桥规范化：旧主进程应答缺 writePolicy → confined 兜底（新旧混跑安全）', async () => {
  effectiveMock.mockResolvedValue({ netOn: false, extraDirs: [] } as never);
  /* 经 bash 工具触发一次查询后断言桥产物 —— 或直接单测 requestEffectiveNetwork 的
     then 规范化：mock process.send 应答缺键，返回 writePolicy 'confined' */
});
```

（桥规范化的直接单测：在 `tests/agent/tools/` 既有 net-trust 桥测试文件形态内 mock `process.send` 应答；若该文件无此形态，退而在 shell-net-trust.test.ts 经 `__setNetQueryForTest` 注入缺键应答、断言 spawn 走 confined 分支——以实际文件结构为准，保真度优先。）

`resolve-spawn.test.ts` 追加：

```ts
it('writeScope 过桥优先：opts.writeScope=full-disk → bwrap args --bind / / + tag 带 /fdw', () => {
  __setSandboxStateForTest(/* 既有 bwrap 可用态 fixture 照抄 */);
  __setSandboxSettingsForTest({ mode: 'strict', networkPolicy: 'allow', writePolicy: 'confined' });
  try {
    const plan = resolveShellSpawn('/tmp/ws', 'true', { networkEnabled: true, extraDirs: [], writeScope: 'full-disk' });
    expect(plan.kind).toBe('wrapped');
    if (plan.kind === 'wrapped') {
      expect(plan.args.slice(0, 3)).toEqual(['--bind', '/', '/']);
      expect(plan.tag).toBe('bwrap/net-on/fdw');
    }
  } finally { __setSandboxSettingsForTest(null); __setSandboxStateForTest(null); }
});
it('未传 opts.writeScope → settings 双态推导（回退语义与 networkEnabled 同构）', () => {
  __setSandboxSettingsForTest({ mode: 'strict', networkPolicy: 'allow', writePolicy: 'full-disk' });
  try {
    const plan = resolveShellSpawn('/tmp/ws', 'true');
    if (plan.kind === 'wrapped') expect(plan.tag).toContain('/fdw');
  } finally { __setSandboxSettingsForTest(null); }
});
```

（darwin/seatbelt 分支与 `sandboxed-spawn.test.ts` 的 tag 用例按同构模式各补一条 full-disk 断言：`seatbelt/net-on/fdw`、`bwrap/net-off/fdw`；confined 既有 tag 断言**一字不改**。）

- [ ] **Step 2: 跑测试确认失败**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/sandbox/network-trust.test.ts tests/agent/tools/shell-net-trust.test.ts tests/sandbox/resolve-spawn.test.ts tests/sandbox/sandboxed-spawn.test.ts --pool=forks`
Expected: FAIL——payload 无 writePolicy / tag 无 /fdw

- [ ] **Step 3: 实现**

`network-trust.ts`（handleNetTrustOp 内，payload 组装处）：

```ts
    const extraDirs = getGrantedDirs(sessionId, parsed.workspaceId ?? null);
    return { ok: true, payload: { netOn, extraDirs, writePolicy: settings.writePolicy } };
```

`net-trust-bridge.ts`：

```ts
import type { SandboxWritePolicy } from '../../../sandbox/types';

export interface EffectiveNetworkDecision {
  netOn: boolean;
  extraDirs: string[];
  /** 写域（2026-11-05 spec §5.5）：旧主进程应答缺键/脏值按 'confined' 兜底（混跑安全） */
  writePolicy: SandboxWritePolicy;
}
// requestEffectiveNetwork 的 then 规范化：
      return {
        netOn: p.netOn === true,
        extraDirs: Array.isArray(p.extraDirs)
          ? p.extraDirs.filter((d): d is string => typeof d === 'string')
          : [],
        writePolicy: p.writePolicy === 'full-disk' ? 'full-disk' : 'confined',
      };
```

`shell-tools.ts` bashOnce 的 resolveShellSpawn 调用：

```ts
    const plan = resolveShellSpawn(
      ctx.workspaceDir,
      command,
      net === null ? undefined : {
        networkEnabled: net.netOn,
        extraDirs: net.extraDirs,
        // 写域过桥（spec §5.5）：与 networkEnabled 同构——子进程不可见 settings DB
        writeScope: net.writePolicy,
      },
    );
```

`index.ts`：

```ts
import type { SandboxWritePolicy, SpawnPlan } from './types';

export function resolveShellSpawn(
  workspaceDir: string,
  command: string,
  opts?: { networkEnabled?: boolean; extraDirs?: string[]; writeScope?: SandboxWritePolicy },
): SpawnPlan {
  const settings = getSandboxSettings();
  const networkEnabled = opts?.networkEnabled ?? (settings.networkPolicy === 'allow');
  // 写域（spec §5.5）：子进程调用方经 net-trust 桥以 opts.writeScope 显式传入；
  // 未传（既有调用方/单测）按 settings 双态推导——与 networkEnabled 同构回退
  const writeScope = opts?.writeScope ?? settings.writePolicy;
  const extraWriteDirs = opts?.extraDirs ?? [];
  const policy = buildPolicy(workspaceDir, networkEnabled, extraWriteDirs, writeScope);
  // ... win32 分支不动 ...
  const netTag = networkEnabled ? 'net-on' : 'net-off';
  const fdwTag = writeScope === 'full-disk' ? '/fdw' : '';
  // bwrap 分支 tag：`bwrap/${netTag}${fdwTag}`；seatbelt 分支 tag：`seatbelt/${netTag}${fdwTag}`
  // blocked/plain 分支不动（plain tag `unsandboxed:${reason}` 无写域段——直跑本就无隔离）
}
```

`resolveSandboxedSpawn`（主进程侧执行，直读 settings）：

```ts
  const settings = getSandboxSettings();
  const policy = buildPolicy(workspaceDir, false, [], settings.writePolicy);
  const fdwTag = settings.writePolicy === 'full-disk' ? '/fdw' : '';
  // tag：`bwrap/net-off${fdwTag}`、`seatbelt/net-off${fdwTag}`；win32 与 unsandboxed 分支不动
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/sandbox/ tests/agent/tools/shell-net-trust.test.ts --pool=forks`
Expected: PASS（含既有全部 tag/形状断言零回归）

- [ ] **Step 5: Commit**

```bash
git add electron/src/main/sandbox/ electron/src/main/agent/tools/ electron/tests/
git commit -m "feat: writePolicy 线协议过桥 + resolve 双入口接线 + spawn tag /fdw（全盘可写 spec §5.5）"
```

---

### Task 6: IPC 契约 + 设置面板 UI

**Files:**
- Modify: `electron/src/main/sandbox/ipc.handlers.ts`（SandboxInfo 接口）
- Modify: `renderer/src/ipc/types.d.ts`（SandboxWritePolicy 类型 + SandboxInfo.settings + GlobalSettings 镜像 ~line 890）
- Modify: `renderer/src/components/settings/SandboxSettingsPanel.tsx`
- Test: `renderer/src/components/settings/SandboxSettingsPanel.test.tsx`
- Sweep: renderer 侧 SandboxInfo mock（`renderer/src/App.test.tsx` mkSandboxInfo ~line 144、`SandboxNotice.test.tsx` 等）

**Interfaces:**
- Consumes: Task 1/5 的 `SandboxWritePolicy`、`getSandboxSettings`（buildInfo 已自动携带）
- Produces: `SandboxInfo.settings.writePolicy`（两端契约）；面板开关写 `settings:updateGlobal({ sandboxWritePolicy })`

- [ ] **Step 1: 写失败测试**（SandboxSettingsPanel.test.tsx 追加；既有 mock 形态照抄——先读文件确认 `mockApi.sandbox.getState` 的注入方式，mock settings 补 `writePolicy: 'confined'`）

```tsx
describe('全盘可写开关（spec §5.7）', () => {
  it('渲染写域区块：confined 默认选中', async () => {
    render(<SandboxSettingsPanel />);
    expect(await screen.findByText(/全盘可写/)).toBeInTheDocument();
    expect(screen.getByLabelText(/仅工作空间/)).toBeChecked();
  });
  it('选 full-disk → 弹确认对话框；取消 → 不落值', async () => {
    render(<SandboxSettingsPanel />);
    fireEvent.click(await screen.findByLabelText(/全盘可写/));
    expect(await screen.findByText(/全盘可写/)).toBeInTheDocument(); // 对话框标题
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    await waitFor(() => expect(mockApi.settings.updateGlobal).not.toHaveBeenCalledWith(
      expect.objectContaining({ sandboxWritePolicy: 'full-disk' }),
    ));
  });
  it('确认 → updateGlobal 落值 full-disk + 乐观 UI', async () => {
    render(<SandboxSettingsPanel />);
    fireEvent.click(await screen.findByLabelText(/全盘可写/));
    fireEvent.click(await screen.findByRole('button', { name: /开启全盘可写/ }));
    await waitFor(() => expect(mockApi.settings.updateGlobal).toHaveBeenCalledWith(
      { sandboxWritePolicy: 'full-disk' },
    ));
  });
  it('win32 → 开关禁用 + 不生效说明', async () => {
    mockApi.sandbox.getState.mockResolvedValue({ /* state.platform: 'win32' 其余字段照抄既有 fixture */ });
    render(<SandboxSettingsPanel />);
    expect(await screen.findByLabelText(/全盘可写/)).toBeDisabled();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd renderer && npx pnpm@9.0.0 vitest run src/components/settings/SandboxSettingsPanel.test.tsx`
Expected: FAIL——无「全盘可写」区块

- [ ] **Step 3: 实现**

`ipc.handlers.ts`（electron 侧接口；buildInfo 的 `settings: getSandboxSettings()` 已自动携带新字段）：

```ts
import { getSandboxSettings, type NetworkPolicy } from './settings';
import type { SandboxMode, SandboxWritePolicy } from './types';

export interface SandboxInfo {
  state: SandboxProbeState | null;
  settings: { mode: SandboxMode; networkPolicy: NetworkPolicy; writePolicy: SandboxWritePolicy };
  /* 其余字段不动 */
```

`renderer/src/ipc/types.d.ts`——三处：

```ts
/** 沙箱写域，与 electron 端 sandbox/types.ts 的 SandboxWritePolicy 对齐（2026-11-05 全盘可写） */
export type SandboxWritePolicy = 'confined' | 'full-disk';
// SandboxInfo.settings 增字段：
  settings: {
    mode: SandboxMode;
    networkPolicy: NetworkPolicy;
    writePolicy: SandboxWritePolicy;
  };
// GlobalSettings 镜像（~line 890 sandboxNetworkPolicy 后）：
  /** 沙箱写域（2026-11-05）：confined=workspace+tmp+动态授权（默认）；full-disk=除 OS 核心目录外全盘可写 */
  sandboxWritePolicy?: 'confined' | 'full-disk';
```

`SandboxSettingsPanel.tsx`：

```tsx
import type { SandboxInfo, SandboxMode, NetworkPolicy, SandboxWritePolicy } from '../../ipc/types';

// save 的 patch 与 settings 组装扩展：
  const save = (patch: {
    sandboxMode?: SandboxMode;
    sandboxNetworkPolicy?: NetworkPolicy;
    sandboxWritePolicy?: SandboxWritePolicy;
  }): void => {
    if (!info) return;
    setInfo({
      ...info,
      settings: {
        mode: patch.sandboxMode ?? info.settings.mode,
        networkPolicy: patch.sandboxNetworkPolicy ?? info.settings.networkPolicy,
        writePolicy: patch.sandboxWritePolicy ?? info.settings.writePolicy,
      },
    });
    void ipc.settings.updateGlobal(patch).catch(() => {});
  };

// 组件内新增待确认态：
  const [confirmFullDisk, setConfirmFullDisk] = useState(false);
  const isWin = info.state?.platform === 'win32';

// 网络出站 fieldset 之后插入写域 fieldset（radio 两态；full-disk onChange 先弹确认）：
      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium text-primary">写域（全盘可写）</legend>
        <label className="flex items-start gap-2 text-sm text-secondary">
          <input type="radio" name="sandbox-write-policy" checked={info.settings.writePolicy === 'confined'}
            onChange={() => save({ sandboxWritePolicy: 'confined' })} className="mt-1" aria-label="仅工作空间（默认）" />
          <span>仅工作空间（默认）——工作空间 / tmp / 已授权目录可写，越界弹授权卡</span>
        </label>
        <label className="flex items-start gap-2 text-sm text-secondary">
          <input type="radio" name="sandbox-write-policy" checked={info.settings.writePolicy === 'full-disk'}
            onChange={() => setConfirmFullDisk(true)} className="mt-1" aria-label="全盘可写"
            disabled={isWin} />
          <span>
            全盘可写——除操作系统核心目录（/System、/usr、/etc 等）外全部可读写，不再弹授权卡
            {isWin ? '（Windows 无 OS 沙箱，此开关不生效）' : ''}
          </span>
        </label>
        <p className="text-xs text-tertiary">仅影响 bash 与插件执行；文件工具仍限工作空间内；~/.ssh 等凭据目录读保护不受影响。</p>
      </fieldset>

// pendingRevoke 对话框之后追加确认对话框（ConfirmDialog danger 变体）：
      {confirmFullDisk && (
        <ConfirmDialog
          title="开启全盘可写"
          message={'开启后 agent 可改写系统目录之外的任意用户目录（含 ~/Library 等持久化位面）。\n凭据目录（~/.ssh 等）仍受读保护；仅影响 bash 与插件执行。'}
          confirmLabel="开启全盘可写"
          onConfirm={() => save({ sandboxWritePolicy: 'full-disk' })}
          onClose={() => setConfirmFullDisk(false)}
        />
      )}
```

- [ ] **Step 4: mock 清扫**（SandboxInfo.settings 必填新字段 → 编译期暴露）

Run: `cd renderer && grep -rn "networkPolicy" src/ --include="*.test.tsx" --include="*.test.ts"`
对每处 mock settings 补 `writePolicy: 'confined'`（已知：`App.test.tsx` mkSandboxInfo、`SandboxSettingsPanel.test.tsx`、`SandboxNotice.test.tsx`——以 grep 实时结果为准）。

- [ ] **Step 5: 跑测试确认通过**

Run: `cd renderer && npx pnpm@9.0.0 vitest run src/components/settings/ src/App.test.tsx && npx pnpm@9.0.0 exec tsc --noEmit`
Expected: PASS + typecheck 绿

- [ ] **Step 6: Commit**

```bash
git add electron/src/main/sandbox/ipc.handlers.ts renderer/src/ipc/types.d.ts renderer/src/components/settings/ renderer/src/App.test.tsx
git commit -m "feat: 设置面板全盘可写开关 + 确认对话框 + SandboxInfo 契约两端对齐（spec §5.2/§5.7）"
```

---

### Task 7: 全量验证 + UI 截图验收

**Files:** 无新改动（验证任务；失败才回头修）

- [ ] **Step 1: 双 workspace typecheck**

Run: `nvm use 24 && npx pnpm@9.0.0 typecheck`
Expected: 双绿

- [ ] **Step 2: renderer 全量**

Run: `cd renderer && npx pnpm@9.0.0 vitest run`
Expected: 全绿

- [ ] **Step 3: electron 全量（需 ABI 协调）**

与用户确认可停 tmux `momo-dev` dev 实例后：
```bash
cd node_modules/better-sqlite3 && npx prebuild-install
# 若 vitest SIGKILL 瞬死：codesign --force --sign - node_modules/.pnpm/better-sqlite3@*/node_modules/better-sqlite3/build/Release/better_sqlite3.node
cd ../electron && npx pnpm@9.0.0 vitest run   # 裸跑，不加 --pool
```
Expected: 全绿；非正常退出后检查孤儿 vitest worker（AGENTS 陷阱表）
跑完如需恢复 dev 实例：`cd electron && npx electron-rebuild -f -w better-sqlite3`（与用户确认）

- [ ] **Step 4: UI 截图验收（momo-ui-preview-rules P2 事后验收）**

dev 实例（或 `xvfb-run` 隔离实例）打开 设置→安全沙箱，截图三态：confined 默认态 / full-disk 确认对话框 / full-disk 已开启态；对照设计系统 token 使用（语义色、无 emoji、lucide）。异常回退 renderer 修。

- [ ] **Step 5: 收尾**

推送前 `git log --oneline` 核对 6 个提交全部落盘；汇总测试证据给用户；**不推送、不发版**（等用户发话——版本号纪律）。
