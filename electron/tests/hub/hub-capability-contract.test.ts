// electron/tests/hub/hub-capability-contract.test.ts
//
// M3.1 双侧契约锁（error-prefix 模式先例）：renderer 侧 hubSupportsMinor（镜像
// 判定，renderer 不能 import 协议包）与 electron 侧协议包 protocolSupports 用
// 同一组字符串 fixture 断言等值——两侧任一漂移（含协议包升 major 未同步镜像的
// PROTOCOL_MAJOR）此测试即红。fixture 从 renderer 源模块导入（CAPABILITY_FIXTURES 单一来源）。
import { describe, expect, it } from 'vitest';
import { protocolSupports } from '../../src/main/hub/protocol';
import { hubSupportsMinor, CAPABILITY_FIXTURES } from '../../../renderer/src/lib/hub-capability';

describe('hub-capability 双侧契约（M3.1）', () => {
  it('同组 fixture：renderer hubSupportsMinor === 协议包 protocolSupports（逐例等值）', () => {
    expect(CAPABILITY_FIXTURES.length).toBeGreaterThan(0);
    for (const { ver, requiredMinor } of CAPABILITY_FIXTURES) {
      expect(
        hubSupportsMinor(ver, requiredMinor),
        `hubSupportsMinor(${String(ver)}, ${requiredMinor}) 应与 protocolSupports 等值`,
      ).toBe(protocolSupports(ver ?? '', requiredMinor));
    }
  });

  it('能力门槛锚点：task.answer 要求 minor 3——1.3.0 支持、1.2.0 不支持（hub 侧 METHOD_REQUIRED_MINOR 同值）', () => {
    expect(protocolSupports('1.3.0', 3)).toBe(true);
    expect(protocolSupports('1.2.0', 3)).toBe(false);
    expect(hubSupportsMinor('1.3.0', 3)).toBe(true);
    expect(hubSupportsMinor('1.2.0', 3)).toBe(false);
  });
});
