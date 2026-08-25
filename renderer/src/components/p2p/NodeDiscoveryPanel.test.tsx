// renderer/src/components/p2p/NodeDiscoveryPanel.test.tsx
//
// 节点发现面板 UI 测试（P2 安全修复）：指纹展示 + 带外核对提示。
//
// 覆盖：
//   - 本机指纹（getIdentity.fingerprint）渲染
//   - 每个节点的指纹（getDiscoveredNodes[].fingerprint）渲染
//   - 信任前的中文核对提示渲染
//   - 「添加信任」按钮仍可用（不影响原有交互）
//   - 空发现列表不展示节点行（仅空态文案 + 本机指纹 + 提示仍存在）
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { NodeDiscoveryPanel } from './NodeDiscoveryPanel';

const OWN_FINGERPRINT = 'a1b2c3d4e5f67890a1b2c3d4e5f67890';
const PEER_FINGERPRINT = '00112233aabbccdd00112233aabbccdd';

const mockApi = {
  p2p: {
    getIdentity: vi.fn().mockResolvedValue({
      nodeId: 'node_owner000000000',
      displayName: '本机节点',
      fingerprint: OWN_FINGERPRINT,
    }),
    getDiscoveredNodes: vi.fn().mockResolvedValue([
      {
        nodeId: 'node_peer0000000001',
        displayName: 'Bob 的 Mac',
        transport: 'lan',
        trusted: false,
        lastSeen: Date.now(),
        fingerprint: PEER_FINGERPRINT,
      },
      {
        nodeId: 'node_peer0000000002',
        displayName: 'Carol 的 Mac',
        transport: 'lan',
        trusted: true,
        lastSeen: Date.now(),
        fingerprint: 'ffeeddccbbaa9988ffeeddccbbaa9988',
      },
    ]),
    addTrustedNode: vi.fn().mockResolvedValue(undefined),
    removeTrustedNode: vi.fn().mockResolvedValue(undefined),
  },
};

beforeEach(() => {
  (globalThis as unknown as { window: { api: typeof mockApi } }).window.api = mockApi;
  vi.clearAllMocks();
  // 恢复默认实现（clearAllMocks 后 vi.fn 会默认 undefined）
  mockApi.p2p.getIdentity.mockResolvedValue({
    nodeId: 'node_owner000000000',
    displayName: '本机节点',
    fingerprint: OWN_FINGERPRINT,
  });
  mockApi.p2p.getDiscoveredNodes.mockResolvedValue([
    {
      nodeId: 'node_peer0000000001',
      displayName: 'Bob 的 Mac',
      transport: 'lan',
      trusted: false,
      lastSeen: Date.now(),
      fingerprint: PEER_FINGERPRINT,
    },
    {
      nodeId: 'node_peer0000000002',
      displayName: 'Carol 的 Mac',
      transport: 'lan',
      trusted: true,
      lastSeen: Date.now(),
      fingerprint: 'ffeeddccbbaa9988ffeeddccbbaa9988',
    },
  ]);
});

afterEach(() => {
  cleanup();
});

describe('NodeDiscoveryPanel P2 指纹展示', () => {
  it('渲染本机指纹（getIdentity.fingerprint）', async () => {
    render(<NodeDiscoveryPanel />);
    // 等 loading 态结束：本机指纹块在 header 区出现
    await waitFor(() => {
      // 本机指纹块在 header 中以 mono 字体渲染；至少一处含 OWN_FINGERPRINT 文本
      expect(screen.getAllByText(OWN_FINGERPRINT).length).toBeGreaterThan(0);
    });
    // 头部标签「本机指纹：」单独存在（精确文本，避免与指纹 hex 内容撞）
    expect(screen.getByText(/^本机指纹：$/)).toBeInTheDocument();
  });

  it('渲染每个发现节点的指纹', async () => {
    render(<NodeDiscoveryPanel />);
    // 节点行渲染（需要 loading 结束）
    await waitFor(() => {
      expect(screen.getByText('Bob 的 Mac')).toBeInTheDocument();
      expect(screen.getByText('Carol 的 Mac')).toBeInTheDocument();
    });
    // 每个节点 fingerprint 独立展示——用函数匹配器按 textContent 搜索（DOM 文本
    // 可能跨多个 element：可视 span + title 属性），确保两个节点的指纹都出现
    const peerMatches = screen.getAllByText((_content, node) =>
      node?.textContent?.includes(PEER_FINGERPRINT) ?? false,
    );
    expect(peerMatches.length).toBeGreaterThan(0);
    expect(
      screen.getAllByText((_content, node) =>
        node?.textContent?.includes('ffeeddccbbaa9988ffeeddccbbaa9988') ?? false,
      ).length,
    ).toBeGreaterThan(0);
  });

  it('展示带外核对提示（中文）', async () => {
    render(<NodeDiscoveryPanel />);
    // 提示文案独立于数据加载——等 loading 态结束后断言
    await waitFor(() => {
      expect(screen.getByText(/核对/i)).toBeInTheDocument();
    });
  });

  it('未信任节点显示「添加信任」，点击调用 addTrustedNode', async () => {
    render(<NodeDiscoveryPanel />);
    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: '添加信任' }).length).toBeGreaterThan(0);
    });
    const trustBtn = screen.getAllByRole('button', { name: '添加信任' })[0]!;
    fireEvent.click(trustBtn);
    await waitFor(() => {
      expect(mockApi.p2p.addTrustedNode).toHaveBeenCalledWith('node_peer0000000001');
    });
    // 信任操作后刷新列表：首次挂载 + 操作后重拉 ≥ 2 次（自 renderer/tests 迁入的断言）
    await waitFor(() => {
      expect(mockApi.p2p.getDiscoveredNodes.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
  });

  it('已信任节点显示「移除信任」', async () => {
    render(<NodeDiscoveryPanel />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '移除信任' })).toBeInTheDocument();
    });
  });

  it('空发现列表：本机指纹 + 核对提示仍渲染；无节点行', async () => {
    mockApi.p2p.getDiscoveredNodes.mockResolvedValue([]);
    render(<NodeDiscoveryPanel />);
    await waitFor(() => {
      expect(screen.getByText(/暂未发现其他节点/)).toBeInTheDocument();
    });
    expect(screen.getAllByText(OWN_FINGERPRINT).length).toBeGreaterThan(0);
    await waitFor(() => {
      expect(screen.getByText(/核对/i)).toBeInTheDocument();
    });
    expect(screen.queryByRole('button', { name: '添加信任' })).toBeNull();
  });

  // —— 以下两用例自 renderer/tests/components/p2p/NodeDiscoveryPanel.test.tsx 迁入
  // （2026-08 目录规范统一）：loading 态与移除信任回调为独有覆盖。
  it('加载阶段显示"扫描中..."', async () => {
    mockApi.p2p.getDiscoveredNodes.mockReturnValue(new Promise(() => {}));
    render(<NodeDiscoveryPanel />);
    expect(screen.getByText('扫描中...')).toBeInTheDocument();
  });

  it('点击「移除信任」调用 removeTrustedNode', async () => {
    render(<NodeDiscoveryPanel />);
    const removeBtn = await screen.findByRole('button', { name: '移除信任' });
    fireEvent.click(removeBtn);
    await waitFor(() => {
      expect(mockApi.p2p.removeTrustedNode).toHaveBeenCalledWith('node_peer0000000002');
    });
  });
});
