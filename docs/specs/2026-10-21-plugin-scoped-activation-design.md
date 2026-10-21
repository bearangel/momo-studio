# 插件按工作空间激活与能力授权模型（plugin scoped activation）设计

- 日期：2026-10-21
- 状态：已评审通过（brainstorming 对话定稿），待实施
- 上游：`docs/specs/2026-10-20-codegraph-engine-integration-design.md`（D2「装即全空间注入」裁定在本设计中退役）
- 决策记录：存量语义选 A（保持现状）、授权粒度选 A（按能力逐项）、方案一（最小翻转）、停用即时全熄

## 1. 背景与目标

当前插件激活模型是「全局装即全量」：安装后默认在**所有**工作空间启用（`plugin_enablements` 行缺失 = 启用），其 MCP/tool/skill 默认对启用工作空间内**所有** agent 可用（opt-out 黑名单模型）。用户四条需求 + 一条停用语义追问，要求反转为 scoped 模型：

1. **安装即作用域**：在 ws X 安装 → X 默认启用，其他 ws 默认停用（插件列表仍全局可见）
2. **列表操作面**：插件列表提供 启用/停用 开关（作用于当前活动 ws）+ 状态徽标
3. **明细组件清单**：插件详情列出其提供的 MCP / 工具 / skill（含 agent、面板、service、config）
4. **能力默认关**：插件提供的 MCP/tool/skill 默认不给任何 agent；哪个 agent 拥有由用户逐项勾选决定
5. **停用即时全熄**：停用后 MCP/tool/skill 全部失效，拥有授权的 agent 不再看到；重新启用按原授权自动恢复

## 2. 语义模型：总闸与授权两层正交

```
ws 启用插件（plugin_enablements）     = 总闸：能力池是否可用（面板/服务/配置/可勾选）
agent 拥有能力（三层合并）            = 授权：定义声明 ∪ 工作空间授权 ∪ 成员勾选
```

- 总闸关（停用）不删任何授权行；总闸重开（启用）后授权自动生效
- 授权通道复用既有三层合并（`capability-merger.ts`）：Layer 1 `def.default*` / Layer 2 `workspace_allocations` / Layer 3 `agent_assignment_capabilities` deltas
- 插件自带 agent（如 code-navigator yaml `defaultMcps: [codegraph]`）的 def 声明是合法授权通道，不受影响

## 3. 现状缺口

| 缺口 | 位置 | 后果 |
|---|---|---|
| 默认启用语义 | `registry.ts isPluginEnabled`（行缺失 = 启用） | 无法表达「其他 ws 默认停用」 |
| 安装不带作用域 | `plugin:installZip/installDevDir` IPC 无 workspaceId | 安装无从记 origin |
| D2 全空间注入 | `installer.ts activateDeclarativeComponents → assignPluginMcpsToAllWorkspaces`；`mcp-sync.ts backfillPluginMcpsForWorkspace`（新建 ws 回填） | MCP 铺到所有 ws 所有 agent |
| 插件 skill 无条件附加 | `spawn-helpers.ts buildSpawnOpts`：`buildPluginSkillRefs(ws)` 旁路三层合并 | ws 内每个 agent 都拿到 |
| 插件工具黑名单模型 | deniedTools（默认全开，勾掉才禁）；`runtime-config.ts` 注释「可见性 = 装配面」 | 默认全 agent 可用 |
| 启停不重建运行时 | `rebuildAffectedRuntimes` 仅挂 `plugin:reload`；`setEnabled` 无级联重建，MCP 池不失效 | 停用后跑动 agent 继续用 |

## 4. 数据模型与迁移（066）

新迁移 `066_plugin_scoped_activation.ts`：

1. **enablements 全量回填**（存量 A）：全部 workspaces × 全部 plugins →
   `INSERT OR IGNORE INTO plugin_enablements (workspace_id, plugin_id, enabled) VALUES (…, …, 1)`
2. **存量 skill 授权物化（启动期回填）**：迁移是内联纯 SQL，无法扫盘取插件 skill slug——由 app 启动后 `backfillLegacyPluginSkillGrants()`（`installed_at < 2026-10-21` 截止日判定，INSERT OR IGNORE 幂等）承担，见 `plugin/legacy-grants.ts`。存量 agent 经 Layer 2 显式授权继续可见（codegraph-usage 在 4 个 ws 均保活）
3. **tools 存量**：无物化对象（当前无 tools 组件插件）。已知边界见 §12
4. **down**：保守清除——删 066 插入的 enablements 回填行无法与用户手写行区分，down 仅删「全 ws × 全 plugin 且无 origin 标记」的行集合并记录不可完全逆（参照 064 风格）

**默认语义翻转**（代码侧，随迁移同批）：

