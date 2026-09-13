// electron/tests/sandbox/network-trust.test.ts
//
// 网络出站信任门测试（spec 2026-09-13 §5，方案 A 阻塞式）：
//   - detectNetworkBlocked：主进程侧复刻 renderer stream.store 双条件判定
//     （tag 正则 + 网络失败签名——仅 tag / 仅签名均不触发）
//   - effective 矩阵：settings 三态 × grants 两值（spec §8）
//   - 等待协议：单飞（同 streamSessionId 并发只推一张卡）/ 三值应答唤醒 /
//     超时 = deny（时钟注入，勿真睡）/ 迟到应答 no-op 不污染下一张卡
//   - clearGrant：任务终态清理（幂等）
//   - handleNetTrustOp：触发条件矩阵（无签名 not-triggered / gate 未初始化 ok:false）
// 时钟全部注入手动触发——任何用例不得真睡 180s。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  NETWORK_TRUST_TIMEOUT_MS,
  NetworkTrustGate,
  detectNetworkBlocked,
  handleNetTrustOp,
  initNetworkTrustGate,
  getNetworkTrustGate,
  clearActiveNetworkGrant,
  __resetNetworkTrustGateForTest,
  type NetworkPolicy,
  type TrustClock,
} from '../../src/main/sandbox/network-trust';

/** 手动时钟：不自动走表；测试显式 fire 触发超时（勿真睡铁律） */
class ManualClock implements TrustClock {
  private handle = 0;
  private entries = new Map<number, () => void>();
  setTimer(callback: () => void, _ms: number): unknown {
    this.handle += 1;
    this.entries.set(this.handle, callback);
    return this.handle;
  }
  clearTimer(handle: unknown): void {
    this.entries.delete(handle as number);
  }
  /** 手动触发当前唯一在表计时器（超时出口） */
  fire(): void {
    const first = this.entries.entries().next().value as [number, () => void] | undefined;
    if (first === undefined) throw new Error('ManualClock: 无在表计时器可触发');
    this.entries.delete(first[0]);
    first[1]();
  }
  get pendingCount(): number {
    return this.entries.size;
  }
}

interface Fixture {
  gate: NetworkTrustGate;
  clock: ManualClock;
  notices: Array<{ kind: string; text: string; streamSessionId: string; createdAt: number }>;
  persistAlways: ReturnType<typeof vi.fn>;
  setPolicy: (p: NetworkPolicy) => void;
}

/** 组装被测 gate：策略可变 + 推卡捕获 + 持久化捕获 + 手动时钟 */
function mkGate(initialPolicy: NetworkPolicy = 'ask'): Fixture {
  let policy = initialPolicy;
  const clock = new ManualClock();
  const notices: Fixture['notices'] = [];
  const persistAlways = vi.fn();
  const gate = new NetworkTrustGate({
    readPolicy: () => policy,
    persistAlways,
    pushNotice: (n) => notices.push(n),
    clock,
  });
  return { gate, clock, notices, persistAlways, setPolicy: (p) => { policy = p; } };
}

const SSN = 'ssn-trust-1';

