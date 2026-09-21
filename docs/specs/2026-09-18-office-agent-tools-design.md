# 办公文档工具组（OfficeTools）设计

- 日期：2026-09-18
- 状态：定稿（已过需求澄清与方案选型，待实施）
- 范围：Momo Studio v2.1 特性——agent 运行时第 12 个工具模块 OfficeTools（Excel / Word / PPT / PDF 读取与生成）+ 内置办公助理 agent
- 上游依据：`docs/specs/2026-08-23-v2.0.0-platform-refactor-design.md`（工具体系 / 变更账本 / 沙箱）

---

## 1. 背景与目标

Momo Studio 的 agent 工具面目前覆盖代码域（file / git / lsp / shell / browser…），不能读写日常办公文档。用户希望 agent 能处理 ppt / excel / word 等文档的日常任务：文档问答与总结、按规则运算多份 Excel 产出新表、撰写申请书 / 报告并按用户提供的参考模板重写、复制既有报表追加汇总页签等。

目标：把办公文档处理做成**平台原语**（内置工具组），任何 agent（含用户自建）可用，完整继承沙箱、Read-before-Edit、变更账本、权限、审计五层安全设施；同时预置一个开箱即用的「办公助理」内置 agent。

## 2. 需求裁定（澄清记录）

| 维度 | 裁定 |
|---|---|
| 操作范围 | **读取 + 生成**。docx / pptx / pdf 为生成式（不做段落级精确编辑、不做格式转换）；**Excel 例外含增量写**（add_sheet / set_cells 改已有文件）——计算型场景刚需，见下行 |
| 格式范围 | **xlsx / docx / pptx / pdf 四件套**（读写都做） |
| 模板能力 | **通用能力、按对话流按需采用**：用户随时提供模板文件，agent 读取其内容与结构后模仿产出——不建预置模板系统、不引入占位符填充机制。典型流：初稿 → 用户不满意 → 用户给模板 → agent `office_read` 模板 → 按其结构重新生成 |
| Excel 特性 | 计算型读写：读多份 → 按用户规则运算 → 创建新表或写入新 sheet；需要 **sheet / 行 / 单元格级增量写**，不能只有整文件一次性生成 |
| 写作流 | 迭代式：产出 → 反馈 → 重写，工具支撑反复覆盖生成（过 Read-before-Edit 守门） |
| 交付物 | 工具组 + 内置 office-assistant agent（不预置示例模板资源） |

## 3. 方案选型

三个候选路径：

- **A（采纳）：单一 `OfficeTools` 模块 + 纯 JS 库族**。一个 ToolModule、`office_*` 前缀工具族，内部按格式拆 helper 文件；新增 6 个纯 JS 依赖；写入全继承平台安全设施。
- B（否决）：四格式四个独立 ToolModule。office 是单一域，拆四份让注册中心 / handles 路由 / 测试翻倍，且四格式均无条件启用，无条件注册收益。
- C（否决）：外挂 MCP server。失去沙箱 / 账本 / 权限 / 审计集成（写文件不可撤销）、stdio 进程开销、与开箱即用目标冲突；仅当未来要向非 Momo 用户分发时再评估。

## 4. 总体架构

### 4.1 模块布局

```
electron/src/main/agent/tools/
  office-tools.ts            # ToolModule 实现：getDefs + handles + execute 路由 + 记账/守门接线
  office/
    format.ts                # 扩展名嗅探、A1 range 解析、输出预算常量
    excel.ts                 # exceljs 读写封装（read / readCells / create / write / copy 落盘）
    docx.ts                  # mammoth 读 + docx 库生成
    pptx.ts                  # pptxgenjs 生成 + adm-zip/cheerio 读取（零新依赖自解析）
    pdf.ts                   # pdf-parse 读 + pdfkit 写（CJK 字体注册）
```

