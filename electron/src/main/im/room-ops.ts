// electron/src/main/im/room-ops.ts
//
// Matrix 房间操作封装：创建/重命名/解散/查成员。
// 解散采用"自适应"语义（v1.1 设计 2.1）：
//   - 全员本地（同 homeserver）→ 全部 bot 离开 + 用户离开 → 0 成员清空
//   - 含远程真人 → 仅用户离开（v1.1 恒为前者，远程检测点留待 v2）
// 团队群（workspace.team_room_id）与系统通知群禁止单独解散。

import { Preset, Visibility } from 'matrix-js-sdk';
import { logger } from '../logger';
import { getOwnerMatrixClient, getCurrentUserId } from '../matrix/session';
import { createMatrixClient } from '../matrix/client';
import { listWorkspaces } from '../workspace/crud';
import { getSecret } from '../storage/keychain';

export interface CreateRoomInput {
  name: string;
  isDirect: boolean;
  inviteUserIds: string[];
}

export interface RoomMemberInfo {
  userId: string;
  displayName: string;
  avatarUrl: string | null;
  powerLevel: number;
  isBot: boolean;
  isLocalUser: boolean;
}

/** 该 roomId 是否为某 workspace 的团队群（受保护，不可单独解散） */
export function isProtectedRoom(roomId: string): boolean {
  return listWorkspaces().some((w) => w.teamRoomId === roomId);
}

export async function createRoom(input: CreateRoomInput): Promise<{ roomId: string }> {
  const client = await getOwnerMatrixClient();
  const resp = await client.createRoom({
    name: input.name,
    preset: input.isDirect ? Preset.TrustedPrivateChat : Preset.PrivateChat,
    visibility: Visibility.Private,
    invite: input.inviteUserIds,
    is_direct: input.isDirect,
  });
  const roomId = (resp as unknown as { room_id: string }).room_id;
  logger.info('房间已创建', { name: input.name, roomId, isDirect: input.isDirect });
  return { roomId };
}

export async function renameRoom(roomId: string, name: string): Promise<void> {
  const client = await getOwnerMatrixClient();
  await client.setRoomName(roomId, name);
  logger.info('房间已重命名', { roomId, name });
}

/**
 * 解散/退出房间。自适应：
 *   全员本地 → 让所有 bot 离开（用各自 token）+ 用户最后离开 → dissolved=true
 *   bot token 缺失 → 降级为仅用户离开 → dissolved=false（提示未完全解散）
 */
export async function dissolveRoom(roomId: string): Promise<{ dissolved: boolean }> {
  if (isProtectedRoom(roomId)) {
    throw new Error('团队群随 workspace 删除，不能单独解散');
  }
  const client = await getOwnerMatrixClient();
  const room = client.getRoom(roomId);
  if (!room) throw new Error(`未找到房间: ${roomId}`);

  const members = room.getJoinedMembers();
  const localUser = getCurrentUserId();
  // bot = 非 local user 的成员（v1.1 全部本地账号）
  const botMembers = members.filter((m) => m.userId !== localUser);

  let allBotsLeft = true;
  for (const bot of botMembers) {
    // 从 keychain 取 bot token 创建临时 client 让其离开
    const token = await getSecret(`bot.${bot.userId}.matrix_token`);
    if (!token) {
      logger.warn('bot token 丢失，跳过让其离开', { userId: bot.userId });
      allBotsLeft = false;
      continue;
    }
    const botClient = createMatrixClient({
      baseUrl: (client as unknown as { baseUrl: string }).baseUrl,
      userId: bot.userId,
      accessToken: token,
    });
    try {
      await botClient.leave(roomId);
    } catch (err) {
      logger.warn('bot 离开房间失败', { userId: bot.userId, err: String(err) });
      allBotsLeft = false;
    }
  }

  // 用户最后离开
  await client.leave(roomId);
  const dissolved = allBotsLeft;
  logger.info('房间已解散/退出', { roomId, dissolved });
  return { dissolved };
}

export async function getRoomMembers(roomId: string): Promise<RoomMemberInfo[]> {
  const client = await getOwnerMatrixClient();
  const room = client.getRoom(roomId);
  if (!room) return [];
  const localUser = getCurrentUserId();
  // SDK 适配：matrix-js-sdk@31 的 RoomMember.getAvatarUrl 签名为
  //   getAvatarUrl(baseUrl, width, height, resizeMethod, allowDefault, allowDirectLinks)
  // 全部 6 个参数必填。brief 原写单参调用（仅 baseUrl）。此处补全缩略图尺寸
  // （64x64 crop）与两个布尔开关（allowDefault=false, allowDirectLinks=false）以通过 strict 类型检查。
  return room.getJoinedMembers().map((m) => ({
    userId: m.userId,
    displayName: m.name || m.userId,
    avatarUrl: m.getAvatarUrl(
      (client as unknown as { getHomeserverUrl: () => string }).getHomeserverUrl(),
      64,
      64,
      'crop',
      false,
      false,
    ) ?? null,
    powerLevel: room.getMember(m.userId)?.powerLevel ?? 0,
    isBot: m.userId !== localUser, // v1.1：非当前用户即 bot
    isLocalUser: m.userId === localUser,
  }));
}
