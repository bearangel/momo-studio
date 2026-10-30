// electron/tests/resource/plugin-dedup.test.ts
//
// M5.1 §1.1 插件优先归并 + 重复检测/一键清理回归锁（spec 2026-10-30 §2）：
//   - 归并矩阵：plugin×custom（skill 集成 / agent 集成 / mcp 纯函数——
//     mcp_definitions.name UNIQUE，plugin/custom 同名行物理不并存，规则按
//     矩阵 §0「预防性覆盖」裁定仍锁）；builtin×custom 不归并（负例——fork
//     语义不动）；隐藏非删除（直查源仍在：fs 目录 / DB 行）
//   - scanPluginDupIssues：插件已提供同名的 custom 本地副本清单（提示条数据源）
//   - cleanupPluginDups：批删成功（skill=fs 目录+.sha256 消失 / agent=DB 行
//     消失）；部分失败续删（逐条报错不中断）；非重复目标拒删（重扫描校验）
//
// 隔离：AP_USER_DATA_DIR 临时目录 + runMigrations 真实建表（ownership.test.ts
// 模式）；插件经 upsertPlugin 落 dev 源行（sourcePath 指向 tmp 目录——
// resolvePluginRoot/listAllPluginSkills 走真实扫描链）；fetchCatalog mock 空目录
// （listResources 需要时零网络，负例用例按需注入 builtin 条目）。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { runMigrations, closeDb } from '../../src/main/storage/db';
import { listResources } from '../../src/main/resource/library';
import {
  dedupePluginLocalCopies,
  scanPluginDupIssues,
  cleanupPluginDups,
} from '../../src/main/resource/plugin-dedup';
import { saveAgentDefinition } from '../../src/main/agent/crud';
import { upsertPlugin } from '../../src/main/plugin/registry';
import type { ResourceItem } from '../../src/main/resource/types';

vi.mock('../../src/main/marketplace/client', () => ({
  fetchCatalog: vi.fn(async () => ({ version: '1', updatedAt: '', items: [] })),
}));

let tmpRoot: string;

