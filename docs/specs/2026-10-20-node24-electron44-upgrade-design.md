# Node 24 LTS + Electron 44 升级设计

- **日期**：2026-10-20
- **状态**：已批准（会话裁定：方案 C 一步到位——工具链 + Electron 大版本 + 真机全量验收一次收口）
- **背景**：Node 20（Iron）已于 2026-03-24 EOL，Electron 30.5.1 早已超出支持窗口（2024-10）；codegraph 插件整合调研（见会话 ses_ec14d132ffferQY3azfHoJimuF 结尾）确认 Electron 内嵌 Node ≥22.5 才能解锁引擎 Library API 的 in-process 路线。本升级消灭 EOL 债并解锁该路线（in-process 整合本身是插件工作流的独立任务，不在本设计范围）。

## 1. 目标与范围

**目标**：开发/测试工具链与 App 运行时统一切到 Node 24 生态。

| 面 | 现状 | 目标 |
|---|---|---|
| 工具链 | Node 20（EOL）／macOS 主机 nvm 默认已是 v24.14.1 | Node 24（Active LTS，24.22.0；EOL 2028-04） |
| App 运行时 | Electron 30.5.1（内嵌 Node 20.18 / Chromium 124 / V8 11.x，ABI 123） | Electron 44.9.x（内嵌 Node 24.22 / Chromium 152 / V8 15.2，**ABI 149**） |
| better-sqlite3 | 11.10.0（11.x 停更，无 Node 24 支持） | 12.11.1（官方支持 Node 20–26.x） |

**明确不做**（边界）：
- codegraph 引擎 in-process 整合（本升级仅解锁该路线）
- vitest 大版本升级（仅当 1.6.1 在 Node 24 下实测跑不动才应急升，单独 commit）
- keytar → safeStorage 迁移（保持 keytar，源码编译机制不变）

## 2. 依赖与构建矩阵

| 依赖 | 变更 | 依据 |
|---|---|---|
| electron | ^30.0.0 → ^44.9.0 | 唯一内嵌 Node 24 且支持窗口最长的稳定大版本（EOL 2027-03-02）；备选 43（同为 Node 24 但跑道更短）被否决 |
| better-sqlite3 | ^11.0.0 → ^12.11.1（**钉 12，不上 13**） | v12 engines `20.x‖22.x‖23.x‖24.x‖25.x‖26.x`；Node 24（ABI 137）prebuild 实证齐备（release 资产含 node-v137）；**v13.0.x 零 prebuild**（release 资产仅 2 个源码包，13.0.3 唯一变更是修 CI）排除 |
| @types/node | ^20.0.0 → ^24.0.0 | 对齐内嵌 Node 24.22.0 |
| keytar 7.9.0 / electron-builder 26.15.3 / pnpm 9.0.0 | 不动 | keytar 懒加载 + 测试 mock，仅打包侧源码编译；eb 26.x 在 pack 步实测验证 |

**ABI 双轨**：
- 单测（工具链 Node 24，ABI 137）：bsq v12 prebuild 免编译直装
- 打包运行（Electron 44，ABI 149）：`electron-rebuild -f -w better-sqlite3 -w keytar` 源码编译——CI（build.yml 三平台）已有此步骤；主机 rebuild 后按 AMFI 教训自查 `better_sqlite3.node` 签名态（必要时 `codesign --force --sign -` 重签）

**Electron 42+ 行为登记**：npm 包不再经 postinstall 下载二进制，首次运行 `npx electron` / electron-builder 时自动下载；`ELECTRON_SKIP_BINARY_DOWNLOAD` 失效。CI 与容器无需改动。

**平台门槛**：macOS ≥ 13（Electron 44 去 12 支持；开发真机 26.5.2 满足）；Windows ia32 / Linux armv7l 不再发布（本项目本就只发 x64/arm64）。

## 3. 破坏面比对结论（Electron 31–44 官方清单 × momo 实际使用面）

### 3.1 必修（1 处）

**`console-message` 事件签名迁移**（Electron 33 起，官方 breaking-changes「API Changed: `level`, `message`, `line`, and `sourceId` arguments in `console-message`」）：

- 旧：`wc.on('console-message', (event, level: number, message, line, sourceId) => …)`
- 新：`wc.on('console-message', ({ level: string, message, lineNumber, sourceId, frame }) => …)`，`level` 取值 `'debug' | 'info' | 'warning' | 'error'`

momo 触点：`electron/src/main/browser/manager.ts:983`（按位置参数读 `args[1]` 数字 level / `args[2]` message）与 `:62`（`CONSOLE_LEVELS = ['verbose','info','warning','error']` 数字→文本映射表）。迁移为 Event 对象解构，映射表退役。**附回归锁**（仿真真实运行时语义：Event 对象形态、level 字符串）。