describe('detectNetworkBlocked（主进程侧复刻 stream.store 双条件，spec §5）', () => {
  it('tag net-off + 监听 EPERM 签名 → 命中', () => {
    const text = 'exit_code: 1\n\nsandbox: bwrap/net-off\n\nstderr:\nError: listen EPERM 0.0.0.0:3000';
    expect(detectNetworkBlocked(text)).toBe(true);
  });
  it('seatbelt tag + DNS 解析失败签名 → 命中', () => {
    const text = 'sandbox: seatbelt/net-off\nstderr: curl: (6) Could not resolve host: example.com';
    expect(detectNetworkBlocked(text)).toBe(true);
  });
  it('connect·connection 近距 EPERM 签名 → 命中（间距 <60 字符）', () => {
    const text = 'sandbox: bwrap/net-off\nstderr: connect EPERM 1.2.3.4:443';
    expect(detectNetworkBlocked(text)).toBe(true);
  });
  it('curl (7) 签名 → 命中', () => {
    const text = 'sandbox: bwrap/net-off\nstderr: curl: (7) Failed to connect';
    expect(detectNetworkBlocked(text)).toBe(true);
  });
  // ── macOS seatbelt 真机形态（2026-09-13 真机会话原文回归锁——EPERM 以
  // strerror 文本出现；修复前这批样本全部漏检 → 信任卡不弹）──
  it('macOS nslookup bind: Operation not permitted（真机原文）→ 命中', () => {
    const text =
      'sandbox: seatbelt/net-off\nstderr:\nbind: Operation not permitted\nnslookup: isc_socket_bind: unexpected error';
    expect(detectNetworkBlocked(text)).toBe(true);
  });
  it('macOS ping sendto: Permission denied（真机形态）→ 命中', () => {
    const text = 'sandbox: seatbelt/net-off\nstderr: ping: sendto: Permission denied';
    expect(detectNetworkBlocked(text)).toBe(true);
  });
  it('node getaddrinfo EAI_AGAIN（断 DNS 形态）→ 命中', () => {
    const text = 'sandbox: seatbelt/net-off\nstderr: Error: getaddrinfo EAI_AGAIN example.com';
    expect(detectNetworkBlocked(text)).toBe(true);
  });
  it('macOS 真机 socket.c 长路径 bind 拒绝（真机原文截取）→ 命中', () => {
    const text =
      'sandbox: seatbelt/net-off\nstderr:\n/AppleInternal/.../socket.c:5580: bind: Operation not permitted';
    expect(detectNetworkBlocked(text)).toBe(true);
  });
  it('用户 echo 的任意格式退出码（退出码: 6）→ 刻意不命中（不可枚举，canonical stderr 已覆盖）', () => {
    const text = 'sandbox: seatbelt/net-off\nstdout:\ncurl 访问失败，退出码: 6';
    expect(detectNetworkBlocked(text)).toBe(false);
  });
  it('仅 tag（未碰网络的命令）→ 不触发（不打扰）', () => {
    const text = 'exit_code: 0\n\nsandbox: bwrap/net-off\n\nstdout:\nok';
    expect(detectNetworkBlocked(text)).toBe(false);
  });
  it('仅签名（非沙箱所致的网络错误，tag 为 net-on）→ 不触发', () => {
    const text = 'exit_code: 1\n\nsandbox: bwrap/net-on\n\nstderr:\nlisten EPERM';
    expect(detectNetworkBlocked(text)).toBe(false);
  });
  it('unsandboxed tag（permissive 降级）→ 不触发（非沙箱断网所致）', () => {
    const text = 'sandbox: unsandboxed:bwrap 未安装\nstderr: listen EPERM';
    expect(detectNetworkBlocked(text)).toBe(false);
  });
  it('win-powershell tag → 不触发（Windows 无 net-off 概念）', () => {
    const text = 'sandbox: win-powershell\nstderr: listen EPERM';
    expect(detectNetworkBlocked(text)).toBe(false);
  });
  it('空文本 → 不触发（空输入专项）', () => {
    expect(detectNetworkBlocked('')).toBe(false);
  });
});

describe('effectiveNetwork 矩阵（settings × grants，spec §5 单点函数）', () => {
  it('无 grant × ask → net-off + awaitingAsk（命中失败后走阻塞询问）', () => {
    const f = mkGate('ask');
    expect(f.gate.effective(SSN)).toEqual({ netOn: false, awaitingAsk: true });
  });
  it('无 grant × allow → net-on 不询问', () => {
    const f = mkGate('allow');
    expect(f.gate.effective(SSN)).toEqual({ netOn: true, awaitingAsk: false });
  });
  it('无 grant × deny → net-off 不询问', () => {
    const f = mkGate('deny');
    expect(f.gate.effective(SSN)).toEqual({ netOn: false, awaitingAsk: false });
  });
  it("grant 'granted' 压过任意 settings（allow/deny/ask 均 net-on）", () => {
    for (const p of ['allow', 'deny', 'ask'] as const) {
      const f = mkGate(p);
      f.gate.__setGrantForTest(SSN, 'granted');
      expect(f.gate.effective(SSN)).toEqual({ netOn: true, awaitingAsk: false });
    }
  });
  it("grant 'denied' 压过任意 settings（net-off 不询问——本任务内不再问）", () => {
    for (const p of ['allow', 'deny', 'ask'] as const) {
      const f = mkGate(p);
      f.gate.__setGrantForTest(SSN, 'denied');
      expect(f.gate.effective(SSN)).toEqual({ netOn: false, awaitingAsk: false });
    }
  });
});

