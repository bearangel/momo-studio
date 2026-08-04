# v1.4 Task 7 报告 — 中断传播（PM abort → 子 agent abort）

**状态**: ✅ 完成
**Commit**: `17d402a feat(v1.4): 中断传播 — PM abort 自动传播到子 agent`
**分支**: main

---

## 实现概要

### 核心机制

当用户中断 PM 的流式输出（新消息或停止按钮），任何正在运行的子 agent 流也必须同步中断。本任务在主进程 runtime-manager.ts 中建立了父→子 stream session 映射，并在 abortStream 中实现级联中断。

### 改动详情（`electron/src/main/agent/runtime-manager.ts`，+65 行）

1. **`streamChildren` 映射（新增）** — 模块级 `Map<string, Set<string>>`，父 streamSessionId → 子 streamSessionId 集合。与 `activeStreams`（roomId 索引）互补：前者解决中断入口，后者解决中断传播。

2. **`handleChildMessage` 跟踪嵌套** — relay start chunk 时，若含 `parentStreamSessionId` 则把子 session 加入父的子集合；relay end chunk 时双向清理（删自身作为父的 entry + 从所有父的子集合中移除自身）。

3. **`abortStream` 传播（增强）** — 中断 PM 自身后，查 `streamChildren` 取得子集合，逐个按 streamSessionId 在 `activeStreams` 中反查子进程句柄，发送 abort IPC。子 session 与 PM 可能同房也可能异房，故按 streamSessionId 而非 roomId 反查。

4. **`handleAgentExit` 清理（增强）** — 子进程退出时，除了清理 activeStreams，同时清理该进程名下所有 session 在 streamChildren 中的记录（自身作为父 + 作为某父的子），防止内存泄漏。

5. **测试钩子（新增）** — `__getStreamChildren()` / `__getActiveStreams()` / `__resetStreamState()` 三个 `__` 前缀函数，仅供单测白盒验证模块内部映射，生产代码不调用。

### 测试基础设施（新建）

- **`electron/tests/agent/fake-runtime-stream.ts`**（42 行）— 假子进程入口，通过环境变量 `AP_SESSION_ID` / `AP_ROOM_ID` / `AP_PARENT_ID` 配置行为。启动时发 start chunk（可选携带 parentStreamSessionId 模拟子 agent 嵌套），收到 abort IPC 后回发 end(interrupted) chunk。

- **`electron/tests/agent/runtime-stream-abort.test.ts`**（165 行，7 用例）— 集成测试。用 mock BrowserWindow 捕获 relayed chunks，用 `setRuntimeEntryOverride` 拉起假子进程。

---

## 测试用例（7/7 通过）

| # | 用例 | 验证点 |
|---|---|---|
| 1 | start chunk 含 parentStreamSessionId 时建立父→子映射 | `streamChildren` 正确记录；父子都在 activeStreams |
| 2 | 无 parentStreamSessionId 的 start chunk 不建立嵌套映射 | 顶层 agent 不出现在 streamChildren |
| 3 | **abortStream 中断 PM 时同步传播到所有子 agent** | PM + 两个子的 end(interrupted) chunk 均被 relay |
| 4 | abortStream 对无活跃流的房间是 no-op | 不抛错 |
| 5 | 有 PM 但无子的房间只中断 PM 自身 | 仅 PM 的 end chunk |
| 6 | 子 agent 与 PM 同 roomId 时映射仍正确建立 | streamChildren 不受 roomId 冲突影响（已知限制：abortStream 在同房场景受 activeStreams 单 roomId 设计制约） |
| 7 | end chunk / 进程退出清理 streamChildren 双向映射 | stopAllAgents 后 streamChildren 清空 |

---

## 验证结果

| 项 | 结果 |
|---|---|
| electron typecheck | ✅ clean |
| renderer typecheck | ✅ clean |
| runtime-stream-abort.test.ts（新） | ✅ 7/7 |
| runtime-stream.test.ts（现有） | ✅ 22/22（含 v1.4 Task 1-2 的嵌套用例） |
| runtime-manager.test.ts（现有） | ✅ 5/5 |
| runtime-manager-restart.test.ts（现有） | ✅ 4/4 |
| electron vitest 全量 | ✅ 352/355（3 个 conduit/manager 预存 flaky，与本任务无关） |

---

## 文件变更

| 文件 | 类型 | 说明 |
|---|---|---|
| `electron/src/main/agent/runtime-manager.ts` | 修改 | +65 行：streamChildren 映射 + abortStream 传播 + handleChildMessage 跟踪 + handleAgentExit 清理 + 3 个测试钩子 |
| `electron/tests/agent/fake-runtime-stream.ts` | 新建 | 42 行：假子进程（发 start chunk + 响应 abort） |
| `electron/tests/agent/runtime-stream-abort.test.ts` | 新建 | 165 行：7 个中断传播集成测试 |

---

## 设计决策

1. **streamChildren 与 activeStreams 分离** — activeStreams 按 roomId 索引解决「中断入口」（用户操作粒度是房间），streamChildren 按 streamSessionId 索引解决「中断传播」（嵌套关系粒度是 session）。两者生命周期独立但相互引用。

2. **abortStream 按 streamSessionId 反查子进程** — 子 agent 可能在与 PM 相同或不同的房间运行。迭代 activeStreams 的 values 按 streamSessionId 匹配，避免对房间布局的假设。

3. **测试用 mock BrowserWindow 而非真实 Electron** — `relayStreamChunk` 依赖 `mainWindow.webContents.send`。测试构造 `{ isDestroyed: () => false, webContents: { send: capture } }` 的 mock 并通过 `setMainWindow` 注入，使 relayed chunks 可断言。`as unknown as BrowserWindow` 类型断言（非 `as any`）满足 strict 约束。

4. **fake-runtime-stream 不在 abort 后立即 exit** — 避免 process.send 的 IPC 消息未 flush 就退出的竞态。假进程保持存活，由测试的 afterEach `stopAllAgents()` 统一清理。

5. **同 roomId 已知限制（测试用例 6 文档化）** — activeStreams 按 roomId 单值索引，若 PM 与子在同一房间，后注册的子会覆盖 PM 的 entry。这是 v1.4 前已有的设计限制（dispatch 典型场景下子 agent 在独立房间工作，不触发此问题）。streamChildren 映射本身不受影响。本任务未修复此限制（超出 Task 7 范围）。

6. **测试钩子用 `__` 前缀** — 遵循仓库既有惯例（`__resetRestartState` 已存在），明确标记为测试专用。生产代码（main/index.ts、runtime-entry.ts）不导入这些函数。

---

## v1.4 嵌套流式总览（Task 1-7 全部完成）

| Task | Commit | 内容 |
|---|---|---|
| 1 | — | StreamChunk + dispatch 类型扩展 |
| 2 | — | runtime dispatch 嵌套流式（PM chip + 子 agent parentStreamSessionId） |
| 3 | — | stream store 嵌套支持 |
| 4 | — | DispatchChip + SubAgentSection 组件 |
| 5 | — | AgentStreamBubble 集成 dispatch chips + 进度指示器 |
| 6 | `b73c529` | MessageList 过滤 + MessageBubble 历史嵌套还原 |
| **7** | `17d402a` | **中断传播 — PM abort 自动传播到子 agent** |

v1.4 嵌套流式展示功能链路完整：类型扩展 → 主进程 IPC → store 状态管理 → renderer 组件渲染 → 历史还原 → 中断传播。所有 7 个 task 已完成。
