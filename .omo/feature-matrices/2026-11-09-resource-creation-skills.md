# 消费面矩阵：资源创建技能组（momo-feature-scope-rules W1–W3）

- 日期：2026-11-09
- 特性：会话内资源创建——6 builtin 工具（resource_list / create_agent / add_agent_member / create_skill / create_mcp / create_team）+ resource-op 子进程桥 + `resource:changed` 渲染推送 + 4 builtin 技能 + Momo（general-assistant）v2.1.0 + builtin 预置启动再同步钩子
- 规则依据：`docs/dev/rules/engineering.md`（momo-feature-scope-rules 五步工作流 W1–W3）
- 设计依据：`docs/specs/2026-11-09-resource-creation-skills-design.md`（§10 为本矩阵预告摘要，本文件为完整落盘）
- 范围声明：本任务仅落盘 W1–W3；W4 门禁 8 问与 W5 验收回填由后续实施任务承接（spec §10 已预答第 7/8 条：生效层与可见层两层均有裁定；验收锚点含新建全链路 + 存量升级 + builtin 只读三场景）

---

## W1 三锚 grep（机械枚举）

### 锚① 能力名消费点（新工具名 / resource-op / 新广播通道）

```bash
grep -rn "resource_list\|create_agent\|create_skill\|create_mcp\|create_team\|add_agent_member\|resource-op\|resource:changed" electron/src renderer/src --include="*.ts" --include="*.tsx" | grep -v "\.test\."
```

**结果：0 命中。** 预期内——8 个标识符均为本次新增（6 工具名、桥消息 type 前缀、新广播通道），现网不存在任何消费点；本特性的消费面全部由锚②的既有链 + spec 新增面（§12 交付物）构成。对应矩阵行：R22（新增消费面由本特性自建）。

### 锚② 展示动词面（工具目录 / 候选 / 页签）

```bash
grep -rnE "getCatalog|useToolCatalog|listInstalled|listResources|unconditionalModules" electron/src/main/agent electron/src/main/resource renderer/src --include="*.ts" --include="*.tsx" | grep -v "\.test\."
```

**结果：88 命中**，逐点清单如下（G1–G6 分组，行号即命中行）：

**G1 工具目录聚合链（electron，9 命中）**

| 命中 | 分类 |
|---|---|
| `electron/src/main/agent/tools/types.ts:81` | 数据通路（ToolModule.getCatalog 接口契约） |
| `electron/src/main/agent/tools/index.ts:38` | 装配链（unconditionalModules 模块清单） |
| `electron/src/main/agent/tools/index.ts:57` | 装配链（getToolModules 默认走全量清单） |
| `electron/src/main/agent/tools/catalog.ts:7` | 数据通路（目录名来源注释：各模块 getDefs 自描述聚合） |
| `electron/src/main/agent/tools/catalog.ts:8` | 数据通路（import unconditionalModules） |
| `electron/src/main/agent/tools/catalog.ts:13` | 数据通路（flatMap getCatalog 聚合） |
| `electron/src/main/agent/tools/catalog-entry.ts:7` | 数据通路（目录条目 = tools:getCatalog 载荷单元） |
| `electron/src/main/agent/tools/catalog-entry.ts:39` | 装配链（缺目录元数据即抛错——新工具 meta 表强制登记） |
| `electron/src/main/agent/ipc.handlers.ts:343` | 数据通路（ipcMain.handle('tools:getCatalog')） |

**G2 既有 14 个工具模块 getCatalog 自描述（electron，15 命中）**

| 命中 | 分类 |
|---|---|
| `agent/tools/file-tools.ts:353`、`task-tools.ts:778`、`git-tools.ts:387`、`search-tools.ts:97`、`memory-tools.ts:165`、`process-tools.ts:70`、`office-tools.ts:104`、`web-tools.ts:181`、`shell-tools.ts:306`、`browser-tools.ts:356`、`todo-tools.ts:154`、`session-tools.ts:196`、`apply-patch-tools.ts:46` | 装配链参照（各模块自描述目录项，resource-tools.ts 的实现模板） |
| `agent/tools/plugin-tools.ts:88`、`plugin-tools.ts:113` | 装配链参照（插件工具目录透传聚合） |

