// P1a+P1b 回归锁（spec §14.6）：写路径缓存重算 + 公式单元格缓存语义。
// 全程真实操作（momo-test-rules：不 mock exceljs / adm-zip）：createXlsx 造底 →
// writeXlsxOps → adm-zip 解包断言 chart XML 缓存内容。
// 核心场景＝真实会话死点：set_cells 修改被图表引用的区域后，既有图表缓存必须重算
// （旧实现字节级快照回注不感知引用变更，agent 被迫外逃 Python 修缓存）。

import { describe, it, expect } from 'vitest';
import AdmZip from 'adm-zip';
import {
  createXlsx,
  writeXlsxOps,
  parseSheetInits,
  parseExcelWriteOps,
} from '../../../../src/main/agent/tools/office/excel';
import { parseChartRef, refreshChartCaches } from '../../../../src/main/agent/tools/office/xlsx-zip';

/** 读取 zip 内某部件全文；缺失即抛（fixture/实现坏了要让测试大声失败） */
function readText(buf: Buffer, name: string): string {
  const zip = new AdmZip(buf);
  const entry = zip.getEntry(name);
  if (!entry) throw new Error(`zip 缺少部件: ${name}`);
  return zip.readAsText(entry.entryName);
}

/** 第 N 个 chart 部件全文 */
function chartXml(buf: Buffer, n: number): string {
  return readText(buf, `xl/charts/chart${n}.xml`);
}

/** 提取全部 numCache 子树——断言作用域收窄（catCache 的 idx 与 valCache 无关） */
function numCaches(xml: string): string[] {
  return xml.match(/<c:numCache>[\s\S]*?<\/c:numCache>/g) ?? [];
}

/** 造「销售明细」底稿：表头 + 3 行月度数据（A 列分类 / B 列数值） */
async function makeBase(): Promise<Buffer> {
  return createXlsx(parseSheetInits([{ name: '销售明细' }]));
}

/** 造底 + 写入 4 行 × 2 列数据（月份 + 金额），返回底稿 */
async function makeMonthlyBase(): Promise<Buffer> {
  return writeXlsxOps(
    await makeBase(),
    parseExcelWriteOps([
      {
        op: 'set_cells',
        sheet: '销售明细',
        range: 'A1',
        values: [
          ['月份', '金额'],
          ['1月', 120],
          ['2月', 135],
          ['3月', 148],
        ],
      },
    ]),
  );
}

/** 底稿 + 一张引用 A2:A4 / B2:B4 的 bar 图（序列名引用 B1） */
async function makeChartedBase(): Promise<Buffer> {
  return writeXlsxOps(
    await makeMonthlyBase(),
    parseExcelWriteOps([
      {
        op: 'add_chart',
        sheet: '销售明细',
        type: 'bar',
        anchor: 'D2',
        title: '月度销售',
        categories: { sheet: '销售明细', range: 'A2:A4' },
        series: [
          {
            name: { sheet: '销售明细', range: 'B1' },
            values: { sheet: '销售明细', range: 'B2:B4' },
          },
        ],
      },
    ]),
  );
}

describe('parseChartRef：c:f 引用解析', () => {
  it('带引号 / 不带引号 / 引号转义 / 感叹号在表名内', () => {
    expect(parseChartRef(`'汇总图表'!$C$10:$C$13`)).toEqual({ sheet: '汇总图表', range: 'C10:C13' });
    expect(parseChartRef('汇总!$B$1')).toEqual({ sheet: '汇总', range: 'B1' });
    expect(parseChartRef(`'it''s'!$A$1`)).toEqual({ sheet: "it's", range: 'A1' });
    expect(parseChartRef(`'a!b'!$A$1:$A$5`)).toEqual({ sheet: 'a!b', range: 'A1:A5' });
    expect(parseChartRef('Sheet1!C10:C13')).toEqual({ sheet: 'Sheet1', range: 'C10:C13' });
  });

  it('非法形态 → null（无 sheet / 未闭合引号 / 非法区域 / 外部引用 / 空串）', () => {
    expect(parseChartRef('$A$1:$A$5')).toBeNull(); // 无 sheet 段
    expect(parseChartRef('Sheet1!')).toBeNull(); // 空 range
    expect(parseChartRef('Sheet1!notARange')).toBeNull(); // 非法 A1
    expect(parseChartRef('[1]Sheet1!$A$1')).toBeNull(); // 外部工作簿引用
    expect(parseChartRef("'未闭合!$A$1")).toBeNull(); // 引号未配对
    expect(parseChartRef('')).toBeNull();
  });
});

