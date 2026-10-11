// renderer/src/components/files/sort-entries.test.ts
// 排序契约：目录优先 + 自然排序 + 大小写不敏感 + 确定性；空输入原样返回。
import { describe, it, expect } from 'vitest';
import { sortDirEntries, sortSearchHits } from './sort-entries';
import type { DirEntry, SearchHit } from '../../ipc/types';

const file = (name: string): DirEntry => ({ name, isDirectory: false, size: 1 });
const dir = (name: string): DirEntry => ({ name, isDirectory: true, size: 0 });

describe('sortDirEntries', () => {
  it('目录排在所有文件之前', () => {
    const sorted = sortDirEntries([file('a.ts'), dir('zeta'), file('b.ts'), dir('alpha')]);
    expect(sorted.map((e) => e.name)).toEqual(['alpha', 'zeta', 'a.ts', 'b.ts']);
  });

  it('组内自然排序：foo2 排在 foo10 之前（数字段按数值）', () => {
    const sorted = sortDirEntries([file('foo10.ts'), file('foo2.ts'), file('foo1.ts')]);
    expect(sorted.map((e) => e.name)).toEqual(['foo1.ts', 'foo2.ts', 'foo10.ts']);
  });

  it('大小写不敏感：B.md 紧邻 a.md / b.md 排序，不被推到队首', () => {
    const sorted = sortDirEntries([file('B.md'), file('a.md'), file('b.md')]);
    expect(sorted.map((e) => e.name)).toEqual(['a.md', 'B.md', 'b.md']);
  });

  it('仅大小写差异时结果确定（码元序 tiebreak，多次调用一致）', () => {
    const input = [file('readme.md'), file('Readme.md')];
    const first = sortDirEntries(input).map((e) => e.name);
    const second = sortDirEntries(input).map((e) => e.name);
    expect(first).toEqual(second);
  });

  it('空数组返回空数组', () => {
    expect(sortDirEntries([])).toEqual([]);
  });

  it('不 mutate 入参（原数组顺序保持）', () => {
    const input = [file('b'), file('a')];
    sortDirEntries(input);
    expect(input.map((e) => e.name)).toEqual(['b', 'a']);
  });
});

describe('sortSearchHits', () => {
  const hit = (path: string, isDirectory: boolean): SearchHit => ({ path, isDirectory });

  it('目录命中排在文件命中之前，组内按路径自然排序', () => {
    const sorted = sortSearchHits([
      hit('src/z.ts', false),
      hit('docs', true),
      hit('src/a.ts', false),
      hit('assets', true),
    ]);
    expect(sorted.map((h) => h.path)).toEqual(['assets', 'docs', 'src/a.ts', 'src/z.ts']);
  });

  it('空输入返回空数组', () => {
    expect(sortSearchHits([])).toEqual([]);
  });
});