**G3 注释引用（electron，1 命中）**

| 命中 | 分类 |
|---|---|
| `electron/src/main/agent/agent-queries.ts:9` | 注释（历史教训注释引用 unconditionalModules，无行为面） |

**G4 资源库 listResources / listInstalled 链（electron，28 命中）**

| 命中 | 分类 |
|---|---|
| `resource/library.ts:3` | 数据通路（listResources 多源聚合入口注释） |
| `resource/library.ts:19` | 数据通路（import listInstalledSkills） |
| `resource/library.ts:33` | 数据通路（listResources 函数本体） |
| `resource/library.ts:52`、`:74`、`:109`、`:130` | 数据通路（各源失败降级 warn） |
| `resource/library.ts:84`、`:94` | 数据通路（**skill builtin 扫描分支**——新 4 册目录的数据入口） |
| `resource/library.ts:169` | 数据通路（resolveResourceById 复用 listResources） |
| `resource/ipc.handlers.ts:50` | 数据通路（import listResources） |
| `resource/ipc.handlers.ts:135` | 数据通路（resource:list handler） |
| `resource/ipc.handlers.ts:250` | 数据通路（filter 短路注释） |
| `resource/ipc.handlers.ts:268` | 数据通路（resource:registerMcp 前置同名查询） |
| `resource/ipc.handlers.ts:291` | 数据通路（uploadSkill 写盘注释，listInstalled 识别 custom 源） |
| `resource/custom.ts:5`、`:14`、`:107` | 数据通路（custom skill 来源 = listInstalledSkills 过滤 source==='custom'） |
| `resource/plugin-dedup.ts:5`、`:30`、`:113` | 数据通路（插件源出口归并，listInstalledSkills） |
| `resource/catalog-adapter.ts:8`、`:12`、`:13`、`:19`、`:31` | 数据通路（marketplace installed 判断 = installer.listInstalled） |

**G5 hub 域（electron，13 命中）**

| 命中 | 分类 |
|---|---|
| `resource/hub-install.ts:30`、`:119`、`:463` | 数据通路（hub 安装状态判断 listInstalled） |
| `resource/hub/ownership.ts:28`、`:31`、`:76`、`:96`、`:152`、`:168` | 数据通路（hub 所有权判定，listInstalledSkills / listInstalled） |
| `resource/hub/momo-hub.ts:11`、`:112`、`:482`、`:487` | 数据通路（hub 目录降级态，resource:getCatalogStatus 消费） |

**G6 renderer 消费面（22 命中）**

| 命中 | 分类 |
|---|---|
| `lib/useToolCatalog.ts:1`、`:2`、`:49`、`:61` | 数据通路（工具目录 hook，tools:getCatalog 单一真相源） |
| `ipc/types.d.ts:557`、`:2407` | 数据通路（ToolCatalogEntry 契约镜像） |
| `ipc/types.d.ts:929` | 数据通路（InstalledSkill 镜像注释，listResources 二次解析） |
| `ipc/types.d.ts:2661` | 数据通路（resource.getCatalogStatus IPC 契约） |
| `components/agent/ToolPickerPanel.tsx:14`、`:80` | 展示面（工具勾选面板，useToolCatalog） |
| `components/agent/CapabilityTabs.tsx:15`、`:24`、`:73` | 展示面（成员工具分组页签，useToolCatalog） |
| `components/agent/AgentCreateWizard.tsx:7`、`:17`、`:82` | 展示面（建向导工具三档预置，useToolCatalog） |
| `components/agent/DefinitionEditor.tsx:26`、`:52`、`:55` | 展示面（定义编辑器工具候选，useToolCatalog） |
| `stores/resource.store.ts:56`、`:66`、`:272` | 数据通路（资源库 store，getCatalogStatus 降级态消费 + load() 拉取） |

### 锚③ 状态判定函数——**N/A**

本特性**无状态翻转**：不翻转任何启停/默认值/可见性语义。6 工具与 4 技能均为**纯新增能力**（不存在「既有状态读取点换语义」）；Momo 升级走 §8 幂等再同步（YAML 版本 > DB 行版本时 UPDATE，非状态翻转）；defaultSkills 恢复是新增引用字段而非既有状态语义变化。锚③按规则显式记 N/A，门禁第 6 条据此答「不适用，已论证」。

