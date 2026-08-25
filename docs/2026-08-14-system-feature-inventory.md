# Momo Studio 系统功能全景清单

> **生成日期**：2026-08-14　**基线**：当前 main（v2.0 平台重构 + task-driven 切换 + 8/14 三轮修复之后）
> **用途**：大重构前的系统认知底座——先完整了解系统有什么、什么健康、什么是过渡态、什么是半成品/死代码。
> **方法**：四路并行代码审计（electron 主进程 ~113 文件 / renderer ~48 业务文件 / IPC 全面 97 契约 / momo-hub 独立项目）+ README、CHANGELOG、7 份设计文档交叉验证。

**状态图例**：✅ 健康在用｜⚠️ 新旧并存/过渡态｜🔶 已实现但未接线（半成品）｜❌ 死代码/已废弃残留

---

## 1. 系统组成

```
momo-studio 仓库
├── electron/     Electron 主进程（CommonJS）——所有业务逻辑的宿主：agent 运行时、任务调度、
│                 Matrix 集成、存储、工具执行、P2P 客户端。子进程 runtime-entry.ts 是 agent 大脑。
├── renderer/     React UI（ESM + Vite + Zustand + Tailwind + Monaco）——6 大视图，无路由库
├── momo-hub/     独立 Node.js WebSocket 中继服务器（互联网模式 P2P）——不在 pnpm workspace 内
├── resources/    Tuwunel（Conduwuit 继任者）二进制 + 内置 agent YAML + marketplace catalog
├── tests/        Playwright e2e（🔶 实际未跑通，README 待办项）
└── docs/         specs（设计）/ plans（实施计划）/ dev（指南）
```

三个进程角色：**主进程**（路由 + 调度 + 存储）、**renderer**（UI）、**agent 子进程**（runtime-entry，每个任务/agent 一个 Node 进程，LLM chat loop + 工具执行）。本地 Matrix 服务器（Tuwunel）承担 bot 身份 + 房间 + 消息传输层（v2.0 A 后退为纯传输层，SQLite 是唯一真相源）。

## 2. 版本演进脉络（为什么系统变成今天这样）

| 版本 | 日期 | 主题 | 遗产 |
|---|---|---|---|
| v1.0 | 07-28 | 单机自洽：workspace + 声明式 agent + IM + MCP + Skill + Marketplace + 安全基线 | 骨架 |
| v1.1 | 07-31 | 会话房间管理、设置页、供应商注册表、文件 CRUD | |
| v1.2 | 07-31 | 主/子 agent 编排 UI、质量打磨 | 编排树 |
| v1.3 | 08-03 | **定义/分配解耦**（role 进 assignment）、provider 引用化、workspace 隔离、双 Tab | migration v12 |
| v1.4 | 08-04 | **流式回复**（SSE 双通道）、可配置工具上限、委派嵌套展示 | room_settings v13 |
| v1.5 | 08-04 | **内置工具库扩到 24 个**（7 类） | 分层 agent_meta v14 |
| v1.6 | 08-11 | **三层能力配置** + Marketplace 自定义上传（MCP 注册/Skill zip） | v16；修复 allowedTools 丢弃关键 bug |
| v1.7 | 08-11 | **资源库**统一三源三类，取代 Marketplace UI；IPC 收敛为 resource:* 4 通道 | ResourceItem |
| v1.7.4 | 08-12 | 多段消息/重启一致性 5 个 bug 修复（症状治疗） | 触发 2.0 反思 |
| **v2.0** | 08-13~14 | **平台重构 A/B/C/D 四子系统** + task-driven 完全切换 | 见下 |
| v2.0 修复 | 08-14 | agent 在线语义重定义（lastRunning）→ 全线下线 bug；RouterService lazy init → 全线不回消息 bug | 两轮"上线即坏"事故 |

**v2.0 四子系统**（依赖顺序 A→B→D→C）：
- **A 消息源统一**：SQLite `messages` + `message_events` 事件溯源成唯一真相源（migration v17）；废弃 agent_meta 表与 Matrix event 富字段；实时/重启同一聚合函数。根治"重启前后显示不一致"。
- **B 任务模型**：Chat + Task 双模型；`tasks` 表 + 8 态状态机 + 执行锁定；`@agent`/`#T-xxx` 双 mention 语法；冲突 5 策略；MemoryProvider 抽象。
- **D 看板 + 并发**：Linear 风格任务看板；**task-driven runtime**（runtime 从长存进程变为任务的临时资源：RouterService 路由中心 + AgentRunner + WarmPool 预热池 K=2）；三层并发（全局/per-agent/provider 令牌桶）；migration v21/v22。
- **C 联网 P2P**：三层联网（本地/局域网 mDNS+TCP/互联网 hub 中转）；Ed25519 节点身份 + 信任列表 + E2E 加密；momo-hub 独立中继服务器。**当前状态最靠后**（见 §3.19）。

