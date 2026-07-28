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
