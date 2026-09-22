// electron/tests/agent/preset.test.ts
//
// 预设 agent 按需启用（spec 2026-09-22）def 层 + 编排层测试：
//   1. enablePresetDef：确定性 id / source=builtin / 模型字段入参覆盖
//   2. 幂等：重复启用 id 不变、字段覆盖
//   3. suggestions Map 填充该条
//   4. 源头拒绝：slug 路径穿越 / 供应商不存在 / YAML 缺失
//   5. enablePresetWithJoin：加入 + 设默认（DB 行断言）
//   6. join 幂等：重复调用返回既有 member、joinedNow=false
//   7. loadBuiltinSuggestionsOnly：只填 Map 不落库
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import {
  listAgentDefinitions,
  getAgentDefinition,
  listMembers,
} from '../../src/main/agent/crud';
import {
  setBuiltinAgentsDir,
  getBuiltinSuggestionsMap,
  clearBuiltinSuggestionsForTest,
} from '../../src/main/agent/builtin';
import {
  enablePresetDef,
  enablePresetWithJoin,
} from '../../src/main/agent/preset';
import { createWorkspace } from '../../src/main/workspace/crud';

const tmpRoot = path.join(os.tmpdir(), `ap-preset-test-${Date.now()}`);

const VALID_YAML = `
apiVersion: v1
kind: AgentDefinition
metadata:
  name: 需求讨论师
  slug: requirement-analyst
  version: 1.0.0
  description: 帮用户梳理需求
spec:
  type: standalone
  runtime: declarative
  declarative:
    systemPrompt: "你是需求分析师"
    model:
      provider: anthropic
      model: claude-3-5-sonnet
  defaultTools:
    - kind: builtin
      ref: read_file
`;

/** 插入测试供应商行（model_providers）——getProvider 校验依赖 */
function seedProvider(id: string): void {
  getDb().prepare(
    `INSERT INTO model_providers (id, name, base_url, api_key_ref, default_model, is_default, created_at, platform, preset_key)
     VALUES (?, '测试供应商', 'https://api.test/v1', ?, NULL, 0, datetime('now'), 'openai', NULL)`,
  ).run(id, `provider.${id}.api_key`);
}

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  clearBuiltinSuggestionsForTest();
  const agentDir = path.join(tmpRoot, 'agents');
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, 'requirement-analyst.yaml'), VALID_YAML, 'utf-8');
  setBuiltinAgentsDir(agentDir);
  seedProvider('prov-1');
});

