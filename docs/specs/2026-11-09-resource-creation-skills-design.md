# 资源创建技能组设计（会话内直接创建 Agent / Skill / MCP / 团队）

- 日期：2026-11-09
- 状态：待评审
- 类型：宿主特性（新内置工具模块 + resource-ops IPC 桥 + builtin 技能内容 + Momo 升级与存量再同步）
- 设计依据：`docs/specs/2026-08-31-agent-team-session-redesign.md`（agent/团队域）、`docs/specs/2026-10-15-plugin-system-design.md`（插件边界探明）、`docs/specs/2026-09-24-p2.4-mcp-quick-create-and-json-import-design.md`（MCP 快速创建链）
- 已与用户确认的三个裁定：**直接落库生效**（不做确认弹窗）、**技能+工具默认挂 Momo（general-assistant）**、**方案 A 宿主 builtin 路线**（否决插件路线与子进程直写，理由见 §3）

## 1. 背景与目标

四类资源（agent / skill / MCP / 团队）目前只有 UI 手工创建入口（预置库启用 / ImportAgentYamlDialog / UploadSkillDialog / McpJsonPasteDialog / TeamDialog）；agent 会话内的 58 个内置工具没有任何资源创建类工具——「造资源」没有成为系统能力。

本设计交付**一组资源创建能力**：6 个内置工具 + 4 册方法论技能，默认挂在 Momo 上。用户在会话里说「帮我建个翻译 agent，再和它组成翻译团队」，Momo 盘点资源 → 起草定义 → 调工具直接落库 → 资源库 / 成员列表 / 团队页原生出现，立即可用。

成功标准：

1. 会话内一句话可完成：建 agent 定义（可含加入工作空间）、装 skill、配 MCP（含连通验证）、组团队，全程无 UI 操作；
2. 会话内创建与 UI 创建走**同一条主进程校验链**（manifest 解析 / slug 白名单 / 建团事务），零契约漂移；
3. 全量审计（logToolCall 工具名+参数入账），创建后 UI 原生刷新（renderer 零改动）；
4. 存量已启用的 Momo 升级后自动拿到新工具面与技能面（用户已配模型值保留）；
5. 任何自定义 agent 也可经成员编辑勾选这 6 个工具与 4 册技能（通用可挂，非 Momo 独占）。

## 2. 非目标

- 不做 update / delete 资源工具——UI 已有完整管理面，v1 明确不做（技能教 agent 引导用户去 UI 改）；
- 不改 skill 底层机制（SkillRegistry 三层渐进披露沿用现状）；
- 不做插件宿主资源门面 API（方案 B 演进位，见 §12）；
- 不新增资源类型、不动 IPC 通道契约面（resource:* 事件语义沿用）；
- 不做落库前确认弹窗（用户裁定直接生效；安全补偿见 §9）。

## 3. 方案比选结论（过程记录）

| 方案 | 结论 | 理由 |
|---|---|---|
| **A. 宿主 builtin 工具 + resource-ops IPC 桥**（本设计） | ✅ 采用 | 单一真相源（复用主进程全部校验/事务）、原生审计与刷新、为插件化留门 |
| B. 插件载体（momo-plugin 仓） | ❌ 否决（本期） | `PluginToolCtx` / `PluginServiceCtx` 无任何宿主资源 API——须先给宿主开插件资源门面，改动比 A 更大且引入新安全面；鸡生蛋（建资源前得先装插件）。A 的桥面将来可直接暴露为该门面 |
| C. 子进程直写 SQLite | ❌ 否决 | MCP 注册需主进程 Host 生命周期联动、skill 落盘在 userData（workspace 沙箱外）、UI 刷新事件源在主进程、建团是事务语义——直写绕开主进程不变量，双写者协调成本高 |

## 4. 现状复用点（探索钉死的事实锚）

