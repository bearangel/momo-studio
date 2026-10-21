// electron/tests/plugin/uninstall-grants.test.ts
//
// 卸载级联清授权（spec 2026-10-21 §8）：addedPluginTools 前缀/组模式行、
// skill 精确授权行、skill allocation 行一并清除——防同 id 重装冒用继承
// （与引擎整合终审 I2「敏感键随数据删」同判）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { installPluginDevDir, uninstallPlugin } from '../../src/main/plugin/installer';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-ugrant-'));

function mkPlugin(): string {
  const dir = path.join(tmpRoot, 'plug-ug');
  fs.mkdirSync(path.join(dir, 'skills', 'ug-skill'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'skills', 'ug-skill', 'SKILL.md'), '# ug-skill\n');
  fs.writeFileSync(
    path.join(dir, 'momo-plugin.json'),
    JSON.stringify({
      id: 'ug', name: 'UG', version: '1.0.0', description: '',
      components: { skills: './skills' },
    }),
  );
  return dir;
}

function seedGrantRows(): void {
  const db = getDb();
  // 成员 + def（授权行挂成员）
  db.prepare(
    `INSERT INTO workspaces (id, name, directory_path, owner_id) VALUES ('w1', 'W', '/tmp/x', '@o')`,
  ).run();
  db.prepare(
    `INSERT INTO agent_definitions (id, name, slug, version, runtime, system_prompt, default_tools, default_mcps, default_skills, source, description, icon_emoji, model_provider_id, model_name, task_driven)
     VALUES ('d1', 'D', 'd', '1', 'declarative', 'p', '[]', '[]', '[]', 'custom', '', '🤖', 'pid', 'm', 1)`,
  ).run();
  db.prepare(
    `INSERT INTO workspace_agent_members (instance_id, workspace_id, agent_definition_id, agent_user_id, last_running, created_at)
     VALUES ('i1', 'w1', 'd1', '@a:home', 0, datetime('now'))`,
  ).run();
  const ins = db.prepare(
    `INSERT INTO agent_assignment_capabilities (assignment_id, capability_type, mode, ref) VALUES ('i1', ?, 'add', ?)`,
  );
  ins.run('plugin_tool', 'plugin:ug/thing');
  ins.run('plugin_tool', 'plugin:ug/*');
  ins.run('skill', 'ug-skill');
  // 别插件的行（不受牵连）
  ins.run('plugin_tool', 'plugin:other/x');
  ins.run('skill', 'other-skill');
  // ws 级 skill allocation
  db.prepare(
    `INSERT INTO workspace_allocations (workspace_id, capability_type, capability_ref) VALUES ('w1', 'skill', 'ug-skill')`,
  ).run();
  db.prepare(
    `INSERT INTO workspace_allocations (workspace_id, capability_type, capability_ref) VALUES ('w1', 'skill', 'other-skill')`,
  ).run();
}

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  seedGrantRows();
});
afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

describe('卸载级联清授权（spec §8）', () => {
  it('本插件授权行清除；他插件行不受牵连', () => {
    installPluginDevDir(mkPlugin(), '2.1.0', 'w1');
    uninstallPlugin('ug', true);
    const db = getDb();
    const rows = db
      .prepare(`SELECT capability_type, ref FROM agent_assignment_capabilities`)
      .all() as Array<{ capability_type: string; ref: string }>;
    expect(rows).toEqual([
      { capability_type: 'plugin_tool', ref: 'plugin:other/x' },
      { capability_type: 'skill', ref: 'other-skill' },
    ]);
    const allocs = db
      .prepare(`SELECT capability_ref FROM workspace_allocations WHERE capability_type='skill'`)
      .all() as Array<{ capability_ref: string }>;
    expect(allocs).toEqual([{ capability_ref: 'other-skill' }]);
  });
});
