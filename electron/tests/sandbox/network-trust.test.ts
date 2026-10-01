// electron/tests/sandbox/network-trust.test.ts
//
// 网络出站策略查询测试（2026-09-13 修订 B 双态化 + 2026-10-01 v2.5 工具链授权）：
//   - handleNetTrustOp（effective 单 op）：allow → netOn:true / deny → netOn:false
//   - v2.5 新增：工具链写授权 toolchainOn（policy allow 永久 || 会话 grant 按 workspace 键控）
//   - 旧载荷兼容：无 workspaceId → grant 按 false（向后兼容旧子进程）
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
import {
  DEFAULT_TOOLCHAIN_DIRS,
  grantToolchainWorkspace,
  __clearToolchainGrantsForTest,
} from '../../src/main/sandbox/toolchain-grant';

/** 测试用 settings 构造器：v2.5 起 toolchainPolicy/toolchainDirs 必填 */
function settings(mode: 'strict' | 'permissive', networkPolicy: 'deny' | 'allow') {
  return { mode, networkPolicy, toolchainPolicy: 'deny' as const, toolchainDirs: [...DEFAULT_TOOLCHAIN_DIRS] };
}

const SSN = 'ssn-trust-1';

describe('handleNetTrustOp（effective 单 op 路由，修订 B 双态）', () => {
  beforeEach(() => {
    __setSandboxSettingsForTest(settings('strict', 'allow'));
  });
  afterEach(() => {
    __setSandboxSettingsForTest(null);
  });

  it('policy=allow → { ok:true, payload:{ netOn:true, toolchainOn:false } }', async () => {
    // 旧载荷（无 workspaceId）：toolchainPolicy 默认 deny + 无 grant → toolchainOn=false
    __setSandboxSettingsForTest(settings('strict', 'allow'));
    const r = await handleNetTrustOp({ type: 'net-trust-op', requestId: 'r1', op: 'effective', streamSessionId: SSN });
    expect(r).toEqual({ ok: true, payload: { netOn: true, toolchainOn: false } });
  });

  it('policy=deny → { ok:true, payload:{ netOn:false, toolchainOn:false } }', async () => {
    __setSandboxSettingsForTest(settings('strict', 'deny'));
    const r = await handleNetTrustOp({ type: 'net-trust-op', requestId: 'r2', op: 'effective', streamSessionId: SSN });
    expect(r).toEqual({ ok: true, payload: { netOn: false, toolchainOn: false } });
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

describe('effective op 工具链双字段（spec §6）', () => {
  beforeEach(() => {
    // 会话 grant 表跨用例需清理——避免前例置位泄露（testOverride 不影响 grants）
    __clearToolchainGrantsForTest();
    __setSandboxSettingsForTest(settings('strict', 'allow'));
  });
  afterEach(() => {
    __setSandboxSettingsForTest(null);
    __clearToolchainGrantsForTest();
  });

  it('默认 deny 且无 grant → toolchainOn=false（spec §6 Review Focus 4）', async () => {
    __setSandboxSettingsForTest(settings('strict', 'allow'));
    const r = await handleNetTrustOp({
      type: 'net-trust-op', requestId: 'r1', op: 'effective',
      streamSessionId: SSN, workspaceId: 'ws-a',
    });
    expect(r).toEqual({ ok: true, payload: { netOn: true, toolchainOn: false } });
  });

  it('会话 grant 置位 → toolchainOn=true；跨 workspace 隔离（spec §6 Review Focus 3）', async () => {
    grantToolchainWorkspace('ws-a');
    const r = await handleNetTrustOp({
      type: 'net-trust-op', requestId: 'r2a', op: 'effective',
      streamSessionId: SSN, workspaceId: 'ws-a',
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.payload.toolchainOn).toBe(true);

    const r2 = await handleNetTrustOp({
      type: 'net-trust-op', requestId: 'r2b', op: 'effective',
      streamSessionId: SSN, workspaceId: 'ws-b',
    });
    expect(r2.ok).toBe(true);
    if (r2.ok) expect(r2.payload.toolchainOn).toBe(false);
  });

  it('policy=allow → 无 grant 也 true（永久开）', async () => {
    __setSandboxSettingsForTest({
      mode: 'strict', networkPolicy: 'allow', toolchainPolicy: 'allow', toolchainDirs: [...DEFAULT_TOOLCHAIN_DIRS],
    });
    const r = await handleNetTrustOp({
      type: 'net-trust-op', requestId: 'r3', op: 'effective',
      streamSessionId: SSN, workspaceId: 'ws-x',
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.payload.toolchainOn).toBe(true);
  });

  it('旧载荷（无 workspaceId）→ grant 按 false 兼容（spec §6 Review Focus 4）', async () => {
    // 即便 grant 已置位，旧载荷（无 workspaceId）按 false 处理——向后兼容旧子进程
    grantToolchainWorkspace('ws-a');
    const r = await handleNetTrustOp({
      type: 'net-trust-op', requestId: 'r4', op: 'effective', streamSessionId: SSN,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.payload.toolchainOn).toBe(false);
  });
});