afterEach(() => {
  closeDb();
  setBuiltinAgentsDir(null);
  clearBuiltinSuggestionsForTest();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

describe('enablePresetDef — def 层', () => {
  it('落库：确定性 id builtin-<slug>、source=builtin、模型字段以入参覆盖', () => {
    const def = enablePresetDef({
      slug: 'requirement-analyst',
      modelProviderId: 'prov-1',
      modelName: 'glm-4.7',
    });
    expect(def.id).toBe('builtin-requirement-analyst');
    expect(def.source).toBe('builtin');
    expect(def.modelProviderId).toBe('prov-1');
    expect(def.modelName).toBe('glm-4.7');
    expect(def.systemPrompt).toBe('你是需求分析师');
    // DB 行为准（不是只看返回值）
    const row = getAgentDefinition('builtin-requirement-analyst');
    expect(row?.modelProviderId).toBe('prov-1');
    expect(listAgentDefinitions().some((d) => d.id === def.id)).toBe(true);
  });

  it('幂等：重复启用 id 不变、模型字段覆盖为新值', () => {
    const first = enablePresetDef({
      slug: 'requirement-analyst', modelProviderId: 'prov-1', modelName: 'glm-4.7',
    });
    const second = enablePresetDef({
      slug: 'requirement-analyst', modelProviderId: 'prov-1', modelName: 'deepseek-chat',
    });
    expect(second.id).toBe(first.id);
    expect(listAgentDefinitions().filter((d) => d.id === first.id)).toHaveLength(1);
    expect(getAgentDefinition(first.id)?.modelName).toBe('deepseek-chat');
  });

  it('suggestions Map 填充该条（key=builtin-<slug>）', () => {
    enablePresetDef({ slug: 'requirement-analyst', modelProviderId: 'prov-1', modelName: 'glm-4.7' });
    expect(getBuiltinSuggestionsMap()['builtin-requirement-analyst']).toBeDefined();
    expect(getBuiltinSuggestionsMap()['builtin-requirement-analyst']!.suggestedPlatform).toBe('anthropic');
  });

  it('slug 路径穿越拒绝（../evil 形态）', () => {
    expect(() =>
      enablePresetDef({ slug: '../evil', modelProviderId: 'prov-1', modelName: 'm' }),
    ).toThrow(/slug 非法/);
  });

  it('供应商不存在拒绝（ghost provider）', () => {
    expect(() =>
      enablePresetDef({ slug: 'requirement-analyst', modelProviderId: 'prov-gone', modelName: 'm' }),
    ).toThrow(/供应商不存在/);
  });

  it('YAML 缺失报错（不静默）', () => {
    expect(() =>
      enablePresetDef({ slug: 'no-such-preset', modelProviderId: 'prov-1', modelName: 'm' }),
    ).toThrow(/不存在/);
  });

  it('空 modelProviderId / modelName 拒绝', () => {
    expect(() =>
      enablePresetDef({ slug: 'requirement-analyst', modelProviderId: '  ', modelName: 'm' }),
    ).toThrow(/modelProviderId/);
    expect(() =>
      enablePresetDef({ slug: 'requirement-analyst', modelProviderId: 'prov-1', modelName: '' }),
    ).toThrow(/modelName/);
  });

  // N2 终审修复回归锁：catalog 文件名与 YAML metadata.slug 漂移（如文件 requirement-analyst.yaml
  // 但 metadata.slug: other-name）必须被立刻拒绝——否则 def 会以 'builtin-other-name' 落库，
  // 而调用方拿到的 def.id 与基于请求 slug 计算的 'builtin-requirement-analyst' 不一致，
  // 启用态永远无法被重复启用的同请求幂等命中（死循环）。
  it('YAML metadata.slug 与请求不符 → 拒绝（catalog slug 漂移防御）', () => {
    const agentDir = path.join(tmpRoot, 'agents');
    fs.writeFileSync(
      path.join(agentDir, 'requirement-analyst.yaml'),
      `
apiVersion: v1
kind: AgentDefinition
metadata:
  name: 别名
  slug: other-name
  version: 1.0.0
  description: ''
spec:
  type: standalone
  runtime: declarative
  declarative:
    systemPrompt: "漂移的 systemPrompt"
    model:
      provider: openai
      model: m
  defaultTools: []
`,
      'utf-8',
    );
    expect(() =>
      enablePresetDef({ slug: 'requirement-analyst', modelProviderId: 'prov-1', modelName: 'm' }),
    ).toThrow(/slug 与请求不符/);
  });

  // 故意注入运行时坏形状——thinkingJson 形状非法是 spec 终审 I-2 锁的源头拒绝语义。
  // 编译期 ThinkingConfig 类型已限定 mode 枚举；此处 `as never` 是为了让运行时校验真
  // 正触发（typecheck 关闭，运行时形状是实际被测面）。回归锁——若有人改成「静默吞坏值」
  // 让它落库，本用例立刻红。
  it('thinkingJson 形状非法源头拒绝（assertThinkingConfigShape 抛错文案）', () => {
    expect(() =>
      enablePresetDef({
        slug: 'requirement-analyst',
        modelProviderId: 'prov-1',
        modelName: 'm',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        thinkingJson: { mode: 'bogus', effort: null } as never,
      }),
    ).toThrow(/thinkingJson 形状非法|形状非法/);
  });
});

describe('enablePresetWithJoin — 编排层（DB 断言）', () => {
  it('join + setAsDefault：workspace_agent_members 落行 + default_agent_instance_id 写入', async () => {
    const ws = await createWorkspace(
      { name: '测试 ws', directoryPath: path.join(tmpRoot, 'ws') },
      '@tester:localhost',
    );
    const outcome = await enablePresetWithJoin({
      slug: 'requirement-analyst',
      modelProviderId: 'prov-1',
      modelName: 'glm-4.7',
      joinWorkspaceId: ws.id,
      setAsDefault: true,
    });
    expect(outcome.joinedNow).toBe(true);
    expect(outcome.member).not.toBeNull();
    expect(outcome.member?.agentDefinitionId).toBe('builtin-requirement-analyst');
    // DB 行断言（生产消费的字段）
    const members = listMembers(ws.id);
    expect(members).toHaveLength(1);
    expect(members[0]!.agentUserId).toMatch(/^agent-requirement-analyst-/);
    const wsRow = getDb()
      .prepare('SELECT default_agent_instance_id FROM workspaces WHERE id = ?')
      .get(ws.id) as { default_agent_instance_id: string | null };
    expect(wsRow.default_agent_instance_id).toBe(outcome.member!.instanceId);
  });

  it('不 join：member=null、joinedNow=false', async () => {
    const outcome = await enablePresetWithJoin({
      slug: 'requirement-analyst', modelProviderId: 'prov-1', modelName: 'glm-4.7',
    });
    expect(outcome.member).toBeNull();
    expect(outcome.joinedNow).toBe(false);
  });

  it('join 幂等：重复调用返回既有 member、joinedNow=false、不重复落行', async () => {
    const ws = await createWorkspace(
      { name: '测试 ws 2', directoryPath: path.join(tmpRoot, 'ws2') },
      '@tester:localhost',
    );
    const first = await enablePresetWithJoin({
      slug: 'requirement-analyst', modelProviderId: 'prov-1', modelName: 'glm-4.7',
      joinWorkspaceId: ws.id,
    });
    const second = await enablePresetWithJoin({
      slug: 'requirement-analyst', modelProviderId: 'prov-1', modelName: 'glm-4.7',
      joinWorkspaceId: ws.id,
    });
    expect(second.joinedNow).toBe(false);
    expect(second.member?.instanceId).toBe(first.member?.instanceId);
    expect(listMembers(ws.id)).toHaveLength(1);
  });

  // 编排层源头拒绝——joinWorkspaceId 在 DB 不存在时拒绝继续；不让 def 写入后才发现
  // workspace 不存在导致「半启用态」（def 已落、join 未落，与 enablePresetDef 校验语义对齐）。
  it('未知 joinWorkspaceId 拒绝', async () => {
    await expect(
      enablePresetWithJoin({
        slug: 'requirement-analyst',
        modelProviderId: 'prov-1',
        modelName: 'glm-4.7',
        joinWorkspaceId: 'no-such-ws',
      }),
    ).rejects.toThrow(/未找到 workspace/);
  });
});

describe('loadBuiltinSuggestionsOnly — 启动轻量加载', () => {
  it('只填 suggestions Map，不落 agent_definitions', async () => {
    const { loadBuiltinSuggestionsOnly } = await import('../../src/main/agent/builtin');
    const before = listAgentDefinitions().length;
    loadBuiltinSuggestionsOnly();
    expect(getBuiltinSuggestionsMap()['builtin-requirement-analyst']).toBeDefined();
    expect(listAgentDefinitions().length).toBe(before);
  });
});
