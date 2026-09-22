// electron/tests/resource/hub/backoff.test.ts
//
// hub 退避负缓存（模式抽自 marketplace/client.ts 的 catalogFailureBackoff）：
// 失败后窗口内零网络重试，recordSuccess 即刻恢复，窗口过期自动恢复。
import { describe, it, expect } from 'vitest';
import { createBackoff } from '../../../src/main/resource/hub/backoff';

describe('hub 退避负缓存（模式抽自 fetchCatalog）', () => {
  it('失败后窗口内 isBackedOff=true，recordSuccess 清除', () => {
    const b = createBackoff('test', 60_000);
    expect(b.isBackedOff()).toBe(false);
    b.recordFailure();
    expect(b.isBackedOff()).toBe(true);
    b.recordSuccess();
    expect(b.isBackedOff()).toBe(false);
  });

  it('rewind 前移窗口可模拟过期', () => {
    const b = createBackoff('test2', 60_000);
    b.recordFailure();
    b.__rewindForTest(60_001);
    expect(b.isBackedOff()).toBe(false);
  });
});
