# Task 13 Report — RegisterMcpDialog（v1.6）

> 注：本文件此前是 v1.5 周期同名 Task 13（TodoTools 后端）的报告，其实现已合入 main（commit `0b0c42c0`），无信息丢失。现被本 v1.6 Task 13 报告覆盖。

**状态**: ✅ 完成
**分支**: main（未推送）

## 实施摘要

创建表单式注册自定义 MCP server 的模态弹窗 `RegisterMcpDialog`，允许用户手动录入 `command + args + env` 注册自定义 MCP（区别于 marketplace 安装）。

**新增文件：**
- `renderer/src/components/agent/RegisterMcpDialog.tsx`（弹窗组件）
- `renderer/src/components/agent/RegisterMcpDialog.test.tsx`（12 个单测）

**文件位置选择：** 放在 `components/agent/`（而非 `marketplace/`），理由：
1. brief 明确指定路径为 `renderer/src/components/agent/RegisterMcpDialog.tsx`
2. 同目录的 `AssignmentCapabilitiesDialog` / `CapabilityTabs` 也处理 MCP 能力，摆放习惯一致
3. 测试与组件同目录 co-located，符合仓库既有约定（brief 写的 `renderer/tests/components/` 在本仓库不存在，现有 5 个 dialog 测试全部 co-located）

## TDD 步骤输出

### Step 1（RED）：写失败测试

按 brief 列出的 3 类 case + 用户约束扩展为 12 个用例：

| # | 用例 | 覆盖的约束 |
|---|---|---|
| 1 | 渲染所有表单字段 + 初始一行 env | 字段完整性 |
| 2 | 名称和命令都空 → 按钮 disabled | 必填校验 |
| 3 | 只填名称（命令空）→ 仍 disabled | 必填校验 |
| 4 | 名称+命令都填 → enabled | 必填校验 |
| 5 | [+] 按钮追加一行 env | env 多行交互 |
| 6 | 提交 → register 收到正确 payload（含 source='custom' + randomUUID）| source 标识 |
| 7 | args 解析：`' a , , b ,  ,c,'` → `['a','b','c']` | args 转换 |
| 8 | env 多行 KEY=VALUE → Record | env 转换 |
| 9 | 提交 → start(activeWorkspaceId, name) | 启动调用 |
| 10 | 成功 → onSuccess + onClose | 父组件刷新 |
| 11 | register 失败 → 红字错误，弹窗不关 | 错误处理 |
| 12 | 提交期间按钮 disabled（防双击）| 防双击 |

### Step 2（RED 验证）

```
FAIL  src/components/agent/RegisterMcpDialog.test.tsx
Error: Failed to resolve import "./RegisterMcpDialog" ... Does the file exist?
```
✅ 失败原因正确（模块缺失，非 typo）。

### Step 3（GREEN）：实现

最小实现要点：
- `useState` 管理 name/version/command/args/envRows(error/submitting)
- `envRows` 初始 `['']`，[+] 按钮 `setEnvRows(r => [...r, ''])`
- `parseEnv()` 工具函数：按首个 `=` 拆键值（值里允许含 `=`），跳过空行与无 `=` 行
- 提交：`args.split(',').map(trim).filter(Boolean)` → `ipc.mcp.register({id: crypto.randomUUID(), ..., source: 'custom'})` → `ipc.mcp.start(activeWorkspaceId, name)` → `onSuccess()` → `onClose()`
- 按钮 `disabled={submitting || !name.trim() || !command.trim()}`，文案 `submitting ? '注册中…' : '注册并启动'`

### Step 4（GREEN 验证）

```
✓ src/components/agent/RegisterMcpDialog.test.tsx  (12 tests) 268ms
Test Files  1 passed (1)    Tests  12 passed (12)
```

全套回归（renderer）：
```
Test Files  32 passed (32)    Tests  310 passed (310)
```

Typecheck（electron + renderer 双 workspace）：
```
electron typecheck: Done
renderer typecheck: Done
```

LSP diagnostics（RegisterMcpDialog.tsx）：0 errors / 0 warnings。

## Self-Review

- ✅ **表单字段校验（name + command 必填）？**
  按钮 `disabled` 条件含 `!name.trim() || !command.trim()`，3 个校验用例（都空 / 只填名称 / 都填）覆盖。提交守卫 `if (!name.trim() || !command.trim()) return` 双重保险。

- ✅ **args/env 转换正确？**
  - args：`split(',').map(s => s.trim()).filter(Boolean)`，用例 7 用脏数据 `' a , , b ,  ,c,'` 验证输出 `['a','b','c']`
  - env：`parseEnv()` 按首个 `=` 拆分（比 brief 伪代码的 `line.split('=')` 更健壮——值里含 `=` 不会截断），用例 8 验证多行 → `{FOO:'bar', BAZ:'qux'}`

- ✅ **source 是否显式 'custom'（避免被 T6 的 deleteRegistered 拒绝）？**
  register 调用显式传 `source: 'custom'`，用例 6 断言 `config.source === 'custom'`。这是 T6 deleteRegistered 接受删除的前提。

- ✅ **成功后是否触发父组件刷新？**
  `onSuccess()` 在 `onClose()` 之前调用，用例 10 验证两者都被调用且 onSuccess 先触发。父组件（T15 会改 MarketplaceView 或能力配置面板）据此 re-fetch `ipc.mcp.listRegistered()`。

- ✅ **提交按钮在 ipc 调用期间 disabled（防双击）？**
  `submitting` state 在 try 入口置 true、finally 置 false，用例 12 用未决 promise 卡住提交过程，验证按钮变 '注册中…' 且 disabled、register 只被调一次。

## 与 brief 的实现差异

1. **env 解析更健壮**：brief 伪代码 `line.split('=')` 在值含 `=` 时会产出 >2 元素的数组，`Object.fromEntries` 会得到错误结果。改为按首个 `=` 拆分（`indexOf('=')`），值部分保留后续所有 `=`。
2. **额外校验**：当 `activeWorkspaceId` 为 null 时提前报错（不应发生，但防御性处理），避免 start 调用传 null。

## Commit

`feat(agent): RegisterMcpDialog 表单式注册自定义 MCP server`
**Commit**: `dbf31254efb9b08560b5a05fa636f77d17ec58e7`

