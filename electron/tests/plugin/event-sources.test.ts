// electron/tests/plugin/event-sources.test.ts
//
// 15 事件源落位锁：storage 层 setter 注入（依赖方向防反向）/ 事务外分发
// （Review Focus #5）/ resource·workspace 映射。emit 回调 mock 收集断言。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { wirePluginEventSources } from '../../src/main/plugin/event-sources';
import { getPluginBus } from '../../src/main/plugin/bus-instance';
import { insertSession, deleteSession } from '../../src/main/storage/sessions/repo';
import { insertTask, transitionTaskStatus } from '../../src/main/storage/tasks/repo';
import { closeDb, getDb, runMigrations } from '../../src/main/storage/db';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-pevt-'));
const seen: Array<{ event: string; payload: unknown }> = [];

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  seen.length = 0;
  wirePluginEventSources(getPluginBus(), (event, payload) => seen.push({ event, payload }));
});
afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

function seedWorkspace(id: string): void {
  getDb()
    .prepare(`INSERT INTO workspaces (id, name, directory_path, owner_id) VALUES (?, ?, ?, ?)`)
    .run(id, 'T', path.join(tmpRoot, id), '@o:home');
}

describe('storage 层信号（setter 注入）', () => {
  it('insertSession → sessionStarted（fire-and-forget 同步即刻返回）', () => {
    seedWorkspace('ws1');
    const t0 = Date.now();
    const row = insertSession({ workspaceId: 'ws1', title: 't', kind: 'chat' });
    const sid = row.id;
    expect(Date.now() - t0).toBeLessThan(50);
    expect(seen.find((s) => s.event === 'sessionStarted')?.payload).toMatchObject({ id: sid });
  });

  it('deleteSession → sessionEnded', () => {
    seedWorkspace('ws1');
    const row = insertSession({ workspaceId: 'ws1', title: 't', kind: 'chat' });
    const sid = row.id;
    deleteSession('s1');
    expect(seen.find((s) => s.event === 'sessionEnded')?.payload).toMatchObject({ id: 's1' });
  });

  it('insertTask → taskCreated；transitionTaskStatus → taskStatusChanged', () => {
    seedWorkspace('ws1');
    const tk = insertTask({ workspaceId: 'ws1', title: 't', creatorUserId: '@o:home', status: 'assigned' });
    expect(seen.find((s) => s.event === 'taskCreated')?.payload).toMatchObject({ id: tk.id });
    transitionTaskStatus(tk.id, 'in_progress');
    transitionTaskStatus(tk.id, 'completed');
    expect(seen.find((s) => s.event === 'taskStatusChanged')?.payload).toMatchObject({
      id: tk.id,
      status: 'in_progress',
    });
    expect(seen.find((s) => s.event === 'taskCompleted')?.payload).toMatchObject({
      id: tk.id,
      status: 'completed',
    });
  });
});
