# 研发规则详版——2.0.0 主机验收 8 个 P0 完整复盘

日期：2026-08-25
配套：`.opencode/skills/momo-{debug,test,boundary}-rules`（场景化自动加载版）；`AGENTS.md` 研发红线

本文是完整案例复盘，供人阅读。每个案例按「症状 → 排查路径 → 根因 → 修复 → 沉淀规则」组织。

---

## 模式一：Mock 保真度缺口（4/8）

### P0-1 错误路径裸调用崩溃

- **症状**：会话发消息 agent 永不回复，日志只有一句 `task-config 处理失败: Cannot read properties of undefined (reading 'connected')`，无堆栈。
- **排查**：全仓 grep `.connected` 排除自有代码 → fork 探针证明 Electron fork 链路健康 → 拷 dist 产物打补丁（err.message → err.stack）重跑 harness 拿到完整堆栈 → 定位 `sendTaskEndAndExit`。
- **根因**：`const send = process.send; send(...)` 解构裸调用——Node 内部实现读 `this.connected`，严格模式 `this=undefined` 直接抛 TypeError。单测 mock 是不读 this 的普通函数，从未暴露。
- **修复**：方法调用形式 `process.send(...)`（保留 flush-then-exit）。
- **规则**：mock 方法型 API 必须仿真 this 绑定（momo-test-rules #1）。

### P0-5 实时流式内容全部丢失

- **症状**：实时只有「流式中」状态条，重启后完整富内容（用户 DOM 对比实证）。
- **排查**：数据在 DB（重启可渲染证明）→ 嫌疑锁定实时推送链 → 发现 event-buffer onFlush 传 `id:'buffered'` 占位符，注释还写着「调用方不应该依赖 id」——但 renderer 恰恰按 id 去重。
- **根因**：双层叠加：主进程给占位 id（全部事件同一个 id）+ renderer 按 id 去重 → 第一批之后所有实时事件被误判重复静默丢弃。
- **修复**：`insertEventBatch` 返回真实 id 行 + 去重键改桶内 seq（对 id 方案健壮）。
- **规则**：断言覆盖生产消费的字段；防御性修复（双层都修）（momo-test-rules #2）。

### P0-3 / P0-4（同族）错误路径与空输入

- **P0-3**：聚合器 `case 'final': status = 'done'` 硬编码——`final{status:'failed', error}` 的真实状态与错误文本被吞，失败流显示为空气泡。
- **P0-4**：`hydrateFromEvents` 对零事件消息也写入 streams——`aggregateEvents([])` 默认 `status:'streaming'`，用户消息被灌幽灵流式状态，重启后全部不可见。
- **规则**：错误路径/空输入必须有专项用例；禁止错误处理里硬编码状态（momo-test-rules #3）。

---

## 模式二：跨边界契约漂移（4/8）

### P0-7 dispatch 嵌套 ID 断链

- **症状**：chip 出现（aria-expanded=true）但展开区永远空。
- **排查**：容器 harness 生成数据 + 直查 DB——chip 查找键 UUID-A ≠ 子消息行 streamSessionId UUID-B，子消息 parentStreamSessionId 还指向幽灵 UUID-A'。
- **根因**：PM 在 chunk 里预生成查找键，routeDispatch 又自造新 UUID；`tool_stream_session_id` 字段语义漂移（一字段两义）。
- **修复**：dispatch 消息双流 id 字段——`sub_stream_session_id`（子流 id，路由用，与查找键同源）+ `tool_stream_session_id`（PM 流 id，parent 来源）。
- **规则**：跨模块 ID 单点生成沿线透传；一义一名（momo-boundary-rules #1/#3）。

### P0-6 等待从不产生的事件

- **症状**：P0-7 修复后仍无效——DOM 显示 dispatch 被渲染成普通工具卡片。
- **排查**：用户 DOM 是决定性证据 → 主进程 grep 证实 dispatch 以 `tool_call_start(isDispatch:true)` 落库，`dispatch_start` 事件类型从不产生（v1.4 遗留类型定义）。
- **根因**：renderer 聚合器按 v1.4 类型定义等 `dispatch_start`——纸面契约与生产现实脱节。
- **规则**：消费方必须验证生产者存在（momo-boundary-rules #2）；对接面契约测试（momo-test-rules #4）。

