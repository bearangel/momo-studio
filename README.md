# Momo Studio

个人桌面端多 agent 协作平台：把可声明的 agent、可扩展的 MCP/Skill 市场、IM 通道和受控的文件沙箱，全部装进一个本地 Electron 应用。

完整设计见 `docs/specs/2026-07-28-agent-platform-design.md`。

## 状态

**v1.6.2 — Released**

v1.6 Agent 能力配置 + Marketplace 自定义上传——修复关键 bug（`merged.tools` 丢失导致能力白名单形同虚设），新增三层能力配置 UI（DefinitionEditor 编辑 Layer 1 + AddToWorkspaceDialog/WorkspaceAgentsPanel 做 Layer 3 per-assignment override）+ Marketplace 自定义入口（MCP 表单注册 + Skill zip 上传）。v1.5 内置工具库（7 类 24 工具）仍可用，详见 `docs/specs/2026-08-11-v1.6-capability-config-design.md`。

**v1.6.1** 修复三处 v1.6 review 发现的问题：AddToWorkspaceDialog Layer 3 deltas 首次 spawn 不生效（落库后未重启）；marketplace 安装 builtin agent 时 `defaultTools` 为空（改为写入 24 工具全集，与 Migration v16 builtin YAML 同步）；`DefinitionEditor` 与 `capability-helpers` 的 `defToCapabilities` 重复定义合并。

**v1.6.2** 扩展 zip-uploader 支持三种 zip 结构 + 一个 zip 多 skill 批量安装 + 自动忽略 macOS/Windows 元数据：模式 A（扁平，`SKILL.md` 在根目录，slug 取 frontmatter.name 或 zip filename）修复 macOS 用户 Finder 压缩的 xlsx.zip 场景；模式 B（单子目录包裹）保持向后兼容；模式 C（多子目录批量）支持一个 zip 安装多个 skill。IPC 返回类型 breaking change：`{ slug, description }` → `UploadedSkill[]`。详见 `CHANGELOG.md`。

## 特性

### Workspace 管理
- 创建 / 删除 / 重命名 workspace
- 每个 workspace 绑定本地目录（`~/...` 或自定义路径）
- 自动 `git init` + 初始 commit，作为 agent 写操作的版本基线
- 所有文件访问走 `WorkspaceFS` 抽象层，禁止越界

### Agent
- YAML 声明式定义（frontmatter + prompt body）
- v1.3：定义与分配解耦——身份/能力/模型在 def；角色/父子在 assignment
- v1.3：自定义 agent 可 workspace 隔离（默认私有，可选全局共享）
- v1.3：UI 双 Tab（本工作空间 + Agent 库管理）
- 内置 Anthropic / OpenAI 两个 LLM provider；v1.3 改为 provider 引用模式（baseUrl + keychain）
- 工具系统：v1.5 内置 7 类 24 个工具（文件/搜索/Shell/Git/Web/Todo/LSP）+ MCP 工具；v1.6 三层能力配置（Definition 默认集 + Assignment override + per-assignment delta）
- 主子调度：父 agent 通过 `dispatch` 派发子任务，子任务通过 `task_reply` 回传结果
- 完整运行历史与工具调用审计

### 即时通讯（IM）
- 本地 Tuwunel（Matrix 兼容协议）服务端，零外部依赖
- 支持私聊和房间消息
- Agent 在 IM 内可被 `@` 唤起，v1.4 流式回复（thinking 折叠 + 工具调用卡片 + Markdown 逐字输出）
- v1.4 多 agent 委派嵌套展示：dispatch/task_reply 不再作为独立消息，嵌套在 PM 气泡的 DispatchChip 内
- v1.4 可配置工具调用上限：全局默认 + 房间级覆盖 + per-task 重置（0-无限）
- 客户端渲染支持代码块、表格、链接、引用块

### MCP（Model Context Protocol）
- stdio transport
- 共享进程池：相同 server 配置只启一个进程，工具调用并发安全
- 配置、热重载、生命周期管理在主进程完成

