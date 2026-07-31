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
  return events
    .filter((e) => SYNCED_EVENT_TYPES.has(e.getType()))
    .map(eventToMessage)
    .filter((m): m is MatrixMessagePayload => m !== null)
    .slice(-limit);
}

/** 停止 /sync 并清理 client 引用 */
export async function stopSync(): Promise<void> {
  if (client) {
    client.stopClient();
    client = null;
    logger.info('Matrix /sync 已停止');
  }
}
