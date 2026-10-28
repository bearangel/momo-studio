// electron/tests/hub/mirror-registry.test.ts
//
// M2.1 Task 6 / RM-M21-7：镜像登记表（workspace_mirror_registry）。
// 数据源 = workspace.mirrored 组内广播（hub/index.ts 透传点累积登记，此前零消费）。
// 锁什么：
//   Part A（store 直测，真 migrations 内存库）：upsert 语义——同组×同节点×同空间
//   覆盖 snapshot_id 不增行；三键任一不同 → 独立行；UNIQUE 约束本体；查询过滤。
//   Part B（wiring，manager.test.ts 同款边界 mock + 真 DB）：hub/index.ts 事件处理器
//   「广播 + 登记」双动作；异形载荷不广播不登记；hubListMirrorRegistry 查询面。
// 失忆限制（M2 协议无重放/无查询 RPC）：登记表只累积本机在线期间收到的组内广播——
// 晚入组 / 离线期间发生的镜像不可恢复，直至同键下一次镜像事件；M3 票：hub 查询式清单 RPC。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { Database as DB } from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadMigrations } from '../../src/main/storage/migrations';
import { runMigrations, closeDb } from '../../src/main/storage/db';
import type { EventEnvelope } from '../../src/main/hub/protocol';

// ── Part B 边界 mock（electron 窗口面 / ws client / keychain 凭证 / logger）──
// storage/db 不 mock——真 tmp 库跑真 migrations（保真度：登记链路 SQL 全真实）。
interface CapturedOpts {
  url: string;
  nodeName: string;
  deviceToken: string;
  onStateChange(state: string, err?: string): void;
  onEvent(evt: EventEnvelope): void;
  onHelloSnapshot?: (nodes: Array<{ nodeId: string; nodeName: string }>) => void;
}

const m = vi.hoisted(() => ({
  sent: [] as Array<{ channel: string; payload: unknown }>,
  clients: [] as Array<{ opts: CapturedOpts; state: string }>,
  seq: 0,
}));

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => [
      {
        webContents: {
          send: (channel: string, payload: unknown): void => {
            m.sent.push({ channel, payload });
          },
        },
      },
    ],
  },
}));

vi.mock('../../src/main/hub/client', () => ({
  createHubClient: (opts: CapturedOpts) => {
    m.seq += 1;
    const rec = { opts, state: 'connecting' };
    m.clients.push(rec);
    return {
      start: (): void => { rec.state = 'connecting'; },
      stop: (): void => { rec.state = 'disconnected'; },
      state: (): string => rec.state,
      hubProtoVer: (): string | null => null,
      request: async () => ({ ok: true }),
    };
  },
  enrollOverHttp: vi.fn(async () => ({ nodeId: `node-${++m.seq}`, deviceToken: 'tok' })),
}));

vi.mock('../../src/main/hub/creds', () => ({
  getDeviceToken: vi.fn(async () => 'tok'),
  setDeviceToken: vi.fn(async () => undefined),
  clearDeviceToken: vi.fn(async () => undefined),
}));

vi.mock('../../src/main/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { createMirrorRegistry } from '../../src/main/hub/mirror-registry';
import * as manager from '../../src/main/hub/index';

/** 全量迁移内存库（Part A 用） */
function newMemDb(): DB {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  for (const mig of loadMigrations()) db.exec(mig.sql);
  return db;
}

describe('Part A：mirror-registry store（upsert / 唯一约束 / 查询过滤）', () => {
  it('首事件 → 新登记行（五字段 camelCase + id）', () => {
    const db = newMemDb();
    const reg = createMirrorRegistry(db);
    reg.record({ groupId: 'g-1', targetNodeId: 'n-2', workspaceName: 'ws-a', snapshotId: 'snap-1' });
    const rows = reg.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      groupId: 'g-1',
      targetNodeId: 'n-2',
      workspaceName: 'ws-a',
      snapshotId: 'snap-1',
    });
    expect(typeof rows[0]!.id).toBe('number');
    expect(typeof rows[0]!.mirroredAt).toBe('number');
    db.close();
  });

  it('同组×同节点×同空间再镜像 → 覆盖 snapshot_id 不增行（最新版本语义）', () => {
    const db = newMemDb();
    const reg = createMirrorRegistry(db);
    reg.record({ groupId: 'g-1', targetNodeId: 'n-2', workspaceName: 'ws-a', snapshotId: 'snap-1' });
    reg.record({ groupId: 'g-1', targetNodeId: 'n-2', workspaceName: 'ws-a', snapshotId: 'snap-2' });
    const rows = reg.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.snapshotId).toBe('snap-2');
    db.close();
  });

  it('三键任一不同（组/节点/空间）→ 独立行', () => {
    const db = newMemDb();
    const reg = createMirrorRegistry(db);
    reg.record({ groupId: 'g-1', targetNodeId: 'n-2', workspaceName: 'ws-a', snapshotId: 's' });
    reg.record({ groupId: 'g-9', targetNodeId: 'n-2', workspaceName: 'ws-a', snapshotId: 's' });
    reg.record({ groupId: 'g-1', targetNodeId: 'n-8', workspaceName: 'ws-a', snapshotId: 's' });
    reg.record({ groupId: 'g-1', targetNodeId: 'n-2', workspaceName: 'ws-b', snapshotId: 's' });
    expect(reg.list()).toHaveLength(4);
    db.close();
  });

  it('UNIQUE(group_id,target_node_id,workspace_name) 约束本体：裸 SQL 重复插入抛错', () => {
    const db = newMemDb();
    const ins = db.prepare(
      `INSERT INTO workspace_mirror_registry (group_id, target_node_id, workspace_name, snapshot_id, mirrored_at)
       VALUES (?, ?, ?, ?, ?)`,
    );
    ins.run('g-1', 'n-2', 'ws-a', 's-1', 1);
    expect(() => ins.run('g-1', 'n-2', 'ws-a', 's-2', 2)).toThrow(/UNIQUE/i);
    db.close();
  });

  it('list(workspaceName?) 过滤：只回匹配行；无事件空数组', () => {
    const db = newMemDb();
    const reg = createMirrorRegistry(db);
    expect(reg.list()).toEqual([]);
    reg.record({ groupId: 'g-1', targetNodeId: 'n-2', workspaceName: 'ws-a', snapshotId: 's1' });
    reg.record({ groupId: 'g-1', targetNodeId: 'n-3', workspaceName: 'ws-b', snapshotId: 's2' });
    expect(reg.list('ws-a')).toHaveLength(1);
    expect(reg.list('ws-a')[0]!.targetNodeId).toBe('n-2');
    expect(reg.list('ws-zzz')).toEqual([]);
    expect(reg.list()).toHaveLength(2);
    db.close();
  });
});

