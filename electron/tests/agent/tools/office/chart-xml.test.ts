// Momo Studio 原生 Excel 图表：chart-xml.ts 纯函数生成器单测。
// 覆盖四型（bar/bar_h/line/pie）chartSpace 元素次序 + drawing twoCellAnchor 组装 + sheetAbsRef + xmlEscape。
// PoC 排雷铁律已锁：drawing 根节点 xmlns:r 声明、graphicFrame 显式闭合、chartSpace 元素次序严格。

import { describe, it, expect } from 'vitest';
import * as cheerio from 'cheerio';
import { buildChartXml, buildAnchorXml, sheetAbsRef, xmlEscape } from '../../../../src/main/agent/tools/office/chart-xml';
import type { ChartSeriesData } from '../../../../src/main/agent/tools/office/chart-xml';

// 1 元组而非数组：noUncheckedIndexedAccess 下 barSeries[0] 展开需要非 undefined 类型
const barSeries: [ChartSeriesData] = [{
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
  it('nameCache 提供时 tx 发 strCache（引用+缓存）', () => {
    const $ = cheerio.load(buildChartXml({ type: 'bar', series: [{ ...barSeries[0], nameCache: '销售额' }] }), { xmlMode: true });
    expect($('c\\:tx c\\:strRef c\\:f').text()).toBe(`'汇总'!$B$1`);
    expect($('c\\:tx c\\:strRef c\\:strCache c\\:pt c\\:v').text()).toBe('销售额');
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
    // OOXML 中 graphic 在 drawingml-main 命名空间（a:），不在 spreadsheetDrawing（xdr:）。
    // cheerio xmlMode 不暴露 r:id 的本地名 id：必须用限定名 r:id 访问。
    expect($('a\\:graphic c\\:chart').attr('r:id')).toBe('rId1');
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

// ────────────────────────────────────────────────────────────────────────────
// 着色（spec §14.8-5）：series.color（整系列 solidFill）+ dataPointColors（逐点
// c:dPt）。C5 场景死点：预警红柱无工具 → agent 外逃 Python。
// ────────────────────────────────────────────────────────────────────────────

/** ser 直接子元素标签名序列（次序断言用；xmlMode 下保留 c: 前缀原名） */
function serChildTags($: ReturnType<typeof cheerio.load>): string[] {
  return $('c\\:ser')
    .children()
    .map((_, e) => (e as unknown as { name: string }).name)
    .get();
}

describe('着色：系列色（spec §14.8-5）', () => {
  it('bar + color：ser spPr solidFill 色值 + 描边保留（ln 仍在，solidFill 在 ln 前）', () => {
    const $ = cheerio.load(
      buildChartXml({ type: 'bar', series: [{ ...barSeries[0], color: '4472C4' }] }),
      { xmlMode: true },
    );
    expect($('c\\:ser > c\\:spPr > a\\:solidFill > a\\:srgbClr').attr('val')).toBe('4472C4');
    expect($('c\\:ser > c\\:spPr > a\\:ln').length).toBe(1);
    const tags = serChildTags($);
    expect(tags.indexOf('c:spPr')).toBeGreaterThan(tags.indexOf('c:tx'));
    expect(tags.indexOf('c:spPr')).toBeLessThan(tags.indexOf('c:cat'));
  });
  it('pie + color：solidFill-only spPr（pie 无描边语义不回归）', () => {
    const $ = cheerio.load(
      buildChartXml({ type: 'pie', series: [{ ...barSeries[0], color: 'ED7D31' }] }),
      { xmlMode: true },
    );
    expect($('c\\:ser > c\\:spPr > a\\:solidFill > a\\:srgbClr').attr('val')).toBe('ED7D31');
    expect($('c\\:ser > c\\:spPr > a\\:ln')).toHaveLength(0);
  });
  it('无 color 时 spPr 形态不变（bar 描边 / pie 无 spPr——既有字节行为零变更）', () => {
    const bar = cheerio.load(buildChartXml({ type: 'bar', series: barSeries }), { xmlMode: true });
    expect(bar('c\\:ser > c\\:spPr > a\\:solidFill > a\\:srgbClr')).toHaveLength(0);
    expect(bar('c\\:ser > c\\:spPr > a\\:ln > a\\:solidFill > a\\:srgbClr').attr('val')).toBe('000000');
    const pie = cheerio.load(buildChartXml({ type: 'pie', series: barSeries }), { xmlMode: true });
    expect(pie('c\\:ser > c\\:spPr')).toHaveLength(0);
  });
});

describe('着色：数据点色 dataPointColors（spec §14.8-5）', () => {
  const dpcs = [
    { index: 1, color: 'FF0000' },
    { index: 2, color: 'FFC000' },
    { index: 3, color: '00B050' },
  ];

  it('3 项 → 3 个 dPt：idx/色正确，全部位于 spPr 之后、cat 之前', () => {
    const $ = cheerio.load(
      buildChartXml({ type: 'bar', series: [barSeries[0]], dataPointColors: dpcs }),
      { xmlMode: true },
    );
    const dpts = $('c\\:ser > c\\:dPt');
    expect(dpts).toHaveLength(3);
    expect(dpts.eq(0).find('c\\:idx').attr('val')).toBe('1');
    expect(dpts.eq(0).find('a\\:srgbClr').attr('val')).toBe('FF0000');
    expect(dpts.eq(1).find('c\\:idx').attr('val')).toBe('2');
    expect(dpts.eq(1).find('a\\:srgbClr').attr('val')).toBe('FFC000');
    expect(dpts.eq(2).find('c\\:idx').attr('val')).toBe('3');
    expect(dpts.eq(2).find('a\\:srgbClr').attr('val')).toBe('00B050');
    // 次序锁：首个与末个 dPt 都夹在 spPr 与 cat 之间（CT_BarSer 允许位）
    const tags = serChildTags($);
    expect(tags.indexOf('c:dPt')).toBeGreaterThan(tags.indexOf('c:spPr'));
    expect(tags.lastIndexOf('c:dPt')).toBeLessThan(tags.indexOf('c:cat'));
  });

  it('乱序输入按 index 升序输出（idx 2 在 idx 1 前）', () => {
    const $ = cheerio.load(
      buildChartXml({
        type: 'bar',
        series: [barSeries[0]],
        dataPointColors: [dpcs[2]!, dpcs[0]!],
      }),
      { xmlMode: true },
    );
    const dpts = $('c\\:ser > c\\:dPt');
    expect(dpts).toHaveLength(2);
    expect(dpts.eq(0).find('c\\:idx').attr('val')).toBe('1');
    expect(dpts.eq(1).find('c\\:idx').attr('val')).toBe('3');
  });

  it('line + 数据点色：marker 仍在 dPt 之前（CT_LineSer 次序）', () => {
    const $ = cheerio.load(
      buildChartXml({ type: 'line', series: [barSeries[0]], dataPointColors: dpcs.slice(0, 1) }),
      { xmlMode: true },
    );
    const tags = serChildTags($);
    expect(tags.indexOf('c:marker')).toBeGreaterThan(-1);
    expect(tags.indexOf('c:marker')).toBeLessThan(tags.indexOf('c:dPt'));
    expect(tags.indexOf('c:dPt')).toBeLessThan(tags.indexOf('c:cat'));
  });

  it('多序列：dataPointColors 应用到每个 ser（各 2 个 dPt）', () => {
    const two = [...barSeries, { ...barSeries[0], valRef: `'汇总'!$C$2:$C$5`, valCache: [5, 6, 7, 8] }];
    const $ = cheerio.load(
      buildChartXml({ type: 'bar', series: two, dataPointColors: dpcs.slice(0, 2) }),
      { xmlMode: true },
    );
    expect($('c\\:ser')).toHaveLength(2);
    expect($('c\\:ser').eq(0).children('c\\:dPt')).toHaveLength(2);
    expect($('c\\:ser').eq(1).children('c\\:dPt')).toHaveLength(2);
  });

  it('C5 场景形态：pie 单序列 20 点全点着色（>=15 红色预警，其余默认蓝）', () => {
    const cats = Array.from({ length: 20 }, (_, i) => `P${i + 1}`);
    const series: ChartSeriesData = {
      catRef: `'数据'!$A$2:$A$21`, catCache: cats,
      valRef: `'数据'!$B$2:$B$21`, valCache: cats.map((_, i) => (i + 1) * 10),
    };
    const dpc20 = cats.map((_, i) => ({ index: i, color: i >= 15 ? 'FF0000' : '4472C4' }));
    const $ = cheerio.load(
      buildChartXml({ type: 'pie', title: '预警', series: [series], dataPointColors: dpc20 }),
      { xmlMode: true },
    );
    const dpts = $('c\\:pieChart c\\:ser > c\\:dPt');
    expect(dpts).toHaveLength(20);
    expect(dpts.eq(0).find('a\\:srgbClr').attr('val')).toBe('4472C4');
    expect(dpts.eq(14).find('a\\:srgbClr').attr('val')).toBe('4472C4');
    expect(dpts.eq(15).find('a\\:srgbClr').attr('val')).toBe('FF0000');
    expect(dpts.eq(19).find('a\\:srgbClr').attr('val')).toBe('FF0000');
    // varyColors 语义不回归
    expect($('c\\:pieChart c\\:varyColors').attr('val')).toBe('1');
  });
});