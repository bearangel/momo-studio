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
import type { RoutedEvent } from '../agent/router-service';
import { agentRunners } from '../agent/runtime-registry';
import { resolveMessageTarget, type BotCandidate, type WorkspaceRoutingInfo } from '../agent/message-target-resolver';
import { isDirectChat, hasWorkspaceCoordinator } from './room-info';
import {
  insertMessage,
  getMessageByStreamSessionId,
  type MessageRow,
} from '../storage/messages/repo';

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

/**
 * Agent 最终消息在 Matrix event content 里保留的关联线索（A7 改造后唯一保留的富字段）。
 * sync-manager 据此把 /sync 回声与 routeChunkToBuffer 已落盘的 agent messages 行关联，
 * 避免对同一 agent 消息二次 INSERT（routeChunkToBuffer 不持有 matrix_event_id）。
 */
const STREAM_SESSION_ID_KEY = 'io.momo-studio.stream_session_id';

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

/**
 * task-driven runtime 的 RouterService 引用（由 main/index.ts initTaskDrivenRuntime 注入）。
 * 非空时，/sync 收到的新 event 在 A 子系统 INSERT 之后经此路由到对应 AgentRunner。
 */
let routerService: { routeMatrixEvent: (event: RoutedEvent, ownerUserId: string, targetAssignmentId: string | null, directTargetAssignmentId?: string) => Promise<void> } | null = null;

/** 由 main/index.ts 在 initTaskDrivenRuntime 完成后注入 RouterService */
export function setRouterService(svc: typeof routerService): void {
  routerService = svc;
}

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

/**
 * 推送 SQLite MessageRow 到 renderer（ImMessage 形状）。
 * A final fix（C1+I2）：dispatch/task_reply/远程 m.room.message 落盘后用此通道推送，
 * 字段（id/createdAt/status/...）与 renderer ImMessage 完全对齐，消除旧 MatrixMessagePayload
 * 运行时形状不匹配（id=undefined 导致去重失败、排序错乱）。
 */
function pushMessageRow(msg: MessageRow): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('im:message', msg);
}

/** 当前登录用户的 Matrix user ID（未登录返回 null）。用于在 /sync 回声中识别本地用户消息 */
function getLocalUserId(): string | null {
  return readSession()?.userId ?? null;
}

/**
 * C1 修复：为 m.room.message 解析目标 task-driven agent 的 assignmentId。
 *
 * 遍历 room 中的 task-driven runner（agentRunners），按 botUserId 匹配 room 成员，
 * 然后用 resolveMessageTarget（封装 decideResponse 三种场景）选出应响应的 agent。
 *
 * 主进程有 Matrix client + DB 直连，无需像 runtime-entry 那样走 IPC 查询 room info。
 *
 * @returns 目标 assignmentId；无 agent 应响应时返回 null（RouterService 收到 null 时不派发 m.room.message）
 */