### Skill
- 渐进式披露：`SKILL.md` frontmatter 元数据始终可用，正文按需加载到上下文
- 内置 skill：git-workflow、code-review、debugging、markdown-format

### Marketplace
- 浏览 / 搜索 / 安装 agent / skill / mcp 三类包
- 安装包自动注册到主进程的 agent / skill / mcp 定义列表
- 支持 zip 包下载 + SHA256 checksum 校验
- 市场源可通过设置页切换（默认 + 自定义 URL）

### 安全
- `WorkspaceFS`：所有路径经过验证，禁止 `..` 越界与符号链接逃逸
- 进程沙箱：renderer 进程禁用 Node.js 集成 + contextIsolation
- 审计日志：每次工具调用写入 SQLite，UI 可查询
- Git policy：agent 写文件走 `git commit`，可一键回滚

## 前置依赖

- **Node.js 20 LTS**：Node 26+ 会破坏 `better-sqlite3` 原生编译（`ERR_DLOPEN_FAILED`）。容器默认是 Node 26，先 `nvm use 20`。
- **pnpm 9+**
- 平台：macOS（arm64 / x64）或 Linux（x64）。Windows 是 v2 任务。
- Tuwunel（Conduwuit 继任者）当前仅预编译 Linux 二进制；macOS / Windows 待本地预编译（见 `docs/dev/conduit-manual.md`）。

## 安装

```bash
git clone <repo>
cd momo-studio
nvm use 20
npx pnpm@9.0.0 install
```

`postinstall` 会下载预编译的 Tuwunel 二进制。如果下载失败（离线环境），见 `docs/dev/conduit-manual.md` 手动放置。

> **`matrix-js-sdk` 锁版本说明**：仓库锁定 `^31.0.0`（不是 `^34`）。v34 是纯 ESM，与本仓库的 CommonJS Electron 主进程冲突，`pnpm install` 会报 `ERR_REQUIRE_ESM`。lockfile 已反映这个降级。

## 开发

```bash
nvm use 20
npx pnpm@9.0.0 dev
```

应用启动后会跑首次注册向导（创建本地 Matrix 账号），完成后进入主界面。

## 测试

```bash
nvm use 20
npx pnpm@9.0.0 typecheck       # electron + renderer 双 workspace 严格类型检查
npx pnpm@9.0.0 test            # 单元测试（electron + renderer 全部）
npx pnpm@9.0.0 test:e2e        # 端到端集成测试（需要已构建应用，慢）
```

### 单独跑某个 workspace

```bash
npx pnpm@9.0.0 --filter @momo-studio/electron test
npx pnpm@9.0.0 --filter @momo-studio/renderer test
```

## 打包

```bash
nvm use 20
npx pnpm@9.0.0 build                       # 先构建 renderer + electron
npx pnpm@9.0.0 --filter @momo-studio/electron dist  # electron-builder 产出 .dmg / .AppImage / .deb
```

产物输出到 `electron/dist-installers/`。

详细发布流程见 `docs/dev/release.md`。

## 项目结构

```
electron/      Electron 主进程（CommonJS, Node.js）
renderer/      React UI（ESM, Vite）
resources/     Tuwunel 二进制 + 下载脚本
tests/         Playwright 端到端测试
docs/
  specs/       设计文档
  plans/       实施计划
  dev/         开发者指南（setup / conduit-manual / release）
```

两个 workspace 包名：`@momo-studio/electron`、`@momo-studio/renderer`。

## 研发演进路线图

### v1.0 — 单机自洽 ✅ 已发布

本地优先的 agent 编排平台。一个用户、一台机器、开箱即用。

