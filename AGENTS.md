# AGENTS.md

本文件为 AI agent 提供本项目的高价值操作指南。仅包含容易踩坑、不看就会出错的仓库特定信息。

## 语言要求

**所有代码注释、文档、说明文件使用中文。** 包括：源码内注释、commit message 以外的文档、README、AGENTS.md、设计文档、实施计划。代码标识符（变量名、函数名、类型名）保持英文。

## 项目概述

Momo Studio — 个人桌面端多 agent 协作平台。Electron + React + Node.js，单进程架构，本地零外部依赖。

v2.0.0 已发布（commit ac51236 起合并）。五期重构收官：

- P1 传输层内迁：移除 Matrix/Tuwunel 全家，`sessions` / `session_members` 表取代 Matrix room
- P2 UI 骨架与设置：自绘 TitleBar + 活动栏 + 统一侧边栏 + 设置独立界面
- P3 半成品处置 + IPC 收敛：provider platform 运行时接线、#T 任务 id 端到端、资源注册统一 `resource:*`
- P4 局域网 P2P：任务只读镜像 + agent/MCP 资源分享 + 一键导入
- P5 升级体验：旧库只读导出 Markdown/JSON，备份重命名 `.legacy-v1.bak`，首启一次性提示

## 架构关键点

v2.0.0 设计取舍一句话：「单进程 Electron + 内置 SessionService + 进程内事件分发」。细节以 `docs/specs/2026-08-23-v2.0.0-platform-refactor-design.md` 为准，列出五点供快速对齐：

- **sessions 内核**：`sessions` / `session_members` / `message_events` 表是单一真相源；`message_events.seq` 自增主键 = 时间线性显示的天然全序
- **task-driven runtime**：AgentRunner + WarmPool（K=2 预热）+ MessageEventBuffer（50ms/30 条批落盘）；废弃 v1 双轨 runtime-manager
- **v25 agent 域（去编排）**：`workspace_agent_members` 成员制（无 role/parent，同 ws 同 def 唯一）取代 `agent_assignments`；agent 定义全局化（`workspace_id` 列已 DROP）；多 agent 协作走「团队」（`teams`/`team_members`，leader+成员），dispatch 注入按会话快照判定（成员>1 且 is_leader，`buildDispatchSnapshot` 在 spawn 时定型）；会话双类型（快速/协作），`workspaces.default_agent_instance_id` 支撑快速会话；依据 `docs/specs/2026-08-31-agent-team-session-redesign.md`
- **dispatch + stream 事件链**：RouterService 切输入源（Matrix event → SessionService 进程内事件）；dispatch / task_reply 走内部事件桥，子 agent 结果可靠回传
- **LAN p2p**：Ed25519 身份 + mDNS 发现 + TCP 直连；payload 多类型分发（message / task-snapshot / resource-catalog / resource-request / resource-provide）；远端任务**只读镜像**（spec D7 铁律：入站快照只进内存缓存，绝不写 `tasks` 表）
- **marketplace + skill**：资源库三类 source（builtin / marketplace / custom）+ v2 加 `source='p2p'`；内置 agent YAML 落 `electron/resources/agents/*.yaml`（coder / pm-agent / requirement-analyst）；marketplace 目录 `resources/marketplace/catalog.json`

## 关键命令

```bash
# 安装（容器内 pnpm 未全局安装）
nvm use 20
npx pnpm@9.0.0 install

# 测试（两个 workspace 同时跑）
npx pnpm@9.0.0 test

# 单独跑一个 workspace
npx pnpm@9.0.0 --filter momo-studio-electron test
npx pnpm@9.0.0 --filter momo-studio-renderer test

# 跑单个测试文件
cd electron && npx pnpm@9.0.0 vitest run tests/agent/stream-relay.test.ts
cd renderer && npx pnpm@9.0.0 vitest run src/lib/stream-aggregator.test.ts

# 端到端（Playwright，需要先构建）
npx pnpm@9.0.0 e2e

# 类型检查（先于测试执行）
npx pnpm@9.0.0 typecheck

# 启动开发模式（vite HMR + electron；页面来自 dev server，无 stale renderer 问题）
npx pnpm@9.0.0 dev

# 构建（已固化 NODE_OPTIONS=4096 防 Vite Monaco OOM；Windows 本地构建不支持——打包走 CI）
npx pnpm@9.0.0 build
```