### P0-8 dispatch 路由到团队会话

- **症状**：代码/数据/渲染三层验证全部 PASS，用户机器仍空。
- **排查**：加 `__momoDebug()` 钩子让用户导出 store 状态——子行不在当前会话的 messages 里但 streamKeys 有键 → 子消息落在别的会话 → harness 改用普通会话复现实证（子行落 sess-team）。
- **根因**：`executeDispatch` 用 `config.teamSessionId` 发内部事件（PM 配置的团队会话），而非用户当前发消息的会话。所有验证都在团队会话里做，两会话恰好同值，缺陷被掩盖。
- **修复**：`executionSessionId` 从 runChatLoop 的 roomId 线程化传入。
- **规则**：路由目标用当前上下文不用配置默认值（momo-boundary-rules #5）；测试场景覆盖「配置默认值 ≠ 实际上下文」的分歧点。

---

## 模式三：环境分歧（「修复无效」的最大来源）

- **P0-6/7 两轮「无效」**：用户跑的是旧 `renderer/dist`（dev 脚本不覆盖 renderer，git pull 后无人重建）。
- **代理劫持**：dev 编排器用 fetch 探测 vite 就绪——Node fetch 走 HTTP_PROXY，代理机上永远探不到 localhost（改裸 TCP 探测根治）。
- **ABI 横跳**：better-sqlite3 在 Node ↔ Electron ABI 间反复 rebuild，容器验证前后必须显式管理。
- **规则**：修复无效三查（git log / dist 产物特征 grep / renderer 重建确认）；环境与代码同权重怀疑（momo-debug-rules #2）。

---

## v2.3 Read-before-Edit 规则

v2.3 FileTools 防御硬化（spec：`docs/specs/2026-09-10-file-tools-defense-hardening-design.md`）引入的工具层强阻塞守门：

- 所有 edit_file / write_file 调用前必须先 read_file 读取同文件
- write_file 创建新文件豁免（文件不存在时无需 Read）
- 子 agent（parentStreamSessionId 非空）永远 fresh-session，不继承父 agent 已读状态
- 测试覆盖：electron/tests/agent/tools/file-tools-read-gate.test.ts

---

## v2.4 OS 沙箱规则

v2.4 ShellTools OS 沙箱（spec：`docs/specs/2026-09-10-shell-tools-os-sandbox-design.md`）引入的 bash 工具 OS 级隔离约束：

- bash 工具结果必含 `sandbox:` 行（紧跟 `exit_code:` 行）——LLM 与调用方据此感知本次执行是否落在 OS 沙箱内；`unsandboxed:*` 标记 = permissive 降级直跑，不得静默吞掉
- 改动沙箱剖面（`buildBwrapArgs` / `renderSeatbeltProfile` / `buildPolicy`）必须先跑 `electron/tests/sandbox/` 快照测试——剖面参数顺序（ro-bind 全盘在前、workspace bind 在后）是安全语义，不是实现细节
- 容器内 bwrap 受限：Docker seccomp 拦 user namespace（`Operation not permitted`），真实 bwrap 集成测试自动整组 skip（`tests/sandbox/bwrap-integration.test.ts` 顶层同步冒烟 + `describe.skipIf`）——skip 是诚实行为，不造假绿；真实验证留 macOS 主机 / 允许 userns 的 Linux
- 新增任何 bash 相关防线（黑名单 / 环境变量过滤 / 超时 / 杀进程树等）不得绕过 `resolveShellSpawn`——它是 shell-tools 的唯一沙箱接入点，绕过即 plain 直跑失去 OS 隔离

---

## v2.5 变更账本规则

v2.5 变更账本与撤销（spec：`docs/specs/2026-09-10-change-journal-undo-design.md`）引入的 agent 写操作记账与撤回约束：

