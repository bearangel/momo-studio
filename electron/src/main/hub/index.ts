// HubManager 单例——主进程生命周期接线（taskExecutor 同款模块级单例模式）。
// 职责：读配置+凭证 → 起停 HubClient；状态/事件转发全部窗口（webContents.send）。
import { BrowserWindow } from 'electron';
import { getDb } from '../storage/db';
import { logger } from '../logger';
import { createHubClient, enrollOverHttp, type HubClient, type HubConnectionState } from './client';
import { createHubConfigStore, type HubConfigRow } from './config-store';
import {
  clearDeviceToken,
  deriveDeviceTokenScopeSuffix,
  getDeviceToken,
  setDeviceToken,
  setDeviceTokenScopeResolver,
} from './creds';
import {
  registerTrustedDownloadOrigin,
  unregisterTrustedDownloadOrigin,
} from '../marketplace/installer';
import { EVT, type EventEnvelope, type RequestEnvelope, type ResponseEnvelope, type RpcErrorPayload } from './protocol';
import { MIRROR_WIRE, type MirrorApplyPayload, type MirrorApplyOutcome } from './mirror-wire';
import { applyMirrorSnapshot } from './mirror-applier';
import { bridgeGroupChanged } from './groups';
import type { HubResponderResult } from './client';

export interface HubStatus {
  configured: boolean;
  state: HubConnectionState;
  hubUrl: string | null;
  nodeName: string | null;
  nodeId: string | null;
  lastError: string | null;
}

let client: HubClient | null = null;
let lastError: string | null = null;
// 当前连接的在线节点快照（hello 成功时写入，已排除本机）——renderer 拉状态时重播，
// 使「面板挂载晚于 hello」也见全量在线节点（快照是 hub 唯一的存量下发面：
// 协议 onlineNodes 注释明言「后续增量走 node.online/offline 事件」）。
// 集合由快照（存量）+ node.online/offline 事件（增量）共同维护——重播的是权威视图
let presenceSeed: Array<{ nodeId: string; nodeName: string }> | null = null;

const configStore = () => createHubConfigStore(getDb());

function broadcast(channel: string, payload: unknown): void {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send(channel, payload);
}

export function hubGetStatus(): HubStatus {
  const cfg = configStore().read();
  return {
    configured: cfg !== null,
    state: client?.state() ?? 'disconnected',
    hubUrl: cfg?.hubUrl ?? null,
    nodeName: cfg?.nodeName ?? null,
    nodeId: cfg?.nodeId ?? null,
    lastError,
  };
}

/**
 * RPC 请求面（M2 组管理消费）——透传 client 关联器；未建连/未配置时人话拒绝。
 * 错误语义由 client.request 单点定义（hub 人话原文 / 连接已重置 / 超时）。
 */
export function hubRequest<T>(method: string, payload: unknown, timeoutMs?: number): Promise<T> {
  if (!client) return Promise.reject(new Error('hub 未连接，请先在设置中接入 momo-hub'));
  return client.request<T>(method, payload, timeoutMs);
}

/**
 * mirror.apply 被动应答器（目标节点侧）：应用器 outcome → mirror.receipt res 信封
 * （id=对账键透传；conflict 附 diffSummary 超集——RpcErrorPayload + diffSummary）。
 * 未知 req 方法回 unknown_method（诚实应答优于静默——hub 侧按 id 结算不悬挂）。
 */
async function handleHubRequest(req: RequestEnvelope): Promise<HubResponderResult> {
  if (req.method === MIRROR_WIRE.apply) {
    const outcome: MirrorApplyOutcome = await applyMirrorSnapshot(req.payload as MirrorApplyPayload);
    if (outcome.ok) {
      return {
        ok: true,
        payload: {
          appliedResources: outcome.appliedResources,
          ...('unresolvedRefs' in outcome ? { unresolvedRefs: outcome.unresolvedRefs } : {}),
        },
      };
    }
    return {
      ok: false,
      payload: {
        code: outcome.code,
        message: outcome.message,
        ...('diffSummary' in outcome && outcome.diffSummary ? { diffSummary: outcome.diffSummary } : {}),
      } satisfies RpcErrorPayload,
    };
  }
  return { ok: false, payload: { code: 'unknown_method', message: `节点不支持的方法: ${req.method}` } satisfies RpcErrorPayload };
}

/**
 * mirror.result（两段式第二段，res 信封定向→本机 leader）→ hub:mirrorResult 推送。
 * 载荷挑字段（ok 成功 {appliedResources, unresolvedRefs?} / 失败 {code, message,
 * diffSummary?}），不透传整个信封防杂字段渗入 renderer 契约——与 presence 桥同款纪律。
 */