---

## W2 消费面矩阵

列定义：
- **新建** = 本次新增物（6 工具 + 4 技能 + Momo v2.1.0 + 再同步钩子 + resource-op 桥 + resource:changed 通道）落地后该消费面的行为
- **存量** = 已启用 Momo 的 DB 行（v2.0.0，58 工具，无 defaultSkills）
- **builtin 只读** = 未启用/已启用的 builtin 预置（general-assistant.yaml，只读语义）

### 数据通路与装配链行（锚②逐组）

| # | 消费面（W1 命中引用） | 新建 | 存量 | builtin 只读 |
|---|---|---|---|---|
| R1 | 工具目录聚合链 G1：`tools/types.ts:81`、`index.ts:38,57`、`catalog.ts:7,8,13`、`catalog-entry.ts:7,39`、`agent/ipc.handlers.ts:343` | **改**：resource-tools.ts 新模块注册进 unconditionalModules 清单（index.ts:38）+ catalog-entry meta 表登记 6 条目（catalog-entry.ts:39 缺 meta 即抛错，强制项）；getCatalog 聚合与 tools:getCatalog handler（catalog.ts:13、ipc.handlers.ts:343）零改动即自动携带 58→64 | **不改**：聚合数据驱动，存量行经再同步获得新工具后同一 handler 自动出 64 项 | **不改**：接口与聚合逻辑不变，启用时经 manifest 原生获得 |
| R2 | 既有 14 工具模块 getCatalog G2（file/task/git/search/memory/process/office/web/shell/browser/todo/session/apply-patch/plugin-tools，15 命中） | **不改**：作为 resource-tools.ts 的实现模式参照（零改动），插件工具目录透传（plugin-tools.ts:88,113）不受影响 | 不改 | 不改 |
| R3 | 注释引用 G3：`agent-queries.ts:9` | **不改**：历史教训注释，无行为面 | 不改 | 不改 |
| R4 | renderer 目录桥 G6：`useToolCatalog.ts:1,2,49,61`、`ipc/types.d.ts:557,929,2407,2661` | **不改**：hook 与契约条目形状不变（64 项数据驱动流过）；types.d.ts:929（InstalledSkill 镜像）与 2661（getCatalogStatus）与本特性无关 | 不改 | 不改 |
| R8 | hub 降级态链 G5：`hub-install.ts:30,119,463`、`hub/ownership.ts:28,31,76,96,152,168`、`hub/momo-hub.ts:11,112,482,487`、`resource/ipc.handlers.ts:418,423`、`resource.store.ts:56,66,272` | **不改**：hub 域与 builtin skill / 新工具无交集；getCatalogStatus 降级态语义不变（resource.store 订阅新增见 R22，本行仅指降级态读取面） | 不改 | 不改 |
| R9 | `resource/library.ts` listResources 多源聚合 G4（10 命中，含 :84,94 skill builtin 扫描分支） | **不改**（代码）：:84,94 的 builtin 目录扫描数据驱动，新 4 册落 `electron/resources/skills/` 后自动拾取（该目录现不存在，落盘即生效）；listResources 聚合逻辑零改动 | 不改 | 不改 |
| R10 | `resource/ipc.handlers.ts:50,135,250,268,291` resource:list / registerMcp / uploadSkill handler | **不改**：listResources 聚合自动出现新资源；resource:registerMcp / uploadSkill 为 UI 链不动（会话创建走 resource-op 桥复用同链校验，不经这两条 handler）；`resource:changed` 为**新增**通道非改既有面（spec §2 不动 IPC 通道契约面） | 不改 | 不改 |
| R11 | `resource/custom.ts:5,14,107` custom 源 | **不改**：custom 源过滤逻辑（source==='custom'）与新 builtin 4 册无交集（4 册走 builtin 源） | 不改 | 不改 |
| R12 | `resource/plugin-dedup.ts:5,30,113` 插件源归并 | **不改**：插件源归并与 builtin skill 无交集；仅验收时确认新 slug 不与插件源撞名 | 不改 | 不改 |
| R13 | `resource/catalog-adapter.ts:8,12,13,19,31` marketplace installed 判断 | **不改**：installed 判断逻辑不变；catalog.json +4 条目为 builtin 内联新条目（见 R18），不改判定代码 | 不改 | 不改 |
| R19 | `agent:runtimeChanged` 既有广播 → MainLayout 成员重拉（spec §6） | **不改**（消费端已存在）：成员增减类 op（createAgent-addToWorkspace / addMember / createTeam）由主进程侧复播既有通道，MainLayout 既有监听即重拉——验证该通道有生产者（本特性即新增生产者，消费端零改） | 同左 | 同左 |
| R21 | SkillRegistry / RuntimeSkillRef defaultSkills 解析链（spec §7） | **不改**：4 册经 builtin 扫描注册，Momo manifest 的 defaultSkills 引用走既有 RuntimeSkillRef 链路（skill 底层机制不改，spec §2） | 不改 | 不改 |
| R22 | `resource:changed` 新广播消费面（preload `resource.onChanged` 订阅、resource.store load() 重拉、agent.store 成员/团队重拉）——**本特性新增**（锚①零命中对应的新消费点，自建自销） | **改**：renderer 小改动三处 + 主进程广播一处（复用 pushToMainWindow / notifyPanelsChanged 模式）——spec §12 交付物；现行「死注释广播」被此通道替换 | **改**：存量库同一 renderer 代码生效（订阅逻辑与存量/builtin 无关，随包升级） | 同左 |

