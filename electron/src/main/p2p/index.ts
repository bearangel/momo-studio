// electron/src/main/p2p/index.ts
//
// P2P 子系统入口（C 子系统 C8）——初始化 + IPC handlers。
//
// 设计要点：
//   - initP2p() 加载或生成 NodeIdentity，串起 LocalTransport + LanTransport + Router + P2pSync。
//     模块级单例（router/lanTransport/sync）保证 IPC handlers 能拿到运行时引用。
//   - registerP2pHandlers() 暴露 6 个 IPC：
//       p2p:getIdentity         当前节点身份
//       p2p:getDiscoveredNodes  发现的节点列表（带 trusted 标记）
//       p2p:addTrustedNode      信任节点（按 nodeId 从 discoveredNodes 查公钥）
//       p2p:removeTrustedNode   取消信任
//       p2p:listTrustedNodes    信任节点完整列表
//       p2p:getRemoteTasks      远端节点任务只读镜像（P4 Task 3；轮询点顺带 prune）
//     远端共享资源目录无独立 IPC——renderer 走 resource:list（listResources 读 p2p 源
//     缓存，getSharedResources 读口顺带 prune；P4 Task 4 + 终审移除死 handler）
//   - 本 task 不实际接入 main/index.ts 启动流程（C8 仅提供函数，C9+ 集成）。
//
// 与 C7 sync.ts 的关系：
//   sync 通过 router.onIncoming(handler) 订阅，router opts.onIncoming 兼容回调保留空函数。
//   onRemoteMessage → handleRemoteMessage：把对端 message 写入 SQLite（source='lan'）+ 推 renderer。
//   broadcastLocalMessage：本地新消息出站触发，委托 sync.broadcastNewMessage 广播给信任节点。
//
// P4 Task 2 追加：
//   initP2p 同时装配 task-broadcast 依赖（sync + 节点身份），并再导出
//   broadcastLocalTaskSnapshot 作为任务快照出站广播的 facade——写路径触发点
//   （task IPC handlers / scheduler）直接 import task-broadcast 叶子模块。
//
// P4 Task 4 追加：
//   initP2p 同时装配 resource-share 依赖 + onRemoteResourceCatalog 入站接线；
//   5min 资源目录周期重播兜底（目录变更频率远低于任务流转；renderer 走 resource:list
//   读 p2p 源，getSharedResources 读口顺带 prune）。
import { BrowserWindow, ipcMain } from 'electron';
import { Router } from './router';
import { LocalTransport } from './local-transport';
import { LanTransport } from './lan-transport';
import {
  loadIdentity,
  generateIdentity,
  saveIdentity,
  publicKeyFingerprint,
} from './identity';
import {
  listTrustedNodes,
  addTrustedNode,
  removeTrustedNode,
  isTrusted,
  getTrustedPublicKey,
  getTrustedBoxPublicKey,
} from './trust-store';
import { P2pSync, type SyncMessage } from './sync';
import {
  setTaskBroadcastDeps,
  clearTaskBroadcastDeps,
  broadcastLocalTaskSnapshot,
} from './task-broadcast';
import {
  setResourceShareDeps,
  clearResourceShareDeps,
  broadcastLocalResourceCatalog,
  writeResourceCatalog,
} from './resource-share';
import {
  setResourceTransferDeps,
  clearResourceTransferDeps,
  handleResourceRequest,
  handleResourceProvide,
} from './resource-transfer';
import {
  writeTaskSnapshot,
  getRemoteTasks,
  pruneStale,
} from './remote-cache';
import { insertMessage } from '../storage/messages/repo';
import { logger } from '../logger';

// 任务快照出站广播 facade（P4 Task 2）——实现与依赖装配在 ./task-broadcast
export { broadcastLocalTaskSnapshot } from './task-broadcast';

// 资源目录出站广播 facade（P4 Task 4）——实现与依赖装配在 ./resource-share
export { broadcastLocalResourceCatalog } from './resource-share';

/**
 * 快照周期重播兜底间隔（T2 移交项）——30-60s 取中值。
 * 事件触发广播依赖本地写路径（task IPC / scheduler），但 agent 自主终态等
 * 场景无本地写触发点，对端 staleness 会无界增长——周期重播保证有界。
 */
const SNAPSHOT_REBROADCAST_INTERVAL_MS = 45_000;

/**
 * 资源目录周期重播兜底间隔（P4 Task 4）。
 * 目录变更频率远低于任务流转（仅 custom 资源增删改触发），事件触发为主、
 * 5min 重播仅兜底（如对端离线期间错过的目录更新，重连后最多 5min 补齐）。
 */
const RESOURCE_CATALOG_REBROADCAST_INTERVAL_MS = 5 * 60_000;

