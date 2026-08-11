# Changelog

本文件记录 Momo Studio 的版本变更。格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

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
