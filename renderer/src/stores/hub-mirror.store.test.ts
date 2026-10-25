// renderer/src/stores/hub-mirror.store.test.ts
//
// 镜像向导 store 契约（M2c T8b）：S2 构建映射 / 两段式 mirrorId 对账 /
// conflict→confirm 重发 / 失败重试 / 防误关 / 终态超时兜底。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useHubMirrorStore } from './hub-mirror.store';
import type { HubMirrorResultEvent } from '../ipc/types';

let mirrorResultCb: ((e: HubMirrorResultEvent) => void) | undefined;

const UPLOAD_RESULT = {
  snapshotId: 'snap-1',
  checksum: '9c4f21e0'.padEnd(64, '0'),
  version: '3',
  sizeBytes: 2400 * 1024,
  excludedPlugins: ['local-webhook-debug'],
  summary: { members: 6, embeddedMembers: 2, teams: 2, mcp: 3, skills: 5, plugins: 4, providers: 2, resources: 13 },
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

beforeEach(() => {
  vi.clearAllMocks();
  mirrorResultCb = undefined;
  (globalThis as unknown as { window: { api: typeof api } }).window = { api };
  api.hub.snapshotBuildUpload.mockResolvedValue(UPLOAD_RESULT);
  api.hub.mirrorWorkspace.mockResolvedValue({ accepted: true, mirrorId: 'mir-1' });
  useHubMirrorStore.getState().openWizard('g1', '分布式研发组');
  useHubMirrorStore.getState().selectWorkspace('ws-1', 'product-dev');
});
afterEach(() => {
  vi.useRealTimers();
  useHubMirrorStore.getState().close();
});

async function buildAndAdvanceToStep4(): Promise<void> {
  await useHubMirrorStore.getState().startBuild();
  useHubMirrorStore.getState().gotoPickNode();
  useHubMirrorStore.getState().selectTarget('node-b');
  await useHubMirrorStore.getState().startMirror();
}

describe('hub-mirror store S2 构建', () => {
  it('startBuild → snapshotBuildUpload({workspaceId}) → done + 快照信息', async () => {
    await useHubMirrorStore.getState().startBuild();
    expect(api.hub.snapshotBuildUpload).toHaveBeenCalledWith({ workspaceId: 'ws-1' });
    const s = useHubMirrorStore.getState();
    expect(s.buildStatus).toBe('done');
    expect(s.snapshot?.snapshotId).toBe('snap-1');
    expect(s.snapshot?.excludedPlugins).toEqual(['local-webhook-debug']);
  });

  it('构建失败 → buildStatus error + 人话；换空间 → 快照作废重置', async () => {
    api.hub.snapshotBuildUpload.mockRejectedValueOnce(new Error('快照红线校验失败'));
    await useHubMirrorStore.getState().startBuild();
    expect(useHubMirrorStore.getState().buildStatus).toBe('error');
    expect(useHubMirrorStore.getState().buildError).toBe('快照红线校验失败');
    useHubMirrorStore.getState().selectWorkspace('ws-2', '别的空间');
    expect(useHubMirrorStore.getState().snapshot).toBeNull();
    expect(useHubMirrorStore.getState().buildStatus).toBe('idle');
  });
});

describe('hub-mirror store 两段式执行', () => {
  it('startMirror → mirrorWorkspace（无 confirm）→ running；终态推送按 mirrorId 对账', async () => {
    await buildAndAdvanceToStep4();
    expect(api.hub.mirrorWorkspace).toHaveBeenCalledWith({
      groupId: 'g1', targetNodeId: 'node-b', workspaceName: 'product-dev', snapshotId: 'snap-1',
    });
    expect(useHubMirrorStore.getState().execStatus).toBe('running');
    expect(useHubMirrorStore.getState().mirrorId).toBe('mir-1');

    // 他路镜像的结果不误收
    mirrorResultCb?.({ mirrorId: 'mir-other', ok: true, appliedResources: ['agent/x'] });
    expect(useHubMirrorStore.getState().execStatus).toBe('running');

    mirrorResultCb?.({ mirrorId: 'mir-1', ok: true, appliedResources: ['agent/coder'], unresolvedRefs: ['mcp:ghost'] });
    const s = useHubMirrorStore.getState();
    expect(s.execStatus).toBe('success');
    expect(s.result).toEqual({ ok: true, appliedResources: ['agent/coder'], unresolvedRefs: ['mcp:ghost'] });
  });

  it('conflict 终态 → execStatus conflict + diffSummary；确认覆盖 → confirm:true 重发（新 mirrorId）', async () => {
    await buildAndAdvanceToStep4();
    mirrorResultCb?.({
      mirrorId: 'mir-1', ok: false, code: 'conflict', message: '目标已存在',
      diffSummary: { added: 5, removed: 2, changed: 9 },
    });
    expect(useHubMirrorStore.getState().execStatus).toBe('conflict');

    api.hub.mirrorWorkspace.mockResolvedValueOnce({ accepted: true, mirrorId: 'mir-2' });
    await useHubMirrorStore.getState().confirmOverride();
    expect(api.hub.mirrorWorkspace).toHaveBeenLastCalledWith({
      groupId: 'g1', targetNodeId: 'node-b', workspaceName: 'product-dev', snapshotId: 'snap-1', confirm: true,
    });
    expect(useHubMirrorStore.getState().mirrorId).toBe('mir-2');
    mirrorResultCb?.({ mirrorId: 'mir-2', ok: true, appliedResources: [] });
    expect(useHubMirrorStore.getState().execStatus).toBe('success');
  });

  it('失败终态（node_offline）→ failed；重试复用已存档快照原参重发', async () => {
    await buildAndAdvanceToStep4();
    mirrorResultCb?.({ mirrorId: 'mir-1', ok: false, code: 'node_offline', message: '目标节点在镜像应用期间离线' });
    expect(useHubMirrorStore.getState().execStatus).toBe('failed');

    api.hub.mirrorWorkspace.mockResolvedValueOnce({ accepted: true, mirrorId: 'mir-3' });
    await useHubMirrorStore.getState().retry();
    expect(api.hub.mirrorWorkspace).toHaveBeenLastCalledWith({
      groupId: 'g1', targetNodeId: 'node-b', workspaceName: 'product-dev', snapshotId: 'snap-1',
    });
  });

  it('第一段拒绝（node_offline 预检）→ failed 人话直呈', async () => {
    api.hub.mirrorWorkspace.mockRejectedValueOnce(new Error('目标节点离线（node_offline）'));
    await buildAndAdvanceToStep4();
    const s = useHubMirrorStore.getState();
    expect(s.execStatus).toBe('failed');
    expect(s.result).toMatchObject({ ok: false, code: 'first_stage', message: '目标节点离线（node_offline）' });
  });

  it('防误关：running 中 close 无效；终态后可关', async () => {
    await buildAndAdvanceToStep4();
    useHubMirrorStore.getState().close();
    expect(useHubMirrorStore.getState().open).toBe(true);
    mirrorResultCb?.({ mirrorId: 'mir-1', ok: true, appliedResources: [] });
    useHubMirrorStore.getState().close();
    expect(useHubMirrorStore.getState().open).toBe(false);
  });

  it('终态超时兜底（hub 无 pending TTL）→ failed 提示可重试', async () => {
    vi.useFakeTimers();
    await buildAndAdvanceToStep4();
    expect(useHubMirrorStore.getState().execStatus).toBe('running');
    vi.advanceTimersByTime(300_000);
    const s = useHubMirrorStore.getState();
    expect(s.execStatus).toBe('failed');
    expect(s.result).toMatchObject({ ok: false, code: 'timeout' });
    expect(s.result && !s.result.ok ? s.result.message : '').toContain('快照仍存于 hub');
  });
});
