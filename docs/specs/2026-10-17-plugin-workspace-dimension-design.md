# Momo Studio 插件平台「工作空间维度」补全设计

- 日期：2026-10-17
- 状态：设计已批准（用户 2026-10-17 逐节确认六节设计），待实现
- 类型：架构增强（plugin 子系统 v1.1——对 `docs/specs/2026-10-15-plugin-system-design.md` 的维度补全，非破坏性修订）
- 上游输入：真实 LLM 验收轮（`.omo/qa-reports/2026-10-16-plugin-llm-acceptance/`，gitignored）后用户真机四问题反馈
- 版本：特性合入只动 alpha 号（按 `docs/dev/release.md` 研发期策略）

## 1. 背景与问题

插件系统 P1-P5 收官后用户真机使用反馈四问题，勘察判定（代码 + 真实库证据）：

| # | 用户观察 | 判定 | 证据 |
|---|---|---|---|
| 1 | 插件配置不按工作空间隔离 | 属实，v1 设计如此（config 是插件级全局属性） | `writePluginConfig(pluginId, schema, values)` 无 workspace 维度；存储 `<userData>/plugins/data/<id>/config.json` 全局一份 |
| 2 | 代码图谱 UI 混在侧边栏功能界面里，非独立页面 | 属实，P4 设计即 sidebar 视图（UX 争议） | `ViewSidebar.tsx` + `ActivityBar.tsx` 经 plugin-panels.store 挂 iframe |
| 3 | 插件工具在 agent 配置不显示、默认全局都有、无法按 agent 关闭 | 属实：装配为 workspace 级全员注入；`deniedTools` 机制在运行时存在（`assertToolAllowed` 路由前强制，天然覆盖 `plugin:*`）但无存储无 UI | `buildPluginToolRefs(workspaceId)`；renderer 全域无 deniedTools 写入面 |
| 4 | dape 工作空间搜不到自己的代码，索引是别人的 | 根因 = #1 直接后果：全局唯一 `workspaceRoot` 指向 moo-studio 仓库，dape 目录是 `dap-e_server`；service 按 pluginId 单例 | `~/.momo-studio/plugins/data/codegraph/config.json` + `service-manager.ts` running Map + 会话「代码图谱可用但索引挂错」 |

有利事实：`workspaces.directory_path` 列存在——「配置留空默认跟随工作区目录」天然可行；`assertToolAllowed` 在 `doExecuteTool` 路由前执行——工具门控的运行时强制零改动。

## 2. 意图裁定（用户逐项确认）

| 裁定项 | 结论 |
|---|---|
| config 作用域模型 | **方案 B：manifest 声明式作用域**——config 属性级 `scope: 'workspace' \| 'global'`（默认 global，存量插件零影响）；存储分轨、service 按工作区多实例 |
| 插件 UI 放置 | **方案 D：manifest 声明可选手**——`placement: 'sidebar' \| 'page'`；page = 主区独立视图（与会话/看板同级）；codegraph 改声明 page |
| 工具门控粒度 | **方案 G：两层门控**——workspace 总开关（已有，资源库插件卡片禁用）+ agent 配置「插件工具」分组开关（写 `denied_tools`，运行时机制现成） |
| 默认值策略 | 并入 B：codegraph `workspaceRoot` 留空 = 默认 `workspace.directoryPath`——新工作区零配置即正确索引（dape 案根治） |

## 3. 非目标

- sensitive + workspace 组合（v1 schema 校验拒绝；codegraph 类插件无敏感项，YAGNI）
- MCP / skills 的插件贡献进 agent 级门控（用户只诉求工具；workspace 级禁用已覆盖，`filterDisabledPluginMcps` 现状保留）
- 设置页 per-workspace 配置切换 tab（表单随当前活动工作区读写即可）
- 面板多标签 / 多窗口（page 形态 = 每插件一个主区视图入口，点击活动栏切换）
- 存量全局 `workspaceRoot` 值迁移搬运（废弃 + 首启提示，见 §8）

## 4. config 声明式作用域

### 4.1 manifest 变更

config 属性声明新增可选字段 `scope`：

```json
{
  "workspaceRoot": { "type": "string", "title": "索引根目录", "scope": "workspace" },
  "indexCommand": { "type": "string", "title": "自定义索引命令" },
  "maxFiles": { "type": "number", "title": "最大索引文件数" }
}
```

- 校验规则（`normalizeConfigSchema` 扩展）：`scope` ∈ `{workspace, global}`，缺省 `global`；`sensitive: true` + `scope: 'workspace'` 组合**拒绝**（v1 非目标）。
- 存量 manifest 无 `scope` 字段 → 全 global → 行为与现状逐字节一致。

### 4.2 存储模型

