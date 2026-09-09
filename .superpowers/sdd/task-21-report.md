# Task 21 报告 — v2.1 UI 设计系统 P0 收官验证

- **执行日期**: 2026-09-02（容器内，Node v20.20.2 全程经 nvm 加载，每个 shell 均验证）
- **基线**: HEAD = `eb02d0e`（docs: v2.1 设计系统规范文档 + AGENTS.md UI 开发红线）
- **结论**: 五项门禁全部 PASS（Step 4 经一次环境修复后通过，修复仅涉及 node_modules 与僵尸进程，零仓库文件改动、零 commit）

---

## Step 1: 类型检查（双 workspace）— PASS

```bash
export NVM_DIR="$HOME/.nvm" && . "$NVM_DIR/nvm.sh" && nvm use 20 && node --version && npx pnpm@9.0.0 typecheck
```

关键输出（逐字）：

```
Now using node v20.20.2 (npm v10.8.2)
v20.20.2
electron typecheck$ tsc --noEmit
renderer typecheck$ tsc --noEmit
electron typecheck: Done
renderer typecheck: Done
TYPECHECK_EXIT=0
```

## Step 2: 全量测试 — PASS

```bash
npx pnpm@9.0.0 test
```

关键输出（逐字）：

```
renderer test:  Test Files  90 passed (90)
renderer test:       Tests  774 passed (774)
renderer test:    Duration  38.34s
renderer test: Done
electron test:  Test Files  160 passed (160)
electron test:       Tests  1308 passed (1308)
electron test:    Duration  39.81s
electron test: Done
TEST_EXIT=0
```

- renderer 774/774（与 Task 20 记录一致）；electron 1308/1308（符合 ~1300+ 预期）
- 全部在 Node v20.20.2 下执行（本次执行者每个 shell 均 `nvm use 20` + `node --version` 验证，规避前序子代理未加载 nvm 的误报）

## Step 3: 构建 — PASS

```bash
npx pnpm@9.0.0 build
```

关键输出（逐字）：

```
> NODE_OPTIONS=--max-old-space-size=4096 pnpm -r build
electron build$ tsc -p tsconfig.json
renderer build$ tsc && vite build
electron build: Done
renderer build: transforming...
renderer build: ✓ 3469 modules transformed.
renderer build: dist/assets/inter-latin-wght-normal-Dx4kXJAl.woff2        48.26 kB
renderer build: dist/assets/index-B2d0kQOy.css                             193.79 kB │ gzip:    31.66 kB
renderer build: ✓ built in 39.10s
renderer build: Done
BUILD_EXIT=0
```

- OOM 防护（NODE_OPTIONS=4096）已固化在根 build 脚本中，无需手工注入
- Inter 字体 woff2 分包出现在产物中（设计系统 Task 2 的字体落地证据）；CSS 产物 193.79 kB

## Step 4: xvfb 冒烟 — PASS（经一次环境修复）

```bash
ELECTRON_DISABLE_SANDBOX=1 timeout 120 xvfb-run -a --server-args="-screen 0 1280x800x24" npx pnpm@9.0.0 dev
```

### 第一次运行：失败（环境问题，非代码回归）

逐字关键错误（完整日志 `/tmp/opencode/task21-smoke.log`）：

```
08:44:01.832 (main) › 旧库检测失败（文件不可读或损坏），按非旧库处理 {
  error: "...better_sqlite3.node'\n" +
    'was compiled against a different Node.js version using\n' +
    'NODE_MODULE_VERSION 115. This version of Node.js requires\n' +
    'NODE_MODULE_VERSION 123. ...'
}
08:44:01.834 (main) › Fatal startup error { error: "Module did not self-register..." }
[electron] 退出 (code 0)
```

根因（两项，均为 AGENTS.md 陷阱表已记载的环境态）：
1. better-sqlite3 当前为 Node 20 ABI（115）——Step 2 测试刚以 Node 20 消费过；Electron 30 需要 ABI 123。对应陷阱表「Electron native binding 不匹配 → `cd electron && npx electron-rebuild -f -w better-sqlite3`」
2. 8月31日遗留的僵尸 dev 进程（vite/tsc watch/Xvfb :99）占用 5173/5174 端口

**未走 brief 的 `--no-sandbox` fallback**：首次运行 Electron 已正常启动（无 chrome-sandbox SUID 报错），`ELECTRON_DISABLE_SANDBOX=1` 透传有效，dev.mjs 零改动。

### 修复动作（零仓库改动）

