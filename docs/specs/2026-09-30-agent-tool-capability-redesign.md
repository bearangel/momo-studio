# Agent 创建工具集重构：目录单一真相源 + 白名单修复 + 工具分级 设计文档

- 日期：2026-09-30
- 状态：已确认（八节设计经用户逐节确认通过）
- 上游依据：v2.0.0 现行架构 `2026-08-23-v2.0.0-platform-refactor-design.md`；能力三层配置 `docs/plans/2026-08-11-v1.6-capability-config.md`（本设计修复其遗留缺陷）

## 1. 背景与目标

用户报告三类问题，经代码勘察全部证实，且发现一个更深的权限执行缺陷：

1. **工具目录三层漂移**：renderer 镜像副本（`renderer/src/lib/tool-catalog.ts`）停在 v1.5 的 24 工具；electron 目录（`electron/src/main/agent/tools/catalog.ts`）停在 v2.1 的 33 工具；运行时 `buildToolRegistry` 实际注册 14 个 ToolModule ≈ 60+ 工具。创建界面展示的工具集与系统能力严重脱节，缺失 Process / Task(7) / Memory(3) / Browser(12) / Session(2) / `git_repos` / `apply_patch` / 办公(9)。
2. **创建入口无 skill / MCP 选择**：`CreateAgentDialog`（Agent 管理页入口）只有三档 preset + 纯 builtin 勾选；`CapabilityTabs`（已支持 工具/MCP/Skill 三 tab）未被该入口复用。
3. **per-agent 工具白名单完全失效（本次勘察新发现，P0）**：`runtime-entry.ts buildRuntimeContext` 的 v1.7.1「动态工具白名单修复」实现有误——`dynamicNames = tools.map(t => t.name)` 中的 `tools` 数组首个展开项即 `getAllToolDefs(toolModules)`（全部内置工具），导致只要 `allowedTools` 非空就被扩成全集。**任何 agent 无论创建时怎么配，运行时都能调用 `bash` / `git_commit` / `browser_*` 等全部工具**；界面配置形同虚设。

目标：

1. 工具目录以注册中心为单一真相源，结构性根除漂移
2. 修复白名单执行，恢复「UI 所配即所得」语义
3. 建立工具分级模型（平台机制 / 公共默认 / 可选 / 扩展），明确哪些工具 agent 默认必备、哪些可选
4. 创建入口可配置 工具 + MCP + Skill 三类能力

非目标：能力三层合并模型（Layer 1 def ∪ Layer 2 workspace ∪/− Layer 3 per-成员 delta）变更；MCP Host / SkillRegistry 运行时机制变更；deniedTools 黑名单语义变更。

## 2. 需求澄清决策记录

| # | 问题 | 决策 |
|---|---|---|
| D1 | 白名单失效 bug 处置 | 修复白名单强执行 + 分级默认（否决黑名单模式与放宽默认档两个备选） |
| D2 | 公共默认集（Tier 1）边界 | 只读 13 + 文件写 4（`write_file` `edit_file` `mkdir` `mv`），共 17 个；不含 `rm` |
| D3 | Tier 1 是否强制 | 默认勾选、可取消；强制项仅 Tier 0 平台机制工具 |
| D4 | 目录单一真相源 | 方案 A：ToolModule 自描述元数据 + IPC 下发，删除 renderer 镜像副本（否决共享 JSON 与双副本+测试） |
| D5 | spec 落位 | 按仓库惯例 `docs/specs/`；不自动 commit |

## 3. 工具分级模型

### 3.1 Tier 0 · 平台机制（恒注入，不进配置 UI，不可选）

`task_complete` `compact` `loadSkill` `readResource` `dispatch:*`

chat loop 生命周期、多 agent 协作、skill 加载的运转部件。白名单修复后是唯一合法的「自动放行」集。

### 3.2 Tier 1 · 公共默认集（defaultOn=true，创建默认勾选、可取消）

| 组 | 工具 |
|---|---|
| 文件读 | `read_file` `list_files` `exists` |
| 搜索 | `grep` `glob` |
| 文件写 | `write_file` `edit_file` `mkdir` `mv`（不含 `rm`） |
| 任务读 | `list_tasks` `read_task` `read_task_history` `read_task_progress` |
| 记忆读 | `memory_search` |
| 会话读 | `list_sessions` `read_session` |
| 自留地 | `todowrite`（仅写自身任务清单） |

`SAFE_MINIMUM_TOOLS` 语义演进为本集（7 → 17），仍是「新建 custom agent 默认勾选集」。

### 3.3 Tier 2 · 可选工具（defaultOn=false，按需勾选）

