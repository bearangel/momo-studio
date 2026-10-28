// renderer/src/components/hub/MirrorWizard.test.tsx
//
// 镜像向导行为测试（M2c T8b——task-8-preview 批准稿交互要点逐项）：
// - 四步流推进（S1 选空间 → S2 构建上传 → S3 选节点 → S4 执行）
// - S3 禁选规则：离线禁选 / 本机 leader 禁选（dashed）；未选时开始镜像 disabled
// - S4 执行中防误关（关闭 disabled + 运行中提示）
// - conflict 两步确认：首击 danger-outline → 再击 danger 执行（confirm:true）
// - 结果面 applied / unresolved 分列
// - 失败态：node_offline 人话 + 重试（复用 hub 存档快照）
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MirrorWizard } from './MirrorWizard';
import { useHubMirrorStore } from '../../stores/hub-mirror.store';
import { useHubGroupStore } from '../../stores/hub-group.store';
import { useHubStore } from '../../stores/hub.store';
import { useWorkspaceStore } from '../../stores/workspace.store';
import type { HubMirrorResultEvent } from '../../ipc/types';

let mirrorResultCb: ((e: HubMirrorResultEvent) => void) | undefined;

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

const UPLOAD_RESULT = {
  snapshotId: 'snap-1',
  checksum: '9c4f21e0'.padEnd(64, '0'),
  version: '3',
  sizeBytes: 2_400_000,
  excludedPlugins: ['local-webhook-debug'],
  summary: { members: 6, embeddedMembers: 2, teams: 2, mcp: 3, skills: 5, skillResources: 2, skillEmbedded: 1, plugins: 4, providers: 2, modelBinding: true, resources: 13 },
};

const WORKSPACES = [
  {
    id: 'ws-1', name: 'product-dev', description: '', directoryPath: '/tmp/a', gitInitialized: true,
    createdAt: '2026-10-01', ownerId: 'owner', iconEmoji: '📁', defaultAgentInstanceId: null,
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  mirrorResultCb = undefined;
  // 组件测试环境必须保 window 本体（react-dom 依赖 window.document）——只挂 api
  (globalThis as unknown as { window: { api: typeof api } }).window.api = api;
  api.hub.snapshotBuildUpload.mockResolvedValue(UPLOAD_RESULT);
  api.hub.mirrorWorkspace.mockResolvedValue({ accepted: true, mirrorId: 'mir-1' });
  useHubStore.setState({
    status: {
      configured: true, state: 'online', hubUrl: 'https://hub.example.com',
      nodeName: '办公室 MacBook', nodeId: 'node-a', lastError: null, lastErrorCode: null, hubProtoVer: null,
    },
    nodes: [], loadError: null,
  });
  useHubGroupStore.setState({
    groups: [{
      groupId: 'g1',
      groupName: '分布式研发组',
      leaderNodeId: 'node-a',
      members: [
        { nodeId: 'node-a', name: '办公室 MacBook', online: true },
        { nodeId: 'node-b', name: 'studio-mini', online: true },
        { nodeId: 'node-c', name: 'laptop-win', online: false },
      ],
    }],
    loading: false, error: null, inviteCodes: {},
  });
  useWorkspaceStore.setState({ workspaces: WORKSPACES, activeWorkspaceId: 'ws-1', closedIds: [], loading: false });
  useHubMirrorStore.getState().openWizard('g1', '分布式研发组');
});

/** S1 → S2（构建完成）→ S3（选 node-b）→ S4 running */
async function advanceToRunning(): Promise<void> {
  // S1：选空间 → 下一步
  fireEvent.change(screen.getByLabelText('工作空间'), { target: { value: 'ws-1' } });
  fireEvent.click(screen.getByRole('button', { name: '下一步' }));
  // S2：构建完成 → 下一步 · 选节点
  await screen.findByText('已上传 hub 存档');
  fireEvent.click(screen.getByRole('button', { name: '下一步 · 选节点' }));
  // S3：选在线节点 → 开始镜像
  fireEvent.click(screen.getByRole('radio', { name: /studio-mini/ }));
  fireEvent.click(screen.getByRole('button', { name: '开始镜像' }));
  await screen.findByText('镜像进行中，请勿关闭窗口');
}

