# Task 8 + 9 合并报告

## 1. Status: DONE

## 2. Commits

```
fdf0a2e feat(renderer): UI 组件统一改读 assignment.lastRunning
87fcba5 refactor(renderer): 删除 agent.store 的 running state + syncRunningStates
```

Base: `fdfa700`

## 3. Test Summary

### Renderer (vitest)
```
 Test Files  50 passed (50)
      Tests  407 passed (407)
   Duration  9.00s
```

### Electron (vitest)
```
 Test Files  132 passed (132)
      Tests  870 passed (870)
   Duration  33.66s
```

## 4. Typecheck Output

```
electron typecheck$ tsc --noEmit
renderer typecheck$ tsc --noEmit
electron typecheck: Done
renderer typecheck: Done
```

双 workspace clean。

## 5. Self-Review Notes

### Brief 遗漏的文件（4 个源文件 + 1 个测试文件）

grep 发现 brief 只列了 4 个源文件，实际有 **8 个源文件 + 7 个测试文件** 引用 `running`/`syncRunningStates`。以下文件 brief 未提及，但必须修改否则 typecheck/test 失败：

| 文件 | 变更说明 |
|------|---------|
| `renderer/src/components/agent/AgentOrchestrator.tsx` | 编排视图 3 处 `running[id]` → `a.lastRunning` |
| `renderer/src/components/agent/AssignmentCapabilitiesDialog.tsx` | 删除 `syncRunningStates` + `running` store selector；改为读 `assignment.lastRunning` prop |
| `renderer/src/components/im/MessageInput.tsx` | `running[a.instanceId]` → `a.lastRunning` |
| `renderer/src/components/layout/MainLayout.tsx` | `onRuntimeChanged` 回调从 `syncRunningStates()` 改为 `loadAssignments(activeWsId)` |
| `renderer/src/components/agent/DefinitionEditor.test.tsx` | 移除 `running: {}` + `syncRunningStates: vi.fn()` |
| `renderer/src/components/agent/AddToWorkspaceDialog.test.tsx` | 同上 |
| `renderer/tests/components/im/MentionInput.test.tsx` | fixture 加 `lastRunning: true` |

### 测试 fixture 更新策略

- **`MembersPanel.test.tsx`**: mock 从 `vi.fn(() => ({ assignments, running }))` 改为 selector 模式 `vi.fn((selector) => selector({ assignments }))`，删除 `mockRunning`。
- **`AssignmentCapabilitiesDialog.test.tsx`**: 删除 `setRunning()` helper（之前 `useAgentStore.setState({ running: {...} })`）。改为在 `buildAssignment()` 传 `lastRunning` prop：`buildAssignment({ lastRunning: false })`。
- **`agent.store.test.ts`**: stopAgent 测试改为 mock `listAssignments.mockResolvedValueOnce([stoppedAssignment])` 验证 reload 逻辑；assignMainAgent 测试从检查 `running[]` 改为检查 `assignments.find(...).lastRunning`。
- **4 个 `.setState({...})` 桩**（DefinitionEditor/AddToWorkspaceDialog/WorkspaceAgentsPanel/AssignmentCapabilitiesDialog test）：统一删除 `running: {}` 和 `syncRunningStates: vi.fn()` 行。

### MainLayout.tsx 的特殊处理

`MainLayout` 原先在 `onRuntimeChanged` 回调中调用 `syncRunningStates()`。删除该方法后，改为 `useWorkspaceStore.getState().getActive()` + `loadAssignments(ws.id)`。在回调内用 `getState()` 而非 hook selector，避免 effect 依赖 `activeWorkspace` 导致频繁 re-subscribe。

### AssignmentCapabilitiesDialog.tsx 的设计决策

原先 `running` 从 store 的 `running[instanceId]` 读取（reactive，dialog 打开后由 `syncRunningStates` useEffect 刷新）。新方案改为直接读 `assignment.lastRunning` prop。assignment 对象由父组件传入（父组件通过 `loadAssignments` 定期刷新），dialog 打开时 prop 已含最新 lastRunning。移除了 `syncRunningStates` useEffect。

## 6. Files Touched

### Commit 1 (87fcba5 — T8 store)
- `renderer/src/stores/agent.store.ts`
- `renderer/src/stores/agent.store.test.ts`

### Commit 2 (fdf0a2e — T9 UI + tests)
- `renderer/src/components/im/MentionInput.tsx`
- `renderer/src/components/im/MembersPanel.tsx`
- `renderer/src/components/im/MembersPanel.test.tsx`
- `renderer/src/components/im/MessageInput.tsx`
- `renderer/src/components/agent/WorkspaceAgentsPanel.tsx`
- `renderer/src/components/agent/WorkspaceAgentsPanel.test.tsx`
- `renderer/src/components/agent/AgentOrchestrator.tsx`
- `renderer/src/components/agent/AssignmentCapabilitiesDialog.tsx`
- `renderer/src/components/agent/AssignmentCapabilitiesDialog.test.tsx`
- `renderer/src/components/agent/DefinitionEditor.test.tsx`
- `renderer/src/components/agent/AddToWorkspaceDialog.test.tsx`
- `renderer/src/components/layout/MainLayout.tsx`
- `renderer/tests/components/im/MentionInput.test.tsx`
