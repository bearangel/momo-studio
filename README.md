# Momo Studio

个人桌面端多 agent 协作平台：把可声明的 agent、可扩展的 MCP/Skill 市场、IM 通道和受控的文件沙箱，全部装进一个本地 Electron 应用。

完整设计见 `docs/specs/2026-07-28-agent-platform-design.md`。

## 状态

**v1.2 — Released**

## 特性

### Workspace 管理
- 创建 / 删除 / 重命名 workspace
- 每个 workspace 绑定本地目录（`~/...` 或自定义路径）
- 自动 `git init` + 初始 commit，作为 agent 写操作的版本基线
- 所有文件访问走 `WorkspaceFS` 抽象层，禁止越界

### Agent
- YAML 声明式定义（frontmatter + prompt body）
- 内置 Anthropic / OpenAI / Ollama 三个 LLM provider
- 工具系统：内置（bash / file_read / file_write / git）+ MCP 工具
- 主子调度：父 agent 通过 `dispatch` 派发子任务，子任务通过 `task_reply` 回传结果
- 完整运行历史与工具调用审计

### 即时通讯（IM）
- 本地 Conduwuit（Matrix 兼容协议）服务端，零外部依赖
- 支持私聊和房间消息
- Agent 在 IM 内可被 `@` 唤起，并以 Markdown 流式回复
- 客户端渲染支持代码块、表格、链接、引用块

### MCP（Model Context Protocol）
- stdio transport
- 共享进程池：相同 server 配置只启一个进程，工具调用并发安全
- 配置、热重载、生命周期管理在主进程完成

### Skill
- 渐进式披露：`SKILL.md` frontmatter 元数据始终可用，正文按需加载到上下文
- 内置 skill：git-workflow、code-review、debugging、markdown-format

### Marketplace
- 浏览 / 搜索 / 安装 agent / skill / mcp 三类包
- 安装包自动注册到主进程的 agent / skill / mcp 定义列表
- 支持 zip 包下载 + SHA256 checksum 校验
- 市场源可通过设置页切换（默认 + 自定义 URL）

### 安全
- `WorkspaceFS`：所有路径经过验证，禁止 `..` 越界与符号链接逃逸
- 进程沙箱：renderer 进程禁用 Node.js 集成 + contextIsolation
- 审计日志：每次工具调用写入 SQLite，UI 可查询
- Git policy：agent 写文件走 `git commit`，可一键回滚

## 前置依赖

- **Node.js 20 LTS**：Node 26+ 会破坏 `better-sqlite3` 原生编译（`ERR_DLOPEN_FAILED`）。容器默认是 Node 26，先 `nvm use 20`。
- **pnpm 9+**
- 平台：macOS（arm64 / x64）或 Linux（x64）。Windows 是 v2 任务。
- Conduwuit 仅发布 Linux 二进制；macOS / Windows 需要 Docker 运行 Conduwuit（见 `docs/dev/conduit-manual.md`）。

## 安装

```bash
git clone <repo>
cd momo-studio
nvm use 20
npx pnpm@9.0.0 install
```

`postinstall` 会下载预编译的 Conduwuit 二进制。如果下载失败（离线环境），见 `docs/dev/conduit-manual.md` 手动放置。

> **`matrix-js-sdk` 锁版本说明**：仓库锁定 `^31.0.0`（不是 `^34`）。v34 是纯 ESM，与本仓库的 CommonJS Electron 主进程冲突，`pnpm install` 会报 `ERR_REQUIRE_ESM`。lockfile 已反映这个降级。

## 开发

```bash
nvm use 20
npx pnpm@9.0.0 dev
```

应用启动后会跑首次注册向导（创建本地 Matrix 账号），完成后进入主界面。

## 测试

```bash
nvm use 20
npx pnpm@9.0.0 typecheck       # electron + renderer 双 workspace 严格类型检查
npx pnpm@9.0.0 test            # 单元测试（electron + renderer 全部）
npx pnpm@9.0.0 test:e2e        # 端到端集成测试（需要已构建应用，慢）
```

### 单独跑某个 workspace

```bash
npx pnpm@9.0.0 --filter @momo-studio/electron test
npx pnpm@9.0.0 --filter @momo-studio/renderer test
```

## 打包

```bash
nvm use 20
npx pnpm@9.0.0 build                       # 先构建 renderer + electron
npx pnpm@9.0.0 --filter @momo-studio/electron dist  # electron-builder 产出 .dmg / .AppImage / .deb
```

产物输出到 `electron/dist-installers/`。

详细发布流程见 `docs/dev/release.md`。

## 项目结构

