# 预设 Agent 与 Skill 内容库设计（五角色全覆盖）

- 日期：2026-10-08
- 状态：待评审
- 类型：内容预设（纯新增/覆盖内容文件 + catalog 登记 + 测试；**零 TS 机制改动**）

## 1. 背景与目标

Momo Studio 的目标用户为五类角色：需求/产品人员、UI 设计师、全栈开发工程师、研发管理、文档办公人员（PPT/Word/Excel/PDF）。当前内置预设覆盖不足：

- Agent 仅 4 个（项目经理/需求讨论师/程序员/办公助理），**UI 设计师缺失**；项目经理定位为「编排调度」，与研发管理用户的实际职能（排期/评审/汇报）错位
- Builtin skill 仅 3 个且全是开发向（code-review / write-tests / debug-reproduce），其余四类角色为零

本设计基于市面 skill 生态调研（Anthropic 官方 skills 仓库 19 个 skill、skills.sh / claude.com 插件市场头部内容、obra/superpowers、Vercel agent-skills、oh-my-openagent prompt 模式）与系统现状探索，给出：

- **5 个 agent**（新增 1 + 升级 4，含 pm-agent 重定位为研发管理向）
- **20 个 skill**（新增 17 + 规范化升级现有 3）
- catalog.json 双轨登记对齐（修复现状 catalog skill 条目与 builtin 目录漂移）

**成功标准**：用户在预置库启用 agent 后，agent 自带对应 skill；任何 agent 可另行挂载全部 18 个 builtin skill；全部内容开箱可用、零外部依赖。

## 2. 非目标

- 不改 skill/agent 底层机制（SkillRegistry、渐进披露、预置库启用链路均沿用现状）
- 不引入任何脚本执行依赖（Anthropic 文档 skill 的 python-pptx/LibreOffice 路线不采用——office 场景由内建 office_* 工具承载）
- 不做 MCP 工具桥接（catalog 仅登记现有条目，不新增 MCP）
- 不动 renderer UI

## 3. 调研结论摘要（设计依据）

1. **Skill 格式与 Anthropic 生态同构**：`SKILL.md`（frontmatter `name` + `description`）+ 可选 `references/` 附属文件；系统已支持 git 仓库直接导入该格式
2. **渐进披露三层机制现成**：Layer 1 = frontmatter description 进 system prompt；Layer 2 = `loadSkill` 虚拟工具读 SKILL.md 正文；Layer 3 = `readResource` 虚拟工具读 `references/` 附属文件。→ **description 的触发短语质量直接决定命中率**
3. **市面验证的安全选题**（跨 ≥3 个市场出现）：文档四件套方法论、前端 anti-AI-slop 设计、TDD/调试/验证三件套、PRD 渐进共创、任务分解与排期、反 AI 腔写作
4. **oh-my-openagent（69.9K★，SUL-1.0 非商用）**：agent 阵容全是软件工程向、与五角色几乎零重叠；但其 prompt 工程模式值得移植（原创转译）：角色锚定一句话（「你是 X，做 Y，从不 Z」）、NEVER/ALWAYS 硬规则清单置尾、反重复规则、最小权限工具集
5. **License 红线**：Anthropic 文档 skill（pptx/docx/xlsx/pdf）为 Source-available 私有协议；oh-my-openagent 为 SUL-1.0。**一律零复制**，只借鉴选题与结构模式，内容全部原创中文

## 4. Agent 阵容设计（5 个）

### 4.1 统一 prompt 结构（四段式）

所有 agent 的 `systemPrompt` 升级为统一结构：

```
（一句话角色锚定：你是 X——[定位]。你做 Y，你从不 Z）

工作流：
1. ...（编号步骤，引用真实工具名）

工具要点：
- （何时用哪个工具的优先级提示）

硬规则：
- NEVER: ...
- ALWAYS: ...
```

### 4.2 阵容总表

| slug | 名称 | 动作 | 版本 | 模型建议（manifest 实际写法） | defaultSkills |
|---|---|---|---|---|---|
| `requirement-analyst` | 需求分析师 | 升级 | 1.1.0 | anthropic / claude-3-5-sonnet（沿用现值） | prd-coauthoring, user-story-craft |
| `ui-designer` | UI 设计师 | **新增** | 1.0.0 | anthropic / claude-3-5-sonnet | design-spec, frontend-polish, design-critique |
| `coder` | 程序员 | 升级 | 1.1.0 | openai / gpt-4o（沿用现值） | tdd-workflow, frontend-best-practices, code-review, write-tests, debug-reproduce |
| `pm-agent` | 项目经理 | **重定位**升级 | 1.1.0 | anthropic / claude-3-5-sonnet（沿用现值） | task-breakdown, tech-design-review, sprint-reporting, verification-before-done |
| `office-assistant` | 办公助理 | 微升级 | 1.1.0 | anthropic / claude-3-5-sonnet（沿用现值） | excel-analysis, ppt-authoring, pdf-extraction, doc-formatting, doc-coauthoring, humanize-writing |

