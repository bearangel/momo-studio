// electron/tests/agent/spawn-helpers-sub-filter.test.ts
//
// Task 6：rebuildSubAgents 必须按 lastRunning 过滤 sub。
//
// 背景：rebuildSubAgents 决定 PM agent 的 dispatch:<slug> 工具列表。
// 用户停止某个 sub 后，PM 视角该 sub 完全不存在（LLM 看不到对应工具）。
// 老实现无条件返回所有 parent_instance_id 命中的 subs，包含已停止的，
// 导致 PM dispatch 到不存在的 sub → spawn 失败 / 工具调用失败。
//
// 两个用例：
//   1. 混合状态（2 在线 + 1 离线）→ 仅返回 2 个在线 sub
//   2. 全部离线 → 返回空数组
//
// DB 隔离沿用仓库既定模式（参考 spawn-helpers-tools.test.ts / T2）：
//   - process.env.AP_USER_DATA_DIR 指向临时目录
//   - getDb() 单例 + foreign_keys = ON
//   - closeDb() 在 afterEach 复位单例

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { rebuildSubAgents } from '../../src/main/agent/spawn-helpers';

const tmpRoot = path.join(os.tmpdir(), `ap-spawn-sub-filter-test-${Date.now()}-${process.pid}`);

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();

  const db = getDb();
  // 准备 workspace + main def + 3 个 sub def（其中 2 个 last_running=1）
  const wsId = 'ws-sub-filter';
  // v1.3 后 workspaces 必填 matrix_space_id（NOT NULL，团队群 room ID）
  db.prepare(`INSERT INTO workspaces (id, name, directory_path, matrix_space_id, owner_id) VALUES (?, ?, ?, ?, ?)`)
    .run(wsId, 'test', '/tmp', '!space:localhost', '@owner:localhost');

  // main
  db.prepare(`INSERT INTO agent_definitions (id, name, slug, version, runtime, system_prompt, default_tools, default_mcps, default_skills, source, description, icon_emoji, model_provider_id, model_name, task_driven)
      VALUES (?, ?, ?, ?, 'declarative', '', '[]', '[]', '[]', 'builtin', '', '🤖', NULL, '', 1)`)
    .run('def-main', 'Main', 'main', '1.0.0');
  db.prepare(`INSERT INTO agent_assignments (instance_id, workspace_id, agent_definition_id, bot_matrix_user_id, enabled, last_running, role, parent_instance_id, has_api_key_override)
      VALUES (?, ?, ?, ?, 1, 1, 'main', NULL, 0)`)
    .run('inst-main', wsId, 'def-main', '@main:localhost');

  // 3 subs（2 last_running=1, 1 last_running=0）
  for (const [subId, lastRun] of [['sub-a', 1], ['sub-b', 1], ['sub-c', 0]] as const) {
    db.prepare(`INSERT INTO agent_definitions (id, name, slug, version, runtime, system_prompt, default_tools, default_mcps, default_skills, source, description, icon_emoji, model_provider_id, model_name, task_driven)
        VALUES (?, ?, ?, ?, 'declarative', '', '[]', '[]', '[]', 'builtin', '', '🤖', NULL, '', 1)`)
      .run(`def-${subId}`, subId, subId, '1.0.0');
    db.prepare(`INSERT INTO agent_assignments (instance_id, workspace_id, agent_definition_id, bot_matrix_user_id, enabled, last_running, role, parent_instance_id, has_api_key_override)
        VALUES (?, ?, ?, ?, 1, ?, 'sub', ?, 0)`)
      .run(`inst-${subId}`, wsId, `def-${subId}`, `@${subId}:localhost`, lastRun, 'inst-main');
  }
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

describe('rebuildSubAgents lastRunning 过滤 (Task 6)', () => {
  it('返回 2 个 last_running=1 的 sub（跳过 last_running=0）', () => {
    const subs = rebuildSubAgents('ws-sub-filter', 'inst-main');
    expect(subs).toHaveLength(2);
    const slugs = subs.map((s) => s.slug).sort();
    expect(slugs).toEqual(['sub-a', 'sub-b']);
  });

  it('全部 last_running=0 时返回空数组', () => {
    const db = getDb();
    db.prepare(`UPDATE agent_assignments SET last_running = 0 WHERE workspace_id = ? AND role = 'sub'`).run('ws-sub-filter');
    const subs = rebuildSubAgents('ws-sub-filter', 'inst-main');
    expect(subs).toEqual([]);
  });
});