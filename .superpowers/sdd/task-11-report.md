# Task 11 报告：启动链与认证简化（切换点任务）

**Commit**: `1a90bc0 refactor(main,renderer): 启动链去 Matrix + 首启流程简化`
**门禁**: typecheck 双 clean；electron 142 files / 949 tests 全绿；renderer 49 files / 409 tests 全绿；renderer lint clean。

## 实际改动

### 主进程（electron）

| 文件 | 改动 |
|---|---|
| `src/main/index.ts` | 删两处 `startConduit()` 调用、`autoRestoreSession()`（含 `auth:sessionExpired` 推送）、`startSyncFromSession` import。启动链变为：migrations → initTaskRuntime → registerIpcHandlers → createMainWindow →（setMainWindow/setRuntimeMainWindow/setSessionMainWindow）→ **启动即 initTaskDrivenRuntime** + broadcastRuntimeChanged → initP2p。before-quit 保留全部 destroy 链（stopConduit/stopSync 成为无害 no-op，Task 12 删） |
| `src/main/ipc/index.ts` | 删 `registerAuthHandlers` import + 调用 |
| `src/main/ipc/auth.handlers.ts` | **删除**（auth:register/login/getCurrentUser/logout 四通道 + 登录后 restore 逻辑） |
| `src/main/ipc/authFlows.ts` | **删除**（注册/登录/登出/读会话流程 + kv_store CURRENT_USER_KEY 读写） |
| `src/main/im/ipc.handlers.ts` | 删 `im:startSync` handler + startConduit/startSyncFromSession import。其余通道（send/getRooms/getMessages/room 操作/export）**原样保留**——renderer 已无调用方，Task 12 随 Matrix 全家删除 |
| `src/main/task/starter.ts` | **超出 brief 的必要修复**（见下） |
| `src/main/workspace/ipc.handlers.ts` | `workspace:create` 身份注入 `getCurrentUserId()`（未登录抛错）→ 常量 `'owner'` |
| `src/main/task/ipc.handlers.ts` | `task:create` 同上 → `'owner'` |
| `src/preload/index.ts` | 删 `auth` 命名空间（5 绑定）+ `im.startSync` |
| `tests/im/ipc.handlers.test.ts` | 删 startSync 断言（改为 `has('im:startSync') === false` 回归断言）+ 失效 mock（conduit/manager、startSyncFromSession） |
| `tests/ipc/authFlows.test.ts`、`tests/ipc/auth-handlers-restore.test.ts` | **删除** |
| `tests/task/starter.test.ts` | 重写新会话路径断言（本地 sessions 表 + 成员表），删 Matrix mock，新增 assignee 成员用例（7 用例） |
| `tests/task/conflict-executor.test.ts` | fork 用例改断言本地 session 行；删失效 Matrix mock |

### Renderer

| 文件 | 改动 |
|---|---|
| `src/App.tsx` | 删 Onboarding/auth 分支。新逻辑：挂载即 `workspace.load()`（`bootstrapped` 本地态防首拉闪现）→ 有 workspace 渲染 MainShell；无 → 全屏复用 `CreateWorkspaceDialog` 作首启空态（创建成功 store 写入 → 分支翻转；onClose 重拉兜底）。session 通道订阅保留 |
| `src/App.test.tsx` | **新增** 3 用例（TDD 先行）：已有 workspace 直进 MainShell / 无 workspace 显示首启对话框 / 创建成功进 MainShell（有状态 list mock 覆盖 onClose→load 路径） |
| `src/stores/auth.store.ts` + test | **删除** |
| `src/routes/Onboarding.tsx` + test、`src/components/onboarding/*`（5 组件） | **删除** |
| `src/components/im/MessageList.tsx` | `currentUserId` 从 auth.store → 常量 `'owner'`（与 session-service.sendUserMessage 写入侧 sender='owner' 对齐，气泡左右判定） |
| `src/components/im/MessageList.test.tsx` | 删 auth.store mock |
| `src/components/settings/AccountSettings.tsx` | 静态化：展示 owner（本地单用户）说明，无登出按钮（设置分类导航保留） |
| `src/ipc/types.d.ts` | 删 `AuthResult`、ApiSurface.auth、`im.startSync` |
| `src/stores/session.store.ts` | **Task 9 deferred 清偿**：refreshSessionList 删 1s setTimeout 双拉取（纯 SQLite 首拉即权威）。配套 RED 测试（advanceTimersByTimeAsync 1.5s 断言单次调用） |

## 超出 brief 的必要修复：task/starter.ts

