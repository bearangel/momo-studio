// electron/tests/files/workspace-fs-search.test.ts
//
// WorkspaceFS.searchNames 专项测试（spec §5.1 / §7.1）：
// 递归文件名搜索——嵌套命中、大小写、子串、目录命中、.git*/node_modules
// 排除（与 listDir 一致）、符号链接目录不进入、双上限、空 query。
// 全部用真实临时目录 + 真实 fs（无 mock，momo-test-rules 第 5 条）。
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
  it('空 query 返回 []', async () => {
    put('a.ts');
    await expect(wsFs.searchNames('')).resolves.toEqual([]);
    await expect(wsFs.searchNames('   ')).resolves.toEqual([]);
  });

  it('嵌套目录中的文件按名命中，path 含目录前缀（/ 分隔）', async () => {
    put('src/foo.ts');
    await expect(wsFs.searchNames('foo')).resolves.toEqual([
      { path: 'src/foo.ts', isDirectory: false },
    ]);
  });

  it('大小写不敏感（query 大写命中小写文件名）', async () => {
    put('src/foo.ts');
    await expect(wsFs.searchNames('FOO')).resolves.toEqual([
      { path: 'src/foo.ts', isDirectory: false },
    ]);
  });

  it('子串包含（非前缀匹配）', async () => {
    put('docs/nested/deep_note.md');
    await expect(wsFs.searchNames('note')).resolves.toEqual([
      { path: 'docs/nested/deep_note.md', isDirectory: false },
    ]);
  });

  it('目录名命中返回 isDirectory: true（目录本身参与匹配）', async () => {
    put('src/foo.ts');
    await expect(wsFs.searchNames('src')).resolves.toEqual([
      { path: 'src', isDirectory: true },
    ]);
  });

  it('.git* 前缀条目不进入不返回（与 listDir 过滤一致）', async () => {
    put('.git/config');
    put('.gitignore');
    put('regular.ts');
    await expect(wsFs.searchNames('git')).resolves.toEqual([]);
    await expect(wsFs.searchNames('regular')).resolves.toEqual([
      { path: 'regular.ts', isDirectory: false },
    ]);
  });

  it('node_modules 不进入', async () => {
    put('node_modules/pkg/index.js');
    put('app.js');
    await expect(wsFs.searchNames('index')).resolves.toEqual([]);
    await expect(wsFs.searchNames('app')).resolves.toEqual([
      { path: 'app.js', isDirectory: false },
    ]);
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
    const hits = await wsFs.searchNames('target');
    // real/target.txt 命中一次；loopdir 不进入（否则 target.txt 会被重复收集）
    await expect(hits).toEqual([{ path: 'real/target.txt', isDirectory: false }]);
    const linkHits = await wsFs.searchNames('link');
    await expect(linkHits).toEqual([{ path: 'link.txt', isDirectory: false }]);
  });

  it('limit 截断：命中数超过 limit 时只返回前 limit 条', async () => {
    for (let i = 0; i < 5; i++) put(`match${i}.ts`);
    const hits = await wsFs.searchNames('match', 3);
    expect(hits).toHaveLength(3);
    expect(hits.every((h) => h.path.startsWith('match'))).toBe(true);
  });

  it('遍历条目总数上限触发时安全返回已有结果（不依赖 readdir 顺序）', async () => {
    put('match1.ts');
    put('match2.ts');
    // traversalCap=1：只看第一个条目 → 恰好 1 条命中（无论先看到哪个）
    const hits = await wsFs.searchNames('match', 200, 1);
    expect(hits).toHaveLength(1);
    // traversalCap=2：两个条目都看到 → 2 条
    const hits2 = await wsFs.searchNames('match', 200, 2);
    expect(hits2).toHaveLength(2);
  });
});
