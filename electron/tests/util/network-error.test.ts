// electron/tests/util/network-error.test.ts
//
// A2：下载层网络失败人话映射。describeNetworkError 只服务「fetch 抛错」这一层；
// 非 2xx 分支的 `下载失败: HTTP n` 不经本函数（零改动）。
//
// 真实 Node fetch 形状：`TypeError: fetch failed`，底层原因在 `cause` 链上
// （ENOTFOUND / ECONNREFUSED / ETIMEDOUT / CERT_* / ECONNRESET），abort 则是
// name='AbortError' 的异常。测试按真实形状构造（momo-test-rules：mock 仿真）。

import { describe, it, expect } from 'vitest';
import { describeNetworkError } from '../../src/main/util/network-error';

/** 构造 fetch 真实失败形状：外层 TypeError('fetch failed')，cause 携带 code */
function fetchErrorWithCode(code: string, causeMessage = `connect ${code}`): Error {
  const cause = Object.assign(new Error(causeMessage), { code });
  return Object.assign(new TypeError('fetch failed'), { cause });
}

describe('describeNetworkError（fetch 抛错 → 人话）', () => {
  it('ENOTFOUND → 无法解析域名', () => {
    expect(describeNetworkError(fetchErrorWithCode('ENOTFOUND'))).toBe('无法解析域名');
  });

  it('EAI_AGAIN → 无法解析域名', () => {
    expect(describeNetworkError(fetchErrorWithCode('EAI_AGAIN'))).toBe('无法解析域名');
  });

  it('ECONNREFUSED → 连接被拒绝', () => {
    expect(describeNetworkError(fetchErrorWithCode('ECONNREFUSED'))).toBe('连接被拒绝');
  });

  it('ETIMEDOUT → 连接超时', () => {
    expect(describeNetworkError(fetchErrorWithCode('ETIMEDOUT'))).toBe('连接超时');
  });

  it('AbortError → 连接超时', () => {
    const err = Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
    expect(describeNetworkError(err)).toBe('连接超时');
  });

  it('CERT_HAS_EXPIRED → 证书校验失败', () => {
    expect(describeNetworkError(fetchErrorWithCode('CERT_HAS_EXPIRED'))).toBe('证书校验失败');
  });

  it('UNABLE_TO_VERIFY_LEAF_SIGNATURE（仅 message 携带）→ 证书校验失败', () => {
    const cause = new Error('unable to verify the first certificate: UNABLE_TO_VERIFY_LEAF_SIGNATURE');
    const err = Object.assign(new TypeError('fetch failed'), { cause });
    expect(describeNetworkError(err)).toBe('证书校验失败');
  });

  it('SELF_SIGNED_CERT_IN_CHAIN → 证书校验失败', () => {
    expect(describeNetworkError(fetchErrorWithCode('SELF_SIGNED_CERT_IN_CHAIN'))).toBe('证书校验失败');
  });

  it('ECONNRESET → 连接被重置', () => {
    expect(describeNetworkError(fetchErrorWithCode('ECONNRESET'))).toBe('连接被重置');
  });

  it('未命中分类 → 回退「网络请求失败」（不猜原因）', () => {
    expect(describeNetworkError(new TypeError('fetch failed'))).toBe('网络请求失败');
  });

  it('空输入 / 非 Error 抛出物 → 回退「网络请求失败」', () => {
    expect(describeNetworkError(undefined)).toBe('网络请求失败');
    expect(describeNetworkError(null)).toBe('网络请求失败');
    expect(describeNetworkError('boom')).toBe('网络请求失败');
    expect(describeNetworkError({})).toBe('网络请求失败');
  });
});
