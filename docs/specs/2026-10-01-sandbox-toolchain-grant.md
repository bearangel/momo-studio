# 沙箱工具链安装授权 设计文档

- 日期：2026-10-01
- 状态：设计已确认（八节经用户逐节确认），待 spec 审阅
- 上游依据：v2.4 沙箱体系（spec §5/§6，2026-09-13 修订 B 网络双态化）；本设计是修订 B 模式在「写权限」维度的第三次应用（网络态 → net-off 卡 → 工具链写授权）
- 分支基线：独立特性分支 `feat/sandbox-toolchain-grant`（自 main 切出；不依赖 feat/multi-language-lsp）

## 1. 背景与目标

agent 的 bash 受 OS 沙箱约束（写白名单 = workspace + /tmp）。编程工作中「工具链/依赖全局安装」（rustup / npm -g / go install / pip --user）是高频正当需求，但一律被拦，已产生两起实证的 agent 即兴绕路：

1. `.momo-scratch/lsp-test/` 本地安装（对 LSP 子系统不可见，装了也没用；每 workspace 重复）
2. GitHub 下载 rust-analyzer 到 `/tmp`（重启即失、版本不配套、不可见）

绕路本身构成新的风险面（不受控下载、无审批痕迹）。本设计给出**非阻塞的用户授权升级通道**：默认拒绝不变，用户一键（会话级或永久）放行工具链目录写入。

### 前车之鉴（2026-09-13 修订 B，本设计的方法论基础）

阻塞式 ask 信任门机制（sessionGrants 阻塞等待表 / 三值应答 / 超时收敛 / 信任卡推送）已被全链下线，理由：①事后文本鉴定永远漏检；②**阻塞等待卡在无人值守场景必然超时按拒绝收敛，等效于变相 deny**。现行成熟模式 = 设置态单点判定 + 非阻塞签名检测 + 一次性引导卡。本设计完整复用该模式，不复活任何阻塞语义。

### 非目标

- per-command 命令级审批（事前命令形态鉴定不可枚举，阻塞式已证伪——见 §3 方案对比）
- Windows（无 OS 沙箱恒 plain，设计不适用）
- brew / apt 等系统包管理器放行（不进预置目录集；用户自行加入清单属显式选择）
- App 代装扩展（GitHub release 一键装等，属 LSP 子系统的 D3 演进，另行立项）

## 2. 决策记录

| # | 问题 | 决策 |
|---|---|---|
| D1 | 放开方式 | 否决「工具链目录写白名单常开」（PATH 目录可写 = 沙箱外执行植入面）；采用「默认 deny + 用户显式授权升级」 |
| D2 | 授权生命周期 | **会话 grant + 设置双态**：设置默认 deny；引导卡「本会话允许」（app 运行期有效）+「永久允许」（设置页） |
| D3 | 目录集 | **用户可配置清单 + 预置默认五项**（~/.rustup、~/.cargo、~/go、npm 全局 prefix、pip --user 目录）；brew/apt 不预置 |
| D4 | 交互形态 | 非阻塞（修订 B 模式）：拦截→结果附结构化提示（同服 LLM 与 renderer）→一次性引导卡→授权→agent 重试自然通过 |
| D5 | 查询通道 | 扩展现有 net-trust-op 的 effective op 载荷（{ netOn, toolchainOn }），不新增子进程桥通道 |

## 3. 方案对比记录

| 方案 | 结论 |
|---|---|
| A. 完整复用修订 B 链（采纳） | 全部组件有成熟先例，零新协议形态 |
| B. 事前命令鉴定 | 否决：命令形态不可枚举，「事前鉴定永远漏检」与修订 B 批判的「事后鉴定永远漏检」同构 |
| C. 专用 install_toolchain 工具 | 否决为主方案：App 代装覆盖不了任意生态；已按 LSP D3 演进另行考虑 |

## 4. 授权状态模型

```
GlobalSettings 新增两键（kv 持久，settings/crud 单一真相源）：
  sandboxToolchainPolicy: 'deny' | 'allow'   默认 deny（懒迁移：无键 → deny，写回）
  sandboxToolchainDirs:   string[]           默认预置五项；用户可编辑（设置页）

会话 grant（主进程内存表，sandbox 域持有）：
  Map<workspaceId, true>  「本会话允许」置位；app 运行期有效（重启自然失效）
  语义说明：「本会话」= 本次应用使用期间，按 workspace 键控——比对话会话略宽松，
  免去多 agent 团队/子会话边界纠缠；单用户本地产品可接受，spec 明示。

有效授权（spawn 前单点判定）：
  toolchainOn = (sandboxToolchainPolicy === 'allow') || grantTable.has(workspaceId)
```