```
electron/      Electron 主进程（CommonJS, Node.js）
renderer/      React UI（ESM, Vite）
resources/     Conduwuit 二进制 + 下载脚本
tests/         Playwright 端到端测试
docs/
  specs/       设计文档
  plans/       实施计划
  dev/         开发者指南（setup / conduit-manual / release）
```

两个 workspace 包名：`@momo-studio/electron`、`@momo-studio/renderer`。

## 研发演进路线图

### v1.0.0 — 单机自洽 ✅ 已发布

本地优先的 agent 编排平台。一个用户、一台机器、开箱即用。

- ✅ Electron + React + Conduwuit 一体化桌面应用
- ✅ Workspace 管理（目录映射 + git init）
- ✅ Declarative agent（YAML manifest + LLM chat loop + 工具执行）
- ✅ 主子 agent 调度（IM dispatch/task_reply 协议）
- ✅ MCP stdio transport（共享进程池）
- ✅ Skill 渐进式披露（SKILL.md 三层加载）
- ✅ IM（Matrix /sync + Markdown + @mention）
- ✅ Marketplace 浏览/搜索/安装
- ✅ 安全（WorkspaceFS + sandbox + 审计 + Git policy + 崩溃重启 + LLM 重试）

### v1.1 — 打磨与补全（已完成）

不引入新架构，聚焦 v1 遗留项和体验优化。

#### v1.1.0 — IM 房间管理 + 设置基座（M1，已完成）

- ✅ 会话房间新增 / 重命名 / 自适应解散（本地全员离开清空；团队群受保护）
- ✅ 群成员查看（⭐自己 / 🤖bot / 管理 徽标）
- ✅ 设置页分类导航（左导航 + 右内容）
- ✅ 全局模型供应商注册表（baseUrl + apiKey 入 keychain；创建 agent 时下拉自动填充）
- ✅ Agent 创建表单接供应商下拉

#### v1.1.1 — Agent 编辑 + 文件操作 + 团队群调度（M2，已完成）

- ✅ Agent 创建后可编辑（定义层；apiKey 独立更新；保存后停止运行中实例并提示重启）
- ✅ 文件树折叠修复（根级 + 子目录折叠；刷新/全部折叠工具条）
- ✅ 文件 CRUD（新建 / 改名 / 删除 / 移动；走 WorkspaceFS 路径防御；editor tab 联动）
- ✅ 团队群自动调度（主 agent 默认接待非 @ 消息；@ 别人/子 agent 回复不插嘴；复用主→子 dispatch）

#### v1.2 功能补全

- ✅ **主/子 agent 编排 UI（委派调度）** — v1.2 M3 实现完整编排：runtime subAgents 传递修复 + auto-start 重启重建 + slug→UUID 解析 + IPC 角色/父 agent 校验 + 编排视图（列表/编排切换，树形展示 main→sub 关系，添加子/解除/设为主操作）+ AddAgentDialog 角色选择 + main 定义子 agent 勾选 + AgentList 角色徽标分组 + 移除级联。
- ✅ keychain slot helper 去重（`llmApiKeyRef` 统一使用）
- ✅ `stopRunningInstancesByDefinition` 实际停止分支补测（isAgentRunning=true 路径）
- ✅ `updateAgentDefinition` 的 modelBaseUrl 往返保真（写 NULL 而非空串）
- ✅ 文件树折叠状态 localStorage 持久化
- ✅ 协调 agent 设定后自动重启（不再提示手动操作）
- ✅ `setCoordinator` store 动作异常 catch + 文件 CRUD 操作 try/catch 一致化
- ✅ 编排视图 main 节点折叠/展开
- ✅ assignMain 重复安装守卫 + 编排视图孤儿子 agent 可见性

#### 基础设施项（推迟到 v1.2）

- ✅ `.gitignore` 裸 `docs` 条目清理
- 🔲 重启自动恢复 agent runtime（持久化运行状态）
- 🔲 打包后 YAML/migration 路径适配（内置资源动态定位）
- 🔲 e2e 测试跑通（xvfb + 真实 LLM API key）
- 🔲 Windows 沙箱（AppContainer）
- 🔲 macOS sandbox-exec 实测验证
- ✅ CHANGELOG.md + 版本号规范

#### v1.2 IM 体验优化（已完成）

