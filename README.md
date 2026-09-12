# Momo Studio

个人桌面端多 agent 协作平台：把可声明的 agent、可扩展的 MCP/Skill 市场、IM 通道和受控的文件沙箱，全部装进一个本地 Electron 应用。

完整设计见 `docs/specs/2026-08-23-v2.0.0-platform-refactor-design.md`（v2.0.0 现行架构）。`docs/specs/2026-07-28-agent-platform-design.md` 为 v1.x 早期设计，仅作历史参考，v2.0.0 起已被取代（Matrix 层已移除）。

## 状态

**v2.10.0 — Windows 全平台化（开发中，未发布）**

Windows 代码层硬化 + 打包就绪——路径语义 / spawn / 单实例 / NSIS 四层补齐。验证策略：Linux 容器内经 `vi.mock('node:path')` 注入 win32 语义锁住纯路径逻辑，真机验收进行中（平台声明标「实验性」）。spec 见 `docs/specs/2026-09-12-windows-platform-design.md`。

- **paths helper（新增）** — `electron/src/main/platform/paths.ts` 统一全仓目录边界判定：`isInsideDir`（win32 盘符与目录段大小写不敏感 + UNC 等价处理 + 分隔符归一 + `..foo.txt` 不误伤；posix 语义与被替换的手工比对逐字节等价）+ `toPosixRelPath`（POSIX 相对化，`replaceAll` 字面替换不依赖 `split` 段重组巧合）——六模块七处收敛（5 处 `startsWith` + 2 处 `split/join`）；skill 域两处与 realpath anchor 链存量待 v2.10.x 收敛（适用域圈定见 engineering.md v2.10 规则）；平台分叉按「当前 path 模块语义」而非 OS（`PATH_SEMANTICS_WIN32`，mock 测试与生产环境收敛同一结果）
- **六模块 win32 模拟测试** — workspace-fs / journal revert / journal detector / git-tools / browser policy / browser protocol 六模块各配 `*.win32.test.ts`（统一 vi.mock 模板，双 win32 default+named 形态）：大小写命中 / UNC 命中 / 异盘拒 / `..` 边界 / POSIX 归一正确；fs 依赖用例 mock `node:fs` 模拟 NTFS 大小写行为（case-preserving realpath）
- **MCP spawn 修正** — win32 无 shell 的 `spawn('npx')` 直接 ENOENT（CreateProcess 不解析 .cmd shim）：`shell: process.platform === 'win32'` 三态注入（linux 行为零变化）+ command 本体与 args 逐元素引号转义（含空格 command 同走转义——`C:\Program Files\nodejs\npx.cmd` 类路径不转义会被 cmd 切分；内嵌双引号无法安全转义 → 拒绝启动 + 中文报错）；其余 spawn 点（journal git / agent-runner node 自身 / sandbox probe / dev 脚本）逐一审计豁免并注释记录（豁免理由见 spec §3.4）
- **MCP spawn 信任前提** — p2p 导入的 MCP 定义以导入信任门为界（peer 可控 command 本体，`%VAR%` 边缘并非升格路径）
- **单实例锁** — `requestSingleInstanceLock` + `second-instance` 聚焦既有窗口（show + focus，最小化恢复）；无锁实例静默 quit 且 boot 链不执行（修复 v2.0 P2 半成品「quit 后 boot 照跑」）——SQLite WAL 双开锁冲突由此消除
- **NSIS 加固** — `perMachine: false` 显式（per-user 安装免管理员，默认值固化防漂移）+ `build/icon.ico` 占位 + 未签名 SmartScreen 指引（见「Windows 安装说明」）
- 已知边界：长路径 >260 Node/Electron 常规路径可过但 git 操作需 `core.longpaths=true` / MCP win32 shell 模式下 `%VAR%` 在 cmd 双引号内仍可能被展开（参数来自用户本机 MCP 配置，非对抗性输入，文档化不追防）/ 字面反斜杠文件名与分隔符 win32 下不可区分——按分隔符语义解析后归一 POSIX（与 git 在 Windows 的行为一致）/ realpath 符号链接反逃逸链的 anchor 比较仍大小写严格的是 workspace-fs / skill loader 两处（browser policy.ts 的 anchor 已转换 isInsideDir）——真实 Windows 靠 NTFS 大小写不敏感 existsSync + case-preserving realpathSync 兜底（分析确认无死循环路径）
- 主机验收待办（Windows 真机）：安装（NSIS + SmartScreen「仍要运行」实测）→ 首启（如遇 ExecutionPolicy=Restricted 授权卡按指引操作）→ MCP npx server 实启 → 双开聚焦（第二实例静默退出 + 首窗口前置）→ UNC 工作区（创建 + agent 文件操作）

**v2.9.0 — 多仓 git 工具（开发中，未发布）**

workspace 内层仓的 agent 可见可操作——git 九件套（status/diff/log/show/add/commit/branch/checkout/stash）此前固定在 workspace 根仓执行（`runGit` 恒 workspaceDir），agent 能改内层仓文件却看不见也管不了这些仓的 git 状态（monorepo 子服务、vendored 依赖、嵌套克隆是真实工程常态）。v2.9 以「发现列表是唯一 `-C` 入口」为安全骨架，把多仓能力交到 agent 手上。spec 见 `docs/specs/2026-09-12-multi-repo-git-design.md`。

- **git_repos 发现工具（新增，第 10 个 git 工具）** — 列 workspace 内全部 git 仓：每仓一行 `root: <是否根仓>  branch: <当前分支>  dirty: <改动数，50+ 封顶>  <相对路径，根仓为 (.)>`；discoverRepos 已保序（根在前、内层字典序），单仓查询失败该行 `branch: ?  dirty: ?` 不降级整体。工具描述引导 LLM「改内层仓文件或对其 commit 前先调用本工具确认可用仓」
- **9 工具可选 `repo` 参数** — 全部 git 工具 inputSchema 加 `repo?: string`（workspace 相对路径，缺省根仓）：缺省路径 args 与 spawn **逐字节零变化**（不前置 `-C`，既有 agent / 测试零回归）；指定时经 `resolveRepoPath` 双校验——`wsFs` 边界（拒 `..`/绝对路径/symlink 逃逸）+ 必须命中 `discoverRepos` 发现列表（`./x` / `x/` 等形态归一后比对，Windows 反斜杠同口径 POSIX 归一），未命中报错附可用仓清单（含缓存失效重试指引）；命中后 `git -C <该仓>` 执行
- **discoverRepos 上提共享** — 探测器自 `journal/detector.ts` 上提为 `git/repos.ts` 共享模块（纯搬家：函数+缓存+mtime 逐字节迁移，仅 `DEFAULT_MAX_DEPTH` 加 export），v2.5 账本对账与 git 工具层从此同源；账本零改动（记账按 workspace 相对路径天然仓无关）
- **GitPolicy 均匀继承** — 三层校验（总开关 / 分支保护 / message pattern）对任何仓一致适用，分支保护按**目标仓自己的当前分支**匹配同名规则（内层 main 受保护与根 main 同拒；总开关关则全仓拒绝）；commit 的 fallback 分支切换 / 回滚 / 提交全部落目标仓
- 已知边界：探测深度 3 层（更深用 bash，与账本探测器同深度——对账语义自洽）/ 新克隆仓依赖目录 mtime 缓存失效后可见（父目录条目变化即失效，实践中即时）/ Windows 反斜杠 repo 参数按 POSIX 相对路径归一匹配 / 根仓无 `.gitignore` 覆盖内层仓时对账出现 `?? services/` 目录条目噪声——v2.5 探测器既有口径，非本次引入
- 主机验收待办：monorepo workspace 实测内层仓 commit（分支保护跨仓生效 + fallback 落目标仓）+ 任务卡「未入账」对账联动（`git_repos` → 内层改动 → `scanUnjournaled` 零漂移归类）

**v2.8.0 — Orchestration 元语（开发中，未发布）**

会话内编排面补齐两大缺口——「子 agent 不可续接」（dispatch 一次性 body 进 / reply 出，无法追问）与「无 fire-and-forget + gather」（leader 派发后必须当场等完）：新增 5 个编排原语（续接族 + 异步句柄族），与既有 dispatch:<slug> 同门注入，路由链（routeDispatch → executeTask）零改动复用。spec 见 `docs/specs/2026-09-12-orchestration-primitives-design.md`。

- **5 编排原语（新增）** — `dispatch_followup`（replay 续接——`rebuildSubConversation` 从 message_events 重建该链全部轮次的 LLM messages 后 re-spawn 续聊，复用 v2.6 重建器语义：完整工具对 verbatim 保留 / 孤儿 tool_call 合成中断 result / 重建抛错降级不阻断）+ `dispatch_bg:<slug>`（非阻塞派发立即返回 `{taskId}` 句柄，同 PM 在途上限 8，超限报错含清单教 LLM 先 gather/cancel）+ `dispatch_gather`（all|any 收割，迟到 reply 缓存命中，超时非错误——返回 done/pending 结构，句柄保留可再 gather）+ `dispatch_status`（单句柄查询）+ `dispatch_cancel`（取消在途，复用 abort_dispatch 链路，幂等）
- **taskId = 链 ID** — 多轮 followup 沿用原 dispatch 的 task_id（不另造 ID 空间）：`WHERE task_id = ?` 天然聚合全链轮次；上轮 settle 后才可再 followup（同链串行，pendingReplies 键安全）；每轮新 subStreamSessionId；**v2.8.0 已知边界：followup 子流暂不在消息流嵌套渲染（chip 呈现），答案经工具卡 result 文本可见——chip 实装与 bg chip 终态翻转同批排 v2.8.x**
- **链路打标基础设施** — 派发链 task_id 端到端落库：start chunk 携带 taskId + insertMessage 调用点写 task_id + 追问行 helper（followup 的 user 追问落库关联链）——修复「task_id 恒空」后，followup 重建 / read_task_progress / 记忆注入的链查询才有真实数据域
- **handleTaskReply 单点收口扩展** — pendingReplies miss 时查 bgHandles（in_flight 翻转 done / cancel 后迟到 reply 忽略 body）+ gatherWaiters 独立等待集唤醒——reply 路径不 fork
- **零新表零迁移** — followup 重建走 message_events 既有真相源；bg 句柄纯内存（Map）；TaskConfig 仅加可选 `historyPrefix` 字段（与 v2.6 resumeTurn 正交互斥，runChatLoop 防御优先 resumeTurn）
- 已知边界：孙 agent 嵌套禁止（子 agent 非会话 leader 天然无 dispatch 工具）/ followup 仅同步（无 followup_bg 组合）/ followup 子流暂不嵌套渲染（chip 呈现留 v2.8.x，答案经工具卡 result 文本可见）/ bg 句柄不跨重启（重启后 status → not_found）/ PM abort 不级联 cancel bg（句柄随子进程消亡）/ bg chip 终态 renderer 翻转留 v2.8.x / 结构化 reply 不做、同链 chip 不分组
- 主机验收待办：dispatch → followup 追问保留上下文实测（子 agent 无需重述背景直接续答）/ bg 三连派 → 干别的 → gather 收割实测（含超时后句柄再 gather）

