// electron/tests/p2p/remote-cache.test.ts
//
// 远端任务镜像缓存测试（P4 Task 3）。
//
// 覆盖：
//   ① 写读往返——writeTaskSnapshot 后 getRemoteTasks 返回完整条目；
//      缓存按 fromNodeId（传输层验签来源）键控，snap.nodeId 自报字段不采信
//   ② stale 判定——takenAt 超 3 分钟 → stale=true；3 分钟内 → false
//   ③ pruneStale——超 5 分钟条目移除；3-5 分钟区间 stale 但保留
//   ④ 多节点覆写——同 fromNodeId 二次写入整条覆写（旧任务不残留）；不同节点互不影响
//   ⑤ nodeName 更新——对端改名后新快照的 nodeName 生效
//   ⑥ initP2p 接线——入站 task-snapshot（Router onIncoming 捕获注入）→ 缓存 →
//      p2p:getRemoteTasks handler 可读
//   ⑦ p2p:getRemoteTasks handler 顺带 pruneStale（轮询点兜底清理）
//   ⑧ 45s 周期重播兜底（T2 移交）——事件触发外无本地写路径时快照 staleness 有界；
//      stopP2p 后 clearInterval 不再重播
//
// 模式：与 task-broadcast.test.ts 一致——vi.hoisted + vi.mock 捕获 ipcMain.handle
// 注册表；Router mock 捕获 onIncoming handler 模拟入站消息；依赖全 mock，
// 不依赖真实 DB / 网络 / 文件 IO。
import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  ipcHandlers,
  taskRepoMocks,
  incomingHandler,
} = vi.hoisted(() => ({
  // ipcMain.handle 注册表——capture 真实注册的 handler 后按通道调用
  ipcHandlers: new Map<string, (...args: unknown[]) => unknown>(),
  // storage/tasks/repo 桩（task-broadcast 出站路径用）
  taskRepoMocks: {
    listTasks: vi.fn(),
  },
  // Router mock 捕获的 onIncoming handler——模拟传输层入站消息
  incomingHandler: {
    current: undefined as ((msg: unknown) => void) | undefined,
  },
}));

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      ipcHandlers.set(channel, fn);
    },
  },
}));

vi.mock('../../src/main/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../src/main/storage/tasks/repo', () => taskRepoMocks);

// Router 桩——start/stop 无 IO；onIncoming 捕获 handler 供测试注入入站消息
vi.mock('../../src/main/p2p/router', () => ({
  Router: class {
    start = vi.fn(async () => {});
    stop = vi.fn(async () => {});
    onIncoming = vi.fn((h: (msg: unknown) => void) => {
      incomingHandler.current = h;
      return () => {};
    });
    send = vi.fn(async () => {});
  },
}));
vi.mock('../../src/main/p2p/local-transport', () => ({
  LocalTransport: class {},
}));
vi.mock('../../src/main/p2p/lan-transport', () => ({
  LanTransport: class {},
}));
vi.mock('../../src/main/p2p/identity', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/p2p/identity')>()),
  loadIdentity: vi.fn(() => ({
    nodeId: 'node-me',
    displayName: '本机节点',
    publicKey: new Uint8Array(32),
  })),
  generateIdentity: vi.fn(),
  saveIdentity: vi.fn(),
}));
vi.mock('../../src/main/p2p/trust-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/p2p/trust-store')>()),
  listTrustedNodes: vi.fn(() => []),
  addTrustedNode: vi.fn(),
  removeTrustedNode: vi.fn(),
  isTrusted: vi.fn(() => false),
  getTrustedPublicKey: vi.fn(() => null),
  getTrustedBoxPublicKey: vi.fn(() => null),
}));
vi.mock('../../src/main/storage/messages/repo', () => ({
  insertMessage: vi.fn(),
}));

import {
  writeTaskSnapshot,
  getRemoteTasks,
  pruneStale,
  clearRemoteTaskCache,
  type RemoteNodeTasks,
} from '../../src/main/p2p/remote-cache';
import { initP2p, stopP2p, registerP2pHandlers } from '../../src/main/p2p/index';
import { P2pSync } from '../../src/main/p2p/sync';
import { clearTaskBroadcastDeps } from '../../src/main/p2p/task-broadcast';
import type { TaskSnapshot } from '../../src/main/p2p/protocols';

/** 构造合法 TaskSnapshot fixture（默认 takenAt=now → 不 stale） */
function mkSnap(partial: Partial<TaskSnapshot> = {}): TaskSnapshot {
  return {
    // 自报 nodeId 故意与 fromNodeId 不同——验证缓存键控采信验签来源而非自报字段
    nodeId: 'node-self-claimed',
    nodeName: '对端节点',
    tasks: [
      {
        id: 'T-1',
        title: '远端任务',
        status: 'in_progress',
        assigneeAgentId: null,
        priority: 5,
        createdAt: 1000,
        updatedAt: 2000,
      },
    ],
    takenAt: Date.now(),
    ...partial,
  };
}

beforeEach(() => {
  ipcHandlers.clear();
  taskRepoMocks.listTasks.mockReset();
  taskRepoMocks.listTasks.mockReturnValue([]);
  incomingHandler.current = undefined;
  clearRemoteTaskCache();
  clearTaskBroadcastDeps();
});