## 单元测试文件存放规范

| 位置 | 规则 | 强制机制 |
|---|---|---|
| 根 `tests/` | **仅 Playwright e2e**（`tests/e2e/*.spec.ts`），不放单元测试 | Playwright testDir |
| `electron/tests/` | 主进程单测**集中存放**，子目录镜像 `src/` 结构（`tests/agent/`、`tests/storage/`…） | `electron/vitest.config.ts` 显式 `include: ['tests/**/*.test.ts']`——放别处不执行 |
| `renderer/src/**` | renderer 单测**贴源 colocated**：`Foo.test.tsx` 与 `Foo.tsx` 同目录；**不要**建 `renderer/tests/` 或 `__tests__/` 子目录 | `renderer/vitest.config.ts` 显式 `include: ['src/**/*.test.{ts,tsx}']`——放别处不执行 |

裁定依据（2026-08-25 业界调研）：vitest/jest 官方对位置无意见，著名项目两模式并存（Vue/React 库场景用 `__tests__/`；VS Code/Joplin 应用场景贴源；Electron/Hyper/GitHub Desktop 集中）。本项目原则=各 workspace 向自身既有多数派收敛 + 显式 include 机械强制，杜绝同一文件两份副本分叉漂移（曾发生于 renderer/tests 与 src 同名测试）。

## 必须遵守的约束

- **Node 20 LTS**：Node 26 会破坏 better-sqlite3 的 native binding（`ERR_DLOPEN_FAILED`）。容器默认 Node 26，必须先 `nvm use 20`。
- **TypeScript strict**：禁止 `any`、`@ts-ignore`、`as any`。ESLint `no-explicit-any: error` 已启用。
- **Conventional Commits**：`feat:`、`fix:`、`chore:`、`docs:`、`test:`、`refactor:`。
- **UI 设计系统（v2.1）**：renderer 新代码只用语义 token（`bg-surface-*` / `text-secondary` 等），禁标准 Tailwind 色阶类、禁 inline 硬编码颜色、禁 emoji 图标（用 lucide-react，16px / stroke 1.75）；原子组件优先（`components/ui/`）；状态色一律 `lib/task-status.ts`。ESLint 已机械强制（P4 起全局 error + Tailwind 默认色阶移除）。规范全文：`docs/dev/design-system.md`

## 架构关键点（基础设施细节）

### Monorepo 结构

```
electron/   — Electron 主进程（CommonJS, Node.js 运行时）
renderer/   — React UI（ESM, Vite 构建）
resources/  — marketplace catalog（electron-builder extraResources）
tests/      — Playwright e2e 测试
docs/       — 设计文档(specs) + 实施计划(plans) + 开发指南(dev)
```

两个 workspace 包名：`momo-studio-electron`、`momo-studio-renderer`（**无 `@` scope**）。根包名 `momo-studio`。

### Electron 主进程是 CommonJS

`electron/package.json` 的 `"type": "commonjs"` 是刻意选择——better-sqlite3 / keytar 的 native binding 需要 CJS。matrix-js-sdk v31 锁定已随 v2.0.0 拆除（Matrix 全家移除），主进程可独立进行 ESM 化（如有需要）。

### IPC 类型共享

`electron/src/preload/index.ts` 通过三层 `../../../` 引用 `renderer/src/ipc/types.d.ts`（注意是 `.d.ts` 不是 `.ts`——避免 tsc 把 renderer 文件输出到 electron/dist）。修改 IPC 接口时两个 workspace 都要 typecheck。

