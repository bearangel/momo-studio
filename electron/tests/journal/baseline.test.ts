// electron/tests/journal/baseline.test.ts
//
// 任务起点基线测试（未入账误归因根治，2026-09-29）：捕获逻辑 + store 三方法。
//
// fixture 照 tests/journal/detector.test.ts：AP_USER_DATA_DIR 注入临时目录 +
// runMigrations 真实建库 + __setJournalStoreForTest 注入真实 store（momo-test-rules
// 铁律 1/5：不用 mock store）。仓库发现用真实 `git init` fixture；git 命令执行用
// fake GitRunner 注入 porcelain 输出——被测对象是「解析 + hash + 落库」逻辑。
// hash 断言用 recorder.hashContent 对真实文件内容计算（锁 sha256 真实语义）。
//
// 断言清单：
//   store：insertBaseline/getBaselineMeta/listBaselinePaths 往返 + path 升序 +
//         原子性（path 行 PK 冲突 → 整笔回滚，meta 行不留）+ 空基线与无基线可区分
//   捕获：porcelain 夹具 → 路径 + hash 正确；不可读文件 hash=null；
//         degraded（非零退出 / ENOENT / 截断）→ meta degraded=1 无 path 行；
//         幂等（二次捕获 no-op，期间文件变动不影响）；workspace 不存在 → degraded；
//         store 未注入 → warn 不抛
//

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { createJournalStore } from '../../src/main/journal/store';
import { __setJournalStoreForTest, hashContent } from '../../src/main/journal/recorder';
import { captureTaskScanBaseline } from '../../src/main/journal/baseline';
import type { GitRunner } from '../../src/main/journal/detector';

const tmpRoot = path.join(os.tmpdir(), `ap-journal-baseline-${Date.now()}`);

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

/** 建 workspace 行（capture 经 getWorkspace 查 directoryPath） */
function seedWorkspace(id: string, dir: string): void {
  getDb()
    .prepare(`INSERT INTO workspaces (id, name, directory_path, owner_id) VALUES (?, ?, ?, ?)`)
    .run(id, 'Test', dir, '@owner:home');
}

/** 建目录并 git init 为仓 */
function mkRepo(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  execSync('git init -q', { cwd: dir });
  return dir;
}

/** 与 detector.test.ts 同款 fake runner：按 `-C <repo>` 分发 porcelain 输出 */
function fakeRunnerByRepo(table: Record<string, string>): GitRunner {
  return async (args) => {
    const repo = args[1] ?? '';
    return { code: 0, stdout: table[repo] ?? '', stderr: '', errCode: null, truncated: false };
  };
}