**v2.7.0 — McpBrowser 浏览器工具（开发中，未发布）**

12 个浏览器工具 + 内嵌浏览器侧栏——puppeteer 零依赖路线：Electron 原生 WebContentsView 叠加渲染（renderer 只画 chrome，页面内容属主进程）+ per-workspace partition 隔离（`persist:browser-<wsId>`，登录态跨重启保留）。spec 见 `docs/specs/2026-09-11-mcp-browser-design.md`。

- **12 浏览器工具** — navigate / tabs(list/open/close/switch) / snapshot（a11y 树 + selector 提示）/ screenshot（落 `userData/browser-screenshots`，经 `browser-shot://` 协议供 renderer）/ evaluate（默认关）/ click / hover / type / press_key（白名单键）/ scroll / console_messages（每 tab 50 条环形）/ close——无 puppeteer/CDP-HTTP 依赖，全部经主进程编排
- **单页共享 + takeover 三入口** — agent 与用户操作同一页面（单页仲裁，无镜像）；接管三入口：地址栏回车（userNavigate 隐式接管）/ 显式「接管」路径 / 页内点击原生 overlay（agent 态透明 WebContentsView 拦截 mousedown，键盘 before-input-event 同路径）；user 态下任一 agent 浏览器工具立即失败（TakenOver 可重试语义，显式释放回切）
- **右侧浏览器侧栏** — tabs 栏 + 地址栏 + 接管/信任徽标 + 可折叠（折叠销毁视图省内存，展开按清单重建）+ dev server 探活下拉（5173/3000/8080/4200/8000，TCP 试连 + HTTP HEAD 双校验防裸端口误报）
- **信任卡 + 设置分类** — trust 三态 ask/always/deny：ask 且 agent 首调推右下角信任卡（本次会话 / 永久允许 / 取消）；设置页「浏览器」分类——信任模式 / 域名黑白名单（子域匹配，白名单优先）/ evaluate 开关 / 清除浏览数据（清 partition storage）；workspace_settings 表 migration 034
- **安全边界** — file:// 限定 workspace 目录内（resolve 字符串边界 + realpath 最近祖先双防线，拒 `..` 与符号链接逃逸）；popup/window.open 一律 deny + 收编新 tab（不产生游离 OS 窗口，popup URL 同样过策略）；下载一律拦截（will-download preventDefault + notice）；视图 webPreferences 四硬化（nodeIntegration 关 / contextIsolation / sandbox / webSecurity）；域外协议全拒（仅 http(s) 与 workspace 内 file://）
- 已知边界：域名策略不复检重定向（初航过名单后，页面 302 跳转目标不二次校验）/ 侧栏宽度受控化待接（落库侧就绪，当前静态 380px）/ macOS activate 事件窗口重接待办 / `electron/tests` 未纳入 eslint 门禁（typecheck 门禁已含）/ e2e 容器降级（页内点击经主进程 sendInputEvent 驱动——OS 层 overlay 栈顶命中的真实鼠标链待主机）
- 主机验收待办：真实鼠标 → overlay 栈顶命中接管 / browser-shot 截图协议打包（electron-builder resourcesPath）落位 / partition 登录态跨重启实测 / dev server 探活真机联动

**v2.6.0 — 任务断点续跑（开发中，未发布）**

重启后 in-flight 任务事件重建式断点续跑——工具防御第四期，清偿自 v1.3 起连续四版列出的「重启自动恢复 agent runtime（持久化运行状态）」基础设施债。不新建持久化机制——`message_events` 本来就是流式事件的持久化真相源，断点素材已在 DB 里。spec 见 `docs/specs/2026-09-10-task-resume-design.md`。

- **回合重建器（新增）** — `turn-reconstructor` 按 seq 序聚合事件为合法 LLM messages：完整工具对 verbatim 保留不重跑；孤儿 tool_call（含 dispatch）合成 `[执行中断]` tool result 补齐协议对（LLM 看到事实自决重试）；半截 assistant 文本收尾为完整消息；steer 已 drain 随消息重建、未 drain 进 `steers[]` 随载荷重放；thinking / message_roll / 未知事件类型一律跳过（前向兼容——schema 演进时旧中断任务安全退化）；任何重建抛错 catch 降级 degenerate（等价全新回合，降级本身是设计要求）
- **关机保态 + 陈旧流清扫** — 正常退出不再被 failTaskOnCrash 误标 failed：runner `markShuttingDown()` 关机先置 flag，`handleChildExit` 据此跳过任务终态转换（保留 in_progress）但消息行仍诚实标 failed；boot `sweepStaleStreaming` 兜底清扫崩溃 / 强制 kill 残留的 streaming 陈旧流（runMigrations 之后、runtime 起动之前）
- **断点接续执行** — `resumeTask` 经既有 AgentRunner.executeTask + registerLane 派发（maxConcurrentTasks 并发闸 + 会话车道串行性天然生效，同流双恢复被 lane 守卫拦截）；resume 载荷（messages / toolCallsUsed / steers / degenerate）经 task-config 透传子进程，`runChatLoop(resumeTurn)` 从中断点继续——messages 接续不重发 currentBody、预算续扣不重置、steers 重放进 mandate；消费侧接线锁走真实生产路径（runtime-task-driven），红绿变异验证摘掉透传必红
- **steer 落库** — 中途补充 drain 时补发 `steer` 事件走既有 event buffer 落库（断点重建可见性，v2.6 前只进内存）；重建器消费已 drain steer 随消息重建，未 drain 进恢复载荷重放
- **恢复卡（v2.5 账本联动）** — 启动右下角非模态卡（SandboxNotice 同款基建，boot 现查现示、瞬态无 kv 标记）：逐任务行（标题 / agent 名 / 「半程变更 M 处」）+ [恢复] / [放弃] 二选一（直接放弃 → cancelled；撤回变更后放弃 → journal:revert 全条目再 cancelled，撤回结果行内摘要）；全部决策完卡片消散；IPC 两通道 `task:listInterrupted` / `task:resume`（与 paused K7-5 恢复多路复用，不新增通道名）
- 已知边界（spec §3）：会话闲聊流不恢复（中断定格，用户重发一句话）；dispatch 嵌套不自动续跑（父恢复时子流合成中断 result，LLM 自决重派 = 全新子流）；断点不做跨版本兼容保证（未知事件跳过 + 重建失败降级——安全退化为全新回合）

**v2.5.0 — 变更账本与撤销（开发中，未发布）**

agent 文件变更全量记账 + 可靠撤销——工具防御第三期：git 安全网在无 git 机器上失效（D1），改用零依赖零假设的本地账本。spec 见 `docs/specs/2026-09-10-change-journal-undo-design.md`。

- **五 op 记账（新增）** — write_file / edit_file / apply_patch / rm / mv 五个写类工具在落盘前单点收口调 recordChange（D2，对齐 v2.3 Read-before-Edit / v2.4 resolveShellSpawn 的「单一接入点」纪律）；before/after 内容入 userData 内容寻址 blob，条目入 state.db；rm 递归逐文件记账（内存有界）；store 未注入降级跳过不阻断工具主路径
- **hash 守卫 + 逆序撤销** — revertEntries 逐文件按 created_at 逆序执行，写回前校验 hash(当前文件) == after_hash：漂移（其后被任务 B / 手动 / shell 改过）默认拦截 + 黄标，force 可强制但警告「将丢失其后全部变更」；交叉场景（任务 A/B 同改一文件）默认拦 A、「回滚到此文件此条之前」组合操作自动逆序逐步守卫；撤销动作本身记对称条目（撤销可再撤销）
- **多仓 git 探测器（机会主义增强）** — bash 不经过账本，事后核对补洞：discoverRepos 限定深度找 workspace 内全部 git 仓（根仓 + 内层仓，结果缓存），scanUnjournaled 对每仓跑 porcelain 与账本路径集做差产出「未入账」清单；只读不写绝不 commit；git 不可用 / 执行失败 / 截断一律 degraded 空结果（无法核对绝不半真半假）
- **200MB + 30 天配额滚动清理** — 对齐审计配额先例（D7）：workspace 级 200MB（设置页可调）+ 30 天硬上限双条件独立触发；超限按最旧任务组 / 快速会话段整组删，共享 blob 由引用计数守护（仍有引用不物理删）；记账每 50 次节流触发 + boot 强制执行
- **两入口 UI** — 消息流「N 处变更」chip（行级 diff + 单条撤回 + 漂移黄标，快速会话无任务也可用）+ 任务卡变更审查面板（按消息分组聚合 diff + 未入账区（degraded 提示）+「撤回全部」/ 逐文件组合回滚）；IPC 四通道 `journal:list / revert / scan / rollbackFileBefore`
- 已知边界（spec §10）：账本按 utf-8 存取，二进制文件撤回有损；bash 账外变更只有事后核对，未入账区无法区分 shell 与用户手动