### SQLite 迁移是内联 SQL

`electron/src/main/storage/migrations/index.ts` 把 SQL 定义为 TS 字符串常量，**不是 `.sql` 文件**。原因：tsc 只输出 `.js`，外部 `.sql` 不会进 `dist/`，打包后 `__dirname` 查找会返回空数组导致建表失败。

## 常见陷阱

| 陷阱 | 症状 | 解决 |
|---|---|---|
| Node 版本不对 | `better-sqlite3 ERR_DLOPEN_FAILED` 或 `NODE_MODULE_VERSION mismatch` | `nvm use 20 && npx pnpm@9.0.0 rebuild better-sqlite3` |
| Electron native binding 不匹配 | 启动 Electron 时 `NODE_MODULE_VERSION 115 vs 123` | `cd electron && npx electron-rebuild -f -w better-sqlite3` |
| 容器内启动 Electron | `chrome-sandbox SUID` 错误 | 加 `--no-sandbox` 参数 |
| `git add docs/foo.md` 无输出 | `.gitignore` 历史遗留条目 | 先 `git add docs/` 或 `git add -f docs/foo.md`（v2.0.0 后该裸 `docs` 条目已删，正常 `git add` 即可） |

## 研发红线（2.0.0 主机验收 8 个 P0 教训沉淀）

- **修 bug 先复现后修复**；用户报「修复无效」先查构建新鲜度（git log ↔ electron/dist ↔ renderer/dist），再怀疑代码
- **回归锁必须仿真真实运行时语义**（this 绑定 / ID 唯一性）；「方便测试」的 mock 简化 = 生产事故
- **跨模块 ID 单点生成沿线透传**；「等待某事件」的代码必须先验证该事件有生产者；路由目标用当前上下文不用配置默认值
- **错误路径与空输入必须有专项测试用例**；禁止错误处理里硬编码吞状态
- 场景化规则由 skills 自动加载：修 bug → `momo-debug-rules`；写测试/mock → `momo-test-rules`；改 IPC/跨模块/协议 → `momo-boundary-rules`。完整案例复盘：`docs/dev/rules/engineering.md`

## 开发环境

本项目运行在 OrbStack DevContainer（Linux arm64）中。代码同步映射到 macOS 主机 `/Users/stbearangel/dev/AiProject/moo-studio`。

- 容器内无 GUI 显示——测试 Electron GUI 需 `xvfb-run -a --server-args="-screen 0 1280x800x24"`
- 容器内可用 `nvm use 20`（已安装）；默认 shell 是 Node 26
- macOS 主机上可直接 `cd /Users/stbearangel/dev/AiProject/moo-studio && pnpm dev` 运行 GUI

## 关键文档

- `docs/specs/2026-08-31-agent-team-session-redesign.md` — v25 agent/会话域现行设计（去编排 + 团队 + 双会话），agent 域实现以此为准
- `docs/specs/2026-08-23-v2.0.0-platform-refactor-design.md` — v2.0.0 现行架构设计（18 节），所有 2.x 实现的依据
- `docs/specs/2026-07-28-agent-platform-design.md` — v1.x 早期设计（14 节），**已 superseded**；v2.0.0 起仅作历史参考
- `docs/plans/2026-08-23-v2.0.0-p*.md` — 五期实施计划（p1 会话内核 / p2 UI / p3 收尾 / p4 局域网 / p5 升级）
- `docs/2026-08-14-system-feature-inventory.md` — 系统功能全景清单（v2.0 spec 的上游输入底座）
- `.superpowers/sdd/progress.md` — v2.0.0 主线 ledger，gitignored
- `docs/dev/design-system.md` — v2.1 UI 设计系统规范（token / 组件 / 图标 / do-don't），renderer UI 开发唯一入口