describe('store 基线三方法（真实 SQLite 往返）', () => {
  it('insertBaseline → getBaselineMeta/listBaselinePaths 往返；path 升序；camelCase 形态', () => {
    const store = createJournalStore(getDb());
    store.insertBaseline(
      { workspaceId: 'ws-1', taskId: 'T-1', capturedAt: 1234, degraded: false },
      [
        { path: 'b.txt', contentHash: 'hash-b' },
        { path: 'a.txt', contentHash: 'hash-a' },
        { path: 'gone.txt', contentHash: null },
      ],
    );

    const meta = store.getBaselineMeta('ws-1', 'T-1');
    expect(meta).toEqual({ workspaceId: 'ws-1', taskId: 'T-1', capturedAt: 1234, degraded: false });

    expect(store.listBaselinePaths('ws-1', 'T-1')).toEqual([
      { path: 'a.txt', contentHash: 'hash-a' },
      { path: 'b.txt', contentHash: 'hash-b' },
      { path: 'gone.txt', contentHash: null },
    ]);
  });

  it('无基线：getBaselineMeta 返回 null、listBaselinePaths 空数组——与空基线（meta 行存在 + 零 path 行）可区分', () => {
    const store = createJournalStore(getDb());
    expect(store.getBaselineMeta('ws-1', 'T-none')).toBeNull();
    expect(store.listBaselinePaths('ws-1', 'T-none')).toEqual([]);

    // 零脏工作区的合法空基线：meta 行存在，path 行为空
    store.insertBaseline({ workspaceId: 'ws-1', taskId: 'T-empty', capturedAt: 5, degraded: false }, []);
    expect(store.getBaselineMeta('ws-1', 'T-empty')).not.toBeNull();
    expect(store.listBaselinePaths('ws-1', 'T-empty')).toEqual([]);
  });

  it('原子性：path 行 PK 冲突 → 整笔抛错回滚，meta 行不留（半份基线不可见）', () => {
    const store = createJournalStore(getDb());
    expect(() =>
      store.insertBaseline(
        { workspaceId: 'ws-1', taskId: 'T-1', capturedAt: 1, degraded: false },
        [
          { path: 'a.txt', contentHash: 'h1' },
          { path: 'a.txt', contentHash: 'h2' }, // 同 path 重复 → PK 冲突
          { path: 'b.txt', contentHash: 'h3' },
        ],
      ),
    ).toThrow();
    // 整笔回滚：meta 与先插入的 path 行都不留
    expect(store.getBaselineMeta('ws-1', 'T-1')).toBeNull();
    expect(store.listBaselinePaths('ws-1', 'T-1')).toEqual([]);
  });

  it('degraded 标记往返（捕获失败路径写 degraded=1 空基线）', () => {
    const store = createJournalStore(getDb());
    store.insertBaseline(
      { workspaceId: 'ws-1', taskId: 'T-d', capturedAt: 9, degraded: true },
      [],
    );
    expect(store.getBaselineMeta('ws-1', 'T-d')?.degraded).toBe(true);
    expect(store.listBaselinePaths('ws-1', 'T-d')).toEqual([]);
  });
});

