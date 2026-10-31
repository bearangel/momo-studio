# 可信执行包设计（执行超时 / 流看门狗 / 子任务停止 / 派发透明化）

- 日期：2026-10-31
- 状态：已批准（用户 2026-10-31 设计评审通过）
- 来源：真实用户验收报告 `.omo/qa-reports/2026-10-31-game-designer-rpg/report.md`（4.3 小时首触深度体验，16 缺陷）
- 范围：报告 P1 全部（D1/D2/D3）+ 联动的 D8 + 顺手 D12；其余缺陷归后续包（§8）

## 1. 背景与问题定性

验收报告暴露的核心杀伤力不在单点功能，而在**执行可信度**：思考型模型 + 死连接场景下，系统出现 17 分钟级「假死」（UI 计时器走、实际早已停滞），且用户主动止损的「停止子任务」按钮无效——只能用「主停止」杀掉整回合（含其它健康子任务）。把这类问题修到「挂死可辨、可救、自动判死」，是本包唯一目标。

## 2. 根因实锤（探查结论，非猜测）

| 缺陷 | 代码事实 |
|---|---|
| D1 方案生成确定性超时 | `plan-generator.ts:118-137`：`createLLMProvider` 不传 `thinking`（推理模型默认开思考；报告 curl 实测同 prompt 非流式 58.8s，7017 字符思考）；`Promise.race` 60s 超时后**底层请求继续在途**（`chat()` 无 signal 参数，超时只是丢弃结果，token 白烧且重试叠加在途请求）；超时文案硬编码「建议换更快的模型（如 flash 档）」在用户已选 flash 时误导；超时在 main.log 零痕迹 |
| D2 流静默挂死无看门狗 | `chatStreamOpenAI/Anthropic` 读循环只与**用户 abort** 竞速（`buildAbortPromise`），无空闲超时——socket 静默死亡（无 FIN/RST，出站连接消失）时 `reader.read()` 永不返回，回合永不收尾。bg 模式宣称「静默 3 分钟判死」但注册表心跳（`HEARTBEAT_INTERVAL_MS=60s`）由 `runTaskChatLoop` 定时器驱动——**量的是进程活着，不是数据在流**，死流同样心跳正常，判死永不触发（报告两次复现 17min/12min 完全吻合） |
| D3 子任务停止无效 | **表层 wiring 已存在**：`router-service.cancelChain`（:805）→ `broadcastAbortDispatch`（:756）→ 遍历 `runners` 调 `abortStream(subStreamSessionId)`（:752，与主停止同款 IPC 信号链）。但实测点击后 7 分钟无效（主停止 ~10s 生效，走的 PM 等待侧 `waitForTaskReply` 的 signal onAbort 立即 reject）。**存在更深的 wiring/时序缺口**（候选：子 agent runner 不在 `runners` Map / `activeTasks` 键与 subStreamSessionId 不匹配 / 子进程 abort 监听器未武装或时机错过）。按 momo-debug-rules 红线：**先复现后修复，不预设结论** |
| D8 子任务执行不透明 | `DispatchChip` 头行只有状态 + 活动提示 + 计时器；展开区 `SubAgentSection` 已具备思考折叠/工具卡/正文渲染（探查确认能力在）。缺**最后活动时间戳**——挂死与健康不可辨的直接原因。报告所见「只有计时器」的形态疑为在途面板行（预览阶段核对） |
| D12 dev.mjs 透传 `--` | `pnpm dev -- --remote-debugging-port=…` 中 `--` 被 dev.mjs 原样转发 Electron，其后参数被 Chromium 视为位置参数静默失效（本次验收曾因此污染真实 Chromium profile） |

## 3. 方案

### 3.1 D1 方案生成超时链

1. **显式关思考**：`createLLMProvider(..., { thinking })`——thinking 关闭配置经与成员编辑「思维模式-关」**同源的方言解析链**产出（`resolveThinkingConfig`：模型级覆写→预设→platform 兜底），仅强制 `mode='off'`，不手拼方言（实施可提取 `(modelName, provider)` 入口的解析内核复用，plan-generator 持 providerId+modelId 而无 AgentDefinition）。方案生成是白名单选择题（prompt schema 限定从预置清单选），思考零增益而耗时是主体。60s 超时从「确定性命中」退化为真兜底
2. **真中断**：`LLMProvider.chat()` 增加可选第三参 `signal?: AbortSignal` 并透传至 fetch 层（可选参数，既有调用点与测试 mock 零破坏——结构化类型兼容）；plan-generator 改用 `AbortSignal.timeout(ONBOARDING_LLM_TIMEOUT_MS)`，超时即断底层连接
3. **文案模型无关**：「AI 生成超时（60 秒），可重试或转手动配置（已完成步骤不丢失）」
4. **超时落日志**：main.log warn（含耗时）

非流式其他 `chat()` 调用点（会话命名等）不改动——`LLM_REQUEST_TIMEOUT_MS=300s` 已确认接线（fetchWithRetry 默认 timeoutMs），fetch 挂死有兜底。

否决备选：改流式 + 进度 UI——为兜底路径上流式基建，YAGNI。

### 3.2 D2 流空闲看门狗（裁定：全流统一，装 provider 层）

