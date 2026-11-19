// electron/tests/storage/084_recurrence_chain_root.test.ts
//
// 迁移 084：tasks.recurrence_chain_root 列 + 存量循环链 WITH RECURSIVE 回填。
// 末位哨兵自 083 测试移入（070→080→082→083 先例：新迁移落地后末位断言随迁）。
import { describe, it, expect } from 'vitest';
import { loadMigrations } from '../../src/main/storage/migrations';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { insertTask, getTask } from '../../src/main/storage/tasks/repo';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('migration 084 循环链根列 + 存量回填', () => {
  const tmpRoot = path.join(os.tmpdir(), `ap-m084-${Date.now()}-${Math.random().toString(36).slice(2)}`);

  it('用例 F：084 注册为最新迁移（末位哨兵自 083 测试移入）', () => {
    const versions = loadMigrations().map((m) => m.version);
    expect(versions).toContain(84);
    expect(versions[versions.length - 1]).toBe(84);
    expect(new Set(versions).size).toBe(versions.length);
  });

  // 回填 SQL 在迁移内联执行（建库即跑，无法在 084 前插入存量数据单测）——
  // 其语义由 recurrence.test.ts「归档区聚合」（手工构造链）与 spawn 继承
  // （recurrenceChainRoot ?? id）共同覆盖；此处锁迁移注册与列可写读。
  it('列已建：insertTask 带 recurrenceChainRoot 可写读', () => {
    fs.mkdirSync(tmpRoot, { recursive: true });
    process.env.AP_USER_DATA_DIR = tmpRoot;
    runMigrations();
    getDb()
      .prepare(`INSERT INTO workspaces (id, name, directory_path, owner_id) VALUES ('ws1', 'T', '/tmp', '@o')`)
      .run();
    const t = insertTask({
      workspaceId: 'ws1', title: '日报', creatorUserId: 'o',
      recurrenceChainRoot: 'T-000001',
    });
    expect(getTask(t.id)!.recurrenceChainRoot).toBe('T-000001');
    closeDb();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    delete process.env.AP_USER_DATA_DIR;
  });
});
