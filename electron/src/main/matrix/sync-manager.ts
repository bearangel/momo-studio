// electron/src/main/matrix/sync-manager.ts
//
// 主进程管理 Matrix /sync 长连接：
// - 从 DB + keychain 恢复用户会话后创建 Matrix client
// - 启动 /sync，新消息通过 webContents.send('im:message') 推送到 renderer
// - 暴露 sendMessage / getJoinedRooms / getRoomMessages 供 IPC handler 调用
//
// 设计决策：Matrix /sync 在主进程而非 renderer 运行，原因：
// 1. matrix-js-sdk 是 CJS，renderer 是 ESM（会冲突）
// 2. token 在 keychain（仅主进程能访问）
// 3. /sync 是长连接，适合主进程统一管理生命周期
import { ClientEvent, SyncState, type MatrixClient, type MatrixEvent } from 'matrix-js-sdk';
import type { BrowserWindow } from 'electron';
import { logger } from '../logger';
import { createMatrixClient } from './client';
import { startConduit } from '../conduit/manager';
import { getSecret } from '../storage/keychain';
import { getDb } from '../storage/db';
import { getWorkspace } from '../workspace/crud';
import { DISPATCH_EVENT_TYPE, TASK_REPLY_EVENT_TYPE } from '../agent/dispatch';

/** 主进程推送到 renderer 的消息载荷（与 renderer ImMessage 结构一致） */
export interface MatrixMessagePayload {
  eventId: string;
  roomId: string;
  sender: string;
  body: string;
  /** Matrix event type，用于 renderer 区分渲染（普通消息 / dispatch / task_reply） */
  eventType: string;
  /** 原始 event content，dispatch/task_reply 卡片从中读取结构化字段 */
  content: Record<string, unknown>;
  timestamp: number;
}

/** /sync 监听并同步到 renderer 的 event type 白名单 */
const SYNCED_EVENT_TYPES: ReadonlySet<string> = new Set([
  'm.room.message',
  DISPATCH_EVENT_TYPE,
  TASK_REPLY_EVENT_TYPE,
]);

/** 房间摘要（与 renderer ImRoomInfo 结构一致） */
export interface RoomInfoPayload {
  roomId: string;
  name: string;
  isSystem?: boolean;
}

/** DB kv_store 中存储的会话记录（与 authFlows.ts 的 StoredSession 结构一致） */
interface StoredSession {
  userId: string;
  deviceId: string;
}

const CURRENT_USER_KEY = 'current_user_session';

let client: MatrixClient | null = null;
let mainWindow: BrowserWindow | null = null;

/** 由 main/index.ts 在创建主窗口后调用，注册窗口引用用于推送消息 */
export function setMainWindow(win: BrowserWindow | null): void {
  mainWindow = win;
}

/** 返回当前同步中的 Matrix client（未启动 sync 时为 null）。供 room-ops 等需要读取房间状态的模块使用。 */
export function getSyncingClient(): MatrixClient | null {
  return client;
}

/** 从 MatrixEvent 提取消息载荷；非白名单类型或缺 body 字段时返回 null */
function eventToMessage(event: MatrixEvent): MatrixMessagePayload | null {
  const content = event.getContent() as Record<string, unknown> | undefined;
  const body = content?.body;
  if (typeof body !== 'string') return null;
  return {
    eventId: event.getId() ?? '',
    roomId: event.getRoomId() ?? '',
    sender: event.getSender() ?? '',
    body,
    eventType: event.getType(),
    content: content ?? {},
    timestamp: event.getTs() ?? Date.now(),
  };
}

/** 推送单条消息到 renderer（窗口已销毁时静默跳过） */
function pushMessage(msg: MatrixMessagePayload): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('im:message', msg);
}

/** 通知 renderer：agent 运行态变化（启动/停止/自动恢复完成），让其重新同步 running 状态 */
export function broadcastRuntimeChanged(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('agent:runtimeChanged');
}

/**
 * 启动 Matrix /sync。等待初始同步完成（SyncState.Prepared）后注册事件监听。
 * 幂等：若已有 client 在运行则直接返回。
 */
export async function startSync(matrixClient: MatrixClient): Promise<void> {
  if (client) {
    logger.warn('Matrix /sync 已在运行，跳过重复启动');
    return;
  }
  client = matrixClient;

  try {
    await client.startClient({ initialSyncLimit: 50 });
    await waitForPrepared(client);
  } catch (err) {
    client = null;
    logger.error('Matrix /sync 启动失败，已清理 client', { error: (err as Error).message });
    throw err;
  }

  // 注册事件监听：白名单内 event type（m.room.message + dispatch + task_reply）推送到 renderer
  client.on(ClientEvent.Event, (event: MatrixEvent) => {
    if (!SYNCED_EVENT_TYPES.has(event.getType())) return;
    if (event.isRedacted()) return;
    const msg = eventToMessage(event);
    if (msg) pushMessage(msg);
  });

  logger.info('Matrix /sync 已启动，消息将推送到 renderer');
}

