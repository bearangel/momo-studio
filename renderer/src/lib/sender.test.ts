import { describe, expect, it } from 'vitest';
import { isSystemSender, isTurnAnchor } from './sender';

describe('sender 语义守卫', () => {
  it('system 行命中 isSystemSender；owner/agent/remote 前缀不命中', () => {
    expect(isSystemSender('system')).toBe(true);
    expect(isSystemSender('owner')).toBe(false);
    expect(isSystemSender('agent-pm-agent-1')).toBe(false);
    expect(isSystemSender('')).toBe(false);
  });
  it('回合锚点 = owner 或 system', () => {
    expect(isTurnAnchor('owner')).toBe(true);
    expect(isTurnAnchor('system')).toBe(true);
    expect(isTurnAnchor('agent-coder-1')).toBe(false);
  });
});
