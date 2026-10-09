# Momo Studio 验收测试技能设计（momo-acceptance）

- 日期：2026-10-09
- 状态：已实施 + 评审修订（2026-10-09 狗粮验收通过；同日 5 路评审后修复回写——隔离三作用域 / 门禁矛盾修正 / canonical driver 提交 / 真实运行证据纪律 / 索引登记，详见 §14）
- 类型：开发工具链设计（非产品功能）
- 判据上游：`docs/specs/*`（行为预期）、`docs/dev/design-system.md`（UI 判据）
- 回归下游：`tests/e2e/`（缺陷沉淀）

## 1. 背景与目标

App 级功能验收目前没有固化流程：靠人工点开 GUI 走查，证据（截图、console 报错、复现步骤）散落聊天记录，报告不成文、不可复现。本设计把「启动 App → 模拟用户操作 → 收集证据 → 产出稳定报告」固化为项目级 AI 技能，用户一句「验收 XX」即可触发完整执行。

原始需求四条：

1. 根据用户提供的信息测试某个功能
2. 检查系统设计是否合理、功能是否存在缺陷、UI 是否偏离设计
3. 模拟用户使用，判断 UX 操作是否合理
4. 稳定输出详细报告（结构确定，不因测试失败吞掉报告）

## 2. 已确认决策

| 决策点 | 结论 |
|---|---|
| 执行机制 | CDP 实时交互操作真实 GUI（截图 / a11y 快照 / console+network 证据）；确认缺陷按需沉淀 `tests/e2e` 回归 spec |
| 报告归宿 | `.omo/qa-reports/<date>-<topic>/`（本地会话产物，gitignored；含 `evidence/` 证据目录） |
| 数据隔离 | 默认 `--user-data-dir` 隔离实例；真实 profile 仅在用户明确授权后使用 |
| 技能形态 | `SKILL.md`（规则 + 流程）+ `references/report-template.md`（模板**原样复制**填充，机械保证报告结构稳定）+ `references/qa-driver.mjs`（canonical CDP driver，评审后新增，见 §3 修订） |

## 3. 非目标

- 不替代单元测试（`pnpm test`）与现有 e2e 套件；不引入新 npm 依赖；不写**启动类**辅助脚本（启动编排复用 `electron/scripts/dev.mjs`）。**评审修订（P1-6）**：CDP driver 作为唯一例外提交 `references/qa-driver.mjs`——防重放播种 / 事件持久化 / URL 脱敏经狗粮与评审双事故证明是散文规范守不住的不变量，固化优于每次运行重造
- 不做性能 / 压测、安全审计（各有专门流程）
- 不自动修复发现的缺陷——修复走 `momo-debug-rules`，本技能的缺陷清单作为其输入

## 4. 文件结构

```
.opencode/skills/momo-acceptance/
├── SKILL.md                    # 规则 + 流程（约 150 行，对齐现有 momo-* 风格）
└── references/
    ├── report-template.md      # 报告模板（每轮验收复制到 .omo/qa-reports/<run>/report.md 后填充）
    └── qa-driver.mjs           # canonical CDP driver（复制到 RUN_DIR，QA_CDP_PORT/QA_RUN_DIR 参数化；评审后新增）
```

配套一行衔接编辑：`.opencode/skills/momo-ui-preview-rules/SKILL.md` 的「P2 事后验收」节增补一句指向本技能。

## 5. SKILL.md 设计

frontmatter 遵循现有格式（`name` + 中文描述 + `Use when` 英文触发子句）：

- name: `momo-acceptance`
- description 草案：`Momo Studio App 级功能验收与测试技能。Use when 验收、acceptance、测一下某功能、测试 XX 功能、UI 偏离设计、UX 走查、发布前验收、回归验收。启动真实 App（CDP 接管 + 隔离 profile），模拟用户操作，产出 .omo/qa-reports/ 稳定报告。`

章节骨架：

| 节 | 内容 |
|---|---|
| 适用判定 | 本技能 vs momo-debug-rules（修 bug）vs momo-test-rules（写单测）vs momo-ui-preview-rules（UI 变更前置预览）的边界 |
| 启动编排门禁 | §6 的清单式规则 |
| 模式路由 | M1/M2/M3 可组合；一次验收默认按用户诉求路由，拿不准问一次 |
| 证据纪律 | §7.4 |
| 报告稳定机制 | §8.6 四机制（逐条铁律化） |
| 缺陷沉淀 | §7.5 |
| 反模式 | §13 |

