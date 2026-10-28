// electron/tests/hub/delegation-answer.test.ts
//
// M3.1 远程代答 worker 侧处理器锁（spec 2026-10-28 §3.3）：载荷校验（bad_request
// 全路径）/ 三 stale 口径（无委派、无 sessionId、无未决登记——幂等不报错）/
// approve 聚合多 pending dirs 一次授予 + 逐条清除 / deny 广播聚合 dirs + 整会话
// 清除 / message 仅留痕不上报（审计日志唯一消费点）。纯注入 fake ports。
import { describe, expect, it } from 'vitest';
import {
  handleTaskAnswerRequest,
  type TaskAnswerPendingSignal,
  type TaskAnswerPorts,
} from '../../src/main/hub/delegation-answer';

interface FakeWorld {
  ports: TaskAnswerPorts;
  grantCalls: Array<{ sessionId: string; dirs: string[] }>;
  clearGrantCalls: Array<{ sessionId: string; dirs: string[] }>;
  clearDenyCalls: string[];
  broadcasts: string[][];
  audits: Array<{ taskId: string; decision: string; disposition: string; sessionId: string | null; message?: string }>;
}

function makeWorld(opts: { sessionOf?: (taskId: string) => string | null; pending?: (sessionId: string) => TaskAnswerPendingSignal[] }): FakeWorld {
  const grantCalls: FakeWorld['grantCalls'] = [];
  const clearGrantCalls: FakeWorld['clearGrantCalls'] = [];
  const clearDenyCalls: string[] = [];
  const broadcasts: string[][] = [];
  const audits: FakeWorld['audits'] = [];
  const ports: TaskAnswerPorts = {
    findDelegationSession: opts.sessionOf ?? (() => null),
    listPending: opts.pending ?? (() => []),
    grantDirs: (sessionId, dirs) => grantCalls.push({ sessionId, dirs }),
    clearGranted: (sessionId, dirs) => clearGrantCalls.push({ sessionId, dirs }),
    clearDenied: (sessionId) => clearDenyCalls.push(sessionId),
    broadcastDenied: (dirs) => broadcasts.push(dirs),
    logAnswered: (info) => audits.push(info),
  };
  return { ports, grantCalls, clearGrantCalls, clearDenyCalls, broadcasts, audits };
}

const SESSION_OF_T1 = (taskId: string): string | null => (taskId === 'T-1' ? 'sess-1' : null);

describe('delegation-answer — 载荷校验（bad_request 全路径）', () => {
  it('非对象 / taskId 缺失或空串 / decision 非枚举 → bad_request', () => {
    const w = makeWorld({});
    expect(handleTaskAnswerRequest(null, w.ports)).toEqual({ ok: false, payload: { code: 'bad_request', message: '载荷非对象' } });
    expect(handleTaskAnswerRequest('x', w.ports).ok).toBe(false);
    expect(handleTaskAnswerRequest({ decision: 'approve' }, w.ports).ok).toBe(false);
    expect(handleTaskAnswerRequest({ taskId: '', decision: 'approve' }, w.ports).ok).toBe(false);
    expect(handleTaskAnswerRequest({ taskId: 'T-1' }, w.ports).ok).toBe(false);
    expect(handleTaskAnswerRequest({ taskId: 'T-1', decision: 'yes' }, w.ports).ok).toBe(false);
    // 校验失败零副作用（原语与审计均不触发）
    expect(w.grantCalls).toHaveLength(0);
    expect(w.broadcasts).toHaveLength(0);
    expect(w.audits).toHaveLength(0);
  });

  it('message 空串 / 超 512 / 非字符串 → bad_request（hub 侧同界 1-512）', () => {
    const w = makeWorld({});
    expect(handleTaskAnswerRequest({ taskId: 'T-1', decision: 'approve', message: '' }, w.ports).ok).toBe(false);
    expect(handleTaskAnswerRequest({ taskId: 'T-1', decision: 'approve', message: 'x'.repeat(513) }, w.ports).ok).toBe(false);
    expect(handleTaskAnswerRequest({ taskId: 'T-1', decision: 'approve', message: 42 }, w.ports).ok).toBe(false);
    // 512 恰好过界（合法上限）
    expect(handleTaskAnswerRequest({ taskId: 'T-1', decision: 'approve', message: 'x'.repeat(512) }, w.ports).ok).toBe(true);
  });
});

