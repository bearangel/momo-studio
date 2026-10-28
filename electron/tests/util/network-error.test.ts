// electron/tests/util/network-error.test.ts
//
// 下载层失败人话映射的两个层面：describeNetworkError 服务「fetch 抛错」
// （网络层，M2.5 A2）；describeHttpDownloadFailure 服务 HTTP 非 2xx
// （M3.0 T2——人话进 UI，`HTTP <status> <url>` 原文只进主进程日志）。
//
// 真实 Node fetch 形状：`TypeError: fetch failed`，底层原因在 `cause` 链上
// （ENOTFOUND / ECONNREFUSED / ETIMEDOUT / CERT_* / ECONNRESET），abort 则是
// name='AbortError' 的异常。测试按真实形状构造（momo-test-rules：mock 仿真）。

import { describe, it, expect } from 'vitest';
import {
  describeNetworkError,
  describeHttpDownloadFailure,
} from '../../src/main/util/network-error';

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

describe('describeHttpDownloadFailure（HTTP 非 2xx → 人话，M3.0 T2 映射逐条）', () => {
  it.each([
    [404, '资源包不存在或已下架'],
    [403, '无权访问该资源包'],
    [500, 'hub 服务异常，请稍后重试'],
    [502, 'hub 服务异常，请稍后重试'],
    [503, 'hub 服务异常，请稍后重试'],
    // 418 茶壶态：非 404/403/5xx 的怪异码走兜底条
    [418, '下载失败，请稍后重试'],
    // 401 不再带旧鉴权提示（M2.5 401 hint 随映射表收编退役）——走兜底条
    [401, '下载失败，请稍后重试'],
    [302, '下载失败，请稍后重试'],
  ])('HTTP %i → %s', (status, message) => {
    expect(describeHttpDownloadFailure(status)).toBe(message);
  });

  it('映射文案不含 HTTP 状态码 / 技术原文（UI 无原文——原文只进日志）', () => {
    for (const status of [401, 403, 404, 418, 500, 502]) {
      const message = describeHttpDownloadFailure(status);
      expect(message).not.toContain('HTTP');
      expect(message).not.toContain(String(status));
      expect(message).not.toContain('http');
    }
  });
});
