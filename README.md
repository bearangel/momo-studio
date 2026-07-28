# Momo Studio

个人桌面端多 agent 协作平台：把可声明的 agent、可扩展的 MCP/Skill 市场、IM 通道和受控的文件沙箱，全部装进一个本地 Electron 应用。

完整设计见 `docs/specs/2026-07-28-agent-platform-design.md`。

## 状态

**v1.0.0 — Released**

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

## 已知限制

- Conduwuit 仅 Linux 原生二进制，macOS / Windows 需 Docker 桥接。
- `matrix-js-sdk` 锁定 v31，升级 v32+ 需要先把主进程迁到 ESM（v2 任务）。
- Marketplace 当前只支持 zip 包 + checksum 校验，未做签名验证（v2）。

## 许可

待定。