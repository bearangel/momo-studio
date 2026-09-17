# Changelog

本文件记录 Momo Studio 的版本变更与研发账本。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

> **版本号说明（2026-09-13 起）**：产品版本号与研发账本**解耦**——「未发布」小节的 v2.x 条目是
> 特性分组账本，不是发布史；研发期产品版本停在 `2.1.0-alpha.N`，发正式版才定终号。策略全文见
> `docs/dev/release.md`「研发期版本号策略」。上一正式版：**v2.0.0**。

## [未发布] — v25 agent/会话域重构（去编排 + 团队 + 双会话）

设计依据：`docs/specs/2026-08-31-agent-team-session-redesign.md`。无旧数据兼容负担（migration v25 丢弃 role/parent 数据）。

### 重构（Breaking Change）
- **去编排**：`agent_assignments`（role=standalone/main/sub + parentInstanceId 父子链）退役 → `workspace_agent_members` 成员制（无角色，同 ws 同 def 唯一）；agent 定义全局化（`agent_definitions.workspace_id` 列 DROP）
- **团队取代主子编排**：`teams` / `team_members`（leader + 成员，建团事务保证 leader 必在成员集）；leader 在多成员会话中自动获得 dispatch 权（`buildDispatchSnapshot` 会话快照在 spawn 时定型，取代 role='main' + parent 链）
- **会话双类型**：「快速会话」（免弹窗直达 workspace 默认 agent；首条消息截断命名 + 接待 agent 首次回复后 LLM 异步生成标题）与「协作会话」（指定单 agent 或团队，建会快照展开 `session_members`）；workspace 级「团队会话」概念退役（`workspaces.team_session_id` / `coordinator_instance_id` → `default_agent_instance_id`）
- **接待路由**：非 @ 消息由会话内 `is_leader` 成员接待；@ 成员直答；目标成员离线自动拉起
- **IPC 通道面**：`agent:addToWorkspace`→`agent:addMember`、`agent:removeAssignment`→`agent:removeMember`、`agent:listAssignments`→`agent:listMembers`、`workspace:setCoordinator`→`workspace:setDefaultAgent`；`agent:assignMain` / `agent:updateAssignmentRole` / `workspace:getCoordinator` 退役；新增 `team:*` 七通道
- **AGENT_CONFIG 线协议**：`teamSessionId` 字段删除（dispatch/abort 目标会话一律用当前 `executionSessionId`）

### 新增
- AgentsView 双 Tab（Agent 成员 + 团队）；创建 Agent / 创建团队 / 创建协作会话三弹窗；会话入口 ⚡快速 + 👥协作 双常驻按钮；无默认 agent 时一次性选择引导
- 成员 leader 守卫（是任一团队 leader 拒绝移除，返回 blockedTeams）；删除命中默认 agent 联动置空
- 会话列表图标语义派生（单成员显示该 agent emoji；多成员显示成员 icon 组，leader 带 👑）

### 清理（Task 15 收官）
- 退役概念源码零残留：`AgentRole` / `parentInstanceId` / `coordinator` / `teamSessionId` / `assignMain` / `addToWorkspace` / `AgentAssignment` 过渡别名全部清除（合法残留仅 migrations 历史 SQL 与类型对齐注释）
- 148 个依赖 v25 前语义的红测试逐文件清账：夹具修复 / 断言重写 / 退役覆盖删除（裁定记录 `.superpowers/sdd/task-15-report.md`）；electron 全量 1306 + renderer 719 全绿
- e2e：新增 v25 最小冒烟（smoke.spec.ts）；旧 onboarding/Matrix 场景 spec 标记待重写（2.x 技术债在案）

## [未发布·研发账本] — 2.1.0-alpha 累积特性（自 v2.0.0 起）

以下条目为特性分组账本（非发布史）；spec 见 `docs/specs/` 对应文件。