---

## 3. 功能域清单（按用户可感知功能组织）

### 3.1 认证与账户　✅

| 功能 | 说明 |
|---|---|
| 首次注册向导 | 5 步：欢迎 → 模式选择（仅"独立模式"，服务端连接标注"即将推出"）→ 注册账号 → 老用户登录（自动识别）→ 完成自动进入 |
| 登录/登出/会话恢复 | Matrix 账号 token 存 OS keychain；token 失效推送 `auth:sessionExpired` 自动跳登录页 |
| 账户页 | 设置 → 账户：信息展示 + 退出登录 |

支撑：`auth.store` / `components/onboarding/*` / `ipc/authFlows.ts + auth.handlers.ts` / `kv_store.current_user_session`

### 3.2 Workspace 管理　✅（删除功能 🔶）

| 功能 | 说明 | 状态 |
|---|---|---|
| 创建 | 名称 + 原生目录选择对话框；自动 git init（含空 commit 建立基线）+ 自动建 Matrix Space + 团队群 | ✅ |
| 切换 | 左栏顶部切换器；切换时 IM store 重置、agent 库按 scope 过滤、IM 房间按 Space 过滤 | ✅ |
| 协调 agent（PM） | 设置/清空 workspace 协调 agent；运行中实例自动重启生效 | ✅ |
| 删除 workspace | 后端 `workspace:delete` 存在，**UI 无入口** | 🔶 |

支撑：`workspace/crud.ts + git.ts + ipc.handlers.ts`；表 `workspaces` / `workspace_members`

### 3.3 文件浏览与编辑器　✅

| 功能 | 说明 |
|---|---|
| 文件树 | 按需加载、折叠态 localStorage 持久化、文件/文件夹选中互斥、右键菜单（新建/重命名/移动/删除）、空白区操作、工具栏跟随选中目录 |
| Monaco 编辑器 | 多 tab + dirty 标记 + Ctrl/Cmd+S 保存 + 按扩展名语言检测；中文 NLS 本地打包离线优先 |
| 路径安全 | 所有 renderer 文件 IPC 走 `WorkspaceFS` 沙箱（见 §3.17） |

支撑：`file.store` / `components/files/*` / `components/editor/CodeEditor.tsx` / `files/workspace-fs.ts`

### 3.4 Agent 定义与库　✅

| 功能 | 说明 |
|---|---|
| 内置 agent | `resources/agents/*.yaml` 3 个 YAML 定义（不进 DB，内存 suggestions Map 供 UI 预填） |
| 自定义 agent | 表单创建：名称/slug/prompt/emoji/供应商/模型/scope（默认 workspace 私有，可选全局共享）；默认能力为"安全最小集"（7 工具 + dispatch-if-main） |
| 编辑 | 定义层可编辑（保存自动停止运行实例）；apiKey 独立更新（per-assignment override 入 keychain） |
| Agent 库 | 双 Tab 之一：builtin / 全局 custom / 本 ws custom 三组 + 搜索 + 配置/编辑/删除/加入工作空间 |
| 删除保护 | builtin 禁删；custom 级联清理 assignment + keychain + bot |

支撑：`agent/crud.ts + manifest-parser.ts + builtin.ts`；表 `agent_definitions`（v1.3 解耦后：身份/能力/模型在 def）`agent_assignments`（role standalone/main/sub + parent + hasApiKeyOverride + lastRunning + taskDriven）

### 3.5 主/子 Agent 编排　✅

| 功能 | 说明 |
|---|---|
| 编排树视图 | main→sub 树形展示、可折叠、孤儿子 agent 可见、添加子/解除父子/设为主 |
| 一键安装 main | `assignMain` 自动跟随安装其全部 sub；重复安装守卫；级联删除 |
| 校验 | 角色变更循环引用校验；main 改非 main 级联停止 subs |
| dispatch 列表联动 | main 的 dispatch 工具列表仅含**在线**（lastRunning=1）sub；sub 启停自动重启 parent main 刷新工具列表 |

