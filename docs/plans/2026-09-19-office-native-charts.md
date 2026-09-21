# 原生 Excel 图表（add_chart）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `office_write_excel` 新增 `add_chart` op——bar / bar_h / line / pie 四型原生 Excel 图表，adm-zip 后处理注入，零外部依赖；既有图表部件写路径保真。

**Architecture:** 纯函数 XML 生成器（chart-xml.ts，模板以 2026-09-19 PoC 验证版为基准）+ zip 注入/快照回注模块（xlsx-zip.ts）+ excel.ts 编排（exceljs 数据 ops → 区域值缓存 → writeBuffer → 注入）。注入必须在 writeBuffer 之后（exceljs 重建 zip 丢未知部件）；写路径先快照既有 chart/drawing 部件再净化，序列化后回注叠加（保真红线，spec §14.3）。

**Spec:** `docs/specs/2026-09-18-office-agent-tools-design.md` §14（2026-09-19 增补）

**已排雷（PoC 实证，勿再踩）**：① drawing 根节点必须声明 `xmlns:r`（openpyxl 严格校验 unbound prefix）；② `<xdr:graphicFrame>` 必须显式闭合再接 `<xdr:clientData/>`；③ openpyxl 验证属性是 `numCache.pt`（无 s）。

## 全局约束

- Node 20（`nvm use 20`）；TS strict 禁 any/@ts-ignore；`noUncheckedIndexedAccess`；注释全中文
- 测试：`cd electron && npx pnpm@9.0.0 vitest run <路径>`；镜像 src 结构（tests/agent/tools/office/）
- momo-test-rules：不 mock adm-zip/exceljs；结构断言用 cheerio（xmlMode）
- 版本号不动；commit 加双 footer（Ultraworked + Co-authored-by）
- 引用格式一律 `'工作表名'!$A$1:$B$5`（单引号包裹 sheet 名，列行绝对引用）
- axId 用 PoC 验证值：catAx=111111111 / valAx=222222222（pie 无轴）

---

### Task 1: chart-xml.ts 纯函数生成器

**Files:**
- Create: `electron/src/main/agent/tools/office/chart-xml.ts`
- Test: `electron/tests/agent/tools/office/chart-xml.test.ts`

**Interfaces（Produces）:**
- `type ChartType = 'bar' | 'bar_h' | 'line' | 'pie'`
- `interface ChartSeriesData { nameRef?: string; nameLiteral?: string; catRef: string; catCache: string[]; valRef: string; valCache: number[] }`
- `interface ChartData { type: ChartType; title?: string; series: ChartSeriesData[] }`
- `buildChartXml(data: ChartData): string`（完整 chartSpace XML）
- `buildAnchorXml(anchor: { fromCol: number; fromRow: number; toCol: number; toRow: number }, chartRid: string, frameId: number): string`（twoCellAnchor 片段）
- `sheetAbsRef(sheet: string, range: string): string`（`'汇总'!$A$2:$A$5` 形态；内部用既有 parseRange 归一）
- `xmlEscape(s: string): string`

- [ ] **Step 1: 失败测试**（cheerio xmlMode 结构断言）