### Windows 全平台化（v2.10 账本）
Windows 代码层硬化 + 打包就绪——路径语义 / spawn / 单实例 / NSIS 四层补齐；Linux 容器内 `vi.mock('node:path')` 注入 win32 语义锁住纯路径逻辑，真机验收进行中（平台标「实验性」）。
- `platform/paths.ts` 统一目录边界判定（win32 大小写/UNC/分隔符归一 + posix 逐字节等价）——六模块七处收敛
- 六模块 `*.win32.test.ts`（大小写命中 / UNC 命中 / 异盘拒 / `..` 边界 / POSIX 归一）
- MCP spawn 修正：win32 `shell` 三态注入 + 逐元素引号转义（内嵌双引号拒绝启动）；其余 spawn 点审计豁免
- 单实例锁（`requestSingleInstanceLock` + second-instance 聚焦，消除 SQLite WAL 双开冲突）
- NSIS per-user 加固 + 未签名 SmartScreen 指引
- 待真机验收：安装 / 首启授权卡 / MCP npx 实启 / 双开聚焦 / UNC 工作区

### 多仓 git 工具（v2.9 账本）
workspace 内层仓 agent 可见可操作——「发现列表是唯一 `-C` 入口」安全骨架。
- `git_repos` 发现工具（根在前字典序；探测器上提 `git/repos.ts` 与 v2.5 对账同源）
- 9 工具可选 `repo` 参数：缺省逐字节零变化；指定时 `resolveRepoPath` 双校验（边界 + 命中列表）
- GitPolicy 均匀继承（分支保护按目标仓当前分支匹配）

### Orchestration 元语（v2.8 账本）
- `dispatch_followup`（链重建续聊）/ `dispatch_bg`（句柄 + 在途上限 8）/ `dispatch_gather`（all|any，超时非错误）/ `dispatch_status` / `dispatch_cancel`
- taskId = 链 ID（多轮聚合）；handleTaskReply 单点收口扩展；零新表零迁移
- 已知边界：followup 子流暂不嵌套渲染 / bg 句柄不跨重启

### McpBrowser 浏览器工具（v2.7 账本）
puppeteer 零依赖——原生 WebContentsView 叠加 + per-workspace partition。
- 12 工具（navigate/tabs/snapshot/screenshot/evaluate/click/hover/type/press_key/scroll/console/close）
- 单页共享 + takeover 三入口（地址栏 / 显式 / overlay）；user 态工具立即失败可重试
- 右侧浏览器侧栏：可折叠 + 宽度拖拽（280-720 持久化）+ agent 折叠期间打开网站自动展开 + dev server 探活
- 安全：file:// 限定 workspace（双防线）/ popup 收编 / 下载拦截 / webPreferences 四硬化

### 任务断点续跑（v2.6 账本）
- `turn-reconstructor` 事件重建（完整工具对 verbatim / 孤儿 tool_call 合成中断 result / 降级 degenerate）
- 关机保态（`markShuttingDown`）+ boot 陈旧流清扫；`resumeTask` 复用 executeTask + 车道闸
- 启动恢复卡（[恢复]/[放弃]，撤回后放弃走 journal:revert）

### 变更账本与撤销（v2.5 账本）
- 五写工具落盘前单点记账（内容寻址 blob）；hash 守卫 + 逆序撤销（漂移拦截 + 黄标）
- 多仓 git 探测器事后核对 bash 账外变更；200MB + 30 天配额滚动清理
- 消息流「N 处变更」chip + 任务卡审查面板（`journal:*` 四通道）

### ShellTools OS 沙箱（v2.4 账本）
- macOS Seatbelt / Linux bwrap / Windows PowerShell plain 三平台；`resolveShellSpawn` 三态（wrapped/plain/blocked）
- **网络策略（2026-09-13 修订 B）**：三态收敛双态 `deny | allow`，默认 allow；ask 信任门全链下线（事后文本鉴定漏检为结构性天花板）；deny 态保留 netOff 信息卡
- bash 结果 `sandbox: <tag>` 行；strict 默认 + permissive 逃生门

### FileTools 防御硬化（v2.3 账本）
- 结构化 apply_patch（V4A + PEG + 原子回滚）；Read-before-Edit 强阻塞；edit_file 失败信息增强

### 供应商预设与思维模式（v2.2.x 账本）
- 15 家供应商预设两段式新建；思维模式两级配置（模型级 + agent 级，四级 fallback + 四种 wire 方言）

### Agent 记忆系统（v2.2.0 账本，三期完结）
- 三层记忆（会话/工作空间/全局）+ FTS5/jieba/BM25 检索；注入链路（7000 字符预算）；memory 三工具 + 自动提取 + 滚动压缩；设置页管理 + 导入导出 + 90 天清理建议
- 待办：macOS 主机冒烟八项

