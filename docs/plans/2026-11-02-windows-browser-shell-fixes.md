# Windows 浏览器 / 命令执行缺陷修复 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**目标：** 让 Momo Studio 的 agent 在 Windows 上能正常执行命令（node / python / npm / git）并在内置浏览器打开工作空间内的本地网页，同时不改变 macOS / Linux 的既有行为。

**架构：** 五处独立修复 + 一处接线。两个新纯模块承担可测逻辑（`shared/stream-decode.ts` 流式 UTF-8 解码、`browser/url-input.ts` 导航输入归一），一个纯函数承担 Windows 命令序言（`sandbox/windows.ts`）。其余是在既有函数内按 platform 参数分叉；`browser/policy.ts` 只补返回值与错误文案，安全边界判定不动。

**技术栈：** Electron 44 / TypeScript strict / better-sqlite3 / vitest / Node 24

**Spec:** `docs/specs/2026-11-02-windows-browser-shell-fixes-design.md`

## Global Constraints

- TypeScript strict：禁 `any`、`@ts-ignore`、`as any`（ESLint `no-explicit-any: error`）。
- 代码注释与文档用中文；标识符保持英文。
- **不 mock `process.platform`**（`electron/tests/platform/paths.win32.test.ts` 文件头明令禁止）。平台分叉一律经显式参数或纯函数进入；需要 win32 路径语义时按既有模板 `vi.mock('node:path', …win32)`。
- electron 单测只放 `electron/tests/**/*.test.ts`，子目录镜像 `src/` 结构。
- 测试命令：`cd electron && npx pnpm@9.0.0 vitest run tests/<path>`；类型检查：`npx pnpm@9.0.0 typecheck`。
- **不 bump 版本号**（特性 commit 不动 alpha 号）。
- Conventional Commits：`fix:` / `test:` / `refactor:`。
- posix 侧 `buildSandboxEnv` 的输出必须与改动前**逐字相等**。
- 不改安全边界：`BrowserPolicy.assertFilePath` 的越界/realpath 判定只作用于 pathname。
- **原生模块 ABI**：本机 `better-sqlite3` 现在是 Electron ABI 149，Node/vitest 加载会报模块版本不匹配。跑任何触 DB 的测试前先切回 Node ABI：
  `cd electron && npx pnpm@9.0.0 rebuild better-sqlite3`（若静默 no-op，改在 `node_modules/.pnpm/better-sqlite3@12.11.1/node_modules/better-sqlite3 && npx prebuild-install`）。
  Task 9 手工验收前再用 `npm_config_nodedir=$USERPROFILE\.electron-gyp\electron-44.9.1` + `electron-rebuild` 切回 Electron ABI。`keytar` 是 N-API，不受影响。
- 测试里的路径期望值**必须用 `pathToFileURL(path.join(...))` 现算**，禁止硬编码 `file:///ws/...`：非 win32 的那份测试跑在真实平台语义上（Windows 开发机会得到 `file:///C:/ws/...`，Linux CI 得到 `file:///ws/...`）。

## Review Focus

以下五类输入是 spec 隐含、但容易"单测全绿、用户照旧踩坑"的，每条都在对应任务里落一个测试：

1. **中文 / 空格 / 字面 `%` 的文件名**（`研发 周报%模板.html`）→ 相对路径归一后必须仍能命中真实文件，且不因 `%` 报错。（Task 5）
2. **win32 的 `file:///C:/abs/a.html` 与 UNC `file://srv/share/x`** → 是最常见的"绝对路径"，绝不能掉进相对路径分支。（Task 5）
3. **`#fragment` / `?query` 经 policy 往返** → 必须原样保留，否则锚点导航静默失效（HTML 分页/PPT 放映的主用法）。（Task 6）
4. **输出恰好在 limit 边界被切断** → 不出现半个字符、截断标记不误报/漏报。（Task 1）
5. **`grep` 显式点名的文件被 gitignore 或 1MB 上限静默跳过** → 用户会以为"没有匹配"。（Task 8）

---

## 文件结构

| 文件 | 责任 | 动作 |
|---|---|---|
| `electron/src/main/agent/tools/shared/stream-decode.ts` | 子进程输出按 UTF-8 流式累积 + 上限截断（纯） | 新建 |
| `electron/src/main/browser/url-input.ts` | 导航输入 → 绝对 URL / 工作空间相对路径归一（纯） | 新建 |
| `electron/src/main/sandbox/windows.ts` | Windows shell 辅助（已有）+ 命令序言纯函数 | 修改 |
| `electron/src/main/sandbox/index.ts` | `resolveShellSpawn` 三态决策 | 修改（win32 分支一处） |
| `electron/src/main/agent/tools/shell-tools.ts` | bash 工具：env 白名单、输出收集、工具描述 | 修改（三处） |
| `electron/src/main/agent/tools/git-tools.ts` | git 工具：`runGit` 输出收集 | 修改（一处） |
| `electron/src/main/browser/policy.ts` | 浏览器策略：file URL 归一返回值 + 越界文案 | 修改（一处） |
| `electron/src/main/agent/tools/browser-tools.ts` | 浏览器 12 工具：navigate / tabs open 接线 + 描述 | 修改（三处） |
| `electron/src/main/agent/tools/search-tools.ts` | grep / glob：单文件路径支持 | 修改（一处） |

