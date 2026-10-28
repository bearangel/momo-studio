// renderer/src/lib/hub-capability.ts
//
// M3.1 远程代答能力门控（spec 2026-10-28 §3.4）：renderer 不能 import electron 侧
// 协议包（protocol.ts 唯一入口规则），此处在 renderer 侧镜像 protocolSupports 的
// 判定语义——「hub 协议 major 与本应用协议包 major 相等，且 minor ≥ requiredMinor
// 即支持该能力」；任何非法版本串（无 minor 段 / 非数字）与 null/undefined 一律
// false（未连接即未知，未知即不可用）。
//
// 与 electron 侧的等值关系由双侧契约测试锁定（error-prefix 双侧模式）：
// electron/tests/hub/hub-capability-contract.test.ts 用同一组字符串 fixture 断言
// 本函数结果 === 协议包 protocolSupports；协议包升 major 时契约会红，提醒同步
// 此处的 MAJOR 常量。

/** 本应用协议包 current major（镜像 protocolSupports 的 selfMajor——随 pin bump 同步） */
const PROTOCOL_MAJOR = 1;

/**
 * 双侧契约 fixture（M3.1）：renderer 测试与 electron 契约测试
 * （tests/hub/hub-capability-contract.test.ts）共用——两组结果必须逐例等值，
 * 改动须两侧同 commit。
 */
export const CAPABILITY_FIXTURES: ReadonlyArray<{
  ver: string | null | undefined;
  requiredMinor: number;
}> = [
  { ver: '1.3.0', requiredMinor: 3 },
  { ver: '1.2.0', requiredMinor: 3 },
  { ver: '2.0.0', requiredMinor: 3 },
  { ver: '1.9.9', requiredMinor: 3 },
  { ver: '1.3.0', requiredMinor: 2 },
  { ver: '1.2.0', requiredMinor: 2 },
  { ver: '1.3.0', requiredMinor: 4 },
  { ver: '1', requiredMinor: 3 },
  { ver: '', requiredMinor: 3 },
  { ver: null, requiredMinor: 3 },
  { ver: undefined, requiredMinor: 3 },
  { ver: 'abc', requiredMinor: 3 },
];

/**
 * hub 连接（hubProtoVer）是否支持给定 minor 门槛的能力。
 * 例：hubSupportsMinor('1.3.0', 3) === true；('1.2.0', 3) / ('2.0.0', 3) /
 * ('1', 3) / (null, 3) 均为 false。
 */
export function hubSupportsMinor(hubProtoVer: string | null | undefined, requiredMinor: number): boolean {
  if (typeof hubProtoVer !== 'string') return false;
  const m = /^(\d+)\.(\d+)/.exec(hubProtoVer);
  if (m === null) return false;
  return Number(m[1]) === PROTOCOL_MAJOR && Number(m[2]) >= requiredMinor;
}