```ts
// electron/tests/agent/tools/office/chart-xml.test.ts
import { describe, it, expect } from 'vitest';
import * as cheerio from 'cheerio';
import { buildChartXml, buildAnchorXml, sheetAbsRef, xmlEscape } from '../../../../src/main/agent/tools/office/chart-xml';

const barSeries = [{
  nameRef: `'汇总'!$B$1`, catRef: `'汇总'!$A$2:$A$5`, catCache: ['1月', '2月', '3月', '4月'],
  valRef: `'汇总'!$B$2:$B$5`, valCache: [100, 200, 300, 400],
}];

describe('buildChartXml', () => {
  it('bar：barDir=col + 双轴 + ser 引用与缓存', () => {
    const $ = cheerio.load(buildChartXml({ type: 'bar', title: '月度销售额', series: barSeries }), { xmlMode: true });
    expect($('c\\:barChart c\\:barDir').attr('val')).toBe('col');
    expect($('c\\:barChart c\\:grouping').attr('val')).toBe('clustered');
    expect($('c\\:title a\\:t').text()).toBe('月度销售额');
    const ser = $('c\\:ser');
    expect(ser).toHaveLength(1);
    expect(ser.find('c\\:tx c\\:strRef c\\:f').text()).toBe(`'汇总'!$B$1`);
    expect(ser.find('c\\:cat c\\:strRef c\\:f').text()).toBe(`'汇总'!$A$2:$A$5`);
    expect(ser.find('c\\:cat c\\:strCache c\\:pt').map((_, e) => $(e).find('c\\:v').text()).get()).toEqual(['1月', '2月', '3月', '4月']);
    expect(ser.find('c\\:val c\\:numRef c\\:f').text()).toBe(`'汇总'!$B$2:$B$5`);
    expect(ser.find('c\\:val c\\:numCache c\\:pt').map((_, e) => $(e).find('c\\:v').text()).get()).toEqual(['100', '200', '300', '400']);
    expect($('c\\:catAx c\\:axId').attr('val')).toBe('111111111');
    expect($('c\\:valAx c\\:axId').attr('val')).toBe('222222222');
  });
  it('bar_h：barDir=bar + catAx axPos=l / valAx axPos=b', () => {
    const $ = cheerio.load(buildChartXml({ type: 'bar_h', series: barSeries }), { xmlMode: true });
    expect($('c\\:barChart c\\:barDir').attr('val')).toBe('bar');
    expect($('c\\:catAx c\\:axPos').attr('val')).toBe('l');
    expect($('c\\:valAx c\\:axPos').attr('val')).toBe('b');
  });
  it('line：lineChart + marker + 双轴', () => {
    const $ = cheerio.load(buildChartXml({ type: 'line', series: barSeries }), { xmlMode: true });
    expect($('c\\:lineChart')).toHaveLength(1);
    expect($('c\\:lineChart c\\:grouping').attr('val')).toBe('standard');
    expect($('c\\:lineChart c\\:ser c\\:marker c\\:symbol').attr('val')).toBe('circle');
  });
  it('pie：pieChart + varyColors + dLbls 百分比 + 无轴', () => {
    const $ = cheerio.load(buildChartXml({ type: 'pie', title: '占比', series: barSeries }), { xmlMode: true });
    expect($('c\\:pieChart')).toHaveLength(1);
    expect($('c\\:pieChart c\\:varyColors').attr('val')).toBe('1');
    expect($('c\\:pieChart c\\:dLbls c\\:showPercent').attr('val')).toBe('1');
    expect($('c\\:catAx')).toHaveLength(0);
    expect($('c\\:valAx')).toHaveLength(0);
  });
  it('多序列 idx/order 递增；字面量序列名走 c:v；空 title 不生成 title 节点', () => {
    const two = [...barSeries, { nameLiteral: '第二年', catRef: `'汇总'!$A$2:$A$5`, catCache: ['1月'], valRef: `'汇总'!$C$2:$C$5`, valCache: [1, 2, 3, 4] }];
    const $ = cheerio.load(buildChartXml({ type: 'bar', series: two }), { xmlMode: true });
    expect($('c\\:ser')).toHaveLength(2);
    expect($('c\\:ser').eq(1).find('c\\:idx').attr('val')).toBe('1');
    expect($('c\\:ser').eq(1).find('c\\:order').attr('val')).toBe('1');
    expect($('c\\:ser').eq(1).find('c\\:tx c\\:v').text()).toBe('第二年');
    const noTitle = cheerio.load(buildChartXml({ type: 'bar', series: barSeries }), { xmlMode: true });
    expect(noTitle('c\\:title')).toHaveLength(0);
    expect(noTitle('c\\:autoTitleDeleted').attr('val')).toBe('1');
  });
});

describe('buildAnchorXml', () => {
  it('twoCellAnchor editAs=oneCell + graphicFrame 闭合 + r:id 引用', () => {
    const xml = buildAnchorXml({ fromCol: 0, fromRow: 5, toCol: 7, toRow: 20 }, 'rId1', 2);
    const $ = cheerio.load(`<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${xml}</xdr:wsDr>`, { xmlMode: true });
    expect($('xdr\\:twoCellAnchor').attr('editAs')).toBe('oneCell');
    expect($('xdr\\:from xdr\\:row').text()).toBe('5');
    expect($('xdr\\:to xdr\\:col').text()).toBe('7');
    expect($('xdr\\:graphicFrame')).toHaveLength(1);
    expect($('xdr\\:clientData')).toHaveLength(1);
    expect($('xdr\\:graphic c\\:chart').attr('id')).toBe('rId1');
    expect($('xdr\\:cNvPr').attr('id')).toBe('2');
  });
});

describe('sheetAbsRef / xmlEscape', () => {
  it('单引号包裹 + 绝对化', () => {
    expect(sheetAbsRef('汇总', 'A2:B5')).toBe(`'汇总'!$A$2:$B$5`);
    expect(sheetAbsRef('销售 明细', 'B1')).toBe(`'销售 明细'!$B$1`);
  });
  it('XML 转义', () => {
    expect(xmlEscape('a<b>&"c"')).toBe('a&lt;b&gt;&amp;&quot;c&quot;');
  });
});
```

