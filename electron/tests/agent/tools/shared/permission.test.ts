// electron/tests/agent/tools/shared/permission.test.ts
//
// 验证工具权限白名单 + 通配符匹配：
//   - 后缀通配符（lsp_* / git_* / mcp:github:*）匹配多个工具
//   - 通配符不会错误匹配前缀不同的工具
//   - denied 优先于 allowed（含通配符场景）
//   - 精确匹配仍然有效（向后兼容）

import { describe, it, expect } from 'vitest';
import { assertToolAllowed, filterVisibleToolDefs } from '../../../../src/main/agent/tools/shared/permission';

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

// ── 插件工具豁免（P2，spec §4.2：可见性=装配面；allowed 不筛插件名，denied 生效）──

describe('插件工具权限豁免（P2）', () => {
  it('allowedTools 白名单不含插件名时不阻断', () => {
    expect(() =>
      assertToolAllowed('plugin:sample-echo/echo', { allowedTools: ['read_file'], deniedTools: [] }),
    ).not.toThrow();
  });

  it('deniedTools 精确名 / plugin:<id>/* 前缀仍禁用', () => {
    expect(() =>
      assertToolAllowed('plugin:sample-echo/echo', { allowedTools: [], deniedTools: ['plugin:sample-echo/*'] }),
    ).toThrow(/被禁止/);
    expect(() =>
      assertToolAllowed('plugin:sample-echo/echo', { allowedTools: [], deniedTools: ['plugin:sample-echo/echo'] }),
    ).toThrow(/被禁止/);
  });
});

// ── I1：可见面过滤（filterVisibleToolDefs 纯函数，含 plugin 豁免与通配 denied）──

describe('filterVisibleToolDefs（P2 审查 I1）', () => {
  const defs = [
    { name: 'read_file', description: 'a', inputSchema: {} },
    { name: 'bash', description: 'a', inputSchema: {} },
    { name: 'plugin:cg/echo', description: 'a', inputSchema: {} },
  ];

  it('非插件 denied：allowed 空或含该名都必须隐藏（回归锁——运算符优先级）', () => {
    expect(filterVisibleToolDefs(defs, [], ['bash']).map((d) => d.name)).toEqual([
      'read_file',
      'plugin:cg/echo',
    ]);
    // denied+allowed 同含 bash → deny 胜出隐藏；read_file 不在白名单亦隐藏；
    // 插件工具豁免白名单保持可见
    expect(filterVisibleToolDefs(defs, ['bash'], ['bash']).map((d) => d.name)).toEqual([
      'plugin:cg/echo',
    ]);
  });

  it('插件工具豁免 allowed 白名单；精确名与 plugin:<id>/* 通配 denied 生效', () => {
    expect(filterVisibleToolDefs(defs, ['read_file'], []).map((d) => d.name)).toEqual([
      'read_file',
      'plugin:cg/echo',
    ]);
    expect(
      filterVisibleToolDefs(defs, [], ['plugin:cg/*']).map((d) => d.name),
    ).toEqual(['read_file', 'bash']);
    expect(
      filterVisibleToolDefs(defs, [], ['plugin:cg/echo']).map((d) => d.name),
    ).toEqual(['read_file', 'bash']);
  });
});

// ── 工作空间维度 v1.1（spec 2026-10-17 §7.2）：插件工具 denied 门控（Review Focus #5） ──
describe('deniedTools plugin 前缀门控（跨域无误伤）', () => {
  const cfg = { allowedTools: [], deniedTools: ['plugin:codegraph/*'] };

  it('plugin:codegraph/* 命中该插件全部工具，不伤 builtin 与他插件', () => {
    expect(() => assertToolAllowed('plugin:codegraph/explore', cfg)).toThrow(/被禁止/);
    expect(() => assertToolAllowed('plugin:codegraph/status', cfg)).toThrow(/被禁止/);
    expect(() => assertToolAllowed('read_file', cfg)).not.toThrow();
    expect(() => assertToolAllowed('plugin:codegraph2/x', cfg)).not.toThrow(); // 前缀碰撞免疫（'/' 分隔）
  });

  it('deny 精确名 read_file 不影响插件工具；插件精确名单独禁', () => {
    const cfg2 = { allowedTools: [], deniedTools: ['read_file'] };
    expect(() => assertToolAllowed('plugin:codegraph/explore', cfg2)).not.toThrow();
    expect(() => assertToolAllowed('read_file', cfg2)).toThrow(/被禁止/);
    const cfg3 = { allowedTools: [], deniedTools: ['plugin:codegraph/explore'] };
    expect(() => assertToolAllowed('plugin:codegraph/explore', cfg3)).toThrow(/被禁止/);
    expect(() => assertToolAllowed('plugin:codegraph/status', cfg3)).not.toThrow();
  });
});
