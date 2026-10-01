# 多语言 LSP 子系统重构 设计文档

- 日期：2026-10-01
- 状态：设计已确认（十节经用户逐节确认），待 spec 审阅
- 上游依赖：`docs/specs/2026-09-30-agent-tool-capability-redesign.md`（消费其 ToolCatalogEntry 目录自描述与 Tier 2 分级基建）
- 分支基线：实现应基于 `feat/agent-tool-capability`（消费 Task 2 的 catalog infra），独立特性分支 `feat/multi-language-lsp` 叠加

## 1. 背景与目标

用户报告 LSP 工具不可用。勘察确认三个层次的问题：

1. **判据盲区**：`shouldRegister`（lsp-tools.ts:550）只看 workspace 根目录的 `tsconfig.json`/`jsconfig.json`/顶层 `.ts`/`.js`——对「前后端分体」（backend/ + frontend/ 各自 tsconfig）与「monorepo」（根 `tsconfig.base.json` + 子包 tsconfig）两类常见形态全部误判为非 TS workspace
2. **语言覆盖窄**：仅支持 TS/JS（typescript-language-server 硬编码），用户需求为市面常见流行语言全支持
3. **隐藏性能缺陷（本次勘察新发现）**：`LspManager` 的 per-workspace 单例 Map 活在 **agent 子进程**内，而 task-driven runtime 是一任务一进程（WarmPool 销毁不复用）——**每个任务都要重新冷启动 tsserver**。多语言化后（gopls/clangd 冷启动 30s+）该缺陷将放大 N 倍

目标：

1. LSP 子系统多语言化（16 门常见语言，三层信心分级）
2. server 生命周期上移主进程，冷启动全 app 只付一次
3. workspace 检测单一真相源（主进程一次检测，注册门控与设置面板共享）
4. 设置页新增「语言服务」面板（检测可见性 + 二进制安装引导）
5. 判据盲区随 markers 子目录扫描一并修复

非目标：hover/definition/重命名等导航工具扩展（二期）；诊断回灌 read/编辑闭环（二期，见 §12 路线图）；语言 server 自动安装（二进制策略为用户自装 + 引导，见 D3）；Haskell/Scala/Clojure/OCaml 等小众语言（按需追加注册表行）；DB schema 变更（无 migration）。

## 2. 决策记录

| # | 问题 | 决策 |
|---|---|---|
| D1 | 总体方案 | 主进程 LSP 子系统 + IPC 桥（MCP host-manager / BrowserManager 同型第三例）；否决「子进程内泛化」（每任务冷启动致命）与「MCP 化」（LSP 原生语义被工具 schema 扭曲） |
| D2 | 语言范围 | 16 门全进一期注册表，分两层：验证层 12 + 实验层 4（Java/Kotlin/PHP/Elixir，摩擦大，标注实验性——能力广告真实原则） |
| D3 | 二进制策略 | 用户自装（PATH）+ 面板一键装到 app 管理共享目录（`<userData>/lsp-bin`，仅 npm 分发语言），不自动安装（修正 2026-10-01：原文「PATH 探测 + 缺失时安装引导文案；不自动安装」——增设一键安装后修正表述；一键安装为用户显式点击，非自动安装） |
| D4 | 工具面 | 保持 `lsp_diagnostics` + `lsp_find_references` 两工具、参数不变；语言由主进程按 path 扩展名路由，LLM 不指定语言 |
| D5 | 默认档 | `lsp_*` 维持 Tier 2 defaultOn=false；注册门控 = 检测快照非空 |
| D6 | 设置面板 | 本期交付（二进制自装策略下，无可见性面板则「工具没注册」无从排查） |
| D7 | 检测时机 | 主进程 spawn 时一次，快照注入 `AGENT_CONFIG.lspLanguages`；面板「重新检测」手动刷新（目录变更自动重扫属 YAGNI） |

## 3. 业界调研引用（决策依据）

- **OpenCode**：最完整终端向 LSP（30+ 语言 per-language 配置，`lsp: true` 默认关）；文档原话承认 server 失步/内存/拖慢工作流风险——「默认关」共识与 D5 一致
- **Claude Code**（v2.0.74+）：插件市场 `lspServers` manifest + 用户自装二进制——D3 二进制策略同款
- **arxiv 2608.13568**：符号定位任务 agent 即使 LSP 免费也仅 0-6% 使用率且多耗 token；引用查找精度显著（call-site 召回 1.00 vs grep 0.76）——支撑 D4「只保留 diagnostics/references 两工具、不膨胀导航工具面」
- **Codex CLI / Aider / Gemini CLI**：无 LSP（提案/树替换/纯 file+shell）——反面参照，Momo 选择 OpenCode/Claude Code 路线是有意识分叉

## 4. 架构总览

