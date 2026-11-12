// electron/tests/agent/resource-ops-delta-parity.test.ts
// 契约锁（spec §6.4）：主进程 applyCapabilityDelta 与 renderer computeDeltas 同语义。
// capability-helpers.ts 为纯 TS（无 DOM 依赖），跨 workspace 相对导入在 vitest 可行。
import { describe, it, expect } from 'vitest';
import { applyCapabilityDelta } from '../../src/main/agent/resource-ops-delta';
import { computeDeltas, EMPTY_DELTAS } from '../../../renderer/src/lib/capability-helpers';

const base = { tools: ['read_file'], mcps: [], skills: ['create-agent'], baseGrantedPlugin: ['plugin:office/run_js'] };

describe('applyCapabilityDelta 纯语义', () => {
  it('add 已在基线的 ref 不产生冗余 added 条目', () => {
    const out = applyCapabilityDelta(
      base,
      { tools: ['read_file'], mcps: [], skills: ['create-agent'], grantedPlugin: ['plugin:office/run_js'] },
      { add: { skills: ['create-agent'] } },
    );
    expect(out.addedSkills).toEqual([]);   // 已在 L1，无需 delta
    expect(out.removedSkills).toEqual([]);
  });

  it('remove 基线自有 ref 记入 removed（member 分支语义）', () => {
    const out = applyCapabilityDelta(
      base,
      { tools: ['read_file'], mcps: [], skills: ['create-agent'], grantedPlugin: ['plugin:office/run_js'] },
      { remove: { tools: ['read_file'] } },
    );
    expect(out.removedTools).toEqual(['read_file']);
    expect(out.addedTools).toEqual([]);
  });

  it('同 ref 同现 add+remove → remove 胜（与 mergeCapabilities 保守语义对齐）', () => {
    // brief 修正：current 须与 base 一致（brief 原文 tools:[] 相对基线 ['read_file']
    // 是状态漂移，会把 read_file 误记 removed——本用例只验证 bash 的 add+remove 抵消）
    const out = applyCapabilityDelta(
      base,
      { tools: ['read_file'], mcps: [], skills: ['create-agent'], grantedPlugin: ['plugin:office/run_js'] },
      { add: { tools: ['bash'] }, remove: { tools: ['bash'] } },
    );
    expect(out.addedTools).toEqual([]);
    expect(out.removedTools).toEqual([]); // 既非基线也无净变化
  });

  it('plugin 双向：remove 基线授权 → removedPluginTools；再 add 新插件 → addedPluginTools', () => {
    const out = applyCapabilityDelta(
      base,
      { tools: ['read_file'], mcps: [], skills: [], grantedPlugin: ['plugin:office/run_js'] },
      { add: { pluginTools: ['plugin:email/send'] }, remove: { pluginTools: ['plugin:office/run_js'] } },
    );
    expect(out.addedPluginTools).toEqual(['plugin:email/send']);
    expect(out.removedPluginTools).toEqual(['plugin:office/run_js']);
  });

  it('空请求 → 全空 deltas（no-op）', () => {
    // brief 修正：no-op 语义成立的前提是 current 与 base 一致（brief 原文 skills/
    // grantedPlugin 为空相对基线是漂移，正确产出 removed*——与本用例意图相悖）
    const out = applyCapabilityDelta(
      base,
      { tools: ['read_file'], mcps: [], skills: ['create-agent'], grantedPlugin: ['plugin:office/run_js'] },
      {},
    );
    expect(out).toEqual({ ...EMPTY_DELTAS, addedPluginTools: [], removedPluginTools: [] });
  });
});

describe('parity：与 renderer computeDeltas 同输入同输出（spec §6.4 同源铁律）', () => {
  const cases: Array<{ name: string; base: ReturnType<typeof mkCaps>; value: ReturnType<typeof mkCaps> }> = [];
  const mkCaps = (t: string[], m: string[], s: string[]) => ({ tools: t, mcps: m, skills: s });

  it('parity-1 加新技能后 effective 集 → 双侧 deltas 全等', () => {
    const value = mkCaps(['read_file'], [], ['create-agent', 'weather']);
    cases.push({ name: 'p1', base: mkCaps(base.tools, [], ['create-agent']), value });
    const ours = applyCapabilityDelta(
      { ...base, baseGrantedPlugin: [] },
      { tools: base.tools, mcps: [], skills: ['create-agent'], grantedPlugin: [] },
      { add: { skills: ['weather'] } },
    );
    const theirs = computeDeltas(value, mkCaps(base.tools, [], ['create-agent']));
    expect({ a: ours.addedSkills, r: ours.removedSkills }).toEqual({ a: theirs.addedSkills, r: theirs.removedSkills });
    expect(ours.addedSkills).toEqual(['weather']);
  });

  it('parity-2 既有 added 被撤销 → added 剔除而非记 removed', () => {
    // 现状：weather 是旧 delta 加进来的（不在基线）；remove weather 后应回到全空
    const ours = applyCapabilityDelta(
      { ...base, skills: ['create-agent'], baseGrantedPlugin: [] },
      { tools: base.tools, mcps: [], skills: ['create-agent', 'weather'], grantedPlugin: [] },
      { remove: { skills: ['weather'] } },
    );
    const theirs = computeDeltas(mkCaps(base.tools, [], ['create-agent']), mkCaps(base.tools, [], ['create-agent']));
    expect(ours.addedSkills).toEqual([]);
    expect(ours.removedSkills).toEqual([]);
    expect(theirs.addedSkills).toEqual([]);
  });

  it('parity-3 基线自带 ref 被 remove → removed 记录（双侧一致）', () => {
    const ours = applyCapabilityDelta(
      { ...base, baseGrantedPlugin: [] },
      { tools: base.tools, mcps: [], skills: ['create-agent'], grantedPlugin: [] },
      { remove: { skills: ['create-agent'] } },
    );
    const theirs = computeDeltas(mkCaps(base.tools, [], []), mkCaps(base.tools, [], ['create-agent']));
    expect(ours.removedSkills).toEqual(['create-agent']);
    expect(theirs.removedSkills).toEqual(['create-agent']);
  });
});
