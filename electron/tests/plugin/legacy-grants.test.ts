// electron/tests/plugin/legacy-grants.test.ts
//
// 存量 skill 授权回填（spec 2026-10-21 §4 修订版）：
//   ① pre-cutoff 插件（installed_at < 截止日）的 skill → 全部 ws 写 skill allocation
//   ② post-cutoff 插件不授（新语义：装即无授权）
//   ③ 幂等重放行数不变
//   ④ missing 态（目录消失）静默跳过
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { closeDb, runMigrations, getDb } from '../../src/main/storage/db';
import { backfillLegacyPluginSkillGrants } from '../../src/main/plugin/legacy-grants';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-lgrant-'));

/** 种 dev 插件：目录 + plugins 行（installedAt 可控） */
function seedPlugin(id: string, installedAt: string, skills: string[]): void {
  const dir = path.join(tmpRoot, `plug-${id}`);
  for (const slug of skills) {
    fs.mkdirSync(path.join(dir, 'skills', slug), { recursive: true });
    fs.writeFileSync(path.join(dir, 'skills', slug, 'SKILL.md'), `# ${slug}\n`);
  }
  fs.writeFileSync(
    path.join(dir, 'momo-plugin.json'),
    JSON.stringify({
      id,
      name: id,
      version: '1.0.0',
      description: '',
      components: skills.length > 0 ? { skills: './skills' } : {},
    }),
  );
  getDb()
    .prepare(
      `INSERT INTO plugins (id, version, manifest_json, state, source, source_path, installed_at)
       VALUES (?, '1.0.0', ?, 'active', 'dev', ?, ?)`,
    )
    .run(id, JSON.stringify({ id, components: skills.length > 0 ? { skills: './skills' } : {} }), dir, installedAt);
}

function seedWorkspace(id: string): void {
  getDb()
    .prepare(`INSERT OR IGNORE INTO workspaces (id, name, directory_path, owner_id) VALUES (?, 'W', '/tmp/x', '@o')`)
    .run(id);
}

function skillRefs(): string[] {
  return (
    getDb()
      .prepare(`SELECT capability_ref FROM workspace_allocations WHERE capability_type='skill'`)
      .all() as Array<{ capability_ref: string }>
  ).map((r) => r.capability_ref);
}

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

describe('backfillLegacyPluginSkillGrants（存量 skill 授权回填）', () => {
  it('① pre-cutoff 授 / ② post-cutoff 不授', () => {
    seedWorkspace('w1');
    seedWorkspace('w2');
    seedPlugin('p-old', '2026-10-01T00:00:00Z', ['sk-old']);
    seedPlugin('p-new', '2026-10-22T00:00:00Z', ['sk-new']);

    backfillLegacyPluginSkillGrants('2026-10-21');

    const refs = skillRefs();
    // pre-cutoff：两个 ws 各一行
    expect(refs.filter((r) => r === 'sk-old')).toHaveLength(2);
    // post-cutoff：零行
    expect(refs).not.toContain('sk-new');
  });

  it('③ 幂等重放行数不变', () => {
    seedWorkspace('w1');
    seedPlugin('p-old', '2026-10-01T00:00:00Z', ['sk-a', 'sk-b']);
    backfillLegacyPluginSkillGrants('2026-10-21');
    const before = skillRefs().length;
    backfillLegacyPluginSkillGrants('2026-10-21');
    expect(skillRefs().length).toBe(before);
  });

  it('④ missing 态（目录消失）静默跳过', () => {
    seedWorkspace('w1');
    seedPlugin('p-gone', '2026-10-01T00:00:00Z', ['sk-gone']);
    fs.rmSync(path.join(tmpRoot, 'plug-p-gone'), { recursive: true, force: true });
    expect(() => backfillLegacyPluginSkillGrants('2026-10-21')).not.toThrow();
    expect(skillRefs()).not.toContain('sk-gone');
  });
});