支撑：`AgentOrchestrator` / `AddToWorkspaceDialog` / `AssignmentRoleEditor` / `agent/ipc.handlers.ts`（assignMainAgent / restartMainForSubChange / maybeRestartMainForSubChange）/ `spawn-helpers.rebuildSubAgents`

### 3.6 Agent 运行时　⚠️ **全系统最大新旧并存点**

| 概念 | v2 task-driven（默认，task_driven=1） | v1 长存进程（fallback，task_driven=0） |
|---|---|---|
| 模型 | runtime 是任务的临时资源：任务到达 → acquire 预热 runtime → 注入 task-config → chat loop → 销毁 | 每 agent 一个常驻子进程，自己监听 Matrix room |
| 路由 | 主进程 `RouterService` 统一路由 Matrix event（user msg / dispatch / task_reply / abort_dispatch） | 子进程内 `runtime-entry` 自己监听 + decideResponse |
| 执行单元 | `AgentRunner`（每 assignment 一个）+ `WarmPool`（K=2 预热池，消除 200-500ms spawn 延迟） | `runtime-manager.spawnAgent`（**@deprecated 905 行文件**） |
| 启动语义 | 「启动」= 注册 runner + 预热池 + lastRunning=1（用户意图，子进程状态是实现细节） | 「启动」= spawn 常驻进程 |
| 崩溃恢复 | WarmPool 自动 replenish | circuit breaker（3 次 2s/5s/10s） |
| app 启动恢复 | `initTaskDrivenRuntime`（enabled=1 且 lastRunning=1 过滤）+ lazy `ensureRouterService` | `auto-start.ts`（token 失效自动 password re-login） |

**关键耦合**：子进程入口同一份 `runtime-entry.ts`（1891 行），按 taskDriven 字段分流；**流式 chunk 双通道转发（落盘 + 推 renderer）和 abortStream 仍住在 deprecated 的 runtime-manager 里**，v2 并未搬走。

**未完成**（task-driven 切换遗留）：
- `task/runtime-init.scanPickup` 是 no-op——assigned 任务**不会自动 pickup**，只能看板手动启动 🔶
- `RouterService.routeAbortDispatch` 仅打日志占位——abort_dispatch 事件路由未实现 🔶

**8/14 两轮事故修复**（v2.0 质量问题的直接证据）：
1. 全线显示离线：`agent:isRunning` 仍查 v1 Map → 改为查 DB `last_running`（语义重定义：在线 = 用户启动过）
2. 全线不回消息：RouterService 仅启动时创建一次，空状态下永不创建 → 改 lazy init（第一次 runner 注册时启动）

### 3.7 IM 会话　✅（部分组件 🔶）

| 功能 | 说明 | 状态 |
|---|---|---|
| 房间列表 | 排序（系统/团队群优先）；新建（名称+私聊开关+邀请 agent+工具上限）、重命名、解散（自适应：bot 先退；团队群保护禁删） | ✅ |
| 消息发送 | `@` 触发 agent mention 下拉（仅显示在线 agent） | ✅ |
| 消息源（v2 A 核心） | SQLite `messages` + `message_events` 事件溯源唯一真相源；实时 = IPC event batch 推送，重启 = 同一 `stream-aggregator` 聚合——双路径同源，根治重启不一致 | ✅ |
| 翻页 | `loadOlderMessages`（created_at 游标，不再依赖 Matrix timeline 分页） | ✅ |
| 流式气泡 | thinking 折叠区 + todo 面板 + 工具调用卡片 + dispatch chips + Markdown 逐字 + 状态栏 + 停止按钮 + 流式光标 | ✅ |
| 委派嵌套 | dispatch/task_reply 不再是独立消息，嵌套在 PM 气泡 DispatchChip 内（4 状态）可展开 SubAgentSection；多段 task_complete 归组 SegmentStack 纵向堆叠 | ✅ |
| 消息过滤 | dispatch/task_reply/子 agent 消息不作顶层消息（DispatchCard/TaskReplyCard 仅防御性兜底渲染） | ✅ |
| 成员浮层 | ⭐自己/🤖bot/管理徽标 + 在线/离线 badge（基于 lastRunning） | ✅ |
| 工具上限徽标 | 房间头 ∞/禁用/N 次，点击弹窗改（继承/禁用/无限/自定义） | ✅ |
| 导出 | 房间最近 N 条导出 Markdown 文件下载 | ✅ |
| 冲突弹窗 | execution_room 内 @另一任务 → 全局 ConflictDialog（queue/preempt/fork/reject/ask + 记住选择） | ✅ |
| `@` + `#` 双语法输入框 | `MentionInput.tsx`（185 行，@agent + #T-xxx 任务双菜单）**已实现未挂载**，现役 MessageInput 仅 @ | 🔶 |
| agent 内联任务建议 | `InlineTaskSuggestion.tsx` **未挂载** | 🔶 |

