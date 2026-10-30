// electron/tests/hub/publish-writeback.test.ts
//
// M5.1 §1.2 发布版本回写回归锁（spec 2026-10-30 §2）：
//   - 三通道：skill SKILL.md frontmatter 原子写（version 写/更新，其余字段与
//     正文逐字保留；.sha256 标记同步刷新）/ agent DB / mcp DB
//   - plugin：dev 源写 momo-plugin.json；zip 装源 skipped + 人话提示
//   - 回写失败不推翻发布（Safe 壳吞错转 { written:false, error }）
//   - upsertSkillFrontmatterVersion 单元面：无 frontmatter 补块 / 嵌套
//     version 键不误伤 / CRLF 保持
//
// 隔离：AP_USER_DATA_DIR 临时目录 + runMigrations 真实建表（publish 定位链
// resolveSkillCachePath / getPlugin / DB UPDATE 全真实）。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import {
  writebackPublishedVersion,
  writebackPublishedVersionSafe,
  upsertSkillFrontmatterVersion,
} from '../../src/main/hub/publish-writeback';
import { saveAgentDefinition } from '../../src/main/agent/crud';
import { getAgentDefinition } from '../../src/main/agent/agent-queries';
import { registerMcpDefinition } from '../../src/main/mcp/host-manager';
import { upsertPlugin } from '../../src/main/plugin/registry';

let tmpRoot: string;

function seedCustomSkill(slug: string, frontmatterExtra?: string): string {
  const dir = path.join(tmpRoot, 'skills', slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${slug}\ndescription: d${frontmatterExtra ?? ''}\n---\n\n# 正文标题\n\n逐字保留的正文。\n`,
  );
  fs.writeFileSync(path.join(dir, '.sha256'), 'deadbeef');
  return dir;
}