```
<userData>/plugins/data/<pluginId>/
├── config.json                      # global 层（现状不动）
├── config.<workspaceId>.json        # workspace 层（新增，同目录分文件）
```

- 双轨原则不变：非敏感走文件（tmp + rename 原子写），敏感走 keytar（仅 global）。
- 卸载清理语义不变：整 `data/<id>/` 目录按 keepData 决定去留，workspace 层文件随之消失。
- workspace 删除：其 config 文件成为孤儿——随工作区删除动作顺带清理（`DELETE /workspaces/:id` 主进程链路调用 `deleteWorkspacePluginConfig(workspaceId)`）；孤儿文件不参与任何读取（按 workspaceId 寻址天然跳过）。

### 4.3 API 变更（`config-store.ts`）

```typescript
writePluginConfig(pluginId, schema, values, workspaceId?)   // workspace-scope 键落对应工作区文件
getPluginConfigView(pluginId, schema, workspaceId?)          // 表单视图：global 值 + 当前工作区值拼合
resolvePluginConfig(pluginId, schema, workspaceId?)          // 全量合并（global 层 + workspace 层 + 敏感缓存）
readPluginConfigJson(pluginId, workspaceId?)                 // 单文件读（内部分流）
```

- required 校验按「各自作用域合并终态」：workspace-scope 键的存在性查工作区文件，global 键查 config.json + keytar。
- `pluginCtx.getConfig()` / service ctx：返回 `{ ...global层, ...当前workspace层, ...敏感缓存 }`（一键一 scope，无同名覆盖问题，纯拼合）。

### 4.4 ctx 注入与默认跟随

- `PluginServiceCtx` 与插件工具 ctx 新增 `workspace: { id: string; directoryPath: string }`（装配/启动时定型注入）。
- codegraph service 取根：`root = cfg.workspaceRoot ?? ctx.workspace.directoryPath`（**留空即跟随**，平台只提供事实，默认语义由插件自定）。
- codegraph manifest：`workspaceRoot` 改声明 `scope: 'workspace'` 且**从 required 移除**（留空合法 = 用默认）。

## 5. service 多实例生命周期

### 5.1 实例键

`service-manager.ts` 的 `running` Map key 改为：

- 纯 global-config 插件（schema 无 workspace-scope 属性）：`pluginId`（现状不变，单例）
- 含 workspace-scope 属性的插件（如 codegraph）：`pluginId@workspaceId`（每工作区一实例，各自索引各自 root）

### 5.2 启停时机

| 事件 | 行为 |
|---|---|
| 工具/面板调用 `callPluginService` | 无实例时 **lazy start**（读该工作区 config；start 失败照旧 warn 返回错误） |
| 工作区切换（活动工作区变更） | 停非当前工作区的多实例（后台 agent 跨工作区调用由 lazy 兜底重启） |
| 禁用 / 卸载 / 重载插件 | 该插件**全部实例**（所有 key 前缀匹配）齐停——§8.6 禁用即消失语义对多实例不变 |
| boot 再激活 | 仅当前活动工作区实例预启动，其余 lazy |
| app 退出 | 全部齐停（`stopAllPluginServices` 现状扩展） |

### 5.3 设置页表单

- workspace-scope 字段显示「按工作空间」标签（badge），值随**当前活动工作区**读写；
- 表单顶部说明文案：「按工作空间的配置项独立保存于每个工作空间；当前显示/保存的是活动工作空间的值」。

## 6. 面板放置 placement

### 6.1 声明位（实施修订）

**修订（2026-10-17 实施期）**：placement 声明位为 panel.json 每面板 `location` 字段（既有字段扩枚举 `sidebar | page`），而非下述 manifest components.panel 对象形态——字段已存在，仅扩白名单，改动面最小。以下原文保留作设计演进记录：

`components.panel` 接受两种形态：

```json
"panel": "panel/"                      // string = sidebar（现状，存量零影响）
"panel": { "path": "panel/", "placement": "page" }   // 对象形态显式声明
```

- 校验：`placement` ∈ `{sidebar, page}`，缺省 `sidebar`；对象形态缺 `path` 拒绝。

### 6.2 renderer 变更

- `plugin-panels.store` 的 panel 描述增 `placement` 字段（IPC 派发面同步）。
- ActivityBar 点击分流：`sidebar` → 现状 ViewSidebar 视图链路；`page` → **主区独立视图**（App shell 视图切换层新增 plugin page view，key 复用 `panelKeyOf`）。
- page 视图 = 全宽主区 iframe（`momo-plugin://<id>/panel/index.html` + postMessage 桥全复用）；v1 每插件一个入口，活动栏按钮即切换器。
- §8.6 禁用即消失对两形态同样生效：按钮消失 + 视图卸载 + service 齐停。
- codegraph manifest 改 `{ "path": "panel/", "placement": "page" }`。

