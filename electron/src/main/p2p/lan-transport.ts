// electron/src/main/p2p/lan-transport.ts
//
// 局域网传输层——mDNS 自动发现 + TCP 直连。
//
// 启动顺序：
//   1. mDNS 广告自身（_momo-studio._tcp + nodeId/displayName/签名公钥/box 公钥在 txt 记录）
//   2. 监听 mDNS 发现其他节点（onServiceUp）
//   3. 启动 TCP server 接受入站连接（handleIncoming）
//   4. 发现信任节点时主动建立出站 TCP 连接（onServiceUp 末尾）
//
// send(targetNodeId)：
//   - 查连接池（connections），已连则直接写帧；未连则抛错（应由发现+握手保证）
//   - v2 帧：payload 用 DH(己方 box 私钥, 信任库对端 box 公钥) 派生共享密钥加密，
//     再对密文做 Ed25519 签名（sign-then-encrypt）
//
// 接收：
//   - 入站连接第一帧前 nodeId 未知——临时 buffer 按行解析，
//     识别出 fromNodeId 后切换到稳定 PeerConnection 状态
//   - 出站连接由 onServiceUp 直接组装 PeerConnection
//   - 每帧解码后调 processFrame：查信任公钥 → 验签 → 派生解密 → 推 onMessage
//
// 安全注记（安全修复）：
//   - 行缓冲上限 MAX_LINE_CHARS（1MB）：信任验证完成前任何来源都可能灌数据，
//     超限即销毁 socket——防"无换行巨帧"内存耗尽 DoS
//   - 加密/验签所用公钥一律取自信任库；mDNS 广告数据（可伪造）只用于发现展示
//     与信任添加时的带外指纹核对，不参与已信任链路的密钥决策
import net from 'node:net';
import { Bonjour } from 'bonjour-service';
import type { Service } from 'bonjour-service';
import type { TransportLayer, MessagePayload, IncomingMessage, NodeInfo } from './types';
import type { NodeIdentity } from './identity';
import { sign, verify } from './identity';
import { deriveSharedKey, randomNonce, encryptPayload, decryptPayload } from './crypto';
import { encodeFrame, decodeFrame, type LanFrame } from './lan-protocol';
import { logger } from '../logger';

const SERVICE_TYPE = 'momo-studio';

/** 单帧（行）长度上限——超出即销毁连接。任务快照等合法帧远小于此值 */
const MAX_LINE_CHARS = 1_048_576; // 1MB

/** 传输层信任接口（C3 用最小子集；C8 完整 trust-store 实现它） */
export interface TrustStore {
  isTrusted: (nodeId: string) => boolean;
  getTrustedPublicKey: (nodeId: string) => Uint8Array | null;
  /** box 公钥（v2 帧加密）——旧版本信任条目可能返回 null，调用方按不可加密处理 */
  getTrustedBoxPublicKey: (nodeId: string) => Uint8Array | null;
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

