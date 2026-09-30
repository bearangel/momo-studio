// electron/tests/task/starter-baseline.test.ts
//
// startTask → 任务起点基线捕获集成测试（未入账误归因根治，2026-09-29）。
//
// fixture 照 tests/task/starter.test.ts + tests/journal/detector.test.ts：
// 真实 runMigrations + 真实 createJournalStore 注入（momo-test-rules 铁律 1：
// 禁 mock store 掩盖真实落库语义）+ 真实 `git init` workspace 目录 + 真实
// defaultGitRunner（容器/主机有 git——startTask 不接受 runner 注入，生产
// 永远走 default，测试同路径才是真集成）。
//
// 断言清单：
//   1. startTask 后基线已捕获：meta 行存在 + 真实脏文件路径 + 真实内容 sha256
//   2. 捕获失败（.git/HEAD 损坏 → git status 非零）不阻塞启动：任务仍
//      in_progress，落 degraded 基线
//   3. resumePausedTask 二次恢复：幂等守卫跳过（capturedAt 不变），
//      kickoff 重注入照常发起
//   4. 事务性：捕获失败时任务行/会话行不受影响（基线是 best-effort 旁路）
//
// mock 边界（momo-test-rules 铁律 5）：仅 mock 会话服务边界（sendUserMessage
// 真身是 insertMessage + 接待路由重链路，照 lifecycle.test.ts 先例拦截为
// 成功值）；DB / 状态机 / starter / git 全部真实运行。
//

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { insertTask, transitionTaskStatus } from '../../src/main/storage/tasks/repo';
import { createJournalStore } from '../../src/main/journal/store';
import { __setJournalStoreForTest, hashContent } from '../../src/main/journal/recorder';
import * as sessionServiceMod from '../../src/main/im/session-service';

// starter/lifecycle 延迟 import（照 starter.test.ts：import 发生在全部 vi.mock
// 提升之后）
type StarterModule = typeof import('../../src/main/task/starter');
type LifecycleModule = typeof import('../../src/main/task/lifecycle');
let startTask!: StarterModule['startTask'];
let resumePausedTask!: LifecycleModule['resumePausedTask'];
beforeAll(async () => {
  ({ startTask } = await import('../../src/main/task/starter'));
  ({ resumePausedTask } = await import('../../src/main/task/lifecycle'));
});

// spy 模块导出（tsc→CJS 编译为属性访问，spy 生效——照 lifecycle.test.ts 先例）
const sendUserMessageSpy = vi
  .spyOn(sessionServiceMod, 'sendUserMessage')
  .mockResolvedValue({ ok: true } as never);

const tmpRoot = path.join(
  os.tmpdir(),
  `ap-starter-baseline-${Date.now()}-${Math.random().toString(36).slice(2)}`,
);

/** seed workspace 行（directoryPath 指向真实 git fixture 目录） */
function seedWorkspaceWithDir(id: string, dir: string): void {
  getDb()
    .prepare(`INSERT INTO workspaces (id, name, directory_path, owner_id) VALUES (?, ?, ?, ?)`)
    .run(id, 'Test', dir, '@owner:home');
}

/** 真实 git fixture：workspace 根为 git 仓，带两个真实脏文件 */
function mkDirtyGitWorkspace(wsId: string): string {
  const ws = fs.mkdtempSync(path.join(tmpRoot, 'ws-'));
  execSync('git init -q', { cwd: ws });
  fs.mkdirSync(path.join(ws, 'demo-static-site'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'demo-static-site', 'index.html'), 'historical dirty', 'utf-8');
  fs.writeFileSync(path.join(ws, 'preexisting.txt'), 'dirty before task start', 'utf-8');
  seedWorkspaceWithDir(wsId, ws);
  return ws;
}