```bash
# 1. 清理僵尸进程（按 PID 精确 kill，避开 chrome-devtools-mcp watchdog）
kill <Aug31 遗留 vite/tsc/Xvfb PIDs>  →  "ALL STALE PROCESSES CLEANED"

# 2. 按 AGENTS.md 陷阱表重建原生模块（仅 node_modules，gitignored）
cd electron && npx electron-rebuild -f -w better-sqlite3 -w keytar
✔ Rebuild Complete  (REBUILD_EXIT=0)
```

### 第二次运行：通过

关键输出（逐字，完整日志 `/tmp/opencode/task21-smoke2.log`）：

```
  VITE v5.4.21  ready in 139 ms
  ➜  Local:   http://localhost:5173/
[dev] vite 就绪 (http://localhost:5173) + electron dist 就绪 → 启动 Electron
[electron] 已启动 (pid 2996049)
8:46:21 AM - Found 0 errors. Watching for file changes.
08:46:22.568 (main) › App starting { version: '2.0.0' }
08:46:22.588 (main) › SQLite opened { path: '/home/ai-agent/.momo-studio/state.db' }
08:46:22.589 (main) › Applying migration { version: 25 }
08:46:22.595 (main) › Migrations complete
08:46:22.596 (main) › Registering IPC handlers
...（System/Workspace/File/Agent/Team/Session/MCP/Allocation/Git Policy/Audit/Provider/Resource/Task/Dialog/Window IPC 全部「已注册」）
08:46:22.697 (main) › RouterService 已启动
08:46:22.699 (main) › Task-driven runtime initialized
08:46:26.393 (main) › Window ready
SMOKE_EXIT=124
```

- **exit 124**：进程存活至 timeout 杀死（SIGTERM 传导至 vite 子进程为预期 teardown 噪音）
- **全启动链闭合**：vite ready → electron 启动 → 建库迁移（v25/v26）→ IPC 全注册 → RouterService → **Window ready**（渲染页面加载完成）
- **主题链零报错**：`grep -iE "csp|content-security|theme-boot|globals\.css|Refused to|Uncaught"` → 无匹配
- dbus `bus.cc` / GPU `viz_main_impl.cc` 报错为无 dbus、无真实 GPU 的无头容器标准噪音，与本计划无关
- 超时后无残留进程（`ps` 复查 clean）

## Step 5: 工作树检查 — PASS

```bash
git status
```

- HEAD = `eb02d0e`（与任务上下文一致）
- 脏文件**仅限** `.superpowers/sdd/` 下 10 个文件（progress.md + task-1/2/3/4/5/7/11/13/14-report.md）——controller 已知会裁定的人工遗留，本任务忽略
- 其余零脏、零未跟踪文件；最近 3 个 commit 扫描无 probe/临时文件混入
- Step 4 fallback 未触发 → dev.mjs 未改动 → **本任务无 commit**（符合 brief 预期）

---

## 门禁总表

| # | 门禁 | 结果 | 关键证据 |
|---|---|---|---|
| 1 | typecheck（双 workspace） | ✅ PASS | exit 0；electron/renderer 双 Done |
| 2 | 全量测试 | ✅ PASS | renderer 774/774（90 文件）+ electron 1308/1308（160 文件），exit 0 |
| 3 | 构建 | ✅ PASS | exit 0；tsc + Vite 3469 模块 39.10s；Inter woff2 入产物 |
| 4 | xvfb 冒烟 | ✅ PASS（经环境修复） | exit 124；vite ready 5173 + 全启动链至 Window ready；CSP/theme-boot/globals.css 零命中 |
| 5 | 工作树 | ✅ PASS | 仅 .superpowers/sdd/ 遗留（已知）；无 probe 残留；无 commit |

## 关注项（concerns）

1. **node_modules ABI 现为 Electron 侧（123）**：electron-rebuild 后，若需再次跑 Node 侧 vitest，须先 `nvm use 20 && npx pnpm@9.0.0 rebuild better-sqlite3`（AGENTS.md 陷阱表另一方向）。本报告 Step 2 的全绿结果产于 rebuild **之前**，时序无污染。这是本仓库单份原生模块无法同时满足双 ABI 的固有约束，非本计划引入。
2. **环境修复未入库**：僵尸进程清理 + electron-rebuild 均为运行环境操作，仓库零改动；后续验证者如遇同样 115 vs 123 报错，照 AGENTS.md 陷阱表处置即可。
3. **人工补充项（macOS 主机）**：brief 明确的「设置 → 外观三态切换 + 全 app 即时换肤 + 重启记忆」仍需主机验收，容器 xvfb 只能验证启动链。
4. lint 门禁（446 warnings / 0 errors）为 Task 19/20 已记录的既有状态，非本任务五步范围，未复跑。
