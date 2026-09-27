// electron/tests/sandbox/process-registry.test.ts
//
// 沙箱进程组生命周期契约锁（2026-09-25 立项）：
//   1. 登记 → 收割：真进程组全灭（SIGKILL）、条目清除、幂等
//   2. 空组探测跳过（pgid 复用缓解——不盲杀）
//   3. 子进程上报消息形状门（registerFromChildMsg）
//   4. 存量清扫：带 MOMO_STUDIO_AGENT=1 的孤儿被杀、无标记进程存活、自家进程树排除
//
// 时序注：SIGKILL 送达后目标需经 libuv 收尸才从 kill(pid,0) 消失——
// 「已死」断言一律走 vi.waitFor 轮询（事件循环转起来才收尸，同步阻塞不会）。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import {
  registerProcessGroup,
  reapProcessGroups,
  registerFromChildMsg,
  sweepTaggedOrphans,
  sweepRoundEscapes,
  listRoundProcesses,
  killRoundProcess,
  keepRoundProcess,
  __registeredForTest,
  __clearRegistryForTest,
} from '../../src/main/sandbox/process-registry';

const spawned: ChildProcess[] = [];

/** 起一个 60s 睡眠进程（可注入 env、可 detached 成组长）——用例结束统一兜底杀 */
function mkSleeper(opts?: { env?: Record<string, string>; detached?: boolean }): ChildProcess {
  const child = spawn('sleep', ['60'], {
    stdio: 'ignore',
    detached: opts?.detached ?? true,
    env: opts?.env,
  });
  spawned.push(child);
  return child;
}

function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * 进程级探针（sweep 用例专用）：sweep 制造的孤儿经非 detached 中间 bash，
 * sleep 继承的是本测试进程组——组探针恒假阴性，必须探进程本身。
 */
function procAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcGone(pid: number): Promise<void> {
  await vi.waitFor(
    () => {
      expect(procAlive(pid)).toBe(false);
    },
    { timeout: 3000, interval: 50 },
  );
}

async function waitForGone(pid: number): Promise<void> {
  await vi.waitFor(
    () => {
      expect(groupAlive(pid)).toBe(false);
    },
    { timeout: 3000, interval: 50 },
  );
}

beforeEach(() => {
  __clearRegistryForTest();
});

afterEach(() => {
  for (const c of spawned) {
    try {
      if (c.pid) process.kill(-c.pid, 'SIGKILL');
    } catch {
      // 组已灭
    }
  }
  spawned.length = 0;
  __clearRegistryForTest();
});

describe('registerProcessGroup / reapProcessGroups', () => {
  it('登记 → 收割：进程组全灭 + 条目清除 + 二次收割幂等 no-op', async () => {
    const child = mkSleeper({ detached: true });
    expect(child.pid).toBeTypeOf('number');
    const pgid = child.pid!;

    registerProcessGroup('ss-x', pgid);
    expect(__registeredForTest().get('ss-x')).toEqual(new Set([pgid]));

    // detached spawn：child.pid 即 pgid，进程组存活
    expect(groupAlive(pgid)).toBe(true);

    reapProcessGroups('ss-x');
    await waitForGone(pgid);
    // 条目已清
    expect(__registeredForTest().has('ss-x')).toBe(false);
    // 幂等
    expect(() => reapProcessGroups('ss-x')).not.toThrow();
  });

  it('同回合多组登记，一次收割全灭', async () => {
    const a = mkSleeper({ detached: true });
    const b = mkSleeper({ detached: true });
    registerProcessGroup('ss-multi', a.pid!);
    registerProcessGroup('ss-multi', b.pid!);

    reapProcessGroups('ss-multi');
    await waitForGone(a.pid!);
    await waitForGone(b.pid!);
  });

  it('空组（已退出的组长）跳过不抛（pgid 复用缓解路径）', () => {
    const child = spawn('sleep', ['0'], { stdio: 'ignore', detached: true });
    child.unref();
    // 轮询等它退出（自然退出同样需收尸窗口）
    return vi
      .waitFor(
        () => {
          expect(groupAlive(child.pid!)).toBe(false);
        },
        { timeout: 3000, interval: 50 },
      )
      .then(() => {
        registerProcessGroup('ss-dead', child.pid!);
        expect(() => reapProcessGroups('ss-dead')).not.toThrow();
      });
  });
});