| 复用点 | 位置 | 语义 |
|---|---|---|
| manifest 解析 | `agent/manifest-parser.ts` `parseAgentManifestWithSuggestion` | YAML → AgentDefinition，必填校验 |
| agent 定义落库 | `agent/crud.ts` `saveAgentDefinition` / `updateAgentDefinition` | upsert；source/workspaceId 由调用方定 |
| 模型绑定缺省 | `plugin/agent-sync.ts` `resolveModelBinding` | 优先级：行内已配 > 全局默认聊天模型（defaultChatModel）> null |
| workspace 成员 | `agent/crud.ts` `addMember` / `generateAgentUserId` / `listMembers` | 同 ws 同 def 唯一 |
| skill 安装尾链 | `skill/zip-uploader.ts`（`getSkillsDir` = `<userData>/skills/`）+ skill_definitions 落库 | 目录 + SKILL.md → 注册 |
| slug 白名单 | `marketplace/types.ts` `isValidSlug` | 防路径穿越 / 注入（installer S1 同款防线） |
| MCP 注册与握手 | MCP 快速创建链（p2.4）+ `mcp/host-manager` `listMcpTools` / `getOrStartMcp` | 注册 + 连通测试路径现成 |
| 建团事务 | `agent/team.ts` `createTeam` / `addTeamMember` / `listTeams` | ≥2 成员、leader∈成员、单事务 |
| 子进程→主进程桥模式 | `agent/mcp-bridge.ts`（子）+ 主进程子进程 message 路由（`mcp:listTools` 接线点）；`task-ipc-bridge` / `process-bridge` 同款 | id 配对 + 超时 + 类型前缀分发 |
| 窗口推送 | `resource/hub-install.ts` `broadcastProgressToWindows` 模式 | `BrowserWindow.getAllWindows().webContents.send` |
| builtin 预设幂等升级 | `agent/preset.ts` `enablePresetDef` UPDATE 分支 | 保留成员关系与 default 引用 |
| 工具目录 | `agent/tools/catalog.ts`（58 内置） | 新工具入目录后各消费面数据驱动出现 |

## 5. 工具面设计（`agent/tools/resource-tools.ts`）

新内置工具模块，6 个工具，`resource_` / `create_` 前缀对齐 `git_` / `browser_` 命名域。全部经 §6 桥在主进程执行；工具定义（LLMToolDef）与执行（ToolModule）同仓既有模式。

### 5.1 `resource_list`（先盘点后创建）

- 入参：`{ type?: 'agents' | 'members' | 'skills' | 'mcps' | 'teams' }`（缺省全量）
- 返回：聚合清单——agent 定义（id/slug/name/source/有无模型绑定）、当前 workspace 成员（instanceId/defId/name/在线态）、已装 skill（slug/name/source）、已配 MCP（name/transport/启停态）、已有团队（id/name/成员 instanceId/leader）
- 语义：为防重复创建与团队盘点服务；输出为紧凑摘要（控制 token），详情按需由 agent 二次问

### 5.2 `create_agent`

- 入参：`{ manifestYaml: string, addToWorkspace?: boolean, modelProviderId?: string, modelName?: string }`
- 行为：与 UI 导入链（`agent.createFromYaml` IPC handler → `parseAgentManifest` + `createCustomDef`）**同链复用**——解析校验（错误逐条透出，agent 可修后重试）→ **slug 全局冲突拒绝**（v25 定义全局化：任何 source 同 slug 即冲突；报错带既有 def 的 id/source，不做 bundle-import 式 -2..-20 静默后缀——会话创建需要明确性）→ 模型绑定复用 `createCustomDef` 内置兜底（入参显式 > `defaultChatModel` 全局默认；均无则报错指路设置）→ `defaultTools` 缺省 `SAFE_MINIMUM_TOOLS`（安全缺省，防未审查高危权限）→ 落库 source='custom'（**定义全局**，作用域由成员关系承载）→ `addToWorkspace` 为真时 `addMember`（幂等：先查既有成员）
- 返回：`{ definitionId, slug, member?: { instanceId } }`；解析失败原样透出 parser 错误（agent 可修后重试）

### 5.3 `add_agent_member`