```
┌─ 主进程 ─────────────────────────────────────────────┐
│ electron/src/main/lsp/（新目录）                       │
│   registry.ts   语言注册表（§5，16 门声明式数据）       │
│   detect.ts     workspace 检测 → LanguageStatus[]      │
│   manager.ts    per (workspace × language) 单例        │
│                 （现有 LspManager 500 行迁出泛化，§6）  │
│   ipc.ts        lsp:op 子进程路由 + lsp:status 面板查询 │
└───────────────────────────────────────────────────────┘
      ▲ AGENT_CONFIG.lspLanguages 检测快照（spawn 时注入）
      ▼ lsp:op / lsp:op-result（工具调用 IPC 往返）
┌─ agent 子进程 ───────────────────────────────────────┐
│ lsp-tools.ts → 薄 IPC 客户端（仿 BrowserManagerPort）  │
│   LspTools.create 门控 = lspLanguages 快照非空         │
└───────────────────────────────────────────────────────┘
```

单一真相源：检测只在主进程跑一次，两个消费方（注册门控经 AGENT_CONFIG、面板经 lsp:status）共享同一结果，杜绝「面板说有、agent 没注册」漂移。

## 5. 语言注册表

```typescript
// electron/src/main/lsp/registry.ts
export interface LanguageServerSpec {
  languageId: string;            // LSP languageId
  label: string;                 // 面板展示名
  binaries: string[];            // PATH 探测候选（按序取首个命中）
  args: string[];                // server 启动参数
  markers: string[];             // toolchain 标志（glob，根 + 一层子目录求值，
                                 //   跳过 node_modules/.git/dist/build/vendor/out）
  extensions: string[];          // 文件扩展名 → 工具调用按文件路由
  tier: 'verified' | 'experimental';
  installHint: string;           // 安装引导（面板 + 工具报错共用）
  initOverrides?: Record<string, unknown>;  // 语言专属 initializationOptions
}
```

一期 16 条注册数据（markers 为 glob；`*.csproj` 类匹配根与一层子目录内文件）：

| languageId | label | binaries（args） | markers | extensions | tier |
|---|---|---|---|---|---|
| typescript | TypeScript / JavaScript | `typescript-language-server`（`--stdio`） | `tsconfig.json` `jsconfig.json` `*/tsconfig.json` `*/jsconfig.json` | .ts .tsx .js .jsx .mts .cts .mjs .cjs | verified |
| python | Python | `pyright-langserver`（`--stdio`） | `pyproject.toml` `requirements*.txt` `setup.py` `setup.cfg` | .py .pyi | verified |
| go | Go | `gopls` | `go.mod` `*/go.mod` | .go | verified |
| rust | Rust | `rust-analyzer` | `Cargo.toml` `*/Cargo.toml` | .rs | verified |
| cpp | C / C++ | `clangd` | `compile_commands.json` `CMakeLists.txt` `Makefile` `configure.ac` | .c .cc .cpp .cxx .h .hh .hpp | verified |
| swift | Swift / Objective-C | `sourcekit-lsp` | `Package.swift` `*.xcodeproj` | .swift | verified |
| ruby | Ruby | `ruby-lsp` | `Gemfile` `*.gemspec` | .rb | verified |
| lua | Lua | `lua-language-server` | `.luarc.json` | .lua | verified |
| shell | Shell | `bash-language-server`（`start`） | `*.sh` `scripts/` | .sh .bash | verified |
| csharp | C# | `csharp-ls` | `*.csproj` `*.sln` | .cs | verified |
| dart | Dart / Flutter | `dart`（`language-server --protocol=lsp`） | `pubspec.yaml` | .dart | verified |
| zig | Zig | `zls` | `build.zig` | .zig | verified |
| java | Java | `jdtls` | `pom.xml` `build.gradle` `build.gradle.kts` `settings.gradle` | .java | experimental |
| kotlin | Kotlin | `kotlin-language-server`（`--stdio`） | `*.kt` `build.gradle.kts` | .kt .kts | experimental |
| php | PHP | `intelephense`（`--stdio`） | `composer.json` `index.php` `artisan` | .php | experimental |
| elixir | Elixir | `lexical` | `mix.exs` | .ex .exs | experimental |

扩展名冲突裁定：`.h` 归 cpp（注册表顺序优先）；Swift 层只挂 `.swift`（ObjC 的 .m/.mm 二期视 sourcekit 效果再挂）。Java 与 Kotlin 的 gradle markers 可同时命中——两门独立 ready，按各自扩展名路由，无冲突。

installHint 示例（完整 16 条在实现的注册表内）：typescript → `npm install -g typescript-language-server typescript`；python → `pip install pyright`（或 `npm install -g pyright`）；go → `go install golang.org/x/tools/gopls@latest`；rust → `rustup component add rust-analyzer`；swift → `xcode-select --install`（Xcode CLT 自带 sourcekit-lsp）。