### 效率增强（v2.1 账本）
- ✅ UI 设计系统（语义 token / 原子组件 / lucide + ESLint 机械强制）
- ✅ OS 级沙箱接线（由 v2.4 完成）
- 🔲 分支工作流 / 并发多任务 / token 配额 / LSP 集成 / CRDT / e2e 重写（v2.7 已新增 browser e2e）

### 网络策略收敛为双态（2026-09-13 修订 B，独立条目）
三态（deny/ask/allow）收敛为 `deny | allow`，默认 allow；ask 信任门机制全链下线（−1717 行）——迟到点击语义、签名词形三轮真机修复后裁定：事后文本鉴定存在结构性漏检天花板，默认放行 + 拒绝留挡外传通道是诚实取舍。kv 迁移：显式 deny 保留，其余一律收敛 allow。

### 会话连续性修复（A+B）`2026-09-14`
- fix: 会话上下文窗口「最早 N 条」→「最近 N 条」（getConversationContext；ASC+LIMIT 语义陷阱，/compact 早在 v30 注释警示）
- fix: aborted/failed 空 body 行合成中断/失败标记（防 Anthropic 空 assistant 400 + 模型可见信号）
- feat: rebuildSessionContext——主会话跨轮上下文 events 级重建，工具调用/结果跨轮可见、中断轮孤儿 call 自动合成结果、steer 行时间窗去重、当前指令行双拼消除（spec: docs/specs/2026-09-14-session-continuity-design.md）

### 浏览器接管优雅等待 `2026-09-14`
- feat: browser_* 工具用户接管时驻留等待（gateAgentSide 单飞，默认 120s 可配）+ 空闲自愈（90s 无输入自动回切，仅 agent 等待中判定）+「释放并继续」提示卡（notice kind agent-waiting-release / durationMs 契约加法）
- fix: 接管错误文案诚实化——超时出口携带等待秒数与 webfetch 改道指引（原「等待释放后重试」承诺了不存在的等待能力）
- fix: 释放提示遮挡修复（2026-09-15）——fixed 右下角卡落在浏览器 WebContentsView 占位区 rect 内被页面盖住（OS 合成层高于一切 DOM），改为 BrowserSidebar chrome 列内条幅，构造上无重叠（同类先例：侧栏拖拽手柄 bug 1）

### 提示交互分级统一 `2026-09-15`
- feat: 阻断类确认居中（信任授权带遮罩 / 释放等待无遮罩，安全区动态避让浏览器侧栏）+ 告知类右下堆叠（NoticeStack，上限 4 + 6s 消散）
- feat: 死信补渲染——crash 重载/popup 拦截/导航失败三 kind 首次可见；沙箱/升级/恢复三卡迁入堆叠，四卡同位叠放旧债清偿

