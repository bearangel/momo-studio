// electron/tests/agent/tools/git-tools.test.ts
//
// GitTools 单元测试：只读 4 工具（status / diff / log / show）+ 写工具占位拒绝。
// 设计要点：
//   - 每用例新建唯一 tmp 目录 + 真实 WorkspaceFS（路径沙箱走真实代码路径）。
//   - beforeEach 在 tmp 目录 `git init` 并配置 user.email / user.name，
//     保证 git 命令在该 workspace 内可正常工作（无 user 配置会报错）。
//   - 构造最小 ToolContext：GitTools 只用 wsFs / workspaceDir，其他字段给 stub。
//   - 不存在的 commit 用例期待 reject（git show 非 0 退出码 → executeShow 抛错）。

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { WorkspaceFS } from '../../../src/main/files/workspace-fs';
import type { ToolContext } from '../../../src/main/agent/tools/types';
import { GitTools } from '../../../src/main/agent/tools/git-tools';

let tmpRoot: string;
let tmpDir: string;
let wsFs: WorkspaceFS;
let ctx: ToolContext;

beforeEach(() => {
  // 每用例唯一 tmpDir，避免模块级缓存串数据。
  tmpRoot = path.join(os.tmpdir(), `ap-git-tools-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  tmpDir = path.join(tmpRoot, 'workspace');
  fs.mkdirSync(tmpDir, { recursive: true });
  wsFs = new WorkspaceFS(tmpDir);
  // GitTools 只用 wsFs / workspaceDir；其他字段给空 stub（实现不会触碰）。
  ctx = {
    wsFs,
    workspaceId: 'test-ws',
    workspaceDir: tmpDir,
    skillRegistry: {} as ToolContext['skillRegistry'],
    streamSessionId: 'test-stream',
    roomId: 'test-room',
    sendStreamChunk: () => {},
    permissionConfig: { allowedTools: ['git_status'], deniedTools: [] },
  };
  // 在 tmp workspace 内初始化 git 仓库（默认分支 main + 提交者身份配置）。
  execSync('git init -b main', { cwd: tmpDir });
  execSync('git config user.email test@test.com', { cwd: tmpDir });
  execSync('git config user.name Test', { cwd: tmpDir });
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('git_status', () => {
  it('干净仓库', async () => {
    const tools = new GitTools();
    expect(await tools.execute('git_status', {}, ctx)).toMatch(/干净|nothing to commit/);
  });

  it('有变更', async () => {
    await fs.promises.writeFile(path.join(tmpDir, 'a.txt'), 'hello');
    const tools = new GitTools();
    expect(await tools.execute('git_status', {}, ctx)).toContain('a.txt');
  });
});

describe('git_diff', () => {
  it('unstaged 变更', async () => {
    execSync('git commit --allow-empty -m init', { cwd: tmpDir });
    // 先把 a.txt 作为 tracked 文件提交一次，再修改——这样 git diff 才会显示
    // 对 tracked 文件的未暂存变更（未跟踪文件默认不出现在 git diff 输出中）。
    await fs.promises.writeFile(path.join(tmpDir, 'a.txt'), 'original');
    execSync('git add a.txt && git commit -m "add a"', { cwd: tmpDir });
    await fs.promises.writeFile(path.join(tmpDir, 'a.txt'), 'modified');
    const tools = new GitTools();
    expect(await tools.execute('git_diff', {}, ctx)).toContain('+modified');
  });
});

describe('git_log', () => {
  it('默认 20 条', async () => {
    for (let i = 0; i < 5; i++) {
      execSync(`git commit --allow-empty -m "commit ${i}"`, { cwd: tmpDir });
    }
    const tools = new GitTools();
    // git log --oneline 输出末尾带换行，split('\n') 会多出一个空字符串元素，
    // 先 trim() 去掉尾部换行再 split，得到的 length 才等于真实提交数。
    expect((await tools.execute('git_log', {}, ctx)).trim().split('\n').length).toBe(5);
  });
});

describe('git_show', () => {
  it('默认 HEAD 完整 diff', async () => {
    await fs.promises.writeFile(path.join(tmpDir, 'a.txt'), 'hello');
    execSync('git add a.txt && git commit -m "add a"', { cwd: tmpDir });
    const tools = new GitTools();
    expect(await tools.execute('git_show', {}, ctx)).toContain('+hello');
  });

  it('不存在的 commit 抛错', async () => {
    const tools = new GitTools();
    await expect(tools.execute('git_show', { commit: 'nonexistent' }, ctx)).rejects.toThrow();
  });
});
