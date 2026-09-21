// fill 数据生成 op 单测（spec §14.7）：parseFillOp 窄化与错误路径全表、
// generateFillRows 七型生成器语义、writeXlsxOps 接线（会话回归锁 + 图表混排）。
// 保真度：真实 exceljs 造文件 → 真实写入 → 重读断言，不 mock 库；所有含随机性
// 的断言固定 seed（确定性断言代替统计检验，快照 green 后按实际输出固化）。
// 回归背景：第三轮会话 agent 手写 80 行 × 10 列 set_cells → 形状失控（27×11）+
// 内容污染（数组退化混入无关字符串）→ 整体外逃 Python 生成——本套件锁定 fill
// 一次成型、枚举列零污染、公式行号正确。

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import ExcelJS from 'exceljs';
import AdmZip from 'adm-zip';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseFillOp,
  generateFillRows,
  type FillColumn,
} from '../../../../src/main/agent/tools/office/fill';
import {
  createXlsx,
  writeXlsxOps,
  parseExcelWriteOps,
  parseSheetInits,
} from '../../../../src/main/agent/tools/office/excel';
import type { CellInput } from '../../../../src/main/agent/tools/office/excel';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-fill-'));
});
afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

/** 最小合法 fill 原始参数（各错误路径用例覆写单字段） */
function baseFillOp(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    op: 'fill',
    sheet: '数据',
    anchor: 'A2',
    rows: 10,
    seed: 20260921,
    columns: [{ type: 'literal', values: ['甲'] }],
    ...overrides,
  };
}

/** 单列便捷调用：返回该列生成结果（一维） */
function oneColumn(col: FillColumn, rows: number, anchor = 'A1', seed = 42): CellInput[] {
  return generateFillRows({ sheet: 'S', anchor, rows, seed, columns: [col] }).map((r) => r[0]!);
}

// ────────────────────────────────────────────────────────────────────────────
// 1. 会话回归锁：writeXlsxOps 单 op fill——复刻第三轮会话的 80 行 × 10 列场景
// ────────────────────────────────────────────────────────────────────────────