describe('refreshChartCaches：单元契约', () => {
  it('readRef 一律返回 null → chart 部件字节不变（保持原缓存）', async () => {
    const charted = await makeChartedBase();
    const out = refreshChartCaches(charted, () => null);
    expect(out.equals(charted)).toBe(true);
  });

  it('缓冲不含 chart 部件 → 原字节返回', async () => {
    const plain = await makeMonthlyBase();
    const out = refreshChartCaches(plain, () => ({ numbers: [1, 2, 3] }));
    expect(out.equals(plain)).toBe(true);
  });

  it('引用值未变化 → 字节级幂等（重建子树与原生成器同构）', async () => {
    const charted = await makeChartedBase();
    const zip = new AdmZip(charted);
    const orig = zip.getEntry('xl/charts/chart1.xml')?.getData();
    expect(orig).toBeDefined();
    const out = refreshChartCaches(charted, (ref) => {
      // 从原 zip 读同区域值回喂（值未变的等价 readRef）
      expect(ref.sheet).toBe('销售明细');
      return ref.range === 'A2:A4'
        ? { texts: ['1月', '2月', '3月'] }
        : ref.range === 'B1'
          ? { texts: ['金额'] }
          : { numbers: [120, 135, 148] };
    });
    const after = new AdmZip(out).getEntry('xl/charts/chart1.xml')?.getData();
    expect(after && orig && after.equals(orig)).toBe(true);
  });
});

