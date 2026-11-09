// renderer/src/stores/unified-mirror.store.test.ts
//
// 统一镜像 store 契约：打开即构建 / 行定格（组长排除+资格原因+默认全勾）/
// 多选冻结 / launch 逐行第一段（受理与拒绝分记）/ mirrorId 终态对账 /
// 单行重试 / 防误关 / 300s 超时 sweep。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useUnifiedMirrorStore } from './unified-mirror.store';
import type { HubMirrorResultEvent } from '../ipc/types';

let mirrorResultCb: ((e: HubMirrorResultEvent) => void) | undefined;

const UPLOAD_RESULT = {
  snapshotId: 'snap-1',
  checksum: '9c4f21e0'.padEnd(64, '0'),
  version: '3',
  sizeBytes: 2400 * 1024,
  excludedPlugins: [],
  summary: { members: 2, embeddedMembers: 0, teams: 1, mcp: 1, skills: 2, skillResources: 2, skillEmbedded: 0, plugins: 1, providers: 1, modelBinding: false, resources: 4 },
};

const api = {
  hub: {
    snapshotBuildUpload: vi.fn(),
    mirrorWorkspace: vi.fn(),
    onMirrorResult: vi.fn((cb: (e: HubMirrorResultEvent) => void) => {
      mirrorResultCb = cb;
      return () => undefined;
    }),
  },
};

const LEADER = 'leader-node';
const OPEN_INPUT = {
  groupId: 'g-peer',
  groupName: '产品三人组',
  leaderNodeId: LEADER,
  members: [
    { nodeId: LEADER, name: '组长', online: true, bound: true, boundWorkspaceName: '研发空间', acceptsMirror: false },
    { nodeId: 'ok-1', name: 'office-mac', online: true, bound: true, boundWorkspaceName: '测试空间', acceptsMirror: true },
    { nodeId: 'no-accept', name: 'lab-node', online: true, bound: true, boundWorkspaceName: '需求池', acceptsMirror: false },
    { nodeId: 'offline-1', name: 'home-nas', online: false, bound: true, boundWorkspaceName: '备份区', acceptsMirror: true },
    { nodeId: 'unbound-1', name: 'guest', online: true, bound: false, acceptsMirror: false },
  ],
  sourceWorkspaceId: 'ws-dev',
  sourceWorkspaceName: '研发空间',
};