---

### Task 1: 共享 UTF-8 流式解码器，并接入 bash 与 git

**Files:**
- Create: `electron/src/main/agent/tools/shared/stream-decode.ts`
- Create: `electron/tests/agent/tools/shared/stream-decode.test.ts`
- Modify: `electron/src/main/agent/tools/shell-tools.ts:295-316`（两处 `data` 回调）、`:388-402`（结果拼装里的 `truncated` 取值）
- Modify: `electron/src/main/agent/tools/git-tools.ts` `runGit` 的两处 `data` 回调
- Test: `electron/tests/agent/tools/git-tools.test.ts`（扩充）

**Interfaces:**
- Produces：
  ```ts
  export interface Utf8Collector {
    write(chunk: Buffer): void;
    /** close 时调用：冲出不完整尾字节 */
    end(): void;
    readonly text: string;
    readonly truncated: boolean;
  }
  export function createUtf8Collector(limit: number): Utf8Collector;
  ```
  语义：按**字符**累计到 `limit`；超出部分丢弃并置 `truncated = true`（后续写入不再累加）；内部用 `node:string_decoder` 的 `StringDecoder('utf8')`。

- [ ] **Step 1: 写失败测试**

```ts
// electron/tests/agent/tools/shared/stream-decode.test.ts
import { describe, it, expect } from 'vitest';
import { createUtf8Collector } from '../../../../src/main/agent/tools/shared/stream-decode';

describe('createUtf8Collector', () => {
  it('多字节字符跨 chunk 边界不产生乱码（回归锁：旧实现 toString 逐 chunk 解必挂）', () => {
    const c = createUtf8Collector(1024);
    const bytes = Buffer.from('中文测试', 'utf8'); // 每个汉字 3 字节
    for (const b of [bytes.subarray(0, 1), bytes.subarray(1, 4), bytes.subarray(4)]) c.write(b);
    c.end();
    expect(c.text).toBe('中文测试');
    expect(c.truncated).toBe(false);
  });

  it('超过 limit 截断并置标记，后续写入不再累加', () => {
    const c = createUtf8Collector(3);
    c.write(Buffer.from('中文测试', 'utf8'));
    c.write(Buffer.from('还有更多', 'utf8'));
    c.end();
    expect(c.text).toBe('中文测');
    expect(c.truncated).toBe(true);
  });

  it('恰好等于 limit 不置截断标记', () => {
    const c = createUtf8Collector(4);
    c.write(Buffer.from('中文测试', 'utf8'));
    c.end();
    expect(c.text).toBe('中文测试');
    expect(c.truncated).toBe(false);
  });

  it('不完整尾字节上 end() 不抛错', () => {
    const c = createUtf8Collector(1024);
    c.write(Buffer.from('中', 'utf8').subarray(0, 2));
    expect(() => c.end()).not.toThrow();
    expect(c.text.length).toBeLessThanOrEqual(1);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/agent/tools/shared/stream-decode.test.ts`
Expected: FAIL —— `Failed to resolve import ".../stream-decode"`。

- [ ] **Step 3: 实现 `createUtf8Collector`**

