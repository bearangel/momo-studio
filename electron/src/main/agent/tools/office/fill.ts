// fill 数据生成 op 引擎（spec §14.7，2026-09-21 第三轮会话增补）：声明式生成
// 模拟/批量数据，消灭 agent 手写大数组的形状失控与内容污染（→ 外逃 Python）。
// 纯逻辑模块——窄化（parseFillOp）与生成（generateFillRows）都在内存完成，
// xlsx 落格由 excel.ts writeXlsxOps 复用 set_cells 逐格写入机制。
// 确定性：mulberry32 PRNG，同 seed 同参数逐字节复现；每列种子混入列索引
//（黄金比例常数）防列间序列相关。日期一律 UTC 毫秒差 / 86400000 取整，无时区坑。

import type { CellInput } from './excel';
import { parseRange, asString, asStringArray } from './format';

/** 七型列生成器规格（spec §14.7） */
export type FillColumn =
  | { type: 'sequence_date'; start: string; end: string; distribute: 'even' | 'random' }
  | { type: 'sequence_number'; start: number; step: number }
  | { type: 'random_int'; min: number; max: number }
  | { type: 'random_float'; min: number; max: number; decimals: number }
  | { type: 'pick'; items: string[]; weights?: number[] }
  | { type: 'literal'; values: string[] }
  | { type: 'formula'; template: string };

export interface FillSpec {
  sheet: string;
  /** 单格左上角锚点（A1 记法），生成区域按 rows × columns.length 向右下展开 */
  anchor: string;
  rows: number;
  seed: number;
  columns: FillColumn[];
}

/** rows 上限（防误传，spec §14.7） */
export const FILL_MAX_ROWS = 50000;
/** seed 省略值（spec §14.7） */
export const FILL_DEFAULT_SEED = 42;

const MS_PER_DAY = 86400000;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 窄化原语：有限数字或抛错（中文错误含字段路径） */
function asFiniteNumber(v: unknown, what: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new Error(`参数 ${what} 缺失或不是有限数字`);
  }
  return v;
}

/** 窄化原语：整数或抛错 */
function asInt(v: unknown, what: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v)) {
    throw new Error(`参数 ${what} 缺失或不是整数`);
  }
  return v;
}

/** ISO 'YYYY-MM-DD' → UTC 毫秒；拒绝格式错误与不存在的日历日（如 2026-02-30）。
 *  校验用 Date.UTC 构造 + ISO 往返比对——V8 对 '2026-02-30T…Z' 会静默回滚到
 *  3 月 2 日（Date.parse 非 NaN），必须往返才能抓住越界日。 */
function parseIsoDate(v: string, what: string): number {
  if (!ISO_DATE_RE.test(v)) throw new Error(`参数 ${what} 不是 YYYY-MM-DD 日期: "${v}"`);
  const [y, mo, d] = v.split('-').map(Number);
  const ms = Date.UTC(y!, mo! - 1, d!);
  if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== v) {
    throw new Error(`参数 ${what} 不是合法日期: "${v}"`);
  }
  return ms;
}

