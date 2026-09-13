// electron/tests/platform/paths.test.ts
// posix 原生语义测试：isInsideDir 与既有手工形态等价性 + toPosixRelPath 断言。
//
// 等价性基准 = 已转换模块内联的手工边界判定（workspace-fs.ts / browser/protocol.ts /
// browser/policy.ts / journal/revert.ts 等，六模块七处）：
//   resolve(c) === resolve(r) || resolve(c).startsWith(resolve(r) + path.sep)
// 勘误（终审 I2）：旧头注释曾把 skill/zip-uploader.ts 列为等价基准——该声明撤回，
// zip-uploader 从未转换（v2.10 圈定在边界模块适用域外，存量手工形态记 v2.10.x
// 待办收敛，见 engineering.md 唯一入口规则的适用域注记）。
// 本文件在边界 + 随机组合下断言 helper 与该手工形态结果一致——T2 逐模块替换的行为锁。
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { isInsideDir, toPosixRelPath } from '../../src/main/platform/paths';

/** 既有手工形态（五模块内联基准的实现拷贝）——等价性对照用，勿随 helper 改动 */
function manualInside(root: string, child: string): boolean {
  const r = path.resolve(root);
  const c = path.resolve(child);
  return c === r || c.startsWith(r + path.sep);
}

/** git-tools.ts 内联的 toPosix 手工形态——toPosixRelPath 的等价性基准 */
function manualToPosix(root: string, absPath: string): string {
  return path.relative(root, absPath).split(path.sep).join('/');
}

/** 确定性伪随机（mulberry32）：随机组合跨运行可复现，防 flake */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 段池：普通段 / 点前缀文件名 / 空格 / CJK / 穿越段 / 冗余段——覆盖真实路径形态 */
const SEGMENTS = ['a', 'bb', 'ccc', 'x.txt', '..foo.txt', 'dir.d', 'sp ace', '子目录', '..', '.'];

/** 随机拼一条路径：约七成绝对（前导 '/'）、三成相对，段数 1-5 */
function randomPath(rand: () => number): string {
  const parts: string[] = [];
  if (rand() < 0.7) parts.push('');
  const n = 1 + Math.floor(rand() * 5);
  for (let i = 0; i < n; i++) {
    parts.push(SEGMENTS[Math.floor(rand() * SEGMENTS.length)] ?? 'a');
  }
  return parts.join('/');
}

/** 边界组合表：语义直接断言（锁定预期值）+ 等价性断言（对照手工形态）共用 */
const BOUNDARY_CASES: Array<{ root: string; child: string; expected: boolean; note: string }> = [
  { root: '/ws', child: '/ws', expected: true, note: '自身' },
  { root: '/ws', child: '/ws/a/b.txt', expected: true, note: '深层子文件' },
  { root: '/ws', child: '/ws/..foo.txt', expected: true, note: '点前缀文件名（真在目录内）' },
  { root: '/ws', child: '/wsfoo.txt', expected: false, note: '兄弟前缀碰撞（不误伤的关键用例）' },
  { root: '/ws', child: '/ws/../etc/passwd', expected: false, note: "'..' 穿越出根" },
  { root: '/ws', child: '/ws/./a', expected: true, note: "'.' 冗余段" },
  { root: '/ws/', child: '/ws/a', expected: true, note: 'root 尾分隔符（resolve 归一后相等）' },
  { root: '/ws', child: '/ws/./', expected: true, note: 'child 尾分隔符' },
  { root: '/a/b', child: '/a/bc/x', expected: false, note: '目录名前缀段碰撞' },
  { root: '/a/b', child: '/a', expected: false, note: '反向（父目录不在子内）' },
  { root: '/ws', child: '/other/x', expected: false, note: '无关树' },
  { root: 'ws', child: 'ws/x', expected: true, note: '相对路径形态（resolve 对齐 cwd）' },
  { root: '/ws/a/b', child: '/ws/a/b', expected: true, note: '深层自身' },
];

describe('isInsideDir（posix 原生）', () => {
  it('边界组合：语义直接断言', () => {
    for (const { root, child, expected, note } of BOUNDARY_CASES) {
      expect(isInsideDir(root, child), `边界用例失败: ${note} (root=${root} child=${child})`).toBe(expected);
    }
  });

  it('边界组合：与既有手工形态等价', () => {
    for (const { root, child } of BOUNDARY_CASES) {
      expect(isInsideDir(root, child)).toBe(manualInside(root, child));
    }
  });

  it('随机组合：与既有手工形态等价（500 组固定种子）', () => {
    const rand = mulberry32(20260912);
    for (let i = 0; i < 500; i++) {
      const root = randomPath(rand);
      const child = randomPath(rand);
      expect(
        isInsideDir(root, child),
        `随机用例 #${i} 不等价 (root=${root} child=${child})`,
      ).toBe(manualInside(root, child));
    }
  });

  it('非法输入返回 false（空串 / 非串——IPC 与 JSON 边界未受信输入）', () => {
    expect(isInsideDir('', '/x')).toBe(false);
    expect(isInsideDir('/x', '')).toBe(false);
    // strict TS 下用双重断言构造非法运行时值（非 as any），模拟外部边界传入
    expect(isInsideDir(undefined as unknown as string, '/x')).toBe(false);
    expect(isInsideDir('/x', 42 as unknown as string)).toBe(false);
    expect(isInsideDir(null as unknown as string, null as unknown as string)).toBe(false);
  });
});

describe('toPosixRelPath（posix 原生）', () => {
  it('基本形态', () => {
    expect(toPosixRelPath('/ws', '/ws/a/b')).toBe('a/b');
    expect(toPosixRelPath('/ws', '/ws')).toBe('');
    expect(toPosixRelPath('/a/b', '/a')).toBe('..');
    expect(toPosixRelPath('/ws', '/other/x')).toBe('../other/x');
    expect(toPosixRelPath('/ws', '/ws/a/b/c/d.txt')).toBe('a/b/c/d.txt');
  });

  it('随机组合：与 git-tools 既有 split/join 手工形态等价（500 组固定种子）', () => {
    const rand = mulberry32(417711);
    for (let i = 0; i < 500; i++) {
      const root = randomPath(rand);
      const absPath = randomPath(rand);
      expect(
        toPosixRelPath(root, absPath),
        `随机用例 #${i} 不等价 (root=${root} absPath=${absPath})`,
      ).toBe(manualToPosix(root, absPath));
    }
  });
});
