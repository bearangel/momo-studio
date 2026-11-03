# office-pro 插件：office 生成能力「代码工坊」化设计

- 日期：2026-11-03
- 状态：待评审
- 上游：`docs/specs/2026-09-18-office-agent-tools-design.md`（v1 office 工具集设计；本 spec 落地后其生成类能力条目由本 spec 取代，读取类继续有效）
- 范围裁定：本轮只做「方案 A：插件化代码工坊」。方案 B（主题引擎/双渲染）、方案 C（模板库升级）、渲染 QA 插件均不立项，仅预留演进位（§10）。

## 1. 背景与问题

实测会话「IT工作周报 PPT」双 agent 对比暴露两个现象：

1. 内置 office 工具集产出的 PPT 样式差（视觉词汇表只有「全宽色条 title bar + 页脚线」一种，字体/形状/主题硬编码）；
2. 要求 agent「参考 python-pptx 产出、用内置工具复刻」时，agent 直接弃用工具改走 bash + pip + python-pptx。

架构层面三个根因（证据链见上游 spec 与现行代码）：

- **根因 1：表达力天花板**。`office_create_ppt` 每页仅暴露约 10 个样式维度（5 种固定 layout、页级 accentColor、背景色、图片坐标、4 类图表）；字体零暴露、无任意形状/文本框、无全局主题、无母版。上游 spec §14.9 自认「复杂自由排版不支持」、§12 自认「重样式 PPT 需求走人工」，且明言「v1 是裁剪非库限制」。当任务是复刻任意设计时，工具在数学上无法表达目标，agent 弃用是理性行为。
- **根因 2：零先验**。LLM 对 pptxgenjs / exceljs / OOXML 有海量训练先验，对自研工具 schema 先验为零。业界对标：Anthropic 官方 pptx skill 让模型直接写 pptxgenjs 代码，理由原文「The model knows the API」；其 HTML→PPT 中间层（html2pptx）因抽象不完备已于 2026-02 废弃。上游 spec §14 四轮增强全部由「agent 外逃 Python」事件驱动——打地鼠式加参数从未触及根因。
- **根因 3：无视觉反馈回路**。工具只返回一句话摘要，agent 看不到产出，难看也无人发现。本轮不解决（属渲染 QA，P3），但设计不与之冲突。

叠加部署约束：目标用户含 IT 小白（机器无 Python/开发工具链）与内网环境（自建 LLM、无互联网，pip/npm 自动下载不可行）。现 bash 外逃路径在目标环境根本走不通。

另：2026-11-02「内置资源极简化」已删除 office-assistant 预置 agent 与 ppt-authoring 等 skill，office 引导层现状为零——本 spec 的 skill 组件即为其正式继任者。

## 2. 目标 / 非目标

**目标**

1. office 文档**生成**能力迁移至 `office-pro` 插件：`run_js` 沙箱代码执行工具 + `office-authoring` 方法论 skill + 预置 agent，三者一体交付。
2. 全程离线可用：运行时与库全部随插件分发，零网络依赖（沙箱网络固定禁用）。
3. 生成产物保留变更账本（可审计、可撤销）与 Read-before-Edit 门禁。
4. 核心内置 office 生成类工具下线（先立后破），读取类保留。

**非目标**

- 不做 Python 运行时整合（裁定见 §3.2）。
- 不做声明式工具的参数面扩展 / 主题引擎 / 引擎双渲染（方案 B）。
- 不做模板库与 `office_fill_ppt_template` 升级（方案 C，后续期另行立项）。
- 不做视觉渲染 QA（渲染插件，P3 演进位见 §10）。
- 不修改 bash 工具与既有 OS 沙箱策略语义。

## 3. 决策记录

### 3.1 为什么「代码工坊」优于「声明式工具增强」

- 表达力：代码路径表达力 = 库 API 全集（pptxgenjs 可控字体/形状/坐标/母版/图表细节），天花板直接消除根因 1；
- 先验：模型熟悉库 API，skill 只需补 footgun 与设计规范，学习成本从「学新 schema」降为「回忆已知 API」（消除根因 2）；
- 业界证据：Anthropic pptx skill（创建=pptxgenjs 代码 + skill 文档 + QA 闭环）为当前可观测的最优产出配方；Gamma（紧 schema + 主题引擎）与 Copilot（模板管控）分别代表方案 B/C，其产出上限受 schema/模板设计水平约束，且不解决「复刻任意设计」诉求。

