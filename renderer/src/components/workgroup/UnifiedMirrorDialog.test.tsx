// renderer/src/components/workgroup/UnifiedMirrorDialog.test.tsx
//
// 统一镜像对话框渲染契约（预览批准稿形态）：快照计数行 + 版本芯片 /
// 成员行（资格原因 + 勾选 + 终态徽标）/ 发起按钮计数 / 失败行重试 / 完成态。
// 组件纯消费 store——用例直接 openDialog 驱动（GroupMonitor 入口另有 PR-4 锁）。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { UnifiedMirrorDialog } from './UnifiedMirrorDialog';
import { useUnifiedMirrorStore } from '../../stores/unified-mirror.store';
import type { HubMirrorResultEvent } from '../../ipc/types';

let mirrorResultCb: ((e: HubMirrorResultEvent) => void) | undefined;

const UPLOAD_RESULT = {
  snapshotId: 'snap-1',
  checksum: '9c4f21e0'.padEnd(64, '0'),
  version: '12',
  sizeBytes: 1400 * 1024,
  excludedPlugins: [],
  summary: { members: 6, embeddedMembers: 2, teams: 2, mcp: 3, skills: 5, skillResources: 5, skillEmbedded: 1, plugins: 2, providers: 2, modelBinding: true, resources: 8 },
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

const OPEN_INPUT = {
  groupId: 'g-peer',
  groupName: '产品三人组',
  leaderNodeId: 'leader-node',
  members: [
    { nodeId: 'leader-node', name: '组长', online: true, bound: true, boundWorkspaceName: '研发空间', acceptsMirror: false },
    { nodeId: 'ok-1', name: 'office-mac', online: true, bound: true, boundWorkspaceName: '测试空间', acceptsMirror: true },
    { nodeId: 'no-accept', name: 'lab-node', online: true, bound: true, boundWorkspaceName: '需求池', acceptsMirror: false },
  ],
  sourceWorkspaceId: 'ws-dev',
  sourceWorkspaceName: '研发空间',
};

beforeEach(() => {
  vi.clearAllMocks();
  mirrorResultCb = undefined;
  // 属性赋值而非整体覆写——组件渲染依赖 jsdom window（document 等）
  (globalThis as unknown as { window: { api: typeof api } }).window.api = api;
  api.hub.snapshotBuildUpload.mockResolvedValue(UPLOAD_RESULT);
  api.hub.mirrorWorkspace.mockResolvedValue({ accepted: true, mirrorId: 'm-1' });
  useUnifiedMirrorStore.setState({
    open: false, groupId: null, groupName: null, sourceWorkspaceId: null, sourceWorkspaceName: null,
    buildStatus: 'idle', buildError: null, snapshot: null, rows: [], launched: false, launching: false,
  });
});

describe('UnifiedMirrorDialog', () => {
  it('快照就绪：七行真实计数 + 版本/大小/checksum 芯片 + 红线注记；源空间副题在场', async () => {
    useUnifiedMirrorStore.getState().openDialog(OPEN_INPUT);
    render(<UnifiedMirrorDialog />);
    const dlg = await screen.findByRole('dialog', { name: '统一镜像' });
    expect(within(dlg).getByText('统一镜像 · 产品三人组')).toBeInTheDocument();
    expect(within(dlg).getByText(/源空间：研发空间（组长绑定空间）/)).toBeInTheDocument();
    expect(await within(dlg).findByText('6 定义 · 4 引用 + 2 内嵌')).toBeInTheDocument();
    expect(within(dlg).getByText('5 补装 + 1 内嵌')).toBeInTheDocument();
    expect(within(dlg).getByText(/sha256:9c4f21e0…/)).toBeInTheDocument();
    expect(within(dlg).getByText('已上传 hub 存档')).toBeInTheDocument();
    expect(within(dlg).getByText(/整体覆盖/)).toBeInTheDocument();
  });

  it('成员行：就绪默认勾选、不达标勾选禁用且原因可见；勾选翻转实时反映发起按钮计数', async () => {
    useUnifiedMirrorStore.getState().openDialog(OPEN_INPUT);
    render(<UnifiedMirrorDialog />);
    await waitFor(() => {
      expect(useUnifiedMirrorStore.getState().buildStatus).toBe('done');
    });
    expect(screen.getByText(/承接空间「测试空间」 · 已接受镜像/)).toBeInTheDocument();
    expect(screen.getByText(/承接空间「需求池」 · 未接受镜像/)).toBeInTheDocument();
    const ckOk = screen.getByRole('checkbox', { name: '选择 office-mac' }) as HTMLInputElement;
    const ckNo = screen.getByRole('checkbox', { name: '选择 lab-node' }) as HTMLInputElement;
    expect(ckOk.checked).toBe(true);
    expect(ckNo.disabled).toBe(true);
    expect(screen.getByRole('button', { name: '向 1 个成员发起镜像' })).toBeInTheDocument();
    fireEvent.click(ckOk);
    expect(screen.getByRole('button', { name: '向 0 个成员发起镜像' })).toBeDisabled();
    expect(within(screen.getByRole('dialog', { name: '统一镜像' })).getByText('不参与')).toBeInTheDocument();
  });

  it('发起 → 逐行在途徽标；终态成功行显示资源数；全终态后「完成」可关', async () => {
    useUnifiedMirrorStore.getState().openDialog(OPEN_INPUT);
    render(<UnifiedMirrorDialog />);
    await waitFor(() => {
      expect(useUnifiedMirrorStore.getState().buildStatus).toBe('done');
    });
    fireEvent.click(screen.getByRole('button', { name: /向 1 个成员发起镜像/ }));
    await waitFor(() => {
      expect(screen.getByText('应用中…')).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: '关闭' })).toBeDisabled();
    mirrorResultCb?.({
      mirrorId: 'm-1',
      ok: true,
      appliedResources: ['a', 'b'],
      unresolvedRefs: ['u'],
    });
    expect(await screen.findByText(/应用成功 · 2 资源 · 1 软失败/)).toBeInTheDocument();
    expect(screen.getByText('1 成功')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '完成' }));
    expect(useUnifiedMirrorStore.getState().open).toBe(false);
  });

  it('失败行：第一段拒绝人话 + 重试按钮再派（错误路径专项）', async () => {
    api.hub.mirrorWorkspace.mockRejectedValueOnce(new Error('[forbidden] 目标节点未绑定承接空间，无法接收镜像'));
    useUnifiedMirrorStore.getState().openDialog(OPEN_INPUT);
    render(<UnifiedMirrorDialog />);
    await waitFor(() => {
      expect(useUnifiedMirrorStore.getState().buildStatus).toBe('done');
    });
    fireEvent.click(screen.getByRole('button', { name: /向 1 个成员发起镜像/ }));
    expect(await screen.findByText('目标节点未绑定承接空间，无法接收镜像')).toBeInTheDocument();
    api.hub.mirrorWorkspace.mockClear();
    api.hub.mirrorWorkspace.mockResolvedValue({ accepted: true, mirrorId: 'm-2' });
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    await waitFor(() => {
      expect(api.hub.mirrorWorkspace).toHaveBeenCalledWith({
        groupId: 'g-peer', targetNodeId: 'ok-1', workspaceName: '研发空间', snapshotId: 'snap-1',
      });
    });
    expect(await screen.findByText('应用中…')).toBeInTheDocument();
  });

  it('构建失败态：错误卡 + 人话 + 重试构建按钮（错误路径专项）', async () => {
    api.hub.snapshotBuildUpload.mockRejectedValueOnce(new Error('工作目录不可写'));
    useUnifiedMirrorStore.getState().openDialog(OPEN_INPUT);
    render(<UnifiedMirrorDialog />);
    expect(await screen.findByText('快照构建失败')).toBeInTheDocument();
    expect(screen.getByText('工作目录不可写')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /重试构建/ }));
    await waitFor(() => {
      expect(useUnifiedMirrorStore.getState().buildStatus).toBe('done');
    });
  });
});