describe('remote-cache 纯缓存逻辑', () => {
  it('① 写读往返：按 fromNodeId 键控（自报 nodeId 不采信）+ nodeName 取自快照', () => {
    const snap = mkSnap({ nodeName: '对端A' });
    writeTaskSnapshot(snap, 'node-peer');

    const list = getRemoteTasks();
    expect(list).toHaveLength(1);
    expect(list[0]).toEqual({
      nodeId: 'node-peer',
      nodeName: '对端A',
      tasks: snap.tasks,
      takenAt: snap.takenAt,
      stale: false,
    });
  });

  it('② stale 判定：takenAt 超 3 分钟 → stale=true；3 分钟内 → false', () => {
    writeTaskSnapshot(mkSnap({ takenAt: Date.now() - 3.5 * 60_000 }), 'node-old');
    writeTaskSnapshot(mkSnap({ takenAt: Date.now() }), 'node-fresh');

    const byId = new Map(getRemoteTasks().map((r) => [r.nodeId, r]));
    expect(byId.get('node-old')?.stale).toBe(true);
    expect(byId.get('node-fresh')?.stale).toBe(false);
  });

  it('③ pruneStale：超 5 分钟移除；3-5 分钟区间 stale 但保留', () => {
    writeTaskSnapshot(mkSnap({ takenAt: Date.now() - 6 * 60_000 }), 'node-gone');
    writeTaskSnapshot(mkSnap({ takenAt: Date.now() - 4 * 60_000 }), 'node-stale-but-kept');
    writeTaskSnapshot(mkSnap({ takenAt: Date.now() }), 'node-fresh');

    pruneStale();

    const byId = new Map(getRemoteTasks().map((r) => [r.nodeId, r]));
    expect(byId.has('node-gone')).toBe(false);
    // 4 分钟：超 stale 阈值但未到 prune 阈值——看板仍显示（带已离线? 标记）
    expect(byId.get('node-stale-but-kept')?.stale).toBe(true);
    expect(byId.has('node-fresh')).toBe(true);
  });

  it('④ 多节点覆写：同节点二次写入整条覆写（旧任务不残留），不同节点互不影响', () => {
    writeTaskSnapshot(mkSnap({ tasks: [mkSnap().tasks[0]] }), 'node-a');
    writeTaskSnapshot(
      mkSnap({
        tasks: [
          { id: 'T-9', title: '新任务', status: 'pending', assigneeAgentId: 'ag-1', priority: 1, createdAt: 1, updatedAt: 2 },
        ],
      }),
      'node-a',
    );
    writeTaskSnapshot(mkSnap(), 'node-b');

    const byId = new Map(getRemoteTasks().map((r) => [r.nodeId, r]));
    expect(byId.get('node-a')?.tasks).toHaveLength(1);
    expect(byId.get('node-a')?.tasks[0]).toMatchObject({ id: 'T-9', title: '新任务' });
    expect(byId.get('node-b')?.tasks[0]).toMatchObject({ id: 'T-1' });
  });

  it('⑤ nodeName 更新：对端改名后新快照生效', () => {
    writeTaskSnapshot(mkSnap({ nodeName: '旧名' }), 'node-a');
    writeTaskSnapshot(mkSnap({ nodeName: '新名' }), 'node-a');

    expect(getRemoteTasks()).toHaveLength(1);
    expect(getRemoteTasks()[0].nodeName).toBe('新名');
  });
});

describe('initP2p 接线（index.ts）', () => {
  it('⑥ 入站 task-snapshot → onRemoteTaskSnapshot → 缓存 → p2p:getRemoteTasks 可读', async () => {
    try {
      await initP2p();
      registerP2pHandlers();

      // Router mock 捕获的 onIncoming handler = 真实 P2pSync.handleIncoming
      expect(incomingHandler.current).toBeTruthy();
      incomingHandler.current!({
        fromNodeId: 'node-peer',
        payload: {
          targetNodeId: 'node-me',
          type: 'task-snapshot',
          body: mkSnap({ nodeName: '对端A' }),
        },
        receivedAt: Date.now(),
      });

      const list = (await ipcHandlers.get('p2p:getRemoteTasks')!()) as RemoteNodeTasks[];
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({
        nodeId: 'node-peer',
        nodeName: '对端A',
        stale: false,
      });
    } finally {
      await stopP2p();
    }
  });

  it('⑦ p2p:getRemoteTasks 顺带 pruneStale——超 5 分钟条目在轮询点直接消失', async () => {
    registerP2pHandlers();
    writeTaskSnapshot(mkSnap({ takenAt: Date.now() - 6 * 60_000 }), 'node-gone');
    writeTaskSnapshot(mkSnap({ takenAt: Date.now() }), 'node-fresh');

    const list = (await ipcHandlers.get('p2p:getRemoteTasks')!()) as RemoteNodeTasks[];

    expect(list.map((r) => r.nodeId)).toEqual(['node-fresh']);
  });

  it('⑧ 45s 周期重播兜底——事件触发外的 staleness 有界；stopP2p 后 clearInterval', async () => {
    vi.useFakeTimers();
    const spy = vi
      .spyOn(P2pSync.prototype, 'broadcastTaskSnapshot')
      .mockResolvedValue(undefined);
    try {
      await initP2p();
      taskRepoMocks.listTasks.mockReturnValue([]);

      // 45s 边界：44.999s 不触发，第 45s 触发第一次重播
      await vi.advanceTimersByTimeAsync(44_999);
      expect(spy).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(spy).toHaveBeenCalledTimes(1);
      // 下一周期继续重播
      await vi.advanceTimersByTimeAsync(45_000);
      expect(spy).toHaveBeenCalledTimes(2);

      // stopP2p 清理 interval——后续不再重播
      await stopP2p();
      await vi.advanceTimersByTimeAsync(90_000);
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
      vi.useRealTimers();
    }
  });
});
