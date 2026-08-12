// electron/tests/resource/types.test.ts
//
// v1.7 资源库类型 + ID 工具的单元测试。覆盖：
//   1. buildResourceId 拼接命名约定
//   2. parseResourceId 反解三元组（含 UUID slug）
//   3. parseResourceId 非法 id 返回 null（空 slug / 未知 source / 未知 type）
//   4. buildResourceId ↔ parseResourceId 互逆
//   5. sourceLabel 中文文案

import { describe, it, expect } from 'vitest';
import {
  buildResourceId, parseResourceId, sourceLabel,
  type ResourceItem, type ResourceFilter,
} from '../../src/main/resource/types';

describe('resource/types', () => {
  it('buildResourceId 拼 ${source}-${type}-${slug}', () => {
    expect(buildResourceId('builtin', 'agent', 'pm-agent')).toBe('builtin-agent-pm-agent');
    expect(buildResourceId('custom', 'mcp', 'github')).toBe('custom-mcp-github');
    expect(buildResourceId('custom', 'agent', 'uuid-abc-123')).toBe('custom-agent-uuid-abc-123');
  });

  it('parseResourceId 反解三元组', () => {
    expect(parseResourceId('builtin-skill-code-review')).toEqual({
      source: 'builtin', type: 'skill', slug: 'code-review',
    });
    expect(parseResourceId('custom-agent-abc-123-def')).toEqual({
      source: 'custom', type: 'agent', slug: 'abc-123-def',
    });
  });

  it('parseResourceId 非法 id 返回 null', () => {
    expect(parseResourceId('invalid')).toBeNull();
    expect(parseResourceId('builtin-agent-')).toBeNull();  // 空 slug
    expect(parseResourceId('unknown-agent-foo')).toBeNull();  // 未知 source
    expect(parseResourceId('builtin-unknown-foo')).toBeNull();  // 未知 type
  });

  it('buildResourceId ↔ parseResourceId 互逆', () => {
    const cases = [
      ['builtin', 'agent', 'pm-agent'],
      ['custom', 'mcp', 'github'],
      ['marketplace', 'skill', 'xlsx-remote'],
    ] as const;
    for (const [s, t, slug] of cases) {
      const id = buildResourceId(s, t, slug);
      expect(parseResourceId(id)).toEqual({ source: s, type: t, slug });
    }
  });

  it('sourceLabel 中文文案', () => {
    expect(sourceLabel('builtin')).toBe('系统预置');
    expect(sourceLabel('custom')).toBe('我的上传');
    expect(sourceLabel('marketplace')).toBe('网络资源');
    expect(sourceLabel('p2p')).toBe('P2P 共享');
  });
});
