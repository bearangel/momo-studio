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