function resolveDirectTargetAssignmentId(event: MatrixEvent): string | null {
  if (!client) return null;
  const roomId = event.getRoomId();
  if (!roomId) return null;

  const room = client.getRoom(roomId);
  if (!room) return null;

  const memberUserIds = new Set(room.getJoinedMembers().map((m) => m.userId));

  // 从 agentRunners 收集 room 中的 task-driven candidate
  const candidates: BotCandidate[] = [];
  let firstWorkspaceId: string | null = null;

  for (const runner of agentRunners.values()) {
    if (!memberUserIds.has(runner.botUserId)) continue;
    if (firstWorkspaceId === null) {
      firstWorkspaceId = runner.workspaceId;
    }
    candidates.push({
      botUserId: runner.botUserId,
      assignmentId: runner.assignmentId,
      workspaceId: runner.workspaceId,
      isCoordinator: false,
    });
  }

  if (candidates.length === 0 || firstWorkspaceId === null) return null;

  const workspace = getWorkspace(firstWorkspaceId);
  if (!workspace) return null;

  for (const c of candidates) {
    c.isCoordinator = workspace.coordinatorInstanceId === c.assignmentId;
  }

  const routingInfo: WorkspaceRoutingInfo = {
    ownerId: workspace.ownerId,
    teamSessionId: workspace.teamSessionId,
    hasCoordinator: hasWorkspaceCoordinator(workspace.id),
  };

  return resolveMessageTarget(
    {
      sender: event.getSender() ?? '',
      roomId,
      content: (event.getContent() as Record<string, unknown>) ?? {},
      isDirectChat: isDirectChat(client, roomId, workspace.ownerId),
      candidates,
    },
    routingInfo,
  );
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

  // 注册事件监听：白名单内 event type（m.room.message + dispatch + task_reply）。
  // 所有消息统一 INSERT SQLite 后再 push MessageRow（ImMessage 形状）。
  // v23：messages.matrix_event_id 列已删除，基于 event id 的幂等去重随之移除；
  // 保留两层去重：
  //   1. m.room.message 且 sender == 本地用户 → 已在 im:send 落盘，跳过（避免本地回声重复）
  //   2. m.room.message 且 content 带 stream_session_id 且对应行已存在 → agent 消息，
  //      routeChunkToBuffer 已落盘，跳过
  // dispatch / task_reply / 远程 m.room.message → INSERT（source='matrix'）+ push。
  client.on(ClientEvent.Event, (event: MatrixEvent) => {
    if (!SYNCED_EVENT_TYPES.has(event.getType())) return;
    if (event.isRedacted()) return;

    const eventType = event.getType();
    const sender = event.getSender() ?? '';
    const roomId = event.getRoomId() ?? '';
    const content = (event.getContent() as Record<string, unknown> | undefined) ?? {};
    const body = typeof content.body === 'string' ? content.body : '';

    if (eventType === 'm.room.message') {
      // 去重层 1：本地用户消息已在 im:send INSERT（source='local'），跳过 /sync 回声
      const localUserId = getLocalUserId();
      if (localUserId && sender === localUserId) return;

      // 去重层 2：agent 消息（content 带 stream_session_id，routeChunkToBuffer 已落盘）
      const ssIdRaw = content[STREAM_SESSION_ID_KEY];
      if (typeof ssIdRaw === 'string' && ssIdRaw !== '') {
        const existing = getMessageByStreamSessionId(ssIdRaw);
        if (existing) return;
      }

      // 缺 body 字段的 m.room.message（与旧 eventToMessage 行为一致）不落盘
      if (body === '') return;
    }

    // dispatch / task_reply / 远程 m.room.message：INSERT + push
    const msg = insertMessage({
      sessionId: roomId,
      sender,
      eventType,
      body,
      source: 'matrix',
    });
    pushMessageRow(msg);

    // task-driven：路由到 RouterService（A 子系统 INSERT 之后）
    // C1 修复：m.room.message 需先解析目标 assignmentId（decideResponse 三场景），
    // 否则 RouterService.routeUserMessage 因 directTargetAssignmentId=null 跳过派发。
    // dispatch / task_reply 的目标由 event content 自解析（dispatch_to / reply_to），不需预解析。
    if (routerService) {
      const localUserId = getLocalUserId();
      const directTarget = eventType === 'm.room.message'
        ? resolveDirectTargetAssignmentId(event)
        : null;
      void routerService.routeMatrixEvent(event, localUserId ?? '', null, directTarget ?? undefined);
    }
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

/**
 * 发送文本消息到指定 room。
 * A final fix（C1）：返回 matrix event_id，供 im:send 回填到 SQLite messages.matrix_event_id
 * （/sync 回声去重 + 导出关联）。
 */
export async function sendMessage(roomId: string, body: string): Promise<{ eventId: string | null }> {
  if (!client) throw new Error('Matrix client 未初始化（sync 未启动）');
  const res = await client.sendEvent(roomId, 'm.room.message', { msgtype: 'm.text', body }, '');
  return { eventId: parseEventId(res) };
}

export async function sendMessageWithMentions(
  roomId: string,
  body: string,
  mentionedUserIds: string[],
): Promise<{ eventId: string | null }> {
  if (!client) throw new Error('Matrix client 未初始化（sync 未启动）');
  const res = await client.sendEvent(
    roomId,
    'm.room.message',
    {
      msgtype: 'm.text',
      body,
      'm.mentions': { user_ids: mentionedUserIds },
    },
    '',
  );
  return { eventId: parseEventId(res) };
}

/** matrix-js-sdk sendEvent 返回值形状不确定（{event_id} 或空），统一提取 event_id */
function parseEventId(res: unknown): string | null {
  if (res && typeof res === 'object' && 'event_id' in res) {
    const id = (res as { event_id: unknown }).event_id;
    return typeof id === 'string' ? id : null;
  }
  return null;
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

  // 收集本 workspace 可见房间：团队会话（v23 过渡：Space 子房间过滤随 matrix_space_id
  // 列删除一并移除，Task 8-11 改为 sessions 表驱动）+ 系统通知房间。
  const allowedRoomIds = new Set<string>();
  if (ws.teamSessionId) allowedRoomIds.add(ws.teamSessionId);

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