## 7. 工具门控

### 7.1 存储

- `agent_definitions` 新列：`denied_tools TEXT NOT NULL DEFAULT '[]'`（JSON 模式串数组，一条 ALTER TABLE 迁移）。
- 模式串语法复用 `tools/shared/permission.ts` 现有 `matchToolPattern`（支持 `plugin:<id>/*` 整插件前缀与精确名）。

### 7.2 装配与强制（运行时近零改动）

- spawn 链路：读 `denied_tools` 列 → 注入 runtime config `deniedTools`（`runtime-config.ts` 字段与 parse 现成）。
- 强制点：`doExecuteTool` → `assertToolAllowed(name, config)` 在路由前执行，`plugin:*` 工具调用天然被过滤——被拒调用走 executeTool 审计包装记失败回传 LLM（M3 语义不变）。

### 7.3 UI（DefinitionEditor）

- 工具配置区新增「插件工具」分组（位于 builtin 工具与 MCP 之间）：
  - 组头：整插件开关 → 写 `plugin:<id>/*` 模式串；
  - 组内：单工具开关 → 写精确名（`plugin:codegraph/explore`）；
  - 默认全开（denied_tools 为空数组）。
- 清单来源：新 IPC `plugin:listAssembledTools(workspaceId)` 返回当前工作区装配的插件工具 view（id / name / description，`buildPluginToolRefs` 派生）。
- IPC 契约变更同步 `renderer/src/ipc/types.d.ts` + `electron/src/preload`（两 workspace typecheck 铁律）。

## 8. 迁移与存量处置

1. **旧全局 `workspaceRoot` 值**：废弃不搬（搬进任何单一工作区都是错的）。升级后首启一次性提示（设置页 banner，非模态）：「索引根目录已改为按工作空间配置，留空时默认使用工作空间目录」。
2. **schema 迁移**：`agent_definitions` ALTER 一条；插件 config 无表结构变更（文件即存）。
3. **dape 验证路径**：升级后 codegraph 零配置 → dape 会话 explore 返回 `dap-e_server` 符号（验收锚点 A1/A2）。

## 9. 测试与验收锚点

### 9.1 单测

- config-store：双轨读写（global/workspace 分文件）、跨作用域 required 校验、sensitive+workspace 拒绝、孤儿 workspaceId 寻址跳过
- service-manager：多实例 key 生成、lazy start、工作区切换停非当前、禁用齐停全部 key 前缀
- runtime：deniedTools 过滤含 `plugin:` 前缀（permission.ts 既有用例扩展）
- DefinitionEditor：插件工具分组渲染与开关写值
- manifest 解析：`components.panel` string/对象双形态兼容、placement 校验
- codegraph 插件：workspaceRoot 留空默认跟随（ctx 注入 directoryPath）

### 9.2 验收锚点（真机，CDP 驱动）

| # | 锚点 | 通过判据 |
|---|---|---|
| A1 | 双工作区索引互不串（dape 回归锁） | test 与 dape 两工作区各自会话 explore，返回符号分别属于各自 `directory_path` |
| A2 | 留空默认跟随 | codegraph 配置全空，dape 会话查询返回 dap-e_server 符号；面板统计非零 |
| A3 | page 面板独立视图 | codegraph 面板在主区渲染（非侧边栏）；禁用后活动栏按钮与视图齐消失，复启复活 |
| A4 | agent 工具门控 | 某 agent 关闭 codegraph 整插件后，该 agent 会话中 LLM 调用 `plugin:codegraph/*` 被拒（审计可见失败记录）；其他 agent 不受影响 |

## 10. 安全考量（延续 v1「装了即信」模型）

- workspace 层文件与 global 层同目录同权限，无新攻击面；
- `denied_tools` 是能力收缩面（只会少不会多），无提权风险；
- lazy start 失败 warn 不落注册表（§5.3「不半活」语义多实例下不变）。

## 11. 实施规模预估

| 任务组 | 范围 | 主要文件 |
|---|---|---|
| ① 主进程存储+生命周期 | §4 §5 §8 | `config-store.ts` / `service-manager.ts` / `ipc.handlers.ts` / `assembly.ts` / `boot.ts` / 迁移 |
| ② renderer 两处 UI | §6 §7.3 | `plugin-panels.store.ts` / `ActivityBar.tsx` / App shell 视图层 / `DefinitionEditor.tsx` / `types.d.ts` |
| ③ codegraph 插件+迁移+测试 | §4.4 §6.1 §8 §9 | `plugins/codegraph/**`（manifest + service 默认跟随）/ 各测试 |

单 spec 单计划，三任务组并行度：① → ②（IPC 契约依赖），③ 与 ①② 部分并行。