注册：`tools/index.ts` 的 `buildToolRegistry` 数组追加 `new OfficeTools()`（无条件注册，与 FileTools / GitTools 同列，成为第 12 个模块）。权限 / 审计仍在 runtime-entry 入口统一前置，注册中心不做。

### 4.2 新增依赖（全部纯 JS、无 native binding）

| 库 | 用途 | 备注 |
|---|---|---|
| `exceljs` ^4 | xlsx 读写 | cell / sheet / 公式级操作 |
| `docx` ^9 | docx 生成 | heading / para / list / table |
| `mammoth` ^1 | docx 读取 | 转 markdown，保结构丢样式 |
| `pptxgenjs` ^3 | pptx 生成 | 标题+内容+表格+备注版式 |
| `pdfkit` ^0.15 | pdf 生成 | 需内嵌 CJK 字体（§9） |
| `pdfjs-dist` ^3.11 | pdf 读取 | 官方库 legacy/UMD build（CJS 主进程直用）；`getTextContent` 逐页文本提取，纯 JS 零 native。（2026-09-18 裁定：弃 pdf-parse——v2 硬依赖 @napi-rs/canvas 原生 Skia 二进制，违反纯 JS 约束） |

pptx 读取不自加依赖：pptx 是 zip 容器，slide XML 的 `<a:t>` 文本用现有 `adm-zip` + `cheerio` 提取（仓库既有依赖）。

### 4.3 明确不支持

旧二进制格式 `.xls` / `.doc` / `.ppt`：报错并提示先另存为新格式。`.xlsx` / `.docx` / `.pptx` / `.pdf` 之外扩展名一律「不支持的格式」。

## 5. 工具面契约（8 个工具）

通用口径（全部工具）：

- 路径一律相对 workspace，先过 `ctx.wsFs.assertInWorkspace`
- 读工具成功后 `ctx.readTracker?.add(ctx.streamSessionId, absPath)`
- 写工具目标已存在 → `ctx.readTracker?.assertRead(...)` 后覆盖（与 write_file 覆盖同口径；子 agent fresh-session 语义照旧继承）；不存在 → 直接建
- 写工具落盘前经 `buildRecordCtx('office_*', ctx)` + `recordChangeSafe` 记账（§6.3）
- assertRead 抛错文案硬编码 read_file，office 写工具 catch 后重抛补充「可用 office_read 读取」指引

### 5.1 读取类

**`office_read(path)`** — 按扩展名嗅探，输出结构化文本：

| 格式 | 输出 |
|---|---|
| xlsx | 每 sheet 一节：`## Sheet: <名> (<行>×<列>)` + 前 20 行 × 前 12 列 markdown 表格预览（超宽省略提示）；空 sheet 显式标注；sheet 数多时逐 sheet 截断 |
| docx | mammoth → markdown（标题层级 / 段落 / 列表 / 表格 / 图片占位标注） |
| pptx | `## Slide N` + 逐文本框段落 + 备注前缀；逐 slide 截断 |
| pdf | `## 第 N 页` + 页文本；无文本层（扫描版）→ 报错提示 |

输出预算：`OUTPUT_LIMITS` 新增 `office_read` 条目（沿用 truncateString），超限提示改用 `office_read_cells` 精读。

**`office_read_cells(path, sheet, range?, formulas?)`** — Excel 精读：

- `sheet`：sheet 名或 1-based 序号
- `range`：A1 记法（如 `A1:F50`）；省略 = 该 sheet 已用区域；行上限 500、列上限 64，超限报错（防上下文撑爆）
- `formulas: true` → 公式单元格显示 `=<原文>`
- 返回 markdown 表格

### 5.2 生成类

**`office_create_excel(path, sheets?)`** — 建新 xlsx。`sheets: [{name, headers?}]`（headers 写首行列头）。只建骨架，数据统一走 `office_write_excel`（单一写路径）。已存在 → assertRead 覆盖（记账 op=modify）；新建 op=create。

**`office_write_excel(path, ops)`** — 增量写已有 xlsx：