- ✅ Electron + React + Tuwunel 一体化桌面应用
- ✅ Workspace 管理（目录映射 + git init）
- ✅ Declarative agent（YAML manifest + LLM chat loop + 工具执行）
- ✅ 主子 agent 调度（IM dispatch/task_reply 协议）
- ✅ MCP stdio transport（共享进程池）
- ✅ Skill 渐进式披露（SKILL.md 三层加载）
- ✅ IM（Matrix /sync + Markdown + @mention）
- ✅ Marketplace 浏览/搜索/安装
- ✅ 安全（WorkspaceFS + sandbox + 审计 + Git policy + 崩溃重启 + LLM 重试）

### v1.1 — 打磨与补全 ✅ 已发布

不引入新架构，聚焦 v1 遗留项和体验优化。

- ✅ 会话房间新增 / 重命名 / 自适应解散（团队群受保护）
- ✅ 群成员查看（⭐自己 / 🤖bot / 管理 徽标）
- ✅ 设置页分类导航 + 全局模型供应商注册表（baseUrl + apiKey 入 keychain）
- ✅ Agent 创建后可编辑（apiKey 独立更新；保存后停止运行中实例并提示重启）
- ✅ 文件 CRUD（新建 / 改名 / 删除 / 移动；走 WorkspaceFS 路径防御）
- ✅ 团队群自动调度（主 agent 默认接待非 @ 消息；@ 别人不插嘴）

### v1.2 — 功能补全 + IM 体验优化 ✅ 已发布

**Agent 编排**

- ✅ 主/子 agent 编排 UI（委派调度）— runtime subAgents 传递修复 + auto-start 重启重建 + slug→UUID 解析 + IPC 角色/父 agent 校验 + 编排视图（树形展示 main→sub 关系）+ AddAgentDialog 角色选择 + AgentList 角色徽标分组 + 移除级联

**质量打磨**

- ✅ keychain slot helper 去重（`llmApiKeyRef` 统一使用）
- ✅ modelBaseUrl 往返保真 + stopRunningInstances 补测
- ✅ 文件树折叠 localStorage 持久化 + 协调 agent 自动重启
- ✅ setCoordinator / 文件 CRUD 异常处理一致化
- ✅ assignMain 重复安装守卫 + 编排视图孤儿子 agent 可见性
- ✅ `.gitignore` 裸 `docs` 清理 + CHANGELOG.md

**Dev 运维**

- ✅ Dev 模式 agent 行为日志 — `trace()` 函数 + 14 个插桩点（消息接收/LLM 调用/工具执行/dispatch/reply）
- ✅ LLM 请求超时 90s → 300s；dispatch 渐进式超时 3min→6min→fail

**IM 会话体验**

- ✅ 卡片归属与对话化视觉 — 抽取 `MessageFrame` 共享外壳（头像+名字+左右对齐），三类消息统一外壳；TaskReplyCard 补齐 agent 归属；DispatchCard 紧凑化
- ✅ 缩窗布局响应式修复 — LeftRail 永不压扁；RoomList/MembersPanel 可缩；MessageList 禁水平滚动
- ✅ Tailwind 任意值 class bug 规避 — 改用 inline style 约束宽度
- ✅ IM 工具条 + 成员按需浮层 — InputToolbar（成员切换按钮 + 预留扩展位）；MembersPanel 改 absolute 浮层（backdrop 关闭）；移除上线消息，改为在线/离线 badge

**测试覆盖**

- ✅ renderer 全套 105 测试（含 MessageFrame/DispatchCard/TaskReplyCard/MessageBubble/InputToolbar/MembersPanel 共 40 个 IM 组件测试）

### v1.3 — Agent 定义/分配解耦 + Workspace 隔离 ✅ 已发布

v1.2 最大架构债务：`agent_definitions` 表把「agent 是什么」与「在某 workspace 怎么用」混在一起，定义全局共享无 workspace 边界。v1.3 彻底解耦。

**架构重构（Migration v12）**

