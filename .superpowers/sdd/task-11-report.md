# Task 11 Report — AddToWorkspaceDialog 加 Layer 3 折叠区

**状态：** ✅ 完成
**Base commit：** `1b855d3`（T10 已合）
**实施日期：** 2026-08-11

---

## 实施摘要

在 AddToWorkspaceDialog 现有流程（选 def → role → parent → API key）的最后追加一个「能力调整（可选）」折叠区，让用户在把 agent 添加到 workspace 时可**可选地**设置 per-assignment 能力 override（Layer 3 deltas）。折叠区默认收起，保持原有简洁流程；展开后内嵌 `CapabilityTabs mode="override"`，提交时计算 deltas 并写入。

同时把 T10 在 `AssignmentCapabilitiesDialog` 内联的能力计算 helper 提取为共享 lib（DRY），并让 `addAgent` 返回新创建的 `AgentAssignment` 以便调用方捕获 `instanceId`。

### 改动文件

| 文件 | 类型 | 说明 |
|---|---|---|
| `renderer/src/lib/capability-helpers.ts` | 新增 | 共享纯函数库：`Capabilities` 类型、`EMPTY_DELTAS`、`defToCapabilities`、`mergeDefault`、`applyDeltas`、`computeDeltas`、`deltasEqual`、新增 `isEmptyDeltas` |
| `renderer/src/components/agent/AddToWorkspaceDialog.tsx` | 修改 | 加 Layer 3 `<details>` 折叠区 + 提交时 computeDeltas + setAssignmentDeltas（非空才调） |
| `renderer/src/components/agent/AddToWorkspaceDialog.test.tsx` | 新增 | 5 个测试用例（TDD） |
| `renderer/src/components/agent/AssignmentCapabilitiesDialog.tsx` | 修改 | 删除内联 helper，改 import 共享 lib（行为不变） |
| `renderer/src/components/agent/CapabilityTabs.tsx` | 修改 | `Capabilities` 类型移到 lib，本地 import + re-export 保持现有 `import { type Capabilities } from './CapabilityTabs'` 不破 |
| `renderer/src/stores/agent.store.ts` | 修改 | `addAgent` 返回类型 `Promise<void>` → `Promise<AgentAssignment>`，return 新 assignment |
| `renderer/src/stores/agent.store.test.ts` | 修改 | 加 1 条用例：addAgent 返回新建 assignment |

---

## TDD 步骤输出

### Step 1（RED）— 写失败测试

**Task 11a：addAgent 返回 assignment（前置）**
- 新增 `agent.store.test.ts` 用例「addAgent 返回新创建的 AgentAssignment」
- RED 确认：`Received: undefined`（addAgent 当时返回 void）

**Task 11b：AddToWorkspaceDialog Layer 3 折叠区**
- 新建 `AddToWorkspaceDialog.test.tsx`，5 个用例：
  1. 默认收起：summary 在，read_file checkbox 不在
  2. 点击 summary 展开 → CapabilityTabs checkbox 出现
  3. 展开后显示 override 模式默认值提示（def + ws allocation 合集，read_file + grep 都勾选）
  4. 改工具（勾 bash）后保存 → setAssignmentDeltas 收到 `instanceId='inst-new'` + `addedTools=['bash']`
  5. 不展开直接保存 → deltas 全空，setAssignmentDeltas 不被调用
- RED 确认：4 failed | 1 passed（summary 文本找不到 → 4 个 capability 用例全红；第 5 个因当前代码从不调 setAssignmentDeltas 而巧合通过）

### Step 2（GREEN）— 实现

1. 提取共享 lib `capability-helpers.ts`（refactor，现有 T10 测试保持 green）
2. `addAgent` 加 `return assignment`
3. AddToWorkspaceDialog 加：
   - `capsOpen` state（默认 false）+ `allocation` state + `overrideValue` state
   - `ipc.allocation.get(workspace.id)` useEffect 拉取 Layer 2
   - `defaultCaps = mergeDefault(defToCapabilities(selectedDef), allocation)` useMemo
   - `useEffect([defaultCaps])` 同步 overrideValue
   - `<details open={capsOpen}>` 受控 + `<summary onClick={preventDefault + toggle}>`
   - `handleSubmit`：`const newAssignment = await addAgent(...)` → `computeDeltas(overrideValue, defaultCaps)` → `if (!isEmptyDeltas(deltas)) await setAssignmentDeltas(newAssignment.instanceId, deltas)` → `onClose()`

### Step 3（验证）

- `AddToWorkspaceDialog.test.tsx`：5/5 ✅
- `agent.store.test.ts`：12/12 ✅
- renderer 全套：**295/295 ✅**（+6 新增，无回归）
- typecheck（electron + renderer）：**双 clean ✅**
- LSP diagnostics（5 个改动文件）：**全 0 errors ✅**