### 4.3 各 agent 定位与升级要点

**requirement-analyst（需求分析师，升级）**
- 角色锚定：「你是需求澄清者——用追问消解模糊，用结构沉淀共识；你从不替用户发明业务规则」
- 工作流升级：三维追问（数据源/业务规则/异常路径）→ 分节渐进产出 PRD → `[TBD]` 占位纪律（未确认项显式标注，不编造）→ 验收标准（Given/When/Then）
- defaultTools 沿用现有清单不变

**ui-designer（UI 设计师，新增）**
- 角色锚定：「你是设计规范守护者——产出设计 token、组件 spec 与设计契约；你审查界面但不直接写产品代码」
- 工作流：需求理解 → 设计 spec 产出（DESIGN.md 契约：token/组件/状态）→ 浏览器截图走查（browser_navigate + browser_screenshot + browser_snapshot 对既有实现评审）→ 交接文档
- defaultTools（最小权限 + 走查需要；**不含 LSP 工具**——LSP 子系统 2026-10-08 已下架休眠，恢复时再评估补回）：
  - 文件组：`read_file` `write_file` `edit_file` `apply_patch` `mkdir` `mv` `exists` `grep` `glob`（不授 `rm`）
  - 浏览器组：`browser_navigate` `browser_snapshot` `browser_screenshot` `browser_click` `browser_type` `browser_press_key` `browser_scroll` `browser_console_messages`（不授 `browser_tabs` `browser_close` `browser_evaluate`）
  - 其他：`webfetch` `todowrite`
  - 读取组：`list_sessions` `read_session` `memory_search` `read_task` `read_task_history` `read_task_progress` `list_tasks`

**coder（程序员，升级）**
- 角色锚定：「你是实现工程师——先读后写、遵循项目既有风格、测试先行；你从不提交未验证的代码」
- 工作流升级：读需求文档（read_file）→ 了解结构（list_files/grep）→ TDD 循环（先写失败测试）→ 实现并用 lsp_diagnostics 自检 → git 提交流程
- defaultTools 沿用现有清单不变

**pm-agent（项目经理，重定位升级）**
- 重定位理由：v25 团队机制下编排是系统能力（任何 leader 自动获得 dispatch 注入），prompt 里的「调度子 agent」教学与研发管理用户的职能需求错位
- 角色锚定：「你是研发管理者——拆解任务、评审方案、产出排期与汇报；编排派发交给团队机制，你不亲自写代码」
- 工作流：目标理解 → 任务分解（可独立验收粒度 + 依赖 + 风险）→ 技术方案评审（checklist 式）→ 周报/里程碑汇报（进展/风险/待决策三段式）
- 作为团队 leader 时 dispatch 照常可用（系统注入，不依赖 prompt）
- defaultTools 沿用现有清单不变

**office-assistant（办公助理，微升级）**
- 现有 prompt 是全库最强（office 工具用法已细化），主体保留；将「方法论深度」下放到 4 个 skill（excel/ppt/pdf/doc），prompt 中引导「按已挂载 skill 的方法执行」
- defaultTools 沿用现有清单不变

## 5. Skill 清单设计（20 个）

通用规则：

- 目录：`electron/resources/skills/<slug>/SKILL.md`（+ 可选 `references/*.md`）
- frontmatter：`name`（中文显示名）+ `description`（一句话定位 + 中文触发短语）+ `version`（惯例字段，机制仅消费 name/description——对齐现有 3 个 skill 的写法）
- 正文四段：适用场景 → 工作流 → 输出规范 → 硬规则（NEVER/ALWAYS）
- 正文 ≤3KB，超出拆 `references/`（Layer 3 披露）
- 无版本号字段（frontmatter 仅两字段，机制如此）

### 5.1 通用组（3 个）

| slug | 名称 | 定位 | 灵感来源 |
|---|---|---|---|
| `doc-coauthoring` | 长文档共创 | 上下文转移 → 分节迭代 → 读者视角验证；适用任何长文档（方案/报告/手册） | anthropics/skills `doc-coauthoring` |
| `humanize-writing` | 反 AI 腔中文写作 | 消灭「综上所述/总而言之/值得注意的是」式套话；口语化、信息密度优先 | blader `humanizer` + `stop-slop` |
| `verification-before-done` | 完成前验证 | 证据先于宣称完成：跑过测试才算通过、看过输出才算生成、引用文件路径必须存在 | obra/superpowers `verification-before-completion` |

