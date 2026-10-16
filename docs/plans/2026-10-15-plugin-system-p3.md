# 插件系统 P3 实施计划：hooks 事件总线 + service 长驻组件

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地插件系统 P3（spec §5）——HookBus 类型化事件总线（15 事件 × emit/parallel/waterfall 三分发）、hooks.json 主进程 JS handler、preToolUse 跨进程拦截（插件 waterfall → 内置权限 → 执行）、service 长驻组件（start/stop/handle RPC + `pluginCtx.callService`）、hook 审计落库。「管得深：插件参与工具治理与生命周期」。

**Architecture:** 三桥裁定（探索实证）：①`plugin:preToolUse` / `plugin:callService` 走**范式 A**（spawn 闭包 messageHandler + id 配对 + 子进程超时兜底——mcp-bridge 同构，先例 `requestMcpCall` 的同步 await 问询）；②`plugin:postToolUse` fire-and-forget（sendStreamChunk 单向先例）；③主进程 handler/service 长驻 → **reload/启停必须显式 `delete require.cache`**（P2 子进程一 task 一进程免除此面，主进程没有此豁免）。HookBus 全事件 fire-and-forget 分发（handler 错误吞日志，绝不拖事务——session/task 信号多处包裹在 `db.transaction()` 内）。storage 层信号挂 repo 单点，依赖方向用模块级 setter 注入（`setBridgeRouter` 先例）。

**Tech Stack:** 同 P1/P2。无新依赖。**本计划零 renderer 改动**（组件清单 UI 已按 manifest 键通用展示——无预览门禁）。

**Spec:** `docs/specs/2026-10-15-plugin-system-design.md` §5（hooks+service）/§4.1（pluginCtx.callService 预留）

## Global Constraints

- 同 P1/P2（Node 20 / TS strict 禁 any / 中文注释与错误 / Conventional Commits / momo-test-rules 保真 / 测试位置规范）
- **fail-open 铁律**：hook 桥在无 IPC 环境（vitest 直调 doExecuteTool 的既有 20+ 测试）必须跳过不阻塞；handler 抛错 = 该订阅者本次跳过 + logger.error，不影响主流程（spec §5.4）
- **事务安全铁律**：HookBus emit 一律异步排队（setImmediate/microtask），storage 层事务内调用不得同步执行 handler（spec 探索实证：insertSession 处于事务内）
- 主进程 require 插件模块前必须先 `delete require.cache[absPath]`（reload/重启用新代码——长驻进程无「进程死即缓存清」豁免）
- preToolUse 决策记 rewrite 后生效 args（审计记实际执行值）

## Review Focus

1. **无 IPC 环境 fail-open**（vitest 直调 doExecuteTool 的既有测试群零破坏）→ T5 测试：process.send undefined → 直通执行
2. **waterfall deny/rewrite 语义**（deny 短路抛错 + rewrite 透传下游 + 审计记改写后 args）→ T5/T6 契约测试
3. **service 崩溃隔离**（handler 抛错不拖垮主进程；callService 拿错误回包）→ T4 测试
4. **reload 后 require cache 失效**（改 service 代码 → reload → 新行为）→ T4 测试：同路径二次 require 返回新模块
5. **事务内 emit 不阻塞**（handler 慢不拖 insertSession 事务）→ T2 测试：emit 同步返回、handler 异步跑

---

### Task 1: 迁移 060（hook_calls 表 + tool_calls.pre_tool_use 列）

**Files:**
- Create: `electron/src/main/storage/migrations/060_plugin_hooks_audit.ts`
- Modify: `storage/migrations/index.ts`
- Test: `electron/tests/storage/migration-060-plugin-hooks.test.ts`

**Interfaces:**
- Produces:
  - `hook_calls` 表：`id TEXT PK / plugin_id TEXT / event TEXT / matcher TEXT NULL / decision TEXT NULL（waterfall 决策 JSON）/ duration_ms INTEGER / success INTEGER / timestamp DEFAULT datetime('now')`
  - `tool_calls.pre_tool_use TEXT NULL`（决策摘要 JSON：`{pluginId, action, rewritten}` 数组或 null=无 hook 参与）

