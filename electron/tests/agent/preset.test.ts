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