预置默认五项（存储为字面 `~/` 前缀，消费时按 HOME 展开 + realpath 归一；npm prefix 运行时 `npm prefix -g` 探测解析一次缓存）：

| 项 | 覆盖 |
|---|---|
| `~/.rustup` | rustup 工具链/组件 |
| `~/.cargo` | cargo bin shims / registry |
| `~/go` | go install 产物（GOBIN 默认）|
| npm 全局 prefix | `npm install -g`（bin + lib）|
| pip --user 目录 | `pip install --user`（~/Library/Python/X.Y 或 ~/.local）|

## 5. 数据流（端到端）

```
agent: rustup component add rust-analyzer
 → seatbelt 拦（写 ~/.rustup EPERM）
 → shell-tools 结果检测（§7）→ 尾部追加固定提示段
 → LLM 读提示：请求用户授权（不再绕路）
 → renderer stream.store 检测固定子串 → 一次性引导卡
 → 用户「本会话允许」→ invoke sandbox:grantToolchain(workspaceId) → grant 表置位
 → 用户告知 agent 已授权 → agent 重试
 → spawn 前 effective 查询返回 toolchainOn=true
 → resolveShellSpawn(opts.toolchainEnabled) → buildPolicy 填 toolchainDirs
 → profile 追加目录集 allow → 安装成功（PATH 本就透传，装完即可执行）
```

黑名单（assertCommandAllowed）、敏感目录 deny、网络双态、env 白名单全部不变——授权只扩「写目录集」一个维度。

## 6. spawn 前查询（扩展现有桥）

`net-trust-op` 的 `effective` op 返回载荷扩展：`{ ok: true, payload: { netOn, toolchainOn } }`。

- 向后兼容：旧消费者只读 netOn；线协议消息形状不变（payload 加字段）
- `net-trust-bridge.ts` 的 EffectiveNetworkDecision 扩展为 EffectivePolicyDecision（或并列字段），shell-tools execute 一次查询取两态，显式传入 resolveShellSpawn
- 主进程 handleNetTrustOp 读 getSandboxSettings()（扩展后含 toolchain 字段）+ grant 表（新增 workspaceId 入参——effective op 载荷加 `workspaceId` 字段，向后兼容旧载荷缺省时 grant 按 false）

## 7. 拦截提示层（一段文本，两端同服）

shell-tools 组装 bash 结果时检测三条件（全部命中才追加提示段）：

1. `plan.tag` 为 `seatbelt/*` 或 `bwrap/*`（确在 OS 沙箱内——win-powershell / unsandboxed 不触发）
2. stderr 命中写拒绝签名：`EPERM` / `Operation not permitted` / `Permission denied` / `Read-only file system`
3. 命令或 stderr 含 HOME 路径特征（`~/` 或 `$HOME` 或展开后的 home 绝对路径前缀）

固定提示段（逐字锁测试）：

> 「⚠ 非工作空间路径写入被沙箱拦截。若这是工具链/依赖的安装步骤：请让用户点击会话中的引导卡授权（本会话有效），或请用户在终端自行执行；用户操作后重试同一命令即可。不要尝试下载到临时目录或工作区缓存绕过——那对系统工具注册不可见。」

- LLM 可读：知道正确动作是请求用户 + 重试（消灭 .momo-scratch//tmp 式即兴——最后一句直接针对两起实证）
- renderer 可测：stream.store 检测固定子串「非工作空间路径写入被沙箱拦截」（单一签名实现[子进程]、单一标记检测[renderer]，零跨进程协议）
- 检测在子进程结果组装处实现为纯函数（导出单测），误报方向安全（多提示不损失安全性；tag 条件保证非沙箱环境永不触发）

## 8. 引导卡（SandboxNotice 同型）

- 检测命中 → 一次性卡（kv flag `toolchainPromptDismissed`；`sandbox:dismissPrompt` 的 kind 联合类型增加 `'toolchain'`）
- 内容：标题「agent 需要写入工具链目录」+ 说明（如 rustup / npm -g 类安装被沙箱拦截）+ 失败命令预览（截断 200 字符）
- 动作①「本会话允许」→ `invoke sandbox:grantToolchain(workspaceId)`（主进程 grant 表置位 + dismiss 卡）
- 动作②「永久允许」→ 跳转 设置→安全沙箱（锚点）
- 一次性语义同 netBlockedSeen：每 app 运行期至多自动弹出一次；卡消失后用户仍可从设置页操作授权/开关

