// electron/src/main/p2p/lan-transport.ts
//
// 局域网传输层——mDNS 自动发现 + TCP 直连。
//
// 启动顺序：
//   1. mDNS 广告自身（_momo-studio._tcp + nodeId/displayName/pubkey 在 txt 记录）
//   2. 监听 mDNS 发现其他节点（onServiceUp）
//   3. 启动 TCP server 接受入站连接（handleIncoming）
//   4. 发现信任节点时主动建立出站 TCP 连接（onServiceUp 末尾）
//
// send(targetNodeId)：
//   - 查连接池（connections），已连则直接写帧；未连则抛错（应由发现+握手保证）
//
// 接收：
//   - 入站连接第一帧前 nodeId 未知——临时 buffer 按行解析，
//     识别出 fromNodeId 后切换到稳定 PeerConnection 状态
//   - 出站连接由 onServiceUp 直接组装 PeerConnection
//   - 每帧解码后调 processFrame：查信任公钥 → verify → 推 onMessage
//
// 签名约定：sign(JSON.stringify({ fromNodeId, payload })) → base64
//   - 接收方按相同 JSON 序列化再 verify（注意键序由 V8 保证稳定）
import net from 'node:net';
import { Bonjour } from 'bonjour-service';
import type { Service } from 'bonjour-service';
import type { TransportLayer, MessagePayload, IncomingMessage, NodeInfo } from './types';
import type { NodeIdentity } from './identity';
import { sign, verify } from './identity';
import { encodeFrame, decodeFrame, type LanFrame } from './lan-protocol';

const SERVICE_TYPE = 'momo-studio';

/** 传输层信任接口（C3 用最小子集；C8 完整 trust-store 实现它） */
export interface TrustStore {
  isTrusted: (nodeId: string) => boolean;
  getTrustedPublicKey: (nodeId: string) => Uint8Array | null;
}

export interface LanTransportOpts {
  identity: NodeIdentity;
  /** 监听端口，默认 0 = 随机端口（mDNS 仍会广播实际端口） */
  port?: number;
  trustStore: TrustStore;
}

interface PeerConnection {
  socket: net.Socket;
  nodeId: string;
  /** 行缓冲（按 \n 切帧） */
  buffer: string;
}

export class LanTransport implements TransportLayer {
  readonly type = 'lan' as const;
  private server?: net.Server;
  private bonjour?: Bonjour;
  /** nodeId → conn（含入站 + 出站） */
  private connections = new Map<string, PeerConnection>();
  /** mDNS 发现的节点列表（discoverNodes 返回它） */
  private discoveredNodes = new Map<string, NodeInfo>();
  private handlers = new Set<(msg: IncomingMessage) => void>();
  /** server 端所有已接受 socket——stop() 时强制销毁避免 server.close() 等待 */
  private serverSockets = new Set<net.Socket>();
  private readonly port: number;

  constructor(private readonly opts: LanTransportOpts) {
    this.port = opts.port ?? 0; // 0 = 随机端口
  }

  async start(): Promise<void> {
    // 1. TCP server
    this.server = net.createServer((socket) => {
      // 跟踪所有 server 端 socket；net.Server 没有 closeAllConnections（http.Server 才有），
      // 必须自己维护 Set 才能在 stop() 时强制销毁孤儿 socket。
      this.serverSockets.add(socket);
      socket.on('close', () => this.serverSockets.delete(socket));
      this.handleIncoming(socket);
    });
    await new Promise<void>((resolve) => {
      this.server!.listen(this.port, () => resolve());
    });
    const actualPort = (this.server.address() as net.AddressInfo).port;

    // 2. mDNS 广告 + 发现
    this.bonjour = new Bonjour();
    this.bonjour.publish({
      name: this.opts.identity.nodeId,
      type: SERVICE_TYPE,
      port: actualPort,
      txt: {
        nodeid: this.opts.identity.nodeId,
        name: this.opts.identity.displayName,
        pubkey: Buffer.from(this.opts.identity.publicKey).toString('base64'),
      },
    });
    const browser = this.bonjour.find({ type: SERVICE_TYPE });
    browser.on('up', (svc) => this.onServiceUp(svc));
  }