- ✅ AgentDefinition 删 `type` / `parentAgentId` / `model.provider` / `model.baseUrl`；加 `workspaceId`（NULL=全局）/ `modelProviderId`（引用供应商表）/ `modelName`
- ✅ AgentAssignment 加 `role`（standalone/main/sub）/ `parentInstanceId`（同 ws 父 assignment）/ `hasApiKeyOverride`（DB 标志）
- ✅ 数据回填：role 从老 def.type 推导；parent_instance_id 从老 def.parentAgentId + 同 ws 父 assignment 推导
- ✅ Keychain 新增 `agent.<instanceId>.api_key_override`（可选 per-assignment override）

**角色与父子关系剥离**

- ✅ 彻底从 definition 剥离到 assignment — 同一 agent def 在不同 workspace 可当不同角色
- ✅ `assignAgentToWorkspace` 接 role + parentInstanceId（校验循环引用）
- ✅ `updateAssignmentRole` 支持运行时改角色（从 main 改非 main 时级联停止 subs）
- ✅ `deleteDefinition` builtin 不可删；custom 级联清理 assignment + keychain + def

**模型供应商化**

- ✅ AgentDefinition 引用 `model_providers` 表（不再硬编码 platform/model/baseUrl）
- ✅ `resolveApiKey`：override ?? provider key（keychain 解析）
- ✅ `createLLMProvider` 按 baseUrl 自动检测 platform（anthropic.com → anthropic，其余 → openai 兼容）
- ✅ 现有 assignment 强制重配 provider（model_provider_id 留 NULL，启动时拒绝）

**自定义 Agent Workspace 隔离**

- ✅ 创建自定义 agent 时选 scope（默认 workspace-scoped，可选全局共享）
- ✅ `listAgentDefinitions(workspaceId?)` 按 `workspace_id IS NULL OR = ?` 过滤
- ✅ 切换 workspace 时 Agent 库只显示 global + 当前 ws scoped + builtin
- ✅ 删除 workspace 级联删除 scoped custom def（global 不受影响）

**Builtin 加载策略**

- ✅ YAML 仍可写 `type` / `parentAgentId` / `model.provider`（向后兼容）
- ✅ 不写入 DB（schema 已删除）；存内存 `builtinSuggestions` Map
- ✅ UI 添加 builtin 时预填建议角色 + platform

**UI 双 Tab 重构**

- ✅ `AgentsView`：Tab 容器（本工作空间 / Agent 库）
- ✅ `WorkspaceAgentsPanel`：按 main→sub 树形分组 + 孤儿 sub 警告 + 启停 + 移除 + 协调设置
- ✅ `AgentLibrary`：builtin/全局/工作空间三组 + 搜索 + 配置/编辑/删除
- ✅ `DefinitionEditor`：三模式（create/edit/configure builtin）
- ✅ `AddToWorkspaceDialog`：选 def + role + parent + apiKeyOverride
- ✅ `AssignmentRoleEditor` / `AssignmentApiKeyEditor`：运行时改角色/密钥

**IM 房间按 Workspace 隔离**

- ✅ `getRoomsForWorkspace(workspaceId?)`：按 Matrix Space `m.space.child` 成员过滤
- ✅ 新建房间自动加入当前 workspace 的 Space
- ✅ 切换 workspace 时 IM store 重置（rooms/messages/activeRoom 全清）

**工作空间与编辑器体验**

- ✅ 新建工作空间原生目录选择对话框（Electron `dialog.showOpenDialog`）
- ✅ 全量中文化（7 处 workspace → 工作空间 + Onboarding 英文翻译）
- ✅ Monaco 编辑器中文 locale（官方 NLS 本地打包，离线优先）
- ✅ 文件树增强（单击文件夹选中 + 目录级右键新建 + 空白区操作 + 工具栏跟随选中目录）
- ✅ 文件树选中状态互斥（文件↔文件夹）+ 根目录可选中

**测试覆盖**

- ✅ Electron 305/308（3 个 conduit flaky 预存）；Renderer 131/131；Typecheck 双 clean
- ✅ Migration v12 回填测试（7 用例，含孤儿 sub 边界）
- ✅ crud assignment 测试（15 用例：role/parent/循环引用/级联删除）
- ✅ builtin suggestions 测试（7 用例：v1.3 schema + suggestions Map）
- ✅ agent.store 测试（11 用例：v1.3 新签名 + 新 actions）

