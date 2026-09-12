// electron/tests/journal/detector.test.ts
//
// git 探测器测试（v2.5 变更账本 Task 5）：多仓发现 + 未入账扫描。
//
// fixture 照 tests/journal/store.test.ts：AP_USER_DATA_DIR 注入临时目录 +
// runMigrations 真实建库 + __setJournalStoreForTest 注入真实 store——
// journal 对账走真实 SQLite（momo-test-rules 铁律 1）。
// 仓库发现用真实 `git init` fixture（外层 repo + inner/ 内层 repo + inner2/
// 普通目录）；git 命令执行用 fake GitRunner 注入 porcelain 输出——探测的
// 对象是「解析 + 对账」逻辑，不是 git 本身。
//
// 断言清单（task brief Step 1）：
//   discoverRepos：根仓 + 内层仓发现 / 深度限制（默认 3 层）/ 跳过
//     node_modules 与隐藏目录 / 缓存 mtime 命中与失效 / 目录不存在
//   scanUnjournaled：差集正确（journaled=git变更∩账本、unjournaled=差集）/
//     untracked 计入 / rename 取新路径 / 引号八进制 CJK 路径还原 /
//     taskId=null 用全 workspace 并集（设计裁定）/ 账本路径反斜杠 POSIX 对齐 /
//     ENOENT 与非零退出与截断均 degraded / store 未注入 fail-fast
//

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { createJournalStore } from '../../src/main/journal/store';
import { __setJournalStoreForTest } from '../../src/main/journal/recorder';
import { discoverRepos } from '../../src/main/git/repos';
import { scanUnjournaled, defaultGitRunner } from '../../src/main/journal/detector';
import type { GitRunner } from '../../src/main/journal/detector';
import type { JournalEntry } from '../../src/main/journal/types';

const tmpRoot = path.join(os.tmpdir(), `ap-journal-detector-${Date.now()}`);

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  __setJournalStoreForTest(createJournalStore(getDb()));
});

