// electron/tests/util/user-facing-error.test.ts
//
// M2.4 D1：IPC 出口文案归一的纯函数契约（幂等 / 不吞信息 / 非 Error 抛出物）。
import { describe, it, expect } from 'vitest';
import { toUserFacingError } from '../../src/main/util/user-facing-error';

class HubCatalogStaleError extends Error {
  override readonly name = 'HubCatalogStaleError';
}

describe('toUserFacingError', () => {
  it('剥本地错误类名前缀，name 归一为 Error', () => {
    const e = toUserFacingError(new HubCatalogStaleError('无法连接到 momo-hub 获取最新目录'));
    expect(e.message).toBe('无法连接到 momo-hub 获取最新目录');
    expect(e.name).toBe('Error');
  });

  it('剥 Electron invoke 包装 + 类名前缀', () => {
    const e = toUserFacingError(
      new Error("Error invoking remote method 'resource:install': HubCatalogStaleError: 网络不可用"),
    );
    expect(e.message).toBe('网络不可用');
  });

  it('普通 Error 原文不变（含技术原文 TypeError 形态）', () => {
    const e = toUserFacingError(new TypeError('fetch failed'));
    expect(e.message).toBe('fetch failed');
    expect(e.name).toBe('Error');
  });

  it('非 Error 抛出物走 String()（不吞）', () => {
    expect(toUserFacingError('boom').message).toBe('boom');
    expect(toUserFacingError(undefined).message).toBe('undefined');
  });

  it('幂等：重复归一结果不变', () => {
    const once = toUserFacingError(new HubCatalogStaleError('请稍后重试'));
    const twice = toUserFacingError(once);
    expect(twice.message).toBe('请稍后重试');
  });
});
