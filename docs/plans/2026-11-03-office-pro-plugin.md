# office-pro 插件实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 office 文档生成能力迁移为 `office-pro` 插件（run_js 沙箱代码执行 + office-authoring skill + 文档工程师预置 agent），验收通过后下线核心 office 生成类工具（先立后破）。

**Architecture:** 三层——① 沙箱层：`resolveSandboxedSpawn`（任意 argv 包裹，net-off 固定）+ `execSandboxed`（spawn/收集/超时强杀/截断）经 ToolContext 注入；② 插件层：`run_js` 工具（声明式输出记账）+ bootstrap（vendor 库注入 + fs 写守卫）+ momo-libs（chart/pptx-zip 移植 + validate 新库）；③ 引导层：SKILL.md + 预置 agent YAML。M4 删除核心生成路径（读留写删）。

**Tech Stack:** Electron 主进程 CJS / TypeScript strict / vitest / pptxgenjs·exceljs·docx·pdfkit·adm-zip（vendor 锁版）/ OS 沙箱（seatbelt·bwrap，win32 plain）

**Spec:** `docs/specs/2026-11-03-office-pro-plugin-design.md`（计划与 spec 冲突时以 spec 为准；执行者应同时持有两份）

## Global Constraints

- Node 24：先 `nvm use 24`（.nvmrc 已钉）；pnpm 一律 `npx pnpm@9.0.0`
- TypeScript strict：禁 `any` / `@ts-ignore` / `as any`（ESLint no-explicit-any error）。**插件 JS 文件不在 tsc 范围内**——类型安全靠测试覆盖兜底
- 注释/文档一律中文；标识符英文
- Conventional Commits（`feat:` / `test:` / `refactor:` / `chore:`）；特性 commit 不动版本号（Task 12 收尾统一三处 package.json alpha +1）
- electron 主进程 CJS；插件工具模块纯 CJS，**不得 require electron 或 app 内部模块**（沙箱执行/记账经 ToolContext 注入）
- 单测位置：electron/tests/ 镜像 src；插件文件测试放 `electron/tests/agent/tools/officepro/`（经仓库根相对路径 require 被测 JS）
- momo-test-rules：真链优先（真 spawn / 真 require / 真文件系统），mock 简化需显式理由
- 单测命令：`cd electron && npx pnpm@9.0.0 vitest run tests/<path>`
- vitest 非正常退出（exit 139/137）后必须检查清理孤儿 worker（AGENTS.md 陷阱表）

## Review Focus

以下五类「spec 隐含但易咬人」的输入/失效模式，每个都由归属任务的测试锁定：

1. **outputs/脚本路径越界**（`../`、绝对路径、symlink）→ run_js 执行前拒绝 → Task 6 测试 `outputs 越界 → 抛错`
2. **死循环/超时脚本** → 进程组强杀，Promise 必 resolve（不挂死会话）→ Task 2 测试 `死循环 → 超时强杀`
3. **stdout/stderr 输出炸弹**（数 MB）→ `maxOutputBytes` 截断并标注 → Task 2 测试 `输出炸弹 → 截断`
4. **脚本写 workspace/tmp 之外**（如 `~/.ssh`）→ bootstrap fs 写守卫拒绝 → Task 5 测试 `越界写 → 守卫拒绝`；**未列入 outputs 的写入不入账**（与 bash 对等语义）→ Task 6 测试 `未声明产物不记账`
5. **宿主设施缺失降级**：execSandboxed 未注入 → run_js 明确报错拒跑（不裸 spawn）→ Task 6 测试；vendor 未构建 → bootstrap 报错指引 `build.sh`（小白可自诊）→ Task 5/7 测试

---

### Task 1: 沙箱任意 argv 包裹变体 `resolveSandboxedSpawn`（M1）

**Files:**
- Modify: `electron/src/main/sandbox/index.ts`（新增导出，不动 `resolveShellSpawn`）
- Test: `electron/tests/sandbox/sandboxed-spawn.test.ts`

**Interfaces:**
- Consumes: 既有 `buildPolicy` / `buildBwrapArgs` / `renderSeatbeltProfile` / `getSandboxState` / `getSandboxSettings` / `cacheEnvAdditions` / `sandboxInstallHint`（均在 sandbox/index.ts 或其依赖内）
- Produces: `resolveSandboxedSpawn(workspaceDir: string, argv: string[]): SpawnPlan`——`SpawnPlan` 复用 `sandbox/types.ts` 现有三态类型。Task 2 的 `execSandboxed` 消费它

- [ ] **Step 1: 查既有 sandbox 测试的状态注入范式**

打开 `electron/tests/sandbox/` 下任一既有测试，确认 `__setSandboxStateForTest` / `__setSandboxSettingsForTest` 的入参形状（`SandboxProbeState` 与 settings 对象）。若与 Step 2 代码不一致，以既有测试形状为准修正测试代码。

- [ ] **Step 2: 写失败测试**

```typescript
// electron/tests/sandbox/sandboxed-spawn.test.ts
//
// resolveSandboxedSpawn 锁（spec 2026-11-03 §5.2）：任意 argv 包裹、网络恒关、
// 三态语义与 resolveShellSpawn 对齐。平台分支用 skipIf 保证跨宿主绿。
import fs from 'node:fs';
import os from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import {
  __setSandboxStateForTest,
  __setSandboxSettingsForTest,
  resolveSandboxedSpawn,
} from '../../src/main/sandbox';

const ARGV = [process.execPath, '/tmp/momo-boot-fake.js', '/ws'];

afterEach(() => {
  __setSandboxStateForTest(null);
  __setSandboxSettingsForTest({ mode: 'strict', networkPolicy: 'deny' });
});

describe('resolveSandboxedSpawn（任意 argv 包裹，net-off 固定）', () => {
  it('空 argv → 抛错', () => {
    expect(() => resolveSandboxedSpawn('/ws', [])).toThrow('argv');
  });

  it('沙箱不可用 + strict → blocked（含安装指引）', () => {
    __setSandboxStateForTest({ sandboxTool: 'none', unavailableReason: '单测模拟不可用' });
    const plan = resolveSandboxedSpawn('/ws', ARGV);
    expect(plan.kind).toBe('blocked');
    if (plan.kind === 'blocked') expect(plan.reason).toContain('沙箱');
  });

  it('沙箱不可用 + permissive → plain 直跑（tag 标注 unsandboxed）', () => {
    __setSandboxStateForTest({ sandboxTool: 'none', unavailableReason: '单测模拟不可用' });
    __setSandboxSettingsForTest({ mode: 'permissive', networkPolicy: 'deny' });
    const plan = resolveSandboxedSpawn('/ws', ARGV);
    expect(plan.kind).toBe('plain');
    if (plan.kind === 'plain') {
      expect(plan.shell).toBe(ARGV[0]);
      expect(plan.args).toEqual(ARGV.slice(1));
      expect(plan.tag).toContain('unsandboxed');
    }
  });

  it.skipIf(process.platform !== 'darwin')('darwin+seatbelt → wrapped：-f profile + argv 透传 + cleanupFiles', () => {
    __setSandboxStateForTest({ sandboxTool: 'seatbelt', unavailableReason: null });
    const plan = resolveSandboxedSpawn('/ws', ARGV);
    expect(plan.kind).toBe('wrapped');
    if (plan.kind === 'wrapped') {
      expect(plan.tag).toBe('seatbelt/net-off');
      expect(plan.args[0]).toBe('-f');
      expect(fs.existsSync(plan.args[1]!)).toBe(true); // profile 已写盘
      expect(plan.args.slice(2)).toEqual(ARGV);
      expect(plan.cleanupFiles).toHaveLength(1);
    }
  });

  it.skipIf(process.platform !== 'linux')('linux+bwrap → wrapped：bwrapArgs + argv 透传', () => {
    __setSandboxStateForTest({ sandboxTool: 'bwrap', unavailableReason: null });
    const plan = resolveSandboxedSpawn('/ws', ARGV);
    expect(plan.kind).toBe('wrapped');
    if (plan.kind === 'wrapped') {
      expect(plan.tag).toBe('bwrap/net-off');
      expect(plan.args.slice(-ARGV.length)).toEqual(ARGV);
    }
  });

  it('profile 落盘于 os.tmpdir（不污染 workspace）', () => {
    __setSandboxStateForTest(
      process.platform === 'darwin'
        ? { sandboxTool: 'seatbelt', unavailableReason: null }
        : { sandboxTool: 'none', unavailableReason: '非 darwin' },
    );
    const plan = resolveSandboxedSpawn('/ws', ARGV);
    if (plan.kind === 'wrapped' && plan.cleanupFiles.length > 0) {
      expect(plan.cleanupFiles[0]!.startsWith(os.tmpdir())).toBe(true);
    }
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/sandbox/sandboxed-spawn.test.ts`
Expected: FAIL——`resolveSandboxedSpawn` 未导出

- [ ] **Step 4: 实现**

在 `electron/src/main/sandbox/index.ts` 的 `resolveShellSpawn` 之后新增：

```typescript
/**
 * 受管任意 argv 沙箱包裹（office-pro 插件 run_js 消费，spec 2026-11-03 §5.2）。
 * 与 resolveShellSpawn 同源 policy 基建，差异两点：
 *  1) 包裹对象是任意 argv（argv[0]=可执行文件）而非 bash -c 命令串；
 *  2) 网络恒关——office 生成零联网诉求，不消费 bash 的动态网络授权
 *     （内网安全默认；net-off tag 透传给 LLM 自诊）。
 * 三态语义与 resolveShellSpawn 一致：wrapped / plain / blocked。
 */
export function resolveSandboxedSpawn(workspaceDir: string, argv: string[]): SpawnPlan {
  if (argv.length === 0) throw new Error('resolveSandboxedSpawn: argv 不能为空');
  const settings = getSandboxSettings();
  const policy = buildPolicy(workspaceDir, false, []);
  if (process.platform === 'win32') {
    // Windows 无 OS 沙箱（与 resolveShellSpawn win32 分支同基线）：直跑 + tag 标注
    return { kind: 'plain', shell: argv[0]!, args: argv.slice(1), tag: 'win-plain/net-off' };
  }
  const state = getSandboxState();
  if (process.platform === 'linux' && state?.sandboxTool === 'bwrap') {
    return {
      kind: 'wrapped', shell: 'bwrap',
      args: [...buildBwrapArgs(policy), ...argv],
      tag: 'bwrap/net-off', envAdditions: cacheEnvAdditions(policy.tmpDir), cleanupFiles: [],
    };
  }
  if (process.platform === 'darwin' && state?.sandboxTool === 'seatbelt') {
    const profilePath = path.join(os.tmpdir(), `momo-sbx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.sb`);
    fs.writeFileSync(profilePath, renderSeatbeltProfile(policy), 'utf-8');
    return {
      kind: 'wrapped', shell: 'sandbox-exec',
      args: ['-f', profilePath, ...argv],
      tag: 'seatbelt/net-off', envAdditions: cacheEnvAdditions(policy.tmpDir), cleanupFiles: [profilePath],
    };
  }
  const reason = state?.unavailableReason ?? '沙箱未探测';
  if (settings.mode === 'strict') {
    return { kind: 'blocked', reason: `OS 沙箱不可用（${reason}）。${sandboxInstallHint(process.platform)}` };
  }
  return { kind: 'plain', shell: argv[0]!, args: argv.slice(1), tag: `unsandboxed/net-off:${reason}` };
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/sandbox/sandboxed-spawn.test.ts`
Expected: PASS 全绿

- [ ] **Step 6: Commit**

```bash
git add electron/src/main/sandbox/index.ts electron/tests/sandbox/sandboxed-spawn.test.ts
git commit -m "feat: 沙箱层新增任意 argv 包裹变体 resolveSandboxedSpawn（office-pro 前置）"
```

---

### Task 2: `execSandboxed` 执行器 + ToolContext 设施注入（M1）