### 浏览器 tab 归属制与隐藏/销毁分离 `2026-09-15`
多会话 tab 抢占 + 折叠劫持两痛点根治——agent 各自独立 tab 集合、收起=隐藏不销毁、会话级可见性、自动展开规则、关闭确认防误杀。spec：`docs/specs/2026-09-15-browser-tab-ownership-design.md`；计划：`docs/plans/2026-09-15-browser-tab-ownership.md`（7 任务 TDD 分解）。
- **tab 归属制**：manager `TabRecord.owner` + per-owner 光标 + `ownerTabs` 集合内重索引；12 工具按 `BrowserOpCtx.ownerId` 解析作用域（agent 实例 ID 或 `'user'`），`browser_tabs.list` 仅返回自身集合（user 源透出真实归属），`browser_close` agent 源只清自己集合、user 源全局销毁（含 agent tab）+ 仲裁复位全新起点
- **隐藏/销毁分离**：`browser:setSidebarVisible(false)` 视图 bounds 置零不销毁——agent 在用户收起期间照常 click/snapshot；落库折叠列 `browser_sidebar_collapsed` 退役（spec §7.4 列 inert，无 migration 触及）
- **会话级可见性**：renderer `browser-sidebar-visibility.store` per-session 替代落库 `collapsed`；新建会话默认收起，agent 首次导航自动展开本会话侧栏，他会话不受打扰
- **自动展开规则**：`browser:setActiveSession` 上报活跃会话（`App.tsx` 顶层 effect）；manager `expandHint` 仅活跃会话的 agent 导航触发，非活跃/null 安全缺省永不动可见 tab
- **关闭确认卡**：`browser:closeBrowser` 用户路径遇 agent 活 tab 弹居中确认卡（Tier A，`BrowserCloseConfirmCard`）——强制关闭走 user 源全局销毁路径；agent 工具 `browser_close` 不弹卡（其作用域已只清自己集合）
- **协议层**：线协议 12 op 元组尾部恒携 `BrowserOpCtx = { ownerId, sessionId }`（op-router 信封校验 + 元数上限表双锁 `source='user'` 走私路径）；renderer `BrowserSettings` 读面保留 `sidebarCollapsed`（store 形状不变），写面（`browser:updateSettings` `PATCH_KEYS` + 设置页「默认折叠」勾选 UI）下架
- **IPC 通道面**：14 → 16 通道（新增 `browser:setSidebarVisible` / `browser:setActiveSession` / `browser:closeBrowser` user 源）；`browser:setSidebarCollapsed` 退役
- **回归锁矩阵**：`tests/browser/{ipc,manager,manager-hide-expand,manager-ownership,op-ctx-threading,boot-wiring}.test.ts` + `renderer/src/components/workspace/BrowserSidebar.test.tsx` + `renderer/src/App.test.tsx`（活跃会话上报首报+变更重报）；11 commits 全量 typecheck/test 零错误（Task 7 收尾清扫 + 变异验证：`closeBrowser` 复位行摘除→接管区分度断言红；`App.tsx` 上报 effect 摘除→重报断言红）

### 会话输入框上下文系统（v2.11 账本）
spec：`docs/specs/2026-09-16-composer-context-system-design.md`。输入框从纯文本升级为结构化上下文载体——用户意图（skill / 文件）一次性注入本轮对话，metadata 与正文分离。
- **@ 文件引用**：composer `@` 提及 workspace 相对路径文件，随消息下发（≤64KB/文件、256KB/条消息内联，超限降级路径引用由 LLM 转文件工具自读）
- **/ 菜单命令 + 技能**：斜杠命令注册表（主进程 `commands.ts` 单一真相源）+ `/技能名` 挂载上下文；预置三技能（代码审查 / 调试 / 文档）
- **context 一次性注入（spec D2）**：主进程 `context-expander` 展开 → `<user-context>` 块包装进本轮用户正文（`turn-context.ts`）——每会话轮仅注入一次，会话重建只重放原文不重放展开
- **消息 chip**：owner 消息气泡上方的技能 / 文件 chip 行；文件 chip 点击 `file:read` 直开编辑器 tab，读取失败降级 disabled
- **P2P context 同步**：`SyncMessage.contextJson` 随消息广播，远端镜像同样渲染 chip
- **resume 断点重放（终审 I1）**：中断回合重建时首条用户消息的 context 与 steer 对称重放展开
- **egress 投影（终审 I2）**：steer 事件 `context` 全文只留 DB 供 resume，两处 renderer 出口（event batch 推送 / getMessages）一律剥离
- **交互精简（v2.11.1 主机验收反馈）**：`@` 统一菜单（agent + 文件同浮层双源过滤，移除 `@/` 独立语法，文件标记 `@路径` 与 agent 同形）；`/`、`@`、`#` 触发正则放宽为非空白字符集——中文名直接过滤；📎 点击直开菜单 + 空查询根目录默认文件列表（`file.list`，主进程零改动）；chips 自顶置工具条移入输入框容器内底部（Kimi 式），📎 移至框内左下角
- **内联 pill 富输入块（第三轮主机验收）**：textarea 升级为 contentEditable 富输入块——@（agent/文件）/ #（任务）/ /（命令/技能）选中的引用以原子 pill 内联在文字流中（填充底色式：agent 蓝 / 文件中性 / 技能紫 / 命令橙 / 任务绿；命令无前缀图标），光标处插入、退格两段式整删、IME 组字保护；会话草稿存 segments（pill 不丢）。发送序列化保持 IPC 三参契约不变（技能不进正文、命令整串拦截语义由形态保持）；菜单选择后焦点自动回编辑器、点编辑器即放弃菜单（终审修复）
- **句中 / 触发（第四轮主机验收）**：`/` 从整串锚定（仅空 body）改为空白前缀锚定——句中空格后与 pill 之后均可弹出命令/技能菜单，与 `@`/`#` 对称；路径/分数/URL 的 `/` 与 `//` 转义仍不触发；命令整串拦截语义不变（句中命令 pill 按混排正文发送）
- 已知边界：builtin 预置技能包不进子进程运行时 skill 索引——composer 注入路径不受影响；`<user-context>` 对内容零转义为设计取舍（与 file:read 等价暴露面）；selectSkill 光标居中会丢弃前段文本（低频边角）；e2e 打包路径待容器外验证