- `isPluginEnabled`：`row?.enabled !== 0` → `row?.enabled === 1`（行缺失 = 停用）
- `plugin/ipc.handlers.ts` 三处 `stillEnabled` LEFT JOIN（`setEnabled` ×2、`setConfig` ×1）：`WHERE e.enabled IS NULL OR e.enabled = 1` → `WHERE e.enabled = 1`
- 其余 13 个 `isPluginEnabled` 调用点（panel-sync / service-manager / reload / resources / assembly）行为一致性由迁移回填保证

## 5. 安装链

- `plugin:installZip` / `plugin:installDevDir` IPC 增参 `workspaceId`（renderer 传活动 ws；null → throw「无活动工作空间，无法确定安装作用域」）。marketplace 安装路径经 `installPluginZip` 自动继承
- 安装成功 → 写一行 `plugin_enablements(安装ws, plugin, 1)`；`syncPluginMcps` 照常注册 `mcp_definitions`（能力池），**allocation 零写入**
- `assignPluginMcpsToAllWorkspaces` 退役删除；`backfillPluginMcpsForWorkspace` 删除并摘除 `createWorkspace` 调用点——新建 ws 对所有已装插件默认停用
- reload 链不变（本就不写 enablement/allocation）

## 6. 装配链翻转（spawn 三点，`buildSpawnOpts`）

| 能力 | 改动 | 运行时 |
|---|---|---|
| **MCP** | **零改动**。`mcpNames = filterDisabledPluginMcps(filterEnabledMcps(merged.mcps), ws)` 不变——插件名此后只可能来自 def 声明 / allocation 显式 / 成员勾选 | 零 |
| **Skill** | `resolveSkillSlugs` 入参 = `merged.skills − 插件slug集`；`buildPluginSkillRefs(ws)` 从无条件附加改为 `∩ merged.skills`（插件 slug 只经三层合并进入） | 零 |
| **Tool** | 白名单翻转：授权集 = `allocation.tools 命中插件全名/组模式 ∪ deltas.addedPluginTools`（字段语义从「禁用覆盖」升级为「成员授权」）；生效集 = 授权集 − `(def.deniedTools ∪ deltas.removedPluginTools)`（黑名单优先的保守语义不变）。落点：`buildPluginToolRefs(ws)` 产物按生效集过滤 `modulePaths`（全滤空的 ref 丢弃） | **零**（「可见性 = 装配面」既有设计） |

- def 级正向声明插件工具的通道**不做**（YAGNI——插件作者用 MCP；`ToolRef.kind` 扩展留待真实需求）
- allocation.tools 对插件工具的匹配语义与 deniedTools 同款：`plugin:<id>/*` 组模式 + `plugin:<id>/<name>` 精确名

## 7. 启停即时生效与运行时重建

`plugin:setEnabled` 升级（双向）：

1. **重建**：把 `rebuildAffectedRuntimes` 参数化为单 ws 版本，`setEnabled(ws, …)` 触发该 ws `lastRunning` 成员 stop→start（reload 保留全 ws 行为不变）。停用与启用两个方向都重建——启用后跑动 agent 才能拿到新能力
2. **MCP 池失效**（仅停用方向）：顺序 stop 成员 → 该插件全部 server 名 `invalidateMcpByName`（镜像卸载级联）→ start 成员（新装配 `mcpNames` 已滤）。防池实例残留与按需复活
3. **§3.3 冻结语义收窄**（显式语义变更）：「跑动会话不受后续变更影响」此后只适用于**配置变更**（`setConfig` 不重建，现状保留）；**启停**升级为立即生效
4. 既有级联保留：hooks 摘挂 / service 联动 / 面板通知

**存量会话处理**：会话历史零影响（sessions / message_events 是 DB 单一真相源）；正在执行的回合按 stop 既有语义中断（与 reload 重建同款，非新语义）；agent 秒级闪断后带新装配回来；下一任务/回合无插件能力。

## 8. 卸载级联补充

既有：MCP 定义删除 + `removeMcpRefsFromAgents` + allocation 行清除 + agents/hooks/service 级联。
补充：`addedPluginTools` / `addedSkills` 中指向该插件的授权行一并清理（防同 id 重装冒用继承——与 codegraph 整合终审 I2「敏感键随数据删」同判）。

## 9. UI 面

**① 资源库插件列表（需求 2）**
- 行内 启用/停用 开关（走既有 `plugin:setEnabled`，传活动 ws）+ 状态徽标（当前 ws 视角：已启用 / 已停用 / missing）
- `resource.list({type:'plugin'})` 返回扩 `enabledInWorkspace: boolean`（主进程按活动 ws 算）

**② 插件明细组件清单（需求 3）**
- 新 IPC `plugin:getDetail(pluginId, workspaceId?)`：`mcps[{name,description}]` / `tools[{fullName,description}]` / `skills[{slug,title}]` / `agents[{id,name}]` / `panels[{panelId,title}]` / `service:bool` / `config:bool`
- 数据源：mcp.json、manifest、`listAssembledTools` 过滤该插件、`listAllPluginSkills`、`agent_definitions source='plugin'`
- 资源库插件条目展开明细（形态与 ResourceLibraryView 既有详情对齐，实施时核对现状）
- 清单只读，不做「谁在用」反查（YAGNI）

