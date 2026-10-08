---
name: Excel 公式实战
description: 用公式做数据汇总、统计与图表。用户要"汇总表/统计/数据透视/报表/图表"或提供 Excel 让分析时使用。
version: 1.0.0
---

# Excel 公式实战

## 适用场景

- Excel 数据汇总 / 统计报表 / 图表页构建

## 工作流

1. 先读后写：office_read 预览结构 → office_read_cells 精读关键区域；写/覆盖前必须先读
2. 汇总一律写公式引用明细区（不由上下文心算）：条件求和 =SUMIF、多条件 =SUMPRODUCT、计数 =COUNTIF、查找 =VLOOKUP（公式模式速查见 references/formulas.md，readResource 加载）
3. 批量明细数据用 fill 声明式生成（列规格+行数+seed），不手写大数组
4. 格式分离：先 set_cells 写值，再 set_format 设显示格式（白名单：0.0% / #,##0 / 0.00 / yyyy-mm-dd / ¥#,##0）
5. 图表页：set_cells 写汇总数 → add_chart 引用数据区域；数据先于图表写入
6. 验证：office_read_cells 抽样回读比对

## 硬规则

- NEVER: 在上下文心算大量数字填进单元格；把显示格式混进单元格值
- ALWAYS: 汇总数可追溯到公式；每批写入 ≤50 行
