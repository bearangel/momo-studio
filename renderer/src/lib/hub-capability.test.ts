// renderer/src/lib/hub-capability.test.ts
//
// M3.1 门控助手单测：fixture 矩阵与 electron 侧协议包 protocolSupports 语义等值
// （双侧契约锁的另一侧——electron/tests/hub/hub-capability-contract.test.ts 用
// 同一组 fixture 断言两侧结果相等）。fixture 定义在源模块（CAPABILITY_FIXTURES）。
import { describe, expect, it } from 'vitest';
import { hubSupportsMinor } from './hub-capability';

describe('hubSupportsMinor（M3.1 门控——protocolSupports 的 renderer 镜像）', () => {
  it('同 major：minor ≥ required 支持；低于不支持；higher minor 前向兼容', () => {
    expect(hubSupportsMinor('1.3.0', 3)).toBe(true);
    expect(hubSupportsMinor('1.2.0', 3)).toBe(false);
    expect(hubSupportsMinor('1.9.9', 3)).toBe(true);
    expect(hubSupportsMinor('1.3.0', 2)).toBe(true);
    expect(hubSupportsMinor('1.2.0', 2)).toBe(true);
    expect(hubSupportsMinor('1.3.0', 4)).toBe(false);
  });

  it('跨 major 不兼容（2.0.0 对 minor 3 为 false——major 相等才是前提）', () => {
    expect(hubSupportsMinor('2.0.0', 3)).toBe(false);
    expect(hubSupportsMinor('2.9.9', 1)).toBe(false);
  });

  it('非法/未知版本一律 false：无 minor 段、空串、null、undefined、非版本串', () => {
    expect(hubSupportsMinor('1', 3)).toBe(false);
    expect(hubSupportsMinor('', 3)).toBe(false);
    expect(hubSupportsMinor(null, 3)).toBe(false);
    expect(hubSupportsMinor(undefined, 3)).toBe(false);
    expect(hubSupportsMinor('abc', 3)).toBe(false);
  });
});
