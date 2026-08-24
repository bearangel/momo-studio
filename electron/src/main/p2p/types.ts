// electron/src/main/p2p/types.ts
//
// P2P 子系统的传输层抽象。
//
// 设计要点：
//   - TransportLayer 是统一的"节点间消息传输"接口，Router 不需要关心底层是 local/lan/hub
//   - 自身节点走 LocalTransport（直接本地派发）；远端节点走 LanTransport / HubTransport
//   - NodeInfo.transport 仅枚举外部可见传输（lan/hub）；LocalTransport 节点不在 p2p 列表
//   - MessagePayload.targetNodeId = '*' 表示广播给所有信任节点（Router 层展开）
//
// 关键类型：
//   - NodeInfo：节点元数据（id/名称/公钥/传输类型/最近活跃）
//   - MessagePayload：业务消息包装（type 区分消息/任务快照/资源目录/资源请求/资源供给）
//   - IncomingMessage：传输层收到的消息（带来源 + 时间戳）
//   - TransportLayer：传输接口（start/stop/send/discoverNodes/onMessage）

/** 节点元数据 */
export interface NodeInfo {
  /** 节点 ID（来自 NodeIdentity.nodeId） */
  nodeId: string;
  /** 用户可见的展示名 */
  displayName: string;
  /** 节点公钥（用于验签） */
  publicKey: Uint8Array;
  /**
   * 传输类型：'lan' / 'hub'
   * 注：LocalTransport 自身节点不归入此枚举（C2 用 `as never` 兜底，因为它只在路由层用）
   */
  transport: 'lan' | 'hub';
  /** 最近一次见到此节点的时间（毫秒时间戳） */
  lastSeen: number;
}

/** 业务消息 payload */
export interface MessagePayload {
  /**
   * 目标节点 ID
   * '*' = 广播给所有信任节点（Router 层负责展开）
   */
  targetNodeId: string;
  /**
   * 消息类型（P4 收敛为五个实义值）。
   * 原 'task' | 'presence' | 'ack' 预留位从未有生产发送方，已移除；
   * 2.1 联网增强（presence 在线广播 / ack 可靠回执）可在此联合再扩展。
   */
  type: 'message' | 'task-snapshot' | 'resource-catalog' | 'resource-request' | 'resource-provide';
  /** 业务 payload（由 type 决定 schema：SyncMessage / TaskSnapshot / ResourceCatalogEntry / ResourceRequest / ResourceProvide） */
  body: Record<string, unknown>;
}

/** 传输层收到的消息（已组装好来源） */
export interface IncomingMessage {
  /** 来源节点 ID */
  fromNodeId: string;
  /** 消息内容 */
  payload: MessagePayload;
  /** 接收时间戳（毫秒） */
  receivedAt: number;
}

/**
 * 传输层接口
 *
 * 三种实现：
 *   - LocalTransport：自身节点消息直接派发（不发网）
 *   - LanTransport（v2.1）：局域网 mDNS 节点
 *   - HubTransport（v2.1）：中继 hub 节点
 *
 * Router 通过 send(targetNodeId) 委托到正确的 transport。
 */
export interface TransportLayer {
  /** 传输类型标识 */
  readonly type: 'local' | 'lan' | 'hub';
  /** 启动传输（绑定端口 / 加入 mDNS / 握手中继） */
  start(): Promise<void>;
  /** 停止传输（释放资源） */
  stop(): Promise<void>;
  /** 发送消息到目标节点（targetNodeId='*' = 广播） */
  send(targetNodeId: string, payload: MessagePayload): Promise<void>;
  /** 返回当前可见的节点列表（含自身 for LocalTransport） */
  discoverNodes(): NodeInfo[];
  /** 注册收到消息的回调；返回解注册函数 */
  onMessage(handler: (msg: IncomingMessage) => void): () => void;
}