  async stop(): Promise<void> {
    this.bonjour?.destroy();
    this.bonjour = undefined;
    for (const conn of this.connections.values()) conn.socket.destroy();
    this.connections.clear();
    // 强制销毁所有 server 端 socket（含被覆盖而未在 connections 中的孤儿）。
    // net.Server.close() 会等待所有连接关闭才回调——必须先 destroy 完才能解阻塞。
    for (const s of this.serverSockets) s.destroy();
    this.serverSockets.clear();
    await new Promise<void>((resolve) => {
      if (this.server) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
    this.server = undefined;
    this.handlers.clear();
    this.discoveredNodes.clear();
  }

  async send(targetNodeId: string, payload: MessagePayload): Promise<void> {
    const conn = this.connections.get(targetNodeId);
    if (!conn) throw new Error(`LanTransport: 节点 ${targetNodeId} 未连接`);
    const sigMsg = new TextEncoder().encode(
      JSON.stringify({ fromNodeId: this.opts.identity.nodeId, payload }),
    );
    const signature = Buffer.from(sign(this.opts.identity, sigMsg)).toString('base64');
    const frame: LanFrame = {
      v: 1,
      fromNodeId: this.opts.identity.nodeId,
      signature,
      payload,
    };
    conn.socket.write(encodeFrame(frame));
  }

  discoverNodes(): NodeInfo[] {
    return Array.from(this.discoveredNodes.values());
  }

  onMessage(handler: (msg: IncomingMessage) => void): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  /**
   * mDNS 发现服务上线。
   * 解析 txt 记录组装 NodeInfo，记入 discoveredNodes；
   * 若该节点已信任且尚未连接则主动建立出站 TCP 连接。
   */
  private onServiceUp(svc: Service): void {
    const nodeId = svc.txt?.nodeid as string | undefined;
    const displayName = (svc.txt?.name as string | undefined) ?? 'Unknown';
    const pubKeyB64 = svc.txt?.pubkey as string | undefined;
    if (!nodeId || !pubKeyB64) return;
    if (nodeId === this.opts.identity.nodeId) return; // 自身广告
    const addr = svc.addresses?.[0];
    if (!addr) return;

    this.discoveredNodes.set(nodeId, {
      nodeId,
      displayName,
      publicKey: new Uint8Array(Buffer.from(pubKeyB64, 'base64')),
      transport: 'lan',
      lastSeen: Date.now(),
    });

    // 主动建立 TCP 连接（仅信任节点）
    if (this.opts.trustStore.isTrusted(nodeId) && !this.connections.has(nodeId)) {
      const socket = net.createConnection({ host: addr, port: svc.port }, () => {
        const conn: PeerConnection = { socket, nodeId, buffer: '' };
        this.connections.set(nodeId, conn);
      });
      socket.on('data', (data) => {
        const conn = this.connections.get(nodeId);
        if (conn) this.handleData(conn, data);
      });
      socket.on('close', () => this.connections.delete(nodeId));
      socket.on('error', () => this.connections.delete(nodeId));
    }
  }

  /**
   * 处理入站 TCP 连接。
   * 收到第一帧前 nodeId 未知——按行解析临时 buffer，识别 fromNodeId 后切换到稳定态。
   */
  private handleIncoming(socket: net.Socket): void {
    let tempBuffer = '';
    let stableConn: PeerConnection | null = null;
    socket.on('data', (data) => {
      if (stableConn) {
        this.handleData(stableConn, data);
        return;
      }
      // 临时阶段：先按行解析，识别 nodeId 后落定 PeerConnection
      tempBuffer += data.toString('utf-8');
      let nl: number;
      while ((nl = tempBuffer.indexOf('\n')) >= 0) {
        const line = tempBuffer.slice(0, nl);
        tempBuffer = tempBuffer.slice(nl + 1);
        const frame = decodeFrame(Buffer.from(line));
        if (!frame) continue;
        if (!stableConn) {
          // 双方都 initiate TCP 时会形成 2 条 TCP 连接；以入站的第一帧为准把入站 socket
          // 落定为 canonical（覆盖先前出站条目），同时销毁被覆盖的出站 socket 防泄漏。
          const existing = this.connections.get(frame.fromNodeId);
          if (existing && existing.socket !== socket) {
            existing.socket.destroy();
          }
          stableConn = { socket, nodeId: frame.fromNodeId, buffer: tempBuffer };
          this.connections.set(frame.fromNodeId, stableConn);
          tempBuffer = '';
        }
        this.processFrame(frame, frame.fromNodeId);
      }
    });
    socket.on('close', () => {
      if (stableConn) this.connections.delete(stableConn.nodeId);
    });
    socket.on('error', () => {
      if (stableConn) this.connections.delete(stableConn.nodeId);
    });
  }

  /** 稳定连接按行解析数据 chunk。 */
  private handleData(conn: PeerConnection, data: Buffer): void {
    conn.buffer += data.toString('utf-8');
    let nl: number;
    while ((nl = conn.buffer.indexOf('\n')) >= 0) {
      const line = conn.buffer.slice(0, nl);
      conn.buffer = conn.buffer.slice(nl + 1);
      const frame = decodeFrame(Buffer.from(line));
      if (frame) this.processFrame(frame, conn.nodeId);
    }
  }

  /** 处理已解码的帧：查信任公钥 → verify → 推 onMessage。 */
  private processFrame(frame: LanFrame, fromNodeId: string): void {
    const pub = this.opts.trustStore.getTrustedPublicKey(fromNodeId);
    if (!pub) return; // 不信任，丢弃
    const sigMsg = new TextEncoder().encode(
      JSON.stringify({ fromNodeId: frame.fromNodeId, payload: frame.payload }),
    );
    const sig = new Uint8Array(Buffer.from(frame.signature, 'base64'));
    if (!verify(pub, sigMsg, sig)) return; // 验签失败

    const msg: IncomingMessage = {
      fromNodeId,
      payload: frame.payload,
      receivedAt: Date.now(),
    };
    for (const h of this.handlers) h(msg);
  }
}
