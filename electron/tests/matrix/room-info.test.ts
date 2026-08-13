// electron/tests/matrix/room-info.test.ts
//
// room-info.ts helper 测试——isDirectChat + hasWorkspaceCoordinator。
// isDirectChat 用桩 MatrixClient 测；hasWorkspaceCoordinator 用真实临时 DB 测。

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { getDb, runMigrations, closeDb } from '../../src/main/storage/db';
import {
  isDirectChat,
  hasWorkspaceCoordinator,
} from '../../src/main/matrix/room-info';
import type { MatrixClient, Room, RoomMember } from 'matrix-js-sdk';

const tmpRoot = path.join(os.tmpdir(), `momo-roominfo-${Date.now()}-${process.pid}`);

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

/** 构造一个桩 Room，控制 getJoinedMembers 返回值 */
function makeRoom(memberIds: string[]): Room {
  const members: RoomMember[] = memberIds.map((id) => ({ userId: id }) as RoomMember);
  return {
    getJoinedMembers: () => members,
  } as unknown as Room;
}

/** 构造桩 MatrixClient，getRoom 返回指定 room（或 undefined） */
function makeClient(room: Room | undefined): MatrixClient {
  return {
    getRoom: () => room,
  } as unknown as MatrixClient;
}

describe('isDirectChat', () => {
  it('client 为 null → false', () => {
    expect(isDirectChat(null, '!room:localhost', '@owner:localhost')).toBe(false);
  });

  it('room 不存在 → false', () => {
    const client = makeClient(undefined);
    expect(isDirectChat(client, '!room:localhost', '@owner:localhost')).toBe(false);
  });

  it('成员数 ≠ 2 → false（群组）', () => {
    const client = makeClient(
      makeRoom(['@owner:localhost', '@bot1:localhost', '@bot2:localhost']),
    );
    expect(isDirectChat(client, '!room:localhost', '@owner:localhost')).toBe(false);
  });

  it('成员数 = 1 → false', () => {
    const client = makeClient(makeRoom(['@owner:localhost']));
    expect(isDirectChat(client, '!room:localhost', '@owner:localhost')).toBe(false);
  });

  it('2 成员 + 含 owner → true（单聊场景 1.3）', () => {
    const client = makeClient(makeRoom(['@owner:localhost', '@bot:localhost']));
    expect(isDirectChat(client, '!room:localhost', '@owner:localhost')).toBe(true);
  });

  it('2 成员但不含 owner → false（防两个 bot 互聊误判）', () => {
    const client = makeClient(makeRoom(['@bot1:localhost', '@bot2:localhost']));
    expect(isDirectChat(client, '!room:localhost', '@owner:localhost')).toBe(false);
  });
});

describe('hasWorkspaceCoordinator', () => {
  function insertWorkspace(
    id: string,
    coordinatorInstanceId: string | null,
  ): void {
    const db = getDb();
    runMigrations();
    db.prepare(
      `INSERT INTO workspaces
         (id, name, description, directory_path, matrix_space_id, git_initialized, owner_id, icon_emoji, coordinator_instance_id)
       VALUES (?, ?, '', '', '', 0, '', '📁', ?)`,
    ).run(id, `ws-${id}`, coordinatorInstanceId);
  }

  it('workspace 不存在 → false', () => {
    expect(hasWorkspaceCoordinator('nonexistent')).toBe(false);
  });

  it('coordinator_instance_id 为 NULL → false（场景 1.2 无 PM）', () => {
    insertWorkspace('ws-no-pm', null);
    expect(hasWorkspaceCoordinator('ws-no-pm')).toBe(false);
  });

  it('coordinator_instance_id 为空字符串 → false', () => {
    insertWorkspace('ws-empty', '');
    expect(hasWorkspaceCoordinator('ws-empty')).toBe(false);
  });

  it('coordinator_instance_id 非空 → true（场景 1.1 有 PM）', () => {
    insertWorkspace('ws-has-pm', 'instance-uuid-123');
    expect(hasWorkspaceCoordinator('ws-has-pm')).toBe(true);
  });
});
