// electron/tests/agent/tools/git-tools-repo.test.ts
//
// v2.9 多仓 git Task 2 单元测试：resolveRepoPath 六场景 + runGit repoPath 双跑。
// v2.9 多仓 git Task 3 扩展：git_repos 发现工具——四仓清单逐字段断言 + 坏仓
// 容错 + 空 workspace 提示 + 注册面（getDefs 首位 / handles）。
// v2.9 多仓 git Task 4 扩展：9 工具 repo 参数接线——每工具 × {缺省, 内层} 双跑
// （副作用/输出归属内层仓断言）+ GitPolicy 跨仓（总开关关 / 分支保护读目标仓
// 当前分支）+ repo 未命中 9 工具统一报错附清单 + inputSchema 契约。
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
//   - Task 4 起 git_commit 用例需要 DB / GitPolicy 初始化（照 git-tools.test.ts
//     的 AP_USER_DATA_DIR + runMigrations + setGitPolicy 模式）。
//   - 分支保护跨仓用例刻意把根仓与内层仓放在不同分支（根 feat/root-safe ×
//     内层 main / 根 main × 内层 feat/x）：若实现误读根仓分支，两个方向的
//     断言都会翻转——同时锁「读目标仓分支」的正反两面。

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { WorkspaceFS } from '../../../src/main/files/workspace-fs';
import type { ToolContext } from '../../../src/main/agent/tools/types';
import { GitTools, resolveRepoPath, runGit } from '../../../src/main/agent/tools/git-tools';
import { runMigrations, closeDb } from '../../../src/main/storage/db';
import { setGitPolicy, getGitPolicy } from '../../../src/main/workspace/git-policy';

/** 在指定目录执行 git 命令并返回输出（测试 fixture 播种用）。*/
function git(cwd: string, cmd: string): string {
  return execSync(`git ${cmd}`, { cwd }).toString();
}

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

// ---------------------------------------------------------------------------
// Task 4：9 工具 repo 参数接线
// ---------------------------------------------------------------------------

