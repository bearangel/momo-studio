# Windows 下 agent 浏览器 / 命令执行缺陷修复 设计文档

- 日期：2026-11-02
- 状态：待评审（rev.2，已并入 builder check 的 7 条反馈）
- 上游现场：运行日志 + `state.db` 事件流（一次 PPT 任务、一次 Excel 任务）
- 关联版本：`2.1.0-alpha.56`（commit `06e5cd93`）

## 1. 意图与原因

在 macOS 上开发、验证过的 agent 能力，第一次在 Windows 实机上跑就暴露了三类失败。用户的三句原话：

1. 在 windows 中 agent 无法使用内置浏览器打开本地网页
2. agent 貌似无法执行命令脚本
3. agent 回复系统没有 node 和 python，但我系统明明安装，powershell 里能看到

第 3 条把前两条的根一起拉了出来：**不是环境缺东西，是工具把环境弄丢了。**

这不只是"Windows 支持不完整"，它直接毁掉了 agent 的自我纠错能力：模型拿到的错误信息（「非法 file:// URL」）和一个空 PATH 造成的假事实（「系统没装 node」）都会把它推向几十轮的无效试探——现场那次 PPT 任务跑了近 1700 条事件，最后靠 PowerPoint COM 绕出来。

### 1.1 现场证据（可复核）

| 现象 | 证据 |
|---|---|
| 空 PATH | 子进程白名单实际只剩 `TEMP,TERM,TMP,USERPROFILE,WORKSPACE_DIR,MOMO_STUDIO_AGENT`；`PATH` 被丢弃，因为白名单写大写 `PATH`，Windows 的键是 `Path` |
| 缺 PATHEXT | 补上 `Path` 后 `node -v` 仍「无法识别」；再加 `PATHEXT` 才恢复（实测 `v24.22.1` / `Python 3.13.17`） |
| 中文乱码 | `chunk.toString('utf-8')` 解码 PS 5.1 的 GBK 输出；事件流里可见 `[��չ]`、`��з��ܱ�PPTģ��` |
| Python 中文 | `python -c "print('中文')"` 按 locale 写 cp936 字节 → 按 UTF-8 解必乱码（实测） |
| `file://` 相对路径 | 5 次 `browser_navigate` 全抛 `BrowserProtocolError`；win32 `fileURLToPath` 对 `file:///研发周报PPT模板.html` 抛 `ERR_INVALID_FILE_URL_PATH: must be absolute` |
| `grep` 传文件 | `grep { path: '研发周报PPT模板.html' }` → `ENOTDIR: not a directory, scandir` |

`bash` 工具本身**已授权**（`agent_assignment_capabilities` 中 `bash` 为 `mode=add`），不是权限问题。

## 2. 目标

1. Windows 上 `bash` 能解析并运行 `node` / `python` / `npm` / `git` 等外部程序
2. Windows 上程序输出（含中文、含报错、含 Python）按 UTF-8 正确回传给模型
3. `browser_navigate` 与 `browser_tabs {action:'open'}` 能打开工作空间内本地文件（三平台统一支持相对路径）
4. `grep` 的 `path` 指向单个文件时可正常搜索
5. 上述失败若再次发生，错误信息必须给出可执行的下一步

## 3. 非目标

- 不做 bash → PowerShell 命令转译层（见 §4）
- 不引入 Git Bash / WSL，不加 shell 选项设置项
- 不改浏览器信任门 / 域名策略 / workspace 文件边界语义
- 不改 Windows 无 OS 沙箱的现状
- **不改 PS 的默认写文件编码**（`>` / `Out-File` / `Set-Content` 行为原样），改用工具描述给标准写法（见 §5.2c）
- 不补 `office_write`（另一个独立根因）——单独立项
- 不改 `browser_evaluate` 默认关的现状

## 4. 方案选择（已定）

### 4.1 本地文件打开：A / B → **A**

| 方案 | 做法 | 取舍 |
|---|---|---|
| **A（选定）** | 工具层把相对路径解析成工作空间内绝对路径 | 三平台统一受益；安全边界零改动；mac/linux 从"报错"变"可用"（行为变更） |
| B | 只改 Windows 错误文案，让模型自己写绝对路径 | mac/linux 行为不变；但模型仍不知道工作空间根，只能猜 |

