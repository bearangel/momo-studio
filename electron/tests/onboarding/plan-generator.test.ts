// electron/tests/onboarding/plan-generator.test.ts
//
// plan-generator 测试（spec 2026-10-10 §6.1）：prompt 组装 / 围栏剥离 /
// 4000 截断 / 静默修复一轮 / 两轮失败上抛 / provider 校验。
// LLM 经 PlanDeps 注入 mock——保真边界在 LLMResponse 形状（momo-test-rules）。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';
import { setKeychainImpl } from '../../src/main/storage/keychain';
import { setBuiltinAgentsDir } from '../../src/main/agent/builtin';
import type { LLMResponse } from '../../src/main/agent/llm-provider';
import {
  generateOnboardingPlan,
  buildPlanPrompt,
  stripJsonFence,
  type PlanDeps,
} from '../../src/main/onboarding/plan-generator';

const tmpRoot = path.join(os.tmpdir(), `onboarding-gen-${Date.now()}`);

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

/** LLMResponse 形状保真（mock 边界与真实一致） */
function llmReply(content: string): LLMResponse {
  return { content, toolCalls: [], finishReason: 'stop' };
}

const VALID_PLAN_JSON = JSON.stringify({
  agents: [
    { kind: 'preset', slug: 'requirement-analyst', reason: '梳理需求', mcps: [], skills: [] },
  ],
  defaultAgentIndex: 0,
});

function seedProvider(): void {
  getDb().prepare(
    `INSERT INTO model_providers (id, name, base_url, api_key_ref, default_model, is_default, created_at, platform, preset_key)
     VALUES ('prov-1', '测试供应商', 'https://api.test/v1', 'provider.prov-1.api_key', NULL, 1, datetime('now'), 'openai', NULL)`,
  ).run();
}

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  // keychain 注入（memory/extraction.test.ts 同款惯例）：prov-1 的 key 恒可解析
  setKeychainImpl({
    async getSecret(key: string) {
      return key === 'provider.prov-1.api_key' ? 'sk-test' : null;
    },
    async setSecret() {},
    async deleteSecret() {},
  });
  const agentDir = path.join(tmpRoot, 'agents');
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, 'requirement-analyst.yaml'), VALID_YAML, 'utf-8');
  setBuiltinAgentsDir(agentDir);
  seedProvider();
});

afterEach(() => {
  closeDb();
  setBuiltinAgentsDir(null);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

describe('stripJsonFence', () => {
  it('剥离 ```json 围栏', () => {
    expect(stripJsonFence('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });
  it('无围栏原样返回', () => {
    expect(stripJsonFence('{"a":1}')).toBe('{"a":1}');
  });
  it('前后杂文取首个 { 到末个 } 的片段', () => {
    expect(stripJsonFence('好的，这是方案：{"a":1} 以上')).toBe('{"a":1}');
  });
});

describe('buildPlanPrompt', () => {
  it('系统指令含 schema 描述与硬性规则，上下文含预制/MCP/skill 白名单，用户消息含需求', () => {
    const { system, user } = buildPlanPrompt({
      requirement: '我要写周报',
      presets: [
        {
          slug: 'requirement-analyst',
          name: '需求讨论师',
          description: '梳理需求',
          systemPrompt: '',
          tools: [],
          mcps: [],
          skills: [],
          iconEmoji: '📋',
        },
      ],
      mcpNames: ['filesystem'],
      skills: [{ slug: 'doc-writer', name: '文档写手', description: '写文档' }],
    });
    expect(system).toContain('JSON');
    expect(system).toContain('preset');
    expect(system).toContain('filesystem');
    expect(user).toContain('我要写周报');
  });
});

describe('generateOnboardingPlan', () => {
  const baseInput = { requirement: '帮我做需求分析', providerId: 'prov-1', modelId: 'glm-test' };

  it('合法 JSON 直接产出方案', async () => {
    const deps: PlanDeps = { callLlm: async () => llmReply(VALID_PLAN_JSON) };
    const { plan } = await generateOnboardingPlan(baseInput, deps);
    expect(plan.agents[0]).toMatchObject({ kind: 'preset', slug: 'requirement-analyst' });
  });

  it('围栏包裹的 JSON 可解析（Review Focus 1）', async () => {
    const deps: PlanDeps = {
      callLlm: async () => llmReply('```json\n' + VALID_PLAN_JSON + '\n```'),
    };
    const { plan } = await generateOnboardingPlan(baseInput, deps);
    expect(plan.agents.length).toBe(1);
  });

  it('第一轮解析失败 → 静默修复一轮成功', async () => {
    let calls = 0;
    const deps: PlanDeps = {
      callLlm: async () => {
        calls += 1;
        return calls === 1 ? llmReply('我觉得你应该自己配') : llmReply(VALID_PLAN_JSON);
      },
    };
    const { plan } = await generateOnboardingPlan(baseInput, deps);
    expect(calls).toBe(2);
    expect(plan.agents.length).toBe(1);
  });

  it('两轮失败 → 中文错误上抛', async () => {
    const deps: PlanDeps = { callLlm: async () => llmReply('仍然不是 JSON') };
    await expect(generateOnboardingPlan(baseInput, deps)).rejects.toThrow('格式无效');
  });

  it('供应商不存在 → 中文错误（Review Focus 3）', async () => {
    const deps: PlanDeps = { callLlm: async () => llmReply(VALID_PLAN_JSON) };
    await expect(
      generateOnboardingPlan({ ...baseInput, providerId: 'ghost' }, deps),
    ).rejects.toThrow('供应商不存在');
  });

  it('API key 为空 → 中文错误，不产生半配置（Review Focus 3 另一半）', async () => {
    // 覆盖 keychain stub：prov-1 的 key 解析为 null
    setKeychainImpl({
      async getSecret() {
        return null;
      },
      async setSecret() {},
      async deleteSecret() {},
    });
    const deps: PlanDeps = { callLlm: async () => llmReply(VALID_PLAN_JSON) };
    await expect(generateOnboardingPlan(baseInput, deps)).rejects.toThrow('API key 未配置');
  });

  it('需求超 4000 字符截断（Review Focus 6）', async () => {
    let seen = '';
    const deps: PlanDeps = {
      callLlm: async (messages) => {
        seen = messages.map((m) => m.content).join('\n');
        return llmReply(VALID_PLAN_JSON);
      },
    };
    await generateOnboardingPlan({ ...baseInput, requirement: '长'.repeat(5000) }, deps);
    expect(seen.includes('长'.repeat(4000))).toBe(true);
    expect(seen.includes('长'.repeat(4001))).toBe(false);
  });
});