在 `electron/src/main/agent/tools/shared/stream-decode.ts` 实现上面的接口。`write` 里：`decoded = decoder.write(chunk)`；若 `text.length + decoded.length > limit` 则只取前 `limit - text.length` 个字符并置 `truncated = true`；已 `truncated` 时直接忽略后续 chunk（但仍需 `decoder.write(chunk)` 保持解码器状态一致——实现者自行选择更简单的一种，只要上表四个测试都过）。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/agent/tools/shared/stream-decode.test.ts`
Expected: 4 passed。

- [ ] **Step 5: 接入 `bashOnce`**

`shell-tools.ts` 里把两个 `let stdout = ''; let stderr = '';` 换成 `const outCol = createUtf8Collector(OUTPUT_LIMITS.bash_stdout);` / `const errCol = createUtf8Collector(OUTPUT_LIMITS.bash_stderr);`，两个 `data` 回调体改成 `outCol.write(chunk)` / `errCol.write(chunk)`。`close` 回调里先 `outCol.end(); errCol.end();`，再用 `outCol.text` / `errCol.text` 拼装，`truncated` 统一取 `outCol.truncated || errCol.truncated`。**输出文本格式（`exit_code:` / `sandbox:` / `stdout:` 等行）与截断提示文案一字不改。**

- [ ] **Step 6: 接入 `runGit`**

`runGit` 里 `if (stdout.length < maxOutput) stdout += chunk.toString('utf-8');` 换成 collector（`createUtf8Collector(maxOutput)`），`close` 时 `end()` 后取 `.text`。`GitResult` 契约（`{ code, stdout, stderr }`）不变；`runGit` 不需要 `truncated` 标记。

- [ ] **Step 7: 跑既有测试确认无回归**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/agent/tools/shell-tools.test.ts tests/agent/tools/shell-tools-abort.test.ts tests/agent/tools/shell-net-trust.test.ts tests/agent/tools/git-tools.test.ts`
Expected: 全 passed。

- [ ] **Step 8: 补 git 中文输出回归测试**

在 `git-tools.test.ts` 加一例：桩一个输出含中文且被拆成两个 chunk 的场景（沿用该文件既有的 spawn 桩写法），断言 `result.stdout` 为完整中文、无 `\uFFFD`。

- [ ] **Step 9: Commit**

```bash
git add electron/src/main/agent/tools/shared/stream-decode.ts \
        electron/src/main/agent/tools/shell-tools.ts \
        electron/src/main/agent/tools/git-tools.ts \
        electron/tests/agent/tools/shared/stream-decode.test.ts \
        electron/tests/agent/tools/git-tools.test.ts
git commit -m "fix(agent): 子进程输出改流式 UTF-8 解码，修跨 chunk 多字节截断"
```

---

### Task 2: 子进程环境变量白名单平台化（win32 补 PATH / PATHEXT）

**Files:**
- Modify: `electron/src/main/agent/tools/shell-tools.ts:97-112`（`buildSandboxEnv`）
- Test: `electron/tests/agent/tools/sandbox-env.test.ts`（新建）

**Interfaces:**
- Consumes：`ToolContext`（只用 `workspaceDir`）
- Produces：
  ```ts
  export function buildSandboxEnv(
    ctx: ToolContext,
    env?: NodeJS.ProcessEnv,        // 缺省 process.env
    platform?: NodeJS.Platform,     // 缺省 process.platform
  ): NodeJS.ProcessEnv;
  ```
  win32 分支额外固定注入 `PYTHONUTF8: '1'`、`PYTHONIOENCODING: 'utf-8'`；posix 分支**不**注入。

- [ ] **Step 1: 写失败测试**

```ts
// electron/tests/agent/tools/sandbox-env.test.ts
import { describe, it, expect } from 'vitest';
import { buildSandboxEnv } from '../../../src/main/agent/tools/shell-tools';
import type { ToolContext } from '../../../src/main/agent/tools/types';

const ctx = { workspaceDir: 'C:\\ws' } as unknown as ToolContext;

describe('buildSandboxEnv', () => {
  it('win32：大小写混合的 Path / SystemRoot 被保留', () => {
    const out = buildSandboxEnv(ctx, {
      Path: 'C:\\bin', PATHEXT: '.COM;.EXE;.BAT', SystemRoot: 'C:\\Windows', windir: 'C:\\Windows',
    }, 'win32');
    expect(out.Path).toBe('C:\\bin');
    expect(out.PATHEXT).toBe('.COM;.EXE;.BAT');
    expect(out.SystemRoot).toBe('C:\\Windows');
    expect(out.windir).toBe('C:\\Windows');
  });

  it('win32：注入 PYTHONUTF8 与 PYTHONIOENCODING', () => {
    const out = buildSandboxEnv(ctx, {}, 'win32');
    expect(out.PYTHONUTF8).toBe('1');
    expect(out.PYTHONIOENCODING).toBe('utf-8');
  });

  it('win32：白名单外的变量不下发', () => {
    const out = buildSandboxEnv(ctx, { Path: 'x', OPENAI_API_KEY: 'sk-x', GITHUB_TOKEN: 'g' }, 'win32');
    expect(out.OPENAI_API_KEY).toBeUndefined();
    expect(out.GITHUB_TOKEN).toBeUndefined();
  });

  it('posix：输出与旧实现逐字相等，且不注入 PYTHONUTF8', () => {
    const out = buildSandboxEnv(ctx, {
      PATH: '/usr/bin', HOME: '/home/u', OPENAI_API_KEY: 'sk-x', GITHUB_TOKEN: 'g',
    }, 'linux');
    expect(out).toEqual({
      PATH: '/usr/bin', HOME: '/home/u',
      WORKSPACE_DIR: 'C:\\ws', MOMO_STUDIO_AGENT: '1',
    });
  });

  it('posix：大小写不同不算命中（保持既有大小写敏感语义）', () => {
    const out = buildSandboxEnv(ctx, { Path: '/usr/bin' }, 'linux');
    expect(out.PATH).toBeUndefined();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/agent/tools/sandbox-env.test.ts`
