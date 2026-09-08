# Task 14 报告：CreateTaskDialog + ConflictDialog → Dialog + CreateTaskButton + InlineTaskSuggestion

日期：2026-09-02 · 分支：`main` · 执行环境：OrbStack DevContainer（Linux arm64, Node 20.20.2）

> 本文件原属 v2.0.0 P1 同编号报告，被本次 Task14 覆盖。

## 实现内容

四件 im/ 区 inline-hex 弹窗收敛为 v2.1 设计系统：

### 1. CreateTaskDialog.tsx（205 → 149 行）
- 外壳换 Dialog 原子件（width=480, title="创建任务"）
- form onSubmit + handleSubmit（FormEvent 版）：preventDefault + void
- 字段全原子件化：Input（标题/计划开始/截止时间 type=datetime-local）/ Select（指派/优先级）
- 描述 textarea 无原子件 → `class="mt-1 min-h-[80px] w-full rounded border border-subtle bg-surface-2 px-3 py-2 text-[13px] text-primary focus:border-focus focus:outline-none"`（brief 指定）
- footer 取消(ghost)+创建(Button type=submit disabled=!title.trim()||submitting)
- 6 个 style 常量（overlayStyle/dialogStyle/labelStyle/inputStyle/primaryButtonStyle）全删
- `if (!open) return null` 保留在 hooks 后（与 ProviderDialog 一致的双保险模式）

### 2. ConflictDialog.tsx（133 → 124 行）
- 外壳换 Dialog 原子件（width=480, footer 关闭 ghost）
- ⚠️ → CircleAlert lucide 图标（size=16, strokeWidth=1.75, aria-hidden, text-status-warning）
- 4 选项按钮 → `className="w-full rounded border border-subtle bg-surface-2 px-3 py-2 text-left text-[13px] text-primary hover:bg-surface-3"`，① ② ③ ④ 序号文本保留
- 记住勾选 → Checkbox（label 透传）
- `data-testid="conflict-overlay"` 删除（Dialog 用 portal + role=dialog 语义定位）
- 3 个 style 常量（overlayStyle/dialogStyle/optionButtonStyle）全删

### 3. CreateTaskButton.tsx（47 → 33 行）
- 纯展示 IconButton + ListPlus 图标（size=14, strokeWidth=1.75）
- aria-label="创建任务"；title prop 删除（IconButton 无 title prop）
- buttonStyle 常量删

### 4. InlineTaskSuggestion.tsx（61 → 53 行）
- 💡 → Lightbulb lucide 图标（size=12, strokeWidth=1.75, aria-hidden）
- 📌 创建任务 → Button secondary sm + ListPlus 图标
- wrapperStyle/ctaStyle 常量全删 → `className="my-2 flex items-center gap-2 rounded border border-accent-500/40 bg-surface-active px-2 py-1.5"`
- 提示 span 改 inline-flex items-center gap-1 text-xs text-accent-600 dark:text-accent-300

### 测试适配
- CreateTaskDialog.test.tsx：未改（label for/id 绑定 + form submit 模式天然兼容 Input/Select 原子件；所有 5 用例过）
- ConflictDialog.test.tsx：'点击 overlay' → '点击 backdrop'，`getByTestId('conflict-overlay')` → `screen.getByRole('dialog').previousElementSibling`（与 Dialog.test.tsx 第 51-55 行同模式）
- ConflictDialogMount.test.tsx：⚠️ 任务冲突 → 任务冲突；`conflict-overlay` testid → `role=dialog`

## 验证链

```
pnpm test (renderer)               # im/ 25 files / 199 tests PASS
pnpm typecheck                      # electron + renderer 双 clean
eslint <7 files>                    # 0 errors, 0 warnings on my files
pnpm lint (renderer)                # 0 errors, 216 warnings (all pre-existing)
lsp_diagnostics <4 files>           # No diagnostics found
```