### 四类展示面 checklist（每类至少一行，不许漏类）

| # | 展示面 | 新建 | 存量 | builtin 只读 |
|---|---|---|---|---|
| R5 | ②选择器候选·**成员编辑工具页签**：`ToolPickerPanel.tsx:14,80`、`CapabilityTabs.tsx:15,24,73` | **改**（内容不改码）：候选目录 58→64 数据驱动原生出现；Momo builtin 只读经成员 deltas 增删 6 工具（既有模式，spec §10 同款裁定）；任何 custom agent 亦可勾选（通用可挂） | **不改**：再同步后 Momo 工具面原生更新，候选列表自动含新工具 | **不改**：启用时经 manifest 原生获得 |
| R6 | ②选择器候选·**建向导三档预置**：`AgentCreateWizard.tsx:7,17,82` | **不改**：useToolCatalog 数据驱动，64 项自动流过，三档语义不变 | 不改 | 不改 |
| R15 | ②选择器候选·**成员编辑 MCP/Skill 页签**（MemberEditDialog，G6 未命中但属同类候选面） | **不改**：新 MCP / skill 落库后经 resource:changed 重拉，候选列表数据驱动出现（既有 listResources 拉取），零码改 | 不改 | 不改 |
| R16 | ②选择器候选·**工作空间配置页** | **不改**：本次不新增工作空间级配置项（资源创建为会话内工具行为） | 不改 | 不改 |
| R14 | ①资源目录页（资源库各类型页签）：`resource-library/`（ResourceLibraryView / TypeSidebar / ResourceCard / TypePageShell）——agent / MCP / skill 三页签 | **改**（内容不改码，三页签分述）：agent 页签 = Momo 预置卡版本 v2.1.0（YAML 更新）+ 会话建 custom agent 落库后经 R22 刷新原生出现；skill 页签 = 4 册 builtin 经 listInstalled 扫描原生出现；MCP 页签 = create_mcp 落库后经刷新出现；列表组件零码改 | **改**（存量列行为）：再同步后 Momo 行内字段更新；存量库中会话创建的新资源同样经刷新出现 | **不改**：builtin 预置启用链（EnablePresetDialog / AgentsView 预置卡）不变，首启用即 v2.1.0 |
| R17 | ③命令引用入口（/ 命令、@ 引用） | **不适用**：固定注册表，设计如此（spec §10 同款裁定）——本特性不新增 / 命令与 @ 引用形态，6 工具经 LLM 工具调用触发非 slash 命令 | 不适用（同左） | 不适用（同左） |
| R7 | ④编辑器·**定义编辑器**：`DefinitionEditor.tsx:26,52,55` | **不改**：Momo builtin 只读既有语义不变；工具候选数据驱动 64 项；会话建的 custom 定义可编辑（既有 custom 编辑链） | 不改 | 不改 |
| R20 | ④编辑器·**成员编辑器**（MemberEditDialog，工具/MCP/Skill 三页签汇总见 R5/R15）与**工作空间配置**（见 R16） | **改**（仅工具页签候选内容，见 R5；码改仅 R22 刷新订阅）：deltas 行模型既有模式，不扩字段 | 同 R5 | 同 R5 |