## 6. LspManager 泛化与生命周期

- 现有 `LspManager`（lsp-tools.ts:150-505：JSON-RPC Content-Length 分帧、pending 表与超时、publishDiagnostics 缓存 + 诊断代数轮询等待、didOpen/didChange 全量同步、闲置自动 shutdown、意外退出恢复、单飞启动）**整体迁移**至 `main/lsp/manager.ts`，语言参数化：
  - 单例键 `workspaceId` → `` `${workspaceId}:${languageId}` ``
  - `resolveServerBin()` → 按 spec.binaries 逐个 PATH 探测（`which` 语义：PATH 目录拼接 + 可执行检查；裸名经 shell 解析的现有兜底保留）
  - `inferLanguageId` → 由注册表 extensions 反查
  - initialize 握手保留 publishDiagnostics 客户端能力声明（现有注释：缺失则 server 判 diagnosticsSupport=false 永不推送）；`initializationOptions` 合并 spec.initOverrides
- **资源保险丝**：每 workspace 活跃 server 上限 3 门；超限报错（中文提示：减少并行语言任务或等闲置回收），不做静默 LRU 杀——静默杀会让下次调用再付冷启动
- 闲置治理（IDLE_TIMEOUT_MS 自动 shutdown）与意外退出恢复语义原样保留
- 冷启动全 app 一次：server 驻主进程跨任务/跨 agent 复用

## 7. IPC 契约（boundary-rules 场景，双 workspace typecheck）

**子进程 → 主进程**（仿 browser-ipc-bridge 的 envelope + reqId 应答；超时与错误回包照 net-trust-bridge 形态）：

```typescript
// 出（languageId 不由子进程指定——主进程按 op.path 扩展名查注册表路由）
{ type: 'lsp:op', reqId, op: {
    kind: 'diagnostics', workspaceId, path, content
  | kind: 'references', workspaceId, path, line /*1-based*/, character /*0-based*/
} }
// 回
{ type: 'lsp:op-result', reqId, ok: true, result: string }
{ type: 'lsp:op-result', reqId, ok: false, error: string }
```

工具执行结果在主进程完成格式化（诊断行/引用位置列表沿用现有输出格式），子进程透传字符串——子进程零 LSP 逻辑。

**主进程 → renderer（面板）**：invoke 通道 `lsp:status(workspaceId)` → `LanguageStatus[]`：

```typescript
interface LanguageStatus {
  languageId: string; label: string; tier: 'verified' | 'experimental';
  toolchain: boolean;        // markers 命中
  binary: boolean;           // 二进制在 PATH
  running: 'running' | 'idle' | 'stopped';  // manager 实际状态
  installHint: string;
}
```

**AGENT_CONFIG 新增可选字段**：`lspLanguages?: string[]`（spawn-helpers 从检测快照注入；缺省 = 不注册 LSP 工具，旧 spawn 站点与测试构造兼容）。ToolContext 同步透传 `lspLanguages?: string[]`。

## 8. 工具层改造

- `LspTools.create(ctx)`：门控从 `shouldRegister(workspaceDir)` 改为 `ctx.lspLanguages !== undefined && ctx.lspLanguages.length > 0`；`shouldRegister` 与内嵌 LspManager 从 lsp-tools.ts 删除
- 工具 defs 参数不变（diagnostics: path；references: path/line/character）；description 更新为多语言语义（「获取代码诊断——按文件类型自动路由语言 server（16 门语言自动检测，部分实验性）」）
- `LSP_CATALOG_ENTRIES` conditional 文案更新：「按 workspace toolchain 自动检测激活；16 门语言（4 门实验性）；server 需已安装」；维持 Tier 2 defaultOn=false
- execute → 组装 op 经 `process.send` 往返，超时与重试语义照 browser-ipc-bridge（reqId 匹配、超时 reject 中文错误）
- 语言路由：主进程按 op.path 扩展名查注册表得 languageId 后进 manager——子进程只传 kind/path/坐标，不判语言

## 9. 检测语义

```
detect(workspaceId, workspaceDir): LanguageStatus[]
  for spec in REGISTRY:
    toolchain = markers 任一 glob 命中（根 + 一层子目录；跳过 node_modules/.git/dist/build/vendor/out）
    binary    = spec.binaries 任一在 PATH
    running   = manager 当前实际状态
    status    = toolchain && binary → 进 lspLanguages 快照（含实验层）
               toolchain && !binary → 'missing-binary'（面板引导安装）
               !toolchain           → inactive（面板灰显）
```