---

## Self-Review

### 1. 是否提取了 T10 的共享 helper（DRY）？✅ 是

提取 `renderer/src/lib/capability-helpers.ts`，包含：
- `Capabilities` 类型（原内联在 CapabilityTabs.tsx）
- `EMPTY_DELTAS`、`defToCapabilities`、`mergeDefault`、`applyDeltas`、`computeDeltas`、`deltasEqual`（原内联在 AssignmentCapabilitiesDialog.tsx）
- **新增 `isEmptyDeltas`**（T11 提交时判断 deltas 全空跳过的专用 helper，比 `deltasEqual(d, EMPTY_DELTAS)` 语义更清晰）

`AssignmentCapabilitiesDialog.tsx` 从 271 行缩到 ~180 行（删除 ~90 行内联 helper），改 import 共享 lib。`CapabilityTabs.tsx` 通过 `import` + `export type { Capabilities }` 保持现有 `import { type Capabilities } from './CapabilityTabs'` 不破（DefinitionEditor 不用改）。T10 全部 11 个测试保持 green，行为零变化。

### 2. instanceId 捕获 + setAssignmentDeltas 调用链是否正确？✅ 是

调用链：
```
handleSubmit
  → const newAssignment = await addAgent(ws.id, defId, role, parent?, apiKey?)
       （store action：await ipc.agent.addToWorkspace → set state → return assignment）
  → const deltas = computeDeltas(overrideValue, defaultCaps)
  → if (!isEmptyDeltas(deltas))
       await setAssignmentDeltas(newAssignment.instanceId, deltas)
  → onClose()
```

关键点：
- `addAgent` 返回类型改为 `Promise<AgentAssignment>`，return IPC 返回的 assignment（含 DB 生成的真实 instanceId）
- 用 `newAssignment.instanceId`（而非猜测/查找）保证绑到刚创建的 assignment
- 测试 #4 断言 `setAssignmentDeltas` 被调用且首参 = `'inst-new'`（mock addToWorkspace 返回的 instanceId），验证整条链路

### 3. deltas 全空跳过逻辑？✅ 是

- `isEmptyDeltas(deltas)` 判断六个数组全空
- `if (!isEmptyDeltas(deltas))` 守卫 setAssignmentDeltas 调用
- 测试 #5（不展开直接保存）断言 `setAssignmentDeltasMock).not.toHaveBeenCalled()` 验证跳过
- 意义：折叠区默认收起 → value === defaultCaps → deltas 全空 → 不产生空写 IPC，避免无意义写入

---

## 设计决策

### `<details>` 用 state 受控（非原生 toggle）

jsdom 不模拟 `<details>/<summary>` 的原生 toggle 行为，且 React 对 `open` 属性的非受控管理容易与原生 toggle 双重翻转。采用 `open={capsOpen}` + `<summary onClick={e => { e.preventDefault(); setCapsOpen(v => !v) }}>`：
- preventDefault 阻止原生 toggle，完全由 state 驱动
- `{capsOpen && <CapabilityTabs .../>}` 条件渲染——折叠时不挂载 CapabilityTabs，避免无谓的 MCP/Skill IPC 调用

### allocation 加载时机

挂载时（`useEffect([workspace?.id])`）拉一次 `ipc.allocation.get`。allocation 异步到达后 `defaultCaps` 重算，`useEffect([defaultCaps])` 同步 `overrideValue`。由于 IPC 在毫秒级完成、折叠区默认收起（用户点击展开是秒级操作），用户展开前 allocation 必已就绪，不会出现 checkbox「跳变」。测试中对异步加载用 `waitFor` 而非同步断言。

### addAgent 返回值变更的兼容性

`Promise<void>` → `Promise<AgentAssignment>` 是**兼容扩展**：现有 3 处 `await addAgent(...)` 调用（agent.store.test.ts 的 2 处 + AddToWorkspaceDialog 本身）都不读返回值，升级后无影响。新增 1 条 store 测试显式验证返回值。

---

## Concerns / 备注

- **setAssignmentDeltas 失败时的语义**：若 addAgent 成功但 setAssignmentDeltas 抛错（网络/DB），`handleSubmit` 的 catch 会 setError 且不调 onClose——assignment 已创建但 deltas 未保存，用户看到错误可重试或取消。这是可接受的：deltas 是 bonus 层，主操作（添加 agent）已成功；且折叠区默认收起，绝大多数提交 path 不走 setAssignmentDeltas。
- **T10/T11 共享 lib 已就绪**，后续若有其他组件需要能力计算（如批量编辑），直接 import `capability-helpers` 即可。

## Commit SHA

见最终输出（提交后回填）。