/** UTC 毫秒 → ISO 'YYYY-MM-DD' */
function toIsoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** mulberry32 PRNG：uint32 种子 → [0,1) 均匀序列；同种子逐字节复现 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 单列窄化（parseFillOp 内部逐列调用） */
function parseFillColumn(raw: unknown, what: string): FillColumn {
  if (typeof raw !== 'object' || raw === null) throw new Error(`参数 ${what} 不是对象`);
  const rec = raw as Record<string, unknown>;
  switch (rec.type) {
    case 'sequence_date': {
      const startStr = asString(rec.start, `${what}.start`);
      const endStr = asString(rec.end, `${what}.end`);
      const start = parseIsoDate(startStr, `${what}.start`);
      const end = parseIsoDate(endStr, `${what}.end`);
      if (start > end) throw new Error(`参数 ${what}.start 晚于 end（日期区间非法）`);
      const distribute = rec.distribute;
      if (distribute !== 'even' && distribute !== 'random') {
        throw new Error(`参数 ${what}.distribute 非法（支持 even / random）`);
      }
      return { type: 'sequence_date', start: startStr, end: endStr, distribute };
    }
    case 'sequence_number':
      return {
        type: 'sequence_number',
        start: asFiniteNumber(rec.start, `${what}.start`),
        step: asFiniteNumber(rec.step, `${what}.step`),
      };
    case 'random_int': {
      const min = asInt(rec.min, `${what}.min`);
      const max = asInt(rec.max, `${what}.max`);
      if (min > max) throw new Error(`参数 ${what}.min 大于 max（数值区间非法）`);
      return { type: 'random_int', min, max };
    }
    case 'random_float': {
      const min = asFiniteNumber(rec.min, `${what}.min`);
      const max = asFiniteNumber(rec.max, `${what}.max`);
      if (min > max) throw new Error(`参数 ${what}.min 大于 max（数值区间非法）`);
      const decimals = asInt(rec.decimals, `${what}.decimals`);
      if (decimals < 0) throw new Error(`参数 ${what}.decimals 必须是非负整数`);
      return { type: 'random_float', min, max, decimals };
    }
    case 'pick': {
      const items = asStringArray(rec.items, `${what}.items`);
      if (items.length === 0) throw new Error(`参数 ${what}.items 不能为空`);
      let weights: number[] | undefined;
      if (rec.weights !== undefined) {
        if (!Array.isArray(rec.weights)) throw new Error(`参数 ${what}.weights 不是数组`);
        if (rec.weights.length !== items.length) {
          throw new Error(
            `参数 ${what}.weights 必须与 items 等长（items ${items.length} 个，weights ${rec.weights.length} 个）`,
          );
        }
        weights = rec.weights.map((w, k) => {
          const n = asFiniteNumber(w, `${what}.weights[${k}]`);
          if (n <= 0) throw new Error(`参数 ${what}.weights[${k}] 必须是正数`);
          return n;
        });
      }
      return weights === undefined ? { type: 'pick', items } : { type: 'pick', items, weights };
    }
    case 'literal': {
      const values = asStringArray(rec.values, `${what}.values`);
      if (values.length === 0) throw new Error(`参数 ${what}.values 不能为空`);
      return { type: 'literal', values };
    }
    case 'formula':
      return { type: 'formula', template: asString(rec.template, `${what}.template`) };
    default:
      throw new Error(
        `参数 ${what}.type 未知（支持 sequence_date / sequence_number / random_int / random_float / pick / literal / formula）`,
      );
  }
}

/** fill op 参数窄化：全部错误路径在此校验（中文文案含字段路径）。
 *  what：可选前缀（如 'ops[2]'）— 加在每条错误文案字段路径前，excel.ts 侧传递 op
 *  索引便于用户定位是哪一项 ops 报错；省略时保持纯函数文案不变（纯函数测试合约）。
 *  纯函数幂等——已窄化的 FillSpec 再解析结果一致（writeXlsxOps 侧复用）。 */
export function parseFillOp(raw: Record<string, unknown>, what = ''): FillSpec {
  const path = (field: string): string => (what === '' ? field : `${what}.${field}`);
  const sheet = asString(raw.sheet, path('sheet'));
  const anchor = asString(raw.anchor, path('anchor'));
  const a = parseRange(anchor);
  if (a.endRow !== null || a.endCol !== null) {
    throw new Error(`参数 ${path('anchor')} 必须是单格左上角（如 A2），收到: "${anchor}"`);
  }
  const rows = raw.rows;
  if (typeof rows !== 'number' || !Number.isInteger(rows) || rows < 1 || rows > FILL_MAX_ROWS) {
    throw new Error(`参数 ${path('rows')} 必须是 1..${FILL_MAX_ROWS} 的整数`);
  }
  let seed = FILL_DEFAULT_SEED;
  if (raw.seed !== undefined) {
    const s = asFiniteNumber(raw.seed, path('seed'));
    seed = s >>> 0; // 归一 uint32（负数/小数截断，mulberry32 定义域）
  }
  if (!Array.isArray(raw.columns) || raw.columns.length === 0) {
    throw new Error(`参数 ${path('columns')} 缺失或不是非空数组`);
  }
  const columns = raw.columns.map((c, i) => parseFillColumn(c, path(`columns[${i}]`)));
  return { sheet, anchor, rows, seed, columns };
}