describe('9 工具 repo 参数双跑（Task 4）', () => {
  it('git_status：repo=内层 → 只含内层特征文件；缺省 → 只含根仓特征文件', async () => {
    await fs.promises.writeFile(path.join(tmpDir, 'root-only.txt'), 'root');
    await fs.promises.writeFile(path.join(apiDir, 'api-only.txt'), 'api');
    const tools = new GitTools();

    const inner = await tools.execute('git_status', { repo: 'services/api' }, ctx);
    expect(inner).toContain('api-only.txt');
    expect(inner).not.toContain('root-only.txt');

    const root = await tools.execute('git_status', {}, ctx);
    expect(root).toContain('root-only.txt');
    expect(root).not.toContain('api-only.txt');
  });

  it('git_diff：repo=内层 → diff 是内层仓 tracked 修改；缺省 → 根仓修改', async () => {
    git(tmpDir, 'commit --allow-empty -m "init root"');
    await fs.promises.writeFile(path.join(tmpDir, 'a.txt'), 'orig');
    git(tmpDir, 'add a.txt');
    git(tmpDir, 'commit -m "add a"');
    await fs.promises.writeFile(path.join(tmpDir, 'a.txt'), 'root-change');

    git(apiDir, 'commit --allow-empty -m "init api"');
    await fs.promises.writeFile(path.join(apiDir, 'b.txt'), 'orig');
    git(apiDir, 'add b.txt');
    git(apiDir, 'commit -m "add b"');
    await fs.promises.writeFile(path.join(apiDir, 'b.txt'), 'api-change');

    const tools = new GitTools();
    const inner = await tools.execute('git_diff', { repo: 'services/api' }, ctx);
    expect(inner).toContain('+api-change');
    expect(inner).not.toContain('root-change');

    const root = await tools.execute('git_diff', {}, ctx);
    expect(root).toContain('+root-change');
    expect(root).not.toContain('api-change');
  });

  it('git_log：repo=内层 → 只有内层提交；缺省 → 只有根仓提交', async () => {
    git(tmpDir, 'commit --allow-empty -m "root commit B"');
    git(apiDir, 'commit --allow-empty -m "api commit X"');

    const tools = new GitTools();
    const inner = await tools.execute('git_log', { repo: 'services/api' }, ctx);
    expect(inner).toContain('api commit X');
    expect(inner).not.toContain('root commit');

    const root = await tools.execute('git_log', {}, ctx);
    expect(root).toContain('root commit B');
    expect(root).not.toContain('api commit X');
  });

  it('git_show：repo=内层 → HEAD 是内层仓提交；缺省 → 根仓提交', async () => {
    await fs.promises.writeFile(path.join(tmpDir, 'root-show.txt'), 'root-show-content');
    git(tmpDir, 'add root-show.txt');
    git(tmpDir, 'commit -m "add root-show"');

    await fs.promises.writeFile(path.join(apiDir, 'api-show.txt'), 'api-show-content');
    git(apiDir, 'add api-show.txt');
    git(apiDir, 'commit -m "add api-show"');

    const tools = new GitTools();
    const inner = await tools.execute('git_show', { repo: 'services/api' }, ctx);
    expect(inner).toContain('+api-show-content');
    expect(inner).not.toContain('root-show-content');

    const root = await tools.execute('git_show', {}, ctx);
    expect(root).toContain('+root-show-content');
    expect(root).not.toContain('api-show-content');
  });

  it('git_add：repo=内层 → 暂存落在内层仓索引（根仓索引零感知）；缺省 → 根仓索引', async () => {
    await fs.promises.writeFile(path.join(apiDir, 'inner-file.txt'), 'x');
    await fs.promises.writeFile(path.join(tmpDir, 'root-file.txt'), 'y');
    const tools = new GitTools();

    await tools.execute('git_add', { paths: ['inner-file.txt'], repo: 'services/api' }, ctx);
    // 内层仓索引出现 staged 行；根仓 porcelain 未跟踪目录折叠为 `?? services/`，
    // 不含 inner-file.txt（根仓索引未被触碰）。
    expect(git(apiDir, 'status --porcelain')).toMatch(/^A\s+inner-file\.txt/m);
    expect(git(tmpDir, 'status --porcelain')).not.toContain('inner-file.txt');

    await tools.execute('git_add', { paths: ['root-file.txt'] }, ctx);
    expect(git(tmpDir, 'status --porcelain')).toMatch(/^A\s+root-file\.txt/m);
  });

  it('git_branch：repo=内层 → 分支创建在内层仓；缺省 → 根仓', async () => {
    git(tmpDir, 'commit --allow-empty -m "init root"');
    git(apiDir, 'commit --allow-empty -m "init api"');
    const tools = new GitTools();

    await tools.execute('git_branch', { name: 'api-feat', repo: 'services/api' }, ctx);
    expect(git(apiDir, 'branch')).toContain('api-feat');
    expect(git(tmpDir, 'branch')).not.toContain('api-feat');

    await tools.execute('git_branch', { name: 'root-feat' }, ctx);
    expect(git(tmpDir, 'branch')).toContain('root-feat');
    expect(git(apiDir, 'branch')).not.toContain('root-feat');
  });

  it('git_checkout：repo=内层 → 切内层仓分支（根仓 HEAD 不动）；缺省 → 根仓', async () => {
    git(tmpDir, 'commit --allow-empty -m "init root"');
    git(tmpDir, 'branch root-target');
    git(apiDir, 'commit --allow-empty -m "init api"');
    git(apiDir, 'branch api-target');
    const tools = new GitTools();

    await tools.execute('git_checkout', { branch: 'api-target', repo: 'services/api' }, ctx);
    expect(git(apiDir, 'rev-parse --abbrev-ref HEAD').trim()).toBe('api-target');
    expect(git(tmpDir, 'rev-parse --abbrev-ref HEAD').trim()).toBe('main');

    await tools.execute('git_checkout', { branch: 'root-target' }, ctx);
    expect(git(tmpDir, 'rev-parse --abbrev-ref HEAD').trim()).toBe('root-target');
  });

  it('git_stash：repo=内层 → 暂存收进内层仓 stash（根仓 stash 空）；缺省 → 根仓', async () => {
    await fs.promises.writeFile(path.join(tmpDir, 'r.txt'), 'base');
    git(tmpDir, 'add r.txt');
    git(tmpDir, 'commit -m "add r"');
    await fs.promises.writeFile(path.join(apiDir, 't.txt'), 'base');
    git(apiDir, 'add t.txt');
    git(apiDir, 'commit -m "add t"');

    const tools = new GitTools();
    await fs.promises.writeFile(path.join(apiDir, 't.txt'), 'dirty-api');
    await tools.execute('git_stash', { action: 'push', message: 'api-wip', repo: 'services/api' }, ctx);
    expect(fs.readFileSync(path.join(apiDir, 't.txt'), 'utf-8')).toBe('base');
    expect(git(apiDir, 'stash list')).toContain('api-wip');
    expect(git(tmpDir, 'stash list')).toBe('');

    await fs.promises.writeFile(path.join(tmpDir, 'r.txt'), 'dirty-root');
    await tools.execute('git_stash', { action: 'push', message: 'root-wip' }, ctx);
    expect(fs.readFileSync(path.join(tmpDir, 'r.txt'), 'utf-8')).toBe('base');
    expect(git(tmpDir, 'stash list')).toContain('root-wip');
    // 根仓 push 之后内层仓 stash 仍只有自己那一条（互不串扰）。
    expect(git(apiDir, 'stash list').trim().split('\n')).toHaveLength(1);
  });
});

