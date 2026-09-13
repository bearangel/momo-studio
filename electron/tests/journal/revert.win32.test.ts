// electron/tests/journal/revert.win32.test.ts
//
// revert 边界判定（safeResolve，v2.10 T2 :95 段）的 win32 语义测试。
// 模板来源：tests/platform/paths.win32.test.ts 文件头。
//
// 被测面是纯字符串边界函数 safeResolve（resolve + 前缀比对），不触 fs——
// 无需 mock node:fs，仅 mock node:path 为 win32。越界三形态（brief Step 1）：
// 大小写混合命中 / '..\\' 穿越拒 / 异盘拒。revertEntries 的逆序链与 hash
// 守卫语义由 revert.test.ts 既有 posix 用例覆盖（两测试面正交）。
import { describe, it, expect, vi } from 'vitest';
import { safeResolve } from '../../src/main/journal/revert';

vi.mock('node:path', async () => {
  const actual = await vi.importActual<typeof import('node:path')>('node:path');
  return { default: actual.win32, ...actual.win32 };
});

describe('journal safeResolve（win32 语义）', () => {
  it('大小写混合绝对路径条目命中：返回 resolve 后原大小写路径', () => {
    expect(safeResolve('C:\\WS', 'c:\\ws\\a.txt')).toBe('c:\\ws\\a.txt');
  });

  it("相对条目 '..' 穿越拒绝", () => {
    expect(() => safeResolve('C:\\WS', '..\\outside\\a.txt')).toThrow('journal 条目路径越界');
  });

  it('异盘绝对条目拒绝', () => {
    expect(() => safeResolve('C:\\WS', 'd:\\outside\\a.txt')).toThrow('journal 条目路径越界');
  });

  it('常规相对条目与根自身', () => {
    expect(safeResolve('C:\\WS', 'a\\b.txt')).toBe('C:\\WS\\a\\b.txt');
    expect(safeResolve('C:\\WS', '.')).toBe('C:\\WS');
  });
});