/** 单列生成（generateFillRows 内部逐列调用；rand 已绑定该列种子） */
function generateColumn(
  col: FillColumn,
  rows: number,
  anchorRow: number,
  rand: () => number,
): CellInput[] {
  switch (col.type) {
    case 'sequence_date': {
      const start = parseIsoDate(col.start, 'columns.start'); // parse 已校验，此处仅取毫秒
      const spanDays = Math.round((parseIsoDate(col.end, 'columns.end') - start) / MS_PER_DAY);
      if (col.distribute === 'even') {
        // start..end 均分 rows 个点（含首尾）；rows=1 取 start
        return Array.from({ length: rows }, (_, i) =>
          toIsoDate(start + (rows === 1 ? 0 : Math.round((spanDays * i) / (rows - 1))) * MS_PER_DAY),
        );
      }
      // random：[start,end] 日粒度随机（可重复）
      return Array.from({ length: rows }, () =>
        toIsoDate(start + Math.floor(rand() * (spanDays + 1)) * MS_PER_DAY),
      );
    }
    case 'sequence_number':
      // 显式 start + i*step（非增量累加，避免浮点漂移）
      return Array.from({ length: rows }, (_, i) => col.start + i * col.step);
    case 'random_int':
      // 闭区间 [min,max]：floor(rand()*(max-min+1)) ∈ [0, max-min]
      return Array.from({ length: rows }, () => col.min + Math.floor(rand() * (col.max - col.min + 1)));
    case 'random_float': {
      const factor = 10 ** col.decimals;
      return Array.from(
        { length: rows },
        () => Math.round((col.min + rand() * (col.max - col.min)) * factor) / factor,
      );
    }
    case 'pick': {
      const pickOne = (): string => {
        if (col.weights === undefined) {
          return col.items[Math.floor(rand() * col.items.length)]!;
        }
        // 累积权重法：r ∈ [0,total) 落入哪段累积区间取哪项
        const total = col.weights.reduce((s, w) => s + w, 0);
        let r = rand() * total;
        for (let k = 0; k < col.weights.length; k++) {
          r -= col.weights[k]!;
          if (r < 0) return col.items[k]!;
        }
        return col.items[col.items.length - 1]!; // 浮点余量兜底（r 恰未为负）
      };
      return Array.from({ length: rows }, pickOne);
    }
    case 'literal':
      // 循环取用：values[i % len]
      return Array.from({ length: rows }, (_, i) => col.values[i % col.values.length]!);
    case 'formula': {
      // {row} 全部替换为该行实际绝对行号（anchor 行 + i）；前导 '=' 剥离（exceljs 约定）
      const tpl = col.template.replace(/^=/, '');
      return Array.from({ length: rows }, (_, i) => ({
        formula: tpl.replace(/\{row\}/g, String(anchorRow + i)),
      }));
    }
  }
}

/** 生成 rows × columns.length 矩阵；每列独立 PRNG（种子混入列索引防列间相关） */
export function generateFillRows(spec: FillSpec): CellInput[][] {
  const anchorRow = parseRange(spec.anchor).startRow;
  const byColumn = spec.columns.map((col, ci) => {
    const rand = mulberry32((spec.seed ^ Math.imul(ci + 1, 0x9e3779b9)) >>> 0);
    return generateColumn(col, spec.rows, anchorRow, rand);
  });
  const out: CellInput[][] = [];
  for (let r = 0; r < spec.rows; r++) {
    const row: CellInput[] = [];
    for (const col of byColumn) row.push(col[r]!);
    out.push(row);
  }
  return out;
}