### 3.2 登记不修（行为变化，均无害）

| 变化 | 影响 | 处置 |
|---|---|---|
| dialog 无 `defaultPath` 时初始目录改为 Downloads，不再记忆上次目录（E43） | `dialog.handlers.ts` 的 defaultPath 为可选透传 | 接受，CHANGELOG 记录 |
| `window.open` 弹窗恒可缩放（E39） | momo 经 `setWindowOpenHandler` 收编新 tab | 无感 |
| macOS 通知需代码签名（E42 UNNotification） | momo 未用 Electron Notification API | 无关 |
| nativeImage/PNG 色彩空间标准化（E43） | screenshot 走 `capturePage().toPNG()`，无 API 变化 | 无感 |
| PDF 不再单独 WebContents（E41）、cookie change cause 更新（E41）、net.request Sec-Fetch 校验（E44） | 未用相应路径（net.request 零直调；undici 独立链路） | 无关 |
| Wayland 默认（E38） | 容器 xvfb 为 X11 会话，不受影响 | 登记 |

### 3.3 已排查不适用（高危面全绿）

- **clipboard 模块大重构（E44 移除 renderer 侧 + Promise 化）**：momo renderer 用 `navigator.clipboard`（W3C），主进程零使用
- `ipcRenderer.sendTo`（E35 移除）、`systemPreferences`（E32/34 移除）、BrowserView（E30 起废弃）、`<webview>` 标签、utilityProcess、`session.clearStorageData.quotas`（E42 移除，momo 调用无此参数）、login-item `openAsHidden`（E44 移除）、trafficLightPosition、OSR、32 位平台——**全部未使用或已在现代 API 上**

## 4. 验证阶梯（真机全量，每级全绿才进下一级）

1. `npx pnpm@9.0.0 typecheck`（mono 双 workspace）
2. `npx pnpm@9.0.0 lint`
3. electron 全量单测（vitest run；DB 重目录 `--pool=forks`；基线 146 passed）
4. renderer 全量单测（基线 2379 passed）
5. `npx pnpm@9.0.0 build`（NODE_OPTIONS=--max-old-space-size=4096）
6. `pnpm --filter electron pack`（electron-builder --dir：实测 eb × E44 × rebuild 链）
7. `npx pnpm@9.0.0 e2e`（Playwright `_electron.launch` 真实启动构建产物）
8. 真机 App 验收（momo-acceptance：隔离 profile + CDP）：启动、双类型会话、agent spawn、浏览器工具（WebContentsView 栈 = console-message 修复实证面）、codegraph 插件面板、keychain 读写
9. 陷阱自查：孤儿 vitest worker 清理；`better_sqlite3.node` AMFI 签名态
10. 稳定验收报告落 `.omo/qa-reports/`

任一级失败：修复 → 该级重跑（不跳级）。vitest 1.6.1 × Node 24 不兼容在第 3/4 级实证暴露，应急路径 = 升 vitest（单独 commit + 全量重跑）。

## 5. 风险登记表

| 风险 | 概率 | 缓解 |
|---|---|---|
| vitest 1.6.1 × Node 24 兼容性 | 中低 | 阶梯第 3/4 级实证；应急升 vitest（单独 commit） |
| Electron 44 下 WebContentsView 叠放 / bounds 行为漂移 | 低 | 验收第 8 步浏览器侧栏专项 |
| bsq 源码编译失败（Electron ABI 149） | 低 | CLT 在位；失败查 python3 / xcode-select；AMFI 重签预案 |
| e2e 启动时序漂移 | 低 | 超时阈值实测校准 |
| Node 24 主进程 API drift | 极低 | @types/node 24 typecheck 兜底 |

## 6. 声明面与文档同步清单

- `electron/package.json`：electron / @types/node / better-sqlite3 三依赖 + alpha.21
- `renderer/package.json`：alpha.21
- 根 `package.json`：`engines.node >=24.0.0` + alpha.21
- `.github/workflows/build.yml`：三平台 `node-version: '20'` → `'24'`
- 新增根 `.nvmrc` = `24`
- `README.md`：`nvm use 20` → `24`；「Node 20 LTS 必需」说明更新
- `AGENTS.md`：Node 纪律改 24（保留 ABI 横跳 / AMFI / 孤儿 worker 教训，例证号 115/123 → 137/149）；容器纪律 `nvm use 24`
- `CHANGELOG.md`：2.1.0-alpha.21 条目（升级内容 + 行为变化登记）

## 7. commit 划分

1. `docs:` spec 落盘
2. `chore:` 依赖与工具链声明面（package.json×3 / .nvmrc / build.yml / README / AGENTS.md / CHANGELOG）
3. `fix:` console-message 签名迁移 + 回归锁
4. 验收产出（qa-reports 不入库；CHANGELOG 如有补充随 3）