支撑：`im.store` / `stream.store` / `lib/stream-aggregator.ts` / `lib/mention-parser.ts` / `matrix/sync-manager.ts`（/sync 长连接 + 三层去重）/ `im/ipc.handlers.ts` / `im/room-ops.ts` / `im/markdown-exporter.ts`

### 3.8 任务系统（B + D 子系统）　🔶 多处占位

| 功能 | 说明 | 状态 |
|---|---|---|
| 数据模型 | `tasks` 表：8 态状态机（draft/pending/assigned/in_progress/paused/completed/failed/cancelled，终态不可重启）；执行锁定（in_progress 后 execution_room 不可变）；任务可跨会话创建（source_room）→ 在另一会话执行 | ✅ |
| 创建路径 | ① 看板「+ 新建任务」② 会话内 📌 按钮（预填 source_room）③ agent inline 建议（未挂载） | ①②✅ ③🔶 |
| 启动机制 | ① 看板启动按钮（选/建执行会话）② 会话 #T-xxx mention（后端 conflict-detector/parseTaskMentions 就绪；专用输入框未挂载，手输 # 文本可被后端解析）③ 定时启动（TaskScheduler 30s 扫描 pending→assigned ✅）④ agent 自主 pickup（scanPickup no-op ❌） | ①③✅ ②🔶 ④❌ |
| 会话执行房命名 | 新建执行会话 `任务 #T-XXX: 标题前 20 字`，挂 workspace Space | ✅ |
| 冲突处理 | 5 策略存 room_settings.conflict_strategy；detector→resolver（纯函数）→executor（副作用）三层 | ✅ |
| 三层并发 | 全局 max_concurrent_tasks（默认 3）+ per-agent（v1 强制 1，schema 留 v2）+ provider 令牌桶（RPM/TPM 滑动窗口） | ✅ |
| 任务看板 UI | Linear 风格列表：状态栏（并发 n/m + 排队数）+ 5s 轮询 + 筛选（status/assignee/sort）+ TaskCard（优先级/#短ID/计划/指派/进度）+ 详情侧滑（启动/取消） | ✅ 但：assignee 筛选仅"全部 agent"占位 🔶、「进入执行会话」跳转占位 🔶 |
| 任务工具（暴露给 agent） | read_task / read_task_history / read_task_progress / create_task（默认禁用）/ complete_task / fail_task / list_tasks | ✅ |
| 记忆模块 | `MemoryProvider` 接口 + `SQLiteMemoryProvider` 最简实现（task/conversation 上下文；agent/user stub）；替代 v1 loadRecentHistory；子 agent 保持 fresh session 语义 | ✅ |

支撑：`storage/tasks/repo.ts + state-machine.ts` / `task/scheduler.ts + dispatcher.ts + starter.ts + conflict-{detector,resolver,executor}.ts + ipc.handlers.ts` / `components/task-board/*` / `task.store`

### 3.9 主/子调度协议（dispatch）　✅

- Matrix 自定义 event：`io.momo-studio.dispatch` / `task_reply` / `abort_dispatch`（v2 task_reply 加 reply_to 字段精确路由，避免广播）
- PM 侧 `dispatch:<slug>` 工具（按 sub 列表动态生成）；子 agent fresh session（仅 system + task prompt，不加载房间历史）
- dispatchContext（tool_budget / parent stream session）注入子任务

### 3.10 内置工具库（v1.5，24 个 + 虚拟工具）　✅

| 类别 | 工具 | 要点 |
|---|---|---|
| 文件（8） | read_file / write_file / list_files / edit_file / mkdir / rm / mv / exists | edit_file str_replace 唯一匹配 |
| 搜索（2） | grep / glob | 尊重 .gitignore（mtime 缓存）；50/200 条上限；>1MB 跳过 |
| Shell（1） | bash | 命令黑名单（rm -rf /、mkfs、dd、fork bomb、关机、git commit…）；环境变量白名单（不传 key）；10KB 截断；30s 超时 SIGKILL |
| Git（9） | status/diff/log/show（读）+ add/branch/checkout/stash（写）+ commit（走 GitPolicy 三层校验，拦截 `-c key=val` 防绕过身份） | 无 push/merge/reset（保留给人） |
| Web（1） | webfetch | 强制 HTTPS；HTML→Markdown；CSS 选择器提取；双阶段截断 |
| Todo（1） | todowrite | 全量替换协议；实时推送 + 终态持久化；UI TodoSection |
| LSP（2） | lsp_diagnostics / lsp_find_references | 仅 TS/JS workspace 条件注册；typescript-language-server stdio；懒启动 + 5min 闲置关闭 |
| 虚拟 | loadSkill / readResource / dispatch:*（运行时生成） | |
| 任务（v2） | 7 个 task_* 工具（见 §3.8） | create_task 默认禁用 |

