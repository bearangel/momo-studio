// electron/tests/agent/tools/session-tools.test.ts
//
// SessionTools.list_sessions 回归锁（spec 2026-09-30 §4.1）：
//   workspace 范围 / 排除当前会话 / 关键词过滤 / 消歧元信息（成员名、消息数、预览）。
// 核心读路径真 SQLite；listMembers（显示名富化）mock 收窄到边界。
//
// seeding 偏离 brief：sessions.workspace_id 外键真实存在（REFERENCES workspaces
// + foreign_keys=ON），按 messages-repo.test.ts Task-1 套件先例补 seed workspaces 行。
// workspace id 用 randomUUID：每个 beforeEach 重建 DB 安全，但跨 it 用 fixed id 仍
// 脆；本次复现 brief 三例，每个 it 内分别 seed 独立 workspace id。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { runMigrations, closeDb, getDb } from '../../../src/main/storage/db';
import { insertSession, addSessionMember } from '../../../src/main/storage/sessions/repo';
import { insertMessage } from '../../../src/main/storage/messages/repo';
import { SessionTools } from '../../../src/main/agent/tools/session-tools';
import type { ToolContext } from '../../../src/main/agent/tools/types';

vi.mock('../../../src/main/agent/crud', () => ({
  listMembers: () => [
    { instanceId: 'inst-coder', agentUserId: 'coder-1', agentName: 'Coder', iconEmoji: null },
    { instanceId: 'inst-writer', agentUserId: 'writer-1', agentName: 'Writer', iconEmoji: null },
  ],
}));

/** 建 workspace 行（sessions FK 兜底；NOT NULL 列全补），返回 id */
function seedWorkspace(): string {
  const id = `ws-${randomUUID()}`;
  getDb()
    .prepare(
      `INSERT INTO workspaces
         (id, name, description, directory_path, git_initialized, owner_id, icon_emoji,
          default_agent_instance_id)
       VALUES (?, 'WS', '', '/tmp', 0, '@owner:s', '📁', null)`,
    )
    .run(id);
  return id;
}

/** 建 agent_definition + workspace_agent_member 行（addSessionMember FK 兜底：
 *  session_members.instance_id → workspace_agent_members.instance_id →
 *  workspaces(id) / agent_definitions(id)）。仅 inst-coder 是被测断言消费的实例
 *  （addSessionMember(ref.id, 'inst-coder', true)）；其它实例（inst-writer）mock
 *  listMembers 返回，不入 DB。 */
function seedMemberInstance(workspaceId: string, instanceId: string, defId: string, agentUserId: string): void {
  getDb()
    .prepare(
      `INSERT INTO agent_definitions
         (id, name, slug, version, system_prompt, model_name, model_provider_id)
       VALUES (?, 'def', 'def', '1', '', 'm', NULL)`,
    )
    .run(defId);
  getDb()
    .prepare(
      `INSERT INTO workspace_agent_members
         (instance_id, workspace_id, agent_definition_id, agent_user_id, last_running)
       VALUES (?, ?, ?, ?, 1)`,
    )
    .run(instanceId, workspaceId, defId, agentUserId);
}

const tmpRoot = path.join(os.tmpdir(), `momo-sess-tools-${Date.now()}`);

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

const mkCtx = (workspaceId: string, roomId: string): ToolContext => ({
  wsFs: {} as never,
  workspaceId,
  workspaceDir: '/tmp/ws',
  skillRegistry: {} as never,
  streamSessionId: 'ss-1',
  roomId,
  sendStreamChunk: () => {},
  permissionConfig: { allowedTools: [], deniedTools: [] },
  creatorUserId: 'owner',
});

describe('list_sessions', () => {
  it('列出本 workspace 会话，排除当前会话，带成员名/消息数/预览', async () => {
    const wsA = seedWorkspace();
    const wsB = seedWorkspace();
    const cur = insertSession({ workspaceId: wsA, title: '当前会话' });
    const ref = insertSession({ workspaceId: wsA, title: '设计讨论' });
    insertSession({ workspaceId: wsB, title: '别家的会话' });
    seedMemberInstance(wsA, 'inst-coder', 'def-coder', 'coder-1');
    addSessionMember(ref.id, 'inst-coder', true);
    insertMessage({ sessionId: ref.id, sender: 'owner', eventType: 'm.room.message', body: '我们讨论一下重构方案' });

    const out = await new SessionTools().execute('list_sessions', {}, mkCtx(wsA, cur.id));

    expect(out).toContain('设计讨论');
    expect(out).toContain('Coder');
    expect(out).toContain('消息数=1');
    expect(out).toContain('我们讨论一下重构方案');
    expect(out).not.toContain('当前会话'); // 排除自身
    expect(out).not.toContain('别家的会话'); // workspace 范围门
    expect(out).toContain(ref.id); // id 必须出现（read_session 直达键）
  });

  it('keyword 标题子串过滤（大小写不敏感）', async () => {
    const wsA = seedWorkspace();
    insertSession({ workspaceId: wsA, title: 'Refactor Plan' });
    insertSession({ workspaceId: wsA, title: '闲聊' });
    const out = await new SessionTools().execute(
      'list_sessions',
      { keyword: 'refactor' },
      mkCtx(wsA, 'room-x'),
    );
    expect(out).toContain('Refactor Plan');
    expect(out).not.toContain('闲聊');
  });

  it('空会话与零命中', async () => {
    const wsA = seedWorkspace();
    const s = insertSession({ workspaceId: wsA, title: '空会话' });
    const out = await new SessionTools().execute('list_sessions', {}, mkCtx(wsA, 'room-x'));
    expect(out).toContain('空会话');
    expect(out).toContain('消息数=0');
    expect(out).toContain(s.id);
    const miss = await new SessionTools().execute(
      'list_sessions',
      { keyword: '不存在的关键词' },
      mkCtx(wsA, 'room-x'),
    );
    expect(miss).toContain('没有匹配的会话');
  });
});