### 3.2 为什么 Node 而不是 Python

- Electron 自带 Node 24 运行时，`ELECTRON_RUN_AS_NODE=1` 即得沙箱子进程，零分发成本；pptxgenjs / exceljs / docx / pdfkit 全部纯 JS 且已在技术栈验证。
- Python 需每平台打包 30–80MB 运行时 + C 扩展 wheel（lxml 等）+ macOS 签名/公正 + Windows 杀软误报处置，全部成本只换来与 Node 路线等价的能力；python-pptx 的差异化场景（编辑既有 deck）由轻量模板手术库覆盖（§5.2 预置库 `momo-pptx-zip`）。

### 3.3 为什么插件而不是核心内置

- 与 2026-11-02 极简化方向一致：核心只留无争议基础设施，能力包按需安装；
- 插件 manifest 的一等组件（tools / skills / agents）与 `vendor.archives`（sha256 校验的 vendored 大件机制）为本设计量身现成；
- 内网分发 = 插件包文件（U 盘/内网共享均可），迭代独立于核心发版。

### 3.4 读取类为什么留核心

读取不存在表达力问题：结构化文本输出是 token 最高效形态（Anthropic 配方同为「读走结构化、写走代码」）；`general-assistant` 默认挂载 `office_read`，属所有 agent 的基础感官，不应随能力包增减。

### 3.5 记账方案：声明式输出记账

现状事实：bash 写文件**不进**变更账本（账本是工具层机制，JournalEntry.toolName 域为 write_file / edit_file / apply_patch / rm / mv / undo 等工具级写入）。run_js 若不处理将弱于被替换的 office 写工具。

裁定采用「声明式输出记账」：调用方在参数中声明 `outputs`（workspace 相对路径数组）；工具层执行前逐文件取 before 字节（不存在记 create），执行后取 after 字节，经 `recordChangeSafe` 记账（toolName='run_js'）。未声明写入与 bash 对等（不记账、不可撤销）。理由：office 工作流的产出文件总是可预知的；全量 staging 提交模式（沙箱只写暂存区、工具层代为落盘）更严密但需改沙箱写剖面，收益/成本比不成立，列为 §10 演进位。

## 4. 总体架构

```
整改前                                整改后（先立后破）
─────────────────────────────       ─────────────────────────────
核心 builtin（9 工具）               核心 builtin（3 工具）
  读: office_read                   读: office_read
      office_read_cells                 office_read_cells
      office_copy                      office_copy
  写: office_create_ppt ✂
      office_create_excel ✂          插件 office-pro（生成能力唯一家）
      office_write_excel ✂             tools/run_js.js     沙箱代码执行
      office_create_doc ✂              skills/office-authoring/
      office_create_pdf ✂              agents/office-pro.yaml
      office_fill_ppt_template ✂       node_modules/       pptxgenjs 等
  资产: chart-xml.ts ➚ 迁插件          libs/               momo-chart 等
        pptx-zip.ts  ➚ 迁插件
```

✂ = 下线删除；➚ = 代码资产迁入插件预置库。

## 5. office-pro 插件设计

### 5.1 目录与 manifest

monorepo 新增顶层 `plugins/office-pro/`，构建产物为可安装插件包（复用 `publish-pack` 打包链）。结构：

```
plugins/office-pro/
  manifest.json          # components: tools / skills / agents
  tools/run_js.js        # createTools(ctx) → ToolModule（CJS）
  skills/office-authoring/SKILL.md
  agents/office-pro.yaml # 预置 agent 定义
  vendor/                # 预置库（见 §5.2）
    node_modules/        # pptxgenjs / exceljs / docx / pdfkit / adm-zip（锁定版本）
    momo-libs/           # momo-chart / momo-pptx-zip / momo-validate
  scripts/build.*        # 构建脚本（vendor 依赖安装 + 产物打包）
```

manifest 声明 `minAppVersion`；`vendor.archives` 机制本期不用（无平台二进制），为 P3 渲染插件预留先例。

### 5.2 run_js 工具

**接口（LLMToolDef）**