- [ ] **Step 1: RED**——照 058 范式：两表可写断言（hook_calls 插全字段行；tool_calls 带 pre_tool_use 与不带两态）+ version 60 注册锁
- [ ] **Step 2-4: RED→GREEN→tests/storage 回归 → Commit** `feat: 迁移 060 hook_calls 审计表 + tool_calls.pre_tool_use 决策列（spec §5.4）`

---

### Task 2: HookBus 事件总线（纯逻辑，三分发模式）

**Files:**
- Create: `electron/src/main/plugin/hook-bus.ts`
- Test: `electron/tests/plugin/hook-bus.test.ts`

**Interfaces:**
- Produces:

```ts
/** spec §5.1 事件目录（15）——分发模式平台固定 */
export type PluginHookEvent =
  | 'appReady' | 'workspaceOpened' | 'workspaceClosed'
  | 'sessionStarted' | 'sessionEnded'
  | 'preToolUse' | 'postToolUse' | 'postToolUseFailure'
  | 'taskCreated' | 'taskStatusChanged' | 'taskCompleted'
  | 'resourceInstalled' | 'resourceRemoved' | 'pluginEnabled' | 'pluginDisabled';

/** 分发模式：emit=fire-and-forget / parallel=全并发等齐 / waterfall=仅 preToolUse */
export interface HookHandlerModule {
  handle(event: string, pluginCtx: PluginHookCtx, payload: unknown): Promise<HookDecision | null>;
}
export interface HookDecision { action: 'deny' | 'rewrite'; reason?: string; args?: Record<string, unknown> }
export interface HookSubscription { pluginId: string; event: PluginHookEvent; matcher?: string; modulePath: string; handler: HookHandlerModule['handle'] }

export class HookBus {
  register(sub: HookSubscription): void;
  unregisterPlugin(pluginId: string): void;
  /** emit/parallel 模式入口（异步排队，handler 错误吞 logger.error——fail-open） */
  dispatch(event: PluginHookEvent, payload: unknown): void;
  /** waterfall（仅 preToolUse）：洋葱式过全部匹配订阅者，返回聚合决策 */
  async dispatchPreToolUse(payload: { workspaceId: string; toolName: string; args: Record<string, unknown> }): Promise<HookDecision | null>;
  listSubscriptions(pluginId?: string): HookSubscription[];
}
export interface PluginHookCtx { getConfig(): Record<string, unknown>; getDataDir(): string; logger: { warn/info/error(msg, meta?) } }
```

- [ ] **Step 1: RED**——纯逻辑测试（fake handler 函数注入，无 require）：
  1. emit：注册 2 订阅者（1 慢 async + 1 抛错）→ dispatch 同步即刻返回（事务安全），await 微任务刷新后两者都被调用、抛错者不影响另一者（Review Focus #5）
  2. parallel：全并发（Promise.all 顺序无保证断言两者都完成）
  3. waterfall：三层订阅（A rewrite args → B 基于 A 结果再 rewrite → C deny）→ 返回 deny 且 reason 带 C；两层 rewrite 聚合最终 args 为 B 输出；无订阅者 → null
  4. matcher：`git_*` 不匹配 `read_file`、匹配 `git_status`（preToolUse 专属）
  5. unregisterPlugin 后不再分发
- [ ] **Step 2-4: RED→GREEN→Commit** `feat: HookBus 类型化事件总线（15 事件/三分发/fail-open，spec §5.1-5.2）`

---

### Task 3: hooks.json 加载 + handler 主进程 require（含 cache 失效）

**Files:**
- Create: `electron/src/main/plugin/hook-sync.ts`
- Test: `electron/tests/plugin/hook-sync.test.ts`