- **写类工具不得绕过 recordChange**——write_file / edit_file / rm / mv（file-tools.ts）与 apply_patch（apply-patch-tools.ts）五个写 op 是仅有的记账点，落盘前经 `recordChangeSafe` 单点收口（spec D2，与 v2.3 Read-before-Edit、v2.4 resolveShellSpawn 同款「单一接入点」纪律）。新增任何能写 workspace 文件的工具（含未来多仓 git 工具）必须先接入 recordChange 再上线——绕过即该工具变更游离于撤销链之外。用户侧 file:* CRUD 不入账是用户主权豁免，不在禁令内
- **撤回一律走 revertEntries**——hash 守卫（hash(当前文件) != after_hash 即漂移：其后被任务 B / 手动 / shell 改过，默认跳过 + 黄标，force 强制须 UI 明确警告）+ 逐文件逆序（created_at DESC）。禁止裸写文件撤回、禁止乱序批量写回；交叉场景（任务 A/B 同改一文件撤 A）默认拦截，正确姿势是 rollbackFileBefore 组合操作（自动逆序该文件全部后续 + 本条，逐步守卫逐步汇报，任一步拦截即停）。撤销动作本身记对称条目（撤销可再撤销）
- **探测器多仓语义**——discoverRepos 限定深度找 workspace 内全部 git 仓（根仓 + 内层仓，目录 mtime 缓存），scanUnjournaled 对每仓 `git status --porcelain=v1` 与账本路径集做差；只读不写、绝不产生 commit。degraded 两成因：本机无 git（spawn ENOENT）与任意仓执行非零退出 / 输出截断（porcelain 不完整）——degraded=true 时三列表恒空，无法核对绝不半真半假
- **spec §10 已知边界**——账本内容按 utf-8 存取（`fs.readFileSync(abs, 'utf8')` + blob 文本），二进制文件撤回有损；bash 账外变更只有事后核对（无实时记账），未入账区文案诚实标注「经 shell 命令或用户手动修改——无法区分」

---

## v2.7 浏览器规则

v2.7 McpBrowser（spec：`docs/specs/2026-09-11-mcp-browser-design.md`）引入的浏览器工具与内嵌视图约束：

- **file:// workspace 限定不可绕过**——`policy.assertUrl` 是唯一导航门：agent 的 browser_navigate、用户的地址栏 userNavigate、popup 收编 incorporatePopup 三条导航路全部先过（file:// 走 resolve 字符串边界 + realpath 最近祖先双防线）。新增任何导航入口必须走 assertUrl，直接 `loadURL` = 越界漏洞（`..` 穿越 / 符号链接逃逸 / 域外协议全部由此拦）。已知边界：重定向不复检（初航过名单后 302 目标不二次校验）——新增「跳转后校验」若立项，收口点同样在 policy
- **popup 一律收编 tab**——`setWindowOpenHandler` 恒 deny + incorporatePopup 开新 tab，禁止产生游离 OS 窗口；popup URL 同样过 assertUrl（页面发起的 window.open 也是可见导航面——防御纵深）。新增会开新视图的路径（含 window.open 变体、外链协议）必须沿用收编，不得 `action: 'allow'`
- **浏览器网络与 bash sandbox 无关**——浏览器视图的网络请求不经 resolveShellSpawn 三态决策（Seatbelt/bwrap 只约束 bash 工具子进程），域名策略（黑白名单 + localhost 恒放行）是浏览器唯一网络层约束。两套体系不混谈、不互相兜底：给 bash 沙箱开网络 ≠ 浏览器放开域名，反之亦然
- **新增浏览器工具必须过信任门**——`assertAllowed` 先于一切：门序 = 信任门（deny 拒 / ask 未授 NotTrusted）→ 接管门（user 态 TakenOver）→ evaluate 门（仅 browser_evaluate）→ 动作。绕过信任门直连 manager 方法 = 未授权浏览器访问；工具路由（browser-tools.ts）是唯一工具侧入口，新工具在此注册并声明门序
- **assertAllowed(wsId) 抛 NotTrusted 前必须推 browser:notice(kind:'trust-request')**——spec §5.2 step 3 契约：推 notice 与抛错是同一原子操作的「前半」+「后半」，顺序不可倒（先抛后推 → renderer 信任卡永不弹出 → LLM 永久重试 → 用户无法授权）。pushNotice 自身抛错须向上穿透（IPC 故障可见），不得静默吞回退到 NotTrusted——否则复现同一 bug 类。notice 载荷须带 `workspaceId`（M7，v2.7 review）——renderer 信任卡路由用载荷而非活跃 ws 推导（用户切 ws、tool 跨 ws 上下文时活跃 ws ≠ notice 发送方 ws）
- **takeover 语义按 source 甄别**——agent 工具在 user 态一律 BrowserTakenOverError（等待释放，可重试）；用户的 tabs IPC（open/close/switch，`browser:*` 通道）显式传 `source='user'` 放行——§3.2 只约束工具不约束人。新增浏览器 IPC 通道必须显式声明调用方（user / agent / 双方），无 source 字段的通道 = 甄别缺口（G4 教训：单门拒绝曾导致用户接管后无法操作自己的 tab）

