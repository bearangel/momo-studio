# Task 14 实施报告 — UploadSkillDialog（v1.6）

## 实施摘要

新建 `renderer/src/components/agent/UploadSkillDialog.tsx` + 配套 colocated 测试 `UploadSkillDialog.test.tsx`，实现本地 .zip 自定义 Skill 上传弹窗。

**文件清单**
- `renderer/src/components/agent/UploadSkillDialog.tsx`（149 行）— 弹窗组件
- `renderer/src/components/agent/UploadSkillDialog.test.tsx`（180 行）— 10 个单测

**测试路径调整**：brief 写的是 `renderer/tests/components/UploadSkillDialog.test.tsx`，但仓库现有约定是 colocated（参考 T13 的 `RegisterMcpDialog.test.tsx`、T11 的 `AddToWorkspaceDialog.test.tsx` 等 25 个 `.test.tsx` 都在 `src/` 旁）。遵循仓库约定放 colocated 位置。

**核心流程**
```
[选择文件...] 按钮 → 隐藏 <input type="file" accept=".zip">.click()
  → 用户选 zip → setFile(file) + 回显文件名 + 清旧提示
[上传] 按钮 → readFileAsArrayBuffer(file)
  → ipc.skill.uploadZip(buffer, file.name)
  → 成功：显示绿色 "已安装：slug（description）" + onSuccess() + onClose()
  → 失败：显示红字 error.message，弹窗保持打开
```

**无需新增 IPC**：T7 已就绪的 `skill:uploadZip` IPC（preload 已经做 `Buffer.from(buffer)` 转换）够用，没有走 `dialog:openFile` 路线（`<input type="file">` 在 renderer 进程内能直接拿到 File 对象，简单且无需新 IPC）。

## TDD 步骤输出

### RED（写失败测试 → 验证失败）

测试文件首版 10 用例，运行 vitest 输出：
```
FAIL  src/components/agent/UploadSkillDialog.test.tsx
Error: Failed to resolve import "./UploadSkillDialog" from "...UploadSkillDialog.test.tsx". Does the file exist?
Test Files  1 failed (1)
Tests  no tests
```
失败原因正确——组件文件不存在（feature missing，不是 typo）。

### GREEN（实现组件 → 验证通过）

第一版实现用 `await file.arrayBuffer()`，跑测试发现 jsdom 24 报 `file.arrayBuffer is not a function`（probe 验证：`Blob.arrayBuffer` 在 jsdom 24 runtime 为 undefined）。改用 `FileReader.readAsArrayBuffer`（brief 也推荐），probe 验证可正确读取 4 字节、首字节 0x50。

修复后单测运行：
```
✓ src/components/agent/UploadSkillDialog.test.tsx  (10 tests) 150ms
Test Files  1 passed (1)
Tests  10 passed (10)
```

### 全套回归（含一道 flake 修复）

首次跑全套 `vitest run`：319 passed / 1 failed。
唯一失败：「上传中 → 按钮 disabled（防双击），uploadZip 仅被调一次」用例。失败原因：原断言 `expect(uploadZip).toHaveBeenCalledTimes(1)` 是同步的，但 `FileReader.onload` 是异步的，并发跑测时 uploadZip 还未被调用就断言了。

修复：把该断言包进 `waitFor`（同处加注释说明为何这里和 `RegisterMcpDialog.test.tsx` 的同步断言不同——后者 mock 在 click 后同步调用，前者夹了一层异步 FileReader）。

修复后再跑全套 3 次全绿：
- 全套：`Test Files 33 passed (33) | Tests 320 passed (320)`
- 单文件 3 次连跑：每次都 10/10

### Typecheck

```
pnpm -r typecheck
electron typecheck: Done
renderer typecheck: Done
```

### LSP 诊断

`UploadSkillDialog.tsx` + `UploadSkillDialog.test.tsx`：0 errors。

## Self-review

### 1. ArrayBuffer → Buffer 转换正确？

**正确**。三层链路：

1. **renderer**（`UploadSkillDialog.tsx`）：`await readFileAsArrayBuffer(file)` 拿到 `ArrayBuffer`，调 `ipc.skill.uploadZip(buffer, file.name)`。
2. **preload**（`electron/src/preload/index.ts:156-157`，T7 已实现）：
   ```ts
   uploadZip: (buffer: ArrayBuffer, filename: string) =>
     invoke<{ slug: string; description: string }>('skill:uploadZip', Buffer.from(buffer), filename),
   ```
   `Buffer.from(ArrayBuffer)` 共享底层内存创建 Node Buffer，再交给 `ipcRenderer.invoke`。
3. **IPC 序列化**：Electron 的 structured-clone 把 Buffer 序列化为 Uint8Array arraybuffer 形态传到主进程，handler 端 `(_evt, buffer: Buffer, filename: string) => uploadSkillZip(buffer, filename)` 收到的就是 Buffer。

测试断言 `buf instanceof ArrayBuffer` + `byteLength === 6` + 首字节 `0x50`，确保 renderer → preload 边界前 ArrayBuffer 内容完整。

### 2. 错误信息友好？

**友好**。直接展示后端抛出的中文错误 message，覆盖三类典型失败：
- zip 缺 SKILL.md：`zip 内未找到 SKILL.md（要求 <slug>/SKILL.md 结构）`
- 多根目录：`zip 根目录包含多个子目录（应有且仅有一个 <slug>/ 包裹 SKILL.md）`
- slug 非法：`非法 slug：${slug}`

弹窗在错误时**保持打开**，用户可以重新选文件再上传（重新选会清掉旧 error）。

### 3. 上传中状态管理正确？

**正确**。三道闸门同时生效：
- `uploading` state：进入时 `setUploading(true)`，结束（成功/失败）时 `finally setUploading(false)`。
- 按钮 disabled：上传中「选择文件...」「取消」「上传」三个按钮都 disabled（`disabled={lockAll}`，`lockAll = uploading`）。
- 入口守卫：`handleUpload` 第一行 `if (!file || uploading) return;`——即便按钮被强点也不会重复触发。
- 背景遮罩 `onClick={lockAll ? undefined : onClose}`：上传中点遮罩不关弹窗。

测试 #9「上传中 → 按钮 disabled（防双击）」用未决 Promise 卡住上传过程，连点 2 次「上传中…」按钮，断言 `uploadZip` 最终只被调 1 次（waitFor 包裹保证 FileReader 解析完后才数调用次数）。

## 偏离与决策

1. **测试文件位置**：放 `src/components/agent/` 而非 brief 写的 `tests/components/`，与仓库 25 个现有 colocated 测试一致。
2. **FileReader 而非 file.arrayBuffer()**：jsdom 24 runtime 未实现 `Blob.arrayBuffer`，FileReader 两者都可用，且 brief 也建议此方案。docstring 显式标注此约束以防后续被"现代化"重构回去。
3. **无预检**：按 brief 的"简化版"方案，直接调 `skill:uploadZip`，失败时由后端一次性抛错。

## commit hash

```
b76b7b4 feat(agent): UploadSkillDialog 本地 zip 上传自定义 Skill
```

2 files changed, 323 insertions(+).
