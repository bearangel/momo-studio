---
name: momo-acceptance
description: Momo Studio App 级功能验收与测试技能。启动真实 App（CDP 接管 + 隔离 profile），模拟用户操作，产出 .omo/qa-reports/ 稳定报告。Use when 验收、acceptance、测一下某功能、测试 XX 功能、UI 偏离设计、UX 走查、发布前验收、回归验收。
---

# Momo Studio App 级验收测试规则

诉求是「验收 / 测一下某功能 / UI 偏离 / UX 走查 / 发布前验收」时走本技能：真实启动 App、像用户一样操作、证据落袋、稳定出报告。设计与决策依据：`docs/specs/2026-10-09-momo-acceptance-skill-design.md`。

## 适用判定（先分流，再动手）

| 诉求 | 走向 |
|---|---|
| 修 bug / 排查为什么坏 | `momo-debug-rules`（修完可用本技能做回归验收） |
| 写单元测试 / mock | `momo-test-rules` |
| UI 变更前置预览门禁 | `momo-ui-preview-rules` |
| 验收功能 / UI 偏离检查 / UX 走查 / 发布前验收 | **本技能** |

## 执行总览（固定顺序）

前置门禁 → 启动隔离实例 → CDP 接管 → 按模式测试（M1/M2/M3 可组合）→ 复制模板出报告 →（可选）缺陷沉淀 → 收尾。

## 第一步：前置门禁（全部通过才启动）

1. **Node 20 可用性**：`node -v` 非 v20.x 不等于停止——先解析 v20 bin 路径（`nvm which 20`，或已知路径如 `~/.nvm/versions/node/v20.20.2/bin`），后续**所有启动命令统一显式带该 PATH**。原因：tmux server 预先存在时，新窗口继承的是 server 的陈旧环境，`nvm use 20` 不透传（评审实测）；v20 完全不可用才停止并提示安装
2. momo Electron 进程探测（`pgrep -fl`），**三分法**处置：**用户活实例**（user-data-dir 指向真实目录）→ 不杀，启动走「直启共存」变体（第二步）；**本技能残留**（cmdline 含 `qa-reports` / `AP_USER_DATA_DIR=…qa-reports` 特征）→ 上次中断遗留，确认后清理再继续；**来历不明的僵尸** → 与用户确认后清理
3. 依赖可用：启动后若遇 better-sqlite3 `ERR_DLOPEN_FAILED` / `NODE_MODULE_VERSION` 不匹配 → 按 AGENTS.md 陷阱表修复，处置过程记入报告「环境异常记录」
4. dev 模式下构建新鲜度由 `electron/scripts/dev.mjs` 自带判定（dist mtime 晚于编排器启动），本技能不重复检查
5. 容器环境（OrbStack，无 GUI 直显）：启动命令外层包 `xvfb-run -a --server-args="-screen 0 1280x800x24"`（详见 spec §9）

## 第二步：启动（默认隔离实例）

先探测空闲端口（从 9222 起 `lsof -i :<port>` 递增），tmux 后台启动：

```bash
RUN_DIR=<repo>/.omo/qa-reports/<YYYY-MM-DD>-<topic>
V20=<门禁 1 已解析的 v20 bin 路径>
mkdir -p "$RUN_DIR/evidence"
# tmux 幂等：上次中断残留的同名会话先清（否则 duplicate session 报错——评审实测）
tmux has-session -t momo-acceptance 2>/dev/null && tmux kill-session -t momo-acceptance
tmux new-session -d -s momo-acceptance
# 常规（无其他实例在跑）：dev 编排器全链启动——显式 v20 PATH（tmux server 陈旧环境不透传 nvm use）
tmux send-keys -t momo-acceptance "cd <repo> && PATH=\"$V20:\$PATH\" AP_USER_DATA_DIR=$RUN_DIR/profile-appdata npx pnpm@9.0.0 dev -- --remote-debugging-port=<port> --user-data-dir=$RUN_DIR/profile" Enter
# 变体（用户 dev 实例已在跑）：复用其 vite + tsc watch 产物直启第二实例——
# 再起一份 pnpm dev 会双 vite/双 tsc watch 互相干扰（狗粮实测）。
# vite 端口先确认：5173 被占时 vite 自动跳 5174——lsof 探测 / 从用户实例 vite 进程参数读实际端口
tmux send-keys -t momo-acceptance "cd <repo> && PATH=\"$V20:\$PATH\" AP_USER_DATA_DIR=$RUN_DIR/profile-appdata VITE_DEV_SERVER_URL=http://localhost:<vite端口> npx pnpm@9.0.0 --filter ./electron exec electron . --remote-debugging-port=<port> --user-data-dir=$RUN_DIR/profile" Enter
```

