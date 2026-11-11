// electron/tests/files/workspace-fs-search.test.ts
//
// WorkspaceFS.searchNames 专项测试（spec §5.1 / §7.1）：
// 递归文件名搜索——嵌套命中、大小写、子串、目录命中、.git*/node_modules
// 排除（与 listDir 一致）、符号链接目录不进入、双上限、空 query。
// 全部用真实临时目录 + 真实 fs（无 mock，momo-test-rules 第 5 条）。
//
// 2026-11-11（方案 C）：返回形状改为 `{ hits, truncated }`；遍历预算从
// 「条目数 10000」改为「时间预算 1500ms + 20 万条绝对兜底」——旧条目数预算在
// DFS 顺序下会被单个大目录吃光（ws2 `.momo-scratch` 11,604 条），后续目录
// 永不访问 → 静默 0 命中（本文件「大目录回归锁」用例）。truncated 只表达
// 「遍历预算提前结束」，结果数达到 limit 属正常截断（truncated=false）。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { WorkspaceFS } from '../../src/main/files/workspace-fs';

const tmpRoot = path.join(os.tmpdir(), `ap-fs-search-test-${Date.now()}`);
let wsFs: WorkspaceFS;

beforeEach(() => {
  fs.mkdirSync(path.join(tmpRoot, 'workspace'), { recursive: true });
  wsFs = new WorkspaceFS(path.join(tmpRoot, 'workspace'));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

/** 在 workspace 内写文件（自动建父目录） */
function put(rel: string, content = ''): void {
  const abs = path.join(wsFs['rootDir'], rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

describe('files/workspace-fs searchNames', () => {
  it('空 query = match-all 全量列举（2026-11-05：文件按钮限定菜单数据源；含目录行）', async () => {
    put('a.ts');
    put('src/deep/b.md');
    const { hits, truncated } = await wsFs.searchNames('');
    expect(hits).toEqual(
      expect.arrayContaining([
        { path: 'a.ts', isDirectory: false },
        { path: 'src', isDirectory: true },
        { path: 'src/deep', isDirectory: true },
        { path: 'src/deep/b.md', isDirectory: false },
      ]),
    );
    expect(hits).toHaveLength(4);
    expect(truncated).toBe(false);
    // 纯空白等价空 query
    const blank = await wsFs.searchNames('   ');
    expect(blank.hits).toHaveLength(4);
    expect(blank.truncated).toBe(false);
  });

  it('嵌套目录中的文件按名命中，path 含目录前缀（/ 分隔）', async () => {
    put('src/foo.ts');
    const { hits, truncated } = await wsFs.searchNames('foo');
    expect(hits).toEqual([{ path: 'src/foo.ts', isDirectory: false }]);
    expect(truncated).toBe(false);
  });

  it('大小写不敏感（query 大写命中小写文件名）', async () => {
    put('src/foo.ts');
    await expect(wsFs.searchNames('FOO')).resolves.toEqual({
      hits: [{ path: 'src/foo.ts', isDirectory: false }],
      truncated: false,
    });
  });

  it('子串包含（非前缀匹配）', async () => {
    put('docs/nested/deep_note.md');
    await expect(wsFs.searchNames('note')).resolves.toEqual({
      hits: [{ path: 'docs/nested/deep_note.md', isDirectory: false }],
      truncated: false,
    });
  });

  it('目录名命中返回 isDirectory: true，且其下文件按路径命中（2026-11-11 路径匹配）', async () => {
    put('src/foo.ts');
    const { hits } = await wsFs.searchNames('src');
    expect(hits).toEqual([
      { path: 'src', isDirectory: true },
      { path: 'src/foo.ts', isDirectory: false },
    ]);
  });

  it('输入目录名 → 其下文件全部命中；输入 `dir/` → 只列该目录内容', async () => {
    put('shell/dev-build.sh');
    const byDirName = await wsFs.searchNames('shell');
    expect(byDirName.hits).toEqual([
      { path: 'shell', isDirectory: true },
      { path: 'shell/dev-build.sh', isDirectory: false },
    ]);
    // 尾斜杠：目录自身路径不含 'shell/'，只剩其子项（钻入语义）
    const byPrefix = await wsFs.searchNames('shell/');
    expect(byPrefix.hits).toEqual([{ path: 'shell/dev-build.sh', isDirectory: false }]);
    // 继续收窄到文件
    const narrowed = await wsFs.searchNames('shell/dev');
    expect(narrowed.hits).toEqual([{ path: 'shell/dev-build.sh', isDirectory: false }]);
  });

  it('排序：basename 命中优先于纯路径命中，同级目录优先于文件', async () => {
    put('a.ts');
    put('za/bx.ts');
    put('adir/keep.txt');
    const { hits } = await wsFs.searchNames('a');
    // a.ts（basename 命中）先于 adir（basename 命中且目录）之外的一切纯路径命中
    const paths = hits.map((h) => h.path);
    expect(paths.indexOf('a.ts')).toBeLessThan(paths.indexOf('za/bx.ts'));
    expect(paths.indexOf('adir')).toBeLessThan(paths.indexOf('za/bx.ts'));
    // 同级（都命中 basename='a'）目录排在文件前
    expect(paths.indexOf('adir')).toBeLessThan(paths.indexOf('a.ts'));
  });

  it('.git* 前缀条目不进入不返回（与 listDir 过滤一致）', async () => {
    put('.git/config');
    put('.gitignore');
    put('regular.ts');
    await expect(wsFs.searchNames('git')).resolves.toEqual({ hits: [], truncated: false });
    await expect(wsFs.searchNames('regular')).resolves.toEqual({
      hits: [{ path: 'regular.ts', isDirectory: false }],
      truncated: false,
    });
  });

  it('node_modules 不进入', async () => {
    put('node_modules/pkg/index.js');
    put('app.js');
    await expect(wsFs.searchNames('index')).resolves.toEqual({ hits: [], truncated: false });
    await expect(wsFs.searchNames('app')).resolves.toEqual({
      hits: [{ path: 'app.js', isDirectory: false }],
      truncated: false,
    });
  });

  it('符号链接目录不递归进入（防环防逃逸），符号链接文件按普通条目匹配', async () => {
    put('real/target.txt');
    // 符号链接目录：指向 workspace 根（若进入会无限递归）
    fs.symlinkSync(wsFs['rootDir'], path.join(wsFs['rootDir'], 'loopdir'), 'dir');
    // 符号链接文件：指向已有文件
    fs.symlinkSync(
      path.join(wsFs['rootDir'], 'real/target.txt'),
      path.join(wsFs['rootDir'], 'link.txt'),
      'file',
    );
    const { hits } = await wsFs.searchNames('target');
    // real/target.txt 命中一次；loopdir 不进入（否则 target.txt 会被重复收集）
    expect(hits).toEqual([{ path: 'real/target.txt', isDirectory: false }]);
    const linkHits = await wsFs.searchNames('link');
    expect(linkHits.hits).toEqual([{ path: 'link.txt', isDirectory: false }]);
  });

  it('limit 截断：命中数超过 limit 时只返回前 limit 条（属正常截断，truncated=false）', async () => {
    for (let i = 0; i < 5; i++) put(`match${i}.ts`);
    const { hits, truncated } = await wsFs.searchNames('match', 3);
    expect(hits).toHaveLength(3);
    expect(hits.every((h) => h.path.startsWith('match'))).toBe(true);
    // 结果数达上限即停是正常语义——不等于「遍历预算耗尽」
    expect(truncated).toBe(false);
  });

  it('条目数绝对兜底触发时安全返回已有结果并标记 truncated', async () => {
    put('match1.ts');
    put('match2.ts');
    // traversalCap=1：只看第一个条目 → 恰好 1 条命中（无论先看到哪个）+ truncated
    const one = await wsFs.searchNames('match', 200, 60_000, 1);
    expect(one.hits).toHaveLength(1);
    expect(one.truncated).toBe(true);
    // traversalCap=2：两个条目都看到 → 2 条，未触发兜底
    const two = await wsFs.searchNames('match', 200, 60_000, 2);
    expect(two.hits).toHaveLength(2);
    expect(two.truncated).toBe(false);
  });

  it('大目录回归锁（2026-11-11）：单目录超过旧 10000 条预算后，后续目录/根文件仍可命中', async () => {
    // 旧实现：DFS 先进 a-dense/，10,000 条预算在此耗尽 → zzz-root.txt 永不访问
    const dense = path.join(wsFs['rootDir'], 'a-dense');
    fs.mkdirSync(dense, { recursive: true });
    for (let i = 0; i < 10_050; i++) {
      fs.writeFileSync(path.join(dense, `f${i}.bin`), '');
    }
    put('zzz-root.txt');
    put('zzz-later/needle.txt');

    // 显式放宽时间预算：本用例锁的是「条目数预算」回归（DFS 大目录吃光预算），
    // 不锁 wall-clock——CI 慢盘上默认 1500ms 会抖动（默认预算由真机探针验收）
    const rootHit = await wsFs.searchNames('zzz-root', 200, 60_000);
    expect(rootHit.hits).toEqual([{ path: 'zzz-root.txt', isDirectory: false }]);
    expect(rootHit.truncated).toBe(false);

    const deepHit = await wsFs.searchNames('needle', 200, 60_000);
    expect(deepHit.hits).toEqual([{ path: 'zzz-later/needle.txt', isDirectory: false }]);
    expect(deepHit.truncated).toBe(false);
  }, 60_000);
});