/** 模块级单例（initP2p 创建，IPC handlers / stopP2p 引用） */
let router: Router | null = null;
let lanTransport: LanTransport | null = null;
let sync: P2pSync | null = null;
/** 任务快照周期重播定时器（initP2p 创建并 unref，stopP2p 清理） */
let snapshotRebroadcastTimer: NodeJS.Timeout | null = null;
/** 资源目录周期重播定时器（initP2p 创建并 unref，stopP2p 清理） */
let resourceCatalogRebroadcastTimer: NodeJS.Timeout | null = null;
/** 当前节点身份缓存（getIdentity handler 用；fingerprint 供信任前带外核对） */
let currentIdentity: { nodeId: string; displayName: string; fingerprint: string } | null = null;

/**
 * 初始化 P2P 子系统。
 * 加载或生成 NodeIdentity → 创建 LocalTransport + LanTransport + Router + P2pSync → start。
 * 幂等：重复调用会先停止旧实例（防止 mDNS 端口泄漏）。
 */
export async function initP2p(): Promise<void> {
  // 幂等保护：重复调用先清理旧实例
  if (router) {
    await stopP2p();
  }

  // 1. 节点身份：加载或生成（loadIdentity 自带旧文件 box 密钥迁移）
  let id = loadIdentity();
  if (!id) {
    id = generateIdentity('My Momo Node');
    saveIdentity(id);
  }
  currentIdentity = {
    nodeId: id.nodeId,
    displayName: id.displayName,
    fingerprint: publicKeyFingerprint(id.publicKey),
  };

  // 2. 传输层：本地（无 IO）+ 局域网（mDNS + TCP）
  const local = new LocalTransport(id);
  lanTransport = new LanTransport({
    identity: id,
    trustStore: { isTrusted, getTrustedPublicKey, getTrustedBoxPublicKey },
  });

  // 3. 路由层：按 nodeId 选 transport
  // onIncoming 兼容回调保留空函数——C7 sync 通过 router.onIncoming(handler) 订阅
  router = new Router({
    localNodeId: id.nodeId,
    localTransport: local,
    lanTransport,
    onIncoming: () => {
      // sync.start() 订阅 router.onIncoming 接管所有入站消息
    },
  });
  await router.start();

  // 4. 应用层同步：把对端 message 写本地 SQLite + 推 renderer；
  //    任务快照入站 → remote-cache 只读镜像（不落 tasks 表——防本节点调度器误捡）；
  //    资源目录入站 → resource-share 缓存（清单元数据，完整定义走 request/provide）；
  //    资源请求入站 → 供给方查本地 custom 回执；资源供给入站 → 需求方 resolve pending（T5）
  sync = new P2pSync({
    router,
    localNodeId: id.nodeId,
    onRemoteMessage: handleRemoteMessage,
    onRemoteTaskSnapshot: writeTaskSnapshot,
    onRemoteResourceCatalog: writeResourceCatalog,
    onResourceRequest: handleResourceRequest,
    onResourceProvide: handleResourceProvide,
  });
  sync.start();

  // 5. 任务快照出站广播装配（P4 Task 2）：注入 sync + 当前身份——
  //    写路径触发点（task IPC handlers / scheduler）经 task-broadcast 模块取用
  setTaskBroadcastDeps({ sync, nodeId: id.nodeId, nodeName: id.displayName });

  // 6. 资源目录出站广播装配（P4 Task 4）：注入 sync + 当前身份——
  //    写路径触发点（resource IPC handlers / agent IPC handlers）经 resource-share 模块取用
  setResourceShareDeps({ sync, nodeId: id.nodeId, nodeName: id.displayName });

  // 6b. 资源导入请求/供给装配（P4 Task 5）：requestResourceImport 的单发通道依赖
  setResourceTransferDeps({ sync });

  // 7. 任务快照周期重播兜底（T2 移交）：事件触发外的快照重播，保证对端 staleness 有界。
  //    unref——纯兜底重播不值得阻止进程退出
  snapshotRebroadcastTimer = setInterval(() => {
    void broadcastLocalTaskSnapshot();
  }, SNAPSHOT_REBROADCAST_INTERVAL_MS);
  snapshotRebroadcastTimer.unref();

  // 8. 资源目录周期重播兜底（P4 Task 4）：事件触发为主（custom 资源写通道），
  //    5min 重播保证对端离线错过的目录更新重连后有界补齐。unref 同上
  resourceCatalogRebroadcastTimer = setInterval(() => {
    void broadcastLocalResourceCatalog();
  }, RESOURCE_CATALOG_REBROADCAST_INTERVAL_MS);
  resourceCatalogRebroadcastTimer.unref();
}

/**
 * 入站应用层：收到对端 message → 写入 SQLite（source='lan'）→ 推 renderer。
 *
 * source 统一用 'lan' 标识所有 P2P 来源（LAN mDNS + hub 中转）——
 * 区分具体传输层由 router/transport 负责，应用层只需知道"非本地产生"。
 * sender 契约（P4 安全修复）：入站 sender 已由 sync.handleIncoming 命名空间化为
 * `remote:<fromNodeId>[:<原始sender>]`——本函数不做二次改写，但下游（renderer 显示）
 * 依赖该前缀区分本地/远端身份；直接调用方（测试/未来接线）必须先构造同款前缀。
 * roomId 由 messages 表外键约束兜底（不存在的会话写入失败，仅记 warn）。
 * 失败时记录日志但不抛出（入站消息丢失不影响 P2P 链路稳定性）。
 */