### 4.2 Windows shell 语义：甲 / 乙 / 丙 / 丁 → **甲**

| 方案 | 做法 | 理由 |
|---|---|---|
| **甲（选定）** | 修 env 与编码；工具描述按实测 shell 生成 | 只修客观错误，零抽象层 |
| 乙 | bash→PowerShell 转译 | 引号/转义必然漂移；错误指向改写后的命令 |
| 丙 | 优先 Git Bash / WSL | 需 Windows↔POSIX 路径互转，等于新增一套平台适配 |
| 丁 | 甲 + 设置项选 shell | 无真实需求驱动，留待以后 |

### 4.3 写文件编码：甲 / 乙 / 丙 → **丙**

| 方案 | 做法 | 理由 |
|---|---|---|
| 甲 | 只保证 stdout 不乱码 | 用 `>` 写中文仍产出 UTF-16LE 文件 |
| 乙 | 再加 `$PSDefaultParameterValues['Out-File:Encoding']='utf8'` | PS 5.1 只能写**带 BOM** 的 UTF-8，`JSON.parse` 等下游会炸 |
| **丙（选定）** | 甲 + 工具描述给出无 BOM 的标准写法 | 无副作用、可控、有据可依 |

## 5. 设计

### 5.1 子进程环境变量白名单平台化

**位置**：`electron/src/main/agent/tools/shell-tools.ts` → `buildSandboxEnv`

**签名**（现有调用点不变）：

```ts
export function buildSandboxEnv(
  ctx: ToolContext,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv
```

- **posix 分支**：**逐字保留现有清单**（`PATH, HOME, USER, LANG, LC_*, SHELL, TERM, TMPDIR, TMP, TEMP`），大小写敏感比对。行为零变更。
- **win32 分支**：**大小写不敏感**比对（Windows 环境变量名不分大小写），清单：

  `Path, PATHEXT, SystemRoot, SystemDrive, WINDIR, ComSpec, TEMP, TMP,`
  `USERPROFILE, HOMEDRIVE, HOMEPATH, USERNAME, USERDOMAIN, COMPUTERNAME,`
  `PSModulePath, APPDATA, LOCALAPPDATA, ProgramData, ProgramFiles,`
  `"ProgramFiles(x86)", PUBLIC, NUMBER_OF_PROCESSORS, PROCESSOR_ARCHITECTURE, OS`

- **win32 额外固定注入**（不属于白名单透传，是工具方主动设定）：
  `PYTHONUTF8=1`、`PYTHONIOENCODING=utf-8`
  —— 理由见 §5.2c；**仅 win32**，posix 分支不注入，保持零影响。
- 两分支继续注入 `WORKSPACE_DIR` 与 `MOMO_STUDIO_AGENT=1`（不变）。

**为什么不以"安全"为名扣住 APPDATA 等变量**：Windows 侧本来没有 OS 沙箱（`resolveShellSpawn` 走 `plain` 直跑），子进程有完整文件读权限——藏变量不产生隔离效果，只让工具链莫名失败。真正的隔离在 `assertInWorkspace` 与工具白名单。

### 5.2 命令输出与写文件编码

#### 5.2a win32 强制 UTF-8 输出（新纯函数）

`electron/src/main/sandbox/windows.ts`：

```ts
/** PowerShell 命令序言：控制台输出编码钉成 UTF-8（PS 5.1 默认 GBK） */
export function buildWindowsCommandLine(command: string): string
// 返回 '$OutputEncoding = [Console]::OutputEncoding = [System.Text.Encoding]::UTF8;\n' + command
```

`resolveShellSpawn` 的 win32 分支改用它：

```ts
return { kind: 'plain', shell,
  args: ['-NoProfile', '-NonInteractive', '-Command', buildWindowsCommandLine(command)],
  tag: 'win-powershell' };
```

实测（PS 5.1.19041）：PS 自身中文、node 中文、`CommandNotFoundException` 报错信息三者均正常。