Expected: FAIL —— win32 用例失败（`out.Path` 为 `undefined`，因为当前实现按大写 `PATH` 比对且无 platform 分支）。

- [ ] **Step 3: 改 `buildSandboxEnv`**

按 spec §5.1：加 `env` / `platform` 两参；posix 分支保留原 `ALLOWED` 集合与大小写敏感比对（逻辑逐字不变）；win32 分支用**大小写不敏感**比对，清单按 spec §5.1 那份（`Path, PATHEXT, SystemRoot, SystemDrive, WINDIR, ComSpec, TEMP, TMP, USERPROFILE, HOMEDRIVE, HOMEPATH, USERNAME, USERDOMAIN, COMPUTERNAME, PSModulePath, APPDATA, LOCALAPPDATA, ProgramData, ProgramFiles, "ProgramFiles(x86)", PUBLIC, NUMBER_OF_PROCESSORS, PROCESSOR_ARCHITECTURE, OS`），并注入 `PYTHONUTF8` / `PYTHONIOENCODING`；两分支末尾都注入 `WORKSPACE_DIR` / `MOMO_STUDIO_AGENT`。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/agent/tools/sandbox-env.test.ts`
Expected: 5 passed。

- [ ] **Step 5: 跑既有 shell 测试确认无回归**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/agent/tools/shell-tools.test.ts tests/agent/tools/shell-sandbox-wiring.test.ts tests/sandbox/`
Expected: 全 passed。

- [ ] **Step 6: Commit**

```bash
git add electron/src/main/agent/tools/shell-tools.ts electron/tests/agent/tools/sandbox-env.test.ts
git commit -m "fix(agent): Windows 子进程环境白名单改大小写不敏感并补 PATHEXT"
```

---

### Task 3: Windows 命令序言（强制 UTF-8 输出）

**Files:**
- Modify: `electron/src/main/sandbox/windows.ts`（新增纯函数）
- Modify: `electron/src/main/sandbox/index.ts:50-55`（win32 分支）
- Test: `electron/tests/sandbox/windows-command-line.test.ts`（新建）

**Interfaces:**
- Produces：
  ```ts
  export function buildWindowsCommandLine(command: string): string;
  // 返回 '$OutputEncoding = [Console]::OutputEncoding = [System.Text.Encoding]::UTF8;\n' + command
  ```

- [ ] **Step 1: 写失败测试**

```ts
// electron/tests/sandbox/windows-command-line.test.ts
import { describe, it, expect } from 'vitest';
import { buildWindowsCommandLine } from '../../src/main/sandbox/windows';

describe('buildWindowsCommandLine', () => {
  it('序言把控制台输出编码钉成 UTF-8，并在原命令之前', () => {
    const out = buildWindowsCommandLine('node -v');
    expect(out.startsWith('$OutputEncoding = [Console]::OutputEncoding = [System.Text.Encoding]::UTF8;')).toBe(true);
    expect(out.endsWith('node -v')).toBe(true);
  });

  it('多行命令 / 含分号命令原样保留', () => {
    const cmd = "$ErrorActionPreference='Stop'\nGet-ChildItem; Write-Output 'ok'";
    const out = buildWindowsCommandLine(cmd);
    expect(out).toContain(cmd);
    expect(out.indexOf('$OutputEncoding')).toBeLessThan(out.indexOf(cmd));
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/sandbox/windows-command-line.test.ts`
Expected: FAIL —— `buildWindowsCommandLine is not a function`。

- [ ] **Step 3: 实现并接线**

`windows.ts` 加该纯函数（一行模板字符串）。`sandbox/index.ts` 的 win32 分支把 `args` 的第四项由 `command` 改为 `buildWindowsCommandLine(command)`，`tag` 保持 `'win-powershell'`，`kind: 'plain'` 不变。

- [ ] **Step 4: 跑测试确认通过 + 无回归**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/sandbox/`
Expected: 全 passed（含既有 `resolve-spawn.test.ts`）。

- [ ] **Step 5: Commit**

```bash
git add electron/src/main/sandbox/windows.ts electron/src/main/sandbox/index.ts \
        electron/tests/sandbox/windows-command-line.test.ts