describe('MirrorWizard S1/S2/S3', () => {
  it('S1 红线文案与 excluded 提示（构建后）；未选空间下一步禁用', () => {
    render(<MirrorWizard />);
    expect(screen.getByText(/密钥与对话永远不离开本机/)).toBeInTheDocument();
    // 模型绑定行：未构建=占位文案；构建后回 S1 呈现有/无（D4）
    expect(screen.getByText('全局默认模型')).toBeInTheDocument();
    expect(screen.getByText('模型绑定')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '下一步' })).toBeDisabled();

    fireEvent.change(screen.getByLabelText('工作空间'), { target: { value: 'ws-1' } });
    expect(screen.getByRole('button', { name: '下一步' })).toBeEnabled();
    // 尚未构建：excluded 提示条不在场
    expect(screen.queryByText(/local-webhook-debug/)).not.toBeInTheDocument();
  });

  it('S1 构建后回看：摘要卡含模型绑定行（summary.modelBinding 有/无两态）', async () => {
    useHubMirrorStore.getState().selectWorkspace('ws-1', 'product-dev');
    useHubMirrorStore.setState({ step: 2 });
    render(<MirrorWizard />);
    await screen.findByText('已上传 hub 存档');
    useHubMirrorStore.setState({ step: 1 }); // 回看 S1：summary 已在 store
    expect(await screen.findByText('模型绑定')).toBeInTheDocument();
    expect(screen.getByText('有')).toBeInTheDocument(); // UPLOAD_RESULT.modelBinding=true
  });

  it('S2 自动构建 → 完成态元信息（版本/大小/checksum 短码）+ excluded 提示条', async () => {
    useHubMirrorStore.getState().selectWorkspace('ws-1', 'product-dev');
    useHubMirrorStore.setState({ step: 2 });
    render(<MirrorWizard />);
    await screen.findByText('已上传 hub 存档');
    expect(api.hub.snapshotBuildUpload).toHaveBeenCalledWith({ workspaceId: 'ws-1' });
    expect(screen.getByText(/v3/)).toBeInTheDocument();
    expect(screen.getByText(/2\.3 MB|2 MB|MB/)).toBeInTheDocument();
    expect(screen.getByText(/sha256:9c4f21e0/)).toBeInTheDocument();
    expect(screen.getByText(/local-webhook-debug/)).toBeInTheDocument();
    // S2 Skill 行双桶展示（P2-6）：装包面 = 补装 + 内嵌，不展示无差别总数
    expect(screen.getByText('Skill 清单（补装 + 内嵌）')).toBeInTheDocument();
    expect(screen.getByText('2 补装 + 1 内嵌')).toBeInTheDocument();
    expect(screen.queryByText('5 个', { exact: true })).not.toBeInTheDocument();
  });

  it('S3 禁选规则：离线与本机禁选；未选时开始镜像禁用', async () => {
    useHubMirrorStore.getState().selectWorkspace('ws-1', 'product-dev');
    useHubMirrorStore.setState({ step: 3 });
    render(<MirrorWizard />);

    const self = screen.getByRole('radio', { name: /办公室 MacBook/ });
    const offline = screen.getByRole('radio', { name: /laptop-win/ });
    expect(self).toBeDisabled();
    expect(offline).toBeDisabled();
    expect(screen.getByText('本机 · leader')).toBeInTheDocument();
    expect(screen.getByText('离线 · 禁选')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '开始镜像' })).toBeDisabled();

    fireEvent.click(screen.getByRole('radio', { name: /studio-mini/ }));
    expect(screen.getByRole('button', { name: '开始镜像' })).toBeEnabled();
  });
});

describe('MirrorWizard S4', () => {
  it('执行中防误关（关闭 disabled + 运行中提示）；mirrorWorkspace 原参发起', async () => {
    render(<MirrorWizard />);
    await advanceToRunning();
    expect(api.hub.mirrorWorkspace).toHaveBeenCalledWith({
      groupId: 'g1', targetNodeId: 'node-b', workspaceName: 'product-dev', snapshotId: 'snap-1',
    });
    expect(screen.getByRole('button', { name: '关闭向导' })).toBeDisabled();
    expect(screen.getByText(/先装后落/)).toBeInTheDocument();
  });

  it('conflict 两步确认：差异三计数 → 首击换文案 → 再击带 confirm:true 重发', async () => {
    render(<MirrorWizard />);
    await advanceToRunning();
    mirrorResultCb?.({
      mirrorId: 'mir-1', ok: false, code: 'conflict', message: '目标已存在',
      diffSummary: { added: 5, removed: 2, changed: 9 },
    });
    await screen.findByText('差异摘要 · 目标实况 vs 快照 v3');
    expect(screen.getByText('+5')).toBeInTheDocument();
    expect(screen.getByText('−2')).toBeInTheDocument();
    expect(screen.getByText('±9')).toBeInTheDocument();

    const first = screen.getByRole('button', { name: '确认覆盖' });
    fireEvent.click(first);
    const second = screen.getByRole('button', { name: /再击一次 · 确认覆盖/ });
    api.hub.mirrorWorkspace.mockClear();
    api.hub.mirrorWorkspace.mockResolvedValueOnce({ accepted: true, mirrorId: 'mir-2' });
    fireEvent.click(second);
    await waitFor(() => expect(api.hub.mirrorWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ confirm: true, snapshotId: 'snap-1', targetNodeId: 'node-b' }),
    ));
  });

  it('成功态：applied 分列清单 + unresolved 分列 + 完成', async () => {
    render(<MirrorWizard />);
    await advanceToRunning();
    mirrorResultCb?.({
      mirrorId: 'mir-1', ok: true,
      appliedResources: ['agent/coder', 'agent/pm-agent', 'skill/pdf-tools', 'plugin/gh-copilot'],
      unresolvedRefs: ['mcp:ghost-server'],
    });
    await screen.findByText('镜像完成');
    expect(screen.getByText(/product-dev · v3 已镜像到 studio-mini/)).toBeInTheDocument();
    expect(screen.getByText(/coder · pm-agent/)).toBeInTheDocument();
    expect(screen.getByText(/pdf-tools/)).toBeInTheDocument();
    expect(screen.getByText(/目标节点无法解析/)).toBeInTheDocument();
    expect(screen.getByText('mcp:ghost-server')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '完成' })).toBeEnabled();
  });

  it('失败态：node_offline 人话 + 重试（复用 hub 存档）', async () => {
    render(<MirrorWizard />);
    await advanceToRunning();
    mirrorResultCb?.({ mirrorId: 'mir-1', ok: false, code: 'node_offline', message: '目标节点在镜像应用期间离线' });
    await screen.findByText('目标节点离线，镜像中断');
    expect(screen.getByText(/快照仍存于 hub/)).toBeInTheDocument();
    expect(screen.getByText('已跳过 · 目标保持原状')).toBeInTheDocument();

    api.hub.mirrorWorkspace.mockClear();
    api.hub.mirrorWorkspace.mockResolvedValueOnce({ accepted: true, mirrorId: 'mir-9' });
    fireEvent.click(screen.getByRole('button', { name: /重试/ }));
    await waitFor(() => expect(api.hub.mirrorWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ snapshotId: 'snap-1' }),
    ));
  });
});