describe('P1a：写路径缓存重算（会话死点回归锁）', () => {
  it('set_cells 修改被引用区域 → 既有 chart numCache 重算为新值，c:f 引用不变', async () => {
    const charted = await makeChartedBase();
    // 初始缓存在（旧值）
    expect(chartXml(charted, 1)).toContain('<c:v>120</c:v>');

    // 死点场景：后续 writeXlsxOps 只改数据，图表缓存必须跟随刷新
    const out = await writeXlsxOps(
      charted,
      parseExcelWriteOps([
        { op: 'set_cells', sheet: '销售明细', range: 'B2:B4', values: [[10], [20], [30]] },
      ]),
    );
    const xml = chartXml(out, 1);
    expect(xml).toContain('<c:v>10</c:v>');
    expect(xml).toContain('<c:v>20</c:v>');
    expect(xml).toContain('<c:v>30</c:v>');
    expect(xml).not.toContain('<c:v>120</c:v>');
    expect(xml).not.toContain('<c:v>135</c:v>');
    expect(xml).not.toContain('<c:v>148</c:v>');
    // 活引用不动（重算只重建缓存子树）
    expect(xml).toContain(`<c:f>'销售明细'!$B$2:$B$4</c:f>`);
    expect(xml).toContain(`<c:f>'销售明细'!$A$2:$A$4</c:f>`);
  });

  it('strCache 刷新：categories 区域改名 + 序列名单格（strRef 单格）改名 → chart XML 更新', async () => {
    const charted = await makeChartedBase();
    const out = await writeXlsxOps(
      charted,
      parseExcelWriteOps([
        {
          op: 'set_cells',
          sheet: '销售明细',
          range: 'A2:A4',
          values: [['一月'], ['二月'], ['三月']],
        },
        { op: 'set_cells', sheet: '销售明细', range: 'B1', values: [['销售额']] },
      ]),
    );
    const xml = chartXml(out, 1);
    expect(xml).toContain('<c:v>一月</c:v>');
    expect(xml).toContain('<c:v>三月</c:v>');
    expect(xml).not.toContain('<c:v>1月</c:v>');
    // 序列名 strRef（单格）缓存同样重算
    expect(xml).toContain('<c:v>销售额</c:v>');
    expect(xml).not.toContain('<c:v>金额</c:v>');
    // numCache 未被破坏（引用区域未改，值原样重建）
    expect(xml).toContain('<c:v>120</c:v>');
  });

  it('多图表全刷新：3 张图不同区域各自更新', async () => {
    const charted = await writeXlsxOps(
      await writeXlsxOps(
        await makeBase(),
        parseExcelWriteOps([
          {
            op: 'set_cells',
            sheet: '销售明细',
            range: 'A1',
            values: [
              ['月份', 'B列', 'C列', 'D列'],
              ['1月', 10, 100, 1000],
              ['2月', 20, 200, 2000],
              ['3月', 30, 300, 3000],
            ],
          },
        ]),
      ),
      parseExcelWriteOps([
        {
          op: 'add_chart',
          sheet: '销售明细',
          type: 'bar',
          anchor: 'F2',
          categories: { sheet: '销售明细', range: 'A2:A4' },
          series: [{ values: { sheet: '销售明细', range: 'B2:B4' } }],
        },
        {
          op: 'add_chart',
          sheet: '销售明细',
          type: 'line',
          anchor: 'P2',
          categories: { sheet: '销售明细', range: 'A2:A4' },
          series: [{ values: { sheet: '销售明细', range: 'C2:C4' } }],
        },
        {
          op: 'add_chart',
          sheet: '销售明细',
          type: 'pie',
          anchor: 'F20',
          categories: { sheet: '销售明细', range: 'A2:A4' },
          series: [{ values: { sheet: '销售明细', range: 'D2:D4' } }],
        },
      ]),
    );
    const out = await writeXlsxOps(
      charted,
      parseExcelWriteOps([
        {
          op: 'set_cells',
          sheet: '销售明细',
          range: 'B2:D4',
          values: [
            [11, 110, 1100],
            [21, 210, 2100],
            [31, 310, 3100],
          ],
        },
      ]),
    );
    const c1 = chartXml(out, 1);
    const c2 = chartXml(out, 2);
    const c3 = chartXml(out, 3);
    expect(c1).toContain('<c:v>11</c:v>');
    expect(c1).toContain('<c:v>31</c:v>');
    expect(c1).not.toContain('<c:v>10</c:v>');
    expect(c2).toContain('<c:v>110</c:v>');
    expect(c2).toContain('<c:v>310</c:v>');
    expect(c2).not.toContain('<c:v>100</c:v>');
    expect(c3).toContain('<c:v>1100</c:v>');
    expect(c3).toContain('<c:v>3100</c:v>');
    expect(c3).not.toContain('<c:v>1000</c:v>');
    // 各图引用保持各自区域
    expect(c1).toContain(`<c:f>'销售明细'!$B$2:$B$4</c:f>`);
    expect(c2).toContain(`<c:f>'销售明细'!$C$2:$C$4</c:f>`);
    expect(c3).toContain(`<c:f>'销售明细'!$D$2:$D$4</c:f>`);
  });
});