**v2.4.0 — ShellTools OS 沙箱（开发中，未发布）**

bash 工具接入 OS 级隔离——工具防御第二期，清偿 v2.1 安全债务「OS 级沙箱接线」。spec 见 `docs/specs/2026-09-10-shell-tools-os-sandbox-design.md`。

- **三平台沙箱路径（新增）** — macOS Seatbelt（`sandbox-exec` + SBPL profile：全盘只读 + 敏感目录 deny + workspace/tmp 写白名单 + 网络开关）/ Linux bubblewrap（`bwrap`：`--ro-bind` 全盘只读 + 敏感目录 tmpfs 遮盖 + workspace 与 /tmp 可写 bind + `--new-session` 防 TIOCSTI）/ Windows 无 OS 沙箱（PowerShell plain 路径 + `taskkill /T` 杀进程树 + remove-item 黑名单双向语序拦截）
- **resolveShellSpawn 三态决策** — wrapped（沙箱包裹）/ plain（permissive 降级直跑，审计标记 `unsandboxed:*`）/ blocked（strict 且不可用时 spawn 前拒绝，错误含安装指引）；shell-tools 唯一接入点；npm/pip 缓存 env 重定向沙箱内 tmp（写剖面自洽）
- **strict 默认 + permissive 逃生门** — 沙箱不可用时默认拒绝 bash 执行（推荐安全位）；设置可切 permissive 降级运行（无 OS 隔离，结果 sandbox 行明示）
- **网络默认禁 + 设置开关** — 沙箱内 bash 默认无网络（bwrap `--unshare-net` / Seatbelt deny network*）；开关放开仅影响 bash，LLM API 调用不受影响
- **bash 结果 sandbox 行** — `exit_code:` 行后紧跟 `sandbox: <tag>`，LLM 与用户可感知单次执行是否落在 OS 沙箱内
- **boot 探测 + IPC 4 通道** — 启动 fire-and-forget 探测（bwrap `--version` / sandbox-exec 最小 profile 冒烟 / pwsh + ExecutionPolicy），失败不影响启动；`sandbox:getState` / `reprobe` / `installBwrap` / `dismissPrompt`
- **设置「安全沙箱」分类 + 首启提示卡** — 模式单选 / 网络开关 / 探测状态只读区 + 重新探测；Linux 缺 bwrap 右下角非模态引导卡（复制命令 / pkexec 一键安装 / 装后自动重探测），Windows ExecutionPolicy=Restricted 授权指引卡
- 真实 bwrap 条件集成测试（容器拦 user namespace 时整组自动 skip，不造假绿）

**v2.3.0 — FileTools 防御硬化（开发中，未发布）**

工具防御契约系统性补齐——结构化 patch + Read-before-Edit + 失败信息增强。

- **结构化 apply_patch 工具（新增）** — V4A 语法（add / update / delete 三头）+ 自写 PEG parser + 多文件原子执行 + 失败自动回滚（备份到 Electron userData/apply-patch-tmp/）
- **Read-before-Edit 强阻塞守门** — edit_file / write_file（覆盖场景）前必须先 read_file 读取同文件；write_file 创建新文件豁免；子 agent 永远 fresh-session（与 Memory 子 agent 规则一致）
- **edit_file 失败信息增强** — 错误信息含原文前 5KB 快照 + 首次不一致行号 + read_file 重试建议；LLM 一次 round-trip 即可定位错误
- **builtin agent 同步** — 3 个 builtin YAML（coder / pm-agent / requirement-analyst）defaultTools 加 apply_patch；Migration v32 幂等同步
- **ToolContext 扩展** — 新增可选 `readTracker?: ReadTracker`（向后兼容；未注入时不阻塞既有流程）
- 详见 `docs/specs/2026-09-10-file-tools-defense-hardening-design.md`

**v2.2.1 — 供应商预设与模型思维模式（开发中，未发布）**

供应商新建预设化 + 思维模式两级配置。spec 见 `docs/specs/2026-09-09-provider-presets-design.md`，实施计划见 `docs/plans/2026-09-09-provider-presets.md`。

- **供应商预设目录**——15 家手写预设（国内直连 5 + 国际直连 6 + 聚合/本地 4）：ProviderDialog 两段式（预设卡片 → 预填表单 + API Key），预设模型种子幂等写入（INSERT OR IGNORE，不覆盖用户改动），聚合/本地商引导「获取模型列表」；`model_providers.preset_key` 标记来源（「已添加」徽标）
- **内置目录升级**——`model-catalog.ts` 条目增加思维模式能力（`ReasoningCapability`：none/toggle/effort{values,default}）+ 补旗舰缺位（GLM-5.x 1M / DeepSeek V4 1M+384K / Kimi K3 1M / gemini-3）
- **思维模式两级配置（migration v31）**——`provider_models.thinking_json`（模型级默认）+ `agent_definitions.thinking_json`（agent 级覆盖，NULL=继承）；`resolveThinkingConfig` 单点 resolve（配置四级 fallback + 能力词汇表预设→目录 + 方言模型级覆写→预设级→platform 兜底 + effort 越界钳制回默认）
- **请求注入（wire 方言）**——`createLLMProvider` 第三参实例级持有；四种方言映射表：`toggle` / `toggle-effort`（GLM-5.x、DeepSeek V4：thinking.type + reasoning_effort）/ `effort`（OpenAI、K3：顶层 reasoning_effort）/ `anthropic-budget`（档位→budget_tokens 阶梯 + max_tokens 抬升）；`chatStreamAnthropic` 旧硬编码 always-on 10000 退役为方言驱动（medium 档=10000 保持成本连续）；thinking 解析加 `reasoning` 别名容差
- **UI 三处**——ProviderDialog 预设两段式；模型列表行内思维三态控件 + 档位下拉 + 窗口 placeholder 显示 resolve 有效值（1M/200K/自动）；三个 agent 编辑器（Create/Definition/MemberEdit）「思维模式：跟随/关闭/开启(+档位)」覆盖控件

**v2.2.0-p1 — Agent 记忆系统·数据与手动层（开发中，未发布）**

三层记忆（会话/工作空间/全局）第一期：数据层 + 手动管理。spec 见 `docs/specs/2026-09-03-v2.2-agent-memory-design.md`，实施计划见 `docs/plans/2026-09-03-v2.2-agent-memory-p1-data-manual.md`。

- **数据模型（migration 027）**——`memories` 表（scope 列三层 + kind/pinned/source 三维，session 级联删除）+ `session_summaries` 滚动摘要表 + `memories_fts` FTS5 external content 派生索引；向量伴生表仅预留 schema 升级位（BM25 召回不足时再上）
- **检索层**——jieba（@node-rs/jieba）预分词与 FTS5 写入/查询两侧同源（契约测试锁死），BM25 中文检索 + 三层并集 scope 过滤；repo CRUD 与 FTS 双写同事务（主表与索引永不漂移，UPDATE 顺序修正规避外部内容表 CORRUPT_VTAB/静默漂移双失败形态）
- **注入链路**——`MemoryProvider` 扩展四方法（既有五签名冻结）：常驻/检索双类型注入视图（预算合计 7000 字符，≈3000 token，分段 2000/3000/1000/1000）+ 每轮现拉（UI 修改下一条消息即生效）+ 子 agent 不带会话记忆（fresh-session 对齐）+ `memoryEnabled` 总开关（只 gate 注入）
- **手动管理**——设置页「记忆」分类：全局/工作空间双层 tab、置顶/编辑/删除（确认）/新增/总开关；`memory:*` 五通道 IPC 双端类型对齐
- **P2 已落地（agent 工具 + 自动提取）**——MemoryTools 三工具（memory_save/search/forget，用户主权保护 + 审计）；自动提取管线（任务完成/会话每 20 轮触发、10 分钟去抖、ADD-only 提示、BM25 去重、最近 50 条窗口 DESC 取数）；会话滚动压缩（>40 消息融合既有摘要 upsert + covered_until 游标）；设置页「自动提取」开关（总开关联动禁用）；boot jieba 冒烟；注入补强（会话记忆段/provider 兜底空视图/catalog SQL LIMIT）
- **P3 已落地（收官）**——记忆导出/导入 Markdown（同 scope 去重 + source 固定 user）；命中统计（use_count/最近命中）+ auto 条目 90 天「建议清理」黄标（仅标记，删除仍走确认）；content 长度上限双端 enforcement（2000/rule 4000）；数据信号净化（提取去重不污染计数/top3 比对）；审计层级标识、messageToContext 单点化、UI 错误条/竞态守卫/回滚/a11y 打磨
- 待办：macOS 主机冒烟八项（P1 四 + P2 两 + P3 两：导出→清库→导入复原 / auto 条目 90 天黄标）——v2.2 功能全量完成

**v2.0.0 — Released**

2.0.0 正式发布——五期重构一气呵成：传输层内迁（终结 Matrix/Tuwunel 双轨）、UI 骨架与设置重构、半成品处置与 IPC 收敛、P2P 局域网协作、升级体验收尾。架构上从 v1.x 的「Electron + Matrix/Conduit 子进程 + 双轨 IM」收缩为「单进程 Electron + 内置 SessionService + 进程内事件分发」，本地零外部依赖、消息/委派不再经过外部协议服务器。详见 `docs/specs/2026-07-28-agent-platform-design.md` 与各期实施计划（p1-p5）。