```jsonc
ops: [
  { "op": "add_sheet", "name": "汇总" },
  { "op": "set_cells", "sheet": "汇总", "range": "A1", "values": [[...], [...]] }
]
```

- 文件必须已存在且已读（assertRead 强制）
- `set_cells.values` 二维数组，元素 `string | number | boolean | null | {formula: string}`
- `range` 两种语义：给**左上角单格**（如 `A1`）→ 按 values 形状向右下展开，不校验；给**完整区域**（如 `A1:F50`）→ 区域行列数必须与 values 形状一致，否则报错。省略 `range` 等价 `A1`
- sheet 不存在 → 报错（须显式 add_sheet，防误建）；一次工具调用记一条 modify（before=原文件字节，after=新文件字节）
- 内部流程：exceljs load → 逐 op 内存变更 → buffer 落盘（一次 IO）

**`office_create_doc(path, sections)`** — sections 元素四型：

- `{type: 'heading', level: 1..4, text}`
- `{type: 'para', text}`
- `{type: 'list', items: string[], ordered?: boolean}`
- `{type: 'table', header: string[], rows: string[][]}`

**`office_create_ppt(path, slides)`** — slides 元素：

- `{title, bullets?: string[], table?: {header, rows}, notes?: string}`
- 每页一版式：title + bullets 或 title + table；第一页 title 幻灯片（仅标题时）

**`office_create_pdf(path, blocks)`** — blocks 元素五型：heading / para / list / table / pagebreak。pdfkit 渲染，字体见 §9。表格为简单网格线样式，均分列宽。

### 5.3 辅助类

**`office_copy(from, to)`** — 复制任意受支持格式文件。from 必须存在且为支持格式；to 已存在 → assertRead 覆盖；to 侧记账（新建 create / 覆盖 modify）。返回提示「可用 office_write_excel 增量写副本」。

## 6. 安全模型

### 6.1 继承项（零接线）

- **沙箱**：`wsFs.assertInWorkspace`（拒 `..` / 符号链接逃逸）
- **权限**：`ToolPermissionConfig` 名单制天然支持 `office_*` 通配（allow/deny 后缀匹配）
- **审计**：runtime-entry 全量工具调用审计，office 无需特殊处理

### 6.2 Read-before-Edit

`office_read` / `office_read_cells` 成功后 add；五个 create/copy 工具目标存在时 assertRead；`office_write_excel` 恒 assertRead。

### 6.3 变更账本二进制扩展（本设计唯一跨模块改动）

现状：`journal/recorder.ts` 的 `recordChange` before/after 与 blob 均为 utf-8 文本语义（`hashContent(content: string)`、`writeBlob(workspaceId, hash, content: string)`）。office 文档是二进制 zip，按文本记账会导致撤销恢复写坏文件。

改动面（`string | Buffer` 泛化，既有 string 调用方零变化）：

1. `recorder.ts`：`hashContent` / `recordChange` / `assembleEntry` 的 before/after 泛化 `string | Buffer`（string 一律 `Buffer.from(s, 'utf-8')` 后统一处理）
2. `store.writeBlob`：落盘改 Buffer IO（文本 blob 是字节子集，utf-8 round-trip 无损，既有 blob 兼容读取）
3. blob 读取双 API：`readBlob` 保留 utf-8 文本返回（IPC 视图用），新增字节版（撤销恢复用）
4. `revert.ts`：恢复文件内容改字节 IO
5. `JournalEntryView.beforeText/afterText`：utf-8 严格解码，含非法序列 → null（UI 显示「二进制内容」）
6. 记账失败不阻塞工具执行的 `*Safe` 降级铁律照旧（`change-journal.ts` 不动语义，office 写工具复用）

按 momo-boundary-rules 要求：文本 round-trip 契约测试锁死不回归 + 二进制 round-trip 新增用例。

## 7. 输出预算与中断