describe('writeXlsxOps fill（会话回归锁：一次 fill 80 行 × 10 列）', () => {
  it('形状 81×10、日期 even 首尾覆盖且升序、枚举列零污染、公式行号 2..81', async () => {
    const abs = path.join(tmpDir, 'sales.xlsx');
    fs.writeFileSync(
      abs,
      await createXlsx(
        parseSheetInits([
          {
            name: '销售明细',
            headers: ['日期', '月份', '产品', '类别', '区域', '渠道', '数量', '单价', '金额', '销售员'],
          },
        ]),
      ),
    );
    const products = ['智能手表', '无线耳机', '便携音箱'];
    const regions = ['华东', '华南', '华北', '西南'];
    const channels = ['线上', '线下', '分销'];
    const prices = ['199', '299', '499'];
    const sellers = ['李明', '王芳', '赵强'];
    const ops = parseExcelWriteOps([
      {
        op: 'fill',
        sheet: '销售明细',
        anchor: 'A2',
        rows: 80,
        seed: 20260921,
        columns: [
          { type: 'sequence_date', start: '2026-01-01', end: '2026-09-30', distribute: 'even' },
          { type: 'formula', template: '=MONTH(A{row})' },
          { type: 'pick', items: products },
          { type: 'formula', template: '=VLOOKUP(C{row},目录!$A$2:$B$4,2,0)' },
          { type: 'pick', items: regions },
          { type: 'literal', values: channels },
          { type: 'random_int', min: 3, max: 15 },
          { type: 'pick', items: prices },
          { type: 'formula', template: '=H{row}*I{row}' },
          { type: 'pick', items: sellers },
        ],
      },
    ]);
    const out = await writeXlsxOps(fs.readFileSync(abs), ops);
    fs.writeFileSync(abs, out);

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(abs);
    const ws = wb.getWorksheet('销售明细')!;
    // 形状锁：表头 1 行 + 数据 80 行 = 81；列 10——无第三轮的 27×11 形状失控
    expect(ws.rowCount).toBe(81);
    expect(ws.columnCount).toBe(10);
    // 日期列 even：首尾恰为 start/end 且单调不减（升序即覆盖全程）
    expect(ws.getCell('A2').value).toBe('2026-01-01');
    expect(ws.getCell('A81').value).toBe('2026-09-30');
    for (let r = 3; r <= 81; r++) {
      const prev = ws.getCell(`A${r - 1}`).value;
      const cur = ws.getCell(`A${r}`).value;
      if (typeof prev !== 'string' || typeof cur !== 'string') throw new Error(`A${r} 日期不是字符串`);
      expect(cur >= prev).toBe(true);
    }
    // 公式行号：anchor A2 + i → 行号 2..81（前导 = 按 exceljs 约定剥离）
    expect(ws.getCell('B2').value).toMatchObject({ formula: 'MONTH(A2)' });
    expect(ws.getCell('B81').value).toMatchObject({ formula: 'MONTH(A81)' });
    expect(ws.getCell('D2').value).toMatchObject({ formula: 'VLOOKUP(C2,目录!$A$2:$B$4,2,0)' });
    for (let r = 2; r <= 81; r++) {
      expect(ws.getCell(`I${r}`).value).toMatchObject({ formula: `H${r}*I${r}` });
    }
    // 内容零污染：枚举/数值列全部落在声明的值域内（无混入无关字符串）
    for (let r = 2; r <= 81; r++) {
      expect(products).toContain(ws.getCell(`C${r}`).value);
      expect(regions).toContain(ws.getCell(`E${r}`).value);
      expect(channels).toContain(ws.getCell(`F${r}`).value);
      expect(prices).toContain(ws.getCell(`H${r}`).value);
      expect(sellers).toContain(ws.getCell(`J${r}`).value);
      const qty = ws.getCell(`G${r}`).value;
      if (typeof qty !== 'number') throw new Error(`G${r} 数量不是数字`);
      expect(qty).toBeGreaterThanOrEqual(3);
      expect(qty).toBeLessThanOrEqual(15);
      expect(Number.isInteger(qty)).toBe(true);
    }
  });

  it('anchor 单格展开：B3 起两列三行落在 B3:C5', async () => {
    const abs = path.join(tmpDir, 'anchor.xlsx');
    fs.writeFileSync(abs, await createXlsx(parseSheetInits(undefined)));
    const ops = parseExcelWriteOps([
      {
        op: 'fill',
        sheet: 'Sheet1',
        anchor: 'B3',
        rows: 3,
        columns: [
          { type: 'sequence_number', start: 10, step: 10 },
          { type: 'literal', values: ['x'] },
        ],
      },
    ]);
    const out = await writeXlsxOps(fs.readFileSync(abs), ops);
    fs.writeFileSync(abs, out);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(abs);
    const ws = wb.worksheets[0]!;
    expect(ws.getCell('B3').value).toBe(10);
    expect(ws.getCell('C3').value).toBe('x');
    expect(ws.getCell('B5').value).toBe(30);
    expect(ws.getCell('C5').value).toBe('x');
    expect(ws.getCell('A1').value).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 2. seed 复现
// ────────────────────────────────────────────────────────────────────────────

describe('seed 确定性', () => {
  const mixedCols = [
    { type: 'pick', items: ['甲', '乙', '丙'] },
    { type: 'random_int', min: 1, max: 1000 },
    { type: 'random_float', min: 0, max: 10, decimals: 3 },
    { type: 'sequence_date', start: '2026-01-01', end: '2026-12-31', distribute: 'random' },
    { type: 'literal', values: ['x', 'y'] },
    { type: 'sequence_number', start: 1, step: 2 },
  ];

  it('同 seed 同参数：两次生成逐元素相等', () => {
    const a = generateFillRows(parseFillOp(baseFillOp({ rows: 50, seed: 7, columns: mixedCols })));
    const b = generateFillRows(parseFillOp(baseFillOp({ rows: 50, seed: 7, columns: mixedCols })));
    expect(a).toEqual(b);
  });

  it('不同 seed：随机列不同，确定性列（literal/等差）相同', () => {
    const a = generateFillRows(parseFillOp(baseFillOp({ rows: 50, seed: 7, columns: mixedCols })));
    const b = generateFillRows(parseFillOp(baseFillOp({ rows: 50, seed: 8, columns: mixedCols })));
    expect(a.map((row) => row[0])).not.toEqual(b.map((row) => row[0])); // pick
    expect(a.map((row) => row[1])).not.toEqual(b.map((row) => row[1])); // random_int
    expect(a.map((row) => row[2])).not.toEqual(b.map((row) => row[2])); // random_float
    expect(a.map((row) => row[3])).not.toEqual(b.map((row) => row[3])); // random 日期
    expect(a.map((row) => row[4])).toEqual(b.map((row) => row[4])); // literal 无关 seed
    expect(a.map((row) => row[5])).toEqual(b.map((row) => row[5])); // 等差无关 seed
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 3. 七型生成器语义
// ────────────────────────────────────────────────────────────────────────────

describe('generateFillRows 各生成器语义', () => {
  it('sequence_date even：首尾恰为 start/end，中间均分（span 整除与不整除）', () => {
    // span=7 天、rows=8 → 每日一点（整除情形）
    expect(
      oneColumn({ type: 'sequence_date', start: '2026-01-01', end: '2026-01-08', distribute: 'even' }, 8),
    ).toEqual(['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04', '2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08']);
    // span=7 天、rows=4 → 偏移 round(7i/3) = 0,2,5,7
    expect(
      oneColumn({ type: 'sequence_date', start: '2026-01-01', end: '2026-01-08', distribute: 'even' }, 4),
    ).toEqual(['2026-01-01', '2026-01-03', '2026-01-06', '2026-01-08']);
    // rows=1 取 start；start=end 时全天同日
    expect(
      oneColumn({ type: 'sequence_date', start: '2026-01-01', end: '2026-09-30', distribute: 'even' }, 1),
    ).toEqual(['2026-01-01']);
    expect(
      oneColumn({ type: 'sequence_date', start: '2026-05-01', end: '2026-05-01', distribute: 'even' }, 5),
    ).toEqual(['2026-05-01', '2026-05-01', '2026-05-01', '2026-05-01', '2026-05-01']);
  });

  it('sequence_date random：区间内、ISO 格式、可重复（40 点落 5 天必有重复）', () => {
    const out = oneColumn(
      { type: 'sequence_date', start: '2026-03-01', end: '2026-03-05', distribute: 'random' },
      40,
    );
    for (const v of out) {
      if (typeof v !== 'string') throw new Error('random 日期不是字符串');
      expect(v).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(v >= '2026-03-01' && v <= '2026-03-05').toBe(true);
    }
    expect(new Set(out).size).toBeLessThan(out.length);
  });

  it('sequence_number 等差（正步长/负步长/小数步长）', () => {
    expect(oneColumn({ type: 'sequence_number', start: 5, step: 3 }, 4)).toEqual([5, 8, 11, 14]);
    expect(oneColumn({ type: 'sequence_number', start: 10, step: -2 }, 3)).toEqual([10, 8, 6]);
    expect(oneColumn({ type: 'sequence_number', start: 2.5, step: 0.5 }, 3)).toEqual([2.5, 3, 3.5]);
  });

  it('random_int 闭区间：min=max 边界可达、全程整数在界内', () => {
    expect(oneColumn({ type: 'random_int', min: 7, max: 7 }, 20)).toEqual(Array<CellInput>(20).fill(7));
    const out = oneColumn({ type: 'random_int', min: 1, max: 5 }, 100);
    for (const v of out) {
      if (typeof v !== 'number') throw new Error('random_int 不是数字');
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(1);
      expect(v).toBeLessThanOrEqual(5);
    }
  });

  it('random_float：decimals 位数与区间（含 decimals=0 取整）', () => {
    const out = oneColumn({ type: 'random_float', min: 0.8, max: 1.2, decimals: 2 }, 50);
    for (const v of out) {
      if (typeof v !== 'number') throw new Error('random_float 不是数字');
      expect(v).toBeGreaterThanOrEqual(0.8);
      expect(v).toBeLessThanOrEqual(1.2);
      expect(v).toBeCloseTo(Math.round(v * 100) / 100, 12);
    }
    const ints = oneColumn({ type: 'random_float', min: 1.1, max: 1.9, decimals: 0 }, 10);
    for (const v of ints) {
      if (typeof v !== 'number') throw new Error('random_float 不是数字');
      expect(Number.isInteger(v)).toBe(true);
    }
  });

  it('literal 循环取用', () => {
    expect(oneColumn({ type: 'literal', values: ['李明', '王芳'] }, 5)).toEqual([
      '李明',
      '王芳',
      '李明',
      '王芳',
      '李明',
    ]);
  });

  it('pick 无权：固定 seed 输出快照（确定性代替统计均匀性）', () => {
    const out = oneColumn({ type: 'pick', items: ['甲', '乙', '丙'] }, 10);
    for (const v of out) expect(['甲', '乙', '丙']).toContain(v);
    // 快照：seed 42、rows 10 的确定性输出（10 次未抽到「甲」——锁序列不锁分布）
    expect(out).toEqual(['乙', '丙', '丙', '乙', '丙', '丙', '乙', '丙', '丙', '乙']);
  });

  it('pick 加权：累积权重法确定性输出，悬殊权重下低权项少量', () => {
    const out = oneColumn({ type: 'pick', items: ['甲', '乙'], weights: [1, 999] }, 50);
    for (const v of out) expect(['甲', '乙']).toContain(v);
    const heavy = out.filter((v) => v === '乙').length;
    expect(heavy).toBeGreaterThan(25);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 4. 公式 {row} 替换
// ────────────────────────────────────────────────────────────────────────────

describe('formula {row} 替换', () => {
  it('anchor C5 → 首行引用 row 5；{row} 多次出现全部替换；前导 = 剥离、无 = 也可', () => {
    const out = generateFillRows({
      sheet: 'S',
      anchor: 'C5',
      rows: 3,
      seed: 42,
      columns: [
        { type: 'formula', template: '=SUM(A{row}:Z{row})' },
        { type: 'formula', template: '=A{row}+B{row}' },
        { type: 'formula', template: 'H{row}*I{row}' },
      ],
    });
    expect(out[0]).toEqual([{ formula: 'SUM(A5:Z5)' }, { formula: 'A5+B5' }, { formula: 'H5*I5' }]);
    expect(out[1]).toEqual([{ formula: 'SUM(A6:Z6)' }, { formula: 'A6+B6' }, { formula: 'H6*I6' }]);
    expect(out[2]).toEqual([{ formula: 'SUM(A7:Z7)' }, { formula: 'A7+B7' }, { formula: 'H7*I7' }]);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 5. 错误路径全表
// ────────────────────────────────────────────────────────────────────────────

describe('parseFillOp 错误路径', () => {
  it('rows 边界：0 / 50001 拒，1 / 50000 收；非整数与缺失拒', () => {
    expect(() => parseFillOp(baseFillOp({ rows: 0 }))).toThrow(/rows/);
    expect(() => parseFillOp(baseFillOp({ rows: 50001 }))).toThrow(/rows/);
    expect(() => parseFillOp(baseFillOp({ rows: 1 }))).not.toThrow();
    expect(() => parseFillOp(baseFillOp({ rows: 50000 }))).not.toThrow();
    expect(() => parseFillOp(baseFillOp({ rows: 2.5 }))).toThrow(/rows/);
    expect(() => parseFillOp(baseFillOp({ rows: undefined }))).toThrow(/rows/);
  });

  it('columns：空数组 / 缺失 / 非数组', () => {
    expect(() => parseFillOp(baseFillOp({ columns: [] }))).toThrow(/columns/);
    expect(() => parseFillOp(baseFillOp({ columns: undefined }))).toThrow(/columns/);
    expect(() => parseFillOp(baseFillOp({ columns: 'x' }))).toThrow(/columns/);
  });

  it('未知列 type / 列不是对象 / 列缺 type', () => {
    expect(() => parseFillOp(baseFillOp({ columns: [{ type: 'magic' }] }))).toThrow(/type/);
    expect(() => parseFillOp(baseFillOp({ columns: ['x'] }))).toThrow(/columns\[0\]/);
    expect(() => parseFillOp(baseFillOp({ columns: [{}] }))).toThrow(/type/);
  });

  it('weights：长度不等 / 含 0 / 含负 / 非数组', () => {
    expect(() =>
      parseFillOp(baseFillOp({ columns: [{ type: 'pick', items: ['a', 'b'], weights: [1] }] })),
    ).toThrow(/weights/);
    expect(() =>
      parseFillOp(baseFillOp({ columns: [{ type: 'pick', items: ['a', 'b'], weights: [0, 1] }] })),
    ).toThrow(/weights/);
    expect(() =>
      parseFillOp(baseFillOp({ columns: [{ type: 'pick', items: ['a', 'b'], weights: [1, -2] }] })),
    ).toThrow(/weights/);
    expect(() =>
      parseFillOp(baseFillOp({ columns: [{ type: 'pick', items: ['a'], weights: 3 }] })),
    ).toThrow(/weights/);
  });

  it('literal values：空数组 / 缺失', () => {
    expect(() => parseFillOp(baseFillOp({ columns: [{ type: 'literal', values: [] }] }))).toThrow(/values/);
    expect(() => parseFillOp(baseFillOp({ columns: [{ type: 'literal' }] }))).toThrow(/values/);
  });

  it('日期：start 晚于 end / 非法格式 / 不存在的日历日 / distribute 非法', () => {
    expect(() =>
      parseFillOp(
        baseFillOp({
          columns: [{ type: 'sequence_date', start: '2026-06-01', end: '2026-01-01', distribute: 'even' }],
        }),
      ),
    ).toThrow(/start/);
    expect(() =>
      parseFillOp(
        baseFillOp({
          columns: [{ type: 'sequence_date', start: '2026/01/01', end: '2026-02-01', distribute: 'even' }],
        }),
      ),
    ).toThrow(/start/);
    expect(() =>
      parseFillOp(
        baseFillOp({
          columns: [{ type: 'sequence_date', start: '2026-01-01', end: '2026-02-30', distribute: 'even' }],
        }),
      ),
    ).toThrow(/end/);
    expect(() =>
      parseFillOp(
        baseFillOp({
          columns: [{ type: 'sequence_date', start: '2026-01-01', end: '2026-03-01', distribute: 'daily' }],
        }),
      ),
    ).toThrow(/distribute/);
  });

  it('随机区间：random_int / random_float min>max；非整数端点；decimals 负数', () => {
    expect(() => parseFillOp(baseFillOp({ columns: [{ type: 'random_int', min: 5, max: 3 }] }))).toThrow(
      /min/,
    );
    expect(() =>
      parseFillOp(baseFillOp({ columns: [{ type: 'random_float', min: 1.5, max: 1.2, decimals: 2 }] })),
    ).toThrow(/min/);
    expect(() =>
      parseFillOp(baseFillOp({ columns: [{ type: 'random_int', min: 1.5, max: 3 }] })),
    ).toThrow(/min/);
    expect(() =>
      parseFillOp(baseFillOp({ columns: [{ type: 'random_float', min: 0, max: 1, decimals: -1 }] })),
    ).toThrow(/decimals/);
  });

  it('anchor 非单格 / sheet 缺失 / seed 非数字', () => {
    expect(() => parseFillOp(baseFillOp({ anchor: 'A1:B2' }))).toThrow(/单格/);
    expect(() => parseFillOp(baseFillOp({ anchor: 'not-a-cell' }))).toThrow(/range/);
    expect(() => parseFillOp(baseFillOp({ sheet: '' }))).toThrow(/sheet/);
    expect(() => parseFillOp(baseFillOp({ seed: 'x' }))).toThrow(/seed/);
  });

  it('fill 到不存在的 sheet：writeXlsxOps 拒（沿用须先 add_sheet 指引）', async () => {
    const abs = path.join(tmpDir, 'e.xlsx');
    fs.writeFileSync(abs, await createXlsx(parseSheetInits(undefined)));
    await expect(
      writeXlsxOps(fs.readFileSync(abs), parseExcelWriteOps([baseFillOp({ sheet: '没有' })])),
    ).rejects.toThrow(/add_sheet/);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// 6. fill + add_chart 同批混排
// ────────────────────────────────────────────────────────────────────────────

describe('fill + add_chart 同批混排', () => {
  it('fill 生成数据 → add_chart 引用生成列 → 图表缓存含生成值', async () => {
    const abs = path.join(tmpDir, 'mix.xlsx');
    fs.writeFileSync(abs, await createXlsx(parseSheetInits([{ name: '数据' }])));
    const ops = parseExcelWriteOps([
      {
        op: 'fill',
        sheet: '数据',
        anchor: 'A1',
        rows: 12,
        seed: 42,
        columns: [
          { type: 'pick', items: ['华东', '华南', '华北'] },
          { type: 'random_int', min: 100, max: 200 },
        ],
      },
      {
        op: 'add_chart',
        sheet: '数据',
        type: 'bar',
        anchor: 'D2',
        categories: { sheet: '数据', range: 'A1:A12' },
        series: [{ values: { sheet: '数据', range: 'B1:B12' } }],
      },
    ]);
    const out = await writeXlsxOps(fs.readFileSync(abs), ops);
    fs.writeFileSync(abs, out);
    // 重读生成值（seed 固定但断言按实际读值构造——同时锁「写入确实落盘」）
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(abs);
    const ws = wb.getWorksheet('数据')!;
    const region = ws.getCell('A1').value;
    const num = ws.getCell('B1').value;
    if (typeof region !== 'string' || typeof num !== 'number') throw new Error('生成列类型不对');
    // 图表部件的 catCache/numCache 含 fill 生成值（证明 fill 结果对同批图表可见）
    const xml = new AdmZip(out).getEntry('xl/charts/chart1.xml')?.getData().toString('utf8') ?? '';
    expect(xml).toContain(`<c:v>${region}</c:v>`);
    expect(xml).toContain(`<c:v>${num}</c:v>`);
    expect(xml).toContain('$A$1:$A$12');
    expect(xml).toContain('$B$1:$B$12');
  });
});