- 检测结果 per-workspace 缓存于主进程；spawn 时取缓存（无则现算）；面板「重新检测」强制重算并刷新缓存
- PATH 探测注意：解析 PATH 环境变量逐目录拼接 + `X_OK` 检查；Electron 主进程 GUI 启动的 PATH 可能缺 shell profile 注入（macOS launchd 环境）——探测前追加 `/opt/homebrew/bin`、`/usr/local/bin` 常见前缀（存在才加、幂等），探测失败时降级经 login shell（macOS `/bin/zsh -lc`、Linux `/bin/bash -lc` 的 `command -v`）兜底，win32 跳过（实现细节，测试覆盖。勘误 2026-10-01：原文「经 `/usr/bin/env which` shell 兜底」不可行——`env` 继承同一 `process.env.PATH`，解析不到 profile 注入的目录）

## 10. 设置面板「语言服务」

挂载点：设置页 workspace 维度区（workspace_settings 同级交互）。线框：

```
语言服务                                    [重新检测]
┌────────────────────────────────────────────────┐
│ TypeScript / JavaScript   ✓ 工程  ✓ server  闲置 │
│ Go                        ✓ 工程  ✓ server  运行中│
│ Python                    ✓ 工程  ✗ 未安装        │
│   缺少 pyright — 复制安装命令                     │
│ Java  (实验)              ✓ 工程  ✗ 未安装        │
│ Rust                      — 未检测到工程标志      │
└────────────────────────────────────────────────┘
```

- 行元素：label / tier 徽标（实验性）/ toolchain ✓✗ / binary ✓✗ / running 状态 / installHint（可复制）；installable 行（仅 npm 分发语言，D3 修正案）含「安装」按钮——一键装到 `<userData>/lsp-bin` 共享目录（busy 态禁用 + 「安装中…」，完成后以重探测 statuses 刷新；失败呈现含 stderr 末尾的中文错误）
- UI 约束（momo-ui-preview-rules）：语义 token、lucide 16px/1.75 图标、状态色走语义类；P1 新交互面——**实现前静态预览确认**（本线框为基准）
- 数据源唯一：`lsp:status` invoke；「重新检测」调 `lsp:redetect`（重算 + 返回新列表）

## 11. 测试策略

- **electron 单测**（tests/lsp/ 镜像 src 结构）：
  - registry：16 条字段完备（tier/二进制/markers/extensions/installHint 非空）
  - detect：tmp fixtures——根 tsconfig / 子目录 go.mod / 无标志 / node_modules 内 marker 跳过 / missing-binary 三态；PATH 探测（注入伪 PATH 目录 + 可执行文件）
  - manager：纯逻辑用例（per-language 键控隔离、binaries 顺序探测、initOverrides 合并、并发上限第 4 门报错、启动失败驱逐单例）不触 server；协议正确性沿用现有 lsp-tools.test 的真实 server 模式（tsserver 冒烟，30s 超时 + afterEach 强制清理防进程泄漏）；闲置 shutdown、意外退出恢复由迁移代码保留既有行为
  - ipc：envelope 解析 / reqId 匹配 / 超时 reject / 主进程路由按扩展名选语言
  - spawn 透传：AGENT_CONFIG.lspLanguages 注入与缺省兼容（buildSpawnOpts 单测）
- **真实 server 冒烟**（skip-if-binary-missing）：tsserver（既有用例迁移）；gopls / pyright 各一条 diagnostics+references 冒烟（容器装了才跑）
- **renderer**：面板组件测试（mock lsp:status 三态 + 实验性徽标 + installHint 渲染 + 重新检测交互）
- **手动验收**：test workspace（backend/frontend 分体结构）→ 面板 TS/Go ready、Python missing-binary 引导 → agent 自报含 lsp 工具 → 实调两工具 → 闲置自动回收观察

## 12. 二期路线图（非本期）

1. 诊断回灌闭环（read 输出尾部注入 / 编辑后回灌同回合自愈——arxiv/OpenCode 实证的最高价值增量）
2. hover / definition / workspaceSymbol 导航工具
3. workspace 级 server 覆盖配置（用户选 pyright vs pylsp 等）
4. Java/Kotlin/PHP/Elixir 转正（init 调优 + 验证补齐）；ObjC .m/.mm 挂载
5. 目录变更自动重扫（file watcher）

## 13. 兼容性说明

- 无 DB migration；无 AGENT_CONFIG 破坏性变更（新字段可选缺省）
- 现 TS workspace（根 tsconfig）行为等价；分体/monorepo 结构由子目录 glob 修复
- def 配了 `lsp_*` 但 workspace 无 ready 语言：工具未注册，白名单名多余无副作用（展示层过滤后模型不可见）——沿用现状语义
- `feat/agent-tool-capability` 的 catalog/展示层过滤与本设计正交组合：lsp 工具仍 Tier 2、仍受白名单与展示层过滤约束