**发现**：starter.ts 是 `getOwnerMatrixClient()` 的活调用方（TaskDetailPanel → task:start → 新建会话路径）。auth 删除后：新装抛"未登录"（核心流程断）；旧库读到 kv_store 残留会话则 `startConduit()` 复活 Matrix 流量——两者都违反切换点目标"系统实际运行已无 Matrix 流量"。brief 第 7 条（活调用方就地适配）精神覆盖此情况。

**修复**：`createNewTaskRoom` 改写本地 `sessions` 表（`kind='task_execution'`，命名约定不变）；assignee 直接入 `session_members`（`task.assigneeAgentId` 在 v2 语义下即 assignment instanceId，与 CreateTaskDialog 下拉值一致）。TDD：先重写测试看失败（"未登录"异常复现断点），再实现，7/7 绿。

## TDD 记录

| 测试 | RED 验证 | GREEN |
|---|---|---|
| App.test.tsx ×3 | 旧 App 渲染 Onboarding + ipc.auth 缺失抛错 | ✅ 42/42 |
| refreshSessionList 单拉取 | "called 2 times, expected 1" | ✅ |
| starter.test.ts ×7 | "未登录"（getOwnerMatrixClient） | ✅ |

## 本任务后仍引用 Matrix/Conduit 的清单（全部 Task 12/13 范围）

| 位置 | 状态 | 归属 |
|---|---|---|
| `electron/src/main/matrix/`（session/client/sync-manager/rooms/room-info） | 死代码：startSyncFromSession 零活调用方；getOwnerMatrixClient 仅剩死路径引用（room-ops、im 旧通道） | Task 12 |
| `electron/src/main/conduit/` | startConduit 仅被 matrix/ 死路径调用；`isConduitRunning` 被 system:getConduitStatus 纯读（无流量，恒 false） | Task 12 |
| `electron/src/main/im/room-ops.ts` | 仅被 im/ipc.handlers 的死通道动态 import | Task 12 |
| `electron/src/main/im/ipc.handlers.ts` 剩余通道 | renderer 零调用（唯一活的 `im:conflict` 推送来自 session-service，非 Matrix） | Task 12 |
| `electron/src/main/im/markdown-exporter.ts` | type-only import（MatrixMessagePayload）；im:exportRoomMessages 死通道 | Task 12（迁 session:exportMessages） |
| `electron/src/main/agent/bot-registrar.ts` | **零 import 方** | Task 12 |
| `electron/src/main/agent/auto-start.ts` | src 零 import（auth.handlers 是最后调用方，已删；测试仍直接覆盖） | Task 13 |
| `electron/src/main/agent/runtime-manager.ts`、`decide-response.ts`、`message-target-resolver.ts` | 按计划不动 | Task 13 |
| `main/index.ts` 残留 import（stopConduit/stopSync/setMainWindow/broadcastRuntimeChanged） | before-quit no-op + UI 通知（broadcastRuntimeChanged 仅 webContents.send，无 Matrix 流量） | Task 12 |
| preload `im` 命名空间（除已删 startSync） | onConflict 活消费；其余死绑定 | Task 12 |
| `system:getConduitStatus` IPC + SettingsView Conduit 状态展示 | 恒 false，无流量 | Task 12 / P2 UI |
| `getCurrentUserId` 剩余调用方（im/ipc.handlers、room-ops、matrix/session 自身） | 全部死路径 | Task 12 |
| kv_store `CURRENT_USER_KEY` | 无写入方；旧库残留行仅被死路径读取，无害 | Task 12（随 matrix/ 删除） |

**运行时 Matrix 流量：0**（boot 链无 startConduit；im:startSync 删除；auth 删除；task:start 已本地化；其余引用全部不可达）。

## 已知限制 / 风险

1. **旧数据气泡对齐**：v2 前历史消息 sender 为 Matrix user id（如 `@alice:localhost`），currentUserId='owner' 判定下显示为左侧（非本人）。仅影响旧数据展示，P2 UI 重设计范围。
2. **预存 lint error ×4**（runtime-entry.ts ×2、task-tools.ts warning、conduit/manager.ts ×2）：经 stash 验证在本任务前已存在，非本任务引入（conduit/manager.ts 属 Task 12 删除范围）。renderer lint clean。
3. **首启对话框为全屏遮罩形态**：复用 CreateWorkspaceDialog 的 fixed inset-0 模态（brief 明示 keep it simple，P2 重设计）；无"跳过"路径——必须创建 workspace 才能进入应用（符合单用户本地应用模型）。
4. `docs/` 下有一份未跟踪文件 `2026-08-14-system-feature-inventory.md` 与 `.superpowers/sdd/task-{1,5,7}-report.md` 的既有改动，非本任务产物，未纳入提交。旧的 v1.6 task-11 报告已按目录惯例归档为 `task-11-report-v1.6-archived.md`。