**待办基础设施项**

- 🔲 重启自动恢复 agent runtime（持久化运行状态）
- 🔲 打包后 YAML/migration 路径适配
- 🔲 e2e 测试跑通（xvfb + 真实 LLM API key）
- 🔲 Windows / macOS 沙箱实测

### v1.4 — 流式回复 + 可配置工具上限 + 委派嵌套 ✅ 已发布

v1.3 最大体验短板：agent 回复无流式反馈、工具调用上限硬编码 10 次、多 agent 委派场景消息混乱。v1.4 全面优化会话体验。

**流式回复（双通道架构）**

- ✅ LLM Provider `chatStream` — OpenAI/Anthropic SSE 流式解析，含 thinking 捕获（reasoning_content / thinking_delta）
- ✅ 双通道传输 — IPC 实时推送 chunk（< 100ms）+ Matrix 持久化最终消息（含 thinking + tool_calls 元数据）
- ✅ 流式气泡 — AgentStreamBubble：thinking 折叠区 + 工具调用卡片 + Markdown 正文 + 状态栏 + 停止按钮
- ✅ 中断重置 — 用户发新消息或点停止 → AbortController 跨进程中断 → 新任务新预算
- ✅ 非 SSE 降级 — 不支持流式的 provider 自动降级到 `chat()` 一次性返回
- ✅ PDU 渐进式截断 — 最终消息超 55KB 时逐级削减（工具字段 → thinking → 删除 thinking → 删除 tool_calls），body 永远保留

**可配置工具调用上限**

- ✅ Migration v13 — `room_settings` 表（房间级 `max_tool_calls`，NULL=继承全局）
- ✅ 全局默认 — Settings → 会话设置 → 工具调用上限（-1=无限 / 0=禁用 / N=上限）
- ✅ 房间级覆盖 — 创建房间时选 + 房间头部徽标修改
- ✅ Per-task 重置 — 每条用户消息 = 新任务 = 新预算池
- ✅ 共享预算 — main + sub agent 共用，dispatch 传 `tool_budget`，task_reply 回 `tool_calls_used`
- ✅ 预算注入 system prompt — agent 感知预算上限自行规划

**多 agent 委派嵌套展示**

- ✅ DispatchChip — 委派 chip（4 状态：排队/执行中/完成/失败），点击展开查看子 agent 工作
- ✅ SubAgentSection — 嵌套工作区（thinking + 工具调用 + Markdown 正文）
- ✅ 并行委派 — 多 chip 纵向堆叠，各自独立状态 + 进度指示器
- ✅ 消息过滤 — dispatch/task_reply/子 agent 消息不作为顶层独立消息（仅嵌套在 PM 气泡内）
- ✅ 历史还原 — 重启后从 Matrix 历史重建子 agent StreamState（按 `parent_stream_session_id` 关联）
- ✅ 中断传播 — PM abort 自动传播到子 agent（`streamChildren` 映射）

**滚动管理**

- ✅ 智能自动滚动 — 仅在用户处于底部 120px 范围内时跟随；滚向上查看历史不被干扰
- ✅ 瞬移滚动 — `behavior: 'auto'` 消除 smooth 动画叠加抖动

**测试覆盖**

- ✅ Electron 352/355（3 个 conduit flaky 预存）；Renderer 232/232；Typecheck 双 clean
- ✅ Migration v13 测试 + settings CRUD（12 用例）
- ✅ LLM Provider chatStream 测试（8 用例：OpenAI/Anthropic SSE + 降级 + abort）
- ✅ Runtime streaming 测试（20 用例：chunk 序列 + 预算 + abort + dispatch 嵌套）
- ✅ Stream store 嵌套测试（10 用例：dispatchChildren + parentStreamSessionId 关联）
- ✅ DispatchChip / SubAgentSection / AgentStreamBubble 组件测试
- ✅ 中断传播测试（7 用例：嵌套映射 + abort 传播 + 清理）