- **五期一句话总结**
  - **P1 会话内核去 Matrix**——彻底移除 Matrix/Tuwunel 全家（matrix-js-sdk、Conduit 子进程、bot 注册器、Space/room 列）；`sessions` / `session_members` 表取代 Matrix room；SessionService + 进程内事件分发；dispatch/task_reply 走内部事件桥
  - **P2 UI 骨架与设置**——无边框窗口 + 自绘 TitleBar；活动栏 + 统一侧边栏；设置独立界面；provider platform 显式化（migration v24）；MCP 子进程桥恢复；`agent:stream` 死推送清理
  - **P3 半成品处置 + IPC 收敛**——`spawn-helpers.ts` 显式透传 `provider.platform`；空 model 源头拦截 + `gpt-3.5-turbo` 兜底退役；#T 双语法输入框 + T-序号任务 id 端到端闭合；资源注册面 IPC 收敛（`resource:registerMcp` / `resource:uploadSkill` 取代 `mcp:register` / `skill:uploadZip`）
  - **P4 局域网联网**——P2P payload 多类型分发（message / task-snapshot / resource-catalog / resource-request / resource-provide）；任务快照出站广播 + 远端任务只读镜像（spec D7 铁律）；agent/MCP 资源分享 + 一键导入（请求/供给协议 + 30s 超时）
  - **P5 升级体验**——主进程 boot 链 `runLegacyUpgradeIfNeeded()`（runMigrations **之前**）；旧库（schema_migrations 最大版本 < 23）只读连接全量导出 Markdown（按房间）+ JSON（agent 定义），落 `upgrade-export-<时间戳>/`；`state.db(+wal/shm)` 改名 `.legacy-v1.bak` 备份；renderer 首启右下角非模态卡片一次性提示导出目录

- **升级说明**（v1.x 旧库用户）
  - **完全重新开始（D5 决策）**——不做旧数据兼容；检测通过后在原路径按 2.0 schema 全新建库，旧库在 runMigrations 前被备份而非删除
  - **首启自动导出**——检测到旧库即全量导出「房间消息 Markdown + agent 定义 JSON」，目录路径由首启提示告知（位于用户数据目录下 `upgrade-export-YYYYMMDD-HHmmss/`）
  - **备份路径**——`state.db` / `state.db-wal` / `state.db-shm` 在末尾加后缀重命名为 `state.db.legacy-v1.bak` / `state.db-wal.legacy-v1.bak` / `state.db-shm.legacy-v1.bak` 留在原位置，需要时手动还原（实现见 `electron/src/main/upgrade/legacy-upgrade.ts:60-63`——suffix 追加在 `-wal`/`-shm` 之后）
  - **首启提示**——右下角非模态卡片（「已升级到 Momo Studio 2.0」+ 说明 + 等宽路径 + 「知道了」），点击「知道了」kv 标记清空，下次启动不再提示
  - **导出异常不阻塞**——单条失败仅 warn 记录，旧数据完整保留在备份文件中；最坏情况是少一份 Markdown/JSON 导出，**不会丢数据**

- **指引**
  - **macOS 主机验收清单**——P1/P2 半成品「真实拖拽 tab / 红绿灯 / frameless 标题栏」、P3「platform 下拉选择端到端生效」、P4「两台局域网设备互信 + 资源请求供给 + 任务远端镜像」、P5「1.x 库升级实测（旧库检测 + 导出 + 备份 + 首启提示 + 二次启动不重提示）」
  - **2.1 清单位置**——P4 遗留 skill 分享（需文件块传输协议）/ 双向看板（当前远端任务仅只读）/ hub 中继；P2/P3 遗留（重启自动恢复 agent runtime / e2e 套件重写 / Windows 沙箱）；安全债务（LAN 帧加密或对应设计稿 / OS 沙箱接线 / p2p 私钥入 keytar）

- **DoD 对照**（spec §10 验收标准 × 收官状态，P5 T4 实测）

  | # | 验收标准 | 状态 | 依据 |
  |---|---|---|---|
  | 1 | 重启一致性：流式输出中途杀进程重启，UI 展示逐字节一致 | ✅ 单测验证 | restart-consistency 7 场景（实时聚合==重启聚合 / dispatch 嵌套 / 多段 / 千级并发）；真实 LLM 交互实测待 macOS 主机（P1 终审记录） |
  | 2 | 大上下文：≥1MB 正文 + 500 工具调用事件无截断、顺序正确、重启还原 | ✅ 等价单测 / 主机待验 | 千级 text_delta + 50 tool_call 并发重启一致测试；字面规格（1MB/500）待 macOS 主机实测 |
  | 3 | 无 Matrix 残留：无 Tuwunel 进程 / 无 matrix-js-sdk / 体积减小 | ✅ 已验证 | P1 删除 54 文件（−3226 行）+ matrix-js-sdk 出库；收官复扫依赖树与锁文件 0 命中；xvfb 冒烟零 Matrix 进程 |
  | 4 | UI：titlebar tabs + 活动栏 + 设置独立界面；Ctrl/Cmd+B 折叠侧栏 | ✅ 已验证（单测+xvfb） | P2 终审 APPROVED；真实拖拽 tab / 红绿灯交互待 macOS 主机 |
  | 5 | 设置：模型服务两列 CRUD + 检查连接 + 模型列表；默认模型四类；审计滚动删除 | ✅ 已验证（单测） | P2 终审交叉审计全过（provider 链 / 审计链）；配额滚动删除含滞回回归锁 |
  | 6 | 联网：两台局域网设备互信后，看板只读镜像 + 资源分享导入可演示 | ✅ 单测 + 单机双进程 / 双机待主机 | P4 终审 APPROVED（107 新测试）；mDNS 发布经第二进程发现验证；双机实测待 macOS 主机 |
  | 7 | 测试：typecheck 双 clean；健康测试全绿；restart-consistency 扩展大上下文 | ✅ 收官实测 | electron 1074 + renderer 548 全绿零 flake；typecheck 双 clean；build exit 0；electron-builder 产物内嵌版本 2.0.0；xvfb 冒烟双启动通过 |

**v2.0.0-p4 — 局域网联网（开发中，未发布）**

2.0.0 第四期：P2P 局域网协作——任务只读镜像 + 资源分享。详见 `docs/plans/2026-08-23-v2.0.0-p4-lan-sync.md`。

- **P2P 协议扩展——payload 多类型分发**——`MessagePayload.type` 收敛为五个实义值（message / task-snapshot / resource-catalog / resource-request / resource-provide），P2pSync 按类型多路分发；原 'task'/'presence'/'ack' 预留位（无生产发送方）移除
- **任务快照出站广播**——task 写通道（create / transition / cancel / start）与 scheduler 自动转换成功后 fire-and-forget 全量快照广播；45s 周期兜底重播保证对端 staleness 有界
- **远端任务只读镜像**——入站快照只进内存缓存，绝不写 `tasks` 表、调度器不消费远端数据（spec D7 只读铁律）；看板 TaskSidebarPanel 新增「远端节点」只读分区（节点分组卡 + 5s 轮询，无操作按钮）
- **资源分享（agent / MCP）**——custom 资源目录广播（资源/agent 写通道触发 + 5min 周期兜底）；资源库新增「P2P 共享」来源 tab；入站目录内存缓存 + 读路径顺带 prune（离线对端不滞留）
- **资源一键导入（请求/供给协议）**——requestId 配对 + 30s 超时：agent 定义落地 custom（不落 assignment，导入后手动加入 workspace；slug 冲突加 `-from-<节点前4>` 后缀）；MCP 定义重名幂等覆盖
- 范围裁定：skill 分享留 2.1（需文件块传输协议；agent/MCP 是 JSON 结构化定义可直接载）；任务广播用全量快照（不做增量 diff）；远端任务 UI 轮询刷新（5s，不加推送通道）
- 2.1 遗留：skill 分享 / 双向看板（当前远端任务仅只读）/ hub 中继
- 验收边界：容器单机——mDNS 发布经第二进程发现验证（nodeid + 公钥 TXT 记录）；双机真机联调（spec 验收 6「两台局域网设备互信」）留 macOS 主机
- 待办：P5 升级体验

**v2.0.0-p3 — 半成品处置与 IPC 收敛（开发中，未发布）**

2.0.0 第三期：P1/P2 半成品收尾 + IPC 面收敛。详见 `docs/plans/2026-08-23-v2.0.0-p3-cleanup-ipc.md`。

- **provider.platform 运行时接线**——`spawn-helpers.ts` 显式透传 `provider.platform` 到 `createLLMProvider`，baseUrl 启发式检测退役为缺省回退；设置页 platform 下拉选择自此生效
- **默认模型 fallback + testConnection 统一**——会话默认模型配置接入后端写路径（新建时兜底；表单校验放宽与保存路径扩展留 P4）；`gpt-3.5-turbo` 硬编码兜底删除，空 model 源头拦截返回结构化提示（两路径行为统一）
- **#T 双语法输入框 + T-序号任务 id**——MentionInput 现役化（@ agent / #T 任务双 mention）替换 MessageInput；任务 id 改 T-序号 约定，#T mention 端到端闭合
- **任务看板补完**——assignee 筛选实数据 + 看板卡片进入执行会话接线
- **L2 工作空间能力面板**——工作空间级能力（Layer 2）编辑 UI 挂载
- **能力配置归一**——mergeCapabilities 读写收拢单一 owner，消除双写路径
- **资源注册面 IPC 收敛**——`mcp:register` / `skill:uploadZip` 通道退役，统一 `resource:registerMcp` / `resource:uploadSkill`
- **杂项加固**——ghost provider 兜底缺失分支补 warn 日志；audit 分支防御 + 注释纠偏
- 待办：P4 局域网联网、P5 升级体验