#### 5.2b 跨平台流式解码（新共享模块）

`electron/src/main/agent/tools/shared/stream-decode.ts`：

```ts
/** 按 UTF-8 流式累积子进程输出，超出 limit 后丢弃并标记截断 */
export interface Utf8Collector {
  write(chunk: Buffer): void;
  /** close 时调用：冲出不完整序列的尾字节 */
  end(): void;
  readonly text: string;
  readonly truncated: boolean;
}
export function createUtf8Collector(limit: number): Utf8Collector
```

内部用 `node:string_decoder`，替代 `chunk.toString('utf-8')`。修的是**三平台共有**的缺陷（多字节字符被 chunk 边界切断）。

**两个消费点都换**（同一类缺陷只补单点 = 项目已复盘过的高发错误）：
- `shell-tools.ts` `bashOnce` 的 stdout / stderr
- `git-tools.ts` `runGit` 的 stdout / stderr

#### 5.2c 写文件编码：只教不改

- `PYTHONUTF8=1` / `PYTHONIOENCODING=utf-8`（§5.1 win32 注入）：实测 Python 中文输出从乱码恢复正常。
- **不改** `>` / `Out-File` / `Set-Content` 的默认编码（乙方案否决：PS 5.1 只能写带 BOM 的 UTF-8）。
- 在 Windows 版的 shell 工具描述里给出标准写法：

  ```
  写文本文件（HTML/JSON/CSV/脚本）用无 BOM 的 UTF-8：
    [System.IO.File]::WriteAllText($path, $content, [System.Text.UTF8Encoding]::new($false))
  不要用 `>` / `Out-File`：PS 5.1 会写成带 BOM 的 UTF-8 或 UTF-16LE，下游工具读不了。
  ```

### 5.3 `browser_navigate` / `browser_tabs(open)` 支持工作空间相对路径（A 方案）

**新增纯模块**：`electron/src/main/browser/url-input.ts`（零 electron 依赖，可直接单测）

```ts
export interface ResolveNavigateInputOpts {
  workspaceDir: string;
  /** 仅用于「平台绝对性」判定与 file: 解析；缺省 process.platform */
  platform?: NodeJS.Platform;
  /** 注入以便 win32 单测（node:url 的 file↔path 语义按 process.platform 内部分叉，模板要求手写 mock） */
  fileUrlToPath?: (u: URL) => string;
}

export function resolveNavigateInput(raw: string, opts: ResolveNavigateInputOpts): { url: string }
```

**判定顺序**（顺序即契约）：

1. 去首尾空白；空串 → 抛「URL 为空」
2. **先排除 Windows 盘符形态**：`^[A-Za-z]:[\\/]` → 视为无 scheme 的平台绝对路径（否则 `C:` 会被当成 scheme）
3. `http:` / `https:` → 原样返回（域名单/黑名单仍在 policy 判）
4. `file:` → **先试 `fileUrlToPath(url)`**：
   - 成功 → `pathToFileURL(path.resolve(abs))`，附回原 `search` / `hash` → 返回（越界由 policy 拒）
   - 抛错（win32 无盘符形态 `file:///x.html`，或非法 percent-encoding）→ 取 `url.pathname`，`decodeURIComponent` 后落到第 6 步
   - 说明：posix 上 `file:///x.html` 不抛错（返回 `/x.html`）→ 走"平台绝对"分支 → 由 policy 按越界拒绝（见 §5.3 已知取舍）
5. 其他已知 scheme（`ftp:` / `data:` / `javascript:` / `chrome:` 等）→ 原样返回，由 policy 抛 `BrowserProtocolError`（保持既有错误分类）
6. 无 scheme 或第 4 步回退：
   - 按**首个** `#` 或 `?` 切出 `pathPart` + 后缀（**必须先切**，否则 `a.html#p2` 会把 `#p2` 当文件名）
   - `pathPart` 尝试 `decodeURIComponent`（失败则原样用，不因字面 `%` 报错）
   - 平台绝对判定（win32：`^[A-Za-z]:[\\/]` 或 `^\\\\`；posix：`^/`）
     - 绝对 → `pathToFileURL(path.resolve(pathPart))`
     - 否则 → `pathToFileURL(path.resolve(workspaceDir, pathPart))`
   - 把后缀拆成 `search` / `hash` 挂回结果 URL

