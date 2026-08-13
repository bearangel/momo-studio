# Task D4 报告：AgentRunner（task-driven 核心重构）

**Status:** ✅ 完成
**Commit:** `ab9d240` — `feat(agent): AgentRunner task-driven 核心重构（D 子系统）`
**Base:** `c2d6952`（D3 WarmPool）

## 交付物

| 文件 | 行数 | 说明 |
|---|---|---|
| `electron/src/main/agent/agent-runner.ts` | 140 | AgentRunner 类（task-driven runtime 核心） |
| `electron/tests/agent/agent-runner.test.ts` | 157 | 4 个 it 覆盖核心场景 |

## 测试结果

```
✓ tests/agent/agent-runner.test.ts  (4 tests) 4ms

Test Files  1 passed (1)
     Tests  4 passed (4)
```

4 个 it 全部通过：
1. ✅ executeTask 从 warm pool 取 runtime，注入 task config（验证 child.send 收到 task-config + activeTaskCount=1）
2. ✅ task 结束（end chunk）→ release runtime + activeTaskCount 减 1（模拟子进程发 end chunk，验证 release + 清理）
3. ✅ abortStream 中断指定 task（验证 child.send 收到 {type:'abort', streamSessionId}）
4. ✅ destroy 释放所有活跃 runtime + warm pool（验证 child.kill 被调用）

## 类型检查

```
electron typecheck: Done   (tsc --noEmit)
renderer typecheck: Done   (tsc --noEmit)
```

LSP diagnostics：`agent-runner.ts` 与 `agent-runner.test.ts` 均 0 errors。

## 实现要点

### 架构定位
AgentRunner 替代 runtime-manager.ts 的"长期运行 agent"模式。每个 agent_assignment 对应一个 AgentRunner：
- **v1（当前）**：单 task 串行（per-agent max=1）
- **v2（预留）**：多 task 并发（warm pool 多 acquire，activeTasks Map 已支持多 entry）

### 核心流程（executeTask）
1. `warmPool.acquire(agentAssignmentId)` 取 warm runtime（< 1ms，跳过冷启动）
2. 注册 `child.on('message', handler)`，handler 按 streamSessionId 过滤，收到 `end`/`error` chunk 时 release runtime + 移出 activeTasks
3. `child.send({type:'task-config', ...})` 注入 task 配置（子进程据此跑 chat loop）
4. 返回 `{ streamSessionId }`（不等候 chat loop 完成——异步流式）

### 与 D3 WarmPool 的集成
- 构造时注入 `warmPool: WarmPool`（共享，多 runner 可共用同一 pool）
- `acquire()` 取 runtime，`release()` 归还（v1 = kill 子进程）
- `destroy()` 释放所有活跃 runtime 但**不**销毁 warmPool（warmPool 生命周期由外层管理）

### 复用旧类型
- `AgentRuntimeOpts`（runtime-manager.ts）作为 `config` 字段类型——仅类型复用，不耦合 runtime-manager 实现
- spawn 实现由 warmPool 注入的 `spawn(agentId)` 函数承担（后续 runtime-spawner task 接管）

## 与 brief 的偏差（均为改进）

1. **移除未使用的 import**：brief 的实现含 `import { randomUUID } from 'node:crypto'` 和 `import type { ChildProcess }`——实际均未引用（`randomUUID` 未用；`ChildProcess` 经由 `WarmRuntime.child` 隐式获得类型）。已删除以保持代码整洁。

2. **mock cast 修正**：brief 测试用 `ReturnType<typeof vi>`（即 `VitestUtils` 对象）做 cast，触发 LSP 2344 错误（`VitestUtils` 不满足 `(...args) => any` 约束）。改为仓库既有约定 `ReturnType<typeof vi.fn>`（`tests/resource/ipc-handlers.test.ts` 7 处同模式）。

3. **mock.calls 访问方式**：brief 用 `([event]: [string]) => event === 'message'` 解构，触发 `noUncheckedIndexedAccess` 下的元组不匹配错误。改为 `onCalls.find((c) => c[0] === 'message')?.[1]`（与 `bot-registrar.test.ts` / `auto-start-last-running.test.ts` 的 `calls[n][m]` 直接索引约定一致）。

4. **destroy 测试简化**：brief 引入 `killSpy` 变量再断言；改为 `expect(child.kill).toHaveBeenCalled()`（与 `warm-pool.test.ts` 同断言模式，减少无谓中间变量）。

5. **destroy 反注册 handler**：实现里 `destroy()` 不仅 release runtime，还显式 `child.off('message', handler)` 反注册（brief 实现未做）。虽 v1 release 即 kill 子进程（handler 随之消失），但显式 off 是防御性的——v2 若 release 改为归还池而非 kill，不 off 会导致已释放 runtime 的 handler 泄漏。

## 顾虑 / 后续 task 需关注

1. **chunk 转发未实现**：AgentRunner 当前只监听 end/error 做 release，**不负责**把 thinking/text/tool_call 等 chunk 转发给 renderer。brief 注释说"chunk 转发逻辑由 runtime-spawner 统一处理（已注册）"——后续 runtime-spawner task 需在 spawn 时注册全局 chunk 转发 handler。若 runtime-spawner 未实现，AgentRunner 单独跑时 renderer 收不到中间 chunk（只有 end）。

2. **task-ack 未消费**：mock 子进程在收到 task-config 后回 `task-ack`，但 AgentRunner 不等候 ack（fire-and-forget）。当前测试的 ack 只是模拟行为，实现未读。若后续需要"确认子进程已开始处理 task"语义，需扩展 executeTask 为 await ack。

3. **错误路径未测**：4 个 it 未覆盖 `acquire` 失败（spawn 抛错）、`child.send` 失败（EPIPE / connected=false）、message handler 抛错等异常路径。v1 可接受（warmPool.release 内部已 try/catch kill），但生产化时需补。

4. **destroy 不销毁 warmPool**：设计如此（warmPool 共享），但若 AgentRunner 是 warmPool 的唯一使用者，外层需另行调 `warmPool.destroyAll()`，否则池内 runtime 泄漏。后续 task 负责编排。

5. **per-agent 并发=1 未强制**：`activeTaskCount()` 只读不拦。v1 串行约束需上层（消息路由层）在调 executeTask 前检查 `activeTaskCount() < maxConcurrent`。max_concurrent_tasks 字段已在 D1 migration v21 加入 DB，但 AgentRunner 自身不读它。
