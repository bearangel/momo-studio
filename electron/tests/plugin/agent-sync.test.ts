// electron/tests/plugin/agent-sync.test.ts
//
// 插件 agents 激活锁（spec §10 P2）：YAML→agent_definitions 落库（source='plugin'、
// id=plugin:<pluginId>:<slug>）/ 幂等 / 坏 YAML 降级跳过 / removePluginAgents 级联
// 清成员行与定义行（Review Focus #5）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { closeDb, getDb, runMigrations } from '../../src/main/storage/db';
import { registerPluginAgents, removePluginAgents } from '../../src/main/plugin/agent-sync';
import { updateGlobalSettings } from '../../src/main/settings/crud';
import { upsertPlugin } from '../../src/main/plugin/registry';
import type { PluginRecord } from '../../src/main/plugin/types';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-pasync-'));

const AGENT_YAML = `apiVersion: v1
kind: AgentDefinition
metadata:
  name: 代码导航员
  slug: code-navigator
  version: 1.0.0
spec:
  declarative:
    systemPrompt: 你是代码导航员
    model:
      provider: openai
      model: gpt-4o
`;

function mkPlugin(id: string, yaml: string): PluginRecord {
  const root = path.join(tmpRoot, 'plugins', 'installed', id, '0.1.0');
  fs.mkdirSync(path.join(root, 'agents'), { recursive: true });
  fs.writeFileSync(path.join(root, 'agents', 'navigator.yaml'), yaml);
  fs.writeFileSync(
    path.join(root, 'momo-plugin.json'),
    JSON.stringify({
      id,
      name: id,
      version: '0.1.0',
      description: '',
      components: { agents: './agents' },
    }),
  );
  return {
    id,
    version: '0.1.0',
    manifestJson: fs.readFileSync(path.join(root, 'momo-plugin.json'), 'utf-8'),
    state: 'active',
    source: 'zip',
    sourcePath: null,
    installedAt: 'x',
  };
}