**调用点（两处，都是 agent 可见入口）**：

| 位置 | 改动 |
|---|---|
| `browser-tools.ts` `browser_navigate` | `resolveNavigateInput(raw, { workspaceDir: ctx.workspaceDir })` 后再 `manager.navigate` |
| `browser-tools.ts` `browser_tabs` 的 `open` 分支 | 同上，再 `manager.tabsAction(..., url)` |

用 `ctx.workspaceDir`（工具层已有、无过期风险），不用 policy 的 `workspaceRoot`（跟随活跃 ws，跨 ws 可能陈旧）。

**地址栏（`manager.userNavigate`）不改**：URL 栏就是 URL 栏，静默把 `/etc/hosts` 重解释成工作空间内文件是意外行为。地址栏继续只接受绝对 URL。

**policy 层改动（从"零改动"修正为两处小改）**：

1. `assertFilePath` 的返回值补回 `search` / `hash`。现状 `pathToFileURL(normalized).href` 会把 `#p2` 吃掉，端到端导航落到无锚点页面——单测全绿而用户看不到的典型陷阱。边界检查仍只在 `pathname` 上做，安全语义不变。
2. `BrowserFileAccessError` 文案补工作空间根与可执行建议：

   > 文件不在工作空间内：`/etc/passwd`。工作空间根：`C:\Users\...\ws001`。请传相对路径（如 `report.html`）或工作空间内的绝对路径。

**已知取舍（平台差异，需评审确认）**：`file:` + 无盘符形态（`file:///x.html`）在 win32 按相对路径处理（win32 本无此形态的合法含义），在 posix 仍按绝对路径处理（`/x.html` 合法，越界就该拒）。两侧各自只有一种合理语义；工具结果回显**最终绝对 URL**，模型下一轮可自纠正。**裸相对路径（`x.html`）三平台语义完全一致**。

### 5.4 `grep` 支持 `path` 指向单个文件

**位置**：`electron/src/main/agent/tools/search-tools.ts` → `executeGrep`

1. `assertInWorkspace(startDir)` 后 `fs.stat`
2. 目录 → 现有逻辑不变
3. **文件** → 候选集 = 该文件本身，`cwd` = `dirname`；`include` 被忽略（只可能命中这一个文件）
   - **绕过 `DEFAULT_IGNORE` 与 `.gitignore`**：用户显式点名 `dist/x.html` 就该搜它，不该静默给「(无匹配)」
   - **保留 1MB 上限，但不静默**：超限时返回「文件超过 1MB 未搜索：<path>（可按范围分段读）」
4. 不存在 → 抛「路径不存在: <path>」

`glob` 的 `path` 保持只接受目录（语义如此），不存在时给同样明确文案。

### 5.5 工具描述按**实测 shell** 生成

**位置**：`shell-tools.ts` → `ShellTools.getDefs()`

`getSandboxState()?.windowsShell` 决定文案（`sandbox/windows.ts` 的 `detectWindowsShell` **优先 pwsh.exe**；pwsh 7 支持 `&&` 且默认 UTF-8，绝不能对 PS 7 硬写"不支持 &&"——那正是甲方案"把事实告诉模型"的反面）。

```ts
function shellToolDescription(platform: NodeJS.Platform, detectedShell: string | null): string
```

- **posix**：现状 + 「支持 `&&` 串联；外部程序从 PATH 解析」
- **win32 + `pwsh.exe`**：「运行环境是 PowerShell 7（pwsh）。支持 `&&`；输出 UTF-8」
- **win32 + `powershell.exe`**：「运行环境是 **Windows PowerShell 5.1**（不是 bash、不是 pwsh）。串联用 `;`，**不支持 `&&`**；路径分隔符 `\`，反引号是转义符；输出已按 UTF-8 解码；`node` / `python` / `npm` / `git` 可直接调用」
- **win32 探测态为 null**（子进程尚未探测）：中性文案 + 自检指引「先跑 `$PSVersionTable.PSVersion` 确认 shell 版本再决定用 `;` 还是 `&&`」

三个平台文案都补：**写文件用 §5.2c 的无 BOM 写法**（win32 适用），以及「环境变量是受限白名单，不要依赖 `PATH` 以外的自定义变量」。

`browser_navigate` 描述补：「支持 http(s) URL、工作空间内相对路径（如 `report.html`、`sub/a.html#p2`）、工作空间内绝对 `file://` URL」。