**v2.0.0-p2 — UI 骨架与设置（开发中，未发布）**

2.0.0 第二期：应用壳与设置重构。详见 `docs/plans/2026-08-23-v2.0.0-p2-ui-shell.md`。

- **无边框窗口 + 自绘 TitleBar**——frameless（mac 保留红绿灯），workspace tab + 窗口控制 IPC + 状态持久化；Linux 路径 xvfb 冒烟通过
- **活动栏 + 统一侧边栏**——LeftRail / WorkspaceSwitcher 退役；ActivityBar 切换主视图，全局 Ctrl/Cmd+B 折叠侧边栏
- **设置独立界面**——AccountSettings 内嵌页退役；独立设置界面（分类导航 + 菜单重排）
- **模型服务两列管理**——provider platform 显式化（migration v24：provider platform / provider_models / audit 配额列）+ 模型列表管理
- **默认模型四类 + 关于页**——默认模型按场景四类选择；About 显示 Electron 版本
- **审计容量滚动删除**——audit 表配额上限 + 滚动删除；`audit:toolCall` 子进程桥恢复
- **MCP 子进程桥恢复**——task-driven 执行路径重新可用 MCP 工具（死通道防御 + 进程池惰性填充）
- **abort 级联传播**——`abort_dispatch` 中断子 agent；删除 `agent:stream` 死推送
- 待办：mac 主机交互验收（真实拖拽 tab / 红绿灯）

**v2.0.0-p1 — 会话内核（开发中，未发布）**

2.0.0 第一期：传输层内迁，终结 v1/v2 双轨。详见 `docs/specs/2026-08-23-v2.0.0-platform-refactor-design.md` 与 `docs/plans/2026-08-23-v2.0.0-p1-session-core.md`。

- **移除 Matrix/Tuwunel 全家（BREAKING）**——matrix-js-sdk、Conduit 子进程管理、bot 注册器、Space/room 关联列全部删除；升级采用完全重新开始（D5 决策），不做旧数据兼容
- **sessions 数据模型（migration v23）**——`sessions` / `session_members` 表取代 Matrix room；workspace 隔离 = 外键；会话级配置（工具上限/冲突策略）存 `settings_json`
- **传输层内迁**——SessionService + 进程内事件分发（RouterService 切输入源），消息/委派不再经过外部协议服务器
- **task_reply 回传链接线**——删除 v1 长存进程双轨，dispatch/task_reply 走内部事件桥，子 agent 结果可靠回传
- 待办：P4 局域网联网、P5 升级体验

**v1.7.0 — Released**

v1.7 资源库重构——把 v1.6 的 Marketplace + 底部"自定义资源"折叠区统一为一个"资源库"视图，三类 source（系统预置 / 我的上传 / 网络资源）通过双层 tab 正交过滤。数据模型 `ResourceItem` 取代 `MarketplaceItem` / `InstalledSkill` / `RegisteredMcp` 三结构；IPC 统一为 `resource:list` / `resource:getDetail` / `resource:install` / `resource:delete` 四通道。架构预留 `source='p2p'` 字段，v2 agent 互联时直接接入。详见 `docs/specs/2026-08-11-v1.7-resource-library-design.md`。

**v1.6.x** v1.6 Agent 能力配置 + Marketplace 自定义上传——修复关键 bug（`merged.tools` 丢失导致能力白名单形同虚设），新增三层能力配置 UI（DefinitionEditor 编辑 Layer 1 + AddToWorkspaceDialog/WorkspaceAgentsPanel 做 Layer 3 per-assignment override）+ Marketplace 自定义入口（MCP 表单注册 + Skill zip 上传）；v1.6.2 扩展 zip-uploader 支持三种 zip 结构 + 一个 zip 多 skill 批量安装 + 自动忽略 macOS/Windows 元数据。详见 `docs/specs/2026-08-11-v1.6-capability-config-design.md` 和 `CHANGELOG.md`。

## 特性

### Workspace 管理
- 创建 / 删除 / 重命名 workspace
- 每个 workspace 绑定本地目录（`~/...` 或自定义路径）
- 自动 `git init` + 初始 commit，作为 agent 写操作的版本基线
- 所有文件访问走 `WorkspaceFS` 抽象层，禁止越界

### Agent
- YAML 声明式定义（frontmatter + prompt body）
- v25：去编排——agent 定义全局化（无 workspace 隔离），加入工作空间即成员（无 role/父子链，同 ws 同 def 唯一）；多 agent 协作由「团队」（leader + 成员）承担，leader 在多成员会话中自动获得 `dispatch` 派发权
- v25：每个 workspace 可指定唯一「默认会话 agent」（⭐ 标记），支撑快速会话一键直达
- 内置 Anthropic / OpenAI 两个 LLM provider；provider 引用模式（baseUrl + keychain）
- 工具系统：v1.5 内置 7 类 24 个工具（文件/搜索/Shell/Git/Web/Todo/LSP）+ MCP 工具；v1.6 三层能力配置（Definition 默认集 + workspace 分配 + 成员级 add/remove delta）
- 多 agent 协作：团队 leader 通过 `dispatch` 派发子任务，子任务通过 `task_reply` 回传结果
- 完整运行历史与工具调用审计

### 会话（2.0.0-p1 前为 IM）
- 2.0.0-p1 起传输层内迁：SQLite sessions 表 + 进程内事件分发，本地零外部依赖（Matrix/Tuwunel 已移除）
- v25：会话双类型——「快速会话」（免弹窗直达默认 agent；首条消息截断命名 + LLM 异步生成标题）与「协作会话」（指定单 agent 或团队，团队建会时快照展开成员）；workspace 级「团队会话」概念退役
- v25：接待路由按会话成员快照——非 @ 消息由 is_leader 成员接待，@ 成员直答；目标成员离线自动拉起
- Agent 在会话内可被 `@` 唤起，v1.4 流式回复（thinking 折叠 + 工具调用卡片 + Markdown 逐字输出）
- v1.4 多 agent 委派嵌套展示：dispatch/task_reply 不再作为独立消息，嵌套在 PM 气泡的 DispatchChip 内
- v1.4 可配置工具调用上限：全局默认 + 会话级覆盖 + per-task 重置（0-无限）
- 客户端渲染支持代码块、表格、链接、引用块

### MCP（Model Context Protocol）
- stdio transport
- 共享进程池：相同 server 配置只启一个进程，工具调用并发安全
- 配置、热重载、生命周期管理在主进程完成

### Skill
- 渐进式披露：`SKILL.md` frontmatter 元数据始终可用，正文按需加载到上下文
- 内置 skill：git-workflow、code-review、debugging、markdown-format

### 资源库（v1.7 重构）
- 三类 source 统一管理：系统预置 / 我的上传 / 网络资源（v2 加 P2P 共享）
- 主网格双层 tab（类型 × 来源）+ 搜索 + 统一 ResourceCard 卡片
- 「+ 添加资源」下拉菜单：创建 Agent / 添加 MCP / 上传 Skill
- 取代 v1.6 Marketplace + 底部"自定义资源"折叠区

### 安全
- `WorkspaceFS`：文件工具（read / write / edit / mkdir / rm / mv 等）的所有路径经过验证，禁止 `..` 越界与符号链接逃逸
- bash 工具：v2.0.0 起从 builtin agent 默认工具集移除，需经工作空间能力面板显式开启；v2.4.0 起接入 OS 级沙箱（macOS Seatbelt / Linux bwrap；strict 默认不可用即拒绝，permissive 可降级）
- 进程沙箱：renderer 进程禁用 Node.js 集成 + contextIsolation
- 审计日志：每次工具调用写入 SQLite，UI 可查询
- Git policy：agent 写文件走 `git commit`，可一键回滚
- OS 级沙箱：v2.4.0 已接线（`sandbox/` 模块，bash 工具经 `resolveShellSpawn` 三态决策包裹；Windows 无 OS 沙箱走 PowerShell plain 路径）

## 前置依赖

- **Node.js 20 LTS**：Node 26+ 会破坏 `better-sqlite3` 原生编译（`ERR_DLOPEN_FAILED`）。容器默认是 Node 26，先 `nvm use 20`。
- **pnpm 9+**
- 平台：macOS（arm64 / x64）/ Linux（x64）/ **Windows（实验性——代码层硬化 + 打包就绪，真机验收进行中，安装见下方「Windows 安装说明」）**

## 安装

```bash
git clone <repo>
cd momo-studio
nvm use 20
npx pnpm@9.0.0 install
```

### Windows 安装说明（实验性）

Windows 支持自 v2.10.0 起进入「代码层硬化 + 打包就绪」状态，真机验收进行中——遇到问题请提 issue。安装包为 NSIS 安装器（`electron/dist-installers/` 下 `*-setup.exe`，per-user 安装，无需管理员权限）。

- **SmartScreen 警告（未签名，属常态）**——安装器当前无代码签名证书，首次运行会弹「Windows 已保护你的电脑」：点「更多信息」→「仍要运行」即可继续安装。有证书前该警告每次都会出现，不是安装包损坏。
- **代码签名（待接入）**——采购证书后在 `electron/package.json` 的 `win` 段写 `signtoolOptions: { certificateFile, certificatePassword }`，或经环境变量 `CSC_LINK` / `WIN_CSC_KEY_PASSWORD` 注入——构建时自动签名，SmartScreen 警告随之消除。注意：顶层 `win.certificateFile` / `win.certificatePassword` 写法**在 electron-builder v26 已不生效**（实现只读 `signtoolOptions` 嵌套值；d.ts 里的顶层声明是 legacy 残留，勿被误导）。
- **PowerShell 执行策略**——bash 工具的 Windows 路径走 PowerShell plain 模式（v2.4 起）。若系统 `ExecutionPolicy=Restricted`，首启会出现授权指引卡：按卡内指引以当前用户作用域放开（`Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned`），或如无 bash 工具需求可忽略。
- **长路径**——工作区路径超过 260 字符时 Node/Electron 常规读写可过，但 agent 的 git 操作需仓库启用 `core.longpaths=true`（`git config --global core.longpaths true`）。

