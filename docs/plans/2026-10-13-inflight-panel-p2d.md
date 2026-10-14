# P2-D 实施计划：在途任务面板（D5）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 会话内随时查看 / 取消全部在途 dispatch 链——回答「现在有几个 agent 在跑、停得掉吗」。

**Architecture:** 主进程 `dispatch:listInFlight`（registry `listInFlight` + agent 名解析）供数据；renderer 会话头部工具条新 IconButton + 徽标 + 绝对定位卡片（打开期间 2s 轮询刷新——零新推送通道、零契约风险）；单链取消复用 P0-B `dispatch:cancelChain`。依赖 P0-B 已合入。

**Tech Stack:** 同前。**Spec:** `docs/specs/2026-10-13-dispatch-receipt-and-interrupt-cascade-design.md`（§9 D5）

## Global Constraints

- 同 P0-A；IPC 双端成对 + 契约测试（boundary 规则 4）
- UI 全语义 token / lucide 图标；原子组件优先（IconButton / Badge）

## Review Focus

1. **空在途**（无链运行）→ 面板显示空态文案，徽标隐藏——Task D2 测试
2. **面板打开期间链终态**（轮询窗口内自然完成）→ 下一轮刷新从列表消失，无僵尸行——Task D2 测试
3. **取消后乐观态与轮询真值打架**（cancelChain 返回 cancelled 但轮询仍见 in_flight 一拍）→ 以轮询真值覆盖，不锁死乐观态——Task D2 测试
4. **subAgentName 解析失败**（成员已删）→ 显示 `null` 时降级短 taskId，不渲染空白行——Task D1/D2 测试
5. **组件卸载计时器泄漏**（面板关闭/会话切换）→ interval 清理——Task D2 测试

---

### Task D1: listInFlight 数据面（主进程 + agent 名解析）

**Files:**
- Modify: `electron/src/main/agent/interrupt-ipc.ts`（Task B2 文件——listInFlight deps 落地真实现）
- Modify: `renderer/src/ipc/types.d.ts`（若 B2 未含 InFlightChainView 则此处定型）
- Modify: `electron/tests/agent/interrupt-ipc.test.ts`

**Interfaces:**
- Consumes: `dispatchRegistry.listInFlight`（Task B1）
- Produces: `InFlightChainView = { taskId: string; round: number; sessionId: string; subAgentName: string | null; subStreamSessionId?: string; startedAt: number }`；`ipc.dispatch.listInFlight({ sessionId? })`

- [ ] **Step 1: 失败测试**

interrupt-ipc.test.ts 追加：registry 种子两链（一 in_flight 一 done）→ listInFlight 只返 in_flight；subAssignmentId 经 `workspace_agent_members` 反查 `agent_user_id` → 名映射（沿用 session-tools 的 byUserId 映射数据源；成员不存在 → `subAgentName: null`）；sessionId 过滤生效。

- [ ] **Step 2: 实现（router-bootstrap 注入 deps 处）**

```ts
  // interrupt-ipc deps.listInFlight 真实现（spec §9）：
  // registry 在途链 → 主进程解析子 agent 展示名（成员已删返回 null，UI 降级短 taskId）
  listInFlight: (sessionId?: string) =>
    dispatchRegistry.listInFlight(sessionId).map((c) => ({
      taskId: c.taskId,
      round: c.round,
      sessionId: c.sessionId,
      subAgentName: resolveAgentName(c.subAssignmentId), // workspace_agent_members 反查（照 session-tools byUserId 同源）
      ...(c.subStreamSessionId !== undefined ? { subStreamSessionId: c.subStreamSessionId } : {}),
      startedAt: c.startedAt,
    })),
```

- [ ] **Step 3: 通过 + 双 typecheck + Commit**

```bash
git add electron/src/main/agent/interrupt-ipc.ts electron/tests/agent/interrupt-ipc.test.ts renderer/src/ipc/types.d.ts
git commit -m "feat: dispatch:listInFlight 在途链视图（含子 agent 名解析）"
```

---

### Task D2: InFlightPanel 组件与会话头部接线

**Files:**
- Create: `renderer/src/components/im/InFlightPanel.tsx` + `.test.tsx`
- Modify: `renderer/src/components/layout/MiddlePanel.tsx`（与 TaskProgressButton 同一工具行接入）

**Interfaces:**
- Consumes: `ipc.dispatch.listInFlight` / `ipc.dispatch.cancelChain`（P0-B）；`InFlightChainView`（Task D1）

- [ ] **Step 1: 失败测试（Review Focus 五项全覆盖）**

