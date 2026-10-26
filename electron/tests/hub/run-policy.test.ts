// L0 权限档位语义单源契约锁（M2.1 T10，plan 契约区 PermissionTier）——
// 纯函数直测（零 DB 零 mock）：
//   - 三档→运行时预配映射矩阵（readonly=零写授权+prompt 前置只读约束段 /
//     sandbox=预授予镜像工作空间目录写授权 / confirm=不自动拒的现状默认）
//   - normalizeTier 协议未知容忍（hub 1.2.0 parseDelegationTask 白名单重建剥离
//     permissionTier——缺省/非法值一律按 confirm 收敛，未来 hub 透传后直接消费）
//   - composeTurnBody：readonly 档任务书前只读约束段（含「违反将被拒绝」明示）；
//     sandbox/confirm 档原文直返不加前缀
import { describe, expect, it } from 'vitest';
import {
  READONLY_PROMPT_PREFIX,
  composeTurnBody,
  isPermissionTier,
  normalizeTier,
  planRunPolicy,
  type PermissionTier,
} from '../../src/main/hub/run-policy';

describe('run-policy — 三档→运行时预配映射矩阵', () => {
  it('1. readonly：清会话级写授权（零授权面）+ 任务书前置只读约束段', () => {
    const plan = planRunPolicy('readonly');
    expect(plan.grant).toBe('clear-session');
    expect(plan.promptPrefix).toBe(READONLY_PROMPT_PREFIX);
  });

  it('2. sandbox：预授予镜像工作空间目录写授权 + 不加 prompt 前缀', () => {
    const plan = planRunPolicy('sandbox');
    expect(plan.grant).toBe('grant-workspace-dir');
    expect(plan.promptPrefix).toBeNull();
  });

  it('3. confirm：不动授权面（不自动拒，现状默认）+ 不加 prompt 前缀', () => {
    const plan = planRunPolicy('confirm');
    expect(plan.grant).toBe('none');
    expect(plan.promptPrefix).toBeNull();
  });

  it('4. 三档映射穷举（tier 全集各得一档，无共享 grant 动作）', () => {
    const tiers: PermissionTier[] = ['readonly', 'sandbox', 'confirm'];
    const grants = tiers.map((t) => planRunPolicy(t).grant);
    expect(new Set(grants).size).toBe(3);
  });
});

describe('run-policy — 只读约束段文案', () => {
  it('5. 前缀段明示只读约束与「违反将被拒绝」（worker agent 可执行的行为契约）', () => {
    expect(READONLY_PROMPT_PREFIX).toContain('只读');
    expect(READONLY_PROMPT_PREFIX).toContain('违反将被拒绝');
    // 段落形态：完整可读文案（非占位符）
    expect(READONLY_PROMPT_PREFIX.length).toBeGreaterThan(10);
  });
});

describe('run-policy — composeTurnBody 前置语义', () => {
  const PROMPT = '请排查登录超时问题，输出修复说明。';

  it('6. readonly：约束段在前、任务书在后（前缀不吞并任务书）', () => {
    const body = composeTurnBody('readonly', PROMPT);
    expect(body.startsWith(READONLY_PROMPT_PREFIX)).toBe(true);
    expect(body.endsWith(PROMPT)).toBe(true);
    // 两段之间有分隔（前缀段独立成段）
    expect(body).toBe(`${READONLY_PROMPT_PREFIX}\n\n${PROMPT}`);
  });

  it('7. sandbox / confirm：任务书原文直返（零前缀注入）', () => {
    expect(composeTurnBody('sandbox', PROMPT)).toBe(PROMPT);
    expect(composeTurnBody('confirm', PROMPT)).toBe(PROMPT);
  });
});

describe('run-policy — 协议未知容忍（hub 1.2.0 剥离 permissionTier）', () => {
  it('8. isPermissionTier：三合法值真；undefined/null/非法串/对象假', () => {
    expect(isPermissionTier('readonly')).toBe(true);
    expect(isPermissionTier('sandbox')).toBe(true);
    expect(isPermissionTier('confirm')).toBe(true);
    expect(isPermissionTier(undefined)).toBe(false);
    expect(isPermissionTier(null)).toBe(false);
    expect(isPermissionTier('root')).toBe(false);
    expect(isPermissionTier('')).toBe(false);
    expect(isPermissionTier({ tier: 'readonly' })).toBe(false);
  });

  it('9. normalizeTier：合法值透传；缺省/非法值收敛 confirm（不抛）', () => {
    expect(normalizeTier('readonly')).toBe('readonly');
    expect(normalizeTier('sandbox')).toBe('sandbox');
    expect(normalizeTier('confirm')).toBe('confirm');
    expect(normalizeTier(undefined)).toBe('confirm');
    expect(normalizeTier('root')).toBe('confirm');
    expect(normalizeTier(42)).toBe('confirm');
  });
});