### 5.2 需求/产品组（2 个）

| slug | 名称 | 定位 | 灵感来源 |
|---|---|---|---|
| `prd-coauthoring` | PRD 渐进共创 | 三维追问（数据源/业务规则/异常路径）→ 分节产出 → `[TBD]` 占位纪律 → 结构化 PRD 模板 | GarrusHuang/prd-writer + DivikWu/product-requirement-craft |
| `user-story-craft` | 用户故事与验收标准 | INVEST 原则 + 故事拆分 + AC 写法（Given/When/Then） | dmpriatna/NatPRD + product-manager-skill |

### 5.3 UI 设计组（3 个）

| slug | 名称 | 定位 | 灵感来源 |
|---|---|---|---|
| `design-spec` | 设计 spec 契约 | 发现 → 设计 token → 组件 spec → 状态定义 → 工程交接文档（DESIGN.md 模式） | ulpi-io `frontend-design-ui-ux` |
| `frontend-polish` | 前端审美规范 | anti-AI-slop：排版层级/间距节奏/色彩克制/杜绝模板味套路 | anthropics `frontend-design` + vercel `web-design-guidelines` |
| `design-critique` | 设计走查评审 | 布局/层级/对比度/状态/可达性清单式评审；配合浏览器截图工具实操（browser_screenshot + browser_snapshot）；走查细项清单拆 `references/` | oh-my-openagent `visual-qa` 模式 + Apple HIG 清单 |

### 5.4 全栈开发组（新增 2 + 升级 3）

| slug | 动作 | 名称 | 定位 | 灵感来源 |
|---|---|---|---|---|
| `tdd-workflow` | 新增 | TDD 工作流 | RED-GREEN-REFACTOR 循环；测试先行纪律；重构与测试分离 | obra/superpowers `test-driven-development` |
| `frontend-best-practices` | 新增 | 前端最佳实践 | 重渲染/组件组合/bundle 精选规则（组合优于配置、状态提升判据） | vercel `react-best-practices` + `composition-patterns` |
| `code-review` | 升级 | 代码审查 | 现有内容规范化：补四段式结构、触发短语、NEVER/ALWAYS | 现有 builtin skill |
| `write-tests` | 升级 | 测试编写 | 同上 | 现有 builtin skill |
| `debug-reproduce` | 升级 | 调试复现 | 同上 | 现有 builtin skill |

### 5.5 研发管理组（3 个）

| slug | 名称 | 定位 | 灵感来源 |
|---|---|---|---|
| `task-breakdown` | 任务分解与排期 | 目标 → 里程碑 → 可独立验收的任务粒度 + 依赖标注 + 风险清单；输出 Markdown 计划文档 | obra/superpowers `writing-plans` |
| `tech-design-review` | 技术方案评审 | 架构/边缘 case/性能/安全 checklist 式评审；评审清单拆 `references/` | mrwakayk `engineering-plan-review` |
| `sprint-reporting` | 周报与状态汇报 | 进展/风险/待决策三段式；配反 AI 腔纪律 | anthropics `internal-comms` |

### 5.6 文档办公组（4 个，全部对齐 office_* 工具）

| slug | 名称 | 定位 | 灵感来源 |
|---|---|---|---|
| `excel-analysis` | Excel 公式实战 | SUMIF/COUNTIF/VLOOKUP 套路；汇总页/图表页构建；公式重算语义；公式清单拆 `references/` | anthropics `xlsx` 方法论（选题借鉴） |
| `ppt-authoring` | PPT 汇报构建 | 大纲 → 每页信息层级 → 图表优先 → 模板填充决策（office_create_ppt vs office_fill_ppt_template） | anthropics `pptx` 方法论（选题借鉴） |
| `pdf-extraction` | PDF 提取与问答 | 结构化提取/跨文档比对/摘要整理（对齐 office_read 对 PDF 的读取） | anthropics `pdf` + chat-with-pdf（选题借鉴） |
| `doc-formatting` | Word 长文档排版 | 标题层级/目录/表格规范/样式一致性（对齐 office_create_doc） | anthropics `docx` 方法论（选题借鉴） |

## 6. 交付落位与接线

### 6.1 文件清单

| 交付物 | 位置 | 数量 |
|---|---|---|
| skill 目录 | `electron/resources/skills/<slug>/SKILL.md`（4 个含 `references/`：excel-analysis / design-critique / tech-design-review / frontend-polish） | 20（17 新增 + 3 覆盖升级） |
| agent manifest | `electron/resources/agents/<slug>.yaml` | 5（4 覆盖升级 + 1 新增 `ui-designer.yaml`） |
| catalog 条目 | `resources/marketplace/catalog.json` | 25（`agent-<slug>` 5 条 + `skill-<slug>` 20 条） |