## 6. 启动编排设计

### 6.1 前置门禁（全部通过才继续）

1. **Node 20 可用性（评审修正：原「node≠20 即停止」与启动命令 PATH 前缀自相矛盾）**：解析 v20 bin 路径（`nvm which 20`），所有启动命令统一显式带该 PATH——tmux server 预存在时新窗口继承 server 陈旧环境，`nvm use` 不透传；v20 完全不可用才停止
2. **进程三分法（评审修正：原二分法漏「本技能残留」）**：用户活实例（不动，走共存变体）/ 本技能残留（cmdline 含 qa-reports 特征，确认后清理）/ 来历不明僵尸（与用户确认后清理）
3. **构建新鲜度**：dev 模式下 renderer 走 vite dev server（无 stale renderer 问题）；主进程 dist 由 dev.mjs 自带新鲜度判定（mtime 晚于编排器启动），冷启动即重编译——技能只需确认 dev 编排器正常拉起 Electron，不自行重复判新鲜度
4. **依赖可用**：首跑若遇 better-sqlite3 `ERR_DLOPEN_FAILED` / `NODE_MODULE_VERSION` 不匹配 → 按 AGENTS.md 陷阱表修复，过程记入报告「环境异常记录」节

### 6.2 启动命令（macOS 主机主路径）

tmux 后台执行：

```bash
AP_USER_DATA_DIR=<repo>/.omo/qa-reports/<run>/profile-appdata \
npx pnpm@9.0.0 dev -- --remote-debugging-port=<port> \
  --user-data-dir=<repo>/.omo/qa-reports/<run>/profile
```

- **隔离三作用域（评审在双隔离基础上增补③）**：①`--user-data-dir` 只隔离 Chromium 层（原「单旗标全量隔离」假设被狗粮证伪）；②应用数据根在 `~/.momo-studio`（`electron/src/main/paths.ts`：`AP_USER_DATA_DIR` 环境变量 ?? 家目录默认）——必须**同时**设 `AP_USER_DATA_DIR`，漏设打开用户真实库（狗粮首跑事故，只读快照即暴露全部真实数据）；③**OS keychain 不随 profile 隔离**（`keychain.ts` 服务名 `Momo Studio` 常量）：读路径安全（keychain 键由隔离库的 instanceId/providerId 派生，读不到真实 key），**写路径穿透**——验收表单输入的 secret 落入真实 OS keychain 且不随收尾清理，隔离跑一律用一次性假值
- 共存变体（狗粮补充）：用户 dev 实例在跑时不再起第二份 `pnpm dev`（vite 5173 / tsc watch 双份冲突），直接 `electron .` 复用其 vite + dist 启动第二实例；单实例锁按 userData 分键可共存（mDNS 服务名冲突未优雅处理，见验收报告缺陷 D6）
- 端口选择：从 9222 起 `lsof` 探测空闲端口递增，实际端口记入报告元信息
- 参数透传注意：`--` 分隔符在 pnpm 下是否被吞有版本差异——以狗粮验收实测为准；若被吞则去掉 `--` 直传参数（dev.mjs 读取的是 `process.argv.slice(2)`，到达即生效）
- **build 产物验收（备选）**：发版前需验收打包产物时，先 `npx pnpm@9.0.0 build`，再直接以 electron 启动（不带 `VITE_DEV_SERVER_URL`），CDP 与 `--user-data-dir` 参数同上；默认日常验收走 dev 模式

### 6.3 CDP 接管

- 工具优先级（狗粮修正）：playwright 库 `chromium.connectOverCDP` 直连为主（仓库 devDependencies 自带）；chrome-devtools 插件连自建 Chrome 实例、接不上 Electron；playwright MCP `cdp_url` 为备选。**连接前必须 `/json/close` 掉 dev 模式自动打开的 `devtools://` target**——否则 connectOverCDP 初始化 30s 超时（实测）
- **canonical driver（评审修正）**：CDP 驱动固化于 `references/qa-driver.mjs`（复制到 RUN_DIR 后以 `QA_CDP_PORT` / `QA_RUN_DIR` 环境变量参数化启动），内置防重放播种、console/pageerror/requestfailed 持续落盘、URL query 剥离——不再依赖运行时按散文重写
- **CDP 生命周期（评审修正）**：连接前 `lsof` 核验端口仅绑 127.0.0.1；agent 异常中断会遗留开放调试端口——门禁 2（起始清扫）与收尾（零残留复核）双向把关
- ready 判定：页面列表出现目标窗口 + 首页 load 完成
- 接管后立即开启 **console + network 持续监听**（证据自动收集，不依赖事后回忆）