**Interfaces:**
- Consumes: HookBus（T2）、`resolvePluginRoot`（assembly）
- Produces:
  - `syncPluginHooks(rec: PluginRecord): { registered: number }`——hooks.json 解析 → 逐条 `delete require.cache[abs]` 后 require 模块 → 校验导出 `handle` 函数 → HookBus.register；坏条目（JSON 坏/module 无 handle/require 抛错）逐条 warn 跳过
  - `removePluginHooks(pluginId: string): void`——unregisterPlugin
  - manifest 校验扩展（`manifest.ts`）：`components.hooks` 存在时 hooks.json 必须可解析且 module 路径存在（安装时静态检查——不 require，只验存在性与 JSON 形状）

- [ ] **Step 1: RED**——真实 tmpdir 插件树：合法 hooks.json（2 事件 2 模块）注册数 2 且 HookBus.listSubscriptions 含之；坏 JSON/缺 module 文件/模块抛错各降级跳过；**同路径改写模块内容后二次 syncPluginHooks → dispatch 走到新逻辑**（require cache 失效，Review Focus #4）
- [ ] **Step 2-4: RED→GREEN→Commit** `feat: hooks.json 主进程加载（fail-open 逐条降级 + require cache 失效，spec §5.2）`

---

### Task 4: service 管理器（start/stop/handle + 崩溃隔离 + cache 失效）

**Files:**
- Create: `electron/src/main/plugin/service-manager.ts`
- Test: `electron/tests/plugin/service-manager.test.ts`

**Interfaces:**
- Produces:
  - `startPluginService(rec: PluginRecord): boolean`——manifest 有 components.service 才启动：cache 失效 → require `<root>/<service>/index.js` → `createService(pluginCtx)` → `await start()`；任一步抛错 warn 返回 false（不拖垮安装链）
  - `stopPluginService(pluginId: string): Promise<void>`——`await stop()` + 实例清除；stop 抛错吞日志
  - `callPluginService(pluginId: string, method: string, params: unknown): Promise<unknown>`——无实例抛中文错「插件 service 未运行」；handle 抛错原样 reject（调用方拿错误结果，Review Focus #3）
  - `stopAllPluginServices(): Promise<void>`（app 退出钩）
  - service 的 pluginCtx 与工具侧同形（getConfig/getDataDir/logger——**不含 callService**，防递归）

- [ ] **Step 1: RED**——真实 tmpdir：合法 service（start 记录状态 + handle echo）启动成功可 call；handle 抛错 reject 且下次 call 仍可用（崩溃不拖管理器）；start 抛错返回 false；**改模块重 start 后 call 走新代码**（cache 失效）；stop 后 call 抛「未运行」
- [ ] **Step 2-4: RED→GREEN→Commit** `feat: 插件 service 管理器（start/stop/handle RPC/崩溃隔离/cache 失效，spec §5.3）`

---

### Task 5: 子进程侧桥 + doExecuteTool 插入（preToolUse/postToolUse）

**Files:**
- Create: `electron/src/main/agent/plugin-hook-bridge.ts`（子进程侧：id 配对 + 5s 超时 + 无 process.send 直通）
- Modify: `electron/src/main/agent/runtime-entry.ts`（doExecuteTool 前置 waterfall + postToolUse 通知 + executeTool 审计载荷扩展）
- Modify: `electron/src/main/agent/tools/shared/audit.ts`（ToolCallAudit 加 `preToolUse?: string | null`）
- Test: `electron/tests/agent/plugin-hook-bridge.test.ts` + `electron/tests/agent/runtime-pretool-use.test.ts`

**Interfaces:**
- Produces:
  - `requestPreToolUse(payload): Promise<HookDecision | null>`——无 `process.send` → **立即 null（fail-open，Review Focus #1）**；有 → id 配对等响应，5s 超时 → warn + null（不阻塞工具）
  - `notifyPostToolUse(payload): void`——fire-and-forget（无 send 静默）
  - doExecuteTool 插入（`assertToolAllowed` 之前）：

