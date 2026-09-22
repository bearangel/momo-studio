# 资源库 UI 重设计：三类独立资源页与类型原生添加流程

| | |
|---|---|
| 日期 | 2026-09-22 |
| 状态 | 设计已评审通过（视觉伴侣三屏决策 + 终端分节确认），待实施 |
| 范围 | **UI 先行，预留网络接口**——本轮不含真实第三方注册表接入 |
| 上游调研 | VS Code / Raycast / Cursor / Windsurf / Smithery / skills.sh / mcpservers.org / Obsidian（模式调研）+ Cherry Studio / Cline / claude.ai / LobeChat / Dify / Coze（创建流程调研）|
| 视觉决策 | 见 §1.3 决策记录（视觉伴侣会话 `.superpowers/brainstorm/3865416-*/`，gitignored） |

---

## 1. 背景与目标

### 1.1 现状问题

现有 `ResourceLibraryView` 是单页混合视图：双行 tab（类型 × 来源）+ 卡片网格 + 右侧详情 + 「添加资源」统一下拉挂三个异构弹窗。问题：

- 三类资源（agent / mcp / skill）形态完全不同（人格 / 配置 / 内容），混排导致筛选维度爆炸（双行 tab）、添加入口语义模糊；
- 「网络资源」源只是本地打包的 marketplace catalog（`resources/marketplace/catalog.json`），但 UI 没有为「浏览注册表」这一场景留出空间；
- 每类资源的新增方式被迫共用一套抽象入口，与业界实践（Cherry Studio / Cline 等全部按类型定制）相悖。

### 1.2 目标

1. Agent / MCP / Skill 拆为三个独立子页面（二级侧边菜单），各自拥有独立列表、筛选、添加流程、详情；
2. 每类的「＋」下拉提供**类型原生**的新增路径：表单创建 / 文件（JSON/YAML/zip）导入 / 网络获取；
3. 「网络获取」做成页面级浏览模式，数据源经 **RegistryProvider** 可插拔：本轮接本地 marketplace catalog，未来接 mcphub / skillhub 只增实现、不动 UI；
4. 列表改紧凑行，详情面板升级三段式（状态 / 配置预览 / 元数据）。

### 1.3 决策记录（视觉伴侣三屏）

| # | 决策点 | 结论 | 备选否决理由 |
|---|---|---|---|
| ① | 导航骨架 | **C 变体**：资源库单入口 + 内部二级侧边菜单（Agent / MCP / Skill），**无总览页** | A 顶部 tab（活动栏不膨胀但用户偏好纵向菜单扩展性）；B 活动栏三顶级入口（拥挤、丢整体感） |
| ② | 添加流程 | **类型原生下拉**（每类 3 条命名路径，含一句说明）+ 页面级网络浏览模式 + Agent 分步向导 | 统一抽象壳（M1/M2/M3 初版）被否——对照 Cherry Studio 实测，主流应用全部按类型定制 |
| ③ | 列表形态 | **紧凑行** + 右侧三段式详情 | 卡片网格（现状）密度低、状态信息难承载 |

### 1.4 关键后端事实（约束设计的现状）

| 事实 | 出处 | 设计影响 |
|---|---|---|
| MCP 传输**仅 stdio**（`registerMcpDefinition` 硬编码） | `electron/src/main/mcp/host-manager.ts:175` | MCP 表单**不放传输类型选择**；JSON 粘贴只接受 stdio 字段 |
| `mcp_definitions` 表无 `enabled` 列、无连接状态 IPC | `host-manager.ts` | 启停 toggle、连接状态点 = **P2 后端能力**，本轮不做（§11） |
| `resource:registerMcp` 已存在（`RegisterMcpInput`，id/version 主进程补全，name 冲突 INSERT OR REPLACE） | `renderer/src/ipc/types.d.ts:633` | JSON 批量导入 = renderer 循环现有通道；**覆盖前 UI 必须显式确认** |
| `resource:uploadSkill` 返回 `UploadedSkill[]`，zip 落盘后经 `SkillRegistry.register(cachePath)` | `skill/registry.ts:22` | `resource:createSkill` 复用同一条落盘链路（写 SKILL.md → register） |
| marketplace catalog 为本地打包 JSON | `resources/marketplace/catalog.json` | RegistryProvider v1 实现直接消费现有 `resource:list` |
| `agent.createFromYaml(yaml)` 通道**已存在**（manifest 解析 + 校验 + 落库一体） | `renderer/src/ipc/types.d.ts:1268` | Agent YAML 导入**零新 IPC**，直接复用 |
| `agent:createCustom` 入参**已含** `defaultMcps` / `defaultSkills`（v1.6 起，主进程 `CreateCustomDefInput` 同构） | `types.d.ts:1284-1286`、`crud.ts:58-76` | 向导第 3 步能力绑定**零 IPC 扩展**，renderer 直接传字段 |