/** 等待客户端进入 PREPARED 同步状态（初始 sync 完成） */
function waitForPrepared(c: MatrixClient): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const handler = (state: SyncState, lastState: SyncState | null): void => {
      if (state === SyncState.Prepared) {
        c.off(ClientEvent.Sync, handler);
        resolve();
      } else if (state === SyncState.Error && lastState !== SyncState.Error) {
        c.off(ClientEvent.Sync, handler);
        reject(new Error('Matrix 初始同步失败'));
      }
    };
    c.on(ClientEvent.Sync, handler);
  });
}

/**
 * 从 DB + keychain 恢复会话，创建 Matrix client 并启动 /sync。
 * 由 im:startSync IPC handler 调用（renderer 在登录后触发）。
 */
export async function startSyncFromSession(): Promise<void> {
  if (client) {
    logger.warn('Matrix /sync 已在运行，跳过');
    return;
  }

  const session = readSession();
  if (!session) {
    throw new Error('无活跃会话，请先登录');
  }

  const token = await getSecret(`user.${session.userId}.matrix_token`);
  if (!token) {
    throw new Error('Matrix access token 丢失，请重新登录');
  }

  const { baseUrl } = await startConduit();
  const matrixClient = createMatrixClient({
    baseUrl,
    userId: session.userId,
    accessToken: token,
    deviceId: session.deviceId,
  });

  await startSync(matrixClient);
}

/** 读取 kv_store 中的当前会话记录 */
function readSession(): StoredSession | undefined {
  const row = getDb()
    .prepare('SELECT value FROM kv_store WHERE key = ?')
    .get(CURRENT_USER_KEY) as { value: string } | undefined;
  if (!row) return undefined;
  return JSON.parse(row.value) as StoredSession;
}

/** 发送文本消息到指定 room */
export async function sendMessage(roomId: string, body: string): Promise<void> {
  if (!client) throw new Error('Matrix client 未初始化（sync 未启动）');
  await client.sendEvent(roomId, 'm.room.message', { msgtype: 'm.text', body }, '');
}

export async function sendMessageWithMentions(
  roomId: string,
  body: string,
  mentionedUserIds: string[],
): Promise<void> {
  if (!client) throw new Error('Matrix client 未初始化（sync 未启动）');
  await client.sendEvent(
    roomId,
    'm.room.message',
    {
      msgtype: 'm.text',
      body,
      'm.mentions': { user_ids: mentionedUserIds },
    },
    '',
  );
}

/** 获取已加入的房间列表（含房间名，无名字时回退到 roomId） */
export function getJoinedRooms(): RoomInfoPayload[] {
  if (!client) return [];
  return client.getRooms()
    .filter((room) => {
      const state = room.getMyMembership();
      if (state !== 'join') return false;
      const createEvent = room.currentState.getStateEvents('m.room.create', '');
      const roomType = createEvent?.getContent()?.type as string | undefined;
      return roomType !== 'm.space';
    })
    .map((room) => {
      const name = room.name || room.roomId;
      const isSystem = isSystemRoom(room, name);
      return {
        roomId: room.roomId,
        name: isSystem ? '⚙️ 系统通知' : name,
        isSystem,
      };
    })
    .sort((a, b) => {
      if (a.isSystem && !b.isSystem) return 1;
      if (!a.isSystem && b.isSystem) return -1;
      return 0;
    });
}

/**
 * 获取指定 workspace 范围内的房间：该 workspace 的 Matrix Space 子房间 + 团队群 +
 * 系统通知房间（系统通知对所有 workspace 全局可见）。workspaceId 缺省时返回全部已加入房间。
 */