### 6.4 真实 profile 门禁（安全红线）

默认一律隔离实例。仅当测试范围确需真实数据 / 真实 API key 时：向用户说明「会写入真实库 + 具体风险」→ 得到明确同意 → 启动去掉 `AP_USER_DATA_DIR` 与 `--user-data-dir`（其余参数不变）→ 报告元信息标 `真实（已授权）`。未授权 = 不碰真实数据，无例外。**授权运行附加纪律（评审修正）**：eval 限被测功能只读断言与明示授权的交互；证据脱敏（禁截设置/密钥页、URL 剥 query）；`evidence/` chmod 700；报告交付后提示及时清理。

### 6.5 收尾

SIGTERM 结束 tmux 会话（进程链随之退出）；隔离 profile 目录保留（复现用），路径记入报告；向用户提示 `.omo/qa-reports/` 会累积、可自行清理。

## 7. 测试模式设计

### 7.1 M1 定向功能测试

输入：用户描述（功能名 / 场景 / 关切点）。

1. **澄清**：信息不足时一次性问清（测什么、预期是什么、有无特定入口），不来回多轮
2. **预期建立**：定位相关 `docs/specs/` 章节与实现代码，把「预期行为」写成可判定的文字；spec 与实现矛盾 → 本身记为发现（M2 层缺陷）
3. **测试点清单**：正常路径 + 边界（空输入 / 长中文文本 / 重复点击 / 并发操作）+ 错误路径——错误路径必须有专项用例（P0 纪律：错误处理里硬编码吞状态曾是验收事故源）。清单亮给用户后**直接执行**（隔离 profile 下的操作非破坏性），用户可中途补充测试点
4. **执行**：CDP 逐步操作，每步截图 / a11y 快照留证
5. **判定**：每测试点判四态（§8.3）

### 7.2 M2 设计符合性（三层）

- **(a) spec 对照**：实际行为逐条对照 `docs/specs/` 相关设计的陈述；偏离即缺陷（含「spec 合理但实现没跟上」与「spec 本身不合理」两种记录口径）
- **(b) 缺陷探查**：空态渲染 / 超长与特殊字符 / 重复提交 / 中断恢复（关窗重开状态是否保真）
- **(c) UI 偏离**：对照 `docs/dev/design-system.md`——语义 token 使用（抽查 computed style）、16px / stroke 1.75 图标、状态色走 `lib/task-status.ts`、明暗双主题各截一组；ESLint 已挡编码层违规，本层查「规范正确但视觉 / 布局不佳」

### 7.3 M3 UX 走查

- 角色设定：新用户（无预置知识，从 onboarding 起走）或熟练用户（跳过引导直击任务），按测试范围选
- 任务清单：把功能拆成 3-6 个真实任务，像人一样完成
- 记录：每任务步骤数、入口寻找路径、误操作与恢复方式
- 评估固定五维，每个判断必须给出可观察依据（截图 / 步骤序列），禁止「感觉不错」：

| 维度 | 判据 |
|---|---|
| 可达性 | 功能入口几步可达；入口是否符合全局导航模式 |
| 反馈及时性 | 操作后有无即时反馈（loading / 成功 / 失败提示）；长任务有无进度可见 |
| 一致性 | 同类操作交互形态一致；图标 / 文案 / 布局与全局模式一致 |
| 容错 | 误操作可恢复（确认框 / 撤销 / 返回）；错误提示是否给出下一步动作 |
| 效率 | 常见任务步骤数是否最短；有无冗余确认 / 跳转 |

### 7.4 证据纪律

- 截图：`evidence/NN-<step-slug>.png`，NN 两位全局递增；关键判定配元素特写 + 整页截图
- a11y 快照：可判定文本证据存 `evidence/NN-<step-slug>.a11y.txt`（可 grep / 可 diff，省 token）
- console 报错 / 网络失败：持续监听收集，报告「环境异常记录」或缺陷条目引用原始消息
- 证据引用必须指向真实存在的文件；截图失败显式标「证据缺失」，不静默跳过

