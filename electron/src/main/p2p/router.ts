// electron/src/main/p2p/router.ts
//
// 路由层——按目标节点 ID 自动选 transport。
// 优先级：local > lan > hub > 不可达
//
// 路由决策：
//   target === localNodeId → localTransport
//   lanTransport.discoverNodes() 含 target → lanTransport
//   hubTransport 在线 → hubTransport
//   都不匹配 → 抛"不可达"
//
// 入站处理：
//   start() 注册 local/lan/hub 的 onMessage，统一转发到 opts.onIncoming。
//   stop() 反注册全部 handler。
//
// 与 sync.ts（C7）的关系：
//   sync.ts 通过 Router.onIncoming 接收所有 transport 收到的消息，
//   按消息类型（message/task/presence/ack）路由到对应业务层。
import type { TransportLayer, MessagePayload, IncomingMessage } from './types';

export interface RouterOpts {
  /** 自身节点 ID（用于判断"目标是自己"） */
  localNodeId: string;
  /** 自身传输层（必填，目标==自己时走它） */
  localTransport: TransportLayer;
  /** 局域网传输层（可选，未提供时跳过局域网路由） */
  lanTransport?: TransportLayer;
  /** 中继 hub 传输层（可选，未提供时局域网之外的远程节点判定为不可达） */
  hubTransport?: TransportLayer;
  /** 各 transport 收到消息的统一回调（C7 sync.ts 订阅这里） */
  onIncoming: (msg: IncomingMessage) => void;
}

/**
 * P2P 路由层。
 *
 * 生命周期：
 *   - start() 注册 onMessage 转发 + 启动所有 transport
 *   - send() 按目标节点 ID 选 transport
 *   - stop() 解注册 + 停止所有 transport
 *
 * Router 本身不持有"目标节点 → transport"的映射缓存；
 * 每次 send() 重新查 lanTransport.discoverNodes()（lan 节点集合会动态变化）。
 * hubTransport 不暴露节点列表，只判断"有没有 hub 可用"。
 */
export class Router {
  private readonly opts: RouterOpts;
  /** onMessage 解注册函数集合，stop() 时统一调用 */
  private unsubscribers: Array<() => void> = [];
  /** onIncoming 订阅 handler 集合（与 opts.onIncoming 并行触发，保留 C4 兼容） */
  private incomingHandlers = new Set<(msg: IncomingMessage) => void>();

  constructor(opts: RouterOpts) {
    this.opts = opts;
  }

  /**
   * 订阅入站消息。返回解注册函数。
   * 与 opts.onIncoming 并行触发——C4 调用方走后者，本接口供 C7 sync.ts 等模块订阅。
   */
  onIncoming(handler: (msg: IncomingMessage) => void): () => void {
    this.incomingHandlers.add(handler);
    return () => {
      this.incomingHandlers.delete(handler);
    };
  }

  /** 启动：注册入站转发 + 启动所有 transport */
  async start(): Promise<void> {
    // 派发器：同时通知 opts.onIncoming 兼容回调 + 所有 onIncoming 订阅者
    const dispatch = (m: IncomingMessage): void => {
      this.opts.onIncoming(m);
      for (const h of this.incomingHandlers) h(m);
    };
    this.unsubscribers.push(this.opts.localTransport.onMessage(dispatch));
    if (this.opts.lanTransport) {
      this.unsubscribers.push(this.opts.lanTransport.onMessage(dispatch));
    }
    if (this.opts.hubTransport) {
      this.unsubscribers.push(this.opts.hubTransport.onMessage(dispatch));
    }

    // 启动 transport——启动顺序：local（无 IO）→ lan（TCP server + mDNS）→ hub
    await this.opts.localTransport.start();
    await this.opts.lanTransport?.start();
    await this.opts.hubTransport?.start();
  }

  /** 停止：解注册入站转发 + 停止所有 transport */
  async stop(): Promise<void> {
    // 解注册入站 handler（顺序无所谓）
    for (const off of this.unsubscribers) off();
    this.unsubscribers = [];

    // 停止 transport——先停 hub/lan（外部依赖），最后停 local（自身）
    await this.opts.hubTransport?.stop();
    await this.opts.lanTransport?.stop();
    await this.opts.localTransport.stop();
  }

  /**
   * 发送消息到目标节点。
   * 路由决策：
   *   1. target == localNodeId → localTransport
   *   2. lanTransport.discoverNodes() 包含 target → lanTransport
   *   3. hubTransport 已配置 → hubTransport
   *   4. 否则抛"不可达"
   */
  async send(targetNodeId: string, payload: MessagePayload): Promise<void> {
    if (targetNodeId === this.opts.localNodeId) {
      return this.opts.localTransport.send(targetNodeId, payload);
    }
    if (this.opts.lanTransport) {
      const lanNodes = this.opts.lanTransport.discoverNodes();
      if (lanNodes.some((n) => n.nodeId === targetNodeId)) {
        return this.opts.lanTransport.send(targetNodeId, payload);
      }
    }
    if (this.opts.hubTransport) {
      return this.opts.hubTransport.send(targetNodeId, payload);
    }
    throw new Error(`节点 ${targetNodeId} 不可达（不在局域网，且未启用 hub）`);
  }
}