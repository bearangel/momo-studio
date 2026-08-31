// electron/tests/workspace/default-agent.test.ts
//
// 默认会话 agent 服务（spec §4.3 — v25）：
//   setDefaultAgent(workspaceId, instanceId | null): void
//     - 设置：写入 workspaces.default_agent_instance_id，getWorkspace 同步返回
//     - 校验：instanceId 必须是 workspace_agent_members 中属于该 ws 的成员；否则 throw
//     - null：清空（保留列默认 NULL 语义）
//     - 移除联动：T3 removeMember 删除事务内已锁「命中 default → 置 NULL」，
//       本 task 不重复锁定（详见 membership-crud.test.ts 的 default 置 NULL 用例）。
//
// 夹具沿用 T3 真实 addMember 造成员（业务逻辑真实实现，零 mock），
// keychain 注入内存实现（OS 边界替身；momo-test-rules：只 mock 进程/网络边界）。
// DB 隔离：AP_USER_DATA_DIR + runMigrations() 真实迁移链（v25）+
// closeDb() afterEach 复位单例；foreign_keys = ON（FK 约束必需）。

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { setKeychainImpl } from '../../src/main/storage/keychain';
import {
  createWorkspace,
  getWorkspace,
  setDefaultAgent,
} from '../../src/main/workspace/crud';
import { addMember, removeMember } from '../../src/main/agent/crud';

const tmpRoot = path.join(os.tmpdir(), `ap-default-agent-${Date.now()}`);

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  setKeychainImpl({
    setSecret: async () => undefined,
    getSecret: async () => null,
    deleteSecret: async () => undefined,
  });
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

/** 裸 SQL 插一个 agent_definition 行（addMember 必需存在该 def） */
function rawInsertDef(defId: string, slug: string): void {
  getDb()
    .prepare(
      `INSERT INTO agent_definitions
         (id, name, slug, version, system_prompt, model_name)
       VALUES (?, ?, ?, '1', 'p', 'm')`,
    )
    .run(defId, defId.toUpperCase(), slug);
}

describe('setDefaultAgent — 默认会话 agent（spec §4.3）', () => {
  it('设置后 getWorkspace 返回该 instanceId', async () => {
    const ws = await createWorkspace(
      { name: 'WS一', description: '', iconEmoji: '📁', directoryPath: path.join(tmpRoot, 'ws1') },
      'owner',
    );
    rawInsertDef('def1', 'd1');
    const member = await addMember(ws.id, 'def1', 'agent-a-x1');

    setDefaultAgent(ws.id, member.instanceId);

    expect(getWorkspace(ws.id)?.defaultAgentInstanceId).toBe(member.instanceId);
  });

  it('跨 ws 成员 throw：写入零副作用（落库仍为 NULL）', async () => {
    const ws1 = await createWorkspace(
      { name: 'WS一', description: '', iconEmoji: '📁', directoryPath: path.join(tmpRoot, 'ws1') },
      'owner',
    );
    const ws2 = await createWorkspace(
      { name: 'WS二', description: '', iconEmoji: '📁', directoryPath: path.join(tmpRoot, 'ws2') },
      'owner',
    );
    rawInsertDef('def1', 'd1');
    // 同一个 def 在两个 ws 都允许（per-ws 唯一性）——这里跨 ws 引用更真切
    const ws2Member = await addMember(ws2.id, 'def1', 'agent-a-x1');

    expect(() => setDefaultAgent(ws1.id, ws2Member.instanceId)).toThrow();

    // 写入零副作用：ws1.default_agent_instance_id 仍为 NULL
    expect(getWorkspace(ws1.id)?.defaultAgentInstanceId).toBeNull();
    // ws2 也不被波及
    expect(getWorkspace(ws2.id)?.defaultAgentInstanceId).toBeNull();
  });

  it('null 清除已设置的值', async () => {
    const ws = await createWorkspace(
      { name: 'WS一', description: '', iconEmoji: '📁', directoryPath: path.join(tmpRoot, 'ws1') },
      'owner',
    );
    rawInsertDef('def1', 'd1');
    const member = await addMember(ws.id, 'def1', 'agent-a-x1');

    setDefaultAgent(ws.id, member.instanceId);
    expect(getWorkspace(ws.id)?.defaultAgentInstanceId).toBe(member.instanceId);

    setDefaultAgent(ws.id, null);
    expect(getWorkspace(ws.id)?.defaultAgentInstanceId).toBeNull();

    // 清除是 DB 落地（不是缓存假象）：裸查 workspaces 表断言同源
    const row = getDb()
      .prepare('SELECT default_agent_instance_id FROM workspaces WHERE id = ?')
      .get(ws.id) as { default_agent_instance_id: string | null };
    expect(row.default_agent_instance_id).toBeNull();
  });

  it('传不存在的 instanceId throw：写入零副作用', async () => {
    const ws = await createWorkspace(
      { name: 'WS一', description: '', iconEmoji: '📁', directoryPath: path.join(tmpRoot, 'ws1') },
      'owner',
    );

    expect(() => setDefaultAgent(ws.id, 'nonexistent-instance')).toThrow();
    expect(getWorkspace(ws.id)?.defaultAgentInstanceId).toBeNull();
  });

  it('移除成员时联动置 NULL（T3 已锁；本 task 不重复断言，仅引用回归存在性）', async () => {
    const ws = await createWorkspace(
      { name: 'WS一', description: '', iconEmoji: '📁', directoryPath: path.join(tmpRoot, 'ws1') },
      'owner',
    );
    rawInsertDef('def1', 'd1');
    const member = await addMember(ws.id, 'def1', 'agent-a-x1');

    setDefaultAgent(ws.id, member.instanceId);
    expect(getWorkspace(ws.id)?.defaultAgentInstanceId).toBe(member.instanceId);

    // 移除该成员（裸 leader 检查为零，非 leader 路径直接 ok）；联动置 NULL
    expect(removeMember(member.instanceId)).toEqual({ ok: true });
    expect(getWorkspace(ws.id)?.defaultAgentInstanceId).toBeNull();
  });
});
