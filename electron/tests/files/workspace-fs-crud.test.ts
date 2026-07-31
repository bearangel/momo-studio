// WorkspaceFS create/delete/rename 单测（真实临时 workspace 目录）
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { WorkspaceFS } from '../../src/main/files/workspace-fs';

const tmp = path.join(os.tmpdir(), `ap-wsfs-crud-${Date.now()}`);
let wfs: WorkspaceFS;

beforeEach(() => {
  fs.mkdirSync(tmp, { recursive: true });
  wfs = new WorkspaceFS(tmp);
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('WorkspaceFS CRUD', () => {
  it('createFile 创建空文件', async () => {
    await wfs.createFile('a.txt');
    const stat = fs.statSync(path.join(tmp, 'a.txt'));
    expect(stat.isFile()).toBe(true);
    expect(stat.size).toBe(0);
  });

  it('createDir 递归创建目录', async () => {
    await wfs.createDir('x/y');
    expect(fs.statSync(path.join(tmp, 'x', 'y')).isDirectory()).toBe(true);
  });

  it('deletePath 删文件', async () => {
    await wfs.createFile('a.txt');
    await wfs.deletePath('a.txt');
    expect(fs.existsSync(path.join(tmp, 'a.txt'))).toBe(false);
  });

  it('deletePath 递归删目录', async () => {
    await wfs.createDir('d');
    await wfs.createFile('d/a.txt');
    await wfs.deletePath('d');
    expect(fs.existsSync(path.join(tmp, 'd'))).toBe(false);
  });

  it('rename 同级改名', async () => {
    await wfs.createFile('old.txt');
    await wfs.rename('old.txt', 'new.txt');
    expect(fs.existsSync(path.join(tmp, 'old.txt'))).toBe(false);
    expect(fs.existsSync(path.join(tmp, 'new.txt'))).toBe(true);
  });

  it('rename 跨目录移动', async () => {
    await wfs.createDir('dst');
    await wfs.createFile('src.txt');
    await wfs.rename('src.txt', 'dst/moved.txt');
    expect(fs.existsSync(path.join(tmp, 'dst', 'moved.txt'))).toBe(true);
  });

  it('路径越界（..）抛错', async () => {
    await expect(wfs.createFile('../escape.txt')).rejects.toThrow(/越界|escape/);
  });

  it('操作 .git/ 被拒', async () => {
    await expect(wfs.createFile('.git/config')).rejects.toThrow(/\.git/);
    await expect(wfs.deletePath('.git')).rejects.toThrow(/\.git/);
  });

  it('rename 目标越界被拒', async () => {
    await wfs.createFile('a.txt');
    await expect(wfs.rename('a.txt', '../escape.txt')).rejects.toThrow(/越界|escape/);
  });
});