**只改描述，不改执行逻辑**——甲方案的落地形态。

## 6. 平台影响矩阵

| 修复项 | 改动文件 | 门控 | macOS / Linux 影响 |
|---|---|---|---|
| env 白名单 | `shell-tools.ts` | `platform` 参数，两套清单 | **零**（posix 清单逐字保留，测试锁定） |
| PYTHONUTF8 等注入 | `shell-tools.ts` win32 分支 | win32 only | **零** |
| UTF-8 序言 | `sandbox/windows.ts` + `sandbox/index.ts` win32 分支 | win32 分支内 | **零**（posix 走 bwrap/seatbelt） |
| 流式解码 | 新 `shared/stream-decode.ts` + `shell-tools.ts` + `git-tools.ts` | 无 | **正向**（修跨 chunk 多字节截断） |
| 相对路径 | 新 `browser/url-input.ts` + `browser-tools.ts` 两处 | 无 | **行为变更**：相对路径从"报错"变"可用"；越界拒绝不变 |
| hash/query 保留 | `browser/policy.ts` `assertFilePath` | 无 | **正向**（修锚点丢失，三平台同样问题） |
| `grep` 文件路径 | `search-tools.ts` | 无 | **正向**（补缺失能力） |
| 工具描述 | `shell-tools.ts` / `browser-tools.ts` | 按平台+实测 shell | 仅文案 |

**风险排序**：env / 编码 / 解码 / grep / hash 为纯修复（低）；相对路径是唯一跨平台行为变更（中，靠边界检查 + 测试锁）。

## 7. 测试计划

> 遵循仓库模板：**不 mock `process.platform`**（`tests/platform/paths.win32.test.ts` 文件头明令禁止），平台分叉一律经显式参数或纯函数进入。

| 用例文件 | 覆盖 |
|---|---|
| `tests/agent/tools/sandbox-env.test.ts`（新） | win32：大小写混合假 env（`Path`/`SystemRoot`）→ 保留；`OPENAI_API_KEY`/`GITHUB_TOKEN` 不下发；`PYTHONUTF8` 被注入。posix：输出与旧实现**逐字相等**（旧清单快照比对）；`PYTHONUTF8` **不**注入 |
| `tests/sandbox/windows-command-line.test.ts`（新） | 序言在位、原命令原样在尾部、含换行/分号不被破坏 |
| `tests/agent/tools/shared/stream-decode.test.ts`（新） | 3 字节中文从中间切两 chunk → 无乱码（旧实现必挂）；超限截断标记；`end()` 冲尾 |
| `tests/browser/url-input.test.ts`（新） | 裸相对路径 / `./a.html` / `sub/a.html` / **`a.html#p2`（fragment 不参与 resolve）** / `a.html?x=1` / `C:\abs\a.html` / `file:///C:/abs/a.html`（win32，注入 mock `fileUrlToPath`）/ `file://srv/share/x`（UNC）/ `file:///a.html`（win32=相对、posix=绝对）/ `http://localhost:5173/x` 原样 / `ftp://x` 透传 / 空串抛错 |
| `tests/browser/policy-relative.test.ts`（新，套 win32 mock 模板） | 相对路径→绝对 file URL 能过 `assertUrl`；`../../escape` 抛 `BrowserFileAccessError`；符号链接逃逸仍拒；**`file:///C:/ws/a.html#p2` 返回值保留 `#p2`** |
| `tests/agent/tools/browser-tools.test.ts`（扩充） | `browser_navigate {url:"report.html"}` → `manager.navigate` 第二参为绝对 `file://` URL；`browser_tabs {action:'open', url:"report.html"}` → `tabsAction` 收到绝对 URL（两个入口的跨层契约锁） |
| `tests/agent/tools/search-tools.test.ts`（扩充） | 文件路径 → 只搜该文件；被 gitignore 的文件显式点名仍能搜；>1MB → 明确提示未被搜；目录 → 行为不变；不存在 → 中文错误 |
| `tests/agent/tools/git-tools.test.ts`（扩充） | 中文输出跨 chunk 不乱码（共享解码器接线验证） |