## 开发

```bash
nvm use 20
npx pnpm@9.0.0 dev
```

## 测试

```bash
nvm use 20
npx pnpm@9.0.0 typecheck       # electron + renderer 双 workspace 严格类型检查
npx pnpm@9.0.0 test            # 单元测试（electron + renderer 全部）
npx pnpm@9.0.0 e2e              # 端到端集成测试（需要已构建应用，慢）
```

### 单独跑某个 workspace

```bash
npx pnpm@9.0.0 --filter momo-studio-electron test
npx pnpm@9.0.0 --filter momo-studio-renderer test
```

## 打包

```bash
nvm use 20
npx pnpm@9.0.0 build                       # 先构建 renderer + electron
NODE_OPTIONS=--max-old-space-size=4096 npx pnpm@9.0.0 build  # 容器/低内存环境防 Vite Monaco OOM（2.1 拆 chunk 根治）
npx pnpm@9.0.0 --filter momo-studio-electron dist  # electron-builder 产出 .dmg / .AppImage / .deb
```

产物输出到 `electron/dist-installers/`。

详细发布流程见 `docs/dev/release.md`。

## 项目结构

```
electron/      Electron 主进程（CommonJS, Node.js）
renderer/      React UI（ESM, Vite）
resources/     静态资源（marketplace catalog 等）
tests/         Playwright 端到端测试
docs/
  specs/       设计文档
  plans/       实施计划
  dev/         开发者指南（setup / release / rules）
```

两个 workspace 包名：`momo-studio-electron`、`momo-studio-renderer`（**无 `@` scope**）。根包名 `momo-studio`。

## 研发演进路线图

### v1.0 — 单机自洽 ✅ 已发布

本地优先的 agent 编排平台。一个用户、一台机器、开箱即用。

- ✅ Electron + React + Tuwunel 一体化桌面应用
- ✅ Workspace 管理（目录映射 + git init）
- ✅ Declarative agent（YAML manifest + LLM chat loop + 工具执行）
- ✅ 主子 agent 调度（IM dispatch/task_reply 协议）
- ✅ MCP stdio transport（共享进程池）
- ✅ Skill 渐进式披露（SKILL.md 三层加载）
- ✅ IM（Matrix /sync + Markdown + @mention）
- ✅ Marketplace 浏览/搜索/安装
- ✅ 安全（WorkspaceFS + sandbox + 审计 + Git policy + 崩溃重启 + LLM 重试）

### v1.1 — 打磨与补全 ✅ 已发布

不引入新架构，聚焦 v1 遗留项和体验优化。

- ✅ 会话房间新增 / 重命名 / 自适应解散（团队群受保护）
- ✅ 群成员查看（⭐自己 / 🤖bot / 管理 徽标）
- ✅ 设置页分类导航 + 全局模型供应商注册表（baseUrl + apiKey 入 keychain）
- ✅ Agent 创建后可编辑（apiKey 独立更新；保存后停止运行中实例并提示重启）
- ✅ 文件 CRUD（新建 / 改名 / 删除 / 移动；走 WorkspaceFS 路径防御）
- ✅ 团队群自动调度（主 agent 默认接待非 @ 消息；@ 别人不插嘴）

### v1.2 — 功能补全 + IM 体验优化 ✅ 已发布

**Agent 编排**

- ✅ 主/子 agent 编排 UI（委派调度）— runtime subAgents 传递修复 + auto-start 重启重建 + slug→UUID 解析 + IPC 角色/父 agent 校验 + 编排视图（树形展示 main→sub 关系）+ AddAgentDialog 角色选择 + AgentList 角色徽标分组 + 移除级联

**质量打磨**

- ✅ keychain slot helper 去重（`llmApiKeyRef` 统一使用）
- ✅ modelBaseUrl 往返保真 + stopRunningInstances 补测
- ✅ 文件树折叠 localStorage 持久化 + 协调 agent 自动重启
- ✅ setCoordinator / 文件 CRUD 异常处理一致化
- ✅ assignMain 重复安装守卫 + 编排视图孤儿子 agent 可见性
- ✅ `.gitignore` 裸 `docs` 清理 + CHANGELOG.md

**Dev 运维**

- ✅ Dev 模式 agent 行为日志 — `trace()` 函数 + 14 个插桩点（消息接收/LLM 调用/工具执行/dispatch/reply）
- ✅ LLM 请求超时 90s → 300s；dispatch 渐进式超时 3min→6min→fail

**IM 会话体验**

- ✅ 卡片归属与对话化视觉 — 抽取 `MessageFrame` 共享外壳（头像+名字+左右对齐），三类消息统一外壳；TaskReplyCard 补齐 agent 归属；DispatchCard 紧凑化
- ✅ 缩窗布局响应式修复 — LeftRail 永不压扁；RoomList/MembersPanel 可缩；MessageList 禁水平滚动
- ✅ Tailwind 任意值 class bug 规避 — 改用 inline style 约束宽度
- ✅ IM 工具条 + 成员按需浮层 — InputToolbar（成员切换按钮 + 预留扩展位）；MembersPanel 改 absolute 浮层（backdrop 关闭）；移除上线消息，改为在线/离线 badge

**测试覆盖**

- ✅ renderer 全套 105 测试（含 MessageFrame/DispatchCard/TaskReplyCard/MessageBubble/InputToolbar/MembersPanel 共 40 个 IM 组件测试）

### v1.3 — Agent 定义/分配解耦 + Workspace 隔离 ✅ 已发布

v1.2 最大架构债务：`agent_definitions` 表把「agent 是什么」与「在某 workspace 怎么用」混在一起，定义全局共享无 workspace 边界。v1.3 彻底解耦。

**架构重构（Migration v12）**

- ✅ AgentDefinition 删 `type` / `parentAgentId` / `model.provider` / `model.baseUrl`；加 `workspaceId`（NULL=全局）/ `modelProviderId`（引用供应商表）/ `modelName`
- ✅ AgentAssignment 加 `role`（standalone/main/sub）/ `parentInstanceId`（同 ws 父 assignment）/ `hasApiKeyOverride`（DB 标志）
- ✅ 数据回填：role 从老 def.type 推导；parent_instance_id 从老 def.parentAgentId + 同 ws 父 assignment 推导
- ✅ Keychain 新增 `agent.<instanceId>.api_key_override`（可选 per-assignment override）

**角色与父子关系剥离**

- ✅ 彻底从 definition 剥离到 assignment — 同一 agent def 在不同 workspace 可当不同角色
- ✅ `assignAgentToWorkspace` 接 role + parentInstanceId（校验循环引用）
- ✅ `updateAssignmentRole` 支持运行时改角色（从 main 改非 main 时级联停止 subs）
- ✅ `deleteDefinition` builtin 不可删；custom 级联清理 assignment + keychain + def

**模型供应商化**

- ✅ AgentDefinition 引用 `model_providers` 表（不再硬编码 platform/model/baseUrl）
- ✅ `resolveApiKey`：override ?? provider key（keychain 解析）
- ✅ `createLLMProvider` 按 baseUrl 自动检测 platform（anthropic.com → anthropic，其余 → openai 兼容）
- ✅ 现有 assignment 强制重配 provider（model_provider_id 留 NULL，启动时拒绝）

**自定义 Agent Workspace 隔离**

- ✅ 创建自定义 agent 时选 scope（默认 workspace-scoped，可选全局共享）
- ✅ `listAgentDefinitions(workspaceId?)` 按 `workspace_id IS NULL OR = ?` 过滤
- ✅ 切换 workspace 时 Agent 库只显示 global + 当前 ws scoped + builtin
- ✅ 删除 workspace 级联删除 scoped custom def（global 不受影响）

**Builtin 加载策略**

- ✅ YAML 仍可写 `type` / `parentAgentId` / `model.provider`（向后兼容）
- ✅ 不写入 DB（schema 已删除）；存内存 `builtinSuggestions` Map
- ✅ UI 添加 builtin 时预填建议角色 + platform

**UI 双 Tab 重构**

- ✅ `AgentsView`：Tab 容器（本工作空间 / Agent 库）
- ✅ `WorkspaceAgentsPanel`：按 main→sub 树形分组 + 孤儿 sub 警告 + 启停 + 移除 + 协调设置
- ✅ `AgentLibrary`：builtin/全局/工作空间三组 + 搜索 + 配置/编辑/删除
- ✅ `DefinitionEditor`：三模式（create/edit/configure builtin）
- ✅ `AddToWorkspaceDialog`：选 def + role + parent + apiKeyOverride
- ✅ `AssignmentRoleEditor` / `AssignmentApiKeyEditor`：运行时改角色/密钥

**IM 房间按 Workspace 隔离**

- ✅ `getRoomsForWorkspace(workspaceId?)`：按 Matrix Space `m.space.child` 成员过滤
- ✅ 新建房间自动加入当前 workspace 的 Space
- ✅ 切换 workspace 时 IM store 重置（rooms/messages/activeRoom 全清）

**工作空间与编辑器体验**

- ✅ 新建工作空间原生目录选择对话框（Electron `dialog.showOpenDialog`）
- ✅ 全量中文化（7 处 workspace → 工作空间 + Onboarding 英文翻译）
- ✅ Monaco 编辑器中文 locale（官方 NLS 本地打包，离线优先）
- ✅ 文件树增强（单击文件夹选中 + 目录级右键新建 + 空白区操作 + 工具栏跟随选中目录）
- ✅ 文件树选中状态互斥（文件↔文件夹）+ 根目录可选中