- `OUTPUT_LIMITS` 新增：`office_read`、`office_read_cells` 条目，复用 truncateString / truncateArray
- 大 Excel 两级读取：预览（office_read）+ 精读（office_read_cells），不整表倾倒
- `abortSignal`：工具入口与逐 sheet / 逐 slide 循环点检查，signal 触发即清理并 resolve「已中断」（对齐 bash / webfetch 先例）

## 8. office-assistant 内置 agent 交付

三处联动（沿用既有 builtin 双轨机制）：

1. **`electron/resources/agents/office-assistant.yaml`**：`spec.type: standalone`（无父子，参照 coder 但不挂 pm-agent）；model 预填 anthropic / claude-3-5-sonnet（仅 UI 建议，不落库）；defaultTools = office 八工具 + read_file / list_files / exists / webfetch / todowrite；systemPrompt 覆盖策略：选格式 → 先读用户提供的参考（office_read）→ 分步写（create 骨架 + write 数据）→ 告知输出路径与后续可迭代方式
2. **`resources/marketplace/catalog.json`**：新增 `agent-office-assistant` 条目（category: productivity，无 downloadUrl 内联包；readme 即 systemPrompt 载体，与既有条目同构）
3. **工具全集同步**：`ALL_BUILTIN_TOOLS`（crud.ts / installer.ts 消费）追加 8 个 office 工具；新增一条 migration（沿用 v32 追加 apply_patch 模板）把 office_* 追加到既有 builtin 来源 agent 的 defaultTools（若缺失），保证存量安装与 YAML 全集一致

## 9. PDF CJK 字体打包

- pdfkit 默认字体（Helvetica 等）不含 CJK，中文会渲染为乱码 → 必须注册中文字体
- 打包 **Noto Sans SC Regular 单字重 TTF**（TrueType outline 版本；pdfkit 不支持 CFF/OTF）至 `electron/resources/fonts/`，electron-builder `extraResources` 增加映射（生产 `process.resourcesPath/fonts/`，dev 走 `__dirname` 相对回退，与 agents 目录解析同模式）
- 字体缺失（安装损坏）→ `office_create_pdf` 明确报错；其余三格式文本存 XML 由打开端渲染，无字体问题
- 包体代价约 +10MB，可接受；字体子集化留作后续优化

## 10. 错误处理

| 场景 | 行为 |
|---|---|
| 不支持扩展名 / 旧格式 | 明确报错 + 指引（.xls/.doc/.ppt 提示先另存新格式） |
| 文件损坏（zip 解析失败 / pdf 解析失败） | 报「文件损坏或非预期格式」 |
| range 非法 / 超上限 | 报错并说明上限（500 行 / 64 列） |
| 扫描版 PDF（无文本层） | 报「无文本层（疑似扫描版）」 |
| sheet 不存在（write） | 报错，指引显式 add_sheet |
| 未读先写 | assertRead 抛错 + office_read 指引文案 |
| 越界路径 / 符号链接逃逸 | wsFs 抛错（既有语义） |

错误路径全部要求专项测试用例（研发红线）。

## 11. 测试策略

位置：`electron/tests/agent/tools/office/`（镜像 src 结构）；账本二进制用例放 `electron/tests/journal/`。口径（momo-test-rules）：仿真真实运行时语义，不 mock 库本身。

1. **读写 round-trip**：每格式 create → 磁盘真实文件 → 用对应库 / 解 zip 重读断言内容；exceljs 写公式重读断公式原文
2. **账本二进制**：modify 二进制 → revert → `Buffer.equals` 字节级一致；既有文本 round-trip 契约锁不回归
3. **readTracker 接线**：office_read 后 write_excel 过门；未读先写抛错；子 agent fresh 语义
4. **沙箱**：`..` 越界、符号链接逃逸用例
5. **错误路径专项**：§10 全表逐项
6. **office_copy**：copy 后 write_excel 闭环（用户核心场景回归锁）
7. **pptx 自解析**：构造含多 slide / 备注的 pptx（pptxgenjs 生成），断言逐 slide 文本提取
8. **office-assistant YAML**：解析通过 + defaultTools 引用的工具名全部真实存在（防契约漂移）