### 完整 renderer 套件（实际数字）
- Test Files：4 failed | 86 passed (90)
- Tests：47 failed | 740 passed (787)
- 47 个失败全部是 4 个测试文件的 `localStorage.clear()` 报错（pre-existing，与本次改动无关——`git stash` 验证过：HEAD 上同样 47 失败）

### im/ 子目录
- Test Files：25 passed (25)
- Tests：199 passed (199)

## 文件变更

```
 renderer/src/components/im/ConflictDialog.test.tsx       |  10 +-
 renderer/src/components/im/ConflictDialog.tsx            | 137 +++++++--------
 renderer/src/components/im/ConflictDialogMount.test.tsx   |   6 +-
 renderer/src/components/im/CreateTaskButton.tsx          |  25 +--
 renderer/src/components/im/CreateTaskDialog.tsx          | 184 +++++++--------------
 renderer/src/components/im/InlineTaskSuggestion.tsx       |  40 ++---
 6 files changed, 156 insertions(+), 246 deletions(-)
```

净减 90 行——主要是 inline style 对象（overlayStyle/dialogStyle/labelStyle/inputStyle/primaryButtonStyle/optionButtonStyle/wrapperStyle/ctaStyle/buttonStyle）移除。

## 自我审查

### ✅ 零 inline hex / inline rgba
所有 style 常量已删除。grep `backgroundColor\|color:\|#[0-9a-fA-F]\|rgba` 在 4 文件零命中。

### ✅ 零渲染 emoji
- CreateTaskDialog：clean
- ConflictDialog：clean（仅注释 `⚠️ → CircleAlert` 文档迁移说明，无渲染）
- CreateTaskButton：clean（仅注释 `📌 → ListPlus` 文档迁移说明，无渲染）
- InlineTaskSuggestion：clean（仅注释 `💡 → Lightbulb` / `📌 创建任务 → Button secondary sm` 文档迁移说明，无渲染）

### ✅ IPC payload byte-identical

**ipc.task.create（CreateTaskDialog.tsx:67-77）**：
```ts
{
  workspaceId,
  title: title.trim(),
  description,
  priority: priorityNum,
  sourceSessionId: preset?.sourceSessionId ?? null,
  sourceMessageId: preset?.sourceMessageId ?? null,
  assigneeAgentId,
  scheduledAt: scheduledAt ? new Date(scheduledAt).getTime() : null,
  deadlineAt: deadlineAt ? new Date(deadlineAt).getTime() : null,
}
```
字段名/值/null 处理完全保留。

**ipc.task.resolveConflict（ConflictDialog.tsx）**：
```ts
{ newTaskId, currentTaskId, currentRoomId, strategy }
```
完全保留。

**ipc.settings.updateSession**：
```ts
await ipc.settings.updateSession(currentRoomId, { conflictStrategy: strategy });
```
完全保留。

### ✅ 业务逻辑保留

- CreateTaskDialog：useEffect 初始化 preset 序列、`if (!open) return null` 顺序、handleSubmit 守卫、ipc.task.create 调用全部 byte-identical
- ConflictDialog：4 选项 onClick → handleChoose → (remember 时 updateSession) → resolveConflict → onResolved + onClose 顺序完全保留

## 关注点

1. **textarea 用裸 className 而非 Textarea 原子件**——按 brief 明确指示（Textarea 无原子件）；后续如多文件复用 Textarea 可提升为 ui/Textarea.tsx
2. **CreateTaskDialog 提交按钮 type=submit**——把 onClick={() => void handleSubmit()} 改为 form onSubmit 后，按钮 type 同步改为 submit 才能触发 submit 事件
3. **测试中 ConflictDialog '点击 overlay' → '点击 backdrop'**——语义适配，但保留「点击外部触发 onClose」的断言意图
4. **47 个 renderer pre-existing 测试失败**——4 文件（file.store / AppearanceSettings 等）调用 `localStorage.clear()` 报 undefined，与本任务无关，stash 验证 HEAD 上同样失败，留待 2.x 债清理

## Commits

- `81ef840` refactor(renderer): 任务弹窗两件收敛 Dialog——inline-style 表单全原子件化