- 入参：`{ definitionIdOrSlug: string }`（slug 查不到时报错列相近候选）
- 行为：定位定义 → `addMember`（幂等：同 ws 同 def 已存在时返回既有 member，不报错）
- 返回：`{ instanceId, agentName }`

### 5.4 `create_skill`

- 入参：`{ slug: string, skillMd: string, references?: Array<{ path: string, content: string }> }`（slug 显式必填——中文 name 无法可靠派生英文 slug，技能教 agent 起名规则）
- 行为：frontmatter 解析（name/description 必填，复用 loader 校验）→ slug 过 `isValidSlug` → 同名已装（builtin/custom/marketplace 任一来源）**拒绝**（报错带既有 skill 信息与来源，不覆盖）→ 写 `<userData>/skills/<slug>/SKILL.md`（+ references 文件，路径过同款越界校验）→ zip 安装尾链落 `skill_definitions`
- 返回：`{ slug, name }`

### 5.5 `create_mcp`

- 入参：`{ name: string, transport: { kind: 'stdio', command, args?, env? } | { kind: 'http', url, headers? } }`
- 行为：name 过 `isValidSlug` + 同名冲突拒绝 → **先测后落库**：瞬态客户端（stdio `McpClient` / http `HttpMcpClient`，不经进程池不落库）`connect()` + `listTools()` 握手（30s 超时对齐既有常量）→ 失败回传错误零落库（agent 可修参数重试）→ 成功后 `registerMcpDefinition`（p2.4 同款落库形状）→ 返回首层工具名摘要
- 返回：`{ name, toolCount, toolNames: string[]（截断至前 20） }`

### 5.6 `create_team`

- 入参：`{ name: string, iconEmoji?: string, memberInstanceIds: string[], leaderInstanceId: string }`
- 行为：`team.ts createTeam` 原事务（去重、≥2、leader∈成员、FK 校验全复用）；错误信息原样透出
- 返回：`{ teamId, name, memberCount }`

## 6. resource-ops IPC 桥

- 子进程侧：`agent/resource-ops-bridge.ts`——`requestResourceOp(op, args)`（id 配对 + 30s 超时 + `process.send` 方法调用式绑定铁律，复刻 `mcp-bridge` 全部教训）
- 主进程侧：挂在子进程 message 路由（与 `mcp:listTools` 同一接线点，实施计划钉精确文件行），消息 type 前缀 `resource-op:`，**op 白名单枚举分发**（`list` / `createAgent` / `addMember` / `createSkill` / `createMcp` / `createTeam` 六个入口，未知 op 一律拒绝——桥不是通用 RPC 面）
- workspaceId 取自主进程侧 spawn 上下文（子进程不可伪造——入参不带 workspaceId，防越权写别的 ws）
- 刷新推送（计划期探明：**无通用资源刷新通道**——`registerPluginAgents` 落库后零推送，`resource:registerMcp` / `uploadSkill` 注释里的「广播」是死注释，现行刷新纯靠 renderer 拉取）：新增 `resource:changed` 全窗口广播（复用 `pushToMainWindow` / `notifyPanelsChanged` 既有模式）+ preload `resource.onChanged` 订阅 + resource.store（`load()`）与 agent.store（成员/团队重拉）两处监听；成员增减类 op（createAgent-addToWorkspace / addMember / createTeam）同时广播既有 `agent:runtimeChanged`（MainLayout 既有监听即重拉成员）
- MCP 注册成功联动 Host 进程池热加载（既有注册链语义）

## 7. 技能设计（4 册，`electron/resources/skills/`）

通用规范：frontmatter `name` + `description`（含中文触发短语——渐进披露命中率关键）；正文四段（适用场景 → 工作流 → 输出规范 → 硬规则）；正文 ≤3KB，超出拆 `references/`。

