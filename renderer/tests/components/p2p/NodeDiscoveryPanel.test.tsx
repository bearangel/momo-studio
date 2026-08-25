// renderer/tests/components/p2p/NodeDiscoveryPanel.test.tsx
//
// NodeDiscoveryPanel 行为测试（C 子系统 C8）：
//   1. 加载阶段显示"扫描中..."
//   2. 加载完成后渲染已发现节点列表
//   3. 未信任节点显示"添加信任"按钮
//   4. 已信任节点显示"移除信任"按钮
//   5. 点击"添加信任"→ 调 ipc.p2p.addTrustedNode + 刷新列表
//   6. 点击"移除信任"→ 调 ipc.p2p.removeTrustedNode + 刷新列表
//   7. 空列表显示"暂未发现其他节点"提示
//
// Mock 策略：mock ../../src/ipc/client，把 ipc.p2p 三个方法都替换成 vi.fn()，
// 测试用例内 mockResolvedValue 控制返回值。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { NodeDiscoveryPanel } from '../../../src/components/p2p/NodeDiscoveryPanel';

const { mockGetDiscoveredNodes, mockGetIdentity, mockAddTrustedNode, mockRemoveTrustedNode } =
  vi.hoisted(() => ({
    mockGetDiscoveredNodes: vi.fn(),
    // v2.0.1 组件新增 getIdentity 调用（本机指纹展示）——旧用例不关心指纹，
    // 默认 resolve null（组件隐藏指纹块，维持原有断言不变）
    mockGetIdentity: vi.fn().mockResolvedValue(null),
    mockAddTrustedNode: vi.fn(),
    mockRemoveTrustedNode: vi.fn(),
  }));

vi.mock('../../../src/ipc/client', () => ({
  ipc: {
    p2p: {
      getDiscoveredNodes: mockGetDiscoveredNodes,
      getIdentity: mockGetIdentity,
      addTrustedNode: mockAddTrustedNode,
      removeTrustedNode: mockRemoveTrustedNode,
    },
  },
}));

// 模拟节点数据：Alice 已信任，Bob 未信任
const TWO_NODES = [
  {
    nodeId: 'node_a',
    displayName: 'Alice',
    transport: 'lan' as const,
    trusted: true,
    lastSeen: Date.now(),
    fingerprint: 'aaaa1111aaaa1111aaaa1111aaaa1111',
  },
  {
    nodeId: 'node_b',
    displayName: 'Bob',
    transport: 'lan' as const,
    trusted: false,
    lastSeen: Date.now(),
    fingerprint: 'bbbb2222bbbb2222bbbb2222bbbb2222',
  },
];

describe('NodeDiscoveryPanel', () => {
  beforeEach(() => {
    mockGetDiscoveredNodes.mockReset();
    mockAddTrustedNode.mockReset();
    mockRemoveTrustedNode.mockReset();
    mockAddTrustedNode.mockResolvedValue(undefined);
    mockRemoveTrustedNode.mockResolvedValue(undefined);
  });

  it('加载阶段显示"扫描中..."', () => {
    // 不 resolve，组件停在 loading
    mockGetDiscoveredNodes.mockReturnValue(new Promise(() => {}));
    render(<NodeDiscoveryPanel />);
    expect(screen.getByText('扫描中...')).toBeInTheDocument();
  });

  it('加载完成后渲染已发现节点列表', async () => {
    mockGetDiscoveredNodes.mockResolvedValue(TWO_NODES);
    render(<NodeDiscoveryPanel />);
    await waitFor(() => {
      expect(screen.getByText('Alice')).toBeInTheDocument();
      expect(screen.getByText('Bob')).toBeInTheDocument();
    });
  });

  it('未信任节点显示"添加信任"按钮', async () => {
    mockGetDiscoveredNodes.mockResolvedValue(TWO_NODES);
    render(<NodeDiscoveryPanel />);
    await waitFor(() => {
      expect(screen.getByText('添加信任')).toBeInTheDocument();
    });
  });

  it('已信任节点显示"移除信任"按钮', async () => {
    mockGetDiscoveredNodes.mockResolvedValue(TWO_NODES);
    render(<NodeDiscoveryPanel />);
    await waitFor(() => {
      expect(screen.getByText('移除信任')).toBeInTheDocument();
    });
  });

  it('点击"添加信任"调用 ipc.p2p.addTrustedNode 并刷新列表', async () => {
    mockGetDiscoveredNodes.mockResolvedValue(TWO_NODES);
    render(<NodeDiscoveryPanel />);
    const trustBtn = await screen.findByText('添加信任');
    fireEvent.click(trustBtn);
    await waitFor(() => {
      expect(mockAddTrustedNode).toHaveBeenCalledWith('node_b');
    });
    // refresh 触发额外一次 getDiscoveredNodes 调用（首次是挂载时的初始加载）
    await waitFor(() => {
      expect(mockGetDiscoveredNodes.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
  });

  it('点击"移除信任"调用 ipc.p2p.removeTrustedNode', async () => {
    mockGetDiscoveredNodes.mockResolvedValue(TWO_NODES);
    render(<NodeDiscoveryPanel />);
    const removeBtn = await screen.findByText('移除信任');
    fireEvent.click(removeBtn);
    await waitFor(() => {
      expect(mockRemoveTrustedNode).toHaveBeenCalledWith('node_a');
    });
  });

  it('空列表显示"暂未发现其他节点"提示', async () => {
    mockGetDiscoveredNodes.mockResolvedValue([]);
    render(<NodeDiscoveryPanel />);
    await waitFor(() => {
      expect(screen.getByText(/暂未发现其他节点/)).toBeInTheDocument();
    });
  });
});