## [2.0.0] — 2026-09 Released

五期重构：**单进程 Electron + 内置 SessionService + 进程内事件分发**，本地零外部依赖（Matrix/Tuwunel 全家移除，−54 文件 −3226 行）。
- **P1 会话内核**：`sessions`/`session_members` 取代 Matrix room；dispatch/task_reply 内部事件桥
- **P2 UI 骨架**：无边框 + 自绘 TitleBar；活动栏 + 统一侧边栏；设置独立界面；provider platform 显式化；审计滚动删除；MCP 子进程桥恢复
- **P3 半成品处置 + IPC 收敛**：platform 运行时接线；#T 双语法 + T-序号任务 id 端到端；资源注册收敛 `resource:*`
- **P4 局域网 P2P**：payload 五类型分发；任务快照广播 + 远端只读镜像（D7 铁律）；资源分享 + 一键导入
- **P5 升级体验**：旧库只读导出 Markdown/JSON + `.legacy-v1.bak` 备份 + 首启一次性提示；完全重新开始（D5，不丢数据）
- 升级说明：v1.x 不做数据兼容；检测旧库自动全量导出 + 备份 + 告知路径；导出异常仅 warn 不阻塞

## [1.7.4] — 2026-08-12

### 修复
- **Bug 2（多段消息归组）**：MessageList 按 `io.momo-studio.segment_of` 字段归组多段 task_complete 消息，重启后 UI 显示与重启前一致——之前 N 段消息显示为 N 个独立气泡
- **Bug 3（事件顺序）**：多段消息由新组件 SegmentStack 按段顺序（segment_index）纵向堆叠，单段消息保持原顺序不变
- **Bug 4（增量 tool_calls）**：task_complete 分段 tool_calls 改为增量持久化（v1.7.3 全量快照导致每段重复显示所有工具调用）；新增 `io.momo-studio.tool_calls_offset` 字段
- **Bug 5（子 agent fresh session）**：dispatch 子 agent 跳过 `loadRecentHistory`——之前无差别加载房间历史，子 agent 误判任务已完成（输出"您好👋 之前的工作总结已加载完毕"）。参考 opencode task 工具设计：子 agent 是 fresh session，只看到 system + task prompt

### 新增
- 新组件 `SegmentStack`：多段消息纵向堆叠渲染（顶部聚合标签 + 每段段号分隔）
- 新类型 `SegmentGroup`：归组数据结构
- 诊断日志插桩：`task_complete` 分段 / `sendFinalMessage` / `loadRecentHistory` 关键决策点 trace 输出
- 测试：`segment-message-restart.test.ts` (3) + `dispatch-fresh-session.test.ts` (4) + `MessageList.segment.test.ts` (5) + `SegmentStack.test.tsx` (2)

### 已知限制
- v1.7.3 之前的旧分段消息已永久丢失 thinking/tool_calls（Matrix event 不可变）

## [1.7.0] — 2026-08-11

### 重构（Breaking Change）
- **资源库取代 Marketplace**：UI 重命名（MarketplaceView → ResourceLibraryView）+ 数据模型统一（`ResourceItem` 取代 MarketplaceItem / InstalledSkill / RegisteredMcp 三结构）
- **取消底部"自定义资源"折叠区**：custom 资源直接出现在主网格（按 source 过滤）
- **IPC 统一**：`resource:list` / `resource:getDetail` / `resource:install` / `resource:delete` 四通道，取代 `mcp:listRegistered` / `mcp:deleteRegistered` / `skill:listInstalled` / `skill:deleteCustom` / `marketplace:*` 等多套通道
- **资源 ID 命名约定**：`${source}-${type}-${slug}`——全局唯一 + 可路由（parseResourceId 反解三元组）