### spec §10 镜像补充行（非 W1 命中，登记面）

| # | 消费面 | 新建 | 存量 | builtin 只读 |
|---|---|---|---|---|
| R18 | `resources/marketplace/catalog.json` 双轨登记 | **改**：+4 条 skill 条目（builtin 内联，downloadUrl 空串）；既有条目计数测试 fixture 联动 +4（spec §11） | 不适用（登记面无存量语义） | 不适用（同左） |
| R23 | Momo（general-assistant.yaml）v2.1.0：defaultTools +6 / defaultSkills +4 / systemPrompt 资源创建引导段 | **改**：YAML 升版（唯一直接编辑的 builtin 定义） | **改**（存量列核心）：启动再同步钩子（§8）——YAML 版本 > DB 行版本时走 enablePresetDef UPDATE 分支，defaultTools/defaultSkills/systemPrompt/name/description 更新，**modelProviderId/modelName/thinkingJson 保留用户已配值**，成员关系与 default 引用保留；幂等（版本相等跳过） | **改**（未启用态）：首启用即 v2.1.0（启用链不改，内容更新） |

---

## W3 diff 反查（W1 清单 ↔ 矩阵行差集）

| W1 命中组 | 命中数 | 矩阵行 | 差集 |
|---|---|---|---|
| 锚① 新标识符 | 0 | R22（新增消费面自建） | 空 |
| G1 工具目录聚合链 | 9 | R1 | 空 |
| G2 既有工具模块 | 15 | R2 | 空 |
| G3 注释 | 1 | R3 | 空 |
| G4 资源库 listResources 链 | 28 | R9（library 10）/ R10（ipc.handlers 5）/ R11（custom 3）/ R12（plugin-dedup 3）/ R13（catalog-adapter 5）、R8（ipc.handlers:418,423 归入 hub 降级态） | 空 |
| G5 hub 域 | 13 | R8 | 空 |
| G6 renderer | 22 | R4（useToolCatalog 4 + types.d.ts 4）/ R5（ToolPickerPanel 2 + CapabilityTabs 3）/ R6（AgentCreateWizard 3）/ R7（DefinitionEditor 3）/ R8（resource.store 3） | 空 |

**反查差集为空**：锚① 0 + 锚② 88 + 锚③ N/A，全部命中已映射到 R1–R23 行，无查到而未裁定的点；矩阵行亦无无 W1 来源的未标注行（R14/R15/R16/R17/R18/R19/R20/R21/R23 为 W2 四类展示面 checklist 强制行或 spec §10 镜像行，来源已在行内标注）。

---

## 附：本特性变更物清单（矩阵「新建」列的实体，非消费面行）

1. `electron/src/main/agent/tools/resource-tools.ts`（+ catalog.ts 注册 + catalog-entry meta 表 6 条目）——R1
2. `electron/src/main/agent/resource-ops-bridge.ts`（子进程侧）+ `runtime-spawner.ts` per-child message 路由（`resource-op:` 前缀，op 白名单六枚举）——R22 上游
3. `electron/resources/skills/{create-agent,create-skill,create-mcp,build-team}/SKILL.md`（目录现不存在，新建）——R9/R14/R21
4. `electron/resources/agents/general-assistant.yaml` v2.1.0——R23
5. builtin 预置启动再同步钩子（`index.ts` runMigrations() 之后）——R23 存量列
6. `resources/marketplace/catalog.json` +4 条——R18
7. `resource:changed` 广播 + preload `resource.onChanged` + resource.store / agent.store 订阅——R22
