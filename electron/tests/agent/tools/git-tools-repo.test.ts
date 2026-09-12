// electron/tests/agent/tools/git-tools-repo.test.ts
//
// v2.9 多仓 git Task 2 单元测试：resolveRepoPath 六场景 + runGit repoPath 双跑。
// v2.9 多仓 git Task 3 扩展：git_repos 发现工具——四仓清单逐字段断言 + 坏仓
// 容错 + 空 workspace 提示 + 注册面（getDefs 首位 / handles）。
// 设计要点：
//   - 真 tmp fixture：workspace 根仓 + `services/api` 内层仓（各自独立 git init），
//     走 discoverRepos 真实发现路径——其模块级缓存按 workspaceDir 入键，每用例
//     唯一 tmpDir 天然隔离，用例间零串扰。
//   - wsFs helper 照 git-tools.test.ts 既有模式：真实 WorkspaceFS（边界校验 /
//     symlink 逃逸检查走真实代码路径，不做 mock）。
//   - runGit 双跑：repoPath=内层 → status 输出只含内层仓特征文件；缺省对照只含
//     根仓特征文件——锁死「-C 透传 + 缺省行为不变」契约。
//   - git_repos 坏仓容错不 mock runGit，构造真实坏仓（.git 为内容非法的 gitfile，
//     git 硬失败 exit 128 且不向上回溯；注意空 .git 目录会被 git 回溯到父仓，
//     假阴性不可用）——保真度规则：mock 收窄，真实行为优先。
//   - 根仓 dirty 计数依赖 porcelain 未跟踪目录折叠（libs/ + services/ 各 1 行）。
//   - 本文件不触碰 git_commit，无需 DB / GitPolicy 初始化。

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { WorkspaceFS } from '../../../src/main/files/workspace-fs';
import type { ToolContext } from '../../../src/main/agent/tools/types';
import { GitTools, resolveRepoPath, runGit } from '../../../src/main/agent/tools/git-tools';

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

describe('git_repos 发现工具（Task 3）', () => {
  it('四仓清单：根在前、内层字典序；逐字段断言 root/branch/dirty(50+)/路径', async () => {
    // services/api：保持 beforeEach 的裸 init（unborn main、无文件）→ dirty 0。
    // services/web：51 个 untracked 文件 → dirty 行数 ≥50 显示 50+。
    const webDir = path.join(tmpDir, 'services', 'web');
    fs.mkdirSync(webDir, { recursive: true });
    execSync('git init -b main', { cwd: webDir });
    for (let i = 0; i < 51; i++) {
      fs.writeFileSync(path.join(webDir, `f${i}.txt`), 'x');
    }
    // libs/util：分支名带 `/` + 1 个 untracked 文件。
    const utilDir = path.join(tmpDir, 'libs', 'util');
    fs.mkdirSync(utilDir, { recursive: true });
    execSync('git init -b main', { cwd: utilDir });
    execSync('git checkout -b feature/util', { cwd: utilDir });
    fs.writeFileSync(path.join(utilDir, 'note.txt'), 'x');
    // 根仓不额外放文件：porcelain 折叠未跟踪目录 → `?? libs/` + `?? services/` 两行。

    const tools = new GitTools();
    const out = await tools.execute('git_repos', {}, ctx);
    const lines = out.split('\n');
    expect(lines).toHaveLength(4);
    expect(lines[0]).toBe('root: true  branch: main  dirty: 2  (.)');
    expect(lines[1]).toBe('root: false  branch: feature/util  dirty: 1  libs/util');
    expect(lines[2]).toBe('root: false  branch: main  dirty: 0  services/api');
    expect(lines[3]).toBe('root: false  branch: main  dirty: 50+  services/web');
  });

  it('坏仓容错：该行 branch: ?  dirty: ?，其余行不受影响', async () => {
    // .git 为内容非法的 gitfile（真实坏仓，不 mock runGit）：
    // git 报 invalid gitfile format 硬失败（exit 128）且不向上回溯到根仓。
    const brokenDir = path.join(tmpDir, 'broken');
    fs.mkdirSync(brokenDir);
    fs.writeFileSync(path.join(brokenDir, '.git'), 'garbage');

    const tools = new GitTools();
    const out = await tools.execute('git_repos', {}, ctx);
    const lines = out.split('\n');
    expect(lines).toHaveLength(3);
    // 根仓 dirty 数字依赖 porcelain 未跟踪目录折叠 + 嵌套仓启发（`.git` 文件
    // 即便格式非法也会被当作 nested-repo 候选从未跟踪列表排除——具体数字随 git
    // 版本可能漂移）；本测试只锁坏行契约，根行用正则允许数字浮动。
    expect(lines[0]).toMatch(/^root: true  branch: main  dirty: \d+  \(\.\)$/);
    expect(lines[1]).toBe('root: false  branch: ?  dirty: ?  broken');
    expect(lines[2]).toBe('root: false  branch: main  dirty: 0  services/api');
  });

  it('空 workspace（无任何仓）→ 提示行「未发现任何 git 仓」', async () => {
    const emptyWs = path.join(tmpRoot, 'empty-ws');
    fs.mkdirSync(emptyWs);
    const emptyCtx: ToolContext = { ...ctx, workspaceDir: emptyWs };

    const tools = new GitTools();
    const out = await tools.execute('git_repos', {}, emptyCtx);
    expect(out).toBe('未发现任何 git 仓');
  });

  it('注册面：getDefs 首位是 git_repos（git_status 前），共 10 个；handles 认领', () => {
    const tools = new GitTools();
    const defs = tools.getDefs();
    expect(defs[0]?.name).toBe('git_repos');
    expect(defs[1]?.name).toBe('git_status');
    expect(defs).toHaveLength(10);
    expect(tools.handles('git_repos')).toBe(true);
  });
});
