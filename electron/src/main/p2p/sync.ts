// electron/src/main/p2p/sync.ts
//
// 跨节点同步应用层——出站把本地数据推给对端，入站按 payload.type 多路分发。
//
// P4 泛化：从单一 message 扩展为五类 payload（message / task-snapshot /
// resource-catalog / resource-request / resource-provide）。载荷结构定义在 protocols.ts。
//
// 数据流：
//   出站：broadcastNewMessage / broadcastTaskSnapshot / broadcastResourceCatalog
//         → 遍历信任节点 → router.send
//         sendResourceRequest / sendResourceProvide → 单发指定节点
//   入站：router.onIncoming → handleIncoming → switch(payload.type)
//         → 形状 guard → onRemote* 回调（畸形 body 静默丢弃）
import type { Router } from './router';
import {
  isResourceCatalogEntry,
  isResourceProvide,
  isResourceRequest,
  isTaskSnapshot,
  type ResourceCatalogEntry,
  type ResourceProvide,
  type ResourceRequest,
  type TaskSnapshot,
} from './protocols';
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
  /** 收到远端任务快照（只读镜像：入站数据不落 tasks 表，防本节点调度器误捡） */
  onRemoteTaskSnapshot?: (snap: TaskSnapshot, fromNodeId: string) => void;
  /** 收到远端资源目录（清单元数据缓存；完整定义走 request/provide 按需拉取） */
  onRemoteResourceCatalog?: (cat: ResourceCatalogEntry, fromNodeId: string) => void;
  /** 收到资源请求——对端想拉取我方某资源的完整定义 */
  onResourceRequest?: (req: ResourceRequest, fromNodeId: string) => void;
  /** 收到资源供给——此前发出的 request 的回执 */
  onResourceProvide?: (prov: ResourceProvide, fromNodeId: string) => void;
}

export class P2pSync {
  private readonly opts: P2pSyncOpts;
  private unsubscribe?: () => void;

  constructor(opts: P2pSyncOpts) {
    this.opts = opts;
  }

  /** 订阅 router.onIncoming。start 后路由层收到的消息会触发各 onRemote / onResource 回调 */
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
    await this.broadcast('message', msg);
  }

  /** 广播任务快照给所有信任节点（跳过自己）。容错策略同 broadcastNewMessage。 */
  async broadcastTaskSnapshot(snap: TaskSnapshot): Promise<void> {
    await this.broadcast('task-snapshot', snap);
  }

  /** 广播资源目录给所有信任节点（跳过自己）。容错策略同 broadcastNewMessage。 */
  async broadcastResourceCatalog(cat: ResourceCatalogEntry): Promise<void> {
    await this.broadcast('resource-catalog', cat);
  }

  /** 单发资源请求到指定节点。失败上抛（调用方需感知，与广播的尽力而为策略不同）。 */
  async sendResourceRequest(targetNodeId: string, req: ResourceRequest): Promise<void> {
    await this.send(targetNodeId, 'resource-request', req);
  }

  /** 单发资源供给（请求回执）到指定节点。失败上抛。 */
  async sendResourceProvide(targetNodeId: string, prov: ResourceProvide): Promise<void> {
    await this.send(targetNodeId, 'resource-provide', prov);
  }

  /**
   * 广播型发送的共享实现：遍历信任节点（跳过自己）。
   * 单节点失败不影响其他节点。
   */
  private async broadcast(
    type: MessagePayload['type'],
    body: SyncMessage | TaskSnapshot | ResourceCatalogEntry,
  ): Promise<void> {
    const trusted = listTrustedNodes();
    const tasks: Array<Promise<void>> = [];
    for (const node of trusted) {
      if (node.nodeId === this.opts.localNodeId) continue;
      const payload: MessagePayload = {
        targetNodeId: node.nodeId,
        type,
        body: { ...body },
      };
      tasks.push(
        this.opts.router.send(node.nodeId, payload).catch(() => {
          // 单节点失败不影响其他节点
        }),
      );
    }
    await Promise.all(tasks);
  }

  /** 单发型发送的共享实现：不吞错，失败上抛给调用方 */
  private async send(
    targetNodeId: string,
    type: MessagePayload['type'],
    body: ResourceRequest | ResourceProvide,
  ): Promise<void> {
    const payload: MessagePayload = { targetNodeId, type, body: { ...body } };
    await this.opts.router.send(targetNodeId, payload);
  }

  /**
   * 入站分发：按 payload.type 多路分发；未注册回调的类型直接忽略。
   * 各类型 body 先过形状 guard（protocols.ts 手写 guard），畸形数据静默丢弃不抛。
   */
  private handleIncoming(msg: IncomingMessage): void {
    const { body } = msg.payload;
    switch (msg.payload.type) {
      case 'message': {
        const m = body as Partial<SyncMessage>;
        if (
          typeof m.roomId !== 'string' ||
          typeof m.sender !== 'string' ||
          typeof m.body !== 'string' ||
          typeof m.eventType !== 'string'
        ) {
          return;
        }
        this.opts.onRemoteMessage({
          roomId: m.roomId,
          sender: m.sender,
          body: m.body,
          eventType: m.eventType,
        });
        return;
      }
      case 'task-snapshot': {
        if (!isTaskSnapshot(body)) return;
        this.opts.onRemoteTaskSnapshot?.(body, msg.fromNodeId);
        return;
      }
      case 'resource-catalog': {
        if (!isResourceCatalogEntry(body)) return;
        this.opts.onRemoteResourceCatalog?.(body, msg.fromNodeId);
        return;
      }
      case 'resource-request': {
        if (!isResourceRequest(body)) return;
        this.opts.onResourceRequest?.(body, msg.fromNodeId);
        return;
      }
      case 'resource-provide': {
        if (!isResourceProvide(body)) return;
        this.opts.onResourceProvide?.(body, msg.fromNodeId);
        return;
      }
      default:
        return;
    }
  }
}