| 组 | 工具 | riskNote |
|---|---|---|
| 文件破坏 | `rm` | 不可恢复删除 |
| 原子补丁 | `apply_patch` | 多文件批量修改 |
| Shell/进程 | `bash` `process_list` `process_keep` `process_kill` | 任意代码执行 / 进程控制 |
| Git 读 | `git_repos` `git_status` `git_diff` `git_log` `git_show` | — |
| Git 写 | `git_add` `git_commit` `git_branch` `git_checkout` `git_stash` | 改仓库历史 |
| 网络 | `webfetch` | 涉外请求 |
| 浏览器 | `browser_navigate` `browser_snapshot` `browser_screenshot` `browser_click` `browser_type` `browser_press_key` `browser_hover` `browser_scroll` `browser_evaluate` `browser_console_messages` `browser_tabs` `browser_close` | 已有信任门兜底 |
| 办公 | `office_read` `office_read_cells` `office_create_excel` `office_write_excel` `office_create_doc` `office_create_ppt` `office_create_pdf` `office_copy` `office_fill_ppt_template` | 文件覆盖 |
| LSP | `lsp_diagnostics` `lsp_find_references` | conditional：仅 TS/JS workspace 注册 |
| 记忆写 | `memory_save` `memory_forget` | forget 删除数据 |
| 任务写 | `create_task` `complete_task` `fail_task` | 任务板状态变更 |

### 3.4 Tier 3 · 扩展能力

MCP server / Skill，per-agent opt-in（现有 CapabilityTabs 交互）。MCP/skill 为 workspace 级安装资源，agent 定义为全局（v25）——引用按 slug，运行时 `discoverMcpTools` 对该 workspace 未安装的 server 静默跳过（现有行为，保持）。

## 4. 设计细节

### 4.1 白名单修复（P0）

`runtime-entry.ts buildRuntimeContext`：

```typescript
const builtinNames = new Set(getAllToolDefs(toolModules).map((t) => t.name));
const dynamicNames = tools
  .filter((t) => !builtinNames.has(t.name))  // 只剩 loadSkill / readResource / mcp:* / dispatch:* / task_complete / compact
  .map((t) => t.name);
if (config.allowedTools.length > 0) {
  config.allowedTools = [...new Set([...config.allowedTools, ...dynamicNames])];
}
```

回归锁：新测试断言 `allowedTools=['read_file']` 的 runtime 调 `bash` 被 `assertToolAllowed` 拒绝（「工具 bash 不在允许列表中」）。该测试修复前必红、修复后必绿。

### 4.2 ToolModule 自描述元数据

```typescript
// electron/src/main/agent/tools/catalog-entry.ts（新文件，避免 catalog ↔ 模块循环依赖）
export interface ToolCatalogEntry {
  name: string;
  description: string;
  category: string;        // '文件' | '搜索' | 'Shell' | ...
  categoryEmoji: string;   // 沿用现有目录 emoji（数据字段，豁免 emoji 图标禁令）
  defaultOn: boolean;      // Tier 1 = true（创建默认勾选，可取消）
  riskNote?: string;       // 高危组 UI 提示文案
  conditional?: string;    // LSP: '仅 TS/JS workspace 可用'
}
export type ToolMeta = Omit<ToolCatalogEntry, 'name' | 'description'>;
export function buildCatalog(defs: LLMToolDef[], metaByTool: Record<string, ToolMeta>): ToolCatalogEntry[];
// 缺 meta 的工具直接抛错——fail-fast，防「新模块注册但目录漏项」静默漂移

// electron/src/main/agent/tools/types.ts
export interface ToolModule {
  /** 目录自描述（单一真相源）：与 getDefs() 一一对应的目录条目 */
  getCatalog(): ToolCatalogEntry[];
  getDefs(): LLMToolDef[];
  // handles / execute 不变
}
```

粒度说明：`defaultOn` 分级是 **per-tool** 而非 per-module（FileTools 内 `read_file` 默认开、`rm` 默认关），故自描述方法返回条目数组。LspTools 私有构造——目录条目经模块导出常量 `LSP_CATALOG_ENTRIES`（带 conditional 标注）参与派生。

- 14 个模块各实现 `getMeta()`（LspTools 标 conditional；BrowserTools riskNote 注明信任门）
- `catalog.ts` 保留 `ALL_BUILTIN_TOOLS` / `SAFE_MINIMUM_TOOLS` / `TOOL_CATEGORIES` 导出符号，实现改为从模块聚合派生（对 marketplace/installer、p2p clamp、`createCustomDef` 默认值等既有消费者零改动）
- LSP 条件注册的派生处理：目录含 LSP 条目（带 conditional 标注），`SAFE_MINIMUM_TOOLS` 不含 LSP 工具（现状一致）
- p2p 导入钳制集合（`readToolRefs` 的 SAFE_TOOL_REFS）改由新 Tier 1 派生——仍天然不含 `rm` / `bash` / git 写，钳制强度不降级

### 4.3 IPC `tools:getCatalog` + 删除 renderer 镜像