describe('waitForTrust 等待协议（spec §5 协议 1-6）', () => {
  it('进入等待前推一张信任卡（kind=net-trust-request + streamSessionId + createdAt）', async () => {
    const f = mkGate('ask');
    const p = f.gate.waitForTrust(SSN);
    expect(f.notices).toHaveLength(1);
    const n = f.notices[0]!;
    expect(n.kind).toBe('net-trust-request');
    expect(n.streamSessionId).toBe(SSN);
    expect(typeof n.createdAt).toBe('number');
    f.gate.answer(SSN, 'deny');
    await expect(p).resolves.toBe('denied');
  });

  it('单飞：同 streamSessionId 并发等待只推一张卡，join 同一裁决', async () => {
    const f = mkGate('ask');
    const p1 = f.gate.waitForTrust(SSN);
    const p2 = f.gate.waitForTrust(SSN);
    const p3 = f.gate.waitForTrust(SSN);
    expect(f.notices).toHaveLength(1);
    f.gate.answer(SSN, 'session');
    await expect(p1).resolves.toBe('granted');
    await expect(p2).resolves.toBe('granted');
    await expect(p3).resolves.toBe('granted');
  });

  it("不同 streamSessionId 各自推卡（跨任务不合并）", async () => {
    const f = mkGate('ask');
    const p1 = f.gate.waitForTrust('ssn-a');
    const p2 = f.gate.waitForTrust('ssn-b');
    expect(f.notices).toHaveLength(2);
    f.gate.answer('ssn-a', 'deny');
    await expect(p1).resolves.toBe('denied');
    // b 仍在等待（a 的裁决不串扰 b）
    f.gate.answer('ssn-b', 'session');
    await expect(p2).resolves.toBe('granted');
  });

  it("answer 'session' → granted + grants 置 granted（后续 spawn net-on）+ 不持久化", async () => {
    const f = mkGate('ask');
    const p = f.gate.waitForTrust(SSN);
    f.gate.answer(SSN, 'session');
    await expect(p).resolves.toBe('granted');
    expect(f.gate.effective(SSN)).toEqual({ netOn: true, awaitingAsk: false });
    expect(f.persistAlways).not.toHaveBeenCalled();
  });

  it("answer 'always' → granted + grants 置 granted + 持久化被调（本任务即刻生效）", async () => {
    const f = mkGate('ask');
    const p = f.gate.waitForTrust(SSN);
    f.gate.answer(SSN, 'always');
    await expect(p).resolves.toBe('granted');
    expect(f.persistAlways).toHaveBeenCalledTimes(1);
    expect(f.gate.effective(SSN)).toEqual({ netOn: true, awaitingAsk: false });
  });

  it("answer 'deny' → denied + grants 置 denied（本任务内不再询问）+ 失败结果原样返回", async () => {
    const f = mkGate('ask');
    const p = f.gate.waitForTrust(SSN);
    f.gate.answer(SSN, 'deny');
    await expect(p).resolves.toBe('denied');
    expect(f.gate.effective(SSN)).toEqual({ netOn: false, awaitingAsk: false });
    // denied 后同流新等待走快路径直接 denied（不再推卡）
    const p2 = f.gate.waitForTrust(SSN);
    expect(f.notices).toHaveLength(1);
    await expect(p2).resolves.toBe('denied');
  });

  it('超时 → 等效 deny（置 denied + 唤醒挂起者；时钟注入手动触发，勿真睡）', async () => {
    const f = mkGate('ask');
    const p1 = f.gate.waitForTrust(SSN);
    const p2 = f.gate.waitForTrust(SSN);
    f.clock.fire();
    await expect(p1).resolves.toBe('denied');
    await expect(p2).resolves.toBe('denied');
    expect(f.gate.effective(SSN)).toEqual({ netOn: false, awaitingAsk: false });
  });

  it('迟到应答 no-op：超时收敛后到达的应答整体丢弃（不覆盖 denied、不持久化、不污染下一张卡）', async () => {
    const f = mkGate('ask');
    const p = f.gate.waitForTrust(SSN);
    f.clock.fire();
    await expect(p).resolves.toBe('denied');
    // 迟到点击「永久允许」——spec §5.6 整体 no-op
    f.gate.answer(SSN, 'always');
    expect(f.persistAlways).not.toHaveBeenCalled();
    expect(f.gate.effective(SSN)).toEqual({ netOn: false, awaitingAsk: false });
    // 下一张卡不受污染：clearGrant 后新任务同流可再询问
    f.gate.clearGrant(SSN);
    const p2 = f.gate.waitForTrust(SSN);
    expect(f.notices).toHaveLength(2);
    f.gate.answer(SSN, 'session');
    await expect(p2).resolves.toBe('granted');
  });

  it('已应答后的重复应答同样 no-op（双击防重）', async () => {
    const f = mkGate('ask');
    const p = f.gate.waitForTrust(SSN);
    f.gate.answer(SSN, 'session');
    await expect(p).resolves.toBe('granted');
    f.gate.answer(SSN, 'deny'); // 迟到的第二击
    expect(f.gate.effective(SSN)).toEqual({ netOn: true, awaitingAsk: false }); // granted 保留
  });

  it('等待期间策略被翻到 deny（设置页竞态）→ 新等待直接 denied', async () => {
    const f = mkGate('ask');
    f.setPolicy('deny');
    await expect(f.gate.waitForTrust(SSN)).resolves.toBe('denied');
    expect(f.notices).toHaveLength(0);
  });

  it('推卡抛错（IPC 故障）→ 穿透且不留悬挂等待', async () => {
    const clock = new ManualClock();
    const gate = new NetworkTrustGate({
      readPolicy: () => 'ask',
      persistAlways: () => {},
      pushNotice: () => { throw new Error('webContents 已销毁'); },
      clock,
    });
    await expect(gate.waitForTrust(SSN)).rejects.toThrow('webContents 已销毁');
    // 无悬挂等待：后续 answer no-op，新等待重新推卡（计时器已清）
    expect(clock.pendingCount).toBe(0);
  });

  it('persistAlways 抛错不撤销会话级授权（granted 仍生效）', async () => {
    const clock = new ManualClock();
    const gate = new NetworkTrustGate({
      readPolicy: () => 'ask',
      persistAlways: () => { throw new Error('DB 写失败'); },
      pushNotice: () => {},
      clock,
    });
    const p = gate.waitForTrust(SSN);
    gate.answer(SSN, 'always');
    await expect(p).resolves.toBe('granted');
    expect(gate.effective(SSN)).toEqual({ netOn: true, awaitingAsk: false });
  });
});