**手工验收（本机 Windows，必须逐条做）**：

1. `bash` 跑 `node -v; python --version; npm -v; git --version` → 四个都有版本号
2. `bash` 跑 `Write-Output "中文测试"`、`node -e "console.log('中文')"`、`python -c "print('中文')"` → 三条都无乱码
3. `bash` 用 §5.2c 写法写一个含中文的 `t.html` → **文件无 BOM、UTF-8 可读**
4. `browser_navigate { url: "研发周报PPT模板.html" }` → 打开成功，返回绝对 URL
5. `browser_navigate { url: "研发周报PPT模板.html#p2" }` → **页面真的跳到第 2 页**（锚点未被吃掉）
6. `browser_navigate { url: "../../Windows/win.ini" }` → 明确拒绝，文案含工作空间根
7. `browser_tabs { action:'open', url:"研发周报PPT模板.html" }` → 同样成功
8. `grep { pattern: "id=\"p2\"", path: "研发周报PPT模板.html" }` → 有命中

## 8. 留给实现者的决定

- `url-input.ts` 的「平台绝对性」判定与 `#/?` 切分是否抽成共用工具（若 `webfetch` 将来也需要）
- `buildSandboxEnv` 的 win32 清单是否按「构建工具链最小可用集」再收窄一档
- `grep` 单文件模式下 `file` 字段返回相对 `workspaceDir` 的路径还是 `path` 参数的 basename（多文件形态返回相对 `absStart` 的路径）

## 9. 验收标准

- §7 的 8 条手工验收全绿
- 新增/扩充测试全部通过；`pnpm typecheck` 零错误
- posix 侧 `buildSandboxEnv` 输出与改动前**逐字相等**（测试锁定）
- Windows 专属行为不出现在 posix 分支代码路径上（review + 分支测试双保险）

## 10. 我替你做的判断（请核对）

builder check 提出的 7 条，以下是已定结论，不再需要你回答：

| # | 问题 | 结论 | 依据 |
|---|---|---|---|
| 1 | 相对路径只覆盖 `browser_navigate`？ | **不止**：`browser_navigate` + `browser_tabs{open}` 两个 agent 入口都覆盖；**地址栏不改** | 同一 bug 有两个 agent 可见入口，只补一处必复现；地址栏静默重解释文件路径是意外行为 |
| 2 | win32 `file:///C:/abs/a.html` 会被误判成相对路径 | **先 `fileUrlToPath` 成功即用绝对路径，抛错才回退相对** | 原设计按 pathname 判平台绝对性，win32 盘符与 UNC 都有 host/pathname 形态差异，会误判 |
| 3 | policy 会吃掉 `#p2`，与"零改动"矛盾 | **`assertFilePath` 返回值补回 search/hash**，边界仍只查 pathname | 锚点导航是这类 HTML 的主要用途；否则单测全绿、用户看不到 |
| 4 | 编码保证到哪一层 | **丙**：stdout + PYTHONUTF8；写文件只教不改 | 见 §4.3 |
| 5 | 描述按平台还是按实测 shell | **按平台 + `getSandboxState()?.windowsShell`**，探测为 null 时给中性文案 + 自检指引 | pwsh 7 支持 `&&`，硬写"不支持"会给出错误事实 |
| 6 | `git-tools` 同样的解码缺陷要不要一起改 | **一起改**，抽 `shared/stream-decode.ts` | 同类缺陷只补单点是本项目已复盘的 P0 成因 |
| 7 | `grep` 显式文件是否绕过 ignore / 1MB 上限 | **绕过 ignore，保留 1MB 但明说未搜** | 用户显式点名的文件不该被静默跳过；超限静默等于骗人 |