**待办基础设施项**

- 🔲 重启自动恢复 agent runtime（持久化运行状态）
- 🔲 e2e 测试跑通（xvfb + 真实 LLM API key）
- 🔲 Windows / macOS 沙箱实测

### v1.5 — 内置工具库扩充 ✅ 已发布

v1.4 之前 agent 仅 3 个工具（read/write/list）。v1.5 系统性补全 7 类共 24 个工具，对标 opencode 工具集水平。

**文件操作（8 工具）**
- ✅ read_file / write_file / list_files（v1.4 已有，搬迁）
- ✅ edit_file（str_replace 唯一匹配 + 失败回写文件头）
- ✅ mkdir / rm / mv / exists（暴露 WorkspaceFS 能力）

**搜索（2 工具）**
- ✅ grep（JS 正则，50 条上限）
- ✅ glob（文件名匹配，200 条上限）
- ✅ 自动加载 workspace .gitignore（mtime 缓存）

**Shell（1 工具）**
- ✅ bash（workspace 内自由 shell）
- ✅ 黑名单：rm -rf /、mkfs、dd、fork bomb、关机、git commit
- ✅ 环境变量白名单（不传 API key/token）
- ✅ 10KB 输出截断 + 30s 超时

**Git（9 工具）**
- ✅ status / diff / log / show（只读）
- ✅ add / branch / checkout / stash（写）
- ✅ commit 走 GitPolicy 三层校验（allowAgentCommits + 分支保护 + message pattern）
- ✅ 拦截 -c key=val 防绕过身份追踪
- ✅ 不提供 push/merge/reset（保留给人）

**Web（1 工具）**
- ✅ webfetch（HTTP 强制升级 HTTPS，HTML→Markdown）
- ✅ CSS 选择器提取
- ✅ 双阶段截断（100KB 原始 + 50KB 转换）

**Todo（1 工具）**
- ✅ todowrite（全量替换协议，会话内 store）
- ✅ UI 可见（TodoSection 嵌入 AgentStreamBubble/SubAgentSection）
- ✅ Matrix 持久化 + 重启还原

**LSP（2 工具，仅 TS/JS workspace）**
- ✅ lsp_diagnostics（错误/警告）
- ✅ lsp_find_references（含定义）
- ✅ typescript-language-server 集成
- ✅ 懒启动 + 5 分钟闲置 shutdown

**架构重构**
- ✅ 工具按类别拆 8 模块 + shared 层（output-truncate/audit/permission）
- ✅ 统一 ToolModule 接口 + tools/index.ts 注册中心
- ✅ tool-permission 扩展通配符（lsp_* / git_* / mcp:github:*）
- ✅ 沿用 v1.4 三层安全（WorkspaceFS + tool-permission + GitPolicy）

**测试覆盖**
- ✅ Electron 全套测试通过（108+ 新增单元测试 + 集成测试）
- ✅ Typecheck 双 clean
- ✅ 三阶段迁移（搬迁 → file-tools → 其他模块递增），每阶段独立可测

### v1.6 — Agent 能力配置 + Marketplace 自定义上传 ✅ 已发布

v1.5 把工具库扩到 24 个后暴露三处断裂：(1) 关键 bug——`buildSpawnOpts` 把 `mergeCapabilities` 的 `merged.tools` 字段完全丢弃，`RuntimeConfig.allowedTools` 永远 undefined，permission 层走空数组全放行，**所有 agent 实际能用全部 24 个工具**，能力白名单形同虚设；(2) `DefinitionEditor` 自定义 agent 表单完全没有 defaultTools/defaultMcps/defaultSkills 编辑入口；(3) Marketplace 只能浏览远程 catalog，没有自定义注册入口（后端 IPC 早已存在但 UI 没按钮调用）。v1.6 系统性补齐能力配置能力。