- **隔离三作用域铁律（P0，评审修正）**：①`--user-data-dir` 只隔离 Chromium 层；②应用数据根在 `~/.momo-studio`（`electron/src/main/paths.ts`），**必须同时设 `AP_USER_DATA_DIR`**——漏设会直接打开用户真实库（狗粮首跑事故，只读即暴露全部真实数据）；③**OS keychain 不随 profile 隔离**（`keychain.ts` 服务名 `Momo Studio` 常量）：读路径安全（keychain 键由隔离库的 instanceId/providerId 派生，读不到真实 key），但**验收中向表单输入的任何 secret 会写入真实 OS keychain 且收尾不清理**——隔离跑一律用一次性假值，绝不输入真实 API key；报告元信息注明 keychain 残留风险。隔离生效自检：AP 目录长出全新 `state.db` + `p2p-identity.json`，且 UI 无任何既有工作区
- 参数透传依据：dev.mjs 把 `process.argv.slice(2)` 原样转给 electron；若 `--` 分隔符被 pnpm 吞（argv 未到达 electron），去掉 `--` 直传重试
- **build 产物验收（发版前备选）**：先 `npx pnpm@9.0.0 build`，再直接 electron 启动（不带 `VITE_DEV_SERVER_URL`），CDP / 双隔离参数同上；日常默认 dev 模式
- **真实 profile 红线**：默认一律隔离。确需真实数据 / API key → 向用户说明「会写真实库」+ 具体风险 → 明确同意 → 启动去掉 `AP_USER_DATA_DIR` 与 `--user-data-dir` → 报告元信息标「真实（已授权）」。未授权不碰，无例外。**授权运行附加纪律（评审修正）**：①eval 仅限被测功能的只读断言与明示授权的交互，禁探索性 JS；②证据脱敏——禁截取/采样设置与 provider 密钥页（必须经过时强制遮罩），console 证据 URL 落盘前剥 query；③`evidence/` 目录 `chmod 700`，报告交付后提示用户及时清理（`.omo/qa-reports/` 无自动保留期限）

## 第三步：CDP 接管

- **先关 devtools target**：dev 模式自动打开的 DevTools 会阻塞 playwright `connectOverCDP` 初始化（狗粮实测 30s 超时）——`curl http://localhost:<port>/json/list` 找 `devtools://` target，`/json/close/<id>` 关掉再连
- **CDP 生命周期（评审修正）**：连接前 `lsof -nP -iTCP:<port>` 核验端口仅绑 127.0.0.1（Chromium 默认，须确认未被改写为 0.0.0.0）；agent 异常中断会留下开放调试端口——每轮开始（门禁 2 清扫）与结束（收尾复核）各扫一次自家残留
- 工具优先 playwright 库直连（`chromium.connectOverCDP`，仓库 devDependencies 自带）；chrome-devtools 插件连的是自己的 Chrome 实例接不上 Electron；playwright MCP 走 `cdp_url` 可作备选
- **驱动方式（评审修正：用 canonical driver，勿重写）**：防重放播种 / 事件持久化 / URL 脱敏是不易重造的不变量（狗粮 + 评审双事故印证），技能已固化实现，复制即用：
  ```bash
  cp .opencode/skills/momo-acceptance/references/qa-driver.mjs "$RUN_DIR/qa-driver.mjs"
  tmux new-window -t momo-acceptance -n driver
  tmux send-keys -t momo-acceptance:driver "cd <repo> && PATH=\"$V20:\$PATH\" QA_CDP_PORT=<port> QA_RUN_DIR=$RUN_DIR node $RUN_DIR/qa-driver.mjs" Enter
  ```
  命令经 `cmd/*.cmd.json` → `*.result.json` 文件轮询执行（url/title/snapshot/screenshot/click/fill/press/type/eval/waitFor/wait/quit），console error/warning、pageerror、requestfailed 持续落盘 `evidence/console.log`
- 定位纪律：`getByRole({name})` 是**子串匹配**——「关闭」会命中 tab 上 `aria-label="关闭 工作区名"` 的 opacity-0 hover 按钮导致超时；对话框内控件用 `[role=dialog]` 作用域限定或 eval 精确点击
- ready 判定：页面列表出现目标窗口 + 首页 load 完成

## 第四步：按模式测试（可组合，拿不准问用户一次）

### M1 定向功能测试
信息不足一次性问清（测什么 / 预期 / 入口）。从 `docs/specs/` + 实现代码建立**可判定的预期**（spec 与实现矛盾本身记缺陷，分「实现偏离 spec」与「spec 不合理」两口径）。测试点清单 = 正常路径 + 边界（空输入 / 长中文 / 重复点击 / 中断恢复 / **「配置默认值 ≠ 实际上下文」分歧点**——如普通会话 vs 团队会话触发同一功能，P0-8 教训）+ **错误路径专项**（P0 纪律：错误路径必须有专项用例）。清单亮给用户后直接执行（隔离 profile 非破坏性，用户可中途补充），每点判四态。

