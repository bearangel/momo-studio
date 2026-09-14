# Momo Studio

**个人桌面端多 agent 协作平台**——把可声明的 agent、MCP/Skill 资源库、内嵌浏览器、多会话协作与受控文件沙箱，全部装进一个本地 Electron 应用。

`2.1.0-alpha（研发中）` · 上一稳定版 `v2.0.0` · macOS / Linux / Windows（实验性） · Apache-2.0

## 为什么用 Momo Studio

- **本地优先**：单进程 Electron，零外部服务依赖——不需要服务器、不需要账号，数据全在本机（SQLite + 工作区目录）
- **隐私边界清晰**：API key 入 keychain；agent 的每一次文件写入、每一条 bash 命令都有账本与审计，可逐条撤销
- **多 agent 真协作**：团队（leader + 成员）、dispatch 派发、断点续接、异步句柄与收割——不只是多个聊天窗
- **能力可扩展**：MCP server、Skill 渐进披露、资源库多来源（预置 / 上传 / 网络 / P2P 共享），15 家模型供应商预设开箱即用

## 核心特性

**Agent 运行时**
- YAML 声明式 agent 定义（frontmatter + prompt body），加入工作空间即成员
- 多 agent 协作：团队 leader 经 `dispatch` 派发子任务，`task_reply` 回传；续接（followup）、后台派发（bg）、收割（gather）、取消等编排原语
- 流式回复（thinking 折叠 + 工具调用卡 + Markdown 逐字）；思维模式两级配置（模型级 + agent 级）
- 三层记忆（会话 / 工作空间 / 全局）：BM25 中文检索、自动提取、滚动压缩、导入导出
- 任务断点续跑：重启后从 `message_events` 重建中断回合，恢复卡一键接续

**会话**
- 双类型会话：快速会话（一键直达默认 agent）与协作会话（单 agent 或团队）
- @ 成员直答、leader 接待、成员离线自动拉起；工具调用上限可配（全局 / 会话 / 任务）

**浏览器与网络**
- 12 个浏览器工具（navigate / snapshot / click / type / screenshot…）+ 内嵌浏览器侧栏，puppeteer 零依赖
- 单页共享仲裁：agent 与用户操作同一页面，接管三入口；per-workspace partition 登录态隔离
- webfetch 独立链路；bash 出站网络双态策略（允许 / 拒绝）

**安全与可撤销**
- OS 级沙箱：macOS Seatbelt / Linux bubblewrap / Windows PowerShell plain，strict 默认
- WorkspaceFS 路径防御（拒 `..` 与符号链接逃逸）；Read-before-Edit 守门；结构化 apply_patch 原子执行
- 变更账本：五类写工具落盘前记账，hash 守卫逆序撤销；bash 账外变更事后核对
- GitPolicy 三层校验（总开关 / 分支保护 / message pattern）；多仓 git 工具（发现列表是唯一 `-C` 入口）
- 全量工具调用审计 + 配额滚动删除

**连接性**
- MCP stdio transport，共享进程池，热重载
- 资源库：agent / MCP / skill 三类 × 多来源（预置 / 上传 / 网络 / P2P）
- 局域网 P2P：Ed25519 身份 + mDNS 发现 + TCP 直连；任务只读镜像 + 资源分享一键导入

## 安装

### 从源码运行

```bash
git clone <repo>
cd momo-studio
nvm use 20          # Node 20 LTS 必需（Node 26 会破坏 better-sqlite3 原生编译）
npx pnpm@9.0.0 install
npx pnpm@9.0.0 dev
```

### Windows 安装（实验性）

NSIS 安装器（per-user，免管理员）。未签名首启会触发 SmartScreen——「更多信息」→「仍要运行」。PowerShell `ExecutionPolicy=Restricted` 时首启有授权指引卡。长路径工作区需 `git config --global core.longpaths true`。详见 CHANGELOG「Windows 全平台化」节。

## 开发

```bash
npx pnpm@9.0.0 dev        # vite HMR + electron
npx pnpm@9.0.0 typecheck  # 双 workspace 严格类型检查
npx pnpm@9.0.0 test       # electron + renderer 全部单元测试
npx pnpm@9.0.0 e2e        # Playwright 端到端（需先构建）
npx pnpm@9.0.0 build      # 打包（容器内加 NODE_OPTIONS=--max-old-space-size=4096）
```

单元测试位置约定：electron 主进程集中 `electron/tests/`（镜像 src 结构）；renderer 贴源 colocated（`Foo.test.tsx` 与组件同目录）；根 `tests/` 仅 Playwright e2e。

## 项目结构

```
electron/   Electron 主进程（CommonJS）
renderer/   React UI（ESM, Vite）
resources/  静态资源（marketplace catalog 等）
tests/      Playwright e2e
docs/       specs（设计）/ plans（实施计划）/ dev（开发指南）
```

## 文档

| 文档 | 内容 |
|---|---|
| `CHANGELOG.md` | 版本变更 + 研发账本（版本号策略见 `docs/dev/release.md`） |
| `docs/specs/2026-08-23-v2.0.0-platform-refactor-design.md` | 现行架构设计（所有 2.x 实现依据） |
| `docs/specs/2026-08-31-agent-team-session-redesign.md` | agent / 团队 / 双会话域现行设计 |
| `docs/dev/design-system.md` | UI 设计系统规范（token / 组件 / 图标） |
| `docs/dev/release.md` | 发布流程与版本号策略 |
| `docs/dev/rules/engineering.md` | 工程规则与 P0 案例复盘 |

各特性域设计文档见 `docs/specs/` 目录索引。

## 当前状态与路线图

研发中（`2.1.0-alpha`）——自 v2.0.0 起累积：Windows 全平台化 / 多仓 git / 编排元语 / 浏览器工具 / 断点续跑 / 变更账本与撤销 / OS 沙箱 / 记忆系统 / 供应商预设。逐特性详情与验收待办见 `CHANGELOG.md`。

近期方向：Windows 真机验收收口 · LSP 集成 · 分支工作流（agent 工作独立 branch，PR 式合并）· agent 并发多任务 · e2e 套件重写。

远期：私有 marketplace · headless agent runner · 移动端只读 · NAT 打洞。

## 已知限制

- Marketplace 包未做签名验证（zip + checksum）
- Tailwind 任意值 class 仅静态书写保证生成（动态拼接被规范禁止）
- bash 账外文件变更只有事后核对（未入账区无法区分 shell 与手动）
- 域名策略不复检重定向（初航过名单后 302 目标不二次校验）
- v2.0 升级为完全重新开始（v1.x 旧库自动导出 + 备份，不做数据迁移）

## 贡献与反馈

提 issue 时附会话日志 / 复现步骤。Windows 相关问题标 `windows` 标签。

## 许可

Apache-2.0
