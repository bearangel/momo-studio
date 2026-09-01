// removeAgentMember（IPC 编排层）：removeMember 守卫/删除 + 收尾副作用
//
// v25 Task 3：编排顺序——removeMember（leader 守卫 + 事务删除）先行，
// blocked 时零副作用直接返回；成功后销毁 runtime + 清 keychain override。
// DB 层语义（级联 / default 置空）由 membership-crud.test.ts 覆盖，
// 此处只锁编排契约：blocked 不动 runtime/keychain，成功全清理。
//
// 保真度（momo-test-rules）：DB 真实迁移链；keychain 经 setKeychainImpl
// 注入内存实现（OS 边界）；runtime-registry 为进程边界 mock。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const mocks = vi.hoisted(() => ({
  stopAgentMock: vi.fn(async () => undefined),
}));

vi.mock('../../src/main/agent/runtime-registry', () => ({
  startAgentRuntime: vi.fn(),
  stopAgentRuntime: mocks.stopAgentMock,
}));
vi.mock('../../src/main/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { setKeychainImpl } from '../../src/main/storage/keychain';
import { removeAgentMember } from '../../src/main/agent/ipc.handlers';

const tmpRoot = path.join(os.tmpdir(), `ap-remove-assignment-${Date.now()}`);
const fakeKeychain = new Map<string, string>();

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  fakeKeychain.clear();
  setKeychainImpl({
    setSecret: async (key, value) => {
      fakeKeychain.set(key, value);
    },
    getSecret: async (key) => fakeKeychain.get(key) ?? null,
    deleteSecret: async (key) => {
      fakeKeychain.delete(key);
    },
  });
  mocks.stopAgentMock.mockClear();

  const db = getDb();
  db.prepare(
    `INSERT INTO workspaces
       (id, name, description, directory_path, git_initialized, owner_id, icon_emoji)
     VALUES ('ws1', 'WS', '', '/tmp', 0, '@owner:s', '📁')`,
  ).run();
  for (const [defId, slug] of [['def1', 'a'], ['def2', 'b']] as const) {
    db.prepare(
      `INSERT INTO agent_definitions
         (id, name, slug, version, system_prompt, model_name)
       VALUES (?, ?, ?, '1', 'p', 'm')`,
    ).run(defId, defId.toUpperCase(), slug);
  }
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

/** 裸 SQL 插成员行（可带 override 标志 + 预置 keychain secret） */
function insertMember(instanceId: string, defId: string, withOverride = false): void {
  getDb()
    .prepare(
      `INSERT INTO workspace_agent_members
         (instance_id, workspace_id, agent_definition_id, agent_user_id, api_key_override)
       VALUES (?, 'ws1', ?, ?, ?)`,
    )
    .run(instanceId, defId, `@${instanceId}:s`, withOverride ? 1 : 0);
  if (withOverride) {
    fakeKeychain.set(`agent.${instanceId}.api_key_override`, 'sk-old');
  }
}

describe('removeAgentMember（v25 编排契约）', () => {
  it('leader 守卫命中：返回 blockedTeams，零副作用（行保留 / 不停 runtime / 不清 keychain）', async () => {
    insertMember('leader-1', 'def1', true);
    insertMember('member-1', 'def2');
    getDb()
      .prepare(
        `INSERT INTO teams (id, workspace_id, name, leader_instance_id)
         VALUES ('team-1', 'ws1', '攻坚组', 'leader-1')`,
      )
      .run();
    getDb()
      .prepare('INSERT INTO team_members (team_id, instance_id, added_at) VALUES (?, ?, 1)')
      .run('team-1', 'leader-1');

    const result = await removeAgentMember('leader-1');

    expect(result).toEqual({ ok: false, blockedTeams: ['攻坚组'] });
    // 零破坏：成员行与 override secret 原样保留，runtime 未被停止
    expect(
      getDb().prepare('SELECT * FROM workspace_agent_members WHERE instance_id = ?').get('leader-1'),
    ).toBeTruthy();
    expect(fakeKeychain.get('agent.leader-1.api_key_override')).toBe('sk-old');
    expect(mocks.stopAgentMock).not.toHaveBeenCalled();
  });

  it('非 leader 成功：行删除 + runtime 停止 + override keychain 清理', async () => {
    insertMember('member-2', 'def2', true);

    const result = await removeAgentMember('member-2');

    expect(result).toEqual({ ok: true });
    expect(
      getDb().prepare('SELECT * FROM workspace_agent_members WHERE instance_id = ?').get('member-2'),
    ).toBeUndefined();
    expect(mocks.stopAgentMock).toHaveBeenCalledWith('member-2');
    expect(fakeKeychain.has('agent.member-2.api_key_override')).toBe(false);
  });

  it('不存在的 instanceId：幂等返回 ok（沿用旧语义）', async () => {
    const result = await removeAgentMember('nonexistent-inst');
    expect(result).toEqual({ ok: true });
  });

  it('被删实例是默认会话 agent：workspaces.default_agent_instance_id 联动置空', async () => {
    insertMember('default-1', 'def1');
    getDb()
      .prepare('UPDATE workspaces SET default_agent_instance_id = ? WHERE id = ?')
      .run('default-1', 'ws1');

    const result = await removeAgentMember('default-1');

    expect(result).toEqual({ ok: true });
    const ws = getDb()
      .prepare('SELECT default_agent_instance_id FROM workspaces WHERE id = ?')
      .get('ws1') as { default_agent_instance_id: string | null };
    expect(ws.default_agent_instance_id).toBeNull();
  });
});