---

## v2.6 断点续跑规则

v2.6 任务断点续跑（spec：`docs/specs/2026-09-10-task-resume-design.md`）引入的事件重建式恢复约束：

- **新增流 chunk 类型必须走 event buffer 落库**——重建器以 `message_events` 为唯一断点真相源（spec D2），任何绕过 MessageEventBuffer 直推 renderer 的新 chunk 类型在中断后不可见、不可重建（kill 瞬间 ≤50ms 未 flush delta 的丢失是既定可接受界）。先例：v2.6 `steer` 事件即因重建可见性需求在 drain 处补落库（v2.6 前只进内存）——新增 chunk 类型时先问「中断重启后重建器看得到吗」
- **重建器前向兼容跳过未知事件**——turn-reconstructor 对未知 event type 一律跳过不炸：断点不做跨版本兼容保证，schema 演进时旧中断任务经「未知事件跳过 + 重建失败降级 degenerate」安全退化为全新回合（降级本身是设计要求）。反向约束：给既有事件类型赋予新重建语义时必须同步补重建器场景矩阵测试（`tests/agent/turn-reconstructor.test.ts`），且不得破坏降级阶梯（重建任何抛错 → catch 降级，安全方向）
- **恢复链不得绕过 executor 并发闸**——resumeTask 必须经 AgentRunner.executeTask + registerLane 派发（对齐 RouterService.routeUserChat 的 runner 查找 / ensureMemberRuntime 拉起 / 派发 / 占道四要素），maxConcurrentTasks、会话车道串行性、预算续扣、压缩游标四重保障全部天然生效；任何「直接 spawn 子进程续跑」的捷径 = 绕开并发闸 + 同流双恢复无守卫。检测侧配套铁律：detectInterrupted 不改任务状态（spec D6，恢复卡是唯一闸门），scheduler 对 in_progress 零触碰的边界由回归锁固化

---

## v2.8 编排规则

v2.8 Orchestration 元语（spec：`docs/specs/2026-09-12-orchestration-primitives-design.md`）引入的子 agent 续接与异步派发约束：

- **taskId = 链 ID，不可复用不可另造**——followup 多轮沿用原 dispatch 的 task_id（executeFollowup 构造 dispatch content 时不用 buildDispatchMessage 的 randomUUID），`WHERE task_id = ?` 是链历史聚合的唯一键。任何「为新轮次生成新任务 ID」的改动都会把链拆断（重建器查不到前轮、句柄表键漂移）。串行保障：上轮 settle 后才可再 followup（派发侧校验同链无在途条目）——pendingReplies / bgHandles 同键复用的安全前提
- **bg 句柄是内存态，不承诺跨重启**——`bgHandles: Map<taskId, BgHandle>` 生命周期 = PM runtime 子进程；重启后 status / cancel / gather 一律 not_found（spec §12 明示边界，不做持久化补救）。新增依赖句柄的功能必须先把 not_found 当常态路径处理；同 PM 在途上限 8（BG_HANDLE_LIMIT）是内存约束不是配置项
- **handleTaskReply 单点收口不破**——子 agent reply 的唯一入口：pendingReplies 命中走既有逻辑，miss 查 bgHandles（in_flight 翻转 / cancel 后迟到忽略 body）+ 唤醒 gatherWaiters。新增任何「消费 reply」的机制必须在此扩展分支，禁止另开监听路径 fork reply 流——双消费者 = 竞态 + 既有渐进超时 / abort 清理语义漂移
- **historyPrefix 与 resumeTurn 互斥**——两者都是 runChatLoop 尾参且语义正交（resume=恢复中断、messages 非空不追加 body；followup=续聊、前缀 + 新 user 轮），派发侧保证不同时设置；runChatLoop 防御性处理：同现时 resumeTurn 优先、historyPrefix 忽略 + warn。新增第三种载荷前缀类字段必须先回答「与这两者如何互斥」
- **编排工具注入门统一 length 判定**——getSessionDispatchScope 的 filter 可返回空数组（多成员会话 + 自己是 leader + subAgents 快照与会话成员交集为空），而 `[]` 在 JS 为 truthy：hint 门判 length 而工具门判 truthy 即出现「无教学段却注入工具」的门不一致（T7 Minor，T9 收敛为单一 hasSessionSubs 布尔）。新增依赖 sessionSubs 的注入点必须复用同一布尔，禁止再写裸 truthy 判定