function readSkillMd(dir: string): string {
  return fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf-8');
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-writeback-'));
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

describe('upsertSkillFrontmatterVersion（frontmatter 字符串手术单元面）', () => {
  it('已有顶层 version 行 → 原位换值，其余字段/正文逐字保留', () => {
    const md = `---\nname: s\ndescription: d\nversion: 1.0.0\n---\n\n正文。第二行。\n`;
    const out = upsertSkillFrontmatterVersion(md, '1.0.1');
    expect(out).toBe(`---\nname: s\ndescription: d\nversion: 1.0.1\n---\n\n正文。第二行。\n`);
  });

  it('无 version 行 → 紧跟开档 --- 插入，已有字段与正文不动', () => {
    const md = `---\nname: s\ndescription: d\n---\n\n正文。\n`;
    const out = upsertSkillFrontmatterVersion(md, '2.0.0');
    expect(out).toBe(`---\nversion: 2.0.0\nname: s\ndescription: d\n---\n\n正文。\n`);
  });

  it('嵌套缩进的 version 键不误伤（只匹配顶层无缩进行）', () => {
    const md = `---\nname: s\nmodels:\n  version: nested\n---\n\n正文。\n`;
    const out = upsertSkillFrontmatterVersion(md, '1.1.0');
    expect(out).toContain('  version: nested\n');
    expect(out).toContain('version: 1.1.0\n');
    expect(out.match(/^version:/gm)).toHaveLength(1);
  });

  it('无 frontmatter → 补最小块', () => {
    const out = upsertSkillFrontmatterVersion('# 只有正文\n', '1.0.0');
    expect(out).toBe(`---\nversion: 1.0.0\n---\n# 只有正文\n`);
  });

  it('CRLF 行尾保持', () => {
    const md = `---\r\nname: s\r\nversion: 1.0.0\r\n---\r\n\r\n正文。\r\n`;
    const out = upsertSkillFrontmatterVersion(md, '1.0.2');
    expect(out).toBe(`---\r\nname: s\r\nversion: 1.0.2\r\n---\r\n\r\n正文。\r\n`);
  });
});

describe('回写三通道（writebackPublishedVersion）', () => {
  it('skill：SKILL.md version 写入 + 正文保留 + .sha256 刷新 + 无 tmp 残留', () => {
    const dir = seedCustomSkill('wb-skill'); // frontmatter 无 version
    const r = writebackPublishedVersion('skill', 'wb-skill', '1.0.1');
    expect(r).toEqual({ written: true });

    const md = readSkillMd(dir);
    expect(md).toContain('version: 1.0.1');
    expect(md).toContain('name: wb-skill');
    expect(md).toContain('逐字保留的正文。');
    // .sha256 刷新为内容 hash（不再是种子值）
    const hash = fs.readFileSync(path.join(dir, '.sha256'), 'utf-8').trim();
    expect(hash).not.toBe('deadbeef');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    // 原子写：无 .tmp 残留
    expect(fs.readdirSync(dir).filter((f) => f.includes('.tmp-'))).toEqual([]);
  });

  it('skill：已有 version 原位升版（1.0.0 → 1.0.2）', () => {
    const dir = seedCustomSkill('wb-skill2', '\nversion: 1.0.0');
    writebackPublishedVersion('skill', 'wb-skill2', '1.0.2');
    const md = readSkillMd(dir);
    expect(md).toContain('version: 1.0.2');
    expect(md).not.toContain('1.0.0');
  });

  it('skill 不存在 → written:false + error', () => {
    const r = writebackPublishedVersion('skill', 'ghost', '1.0.0');
    expect(r.written).toBe(false);
    expect(r.error).toContain('skill 不存在');
  });

  it('agent：agent_definitions.version 更新（DB）', () => {
    const defId = randomUUID();
    saveAgentDefinition({
      id: defId, name: 'wb-agent', slug: 'wb-agent', version: '1.0.0', runtime: 'declarative',
      systemPrompt: 'p', defaultTools: [], source: 'custom', description: 'd', iconEmoji: '',
      defaultMcps: [], defaultSkills: [], workspaceId: null, modelProviderId: null, modelName: 'm',
    });
    const r = writebackPublishedVersion('agent', defId, '1.2.0');
    expect(r).toEqual({ written: true });
    expect(getAgentDefinition(defId)?.version).toBe('1.2.0');
  });

  it('mcp：mcp_definitions.version 更新（custom 源；非 custom 行不动）', () => {
    registerMcpDefinition({
      id: randomUUID(), name: 'wb-mcp', version: '1.0.0', transport: 'stdio',
      command: 'npx', args: ['pkg'], source: 'custom',
    });
    const r = writebackPublishedVersion('mcp', 'wb-mcp', '2.0.0');
    expect(r).toEqual({ written: true });
    const row = getDb().prepare('SELECT version FROM mcp_definitions WHERE name = ?').get('wb-mcp') as { version: string };
    expect(row.version).toBe('2.0.0');
  });

  it('mcp 非自定义行（marketplace 源）→ written:false（不误改市场装面）', () => {
    registerMcpDefinition({
      id: randomUUID(), name: 'mkt-mcp', version: '1.0.0', transport: 'stdio',
      command: 'npx', args: ['pkg'], source: 'marketplace',
    });
    const r = writebackPublishedVersion('mcp', 'mkt-mcp', '2.0.0');
    expect(r.written).toBe(false);
    expect(r.error).toContain('自定义 MCP 不存在');
  });
});

describe('plugin 通道（dev 可写 / zip 跳过）', () => {
  it('dev 源：momo-plugin.json version 更新（原子写保留其余字段）', () => {
    const root = path.join(tmpRoot, 'plugins', 'wb-plug');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(
      path.join(root, 'momo-plugin.json'),
      JSON.stringify({ id: 'wb-plug', name: '插件', version: '1.0.0', description: 'd', components: { skills: 'skills' } }, null, 2),
    );
    upsertPlugin({
      id: 'wb-plug', version: '1.0.0',
      manifestJson: fs.readFileSync(path.join(root, 'momo-plugin.json'), 'utf-8'),
      state: 'active', source: 'dev', sourcePath: root, installedAt: new Date().toISOString(),
    });

    const r = writebackPublishedVersion('plugin', 'wb-plug', '1.1.0');
    expect(r).toEqual({ written: true });
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'momo-plugin.json'), 'utf-8')) as {
      version: string; components: { skills: string };
    };
    expect(manifest.version).toBe('1.1.0');
    expect(manifest.components.skills).toBe('skills'); // 其余字段保留
  });

  it('zip 装源：skipped + 人话提示「插件本体由插件包管理，版本未回写」', () => {
    upsertPlugin({
      id: 'zip-plug', version: '1.0.0',
      manifestJson: JSON.stringify({ id: 'zip-plug', name: 'z', version: '1.0.0', description: '', components: {} }),
      state: 'active', source: 'zip', sourcePath: null, installedAt: new Date().toISOString(),
    });
    const r = writebackPublishedVersion('plugin', 'zip-plug', '1.1.0');
    expect(r.written).toBe(false);
    expect(r.skipped).toBe(true);
    expect(r.notice).toBe('插件本体由插件包管理，版本未回写');
  });
});

describe('Safe 壳：回写失败不推翻发布', () => {
  it('writebackPublishedVersionSafe 吞错转 { written:false, error }，不抛', () => {
    const r = writebackPublishedVersionSafe('skill', 'ghost', '1.0.0');
    expect(r.written).toBe(false);
    expect(r.error).toBeTruthy();
  });

  it('正常路径透传（written:true）', () => {
    seedCustomSkill('safe-skill');
    expect(writebackPublishedVersionSafe('skill', 'safe-skill', '1.0.1')).toEqual({ written: true });
  });
});