### 新增
- 双层 tab（类型 + 来源）AND 过滤 + 单按钮「+ 添加资源 ▼」下拉菜单（创建 Agent / 添加 MCP / 上传 Skill）
- SourceBadge 组件（4 source 颜色 + 文案：系统预置/我的上传/网络资源/P2P 共享）
- ResourceDetail 按 source 分支详情面板（builtin/marketplace/custom 字段差异分支显示）
- ResourceCard 统一卡片（install/removable 状态 + 删除/安装按钮）
- listResources 三源合并（builtin + marketplace + custom），filter 短路 + fetchCatalog 失败容错（catalog 拉失败时仅返回 builtin+custom，不阻断 UI）
- resource.store 双层 tab 状态机 + 安装/删除流程

### 删除
- `renderer/src/components/marketplace/` 目录（MarketplaceView / ItemCard / ItemDetail）
- `renderer/src/stores/marketplace.store.ts`
- IPC: `mcp:listRegistered` / `mcp:deleteRegistered` / `skill:listInstalled` / `skill:deleteCustom` / `marketplace:*`（5 通道）
- preload 6 个废弃绑定 + `marketplace` 命名空间
- types.d.ts: `RegisteredMcp` / `InstalledSkill` 类型 + ApiSurface 对应字段

### 修复
- v1.6.x 累积 bug 修复——`uninstallPackage` 之前传 `ResourceItem.id`（格式 `marketplace-mcp-foo`）但底层需要 catalog opaque id，导致 marketplace delete 静默 no-op；改为正确传 catalog opaque id

### 不动
- DB schema（Migration v0-v16 完全兼容，无新 migration）
- 底层函数（`listRegistered` / `listInstalled` / `installPackage` / `uninstallPackage` 等保留，作 `resource/` 内部复用）
- 现有 add 弹窗（RegisterMcpDialog / UploadSkillDialog / DefinitionEditor 保留，仅 IPC 调用层改名）
- builtin catalog 内容（catalog.json 不动，5 项全部归 `source='builtin'`）

### 架构预留
- `ResourceItem.source` enum 四值（`builtin` / `marketplace` / `custom` / `p2p`）——v2 agent 互联时加 `listP2PResources()` 即可接入

## [1.6.4] — 2026-08-11

### 修复
- **Marketplace 自定义资源区看不到上传的 skill**：根因双重——
  1. `<details>` 默认折叠，用户不知道点击展开；改为 `defaultOpen`
  2. `UploadSkillDialog` 成功后立即 `onClose()` 把弹窗关了，用户来不及看 successMsg 反馈；改为只 `setSuccessMsg + onSuccess`，弹窗保留显示「已安装：xxx」，用户手动关闭
- **refreshCustomResources 错误之前静默吞掉**：现在打到 `console.error`，DevTools 可看到 listInstalled 失败的真实原因（之前用户排查时看不到任何信号）

## [1.6.3] — 2026-08-11

### 修复
- **关键 bug**：UploadSkillDialog 上传 zip 永远报"未找到 SKILL.md"——根因是 Electron IPC buffer 传输损坏。renderer 经 preload 用 `Buffer.from(arrayBuffer)` 创建的 Node Buffer 跨 contextBridge 经 `ipcRenderer.invoke` structured clone 时，底层 ArrayBuffer view 关联断裂，main process 收到的是损坏数据。修复：preload 改用标准 `Uint8Array` view（structured clone 标准类型），main process IPC handler 加 `Buffer.isBuffer` 守卫自己转回 Buffer。

## [1.6.2] — 2026-08-11

### 新增
- **zip-uploader 支持三种 zip 结构**：
  - 模式 A（扁平）——`SKILL.md` 在根目录，slug 取 frontmatter.name 转 kebab-case，否则 zip filename 去 `.zip`。修复 macOS 用户 Finder 压缩的 xlsx.zip 场景（之前报"SKILL.md 未找到"）
  - 模式 B（单子目录包裹）——`<slug>/SKILL.md`（向后兼容，slug = 子目录名）
  - 模式 C（多子目录批量）——一个 zip 含多个 `<slug>/SKILL.md`，每个独立安装为一个 skill