export function handleRemoteMessage(msg: SyncMessage): void {
  try {
    const row = insertMessage({
      sessionId: msg.roomId,
      sender: msg.sender,
      eventType: msg.eventType,
      body: msg.body,
      source: 'lan',
    });
    const win = BrowserWindow.getAllWindows()[0];
    if (win && !win.isDestroyed()) {
      // v2.0 P1 Task 12：推送通道由 im:message 改名 session:message（最后一个旧通道
      // 发送方），preload 反向桥已随之移除。
      win.webContents.send('session:message', row);
    }
  } catch (err) {
    logger.warn('P2P 入站消息写入失败', {
      sessionId: msg.roomId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * 出站应用层：本地新消息 → 广播给所有信任节点。
 *
 * sync 未初始化（P2P 未启用）时静默返回——调用方无需关心 P2P 状态。
 * 由 im:send 路径在 insertMessage 后 fire-and-forget 调用。
 */
export async function broadcastLocalMessage(msg: SyncMessage): Promise<void> {
  if (!sync) return;
  try {
    await sync.broadcastNewMessage(msg);
  } catch (err) {
    logger.warn('P2P 出站广播失败', {
      sessionId: msg.roomId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * 停止 P2P 子系统，释放所有传输层资源（TCP 连接 + mDNS 广告）。
 * 反向顺序：sync → router（router.stop 会停掉所有 transport）。
 */
export async function stopP2p(): Promise<void> {
  // 周期重播定时器先行清理——后续不再有出站快照/目录
  if (snapshotRebroadcastTimer) {
    clearInterval(snapshotRebroadcastTimer);
    snapshotRebroadcastTimer = null;
  }
  if (resourceCatalogRebroadcastTimer) {
    clearInterval(resourceCatalogRebroadcastTimer);
    resourceCatalogRebroadcastTimer = null;
  }
  sync?.stop();
  sync = null;
  // 任务快照 / 资源目录广播 / 资源导入传输依赖一并清空——回到"P2P 未启用"静默 no-op
  clearTaskBroadcastDeps();
  clearResourceShareDeps();
  clearResourceTransferDeps();
  await router?.stop();
  router = null;
  lanTransport = null;
  currentIdentity = null;
}

/**
 * 注册 P2P IPC handlers（6 个 p2p: 通道）。
 * 必须在 initP2p() 之后调用（getIdentity / getDiscoveredNodes 依赖模块单例）。
 *
 * 幂等性：Electron ipcMain.handle 重复注册同通道会抛错；调用方需保证只调一次。
 */
export function registerP2pHandlers(): void {
  ipcMain.handle('p2p:getIdentity', () => currentIdentity);

  ipcMain.handle('p2p:getDiscoveredNodes', () => {
    if (!lanTransport) return [];
    const trusted = new Set(listTrustedNodes().map((n) => n.nodeId));
    return lanTransport.discoverNodes().map((n) => ({
      nodeId: n.nodeId,
      displayName: n.displayName,
      transport: n.transport,
      trusted: trusted.has(n.nodeId),
      lastSeen: n.lastSeen,
      // 签名公钥指纹（与 renderer types.d.ts 契约同步）：信任前与对端展示的本机指纹核对
      fingerprint: publicKeyFingerprint(n.publicKey),
    }));
  });

  ipcMain.handle('p2p:addTrustedNode', async (_evt, nodeId: string) => {
    if (!lanTransport) throw new Error('P2P 子系统未初始化');
    const node = lanTransport.discoverNodes().find((n) => n.nodeId === nodeId);
    if (!node) throw new Error(`未发现节点 ${nodeId}`);
    // 同时捕获签名公钥 + box 公钥（v2 帧加密用）；旧版本对端无 box 公钥时缺省——
    // 此时该节点不可 v2 加密通信，需对端升级后重新信任
    addTrustedNode({
      nodeId: node.nodeId,
      displayName: node.displayName,
      publicKey: node.publicKey,
      ...(node.boxPublicKey !== undefined ? { boxPublicKey: node.boxPublicKey } : {}),
      trustedAt: Date.now(),
    });
  });

  ipcMain.handle('p2p:removeTrustedNode', (_evt, nodeId: string) => {
    removeTrustedNode(nodeId);
  });

  ipcMain.handle('p2p:listTrustedNodes', () =>
    listTrustedNodes().map((n) => ({
      nodeId: n.nodeId,
      displayName: n.displayName,
      trustedAt: n.trustedAt,
    })),
  );

  // P4 Task 3：远端节点任务只读镜像。看板侧 5s 轮询入口——顺带 prune
  //（计划原定 NodeDiscoveryPanel 轮询点顺带调，此处 handler 即实际轮询点）
  ipcMain.handle('p2p:getRemoteTasks', () => {
    pruneStale();
    return getRemoteTasks();
  });

  // 远端共享资源目录无独立 IPC（终审清理）——renderer 走 resource:list →
  // listResources 调 getSharedResources() 读 p2p 缓存（读口自带 prune）
}