## 12. 已知边界与非目标

- pptxgenjs 简单版式：无母版继承 / 复杂排版；「参考模板」只能模仿内容结构，不能复刻样式。重样式 PPT 需求明确告知用户走人工
- mammoth 读 docx 保结构（标题 / 列表 / 表格）丢样式（字体 / 颜色 / 版式）
- 样式级写入（单元格底色 / 字体 / 幻灯片母版）仍为二期候选；**原生 Excel 图表已落地（§14，2026-09-19 增补）**
- 精确编辑已有 docx / pptx（段落替换等）不在第一期（Excel 有增量写因为计算型场景刚需）
- 格式转换（如 docx→pdf）不在第一期
- `.xls` / `.doc` / `.ppt` 旧格式不支持
- pdfjs-dist 直用（无 pdf-parse 封装层）：worker 走 Node fake-worker 路径，`verbosity: 0` 压制噪声；仅用 getTextContent（不触渲染），无需 canvas

## 13. 实施切分建议（供实施计划参考）

1. **P1 账本二进制扩展**（journal 泛化 + revert 字节化 + 契约测试）——独立可验收，先行铺路
2. **P2 Excel 全链路**（read / read_cells / create / write / copy + 守门记账接线 + round-trip 测试）——用户核心场景闭环
3. **P3 docx / pptx / pdf 生成与读取**（含 pptx 自解析 + PDF 字体打包）
4. **P4 office-assistant 交付三联动**（YAML + catalog + ALL_BUILTIN_TOOLS + migration）+ 全量回归

## 14. 原生 Excel 图表（v2.1 增补，2026-09-19 裁定：内网用户关键能力）

### 14.1 背景与定位

真实用户场景（会话 2026-09-18）：「销售明细 + 图表页签」——office 工具无图表能力，agent 只能外逃 Python+openpyxl，而内网/无网办公机器上该路径不存在。纯 JS 生态无可写原生 xlsx 图表的成熟库（exceljs 明确不支持），故**自研 chart XML 注入**：exceljs 序列化后用 adm-zip 后处理注入 chart/drawing 部件，零外部依赖。可行性已由 PoC 验证（openpyxl 完整识别注入结果：类型/引用/缓存/轴全对；两处 XML 陷阱已排雷——drawing 根需声明 xmlns:r、graphicFrame 必须显式闭合）。

### 14.2 op 设计（office_write_excel 第三 op）

```jsonc
{ "op": "add_chart",
  "sheet": "汇总图表",            // 图表所在页签（须已存在）
  "type": "bar" | "bar_h" | "line" | "pie",
  "anchor": "A16",               // 左上角 A1 记法；默认尺寸 8 列 × 15 行
  "size": { "cols": 12, "rows": 20 },  // 可选覆盖
  "title": "月度销售趋势",         // 可选
  "categories": { "sheet": "汇总", "range": "A2:A10" },   // 类别轴区域引用
  "series": [ { "name": { "sheet": "汇总", "range": "B1" },  // 可选：单元格引用或字面量串
                "values": { "sheet": "汇总", "range": "B2:B10" } } ]
}
```

规则：
- bar/bar_h/line 支持 1..N 序列；**pie 恰 1 序列**（多序列报错）
- 数据一律**区域引用**（活引用：Excel 中改单元格图表跟随刷新）；字面量数组不支持——报错文案指引「先 set_cells 写数再引用」（agent 工作流）
- **缓存值**：注入时从内存 workbook 读区域值写 numCache/strCache——任何查看器免重算直接渲染；引用与缓存由实现同源填充，不会漂移
- 序列名：区域引用（strRef）或字面量串；省略则 Series N
- 目标 sheet 已有 drawing 部件（既有图表/图片）→ 锚点**合并进既有 drawing**（一 sheet 仅允许一个 drawing 部件，另起第二个会损坏文件）

