// electron/src/main/p2p/trust-store.ts
//
// 信任节点列表——首次连接扫码确认后持久化（C3 最小实现，C8 完整版补 ACL/批量导入）。
//
// 设计要点：
//   - 存 `<userData>/p2p-trusted-nodes.json`（base64 编码公钥，0o600 权限）
//   - v1 简化：v1 信任后所有消息互通；v2 加 ACL 细粒度（C8 任务）
//   - 节点 ID 主键：同 nodeId 视为同节点（add 时去重覆盖）
//   - 文件不存在时返回空列表（首次启动常见路径，不抛错）
//
// 导出 API：
//   - listTrustedNodes()：读取全部
//   - addTrustedNode(node)：upsert 单个
//   - removeTrustedNode(nodeId)：按 id 删
//   - isTrusted(nodeId)：存在性检查
//   - getTrustedPublicKey(nodeId)：验签前查公钥
//   - saveAll(list)：批量覆盖写（集成测试场景预置信任表用）
import fs from 'node:fs';
import path from 'node:path';
import { resolveUserDataDir } from '../paths';

/** 信任节点记录（持久化前后做 base64 编码转换） */
export interface TrustedNode {
  nodeId: string;
  displayName: string;
  publicKey: Uint8Array;
  trustedAt: number;
}

const TRUST_FILE = 'p2p-trusted-nodes.json';

function trustPath(): string {
  return path.join(resolveUserDataDir(), TRUST_FILE);
}

/** 持久化文件的原始 JSON 形态（公钥为 base64 字符串） */
interface SerializedTrustedNode {
  nodeId: string;
  displayName: string;
  publicKey: string;
  trustedAt: number;
}

/** 列出全部信任节点。文件不存在时返回空数组。 */
export function listTrustedNodes(): TrustedNode[] {
  const p = trustPath();
  if (!fs.existsSync(p)) return [];
  const raw = JSON.parse(fs.readFileSync(p, 'utf-8')) as SerializedTrustedNode[];
  return raw.map((r) => ({
    nodeId: r.nodeId,
    displayName: r.displayName,
    publicKey: new Uint8Array(Buffer.from(r.publicKey, 'base64')),
    trustedAt: r.trustedAt,
  }));
}

/** 添加或更新（按 nodeId 去重）信任节点。 */
export function addTrustedNode(node: TrustedNode): void {
  const list = listTrustedNodes().filter((n) => n.nodeId !== node.nodeId);
  list.push(node);
  saveAll(list);
}

/** 按 nodeId 删除信任节点（不存在时无操作）。 */
export function removeTrustedNode(nodeId: string): void {
  saveAll(listTrustedNodes().filter((n) => n.nodeId !== nodeId));
}

/** 节点是否在信任列表中。 */
export function isTrusted(nodeId: string): boolean {
  return listTrustedNodes().some((n) => n.nodeId === nodeId);
}

/** 取信任节点的公钥（用于验签）。不在信任列表时返回 null。 */
export function getTrustedPublicKey(nodeId: string): Uint8Array | null {
  return listTrustedNodes().find((n) => n.nodeId === nodeId)?.publicKey ?? null;
}

/**
 * 批量覆盖写信任列表。
 * 内部使用——addTrustedNode/removeTrustedNode 都通过它落盘；测试也用它预置数据。
 */
export function saveAll(list: TrustedNode[]): void {
  const dir = path.dirname(trustPath());
  fs.mkdirSync(dir, { recursive: true });
  const serialized: SerializedTrustedNode[] = list.map((n) => ({
    nodeId: n.nodeId,
    displayName: n.displayName,
    publicKey: Buffer.from(n.publicKey).toString('base64'),
    trustedAt: n.trustedAt,
  }));
  fs.writeFileSync(trustPath(), JSON.stringify(serialized, null, 2), { mode: 0o600 });
}