### 6.2 生效链路（沿用现状机制，零代码改动）

- **Skill**：`listInstalled()` 扫描 `electron/resources/skills/`（打包后 `resourcesPath/skills`）→ builtin 即已装；agent 启用时经 `RuntimeSkillRef{slug, cachePath}` 注册进 SkillRegistry → `loadSkill` / `readResource` 虚拟工具三层渐进披露
- **Agent**：预置库 `listBuiltinPresetAgents()` 扫描 YAML 目录 → 用户点启用 → `enablePresetDef` → `readBuiltinManifestBySlug` 解析落库（`defaultSkills` 引用随 manifest 入库）
- **Catalog**：`fetchCatalog` → `listBuiltinResources` 过滤 `downloadUrl=""` 内联项 → 资源库 builtin tab 展示

### 6.3 catalog 条目规范

- id：`agent-<slug>` / `skill-<slug>`；`type`: `agent` / `skill`；`downloadUrl`/`checksum`: 空串（builtin 内联）
- `verificationStatus`: `official`；`author`: `Momo Studio`；`category` 按组：development（全栈）/ design（UI）/ product（需求）/ management（管理）/ productivity（办公，对齐 office-assistant 现值）/ general（通用）
- **readme 契约**：agent 条目的 readme 是 systemPrompt 的载体（builtin 内联项安装时从 readme 就地生成 manifest）——升级 agent 时 readme 必须与新 systemPrompt 关键词同步；office-assistant 的既有契约锁（`builtin-office.test.ts`：add_chart/SUMIF/fill/第一/office_read_cells/set_format/百分比/50 行/office_fill_ppt_template/模板/填充 等关键词三处一致）在微升级后必须保持全绿
- `readme` 放一句话简介（详情面板展示用）
- `updatedAt` 更新为 `2026-10-08T00:00:00Z`
- **修复漂移**：现有 catalog 仅登记 1 个 skill 条目（code-review-workflow）而目录有 3 个——本次 18 个 skill 条目与目录**一一对齐**，现有 code-review 条目的 slug 修正为 `code-review`（与目录一致），消除双轨漂移

## 7. License 与内容纪律

- **零复制原则**：所有 SKILL.md 与 agent prompt 均为原创中文内容；借鉴范围限「选题 + 结构模式」，任何来源的文本不逐句搬运
- 灵感来源已在上表逐条标注（来源 repo + 性质），spec 随附可审计
- 特别标注：anthropics 文档 skill（Source-available 私有）与 oh-my-openagent（SUL-1.0 非商用）为红线来源，仅选题级借鉴

## 8. 测试与验收

1. **manifest 解析**：5 个 agent YAML 全部通过 `parseAgentManifestWithSuggestion`（扩展 `electron/tests/agent/builtin.test.ts` 既有模式：逐文件解析 + 断言 slug/版本/defaultSkills）
2. **引用一致性**（新增测试，防契约漂移）：遍历全部 agent YAML 的 `defaultSkills[].ref`，断言每个 slug 在 `electron/resources/skills/` 目录存在
3. **catalog 对齐**（新增测试）：catalog 中 `downloadUrl=""` 的 skill 条目 slug 集合 ≡ skills 目录 slug 集合（锁死双轨同步，防回归）
4. **frontmatter 完整性**：全部 SKILL.md 的 `name`/`description` 非空，description 含触发场景描述
5. **整体验收**：`npx pnpm@9.0.0 typecheck` + 双 workspace 测试全绿；`npx pnpm@9.0.0 dev` 启动 → 预置库可见 5 个 agent → 启用 ui-designer → 会话中确认 skill 挂载（loadSkill 可用）

## 9. 风险与备注

- **内容撰写量大**（18 个 SKILL.md + 5 个 YAML）：建议按角色分批交付（先办公组 + UI 组打样价值最高，再开发/管理/需求组）
- **catalog 测试 fixture 联动**：`electron/tests/marketplace/client.test.ts:95` 硬编码本地 catalog 条目总数 `toBe(6)`——每批新增条目后同步更新（终态 26）；office-assistant 契约锁（`builtin-office.test.ts`）在 Task 7 后复跑验证
- **触发短语质量**决定渐进披露命中率：验收时人工抽检每个 skill 的 description（模拟用户提问 → 确认 loadSkill 被正确触发）
- 版本号纪律：本变更为特性内容新增，按 `docs/dev/release.md` 研发期策略不动产品版本号
