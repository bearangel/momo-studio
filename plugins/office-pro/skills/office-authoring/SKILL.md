---
name: office 文档创作
description: run_js 代码工坊方法论——路径决策树、库速查与 footgun 清单、设计规范红线、收工自查；产出 pptx/xlsx/docx/pdf 前必读
version: 1.0.0
tags: [office, pptx, xlsx, docx, pdf]
---

# Office 文档创作（run_js 代码工坊）

## 0. 能力地图与路径决策（先读这里）

| 需求 | 正确路径 |
|---|---|
| 读文档内容 / 精读 Excel 区域 | office_read / office_read_cells（禁用 run_js 做纯读取——浪费 token） |
| 从零生成 pptx / xlsx / docx / pdf | run_js 写代码 |
| 用户给了企业 .pptx 模板 | run_js + require('momo-pptx-zip') 模板手术（保品牌母版，禁从零仿制） |
| xlsx 要原生图表（双击可编辑） | run_js + exceljs 写数 + require('momo-chart').injectXlsxChart 注入 |
| 收工自查 | require('momo-validate').validateOfficeFile 逐产物校验 |

决策顺序：先问用户有无模板/品牌规范（配色、Logo、字体）→ 没有才从零写 → 复杂版式拆多次小脚本跑。

## 1. run_js 沙箱现实（每次动手前默念）

- **无网络**：任何 fetch / pip / npm 联网方案必败，不要尝试
- **可写目录**：仅 workspace 与系统 tmp；写其他路径直接抛错（沙箱写守卫）
- **预置库**：pptxgenjs / exceljs / docx / pdfkit / adm-zip / momo-chart / momo-pptx-zip / momo-validate，require 裸名即可
- **产物必列 outputs**：记账与撤销的唯一依据；未声明的写入不可撤销
- **超时**：默认 120s（上限 300s）；大数组分批写，不要一次构造全部内容
- 文件写 workspace 相对路径（cwd 就是 workspace）
- **所有异步写盘（writeFile/writeBuffer）必须顶层 await，禁止裸 .then**

## 2. pptxgenjs 速查与 footgun（踩过的坑，照做）

正确用法：
- 颜色 hex **不带 #**：`{ color: '1F4E79' }`
- 字距参数是 `charSpacing`（写 `letterSpacing` 静默失效）。**单位是 point，安全范围 0–2**（正常排版基本不需要）；**绝不传百分比/倍数直觉值**——传 150/180 会让每个字后垫半页空白，PowerPoint 渲染成逐字竖排并压住其他元素（验收实锤的最高代价事故）
- 双轴图必须 `valAxes` + `catAxes` 成对给出
- options 对象会被**原地 mutate**（内部做 EMU 换算）——同一个字面量不要复用
- 版面单位英寸；16:9 为 10 × 5.625

会损坏文件（PowerPoint 拒开，其他工具看不出来）：
- stacked 图表设 `dataLabelPosition: 'outEnd'`
- 颜色字符串带 `#`

常用 API：`new PptxGenJS()` → `defineLayout` / `addSlide()` → `addText(text, {x,y,w,h,fontSize,color,bold,align,valign})` / `addShape('rect', {...})` / `addTable(rows, {...})` / `addChart(type, data, {...})` / `addImage({ path })` → `writeFile({ fileName: 'x.pptx' })`

## 3. exceljs + momo-chart

- exceljs：`new ExcelJS.Workbook()` → `addWorksheet('名')` → `addRow` / `getCell('A1').value` → `workbook.xlsx.writeFile('x.xlsx')`
- 原生图表（纯 JS 生态唯一方案）：先 exceljs 写盘 → `injectXlsxChart(fs.readFileSync('x.xlsx'), { sheetName, anchor, chart })` → 写回。anchor 形如 `{ from: { col: 3, row: 1 }, to: { col: 9, row: 16 } }`（0-based 列行）
- 列宽 / 冻结窗格 / 数字格式 exceljs 原生支持；超大表用流式 `WorkbookWriter`

## 4. docx / pdfkit

- docx：`new Document({ sections: [{ children: [new Paragraph(...), new Table(...)] }] })` → `Packer.toBuffer` → fs 写盘
- pdfkit 中文**必须内嵌字体**，否则乱码：优先检查 pdfkit 内置注册字体；无中文字体时向用户说明改用 docx
- pdfkit 无自动表格：手动画行（moveTo/lineTo）或逐 cell 定位

## 5. 设计规范（反「AI 味」红线）

- NEVER：标题下加装饰线；页面顶部通栏色条压白字（旧工具的丑即此）；无意义色块；一页塞满
- ALWAYS：一页一个主张；字号阶梯 ≤ 3 档（28 / 18 / 14）；四周留白 ≥ 0.5 英寸；配色 3 色内（底色 / 主色 / 强调色），从内容主题推导而非默认深蓝
- 表格：斑马纹或仅横向分隔线；禁全边框网格
- 图表：一张图回答一个问题；数据点 ≤ 8 才全显数据标签

## 6. QA 收工自查（缺一不可）

1. `require('momo-validate').validateOfficeFile(path.resolve('产物路径'))` 每个产物 `ok:true`
2. 文本溢出自查：中文每字宽 ≈ fontSize/72 英寸；估字符数 × 字宽 ≤ 文本框宽 − 0.2 英寸，超了减字或缩号
3. outputs 与实际写盘文件一一核对（多写的补声明重跑，或删掉）
4. 声称完成前，回复里列全部产物路径

## 7. 最小可抄模板

PPT：

```js
const PptxGenJS = require('pptxgenjs');
const pptx = new PptxGenJS();
pptx.defineLayout({ name: 'W', width: 10, height: 5.625 });
pptx.layout = 'W';
const s = pptx.addSlide();
s.addText('标题', { x: 0.6, y: 0.5, w: 8.8, h: 0.8, fontSize: 28, bold: true, color: '2D3436' });
s.addText(['要点一', '要点二'], { x: 0.8, y: 1.7, w: 8.4, h: 2.4, fontSize: 16, color: '555F66', lineSpacingMultiple: 1.4 });
await pptx.writeFile({ fileName: 'out.pptx' });
```

Excel + 原生图表：

```js
const ExcelJS = require('exceljs');
const { injectXlsxChart } = require('momo-chart');
const fs = require('fs');
const wb = new ExcelJS.Workbook();
const ws = wb.addWorksheet('数据');
ws.addRow(['季度', '销量']); ws.addRow(['Q1', 120]); ws.addRow(['Q2', 180]); ws.addRow(['Q3', 150]);
await wb.xlsx.writeFile('out.xlsx');
fs.writeFileSync('out.xlsx', injectXlsxChart(fs.readFileSync('out.xlsx'), {
  sheetName: '数据',
  anchor: { from: { col: 3, row: 1 }, to: { col: 9, row: 16 } },
  chart: { type: 'bar', title: '季度销量', series: [
    { nameLiteral: '销量', catRef: '数据!$A$2:$A$4', catCache: ['Q1', 'Q2', 'Q3'], valRef: '数据!$B$2:$B$4', valCache: [120, 180, 150] },
  ] },
}));
```

校验收工：

```js
const { validateOfficeFile } = require('momo-validate');
const path = require('path');
console.log(JSON.stringify(validateOfficeFile(path.resolve('out.pptx'))));
```