/** 落一个 custom skill 目录（.sha256 标记——listInstalled custom 判定源） */
function seedCustomSkill(slug: string, version?: string): string {
  const dir = path.join(tmpRoot, 'skills', slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${slug}\ndescription: d${version !== undefined ? `\nversion: ${version}` : ''}\n---\n\n正文。\n`,
  );
  fs.writeFileSync(path.join(dir, '.sha256'), 'deadbeef');
  return dir;
}

function seedAgentDef(slug: string, source: 'custom' | 'builtin', id?: string): string {
  const defId = id ?? randomUUID();
  saveAgentDefinition({
    id: defId, name: `${slug}-name`, slug, version: '1.0.0', runtime: 'declarative',
    systemPrompt: 'p', defaultTools: [], source, description: 'd', iconEmoji: '',
    defaultMcps: [], defaultSkills: [], workspaceId: null,
    modelProviderId: null, modelName: 'm',
  });
  return defId;
}

/** dev 源插件：momo-plugin.json + 可选 skills/<slug>/SKILL.md（listAllPluginSkills 真实扫描） */
function seedDevPlugin(pluginId: string, skills: string[] = []): string {
  const root = path.join(tmpRoot, 'plugins', pluginId);
  fs.mkdirSync(root, { recursive: true });
  for (const slug of skills) {
    fs.mkdirSync(path.join(root, 'skills', slug), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'skills', slug, 'SKILL.md'),
      `---\nname: ${slug}\ndescription: 插件技能\n---\n\n插件正文。\n`,
    );
  }
  const manifest = JSON.stringify({
    id: pluginId, name: pluginId, version: '1.0.0', description: 'dedup 测试插件',
    components: skills.length > 0 ? { skills: './skills' } : {},
  });
  fs.writeFileSync(path.join(root, 'momo-plugin.json'), manifest);
  upsertPlugin({
    id: pluginId, version: '1.0.0', manifestJson: manifest,
    state: 'active', source: 'dev', sourcePath: root, installedAt: new Date().toISOString(),
  });
  return root;
}

/** plugin agent 定义（id 形如 plugin:<pluginId>:<slug>——agent-sync 落库约定） */
function seedPluginAgentDef(pluginId: string, slug: string): void {
  saveAgentDefinition({
    id: `plugin:${pluginId}:${slug}`, name: `${slug}-p`, slug, version: '1.0.0',
    runtime: 'declarative', systemPrompt: 'p', defaultTools: [], source: 'plugin',
    description: 'd', iconEmoji: '', defaultMcps: [], defaultSkills: [],
    workspaceId: null, modelProviderId: null, modelName: 'm',
  });
}

/** 最小 ResourceItem 构造（dedupePluginLocalCopies 纯函数单测用） */
function item(source: 'plugin' | 'custom', type: 'skill' | 'mcp' | 'agent', slug: string): ResourceItem {
  return {
    id: `${source}-${type}-${slug}`, type, source, slug, name: slug, description: 'd',
    installed: true, installable: false, removable: source === 'custom',
  };
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-plugin-dedup-'));
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
});

afterEach(() => {
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

describe('插件优先归并（listResources 出口，隐藏非删除）', () => {
  it('skill：插件行在场 → 同 slug custom fs 副本行不输出；源目录仍在（隐藏非删除）', async () => {
    const customDir = seedCustomSkill('dup-skill');
    seedDevPlugin('plug-a', ['dup-skill']);

    const skills = await listResources({ type: 'skill' });
    expect(skills.some((i) => i.id === 'plugin-skill-dup-skill')).toBe(true);
    expect(skills.some((i) => i.id === 'custom-skill-dup-skill')).toBe(false);
    // 直查源仍在——归并只隐藏，删除仅经一键清理（用户触发）
    expect(fs.existsSync(path.join(customDir, 'SKILL.md'))).toBe(true);
  });

  it('agent：插件 agent def 同 def.slug → custom def 行不输出（语义 slug 匹配，非 def.id）', async () => {
    const customDefId = seedAgentDef('dup-agent', 'custom');
    seedPluginAgentDef('plug-a', 'dup-agent');

    const agents = await listResources({ type: 'agent' });
    expect(agents.some((i) => i.id === 'plugin-agent-plugin:plug-a:dup-agent')).toBe(true);
    expect(agents.some((i) => i.id === `custom-agent-${customDefId}`)).toBe(false);
  });

  it('mcp：同名 plugin 行在场 → custom 行不输出（纯函数锁——name UNIQUE 物理不并存，规则预防性覆盖）', () => {
    const out = dedupePluginLocalCopies([
      item('plugin', 'mcp', 'dup-mcp'),
      item('custom', 'mcp', 'dup-mcp'),
      item('custom', 'mcp', 'solo-mcp'),
    ]);
    expect(out.map((i) => i.id)).toEqual(['plugin-mcp-dup-mcp', 'custom-mcp-solo-mcp']);
  });

  it('负例锁：builtin×custom 同 slug 不归并（fork 语义，spec §1.1 不动项）', async () => {
    // catalog 注入 builtin agent 条目（library builtin 面）——与 custom def 同 slug
    const { fetchCatalog } = await import('../../src/main/marketplace/client');
    (fetchCatalog as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      version: '1', updatedAt: '',
      items: [{
        id: 'bi-1', type: 'agent', slug: 'fork-agent', name: '内置 Agent', version: '1',
        author: 'Momo', description: 'd', readme: 'r', tags: [], category: 'c',
        iconEmoji: '🤖', verificationStatus: 'official', downloadUrl: '', checksum: '',
        sizeBytes: 0, installCount: 0,
      }],
    });
    const customDefId = seedAgentDef('fork-agent', 'custom');

    const agents = await listResources({ type: 'agent' });
    expect(agents.some((i) => i.source === 'builtin' && i.slug === 'fork-agent')).toBe(true);
    expect(agents.some((i) => i.id === `custom-agent-${customDefId}`)).toBe(true);
  });

  it('无关 slug 的 custom 行不受归并影响（只归并同 type+slug）', async () => {
    seedCustomSkill('keep-skill');
    seedDevPlugin('plug-b', ['other-skill']);

    const skills = await listResources({ type: 'skill' });
    expect(skills.some((i) => i.id === 'custom-skill-keep-skill')).toBe(true);
    expect(skills.some((i) => i.id === 'plugin-skill-other-skill')).toBe(true);
  });
});

describe('scanPluginDupIssues（提示条数据源）', () => {
  it('skill/agent 重复各出一行（type/slug/pluginId；agent slug=def.id）；无重复 → 空', () => {
    seedCustomSkill('dup-skill');
    seedDevPlugin('plug-a', ['dup-skill']);
    const customDefId = seedAgentDef('dup-agent', 'custom');
    seedPluginAgentDef('plug-a', 'dup-agent');
    // 非重复对照
    seedCustomSkill('solo-skill');

    const issues = scanPluginDupIssues();
    expect(issues).toHaveLength(2);
    expect(issues.find((i) => i.type === 'skill')).toMatchObject({
      slug: 'dup-skill', pluginId: 'plug-a', name: 'dup-skill',
    });
    const agent = issues.find((i) => i.type === 'agent')!;
    expect(agent.slug).toBe(customDefId); // agent 的清理入参键是 def.id
    expect(agent.pluginId).toBe('plug-a');
    expect(issues.some((i) => i.slug === 'solo-skill')).toBe(false);
  });

  it('无任何重复 → 空数组（提示条不渲染）', () => {
    expect(scanPluginDupIssues()).toEqual([]);
  });
});

describe('cleanupPluginDups（一键清理：批删 + 部分失败续删）', () => {
  it('批删成功：skill fs 目录+.sha256 消失；agent DB 行消失；插件面保留；清单清空', async () => {
    const customDir = seedCustomSkill('dup-skill');
    seedDevPlugin('plug-a', ['dup-skill']);
    const pluginSkillMd = path.join(tmpRoot, 'plugins', 'plug-a', 'skills', 'dup-skill', 'SKILL.md');
    const agentDefId = seedAgentDef('dup-agent', 'custom');
    seedPluginAgentDef('plug-a', 'dup-agent');

    const result = await cleanupPluginDups([
      { type: 'skill', slug: 'dup-skill' },
      { type: 'agent', slug: agentDefId },
    ]);

    expect(result.failures).toEqual([]);
    expect(result.deleted).toHaveLength(2);
    // skill：fs 目录与 .sha256 标记删除
    expect(fs.existsSync(customDir)).toBe(false);
    // agent：custom def 删除，plugin def 保留
    const agents = await listResources({ type: 'agent' });
    expect(agents.some((i) => i.source === 'plugin' && i.slug === 'plugin:plug-a:dup-agent')).toBe(true);
    expect(agents.some((i) => i.id === `custom-agent-${agentDefId}`)).toBe(false);
    // 插件本体与插件技能不受清理影响
    expect(fs.existsSync(pluginSkillMd)).toBe(true);
    // 清理后重复清单为空（提示条消失）
    expect(scanPluginDupIssues()).toEqual([]);
  });

  it('部分失败续删：中途失败不中断后续目标，逐条报错', async () => {
    seedCustomSkill('ok-skill');
    seedDevPlugin('plug-a', ['ok-skill']);
    seedCustomSkill('bad-skill');
    seedDevPlugin('plug-a', ['bad-skill']);
    // 注入单条失败：bad-skill 目录收回写权限（rmSync 删内部文件 EACCES），
    // ok-skill 应照常被删（续删语义——失败不中断）
    fs.chmodSync(path.join(tmpRoot, 'skills', 'bad-skill'), 0o500);

    const result = await cleanupPluginDups([
      { type: 'skill', slug: 'bad-skill' },
      { type: 'skill', slug: 'ok-skill' },
    ]);

    expect(result.deleted).toEqual([{ type: 'skill', slug: 'ok-skill' }]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]!.slug).toBe('bad-skill');
    expect(result.failures[0]!.reason).not.toBe('已不是插件重复项（可能已被删除）');
    expect(fs.existsSync(path.join(tmpRoot, 'skills', 'ok-skill'))).toBe(false);
    fs.chmodSync(path.join(tmpRoot, 'skills', 'bad-skill'), 0o755); // 收摊可清理
  });

  it('非重复目标拒删（重扫描校验——不信任调用方清单）', async () => {
    seedCustomSkill('plain-skill'); // 无插件同名——非重复项
    const result = await cleanupPluginDups([{ type: 'skill', slug: 'plain-skill' }]);
    expect(result.deleted).toEqual([]);
    expect(result.failures[0]!.reason).toContain('已不是插件重复项');
    expect(fs.existsSync(path.join(tmpRoot, 'skills', 'plain-skill', 'SKILL.md'))).toBe(true);
  });

  it('mcp 目标：name UNIQUE 下 plugin/custom 同名不并存——恒落「已不是插件重复项」失败不误删', async () => {
    seedDevPlugin('plug-a');
    const result = await cleanupPluginDups([{ type: 'mcp', slug: 'ghost-mcp' }]);
    expect(result.deleted).toEqual([]);
    expect(result.failures[0]!.reason).toContain('已不是插件重复项');
  });
});
