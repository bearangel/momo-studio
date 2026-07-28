# AgentPlatform M3 — 安全加固 + Git Policy 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**目标：** Agent 崩溃自动恢复 + LLM 调用重试 + 工具调用审计 + Git commit 规则校验 + OS 级沙箱 + 遗留 bug 修复。

**架构：** 在 M2 基础上增加：runtime-manager 的崩溃重启逻辑（circuit breaker）、llm-provider 的指数退避重试、tool_calls 审计表 + executeTool 插桩、git policy 配置 + commit 校验、SandboxProvider 抽象（Linux namespace + macOS sandbox-exec）。

**技术栈：** 无新依赖。沙箱用 OS 原生工具（unshare/sandbox-exec）。

## 全局约束

继承 M0-M2 全部约束。新增：

- **OS 沙箱仅 Linux + macOS**（Windows 推迟到 v2）。
- **审计日志仅记录操作级元数据**（tool name, duration, success），不记录输入/输出完整内容（避免膨胀）。
- **Git policy 仅支持 strict / warning / none 三级**。
- **LLM 重试最多 3 次**，指数退避（1s → 2s → 4s）。
- **Agent 崩溃重启上限 3 次**，之后标记 error 不再自动重启。
- 代码注释用中文。工作目录 `/workspace`。

## 文件结构（新增/修改）

```
electron/src/main/
├── agent/
│   ├── runtime-manager.ts       # 修改：崩溃重启 + circuit breaker
│   ├── llm-provider.ts          # 修改：指数退避重试
│   ├── builtin-tools.ts         # 修改：executeTool 插桩审计
│   └── tool-audit.ts            # 新：审计日志记录
├── sandbox/
│   ├── types.ts                 # SandboxProvider 接口
│   ├── linux-sandbox.ts         # Linux namespace 实现
│   ├── macos-sandbox.ts         # macOS sandbox-exec 实现
│   ├── fallback-sandbox.ts      # 无沙箱兜底（开发用）
│   └── index.ts                 # 平台分发
├── workspace/
│   ├── git-policy.ts            # 新：commit message 校验
│   └── allocation.ts            # 修改：Layer 2 接线到 runtime
├── storage/migrations/
│   └── index.ts                 # 修改：006 迁移（tool_calls + git_policy 表）
└── ipc/
    └── index.ts                 # 修改：注册新 handlers

renderer/src/
├── components/
│   ├── settings/
│   │   ├── GitPolicySettings.tsx # Git 规则配置
│   │   └── AuditLog.tsx          # 审计日志查看
│   └── agent/
│       └── PermissionsPanel.tsx   # 工具权限白名单
└── ipc/
    └── types.ts                  # 修改：审计/policy API
```

---

## Task 1: Agent 崩溃自动重启 + Circuit Breaker

**文件：**
- 修改: `electron/src/main/agent/runtime-manager.ts`
- 测试: `electron/tests/agent/runtime-manager-restart.test.ts`

**接口：**
- 产出: agent 子进程崩溃后自动重启（最多 3 次，间隔递增）；超过上限标记 error 不再重启

- [ ] **Step 1: 在 runtime-manager.ts 添加崩溃重启逻辑**

在文件中添加：

```typescript
// 崩溃重启配置
const MAX_RESTART_ATTEMPTS = 3;
const RESTART_DELAYS_MS = [2000, 5000, 10000]; // 递增延迟

// 每个 agent 实例的重启计数
const restartCounts = new Map<string, { count: number; timer: NodeJS.Timeout | null }>();

/** 在 spawnAgent 的 child.on('exit') handler 中调用 */
function handleAgentExit(instanceId: string, code: number | null, opts: AgentRuntimeOpts): void {
  runtimes.delete(instanceId);
  logger.warn('Agent 子进程退出', { instanceId, code });

  // 正常退出（code=0）不重启
  if (code === 0) {
    restartCounts.delete(instanceId);
    return;
  }

  // 检查 circuit breaker
  const state = restartCounts.get(instanceId) ?? { count: 0, timer: null };
  if (state.count >= MAX_RESTART_ATTEMPTS) {
    logger.error('Agent 达到崩溃重启上限，不再自动重启', {
      instanceId, attempts: state.count,
    });
    // TODO: 通过 IPC 通知 UI
    return;
  }

  const delay = RESTART_DELAYS_MS[state.count] ?? 10000;
  state.count++;
  logger.info('Agent 将在崩溃后重启', {
    instanceId, attempt: state.count, delayMs: delay,
  });

  state.timer = setTimeout(() => {
    // 重新 spawn（复用原有 opts）
    try {
      doSpawnAgent(opts);
      logger.info('Agent 重启成功', { instanceId, attempt: state.count });
    } catch (err) {
      logger.error('Agent 重启失败', { instanceId, error: (err as Error).message });
    }
  }, delay);

  restartCounts.set(instanceId, state);
}

/** 手动重置 circuit breaker（用户在 UI 点"重启"时调用）*/
export function resetRestartCount(instanceId: string): void {
  const state = restartCounts.get(instanceId);
  if (state?.timer) clearTimeout(state.timer);
  restartCounts.delete(instanceId);
}
```

