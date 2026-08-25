# 发布流程（面向 2.x）

本文档面向维护者：说明如何打包、校验、发布一个新版本。

## 前置

```bash
nvm use 20
npx pnpm@9.0.0 install
```

确保 `git status` 干净，所有改动已 commit。

## 打包步骤

### 1. 类型检查 + 单测 + 构建（三道闸）

按顺序执行，任何一步失败立即停止：

```bash
npx pnpm@9.0.0 typecheck
npx pnpm@9.0.0 test
npx pnpm@9.0.0 build   # 已固化 NODE_OPTIONS=--max-old-space-size=4096（防 Vite Monaco OOM）
```

预期结果：
- `typecheck`：两 workspace 零 error。
- `test`：所有 spec 通过，记录最终用例数。
- `build`：renderer 先完成，electron 后完成，退出码 0。

### 2. 原生模块重建（仅在 Node 版本变更时）

```bash
npx pnpm@9.0.0 rebuild better-sqlite3
```

如果遇到 `NODE_MODULE_VERSION mismatch`，执行：

```bash
cd electron && npx electron-rebuild -f -w better-sqlite3
```

### 3. 产出安装包

```bash
npx pnpm@9.0.0 --filter ./electron dist
```

产物输出到 `electron/dist-installers/`：
- macOS arm64：`Momo Studio-2.0.0-arm64.dmg`
- macOS x64：`Momo Studio-2.0.0.dmg`
- Linux x64：`Momo Studio-2.0.0.AppImage`、`Momo Studio-2.0.0.deb`
- Windows：CI 产出 nsis exe（`build-windows` job）。

### 4. 校验产物

```bash
# macOS
hdiutil verify "electron/dist-installers/Momo Studio-2.0.0-arm64.dmg"

# Linux
sha256sum "electron/dist-installers/Momo Studio-2.0.0.AppImage"
```

把 SHA256 写入 GitHub Release 的 description。

## 发布 Checklist

逐项确认，全部打勾才能打 tag：

- [ ] 分支已 rebase / merge 到 `main`，无未提交改动。
- [ ] `typecheck` 双 workspace 零 error。
- [ ] `test` 全部通过，记录用例总数到 release notes。
- [ ] `build` 退出码 0，dist 目录存在 `.dmg` 或 `.AppImage`。
- [ ] 仓库内 `any` / `@ts-ignore` grep 为空（`rg -n '(\\bany\\b|@ts-ignore)' electron/src renderer/src || true`）。
- [ ] `CHANGELOG.md`（如存在）新增版本小节。
- [ ] 版本号已更新到 `package.json` 的 `version` 字段（详见下节）。
- [ ] git tag 注明日期：`git tag -a v1.0.0 -m "v1.0.0 — 2026-07-28"`。
- [ ] GitHub Release 页面填写：CHANGELOG 摘要 + SHA256 + 产物链接。
- [ ] `docs/specs/` 设计文档与已发布版本对应（设计如有变更需同步更新）。

## 版本号规则

本项目遵循 [Semantic Versioning](https://semver.org/)：

- **MAJOR（v2.0.0）**：不兼容的架构变更。例如主进程从 CommonJS 迁到 ESM、协议重大重构。
- **MINOR（v1.1.0）**：向后兼容的新功能。例如新增 provider、新增 marketplace 源类型、新增 agent 能力。
- **PATCH（v1.0.1）**：向后兼容的 bug 修复、文档更新、依赖升级（不引入 breaking）。

### 版本号修改位置

2.0.0 起版本号在**三处**维护（P5 约定，发版时同步改）：

- 仓库根 `package.json`
- `electron/package.json`
- `renderer/package.json`

`electron-builder` 在 dist 时读取 electron 包的版本写入产物 metadata。

### 何时升 MAJOR

出现以下任一情况，必须升 MAJOR：

1. 主进程模块系统变更（CJS → ESM，或反向）。
2. IPC 协议破坏性变更（renderer 旧版本与新版本无法通信）。
3. SQLite schema 不向后兼容（migration 无法自动修复旧库）。
4. SQLite migration 不兼容（含升级路径行为变更，如 P5 的 D5 全新开始策略调整）。

### Pre-release 标签（v1.1 之后启用）

- `v1.1.0-rc.1`：RC 版，内部测试。
- `v1.1.0-beta.1`：公开 beta，文档可标注"实验性"。
- `v1.1.0-alpha.1`：仅核心维护者使用。

## 回滚策略

如果发布后 24 小时内发现 critical bug：

1. 在 `main` 分支 revert 发布 commit（`git revert <tag-commit>`）。
2. 打 patch 版本（如 `v1.0.1`），重新走打包流程。
3. 在 GitHub Release 页面注明该版本被替换。
4. Marketplace 包不受影响（市场是声明式，依赖主程序版本号，不需回滚市场）。

## 常见打包问题

| 症状 | 原因 | 解决 |
|---|---|---|
| `ERR_DLOPEN_FAILED` on `better-sqlite3` | Node 版本错 | `nvm use 20 && pnpm rebuild better-sqlite3` |
| `NODE_MODULE_VERSION 115 vs 123` | Electron 与 Node ABI 不匹配 | `cd electron && npx electron-rebuild -f -w better-sqlite3` |
| macOS `codesign` 失败 | 未配置签名证书 | 见 `docs/dev/codesign.md`（v1.1 补充） |
| Linux AppImage 启动报 `chrome-sandbox SUID` | 容器无 SUID 权限 | 加 `--no-sandbox` 参数；正常桌面环境无此问题 |
| Conduwuit 启动失败 | `allow_registration` 没同时设 `yes_i_am_very_very_sure_...` | 见 `docs/dev/conduit-manual.md` 排错章节 |

## 联系方式

发布相关问题在 GitHub Issue 标注 `release` 标签。