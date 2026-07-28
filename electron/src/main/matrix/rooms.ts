// electron/src/main/matrix/rooms.ts
//
// Matrix 房间操作工具函数。Space 是 Matrix 中一种特殊的 room
// （creation_content.type = "m.space"），用于把多个子 room 组织成一个
// 逻辑分组。本模块负责创建 Space 以及把普通 room 挂到某个 Space 下。
import type { MatrixClient } from 'matrix-js-sdk';
import { Preset, Visibility } from 'matrix-js-sdk';
import { logger } from '../logger';

/** 创建 Matrix Space（一种特殊的 room，type = m.space） */
export async function createMatrixSpace(
  client: MatrixClient,
  name: string,
): Promise<string> {
  const response: unknown = await client.createRoom({
    name,
    preset: Preset.PrivateChat,
    visibility: Visibility.Private,
    creation_content: { type: 'm.space' },
    invite: [],
  });
  const roomId = (response as { room_id: string }).room_id;
  logger.info('Matrix Space 已创建', { name, roomId });
  return roomId;
}

/** 创建普通 room 并加入指定 Space */
export async function createRoomInSpace(
  client: MatrixClient,
  spaceId: string,
  name: string,
): Promise<string> {
  const response: unknown = await client.createRoom({
    name,
    preset: Preset.PrivateChat,
    visibility: Visibility.Private,
    invite: [],
  });
  const roomId = (response as { room_id: string }).room_id;

  // 把 room 加入 Space：发 m.space.child state event。
  // 注意 sendStateEvent 参数顺序为 (roomId, eventType, content, stateKey)，
  // content 是 { via }，stateKey 是子 room id。
  await client.sendStateEvent(
    spaceId,
    'm.space.child',
    { via: [client.getDomain() ?? 'localhost'] },
    roomId,
  );
  logger.info('Room 已创建并加入 Space', { name, roomId, spaceId });
  return roomId;
}

/**
 * 邀请用户（通常是 agent bot）加入指定 room。
 * bot 账号必须先被邀请、再 accept 后才能读取/发送 room 内的消息。
 * 调用方需保证 client 已具备该 room 的邀请权限（通常是 room 创建者/owner）。
 */
export async function inviteBotToRoom(
  client: MatrixClient,
  roomId: string,
  botUserId: string,
): Promise<void> {
  await client.invite(roomId, botUserId);
  logger.info('已邀请用户加入 room', { roomId, botUserId });
}