**关键 Bug 修复**
- ✅ `buildSpawnOpts` 把 `merged.tools` 注入 `RuntimeConfig.allowedTools`——之前完全丢弃导致 permission 全放行
- ✅ 合并函数 `mergeCapabilities` 扩展 Layer 3（assignment deltas add+remove）正确产出 `tools`/`mcps`/`skills`

**三层能力配置架构**
- ✅ Layer 1（Definition）— `DefinitionEditor` 加 Tab + 类别分组 checkbox，编辑 defaultTools / defaultMcps / defaultSkills
- ✅ Layer 2（Assignment）— builtin/自定义 agent 均可参与
- ✅ Layer 3（Override）— `AddToWorkspaceDialog` 与 `WorkspaceAgentsPanel`「调整能力」按钮做 per-assignment add+remove delta（`AssignmentCapabilitiesDialog`）
- ✅ 新建 custom agent 默认勾选"安全最小集"（read/write/list/edit/grep/glob/todowrite + dispatch-if-main）

**Marketplace 自定义入口**
- ✅ 顶部「+ 添加 MCP」——`RegisterMcpDialog` 表单式注册（name/command/args/env），写入 `mcp_definitions` 标记 `source='custom'`
- ✅ 顶部「+ 上传 Skill」——`UploadSkillDialog` 本地 zip 包上传，解压校验 SKILL.md，写入 skills 目录
- ✅ 底部自定义资源管理区——已注册自定义 MCP / 已上传 Skill 可删除

**v1.6.2 zip-uploader 扩展**
- ✅ 三种 zip 结构：扁平（`SKILL.md` 在根目录）/ 单子目录包裹 / 多子目录批量（一个 zip 装多个 skill）
- ✅ 自动忽略 macOS/Windows 元数据（`__MACOSX/`、`.DS_Store`、`._*`、`Thumbs.db`、`*.bak`）
- ✅ slug 决策优先级：frontmatter.name > zip filename（扁平）/ 子目录名（包裹）
- ⚠️ Breaking change：IPC `skill:uploadZip` 返回类型从 `{ slug, description }` 改为 `UploadedSkill[]`

**CapabilityConfig 增强（v1.5 兼容）**
- ✅ builtin agent（不可编辑 Layer 1）显示「编辑 def」「调整实例能力」两个增强按钮入口
- ✅ v1.5 升级路径——旧 builtin agent 行为不变（仍 24 工具全开，defaultTools 扩展为全集）

**Migration v16**
- ✅ 新增 `agent_assignment_capabilities` 表（Layer 3 deltas：add_tools/remove_tools/add_mcps/remove_mcps/add_skills/remove_skills）
- ✅ `mcp_definitions` 加 `source`（builtin/custom/marketplace）+ `installed_at` 列
- ✅ 三个 builtin YAML `defaultTools` 扩展为 24 工具全集（保持 v1.5 行为）
- ✅ builtin default_tools 修复——Migration 同步 builtin YAML 到 DB（之前 DB 里 builtin def 的 default_tools 为空）

**测试覆盖**
- ✅ Electron 534/534 passed（81 test files）；Renderer 341/341 passed（35 test files）；Typecheck 双 clean
- ✅ Migration v16 测试 + assignment-capabilities CRUD（含 add/remove delta 边界）
- ✅ mergeCapabilities Layer 3 合并测试（含 builtin 全集 + delta 叠加）
- ✅ buildSpawnOpts 注入 allowedTools 回归测试（防止 bug 复发）
- ✅ DefinitionEditor / AddToWorkspaceDialog / AssignmentCapabilitiesDialog / RegisterMcpDialog / UploadSkillDialog / CapabilityConfig 组件测试

从"单机工具"进化为"团队平台"。