---

## 2. 总体结构

### 2.1 组件树

```
MiddlePanel
└── ResourceLibraryView（壳，保留文件名与挂载点）
    ├── TypeSidebar                    // 二级侧边菜单：Agent / MCP / Skill
    └── TypePageShell type={activeType}
        ├── 工具栏
        │   ├── 搜索框（Input 原子件）
        │   ├── 来源筛选 chips（预置/自定义/网络/P2P → sourceFilter）
        │   ├── AddMenu type={}        // 类型专属「＋」下拉（§4）
        │   └── Segmented：已安装 | 网络获取（mode）
        ├── 模式 = installed
        │   └── 行列表（ResourceRow × N，紧凑行）
        ├── 模式 = registry
        │   └── RegistryBrowse type={} // 共享浏览组件（§4.4）
        └── ResourceDetail（三段式详情，选中行时挂载）
```

- `TypeSidebar`：纵向菜单，lucide `Bot` / `Puzzle` / `Package`（沿用现 `ResourceCard.TYPE_ICON` 映射），选中态 `bg-surface-active` + `text-accent-600 dark:text-accent-300`；无「总览」项；上次选择持久化 `localStorage['momo.resourceLibrary.activeType']`，缺省 `agent`。
- `TYPE_TABS` / `SOURCE_TABS` 双行 tab、`AddResourceMenu`、卡片网格全部移除；`ResourceCard` 被 `ResourceRow` 取代（测试迁移见 §10）。

### 2.2 页面模式与数据源

| 模式 | 数据源 | 说明 |
|---|---|---|
| 已安装 | `resource:list`（现 IPC，type=当前页，source 由 chip 筛选） | builtin + custom + marketplace 已装 + p2p 全量已安装项 |
| 网络获取 | `RegistryProvider.list(type)`（§3） | v1 = marketplace catalog 未安装项优先；每行「安装」按钮走现有 `installResource` 链路（marketplace agent 安装后弹配置引导的现有行为保留） |

`resource.store` 演进：`typeFilter` 由当前页类型固定驱动（`setTypeFilter` 仍存在但由页面切换调用）；新增 `mode: 'installed' | 'registry'` 与 `setMode`。store 仍是唯一列表状态源，页面组件不自行拉数据。

---

## 3. RegistryProvider（网络获取数据层）

新目录 `renderer/src/services/registry/`：

```ts
/** 注册表条目——网络获取模式的统一形状（v1 由 ResourceItem.marketplace 映射） */
export interface RegistryEntry {
  /** 对应 marketplace item 的 resource id（安装时透传，禁止重新生成） */
  id: string;
  type: ResourceType;
  name: string;
  description: string;
  version?: string;
  tags: string[];
  category?: string;
  /** 供详情预览；安装仍走 resource:item 的完整数据 */
  item: ResourceItem;
}

export interface RegistryProvider {
  readonly key: string;            // 'marketplace' | 未来 'mcphub' | 'skillhub'
  readonly label: string;          // 展示名，如「内置市场」
  list(type: ResourceType, query?: string): Promise<RegistryEntry[]>;
}
```