git commit -m "fix(sandbox): Windows 命令加 UTF-8 输出序言，修中文乱码"
```

---

### Task 4: shell 工具描述按实测 shell 生成

**Files:**
- Modify: `electron/src/main/agent/tools/shell-tools.ts`（`ShellTools.getDefs()`，新增导出纯函数）
- Test: `electron/tests/agent/tools/shell-tool-description.test.ts`（新建）

**Interfaces:**
- Produces：
  ```ts
  export function shellToolDescription(
    platform: NodeJS.Platform,
    detectedShell: string | null,   // 'pwsh.exe' | 'powershell.exe' | null（未探测）
  ): string;
  ```
  `getDefs()` 用 `shellToolDescription(process.platform, getSandboxState()?.windowsShell ?? null)` 生成描述。

- [ ] **Step 1: 写失败测试**

```ts
// electron/tests/agent/tools/shell-tool-description.test.ts
import { describe, it, expect } from 'vitest';
import { shellToolDescription } from '../../../src/main/agent/tools/shell-tools';

describe('shellToolDescription', () => {
  it('win32 + Windows PowerShell 5.1：明确不支持 &&', () => {
    const d = shellToolDescription('win32', 'powershell.exe');
    expect(d).toContain('Windows PowerShell 5.1');
    expect(d).toContain('不支持 &&');
    expect(d).toContain(';');
  });

  it('win32 + pwsh 7：明确支持 &&', () => {
    const d = shellToolDescription('win32', 'pwsh.exe');
    expect(d).toContain('pwsh');
    expect(d).toContain('支持 &&');
  });

  it('win32 + 未探测：给中性文案与版本自检指引', () => {
    const d = shellToolDescription('win32', null);
    expect(d).toContain('$PSVersionTable.PSVersion');
  });

  it('win32 三种形态都写清写文件用无 BOM UTF-8，并警示不要用 >', () => {
    for (const s of ['powershell.exe', 'pwsh.exe', null] as const) {
      const d = shellToolDescription('win32', s);
      expect(d).toContain('UTF8Encoding');
      expect(d).toContain('不要用');
    }
  });

  it('posix：不提 PowerShell / BOM，且声明支持 &&', () => {
    const d = shellToolDescription('linux', null);
    expect(d).not.toContain('PowerShell');
    expect(d).toContain('&&');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/agent/tools/shell-tool-description.test.ts`
Expected: FAIL —— `shellToolDescription is not a function`。

- [ ] **Step 3: 实现纯函数并接进 `getDefs()`**

文案按 spec §5.5。原描述里关于参数（`command` / `timeoutMs`）与返回值格式的说明**保留**，新文案追加在尾部。三段 win32 共用同一段"写文件标准写法"与"env 是受限白名单"提示。

- [ ] **Step 4: 跑测试确认通过 + 目录测试无回归**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/agent/tools/shell-tool-description.test.ts tests/agent/tools/catalog-selfdescribe.test.ts`
Expected: 全 passed。

- [ ] **Step 5: Commit**

```bash
git add electron/src/main/agent/tools/shell-tools.ts electron/tests/agent/tools/shell-tool-description.test.ts
git commit -m "fix(agent): shell 工具描述按实测 shell 生成，避免对 pwsh 7 给出错误事实"
```

---

### Task 5: `browser/url-input.ts` 导航输入归一（纯模块）

**Files:**
- Create: `electron/src/main/browser/url-input.ts`
- Create: `electron/tests/browser/url-input.test.ts`（posix 语义，真实 `node:path`）
- Create: `electron/tests/browser/url-input.win32.test.ts`（`vi.mock('node:path')` → win32，按 `policy.win32.test.ts` 模板）

**Interfaces:**
- Produces：
  ```ts
  export interface ResolveNavigateInputOpts {
    workspaceDir: string;
    platform?: NodeJS.Platform;                        // 缺省 process.platform
    fileUrlToPath?: (u: URL) => string;                // 缺省 node:url 的 fileURLToPath（供 win32 单测注入）
  }
  export function resolveNavigateInput(raw: string, opts: ResolveNavigateInputOpts): { url: string };
  ```
- 判定顺序严格按 spec §5.3 的六步（盘符优先排除 → http(s) → file: 先 `fileUrlToPath` → 其他 scheme 透传 → 无 scheme 时先切 `#`/`?` 再判平台绝对性）。

- [ ] **Step 1: 写失败测试（真实平台路径语义）**

断言写成 `expect(resolveNavigateInput(x, { workspaceDir: '/ws' }).url)`，期望值**一律用 `pathToFileURL(...)` 现算**（见 Global Constraints 最后一条），不要写字面量。逐条覆盖：

| 输入 | 期望 |
|---|---|
| `'report.html'` | `pathToFileURL(path.join('/ws', 'report.html')).href` |
| `'./sub/a.html'` | `pathToFileURL(path.join('/ws', 'sub/a.html')).href` |
| `'a.html#p2'` | `pathToFileURL(path.join('/ws', 'a.html')).href + '#p2'` |
| `'a.html?x=1#p2'` | `pathToFileURL(path.join('/ws', 'a.html')).href + '?x=1#p2'` |
| `'研发 周报%模板.html'` | `pathToFileURL(path.join('/ws', '研发 周报%模板.html')).href`（`%` 是字面量、不抛错、不被当编码，最终编码为 `%25`） |
| `'%E7%A0%94.html'` | `pathToFileURL(path.join('/ws', '研.html')).href`（合法 percent 解码后再编码） |
| `'../outside.html'` | `pathToFileURL(path.resolve('/ws', '../outside.html')).href`（归一即可，越界由 policy 判） |
| `'/etc/hosts'` | `pathToFileURL(path.resolve('/etc/hosts')).href`（平台绝对 → 原样语义） |
| `'http://localhost:5173/x'` | 原样 `'http://localhost:5173/x'` |
| `'ftp://x/y'` | 原样 `'ftp://x/y'`（交给 policy 抛 BrowserProtocolError） |
| `'file:///C:/abs/a.html'` | 原样 `'file:///C:/abs/a.html'`（能被 `fileUrlToPath` 解析成功的，一律按绝对路径走） |
| `''` / `'   '` | 抛错，错误信息含「URL 为空」 |

- [ ] **Step 2: 跑测试确认失败**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/browser/url-input.test.ts`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现 `resolveNavigateInput`**

文件放 `electron/src/main/browser/url-input.ts`，**零 electron 依赖**（只 `node:path` / `node:url`）。第 2 步"盘符优先排除"必须先于 scheme 解析，否则 `C:\x` 会被当 scheme `c:`。

- [ ] **Step 4: 跑 posix 测试确认通过**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/browser/url-input.test.ts`
Expected: 全 passed。

- [ ] **Step 5: 写 win32 测试**

`url-input.win32.test.ts`：`vi.mock('node:path', …actual.win32)`（照抄 `policy.win32.test.ts:23-26`），并注入 `fileUrlToPath`（照抄该文件 `:28-46` 的 drive / UNC 两形态实现）。断言：

| 输入 | 期望 |
|---|---|
| `'report.html'`（workspaceDir `'C:\\WS'`） | `'file:///C:/WS/report.html'` |
| `'C:\\abs\\a.html'` | `'file:///C:/abs/a.html'`（盘符形态不能被当 scheme） |
| `'file:///C:/abs/a.html'` | `'file:///C:/abs/a.html'`（**必须先 fileUrlToPath，不能掉进相对分支**） |
| `'file://srv/share/x.html'` | `'file://srv/share/x.html'`（UNC） |
| `'file:///report.html'` | `'file:///C:/WS/report.html'`（win32 无盘符 → 相对） |
| `'a.html#p2'` | `'file:///C:/WS/a.html#p2'` |

- [ ] **Step 6: 跑 win32 测试确认通过**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/browser/url-input.win32.test.ts`
Expected: 全 passed（在 Linux CI 上同样必须通过——这是不 mock `process.platform` 的关键收益）。

- [ ] **Step 7: Commit**

```bash
git add electron/src/main/browser/url-input.ts electron/tests/browser/url-input.test.ts \
        electron/tests/browser/url-input.win32.test.ts
git commit -m "feat(browser): 导航输入归一模块，支持工作空间相对路径"
```

---

### Task 6: policy 保留 hash/query + 越界文案

**Files:**
- Modify: `electron/src/main/browser/policy.ts:220-267`（`assertFilePath` 返回值与 `BrowserFileAccessError` 文案）
- Test: `electron/tests/browser/policy-relative.test.ts`（新建）、`electron/tests/browser/policy.win32.test.ts`（扩充）

**Interfaces:**
- Consumes：Task 5 产出的绝对 `file://` URL（含 `#` / `?`）
- Produces：`assertUrl` 对 file 分支的返回值**保留 `search` 与 `hash`**；越界错误文案含工作空间根 + 相对路径建议。

- [ ] **Step 1: 写失败测试**

`policy-relative.test.ts`（posix 真实 fs，用 `tmpdir` 造工作空间）：

```ts
it('file:// 的 hash 与 query 在返回值中保留', () => {
  const policy = new BrowserPolicy(() => settings, wsDir);
  const out = policy.assertUrl('ws1', pathToFileURL(path.join(wsDir, 'a.html')).href + '?x=1#p2');
  expect(out.endsWith('a.html?x=1#p2')).toBe(true);
});

it('越界错误文案含工作空间根与相对路径建议', () => {
  const policy = new BrowserPolicy(() => settings, wsDir);
  expect(() => policy.assertUrl('ws1', 'file:///etc/passwd'))
    .toThrowError(/工作空间根.*report\.html|report\.html.*工作空间根/s);
});
```

`policy.win32.test.ts` 增补：`file:///c:/ws/proj/a.txt#p2` 返回值以 `#p2` 结尾。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/browser/policy-relative.test.ts tests/browser/policy.win32.test.ts`
Expected: FAIL —— 返回值不带 `#p2` / 文案不含工作空间根。

- [ ] **Step 3: 改 `assertFilePath`**

末尾由 `return pathToFileURL(normalized).href;` 改为：构造 `const out = pathToFileURL(normalized)`，把入参 URL 的 `search` / `hash` 挂到 `out` 上再 `.href`。**边界判定（`isInsideDir` 字符串边界 + realpath 反符号链接）一律仍只作用于 `normalized`（pathname），不得把 search/hash 掺进路径。** 越界与"根目录不可访问"两处文案按 spec §5.3 补工作空间根与建议。

- [ ] **Step 4: 跑测试确认通过 + policy 全量无回归**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/browser/`
Expected: 全 passed（含 `policy.test.ts` / `protocol.test.ts` / `manager*.test.ts`）。

- [ ] **Step 5: Commit**

```bash
git add electron/src/main/browser/policy.ts electron/tests/browser/policy-relative.test.ts \
        electron/tests/browser/policy.win32.test.ts
git commit -m "fix(browser): file URL 保留 hash/query，越界错误补工作空间根与建议"
```

---

### Task 7: 接线 `browser_navigate` 与 `browser_tabs(open)`（跨层契约）

**Files:**
- Modify: `electron/src/main/agent/tools/browser-tools.ts`（`browser_navigate` 分支、`tabsAction` 的 `open` 分支、`browser_navigate` 工具描述）
- Test: `electron/tests/agent/tools/browser-tools.test.ts`（扩充）

**Interfaces:**
- Consumes：`resolveNavigateInput`（Task 5）；policy 已能正确往返 `#`/`?`（Task 6）
- Produces：`manager.navigate(wsId, absoluteFileUrl, opCtx)` / `manager.tabsAction(wsId,'open',undefined, absoluteFileUrl, …)`

- [ ] **Step 1: 写失败契约测试**

在 `browser-tools.test.ts`（沿用该文件既有 `mkCtx()` + 桩 manager）加两例：

```ts
// 期望 URL 一律现算（该测试的 ctx.workspaceId='ws1'、workspaceDir='/tmp/ws1'，见文件内 ctx 构造）
const expected = pathToFileURL(path.join('/tmp/ws1', 'report.html')).href;

it('browser_navigate 收到相对路径时，manager 收到工作空间内绝对 file URL', async () => {
  await tools.execute('browser_navigate', { url: 'report.html' }, ctx);
  expect(managerMock.navigate).toHaveBeenCalledWith('ws1', expected, expect.anything());
});

it('browser_tabs open 同样归一（同一 bug 的第二个入口）', async () => {
  await tools.execute('browser_tabs', { action: 'open', url: 'report.html' }, ctx);
  expect(managerMock.tabsAction).toHaveBeenCalledWith('ws1', 'open', undefined, expected, undefined, expect.anything());
});
```

> 第 6 参 `opCtx` 的具体值由该文件的既有 `OP_CTX` 决定；真正必须锁住的是「第 4 参是**绝对** file URL」与「第 5 参仍是 `undefined`（source 由工具层缺省，`browser-tools.ts` 现有调用形态就是 `(wsId, action, index, url, undefined, opCtx)`）」。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/agent/tools/browser-tools.test.ts`
Expected: FAIL —— manager 收到的是 `'report.html'`。

- [ ] **Step 3: 接线两处 + 补描述**

- `browser_navigate`：`const { url } = resolveNavigateInput(raw, { workspaceDir: ctx.workspaceDir });` 再交给 `manager.navigate`。
- `browser_tabs` 的 `open` 分支：仅当 `url !== undefined` 时归一（`undefined` 仍走 ABOUT_BLANK 既有路径），再传给 `manager.tabsAction`。
- `browser_navigate` 的工具描述补一句：支持 http(s)、工作空间内相对路径（`report.html`、`sub/a.html#p2`）、工作空间内绝对 `file://`。

- [ ] **Step 4: 跑测试确认通过 + 相关套件无回归**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/agent/tools/browser-tools.test.ts tests/agent/tools/browser-owner-session-scope.test.ts tests/agent/tools/browser-takenover-wait.test.ts tests/browser/`
Expected: 全 passed。

- [ ] **Step 5: Commit**

```bash
git add electron/src/main/agent/tools/browser-tools.ts electron/tests/agent/tools/browser-tools.test.ts
git commit -m "feat(browser): navigate 与 tabs open 支持工作空间相对路径"
```

---

### Task 8: `grep` 支持 `path` 指向单个文件

**Files:**
- Modify: `electron/src/main/agent/tools/search-tools.ts`（`executeGrep`；`executeGlob` 只补错误文案）
- Test: `electron/tests/agent/tools/search-tools.test.ts`（扩充）

**Interfaces:**
- Consumes：`ctx.wsFs.assertInWorkspace`
- Produces：`executeGrep` 在 `path` 是文件时只搜该文件；文件不存在时抛「路径不存在: <path>」

- [ ] **Step 1: 写失败测试**

在 `search-tools.test.ts`（沿用该文件既有临时工作空间构造）加四例：

```ts
it('path 指向单个文件时只搜该文件', async () => { /* 断言命中行号与文件名 */ });
it('显式点名的文件即使被 .gitignore 覆盖也能搜到', async () => { /* 回归锁：Review Focus 5 */ });
it('文件超过 1MB 时明确提示未搜索，而不是 (无匹配)', async () => { /* 断言输出含「超过 1MB 未搜索」 */ });
it('path 不存在时抛明确中文错误', async () => { /* 断言 /路径不存在/ */ });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/agent/tools/search-tools.test.ts`
Expected: FAIL —— 第一例报 `ENOTDIR`。

- [ ] **Step 3: 实现**

按 spec §5.4：`assertInWorkspace` → `fs.promises.stat` → 目录走现有逻辑；文件则候选集 = 该文件（**跳过 `DEFAULT_IGNORE` 与 `.gitignore`**，仍走 `assertInWorkspace` 与 1MB 上限，超限返回明确提示）；`ENOENT` 转「路径不存在: <path>」。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd electron && npx pnpm@9.0.0 vitest run tests/agent/tools/search-tools.test.ts`
Expected: 全 passed。

- [ ] **Step 5: Commit**

```bash
git add electron/src/main/agent/tools/search-tools.ts electron/tests/agent/tools/search-tools.test.ts
git commit -m "fix(agent): grep 支持 path 指向单个文件"
```

---

### Task 9: 全量验证与本机手工验收

**Files:** 无代码改动（发现问题则回到对应任务的 Step 1）

- [ ] **Step 1: 双 workspace 类型检查**

Run: `npx pnpm@9.0.0 typecheck`
Expected: 两个 workspace 均 0 errors。

- [ ] **Step 2: electron 全量单测**

Run: `cd electron && npx pnpm@9.0.0 vitest run`
Expected: 全 passed，无 skipped。**注意**：若出现 SIGKILL / 段错误，先清理孤儿 worker 再重跑（见 AGENTS.md「vitest 崩溃运行孤儿化 worker」）；DB 重度目录可加 `--pool=forks`。

- [ ] **Step 3: 本机 Windows 手工验收（8 条，must pass）**

启动 `npx pnpm@9.0.0 dev`，在工作空间 `C:\Users\stbearangel\wspase\ws001` 逐条执行：

| # | 操作 | 期望 |
|---|---|---|
| 1 | `bash` 跑 `node -v; python --version; npm -v; git --version` | 四个都有版本号输出 |
| 2 | `bash` 跑 `Write-Output "中文测试"`、`node -e "console.log('中文')"`、`python -c "print('中文')"` | 三条都无乱码 |
| 3 | `bash` 用 `[System.IO.File]::WriteAllText($p,$s,[System.Text.UTF8Encoding]::new($false))` 写含中文的 `t.html` | 文件前 3 字节不是 `EF BB BF`，按 UTF-8 可读 |
| 4 | `browser_navigate { url: "研发周报PPT模板.html" }` | 打开成功，返回绝对 URL 与标题 |
| 5 | `browser_navigate { url: "研发周报PPT模板.html#p2" }` | 页面真的跳到第 2 页 |
| 6 | `browser_navigate { url: "../../Windows/win.ini" }` | 明确拒绝，文案含工作空间根与相对路径建议 |
| 7 | `browser_tabs { action:'open', url:"研发周报PPT模板.html" }` | 同样成功 |
| 8 | `grep { pattern: "id=\"p2\"", path: "研发周报PPT模板.html" }` | 有命中（不再 ENOTDIR） |

- [ ] **Step 4: Commit（若 Step 3 触发过修复）**

```bash
git add -A
git commit -m "fix(agent): 手工验收暴露的问题"
```

若未触发修复，此步跳过。