- 🔲 **多 peer P2P 协作** — 多用户通过协调服务器互联，共享 workspace
- 🔲 **Git remote 同步** — workspace 文件通过 bare repo 跨 peer 同步
- 🔲 **跨 peer agent 调度** — @ 对方的 agent，任务经 Matrix 路由
- 🔲 **Agent SDK** — TypeScript/Python 自定义 agent 生命周期
- 🔲 **External runtime 桥接** — 接入 OpenCode / Codex / Claude Code
- 🔲 **MCP HTTP/SSE transport** — 远端 MCP server 接入
- 🔲 **Marketplace 上架** — 用户上传 agent/mcp/skill 包
- 🔲 **E2E 加密** — 人 ↔ 人 DM 加密
- 🔲 **消息搜索** — 全文检索 Matrix 历史
- 🔲 **Electron 主进程 ESM 转换** — 解除 matrix-js-sdk v31 锁定

### v2.1 — 效率增强 🔲 概念阶段

- 🔲 分支工作流（agent 工作在独立 branch，PR 式合并）
- 🔲 Agent 并发多任务（内部 task queue）
- 🔲 Token 配额管理
- 🔲 LSP 集成（Monaco 编辑器语言服务）
- 🔲 协作实时编辑（CRDT）

### v3.0+ — 生态扩展 🔲 远期愿景

- 🔲 Federation（跨 homeserver 联邦）
- 🔲 私有 Marketplace + 付费/计费
- 🔲 Headless agent runner（7×24 服务端）
- 🔲 移动端（iOS/Android 只读 + IM）
- 🔲 NAT 打洞（peer 直连）
- 🔲 Agent 自动能力发现 + 自定义代码 hook

### 技术债务跟踪

| 问题 | 影响 | 计划解决版本 |
|---|---|---|
| **Tailwind 任意值 class 不生成 CSS** | `max-w-[70%]` 等无效，宽度约束必须用 inline style | 待排查 Tailwind 版本/PostCSS 配置 |
| matrix-js-sdk 锁定 v31（v34 ESM 冲突） | 无法用最新 SDK 特性 | v2.0 ESM 转换 |
| OS 级沙箱简化实现 | 仅应用层防御 | v2.1 |
| Marketplace 无签名验证 | 不可信包风险 | v2.0 |
| **model_providers 表无 platform 字段** | createLLMProvider 按 baseUrl 启发式检测；非标准域名可能误判 | v1.5 加 platform 列 |
| **3 个 conduit/manager 测试 flaky** | SIGKILL/healthCheck/timeout 偶发失败 | 待排查测试时序 |
| **同房中断限制** | activeStreams 按 roomId 索引，PM 与子 agent 同房时子覆盖 PM entry | v1.5 改按 streamSessionId 索引 |
| **StreamState 内存累积** | 会话结束后 StreamState 不清理（保留完整展示），长期使用内存增长 | v1.5 加房间切换/定期清理 |

## 已知限制

- Tuwunel（原 Conduwuit 继任者）当前仅预编译 Linux 二进制，macOS / Windows 版本待本地预编译。
- `matrix-js-sdk` 锁定 v31，升级 v32+ 需要先把主进程迁到 ESM（v2 任务）。
- Marketplace 当前只支持 zip 包 + checksum 校验，未做签名验证（v2）。
- **Tailwind 任意值 class（如 `max-w-[70%]`）不生成 CSS**——宽度约束需用 inline style（`style={{ maxWidth: '70%' }}`）。待排查 Tailwind/PostCSS 配置。
- **LLM platform 按 baseUrl 启发式检测**——非 `anthropic.com` 域名的 Anthropic 兼容供应商可能被误判为 OpenAI。后续加 `model_providers.platform` 列显式指定。
- **同房中断限制**——PM 与子 agent 同在 team room 时，`activeStreams` 按 roomId 索引导致子覆盖 PM entry，dispatch 进行中点「停止」可能只中断子 agent。
- **旧消息子 agent 工具条**——v1.4 修复前生成的消息缺少 `subStreamSessionId`（被 PDU 截断丢弃），重启后 DispatchChip 无法展开查看历史。新消息正常。

## 许可

待定。