function bridgeMirrorResult(res: ResponseEnvelope, broadcast: (channel: string, payload: unknown) => void): void {
  if (res.method !== MIRROR_WIRE.result) return;
  const p = res.payload as {
    mirrorId?: unknown; appliedResources?: unknown; unresolvedRefs?: unknown;
    code?: unknown; message?: unknown; diffSummary?: unknown;
  } | null;
  if (typeof p?.mirrorId !== 'string') return; // 异形结果丢弃（hub 侧契约保证必带）
  if (res.ok) {
    broadcast('hub:mirrorResult', {
      mirrorId: p.mirrorId,
      ok: true,
      appliedResources: Array.isArray(p.appliedResources) ? p.appliedResources : [],
      ...(Array.isArray(p.unresolvedRefs) ? { unresolvedRefs: p.unresolvedRefs } : {}),
    });
    return;
  }
  broadcast('hub:mirrorResult', {
    mirrorId: p.mirrorId,
    ok: false,
    code: typeof p.code === 'string' ? p.code : 'internal',
    message: typeof p.message === 'string' ? p.message : '镜像失败',
    ...(p.diffSummary && typeof p.diffSummary === 'object' ? { diffSummary: p.diffSummary } : {}),
  });
}

function startClient(
  hubUrl: string,
  nodeName: string,
  deviceToken: string,
  nodeId: string | null,
): void {
  client?.stop();
  // 新连接开始 → 上个连接的快照作废（重播不得推陈旧节点）
  presenceSeed = null;
  client = createHubClient({
    url: wsUrlOf(hubUrl),
    nodeName,
    deviceToken,
    onStateChange(state, err) {
      if (err) lastError = err;
      if (state === 'online') lastError = null;
      // 掉线 → 快照过期（断连期间收不到 peer 上下线事件）
      else presenceSeed = null;
      broadcast('hub:stateChanged', { state, lastError });
    },
    onEvent(evt: EventEnvelope) {
      if (evt.method === EVT.nodeOnline) {
        const p = evt.payload as { nodeId: string; nodeName: string };
        broadcast('hub:nodePresence', { kind: 'online', ...p });
        // 种子 upsert——快照是存量面、事件是增量面，两者合成权威在线集合
        // （hello 后上线者入集合，否则重播漏行；本机排除，同捕获点过滤）
        if (presenceSeed && p.nodeId !== nodeId) {
          presenceSeed = [...presenceSeed.filter((n) => n.nodeId !== p.nodeId), { nodeId: p.nodeId, nodeName: p.nodeName }];
        }
      } else if (evt.method === EVT.nodeOffline) {
        const p = evt.payload as { nodeId: string };
        broadcast('hub:nodePresence', { kind: 'offline', ...p });
        // 种子 remove——已下线者不得残留（否则重播推幽灵行）
        if (presenceSeed) presenceSeed = presenceSeed.filter((n) => n.nodeId !== p.nodeId);
      } else if (evt.method === EVT.resourcePublished) {
        // 发布成功广播（spec §3.3/§5）——六字段显式挑出（协议 ResourcePublishedEvent 形状，
        // 不透传整个 payload 防信封杂字段渗入 renderer 契约）
        const p = evt.payload as { slug: string; type: string; name: string; version: string; author: string; at: number };
        broadcast('hub:resourcePublished', {
          slug: p.slug, type: p.type, name: p.name, version: p.version, author: p.author, at: p.at,
        });
      } else if (evt.method === EVT.workspaceMirrored) {
        // 镜像完成组内广播（spec §3.2——组内皆可见谁被镜像到什么版本）
        const p = evt.payload as {
          groupId: string; targetNodeId: string; workspaceName: string;
          snapshotId: string; appliedResources: string[]; unresolvedRefs?: string[];
        };
        broadcast('hub:workspaceMirrored', {
          groupId: p.groupId,
          targetNodeId: p.targetNodeId,
          workspaceName: p.workspaceName,
          snapshotId: p.snapshotId,
          appliedResources: Array.isArray(p.appliedResources) ? p.appliedResources : [],
          ...(Array.isArray(p.unresolvedRefs) ? { unresolvedRefs: p.unresolvedRefs } : {}),
        });
      }
      // 工作组事件桥（M2b）：group.changed → hub:groupChanged（载荷挑字段，见桥内注释）
      bridgeGroupChanged(evt, broadcast);
    },
    // OBS-1：hello 应答里的在线节点快照 → 逐节点播 presence 种子（在线列表初始面）。
    // 本机节点排除——renderer 用状态快照自合成「本机」行，重复播会双行。
    onHelloSnapshot(nodes) {
      presenceSeed = nodes.filter((n) => n.nodeId !== nodeId);
      broadcastPresenceSeed(presenceSeed);
    },
    // 目标节点侧被动应答（M2c 镜像链）：mirror.apply → 应用器 → mirror.receipt
    onRequest: handleHubRequest,
    // leader 侧两段式第二段：mirror.result res 信封 → hub:mirrorResult 推送
    onUnsolicitedRes(res) {
      bridgeMirrorResult(res, broadcast);
    },
  });
  client.start();
}

/** presence 种子播报（在线列表初始面）——节点集合已排除本机。 */
function broadcastPresenceSeed(nodes: Array<{ nodeId: string; nodeName: string }>): void {
  for (const n of nodes) {
    broadcast('hub:nodePresence', { kind: 'online', nodeId: n.nodeId, nodeName: n.nodeName });
  }
}

