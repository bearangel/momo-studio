// electron/tests/agent/capability-merger-read.test.ts
//
// P3 Task 6：验证 capability-merger 成为「能力读取」单一 owner ——
//   readAllocationLayer / readAssignmentDeltas 是 spawn-helpers 等能力消费方
//   唯一入口，行为与原模块的 getAllocation / getAssignmentDeltas 完全一致。
//
// 这是搬移锁定测试（relocation lock），不是新增行为。Seed DB 后比对门面与
// 底层函数的输出，确保 facade 是真转发、未引入任何额外过滤/拷贝/副作用。
//
// DB 隔离沿用仓库既定模式（参考 workspace/allocation.test.ts /
// assignment-capabilities-crud.test.ts）：
//   - process.env.AP_USER_DATA_DIR 指向临时目录
//   - runMigrations + closeDb 单例复位
//   - foreign_keys = ON（cascade 依赖此 PRAGMA）

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import {
  readAllocationLayer,
  readAssignmentDeltas,
} from '../../src/main/agent/capability-merger';
import {
  getAllocation,
  addAllocation,
} from '../../src/main/workspace/allocation';
import {
  getAssignmentDeltas,
  setAssignmentDeltas,
} from '../../src/main/agent/assignment-capabilities';

const tmpRoot = path.join(os.tmpdir(), `ap-merger-read-test-${Date.now()}`);

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();

  // 满足外键链：workspaces → agent_definitions → workspace_agent_members
  // （v25 schema：成员制表取代 agent_assignments；v26 起 capabilities FK 指向成员表）
  const db = getDb();
  db.prepare(
    `INSERT INTO workspaces
       (id, name, description, directory_path, git_initialized, owner_id, icon_emoji)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run('ws-1', 'WS', '', '/tmp', 0, '@owner:s', '📁');
  db.prepare(
    `INSERT INTO agent_definitions
       (id, name, slug, version, runtime, system_prompt, default_tools, source, model_name)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run('def-1', 'A', 'a', '1', 'declarative', 'p', '[]', 'custom', 'm');
  db.prepare(
    `INSERT INTO workspace_agent_members
       (instance_id, workspace_id, agent_definition_id, agent_user_id)
     VALUES (?, ?, ?, ?)`,
  ).run('inst-1', 'ws-1', 'def-1', '@bot:s');
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

describe('capability-merger read facade', () => {
  it('readAllocationLayer 返回与 getAllocation 同形（深相等）', () => {
    addAllocation('ws-1', 'tool', 'read_file');
    addAllocation('ws-1', 'mcp', 'filesystem');
    addAllocation('ws-1', 'skill', 'code-review');

    const viaFacade = readAllocationLayer('ws-1');
    const viaDirect = getAllocation('ws-1');

    // 门面与底层完全等价（结构 + 内容）
    expect(viaFacade).toEqual(viaDirect);
    // 同时断言关键字段，避免 toEqual 巧合通过
    expect(viaFacade.workspaceId).toBe('ws-1');
    expect(viaFacade.tools).toEqual(['read_file']);
    expect(viaFacade.mcps).toEqual(['filesystem']);
    expect(viaFacade.skills).toEqual(['code-review']);
  });

  it('readAssignmentDeltas 返回与 getAssignmentDeltas 同形（深相等）', () => {
    setAssignmentDeltas('inst-1', {
      addedTools: ['bash', 'webfetch'],
      removedTools: ['git_commit'],
      addedMcps: ['github'],
      removedMcps: [],
      addedSkills: ['code-review'],
      removedSkills: [],
    });

    const viaFacade = readAssignmentDeltas('inst-1');
    const viaDirect = getAssignmentDeltas('inst-1');

    expect(viaFacade).toEqual(viaDirect);
    expect(viaFacade.addedTools).toEqual(['bash', 'webfetch']);
    expect(viaFacade.removedTools).toEqual(['git_commit']);
    expect(viaFacade.addedMcps).toEqual(['github']);
    expect(viaFacade.addedSkills).toEqual(['code-review']);
  });
});