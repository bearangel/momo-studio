// electron/tests/sandbox/network-trust.test.ts
// handleNetTrustOp（effective 单 op，修订 B 双态 + v2.5 双字段 + 2026-10-03 extraDirs）。
// 旧 grants 布尔模型已随通用写授权下线：toolchainOn 仅剩 toolchainPolicy==='allow'
// 永久开关；动态授权目录经 extraDirs（session/ws 两层合成）回传。
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
import { DEFAULT_TOOLCHAIN_DIRS } from '../../src/main/sandbox/toolchain-grant';
import {
  grantWriteDirs,
  __clearWriteGrantsForTest,
} from '../../src/main/sandbox/write-grant';
import { runMigrations, closeDb, getDb } from '../../src/main/storage/db';

/** 测试用 settings 构造器：v2.5 起 toolchainPolicy/toolchainDirs 必填 */
function settings(mode: 'strict' | 'permissive', networkPolicy: 'deny' | 'allow') {
  return { mode, networkPolicy, toolchainPolicy: 'deny' as const, toolchainDirs: [...DEFAULT_TOOLCHAIN_DIRS] };
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

describe('handleNetTrustOp（effective 单 op 路由，修订 B 双态）', () => {
  it('policy=allow → { ok:true, payload:{ netOn:true, toolchainOn:false, extraDirs:[] } }', async () => {
    __setSandboxSettingsForTest(settings('strict', 'allow'));
    const r = await handleNetTrustOp({ type: 'net-trust-op', requestId: 'r1', op: 'effective', streamSessionId: SSN });
    expect(r).toEqual({ ok: true, payload: { netOn: true, toolchainOn: false, extraDirs: [] } });
  });

  it('policy=deny → { ok:true, payload:{ netOn:false, toolchainOn:false, extraDirs:[] } }', async () => {
    __setSandboxSettingsForTest(settings('strict', 'deny'));
    const r = await handleNetTrustOp({ type: 'net-trust-op', requestId: 'r2', op: 'effective', streamSessionId: SSN });
    expect(r).toEqual({ ok: true, payload: { netOn: false, toolchainOn: false, extraDirs: [] } });
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

describe('effective op 工具链双字段 + extraDirs（spec 2026-10-03 §6.1）', () => {
  it('默认 deny → toolchainOn=false（永久开关关闭；grants 布尔模型已下线）', async () => {
    const r = await handleNetTrustOp({
      type: 'net-trust-op', requestId: 'r1', op: 'effective',
      streamSessionId: SSN, workspaceId: 'ws-a',
    });
    expect(r).toEqual({ ok: true, payload: { netOn: true, toolchainOn: false, extraDirs: [] } });
  });

  it('policy=allow → 无动态授权也 true（永久开）', async () => {
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

  it('extraDirs：workspace 授权参与合成（streamSessionId 无消息映射 → session 层缺省）', async () => {
    grantWriteDirs('workspace', 'ws-a', ['/tmp/ws-grant']);
    const r = await handleNetTrustOp({
      type: 'net-trust-op', requestId: 'e1', op: 'effective',
      streamSessionId: SSN, workspaceId: 'ws-a',
    });
    expect(r).toEqual({ ok: true, payload: { netOn: true, toolchainOn: false, extraDirs: ['/tmp/ws-grant'] } });
  });

  it('extraDirs：streamSessionId 经 messages 映射命中 → session 层参与合成', async () => {
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

  it('旧载荷（无 workspaceId）→ extraDirs 恒空数组不抛错（兼容铁律）', async () => {
    grantWriteDirs('workspace', 'ws-a', ['/tmp/ws-grant']);
    const r = await handleNetTrustOp({ type: 'net-trust-op', requestId: 'e3', op: 'effective', streamSessionId: SSN });
    expect(r).toEqual({ ok: true, payload: { netOn: true, toolchainOn: false, extraDirs: [] } });
  });
});