- **v1 唯一实现** `MarketplaceCatalogProvider`：内部调 `ipc.resource.list({ type, source: 'marketplace' })`，前端模糊过滤（复用现 name/description/slug 匹配语义）。已安装项排在末尾并标「已安装」徽章。
- 未来接入 mcphub / skillhub：新增 Provider 实现 + 注册表选择 UI（Provider 列表入口已在本组件接口预留），**不改任何页面组件**。
- Provider 的失败语义：`list` 抛错由 `RegistryBrowse` 渲染错误态 + 重试按钮（§9）。

---

## 4. 类型专属页与添加流程

三个页面的公共骨架：工具栏「＋」下拉（Cherry Studio MCP 模式——命名路径 + 一句副文案），下拉**最后一项固定「从网络获取…」**（点击 = 切到 registry 模式，与 Segmented 等价入口）。

### 4.1 Agent 页（人格驱动）

**行规格**：图标（iconEmoji 数据照渲染，缺省 `Bot`）+ 名称 + 一行描述 + 来源徽章 + 状态槽（builtin：未启用→「启用」/已启用→绿色「已启用」；custom：「编辑」入口；marketplace 已装：「配置」入口）——状态逻辑从现 `ResourceCard` 平移，不新增语义。

**「＋ 新建 / 导入」下拉**：

| 菜单项 | 副文案 | 实现 |
|---|---|---|
| 新建智能体… | 分步向导：基础信息 → 提示词 → 能力 → 模型 | `AgentCreateWizard`（新，见下） |
| 导入 YAML 文件… | manifest 格式（apiVersion/kind/metadata/spec），校验后注册为自定义 agent | `ImportAgentYamlDialog`（新）+ 现有 `agent.createFromYaml` 通道（零新 IPC） |
| 从网络获取… | 浏览注册表（内置市场） | 切 registry 模式 |

**AgentCreateWizard（4 步，Dialog 内左侧步进条）**：

1. **基础信息**：名称（必填）、描述、iconEmoji（现有字段平移，默认 🤖，用户数据照渲染豁免）；
2. **System Prompt**：大文本域（必填）；
3. **能力绑定**：默认工具集三档（安全最小集 / 全部 / 自选——平移现 `CreateAgentDialog` 的 PRESETS 与自选网格）+ **MCP 多选 + Skill 多选**（可选；数据来自 `resource:list` 对应 type；映射 def 的 mcps / skills 引用）；
4. **模型与完成**：`ProviderModelPicker` + `ThinkingOverrideControl`（与现 `CreateAgentDialog` 同组件），提交 `ipc.agent.createCustom`（入参扩展见 §5.1）。

向导字段集 = 现 `CreateAgentDialog` 字段的超集分步呈现（新增仅 mcps/skills 多选与描述字段）。**`CreateAgentDialog` 保留不动**——MembersPanel 两个调用点继续使用；资源库内替换为向导。两组件收敛标记为后续迭代（§11 非目标）。

### 4.2 MCP 页（配置驱动）

**行规格**：图标（`Puzzle` 兜底）+ 名称 + 一行描述 + 来源徽章 + 状态槽（marketplace source 不可删提示、custom 显示删除入口）。

**「＋ 添加服务器」下拉**：

| 菜单项 | 副文案 | 实现 |
|---|---|---|
| 手动配置… | 名称 / 命令 / 参数 / 环境变量（高级项默认折叠） | `RegisterMcpDialog` 原位演进：字段不变（`RegisterMcpInput`：name/command/args/env），环境变量折叠进「高级」区；**不新增传输类型选择**（后端 stdio-only） |
| 粘贴 JSON… | mcpServers 格式，支持一次导入多条 | `McpJsonPasteDialog`（新，见下） |
| 从网络获取… | 浏览注册表（内置市场） | 切 registry 模式 |

**McpJsonPasteDialog 规格**：