修改 `spawnAgent`（重命名为 `doSpawnAgent`，内部使用）+ 暴露公共 `spawnAgent` 包装：

```typescript
export function spawnAgent(opts: AgentRuntimeOpts): void {
  resetRestartCount(opts.instanceId); // 用户主动启动时重置计数
  doSpawnAgent(opts);
}

function doSpawnAgent(opts: AgentRuntimeOpts): void {
  // ... 已有 fork 逻辑 ...
  // child.on('exit') 改为调用 handleAgentExit：
  child.on('exit', (code, signal) => {
    handleAgentExit(opts.instanceId, code, opts);
  });
}
```

- [ ] **Step 2: 写测试**

```typescript
// electron/tests/agent/runtime-manager-restart.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
// 测试：模拟子进程快速退出 → 验证重启计数 + circuit breaker
// 测试：正常退出（code=0）不重启
// 测试：达到 3 次后不再重启
// 用 setBinaryOverride 注入假 entry（快速退出的假进程）
```

- [ ] **Step 3: 运行测试 + 提交**

```bash
cd electron && npx pnpm@9.0.0 vitest run tests/agent/runtime-manager-restart.test.ts
git add electron/src/main/agent/runtime-manager.ts electron/tests/agent/runtime-manager-restart.test.ts
git commit -m "feat(agent): 崩溃自动重启 + circuit breaker（3 次后暂停）"
```

---

## Task 2: LLM 指数退避重试

**文件：**
- 修改: `electron/src/main/agent/llm-provider.ts`
- 测试: `electron/tests/agent/llm-provider-retry.test.ts`

**接口：**
- 修改: `LLMProvider.chat()` 内部加重试逻辑（对外接口不变）
- 重试条件：HTTP 429 / 500 / 503 / fetch 抛错（含超时）
- 不重试：400 / 401 / 403（客户端错误，重试无意义）

- [ ] **Step 1: 在 llm-provider.ts 添加重试包装**

```typescript
const MAX_LLM_RETRIES = 3;
const RETRY_DELAYS_MS = [1000, 2000, 4000];
const RETRYABLE_STATUS = new Set([429, 500, 502, 503]);

/** 带指数退避重试的 fetch 包装 */
async function fetchWithRetry(
  url: string,
  options: RequestInit,
  maxRetries: number = MAX_LLM_RETRIES,
): Promise<Response> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(url, options);
      if (response.ok || !RETRYABLE_STATUS.has(response.status)) {
        return response; // 成功或不可重试的错误
      }
      // 可重试的 HTTP 错误
      lastError = new Error(`HTTP ${response.status}`);
    } catch (err) {
      lastError = err as Error;
    }
    // 最后一次不等待
    if (attempt < maxRetries) {
      const delay = RETRY_DELAYS_MS[attempt] ?? 4000;
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastError ?? new Error('LLM 请求失败（重试耗尽）');
}
```

把 OpenAIProvider 和 AnthropicProvider 中的 `await fetch(...)` 替换为 `await fetchWithRetry(url, options)`。

- [ ] **Step 2: 写测试**

```typescript
// 测试：mock fetch 第一次返回 429，第二次返回 200 → 应成功
// 测试：mock fetch 三次都返回 500 → 第四次不调用，抛错
// 测试：mock fetch 返回 400 → 不重试，直接返回
// 测试：mock fetch 抛 AbortError（超时）→ 重试
```

- [ ] **Step 3: 运行 + 提交**

```bash
npx pnpm@9.0.0 vitest run tests/agent/llm-provider-retry.test.ts
git add electron/src/main/agent/llm-provider.ts electron/tests/agent/llm-provider-retry.test.ts
git commit -m "feat(agent): LLM 指数退避重试（3 次，1s→2s→4s）"
```

---

## Task 3: tool_calls 审计表 + 插桩

**文件：**
- 修改: `electron/src/main/storage/migrations/index.ts`（添加 006 迁移）
- 创建: `electron/src/main/agent/tool-audit.ts`
- 修改: `electron/src/main/agent/runtime-entry.ts`（在 executeTool 中插桩）