describe('P1b：公式单元格缓存语义', () => {
  it('values 区域含新写公式（无缓存 result）→ add_chart 成功，该点省略 c:pt、ptCount 全长、c:f 不变', async () => {
    const out = await writeXlsxOps(
      await makeBase(),
      parseExcelWriteOps([
        {
          op: 'set_cells',
          sheet: '销售明细',
          range: 'A1',
          values: [
            ['月份', '金额'],
            ['1月', 10],
            // 公式格：exceljs 新写公式无缓存 result → numCache 该点 omit（诚实优于错值）
            ['2月', { formula: 'SUM(B2,B4)' }],
            ['3月', 30],
          ],
        },
        {
          op: 'add_chart',
          sheet: '销售明细',
          type: 'bar',
          anchor: 'D2',
          categories: { sheet: '销售明细', range: 'A2:A4' },
          series: [{ values: { sheet: '销售明细', range: 'B2:B4' } }],
        },
      ]),
    );
    const xml = chartXml(out, 1);
    const num = numCaches(xml)[0] ?? '';
    // 非公式点照常
    expect(num).toContain('<c:pt idx="0"><c:v>10</c:v></c:pt>');
    expect(num).toContain('<c:pt idx="2"><c:v>30</c:v></c:pt>');
    // 公式点省略 c:pt，ptCount 仍为区域全长 3
    expect(num).not.toContain('<c:pt idx="1"');
    expect(num).toContain('<c:ptCount val="3"/>');
    // 引用不受影响
    expect(xml).toContain(`<c:f>'销售明细'!$B$2:$B$4</c:f>`);
  });

  it('纯文本仍拒绝：values 区域含文本 → 运行期报错文案含单元格地址（现状保留）', async () => {
    await expect(
      writeXlsxOps(
        await writeXlsxOps(
          await makeBase(),
          parseExcelWriteOps([
            {
              op: 'set_cells',
              sheet: '销售明细',
              range: 'A1',
              values: [
                ['月份', '金额'],
                ['1月', 10],
                ['2月', '缺数'],
                ['3月', 30],
              ],
            },
          ]),
        ),
        parseExcelWriteOps([
          {
            op: 'add_chart',
            sheet: '销售明细',
            type: 'bar',
            anchor: 'D2',
            categories: { sheet: '销售明细', range: 'A2:A4' },
            series: [{ values: { sheet: '销售明细', range: 'B2:B4' } }],
          },
        ]),
      ),
    ).rejects.toThrow(/'销售明细'!B3 不是数字/);
  });

  it('公式格 + 刷新共存：图表引用区域含公式格 → 后续 write 重算该点仍 omit 不报错', async () => {
    const charted = await writeXlsxOps(
      await makeBase(),
      parseExcelWriteOps([
        {
          op: 'set_cells',
          sheet: '销售明细',
          range: 'A1',
          values: [
            ['月份', '金额'],
            ['1月', 10],
            ['2月', { formula: 'SUM(B2,B4)' }],
            ['3月', 30],
          ],
        },
        {
          op: 'add_chart',
          sheet: '销售明细',
          type: 'bar',
          anchor: 'D2',
          categories: { sheet: '销售明细', range: 'A2:A4' },
          series: [{ values: { sheet: '销售明细', range: 'B2:B4' } }],
        },
      ]),
    );
    // 后续写：改非公式格 + 触发全图重算——公式点仍 omit、其余点取新值、不抛错
    const out = await writeXlsxOps(
      charted,
      parseExcelWriteOps([
        { op: 'set_cells', sheet: '销售明细', range: 'B2', values: [[11]] },
      ]),
    );
    const xml = chartXml(out, 1);
    const num = numCaches(xml)[0] ?? '';
    expect(num).toContain('<c:pt idx="0"><c:v>11</c:v></c:pt>');
    expect(num).not.toContain('<c:pt idx="1"');
    expect(num).toContain('<c:pt idx="2"><c:v>30</c:v></c:pt>');
    expect(num).toContain('<c:ptCount val="3"/>');
  });

  it('公式格带缓存 result（真实 Excel 保存后再写）→ numCache 取 result 值', async () => {
    // 直接构造 readRef 契约：refreshChartCaches 消费「公式 result 数字」点。
    // exceljs 本身不计算公式，带 result 的公式格来自真实 Excel 保存的文件——
    // 用 refreshChartCaches 单元锁「number 直通」即可（write 链路同函数消费）。
    const charted = await makeChartedBase();
    const out = refreshChartCaches(charted, (ref) => {
      if (ref.range === 'B2:B4') return { numbers: [120, null, 148] };
      return null; // 其余引用保持原缓存
    });
    const xml = chartXml(out, 1);
    const num = numCaches(xml)[0] ?? '';
    expect(num).toContain('<c:pt idx="0"><c:v>120</c:v></c:pt>');
    expect(num).not.toContain('<c:pt idx="1"');
    expect(num).toContain('<c:pt idx="2"><c:v>148</c:v></c:pt>');
    expect(num).toContain('<c:ptCount val="3"/>');
    // strCache（categories/name）未被 readRef 触达 → 原缓存保留
    expect(xml).toContain('<c:v>1月</c:v>');
    expect(xml).toContain('<c:v>金额</c:v>');
  });
});
