// electron/src/main/p2p/local-transport.ts
//
// 本地传输层——把"发给自己"包装成 TransportLayer 接口。
//
// 设计动机：
//   - Router 调用 send(targetNodeId, payload) 时不区分自身 / 远端
//   - 目标节点 == 自己时直接本地派发，不再走网络层
//   - start/stop 是 no-op（无网络 IO），仅维护 handler 集合
//   - 自身节点不出现在 p2p 节点列表（Router 通过 transport 字段识别 LocalTransport）
//
// 不支持的能力：
//   - send 其他节点 = 抛错（callers 必须先按 transport 路由到正确实现）
import type {
  TransportLayer, MessagePayload, IncomingMessage, NodeInfo,
} from './types';
import type { NodeIdentity } from './identity';

export class LocalTransport implements TransportLayer {
  readonly type = 'local' as const;
  private handlers = new Set<(msg: IncomingMessage) => void>();

  constructor(private readonly identity: NodeIdentity) {}

  /** 启动：无操作（本地传输不持有网络资源） */
  async start(): Promise<void> {}

  /** 停止：清空所有监听器（避免 stop 后 send 残留回调） */
  async stop(): Promise<void> {
    this.handlers.clear();
  }

  /**
   * 发送消息到目标节点。
   * 目标 == 自己 = 同步派发到所有 handler。
   * 目标 != 自己 = 抛错（callers 应该按 transport 类型路由，不要直接发非自身）。
   */
  async send(targetNodeId: string, payload: MessagePayload): Promise<void> {
    if (targetNodeId !== this.identity.nodeId) {
      throw new Error(`LocalTransport 不支持发送给其他节点: ${targetNodeId}`);
    }
    const msg: IncomingMessage = {
      fromNodeId: this.identity.nodeId,
      payload,
      receivedAt: Date.now(),
    };
    for (const h of this.handlers) h(msg);
  }

  /**
   * 返回当前可见的节点列表——仅自身一个节点。
   * transport 字段标 'local'（不在对外枚举 'lan'/'hub' 内，Router 用此区分本地派发）。
   */
  discoverNodes(): NodeInfo[] {
    return [{
      nodeId: this.identity.nodeId,
      displayName: this.identity.displayName,
      publicKey: this.identity.publicKey,
      // LocalTransport 不出现在 p2p 节点列表；用 'local' 标记仅用于 Router 路由决策。
      // 类型 'lan' | 'hub' 不包含 'local'，此处用 as never 兜底（C2 brief 说明）。
      transport: 'local' as never,
      lastSeen: Date.now(),
    }];
  }

  /**
   * 注册消息监听器。返回解注册函数。
   * 同一 handler 多次注册只保留一份（Set 语义）。
   */
  onMessage(handler: (msg: IncomingMessage) => void): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }
}