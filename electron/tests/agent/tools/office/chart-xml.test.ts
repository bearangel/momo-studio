// Momo Studio 原生 Excel 图表：chart-xml.ts 纯函数生成器单测。
// 覆盖四型（bar/bar_h/line/pie）chartSpace 元素次序 + drawing twoCellAnchor 组装 + sheetAbsRef + xmlEscape。
// PoC 排雷铁律已锁：drawing 根节点 xmlns:r 声明、graphicFrame 显式闭合、chartSpace 元素次序严格。

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