    // 2. mDNS 广告 + 发现。box 公钥一并广告——对端信任时捕获（带外指纹核对的是签名公钥）
    this.bonjour = new Bonjour();
    this.bonjour.publish({
      name: this.opts.identity.nodeId,
      type: SERVICE_TYPE,
      port: actualPort,
      txt: {
        nodeid: this.opts.identity.nodeId,
        name: this.opts.identity.displayName,
        pubkey: Buffer.from(this.opts.identity.publicKey).toString('base64'),
        boxpub: Buffer.from(this.opts.identity.boxPublicKey).toString('base64'),
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
    // v2：先加密后签名。对端 box 公钥只从信任库取——mDNS 广告可伪造，不能用于加密决策
    const peerBoxPub = this.opts.trustStore.getTrustedBoxPublicKey(targetNodeId);
    if (!peerBoxPub) {
      throw new Error(
        `LanTransport: 节点 ${targetNodeId} 缺少 box 公钥（旧版本信任条目，请移除信任后重新添加）`,
      );
    }
    const sharedKey = deriveSharedKey(this.opts.identity.boxPrivateKey, peerBoxPub);
    const nonce = randomNonce();
    const plaintext = new TextEncoder().encode(JSON.stringify(payload));
    const ciphertext = encryptPayload(plaintext, sharedKey, nonce);
    // 签名对象是密文原始字节——接收方解密前即可验签（快速拒绝伪造帧）
    const signature = sign(this.opts.identity, ciphertext);
    const frame: LanFrame = {
      v: 2,
      fromNodeId: this.opts.identity.nodeId,
      nonce: Buffer.from(nonce).toString('base64'),
      ciphertext: Buffer.from(ciphertext).toString('base64'),
      signature: Buffer.from(signature).toString('base64'),
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
   * 解析 txt 记录组装 NodeInfo（boxpub 缺失 = 旧版本节点，仍可发现但不具备 v2 加密能力），
   * 记入 discoveredNodes；若该节点已信任且尚未连接则主动建立出站 TCP 连接。
   */
  private onServiceUp(svc: Service): void {
    const nodeId = svc.txt?.nodeid as string | undefined;
    const displayName = (svc.txt?.name as string | undefined) ?? 'Unknown';
    const pubKeyB64 = svc.txt?.pubkey as string | undefined;
    const boxPubB64 = svc.txt?.boxpub as string | undefined;
    if (!nodeId || !pubKeyB64) return;
    if (nodeId === this.opts.identity.nodeId) return; // 自身广告
    const addr = svc.addresses?.[0];
    if (!addr) return;

    this.discoveredNodes.set(nodeId, {
      nodeId,
      displayName,
      publicKey: new Uint8Array(Buffer.from(pubKeyB64, 'base64')),
      ...(boxPubB64 !== undefined
        ? { boxPublicKey: new Uint8Array(Buffer.from(boxPubB64, 'base64')) }
        : {}),
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
   * 临时阶段同样受 MAX_LINE_CHARS 约束：任何未验证来源的超长数据直接断开
   *（防信任验证前的无换行巨帧内存耗尽 DoS）。
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
        if (line.length > MAX_LINE_CHARS) {
          this.destroyForOversizedLine(socket, '(未落定连接)', line.length);
          return;
        }
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
        this.processFrame(frame);
      }
      // 无换行的残留数据持续累积——超上限即断开（DoS 防御的核心检查点）
      if (tempBuffer.length > MAX_LINE_CHARS) {
        this.destroyForOversizedLine(socket, '(未落定连接)', tempBuffer.length);
      }
    });
    socket.on('close', () => {
      if (stableConn) this.connections.delete(stableConn.nodeId);
    });
    socket.on('error', () => {
      if (stableConn) this.connections.delete(stableConn.nodeId);
    });
  }

  /** 稳定连接按行解析数据 chunk。超长行 / 超长残留同样断开。 */
  private handleData(conn: PeerConnection, data: Buffer): void {
    conn.buffer += data.toString('utf-8');
    let nl: number;
    while ((nl = conn.buffer.indexOf('\n')) >= 0) {
      const line = conn.buffer.slice(0, nl);
      conn.buffer = conn.buffer.slice(nl + 1);
      if (line.length > MAX_LINE_CHARS) {
        this.destroyForOversizedLine(conn.socket, conn.nodeId, line.length);
        this.connections.delete(conn.nodeId);
        return;
      }
      const frame = decodeFrame(Buffer.from(line));
      if (frame) this.processFrame(frame);
    }
    if (conn.buffer.length > MAX_LINE_CHARS) {
      this.destroyForOversizedLine(conn.socket, conn.nodeId, conn.buffer.length);
      this.connections.delete(conn.nodeId);
    }
  }

  /** 超长帧处置：记告警日志 + 销毁 socket（调用方负责清理连接表条目） */
  private destroyForOversizedLine(socket: net.Socket, nodeId: string, length: number): void {
    logger.warn('P2P 入站数据超过单帧长度上限，已断开连接', {
      nodeId,
      length,
      max: MAX_LINE_CHARS,
    });
    socket.destroy();
  }

  /**
   * 处理已解码的 v2 帧：信任库查签名公钥 + box 公钥 → 验签（密文字节）→
   * DH 派生解密 → 推 onMessage。任一步失败静默丢弃（不信任 / 旧信任条目 /
   * 验签失败 / 解密失败 / 明文损坏）。
   */
  private processFrame(frame: LanFrame): void {
    const pub = this.opts.trustStore.getTrustedPublicKey(frame.fromNodeId);
    if (!pub) return; // 不信任，丢弃
    const peerBoxPub = this.opts.trustStore.getTrustedBoxPublicKey(frame.fromNodeId);
    if (!peerBoxPub) return; // 旧版本信任条目无 box 公钥——无法解密，丢弃

    const ciphertext = new Uint8Array(Buffer.from(frame.ciphertext, 'base64'));
    const sig = new Uint8Array(Buffer.from(frame.signature, 'base64'));
    if (!verify(pub, ciphertext, sig)) return; // 验签失败

    const sharedKey = deriveSharedKey(this.opts.identity.boxPrivateKey, peerBoxPub);
    const nonce = new Uint8Array(Buffer.from(frame.nonce, 'base64'));
    const plaintext = decryptPayload(ciphertext, sharedKey, nonce);
    if (!plaintext) return; // 解密失败（密文被篡改 / 密钥不匹配）
    let payload: MessagePayload;
    try {
      payload = JSON.parse(new TextDecoder().decode(plaintext)) as MessagePayload;
    } catch {
      return; // 解密后非合法 JSON
    }

    const msg: IncomingMessage = {
      fromNodeId: frame.fromNodeId,
      payload,
      receivedAt: Date.now(),
    };
    for (const h of this.handlers) h(msg);
  }
}