describe('inputSchema repo 字段 + 描述多仓提示（Task 4）', () => {
  it('9 工具均含 repo 参数（契约文案一致）；git_repos 不含', () => {
    const tools = new GitTools();
    const defs = tools.getDefs();
    const nine = defs.filter((d) => d.name !== 'git_repos');
    expect(nine).toHaveLength(9);

    for (const d of nine) {
      const schema = d.inputSchema as {
        properties?: Record<string, { type?: string; description?: string }>;
      };
      expect(schema.properties?.repo?.type, `${d.name} 缺 repo 参数`).toBe('string');
      expect(
        schema.properties?.repo?.description,
        `${d.name} repo 描述不符合契约`,
      ).toBe('目标仓（相对 workspace 路径，缺省根仓；可用仓见 git_repos）');
      expect(d.description, `${d.name} 描述缺多仓提示`).toContain(
        '多仓 workspace 中可用 repo 参数指定内层仓（先 git_repos 查询可用仓）',
      );
    }

    const reposDef = defs.find((d) => d.name === 'git_repos');
    const reposSchema = reposDef?.inputSchema as {
      properties?: Record<string, unknown>;
    };
    expect(reposSchema?.properties?.repo).toBeUndefined();
  });
});

describe('repo 未命中 → 9 工具统一报错（Task 4）', () => {
  // 各工具最小可用参数（除 repo 外全部合法）——错误只能来自 repo 解析。
  const TOOL_CASES: Array<[string, Record<string, unknown>]> = [
    ['git_status', {}],
    ['git_diff', {}],
    ['git_log', {}],
    ['git_show', {}],
    ['git_add', { paths: ['a.txt'] }],
    ['git_branch', { list: true }],
    ['git_checkout', { branch: 'x' }],
    ['git_stash', { action: 'list' }],
    ['git_commit', { message: 'feat: x' }],
  ];

  it.each(TOOL_CASES)('%s：报「不在发现列表」并附可用仓清单', async (name, baseArgs) => {
    const tools = new GitTools();
    const err = await tools
      .execute(name, { ...baseArgs, repo: 'nope' }, ctx)
      .then(() => null, (e: unknown) => e as Error);
    // git_commit 的 repo 解析先于 GitPolicy/DB 读取——统一报错不依赖 DB 初始化。
    expect(err).toBeInstanceOf(Error);
    expect(err?.message).toContain('仓 "nope" 不在发现列表');
    expect(err?.message).toContain('根仓(.)');
    expect(err?.message).toContain('services/api');
  });
});

