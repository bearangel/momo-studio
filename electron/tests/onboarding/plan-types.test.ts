// electron/tests/onboarding/plan-types.test.ts
//
// OnboardingPlan shape guard + sanitize 过滤测试（spec 2026-10-10 §6.1/§6.2/§7）：
// 引用只认白名单、slug 只认预制清单、上限截断、越界钳制，剔除一律出 warning。
import { describe, it, expect } from 'vitest';
import { isOnboardingPlan, sanitizePlan } from '../../src/main/onboarding/plan-types';

const CTX = {
  presetSlugs: ['coder', 'pm-agent'],
  mcpNames: ['filesystem', 'web-search'],
  skillSlugs: ['doc-writer'],
};

const VALID_PLAN = {
  agents: [
    { kind: 'preset', slug: 'coder', reason: '写代码', mcps: ['filesystem'], skills: [] },
    {
      kind: 'custom',
      name: '测试员',
      iconEmoji: '🧪',
      systemPrompt: '你是测试员',
      toolPreset: 'standard',
      reason: '补位',
      mcps: ['web-search'],
      skills: ['doc-writer'],
    },
  ],
  defaultAgentIndex: 0,
};

describe('isOnboardingPlan', () => {
  it('合法方案通过', () => {
    expect(isOnboardingPlan(VALID_PLAN)).toBe(true);
  });
  it('agents 空数组拒绝', () => {
    expect(isOnboardingPlan({ agents: [], defaultAgentIndex: 0 })).toBe(false);
  });
  it('defaultAgentIndex 非数字拒绝', () => {
    expect(isOnboardingPlan({ ...VALID_PLAN, defaultAgentIndex: 'x' })).toBe(false);
  });
  it('preset 项缺 slug 拒绝', () => {
    expect(
      isOnboardingPlan({
        agents: [{ kind: 'preset', reason: 'r', mcps: [], skills: [] }],
        defaultAgentIndex: 0,
      }),
    ).toBe(false);
  });
  it('custom 项 toolPreset 非法值拒绝', () => {
    expect(
      isOnboardingPlan({ agents: [{ ...VALID_PLAN.agents[1]!, toolPreset: 'custom' }], defaultAgentIndex: 0 }),
    ).toBe(false);
  });
  it('非对象拒绝', () => {
    expect(isOnboardingPlan('{"agents":[]}')).toBe(false);
  });
});

describe('sanitizePlan', () => {
  it('白名单内的引用保留，白名单外剔除并出 warning', () => {
    const raw = {
      agents: [
        {
          kind: 'preset',
          slug: 'coder',
          reason: 'r',
          mcps: ['filesystem', 'not-registered'],
          skills: ['doc-writer', 'ghost-skill'],
        },
      ],
      defaultAgentIndex: 0,
    };
    const { plan, warnings } = sanitizePlan(raw, CTX);
    expect(plan?.agents[0]).toMatchObject({ mcps: ['filesystem'], skills: ['doc-writer'] });
    expect(warnings.some((w) => w.includes('not-registered'))).toBe(true);
    expect(warnings.some((w) => w.includes('ghost-skill'))).toBe(true);
  });

  it('slug 不在预制清单的项剔除；剔除后空 → plan=null', () => {
    const { plan, warnings } = sanitizePlan(
      {
        agents: [{ kind: 'preset', slug: 'ghost', reason: 'r', mcps: [], skills: [] }],
        defaultAgentIndex: 0,
      },
      CTX,
    );
    expect(plan).toBeNull();
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('defaultAgentIndex 越界钳制到 0 并出 warning', () => {
    const { plan, warnings } = sanitizePlan({ ...VALID_PLAN, defaultAgentIndex: 9 }, CTX);
    expect(plan?.defaultAgentIndex).toBe(0);
    expect(warnings.some((w) => w.includes('defaultAgentIndex'))).toBe(true);
  });

  it('agents 超过 5 截断到前 5 并出 warning', () => {
    const agents = Array.from({ length: 7 }, (_, i) => ({
      kind: 'preset' as const,
      slug: 'coder',
      reason: `r${i}`,
      mcps: [],
      skills: [],
    }));
    const { plan, warnings } = sanitizePlan({ agents, defaultAgentIndex: 0 }, CTX);
    expect(plan?.agents.length).toBe(5);
    expect(warnings.some((w) => w.includes('5'))).toBe(true);
  });

  it('custom 项 name 空白剔除并出 warning', () => {
    const { plan, warnings } = sanitizePlan(
      { agents: [{ ...VALID_PLAN.agents[1]!, name: '  ' }], defaultAgentIndex: 0 },
      CTX,
    );
    expect(plan).toBeNull();
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('整包非法（guard 不过）→ plan=null + warning', () => {
    const { plan, warnings } = sanitizePlan({ foo: 1 }, CTX);
    expect(plan).toBeNull();
    expect(warnings.length).toBeGreaterThan(0);
  });
});