beforeEach(() => {
  vi.clearAllMocks();
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

describe('startTask：任务起点基线捕获接线', () => {
  it('启动后基线已捕获（真实 git + 真实 store）：脏路径 + 真实内容 sha256 落库', async () => {
    mkDirtyGitWorkspace('ws-1');
    const t = insertTask({
      workspaceId: 'ws-1',
      title: 'T1',
      creatorUserId: '@owner:home',
    });
    transitionTaskStatus(t.id, 'assigned');

    const result = await startTask(t.id, { createNewRoom: true });
    expect(result.task.status).toBe('in_progress');

    const store = createJournalStore(getDb());
    const meta = store.getBaselineMeta('ws-1', t.id);
    expect(meta).not.toBeNull();
    expect(meta?.degraded).toBe(false);
    // 真实 git status 报出的脏路径（workspace 根相对 POSIX）+ 真实内容 sha256
    expect(store.listBaselinePaths('ws-1', t.id)).toEqual([
      { path: 'demo-static-site/index.html', contentHash: hashContent('historical dirty') },
      { path: 'preexisting.txt', contentHash: hashContent('dirty before task start') },
    ]);
  });

  it('捕获失败（.git/HEAD 损坏 → git status 非零）不阻塞启动：任务 in_progress + degraded 基线', async () => {
    const wsDir = mkDirtyGitWorkspace('ws-1');
    // .git 存在（discoverRepos 会发现根仓）但 HEAD 损坏 → git status 非零 → 降级
    fs.writeFileSync(path.join(wsDir, '.git', 'HEAD'), 'garbage-not-a-ref', 'utf-8');

    const t = insertTask({
      workspaceId: 'ws-1',
      title: 'T2',
      creatorUserId: '@owner:home',
    });
    transitionTaskStatus(t.id, 'assigned');

    const result = await startTask(t.id, { createNewRoom: true });
    // 铁律：捕获失败绝不阻塞任务启动
    expect(result.task.status).toBe('in_progress');

    const store = createJournalStore(getDb());
    const meta = store.getBaselineMeta('ws-1', t.id);
    expect(meta).not.toBeNull();
    expect(meta?.degraded).toBe(true);
    expect(store.listBaselinePaths('ws-1', t.id)).toEqual([]);
  });

  it('resumePausedTask 二次恢复：幂等守卫跳过（capturedAt 不变），kickoff 重注入照常', async () => {
    const wsDir = mkDirtyGitWorkspace('ws-1');
    const t = insertTask({
      workspaceId: 'ws-1',
      title: 'T3',
      creatorUserId: '@owner:home',
    });
    transitionTaskStatus(t.id, 'assigned');
    await startTask(t.id, { createNewRoom: true });

    const store = createJournalStore(getDb());
    const first = store.getBaselineMeta('ws-1', t.id);
    expect(first?.degraded).toBe(false);

    // 暂停（agent 写入一个新脏文件模拟任务已推进——二次捕获若未跳过会把它记进基线）
    fs.writeFileSync(path.join(wsDir, 'agent-made.txt'), 'made during task', 'utf-8');
    transitionTaskStatus(t.id, 'paused');

    await resumePausedTask(t.id);

    // 幂等：基线未被二次捕获覆盖（capturedAt 不变、无新 path 行）
    const second = store.getBaselineMeta('ws-1', t.id);
    expect(second?.capturedAt).toBe(first?.capturedAt);
    expect(store.listBaselinePaths('ws-1', t.id).map((r) => r.path)).toEqual([
      'demo-static-site/index.html',
      'preexisting.txt',
    ]);
    // kickoff 重注入照常发起（K7-5 既有行为不被基线接线破坏）
    expect(sendUserMessageSpy).toHaveBeenCalled();
  });

  it('journal store 未注入：startTask 仍成功（best-effort 旁路，不留任何基线行）', async () => {
    mkDirtyGitWorkspace('ws-1');
    __setJournalStoreForTest(null);

    const t = insertTask({
      workspaceId: 'ws-1',
      title: 'T4',
      creatorUserId: '@owner:home',
    });
    transitionTaskStatus(t.id, 'assigned');

    const result = await startTask(t.id, { createNewRoom: true });
    expect(result.task.status).toBe('in_progress');

    // 恢复注入后断言：无基线行（capture 在未注入时纯 warn 跳过）
    __setJournalStoreForTest(createJournalStore(getDb()));
    expect(createJournalStore(getDb()).getBaselineMeta('ws-1', t.id)).toBeNull();
  });
});