- [ ] **Step 2: 跑红** → FAIL（模块不存在）
- [ ] **Step 3: 实现**（bar 模板 = PoC 验证版逐字基准；line/pie/bar_h 为同构增量）

核心结构（完整实现要点，bar 型 ser/轴以 PoC 为准）：

```ts
// chartSpace 序列化次序（openpyxl 严格）：c:chart → [c:title, c:autoTitleDeleted, c:plotArea, c:plotVisOnly, c:dispBlanksAs]
// plotArea: c:layout → {barChart|lineChart|pieChart} → [axes]
// bar(bar_h): barDir col(bar) + grouping clustered + varyColors 0 + sers + gapWidth 150 + axId×2
// line: lineChart grouping standard + sers(含 c:marker symbol=circle size=5) + axId×2 + 轴同 bar col
// pie: pieChart varyColors 1 + ser(无 spPr) + dLbls(showPercent=1, showLeaderLines=1) + firstSliceAng 0 —— 无轴无 axId
// ser 次序：c:idx, c:order, [c:tx(strRef+strCache | c:v)], [c:spPr(bar/line 线色)], c:cat(strRef+strCache), c:val(numRef+numCache)
// numCache 次序：c:formatCode General → c:ptCount → c:pt idx 递增
// 轴：catAx(axId 111111111, scaling minMax, delete 0, axPos b|l, crossAx 222222222) / valAx(axId 222222222, axPos l|b, crossAx 111111111, numFmt General sourceLinked=1)
// title：c:title>c:tx>c:rich>a:bodyPr+a:lstStyle+a:p>a:pPr(a:defRPr sz=1200)+a:r(a:rPr lang=zh-CN sz=1200, a:t=转义文本)+c:overlay 0；无 title 时 c:autoTitleDeleted val=1（有 title 时 val=0）
// 两处排雷铁律：drawing 组装时根节点声明 xmlns:r；graphicFrame 显式闭合后才能 clientData
```

- [ ] **Step 4: 跑绿** → PASS
- [ ] **Step 5: Commit** `feat: chart XML 纯函数生成器——bar/bar_h/line/pie 四型（PoC 验证模板）`

### Task 2: xlsx-zip.ts 注入与保真

**Files:**
- Create: `electron/src/main/agent/tools/office/xlsx-zip.ts`
- Test: `electron/tests/agent/tools/office/xlsx-zip.test.ts`

**Interfaces（Produces）:**
- `resolveSheetFile(zip: AdmZip, sheetName: string): string | null`（workbook.xml + workbook rels → sheetN.xml）
- `snapshotChartParts(buf: Buffer): ChartPartsSnapshot`（drawings/charts/media 部件 + 各 sheet rels 中 drawing 条目 + sheet `<drawing/>` 标签 + 相关 ContentTypes Override）
- `restoreChartParts(buf: Buffer, snap: ChartPartsSnapshot): Buffer`（回注部件；sheet rels 与新文件既有条目合并，**Id 冲突时重命名**并同步改 sheet XML 的 r:id；ContentTypes 补缺失 Override）
- `injectCharts(buf: Buffer, sheetFile: string, charts: Array<{ anchorXml 内嵌的 chartSpaceXml }>): Buffer`——目标 sheet 无 drawing → 新建 drawingN/rels/sheet rels/`<drawing/>` 标签/ContentTypes；**已有 drawing → 锚点合并**（twoCellAnchor 追加进既有 wsDr、drawing rels 追加、cNvPr id 取既有最大+1）

- [ ] **Step 1: 失败测试**（fixture 用 exceljs 造底 + adm-zip 注入 P0 形态 drawing，全部真实操作）

用例清单：
1. `resolveSheetFile`：单/多 sheet 名→文件映射；不存在 → null
2. `injectCharts` 干净文件：注入后 zip 含 `xl/charts/chart1.xml` + `xl/drawings/drawing1.xml` + 双 rels；sheet1.xml 尾部含 `<drawing r:id=`；ContentTypes 含 chart/drawing Override；**exceljs 仍能 load 注入结果**（PoC 已证）
3. `injectCharts` 多图表：两 chart → chart1/chart2 + drawing1 含两 twoCellAnchor + drawing rels 两条
4. `injectCharts` 目标 sheet 已有 drawing（fixture）：合并后 drawing1 只有一个 wsDr、锚点 2 个、rels 3 条（原 chart 引用 + 新 2）
5. `snapshotChartParts`/`restoreChartParts` 往返：带 2 chart fixture → snapshot → exceljs 重写（净化后 writeBuffer 的等价模拟）→ restore → 部件数不变、chart1.xml 字节不变、rels/ContentTypes 完整
6. **Id 冲突**：新文件 sheet rels 已有 `rId1`（hyperlink）+ snapshot drawing 也是 `rId1` → restore 后两条并存且 Id 不同、sheet XML 的 drawing r:id 指向重命名后的 Id