```tsx
// renderer/src/components/im/InFlightPanel.test.tsx
// ipc mock 收窄在 IPC 边界（vi.mock ipc client），列表数据用真实形状 InFlightChainView。
it('空在途 → 按钮无徽标，卡片空态文案');
it('打开面板 → 拉取 + 2s 轮询；卸载清理 interval（vi.useFakeTimers 断言 clearInterval）');
it('链行：名 + 短 taskId + 轮次 + 运行时长 + 取消按钮；subAgentName null → 降级短 taskId');
it('取消 → cancelChain 调用；轮询下一拍以真值覆盖（in_flight 消失即从列表移除）');
```

- [ ] **Step 2: 实现（组件骨架）**

```tsx
// renderer/src/components/im/InFlightPanel.tsx
//
// 在途任务面板（spec §9）：会话头部入口 + 徽标在途数 + 打开期间 2s 轮询刷新。
// 单链取消复用 dispatch:cancelChain；轮询真值优先于乐观态。
import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, Square, Zap } from 'lucide-react';
import { ipc } from '../../ipc/client';
import type { InFlightChainView } from '../../ipc/types';

export function InFlightPanel({ sessionId }: { sessionId: string }) {
  const [open, setOpen] = useState(false);
  const [chains, setChains] = useState<InFlightChainView[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    const rows = await ipc.dispatch.listInFlight({ sessionId });
    setChains(rows);
  }, [sessionId]);

  useEffect(() => {
    if (!open) return;
    void refresh();
    timerRef.current = setInterval(() => void refresh(), 2000);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [open, refresh]);

  return (
    <div className="relative">
      <button
        type="button"
        aria-label={`在途任务 ${chains.length} 个`}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="relative inline-flex cursor-pointer items-center text-secondary hover:text-primary"
      >
        <Zap size={16} strokeWidth={1.75} aria-hidden />
        {open === false && chains.length > 0 && (
          <span className="absolute -right-1.5 -top-1.5 inline-flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-status-error px-0.5 text-[9px] font-medium text-status-error-foreground">{chains.length}</span>
        )}
      </button>
      {open && (
        <div className="absolute right-0 top-7 z-20 w-72 rounded border border-subtle bg-surface-1 p-2 shadow-lg">
          <p className="mb-1.5 text-xs font-medium text-primary">在途子任务（{chains.length}）</p>
          {chains.length === 0 && <p className="py-2 text-center text-xs text-tertiary">当前没有运行中的子任务</p>}
          {chains.map((c) => (
            <div key={c.taskId} className="flex items-center gap-1.5 rounded px-1 py-1 text-xs hover:bg-surface-active">
              <Loader2 size={11} strokeWidth={1.75} aria-hidden className="animate-spin text-accent-500" />
              <span className="text-secondary">{c.subAgentName ?? c.taskId.slice(0, 8)}</span>
              <span className="text-tertiary">第 {c.round} 轮</span>
              <span className="ml-auto text-tertiary">{Math.round((Date.now() - c.startedAt) / 60000)}m</span>
              <button
                type="button"
                aria-label={`停止 ${c.subAgentName ?? c.taskId.slice(0, 8)} 的任务`}
                className="cursor-pointer text-tertiary hover:text-status-error"
                onClick={() => void ipc.dispatch.cancelChain({ taskId: c.taskId })}
              >
                <Square size={11} strokeWidth={1.75} aria-hidden />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
```

（时长行静态渲染即可，2s 轮询自然刷新；MiddlePanel 工具行 `<InFlightPanel sessionId={activeSessionId} />` 接在 TaskProgressButton 旁。）

- [ ] **Step 3: 通过 + Commit**

Run: `cd renderer && npx pnpm@9.0.0 vitest run src/components/im/InFlightPanel.test.tsx` → PASS

```bash
git add renderer/src/components/im/InFlightPanel.tsx renderer/src/components/im/InFlightPanel.test.tsx renderer/src/components/layout/MiddlePanel.tsx
git commit -m "feat: 会话内在途任务面板（2s 轮询 + 单链取消）"
```

---

### Task D3: 全量验证 + App 级验收

- [ ] **Step 1: 全量**

```bash
npx pnpm@9.0.0 typecheck
npx pnpm@9.0.0 test
```

- [ ] **Step 2: App 级验收（momo-acceptance 技能，spec §11.5-18 终检）**

隔离实例 + CDP 接管回放 spring-mcp 场景：派发 → 面板见在途 → 单链停 → 回合停 → 重启 → 三症状（计数不含子链 / 停不死 / 回执漂移重复）全部消失，产出 `.omo/qa-reports/` 报告。

- [ ] **Step 3: Commit（验收修缮如有）**

```bash
git add -A && git commit -m "test: 在途面板全量验证与 App 级验收收口"
```