describe('clearGrant（agent-runner 任务终态清理，spec §5）', () => {
  it('清理后回到设置三态（session 授权严格随任务生命周期）', () => {
    const f = mkGate('ask');
    f.gate.__setGrantForTest(SSN, 'granted');
    expect(f.gate.effective(SSN).netOn).toBe(true);
    f.gate.clearGrant(SSN);
    expect(f.gate.effective(SSN)).toEqual({ netOn: false, awaitingAsk: true });
  });
  it('幂等：重复清理 no-op 不抛错', () => {
    const f = mkGate('ask');
    f.gate.clearGrant(SSN);
    f.gate.clearGrant(SSN);
  });
  it('模块级 clearActiveNetworkGrant：gate 未接线时 no-op（清理绝不阻断收尾链路）', () => {
    __resetNetworkTrustGateForTest();
    expect(() => clearActiveNetworkGrant(SSN)).not.toThrow();
  });
});

describe('handleNetTrustOp（child IPC op 路由，spec §5 阻塞询问钩子主进程侧）', () => {
  beforeEach(() => { __resetNetworkTrustGateForTest(); });
  afterEach(() => { __resetNetworkTrustGateForTest(); });

  it('gate 未初始化 → ok:false（中文错误，不裸抛）', async () => {
    const r = await handleNetTrustOp({ type: 'net-trust-op', requestId: 'r1', op: 'effective', streamSessionId: SSN });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('未初始化');
  });

  it('载荷形状非法 → ok:false', async () => {
    initNetworkTrustGate({ readPolicy: () => 'ask', persistAlways: () => {}, pushNotice: () => {} });
    const r = await handleNetTrustOp({ type: 'net-trust-op', requestId: 'r1', op: 'bogus', streamSessionId: SSN });
    expect(r.ok).toBe(false);
    const r2 = await handleNetTrustOp('not-an-object');
    expect(r2.ok).toBe(false);
  });

  it("op 'effective' → 返回 gate.effective 结果", async () => {
    initNetworkTrustGate({ readPolicy: () => 'allow', persistAlways: () => {}, pushNotice: () => {} });
    const r = await handleNetTrustOp({ type: 'net-trust-op', requestId: 'r1', op: 'effective', streamSessionId: SSN });
    expect(r).toEqual({ ok: true, payload: { netOn: true, awaitingAsk: false } });
  });

  it("op 'wait' 无网络拒绝签名 → not-triggered（不推卡不阻塞）", async () => {
    const notices: unknown[] = [];
    initNetworkTrustGate({ readPolicy: () => 'ask', persistAlways: () => {}, pushNotice: (n) => notices.push(n) });
    const r = await handleNetTrustOp({
      type: 'net-trust-op', requestId: 'r1', op: 'wait',
      streamSessionId: SSN,
      resultText: 'exit_code: 0\n\nsandbox: bwrap/net-off\n\nstdout:\nok',
    });
    expect(r).toEqual({ ok: true, payload: { outcome: 'not-triggered' } });
    expect(notices).toHaveLength(0);
  });

  it("op 'wait' 命中签名且 ask 无 grant → 阻塞等待直到应答（granted 唤醒）", async () => {
    const notices: unknown[] = [];
    initNetworkTrustGate({ readPolicy: () => 'ask', persistAlways: () => {}, pushNotice: (n) => notices.push(n) });
    const pending = handleNetTrustOp({
      type: 'net-trust-op', requestId: 'r1', op: 'wait',
      streamSessionId: SSN,
      resultText: 'sandbox: bwrap/net-off\nstderr: listen EPERM',
    });
    await Promise.resolve(); // 让 waitForTrust 同步段先跑（推卡入队）
    expect(notices).toHaveLength(1);
    getNetworkTrustGate()!.answer(SSN, 'session');
    await expect(pending).resolves.toEqual({ ok: true, payload: { outcome: 'granted' } });
  });

  it("op 'wait' 命中签名但 grant 已在场 → 快路径不推卡（不触发矩阵：已有 grant）", async () => {
    const notices: unknown[] = [];
    initNetworkTrustGate({ readPolicy: () => 'ask', persistAlways: () => {}, pushNotice: (n) => notices.push(n) });
    getNetworkTrustGate()!.__setGrantForTest(SSN, 'denied');
    const r = await handleNetTrustOp({
      type: 'net-trust-op', requestId: 'r1', op: 'wait',
      streamSessionId: SSN,
      resultText: 'sandbox: bwrap/net-off\nstderr: listen EPERM',
    });
    expect(r).toEqual({ ok: true, payload: { outcome: 'denied' } });
    expect(notices).toHaveLength(0);
  });

  it('超时常量为 180s（spec §5 协议 2）', () => {
    expect(NETWORK_TRUST_TIMEOUT_MS).toBe(180_000);
  });
});
