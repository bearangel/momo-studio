// electron/tests/im/collab-members-target.test.ts
//
// CollabTarget 第三态 `members`（spec 2026-10-22 §5.1/§5.2）——建会临时组队。
// 覆盖：
//   - 多成员：leader 落 is_leader=1 / 其余 0；重复 instanceId 静默去重；session_type='collab'
//   - 单成员：等价旧 `agent` 形态（唯一成员即 leader）
//   - 三非法输入 → 字节级中文错误（空列表 / leader 越集 / 跨 ws 或不存在）
//   - 旧形态回归：`agent` 单选仍可用且 session_type='collab'
// team 分支（快照展开 / 快照铁律）由既有 session-ops.test.ts
// 「团队目标：快照展开全部成员…」「快照铁律：建会后团队换 leader / 加成员…」覆盖，
// 此处不重复造 teams 夹具。
//
// DB 隔离沿用 session-ops.test.ts 模式：AP_USER_DATA_DIR 指向临时目录 +
// runMigrations() + afterEach closeDb/删目录（库文件必须逐例重置，否则二次
// 建 workspaces 行撞 UNIQUE）。断言走生产读路径（getSession / listSessionMembers）。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { createCollabSession } from '../../src/main/im/session-ops';
import { getSession, listSessionMembers } from '../../src/main/storage/sessions/repo';

const tmpRoot = path.join(os.tmpdir(), `ap-collab-members-${Date.now()}`);
const WS = 'ws-c';
const INST_A = 'inst-a';
const INST_B = 'inst-b';

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  const db = getDb();
  db.prepare(
    `INSERT INTO workspaces (id, name, directory_path, git_initialized, owner_id)
     VALUES (?, 'ws', '/tmp/ws', 0, 'u1')`,
  ).run(WS);
  // v25 约束：同 ws 同 def 唯一（idx_wam_unique）→ 两成员各用不同 def
  for (const [i, defId] of ['def-a', 'def-b'].entries()) {
    db.prepare(
      `INSERT INTO agent_definitions
        (id, name, slug, version, runtime, system_prompt, default_tools, default_mcps,
         default_skills, source, description, icon_emoji, model_provider_id, model_name,
         task_driven, created_at)
       VALUES (?, ?, ?, '1.0.0', 'declarative', 'p', '[]', '[]', '[]', 'custom', '', '🤖', NULL, 'm', 1, ?)`,
    ).run(defId, `d${i}`, `d-${i}`, Date.now());
    db.prepare(
      `INSERT INTO workspace_agent_members
        (instance_id, workspace_id, agent_definition_id, agent_user_id, api_key_override,
         last_running, created_at)
       VALUES (?, ?, ?, ?, 0, 0, 1)`,
    ).run(i === 0 ? INST_A : INST_B, WS, defId, `au-${i}`);
  }
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

describe('createCollabSession members 形态（spec §5.2）', () => {
  it('多成员：leader 落 is_leader=1 其余 0；session_type=collab；重复 id 静默去重', () => {
    const s = createCollabSession(WS, null, {
      type: 'members',
      instanceIds: [INST_A, INST_B, INST_A],
      leaderInstanceId: INST_B,
    });
    const members = listSessionMembers(s.id);
    expect(members).toHaveLength(2);
    expect(members.find((m) => m.instanceId === INST_B)!.isLeader).toBe(true);
    expect(members.find((m) => m.instanceId === INST_A)!.isLeader).toBe(false);
    expect(getSession(s.id)!.sessionType).toBe('collab');
  });

  it('单成员：等价旧 agent 形态（唯一成员即 leader）', () => {
    const s = createCollabSession(WS, null, {
      type: 'members',
      instanceIds: [INST_A],
      leaderInstanceId: INST_A,
    });
    expect(listSessionMembers(s.id)).toHaveLength(1);
    expect(listSessionMembers(s.id)[0]!.isLeader).toBe(true);
  });

  it('非法输入三连（Review Focus #3）：空 / leader 越集 / 跨 ws 成员 → 中文错误', () => {
    // 空列表：去重后仍为空 → 「不能为空」而非「leader 越集」
    expect(() =>
      createCollabSession(WS, null, { type: 'members', instanceIds: [], leaderInstanceId: INST_A }),
    ).toThrow('会话目标不能为空：请至少选择一个 agent');
    // leader 不在成员集
    expect(() =>
      createCollabSession(WS, null, { type: 'members', instanceIds: [INST_A], leaderInstanceId: INST_B }),
    ).toThrow('主 agent 必须是所选成员之一');
    // 成员不存在 / 不属于当前 ws → 报第一个非法 id
    expect(() =>
      createCollabSession(WS, null, {
        type: 'members',
        instanceIds: [INST_A, 'inst-x'],
        leaderInstanceId: INST_A,
      }),
    ).toThrow('成员不存在或不属于当前工作空间：inst-x');
    // 三次非法输入零建会副作用
    expect(getDb().prepare('SELECT id FROM sessions').all()).toEqual([]);
  });

  it('旧形态回归：agent 单选仍可用且 session_type=collab', () => {
    const a = createCollabSession(WS, null, { type: 'agent', instanceId: INST_A });
    expect(getSession(a.id)!.sessionType).toBe('collab');
    expect(listSessionMembers(a.id)[0]!.isLeader).toBe(true);
  });
});