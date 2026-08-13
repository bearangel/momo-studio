// electron/src/main/matrix/room-info.ts
//
// 房间信息查询 helper——给 agent runtime（子进程）提供 isDirectChat / hasCoordinator 计算。
//
// 设计原因：agent runtime 运行在独立子进程中，无直接 DB 访问权限，也无法共享主进程的
// Matrix client 状态。子进程通过 IPC（process.send）向主进程查询这两个值，主进程用此模块
// 的 helper 计算后回包。
//
// 两个 helper 都是纯查询函数，不抛错（room 不存在 / DB 错误时返回安全默认 false）。

import type { MatrixClient } from 'matrix-js-sdk';
import { getDb } from '../storage/db';

/**
 * 判断指定 room 是否是单聊（场景 1.3）。
 *
 * 单聊定义：room 仅有 2 个成员（owner + 1 bot）。此时用户发言即应答，无需 @。
 *
 * 安全默认：room 不存在或成员数 ≠ 2 时返回 false（不误判群组为单聊）。
 *
 * @param client 主进程的 syncing Matrix client（getSyncingClient()）
 * @param roomId 要查询的 Matrix room ID
 * @param ownerUserId workspace owner 的 Matrix userId
 */
export function isDirectChat(
  client: MatrixClient | null,
  roomId: string,
  ownerUserId: string,
): boolean {
  if (!client) return false;
  const room = client.getRoom(roomId);
  if (!room) return false;
  const members = room.getJoinedMembers();
  if (members.length !== 2) return false;
  const ids = members.map((m) => m.userId);
  // 必须包含 owner（防两个 bot 互聊被误判为单聊）
  return ids.includes(ownerUserId);
}

/**
 * 判断指定 workspace 是否已配置协调 agent（场景 1.1 vs 1.2 的分水岭）。
 *
 * 有协调 agent（PM）→ 团队群中 owner 无指名消息由 PM 自动接待。
 * 无协调 agent → 团队群中未 @ 的消息不响应。
 *
 * @param workspaceId workspace UUID
 * @returns true = workspaces.coordinator_instance_id 非空
 *
 * 安全默认：DB 查询异常或 workspace 不存在时返回 false。
 */
export function hasWorkspaceCoordinator(workspaceId: string): boolean {
  try {
    const db = getDb();
    const row = db
      .prepare('SELECT coordinator_instance_id FROM workspaces WHERE id = ?')
      .get(workspaceId) as { coordinator_instance_id: string | null } | undefined;
    return !!row?.coordinator_instance_id;
  } catch {
    // DB 未初始化 / 查询异常——安全默认 false（不触发 PM 自动接待）
    return false;
  }
}