- 接受两种输入：标准 `{ "mcpServers": { <name>: { command, args?, env? } } }` 包裹结构，或裸 `{ <name>: { command, ... } }` 对象；每项字段校验（command 必填、args 数组、env 字符串表）；
- 解析后先展示**待导入清单**（name + command 摘要）；与 `resource:list`（type=mcp）比对出同名项 → 显式确认「将覆盖 N 个同名服务器」（后端 INSERT OR REPLACE 语义，UI 必须显式）；
- 执行：renderer 循环 `ipc.resource.registerMcp`（顺序执行，逐条收集错误）；结果摘要：成功 N 条 + 失败清单（name + 原因）；部分成功不清空已成功项。

### 4.3 Skill 页（内容驱动）

**行规格**：图标（`Package` 兜底）+ 名称 + 一行描述 + 来源徽章（预置 / zip 导入 / 自建 / 网络 / P2P）。

**「＋ 添加技能」下拉**：

| 菜单项 | 副文案 | 实现 |
|---|---|---|
| 导入 zip 包… | 拖放或选择文件 | `UploadSkillDialog` 原样复用 |
| 新建 SKILL.md… | frontmatter（name/description）+ Markdown 正文 | `SkillCreateDialog`（新）+ `resource:createSkill`（§5） |
| 从网络获取… | 浏览注册表（内置市场） | 切 registry 模式 |

**SkillCreateDialog 规格**：name（必填，slug 化）、description（必填）、正文 textarea（必填）+ 生成内容预览（frontmatter + body 拼接）；提交后成功消息对齐 `UploadSkillDialog` 模式（保留展示、手动关闭、先刷新后提示）。

### 4.4 网络获取模式（RegistryBrowse，共享组件）

- 入参 `type: ResourceType`；工具栏：搜索框（前端模糊过滤）+ 分类 chips（v1 = marketplace tags 去重 Top-N）；
- 行式列表：图标 + 名称 + 描述 + 标签徽章 + 状态槽（未安装→「安装」；已安装→绿色「已安装」）；
- 点行挂载 `ResourceDetail`（marketplace 元数据段）；
- 安装链路复用 `installResource`：**marketplace agent 安装成功后弹 `EnablePresetDialog` 配置引导的现有行为原样保留**；
- Provider 来源标注：列表顶部轻量说明「来源：内置市场」（未来多 Provider 时变为选择器）。

---

## 5. IPC 与主进程改动

> 遵循 momo-boundary-rules：新通道两端（`renderer/src/ipc/types.d.ts` 与 electron 侧类型）**同一 commit 对齐**；ID 单点生成沿线透传（安装沿用 resource.id，不重新生成）；跨 workspace 改动双 typecheck。

### 5.1 新增通道（仅 1 个）

**`resource:importAgentYaml` 已取消**——调研核实 `agent.createFromYaml(yaml)` 通道已存在（manifest 解析 + 校验 + 落库），YAML 导入直接复用；向导能力绑定同理复用 `agent.createCustom` 现成的 `defaultMcps` / `defaultSkills` 字段。本节仅新增：

**`resource:createSkill`**

```ts
createSkill(input: SkillCreateInput): Promise<UploadedSkill>;
interface SkillCreateInput {
  name: string;         // 必填，slug 化在主进程做（与 zip 导入同口径）
  description: string;  // 必填
  body: string;         // 必填，Markdown 正文
}
// 返回复用 UploadedSkill（slug/name/description）——与 zip 上传同形状
```

- 主进程：生成 `SKILL.md`（frontmatter + body，frontmatter 值经 JSON 风格引号转义防 YAML 注入）→ 写入 `<skillsDir>/<slug>/` + `.sha256` 标记文件（与 zip 上传同布局，`listInstalled` 自动识别为 custom 源）→ 广播资源目录；slug 冲突 = 覆盖（与 zip 重复上传同语义，UI 提交前用 `resource:list` 比对提示）。

### 5.2 复用通道（零改动）