```ts
const hookDecision = await requestPreToolUse({ workspaceId: config.workspaceId, toolName: name, args: call.arguments });
if (hookDecision?.action === 'deny') {
  throw new Error(`工具 ${name} 被插件钩子拒绝：${hookDecision.reason ?? '未给出原因'}`);
}
if (hookDecision?.action === 'rewrite' && hookDecision.args) {
  call = { ...call, arguments: hookDecision.args };   // 下游与审计均用改写后 args
}
assertToolAllowed(name, config);
// …原执行序列不变；executeTool finally 的 logToolCall 载荷加 preToolUse 决策摘要
```

- [ ] **Step 1: RED**——桥单测（mock process.send/respond：决策回包配对/超时 null/无 send null）+ doExecuteTool 集成测（直调，注入桥 stub：deny 抛错且不执行工具 / rewrite 后 executeToolModule 收新 args / null 直通——**既有 routing 测试群全跑回归**）
- [ ] **Step 2-4: RED→GREEN→Commit** `feat: preToolUse 跨进程拦截（waterfall→内置权限→执行）+ postToolUse 通知 + 决策审计载荷（spec §5.2）`

---

### Task 6: 主进程侧三分支（preToolUse/callService/postToolUse——契约测试）

**Files:**
- Create: `electron/src/main/plugin/hook-bridge-main.ts`（`handlePluginBridgeMsg(msg, respond): Promise<boolean>`——范式 C respond 注入独立导出）
- Modify: `electron/src/main/agent/runtime-spawner.ts`（messageHandler 三分支接线 + 宽松形状）
- Test: `electron/tests/plugin/hook-bridge-main.test.ts`

**Interfaces:**
- Consumes: HookBus.dispatchPreToolUse、callPluginService、hook_calls 插入
- Produces: 线协议三分支：
  - `plugin:preToolUse`（id 配对）→ dispatchPreToolUse → respond `{id, decision}`；决策记 hook_calls
  - `plugin:callService`（id 配对）→ callPluginService → respond `{id, result}` / `{id, error}`
  - `plugin:postToolUse`（无 id）→ HookBus.dispatch + hook_calls 落库（fire-and-forget）
  - 非本族消息返回 false（不消费）

- [ ] **Step 1: RED**——respond 注入直调（mcp-spawner-bridge 契约模板）：三分支各自成功/失败/形状漂移收敛（id 非字符串不消费）断言
- [ ] **Step 2-4: RED→GREEN→runtime-spawner-audit 回归 → Commit** `feat: 插件桥主进程三分支（preToolUse waterfall/callService RPC/postToolUse 审计，spec §5.2-5.3）`

---

### Task 7: 生命周期接线（install/uninstall/setEnabled/reload/退出）+ pluginCtx.callService

**Files:**
- Modify: `plugin/installer.ts`（activateDeclarativeComponents 加 hook-sync + service 段；uninstall 级联加 stop+remove hooks）
- Modify: `plugin/ipc.handlers.ts`（setEnabled → 停起 service + pluginEnabled/Disabled 事件 emit；重载通道不变）
- Modify: `plugin/reload.ts`（重激活顺序：hooks → service → agents/mcp → rebuild）
- Modify: `index.ts`（启动序列：HookBus init（runMigrations 后）+ appReady emit（initTaskDrivenRuntime 后）；before-quit → stopAllPluginServices）
- Modify: `agent/tools/plugin-tools.ts`（PluginToolCtx 加 `callService(method, params): Promise<unknown>`——闭包注入桥引用；子进程桥文件复用 T5 的配对机制发 `plugin:callService`）
- Test: `electron/tests/plugin/lifecycle-p3.test.ts`

- [ ] **Step 1: RED**——install 带 hooks+service 的 fixture → HookBus 有订阅 + service 运行；uninstall → 全清；setEnabled(false) → service 停 + pluginDisabled 事件可观测（HookBus.listSubscriptions 空或标志位）；reload → service 新代码；pluginCtx.callService 从子进程闭包形状（单测桥注入 fake）
- [ ] **Step 2-4: RED→GREEN→installer/reload 回归 → Commit** `feat: hooks+service 生命周期接线（install/uninstall/启停/reload/退出 + callService 注入，spec §5.3）`

---

### Task 8: 事件源接线（15 事件落位）

