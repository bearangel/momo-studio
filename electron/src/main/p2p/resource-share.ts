// electron/src/main/p2p/resource-share.ts
//
// 资源目录出站构建 + 入站缓存（P4 Task 4）。
//
// 设计要点：
//   - 目录范围：仅 custom agent / custom mcp——两者是 JSON 结构化定义，清单元数据
//     可直接映射传输。skill 排除：zip 是文件块而非结构化数据，分享需文件块传输
//     协议，留 2.1（P4 计划范围裁定①）
//   - 出站触发：事件触发为主（resource:registerMcp/uploadSkill/delete + agent
//     create/update/delete 自定义写通道成功后 fire-and-forget）+ 5min 定时兜底
//     （目录变更频率远低于任务流转，无需 45s 级重播）
//   - 入站缓存镜像 remote-cache.ts 模式：Map 按 fromNodeId 键控（传输层验签来源），
//     cat.nodeId 自报字段不采信；同节点整条覆写；超 5 分钟无更新 prune
//     （getSharedResources 读口顺带清理——覆盖 listResources / handler / T5 导入路径）
//   - 依赖装配镜像 task-broadcast.ts：deps 由 initP2p 注入 / stopP2p 清空，
//     未装配时出站静默 no-op——本地资源写路径完全不受 P2P 启停影响
import { logger } from '../logger';
import { listCustomResources } from '../resource/custom';
import type { P2pSync } from './sync';
import type { ResourceCatalogEntry } from './protocols';

/** 远端节点共享目录（getSharedResources 返回结构） */
export interface SharedNodeResources {
  nodeId: string;
  nodeName: string;
  items: ResourceCatalogEntry['items'];
  takenAt: number;
}

/** 装配依赖——initP2p 成功后注入（Pick 收窄到本模块实际用到的能力） */
export interface ResourceShareDeps {
  /** 广播通道（P2pSync 实例；结构类型便于测试注入最小桩） */
  sync: Pick<P2pSync, 'broadcastResourceCatalog'>;
  /** 当前节点身份——目录 nodeId / nodeName 来源 */
  nodeId: string;
  nodeName: string;
}

/** prune 阈值：超此时长无更新的节点条目直接移除（与 remote-cache PRUNE_AFTER_MS 一致） */
const PRUNE_AFTER_MS = 5 * 60_000;

/** 模块级单例（initP2p 装配，stopP2p 清空） */
let deps: ResourceShareDeps | null = null;

/** 入站缓存——key = fromNodeId（验签来源），value = 最近一次目录 */
const cache = new Map<string, SharedNodeResources>();

/** initP2p 装配调用：注入 P2pSync 实例 + 当前节点身份 */
export function setResourceShareDeps(next: ResourceShareDeps): void {
  deps = next;
}

/** stopP2p 清空调用：回到"P2P 未启用"状态（出站静默 no-op） */
export function clearResourceShareDeps(): void {
  deps = null;
}

/**
 * 出站目录构建：listCustomResources 过滤 type ∈ {agent, mcp} 映射为目录条目。
 * skill 排除（2.1 遗留：zip 文件块传输协议未就位）。身份字段显式传入
 * （生产唯一调用点 broadcastLocalResourceCatalog 用 deps 身份）——保持纯函数可测。
 */
export function buildLocalResourceCatalog(
  nodeId: string,
  nodeName: string,
): ResourceCatalogEntry {
  const items: ResourceCatalogEntry['items'] = [];
  for (const r of listCustomResources()) {
    // skill 排除：目录只收 agent/mcp（控制流同时完成类型收窄）
    if (r.type !== 'agent' && r.type !== 'mcp') continue;
    items.push({
      type: r.type,
      slug: r.slug,
      name: r.name,
      description: r.description,
      version: r.version,
    });
  }
  return { nodeId, nodeName, items, takenAt: Date.now() };
}

/**
 * 入站缓存写入：同节点整条覆写（全量目录语义，旧条目不残留）。
 * by initP2p 的 onRemoteResourceCatalog 回调调用（入站链路唯一写点）。
 */
export function writeResourceCatalog(cat: ResourceCatalogEntry, fromNodeId: string): void {
  cache.set(fromNodeId, {
    nodeId: fromNodeId,
    nodeName: cat.nodeName,
    items: cat.items,
    takenAt: cat.takenAt,
  });
}

/** 读取全部远端共享目录——listResources p2p 源的数据入口 */
export function getSharedResources(): SharedNodeResources[] {
  // 读路径顺带清理——T3 模式的生产触发点是看板 5s 轮询（handler），
  // 资源侧消费点是 listResources 读缓存，故在读口清理（离线对端目录不滞留）
  pruneStaleResources();
  return Array.from(cache.values());
}

/** 清理超 5 分钟无更新的节点条目——getSharedResources 读口顺带调用 */
export function pruneStaleResources(): void {
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (now - entry.takenAt > PRUNE_AFTER_MS) {
      cache.delete(key);
    }
  }
}

/** 清空缓存——测试隔离用（生产无调用点：重启自然清空 + prune 兜底） */
export function clearSharedResourceCache(): void {
  cache.clear();
}

/**
 * 出站应用层：广播本地资源目录。
 * deps 未装配（P2P 未启用）时静默返回；失败仅记日志不抛（同
 * broadcastLocalTaskSnapshot 容错模式）。调用方一律 fire-and-forget：
 * `void broadcastLocalResourceCatalog()`。
 */
export async function broadcastLocalResourceCatalog(): Promise<void> {
  if (!deps) return;
  try {
    await deps.sync.broadcastResourceCatalog(
      buildLocalResourceCatalog(deps.nodeId, deps.nodeName),
    );
  } catch (err) {
    logger.warn('P2P 资源目录广播失败', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
