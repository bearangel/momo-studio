// electron/tests/agent/assignment-capabilities-crud.test.ts
//
// v1.6 Layer 3：per-assignment 能力 delta 的 CRUD 测试。
//   - getAssignmentDeltas：读取某 assignment 的 add/remove delta（无值返回全空对象）
//   - setAssignmentDeltas：全量替换（事务 DELETE + INSERT），幂等
//   - cascade delete：assignment 删除时 delta 经 ON DELETE CASCADE 自动清理
//
// DB 隔离沿用仓库既定模式（参考 016-assignment-capabilities.test.ts / 013 / 015）：
//   - process.env.AP_USER_DATA_DIR 指向临时目录
//   - getDb() 单例 + foreign_keys = ON（cascade 依赖此 PRAGMA）
//   - closeDb() 在 afterEach 复位单例
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import {
  getAssignmentDeltas,
  setAssignmentDeltas,
} from '../../src/main/agent/assignment-capabilities';

const tmpRoot = path.join(os.tmpdir(), `ap-cap-crud-test-${Date.now()}`);

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();

  // 外键依赖：workspaces → agent_definitions → workspace_agent_members
  // （v25 schema：成员制表取代 agent_assignments；v26 起 capabilities FK 指向成员表）
  const db = getDb();
  db.prepare(
    `INSERT INTO workspaces
       (id, name, description, directory_path, git_initialized, owner_id, icon_emoji)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run('ws1', 'WS', '', '/tmp', 0, '@owner:s', '📁');
  db.prepare(
    `INSERT INTO agent_definitions
       (id, name, slug, version, runtime, system_prompt, default_tools, source, model_name)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run('def1', 'A', 'a', '1', 'declarative', 'p', '[]', 'custom', 'm');
  db.prepare(
    `INSERT INTO workspace_agent_members
       (instance_id, workspace_id, agent_definition_id, agent_user_id)
     VALUES (?, ?, ?, ?)`,
  ).run('inst1', 'ws1', 'def1', '@bot:s');
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

describe('assignment-capabilities CRUD', () => {
  it('无 delta 时返回全空对象', () => {
    const d = getAssignmentDeltas('inst1');
    expect(d).toEqual({
      addedTools: [],
      removedTools: [],
      addedMcps: [],
      removedMcps: [],
      addedSkills: [],
      removedSkills: [],
    });
  });

  it('setAssignmentDeltas 全量写入 + get 读回', () => {
    setAssignmentDeltas('inst1', {
      addedTools: ['bash', 'webfetch'],
      removedTools: ['git_commit'],
      addedMcps: ['github'],
      removedMcps: [],
      addedSkills: ['code-review'],
      removedSkills: [],
    });
    const d = getAssignmentDeltas('inst1');
    expect(d.addedTools).toEqual(['bash', 'webfetch']);
    expect(d.removedTools).toEqual(['git_commit']);
    expect(d.addedMcps).toEqual(['github']);
    expect(d.addedSkills).toEqual(['code-review']);
  });

  it('setAssignmentDeltas 全量替换语义（旧值清空）', () => {
    setAssignmentDeltas('inst1', {
      addedTools: ['bash'],
      removedTools: [],
      addedMcps: [],
      removedMcps: [],
      addedSkills: [],
      removedSkills: [],
    });
    setAssignmentDeltas('inst1', {
      addedTools: [],
      removedTools: ['git_commit'],
      addedMcps: [],
      removedMcps: [],
      addedSkills: [],
      removedSkills: [],
    });
    const d = getAssignmentDeltas('inst1');
    expect(d.addedTools).toEqual([]); // bash 被清空
    expect(d.removedTools).toEqual(['git_commit']); // 新值
  });

  it('setAssignmentDeltas 幂等（同值多次保存结果一致）', () => {
    const deltas = {
      addedTools: ['bash'],
      removedTools: [],
      addedMcps: [],
      removedMcps: [],
      addedSkills: [],
      removedSkills: [],
    };
    setAssignmentDeltas('inst1', deltas);
    setAssignmentDeltas('inst1', deltas);
    setAssignmentDeltas('inst1', deltas);
    const d = getAssignmentDeltas('inst1');
    expect(d.addedTools).toEqual(['bash']);
  });

  it('cascade delete：assignment 删除时 delta 自动清理', () => {
    setAssignmentDeltas('inst1', {
      addedTools: ['bash'],
      removedTools: [],
      addedMcps: [],
      removedMcps: [],
      addedSkills: [],
      removedSkills: [],
    });
    // ON DELETE CASCADE（依赖 getDb() 的 foreign_keys = ON）自动清理 delta 行
    getDb().prepare('DELETE FROM workspace_agent_members WHERE instance_id = ?').run('inst1');
    const d = getAssignmentDeltas('inst1');
    expect(d.addedTools).toEqual([]);
  });
});