**测试覆盖**

- ✅ Electron 305/308（3 个 conduit flaky 预存）；Renderer 131/131；Typecheck 双 clean
- ✅ Migration v12 回填测试（7 用例，含孤儿 sub 边界）
- ✅ crud assignment 测试（15 用例：role/parent/循环引用/级联删除）
- ✅ builtin suggestions 测试（7 用例：v1.3 schema + suggestions Map）
- ✅ agent.store 测试（11 用例：v1.3 新签名 + 新 actions）

**待办基础设施项**

- 🔲 重启自动恢复 agent runtime（持久化运行状态）
- 🔲 打包后 YAML/migration 路径适配
- 🔲 e2e 测试跑通（xvfb + 真实 LLM API key）
- 🔲 Windows / macOS 沙箱实测

### v1.4 — 流式回复 + 可配置工具上限 + 委派嵌套 ✅ 已发布

v1.3 最大体验短板：agent 回复无流式反馈、工具调用上限硬编码 10 次、多 agent 委派场景消息混乱。v1.4 全面优化会话体验。

**流式回复（双通道架构）**

- ✅ LLM Provider `chatStream` — OpenAI/Anthropic SSE 流式解析，含 thinking 捕获（reasoning_content / thinking_delta）
- ✅ 双通道传输 — IPC 实时推送 chunk（< 100ms）+ Matrix 持久化最终消息（含 thinking + tool_calls 元数据）
- ✅ 流式气泡 — AgentStreamBubble：thinking 折叠区 + 工具调用卡片 + Markdown 正文 + 状态栏 + 停止按钮
- ✅ 中断重置 — 用户发新消息或点停止 → AbortController 跨进程中断 → 新任务新预算
- ✅ 非 SSE 降级 — 不支持流式的 provider 自动降级到 `chat()` 一次性返回
- ✅ PDU 渐进式截断 — 最终消息超 55KB 时逐级削减（工具字段 → thinking → 删除 thinking → 删除 tool_calls），body 永远保留

**可配置工具调用上限**

- ✅ Migration v13 — `room_settings` 表（房间级 `max_tool_calls`，NULL=继承全局）
- ✅ 全局默认 — Settings → 会话设置 → 工具调用上限（-1=无限 / 0=禁用 / N=上限）
- ✅ 房间级覆盖 — 创建房间时选 + 房间头部徽标修改
- ✅ Per-task 重置 — 每条用户消息 = 新任务 = 新预算池
- ✅ 共享预算 — main + sub agent 共用，dispatch 传 `tool_budget`，task_reply 回 `tool_calls_used`
- ✅ 预算注入 system prompt — agent 感知预算上限自行规划

**多 agent 委派嵌套展示**

- ✅ DispatchChip — 委派 chip（4 状态：排队/执行中/完成/失败），点击展开查看子 agent 工作
- ✅ SubAgentSection — 嵌套工作区（thinking + 工具调用 + Markdown 正文）
- ✅ 并行委派 — 多 chip 纵向堆叠，各自独立状态 + 进度指示器
- ✅ 消息过滤 — dispatch/task_reply/子 agent 消息不作为顶层独立消息（仅嵌套在 PM 气泡内）
- ✅ 历史还原 — 重启后从 Matrix 历史重建子 agent StreamState（按 `parent_stream_session_id` 关联）
- ✅ 中断传播 — PM abort 自动传播到子 agent（`streamChildren` 映射）

**滚动管理**

- ✅ 智能自动滚动 — 仅在用户处于底部 120px 范围内时跟随；滚向上查看历史不被干扰
- ✅ 瞬移滚动 — `behavior: 'auto'` 消除 smooth 动画叠加抖动

**测试覆盖**

- ✅ Electron 352/355（3 个 conduit flaky 预存）；Renderer 232/232；Typecheck 双 clean
- ✅ Migration v13 测试 + settings CRUD（12 用例）
- ✅ LLM Provider chatStream 测试（8 用例：OpenAI/Anthropic SSE + 降级 + abort）
- ✅ Runtime streaming 测试（20 用例：chunk 序列 + 预算 + abort + dispatch 嵌套）
- ✅ Stream store 嵌套测试（10 用例：dispatchChildren + parentStreamSessionId 关联）
- ✅ DispatchChip / SubAgentSection / AgentStreamBubble 组件测试
- ✅ 中断传播测试（7 用例：嵌套映射 + abort 传播 + 清理）

**待办基础设施项**

- 🔲 重启自动恢复 agent runtime（持久化运行状态）
- 🔲 e2e 测试跑通（xvfb + 真实 LLM API key）
- 🔲 Windows / macOS 沙箱实测

### v1.5 — 内置工具库扩充 ✅ 已发布

v1.4 之前 agent 仅 3 个工具（read/write/list）。v1.5 系统性补全 7 类共 24 个工具，对标 opencode 工具集水平。

**文件操作（8 工具）**
- ✅ read_file / write_file / list_files（v1.4 已有，搬迁）
- ✅ edit_file（str_replace 唯一匹配 + 失败回写文件头）
- ✅ mkdir / rm / mv / exists（暴露 WorkspaceFS 能力）

**搜索（2 工具）**
- ✅ grep（JS 正则，50 条上限）
- ✅ glob（文件名匹配，200 条上限）
- ✅ 自动加载 workspace .gitignore（mtime 缓存）

**Shell（1 工具）**
- ✅ bash（workspace 内自由 shell）
- ✅ 黑名单：rm -rf /、mkfs、dd、fork bomb、关机、git commit
- ✅ 环境变量白名单（不传 API key/token）
- ✅ 10KB 输出截断 + 30s 超时

**Git（9 工具）**
- ✅ status / diff / log / show（只读）
- ✅ add / branch / checkout / stash（写）
- ✅ commit 走 GitPolicy 三层校验（allowAgentCommits + 分支保护 + message pattern）
- ✅ 拦截 -c key=val 防绕过身份追踪
- ✅ 不提供 push/merge/reset（保留给人）

**Web（1 工具）**
- ✅ webfetch（HTTP 强制升级 HTTPS，HTML→Markdown）
- ✅ CSS 选择器提取
- ✅ 双阶段截断（100KB 原始 + 50KB 转换）

**Todo（1 工具）**
- ✅ todowrite（全量替换协议，会话内 store）
- ✅ UI 可见（TodoSection 嵌入 AgentStreamBubble/SubAgentSection）
- ✅ Matrix 持久化 + 重启还原

**LSP（2 工具，仅 TS/JS workspace）**
- ✅ lsp_diagnostics（错误/警告）
- ✅ lsp_find_references（含定义）
- ✅ typescript-language-server 集成
- ✅ 懒启动 + 5 分钟闲置 shutdown

**架构重构**
- ✅ 工具按类别拆 8 模块 + shared 层（output-truncate/audit/permission）
- ✅ 统一 ToolModule 接口 + tools/index.ts 注册中心
- ✅ tool-permission 扩展通配符（lsp_* / git_* / mcp:github:*）
- ✅ 沿用 v1.4 三层安全（WorkspaceFS + tool-permission + GitPolicy）

**测试覆盖**
- ✅ Electron 全套测试通过（108+ 新增单元测试 + 集成测试）
- ✅ Typecheck 双 clean
- ✅ 三阶段迁移（搬迁 → file-tools → 其他模块递增），每阶段独立可测

### v1.6 — Agent 能力配置 + Marketplace 自定义上传 ✅ 已发布

v1.5 把工具库扩到 24 个后暴露三处断裂：(1) 关键 bug——`buildSpawnOpts` 把 `mergeCapabilities` 的 `merged.tools` 字段完全丢弃，`RuntimeConfig.allowedTools` 永远 undefined，permission 层走空数组全放行，**所有 agent 实际能用全部 24 个工具**，能力白名单形同虚设；(2) `DefinitionEditor` 自定义 agent 表单完全没有 defaultTools/defaultMcps/defaultSkills 编辑入口；(3) Marketplace 只能浏览远程 catalog，没有自定义注册入口（后端 IPC 早已存在但 UI 没按钮调用）。v1.6 系统性补齐能力配置能力。

**关键 Bug 修复**
- ✅ `buildSpawnOpts` 把 `merged.tools` 注入 `RuntimeConfig.allowedTools`——之前完全丢弃导致 permission 全放行
- ✅ 合并函数 `mergeCapabilities` 扩展 Layer 3（assignment deltas add+remove）正确产出 `tools`/`mcps`/`skills`

**三层能力配置架构**
- ✅ Layer 1（Definition）— `DefinitionEditor` 加 Tab + 类别分组 checkbox，编辑 defaultTools / defaultMcps / defaultSkills
- ✅ Layer 2（Assignment）— builtin/自定义 agent 均可参与
- ✅ Layer 3（Override）— `AddToWorkspaceDialog` 与 `WorkspaceAgentsPanel`「调整能力」按钮做 per-assignment add+remove delta（`AssignmentCapabilitiesDialog`）
- ✅ 新建 custom agent 默认勾选"安全最小集"（read/write/list/edit/grep/glob/todowrite + dispatch-if-main）

**Marketplace 自定义入口**
- ✅ 顶部「+ 添加 MCP」——`RegisterMcpDialog` 表单式注册（name/command/args/env），写入 `mcp_definitions` 标记 `source='custom'`
- ✅ 顶部「+ 上传 Skill」——`UploadSkillDialog` 本地 zip 包上传，解压校验 SKILL.md，写入 skills 目录
- ✅ 底部自定义资源管理区——已注册自定义 MCP / 已上传 Skill 可删除