支撑：`agent/tools/`（ToolModule 统一接口 + index.ts 注册中心 + shared 层：audit / output-truncate / permission）

### 3.11 能力配置（三层）　✅

| 层 | 内容 | 编辑入口 |
|---|---|---|
| L1 Definition | defaultTools / defaultMcps / defaultSkills | DefinitionEditor 内嵌 CapabilityTabs（3 Tab + 7 类分组 + 安全最小集快捷键） |
| L2 Workspace | workspace 级共享分配（tool/mcp/skill 三桶） | ⚠️ 旧入口 `CapabilityConfig.tsx`（176 行）**未挂载**——L2 编辑 UI 实际缺失 🔶 |
| L3 Assignment | per-assignment add/remove delta（6 字段） | AssignmentCapabilitiesDialog + AddToWorkspaceDialog 折叠区；保存后自动 stop+start 生效 |

合并逻辑：`capability-merger.mergeCapabilities`（L1∪L2[L3±]），唯一消费方 `buildSpawnOpts` 注入 `allowedTools`（v1.6 修复的关键 bug：之前字段被丢弃导致白名单形同虚设）。四处实现（allocation.ts / assignment-capabilities.ts / capability-merger.ts / def 字段）**无单一 owner**。

### 3.12 MCP　✅

- 自研 JSON-RPC 2.0 over stdio 客户端（不用官方 SDK，避开 CJS 冲突）；workspace 级共享进程池（相同配置只启一个进程，in-flight Promise 共享）
- 注册 UI：RegisterMcpDialog（name/command/args/env 表单 → 落库 + 立即启动）
- renderer 的 `mcp:listTools/callTool/stop` IPC 通道未被 UI 使用（agent 子进程经 child IPC 走 host-manager）

### 3.13 Skill　✅

- 渐进式披露三层：frontmatter 索引（始终在上下文）→ 正文按需加载 → 附加资源按需读
- zip 上传：三种结构（扁平/单子目录/多子目录批量）+ macOS/Windows 元数据自动忽略 + SHA256 幂等 + 路径三重防御
- 内置：git-workflow / code-review / debugging / markdown-format

### 3.14 资源库（v1.7 重构）　✅