1. **位置**：`chatStreamOpenAI` / `chatStreamAnthropic` 读循环内——每次 `reader.read()` 与空闲计时器竞速，**任何 read 返回即重置计时**（SSE keep-alive ping 字节也算活性——这正是正确的活性信号）。覆盖主会话 / 快速会话 / dispatch 子流 / bg，一处机制无特判，未来新会话类型自动受益
2. **阈值**：`STREAM_IDLE_TIMEOUT_MS = 120_000`（导出常量，测试可注入时钟/阈值）。流式生成期 chunk 持续到达，120s 零字节判死，误杀面极小；不做用户设置项（YAGNI，报告未要求可配）
3. **触发动作**：经独立 AbortController 中断读循环 + 抛类型化错误（错误名 `StreamIdleTimeout`，文案「流空闲超时（120s 无数据，疑似连接中断）」）→ 走既有错误路径：回合 failed → dispatch 链 `settle failed` → **失败回执送达 PM**。同步与 bg 天然统一（两者共享同一 provider 层），无链路特判
4. **资源纪律**：流正常收尾 / 异常退出时清计时器（finally），不留悬挂 timer
5. **与注册表心跳的关系**：注册表心跳保持现状（链级活性/投递判定用）；看门狗是数据级活性的唯一执法者。两者语义正交，不合并

### 3.3 D3 子任务停止接真 abort（复现驱动）

方法论（不猜修法）：

1. **红测复现**：fork 池单测构造「死流 mock provider」（建连后挂起：不发数据、不发 FIN、不响应）+ dispatch 在途 + 调 `cancelChain({subStreamSessionId})`，断言「数秒内子流翻终态（aborted）」——当前必红
2. **五段插桩定位**：`cancelChain` → `broadcastAbortDispatch` → `runners` Map 命中 → `activeTasks` 键匹配 → 子进程 `abortListener` → `AbortController.abort()`，逐段日志确认断点
3. **最小修复**（按定位结果）+ 回归锁入 `tests/agent/`
4. **验收语义**：手动止损独立可用，不依赖 D2 的 120s 自动判死；点击后子流秒级终态、chip 翻 `aborted`、PM 收到失败回执

### 3.4 D8 dispatch 卡透明化（UI，走预览门禁）

1. **最后活动时间戳**：renderer `stream.store` 按 streamSessionId 记 `lastEventAt`（应用事件批即刷新，零新 IPC）；DispatchChip 头行显示「最后活动 Xs 前」（1s 跳动，复用 ElapsedTimer 模式），**>30s 无事件转警示色**——挂死与健康一眼可辨
2. **在途面板**：行内同样补最后活动时间（报告所见疑似发生地，预览阶段核对）
3. **思考可见性**：展开区 `SubAgentSection` 思考/工具渲染能力已在（探查确认），预览阶段核对形态与主会话 `ThinkingSection` 一致
4. **P1 变更 → 静态预览门禁**（momo-ui-preview-rules）：产出 `.omo/previews/execution-trust-dispatch-card.html`（执行中活跃 / 执行中停滞>30s / 完成 / 失败 × 明暗双主题），确认后实现

### 3.5 D12 dev.mjs 剥 `--`

`dev.mjs` 组装 Electron argv 前剥离首个 `--`（pnpm 传参惯例产物）；momo-acceptance 技能文档命令示例同步去 `--`。

## 4. 裁定记录

| # | 裁定 | 日期 |
|---|---|---|
| 1 | 范围 = 包①（D1+D2+D3+D8+D12），D4-D7/D9-D16 归后续包 | 2026-10-31 |
| 2 | D2 看门狗装 provider 层全流统一（否决「仅 dispatch 子流」最小面方案） | 2026-10-31 |
| 3 | 设计 7 节整体批准 | 2026-10-31 |

## 5. 测试与验收

- **红测先行**：每缺陷先写失败测试（D3 的复现用例即红测；D2 用死流 mock 验证 120s 触发与错误形态；D1 验证 thinking:off 传入 + signal 真中断 + 文案；D8 验证 lastEventAt 记录与展示逻辑）
- **回归**：`tests/agent` 全套 + electron 全量 + e2e 13 场景（hub-distribution）零回归
- **真机验收**（A/B 实例复刻报告场景）：思考开启模型派发大任务 + dev 代理断流模拟死连接，验证——① 看门狗 ~120s 触发 + 失败回执送达；② 子任务停止秒级生效（不等 120s）；③ chip「最后活动 Xs 前」实时跳动、停滞>30s 转警示；④ onboarding 方案生成在 flash 档按时返回
- **交付流水线**：spec → .omo/plans 副本 → Momus 评审 → D8 预览确认 → 实施 → oracle 终审（零必修）→ PR → CI 终态 SUCCESS 合并 → main CI 绿 → 台账 → A/B 重启复验

## 6. 风险与缓解

| 风险 | 缓解 |
|---|---|
| `chat()` 接口加参的连锁面 | 可选参数 + 结构化类型兼容——既有调用点与 mock 零改动；typecheck + 全量测试实证 |
| 看门狗误杀（厂商长时间静默） | 120s 阈值保守（流式生成期 chunk 持续）；错误文案自解释；误杀走 failed 回执可重派，无静默丢失 |
| D3 根因定位偏离预设候选 | 方法论约束：复现红测 + 五段插桩，修在实锤断点上；不修无关代码 |
| stream.store lastEventAt 与 DB 时钟漂移 | 单机单进程本地时钟，直接 Date.now()，不引入跨源对时 |

## 7. 版本与交付

- 版本：`2.1.0-alpha.53`（三处 package.json + CHANGELOG）
- 分支：`fix/execution-trust-package`

## 8. 明确不做（后续包）

- 包② 账本与存储：D4 dispatch 子任务入任务账本 / D5 thinking_delta 聚合存储（186MB/4.3h 增速）
- 包③ 状态容错快赢：D6 provider 验证状态回写 / D7 工作空间路径确认
- 包④ 打磨：D9 团队创建回填 / D10 GLM placeholder / D11 首屏视觉 / D13 日志降噪 / D14 停止异步化 / D16 生效语义；D15 QA 基建单独处理
