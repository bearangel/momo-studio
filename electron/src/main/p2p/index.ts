// electron/src/main/p2p/index.ts
//
// P2P 子系统入口（C 子系统 C8）——初始化 + IPC handlers。
//
// 设计要点：
//   - initP2p() 加载或生成 NodeIdentity，串起 LocalTransport + LanTransport + Router + P2pSync。
//     模块级单例（router/lanTransport/sync）保证 IPC handlers 能拿到运行时引用。
//   - registerP2pHandlers() 暴露 5 个 IPC：
//       p2p:getIdentity         当前节点身份
//       p2p:getDiscoveredNodes  发现的节点列表（带 trusted 标记）
//       p2p:addTrustedNode      信任节点（按 nodeId 从 discoveredNodes 查公钥）
//       p2p:removeTrustedNode   取消信任
//       p2p:listTrustedNodes    信任节点完整列表
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
import { BrowserWindow, ipcMain } from 'electron';
import { Router } from './router';
import { LocalTransport } from './local-transport';
import { LanTransport } from './lan-transport';
import {
  loadIdentity,
  generateIdentity,
  saveIdentity,
} from './identity';
import {
  listTrustedNodes,
  addTrustedNode,
  removeTrustedNode,
  isTrusted,
  getTrustedPublicKey,
} from './trust-store';
import { P2pSync, type SyncMessage } from './sync';
import { setTaskBroadcastDeps, clearTaskBroadcastDeps } from './task-broadcast';
import { insertMessage } from '../storage/messages/repo';
import { logger } from '../logger';

// 任务快照出站广播 facade（P4 Task 2）——实现与依赖装配在 ./task-broadcast
export { broadcastLocalTaskSnapshot } from './task-broadcast';

/** 模块级单例（initP2p 创建，IPC handlers / stopP2p 引用） */
let router: Router | null = null;
let lanTransport: LanTransport | null = null;
let sync: P2pSync | null = null;
/** 当前节点身份缓存（getIdentity handler 用） */
let currentIdentity: { nodeId: string; displayName: string } | null = null;

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

  // 1. 节点身份：加载或生成
  let id = loadIdentity();
  if (!id) {
    id = generateIdentity('My Momo Node');
    saveIdentity(id);
  }
  currentIdentity = { nodeId: id.nodeId, displayName: id.displayName };

  // 2. 传输层：本地（无 IO）+ 局域网（mDNS + TCP）
  const local = new LocalTransport(id);
  lanTransport = new LanTransport({
    identity: id,
    trustStore: { isTrusted, getTrustedPublicKey },
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

  // 4. 应用层同步：把对端 message 写本地 SQLite + 推 renderer
  sync = new P2pSync({
    router,
    localNodeId: id.nodeId,
    onRemoteMessage: handleRemoteMessage,
  });
  sync.start();

  // 5. 任务快照出站广播装配（P4 Task 2）：注入 sync + 当前身份——
  //    写路径触发点（task IPC handlers / scheduler）经 task-broadcast 模块取用
  setTaskBroadcastDeps({ sync, nodeId: id.nodeId, nodeName: id.displayName });
}

/**
 * 入站应用层：收到对端 message → 写入 SQLite（source='lan'）→ 推 renderer。
 *
 * source 统一用 'lan' 标识所有 P2P 来源（LAN mDNS + hub 中转）——
 * 区分具体传输层由 router/transport 负责，应用层只需知道"非本地产生"。
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
  sync?.stop();
  sync = null;
  // 任务快照广播依赖一并清空（P4 Task 2）——回到"P2P 未启用"静默 no-op
  clearTaskBroadcastDeps();
  await router?.stop();
  router = null;
  lanTransport = null;
  currentIdentity = null;
}

/**
 * 注册 P2P IPC handlers（5 个 p2p: 通道）。
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
    }));
  });

  ipcMain.handle('p2p:addTrustedNode', async (_evt, nodeId: string) => {
    if (!lanTransport) throw new Error('P2P 子系统未初始化');
    const node = lanTransport.discoverNodes().find((n) => n.nodeId === nodeId);
    if (!node) throw new Error(`未发现节点 ${nodeId}`);
    addTrustedNode({
      nodeId: node.nodeId,
      displayName: node.displayName,
      publicKey: node.publicKey,
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
}