- electron：新 IPC handler 返回 `buildToolCatalog()` 聚合结果（name + description + meta 的扁平数组）
- renderer：`renderer/src/ipc/types.d.ts` 补接口、preload 补桥接；**删除 `renderer/src/lib/tool-catalog.ts`**；新增 `useToolCatalog()` hook（模块级缓存 + 单飞去重）供 `CapabilityTabs` / `CreateAgentDialog` / `AgentCreateWizard` 消费
- 两 workspace 同步 typecheck（IPC 契约变更，boundary-rules 口径）
- 拉取失败：能力配置区降级为错误提示空态，不阻塞表单其余字段（名称 / 模型 / 提示词仍可填写）

### 4.4 创建入口改造

**`CreateAgentDialog`**：

- 三档 preset 语义升级：「标准（Tier 1）」/「全部」/「自定义」（radio 组保留，文案与语义对齐新分级）
- 自定义区块从手写 checkbox 换 `CapabilityTabs mode='edit'`——skill / MCP 选择即刻获得
- 提交时 `defaultTools + defaultMcps + defaultSkills` 三字段齐发；`CreateCustomDefInput` 与 `ipc.agent.createCustom` 链路补 `defaultMcps` / `defaultSkills` 透传（`agent_definitions` 三列与 `updateAgentDefinition` 已支持，仅创建链路缺）

**`AgentCreateWizard`**：工具步骤切换到 `useToolCatalog()` 数据源，交互不变。

### 4.5 存量迁移（只加不减）

- DB migration（下一个版本号）：现有 `agent_definitions.default_tools` 逐行解析 JSON，追加新 Tier 1 中缺失的 builtin refs，事务内执行、幂等（重复跑无副作用）
- 内置 YAML（coder / pm-agent / office-assistant / requirement-analyst）`defaultTools` 加法更新——白名单生效后 builtin agent 不丢任务读 / 记忆读 / 会话读能力（勘察确认：现行 YAML 均未包含这些工具，不加法则为事实能力回退）
- `default_mcps` / `default_skills` 不迁移不动

## 5. 数据流（修复后全景）

```
ToolModule.getMeta()/getDefs() ──buildToolCatalog()──► IPC tools:getCatalog ──► useToolCatalog()
                                                                          │
                                                                          ▼
                                              CreateAgentDialog / CapabilityTabs / Wizard
                                                          │ defaultTools/Mcps/Skills
                                                          ▼
                                              agent_definitions 三列（JSON）
                                                          │ Layer1 ∪ Layer2 ∪/− Layer3
                                                          ▼
                                     AGENT_CONFIG { allowedTools, mcpNames, skills }
                                                          ▼
                     buildRuntimeContext：全部模块注册（执行面不变）
                                                          ▼
                     allowedTools + dynamicNames(仅 Tier 0) ──► assertToolAllowed 强执行
```

## 6. 错误处理

| 场景 | 行为 |
|---|---|
| catalog IPC 拉取失败 | 能力区空态 + 错误提示，不阻塞表单其余部分 |
| migration 失败 | 事务回滚，启动失败带明确错误（better-sqlite3 同步事务） |
| 存量 def 的 defaultTools JSON 含未知工具名 | 保留原样（白名单放行集合中出现未注册名无副作用，运行时模块不 handles 即不可调） |
| Tier 1 工具在特定 workspace 不可用（LSP 类条件工具入白名单但未注册） | 同上，白名单项多余不报错 |

## 7. 测试策略

**electron（`electron/tests/` 镜像 src 结构）**：

1. 白名单拦截回归锁：`allowedTools=['read_file']` 调 `bash` 被拒（§4.1）
2. 目录完备性：`getAllToolDefs` 产出的每个工具名都出现在 `buildToolCatalog()` 且带 meta——防目录与注册中心再漂移
3. catalog 派生一致性：`SAFE_MINIMUM_TOOLS` = Tier 1 全集；`TOOL_CATEGORIES` 并集 = `ALL_BUILTIN_TOOLS`（承接现有 tools-catalog.test.ts 断言意图）
4. migration 幂等 + 只加法：含旧 7 工具的 def 迁移后 = 旧集 ∪ Tier 1；已含工具不重复
5. 创建链路：`createCustom` 带 defaultMcps/defaultSkills 落库回读一致

**renderer（贴源 colocated）**：

6. `CreateAgentDialog`：渲染三 tab、自定义档提交三字段（mock IPC）
7. `CapabilityTabs`：消费 IPC catalog 渲染分组与 defaultOn 预勾选（mock `tools:getCatalog`）

**手动验收**：dev 模式建一个仅勾 Tier 1 的 agent → 会话内要求执行 bash → 收到「工具 bash 不在允许列表中」。

## 8. 兼容性说明

- 现有 custom agent（defaultTools 为旧安全最小集 7 个）：迁移后自动获得 Tier 1 全集（加法）；若用户此前依赖「白名单失效带来的全工具面」，迁移后按其显式配置收窄——这正是修复的语义回归，非缺陷
- builtin agent：YAML 加法更新后能力 ⊇ 迁移前声明集
- `deniedTools` 黑名单语义不变，优先级仍高于白名单
- 版本号：按研发期纪律，实现 commit 不动版本号，合入时三处 `package.json` alpha 号 +1