**v1.6.2 zip-uploader 扩展**
- ✅ 三种 zip 结构：扁平（`SKILL.md` 在根目录）/ 单子目录包裹 / 多子目录批量（一个 zip 装多个 skill）
- ✅ 自动忽略 macOS/Windows 元数据（`__MACOSX/`、`.DS_Store`、`._*`、`Thumbs.db`、`*.bak`）
- ✅ slug 决策优先级：frontmatter.name > zip filename（扁平）/ 子目录名（包裹）
- ⚠️ Breaking change：IPC `skill:uploadZip` 返回类型从 `{ slug, description }` 改为 `UploadedSkill[]`

**CapabilityConfig 增强（v1.5 兼容）**
- ✅ builtin agent（不可编辑 Layer 1）显示「编辑 def」「调整实例能力」两个增强按钮入口
- ✅ v1.5 升级路径——旧 builtin agent 行为不变（仍 24 工具全开，defaultTools 扩展为全集）

**Migration v16**
- ✅ 新增 `agent_assignment_capabilities` 表（Layer 3 deltas：add_tools/remove_tools/add_mcps/remove_mcps/add_skills/remove_skills）
- ✅ `mcp_definitions` 加 `source`（builtin/custom/marketplace）+ `installed_at` 列
- ✅ 三个 builtin YAML `defaultTools` 扩展为 24 工具全集（保持 v1.5 行为）
- ✅ builtin default_tools 修复——Migration 同步 builtin YAML 到 DB（之前 DB 里 builtin def 的 default_tools 为空）

**测试覆盖**
- ✅ Electron 534/534 passed（81 test files）；Renderer 341/341 passed（35 test files）；Typecheck 双 clean
- ✅ Migration v16 测试 + assignment-capabilities CRUD（含 add/remove delta 边界）
- ✅ mergeCapabilities Layer 3 合并测试（含 builtin 全集 + delta 叠加）
- ✅ buildSpawnOpts 注入 allowedTools 回归测试（防止 bug 复发）
- ✅ DefinitionEditor / AddToWorkspaceDialog / AssignmentCapabilitiesDialog / RegisterMcpDialog / UploadSkillDialog / CapabilityConfig 组件测试

### v1.7 — 资源库（取代 Marketplace）✅ 已发布

v1.6 把自定义上传的 MCP / Skill 单独放在 Marketplace 底部"自定义资源折叠区"——形成两套 UI：marketplace 装的资源在主网格，自定义上传的在折叠区，用户体验割裂。v1.7 重新定位整个功能：**"商场"改为"资源库"**，统一管理 agent / mcp / skill 三类共享资源 + 三类 source。

**架构重构（Breaking Change）**
- ✅ MarketplaceView → ResourceLibraryView——UI 重命名 + 路由切换
- ✅ `ResourceItem` 统一数据模型——取代 MarketplaceItem / InstalledSkill / RegisteredMcp 三结构
- ✅ 资源 ID 命名约定 `${source}-${type}-${slug}`——全局唯一 + 可路由（parseResourceId 反解三元组）
- ✅ 取消底部"自定义资源"折叠区——custom 资源直接出现在主网格（按 source 过滤）

**IPC 统一（4 通道）**
- ✅ `resource:list` / `resource:getDetail` / `resource:install` / `resource:delete`——取代 `mcp:listRegistered` / `mcp:deleteRegistered` / `skill:listInstalled` / `skill:deleteCustom` / `marketplace:*` 多套通道
- ✅ listResources 三源合并（builtin + marketplace + custom）+ filter 短路 + fetchCatalog 失败容错
- ✅ delete 按 source 路由（builtin 抛错 / marketplace uninstall / custom 按 type 路由）

**UI 双层 Tab**
- ✅ 类型 tab（全部/Agent/MCP/Skill）+ 来源 tab（全部/系统预置/我的上传/网络资源）AND 过滤
- ✅ 单按钮「+ 添加资源 ▼」下拉菜单——创建 Agent / 添加 MCP / 上传 Skill
- ✅ SourceBadge 组件（4 source 颜色 + 文案）
- ✅ ResourceDetail 按 source 分支详情面板
- ✅ ResourceCard 统一卡片（install/removable 状态 + 删除/安装按钮）

**直接删除（不保留兼容）**
- ✅ `renderer/src/components/marketplace/` 目录（MarketplaceView / ItemCard / ItemDetail）
- ✅ `renderer/src/stores/marketplace.store.ts`
- ✅ preload 6 个废弃绑定 + marketplace 命名空间
- ✅ types.d.ts: RegisteredMcp / InstalledSkill 类型 + ApiSurface 对应字段

**架构预留**
- ✅ `source='p2p'` 字段——v2 agent 互联时加 `listP2PResources()` 即可
- ✅ ResourceItem.source enum 四值（builtin / marketplace / custom / p2p）

**测试覆盖**
- ✅ Typecheck 双 clean（electron + renderer）
- ✅ resource/library 三源合并 + filter 短路 + fetchCatalog 容错测试
- ✅ SourceBadge / ResourceCard / ResourceDetail / AddResourceMenu / ResourceLibraryView 组件测试
- ✅ resource.store 双层 tab + 安装/删除流程测试

**待办基础设施项**

- 🔲 重启自动恢复 agent runtime（持久化运行状态）
- 🔲 e2e 测试跑通（xvfb + 真实 LLM API key）
- 🔲 Windows / macOS 沙箱实测

从"单机工具"进化为"团队平台"。

- 🔲 **多 peer P2P 协作** — 多用户通过协调服务器互联，共享 workspace
- 🔲 **Git remote 同步** — workspace 文件通过 bare repo 跨 peer 同步
- 🔲 **跨 peer agent 调度** — @ 对方的 agent，任务经 Matrix 路由
- 🔲 **Agent SDK** — TypeScript/Python 自定义 agent 生命周期
- 🔲 **External runtime 桥接** — 接入 OpenCode / Codex / Claude Code
- 🔲 **MCP HTTP/SSE transport** — 远端 MCP server 接入
- 🔲 **Marketplace 上架** — 用户上传 agent/mcp/skill 包
- 🔲 **E2E 加密** — 人 ↔ 人 DM 加密
- 🔲 **消息搜索** — 全文检索 Matrix 历史
- 🔲 **Electron 主进程 ESM 转换** — 解除 matrix-js-sdk v31 锁定

### v2.1 — 效率增强 🔲 概念阶段

- 🔲 分支工作流（agent 工作在独立 branch，PR 式合并）
- 🔲 Agent 并发多任务（内部 task queue）
- 🔲 Token 配额管理
- 🔲 LSP 集成（Monaco 编辑器语言服务）
- 🔲 协作实时编辑（CRDT）
- 🔲 e2e 套件重写（替换 v1.x 残留的 Conduit/Matrix 场景用例）
- ✅ OS 级沙箱接线（v2.4.0 完成——bash 工具经 `resolveShellSpawn` 接入 Seatbelt/bwrap）
- 🔲 p2p 私钥入 keytar（当前 Ed25519 私钥落盘位置待硬化）
- 🔲 LAN 帧加密或对应设计稿

### v3.0+ — 生态扩展 🔲 远期愿景

- 🔲 Federation（跨 homeserver 联邦）
- 🔲 私有 Marketplace + 付费/计费
- 🔲 Headless agent runner（7×24 服务端）
- 🔲 移动端（iOS/Android 只读 + IM）
- 🔲 NAT 打洞（peer 直连）
- 🔲 Agent 自动能力发现 + 自定义代码 hook

### 技术债务跟踪

| 问题 | 影响 | 计划解决版本 |
|---|---|---|
| **Tailwind 任意值 class 不生成 CSS** | 已定位根因：动态拼接 class 不可见（静态书写正常）；规范已禁动态拼接 | 已于 v2.1 P0 勘正 |
| ~~**OS 级沙箱简化实现**~~ | **v2.4.0 已接线**——bash 工具经 `resolveShellSpawn` 三态决策接入 Seatbelt/bwrap；Windows 无 OS 沙箱走 PowerShell plain 路径 | ~~v2.1~~ 已完成 |
| Marketplace 无签名验证 | 不可信包风险 | v2.0 |
| ~~**model_providers 表无 platform 字段**~~ | **v24 已加 platform 列 + CHECK 约束 + 设置页显式下拉**；运行时接线 P3 已完成（`spawn-helpers.ts` 显式透传 `provider.platform`） | ~~P3~~ 已完成 |
| **StreamState 内存累积** | 会话结束后 StreamState 不清理（保留完整展示），长期使用内存增长 | v1.5 加房间切换/定期清理 |
| ~~**provider.platform 运行时接线**~~ | **P3 已完成**——`spawn-helpers.ts` 显式透传 `provider.platform` 到 `createLLMProvider`，设置页下拉选择生效，baseUrl 启发式检测退役为缺省回退 | ~~P3~~ 已完成 |
| ~~**provider testConnection 空 model 兜底不统一**~~ | **P3 已完成**——`gpt-3.5-turbo` 硬编码兜底删除，空 model 源头拦截返回结构化提示，两路径行为统一 | ~~P3~~ 已完成 |

## 已知限制

- Marketplace 当前只支持 zip 包 + checksum 校验，未做签名验证（v2）。
- **Tailwind 任意值 class 仅静态书写时保证生成**——运行时动态拼接的 class（模板字符串插值）JIT 扫描器不可见、对应 CSS 不生成（v2.1 P0 探针实测结论）。静态任意值（`max-w-[70%]`、`text-[13px]`）可正常使用；规范见 `docs/dev/design-system.md` §5。
- **2.0.0 升级为完全重新开始**——旧 v1 库不做数据迁移（D5 决策）；P5 已实现自动导出（Markdown/JSON 落 `upgrade-export-<时间戳>/`）+ 备份重命名（`state.db.legacy-v1.bak`）+ 首启一次性提示。历史 session/agent 定义需手动导入新库（参考 P5 实施计划）

## 许可

Apache-2.0。