export function getRoomsForWorkspace(workspaceId?: string): RoomInfoPayload[] {
  if (!client) return [];
  if (!workspaceId) return getJoinedRooms();

  const ws = getWorkspace(workspaceId);
  if (!ws) return [];

  // 收集本 workspace 的 Space 子房间 ID + 团队群
  const allowedRoomIds = new Set<string>();
  const spaceRoom = client.getRoom(ws.matrixSpaceId);
  if (spaceRoom) {
    const childEvents = spaceRoom.currentState.getStateEvents('m.space.child');
    for (const evt of childEvents) {
      const stateKey = evt.getStateKey();
      if (stateKey) allowedRoomIds.add(stateKey);
    }
  }
  if (ws.teamRoomId) allowedRoomIds.add(ws.teamRoomId);

  return client.getRooms()
    .filter((room) => {
      const state = room.getMyMembership();
      if (state !== 'join') return false;
      const createEvent = room.currentState.getStateEvents('m.room.create', '');
      const roomType = createEvent?.getContent()?.type as string | undefined;
      if (roomType === 'm.space') return false;
      const name = room.name || room.roomId;
      // 系统通知房间全局可见；其余房间必须属于本 workspace
      return isSystemRoom(room, name) || allowedRoomIds.has(room.roomId);
    })
    .map((room) => {
      const name = room.name || room.roomId;
      const isSystem = isSystemRoom(room, name);
      return {
        roomId: room.roomId,
        name: isSystem ? '⚙️ 系统通知' : name,
        isSystem,
      };
    })
    .sort((a, b) => {
      if (a.isSystem && !b.isSystem) return 1;
      if (!a.isSystem && b.isSystem) return -1;
      return 0;
    });
}

function isSystemRoom(room: { roomId: string; name: string }, name: string): boolean {
  const lowerName = name.toLowerCase();
  if (lowerName.includes('admin room') || lowerName.includes('server notice')) return true;
  const realRoom = client?.getRoom(room.roomId);
  if (!realRoom) return false;
  const members = realRoom.getJoinedMembers();
  if (members.length === 2) {
    const hasServerBot = members.some((m) => {
      const localpart = ((m.userId ?? '').split(':')[0] ?? '').toLowerCase();
      return localpart === '@conduit' || localpart === '@tuwunel' || localpart === '@notices';
    });
    return hasServerBot;
  }
  return false;
}

/** 获取指定房间的历史消息（默认最近 50 条白名单内 event） */
export function getRoomMessages(roomId: string, limit = 50): MatrixMessagePayload[] {
  if (!client) return [];
  const room = client.getRoom(roomId);
  if (!room) return [];
  const events = room.getLiveTimeline().getEvents();

  // v1.5.7 诊断：用 console.warn 输出到 stdout（确保可见）
  const typeCounts: Record<string, number> = {};
  const senderSet = new Set<string>();
  for (const e of events) {
    const t = e.getType();
    typeCounts[t] = (typeCounts[t] ?? 0) + 1;
    senderSet.add(e.getSender() ?? '?');
  }
  console.warn('[getRoomMessages诊断]', JSON.stringify({
    roomId: roomId.slice(0, 15),
    totalEvents: events.length,
    typeCounts,
    senders: [...senderSet].map((s) => s.slice(0, 15)),
  }));

  return events
    .filter((e) => SYNCED_EVENT_TYPES.has(e.getType()))
    .map(eventToMessage)
    .filter((m): m is MatrixMessagePayload => m !== null)
    .sort((a, b) => {
      // v1.7.3 修复：同一 timestamp（毫秒精度相同）内多条消息排序不稳定，
      // 导致重启 agent 后 /sync 重新构建 timeline 时消息顺序变化。
      // 加 eventId 字典序做稳定二级排序，保证多次拉取顺序一致。
      if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
      return a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0;
    })
    .slice(-limit);
}

/**
 * 向前翻页加载更早的历史消息。
 * matrix-js-sdk 的 paginateEventTimeline 会原地扩展 timeline（向前填充），
 * 多次调用会持续向更早的历史延伸。
 *
 * @param roomId 目标房间
 * @param count 本次请求条数（默认 30，服务端可能返回更多或更少）
 * @returns 新拉到的白名单消息（按时间正序）+ 是否还有更早的历史
 */
export async function loadOlderMessages(
  roomId: string,
  count = 30,
): Promise<{ messages: MatrixMessagePayload[]; hasMore: boolean }> {
  if (!client) return { messages: [], hasMore: false };
  const room = client.getRoom(roomId);
  if (!room) return { messages: [], hasMore: false };
  const timeline = room.getLiveTimeline();
  const beforeCount = timeline.getEvents().length;

  const hasMore = await client.paginateEventTimeline(timeline, { backwards: true, limit: count });
  const afterEvents = timeline.getEvents();
  // timeline 原地扩展：新拉到的历史事件在数组前部，本次新增数量 = afterCount - beforeCount
  const newEventCount = Math.max(0, afterEvents.length - beforeCount);
  const newEvents = afterEvents.slice(0, newEventCount);

  return {
    messages: newEvents
      .filter((e) => SYNCED_EVENT_TYPES.has(e.getType()))
      .map(eventToMessage)
      .filter((m): m is MatrixMessagePayload => m !== null),
    hasMore,
  };
}

/** 停止 /sync 并清理 client 引用 */
export async function stopSync(): Promise<void> {
  if (client) {
    client.stopClient();
    client = null;
    logger.info('Matrix /sync 已停止');
  }
}