describe('git_commit + GitPolicy 跨仓（Task 4）', () => {
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
          {
            code: 'chore',
            name: 'Conventional',
            regex: '^(feat|fix|chore|docs|refactor|test)(\\(.+\\))?:\\s+.+',
            example: 'feat(api): add endpoint',
          },
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

  it('内层 feat/x 放行：commit 直落内层仓当前分支，根仓零感知', async () => {
    git(tmpDir, 'commit --allow-empty -m "init root"');
    git(apiDir, 'commit --allow-empty -m "init api"');
    git(apiDir, 'checkout -b feat/x');
    await fs.promises.writeFile(path.join(apiDir, 'api-file.txt'), 'hello');

    const tools = new GitTools();
    await tools.execute('git_add', { paths: ['api-file.txt'], repo: 'services/api' }, ctx);
    const out = await tools.execute('git_commit', { message: 'feat: api work', repo: 'services/api' }, ctx);

    // feat/x 非保护分支：不切 fallback，commit 输出行带 [feat/x ...]。
    expect(git(apiDir, 'rev-parse --abbrev-ref HEAD').trim()).toBe('feat/x');
    expect(out).toContain('feat/x');
    expect(git(apiDir, 'log -1 --oneline')).toContain('feat: api work');
    // 根仓零感知：HEAD 仍在 main、无新分支、无新提交。
    expect(git(tmpDir, 'rev-parse --abbrev-ref HEAD').trim()).toBe('main');
    expect(git(tmpDir, 'branch')).not.toMatch(/agent\//);
    expect(git(tmpDir, 'log --oneline')).not.toContain('feat: api work');
  });

  it('内层 main 拒：分支保护读目标仓当前分支 → 自动切 fallback；根仓分支不参与判定', async () => {
    // 根仓刻意放在非保护分支 feat/root-safe：若实现误读根仓分支，
    // 内层 main 的保护会被绕过（diversion 不发生）——断言翻转即红。
    git(tmpDir, 'commit --allow-empty -m "init root"');
    git(tmpDir, 'checkout -b feat/root-safe');
    git(apiDir, 'commit --allow-empty -m "init api"');
    await fs.promises.writeFile(path.join(apiDir, 'b.txt'), 'x');

    const tools = new GitTools();
    await tools.execute('git_add', { paths: ['b.txt'], repo: 'services/api' }, ctx);
    await tools.execute('git_commit', { message: 'feat: diverted', repo: 'services/api' }, ctx);

    // 内层仓被 diversion 到 fallback（agent/agent/test-stream），commit 落在
    // fallback 上而非 main。
    expect(git(apiDir, 'rev-parse --abbrev-ref HEAD').trim()).toBe('agent/agent/test-stream');
    expect(git(apiDir, 'log -1 --oneline')).toContain('feat: diverted');
    expect(git(apiDir, 'log main --oneline')).not.toContain('feat: diverted');
    // 根仓零感知：HEAD 仍在 feat/root-safe、无 fallback 分支残留。
    expect(git(tmpDir, 'rev-parse --abbrev-ref HEAD').trim()).toBe('feat/root-safe');
    expect(git(tmpDir, 'branch')).not.toMatch(/agent\//);
  });

  it('根 main 拒（缺省零变化显式一例）：既有 fallback 行为复刻；内层仓零感知', async () => {
    git(tmpDir, 'commit --allow-empty -m "init root"');
    git(apiDir, 'commit --allow-empty -m "init api"');
    await fs.promises.writeFile(path.join(tmpDir, 'r.txt'), 'x');

    const tools = new GitTools();
    await tools.execute('git_add', { paths: ['r.txt'] }, ctx);
    const out = await tools.execute('git_commit', { message: 'feat: root work' }, ctx);

    // 与既有 git-tools.test.ts「在 defaultBranch 上自动切到 fallback」同语义：
    // HEAD → agent/ 前缀 fallback，返回文案含「从 main 自动切到分支」。
    expect(git(tmpDir, 'rev-parse --abbrev-ref HEAD').trim()).toBe('agent/agent/test-stream');
    expect(out).toContain('从 main 自动切到分支');
    expect(git(tmpDir, 'log -1 --oneline')).toContain('feat: root work');
    // 内层仓零感知：HEAD 仍在 main、无新提交。
    expect(git(apiDir, 'rev-parse --abbrev-ref HEAD').trim()).toBe('main');
    expect(git(apiDir, 'log --oneline')).not.toContain('feat: root work');
  });

  it('总开关关 → 内层 commit 拒，文案含指引；根仓同样拒（策略仓无关）', async () => {
    setGitPolicy('test-ws', { ...getGitPolicy('test-ws'), allowAgentCommits: false });
    git(apiDir, 'commit --allow-empty -m "init api"');

    const tools = new GitTools();
    await expect(
      tools.execute('git_commit', { message: 'feat: x', repo: 'services/api' }, ctx),
    ).rejects.toThrow('GitPolicy 禁止 agent 自动提交（allowAgentCommits=false）');

    const err = await tools
      .execute('git_commit', { message: 'feat: x', repo: 'services/api' }, ctx)
      .then(() => null, (e: unknown) => e as Error);
    // 指引：去哪开启 + 关闭时的替代路径。
    expect(err?.message).toContain('设置');
    expect(err?.message).toContain('git_diff');

    await expect(
      tools.execute('git_commit', { message: 'feat: x' }, ctx),
    ).rejects.toThrow(/allowAgentCommits/);
  });
});
