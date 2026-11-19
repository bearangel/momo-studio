// electron/tests/task/recurrence.test.ts
//
// nextRun 纯函数 + spawnNextInstanceIfRecurring 测试。
// 时间全部注入固定值，不依赖真实时钟（防 flaky）。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { insertTask, getTask, listTasks, listRecurrenceArchiveGroups } from '../../src/main/storage/tasks/repo';
import { nextRun, spawnNextInstanceIfRecurring } from '../../src/main/task/recurrence';

const tmpRoot = path.join(os.tmpdir(), `ap-rec-${Date.now()}-${Math.random().toString(36).slice(2)}`);

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  getDb()
    .prepare(`INSERT INTO workspaces (id, name, directory_path, owner_id) VALUES (?, ?, ?, ?)`)
    .run('ws1', 'Test', '/tmp', '@owner:home');
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

describe('nextRun 纯函数', () => {
  // 2026-09-07 08:30 (周一) UTC+0 本地时区无关——用 Date 构造
  const base = new Date(2026, 8, 7, 8, 30).getTime();

  it('every:30m → 完成时间 + 30 分钟', () => {
    expect(nextRun(base, 'every:30m')).toBe(base + 30 * 60_000);
  });
  it('every:2h / every:1d 单位换算', () => {
    expect(nextRun(base, 'every:2h')).toBe(base + 2 * 3_600_000);
    expect(nextRun(base, 'every:1d')).toBe(base + 86_400_000);
  });
  it('daily@09:00 → 当天 09:00（08:30 未过）', () => {
    expect(nextRun(base, 'daily@09:00')).toBe(new Date(2026, 8, 7, 9, 0).getTime());
  });
  it('daily@09:00 → 已过 09:00 取明天', () => {
    const late = new Date(2026, 8, 7, 9, 30).getTime();
    expect(nextRun(late, 'daily@09:00')).toBe(new Date(2026, 8, 8, 9, 0).getTime());
  });
  it('weekly@1,09:00 → 周一 08:30 取当天；周一 09:30 取下周一', () => {
    expect(nextRun(base, 'weekly@1,09:00')).toBe(new Date(2026, 8, 7, 9, 0).getTime());
    const late = new Date(2026, 8, 7, 9, 30).getTime();
    expect(nextRun(late, 'weekly@1,09:00')).toBe(new Date(2026, 8, 14, 9, 0).getTime());
  });
  it('weekly@3,09:00 → 周一取本周三', () => {
    expect(nextRun(base, 'weekly@3,09:00')).toBe(new Date(2026, 8, 9, 9, 0).getTime());
  });
  it('非法规则 / 非法数值 → null', () => {
    expect(nextRun(base, 'cron:0 9 * * *')).toBeNull();
    expect(nextRun(base, 'every:0m')).toBeNull();
    expect(nextRun(base, 'daily@25:00')).toBeNull();
    expect(nextRun(base, '')).toBeNull();
  });
});

describe('spawnNextInstanceIfRecurring', () => {
  // 泳道语义重构（2026-09-30 §4.3）：续期实例落 assigned（建即入队），下次
  // 时间由 executor 闸门管——旧「pending 待 scheduler 升级」中转退役
  it('completed + every:30m → 生成 assigned 下一实例（字段复制 + scheduledAt + 母链）', () => {
    const now = Date.now();
    insertTask({
      workspaceId: 'ws1', title: '日报', description: '写日报', creatorUserId: 'owner',
      priority: 5, assigneeAgentId: 'inst1', recurrenceRule: 'every:30m',
      status: 'in_progress', startedAt: now - 60_000,
    });
    getDb().prepare(
      `UPDATE tasks SET status='completed', completed_at=? WHERE id='T-001'`,
    ).run(now);
    // completed 由 updateTask 裸写（此处测 spawn，不测状态机）

    spawnNextInstanceIfRecurring('T-001');

    const next = listTasks({ workspaceId: 'ws1' }).find((t) => t.id !== 'T-001')!;
    expect(next.status).toBe('assigned');
    expect(next.recurrenceParentId).toBe('T-001');
    expect(next.recurrenceRule).toBe('every:30m');
    expect(next.assigneeAgentId).toBe('inst1');
    expect(next.scheduledAt).toBe(now + 30 * 60_000);
    expect(next.title).toBe('日报');
    expect(next.deadlineAt).toBeNull(); // deadline 不复制（spec §7.2）
  });

  it('续期实例未来 scheduledAt → executor 闸门不捞（等下个周期自动跑）', async () => {
    const now = Date.now();
    insertTask({
      workspaceId: 'ws1', title: '每时', creatorUserId: 'owner',
      assigneeAgentId: 'inst1', recurrenceRule: 'every:1h',
      status: 'in_progress', startedAt: now - 60_000,
    });
    getDb().prepare(
      `UPDATE tasks SET status='completed', completed_at=? WHERE id='T-001'`,
    ).run(now);
    spawnNextInstanceIfRecurring('T-001');

    // executor 评估一轮：未来时间（now+1h）被闸门拦下，留排队中
    const { TaskExecutor } = await import('../../src/main/task/executor');
    const ex = new TaskExecutor();
    ex.init({ sendKickoff: vi.fn().mockResolvedValue(undefined), getGlobalMax: () => 3 });
    await ex.admitOnce();
    const next = listTasks({ workspaceId: 'ws1' }).find((t) => t.id !== 'T-001')!;
    expect(next.status).toBe('assigned'); // 排队中等到点
  });

  it('failed / 无规则 / 非 completed → 不生成', () => {
    insertTask({ workspaceId: 'ws1', title: 'A', creatorUserId: 'owner', recurrenceRule: 'every:1h', status: 'failed' });
    insertTask({ workspaceId: 'ws1', title: 'B', creatorUserId: 'owner', status: 'completed' });
    spawnNextInstanceIfRecurring('T-001');
    spawnNextInstanceIfRecurring('T-002');
    expect(listTasks({ workspaceId: 'ws1' })).toHaveLength(2);
  });
});