- **自动忽略 OS 元数据**：`__MACOSX/` 整目录、`.DS_Store`、`._*`（macOS AppleDouble 资源叉）、`Thumbs.db`、`*.bak`——解压时跳过，不写进 skill 目录
- **批量安装幂等**：模式 C 下每个 skill 独立判断 SHA256（同 hash 跳过，不同 hash 覆盖），返回数组记录全部处理结果

### 改动（Breaking Change）
- **IPC 返回类型 `skill:uploadZip`**：`{ slug, description }` → `UploadedSkill[]`（即使只装 1 个 skill 也返回长度 1 的数组）。协调点：`zip-uploader.ts` / `ipc.handlers.ts` / `preload/index.ts` / `types.d.ts` / `UploadSkillDialog.tsx` 全部对齐
- `filename` 参数现在被使用（之前 `_filename`）：扁平结构时作为 slug 来源
- `UploadSkillDialog` 成功提示：1 个 skill 显示"已安装：slug（desc）"，多个显示"已安装 N 个 skill：a, b, c"

### 修复
- **Fix #1**：macOS 用户 Finder 压缩 zip 含 `__MACOSX/` 元数据导致"SKILL.md 未找到"——扁平结构现在合法支持 + 元数据自动忽略
- **Fix #2**：扁平结构（SKILL.md 在根目录）之前合法但 slug 退化为 `'unnamed'`，现在 frontmatter.name > filename 优先级正确

## [1.6.1] — 2026-08-11

### 修复
- **Layer 3 deltas 首次 spawn 不生效**：`AddToWorkspaceDialog` 在 `setAssignmentDeltas` 成功后未重启 agent，用户在折叠区改的 add/remove 工具不会反映到首次 spawn（agent 已在 `addAgent` 时 spawn，deltas 是后落库的）。修复为：deltas 落库后自动 `stopAgent` + `startAgent`；workspace 已删除则只 stop。
- **builtin marketplace 安装包 `defaultTools` 为空**：`installer.createInlinePackage` 之前写 `defaultTools: []`，导致 marketplace 安装的 builtin agent 落库后 `def.defaultTools` 为空，Layer 3 弹窗显示「默认 0 工具」误导用户。修复为：从 `ALL_BUILTIN_TOOLS` 生成 24 工具的 `[{kind:'builtin', ref}]` 数组，与 Migration v16 builtin YAML 同步策略一致。
- **`defToCapabilities` 重复定义**：`DefinitionEditor` 本地副本与 `capability-helpers` 完全重复，移除本地副本改 import 共享版本。

## [1.6.0] — 2026-08-11

### 新增
- **三层能力配置**：DefinitionEditor 加 Tab + 类别分组 checkbox，编辑 Layer 1 defaultTools / defaultMcps / defaultSkills
- **Layer 3 per-assignment override**：AddToWorkspaceDialog + WorkspaceAgentsPanel「调整能力」按钮（AssignmentCapabilitiesDialog），对 builtin/自定义 agent 做 add+remove delta
- **新建 custom agent 默认"安全最小集"**：read/write/list/edit/grep/glob/todowrite + dispatch-if-main（不再默认全放行）
- **Marketplace 自定义 MCP 入口**：顶部「+ 添加 MCP」（RegisterMcpDialog 表单式注册 name/command/args/env，写入 mcp_definitions 标记 source='custom'）
- **Marketplace 自定义 Skill 入口**：顶部「+ 上传 Skill」（UploadSkillDialog 本地 zip 包上传，解压校验 SKILL.md）
- **自定义资源管理区**：MarketplaceView 底部列出已注册自定义 MCP / 已上传 Skill，可删除
- **CapabilityConfig 增强**：builtin agent 显示「编辑 def」「调整实例能力」两个增强按钮入口

### 修复
- **关键 bug**：`buildSpawnOpts` 把 `mergeCapabilities` 的 `merged.tools` 注入 `RuntimeConfig.allowedTools`——之前完全丢弃导致 permission 层走空数组全放行，所有 agent 实际能用全部 24 个工具，能力白名单形同虚设

