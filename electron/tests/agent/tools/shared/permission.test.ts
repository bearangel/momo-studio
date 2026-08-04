// electron/tests/agent/tools/shared/permission.test.ts
//
// 验证工具权限白名单 + 通配符匹配：
//   - 后缀通配符（lsp_* / git_* / mcp:github:*）匹配多个工具
//   - 通配符不会错误匹配前缀不同的工具
//   - denied 优先于 allowed（含通配符场景）
//   - 精确匹配仍然有效（向后兼容）

import { describe, it, expect } from 'vitest';
import { assertToolAllowed } from '../../../../src/main/agent/tools/shared/permission';

describe('assertToolAllowed - 通配符', () => {
  const config = (allowed: string[], denied: string[]) => ({ allowedTools: allowed, deniedTools: denied });

  it('通配符后缀匹配：lsp_* 匹配 lsp_diagnostics', () => {
    expect(() => assertToolAllowed('lsp_diagnostics', config(['lsp_*'], []))).not.toThrow();
    expect(() => assertToolAllowed('lsp_find_references', config(['lsp_*'], []))).not.toThrow();
  });

  it('通配符不匹配前缀不同的工具', () => {
    expect(() => assertToolAllowed('bash', config(['lsp_*'], []))).toThrow(/不在允许列表/);
  });

  it('denied 通配符优先于 allowed', () => {
    expect(() => assertToolAllowed('git_commit', config(['git_*'], ['git_commit']))).toThrow(/被禁止/);
  });

  it('精确匹配仍然有效（向后兼容）', () => {
    expect(() => assertToolAllowed('bash', config(['bash'], []))).not.toThrow();
    expect(() => assertToolAllowed('bash', config(['ls'], []))).toThrow(/不在允许列表/);
  });
});