| slug | 名称 | 内容框架 |
|---|---|---|
| `create-agent` | 创建 Agent | manifest YAML 全格式参考（apiVersion/kind/metadata/spec 四块逐一说明 + 完整可抄示例）；四段式 prompt 方法论（角色锚定/工作流/纪律/硬规则）；工具最小授权原则（只授任务必需工具，58 内置目录分组速查拆 references/）；model 块 = 建议位语义；建后自检清单（slug 合法/工具名真实存在/defaultSkills 引用存在）。硬规则：NEVER 引用不存在的工具名与 skill slug；NEVER 建全局定义（一律 ws 私有）；创建前向用户复述名称/slug/工具面；同名冲突先问用户是否换名 |
| `create-skill` | 创建技能 | SKILL.md 格式（frontmatter name/description + 触发短语写法）；三层披露结构与 references/ 拆分判据；≤3KB 纪律；四段正文模板。硬规则：NEVER 递归自举（不创建「创建技能」的技能）；description 必须含使用场景触发语；建前复述 slug 与触发场景 |
| `create-mcp` | 创建 MCP | stdio/HTTP 双形态 config 模板 + 各一完整示例；常见 server 配置速查拆 references/；连通测试失败排查表（命令错/超时/凭证错）。硬规则：NEVER 主动配置用户未明确要求的 server；凭证/token 只写配置不在回复中回显；建前复述 name/transport/是否含凭证 |
| `build-team` | 组建团队 | 工作流：`resource_list` 盘点 → 缺口分析（需要哪些职能/既有定义可复用否/缺则 create_agent + add_agent_member 补位）→ leader 选择依据（职能匹配 + 向用户说明理由）→ `create_team` → `resource_list` 回读验证；团队语义说明（≥2 成员、leader∈成员、leader 获 dispatch）。硬规则：NEVER 跳过盘点直接建团；NEVER 建职能重复的成员；建前向用户复述阵容表（成员名/职能/leader） |

挂载：`general-assistant.yaml` v2.0.0 → **v2.1.0**：

- `defaultTools` += 6 工具（`resource_list` / `create_agent` / `add_agent_member` / `create_skill` / `create_mcp` / `create_team`）
- `defaultSkills` += 4 引用（`create-agent` / `create-skill` / `create-mcp` / `build-team`）——2026-11-02 下架 defaultSkills 后的首次恢复，systemPrompt 补一段「资源创建引导」（用户要建资源时按匹配技能执行）
- 4 册经 builtin 扫描（`resolveBuiltinSkillsDir`）注册，manifest 解析 defaultSkills 引用 → RuntimeSkillRef 既有链路

## 8. Momo 升级与存量再同步（P0 防线）

现状：启动不再自动全量落库 builtin——**存量已启用的 Momo（DB 行 v2.0.0，58 工具，无 defaultSkills）不会自动拿到新能力**。

设计：启动时一次性 builtin 再同步钩子（`agent/builtin.ts` 或启动装配处）：

- 仅对 `builtin-general-assistant` 行：YAML 版本 > DB 行版本时，走 `enablePresetDef` 的 UPDATE 分支语义（defaultTools/defaultSkills/systemPrompt/name/description 更新；**modelProviderId/modelName/thinkingJson 保留 DB 行用户已配值**；成员关系与 default 引用原样保留）
- 幂等：版本相等跳过；YAML 版本低（理论不可达）跳过并 warn
- 该钩子做成通用「builtin 预置版本升级」语义，不硬编码工具清单——未来 builtin 预设升级复用同路径

## 9. 安全与权限

- **直接落库 + prompt 层补偿**：用户已裁定不加确认弹窗；4 册技能统一硬规则「创建前向用户复述关键参数」；审计全量入账（工具名 + 完整参数）
- preToolUse 插件钩子天然可拦（fail-open 既有语义不变）
- `create_agent` 产出全局 custom 定义（v25 定义全局化，列已删）；作用域与可见性由「加入哪个 workspace」的成员关系承载；`defaultTools` 缺省 `SAFE_MINIMUM_TOOLS`——新建 agent 未经用户审查不自动获得 bash 等高危工具；模型缺省兜底复用 `createCustomDef` 既有语义
- `create_skill` slug 白名单 + references 路径越界校验（复用 `readSkillResource` 同款沙箱检查）
- `create_mcp` 不新增提权面：命令/凭证与用户手动在 UI 配置同信任级；凭证落库链路同 UI（不新增存储）；连通测试失败不落库防坏配置积压
- 桥白名单 op 枚举 + workspaceId 主进程侧取值 = 桥面最小化；子进程伪造 workspaceId 无效