**Files:**
- Create: `electron/src/main/plugin/event-sources.ts`（`wirePluginEventSources(deps)`：storage 层 setter 注入 + 各信号点调用，fire-and-forget）
- Modify: `storage/tasks/repo.ts`（insertTask/transitionTaskStatus 尾部 dispatch——经注入的 emit 回调，无 HookBus 直接依赖）
- Modify: `storage/sessions/repo.ts`（insertSession/deleteSession 同款）
- Modify: `im/session-ops.ts`（事务外补发点——事务包裹处改为 commit 后 dispatch）
- Modify: `resource/ipc.handlers.ts`（install/delete 成功后）
- Modify: `workspace/ipc.handlers.ts`（create/switch/delete 映射 opened/closed）
- Test: `electron/tests/plugin/event-sources.test.ts`

- [ ] **Step 1: RED**——各信号点 dispatch 断言（mock emit 回调收集）：taskCreated/taskStatusChanged/taskCompleted（transition 三态）/sessionStarted/Ended/resource 两态/workspace 映射三态；**insertSessionWithMembers 事务内不 dispatch、commit 后 dispatch**（Review Focus #5 事务安全）
- [ ] **Step 2-4: RED→GREEN→sessions/tasks 既有域回归 → Commit** `feat: 15 事件源接线（storage setter 注入/事务外分发/workspace 映射，spec §5.1）`

---

### Task 9: 审计闭环（hook_calls 落库 + tool_calls.pre_tool_use 透传）

**Files:**
- Create: `electron/src/main/audit/hook-insert.ts`（insertHookCall）
- Modify: `hook-bridge-main.ts`（T6 分支内落库）、`runtime-spawner.ts` audit 分支（pre_tool_use 透传）、`audit/insert.ts`（InsertToolCallInput.preToolUse）
- Test: `electron/tests/audit/hook-insert.test.ts`（+ tool-call-source.test 扩展）

- [ ] **Step 1: RED→GREEN→Commit** `feat: hook 审计闭环（hook_calls 落库 + pre_tool_use 决策附工具调用，spec §5.4）`

---

### Task 10: 收官——守护 + 真实冒烟 + 账本 + alpha 18

- [ ] typecheck 双 ws + 插件域/agent 域/audit/sessions/tasks 全绿（预存域除外）
- [ ] 真实冒烟（用户在时可用真 LLM；不在则隔离轮）：fixture 升级带 preToolUse hook（deny 指定工具）+ service（echo）→ 会话验证 hook 拦截生效 + callService 通 + hook_calls 审计行；截图/DB 证据入 `.omo/qa-reports/`
- [ ] CHANGELOG P3 条目 + 三处 alpha 17→18
- [ ] Commit `chore: 插件系统 P3 收官（CHANGELOG + alpha 18）`

---

## P3 边界（执行者须知）

- pluginCtx（service 侧）**不含 callService**（防递归）；工具侧才有
- postToolUse 为异步通知（不阻塞工具返回）；postToolUseFailure 复用同通道（success=false 载荷）
- `messageAppended` 高频事件维持排除（spec §5.1）；panel UI 无改动（P4 范围）
- hook 的 settings 展示面板留 P4（与 config 表单同期）
- HookBus 不做优先级排序（注册序即执行序——waterfall 语义确定性由注册序保证）

## Self-Review 记录

- **Spec 覆盖**：§5.1 目录/模式（T2/T8）✓ §5.2 hooks.json+handler+waterfall（T3/T5/T6）✓ §5.3 service+callService（T4/T6/T7）✓ §5.4 审计（T1/T9）✓ §5.4 错误处理（fail-open/崩溃隔离/退避——T2/T4/T5）✓
- **占位符**：T5 核心插入代码块完整；其余各任务锚点+断言清单齐备
- **类型一致性**：HookDecision/HookHandlerModule 在 T2 定义、T3/T5/T6 消费同源；PluginHookCtx 与 PluginToolCtx 同形（service 侧无 callService）
- **Review Focus 落位**：#1/#2→T5、#3→T4、#4→T3/T4、#5→T2/T8