**③ 成员/定义编辑器 opt-in 翻转（需求 4）**
- MemberEditDialog 的 MCP/skill 页签**预期零改动**：勾选态 = 三层合并终态；新装插件无 allocation 行自然不勾，存量因 066 物化继续勾。实施时验证候选列表已含插件条目（D2 后已含）
- `PluginToolsSection` 薄化为受控组件：`checkedFullNames: string[]` + `onChange(next: string[])`。MemberEditDialog 侧换算授权集；DefinitionEditor 侧保持 denied 换算（定义级「禁哪些」语义保留，黑名单继续优先）
- `capability-helpers.ts` 纯函数翻转：`computePluginToolDeltas` / `effectivePluginDenied` → 授权模型（成员勾选 = `addedPluginTools` 授权行）

**预览门禁**（momo-ui-preview-rules）：列表开关+徽标、明细清单属 P1 新布局——静态预览确认后实现；编辑器翻转按 P2 三条件判定。

## 10. 消费面矩阵

| 消费面 | 新装插件 | 存量（codegraph） | builtin agent（Momo） |
|---|---|---|---|
| 安装（zip/dev/marketplace） | 写 enablement(安装ws=1)，allocation 零写入 | 066 回填全启用 + skill 物化 | — |
| 列表开关+徽标 | ✓ | ✓（显示已启用） | — |
| 明细清单 | ✓ | ✓ | — |
| 成员勾选（MCP/skill/tools） | 默认全不勾，勾上=授权 | 保持现状（物化），可取消 | 只读 def 经成员勾选管理 ✓ |
| 工作空间配置（MCP/skill 页） | 显式批量授权通道 | 现有行保留 | — |
| 面板/service/hooks | 行缺失=停用 | 迁移回填保现状 | — |
| 新建工作空间 | 所有插件默认停用 | — | — |
| 停用/启用 | 双向重建 + 停用清 MCP 池 | 同一代码路径 | — |
| 卸载 | 既有级联 + 插件授权行清理 | 同 | — |

## 11. 测试与验收

**electron 单测**：迁移 066（含幂等）；`isPluginEnabled` 翻转；安装链带 wsId（null 报错 / 只写一行 / 零 allocation）；`backfillPluginMcpsForWorkspace` 摘除；skill `∩ merged.skills`；tool 白名单过滤（含组模式 / 黑名单优先 / modulePaths 全滤丢弃）；`setEnabled` 双向重建 + 停用清池；卸载清授权行；三处 stillEnabled 查询翻转。

**renderer 单测**：PluginToolsSection 新受控 props；列表徽标与开关渲染；明细清单渲染；capability-helpers 翻转后纯函数。

**回归**：tests/plugin + tests/agent（spawn-helpers / capability-merger 既有用例）+ tests/resource 全量。

**验收锚点**（含存量路径，feature-scope 铁律 5）：
1. 存量：dape ws 停用 codegraph → 在线 agent 重建后新会话无其工具 → 重启用恢复
2. 存量：Momo 成员勾选 codegraph MCP → 会话中真机调用 `codegraph_explore` 成功
3. 新装：zip 装于 ws X → X 已启用、ws Y 徽标「已停用」→ Y 手动启用 → agent 勾选授权生效
4. 存量 skill：066 后 codegraph-usage 对现有 agent 仍可见，取消勾选即消失
5. 新建 ws：全部插件默认停用徽标

## 12. 风险与已知边界

- **tools 存量边界**：升级前若有 dev 源带 tools 组件插件（当前无），其工具收敛为默认关需重新勾选——记录不迁移（工具全名需扫盘，迁移不可靠）
- **toggle 闪断**：该 ws 在线 agent stop→start 秒级重启，桌面单机规模可接受
- **slug 平铺命名空间**：插件 skill 与用户 skill 同名冲突维持现状行为（SkillRegistry 注册期处理），本设计不扩
- **迁移 down 不可完全逆**：enablements 回填行与用户手写行不可区分，down 按保守子集删除并注释
- **066 依赖文件系统读 skill 目录**：迁移期插件目录缺失（missing 态）时该插件无物化行——目录恢复后 reload 可补（可接受）

## 13. 关联文档

- `docs/specs/2026-10-20-codegraph-engine-integration-design.md` —— D2 装即全空间注入裁定（本设计退役该语义，MCP 池/模板展开/boot 链不受影响）
- `docs/specs/2026-08-31-agent-team-session-redesign.md` —— 三层能力合并与成员制
- `.opencode/skills/momo-feature-scope-rules/SKILL.md` —— 消费面矩阵铁律