function defsOf(pluginId: string): Array<{ id: string; source: string; name: string }> {
  const prefix = `plugin:${pluginId}:`;
  return getDb()
    .prepare(`SELECT id, source, name FROM agent_definitions WHERE substr(id, 1, ?) = ?`)
    .all(prefix.length, prefix) as Array<{ id: string; source: string; name: string }>;
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

describe('registerPluginAgents', () => {
  it('YAML 落库：id=plugin:<id>:<slug>、source=plugin、workspaceId=NULL', () => {
    const rec = mkPlugin('cg', AGENT_YAML);
    upsertPlugin(rec);
    const n = registerPluginAgents(rec);
    expect(n).toBe(1);
    const defs = defsOf('cg');
    expect(defs).toHaveLength(1);
    expect(defs[0]!.id).toBe('plugin:cg:code-navigator');
    expect(defs[0]!.source).toBe('plugin');
    expect(defs[0]!.name).toBe('代码导航员');
  });

  it('重复注册幂等（不重复行）', () => {
    const rec = mkPlugin('cg', AGENT_YAML);
    upsertPlugin(rec);
    registerPluginAgents(rec);
    registerPluginAgents(rec);
    expect(defsOf('cg')).toHaveLength(1);
  });

  it('坏 YAML 跳过不抛，返回 0', () => {
    const rec = mkPlugin('bad', 'not: [valid: yaml');
    upsertPlugin(rec);
    expect(registerPluginAgents(rec)).toBe(0);
    expect(defsOf('bad')).toHaveLength(0);
  });

  it('manifest 无 agents 组件 → 0', () => {
    const root = path.join(tmpRoot, 'plain');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(
      path.join(root, 'momo-plugin.json'),
      JSON.stringify({ id: 'plain', name: 'p', version: '0.1.0', description: '', components: {} }),
    );
    const rec: PluginRecord = {
      id: 'plain',
      version: '0.1.0',
      manifestJson: fs.readFileSync(path.join(root, 'momo-plugin.json'), 'utf-8'),
      state: 'active',
      source: 'zip',
      sourcePath: null,
      installedAt: 'x',
    };
    upsertPlugin(rec);
    expect(registerPluginAgents(rec)).toBe(0);
  });
});

// 模型绑定解析锁（2026-11-03 插件 agent LLM 配置闭环）：落库模型三列优先级 =
// 既有行显式配置（重载不丢）→ 全局默认聊天模型（provider 存在校验）→ null。
// 背景：saveAgentDefinition 的 upsert 冲突时覆盖模型列，注册若恒带 null 会在
// 每次插件 reload 后清掉用户配置（资源库「配置」/成员编辑写入的模型绑定）。
describe('模型绑定解析（registerPluginAgents）', () => {
  function modelColsOf(defId: string): {
    modelProviderId: string | null;
    modelName: string | null;
  } {
    const row = getDb()
      .prepare('SELECT model_provider_id, model_name FROM agent_definitions WHERE id = ?')
      .get(defId) as { model_provider_id: string | null; model_name: string | null };
    return { modelProviderId: row.model_provider_id, modelName: row.model_name };
  }

  function seedProvider(id: string): void {
    getDb()
      .prepare(
        `INSERT INTO model_providers (id, name, base_url, api_key_ref, is_default, platform)
         VALUES (?, '测试供应商', 'https://x', 'ref', 0, 'openai')`,
      )
      .run(id);
  }

  it('无显式配置 + 全局默认已配置（provider 在库）→ 落默认模型', () => {
    seedProvider('prov-a');
    updateGlobalSettings({ defaultChatModel: { providerId: 'prov-a', modelId: 'glm-5.3' } });
    const rec = mkPlugin('mb1', AGENT_YAML);
    upsertPlugin(rec);
    registerPluginAgents(rec);
    expect(modelColsOf('plugin:mb1:code-navigator')).toEqual({
      modelProviderId: 'prov-a',
      modelName: 'glm-5.3',
    });
  });

  it('重载保留既有行显式配置（不清用户模型绑定）', () => {
    const rec = mkPlugin('mb2', AGENT_YAML);
    upsertPlugin(rec);
    registerPluginAgents(rec);
    // 模拟用户经资源库「配置」写入的显式绑定（updateDefinition 落点即模型三列）
    getDb()
      .prepare(
        `UPDATE agent_definitions SET model_provider_id = ?, model_name = ? WHERE id = ?`,
      )
      .run('prov-user', 'glm-5.2', 'plugin:mb2:code-navigator');
    // 全局默认随后才配置——显式配置仍优先，不被默认覆盖
    seedProvider('prov-b');
    updateGlobalSettings({ defaultChatModel: { providerId: 'prov-b', modelId: 'glm-5.3' } });
    registerPluginAgents(rec); // reload 链重注册
    expect(modelColsOf('plugin:mb2:code-navigator')).toEqual({
      modelProviderId: 'prov-user',
      modelName: 'glm-5.2',
    });
  });

  it('默认未配置 / 默认 provider 已删 → 落 null（spawn 校验报错兜底）', () => {
    // 场景①：默认从未配置
    const rec = mkPlugin('mb3', AGENT_YAML);
    upsertPlugin(rec);
    registerPluginAgents(rec);
    expect(modelColsOf('plugin:mb3:code-navigator')).toEqual({
      modelProviderId: null,
      modelName: '',
    });
    // 场景②：默认指向已删除的 provider——不落悬空引用
    updateGlobalSettings({ defaultChatModel: { providerId: 'prov-gone', modelId: 'x' } });
    const rec2 = mkPlugin('mb4', AGENT_YAML);
    upsertPlugin(rec2);
    registerPluginAgents(rec2);
    expect(modelColsOf('plugin:mb4:code-navigator')).toEqual({
      modelProviderId: null,
      modelName: '',
    });
  });
});

describe('removePluginAgents', () => {
  it('删定义行 + 成员行级联清（Review Focus #5）', () => {
    const rec = mkPlugin('cg', AGENT_YAML);
    upsertPlugin(rec);
    registerPluginAgents(rec);
    const db = getDb();
    db.prepare(
      `INSERT INTO workspaces (id, name, directory_path, owner_id) VALUES ('ws1', 'T', '/x', '@o')`,
    ).run();
    const defId = defsOf('cg')[0]!.id;
    db.prepare(
      `INSERT INTO workspace_agent_members (workspace_id, instance_id, agent_definition_id, agent_user_id) VALUES ('ws1', 'inst-cg-1', ?, '@agent:cg-1')`,
    ).run(defId);
    removePluginAgents('cg');
    expect(defsOf('cg')).toHaveLength(0);
    const members = db
      .prepare(`SELECT * FROM workspace_agent_members WHERE agent_definition_id = ?`)
      .all(defId);
    expect(members).toHaveLength(0);
  });

  it('无行时 no-op 不抛', () => {
    expect(() => removePluginAgents('nope')).not.toThrow();
  });
});

describe('I2：LIKE _ 通配与 I3：reload 收敛（审查修复）', () => {
  function mkRecWithAgents(id: string, slugs: string[]): PluginRecord {
    const root = path.join(tmpRoot, 'plugins', 'installed', id, '0.1.0');
    fs.mkdirSync(path.join(root, 'agents'), { recursive: true });
    for (const slug of slugs) {
      fs.writeFileSync(
        path.join(root, 'agents', `${slug}.yaml`),
        AGENT_YAML.replace('code-navigator', slug),
      );
    }
    fs.writeFileSync(
      path.join(root, 'momo-plugin.json'),
      JSON.stringify({
        id,
        name: id,
        version: '0.1.0',
        description: '',
        components: { agents: './agents' },
      }),
    );
    return {
      id,
      version: '0.1.0',
      manifestJson: fs.readFileSync(path.join(root, 'momo-plugin.json'), 'utf-8'),
      state: 'active',
      source: 'zip',
      sourcePath: null,
      installedAt: 'x',
    };
  }

  it('I2：卸载 a_b 不误删 a-b 的定义行（LIKE _ 通配）', () => {
    const a = mkRecWithAgents('a_b', ['nav']);
    const b = mkRecWithAgents('a-b', ['nav']);
    upsertPlugin(a);
    upsertPlugin(b);
    registerPluginAgents(a);
    registerPluginAgents(b);
    removePluginAgents('a_b');
    expect(defsOf('a_b')).toHaveLength(0);
    expect(defsOf('a-b')).toHaveLength(1);
  });

  it('I3：register 收敛——插件删掉某 agent YAML 后重注册，幽灵行被清', () => {
    const rec = mkRecWithAgents('cg', ['nav', 'old']);
    upsertPlugin(rec);
    registerPluginAgents(rec);
    expect(defsOf('cg')).toHaveLength(2);
    // 模拟 dev 改动：删 old.yaml（保持 manifest 不变——agents 目录内容即真相）
    const root = path.join(tmpRoot, 'plugins', 'installed', 'cg', '0.1.0');
    fs.rmSync(path.join(root, 'agents', 'old.yaml'));
    registerPluginAgents(rec); // reload 链重注册
    const defs = defsOf('cg');
    expect(defs).toHaveLength(1);
    expect(defs[0]!.id).toBe('plugin:cg:nav');
  });
});

// v2.0 引擎整合回归锁：插件 agent 注册链（manifest agents 声明 → 定义落库 source='plugin'）。
// 2026-11-03 夹具化（spec 2026-11-03-momo-plugin §4）：原版 sourcePath 指向仓库
// plugins/codegraph，插件已迁出至独立仓 momo-plugin——改 tmp 夹具 + 内联与真实
// code-navigator 同形的 YAML，断言语义不变。
describe('registerPluginAgents（codegraph v2.0 agents 声明）', () => {
  it('manifest 声明 agents → yaml 注册为 plugin 源定义', () => {
    const fxRoot = path.join(tmpRoot, 'cg-fixture');
    fs.mkdirSync(path.join(fxRoot, 'agents'), { recursive: true });
    fs.writeFileSync(
      path.join(fxRoot, 'agents', 'code-navigator.yaml'),
      `# 夹具：与 momo-plugin 仓 codegraph agents/code-navigator.yaml 同形（最小保留 frontmatter 语义字段）
apiVersion: v1
kind: AgentDefinition
metadata:
  name: 代码导航员
  slug: code-navigator
  version: 1.0.0
  description: 问「某符号被谁调用 / 改动影响面」派我；先用 codegraph 图谱查询，再读源码确认。
spec:
  declarative:
    systemPrompt: |
      你是代码导航员——调用关系专家。
    model:
      provider: openai
      model: gpt-4o
  defaultTools:
    - kind: builtin
      ref: read_file
`,
      'utf-8',
    );
    const manifest = {
      id: 'cg',
      name: 'cg',
      version: '2.0.0',
      components: { agents: './agents' },
    };
    const rec = {
      id: 'cg',
      version: '2.0.0',
      manifestJson: JSON.stringify(manifest),
      state: 'active',
      source: 'dev',
      sourcePath: fxRoot,
      installedAt: 'x',
    } as Parameters<typeof registerPluginAgents>[0];
    const n = registerPluginAgents(rec);
    expect(n).toBeGreaterThanOrEqual(1);
    const def = getDb()
      .prepare(`SELECT source, slug FROM agent_definitions WHERE id = 'plugin:cg:code-navigator'`)
      .get() as { source: string; slug: string } | undefined;
    expect(def).toMatchObject({ source: 'plugin', slug: 'code-navigator' });
  });
});
