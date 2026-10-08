// electron/tests/sandbox/network-trust.test.ts
// handleNetTrustOp（effective 单 op，修订 B 双态 + v2.5 两字段 payload +
// 2026-10-03 extraDirs）。v2.5 工具链授权机制（policy 开关 + 预置清单）已整体
// 移除：effective payload = { netOn, extraDirs } 两字段；extraDirs = 会话 ∪ 工
// 作空间两层动态授权目录合成（write-grant KV）。toolchainOn 字段已从契约下线。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
  grantWriteDirs,
  __clearWriteGrantsForTest,
} from '../../src/main/sandbox/write-grant';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';

/** 测试用 settings 构造器：v2.5 起 SandboxSettings 仅含 mode/networkPolicy */
function settings(mode: 'strict' | 'permissive', networkPolicy: 'deny' | 'allow') {
  return { mode, networkPolicy };
}

const SSN = 'ssn-trust-1';
const tmpRoot = path.join(os.tmpdir(), `net-trust-test-${Date.now()}`);

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  process.env.AP_USER_DATA_DIR = tmpRoot;
  runMigrations();
  __clearWriteGrantsForTest();
  __setSandboxSettingsForTest(settings('strict', 'allow'));
});
afterEach(() => {
  __setSandboxSettingsForTest(null);
  __clearWriteGrantsForTest();
  closeDb();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.AP_USER_DATA_DIR;
});

describe('handleNetTrustOp（effective 单 op 路由，修订 B 双态 + v2.5 两字段 payload）', () => {
  it('policy=allow → { ok:true, payload:{ netOn:true, extraDirs:[] } }', async () => {
    __setSandboxSettingsForTest(settings('strict', 'allow'));
    const r = await handleNetTrustOp({ type: 'net-trust-op', requestId: 'r1', op: 'effective', streamSessionId: SSN });
    expect(r).toEqual({ ok: true, payload: { netOn: true, extraDirs: [] } });
  });

  it('policy=deny → { ok:true, payload:{ netOn:false, extraDirs:[] } }', async () => {
    __setSandboxSettingsForTest(settings('strict', 'deny'));
    const r = await handleNetTrustOp({ type: 'net-trust-op', requestId: 'r2', op: 'effective', streamSessionId: SSN });
    expect(r).toEqual({ ok: true, payload: { netOn: false, extraDirs: [] } });
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
    const settingsMod = await import('../../src/main/sandbox/settings');
    const spy = vi.spyOn(settingsMod, 'getSandboxSettings').mockImplementation(() => {
      throw new Error('DB 异常');
    });
    const r = await handleNetTrustOp({ type: 'net-trust-op', requestId: 'r6', op: 'effective', streamSessionId: SSN });
    spy.mockRestore();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('网络策略读取失败');
  });
});

describe('effective extraDirs 两层合成（spec §6.1，2026-10-04 工具链机制移除）', () => {
  it('workspace 授权参与合成（streamSessionId 无消息映射 → session 层缺省）', async () => {
    grantWriteDirs('workspace', 'ws-a', ['/tmp/ws-grant']);
    const r = await handleNetTrustOp({
      type: 'net-trust-op', requestId: 'e1', op: 'effective',
      streamSessionId: SSN, workspaceId: 'ws-a',
    });
    expect(r).toEqual({ ok: true, payload: { netOn: true, extraDirs: ['/tmp/ws-grant'] } });
  });

  it('streamSessionId 经 messages 映射命中 → session 层参与合成', async () => {
    grantWriteDirs('session', 's-map', ['/tmp/session-grant']);
    getDb()
      .prepare(
        'INSERT INTO messages (id, session_id, sender, event_type, body, stream_session_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run('m-1', 's-map', 'agent-x', 'message', '', 'ss-map', Date.now(), Date.now());
    const r = await handleNetTrustOp({
      type: 'net-trust-op', requestId: 'e2', op: 'effective',
      streamSessionId: 'ss-map', workspaceId: 'ws-a',
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.payload.extraDirs).toContain('/tmp/session-grant');
    }
  });

  it('#roll 后缀流映射最新行 → session 层仍参与（终审 I1，spec §5.3 前缀语义）', async () => {
    grantWriteDirs('session', 's-roll', ['/tmp/roll-grant']);
    // rename 模型：流 roll 时同一消息行的 stream_session_id 被改写为 #roll 后缀，
    // base 形态的行不再存在——精确匹配必然落空（终审 I1 的真实形态）
    getDb()
      .prepare(
        'INSERT INTO messages (id, session_id, sender, event_type, body, stream_session_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run('m-rolled', 's-roll', 'agent-x', 'message', '', 'ss-roll#roll2', Date.now(), Date.now());
    // 子进程持 base ssi——必须经 roll 语义拿到 session 层
    const r = await handleNetTrustOp({
      type: 'net-trust-op', requestId: 'e4', op: 'effective',
      streamSessionId: 'ss-roll', workspaceId: 'ws-a',
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.payload.extraDirs).toContain('/tmp/roll-grant');
  });

  it('旧载荷（无 workspaceId）→ extraDirs 恒空数组不抛错（兼容铁律）', async () => {
    grantWriteDirs('workspace', 'ws-a', ['/tmp/ws-grant']);
    const r = await handleNetTrustOp({ type: 'net-trust-op', requestId: 'e3', op: 'effective', streamSessionId: SSN });
    expect(r).toEqual({ ok: true, payload: { netOn: true, extraDirs: [] } });
  });

  it('session ∪ workspace 两层并集去重（同一路径双源 → 单条）', async () => {
    const dual = path.join(os.tmpdir(), `dual-l3-${Date.now()}`);
    fs.mkdirSync(dual, { recursive: true });
    grantWriteDirs('session', 's-map', [dual]);
    grantWriteDirs('workspace', 'ws-l3', [dual]);
    // 注入一条 messages 行以让 session 键被命中
    getDb()
      .prepare(
        'INSERT INTO messages (id, session_id, sender, event_type, body, stream_session_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run('m-map', 's-map', 'agent-x', 'message', '', SSN, Date.now(), Date.now());
    const r = await handleNetTrustOp({
      type: 'net-trust-op', requestId: 'l3-dedup', op: 'effective',
      streamSessionId: SSN, workspaceId: 'ws-l3',
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      // realpath 归一后匹配（macOS /tmp → /private/tmp 等情况）
      const norm = fs.realpathSync(dual);
      expect(r.payload.extraDirs.filter((d) => d === norm)).toHaveLength(1);
    }
  });

  it('payload 形状锁：恰好 {netOn, extraDirs} 两键——抗复活锁（v2.5 工具链机制移除后，toolchainOn 不应再现）', async () => {
    const r = await handleNetTrustOp({
      type: 'net-trust-op', requestId: 'shape-lock', op: 'effective',
      streamSessionId: SSN, workspaceId: 'ws-a',
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(Object.keys(r.payload).sort()).toEqual(['extraDirs', 'netOn']);
      expect(r.payload).not.toHaveProperty('toolchainOn');
    }
  });
});