```json
{
  "name": "plugin:office-pro/run_js",
  "description": "在离线沙箱中执行 JavaScript 生成 office 文档。预置库：pptxgenjs/exceljs/docx/pdfkit/adm-zip + momo 系（原生图表/模板手术/结构校验）。无网络；仅 workspace 可写；产物文件必须在 outputs 中声明以便记账与撤销。",
  "inputSchema": {
    "type": "object",
    "properties": {
      "script":   { "type": "string", "description": "JS 源码（CommonJS，支持顶层 await 由 bootstrap 包裹）" },
      "outputs":  { "type": "array", "items": { "type": "string" }, "description": "产物 workspace 相对路径列表（记账与撤销依据，强烈建议必填）" },
      "timeout_ms": { "type": "number", "description": "默认 120000，上限 300000" }
    },
    "required": ["script"]
  }
}
```

script 上限 64KB；outputs 每项经 `wsFs.assertInWorkspace` 校验（拒 `..`/绝对路径/符号链接逃逸）。

**执行模型**

1. 前置：outputs 已存在者过 Read-before-Edit 门禁（`readTracker.assertRead`，与 edit_file 同语义）；逐文件取 before 字节。
2. spawn：`process.execPath + ELECTRON_RUN_AS_NODE=1` 运行插件 `bootstrap.js`，argv 携带（workspaceDir、script 落盘路径、vendor 路径）。script 由工具层落盘到 workspace 外临时目录后传入，不进命令行。
3. 沙箱包裹：sandbox 模块新增 `resolveSandboxedSpawn(argv)` 变体——复用现有 `buildPolicy`（workspaceDir 可写 / 敏感路径遮盖 / **networkEnabled 恒 false**）与 seatbelt / bwrap 平台渲染，区别仅为「包裹任意 argv」而非 `bash -c`。run_js 不消费 bash 的动态网络授权：office 生成不需要网络，固定 net-off。macOS/Linux 得到 OS 级隔离；Windows 无 OS 沙箱，走 plain spawn（与 bash 现状对齐，补偿控制见 §7）。
4. env 白名单：复用 bash 的 `buildSandboxEnv`（白名单外环境变量不传入）。
5. bootstrap 职责：注入 vendor 库解析（`NODE_PATH` 或模块路径重写，`require('pptxgenjs')` 等固定名称可用）；执行 script（包裹为 async 入口捕获顶层 await 与未捕获异常）；退出码协议（0 成功 / 非 0 失败并透传 stderr）。
6. 收尾：stdout/stderr 截断（对齐既有 OUTPUT_LIMITS 量级）；outputs 逐文件取 after 字节并 `recordChangeSafe`（create/modify，toolName='run_js'）；返回文本 = 退出码 + 截断后的 stdout/stderr + 记账结果行（`已记账: weekly.pptx (create)` / `未声明产物不记账` 提示）。

**中断与超时**：监听 `ctx.abortSignal`；POSIX `detached` + `kill(-pgid)` 杀进程组，Windows `taskkill /T /F`（对齐 bash 语义）；timeout 到点同路径强杀并在返回文本标注超时。

**预置库清单（vendor，版本锁定进插件）**

| 模块名 | 来源 | 说明 |
|---|---|---|
| pptxgenjs / exceljs / docx / pdfkit / adm-zip | npm 锁定版本 | 生成四件套 + zip 基础设施 |
| momo-chart | 迁自 `electron/src/main/agent/tools/office/chart-xml.ts` | 自研 xlsx 原生图表 XML 注入——纯 JS 生态唯一原生图表方案（上游 spec §14.1 论证无替代），删除核心写路径后此差异化能力由 run_js 环境延续 |
| momo-pptx-zip | 迁自 `office/pptx-zip.ts` | pptx 模板字节级手术（占位替换、关系保真）——`office_fill_ppt_template` 下线后其能力以库形态保留，agent 代码可直接调用；也是 P2 模板路线的底座 |
| momo-validate | 新写（轻量） | 产物结构校验：zip 完整性 + XML well-formed + 关键部件存在性（[Content_Types].xml / ppt/slides 关系链）。Anthropic validate.py 的 JS 简化版 |

### 5.3 office-authoring skill

`skills/office-authoring/SKILL.md`，内容骨架（对标 Anthropic pptx skill 配方，本地化到本沙箱现实）：