/**
 * 在线节点快照重播——renderer 拉状态时补发。
 * 消费面已在位（store 先订阅后拉快照），故拉状态即是把存量快照递给晚挂载的面板。
 */
export function replayPresenceSeed(): void {
  if (!presenceSeed) return;
  broadcastPresenceSeed(presenceSeed);
}

/** hubUrl（http/https origin）→ ws/wss URL + /ws 路径。 */
function wsUrlOf(hubUrl: string): string {
  const u = new URL(hubUrl);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  u.pathname = '/ws';
  return u.toString();
}

function normUrl(hubUrl: string): string { return hubUrl.trim().replace(/\/$/, ''); }

/**
 * D2：token 键实例作用域接线（app ready 后、任何 hub 凭证读写前调用一次）。
 * 入参取值而非 app 对象——creds.ts 保持 Electron-free（派生纯函数可测，见
 * deriveDeviceTokenScopeSuffix）。userDataPath 与默认 userData 全路径
 * （<appData>/<app.name>）相等 → 空后缀 = 裸键（单实例向后兼容）；隔离实例
 * → sha256 完整路径前 8 位后缀（同名 basename 不互撞——验收 --user-data-dir 形态）。
 */
export function wireHubCredsScope(userDataPath: string, defaultUserDataPath: string): void {
  setDeviceTokenScopeResolver(() => deriveDeviceTokenScopeSuffix(userDataPath, defaultUserDataPath));
}

/** app ready 后调用：已配置且有凭证则自动连接。 */
export async function initHub(): Promise<void> {
  const cfg = configStore().read();
  if (!cfg) return;
  const token = await getDeviceToken();
  if (!token) { logger.warn('hub 已配置但 keychain 无 device token（跳过连接）'); return; }
  startClient(cfg.hubUrl, cfg.nodeName, token, cfg.nodeId);
}

export async function hubConfigure(input: { hubUrl: string; nodeName: string }): Promise<HubStatus> {
  const store = configStore();
  const prev: HubConfigRow | null = store.read();
  const hubUrl = normUrl(input.hubUrl);
  const nodeName = input.nodeName.trim();
  if (prev && prev.hubUrl !== hubUrl) {
    // 换址 = 换 hub：旧 device token 是旧 hub 签发的，对新 hub 无效——拿它连新 hub
    // 会连出「鉴权失败 + 退避重连」的死循环。故断开旧连接、清凭证、nodeId 归零，
    // 不起新连接（用户必须重新 enroll 才能接入新 hub）。
    // 换址重置陈旧错误——先清 lastError 再停连接（同 hubForget）：
    // client.stop() 会广播 disconnected，lastError 未清则 renderer 收到带历史错误的事件。
    lastError = null;
    client?.stop();
    client = null;
    // 换 hub → 旧 hub 的在线快照作废（重播不得推上个 hub 的节点）
    presenceSeed = null;
    await clearDeviceToken();
    // 下载授权随址收回（F2）：撤旧 hub origin、登新址（下次目录拉取亦会重登，
    // 此处即时生效——避免换址后旧 hub 的 http 下载授权残留）
    unregisterTrustedDownloadOrigin(prev.hubUrl);
    registerTrustedDownloadOrigin(hubUrl);
    store.write({ hubUrl, nodeName, nodeId: null });
    return hubGetStatus();
  }
  // 同址（仅节点名变化）→ 保留 nodeId 与凭证，照旧连接
  store.write({ hubUrl, nodeName, nodeId: prev?.nodeId ?? null });
  await initHub();
  return hubGetStatus();
}

export async function hubEnroll(input: { hubUrl: string; enrollmentToken: string; nodeName: string }): Promise<HubStatus> {
  const hubUrl = normUrl(input.hubUrl);
  const nodeName = input.nodeName.trim();
  const r = await enrollOverHttp(hubUrl, input.enrollmentToken, nodeName);
  await setDeviceToken(r.deviceToken);
  configStore().write({ hubUrl, nodeName, nodeId: r.nodeId });
  startClient(hubUrl, nodeName, r.deviceToken, r.nodeId);
  return hubGetStatus();
}

export async function hubForget(): Promise<void> {
  // 先清 lastError 再停连接——client.stop() 内部会 setState('disconnected') 触发一次
  // 状态广播，若此时 lastError 还是旧值，renderer 会先收到一条带历史错误的
  // disconnected 事件。
  const prev = configStore().read();
  lastError = null;
  client?.stop();
  client = null;
  presenceSeed = null;
  configStore().clear();
  await clearDeviceToken();
  // 下载授权随接入收回（F2）：旧 hub origin 立即撤出 installer 信任集
  if (prev) unregisterTrustedDownloadOrigin(prev.hubUrl);
  broadcast('hub:stateChanged', { state: 'disconnected', lastError: null });
}

/** before-quit 调用。 */
export function stopHub(): void {
  client?.stop();
  client = null;
}