describe('delegation-answer — 三 stale 口径（幂等不报错）', () => {
  it('本地无此委派 → {ok:true, stale}（无 sessionId），零原语调用，审计留痕', () => {
    const w = makeWorld({});
    const r = handleTaskAnswerRequest({ taskId: 'T-unknown', decision: 'approve' }, w.ports);
    expect(r).toEqual({ ok: true, payload: { disposition: 'stale' } });
    expect(w.grantCalls).toHaveLength(0);
    expect(w.clearDenyCalls).toHaveLength(0);
    expect(w.broadcasts).toHaveLength(0);
    expect(w.audits).toEqual([{ taskId: 'T-unknown', decision: 'approve', disposition: 'stale', sessionId: null }]);
  });

  it('未决登记为空（已处置 / TTL 清扫）→ {ok:true, stale, sessionId}', () => {
    const w = makeWorld({ sessionOf: SESSION_OF_T1, pending: () => [] });
    const r = handleTaskAnswerRequest({ taskId: 'T-1', decision: 'deny' }, w.ports);
    expect(r).toEqual({ ok: true, payload: { disposition: 'stale', sessionId: 'sess-1' } });
    expect(w.grantCalls).toHaveLength(0);
    expect(w.broadcasts).toHaveLength(0);
    expect(w.audits).toEqual([{ taskId: 'T-1', decision: 'deny', disposition: 'stale', sessionId: 'sess-1' }]);
  });
});

describe('delegation-answer — approve：聚合授予 + 逐条清除', () => {
  it('多 pending 条目（含重叠 dirs）→ grantWriteDirs 一次（去重并集）+ 逐条 clearPendingOnGrant', () => {
    const w = makeWorld({
      sessionOf: SESSION_OF_T1,
      pending: () => [
        { dirs: ['/tmp/a', '/tmp/b'] },
        { dirs: ['/tmp/b', '/tmp/c'] },
      ],
    });
    const r = handleTaskAnswerRequest({ taskId: 'T-1', decision: 'approve' }, w.ports);
    expect(r).toEqual({ ok: true, payload: { disposition: 'granted', sessionId: 'sess-1' } });
    // 一次授予：去重并集（grantWriteDirs 内部再归一——端口收到原始并集）
    expect(w.grantCalls).toEqual([{ sessionId: 'sess-1', dirs: ['/tmp/a', '/tmp/b', '/tmp/c'] }]);
    // 逐条按各自 dirs 清除（write-blocked-emit 相交匹配语义）
    expect(w.clearGrantCalls).toEqual([
      { sessionId: 'sess-1', dirs: ['/tmp/a', '/tmp/b'] },
      { sessionId: 'sess-1', dirs: ['/tmp/b', '/tmp/c'] },
    ]);
    expect(w.clearDenyCalls).toHaveLength(0);
    expect(w.broadcasts).toHaveLength(0);
    expect(w.audits).toEqual([{ taskId: 'T-1', decision: 'approve', disposition: 'granted', sessionId: 'sess-1' }]);
  });
});

describe('delegation-answer — deny：广播聚合 dirs + 整会话清除', () => {
  it('deny 广播与 approve 同集（子进程按目录相交匹配等待），清除走整会话口径', () => {
    const w = makeWorld({
      sessionOf: SESSION_OF_T1,
      pending: () => [{ dirs: ['/tmp/x'] }, { dirs: ['/tmp/y'] }],
    });
    const r = handleTaskAnswerRequest({ taskId: 'T-1', decision: 'deny' }, w.ports);
    expect(r).toEqual({ ok: true, payload: { disposition: 'denied', sessionId: 'sess-1' } });
    expect(w.broadcasts).toEqual([['/tmp/x', '/tmp/y']]);
    // 空 dirs = 整会话拒绝（clearPendingOnDeny 语义）——生产端口落 clearPendingOnDeny(sessionId, [])
    expect(w.clearDenyCalls).toEqual(['sess-1']);
    expect(w.grantCalls).toHaveLength(0);
    expect(w.clearGrantCalls).toHaveLength(0);
    expect(w.audits).toEqual([{ taskId: 'T-1', decision: 'deny', disposition: 'denied', sessionId: 'sess-1' }]);
  });
});

describe('delegation-answer — message 仅留痕不上报子进程', () => {
  it('message 只进审计日志；grant/broadcast/clear 载荷均不含 message（无注入点——一义一名）', () => {
    const w = makeWorld({ sessionOf: SESSION_OF_T1, pending: () => [{ dirs: ['/tmp/a'] }] });
    handleTaskAnswerRequest({ taskId: 'T-1', decision: 'approve', message: 'leader 批准本次写入' }, w.ports);
    expect(w.audits[0]).toMatchObject({ message: 'leader 批准本次写入' });
    const flat = JSON.stringify([w.grantCalls, w.clearGrantCalls, w.clearDenyCalls, w.broadcasts]);
    expect(flat).not.toContain('leader 批准本次写入');
  });

  it('message 缺席 → 审计条目无 message 键（可选字段落形纪律）', () => {
    const w = makeWorld({ sessionOf: SESSION_OF_T1, pending: () => [{ dirs: ['/tmp/a'] }] });
    handleTaskAnswerRequest({ taskId: 'T-1', decision: 'deny' }, w.ports);
    expect(w.audits[0]).not.toHaveProperty('message');
  });
});