1. **能力地图与路径决策**：读内容 → `office_read`/`office_read_cells`；生成/改造 → `run_js`；需要企业模板时向用户索取 .pptx 并用 `momo-pptx-zip` 做手术而非从零仿制。
2. **pptxgenjs 速查与 footgun 清单**（本地化）：hex 色值不带 `#`；字距参数是 `charSpacing` 不是 `letterSpacing`；options 对象会被原地 mutate（勿复用）；stacked 图表禁 `dataLabelPosition:'outEnd'`（损坏文件）；双轴图必须 `valAxes`+`catAxes` 成对；输出路径用 workspace 相对路径并声明进 outputs。
3. **exceljs + momo-chart**：数据/格式分离写法；原生图表注入流程（写盘后 zip 手术阶段）。
4. **docx / pdfkit 速查**：section 结构、pdfkit 中文内嵌字体（Noto Sans SC 迁入 vendor）。
5. **设计规范**（反「AI 味」红线，源自业界配方本地化）：禁标题下装饰线、禁无意义色条色块；每页一个主张；字号阶梯与留白常量；配色从内容主题推导而非默认深蓝。
6. **QA 自查**：产物必跑 `momo-validate`；文本溢出启发式（字数 × 字号 × 版心宽估算超限即减字或缩号）；outputs 声明齐全再收工。
7. **沙箱现实**：无网络（报错别重试联网方案）、预置库清单、超时预算、大数组分批写。

skill 与 vendor 库版本同插件锁版发布（footgun 清单与库行为不漂移）。

### 5.4 预置 agent

`agents/office-pro.yaml`：

- 名称建议「文档工程师」（slug `office-pro`）；
- `defaultTools`：`office_read` / `office_read_cells` / `office_copy` / `plugin:office-pro/run_js` + 与 general-assistant 对齐的基础文件读写面（最终清单在实施计划中对齐 capability-merger 的三层合并语义后敲定）；
- **不挂 bash**：能力自足防外逃，且保证「office-pro agent vs bash agent」对比实验变量干净；
- `defaultSkills`：`office-authoring`。

## 6. 核心侧下线（先立后破，验收通过后执行）

### 6.1 处置清单

| 工具 / 文件 | 处置 |
|---|---|
| office_read / office_read_cells / office_copy | 保留（`office-tools.ts` 读取分支 + 底层读取函数） |
| office_create_ppt / office_create_excel / office_write_excel / office_create_doc / office_create_pdf / office_fill_ppt_template | 删除（DEF + execute 分支 + 生成路径代码） |
| office/pptx.ts | 生成侧删除；若 `office_read` 的 pptx 文本提取依赖其常量则拆分保留读取侧 |
| office/excel.ts、docx.ts、pdf.ts | 按「读留写删」拆分（office_read 依赖 mammoth/exceljs/pdfjs 读取路径） |
| office/chart-xml.ts、pptx-zip.ts | 整体迁出至插件 `vendor/momo-libs/`（TS 源迁入插件构建，产物 JS 随包分发） |
| office/format.ts、xlsx-zip.ts | 随读取侧保留的部分留下；仅被写路径消费的部分随迁 |

精确文件级拆分在实施计划中逐文件列出并配 typecheck 锁。

### 6.2 目录与契约锁调整

- `ALL_BUILTIN_TOOLS` 与 ToolCatalog 更新（office 生成类条目移除，Tier 2 类目瘦身）；
- `builtin-office.test.ts`：读取工具 description 契约锁保留；生成工具锁随代码删除；
- electron 主包依赖清理：pptxgenjs / docx / pdfkit 等仅被写路径使用的依赖从 `electron/package.json` 移至插件 vendor（exceljs/mammoth/pdfjs-dist 若读取侧仍用则留）。

### 6.3 存量引用失效处理

生成类工具本为 Tier 2（defaultOn=false）且 2026-11-02 后无预置 agent 引用，存量面仅剩用户手动勾选的自定义 agent。处理：capability-merger 合并时过滤失效 ref + 启动日志 warn（`defaultTools 引用了已下线工具: office_create_ppt`），不做数据迁移。

## 7. 安全模型

