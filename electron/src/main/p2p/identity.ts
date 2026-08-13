// electron/src/main/p2p/identity.ts
//
// 节点身份——Ed25519 密钥对 + 节点 ID（公钥指纹）。
// 密钥对存 `<userData>/p2p-identity.json`（base64 编码，0o600 权限）；首次启动 generate。
//
// 设计要点：
//   - nodeId 取公钥前 16 hex 字符（8 字节），前缀 `node_`；碰撞概率约 2^-64，足够节点标识
//   - 私钥是 nacl.sign.keyPair() 返回的 64 字节 secretKey（含公钥），签名时直接用
//   - 文件位置放在 userData 根而非 p2p/ 子目录，便于后续单文件扩展（peer list / 密钥对等）
//   - 不引入加密层（私钥明文存盘）：节点身份自身受 OS 文件权限保护；
//     进一步加密是 v2.1 的"信任设备绑定"任务的事
import nacl from 'tweetnacl';
import fs from 'node:fs';
import path from 'node:path';
import { resolveUserDataDir } from '../paths';

export interface NodeIdentity {
  /** 节点 ID，公钥指纹（hex 前 16 字符 + 前缀） */
  nodeId: string;
  /** Ed25519 公钥（32 字节） */
  publicKey: Uint8Array;
  /** Ed25519 私钥（64 字节，tweetnacl 格式） */
  privateKey: Uint8Array;
  /** 用户可见的展示名（如 "Alice 的 Mac"） */
  displayName: string;
  /** 密钥对生成时间（毫秒时间戳） */
  createdAt: number;
}

const IDENTITY_FILE = 'p2p-identity.json';

/**
 * 生成新节点身份（密钥对 + 节点 ID）。
 * 不写盘——调用方决定何时 saveIdentity。
 */
export function generateIdentity(displayName: string): NodeIdentity {
  const { publicKey, secretKey } = nacl.sign.keyPair();
  return {
    nodeId: nodeIdFromPublicKey(publicKey),
    publicKey,
    privateKey: secretKey,
    displayName,
    createdAt: Date.now(),
  };
}

/**
 * 从公钥派生稳定节点 ID。
 * 同公钥永远返回同 ID（确定性函数）。
 */
export function nodeIdFromPublicKey(pub: Uint8Array): string {
  // 取公钥前 16 hex 字符（8 字节）作 nodeId（碰撞概率极低，~2^-64）
  const hex = Buffer.from(pub).toString('hex');
  return `node_${hex.slice(0, 16)}`;
}

function identityPath(): string {
  return path.join(resolveUserDataDir(), IDENTITY_FILE);
}

/**
 * 持久化节点身份到 `<userData>/p2p-identity.json`。
 * 文件权限 0o600——只有当前用户可读写。
 */
export function saveIdentity(id: NodeIdentity): void {
  const p = identityPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const serialized = {
    nodeId: id.nodeId,
    publicKey: Buffer.from(id.publicKey).toString('base64'),
    privateKey: Buffer.from(id.privateKey).toString('base64'),
    displayName: id.displayName,
    createdAt: id.createdAt,
  };
  fs.writeFileSync(p, JSON.stringify(serialized, null, 2), { mode: 0o600 });
}

/**
 * 从磁盘加载节点身份。文件不存在时返回 null。
 */
export function loadIdentity(): NodeIdentity | null {
  const p = identityPath();
  if (!fs.existsSync(p)) return null;
  const raw = JSON.parse(fs.readFileSync(p, 'utf-8')) as {
    nodeId: string;
    publicKey: string;
    privateKey: string;
    displayName: string;
    createdAt: number;
  };
  return {
    nodeId: raw.nodeId,
    publicKey: new Uint8Array(Buffer.from(raw.publicKey, 'base64')),
    privateKey: new Uint8Array(Buffer.from(raw.privateKey, 'base64')),
    displayName: raw.displayName,
    createdAt: raw.createdAt,
  };
}

/**
 * 用节点私钥对消息签名（detached 签名，不含消息本身）。
 */
export function sign(id: NodeIdentity, message: Uint8Array): Uint8Array {
  return nacl.sign.detached(message, id.privateKey);
}

/**
 * 用公钥验证 detached 签名。
 * 任何不一致（消息被改 / 公钥不对 / 签名损坏）都返回 false。
 */
export function verify(
  publicKey: Uint8Array,
  message: Uint8Array,
  signature: Uint8Array,
): boolean {
  return nacl.sign.detached.verify(message, signature, publicKey);
}