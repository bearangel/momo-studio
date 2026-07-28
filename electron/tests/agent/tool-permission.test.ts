// electron/tests/agent/tool-permission.test.ts
//
// 验证工具权限白名单判定（纯单元测试）：
//   - deniedTools 命中即拒绝（优先级最高）
//   - allowedTools 非空时，不在列表即拒绝（白名单模式）
//   - allowedTools 为空时全部放行（非白名单模式）
//   - denied 优先于 allowed（同时在两边也拒绝）
//   - 全空时全部放行

import { describe, it, expect } from 'vitest';
import { assertToolAllowed } from '../../src/main/agent/tool-permission';

describe('agent/tool-permission 权限白名单', () => {
  it('deniedTools 命中即拒绝', () => {
    expect(() =>
      assertToolAllowed('write_file', { allowedTools: [], deniedTools: ['write_file'] }),
    ).toThrow(/被禁止使用/);
  });

  it('allowedTools 非空时，不在列表即拒绝', () => {
    expect(() =>
      assertToolAllowed('write_file', { allowedTools: ['read_file'], deniedTools: [] }),
    ).toThrow(/不在允许列表中/);
  });

  it('allowedTools 非空且在列表中 → 放行', () => {
    expect(() =>
      assertToolAllowed('read_file', { allowedTools: ['read_file', 'list_files'], deniedTools: [] }),
    ).not.toThrow();
  });

  it('allowedTools 为空 → 全部放行（非白名单模式）', () => {
    expect(() =>
      assertToolAllowed('write_file', { allowedTools: [], deniedTools: [] }),
    ).not.toThrow();
  });

  it('denied 优先于 allowed（同时在两边也拒绝）', () => {
    expect(() =>
      assertToolAllowed('read_file', {
        allowedTools: ['read_file'],
        deniedTools: ['read_file'],
      }),
    ).toThrow(/被禁止使用/);
  });

  it('全空时全部放行', () => {
    expect(() => assertToolAllowed('any_tool', { allowedTools: [], deniedTools: [] })).not.toThrow();
  });

  it('MCP 工具名（含冒号）也能被正常匹配', () => {
    const name = 'mcp:github:create_issue';
    expect(() =>
      assertToolAllowed(name, { allowedTools: [], deniedTools: [name] }),
    ).toThrow(/被禁止使用/);
    expect(() =>
      assertToolAllowed(name, { allowedTools: [name], deniedTools: [] }),
    ).not.toThrow();
  });
});