afterEach(() => {
  __setJournalStoreForTest(null);
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

function gitInit(dir: string): void {
  execSync('git init -q', { cwd: dir });
}

/** 建目录并 init 为仓（显式传路径：mkdirSync recursive 的返回值是首个创建目录，不可靠） */
function mkRepo(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  gitInit(dir);
  return dir;
}

/** 标准 fixture：外层 repo + inner/ 内层 repo + inner2/ 普通目录 */
function mkWorkspace(): string {
  const ws = fs.mkdtempSync(path.join(tmpRoot, 'ws-'));
  gitInit(ws);
  mkRepo(path.join(ws, 'inner'));
  fs.mkdirSync(path.join(ws, 'inner2'));
  return ws;
}

/** 生产语义条目构造器（照 store.test.ts 模式） */
function entry(overrides: Partial<JournalEntry> = {}): JournalEntry {
  return {
    id: `je_${randomUUID()}`,
    workspaceId: 'ws-A',
    taskId: 'T-1',
    sessionId: 'sess-1',
    streamSessionId: 'stream-1',
    toolName: 'write_file',
    path: 'README.md',
    op: 'create',
    beforeHash: null,
    afterHash: null,
    oldPath: null,
    createdAt: 1_000,
    ...overrides,
  };
}

/**
 * fake runner：按 `-C <repo>` 的 repo 根分发表；记录每次调用参数。
 * 输出壳（code/stderr/errCode/truncated）默认成功形态，失败场景单独构造。
 */
function fakeRunnerByRepo(
  table: Record<string, string>,
): { runner: GitRunner; calls: string[][] } {
  const calls: string[][] = [];
  const runner: GitRunner = async (args) => {
    calls.push(args);
    // 约定：args = ['-C', repo, 'status', ...]，repo 恒在第二位
    const repo = args[1] ?? '';
    return { code: 0, stdout: table[repo] ?? '', stderr: '', errCode: null, truncated: false };
  };
  return { runner, calls };
}

describe('discoverRepos：多仓发现', () => {
  it('外层根仓 + 内层仓发现；inner2 普通目录不含；返回绝对路径、根在前', () => {
    const ws = mkWorkspace();
    expect(discoverRepos(ws)).toEqual([ws, path.join(ws, 'inner')]);
  });

  it('根目录非 git 仓库 → 根不含，仅内层仓', () => {
    const ws = fs.mkdtempSync(path.join(tmpRoot, 'ws-'));
    mkRepo(path.join(ws, 'inner'));
    expect(discoverRepos(ws)).toEqual([path.join(ws, 'inner')]);
  });

  it('深度限制：默认 3 层内发现、第 4 层不发现；maxDepth=1 只看第一层', () => {
    // 默认深度边界：d1/d2/d3（第 3 层）发现，d1/d2/d3/d4（第 4 层）不发现
    // 注意：mkdirSync recursive 返回首个创建的目录——gitInit 必须显式传目标路径
    const ws = fs.mkdtempSync(path.join(tmpRoot, 'ws-'));
    fs.mkdirSync(path.join(ws, 'd1/d2/d3'), { recursive: true });
    gitInit(path.join(ws, 'd1/d2/d3'));
    fs.mkdirSync(path.join(ws, 'd1/d2/d3/d4'), { recursive: true });
    gitInit(path.join(ws, 'd1/d2/d3/d4'));
    expect(discoverRepos(ws)).toEqual([path.join(ws, 'd1/d2/d3')]);

    // 显式 maxDepth=1：inner（第 1 层）发现，inner/deep（第 2 层）不发现
    const ws2 = mkWorkspace();
    fs.mkdirSync(path.join(ws2, 'inner/deep'), { recursive: true });
    gitInit(path.join(ws2, 'inner/deep'));
    expect(discoverRepos(ws2, 1)).toEqual([ws2, path.join(ws2, 'inner')]);
    expect(discoverRepos(ws2, 2)).toEqual([ws2, path.join(ws2, 'inner'), path.join(ws2, 'inner/deep')]);
  });

  it('跳过 node_modules 与隐藏目录（.git 内部天然不深入）', () => {
    const ws = mkWorkspace();
    mkRepo(path.join(ws, 'node_modules/pkg'));
    mkRepo(path.join(ws, '.hidden/r'));
    const repos = discoverRepos(ws);
    expect(repos).toEqual([ws, path.join(ws, 'inner')]);
    expect(repos.some((r) => r.includes('node_modules'))).toBe(false);
    expect(repos.some((r) => r.includes('.hidden'))).toBe(false);
  });

  it('缓存：根 mtime 未变 → 命中不重 walk（期间新生的内层仓不可见）；根 mtime 变 → 重算', () => {
    const ws = fs.mkdtempSync(path.join(tmpRoot, 'ws-'));
    gitInit(ws); // 根仓
    fs.mkdirSync(path.join(ws, 'inner')); // inner 尚非 repo
    expect(discoverRepos(ws)).toEqual([ws]);

    // inner 变 repo 只改 inner 自身 mtime，根 mtime 不变 → 缓存命中、不重 walk：
    // 若此刻重 walk 会发现 inner（结果应仍是 [ws]——以此证明短路）
    gitInit(path.join(ws, 'inner'));
    expect(discoverRepos(ws)).toEqual([ws]);

    // 根目录新增条目 → 根 mtime 变化 → 缓存失效重算，inner 可见
    fs.writeFileSync(path.join(ws, 'marker.txt'), 'bump');
    expect(discoverRepos(ws)).toEqual([ws, path.join(ws, 'inner')]);
  });

  it('workspaceDir 不存在 → 空数组（防御，不抛错）', () => {
    expect(discoverRepos(path.join(tmpRoot, 'no-such-dir'))).toEqual([]);
  });
});

describe('scanUnjournaled：账外变更对账', () => {
  it('差集正确 + untracked 计入 + rename 取新路径 + 引号八进制 CJK 路径还原 + runner 参数形态', async () => {
    const ws = mkWorkspace();
    // 账本：T-1 记了两笔（内层仓相对 workspace 根的路径 + 根仓路径）
    const store = createJournalStore(getDb());
    store.insert(entry({ path: 'inner/src/a.ts', op: 'modify' }));
    store.insert(entry({ path: 'README.md', op: 'create' }));

    // porcelain 输出按 repo 分发：根仓有 M + 未跟踪；内层仓有 M + rename + 引号 CJK 未跟踪
    // \346\226\207 = 文（E6 96 87）、\346\234\253 = 末（E6 9C AB）——git 对非 ASCII 路径的八进制转义形态
    const { runner, calls } = fakeRunnerByRepo({
      [ws]: ' M README.md\n?? notes.md\n',
      [path.join(ws, 'inner')]:
        ' M src/a.ts\nR  src/old.ts -> src/new.ts\n?? "spa ce/\\346\\226\\207\\346\\234\\253.txt"\n',
    });

    const result = await scanUnjournaled('ws-A', ws, 'T-1', { runner });

    expect(result.degraded).toBe(false);
    expect(result.repos).toEqual([ws, path.join(ws, 'inner')]);
    // journaled = git 变更 ∩ 账本路径（POSIX、相对 workspace 根、排序）
    expect(result.journaled).toEqual(['README.md', 'inner/src/a.ts']);
    // unjournaled = git 变更 − 账本路径：rename 取新路径、untracked 计入、CJK 路径还原
    expect(result.unjournaled).toEqual([
      'inner/spa ce/文末.txt',
      'inner/src/new.ts',
      'notes.md',
    ]);
    // runner 收到的参数形态：-C <repo> status --porcelain=v1 --untracked-files=all
    expect(calls).toEqual([
      ['-C', ws, 'status', '--porcelain=v1', '--untracked-files=all'],
      ['-C', path.join(ws, 'inner'), 'status', '--porcelain=v1', '--untracked-files=all'],
    ]);
  });

  it('taskId=null → journaled 集为全 workspace 条目并集（跨任务条目算已入账）；指定 taskId 时归未入账', async () => {
    const ws = mkWorkspace();
    const store = createJournalStore(getDb());
    store.insert(entry({ taskId: 'T-1', path: 'README.md', createdAt: 100 }));
    store.insert(entry({ taskId: 'T-2', path: 'shared.md', createdAt: 200 }));
    store.insert(entry({ taskId: null, sessionId: null, path: 'quick.md', createdAt: 300 }));

    // 根仓变更：shared.md（T-2 记的）+ quick2.md（未记账）；内层仓无变更
    const { runner } = fakeRunnerByRepo({
      [ws]: ' M shared.md\n?? quick2.md\n',
      [path.join(ws, 'inner')]: '',
    });

    // taskId=null：对账基线是全 workspace 并集——shared.md 虽属 T-2 也算已入账
    const nullScan = await scanUnjournaled('ws-A', ws, null, { runner });
    expect(nullScan.degraded).toBe(false);
    expect(nullScan.journaled).toEqual(['shared.md']);
    expect(nullScan.unjournaled).toEqual(['quick2.md']);

    // 指定 T-1：T-1 只记了 README.md，shared.md 归未入账
    const t1Scan = await scanUnjournaled('ws-A', ws, 'T-1', { runner });
    expect(t1Scan.journaled).toEqual([]);
    expect(t1Scan.unjournaled).toEqual(['quick2.md', 'shared.md']);
  });

  it('Windows 对齐：账本路径含反斜杠 → 统一 POSIX 后对齐命中', async () => {
    const ws = mkWorkspace();
    const store = createJournalStore(getDb());
    // 模拟 Windows 记账侧落库路径形态 inner\src\a.ts
    store.insert(entry({ path: 'inner\\src\\a.ts', op: 'modify' }));

    const { runner } = fakeRunnerByRepo({
      [ws]: '',
      [path.join(ws, 'inner')]: ' M src/a.ts\n',
    });

    const result = await scanUnjournaled('ws-A', ws, 'T-1', { runner });
    expect(result.journaled).toEqual(['inner/src/a.ts']);
    expect(result.unjournaled).toEqual([]);
  });

  it('git ENOENT → degraded=true + 空结果（spec：本机无 git 无法交叉核对）', async () => {
    const ws = mkWorkspace();
    const runner: GitRunner = async () => ({
      code: null,
      stdout: '',
      stderr: 'spawn git ENOENT',
      errCode: 'ENOENT',
      truncated: false,
    });
    const result = await scanUnjournaled('ws-A', ws, 'T-1', { runner });
    expect(result).toEqual({ journaled: [], unjournaled: [], repos: [], degraded: true });
  });

  it('git 非零退出（非 ENOENT，如仓库损坏 128）→ 同样 degraded（不半真半假）', async () => {
    const ws = mkWorkspace();
    const runner: GitRunner = async () => ({
      code: 128,
      stdout: '',
      stderr: 'fatal: not a git repository',
      errCode: null,
      truncated: false,
    });
    const result = await scanUnjournaled('ws-A', ws, 'T-1', { runner });
    expect(result.degraded).toBe(true);
    expect(result.unjournaled).toEqual([]);
  });

  it('输出截断 → degraded（porcelain 不完整不可对账）', async () => {
    const ws = mkWorkspace();
    const runner: GitRunner = async () => ({
      code: 0,
      stdout: ' M README.md',
      stderr: '',
      errCode: null,
      truncated: true,
    });
    const result = await scanUnjournaled('ws-A', ws, 'T-1', { runner });
    expect(result.degraded).toBe(true);
    expect(result.journaled).toEqual([]);
  });

  it('store 未注入 → fail-fast 抛错（接线缺陷不该静默降级）', async () => {
    const ws = mkWorkspace();
    __setJournalStoreForTest(null);
    const { runner } = fakeRunnerByRepo({ [ws]: '' });
    await expect(scanUnjournaled('ws-A', ws, 'T-1', { runner })).rejects.toThrow(/未注入/);
  });

  it('porcelain 空输出 → 双空列表 + degraded=false；路径顺序排序稳定', async () => {
    const ws = mkWorkspace();
    const { runner } = fakeRunnerByRepo({ [ws]: '', [path.join(ws, 'inner')]: '' });
    const result = await scanUnjournaled('ws-A', ws, 'T-1', { runner });
    expect(result).toEqual({
      journaled: [],
      unjournaled: [],
      repos: [ws, path.join(ws, 'inner')],
      degraded: false,
    });
  });
});

describe('defaultGitRunner 真实冒烟（T5 移交：锁 runner 边界本体）', () => {
  it('真实跑 git --version：code 0 + stdout 含版本号（spawn/超时/截断壳层之外的真实执行面）', async () => {
    const r = await defaultGitRunner(['--version']);
    expect(r.code).toBe(0);
    expect(r.errCode).toBeNull();
    expect(r.truncated).toBe(false);
    expect(r.stdout).toMatch(/git version \d+\.\d+/);
  });
});
