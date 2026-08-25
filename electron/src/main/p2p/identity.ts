// electron/src/main/p2p/identity.ts
//
// 节点身份——Ed25519 签名密钥对 + X25519 box 密钥对 + 节点 ID（公钥指纹）。
// 密钥对存 `<userData>/p2p-identity.json`（base64 编码，0o600 权限）；首次启动 generate。
//
// 设计要点：
//   - nodeId 取公钥前 16 hex 字符（8 字节），前缀 `node_`；碰撞概率约 2^-64，足够节点标识
//   - 签名私钥是 nacl.sign.keyPair() 返回的 64 字节 secretKey（含公钥），签名时直接用
//   - box 密钥对（X25519）独立于签名密钥对：LAN 帧 v2 加密用（DH 派生共享密钥）。
//     旧身份文件缺 box 密钥时 loadIdentity 现场生成并回写（加载时迁移）
//   - 文件位置放在 userData 根而非 p2p/ 子目录，便于后续单文件扩展（peer list / 密钥对等）
//   - 不引入加密层（私钥明文存盘）：节点身份自身受 OS 文件权限保护；
//     进一步加密是 v2.1 的"信任设备绑定"任务的事
import nacl from 'tweetnacl';
import fs from 'node:fs';
import path from 'node:path';
import { resolveUserDataDir } from '../paths';

export interface NodeIdentity {
  /** 节点 ID，签名公钥指纹（hex 前 16 字符 + 前缀） */
  nodeId: string;
  /** Ed25519 公钥（32 字节） */
  publicKey: Uint8Array;
  /** Ed25519 私钥（64 字节，tweetnacl 格式） */
  privateKey: Uint8Array;
  /** X25519 box 公钥（32 字节）——LAN 帧 v2 加密：DH 派生共享密钥用 */
  boxPublicKey: Uint8Array;
  /** X25519 box 私钥（32 字节）——与 boxPublicKey 成对 */
  boxPrivateKey: Uint8Array;
  /** 用户可见的展示名（如 "Alice 的 Mac"） */
  displayName: string;
  /** 密钥对生成时间（毫秒时间戳） */
  createdAt: number;
}

const IDENTITY_FILE = 'p2p-identity.json';

/** X25519 box 密钥长度（tweetnacl box.publicKeyLength）——迁移时的合法性校验基准 */
const BOX_KEY_LENGTH = 32;

/**
 * 生成新节点身份（签名密钥对 + box 密钥对 + 节点 ID）。
 * 不写盘——调用方决定何时 saveIdentity。
 */
export function generateIdentity(displayName: string): NodeIdentity {
  const { publicKey, secretKey } = nacl.sign.keyPair();
  const box = nacl.box.keyPair();
  return {
    nodeId: nodeIdFromPublicKey(publicKey),
    publicKey,
    privateKey: secretKey,
    boxPublicKey: box.publicKey,
    boxPrivateKey: box.secretKey,
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

/**
 * 签名公钥指纹——sha512(公钥) 前 16 字节的 hex（32 字符）。
 * 用途：添加信任前的带外人工核对（两台设备 UI 各自展示指纹，用户比对是否一致，
 * 防止局域网内冒充 nodeId + 替换公钥的中间人）。
 */
export function publicKeyFingerprint(pub: Uint8Array): string {
  return Buffer.from(nacl.hash(pub).slice(0, 16)).toString('hex');
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
    boxPublicKey: Buffer.from(id.boxPublicKey).toString('base64'),
    boxPrivateKey: Buffer.from(id.boxPrivateKey).toString('base64'),
    displayName: id.displayName,
    createdAt: id.createdAt,
  };
  fs.writeFileSync(p, JSON.stringify(serialized, null, 2), { mode: 0o600 });
}

/** 身份文件的磁盘 JSON 形态（密钥为 base64 字符串）；box 字段旧文件可能缺失 */
interface SerializedIdentity {
  nodeId: string;
  publicKey: string;
  privateKey: string;
  boxPublicKey?: string;
  boxPrivateKey?: string;
  displayName: string;
  createdAt: number;
}

/** 反序列化出的原始字段（box 可能缺失/非法） */
function deserializeIdentity(raw: SerializedIdentity): Omit<NodeIdentity, 'boxPublicKey' | 'boxPrivateKey'> & {
  boxPublicKey?: Uint8Array;
  boxPrivateKey?: Uint8Array;
} {
  return {
    nodeId: raw.nodeId,
    publicKey: new Uint8Array(Buffer.from(raw.publicKey, 'base64')),
    privateKey: new Uint8Array(Buffer.from(raw.privateKey, 'base64')),
    displayName: raw.displayName,
    createdAt: raw.createdAt,
  };
}

/**
 * 从磁盘加载节点身份。文件不存在时返回 null。
 * 加载时迁移：旧文件（v2.0 之前）没有 box 密钥对——现场生成并回写，
 * 保证 LAN 帧 v2 加密所需密钥材料就位。nodeId 不变（仍由签名公钥派生）。
 */
export function loadIdentity(): NodeIdentity | null {
  const p = identityPath();
  if (!fs.existsSync(p)) return null;
  const raw = JSON.parse(fs.readFileSync(p, 'utf-8')) as SerializedIdentity;
  const base = deserializeIdentity(raw);
  const rawBoxPub = raw.boxPublicKey !== undefined
    ? new Uint8Array(Buffer.from(raw.boxPublicKey, 'base64'))
    : undefined;
  const rawBoxSec = raw.boxPrivateKey !== undefined
    ? new Uint8Array(Buffer.from(raw.boxPrivateKey, 'base64'))
    : undefined;

  // 完整且长度合法的 box 密钥对直接采用（内联判空让 TS 完成窄化；
  // 旧文件缺失 / 损坏字段走下方迁移分支）
  if (
    rawBoxPub !== undefined &&
    rawBoxSec !== undefined &&
    rawBoxPub.length === BOX_KEY_LENGTH &&
    rawBoxSec.length === BOX_KEY_LENGTH
  ) {
    return { ...base, boxPublicKey: rawBoxPub, boxPrivateKey: rawBoxSec };
  }

  // 迁移：生成新 box 密钥对 + 回写磁盘（后续启动不再重复生成）
  const box = nacl.box.keyPair();
  const migrated: NodeIdentity = {
    ...base,
    boxPublicKey: box.publicKey,
    boxPrivateKey: box.secretKey,
  };
  saveIdentity(migrated);
  return migrated;
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