- **平台矩阵**：macOS（seatbelt wrapped）/ Linux（bwrap wrapped）/ Windows（plain + 补偿控制）——与 bash 完全同基线。
- **网络**：run_js 固定 net-off（不消费动态网络授权）；wrapped 模式下出网/监听在 OS 层必败，返回文本携带 `net-off` tag 供 LLM 自诊。
- **文件系统**：workspace 越界防御三层——outputs 参数 `assertInWorkspace` 校验；bootstrap 层 fs 路径守卫（写操作限制 workspaceDir + os.tmpdir，全平台生效，Windows 的主要补偿控制）；OS 沙箱（macOS/Linux）。
- **进程**：超时强杀进程组（detached + kill(-pgid) / taskkill /T /F）；abortSignal 即时中断；script 64KB 上限防上下文炸弹。
- **输出**：stdout/stderr 截断上限，防输出炸弹。
- **审计**：toolSourceFor 既有机制自动标注 `source:'plugin'`；outputs 记账条目含 before/after hash，可撤销。

## 8. 时序与里程碑（先立后破）

| 里程碑 | 内容 | 出口条件 |
|---|---|---|
| M1 沙箱扩展 | `resolveSandboxedSpawn(argv)` + buildPolicy net-off 固定变体 | sandbox 单测通过（三态 × 平台矩阵） |
| M2 插件主体 | plugins/office-pro 骨架 + run_js（bootstrap/vendor/记账/中断）+ momo-libs 迁移构建 | run_js 单测：生成四格式产物、记账、越界拒绝、超时杀组、abort 生效 |
| M3 引导层 | office-authoring skill + office-pro 预置 agent | skill 加载与 agent 装配冒烟通过 |
| M4 验收与下线 | §9 验收全过 → 执行 §6 下线 | 验收清单全绿 + 核心测试套件回归通过 |

M1–M3 期间核心 office 工具原样运行（新旧并存但互不引用）；M4 才删除。

## 9. 验收标准

1. **复刻质量**：以「IT工作周报」python-pptx 产出为参照，office-pro 预置 agent 用 run_js 复刻出同类样式 PPT，与旧 office_create_ppt 产出双盲人工对比显著占优（评审人不知产出来源）。
2. **断网全流程**：net-off 沙箱 + 无外网环境下，从空白到 .pptx / .xlsx（含 momo-chart 原生图表）产出成功，全程无 pip/npm/网络调用。
3. **不外逃**：预置 agent（无 bash）独立完成生成任务；会话中不出现「下载/安装依赖」行为。
4. **安全**：`../` 越界与绝对路径写被拒；net-off 下出网尝试失败且返回自诊信息；超时进程组被杀；>上限 stdout 被截断；abortSignal 中止即时生效。
5. **记账**：outputs 产物在变更账本可见（before/after hash），undo 可还原；未声明写不入账（与 bash 对等）。
6. **存量兼容**：引用已下线工具的自定义 agent 启动不崩，日志出现失效提示。

## 10. 风险与演进位

**风险**

- 弱自建模型写代码质量不稳 → skill 提供可抄的最小可运行模板片段（PPT/Excel/PDF 各一）；真实效果在 M4 验收暴露，若不可接受则提前启动方案 B/C 组合的立项评审。
- 上下文消耗上升（代码 token 多于声明式参数）→ skill 教「小脚本分步跑、产物即时校验」习惯；run_js 返回值截断纪律。
- footgun 清单与 pptxgenjs 版本漂移 → 库版本锁定插件内，升级 = 插件发版（skill 同步修订）。
- Windows 无 OS 沙箱 → 与 bash 同基线（既有接受面），bootstrap fs 守卫 + env 白名单补偿；插件 README 明示。

**演进位（本轮不做，设计已预留）**

- P3 渲染 QA 插件：manifest `vendor.archives`（file + sha256 + probe）携带 LibreOffice，装了即启用真渲染视觉自查，核心包零增重。
- 全量 staging 记账：沙箱写剖面改「仅暂存区可写」，工具层代为落盘，消灭未声明写不记账的缺口。
- P2 模板路线：`momo-pptx-zip` 已就位，补「官方主题模板 N 套 + 预置 agent 模板工作流」即可立项。

## 11. 开放问题（实施计划需回答）

1. 预置 agent `defaultTools` 的最终清单——需先核对 capability-merger 三层合并中 defaultTools 是「全量显式」还是「增量叠加」，以 general-assistant.yaml 为准对齐。
2. 插件构建链细节：vendor 依赖的离线安装（pnpm lockfile → 插件包内 node_modules 的固化方式）、momo-libs 的 TS→JS 构建产物形态。
3. `office_read` 对 pptx 的文本提取若与 pptx.ts 生成侧共享常量/工具函数，拆分边界在实施计划逐文件列明。