describe('captureTaskScanBaseline：捕获逻辑', () => {
  it('porcelain 夹具 → 脏路径（workspace 根相对 POSIX）+ 真实内容 sha256 落库', async () => {
    const ws = mkRepo(path.join(tmpRoot, 'ws-ok'));
    // 真实脏文件：hash 断言对文件内容计算（锁 sha256 真实语义，非占位符）
    fs.mkdirSync(path.join(ws, 'demo'), { recursive: true });
    fs.writeFileSync(path.join(ws, 'demo', 'index.html'), '<html>old</html>', 'utf-8');
    seedWorkspace('ws-1', ws);

    const runner = fakeRunnerByRepo({ [ws]: '?? demo/index.html\n' });
    await captureTaskScanBaseline('ws-1', 'T-1', { runner });

    const store = createJournalStore(getDb());
    const meta = store.getBaselineMeta('ws-1', 'T-1');
    expect(meta).not.toBeNull();
    expect(meta?.degraded).toBe(false);
    expect(store.listBaselinePaths('ws-1', 'T-1')).toEqual([
      { path: 'demo/index.html', contentHash: hashContent('<html>old</html>') },
    ]);
  });

  it('porcelain 报出但磁盘不存在的路径（已删除等）→ contentHash=null', async () => {
    const ws = mkRepo(path.join(tmpRoot, 'ws-ghost'));
    seedWorkspace('ws-1', ws);

    const runner = fakeRunnerByRepo({ [ws]: '?? ghost.txt\n D gone-tracked.txt\n' });
    await captureTaskScanBaseline('ws-1', 'T-1', { runner });

    const store = createJournalStore(getDb());
    expect(store.listBaselinePaths('ws-1', 'T-1')).toEqual([
      { path: 'ghost.txt', contentHash: null },
      { path: 'gone-tracked.txt', contentHash: null },
    ]);
  });

  it('多仓：根仓 + 内层仓的脏路径都归一为 workspace 根相对 POSIX', async () => {
    const ws = mkRepo(path.join(tmpRoot, 'ws-multi'));
    mkRepo(path.join(ws, 'inner'));
    seedWorkspace('ws-1', ws);

    const runner = fakeRunnerByRepo({
      [ws]: ' M README.md\n',
      [path.join(ws, 'inner')]: ' M src/a.ts\n',
    });
    await captureTaskScanBaseline('ws-1', 'T-1', { runner });

    const store = createJournalStore(getDb());
    expect(store.listBaselinePaths('ws-1', 'T-1').map((r) => r.path)).toEqual([
      'README.md',
      'inner/src/a.ts',
    ]);
  });

  it.each([
    ['非零退出（仓损坏 128）', { code: 128, errCode: null as string | null, truncated: false }],
    ['spawn ENOENT（本机无 git）', { code: null, errCode: 'ENOENT', truncated: false }],
    ['输出截断', { code: 0, errCode: null as string | null, truncated: true }],
  ])('degraded：%s → meta degraded=1、无 path 行、不抛', async (_name, failure) => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ws = mkRepo(path.join(tmpRoot, 'ws-deg'));
    seedWorkspace('ws-1', ws);

    const runner: GitRunner = async () => ({
      code: failure.code,
      stdout: '?? should-not-be-recorded.txt\n',
      stderr: 'boom',
      errCode: failure.errCode,
      truncated: failure.truncated,
    });
    await captureTaskScanBaseline('ws-1', 'T-1', { runner });

    const store = createJournalStore(getDb());
    const meta = store.getBaselineMeta('ws-1', 'T-1');
    expect(meta).not.toBeNull();
    expect(meta?.degraded).toBe(true);
    expect(store.listBaselinePaths('ws-1', 'T-1')).toEqual([]);
    warnSpy.mockRestore();
  });

  it('workspace 行不存在（workspaceDir 取不到）→ degraded 基线', async () => {
    await captureTaskScanBaseline('ws-不存在', 'T-1', { runner: fakeRunnerByRepo({}) });
    const store = createJournalStore(getDb());
    expect(store.getBaselineMeta('ws-不存在', 'T-1')?.degraded).toBe(true);
  });

  it('幂等：已有基线（含正常与 degraded）→ 二次捕获 no-op，期间文件变动不影响', async () => {
    const ws = mkRepo(path.join(tmpRoot, 'ws-idem'));
    fs.writeFileSync(path.join(ws, 'a.txt'), 'v1', 'utf-8');
    seedWorkspace('ws-1', ws);

    const runner = fakeRunnerByRepo({ [ws]: '?? a.txt\n' });
    await captureTaskScanBaseline('ws-1', 'T-1', { runner });

    // 期间文件内容变了（模拟 agent 已开工写入）
    fs.writeFileSync(path.join(ws, 'a.txt'), 'v2-changed-by-agent', 'utf-8');
    // 二次捕获（resume 场景）：幂等守卫直接跳过，基线保持首次内容 hash
    await captureTaskScanBaseline('ws-1', 'T-1', { runner });

    const store = createJournalStore(getDb());
    expect(store.listBaselinePaths('ws-1', 'T-1')).toEqual([
      { path: 'a.txt', contentHash: hashContent('v1') },
    ]);

    // degraded 基线同样幂等：不升级为正常基线（避免半程状态）
    const runner2 = fakeRunnerByRepo({ [ws]: '' });
    await captureTaskScanBaseline('ws-1', 'T-deg', {
      runner: async () => ({ code: 128, stdout: '', stderr: '', errCode: null, truncated: false }),
    });
    await captureTaskScanBaseline('ws-1', 'T-deg', { runner: runner2 });
    expect(store.getBaselineMeta('ws-1', 'T-deg')?.degraded).toBe(true);
  });

  it('store 未注入 → warn 不抛（best-effort 铁律：绝不阻塞任务启动）', async () => {
    __setJournalStoreForTest(null);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(captureTaskScanBaseline('ws-1', 'T-1', { runner: fakeRunnerByRepo({}) })).resolves.toBeUndefined();
    warnSpy.mockRestore();
  });

  it('零脏工作区 → 合法空基线（degraded=false + 零 path 行）', async () => {
    const ws = mkRepo(path.join(tmpRoot, 'ws-clean'));
    seedWorkspace('ws-1', ws);
    await captureTaskScanBaseline('ws-1', 'T-1', { runner: fakeRunnerByRepo({ [ws]: '' }) });
    const store = createJournalStore(getDb());
    const meta = store.getBaselineMeta('ws-1', 'T-1');
    expect(meta?.degraded).toBe(false);
    expect(store.listBaselinePaths('ws-1', 'T-1')).toEqual([]);
  });
});