### 改动
- **Migration v16**：新增 `agent_assignment_capabilities` 表（Layer 3 deltas：add_tools/remove_tools/add_mcps/remove_mcps/add_skills/remove_skills）；`mcp_definitions` 加 `source`（builtin/custom/marketplace）+ `installed_at` 列
- **builtin default_tools 修复**：Migration 同步 builtin YAML 到 DB（之前 DB 里 builtin def 的 default_tools 为空）；三个 builtin YAML defaultTools 扩展为 24 工具全集（保持 v1.5 行为，升级无感）
- **mergeCapabilities 扩展**：支持 Layer 3 deltas 合并（builtin 全集 + add/remove delta 正确产出 tools/mcps/skills）

## [Unreleased] — v1.2

### v1.2.0 — 主/子 Agent 编排（M3）

#### 新增
- 主/子 agent 编排 UI：Agent 面板"列表/编排"视图切换，树形展示 main→sub 关系
- 添加子 agent / 解除父子关系 / 设为主 agent 三项操作
- AddAgentDialog 角色选择（独立/主/子）+ main 定义子 agent 勾选安装
- AgentList 角色徽标（📋主 / 🔗子 / 🤖独立）+ sub 缩进分组
- assignMain 支持 selectedSubDefIds 选择性安装子 agent

#### 修复
- assignMainAgent 传递 subAgents 给 main 的 spawnAgent（R1）
- auto-start 从 DB 重建 main agent 的 subAgents（R2）
- createFromYaml 解析 parentAgentId slug 为 UUID（R3）
- 删除 main agent 时级联删除其全部 sub agents

### v1.2.1 — 质量打磨（M4）

#### 修复
- keychain slot helper 去重（统一使用 llmApiKeyRef）
- updateAgentDefinition modelBaseUrl NULL 往返保真
- stopRunningInstancesByDefinition 实际停止分支补测
- 协调 agent 设定后自动重启（不再提示手动操作）
- setCoordinator + file CRUD 异常处理一致化
- 文件树折叠状态 localStorage 持久化
- 编排视图 main 节点支持折叠/展开
- assignMain 重复安装守卫
- 编排视图显示孤儿子 agent

#### 变更
- .gitignore 清理裸 docs 条目（docs/ 现可直接 git add）

## [1.1.1] — 2026-07-31

### 新增
- Agent 创建后可编辑（定义层；apiKey 独立更新）
- 文件树折叠修复（根级 + 子目录折叠；刷新/全部折叠工具条）
- 文件 CRUD（新建 / 改名 / 删除 / 移动；走 WorkspaceFS 路径防御）
- 团队群自动调度（主 agent 默认接待非 @ 消息）

### 修复
- 删除 agent 时让 bot 离开所有房间 + 清空悬空 coordinator
- bot 不接受新建房间邀请（owner 检查误拒）
- @候选只含本房成员 + 修复首次启动 @ 失效（运行态同步竞态）
- 自定义群 @agent 可回复（解除 team-room-only 守卫）
- 直接 @ 协调 agent 时不再注入协调引导（消除回复混乱）
- 会话中 bot 显示配置名称而非 Matrix userId
- 全部 IM 组件统一显示 agent 配置名称

## [1.1.0] — 2026-07-31

### 新增
- 会话房间新增 / 重命名 / 自适应解散（本地全员离开清空；团队群受保护）
- 群成员查看（⭐自己 / 🤖bot / 管理 徽标）
- 设置页分类导航（左导航 + 右内容）
- 全局模型供应商注册表（baseUrl + apiKey 入 keychain；创建 agent 时下拉自动填充）
- Agent 创建表单接供应商下拉

## [1.0.0] — 2026-07-28

### 初始发布
- Electron + React + Conduwuit 一体化桌面应用
- Workspace 管理（目录映射 + git init）
- Declarative agent（YAML manifest + LLM chat loop + 工具执行）
- 主子 agent 调度（IM dispatch/task_reply 协议）
- MCP stdio transport（共享进程池）
- Skill 渐进式披露（SKILL.md 三层加载）
- IM（Matrix /sync + Markdown + @mention）
- Marketplace 浏览/搜索/安装
- 安全（WorkspaceFS + sandbox + 审计 + Git policy）
