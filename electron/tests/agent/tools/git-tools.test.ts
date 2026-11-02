// electron/tests/agent/tools/git-tools.test.ts
//
// GitTools 单元测试：只读 4 工具（status / diff / log / show）+ 写工具占位拒绝。
// 设计要点：
//   - 每用例新建唯一 tmp 目录 + 真实 WorkspaceFS（路径沙箱走真实代码路径）。
//   - beforeEach 在 tmp 目录 `git init` 并配置 user.email / user.name，
//     保证 git 命令在该 workspace 内可正常工作（无 user 配置会报错）。
//   - 构造最小 ToolContext：GitTools 只用 wsFs / workspaceDir，其他字段给 stub。
//   - 不存在的 commit 用例期待 reject（git show 非 0 退出码 → executeShow 抛错）。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { WorkspaceFS } from '../../../src/main/files/workspace-fs';
import type { ToolContext } from '../../../src/main/agent/tools/types';
import { GitTools, runGit } from '../../../src/main/agent/tools/git-tools';
import { OUTPUT_LIMITS } from '../../../src/main/agent/tools/shared/output-truncate';
import { runMigrations, closeDb } from '../../../src/main/storage/db';
import { setGitPolicy, getGitPolicy } from '../../../src/main/workspace/git-policy';

// 子进程桩（仅「流式 UTF-8 解码」用例启用）：本文件其余用例全是真实 git 仓，
// 故用**部分 mock**——procStub.fake 为 null 时 spawn 委托给真实实现，逐字节
// 不变；置为 fake 时才替换。与 mcp-spawner-*.test.ts 同款「只 mock 进程边界」策略。
const procStub = vi.hoisted(() => ({
  fake: null as null | (() => unknown),
}));

type SpawnFn = typeof import('node:child_process').spawn;

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const spawn = ((...args: Parameters<SpawnFn>) => {
    const fake = procStub.fake;
    return (fake ? fake() : actual.spawn(...args)) as ReturnType<SpawnFn>;
  }) as SpawnFn;
  return { ...actual, spawn, default: { ...actual, spawn } };
});

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
    creatorUserId: '',
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

describe('git_add', () => {
  it('单文件', async () => {
    await fs.promises.writeFile(path.join(tmpDir, 'a.txt'), 'hello');
    const tools = new GitTools();
    await tools.execute('git_add', { paths: ['a.txt'] }, ctx);
    const status = execSync('git status --porcelain', { cwd: tmpDir }).toString();
    expect(status).toMatch(/^A\s+a\.txt/);
  });

  it('多文件', async () => {
    await fs.promises.writeFile(path.join(tmpDir, 'a.txt'), '1');
    await fs.promises.writeFile(path.join(tmpDir, 'b.txt'), '2');
    const tools = new GitTools();
    await tools.execute('git_add', { paths: ['a.txt', 'b.txt'] }, ctx);
    const status = execSync('git status --porcelain', { cwd: tmpDir }).toString();
    expect(status).toContain('a.txt');
    expect(status).toContain('b.txt');
  });
});

describe('git_branch', () => {
  it('列出分支', async () => {
    execSync('git commit --allow-empty -m init', { cwd: tmpDir });
    const tools = new GitTools();
    expect(await tools.execute('git_branch', { list: true }, ctx)).toContain('main');
  });

  it('创建新分支', async () => {
    execSync('git commit --allow-empty -m init', { cwd: tmpDir });
    const tools = new GitTools();
    await tools.execute('git_branch', { name: 'feature' }, ctx);
    expect(execSync('git branch', { cwd: tmpDir }).toString()).toContain('feature');
  });
});

describe('git_checkout', () => {
  it('切到已有分支', async () => {
    execSync('git commit --allow-empty -m init', { cwd: tmpDir });
    execSync('git branch feature', { cwd: tmpDir });
    const tools = new GitTools();
    await tools.execute('git_checkout', { branch: 'feature' }, ctx);
    expect(execSync('git rev-parse --abbrev-ref HEAD', { cwd: tmpDir }).toString().trim()).toBe('feature');
  });

  it('不存在抛错', async () => {
    const tools = new GitTools();
    await expect(tools.execute('git_checkout', { branch: 'nonexistent' }, ctx)).rejects.toThrow();
  });
});

