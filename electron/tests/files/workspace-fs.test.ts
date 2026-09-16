// electron/tests/files/workspace-fs.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { WorkspaceFS } from '../../src/main/files/workspace-fs';

const tmpRoot = path.join(os.tmpdir(), `ap-fs-test-${Date.now()}`);
let wsFs: WorkspaceFS;

beforeEach(() => {
  fs.mkdirSync(path.join(tmpRoot, 'workspace'), { recursive: true });
  wsFs = new WorkspaceFS(path.join(tmpRoot, 'workspace'));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('files/workspace-fs', () => {
  it('assertInWorkspace 允许 workspace 内路径', () => {
    expect(() => wsFs.assertInWorkspace('src/main.ts')).not.toThrow();
    expect(() => wsFs.assertInWorkspace(path.join(wsFs['rootDir'], 'src/app.ts'))).not.toThrow();
  });

  it('assertInWorkspace 拒绝路径穿越', () => {
    expect(() => wsFs.assertInWorkspace('../../../etc/passwd')).toThrow();
    expect(() => wsFs.assertInWorkspace('../../secret')).toThrow();
  });

  it('assertInWorkspace 拒绝绝对路径在 workspace 外', () => {
    expect(() => wsFs.assertInWorkspace('/etc/passwd')).toThrow();
    expect(() => wsFs.assertInWorkspace(path.join(tmpRoot, 'outside'))).toThrow();
  });

  it('writeFile + readFile 往返', async () => {
    await wsFs.writeFile('test.txt', 'hello world');
    const content = await wsFs.readFile('test.txt');
    expect(content.toString()).toBe('hello world');
  });

  it('writeFile 拒绝写到 .git/', async () => {
    await expect(wsFs.writeFile('.git/config', 'evil')).rejects.toThrow();
  });

  it('writeFile 拒绝大写 .GIT/ 变体（macOS 大小写不敏感 FS 绕过防护）', async () => {
    await expect(wsFs.writeFile('.GIT/config', 'evil')).rejects.toThrow();
    await expect(wsFs.writeFile('.Git/hooks/x', 'evil')).rejects.toThrow();
  });

  // I4 连带：`.git` 保护是段精确匹配（`.git` 与其内部子路径），同前缀的
  // `.github` / `.gitattributes` 等正常 dotfile 不误伤。旧实现的字符串前缀
  // startsWith('.git') 把 .github/… 一并拒绝（composer @ 引用第二层撞墙根因）。
  it('writeFile 允许 .github/ 等同前缀 dotfile（段精确匹配不误伤）', async () => {
    await expect(wsFs.writeFile('.github/workflows/ci.yml', 'jobs: {}')).resolves.toBeUndefined();
    await expect(wsFs.writeFile('.gitattributes', '* text=auto')).resolves.toBeUndefined();
    // `.git` 本身与其内部路径仍拒（保护语义不变）
    await expect(wsFs.writeFile('.git/config', 'evil')).rejects.toThrow(/\.git/);
    await expect(wsFs.writeFile('.git-hooks/x.sh', 'ls')).resolves.toBeUndefined();
  });

  it('listDir 返回文件和子目录', async () => {
    await wsFs.writeFile('a.txt', 'a');
    await wsFs.writeFile('b.txt', 'b');
    fs.mkdirSync(path.join(wsFs['rootDir'], 'subdir'), { recursive: true });
    const entries = await wsFs.listDir('.');
    expect(entries.map((e) => e.name).sort()).toEqual(['a.txt', 'b.txt', 'subdir']);
  });

  it('exists 检查文件存在', async () => {
    await wsFs.writeFile('exists.txt', 'yes');
    expect(await wsFs.exists('exists.txt')).toBe(true);
    expect(await wsFs.exists('no.txt')).toBe(false);
  });
});