- ✅ **Dev 模式 agent 行为日志** — `trace()` 函数 + 14 个插桩点（消息接收/LLM 调用/工具执行/dispatch/reply），dev 模式终端实时输出 agent 行为摘要
- ✅ **LLM 请求超时优化** — 单次请求 90s → 300s；dispatch 渐进式超时 3min→6min→fail
- ✅ **IM 卡片归属与对话化视觉** — 抽取 `MessageFrame` 共享消息外壳（头像+名字+左右对齐），三类消息（普通文本/dispatch/task_reply）统一外壳；TaskReplyCard 补齐此前完全缺失的 agent 归属；DispatchCard 去冗余 from 紧凑显示 target
- ✅ **缩窗布局响应式修复** — LeftRail `shrink-0` 永不压扁；RoomList/MembersPanel 可缩；MiddlePanel `min-w-0`；MessageList 禁用水平滚动
- ✅ **Tailwind 任意值 class bug 规避** — 发现 Tailwind JIT 不生成 `max-w-[70%]` 等任意值 class，改用 inline style 约束宽度
- ✅ **IM 工具条 + 成员浮层 + 上下线标签** — InputToolbar 工具条（成员切换按钮 + 预留扩展位）；MembersPanel 从常驻改为按需浮层（absolute 定位 + backdrop 关闭）；移除 agent 启动上线消息，改为成员面板在线/离线 badge（绿/灰）
- ✅ 29 + 11 个新增 IM 组件测试（MessageFrame/DispatchCard/TaskReplyCard/MessageBubble/InputToolbar/MembersPanel），renderer 全套 105 测试通过

### v2.0 — 多人协作 + 进阶 Agent（设计中）

从"单机工具"进化为"团队平台"。

- 🔲 **多 peer P2P 协作** — 多用户通过协调服务器互联，共享 workspace
- 🔲 **Git remote 同步** — workspace 文件通过 bare repo 跨 peer 同步
- 🔲 **跨 peer agent 调度** — @ 对方的 agent，任务经 Matrix 路由
- 🔲 **Agent SDK（programmatic runtime）** — TypeScript/Python 自定义 agent 生命周期
- 🔲 **External runtime 桥接** — 接入 OpenCode / Codex / Claude Code
- 🔲 **MCP HTTP/SSE transport** — 远端 MCP server 接入
- 🔲 **Marketplace 上架** — 用户上传 agent/mcp/skill 包
- 🔲 **E2E 加密** — 人 ↔ 人 DM 加密
- 🔲 **消息搜索** — 全文检索 Matrix 历史
- 🔲 **Electron 主进程 ESM 转换** — 解除 matrix-js-sdk v31 锁定
- 🔲 **macOS 原生 Conduwuit 或内置 Docker 编排**

### v2.1 — 效率增强（概念阶段）

- 🔲 **分支工作流** — agent 工作在独立 branch，PR 式合并
- 🔲 **Agent 并发多任务** — 每 agent 内部 task queue
- 🔲 **Token 配额管理** — 月度 LLM token 预算控制
- 🔲 **LSP 集成** — Monaco 编辑器语言服务（TS/Python）
- 🔲 **协作实时编辑** — 多 peer 同时编辑同一文件（CRDT）

### v3.0+ — 生态扩展（远期愿景）

- 🔲 **Federation** — 跨 homeserver 联邦
- 🔲 **私有 Marketplace** — 企业内部包管理
- 🔲 **付费/计费** — Marketplace 交易
- 🔲 **Headless agent runner** — 7×24 服务端 agent
- 🔲 **移动端** — iOS/Android（只读 + IM）
- 🔲 **NAT 打洞** — peer 直连，省协调服务器带宽
- 🔲 **自动能力发现** — agent 自动搜索并安装缺失 skill
- 🔲 **Agent 自定义代码 hook** — 运行时注入用户代码

### 技术债务跟踪

| 问题 | 影响 | 计划解决版本 |
|---|---|---|
| **Tailwind 任意值 class 不生成 CSS** | `max-w-[70%]` 等无效，宽度约束必须用 inline style | 待排查 Tailwind 版本/PostCSS 配置 |
| matrix-js-sdk 锁定 v31（v34 ESM 冲突） | 无法用最新 SDK 特性 | v2.0 ESM 转换 |
| Conduwuit 无 macOS 二进制 | macOS 需 Docker | v2.0 |
| OS 级沙箱简化实现 | 仅应用层防御 | v2.1 |
| Marketplace 无签名验证 | 不可信包风险 | v2.0 |

## 已知限制

- Conduwuit 仅 Linux 原生二进制，macOS / Windows 需 Docker 桥接。
- `matrix-js-sdk` 锁定 v31，升级 v32+ 需要先把主进程迁到 ESM（v2 任务）。
- Marketplace 当前只支持 zip 包 + checksum 校验，未做签名验证（v2）。
- **Tailwind 任意值 class（如 `max-w-[70%]`）不生成 CSS**——宽度约束需用 inline style（`style={{ maxWidth: '70%' }}`）。待排查 Tailwind/PostCSS 配置。

## 许可

待定。