- [ ] **Step 2: 跑红** → FAIL
- [ ] **Step 3: 实现**（AdmZip API：getEntries/deleteFile/updateFile/addFile；rels 合并 = 字符串级 `<Relationship .../>` 数组操作——P0 sanitize 同款手法复用）
- [ ] **Step 4: 跑绿**；**Step 5: Commit** `feat: xlsx zip 图表注入与既有部件快照回注——rels 冲突重命名与锚点合并`

### Task 3: excel.ts add_chart 集成

**Files:**
- Modify: `electron/src/main/agent/tools/office/excel.ts`
- Test: `electron/tests/agent/tools/office/excel-chart.test.ts`

**Interfaces:**
- `ExcelWriteOp` 增第三型 `{ op: 'add_chart'; sheet; type; anchor; size?; title?; categories: {sheet; range}; series: Array<{name?: {sheet; range} | string; values: {sheet; range}}> }`
- `parseExcelWriteOps` 增分支与校验：series 空 / pie 多序列 / anchor 单格（parseRange）/ range 引用缺 sheet
- `writeXlsxOps` 流程改造：`snapshotChartParts(before)` → `sanitizeXlsxForRead(before).data` → exceljs load → 逐 op（数据 op 原样；add_chart 校验 sheet 存在 + 从**内存 wb** 读 categories/series 区域值[数字序列校验，非数字中文报错含单元格地址] + 组装 ChartData）→ writeBuffer → `restoreChartParts` → 有 chart 时 `injectCharts`（sheet 名经 `resolveSheetFile` 映射）→ 返回
- 区域读值辅助 `readRangeValues(wb, sheet, range): { texts: string[]; numbers: number[] }`（单列/单行区域；values 校验全数字）

- [ ] **Step 1: 失败测试**

用例清单（fixture：createXlsx → set_cells 写月度数据 → add_chart）：
1. **bar round-trip**：写出后 zip 断言 chart1.xml 的 c:f 引用 = `'销售明细'!$A$2:$A$10` 等 + numCache 值与写入数据一致；`resolveSheetFile` 映射正确（图表在第二页签时注入到 sheet2）
2. **四型**：bar/bar_h/line/pie 各注一个（同文件多 op）→ zip 中四个 chart 部件型别节点正确
3. **保真红线**：P0 chart fixture（2 chart）→ writeXlsxOps（add_sheet 汇总 + set_cells + add_chart 于新页签）→ 输出 zip：chart 部件 3 个、**原 chart1/chart2.xml 字节不变**、原 drawing rels 完好
4. 错误路径：pie 2 序列报错；series 空报错；values 区域含文本报错（文案含单元格地址）；anchor 给区域（A1:B2）报错；sheet 不存在沿用 add_sheet 指引
5. 顺序语义：add_chart 引用的区域在同批 set_cells 刚写入 → 缓存正确（先写后图）

- [ ] **Step 2: 跑红** → **Step 3: 实现** → **Step 4: 跑绿**（office 目录全套 + 全量 electron）
- [ ] **Step 5: Commit** `feat: office_write_excel 支持 add_chart——原生图表编排与既有部件保真`

### Task 4: 工具面同步 + 办公助理提示词 + 终验

**Files:**
- Modify: `electron/src/main/agent/tools/office-tools.ts`（WRITE_EXCEL_DEF description + op enum 加 add_chart + items 属性）
- Modify: `electron/resources/agents/office-assistant.yaml` + `resources/marketplace/catalog.json`（systemPrompt 工作流 3 补图表指引：「图表页签：set_cells 写汇总数 → add_chart 引用区域（柱/横条/折线/饼）」）
- Test: 上述文件同步的契约断言（office-tools.test.ts handles 已覆盖；YAML readme 断言 add_chart 关键词出现）

- [ ] **Step 1: 失败测试**（YAML/catalog 含图表指引断言）→ **Step 2: 实现** → **Step 3: 跑绿 + 全量**（`npx pnpm@9.0.0 test` + typecheck 双 Done）→ **Step 4: Commit** `feat: 办公工具图表能力面同步——工具描述与助理提示词`

- [ ] **Step 5: controller 终验（openpyxl 真实消费方）**：node 脚本走 OfficeTools.execute 全链路生成四型图表文件 → python 断言 `_charts` 数量/类型/引用/缓存（PoC 同款）——实现者跑通后把脚本输出贴报告。

## 验收对照（spec §14.5）

结构断言（T1-T3 用例）✓ / 真实消费方（T4 Step 5）✓ / 保真回归（T3 用例 3）✓ / 提示词同步（T4）✓