## 9. 沙箱 profile 渲染（平台无关策略 + 双平台）

- `ShellSandboxPolicy` 增加 `toolchainDirs: string[]`（未授权 = 空数组；元素为展开+realpath 归一后的绝对路径；目录不存在不强制——allow 不存在路径无害，安装动作会创建它）
- macOS（renderSeatbeltProfile）：每目录追加 `(allow file-write* (subpath "<dir>"))`——deny default 与 sensitiveDirs deny 的后置覆盖语义不变
- Linux（buildBwrapArgs）：同型追加 `--bind <dir> <dir>`（rw）
- buildPolicy(workspaceDir, networkEnabled, toolchainDirs) 签名扩展（第三参缺省空数组，向后兼容既有调用方与测试）

## 10. 设置页（SandboxSettingsPanel 扩展）

1. 新增 radio 区块「工具链目录写入」（对齐网络出站双态形态）：
   - `deny（默认）`——沙箱内不可写工具链目录；agent 遇拦截时会话引导卡可临时授权
   - `allow`——永久允许（清单内目录可写）
2. 新增「工具链目录清单」编辑区：textarea（每行一个路径，支持 `~/` 前缀）+ 当前生效清单只读回显（展开后绝对路径，含 npm prefix 探测值）+「恢复默认」按钮；保存写 `sandboxToolchainDirs`
3. 保存走既有 `settings:updateGlobal` 通道；SandboxApiSurface 增加 `grantToolchain(workspaceId): Promise<void>`；SandboxInfo 扩展 `toolchainPromptDismissed: boolean` 与 settings 两字段（renderer 镜像 types.d.ts 同步）

## 11. 安全论证（设计内记录）

- 威胁模型：单用户本地产品；主要风险 = agent 失误/幻觉命令，非恶意用户
- 植入向量分析（工具链目录多在 PATH 上 → 写入即潜在沙箱外执行）：缓解 = 默认 deny + 授权须用户显式动作（卡上点击 / 设置页选择）+ 会话 grant 窗口有限（app 运行期）+ 目录清单完全可审计可编辑 + 黑名单与敏感目录 deny 不受授权影响
- 授权扩的仅是「写目录集」；读全盘、网络双态、进程语义、env 白名单均不变
- brew/apt 不预置的理由：系统包管理器写 /opt/homebrew、/usr 等系统域，风险面与用户域工具链目录不同级；用户显式加入清单属知情选择

## 12. 平台矩阵

| 平台 | 行为 |
|---|---|
| darwin | seatbelt profile 追加 allow file-write* |
| linux | bwrap --bind 追加 |
| win32 | 不适用（无 OS 沙箱恒 plain；提示层 tag 条件天然不触发）|

## 13. 测试策略

- **electron**：
  - 提示层纯函数：三条件组合（真 EPERM 形态 / 非沙箱 tag 不触发 / 无 HOME 特征不触发）；提示段逐字锁
  - effective op 双字段：payload 含 toolchainOn；旧载荷（无 workspaceId）grant 按 false；桥端单测迁移
  - grant 表：置位/查询/app 运行期语义；grantToolchain invoke
  - buildPolicy / renderSeatbeltProfile / buildBwrapArgs：授权态目录出现在 allow/bind、未授权不出现、`~` 展开 + realpath 归一、清单去重
  - 设置读写：默认值（无键 → deny + 预置五项）、懒迁移、清单写回
- **renderer**：stream.store 固定子串检测置位（一次性）；引导卡渲染/动作（grantToolchain 调用参数 / 跳设置）/dismiss；SandboxSettingsPanel 新区块交互（radio 保存、textarea 编辑、恢复默认）
- **手动验收**：真实 `rustup component add rust-analyzer` 全流程——拦截提示→卡→本会话允许→agent 重试成功→LSP 面板 rust-analyzer 转正→`lsp_diagnostics` 实调（正好闭合今日 Rust 会话的坑）

## 14. 二期路线（非本期）

- 引导卡「本会话允许」后的 agent 自动重试通知（当前靠用户口头告知重试）
- 目录清单的路径校验增强（存在性提示 / 冲突检测）
- App 代装扩展（GitHub release 类 server 一键装，LSP D3 演进）
- 授权审计日志（journal 记录 grant 事件）