### 14.3 实现架构

```
office/chart-xml.ts   纯函数 XML 生成器：buildChartXml（bar/bar_h/line/pie + 轴 + 序列 + 缓存）
                      buildDrawingAnchor（twoCellAnchor 片段，editAs=oneCell）
                      模板以 2026-09-19 PoC 验证版为基准（openpyxl 识别通过）
office/xlsx-zip.ts    zip 注入与保真：注入 chartN/drawingN 部件 + sheet↔drawing↔chart rels 接线
                      + [Content_Types] Override；**既有部件快照/回注**（见红线）
excel.ts              add_chart op 解析与编排：exceljs 应用数据 ops → 读区域值生成缓存
                      → writeBuffer → zip 后处理注入
```

- 注入必须在 exceljs `writeBuffer` **之后**（exceljs 重建 zip 会丢未知部件）
- **既有图表保真（红线）**：写路径 load 前净化（P0 机制）会剥 drawing/chart——`office_write_excel` 必须先**快照**既有 chart/drawing 部件及全部接线（rels/ContentTypes/sheet 标签），ops 序列化后**原样回注**再叠加新图表。「复制带图表报表加汇总页签」为验收用例（图表部件数不减）
- 读取侧不变：office_read 净化剥离 + 「文件含 N 个图表/图形部件」提示（P0 已落地）

### 14.4 错误路径

series 空、pie 多序列、range 非法、sheet 不存在（沿用 add_sheet 指引）、anchor 非法——各专项中文文案与用例。

### 14.5 验收

1. 结构断言（vitest，纯 JS）：zip 部件齐、rels 图闭合、ContentTypes Override 齐、chart XML 关键节点（c:barChart/c:lineChart/c:pieChart、c:ser、c:f、numCache/strCache 值）
2. **真实消费方验证（controller 终验）**：openpyxl `load_workbook` 写出文件 → `_charts` 数量/类型/引用/缓存逐项断言（PoC 同款）
3. 保真回归：带图表文件（P0 fixture）→ copy → write_excel 加汇总 → 部件数不减、既有 chart XML 字节不变
4. office-assistant systemPrompt 与 WRITE_EXCEL_DEF 描述同步图表能力

### 14.6 缓存刷新与公式语义（2026-09-21 增补，源自真实会话验收）

**缺口回顾**：真实会话（2026-09-21）暴露两个缺口——① 汇总数字由 agent 上下文心算，60 行 × 4 维 16 组全错（正解是 SUMIF 公式引用明细，但 add_chart 当时不容忍公式单元格）；② set_cells 修改被图表引用的区域后，既有图表缓存不刷新（字节级快照回注不感知引用变更），agent 被迫外逃 Python 修缓存。

**裁定三项**：

1. **公式优先工作流（P1c）**：汇总/统计类结果一律用公式（SUMIF/COUNTIF/SUMPRODUCT 引用明细区域）写入，不在上下文心算大量数字——结果由 Excel 计算保证正确。office-assistant 提示词与 WRITE_EXCEL_DEF 描述同步此指引。
2. **公式单元格缓存语义（P1b）**：add_chart 的 values/categories 区域容忍公式单元格——有缓存 result 用 result，无缓存（新写公式）该点 **omit**（c:pt 省略、ptCount 保持区域全长）；纯文本等非法值仍报错。Excel 打开后自动计算并回填，轻量预览器显示留空（诚实优于错值）。
3. **写路径缓存重算（P1a）**：`office_write_excel` 每次写盘时对**全部既有图表**做缓存重算——按 chart XML 的 `c:f` 引用从内存 workbook（已应用本批 ops）重读区域值重建 numCache/strCache。消灭「改数后图表缓存陈旧」及由此引发的 python 逃逸。新注入图表的缓存在 add_chart 时点已同源正确，无需重算。
