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
