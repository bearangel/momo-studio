// electron/tests/resource/compose-remote-config.test.ts
//
// P2.2 Task 2：composeRemoteConfig（x-from 分流组装，安装/编辑共用单点）测试。
// 纯函数零依赖——不建 DB、不 mock 任何边界（momo-test-rules 铁律 5）。
// 覆盖面：
//   - x-from=query 字段 encodeURIComponent 拼进 URL（无 ? 用 '?'，已带 ? 用 '&'）
//   - x-from=header 显式 / 缺省（无 schema、字段无 x-from）→ 进 headers（spec D5）
//   - 空串值剔除（编辑链表单可选字段留空不产生占位项；安装链既有测试守护等价）
//   - 空 config / 全空串 → finalUrl 原样、headers 空
//   - 非 https url（http:// / 空 / 其他 scheme）→ 抛中文错误（momo-test-rules 铁律 3）
//
// Task 4 编辑链消费契约在此锁死：返回形状 { finalUrl, headers } 供
// registerMcpDefinition 更新消费（不改签名需同步本文件与安装链）。

import { describe, it, expect } from 'vitest';
import { composeRemoteConfig } from '../../src/main/resource/hub-install';

describe('composeRemoteConfig x-from 分流', () => {
  it('x-from=query 拼 URL（encodeURIComponent key 与 value）+ x-from=header 进 headers', () => {
    const { finalUrl, headers } = composeRemoteConfig(
      'https://brave.run.tools',
      { braveApiKey: 'k1', projectId: 'p1' },
      {
        properties: {
          braveApiKey: { 'x-from': 'header' },
          projectId: { 'x-from': 'query' },
        },
      },
    );
    expect(finalUrl).toBe('https://brave.run.tools?projectId=p1');
    expect(headers).toEqual({ braveApiKey: 'k1' });
  });

  it('url 已带 ? → 追加用 & 分支', () => {
    const { finalUrl } = composeRemoteConfig(
      'https://srv.run.tools?preset=default',
      { token: 't1' },
      { properties: { token: { 'x-from': 'query' } } },
    );
    expect(finalUrl).toBe('https://srv.run.tools?preset=default&token=t1');
  });

  it('多个 query 字段按 config 插入序拼接', () => {
    const { finalUrl } = composeRemoteConfig(
      'https://srv.run.tools',
      { b: '2', a: '1' },
      {
        properties: { a: { 'x-from': 'query' }, b: { 'x-from': 'query' } },
      },
    );
    expect(finalUrl).toBe('https://srv.run.tools?b=2&a=1');
  });

  it('query key 与 value 特殊字符均 encodeURIComponent（S1 注入防线）', () => {
    const { finalUrl } = composeRemoteConfig(
      'https://esc.run.tools',
      { 'k&y': 'a b&c' },
      { properties: { 'k&y': { 'x-from': 'query' } } },
    );
    expect(finalUrl).toBe('https://esc.run.tools?k%26y=a%20b%26c');
  });

  it('无 schema → 全部缺省进 headers（spec D5，ipc 直装路径）', () => {
    const { finalUrl, headers } = composeRemoteConfig('https://plain.run.tools', {
      token: 't1',
      region: 'r1',
    });
    expect(finalUrl).toBe('https://plain.run.tools');
    expect(headers).toEqual({ token: 't1', region: 'r1' });
  });

  it('schema 有 properties 但字段无 x-from → 同样缺省进 headers', () => {
    const { finalUrl, headers } = composeRemoteConfig(
      'https://no-xfrom.run.tools',
      { apiKey: 'a1' },
      { properties: { apiKey: { title: 'API Key' } } },
    );
    expect(finalUrl).toBe('https://no-xfrom.run.tools');
    expect(headers).toEqual({ apiKey: 'a1' });
  });

  it('空串值剔除：header 与 query 字段均不产生占位项', () => {
    const { finalUrl, headers } = composeRemoteConfig(
      'https://empty.run.tools',
      { apiKey: '', token: 't1', projectId: '' },
      {
        properties: {
          apiKey: { 'x-from': 'header' },
          token: { 'x-from': 'header' },
          projectId: { 'x-from': 'query' },
        },
      },
    );
    expect(finalUrl).toBe('https://empty.run.tools');
    expect(headers).toEqual({ token: 't1' });
  });

  it('空 config → finalUrl 原样、headers 空', () => {
    const { finalUrl, headers } = composeRemoteConfig('https://none.run.tools', {});
    expect(finalUrl).toBe('https://none.run.tools');
    expect(headers).toEqual({});
  });

  it('全空串 config → 等价空 config（url 不带尾随 ?）', () => {
    const { finalUrl, headers } = composeRemoteConfig(
      'https://all-empty.run.tools',
      { a: '', b: '' },
      { properties: { a: { 'x-from': 'query' }, b: { 'x-from': 'query' } } },
    );
    expect(finalUrl).toBe('https://all-empty.run.tools');
    expect(headers).toEqual({});
  });

  it('http:// url → 抛中文错误（含原始 url）', () => {
    expect(() => composeRemoteConfig('http://insecure.run.tools', {})).toThrow(
      '远程 MCP url 必须以 https:// 开头: http://insecure.run.tools',
    );
  });

  it('空 url / 非 http scheme → 同一防线拒绝', () => {
    expect(() => composeRemoteConfig('', {})).toThrow(/https/);
    expect(() => composeRemoteConfig('ftp://srv.run.tools', {})).toThrow(/https/);
  });
});
