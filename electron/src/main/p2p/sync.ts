// electron/src/main/p2p/sync.ts
//
// 跨节点同步应用层——把本地新消息推给对端，接收对端的 message 写入本地 SQLite。
//
// 简化 v1：只同步 message（不同步 task 全表）；信任节点列表由 trust-store 提供。
//
// 数据流：
//   出站：广播新消息 → broadcastNewMessage → 遍历信任节点 → router.send
//   入站：router.onIncoming → handleIncoming → 按 payload.type 分发 → onRemoteMessage
import type { Router } from './router';
import type { IncomingMessage, MessagePayload } from './types';
import { listTrustedNodes } from './trust-store';

/** 应用层要同步的 message 结构（IM 消息的最小子集） */
export interface SyncMessage {
  roomId: string;
  sender: string;
  body: string;
  eventType: string;
}

export interface P2pSyncOpts {
  router: Router;
  localNodeId: string;
  /** 收到远端 message 时触发——由调用方写入本地 SQLite */
  onRemoteMessage: (msg: SyncMessage) => void;
}

export class P2pSync {
  private readonly opts: P2pSyncOpts;
  private unsubscribe?: () => void;

  constructor(opts: P2pSyncOpts) {
    this.opts = opts;
  }

  /** 订阅 router.onIncoming。start 后路由层收到的 message 会触发 onRemoteMessage */
  start(): void {
    this.unsubscribe = this.opts.router.onIncoming((msg) => this.handleIncoming(msg));
  }

  /** 取消订阅。多次调用安全。 */
  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  /**
   * 广播新消息给所有信任节点（跳过自己）。
   * 单节点失败不影响其他节点（v1 容错策略：尽力而为，不阻塞消息分发）。
   */
  async broadcastNewMessage(msg: SyncMessage): Promise<void> {
    const trusted = listTrustedNodes();
    const tasks: Array<Promise<void>> = [];
    for (const node of trusted) {
      if (node.nodeId === this.opts.localNodeId) continue;
      const payload: MessagePayload = {
        targetNodeId: node.nodeId,
        type: 'message',
        body: { ...msg },
      };
      tasks.push(
        this.opts.router.send(node.nodeId, payload).catch(() => {
          // 单节点失败不影响其他节点
        }),
      );
    }
    await Promise.all(tasks);
  }

  /**
   * 入站分发：只处理 type='message'，其余类型留给后续 presence/store 等模块订阅。
   */
  private handleIncoming(msg: IncomingMessage): void {
    if (msg.payload.type !== 'message') return;
    const body = msg.payload.body as Partial<SyncMessage>;
    if (
      typeof body.roomId !== 'string' ||
      typeof body.sender !== 'string' ||
      typeof body.body !== 'string' ||
      typeof body.eventType !== 'string'
    ) {
      return;
    }
    this.opts.onRemoteMessage({
      roomId: body.roomId,
      sender: body.sender,
      body: body.body,
      eventType: body.eventType,
    });
  }
}