function resetStore(): void {
  useUnifiedMirrorStore.setState({
    open: false, groupId: null, groupName: null, sourceWorkspaceId: null, sourceWorkspaceName: null,
    buildStatus: 'idle', buildError: null, snapshot: null, rows: [], launched: false, launching: false,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mirrorResultCb = undefined;
  (globalThis as unknown as { window: { api: typeof api } }).window = { api };
  api.hub.snapshotBuildUpload.mockResolvedValue(UPLOAD_RESULT);
  api.hub.mirrorWorkspace.mockResolvedValue({ accepted: true, mirrorId: 'm-1' });
  resetStore();
});
afterEach(() => {
  vi.useRealTimers();
  resetStore();
});

async function openBuilt(): Promise<void> {
  useUnifiedMirrorStore.getState().openDialog(OPEN_INPUT);
  await vi.waitFor(() => {
    expect(useUnifiedMirrorStore.getState().buildStatus).toBe('done');
  });
}

describe('unified-mirror store 打开与构建', () => {
  it('openDialog → 订阅 mirrorResult + 自动构建（源空间 id）；组长行排除，资格与默认勾选定格', async () => {
    await openBuilt();
    expect(api.hub.snapshotBuildUpload).toHaveBeenCalledWith({ workspaceId: 'ws-dev' });
    const s = useUnifiedMirrorStore.getState();
    expect(s.snapshot?.snapshotId).toBe('snap-1');
    expect(s.rows.map((r) => r.nodeId)).toEqual(['ok-1', 'no-accept', 'offline-1', 'unbound-1']);
    const ok = s.rows[0]!;
    expect(ok.eligible).toBe(true);
    expect(ok.selected).toBe(true);
    expect(ok.ineligibleReasons).toEqual([]);
    expect(s.rows[1]!.ineligibleReasons).toEqual(['未接受镜像']);
    expect(s.rows[2]!.ineligibleReasons).toEqual(['离线']);
    expect(s.rows[3]!.ineligibleReasons).toEqual(['未绑定承接空间']);
  });

  it('构建失败 → buildStatus error + 人话；rebuild 恢复', async () => {
    api.hub.snapshotBuildUpload.mockRejectedValueOnce(new Error('快照红线校验失败'));
    useUnifiedMirrorStore.getState().openDialog(OPEN_INPUT);
    await vi.waitFor(() => {
      expect(useUnifiedMirrorStore.getState().buildStatus).toBe('error');
    });
    expect(useUnifiedMirrorStore.getState().buildError).toBe('快照红线校验失败');
    await useUnifiedMirrorStore.getState().rebuild();
    expect(useUnifiedMirrorStore.getState().buildStatus).toBe('done');
  });
});

describe('unified-mirror store 多选与发起', () => {
  it('toggleTarget 只翻转就绪行；launch 后冻结', async () => {
    await openBuilt();
    const st = useUnifiedMirrorStore.getState();
    st.toggleTarget('no-accept');
    st.toggleTarget('ok-1');
    let rows = useUnifiedMirrorStore.getState().rows;
    expect(rows[0]!.selected).toBe(false);
    expect(rows[1]!.selected).toBe(false); // 不达标行翻转无效
    useUnifiedMirrorStore.getState().toggleTarget('ok-1'); // 重新勾上
    await useUnifiedMirrorStore.getState().launch();
    useUnifiedMirrorStore.getState().toggleTarget('ok-1'); // 发起后冻结
    rows = useUnifiedMirrorStore.getState().rows;
    expect(rows[0]!.selected).toBe(true);
    expect(api.hub.mirrorWorkspace).toHaveBeenCalledTimes(1);
  });

  it('launch 逐行第一段：受理 → sent + mirrorId；拒绝 → failed 人话（错误路径专项）', async () => {
    api.hub.mirrorWorkspace
      .mockResolvedValueOnce({ accepted: true, mirrorId: 'm-ok' })
      .mockRejectedValueOnce(new Error('[forbidden] 目标节点未绑定承接空间，无法接收镜像'));
    // 双就绪行：第二行由 hub 拒
    const input = {
      ...OPEN_INPUT,
      members: OPEN_INPUT.members.map((m) =>
        m.nodeId === 'no-accept' ? { ...m, acceptsMirror: true } : m,
      ),
    };
    useUnifiedMirrorStore.getState().openDialog(input);
    await vi.waitFor(() => {
      expect(useUnifiedMirrorStore.getState().buildStatus).toBe('done');
    });
    await useUnifiedMirrorStore.getState().launch();
    const rows = useUnifiedMirrorStore.getState().rows;
    expect(rows[0]).toMatchObject({ nodeId: 'ok-1', status: 'sent', mirrorId: 'm-ok' });
    expect(rows[1]).toMatchObject({ nodeId: 'no-accept', status: 'failed' });
    expect(rows[1]!.error).toBe('目标节点未绑定承接空间，无法接收镜像');
  });

  it('终态对账：mirrorId 命中行回填（成功计数/失败人话）；未知 mirrorId 忽略（他路镜像不误收）', async () => {
    await openBuilt();
    await useUnifiedMirrorStore.getState().launch();
    mirrorResultCb?.({ mirrorId: 'other-mirror', ok: true, appliedResources: ['x'] });
    expect(useUnifiedMirrorStore.getState().rows[0]!.status).toBe('sent');
    mirrorResultCb?.({
      mirrorId: 'm-1',
      ok: true,
      appliedResources: ['a', 'b', 'c'],
      unresolvedRefs: ['u1'],
    });
    expect(useUnifiedMirrorStore.getState().rows[0]).toMatchObject({
      status: 'success',
      appliedCount: 3,
      unresolvedCount: 1,
    });
  });

  it('终态失败载荷 → failed + 服务端人话（错误路径专项）', async () => {
    await openBuilt();
    await useUnifiedMirrorStore.getState().launch();
    mirrorResultCb?.({ mirrorId: 'm-1', ok: false, code: 'internal', message: '资源补装失败' });
    expect(useUnifiedMirrorStore.getState().rows[0]).toMatchObject({ status: 'failed', error: '资源补装失败' });
  });

  it('retryRow：仅 failed 行重发（复用快照）；成功/在途行无效', async () => {
    await openBuilt();
    await useUnifiedMirrorStore.getState().launch();
    mirrorResultCb?.({ mirrorId: 'm-1', ok: false, code: 'internal', message: '资源补装失败' });
    api.hub.mirrorWorkspace.mockClear();
    api.hub.mirrorWorkspace.mockResolvedValue({ accepted: true, mirrorId: 'm-2' });
    await useUnifiedMirrorStore.getState().retryRow('ok-1');
    expect(api.hub.mirrorWorkspace).toHaveBeenCalledWith({
      groupId: 'g-peer', targetNodeId: 'ok-1', workspaceName: '研发空间', snapshotId: 'snap-1',
    });
    expect(useUnifiedMirrorStore.getState().rows[0]).toMatchObject({ status: 'sent', mirrorId: 'm-2' });
  });

  it('防误关：sending/sent 行在途时 close 无效；全终态后可关并注销订阅', async () => {
    await openBuilt();
    useUnifiedMirrorStore.getState().close();
    expect(useUnifiedMirrorStore.getState().open).toBe(false);
    useUnifiedMirrorStore.getState().openDialog(OPEN_INPUT);
    await vi.waitFor(() => {
      expect(useUnifiedMirrorStore.getState().buildStatus).toBe('done');
    });
    await useUnifiedMirrorStore.getState().launch();
    useUnifiedMirrorStore.getState().close();
    expect(useUnifiedMirrorStore.getState().open).toBe(true);
    mirrorResultCb?.({ mirrorId: 'm-1', ok: true, appliedResources: [] });
    useUnifiedMirrorStore.getState().close();
    expect(useUnifiedMirrorStore.getState().open).toBe(false);
  });

  it('300s 超时 sweep：sent 行转 failed（可重试话术）；open=false 后不再扫', async () => {
    vi.useFakeTimers();
    api.hub.snapshotBuildUpload.mockResolvedValue(UPLOAD_RESULT);
    useUnifiedMirrorStore.getState().openDialog(OPEN_INPUT);
    await vi.waitFor(() => {
      expect(useUnifiedMirrorStore.getState().buildStatus).toBe('done');
    });
    await useUnifiedMirrorStore.getState().launch();
    expect(useUnifiedMirrorStore.getState().rows[0]!.status).toBe('sent');
    vi.advanceTimersByTime(300_000);
    const row = useUnifiedMirrorStore.getState().rows[0]!;
    expect(row.status).toBe('failed');
    expect(row.error).toContain('结果等待超时');
  });
});
