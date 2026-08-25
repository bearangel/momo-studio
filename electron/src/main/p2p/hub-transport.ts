// electron/src/main/p2p/hub-transport.ts
//
// 互联网传输层——通过 hub 中转，E2E 加密使 hub 看不到消息内容。
//
// 协议（JSON over WebSocket）：
//   客户端 → hub：
//     hello: { type: 'hello', nodeId, authToken, boxPublicKey, displayName }
//     send:  { type: 'send', to, ciphertext, nonce }
//   hub → 客户端：
//     presence: { type: 'presence', nodes: [{ nodeId, displayName, boxPublicKey }] }
//     deliver:  { type: 'deliver', from, ciphertext, nonce }
//     error:    { type: 'error', message }
//
// E2E 加密：发送方用接收方 box 公钥 + 自己 box 私钥派生共享密钥（X25519 ECDH），
// 再 secretbox（XSalsa20-Poly1305）加密。hub 只看到密文 + 收发 nodeId。
//
// 信任模型（安全修复后的准确表述）：
//   Poly1305 MAC 只证明"密文出自持有某个 box 私钥的人"，并不绑定 nodeId 身份——
//   hub 推送的 presence（含 boxPublicKey 映射）完全受 hub 控制，恶意 hub 可以
//   把受害者的 nodeId 映射到攻击者的 box 公钥。因此收发两个方向的密钥决策
//   一律以本地 trustStore 为准：出站 send 用 trustStore 的对端 box 公钥加密；
//   入站 deliver 用 trustStore 的对端 box 公钥解密，未信任节点直接丢弃。
//   presence 学到的数据只用于在线列表展示，不参与任何信任判断。
import WebSocket from 'ws';
import type { TransportLayer, MessagePayload, IncomingMessage, NodeInfo } from './types';
import type { NodeIdentity } from './identity';
import { deriveSharedKey, randomNonce, encryptPayload, decryptPayload } from './crypto';

/** HubTransport 构造选项 */
export interface HubTransportOpts {
  identity: NodeIdentity;
  /** box key pair 用于 E2E（X25519，独立于 Ed25519 签名密钥） */
  boxKeyPair: { publicKey: Uint8Array; secretKey: Uint8Array };
  /** hub WebSocket URL，如 wss://hub.momostudio.io */
  hubUrl: string;
  /** hub 账号 token（注册时分配） */
  authToken: string;
  /** 信任节点查询——返回其 box 公钥（null = 未信任） */
  trustStore: {
    getBoxPublicKey: (nodeId: string) => Uint8Array | null;
  };
}

/** hub → 客户端的协议消息（discriminated union，按 type 窄化字段） */
type HubToClient =
  | { type: 'presence'; nodes: Array<{ nodeId: string; displayName: string; boxPublicKey: string }> }
  | { type: 'deliver'; from: string; ciphertext: string; nonce: string }
  | { type: 'error'; message: string };

/**
 * HubTransport——互联网中继传输层实现。
 *
 * 生命周期：
 *   - start() 建 WSS + 发 hello；hello 发出后才 resolve（Router 依赖 send 已就绪）
 *   - send() 用对端 box 公钥加密 → 发 send 包
 *   - stop() 关闭 WSS + 清空 handler
 *
 * 节点发现：hub 推 presence 时填充 onlineNodes + boxPublicKeys（仅展示用）；
 * discoverNodes() 返回 onlineNodes 快照。
 *
 * 解密 deliver：用 trustStore.getBoxPublicKey(msg.from) 查来源 box 公钥派生共享密钥
 *（与出站 send 对称）——未信任节点直接丢弃；presence 学到的映射不参与解密决策。
 */
export class HubTransport implements TransportLayer {
  readonly type = 'hub' as const;
  private ws?: WebSocket;
  /** hub 推送的在线节点（discoverNodes 返回它） */
  private onlineNodes = new Map<string, NodeInfo>();
  /**
   * 在线节点的 box 公钥（presence 推送时学到）。
   * 仅用于展示在线节点信息——受 hub 完全控制，禁止用于解密/信任决策（安全修复）。
   */
  private boxPublicKeys = new Map<string, Uint8Array>();
  private handlers = new Set<(msg: IncomingMessage) => void>();