### M2 设计符合性（三层）
- **spec 对照**：实际行为逐条对照相关 spec 章节
- **缺陷探查**：空态渲染 / 超长与特殊字符 / 重复提交 / 关窗重开状态保真
- **UI 偏离**：对照 `docs/dev/design-system.md`——语义 token（computed style 抽查）、16px / stroke 1.75 图标、状态色走 `lib/task-status.ts`、**明暗双主题各截一组**

### M3 UX 走查
角色设定（新用户从 onboarding 起 / 熟练用户直击任务）→ 拆 3-6 个真实任务像人一样完成 → 记录步骤数 / 入口寻找路径 / 误操作与恢复 → 五维评分（可达性 / 反馈及时性 / 一致性 / 容错 / 效率，判据与评分锚点见报告模板），**每个判断必须给可观察依据**。

## 证据纪律

- 截图 `evidence/NN-<step-slug>.png`（NN 两位全局递增）；关键判定配「元素特写 + 整页」两张
- a11y 快照存 `evidence/NN-<step-slug>.a11y.txt`（可 grep / diff 的文本证据）
- 证据引用必须指向**真实存在的文件**；截图失败显式标「证据缺失」，不静默跳过
- DB 落盘验证：宿主直查 better-sqlite3 会因 Electron ABI（123≠115）失败且**禁止 rebuild**（会破坏运行中实例）——用 `sqlite3 "file:<db>?mode=ro"` 只读查询

## 第五步：报告（稳定输出四铁律）

目录 `.omo/qa-reports/<YYYY-MM-DD>-<topic>/`：`report.md` + `evidence/` + `profile/`。

1. **模板原样复制再填空**：`cp .opencode/skills/momo-acceptance/references/report-template.md $RUN_DIR/report.md`——禁止自创结构、增删节
2. **每测试点必判四态之一**：`pass`（须证据引用）/ `fail`（须入缺陷清单）/ `blocked`（须写卡在哪一步）/ `n-a`（须写原因；`n-a(partial)` = 隔离 profile 无 API key，LLM 依赖功能仅验「请求发出 + 流式 UI 正常」层）
3. **崩溃 / CDP 断连 → 报告照常产出**：中断如实记「中断记录」，已收集证据保留，未执行点判 `blocked`——报告永远不因失败缺席
4. **证据引用必须指向真实存在的文件**：截图失败显式标「证据缺失」，不静默跳过

缺陷分级（入缺陷清单）：P0 崩溃/数据丢失/主流程全断 · P1 主流程受损有绕行 · P2 次要缺陷/明显体验 · P3 视觉文案瑕疵。

## 第六步：缺陷沉淀（问询制）

确认缺陷先入报告 → **问用户**是否沉淀 `tests/e2e/<topic>-regression.spec.ts`（`_electron.launch` 现行模式、workers:1 语义、`AP_USER_DATA_DIR` env 隔离——对齐 smoke.spec 现行惯例；mock 保真守 `momo-test-rules`；e2e 套件在重写路线上，按现行模式写、不预支未来结构）。**沉淀 spec 的运行前提须一并告知用户（评审修正）**：双 workspace `build` + `cd electron && npx electron-rebuild -f -w better-sqlite3`——rebuild 会把 ABI 切到 Electron 侧、破坏 Node 侧 vitest，跑完须按 AGENTS.md 陷阱表恢复（包目录 `prebuild-install` + 必要时 AMFI codesign 重签）。

## 收尾

按序执行（**失败路径同样必做**——报告产出后立即执行，评审修正）：

1. 定位并 SIGTERM 自家 electron 主进程：`kill -TERM $(pgrep -f "remote-debugging-port=<port>" | head -1)`，确认退出；无效升级 SIGKILL。**勿只 kill-session**——tmux 发的是 SIGHUP，Electron 常忽略而留 orphan（评审实测）
2. `tmux kill-session -t momo-acceptance`（driver 窗口随之退；亦可先发 `quit` 命令优雅断开 CDP）
3. `pgrep -f "remote-debugging-port=<port>"` 复核**零残留**
4. 隔离 profile 目录保留（复现用，路径已记报告）→ 提示用户 `.omo/qa-reports/` 会累积、可自行清理

## 反模式（禁止）

- ❌ 未过前置门禁就启动（Node 版本错 / 残留进程 / 依赖坏）
- ❌ 未经授权使用真实 profile
- ❌ 隔离跑在表单输入真实 API key / secret——keychain 写入穿透隔离，收尾不清理
- ❌ 测试失败 / App 崩溃就不出报告——报告永远产出
- ❌ 自创报告结构、跳过模板节
- ❌ 证据引用指向不存在的文件；截图失败静默跳过
- ❌ UX 判断无观察依据（「感觉不错」不算）
- ❌ 错误路径没有专项用例就宣布功能 pass
- ❌ 越界自动修缺陷——验收只报告，修复另起任务走 `momo-debug-rules`
