// 交付物保真（spec 2026-11-18 §7.3/DEC-19）：
// 1) buildDeliverableReason 超限时保 files/artifacts，只截 summary；
// 2) submitToHub 同时发 deliverable（全量）与 reason（降级串）。
import { describe, it, expect } from 'vitest';
import { buildDeliverableReason } from '../../src/main/hub/remote-intervene-bridge';

describe('buildDeliverableReason', () => {
  it('放得下 → 全量 JSON', () => {
    const out = buildDeliverableReason({ summary: '短摘要', files: ['a.md'] });
    expect(JSON.parse(out)).toEqual({ summary: '短摘要', files: ['a.md'], artifacts: [] });
  });

  it('超限 → 保留 files/artifacts，summary 截断', () => {
    const out = buildDeliverableReason({
      summary: '长'.repeat(2000),
      files: ['二十四节气散文-三个候选主题.md'],
      artifacts: [{ label: '三个候选主题', value: '1. 春雷落处\n2. 长昼如沸' }],
    });
    expect(out.length).toBeLessThanOrEqual(512);
    const parsed = JSON.parse(out) as {
      summary: string;
      files: string[];
      artifacts: Array<{ label: string; value: string }>;
    };
    expect(parsed.files).toEqual(['二十四节气散文-三个候选主题.md']);
    expect(parsed.artifacts).toHaveLength(1);
    expect(parsed.summary.length).toBeLessThan(2000);
  });
});