describe('git_stash', () => {
  it('push + list', async () => {
    execSync('git commit --allow-empty -m init', { cwd: tmpDir });
    await fs.promises.writeFile(path.join(tmpDir, 'a.txt'), 'uncommitted');
    const tools = new GitTools();
    await tools.execute('git_stash', { action: 'push', message: 'test stash' }, ctx);
    const list = await tools.execute('git_stash', { action: 'list' }, ctx);
    expect(list).toContain('test stash');
    expect(fs.existsSync(path.join(tmpDir, 'a.txt'))).toBe(false);
  });

  it('pop 恢复', async () => {
    execSync('git commit --allow-empty -m init', { cwd: tmpDir });
    await fs.promises.writeFile(path.join(tmpDir, 'a.txt'), 'uncommitted');
    const tools = new GitTools();
    await tools.execute('git_stash', { action: 'push' }, ctx);
    await tools.execute('git_stash', { action: 'pop' }, ctx);
    expect(fs.existsSync(path.join(tmpDir, 'a.txt'))).toBe(true);
  });
});

// Task 11：git_commit + GitPolicy 三层校验
//   - DB 初始化用 runMigrations() + closeDb()（仓库实际 API，brief 中的 initDb 不存在）
//   - AP_USER_DATA_DIR 指向 tmpRoot（文件级 beforeEach 已创建），afterEach 先关库再由
//     文件级 afterEach 删目录——释放文件句柄后再清理。
describe('git_commit + GitPolicy', () => {
  beforeEach(() => {
    process.env.AP_USER_DATA_DIR = tmpRoot;
    runMigrations();
    setGitPolicy('test-ws', {
      allowAgentCommits: true,
      defaultBranch: 'main',
      fallbackBranchPattern: 'agent/{agent_slug}/{task_id}',
      commitMessage: {
        template: '{type}{taskId} {summary}',
        patterns: [
          { code: 'chore', name: 'Conventional', regex: '^(feat|fix|chore|docs|refactor|test)(\\(.+\\))?:\\s+.+', example: 'feat(api): add endpoint' },
        ],
        validation: 'strict',
        trailers: [],
      },
    });
  });

  afterEach(() => {
    closeDb();
    delete process.env.AP_USER_DATA_DIR;
  });

  it('合规 message 通过', async () => {
    execSync('git commit --allow-empty -m init', { cwd: tmpDir });
    await fs.promises.writeFile(path.join(tmpDir, 'a.txt'), 'hello');
    const tools = new GitTools();
    await tools.execute('git_add', { paths: ['a.txt'] }, ctx);
    const result = await tools.execute('git_commit', { message: 'feat: add a' }, ctx);
    expect(result).toContain('main');
  });

  it('strict 模式不合规 message 抛错', async () => {
    execSync('git commit --allow-empty -m init', { cwd: tmpDir });
    await fs.promises.writeFile(path.join(tmpDir, 'a.txt'), 'hello');
    const tools = new GitTools();
    await tools.execute('git_add', { paths: ['a.txt'] }, ctx);
    await expect(tools.execute('git_commit', { message: 'bad message' }, ctx)).rejects.toThrow(/不合规/);
  });

  it('allowAgentCommits=false 抛错', async () => {
    setGitPolicy('test-ws', { ...getGitPolicy('test-ws'), allowAgentCommits: false });
    const tools = new GitTools();
    await expect(tools.execute('git_commit', { message: 'feat: x' }, ctx)).rejects.toThrow(/allowAgentCommits/);
  });

  it('在 defaultBranch 上自动切到 fallback', async () => {
    execSync('git commit --allow-empty -m init', { cwd: tmpDir });
    await fs.promises.writeFile(path.join(tmpDir, 'a.txt'), 'hello');
    const tools = new GitTools();
    await tools.execute('git_add', { paths: ['a.txt'] }, ctx);
    await tools.execute('git_commit', { message: 'feat: a' }, ctx);
    const current = execSync('git rev-parse --abbrev-ref HEAD', { cwd: tmpDir }).toString().trim();
    expect(current).toMatch(/^agent\//);
  });
});

// =====================================================================================
// 选项注入防护（审查 F2）：LLM 控制的 ref 型字段拒绝前导 "-" + 形态校验。
// 攻击链（修复前真实成立，红测试先复现）：git 子进程无 OS 沙箱，commit 字段
// '--output=<绝对路径>' 会被 git 当作选项解析——git show 把 diff 全文写到任意路径。
// =====================================================================================
describe('git 选项注入防护（审查 F2）', () => {
  // 攻击目标路径（容器预置临时区；断言「抛参数错误且文件未创建」双条件）
  const PWN = '/tmp/opencode';

  beforeEach(() => {
    fs.mkdirSync(PWN, { recursive: true });
  });

  it('git_show {commit:"--output=…"} → 抛参数错误且目标文件未创建', async () => {
    execSync('git commit --allow-empty -m init', { cwd: tmpDir });
    const target = path.join(PWN, `pwn-show-${Date.now()}.txt`);
    const tools = new GitTools();
    await expect(
      tools.execute('git_show', { commit: `--output=${target}` }, ctx),
    ).rejects.toThrow(/选项注入/);
    expect(fs.existsSync(target)).toBe(false);
  });

  it('git_log {branch:"--output=…"} → 抛参数错误且目标文件未创建', async () => {
    execSync('git commit --allow-empty -m init', { cwd: tmpDir });
    const target = path.join(PWN, `pwn-log-${Date.now()}.txt`);
    const tools = new GitTools();
    await expect(
      tools.execute('git_log', { branch: `--output=${target}` }, ctx),
    ).rejects.toThrow(/选项注入/);
    expect(fs.existsSync(target)).toBe(false);
  });

  it('git_branch {name:"-x"} / git_checkout {branch:"-b"} → 抛参数错误', async () => {
    execSync('git commit --allow-empty -m init', { cwd: tmpDir });
    const tools = new GitTools();
    await expect(tools.execute('git_branch', { name: '--output=/tmp/opencode/x' }, ctx)).rejects.toThrow(/选项注入/);
    await expect(tools.execute('git_branch', { name: '-b' }, ctx)).rejects.toThrow(/选项注入/);
    await expect(tools.execute('git_checkout', { branch: '--force' }, ctx)).rejects.toThrow(/选项注入/);
    // 未创建任何分支（注入值不落 argv）
    expect(execSync('git branch', { cwd: tmpDir }).toString()).not.toContain('output');
  });

  it('含空格/控制字符的 ref 值 → 形态校验拒绝', async () => {
    const tools = new GitTools();
    await expect(
      tools.execute('git_show', { commit: 'HEAD; rm -rf /' }, ctx),
    ).rejects.toThrow(/不允许的字符/);
    await expect(
      tools.execute('git_log', { branch: 'main --output=/tmp/opencode/y' }, ctx),
    ).rejects.toThrow(/不允许的字符/);
  });

  it('git_add paths 含 "-" 开头文件名 → 经 "--" 分隔正常暂存（不误伤）', async () => {
    await fs.promises.writeFile(path.join(tmpDir, '-poison.txt'), 'x');
    const tools = new GitTools();
    await tools.execute('git_add', { paths: ['-poison.txt'] }, ctx);
    const status = execSync('git status --porcelain', { cwd: tmpDir }).toString();
    expect(status).toMatch(/^A\s+-poison\.txt/);
  });

  it('合法 ref 不误伤：HEAD~2 / feat/x / v1.0.0 / origin/main', async () => {
    for (let i = 0; i < 3; i++) {
      execSync(`git commit --allow-empty -m "c${i}"`, { cwd: tmpDir });
    }
    const tools = new GitTools();
    // HEAD~2：历史语法
    expect(await tools.execute('git_show', { commit: 'HEAD~2' }, ctx)).toContain('c0');
    // 分支名（含斜杠分层）
    expect(await tools.execute('git_log', { branch: 'main', limit: 2 }, ctx)).toBeTruthy();
    await tools.execute('git_branch', { name: 'feat/x' }, ctx);
    expect(execSync('git branch', { cwd: tmpDir }).toString()).toContain('feat/x');
    // tag ref
    execSync('git tag v1.0.0', { cwd: tmpDir });
    await tools.execute('git_checkout', { branch: 'v1.0.0' }, ctx);
    expect(execSync('git rev-parse --abbrev-ref HEAD', { cwd: tmpDir }).toString().trim()).toBe('HEAD');
    // 远端形态分层名（斜杠 + 多段）——仅校验形态，创建本地同名分支验证通过
    await tools.execute('git_checkout', { branch: 'main' }, ctx);
    await tools.execute('git_branch', { name: 'origin/main' }, ctx);
  });
});

// =====================================================================================
// 流式 UTF-8 解码回归锁：git 输出经 pipe 交付，边界可能切开多字节字符。
// 旧实现逐 chunk `chunk.toString('utf-8')`——切开的两半各自解出 U+FFFD，
// 表现为中文提交信息 / 文件名在会话里显示为乱码。
// =====================================================================================

/**
 * 最小子进程桩：stdout/stderr 可 emit data。listeners 全部同步注册完毕后才于
 * 下一个 tick 依次 emit data 与 close——仿真 pipe 分块到达 + 正常退出。
 */
function makeFakeGitProc(stdoutChunks: Buffer[], code = 0): unknown {
  const bus = new EventEmitter();
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const proc = Object.assign(bus, { stdout, stderr, pid: 4242, kill: (): void => {} });
  setImmediate(() => {
    for (const chunk of stdoutChunks) stdout.emit('data', chunk);
    bus.emit('close', code);
  });
  return proc;
}

describe('runGit 流式 UTF-8 解码', () => {
  it('中文被 pipe 边界切成两个 chunk → stdout 完整且无替换字符（旧实现必出 U+FFFD）', async () => {
    const expected = '修改：中文文件名.txt';
    const bytes = Buffer.from(expected, 'utf8');
    // 在第 1 字节后切一刀：首字「修」的 3 字节被拆到两个 chunk
    procStub.fake = (): unknown => makeFakeGitProc([bytes.subarray(0, 1), bytes.subarray(1)]);
    try {
      const result = await runGit(['status', '--porcelain=v1'], ctx);
      expect(result.code).toBe(0);
      expect(result.stdout).toBe(expected);
      expect(result.stdout).not.toContain('\uFFFD');
    } finally {
      procStub.fake = null;
    }
  });
});

// =====================================================================================
// 截断标记回归锁（终审必修 2）：runGit 换成 createUtf8Collector 后收集器**严格封顶**，
// 超限输出恰好等于 maxOutput 字符 → truncateString 的 `buf.length <= maxLen` 早退分支
// 直接返回原文、不追加标记。旧实现整块超限（buf.length > maxLen）标记必然命中。
//
// 纯 ASCII：排除「字符数 ≠ 字节数」的干扰，让「恰好封顶」这条判定路径唯一可解释。
// =====================================================================================
describe('runGit 超限输出必须带截断标记（不得静默截断）', () => {
  it('stdout 超过上限：结果含「截断」标记，且标记出现（不是假完整的半份 diff）', async () => {
    // 40KB 纯 ASCII（> git_show_diff 的 30KB 上限）
    const big = Buffer.from(
      Array.from({ length: 40 }, (_, i) => `diff-line-${String(i).padStart(3, '0')}-${'a'.repeat(900)}`).join('\n'),
      'utf8',
    );
    expect(big.length).toBeGreaterThan(OUTPUT_LIMITS.git_show_diff);
    procStub.fake = (): unknown => makeFakeGitProc([big]);
    try {
      const out = await new GitTools().execute('git_show', {}, ctx);
      expect(out).toContain('截断');
      // 上限之后的尾巴不可能出现在结果里（收集器封顶），且输出被标记过
      expect(out).not.toContain('diff-line-039');
      expect(out.length).toBeLessThan(big.length);
    } finally {
      procStub.fake = null;
    }
  });

  it('未超限时不加标记（标记只属于真实截断）', async () => {
    const small = Buffer.from('diff --git a/a.txt b/a.txt\n+hello\n', 'utf8');
    procStub.fake = (): unknown => makeFakeGitProc([small]);
    try {
      const out = await new GitTools().execute('git_show', {}, ctx);
      expect(out).toBe(small.toString('utf8'));
      expect(out).not.toContain('截断');
    } finally {
      procStub.fake = null;
    }
  });
});