// 2026-11-19 归档聚合 spec：循环完成 → 续期成功即自动归档旧实例（已完成泳道
// 只留活跃实例）+ 续期实例继承链根（recurrenceChainRoot = 前任 root ?? 前任 id，
// 聚合键恒等于链上第一个实例 id）；链断（规则坏/无规则）不归档——最后实例留
// completed 作循环终点记录。
describe('循环任务自动归档 + 链根继承（2026-11-19）', () => {
  function seedCompleted(rule: string | null, opts: { chainRoot?: string | null; parentId?: string } = {}): string {
    const t = insertTask({
      workspaceId: 'ws1', title: '日报', description: '', creatorUserId: 'owner',
      status: 'completed', recurrenceRule: rule,
      completedAt: new Date(2026, 10, 19, 9, 0).getTime(),
      ...(opts.parentId ? { recurrenceParentId: opts.parentId } : {}),
      ...(opts.chainRoot !== undefined ? { recurrenceChainRoot: opts.chainRoot } : {}),
    });
    return t.id;
  }

  it('续期成功 → 新实例继承验收策略与执行会话（D8/D9：巡检循环零打扰 + 一条时间线）', () => {
    const firstId = insertTask({
      workspaceId: 'ws1', title: '检查邮件', description: '', creatorUserId: 'owner',
      status: 'completed', recurrenceRule: 'every:1h', autoAccept: true,
      completedAt: 1, executionSessionId: 'sess-reuse-1',
    }).id;
    spawnNextInstanceIfRecurring(firstId);
    const next = listTasks({ workspaceId: 'ws1', archived: 'exclude' })[0]!;
    expect(next.autoAccept).toBe(true);          // D8：策略继承
    expect(next.executionSessionId).toBe('sess-reuse-1'); // D9：会话复用（继承上一轮）
  });

  it('续期成功 → 旧实例自动归档 + 新实例继承链根', () => {
    const firstId = seedCompleted('daily@09:00');
    spawnNextInstanceIfRecurring(firstId);
    const first = getTask(firstId)!;
    expect(first.archivedAt).not.toBeNull(); // 看板（archived:'exclude'）不再显示
    const second = listTasks({ workspaceId: 'ws1', archived: 'exclude' })[0]!;
    expect(second.recurrenceParentId).toBe(firstId);
    expect(second.recurrenceChainRoot).toBe(firstId); // 首任链根 = 自己 id
    expect(second.archivedAt).toBeNull();

    // 第二次续期：链根稳定不变（恒等于第一个实例 id）
    getDb().prepare(`UPDATE tasks SET status='completed', completed_at=? WHERE id=?`)
      .run(new Date(2026, 10, 20, 9, 0).getTime(), second.id);
    spawnNextInstanceIfRecurring(second.id);
    const third = listTasks({ workspaceId: 'ws1', archived: 'exclude' })[0]!;
    expect(third.recurrenceChainRoot).toBe(firstId);
    expect(getTask(second.id)!.archivedAt).not.toBeNull();
  });

  it('链断（规则解析失败）→ 不归档、不续期（最后实例留 completed 泳道）', () => {
    const id = seedCompleted('cron:0 9 * * *'); // 非法规则
    spawnNextInstanceIfRecurring(id);
    expect(getTask(id)!.archivedAt).toBeNull();
    expect(listTasks({ workspaceId: 'ws1' })).toHaveLength(1);
  });

  it('无规则完成 → 不归档（普通任务行为不变）', () => {
    const id = seedCompleted(null);
    spawnNextInstanceIfRecurring(id);
    expect(getTask(id)!.archivedAt).toBeNull();
  });

  it('归档区聚合：同链实例 GROUP BY 链根（次数含根行 / 标题取最新 / 最近完成排序）', () => {
    // 手工归档的存量链（模拟迁移回填后的既有数据）
    const root = insertTask({ workspaceId: 'ws1', title: '旧名日报', creatorUserId: 'owner', status: 'completed', completedAt: new Date(2026, 10, 1).getTime(), archivedAt: 1 });
    const mid = insertTask({ workspaceId: 'ws1', title: '日报', creatorUserId: 'owner', status: 'completed', recurrenceParentId: root.id, recurrenceChainRoot: root.id, completedAt: new Date(2026, 10, 10).getTime(), archivedAt: 2 });
    insertTask({ workspaceId: 'ws1', title: '日报', creatorUserId: 'owner', status: 'completed', recurrenceParentId: mid.id, recurrenceChainRoot: root.id, completedAt: new Date(2026, 10, 18).getTime(), archivedAt: 3 });
    // 噪音：无链归档任务（不应进聚合）
    insertTask({ workspaceId: 'ws1', title: '一次性任务', creatorUserId: 'owner', status: 'failed', archivedAt: 4 });

    const groups = listRecurrenceArchiveGroups('ws1');
    expect(groups).toHaveLength(1);
    expect(groups[0]!.chainRoot).toBe(root.id);
    expect(groups[0]!.instanceCount).toBe(3); // 根行（root NULL 按 id 归组）+ 2 实例
    expect(groups[0]!.title).toBe('日报'); // 最新实例标题
    expect(groups[0]!.latestCompletedAt).toBe(new Date(2026, 10, 18).getTime());
  });
});
