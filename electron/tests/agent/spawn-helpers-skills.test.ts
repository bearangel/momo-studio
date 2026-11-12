// electron/tests/agent/spawn-helpers-skills.test.ts
//
// resolveSkillSlugs 双源回退回归锁（终审 C1）：四册 builtin 技能（create-agent /
// create-skill / create-mcp / build-team）实际位于 electron/resources/skills/
// （builtin 根），从不物化进 <userData>/skills/。修复前 resolveSkillSlugs 把所有
// 非插件 slug 无差别映射到 userData 目录 → 子进程 SkillRegistry.register 抛
// 「SKILL.md 不存在」被吞 → Layer 1 索引不注入、loadSkill 必败。
//
// 数据源直读仓库真实 general-assistant.yaml（与 builtin.test.ts 引用一致性锁
// 同一数据源，不在 tmp 沙盒伪造）。DB 隔离沿用 spawn-helpers-tools.test.ts 模式。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { buildSpawnOpts, resolveSkillSlugs } from '../../src/main/agent/spawn-helpers';
import { parseAgentManifestWithSuggestion } from '../../src/main/agent/manifest-parser';
import { resolveBuiltinSkillsDir } from '../../src/main/skill/zip-uploader';
import { resolveSkillsDir } from '../../src/main/paths';

const tmpRoot = path.join(os.tmpdir(), `ap-spawn-skills-test-${Date.now()}-${process.pid}`);
const AGENTS_DIR = path.resolve(__dirname, '../../resources/agents');

// 2026-11-12 会话内能力管理：defaultSkills 4 → 5（+manage-agent，与
// builtin.test.ts 引用一致性锁同名单步进）。
const MOMO_SKILL_SLUGS = ['build-team', 'create-agent', 'create-mcp', 'create-skill', 'manage-agent'];

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

describe('resolveSkillSlugs（双源回退，C1 回归锁）', () => {
  it('builtin 四册：userData 无物化时回退 builtin 根，SKILL.md 全部存在', () => {
    const refs = resolveSkillSlugs(MOMO_SKILL_SLUGS);
    expect(refs.map((r) => r.slug).sort()).toEqual([...MOMO_SKILL_SLUGS].sort());
    const builtinDir = resolveBuiltinSkillsDir();
    for (const ref of refs) {
      // 消费方（子进程 SkillRegistry.register）直接读 cachePath/SKILL.md——
      // 断言真实存在，不接受「调用方不应该依赖它」的占位路径
      expect(
        fs.existsSync(path.join(ref.cachePath, 'SKILL.md')),
        `${ref.slug} 的 cachePath 无 SKILL.md: ${ref.cachePath}`,
      ).toBe(true);
      // userData skills 目录为空 → 必须走 builtin 根回退
      expect(ref.cachePath.startsWith(builtinDir), `${ref.slug} 未回退 builtin 根`).toBe(true);
    }
  });

  it('userData 物化目录优先于 builtin 根（custom 覆盖同名 builtin）', () => {
    const customDir = path.join(resolveSkillsDir(), 'create-agent');
    fs.mkdirSync(customDir, { recursive: true });
    fs.writeFileSync(path.join(customDir, 'SKILL.md'), '# custom override\n');

    const refs = resolveSkillSlugs(MOMO_SKILL_SLUGS);
    const custom = refs.find((r) => r.slug === 'create-agent')!;
    expect(custom.cachePath).toBe(customDir);
    // 其余仍回退 builtin
    expect(refs.find((r) => r.slug === 'build-team')!.cachePath.startsWith(resolveBuiltinSkillsDir())).toBe(true);
  });

  it('两处皆无：保留 userData 约定路径（悬空引用语义不回归）', () => {
    const [ref] = resolveSkillSlugs(['no-such-skill']);
    expect(ref!.cachePath).toBe(path.join(resolveSkillsDir(), 'no-such-skill'));
    expect(fs.existsSync(path.join(ref!.cachePath, 'SKILL.md'))).toBe(false);
  });
});

describe('buildSpawnOpts × Momo def（挂载链端到端）', () => {
  it('general-assistant.yaml 的五个 defaultSkills 全部解析到存在 SKILL.md 的 cachePath', async () => {
    const db = getDb();
    db.prepare(
      `INSERT INTO model_providers (id, name, base_url, api_key_ref, default_model, is_default)
       VALUES ('pid', 'Test', 'https://api.test.com', 'provider.pid.api_key', null, 0)`,
    ).run();
    db.prepare(
      `INSERT INTO workspaces
         (id, name, description, directory_path, git_initialized, owner_id, icon_emoji)
       VALUES ('ws1', 'WS', '', '/tmp', 0, '@owner:s', '📁')`,
    ).run();
    db.prepare(
      `INSERT INTO agent_definitions
         (id, name, slug, version, runtime, system_prompt,
          default_tools, default_mcps, default_skills,
          source, description, icon_emoji,
          model_provider_id, model_name, task_driven)
       VALUES ('builtin-general-assistant', 'Momo', 'general-assistant', '2.1.0', 'declarative', 'p',
               '[]', '[]', '[]', 'builtin', 'd', '🐾', 'pid', 'm', 1)`,
    ).run();

    // 真实 YAML 解析产物（builtin def 的 modelProviderId 为 null——spawn 前用户
    // 已配置的形态：指向种子 provider）
    const yaml = fs.readFileSync(path.join(AGENTS_DIR, 'general-assistant.yaml'), 'utf-8');
    const { def } = parseAgentManifestWithSuggestion(yaml);
    def.modelProviderId = 'pid';

    const opts = await buildSpawnOpts({
      instanceId: 'inst1',
      agentUserId: 'agent-general-assistant-ab12cd',
      workspaceId: 'ws1',
      workspaceDir: '/tmp',
      def,
      role: 'standalone',
      llmApiKey: 'k',
    });

    const skills = opts.skills ?? [];
    expect(skills.map((s) => s.slug).sort()).toEqual([...MOMO_SKILL_SLUGS].sort());
    for (const ref of skills) {
      expect(
        fs.existsSync(path.join(ref.cachePath, 'SKILL.md')),
        `${ref.slug} 的 cachePath 无 SKILL.md: ${ref.cachePath}`,
      ).toBe(true);
    }
  });
});