// ── Part B：hub/index.ts wiring（workspace.mirrored → 广播 + 登记）──

const tmpRoot = path.join(os.tmpdir(), `ap-mirror-reg-${Date.now()}-${Math.random().toString(36).slice(2)}`);

beforeEach(async () => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  await manager.hubEnroll({ hubUrl: 'https://h:8787', enrollmentToken: 't', nodeName: 'n' });
  m.sent.length = 0;
});

afterEach(async () => {
  await manager.hubForget();
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
  m.sent.length = 0;
  m.clients.length = 0;
});

/** 触发一条 workspace.mirrored 事件（经真实 onEvent 分发链） */
function fireMirrored(payload: unknown): void {
  m.clients[m.clients.length - 1]!.opts.onEvent({
    v: 1,
    kind: 'evt',
    method: 'workspace.mirrored',
    payload,
  });
}

describe('Part B：hub/index.ts 事件接线', () => {
  it('workspace.mirrored → 广播 hub:workspaceMirrored + 登记表见行（双动作同源）', () => {
    fireMirrored({
      groupId: 'g-1',
      targetNodeId: 'n-2',
      workspaceName: 'ws-a',
      snapshotId: 'snap-1',
      appliedResources: ['agent:coder'],
    });
    expect(m.sent).toContainEqual({
      channel: 'hub:workspaceMirrored',
      payload: {
        groupId: 'g-1',
        targetNodeId: 'n-2',
        workspaceName: 'ws-a',
        snapshotId: 'snap-1',
        appliedResources: ['agent:coder'],
      },
    });
    const rows = manager.hubListMirrorRegistry();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      groupId: 'g-1',
      targetNodeId: 'n-2',
      workspaceName: 'ws-a',
      snapshotId: 'snap-1',
    });
  });

  it('同键再镜像 → 登记表覆盖 snapshot_id（查询面反映最新版本）', () => {
    fireMirrored({ groupId: 'g-1', targetNodeId: 'n-2', workspaceName: 'ws-a', snapshotId: 'snap-1' });
    fireMirrored({ groupId: 'g-1', targetNodeId: 'n-2', workspaceName: 'ws-a', snapshotId: 'snap-2' });
    const rows = manager.hubListMirrorRegistry();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.snapshotId).toBe('snap-2');
  });

  it('hubListMirrorRegistry(workspaceName) 过滤（T3 徽标/T4 选择器/T8 守门消费面）', () => {
    fireMirrored({ groupId: 'g-1', targetNodeId: 'n-2', workspaceName: 'ws-a', snapshotId: 's1' });
    fireMirrored({ groupId: 'g-1', targetNodeId: 'n-3', workspaceName: 'ws-b', snapshotId: 's2' });
    expect(manager.hubListMirrorRegistry('ws-b')).toHaveLength(1);
    expect(manager.hubListMirrorRegistry('ws-b')[0]!.targetNodeId).toBe('n-3');
    expect(manager.hubListMirrorRegistry()).toHaveLength(2);
  });

  it('异形载荷（缺字段/类型错误）→ 不广播不登记（登记表写入必须先验形状）', () => {
    fireMirrored({ targetNodeId: 'n-2', workspaceName: 'ws-a', snapshotId: 's' });
    fireMirrored({ groupId: 'g-1', workspaceName: 'ws-a', snapshotId: 's' });
    fireMirrored({ groupId: 42, targetNodeId: 'n-2', workspaceName: 'ws-a', snapshotId: 's' });
    expect(m.sent).toEqual([]);
    expect(manager.hubListMirrorRegistry()).toEqual([]);
  });
});
