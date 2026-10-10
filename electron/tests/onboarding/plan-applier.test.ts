// electron/tests/onboarding/plan-applier.test.ts
//
// plan-applier 测试（spec 2026-10-10 §6.3）：preset 启用+能力同步 / custom 创建
// （工具档映射）/ 幂等重试 / 应用侧再过滤 / 越界钳制 / workspace 校验 / 空方案拒绝。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { setBuiltinAgentsDir } from '../../src/main/agent/builtin';
import { applyOnboardingPlan } from '../../src/main/onboarding/plan-applier';
import { getAgentDefinition, listMembers, listAgentDefinitions } from '../../src/main/agent/agent-queries';
import { getWorkspace, createWorkspace } from '../../src/main/workspace/crud';
import { SAFE_MINIMUM_TOOLS } from '../../src/main/agent/tools/catalog';

const tmpRoot = path.join(os.tmpdir(), `onboarding-apply-${Date.now()}`);

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

function seedProvider(): void {
  getDb().prepare(
    `INSERT INTO model_providers (id, name, base_url, api_key_ref, default_model, is_default, created_at, platform, preset_key)
     VALUES ('prov-1', '测试供应商', 'https://api.test/v1', 'provider.prov-1.api_key', NULL, 1, datetime('now'), 'openai', NULL)`,
  ).run();
}

let wsId = '';

beforeEach(async () => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  const agentDir = path.join(tmpRoot, 'agents');
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, 'requirement-analyst.yaml'), VALID_YAML, 'utf-8');
  setBuiltinAgentsDir(agentDir);
  seedProvider();
  const ws = await createWorkspace(
    { name: '引导测试', directoryPath: path.join(tmpRoot, 'ws') },
    '@tester:localhost',
  );
  wsId = ws.id;
});

afterEach(() => {
  closeDb();
  setBuiltinAgentsDir(null);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

const PRESET_AGENT = {
  kind: 'preset' as const,
  slug: 'requirement-analyst',
  reason: 'r',
  mcps: [] as string[],
  skills: [] as string[],
};
const CUSTOM_AGENT = {
  kind: 'custom' as const,
  name: '测试工程师',
  iconEmoji: '🧪',
  systemPrompt: '你是测试工程师',
  toolPreset: 'standard' as const,
  reason: 'r',
  mcps: [] as string[],
  skills: [] as string[],
};

describe('applyOnboardingPlan', () => {
  it('preset 项：启用 def + 加入成员 + 设默认', async () => {
    const result = await applyOnboardingPlan({
      plan: { agents: [PRESET_AGENT], defaultAgentIndex: 0 },
      workspaceId: wsId,
      providerId: 'prov-1',
      modelId: 'glm-test',
    });
    expect(result.applied.length).toBe(1);
    expect(result.defaultAgentName).toBe('需求讨论师');
    expect(getAgentDefinition('builtin-requirement-analyst')).toBeTruthy();
    expect(listMembers(wsId).length).toBe(1);
    expect(getWorkspace(wsId)?.defaultAgentInstanceId).toBeTruthy();
  });

  it('custom 项：createCustomDef + 工具档映射 standard → SAFE_MINIMUM_TOOLS', async () => {
    const result = await applyOnboardingPlan({
      plan: { agents: [CUSTOM_AGENT], defaultAgentIndex: 0 },
      workspaceId: wsId,
      providerId: 'prov-1',
      modelId: 'glm-test',
    });
    expect(result.applied[0]!.kind).toBe('custom');
    const member = listMembers(wsId)[0]!;
    const def = getAgentDefinition(member.agentDefinitionId);
    expect(def?.source).toBe('custom');
    expect(def?.name).toBe('测试工程师');
    expect(def?.modelProviderId).toBe('prov-1');
    expect(def?.modelName).toBe('glm-test');
    expect(def?.defaultTools.map((t) => t.ref).sort()).toEqual([...SAFE_MINIMUM_TOOLS].sort());
  });

  it('幂等：整包重复应用无重复 def / 成员（Review Focus 2）', async () => {
    const input = {
      plan: { agents: [PRESET_AGENT, CUSTOM_AGENT], defaultAgentIndex: 1 },
      workspaceId: wsId,
      providerId: 'prov-1',
      modelId: 'glm-test',
    };
    await applyOnboardingPlan(input);
    await applyOnboardingPlan(input);
    expect(listMembers(wsId).length).toBe(2);
    // custom 按 name 查重复用：同名 custom def 仅 1 行
    const customs = listAgentDefinitions().filter(
      (d) => d.source === 'custom' && d.name === '测试工程师',
    );
    expect(customs.length).toBe(1);
  });

  it('未注册引用在应用侧再过滤（双保险）+ warning', async () => {
    const result = await applyOnboardingPlan({
      plan: { agents: [{ ...PRESET_AGENT, mcps: ['ghost-mcp'] }], defaultAgentIndex: 0 },
      workspaceId: wsId,
      providerId: 'prov-1',
      modelId: 'glm-test',
    });
    expect(result.warnings.some((w) => w.includes('ghost-mcp'))).toBe(true);
    expect(getAgentDefinition('builtin-requirement-analyst')!.defaultMcps).toEqual([]);
  });

  it('defaultAgentIndex 越界钳制到 0', async () => {
    const result = await applyOnboardingPlan({
      plan: { agents: [PRESET_AGENT], defaultAgentIndex: 5 },
      workspaceId: wsId,
      providerId: 'prov-1',
      modelId: 'glm-test',
    });
    expect(result.defaultAgentName).toBe('需求讨论师');
    expect(result.warnings.some((w) => w.includes('defaultAgentIndex'))).toBe(true);
  });

  it('workspace 不存在 → 中文错误，零副作用', async () => {
    await expect(
      applyOnboardingPlan({
        plan: { agents: [PRESET_AGENT], defaultAgentIndex: 0 },
        workspaceId: 'ghost-ws',
        providerId: 'prov-1',
        modelId: 'glm-test',
      }),
    ).rejects.toThrow('未找到 workspace');
  });

  it('agents 过滤后为空 → 拒绝应用', async () => {
    await expect(
      applyOnboardingPlan({
        plan: {
          agents: [
            { kind: 'preset', slug: 'ghost-slug', reason: 'r', mcps: [], skills: [] },
          ],
          defaultAgentIndex: 0,
        },
        workspaceId: wsId,
        providerId: 'prov-1',
        modelId: 'glm-test',
      }),
    ).rejects.toThrow('无可应用');
  });
});
