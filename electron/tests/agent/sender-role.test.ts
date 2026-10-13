import { describe, expect, it } from 'vitest';
import { mapsToUserRole } from '../../src/main/agent/sender-role';

describe('UI sender → LLM role 单点映射（spec §5.4）', () => {
  it('owner / system / remote / 未知 → user；agent-* → assistant', () => {
    expect(mapsToUserRole('owner')).toBe(true);
    expect(mapsToUserRole('system')).toBe(true);
    expect(mapsToUserRole('remote:node1:owner')).toBe(true);
    expect(mapsToUserRole('')).toBe(true); // 保守降级 user
    expect(mapsToUserRole('weird-unknown')).toBe(true);
    expect(mapsToUserRole('agent-pm-agent-f_ZufQ')).toBe(false);
  });
});
