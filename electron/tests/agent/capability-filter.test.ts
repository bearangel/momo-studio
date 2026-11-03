// 失效工具 ref 过滤锁（spec 2026-11-03 §6.3）：office 生成类下线后，存量 agent
// 的 defaultTools 引用失效时过滤 + warn 可自诊。
import { describe, expect, it } from 'vitest';
import { dropUnknownToolRefs } from '../../src/main/agent/capability-merger';

describe('dropUnknownToolRefs', () => {
  it('已知 ref 保留；未知 ref（已下线工具）丢弃并回报', () => {
    const known = new Set(['office_read', 'plugin:office-pro/run_js', 'read_file']);
    const { kept, dropped } = dropUnknownToolRefs(
      ['office_read', 'office_create_ppt', 'plugin:office-pro/run_js', 'bash'],
      known,
    );
    expect(kept).toEqual(['office_read', 'plugin:office-pro/run_js']);
    expect(dropped).toEqual(['office_create_ppt', 'bash']);
  });

  it('全已知 → 无丢弃', () => {
    const known = new Set(['a', 'b']);
    expect(dropUnknownToolRefs(['a', 'b'], known)).toEqual({ kept: ['a', 'b'], dropped: [] });
  });

  it('空 refs → 空结果（不抛）', () => {
    expect(dropUnknownToolRefs([], new Set(['a']))).toEqual({ kept: [], dropped: [] });
  });
});