| 通道 | 用途 |
|---|---|
| `resource:list` | 已安装模式 + MarketplaceCatalogProvider |
| `resource:install` / `resource:delete` | 安装 / 删除（含 p2p 导入语义） |
| `resource:registerMcp` | MCP 手动表单 + JSON 批量循环 |
| `resource:uploadSkill` | Skill zip 导入 |
| `agent.createFromYaml` | Agent YAML 导入（解析 + 校验 + 落库一体，校验错误含字段名） |
| `agent.createCustom` | 向导提交（入参现成含 `defaultMcps` / `defaultSkills` 能力绑定） |
| `agent.list` / agent 编辑 / 启用 / 配置链路 | DefinitionEditor、EnablePresetDialog 等既有消费点 |

### 5.3 明确不动

不新增：MCP 启停通道、连接状态探活通道、远程注册表拉取通道、sse/http 传输支持（全部 §11 P2 / 非目标）。

---

## 6. 行组件与详情面板

### 6.1 ResourceRow（紧凑行，共享 + 类型槽）

结构：`状态点(P2预留位) + 图标 + 名称 + 一行描述(截断) + 徽章区(来源/类型专属) + 尾部操作槽`。

- 徽章：`Badge tone` 原子件，来源徽章沿用 `SourceBadge` 语义；
- 尾部操作槽按类型注入：Agent → 启用/已启用/编辑/配置；MCP → 删除（custom）/不可删提示（marketplace）；Skill → 删除；registry 模式 → 安装/已安装；
- 选中态 `border-accent-500`（对齐现卡片选中语义）；点击行 = 挂载详情；操作按钮 `stopPropagation`（沿用现卡片防线）。

### 6.2 ResourceDetail（三段式演进）

| 段 | 内容（按类型×来源条件渲染） |
|---|---|
| ① 状态 | 来源徽章 + 类型专属状态（Agent 启用态；MCP 来源+transport 标注「stdio」；Skill frontmatter 摘要） |
| ② 配置预览 | custom MCP → command / args / env（KEY=*** 掩码，沿用现实现）；custom Agent → def YAML 预览（只读等宽块）；custom Skill → frontmatter；builtin/marketplace → README 折叠（沿用） |
| ③ 元数据 | 版本 / 作者（marketplace）/ 校验状态 / 安装时间 / p2p 节点（沿用现字段） |
| 底部操作条 | 现有条件按钮逻辑平移（安装/导入/编辑/启用/配置/删除），文案与可用性不变 |

宽度与挂载方式沿用现状（右栏条件渲染、删除后选中失效自动收起）。

---

## 7. 错误处理与空态

| 场景 | 行为 |
|---|---|
| 页面空态（每类） | `EmptyState` + 引导文案指向「＋」下拉（Agent：「还没有智能体，点右上角新建或导入」等三条路径提示） |
| registry 空态 | 「目录中没有匹配项」+ 清除搜索建议 |
| registry 加载失败 / Provider 抛错 | 错误态 + 重试按钮（v1 本地 catalog 失败面小，接口形态为网络源预留） |
| YAML 导入失败 | 弹窗内联红字（含字段名），不关弹窗（对齐 UploadSkillDialog 模式） |
| JSON 粘贴解析失败 | 内联错误（非 JSON / 非 mcpServers 结构 / 字段类型错），不执行任何注册 |
| JSON 批量部分失败 | 结果摘要：成功 N + 失败清单（name + 原因）；成功项不回滚 |
| 同名冲突 | MCP：覆盖前显式确认（§4.2）；Skill：提交前比对提示覆盖；Agent：主进程 slug 冲突错误透传内联 |
| 安装失败 | 沿用现 `installNotice` / 错误渲染链路 |

---

## 8. 测试计划

> 全部 colocated（`renderer/src/**` 贴源；momo-test-rules 保真：vi.mock `ipc.client` 断言真实调用参数与调用次数，不简化 ID/绑定语义）。