### 7.5 缺陷沉淀

确认的缺陷先入报告（含复现步骤 + 证据）。然后**问用户**是否沉淀为 `tests/e2e/<topic>-regression.spec.ts`：复现步骤转 Playwright（`_electron.launch` 现行模式，workers:1 语义）；注意 e2e 套件本身在重写路线上（README 路线图），沉淀 spec 按现行模式写、不预支未来结构。沉淀时适用 momo-test-rules 的保真度规则。

## 8. 报告设计

### 8.1 目录布局

```
.omo/qa-reports/<YYYY-MM-DD>-<topic>/
├── report.md          # 从 references/report-template.md 复制后填充
├── evidence/          # NN-<step-slug>.png / .a11y.txt
└── profile/           # 隔离实例 userData（复现用，保留不删）
```

### 8.2 模板结构（字段级定义，全文以 references/report-template.md 为准）

| 节 | 必填字段 |
|---|---|
| 元信息 | 日期 / 执行者 / 测试范围 / git commit（hash + subject + 工作区干净与否）/ 构建方式（dev 或 build 产物）/ 环境（主机或容器、Node 版本、CDP 端口）/ profile 类型（隔离+路径 或 真实+已授权）/ 判据文档（引用了哪些 specs / design-system） |
| 环境异常记录 | 启动与运行期环境问题及处置；无则写「无」 |
| 测试点结果表 | # / 测试点 / 预期 / 实际 / 判定（四态）/ 证据引用 |
| 缺陷清单 | 编号 / 严重级（P0-P3）/ 描述 / 复现步骤 / 证据 / 建议；无则写「无」 |
| UX 评估（M3 时） | 五维 × 评分（1-5）× 可观察依据 |
| 中断记录 | 执行中断的时间点 / 现象 / 已保留证据；无则写「无」 |
| 结论 | 通过率（pass 数 / 总测试点，fail / blocked 单列）/ 建议 |

### 8.3 判定四态

| 态 | 定义 | 附加要求 |
|---|---|---|
| pass | 实际符合预期 | 必须有证据引用 |
| fail | 实际违背预期 | 必须入缺陷清单 |
| blocked | 因环境 / 依赖缺失 / App 崩溃无法执行到判定点 | 必须写明卡在哪一步 |
| n-a | 该点在本次范围不适用（含 `n-a(partial)`：隔离 profile 无 API key 时，LLM 依赖功能只验「请求发出 + 流式 UI 正常」层） | 必须写原因 |

### 8.4 缺陷严重级

- **P0**：崩溃 / 数据丢失 / 主流程完全不可用
- **P1**：主流程受损但有绕行路径
- **P2**：次要功能缺陷或明显体验问题
- **P3**：视觉 / 文案瑕疵

### 8.5 UX 评分

五维各 1-5 分：5 = 无可观察问题；4 = 有轻微摩擦；3 = 有明确多余步骤或反馈缺失；2 = 任务可完成但需试错 / 恢复；1 = 任务无法完成或严重误导。评分必须附可观察依据。

### 8.6 稳定输出四机制（铁律）

1. 报告 = 模板文件**原样复制**再填空；禁止自创结构、增删节
2. 每个测试点必须判四态之一；`blocked` / `n-a` 不写明原因视为违规
3. **执行中途崩溃 / CDP 断连 → 报告照常产出**：中断点如实记入「中断记录」，已收集证据保留，未执行点判 `blocked`
4. 证据引用必须指向真实存在的文件；缺失显式标注，不静默跳过

## 9. 环境边界与错误处理

| 场景 | 处置 |
|---|---|
| macOS 主机 | 主路径（§6.2 命令） |
| DevContainer | 备选：`xvfb-run -a --server-args="-screen 0 1280x800x24"` 包裹启动；无 GUI 直显 |
| App 启动失败 | 按 Node 版本 / native binding / 构建产物三类区分，依 AGENTS.md 陷阱表处置；处置过程入报告「环境异常记录」；仍失败 → 全部测试点判 blocked 出报告 |
| CDP 断连 / App 崩溃 | §8.6 机制 3 |
| 端口冲突 | 动态换端口重试一次，再冲突按启动失败处理 |
| agent 异常中断残留调试端口 | 门禁 2 起始清扫自家残留 + 收尾零残留复核（评审修正） |
| 隔离 profile 无 API key | LLM 依赖功能判 `n-a(partial)`，UI 流式渲染与请求发出仍可验 |

