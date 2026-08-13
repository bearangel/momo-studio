// renderer/src/components/p2p/NodeDiscoveryPanel.tsx
//
// 节点发现面板（C 子系统 C8）：列出 mDNS 发现的节点 + 添加/移除信任。
//
// 数据流：
//   挂载 → ipc.p2p.getDiscoveredNodes → 渲染节点列表
//   5s 轮询 → 自动刷新发现节点（lan 上线/下线动态反映）
//   点击"添加信任" → ipc.p2p.addTrustedNode(nodeId) → 立即刷新
//   点击"移除信任" → ipc.p2p.removeTrustedNode(nodeId) → 立即刷新
//
// 字段约定（与 electron/src/main/p2p/index.ts 的 getDiscoveredNodes handler 对齐）：
//   - transport: 'lan' 局域网（🏠）/ 'hub' 互联网中继（🌐）
//   - trusted: true 已在信任列表（显示"移除信任"）/ false 未信任（显示"添加信任"）
import { useEffect, useState } from 'react';
import { ipc } from '../../ipc/client';

/** 发现的节点行（IPC 返回结构，与 ApiSurface.p2p.getDiscoveredNodes 对齐） */
interface DiscoveredNode {
  nodeId: string;
  displayName: string;
  transport: 'lan' | 'hub';
  trusted: boolean;
  lastSeen: number;
}

/** 刷新轮询间隔（毫秒）——LAN 节点 mDNS 广告 + 下线检测有延迟，5s 足够 */
const REFRESH_INTERVAL_MS = 5000;

export function NodeDiscoveryPanel() {
  const [nodes, setNodes] = useState<DiscoveredNode[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = async (): Promise<void> => {
    try {
      const list = await ipc.p2p.getDiscoveredNodes();
      setNodes(list);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
    const interval = setInterval(() => {
      void refresh();
    }, REFRESH_INTERVAL_MS);
    return () => clearInterval(interval);
  }, []);

  const handleTrust = async (nodeId: string): Promise<void> => {
    await ipc.p2p.addTrustedNode(nodeId);
    void refresh();
  };

  const handleRemove = async (nodeId: string): Promise<void> => {
    await ipc.p2p.removeTrustedNode(nodeId);
    void refresh();
  };

  if (loading) {
    return <div className="p-4 text-sm text-neutral-500">扫描中...</div>;
  }

  return (
    <div className="flex flex-col gap-3">
      <div>
        <h2 className="text-neutral-100 text-base">节点发现</h2>
        <p className="text-xs text-neutral-500 mt-1 leading-relaxed">
          自动发现同 WiFi 下的其他 Momo Studio 设备。首次连接需手动添加信任，
          信任后消息可端到端同步。
        </p>
      </div>

      {nodes.length === 0 && (
        <div className="text-sm text-neutral-500">
          暂未发现其他节点（确保同 WiFi 下其他设备已启动 Momo Studio）
        </div>
      )}

      {nodes.map((n) => (
        <div
          key={n.nodeId}
          className="flex items-center justify-between p-2 border border-border-subtle rounded"
        >
          <div className="flex items-center gap-3 min-w-0">
            <span aria-hidden>{n.transport === 'lan' ? '🏠' : '🌐'}</span>
            <div className="min-w-0">
              <div className="text-sm font-medium text-neutral-100 truncate">
                {n.displayName}
              </div>
              <div className="text-xs text-neutral-500 truncate">{n.nodeId}</div>
            </div>
          </div>
          <div className="shrink-0">
            {n.trusted ? (
              <button
                type="button"
                onClick={() => void handleRemove(n.nodeId)}
                className="text-xs text-red-400 hover:text-red-300"
              >
                移除信任
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void handleTrust(n.nodeId)}
                className="text-xs px-3 py-1 bg-accent-blue text-white rounded hover:bg-accent-blue/90"
              >
                添加信任
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