- [ ] **Step 1: 添加 006 迁移**

```typescript
{
  version: 6,
  sql: `
CREATE TABLE IF NOT EXISTS tool_calls (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  agent_bot_user_id TEXT NOT NULL,
  task_id TEXT,
  tool_name TEXT NOT NULL,
  input_summary TEXT NOT NULL DEFAULT '',
  output_summary TEXT NOT NULL DEFAULT '',
  success INTEGER NOT NULL DEFAULT 1,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  timestamp TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tool_calls_workspace_ts ON tool_calls(workspace_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_tool_calls_agent ON tool_calls(agent_bot_user_id);
`.trim(),
},
```

- [ ] **Step 2: 实现 `tool-audit.ts`**

```typescript
// electron/src/main/agent/tool-audit.ts
// 注意：runtime-entry 在子进程中运行，不能直接 import 主进程的 DB 模块。
// 审计日志通过 IPC 发送到主进程写入（类似 MCP 调用的 IPC 桥接）。

/** 子进程 → 主进程：请求记录审计日志 */
export function logToolCall(opts: {
  toolName: string;
  inputSummary: string;
  outputSummary: string;
  success: boolean;
  durationMs: number;
}): void {
  process.send?.({
    type: 'audit:toolCall',
    toolName: opts.toolName,
    inputSummary: opts.inputSummary.slice(0, 500), // 截断
    outputSummary: opts.outputSummary.slice(0, 500),
    success: opts.success,
    durationMs: opts.durationMs,
  });
}
```

- [ ] **Step 3: 在 runtime-entry.ts 的 executeTool 中插桩**

```typescript
async function executeTool(call, ctx, client, config): Promise<string> {
  const startTime = Date.now();
  let success = true;
  let result = '';
  try {
    result = await doExecuteTool(call, ctx, client, config);
    return result;
  } catch (err) {
    success = false;
    result = (err as Error).message;
    throw err;
  } finally {
    logToolCall({
      toolName: call.name,
      inputSummary: JSON.stringify(call.arguments).slice(0, 500),
      outputSummary: result.slice(0, 500),
      success,
      durationMs: Date.now() - startTime,
    });
  }
}
```

把原 executeTool 的 switch 逻辑提取为 `doExecuteTool`，在新 `executeTool` 包装中加审计。

- [ ] **Step 4: 在 runtime-manager.ts 添加审计 IPC 桥接**

```typescript
child.on('message', (msg) => {
  const m = msg as { type: string; [k: string]: unknown };
  if (m.type === 'audit:toolCall') {
    const { randomUUID } = require('node:crypto');
    getDb().prepare(
      `INSERT INTO tool_calls (id, workspace_id, agent_bot_user_id, tool_name, input_summary, output_summary, success, duration_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      randomUUID(), opts.workspaceId, opts.botUserId,
      m.toolName, m.inputSummary, m.outputSummary,
      m.success ? 1 : 0, m.durationMs,
    );
  }
  // ... 已有 MCP 处理 ...
});
```

- [ ] **Step 5: 提交**

```bash
git add -A
git commit -m "feat(audit): tool_calls 审计表 + executeTool 插桩"
```

---

## Task 4-6: Git Policy（大纲）

### Task 4: Git policy 配置类型 + 迁移

**创建：** `workspace/git-policy.ts` + 007 迁移（`git_policies` 表）

**要点：**
- `GitPolicy` 接口：`allowAgentCommits`, `commitMessage.template`, `.patterns[]`, `.validation`, `.trailers[]`
- SQLite 表：`git_policies(workspace_id PK, config_json TEXT)`
- IPC: `gitPolicy:get(wsId)`, `gitPolicy:set(wsId, policy)`
- 默认 policy: `allowAgentCommits=true, validation='none'`

### Task 5: Commit message 校验

**创建：** `workspace/commit-validator.ts`

**要点：**
- `validateCommitMessage(message, policy): { valid, error? }`
- 按 patterns 逐条 regex 匹配
- strict → 拒绝不合规 commit；warning → commit 但 IM 通知；none → 不校验
- trailers 自动附加（Agent-Bot / Task-ID / Triggered-By）

### Task 6: Git policy IPC + UI

**创建：** `renderer/src/components/settings/GitPolicySettings.tsx`

**要点：**
- settings 视图中添加 Git Policy 配置面板
- 可编辑：template, patterns, validation level
- 实时预览：输入示例 commit message → 显示是否合规

---

## Task 7-8: 审计日志 UI（大纲）

### Task 7: 审计日志查询 IPC

**创建：** `audit/ipc.handlers.ts`

**要点：**
- `audit:getToolCalls(wsId, limit, offset)` — 分页查询
- `audit:getByAgent(wsId, agentBotId)` — 按 agent 筛选
- 返回最近 100 条 + 支持时间范围筛选

### Task 8: 审计日志 UI

**创建：** `renderer/src/components/settings/AuditLog.tsx`

**要点：**
- settings 视图中添加审计日志面板
- 表格显示：时间、agent、工具名、成功/失败、耗时
- 可按 agent / 工具名筛选

---

## Task 9-11: OS 级沙箱（大纲）

### Task 9: SandboxProvider 接口

**创建：** `sandbox/types.ts` + `sandbox/index.ts`

**要点：**
```typescript
export interface SandboxProvider {
  spawn(opts: {
    runtime: 'node';
    entry: string;
    env: Record<string, string>;
    workspaceDir: string;
    network: { allowDomains: string[] };
    resources: { memoryMB: number; cpuPercent: number };
  }): SandboxProcess;
}
```
- 平台分发：`process.platform === 'linux'` → LinuxSandbox; `'darwin'` → MacSandbox; else → FallbackSandbox

### Task 10: Linux namespace 沙箱

**创建：** `sandbox/linux-sandbox.ts`

**要点：**
- 用 `child_process.exec('unshare --mount --pid --user --map-root-user ...')` 包装 fork
- bind-mount workspace 目录到沙箱内
- cgroups v2 限制内存/CPU
- **M3 简化**：仅 mount namespace + bind-mount（不做完整 cgroups/pid/net 隔离）

### Task 11: macOS sandbox-exec

**创建：** `sandbox/macos-sandbox.ts`

**要点：**
- 生成 Seatbelt profile（临时文件）
- `sandbox-exec -p <profile> -- node <entry>`
- profile 允许 workspace 目录 + 网络（LLM API 域名）
- **M3 简化**：仅文件隔离（不做完整 IPC/进程隔离）

---

## Task 12-14: 遗留修复 + 收尾（大纲）

### Task 12: isPackaged() 修复 + macOS 外部 Conduwuit

**修改：** `conduit/binary-path.ts` + `conduit/manager.ts` + onboarding

**要点：**
- `isPackaged()` 改为检查 `process.defaultApp`（Electron dev 模式标志）
- macOS 上跳过内置 Conduit 启动，改为连接外部（配置 homeserverUrl）
- Onboarding 添加"连接外部 homeserver"模式

### Task 13: mergeCapabilities Layer 2 接线

**修改：** `agent/ipc.handlers.ts`（addToWorkspace / assignMain / start）

**要点：**
- spawnAgent 前调用 `getAllocation(workspaceId)` + `mergeCapabilities(def, allocation)`
- 合并后的 tools/mcps/skills 传入 RuntimeConfig
- 用户在 CapabilityConfig UI 添加的 workspace 级能力真正生效

### Task 14: 工具权限白名单 UI + 强制执行

**创建：** `renderer/src/components/agent/PermissionsPanel.tsx`

**要点：**
- 在 agent 详情面板显示/编辑 permissions.tools.allowed/denied
- runtime-entry 的 executeTool 检查白名单
- UI 实时预览可用工具列表

---

## 自审

### Spec 覆盖

| Spec M3 要求 | 对应 Task |
|---|---|
| WorkspaceFS 完整实现 | ✅ 已在 M1+review fix 完成 |
| macOS sandbox-exec | T11 |
| 工具权限白名单 UI + 强制执行 | T14 |
| 审计日志 SQLite + UI | T3, T7-T8 |
| Commit message 规则校验 | T4-T6 |
| Agent 崩溃自动重启 | T1 |
| Onboarding 完整流程 | T12 |
| 修复 isPackaged() | T12 |
| 修复 macOS 外部 Conduwuit | T12 |
| LLM retry/backoff (review 补充) | T2 |
| tool_calls 审计 (review 补充) | T3 |
| Layer 2 接线 (review 补充) | T13 |

### 验收标准

- ✅ Agent 崩溃后 2-10s 内自动重启，3 次后停止
- ✅ LLM 429/500 自动重试 3 次
- ✅ 每次工具调用记录到 tool_calls 表
- ✅ Git commit message 可配置 strict/warning/none 规则
- ✅ macOS sandbox-exec 隔离 agent 文件访问
- ✅ mergeCapabilities 接线后 workspace 级能力生效
