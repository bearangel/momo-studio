# AGENTS.md

本文件为 AI agent 提供本项目的高价值操作指南。仅包含容易踩坑、不看就会出错的仓库特定信息。

## 语言要求

**所有代码注释、文档、说明文件使用中文。** 包括：源码内注释、commit message 以外的文档、README、AGENTS.md、设计文档、实施计划。代码标识符（变量名、函数名、类型名）保持英文。

## 项目概述

Momo Studio — 个人桌面端多 agent 协作平台。Electron + React + Node.js + Matrix(Conduwuit)。

当前进度：M0（项目骨架）已完成并合并到 main。M1-M4 待实施。

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
cd electron && npx pnpm@9.0.0 vitest run tests/conduit/manager.test.ts

# 类型检查（先于测试执行）
npx pnpm@9.0.0 typecheck

# 构建（renderer 先于 electron dist）
npx pnpm@9.0.0 build

# 启动开发模式
npx pnpm@9.0.0 dev
```

## 必须遵守的约束

- **Node 20 LTS**：Node 26 会破坏 better-sqlite3 的 native binding（`ERR_DLOPEN_FAILED`）。容器默认 Node 26，必须先 `nvm use 20`。
- **TypeScript strict**：禁止 `any`、`@ts-ignore`、`as any`。ESLint `no-explicit-any: error` 已启用。
- **Conventional Commits**：`feat:`、`fix:`、`chore:`、`docs:`、`test:`、`refactor:`。
- **禁止提交 `docs/` 的改动用 `git add -A`**：`.gitignore` 含裸 `docs` 条目（历史遗留），会静默忽略文档文件。用 `git add -f docs/your-file.md` 或先 `git add docs/`。

## 架构关键点

### Monorepo 结构

```
electron/   — Electron 主进程（CommonJS, Node.js 运行时）
renderer/   — React UI（ESM, Vite 构建）
resources/  — Conduwuit 二进制 + 下载脚本
tests/      — Playwright e2e 测试
docs/       — 设计文档(specs) + 实施计划(plans) + 开发指南(dev)
```

两个 workspace 包名：`momo-studio-electron`、`momo-studio-renderer`。

### Electron 主进程是 CommonJS

`electron/package.json` 的 `"type": "commonjs"` 是刻意选择——better-sqlite3 / keytar 的 native binding 需要 CJS。**matrix-js-sdk 锁定 `^31.0.0`**：v32+ 是纯 ESM，与 CJS 主进程冲突（`ERR_REQUIRE_ESM`）。升级到 v34+ 需要先做主进程 ESM 转换（v2 任务）。

### IPC 类型共享

`electron/src/preload/index.ts` 通过三层 `../../../` 引用 `renderer/src/ipc/types.d.ts`（注意是 `.d.ts` 不是 `.ts`——避免 tsc 把 renderer 文件输出到 electron/dist）。修改 IPC 接口时两个 workspace 都要 typecheck。

### SQLite 迁移是内联 SQL

`electron/src/main/storage/migrations/index.ts` 把 SQL 定义为 TS 字符串常量，**不是 `.sql` 文件**。原因：tsc 只输出 `.js`，外部 `.sql` 不会进 `dist/`，打包后 `__dirname` 查找会返回空数组导致建表失败。

### Conduwuit 配置特殊要求

- `allow_registration = true` 必须同时设 `yes_i_am_very_very_sure_i_want_an_open_registration_server_prone_to_abuse = true`，否则 Conduwuit 启动即退出。
- 健康检查端点是 `/_matrix/client/versions`，**不是 `/health`**（Conduwuit 没有此端点）。
- Conduwuit 只发布 Linux 二进制。macOS/Windows 需用 Docker 运行 Conduwuit。

## 常见陷阱

| 陷阱 | 症状 | 解决 |
|---|---|---|
| Node 版本不对 | `better-sqlite3 ERR_DLOPEN_FAILED` 或 `NODE_MODULE_VERSION mismatch` | `nvm use 20 && npx pnpm@9.0.0 rebuild better-sqlite3` |
| Electron native binding 不匹配 | 启动 Electron 时 `NODE_MODULE_VERSION 115 vs 123` | `cd electron && npx electron-rebuild -f -w better-sqlite3` |
| 容器内启动 Electron | `chrome-sandbox SUID` 错误 | 加 `--no-sandbox` 参数 |
| Conduwuit 不启动 | `missing field server_name` 或 `registration_token` 错误 | 检查 config.toml 格式（扁平 key 不是嵌套 table） |
| 文档文件无法 `git add` | `git add docs/foo.md` 无输出 | `git add -f docs/foo.md`（`.gitignore` 有裸 `docs` 条目） |

## 开发环境

本项目运行在 OrbStack DevContainer（Linux arm64）中。代码同步映射到 macOS 主机 `/Users/stbearangel/dev/AiProject/moo-studio`。

- 容器内无 GUI 显示——测试 Electron GUI 需 `xvfb-run -a --server-args="-screen 0 1280x800x24"`
- 容器内可用 `nvm use 20`（已安装）；默认 shell 是 Node 26
- macOS 主机上可直接 `cd /Users/stbearangel/dev/AiProject/moo-studio && pnpm dev` 运行 GUI

## 关键文档

- `docs/specs/2026-07-28-agent-platform-design.md` — 完整架构设计（2730 行，14 节），所有实现决策的依据
- `docs/plans/2026-07-28-m0-project-skeleton.md` — M0 实施计划（已执行完成）
- `.superpowers/sdd/progress.md` — M0 执行 ledger（含每 task review 状态 + deferred minors，gitignored）