  constructor(private readonly opts: HubTransportOpts) {}

  async start(): Promise<void> {
    const ws = new WebSocket(this.opts.hubUrl);
    this.ws = ws;
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => {
        ws.send(JSON.stringify({
          type: 'hello',
          nodeId: this.opts.identity.nodeId,
          authToken: this.opts.authToken,
          boxPublicKey: Buffer.from(this.opts.boxKeyPair.publicKey).toString('base64'),
          displayName: this.opts.identity.displayName,
        }));
        resolve();
      });
      ws.on('error', reject);
    });

    ws.on('message', (raw) => {
      // ws 在 Node 环境总传 Buffer；类型上 RawData 是联合，运行时用 isBuffer 收窄
      if (!Buffer.isBuffer(raw)) return;
      try {
        const msg = JSON.parse(raw.toString('utf8')) as HubToClient;
        this.handleHubMessage(msg);
      } catch {
        // 忽略解析失败的非协议帧
      }
    });
  }

  async stop(): Promise<void> {
    this.ws?.close();
    this.ws = undefined;
    this.handlers.clear();
  }

  async send(targetNodeId: string, payload: MessagePayload): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('hub 连接未就绪');
    }
    const peerBoxPub = this.opts.trustStore.getBoxPublicKey(targetNodeId);
    if (!peerBoxPub) throw new Error(`未知节点 ${targetNodeId} 的 box 公钥`);

    const sharedKey = deriveSharedKey(this.opts.boxKeyPair.secretKey, peerBoxPub);
    const nonce = randomNonce();
    const plaintext = new TextEncoder().encode(JSON.stringify(payload));
    const ciphertext = encryptPayload(plaintext, sharedKey, nonce);

    this.ws.send(JSON.stringify({
      type: 'send',
      to: targetNodeId,
      ciphertext: Buffer.from(ciphertext).toString('base64'),
      nonce: Buffer.from(nonce).toString('base64'),
    }));
  }

  discoverNodes(): NodeInfo[] {
    return Array.from(this.onlineNodes.values());
  }

  onMessage(handler: (msg: IncomingMessage) => void): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  /** 处理 hub 推送消息——按 type 窄化字段（discriminated union） */
  private handleHubMessage(msg: HubToClient): void {
    if (msg.type === 'presence') {
      for (const n of msg.nodes) {
        const boxPub = new Uint8Array(Buffer.from(n.boxPublicKey, 'base64'));
        this.boxPublicKeys.set(n.nodeId, boxPub);
        this.onlineNodes.set(n.nodeId, {
          nodeId: n.nodeId,
          displayName: n.displayName,
          publicKey: boxPub,
          transport: 'hub',
          lastSeen: Date.now(),
        });
      }
      return;
    }
    if (msg.type === 'deliver') {
      // 安全修复：解密公钥只从本地 trustStore 取（与出站 send 对称）。
      // presence 学到的映射受 hub 控制，用它会放大"hub 换 key 冒充受害者"攻击；
      // 未信任节点一律丢弃。
      const peerBoxPub = this.opts.trustStore.getBoxPublicKey(msg.from);
      if (!peerBoxPub) return; // 未信任来源，丢弃
      const sharedKey = deriveSharedKey(this.opts.boxKeyPair.secretKey, peerBoxPub);
      const nonce = new Uint8Array(Buffer.from(msg.nonce, 'base64'));
      const ciphertext = new Uint8Array(Buffer.from(msg.ciphertext, 'base64'));
      const plaintext = decryptPayload(ciphertext, sharedKey, nonce);
      if (!plaintext) return; // 解密失败（密文被篡改 / 密钥不匹配——含 hub 换 key 场景）
      const payload = JSON.parse(new TextDecoder().decode(plaintext)) as MessagePayload;
      const incoming: IncomingMessage = {
        fromNodeId: msg.from,
        payload,
        receivedAt: Date.now(),
      };
      for (const h of this.handlers) h(incoming);
      return;
    }
    // 'error' 类型：当前仅吞掉；后续可加日志/重连策略
  }
}