## 10. 消费面矩阵（momo-feature-scope-rules，W1–W4 摘要）

完整矩阵落盘 `.omo/feature-matrices/2026-11-09-resource-creation-skills.md`（实施首任务执行 W1 三锚 grep 后填齐）。

| 消费面 | 新建（6 工具 + 4 技能 + Momo v2.1.0） | 存量（已启用 Momo） | builtin（未启用预置） |
|---|---|---|---|
| 工具目录 / 成员编辑工具页签 | catalog 58→64，数据驱动原生出现（验证 renderer 无 58 硬编码） | §8 再同步后原生获得 | 启用时经 manifest 原生获得 |
| 资源库 skill 页签 | builtin 4 册原生出现（listInstalled 扫描） | N/A | N/A |
| 资源库 agent 页签 / 预置卡 | Momo v2.1.0 描述更新（预置卡版本） | 再同步后行内字段更新 | 首启用即 v2.1.0 |
| 会话内创建的资源 | agent/skill/mcp/team 各页签经刷新推送原生出现（§6） | 同左 | 同左 |
| / 命令入口 | N/A（固定注册表，设计如此） | N/A | N/A |
| 定义编辑器 | Momo builtin 只读（既有语义）；会话建的 custom 定义可编辑 | 不改 | 不改 |
| 成员编辑（Momo 工具面） | 6 新工具可经 deltas 增删（既有模式） | 同左 | 同左 |
| catalog.json 双轨 | 4 册 skill 条目登记（builtin 内联，downloadUrl 空串） | N/A | N/A |

W4 门禁预答：⑦生效层（spawn 工具装配 + skill 注册）与可见层（目录/页签/候选）两层均有裁定；⑧验收锚点 = 新建全链路 + 存量升级 + builtin 只读三场景（§11）。

## 11. 测试与验收

单测（`electron/tests/` 镜像结构）：

| 域 | 锁什么 |
|---|---|
| `tests/agent/resource-ops-bridge.test.ts` | id 配对 / 超时 / 未知 op 拒绝 / workspaceId 主进程侧取值（伪造无效） |
| `tests/agent/resource-tools.test.ts` | 6 工具成功路径 + 失败路径：非法 manifest / slug 冲突（builtin 与 custom）/ 无默认模型时报错指路 / skill frontmatter 缺字段 / skill 同名拒绝 / references 路径越界拒绝 / MCP 连通失败不落库 / 团队成员不足与 leader 缺席 |
| `tests/agent/builtin.test.ts` 扩展 | Momo v2.1.0 解析：6 工具在 catalog 全集内、4 个 defaultSkills 引用在 skills 目录存在（引用一致性锁，防契约漂移） |
| `tests/agent/builtin-resync.test.ts` | 存量升级：v2.0.0 行 → 同步 → 工具/技能面更新、用户 model 值保留、成员关系保留、幂等 |
| 既有测试联动 | catalog 条目计数（如 `marketplace/client.test.ts` 硬编码数）+4 同步更新 |

真机验收（momo-acceptance，隔离实例 + CDP）：

1. **新建全链路**：对 Momo 说「帮我建一个翻译 agent（中英互译），再让它和你组成一个翻译团队」→ 观察：复述参数 → resource_list → create_agent(addToWorkspace) → create_team → 资源库 agent 页 / 成员列表 / 团队页三处出现 → 拉起该团队协作会话正常派发；
2. **MCP 路径**：「帮我接入 context7 MCP」→ create_mcp 连通测试 → MCP 页签出现且工具可发现；
3. **存量锚点**：用带旧版 Momo 行的库启动 → 再同步生效 → 会话内工具可用；
4. **builtin 只读锚点**：Momo 定义编辑器仍只读，成员编辑可经 deltas 调整 6 工具。