- 统一模型 `ResourceItem`：3 类（agent/mcp/skill）× 4 源（builtin/marketplace/custom/**p2p 预留**）；ID 约定 `${source}-${type}-${slug}`
- UI：双层 tab（类型×来源 AND 过滤）+ 搜索 + ResourceCard 统一卡片 + SourceBadge + 按 source 分支详情面板 + 「+ 添加资源 ▼」（创建 Agent/添加 MCP/上传 Skill）
- IPC 收敛为 `resource:list/getDetail/install/delete` 4 通道（底层复用 marketplace installer + mcp/skill 模块）
- builtin catalog：catalog.json 5 项

### 3.15 LLM Provider 管理　✅

- 供应商注册表（model_providers 表 + apiKey 入 keychain）：CRUD + 设默认 + **测试连接**（防 SSRF：https 限制）
- provider 抽象：`createLLMProvider` 按 platform 显式或 baseUrl 启发式分派 OpenAI/Anthropic 兼容；SSE 流式（含 thinking/reasoning 捕获）+ 非 SSE 降级 + 指数退避重试（429/5xx）
- ⚠️ 已知债：无 platform 列，非标域名 Anthropic 兼容供应商可能被误判
- v2：ProviderTokenBucket（RPM/TPM 滑动窗口限流）

### 3.16 设置　✅

6 分类左导航：模型供应商 / 会话设置（全局工具上限）/ Git 策略（含 pattern 实时预览）/ 审计日志 / 节点互联（P2P）/ 账户。全局配置存 kv_store，房间配置存 room_settings（maxToolCalls + conflictStrategy）。

### 3.17 安全与审计　✅（sandbox ❌）

| 层 | 机制 | 状态 |
|---|---|---|
| 路径沙箱 | `WorkspaceFS` 三重防御：字符串边界 + realpathSync 逐级祖先检查（防符号链接逃逸）+ `.git/` 拒绝访问 | ✅ |
| 工具权限 | allowedTools/deniedTools 白名单 + 通配符（`git_*` / `mcp:github:*`）；denied 优先 | ✅ |
| Shell 防御 | 命令黑名单 + 环境变量白名单 | ✅ |
| Git 策略 | GitPolicy（allowAgentCommits/分支保护/message pattern）三层校验 + UI 配置实时预览 | ✅ |
| 审计 | 每次工具调用入 `tool_calls` 表；设置页分页查询（agent/工具筛选） | ✅ |
| Electron 加固 | contextIsolation + sandbox + 无 nodeIntegration | ✅ |
| OS 级沙箱 | `sandbox/` 5 文件（macOS Seatbelt profile 完整实现 / Linux namespace 占位 / fallback）——**runtime-spawner 直接 fork，sandbox 从未接线** | ❌ 死代码 |

### 3.18 记忆/上下文　✅（v1 最简实现）

`memory/`：MemoryProvider 接口（task/conversation/agent/user/workspace 五路 context）+ SQLiteMemoryProvider（关键事件白名单过滤 + 文件改动提取；agent/user 返回 stub）。为 v2+ 完整记忆系统（LLM 总结/向量检索）预留。

### 3.19 P2P 联网（C 子系统）　🔶 代码先行、装配滞后

| 能力 | 状态 |
|---|---|
| 节点身份 | Ed25519 keypair，nodeId = `node_<公钥前 16 hex>`，存 `<userData>/p2p-identity.json`（0o600）✅ |
| 信任模型 | trust-store（trusted-nodes.json）：mDNS 发现 → 用户添加信任（取公钥）→ 移除；v1 信任后全互通 ✅ |
| 局域网 | mDNS 自动发现（Bonjour `_momo-studio._tcp`）+ TCP 直连 + NDJSON 线协议 + 签名验签 ✅ |
| 互联网 hub | HubTransport（WSS + X25519 ECDH + secretbox E2E）**代码完整 + 单测通过，但 initP2p 未接入 main/index.ts 启动链路（C8 产出、C9+ 集成）** 🔶 |
| 消息跨节点 | broadcastLocalMessage / handleRemoteMessage（INSERT source='lan'/'hub' + push renderer，不发 Matrix 防回声）✅ |
| UI | 设置 → 节点互联：NodeDiscoveryPanel（5s 轮询发现列表 + 🏠lan/🌐hub 图标 + 信任/移除）✅ |
| 跨节点 tasks / agent 调度 | **未开始**（v2.0-rc 范畴）❌ |
| 互联网模式 UI 入口 | 无（InternetModeToggle 未创建）🔶 |

**momo-hub（独立项目，~142 行 TS + ws）**：
- 职责：按 nodeId 路由 E2E 密文 + 在线列表广播 + 静态 token 认证 + 限速（100 msg/IP/60s）；**不持久化用户数据**（邮递员模型）
- 协议 6 消息：hello / presence / send / deliver / ack / error
- 部署：`node dist/server.js` 或 Docker（node:20-alpine）；HUB_PORT / HUB_TOKENS 环境变量
- **状态**：🔶 离线消息缓存是 TODO（Redis 计划）；HubTransport 收 error 仅吞掉、无重连；水平扩展不支持（内存 Map）；自身 0 测试；公共 hub（hub.momostudio.io）未上线
- **不在 pnpm workspace 内**（独立 package.json/lockfile）

### 3.20 本地 Matrix 服务器（Tuwunel/Conduit）　✅

- `conduit/manager.ts`：spawn 子进程 + 写 config.toml（含开注册双确认标志）+ 健康检查轮询（`/_matrix/client/versions`，15s 期限）+ 幂等启动；端口固定 8008
- bot 注册：`agent/bot-registrar.ts`（m.login.dummy，用户名带 workspace/owner 后缀）；token + password 双存 keychain（v1.5.8：Conduwuit 重启 token 丢失后自动 re-login）
- 二进制定位：跨平台 8 文件名矩阵（dev 走 resources/，打包走 process.resourcesPath）

### 3.21 数据存储　✅

- better-sqlite3 单例 + WAL + 外键；**22 个 inline SQL migration**（TS 字符串常量，非 .sql 文件——保证打包后可建表）
- keychain 抽象（macOS Keychain / libsecret / CredMan）：bot token/password、provider apiKey、user token、assignment apiKeyOverride
- 关键表（现行）：`workspaces` `workspace_members` `workspace_allocations` `agent_definitions` `agent_assignments` `agent_assignment_capabilities` `model_providers` `mcp_definitions` `tool_calls`（审计）`git_policies` `installed_packages` `room_settings` `kv_store` `messages`（v17）`message_events`（v17）`tasks`（v18/19）`global_settings`（v21）
- **废弃表**：`agent_meta`（v14 引入 v1.5.6 分层持久化，A 子系统废弃）；Matrix event content 的 `io.momo-studio.*` 富字段（thinking/tool_calls/todos/segment_* 等）

---

## 4. IPC 契约总账（renderer ↔ 主进程）

**97 个契约 = 91 invoke 通道（17 个功能域）+ 6 个主进程推送事件**。preload 与主进程 handler 完全对齐（无孤儿）。

| 功能域 | invoke 数 | 备注 |
|---|---|---|
| agent | 18+1(abort) | 最大域 |
| im | 12 | +3 推送（message / message_event_batch / conflict） |
| task | 8 | v2 新增 |
| workspace | 6 | |
| provider | 8 | |
| file | 6 | |
| auth / mcp / p2p | 4+1 / 5 / 5 | auth 另有 sessionExpired 推送 |
| resource / allocation / settings | 4 / 3 / 4 | |
| system / gitPolicy / audit / dialog / skill | 2 / 2 / 1 / 1 / 1 | |

**推送事件（6）**：`auth:sessionExpired`、`agent:runtimeChanged`、`agent:stream`（**已废弃**：主进程仍在推，renderer 已停止订阅，被 `im:message_event_batch` 取代——清理候选）、`im:message`、`im:message_event_batch`、`im:conflict`。

**未被 renderer 业务代码调用的通道（17 个，清理/启用评估候选）**：
`system:getInfo` `system:getConduitStatus` `workspace:delete` `workspace:getCoordinator` `agent:createFromYaml` `agent:assign`（被 addToWorkspace/assignMain 取代）`agent:isRunning`（改推送 + lastRunning）`provider:get` `provider:getApiKey` `im:getMessageEvents`（被 getMessages 打包返回取代）`mcp:listTools` `mcp:callTool` `mcp:stop`（子进程 child IPC 内部使用，可保留）`resource:getDetail` `p2p:getIdentity` `p2p:listTrustedNodes`

---

## 5. 健康/技术债清单（大重构决策素材）

### 5.1 v1/v2 新旧并存（⚠️ 重构主战场）

| # | 并存点 | 现状 |
|---|---|---|
| 1 | **runtime-manager.ts（905 行，@deprecated）** | v1 spawn/stop 骨架 + **v2 仍在用的流式 chunk 双通道转发（handleStreamChunk/routeChunkToBuffer）+ abortStream + activeStreams**。流式路径未切到 v2 独立模块 |
| 2 | 双启动路径 | `initTaskDrivenRuntime`（v2）与 `auto-start.ts`（v1）并存，靠 task_driven 字段分流 |
| 3 | runtime-entry.ts 1891 行 | 同一入口按 taskDriven 分流两套模式，是全仓最大文件 |
| 4 | 停止语义双轨 | `stopAgentRuntime` 需同时处理 v1 子进程 + v2 runner/pool + DB 三件事 |
| 5 | 资源三层旧接口 | `resource/*` 是门面，底下 marketplace installer / mcp host-manager / skill uploader 的 list/delete 仍各自保留 |

### 5.2 死代码 / 未挂载（❌，重构可直接清理 ~600+ 行）

| 项 | 位置 | 说明 |
|---|---|---|
| MentionInput.tsx | renderer/components/im（185 行） | @+# 双语法输入框，被 MessageInput 取代，未挂载 |
| InlineTaskSuggestion.tsx | renderer/components/im | agent 内联任务建议，未挂载 |
| CapabilityConfig.tsx | renderer/components/agent（176 行） | 旧 L2 能力编辑入口，未挂载（意味着 L2 workspace 级能力目前**没有 UI 编辑入口**） |
| sandbox/ 整目录 | electron/src/main/sandbox（6 文件） | OS 级沙箱从未接线，runtime 直接 fork |
| agent:stream 推送 | runtime-manager → preload | 主进程仍推、renderer 不订阅 |
| 17 个未用 IPC 通道 | 见 §4 | 部分有保留价值（mcp:* 子进程用） |
| DispatchCard / TaskReplyCard | renderer/components/im | 仅防御性兜底（MessageList 已过滤该类消息） |

### 5.3 半成品 / 占位（🔶，重构需决定补完或砍掉）

| 项 | 缺口 |
|---|---|
| agent 自主 pickup | `scanPickup` no-op——看板 assigned 任务不会自动执行 |
| abort_dispatch 路由 | RouterService 占位仅日志 |
| 看板 assignee 筛选 | 仅"全部 agent"占位 |
| 看板「进入执行会话」 | 跳转占位 |
| #T-xxx mention 输入菜单 | 后端解析就绪，前端专用输入框未挂载 |
| HubTransport 接入启动链路 | initP2p 未被 main/index.ts 调用 |
| momo-hub 离线缓存 / 重连 / 水平扩展 | TODO |
| 跨节点 task 同步 / agent 调度 | v2.0-rc 未开始 |
| e2e 测试 | Playwright 框架在，实际未跑通（README 长期待办） |
| workspace 删除 UI | 后端有通道，UI 无入口 |

### 5.4 超大文件（拆分候选）

| 文件 | 行数 |
|---|---|
| agent/runtime-entry.ts | **1891** |
| ipc/types.d.ts（共享类型契约） | **924** |
| agent/runtime-manager.ts | 905 |
| renderer GitPolicySettings.tsx | 302 |
| stores/im.store.ts | 275 |
| renderer WorkspaceAgentsPanel / FileTreeView / AddToWorkspaceDialog / DefinitionEditor | 245-251 |

### 5.5 已知 bug / 限制（README 技术债表 + 近期事故）

- **v2.0 上线后两轮全系统事故**：全agent离线（isRunning 查旧 Map）→ 全agent不回消息（RouterService 永不 lazy 创建）。均已修复，但暴露"切换收尾 review 漏改"的系统性风险
- Tailwind 任意值 class（`max-w-[70%]`）不生成 CSS——宽度只能 inline style
- matrix-js-sdk 锁 v31（v34+ 纯 ESM 与 CJS 主进程冲突；升级需先做主进程 ESM 转换）
- model_providers 无 platform 列——baseUrl 启发式检测可能误判
- 3 个 conduit/manager 测试 flaky
- 旧分段消息（v1.7.3 前）thinking/tool_calls 已永久丢失
- macOS/Windows 的 Tuwunel 二进制待预编译（当前仅 Linux）
- 协调 agent 被停止后团队群无 @ 消息无人接待（明确列为范围外）
- 同房中断限制 / StreamState 内存累积（v1.4 记录的债，A 子系统重写后需重新验证）

### 5.6 测试资产

- electron + renderer 共 ~1200+ 测试（v2.0 task-driven spec 基线 1207）；renderer 39 个测试文件 ~4500 行
- 覆盖重点：im.store / agent.store / CapabilityTabs / ResourceLibraryView / AgentStreamBubble / migration 回填 / task-driven e2e（4 场景）/ router lazy init 集成
- 缺口：momo-hub 0 测试；Playwright e2e 未跑通；真实 LLM API 的端到端验证缺失

---

## 6. 重构视角关键观察（一句话版）

1. **系统真正的内核已经换过一次**：v2.0 把「消息驱动长存 runtime」换成「task-driven 临时 runtime + SQLite 事件溯源」，但旧引擎没拆（runtime-manager 905 行 deprecated 仍在服役流式转发），新旧管线在 runtime-entry.ts 1891 行里靠字段分流——这是复杂度和 bug 的最大来源。
2. **v2.0 的完成度不均匀**：A（消息源）基本收官；B/D 骨架完成但 pickup/abort/看板细节有占位；C 只有零散代码（hub 未接线）。重构前需要先决定"补完 C"还是"砍掉 C 保单机"。
3. **UI 侧有三块"影子功能"**：@+# 输入框、内联任务建议、L2 能力编辑——后端全通、前端没挂。要么挂载要么删除，不要带着半挂载状态进重构。
4. **IPC 面有 97 个契约、17 个无调用方**，加上已废弃仍推送的 agent:stream——契约面需要一轮收敛。
5. **能力配置三层散落四处无单一 owner**、**资源库门面下三层旧接口**——这两处适合在大重构中合并归一。

---

*附：本清单由四路并行代码审计生成（主进程/renderer/IPC/momo-hub），细节可追溯至各审计报告；版本史依据 CHANGELOG.md 与 docs/specs/、docs/plans/ 全部 52 份文档。*
