// electron/tests/plugin/plugin-skill-resource.test.ts
//
// 插件 skills 可见性（D2 skill 面补齐）RED：
//   ① manifest 声明 skills 组件 → buildPluginSkillRefs 产出 refs（agent 装配链）
//   ② 资源面扩列：listCustomResources 含 source='plugin' 的 skill（不可手动删）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { closeDb, runMigrations, getDb } from '../../src/main/storage/db';
import { installPluginDevDir } from '../../src/main/plugin/installer';
import { buildPluginSkillRefs } from '../../src/main/plugin/assembly';
import { listCustomResources } from '../../src/main/resource/custom';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-pskill-'));

function mkDevPlugin(): string {
  const devDir = path.join(tmpRoot, 'skill-plugin');
  fs.mkdirSync(path.join(devDir, 'skills', 'codegraph-usage'), { recursive: true });
  fs.writeFileSync(
    path.join(devDir, 'skills', 'codegraph-usage', 'SKILL.md'),
    '# codegraph-usage\n教 agent 用 codegraph explore\n',
  );
  fs.writeFileSync(
    path.join(devDir, 'momo-plugin.json'),
    JSON.stringify({
      id: 'cgs',
      name: 'S',
      version: '1.0.0',
      description: 'd',
      components: { skills: './skills' },
    }),
  );
  return devDir;
}

function seedWs(): void {
  runMigrations();
  getDb()
    .prepare(`INSERT INTO workspaces (id, name, directory_path, owner_id) VALUES ('w', 'W', '/tmp/x', '@o')`)
    .run();
}

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
});
afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

describe('插件 skills 可见性', () => {
  it('① manifest skills 声明 → 装配 refs 产出（slug+cachePath 指插件目录）', () => {
    seedWs();
    installPluginDevDir(mkDevPlugin(), '2.1.0');
    const refs = buildPluginSkillRefs('w');
    expect(refs).toEqual([
      { slug: 'codegraph-usage', cachePath: path.join(tmpRoot, 'skill-plugin', 'skills', 'codegraph-usage') },
    ]);
  });

  it('② 资源面：plugin 源 skill 列出（不可手动删）', () => {
    seedWs();
    installPluginDevDir(mkDevPlugin(), '2.1.0');
    const items = listCustomResources().filter((i) => i.type === 'skill' && i.slug === 'codegraph-usage');
    expect(items).toHaveLength(1);
    expect(items[0]!.source).toBe('plugin');
    expect(items[0]!.removable).toBe(false);
  });

  it('③ 无 skills 组件声明的插件不产出（空目录/无声明安全）', () => {
    seedWs();
    const devDir = path.join(tmpRoot, 'noskill-plugin');
    fs.mkdirSync(devDir, { recursive: true });
    fs.writeFileSync(
      path.join(devDir, 'momo-plugin.json'),
      JSON.stringify({ id: 'ns', name: 'N', version: '1.0.0', description: 'd', components: {} }),
    );
    installPluginDevDir(devDir, '2.1.0');
    expect(buildPluginSkillRefs('w')).toEqual([]);
  });
});
