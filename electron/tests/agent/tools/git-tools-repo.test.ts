// electron/tests/agent/tools/git-tools-repo.test.ts
//
// v2.9 多仓 git Task 2 单元测试：resolveRepoPath 六场景 + runGit repoPath 双跑。
// 设计要点：
//   - 真 tmp fixture：workspace 根仓 + `services/api` 内层仓（各自独立 git init），
//     走 discoverRepos 真实发现路径——其模块级缓存按 workspaceDir 入键，每用例
//     唯一 tmpDir 天然隔离，用例间零串扰。
//   - wsFs helper 照 git-tools.test.ts 既有模式：真实 WorkspaceFS（边界校验 /
//     symlink 逃逸检查走真实代码路径，不做 mock）。
//   - runGit 双跑：repoPath=内层 → status 输出只含内层仓特征文件；缺省对照只含
//     根仓特征文件——锁死「-C 透传 + 缺省行为不变」契约。
//   - 本文件不触碰 git_commit，无需 DB / GitPolicy 初始化。

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { WorkspaceFS } from '../../../src/main/files/workspace-fs';
import type { ToolContext } from '../../../src/main/agent/tools/types';
import { resolveRepoPath, runGit } from '../../../src/main/agent/tools/git-tools';

let tmpRoot: string;
let tmpDir: string;
let apiDir: string;
let wsFs: WorkspaceFS;
let ctx: ToolContext;

beforeEach(() => {
  // 每用例唯一 tmpDir，避免 discoverRepos 模块级缓存跨用例串数据。
  tmpRoot = path.join(os.tmpdir(), `ap-git-repo-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  tmpDir = path.join(tmpRoot, 'workspace');
  apiDir = path.join(tmpDir, 'services', 'api');
  fs.mkdirSync(apiDir, { recursive: true });
  wsFs = new WorkspaceFS(tmpDir);
  // runGit 只读 ctx.workspaceDir；其他字段照 git-tools.test.ts 既有最小 stub 模式。
  ctx = {
    wsFs,
    workspaceId: 'test-ws',
    workspaceDir: tmpDir,
    skillRegistry: {} as ToolContext['skillRegistry'],
    streamSessionId: 'test-stream',
    roomId: 'test-room',
    sendStreamChunk: () => {},
    permissionConfig: { allowedTools: ['git_status'], deniedTools: [] },
    creatorUserId: '',
  };
  // 根仓 + 内层仓各自独立 init（默认分支 main + 提交者身份配置）。
  for (const dir of [tmpDir, apiDir]) {
    execSync('git init -b main', { cwd: dir });
    execSync('git config user.email test@test.com', { cwd: dir });
    execSync('git config user.name Test', { cwd: dir });
  }
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('resolveRepoPath', () => {
  it('缺省（undefined）→ 返回 workspaceDir', () => {
    expect(resolveRepoPath(tmpDir, wsFs, undefined)).toBe(tmpDir);
  });

  it('非 string 抛「参数 "repo" 不是字符串」', () => {
    expect(() => resolveRepoPath(tmpDir, wsFs, 123)).toThrow('参数 "repo" 不是字符串');
    expect(() => resolveRepoPath(tmpDir, wsFs, null)).toThrow('参数 "repo" 不是字符串');
  });

  it("'services/api' / './services/api' / 'services/api/' 三形态归一命中内层仓", () => {
    expect(resolveRepoPath(tmpDir, wsFs, 'services/api')).toBe(apiDir);
    expect(resolveRepoPath(tmpDir, wsFs, './services/api')).toBe(apiDir);
    expect(resolveRepoPath(tmpDir, wsFs, 'services/api/')).toBe(apiDir);
  });

  it("根仓形态 '.' 命中 workspaceDir", () => {
    expect(resolveRepoPath(tmpDir, wsFs, '.')).toBe(tmpDir);
  });

  it("未命中 'nope' → 错误含「不在发现列表」+ 清单含 根仓(.) 与 services/api", () => {
    expect(() => resolveRepoPath(tmpDir, wsFs, 'nope')).toThrow(/不在发现列表/);
    expect(() => resolveRepoPath(tmpDir, wsFs, 'nope')).toThrow(/根仓\(\.\)/);
    expect(() => resolveRepoPath(tmpDir, wsFs, 'nope')).toThrow(/services\/api/);
  });

  it("'../outside' → wsFs 边界拒绝（路径越界）", () => {
    expect(() => resolveRepoPath(tmpDir, wsFs, '../outside')).toThrow(/越界/);
  });

  it('绝对路径 → 拒（即使是 workspace 内的合法仓路径）', () => {
    expect(() => resolveRepoPath(tmpDir, wsFs, apiDir)).toThrow(/绝对路径/);
    expect(() => resolveRepoPath(tmpDir, wsFs, '/etc')).toThrow(/绝对路径/);
  });

  it('symlink 指向内层仓 → 不命中发现列表（discoverRepos 不追 symlink）', () => {
    fs.symlinkSync(apiDir, path.join(tmpDir, 'link-to-api'));
    expect(() => resolveRepoPath(tmpDir, wsFs, 'link-to-api')).toThrow(/不在发现列表/);
  });

  it('symlink 指向 workspace 外目录 → wsFs 逃逸拒绝', () => {
    const outside = path.join(tmpRoot, 'outside');
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(tmpDir, 'evil-link'));
    expect(() => resolveRepoPath(tmpDir, wsFs, 'evil-link')).toThrow(/逃逸|越界/);
  });
});

describe('runGit repoPath（git_status 语义双跑）', () => {
  it('repoPath=内层仓 → status 输出来自内层；缺省 → 根仓（对照）', async () => {
    // 根仓与内层仓各放一个特征文件（untracked），用输出归属锁死 -C 透传。
    await fs.promises.writeFile(path.join(tmpDir, 'root-only.txt'), 'root');
    await fs.promises.writeFile(path.join(apiDir, 'api-only.txt'), 'api');

    const innerPath = resolveRepoPath(tmpDir, wsFs, 'services/api');
    const inner = await runGit(['status', '--porcelain=v1'], ctx, undefined, innerPath);
    expect(inner.code).toBe(0);
    expect(inner.stdout).toContain('api-only.txt');
    expect(inner.stdout).not.toContain('root-only.txt');

    // 缺省（repoPath 不传）：spawn cwd 仍是 workspaceDir，输出为根仓状态。
    const rootRun = await runGit(['status', '--porcelain=v1'], ctx);
    expect(rootRun.code).toBe(0);
    expect(rootRun.stdout).toContain('root-only.txt');
    expect(rootRun.stdout).not.toContain('api-only.txt');
  });
});