**Files:**
- Create: `electron/src/main/agent/tools/shared/sandboxed-exec.ts`
- Modify: `electron/src/main/agent/tools/types.ts`（ToolContext 新增两个可选设施）
- Test: `electron/tests/agent/tools/sandboxed-exec.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `resolveSandboxedSpawn`
- Produces:
  - `SandboxedExecRequest { argv; cwd; env?; timeoutMs; maxOutputBytes; abortSignal? }` / `SandboxedExecResult { exitCode; stdout; stderr; timedOut; aborted; truncated; spawnTag }`
  - `execSandboxed(req): Promise<SandboxedExecResult>`
  - `ToolContext.execSandboxed?` 与 `ToolContext.recordFileChange?: (toolName, relPath, op, before, after) => unknown`
  - Task 6 的 run_js 与 Task 7 冒烟测试消费 `execSandboxed`

- [ ] **Step 1: 写失败测试**

```typescript
// electron/tests/agent/tools/sandboxed-exec.test.ts
//
// execSandboxed 行为锁（spec 2026-11-03 §5.2）：env 白名单 / 超时强杀 /
// 输出炸弹截断 / abort 即时中止 / 退出码与 stdio 透传。
// 全用例钉死 permissive + state=null → plain 路径（不依赖宿主沙箱可用性）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { __setSandboxSettingsForTest, __setSandboxStateForTest } from '../../../src/main/sandbox';
import { execSandboxed } from '../../../src/main/agent/tools/shared/sandboxed-exec';

const NODE = process.execPath;
// 测试环境为纯 node：ELECTRON_RUN_AS_NODE 是 no-op（无害）；打包环境 execPath=
// electron 二进制，该 env 使其以 node 模式启动——协议由本测试锁定。
const ENV = { ELECTRON_RUN_AS_NODE: '1' };
const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-sbxexec-'));

afterEach(() => {
  __setSandboxStateForTest(null);
  __setSandboxSettingsForTest({ mode: 'permissive', networkPolicy: 'deny' });
});

describe('execSandboxed（plain 路径行为锁）', () => {
  it('成功执行：退出码与 stdout 透传', async () => {
    const r = await execSandboxed({ argv: [NODE, '-e', "console.log('hello-sbx')"], cwd: tmpWs, timeoutMs: 10_000, maxOutputBytes: 64 * 1024, env: ENV });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('hello-sbx');
    expect(r.timedOut).toBe(false);
  });

  it('非零退出码与 stderr 透传', async () => {
    const r = await execSandboxed({ argv: [NODE, '-e', "console.error('boom'); process.exit(3)"], cwd: tmpWs, timeoutMs: 10_000, maxOutputBytes: 64 * 1024, env: ENV });
    expect(r.exitCode).toBe(3);
    expect(r.stderr).toContain('boom');
  });

  it('Review Focus：死循环脚本 → 超时强杀，Promise 必 resolve', async () => {
    const r = await execSandboxed({ argv: [NODE, '-e', 'while(true){}'], cwd: tmpWs, timeoutMs: 1_500, maxOutputBytes: 64 * 1024, env: ENV });
    expect(r.timedOut).toBe(true);
  });

  it('Review Focus：输出炸弹 → maxOutputBytes 截断并标注', async () => {
    const r = await execSandboxed({ argv: [NODE, '-e', "process.stdout.write('x'.repeat(3_000_000))"], cwd: tmpWs, timeoutMs: 10_000, maxOutputBytes: 1_000, env: ENV });
    expect(Buffer.byteLength(r.stdout, 'utf-8')).toBeLessThanOrEqual(1_000);
    expect(r.truncated).toBe(true);
  });

  it('abortSignal → 即时中止', async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 150);
    const r = await execSandboxed({ argv: [NODE, '-e', 'while(true){}'], cwd: tmpWs, timeoutMs: 10_000, maxOutputBytes: 64 * 1024, env: ENV, abortSignal: ac.signal });
    expect(r.aborted).toBe(true);
  });

  it('env 白名单：非白名单父进程变量不泄露', async () => {
    process.env.MOMO_SECRET_LEAK = 'should-not-leak';
    try {
      const r = await execSandboxed({ argv: [NODE, '-e', "console.log(process.env.MOMO_SECRET_LEAK ?? 'clean')"], cwd: tmpWs, timeoutMs: 10_000, maxOutputBytes: 64 * 1024, env: ENV });
      expect(r.stdout).toContain('clean');
    } finally {
      delete process.env.MOMO_SECRET_LEAK;
    }
  });

  it('req.env 追加变量可见（ELECTRON_RUN_AS_NODE 协议锁定）', async () => {
    const r = await execSandboxed({ argv: [NODE, '-e', 'console.log(process.env.ELECTRON_RUN_AS_NODE)'], cwd: tmpWs, timeoutMs: 10_000, maxOutputBytes: 64 * 1024, env: ENV });
    expect(r.stdout.trim()).toBe('1');
  });

  it('strict + 沙箱不可用 → blocked 抛错（不静默降级）', async () => {
    __setSandboxStateForTest({ sandboxTool: 'none', unavailableReason: '单测模拟不可用' });
    __setSandboxSettingsForTest({ mode: 'strict', networkPolicy: 'deny' });
    await expect(execSandboxed({ argv: [NODE, '-e', ''], cwd: tmpWs, timeoutMs: 1_000, maxOutputBytes: 1_000 })).rejects.toThrow('沙箱');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/agent/tools/sandboxed-exec.test.ts`
Expected: FAIL——模块不存在

- [ ] **Step 3: 实现 sandboxed-exec.ts**

```typescript
// electron/src/main/agent/tools/shared/sandboxed-exec.ts
//
// 受管沙箱执行器（spec 2026-11-03 §5.2）：resolveSandboxedSpawn 决策 + spawn
// 收集 + 超时/中止进程组强杀 + 输出截断。office-pro 插件 run_js 的唯一执行
// 通道；env 白名单基座之外的环境变量一律不传入子进程（对齐 shell-tools 纪律）。
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import { resolveSandboxedSpawn } from '../../../sandbox';

export interface SandboxedExecRequest {
  /** 完整 argv（argv[0]=可执行文件绝对路径） */
  argv: string[];
  /** 工作目录（须为 workspace 目录——沙箱 policy 的写授权基准） */
  cwd: string;
  /** 追加 env（如 ELECTRON_RUN_AS_NODE）；白名单基座之上合并 */
  env?: Record<string, string>;
  /** 毫秒；到点杀进程组并标记 timedOut */
  timeoutMs: number;
  /** stdout / stderr 各自的字节上限；超出丢弃后续并标注 truncated */
  maxOutputBytes: number;
  abortSignal?: AbortSignal;
}

export interface SandboxedExecResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
  truncated: boolean;
  /** 沙箱形态 tag（seatbelt/net-off 等），调用方透传给 LLM 自诊 */
  spawnTag: string;
}

/** env 白名单基座：子进程仅可见这些继承变量 + 请求方显式追加项 */
const ENV_ALLOWLIST = [
  'PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL',
  'SYSTEMROOT', 'SYSTEMDRIVE', 'USERPROFILE', 'APPDATA', 'TEMP',
] as const;

function baseEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ENV_ALLOWLIST) {
    const v = process.env[key];
    if (typeof v === 'string' && v.length > 0) env[key] = v;
  }
  return env;
}

/** 杀进程组：POSIX kill(-pgid)（detached spawn 使 pid 即 pgid）；win 走 taskkill /T /F 杀树 */
function killTree(child: ChildProcess, isWin: boolean): void {
  if (typeof child.pid !== 'number') return;
  if (isWin) {
    void spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* 进程已退出：no-op */ }
  }
}

export async function execSandboxed(req: SandboxedExecRequest): Promise<SandboxedExecResult> {
  const plan = resolveSandboxedSpawn(req.cwd, req.argv);
  if (plan.kind === 'blocked') throw new Error(plan.reason);
  const env: Record<string, string> = {
    ...baseEnv(),
    ...(plan.kind === 'wrapped' ? plan.envAdditions : {}),
    ...(req.env ?? {}),
  };
  const isWin = process.platform === 'win32';
  const child = spawn(plan.shell, plan.args, {
    cwd: req.cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: !isWin, // POSIX 进程组长语义：kill(-pid) 杀全组
    windowsHide: true,
  });
  let stdout = Buffer.alloc(0);
  let stderr = Buffer.alloc(0);
  let truncated = false;
  let timedOut = false;
  let aborted = false;
  let settled = false;

  const cap = (chunk: Buffer, sink: 'out' | 'err'): void => {
    const cur = sink === 'out' ? stdout : stderr;
    if (cur.length >= req.maxOutputBytes) { truncated = true; return; }
    const room = req.maxOutputBytes - cur.length;
    const taken = chunk.length <= room ? chunk : chunk.subarray(0, room);
    if (taken.length < chunk.length) truncated = true;
    const next = Buffer.concat([cur, taken]);
    if (sink === 'out') stdout = next; else stderr = next;
  };
  child.stdout?.on('data', (c: Buffer) => cap(c, 'out'));
  child.stderr?.on('data', (c: Buffer) => cap(c, 'err'));

  return await new Promise<SandboxedExecResult>((resolve) => {
    const timer = setTimeout(() => { timedOut = true; killTree(child, isWin); }, req.timeoutMs);
    const onAbort = (): void => { aborted = true; killTree(child, isWin); };
    req.abortSignal?.addEventListener('abort', onAbort, { once: true });
    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.abortSignal?.removeEventListener('abort', onAbort);
      for (const f of plan.kind === 'wrapped' ? plan.cleanupFiles : []) {
        try { fs.unlinkSync(f); } catch { /* 清理失败无碍 */ }
      }
      resolve({
        exitCode: code,
        stdout: stdout.toString('utf-8'),
        stderr: stderr.toString('utf-8'),
        timedOut, aborted, truncated,
        spawnTag: plan.tag,
      });
    };
    child.on('close', (code) => finish(code));
    child.on('error', () => finish(null));
  });
}
```

- [ ] **Step 4: 扩展 ToolContext（types.ts）**

在 `electron/src/main/agent/tools/types.ts` 文件头补 import，并在 `ToolContext` 接口尾部（`userDataDir` 之后）新增：

```typescript
import type { SandboxedExecRequest, SandboxedExecResult } from './shared/sandboxed-exec';
```

```typescript
  /**
   * v2.1 office-pro（spec 2026-11-03 §5.2）：受管沙箱执行（决策 + 收集 + 超时/
   * 中止强杀 + 输出截断）。插件工具无法 import 内部模块，经 ctx 注入；未注入
   * （旧调用方/单测直调）时消费方必须拒绝执行，不得降级裸 spawn。
   */
  execSandboxed?: (req: SandboxedExecRequest) => Promise<SandboxedExecResult>;
  /** v2.1 office-pro：变更账本记账薄封装（recordChangeSafe 同参语义；toolName 用完整工具名） */
  recordFileChange?: (
    toolName: string,
    relPath: string,
    op: 'create' | 'modify' | 'delete',
    before: string | Buffer | null,
    after: string | Buffer | null,
  ) => unknown;
```

- [ ] **Step 5: 跑测试 + typecheck**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/agent/tools/sandboxed-exec.test.ts && cd .. && npx pnpm@9.0.0 typecheck`
Expected: PASS / typecheck 无错

- [ ] **Step 6: Commit**

```bash
git add electron/src/main/agent/tools/shared/sandboxed-exec.ts electron/src/main/agent/tools/types.ts electron/tests/agent/tools/sandboxed-exec.test.ts
git commit -m "feat: execSandboxed 受管沙箱执行器 + ToolContext 设施注入点"
```

---

### Task 3: office-pro 插件骨架 + momo-validate（M2）

**Files:**
- Create: `plugins/office-pro/manifest.json`、`plugins/office-pro/vendor/package.json`、`plugins/office-pro/scripts/build.sh`、`plugins/office-pro/README.md`、`plugins/office-pro/vendor/momo-libs/momo-validate/index.js`
- Modify: `.gitignore`（新增 vendor/node_modules 排除）
- Test: `electron/tests/agent/tools/officepro/fixtures.ts`、`electron/tests/agent/tools/officepro/momo-validate.test.ts`

**Interfaces:**
- Produces: `validateOfficeFile(abs): { ok, errors }`（Task 7 冒烟消费）；fixtures 导出 `PLUGIN_ROOT` 与 `makeFakeVendor(root)`（Task 5/6 测试消费）；manifest 为 Task 9 校验对象

- [ ] **Step 1: 目录与基础文件**

```bash
mkdir -p plugins/office-pro/{tools,bootstrap,skills/office-authoring,agents,vendor/momo-libs/momo-validate,scripts}
```

`plugins/office-pro/manifest.json`：

```json
{
  "id": "office-pro",
  "name": "Office Pro",
  "version": "0.1.0",
  "description": "office 文档生成代码工坊：run_js 沙箱执行 + office-authoring 方法论 + 文档工程师预置",
  "minAppVersion": "2.1.0",
  "components": {
    "tools": "./tools",
    "skills": "./skills",
    "agents": "./agents"
  }
}
```