describe('registerFromChildMsg（runtime 子进程上报形状门）', () => {
  it('合法载荷登记；非法形状返回 false 不登记', () => {
    expect(registerFromChildMsg({ type: 'proc-group:register', streamSessionId: 'ss-1', pgid: 4242 })).toBe(true);
    expect(__registeredForTest().get('ss-1')).toEqual(new Set([4242]));

    expect(registerFromChildMsg({ type: 'proc-group:register', streamSessionId: 'ss-2', pgid: 'x' })).toBe(false);
    expect(registerFromChildMsg({ type: 'other' })).toBe(false);
    expect(registerFromChildMsg(null)).toBe(false);
    expect(__registeredForTest().has('ss-2')).toBe(false);
  });
});

describe('sweepTaggedOrphans（boot 存量清扫）', () => {
  it('孤儿（ppid=1）cwd ∈ workspace 目录被杀；目录外孤儿存活', async () => {
    const wsDir = `/tmp/ap-sweep-ws-${Date.now()}`;
    fs.mkdirSync(wsDir, { recursive: true });
    try {
      // 双叉孤儿：中间 bash 回显 sleep pid 后立即退出 → sleep reparent 到 ppid=1，cwd 继承
      const inWs = spawn('bash', ['-c', 'sleep 60 & echo $!'], { stdio: ['ignore', 'pipe', 'ignore'], cwd: wsDir });
      const outWs = spawn('bash', ['-c', 'sleep 60 & echo $!'], { stdio: ['ignore', 'pipe', 'ignore'], cwd: os.tmpdir() });
      const readPid = (c: ChildProcess): Promise<number> =>
        new Promise((resolve) => {
          let buf = '';
          c.stdout!.on('data', (d: Buffer) => {
            buf += d.toString();
          });
          c.on('exit', () => resolve(Number(buf.trim())));
        });
      const [pidIn, pidOut] = await Promise.all([readPid(inWs), readPid(outWs)]);
      spawned.push({ pid: pidIn } as ChildProcess, { pid: pidOut } as ChildProcess);
      await new Promise((r) => setTimeout(r, 300));

      const res = sweepTaggedOrphans([wsDir]);
      expect(res.scanned).toBeGreaterThan(0);
      await waitForProcGone(pidIn);
      // 目录外孤儿不受影响
      expect(procAlive(pidOut)).toBe(true);
    } finally {
      fs.rmSync(wsDir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform !== 'linux')(
    'Linux：环境带 MOMO_STUDIO_AGENT=1 的孤儿被杀（/proc 精确指纹）',
    async () => {
      const tagged = mkSleeper({ env: { ...process.env, MOMO_STUDIO_AGENT: '1' }, detached: true });
      tagged.unref();
      const res = sweepTaggedOrphans([]);
      expect(res.scanned).toBeGreaterThan(0);
      await waitForGone(tagged.pid!);
    },
  );
});

describe('sweepRoundEscapes（回合逃逸清扫——时间窗语义）', () => {
  function mkOrphan(cwd: string): Promise<number> {
    const b = spawn('bash', ['-c', 'sleep 60 & echo $!'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      cwd,
    });
    return new Promise((resolve) => {
      let buf = '';
      b.stdout!.on('data', (d: Buffer) => {
        buf += d.toString();
      });
      b.on('exit', () => resolve(Number(buf.trim())));
    });
  }

  it('窗内（回合开始后启动）孤儿被杀；窗前启动的历史孤儿豁免', async () => {
    const wsDir = `/tmp/ap-escape-ws-${Date.now()}`;
    fs.mkdirSync(wsDir, { recursive: true });
    try {
      // 历史孤儿：窗前启动（间隔须大于实现侧 1.5s 的 lstart 秒级精度余量）
      const stale = await mkOrphan(wsDir);
      await new Promise((r) => setTimeout(r, 3000));

      // 回合窗口锚点 + 窗内逃逸孤儿
      const roundStart = Date.now();
      await new Promise((r) => setTimeout(r, 100));
      const fresh = await mkOrphan(wsDir);
      spawned.push({ pid: stale } as ChildProcess, { pid: fresh } as ChildProcess);
      await new Promise((r) => setTimeout(r, 400));

      const res = sweepRoundEscapes([wsDir], roundStart);
      expect(res.scanned).toBeGreaterThan(0);
      await waitForProcGone(fresh); // 窗内：杀
      expect(procAlive(stale)).toBe(true); // 窗前：历史孤儿是 boot 清扫的地盘，不误杀
    } finally {
      fs.rmSync(wsDir, { recursive: true, force: true });
    }
  });
});

// 回合进程管理（E-A，2026-09-25）：process_list / process_kill 的主进程侧支撑——
// 真进程锁「列表成员清点 / 端口授权击杀 / 越权拒绝」三语义
describe('listRoundProcesses / killRoundProcess（回合进程管理）', () => {
  it('list：登记组的存活成员清点；全灭组出清登记', async () => {
    const child = mkSleeper({ detached: true });
    registerProcessGroup('ss-mgmt', child.pid!);
    const list = listRoundProcesses('ss-mgmt');
    expect(list).toHaveLength(1);
    expect(list[0]!.pgid).toBe(child.pid!);
    expect(list[0]!.members.some((mem) => mem.pid === child.pid && mem.command.includes('sleep'))).toBe(true);

    // 全灭后：列表为空 + 登记出清
    reapProcessGroups('ss-mgmt');
    await waitForGone(child.pid!);
    expect(listRoundProcesses('ss-mgmt')).toEqual([]);
    expect(__registeredForTest().has('ss-mgmt')).toBe(false);
  });

  it('kill by port：授权组内的监听进程被整组击杀', async () => {
    const PORT = 18923 + Math.floor(Math.random() * 100);
    // 组长 python http.server（真实监听端口；与 bash 工具同款 detached 组长形态）
    const server = spawn('python3', ['-m', 'http.server', String(PORT)], {
      stdio: 'ignore',
      detached: true,
      cwd: os.tmpdir(),
    });
    spawned.push(server);
    registerProcessGroup('ss-port', server.pid!);
    // 等监听就绪
    await vi.waitFor(
      () => {
        const check = spawn('lsof', [`-tiTCP:${PORT}`, '-sTCP:LISTEN']);
        return new Promise<void>((resolve, reject) => {
          check.on('exit', (code) => (code === 0 ? resolve() : reject(new Error('no listener'))));
        });
      },
      { timeout: 5000, interval: 100 },
    );

    const res = killRoundProcess('ss-port', { port: PORT });
    expect(res.killedGroups).toBe(1);
    expect(res.refused).toEqual([]);
    await waitForGone(server.pid!);
  });

  it('越权拒绝：未登记进程的 pid / 端口不被杀', async () => {
    const outsider = mkSleeper({ detached: true }); // 未登记
    const mine = mkSleeper({ detached: true });
    registerProcessGroup('ss-authz', mine.pid!);

    const res = killRoundProcess('ss-authz', { pid: outsider.pid! });
    expect(res.killedGroups).toBe(0);
    expect(res.refused.length).toBe(1);
    expect(res.refused[0]).toContain('不属于本回合');
    expect(groupAlive(outsider.pid!)).toBe(true); // 越权目标毫发无损

    // pgid 直杀未登记组同理拒绝
    const res2 = killRoundProcess('ss-authz', { pgid: outsider.pid! });
    expect(res2.killedGroups).toBe(0);
    expect(groupAlive(outsider.pid!)).toBe(true);
  });
});

// process_keep（2026-09-26）：用户保留语义四件套——豁免收割/跨回合可关/上限/逃逸补扫豁免
describe('keepRoundProcess（用户保留服务）', () => {
  it('keep 后豁免回合收割与逃逸补扫：服务跨回合存活，且后续同 workspace 回合可 kill', async () => {
    // 孤儿组长形态（与 bash 工具同款 detached）：中间 bash 退出 → sleep 孤儿化
    // （ppid=1）仍留组内——逃逸补扫的真实猎物形态
    const leader = spawn('bash', ['-c', 'sleep 60 & echo $!'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      detached: true,
      cwd: os.tmpdir(),
    });
    const orphanPid = await new Promise<number>((resolve) => {
      let buf = '';
      leader.stdout!.on('data', (d: Buffer) => {
        buf += d.toString();
      });
      leader.on('exit', () => resolve(Number(buf.trim())));
    });
    spawned.push({ pid: leader.pid } as ChildProcess);
    await new Promise((r) => setTimeout(r, 300));

    registerProcessGroup('ss-keep-1', leader.pid!);
    const kept = keepRoundProcess('ss-keep-1', 'ws-keep', { pgid: leader.pid! });
    expect(kept).toMatchObject({ ok: true, pgid: leader.pid! });

    // 回合收割不再命中（已移出回合表）
    reapProcessGroups('ss-keep-1');
    expect(procAlive(orphanPid)).toBe(true);

    // 逃逸补扫豁免（孤儿成员的组在保留表——不是逃逸者）
    sweepRoundEscapes([os.tmpdir()], Date.now() - 60_000);
    expect(procAlive(orphanPid)).toBe(true);

    // 后续「别的回合」按 workspace 授权可关（整组击杀）
    const res = killRoundProcess('ss-keep-2', { pgid: leader.pid! }, 'ws-keep');
    expect(res.killedGroups).toBe(1);
    await waitForProcGone(orphanPid);
  });

  it('跨 workspace 越权拒绝：别的 workspace 的回合杀不了保留组', async () => {
    const server = mkSleeper({ detached: true });
    registerProcessGroup('ss-keep-3', server.pid!);
    keepRoundProcess('ss-keep-3', 'ws-mine', { pgid: server.pid! });

    const res = killRoundProcess('ss-other', { pgid: server.pid! }, 'ws-not-mine');
    expect(res.killedGroups).toBe(0);
    expect(res.refused[0]).toContain('不属于');
    expect(groupAlive(server.pid!)).toBe(true);
  });

  it('上限：每 workspace 超过 5 个保留拒绝（防泄漏堆积）', () => {
    for (let i = 0; i < 6; i += 1) {
      const s = mkSleeper({ detached: true });
      registerProcessGroup(`ss-cap-${i}`, s.pid!);
      const r = keepRoundProcess(`ss-cap-${i}`, 'ws-cap', { pgid: s.pid! });
      if (i < 5) {
        expect(r.ok).toBe(true);
      } else {
        expect(r).toMatchObject({ ok: false });
        if (!r.ok) expect(r.error).toContain('上限');
      }
    }
  });

  it('keep 目标越权：非本回合进程拒绝', () => {
    const outsider = mkSleeper({ detached: true });
    const r = keepRoundProcess('ss-none', 'ws-x', { pgid: outsider.pid! });
    expect(r).toMatchObject({ ok: false });
    // 空回合同样拒绝
    const r2 = keepRoundProcess('ss-empty', 'ws-x', { port: 1234 });
    expect(r2).toMatchObject({ ok: false });
  });

  it('list 带 workspaceId：保留组带 kept/port 标记展示', () => {
    const s = mkSleeper({ detached: true });
    registerProcessGroup('ss-keep-list', s.pid!);
    keepRoundProcess('ss-keep-list', 'ws-show', { pgid: s.pid!, port: 9999 });
    const list = listRoundProcesses('ss-other-round', 'ws-show');
    expect(list.some((g) => g.pgid === s.pid! && g.kept === true && g.port === 9999)).toBe(true);
  });
});
