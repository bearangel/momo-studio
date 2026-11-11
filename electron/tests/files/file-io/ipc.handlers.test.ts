// electron/tests/files/file-io/ipc.handlers.test.ts
//
// I3 回归锁：buildFileIoStatus 的 node 探测缓存行为（命中 / 强制刷新 / 键切换）。
// 探测函数注入（__setNodeProbeForTest）——零真实 spawn（禁慢测试约束）。
// vi.mock('electron') 形态照抄 tests/sandbox/ipc.handlers.test.ts：本文件不注册
// handler，仅为模块加载提供 ipcMain 占位。
import { describe, expect, it, afterEach, vi } from 'vitest';

vi.mock('electron', () => ({
  ipcMain: {
    handle: () => {},
  },
}));

import {
  __setNodeProbeForTest,
  buildFileIoStatus,
} from '../../../src/main/files/file-io/ipc.handlers';

afterEach(() => {
  __setNodeProbeForTest(null);
});

describe('buildFileIoStatus node 探测缓存（I3）', () => {
  it('同配置两次调用只探一次，第二次命中缓存同值', async () => {
    let calls = 0;
    __setNodeProbeForTest(async () => {
      calls += 1;
      return { nodePath: '/fake/node', nodeVersion: 'v24.1.0' };
    });
    const first = await buildFileIoStatus({ mode: 'direct' });
    const second = await buildFileIoStatus({ mode: 'direct' });
    expect(calls).toBe(1);
    expect(first).toMatchObject({
      nodeAvailable: true,
      nodePath: '/fake/node',
      nodeVersion: 'v24.1.0',
    });
    expect(second).toMatchObject(first);
  });

  it('refresh:true 强制重探并更新缓存（fileIo:probe 路径）', async () => {
    let version = 'v14.21.3';
    __setNodeProbeForTest(async () => ({ nodePath: '/fake/node', nodeVersion: version }));
    await buildFileIoStatus({ mode: 'direct' });
    version = 'v24.1.0';
    const refreshed = await buildFileIoStatus({ mode: 'direct' }, { refresh: true });
    expect(refreshed.nodeVersion).toBe('v24.1.0');
    // 缓存已被刷新覆盖：后续非 refresh 调用拿到新值
    const cached = await buildFileIoStatus({ mode: 'direct' });
    expect(cached.nodeVersion).toBe('v24.1.0');
  });

  it('nodePath 配置变更 → 缓存键切换重探；探测失败结果同样入缓存', async () => {
    let calls = 0;
    __setNodeProbeForTest(async () => {
      calls += 1;
      return calls === 1
        ? { nodePath: '/fake/node', nodeVersion: 'v1' }
        : { nodePath: null, nodeVersion: null };
    });
    const auto = await buildFileIoStatus({ mode: 'direct' });
    expect(auto.nodePath).toBe('/fake/node');
    const explicit = await buildFileIoStatus({ mode: 'direct', nodePath: 'C:\\nodejs\\node.exe' });
    expect(explicit.nodePath).toBeNull();
    expect(explicit.nodeAvailable).toBe(false);
    expect(calls).toBe(2);
  });
});