`plugins/office-pro/vendor/package.json`（执行时以 `electron/package.json` 现行锁定版本为准核对，尤其 adm-zip）：

```json
{
  "name": "office-pro-vendor",
  "version": "0.1.0",
  "private": true,
  "description": "office-pro 插件运行库（内网安装：npm --offline --cache <预置缓存> 或私服 registry）",
  "dependencies": {
    "pptxgenjs": "^4.0.1",
    "exceljs": "^4.4.0",
    "docx": "^9.7.1",
    "pdfkit": "^0.20.2",
    "adm-zip": "^0.5.16"
  }
}
```

`plugins/office-pro/scripts/build.sh`（写入后 `chmod +x`）：

```bash
#!/usr/bin/env bash
# office-pro vendor 构建：安装运行库到 vendor/node_modules（联网一次）。
# 内网替代：npm --offline --cache <预置缓存目录>，或 npm config set registry <私服>。
set -euo pipefail
cd "$(dirname "$0")/../vendor"
npm install --omit=dev --no-audit --no-fund
echo "vendor 就绪: $(pwd)/node_modules"
```

`.gitignore` 追加一行：`plugins/office-pro/vendor/node_modules/`

`plugins/office-pro/README.md`：安装（dev 目录安装 / 打包分发）、构建（scripts/build.sh）、能力（run_js + skill + 预置 agent）、Windows 无 OS 沙箱的安全基线说明（对齐 bash，bootstrap fs 守卫补偿）。

- [ ] **Step 2: 写失败测试（fixtures + validate）**

`electron/tests/agent/tools/officepro/fixtures.ts`：

```typescript
// 插件测试共享夹具：PLUGIN_ROOT 定位 + 假 vendor（单测不依赖 npm install）。
import fs from 'node:fs';
import path from 'node:path';

export const PLUGIN_ROOT = path.resolve(__dirname, '../../../../..', 'plugins/office-pro');

const FAKE_NPM_LIBS = ['pptxgenjs', 'exceljs', 'docx', 'pdfkit', 'adm-zip'] as const;

/** 造假 vendor：npm 库假包 + momo-libs 假实现（跑 bootstrap/run_js 链路单测用） */
export function makeFakeVendor(root: string): void {
  for (const name of FAKE_NPM_LIBS) {
    const dir = path.join(root, 'node_modules', name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version: '0.0.0-fake', main: 'index.js' }));
    fs.writeFileSync(path.join(dir, 'index.js'), `module.exports = { FAKE: '${name}' };\n`);
  }
  for (const name of ['momo-chart', 'momo-pptx-zip', 'momo-validate']) {
    const dir = path.join(root, 'momo-libs', name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.js'), `module.exports = { FAKE: '${name}' };\n`);
  }
}
```

`electron/tests/agent/tools/officepro/momo-validate.test.ts`：

```typescript
// momo-validate 行为锁（spec 2026-11-03 §5.2）：zip 完整性 / 必需部件 / XML 良构粗检。
// 夹具用 adm-zip 手工构造（不依赖 vendor 安装）。
import AdmZip from 'adm-zip';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PLUGIN_ROOT } from './fixtures';

interface ValidateResult { ok: boolean; errors: string[] }
const { validateOfficeFile } = require(path.join(PLUGIN_ROOT, 'vendor/momo-libs/momo-validate/index.js')) as {
  validateOfficeFile: (abs: string) => ValidateResult;
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-mv-'));

function zipWrite(name: string, entries: Array<[string, string]>): string {
  const zip = new AdmZip();
  for (const [entry, content] of entries) zip.addFile(entry, Buffer.from(content, 'utf-8'));
  const p = path.join(tmp, name);
  zip.writeZip(p);
  return p;
}

const XML = '<?xml version="1.0" encoding="UTF-8"?><p:presentation xmlns:p="urn:x"></p:presentation>';

describe('momo-validate（结构校验）', () => {
  it('合法最小 pptx → ok', () => {
    const f = zipWrite('ok.pptx', [
      ['[Content_Types].xml', XML],
      ['_rels/.rels', XML],
      ['ppt/presentation.xml', XML],
      ['ppt/slides/slide1.xml', XML],
    ]);
    expect(validateOfficeFile(f)).toEqual({ ok: true, errors: [] });
  });

  it('缺 [Content_Types].xml → 报缺部件', () => {
    const f = zipWrite('no-ct.pptx', [['ppt/presentation.xml', XML], ['_rels/.rels', XML]]);
    const r = validateOfficeFile(f);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('[Content_Types].xml'))).toBe(true);
  });

  it('根标签未闭合的 xml → 良构错误', () => {
    const broken = '<?xml version="1.0"?><p:presentation xmlns:p="urn:x">';
    const f = zipWrite('broken.pptx', [
      ['[Content_Types].xml', XML], ['_rels/.rels', XML], ['ppt/presentation.xml', broken],
    ]);
    expect(validateOfficeFile(f).ok).toBe(false);
  });

  it('随机字节（非 zip）→ 打不开报损坏', () => {
    const f = path.join(tmp, 'garbage.pptx');
    fs.writeFileSync(f, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(validateOfficeFile(f).ok).toBe(false);
  });

  it('不支持的扩展名 → 明确报错', () => {
    const r = validateOfficeFile('/tmp/a.exe');
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toContain('不支持的扩展名');
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/agent/tools/officepro/momo-validate.test.ts`
Expected: FAIL——momo-validate/index.js 不存在

- [ ] **Step 4: 实现 momo-validate（`plugins/office-pro/vendor/momo-libs/momo-validate/index.js`）**

```javascript
// office 产物结构校验（spec 2026-11-03 §5.2）：zip 完整性 + 关键部件存在性 +
// XML 良构粗检。定位是「agent 收工自查」而非 schema 级校验（Anthropic validate.py
// 的 JS 轻量版）——捕获损坏文件/缺部件，不保证 PowerPoint 语义合法。
'use strict';
const AdmZip = require('adm-zip');

/** 各格式的必需部件（zip entry 名） */
const REQUIRED_PARTS = {
  pptx: ['[Content_Types].xml', 'ppt/presentation.xml', '_rels/.rels'],
  xlsx: ['[Content_Types].xml', 'xl/workbook.xml', '_rels/.rels'],
  docx: ['[Content_Types].xml', 'word/document.xml', '_rels/.rels'],
};

/** XML 良构粗检：去声明/注释/CDATA 后做根级闭合配对（不引入完整 parser） */
function xmlRoughCheck(xml, part) {
  const errors = [];
  const body = xml.replace(/^\uFEFF/, '').trim();
  if (!body.startsWith('<')) return [`部件 ${part} 不以 < 开头（疑似二进制损坏）`];
  const stripped = body
    .replace(/<\?[\s\S]*?\?>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '');
  if (/^<([A-Za-z_][\w.:-]*)[\s\S]*?\/>/.test(stripped)) return errors; // 自闭合根：合法
  const open = /^<([A-Za-z_][\w.:-]*)/.exec(stripped);
  const close = /<\/([A-Za-z_][\w.:-]*)\s*>$/.exec(stripped);
  if (!open || !close || open[1] !== close[1]) {
    errors.push(`部件 ${part} 根标签未闭合（${open ? open[1] : '?'} vs ${close ? close[1] : '?'}）`);
  }
  return errors;
}

/**
 * 校验 office 产物。
 * @param {string} abs 产物绝对路径（支持 pptx / xlsx / docx）
 * @returns {{ ok: boolean, errors: string[] }}
 */
function validateOfficeFile(abs) {
  const ext = abs.slice(abs.lastIndexOf('.') + 1).toLowerCase();
  const required = REQUIRED_PARTS[ext];
  if (!required) return { ok: false, errors: [`不支持的扩展名: .${ext}（支持 pptx/xlsx/docx）`] };
  let zip;
  try {
    zip = new AdmZip(abs);
  } catch (err) {
    return { ok: false, errors: [`zip 无法打开（文件损坏）: ${err.message}`] };
  }
  const names = new Set(zip.getEntries().map((e) => e.entryName));
  const errors = [];
  for (const part of required) {
    if (!names.has(part)) errors.push(`缺少必需部件: ${part}`);
  }
  for (const entry of zip.getEntries()) {
    if (!/\.(xml|rels)$/.test(entry.entryName)) continue;
    const text = entry.getData().toString('utf-8');
    if (text.includes('\u0000')) errors.push(`部件 ${entry.entryName} 含 NUL 字节（疑似损坏）`);
    errors.push(...xmlRoughCheck(text, entry.entryName));
  }
  return { ok: errors.length === 0, errors };
}

module.exports = { validateOfficeFile };
```

- [ ] **Step 5: 跑测试确认通过**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/agent/tools/officepro/momo-validate.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add plugins/office-pro .gitignore electron/tests/agent/tools/officepro
git commit -m "feat: office-pro 插件骨架与 momo-validate 结构校验库"
```

---

### Task 4: momo-chart / momo-pptx-zip 移植（M2）

**Files:**
- Create: `plugins/office-pro/vendor/momo-libs/momo-chart/index.js`、`plugins/office-pro/vendor/momo-libs/momo-pptx-zip/index.js`
- Test: `electron/tests/agent/tools/officepro/momo-libs-port.test.ts`

**Interfaces:**
- Consumes（移植源，逐文件读后按原语义剥类型移植）:
  - `electron/src/main/agent/tools/office/chart-xml.ts`（buildChartXml、ChartData/ChartSeriesData/AnchorSpec 全套构建函数）
  - `electron/src/main/agent/tools/office/xlsx-zip.ts` + `excel.ts` 的 add_chart 注入路径（chart 部件挂载 / [Content_Types] 与 rels 更新 / 快照回注语义）
  - `electron/src/main/agent/tools/office/pptx-zip.ts`（fillPptTemplate 及其内部辅助）
  - `electron/src/main/agent/tools/office/format.ts` 的 `parseRange`（momo-chart 需要时随迁，保持自包含）
- Produces:
  - `momo-chart`: `buildChartXml(data) → string`（ChartData 形状与源一致，JSDoc 标注）+ `injectXlsxChart(xlsxBuffer, spec) → Buffer`，`spec = { sheetName, anchor: { from: {col,row}, to: {col,row} }, chart }`（anchor 0-based 列行）
  - `momo-pptx-zip`: `fillPptTemplate(templateBuffer, fills) → Buffer`（fills 形状与源一致）

- [ ] **Step 1: 写失败测试**

```typescript
// electron/tests/agent/tools/officepro/momo-libs-port.test.ts
//
// momo-libs 移植行为锁（spec 2026-11-03 §5.2/§6.1）：chart XML 构建与 xlsx 注入、
// pptx 模板填充。测试环境用 electron 侧依赖（exceljs/pptxgenjs/adm-zip——M4 前仍在）。
import AdmZip from 'adm-zip';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PLUGIN_ROOT } from './fixtures';

const momoChart = require(path.join(PLUGIN_ROOT, 'vendor/momo-libs/momo-chart/index.js'));
const momoPptxZip = require(path.join(PLUGIN_ROOT, 'vendor/momo-libs/momo-pptx-zip/index.js'));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-port-'));

const SERIES_A = {
  nameLiteral: '销量',
  catRef: '数据!$A$2:$A$4', catCache: ['Q1', 'Q2', 'Q3'],
  valRef: '数据!$B$2:$B$4', valCache: [120, 180, 150],
};

describe('momo-chart（自 chart-xml.ts 移植）', () => {
  it('buildChartXml：bar 双系列 → chartSpace + 2 ser + 双轴 + 标题', () => {
    const xml = momoChart.buildChartXml({
      type: 'bar', title: '季度销量',
      series: [SERIES_A, { ...SERIES_A, nameLiteral: '目标', valRef: '数据!$C$2:$C$4', valCache: [100, 160, 140] }],
    });
    expect(xml).toContain('<c:chartSpace');
    expect(xml.match(/<c:ser>/g)?.length).toBe(2);
    expect(xml).toContain('<c:catAx');
    expect(xml).toContain('<c:valAx');
    expect(xml).toContain('季度销量');
  });

  it('buildChartXml：pie → 无轴', () => {
    const xml = momoChart.buildChartXml({ type: 'pie', series: [SERIES_A] });
    expect(xml).toContain('<c:chartSpace');
    expect(xml).not.toContain('<c:catAx');
  });

  it('injectXlsxChart：exceljs 产物注入 → zip 含 chart 部件且 exceljs 可重开', async () => {
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('数据');
    ws.addRow(['季度', '销量']);
    ws.addRow(['Q1', 120]);
    ws.addRow(['Q2', 180]);
    ws.addRow(['Q3', 150]);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const out = momoChart.injectXlsxChart(buf, {
      sheetName: '数据',
      anchor: { from: { col: 3, row: 1 }, to: { col: 9, row: 16 } },
      chart: { type: 'bar', title: '季度销量', series: [SERIES_A] },
    });
    const zip = new AdmZip(out);
    expect(zip.getEntries().some((e: { entryName: string }) => e.entryName.includes('charts/chart1.xml'))).toBe(true);
    const reopen = new ExcelJS.Workbook();
    await reopen.xlsx.load(out); // 注入后 zip 仍完整（exceljs 可打开）
  });
});

