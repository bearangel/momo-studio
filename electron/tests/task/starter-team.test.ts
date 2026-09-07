// electron/tests/task/starter-team.test.ts
//
// starter 团队分支（spec §5.3）：targetTeamId 任务启动 → 事务内建
// task_execution 会话 + 成员=团队快照展开 + leader is_leader=1 + 转 in_progress。
// seed 直接写 teams / team_members / workspace_agent_members / agent_definitions
// （不走 createTeam 服务——少一层校验依赖）。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { insertTask, getTask } from '../../src/main/storage/tasks/repo';
import { startTask } from '../../src/main/task/starter';
import { listSessionMembers } from '../../src/main/storage/sessions/repo';

const tmpRoot = path.join(os.tmpdir(), `ap-st-team-${Date.now()}-${Math.random().toString(36).slice(2)}`);

function seedTeam(): void {
  const db = getDb();
  db.prepare(`INSERT INTO workspaces (id, name, directory_path, owner_id) VALUES ('ws1', 'T', '/tmp', '@o')`).run();
  // agent_definitions 当前 NOT NULL 列：id, name, slug, version, system_prompt, model_name
  // （migration v3+v13 演变：model_provider 在 v13 已被 DROP；created_at 默认 datetime('now') 可省）
  // 两个成员不能共享 def：workspace_agent_members 在 v25 加了 (workspace_id, agent_definition_id) 唯一索引
  // （去重：同 ws 同 def 保留最早一条）。真实团队里 leader / member 是不同 agent 类型。
  const insDef = db.prepare(
    `INSERT INTO agent_definitions (id, slug, name, version, system_prompt, model_name)
     VALUES (?, ?, ?, '1', 'p', 'm')`,
  );
  insDef.run('def1', 'coder', 'Coder');
  insDef.run('def2', 'reviewer', 'Reviewer');
  // workspace_agent_members 当前 NOT NULL 列：instance_id, workspace_id, agent_definition_id, agent_user_id
  const insMember = db.prepare(
    `INSERT INTO workspace_agent_members (instance_id, workspace_id, agent_definition_id, agent_user_id)
     VALUES (?, 'ws1', ?, ?)`,
  );
  insMember.run('leader1', 'def1', '@leader1:s');
  insMember.run('member1', 'def2', '@member1:s');
  db.prepare(
    `INSERT INTO teams (id, workspace_id, name, icon_emoji, leader_instance_id, created_at)
     VALUES ('team1', 'ws1', '组', '👥', 'leader1', 0)`,
  ).run();
  const insTm = db.prepare(`INSERT INTO team_members (team_id, instance_id, added_at) VALUES ('team1', ?, 0)`);
  insTm.run('leader1');
  insTm.run('member1');
}

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  seedTeam();
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

describe('startTask 团队分支', () => {
  it('团队目标任务 → 新建执行会话（成员快照 + leader 标记）+ 转 in_progress', async () => {
    insertTask({
      workspaceId: 'ws1', title: '团队任务', creatorUserId: 'owner',
      targetTeamId: 'team1', status: 'assigned',
    });
    const result = await startTask('T-001');

    expect(result.createdNewRoom).toBe(true);
    const task = getTask('T-001')!;
    expect(task.status).toBe('in_progress');
    expect(task.executionSessionId).toBe(result.executionSessionId);

    const members = listSessionMembers(result.executionSessionId);
    expect(members).toHaveLength(2);
    const leader = members.find((m) => m.isLeader);
    expect(leader?.instanceId).toBe('leader1'); // leader 标记 = 接待路由依据
  });

  it('团队已解散 → 抛错且任务保持 assigned', async () => {
    getDb().prepare(`DELETE FROM teams WHERE id='team1'`).run();
    insertTask({
      workspaceId: 'ws1', title: '孤儿任务', creatorUserId: 'owner',
      targetTeamId: 'team1', status: 'assigned',
    });
    await expect(startTask('T-001')).rejects.toThrow(/目标团队不存在/);
    expect(getTask('T-001')!.status).toBe('assigned');
  });
});