---

## v2.9 多仓 git 规则

v2.9 多仓 git 工具（spec：`docs/specs/2026-09-12-multi-repo-git-design.md`）引入的 workspace 内层仓操作约束：

- **发现列表是唯一 `-C` 入口**——任何给 git 子进程定仓的路径必须经 `resolveRepoPath` 产出（`wsFs` 边界校验 + `discoverRepos` 发现列表命中双校验，工具层统一入口 `resolveRepoArg`）。新增 git 工具（或任何 spawn `git -C` 的路径）不得绕过该校验直接拼接仓路径——绕过即任意目录注入面（`..` / 绝对路径 / symlink 逃逸 / 未发现目录全部由此拦）。单点纪律与 v2.3 Read-before-Edit、v2.4 resolveShellSpawn、v2.5 recordChange 同源
- **`repo` 参数必须命中 discoverRepos**——命中比对在归一化后进行（`path.normalize` + POSIX `/` 形态，Windows 反斜杠同口径），`./x` / `x/` / `x` 等价；未命中报错附可用仓清单 + 缓存失效重试指引（LLM 可自纠）。命中清单来自 `git/repos.ts` 共享模块（v2.9 自 detector 上提纯搬家）——对账与工具层同源，禁止任何一方另起探测实现造成两份仓清单漂移
- **缺省恒根仓零变化**——`repo` 缺省时 runGit 不前置 `-C`、spawn args 与 v2.9 前逐字节一致（工具层 `resolveRepoArg` 保 `undefined` 而非填 workspaceDir）。给既有 git 工具加新可选参数时必须维持这条缺省契约：既有 agent 提示词、既有测试快照、账本联动全部锚定在「无 repo = 根仓」的零变化路径上——任何「顺手归一成显式 -C 根仓」的改动都是回归
- **path 沙箱语义保持 workspace 锚定**——`git_add.paths` / `git_diff.path` 的 `assertInWorkspace` 校验基准仍是 workspace（不因 repo 参数改为按目标仓校验）：指定 repo 后 path 由 git 在 `-C` 下按仓内相对路径解析，仓本身已在 workspace 内 + git `-C` 自限于仓内，无逃逸面。改动 path 校验基准前先答「能否构造出 workspace 外落点」——答案恒否就不要动

---

## 验证有效的方法论（保留）

| 手段 | 用法 | 战绩 |
|---|---|---|
| 真实 LLM e2e harness | seed SQLite → 驱动 dist 生产代码 → 轮询断言落库 | 全链路问题的一锤定音工具（P0-2/5/7/8 验证） |
| SQLite 直查 | 数据争议直接查库裁决（WAL 三件套注意点） | 「消息丢失」10 秒破案 |
| 运行时探针 | `__momoDebug()` globalThis 钩子导出 store | P0-8 决定性证据 |
| xvfb + CDP | `--remote-debugging-port` + WebSocket 驱动真实 DOM | 容器里验证 UI 行为 |
| 诊断补丁 | 拷 dist 改 err.message→err.stack 重跑 | P0-1 堆栈获取 |
| 双向证据 | 用户侧 DOM/sqlite 输出 + 容器复现互证 | 每一步都基于事实推进 |

## 规则索引

- 排查/修复流程 → `.opencode/skills/momo-debug-rules/SKILL.md`
- 测试/mock 保真度 → `.opencode/skills/momo-test-rules/SKILL.md`
- 跨模块/IPC/协议 → `.opencode/skills/momo-boundary-rules/SKILL.md`
- 核心红线（常驻）→ `AGENTS.md` 研发红线章节