## 12. 交付物清单与边界

| 交付物 | 位置 |
|---|---|
| 工具模块 | `electron/src/main/agent/tools/resource-tools.ts`（+ catalog.ts 注册） |
| 桥 | `electron/src/main/agent/resource-ops-bridge.ts`（子）+ 主进程路由接线 |
| 4 册技能 | `electron/resources/skills/{create-agent,create-skill,create-mcp,build-team}/SKILL.md`（create-agent、create-mcp 含 references/） |
| Momo 升级 | `electron/resources/agents/general-assistant.yaml` v2.1.0 |
| 存量再同步 | builtin 再同步钩子（§8） |
| catalog 双轨 | `resources/marketplace/catalog.json` +4 条 |
| 测试 | §11 全列 |
| renderer | 小改动三处：preload `resource.onChanged` 订阅、resource.store 订阅重拉、agent.store 成员/团队重拉（工具目录已验证全数据驱动——`tools:getCatalog` 链无 58 硬编码，计划期探明） |

版本纪律：特性合入 → 三处 package.json alpha +1（不动终版号）。后续演进位：桥面暴露为插件宿主资源门面 API（方案 B 复活路径）；update/delete 工具视用户反馈二期评估。

## 13. 风险与备注

- **Momo 万能位 + 资源创建 = 权力面扩大**：6 工具全挂 Momo 后，Momo 可建带任意工具面的新 agent（间接提权链）。缓解：创建前复述纪律 + 全量审计 + `SAFE_MINIMUM_TOOLS` 安全缺省 + preToolUse 可拦；残余风险可接受（与用户手动建等价，用户已裁定）
- **技能内容质量**决定触发命中率：验收人工抽检 description 触发短语（沿 preset spec 既有要求）
- catalog 计数测试 fixture 联动（§11）；office 契约锁不受影响（不动 office-assistant——本设计唯一 builtin agent 只动 Momo）
- 接线锚（计划期已钉）：主进程子进程消息路由在 `runtime-spawner.ts`（per-child handler，`McpBridgeResponse` 同函数内）；启动再同步插 `index.ts` `runMigrations()` 之后（:95 一带，`reactivatePluginsOnBoot` 同风格）；MCP 落库复用 `registerMcpDefinition`（`mcp/host-manager.ts:351`，与 `resource:registerMcp` handler `resource/ipc.handlers.ts:251-275` 同输入形状）

## 14. 验收迭代记录（2026-11-10 真机验收发现）

- **model 块必填歧义修复**（commit 4f14cc54）：真机验收中 `create_agent` 两次因「spec.declarative.model.provider/model 不能为空」失败——parser 硬校验 ≠ 技能文案的「建议位」措辞，Momo 合理省略整个块。修复：`create-agent` 技能模板注释改「必填（校验要求）——值仅为建议位」+ NEVER 省略 model 块硬规则 + 工具 description 补必填契约；回归锁 ×2。
- **新增 `list_models` 第 7 工具**（commits 7dc2d30e + 89bf098f）：补上「agent 看不到真实模型配置」的缺口。op `listModels`（只读，不广播）：`listProviders()` + `listProviderModels()` + `getGlobalSettings().defaultChatModel` 聚合，返回 `{ providers[{providerId,name,platform,isDefault,verified,defaultModel,models[modelId,enabled,contextWindow,vision]}], globalDefault }`——**显式丢弃 baseUrl/apiKey/api_key_ref**（最小暴露面 + 安全测试锁）。挂载链：Momo YAML v2.1.1（启动再同步 2.1.0→2.1.1 存量自动进位，用户模型配置保留）+ 迁移 078（65 项冻结名单，074→077 先例同构，077/074 断言改指 078）+ `create-agent` 技能工作流插入选模型指引（先查清单，未指定建议 globalDefault）。
- **C1 修复真机验证通过**：验收会话中 `loadSkill('create-agent')` 返回完整正文 + `readResource(references/tool-catalog.md)` 读取成功——builtin 技能三层披露链路全通。