| 层 | 用例 |
|---|---|
| 组件 | `TypeSidebar`（三态选中/持久化）；`TypePageShell`（模式切换、来源 chip 联动）；`ResourceRow`（三类尾部槽条件、选中、stopPropagation）；`AddMenu` × 3（菜单项与副文案、点击回调）；`AgentCreateWizard`（分步流转、必填校验、步骤回退、提交字段完整性）；`McpJsonPasteDialog`（两种输入结构、字段校验、覆盖确认、部分失败摘要）；`SkillCreateDialog`（必填、预览拼接、成功保留）；`ImportAgentYamlDialog`（读文件、错误内联） |
| Provider | `MarketplaceCatalogProvider`（list 映射、query 过滤、错误透传；注入 mock ipc） |
| store | `resource.store`（typeFilter 驱动、mode 切换、registry 数据段） |
| IPC 契约 | `resource:createSkill` 新通道入参/出参形状测试（electron 侧单测 + renderer types 断言，双端同 commit）；向导 `createCustom` 传 `defaultMcps`/`defaultSkills` 的调用形状用例 |
| 迁移 | `ResourceLibraryView.test.tsx` 重写（壳 + 侧边菜单 + 页面切换）；`ResourceCard.test.tsx` → `ResourceRow.test.tsx`；`ResourceDetail.test.tsx` 更新三段结构 |
| 错误路径 | §7 表每行至少一款专项用例 |
| e2e 预留 | 资源库导航三页切换冒烟 + MCP JSON 导入 happy path（Playwright，实施计划的独立任务） |

---

## 9. 设计系统合规（v2.1）

- 颜色只用语义 token；图标只用 lucide-react（16px / stroke 1.75，侧边菜单 20px）；禁 emoji 图标（agent 用户数据 `iconEmoji` 照渲染为既有豁免）；
- 原子组件优先：`Button / Input / Dialog / Badge / Segmented / EmptyState / Avatar / Select`；状态色一律 `Badge tone`，不自造映射；
- 禁动态拼接 Tailwind class（静态书写）；双主题可运行。

---

## 10. 涉及文件清单

**新增（renderer）**
```
components/resource-library/TypeSidebar.tsx
components/resource-library/TypePageShell.tsx
components/resource-library/ResourceRow.tsx
components/resource-library/AddMenu.tsx
components/resource-library/RegistryBrowse.tsx
components/resource-library/wizard/AgentCreateWizard.tsx        // + steps/ 子组件
components/resource-library/ImportAgentYamlDialog.tsx
components/resource-library/McpJsonPasteDialog.tsx
components/resource-library/SkillCreateDialog.tsx
services/registry/types.ts
services/registry/marketplace-catalog-provider.ts
（每个组件/模块配 colocated .test.tsx/.ts）
```

**修改（renderer）**
```
components/resource-library/ResourceLibraryView.tsx   // 壳重写（挂载点不变，MiddlePanel 零改动）
components/resource-library/ResourceDetail.tsx        // 三段式
components/agent/RegisterMcpDialog.tsx                 // 高级项折叠（仅资源库内使用，原位演进）
stores/resource.store.ts                               // typeFilter 驱动 + mode
ipc/types.d.ts                                         // 新通道类型 + RegistryEntry 相关
ipc/client.ts                                          // 新通道绑定（如有集中映射）
```

**修改（electron）**
```
src/main/skill/form-create.ts                           // 新：createSkillFromForm（SKILL.md 生成 + .sha256 标记）
src/main/resource/ipc.handlers.ts                       // 新增 resource:createSkill handler
src/preload/index.ts                                    // createSkill 通道桥接（1 行）
```

**移除/取代**
```
components/resource-library/AddResourceMenu.tsx        // → AddMenu
components/resource-library/ResourceCard.tsx           // → ResourceRow（测试迁移）
```

---

## 11. 分期与边界

**本轮（P1）**：§2–§10 全部。

**P2 预留（后端能力，独立立项）**：MCP 启停（`mcp_definitions` 迁移 enabled 列 + toggle UI）；MCP 连接状态点（探活/池状态 IPC）；真实 mcphub / skillhub Provider（网络层 + 格式适配 + 安全校验）；Registry 多源选择器。

**非目标**：总览/混合视图；sse / streamableHttp 传输选择 UI；MembersPanel 的 CreateAgentDialog 向向导收敛；系统技能发现（扫本机其他 agent CLI 目录——Cherry Studio 亮点，列为未来候选）。
