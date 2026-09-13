// electron/tests/sandbox/network-trust.test.ts
//
// 网络出站策略查询测试（2026-09-13 修订 B 双态化）：
//   - handleNetTrustOp（effective 单 op）：allow → netOn:true / deny → netOn:false
//   - 载荷形状防线：非对象 / 缺字段 / 非法 op → ok:false（中文错误，不裸抛）
//   - 设置读取故障 → ok:false 降级（不挂死、不裸抛——子进程桥自有回退）
// 三态时代的 gate / 等待协议 / 三值应答 / 超时收敛 / detectNetworkBlocked
// 已随 ask 信任门机制全链下线（相关用例同批删除）。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// 设置读取故障分支注入点（其余用例走真实 testOverride 钩子，mock 收窄到单函数）
const { settingsBoom } = vi.hoisted(() => ({ settingsBoom: { value: false } }));

vi.mock('../../src/main/sandbox/settings', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/sandbox/settings')>();
  return {
    ...actual,
    getSandboxSettings: () => {
      if (settingsBoom.value) throw new Error('DB 异常');
      return actual.getSandboxSettings();
    },
  };
});

import { handleNetTrustOp } from '../../src/main/sandbox/network-trust';
import { __setSandboxSettingsForTest } from '../../src/main/sandbox/settings';

const SSN = 'ssn-trust-1';

describe('handleNetTrustOp（effective 单 op 路由，修订 B 双态）', () => {
  beforeEach(() => {
    __setSandboxSettingsForTest({ mode: 'strict', networkPolicy: 'allow' });
  });
  afterEach(() => {
    __setSandboxSettingsForTest(null);
  });

  it('policy=allow → { ok:true, payload:{ netOn:true } }', async () => {
    __setSandboxSettingsForTest({ mode: 'strict', networkPolicy: 'allow' });
    const r = await handleNetTrustOp({ type: 'net-trust-op', requestId: 'r1', op: 'effective', streamSessionId: SSN });
    expect(r).toEqual({ ok: true, payload: { netOn: true } });
  });

  it('policy=deny → { ok:true, payload:{ netOn:false } }', async () => {
    __setSandboxSettingsForTest({ mode: 'strict', networkPolicy: 'deny' });
    const r = await handleNetTrustOp({ type: 'net-trust-op', requestId: 'r2', op: 'effective', streamSessionId: SSN });
    expect(r).toEqual({ ok: true, payload: { netOn: false } });
  });

  it('载荷非对象 → ok:false（中文错误，不裸抛）', async () => {
    const r = await handleNetTrustOp('not-an-object');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('载荷形状非法');
  });

  it('op 非 effective（如三态时代遗留 wait）→ ok:false', async () => {
    const r = await handleNetTrustOp({ type: 'net-trust-op', requestId: 'r3', op: 'wait', streamSessionId: SSN, resultText: 'x' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('载荷形状非法');
  });

  it('requestId / streamSessionId 缺失或空 → ok:false（形状防线逐字段）', async () => {
    const noId = await handleNetTrustOp({ type: 'net-trust-op', op: 'effective', streamSessionId: SSN });
    expect(noId.ok).toBe(false);
    const emptyId = await handleNetTrustOp({ type: 'net-trust-op', requestId: '', op: 'effective', streamSessionId: SSN });
    expect(emptyId.ok).toBe(false);
    const noSsn = await handleNetTrustOp({ type: 'net-trust-op', requestId: 'r4', op: 'effective' });
    expect(noSsn.ok).toBe(false);
  });

  it('type 非 net-trust-op → ok:false', async () => {
    const r = await handleNetTrustOp({ type: 'other-op', requestId: 'r5', op: 'effective', streamSessionId: SSN });
    expect(r.ok).toBe(false);
  });

  it('设置读取抛错 → ok:false 降级（不挂死、不裸抛——错误路径专项）', async () => {
    // 直接改写 testOverride 为一个读取即抛的形态不可行（钩子是纯值），改经
    // vi.spyOn 临时替换 getSandboxSettings 抛错，验证 handleNetTrustOp 吸收异常。
    const settings = await import('../../src/main/sandbox/settings');
    const spy = vi.spyOn(settings, 'getSandboxSettings').mockImplementation(() => {
      throw new Error('DB 异常');
    });
    const r = await handleNetTrustOp({ type: 'net-trust-op', requestId: 'r6', op: 'effective', streamSessionId: SSN });
    spy.mockRestore();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('网络策略读取失败');
  });
});