## 10. 与现有技能的关系

| 技能 | 边界 |
|---|---|
| momo-debug-rules | 修 bug 流程；本技能缺陷清单作为其输入，不越界代修 |
| momo-test-rules | 沉淀 e2e 回归 spec 时加载 |
| momo-ui-preview-rules | UI 变更**前置**预览门禁归它；其 P2「事后截图验收」衔接本技能（实施时在其 SKILL.md 增一句指引） |
| 内置 visual-qa | 单点视觉检查；整场景验收用本技能 |

## 11. 技能自身验收标准（狗粮）

Markdown 指令无单测。验收 = 干跑真实场景：**onboarding 全流程**（隔离 profile 天然适配：首启引导 → 创建工作区 → 默认 agent → 快速会话发消息，验到流式 UI 层）。

通过标准：

- a) 报告产出且结构与模板逐节一致
- b) 每个测试点四态齐全、证据引用真实存在
- c) 全程未触碰真实 profile（报告元信息可证）
- d) 用户对报告质量认可（最终判据）

**2026-10-09 干跑结果：通过**。报告：`.omo/qa-reports/2026-10-09-onboarding-dogfood/report.md`（pass 10/11、6 项产品发现、5 项运营修正已回写本 spec §6 与 SKILL.md）。

## 12. 实施清单

1. 新增 `.opencode/skills/momo-acceptance/SKILL.md`
2. 新增 `.opencode/skills/momo-acceptance/references/report-template.md`
3. 编辑 `.opencode/skills/momo-ui-preview-rules/SKILL.md`：P2 事后验收节 +1 行衔接
4. 狗粮干跑（§11）+ 用户评判报告

## 13. 反模式（写入 SKILL.md，禁止）

- ❌ 未过前置门禁就启动（Node 版本错 / 残留进程 / 依赖坏）
- ❌ 未经授权使用真实 profile
- ❌ 隔离跑在表单输入真实 API key / secret（keychain 写穿透）
- ❌ 测试失败 / App 崩溃就不出报告——报告永远产出
- ❌ 自创报告结构、跳过模板节
- ❌ 证据引用指向不存在的文件；截图失败静默跳过
- ❌ UX 判断无观察依据（「感觉不错」）
- ❌ 错误路径没有专项用例就宣布功能 pass
- ❌ 越界自动修缺陷——验收技能只报告，修复另起任务

## 14. 评审修订记录（2026-10-09）

5 路评审（目标验证 PASS / QA 实跑 PASS / 代码质量 FAIL / 安全 FAIL / 上下文挖掘 PASS）后的修复回写，全部已同步至 SKILL.md / 模板 / 本 spec：

- **P0**：①隔离铁律升级**三作用域**（keychain：读安全 / 写穿透 + 假值纪律）；②node 门禁矛盾修正（统一显式 v20 PATH，消除「停止 vs PATH 前缀继续」的歧义）；③真实 profile 授权运行附加证据纪律（脱敏 / chmod 700 / 保留提示 / eval 收敛）
- **P1**：④门禁 2 进程**三分法**（补「本技能残留」判别）；⑤tmux 幂等 + 收尾四步具体化（SIGTERM electron PID → kill-session → 零残留复核）；⑥canonical driver 提交 `references/qa-driver.mjs`（§3 非目标相应修订）；⑦CDP 生命周期（loopback 核验 + 起止清扫）
- **P2**：⑧AGENTS.md 路由行 + engineering.md 规则索引 + momo-debug-rules 反向衔接登记；⑨沉淀 e2e 的 build/electron-rebuild 运行前提与 ABI 恢复提示；⑩SKILL.md 补容器 xvfb 门禁项；⑪共存变体 vite 端口探测（5173 被占自动跳号）；⑫「四铁律」第 4 条对齐约束文本（证据真实；缺陷分级独立成行）；⑬M1 边界补「配置默认值 ≠ 实际上下文」分歧场景（P0-8 教训）；⑭模板缺陷清单增「口径」列；⑮description 能力句归位、Use when 触发句收尾