describe('momo-pptx-zip（自 pptx-zip.ts 移植）', () => {
  it('fillPptTemplate：替换发生 + 输出过 momo-validate + 模板语义', async () => {
    const PptxGenJS = require('pptxgenjs');
    const { validateOfficeFile } = require(path.join(PLUGIN_ROOT, 'vendor/momo-libs/momo-validate/index.js'));
    // 占位符约定与 fills 形状以 pptx-zip.ts 源码为准（移植时同步移植
    // electron/tests/agent/tools/office/ 下既有 fill 用例的构造与断言方式，
    // 下方示例若与源签名不符，按源语义改写——锁行为不变：替换发生 + validate ok）
    const pptx = new PptxGenJS();
    pptx.addSlide().addText('{{TITLE}}', { x: 1, y: 1, w: 8, fontSize: 24 });
    const tpl = path.join(tmp, 'tpl.pptx');
    await pptx.writeFile({ fileName: tpl });
    const out = momoPptxZip.fillPptTemplate(fs.readFileSync(tpl), [{ title: '填充后的标题' }]);
    const outPath = path.join(tmp, 'filled.pptx');
    fs.writeFileSync(outPath, out);
    expect(validateOfficeFile(outPath).ok).toBe(true);
    expect(out.equals(fs.readFileSync(tpl))).toBe(false); // 确有替换发生
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/agent/tools/officepro/momo-libs-port.test.ts`
Expected: FAIL——两个 momo-libs 模块不存在

- [ ] **Step 3: 移植实现**

按以下清单逐文件移植（**逐函数对照源码，只剥类型不改逻辑；每个文件头注明移植来源与源 commit**）：

1. 读 `chart-xml.ts` 全文 → 移植全部构建函数到 `momo-chart/index.js`（TS interface 转 JSDoc；`parseRange` 从 `format.ts` 复制实现内联或放同目录 `parse-range.js`，保持自包含）
2. 读 `xlsx-zip.ts` + `excel.ts` 的 add_chart 注入路径 → 在 `momo-chart/index.js` 追加 `injectXlsxChart(xlsxBuffer, spec)`：exceljs 产物 zip 手术——新增 chart 部件、drawing 关系、[Content_Types] 与 sheet rels 更新（保留源实现的快照回注语义）
3. 读 `pptx-zip.ts` 全文 → 移植 `fillPptTemplate(buffer, fills)` 到 `momo-pptx-zip/index.js`（占位符替换约定、模板字节不动语义原样保留）
4. 若 Step 1 测试中 fills/占位符形状与源签名不符，以源语义为准改写测试断言（锁行为不变）

- [ ] **Step 4: 跑测试确认通过**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/agent/tools/officepro/momo-libs-port.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add plugins/office-pro/vendor/momo-libs electron/tests/agent/tools/officepro/momo-libs-port.test.ts
git commit -m "feat: chart-xml/pptx-zip 能力资产移植为 momo-chart/momo-pptx-zip 插件库"
```

---

### Task 5: bootstrap 沙箱入口（M2）

**Files:**
- Create: `plugins/office-pro/bootstrap/run.js`
- Test: `electron/tests/agent/tools/officepro/bootstrap.test.ts`

**Interfaces:**
- Consumes: Task 3 fixtures 的 `makeFakeVendor`
- Produces: argv 协议 `[exe, run.js, workspaceDir, scriptPath, vendorRoot]`；vendor 白名单裸名集合 `{pptxgenjs, exceljs, docx, pdfkit, adm-zip, momo-chart, momo-pptx-zip, momo-validate}`；退出码语义（0 成功 / 1 脚本异常 / 2 参数缺失 / 3 vendor 缺失）。Task 6 的 run_js 以此协议调用

- [ ] **Step 1: 写失败测试**

```typescript
// electron/tests/agent/tools/officepro/bootstrap.test.ts
//
// bootstrap 行为锁（spec 2026-11-03 §5.2）：vendor 白名单解析 / fs 写守卫 /
// 顶层 await / 异常退出码 / vendor 缺失自诊。直接 spawn 纯 node（测试环境
// ELECTRON_RUN_AS_NODE 为 no-op，协议不变）。
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PLUGIN_ROOT, makeFakeVendor } from './fixtures';

const BOOTSTRAP = path.join(PLUGIN_ROOT, 'bootstrap/run.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-boot-'));
const ws = path.join(tmp, 'ws');
fs.mkdirSync(ws, { recursive: true });
const vendor = path.join(tmp, 'vendor');
makeFakeVendor(vendor);

interface RunResult { code: number; stdout: string; stderr: string }

function run(script: string, vendorRoot = vendor): Promise<RunResult> {
  const scriptPath = path.join(tmp, `s-${Math.random().toString(36).slice(2)}.js`);
  fs.writeFileSync(scriptPath, script, 'utf-8');
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [BOOTSTRAP, ws, scriptPath, vendorRoot],
      { cwd: ws, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } },
      (err, stdout, stderr) => {
        const code = err && typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

describe('bootstrap 沙箱入口', () => {
  it('vendor 白名单解析：require(pptxgenjs) 命中 vendor 假包', async () => {
    const r = await run(`const p = require('pptxgenjs'); console.log(p.FAKE);`);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('pptxgenjs');
  });

  it('Review Focus：写 workspace/tmp 之外 → 守卫拒绝', async () => {
    const outside = path.join(path.parse(tmp).root, 'momo-evil-target.txt');
    const r = await run(
      `try { require('fs').writeFileSync(${JSON.stringify(outside)}, 'x'); console.log('SHOULD-NOT-PASS'); }` +
      ` catch (e) { console.log('GUARDED:' + e.message.slice(0, 9)); }`,
    );
    expect(r.stdout).toContain('GUARDED:沙箱写守卫拒绝');
    expect(r.stdout).not.toContain('SHOULD-NOT-PASS');
  });

  it('写 workspace 内 → 放行', async () => {
    const r = await run(`require('fs').writeFileSync('ok.txt', 'hi'); console.log('written');`);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('written');
    expect(fs.existsSync(path.join(ws, 'ok.txt'))).toBe(true);
  });

  it('顶层 await 可用', async () => {
    const r = await run(`await new Promise((r2) => setTimeout(r2, 30)); console.log('tla-ok');`);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('tla-ok');
  });

  it('未捕获异常 → 退出码 1 + stderr 透传', async () => {
    const r = await run(`throw new Error('boom-bootstrap');`);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('boom-bootstrap');
  });

  it('Review Focus：vendor 缺失 → 报错指引 build.sh，退出码 3', async () => {
    const emptyVendor = path.join(tmp, 'vendor-empty');
    fs.mkdirSync(emptyVendor, { recursive: true });
    const scriptPath = path.join(tmp, 'noop.js');
    fs.writeFileSync(scriptPath, '');
    const r = await new Promise<RunResult>((resolve) => {
      execFile(process.execPath, [BOOTSTRAP, ws, scriptPath, emptyVendor], { cwd: ws }, (err, _o, stderr) => {
        const code = err && typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 0;
        resolve({ code, stdout: '', stderr: String(stderr) });
      });
    });
    expect(r.code).toBe(3);
    expect(r.stderr).toContain('build.sh');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/agent/tools/officepro/bootstrap.test.ts`
Expected: FAIL——bootstrap/run.js 不存在

- [ ] **Step 3: 实现 bootstrap（`plugins/office-pro/bootstrap/run.js`）**

```javascript
#!/usr/bin/env node
// run_js 沙箱入口（spec 2026-11-03 §5.2；ELECTRON_RUN_AS_NODE 下运行）。
// argv: [exe, run.js, workspaceDir, scriptPath, vendorRoot]
// 职责：① vendor 库解析白名单注入 ② fs 写守卫（win32 主要补偿 + 全平台纵深）
//       ③ CJS 脚本执行（async 包裹 → 顶层 await 可用）
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const [, , workspaceDir, scriptPath, vendorRoot] = process.argv;
if (!workspaceDir || !scriptPath || !vendorRoot) {
  console.error('bootstrap 参数缺失：期望 argv = [exe, run.js, workspaceDir, scriptPath, vendorRoot]');
  process.exit(2);
}

// ① vendor 库解析：白名单裸名 → vendor 绝对路径（不设 NODE_PATH，防宿主串味）
const VENDOR_LIBS = {
  pptxgenjs: 'node_modules/pptxgenjs',
  exceljs: 'node_modules/exceljs',
  docx: 'node_modules/docx',
  pdfkit: 'node_modules/pdfkit',
  'adm-zip': 'node_modules/adm-zip',
  'momo-chart': 'momo-libs/momo-chart/index.js',
  'momo-pptx-zip': 'momo-libs/momo-pptx-zip/index.js',
  'momo-validate': 'momo-libs/momo-validate/index.js',
};
const vendorMissing = Object.keys(VENDOR_LIBS).filter((name) => {
  const p = path.join(vendorRoot, VENDOR_LIBS[name]);
  return !fs.existsSync(name.startsWith('momo-') ? p : path.join(p, 'package.json'));
});
if (vendorMissing.length > 0) {
  console.error(`vendor 库缺失: ${vendorMissing.join(', ')}——请先运行 plugins/office-pro/scripts/build.sh 安装依赖`);
  process.exit(3);
}
const origResolve = Module._resolveFilename;
Module._resolveFilename = function patched(request, ...rest) {
  if (Object.prototype.hasOwnProperty.call(VENDOR_LIBS, request)) {
    return path.join(vendorRoot, VENDOR_LIBS[request]);
  }
  return origResolve.call(this, request, ...rest);
};

// ② fs 写守卫：写目标仅允许 workspace 与 tmpdir（读不限）
const WRITE_PREFIXES = [path.resolve(workspaceDir), os.tmpdir()].map((p) => p + path.sep);
function assertWritable(target) {
  const abs = path.resolve(String(target));
  if (!WRITE_PREFIXES.some((pre) => abs.startsWith(pre))) {
    throw new Error(`沙箱写守卫拒绝（仅 workspace/tmp 可写）: ${abs}`);
  }
}
const FS_SYNC_FIRST = ['writeFileSync', 'appendFileSync', 'unlinkSync', 'mkdirSync', 'rmSync', 'truncateSync'];
const FS_SYNC_DST = ['renameSync', 'copyFileSync'];
for (const name of FS_SYNC_FIRST) {
  const orig = fs[name];
  if (typeof orig !== 'function') continue;
  fs[name] = function guarded(p, ...args) { assertWritable(p); return orig.call(fs, p, ...args); };
}
for (const name of FS_SYNC_DST) {
  const orig = fs[name];
  if (typeof orig !== 'function') continue;
  fs[name] = function guarded(src, dst, ...args) { assertWritable(dst); return orig.call(fs, src, dst, ...args); };
}
const fsp = fs.promises;
const FS_ASYNC_FIRST = ['writeFile', 'appendFile', 'unlink', 'mkdir', 'rm', 'truncate'];
const FS_ASYNC_DST = ['rename', 'copyFile'];
for (const name of FS_ASYNC_FIRST) {
  const orig = fsp[name];
  fsp[name] = function guarded(p, ...args) { assertWritable(p); return orig.apply(fsp, [p, ...args]); };
}
for (const name of FS_ASYNC_DST) {
  const orig = fsp[name];
  fsp[name] = function guarded(src, dst, ...args) { assertWritable(dst); return orig.apply(fsp, [src, dst, ...args]); };
}

// ③ 执行脚本：new Function 绑定 CJS 语义 + async 包裹（顶层 await 可用）
(async () => {
  const code = fs.readFileSync(scriptPath, 'utf-8');
  const moduleObj = { exports: {} };
  const runner = new Function(
    'require', 'module', 'exports', '__filename', '__dirname',
    `"use strict";\nreturn (async () => {\n${code}\n})();`,
  );
  await runner(require, moduleObj, moduleObj.exports, scriptPath, path.dirname(scriptPath));
  process.exit(0);
})().catch((err) => {
  console.error(err && err.stack ? err.stack : String(err));
  process.exit(1);
});
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/agent/tools/officepro/bootstrap.test.ts`
Expected: PASS 全绿

- [ ] **Step 5: Commit**

```bash
git add plugins/office-pro/bootstrap electron/tests/agent/tools/officepro/bootstrap.test.ts
git commit -m "feat: office-pro bootstrap 沙箱入口（vendor 注入 + fs 写守卫 + 顶层 await）"
```

---

### Task 6: tools/run_js.js 工具模块（M2）

**Files:**
- Create: `plugins/office-pro/tools/run_js.js`
- Test: `electron/tests/agent/tools/officepro/run-js.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `execSandboxed`（测试与 runtime 注入共用）、Task 5 的 bootstrap argv 协议、Task 3 fixtures
- Produces: 插件工具 `run_js`（loader 自动命名空间化为 `plugin:office-pro/run_js`），参数 `{ script, outputs?, timeout_ms? }`，返回文本含 `spawnTag / 退出码 / stdout / stderr / 记账行`

- [ ] **Step 0: 读 read-tracker 真实 API**

打开 `electron/src/main/agent/tools/shared/read-tracker.ts` 与 `office-tools.ts` 的 `assertReadForOffice`，确认「已存在文件未读 → 拒绝覆盖」的断言方法名与签名。Step 3 代码中的 `ctx.readTracker.assertRead?.(ctx.roomId, abs)` 若与真实 API 不符，按真实签名改写（语义不变）。

- [ ] **Step 1: 写失败测试**

```typescript
// electron/tests/agent/tools/officepro/run-js.test.ts
//
// run_js 工具全链路锁（spec 2026-11-03 §5.2）：真 loadPluginToolModules 装配 +
// 真 execSandboxed + 真 bootstrap + 假 vendor（不依赖 npm install）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __setSandboxSettingsForTest, __setSandboxStateForTest } from '../../../../src/main/sandbox';
import { execSandboxed } from '../../../../src/main/agent/tools/shared/sandboxed-exec';
import { loadPluginToolModules } from '../../../../src/main/agent/tools/plugin-tools';
import type { PluginToolRef } from '../../../../src/main/agent/runtime-config';
import type { ToolContext } from '../../../../src/main/agent/tools/types';
import { WorkspaceFS } from '../../../../src/main/files/workspace-fs';
import { PLUGIN_ROOT, makeFakeVendor } from './fixtures';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-runjs-'));
const wsDir = path.join(tmp, 'ws');
fs.mkdirSync(wsDir, { recursive: true });
// 真 vendor 目录不存在 → 用假 vendor 顶替：把假 vendor 造在插件 vendor/ 下会被
// .gitignore 排除且污染插件目录，故测试用「临时插件根」——复制 bootstrap/tools 到
// tmp，vendor 用假件（结构等价，协议不变）。
const testPluginRoot = path.join(tmp, 'office-pro');
fs.mkdirSync(testPluginRoot, { recursive: true });
fs.mkdirSync(path.join(testPluginRoot, 'tools'), { recursive: true });
fs.mkdirSync(path.join(testPluginRoot, 'bootstrap'), { recursive: true });
fs.copyFileSync(path.join(PLUGIN_ROOT, 'bootstrap/run.js'), path.join(testPluginRoot, 'bootstrap/run.js'));
fs.copyFileSync(path.join(PLUGIN_ROOT, 'tools/run_js.js'), path.join(testPluginRoot, 'tools/run_js.js'));
makeFakeVendor(path.join(testPluginRoot, 'vendor'));

interface JournalEntry { toolName: string; rel: string; op: string; before: Buffer | null }

function mkCtx(over: Partial<ToolContext> = {}): ToolContext {
  const journal: JournalEntry[] = [];
  const ctx: ToolContext = {
    wsFs: new WorkspaceFS(wsDir),
    workspaceId: 'ws1',
    workspaceDir: wsDir,
    skillRegistry: {} as ToolContext['skillRegistry'],
    streamSessionId: 'test-stream',
    roomId: 'test-room',
    sendStreamChunk: () => {},
    permissionConfig: { allowedTools: [], deniedTools: [] },
    creatorUserId: '',
    execSandboxed,
    recordFileChange: (toolName, rel, op, before) => { journal.push({ toolName, rel, op, before: before as Buffer | null }); },
    readTracker: { add: vi.fn() } as ToolContext['readTracker'],
    ...over,
  };
  (ctx as { __journal?: JournalEntry[] }).__journal = journal;
  return ctx;
}

function loadTools() {
  const ref: PluginToolRef = {
    pluginId: 'office-pro',
    rootDir: testPluginRoot,
    modulePaths: [path.join(testPluginRoot, 'tools/run_js.js')],
    dataDir: path.join(tmp, 'data'),
    config: {},
  };
  const { modules, failures } = loadPluginToolModules([ref], vi.fn());
  expect(failures).toHaveLength(0);
  return modules[0]!;
}

beforeEach(() => {
  __setSandboxStateForTest(null);
  __setSandboxSettingsForTest({ mode: 'permissive', networkPolicy: 'deny' });
});
afterEach(() => {
  __setSandboxStateForTest(null);
  __setSandboxSettingsForTest({ mode: 'strict', networkPolicy: 'deny' });
});

describe('run_js 工具模块', () => {
  it('装配：命名空间 plugin:office-pro/run_js + 前缀门禁', () => {
    const m = loadTools();
    expect(m.getDefs().map((d) => d.name)).toEqual(['plugin:office-pro/run_js']);
    expect(m.handles('plugin:office-pro/run_js')).toBe(true);
    expect(m.handles('run_js')).toBe(false);
  });

  it('成功路径：产物写入 + create 记账 + 返回文本含记账行', async () => {
    const m = loadTools();
    const ctx = mkCtx();
    const r = await m.execute('plugin:office-pro/run_js', {
      script: `require('fs').writeFileSync('ok.txt', 'hello'); console.log('done');`,
      outputs: ['ok.txt'],
      timeout_ms: 20000,
    }, ctx);
    expect(r).toContain('退出码=0');
    expect(r).toContain('done');
    expect(r).toContain('ok.txt: create 已记账');
    const journal = (ctx as { __journal: JournalEntry[] }).__journal;
    expect(journal).toEqual([{ toolName: 'plugin:office-pro/run_js', rel: 'ok.txt', op: 'create', before: null }]);
    expect(fs.existsSync(path.join(wsDir, 'ok.txt'))).toBe(true);
  });

  it('Review Focus：outputs 越界（../）→ 执行前抛错', async () => {
    const m = loadTools();
    await expect(m.execute('plugin:office-pro/run_js', {
      script: `console.log(1)`, outputs: ['../evil.txt'],
    }, mkCtx())).rejects.toThrow();
  });

  it('Review Focus：未声明产物不记账（只记 outputs 列表）', async () => {
    const m = loadTools();
    const ctx = mkCtx();
    await m.execute('plugin:office-pro/run_js', {
      script: `require('fs').writeFileSync('a.txt','1'); require('fs').writeFileSync('b.txt','2');`,
      outputs: ['a.txt'],
      timeout_ms: 20000,
    }, ctx);
    const journal = (ctx as { __journal: JournalEntry[] }).__journal;
    expect(journal).toHaveLength(1);
    expect(journal[0]!.rel).toBe('a.txt');
    expect(fs.existsSync(path.join(wsDir, 'b.txt'))).toBe(true); // 文件在，只是不入账
  });

  it('覆盖已存在文件且未读 → readTracker 门禁抛错（对齐 office 写工具）', async () => {
    const m = loadTools();
    fs.writeFileSync(path.join(wsDir, 'exist.txt'), 'old');
    const ctx = mkCtx({
      readTracker: {
        add: vi.fn(),
        assertRead: () => { throw new Error('文件已存在但本会话未读取——先 office_read 再覆盖'); },
      } as ToolContext['readTracker'],
    });
    await expect(m.execute('plugin:office-pro/run_js', {
      script: `require('fs').writeFileSync('exist.txt','new');`,
      outputs: ['exist.txt'],
      timeout_ms: 20000,
    }, ctx)).rejects.toThrow('未读取');
  });

  it('Review Focus：execSandboxed 未注入 → 明确报错拒跑', async () => {
    const m = loadTools();
    const ctx = mkCtx();
    delete (ctx as { execSandboxed?: unknown }).execSandboxed;
    await expect(m.execute('plugin:office-pro/run_js', { script: `console.log(1)` }, ctx)).rejects.toThrow('execSandboxed');
  });

  it('script 超 64KB → 抛错提示拆分', async () => {
    const m = loadTools();
    await expect(m.execute('plugin:office-pro/run_js', {
      script: '//' + 'x'.repeat(70 * 1024),
    }, mkCtx())).rejects.toThrow('64KB');
  });

  it('脚本失败 → 返回文本含退出码与 stderr', async () => {
    const m = loadTools();
    const r = await m.execute('plugin:office-pro/run_js', {
      script: `console.error('script-boom'); process.exit(1);`,
      timeout_ms: 20000,
    }, mkCtx());
    expect(r).toContain('退出码=1');
    expect(r).toContain('script-boom');
  });

  it('死循环 + timeout_ms=1000 → 超时强杀标注，Promise 必 resolve', async () => {
    const m = loadTools();
    const r = await m.execute('plugin:office-pro/run_js', {
      script: `while(true){}`, timeout_ms: 1000,
    }, mkCtx());
    expect(r).toContain('超时');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/agent/tools/officepro/run-js.test.ts`
Expected: FAIL——tools/run_js.js 不存在

- [ ] **Step 3: 实现 run_js（`plugins/office-pro/tools/run_js.js`）**

```javascript
// run_js：office 文档生成代码工坊（spec 2026-11-03 §5.2）。
// CJS 插件工具模块：纯 node 可达，不得 require electron / app 内部模块——
// 沙箱执行（execSandboxed）与变更记账（recordFileChange）均经 ToolContext 注入。
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const BOOTSTRAP = path.resolve(__dirname, '../bootstrap/run.js');
const VENDOR_ROOT = path.resolve(__dirname, '../vendor');
const SCRIPT_MAX_BYTES = 64 * 1024;
const OUTPUT_CAP_BYTES = 24 * 1024;

const DEF = {
  name: 'run_js',
  description:
    '在离线沙箱中执行 JavaScript 生成/改造 office 文档（pptx/xlsx/docx/pdf）。' +
    '预置库：pptxgenjs / exceljs / docx / pdfkit / adm-zip / momo-chart（xlsx 原生图表注入）/' +
    'momo-pptx-zip（pptx 模板手术）/ momo-validate（产物结构校验）。' +
    '环境现实：无网络；仅 workspace 与系统 tmp 可写（越界写抛错）；超时默认 120s。' +
    '产物文件必须列入 outputs（记账与撤销的唯一依据，未声明写入不可撤销）。' +
    '收工前必须 require("momo-validate").validateOfficeFile 校验每个产物。',
  inputSchema: {
    type: 'object',
    properties: {
      script: { type: 'string', description: 'JS 源码（CommonJS，顶层 await 可用）。文件写 workspace 相对路径（cwd=workspace），上限 64KB' },
      outputs: { type: 'array', items: { type: 'string' }, description: '产物 workspace 相对路径列表（覆盖已存在文件需先 office_read 读过）' },
      timeout_ms: { type: 'number', description: '执行超时毫秒（默认 120000，钳制 [1000, 300000]）' },
    },
    required: ['script'],
  },
};

function parseOutputs(raw) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new Error('参数 outputs 必须是字符串数组');
  return raw.map((p, i) => {
    if (typeof p !== 'string' || p.length === 0) throw new Error(`outputs[${i}] 必须是非空字符串`);
    return p;
  });
}

module.exports.createTools = function createTools() {
  return {
    getDefs() { return [{ ...DEF }]; },
    getCatalog() {
      return [{
        name: 'run_js',
        displayName: 'run_js 代码工坊',
        description: DEF.description,
        category: '办公',
        categoryEmoji: '',
        defaultOn: false,
      }];
    },
    handles(name) { return name === 'run_js'; },
    async execute(name, args, ctx) {
      if (name !== 'run_js') throw new Error(`未知工具: ${name}`);
      // 宿主设施门禁：不降级裸跑（Review Focus #5）
      if (typeof ctx.execSandboxed !== 'function') {
        throw new Error('run_js 需要宿主注入 execSandboxed（App 版本过旧或运行时未装配）——请升级 Momo Studio');
      }
      const script = typeof args.script === 'string' ? args.script : '';
      if (script.length === 0) throw new Error('参数 script 缺失');
      if (Buffer.byteLength(script, 'utf-8') > SCRIPT_MAX_BYTES) {
        throw new Error(`参数 script 超过 ${SCRIPT_MAX_BYTES} 字节上限——拆分为多次小脚本执行`);
      }
      const outputs = parseOutputs(args.outputs);
      const timeoutMs = typeof args.timeout_ms === 'number'
        ? Math.min(Math.max(Math.round(args.timeout_ms), 1000), 300000)
        : 120000;

      // outputs 预检：越界拒绝 + 已存在文件 Read-before-Edit 门禁 + before 字节
      const tracked = outputs.map((rel) => {
        const abs = ctx.wsFs.assertInWorkspace(rel);
        const existed = fs.existsSync(abs);
        if (existed && ctx.readTracker && typeof ctx.readTracker.assertRead === 'function') {
          ctx.readTracker.assertRead(ctx.roomId, abs); // 未读 → 抛错（对齐 office 写工具门禁）
        }
        return { rel, abs, existed, before: existed ? fs.readFileSync(abs) : null };
      });

      if (!fs.existsSync(BOOTSTRAP) || !fs.existsSync(VENDOR_ROOT)) {
        throw new Error('插件安装不完整（bootstrap/vendor 缺失）——请重装 office-pro 插件');
      }

      const scriptPath = path.join(os.tmpdir(), `office-pro-${crypto.randomUUID()}.js`);
      fs.writeFileSync(scriptPath, script, 'utf-8');
      try {
        const res = await ctx.execSandboxed({
          argv: [process.execPath, BOOTSTRAP, ctx.workspaceDir, scriptPath, VENDOR_ROOT],
          cwd: ctx.workspaceDir,
          timeoutMs,
          maxOutputBytes: OUTPUT_CAP_BYTES,
          env: { ELECTRON_RUN_AS_NODE: '1' },
          abortSignal: ctx.abortSignal,
        });
        const lines = [
          `[run_js] 退出码=${res.exitCode === null ? 'null' : res.exitCode} 沙箱=${res.spawnTag}` +
            `${res.timedOut ? '（超时已强杀——缩小脚本或分批跑）' : ''}${res.aborted ? '（已中止）' : ''}`,
        ];
        if (res.stdout) lines.push('--- stdout ---', res.stdout);
        if (res.stderr) lines.push('--- stderr ---', res.stderr);
        if (res.truncated) lines.push('（输出超限已截断）');
        if (tracked.length > 0) {
          lines.push('--- 产物记账 ---');
          for (const t of tracked) {
            const after = fs.existsSync(t.abs) ? fs.readFileSync(t.abs) : null;
            if (after === null) { lines.push(`${t.rel}: 未生成（不记账）`); continue; }
            const op = t.before === null ? 'create' : 'modify';
            if (typeof ctx.recordFileChange === 'function') {
              ctx.recordFileChange('plugin:office-pro/run_js', t.rel, op, t.before, after);
            }
            if (ctx.readTracker && typeof ctx.readTracker.add === 'function') {
              ctx.readTracker.add(ctx.roomId, t.abs, ctx.parentStreamSessionId);
            }
            lines.push(`${t.rel}: ${op}${typeof ctx.recordFileChange === 'function' ? ' 已记账（可撤销）' : '（记账不可用）'}`);
          }
          lines.push('（未列入 outputs 的写入不入账——与 bash 对等；请声明全部产物）');
        }
        return lines.filter((l) => l !== '').join('\n');
      } finally {
        try { fs.unlinkSync(scriptPath); } catch { /* tmp 清理失败无碍 */ }
      }
    },
  };
};
```

注：测试 mkCtx 中 `execSandboxed` 直传 Task 2 实现函数（签名一致）；`ctx.abortSignal` 由 `SandboxedExecRequest.abortSignal` 承接。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/agent/tools/officepro/run-js.test.ts`
Expected: PASS 全绿

- [ ] **Step 5: Commit**

```bash
git add plugins/office-pro/tools electron/tests/agent/tools/officepro/run-js.test.ts
git commit -m "feat: run_js 插件工具——沙箱执行 + 声明式输出记账"
```

---

### Task 7: vendor 构建落地 + 生成冒烟（M2 收口）

**Files:**
- Create: `electron/tests/agent/tools/officepro/generation-smoke.test.ts`
- 运行 `plugins/office-pro/scripts/build.sh` 产出真 vendor

**Interfaces:**
- Consumes: Task 3-6 全部产物；`electron/package.json` 现行依赖版本（vendor 锁版对齐）
- Produces: 真 vendor（`plugins/office-pro/vendor/node_modules/`，gitignored）；冒烟测试在 vendor 缺失时 skip 并说明

- [ ] **Step 1: 构建 vendor**

Run: `bash plugins/office-pro/scripts/build.sh`
Expected: `vendor 就绪` 输出；`plugins/office-pro/vendor/node_modules/pptxgenjs` 存在

- [ ] **Step 2: 写生成冒烟测试（真库全链路）**

```typescript
// electron/tests/agent/tools/officepro/generation-smoke.test.ts
//
// 生成冒烟（spec 2026-11-03 §9.2 前置）：真 vendor + 真 run_js 链路。
// vendor 未构建时整体 skip（提示先跑 build.sh）——CI 无 vendor 不红，本地验收必跑。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { __setSandboxSettingsForTest, __setSandboxStateForTest } from '../../../../src/main/sandbox';
import { execSandboxed } from '../../../../src/main/agent/tools/shared/sandboxed-exec';
import { loadPluginToolModules } from '../../../../src/main/agent/tools/plugin-tools';
import type { PluginToolRef } from '../../../../src/main/agent/runtime-config';
import type { ToolContext } from '../../../../src/main/agent/tools/types';
import { WorkspaceFS } from '../../../../src/main/files/workspace-fs';
import { PLUGIN_ROOT } from './fixtures';

const VENDOR_OK = fs.existsSync(path.join(PLUGIN_ROOT, 'vendor/node_modules/pptxgenjs'));

describe.skipIf(!VENDOR_OK)('office-pro 生成冒烟（真 vendor 全链路；未构建请先跑 scripts/build.sh）', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-smoke-'));
  const wsDir = path.join(tmp, 'ws');
  fs.mkdirSync(wsDir, { recursive: true });

  beforeEach(() => {
    __setSandboxStateForTest(null);
    __setSandboxSettingsForTest({ mode: 'permissive', networkPolicy: 'deny' });
  });

  function mkCtx(): ToolContext & { __journal: Array<{ rel: string; op: string }> } {
    const journal: Array<{ rel: string; op: string }> = [];
    const ctx = {
      wsFs: new WorkspaceFS(wsDir),
      workspaceId: 'ws1',
      workspaceDir: wsDir,
      skillRegistry: {} as ToolContext['skillRegistry'],
      streamSessionId: 's',
      roomId: 'r',
      sendStreamChunk: () => {},
      permissionConfig: { allowedTools: [], deniedTools: [] },
      creatorUserId: '',
      execSandboxed,
      recordFileChange: (_t: string, rel: string, op: string) => { journal.push({ rel, op }); },
      readTracker: { add: vi.fn() } as ToolContext['readTracker'],
      __journal: journal,
    } as ToolContext & { __journal: Array<{ rel: string; op: string }> };
    return ctx;
  }

  function loadTools() {
    const ref: PluginToolRef = {
      pluginId: 'office-pro', rootDir: PLUGIN_ROOT,
      modulePaths: [path.join(PLUGIN_ROOT, 'tools/run_js.js')],
      dataDir: path.join(tmp, 'data'), config: {},
    };
    const { modules, failures } = loadPluginToolModules([ref], vi.fn());
    expect(failures).toHaveLength(0);
    return modules[0]!;
  }

  it('pptxgenjs：run_js 产出 2 页 pptx → momo-validate ok + 记账 create', async () => {
    const m = loadTools();
    const ctx = mkCtx();
    const r = await m.execute('plugin:office-pro/run_js', {
      script: `
        const PptxGenJS = require('pptxgenjs');
        const pptx = new PptxGenJS();
        pptx.defineLayout({ name: 'W', width: 10, height: 5.625 });
        pptx.layout = 'W';
        pptx.addSlide().addText('冒烟标题', { x: 0.6, y: 0.5, w: 8.8, h: 0.8, fontSize: 28, bold: true, color: '2D3436' });
        pptx.addSlide().addText('第二页', { x: 0.6, y: 0.5, w: 8.8, fontSize: 18 });
        pptx.writeFile({ fileName: 'smoke.pptx' }).then(() => {
          const path = require('path');
          const { validateOfficeFile } = require('momo-validate');
          console.log('VALIDATE=' + JSON.stringify(validateOfficeFile(path.resolve('smoke.pptx'))));
        });
      `,
      outputs: ['smoke.pptx'],
      timeout_ms: 60000,
    }, ctx);
    expect(r).toContain('退出码=0');
    expect(r).toContain('VALIDATE={"ok":true');
    expect(r).toContain('smoke.pptx: create 已记账');
    expect(ctx.__journal).toEqual([{ rel: 'smoke.pptx', op: 'create' }]);
    expect(fs.existsSync(path.join(wsDir, 'smoke.pptx'))).toBe(true);
  });

  it('exceljs + momo-chart：xlsx + 原生图表注入 → validate ok + chart 部件存在', async () => {
    const m = loadTools();
    const ctx = mkCtx();
    const r = await m.execute('plugin:office-pro/run_js', {
      script: `
        const ExcelJS = require('exceljs');
        const { injectXlsxChart } = require('momo-chart');
        const fs = require('fs');
        const path = require('path');
        (async () => {
          const wb = new ExcelJS.Workbook();
          const ws = wb.addWorksheet('数据');
          ws.addRow(['季度', '销量']); ws.addRow(['Q1', 120]); ws.addRow(['Q2', 180]); ws.addRow(['Q3', 150]);
          await wb.xlsx.writeFile('smoke.xlsx');
          const buf = fs.readFileSync('smoke.xlsx');
          fs.writeFileSync('smoke.xlsx', injectXlsxChart(buf, {
            sheetName: '数据',
            anchor: { from: { col: 3, row: 1 }, to: { col: 9, row: 16 } },
            chart: { type: 'bar', title: '季度销量', series: [{ nameLiteral: '销量', catRef: '数据!$A$2:$A$4', catCache: ['Q1','Q2','Q3'], valRef: '数据!$B$2:$B$4', valCache: [120,180,150] }] },
          }));
          const AdmZip = require('adm-zip');
          const zip = new AdmZip('smoke.xlsx');
          console.log('CHART=' + zip.getEntries().some((e) => e.entryName.includes('charts/chart1.xml')));
          const { validateOfficeFile } = require('momo-validate');
          console.log('VALIDATE=' + JSON.stringify(validateOfficeFile(path.resolve('smoke.xlsx'))));
        })();
      `,
      outputs: ['smoke.xlsx'],
      timeout_ms: 60000,
    }, ctx);
    expect(r).toContain('退出码=0');
    expect(r).toContain('CHART=true');
    expect(r).toContain('VALIDATE={"ok":true');
  });
});
```

- [ ] **Step 3: 跑冒烟测试**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/agent/tools/officepro/generation-smoke.test.ts`
Expected: PASS（2 用例；若 skip 则说明 vendor 未构建，回 Step 1）

- [ ] **Step 4: Commit**

```bash
git add electron/tests/agent/tools/officepro/generation-smoke.test.ts
git commit -m "test: office-pro 真 vendor 生成冒烟（pptx/xlsx+原生图表/validate 全链路）"
```

---

### Task 8: office-authoring SKILL.md（M3）

**Files:**
- Create: `plugins/office-pro/skills/office-authoring/SKILL.md`
- Test: `electron/tests/agent/tools/officepro/skill-md.test.ts`

**Interfaces:**
- Consumes: SKILL.md frontmatter 格式（`parseSkillMd`：name/description 必填，version/allowedTools/tags 可选；slug=目录名 `office-authoring`）
- Produces: skill 正文（Task 9 的 agent defaultSkills 引用）

- [ ] **Step 1: 写失败测试**

```typescript
// electron/tests/agent/tools/officepro/skill-md.test.ts
// SKILL.md 格式锁（spec 2026-11-03 §5.3）：frontmatter 必填字段 + 核心章节关键词。
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseSkillMd } from '../../../src/main/skill/loader';
import { PLUGIN_ROOT } from './fixtures';

const skillDir = path.join(PLUGIN_ROOT, 'skills/office-authoring');

describe('office-authoring SKILL.md', () => {
  it('parseSkillMd 通过（frontmatter 完整）', () => {
    const def = parseSkillMd(fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8'), skillDir);
    expect(def.slug).toBe('office-authoring');
    expect(def.name).toBeTruthy();
    expect(def.description).toBeTruthy();
  });

  it('正文含核心章节（决策树 / footgun / 设计规范 / QA）', () => {
    const def = parseSkillMd(fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf-8'), skillDir);
    for (const keyword of ['路径决策', 'footgun', '设计规范', 'QA', 'momo-validate', 'outputs']) {
      expect(def.body).toContain(keyword);
    }
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/agent/tools/officepro/skill-md.test.ts`
Expected: FAIL——SKILL.md 不存在

- [ ] **Step 3: 写入 SKILL.md 全文（`plugins/office-pro/skills/office-authoring/SKILL.md`）**

````markdown
---
name: office 文档创作
description: run_js 代码工坊方法论——路径决策树、库速查与 footgun 清单、设计规范红线、收工自查；产出 pptx/xlsx/docx/pdf 前必读
version: 1.0.0
tags: [office, pptx, xlsx, docx, pdf]
---

# Office 文档创作（run_js 代码工坊）

## 0. 能力地图与路径决策（先读这里）

| 需求 | 正确路径 |
|---|---|
| 读文档内容 / 精读 Excel 区域 | office_read / office_read_cells（禁用 run_js 做纯读取——浪费 token） |
| 从零生成 pptx / xlsx / docx / pdf | run_js 写代码 |
| 用户给了企业 .pptx 模板 | run_js + require('momo-pptx-zip') 模板手术（保品牌母版，禁从零仿制） |
| xlsx 要原生图表（双击可编辑） | run_js + exceljs 写数 + require('momo-chart').injectXlsxChart 注入 |
| 收工自查 | require('momo-validate').validateOfficeFile 逐产物校验 |

决策顺序：先问用户有无模板/品牌规范（配色、Logo、字体）→ 没有才从零写 → 复杂版式拆多次小脚本跑。

## 1. run_js 沙箱现实（每次动手前默念）

- **无网络**：任何 fetch / pip / npm 联网方案必败，不要尝试
- **可写目录**：仅 workspace 与系统 tmp；写其他路径直接抛错（沙箱写守卫）
- **预置库**：pptxgenjs / exceljs / docx / pdfkit / adm-zip / momo-chart / momo-pptx-zip / momo-validate，require 裸名即可
- **产物必列 outputs**：记账与撤销的唯一依据；未声明的写入不可撤销
- **超时**：默认 120s（上限 300s）；大数组分批写，不要一次构造全部内容
- 文件写 workspace 相对路径（cwd 就是 workspace）

## 2. pptxgenjs 速查与 footgun（踩过的坑，照做）

正确用法：
- 颜色 hex **不带 #**：`{ color: '1F4E79' }`
- 字距参数是 `charSpacing`（写 `letterSpacing` 静默失效）
- 双轴图必须 `valAxes` + `catAxes` 成对给出
- options 对象会被**原地 mutate**（内部做 EMU 换算）——同一个字面量不要复用
- 版面单位英寸；16:9 为 10 × 5.625

会损坏文件（PowerPoint 拒开，其他工具看不出来）：
- stacked 图表设 `dataLabelPosition: 'outEnd'`
- 颜色字符串带 `#`

常用 API：`new PptxGenJS()` → `defineLayout` / `addSlide()` → `addText(text, {x,y,w,h,fontSize,color,bold,align,valign})` / `addShape('rect', {...})` / `addTable(rows, {...})` / `addChart(type, data, {...})` / `addImage({ path })` → `writeFile({ fileName: 'x.pptx' })`

## 3. exceljs + momo-chart

- exceljs：`new ExcelJS.Workbook()` → `addWorksheet('名')` → `addRow` / `getCell('A1').value` → `workbook.xlsx.writeFile('x.xlsx')`
- 原生图表（纯 JS 生态唯一方案）：先 exceljs 写盘 → `injectXlsxChart(fs.readFileSync('x.xlsx'), { sheetName, anchor, chart })` → 写回。anchor 形如 `{ from: { col: 3, row: 1 }, to: { col: 9, row: 16 } }`（0-based 列行）
- 列宽 / 冻结窗格 / 数字格式 exceljs 原生支持；超大表用流式 `WorkbookWriter`

## 4. docx / pdfkit

- docx：`new Document({ sections: [{ children: [new Paragraph(...), new Table(...)] }] })` → `Packer.toBuffer` → fs 写盘
- pdfkit 中文**必须内嵌字体**，否则乱码：优先检查 pdfkit 内置注册字体；无中文字体时向用户说明改用 docx
- pdfkit 无自动表格：手动画行（moveTo/lineTo）或逐 cell 定位

## 5. 设计规范（反「AI 味」红线）

- NEVER：标题下加装饰线；页面顶部通栏色条压白字（旧工具的丑即此）；无意义色块；一页塞满
- ALWAYS：一页一个主张；字号阶梯 ≤ 3 档（28 / 18 / 14）；四周留白 ≥ 0.5 英寸；配色 3 色内（底色 / 主色 / 强调色），从内容主题推导而非默认深蓝
- 表格：斑马纹或仅横向分隔线；禁全边框网格
- 图表：一张图回答一个问题；数据点 ≤ 8 才全显数据标签

## 6. QA 收工自查（缺一不可）

1. `require('momo-validate').validateOfficeFile(path.resolve('产物路径'))` 每个产物 `ok:true`
2. 文本溢出自查：中文每字宽 ≈ fontSize/72 英寸；估字符数 × 字宽 ≤ 文本框宽 − 0.2 英寸，超了减字或缩号
3. outputs 与实际写盘文件一一核对（多写的补声明重跑，或删掉）
4. 声称完成前，回复里列全部产物路径

## 7. 最小可抄模板

PPT：

```js
const PptxGenJS = require('pptxgenjs');
const pptx = new PptxGenJS();
pptx.defineLayout({ name: 'W', width: 10, height: 5.625 });
pptx.layout = 'W';
const s = pptx.addSlide();
s.addText('标题', { x: 0.6, y: 0.5, w: 8.8, h: 0.8, fontSize: 28, bold: true, color: '2D3436' });
s.addText(['要点一', '要点二'], { x: 0.8, y: 1.7, w: 8.4, h: 2.4, fontSize: 16, color: '555F66', lineSpacingMultiple: 1.4 });
pptx.writeFile({ fileName: 'out.pptx' });
```

Excel + 原生图表：

```js
const ExcelJS = require('exceljs');
const { injectXlsxChart } = require('momo-chart');
const fs = require('fs');
const wb = new ExcelJS.Workbook();
const ws = wb.addWorksheet('数据');
ws.addRow(['季度', '销量']); ws.addRow(['Q1', 120]); ws.addRow(['Q2', 180]); ws.addRow(['Q3', 150]);
await wb.xlsx.writeFile('out.xlsx');
fs.writeFileSync('out.xlsx', injectXlsxChart(fs.readFileSync('out.xlsx'), {
  sheetName: '数据',
  anchor: { from: { col: 3, row: 1 }, to: { col: 9, row: 16 } },
  chart: { type: 'bar', title: '季度销量', series: [
    { nameLiteral: '销量', catRef: '数据!$A$2:$A$4', catCache: ['Q1', 'Q2', 'Q3'], valRef: '数据!$B$2:$B$4', valCache: [120, 180, 150] },
  ] },
}));
```

校验收工：

```js
const { validateOfficeFile } = require('momo-validate');
const path = require('path');
console.log(JSON.stringify(validateOfficeFile(path.resolve('out.pptx'))));
```
````

- [ ] **Step 4: 跑测试确认通过**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/agent/tools/officepro/skill-md.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add plugins/office-pro/skills electron/tests/agent/tools/officepro/skill-md.test.ts
git commit -m "feat: office-authoring 方法论 skill（决策树/footgun/设计规范/QA）"
```

---

### Task 9: 文档工程师预置 agent + manifest 校验（M3）

**Files:**
- Create: `plugins/office-pro/agents/office-pro.yaml`
- Test: `electron/tests/agent/tools/officepro/manifest.test.ts`

**Interfaces:**
- Consumes: `general-assistant.yaml` 的 YAML 结构范式（apiVersion/kind/metadata/spec.declarative/defaultTools）；manifest 交叉引用校验（tools 目录文件名 ↔ plugin ref、skills 子目录 ↔ defaultSkills ref）
- Produces: 预置 agent 定义（defaultTools 含 `plugin:office-pro/run_js`，defaultSkills 含 `office-authoring`；**不含 bash / webfetch / browser**）

- [ ] **Step 1: 写失败测试**

```typescript
// electron/tests/agent/tools/officepro/manifest.test.ts
// 插件 manifest 与预置 agent 校验锁（spec 2026-11-03 §5.1/§5.4）。
import fs from 'node:fs';
import path from 'node:path';
import { load as yamlLoad } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { parseManifest, validateManifest } from '../../../src/main/plugin/manifest';
import { PLUGIN_ROOT } from './fixtures';

describe('office-pro 插件 manifest 与预置 agent', () => {
  it('manifest 通过 validateManifest（含交叉引用：run_js ↔ tools/run_js.js、office-authoring ↔ skills 子目录）', () => {
    const manifest = parseManifest(fs.readFileSync(path.join(PLUGIN_ROOT, 'manifest.json'), 'utf-8'));
    expect(() => validateManifest(manifest, PLUGIN_ROOT)).not.toThrow();
  });

  it('agent YAML：defaultTools 含 plugin:office-pro/run_js 与 office 读取三件；不含 bash', () => {
    const raw = yamlLoad(fs.readFileSync(path.join(PLUGIN_ROOT, 'agents/office-pro.yaml'), 'utf-8')) as {
      spec?: { defaultTools?: Array<{ ref?: string }>; defaultSkills?: Array<{ ref?: string }> };
    };
    const refs = (raw.spec?.defaultTools ?? []).map((t) => t.ref ?? '');
    expect(refs).toContain('plugin:office-pro/run_js');
    expect(refs).toContain('office_read');
    expect(refs).toContain('office_read_cells');
    expect(refs).toContain('office_copy');
    expect(refs).not.toContain('bash');
    expect(raw.spec?.defaultSkills?.map((s) => s.ref)).toEqual(['office-authoring']);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/agent/tools/officepro/manifest.test.ts`
Expected: FAIL——agents/office-pro.yaml 不存在（交叉引用校验也会失败）

- [ ] **Step 3: 写入 agent YAML（`plugins/office-pro/agents/office-pro.yaml`）**

```yaml
# 文档工程师（office-pro）— office 生成能力官方预置（spec 2026-11-03 §5.4）。
# 特征：无 bash / 无网络工具（离线工坊自足，对比实验变量干净）；生成一律 run_js。
apiVersion: v1
kind: AgentDefinition
metadata:
  name: 文档工程师
  slug: office-pro
  version: 0.1.0
  description: office 文档生成专家——run_js 沙箱代码工坊产出高质量 PPT/Excel/Word/PDF，离线可用。
  iconEmoji: "📄"
spec:
  runtime: declarative
  declarative:
    systemPrompt: |
      你是文档工程师——office 文档生成专家。用户要 PPT/Excel/Word/PDF 产出时你负责交付。

      工作流：
      1. 处理任何 office 生成任务前，先加载 office-authoring 技能并遵守其全部纪律
      2. 读既有文档用 office_read / office_read_cells；不要用 run_js 做纯读取
      3. 生成/改造一律 run_js 写代码；产物文件必须列入 outputs 参数
      4. 用户给了 .pptx 模板 → 优先 momo-pptx-zip 模板手术（保品牌），而非从零仿制
      5. 收工前必须 momo-validate 校验每个产物，并在回复中列全部产物路径

      硬规则：
      - NEVER: 尝试联网下载依赖（沙箱无网络，必败）；未经校验就声称产出完成
      - ALWAYS: 动手前先问品牌模板/配色偏好；配色从内容主题推导，禁默认深蓝色条
    model:
      provider: anthropic
      model: claude-sonnet-4-5
  defaultTools:
    - kind: builtin
      ref: read_file
    - kind: builtin
      ref: write_file
    - kind: builtin
      ref: list_files
    - kind: builtin
      ref: edit_file
    - kind: builtin
      ref: mkdir
    - kind: builtin
      ref: mv
    - kind: builtin
      ref: exists
    - kind: builtin
      ref: grep
    - kind: builtin
      ref: glob
    - kind: builtin
      ref: todowrite
    - kind: builtin
      ref: office_read
    - kind: builtin
      ref: office_read_cells
    - kind: builtin
      ref: office_copy
    - kind: builtin
      ref: plugin:office-pro/run_js
  defaultSkills:
    - kind: skill
      ref: office-authoring
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/agent/tools/officepro/manifest.test.ts`
Expected: PASS（含 validateManifest 交叉引用全过）

- [ ] **Step 5: 手工冒烟（GUI，macOS 主机）**

1. `npx pnpm@9.0.0 dev` 启动应用
2. 设置→插件→开发目录安装 → 选择 `plugins/office-pro`
3. 验证：插件明细页显示 tools（run_js 代码工坊）/ skills（office-authoring）/ agents（文档工程师）三面
4. 资源库或成员编辑处能看到「文档工程师」预置
（容器内无 GUI——此步在 macOS 主机执行；如失败按 momo-debug-rules 排查，不要跳过）

- [ ] **Step 6: Commit**

```bash
git add plugins/office-pro/agents electron/tests/agent/tools/officepro/manifest.test.ts
git commit -m "feat: 文档工程师预置 agent（run_js + office 读取面 + authoring skill）"
```

---

### Task 10: 核心 office 生成类下线（M4，验收通过后执行）

> **前置闸门**：Task 12 的手工验收清单第 1-5 项（复刻质量/断网/不外逃/安全/记账）已人工确认通过后才允许开始本任务。执行者开工前向用户确认此闸门。

**Files:**
- Modify: `electron/src/main/agent/tools/office-tools.ts`、`electron/src/main/agent/tools/catalog.ts`（ALL_BUILTIN_TOOLS）、`electron/package.json`
- Modify/Delete: `electron/src/main/agent/tools/office/pptx.ts`（拆分）、`excel.ts`（拆分）、`docx.ts`（拆分）、`pdf.ts`（拆分）；删 `chart-xml.ts`、`pptx-zip.ts`、`xlsx-zip.ts`
- Test: 调整 `electron/tests/agent/tools/office/builtin-office.test.ts`、`office-tools.test.ts`、`pptx.test.ts`；删 `xlsx-zip.test.ts`

**Interfaces:**
- Consumes: Task 4 已把 chart/pptx-zip 能力移植进插件（删除后能力不丢失）
- Produces: `OfficeTools.getDefs()` 仅返回 `[READ_DEF, READ_CELLS_DEF, COPY_DEF]`；`ALL_BUILTIN_TOOLS` 无 6 个生成名

- [ ] **Step 1: 先改测试锁（红）**

`builtin-office.test.ts` 追加/改写：

```typescript
it('生成类工具已下线（spec 2026-11-03 §6）：getDefs 只剩读取三件', () => {
  const tools = new OfficeTools();
  expect(tools.getDefs().map((d) => d.name).sort()).toEqual(['office_copy', 'office_read', 'office_read_cells']);
});
```

同时删除 office 测试目录中全部生成行为用例（create_ppt / create_excel / write_excel ops / create_doc / create_pdf / fill_ppt_template 的构造与断言），保留 read / read_cells / copy 用例与 description 锁中的读取部分。`xlsx-zip.test.ts` 整文件删除（chart 用例已由 Task 4 插件侧承接）。

- [ ] **Step 2: 跑 office 测试目录确认红**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/agent/tools/office`
Expected: FAIL——新锁用例失败（工具还在）

- [ ] **Step 3: 执行下线（按清单逐文件）**

1. `office-tools.ts`：`getDefs()` → `[READ_DEF, READ_CELLS_DEF, COPY_DEF]`；execute switch 删除 `office_create_excel / office_write_excel / office_create_doc / office_create_ppt / office_fill_ppt_template / office_create_pdf` 六个 case；删除对应 DEF 常量与解析函数（parseSheetInits / parseExcelWriteOps / parseDocSections / parsePptTemplateFills / parsePdfBlocks）及 import（createXlsx / writeXlsxOps / createDocx / parsePptxSlides / createPptx / fillPptTemplate / createPdf）；`OFFICE_CATALOG_META` 裁到 3 条
2. `office/pptx.ts`：保留 `readPptx` / `slideTexts` / `SLIDE_RE` / `NOTES_RE` 与其 import（cheerio、AdmZip）；删除自 `WorkspacePathResolver` 起的全部生成侧代码与 pptxgenjs import
3. `office/excel.ts`：保留 `readXlsxCells` 及其私有依赖；删除 create/write/chart 路径与 chart-xml / xlsx-zip import
4. `office/docx.ts`：保留读取（mammoth）；删除 createDocx 与 docx 库 import
5. `office/pdf.ts`：保留读取（pdfjs-dist）；删除 createPdf、pdfkit import与字体资产引用
6. 删除文件：`office/chart-xml.ts`、`office/pptx-zip.ts`、`office/xlsx-zip.ts`
7. `tools/catalog.ts`：`ALL_BUILTIN_TOOLS` 移除 6 个生成名
8. `electron/package.json`：移除 `pptxgenjs`、`docx`、`pdfkit`（保留 exceljs / mammoth / pdfjs-dist / adm-zip / cheerio——读取侧仍用）；根目录 `npx pnpm@9.0.0 install` 更新 lockfile

- [ ] **Step 4: typecheck + office 测试目录绿**

Run: `npx pnpm@9.0.0 typecheck && cd electron && npx pnpm@9.0.0 vitest run tests/agent/tools/office`
Expected: typecheck 无错；测试全绿

- [ ] **Step 5: Commit**

```bash
git add -A electron plugins
git commit -m "refactor: 核心 office 生成类下线（读留写删，能力由 office-pro 插件承接）"
```

---

### Task 11: 失效 ref 过滤 + warn（M4）

**Files:**
- Modify: `electron/src/main/agent/capability-merger.ts`（新增纯函数）+ 工具面装配点（见 Step 3）
- Test: `electron/tests/agent/capability-filter.test.ts`

**Interfaces:**
- Produces: `dropUnknownToolRefs(refs: string[], knownNames: ReadonlySet<string>): { kept: string[]; dropped: string[] }`——装配层消费并打 warn

- [ ] **Step 1: 写失败测试**

```typescript
// electron/tests/agent/capability-filter.test.ts
// 失效工具 ref 过滤锁（spec 2026-11-03 §6.3）。
import { describe, expect, it } from 'vitest';
import { dropUnknownToolRefs } from '../../src/main/agent/capability-merger';

describe('dropUnknownToolRefs', () => {
  it('已知 ref 保留；未知 ref（已下线工具）丢弃并回报', () => {
    const known = new Set(['office_read', 'plugin:office-pro/run_js', 'read_file']);
    const { kept, dropped } = dropUnknownToolRefs(
      ['office_read', 'office_create_ppt', 'plugin:office-pro/run_js', 'bash'],
      known,
    );
    expect(kept).toEqual(['office_read', 'plugin:office-pro/run_js']);
    expect(dropped).toEqual(['office_create_ppt', 'bash']);
  });

  it('全已知 → 无丢弃', () => {
    const known = new Set(['a', 'b']);
    expect(dropUnknownToolRefs(['a', 'b'], known)).toEqual({ kept: ['a', 'b'], dropped: [] });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/agent/capability-filter.test.ts`
Expected: FAIL——函数不存在

- [ ] **Step 3: 实现与装配**

`capability-merger.ts` 新增：

```typescript
/**
 * 已知工具名集合外的 ref 过滤（spec 2026-11-03 §6.3）：引用已下线/不存在工具的
 * ref 丢弃并回报，供装配层打 warn（存量自定义 agent 的 defaultTools 引用了
 * 已删工具时启动可见提示，不崩）。
 */
export function dropUnknownToolRefs(
  refs: string[],
  knownNames: ReadonlySet<string>,
): { kept: string[]; dropped: string[] } {
  const kept: string[] = [];
  const dropped: string[] = [];
  for (const ref of refs) {
    (knownNames.has(ref) ? kept : dropped).push(ref);
  }
  return { kept, dropped };
}
```

装配点接线：`grep -rn "getDefs" electron/src/main/agent/spawn-helpers.ts electron/src/main/agent/effective-capabilities.ts` 定位 merged.tools 与已装配工具 def 的求交处（唯一装配点），在求交前插入：

```typescript
const known = new Set(allDefs.map((d) => d.name));
const { kept, dropped } = dropUnknownToolRefs(merged.tools, known);
if (dropped.length > 0) logger.warn('能力引用了不存在或已下线的工具，已过滤', { dropped });
// 此后以 kept 替代 merged.tools 参与求交
```

（`allDefs` / `logger` 以该装配点既有变量名为准对齐。）

- [ ] **Step 4: 跑测试 + typecheck**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/agent/capability-filter.test.ts && cd .. && npx pnpm@9.0.0 typecheck`
Expected: PASS / 无错

- [ ] **Step 5: Commit**

```bash
git add electron/src/main/agent electron/tests/agent/capability-filter.test.ts
git commit -m "feat: 失效工具 ref 过滤与启动 warn（office 生成类下线的存量兼容）"
```

---

### Task 12: 全量回归 + 手工验收 + 文档收尾（M4）

**Files:**
- Modify: `CHANGELOG.md`（研发账本条目）、`docs/specs/2026-11-03-office-pro-plugin-design.md`（状态→已实施）、三处 `package.json`（alpha +1）

- [ ] **Step 1: 全量回归**

Run: `nvm use 24 && npx pnpm@9.0.0 typecheck && npx pnpm@9.0.0 test`
Expected: 双 workspace 全绿（裸 `vitest run`，不加 --pool 全局参数）

- [ ] **Step 2: 手工验收清单（spec §9 六条，macOS 主机 + 真实 App）**

按 `momo-acceptance` 技能启动隔离实例执行，逐项记录到 `.omo/qa-reports/`：

1. **复刻质量**：装 office-pro 插件 → 用「文档工程师」预置建 agent → 参考既有 python-pptx 版「IT工作周报」产出复刻 PPT → 与旧 office_create_ppt 产出双盲人工对比（评审人不知来源），显著占优才算过
2. **断网全流程**：系统断网（或沙箱 net-off）下从零产出 .pptx 与 .xlsx（含 momo-chart 原生图表），全程无 pip/npm/网络调用迹象
3. **不外逃**：文档工程师 agent（无 bash）独立完成生成任务；会话无「下载/安装依赖」行为
4. **安全探针**：outputs 传 `../x` → 拒绝；脚本写 workspace 外 → 守卫拒绝；`while(true){}` → 120s 强杀；巨量 stdout → 截断；点停止 → 即时中止
5. **记账撤销**：UI 变更账本可见 run_js 产出条目，undo 可还原
6. **存量兼容**：引用 `office_create_ppt` 的旧自定义 agent 启动不崩，日志出现失效提示（Task 11 warn）

- [ ] **Step 3: 文档收尾**

- `CHANGELOG.md` 追加研发账本条目（office-pro 插件 + 核心生成类下线；**不动版本号**之外的三处 package.json alpha 号 +1：root / electron / renderer）
- `docs/specs/2026-11-03-office-pro-plugin-design.md` 头部状态改「已实施」
- 验收报告归档 `.omo/qa-reports/`

- [ ] **Step 4: Commit**

```bash
git add CHANGELOG.md package.json electron/package.json renderer/package.json docs/specs/2026-11-03-office-pro-plugin-design.md
git commit -m "chore: office-pro 专项收尾——CHANGELOG 账本 + alpha 版本号 +1 + spec 状态更新"
```

---

## 执行交接说明

- 任务依赖链：Task 1→2→（3/4/5 可并行）→6→7→（8/9 可并行）→【手工验收闸门】→10→11→12
- Task 10 有硬闸门：必须先完成 Task 12 Step 2 的验收清单第 1-5 项（先立后破，spec §8）
- 插件 JS 无 tsc 兜底：Task 3-7 的测试是唯一行为锁，Review Focus 五项测试不可删






